#!/usr/bin/env node
/**
 * Unit tests for the pure routing decisions.
 *
 * The plugin's decision modules are erasable TypeScript, so Node's built-in
 * type stripping imports them directly — no build step, no mocked Cordis
 * context. What these cover is the logic the Loader composition tests exercise
 * only through one deterministic path (minContextTokens); the rest is here.
 *
 * Usage: node packages/dsh-model-desk/tests/unit.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideAfterInner,
  decideBeforeInner,
  decideRecovery,
  hasImageContent,
  isSwitchOnEligible,
  planFire,
  resolveChain,
  resolveStartIndex,
  rotate,
  startStep,
  switchesImmediately,
  toolResultHasImage,
  unmetCondition,
} from '../src/router.ts'
import { failoverHistoryProjection, failureCodeOfStream, FAILOVER_HISTORY_KEY, MAX_ENTRIES } from '../src/lineage.ts'
import { breakerNotice } from '../src/notice.ts'
import { assertStructural } from '../src/config.ts'
import { structuralViolations } from '../src/rules.ts'
import {
  BREAKER_COOLDOWN_MIN_SECONDS,
  DEFAULT_IMMEDIATE_SWITCH,
  DEFAULT_SWITCH_ON,
  HEALTH_INTERVAL_MAX_SECONDS,
  MAX_TOKEN_CONTINUES,
  POLICY_VERSION,
  PROBE_TIMEOUT_MIN_SECONDS,
  SWITCH_ON_CODES,
  switchOnKeyOf,
} from '../src/defaults.ts'
import { defaultSwitchOn, normalizeHandoff, normalizeHealth, parseRetryInput, validate, BREAKER_CODE_PRESETS } from '../src/client/validate.ts'
import { deepEqual, fill, saveShortcutKeyKey } from '../src/client/format.ts'
import { routeNames } from '../src/client/naming.ts'
import { checkForUpdate, compareVersions } from '../src/update.ts'
import { en, zh } from '../src/client/locales.ts'
import { emptyConditions, RouterState } from '../src/state.ts'
import { probePromptFor, probeRoute } from '../src/probe.ts'
import { checkConnectivity } from '../src/connectivity.ts'
import { routeParts } from '../src/routes.ts'
import { healthChannels } from '../src/client/health-channels.ts'
import { precheckTierOf } from '../src/precheck.ts'
import { DEFAULT_HANDOFF_PROMPT_TEMPLATE, HANDOFF_PROMPT_PLACEHOLDERS } from '../src/defaults.ts'
import { renderHandoffPrompt } from '../src/handoff.ts'
import { planSkipNotices } from '../src/skip-plan.ts'
import {
  DESK_SLOTS,
  DESK_WORKSTATION,
  WAIT_SLOTS,
  monitorBaseInsideDeskTop,
  seatIsBehindDeskEdge,
  workstationViolations,
} from '../src/client/fleet/office-template.ts'
import { buildScene, visualStateOf } from '../src/client/fleet/office-scene.ts'
import { ROOM_ORIGIN, paintFrame } from '../src/client/fleet/office-render.ts'
import { emptyBinding, SESSION_BINDINGS_DOMAIN, SessionBindings, sessionBindingsDomain } from '../src/bindings.ts'
import {
  FLEET_CONCURRENCY,
  FLEET_SCOPE_LIMIT,
  filterFleetRows,
  fleetGroups,
  fleetQueue,
  fleetRows,
  fleetScope,
  fleetSession,
  fleetSummary,
  formatTokenCount,
  totalTokens,
  topLevelSessions,
} from '../src/client/fleet/model.ts'
import { createFleetController } from '../src/client/fleet/controller.ts'
import { subagentChatAddress } from '../src/client/fleet/address.ts'
import {
  checkDelegateGate,
  checkFinishGate,
  checkNewSessionGate,
  compileDescription,
  handoffProjection,
  HandoffLedger,
  REVIEW_VERDICT_SCHEMA,
} from '../src/handoff.ts'
import { HANDOFF_KEY, handoffCounters } from '../src/handoff-wire.ts'
import { HandoffRuntime, verdictOf } from '../src/handoff-tool.ts'

let passed = 0
const pending = []

/**
 * The structural-validation input both halves speak: named chains plus the id of
 * the default one. The legacy single `chain` is folded into this shape by
 * `effectiveChains`, which is why no rule below takes the old shape.
 */
const named = (chain, id = 'default', name = '') => ({ id, name, ...chain })
const structural = (chain, over = {}) => ({ chains: [named(chain)], defaultChainId: 'default', ...over })
function test(name, body) {
  let result
  try {
    result = body()
  } catch (error) {
    console.log(`    FAIL ${name}: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(
      () => { passed += 1; console.log(`    ok  ${name}`) },
      (error) => { console.log(`    FAIL ${name}: ${error.message}`); process.exitCode = 1 },
    ))
    return
  }
  passed += 1
  console.log(`    ok  ${name}`)
}

const image = (type) => [{ type: 'text', text: 'hi' }, { type, attachment: { name: 'x.png' } }]

// ---- hasImageContent ----

test('detects an image block in any admitted message', () => {
  assert.equal(hasImageContent([{ content: image('image') }]), true)
  assert.equal(hasImageContent([{ content: image('text') }, { content: image('image') }]), true)
})

test('no image block means no images', () => {
  assert.equal(hasImageContent([{ content: image('text') }]), false)
  assert.equal(hasImageContent([]), false)
  assert.equal(hasImageContent([{ content: [] }]), false)
})

// ---- unmetCondition ----

const candidate = (needs) => ({ provider: 'p', model: 'm', ...(needs === undefined ? {} : { needs }) })
const conditions = (hasImages, projectedTokens) => ({ hasImages, projectedTokens })

test('no needs means always eligible', () => {
  assert.equal(unmetCondition(candidate(undefined), conditions(false, undefined)), undefined)
  assert.equal(unmetCondition(candidate({}), conditions(false, undefined)), undefined)
})

test('images gate requires an image block; false requires its absence', () => {
  assert.equal(unmetCondition(candidate({ images: true }), conditions(false, 5000)), '需图片输入')
  assert.equal(unmetCondition(candidate({ images: true }), conditions(true, 5000)), undefined)
  assert.equal(unmetCondition(candidate({ images: false }), conditions(false, 0)), undefined)
  assert.equal(unmetCondition(candidate({ images: false }), conditions(true, 0)), '本请求包含图片')
})

test('context gate: 0 disables, unmeasured is unmet, boundary is inclusive', () => {
  assert.equal(unmetCondition(candidate({ minContextTokens: 0 }), conditions(false, undefined)), undefined)
  assert.equal(unmetCondition(candidate({ minContextTokens: 100 }), conditions(false, undefined)), '需预估上下文 ≥ 100 tokens')
  assert.equal(unmetCondition(candidate({ minContextTokens: 100 }), conditions(false, 99)), '需预估上下文 ≥ 100 tokens')
  assert.equal(unmetCondition(candidate({ minContextTokens: 100 }), conditions(false, 100)), undefined)
  assert.equal(unmetCondition(candidate({ minContextTokens: 100 }), conditions(false, 101)), undefined)
})

// ---- planFire (attempt accounting) ----

const chainOf = (maxAttempts, count = 3, strategy = 'order') => ({
  candidates: Array.from({ length: count }, (_, index) => ({ provider: 'p', model: `m${index}`, maxAttempts, weight: 0 })),
  order: Array.from({ length: count }, (_, index) => index),
  // 2026-10-22 起表外还有一个 `other`（默认 true）。这一组用例刻意保留
  // emptyResponse/invalidRequest = false，它们测的是"用户显式取消勾选"那条路。
  switchOn: { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false, other: true },
  // 这一组测的是次数预算本身，所以白名单留空：把"直接切"的行为留给专门的用例。
  immediateSwitch: [],
  strategy,
})

test('planFire gives each candidate exactly maxAttempts fires before advancing', () => {
  let state = startStep(1, 1, chainOf(2), emptyConditions())
  const fires = []
  for (let i = 0; i < 6; i += 1) {
    const plan = planFire(state, true)
    fires.push(plan.state.index)
    state = plan.state
  }
  assert.deepEqual(fires, [0, 0, 1, 1, 2, 2])
})

test('planFire marks exhausted at the last candidate and never advances past it', () => {
  let state = startStep(1, 1, chainOf(1, 2), emptyConditions())
  const seen = []
  for (let i = 0; i < 5; i += 1) {
    const plan = planFire(state, true)
    seen.push({ index: plan.state.index, exhausted: plan.state.exhausted })
    state = plan.state
  }
  assert.deepEqual(seen, [
    { index: 0, exhausted: false },
    { index: 1, exhausted: false },
    { index: 1, exhausted: true },
    { index: 1, exhausted: true },
    { index: 1, exhausted: true },
  ])
})

test('planFire without mayAdvance stays on the capped candidate', () => {
  let state = startStep(1, 1, chainOf(1, 2), emptyConditions())
  state = planFire(state, false).state
  const second = planFire(state, false)
  assert.equal(second.state.index, 0)
  assert.equal(second.advanced, false)
})

// ---- decideRecovery ----

test('recovery terminates on an unchecked code even when the candidate has retries left', () => {
  const state = { ...startStep(1, 1, chainOf(1, 2), emptyConditions()), totalAttempts: 1 }
  assert.equal(decideRecovery(state, 'AUTH', false), 'terminal')
  assert.equal(decideRecovery(state, 'ABORTED', false), 'terminal')
})

test('recovery advances an eligible code while another candidate exists, terminates at the chain end', () => {
  const base = { ...startStep(1, 1, chainOf(1, 2), emptyConditions()), totalAttempts: 1 }
  assert.equal(decideRecovery(base, 'TIMEOUT', false), 'advance')
  // 链走完（末位候选）即终态：没有整请求总上限，边界就是候选本身。
  const last = { ...startStep(1, 1, chainOf(1, 2), emptyConditions()), index: 1, totalAttempts: 2 }
  assert.equal(decideRecovery(last, 'TIMEOUT', false), 'terminal')
  assert.equal(decideRecovery(base, 'TIMEOUT', true), 'terminal')
})

// ---- the recovery listener's two decision points (index.ts's five branches as one table) ----

// `agent/request-error` 的五条分支（A 透传 / B、C 提前决定 / D 否决 / E 放行 / F 内层
// 放弃）收编成两个纯决策点，副作用由规则派生而不是各分支各挂：一次失败若把当前候选
// 拿出轮换（换走 / 凉住 / 终态）就记熔断；失败尚未定论（放行内层继续重试同一条路由）
// 就不记。index.ts 只剩解释器——调决策、按声明应用副作用、返回决策。

const recoveryChain = (maxAttempts, count) => chainOf(maxAttempts, count)
const at = (chain, over) => ({ ...startStep(1, 1, chain, emptyConditions(), 0), ...over })

test('before inner: a candidate with attempts left retries itself, with a real backoff', () => {
  // 2026-10-21：勾选的码由路由器自己重试，次数就是配置的次数。等待复刻该
  // provider 的策略曲线（这里 jitterRatio 0 + random 0.5 ⇒ 恰好 initialDelay）。
  const policy = { mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }
  const underCapHop = at(recoveryChain(2, 2), { index: 0, attemptsOnCandidate: 1, totalAttempts: 1 })
  const underCapFallback = at(recoveryChain(2, 2), { index: 1, attemptsOnCandidate: 1, totalAttempts: 2 })
  for (const state of [underCapHop, underCapFallback]) {
    const ruling = decideBeforeInner(state, 'RATE_LIMIT', false, { policy, random: () => 0.5 })
    assert.equal(ruling.kind, 'retry-self')
    assert.equal(ruling.record, false, 'nothing left rotation: the route is still being retried')
    assert.equal(ruling.log, '')
    assert.equal(ruling.delayMs, 500, 'the first retry waits the policy initial delay')
  }
  // 第二次重试翻倍（指数），仍受 maxDelayMs 截断。
  const second = decideBeforeInner(at(recoveryChain(3, 2), { attemptsOnCandidate: 2, totalAttempts: 2 }), 'RATE_LIMIT', false, { policy, random: () => 0.5 })
  assert.equal(second.delayMs, 1000)
})

test('before inner: the spent candidate that should switch decides without llm-retry', () => {
  const ruling = decideBeforeInner(at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 }), 'RATE_LIMIT', false)
  assert.equal(ruling.kind, 'advance')
  assert.equal(ruling.record, true)
  assert.match(ruling.log, /this candidate's retry budget is spent, switching/)
})

test('before inner: the last candidate ends the step once its budget is spent', () => {
  const ruling = decideBeforeInner(at(recoveryChain(1, 1), { attemptsOnCandidate: 1, totalAttempts: 1 }), 'RATE_LIMIT', false)
  assert.equal(ruling.kind, 'terminate')
  assert.equal(ruling.record, true)
  assert.match(ruling.log, /and the chain has nothing left, terminating/)
})

test('before inner: an unchecked code or an abort still defers to llm-retry', () => {
  // 路由器只接管 switchOn 勾选的失败。没勾的码与取消都不是它的事：
  // 前者仍由 DSH 按自己的策略重试，后者是一次没人等的调用。
  const underCap = at(recoveryChain(2, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  const spent = at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  const rows = [
    [underCap, 'EMPTY_RESPONSE', false],
    [spent, 'EMPTY_RESPONSE', false],
    [spent, 'RATE_LIMIT', true],
  ]
  for (const [state, code, aborted] of rows) {
    const ruling = decideBeforeInner(state, code, aborted)
    assert.equal(ruling.kind, 'delegate')
    assert.equal(ruling.record, false)
    assert.equal(ruling.log, '')
  }
})

// ---- 立即切换白名单：重试注定一样的码不占预算 ----

const immediateChain = (maxAttempts, count) => {
  const base = chainOf(maxAttempts, count)
  return {
    ...base,
    switchOn: { ...base.switchOn, auth: true, quota: true },
    immediateSwitch: ['auth', 'quota'],
  }
}

test('before inner: a whitelisted failure switches without spending the retry budget', () => {
  // 密钥失效、额度用尽：换一条候选通常立刻能救，而重试同一条只会拿到同一个答案。
  // 白名单命中时不重试、不等退避，直接换——次数预算留给瞬态失败。
  const policy = { mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }
  const state = at(immediateChain(5, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  const ruling = decideBeforeInner(state, 'AUTH', false, { policy })
  assert.equal(ruling.kind, 'advance')
  assert.equal(ruling.record, true, 'the candidate leaves rotation, so the breaker hears about it')
  assert.match(ruling.log, /immediate-switch list, switching without retrying/)
  // 末位候选：直接终态，不再白打一次。
  const last = { ...state, index: 1 }
  assert.equal(decideBeforeInner(last, 'AUTH', false, { policy }).kind, 'terminate')
})

test('before inner: the whitelist only names keys, and the others keep their budget', () => {
  const state = at(immediateChain(5, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  // 限流是瞬态失败：不在默认名单里，仍按次数重试。
  const ruling = decideBeforeInner(state, 'RATE_LIMIT', false)
  assert.equal(ruling.kind, 'retry-self')
  assert.equal(switchesImmediately(state.chain, 'RATE_LIMIT'), false)
  // 表外的码经 `other` 归口：名单里没有 other 就不抢在 DSH 内层前面。
  assert.equal(switchesImmediately(state.chain, 'PI_AI_ERROR'), false)
  assert.equal(decideBeforeInner(state, 'PI_AI_ERROR', false).kind, 'delegate')
})

test('an "always" provider turns the delegated codes into a terminal ruling', () => {
  // `ResolvedAlwaysRetryPolicy` 只有 mode/backoff：内层会无界重试同一条路由，而
  // 插件读不到任何码表或上限。把这些码交给它 = step 永不结束（屏幕一直"重试中"）。
  // 加载期审计看不到这条：它只走链候选，而第一跳可能不在任何链里。
  const always = { mode: 'always', initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  const normal = { mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  // 用户没勾的码（表外经 other 归口，这里 other 关掉 → 归内层）：always 下必须终态。
  const unowned = at({ ...immediateChain(5, 2), switchOn: { ...immediateChain(5, 2).switchOn, other: false } }, { attemptsOnCandidate: 1, totalAttempts: 1 })
  const terminal = decideBeforeInner(unowned, 'PI_AI_ERROR', false, { policy: always })
  assert.equal(terminal.kind, 'terminate')
  assert.equal(terminal.record, true, 'taking the step down is a channel fact worth recording')
  assert.match(terminal.log, /always/)
  // 同一个码在 normal 策略下照旧交给内层。
  assert.equal(decideBeforeInner(unowned, 'PI_AI_ERROR', false, { policy: normal }).kind, 'delegate')
  // 我们接管的码不受影响：次数由插件自己数，always 与否无所谓。
  assert.equal(decideBeforeInner(unowned, 'RATE_LIMIT', false, { policy: always }).kind, 'retry-self')
  // 调用方已取消时不改写结局：那是"没人等这次调用"，不是渠道问题。
  assert.equal(decideBeforeInner(unowned, 'PI_AI_ERROR', true, { policy: always }).kind, 'delegate')
})

test('after inner: a whitelisted code outside the table gets no router retry either', () => {
  // 表外码先问内层；内层放弃后，白名单让路由器不补自己的重试。
  const chain = { ...immediateChain(5, 2), immediateSwitch: ['other'] }
  const state = at(chain, { attemptsOnCandidate: 1, totalAttempts: 1 })
  assert.equal(switchesImmediately(chain, 'PI_AI_ERROR'), true, 'unknown codes are named by the `other` key')
  // `retryable: false` 是"内层从没为这个码重试过"：没有白名单时路由器会补自己的重试。
  const ruling = decideAfterInner(state, 'PI_AI_ERROR', false, undefined, { retryable: false })
  assert.equal(ruling.kind, 'advance')
  assert.equal(ruling.record, true)
})

test('after inner: an inner retry is always honored — there is no cap left to veto it', () => {
  // 2026-10-20 删除整请求总上限之后，"否决内层重试"这条分支没有剩余理由：
  // 额度耗尽的那一条在 decideBeforeInner 就被提前接管，轮不到这里；没勾的码本来就归 DSH。
  const cases = [
    at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 }),
    at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 99 }),
    at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1, exhausted: true }),
  ]
  for (const state of cases) {
    const ruling = decideAfterInner(state, 'RATE_LIMIT', false, 'retry')
    assert.equal(ruling.kind, 'honor')
    assert.equal(ruling.record, false)
    assert.equal(ruling.log, '')
  }
})

test('after inner: llm-retry gave up, so the chain continues or ends — recorded either way', () => {
  const continuing = at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  const advance = decideAfterInner(continuing, 'TIMEOUT', false, undefined)
  assert.equal(advance.kind, 'advance')
  assert.equal(advance.record, true)
  assert.match(advance.log, /continuing the chain/)
  const terminal = decideAfterInner(continuing, 'ABORTED', false, undefined)
  assert.equal(terminal.kind, 'terminate')
  assert.equal(terminal.record, true)
  assert.equal(terminal.log, '')
})

test('after inner: the last candidate ends the step instead of retrying itself without backoff', () => {
  // llm-retry 已经放弃同路由重试；此时"本候选还有额度"不是再打一次的理由——
  // 那正是没有退避的盲重试，还会把 exhausted 置在一个没到上限的候选上。
  const last = at(recoveryChain(3, 2), { index: 1, attemptsOnCandidate: 1, totalAttempts: 3 })
  assert.equal(decideRecovery(last, 'TIMEOUT', false), 'terminal')
  const ruling = decideAfterInner(last, 'TIMEOUT', false, undefined)
  assert.equal(ruling.kind, 'terminate')
  assert.equal(ruling.record, true)
})

test('the record rule holds across the whole ruling table: only delegate, retry-self and honor stay unrecorded', () => {
  // 不变量本身：record === 这个裁决把候选拿出了轮换。穷举状态 × 码 × aborted × 内层
  // 决定，任一分支漏记都会在这里红——待办 4 就是这个测试当时会抓到的形状。
  const states = [
    at(recoveryChain(1, 2), { attemptsOnCandidate: 0, totalAttempts: 0 }),
    at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 }),
    at(recoveryChain(2, 2), { attemptsOnCandidate: 1, totalAttempts: 1 }),
    at(recoveryChain(1, 1), { attemptsOnCandidate: 1, totalAttempts: 1 }),
    at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1, exhausted: true }),
  ]
  for (const state of states) {
    for (const code of ['RATE_LIMIT', 'TIMEOUT', 'EMPTY_RESPONSE', 'ABORTED']) {
      for (const aborted of [false, true]) {
        const before = decideBeforeInner(state, code, aborted)
        // 记录 ⟺ 这次失败把当前候选拿出了轮换（换走 / 终态）。放行内层与
        // "自己重试同一条路由"都不是定论，都不记。
        assert.equal(before.record, before.kind === 'advance' || before.kind === 'terminate', `before ${code}/${String(aborted)}`)
        for (const inner of [undefined, 'retry']) {
          const after = decideAfterInner(state, code, aborted, inner)
          // 未记录的三种：放行内层、路由器自己补重试、委派。只有换走/终态算"定论"。
          const unrecorded = after.kind === 'honor' || after.kind === 'retry-self'
          assert.equal(after.record, !unrecorded, `after ${code}/${String(aborted)}/${String(inner)}`)
        }
      }
    }
  }
})

test('a code outside the table is switch-eligible by default, and still asks the inner layers first', () => {
  // 2026-10-22 的事故形状：402 被 pi-ai 归一成表里的 INVALID_REQUEST（当时默认不勾），
  // 而 `llm-retry` 也不重试它 → 插件不切、DSH 不重试 → 整轮直接失败。表外的码此前同样
  // 是死区（`switchOnKeyOf` 返回 undefined ⇒ 永不接管）。现在它们落到 `other`（默认 true）。
  const state = at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  assert.equal(isSwitchOnEligible(state.chain, 'PI_AI_ERROR'), true)
  // 先问内层：表外的码不抢在 compaction / 未来的恢复插件前面。
  assert.equal(decideBeforeInner(state, 'PI_AI_ERROR', false).kind, 'delegate')
  // 内层放弃后才换下一条候选，并记熔断。
  const after = decideAfterInner(state, 'PI_AI_ERROR', false, undefined)
  assert.equal(after.kind, 'advance')
  assert.equal(after.record, true)
  // 用户显式关掉兜底 = 交给 DSH 收尾，插件一步都不动。
  const off = { ...state, chain: { ...state.chain, switchOn: { ...state.chain.switchOn, other: false } } }
  assert.equal(decideBeforeInner(off, 'PI_AI_ERROR', false).kind, 'delegate')
  assert.equal(decideAfterInner(off, 'PI_AI_ERROR', false, undefined).kind, 'terminate')
})

test('after inner: a code llm-retry never looked at still honours the configured retries', () => {
  // 表外的码永远先 delegate，所以"内层放弃"这条路曾经等于"候选直接定性"——用户给
  // 候选填的 maxRetries 对这类码完全失效（与表内的码不一致）。这里钉住修正：内层
  // 根本没为这个码重试过（retryable: false）且候选还有额度时，路由器用自己的退避补上。
  const policy = { mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }
  const underCap = at(recoveryChain(2, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  const ruling = decideAfterInner(underCap, 'PI_AI_ERROR', false, undefined, { policy, retryable: false, random: () => 0.5 })
  assert.equal(ruling.kind, 'retry-self')
  assert.equal(ruling.record, false)
  assert.equal(ruling.delayMs, 500)
  // 内层真的为这个码重试过（策略里列了它）→ 不叠加第二轮，直接换候选。
  const retried = decideAfterInner(underCap, 'PI_AI_ERROR', false, undefined, { policy, retryable: true })
  assert.equal(retried.kind, 'advance')
  // 额度花完 → 换候选；取消 → 不发这一次没人等的调用。
  const spent = at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  assert.equal(decideAfterInner(spent, 'PI_AI_ERROR', false, undefined, { policy, retryable: false }).kind, 'advance')
  assert.equal(decideAfterInner(underCap, 'PI_AI_ERROR', true, undefined, { policy, retryable: false }).kind, 'terminate')
})

test('the codes DSH recovery plugins own get first refusal even with the catch-all on', () => {
  // 这两个码由 compaction-basic / compaction-image-offload 拥有：压缩历史或卸载图片才是
  // 对的修法。路由器抢在它们前面就等于把一次可修的溢出换成一次换渠道。
  const state = at(recoveryChain(1, 2), { attemptsOnCandidate: 1, totalAttempts: 1 })
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED']) {
    assert.equal(decideBeforeInner(state, code, false).kind, 'delegate', `${code} must reach its owner first`)
    assert.equal(decideAfterInner(state, code, false, 'retry').kind, 'honor')
    assert.equal(decideAfterInner(state, code, false, undefined).kind, 'advance')
  }
})

// ---- resolveChain ----

// ---- strategy: the start index ----

test('resolveStartIndex always starts at the head for the order strategy', () => {
  const chain = chainOf(1, 4)
  for (let cursor = 0; cursor < 8; cursor += 1) {
    assert.equal(resolveStartIndex(chain.candidates, 'order', cursor), 0)
  }
})

test('resolveStartIndex walks the chain one step per cursor for round-robin', () => {
  const chain = chainOf(1, 3)
  assert.deepEqual([0, 1, 2, 3, 4].map(cursor => resolveStartIndex(chain.candidates, 'round-robin', cursor)), [0, 1, 2, 0, 1])
})

test('resolveStartIndex draws by weight, and never picks a zero-weight candidate', () => {
  const candidates = [
    { provider: 'free', model: 'm', weight: 0 },
    { provider: 'paid', model: 'm', weight: 30 },
    { provider: 'spare', model: 'm', weight: 70 },
  ]
  const picked = new Set()
  for (let i = 0; i < 400; i += 1) picked.add(resolveStartIndex(candidates, 'weight', 0))
  // 权重 0 的那条永远不会被抽中，另外两条都出现过。
  assert.deepEqual([...picked].sort(), [1, 2])
})

test('resolveStartIndex falls back to the head when no candidate has weight', () => {
  const chain = chainOf(1, 3)
  assert.equal(resolveStartIndex(chain.candidates, 'weight', 7), 0)
})

test('resolveStartIndex ignores the cursor for a single-candidate chain', () => {
  assert.equal(resolveStartIndex([{ weight: 5 }], 'round-robin', 9), 0)
  assert.equal(resolveStartIndex([{ weight: 5 }], 'weight', 9), 0)
})

test('rotate wraps so the start is the head and the rest follow in order', () => {
  assert.deepEqual(rotate(['a', 'b', 'c'], 1), ['b', 'c', 'a'])
  assert.deepEqual(rotate(['a', 'b', 'c'], 3), ['a', 'b', 'c'])
  assert.deepEqual(rotate(['a', 'b', 'c'], 5), ['c', 'a', 'b'])
  assert.deepEqual(rotate([], 2), [])
})

test('startStep keeps the first hop at the head and rotates only the fallbacks', () => {
  const chain = chainOf(1, 3)
  const state = startStep(1, 1, chain, emptyConditions(), 1)
  // 第一跳（m0）永远是链首；起点只作用于它后面的降级候选。
  assert.deepEqual(state.chain.candidates.map(c => c.model), ['m0', 'm2', 'm1'])
  // 界面和通知说的"第几条"仍是用户自己排的那一套（第一跳固定是 0）。
  assert.deepEqual(state.chain.order, [0, 2, 1])
  assert.equal(state.index, 0)
})

test('the first hop never leaves the head under any start index', () => {
  for (const start of [0, 1, 2, 5, -1]) {
    const state = startStep(1, 1, chainOf(1, 3), emptyConditions(), start)
    assert.equal(state.chain.candidates[0].model, 'm0', `start=${start}`)
    assert.equal(state.chain.order[0], 0, `start=${start}`)
  }
})

test('startStep at the head leaves the chain untouched', () => {
  const chain = chainOf(1, 3)
  const state = startStep(1, 1, chain, emptyConditions(), 0)
  assert.deepEqual(state.chain.candidates.map(c => c.model), ['m0', 'm1', 'm2'])
  assert.deepEqual(state.chain.order, [0, 1, 2])
})

// ---- Circuit breaker ----
import { CircuitBreaker, matchBreakRule } from '../src/breaker.ts'

const RULES = [
  { code: 'AUTH', message: '', cooldownSeconds: 3600, scope: 'route' },
  { code: 'RATE_LIMIT', message: '', cooldownSeconds: 60, scope: 'route' },
  { code: '', message: 'quota', cooldownSeconds: 7200, scope: 'channel' },
]

test('matchBreakRule matches on code alone', () => {
  assert.equal(matchBreakRule('RATE_LIMIT', 'too many requests', RULES).seconds, 60)
  assert.equal(matchBreakRule('AUTH', 'bad key', RULES).seconds, 3600)
})

test('matchBreakRule matches on message when the code says nothing', () => {
  assert.equal(matchBreakRule('PROVIDER_SPECIFIC', 'monthly quota exceeded', RULES).seconds, 7200)
})

test('matchBreakRule requires every filled field to match', () => {
  const both = [{ code: 'SERVER', message: 'overloaded', cooldownSeconds: 30, scope: 'route' }]
  assert.equal(matchBreakRule('SERVER', 'upstream overloaded', both).seconds, 30)
  assert.equal(matchBreakRule('SERVER', 'connection reset', both), undefined)
  assert.equal(matchBreakRule('TIMEOUT', 'upstream overloaded', both), undefined)
})

test('matchBreakRule returns undefined for a failure no rule names', () => {
  assert.equal(matchBreakRule('SERVER', 'internal error', RULES), undefined)
  assert.equal(matchBreakRule('ABORTED', 'user aborted', RULES), undefined)
})

test('matchBreakRule takes the first matching rule', () => {
  const ordered = [
    { code: '', message: 'e', cooldownSeconds: 10, scope: 'route' },
    { code: 'SERVER', message: '', cooldownSeconds: 20, scope: 'channel' },
  ]
  assert.equal(matchBreakRule('SERVER', 'internal error', ordered).seconds, 10)
})

test('matchBreakRule carries the rule scope through', () => {
  assert.equal(matchBreakRule('AUTH', 'bad key', RULES).scope, 'route')
  assert.equal(matchBreakRule('PROVIDER_SPECIFIC', 'quota gone', RULES).scope, 'channel')
})

test('CircuitBreaker blocks a matched route and lifts it when the cooldown ends', () => {
  const breaker = new CircuitBreaker()
  const t0 = 1_000_000
  assert.equal(breaker.note('real-a', 'm1', 'AUTH', 'bad key', RULES, t0)?.until, t0 + 3_600_000)
  assert.equal(breaker.blockedUntil('real-a', 'm1', t0 + 1_000).until, t0 + 3_600_000)
  // 冷却到了就自动放行——不是永久拉黑。
  assert.equal(breaker.blockedUntil('real-a', 'm1', t0 + 3_600_001), undefined)
})

test('CircuitBreaker leaves an unmatched failure alone', () => {
  const breaker = new CircuitBreaker()
  assert.equal(breaker.note('real-a', 'm1', 'SERVER', 'boom', RULES, 1000), undefined)
  assert.equal(breaker.blockedUntil('real-a', 'm1', 2000), undefined)
})

test('CircuitBreaker blocks per route, not per provider', () => {
  const breaker = new CircuitBreaker()
  breaker.note('real-a', 'm1', 'AUTH', 'bad key', RULES, 1000)
  assert.equal(breaker.blockedUntil('real-a', 'm2', 2000), undefined)
  assert.equal(breaker.blockedUntil('real-b', 'm1', 2000), undefined)
})

test('a channel-scope rule blocks every model under the provider', () => {
  // 实测依据：一个网关渠道里密钥失效，链上每条模型都会吐同样的错。按路由禁，
  // 链上会把同渠道其余模型各真打一次才跨渠道——那正是用户配的 attempt 预算。
  const breaker = new CircuitBreaker()
  breaker.note('real-a', 'm1', 'QUOTA_EXCEEDED', 'quota gone', RULES, 1000)
  assert.equal(breaker.blockedUntil('real-a', 'm1', 2000).scope, 'channel')
  assert.equal(breaker.blockedUntil('real-a', 'm2', 2000)?.until, 1000 + 7_200_000)
  assert.equal(breaker.blockedUntil('real-a', 'm3', 2000)?.scope, 'channel')
  // 别的渠道不受影响。
  assert.equal(breaker.blockedUntil('real-b', 'm1', 2000), undefined)
})

test('a route sits out until both its own block and its channel block lift', () => {
  const breaker = new CircuitBreaker()
  const t0 = 1_000_000
  breaker.note('real-a', 'm1', 'RATE_LIMIT', 'slow down', RULES, t0)          // route, 60s
  breaker.note('real-a', 'm2', 'QUOTA_EXCEEDED', 'quota gone', RULES, t0)     // channel, 7200s
  // m1 自己的 60s 先到，但渠道的 7200s 还没到——它仍然不可用，且绑定的是渠道。
  assert.equal(breaker.blockedUntil('real-a', 'm1', t0 + 61_000)?.until, t0 + 7_200_000)
  assert.equal(breaker.blockedUntil('real-a', 'm1', t0 + 61_000)?.scope, 'channel')

  // 反过来：渠道 block 短、路由 block 长时，绑定的回归路由，且渠道的到期会放行
  // 只有渠道 block 的兄弟路由。
  const shortChannel = [{ code: 'QUOTA', message: '', cooldownSeconds: 60, scope: 'channel' }]
  const longRoute = [{ code: 'AUTH', message: '', cooldownSeconds: 3600, scope: 'route' }]
  const other = new CircuitBreaker()
  other.note('real-a', 'm2', 'QUOTA', 'q', shortChannel, t0)                  // channel, 60s
  other.note('real-a', 'm1', 'AUTH', 'k', longRoute, t0)                      // route, 3600s
  assert.equal(other.blockedUntil('real-a', 'm1', t0 + 61_000)?.until, t0 + 3_600_000)
  assert.equal(other.blockedUntil('real-a', 'm1', t0 + 61_000)?.scope, 'route')
  assert.equal(other.blockedUntil('real-a', 'm2', t0 + 61_000), undefined)
})

test('CircuitBreaker.sweep drops expired blocks only', () => {
  const breaker = new CircuitBreaker()
  breaker.note('p', 'short', 'RATE_LIMIT', 'x', RULES, 0)      //  lifts at 60s
  breaker.note('p', 'long', 'AUTH', 'x', RULES, 0)      //  lifts at 3600s
  breaker.sweep(61_000)
  assert.equal(breaker.blockedUntil('p', 'short', 62_000), undefined)
  assert.equal(breaker.blockedUntil('p', 'long', 62_000).until, 3_600_000)
})

test('breakerNotice states the cooldown deadline and promises no retry', () => {
  const text = breakerNotice({ provider: 'real-a', model: 'm1' }, { until: 10_500, scope: 'route' })
  const rendered = text.content.find(block => block.type === 'text').text
  assert.ok(rendered.includes('已被自动禁用'))
  // 冷却只回答"何时解除"（breaker.ts 的 blockedUntil），没有任何自动重试：
  // 旧文案的「约 N 秒后自动重试」是假话，这条断言钉住它不许回来。
  assert.ok(!rendered.includes('自动重试'), rendered)
  assert.ok(rendered.includes('冷却至'), rendered)
  assert.ok(rendered.includes('下一条请求才会再试它'), rendered)
  // durable 消息不能写相对秒数：明天读到同一条，它必须是同一句话。
  assert.ok(!/约 \d+ 秒/.test(rendered), rendered)
})

test('breakerNotice names the whole channel for a channel-scope block', () => {
  const text = breakerNotice({ provider: 'real-a', model: 'm1' }, { until: 10_500, scope: 'channel' })
  const rendered = text.content.find(block => block.type === 'text').text
  assert.ok(rendered.includes('渠道 real-a 已整体自动禁用'), rendered)
  assert.ok(rendered.includes('该渠道下所有模型'), rendered)
  // 路由自己的名字不该出现——用户会以为只凉了这一个。
  assert.ok(!rendered.includes('m1'), rendered)
})

// ---- config round-trip: the shape the client saves must land where the host reads ----
import { Config, switchOnSchema } from '../src/config.ts'

const hostConfig = raw => {
  const c = Config(raw)
  return {
    health: c.health.get(),
    chain: c.chain.get(),
  }
}

test('the once-per-turn notice ledger is one ledger for every notice kind, keyed per turn', () => {
  const states = new RouterState()
  const agent = {} // state 只拿它当 WeakMap 键；agentKey 助手在本文件后部定义
  // 空账本读出来是一个空集，且不会被写坏（记账走 recordTurnNoticeKeys）。
  assert.deepEqual([...states.turnNoticeKeys(agent, 1)], [])
  states.recordTurnNoticeKeys(agent, 1, ['condition:a/b'])
  assert.deepEqual([...states.turnNoticeKeys(agent, 1)], ['condition:a/b'])
  // 不同 key（另一类跳过 / 另一个候选 / 不是跳过的那条绑定通知）互不遮挡：一次
  // fire 可能同时跳过条件候选、能力候选和冷却候选，各自都要各自报一次。
  states.recordTurnNoticeKeys(agent, 1, ['breaker:a/b', 'capability:a/b', 'binding:gone'])
  assert.equal(states.turnNoticeKeys(agent, 1).size, 4)
  assert.equal(states.turnNoticeKeys(agent, 1).has('condition:a/b'), true, 'an earlier key stays recorded after others were announced')
  // 空批次不建账本：没有要记的就不该出现一个"本轮已有通知"的假状态。
  const untouched = {}
  states.recordTurnNoticeKeys(untouched, 1, [])
  assert.deepEqual([...states.turnNoticeKeys(untouched, 1)], [])
  // 新一轮重新武装：新的失败链要重新告知。
  assert.deepEqual([...states.turnNoticeKeys(agent, 2)], [])
  states.recordTurnNoticeKeys(agent, 2, ['breaker:a/b'])
  assert.deepEqual([...states.turnNoticeKeys(agent, 2)], ['breaker:a/b'])
})

// ---- 4.12 的自动网：同一轮里跳过集合变大，只许多报新增的那一条 ----
//
// 组合 harness 一次 boot 只有一个 step，"同一步跳过 {A}、下一步跳过 {A, C}"这个
// 形态在真实组合里到不了（见 feature-review 2026-10-26 第七节末尾）。所以把
// "报哪几条"抽成纯函数（./skip-plan.ts）后在这里两次调用它：同一个 turn 的两次
// fire，第二次把第一次的 keys 当作已报账本。
test('a skip set that grows mid-turn announces only the candidate that joined it', () => {
  const route = (provider, model = 'm1') => ({ provider, model })
  const resolved = route('own-route')
  const ledger = new Set()
  const step1 = planSkipNotices({
    conditionSkipped: [{ candidate: route('image-only'), reason: '仅无图轮' }],
    capabilitySkipped: [],
    blocked: [],
    fellBackToOwnRoute: false,
    resolved,
    alreadyNoted: ledger,
  })
  // 键是逐路由的：`condition:<provider/model>`，与 capability/breaker 同形。
  assert.deepEqual(step1.keys, ['condition:image-only/m1'])
  assert.deepEqual(step1.notices.map(notice => notice.key), ['condition:image-only/m1'])
  // 裁决是纯的：调用方传进来的账本不许被它改写（记账是调用方的事，两处各写一半
  // 就会出现"报过但没人记"或"记了但没报"）。
  assert.equal(ledger.size, 0, 'the plan must not mutate the caller ledger')

  const step2 = planSkipNotices({
    conditionSkipped: [
      { candidate: route('image-only'), reason: '仅无图轮' },
      { candidate: route('small-window'), reason: '上下文不足' },
    ],
    capabilitySkipped: [],
    blocked: [],
    fellBackToOwnRoute: false,
    resolved,
    alreadyNoted: new Set(step1.keys),
  })
  // 这一步才对：只有新加入的那一条开腔。整组拼串的键（`condition:<a:reason|b:reason>`）
  // 在这一步与第一步不同，会把已经说过的 image-only 重报一遍——durable 的 user 消息
  // 进模型上下文，重报就是重复计 token。
  assert.deepEqual(step2.notices.map(notice => notice.key), ['condition:small-window/m1'])
  assert.deepEqual(step2.keys, ['condition:small-window/m1'])
})

test('the skip plan keeps the three kinds apart and never announces one route twice', () => {
  const candidate = { provider: 'a', model: 'm1' }
  const plan = planSkipNotices({
    conditionSkipped: [{ candidate, reason: '仅带图轮' }],
    capabilitySkipped: [{ candidate, tier: 'route-missing', code: 'UNKNOWN_MODEL' }],
    blocked: [{ candidate, block: { until: 1_000, scope: 'route' } }],
    fellBackToOwnRoute: false,
    resolved: { provider: 'own', model: 'm1' },
    alreadyNoted: new Set(),
  })
  // 三条都报（三类互不遮挡），且顺序是条件 → 能力 → 冷却，与 append 顺序一致。
  assert.deepEqual(plan.notices.map(notice => notice.key), ['condition:a/m1', 'capability:a/m1', 'breaker:a/m1'])
  assert.deepEqual(plan.notices.map(notice => notice.kind), ['condition', 'capability', 'breaker'])
  // 同一次 fire 里重复出现的候选只算一次。
  const once = planSkipNotices({
    conditionSkipped: [{ candidate, reason: '仅带图轮' }, { candidate, reason: '仅带图轮' }],
    capabilitySkipped: [], blocked: [], fellBackToOwnRoute: false,
    resolved: { provider: 'own', model: 'm1' },
    alreadyNoted: new Set(),
  })
  assert.deepEqual(once.notices.map(notice => notice.key), ['condition:a/m1'])
})

test('falling back to the user route does not announce that route as skipped', () => {
  // 4.13：隐式第一跳就是 resolved 本身。落回它却说"已跳过第一跳"是假话。
  const plan = planSkipNotices({
    conditionSkipped: [{ candidate: { provider: 'own', model: 'm1' }, reason: '仅带图轮' }],
    capabilitySkipped: [], blocked: [],
    fellBackToOwnRoute: true,
    resolved: { provider: 'own', model: 'm1' },
    alreadyNoted: new Set(),
  })
  assert.deepEqual(plan.notices, [])
  assert.deepEqual(plan.keys, [], 'the suppressed notice must not consume a key either')
  // 别的候选照报：它们确实被跳过，请求也没发到它们。
  const withOther = planSkipNotices({
    conditionSkipped: [
      { candidate: { provider: 'own', model: 'm1' }, reason: '仅带图轮' },
      { candidate: { provider: 'other', model: 'm1' }, reason: '仅无图轮' },
    ],
    capabilitySkipped: [], blocked: [],
    fellBackToOwnRoute: true,
    resolved: { provider: 'own', model: 'm1' },
    alreadyNoted: new Set(),
  })
  assert.deepEqual(withOther.notices.map(notice => notice.key), ['condition:other/m1'])
})

// ---- 像素办公室：模板不变量、场景分配、渲染器调用形状 ----
const fleetAgent = (id, state) => ({
  id,
  label: id,
  mode: 'continuable',
  state,
  running: state === 'running',
  lastTurnCompleted: undefined,
  model: undefined,
  timing: undefined,
  tokenUsage: undefined,
  task: undefined,
  durationMs: undefined,
  addressable: true,
})

test('the workstation template keeps its three invariants, and the check can fail', () => {
  // 模板本身成立：脚在桌沿内、显示器底座在桌面内。
  assert.deepEqual(workstationViolations(0, 0), [])
  assert.equal(seatIsBehindDeskEdge(0, 0), true)
  assert.equal(monitorBaseInsideDeskTop(0, 0), true)
  // 反证：把显示器中心推出去 20px，检查必须报错——否则这条断言是空的。
  const pushed = { ...DESK_WORKSTATION, monitorDX: DESK_WORKSTATION.monitorDX + 20 }
  const baseHalf = (pushed.monitorW - 4) / 2
  const spanX = (pushed.halfW + pushed.halfD) * 24
  const cx = pushed.monitorDX + baseHalf
  assert.ok(cx > spanX, 'the pushed monitor base must fall outside the desk-top diamond')
})

test('the scene seats everyone who is not idle, and overflows past the desk slots', () => {
  // 5 个非空闲 → 5 个工位；1 个空闲 → 待命区。
  const five = buildScene(100, 100, [
    fleetAgent('a', 'running'), fleetAgent('b', 'anomaly'), fleetAgent('c', 'done'),
    fleetAgent('d', 'unknown'), fleetAgent('e', 'running'), fleetAgent('f', 'idle'),
  ])
  assert.equal(five.seated.length, DESK_SLOTS.length)
  assert.equal(five.waiting.length, 1)
  assert.equal(five.overflow, 0)
  assert.equal(five.total, 6)
  assert.equal(five.animating, true, 'a running or stuck agent keeps the clock alive')
  // 座位顺序 = 输入顺序（房间不能和旁边的列表吵架）。
  assert.deepEqual(five.seated.map(person => person.agent.id), ['a', 'b', 'c', 'd', 'e'])
  // 状态条挂在桌面正下方，不随人工位移动。
  for (const person of [...five.seated, ...five.waiting]) {
    assert.equal(person.chip[0], person.at[0])
    assert.ok(person.chip[1] > person.at[1])
  }
  // 第 6 个非空闲装不下 → 计数溢出，不静默丢掉。
  const seven = buildScene(100, 100, [
    fleetAgent('a', 'running'), fleetAgent('b', 'running'), fleetAgent('c', 'running'),
    fleetAgent('d', 'running'), fleetAgent('e', 'running'), fleetAgent('f', 'running'),
  ])
  assert.equal(seven.seated.length, DESK_SLOTS.length)
  assert.equal(seven.overflow, 1)
  // 全空闲：不跑时钟。
  const quiet = buildScene(100, 100, [fleetAgent('x', 'idle')])
  assert.equal(quiet.animating, false)
  assert.equal(quiet.waiting.length, 1)
  assert.ok(WAIT_SLOTS.length >= 1)
})

test('the fleet state becomes a visual state in exactly one place', () => {
  assert.equal(visualStateOf('running'), 'busy')
  assert.equal(visualStateOf('anomaly'), 'stuck')
  assert.equal(visualStateOf('done'), 'done')
  assert.equal(visualStateOf('idle'), 'idle')
  assert.equal(visualStateOf('unknown'), 'unknown')
})

test('a frame blits the baked room once and paints every seated agent', () => {
  const calls = { images: 0, rects: 0 }
  const gradient = { addColorStop() {} }
  const ctx = {
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    fillStyle: '',
    clearRect() {},
    drawImage() { calls.images += 1 },
    fillRect() { calls.rects += 1 },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, ellipse() {},
    createRadialGradient() { return gradient },
  }
  const scene = buildScene(ROOM_ORIGIN.x, ROOM_ORIGIN.y, [fleetAgent('a', 'running'), fleetAgent('b', 'idle')])
  paintFrame(ctx, scene, 1, {})
  assert.equal(calls.images, 1, 'the static room is one blit per frame')
  assert.ok(calls.rects > 10, 'each workstation paints its desk, screen and clutter')
})

test('switchOnKeyOf maps the channel-own faults (AUTH/QUOTA) and never the user-abort', () => {
  // 2026-10-16 修订：AUTH/QUOTA 是渠道自己的毛病（密钥、额度），另一条渠道有自己的
  // 密钥和额度，所以切换通常立刻能救；ABORTED 是用户自己按的停止，永远不切换。
  assert.equal(switchOnKeyOf('AUTH'), 'auth')
  assert.equal(switchOnKeyOf('QUOTA'), 'quota')
  assert.equal(switchOnKeyOf('ABORTED'), undefined)
  assert.equal(switchOnKeyOf('NO_ADAPTER'), undefined)
  assert.equal(switchOnKeyOf('RATE_LIMIT'), 'rateLimit')
})

test('ACCOUNT_QUOTA is the quota key, not an unclassified code', () => {
  // deepseek-account 把 QUOTA 改写成 ACCOUNT_QUOTA（上游真码，llm/src/error.ts 的
  // ACCOUNT_QUOTA_EXCEEDED_CODE）。不映射就等于：用户在「失败切换」里勾的「额度用尽」
  // 管不到它，健康页也不判它不健康，通知里印英文码。
  assert.equal(switchOnKeyOf('ACCOUNT_QUOTA'), 'quota')
  // 一码一键：别名不许进码表，否则界面网格里会出现两个写同一个键的勾选框。
  assert.equal(SWITCH_ON_CODES.some(entry => entry.code === 'ACCOUNT_QUOTA'), false)
  // 同一个键的两个读者必须同意：白名单（额度用尽重试还是同一份额度）与健康判定。
  const chain = { switchOn: { ...DEFAULT_SWITCH_ON }, immediateSwitch: [...DEFAULT_IMMEDIATE_SWITCH] }
  assert.equal(switchesImmediately(chain, 'ACCOUNT_QUOTA'), true)
  assert.equal(classifyHealth('ACCOUNT_QUOTA'), 'unhealthy')
  // 表外未映射的码仍落到兜底键，别名没有把兜底吃掉。
  assert.equal(switchOnKeyOf('PI_AI_ERROR'), undefined)
})

test('the switch-on table, the host schema and the browser draft are one fact', () => {
  // 表里每一个键都必须同时是 host schema 的字段——否则 UI 上那个开关根本存不进
  // host；浏览器草棒的默认值必须与 schema 解析出的默认值逐字相同。三处各写一遍
  // 就会漂移，而漂移是静默的："UI 说开着、host 说关着"。默认值与码清单的唯一
  // 来源是 ../defaults.ts，这条用例钉住两边都真的读它。
  const hostDefaults = switchOnSchema({})
  const browserDefaults = defaultSwitchOn()
  // 表里的键 + 一个表外的兜底键。兜底键不来自码清单（它没有码），所以这里显式列出来：
  // 少了它，`switchOn` 就退回白名单语义，枚举外的一切失败码又变成死区。
  assert.deepEqual(Object.keys(browserDefaults).sort(), [...SWITCH_ON_CODES.map(entry => entry.key), 'other'].sort(),
    'the browser draft names the table\'s keys plus the unclassified catch-all')
  assert.equal(hostDefaults.other, true, 'the catch-all is on by default')
  for (const entry of SWITCH_ON_CODES) {
    assert.ok(Object.hasOwn(hostDefaults, entry.key), `the host schema has no field for ${entry.key}`)
    assert.equal(browserDefaults[entry.key], hostDefaults[entry.key],
      `the browser default for ${entry.key} drifted from the host schema's`)
    assert.equal(switchOnKeyOf(entry.code), entry.key, `the table's code ${entry.code} no longer maps to ${entry.key}`)
  }
})

