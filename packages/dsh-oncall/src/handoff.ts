/**
 * Delegation handoff: one roster, one tool, one projection, one ledger.
 *
 * The design (docs/design/handoff-proposal.md) has one invariant this file
 * exists to keep: **the plugin never decides whether the work is done.** It
 * records what the model declared (a `finish` receipt, a `delegate` call, a
 * reviewer's structured verdict) and enforces the gates the user configured.
 * There is no branch here that reads task state out of text.
 *
 * Three facts, three homes — and none of them is a second copy of another:
 *
 * - **The roster** is config (`config.ts`). This module compiles it into the
 *   tool description (main model) and into the dispatch request (child).
 * - **What happened** is the `oncall/handoff` session projection: it folds
 *   `user/message` (the reset epoch), `tool/call` + `tool/result` (attempts and
 *   receipts) and `step/start` (the open turn). Replayable from the durable log,
 *   so a restarted Host sees the same counters.
 * - **What a reviewer concluded** is the ledger (`storageDomain`, process memory
 *   without it). A verdict is not derivable from the log — the structured result
 *   only exists in the activation's `result` promise — so it is written down
 *   once, when the child settles.
 *
 * The budget counters are the projection's; the budget a new session inherits is
 * the ledger's, because a projection cannot be seeded from another session's
 * state. Gates read both and add them.
 *
 * Note: 为何复核结论落 storageDomain、为何简报用插件自有 source kind、为何拒绝走
 * HarnessError —— 见 .agents/notes/implemented/2026-10-24-handoff-roster-and-gates.md
 */

import type { Agent, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ReasoningEffortId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { HandoffConfig, RosterEntry } from './config.ts'
import { HANDOFF_FAILOVER_INHERIT, HANDOFF_FAILOVER_NONE } from './defaults.ts'
import {
  addCarried,
  HANDOFF_KEY,
  HANDOFF_TOOL,
  type HandoffCountable,
  type HandoffRecord,
} from './handoff-wire.ts'
import type { HandoffCounters } from './handoff-wire.ts'
import { handoffLedgerMemoryNotice } from './notice.ts'


declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A message this plugin put into a session on the model's behalf.
     *
     * It is a `user`-role message — the model must treat the briefing as a task,
     * not as background — but the source is this plugin's own kind, because the
     * projection has to tell "a human spoke" (reset the budget epoch) from "the
     * plugin carried the task over" (do not reset). A plain `kind: 'user'` with an
     * in-memory id set cannot survive replay, and the carried budget would be
     * reset by the very message that carries it.
     */
    'oncall-handoff': {
      readonly kind: 'oncall-handoff'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** The ledger's storage domain name (`UNIT_NAME_RE`: lowercase, digits, `_`). */
export const HANDOFF_LEDGER_DOMAIN = 'oncall_handoff'

/**
 * The reviewer's structured verdict.
 *
 * The plugin owns this schema, not the roster: a gate has to *read* the verdict,
 * and a user-defined shape would force the plugin to guess which field means
 * "passed". See F-16 in docs/design/agent-fleet-drawer.md §9.3.
 */
export const REVIEW_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'gaps'] },
    gaps: { type: 'array', items: { type: 'string' } },
    recommend: { type: 'string', enum: ['continue', 'newSession', 'done'] },
  },
} as const

/** What a reviewer concluded, as the ledger stores it. */
export interface ReviewVerdict {
  verdict: 'pass' | 'gaps'
  gaps?: string[]
  recommend?: 'continue' | 'newSession' | 'done'
}

// ---------------- session projection ----------------

/** A call whose result has not arrived yet: a rejected call must not spend budget. */
interface PendingCall {
  callId: string
  epoch: number
  turn?: number
  at: number
  /** Parsed off `tool/call.arguments`; the result does not carry it. */
  action?: string
  rosterId?: string
  /** `finish`'s declared outcome, so the activity stream can name it. */
  outcome?: string
}

export interface HandoffProjectionState extends HandoffCountable {
  /** Countable facts `facts{}` reports; folded here so the tool never walks the log. */
  stats: { turns: number; compactions: number; toolFailures: number }
  /** The most recent human message, truncated — `attach.userRequest`. */
  lastUserText?: string
  pending: PendingCall[]
}

