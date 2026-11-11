#!/usr/bin/env node
/**
 * The assignment lifecycle, against a fake TurnHost and the in-memory ledger.
 *
 * The composition suite (`oncall-loop.mjs`) proves the wiring; this one proves the
 * branches a real model cannot be asked to produce on demand: a restart that
 * orphaned an assignment, a turn that was cancelled, a chain that was spent on a
 * transient failure, a follow-up that must not be re-delivered, and the step
 * allowance. No DSH, no clock, no network.
 *
 * It also carries the module's own guard: `runtime/executor.ts` may not name a
 * provider, a model, GitHub or `fetch` (docs/design/oncall-v0-architecture.md §二之一
 * 禁止清单). The channel is the router's business; the lifecycle only sees turns.
 *
 * Usage: node packages/dsh-oncall/tests/executor.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { caseSessionId, Executor, followUpMessageId, titleOf } from '../src/runtime/executor.ts'
import { inputIdOf } from '../src/core/case-id.ts'
import { memoryLedger } from '../src/runtime/ledger.ts'
import { Outbox } from '../src/runtime/outbox.ts'
import { planReply, replyMarker } from '../src/core/reply-plan.ts'
import { MAX_STEPS_PER_CASE, RECOVERY_NOTE } from '../src/contract/defaults.ts'

const NOW = Date.parse('2026-11-12T09:00:00.000Z')
const SRC = 'github:acme/widgets#issues'
const THREAD = `${SRC}:issue-12`
const CASE = `case:${SRC}:comment-1`

let checks = 0
const test = async (name, run) => {
  try {
    await run()
    checks += 1
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}
const eq = (actual, expected, note) => assert.deepEqual(actual, expected, note)
/** Let the executor's queued microtasks and its settle loop run. */
const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const caseOf = (over = {}) => ({
  id: CASE,
  mandate: {
    strength: 'explicit',
    actor: { source: SRC, id: 'alice', handle: '@alice', kind: 'human' },
    scope: [THREAD],
    policyVersion: 1,
  },
  origin: `${SRC}:comment-1`,
  brief: '修一下 flaky 测试',
  openedAt: NOW,
  closed: null,
  ...over,
})

const stepOf = (over = {}) => ({
  caseId: CASE,
  seq: 1,
  state: 'running',
  brief: '修一下 flaky 测试',
  report: null,
  at: NOW,
  ...over,
})

/** A TurnHost whose every fact the test decides. */
function fakeHost() {
  const facts = new Map()
  const sessions = new Set()
  const delivered = new Map()
  const idleListeners = new Set()
  const state = {
    followups: [],
    created: [],
    renames: [],
    flushes: 0,
    waits: 0,
    verdictOf: () => undefined,
  }

  const host = {
    async resolveAgent(sessionId) { return sessions.has(sessionId) },
    async create({ sessionId, title }) {
      sessions.add(sessionId)
      state.created.push(sessionId)
      state.renames.push(title)
    },
    followup({ sessionId, messageId, text }) {
      state.followups.push({ sessionId, messageId, text })
      const seen = delivered.get(sessionId) ?? new Set()
      seen.add(messageId)
      delivered.set(sessionId, seen)
    },
    holds(sessionId, messageId) { return delivered.get(sessionId)?.has(messageId) ?? false },
    async whenIdle() { state.waits += 1 },
    log(sessionId) { return facts.get(sessionId) ?? [] },
    async flush() { state.flushes += 1 },
    onIdle(listener) {
      idleListeners.add(listener)
      return () => { idleListeners.delete(listener) }
    },
    exhausted(sessionId, turn, code) { return state.verdictOf(sessionId, turn, code) },
  }

  return {
    host,
    state,
    sessions,
    /** Append facts to one session's log, as a turn would. */
    say(sessionId, ...list) {
      facts.set(sessionId, [...(facts.get(sessionId) ?? []), ...list])
    },
    idle(sessionId) { for (const listener of idleListeners) listener(sessionId) },
  }
}

const repliesOf = () => {
  const queued = []
  return { queued, queue: input => queued.push(input) }
}

