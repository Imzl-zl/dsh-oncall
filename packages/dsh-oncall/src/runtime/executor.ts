/**
 * The assignment lifecycle: start a worker session, deliver, wait, settle.
 *
 * ### What this module is allowed to know
 *
 * Cases, steps, and one turn's outcome. It does not know which provider or model a
 * session runs, which source produced the message, or what a GitHub comment is —
 * the guard in `tests/executor.mjs` fails if any of those words appear here. All of
 * that arrives through `TurnHost`, whose implementation is the assembly
 * (`src/index.ts`). That is what keeps "换渠道" and "换执行后端" from touching the
 * lifecycle.
 *
 * ### Why `steps` and not an input queue
 *
 * A step **is** the assignment (`docs/design/oncall-v0-architecture.md` §三): it
 * stays `running` after its turn ends, because it is still the assignment the Case
 * is working through. A follow-up is delivered into the live session instead of
 * queueing another assignment, so the row needs no `pending` state and the worker
 * reads the follow-up in the conversation it is already in.
 *
 * ### Two clocks, deliberately separate
 *
 * A turn ends (`whenIdle` + one `turn/end` fact) and an assignment settles (a report
 * is written, the Case may close). They are not the same event: `interrupted` and
 * `max-tokens` end a turn without settling anything, and the retry below starts a
 * **new assignment** rather than reopening the turn — so "how many real calls a step
 * may make" stays owned by the router and this file never counts a retry.
 *
 * Note: 为何 follow-up 直接投进活会话、为何层 B 是新派工 —— 见
 * docs/design/oncall-v0-architecture.md 三/四/五节。
 */

import { briefOf } from '../core/brief.ts'
import { inputIdOf } from '../core/case-id.ts'
import { budgetOf, planStep } from '../core/plan-step.ts'
import { planReply, type ReplyPlan } from '../core/reply-plan.ts'
import { MAX_SESSION_TITLE_CHARS, MAX_STEPS_PER_CASE, RECOVERY_NOTE, TRANSIENT_RETRIES, TRANSIENT_RETRY_BASE_MS } from '../contract/defaults.ts'
import type {
  AuditEvent,
  CaseId,
  CaseRecord,
  ClosedReason,
  ReplyIntent,
  Report,
  StepRecord,
  StampedReport,
  ThreadKey,
  TriggerKey,
} from '../contract/types.ts'
import type { Ledger } from './ledger.ts'
import type { FollowUpDelivery, FollowUpPort } from './pass.ts'

/** How much of the Case id survives into the session id. */
const SESSION_TAIL_CHARS = 48

/**
 * Why a turn ended, in this module's own vocabulary.
 *
 * `src/index.ts` projects DSH's `TurnEndReason` onto this union, so the mapping
 * from "a turn ended" to "an assignment reported" is decided and tested here rather
 * than in the assembly.
 */
export type TurnEnd =
  | { readonly kind: 'completed' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'forked' }
  | { readonly kind: 'aborted'; readonly reason: string }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string; readonly retryAfterMs?: number }

/** The two facts this module reads out of a session's log. */
export type TurnFact =
  | { readonly kind: 'turn-end'; readonly turn: number; readonly reason: TurnEnd }
  | { readonly kind: 'assistant'; readonly turn: number; readonly text: string }

/**
 * The session side of the world, as the executor needs it.
 *
 * No `selectModel`: the worker's route is the composition's business (the router's
 * chain and the session's own default), and a method that takes a provider/model
 * pair would be a way for the wrong module to name one. `resolveAgent`/`create`
 * carry the id and the working directory only.
 */