/** Bounded so one long session cannot grow the wire view without limit. */
const MAX_RECORDS = 200

/** A human message can be long; the child gets the request, not the whole paste. */
const MAX_USER_TEXT = 2000

const recordSchema = z.object({
  at: z.number(),
  epoch: z.number(),
  turn: z.number().optional(),
  kind: z.enum(['delegate', 'finish', 'newSession', 'facts']),
  rosterId: z.string().optional(),
  outcome: z.string().optional(),
})

const pendingSchema = z.object({
  callId: z.string(),
  epoch: z.number(),
  turn: z.number().optional(),
  at: z.number(),
  action: z.string().optional(),
  rosterId: z.string().optional(),
  outcome: z.string().optional(),
})

const projectionStateSchema = z.object({
  epoch: z.number(),
  openTurn: z.number().optional(),
  stats: z.object({ turns: z.number(), compactions: z.number(), toolFailures: z.number() }),
  lastUserText: z.string().optional(),
  pending: z.array(pendingSchema),
  records: z.array(recordSchema),
}).strict()

/** `arguments` is the raw model JSON string; a malformed one names no action. */
function parseCall(raw: string): { action?: string; rosterId?: string; outcome?: string } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as { action?: unknown; rosterId?: unknown; outcome?: unknown }
    return {
      action: typeof record.action === 'string' ? record.action : undefined,
      rosterId: typeof record.rosterId === 'string' ? record.rosterId : undefined,
      outcome: typeof record.outcome === 'string' ? record.outcome : undefined,
    }
  } catch {
    return {}
  }
}

function recordKindOf(action: string | undefined): HandoffRecord['kind'] | undefined {
  switch (action) {
    case 'delegate': return 'delegate'
    case 'finish': return 'finish'
    case 'newSession': return 'newSession'
    case 'facts': return 'facts'
    default: return undefined
  }
}

function trim(records: HandoffRecord[]): HandoffRecord[] {
  return records.length <= MAX_RECORDS ? records : records.slice(records.length - MAX_RECORDS)
}

/**
 * The fold. Deliberately narrow: it answers "what did the model declare", never
 * "was the work good". A rejected call (a `tool/result` with `isError`) leaves no
 * record, which is what keeps a refused `delegate` from spending budget.
 */
