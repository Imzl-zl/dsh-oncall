#!/usr/bin/env node
/**
 * Tests for the ingress decision layer.
 *
 * These cover `src/core/*` and `src/contract/*` only: pure functions, no Cordis
 * context, no mocked clock, no I/O. Every case is a table row — the expected value
 * is written next to the input so a reviewer can check the rule without running
 * anything.
 *
 * The suite deliberately has no test framework. Node's type stripping imports the
 * `.ts` sources directly, so a failing rule points at the file that owns it.
 *
 * Usage: node packages/dsh-oncall/tests/ingress.mjs
 */

import assert from 'node:assert/strict'

import { admit } from '../src/core/admission.ts'
import { planStep } from '../src/core/plan-step.ts'
import { deriveStage } from '../src/core/stage.ts'
import { threadKey, triggerKey } from '../src/core/trigger-key.ts'

const SRC = 'github:acme/widgets'
const OTHER = 'chat:oc_room'

const human = (id, source = SRC) => ({ source, id, handle: `@${id}`, kind: 'human' })
const bot = (id, source = SRC) => ({ source, id, handle: `${id}[bot]`, kind: 'bot' })
const system = () => ({ source: SRC, id: 'harness', handle: 'harness', kind: 'system' })

const trigger = (over = {}) => ({
  key: triggerKey(SRC, 'comment-1'),
  source: SRC,
  thread: threadKey(SRC, '12'),
  kind: 'direct',
  actor: human('alice'),
  text: 'please fix the flaky test',
  at: 1_000,
  ...over,
})

const policy = (over = {}) => ({
  version: 1,
  acceptMode: 'off',
  allowed: [{ source: SRC, id: 'alice' }],
  bots: [],
  disabledSources: [],
  ...over,
})

const theCase = (over = {}) => ({
  id: 'case:1',
  mandate: { strength: 'explicit', actor: human('alice'), scope: [trigger().thread], policyVersion: 1 },
  origin: triggerKey(SRC, 'comment-1'),
  brief: 'fix the flaky test',
  openedAt: 1_000,
  closed: null,
  ...over,
})

const openStep = (over = {}) => ({
  caseId: 'case:1',
  seq: 1,
  state: 'running',
  brief: 'fix the flaky test',
  report: null,
  at: 1_100,
  ...over,
})

const report = (over = {}) => ({ state: 'ready', summary: 'ok', at: 2_000, ...over })

/** One Case's facts, with the steps and delivery failure spelled out. */
const facts = (over = {}) => ({
  theCase: theCase(),
  steps: [],
  deliveryFailedAt: undefined,
  ...over,
})