export interface TurnHost {
  /** Whether the id names a session this composition can talk to (resuming from storage counts). */
  resolveAgent(sessionId: string): Promise<boolean>
  /** Create the session under exactly this id and title. */
  create(input: { readonly sessionId: string; readonly cwd: string; readonly title: string }): Promise<void>
  /** Queue one user message under an id we chose. Never blocks on the turn. */
  followup(input: { readonly sessionId: string; readonly messageId: string; readonly text: string }): void
  /** Whether this message id is already delivered — the session log and the inbox are both checked. */
  holds(sessionId: string, messageId: string): boolean
  /** Resolves when the agent has no active driver left (immediately when already idle). */
  whenIdle(sessionId: string): Promise<void>
  /** The session's log, oldest first, as the facts above. */
  log(sessionId: string): readonly TurnFact[]
  /** Whether the message that queued this turn survives a crash. */
  flush(): Promise<void>
  /** `agent/status` reached `idle`. The executor also waits on `whenIdle`; this is the re-entry path. */
  onIdle(listener: (sessionId: string) => void): () => void
  /**
   * What layer A concluded about the turn that just ended.
   *
   * `undefined` — layer A did not give up (the failure is the route's own fact).
   * `transient` — the whole chain is spent on a failure a retry may fix.
   * `terminal` — the whole chain is spent on a failure that will not (auth, quota,
   * an invalid request); retrying only spends tokens.
   */
  exhausted(sessionId: string, turn: number, code: string): 'transient' | 'terminal' | undefined
}

/**
 * Where a settled report's receipt goes.
 *
 * The executor decides *whether* a receipt is owed (`core/reply-plan.ts`) and the
 * outbox decides *how* it lands; this port is the seam, so neither module knows the
 * other's tables.
 */
export interface ReplyPort {
  queue(input: {
    readonly caseId: CaseId
    readonly seq: number
    readonly thread: ThreadKey
    readonly intent: ReplyIntent
    readonly text: string
  }): void
}

export interface ExecutorOptions {
  readonly ledger: Ledger
  readonly host: TurnHost
  readonly replier?: ReplyPort
  /** Working directory of the worker sessions. */
  readonly workdir: string
  readonly now: () => number
  readonly logger: { warn(message: string): void; error(message: string): void }
  /** The first passing-failure wait; overridable so a test does not sleep for 15 seconds. */
  readonly retryBaseMs?: number
}

/** One Case's in-flight settle work, so two deliveries cannot settle the same turn twice. */
interface Watch {
  busy: boolean
  again: boolean
}

/**
 * The one session a Case works in.
 *
 * A pure function of the Case id: the restart path resolves the same session instead
 * of creating a second one, and the id is readable in a log line. The hash is there
 * because sanitising can collide (two comment ids that differ only in punctuation),
 * and a collision would put two Cases in one session.
 */
export function caseSessionId(caseId: CaseId): string {
  const text = String(caseId).replace(/^case:/, '')
  const tail = text.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(-SESSION_TAIL_CHARS)
  return `oncall-case-${tail}-${digest64(text)}`
}

/**
 * Two FNV-1a passes with different seeds, base 36: 64 bits of digest.
 *
 * One 32-bit pass is not enough here. The id it feeds is what keeps two Cases in
 * separate sessions, so a collision silently puts two pieces of work in one
 * conversation — and 32 bits collide at about 1% after 10k Cases (birthday bound).
 * 64 bits move that to the same probability after ~4 billion.
 */
function digest64(text: string): string {
  const pass = (seed: number, salt: string): string => {
    let hash = seed
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    for (let index = 0; index < salt.length; index += 1) {
      hash ^= salt.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(36)
  }
  return `${pass(0x811c9dc5, '')}${pass(0x9e3779b9, ':oncall')}`
}

/** The session title: the first line of what was asked. */
export function titleOf(theCase: CaseRecord): string {
  const firstLine = theCase.brief.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  if (firstLine === '') return `oncall ${theCase.id}`
  return firstLine.length <= MAX_SESSION_TITLE_CHARS ? firstLine : `${firstLine.slice(0, MAX_SESSION_TITLE_CHARS)}…`
}

/** The one message id a follow-up keeps for its whole life. */
export function followUpMessageId(caseId: CaseId, trigger: string): string {
  return `oncall:${caseId}:${trigger}`
}

/** What a new assignment says when the previous one never reported. */
export function recoveryBriefOf(theCase: CaseRecord): string {
  return `${theCase.brief}\n\n${RECOVERY_NOTE}`
}

/** The last turn that ended, or `undefined` before the first one. */
function lastTurnEnd(facts: readonly TurnFact[]): { turn: number; reason: TurnEnd } | undefined {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index]!
    if (fact.kind === 'turn-end') return { turn: fact.turn, reason: fact.reason }
  }
  return undefined
}

/** The last thing the worker said in one turn. */
function lastTextOf(facts: readonly TurnFact[], turn: number): string {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index]!
    if (fact.kind !== 'assistant' || fact.turn !== turn) continue
    return fact.text.trim()
  }
  return ''
}

