/**
 * What a Case does next.
 *
 * The shape follows `dsh-superagent`'s `Tickets`/`Assignments`: a Case that has a
 * running step is not given a second one (`idle`), a `ready` report closes it, and
 * the step allowance closes it as `stopped` when a looping worker would otherwise
 * burn a night of tokens. `close` carries the reason so the caller never invents one.
 *
 * `brief` is the text this step is told to do, not the Case's original request: a
 * follow-up and a recovery note are different briefs for the same Case.
 *
 * Note: 为何步数上限是 40、为何用联合类型而不是可选字段 —— 见
 * docs/design/oncall-v0-architecture.md 与 docs/design/super-plugin-code.md 2.3。
 */

import type { CaseRecord, Step, StepRecord } from '../contract/types.ts'

/** How much of the Case's step allowance is spent. */
export interface Budget {
  readonly stepsSpent: number
  readonly maxSteps: number
}

/**
 * The next Step for one Case.
 *
 * Total by construction: every path returns a Step, including the closed Case, the
 * exhausted budget and the Case that is still working. A function that can silently
 * return nothing is how "the Case just stopped moving" bugs happen.
 */
export function planStep(input: {
  readonly theCase: CaseRecord
  readonly steps: readonly StepRecord[]
  readonly budget: Budget
  /** The text the next step would work on. */
  readonly brief: string
}): Step {
  const { theCase, steps, budget, brief } = input

  if (theCase.closed !== null) return { kind: 'close', reason: theCase.closed.reason }

  const last = steps[steps.length - 1]
  const report = last?.report ?? null
  // A terminal report ends the Case even while its step runs: `dsh-superagent`
  // closes the ticket inside `report()`, whatever the assignment state is.
  if (report?.state === 'ready') return { kind: 'close', reason: 'completed' }
  if (report?.state === 'dropped') return { kind: 'close', reason: 'dropped' }

  // A step that is still running is the Case's current work: queueing another
  // would give one Case two workers.
  if (last?.state === 'running') return { kind: 'idle' }

  if (budget.stepsSpent >= budget.maxSteps) return { kind: 'close', reason: 'stopped' }

  return { kind: 'work', brief }
}

/** The default budget for a Case that has spent `stepsSpent` steps. */
export function budgetOf(stepsSpent: number, maxSteps: number): Budget {
  return { stepsSpent, maxSteps }
}