test('the client save shape lands where the host reads it', () => {
  // 这正是 client.js 的 save() 写进去的形状：四档全在 health 底下。
  // 曾经 breaker 被提到顶层 schema，客户端却存进 health——保存成功、Host 读到
  // 默认值，整个功能静默失效。这条用例守住那个错误。
  const raw = {
    enabled: true,
    chain: { candidates: [], switchOn: {}, firstHopMaxRetries: 0, stickyTurns: 0, strategy: 'order' },
    health: {
      passive: true,
      discover: { enabled: true, intervalSeconds: 5 },
      probe: { enabled: true, intervalSeconds: 0, prompt: '1', prompts: [], timeoutSeconds: 8 },
      breaker: { enabled: true, rules: [{ code: 'AUTH', message: '', cooldownSeconds: 3600 }] },
    },
  }
  const seen = hostConfig(raw)
  assert.equal(seen.health.breaker.enabled, true)
  assert.equal(seen.health.breaker.rules.length, 1)
  assert.equal(seen.health.breaker.rules[0].code, 'AUTH')
  assert.equal(seen.health.discover.intervalSeconds, 5)
  // 新形状：链在顶层 chain 下，客户端存进去的降级候选 Host 读得到。
  assert.ok(Array.isArray(seen.chain.candidates))
})

test('health has no passive switch: the fold always runs, so the field is gone', () => {
  // 一个在 schema、UI、校验里各走一遍而 host 零读者的开关只会骗人：它看起来能关掉
  // 被动观测，实际什么也关不掉。删字段比造一套"要不要记录"的语义小得多。
  assert.equal(Object.hasOwn(hostConfig({}).health, 'passive'), false)
  assert.equal(Object.hasOwn(normalizeHealth({ passive: false }), 'passive'), false)
})

test('the health numbers read back inside the schema bounds, so a save is never refused forever', () => {
  // 曾经：表单只钳下限（探测超时钳到 1），宿主 schema 是 2..60 → 保存被拒，
  // 页脚只说「保存失败，请重试」，用户对着同一个值反复重试。边界现在只有
  // ../defaults.ts 一份，两个读者读同一组数。
  const read = normalizeHealth({
    discover: { intervalSeconds: 999999 },
    probe: { intervalSeconds: -5, timeoutSeconds: 1 },
    breaker: { rules: [{ code: 'AUTH', cooldownSeconds: 0 }] },
  })
  assert.equal(read.discover.intervalSeconds, HEALTH_INTERVAL_MAX_SECONDS)
  assert.equal(read.probe.intervalSeconds, 0)
  assert.equal(read.probe.timeoutSeconds, PROBE_TIMEOUT_MIN_SECONDS)
  assert.equal(read.breaker.rules[0].cooldownSeconds, BREAKER_COOLDOWN_MIN_SECONDS)
  // 同一份对象过 host schema 必须被接受——这就是"保存不会再被拒"的判据。
  const parsed = hostConfig({ health: read }).health
  assert.equal(parsed.probe.timeoutSeconds, PROBE_TIMEOUT_MIN_SECONDS)
  assert.equal(parsed.discover.intervalSeconds, HEALTH_INTERVAL_MAX_SECONDS)
})

test('a legacy flat health config keeps its schedule by converting minutes to seconds', () => {
  const seen = hostConfig({
    enabled: true,
    chain: { candidates: [], switchOn: {}, firstHopMaxRetries: 0, stickyTurns: 0, strategy: 'order' },
    health: { enabled: true, prompt: 'hi', intervalMinutes: 5, timeoutSeconds: 8 },
  })
  // normalizeHealth 负责迁移；这里断言的是 Host 不会因为旧形状而丢字段或报错。
  assert.ok(seen.health.discover !== undefined)
  assert.ok(seen.health.probe !== undefined)
})

test('assertStructural rejects a weight strategy with no positive weight', () => {
  const so = { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false }
  const base = structural({ candidates: [{ provider: 'a', model: 'm', maxRetries: 0, weight: 0 }], switchOn: so, firstHopMaxRetries: 0, stickyTurns: 0, strategy: 'weight' })
  assert.throws(() => assertStructural(base), /weight strategy but no candidate has a positive weight/)
  assert.doesNotThrow(() => assertStructural({
    ...base,
    chains: [{ ...base.chains[0], candidates: [{ provider: 'a', model: 'm', maxRetries: 0, weight: 5 }] }],
  }))
})

test('assertStructural rejects a breaker rule that matches nothing', () => {
  const so = { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false }
  const emptyChain = structural({ candidates: [], switchOn: so, firstHopMaxRetries: 0, stickyTurns: 0, strategy: 'order' })
  const health = (breaker) => ({ passive: true, discover: { enabled: false, intervalSeconds: 0 }, probe: { enabled: false, intervalSeconds: 0, prompt: '1', prompts: [], timeoutSeconds: 8 }, breaker })
  assert.throws(() => assertStructural({
    ...emptyChain,
    health: health({ enabled: true, rules: [{ code: '', message: '', cooldownSeconds: 60 }] }),
  }), /matches nothing/)
  // 关着也校验：空规则在 breaker.ts 里命中每一次失败，"关着开关存下的空规则"会让
  // 所有候选被禁、failover 静默失效。规则可以留着（再开不用重填），空白规则不行。
  assert.throws(() => assertStructural({
    ...emptyChain,
    health: health({ enabled: false, rules: [{ code: '', message: '', cooldownSeconds: 60 }] }),
  }), /matches nothing/)
  // 关着 + 正常规则照常放行。
  assert.doesNotThrow(() => assertStructural({
    ...emptyChain,
    health: health({ enabled: false, rules: [{ code: 'RATE_LIMIT', message: '', cooldownSeconds: 60 }] }),
  }))
})

test('assertStructural rejects a chain that names the same route twice', () => {
  const so = { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false }
  const twice = [
    { provider: 'stub-primary', model: 'stub-model', maxRetries: 0, weight: 0 },
    { provider: 'stub-primary', model: 'stub-model', maxRetries: 0, weight: 0 },
  ]
  // 同链重复的渠道会被各打一遍（各含一次退避等待），白吃 attempt 预算，结构校验就挡住。
  // 目录多选与多行手录都可能录出重复。
  assert.throws(() => assertStructural(structural({
    candidates: twice, switchOn: so, firstHopMaxRetries: 0, stickyTurns: 0, strategy: 'order',
  })), /names stub-primary\/stub-model more than once/)
})

// ---- the cross-field rules have one expression (host throws, browser formats) ----

// 规则模块（../rules.ts）是唯一产出方：host 的 assertStructural 抛第一条，浏览器半包
// 的 validate() 把全部格式化成问题列表。2026-10-17 之前两边各写一份、靠三句"与 host
// 同步"的注释对齐，而且已经漂移——重复渠道 host 从第一天就拒，浏览器漏检：用户存得下
// 一个加载即被拒的配置，吃的还是一句英文错误。

const crossSo = { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false }
const crossChain = (over = {}) => ({ candidates: [], switchOn: crossSo, firstHopMaxRetries: 0, stickyTurns: 0, strategy: 'order', ...over })
const crossHealth = (rules) => ({ breaker: { enabled: true, rules } })

// 每条跨字段规则一个形状；keys 是规则模块必须产出的违规键序列（顺序即 host 先抛哪条）。
const crossCases = [
  ['one route named twice in the chain', structural(crossChain({ candidates: [
    { provider: 'stub-primary', model: 'stub-model', maxRetries: 0, weight: 0 },
    { provider: 'stub-primary', model: 'stub-model', maxRetries: 0, weight: 0 },
  ] })), ['problemDuplicateRouteInChain']],
  ['a weight strategy with nothing to draw', structural(crossChain({ strategy: 'weight', candidates: [{ provider: 'stub-primary', model: 'stub-model', maxRetries: 0, weight: 0 }] })), ['problemWeightNoPositive']],
  ['a breaker rule that matches nothing', { ...structural(crossChain()), health: crossHealth([{ code: '', message: '', cooldownSeconds: 60 }]) }, ['problemBreakerEmptyRule']],
  // 白名单按 switchOn 的键书写；拼错一个键就是一条永不命中的规则，所以它和重复渠道
  // 一样是"任何环境都错"的配置错误。
  ['an immediate-switch entry that names no failure', structural(crossChain({ immediateSwitch: ['authh'] })), ['problemUnknownImmediateSwitch']],
]

test('the cross-field rules are one expression: the host throws the first, the browser formats them all', () => {
  for (const [label, config, keys] of crossCases) {
    const violations = structuralViolations(config)
    assert.deepEqual(violations.map(violation => violation.key), keys, `${label}: the rule module's output`)
    // host：抛的正是第一条的 message（先抛哪条由此固定，与统一前的顺序一致）。
    assert.throws(() => assertStructural(config), (error) => error.message === violations[0].message, `${label}: the host throws the module's message`)
    // 浏览器：全部收进问题列表（key + vars 进字典渲染）。
    const problems = validate(config)
    for (const key of keys) assert.ok(problems.some(problem => problem.key === key), `${label}: the browser reports ${key}`)
  }
})

test('every violation key the rules can emit has a dictionary entry in both locales', () => {
  // 规则模块是唯一产出方、字典是唯一渲染方：加一条规则漏了字典，这里红。
  for (const [label, config] of crossCases) {
    for (const violation of structuralViolations(config)) {
      assert.ok(typeof zh[violation.key] === 'string', `${label}: zh has ${violation.key}`)
      assert.ok(typeof en[violation.key] === 'string', `${label}: en has ${violation.key}`)
    }
  }
})

test('classifyHealth uses DSH own codes, not invented ones', () => {
  // DSH 的码是 AUTH / QUOTA（llm/src/error.ts 的 QUOTA_EXCEEDED_CODE），
  // 全树没有 AUTH_FAILED。写成不存在的码会让密钥失效永远不标记渠道异常。
  assert.equal(classifyHealth('AUTH'), 'unhealthy')
  assert.equal(classifyHealth('QUOTA'), 'unhealthy')
  assert.equal(classifyHealth('AUTH_FAILED'), undefined)
  assert.equal(classifyHealth('QUOTA_EXCEEDED'), undefined)
})