async function executorOf(ledger, host, options = {}) {
  const executor = new Executor({
    ledger,
    host: host.host,
    workdir: 'C:/work',
    now: () => NOW,
    logger: { warn() {}, error() {} },
    ...options,
  })
  return executor
}

// ── naming ──────────────────────────────────────────────────────
await test('会话 id 是 Case id 的纯函数：可读、路径安全、不撞', () => {
  const id = caseSessionId(CASE)
  eq(id, caseSessionId(CASE))
  eq(/^[a-zA-Z0-9_-]+$/.test(id), true, `not path-safe: ${id}`)
  eq(caseSessionId(`case:${SRC}:comment-2`) === id, false)
  // 两个只在标点上不同的 Case 不能落进同一个会话。
  eq(caseSessionId('case:github:a/b#issues:comment-1') === caseSessionId('case:github:a_b#issues:comment-1'), false)
})

await test('标题取 brief 第一行，超长有省略号', () => {
  eq(titleOf(caseOf()), '修一下 flaky 测试')
  eq(titleOf(caseOf({ brief: 'x'.repeat(120) })).endsWith('…'), true)
})

// ── startup scan ────────────────────────────────────────────────
await test('启动扫描：没有派工的 Case → 开 seq 1、起会话、投 Case brief', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [{ key: THREAD, subscriptions: [CASE], lastAt: NOW }],
    inputs: [],
    audit: [],
  })
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  eq(ledger.stepsOf(CASE).map(step => [step.seq, step.state, step.brief]), [[1, 'running', '修一下 flaky 测试']])
  eq(fake.state.created, [caseSessionId(CASE)])
  eq(fake.state.followups.map(call => [call.messageId, call.text]), [
    [`oncall:${CASE}#1`, '修一下 flaky 测试'],
  ])
  executor.stop()
})

await test('启动扫描：在等触发的 Case（running + 已结算）什么都不做', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  await ledger.writeSteps([stepOf({ report: { state: 'waiting', summary: '还没完', at: NOW } })])
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  eq(fake.state.followups, [])
  eq(fake.state.created, [])
  eq(ledger.stepsOf(CASE).length, 1)
  executor.stop()
})

await test('启动扫描：上一刀没有报告 → 结束旧派工、记 step.interrupted、新派工带 RECOVERY_NOTE', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  await ledger.writeSteps([stepOf()])
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  const steps = ledger.stepsOf(CASE)
  eq(steps.map(step => [step.seq, step.state]), [[1, 'ended'], [2, 'running']])
  eq(steps[0].report, null, '被重启打断的派工不冒领一个报告')
  eq(steps[1].brief.startsWith('修一下 flaky 测试'), true)
  eq(steps[1].brief.includes(RECOVERY_NOTE), true)
  eq(ledger.audit.filter(event => event.kind === 'step.interrupted'), [
    { kind: 'step.interrupted', at: NOW, caseId: CASE, seq: 1 },
  ])
  // 同一会话，不是第二个：续的是上一刀的对话。
  eq(fake.state.followups.map(call => [call.sessionId, call.messageId]), [[caseSessionId(CASE), `oncall:${CASE}#2`]])
  executor.stop()
})

await test('启动扫描：报告之后有消息送进会话 → 带 recovery note 重开（参考 assignments.ts:83-92）', async () => {
  const ledger = await openWithWaitingStep()
  await ledger.writeInputs([{
    id: inputIdOf(CASE, `${SRC}:comment-late`),
    caseId: CASE,
    trigger: `${SRC}:comment-late`,
    text: '报告之后才到的消息',
    at: NOW,
    deliveredAt: NOW + 1,
  }])
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  const steps = ledger.stepsOf(CASE)
  eq(steps.map(step => [step.seq, step.state]), [[1, 'ended'], [2, 'running']])
  eq(steps[1].brief.includes(RECOVERY_NOTE), true, '被打断的不是"在等触发"，而是"有消息没处理完"')
  eq(ledger.audit.filter(event => event.kind === 'step.interrupted').length, 1)
  executor.stop()
})

