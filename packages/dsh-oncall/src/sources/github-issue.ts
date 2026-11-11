/**
 * GitHub issues as a Source: which events count as someone addressing the agent.
 *
 * ### Cursor is an optimisation, the key is the guarantee
 *
 * The cursor advances to `now - OVERLAP_MS`, so the next poll re-reads a minute of
 * history and **will** report events this poll already reported. That is
 * deliberate: an overlap window is the only way to survive clock skew between our
 * machine and GitHub's, and dropping the overlap trades duplicates (harmless) for
 * lost work (silent). Duplicates are absorbed one layer up, where `TriggerKey` is
 * the primary key of dedupe.
 *
 * ### What counts as addressing the agent
 *
 * A mention in an issue body or a comment, or an assignment to the agent's
 * account. Nothing else: an unmentioned issue update is not work, and emitting it
 * as `ambient` would make every edited issue a candidate — noise that the gate
 * would refuse anyway, after the poll had already paid for it.
 *
 * Pull requests are skipped even though the endpoint returns them. They are a
 * separate source with their own thread keys; folding both into one thread would
 * let the same work open two Cases.
 *
 * Note: 为何游标要回看一分钟、为何 PR 不在这里 —— 见 docs/design/super-plugin.md 7.4。
 * Note: 被否的方案（max(updatedAt) 游标、Notifications 游标、每 thread 记 id）—— 见
 * .agents/notes/implemented/2026-11-09-github-source-cursor-overlap.md
 */

import { mentions } from '../core/mentions.ts'
import { threadExternal, threadKey, triggerKey } from '../core/trigger-key.ts'
import type { Actor, SourceId, ThreadKey, Trigger, TriggerKind } from '../contract/types.ts'
import type { GithubFace, RawUser } from './github-face.ts'
import type { Cursor, PollInput, PollResult, Source } from './source.ts'

/**
 * How far back each poll re-reads. Accounts for clock skew and for an event that
 * lands between the query and the cursor write; the cost is a few duplicate
 * triggers per poll, which the store drops by key.
 */
const OVERLAP_MS = 60_000

interface GithubCursor {
  readonly since: number
}

export interface GithubIssueOptions {
  readonly face: GithubFace
  readonly owner: string
  readonly repo: string
  /** The agent's own login; mentions of it are what this source reports. */
  readonly login: string
  /**
   * How far back the very first poll looks when there is no cursor.
   *
   * Default `0`: the agent reads from the moment it is switched on and never
   * replays history, the same choice `dsh-superagent` made for receive-all
   * switches (`docs/001-domain.md` Source rules).
   */
  readonly initialLookbackMs?: number
}

/** The source id one repository's issues get. The one place it is built. */
export function githubIssueSourceId(owner: string, repo: string): SourceId {
  return `github:${owner}/${repo}#issues` as SourceId
}

/**
 * Parse `owner/name` into its halves.
 *
 * `undefined` rather than a throw: the caller is a settings read, where a half-typed
 * repository name is an ordinary state, and the caller decides whether that is an
 * error worth logging or just "the ingress is not configured yet".
 */
export function parseRepository(value: string): { readonly owner: string; readonly repo: string } | undefined {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim())
  return match === null ? undefined : { owner: match[1]!, repo: match[2]! }
}

/** One GitHub repository's issues, as a Source. */
export function githubIssueSource(options: GithubIssueOptions): Source {
  const { face, owner, repo, login, initialLookbackMs = 0 } = options
  const id = githubIssueSourceId(owner, repo)

  return {
    id,
    label: `GitHub · ${owner}/${repo} · issues`,

    async poll(input: PollInput): Promise<PollResult> {
      const since = decodeCursor(input.cursor)?.since ?? input.now - initialLookbackMs
      const sinceIso = new Date(since).toISOString()
      const issues = await face.listIssues({ owner, repo, since: sinceIso, signal: input.signal })

      const triggers: Trigger[] = []
      for (const issue of issues) {
        if (issue.pull_request !== undefined) continue

        const issueText = issue.body ?? ''
        const addressesBody = mentions(issueText, login)
        const addressedByAssignment = issue.assignee?.login === login
        if (addressesBody || addressedByAssignment) {
          triggers.push(triggerOf({
            id, login, now: input.now,
            number: issue.number,
            externalId: `issue-${issue.number}`,
            kind: addressesBody ? 'mention' : 'direct',
            actor: issue.user,
            text: issueText,
            occurredAt: issue.createdAt,
          }))
        }

        const comments = await face.listComments({ owner, repo, number: issue.number, since: sinceIso, signal: input.signal })
        for (const comment of comments) {
          const text = comment.body ?? ''
          if (!mentions(text, login)) continue
          triggers.push(triggerOf({
            id, login, now: input.now,
            number: issue.number,
            externalId: `comment-${comment.id}`,
            kind: 'mention',
            actor: comment.user,
            text,
            occurredAt: comment.createdAt,
          }))
        }
      }

      return { triggers, cursor: encodeCursor({ since: input.now - OVERLAP_MS }) }
    },
  }
}

/**
 * The issue number inside one of this source's thread keys, or `undefined`.
 *
 * Only this file knows that an issue thread is spelled `issue-<number>`, so only this
 * file turns one back into a number. A reply sender that parsed it itself would be a
 * second definition of the thread key's tail.
 */
export function issueNumberOf(thread: ThreadKey, sourceId: SourceId): number | undefined {
  const external = threadExternal(thread, sourceId)
  const match = external === undefined ? null : /^issue-(\d+)$/.exec(external)
  return match === null ? undefined : Number(match[1])
}

/** One trigger, with its two keys built in exactly one place each. */
function triggerOf(input: {
  readonly id: SourceId
  readonly login: string
  readonly now: number
  readonly number: number
  readonly externalId: string
  readonly kind: TriggerKind
  readonly actor: RawUser | null
  readonly text: string
  /** When the external event happened, as ISO. Unparseable falls back to `now`. */
  readonly occurredAt: string
}): Trigger {
  const parsed = Date.parse(input.occurredAt)
  return {
    key: triggerKey(input.id, input.externalId),
    source: input.id,
    thread: threadKey(input.id, `issue-${input.number}`),
    kind: input.kind,
    actor: actorOf(input.id, input.actor),
    text: input.text,
    at: Number.isFinite(parsed) ? parsed : input.now,
  }
}

/**
 * Who spoke, in that source's own identity system.
 *
 * A missing user is not an error: GitHub returns `null` for a deleted account, and
 * the trigger still exists. It becomes a `bot` — the most restrictive kind — so a
 * deleted human cannot inherit a person's authority.
 */
function actorOf(source: SourceId, user: RawUser | null): Actor {
  const login = user?.login ?? 'ghost'
  return {
    source,
    id: login,
    handle: user === null ? login : `@${login}`,
    kind: user?.type === 'Bot' ? 'bot' : user === null ? 'bot' : 'human',
  }
}

function encodeCursor(cursor: GithubCursor): Cursor {
  return JSON.stringify(cursor)
}

/** A cursor we cannot read is no cursor: re-read from the lookback, never skip. */
function decodeCursor(cursor: Cursor | null): GithubCursor | null {
  if (cursor === null) return null
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (parsed === null || typeof parsed !== 'object') return null
    const since = (parsed as { since?: unknown }).since
    return typeof since === 'number' && Number.isFinite(since) ? { since } : null
  } catch {
    return null
  }
}

/** Exported for the test that pins the overlap, not for production use. */
export const GITHUB_OVERLAP_MS = OVERLAP_MS
