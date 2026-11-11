/**
 * The one `handoff` tool: delegate / finish / newSession / facts.
 *
 * The four actions share a single registration, a single roster lookup and a
 * single gate evaluation — there is no per-action save path and no second copy
 * of the limits. The split the proposal insists on is kept: the gates
 * (`requireReviewFor`, the three per-user-message budgets) are refusal
 * conditions, while `newSession.*` is the relay's behaviour; they are read from
 * different config sections and never merged into one switch.
 *
 * Refusals throw `HarnessError` (see F-17 in docs/design/agent-fleet-drawer.md
 * §9.3): the model reads the message, the durable `tool/result` carries
 * `isError`, and the projection therefore never bills a refused call to a budget.
 *
 * Note: 四个动作共用一个注册、拒绝走 HarnessError、接力六步 —— 见
 * .agents/notes/implemented/2026-10-24-handoff-roster-and-gates.md
 */

import type { Agent, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HandoffConfig, HandoffOutcome, RosterEntry } from './config.ts'
import {
  buildPrompt,
  checkDelegateGate,
  checkFinishGate,
  checkNewSessionGate,
  compileDescription,
  effectiveBudget,
  gateRefusal,
  handoffMessage,
  renderHandoffPrompt,
  REVIEW_VERDICT_SCHEMA,
  selectionOf,
  type CarriedBudget,
  type GateInput,
  type HandoffProjectionState,
  type ReviewRecord,
  type ReviewVerdict,
} from './handoff.ts'
import {
  HANDOFF_KEY,
  HANDOFF_TOOL,
  handoffCounters,
  reviewRosterIds,
  type HandoffCounters,
} from './handoff-wire.ts'
import { HANDOFF_NEXT_ACTION_TEXT } from './defaults.ts'
import type { SessionBindings } from './bindings.ts'
import type { HandoffLedger } from './handoff.ts'
import { handoffReceiptNotice, handoffRelayNotice } from './notice.ts'

/** A goal as this module reads it (`@deepseek-ai/dsh-goal`). */
export interface GoalLike {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  roundsStarted: number
  maxGoalRounds: number
}

