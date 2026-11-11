/**
 * dsh-oncall — transparent cross-provider failover for Agent main requests.
 *
 * The plugin owns exactly two seams, both verified against the real Loader
 * composition in the Phase 1 spike (docs/design/dsh-capability-boundary.md 7):
 *
 * - `agent/request` with `prepend: true`, so this listener runs OUTSIDE
 *   `installModelSelection` and its post-`next()` override wins. Every attempt
 *   passes through here, which is what makes the per-candidate retry budget
 *   enforceable while `llm-retry` owns same-route retries.
 * - `agent/request-error` with `prepend: true` on the root ctx (registered once;
 *   the agent comes from the payload), so it is the OUTERMOST listener: it sees
 *   `llm-retry`'s decision after `await next()` and then honors it or decides
 *   the failover itself. Since 2026-10-17 it also decides "this candidate's
 *   budget is spent && this error should switch" BEFORE `await next()`, so
 *   llm-retry's backoff and its two `llm/retry` durable records never happen for
 *   that case. Since 2026-10-20 there is no request-wide cap: the chain's own
 *   candidates and each candidate's budget bound the step.
 *
 * Nothing here re-implements backoff, adapter dispatch, credentials, or the
 * durable attempt record. What the plugin adds is the candidate cursor, the
 * capability pre-check, and the Chinese reason notice.
 *
 * The class form carries the plugin's own Remote: `TypertRemoteService` makes
 * this one class the Cordis Service, the plugin, and the Remote owner at once,
 * which is what lets the browser ask the Host to run a probe
 * (docs/design/build-pipeline-and-plugin-remote.md). The `./typert` artifact
 * the generator emits from this class is the registration channel.
 *
 * Note: 类形态转换与 Remote 探针的取舍 —— 见
 * .agents/notes/implemented/2026-10-15-plugin-remote-probe.md
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A message this plugin queued into a worker session.
     *
     * A `user`-role message the model treats as a task, attributed to this plugin so
     * the console can tell "a person spoke" from "the ingress relayed a comment".
     * Distinct from `oncall` (this plugin's own notices) on purpose: a notice is
     * addressed to the person reading the session, this one is addressed to the worker.
     */
    'oncall-worker': { readonly kind: 'oncall-worker'; readonly form: 'relay' }
  }
}

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  Config,
  assertStructural,
  type ChainConfig,
  type HandoffConfig,
  type HealthConfig,
  type NamedChain,
  type RouterOptions,
} from './config.ts'
import { decideAfterInner, decideBeforeInner, hasImageContent, isSwitchOnEligible, jumpTo, planFire, resolveChain, resolveStartIndex, skipTo, startStep, switchesImmediately, toolResultHasImage, unmetCondition } from './router.ts'
import type { AfterInnerRuling, BeforeInnerRuling } from './router.ts'
import { configuredRouteList, routeKeyOf, routeParts } from './routes.ts'
import { DEFAULT_PROBE_PROMPT, DEFAULT_PROBE_TIMEOUT_SECONDS } from './defaults.ts'
import { RouterState, candidateConfig, type StepCandidate, type StepChain, type StepConditions, type TurnCarry } from './state.ts'
import { bindingMissingNotice, conditionSkipNotice, failoverNotice, breakerNotice, skipNotice, routeMissingNotice, adapterDefectNotice, truncationContinueNotice, truncationSwitchNotice, handoffNudgeNotice, handoffUnreceiptedNotice } from './notice.ts'
import { precheckTierOf, type PrecheckTier } from './precheck.ts'
import { planSkipNotices } from './skip-plan.ts'
import { failoverHistoryProjection, failureCodeOfStream, finishKindOfStream } from './lineage.ts'
import { channelHealthProjection } from './health.ts'
import { handoffProjection } from './handoff.ts'
import { HandoffLedger } from './handoff.ts'
import { HandoffRuntime, type AgentRegistryFace, type HandoffFaces, type SessionControllerFace, type GoalLike, type TodoLike } from './handoff-tool.ts'
import { CircuitBreaker, type RouteBlock } from './breaker.ts'
import { waitBeforeRetry } from './backoff.ts'
import { SessionBindings } from './bindings.ts'
import { checkConnectivity, type ConnectivityLlm, type ConnectivitySettings } from './connectivity.ts'
import { probePromptFor, probeRoute } from './probe.ts'
import { chainForSession, chainLabel, effectiveChains, type ChainSource } from './chain.ts'
import { checkForUpdate } from './update.ts'
import { RELEASE_VERSION } from './release.generated.ts'
import { DEFAULT_INGRESS_POLL_SECONDS, INGRESS_POLICY_VERSION, INGRESS_TOKEN_ENV } from './contract/defaults.ts'
import type { Policy } from './contract/policy.ts'
import { DurableLedger } from './runtime/durable-ledger.ts'
import { Executor, type TurnEnd, type TurnFact, type TurnHost } from './runtime/executor.ts'
import { Outbox } from './runtime/outbox.ts'
import { registerReportTool } from './faces/reports.ts'
import { githubReplySender } from './sources/github-reply.ts'
import { startIngressLoop, type IngressLoopHandle } from './faces/ingress.ts'
import { envOf } from './faces/env.ts'
import { githubIssueSource, githubIssueSourceId, parseRepository } from './sources/github-issue.ts'
import { githubHttpFace } from './sources/github-http.ts'
import type {
  ConnectivityRequest,
  ConnectivityVerdict,
  HandoffCarriedView,
  ProbeReport,
  ProbeRequest,
  ProbeRoute,
  SessionBindingRequest,
  SessionBindingView,
  UpdateCheck,
} from './types.ts'

/**
 * No `declare module '@deepseek-ai/cordis'` augmentation here on purpose. The
 * gateway binding is syntactic — the generator reads the `extends
 * TypertRemoteService` heritage and the `super(ctx, serviceKey)` call
 * (packages/typert/generator/src/analyzer.ts:1274-1296) — but a Context member
 * typed as this class feeds the service model, whose walk reaches
 * `Context.typert` → `TypertRegistryContract` → `TypertLookupRegistry` →
 * `TypertLookupMap`, a merge-extensible interface that DSH packages augment
 * from node_modules. Out-of-tree those augmentations sit in no registration, so
 * the face analysis refuses the merge. Consumers reach this service through the
 * generated `./remote` artifact, not through a Context key.
 */

/**
 * Every physical route the config names, across every chain, deduplicated: the
 * target set both the probe and the connectivity check run over. The rule lives
 * in ./routes.ts because the browser half lists the same set for its checks —
 * one definition, both halves.
 */
function configuredRunRoutes(config: { chains: readonly NamedChain[] }): ProbeRoute[] {
  return configuredRouteList(config).map((key) => routeParts(key))
}

/** The slice of the session controller the executor drives. Structural: the real service is wider. */
interface SessionControllerService {
  resolveAgent(sessionId: SessionId): Promise<{ agent?: Agent; error?: { code?: string } }>
  create(request: { sessionId: SessionId; cwd?: string }): Promise<unknown>
  rename(request: { sessionId: SessionId; title: string }): Promise<unknown>
}

/** The live-agent registry: the only way from a session id to the agent driving it. */
interface AgentRegistryService {
  get(sessionId: SessionId): Agent | undefined
}

/** What the executor needs from session persistence: one durable checkpoint. */
interface SessionPersistenceService {
  flush(): Promise<void>
}

/**
 * DSH's turn-end vocabulary projected onto the executor's.
 *
 * An unknown reason settles nothing (`interrupted`): the reason map is
 * merge-extensible, and a reason this build does not understand is not evidence
 * that the work finished.
 */
function turnEndOf(reason: TurnEndReason): TurnEnd {
  switch (reason.kind) {
    case 'completed':
      return { kind: 'completed' }
    case 'max-tokens':
      return { kind: 'max-tokens' }
    case 'interrupted':
      return { kind: 'interrupted' }
    case 'forked':
      return { kind: 'forked' }
    case 'blocked':
      return { kind: 'blocked' }
    case 'aborted':
      return { kind: 'aborted', reason: String(reason.reason?.kind ?? 'aborted') }
    case 'error':
      return {
        kind: 'error',
        code: reason.error.code,
        message: reason.error.message,
        retryAfterMs: reason.error.providerRetryAfterMs,
      }
    default:
      return { kind: 'interrupted' }
  }
}