await test('启动扫描不碰已关闭的 Case', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf({ closed: { reason: 'completed', at: NOW } })],
    threads: [],
    inputs: [],
    audit: [],
  })
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  eq(fake.state.followups, [])
  eq(ledger.stepsOf(CASE), [])
  executor.stop()
})

// ── settle ──────────────────────────────────────────────────────
async function openWithWaitingStep() {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  await ledger.writeSteps([stepOf({ report: { state: 'waiting', summary: '先看看', at: NOW } })])
  return ledger
}

await test('回合正常结束且没有报告 → waiting（不冒充完成），Case 留开', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()
  executor.deliver({ caseId: CASE, text: '再补一个测试', trigger: `${SRC}:comment-2` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'assistant', turn: 2, text: '  补好了  ' }, { kind: 'turn-end', turn: 2, reason: { kind: 'completed' } })
  fake.idle(sessionId)
  await settle()

  const [step] = ledger.stepsOf(CASE)
  eq(step.report, { state: 'waiting', summary: '补好了', at: NOW })
  eq(ledger.cases[0].closed, null, '模型没说 done，Case 不关')
  eq(ledger.audit.filter(event => event.kind === 'step.settled').map(event => [event.seq, event.state]), [[1, 'waiting']])
  executor.stop()
})

await test('回合被打断（interrupted）→ 不结算', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-3` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'interrupted' } })
  fake.idle(sessionId)
  await settle()

  eq(ledger.stepsOf(CASE)[0].report, { state: 'waiting', summary: '先看看', at: NOW }, '旧报告没被改写')
  eq(ledger.audit.filter(event => event.kind === 'step.settled').length, 0)
  executor.stop()
})

await test('回合失败但没有层 A 的结论 → failed 报告，不开新派工', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-4` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'error', code: 'SERVER', message: '502' } })
  fake.idle(sessionId)
  await settle()

  eq(ledger.stepsOf(CASE)[0].report, { state: 'failed', summary: '502', code: 'SERVER', at: NOW })
  eq(ledger.stepsOf(CASE).length, 1, '不是层 A 耗尽就不代它重试')
  eq(ledger.cases[0].closed, null)
  executor.stop()
})

await test('层 A 耗尽 + 终态码（auth）→ failed 报告，不排队', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  fake.state.verdictOf = () => 'terminal'
  const executor = await executorOf(ledger, fake)
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-5` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'error', code: 'AUTH', message: 'bad key' } })
  fake.idle(sessionId)
  await settle()

  eq(ledger.stepsOf(CASE).length, 1)
  eq(ledger.stepsOf(CASE)[0].report.code, 'AUTH')
  executor.stop()
})

await test('回合失败（没有层 A 结论）→ 发 failed 回执', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const replier = repliesOf()
  const executor = await executorOf(ledger, fake, { replier })
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-a` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'error', code: 'SERVER', message: '502' } })
  fake.idle(sessionId)
  await settle()

  eq(replier.queued.map(item => item.intent), ['failed'])
  eq(replier.queued[0].text.includes('SERVER'), true)
  executor.stop()
})