test('single-field bounds belong to the schema: it refuses each value the deleted guards used to catch', () => {
  // assertStructural 曾经自己拦这 8 个条件，而两条生产调用路径都先过 schema
  // （index.ts 读 Cordis 已校验值、Config(raw) 自己跑一遍），那些 guard 全是死
  // 分支——只在 schema 收紧时变成"接不住"的谎言。删掉之后这条用例钉住 schema
  // 真的拥有它们：任何一个条件被 schema 放行就红。
  const candidate = (over = {}) => ({ provider: 'p', model: 'm', maxRetries: 0, weight: 0, ...over })
  const chain = (over = {}, candidates = [candidate()]) => ({
    candidates, switchOn: {}, stickyTurns: 0, strategy: 'order', firstHopMaxRetries: 0, ...over,
  })
  const base = (over = {}) => ({ enabled: true, chain: chain(), ...over })
  const cases = [
    ['candidate.maxRetries < 0', base({ chain: chain({}, [candidate({ maxRetries: -1 })]) })],
    ['candidate.maxRetries > 99', base({ chain: chain({}, [candidate({ maxRetries: 100 })]) })],
    ['chain.firstHopMaxRetries > 99', base({ chain: chain({ firstHopMaxRetries: 100 }) })],
    ['chain.stickyTurns < 0', base({ chain: chain({ stickyTurns: -1 }) })],
    ['health.discover.intervalSeconds < 0', base({ health: { discover: { intervalSeconds: -1 } } })],
    ['health.probe.intervalSeconds < 0', base({ health: { probe: { intervalSeconds: -1 } } })],
    // schema 是 .min(2)，比曾经的 `< 1` guard 还严：1 也过不去。
    ['health.probe.timeoutSeconds < 2', base({ health: { probe: { timeoutSeconds: 1 } } })],
  ]
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  for (const [label, raw] of cases) {
    assert.ok(throws(() => Config(raw)), `${label}: the schema must refuse it, or a bound moved out of the schema`)
    // 同一份原始配置，换成结构校验要的输入形状（命名链 + 默认链 id）。
    assert.doesNotThrow(() => assertStructural(structural(raw.chain, { health: raw.health })),
      `${label}: assertStructural must not re-guard it — that guard is what made the function look stricter than the schema`)
  }
})

// ---- failover-history fold ----

/** Minimal committed-event shapes the fold reads. */
const header = (provider, model, reason, time = 1000) => ({
  type: 'request/header', time, data: { header: { config: { provider, model } }, reason },
})
const failedAttempt = (code, turn = 1, step = 1) => ({
  type: 'assistant/attempt', time: 1100, data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code } } } }] },
})
const okAttempt = (turn = 1, step = 1) => ({
  type: 'assistant/attempt', time: 1100, data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }] },
})
const message = (turn = 1, step = 1) => ({ type: 'assistant/message', time: 1200, data: { turn, step } })
const fold = (...events) => events.reduce(failoverHistoryProjection.apply, failoverHistoryProjection.init())

test('fold records a failover: from, to, code, settled', () => {
  const state = fold(
    { type: 'turn/start', time: 900, data: { turn: 1 } },
    { type: 'step/start', time: 950, data: { turn: 1, step: 1 } },
    header('p-a', 'm-a', 'initial'),
    failedAttempt('RATE_LIMIT'),
    header('p-b', 'm-b', 'change'),
    okAttempt(),
    message(),
  )
  assert.equal(state.entries.length, 1)
  assert.deepEqual(state.entries[0], {
    time: 1000, turn: 1, step: 1, from: 'p-a/m-a', to: 'p-b/m-b', code: 'RATE_LIMIT', settled: true,
  })
})

test('fold ignores a user-initiated switch (change without a failure)', () => {
  const state = fold(header('p-a', 'm-a', 'initial'), header('p-b', 'm-b', 'change'))
  assert.equal(state.entries.length, 0)
})

test('fold ignores series headers and successful attempts', () => {
  const state = fold(header('p-a', 'm-a', 'initial'), okAttempt(), header('p-a', 'm-a', 'series'))
  assert.equal(state.entries.length, 0)
})

test('a failure older than the previous header does not leak into the next switch', () => {
  const state = fold(
    header('p-a', 'm-a', 'initial'),
    failedAttempt('TIMEOUT'),
    header('p-b', 'm-b', 'change'),      // failover #1 (TIMEOUT)
    okAttempt(),
    message(),
    header('p-c', 'm-c', 'change'),      // no failure since the last header: a user switch
  )
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].to, 'p-b/m-b')
})

// 终态失败（不切换）之后用户自己换模型：header 的 reason 也是 'change'，任何 header
// 差异都是（agent.ts:643-648），所以判据不能只问"变更前有没有失败"——失败还必须是
// 同一步里发生的，否则用户的操作会被记成插件的 failover。
test('a user model switch after a terminal failure is not a failover', () => {
  const state = fold(
    { type: 'turn/start', time: 900, data: { turn: 1 } },
    { type: 'step/start', time: 950, data: { turn: 1, step: 1 } },
    header('p-a', 'm-a', 'initial'),
    failedAttempt('AUTH'),               // 终态：不切换，turn 在这里结束
    { type: 'turn/start', time: 1900, data: { turn: 2 } },
    { type: 'step/start', time: 1950, data: { turn: 2, step: 1 } },
    header('p-b', 'm-b', 'change'),      // 用户自己换的模型
  )
  assert.equal(state.entries.length, 0)
})

// 同 turn 内的 llm-retry 恢复：失败后同路由重试成功，之后用户换模型——那次切换
// 同样不该被记成 failover（失败属于上一步/上一轮，且 turn/start 已清掉未决失败）。
test('a recovered transient failure does not arm a later user switch', () => {
  const state = fold(
    { type: 'turn/start', time: 900, data: { turn: 1 } },
    { type: 'step/start', time: 950, data: { turn: 1, step: 1 } },
    header('p-a', 'm-a', 'initial'),
    failedAttempt('RATE_LIMIT'),
    okAttempt(),                          // llm-retry 同路由重试成功
    message(),
    { type: 'turn/start', time: 1900, data: { turn: 2 } },
    { type: 'step/start', time: 1950, data: { turn: 2, step: 1 } },
    header('p-b', 'm-b', 'change'),
  )
  assert.equal(state.entries.length, 0)
})

// settled 只归当轮：切过去的路由当轮就失败，之后任意一轮的成功消息不能把这条
// 旧条目标成"已兑现"。
test('a success in a later turn does not settle an older failover entry', () => {
  const state = fold(
    { type: 'turn/start', time: 900, data: { turn: 1 } },
    { type: 'step/start', time: 950, data: { turn: 1, step: 1 } },
    header('p-a', 'm-a', 'initial'),
    failedAttempt('RATE_LIMIT'),
    header('p-b', 'm-b', 'change'),
    failedAttempt('RATE_LIMIT'),          // 切过去也失败：条目保持未结算
    { type: 'turn/start', time: 1900, data: { turn: 2 } },
    { type: 'step/start', time: 1950, data: { turn: 2, step: 1 } },
    header('p-c', 'm-c', 'change'),       // 用户换模型（无同 step 失败）
    okAttempt(2, 1),
    message(2, 1),
  )
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].settled, false)
})

// 同 turn 内、跨 step 的成功不能结算旧条目：settle 原先只按 turn 过滤，于是
// step 2 在路由 C 上的成功会把 step 1 的 a→b 条目标成"已兑现"——而 b 从未应答。
// 记录路径（request/header 的 change 分支）本来就按 step 门控，settle 漏了。
test('a success in a later step of the same turn does not settle an older failover entry', () => {
  const state = fold(
    { type: 'turn/start', time: 100, data: { turn: 1 } },
    { type: 'step/start', time: 100, data: { turn: 1, step: 1 } },
    header('a', 'm', 'initial'),
    failedAttempt('RATE_LIMIT'),
    header('b', 'm', 'change'),
    failedAttempt('SERVER'),               // 切过去也失败：条目保持未结算
    { type: 'step/start', time: 600, data: { turn: 1, step: 2 } },
    header('c', 'm', 'change'),            // 用户/链在第二步换到 C
    message(1, 2),                         // step 2 的成功
  )
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].from, 'a/m')
  assert.equal(state.entries[0].to, 'b/m')
  assert.equal(state.entries[0].step, 1, 'the entry belongs to step 1')
  assert.equal(state.entries[0].settled, false, 'a step-2 success says nothing about whether a→b worked')
})

test('chained failovers each get an entry, unsettled when the chain dies', () => {  const state = fold(
    header('p-a', 'm-a', 'initial'),
    failedAttempt('RATE_LIMIT'),
    header('p-b', 'm-b', 'change'),
    failedAttempt('TIMEOUT'),
    header('p-c', 'm-c', 'change'),
    failedAttempt('SERVER'),
  )
  assert.equal(state.entries.length, 2)
  assert.equal(state.entries[0].settled, false)
  assert.equal(state.entries[1].code, 'TIMEOUT')
  assert.equal(state.entries[1].settled, false)
})

test('entries are bounded to MAX_ENTRIES', () => {
  let state = failoverHistoryProjection.init()
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    state = failoverHistoryProjection.apply(state, header(`p-${i}`, 'm', i === 0 ? 'initial' : 'change'))
    state = failoverHistoryProjection.apply(state, failedAttempt('RATE_LIMIT'))
  }
  assert.equal(state.entries.length, MAX_ENTRIES)
  assert.equal(state.entries[0].to, 'p-5/m')
  assert.equal(state.entries[MAX_ENTRIES - 1].to, `p-${MAX_ENTRIES + 4}/m`)
})

test('unrelated events return the same state reference', () => {
  const state = fold(header('p-a', 'm-a', 'initial'))
  assert.equal(failoverHistoryProjection.apply(state, { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } }), state)
})

test('the wire view returns the state-held array reference', () => {
  const state = fold(header('p-a', 'm-a', 'initial'), failedAttempt('RATE_LIMIT'), header('p-b', 'm-b', 'change'))
  assert.equal(failoverHistoryProjection.wire.view(state), state.entries)
})

test('failureCodeOfStream reads the terminal finish chunk', () => {
  assert.equal(failureCodeOfStream([{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['x'] }, { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } } }]), 'AUTH')
  assert.equal(failureCodeOfStream([{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }]), undefined)
  assert.equal(failureCodeOfStream([]), undefined)
})

test('projection key is namespaced and stateVersion is a positive integer', () => {
  assert.equal(FAILOVER_HISTORY_KEY, 'router/failover-history')
  assert.ok(Number.isSafeInteger(failoverHistoryProjection.stateVersion) && failoverHistoryProjection.stateVersion >= 1)
})

// ---- Channel Health unit tests ----
import { classifyHealth, routeKeyOf, channelHealthProjection, CHANNEL_HEALTH_KEY, pushTimelinePoint } from '../src/health.ts'

test('pushTimelinePoint keeps the newest observations and drops the oldest past both bounds', () => {
  let timeline
  for (let i = 0; i < 30; i++) {
    timeline = pushTimelinePoint(timeline, {
      time: 1000 + i * 10,
      status: i % 2 === 0 ? 'healthy' : 'degraded',
      latencyMs: 100,
    })
  }
  // 30 次观测都在保留窗口内、也低于条数上限，所以一条不丢——保留规则是年龄
  // 与条数，不是"最近 24 次"。
  assert.equal(timeline.length, 30)
  assert.equal(timeline[timeline.length - 1].time, 1000 + 29 * 10)
})

test('pushTimelinePoint drops an observation past the retention window', () => {
  const now = Date.now()
  const timeline = pushTimelinePoint(
    [{ time: now - (TIMELINE_RETENTION_SECONDS + 60) * 1000, status: 'healthy' }],
    { time: now, status: 'healthy' },
  )
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0].time, now)
})

test('pushTimelinePoint does not mutate the timeline it was given', () => {
  const original = [{ time: 1, status: 'healthy' }]
  const next = pushTimelinePoint(original, { time: 2, status: 'healthy' })
  assert.equal(original.length, 1)
  assert.equal(next.length, 2)
})

test('channelHealthProjection reads throughput from the usage beside message', () => {
  let state = channelHealthProjection.init()
  state = channelHealthProjection.apply(state, {
    type: 'step/start',
    time: 1000,
    data: { turn: 1, step: 1 },
  })
  state = channelHealthProjection.apply(state, {
    type: 'request/header',
    time: 1000,
    data: { reason: 'initial', header: { config: { provider: 'prov-fast', model: 'mod-fast' } } },
  })
  // 100 tokens over the 500ms the turn took = 200 tok/s.
  // `usage` is a sibling of `message` on the event data — core/session/src/types.ts:341-349.
  state = channelHealthProjection.apply(state, {
    type: 'assistant/message',
    time: 1500,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm1', role: 'assistant', content: [], source: { kind: 'model', provider: 'prov-fast', model: 'mod-fast' } },
      stream: [],
      usage: { inputTokens: 10, outputTokens: 100 },
    },
  })
  const rec = state.records['prov-fast/mod-fast']
  assert.ok(rec)
  assert.equal(rec.status, 'healthy')
  assert.equal(rec.latencyMs, 500)
  assert.equal(rec.throughputTps, 200)
  assert.equal(rec.timeline.length, 1)
  assert.equal(rec.timeline[0].throughputTps, 200)
})

test('channelHealthProjection ignores usage nested inside message', () => {
  // The wrong shape must yield no throughput rather than a silently wrong one:
  // a fixture that restates the implementation proves nothing when it changes.
  let state = channelHealthProjection.init()
  state = channelHealthProjection.apply(state, {
    type: 'step/start',
    time: 1000,
    data: { turn: 1, step: 1 },
  })
  state = channelHealthProjection.apply(state, {
    type: 'request/header',
    time: 1000,
    data: { reason: 'initial', header: { config: { provider: 'prov-fast', model: 'mod-fast' } } },
  })
  state = channelHealthProjection.apply(state, {
    type: 'assistant/message',
    time: 1500,
    data: { turn: 1, step: 1, message: { usage: { outputTokens: 100 } }, stream: [] },
  })
  const rec = state.records['prov-fast/mod-fast']
  assert.ok(rec)
  assert.equal(rec.throughputTps, undefined)
})

// 延迟锚点是 step/start，不是 request/header：稳态会话的 step 2..N 不出 header
// （agent.ts:635-651 的 requestHeaderLogged 置 true 后永不重置），按 header 锚定
// 会让工具循环的后续步把整个 turn 的时间算成自己的延迟。DSH 自己的 session-stats
// 用 step/start → assistant/message 并按 (turn, step) 门控
// （session-stats/src/projection.ts:133-149），这里照抄那个形状。
test('the health fold measures each step on its own step/start, not on the turn first header', () => {
  const ev = (type, time, data) => ({ type, time, data })
  const message = (turn, step, time, tokens) => ({
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      message: { source: { provider: 'stub-a', model: 'stub-model' } },
      stream: [],
      usage: { inputTokens: 4, outputTokens: tokens },
    },
  })
  const events = [
    ev('step/start', 1000, { turn: 1, step: 1 }),
    ev('request/header', 1100, { header: { config: { provider: 'stub-a', model: 'stub-model' } }, reason: 'initial' }),
    // 步内退避：llm-retry 的两条记录折叠器不读，但时间确实花在这一步里——DSH 自己
    // 的模型时间定义包含它（"survives an in-step llm/retry"）。
    ev('llm/retry', 1500, { retryId: 'r1', turn: 1, step: 1, provider: 'stub-a', retry: 1, delayMs: 500 }),
    ev('llm/retry-started', 2000, { retryId: 'r1', turn: 1, step: 1, retry: 1 }),
    message(1, 1, 2600, 100),
    // 第二步：工具花了 2.4s，没有新 header（header 未变、requestHeaderLogged 已置位）。
    ev('step/start', 5000, { turn: 1, step: 2 }),
    message(1, 2, 5500, 100),
  ]
  let state = channelHealthProjection.init()
  for (const event of events) state = channelHealthProjection.apply(state, event)
  const record = state.records['stub-a/stub-model']
  assert.equal(record.timeline.length, 2)
  // 第一步：从本步的 header 算起（1500ms，含步内退避）。
  assert.equal(record.timeline[0].latencyMs, 1500)
  // 第二步：只算本步的 500ms。修复前它是 4400——把 step 1 的模型时间与工具执行
  // 时间全算进来，吞吐因此虚高 8.8 倍（22.7 对 200.0）。
  assert.equal(record.timeline[1].latencyMs, 500)
  assert.equal(record.timeline[1].throughputTps, 200)
  // 门控是双向的：不属于任何开着的步的事件不产出测量值（记录照建——这条路确实
  // 应答了，只是代价无从计算）。
  const orphan = channelHealthProjection.apply(
    channelHealthProjection.apply(channelHealthProjection.init(), events[1]),
    message(9, 9, 9999, 100),
  )
  assert.equal(orphan.records['stub-a/stub-model']?.latencyMs, undefined, 'a message from no open step measures nothing')
  assert.equal(orphan.records['stub-a/stub-model']?.throughputTps, undefined)
})

test('classifyHealth scores only faults that belong to the channel', () => {  assert.equal(classifyHealth('RATE_LIMIT'), 'degraded')
  assert.equal(classifyHealth('SERVER'), 'unhealthy')
  assert.equal(classifyHealth('TIMEOUT'), 'unhealthy')
  assert.equal(classifyHealth('TRANSPORT'), 'unhealthy')
  assert.equal(classifyHealth('AUTH'), 'unhealthy')
  assert.equal(classifyHealth('QUOTA'), 'unhealthy')
  // A rejected request, an empty reply and a user-initiated abort say nothing
  // about the channel; scoring them would paint a working route red.
  assert.equal(classifyHealth('INVALID_REQUEST'), undefined)
  assert.equal(classifyHealth('EMPTY_RESPONSE'), undefined)
  assert.equal(classifyHealth('ABORTED'), undefined)
  assert.equal(classifyHealth('NO_ADAPTER'), undefined)
  // The same three codes the probe must report as `unavailable`: a call that
  // never happened indicts the channel no more here than it does there.
  assert.equal(classifyHealth('MISSING_CREDENTIAL'), undefined)
  assert.equal(classifyHealth('INVALID_CREDENTIAL'), undefined)
})

test('routeKeyOf formats provider and model as provider/model', () => {
  assert.equal(routeKeyOf('deepseek-official', 'deepseek-chat'), 'deepseek-official/deepseek-chat')
})

test('channelHealthProjection folds session headers and attempts into channel records', () => {
  assert.equal(CHANNEL_HEALTH_KEY, 'router/channel-health')
  let state = channelHealthProjection.init()
  assert.deepEqual(state.records, {})

  // 1. Initial request header
  state = channelHealthProjection.apply(state, {
    type: 'step/start',
    time: 1000,
    data: { turn: 1, step: 1 },
  })
  state = channelHealthProjection.apply(state, {
    type: 'request/header',
    time: 1000,
    data: { reason: 'initial', header: { config: { provider: 'prov-1', model: 'mod-1' } } },
  })
  assert.equal(state.currentRoute, 'prov-1/mod-1')

  // 2. Failed attempt with 500
  state = channelHealthProjection.apply(state, {
    type: 'assistant/attempt',
    time: 1500,
    data: {
      stream: [
        { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } } },
      ],
    },
  })
  assert.ok(state.records['prov-1/mod-1'])
  assert.equal(state.records['prov-1/mod-1'].status, 'unhealthy')
  assert.equal(state.records['prov-1/mod-1'].lastError, 'SERVER')

  // 3. Switch to candidate 2
  state = channelHealthProjection.apply(state, {
    type: 'request/header',
    time: 2000,
    data: { reason: 'change', header: { config: { provider: 'prov-2', model: 'mod-2' } } },
  })

  // 4. Successful assistant message
  state = channelHealthProjection.apply(state, {
    type: 'assistant/message',
    time: 2400,
    data: { turn: 1, step: 1, message: { content: [] }, stream: [], usage: { inputTokens: 5, outputTokens: 40 } },
  })
  assert.ok(state.records['prov-2/mod-2'])
  assert.equal(state.records['prov-2/mod-2'].status, 'healthy')
  assert.equal(state.records['prov-2/mod-2'].latencyMs, 400)
  // 40 tokens over 400ms = 100 tok/s.
  assert.equal(state.records['prov-2/mod-2'].throughputTps, 100)
  // A settlement clears the error the failed attempt left behind.
  assert.equal(state.records['prov-2/mod-2'].lastError, undefined)

  // Wire view returns records
  assert.equal(channelHealthProjection.wire.view(state), state.records)
})

test('channelHealthProjection leaves the record alone for a non-channel fault', () => {
  let state = channelHealthProjection.init()
  state = channelHealthProjection.apply(state, {
    type: 'step/start',
    time: 1000,
    data: { turn: 1, step: 1 },
  })
  state = channelHealthProjection.apply(state, {
    type: 'request/header',
    time: 1000,
    data: { reason: 'initial', header: { config: { provider: 'prov-1', model: 'mod-1' } } },
  })
  const before = state
  state = channelHealthProjection.apply(state, {
    type: 'assistant/attempt',
    time: 1500,
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } } } },
      ],
    },
  })
  assert.deepEqual(state.records, {})
  assert.equal(state, before)
})

test('channelHealthProjection returns the same state reference for events it ignores', () => {
  const state = channelHealthProjection.init()
  for (const type of ['turn/start', 'tool/call', 'user/message', 'step/start']) {
    assert.equal(channelHealthProjection.apply(state, { type, time: 1, data: {} }), state)
  }
  // A settlement with no preceding header has no route to attribute to.
  assert.equal(
    channelHealthProjection.apply(state, { type: 'assistant/message', time: 1, data: { message: {}, stream: [] } }),
    state,
  )
})

test('channelHealthProjection tolerates a header that names no route', () => {
  const state = channelHealthProjection.init()
  const next = channelHealthProjection.apply(state, {
    type: 'request/header',
    time: 1,
    data: { reason: 'initial', header: { config: { provider: '', model: '' } } },
  })
  assert.equal(next, state)
})

// ---- the round-robin cursor ----
// 轮询游标按请求推进（每个 step 一次 startStep），重试不推进——所以同一步的
// llm-retry 重试不会把链拧走。组合测试够不到它：一次 headless 只有一个 step，
// 要第二个请求得让 stub 驱动一次工具循环。

test('the cursor advances one step per request and wraps, per session', () => {
  const states = new RouterState()
  const session = { id: {} }
  assert.equal(states.nextCursor(session, 2), 0, 'the first request of a session starts at the head')
  assert.equal(states.nextCursor(session, 2), 1, 'the next request advances one step')
  assert.equal(states.nextCursor(session, 2), 0, 'and wraps at the chain length')
  assert.equal(states.nextCursor({ id: {} }, 2), 0, 'another session counts from its own head')
})

test('a single-candidate chain never moves the cursor', () => {
  const states = new RouterState()
  const session = { id: {} }
  assert.equal(states.nextCursor(session, 1), 0)
  assert.equal(states.nextCursor(session, 1), 0)
})

// ---- turn-accumulated image conditions (RouterState) ----// 图片条件按 turn 累积：pre-step 的 messages 只是本步新 claimed 的输入，一个
// 带图 turn 的第二步之后通常是空的——按 step 判会让工具循环的第二步滑回文本
// 模型，而图片还在请求历史里（read_image 也会再次撞门禁）。

const turnConditions = (hasImages, projectedTokens) => ({ hasImages, projectedTokens })
// RouterState 只按身份键控，任何对象都能当 Agent 用。
const agentKey = () => ({ id: {} })

test('image conditions accumulate across the steps of one turn', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(true, 100))
  // 第二步没有新的 claimed 输入，但这一轮已经有图。
  assert.equal(states.conditionsFor(agent, 1, 2).hasImages, true)
  // 新轮次重新评估，不继承上一轮。
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, false)
})

test('projectedTokens stays step-scoped while hasImages is turn-scoped', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(false, 500))
  assert.equal(states.conditionsFor(agent, 1, 1).projectedTokens, 500)
  // 第二步带来图片：整轮按有图算，token 估算换成本步新鲜的数值。
  states.noteConditions(agent, 1, 2, turnConditions(true, 900))
  assert.equal(states.conditionsFor(agent, 1, 2).hasImages, true)
  assert.equal(states.conditionsFor(agent, 1, 2).projectedTokens, 900)
})

test('a no-image turn clears the accumulated image condition', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(true, undefined))
  states.noteConditions(agent, 2, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, false)
})

test('stickyTurns 0 reverts on the very next no-image turn', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.setStickyTurns(agent, 0)
  states.noteConditions(agent, 1, 1, turnConditions(true, undefined))
  states.noteConditions(agent, 2, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, false)
})

test('stickyTurns holds the image condition for N no-image turns, then reverts', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.setStickyTurns(agent, 2)
  states.noteConditions(agent, 1, 1, turnConditions(true, undefined))
  states.noteConditions(agent, 2, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, true)
  states.noteConditions(agent, 3, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 3, 1).hasImages, true)
  states.noteConditions(agent, 4, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 4, 1).hasImages, false)
})

// 生产时序：pre-step 先于 agent/request，而 sticky 值只在 request 里写入
// （resolveChain 之后）。所以会话的第一个带图轮，noteConditions 时 sticky 还是 0。
// setStickyTurns 必须把当前轮刚写的窗口补上，否则紧随的无图追问不粘——这一条不预置
// setStickyTurns，复现的就是"新会话第一条消息带图"的真实顺序。
test('the session first image turn still arms the sticky window (pre-step precedes the request)', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(true, undefined))
  assert.equal(states.conditionsFor(agent, 1, 1).hasImages, true)
  // 此刻还没有任何 setStickyTurns：链未解析。请求到达、链解析出来后才写入。
  states.setStickyTurns(agent, 2)
  states.noteConditions(agent, 2, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, true, 'the first no-image follow-up sticks')
  states.noteConditions(agent, 3, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 3, 1).hasImages, true)
  states.noteConditions(agent, 4, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 4, 1).hasImages, false)
})

// 生产时序的另一半：`index.ts` 在每个 step 的第一次 request 里都调一次
// setStickyTurns（不只是会话开头）。补满因此必须只认"本轮自有图"，否则纯文本会话
// 每步都把窗口补满，hasImages 从第 2 轮起恒真，`needs.images: false` 的候选永不入选。
test('a text-only turn cannot refill the sticky window (stickyTurns is written every step)', () => {
  const states = new RouterState()
  const agent = agentKey()
  for (let turn = 1; turn <= 4; turn += 1) {
    states.noteConditions(agent, turn, 1, turnConditions(false, undefined))
    assert.equal(states.conditionsFor(agent, turn, 1).hasImages, false, `turn ${turn} is text-only and must not read as image-bearing`)
    states.setStickyTurns(agent, 2) // 这一轮那次 agent/request 的写入
  }
})

test('one image turn fills the window once, and it still decays under the same timing', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(true, undefined))
  states.setStickyTurns(agent, 2)
  states.noteConditions(agent, 2, 1, turnConditions(false, undefined))
  states.setStickyTurns(agent, 2)
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, true)
  states.noteConditions(agent, 3, 1, turnConditions(false, undefined))
  states.setStickyTurns(agent, 2)
  assert.equal(states.conditionsFor(agent, 3, 1).hasImages, true)
  states.noteConditions(agent, 4, 1, turnConditions(false, undefined))
  states.setStickyTurns(agent, 2)
  assert.equal(states.conditionsFor(agent, 4, 1).hasImages, false, 'two text turns after the image must clear it')
})

test('an image turn refreshes the sticky window', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.setStickyTurns(agent, 1)
  states.noteConditions(agent, 1, 1, turnConditions(true, undefined))
  states.noteConditions(agent, 2, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 2, 1).hasImages, true)
  // 第 2 轮又带来图片：窗口重新计，后面还能再粘一轮。
  states.noteConditions(agent, 3, 1, turnConditions(true, undefined))
  states.noteConditions(agent, 4, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 4, 1).hasImages, true)
  states.noteConditions(agent, 5, 1, turnConditions(false, undefined))
  assert.equal(states.conditionsFor(agent, 5, 1).hasImages, false)
})

test('an image tool result marks the turn image-bearing for later steps', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(false, undefined))
  // read_image 的图经工具结果进来：本步请求里还没有它，下一步才有。
  states.noteToolResult(agent, 1, true)
  assert.equal(states.conditionsFor(agent, 1, 2).hasImages, true)
})

test('a text-only tool result leaves the turn condition alone', () => {
  const states = new RouterState()
  const agent = agentKey()
  states.noteConditions(agent, 1, 1, turnConditions(false, undefined))
  states.noteToolResult(agent, 1, false)
  assert.equal(states.conditionsFor(agent, 1, 2).hasImages, false)
})

test('toolResultHasImage reads the nested tool-result content', () => {
  assert.equal(
    toolResultHasImage({ message: { content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'x' }] }] } }),
    false,
  )
  assert.equal(
    toolResultHasImage({ message: { content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'image', attachment: {} }] }] } }),
    true,
  )
  // 顶层直接是图片块（非工具结果路径）也算。
  assert.equal(toolResultHasImage({ message: { content: [{ type: 'image', attachment: {} }] } }), true)
  assert.equal(toolResultHasImage({ message: { content: [] } }), false)
  assert.equal(toolResultHasImage({}), false)
  assert.equal(toolResultHasImage(undefined), false)
})

// ---- 截断记录：按 step 存，不是一个槽 ----

test('an auxiliary message cannot erase the truncated step it did not produce', () => {
  // `assistant/message` 不只属于 Agent 主请求：会话标题、压缩这些辅助调用也写一条。
  // 单槽记录会被后到的那条覆盖成 truncated:false，自动续跑随即静默不发生——用户只
  // 看到 DSH 原生的"发送继续"，而插件一声不响。
  const states = new RouterState()
  const agent = agentKey()
  states.noteTruncation(agent, { turn: 1, step: 3, provider: 'p', model: 'm', truncated: true })
  states.noteTruncation(agent, { turn: 1, step: 4, provider: 'p', model: 'title', truncated: false })
  assert.equal(states.truncationOf(agent, 1, 3)?.truncated, true, '别的 step 的消息冲不掉本 step 的事实')
  assert.equal(states.truncationOf(agent, 1, 4)?.truncated, false)
  // 同一个 step 的后一条覆盖前一条：真·后写赢。
  states.noteTruncation(agent, { turn: 1, step: 3, provider: 'p', model: 'm', truncated: false })
  assert.equal(states.truncationOf(agent, 1, 3)?.truncated, false)
  // 换轮即失效。
  states.noteTruncation(agent, { turn: 2, step: 1, provider: 'p', model: 'm2', truncated: true })
  assert.equal(states.truncationOf(agent, 1, 3), undefined)
  assert.equal(states.truncationOf(agent, 2, 1)?.truncated, true)
})

