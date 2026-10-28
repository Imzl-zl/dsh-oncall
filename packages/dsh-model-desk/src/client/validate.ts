/** Config defaults, legacy normalization, draft-shape checks, and the browser rendering of the shared cross-field rules. */

import { clone } from './format.ts'
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
  DEFAULT_HANDOFF_SUBAGENT_BACKEND,
  DEFAULT_IMMEDIATE_SWITCH,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_TOKEN_AUTO_CONTINUE,
  DEFAULT_MAX_TOKEN_CONTINUES,
  DEFAULT_PROBE_PROMPT,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  DEFAULT_STICKY_TURNS,
  DEFAULT_STRATEGY,
  DEFAULT_SWITCH_ON,
  DEFAULT_TIMELINE_BUCKET_SECONDS,
  HANDOFF_ATTACH_ITEMS,
  HANDOFF_BRIEFING_ITEMS,
  HANDOFF_FAILOVER_INHERIT,
  HANDOFF_NEXT_ACTIONS,
  HANDOFF_ROLES,
  MAX_RETRIES,
  MAX_SESSION_RETRIES,
  MAX_TOKEN_CONTINUES,
} from '../defaults.ts'
import { structuralViolations } from '../rules.ts'


// 熔断码预设：秒数是数据，descKey 是字典键——文案一律进 locales.ts（中英各一份），
// 模块里不留手写中文（I9 的教训：在飞改动把字典键换成硬编码中文，英文用户永远看不到）。
export var BREAKER_CODE_PRESETS = [
  { code: 'RATE_LIMIT', descKey: 'breakerPresetRateLimit', seconds: 60 },
  { code: 'SERVER', descKey: 'breakerPresetServer', seconds: 300 },
  { code: 'TIMEOUT', descKey: 'breakerPresetTimeout', seconds: 300 },
  { code: 'TRANSPORT', descKey: 'breakerPresetTransport', seconds: 300 },
  { code: 'AUTH', descKey: 'breakerPresetAuth', seconds: 3600 },
  { code: 'QUOTA', descKey: 'breakerPresetQuota', seconds: 7200 },
]


export function defaultSwitchOn() {
  // 与 host 的 switchOnSchema 默认值同源（../defaults.ts 的 DEFAULT_SWITCH_ON）：
  // 两边各写一份就会漂移，而漂移的表现是"UI 说开着、host 说关着"。
  return Object.assign({}, DEFAULT_SWITCH_ON)
}

/** 截断策略的默认值，与 host 的 `chain.ts` 同源。 */
export function defaultMaxTokens() {
  return { autoContinue: DEFAULT_MAX_TOKEN_AUTO_CONTINUE, continues: DEFAULT_MAX_TOKEN_CONTINUES }
}

/** A chain with no fallbacks: what a fresh draft, and a legacy record, start from. */
export function defaultChainValue() {
  return {
    candidates: [],
    switchOn: defaultSwitchOn(),
    immediateSwitch: [...DEFAULT_IMMEDIATE_SWITCH],
    stickyTurns: DEFAULT_STICKY_TURNS,
    strategy: DEFAULT_STRATEGY,
    firstHopMaxRetries: DEFAULT_FIRST_HOP_MAX_RETRIES,
    maxTokens: defaultMaxTokens(),
  }
}

export function normalizeChain(value) {
  var chain = clone(value ?? defaultChainValue())
  if (!Array.isArray(chain.candidates)) chain.candidates = []
  if (typeof chain.stickyTurns !== 'number' || chain.stickyTurns < 0) chain.stickyTurns = DEFAULT_STICKY_TURNS
  // effectiveChain already speaks retries; this only covers a draft built by hand
  // (a new row, a fixture), where a missing field would render as NaN in the stepper.
  chain.candidates = chain.candidates.map(function (candidate) {
    return typeof candidate.maxRetries === 'number'
      ? candidate
      : Object.assign({}, candidate, { maxRetries: DEFAULT_MAX_RETRIES })
  })
  if (typeof chain.firstHopMaxRetries !== 'number') chain.firstHopMaxRetries = DEFAULT_FIRST_HOP_MAX_RETRIES
  // 2026-10-23 才有的字段：旧草稿/旧记录没有它，补成与宿主同一份默认名单
  // （两边都读 ../defaults.ts）。拼错的键不在这里过滤——结构校验会点名拒绝。
  chain.immediateSwitch = Array.isArray(chain.immediateSwitch)
    ? chain.immediateSwitch.slice()
    : [...DEFAULT_IMMEDIATE_SWITCH]
  // 旧配置没有这一节：缺字段会渲染成空步进器，所以在这里补齐，与 host 同源。
  var maxTokens = chain.maxTokens && typeof chain.maxTokens === 'object' ? chain.maxTokens : {}
  chain.maxTokens = {
    autoContinue: typeof maxTokens.autoContinue === 'boolean' ? maxTokens.autoContinue : DEFAULT_MAX_TOKEN_AUTO_CONTINUE,
    continues: typeof maxTokens.continues === 'number'
      ? Math.max(0, Math.min(MAX_TOKEN_CONTINUES, Math.round(maxTokens.continues)))
      : DEFAULT_MAX_TOKEN_CONTINUES,
  }
  return chain
}

