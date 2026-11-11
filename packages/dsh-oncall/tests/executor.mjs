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

import { caseSessionId, Executor, titleOf } from '../src/runtime/executor.ts'
import { memoryLedger } from '../src/runtime/ledger.ts'
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

await test('启动扫描不碰已关闭的 Case', async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf({ closed: { reason: 'completed', at: NOW } })],
    threads: [],
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
const openWithWaitingStep = async () => {
  const ledger = memoryLedger()
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: null, lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [],
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

await test('层 A 耗尽 + 瞬态码 → 开了新派工（层 B），退避优先用渠道自己给的 retryAfterMs', async () => {
  const ledger = await openWithWaitingStep()
  const fake = fakeHost()
  const verdicts = []
  fake.state.verdictOf = (sessionId, turn, code) => {
    verdicts.push([turn, code])
    return 'transient'
  }
  const executor = await executorOf(ledger, fake, { layerBDelaysMs: [60_000] })
  await executor.start()
  executor.deliver({ caseId: CASE, text: '继续', trigger: `${SRC}:comment-6` })
  await settle()

  const sessionId = caseSessionId(CASE)
  fake.say(sessionId, {
    kind: 'turn-end',
    turn: 2,
    reason: { kind: 'error', code: 'RATE_LIMIT', message: '429', retryAfterMs: 1 },
  })
  fake.idle(sessionId)
  await settle()

  eq(verdicts, [[2, 'RATE_LIMIT']])
  eq(ledger.stepsOf(CASE)[0].report.code, 'RATE_LIMIT')
  // 层 B 的等待用的是渠道自己给的时间（1ms），不是 60s 的常数。
  await settle(10)
  eq(ledger.stepsOf(CASE).map(step => step.seq), [1, 2])
  eq(ledger.stepsOf(CASE)[1].brief, '修一下 flaky 测试')
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
  eq(fake.state.followups.map(call => call.messageId), [`oncall:${CASE}#1:${SRC}:comment-7`])
  eq(fake.state.followups[0].text, '还有一个地方')
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
  eq(fake.state.followups.map(call => call.messageId), [`oncall:${CASE}#2:${SRC}:comment-8`], '续的是同一个会话')
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

// ── 禁止清单 ────────────────────────────────────────────────────
await test('executor 里不出现 provider / model / github / fetch', () => {
  const text = readFileSync(new URL('../src/runtime/executor.ts', import.meta.url), 'utf8')
  // 只查代码，不查注释：注释里解释"为什么 executor 不该知道 provider"是必要的。
  const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
  const banned = ['provider', 'model', 'github', 'fetch']
  eq(banned.filter(word => new RegExp(word, 'i').test(code)), [])
})

console.log(`executor: ${checks} checks`)