// ---- stickyTurns structural validation ----

test('a negative stickyTurns is refused by the schema, not by a structural guard', () => {
  // 曾经 assertStructural 自己拦 stickyTurns < 0——而两条生产调用路径都先过
  // schema（index.ts 读 Cordis 已校验值、Config(raw) 自己跑一遍），.min(0)
  // 永远拦在前面，那个 guard 是死分支，只在 schema 收紧时变成"接不住"的谎言。
  // 单字段边界归 schema：这里钉住它真的归 schema。
  assert.throws(() => Config({
    chain: {
      candidates: [{ provider: 'p', model: 'm', maxRetries: 0, weight: 0 }],
      switchOn: { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false },
      firstHopMaxRetries: 0,
      stickyTurns: -1,
    },
  }), /stickyTurns/)
})

test('assertStructural accepts stickyTurns 0 and a positive value', () => {
  const so = { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false }
  const chain = (stickyTurns) => ({
    candidates: [{ provider: 'p', model: 'm', maxRetries: 0, weight: 0 }],
    switchOn: so,
    firstHopMaxRetries: 0,
    stickyTurns,
  })
  assertStructural(structural(chain(0)))
  assertStructural(structural(chain(3)))
})

// ---- the probe (pure paths the integration suite cannot reach) ----

/**
 * An llm face that answers however the case asks. The stream factory receives
 * the request options, so a fake stream can observe the probe's signal the way
 * a real adapter does — which is also what lets an abandoned stream finish.
 */
function fakeLlm({ makeStream, prepareError } = {}) {
  return {
    prepareCall: () => prepareError === undefined
      ? Promise.resolve({ config: { provider: 'p', model: 'm' }, stream: (options) => makeStream(options.signal) })
      : Promise.reject(prepareError),
  }
}

/**
 * A stream that never produces and never ends until the signal aborts it.
 *
 * The shape follows the REAL adapter, not this plugin's reader: on abort the
 * adapter throws, `adapterStream` catches it (llm/src/index.ts:1111-1114) and
 * yields `adapterFailureChunk` — an in-band `kind:'aborted'` finish
 * (llm/src/index.ts:1161-1169) — rather than rejecting the iterator. DSH's own
 * spec for that is llm-pi-ai/tests/adapter.spec.ts:1052-1067. A fake that
 * rejects here instead exercises only the catch branch and leaves the finish
 * branch untested — which is how the timeout path stayed broken.
 */
const neverEnding = (signal) => (async function* () {
  await new Promise((resolve) => {
    if (signal?.aborted === true) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
})()

const reachableStream = () => (async function* () {
  yield { type: 'text-delta', index: 0, text: 'x' }
})()

const route = { provider: 'p', model: 'm' }

test('probeRoute measures the first content byte and reports reachable', async () => {
  const result = await probeRoute(fakeLlm({ makeStream: () => reachableStream() }), route, 'ping', 8)
  assert.equal(result.kind, 'reachable')
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(result.error, undefined)
})

test('probeRoute reports an error finish as unreachable with its code', async () => {
  const failing = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'denied' } } }
  })()
  const result = await probeRoute(fakeLlm({ makeStream: () => failing }), route, 'ping', 8)
  assert.equal(result.kind, 'unreachable')
  assert.equal(result.error, 'AUTH')
  assert.equal(result.latencyMs, undefined, 'a route that never answered has no TTFT')
})

test('probeRoute reports a thrown adapter error by its code', async () => {
  const thrown = Object.assign(new Error('stub refused'), { code: 'RATE_LIMIT' })
  const result = await probeRoute({
    prepareCall: () => Promise.resolve({
      config: {},
      stream: () => { throw thrown },
    }),
  }, route, 'ping', 8)
  assert.equal(result.kind, 'unreachable')
  assert.equal(result.error, 'RATE_LIMIT')
})

test('probeRoute times out as unreachable, never as a silent hang', async () => {
  const started = Date.now()
  const result = await probeRoute(fakeLlm({ makeStream: (signal) => neverEnding(signal) }), route, 'ping', 1)
  assert.equal(result.kind, 'unreachable')
  assert.equal(result.error, 'TIMEOUT')
  assert.ok(Date.now() - started < 5000, 'the deadline fired instead of waiting on the stream')
})

test('probeRoute cuts an adapter that ignores the abort instead of hanging on it', async () => {
  // `neverEnding` 会看 signal，覆盖的是"配合的适配器"。这一条模拟无视 abort 的那种：
  // 不出字节、不结束、也不抛。没有 race 的实现会永久挂在这里——而且挂住的是
  // `probeInFlight`，之后每一次定时探测都被静默跳过（index.ts 的 tick 守卫）。
  const deaf = (async function* () {
    await new Promise(() => {})
    yield { type: 'text-delta', index: 0, text: 'never' }
  })()
  const started = Date.now()
  const result = await probeRoute(fakeLlm({ makeStream: () => deaf }), route, 'ping', 1)
  assert.equal(result.kind, 'unreachable')
  assert.equal(result.error, 'TIMEOUT')
  assert.ok(Date.now() - started < 5000, 'the race must beat an adapter that never settles')
})

test('probeRoute cuts a prepare phase that never resolves', async () => {
  // 同一条边界的第二个 await：`prepareCall` 也可能在流存在之前就悬挂。
  const started = Date.now()
  const result = await probeRoute({ prepareCall: () => new Promise(() => {}) }, route, 'ping', 1)
  assert.equal(result.kind, 'unreachable')
  assert.equal(result.error, 'TIMEOUT')
  assert.ok(Date.now() - started < 5000, 'the race must cover the prepare phase too')
})

test('probeRoute reads a route it cannot even call as unavailable, not as a fault', async () => {
  const result = await probeRoute(fakeLlm({ prepareError: new Error('no adapter') }), route, 'ping', 8)
  assert.equal(result.kind, 'unavailable')
  assert.match(result.error ?? '', /no adapter/)
})

// The boundary `types.ts:30-34` draws: `unreachable` is reserved for "the call
// was made and the endpoint, the credential, or the model refused it". A code
// DSH raises while *assembling* the call means no request ever existed, so it
// must land on `unavailable` — otherwise a profile that never registered the
// provider, or one with no key stored, is painted as a red channel fault.
//
// Both delivery shapes are real and both are pinned here:
//   - `prepareCall` rejects outright (`llm/src/index.ts:995` for `NO_ADAPTER`);
//   - the adapter fails inside the stream and `adapterStream` converts the
//     throw into an in-band error finish (`llm/src/index.ts:1113,1161`) — that
//     is how a keyless `deepseek-official` reports `MISSING_CREDENTIAL`, from
//     `llm-deepseek-api-key/src/index.ts:30`.
test('probeRoute reads a provider with no registered adapter as unavailable', async () => {
  const thrown = Object.assign(
    new Error('no adapter registered for provider "real-a"'),
    { code: 'NO_ADAPTER' },
  )
  const result = await probeRoute({ prepareCall: () => Promise.reject(thrown) }, route, 'ping', 8)
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.error, 'NO_ADAPTER')
})

test('probeRoute reads a route with no credential as unavailable, in band', async () => {
  const keyless = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'no key' } } }
  })()
  const result = await probeRoute(fakeLlm({ makeStream: () => keyless }), route, 'ping', 8)
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.error, 'MISSING_CREDENTIAL')
  assert.equal(result.latencyMs, undefined, 'a route that never answered has no TTFT')
})

test('probeRoute reads a stored credential no header can carry as unavailable', async () => {
  // `assertUsableApiKey` (llm/src/index.ts:151) refuses a blank or
  // header-hostile key before any request is built — the same class.
  const unusable = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'blank' } } }
  })()
  const result = await probeRoute(fakeLlm({ makeStream: () => unusable }), route, 'ping', 8)
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.error, 'INVALID_CREDENTIAL')
})

test('probeRoute keeps a refusal that really left the Host unreachable', async () => {
  // The counterpart: the classification is per code, not a blanket downgrade.
  // `AUTH` means a request went out and the endpoint refused it, so it stays a
  // fault — in band and thrown alike.
  const denied = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'denied' } } }
  })()
  const inBand = await probeRoute(fakeLlm({ makeStream: () => denied }), route, 'ping', 8)
  assert.equal(inBand.kind, 'unreachable')
  assert.equal(inBand.error, 'AUTH')
  const thrown = Object.assign(new Error('refused'), { code: 'TRANSPORT' })
  const raised = await probeRoute({
    prepareCall: () => Promise.resolve({ config: {}, stream: () => { throw thrown } }),
  }, route, 'ping', 8)
  assert.equal(raised.kind, 'unreachable')
  assert.equal(raised.error, 'TRANSPORT')
})

test('probeRoute stops when the caller cancels, and says so', async () => {
  const controller = new AbortController()
  const running = probeRoute(fakeLlm({ makeStream: (signal) => neverEnding(signal) }), route, 'ping', 8, controller.signal)
  controller.abort()
  const result = await running
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.error, 'cancelled')
})

test('an in-band aborted finish is classified by who aborted, not by its code', async () => {
  // 真实适配器在 abort 时 yield 一个 kind:'aborted' 的 finish，failure.code 是
  // 适配器自己规范化出来的（llm-deepseek 把它映射成 ABORTED，别的适配器可能给
  // 别的码）——所以分类必须看"谁按的"：探针自己的 deadline 是渠道事实
  // （unreachable/TIMEOUT），调用方取消是调用方的事（unavailable/cancelled）。
  // 按码分会把超时判成 cancelled，也会把取消判成一次失败的调用。
  const aborting = (code) => (signal) => (async function* () {
    await new Promise((resolve) => {
      if (signal?.aborted === true) resolve()
      else signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code, message: 'aborted' } } }
  })()
  const timedOut = await probeRoute(fakeLlm({ makeStream: aborting('UNKNOWN') }), route, 'ping', 1)
  assert.equal(timedOut.kind, 'unreachable')
  assert.equal(timedOut.error, 'TIMEOUT')
  const controller = new AbortController()
  const running = probeRoute(fakeLlm({ makeStream: aborting('UNKNOWN') }), route, 'ping', 8, controller.signal)
  controller.abort()
  const cancelled = await running
  assert.equal(cancelled.kind, 'unavailable')
  assert.equal(cancelled.error, 'cancelled')
})

test('probeRoute reports a stream that ends empty as unavailable, not as a fault', async () => {
  const empty = (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const result = await probeRoute(fakeLlm({ makeStream: () => empty }), route, 'ping', 8)
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.error, 'empty stream')
})

test('probePromptFor uses the per-route override, else the shared default', () => {
  const overrides = [{ route: 'p/m', prompt: 'hi there' }]
  assert.equal(probePromptFor(route, '1', overrides), 'hi there')
  assert.equal(probePromptFor({ provider: 'p', model: 'other' }, '1', overrides), '1')
  assert.equal(probePromptFor(route, '1', []), '1')
})

// ---- the capability pre-check's three tiers ----

test('a pre-check failure is tiered by who can fix it, and an unknown code gets no tier', () => {  // 定案依据 docs/design/open-questions.md 第五节第 3 项：压成一句"不支持当前
  // 请求参数"会把一个配错的 provider 说成这条链的问题——而这条 notice 是
  // durable 的，指错了就一直在会话历史里。
  assert.equal(precheckTierOf('UNSUPPORTED_REASONING_EFFORT'), 'request-shape')
  for (const code of ['NO_ADAPTER', 'INVALID_CONFIG', 'UNKNOWN_MODEL']) {
    assert.equal(precheckTierOf(code), 'route-missing', `${code} is fixed on the Models page, not in the chain`)
  }
  // normalizeModelInfo 全家：同一个校验器为"适配器返回的元数据不合形状"抛的四个码。
  for (const code of ['INVALID_MODEL_INFO', 'INVALID_MODEL_CONTEXT', 'INVALID_MODEL_MAX_TOKENS', 'INVALID_MODEL_REASONING']) {
    assert.equal(precheckTierOf(code), 'adapter-defect', `${code} is the adapter breaking its own contract`)
  }
  // 认不出的码不编档：插件不知道谁能修它，编一档就是换一种说法的谎。
  for (const code of ['PI_AI_ERROR', 'AUTH', 'TRANSPORT', 'ABORTED']) {
    assert.equal(precheckTierOf(code), undefined, `${code} must keep the generic notice`)
  }
})

// ---- the attempt budget: a capped last candidate is not fired once more ----

test('the last candidate is not fired once past its cap, and neither is a lone one', () => {
  // C2：`planFire` 在末位候选被 cap 时置 exhausted、attemptsOnCandidate 仍 +1，
  // 而第一个能阻止这次发火的决策点（decideRecovery）在下一次失败后才跑——多打的
  // 那一次已经打完，且 advanced===false 连 notice 都不发，用户完全看不见。
  // 修法把"还能不能发"提成 hasNextCandidate 谓词，由 decideRecovery 在授权下一次
  // 发火之前判（且只授权落在另一条候选上的发火）。这里复现 index.ts 的发射循环，
  // 判据全部取自生产函数本身
  // （planFire / isSwitchOnEligible / decideRecovery），不另写一套停止条件。
  // 2026-10-20 删掉整请求总上限后，边界只剩"候选 × 各自次数"。
  const chainOf = (n, maxAttempts) => ({
    candidates: Array.from({ length: n }, (_, i) => ({ provider: `c${i}`, model: 'm', maxAttempts })),
    order: Array.from({ length: n }, (_, i) => i),
    switchOn: { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false, auth: true, quota: true },
    immediateSwitch: [],
    stickyTurns: 0,
    strategy: 'order',
  })
  // 复现真实的发射循环：planFire → 失败 → decideBeforeInner（额度未尽就 delegate，
  // 否则自己裁决）→ 被 delegate 时由 llm-retry 回答（inner='retry' 或放弃）。
  // 判据全部取自生产函数，不另写一套停止条件。
  const replay = (n, maxAttempts, code, inner) => {
    let state = startStep(1, 1, chainOf(n, maxAttempts), { hasImages: false, projectedTokens: undefined }, 0)
    const calls = []
    for (let guard = 0; guard < 30; guard += 1) {
      const plan = planFire(state, isSwitchOnEligible(state.chain, code))
      state = plan.state
      calls.push(plan.state.index)
      const before = decideBeforeInner(state, code, false)
      const ruling = before.kind === 'delegate'
        ? decideAfterInner(state, code, false, inner)
        : before
      // 自己重试与放行内层一样，都是"下一发仍在这条候选上"。
      if (ruling.kind === 'honor' || ruling.kind === 'retry-self') { state.pendingAdvance = false; continue }
      if (ruling.kind === 'advance') { state.pendingAdvance = true; continue }
      break
    }
    return { calls, finalState: state }
  }
  // 每候选恰好一次：总数 = 各候选上限之和，一次不多。
  const three = replay(3, 1, 'AUTH', 'retry')
  assert.deepEqual(three.calls, [0, 1, 2])
  assert.equal(three.finalState.totalAttempts, 3)
  // 单候选链（合法形态）同样不再打第二次。
  assert.deepEqual(replay(1, 1, 'AUTH', 'retry').calls, [0])
  // cap 2 × 3 候选：每候选两次，总共六次真实调用。
  assert.deepEqual(replay(3, 2, 'AUTH', 'retry').calls, [0, 0, 1, 1, 2, 2])
  // 2026-10-21 起内层是否愿意重试与该码无关：勾选的码由路由器自己重试，
  // 次数就是配置的次数。同一个 AUTH 在 llm-retry 放弃时也必须打满两次——
  // 这正是"填 2 就是 2"与旧的 1+min(2,0) 的分界。
  assert.deepEqual(replay(3, 2, 'AUTH', undefined).calls, [0, 0, 1, 1, 2, 2])
  // 不该切换的码：llm-retry 继续打同一条路由（既有意图），恢复监听终态——
  // 这条路径不产出 C2 形状，钉住它没被 hasNextCandidate 顺手改掉。
  const capped = { ...startStep(1, 1, chainOf(1, 1), { hasImages: false, projectedTokens: undefined }, 0), attemptsOnCandidate: 1, totalAttempts: 1 }
  const plan = planFire(capped, false)
  assert.equal(plan.state.exhausted, false, 'a non-eligible failure leaves the cursor alone for llm-retry')
  assert.equal(plan.state.attemptsOnCandidate, 2)
  assert.equal(decideRecovery(plan.state, 'INVALID_REQUEST', false), 'terminal')
})

// ---- the connectivity check's classification (the Host side) ----

/**
 * An llm face with a configurable-provider directory and one discovery answer
 * per namespace. `answer` may return a model list or throw, which is how a
 * real discovery refuses.
 */
function discoveryLlm({ directory = [], answers = {}, settings } = {}) {
  const asked = []
  return {
    asked,
    listConfigurableProviders: () => directory,
    discoverModels: (settingsNs, request, signal) => {
      // signal 只在调用方真的传了才记录：既有用例断言 asked 的精确形状，
      // 一个恒常的 undefined 键会把它们全打红。
      asked.push(signal === undefined ? { settingsNs, request } : { settingsNs, request, signal })
      const answer = answers[settingsNs]
      if (answer === undefined) {
        // Exactly what LlmRuntime does when no discovery is registered for the
        // namespace (packages/llm/llm/src/index.ts:594-597).
        throw Object.assign(new Error(`no model discovery is registered for "${settingsNs}"`), { code: 'NO_DISCOVERY' })
      }
      // A function answer is the discovery itself: calling it is what lets a
      // case make the refusal happen on the call rather than before it. It gets
      // the signal the plugin handed over, which is the fused one (./deadline.ts)
      // rather than the caller's own.
      return typeof answer === 'function' ? answer(signal) : answer
    },
  }
}

const checkRoute = { provider: 'deepseek-official', model: 'deepseek-chat' }

test('checkConnectivity reports a route whose endpoint lists the model as reachable', async () => {
  const llm = discoveryLlm({
    directory: [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'ns-a', settingsPath: [] }],
    answers: { 'ns-a': Promise.resolve([{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]) },
  })
  const verdict = await checkConnectivity(llm, undefined, checkRoute)
  assert.deepEqual(verdict, { provider: 'deepseek-official', model: 'deepseek-chat', kind: 'reachable' })
  // The signal is the fused one, so it is asserted by behavior elsewhere rather
  // than by identity here.
  assert.deepEqual(llm.asked.map(({ settingsNs, request }) => ({ settingsNs, request })),
    [{ settingsNs: 'ns-a', request: { provider: 'deepseek-official' } }],
    'the request names the provider; the namespace comes from the directory entry')
})

test('checkConnectivity reads the stored baseURL out of the settings namespace', async () => {
  // The settingsPath walk is the plugin's own: the directory entry says where
  // inside the namespace the profile lives, and only the Host can read it.
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: ['providers', 'gw'] }],
    answers: { 'ns-a': Promise.resolve([{ id: 'm' }]) },
  })
  await checkConnectivity(llm, {
    describe: () => [{ ns: 'ns-a', value: { providers: { gw: { baseURL: 'https://gw.example/v1' } } } }],
  }, { provider: 'gw', model: 'm' })
  assert.deepEqual(llm.asked[0].request, { provider: 'gw', baseURL: 'https://gw.example/v1' })
})

test('checkConnectivity reports an endpoint that answered without this model as notAdvertised', async () => {
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
    answers: { 'ns-a': Promise.resolve([{ id: 'other' }, { id: 'another' }]) },
  })
  const verdict = await checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' })
  assert.equal(verdict.kind, 'notAdvertised')
  assert.equal(verdict.advertised, 2)
})

test('checkConnectivity reads a namespace with no registered discovery as unavailable, not as a refusal', async () => {
  // The whole DeepSeek family: `registerDeepSeekProvider` registers an adapter
  // and never a model discovery (llm-deepseek/src/host.ts:55), so the provider
  // is configurable and usable while a connectivity check is structurally
  // impossible. Reporting that as "the endpoint did not answer" accuses an
  // endpoint that was never contacted.
  const llm = discoveryLlm({
    directory: [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'ns-a', settingsPath: [] }],
    answers: {},
  })
  const verdict = await checkConnectivity(llm, undefined, checkRoute)
  assert.equal(verdict.kind, 'unavailable')
  assert.equal(verdict.reason, 'noDiscovery')
  assert.equal(verdict.error, 'NO_DISCOVERY')
  assert.equal(verdict.advertised, undefined, 'a check that never ran counted no models')
})

test('checkConnectivity reads a request that names neither provider nor baseURL as unavailable', async () => {
  // The runtime's other pre-dispatch guard (llm/src/index.ts:600-602). This
  // plugin always names the configured provider, so the case is unreachable
  // today; it is pinned so a future call shape that forgets the provider lands
  // in the honest bucket instead of in "the endpoint did not answer".
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
    answers: {
      'ns-a': () => { throw Object.assign(new Error('needs a provider or a baseURL'), { code: 'INVALID_DISCOVERY' }) },
    },
  })
  const verdict = await checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' })
  assert.equal(verdict.kind, 'unavailable')
  assert.equal(verdict.reason, 'noDiscovery')
  assert.equal(verdict.error, 'INVALID_DISCOVERY')
})

test('checkConnectivity keeps a discovery that really ran and refused unreachable', async () => {
  // The counterpart, and the reason the set is closed rather than "any refusal
  // is unavailable": these codes come from a discovery the runtime DID invoke,
  // and each is the channel's own answer about this route.
  const refused = Object.assign(new Error('401 from the gateway'), { code: 'AUTH' })
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
    answers: { 'ns-a': () => { throw refused } },
  })
  const verdict = await checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' })
  assert.equal(verdict.kind, 'unreachable')
  assert.equal(verdict.error, 'AUTH')
  assert.equal(verdict.reason, undefined)
})

test('checkConnectivity keeps a provider-family refusal unreachable, with its code', async () => {
  // pi-ai's own discovery raises these after the runtime invoked it
  // (llm-pi-ai/src/discovery.ts:243,288,301). They name something the user can
  // fix for THIS channel, so they stay facts about the channel.
  for (const code of ['DISCOVERY_FAILED', 'DISCOVERY_UNSUPPORTED', 'INVALID_CREDENTIAL']) {
    const llm = discoveryLlm({
      directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
      answers: { 'ns-a': () => { throw Object.assign(new Error('no'), { code }) } },
    })
    const verdict = await checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' })
    assert.equal(verdict.kind, 'unreachable', `${code} is the discovery's own answer about this route`)
    assert.equal(verdict.error, code)
  }
})

test('checkConnectivity reads a route with no configurable-provider entry as unavailable', async () => {
  // Nothing in DSH's directory declares this provider, so there is no settings
  // namespace to interrogate and no endpoint to ask.
  const llm = discoveryLlm({ directory: [], answers: {} })
  const verdict = await checkConnectivity(llm, undefined, checkRoute)
  assert.equal(verdict.kind, 'unavailable')
  assert.equal(verdict.reason, 'notConfigurable')
  assert.equal(llm.asked.length, 0, 'no discovery was asked for a route with no namespace')
})

test('checkConnectivity threads the caller signal to the discovery, and an aborted check rethrows', async () => {
  // M4：发现调用是真实网络请求，取消缝必须通到 discoverModels（Typert 的
  // cancellation 通道把浏览器的 abort 送进宿主方法末参）。取消不是"端点没
  // 应答"——中止时原样抛回，让远程调用以拒绝结束，客户端本就跑在拒绝路径上。
  //
  // 适配器拿到的是融合信号而不是调用方那一个：deadline 与取消共用一个
  // AbortController，否则适配器只看得见两件事里的一件。断言因此落在行为上
  // ——调用方 abort 后，适配器收到的那个信号必须跟着 abort。
  const controller = new AbortController()
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
    answers: {
      'ns-a': (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true })
      }),
    },
  })
  const running = checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' }, controller.signal)
  const handed = llm.asked[0].signal
  assert.equal(handed.aborted, false, 'the discovery starts with a live signal')
  controller.abort()
  assert.equal(handed.aborted, true, 'the caller abort reaches the discovery through the fused signal')
  await assert.rejects(running, /aborted/, 'an aborted check rethrows instead of answering')
})

test('checkConnectivity reports a discovery that never answers as unreachable TIMEOUT, never as a hang', async () => {
  // 用户实测的形状：端点接受 TCP 但永不应答。没有 deadline 时这一轮永不结算，
  // 浏览器的 `ui.checking` 就永久锁死，之后手动与周期检查全部 no-op（只能刷新）。
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
    answers: { 'ns-a': () => new Promise(() => {}) },
  })
  const started = Date.now()
  const verdict = await checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' }, undefined, 0.05)
  assert.equal(verdict.kind, 'unreachable')
  assert.equal(verdict.error, 'TIMEOUT')
  assert.equal(verdict.reason, undefined, 'a timeout is a fact about the channel, not "could not check"')
  assert.ok(Date.now() - started < 1000, 'the check settles at its own deadline')
  assert.equal(llm.asked[0].signal.aborted, true, 'the discovery is asked to stop at the deadline')
})

test('checkConnectivity keeps its deadline even when the discovery answers afterwards', async () => {
  // 竞速而不是"只 abort 一下就等"：忽略信号的适配器也必须让这一轮结算，否则
  // 锁死以另一种形态回来（适配器不理 signal，调用方照样等到天荒地老）。
  const llm = discoveryLlm({
    directory: [{ provider: 'gw', displayName: 'Gateway', settingsNs: 'ns-a', settingsPath: [] }],
    answers: { 'ns-a': () => new Promise(resolve => setTimeout(() => resolve([{ id: 'm' }]), 300)) },
  })
  const verdict = await checkConnectivity(llm, undefined, { provider: 'gw', model: 'm' }, undefined, 0.05)
  assert.equal(verdict.kind, 'unreachable')
  assert.equal(verdict.error, 'TIMEOUT', 'the late answer does not retroactively make the check reachable')
})

test('the history-failure line carries the placeholder its caller fills', () => {
  // 少一个占位符，原因就永远不出现在屏幕上——而这条提示的全部价值就是那个原因。
  // 「部分会话读不到」那一支随内联投影一起去掉了：一次 `session.list` 要么整份
  // 读得到、要么整份读不到，浏览器再也没有逐会话失败可报。
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    assert.ok(dict.healthHistoryUnreadable.includes('{error}'), `${name} names the reason`)
  }
})

// ---- client-side pure helpers ----

test('deepEqual compares by value, not by key order', () => {
  // M12：宿主重发布同一份值而键序不同时，JSON 串比较会把草稿误判为"变了"
  // （未保存编辑被冲掉）或反过来漏判真实变化。数组仍按序——顺序是数组的语义。
  assert.equal(deepEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true)
  assert.equal(deepEqual({ a: [1, { x: 1, y: 2 }] }, { a: [1, { y: 2, x: 1 }] }), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false, 'array order is meaning, not notation')
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false, 'a missing key is not an undefined-valued key')
  assert.equal(deepEqual(null, null), true)
  assert.equal(deepEqual(null, {}), false)
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
})

test('the save shortcut label follows the platform, and both keys exist in both locales', () => {
  // M14：chip 上的按键标签曾写死 ⌘S，Windows/Linux 用户看到的是 mac 符号。
  assert.equal(saveShortcutKeyKey(true), 'saveShortcutKeyMac')
  assert.equal(saveShortcutKeyKey(false), 'saveShortcutKeyOther')
  for (const key of ['saveShortcutKeyMac', 'saveShortcutKeyOther']) {
    assert.ok(typeof zh[key] === 'string', `zh has ${key}`)
    assert.ok(typeof en[key] === 'string', `en has ${key}`)
  }
})

// 页面壳、五分区、预算层次与时间轴的字典键：缺键时 DSH 的 locale 会把键名本身
// 渲染给用户（"defaultModelSynced"），而英文用户看到的是空——两份字典各写各的已经
// 漂移过（en 从来没有 problemDuplicateRoute 键，字典覆盖测试当场抓到）。
test('every page, chain, budget and timeline key exists in both locales', () => {
  const keys = [
    'pageTitle', 'viewChainTab', 'viewHealthTab', 'viewTabsLabel',
    'takeoverSwitchLabel', 'allSavedText',
    'strategySectionTitle', 'strategySectionHint', 'strategyLabel',
    'firstHopSectionTitle', 'firstHopSectionHint', 'firstHopTitle', 'firstHopBadge',
    'firstHopRetriesNote',
    'fallbackChainSection', 'addCandidateBtn', 'toggleNeedsBtn',
    'switchOnTitle', 'triggerSummaryLine', 'retrySectionTitle', 'retrySectionHint',
    'retryNoTotalCapNote', 'retryHierarchyNote', 'stickyTurns', 'stickyTurnsHint', 'stickyTurnsOff',
    'outputContinuationTitle', 'outputContinuationHint', 'outputContinuationNote',
    'jumpToHealth', 'healthModalTitle', 'applyChanges',
    'timelineWindowLabel', 'timelineNoData', 'timelineBucketEmpty', 'timelineBucketTip',
    'timelineLegend', 'timelineScopeLine', 'timelineBucketLabel', 'timelineBucketHint',
    'timelineBucketMinutes', 'timelineBucketWindow',
    'healthMetricLatencyHint', 'healthMetricThroughputHint', 'healthMetricThroughputNone',
  ]
  for (const key of keys) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh has ${key}`)
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en has ${key}`)
  }
  // 占位符两边必须一致：{window} 只在一边存在时，另一侧会把 "{window}" 原样印出来。
  for (const key of ['timelineWindowLabel', 'timelineScopeLine', 'timelineBucketWindow', 'timelineBucketTip']) {
    const placeholders = (text) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(',')
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `${key} uses the same placeholders in both locales`)
  }
})

test('the two dictionaries cover the same keys and placeholders', () => {
  // 274 个键逐个对齐：只在一边存在的键会让另一语言直接渲染出键名（retryLimit 就是这么
  // 漏的——两边键数相同，靠数数永远发现不了）。占位符同理，缺了会原样印出 "{n}"。
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en must define the same keys')
  const placeholders = (text) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(',')
  for (const key of zhKeys) {
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `${key} uses the same placeholders in both locales`)
  }
})