export const handoffProjection = {
  key: HANDOFF_KEY,
  stateVersion: 1,
  stateSchema: projectionStateSchema,
  init: (): HandoffProjectionState => ({
    epoch: 0,
    stats: { turns: 0, compactions: 0, toolFailures: 0 },
    pending: [],
    records: [],
  }),
  apply(state: HandoffProjectionState, event: SessionEvent): HandoffProjectionState {
    // `compaction/start` is declared by `@deepseek-ai/dsh-compaction`'s own
    // SessionEventMap augmentation, which this package does not import; the
    // event name is a durable string either way (packages/compaction/
    // compaction-basic/src/region.ts:210-245), so it is matched by name.
    if ((event.type as string) === 'compaction/start') {
      return { ...state, stats: { ...state.stats, compactions: state.stats.compactions + 1 } }
    }
    switch (event.type) {
      case 'user/message': {
        // Only a human resets the budget (proposal §8). Our own briefing is
        // `oncall-handoff`, a settlement is `subagent-settled`.
        if (event.data.source.kind !== 'user') return state
        const text = event.data.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => block.text)
          .join('\n')
          .slice(0, MAX_USER_TEXT)
        return {
          ...state,
          epoch: state.epoch + 1,
          ...text === '' ? {} : { lastUserText: text },
        }
      }
      case 'turn/end': {
        return { ...state, stats: { ...state.stats, turns: state.stats.turns + 1 } }
      }
      case 'step/start': {
        const { turn } = event.data
        if (typeof turn !== 'number') return state
        return state.openTurn === turn ? state : { ...state, openTurn: turn }
      }
      case 'tool/call': {
        if (event.data.name !== HANDOFF_TOOL) return state
        const parsed = parseCall(event.data.arguments)
        return {
          ...state,
          pending: [...state.pending, {
            callId: event.data.callId,
            epoch: state.epoch,
            ...state.openTurn === undefined ? {} : { turn: state.openTurn },
            at: event.time,
            ...parsed,
          }],
        }
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const failed = event.data.message.isError === true
        const stats = failed
          ? { ...state.stats, toolFailures: state.stats.toolFailures + 1 }
          : state.stats
        const call = state.pending.find(entry => entry.callId === callId)
        if (call === undefined) return stats === state.stats ? state : { ...state, stats }
        const pending = state.pending.filter(entry => entry.callId !== callId)
        // A failed call is not a receipt: it spent nothing, so it records nothing.
        if (failed) return { ...state, stats, pending }
        const kind = recordKindOf(call.action)
        if (kind === undefined) return { ...state, stats, pending }
        const record: HandoffRecord = {
          at: event.time,
          epoch: call.epoch,
          ...call.turn === undefined ? {} : { turn: call.turn },
          kind,
          ...call.rosterId === undefined ? {} : { rosterId: call.rosterId },
          // Only a `finish` declares an outcome; any other action's `outcome`
          // argument is not a fact the record may claim.
          ...kind !== 'finish' || call.outcome === undefined ? {} : { outcome: call.outcome },
        }
        return { ...state, stats, pending, records: trim([...state.records, record]) }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: projectionStateSchema,
    view: (state: HandoffProjectionState) => state,
  },
}

// `handoffCounters` and `reviewRosterIds` live in `handoff-wire.ts`: the fleet
// tab reads the same fold to paint "已用 / 上限", and one expression is what keeps
// the painted number equal to the number the gate refuses on.

// ---------------- ledger ----------------

/** One reviewer's conclusion, written when its activation settles. */
export interface ReviewRecord {
  childId: string
  rosterId: string
  /**
   * The budget epoch the review was *dispatched* in.
   *
   * Dispatch, not settlement: a human who speaks while the reviewer runs makes
   * that review stale — it never saw the new instruction — and a gate that
   * accepted it would let a finish through on an outdated verdict. Fail closed.
   */
  epoch: number
  verdict: 'pass' | 'gaps'
  gaps: string[]
  at: number
}

/** Budget carried into a session by `newSession` (proposal §4.6 step 4). */
export interface CarriedBudget {
  delegations: number
  reviews: number
  newSessions: number
  perRole: Record<string, number>
}

const reviewRecordSchema: z.ZodType<ReviewRecord> = z.object({
  childId: z.string(),
  rosterId: z.string(),
  epoch: z.number(),
  verdict: z.enum(['pass', 'gaps']),
  gaps: z.array(z.string()),
  at: z.number(),
})

const carriedBudgetSchema: z.ZodType<CarriedBudget> = z.object({
  delegations: z.number(),
  reviews: z.number(),
  newSessions: z.number(),
  perRole: z.record(z.string(), z.number()),
})

/** `storageDomain` as this module calls it (the same optional-service rule as bindings.ts). */
interface StorageDomainFace {
  open(spec: unknown): Promise<OpenDomain>
}

interface OpenDomain {
  table(name: string): LedgerTable
  close(): Promise<void>
}

interface LedgerTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

interface LedgerContext {
  get(name: string): unknown
  logger: { error(message: string): void }
  effect(execute: () => () => void, label?: string): void
}

/** The ledger's one domain: two tables, both plain JSON. */
export const handoffLedgerDomain = defineDomain({
  name: HANDOFF_LEDGER_DOMAIN,
  version: 1,
  tables: {
    reviews: domainTable(z.array(reviewRecordSchema)),
    budgets: domainTable(carriedBudgetSchema),
  },
})

/**
 * The one ledger: reviewer verdicts and the budget a `newSession` carried.
 *
 * Durable when `storageDomain` is present, process memory otherwise — and when
 * it falls back the session says so once, because a gate whose record evaporates
 * on restart must not look persistent.
 */
export class HandoffLedger {
  private readonly reviews = new Map<string, ReviewRecord[]>()
  private readonly carried = new Map<string, CarriedBudget>()
  private readonly ctx: LedgerContext
  private readonly opening: Promise<void>
  private reviewTable: LedgerTable | undefined
  private budgetTable: LedgerTable | undefined
  private closed = false
  private announced = false

  constructor(ctx: LedgerContext) {
    this.ctx = ctx
    this.opening = this.open()
  }

  /** Whether a write survives a restart. False = process memory only. */
  get persistent(): boolean {
    return this.reviewTable !== undefined && this.budgetTable !== undefined && !this.closed
  }

  /** Every review of this session's children, oldest first. */
  reviewsOf(sessionId: string): ReviewRecord[] {
    const memory = this.reviews.get(sessionId) ?? []
    if (this.closed || this.reviewTable === undefined) return memory
    const raw = this.reviewTable.get(sessionId)
    return Array.isArray(raw) ? raw as ReviewRecord[] : memory
  }

  /** Record one settled review. Durable first; a failed write reaches the caller. */
  async recordReview(sessionId: string, record: ReviewRecord): Promise<void> {
    const next = [...this.reviewsOf(sessionId).filter(entry => entry.childId !== record.childId), record]
    this.reviews.set(sessionId, next)
    await this.opening
    if (this.closed || this.reviewTable === undefined) return
    await this.reviewTable.put(sessionId, next)
  }

  /** The budget a `newSession` carried into this session, if any. */
  carriedOf(sessionId: string): CarriedBudget | undefined {
    const memory = this.carried.get(sessionId)
    if (this.closed || this.budgetTable === undefined) return memory
    const raw = this.budgetTable.get(sessionId)
    return raw === undefined ? memory : raw as CarriedBudget
  }

  /** Hand this session's budget to a new one (proposal §4.6 step 4). */
  async carry(sessionId: string, budget: CarriedBudget): Promise<void> {
    this.carried.set(sessionId, budget)
    await this.opening
    if (this.closed || this.budgetTable === undefined) return
    await this.budgetTable.put(sessionId, budget)
  }

  /**
   * Say once, in the session, that the ledger is memory-only.
   *
   * Only when a review actually lands: an enabled-but-unused roster must not
   * paste a warning into a conversation that never delegated.
   */
  announceOnce(session: Session): void {
    if (this.persistent || this.announced) return
    this.announced = true
    session.append('user/message', handoffLedgerMemoryNotice(), { surfaceOp: 'append' })
  }

  private async open(): Promise<void> {
    const facility = this.ctx.get('storageDomain') as StorageDomainFace | undefined
    if (facility === undefined) return
    try {
      const domain = await this.openDomain(facility)
      this.ctx.effect(() => () => {
        this.closed = true
        this.reviewTable = undefined
        this.budgetTable = undefined
        void domain.close()
      }, 'router: handoff ledger domain')
      this.reviewTable = domain.table('reviews')
      this.budgetTable = domain.table('budgets')
    } catch (error) {
      this.ctx.logger.error(
        `oncall: the ${HANDOFF_LEDGER_DOMAIN} storage domain could not open; `
        + `the review ledger falls back to process memory and will not survive a restart: ${String(error)}`,
      )
    }
  }

  private async openDomain(facility: StorageDomainFace): Promise<OpenDomain> {
    let lastError: unknown
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await facility.open(handoffLedgerDomain)
      } catch (error) {
        lastError = error
        if ((error as { code?: unknown }).code !== 'already-open') throw error
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      }
    }
    throw lastError
  }
}