/** The visible text of one assistant message, without reasoning or tool blocks. */
function textOfMessage(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * The process's working directory.
 *
 * Read off `globalThis` rather than `process` so the plugin type-checks under the
 * documented `npx tsc …` (no `@types/node`), the same reason `crypto.randomUUID` is
 * reached through `globalThis` in `runtime/durable-ledger.ts`. The host is Node; a
 * composition without it has no worker sessions either.
 */
function hostCwd(): string {
  const host = globalThis as unknown as { process?: { cwd?: () => string } }
  return host.process?.cwd?.() ?? '.'
}

export default class OnCallDesk extends TypertRemoteService {
  static inject = ['llm']
  static Config = Config

  // Assigned in the constructor rather than declared as a parameter property:
  // the headless composition loads this file from source through Node's
  // strip-only type removal, which rejects parameter properties outright.
  private readonly config: Config
  /**
   * The plugin's own RAW config, captured once at construction.
   *
   * Not 	his.ctx.fiber._config on demand: Cordis rebinds a service method's
   * 	his.ctx to the CALLER's fiber (the "topology-sensitive property proxy"),
   * so reading it inside setSessionBinding returns the *caller's* raw config —
   * measured: the binding fixture's { chain, retries, observe } instead of this
   * plugin's { chains, ... }. The constructor is the one place where ctx is
   * this fiber's.
   */
  private readonly raw: unknown
  private readonly states = new RouterState()
  private readonly breaker = new CircuitBreaker()
  /**
   * Per-session bindings (which chain, which per-route retry overrides). Its
   * storage domain opens asynchronously; reads fall back to memory until then,
   * and writes await the open so a durable store is never skipped by a race.
   */
  private readonly bindings: SessionBindings
  /**
   * The handoff ledger of the mounted fiber, for the browser's budget read.
   *
   * Assigned by `installHandoff` (the ledger is created inside the child fiber
   * that owns the tool) and cleared with it. No ledger means handoff is off or
   * this composition has no tools/subagents, which the read answers as "nothing
   * was carried" rather than as an error.
   */
  private handoffLedger: HandoffLedger | undefined
  /** Live agents by session, so the session/event feed can reach their state. */
  private readonly agentsBySession = new WeakMap<Session, Agent>()
  /** The last scheduled probe's report, held for the browser's read. */
  private lastProbeReport: ProbeReport = { at: 0, routes: [] }
  /** Probes currently running (scheduled or manual); a scheduled tick skips while any is in flight. */
  private probeInFlight = 0
  private probeTimerId: ReturnType<typeof setInterval> | undefined
  /**
   * Nudges already sent in one agent's current turn.
   *
   * Process memory on purpose: a nudge is a runtime action, not a durable fact,
   * and `maxNudgesPerTurn` bounds it inside one turn. A restart mid-turn can
   * therefore ask once more — the alternative (a durable nudge ledger) would be
   * a second source for something the proposal only ever counts per turn.
   *
   * Keyed by the Agent and reset when the turn changes, so it cannot grow: the
   * previous `sessionId:turn` string map kept one entry per turn forever.
   */
  private readonly nudges = new WeakMap<Agent, { turn: number; used: number }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'oncall', { namespace: 'oncallHealth' })
    this.config = config
    this.raw = rawConfigOf(ctx)
    this.bindings = new SessionBindings(ctx)
    this.install()
    this.installIngress()
    this.warnLegacyRow()
    this.armProbeTimer()
  }

  // ---- routing seams (the apply body, unchanged) ----

  private install(): void {
    const ctx = this.ctx
    const config = this.config
    const states = this.states
    const breaker = this.breaker
    const bindings = this.bindings
    const agentsBySession = this.agentsBySession

    // Structural validation at load: wrong in every environment, so it fails loud.
    const initial = readConfig(config, this.raw)
    if (initial.migratedFrom !== 'chains' && initial.migratedFrom !== 'chain' && initial.migratedFrom !== 'empty') {
      ctx.logger.warn(
        `oncall: the config still uses the old ${initial.migratedFrom === 'default' ? 'default pool' : 'per-model profiles'} shape; `
        + 'it was read as one named chain. Re-save from the dialog to store the new shape.'
        + (initial.ignoredProfiles > 0 ? ` ${initial.ignoredProfiles} extra profile(s) could not be represented and were ignored.` : ''),
      )
    }
    assertStructural(initial)
    // Provider audit: same rule at load and at save, so a bad save is rejected by the
    // waterfall instead of killing the running plugin (see the internal/config listener).
    assertNoAlwaysPolicy(ctx, initial)
    // Hot updates are validated before Cordis restarts this fiber, so a bad edit
    // is rejected at save time instead of killing the running plugin.
    ctx.on('internal/config', function (this: Fiber, _raw, next) {
      const raw: unknown = next()
      if (this !== ctx.fiber) return raw
      const candidate = Config(raw as RouterOptions)
      const effective = readConfig(candidate, raw)
      assertStructural(effective)
      assertNoAlwaysPolicy(ctx, effective)
      return raw
    })

    // Environmental drift (a provider uninstalled after configuration) degrades
    // at runtime: the candidate is skipped and the request falls through to the
    // user's own route. This warning is best-effort only — providers registered
    // after this plugin loads are not visible here.
    warnUnregisteredProviders(ctx, initial)
    warnStaleProbePrompts(ctx, initial)

    // The durable failover ledger and the channel-health fold, both registered
    // through `ctx.get` (the optional-service rule): a composition without the
    // registry still routes — only the two views degrade.
    // One face, two uses: registering this plugin's own units, and reading another
    // package's wire view for the token gate. Both are structurally typed because
    // the registry is optional (packages/AGENTS.md: the ctx.get rule).
    const projections = ctx.get('sessionProjections') as (ProjectionRegistryFace & ProjectionReadFace) | undefined
    projections?.register(failoverHistoryProjection)
    projections?.register(channelHealthProjection)
    // Registered whether or not handoff is enabled: the fold is what makes the
    // budget counters replayable, and a session that delegated before the last
    // config save must not look like it never did. Registering costs one pass
    // over the log the registry already reads.
    projections?.register(handoffProjection)
    this.installHandoff(projections)

    // The router's own failure ledger. `agent/request-error` records synchronously
    // for the failure it is handed, but a delegated failure reaches the next
    // attempt through the durable log first, so the committed `assistant/attempt`
    // is what `mayAdvance` reads when it decides whether the chain may advance.
    // This listener exists for the router's state alone — channel health is folded
    // by the `oncall/channel-health` projection, which the registry drives itself.
    // 失败码记录只有一个写入方（本 listener）：恢复监听曾经自己也写一份，实测
    // durable log 路径足够——删掉 handler 侧写入后，钉「notice 带失败码」的
    // failover-rate-limit 场景仍绿（21 场景全绿），双写已删。
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      // read_image's image enters the conversation as a tool result, so the turn
      // becomes image-bearing from the next step on — without this the walk would
      // send the very next request (the one that actually contains the image) to
      // a candidate the user gated on `images: false`.
      if (event.type === 'tool/result') {
        const agent = agentsBySession.get(session)
        if (agent !== undefined) states.noteToolResult(agent, event.data.turn, toolResultHasImage(event.data))
      }
      if (event.type === 'assistant/message') {
        // 输出被截断不是错误、不经过 `agent/request-error`（`agent-loop/src/agent.ts:547`
        // 直接结束本轮），所以"这一轮是不是截断结束"只能从这里读。`turn-stopping`
        // 在 `turn/end` 之前派发，届时还没有 turn/end 可读。
        const agent = agentsBySession.get(session)
        if (agent !== undefined) {
          const source = event.data.message.source
          states.noteTruncation(agent, {
            turn: event.data.turn,
            step: event.data.step,
            provider: source.provider,
            model: source.model,
            truncated: finishKindOfStream(event.data.stream) === 'max-tokens',
          })
        }
        return
      }
      if (event.type !== 'assistant/attempt') return
      const failure = failureCodeOfStream(event.data.stream)
      if (failure !== undefined) states.noteFailure(session, event.data.turn, event.data.step, failure)
    })

    ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
      // 工具结果里的图片经 session/event 进来，而该事件只有 session 没有 agent；
      // 这张表把两者接上，条目随 agent 消亡。
      agentsBySession.set(agent.session, agent)
    })

    // The per-agent seams live on THIS fiber's ctx and take `agent` from the payload.
    //
    // They used to be registered on `agent.ctx` inside `agent/created`, which made the
    // AGENT their owner: after a plugin reload (any config save restarts this fiber)
    // the old listeners stayed attached to live agents, still holding the disposed
    // instance's storage handle. Measured in the desktop app: five consecutive turns
    // failed with `domain 'oncall_sessions' is closed` because the leftover
    // `agent/request` listener read a domain its own fiber had already closed.
    // Registering here makes the fiber the single owner — unload removes them, reload
    // replaces them, and live sessions keep working across a config save.
    //
    // Conditions are gathered once per step, before route selection: pre-step sees the
    // admitted user messages (the images gate) and the context-pressure projection
    // answers for the next request (the token gate). The image flag accumulates across
    // the turn's steps and is extended by the sticky window, so it stays stable across
    // a step's retries without pretending later steps claimed the same input. This
    // listener only observes.
    ctx.on('agent/pre-step', async (payload, next) => {
      const { agent } = payload
      const decision = await next()
      states.noteConditions(agent, payload.turn, payload.step, gatherConditions(projections, agent.session, payload.messages))
      return decision
    })

    // Note: 为什么仍靠 agent/request 覆盖 route、以及上游何时收回这个权力 —— 见
    // .agents/notes/proposed/2026-10-26-agent-request-is-no-longer-the-route-authority.md
    // Outermost on agent/request: the override applied after next() wins over
    // installModelSelection's write-back of the user's selection.
    ctx.on(
      'agent/request',
      async (payload, next) => {
        const { agent, turn, step, signal } = payload
        const resolved = await next()
        if (!config.enabled.get()) return resolved

        let state = states.current(agent, turn, step)
        /** 本步是否由"截断续满"落到另一条候选；通知在落点确定后发。 */
        let carried: TurnCarry | undefined
        if (state === undefined) {
          // 本会话绑定的是哪条链、每条路由重试几次。读取是同步的（storage 域的内存
          // 权威），因此这个请求看到的一定是"上一次写入已落盘"的状态；绑定在 step
          // 首次请求时冻结，进行中的 step 不换链也不换次数。
          const effective = readConfig(config, this.raw)
          const bound = bindings.read(agent.session.id)
          const sessionChain = chainForSession(effective, bound?.chain ?? null)
          const missingBinding = sessionChain.missing
          if (missingBinding !== undefined
            && !states.turnNoticeKeys(agent, turn).has(`binding:${missingBinding}`)) {
            // 绑定的链被删了：按默认链路由，但必须说出来。会话保留原来的绑定 id，
            // 用户重建同名链就能恢复——静默改成"没绑定"会把一次删除变成一次改道。
            agent.session.append(
              'user/message',
              bindingMissingNotice(missingBinding, chainLabel(sessionChain.chain)),
              { surfaceOp: 'append' },
            )
            states.recordTurnNoticeKeys(agent, turn, [`binding:${missingBinding}`])
          }
          const chain = resolveChain(resolved, sessionChain.chain, bound?.retries ?? {})
          if (chain === undefined) return resolved
          states.setStickyTurns(agent, chain.stickyTurns)
          // 策略只决定第一跳失败后从哪条降级候选开始；第一跳恒在链首，不参与抽签。
          // 起点之后的前进逻辑与策略无关。
          const fallbacks = chain.candidates.slice(1)
          const start = resolveStartIndex(fallbacks, chain.strategy, states.nextCursor(agent.session, fallbacks.length))
          state = startStep(turn, step, chain, states.conditionsFor(agent, turn, step), start)
          // 上一轮输出被截断、自动续跑次数用尽：这一步一开头就落到下一条候选。
          // 落点按路由记（不是下标），因为新 step 的链按起点策略重新旋转过。
          // 通知不在这里发：这条候选还可能被条件/熔断/预检跳过，真正落在哪儿要等
          // 下面走完——通知说"已切换至 X"就必须真的发到 X（项目的老毛病是文案先于事实）。
          const carry = states.takeCarry(agent, turn)
          if (carry !== undefined) {
            const target = chain.candidates.findIndex(candidate =>
              candidate.provider === carry.provider && candidate.model === carry.model)
            if (target > 0) {
              carried = carry
              state = jumpTo(state, target)
            }
          }
          states.start(agent, state)
        }

        const advanceAllowed = mayAdvance(states, agent, turn, step, state.chain)
        const plan = planFire(state, advanceAllowed)
        // `mayAdvance` 是兜底路径：它能推进链，却没有恢复裁决，因此没有熔断记录。
        // 对恢复监听看见过的失败，这条路不该走（裁决会置 `pendingAdvance`）；
        // 真走到这里就把话说出来，而不是悄悄换掉一条候选。
        if (plan.advanced && state.pendingAdvance === undefined && advanceAllowed) {
          const from = state.chain.candidates[state.index]!
          ctx.logger.warn(
            `oncall: advanced off ${routeKeyOf(from.provider, from.model)} by the fallback cap check `
            + `(attempt ${state.attemptsOnCandidate}/${from.maxAttempts}); the recovery listener saw no ruling for this fire`,
          )
        }
        const candidates = plan.state.chain.candidates

        // Walk forward from the planned index, skipping candidates this exact
        // request cannot be served by: an unmet `needs` condition first, then a
        // capability rejection. Conditions apply to EVERY candidate — the first
        // hop included, through the chain's `primaryNeeds` (its only way to carry
        // one: a candidate naming the selected route is dropped by `resolveChain`).
        // An explicit condition is the user's stated intent, and skipping a
        // candidate that fails it honors the configuration instead of silently
        // ignoring it. What the user's own route stays exempt from is the
        // automatic machinery: breaker cooldowns and capability pre-validation,
        // which DSH already settled when the selection was made.
        let index = plan.state.index
        const skipped: { candidate: StepCandidate; tier: PrecheckTier | undefined; code: string | undefined }[] = []
        const conditionSkipped: { candidate: StepCandidate; reason: string }[] = []
        const blocked: { candidate: StepCandidate; block: RouteBlock }[] = []
        let outgoing: LlmCallConfig | undefined
        const now = Date.now()
        breaker.sweep(now)
        while (index < candidates.length) {
          const candidate = candidates[index]!
          const unmet = unmetCondition(candidate, plan.state.conditions)
          if (unmet !== undefined) {
            conditionSkipped.push({ candidate, reason: unmet })
            index += 1
            continue
          }
          // 禁用的渠道直接跳过——但用户自己选的那一条永远不跳过：那是他明确
          // 要用的，禁用名单不该能覆盖人的显式选择。
          if (candidate.provider === resolved.provider && candidate.model === resolved.model) {
            outgoing = candidateConfig(resolved, candidate)
            break
          }
          const block = breaker.blockedUntil(candidate.provider, candidate.model, now)
          if (block !== undefined) {
            blocked.push({ candidate, block })
            index += 1
            continue
          }
          try {
            outgoing = await ctx.llm.resolveCallConfig(candidateConfig(resolved, candidate), signal)
            break
          } catch (error) {
            // 预检的抛出按「用户该去哪儿修」分三档（./precheck.ts）：请求形状 /
            // 路由不存在 / 适配器违约。压成一句"不支持当前请求参数"会把一个配错
            // 的 provider 说成链的问题——而这条 notice 是 durable 的，错了就
            // 一直在历史里。分不出档的码保留原通用文案：插件不知道谁能修它，
            // 编一档就是换一种说法的谎。
            const code = (error as { code?: unknown }).code
            const tier = typeof code === 'string' ? precheckTierOf(code) : undefined
            if (tier === 'adapter-defect') {
              ctx.logger.error(
                `oncall: candidate ${routeKeyOf(candidate.provider, candidate.model)} adapter broke its contract (${String(code)}): ${String(error)}`,
              )
            } else {
              ctx.logger.warn(
                `oncall: candidate ${routeKeyOf(candidate.provider, candidate.model)} cannot serve this request, skipping: ${String(error)}`,
              )
            }
            skipped.push({ candidate, tier, code: typeof code === 'string' ? code : undefined })
            index += 1
          }
        }
        // 跳过通知在"落回用户原路由"之前发：那条路径上没有任何切换 Notice，
        // 而"为什么链上没人能接这一击"恰恰是用户最需要看到的。
        //
        // 报哪几条是 ./skip-plan.ts 的裁决（纯函数：三类跳过、落回不报第一跳、
        // 同一轮内逐路由只报一次），这里只当解释器：按计划 append。分开的原因
        // 是"这一轮里跳过集合变大"这个触发面在组合 harness 里到不了（一次 boot
        // 只有一个 step），而它是错发重复 durable 消息的唯一形态。
        const skipPlan = planSkipNotices({
          conditionSkipped,
          capabilitySkipped: skipped,
          blocked,
          fellBackToOwnRoute: outgoing === undefined,
          resolved,
          alreadyNoted: states.turnNoticeKeys(agent, turn),
        })
        for (const notice of skipPlan.notices) {
          // 档二/档三各有自己的文案与指向（./precheck.ts 的三档）；同一档内
          // 每轮每路由只发一次，去重键与档一共用——那是同一次"调用前跳过"事件。
          const built = notice.kind === 'condition'
            ? conditionSkipNotice(notice.candidate, notice.reason)
            : notice.kind === 'breaker'
              ? breakerNotice(notice.candidate, notice.block)
              : notice.tier === 'route-missing' && notice.code !== undefined
                ? routeMissingNotice(notice.candidate, notice.code)
                : notice.tier === 'adapter-defect' && notice.code !== undefined
                  ? adapterDefectNotice(notice.candidate, notice.code)
                  : skipNotice(notice.candidate)
          agent.session.append('user/message', built, { surfaceOp: 'append' })
        }
        states.recordTurnNoticeKeys(agent, turn, skipPlan.keys)
        if (outgoing === undefined) {
          // Nothing in the chain can serve this request. Fall through to the
          // user's own route so the real failure surfaces there instead of a
          // silent swap. The chain is spent for this step: record it, or every
          // retry re-walks the same dead chain, the recovery listener keeps
          // answering "continue", and the step never ends.
          // Note: 这个 exhausted 修复的来龙去脉 —— 见
          // .agents/notes/implemented/2026-10-14-image-route-conditions-and-admission-gate-boundary.md
          states.start(agent, { ...plan.state, exhausted: true })
          return resolved
        }
        states.start(agent, skipped.length === 0 && conditionSkipped.length === 0 && index === plan.state.index ? plan.state : skipTo(plan.state, index))

        // 截断续满后的换候选：现在才知道真正落在哪条候选上。落在被截断的那条上
        // （链上其他都不可用，走的是"落回原路由"路径）就不发切换通知——那会是一句假话。
        if (carried !== undefined) {
          const landing = candidates[index]!
          if (routeKeyOf(landing.provider, landing.model) !== routeKeyOf(carried.fromProvider, carried.fromModel)) {
            const order = plan.state.chain.order
            agent.session.append(
              'user/message',
              truncationSwitchNotice(
                { provider: carried.fromProvider, model: carried.fromModel },
                landing,
                order[index] ?? index,
                Math.max(0, order.length - 1),
                carried.continues,
              ),
              { surfaceOp: 'append' },
            )
          }
        }

        if (plan.advanced) {
          const order = plan.state.chain.order
          agent.session.append(
            'user/message',
            failoverNotice(
              candidates[plan.fromIndex]!,
              candidates[index]!,
              // 用户自己排的降级编号（order[0] 是第一跳，1..N 是降级），不是策略
              // 旋转后的位置；总数是降级候选数，不含第一跳。
              order[index] ?? index,
              Math.max(0, order.length - 1),
              states.failureCodeOf(agent.session, turn, step),
            ),
            { surfaceOp: 'append' },
          )
        }
        return outgoing
      },
      { prepend: true },
    )

    // 最外层 on agent/request-error（`prepend: true`，注册在 root ctx 一次，agent 从
    // payload 取——按 agent/created 逐个注册会让每个 agent 漏一条 root listener）。
    // 位置是"每条候选重试几次"能否成立的关键：注册在 llm-retry 内层时，它自己的同路由
    // 重试发生在插件看不到的地方，用户填的候选次数会被越过（实测：配 2 打 7 次）。
    // 所以这里先 `await next()` 让内层（llm-retry / compaction）各自决定，再处置：
    //   内层决定重试 → 原样放行（额度耗尽的那条根本轮不到内层，已在下面提前接管）；
    //   内层全部放弃（undefined）→ 才轮到插件做跨候选 failover。
    // 两条分支的裁决与副作用声明都在 router.ts 的两个纯函数里（decideBeforeInner /
    // decideAfterInner，含"记不记熔断"的规则与日志文案）；本 handler 是解释器：调
    // 决策、按声明应用副作用、返回决策。语义依据：open-questions 第五节第 2 项；
    // 五分支收编的来龙去脉（待办 4 是症状不是独立问题）见
    // .agents/notes/implemented/2026-10-17-policy-into-the-decision-core.md。
    ctx.on('agent/request-error', async (payload, next) => {
      const { agent, turn, step, failure, signal } = payload
      // 总闸关着就完全不参与：`agent/request` 已经不接管这一击，恢复侧若还按冻结
      // 的链换候选，就会出现"关了开关还在换模型"。本步剩下的失败交回 DSH 自己的策略。
      // Note: 两个缝读同一个总闸 —— 见 .agents/notes/implemented/2026-10-23-honest-surfaces.md
      if (!config.enabled.get()) return next()
      const state = states.current(agent, turn, step)
      // 不是本插件接管的 step：纯透传，不改变任何既有恢复行为。
      if (state === undefined) return next()
      const current = state.chain.candidates[state.index]!

      // 总闸关着就不记：`enabled` 是用户的显式选择。规则留着（再开时不用重填），
      // 但关着的时候一条都不能生效——此前只读 rules 不读 enabled，开关是个摆设。
      const noteBreaker = (): void => {
        const breakerConfig = (config.health?.get() as HealthConfig | undefined)?.breaker
        if (breakerConfig?.enabled === true) {
          breaker.note(current.provider, current.model, failure.code, failure.message ?? '', breakerConfig.rules, Date.now())
        }
      }
      // 记不记、记什么，由裁决声明（规则见 router.ts 的 docstring：把当前候选拿出
      // 轮换的失败才记，失败尚未定论的不记）；这里只执行。A failure the user said
      // should disqualify the channel takes it out of rotation; the block always
      // expires, so this is a cooldown, not a ban.
      const apply = (ruling: BeforeInnerRuling | AfterInnerRuling): void => {
        if (ruling.record) noteBreaker()
        if (ruling.log !== '') ctx.logger.warn(ruling.log)
      }

      // The provider's resolved policy rides in on the payload; it supplies the
      // backoff shape and the default when the candidate declares no count.
      const before = decideBeforeInner(state, failure.code, signal.aborted, {
        policy: payload.retryPolicy,
        retryAfterMs: failure.providerRetryAfterMs,
      })
      if (before.kind === 'retry-self') {
        apply(before)
        // Same route, so the next fire must NOT advance. The wait is the
        // plugin's own since it owns the retry; the signal fuses caller
        // cancellation into it.
        state.pendingAdvance = false
        const waited = await waitBeforeRetry(before.delayMs, signal)
        // A cancelled wait is not a channel fact: let the loop's own abort win.
        return waited ? { kind: 'retry' as const } : undefined
      }
      if (before.kind !== 'delegate') {
        apply(before)
        if (before.kind === 'advance') {
          state.pendingAdvance = true
        }
        return before.kind === 'advance' ? { kind: 'retry' as const } : undefined
      }

      const inner = await next()
      const after = decideAfterInner(state, failure.code, signal.aborted, inner?.kind === 'retry' ? 'retry' : undefined, {
        policy: payload.retryPolicy,
        retryAfterMs: failure.providerRetryAfterMs,
        // 内层到底有没有为这个码做过重试：没有策略 = 它直接放行；always = 它全重试；
        // normal = 看可重试集。只有"它根本没管"时，路由器才补自己的重试。
        retryable: payload.retryPolicy === undefined
          ? false
          : payload.retryPolicy.mode === 'always'
            || payload.retryPolicy.retryableCodes.includes(failure.code),
      })
      apply(after)
      // honor：原样放行——llm-retry 还在重试同一条路由，失败尚未定论。
      if (after.kind === 'honor') {
        state.pendingAdvance = false
        return inner
      }
      if (after.kind === 'retry-self') {
        state.pendingAdvance = false
        const waited = await waitBeforeRetry(after.delayMs, signal)
        return waited ? { kind: 'retry' as const } : undefined
      }
      if (after.kind === 'advance') {
        state.pendingAdvance = true
        return { kind: 'retry' as const }
      }
      return undefined
    }, { prepend: true })

    // 输出被截断（`max-tokens`）不经过恢复扩展点：DSH 在 `agent-loop/src/agent.ts:547`
    // 直接把本轮结束掉，界面那条"发送继续"就是在等用户手动补一句。插件的目的是
    // "别停在这儿"，所以这里接管：先在同一候选上自动续（次数可配），续满了就换
    // 下一条候选接着写——换候选走 `carryTo`，由下一次 `agent/request` 落位。
    //
    // `agent/turn-stopping` 是 DSH 官方给的续跑口子（`agent.ts:361-365`，官方的
    // `/loop` pattern 就是在这个事件里 `agent.steer()`），且它**先于** `turn/end`
    // 派发，所以"这次是不是截断结束"只能读上一条 assistant 消息的 finish 记录。
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal.aborted || !config.enabled.get()) return
      // 只认本轮**最后一个 step** 的记录：辅助调用（标题、压缩）也会写 assistant 消息，
      // 用它们的截断去 steer 会把一句话塞进不相干的一轮。记录按 step 存，所以这里
      // 先取 step、再问它自己的那一条——别的 step 的消息冲不掉它。
      const state = states.latestOfTurn(agent, turn)
      if (state === undefined) return
      const note = states.truncationOf(agent, turn, state.step)
      if (note === undefined || !note.truncated) return
      const effective = readConfig(config, this.raw)
      const bound = bindings.read(agent.session.id)
      const policy = chainForSession(effective, bound?.chain ?? null).chain.maxTokens
      if (!policy.autoContinue) return
      const route = routeKeyOf(note.provider, note.model)
      const used = states.continuesUsed(agent, turn, route)
      if (used < policy.continues) {
        states.noteContinue(agent, turn, route)
        agent.steer(truncationContinueNotice(policy.continues - used - 1))
        return
      }
      // 续满了：这一步之后再写就该换候选。链上没有下一条就到此为止，交给 DSH 的
      // 截断结束（界面照旧提示用户自己继续），插件不伪造一次没有对象的切换。
      const index = state.chain.candidates.findIndex(candidate =>
        candidate.provider === note.provider && candidate.model === note.model)
      const next = index >= 0 ? state.chain.candidates[index + 1] : undefined
      if (next === undefined) return
      states.carryTo(agent, {
        turn,
        provider: next.provider,
        model: next.model,
        fromProvider: note.provider,
        fromModel: note.model,
        continues: used,
      })
      agent.steer(truncationContinueNotice())
    })
  }

  // ---- delegation handoff (P2) ----
  //
  // 委派名册：一个工具、一个投影、一个账本。默认关（`handoff.enabled: false`），
  // 关着时这里什么都不注册——没有工具、没有监听，装好不改任何现有行为。
  // 字段与默认值的唯一来源是 docs/design/handoff-proposal.md §5/§十二。

  /**
   * Register the one `handoff` tool and the turn-stopping fallback.
   *
   * The registration waits for `tools`/`subagents` through `ctx.inject`: the
   * plugin's own `inject` list is `['llm']`, so at construction time those
   * services may not be mounted yet (measured in the headless composition — the
   * tool silently did not register). The child fiber dies with this one, so a
   * config save unregisters and re-registers the tool exactly once.
   *
   * The remaining services stay optional (`ctx.get`): a composition without
   * `goals`/`sessionController` can still delegate — `newSession` refuses with a
   * named reason instead of pretending it worked.
   */
  /**
   * The ingress: read one repository's issues, judge, open Cases.
   *
   * Every refusal here is a logged error rather than a throw. The alternative —
   * failing the plugin — would take routing down with it, so a typo in the repository
   * name would stop every model call in the profile. The failure is loud in the log
   * and silent in behaviour, which is the direction this seam has to fail.
   *
   * Note: 为何令牌只走环境变量、为何无持久存储时拒绝启动 —— 见
   * .agents/notes/implemented/2026-11-10-ingress-token-and-persistence.md
   */
  private installIngress(): void {
    const ctx = this.ctx
    const ingress = this.config.ingress.get() as {
      enabled: boolean
      repository: string
      baseUrl: string
      agentLogin: string
      allowed: string[]
      bots: string[]
      acceptMode: 'off' | 'observe' | 'auto'
      pollSeconds: number
    }
    if (!ingress.enabled) return

    const parsed = parseRepository(ingress.repository)
    if (parsed === undefined || ingress.agentLogin === '') {
      ctx.logger.error(
        'oncall: ingress is enabled but ingress.repository (owner/name) or ingress.agentLogin is empty; the loop stays off',
      )
      return
    }
    const token = envOf(INGRESS_TOKEN_ENV)
    if (token === '') {
      ctx.logger.error(`oncall: ingress is enabled but ${INGRESS_TOKEN_ENV} is empty; the loop stays off`)
      return
    }

    const sourceId = githubIssueSourceId(parsed.owner, parsed.repo)
    // Empty means api.github.com; the setting exists for GitHub Enterprise and for a
    // test that must not reach the network.
    const face = githubHttpFace({ token, baseUrl: ingress.baseUrl === '' ? undefined : ingress.baseUrl })
    const source = githubIssueSource({ face, owner: parsed.owner, repo: parsed.repo, login: ingress.agentLogin })
    const ledger = new DurableLedger(ctx)
    const policy = (): Policy => ({
      version: INGRESS_POLICY_VERSION,
      acceptMode: ingress.acceptMode,
      allowed: ingress.allowed.map(id => ({ source: sourceId, id })),
      bots: ingress.bots.map(id => ({ source: sourceId, id })),
      disabledSources: [],
    })

    const outbox = new Outbox({
      ledger,
      sender: githubReplySender({ face, sourceId, owner: parsed.owner, repo: parsed.repo }),
      now: () => Date.now(),
      logger: ctx.logger,
    })

    let handle: IngressLoopHandle | undefined
    let executor: Executor | undefined
    let stopped = false
    ctx.effect(() => () => { stopped = true; executor?.stop(); outbox.stop(); handle?.stop() }, 'oncall ingress')

    // The executor needs the Session services, which this composition mounts later
    // than the plugin (measured in the web profile: `sessionController` lives in the
    // web app's own patch). `ctx.inject` is the sanctioned wait; the child fiber
    // dies with this one, so a config save re-registers exactly once.
    ctx.inject(['sessionController', 'agents', 'sessionPersistence', 'tools'], (child: Context) => {
      const controller = child.get('sessionController') as SessionControllerService | undefined
      const agents = child.get('agents') as AgentRegistryService | undefined
      const persistence = child.get('sessionPersistence') as SessionPersistenceService | undefined
      const tools = child.get('tools') as { register(definition: unknown): unknown } | undefined
      if (controller === undefined || agents === undefined || persistence === undefined || tools === undefined) {
        child.logger.error(
          'oncall: the ingress needs sessionController, agents, sessionPersistence and tools; the loop stays off',
        )
        return
      }
      const worker = new Executor({
        ledger,
        host: this.turnHost({ child, controller, agents, persistence, logger: child.logger }),
        replier: outbox,
        // V0: worker sessions run in the host process's directory; `ingress.workdir`
        // becomes the setting that overrides it.
        workdir: hostCwd(),
        now: () => Date.now(),
        logger: child.logger,
      })
      executor = worker
      // Globally registered, per-session decided: see faces/reports.ts.
      registerReportTool({ tools }, worker)

      void (async () => {
        await ledger.ready
        if (stopped) return
        if (!ledger.persistent) {
          ctx.logger.error('oncall: the ingress needs durable storage and this composition has none; the loop stays off')
          return
        }
        // Before the first pass: a restart must turn an orphaned assignment into a
        // recovery one before new work arrives on the same Case.
        await worker.start()
        // ...and before it, the receipts a crash interrupted between the ledger write
        // and the POST (one row per caseId#seq makes this safe to repeat).
        await outbox.resume()
        if (stopped) return
        handle = startIngressLoop({
          sources: [source],
          ledger,
          policy,
          executor: worker,
          intervalMs: Math.max(5, ingress.pollSeconds ?? DEFAULT_INGRESS_POLL_SECONDS) * 1_000,
          now: () => Date.now(),
          // Quiet by default: a pass that changed nothing says nothing.
          onPass: report => {
            for (const item of report.sources) {
              if (item.opened + item.observed + item.refused + item.delivered === 0) continue
              ctx.logger.info(
                `oncall: ingress ${item.sourceId}: ${item.opened} opened, ${item.observed} observed, `
                + `${item.refused} refused, ${item.delivered} followed up`,
              )
            }
          },
          onError: error => { ctx.logger.error(`oncall: ingress pass failed: ${String(error)}`) },
        })
        ctx.logger.info(`oncall: ingress watching ${parsed.owner}/${parsed.repo} for @${ingress.agentLogin}`)
      })()
    })
  }

  /**
   * The session side of the executor, built from the services of one composition.
   *
   * Everything that knows about providers, models or DSH event shapes lives here:
   * the executor sees `TurnFact`s and a `exhausted` verdict, never a session event
   * or a candidate. `exhausted` asks the ROUTER's own per-step state and the chain's
   * own `switchOn`/`immediateSwitch` rules (`router.ts`), so layer B cannot develop
   * its own opinion about which failures are worth retrying.
   */
  private turnHost(services: {
    readonly child: Context
    readonly controller: SessionControllerService
    readonly agents: AgentRegistryService
    readonly persistence: SessionPersistenceService
    readonly logger: { warn(message: string): void }
  }): TurnHost {
    const { child, controller, agents, persistence, logger } = services
    const states = this.states
    const agentOf = (sessionId: string): Agent | undefined => agents.get(sessionId as SessionId)

    return {
      async resolveAgent(sessionId) {
        const resolved = await controller.resolveAgent(sessionId as SessionId)
        return resolved.agent !== undefined
      },
      async create({ sessionId, cwd, title }) {
        await controller.create({ sessionId: sessionId as SessionId, cwd })
        await controller.rename({ sessionId: sessionId as SessionId, title })
      },
      followup({ sessionId, messageId, text }) {
        const agent = agentOf(sessionId)
        if (agent === undefined) {
          logger.warn(`oncall: no live agent for ${sessionId}; the message was not delivered`)
          return
        }
        agent.followup(freezeMessage({
          id: MessageId(messageId),
          role: 'user' as const,
          content: [{ type: 'text', text }],
          source: { kind: 'oncall-worker', form: 'relay' },
        }))
      },
      holds(sessionId, messageId) {
        const agent = agentOf(sessionId)
        if (agent === undefined) return false
        const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
        if (pending.some(message => String(message.id) === messageId)) return true
        return agent.session.snapshotEvents().some(event =>
          event.type === 'user/message' && String(event.data.id) === messageId)
      },
      async whenIdle(sessionId) {
        const agent = agentOf(sessionId)
        if (agent === undefined) return
        await agent.whenIdle()
      },
      log(sessionId): readonly TurnFact[] {
        const agent = agentOf(sessionId)
        if (agent === undefined) return []
        const facts: TurnFact[] = []
        for (const event of agent.session.snapshotEvents()) {
          if (event.type === 'turn/end') {
            facts.push({ kind: 'turn-end', turn: event.data.turn, reason: turnEndOf(event.data.reason) })
          } else if (event.type === 'assistant/message') {
            facts.push({ kind: 'assistant', turn: event.data.turn, text: textOfMessage(event.data.message) })
          }
        }
        return facts
      },
      async flush() { await persistence.flush() },
      onIdle(listener) {
        // Registered on the child fiber, not on the agent: the disposer runs when
        // this plugin fiber unloads, and a reload must not leave a listener holding
        // the previous instance (the per-agent seam lesson, tools.md).
        const dispose = child.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
          if (status === 'idle') listener(agent.session.id)
        })
        return () => { dispose() }
      },
      exhausted(sessionId, turn, code) {
        const agent = agentOf(sessionId)
        if (agent === undefined) return undefined
        const state = states.latestOfTurn(agent, turn)
        if (state === undefined || !state.exhausted) return undefined
        return isSwitchOnEligible(state.chain, code) && !switchesImmediately(state.chain, code)
          ? 'transient'
          : 'terminal'
      },
    }
  }

  /**
   * A profile that still carries the pre-rename row is not silently adopted.
   *
   * The row id is the settings namespace, so a `model-desk` row keeps its own
   * namespace and would never be filled by this build. Saying so once is cheaper
   * than letting the user wonder why the settings page stayed empty.
   *
   * Note: 为何旧行不自动迁移、为何持久化键也一并改掉 —— 见
   * .agents/notes/implemented/2026-11-11-rename-to-oncall.md
   */
  private warnLegacyRow(): void {
    const editor = this.ctx.get('configEditor') as
      | { entries?(): readonly { options?: { id?: string } }[] }
      | undefined
    const entries = editor?.entries?.() ?? []
    if (entries.some(entry => entry.options?.id === 'model-desk')) {
      this.ctx.logger.error(
        'dsh-oncall: this profile still has a `model-desk` row. The row id is the settings namespace, so that row is not adopted: remove it and add `dsh-oncall`, then re-save the chain and roster.',
      )
    }
  }

  private installHandoff(projections: (ProjectionRegistryFace & ProjectionReadFace) | undefined): void {
    const ctx = this.ctx
    const configOf = (): HandoffConfig => this.config.handoff.get() as HandoffConfig
    const config = configOf()
    if (!config.enabled) return
    ctx.inject(['tools', 'subagents'], (child: Context) => {
      const tools = child.get('tools') as HandoffFaces['tools'] | undefined
      const subagents = child.get('subagents') as HandoffFaces['subagents'] | undefined
      if (tools === undefined || subagents === undefined) {
        child.logger.warn(
          'oncall: handoff.enabled is true but this composition provides no tools/subagents service; '
          + 'the handoff tool is not registered',
        )
        return
      }
      // `handoff.subagentBackend` 是一个名字，不是路由：拼错时保存成功、界面无事，
      // 直到模型第一次 delegate 才在 `startActivation` 里炸。这里只说一句——不拒绝，
      // 因为后端注册是环境事实（与候选 provider 同一条裁定，见 rules.ts 的注），
      // 而 warn 已经让"为什么派不出去"出现在同一个日志里。
      const backend = configOf().subagentBackend
      const backends = typeof subagents.list === 'function' ? subagents.list() : undefined
      if (backends !== undefined && !backends.includes(backend)) {
        child.logger.warn(
          `oncall: handoff.subagentBackend '${backend}' is not a registered subagent backend `
          + `(registered: ${backends.length > 0 ? backends.join(', ') : '(none)'}); every delegate will fail until it is fixed`,
        )
      }
      const ledger = new HandoffLedger(child)
      // The browser's budget read needs the same ledger the gates use; it is
      // created here because it rides the child fiber that owns the tool.
      this.handoffLedger = ledger
      const runtime = new HandoffRuntime({
        tools,
        subagents,
        goals: child.get('goals') as HandoffFaces['goals'],
        // Resolved at call time (getters, not captured references): a composition
        // may mount these two after this tool registers.
        sessionController: () => child.get('sessionController') as SessionControllerFace | undefined,
        // `create` answers an id, not the Agent (`SessionCreateValue`): the live
        // agent registry is what turns one into the other.
        agents: () => child.get('agents') as AgentRegistryFace | undefined,
        projections: projections as unknown as HandoffFaces['projections'],
        logger: child.logger,
      }, configOf, ledger, this.bindings)
      runtime.register()
      // The turn-stopping fallback: the one place the plugin speaks first, and it
      // only counts (proposal §7-B). Both halves default off.
      const current = configOf()
      if (current.limits.nudgeWhenUnreceipted || current.onUnreceiptedStop.reportToUser
        || current.onUnreceiptedStop.delegateTo !== '') {
        child.on('agent/turn-stopping', ({ agent, turn, signal }: { agent: Agent; turn: number; signal: AbortSignal }) => {
          this.onTurnStopping(runtime, configOf(), agent, turn, signal)
        })
      }
    })
  }

  /**
   * The "stopped without a receipt" seam.
   *
   * Deliberately narrow: it fires only when the projection can count open todos,
   * the turn declared nothing, and no goal is running. It never claims the work
   * is unfinished — the model's own `finish` receipt is the only sign-off, and
   * the notice says what is left, not what to think about it.
   */
  private onTurnStopping(runtime: HandoffRuntime, config: HandoffConfig, agent: Agent, turn: number, signal: AbortSignal): void {
    if (agent.session.header.parentSession !== undefined) return
    const receipt = runtime.receiptState(agent, turn)
    if (receipt === undefined || receipt.calledThisTurn || receipt.goalActive) return
    if (receipt.pendingTodos === 0) return
    // 计数按 agent（WeakMap，随 agent 消亡）并在换轮时归零：旧实现是
    // `sessionId:turn` 字符串 Map，永不清理，长会话里只增不减。
    const sent = this.nudges.get(agent)
    const used = sent !== undefined && sent.turn === turn ? sent.used : 0
    if (config.limits.nudgeWhenUnreceipted && used < config.limits.maxNudgesPerTurn) {
      this.nudges.set(agent, { turn, used: used + 1 })
      agent.steer(handoffNudgeNotice(receipt.pendingTodos))
      return
    }
    // Nudge spent (or off): either dispatch the configured fallback, or say it.
    if (config.onUnreceiptedStop.delegateTo !== '') {
      void runtime.delegateOnStop(agent, config.onUnreceiptedStop.delegateTo, receipt.pendingTodos, signal)
        .catch((error: unknown) => {
          this.ctx.logger.error(`oncall: the onUnreceiptedStop fallback could not be dispatched: ${String(error)}`)
          if (config.onUnreceiptedStop.reportToUser) {
            agent.session.append(
              'user/message',
              handoffUnreceiptedNotice(receipt.pendingTodos, ''),
              { surfaceOp: 'append' },
            )
          }
        })
      return
    }
    if (config.onUnreceiptedStop.reportToUser) {
      agent.session.append(
        'user/message',
        handoffUnreceiptedNotice(receipt.pendingTodos, ''),
        { surfaceOp: 'append' },
      )
    }
  }

  // ---- the plugin's own Remote ----

  /**
   * Probe routes end to end: one minimal message each, cut at the first content
   * byte. An empty `routes` means every route the config names. The caller's
   * signal cancels the whole run — a browser that closes the page mid-probe
   * stops spending tokens.
   */  @Remote
  async probeAll(request: ProbeRequest, signal: AbortSignal): Promise<ProbeReport> {
    const health = (this.config.health?.get() as HealthConfig | undefined)?.probe
    const fallback = health?.prompt ?? DEFAULT_PROBE_PROMPT
    const overrides = health?.prompts ?? []
    const timeoutSeconds = health?.timeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS
    const wanted = request.routes.length > 0
      ? request.routes
      : configuredRunRoutes(readConfig(this.config, this.raw))
    const at = Date.now()
    const routes: ProbeReport['routes'] = []
    this.probeInFlight += 1
    try {
      for (const route of wanted) {
        if (signal.aborted) break
        routes.push(await probeRoute(
          this.ctx.llm,
          route,
          probePromptFor(route, fallback, overrides),
          timeoutSeconds,
          signal,
        ))
      }
    } finally {
      this.probeInFlight -= 1
    }
    const report: ProbeReport = { at, routes }
    // 取消产生的残篇不当最新报告：用户合上面板后，工作台不该显示一次"只测了两条"的结果。
    if (!signal.aborted) this.lastProbeReport = report
    return report
  }

  /**
   * The report of the last run — the timer, a manual "probe all", or a single
   * route's button, whichever ran last. The browser reads this when the health
   * view opens, so a timer-driven probe is visible without the client holding a
   * subscription — the same snapshot pattern the passive fold uses.
   *
   * A single-route run therefore REPLACES this snapshot, which is why the browser
   * merges the answer into the verdicts it already holds (`client/controller.ts`)
   * instead of replacing its map: the snapshot speaks for the routes this run
   * covered, and says nothing about the others.
   */
  @Remote
  async probeReport(): Promise<ProbeReport> {
    return this.lastProbeReport
  }

  /**
   * Ask one or more routes whether their endpoint answers and advertises this
   * model, through DSH's own model discovery. An empty `routes` means every
   * route the config names.
   *
   * This runs on the Host because the classification needs the `LlmError` code
   * that `remoteDiscoverModels` strips: see ./connectivity.ts. The browser used
   * to call `remote.llm.discoverModels` itself and could not tell a channel DSH
   * cannot check at all from one whose endpoint refused the listing.
   *
   * The routes are checked concurrently, as the browser half did before the
   * move: a check costs no tokens, so a run's wall clock is the slowest
   * provider rather than their sum.
   *
   * Note: 为何搬宿主、封闭集合只收哪两个码、为何不禁用按钮 —— 见
   * .agents/notes/implemented/2026-10-16-connectivity-no-discovery-is-not-a-refusal.md
   */
  @Remote
  async checkConnectivity(request: ConnectivityRequest, signal?: AbortSignal): Promise<ConnectivityVerdict[]> {
    const wanted = request.routes.length > 0
      ? request.routes
      : configuredRunRoutes(readConfig(this.config, this.raw))
    // `settings` is read through the optional-service rule (packages/AGENTS.md):
    // a composition without it still checks, it just cannot supply a stored
    // baseURL and lets the discovery decide from the provider route alone.
    const settings = this.ctx.get('settings') as ConnectivitySettings | undefined
    // signal 是 Typert 的取消通道（描述符声明末参即注入，与 probeAll 同一机制）：
    // 浏览器卸载时在飞的发现调用随它中止，不继续打端点。
    return await Promise.all(wanted.map(route => checkConnectivity(this.ctx.llm, settings, route, signal)))
  }

  /**
   * Ask whether a newer release of this plugin is published, and read that
   * release's notes.
   *
   * It runs on the Host for the same reason the connectivity check does: the
   * browser half must not open a connection to a third party on its own, and
   * the two answers it needs (the newest published version, that version's
   * release notes) are exactly the Host's business.
   *
   * The running version's own notes are NOT fetched: they are embedded in this
   * artifact, so the dialog can show them offline and can never disagree with
   * what is installed.
   *
   * Note: 为何版本以 registry 为准、为何失败分成"查不到"与"读到版本但读不到说明" ——
   * 见 .agents/notes/implemented/2026-10-22-check-update-instead-of-a-changelog-button.md
   */
  @Remote
  async checkUpdate(signal?: AbortSignal): Promise<UpdateCheck> {
    return await checkForUpdate(RELEASE_VERSION, { signal })
  }

  /**
   * One session's routing binding, as the browser's chip reads it.
   *
   * A session that never wrote one reads as "follow the default chain, no
   * overrides" rather than as an error: an absent binding is a state, not a
   * failure. `persistent` is the Host's answer about where that state lives —
   * a composition without the storage domain keeps it in memory only, and the
   * UI has to be able to say so instead of promising durability it cannot give.
   *
   * Note: 会话绑定的存储、写入承诺与 0..9 边界 —— 见
   * .agents/notes/implemented/2026-10-21-per-session-bindings.md
   */
  @Remote
  async sessionBinding(sessionId: string): Promise<SessionBindingView> {
    // `persistent` is only meaningful once the open has settled: answering
    // during the boot would call a durable store "memory only".
    await this.bindings.ready()
    const binding = this.bindings.read(sessionId)
    return {
      chain: binding?.chain ?? null,
      retries: { ...(binding?.retries ?? {}) },
      persistent: this.bindings.persistent,
    }
  }

  /**
   * The budget a `newSession` carried into one session, for the fleet tab.
   *
   * Only the *carried* half: the projection half is already in the browser (the
   * `oncall/handoff` snapshot) and both halves add it with the same
   * `addCarried`, so this read never becomes a second source for "已用". A
   * session that inherited nothing answers `carried: false` with zero counters —
   * a known zero, not an unknown.
   */
  @Remote
  async handoffCarried(sessionId: string): Promise<HandoffCarriedView> {
    const carried = this.handoffLedger?.carriedOf(sessionId)
    if (carried === undefined) {
      return { carried: false, delegations: 0, reviews: 0, newSessions: 0, perRole: {} }
    }
    return {
      carried: true,
      delegations: carried.delegations,
      reviews: carried.reviews,
      newSessions: carried.newSessions,
      perRole: { ...carried.perRole },
    }
  }

  /**
   * Store one session's routing binding. Resolves only after the write is
   * durable (or, without a storage domain, after it reached process memory) —
   * a storage failure is rethrown unchanged, because the caller's contract is
   * "success means saved": a swallowed error would leave the chip showing a
   * binding that does not exist.
   *
   * A chain id the config does not define is refused rather than stored: the
   * routing path would read it as a stale binding and route on the default chain
   * with a notice, so accepting it would save a choice that never takes effect.
   */
  @Remote
  async setSessionBinding(request: SessionBindingRequest): Promise<SessionBindingView> {

    if (request.chain !== null && !readConfig(this.config, this.raw).chains.some(chain => chain.id === request.chain)) {
      throw new Error(`oncall: the config defines no chain '${request.chain}' to bind this session to`)
    }
    const binding = { chain: request.chain, retries: { ...request.retries } }
    await this.bindings.write(request.sessionId, binding)
    return { chain: binding.chain, retries: { ...binding.retries }, persistent: this.bindings.persistent }
  }

  /**
   * Arm the scheduled probe. The interval is user config and defaults to 0
   * (off): a probe spends a token on every tick, so whether that is acceptable
   * is the user's call. A config save restarts this fiber, which re-arms with
   * the new interval — there is no separate update path to keep in sync.
   *
   * 两个不变量：周期到点时若仍有探测在飞（手动或上一轮），本轮直接跳过——不排队、
   * 不叠加，否则 1s 周期叠 8s 超时会并发出几十轮探测，token 与限流都失控；
   * fiber 卸载时 clearInterval 之外还必须 abort 掉飞行中的那轮，否则配置一保存，
   * 上一轮的请求还在花钱。
   */
  private armProbeTimer(): void {
    const health = (this.config.health?.get() as HealthConfig | undefined)?.probe
    const seconds = health?.enabled === true ? (health.intervalSeconds || 0) : 0
    if (seconds <= 0) return
    const controller = new AbortController()
    this.probeTimerId = setInterval(() => {
      if (this.probeInFlight > 0) return
      void this.probeAll({ routes: [] }, controller.signal).catch((error: unknown) => {
        this.ctx.logger.warn(`oncall: scheduled probe failed: ${String(error)}`)
      })
    }, seconds * 1000)
    this.ctx.effect(() => () => {
      if (this.probeTimerId !== undefined) clearInterval(this.probeTimerId)
      controller.abort()
    }, 'router: probe timer')
  }
}