test('every breaker preset desc key exists in both locales', () => {
  // M19：预设文案曾在模块里手写中文，英文用户永远看不到。descKey 进字典，
  // 漏一个键这里就红。
  for (const preset of BREAKER_CODE_PRESETS) {
    assert.ok(typeof zh[preset.descKey] === 'string', `zh has ${preset.descKey}`)
    assert.ok(typeof en[preset.descKey] === 'string', `en has ${preset.descKey}`)
  }
})

test('routeParts is the exact inverse of routeKeyOf', () => {
  // 真实形状：provider 段永不含 `/`（DSH 的 provider 名是标识符），model 段
  // 可以含（网关自己的模型路径）。所以切分必须停在第一个 `/`——这是
  // routes.ts 写下的唯一口径，九个原先各写一遍的解码点都照它。
  assert.deepEqual(routeParts(routeKeyOf('gw', 'kimi-k3')), { provider: 'gw', model: 'kimi-k3' })
  assert.deepEqual(routeParts(routeKeyOf('gw', 'vendor/kimi-k3')), { provider: 'gw', model: 'vendor/kimi-k3' })
  // 没有斜杠的串不是路由键。折叠一条坏记录不能抛，所以它作为"没有 model"
  // 回来，由调用方自己的空值守卫丢掉（health workspace 的 ensure 正是这么用）。
  assert.deepEqual(routeParts('gw'), { provider: 'gw', model: '' })
})

// 路由键的拼与拆只能有一个表达式。`routes.ts` 的 docstring 断言"Everything
// here is pure and shared"——而实现层审查实测 host 8 处 + browser 18 处编码、
// 9 处解码全是手抄的，那条断言为假。这条守卫让"再手抄一处"立刻转红：src/ 里
// 任何 `provider + '/'`、模板串 `${a}/${b}`、`indexOf('/')`、`split('/')`
// 都不允许出现（routes.ts 自身除外，它拥有这个表达式）。
test('a route key is built and split in exactly one place', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
  const files = walk(srcDir).filter((file) => relative(srcDir, file) !== 'routes.ts')
  // 注释里合法地提到 `/`（说明口径），所以守卫只读代码；块注释按原样留白，
  // 行号才不会因为剥离而漂移。
  const codeOf = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/.*$/gm, '$1')
  const shapes = [
    { pattern: /provider \+ '\/'|model \+ '\/'|\+ '\/' \+/, why: 'a hand-joined route key' },
    // 插值尾巴必须是 provider 或 model（可带 `?? ''` 兜底）：`${position}/${total}`
    // 这类分数展示长得一样但不是路由键，守卫不拦它。
    { pattern: /(?:provider|model)(?:\s*\?\?\s*'')?\}\//, why: 'a route key spliced inside a template literal' },
    { pattern: /indexOf\('\/'\)|split\('\/'\)/, why: 'a hand-split route key' },
  ]
  const found = []
  for (const file of files) {
    const code = codeOf(readFileSync(file, 'utf8'))
    for (const { pattern, why } of shapes) {
      for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
        const line = code.slice(0, match.index).split('\n').length
        found.push(`${relative(srcDir, file)}:${line}: ${why}`)
      }
    }
  }
  assert.deepEqual(found, [], `route keys must go through routes.ts, found ${found.length}:\n${found.join('\n')}`)
})

// 检查更新：版本以 registry 为准，失败分成"查不到版本"与"读到版本但读不到说明"。
// 这两种失败不是一回事：前者让"是不是最新"这个问题悬空，后者不影响版本答案。
const jsonResponse = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body })

test('compareVersions orders releases, and refuses what is not a version', () => {
  assert.equal(compareVersions('0.3.3', '0.3.2') > 0, true)
  assert.equal(compareVersions('0.3.3', '0.3.3'), 0)
  assert.equal(compareVersions('0.3.2', '0.3.3') < 0, true)
  assert.equal(compareVersions('1.0.0', '0.9.9') > 0, true)
  // 预发布版比它自己的正式版旧（npm 的规则）。
  assert.equal(compareVersions('0.3.3-rc.1', '0.3.3') < 0, true)
  assert.equal(compareVersions('0.3.3-rc.2', '0.3.3-rc.10') < 0, true, 'rc.2 < rc.10（数字段按数值比，不是按字符串）')
  // 不是版本的东西不能被当成版本比较：那会让"latest"这种值参与比较。
  assert.equal(compareVersions('latest', '0.3.3'), null)
  assert.equal(compareVersions('0.3', '0.3.3'), null)
  assert.equal(compareVersions('', '0.3.3'), null)
})

test('a running version that is not comparable is an error, not "up to date"', async () => {
  // 旧写法 `compareVersions(latest, current) ?? 0` 把"不可比较"读成"不比最新版新"，
  // 于是界面显示"已是最新版本"——一个不成立的结论。运行版本来自构建产物，
  // 读不出它就是构建有毛病，要按失败说。
  const result = await checkForUpdate('latest', {
    fetchImpl: async () => jsonResponse({ version: '0.4.0' })(),
  })
  assert.equal(result.latest, '0.4.0', '版本答案仍然读到了')
  assert.equal(result.newer, false)
  assert.match(result.error ?? '', /not a comparable version/, 'the reason reaches the user')
})

test('the update check answers with the newest published version and its notes', async () => {
  const requested = []
  const result = await checkForUpdate('0.3.3', {
    fetchImpl: async (url) => {
      requested.push(url)
      if (url.includes('/latest')) return jsonResponse({ version: '0.3.4' })()
      return jsonResponse({ body: '## 修复\n\n- 新东西', published_at: '2026-10-25T08:00:00Z' })()
    },
  })
  assert.equal(result.current, '0.3.3')
  assert.equal(result.latest, '0.3.4')
  assert.equal(result.newer, true)
  assert.equal(result.notes, '## 修复\n\n- 新东西')
  assert.equal(result.publishedAt, '2026-10-25T08:00:00Z')
  assert.equal(result.error, null)
  assert.equal(result.notesError, null)
  // 版本以 registry 为准：说明取的是那个版本的 release。
  assert.ok(requested[0].includes('/dsh-model-desk/latest'), 'the version comes from the registry')
  assert.ok(requested[1].includes('/releases/tags/v0.3.4'), 'the notes come from that version\'s release')
})

test('an up-to-date artifact does not spend a request on release notes', async () => {
  const requested = []
  const result = await checkForUpdate('0.3.3', {
    fetchImpl: async (url) => {
      requested.push(url)
      return jsonResponse({ version: '0.3.3' })()
    },
  })
  assert.equal(result.latest, '0.3.3')
  assert.equal(result.newer, false)
  assert.equal(result.notes, null)
  assert.equal(requested.length, 1, '已是最新时不读用不上的说明')
})

test('a registry that cannot be reached leaves the version question open, not answered', async () => {
  const result = await checkForUpdate('0.3.3', {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') },
  })
  assert.equal(result.latest, null)
  assert.equal(result.newer, false)
  assert.match(result.error, /ENOTFOUND/, 'the reason must reach the user')
  // 关键：查不到不等于"已是最新"——latest 为 null 就是"不知道"。
  assert.equal(result.latest, null)
})

test('a registry that answers with a non-version is a failure, not a version', async () => {
  const result = await checkForUpdate('0.3.3', {
    fetchImpl: async () => jsonResponse({ version: 'latest' })(),
  })
  assert.equal(result.latest, null)
  assert.match(result.error, /version/)
})

test('a release whose notes cannot be read keeps the version answer', async () => {
  const result = await checkForUpdate('0.3.3', {
    fetchImpl: async (url) => {
      if (url.includes('/latest')) return jsonResponse({ version: '0.4.0' })()
      throw new Error('HTTP 404 reading release notes')
    },
  })
  assert.equal(result.latest, '0.4.0', '版本答案不受说明失败影响')
  assert.equal(result.newer, true)
  assert.equal(result.notes, null)
  assert.match(result.notesError, /404/)
  assert.equal(result.error, null, '版本查到了，检查就不算失败')
})

test('the update check names the package and the repository it reads', async () => {
  // 换了包名或仓库名，这里会立刻转红——那两处是"最新版本"与"说明"的来源。
  const source = readFileSync(fileURLToPath(new URL('../src/update.ts', import.meta.url)), 'utf8')
  assert.match(source, /REGISTRY_PACKAGE = 'dsh-model-desk'/)
  assert.match(source, /REPO = 'Imzl-zl\/dsh-model-desk'/)
})
// 显示名只有一处解析：DSH 的模型目录（用户在「模型」页映射的名字）。这一组的形状
// 全部取自用户现场那份配置——provider `cherry` 下模型 id 是 `<uuid>:<model>`、name
// 是映射名，正是"一行行看过去分不出谁是谁"的那种。
test('routeNames reads the catalog names for both halves of a route', () => {
  const names = routeNames({
    groups: [{
      id: 'cherry',
      name: 'Cherry',
      models: [{ id: 'c518aa0a-1e0e-46bd-a8b4-e94cd22ddd93:deepseek-4.1-flash', name: 'LunaRoute:deepseek-4.1-flash' }],
    }],
  })
  assert.equal(names.provider('cherry'), 'Cherry')
  assert.equal(names.model('cherry', 'c518aa0a-1e0e-46bd-a8b4-e94cd22ddd93:deepseek-4.1-flash'),
    'LunaRoute:deepseek-4.1-flash')
  assert.equal(names.route('cherry', 'c518aa0a-1e0e-46bd-a8b4-e94cd22ddd93:deepseek-4.1-flash'),
    'Cherry · LunaRoute:deepseek-4.1-flash')
})

test('routeNames falls back to the raw half, never to a neighbouring name', () => {
  const names = routeNames({ groups: [{ id: 'cherry', name: 'Cherry', models: [{ id: 'a', name: 'A' }] }] })
  // 目录里没有这条路由（模型被删了）：回落的是它自己的 id，不许拿同 provider 下
  // 别的名字顶上——那会把两条不同的渠道说成同一条。
  assert.equal(names.model('cherry', 'gone'), 'gone')
  assert.equal(names.provider('not-in-catalog'), 'not-in-catalog')
  // 两半都没有名字时印原始键：与日志/配置/宿主 notice 里同一条字符串，认得出。
  assert.equal(names.route('not-in-catalog', 'gone'), 'not-in-catalog/gone')
  // 只有一半有名字时按名字拼。
  assert.equal(names.route('cherry', 'gone'), 'Cherry · gone')
})

test('routeNames reads an unanswered or malformed catalog as "no names"', () => {
  // 还没答上来 / 答的是垃圾：与"这条路由不在目录里"必须是同一个结果（原始 id），
  // 否则加载期会闪出一批不存在的名字。
  for (const value of [null, undefined, {}, { groups: null }, { groups: 'nope' }, { groups: [null] }, 42]) {
    const names = routeNames(value)
    assert.equal(names.provider('cherry'), 'cherry')
    assert.equal(names.model('cherry', 'm'), 'm')
  }
  // 名字是空串不算名字：空白的行比 id 更难认。
  const blank = routeNames({ groups: [{ id: 'cherry', name: '', models: [{ id: 'm', name: '' }] }] })
  assert.equal(blank.provider('cherry'), 'cherry')
  assert.equal(blank.model('cherry', 'm'), 'm')
})

test('a half route prints its provider half without a dangling separator', () => {
  // routeParts 对坏记录给出 model: ''（见上一条守卫），那半条路由不能印成 "cherry · "。
  assert.equal(routeNames(null).route('cherry', ''), 'cherry')
})

// 显示名与路由键是同一类事实：一处解析、所有面共用。哪个面自己拼名字（把
// `candidate.provider` 直接上屏），用户就又会看到 id——而他映射名字正是为了不看 id。
test('every surface that names a route paints it through the naming module', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const surfaces = ['client/pipeline.ts', 'client/workspace.ts', 'client/chip.ts', 'client/modals.ts']
  for (const name of surfaces) {
    const code = readFileSync(join(srcDir, name), 'utf8')
    assert.match(code, /from '\.\/naming\.ts'/, `${name} must take route display names from naming.ts`)
  }
  // provider 那一半在行标题里的画法只有一种：类名后面接 names.provider(...)。
  for (const name of ['client/pipeline.ts', 'client/workspace.ts']) {
    const code = readFileSync(join(srcDir, name), 'utf8')
    const spans = code.match(/'dsh-router-provider'/g) ?? []
    const named = code.match(/'dsh-router-provider'\s*\}\s*,\s*names\.provider\(/g) ?? []
    assert.ok(spans.length > 0, `${name} must still render the provider half of a route`)
    assert.equal(named.length, spans.length, `${name} must render the provider name, not the raw provider id`)
  }
})

// 新增控件的接线是三级传递（apply.ts 映射 controller → page.ts 交给 ChainView →
// client/chain.ts 交给 RetrySection）。少接一环就是"点一次抛 TypeError、草稿不动"，
// 而单测的 propsFor 会把全部 action 一次塞进去，永远绿——这个项目踩过一次
// （接管开关搬家）。所以这三环用源级守卫钉住，浏览器实测另行补。
test('the truncation controls are wired through every layer that owns the chain view', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const read = name => readFileSync(join(srcDir, name), 'utf8')
  assert.match(read('client/apply.ts'), /onMaxTokenContinue: function \(value\) \{ controller\.setMaxTokensContinue\(value\) \}/)
  assert.match(read('client/apply.ts'), /onMaxTokenContinues: function \(value\) \{ controller\.setMaxTokenContinues\(value\) \}/)
  const page = read('client/page.ts')
  assert.match(page, /onMaxTokenContinue: props\.onMaxTokenContinue/)
  assert.match(page, /onMaxTokenContinues: props\.onMaxTokenContinues/)
  const view = read('client/chain.ts')
  assert.match(view, /onMaxTokenContinue: props\.onMaxTokenContinue/)
  assert.match(view, /onMaxTokenContinues: props\.onMaxTokenContinues/)
  // 以及控件本身：输出续跑是独立分区，一个开关 + 一个步进器，都从草稿的 maxTokens 读值。
  // 它不再和失败重试同处一个分区；RetrySection 里出现续跑文案就是两件事又混回去了。
  const section = read('client/pipeline.ts')
  assert.match(section, /export function OutputContinuationSection/)
  assert.match(section, /var maxTokens = props\.maxTokens \?\? \{\}/)
  assert.match(section, /props\.onMaxTokenContinue\(!auto\)/)
  assert.match(section, /props\.onMaxTokenContinues\(next\)/)
  const retry = section.slice(section.indexOf('export function RetrySection'), section.indexOf('export function OutputContinuationSection'))
  assert.equal(retry.includes('maxTokenContinueLabel'), false,
    'output continuation must not be rendered inside the retry section')
})

import {
  TIMELINE_BAR_COUNT,
  TIMELINE_BUCKET_SECONDS,
  TIMELINE_MAX_POINTS,
  TIMELINE_RETENTION_SECONDS,
  bucketTimeline,
  windowSuccessRate,
  bucketTone,
  pruneTimeline,
} from '../src/timeline.ts'

// ---- 健康时间轴：固定格数 × 时长桶 ----
// 旧口径是"最近 24 次观测、一格一次调用"：没有时间轴，24 格可能横跨几天，
// 可用率也不是时间加权。这里钉的是新口径——每格是一个时长桶，高度是该桶的
// 成功率，颜色按分档；观测点按时间戳保留，改桶长不丢历史。

const MINUTE = 60 * 1000
const alignedNow = (bucketMinutes) => Math.floor(Date.now() / (bucketMinutes * MINUTE)) * (bucketMinutes * MINUTE)
const barAt = (bars, time) => bars.find(bar => time >= bar.start && time < bar.end)

test('bucketTimeline draws one bar per bucket, ending at the current one', () => {
  const now = alignedNow(10)
  const bars = bucketTimeline([], 600, now)
  assert.equal(bars.length, TIMELINE_BAR_COUNT)
  assert.equal(bars[bars.length - 1].end, now + 600 * 1000)
  assert.equal(bars[0].start, now + 600 * 1000 - TIMELINE_BAR_COUNT * 600 * 1000)
})

test('bucketTimeline puts every observation in the bucket its timestamp belongs to', () => {
  const now = alignedNow(10)
  const bars = bucketTimeline([
    { time: now - 5 * MINUTE, status: 'healthy' },
    { time: now - 5 * MINUTE, status: 'unhealthy' },
    { time: now - 95 * MINUTE, status: 'healthy' },
  ], 600, now)
  const near = barAt(bars, now - 5 * MINUTE)
  assert.equal(near.count, 2)
  assert.equal(near.healthy, 1)
  assert.equal(near.unhealthy, 1)
  const far = barAt(bars, now - 95 * MINUTE)
  assert.equal(far.count, 1)
  assert.equal(far.healthy, 1)
  // 95 分钟前与 5 分钟前不是同一格：一格是十分钟，不是一次调用。
  assert.notEqual(near.start, far.start)
})

test('bucketTimeline leaves a bucket with no observation empty, not failed', () => {
  const now = alignedNow(10)
  const bars = bucketTimeline([{ time: now - MINUTE, status: 'healthy' }], 600, now)
  assert.equal(barAt(bars, now - MINUTE).count, 1)
  assert.equal(bars[bars.length - 1].count, 0)
  assert.equal(bars[bars.length - 1].successRate, undefined)
  assert.equal(bucketTone(bars[bars.length - 1]), 'unknown')
})

test('bucketTimeline scores a degraded observation as half a success', () => {
  const now = alignedNow(10)
  const bars = bucketTimeline([
    { time: now - MINUTE, status: 'healthy' },
    { time: now - 2 * MINUTE, status: 'degraded' },
  ], 600, now)
  assert.equal(barAt(bars, now - MINUTE).successRate, 0.75)
})

test('bucketTone bands the success rate: green at 99%, yellow at 90%, red below', () => {
  assert.equal(bucketTone({ successRate: 1 }), 'healthy')
  assert.equal(bucketTone({ successRate: 0.99 }), 'healthy')
  assert.equal(bucketTone({ successRate: 0.98 }), 'degraded')
  assert.equal(bucketTone({ successRate: 0.9 }), 'degraded')
  assert.equal(bucketTone({ successRate: 0.89 }), 'unhealthy')
})

// 回归：窗口可用率曾在这两个界面里各写一遍，而且都多乘了一个 bar.count。
// healthy 本身就是桶内计数，再乘 count 就是平方——一个桶里十次观测会印出
// 1000%，用户实测 3578%。桶里只有一次观测时 1×1=1，所以手写用例完全看不出
// 来（隔离浏览器实测就是这么漏过去的）：这个 bug 只在有真实流量的桶里现形。
test('windowSuccessRate is a rate: a busy bucket cannot push it above 100%', () => {
  const now = alignedNow(10)
  // 一个桶里 50 次观测，全部成功。错公式给 50×50/50 = 50 → 5000%。
  const busy = bucketTimeline(
    Array.from({ length: 50 }, (_, i) => ({ time: now - MINUTE - i * 1000, status: 'healthy' })),
    600, now,
  )
  assert.equal(windowSuccessRate(busy), 1)

  // 一半降级：25 healthy + 25 degraded → (25 + 12.5) / 50 = 0.75。
  const half = bucketTimeline(
    Array.from({ length: 50 }, (_, i) => ({ time: now - MINUTE - i * 1000, status: i % 2 === 0 ? 'healthy' : 'degraded' })),
    600, now,
  )
  assert.equal(windowSuccessRate(half), 0.75)

  // 多个桶各自繁忙：每条渠道按自己的计数加权，不是把桶数也乘进去。
  const manyBuckets = bucketTimeline([
    ...Array.from({ length: 30 }, (_, i) => ({ time: now - MINUTE - i * 1000, status: 'healthy' })),
    ...Array.from({ length: 10 }, (_, i) => ({ time: now - 10 * MINUTE - i * 1000, status: 'unhealthy' })),
  ], 600, now)
  // 30 healthy 与 10 unhealthy 分居两个桶 → 30 / 40 = 0.75。
  assert.equal(windowSuccessRate(manyBuckets), 0.75)

  // 全失败是 0，空窗口是 null（不是 0%）。
  const allBad = bucketTimeline(
    Array.from({ length: 20 }, (_, i) => ({ time: now - MINUTE - i * 1000, status: 'unhealthy' })),
    600, now,
  )
  assert.equal(windowSuccessRate(allBad), 0)
  assert.equal(windowSuccessRate(bucketTimeline([], 600, now)), null)
})

test('windowSuccessRate never exceeds 1 for any mixture of bucket loads', () => {
  // 不变量：healthy ≤ count 恒成立，所以加权值 ≤ 观测数。随机枚举桶内负载与
  // 状态组合，任何一条越过 1 都是公式又变成了平方。
  const now = alignedNow(10)
  const statuses = ['healthy', 'degraded', 'unhealthy']
  for (let a = 0; a <= 6; a += 1) {
    for (let b = 0; b <= 6; b += 1) {
      for (let c = 0; c <= 6; c += 1) {
        const points = []
        let offset = 0
        for (const [count, status] of [[a, 'healthy'], [b, 'degraded'], [c, 'unhealthy']]) {
          for (let i = 0; i < count; i += 1) points.push({ time: now - MINUTE - (offset += 1000), status })
        }
        const rate = windowSuccessRate(bucketTimeline(points, 600, now))
        const total = a + b + c
        if (total === 0) {
          assert.equal(rate, null, 'an empty window is null, not 0%')
          continue
        }
        assert.ok(rate !== null && rate >= 0 && rate <= 1,
          `rate must stay within [0,1] for healthy=${a} degraded=${b} unhealthy=${c}, got ${String(rate)}`)
      }
    }
  }
})

test('bucketTimeline ignores an observation outside the drawn window', () => {
  const now = alignedNow(10)
  const bars = bucketTimeline([{ time: now - 10 * MINUTE * TIMELINE_BAR_COUNT - MINUTE, status: 'healthy' }], 600, now)
  assert.equal(bars.reduce((sum, bar) => sum + bar.count, 0), 0)
})

test('pruneTimeline drops observations older than the retention window, measured from the newest', () => {
  const newest = Date.now()
  const kept = pruneTimeline([
    { time: newest - (TIMELINE_RETENTION_SECONDS + 1) * 1000, status: 'healthy' },
    { time: newest - TIMELINE_RETENTION_SECONDS * 1000, status: 'healthy' },
    { time: newest, status: 'healthy' },
  ])
  assert.equal(kept.length, 2)
  assert.equal(kept[0].time, newest - TIMELINE_RETENTION_SECONDS * 1000)
})

test('pruneTimeline keeps the newest TIMELINE_MAX_POINTS observations', () => {
  const newest = Date.now()
  const many = Array.from({ length: TIMELINE_MAX_POINTS + 5 }, (_, index) => ({
    time: newest - index * 1000,
    status: 'healthy',
  }))
  const kept = pruneTimeline(many)
  assert.equal(kept.length, TIMELINE_MAX_POINTS)
  assert.equal(kept[kept.length - 1].time, newest)
})

test('pruneTimeline does not mutate the timeline it was given', () => {
  const original = [{ time: 2, status: 'healthy' }]
  const next = pruneTimeline(original)
  assert.notEqual(next, original)
  assert.deepEqual(original, [{ time: 2, status: 'healthy' }])
})

test('every offered bucket length is a divisor-free option the dashboard can render', () => {
  assert.ok(TIMELINE_BUCKET_SECONDS.includes(600))
  assert.equal(TIMELINE_BUCKET_SECONDS.length > 1, true)
})

// ---- 单条全局降级链：迁移、选路、结构规则 ----
// 产品口径（2026-10-19 用户决定）：不分主次、不按模型分规则。第一跳永远是用户
// 当前选中的模型（只打一次），失败后按配置的降级候选走。旧配置里的 profiles 是
// 按模型分规则 + 钉死 primary 的形态，加载时迁成一条链：丢掉被钉死的第一个候选
// （它就是"选中模型"本身），其余成为降级候选。

import { chainForSession, chainLabel, defaultChainOf, effectiveChain, effectiveChains, emptyChain } from '../src/chain.ts'
import { failoverNotice } from '../src/notice.ts'

const switchOnAll = { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false, auth: true, quota: true }
const chainValue = (over = {}) => ({ candidates: [], switchOn: switchOnAll, stickyTurns: 0, strategy: 'order', firstHopMaxRetries: 0, ...over })
const cand = (provider, model = 'm', over = {}) => ({ provider, model, maxRetries: 0, weight: 0, ...over })

test('effectiveChain uses the configured chain when it has fallbacks', () => {
  // policyVersion: 2 —— 这条测的是"形状谁赢"，重试次数的旧默认改写由专门的迁移用例覆盖。
  const chain = chainValue({ candidates: [cand('a'), cand('b')] })
  const result = effectiveChain({ enabled: true, chain, policyVersion: 2 })
  assert.deepEqual(result.chain.candidates, chain.candidates)
  assert.equal(result.source, 'chain')
  assert.equal(result.ignoredProfiles, 0)
})

test('a schema-applied legacy chain still migrates: calls to retries, the total cap dropped', () => {
  // 生产路径不是直接调 effectiveChain：Cordis 先用 Config 校验，schemastery 会给每个
  // 候选补上 maxRetries: 0 的默认值，同时原样留下旧的 maxAttempts。迁移按旧键是否
  // 存在判断（见 chain.ts 的 normalizeCandidate），这条用例钉住它能穿过真实 schema，
  // 否则一个配了 3 次调用的候选会被静默降成"不重试"。
  const applied = Config({
    enabled: true,
    chain: { candidates: [{ provider: 'a', model: 'm', maxAttempts: 3 }], firstHopMaxAttempts: 2, maxTotalAttempts: 6 },
  }).chain.get()
  const result = effectiveChain({ chain: applied })
  assert.equal(result.chain.candidates[0].maxRetries, 2)
  assert.equal(result.chain.firstHopMaxRetries, 1)
  assert.equal('maxTotalAttempts' in result.chain, false)
})

test('effectiveChain adopts a legacy default pool when there is no chain key at all', () => {
  // 旧形状的两个字段都在这里：candidates[].maxAttempts 是"调用次数"（3 → 重试 2），
  // maxTotalAttempts 已删除，迁移后不再出现在链上。
  const legacy = { enabled: true, candidates: [cand('a', 'm', { maxAttempts: 3 }), cand('b')], switchOn: switchOnAll, maxTotalAttempts: 5, stickyTurns: 2, strategy: 'round-robin' }
  const result = effectiveChain({ enabled: true, default: legacy })
  assert.deepEqual(result.chain.candidates.map(c => c.provider), ['a', 'b'])
  assert.equal(result.chain.candidates[0].maxRetries, 2)
  // cand('b') 存的是 0 —— 那是旧默认值（一失败就换），没有 v2 标记时按新默认改写成 5。
  assert.equal(result.chain.candidates[1].maxRetries, 5)
  assert.equal('maxTotalAttempts' in result.chain, false)
  assert.equal(result.chain.stickyTurns, 2)
  assert.equal(result.chain.strategy, 'round-robin')
  assert.equal(result.source, 'default')
})

test('effectiveChain turns a single legacy profile into the global chain, dropping its pinned first hop', () => {
  const profile = {
    id: 'p1',
    when: { provider: 'selected', model: 'm' },
    candidates: [cand('selected', 'm', { maxAttempts: 3 }), cand('backup-1'), cand('backup-2')],
    switchOn: switchOnAll,
    maxTotalAttempts: 6,
    stickyTurns: 1,
    strategy: 'weight',
  }
  const result = effectiveChain({ enabled: true, profiles: [profile] })
  // 被钉死的 candidates[0] 就是"用户选中的模型"，它成为隐式第一跳，不再占一条降级；
  // 它的调用次数（3）迁成第一跳的重试次数（2）。
  assert.deepEqual(result.chain.candidates.map(c => c.provider), ['backup-1', 'backup-2'])
  assert.equal(result.chain.firstHopMaxRetries, 2)
  assert.equal(result.chain.strategy, 'weight')
  assert.equal(result.source, 'profile')
})

test('effectiveChain reports the legacy profiles it had to ignore', () => {
  const one = { id: 'p1', when: { provider: 'a', model: 'm' }, candidates: [cand('a'), cand('b')], switchOn: switchOnAll, stickyTurns: 0, strategy: 'order' }
  const two = { ...one, id: 'p2', when: { provider: 'c', model: 'm' }, candidates: [cand('c'), cand('d')] }
  const result = effectiveChain({ enabled: true, profiles: [one, two] })
  assert.equal(result.source, 'profile')
  assert.equal(result.ignoredProfiles, 1)
  assert.deepEqual(result.chain.candidates.map(c => c.provider), ['b'])
})

test('effectiveChain is empty when nothing is configured', () => {
  const result = effectiveChain({ enabled: false })
  assert.deepEqual(result.chain, emptyChain())
  assert.equal(result.source, 'empty')
})

test('an empty chain is a configuration, not a missing one', () => {
  // "没有降级可走"是用户配出来的状态：插件因此不接管。把它当成"没配"会回头去过
  // 旧形状，把用户清空的链又填回旧规则，还会用旧默认值覆盖他改过的重试次数。
  const result = effectiveChain({ enabled: true, chain: { candidates: [], switchOn: switchOnAll, firstHopMaxRetries: 4, stickyTurns: 0, strategy: 'order' }, default: { candidates: [cand('legacy')] } })
  assert.deepEqual(result.chain.candidates, [])
  assert.equal(result.chain.firstHopMaxRetries, 4, 'the chain\'s own settings survive')
  assert.equal(result.source, 'chain')
})

// ---- 命名链：迁移、默认链与按会话选链 ----

const namedChain = (id, name, over = {}) => ({ id, name, ...chainValue(over) })

test('a legacy single chain migrates to one named chain without changing behavior', () => {
  const legacy = chainValue({ candidates: [cand('a'), cand('b')], firstHopMaxRetries: 3 })
  const result = effectiveChains({ chain: legacy })
  assert.equal(result.source, 'chain')
  assert.equal(result.defaultChainId, 'default')
  assert.equal(result.chains.length, 1)
  assert.equal(result.chains[0].id, 'default')
  assert.equal(result.chains[0].name, '', 'an unnamed chain is labelled by the dictionary, never by the config')
  // 形状与顺序原样搬过来；旧默认 0 的重试次数按新默认（5）改写，那是另一个一次性迁移。
  assert.deepEqual(result.chains[0].candidates.map(c => [c.provider, c.model]), legacy.candidates.map(c => [c.provider, c.model]))
  assert.equal(result.chains[0].firstHopMaxRetries, 3)
})

