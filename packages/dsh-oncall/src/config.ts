/**
 * Config schema for dsh-oncall.
 *
 * Schemastery is the DSH plugin Config library (184 in-tree users); `.volatile()`
 * marks the fields the Plugins-page form edits. Values are read through
 * `config.<field>.get()` in `apply`, and a hot update is validated in the
 * `internal/config` waterfall before Cordis restarts the plugin fiber.
 *
 * The shape is the canonical schema from docs/design/product-plan.md section 3:
 * an `enabled` master switch and a set of named fallback chains, one of which is
 * the default. A chain's first hop is the model the user selected in DSH — it is
 * not configured here and the plugin does not own it — so `candidates` lists the
 * fallbacks only. A session may bind itself to any chain by id; `chain` is the
 * legacy single-chain key and is read only while `chains` is absent.
 */

import z from '@deepseek-ai/schemastery'
import {
  BREAKER_COOLDOWN_MAX_SECONDS,
  BREAKER_COOLDOWN_MIN_SECONDS,
  DEFAULT_BREAKER_COOLDOWN_SECONDS,
  DEFAULT_BREAKER_SCOPE,
  DEFAULT_CHAIN_ID,
  HEALTH_INTERVAL_MAX_SECONDS,
  PROBE_TIMEOUT_MAX_SECONDS,
  PROBE_TIMEOUT_MIN_SECONDS,
  DEFAULT_FIRST_HOP_MAX_RETRIES,
  DEFAULT_HANDOFF_LIMITS,
  DEFAULT_HANDOFF_MAX_RUNS_PER_USER_MESSAGE,
DEFAULT_HANDOFF_PROMPT_TEMPLATE,
HANDOFF_PROMPT_EXTRA_MAX,
HANDOFF_PROMPT_TEMPLATE_MAX,
  DEFAULT_HANDOFF_SUBAGENT_BACKEND,
  DEFAULT_IMMEDIATE_SWITCH,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_TOKEN_AUTO_CONTINUE,
  DEFAULT_MAX_TOKEN_CONTINUES,
  HANDOFF_ATTACH_ITEMS,
  HANDOFF_BRIEFING_ITEMS,
  HANDOFF_FAILOVER_INHERIT,
  HANDOFF_NEXT_ACTIONS,
  HANDOFF_OUTCOMES,
  HANDOFF_ROLES,
  MAX_RETRIES,
  MAX_TOKEN_CONTINUES,
  DEFAULT_PROBE_PROMPT,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  DEFAULT_STICKY_TURNS,
  DEFAULT_STRATEGY,
  DEFAULT_SWITCH_ON,
  STRATEGIES,
  type Strategy,
  DEFAULT_TIMELINE_BUCKET_SECONDS,
} from './defaults.ts'
import { DEFAULT_INGRESS_POLL_SECONDS } from './contract/defaults.ts'
import { structuralViolations } from './rules.ts'

/**
 * One physical candidate. Credentials stay owned by the provider adapter.
 *
 * `needs` gates the candidate on the shape of THIS request: `images` is
 * tri-state (`true` = only when the step's admitted user messages carry an
 * image, `false` = only when they do not, absent = unconstrained),
 * `minContextTokens` requires the context-pressure projection's estimate for
 * the next request. Both are read once per step (agent/pre-step and the
 * projection), so they are stable across the step's retries — with `images`
 * accumulating across a turn's steps, because a tool-loop turn's later steps
 * claim no new input. The gates apply to every candidate including the first
 * hop (the user's own selection): an explicit condition is the user's stated
 * intent, and honoring it is configuration, not a silent reroute. What stays
 * exempt is the automatic machinery (breaker cooldowns, capability
 * pre-validation) — DSH validated the selection when it was made.
 */
// 联合手写而不用 `(typeof STRATEGIES)[number]`：Typert 的 Zod 发射器不支持
// indexed-access 节点（packages/typert/generator/src/emitter.ts:777-788），
// 而 `ChainConfig` 的 Typert surface 经由 `strategy` 引用它。清单本身在
// ./defaults.ts（浏览器半包也读它，不能把 schemastery 拖进 bundle），显式
// 注解让 schema 与 UI 的选项在编译期保持同源。
/**
 * 降级起点策略：只决定"第一跳失败后，从哪条降级候选开始"。
 *
 * 第一跳永远是用户当前选中的模型、永远先试——选一个模型就意味着先试它，
 * 起点策略不能悄悄推翻这件事。三种策略只改降级候选的起点：按顺序、按权重
 * 随机抽、还是轮流顺移；之后的前进逻辑完全一样，继续试其余候选直到成功或
 * 用尽预算。DSH 核心没有任何原生的权重/轮询/负载均衡，所以这里自己实现，
 * 但枚举用 schemastery 的 `union` 写法（`llm-pi-ai` 的 `transport` 同款），
 * 没有 `z.enum`。
 */
export type { Strategy }
export { STRATEGIES }

export const strategySchema = z.union([...STRATEGIES]).default(DEFAULT_STRATEGY)
  .description('第一跳（你选中的模型）失败后从哪条降级候选开始：按顺序 / 按权重随机 / 轮询。第一跳永远先试，不参与抽签')