/**
 * What one ended turn means for its assignment.
 *
 * `null` means "do not settle": an interrupted turn is the restart path's business
 * (a new assignment with the recovery note), a truncated turn is the router's
 * existing continue logic, and an aborted one was cancelled by somebody — reporting
 * a failure for it would blame the work for the harness's decision.
 */
export function reportOfTurn(reason: TurnEnd, lastText: string, at: number): StampedReport | null {
  switch (reason.kind) {
    case 'completed':
      // No `ready`: the worker did not say it was done, so the Case waits for a
      // trigger instead of closing on the executor's guess.
      return { state: 'waiting', summary: lastText, at }
    case 'error':
      return { state: 'failed', summary: reason.message, code: reason.code, at }
    case 'blocked':
      return { state: 'failed', summary: lastText, code: 'BLOCKED', at }
    case 'interrupted':
    case 'max-tokens':
    case 'aborted':
    // A fork seed is the only producer of `forked`, and a worker session is never
    // forked; treating it as a restart keeps the total mapping honest.
    case 'forked':
      return null
  }
}

/** The assignment lifecycle for every Case this plugin works. */
export class Executor implements FollowUpPort {
  private readonly options: ExecutorOptions
  /** caseId → the session it works in, and back. Rebuilt by the startup scan. */
  private readonly caseOfSession = new Map<string, CaseId>()
  /** The last turn this process settled, per session: a repeated idle must not rewrite a report. */
  private readonly settledTurn = new Map<string, number>()
  private readonly watches = new Map<string, Watch>()
  /** Deliveries per Case, serialised: two messages in one poll must not both start seq 1. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Layer B assignments already spent, per Case. Process memory: a restart is a new incident. */
  private readonly retries = new Map<string, number>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private unsubscribe: (() => void) | undefined
  private started = false
  private stopped = false

  constructor(options: ExecutorOptions) {
    this.options = options
  }

  private get ledger(): Ledger { return this.options.ledger }
  private get host(): TurnHost { return this.options.host }
  private get logger(): ExecutorOptions['logger'] { return this.options.logger }

  /**
   * The restart scan.
   *
   * Only open Cases are looked at, and only three answers exist: a running
   * assignment with a report is waiting for a trigger (do nothing), a running
   * assignment without one was interrupted by the restart (end it, start a new one
   * with the recovery note), and no running assignment means the Case never started
   * or finished its last one (start it).
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.host.onIdle(sessionId => {
      if (this.caseOfSession.has(sessionId)) this.wake(sessionId)
    })
    for (const theCase of this.ledger.allCases()) {
      if (this.stopped) return
      if (theCase.closed !== null) continue
      const steps = this.ledger.stepsOf(theCase.id)
      const last = steps[steps.length - 1]
      if (last?.state === 'running') {
        // A report is only "settled" when nothing reached the worker after it: an input
        // delivered after a report was lost with the turn that ended, so the assignment
        // restarts with the recovery note (`core/assignments.ts:83-92`).
        if (last.report !== null && !this.busyAfter(theCase.id, last.report.at)) continue
        await this.recover(theCase, last)
        continue
      }
      await this.startStepAndDeliver(theCase, theCase.brief)
    }
  }

  /** Stop consuming timers and idle events. Idempotent. */
  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * A message for a Case that already owns its thread.
   *
   * Queued per Case and never awaited by the caller: the pass must not wait for a
   * model turn. Two messages from one poll arrive here in order, so the second one
   * sees the step the first one started.
   */
  deliver(input: FollowUpDelivery): void {
    const tail = this.queues.get(input.caseId) ?? Promise.resolve()
    const next = tail
      .then(() => this.route(input))
      .catch(error => this.logger.error(`oncall: delivering to ${input.caseId} failed: ${String(error)}`))
    this.queues.set(input.caseId, next)
    void next.then(() => {
      if (this.queues.get(input.caseId) === next) this.queues.delete(input.caseId)
    })
  }

  // ---- routing one arriving message ----

