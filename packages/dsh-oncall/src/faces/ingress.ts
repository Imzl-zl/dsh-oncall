/**
 * The pass loop: one pass at a time, forever.
 *
 * ### A timeout, not an interval
 *
 * `setInterval` fires whether or not the previous pass finished, so a slow GitHub
 * read stacks passes on top of each other — and two passes reading the same cursor
 * both decide to open a Case. Scheduling the next pass only after this one settles
 * makes overlap unrepresentable, which is the same reason `dsh-superagent` runs
 * `passes.ts` as "one pass at a time".
 *
 * ### Failures do not stop the loop
 *
 * `runPass` already records a per-source failure and keeps going. What can still
 * throw is the ledger commit or a bug in the pass itself; that goes to `onError` and
 * the next tick is still scheduled. Stopping the loop on one failed write would turn
 * a transient storage error into "the agent silently stopped watching".
 *
 * `onError` is required, not defaulted: a loop that swallows its own exceptions is
 * indistinguishable from a loop that is not running, and that difference is the
 * whole point of having the loop.
 *
 * Note: 为何用 timeout 而不是 interval、为何失败不终止 —— 见 docs/design/super-plugin.md 7.1。
 */

import type { Policy } from '../contract/policy.ts'
import type { Source } from '../sources/source.ts'
import type { Ledger } from '../runtime/ledger.ts'
import { runPass, type PassReport } from '../runtime/pass.ts'

/** The timer surface, injected so a test can drive ticks without waiting. */
export interface Scheduler {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface IngressLoopInput {
  readonly sources: readonly Source[]
  readonly ledger: Ledger
  /** Read on every pass, so a settings save takes effect without a restart. */
  readonly policy: () => Policy
  readonly intervalMs: number
  readonly now: () => number
  readonly onPass: (report: PassReport) => void
  readonly onError: (error: unknown, at: number) => void
  readonly scheduler?: Scheduler
}

export interface IngressLoopHandle {
  /** Stop scheduling and cancel an in-flight pass. Idempotent. */
  stop(): void
  /** Resolves when the current pass (if any) has settled. */
  settled(): Promise<void>
}

const systemScheduler: Scheduler = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Start the loop. The first pass runs immediately so a mention is not delayed. */
export function startIngressLoop(input: IngressLoopInput): IngressLoopHandle {
  const scheduler = input.scheduler ?? systemScheduler
  const controller = new AbortController()
  let stopped = false
  let timer: unknown
  let current: Promise<void> = Promise.resolve()

  const schedule = (): void => {
    if (stopped) return
    timer = scheduler.set(() => { void tick() }, input.intervalMs)
  }

  const tick = (): void => {
    const at = input.now()
    current = (async () => {
      try {
        const report = await runPass({
          sources: input.sources,
          ledger: input.ledger,
          policy: input.policy(),
          now: at,
          signal: controller.signal,
        })
        input.onPass(report)
      } catch (error) {
        input.onError(error, at)
      }
      schedule()
    })()
  }

  tick()

  return {
    stop() {
      if (stopped) return
      stopped = true
      scheduler.clear(timer)
      controller.abort()
    },
    settled: () => current,
  }
}