export const candidateSchema = z.object({
  provider: z.string().required().description('provider 标识，例如 deepseek-official'),
  model: z.string().required().description('模型 ID，例如 deepseek-v4-flash'),
  maxRetries: z.number().step(1).min(0).max(MAX_RETRIES).default(DEFAULT_MAX_RETRIES)
    .description('这条渠道失败后最多重试几次（不含首次调用；0 = 失败即切下一条）。重试由本插件执行：填几次就是几次，不受 provider 重试策略封顶（退避曲线仍取自该 provider 的策略）'),
  weight: z.number().step(1).min(0).max(100).default(0)
    .description('权重；只有「按权重」策略会读它，其他策略下写多少都不影响'),
  needs: z.object({
    images: z.boolean().description('图片条件：true = 仅当本次请求包含图片时使用此候选；false = 仅当本次请求不含图片时使用；不填 = 不限。第一跳的条件在链的 primaryNeeds 里单独配置'),
    minContextTokens: z.number().step(1).min(0).description('仅当预估上下文达到该 token 数时使用此候选；0 表示不限制'),
  }).description('高级路由条件：不满足时跳过此候选（只作用于链上的降级候选；第一跳用 primaryNeeds）'),
})

/**
 * The first hop's own condition — the same shape as a candidate's `needs`.
 *
 * The first hop is the model DSH has already selected, so it is not in
 * `candidates` and has nowhere to carry a condition. Without this field the
 * "zero-click vision route" (a text-first chain whose image candidate is gated)
 * cannot describe its own primary: `needs` on a candidate that names the
 * selected route is dropped by `resolveChain`'s de-duplication.
 *
 * A condition here that the request does not meet skips the first hop and the
 * chain continues with its fallbacks; the skip is announced like any other.
 */
export const primaryNeedsSchema = z.object({
  images: z.boolean().description('第一跳的图片条件：true = 仅当本次请求包含图片时走第一跳；false = 仅当本次请求不含图片时走；不填 = 不限'),
  minContextTokens: z.number().step(1).min(0).description('仅当预估上下文达到该 token 数时才走第一跳；0 表示不限制'),
}).description('第一跳（你选中的模型）的路由条件：不满足时跳过它，直接从降级候选开始')

/** Which failures move to the next candidate. Fixed set, Chinese labels. */
export const switchOnSchema = z.object({
  rateLimit: z.boolean().default(DEFAULT_SWITCH_ON.rateLimit).description('限流（RATE_LIMIT）'),
  server: z.boolean().default(DEFAULT_SWITCH_ON.server).description('服务端错误（SERVER）'),
  timeout: z.boolean().default(DEFAULT_SWITCH_ON.timeout).description('超时（TIMEOUT）'),
  transport: z.boolean().default(DEFAULT_SWITCH_ON.transport).description('网络传输失败（TRANSPORT）'),
  emptyResponse: z.boolean().default(DEFAULT_SWITCH_ON.emptyResponse).description('空回复（EMPTY_RESPONSE）。勾选时按候选的重试次数用尽后切换；不勾则由 DSH 按它自己的策略重试，重试完即失败、不切换'),
  invalidRequest: z.boolean().default(DEFAULT_SWITCH_ON.invalidRequest).description('请求被拒绝 / 能力不兼容（INVALID_REQUEST）；分类依赖 provider，不保证精确。注意：上游网关的 402「端点不可用」在 pi-ai 适配器里会被归一成这个码（报文带 invalid_request_error），这类是临时故障，应当切换'),
  // 凭证与额度是"渠道自己的毛病"，换一条渠道往往立刻就能救——另一条渠道有自己的
  // 密钥和额度。2026-10-16 修订：此前把它们列为"配置坏了，切换只会把问题藏起来"而
  // 不切换，但熔断本来就会让后续请求跳过死渠道，那条理由只把第一次请求也搭进去；
  // 而切换从不是静默的（中文 notice 点名失败路由与码 + 熔断冷却），比干失败更响。
  auth: z.boolean().default(DEFAULT_SWITCH_ON.auth).description('凭证或权限被拒（AUTH）：换一条渠道通常立刻能救，另一条渠道有自己的密钥'),
  quota: z.boolean().default(DEFAULT_SWITCH_ON.quota).description('额度用尽（QUOTA）：同上，换渠道可继续；熔断会让后续请求先跳过这条'),
  // 枚举永远覆盖不全：这一项代表表里那 8 个码之外的一切失败码（PI_AI_ERROR、
  // HTTP_xxx、以后新增的码）。默认 true，因为"未知"不是"不该动"的理由。
  other: z.boolean().default(DEFAULT_SWITCH_ON.other)
    .description('其他/未分类失败码（表里没有的一切码）。默认切换：未知码同样先交给 DSH 自己的恢复插件，它们放弃后才切换'),
})

/**
 * 一条链的全部可编辑字段。`chainSchema`（旧形状：唯一的全局链）与
 * `namedChainSchema`（新形状：`chains[]` 里的一条）共用这份字段表——两份字段定义
 * 会让"链有哪些字段"变成两个事实，加一个字段就得记得改两处。
 */