  private async route(input: FollowUpDelivery): Promise<void> {
    if (this.stopped) return
    const theCase = this.ledger.caseOf(input.caseId)
    if (theCase === undefined) return

    const steps = this.ledger.stepsOf(input.caseId)
    // The Case's own brief is what a first assignment works on — the message that
    // opened the Case is not re-sent as a follow-up, or the worker would read it twice.
    const opening = steps.length === 0 && input.text.trim() === theCase.brief.trim()

    // A follow-up already delivered stays delivered, even across a close: the source
    // re-reads a minute of history on every poll, and "the same comment resumed a
    // finished Case" is the one duplicate a person would notice.
    if (!opening) {
      const existing = caseSessionId(theCase.id)
      if (await this.host.resolveAgent(existing) && this.host.holds(existing, followUpMessageId(theCase.id, input.trigger))) {
        // 消息早就在会话里了：输入行也必须盖上，否则它永远停在 deliveredAt:null，
        // 每一轮 poll 都会重投一次 no-op。
        await this.markDelivered(theCase.id, input.trigger)
        return
      }
    }

    const running = steps[steps.length - 1]
    if (running?.state === 'running' && theCase.closed === null) {
      const sessionId = await this.ensureSession(theCase)
      await this.deliverTurn(sessionId, theCase.id, running.seq, input.text, input.trigger)
      return
    }

    // Nothing is running: this message opens the next assignment.
    const brief = opening ? theCase.brief : briefOf(input.text)
    const started = await this.startStep(theCase, brief)
    if (started === undefined) return
    await this.deliverTurn(started.sessionId, theCase.id, started.step.seq, brief, opening ? undefined : input.trigger)
  }

  /** End an assignment the restart orphaned, then start the next one with the recovery note. */
  private async recover(theCase: CaseRecord, last: StepRecord): Promise<void> {
    const now = this.options.now()
    await this.ledger.writeSteps(
      [{ ...last, state: 'ended', endedAt: now }],
      [{ kind: 'step.interrupted', at: now, caseId: theCase.id, seq: last.seq }],
    )
    await this.startStepAndDeliver(theCase, recoveryBriefOf(theCase))
  }

  private async startStepAndDeliver(theCase: CaseRecord, brief: string): Promise<void> {
    const started = await this.startStep(theCase, brief)
    if (started === undefined) return
    await this.deliverTurn(started.sessionId, theCase.id, started.step.seq, brief)
  }

  /**
   * Open the next assignment, if the Case should have one.
   *
   * A closed Case is reopened first: a message on a thread whose Case ended (anything
   * but `stopped`, which `core/thread-owner.ts` already filtered out) brings it back,
   * because the subscription never went away. The step allowance survives the reopen —
   * a resumed Case does not get a second budget.
   */
  private async startStep(theCase: CaseRecord, brief: string): Promise<{ step: StepRecord; sessionId: string } | undefined> {
    const steps = this.ledger.stepsOf(theCase.id)
    const budget = budgetOf(steps.length, MAX_STEPS_PER_CASE)

    if (theCase.closed !== null) {
      if (budget.stepsSpent >= budget.maxSteps) {
        await this.closeCase(theCase.id, 'stopped')
        return undefined
      }
      await this.ledger.reopenCase(theCase.id)
    } else {
      const plan = planStep({ theCase, steps, budget, brief })
      if (plan.kind === 'close') {
        await this.closeCase(theCase.id, plan.reason)
        return undefined
      }
      if (plan.kind === 'idle') return undefined
    }

    const seq = (steps[steps.length - 1]?.seq ?? 0) + 1
    const step: StepRecord = { caseId: theCase.id, seq, state: 'running', brief, report: null, at: this.options.now() }
    // The step lands before the message: a crash in between leaves a running
    // assignment with no report, which the restart scan turns into the recovery note.
    await this.ledger.writeSteps([step])
    return { step, sessionId: await this.ensureSession(theCase) }
  }

  // ---- one turn at a time, then settle ----

  /**
   * Deliver one message under an id that makes a replay a no-op.
   *
   * An assignment's own message is `oncall:<caseId>#<seq>`, unique per assignment. A
   * follow-up is `oncall:<caseId>:<trigger>` — **without** the seq, because a comment
   * re-read by the next poll (the source's 60-second overlap window) must stay
   * recognised even after the assignment that consumed it closed the Case. With the
   * seq in the id, a re-read would look new, reopen the Case and wake the worker for
   * a comment it already handled (measured in `oncall-loop.mjs` phase 2).
   */
  private async deliverTurn(sessionId: string, caseId: CaseId, seq: number, text: string, trigger?: string): Promise<void> {
    const messageId = trigger === undefined ? `oncall:${caseId}#${seq}` : `oncall:${caseId}:${trigger}`
    if (!this.host.holds(sessionId, messageId)) {
      this.host.followup({ sessionId, messageId, text })
      // The message has to outlive the process that queued it before the step does,
      // or a crash looks like "the worker never heard this assignment".
      void this.host.flush().catch(error => {
        this.logger.warn(`oncall: flushing the worker session failed: ${String(error)}`)
      })
    }
    if (trigger !== undefined) await this.markDelivered(caseId, trigger as TriggerKey)
    this.wake(sessionId)
  }

