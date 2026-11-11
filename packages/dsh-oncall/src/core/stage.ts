/**
 * The Case's stage, derived from its records.
 *
 * Nothing writes this value to storage. A stored state and the facts it claims to
 * summarize are two sources of truth, and they diverge the first time a write
 * succeeds and the state update fails. Deriving on read costs one pure function
 * call per read and cannot diverge by construction.
 *
 * The precedence below is `dsh-superagent`'s table (`src/core/stage.ts`,
 * `docs/003-execution.md`「Ticket stages」) read top to bottom: the first matching
 * row wins, and the rows are ordered so the more urgent fact shadows the less
 * urgent one. A Case whose last step succeeded but whose follow-up could not be
 * delivered is *delivery-failed*, not *review* — the person cannot act on the
 * review until the message reaches them.
 *
 * Note: 为何状态派生而不落库、与 dsh-superagent 的七行表如何对应 —— 见
 * docs/design/oncall-v0-architecture.md 与 .agents/notes/implemented/2026-11-09-ingress-decision-layer.md
 */

import type { CaseRecord, Stage, StepRecord } from '../contract/types.ts'

/** Everything the derivation reads. All of it comes from records. */
export interface CaseFacts {
  readonly theCase: CaseRecord
  /** Every step of the Case, oldest first. */
  readonly steps: readonly StepRecord[]
  /** When delivery to the worker last failed, if it did. */
  readonly deliveryFailedAt: number | undefined
}

/**
 * One Case's stage.
 *
 * `since` always comes from the record that caused the branch, so the panel can
 * say "waiting since 20:41" without a second clock.
 */
export function deriveStage(facts: CaseFacts): Stage {
  const { theCase, steps, deliveryFailedAt } = facts

  if (theCase.closed !== null) return { kind: 'done', how: theCase.closed.reason, at: theCase.closed.at }
  if (deliveryFailedAt !== undefined) return { kind: 'needs-person', reason: 'delivery-failed', since: deliveryFailedAt }

  const last = steps[steps.length - 1]
  const report = last?.report ?? null
  // `ready` and `dropped` both wait on the Case's own close, which the executor
  // writes in the same transaction; a stage read in between shows the review.
  if (report?.state === 'ready' || report?.state === 'dropped') return { kind: 'needs-person', reason: 'review', since: report.at }
  if (report?.state === 'blocked') return { kind: 'needs-person', reason: 'question', since: report.at }
  if (report?.state === 'failed') return { kind: 'needs-person', reason: 'failed', since: report.at }
  if (last === undefined) return { kind: 'queued', since: theCase.openedAt }
  // A turn that ended without a report leaves the Case idle: the worker said
  // nothing final, so it waits for a trigger rather than for a person.
  if (report?.state === 'waiting' || last.state === 'ended') {
    return { kind: 'waiting', since: report?.at ?? last.endedAt ?? last.at }
  }
  return { kind: 'working', since: report?.at ?? last.at }
}
