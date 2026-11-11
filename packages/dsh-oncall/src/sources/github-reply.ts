/**
 * The GitHub side of a receipt: one comment on the issue the Case came from.
 *
 * ### Why a sender and not a call site
 *
 * The outbox owns "one receipt per `caseId#seq`, retried until it lands or dies"; the
 * transport owns "how a GitHub comment is posted". Keeping them apart is what lets
 * the outbox be tested with a fake sender that answers `gone` on demand, and lets a
 * future chat source add its own sender without touching the receipt rules.
 *
 * ### Why the thread key is parsed here
 *
 * `sources/github-issue.ts` is the only file that knows an issue thread is spelled
 * `issue-<number>`; this module asks it instead of re-deriving the shape. A thread
 * from another source cannot be answered by this sender at all, which throws rather
 * than silently reporting a delivery that never happened.
 *
 * Note: 为何一条回执一条消息、为何 gone 不重试 —— 见 docs/design/oncall-v0-architecture.md 四节 4。
 */

import type { ThreadKey } from '../contract/types.ts'
import type { GithubFace } from './github-face.ts'
import { issueNumberOf } from './github-issue.ts'

export interface ReplyRequest {
  /** The conversation the receipt belongs to (the Case's own thread). */
  readonly thread: ThreadKey
  readonly text: string
  readonly signal: AbortSignal
}

/** `gone` means the target cannot be reached again; every other failure is thrown. */
export type ReplyOutcome = 'sent' | 'gone'

export interface ReplySender {
  send(request: ReplyRequest): Promise<ReplyOutcome>
}

export interface GithubReplyOptions {
  readonly face: GithubFace
  readonly sourceId: Parameters<typeof issueNumberOf>[1]
  readonly owner: string
  readonly repo: string
}

/** A `ReplySender` that posts one comment on the issue the thread names. */
export function githubReplySender(options: GithubReplyOptions): ReplySender {
  const { face, sourceId, owner, repo } = options
  return {
    async send({ thread, text, signal }) {
      const number = issueNumberOf(thread, sourceId)
      if (number === undefined) {
        throw new Error(`oncall: thread ${thread} is not an issue of ${sourceId}; no comment to post`)
      }
      return face.createComment({ owner, repo, number, body: text, signal })
    },
  }
}