const chainFields = {
  candidates: z.array(candidateSchema).default([])
    .description('降级候选：第一跳永远是你当前选中的模型、永远先试；失败后从这里的候选里按起点策略开始走'),
  switchOn: switchOnSchema.default({}).description('哪些失败会切换到下一个候选'),
  // 白名单而不是"每个码一个次数"：码枚举不全，而"这一击要不要再打一次"是个
  // 二值判断。只收键名，界面上的两组勾选因此一一对应。
  immediateSwitch: z.array(z.string()).default([...DEFAULT_IMMEDIATE_SWITCH])
    .description('这些失败不重试、直接切下一条候选（键名与「失败切换」一致）。只用于"重试注定一样"的码：密钥失效、额度用尽、请求被拒'),
  stickyTurns: z.number().step(1).min(0).max(99).default(DEFAULT_STICKY_TURNS)
    .description('带图轮之后，继续按「有图」路由的无图轮数；0 = 无图轮立即切回（默认）'),
  strategy: strategySchema,
  primaryNeeds: primaryNeedsSchema,
  firstHopMaxRetries: z.number().step(1).min(0).max(MAX_RETRIES).default(DEFAULT_FIRST_HOP_MAX_RETRIES)
    .description('第一跳（当前选中的模型）失败后最多重试几次（不含首次调用；0 = 首发失败即降级）'),
  maxTokens: z.object({
    autoContinue: z.boolean().default(DEFAULT_MAX_TOKEN_AUTO_CONTINUE)
      .description('输出被截断（达到输出 token 上限）时自动补一句「继续」，而不是停下等用户手动发'),
    continues: z.number().step(1).min(0).max(MAX_TOKEN_CONTINUES).default(DEFAULT_MAX_TOKEN_CONTINUES)
      .description('同一个候选上一轮最多自动续几次；用完还继续被截断，就换下一条候选接着写'),
  }).default({}).description('输出被截断时的处理：续几次、用完是否换候选'),
}

export const chainSchema = z.object(chainFields)

/**
 * 一条命名链：同一份字段，外加身份。
 *
 * `id` 是会话绑定的引用键，**不可变**（改名只改 `name`）；`name` 留空时界面按
 * 「默认链」显示——把中文名字写进迁移出来的配置会让英文界面显示中文，也会让
 * 用户以为这是个必须填的字段。
 */
export const namedChainSchema = z.object({
  id: z.string().required().description('链的稳定标识；会话按它绑定，改显示名不影响绑定'),
  name: z.string().default('').description('显示名；留空表示「默认链」'),
  ...chainFields,
})

/**
 * "敲门"档：向渠道要一份模型清单，不生成任何内容。
 *
 * 走 DSH 原生的 `ctx.llm.discoverModels`——就是设置页「获取可用模型」按钮的同一套。
 * 它能证明端点可达、凭证有效、这个模型 ID 被广告，但不证明模型真能出字。
 * 零输出 Token；provider 在适配器目录里时甚至不发网络请求。
 */
export const discoverSchema = z.object({
  enabled: z.boolean().default(true).description('定时连通性检查：到点向渠道要一份模型清单，不生成内容、不花 Token'),
  intervalSeconds: z.number().step(1).min(0).max(HEALTH_INTERVAL_MAX_SECONDS).default(DEFAULT_INTERVAL_SECONDS)
    .description('定时检查周期（秒；0 表示只手动跑，不后台轮询）。限流是每个渠道各自的，按你自己渠道的承受能力设'),
})

/**
 * "真探测"档：真的发一条最小消息。
 *
 * 这是唯一能证明「模型现在真能出字」的方式——配额打满、上游容量不足、模型被下线但仍在
 * 清单里，都只有真生成才暴露。代价是花 Token，所以默认关闭，由用户自己决定要不要花。
 *
 * `prompt` 与 `prompts` 只对这一档有意义：前两档不发消息，碰不到渠道违禁词。违禁词是
 * 每个渠道各不一样的，所以全局默认之外再给按渠道覆盖。
 */
export const probeSchema = z.object({
  enabled: z.boolean().default(false).description('定时真探测：真的发一条最小消息，唯一能证明模型能出字，但会花 Token'),
  intervalSeconds: z.number().step(1).min(0).max(HEALTH_INTERVAL_MAX_SECONDS).default(DEFAULT_INTERVAL_SECONDS)
    .description('定时真探测周期（秒；0 表示只手动跑）'),
  prompt: z.string().default(DEFAULT_PROBE_PROMPT)
    .description('探测发什么内容；默认单个字符最不容易触发渠道内容过滤'),
  prompts: z.array(z.object({
    route: z.string().required().description('渠道，格式 provider/model'),
    prompt: z.string().required().description('这个渠道专用探测内容，覆盖全局默认'),
  })).default([]).description('按渠道覆盖探测内容：不同渠道违禁词不同，被拦的就单独写一个'),
  timeoutSeconds: z.number().step(1).min(PROBE_TIMEOUT_MIN_SECONDS).max(PROBE_TIMEOUT_MAX_SECONDS).default(DEFAULT_PROBE_TIMEOUT_SECONDS)
    .description('单次探测超时时间（秒）'),
})

/**
 * 一条自动禁用（熔断）规则。
 *
 * `code` 与 `message` 都是可选的，填几个就按几个匹配，都填就是两条都要满足——
 * 这样"只知道码"和"只有错误信息能判断"两种情况能用同一种规则表达。留空一个是
 * 为了让规则表保持一种形状，而不是逼用户在两种规则类型之间选。
 */