/**
 * The effective config both the routing path and the load-time audits read.
 *
 * For `chains`, `effectiveChains` is the one place that decides which shape
 * wins: a stored `chains` key, or one of the three legacy shapes an older build
 * wrote. `migratedFrom`/`ignoredProfiles` exist so the Host can say out loud
 * that a legacy config was reinterpreted instead of silently discarding what
 * the user configured.
 *
 * `chain` is read through `.get()` and is always defined (the schema stamps its
 * default); that is exactly why the `chains` accessor's UNDEFINED value — which
 * the schema deliberately does not default — is the presence signal.
 */
function readConfig(config: Config, raw: unknown): {
  enabled: boolean
  chains: NamedChain[]
  defaultChainId: string
  health?: HealthConfig
  handoff?: HandoffConfig
  migratedFrom: ChainSource
  ignoredProfiles: number
} {
  // The declared fields are Volatile accessors; the legacy keys schemastery
  // passed through are plain values (they are not in the schema). Build the
  // migration input explicitly so neither half of that fact is guessed.
  const stored = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  // 形状判断只认原始配置里"有没有这个键"：schemastery 会给每个声明过的字段盖默认值
  // （chain 被盖成一条空链、任何数组被盖成 []），校验后的对象分不出"没写过"与"写了个空的"。
  const effective = effectiveChains(stored)
  return {
    enabled: config.enabled.get() as boolean,
    chains: effective.chains,
    defaultChainId: effective.defaultChainId,
    health: config.health?.get() as HealthConfig | undefined,
    handoff: config.handoff?.get() as HandoffConfig | undefined,
    migratedFrom: effective.source,
    ignoredProfiles: effective.ignoredProfiles,
  }
}

