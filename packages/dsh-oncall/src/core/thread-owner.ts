/**
 * Whose Case a message on a thread belongs to.
 *
 * The one place that answers "这条消息归谁". A thread's `subscriptions` is the
 * authoritative list (`docs/design/oncall-v0-architecture.md` §三), written by the
 * pass in the same commit that opens the Case; `mandate.scope` is the authorization
 * range and deliberately not read here — deriving ownership from it would answer
 * the same question twice, and the two answers would drift.
 *
 * ### Only the newest subscription decides
 *
 * V0 keeps at most one live Case per thread (open-questions §14.2 item 1). Walking
 * back past a stopped Case to an older one would resurrect work a person ended,
 * which is the one thing a stop must prevent. So: newest subscription, one verdict.
 *
 * ### A stopped Case is not an owner; anything else closed is
 *
 * A follow-up on a *closed* Case resumes it (open-questions §14.2 item 5,
 * `docs/002-authorization.md` "Subscriptions"): the person's message arrives with the
 * Case's own mandate. `stopped` is the exception — that Case was ended on purpose
 * (a person, or the step allowance), and resuming it would ignore that. The trigger
 * then falls through to the gate, where an explicit new request opens a **new**
 * Case; the stopped Case is never touched again.
 *
 * Note: 为何只认最新订阅、为何 stopped 不恢复 —— 见
 * docs/design/oncall-v0-architecture.md 三/四节与 open-questions §14.2 第 1、5 条。
 */

import type { CaseId, CaseRecord, ThreadRecord } from '../contract/types.ts'

export interface ThreadOwnership {
  /** The thread's row, or `undefined` when no Case was ever opened on it. */
  readonly thread: ThreadRecord | undefined
  /** Look one Case up. A lookup rather than an array so a pass can keep its view live. */
  readonly caseOf: (id: CaseId) => CaseRecord | undefined
}

/**
 * The Case a message on this thread belongs to, or `undefined` when nobody owns it.
 *
 * A missing Case row for the newest subscription answers `undefined` rather than
 * falling back to an older one: a row that vanished is a fact we cannot explain, and
 * guessing would route work to a Case nobody meant.
 */
export function threadOwner(input: ThreadOwnership): CaseRecord | undefined {
  const { thread, caseOf } = input
  if (thread === undefined) return undefined

  const newest = thread.subscriptions[thread.subscriptions.length - 1]
  if (newest === undefined) return undefined

  const owner = caseOf(newest)
  if (owner === undefined) return undefined
  if (owner.closed?.reason === 'stopped') return undefined
  return owner
}