test('stored chains win as they are written, with their own default', () => {
  const result = effectiveChains({
    chains: [namedChain('coding', '写代码', { candidates: [cand('a')] }), namedChain('writing', '', { candidates: [cand('b')] })],
    defaultChainId: 'writing',
  })
  assert.equal(result.source, 'chains')
  assert.equal(result.defaultChainId, 'writing')
  assert.deepEqual(result.chains.map(chain => [chain.id, chain.name]), [['coding', '写代码'], ['writing', '']])
})

test('the shape is decided by which key the RAW config has, not by what looks empty', () => {
  // schemastery 会给声明过的字段盖默认值（chain 变成一条空链、数组变成 []），所以"写过没有"
  // 只能看原始配置。这条钉住用户现场的三种形状：
  // ① 最老的一版：只有 profiles —— 必须认领它，否则升级后插件静默不接管。
  const profilesOnly = effectiveChains({ profiles: [{ when: { provider: 'cherry', model: 'm' }, candidates: [cand('cherry'), cand('lightvela'), cand('stepfun')] }] })
  assert.equal(profilesOnly.source, 'profile')
  assert.deepEqual(profilesOnly.chains[0].candidates.map(candidate => candidate.provider), ['lightvela', 'stepfun'])
  // ② 后来的一版：有 chain（此处被写成空链）——它赢，profiles 是升级后留下的残渣。
  const chainWins = effectiveChains({ chain: chainValue({ candidates: [] }), profiles: [{ when: { provider: 'a', model: 'm' }, candidates: [cand('a'), cand('b')] }] })
  assert.equal(chainWins.source, 'chain')
  assert.deepEqual(chainWins.chains[0].candidates, [])
  // ③ 新形状：chains 存在（哪怕只有一条空链）就赢，旧键一个都不看。
  const chainsWin = effectiveChains({ chains: [namedChain('default', '')], chain: chainValue({ candidates: [cand('kept')] }) })
  assert.equal(chainsWin.source, 'chains')
  assert.deepEqual(chainsWin.chains[0].candidates, [])
})

test('an empty chains list is a set of zero chains, not the legacy look', () => {
  // 显式写了 chains: [] 是一个（无意义的）新形状，按"一条空链"归一：插件不接管，
  // 但也不会回头去读旧键——旧键在用户保存过新形状之后就是残渣。
  const empty = effectiveChains({ chains: [], profiles: [{ candidates: [cand('stale')] }] })
  assert.equal(empty.source, 'chains')
  assert.equal(empty.chains.length, 1)
  assert.deepEqual(empty.chains[0].candidates, [])
  assert.equal(empty.defaultChainId, 'default')
})

test('a config written before policy v2 gets the new "switch on everything" defaults once, not forever', () => {
  // 旧配置里的 false 是当时的默认值（用户没选择过），只改 schema 默认值救不了它们：
  // 存下来的值仍然会被读回。没有 v2 标记 = 一次性按新默认改写；保存后带上标记，
  // 用户之后自己取消的勾选就不再被覆盖。
  const stored = namedChain('default', '', {
    candidates: [cand('a')],
    switchOn: { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: false, invalidRequest: false, auth: true, quota: true },
  })
  const migrated = effectiveChains({ chains: [stored] })
  assert.equal(migrated.chains[0].switchOn.invalidRequest, true, 'the old default false must not survive the upgrade')
  assert.equal(migrated.chains[0].switchOn.emptyResponse, true)
  assert.equal(migrated.chains[0].switchOn.other, true, 'codes outside the table switch by default too')
  // 只有那两个"当年的默认值 false"的键被改写。用户在旧配置里显式取消的勾选必须留下：
  // `rateLimit` 当年就是默认 true，写成 false 只可能是他自己点的，整表丢弃会吞掉它。
  const unChecked = effectiveChains({
    chains: [namedChain('default', '', { candidates: [cand('a')], switchOn: { rateLimit: false } })],
  })
  assert.equal(unChecked.chains[0].switchOn.rateLimit, false, 'an explicit opt-out written before v2 is a choice, not the old default')
  assert.equal(unChecked.chains[0].switchOn.emptyResponse, true, 'the two old-default keys are still rewritten once')
  // 已经带 v2 标记的配置：用户的选择原样保留。
  // 同一次迁移也把"旧默认 0 次重试"改写成新默认 5：插件接管重试之后，默认比 DSH 自己的
  // provider 策略（5）更小，等于让升级后的韧性变差。
  assert.equal(migrated.chains[0].firstHopMaxRetries, 5)
  assert.equal(migrated.chains[0].candidates[0].maxRetries, 5)
  const modern = effectiveChains({
    policyVersion: POLICY_VERSION,
    chains: [{
      ...stored,
      firstHopMaxRetries: 0,
      candidates: [{ provider: 'a', model: 'm', maxRetries: 0, weight: 0 }],
      switchOn: { ...stored.switchOn, invalidRequest: false },
    }],
  })
  assert.equal(modern.chains[0].switchOn.invalidRequest, false, 'an explicit choice made under v2 is never rewritten')
  assert.equal(modern.chains[0].firstHopMaxRetries, 0, 'an explicit "switch at once" made under v2 is kept')
  assert.equal(modern.chains[0].candidates[0].maxRetries, 0)
})

test('a chain without a max-tokens policy reads the defaults, and one with it keeps its numbers', () => {
  const plain = effectiveChains({ chains: [namedChain('default', '')] })
  assert.deepEqual(plain.chains[0].maxTokens, { autoContinue: true, continues: 2 })
  const tuned = effectiveChains({ chains: [namedChain('default', '', { maxTokens: { autoContinue: false, continues: 5 } })] })
  assert.deepEqual(tuned.chains[0].maxTokens, { autoContinue: false, continues: 5 })
  // 上界只有一个来源：这里曾写死字面量 9，与 `MAX_TOKEN_CONTINUES` 是同一个约束。
  const clamped = effectiveChains({
    chains: [namedChain('default', '', { maxTokens: { autoContinue: true, continues: 999 } })],
  })
  assert.equal(clamped.chains[0].maxTokens.continues, MAX_TOKEN_CONTINUES)
})

test('a session routes on the chain it bound, else on the default chain', () => {
  const config = {
    chains: [namedChain('default', '', { candidates: [cand('a')] }), namedChain('coding', '写代码', { candidates: [cand('b')] })],
    defaultChainId: 'default',
  }
  assert.equal(chainForSession(config, 'coding').chain.id, 'coding')
  assert.equal(chainForSession(config, 'coding').missing, undefined)
  assert.equal(chainForSession(config, null).chain.id, 'default')
  // 绑定指向已删除的链：按默认链路由，并把缺失的 id 报出来——宿主要因此留一条 notice，
  // 静默改道会让用户以为他的选择还在。
  const stale = chainForSession(config, 'gone')
  assert.equal(stale.chain.id, 'default')
  assert.equal(stale.missing, 'gone')
  assert.equal(chainLabel(config.chains[1]), '写代码')
  assert.equal(chainLabel(config.chains[0]), 'default', 'an unnamed chain is named by its id in host messages')
  assert.equal(defaultChainOf(config).id, 'default')
})

test('the chain rules catch a duplicate id and a default id that names nothing', () => {
  const duplicated = { chains: [namedChain('default', ''), namedChain('default', '第二个')], defaultChainId: 'default' }
  assert.deepEqual(structuralViolations(duplicated).map(violation => violation.key), ['problemDuplicateChainId'])
  // 每个重复的 id 只报一次：第一条不算"重复的"。
  const thrice = { chains: [namedChain('a', ''), namedChain('b', ''), namedChain('a', '')], defaultChainId: 'a' }
  assert.equal(structuralViolations(thrice).filter(violation => violation.key === 'problemDuplicateChainId').length, 1)
  const missingDefault = { chains: [namedChain('coding', '')], defaultChainId: 'writing' }
  assert.deepEqual(structuralViolations(missingDefault).map(violation => violation.key), ['problemUnknownDefaultChain'])
  // 空链（没有候选）是合法配置，插件的表现是不接管，不是加载失败。
  assert.deepEqual(structuralViolations({ chains: [namedChain('default', '')], defaultChainId: 'default' }), [])
})

test('resolveChain puts the selected model first and the configured fallbacks after it', () => {
  const chain = resolveChain({ provider: 'selected', model: 'm' }, chainValue({ candidates: [cand('a'), cand('b')] }))
  assert.deepEqual(chain.candidates.map(c => `${c.provider}/${c.model}`), ['selected/m', 'a/m', 'b/m'])
  // 第一跳是用户自己的选择，默认不重试（1 次调用）；降级候选各按自己的 maxRetries。
  assert.equal(chain.candidates[0].maxAttempts, 1)
  // order 是用户可见编号：0 = 第一跳，1..N = 降级第几条。
  assert.deepEqual(chain.order, [0, 1, 2])
})

test('resolveChain converts retries to call counts, first hop included', () => {
  const chain = resolveChain(
    { provider: 'selected', model: 'm' },
    chainValue({ candidates: [cand('a', 'm', { maxRetries: 2 })], firstHopMaxRetries: 3 }),
  )
  // 唯一一处 +1：配置说重试 3 次，决策层说最多打 4 次。
  assert.equal(chain.candidates[0].maxAttempts, 4)
  assert.equal(chain.candidates[1].maxAttempts, 3)
})

test('resolveChain drops a fallback that names the selected route', () => {
  const chain = resolveChain({ provider: 'a', model: 'm' }, chainValue({ candidates: [cand('a'), cand('b')] }))
  assert.deepEqual(chain.candidates.map(c => `${c.provider}/${c.model}`), ['a/m', 'b/m'])
  assert.equal(chain.order.length, 2)
})

test('the chain primaryNeeds reaches the implicit first hop, so its condition is expressible', () => {
  // 第一跳是 DSH 已选中的模型，不在候选表里；同名候选又会被去重丢掉，所以它的条件
  // 只能来自链级的 primaryNeeds。没有这个字段时，"只用于带图轮的主模型"无法表达。
  const chain = resolveChain(
    { provider: 'selected', model: 'm' },
    chainValue({ candidates: [cand('a')], primaryNeeds: { images: true } }),
  )
  assert.deepEqual(chain.candidates[0].needs, { images: true })
  // 条件检查本来就对 index 0 生效：纯文本轮上第一跳自身不满足。
  assert.equal(unmetCondition(chain.candidates[0], { hasImages: false, projectedTokens: undefined }), '需图片输入')
  assert.equal(unmetCondition(chain.candidates[0], { hasImages: true, projectedTokens: undefined }), undefined)
  // 同一条路把它带进执行链：schema → 迁移/规范化 → resolveChain。
  const effective = effectiveChains({
    chains: [{ id: 'c', name: '', candidates: [], primaryNeeds: { minContextTokens: 120000 } }],
  })
  assert.deepEqual(effective.chains[0].primaryNeeds, { minContextTokens: 120000 })
  // 旧形状（profiles）里被钉死的那一条就是第一跳：它自带的条件必须搬过去，
  // 否则迁移会连着用户的图片条件一起丢掉。
  const migrated = effectiveChains({
    profiles: [{
      when: { provider: 'selected', model: 'm' },
      candidates: [
        { provider: 'selected', model: 'm', maxRetries: 0, needs: { images: false } },
        { provider: 'a', model: 'm', maxRetries: 0 },
      ],
    }],
  })
  assert.deepEqual(migrated.chains[0].primaryNeeds, { images: false })
})

test('resolveChain has nothing to route when no fallback is configured', () => {
  assert.equal(resolveChain({ provider: 'a', model: 'm' }, chainValue()), undefined)
  // 只配了"选中模型"自己，等于没有降级可走。
  assert.equal(resolveChain({ provider: 'a', model: 'm' }, chainValue({ candidates: [cand('a')] })), undefined)
})

// ---- 会话覆盖的重试次数（解析点只有 resolveChain 一处） ----

test('a session override replaces the candidate retries, and 0 stays distinct from unset', () => {
  const chain = chainValue({ candidates: [cand('a', 'm', { maxRetries: 2 })], firstHopMaxRetries: 3 })
  const resolved = { provider: 'selected', model: 'm' }
  const routes = value => value.candidates.map(c => `${c.provider}/${c.model}`)

  // 未覆盖：候选自己的次数（3 次重试 = 4 次调用 / 2 次重试 = 3 次调用）。
  const untouched = resolveChain(resolved, chain)
  assert.deepEqual(untouched.candidates.map(c => c.maxAttempts), [4, 3])

  // 覆盖了第一跳与降级候选各一个：覆盖值取代配置值，仍然只在这里 +1。
  const overridden = resolveChain(resolved, chain, { 'selected/m': 0, 'a/m': 5 })
  assert.deepEqual(overridden.candidates.map(c => c.maxAttempts), [1, 6])
  assert.deepEqual(routes(overridden), ['selected/m', 'a/m'], 'the override never changes which route is tried')

  // 0 = 不重试，不能被当成"没填"回落成 3 次重试。
  const zero = resolveChain(resolved, chain, { 'selected/m': 0 })
  assert.equal(zero.candidates[0].maxAttempts, 1)
  assert.equal(zero.candidates[1].maxAttempts, 3, 'a route the session does not name keeps the candidate count')
})

// ---- 监听器的生命周期：插件 fiber 是唯一 owner ----

test('per-agent seams are registered on the plugin fiber, never on agent.ctx', () => {
  // 实测故障（桌面实例）：注册在 `agent.ctx` 上的 listener 属于 **agent** 的生命周期，
  // 插件 fiber 重启（任何配置保存）后旧 listener 会留在活着的 agent 上，继续用旧实例
  // 已经关闭的 storage 域——之后每一轮都在 `agent/request` 里抛
  // `domain 'model_router_sessions' is closed`（连续 5 轮失败，且禁用插件也不管用，
  // 因为旧 listener 还在）。这条守卫钉住 owner：两个 per-agent 缝必须挂在插件 ctx 上，
  // agent 从 payload 取。
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '')
  assert.equal(/agent\.ctx\.on\(/.test(source), false,
    'an agent-owned listener outlives the fiber that registered it')
  assert.match(source, /ctx\.on\(\s*'agent\/request'/)
  assert.match(source, /ctx\.on\(\s*'agent\/pre-step'/)
})

// ---- 会话重试输入：空与 0 是两件事 ----

test('an empty retry box means "follow the chain", zero means "do not retry"', () => {
  assert.deepEqual(parseRetryInput(''), { kind: 'follow' })
  assert.deepEqual(parseRetryInput('   '), { kind: 'follow' })
  assert.deepEqual(parseRetryInput(undefined), { kind: 'follow' })
  assert.deepEqual(parseRetryInput('0'), { kind: 'set', value: 0 })
  assert.deepEqual(parseRetryInput('10'), { kind: 'set', value: 10 })
  assert.deepEqual(parseRetryInput('99'), { kind: 'set', value: 99 })
  // 越界与小数都不夹、不猜：调用方把上限显示出来，让用户自己改。
  for (const raw of ['100', '-1', '1.5', 'abc']) {
    assert.deepEqual(parseRetryInput(raw), { kind: 'invalid' }, raw)
  }
})

// ---- 会话绑定的存储（storageDomain 侧车 / 内存回退） ----

/** A fake storage domain that records opens and writes, and can be made to fail. */
function fakeStorage(options = {}) {
  const records = new Map()
  const opened = []
  const facility = {
    async open(spec) {
      opened.push(spec.name)
      if (options.openError !== undefined) throw options.openError
      return {
        table: name => ({
          get: key => records.get(key),
          put: async (key, value) => {
            if (options.writeError !== undefined) throw options.writeError
            records.set(key, value)
          },
        }),
        close: async () => {},
      }
    },
  }
  return { facility, records, opened }
}

const fakeContext = (storage, errors = []) => ({
  get: name => (name === 'storageDomain' ? storage : undefined),
  logger: { error: message => errors.push(message) },
  effect: () => {},
})

test('without a storage domain, bindings live in memory and behave identically', async () => {
  const bindings = new SessionBindings(fakeContext(undefined))
  assert.equal(bindings.persistent, false)
  assert.equal(bindings.read('s1'), undefined, 'an absent binding is a state, not a failure')
  await bindings.write('s1', { chain: null, retries: { 'p/m': 0 } })
  assert.deepEqual(bindings.read('s1'), { chain: null, retries: { 'p/m': 0 } })
  assert.equal(bindings.read('unknown'), undefined)
})

test('with a storage domain, the write goes through it and reads come back from it', async () => {
  const { facility, records, opened } = fakeStorage()
  const bindings = new SessionBindings(fakeContext(facility))
  // §open 是异步的：write 必须等它，否则会绕过持久层写进内存。
  await bindings.write('s1', { chain: 'coding', retries: { 'p/m': 5 } })
  assert.deepEqual(opened, [SESSION_BINDINGS_DOMAIN], 'the declared domain name is what opens')
  assert.deepEqual(records.get('s1'), { chain: 'coding', retries: { 'p/m': 5 } })
  assert.equal(bindings.persistent, true)
  assert.deepEqual(bindings.read('s1'), { chain: 'coding', retries: { 'p/m': 5 } })
})

test('a storage failure reaches the caller unchanged and leaves the previous value in place', async () => {
  const failure = new Error('disk is full')
  const { facility } = fakeStorage({ writeError: failure })
  const bindings = new SessionBindings(fakeContext(facility))
  await assert.rejects(() => bindings.write('s1', { chain: null, retries: { 'p/m': 1 } }), failure)
  assert.equal(bindings.read('s1'), undefined, 'a rejected write must not look saved')
})

test('a closed domain does not leak another package error: reads follow the chain, writes say so', async () => {
  // 现场报错：domain 'model_router_sessions' is closed。它来自 storage-domain 的
  // DomainError：fiber 重启（保存配置）后旧实例的域已经关闭，而浏览器在飞的那次读/写
  // 正好落在旧实例上。旧实例对读的回答是"没有绑定"（UI 会从新实例重读），对写则明确
  // 说"刚刚重启、这次没落盘"，不再把别的包的错码抛给用户。
  const closed = () => { const error = new Error("domain 'model_router_sessions' is closed"); error.code = 'closed'; return error }
  const facility = {
    async open() {
      return {
        table: () => ({
          get: () => { throw closed() },
          put: async () => { throw closed() },
        }),
        close: async () => {},
      }
    },
  }
  const bindings = new SessionBindings(fakeContext(facility))
  assert.equal(bindings.read('s1'), undefined)
  assert.equal(bindings.persistent, false, 'a closed domain is not durable any more')
  await assert.rejects(() => bindings.write('s1', { chain: null, retries: {} }), /just restarted/)
})

test('opening rides out "already-open" while the previous fiber is still closing', async () => {
  // 保存配置 = fiber 整体重启：旧域还在关闭、新实例就来 open 同一个名字，facility 会以
  // already-open 拒绝（storage-domain/src/index.ts:104-106）。不重试的话，新实例会静默
  // 退回内存，直到下一次重启——用户会以为自己的绑定被清空了。
  let attempts = 0
  const facility = {
    async open() {
      attempts += 1
      if (attempts < 3) { const error = new Error("domain 'model_router_sessions' is already open"); error.code = 'already-open'; throw error }
      return { table: () => ({ get: () => undefined, entries: () => [][Symbol.iterator](), put: async () => {}, delete: async () => true }), close: async () => {} }
    },
  }
  const bindings = new SessionBindings(fakeContext(facility))
  await bindings.write('s1', { chain: null, retries: { 'p/m': 1 } })
  assert.equal(attempts, 3)
  assert.equal(bindings.persistent, true)
})

test('a domain that cannot open falls back to memory and says so', async () => {
  const errors = []
  const { facility } = fakeStorage({ openError: new Error('invalid-record') })
  const bindings = new SessionBindings(fakeContext(facility, errors))
  await bindings.write('s1', { chain: null, retries: { 'p/m': 2 } })
  assert.equal(bindings.persistent, false)
  assert.deepEqual(bindings.read('s1'), { chain: null, retries: { 'p/m': 2 } })
  assert.equal(errors.length, 1, 'the fallback is announced, not silent')
  assert.match(errors[0], /model_router_sessions/)
})

test('a binding outside 0..99 or keyed by a non-route is rejected, not clamped', async () => {
  const bindings = new SessionBindings(fakeContext(undefined))
  await assert.rejects(() => bindings.write('s1', { chain: null, retries: { 'p/m': 100 } }), /integer in 0\.\.99/)
  await assert.rejects(() => bindings.write('s1', { chain: null, retries: { 'p/m': 1.5 } }), /integer in 0\.\.99/)
  await assert.rejects(() => bindings.write('s1', { chain: null, retries: { pm: 1 } }), /provider\/model/)
  assert.equal(bindings.read('s1'), undefined)
})

test('the session binding domain declares the shape the routing path reads', () => {
  // 域在模块加载时由 defineDomain 校验（名字受 UNIT_NAME_RE 约束），记录 schema
  // 与 wire 类型同源；这里断言的是"用户写进去的就是路由读到的"。
  assert.equal(sessionBindingsDomain.name, 'model_router_sessions')
  assert.equal(sessionBindingsDomain.version, 1)
  assert.deepEqual(sessionBindingsDomain.tables.bindings.valueSchema.parse({ chain: null, retries: { 'p/m': 0 } }),
    { chain: null, retries: { 'p/m': 0 } })
  assert.throws(() => sessionBindingsDomain.tables.bindings.valueSchema.parse({ chain: null, retries: { 'p/m': 100 } }))
  // 0 与"没填"在存储层也是两件事：前者是键存在、值为 0。
  assert.deepEqual(emptyBinding(), { chain: null, retries: {} })
})

test('the chain rules reject a repeated route and a weight strategy with nothing to draw', () => {
  const repeated = structuralViolations(structural(chainValue({ candidates: [cand('a'), cand('a')] })))
  assert.deepEqual(repeated.map(v => v.key), ['problemDuplicateRouteInChain'])
  const weightless = structuralViolations(structural(chainValue({ candidates: [cand('a')], strategy: 'weight' })))
  assert.deepEqual(weightless.map(v => v.key), ['problemWeightNoPositive'])
  assert.deepEqual(structuralViolations(structural(chainValue({ candidates: [cand('a')] }))), [])
})

test('the failover notice names the failing route and the fallback position', () => {
  const message = failoverNotice({ provider: 'wb', model: 'global:deepseek' }, { provider: 'stepfun', model: 'step' }, 1, 3, 'SERVER')
  const text = message.content[0].text
  assert.match(text, /wb\/global:deepseek/)
  assert.match(text, /服务端错误/)
  assert.match(text, /stepfun\/step/)
  assert.match(text, /降级 1\/3/)
  assert.doesNotMatch(text, /主模型/, 'a global chain has no primary model to name')
})

test('a switch back to the user model is not called "降级 0"', () => {
  // 权重/轮询策略会把链旋转，切换目标可能是用户自己选中的模型（order 0）。
  // 那不是"降级"，也不能印出一个不存在的编号。
  const message = failoverNotice({ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }, 0, 2, 'RATE_LIMIT')
  const text = message.content[0].text
  assert.match(text, /切回你选择的模型/)
  assert.doesNotMatch(text, /降级 0/)
})

// ---- Agent Fleet: unknown is not zero, and the topology is root -> direct children ----

const fleetSummaryOf = (id, over = {}) => ({
  id,
  displayTitle: id,
  running: false,
  retainedBy: { referenceCount: 0, retainedBy: {} },
  blank: false,
  updatedAt: 1,
  ...over,
})

const fleetList = ({ ids, byId, projectionsBySession = {}, phase = 'ready' }) => ({
  ids, byId, phase, projectionsBySession,
})

const fleetProjection = (values, state = 'ready') => ({ state, error: null, values })

const fleetWorkspaces = (items = []) => ({
  items,
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'ready',
  phase: 'ready',
  error: null,
})

test('the fleet never turns an unloaded catalog into zero agents', () => {
  const list = fleetList({
    ids: ['p'],
    byId: { p: fleetSummaryOf('p') },
  })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  const unknown = fleetSummary(rows, false)
  assert.equal(unknown.runningAgents, undefined, 'an unloaded catalog is unknown, not 0')
  assert.equal(unknown.runningAgentsUnknown, 1)
  assert.equal(unknown.childrenUnknown, 0, 'no loaded catalog means no child-status sample to count')

  const ready = fleetList({
    ids: ['p'],
    byId: { p: fleetSummaryOf('p') },
    projectionsBySession: { p: fleetProjection({ subagentCatalog: [] }) },
  })
  const readyRows = fleetRows(ready, new Map(), new Map(), () => undefined)
  const knownZero = fleetSummary(readyRows, false)
  assert.equal(knownZero.runningAgents, 0, 'a ready empty catalog is a known zero')
  assert.equal(knownZero.runningAgentsUnknown, 0)
})

test('a list read failure paints every fleet summary cell as unknown', () => {
  const list = fleetList({
    ids: ['p'],
    byId: { p: fleetSummaryOf('p') },
    projectionsBySession: { p: fleetProjection({ subagentCatalog: [] }) },
  })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  const summary = fleetSummary(rows, true)
  assert.equal(summary.listError, true)
  for (const key of ['runningSessions', 'runningAgents', 'pending', 'anomalies']) {
    assert.equal(summary[key], undefined, `${key} must be —, not a number`)
  }
})

test('the fleet counts running direct children and pending approvals without inventing state', () => {
  const child = fleetSummaryOf('c', { parentId: 'p', origin: 'subagent', running: true })
  const list = fleetList({
    ids: ['p', 'c'],
    byId: { p: fleetSummaryOf('p', { running: true }), c: child },
    projectionsBySession: {
      p: fleetProjection({
        subagentCatalog: [{ id: 'c', createdAt: 1, mode: 'continuable', label: 'reviewer' }],
      }),
    },
  })
  const statuses = new Map([
    ['p', { running: true, pendingInteraction: { key: 'a', kind: 'approval', sessionId: 'p' }, completionUnread: false }],
  ])
  const rows = fleetRows(list, statuses, new Map(), () => undefined)
  const summary = fleetSummary(rows, false)
  assert.equal(summary.runningSessions, 1)
  assert.equal(summary.runningAgents, 1)
  assert.equal(summary.pending, 1)
  assert.deepEqual(fleetQueue(rows).map((item) => item.kind), ['approval'])
  assert.equal(rows[0].state, 'running')
})

test('a child whose latest turn did not complete is "not normal", never "failed"', () => {
  const child = fleetSummaryOf('c', { parentId: 'p', origin: 'subagent', running: false })
  const list = fleetList({
    ids: ['p', 'c'],
    byId: { p: fleetSummaryOf('p'), c: child },
    projectionsBySession: {
      p: fleetProjection({
        subagentCatalog: [{ id: 'c', createdAt: 1, mode: 'continuable', label: 'reviewer' }],
      }),
      c: fleetProjection({ subagentTiming: { settledMs: 1200, lastTurnCompleted: false } }),
    },
  })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  assert.equal(rows[0].anomaly, true)
  const session = fleetSession(
    list, new Map(), 'p', new Map(), () => undefined, fleetWorkspaces(), () => true, 'p',
  )
  assert.equal(session.agents[0].state, 'anomaly')
  assert.equal(session.agents[0].label, 'reviewer')
  assert.equal(zh.fleetAgentAnomaly.includes('失败'), false, 'the Chinese copy must not say 失败')
  assert.equal(en.fleetAgentAnomaly.toLowerCase().includes('fail'), false, 'the English copy must not say failed')
})

test('a child timing that is absent is unknown, not a completed turn', () => {
  const child = fleetSummaryOf('c', { parentId: 'p', origin: 'subagent', running: false })
  const list = fleetList({
    ids: ['p', 'c'],
    byId: { p: fleetSummaryOf('p'), c: child },
    projectionsBySession: {
      p: fleetProjection({
        subagentCatalog: [{ id: 'c', createdAt: 1, mode: 'continuable', label: 'reviewer' }],
      }),
    },
  })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  assert.equal(rows[0].anomaly, undefined, 'no timing sample means unknown, not false')
  const session = fleetSession(
    list, new Map(), 'p', new Map(), () => undefined, fleetWorkspaces(), () => true, 'p',
  )
  assert.equal(session.agents[0].state, 'unknown')
})

test('the fleet activity stream reads the handoff projection and keeps its three states apart', () => {
  const view = (handoff) => fleetSession(
    fleetList({
      ids: ['p'],
      byId: { p: fleetSummaryOf('p') },
      projectionsBySession: {
        p: fleetProjection(handoff === undefined
          ? { subagentCatalog: [] }
          : { subagentCatalog: [], [HANDOFF_KEY]: handoff }),
      },
    }),
    new Map(), 'p', new Map(), () => undefined, fleetWorkspaces(), () => true, 'p',
  )
  const emptyProjection = { epoch: 1, stats: { turns: 0, compactions: 0, toolFailures: 0 }, pending: [], records: [] }

  // 没有这个 key：投影未加载，活动流保持"尚未接入"，不画空时间线。
  assert.equal(view(undefined).activity, undefined)
  // key 在、records 空：已接入但还没有回执——已知的 0，和"未接入"是两种状态。
  assert.deepEqual(view(emptyProjection).activity, [])
  // 有回执：最新的在前，只带投影真的折叠过的字段。
  assert.deepEqual(view({
    ...emptyProjection,
    records: [
      { at: 1000, epoch: 1, turn: 1, kind: 'delegate', rosterId: 'reviewer' },
      { at: 2000, epoch: 1, turn: 1, kind: 'finish', outcome: 'done' },
    ],
  }).activity, [
    { at: 2000, kind: 'finish', rosterId: undefined, outcome: 'done' },
    { at: 1000, kind: 'delegate', rosterId: 'reviewer', outcome: undefined },
  ])
  // 一个形状不对的行不会变成一行假活动。
  assert.deepEqual(view({
    ...emptyProjection,
    records: [{ at: 'x', kind: 'delegate' }, { kind: 'finish' }, null, 'delegate'],
  }).activity, [])
})

test('the fleet budgets add what a relay carried in, and hide when a number is unknown', () => {
  const list = (handoff) => fleetList({
    ids: ['p'],
    byId: { p: fleetSummaryOf('p') },
    projectionsBySession: {
      p: fleetProjection(handoff === undefined
        ? { subagentCatalog: [] }
        : { subagentCatalog: [], [HANDOFF_KEY]: handoff }),
    },
  })
  const config = {
    limits: { delegations: 8, reviews: 1, newSessions: 2 },
    reviewIds: new Set(['reviewer']),
  }
  // epoch 2 是这个人的消息：epoch 1 的那次派发不算。
  const state = {
    epoch: 2,
    openTurn: 3,
    stats: { turns: 1, compactions: 0, toolFailures: 0 },
    pending: [],
    records: [
      { at: 1, epoch: 2, turn: 3, kind: 'delegate', rosterId: 'coder' },
      { at: 2, epoch: 2, turn: 3, kind: 'delegate', rosterId: 'reviewer' },
      { at: 3, epoch: 2, turn: 3, kind: 'newSession' },
      { at: 4, epoch: 1, turn: 1, kind: 'delegate', rosterId: 'coder' },
    ],
  }
  const carried = { carried: true, delegations: 4, reviews: 0, newSessions: 1, perRole: { coder: 2 } }
  const view = (handoff, input) => fleetSession(
    list(handoff), new Map(), 'p', new Map(), () => undefined, fleetWorkspaces(), () => true, 'p', input,
  )

  const budget = view(state, { carried, config }).budget
  assert.deepEqual(budget, {
    delegations: { used: 6, limit: 8 },
    reviews: { used: 1, limit: 1 },
    newSessions: { used: 2, limit: 2 },
  })
  // 文案模板与数字拼法：两本字典都写成同一句，数字来自模型而不是用例里再写一遍。
  assert.equal(fill(zh.fleetBudgetValue, budget.delegations), '6 / 8')
  assert.equal(fill(en.fleetBudgetValue, budget.delegations), '6 / 8')

  // carried 还没读回来 = 未知：整块隐藏，不是把投影数字当成全部。
  assert.equal(view(state, { carried: undefined, config }).budget, undefined)
  // handoff 关着 = 没有预算可说。
  assert.equal(view(state, { carried, config: undefined }).budget, undefined)
  // 投影未加载 = 未知。
  assert.equal(view(undefined, { carried, config }).budget, undefined)
})

test('the fleet groups by workspace and keeps running rows first', () => {
  const workspaces = fleetWorkspaces([{
    workspaceId: 'w1', path: '/w1', title: 'W1', sessionIds: ['a', 'b'], createdAt: '', updatedAt: '',
  }])
  const list = fleetList({
    ids: ['a', 'b'],
    byId: {
      a: fleetSummaryOf('a', { running: false, updatedAt: 20 }),
      b: fleetSummaryOf('b', { running: true, updatedAt: 10 }),
    },
  })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  const groups = fleetGroups(rows, workspaces)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].rows.map((row) => row.id), ['b', 'a'])
  assert.equal(groups[0].runningCount, 1)
})