/**
 * The plugin's RAW config: ctx.fiber._config is "the raw plugin config,
 * re-resolved before each activation" (cordis fiber.d.ts:107-108). The validated
 * value cannot answer "was this key written" — schemastery stamps a default onto
 * every declared field — and that question is the whole shape-判断 in ./chain.ts.
 */
function rawConfigOf(ctx: Context): unknown {
  return (ctx.fiber as unknown as { _config?: unknown })._config
}

/**
 * Whether the next fire may move to the next candidate. The failure behind the
 * retry must be `switchOn`-eligible; an unrecorded code (a first attempt, or a
 * feed that has not committed yet) fails closed — the recovery listener, which
 * sees the failure synchronously, remains the authority.
 */
function mayAdvance(
  states: RouterState,
  agent: Agent,
  turn: number,
  step: number,
  chain: StepChain,
): boolean {
  const code = states.failureCodeOf(agent.session, turn, step)
  return code !== undefined && isSwitchOnEligible(chain, code)
}

/**
 * 拒绝候选 provider 声明 `always` 重试策略。
 *
 * 这是已记录的加载时拒绝项（docs/design/dsh-capability-boundary.md §三 G2 与
 * open-questions 一.3）：always 模式没有重试上限（llm/src/retry-policy.ts），而且它对
 * **每个**失败码都重试——包括用户没勾 switchOn 的码，那些码本插件不切换、只等 DSH 收尾。
 * 放着它，一个没勾的码就能把这一 step 永远重试下去（"绝不盲重试"的承诺失效）。策略是
 * 用户在每个渠道的 Models 设置里自己选的（llm-deepseek/src/config.ts 的
 * RetryPolicySchema），所以必须在这里挡住，而不是在运行时悄悄降级——降级会静默改变
 * 用户依赖的重试行为。
 *
 * `providerRetryPolicy` 是 llm 服务的原生读口（llm/src/index.ts:656），只对已注册的
 * provider 调用（未注册的会抛），未注册的漂移由 warnUnregisteredProviders 处理。
 *
 * 已知边界（与 warnUnregisteredProviders 同源，写在这里防止下轮当成新发现）：加载时
 * 尚未注册的 provider 会被跳过——在本插件之后注册的 always 策略因此逃过加载校验。
 * 运行时拦截是行为变更（跳过候选 + 新通知形状），属另一轮决策，不在本轮。
 */