let checks = 0
const test = (name, run) => {
  try {
    run()
    checks += 1
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}
const eq = (actual, expected, note) => assert.deepEqual(actual, expected, note)

// ── 键：一个构造点 ───────────────────────────────────────────────
test('triggerKey: source 与事件 id 用冒号连接', () => {
  eq(triggerKey(SRC, 'comment-1'), `${SRC}:comment-1`)
})
test('threadKey: 同一格式，不同品牌', () => {
  eq(threadKey(OTHER, 'oc_room'), `${OTHER}:oc_room`)
})

// ── 闸门 ────────────────────────────────────────────────────────
test('human + direct + 在白名单 → 明确请求，真干', () => {
  eq(admit({ trigger: trigger(), policy: policy() }), { admitted: true, strength: 'explicit', effect: 'work' })
})
test('human + mention → 同上', () => {
  eq(admit({ trigger: trigger({ kind: 'mention' }), policy: policy() }), { admitted: true, strength: 'explicit', effect: 'work' })
})
test('human + ambient（没点名）→ not-addressed，哪怕在白名单', () => {
  eq(admit({ trigger: trigger({ kind: 'ambient' }), policy: policy() }), { admitted: false, reason: 'not-addressed' })
})
test('陌生人不点名也拒绝，且先于"有没有点名"判断', () => {
  eq(admit({ trigger: trigger({ kind: 'ambient', actor: human('mallory') }), policy: policy() }), { admitted: false, reason: 'sender-not-allowed' })
})
test('follow-up 先于白名单被拒：它属于已有 Case', () => {
  eq(admit({ trigger: trigger({ kind: 'follow-up' }), policy: policy() }), { admitted: false, reason: 'follow-up-owned' })
})
test('关掉的 source 先于身份判断', () => {
  eq(
    admit({ trigger: trigger(), policy: policy({ disabledSources: [SRC] }) }),
    { admitted: false, reason: 'source-disabled' },
  )
})
test('system（手动 / 定时）不需白名单', () => {
  eq(
    admit({ trigger: trigger({ kind: 'manual', actor: system() }), policy: policy({ allowed: [] }) }),
    { admitted: true, strength: 'explicit', effect: 'work' },
  )
})
test('bot 就算 @ 了 agent 也只是候选', () => {
  const p = policy({ bots: [{ source: SRC, id: 'ci-bot' }], allowed: [{ source: SRC, id: 'ci-bot' }], acceptMode: 'auto' })
  eq(admit({ trigger: trigger({ actor: bot('ci-bot') }), policy: p }), { admitted: true, strength: 'inferred', effect: 'work' })
})
test('不在 bot 名单的机器人：直接拒', () => {
  eq(admit({ trigger: trigger({ actor: bot('random') }), policy: policy() }), { admitted: false, reason: 'bot-not-allowed' })
})
test('候选 + acceptMode off → 拒绝', () => {
  const p = policy({ bots: [{ source: SRC, id: 'ci-bot' }] })
  eq(admit({ trigger: trigger({ actor: bot('ci-bot') }), policy: p }), { admitted: false, reason: 'inferred-mode-off' })
})
test('候选 + observe → 只记录，不真干', () => {
  const p = policy({ bots: [{ source: SRC, id: 'ci-bot' }], acceptMode: 'observe' })
  eq(admit({ trigger: trigger({ actor: bot('ci-bot') }), policy: p }), { admitted: true, strength: 'inferred', effect: 'record-only' })
})

// ── 状态派生（七行表，首行匹配）─────────────────────────────────
test('已关闭 → done，带原因与时间', () => {
  eq(
    deriveStage(facts({ theCase: theCase({ closed: { reason: 'completed', at: 5_000 } }), steps: [{ ...openStep(), report: report() }] })),
    { kind: 'done', how: 'completed', at: 5_000 },
  )
})
test('投递失败压过一切：人收不到结果就谈不上审核', () => {
  eq(
    deriveStage(facts({ steps: [{ ...openStep(), report: report() }], deliveryFailedAt: 4_000 })),
    { kind: 'needs-person', reason: 'delivery-failed', since: 4_000 },
  )
})
test('ready → 等人审核', () => {
  eq(deriveStage(facts({ steps: [{ ...openStep(), report: report() }] })), { kind: 'needs-person', reason: 'review', since: 2_000 })
})
test('blocked → 等人答问', () => {
  eq(
    deriveStage(facts({ steps: [{ ...openStep(), report: report({ state: 'blocked', question: 'which branch?' }) }] })),
    { kind: 'needs-person', reason: 'question', since: 2_000 },
  )
})
test('failed → 等人处置', () => {
  eq(
    deriveStage(facts({ steps: [{ ...openStep(), report: report({ state: 'failed', code: 'E_PREPARE' }) }] })),
    { kind: 'needs-person', reason: 'failed', since: 2_000 },
  )
})
test('有在跑的 step（还没报告）→ working', () => {
  eq(deriveStage(facts({ steps: [openStep()] })), { kind: 'working', since: 1_100 })
})
test('一步都没开 → queued', () => {
  eq(deriveStage(facts()), { kind: 'queued', since: 1_000 })
})
test('waiting → 等触发（没人要动手）', () => {
  eq(
    deriveStage(facts({ steps: [{ ...openStep(), report: report({ state: 'waiting' }) }] })),
    { kind: 'waiting', since: 2_000 },
  )
})
test('派工已 ended 且无新报告 → 也是等触发', () => {
  eq(
    deriveStage(facts({ steps: [{ ...openStep(), state: 'ended', endedAt: 3_000 }] })),
    { kind: 'waiting', since: 3_000 },
  )
})
test('progress → 还在干（progress 不是状态变化）', () => {
  eq(
    deriveStage(facts({ steps: [{ ...openStep(), report: report({ state: 'progress', at: 2_500 }) }] })),
    { kind: 'working', since: 2_500 },
  )
})

// ── 下一步 ──────────────────────────────────────────────────────
test('全新 Case → 派一次工，brief 由调用方给', () => {
  eq(
    planStep({ theCase: theCase(), steps: [], brief: 'fix the flaky test' }),
    { kind: 'work', brief: 'fix the flaky test' },
  )
})
test('已有 running step → idle，不给第二个工', () => {
  eq(
    planStep({ theCase: theCase(), steps: [openStep()], brief: 'again' }),
    { kind: 'idle' },
  )
})
test('ready → 收工 completed', () => {
  eq(
    planStep({ theCase: theCase(), steps: [{ ...openStep(), state: 'ended', report: report() }], brief: 'x' }),
    { kind: 'close', reason: 'completed' },
  )
})
test('dropped → 收工 dropped', () => {
  eq(
    planStep({ theCase: theCase(), steps: [{ ...openStep(), report: report({ state: 'dropped' }) }], brief: 'x' }),
    { kind: 'close', reason: 'dropped' },
  )
})
test('没有步数上限：第 41 个派工照样 work（参考实现也没有）', () => {
  const many = Array.from({ length: 41 }, (_, index) => ({
    ...openStep(),
    seq: index + 1,
    state: 'ended',
    endedAt: 3_000,
    report: report({ state: 'waiting' }),
  }))
  eq(planStep({ theCase: theCase(), steps: many, brief: 'x' }), { kind: 'work', brief: 'x' })
})
test('已关闭的 Case 再来问 → 仍答收工，且沿用原原因', () => {
  eq(
    planStep({ theCase: theCase({ closed: { reason: 'stopped', at: 9_000 } }), steps: [], brief: 'x' }),
    { kind: 'close', reason: 'stopped' },
  )
})

console.log(`ingress: ${checks} checks`)