/** One named chain: the chain fields plus the identity a session binds to. */
export function normalizeNamedChain(value) {
  var chain = normalizeChain(value)
  // id 留空的草稿不能被当成"没有 id"：会话绑定按 id 引用，一个空 id 会让两条链
  // 无法区分。缺省时给默认链的 id，与迁移产物的 id 同一个来源。
  var id = typeof value?.id === 'string' && value.id !== '' ? value.id : DEFAULT_CHAIN_ID
  var name = typeof value?.name === 'string' ? value.name : ''
  return Object.assign(chain, { id: id, name: name })
}


/**
 * 一个重试输入框的文字 → 该存什么。
 *
 * 空 = 跟随链（不是 0）；0 是"这条路由不重试"的真实选择；0..MAX_SESSION_RETRIES 之外
 * 一律 invalid——调用方显示上限，不夹值。chip 的弹层与「会话路由」页签共用这一处判断。
 */
export function parseRetryInput(raw) {
  var text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (text === '') return { kind: 'follow' }
  var value = Number(text)
  if (!Number.isInteger(value) || value < 0 || value > MAX_SESSION_RETRIES) return { kind: 'invalid' }
  return { kind: 'set', value: value }
}


/**
 * One row of the page's problem list: the dictionary key to format plus its
 * placeholders. It is the browser's half of `Violation` (../rules.ts:30) — the
 * same `key`/`vars`, without the host's `message` text, which the browser never
 * renders. Declared here because this is where the list is built; every reader
 * (page.ts, roster.ts) only reads the two fields.
 */
export interface Problem {
  key: string
  vars: Record<string, string | number>
}

export function validate(draft) {
  var problems: Problem[] = []
  // 跨字段规则与 host 同源（../rules.ts 的 structuralViolations）：host 抛第一条、
  // 这里收全部，key + vars 进字典渲染。此前两份规则靠三句「与 host 的 assertStructural
  // 同步」的注释对齐，且已经漂移——重复渠道 host 从第一天就拒、浏览器漏检，用户存得下
  // 一个加载即被 host 拒绝的配置，吃的还是一句英文错误。
  structuralViolations({
    chains: draft.chains,
    defaultChainId: draft.defaultChainId,
    health: draft.health,
    handoff: draft.handoff,
  }).forEach(function (violation) {
    problems.push({ key: violation.key, vars: violation.vars })
  })
  // 草稿态检查：host 故意不做单字段边界（schema 拥有它们，assertStructural 的
  // docstring 划了这条线），浏览器要在保存前挡住，否则用户吃到的是 host 的英文拒绝。
  // 逐条链检查：界面上每个候选都属于"它所在的那条链"，编号也从那条链算。
  draft.chains.forEach(function (chain, chainIndex) {
    chain.candidates.forEach(function (candidate, index) {
      if (!candidate.provider || !candidate.model) problems.push({ key: 'problemEmptyRoute', vars: { chain: chainIndex + 1, index: index + 1 } })
      if (!(candidate.maxRetries >= 0 && candidate.maxRetries <= MAX_RETRIES)) problems.push({ key: 'problemBadMaxRetries', vars: { chain: chainIndex + 1, index: index + 1 } })
    })
    if (!(chain.firstHopMaxRetries >= 0 && chain.firstHopMaxRetries <= MAX_RETRIES)) problems.push({ key: 'problemBadFirstHopRetries', vars: { chain: chainIndex + 1 } })
  })
  // 名册的数值边界与 host schema 同源（../defaults.ts 的 HANDOFF 常量）：结构规则
  // 管"跨字段/语义"，这里只管单字段范围，和候选重试次数同一条分工。
  if (draft.handoff) {
    draft.handoff.roster.forEach(function (entry, index) {
      if (!(entry.maxRunsPerUserMessage >= 0)) {
        problems.push({ key: 'problemRosterBadRuns', vars: { index: index + 1 } })
      }
      if (!(entry.maxTokens >= 0)) {
        problems.push({ key: 'problemRosterBadTokens', vars: { index: index + 1 } })
      }
    })
  }
  return problems
}