await test('瞬态失败 → 同一派工再投一句继续（不写报告、不开新 step、不发卡住了）', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  fake.state.verdictOf = () => 'transient'
  const replier = repliesOf()
  const executor = await executorOf(ledger, fake, { retryBaseMs: 0, replier })
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-r1` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'error', code: 'RATE_LIMIT', message: '429' } })
  fake.idle(sessionId)
  await settle(10)

  eq(ledger.stepsOf(CASE).map(step => step.seq), [1], '不开新派工：参考实现是在同一个派工上再发一句')
  eq(ledger.stepsOf(CASE)[0].report, { state: 'waiting', summary: '先看看', at: NOW }, '瞬态失败不是报告')
  eq(fake.state.followups.at(-1).messageId, `oncall:${CASE}:retry:2`, '重试消息按失败的那一轮命名')
  eq(fake.state.followups.at(-1).text.includes('可恢复'), true)
  eq(replier.queued, [], '还不该说"卡住了"')
  executor.stop()
})

await test('瞬态重试用尽（三次）才写 failed 报告并发回执', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  fake.state.verdictOf = () => 'transient'
  const replier = repliesOf()
  const executor = await executorOf(ledger, fake, { retryBaseMs: 0, replier })
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-r2` })
  await settle()

  const sessionId = caseSessionId(CASE)
  for (const turn of [2, 3, 4, 5]) {
    fake.say(sessionId, { kind: 'turn-end', turn, reason: { kind: 'error', code: 'SERVER', message: '502' } })
    fake.idle(sessionId)
    await settle(10)
  }

  const retries = fake.state.followups.filter(call => call.messageId.includes(':retry:'))
  eq(retries.map(call => call.messageId), [2, 3, 4].map(turn => `oncall:${CASE}:retry:${turn}`))
  eq(ledger.stepsOf(CASE).map(step => step.seq), [1], '重试都在同一个派工上')
  eq(ledger.stepsOf(CASE)[0].report.state, 'failed')
  eq(replier.queued.map(item => item.intent), ['failed'], '用尽后才发"卡住了"')
  executor.stop()
})

await test('正常回合结束会重置瞬态计数（参考 dsh.ts:606）', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  fake.state.verdictOf = () => 'transient'
  const executor = await executorOf(ledger, fake, { retryBaseMs: 0 })
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-r3` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'error', code: 'SERVER', message: '502' } })
  fake.idle(sessionId)
  await settle(10)
  // 一次正常收尾（无报告）之后，计数归零：下一轮失败仍是"第 1 次重试"，但消息 id 按轮次区分。
  fake.say(sessionId, { kind: 'assistant', turn: 3, text: '好一点了' }, { kind: 'turn-end', turn: 3, reason: { kind: 'completed' } })
  fake.idle(sessionId)
  await settle(10)
  fake.say(sessionId, { kind: 'turn-end', turn: 4, reason: { kind: 'error', code: 'SERVER', message: '502' } })
  fake.idle(sessionId)
  await settle(10)

  const retries = fake.state.followups.filter(call => call.messageId.includes(':retry:')).map(call => call.messageId)
  eq(retries, [`oncall:${CASE}:retry:2`, `oncall:${CASE}:retry:4`])
  executor.stop()
})

await test('waiting 没带新的话时保留上一条 summary（参考 dsh.ts:666 said || before）', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-r4` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'turn-end', turn: 2, reason: { kind: 'completed' } })
  fake.idle(sessionId)
  await settle()

  eq(ledger.stepsOf(CASE)[0].report, { state: 'waiting', summary: '先看看', at: NOW })
  executor.stop()
})

// ── follow-ups ──────────────────────────────────────────────────
await test('追问投进同一个活着的派工：消息 id 带 trigger，不新开 step', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  executor.deliver({ caseId: CASE, text: '还有一个地方', trigger: `${SRC}:comment-7` })
  await settle()

  eq(ledger.stepsOf(CASE).map(step => step.seq), [1])
  eq(fake.state.followups.map(call => call.messageId), [`oncall:${CASE}:${SRC}:comment-7`])
  eq(fake.state.followups[0].text, '还有一个地方')
  executor.stop()
})

await test('投出去之后把 input 行标成已投递（崩溃窗口的另一半）', async () => {
  const ledger = await openWithWaitingStep()
  const trigger = `${SRC}:comment-input`
  await ledger.writeInputs([{
    id: inputIdOf(CASE, trigger),
    caseId: CASE,
    trigger,
    text: '还有一个地方',
    at: NOW,
    deliveredAt: null,
  }])
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  executor.deliver({ caseId: CASE, text: '还有一个地方', trigger })
  await settle()

  eq(ledger.inputOf(inputIdOf(CASE, trigger)).deliveredAt, NOW)
  eq(fake.state.followups.length, 1)
  executor.stop()
})

await test('同一条追问重放（消息 id 已在会话里）→ 不重复投递', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  executor.deliver({ caseId: CASE, text: '还有一个地方', trigger: `${SRC}:comment-7` })
  executor.deliver({ caseId: CASE, text: '还有一个地方', trigger: `${SRC}:comment-7` })
  await settle()

  eq(fake.state.followups.length, 1)
  executor.stop()
})