  /**
   * The input row's `deliveredAt`: the message is in the worker's session now.
   *
   * Written whether or not this process sent it (`holds` already answers that), so a
   * crash between the pass's commit and this delivery leaves `deliveredAt: null` and
   * the next poll delivers again — a no-op if it landed, the actual delivery if not.
   */
  private async markDelivered(caseId: CaseId, trigger: TriggerKey): Promise<void> {
    const id = inputIdOf(caseId, trigger)
    const input = this.ledger.inputOf(id)
    if (input === undefined || input.deliveredAt !== null) return
    await this.ledger.writeInputs([{ ...input, deliveredAt: this.options.now() }])
  }

  /**
   * Arm the settle loop for one session.
   *
   * `whenIdle` is the wait; the idle event that reached us is the re-entry path when
   * the delivery had not started a turn yet (waiting on "already idle" would settle
   * an older turn and exit). The `again` flag makes a follow-up that arrives during
   * a settle run one more round instead of being lost.
   */
  private wake(sessionId: string): void {
    if (this.stopped) return
    const watch = this.watches.get(sessionId) ?? { busy: false, again: false }
    this.watches.set(sessionId, watch)
    watch.again = true
    if (watch.busy) return
    watch.busy = true
    void (async () => {
      try {
        while (watch.again && !this.stopped) {
          watch.again = false
          await this.host.whenIdle(sessionId)
          await this.settle(sessionId)
        }
      } catch (error) {
        this.logger.error(`oncall: settling the worker session failed: ${String(error)}`)
      } finally {
        watch.busy = false
        if (this.watches.get(sessionId) === watch && !watch.again) this.watches.delete(sessionId)
      }
    })()
  }

  /**
   * Write what the turn said on the assignment, then let the core decide the Case.
   *
   * A turn is settled at most once per process: an idle event that repeats must not
   * rewrite the same report (the audit would gain a row for nothing).
   */
  private async settle(sessionId: string): Promise<void> {
    const caseId = this.caseOfSession.get(sessionId)
    if (caseId === undefined) return
    const theCase = this.ledger.caseOf(caseId)
    if (theCase === undefined || theCase.closed !== null) return

    const steps = this.ledger.stepsOf(caseId)
    const last = steps[steps.length - 1]
    if (last === undefined || last.state !== 'running') return

    const facts = this.host.log(sessionId)
    const end = lastTurnEnd(facts)
    if (end === undefined) return
    if (end.turn <= (this.settledTurn.get(sessionId) ?? -1)) return
    // 先记后写会吞掉一次写失败：那一轮从此再也不会被结算。所以写在成功之后再记。
    const settledTurn = end.turn

    const now = this.options.now()
    const fromTurn = reportOfTurn(end.reason, lastTextOf(facts, end.turn), now)
    if (fromTurn === null) return
    // A silent turn must not erase a claim the worker already made (`progress`,
    // `blocked`, `failed`): those still describe the work. Two silent turns in a row
    // are the same fact with a newer sentence, so `waiting` may replace `waiting`; and
    // when the worker said nothing at all the report keeps its previous summary
    // (`executor/dsh.ts:666`: `said || before`).
    let report: StampedReport | null = fromTurn
    if (fromTurn.state === 'waiting') {
      if (last.report !== null && last.report.state !== 'waiting') report = null
      else if (fromTurn.summary === '') report = { ...fromTurn, summary: last.report?.summary ?? '' }
    }
    if (report === null) {
      // A turn that ended as turns do resets the passing-failure count (`dsh.ts:606`).
      this.settledTurn.set(sessionId, settledTurn)
      this.retries.delete(caseId)
      return
    }

    // A passing failure is not a report: the SAME assignment goes on after its backoff
    // (`executor/dsh.ts:548-576`). Only a failure that will not pass, or one whose
    // retries are spent, becomes the assignment's `failed` report.
    if (report.state === 'failed' && this.host.exhausted(sessionId, end.turn, report.code) === 'transient') {
      if (this.retryTurn(theCase, sessionId, last, report, end.reason, end.turn)) {
        // 这一轮已经处置过（排了重试）：不记下来的话，settle 循环会对着同一个 turn/end
        // 反复结算，几毫秒内把三次重试全烧掉，然后落一个 failed。
        this.settledTurn.set(sessionId, settledTurn)
        return
      }
    }
    this.retries.delete(caseId)

    const settled: StepRecord = { ...last, report }
    const plan = planStep({
      theCase,
      steps: [...steps.slice(0, -1), settled],
      budget: budgetOf(steps.length, MAX_STEPS_PER_CASE),
      brief: '',
    })
    const closing = plan.kind === 'close' ? plan.reason : undefined
    const audit: AuditEvent = {
      kind: 'step.settled',
      at: now,
      caseId,
      seq: last.seq,
      state: report.state,
      ...(report.state === 'failed' ? { code: report.code } : {}),
    }
    await this.ledger.writeSteps(
      [closing === undefined ? settled : { ...settled, state: 'ended', endedAt: now }],
      [audit],
    )
    if (closing !== undefined) await this.ledger.closeCase(caseId, closing, now)
    // 写成功后才认这一轮已经结算；抛错时下一轮 idle 会重试。
    this.settledTurn.set(sessionId, settledTurn)

    this.queueReply(theCase, last.seq, planReply({ caseId, seq: last.seq, report }))
  }