export const breakRuleSchema = z.object({
  code: z.string().default('').description('错误码，精确匹配；留空表示这一条不按码匹配'),
  message: z.string().default('').description('错误信息包含这个字符串就命中；留空表示不按信息匹配'),
  cooldownSeconds: z.number().step(1).min(BREAKER_COOLDOWN_MIN_SECONDS).max(BREAKER_COOLDOWN_MAX_SECONDS).default(DEFAULT_BREAKER_COOLDOWN_SECONDS)
    .description('命中后禁用多少秒；冷却到了自动放行重试，不是永久拉黑'),
  scope: z.union(['route', 'channel']).default(DEFAULT_BREAKER_SCOPE)
    .description('禁用范围：仅此模型 = 只禁这条 provider/model；整条渠道 = 该 provider 下所有模型一起禁（密钥失效、网关整体故障时用）'),
})

/**
 * 自动禁用：渠道命中规则后凉一段时间。DSH 核心没有任何熔断/冷却机制
 * （`llm-retry` 的计数在 step/start 就清零，明确是单次请求内），所以这里自己做。
 */
export const breakerSchema = z.object({
  enabled: z.boolean().default(false).description('自动禁用：渠道命中规则后凉一段时间，冷却到了自动放行重试'),
  rules: z.array(breakRuleSchema).default([]),
})

/**
 * 渠道健康监控配置：三档各自独立，用户自己选开哪些。
 *
 * 被动观测不在这张表里：它只是把真实对话的结果折进投影（`health.ts`），零请求、
 * 零 Token、也没有"要不要记录"可决定——一个没有读者的开关只会骗人。
 */
export const healthSchema = z.object({
  discover: discoverSchema.default({}),
  probe: probeSchema.default({}),
  breaker: breakerSchema.default({}),
  timelineBucketSeconds: z.number().step(1).min(60).max(3600).default(DEFAULT_TIMELINE_BUCKET_SECONDS)
    .description('健康时间轴每一格代表多长时间（秒）。格子数固定 24，所以窗口 = 24 × 这一格'),
})

/**
 * 委派名册（P2）：一张工牌 = 一个可以被派出去的角色。
 *
 * 字段、默认值与语义的唯一来源是 docs/design/handoff-proposal.md §5 / §十二；
 * 这里只做落地，不新增含义。三个文本字段三个读者，不许混：
 * `purpose` 编进工具描述只给主模型看，`instructions` 只随派发进子会话，
 * `preset` 是 DSH 原生的系统层人格 + 工具集（不由本插件编写）。
 *
 * `provider`/`model` 留空表示"跟随父会话的模型"；只填一半不是路由，结构校验会拒。
 */
export const rosterEntrySchema = z.object({
  id: z.string().default('').description('稳定标识：工具参数与复核账本按它引用，改名只改显示名'),
  name: z.string().default('').description('显示名；留空时界面显示 id'),
  role: z.union([...HANDOFF_ROLES]).default('work')
    .description('review = 复核者（结论进复核账本，收工闸门读它）；work = 干活的人'),
  purpose: z.string().default('')
    .description('给主模型看的一句话：适合什么、不适合什么。编进工具描述，不进子会话；空则拒绝保存'),
  instructions: z.string().default('')
    .description('给子智能体看的岗位规范（轻量 Markdown，≤4000 字符）。随每次派发进任务前面；不要写密钥'),
  preset: z.string().default('')
    .description('DSH Agent Preset：子会话的系统层人格与工具集，由 DSH 负责；与 instructions 至少一个非空'),
  provider: z.string().default('').description('物理渠道；与路由链同一标识空间。留空 = 跟随父会话'),
  model: z.string().default('').description('模型 ID。留空 = 跟随父会话'),
  reasoningEffort: z.string().default('').description('推理档位（可选，由该渠道的适配器解释）'),
  maxTokens: z.number().step(1).min(0).default(0).description('输出 token 上限（0 = 不指定）'),
  failover: z.string().default(HANDOFF_FAILOVER_INHERIT)
    .description('失败后跟哪条链走：inherit（跟随父会话的绑定）/ none（不降级）/ <链 id>'),
  attach: z.array(z.union([...HANDOFF_ATTACH_ITEMS])).default([...HANDOFF_ATTACH_ITEMS])
    .description('派发时附上的会话事实；只收 goal / todos / userRequest / stats'),
  maxRunsPerUserMessage: z.number().step(1).min(0).default(DEFAULT_HANDOFF_MAX_RUNS_PER_USER_MESSAGE)
    .description('本角色自最近一条用户消息以来的派发上限（0 = 不许派）'),
})

/**
 * 全局委派默认：所有角色共用的一条兜底路由。
 *
 * 两种用法都要成立（2026-10-28 用户要求）：只想全局配一个模型、不想逐角色
 * 配；或者只建角色、模型完全跟随父会话。优先级见 `handoff-tool.ts` 的
 * `agentOptionsOf`：角色自己的路由 → 这里 → 父会话当前实际用的路由。
 * 路由按**整条**选，不做逐字段合并——半条路由不是路由，结构校验会拒；
 * 全空是合法配置（= 跟随父会话）。
 */