await test('已完成的 Case 被追问 → 重开 + 新派工，brief 是这一次的话', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf({ closed: { reason: 'completed', at: NOW } })],
    threads: [],
    inputs: [],
    audit: [],
  })
  await ledger.writeSteps([stepOf({ state: 'ended', report: { state: 'ready', summary: '做完了', at: NOW }, endedAt: NOW })])
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  executor.deliver({ caseId: CASE, text: '再补个回归', trigger: `${SRC}:comment-8` })
  await settle()

  eq(ledger.cases[0].closed, null, '恢复就是重开')
  eq(ledger.stepsOf(CASE).map(step => [step.seq, step.state]), [[1, 'ended'], [2, 'running']])
  eq(ledger.stepsOf(CASE)[1].brief, '再补个回归')
  eq(fake.state.followups.map(call => call.messageId), [`oncall:${CASE}:${SRC}:comment-8`], '续的是同一个会话')
  eq(fake.state.created.length, 1)
  executor.stop()
})

await test('步数用尽 → 关 stopped，不再派工也不再投递', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  const spent = Array.from({ length: MAX_STEPS_PER_CASE }, (_, index) => stepOf({
    seq: index + 1,
    state: 'ended',
    report: { state: 'waiting', summary: '继续', at: NOW },
    endedAt: NOW,
  }))
  await ledger.writeSteps(spent)
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  executor.deliver({ caseId: CASE, text: '再做一点', trigger: `${SRC}:comment-9` })
  await settle()

  eq(ledger.cases[0].closed, { reason: 'stopped', at: NOW })
  eq(fake.state.followups, [])
  executor.stop()
})

// ── oncall_report ──────────────────────────────────────────────
await test('oncall_report{ready} → 写报告、关 completed、回执 result', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const replier = repliesOf()
  const executor = await executorOf(ledger, fake, { replier })
  await executor.start()

  const verdict = await executor.submitReport({
    sessionId: caseSessionId(CASE),
    report: { state: 'ready', summary: '修好了，回归也加了' },
  })

  eq(verdict, { ok: true, seq: 1 })
  const [step] = ledger.stepsOf(CASE)
  eq(step.report, { state: 'ready', summary: '修好了，回归也加了', at: NOW })
  eq(step.state, 'ended')
  eq(ledger.cases[0].closed, { reason: 'completed', at: NOW })
  eq(replier.queued.map(item => item.intent), ['result'])
  eq(replier.queued[0].text.includes('修好了，回归也加了'), true)
  eq(replier.queued[0].thread, THREAD)
  executor.stop()
})

await test('oncall_report{blocked} → Case 留开、回执 attention；dropped → 关 dropped', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const replier = repliesOf()
  const executor = await executorOf(ledger, fake, { replier })
  await executor.start()

  await executor.submitReport({
    sessionId: caseSessionId(CASE),
    report: { state: 'blocked', summary: '卡在选型', question: '用 A 还是 B？' },
  })
  eq(ledger.cases[0].closed, null)
  eq(replier.queued.map(item => item.intent), ['attention'])

  await executor.submitReport({ sessionId: caseSessionId(CASE), report: { state: 'dropped', summary: '不做了' } })
  eq(ledger.cases[0].closed.reason, 'dropped')
  eq(replier.queued.map(item => item.intent), ['attention', 'result'])
  executor.stop()
})

await test('oncall_report 拒绝陌生会话、已关闭的 Case、没有运行中的派工', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()

  const stranger = await executor.submitReport({ sessionId: 'someone-else', report: { state: 'ready', summary: 'x' } })
  eq(stranger.ok, false)
  eq(stranger.reason.includes('not working an on-call Case'), true)

  await executor.submitReport({ sessionId: caseSessionId(CASE), report: { state: 'ready', summary: 'x' } })
  const again = await executor.submitReport({ sessionId: caseSessionId(CASE), report: { state: 'progress', summary: 'y' } })
  eq(again.ok, false)
  eq(again.reason.includes('already ended'), true)

  const empty = memoryLedger()
  await empty.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  const noStep = await executorOf(empty, fakeHost())
  const verdict = await noStep.submitReport({ sessionId: caseSessionId(CASE), report: { state: 'ready', summary: 'x' } })
  eq(verdict.ok, false)
  eq(verdict.reason.includes('no assignment is running'), true)
  executor.stop()
  noStep.stop()
})