/**
 * The handoff section as the editor needs it.
 *
 * Every default here comes from `../defaults.ts`, the same constants the host
 * schema uses (proposal §十二 is the design source; this module never re-types
 * a number the host also owns). A config written by an older build has no
 * `handoff` key at all, and that must read as "the section's defaults", not as
 * "the user turned everything off".
 */
export function normalizeHandoff(value) {
  var handoff = value && typeof value === 'object' ? value : {}
  var protocol = handoff.protocol && typeof handoff.protocol === 'object' ? handoff.protocol : {}
  var limits = handoff.limits && typeof handoff.limits === 'object' ? handoff.limits : {}
  var stop = handoff.onUnreceiptedStop && typeof handoff.onUnreceiptedStop === 'object' ? handoff.onUnreceiptedStop : {}
  var newSession = handoff.newSession && typeof handoff.newSession === 'object' ? handoff.newSession : {}
  return {
    enabled: handoff.enabled === true,
    subagentBackend: typeof handoff.subagentBackend === 'string' && handoff.subagentBackend !== ''
      ? handoff.subagentBackend
      : DEFAULT_HANDOFF_SUBAGENT_BACKEND,
    roster: Array.isArray(handoff.roster) ? handoff.roster.map(normalizeRosterEntry) : [],
    protocol: {
      delegate: protocol.delegate !== false,
      finish: protocol.finish !== false,
      facts: protocol.facts !== false,
      requireReviewFor: Array.isArray(protocol.requireReviewFor) ? protocol.requireReviewFor.slice() : [],
      allowReviewOverride: protocol.allowReviewOverride !== false,
    },
    limits: {
      maxDelegationsPerTurn: numberOr(limits.maxDelegationsPerTurn, DEFAULT_HANDOFF_LIMITS.maxDelegationsPerTurn),
      maxDelegationsPerUserMessage: numberOr(limits.maxDelegationsPerUserMessage, DEFAULT_HANDOFF_LIMITS.maxDelegationsPerUserMessage),
      maxReviewsPerUserMessage: numberOr(limits.maxReviewsPerUserMessage, DEFAULT_HANDOFF_LIMITS.maxReviewsPerUserMessage),
      maxNewSessionsPerUserMessage: numberOr(limits.maxNewSessionsPerUserMessage, DEFAULT_HANDOFF_LIMITS.maxNewSessionsPerUserMessage),
      nudgeWhenUnreceipted: limits.nudgeWhenUnreceipted === true,
      maxNudgesPerTurn: numberOr(limits.maxNudgesPerTurn, DEFAULT_HANDOFF_LIMITS.maxNudgesPerTurn),
    },
    onUnreceiptedStop: {
      delegateTo: typeof stop.delegateTo === 'string' ? stop.delegateTo : '',
      reportToUser: stop.reportToUser !== false,
    },
    newSession: {
      onFinish: Array.isArray(newSession.onFinish) ? newSession.onFinish.slice() : [],
      nextAction: HANDOFF_NEXT_ACTIONS.indexOf(newSession.nextAction) >= 0 ? newSession.nextAction : 'continue',
      briefing: Array.isArray(newSession.briefing) ? newSession.briefing.slice() : HANDOFF_BRIEFING_ITEMS.slice(),
      keepGoal: newSession.keepGoal !== false,
      carrySelection: newSession.carrySelection !== false,
      carryChainBinding: newSession.carryChainBinding !== false,
    },
  }
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback
}

/**
 * Whole number inside a bound the host schema also enforces.
 *
 * The bounds are the constants in `../defaults.ts`, so the form and the schema
 * cannot drift: a drift is exactly what made a save fail forever with "保存失败"
 * and no field named.
 */