export const handoffDelegateDefaultsSchema = z.object({
  provider: z.string().default('').description('物理渠道；留空 = 跟随父会话'),
  model: z.string().default('').description('模型 ID；留空 = 跟随父会话'),
  reasoningEffort: z.string().default('').description('推理档位（可选，由该渠道的适配器解释）'),
  maxTokens: z.number().step(1).min(0).default(0).description('输出 token 上限（0 = 不指定）'),
})

/** 协议：哪几个动作对模型可见（前三项可关；`newSession` 随接力配置）。 */
export const handoffProtocolSchema = z.object({
  delegate: z.boolean().default(true).description('允许 delegate（派人）'),
  finish: z.boolean().default(true).description('允许 finish（收工回执）'),
  facts: z.boolean().default(true).description('允许 facts（看可数事实）'),
  requireReviewFor: z.array(z.union([...HANDOFF_OUTCOMES])).default([])
    .description('这些收工落点必须引用一次通过的复核回执；空 = 不强制'),
  allowReviewOverride: z.boolean().default(true)
    .description('允许模型写明理由跳过复核；理由进账，界面上看得见'),
})

/** 闸门：三个时间尺度 + 追问。每个数字都是"最多"，不是"必须"。 */
export const handoffLimitsSchema = z.object({
  maxDelegationsPerTurn: z.number().step(1).min(0).default(DEFAULT_HANDOFF_LIMITS.maxDelegationsPerTurn)
    .description('一个回合内最多派几次（防同轮爆发）'),
  maxDelegationsPerUserMessage: z.number().step(1).min(0).default(DEFAULT_HANDOFF_LIMITS.maxDelegationsPerUserMessage)
    .description('自最近一条用户消息以来最多派几次（复核也计入）；人一说话就清零'),
  maxReviewsPerUserMessage: z.number().step(1).min(0).default(DEFAULT_HANDOFF_LIMITS.maxReviewsPerUserMessage)
    .description('复核上限，不是配额：第一次就通过就收工'),
  maxNewSessionsPerUserMessage: z.number().step(1).min(0).default(DEFAULT_HANDOFF_LIMITS.maxNewSessionsPerUserMessage)
    .description('开新会话上限；随会话复制，不因开新会话而重置'),
  nudgeWhenUnreceipted: z.boolean().default(DEFAULT_HANDOFF_LIMITS.nudgeWhenUnreceipted)
    .description('没交回执就停时追问一次（会触发一次真实模型调用）'),
  maxNudgesPerTurn: z.number().step(1).min(0).default(DEFAULT_HANDOFF_LIMITS.maxNudgesPerTurn)
    .description('每回合最多追问几次；到顶就放行停止'),
})

/** 没签字就停时的兜底：默认只报告，不自动派。 */
export const handoffUnreceiptedSchema = z.object({
  delegateTo: z.string().default('')
    .description('空 = 只报告；填名册 id = 自动派它兜底（花一次真实调用）'),
  reportToUser: z.boolean().default(true).description('写一条中文 notice 说明剩余项与停在哪'),
})

/** 接力：收工后要不要换一个干净会话继续（默认不换）。 */
export const handoffNewSessionSchema = z.object({
  onFinish: z.array(z.union([...HANDOFF_OUTCOMES])).default([])
    .description('这些收工落点之后自动开新会话；空 = 不自动，模型想换场时自己调 newSession'),
  nextAction: z.union([...HANDOFF_NEXT_ACTIONS]).default('continue')
    .description('新会话的"下一步类型"：接着干 / 先复核 / 复核完再接着干'),
  briefing: z.array(z.union([...HANDOFF_BRIEFING_ITEMS])).default([...HANDOFF_BRIEFING_ITEMS])
    .description('接力简报附上的工件：goal / todos / userRequest / lastReview / stats'),
  keepGoal: z.boolean().default(true).description('新会话里按原 objective 重建 goal'),
  carrySelection: z.boolean().default(true).description('主模型不变：把本会话选中的模型带过去'),
  carryChainBinding: z.boolean().default(true).description('链绑定与预算计数跟过去（不因开新会话重置）'),
  // 新会话收到的第一条消息：模板可改，默认就是发布时的措辞。
  // 占位符替换规则在 ../handoff.ts 的 renderHandoffPrompt：一行里的占位符换成空，
  // 整行删掉——所以 `{report}` 没写时不会剩一个空标题。
  promptTemplate: z.string().max(HANDOFF_PROMPT_TEMPLATE_MAX).default(DEFAULT_HANDOFF_PROMPT_TEMPLATE)
    .description('新会话收到的第一条消息模板。占位符：{reason} {nextAction} {extra} {note} {report} {artifacts}；必须含 {note}'),
  promptExtra: z.string().max(HANDOFF_PROMPT_EXTRA_MAX).default('')
    .description('每次接力都带过去的一段固定要求（如审查口径）；空 = 不出现这一行。它是配置，不依赖模型记'),
})

