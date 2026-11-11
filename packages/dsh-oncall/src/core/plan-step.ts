/**
 * What a Case does next.
 *
 * The input type is the interesting part: `lastOutcome` accepts only a settled
 * `done`. A Case that is blocked, failed or waiting needs a person or a trigger,
 * and must never reach here — so the caller cannot pass those states in, and the
 * compiler rejects the attempt instead of trusting a runtime `if` that someone
 * will eventually delete.
 *
 * A `blocked` Case that receives a new message is resumed by its own path
 * (`docs/design/super-plugin.md` 7.3), not by pretending its outcome was `done`.
 *
 * Note: 为何用窄类型而不在函数内判空、为何步数上限是 40 —— 见 docs/design/super-plugin-code.md 2.3。
 */

import { MAX_STEPS_PER_CASE } from '../contract/defaults.ts'
import type { CaseRecord, Outcome, PresetId, Step } from '../contract/types.ts'

/** How much of the Case's step allowance is spent. */
export interface Budget {
  readonly stepsSpent: number
  readonly maxSteps: number
}

/** The only outcomes that can be planned from: one settled success, or none. */
export type PlannableOutcome = Extract<Outcome, { kind: 'done' }> | undefined

/**
 * The next Step for one Case.
 *
 * Total by construction: every path returns a Step, including the closed case and
 * the exhausted budget. A function that can silently return nothing is how
 * "the Case just stopped moving" bugs happen.
 */
export function planStep(input: {
  readonly theCase: CaseRecord
  readonly lastOutcome: PlannableOutcome
  readonly budget: Budget
  readonly preset: PresetId
}): Step {
  const { theCase, lastOutcome, budget, preset } = input

  if (theCase.closed !== null) return { kind: 'close', reason: theCase.closed.reason }
  if (budget.stepsSpent >= budget.maxSteps) return { kind: 'close', reason: 'stopped' }
  if (lastOutcome === undefined) return { kind: 'work', brief: theCase.brief, preset }

  return { kind: 'close', reason: 'completed' }
}

/** The default budget for a Case that has spent `stepsSpent` steps. */
export function budgetOf(stepsSpent: number): Budget {
  return { stepsSpent, maxSteps: MAX_STEPS_PER_CASE }
}
