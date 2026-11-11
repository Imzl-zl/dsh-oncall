/**
 * The Case's state, derived from its records.
 *
 * Nothing writes this value to storage. A stored state and the facts it claims to
 * summarize are two sources of truth, and they diverge the first time a write
 * succeeds and the state update fails. Deriving on read costs one pure function
 * call per read and cannot diverge by construction.
 *
 * The precedence below is the whole design: the first matching row wins, and the
 * rows are ordered so that the more urgent fact shadows the less urgent one. A
 * Case whose last step succeeded but whose follow-up could not be delivered is
 * *delivery-failed*, not *review* — the person cannot act on the review until the
 * message reaches them.
 *
 * Note: 为何状态派生而不落库、与 dsh-superagent 的七个 stage 如何对应 —— 见
 * docs/design/super-plugin.md 五节。
 * Note: 被否的「状态落库」方案 —— 见 .agents/notes/implemented/2026-11-09-ingress-decision-layer.md
 */

import type { CaseRecord, Outcome, Stage, StepRecord } from '../contract/types.ts'

/** Everything the derivation reads. All of it comes from records. */
export interface CaseFacts {
  readonly theCase: CaseRecord
  /** The outcome of the latest settled step, if any settled. */
  readonly lastOutcome: Outcome | undefined
  /** When that step settled. Required whenever `lastOutcome` is set. */
  readonly settledAt: number | undefined
  /** The step currently in flight, if one is. */
  readonly openStep: StepRecord | undefined
  /** When delivery to the worker last failed, if it did. */
  readonly deliveryFailedAt: number | undefined
}

/**
 * One Case's stage.
 *
 * Precedence: closed → delivery failed → step in flight → never settled →
 * then the last outcome. Each branch reports `since` from the record that caused
 * it, so the panel can say "waiting since 20:41" without a second clock.
 */
export function deriveStage(facts: CaseFacts): Stage {
  const { theCase, lastOutcome, settledAt, openStep, deliveryFailedAt } = facts

  if (theCase.closed !== null) return { kind: 'done', how: theCase.closed.reason, at: theCase.closed.at }
  if (deliveryFailedAt !== undefined) return { kind: 'needs-person', reason: 'delivery-failed', since: deliveryFailedAt }
  if (openStep !== undefined) return { kind: 'working', since: openStep.startedAt }
  if (lastOutcome === undefined) return { kind: 'queued', since: theCase.openedAt }

  const since = settledAt ?? theCase.openedAt
  switch (lastOutcome.kind) {
    case 'done': return { kind: 'needs-person', reason: 'review', since }
    case 'waiting': return { kind: 'waiting', since }
    case 'blocked': return { kind: 'needs-person', reason: 'question', since }
    case 'failed': return { kind: 'needs-person', reason: 'failed', since }
  }
}
