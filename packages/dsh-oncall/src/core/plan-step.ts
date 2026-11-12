/**
 * What a Case does next.
 *
 * The shape follows `dsh-superagent`'s `Tickets`/`Assignments`: a Case that has a
 * running step is not given a second one (`idle`), and a `ready`/`dropped` report
 * closes it. `close` carries the reason so the caller never invents one.
 *
 * **There is no step allowance.** The reference has none either: a worker cannot
 * start its own turn (a turn begins from an input), transient failures are retried
 * at most three times (`executor/dsh.ts:30`), background work is capped at 30
 * minutes, and after a `blocked`/`failed` report automatic inputs are held until a
 * person speaks (`core/model.ts:349` `waitsForPerson`). A count here would only be a
 * second, invented limit — and it closed Cases that were still waiting for a person
 * (2026-11-11).
 *
 * `brief` is the text this step is told to do, not the Case's original request: a
 * follow-up and a recovery note are different briefs for the same Case.
 *
 * Note: 为何步数上限是 40、为何用联合类型而不是可选字段 —— 见
 * docs/design/oncall-v0-architecture.md 与 docs/design/super-plugin-code.md 2.3。
 */

import type { CaseRecord, Step, StepRecord } from '../contract/types.ts'

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
  /** The text the next step would work on. */
  readonly brief: string
}): Step {
  const { theCase, steps, brief } = input

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

  return { kind: 'work', brief }
}