  /**
   * The worker's own report (`oncall_report`).
   *
   * Written when it arrives, not at turn end: `ready` closes the Case and the receipt
   * goes out while the turn is still finishing, which is what the person reading the
   * issue needs. The later settle sees a closed Case and does nothing.
   */
  async submitReport(input: { readonly sessionId: string; readonly report: Report }): Promise<
    { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly reason: string }
  > {
    const caseId = this.caseFor(input.sessionId)
    if (caseId === undefined) {
      return { ok: false, reason: 'this session is not working an on-call Case; nothing to report on.' }
    }
    const theCase = this.ledger.caseOf(caseId)
    if (theCase === undefined) return { ok: false, reason: `the Case ${caseId} no longer exists.` }
    if (theCase.closed !== null) return { ok: false, reason: `the Case already ended (${theCase.closed.reason}).` }

    const steps = this.ledger.stepsOf(caseId)
    const last = steps[steps.length - 1]
    if (last === undefined || last.state !== 'running') {
      return { ok: false, reason: 'no assignment is running for this Case right now.' }
    }

    const now = this.options.now()
    const report: StampedReport = { ...input.report, at: now } as StampedReport
    // 不要把这一轮先标成 ended 再问 planStep：那样 `blocked`/`progress` 会掉进预算分支，
    // 第 40 个派工上的一句"卡住了"会把 Case 关成 stopped。planStep 的 ready/dropped
    // 检查排在 running 之前，所以保持 running 也能正确关闭。
    const plan = planStep({
      theCase,
      steps: [...steps.slice(0, -1), { ...last, report }],
      budget: budgetOf(steps.length, MAX_STEPS_PER_CASE),
      brief: last.brief,
    })
    const closing = plan.kind === 'close' ? plan.reason : undefined
    await this.ledger.writeSteps(
      [closing === undefined ? { ...last, report } : { ...last, report, state: 'ended', endedAt: now }],
      [{
        kind: 'step.settled',
        at: now,
        caseId,
        seq: last.seq,
        state: report.state,
        ...(report.state === 'failed' ? { code: report.code } : {}),
      }],
    )
    if (closing !== undefined) await this.ledger.closeCase(caseId, closing, now)
    this.queueReply(theCase, last.seq, planReply({ caseId, seq: last.seq, report }))
    return { ok: true, seq: last.seq }
  }

  private queueReply(theCase: CaseRecord, seq: number, plan: ReplyPlan | undefined): void {
    if (plan === undefined) return
    const thread = theCase.mandate.scope[0]
    if (thread === undefined) {
      this.logger.warn(`oncall: ${theCase.id} has no thread to answer on; the receipt stays unsent`)
      return
    }
    this.options.replier?.queue({ caseId: theCase.id, seq, thread, intent: plan.intent, text: plan.text })
  }