// ── 回执：计划与投递 ────────────────────────────────────────────
await test('reply-plan：ready/dropped → result，blocked → attention，failed → failed，progress/waiting 不发', () => {
  const marker = replyMarker(CASE, 3)
  eq(marker, `<!-- oncall:${CASE}#3 -->`)

  const ready = planReply({ caseId: CASE, seq: 3, report: { state: 'ready', summary: '修好了' } })
  eq(ready?.intent, 'result')
  eq(ready.text.includes('## 完成了'), true)
  eq(ready.text.includes('修好了'), true)
  eq(ready.text.endsWith(marker), true)

  const dropped = planReply({ caseId: CASE, seq: 3, report: { state: 'dropped', summary: '不做了' } })
  eq(dropped?.intent, 'result')
  eq(dropped.text.includes('## 已放弃'), true)

  const blocked = planReply({ caseId: CASE, seq: 3, report: { state: 'blocked', summary: '卡在选型', question: '用 A 还是 B？' } })
  eq(blocked?.intent, 'attention')
  eq(blocked.text.includes('用 A 还是 B？'), true)

  const failed = planReply({ caseId: CASE, seq: 3, report: { state: 'failed', summary: '网关挂了', code: 'SERVER' } })
  eq(failed?.intent, 'failed')
  eq(failed.text.includes('SERVER'), true)

  // worker 自己说"做不到"时没有渠道码可查，别硬编一行"原因代码"。
  const reported = planReply({ caseId: CASE, seq: 3, report: { state: 'failed', summary: '做不了', code: 'REPORTED' } })
  eq(reported?.intent, 'failed')
  eq(reported.text.includes('原因代码'), false)

  eq(planReply({ caseId: CASE, seq: 3, report: { state: 'progress', summary: '一半' } }), undefined)
  eq(planReply({ caseId: CASE, seq: 3, report: { state: 'waiting', summary: '还没说' } }), undefined)
})

const outboxOf = async (sender, over = {}) => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  const errors = []
  const outbox = new Outbox({
    ledger,
    sender,
    now: () => NOW,
    logger: { warn() {}, error: message => errors.push(message) },
    delaysMs: [0, 0],
    ...over,
  })
  return { ledger, outbox, errors }
}
const receipt = (over = {}) => ({ caseId: CASE, seq: 1, thread: THREAD, intent: 'result', text: '## 完成了', ...over })

await test('outbox：一条回执只发一次，重放不重发', async () => {
  const sent = []
  const { ledger, outbox } = await outboxOf({ async send(request) { sent.push(request); return 'sent' } })

  outbox.queue(receipt())
  outbox.queue(receipt())
  await outbox.settled()
  outbox.queue(receipt())
  await outbox.settled()

  eq(sent.length, 1)
  eq(sent[0].thread, THREAD)
  eq(ledger.replyOf(CASE, 1).state, 'sent')
  eq(ledger.audit.filter(event => event.kind === 'reply.settled').map(event => [event.intent, event.state]), [['result', 'sent']])
})

await test('outbox：回执行先写 pending 再发（崩在中间也有据可查）', async () => {
  let stateAtSend
  const { ledger, outbox } = await outboxOf({
    async send() {
      stateAtSend = ledger.replyOf(CASE, 1).state
      return 'sent'
    },
  })

  outbox.queue(receipt())
  await outbox.settled()

  eq(stateAtSend, 'pending')
  eq(ledger.replyOf(CASE, 1).state, 'sent')
})