function assertNoAlwaysPolicy(ctx: Context, config: { chains: readonly NamedChain[] }): void {
  const registered = registeredProviderIds(ctx)
  eachConfiguredCandidate(config, (candidate) => {
    if (!registered.has(candidate.provider)) return
    const policy = ctx.llm.providerRetryPolicy(candidate.provider)
    if (policy?.mode === 'always') {
      throw new Error(
        `oncall: candidate ${routeKeyOf(candidate.provider, candidate.model)} names a provider whose retry policy is "always" — `
        + 'unbounded same-route retries would never end the step for a failure the chain does not switch on; '
        + 'set that provider back to the normal policy, or remove it from the chain',
      )
    }
  })
}

function warnUnregisteredProviders(ctx: Context, config: { chains: readonly NamedChain[] }): void {
  const registered = registeredProviderIds(ctx)
  eachConfiguredCandidate(config, (candidate) => {
    if (!registered.has(candidate.provider)) {
      ctx.logger.warn(
        `oncall: candidate ${routeKeyOf(candidate.provider, candidate.model)} names an unregistered provider; `
        + 'that candidate is skipped at runtime and the chain continues with the rest',
      )
    }
  })
}

/**
 * 一个写错路由的探测覆盖永远不会生效：`probePromptFor`（`probe.ts`）按
 * `provider/model` 精确匹配，匹配不上就静默回落到全局默认内容。配错是环境事实
 * （渠道可能稍后才注册），所以只 warn，与 `warnUnregisteredProviders` 同一条裁定。
 */