/** One todo item, from the native `todos` projection. */
export interface TodoLike {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** `SessionController`'s public face (`dsh-api-session-controller/lib/types/index.d.ts:101,107`). */
export interface SessionControllerFace {
  create(request: { cwd: string; reusable: (sessionId: unknown) => boolean }): Promise<{ sessionId: unknown }>
  selectModel(request: { sessionId: unknown; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

/** `AgentRegistry`'s lookup (`dsh-agent/lib/types/index.d.ts:343`). */
export interface AgentRegistryFace {
  get(id: unknown): Agent | undefined
}

/** The optional services this module reaches through `ctx.get` (packages/AGENTS.md: optional services). */
export interface HandoffFaces {
  tools: { register(definition: unknown): unknown }
  subagents: {
    startActivation(spec: unknown): Promise<{
      childId: unknown
      result: Promise<{ structured?: unknown }>
      dispose(): Promise<void>
    }>
    /**
     * The registered backend names — `SubagentRuntime.list()` in rc.3
     * (`dsh-subagent/lib/types/index.d.ts:299`). Optional because the face is
     * structural: a composition that answers without it still delegates.
     */
    list?(): readonly string[]
  }
  goals?: {
    get(agent: Agent): GoalLike | undefined
    create(agent: Agent, request: { objective: string; maxGoalRounds?: number }): unknown
    clear(agent: Agent, ref: { id: string; revision: number }): unknown
  }
  /**
   * The PUBLIC SessionController face, and only that — resolved at CALL time.
   *
   * `create` / `selectModel` are the service's own methods
   * (`dsh-api-session-controller/lib/types/index.d.ts:101,107`). The three
   * methods this face used to declare — `createSession`, `selectionFor`,
   * `selectForNextRequest` — live on the private `ApiSessionAgentController`
   * (`agent.d.ts:92`), are not reachable through `ctx`, and calling them threw
   * `TypeError: controller.selectionFor is not a function` at runtime while the
   * `as` cast kept TypeScript quiet.
   *
   * A getter rather than the service: in a composition that mounts this package
   * later than the tool (the web profile does), a captured reference is
   * permanently `undefined` and every `newSession` refuses with
   * "this composition does not provide both" while the service is right there.
   */
  sessionController?: () => SessionControllerFace | undefined
  /**
   * The live-agent registry (`ctx.agents`), because `create` answers an id.
   *
   * `AgentRegistry.get(id)` — `dsh-agent/lib/types/index.d.ts:343`.
   */
  agents?: () => AgentRegistryFace | undefined
  projections?: {
    stateOf(session: Session, key: string): unknown
    snapshot(session: Session, keys?: readonly string[]): { values: Record<string, unknown> }
  }
  logger: { error(message: string): void; warn(message: string): void }
}

/**
 * What `delegate` returned.
 *
 * These are type aliases rather than interfaces on purpose: a tool's canonical
 * output is `JsonValue`, and only an alias gets the implicit index signature
 * that makes an object shape assignable to it.
 */
export type DelegateReceipt = {
  action: 'delegate'
  child: string
  rosterId: string
  attached: string[]
}

/**
 * What `finish` returned.
 *
 * `report` is echoed back because the model wrote it for the user ("what I did,
 * what is left") — without it the receipt answered only where the turn ended.
 */
export type FinishReceipt = {
  action: 'finish'
  recorded: true
  outcome: string
  report?: string
  newSessionId?: string
}

/** What `newSession` returned. */
export type NewSessionReceipt = {
  action: 'newSession'
  newSession: string
}

/**
 * What `facts` returned: countable facts only, never a judgment.
 *
 * Every count is `null` when this composition has no `oncall/handoff` projection
 * — an unknown number, not a measured zero. `todos` already worked that way;
 * the counters used to answer `0`, which reads as "nothing was ever delegated".
 */
export type FactsReceipt = {
  action: 'facts'
  compactions: number | null
  turns: number | null
  toolFailures: number | null
  goal: { objective: string; phase: string; roundsStarted: number } | null
  todos: { pending: number; inProgress: number; open: string[] } | null
  delegations: { total: number; perRole: Record<string, number> } | null
}

export type HandoffReceipt = DelegateReceipt | FinishReceipt | NewSessionReceipt | FactsReceipt

/** The tool's arguments, as the model writes them. */
export interface HandoffArgs {
  action: 'delegate' | 'finish' | 'newSession' | 'facts'
  rosterId?: string
  task?: string
  focusPaths?: string[]
  outcome?: HandoffOutcome
  report?: string
  handoffNote?: string
  reviewId?: string
  reviewOverride?: string
  reason?: string
}

/**
 * The active goal a relay found on the old session.
 *
 * `rebuilt` is false when the new session did not get its own goal — either
 * `keepGoal` is off, or `goals.create` failed — and the briefing therefore has
 * to carry the objective instead.
 */
interface CarriedGoal {
  readonly goal: GoalLike
  readonly rebuilt: boolean
}

/**
 * The runtime behind the tool: one instance per fiber, disposed with it.
 *
 * It holds no per-session state of its own — every counter comes from the
 * projection and every verdict from the ledger, so a config save (which
 * restarts the fiber) does not reset a budget or forget a review.
 */
export class HandoffRuntime {
  private readonly faces: HandoffFaces
  private readonly config: () => HandoffConfig
  private readonly ledger: HandoffLedger
  private readonly bindings: SessionBindings

  constructor(
    faces: HandoffFaces,
    config: () => HandoffConfig,
    ledger: HandoffLedger,
    bindings: SessionBindings,
  ) {
    this.faces = faces
    this.config = config
    this.ledger = ledger
    this.bindings = bindings
  }

  /** Register the one tool. Returns the registry's disposer, owned by the fiber. */
  register(): unknown {
    const config = this.config()
    return this.faces.tools.register(defineTool({
      name: HANDOFF_TOOL,
      description: compileDescription(config),
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['delegate', 'finish', 'newSession', 'facts'],
          description: 'delegate: hand a task to a roster role. finish: sign off this turn. newSession: carry the task to a fresh session. facts: read countable facts.',
        },
        rosterId: { type: 'string', description: 'Which roster role to delegate to (its id from the description).' },
        task: { type: 'string', description: 'What the role must do. Your words, not a summary of the conversation.' },
        focusPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the role should look at first.',
        },
        outcome: {
          type: 'string',
          enum: ['done', 'needs_user', 'abandoned'],
          description: 'finish: done = I finished; needs_user = a human must decide; abandoned = giving up.',
        },
        report: { type: 'string', description: 'finish: what you did and what is left, for the user.' },
        handoffNote: {
          type: 'string',
          description: 'finish/newSession: where the next session continues, what not to redo, what to read first.',
        },
        reviewId: { type: 'string', description: 'finish: the child session id of the review you are citing.' },
        reviewOverride: {
          type: 'string',
          description: 'finish: a written reason to skip a required review. Recorded and shown to the user.',
        },
        reason: { type: 'string', description: 'newSession: why this session should not continue.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: HandoffArgs, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
      },
      execute: (args: HandoffArgs, exec: ToolRunContext): Promise<HandoffReceipt> => this.run(args, exec),
    }))
  }

  private async run(args: HandoffArgs, exec: ToolRunContext): Promise<HandoffReceipt> {
    const agent = exec.agent
    if (agent === undefined) {
      gateRefusal('handoff needs a calling agent.', 'HANDOFF_AGENT_REQUIRED')
    }
    // Per-session filtering lives in the handler, never in a dynamic
    // registration: a tool that appears and disappears per session makes the
    // model's behaviour depend on who it is (proposal §4.2).
    if (agent.session.header.parentSession !== undefined) {
      gateRefusal(
        'handoff is available in top-level sessions only — a delegated child cannot delegate further.',
        'HANDOFF_NOT_TOP_LEVEL',
      )
    }
    const config = this.config()
    switch (args.action) {
      case 'delegate': return this.delegate(agent, config, args, exec.signal)
      case 'finish': return this.finish(agent, config, args)
      case 'newSession': return this.newSession(agent, config, args)
      case 'facts': return this.facts(agent, config)
      default:
        return gateRefusal(`unknown action '${String(args.action)}'.`, 'HANDOFF_UNKNOWN_ACTION')
    }
  }

  private async delegate(
    agent: Agent,
    config: HandoffConfig,
    args: HandoffArgs,
    signal: AbortSignal,
  ): Promise<DelegateReceipt> {
    if (!config.protocol.delegate) {
      gateRefusal('delegate is disabled by protocol.delegate.', 'HANDOFF_ACTION_DISABLED')
    }
    const rosterId = args.rosterId ?? ''
    const entry = config.roster.find(candidate => candidate.id === rosterId)
    if (entry === undefined) {
      const known = config.roster.map(candidate => candidate.id).join(', ')
      return gateRefusal(
        `no roster role '${rosterId}'. Configured roles: ${known === '' ? '(none)' : known}.`,
        'HANDOFF_UNKNOWN_ROLE',
      )
    }
    const task = (args.task ?? '').trim()
    if (task === '') {
      gateRefusal('delegate needs a non-empty task.', 'HANDOFF_TASK_REQUIRED')
    }
    const gate = this.gateFor(agent, config)
    checkDelegateGate(gate, entry)
    const facts = this.attachFacts(agent, entry, args.focusPaths ?? [])
    const route = this.agentOptionsOf(entry)
    const request: Record<string, unknown> = {
      parent: agent,
      prompt: buildPrompt(entry, task, facts),
      ...entry.preset.trim() === '' ? {} : { agentPreset: entry.preset.trim() },
      ...route === undefined ? {} : { agentOptions: route },
      // A reviewer must answer in a shape the gate can read; a worker returns prose.
      ...entry.role === 'review' ? { outputSchema: REVIEW_VERDICT_SCHEMA } : {},
    }
    const activation = await this.faces.subagents.startActivation({
      provider: config.subagentBackend,
      label: entry.name.trim() === '' ? entry.id : entry.name.trim(),
      request,
      signal,
      // `parent` is the native wake: the child's settlement notifies this
      // session through the inbox (manager.ts:1186-1206). `caller` would not.
      delivery: 'parent',
    })
    const child = String(activation.childId)
    this.watchReview(agent, entry, child, gate.counters.epoch, activation.result)
    return {
      action: 'delegate',
      child,
      rosterId: entry.id,
      attached: facts.map(fact => fact.title),
    }
  }

  /**
   * Record a reviewer's verdict when it settles.
   *
   * The result is never awaited by the tool (delegate returns immediately), so
   * the promise is watched here; a rejection is logged rather than swallowed,
   * and a child that returned no structured verdict counts as `gaps` — a gate
   * that treated silence as a pass would be the exact failure this ledger exists
   * to prevent.
   */
  private watchReview(
    agent: Agent,
    entry: RosterEntry,
    child: string,
    epoch: number,
    result: Promise<{ structured?: unknown }>,
  ): void {
    if (entry.role !== 'review') return
    const sessionId = agent.session.id
    void result.then(
      async (settled) => {
        const verdict = verdictOf(settled.structured)
        const record: ReviewRecord = {
          childId: child,
          rosterId: entry.id,
          epoch,
          verdict: verdict.verdict,
          gaps: verdict.gaps ?? [],
          at: Date.now(),
        }
        try {
          await this.ledger.recordReview(sessionId, record)
          this.ledger.announceOnce(agent.session)
        } catch (error) {
          this.faces.logger.error(`oncall: the review verdict for ${child} could not be stored: ${String(error)}`)
        }
      },
      (error: unknown) => {
        this.faces.logger.warn(`oncall: review child ${child} failed before producing a verdict: ${String(error)}`)
      },
    )
  }

  private finish(agent: Agent, config: HandoffConfig, args: HandoffArgs): Promise<FinishReceipt> {
    if (!config.protocol.finish) {
      gateRefusal('finish is disabled by protocol.finish.', 'HANDOFF_ACTION_DISABLED')
    }
    const outcome = args.outcome
    if (outcome === undefined) {
      gateRefusal('finish needs an outcome: done / needs_user / abandoned.', 'HANDOFF_OUTCOME_REQUIRED')
    }
    const gate = this.gateFor(agent, config)
    checkFinishGate(gate, {
      outcome,
      ...args.handoffNote === undefined ? {} : { handoffNote: args.handoffNote },
      ...args.reviewId === undefined ? {} : { reviewId: args.reviewId },
      ...args.reviewOverride === undefined ? {} : { reviewOverride: args.reviewOverride },
    })
    // 模型的收工说明：回执里原样带回，接力简报再引一句（见 relay / briefing），
    // 并留一条中文通知——否则"做了什么、还剩什么"只活在折叠的工具结果里。
    const report = (args.report ?? '').trim()
    if (report !== '') {
      agent.session.append('user/message', handoffReceiptNotice(outcome, report), { surfaceOp: 'append' })
    }
    const relay = (config.newSession.onFinish as readonly string[]).includes(outcome)
    if (!relay) {
      return Promise.resolve({ action: 'finish', recorded: true, outcome, ...report === '' ? {} : { report } })
    }
    return this.relay(agent, config, gate, `finish:${outcome}`, args.handoffNote ?? '', report).then(newSessionId => ({
      action: 'finish',
      recorded: true as const,
      outcome,
      ...report === '' ? {} : { report },
      newSessionId,
    }))
  }

  private newSession(agent: Agent, config: HandoffConfig, args: HandoffArgs): Promise<NewSessionReceipt> {
    const gate = this.gateFor(agent, config)
    checkNewSessionGate(gate, args.handoffNote ?? '')
    return this.relay(agent, config, gate, args.reason ?? '', args.handoffNote ?? '').then(newSession => ({
      action: 'newSession',
      newSession,
    }))
  }

  /**
   * The relay, in the proposal's six steps (§4.6).
   *
   * Note: 为何只走 SessionController 的公开面、为何 agents.get 补那一步 ——
   * 见 .agents/notes/implemented/2026-10-26-recheck-driven-fixes.md
   *
   * The first message is a `user`-role message this plugin sourced
   * (`oncall-handoff`): the model must treat it as the task, and the
   * projection must not mistake it for a human speaking — otherwise the carried
   * budget would be reset by the message that carries it.
   */
  private async relay(
    agent: Agent,
    config: HandoffConfig,
    gate: GateInput,
    reason: string,
    handoffNote: string,
    report = '',
  ): Promise<string> {
    // Resolved here, not at registration: the web composition mounts these two
    // services later than this tool, and a captured `undefined` would refuse
    // every relay for the life of the process.
    const controller = this.faces.sessionController?.()
    const registry = this.faces.agents?.()
    if (controller === undefined || registry === undefined) {
      gateRefusal(
        'newSession needs the session controller and the live-agent registry, and this composition does not provide both.',
        'HANDOFF_RELAY_UNAVAILABLE',
      )
    }
    const oldId = agent.session.id
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      gateRefusal(
        'newSession needs the session working directory, and this session has none.',
        'HANDOFF_RELAY_UNAVAILABLE',
      )
    }
    // 1. the old session's own selection, off its own last request header
    //    (falls back to nothing: the new session then follows the user's
    //    current choice).
    const selection = selectionOf(agent.session.requestHeader()?.config)
    // 2. a top-level session, not a child. `create` answers an id; the Agent
    //    comes from the registry the same creation published into.
    const created = await controller.create({ cwd, reusable: () => false })
    const newId = String(created.sessionId)
    const newAgent = registry.get(created.sessionId)
    if (newAgent === undefined) {
      gateRefusal(
        `newSession created session ${newId} but no live agent answers for it; the relay needs the agent to wake it.`,
        'HANDOFF_RELAY_UNAVAILABLE',
      )
    }
    // 3. first hop = the model the old session was on.
    if (config.newSession.carrySelection && selection !== undefined) {
      await controller.selectModel({
        sessionId: created.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
    }
    // 4. the chain binding and the budget counters follow the task.
    if (config.newSession.carryChainBinding) {
      const binding = this.bindings.read(oldId)
      if (binding !== undefined) await this.bindings.write(newId, binding)
      const budget = effectiveBudget(gate)
      await this.ledger.carry(newId, {
        delegations: budget.delegations,
        reviews: budget.reviews,
        newSessions: budget.newSessions + 1,
        perRole: budget.perRole,
      } satisfies CarriedBudget)
    }
    // 5. the goal is rebuilt *before* the briefing: a rebuild that fails has to
    //    reach the one message the new session receives (§4.6 step 6), and that
    //    message is composed once. The old goal is retired after it.
    const carried = this.rebuildGoal(agent, newAgent, config)
    const fallbackGoal = config.newSession.keepGoal && carried !== undefined && !carried.rebuilt
      ? carried.goal
      : undefined
    // 6. the briefing, then wake the new session with it.
    newAgent.followup(handoffMessage(this.briefing(agent, config, reason, handoffNote, report, fallbackGoal)))
    // 7. retire the old goal, then say where the task went.
    this.retireGoal(agent, carried?.goal)
    agent.session.append('user/message', handoffRelayNotice(newId, reason), { surfaceOp: 'append' })
    return newId
  }

  /**
   * The briefing: the configured template, the model's note, and the artefacts
   * the configuration lists.
   *
   * The template is user configuration with the shipped wording as its default
   * (`newSession.promptTemplate`); `renderHandoffPrompt` owns the substitution
   * and the "empty placeholder drops its line" rule, so a customised template
   * cannot degrade into bare headings.
   */
  private briefing(
    agent: Agent,
    config: HandoffConfig,
    reason: string,
    handoffNote: string,
    report: string,
    fallbackGoal?: GoalLike,
  ): string {
    const artifacts = this.briefingArtifacts(agent, config)
    // A goal that could not be rebuilt must survive in the briefing the model
    // reads as its task; otherwise `keepGoal` failing silently drops the
    // objective. Only when the configured list does not already carry it.
    if (fallbackGoal !== undefined && !config.newSession.briefing.includes('goal')) {
      artifacts.unshift({
        title: '目标（未能自动重建，请用 goal 工具重建）',
        body: `${fallbackGoal.objective}（${fallbackGoal.phase}，已用 ${fallbackGoal.roundsStarted} 轮）`,
      })
    }
    const artifactsBlock = artifacts.length === 0
      ? ''
      : ['【工件】', ...artifacts.map(artifact => `${artifact.title}：\n${artifact.body}`)].join('\n')
    return renderHandoffPrompt(config.newSession.promptTemplate, {
      reason,
      nextAction: `${config.newSession.nextAction}：${HANDOFF_NEXT_ACTION_TEXT[config.newSession.nextAction] ?? config.newSession.nextAction}`,
      extra: config.newSession.promptExtra.trim(),
      note: handoffNote.trim() === '' ? '(未填写)' : handoffNote.trim(),
      report: report.trim(),
      artifacts: artifactsBlock,
    })
  }

  private briefingArtifacts(agent: Agent, config: HandoffConfig): { title: string; body: string }[] {
    const artifacts: { title: string; body: string }[] = []
    for (const item of config.newSession.briefing) {
      switch (item) {
        case 'goal': {
          const goal = this.faces.goals?.get(agent)
          if (goal !== undefined) artifacts.push({ title: '目标', body: `${goal.objective}（${goal.phase}，已用 ${goal.roundsStarted} 轮）` })
          break
        }
        case 'todos': {
          const todos = this.todosOf(agent.session)
          const open = todos?.filter(todo => todo.status !== 'completed') ?? []
          if (open.length > 0) artifacts.push({ title: '未完成待办', body: open.map(todo => `- [${todo.status}] ${todo.content}`).join('\n') })
          break
        }
        case 'userRequest': {
          const state = this.stateOf(agent.session)
          if (state?.lastUserText !== undefined) artifacts.push({ title: '最近一条用户原话', body: state.lastUserText })
          break
        }
        case 'lastReview': {
          const reviews = this.ledger.reviewsOf(agent.session.id)
          const last = reviews[reviews.length - 1]
          if (last !== undefined) {
            artifacts.push({
              title: '最近一次复核',
              body: `${last.verdict}${last.gaps.length === 0 ? '' : `：${last.gaps.join('; ')}`}`,
            })
          }
          break
        }
        case 'stats': {
          const state = this.stateOf(agent.session)
          if (state !== undefined) {
            artifacts.push({
              title: '统计',
              body: `压缩 ${state.stats.compactions} 次、轮次 ${state.stats.turns}、工具失败 ${state.stats.toolFailures}`,
            })
          }
          break
        }
        default: break
      }
    }
    return artifacts
  }

  /**
   * Rebuild the active goal on the new session (proposal §4.6 step 6).
   *
   * Called before the briefing so a failure can still be written into it: the
   * new session gets one message, and a `keepGoal` that quietly dropped the
   * objective would leave it without the task it was created to continue.
   */
  private rebuildGoal(agent: Agent, newAgent: Agent, config: HandoffConfig): CarriedGoal | undefined {
    const goals = this.faces.goals
    if (goals === undefined) return undefined
    const goal = goals.get(agent)
    if (goal === undefined || goal.phase !== 'active') return undefined
    if (!config.newSession.keepGoal) return { goal, rebuilt: false }
    try {
      goals.create(newAgent, { objective: goal.objective, maxGoalRounds: goal.maxGoalRounds })
      return { goal, rebuilt: true }
    } catch (error) {
      // The briefing carries the objective; the model rebuilds it with the goal
      // tool. §十一 #3's fallback, not a silent success.
      this.faces.logger.warn(`oncall: the goal could not be rebuilt on ${newAgent.session.id}: ${String(error)}`)
      return { goal, rebuilt: false }
    }
  }

  /** Retire the old session's goal once the task has moved (proposal §4.6 step 7). */
  private retireGoal(agent: Agent, goal: GoalLike | undefined): void {
    if (goal === undefined) return
    try {
      this.faces.goals?.clear(agent, { id: goal.id, revision: goal.revision })
    } catch (error) {
      this.faces.logger.warn(`oncall: the old goal could not be cleared: ${String(error)}`)
    }
  }

  private facts(agent: Agent, config: HandoffConfig): FactsReceipt {
    if (!config.protocol.facts) {
      gateRefusal('facts is disabled by protocol.facts.', 'HANDOFF_ACTION_DISABLED')
    }
    const state = this.stateOf(agent.session)
    const counters = handoffCounters(state, reviewRosterIds(config))
    const goal = this.faces.goals?.get(agent)
    const todos = this.todosOf(agent.session)
    const open = todos?.filter(todo => todo.status !== 'completed') ?? []
    return {
      action: 'facts',
      // 没有投影 = 没数过，不是数出 0。闸门要的是 0（它只拒绝），回执要的是真话。
      compactions: state === undefined ? null : state.stats.compactions,
      turns: state === undefined ? null : state.stats.turns,
      toolFailures: state === undefined ? null : state.stats.toolFailures,
      goal: goal === undefined
        ? null
        : { objective: goal.objective, phase: goal.phase, roundsStarted: goal.roundsStarted },
      todos: todos === null
        ? null
        : {
            pending: todos.filter(todo => todo.status === 'pending').length,
            inProgress: todos.filter(todo => todo.status === 'in_progress').length,
            open: open.map(todo => todo.content),
          },
      delegations: state === undefined ? null : { total: counters.delegations, perRole: counters.perRole },
    }
  }

  /** The attach facts `delegate` collects, in the closed vocabulary the config names. */
  private attachFacts(agent: Agent, entry: RosterEntry, focusPaths: readonly string[]): { title: string; body: string }[] {
    const facts: { title: string; body: string }[] = []
    const state = this.stateOf(agent.session)
    for (const item of entry.attach) {
      switch (item) {
        case 'goal': {
          const goal = this.faces.goals?.get(agent)
          if (goal !== undefined) facts.push({ title: '目标', body: `${goal.objective}（${goal.phase}，已用 ${goal.roundsStarted} 轮）` })
          break
        }
        case 'todos': {
          const todos = this.todosOf(agent.session)
          const open = todos?.filter(todo => todo.status !== 'completed') ?? []
          if (open.length > 0) facts.push({ title: '未完成待办', body: open.map(todo => `- [${todo.status}] ${todo.content}`).join('\n') })
          break
        }
        case 'userRequest': {
          if (state?.lastUserText !== undefined) facts.push({ title: '最近一条用户原话', body: state.lastUserText })
          break
        }
        case 'stats': {
          if (state !== undefined) {
            facts.push({
              title: '统计',
              body: `压缩 ${state.stats.compactions} 次、轮次 ${state.stats.turns}、工具失败 ${state.stats.toolFailures}`,
            })
          }
          break
        }
        default: break
      }
    }
    if (focusPaths.length > 0) {
      facts.push({ title: '先看的文件', body: focusPaths.map(path => `- ${path}`).join('\n') })
    }
    return facts
  }

  /** The gate's inputs, resolved once per call. */
  private gateFor(agent: Agent, config: HandoffConfig): GateInput {
    const state = this.stateOf(agent.session)
    const goal = this.faces.goals?.get(agent)
    return {
      config,
      counters: handoffCounters(state, reviewRosterIds(config)),
      carried: this.ledger.carriedOf(agent.session.id),
      reviews: this.ledger.reviewsOf(agent.session.id),
      goalActive: goal !== undefined && goal.phase === 'active',
    }
  }

  private stateOf(session: Session): HandoffProjectionState | undefined {
    const projections = this.faces.projections
    if (projections === undefined) return undefined
    return projections.stateOf(session, HANDOFF_KEY) as HandoffProjectionState | undefined
  }

  private todosOf(session: Session): TodoLike[] | null {
    const projections = this.faces.projections
    if (projections === undefined) return null
    const todos = projections.snapshot(session, ['todos']).values.todos
    return Array.isArray(todos) ? todos as TodoLike[] : null
  }

  /**
   * The route one delegation runs on: the role's own pin → the section's global
   * default → nothing, which lets DSH inherit the parent's latest request route.
   *
   * The route is chosen whole, never merged field by field: a half-configured
   * pair is refused by the structural rules, so "provider from the role, model
   * from the defaults" is a state the operator cannot reach and this function
   * does not have to model.
   */
  private agentOptionsOf(entry: RosterEntry): AgentOptions | undefined {
    const defaults = this.config().delegateDefaults
    const pinned: RosterEntry | typeof defaults | undefined =
      entry.provider.trim() !== '' && entry.model.trim() !== ''
        ? entry
        : defaults.provider.trim() !== '' && defaults.model.trim() !== ''
          ? defaults
          : undefined
    if (pinned === undefined) return undefined
    const options: AgentOptions = {
      provider: pinned.provider.trim(),
      model: pinned.model.trim(),
    }
    if (pinned.reasoningEffort.trim() !== '') options.reasoningEffort = pinned.reasoningEffort.trim() as never
    if (pinned.maxTokens > 0) options.maxTokens = pinned.maxTokens
    return options
  }

  /** The counters a caller may want to render without opening the projection. */
  countersOf(session: Session, config: HandoffConfig): HandoffCounters {
    return handoffCounters(this.stateOf(session), reviewRosterIds(config))
  }

  /**
   * What the turn-stopping seam may read.
   *
   * `undefined` means "this session has no projection yet" — the caller must
   * stay silent rather than read that as "zero open todos". Unknown is not 0.
   */
  receiptState(agent: Agent, turn: number): {
    calledThisTurn: boolean
    pendingTodos: number
    goalActive: boolean
  } | undefined {
    const state = this.stateOf(agent.session)
    if (state === undefined) return undefined
    const todos = this.todosOf(agent.session)
    if (todos === null) return undefined
    const calledThisTurn = state.records.some(record =>
      record.turn === turn && (record.kind === 'delegate' || record.kind === 'finish' || record.kind === 'newSession'))
    return {
      calledThisTurn,
      pendingTodos: todos.filter(todo => todo.status !== 'completed').length,
      goalActive: this.faces.goals?.get(agent)?.phase === 'active',
    }
  }

  /**
   * The configured fallback: delegate the open work to a named role when the
   * model stopped without a receipt. It is the same `delegate` path, so every
   * budget still applies — a fallback that bypassed the gates would be a second
   * door into the same spend.
   */
  delegateOnStop(agent: Agent, rosterId: string, pendingTodos: number, signal: AbortSignal): Promise<unknown> {
    return this.delegate(
      agent,
      this.config(),
      {
        action: 'delegate',
        rosterId,
        task: `本回合没有收工回执，还有 ${pendingTodos} 项待办未完成。请按你的职责收尾：`
          + '核对已完成的部分，列出还缺什么，并把结论写成结构化结果。',
      },
      signal,
    )
  }
}

/** A structured reviewer answer, or a fail-closed `gaps` when it is not one. */
export function verdictOf(structured: unknown): ReviewVerdict {
  if (typeof structured === 'object' && structured !== null) {
    const value = structured as { verdict?: unknown; gaps?: unknown; recommend?: unknown }
    if (value.verdict === 'pass' || value.verdict === 'gaps') {
      const gaps = Array.isArray(value.gaps)
        ? value.gaps.filter((gap): gap is string => typeof gap === 'string')
        : []
      const recommend = value.recommend === 'continue' || value.recommend === 'newSession' || value.recommend === 'done'
        ? value.recommend
        : undefined
      return { verdict: value.verdict, gaps, ...recommend === undefined ? {} : { recommend } }
    }
  }
  // Silence is not a pass: a reviewer that returned nothing has verified nothing.
  return { verdict: 'gaps', gaps: ['复核者没有返回结构化结论（verdict: pass|gaps）'] }
}