/** 委派名册整段：总闸 + 名册 + 协议 + 闸门 + 兜底 + 接力。 */
export const handoffSchema = z.object({
  enabled: z.boolean().default(false)
    .description('交接总闸：关着时零注册（工具不出现、名册不生效），路由照旧'),
  subagentBackend: z.string().default(DEFAULT_HANDOFF_SUBAGENT_BACKEND)
    .description('派发后端（DSH subagent provider 名，不是模型渠道）'),
  roster: z.array(rosterEntrySchema).default([]),
  delegateDefaults: handoffDelegateDefaultsSchema.default({}),
  protocol: handoffProtocolSchema.default({}),
  limits: handoffLimitsSchema.default({}),
  onUnreceiptedStop: handoffUnreceiptedSchema.default({}),
  newSession: handoffNewSessionSchema.default({}),
})

const ingressSchema = z.object({
  enabled: z.boolean().default(false),
  repository: z.string().default(''),
  baseUrl: z.string().default('')
    .description('GitHub API 根地址。空 = api.github.com；填本机地址是为了企业版与测试，不改变读什么'),
  agentLogin: z.string().default(''),
  allowed: z.array(z.string()).default([]),
  bots: z.array(z.string()).default([]),
  acceptMode: z.union(['off', 'observe', 'auto']).default('off'),
  pollSeconds: z.number().step(1).min(5).max(3_600).default(DEFAULT_INGRESS_POLL_SECONDS),
  workdir: z.string().default('')
    .description('worker 会话在哪个目录里干活。空 = DSH 进程自己的工作目录；指向仓库副本时，worker 改的是那一份'),
})

/** Plugin Config. Every field is volatile: all of them reach the settings form. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile()
    .description('接管总闸：关闭时所有模型绕过插件，直接走官方适配器。默认关——接管会改请求实际打到的渠道，必须由用户显式打开'),
  // `chains` 故意不写 `.default()`：这个字段的"有没有"就是"是不是旧形状"。
  // 但 schemastery 会给任何 array 盖默认值 `[]`，所以真正判形状的是
  // `chain.ts` 的 effectiveChains，读的是**原始配置里这个键是否存在**
  // （`chains: []` 也算新形状，只是它里面那条链是空的），而不是校验后的值。
  chains: z.array(namedChainSchema).volatile()
    .description('命名链：每条链是一套完整的降级顺序；会话可以绑定到其中一条'),
  defaultChainId: z.string().default(DEFAULT_CHAIN_ID).volatile()
    .description('没有绑定（或绑定指向已删除的链）的会话走哪条链'),
  chain: chainSchema.default({}).volatile()
    .description('旧形状：唯一的全局链。只在新形状缺失时读取，首次保存后会被移除'),
  health: healthSchema.default({}).volatile()
    .description('渠道健康监控：连通性检查、发送测试消息、自动禁用三档；被动观测始终在（它只是折真实对话的结果）'),
  handoff: handoffSchema.default({}).volatile()
    .description('委派名册：一个 handoff 工具（派人 / 收工 / 开新会话 / 看事实）+ 名册 + 闸门 + 接力。默认关'),
  ingress: ingressSchema.default({}).volatile()
    .description('入口：盯一个 GitHub 仓库的 issue，把被授权的要求变成 Case。令牌读环境变量 GITHUB_TOKEN，不存配置。默认关'),
  // 策略版本：v2 = "失败默认全切"。旧配置里 emptyResponse/invalidRequest 被写成了
  // false（那是当时的默认值，不是用户的选择），只改 schema 默认值救不了它们；
  // chain.ts 按这个标记做一次性改写，第一次保存后落盘为当前版本。
  policyVersion: z.number().default(0).volatile()
    .description('失败策略版本；由插件自己维护，不用手动改'),
})

/**
 * Hand-written value types. Schemastery has no type inference (`z.infer` does
 * not exist), so the DSH pattern (see llm-pi-ai's config.ts) is three
 * declarations sharing one name space split: the value interfaces, a `Config`
 * interface whose fields are `Volatile<T>` accessors for `apply`, and the
 * schema value. Cordis freezes config values at runtime, which is what makes
 * the stored snapshots safe to share without defensive copies.
 */

import type { Volatile } from '@deepseek-ai/cordis'

/** One physical candidate. Credentials stay owned by the provider adapter. */
export interface Candidate {
  provider: string
  model: string
  /** Retries AFTER the first call; the step core works in call counts (`maxRetries + 1`). */
  maxRetries: number
  /** Only read by the `weight` strategy. */
  weight: number
  needs?: { images?: boolean; minContextTokens?: number }
}

/**
 * Which failures move to the next candidate.
 *
 * 八个具名码之外的一切失败码由 `other` 决定（默认 true）。每一格取消勾选的含义
 * 是"这个码交给 DSH 自己收尾"——插件既不重试也不切换它。
 */
export interface SwitchOn {
  rateLimit: boolean
  server: boolean
  timeout: boolean
  transport: boolean
  emptyResponse: boolean
  invalidRequest: boolean
  auth: boolean
  quota: boolean
  /** 表里没有的码共用的开关；未知不是"不该动"的理由。 */
  other: boolean
}

/** 输出被截断（max-tokens）时的处理。 */
export interface MaxTokenPolicy {
  /** 自动补一句「继续」，而不是停下等用户手动发。 */
  autoContinue: boolean
  /** 同一个候选上一轮最多自动续几次；用完还截断就换下一条候选。 */
  continues: number
}