export function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** One roster row: every field the schema declares, with the same defaults. */
function normalizeRosterEntry(value) {
  var entry = value && typeof value === 'object' ? value : {}
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    role: HANDOFF_ROLES.indexOf(entry.role) >= 0 ? entry.role : 'work',
    purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
    instructions: typeof entry.instructions === 'string' ? entry.instructions : '',
    preset: typeof entry.preset === 'string' ? entry.preset : '',
    provider: typeof entry.provider === 'string' ? entry.provider : '',
    model: typeof entry.model === 'string' ? entry.model : '',
    reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : '',
    maxTokens: numberOr(entry.maxTokens, 0),
    failover: typeof entry.failover === 'string' && entry.failover !== '' ? entry.failover : HANDOFF_FAILOVER_INHERIT,
    attach: Array.isArray(entry.attach) ? entry.attach.filter(function (item) { return HANDOFF_ATTACH_ITEMS.indexOf(item) >= 0 }) : HANDOFF_ATTACH_ITEMS.slice(),
    maxRunsPerUserMessage: numberOr(entry.maxRunsPerUserMessage, DEFAULT_HANDOFF_MAX_RUNS_PER_USER_MESSAGE),
  }
}


export function normalizeHealth(value) {
  var health = value || {}
  var discover = health.discover || {}
  var probe = health.probe || {}
  var breaker = health.breaker || {}
  // 旧字段是分钟，新字段是秒；只在没有新字段时采用，避免覆盖已迁移的值。
  var legacyMinutes = typeof health.intervalMinutes === 'number' ? health.intervalMinutes : undefined
  // 读入即夹到 schema 的边界内：越界值只可能来自旧配置或手写配置，留着它会让
  // 这个表单把一个宿主要拒绝的值原样再存一次。
  var discoverSeconds = clampInt(
    typeof discover.intervalSeconds === 'number'
      ? discover.intervalSeconds
      : legacyMinutes !== undefined ? legacyMinutes * 60 : DEFAULT_INTERVAL_SECONDS,
    0, HEALTH_INTERVAL_MAX_SECONDS,
  )
  var probeSeconds = clampInt(
    typeof probe.intervalSeconds === 'number'
      ? probe.intervalSeconds
      : legacyMinutes !== undefined ? legacyMinutes * 60 : DEFAULT_INTERVAL_SECONDS,
    0, HEALTH_INTERVAL_MAX_SECONDS,
  )
  // 时间轴桶长：旧配置没有这个字段，取默认值（../defaults.ts 与 host schema 同源）。
  var bucketSeconds = typeof health.timelineBucketSeconds === 'number'
    ? health.timelineBucketSeconds
    : DEFAULT_TIMELINE_BUCKET_SECONDS
  return {
    discover: {
      enabled: discover.enabled === true,
      intervalSeconds: discoverSeconds,
    },
    probe: {
      enabled: probe.enabled === true,
      intervalSeconds: probeSeconds,
      prompt: typeof probe.prompt === 'string' && probe.prompt ? probe.prompt : DEFAULT_PROBE_PROMPT,
      prompts: Array.isArray(probe.prompts) ? probe.prompts.slice() : [],
      timeoutSeconds: clampInt(
        typeof probe.timeoutSeconds === 'number' ? probe.timeoutSeconds : DEFAULT_PROBE_TIMEOUT_SECONDS,
        PROBE_TIMEOUT_MIN_SECONDS, PROBE_TIMEOUT_MAX_SECONDS,
      ),
    },
    breaker: {
      enabled: breaker.enabled === true,
      rules: Array.isArray(breaker.rules) ? breaker.rules.map(function (rule) {
        return {
          code: typeof rule.code === 'string' ? rule.code : '',
          message: typeof rule.message === 'string' ? rule.message : '',
          cooldownSeconds: clampInt(
            typeof rule.cooldownSeconds === 'number' ? rule.cooldownSeconds : DEFAULT_BREAKER_COOLDOWN_SECONDS,
            BREAKER_COOLDOWN_MIN_SECONDS, BREAKER_COOLDOWN_MAX_SECONDS,
          ),
          // 旧配置没有这一字段；host schema 的默认值是 route，这里必须填成同一个，
          // 否则 UI 显示与 host 执行会是两个意思。
          scope: rule.scope === 'channel' ? 'channel' : DEFAULT_BREAKER_SCOPE,
        }
      }) : [],
    },
    timelineBucketSeconds: bucketSeconds,
  }
}