// ---------------- roster → description / dispatch ----------------

/** The `purpose`-only menu the main model reads, plus the rules it must follow. */
export function compileDescription(config: HandoffConfig): string {
  const roster = config.roster
  const lines: string[] = []
  lines.push('Delegate work to one of the user\'s preset roles, sign off a finished turn, open a fresh session, or read the countable facts of this session.')
  if (roster.length === 0) {
    lines.push('No roles are configured, so delegate will be refused. The user adds roles in the router settings.')
  } else {
    lines.push('Roles (pick by purpose):')
    for (const entry of roster) {
      const budget = entry.maxRunsPerUserMessage <= 0
        ? 'not delegable'
        : `max ${entry.maxRunsPerUserMessage} per user message`
      lines.push(`- ${entry.id}${entry.name === '' ? '' : ` (${entry.name})`}${entry.role === 'review' ? ' [review]' : ''}: ${entry.purpose} — ${budget}`)
    }
  }
  const actions: string[] = []
  if (config.protocol.delegate) actions.push('delegate{rosterId, task, focusPaths?}')
  if (config.protocol.finish) actions.push('finish{outcome, report, handoffNote?, reviewId?, reviewOverride?}')
  actions.push('newSession{reason, handoffNote}')
  if (config.protocol.facts) actions.push('facts{}')
  lines.push(`Actions: ${actions.join(' / ')}.`)
  if (config.protocol.requireReviewFor.length > 0) {
    const reviewers = roster.filter(entry => entry.role === 'review').map(entry => entry.id)
    lines.push(
      `A finish with outcome ${config.protocol.requireReviewFor.join('/')} is refused unless a review role `
      + `${reviewers.length === 0 ? '(none configured — add one)' : reviewers.join('/')} produced a passing verdict `
      + 'after the most recent user message.'
      + (config.protocol.allowReviewOverride
        ? ' reviewOverride with a written reason skips it; the reason is recorded and shown to the user.'
        : ' reviewOverride is disabled, so a review is the only way through.'),
    )
  }
  lines.push(
    `Limits: at most ${config.limits.maxDelegationsPerTurn} delegation(s) per turn, `
    + `${config.limits.maxDelegationsPerUserMessage} per user message, `
    + `${config.limits.maxReviewsPerUserMessage} review(s) per user message, `
    + `${config.limits.maxNewSessionsPerUserMessage} new session(s) per user message.`,
  )
  if (config.newSession.onFinish.length > 0) {
    lines.push(`A finish with outcome ${config.newSession.onFinish.join('/')} must carry handoffNote — the new session gets it as the next step.`)
  }
  // 交接的两半，缺任何一半模型都不会主动交：**何时**交（它没被告知就不会想到），
  // 以及 **note 里必须写什么**（只说"继续"等于把问题原样搬过去）。这两句是模型
  // 唯一能读到交接契约的地方，所以写在这里而不是文档里。
  lines.push(
    'Hand over with newSession when: the user asks for a fresh session or a new-session prompt; '
    + 'this turn finished its part and the next step is a review or an independent task; '
    + 'or the context has been compacted repeatedly while the task still has a long way to go '
    + '(a clean session with a written note is cheaper than continuing to compact).',
    'The handoffNote is the next session\'s task, written by you from what this session actually did — '
    + 'never a summary of the conversation. It must name: the verifiable boundary of what is finished, '
    + 'the exact next step and the files it touches, what must not be redone, what to read first, '
    + 'and the acceptance requirement the user stated. A note that only says "continue" is not a handover.',
  )
  lines.push('facts{} reports compaction count, turns, failed tool calls, goal, todos and how many times each role was delegated.')
  return lines.join('\n')
}

