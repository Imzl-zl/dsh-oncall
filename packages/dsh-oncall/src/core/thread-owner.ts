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

import { admit } from './admission.ts'
import type { Policy } from '../contract/policy.ts'
import type { CaseId, CaseRecord, RefusalReason, ThreadRecord, Trigger } from '../contract/types.ts'

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

/**
 * Whether a message may wake the Case that owns its thread.
 *
 * A **live** Case is woken by anything that reaches its thread — "with no check of
 * who sent it" (`docs/001-domain.md:37`): a bot's CI result is context its worker
 * needs, and a subscription grants no new authority either way.
 *
 * An **ended** Case is different, and both rules are the reference's, not ours:
 *
 * 1. **Only a person wakes it.** "Bots and CI do not wake ended Tickets"
 *    (`docs/002-authorization.md:127`). A bot message is treated as having reached
 *    no Ticket at all — the caller falls through to the gate, which is our V0 stand-in
 *    for the evaluation layer.
 * 2. **The Mandate is revalidated under today's Policy before it resumes**
 *    (`docs/001-domain.md:34`, `docs/002-authorization.md:131`). A person removed from
 *    the allowed list must not keep a Case alive by commenting on it; the message then
 *    reaches no Ticket and is judged as an ordinary request.
 *
 * `stopped` never reaches here (`threadOwner` answers "no owner"), so a stopped Case
 * cannot be woken by anybody — "A Ticket a person stopped receives nothing."
 */
export function mayWake(input: {
  readonly theCase: CaseRecord
  readonly trigger: Trigger
  readonly policy: Policy
}): { readonly ok: true } | { readonly ok: false; readonly reason: RefusalReason } {
  const { theCase, trigger, policy } = input
  if (theCase.closed === null) return { ok: true }
  if (theCase.closed.reason === 'stopped') return { ok: false, reason: 'follow-up-owned' }
  if (trigger.actor.kind !== 'human') return { ok: false, reason: 'bot-not-allowed' }
  const verdict = admit({ trigger, policy })
  // Any admitted explicit request carries the Mandate; an inferred one does not,
  // because resuming is acting and an inferred candidate is not authorized to act
  // by itself in `observe`/`off`.
  if (!verdict.admitted) return { ok: false, reason: verdict.reason }
  if (verdict.strength !== 'explicit') return { ok: false, reason: 'inferred-mode-off' }
  return { ok: true }
}