  /** The Case a session works, mapping first and then by derivation (the restart path). */
  private caseFor(sessionId: string): CaseId | undefined {
    const known = this.caseOfSession.get(sessionId)
    if (known !== undefined) return known
    for (const theCase of this.ledger.allCases()) {
      if (caseSessionId(theCase.id) !== sessionId) continue
      this.caseOfSession.set(sessionId, theCase.id)
      return theCase.id
    }
    return undefined
  }

  /**
   * One more turn of the same assignment after a passing failure.
   *
   * Not a new assignment and not a report: a message telling the worker to continue is
   * queued into the same session after a backoff (`executor/dsh.ts:555-576`). The count
   * is per Case and reset by the next turn that ends normally (`:606`), so a flapping
   * channel cannot keep one Case awake forever.
   *
   * @returns `false` when the retries are spent — the caller writes the `failed` report.
   */
  private retryTurn(
    theCase: CaseRecord,
    sessionId: string,
    last: StepRecord,
    report: Extract<StampedReport, { state: 'failed' }>,
    reason: TurnEnd,
    turn: number,
  ): boolean {
    const tries = this.retries.get(theCase.id) ?? 0
    if (tries >= TRANSIENT_RETRIES) {
      this.logger.warn(`oncall: ${theCase.id} spent its passing-failure retries; reporting the failure`)
      return false
    }
    this.retries.set(theCase.id, tries + 1)
    const base = this.options.retryBaseMs ?? TRANSIENT_RETRY_BASE_MS
    const asked = reason.kind === 'error' ? reason.retryAfterMs ?? 0 : 0
    const delay = Math.max(base * 2 ** tries, asked)
    const note = `上一回合因为可恢复的原因失败了（${report.summary.slice(0, 200)}）。从中断的地方继续这次派工。`
    // The failing turn names the message: stable for that turn, and it cannot collide
    // with a later attempt after the count resets.
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.retryNow(theCase.id, sessionId, last.seq, turn, note)
    }, Math.max(0, delay))
    this.timers.add(timer)
    return true
  }

  /** Deliver one retry message into the session the assignment already runs in. */
  private async retryNow(caseId: CaseId, sessionId: string, seq: number, turn: number, note: string): Promise<void> {
    if (this.stopped) return
    const theCase = this.ledger.caseOf(caseId)
    if (theCase === undefined || theCase.closed !== null) return
    const steps = this.ledger.stepsOf(caseId)
    const last = steps[steps.length - 1]
    if (last === undefined || last.seq !== seq || last.state !== 'running') return
    const messageId = `oncall:${caseId}:retry:${turn}`
    if (!this.host.holds(sessionId, messageId)) {
      this.host.followup({ sessionId, messageId, text: note })
      void this.host.flush().catch(error => {
        this.logger.warn(`oncall: flushing the worker session failed: ${String(error)}`)
      })
    }
    this.wake(sessionId)
  }

  /** Whether an input reached the worker after `at` — the last turn that reported was still unprocessed. */
  private busyAfter(caseId: CaseId, at: number): boolean {
    return this.ledger.inputsOf(caseId).some(input => input.deliveredAt !== null && input.deliveredAt >= at)
  }

  // ---- the session side ----

  private async ensureSession(theCase: CaseRecord): Promise<string> {
    const sessionId = caseSessionId(theCase.id)
    if (!this.caseOfSession.has(sessionId)) this.caseOfSession.set(sessionId, theCase.id)
    if (await this.host.resolveAgent(sessionId)) return sessionId
    await this.host.create({ sessionId, cwd: this.options.workdir, title: titleOf(theCase) })
    return sessionId
  }

  private async closeCase(caseId: CaseId, reason: ClosedReason): Promise<void> {
    const steps = this.ledger.stepsOf(caseId)
    const last = steps[steps.length - 1]
    if (last !== undefined && last.state === 'running') await this.endStep(last)
    await this.ledger.closeCase(caseId, reason, this.options.now())
  }

  /** One assignment is over: the step stops being the Case's current work. */
  private async endStep(step: StepRecord, audit: readonly AuditEvent[] = []): Promise<void> {
    await this.ledger.writeSteps([{ ...step, state: 'ended', endedAt: this.options.now() }], audit)
  }
}