function warnStaleProbePrompts(ctx: Context, config: { chains: readonly NamedChain[]; health?: HealthConfig }): void {
  const prompts = config.health?.probe?.prompts ?? []
  if (prompts.length === 0) return
  const configured = new Set(configuredRunRoutes(config).map(route => routeKeyOf(route.provider, route.model)))
  for (const entry of prompts) {
    if (entry.route !== '' && !configured.has(entry.route)) {
      ctx.logger.warn(
        `oncall: health.probe.prompts names '${entry.route}', which no chain configures; `
        + 'that per-route prompt will never be used (the global prompt applies instead)',
      )
    }
  }
}

/** The provider ids the llm service has registered so far. */
function registeredProviderIds(ctx: Context): Set<string> {
  return new Set(ctx.llm.listProviders().map(provider => provider.id))
}

/**
 * Walk every configured fallback once. Both load-time audits (the always-policy
 * rejection and the unregistered-provider warning) share this walk; they used to
 * each carry their own copy of the loop, and the second copy is where the two drift.
 */
function eachConfiguredCandidate(
  config: { chains: readonly NamedChain[] },
  visit: (candidate: { provider: string; model: string }) => void,
): void {
  for (const chain of config.chains) for (const candidate of chain.candidates) visit(candidate)
}

/** The projection registry's read face this plugin uses; structurally typed to keep the service optional. */
interface ProjectionReadFace {
  /** `keys` is the native filter (session-projection/src/index.ts:339): only those units' wire views are produced. */
  snapshot(session: Session, keys?: readonly string[]): { values: Record<string, unknown> }
}

