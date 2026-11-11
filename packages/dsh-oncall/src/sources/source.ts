/**
 * The Source contract: read one external stream, report the triggers it holds.
 *
 * ### What a Source is not allowed to do
 *
 * It does **not** hold the cursor and it does **not** retry. Both belong to the
 * caller (`runtime/pass.ts`), for one reason: the cursor must advance in the same
 * transaction as the case it produced (docs/design/super-plugin.md 7.4). A Source
 * that writes its own read position can succeed at reading and fail at recording,
 * and the next poll then skips the work forever.
 *
 * It also does not judge anyone. Authorization is `src/core/admission.ts`, a pure
 * function that sees only the Trigger — never the API response.
 *
 * ### Statelessness
 *
 * `poll` takes everything it needs and returns everything it learned. The failure
 * text, the last poll time and the cursor live in the caller's record, so a Source
 * can be replaced (or faked) without carrying state across runs.
 *
 * Note: 为何游标与失败重试归调用方 —— 见 docs/design/super-plugin.md 7.4。
 */

import type { SourceId, Trigger } from '../contract/types.ts'

/**
 * Where a Source resumes reading, as that Source serialises it.
 *
 * Opaque on purpose: GitHub advances by a timestamp with an overlap window, a
 * chat source would advance by a message id, and the store must not care which.
 */
export type Cursor = string

export interface PollInput {
  /** `null` on the first poll: the Source decides how far back to look. */
  readonly cursor: Cursor | null
  /** Wall clock for this poll, injected so a test can pin it. */
  readonly now: number
  readonly signal: AbortSignal
}

export interface PollResult {
  /**
   * Events read this round. **May contain events a previous poll already
   * reported** — the overlap window guarantees it does. Removing them is the
   * store's job, by `TriggerKey`.
   */
  readonly triggers: readonly Trigger[]
  readonly cursor: Cursor
}

export interface Source {
  readonly id: SourceId
  /** One line for the settings page: what this source reads. */
  readonly label: string
  /**
   * Read once. Throws on a transport failure; the caller records the message and
   * backs off. A thrown error must never be turned into an empty result — an
   * unreachable GitHub is not "no new work".
   */
  poll(input: PollInput): Promise<PollResult>
}