// The `@typert` tag below marks this interface as the package's host-face
// surface: the generator emits a contribution only for a package whose
// reachable sources carry a marked declaration
// (packages/typert/generator/src/analyzer.ts:2775-2808), and `ChainConfig` is
// the plugin's central business type. Why this type, and which alternatives were
// rejected, are recorded in
// .agents/notes/implemented/2026-10-15-out-of-tree-build-pipeline.md
/** The one global fallback chain; the first hop is the user's own selection.
 *
 * @typert
 */
export interface ChainConfig {
  candidates: Candidate[]
  /** The first hop's own condition (`needs` shape); absent = unconstrained. */
  primaryNeeds?: { images?: boolean; minContextTokens?: number }
  switchOn: SwitchOn
  /**
   * 不重试、直接切下一条候选的失败键，按 `switchOn` 的键名书写。
   *
   * 类型是 `string[]` 而不是键的联合：这个数组是用户数据，拼错的键要在结构校验里
   * 被点名拒绝（`rules.ts`），而不是在读取时被悄悄过滤成"没写"。
   */
  immediateSwitch: string[]
  stickyTurns: number
  strategy: Strategy
  /** Retries AFTER the first hop's first call; the step core converts to calls. */
  firstHopMaxRetries: number
  /** 输出被截断时怎么办：续几次、用完是否换候选。 */
  maxTokens: MaxTokenPolicy
}

/**
 * One named chain: the same fields plus the identity a session binds to.
 *
 * `id` is the immutable reference key (rename only touches `name`); an empty
 * `name` means "the default chain" and is labelled by the dictionary, so a
 * migrated config never hard-codes a Chinese name into YAML.
 */
export interface NamedChain extends ChainConfig {
  id: string
  name: string
}

/** "敲门"档配置：要一份模型清单，不生成内容。 */
export interface DiscoverConfig {
  enabled: boolean
  intervalSeconds: number
}

/** "真探测"档配置：真的发一条最小消息，唯一能证明模型能出字。 */
export interface ProbeConfig {
  enabled: boolean
  intervalSeconds: number
  prompt: string
  prompts: { route: string; prompt: string }[]
  timeoutSeconds: number
}

/** 渠道健康监控配置：三档各自独立。 */
export interface HealthConfig {
  discover: DiscoverConfig
  probe: ProbeConfig
  breaker: BreakerConfig
  /** One timeline bar's width, in seconds. The window is 24 × this. */
  timelineBucketSeconds: number
}

/** 一条自动禁用规则。 */
export interface BreakRule {
  code: string
  message: string
  cooldownSeconds: number
  /**
   * `route`（默认）只禁这一条 provider/model；`channel` 把该 provider 下所有模型
   * 一起禁。区分来自实测：同一个网关渠道里模型各坏各的（按路由禁才不会埋掉好
   * 模型），而密钥失效、网关整体故障是按渠道坏的（只禁一个模型，链上会把同渠道
   * 其余模型各真打一次才跨渠道，白白吃掉 attempt 预算）。哪种码属于哪种，provider
   * 之间没有共识，所以由用户在规则上显式声明，不猜。
   */
  scope: BreakerScope
}

/** 熔断作用域：禁一条路由，还是禁整条 provider 渠道。 */
export type BreakerScope = 'route' | 'channel'

/** 自动禁用配置。 */
export interface BreakerConfig {
  enabled: boolean
  rules: BreakRule[]
}

/**
 * 一张工牌：用户配，模型选。
 *
 * 三个文本字段三个读者（提案 §4.1）：`purpose` 只进工具描述（主模型），
 * `instructions` 只进派发消息（子智能体），`preset` 是 DSH 原生的系统层人格。
 * 一个字段只有一个读者，谁也不复用对方的话。
 */
export interface RosterEntry {
  id: string
  name: string
  role: HandoffRole
  purpose: string
  instructions: string
  preset: string
  provider: string
  model: string
  reasoningEffort: string
  maxTokens: number
  /** `inherit` | `none` | a chain id. */
  failover: string
  attach: HandoffAttachItem[]
  maxRunsPerUserMessage: number
}

/** 名册角色：复核者（结论进复核账本）还是工作者。 */
export type HandoffRole = 'review' | 'work'

/** `delegate` 能采的会话事实。 */
export type HandoffAttachItem = 'goal' | 'todos' | 'userRequest' | 'stats'

/** 接力简报能采的项：`delegate` 的词表之外多一条 `lastReview`。 */
export type HandoffBriefingItem = HandoffAttachItem | 'lastReview'

/** 收工回执的三种落点。 */
export type HandoffOutcome = 'done' | 'needs_user' | 'abandoned'

/** 接力首条消息的"下一步类型"。 */
export type HandoffNextAction = 'continue' | 'review' | 'review-then-continue'

/** 哪几个动作对模型可见，以及收工闸门。 */
export interface HandoffProtocolConfig {
  delegate: boolean
  finish: boolean
  facts: boolean
  /** 这些收工落点必须引用一次通过的复核回执；空 = 不强制。 */
  requireReviewFor: HandoffOutcome[]
  /** 允许模型写明理由跳过复核。 */
  allowReviewOverride: boolean
}