await test('outbox：同一个 Case 的回执按顺序发，后一条不超车', async () => {
  const order = []
  const { outbox } = await outboxOf({
    async send(request) {
      // 按"贴上 issue 的顺序"记：第一条故意慢，第二条若超车就会先落。
      if (request.text === '## 一') await new Promise(resolve => setTimeout(resolve, 20))
      order.push(request.text)
      return 'sent'
    },
  })

  outbox.queue(receipt({ seq: 1, text: '## 一' }))
  outbox.queue(receipt({ seq: 2, text: '## 二' }))
  await outbox.settled()

  eq(order, ['## 一', '## 二'])
})

await test('outbox：gone（issue 没了）不再试，直接结账', async () => {
  const calls = []
  const { ledger, outbox } = await outboxOf({ async send() { calls.push(1); return 'gone' } })

  outbox.queue(receipt())
  await outbox.settled()

  eq(calls.length, 1)
  eq(ledger.replyOf(CASE, 1).state, 'gone')
  eq(ledger.audit.filter(event => event.kind === 'reply.settled')[0].state, 'gone')
})

await test('outbox：传输失败按次数重试，用尽后记 failed；成功一次就停', async () => {
  let attempts = 0
  const flaky = await outboxOf({
    async send() {
      attempts += 1
      if (attempts < 3) throw new Error('502')
      return 'sent'
    },
  })
  flaky.outbox.queue(receipt())
  await flaky.outbox.settled()
  eq([attempts, flaky.ledger.replyOf(CASE, 1).state], [3, 'sent'])

  const dead = await outboxOf({ async send() { throw new Error('502') } }, { attempts: 2 })
  dead.outbox.queue(receipt())
  await dead.outbox.settled()
  eq(dead.ledger.replyOf(CASE, 1).state, 'failed')
  eq(dead.errors.length, 1, '失败要说话，不吞掉')
})

await test('outbox：重启后只补 pending，sent/gone/failed 不再动', async () => {
  const sent = []
  const { ledger, outbox } = await outboxOf({ async send(request) { sent.push(request.text); return 'sent' } })
  await ledger.writeReply({ caseId: CASE, seq: 1, intent: 'result', text: '旧的', state: 'pending', at: NOW })
  await ledger.writeReply({ caseId: CASE, seq: 2, intent: 'result', text: '发过了', state: 'sent', at: NOW })
  await ledger.writeReply({ caseId: CASE, seq: 3, intent: 'failed', text: '没了', state: 'gone', at: NOW })

  outbox.resume()
  await outbox.settled()

  eq(sent, ['旧的'])
  eq([1, 2, 3].map(seq => ledger.replyOf(CASE, seq).state), ['sent', 'sent', 'gone'])
})

await test('第 40 个派工上报 blocked：Case 留开，不被预算关成 stopped', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  const spent = Array.from({ length: MAX_STEPS_PER_CASE - 1 }, (_, index) => stepOf({
    seq: index + 1,
    state: 'ended',
    report: { state: 'waiting', summary: '继续', at: NOW },
    endedAt: NOW,
  }))
  await ledger.writeSteps([...spent, stepOf({ seq: MAX_STEPS_PER_CASE })])
  const executor = await executorOf(ledger, fakeHost())

  const verdict = await executor.submitReport({
    sessionId: caseSessionId(CASE),
    report: { state: 'blocked', summary: '卡住了', question: '继续吗？' },
  })

  eq(verdict.ok, true)
  eq(ledger.cases[0].closed, null, '一句 blocked 不该触发"预算用尽"')
  eq(ledger.stepsOf(CASE).at(-1).report.state, 'blocked')
  executor.stop()
})

await test('第 40 个派工上报 ready：仍然关 completed（ready 先于预算判）', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  const spent = Array.from({ length: MAX_STEPS_PER_CASE - 1 }, (_, index) => stepOf({
    seq: index + 1,
    state: 'ended',
    report: { state: 'waiting', summary: '继续', at: NOW },
    endedAt: NOW,
  }))
  await ledger.writeSteps([...spent, stepOf({ seq: MAX_STEPS_PER_CASE })])
  const executor = await executorOf(ledger, fakeHost())

  await executor.submitReport({ sessionId: caseSessionId(CASE), report: { state: 'ready', summary: '做完了' } })

  eq(ledger.cases[0].closed.reason, 'completed')
  executor.stop()
})