/**
 * Build the child's prompt: `instructions → task → attached facts`.
 *
 * The order is the proposal's (§4.3): the role first knows how it works, then
 * what this job is, then the artefacts. Nothing here paraphrases the model's own
 * `task` text, and nothing re-states the parent's conclusions.
 */
export function buildPrompt(entry: RosterEntry, task: string, facts: readonly { title: string; body: string }[]): ContentBlock[] {
  const parts: string[] = []
  if (entry.instructions.trim() !== '') parts.push(entry.instructions.trim())
  parts.push(task.trim())
  for (const fact of facts) parts.push(`【${fact.title}】\n${fact.body}`)
  return [{ type: 'text', text: parts.join('\n\n') }]
}

/** The message the plugin puts in a session on the model's behalf. */
export function handoffMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'oncall-handoff', form: 'notice', summary: boundContextSummary(text) },
  })
}

// ---------------- gates ----------------

/** Everything a gate needs, resolved once per tool call. */
export interface GateInput {
  config: HandoffConfig
  counters: HandoffCounters
  carried: CarriedBudget | undefined
  reviews: readonly ReviewRecord[]
  /** True when the session has an active goal. */
  goalActive: boolean
}

/**
 * The effective per-epoch numbers: what the projection saw plus what a new
 * session inherited. The addition itself lives in `handoff-wire.ts` because the
 * fleet tab paints the same sum.
 */
export function effectiveBudget(gate: GateInput): { delegations: number; reviews: number; newSessions: number; perRole: Record<string, number> } {
  return addCarried(gate.counters, gate.carried)
}

