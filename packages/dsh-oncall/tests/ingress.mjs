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
  seq: 1,
  step: { kind: 'work', brief: 'fix the flaky test', preset: 'worker' },
  startedAt: 1_100,
  outcome: undefined,
  ...over,
})

const settled = outcome => ({ theCase: theCase(), lastOutcome: outcome, settledAt: 2_000, openStep: undefined, deliveryFailedAt: undefined })

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

// ── 状态派生 ────────────────────────────────────────────────────
test('已关闭 → done，带原因与时间', () => {
  eq(
    deriveStage({ ...settled({ kind: 'done', summary: 'ok' }), theCase: theCase({ closed: { reason: 'completed', at: 5_000 } }) }),
    { kind: 'done', how: 'completed', at: 5_000 },
  )
})
test('投递失败压过一切：人收不到结果就谈不上审核', () => {
  eq(
    deriveStage({ ...settled({ kind: 'done', summary: 'ok' }), openStep: openStep(), deliveryFailedAt: 4_000 }),
    { kind: 'needs-person', reason: 'delivery-failed', since: 4_000 },
  )
})
test('有在跑的 step → working', () => {
  eq(deriveStage({ ...settled(undefined), openStep: openStep() }), { kind: 'working', since: 1_100 })
})
test('一步都没结算 → queued', () => {
  eq(deriveStage(settled(undefined)), { kind: 'queued', since: 1_000 })
})
test('done → 等人审核', () => {
  eq(deriveStage(settled({ kind: 'done', summary: 'ok' })), { kind: 'needs-person', reason: 'review', since: 2_000 })
})
test('waiting → 等触发', () => {
  eq(deriveStage(settled({ kind: 'waiting', summary: 'idle' })), { kind: 'waiting', since: 2_000 })
})
test('blocked → 等人答问', () => {
  eq(deriveStage(settled({ kind: 'blocked', question: 'which branch?' })), { kind: 'needs-person', reason: 'question', since: 2_000 })
})
test('failed → 等人处置', () => {
  eq(deriveStage(settled({ kind: 'failed', code: 'E_PREPARE', message: 'no dir' })), { kind: 'needs-person', reason: 'failed', since: 2_000 })
})

// ── 下一步 ──────────────────────────────────────────────────────
test('全新 Case → 派一次工，brief 来自 Case 本身', () => {
  eq(
    planStep({ theCase: theCase(), lastOutcome: undefined, budget: { stepsSpent: 0, maxSteps: 40 }, preset: 'worker' }),
    { kind: 'work', brief: 'fix the flaky test', preset: 'worker' },
  )
})
test('一次 done → 收工', () => {
  eq(
    planStep({ theCase: theCase(), lastOutcome: { kind: 'done', summary: 'ok' }, budget: { stepsSpent: 1, maxSteps: 40 }, preset: 'worker' }),
    { kind: 'close', reason: 'completed' },
  )
})
test('步数耗尽 → 强制收工，理由 stopped', () => {
  eq(
    planStep({ theCase: theCase(), lastOutcome: undefined, budget: { stepsSpent: 40, maxSteps: 40 }, preset: 'worker' }),
    { kind: 'close', reason: 'stopped' },
  )
})
test('已关闭的 Case 再来问 → 仍答收工，且沿用原原因', () => {
  eq(
    planStep({
      theCase: theCase({ closed: { reason: 'stopped', at: 9_000 } }),
      lastOutcome: undefined,
      budget: { stepsSpent: 0, maxSteps: 40 },
      preset: 'worker',
    }),
    { kind: 'close', reason: 'stopped' },
  )
})

console.log(`ingress: ${checks} checks`)