await test('消息已在会话里（重读）→ 输入行也要盖 deliveredAt', async () => {
  const ledger = await openWithWaitingStep()
  const trigger = `${SRC}:comment-dup`
  await ledger.writeInputs([{
    id: inputIdOf(CASE, trigger),
    caseId: CASE,
    trigger,
    text: '重复的一句',
    at: NOW,
    deliveredAt: null,
  }])
  const fake = fakeHost()
  const sessionId = caseSessionId(CASE)
  await fake.host.create({ sessionId, cwd: '', title: '' })
  fake.host.followup({ sessionId, messageId: followUpMessageId(CASE, trigger), text: '重复的一句' })
  fake.state.followups.length = 0
  const executor = await executorOf(ledger, fake)
  await executor.start()

  executor.deliver({ caseId: CASE, text: '重复的一句', trigger })
  await settle()

  eq(fake.state.followups, [], '消息已在会话里，不重投')
  eq(ledger.inputOf(inputIdOf(CASE, trigger)).deliveredAt, NOW, '但输入行必须盖上，否则每轮都重投一次 no-op')
  executor.stop()
})

await test('结算写失败不会吞掉这一轮：下一次 idle 会重试', async () => {
  const base = await openWithWaitingStep()
  let failures = 1
  const ledger = {
    ...base,
    writeSteps: async (records, audit) => {
      if (failures > 0) { failures -= 1; throw new Error('disk full') }
      return base.writeSteps(records, audit)
    },
  }
  const fake = fakeHost()
  const executor = await executorOf(ledger, fake)
  await executor.start()
  executor.deliver({ caseId: CASE, text: '再补一个测试', trigger: `${SRC}:comment-write` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, { kind: 'assistant', turn: 2, text: '补好了' }, { kind: 'turn-end', turn: 2, reason: { kind: 'completed' } })
  fake.idle(sessionId)
  await settle()
  eq(base.stepsOf(CASE)[0].report.summary, '先看看', '这次写失败，报告没落地')

  fake.idle(sessionId)
  await settle()
  eq(base.stepsOf(CASE)[0].report.summary, '补好了', '重试之后落地')
  executor.stop()
})

await test('outbox：落 pending 失败把回执还回去，之后 queue 还能补', async () => {
  const base = memoryLedger()
  await base.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
    inputs: [],
    audit: [],
  })
  let breaking = true
  const ledger = {
    ...base,
    writeReply: async (record, audit) => {
      if (breaking && record.state === 'pending') throw new Error('disk full')
      return base.writeReply(record, audit)
    },
  }
  const sent = []
  const errors = []
  const outbox = new Outbox({
    ledger,
    sender: { async send() { sent.push(1); return 'sent' } },
    now: () => NOW,
    logger: { warn() {}, error: message => errors.push(message) },
    delaysMs: [0],
  })

  outbox.queue(receipt())
  await outbox.settled()

  eq(sent, [], 'pending 没落就不发')
  eq(base.replyOf(CASE, 1), undefined, '账本里也没有行')
  eq(errors.length, 1)

  outbox.resume()
  await outbox.settled()
  eq(sent, [], 'resume 只补 pending 行，这里没有行可补')

  breaking = false
  outbox.queue(receipt())
  await outbox.settled()

  eq(sent, [1], '回执被还回来了，重新排队就能补上')
  eq(base.replyOf(CASE, 1).state, 'sent')
})

// ── 禁止清单 ────────────────────────────────────────────────────
await test('executor 里不出现 provider / model / github / fetch', () => {
  const text = readFileSync(new URL('../src/runtime/executor.ts', import.meta.url), 'utf8')
  // 只查代码，不查注释：注释里解释"为什么 executor 不该知道 provider"是必要的。
  const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
  const banned = ['provider', 'model', 'github', 'fetch']
  eq(banned.filter(word => new RegExp(word, 'i').test(code)), [])
})

console.log(`executor: ${checks} checks`)