/** Reject with the gate that stopped it, in the model's language and with the numbers. */
export function gateRefusal(message: string, code: string): never {
  throw new HarnessError(`oncall handoff: ${message}`, code)
}

/** The most recent review that is still newer than the last human message. */
export function latestReview(
  reviews: readonly ReviewRecord[],
  epoch: number,
  reviewId?: string,
): ReviewRecord | undefined {
  const current = reviews.filter(record => record.epoch === epoch && (reviewId === undefined || record.childId === reviewId))
  return current.length === 0 ? undefined : current[current.length - 1]
}

/**
 * The `finish` gate, in the proposal's order (§4.4): goal first, then review,
 * then the `handoffNote` requirement. Each refusal names the rule and the
 * numbers, and never guesses what the model meant.
 *
 * `reviewOverride` waives the REVIEW rule only — the note requirement is a
 * different question (does the relay have a next step at all) and keeps its
 * own gate below.
 */
export function checkFinishGate(
  gate: GateInput,
  args: { outcome: string; handoffNote?: string; reviewId?: string; reviewOverride?: string },
): void {
  if (args.outcome === 'done' && gate.goalActive) {
    gateRefusal(
      'done is refused while this session has an active goal — completion is the goal\'s call. '
      + 'Complete or clear the goal first, or finish with needs_user.',
      'HANDOFF_GOAL_ACTIVE',
    )
  }
  const needsReview = (gate.config.protocol.requireReviewFor as readonly string[]).includes(args.outcome)
  if (needsReview) {
    const review = latestReview(gate.reviews, gate.counters.epoch, args.reviewId)
    if (review?.verdict !== 'pass') {
      const override = args.reviewOverride?.trim() ?? ''
      // 覆盖只跳过**复核**这一道闸，不能连带跳过后面的 note 闸：这两个是两件事，
      // 而且 note 闸守的是接力会话的下一步任务。从前这里 `return` 直接跳出整个
      // checkFinishGate，于是一句 override 就能开出一个没有任务的接力会话。
      if (override === '' || !gate.config.protocol.allowReviewOverride) {
        const detail = review === undefined
          ? `no review of this session landed after the last user message${args.reviewId === undefined ? '' : ` (reviewId ${args.reviewId} names none)`}`
          : review.verdict === 'gaps'
            ? `the latest review found gaps: ${review.gaps.length === 0 ? '(no detail)' : review.gaps.join('; ')}`
            : 'the latest review is not a passing one'
        gateRefusal(
          `finish{outcome: '${args.outcome}'} is refused — ${detail}. `
          + 'Delegate to a review role again, use needs_user, or pass reviewOverride with a written reason.'
          + (gate.config.protocol.allowReviewOverride ? '' : ' reviewOverride is disabled in this configuration.'),
          'HANDOFF_REVIEW_REQUIRED',
        )
      }
    }
  }
  if ((gate.config.newSession.onFinish as readonly string[]).includes(args.outcome)
    && (args.handoffNote ?? '').trim() === '') {
    gateRefusal(
      `finish{outcome: '${args.outcome}'} is refused — this outcome opens a new session automatically, `
      + 'so it must carry handoffNote saying where to continue.',
      'HANDOFF_NOTE_REQUIRED',
    )
  }
}

/** The `delegate` gate: per-turn, per-user-message, per-role and review budgets. */
export function checkDelegateGate(gate: GateInput, entry: RosterEntry): void {
  const budget = effectiveBudget(gate)
  if (entry.maxRunsPerUserMessage <= 0) {
    gateRefusal(`role '${entry.id}' is not delegable (maxRunsPerUserMessage = 0).`, 'HANDOFF_ROLE_CLOSED')
  }
  if (gate.counters.turnDelegations >= gate.config.limits.maxDelegationsPerTurn) {
    gateRefusal(
      `this turn already delegated ${gate.counters.turnDelegations} time(s), and maxDelegationsPerTurn is ${gate.config.limits.maxDelegationsPerTurn}. `
      + 'Finish the step or wait for the next turn.',
      'HANDOFF_TURN_BUDGET',
    )
  }
  if (budget.delegations >= gate.config.limits.maxDelegationsPerUserMessage) {
    gateRefusal(
      `this user message already delegated ${budget.delegations} time(s), and maxDelegationsPerUserMessage is ${gate.config.limits.maxDelegationsPerUserMessage}. `
      + 'Ask the user to continue, or finish.',
      'HANDOFF_MESSAGE_BUDGET',
    )
  }
  const used = budget.perRole[entry.id] ?? 0
  if (used >= entry.maxRunsPerUserMessage) {
    gateRefusal(
      `role '${entry.id}' was already delegated ${used} time(s) since the last user message, and its limit is ${entry.maxRunsPerUserMessage}.`,
      'HANDOFF_ROLE_BUDGET',
    )
  }
  if (entry.role === 'review' && budget.reviews >= gate.config.limits.maxReviewsPerUserMessage) {
    gateRefusal(
      `this user message already ran ${budget.reviews} review(s), and maxReviewsPerUserMessage is ${gate.config.limits.maxReviewsPerUserMessage}. `
      + 'Finish with needs_user and hand the gap list to the user.',
      'HANDOFF_REVIEW_BUDGET',
    )
  }
}

