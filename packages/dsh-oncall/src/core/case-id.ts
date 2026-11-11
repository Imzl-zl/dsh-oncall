/**
 * The identity of a Case, derived from the Trigger that opened it.
 *
 * `case:<trigger key>` rather than a counter, for one reason: a Case id that is a
 * function of the event is idempotent for free. A retried pass computes the same
 * id, the ledger already has that Case, and no second one can exist for one comment —
 * without a uniqueness constraint, a sequence generator or a lock.
 *
 * The cost is that ids are long and unreadable in a URL. The panel shows the brief
 * and the thread, never the id, so nothing depends on it being short.
 */

import type { CaseId, TriggerKey } from '../contract/types.ts'

/** The one Case a given external event may open. */
export function caseIdOf(trigger: TriggerKey): CaseId {
  return `case:${trigger}` as CaseId
}

/**
 * The one input row for a message routed to a Case: one per (Case, Trigger).
 *
 * Deterministic, so a re-read of the same comment finds the row the first pass wrote
 * instead of routing it again. `dsh-superagent` derives its input ids the same way
 * (`core/ids.ts` `key('input', …)` — content-derived, never a counter).
 */
export function inputIdOf(caseId: CaseId, trigger: TriggerKey): string {
  return `${caseId}:${trigger}`
}