/** 闸门：三个时间尺度 + 追问。 */
export interface HandoffLimitsConfig {
  maxDelegationsPerTurn: number
  maxDelegationsPerUserMessage: number
  maxReviewsPerUserMessage: number
  maxNewSessionsPerUserMessage: number
  nudgeWhenUnreceipted: boolean
  maxNudgesPerTurn: number
}

/** 没签字就停时的兜底。 */
export interface HandoffUnreceiptedConfig {
  delegateTo: string
  reportToUser: boolean
}

/** 接力：收工后要不要换一个干净会话继续。 */
export interface HandoffNewSessionConfig {
  onFinish: HandoffOutcome[]
  nextAction: HandoffNextAction
  briefing: HandoffBriefingItem[]
  keepGoal: boolean
  carrySelection: boolean
  carryChainBinding: boolean
  /** 新会话第一条消息的模板；占位符见 `HANDOFF_PROMPT_PLACEHOLDERS`。 */
  promptTemplate: string
  /** 每次接力都带的一段固定要求；空 = 不出现这一行。 */
  promptExtra: string
}

/** 全局委派默认：角色没写模型时用的那一条路由；全空 = 跟随父会话。 */
export interface HandoffDelegateDefaults {
  provider: string
  model: string
  reasoningEffort: string
  maxTokens: number
}

/** 委派名册整段。 */
export interface HandoffConfig {
  enabled: boolean
  subagentBackend: string
  roster: RosterEntry[]
  delegateDefaults: HandoffDelegateDefaults
  protocol: HandoffProtocolConfig
  limits: HandoffLimitsConfig
  onUnreceiptedStop: HandoffUnreceiptedConfig
  newSession: HandoffNewSessionConfig
}

/**
 * 入口：盯一个 GitHub 仓库的 issue，把被授权的要求变成 Case。
 *
 * 没有 token 字段：访问令牌从环境变量 `GITHUB_TOKEN` 读（见 `INGRESS_TOKEN_ENV`）。
 * 配置会落进 profile 的 `cordis.patch.yml`，把一个长期令牌写在那儿等于把它提交进
 * 配置仓库，也会出现在每次打印配置的日志里。
 */
export interface IngressConfig {
  enabled: boolean
  /** `owner/name`。空 = 没配置。 */
  repository: string
  /** GitHub API 根地址。空 = `https://api.github.com`。 */
  baseUrl: string
  /** agent 自己的 GitHub 登录名；只认提到它的消息，以及指派给它的 issue。 */
  agentLogin: string
  /** 可以派活的人，按 GitHub 登录名。 */
  allowed: string[]
  /** 可以产生候选的机器人。 */
  bots: string[]
  acceptMode: 'off' | 'observe' | 'auto'
  pollSeconds: number
  /** worker 会话的工作目录。空 = 进程自己的工作目录。 */
  workdir: string
}


/** Plugin configuration as `apply` sees it: every field is a Volatile accessor. */
export interface Config {
  enabled: Volatile<boolean>
  /** Absent (an undefined value, not an empty array) in a config written by an older build. */
  chains: Volatile<NamedChain[] | undefined>
  defaultChainId: Volatile<string>
  /** The legacy single chain; read only while `chains` is absent. */
  chain: Volatile<ChainConfig>
  health: Volatile<HealthConfig>
  /** 委派名册：字段与默认值的唯一来源是 docs/design/handoff-proposal.md §5/§十二。 */
  handoff: Volatile<HandoffConfig>
  /** 入口：字段与默认值的唯一来源是 docs/design/super-plugin.md 七节。 */
  ingress: Volatile<IngressConfig>
  /** 失败策略版本：见 {@link POLICY_VERSION}。 */
  policyVersion: Volatile<number>
}

/** The plain config value shape, for validating a hot update before it applies. */
export type RouterOptions = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never }

/**
 * Structural CROSS-FIELD validation, run before a config update restarts the
 * plugin fiber. Single-field bounds (a negative number, an empty string) are
 * the schema's job — both production code paths run the schema first, so a
 * guard repeated here is dead code that only starts lying when the schema
 * tightens. What is left is what no single field can know: a repeated route in
 * the chain, a weight strategy with nothing to draw, a breaker rule that
 * matches nothing.
 *
 * Note: 为何删掉 8 个数值 guard（实测全被 schema 挡在前面）—— 见
 * .agents/notes/implemented/2026-10-17-finish-the-shared-modules.md；
 * 为何跨字段规则与浏览器半包同源（被否的「两边各留 + 对账测试」方案）—— 见
 * .agents/notes/implemented/2026-10-17-policy-into-the-decision-core.md
 *
 * The rules themselves live once in ./rules.ts, shared with the browser half
 * (which formats every violation instead of throwing the first); this
 * function is the host's rendering.
 *
 * Deliberately narrow: only errors that are wrong in every environment. A
 * candidate whose provider is not registered is environmental drift (the user
 * may uninstall a provider later), so it degrades to a warning instead of
 * failing the whole plugin — see .agents/notes and
 * docs/design/product-plan.md section 9.
 */
export function assertStructural(config: {
  chains: NamedChain[]
  defaultChainId: string
  health?: HealthConfig
  handoff?: HandoffConfig
}): void {
  const [first] = structuralViolations(config)
  if (first !== undefined) throw new Error(first.message)
}