/** What a prompt template may name, and what each name resolves to. */
export interface HandoffPromptValues {
  /** Why the previous session handed over (`finish:done`, the model's reason, …). */
  reason: string
  /** The configured next action, already turned into a sentence. */
  nextAction: string
  /** The operator's standing requirement (`promptExtra`), or '' when unset. */
  extra: string
  /** The model-written handoff note — the next session's task. Never empty. */
  note: string
  /** The model-written finish report, or '' when it wrote none. */
  report: string
  /** The whole `【工件】` block, or '' when the configuration carries none. */
  artifacts: string
}

/**
 * Render the first message a relayed session receives.
 *
 * The template is user configuration (`newSession.promptTemplate`), the default
 * is the shipped wording, and the only rule is: **a line whose placeholder
 * resolved to nothing is dropped whole**. That is what keeps the rendering
 * identical to the pre-template output — `{report}` empty leaves no bare
 * heading, `{artifacts}` empty leaves no empty section.
 *
 * Unknown placeholders are left as written: refusing them is the structural
 * rule's job (../rules.ts), because a typo here silently drops content.
 */
export function renderHandoffPrompt(template: string, values: HandoffPromptValues): string {
  const rendered: string[] = []
  for (const line of template.split('\n')) {
    let resolved = line
    let empty = false
    for (const [name, value] of Object.entries(values)) {
      const token = `{${name}}`
      if (!resolved.includes(token)) continue
      if (value.trim() === '') empty = true
      resolved = resolved.split(token).join(value)
    }
    if (!empty) rendered.push(resolved)
  }
  return rendered.join('\n').trim()
}

/** The `newSession` gate: the budget that must not reset by changing sessions. */
export function checkNewSessionGate(gate: GateInput, handoffNote: string): void {
  const budget = effectiveBudget(gate)
  if (handoffNote.trim() === '') {
    gateRefusal('newSession needs a non-empty handoffNote: it is the next session\'s task.', 'HANDOFF_NOTE_REQUIRED')
  }
  if (budget.newSessions >= gate.config.limits.maxNewSessionsPerUserMessage) {
    gateRefusal(
      `this user message already opened ${budget.newSessions} new session(s), and maxNewSessionsPerUserMessage is `
      + `${gate.config.limits.maxNewSessionsPerUserMessage}. The count follows the binding, so a new session does not reset it.`,
      'HANDOFF_NEW_SESSION_BUDGET',
    )
  }
}

/** `none`/`inherit` are not chain ids: the routing side resolves the rest. */
export function failoverChainOf(entry: RosterEntry): string | undefined {
  return entry.failover === HANDOFF_FAILOVER_INHERIT || entry.failover === HANDOFF_FAILOVER_NONE
    ? undefined
    : entry.failover
}

/**
 * The selection a relayed session should start on, read off the old session's
 * own last request header (`session.requestHeader()?.config`).
 *
 * The header is the durable fact about what that session actually ran; the
 * in-memory selection lives on a private controller class no caller can reach.
 */
export function selectionOf(config: { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId } | undefined): ModelSelection | undefined {
  if (config?.provider === undefined || config.model === undefined) return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
  }
}

/** One agent's session id, for ledger keys. */
export function sessionIdOf(agent: Agent): string {
  return agent.session.id
}