test('the fleet scope reports loaded and unknown without hiding the tail', () => {
  const ids = Array.from({ length: FLEET_SCOPE_LIMIT + 2 }, (_, index) => `s${String(index).padStart(2, '0')}`)
  // The list orders by updatedAt desc; make the array order and the recency order agree.
  const byId = Object.fromEntries(ids.map((id, index) => [id, fleetSummaryOf(id, { updatedAt: 1000 - index })]))
  const projectionsBySession = Object.fromEntries(ids.slice(0, FLEET_SCOPE_LIMIT - 2)
    .map((id) => [id, fleetProjection({ subagentCatalog: [] })]))
  const list = fleetList({ ids, byId, projectionsBySession })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  const scope = fleetScope(rows)
  assert.equal(scope.total, FLEET_SCOPE_LIMIT + 2)
  assert.equal(scope.scope, FLEET_SCOPE_LIMIT)
  assert.equal(scope.loaded, FLEET_SCOPE_LIMIT - 2)
  assert.equal(scope.unknown, 4)
})

test('search and filters only read the loaded rows', () => {
  const list = fleetList({
    ids: ['alpha', 'beta'],
    byId: {
      alpha: fleetSummaryOf('alpha', { running: true }),
      beta: fleetSummaryOf('beta', { running: false }),
    },
  })
  const rows = fleetRows(list, new Map(), new Map(), () => undefined)
  assert.deepEqual(filterFleetRows(rows, 'alph', 'all').map((row) => row.id), ['alpha'])
  assert.deepEqual(filterFleetRows(rows, '', 'running').map((row) => row.id), ['alpha'])
  assert.deepEqual(filterFleetRows(rows, '', 'pending'), [])
})

test('the fleet token total is the four disjoint buckets, and absent usage stays absent', () => {
  assert.equal(totalTokens({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }), 18)
  assert.equal(totalTokens(undefined), undefined)
  assert.equal(formatTokenCount(1234), '1.2k')
  assert.equal(formatTokenCount(999), '999')
})

test('the subagent chat address matches DSH native fixture', () => {
  assert.equal(
    subagentChatAddress({ parentSessionId: 'parent/a', childSessionId: 'child#1', mode: 'continuable' }),
    'dsh-resource://subagentchat/session/child%231?parent=parent%2Fa&mode=continuable',
  )
})

// ---- Agent Fleet: scheduling belongs to the tab's visibility ----

const fleetControllerHarness = () => {
  const started = []
  const inflight = []
  const ctx = {
    sessions: {
      refresh: () => Promise.resolve(),
      refreshProjections: (id) => {
        started.push(id)
        return new Promise((resolve) => { inflight.push({ id, resolve }) })
      },
    },
  }
  const controller = createFleetController(ctx, {
    scope: { getSnapshot: () => ({ value: {} }) },
    t: (key) => key,
  })
  return { controller, started, inflight }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('pausing the fleet controller stops the queue and drops repaints until it resumes', async () => {
  const h = fleetControllerHarness()
  let paints = 0
  h.controller.subscribe(() => { paints += 1 })

  h.controller.ensureSessions(['a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(h.started, ['a', 'b', 'c', 'd'], 'the first paint fills the four read slots')

  h.controller.pause()
  h.inflight[0].resolve()
  await settle()
  assert.equal(h.started.length, FLEET_CONCURRENCY, 'nothing new is dispatched while the body is off screen')
  assert.equal(paints, 0, 'a read that settles while hidden does not repaint the hidden body')

  h.controller.resume()
  assert.equal(paints, 1, 'resume repaints once so the settled read reaches the view')
  assert.deepEqual(h.started, ['a', 'b', 'c', 'd', 'e'], 'the queue continues from where it stopped')

  h.controller.dispose()
  h.inflight[1].resolve()
  await settle()
  assert.equal(h.started.length, FLEET_CONCURRENCY + 1, 'dispose cancels nothing that was already dispatched')
  assert.equal(paints, 1, 'and it stops repainting for good')
})

test('a paused body still queues what it asked for, and resume is idempotent', async () => {
  const h = fleetControllerHarness()
  h.controller.ensureSessions(['a'])
  h.controller.pause()
  h.controller.ensureSessions(['b', 'c'])
  assert.deepEqual(h.started, ['a'], 'queued reads wait for the body to come back')

  h.controller.resume()
  h.controller.resume()
  assert.deepEqual(h.started, ['a', 'b', 'c'], 'a second resume neither duplicates nor drops the queue')
})

test('the fleet controller reads the carried budget and the configured limits, and a refusal stays unknown', async () => {
  const calls = []
  const scopeValue = {
    handoff: {
      enabled: true,
      roster: [{ id: 'reviewer', role: 'review', purpose: '复核', instructions: '只读' }],
      limits: { maxDelegationsPerUserMessage: 8, maxReviewsPerUserMessage: 1, maxNewSessionsPerUserMessage: 2 },
    },
  }
  const sessions = { refresh: () => Promise.resolve(), refreshProjections: () => Promise.resolve() }
  const controller = createFleetController({
    sessions,
    remote: {
      deskHealth: {
        handoffCarried: (sessionId) => {
          calls.push(sessionId)
          return Promise.resolve({
            ok: true,
            value: { carried: true, delegations: 4, reviews: 0, newSessions: 1, perRole: { coder: 2 } },
          })
        },
      },
    },
  }, { scope: { getSnapshot: () => ({ value: scopeValue }) }, t: (key) => key })

  // 上限与"谁是复核角色"都来自浏览器自己那份配置，和名册页看到的是同一份。
  assert.deepEqual(controller.handoffBudgetConfig(), {
    limits: { delegations: 8, reviews: 1, newSessions: 2 },
    reviewIds: new Set(['reviewer']),
  })
  assert.equal(controller.carriedSnapshot().size, 0, 'nothing is read before the view asks')
  assert.deepEqual(await controller.loadCarried('s1'), {
    carried: true, delegations: 4, reviews: 0, newSessions: 1, perRole: { coder: 2 },
  })
  assert.equal((await controller.loadCarried('s1')).delegations, 4, 'the second read is the cache')
  assert.deepEqual(calls, ['s1'], 'and the Host is asked once')

  // 被拒的读是未知，不是"没带预算"：缓存留空，预算块因此隐藏。
  const refused = createFleetController({
    sessions,
    remote: { deskHealth: { handoffCarried: () => Promise.resolve({ ok: false, error: { code: 'gateway/denied' } }) } },
  }, { scope: { getSnapshot: () => ({ value: scopeValue }) }, t: (key) => key })
  assert.equal(await refused.loadCarried('s1'), undefined)
  assert.equal(refused.carriedSnapshot().has('s1'), false)

  // handoff 关着：没有预算可说（整块隐藏），而不是画 0/8。
  const off = createFleetController({ sessions }, {
    scope: { getSnapshot: () => ({ value: { handoff: { enabled: false, roster: [] } } }) },
    t: (key) => key,
  })
  assert.equal(off.handoffBudgetConfig(), undefined)
})

test('a projection in state=error is unknown, not an empty catalog', () => {
  for (const state of ['error', 'migration-required']) {
    const child = fleetSummaryOf('c', { parentId: 'p', origin: 'subagent', running: false })
    const list = fleetList({
      ids: ['p', 'c'],
      byId: { p: fleetSummaryOf('p'), c: child },
      projectionsBySession: {
        p: fleetProjection({
          subagentCatalog: [{ id: 'c', createdAt: 1, mode: 'continuable', label: 'reviewer' }],
        }, state),
      },
    })
    const rows = fleetRows(list, new Map(), new Map(), () => undefined)
    assert.equal(rows[0].children, undefined, `state=${state} is not a loaded catalog`)
    assert.equal(rows[0].anomaly, undefined, `state=${state} carries no timing sample`)
    assert.equal(fleetSummary(rows, false).runningAgents, undefined, `state=${state} keeps the cell at —`)
    const session = fleetSession(
      list, new Map(), 'p', new Map(), () => undefined, fleetWorkspaces(), () => true, 'p',
    )
    assert.equal(session.catalogLoaded, false, `state=${state} goes behind the explicit load, not an empty topology`)
    assert.equal(session.agents.length, 0)
  }
})

test('the fleet 8s list timeout is a localized sentence with the seconds kept in one place', () => {
  const source = readFileSync(new URL('../src/client/fleet/controller.ts', import.meta.url), 'utf8')
  assert.match(source, /const REFRESH_TIMEOUT_MS = 8000/, 'the liveness guard keeps its one budget')
  assert.match(source, /fill\(options\.t\('fleetListTimeout'\), \{ seconds: REFRESH_TIMEOUT_MS \/ 1000 \}\)/,
    'the message is a locale key filled from the same constant, not English prose')
  for (const [name, table] of [['zh', zh], ['en', en]]) {
    assert.equal(typeof table.fleetListTimeout, 'string', `${name} carries the timeout key`)
    assert.match(table.fleetListTimeout, /\{seconds\}/, `${name} keeps the seconds a parameter`)
    assert.ok(fill(table.fleetListTimeout, { seconds: 8 }).includes('8'), `${name} fills the number`)
  }
})

// ---- handoff: roster compilation, projection counters and the gates ----
//
// 这些是纯函数：投影的 apply、四个闸门、描述编译。真实 Loader 组合里"工具注册 +
// 拒绝路径"由 run.mjs 的场景覆盖，这里钉的是"计数与拒绝条件本身"。

const rosterEntry = (over = {}) => ({
  id: 'reviewer',
  name: '复核',
  role: 'review',
  purpose: '独立复核：判断目标是否真的达成，列出缺口。',
  instructions: '你只读工件，不改文件。',
  preset: '',
  provider: '',
  model: '',
  reasoningEffort: '',
  maxTokens: 0,
  failover: 'inherit',
  attach: ['goal', 'todos', 'userRequest', 'stats'],
  maxRunsPerUserMessage: 6,
  ...over,
})

const handoffConfig = (over = {}) => ({
  enabled: true,
  subagentBackend: 'spawn',
  roster: [rosterEntry()],
  delegateDefaults: { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
  protocol: {
    delegate: true,
    finish: true,
    facts: true,
    requireReviewFor: [],
    allowReviewOverride: true,
  },
  limits: {
    maxDelegationsPerTurn: 1,
    maxDelegationsPerUserMessage: 8,
    maxReviewsPerUserMessage: 1,
    maxNewSessionsPerUserMessage: 2,
    nudgeWhenUnreceipted: false,
    maxNudgesPerTurn: 1,
  },
  onUnreceiptedStop: { delegateTo: '', reportToUser: true },
  newSession: {
    onFinish: [],
    nextAction: 'continue',
    briefing: ['goal', 'todos', 'userRequest', 'lastReview', 'stats'],
    keepGoal: true,
    carrySelection: true,
    carryChainBinding: true,
    // 默认模板就是发布时的措辞：现有断言（【接力】/【交接说明】）因此同时是
    // "默认渲染没变"的回归网。
    promptTemplate: DEFAULT_HANDOFF_PROMPT_TEMPLATE,
    promptExtra: '',
  },
  ...over,
})

const handoffGate = (over = {}) => ({
  config: handoffConfig(),
  counters: { epoch: 1, turnDelegations: 0, delegations: 0, reviews: 0, newSessions: 0, perRole: {} },
  carried: undefined,
  reviews: [],
  goalActive: false,
  ...over,
})

test('the tool description carries every purpose and never the instructions', () => {
  // 一个字段只有一个读者：purpose 进主模型的菜单，instructions 只进子会话。
  // 描述每轮都进上下文，把 instructions 也编进去等于每次派发前先给主模型看一遍岗位规范。
  const config = handoffConfig({
    roster: [
      rosterEntry({ id: 'reviewer', purpose: 'PURPOSE-REVIEW', instructions: 'INSTRUCTIONS-REVIEW' }),
      rosterEntry({ id: 'coder', role: 'work', purpose: 'PURPOSE-CODE', instructions: 'INSTRUCTIONS-CODE' }),
    ],
  })
  const description = compileDescription(config)
  assert.ok(description.includes('PURPOSE-REVIEW') && description.includes('PURPOSE-CODE'))
  assert.equal(description.includes('INSTRUCTIONS-REVIEW'), false, 'instructions never reach the main model')
  assert.equal(description.includes('INSTRUCTIONS-CODE'), false)
})

test('the description tells the model when to hand over and what the note must contain', () => {
  // 模型只有这一个地方能读到交接契约：没有"何时交"，它只会闷头做完；
  // 没有"note 写什么"，交出去的就是一句"继续"。
  const description = compileDescription(handoffConfig({
    roster: [rosterEntry({ id: 'coder', role: 'work', purpose: '写代码', instructions: '只改指定文件' })],
  }))
  assert.match(description, /Hand over with newSession when:/)
  assert.match(description, /the user asks for a fresh session or a new-session prompt/)
  assert.match(description, /context has been compacted repeatedly/)
  assert.match(description, /next step is a review or an independent task/)
  assert.match(description, /The handoffNote is the next session's task/)
  for (const clause of [
    'the verifiable boundary of what is finished',
    'the exact next step and the files it touches',
    'what must not be redone',
    'what to read first',
    'the acceptance requirement the user stated',
  ]) {
    assert.ok(description.includes(clause), `the note checklist names ${clause}`)
  }
  assert.match(description, /A note that only says "continue" is not a handover/)
  // 仍然不把角色的岗位规范编进来（那是子会话的读者）。
  assert.equal(description.includes('只改指定文件'), false)
})

test('an empty roster still registers a tool that refuses delegation', () => {
  const description = compileDescription(handoffConfig({ roster: [] }))
  assert.match(description, /No roles are configured/)
})

test('the projection resets the budget on a human message and only on a human message', () => {
  const human = { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } }
  const briefing = { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'carry on' }], source: { kind: 'model-desk-handoff', form: 'notice', summary: 'x' } } }
  const settled = { type: 'user/message', time: 3, data: { content: [{ type: 'text', text: 'child done' }], source: { kind: 'subagent-settled', form: 'notice', summary: 'y', senderSessionId: 's' } } }
  let state = handoffProjection.init()
  state = handoffProjection.apply(state, human)
  assert.equal(state.epoch, 1)
  assert.equal(state.lastUserText, 'do it')
  state = handoffProjection.apply(state, briefing)
  state = handoffProjection.apply(state, settled)
  assert.equal(state.epoch, 1, 'the plugin\'s own messages do not reset the budget')
})

test('a refused call spends no budget, a successful one does', () => {
  const call = (callId) => ({ type: 'tool/call', time: 5, data: { turn: 1, step: 1, callId, name: 'handoff', arguments: '{"action":"delegate","rosterId":"reviewer"}' } })
  const result = (callId, isError) => ({ type: 'tool/result', time: 6, data: { turn: 1, step: 1, message: { toolCallId: callId, isError }, ...isError ? { error: { name: 'HarnessError', code: 'HANDOFF_ROLE_BUDGET' } } : {} } })
  const reviews = new Set(['reviewer'])
  let state = handoffProjection.init()
  state = handoffProjection.apply(state, { type: 'step/start', time: 4, data: { turn: 1, step: 1 } })
  state = handoffProjection.apply(state, call('a'))
  state = handoffProjection.apply(state, result('a', true))
  assert.equal(handoffCounters(state, reviews).delegations, 0, 'a refusal is not a delegation')
  state = handoffProjection.apply(state, call('b'))
  state = handoffProjection.apply(state, result('b', false))
  const counters = handoffCounters(state, reviews)
  assert.equal(counters.delegations, 1)
  assert.equal(counters.turnDelegations, 1)
  assert.equal(counters.reviews, 1, 'a review role counts against the review budget')
  assert.deepEqual(counters.perRole, { reviewer: 1 })
})

test('the fold keeps a finish outcome and never attaches one to another action', () => {
  const call = (callId, args) => ({ type: 'tool/call', time: 5, data: { turn: 1, step: 1, callId, name: 'handoff', arguments: args } })
  const result = callId => ({ type: 'tool/result', time: 6, data: { turn: 1, step: 1, message: { toolCallId: callId } } })
  let state = handoffProjection.init()
  state = handoffProjection.apply(state, { type: 'step/start', time: 4, data: { turn: 1, step: 1 } })
  state = handoffProjection.apply(state, call('a', '{"action":"finish","outcome":"done"}'))
  state = handoffProjection.apply(state, result('a'))
  // delegate 的 arguments 里就算带了 outcome，也不是它声明过的事。
  state = handoffProjection.apply(state, call('b', '{"action":"delegate","rosterId":"reviewer","outcome":"done"}'))
  state = handoffProjection.apply(state, result('b'))
  assert.deepEqual(state.records.map(record => [record.kind, record.outcome ?? null]), [
    ['finish', 'done'],
    ['delegate', null],
  ])
})

test('the finish gate refuses done while a goal is active', () => {
  assert.throws(
    () => checkFinishGate(handoffGate({ goalActive: true }), { outcome: 'done' }),
    /HANDOFF_GOAL_ACTIVE|active goal/,
  )
  assert.doesNotThrow(() => checkFinishGate(handoffGate({ goalActive: true }), { outcome: 'needs_user' }))
})

test('the review gate only accepts a passing review from after the last human message', () => {
  const config = handoffConfig({ protocol: { ...handoffConfig().protocol, requireReviewFor: ['done'] } })
  const gate = (reviews) => handoffGate({ config, reviews })
  assert.throws(() => checkFinishGate(gate([]), { outcome: 'done' }), /no review/)
  // 旧 epoch 的复核是"人说话之前"的结论：失败关闭。
  assert.throws(
    () => checkFinishGate(gate([{ childId: 'c1', rosterId: 'reviewer', epoch: 0, verdict: 'pass', gaps: [], at: 1 }]), { outcome: 'done' }),
    /no review/,
  )
  assert.throws(
    () => checkFinishGate(gate([{ childId: 'c1', rosterId: 'reviewer', epoch: 1, verdict: 'gaps', gaps: ['缺测试'], at: 1 }]), { outcome: 'done' }),
    /缺测试/,
  )
  assert.doesNotThrow(() => checkFinishGate(
    gate([{ childId: 'c1', rosterId: 'reviewer', epoch: 1, verdict: 'pass', gaps: [], at: 1 }]),
    { outcome: 'done' },
  ))
  // 说明理由可以跳过，但只有配置允许时。
  assert.doesNotThrow(() => checkFinishGate(gate([]), { outcome: 'done', reviewOverride: '时间不够' }))
  const strict = handoffConfig({ protocol: { ...config.protocol, allowReviewOverride: false } })
  assert.throws(() => checkFinishGate(handoffGate({ config: strict }), { outcome: 'done', reviewOverride: '时间不够' }), /reviewOverride is disabled/)
})

test('an auto-relay outcome must carry a handoff note', () => {
  const config = handoffConfig({ newSession: { ...handoffConfig().newSession, onFinish: ['done'] } })
  assert.throws(() => checkFinishGate(handoffGate({ config }), { outcome: 'done' }), /handoffNote/)
  assert.doesNotThrow(() => checkFinishGate(handoffGate({ config }), { outcome: 'done', handoffNote: '从测试开始' }))
})

test('the delegation gates count turn, message and role budgets separately', () => {
  const entry = rosterEntry({ role: 'work' })
  const gate = (counters) => handoffGate({ counters: { ...handoffGate().counters, ...counters } })
  assert.throws(() => checkDelegateGate(gate({ turnDelegations: 1 }), entry), /maxDelegationsPerTurn/)
  assert.throws(() => checkDelegateGate(gate({ delegations: 8 }), entry), /maxDelegationsPerUserMessage/)
  assert.throws(() => checkDelegateGate(gate({ perRole: { reviewer: 6 } }), entry), /its limit is 6/)
  assert.doesNotThrow(() => checkDelegateGate(gate({}), entry))
  // 复核上限只挡复核角色。
  assert.throws(() => checkDelegateGate(gate({ reviews: 1 }), rosterEntry()), /maxReviewsPerUserMessage/)
  assert.doesNotThrow(() => checkDelegateGate(gate({ reviews: 1 }), entry))
})

test('the new-session gate counts the budget carried across sessions', () => {
  assert.throws(() => checkNewSessionGate(handoffGate(), ''), /handoffNote/)
  assert.doesNotThrow(() => checkNewSessionGate(handoffGate(), '继续'))
  // 接力复制过去的计数也算：换一个会话不能把预算刷满。
  assert.throws(
    () => checkNewSessionGate(handoffGate({ carried: { delegations: 0, reviews: 0, newSessions: 2, perRole: {} } }), '继续'),
    /maxNewSessionsPerUserMessage/,
  )
})

test('a reviewer that returns no structured verdict fails closed', () => {
  assert.deepEqual(verdictOf(undefined).verdict, 'gaps')
  assert.deepEqual(verdictOf({ verdict: 'pass' }).verdict, 'pass')
  assert.deepEqual(verdictOf({ verdict: 'gaps', gaps: ['a'] }).gaps, ['a'])
})

// ---- handoff runtime: 六步接力、facts、派发组装与复核结算 ----
//
// HandoffRuntime 本来就是依赖注入的（HandoffFaces）：这里用假 faces 驱动真实代码。
// 不把 @deepseek-ai/dsh-api-session-controller 塞进 headless 组合——它 inject 一串服务，
// 会把组合测试变成第二套宿主，而那正是本轮要避免的事。

/** 一个假 agent：一个会话 id、它 append 过的消息、它被唤醒时收到的消息。 */
function handoffAgent(id, options = {}) {
  const appended = []
  const followed = []
  const log = options.log
  return {
    session: {
      id,
      header: { cwd: 'D:\\work', ...options.header },
      // 旧会话的模型选择只从这条 durable 头里读（session.requestHeader()?.config）：
      // 内存里的选择器住在一个拿不到的私有类上。
      requestHeader: () => (options.selection === undefined ? undefined : { config: options.selection }),
      append(type, message, appendOptions) {
        if (log !== undefined) log.push('session.append')
        appended.push({ type, message, options: appendOptions })
      },
    },
    followup(message) {
      if (log !== undefined) log.push('followup')
      followed.push(message)
    },
    appended,
    followed,
  }
}

/** 投影面：一个 handoff 状态与一份 todos；缺席就是"未加载"，不是空值。 */
function handoffProjections(state, todos) {
  return {
    stateOf(_session, key) { return key === HANDOFF_KEY ? state : undefined },
    snapshot() { return { values: todos === undefined ? {} : { todos } } },
  }
}

const handoffState = (over = {}) => ({
  epoch: 1,
  stats: { turns: 3, compactions: 1, toolFailures: 2 },
  pending: [],
  records: [],
  ...over,
})

/** 账本的两张表（reviews / budgets），按表名分开记，写入可断言。 */
function fakeDomainTables() {
  const tables = new Map()
  const facility = {
    async open() {
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, new Map())
          const rows = tables.get(name)
          return { get: key => rows.get(key), put: async (key, value) => { rows.set(key, value) } }
        },
        close: async () => {},
      }
    },
  }
  return {
    context: () => ({
      get: name => (name === 'storageDomain' ? facility : undefined),
      logger: { error: () => {} },
      effect: () => {},
    }),
    rows: name => tables.get(name),
  }
}

/** 只观察调用顺序，读写仍落到真实的 SessionBindings / HandoffLedger 上。 */
function observedBindings(bindings, log) {
  return {
    read(sessionId) { log.push('binding.read'); return bindings.read(sessionId) },
    async write(sessionId, value) { log.push('binding.write'); return bindings.write(sessionId, value) },
  }
}

function observedLedger(ledger, log) {
  return {
    carriedOf: sessionId => ledger.carriedOf(sessionId),
    reviewsOf: sessionId => ledger.reviewsOf(sessionId),
    async carry(sessionId, budget) { log.push('ledger.carry'); return ledger.carry(sessionId, budget) },
    recordReview: (sessionId, record) => ledger.recordReview(sessionId, record),
    announceOnce: session => ledger.announceOnce(session),
  }
}

/** 注册真实的工具定义，返回一个按 `execute` 形状调用的入口。 */
function handoffTool(config, faces, ledger, bindings) {
  let definition
  const runtime = new HandoffRuntime(
    { ...faces, tools: { register(value) { definition = value; return () => {} } } },
    () => config,
    ledger,
    bindings,
  )
  runtime.register()
  return {
    runtime,
    call: (args, agent) => definition.execute(args, { agent, signal: new AbortController().signal }),
    definition: () => definition,
  }
}

const flushReview = () => new Promise(resolve => setImmediate(resolve))

test('a custom prompt template replaces the shipped wording and still carries the note', async () => {
  const oldAgent = handoffAgent('old', { selection: { provider: 'acme', model: 'main-1' } })
  const newAgent = handoffAgent('new')
  const controller = { async create() { return { sessionId: 'new' } }, async selectModel() {} }
  const registry = { get: id => (id === 'new' ? newAgent : undefined) }
  const base = handoffConfig()
  const config = handoffConfig({
    roster: [rosterEntry({ id: 'coder', role: 'work', purpose: '写代码', instructions: '只改指定文件' })],
    newSession: {
      ...base.newSession,
      promptTemplate: '任务：{note}\n要求：{extra}\n来源：{reason}',
      promptExtra: '只出结论，不改代码',
    },
  })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    goals: { get: () => undefined, create() {}, clear() {} },
    sessionController: () => controller,
    agents: () => registry,
    projections: handoffProjections(handoffState({ lastUserText: '收尾' }), []),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  await tool.call({ action: 'newSession', reason: 'finish:done', handoffNote: '接着做第 3 项' }, oldAgent)
  const text = newAgent.followed[0].content.map(block => block.text).join('\n')
  // 模板逐字生效：用户改的措辞就是新会话看到的那段，`{note}` 换成模型写的任务，
  // `{extra}` 是配置的常驻要求（不依赖模型记）。
  assert.equal(text, '任务：接着做第 3 项\n要求：只出结论，不改代码\n来源：finish:done')
})

