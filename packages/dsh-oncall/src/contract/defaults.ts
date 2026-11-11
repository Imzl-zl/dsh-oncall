/**
 * Every default the ingress has, in one place.
 *
 * A default replaces a setting when one value suits almost every deployment
 * (`dsh-superagent` docs/000-philosophy.md:20). The point of this file is that
 * "what a deployment gets when it configures nothing" is answerable by reading
 * one file instead of collecting literals from schemas, guards and text.
 */

import type { AcceptMode } from './policy.ts'

/**
 * Off by default: a fresh install must not act on work nobody asked for. The
 * first thing an operator does is put one person on the allowed list, and the
 * agent stays silent about everything else.
 */
export const DEFAULT_ACCEPT_MODE: AcceptMode = 'off'

/**
 * How much of one request a Case carries as its brief.
 *
 * A bound on the ledger, not on the model: the worker reads the original thread, so
 * the brief only has to say what was asked. Four thousand characters holds a normal
 * issue body with its log; anything longer is a template, and the cut is marked.
 */
export const MAX_BRIEF_CHARS = 4_000

/**
 * The environment variable the ingress reads its GitHub token from.
 *
 * Not a setting: configuration lands in the profile's `cordis.patch.yml`, so a token
 * there is a token in a file that gets copied, backed up and pasted into bug reports.
 * One name, so there is no "which variable wins" question.
 */
export const INGRESS_TOKEN_ENV = 'GITHUB_TOKEN'

/** How often the ingress reads its sources when nothing says otherwise. */
export const DEFAULT_INGRESS_POLL_SECONDS = 15

/**
 * What a new assignment says when the last one never reported.
 *
 * The worker cannot know a restart happened, and the two ways to get it wrong are
 * both cheap to avoid: redoing an already-completed external action (a push, a
 * comment, a deploy) and re-reading nothing before continuing. The wording is the
 * reference implementation's (`dsh-superagent` `src/core/assignments.ts:21`), kept in
 * the product's own language because the worker reads it as an instruction.
 */
export const RECOVERY_NOTE =
  '宿主在上一刀中途重启过。先看当前工作区、git 历史与 GitHub 的现状，再决定做到哪一步；'
  + '不要重复已完成的外部动作。完成原任务，然后报告状态。'

/**
 * How a passing (transient) failure is retried: how many times, and the first wait.
 *
 * The shape is the reference implementation's (`executor/dsh.ts:26` `TRANSIENT_TRIES=3`,
 * `:548-576` `retries`/`resumeAfter`): the **same assignment** continues after a
 * backoff of `15s × 2^(n-1)`, by a message telling the worker to go on from where it
 * stopped — it is not a report and not a new assignment. A provider that named its own
 * delay (`turn/end.error.providerRetryAfterMs`, usual on a gateway's 429) wins over the
 * ladder when it is longer.
 */
export const TRANSIENT_RETRIES = 3
export const TRANSIENT_RETRY_BASE_MS = 15_000

/**
 * How long the outbox waits between attempts to post one receipt.
 *
 * The reference retries stored channel messages from 5 seconds, doubling up to 300
 * (`docs/003-execution.md`, "Channel failure"), and holds a Ticket's later messages
 * behind an earlier one that has not gone out. We keep the shape and stop once the
 * list is spent: V0 has no "system problems" surface, so a receipt row has to reach a
 * terminal state — `failed` is what the audit stream shows, and the row keeps it.
 */
export const REPLY_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]

/** How much of a Case's brief becomes the worker session's title. */
export const MAX_SESSION_TITLE_CHARS = 60

/**
 * The Policy version a Mandate records.
 *
 * Bumped by the plugin when the *shape* of the rules changes (a new admit branch),
 * not when a deployment edits its lists — that is what the actor identity and the
 * timestamp on the Case are for.
 */
export const INGRESS_POLICY_VERSION = 1