/** The projection registry's write face: one namespaced unit, disposed with this fiber. */
interface ProjectionRegistryFace {
  register(definition: unknown): () => void
}

/**
 * Gather the step's request-shape conditions. The images gate reads the
 * admitted user messages; the token gate reads the context-pressure wire view,
 * whose `projectedTokens` is the canonical "what the next request will cost"
 * answer (present only after the first usage sample). When the registry or the
 * unit is absent the gate reads as unmet rather than guessing.
 */
function gatherConditions(
  projections: ProjectionReadFace | undefined,
  session: Session,
  messages: readonly { content: readonly { type: string }[] }[],
): StepConditions {
  let projectedTokens: number | undefined
  if (projections !== undefined) {
    // keys 过滤是原生读口（session-projection/src/index.ts:339-353）：只产出这一个
    // 单元的 wire view。不传 keys 会把所有客户端可见单元整份过 viewSchema.parse——
    // 每步一次，含本插件自己的 24 点时间线与账本。
    const pressure = projections.snapshot(session, ['contextPressure']).values['contextPressure'] as { projectedTokens?: number } | undefined
    projectedTokens = pressure?.projectedTokens
  }
  return { hasImages: hasImageContent(messages), projectedTokens }
}

// The Typert host-face surface: re-exported so the generator's package model
// collects the @typert-marked declaration from this entry module
// (packages/typert/generator/src/analyzer.ts:748-789).
export type { ChainConfig } from './config.ts'