test('newSession runs the six relay steps in order and carries selection, binding and budget', async () => {
  const log = []
  const selection = { provider: 'acme', model: 'main-1' }
  const oldAgent = handoffAgent('old', { log, selection })
  const newAgent = handoffAgent('new', { log })
  const goal = { id: 'goal-1', revision: 4, objective: '把 P2 收尾', phase: 'active', roundsStarted: 2, maxGoalRounds: 10 }
  const created = []
  const cleared = []
  const goals = {
    get: agent => (agent === oldAgent ? goal : undefined),
    create(agent, request) { log.push('goal.create'); created.push({ agent, request }); return { ...goal, ...request } },
    clear(agent, ref) { log.push('goal.clear'); cleared.push({ agent, ref }) },
  }
  const createRequests = []
  const selected = []
  // 真实公开面：`create(request)` 与 `selectModel(request)`（index.d.ts:101,107）。
  // 从前这里手写的是私有类上的三个方法，于是测试把错契约固化了。
  const controller = {
    async create(request) { log.push('create'); createRequests.push(request); return { sessionId: 'new' } },
    async selectModel(request) { log.push('selectModel'); selected.push(request) },
  }
  const registry = { get: id => (id === 'new' ? newAgent : undefined) }
  const state = handoffState({
    lastUserText: '把名册收尾',
    records: [{ at: 5, epoch: 1, turn: 1, kind: 'delegate', rosterId: 'coder' }],
  })
  const config = handoffConfig({
    roster: [rosterEntry({ id: 'coder', role: 'work', purpose: '写代码', instructions: '只改指定文件' })],
  })
  const ledger = new HandoffLedger(fakeDomainTables().context())
  await ledger.recordReview('old', { childId: 'r1', rosterId: 'reviewer', epoch: 1, verdict: 'pass', gaps: [], at: 9 })
  const bindings = new SessionBindings(fakeContext(undefined))
  await bindings.write('old', { chain: 'coding', retries: { 'p/m': 2 } })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    goals,
    sessionController: () => controller,
    agents: () => registry,
    projections: handoffProjections(state, [{ content: '写单测', status: 'in_progress' }]),
    logger: { error() {}, warn() {} },
  }, observedLedger(ledger, log), observedBindings(bindings, log))

  const receipt = await tool.call({ action: 'newSession', reason: 'finish:done', handoffNote: '从测试开始' }, oldAgent)

  assert.deepEqual(receipt, { action: 'newSession', newSession: 'new' })
  assert.equal(createRequests.length, 1)
  assert.equal(createRequests[0].cwd, 'D:\\work')
  assert.equal(typeof createRequests[0].reusable, 'function')
  assert.equal(createRequests[0].reusable('any'), false, 'the relay never reuses a session')
  // 六步：建会话 → 首跳 → 绑定与预算 → 简报 → 旧 goal 与 notice。
  // （第 1 步"读旧选择"读的是 durable 的 requestHeader，不经过 controller。）
  // goal.create 排在简报之前：重建失败时目标还得进简报（§4.6 步 6），而简报只发一次。
  assert.deepEqual(log, [
    'create', 'selectModel',
    'binding.read', 'binding.write', 'ledger.carry',
    'goal.create', 'followup', 'goal.clear', 'session.append',
  ])
  // 选择经公开的 selectModel 落地：会话 id + 旧会话真跑过的 provider/model。
  assert.deepEqual(selected, [{ sessionId: 'new', provider: 'acme', model: 'main-1' }])
  assert.deepEqual(bindings.read('new'), { chain: 'coding', retries: { 'p/m': 2 } })
  // 携带的预算就是闸门读数：投影 1 次派发 + 这次 newSession 自身 +1（投影里还没有它）。
  assert.deepEqual(ledger.carriedOf('new'), { delegations: 1, reviews: 0, newSessions: 1, perRole: { coder: 1 } })
  assert.deepEqual(created.map(entry => entry.agent), [newAgent])
  assert.deepEqual(created[0].request, { objective: '把 P2 收尾', maxGoalRounds: 10 })
  assert.deepEqual(cleared, [{ agent: oldAgent, ref: { id: 'goal-1', revision: 4 } }])

  assert.equal(newAgent.followed.length, 1)
  const message = newAgent.followed[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'model-desk-handoff', 'the briefing is the plugin\'s own source kind')
  const text = message.content.map(block => block.text).join('\n')
  assert.match(text, /^由插件按接力配置生成/)
  assert.match(text, /【接力】上一会话收工：finish:done/)
  assert.match(text, /【下一步】continue：接着干/)
  assert.match(text, /【交接说明】从测试开始/)
  for (const title of ['目标', '未完成待办', '最近一条用户原话', '最近一次复核', '统计']) {
    assert.ok(text.includes(title), `the briefing carries the configured artefact ${title}`)
  }
  assert.match(text, /把 P2 收尾（active，已用 2 轮）/)
  assert.match(text, /- \[in_progress\] 写单测/)
  assert.match(text, /把名册收尾/)
  assert.match(text, /pass/)
  assert.match(text, /压缩 1 次、轮次 3、工具失败 2/)

  assert.equal(oldAgent.followed.length, 0, 'the old session is not woken')
  assert.equal(oldAgent.appended.length, 1)
  assert.equal(oldAgent.appended[0].type, 'user/message')
  const notice = oldAgent.appended[0].message.content.map(block => block.text).join('\n')
  assert.match(notice, /新会话 new/)
  assert.match(notice, /finish:done/)
})

test('health channels list every chain position, not only the chain being edited', () => {
  // 4.14：位次曾读 `draft.chain`（正在编辑的那条），于是切链会改变对同一条渠道的
  // 结论（甚至显示"未配置到降级链"），而检查与探测走的却是全链。判据是
  // "每个 (链, 位次) 一条"，且观测到但没配在链里的路由不带位次。
  const dict = { channelUsedInChainNamed: '{chain} 第 {n} 位', chainDefaultName: '默认链' }
  const t = key => dict[key] ?? key
  const channels = healthChannels({
    draft: {
      chains: [
        { name: '', candidates: [{ provider: 'shared', model: 'm1' }] },
        { name: '写代码', candidates: [{ provider: 'shared', model: 'm1' }, { provider: 'only', model: 'm2' }] },
      ],
    },
    passive: { 'seen/route': {} },
    t: t,
  })
  const labelsOf = route => (channels.find(channel => channel.route === route)?.usages ?? []).map(usage => usage.label)
  assert.deepEqual(labelsOf('shared/m1'), ['默认链 第 1 位', '写代码 第 1 位'])
  assert.deepEqual(labelsOf('only/m2'), ['写代码 第 2 位'])
  assert.deepEqual(labelsOf('seen/route'), [], 'an observed route with no chain position carries no badge')
})

test('the hand-written SessionController face names only methods the real service has', async () => {
  // 3.3 的形状：face 手写三个方法，真实服务只有两个，`as` 强转让 tsc 沉默，
  // 一直到 newSession 才 `TypeError: controller.selectionFor is not a function`。
  // 这条用真实包的原型对账——不是再抄一份 d.ts，那只会多一个会漂移的副本。
  const { SessionController } = await import('@deepseek-ai/dsh-api-session-controller')
  const source = readFileSync(new URL('../src/handoff-tool.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export interface SessionControllerFace {')
  const face = source.slice(start, source.indexOf('export interface AgentRegistryFace', start))
  const declared = [...face.matchAll(/^\s{2}(\w+)\(/gm)].map(match => match[1]).sort()
  assert.deepEqual(declared, ['create', 'selectModel'], 'fixture: the face declares exactly the two public methods')
  for (const method of declared) {
    assert.equal(typeof SessionController.prototype[method], 'function',
      `${method} is not on the real SessionController (the ApiSessionAgentController is private and unreachable)`)
  }
})

test('the relay carries no selection and no binding when there is nothing to carry', async () => {
  const log = []
  const oldAgent = handoffAgent('old', { log })
  const newAgent = handoffAgent('new', { log })
  const controller = {
    async create() { log.push('create'); return { sessionId: 'new' } },
    async selectModel() { log.push('selectModel') },
  }
  const config = handoffConfig({
    roster: [rosterEntry({ id: 'coder', role: 'work' })],
    newSession: { ...handoffConfig().newSession, carryChainBinding: false },
  })
  const ledger = new HandoffLedger(fakeDomainTables().context())
  const bindings = new SessionBindings(fakeContext(undefined))
  await bindings.write('old', { chain: 'coding', retries: {} })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    sessionController: () => controller,
    agents: () => ({ get: id => (id === 'new' ? newAgent : undefined) }),
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn() {} },
  }, observedLedger(ledger, log), observedBindings(bindings, log))

  await tool.call({ action: 'newSession', handoffNote: '继续' }, oldAgent)

  // 旧会话没有 requestHeader（没跑过请求）→ 不调 selectModel；
  // carryChainBinding 为假 → 不读不写绑定。
  assert.deepEqual(log, ['create', 'followup', 'session.append'])
  assert.equal(bindings.read('new'), undefined)
  assert.equal(ledger.carriedOf('new'), undefined)
})

test('a goal that cannot be rebuilt still reaches the briefing', async () => {
  const warnings = []
  const oldAgent = handoffAgent('old')
  const newAgent = handoffAgent('new')
  const goal = { id: 'g1', revision: 1, objective: '把 1920 截图补上', phase: 'active', roundsStarted: 0, maxGoalRounds: 5 }
  const cleared = []
  const config = handoffConfig({
    roster: [rosterEntry({ id: 'coder', role: 'work' })],
    // 简报不列 goal：失败兜底必须自己补上目标，否则目标就丢了。
    newSession: { ...handoffConfig().newSession, briefing: ['todos'], keepGoal: true },
  })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    goals: {
      get: () => goal,
      create() { throw new Error('goal tool unavailable') },
      clear(agent, ref) { cleared.push({ agent, ref }) },
    },
    sessionController: () => ({
      async create() { return { sessionId: 'new' } },
      async selectModel() {},
    }),
    agents: () => ({ get: () => newAgent }),
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn(message) { warnings.push(message) } },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  await tool.call({ action: 'newSession', handoffNote: '继续' }, oldAgent)

  const text = newAgent.followed[0].content.map(block => block.text).join('\n')
  assert.match(text, /未能自动重建/)
  assert.match(text, /把 1920 截图补上/)
  assert.equal(warnings.length, 1, 'the failure is logged, not swallowed')
  assert.match(warnings[0], /could not be rebuilt/)
  assert.deepEqual(cleared, [{ agent: oldAgent, ref: { id: 'g1', revision: 1 } }], 'the old goal is still retired')
})

test('facts reports the real goal, todos and per-role delegations of this epoch', async () => {
  const agent = handoffAgent('s1')
  const goal = { id: 'g1', revision: 2, objective: '收尾 P2', phase: 'active', roundsStarted: 3, maxGoalRounds: 20 }
  const state = handoffState({
    stats: { turns: 7, compactions: 2, toolFailures: 3 },
    records: [
      { at: 1, epoch: 1, turn: 1, kind: 'delegate', rosterId: 'reviewer' },
      { at: 2, epoch: 1, turn: 1, kind: 'delegate', rosterId: 'coder' },
      { at: 3, epoch: 1, turn: 2, kind: 'finish' },
      { at: 4, epoch: 0, turn: 1, kind: 'delegate', rosterId: 'coder' },
    ],
  })
  const config = handoffConfig({ roster: [rosterEntry(), rosterEntry({ id: 'coder', role: 'work' })] })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    goals: { get: () => goal, create() {}, clear() {} },
    projections: handoffProjections(state, [
      { content: '写单测', status: 'in_progress' },
      { content: '更新文档', status: 'pending' },
      { content: '跑四套件', status: 'completed' },
    ]),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  const receipt = await tool.call({ action: 'facts' }, agent)

  assert.equal(receipt.compactions, 2)
  assert.equal(receipt.turns, 7)
  assert.equal(receipt.toolFailures, 3)
  assert.deepEqual(receipt.goal, { objective: '收尾 P2', phase: 'active', roundsStarted: 3 })
  assert.deepEqual(receipt.todos, { pending: 1, inProgress: 1, open: ['写单测', '更新文档'] })
  // 旧 epoch 的那次派发不算：人一说话，三本账清零。
  assert.deepEqual(receipt.delegations, { total: 2, perRole: { reviewer: 1, coder: 1 } })
})

test('facts reports todos as unknown, not as an empty list, when the projection has not loaded', async () => {
  const agent = handoffAgent('s1')
  const tool = handoffTool(handoffConfig(), {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    projections: handoffProjections(undefined, undefined),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  const receipt = await tool.call({ action: 'facts' }, agent)
  assert.equal(receipt.todos, null)
  assert.equal(receipt.goal, null)
  // 计数同理：没有投影 = 没数过。回 0 会让模型读成"从没派人"，
  // 而闸门读的是 counters（0 是它该有的拒绝基线），两处不许混。
  assert.equal(receipt.compactions, null)
  assert.equal(receipt.turns, null)
  assert.equal(receipt.toolFailures, null)
  assert.equal(receipt.delegations, null)
})

test('delegate assembles the child request from the roster and keeps one reader per field', async () => {
  const starts = []
  const agent = handoffAgent('s1')
  const goal = { id: 'g1', revision: 1, objective: '收尾 P2', phase: 'active', roundsStarted: 1, maxGoalRounds: 20 }
  const config = handoffConfig({
    roster: [
      rosterEntry({
        id: 'reviewer',
        name: '复核',
        preset: 'reviewer-preset',
        provider: 'acme',
        model: 'rev-1',
        reasoningEffort: 'high',
        maxTokens: 32000,
        instructions: '你只读工件，不改文件。',
      }),
      rosterEntry({ id: 'coder', role: 'work', purpose: '写代码', instructions: '', preset: '', attach: [] }),
    ],
  })
  const tool = handoffTool(config, {
    subagents: {
      async startActivation(spec) {
        starts.push(spec)
        return { childId: `child-${starts.length}`, result: new Promise(() => {}), dispose: async () => {} }
      },
    },
    goals: { get: () => goal, create() {}, clear() {} },
    projections: handoffProjections(handoffState({ lastUserText: '把名册收尾' }), [{ content: '写单测', status: 'pending' }]),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  const receipt = await tool.call({
    action: 'delegate',
    rosterId: 'reviewer',
    task: '复核这次改动',
    focusPaths: ['src/handoff.ts'],
  }, agent)

  assert.deepEqual(receipt, {
    action: 'delegate',
    child: 'child-1',
    rosterId: 'reviewer',
    attached: ['目标', '未完成待办', '最近一条用户原话', '统计', '先看的文件'],
  })
  const spec = starts[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent', 'the native wake is the parent inbox')
  assert.equal(spec.label, '复核')
  assert.equal(spec.request.agentPreset, 'reviewer-preset')
  assert.deepEqual(spec.request.agentOptions, { provider: 'acme', model: 'rev-1', reasoningEffort: 'high', maxTokens: 32000 })
  assert.equal(spec.request.outputSchema, REVIEW_VERDICT_SCHEMA, 'the verdict shape is the plugin\'s, not the roster\'s')
  const prompt = spec.request.prompt[0].text
  assert.ok(prompt.startsWith('你只读工件，不改文件。'), 'instructions come first')
  assert.ok(prompt.indexOf('复核这次改动') > prompt.indexOf('你只读工件，不改文件。'), 'then the task')
  for (const fact of ['【目标】', '【未完成待办】', '【最近一条用户原话】', '【统计】', '【先看的文件】']) {
    assert.ok(prompt.includes(fact), `the prompt carries ${fact}`)
  }
  assert.ok(prompt.indexOf('【目标】') > prompt.indexOf('复核这次改动'), 'artefacts come last')

  // 一个没有 preset / route 的 work 角色：不塞空字段，也不给复核 schema。
  const workReceipt = await tool.call({ action: 'delegate', rosterId: 'coder', task: '写测试' }, agent)
  const work = starts[1]
  assert.equal(Object.hasOwn(work.request, 'agentPreset'), false)
  assert.equal(Object.hasOwn(work.request, 'agentOptions'), false)
  assert.equal(Object.hasOwn(work.request, 'outputSchema'), false)
  assert.ok(work.request.prompt[0].text.startsWith('写测试'), 'no instructions means the task comes first')
  assert.deepEqual(workReceipt.attached, [], 'a role with no attach and no focus paths attaches nothing')
})

// ---- 全局委派模型：角色 → 全局 → 父会话，三档（2026-10-28 用户要求）----
test('the delegation route falls back from the role to the section default, then to the parent', async () => {
  const starts = []
  const agent = handoffAgent('s1')
  const toolFor = (config) => handoffTool(config, {
    subagents: {
      async startActivation(spec) {
        starts.push(spec)
        return { childId: `child-${starts.length}`, result: new Promise(() => {}), dispose: async () => {} }
      },
    },
    goals: { get: () => undefined, create() {}, clear() {} },
    projections: handoffProjections(handoffState({ lastUserText: '派活' }), []),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  const roster = [
    rosterEntry({ id: 'pinned', role: 'work', provider: 'acme', model: 'pinned-1', instructions: '干活' }),
    rosterEntry({ id: 'blank', role: 'work', purpose: '跟随', instructions: '干活' }),
  ]
  const defaults = { provider: 'acme', model: 'default-1', reasoningEffort: 'low', maxTokens: 4096 }

  // 1) 角色自己写了路由：用角色的，全局不覆盖。
  const withBoth = toolFor(handoffConfig({ roster, delegateDefaults: defaults }))
  await withBoth.call({ action: 'delegate', rosterId: 'pinned', task: 't1' }, agent)
  assert.deepEqual(starts[0].request.agentOptions, { provider: 'acme', model: 'pinned-1' },
    'a pinned role wins over the section default')

  // 2) 角色留空：落到全局那份（含它的 effort / maxTokens）。
  await withBoth.call({ action: 'delegate', rosterId: 'blank', task: 't2' }, agent)
  assert.deepEqual(starts[1].request.agentOptions, defaults,
    'a blank role uses the section default as a whole route')

  // 3) 全局也留空：请求里不带 agentOptions，交给 DSH 继承父会话当前路由。
  const withNothing = toolFor(handoffConfig({ roster }))
  await withNothing.call({ action: 'delegate', rosterId: 'blank', task: 't3' }, agent)
  assert.equal(Object.hasOwn(starts[2].request, 'agentOptions'), false,
    'no route anywhere means the child inherits the parent agent')
})

// ---- 新会话提示词：模板可改、附加要求常驻（2026-10-28 用户要求）----
test('the next-session prompt is a template whose empty placeholders drop their line', () => {
  const values = {
    reason: 'finish:done',
    nextAction: 'continue：接着干',
    extra: '只读，不改代码',
    note: '继续做第 3 项',
    report: '',
    artifacts: '',
  }
  // 默认模板 = 发布时的措辞：report / artifacts 为空时不留空标题。
  const byDefault = renderHandoffPrompt(DEFAULT_HANDOFF_PROMPT_TEMPLATE, values)
  assert.match(byDefault, /【接力】上一会话收工：finish:done/)
  assert.match(byDefault, /【附加要求】只读，不改代码/)
  assert.match(byDefault, /【交接说明】继续做第 3 项/)
  assert.ok(byDefault.includes('【下一步】continue：接着干'), byDefault)
  assert.equal(byDefault.includes('【收工说明】'), false, 'an empty report leaves no bare heading')
  assert.equal(byDefault.includes('【工件】'), false, 'no artefacts, no section')
  // 附加要求留空：那一行整行消失（默认配置与旧措辞逐字一致）。
  const noExtra = renderHandoffPrompt(DEFAULT_HANDOFF_PROMPT_TEMPLATE, { ...values, extra: '' })
  assert.equal(noExtra.includes('【附加要求】'), false)
  // 用户自定义：改字、换顺序都行；不认识的占位符原样保留（保存期由结构规则拒）。
  const custom = renderHandoffPrompt('任务：{note}\n\n要求：{extra}\n{unknown}', { ...values, extra: '' })
  assert.equal(custom, '任务：继续做第 3 项\n\n{unknown}')
})

test('the prompt template must keep the handoff note and only name known placeholders', () => {
  const keys = promptTemplate => structuralViolations({
    chains: [named(chainValue())],
    defaultChainId: 'default',
    handoff: handoffConfig({ newSession: { ...handoffConfig().newSession, promptTemplate } }),
  }).map(violation => violation.key)
  assert.deepEqual(keys(DEFAULT_HANDOFF_PROMPT_TEMPLATE), [])
  assert.deepEqual(keys(HANDOFF_PROMPT_PLACEHOLDERS.map(name => `{${name}}`).join(' ')), [],
    'every allowed placeholder passes')
  assert.deepEqual(keys('任务：{reason}'), ['problemHandoffPromptNoNote'],
    'a template without {note} would hand the next session no task')
  assert.deepEqual(keys('{note} {nope}'), ['problemHandoffUnknownPlaceholder'])
})

test('a half-filled default delegation route is refused, and the browser shows the same key', () => {
  const violations = (delegateDefaults) => structuralViolations({
    chains: [named(chainValue())],
    defaultChainId: 'default',
    handoff: handoffConfig({ delegateDefaults }),
  }).map((violation) => violation.key)
  assert.deepEqual(violations({ provider: 'acme', model: '', reasoningEffort: '', maxTokens: 0 }),
    ['problemHandoffHalfDefaultRoute'])
  assert.deepEqual(violations({ provider: '', model: 'only-a-model', reasoningEffort: '', maxTokens: 0 }),
    ['problemHandoffHalfDefaultRoute'])
  // 整条填、或两栏都空（= 跟随父会话）都合法。
  assert.deepEqual(violations({ provider: 'acme', model: 'm1', reasoningEffort: '', maxTokens: 0 }), [])
  assert.deepEqual(violations({ provider: '', model: '', reasoningEffort: '', maxTokens: 0 }), [])
  // 浏览器侧拿到同一个 key，而不是 host 的英文句子。
  const draft = {
    chains: [named(chainValue())],
    defaultChainId: 'default',
    health: normalizeHealth(undefined),
    handoff: normalizeHandoff(handoffConfig({ delegateDefaults: { provider: 'acme', model: '', reasoningEffort: '', maxTokens: 0 } })),
  }
  assert.deepEqual(validate(draft).map((problem) => problem.key), ['problemHandoffHalfDefaultRoute'])
})

test('a settled review is written to the ledger, and the finish gate reads that verdict', async () => {
  const agent = handoffAgent('s1')
  let settle
  const result = new Promise(resolve => { settle = resolve })
  const storage = fakeDomainTables()
  const ledger = new HandoffLedger(storage.context())
  const config = handoffConfig({
    protocol: { ...handoffConfig().protocol, requireReviewFor: ['done'] },
  })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { return { childId: 'review-child', result, dispose: async () => {} } } },
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn() {} },
  }, ledger, new SessionBindings(fakeContext(undefined)))

  await tool.call({ action: 'delegate', rosterId: 'reviewer', task: '复核' }, agent)
  // 还没结算：闸门拒绝。
  await assert.rejects(() => tool.call({ action: 'finish', outcome: 'done' }, agent), /no review/)

  settle({ structured: { verdict: 'pass' } })
  await flushReview()

  const stored = storage.rows('reviews').get('s1')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].childId, 'review-child')
  assert.equal(stored[0].rosterId, 'reviewer')
  assert.equal(stored[0].epoch, 1, 'the dispatch epoch, not the settlement time')
  assert.equal(stored[0].verdict, 'pass')
  assert.deepEqual(stored[0].gaps, [])
  assert.equal(typeof stored[0].at, 'number')

  const receipt = await tool.call({ action: 'finish', outcome: 'done' }, agent)
  assert.deepEqual(receipt, { action: 'finish', recorded: true, outcome: 'done' })
})

test('a review that finds gaps blocks finish with the gap list the ledger stored', async () => {
  const agent = handoffAgent('s1')
  let settle
  const result = new Promise(resolve => { settle = resolve })
  const ledger = new HandoffLedger(fakeDomainTables().context())
  const config = handoffConfig({
    protocol: { ...handoffConfig().protocol, requireReviewFor: ['done'] },
  })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { return { childId: 'review-child', result, dispose: async () => {} } } },
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn() {} },
  }, ledger, new SessionBindings(fakeContext(undefined)))

  await tool.call({ action: 'delegate', rosterId: 'reviewer', task: '复核' }, agent)
  settle({ structured: { verdict: 'gaps', gaps: ['缺少 1920 截图', '活动流未接'] } })
  await flushReview()

  await assert.rejects(
    () => tool.call({ action: 'finish', outcome: 'done' }, agent),
    /缺少 1920 截图; 活动流未接/,
  )
})

test('reviewOverride waives the review gate only, never the handoffNote gate', async () => {
  const agent = handoffAgent('s1')
  const base = handoffConfig()
  const config = handoffConfig({
    protocol: { ...base.protocol, requireReviewFor: ['done'] },
    newSession: { ...base.newSession, onFinish: ['done'] },
  })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  // 同一份配置，两个不同的拒绝：不写 override 时被复核闸挡住……
  await assert.rejects(() => tool.call({ action: 'finish', outcome: 'done' }, agent), /no review/)
  // ……写了 override 就该轮到 note 闸：`done` 在 onFinish 里，接力必须有下一步任务。
  await assert.rejects(
    () => tool.call({ action: 'finish', outcome: 'done', reviewOverride: '赶时间' }, agent),
    /handoffNote/,
  )
})

test('a finish outcome listed in newSession.onFinish goes through the same relay', async () => {
  const oldAgent = handoffAgent('old')
  const newAgent = handoffAgent('new')
  let created = 0
  const config = handoffConfig({
    roster: [rosterEntry({ id: 'coder', role: 'work' })],
    newSession: {
      ...handoffConfig().newSession,
      onFinish: ['done'],
      carrySelection: false,
      carryChainBinding: false,
    },
  })
  const tool = handoffTool(config, {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    sessionController: () => ({
      async create() { created += 1; return { sessionId: 'new' } },
      async selectModel() {},
    }),
    agents: () => ({ get: () => newAgent }),
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  const receipt = await tool.call(
    { action: 'finish', outcome: 'done', handoffNote: '下一段从测试开始', report: '改完 A，还差 B' },
    oldAgent,
  )

  assert.equal(created, 1, 'the auto-relay is the same function, not a second path')
  // report 原样进回执：它是"做了什么/还剩什么"的唯一落点，从前无人接收。
  assert.deepEqual(receipt, {
    action: 'finish',
    recorded: true,
    outcome: 'done',
    report: '改完 A，还差 B',
    newSessionId: 'new',
  })
  const text = newAgent.followed[0].content.map(block => block.text).join('\n')
  assert.match(text, /【接力】上一会话收工：finish:done/)
  assert.match(text, /【交接说明】下一段从测试开始/)
  assert.match(text, /【收工说明】改完 A，还差 B/, 'the new session gets what was left, not only where to start')
  // 用户侧也有一句：不必展开折叠的工具结果才知道收工说了什么。
  const noticeText = oldAgent.appended.map(entry => entry.message.content.map(block => block.text).join('\n')).join('\n')
  assert.match(noticeText, /收工回执（已完成）：改完 A，还差 B/)
})

test('finish without a relay still echoes the report and says it once', async () => {
  const agent = handoffAgent('s1')
  const tool = handoffTool(handoffConfig(), {
    subagents: { async startActivation() { throw new Error('this test never delegates') } },
    projections: handoffProjections(handoffState(), undefined),
    logger: { error() {}, warn() {} },
  }, new HandoffLedger(fakeDomainTables().context()), new SessionBindings(fakeContext(undefined)))

  const receipt = await tool.call({ action: 'finish', outcome: 'needs_user', report: '等你决定要不要换方案' }, agent)
  assert.deepEqual(receipt, { action: 'finish', recorded: true, outcome: 'needs_user', report: '等你决定要不要换方案' })
  const text = agent.appended.map(entry => entry.message.content.map(block => block.text).join('\n')).join('\n')
  assert.match(text, /收工回执（需要你决定）：等你决定要不要换方案/)
  // 没写 report 就不发通知：不为一句空话多花一条 durable 消息。
  await tool.call({ action: 'finish', outcome: 'done' }, agent)
  assert.equal(agent.appended.filter(entry => entry.message.content.some(block => block.text.includes('收工回执'))).length, 1)
})

test('the roster rules reject blank ids, duplicate ids, empty purposes and undefined roles', () => {
  const violations = (roster, over = {}) => structuralViolations({
    chains: [named(chainValue())],
    defaultChainId: 'default',
    handoff: handoffConfig({ roster, ...over }),
  }).map((violation) => violation.key)
  assert.deepEqual(violations([rosterEntry({ purpose: '   ' })]), ['problemRosterEmptyPurpose'])
  assert.deepEqual(violations([rosterEntry({ preset: '', instructions: '' })]), ['problemRosterNoDefinition'])
  assert.deepEqual(violations([rosterEntry({ instructions: 'x'.repeat(4001) })]), ['problemRosterInstructionsTooLong'])
  assert.deepEqual(violations([rosterEntry(), rosterEntry()]), ['problemRosterDuplicateId'])
  assert.deepEqual(violations([rosterEntry({ id: '  ' })]), ['problemRosterEmptyId'])
  assert.deepEqual(violations([rosterEntry({ provider: 'acme' })]), ['problemRosterHalfRoute'])
  assert.deepEqual(violations([rosterEntry({ failover: 'writing' })]), ['problemRosterUnknownFailoverChain'])
  assert.deepEqual(violations([], { onUnreceiptedStop: { delegateTo: 'ghost', reportToUser: true } }), ['problemUnreceiptedUnknownRole'])
})

test('a valid roster produces no violation, and the browser agrees with the host', () => {
  const roster = [rosterEntry(), rosterEntry({ id: 'coder', role: 'work', purpose: '写代码', instructions: '只改指定文件' })]
  const input = { chains: [named(chainValue())], defaultChainId: 'default', handoff: handoffConfig({ roster }) }
  assert.deepEqual(structuralViolations(input), [])
  // 浏览器侧读到同一份 draft 时也必须是 0 条：两边共用 rules.ts。
  const draft = {
    chains: [named(chainValue())],
    defaultChainId: 'default',
    health: normalizeHealth(undefined),
    handoff: normalizeHandoff(input.handoff),
  }
  assert.deepEqual(validate(draft), [])
  // 坏值在浏览器侧拿到的是同一个 key（不是 host 的英文句子）。
  draft.handoff.roster[0].purpose = ''
  assert.deepEqual(validate(draft).map((problem) => problem.key), ['problemRosterEmptyPurpose'])
})

test('normalizeHandoff reads a config written before the section existed as its defaults', () => {
  const fresh = normalizeHandoff(undefined)
  assert.equal(fresh.enabled, false, 'the section is off by default')
  assert.deepEqual(fresh.roster, [], 'no fake roster')
  assert.deepEqual(fresh.protocol.requireReviewFor, [])
  assert.equal(fresh.protocol.allowReviewOverride, true)
  assert.equal(fresh.limits.nudgeWhenUnreceipted, false)
  assert.equal(fresh.limits.maxNudgesPerTurn, 1)
  assert.deepEqual(fresh.newSession.onFinish, [])
  assert.deepEqual(fresh.newSession.briefing, ['goal', 'todos', 'userRequest', 'lastReview', 'stats'])
  assert.equal(fresh.newSession.nextAction, 'continue')
  // 与 host schema 的默认值同源：两边都读 ../defaults.ts。
  assert.equal(fresh.limits.maxDelegationsPerUserMessage, 8)
  assert.equal(fresh.limits.maxReviewsPerUserMessage, 1)
  assert.equal(fresh.limits.maxNewSessionsPerUserMessage, 2)
  // 没有「每日派发上限」：这个字段曾经在 schema、名册 UI 和校验里各走一遍，
  // 而 handoff.ts 一次都没读过它。删字段而不是造一套跨重启的时间源。
  assert.equal(Object.hasOwn(fresh.limits, 'maxDelegationsPerDay'), false)
  assert.equal(fresh.subagentBackend, 'spawn')
})

await Promise.all(pending)
console.log(`\n${passed} unit test(s) passed`)

