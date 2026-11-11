#!/usr/bin/env node
/**
 * Tests for one pass: read → judge → open → record.
 *
 * The point of this suite is the failure modes a reviewer cannot see by reading a
 * happy path: a poll that throws, a poll that reports one event twice, a Case that
 * already exists, and an `observe` decision that must leave no Case behind.
 *
 * Everything runs against the in-memory ledger and a hand-built Source — no Cordis,
 * no network, no clock.
 *
 * Usage: node packages/dsh-oncall/tests/pass.mjs
 */

import assert from 'node:assert/strict'

import { briefOf } from '../src/core/brief.ts'
import { caseIdOf } from '../src/core/case-id.ts'
import { MAX_BRIEF_CHARS } from '../src/contract/defaults.ts'
import { memoryLedger } from '../src/runtime/ledger.ts'
import { runPass } from '../src/runtime/pass.ts'

const SRC = 'github:acme/widgets#issues'
const NOW = Date.parse('2026-11-09T12:00:00.000Z')

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

const human = (id) => ({ source: SRC, id, handle: `@${id}`, kind: 'human' })
const bot = (id) => ({ source: SRC, id, handle: `${id}[bot]`, kind: 'bot' })

const trigger = (over = {}) => ({
  key: `${SRC}:comment-1`,
  source: SRC,
  thread: `${SRC}:issue-12`,
  kind: 'direct',
  actor: human('alice'),
  text: 'please fix the flaky test',
  at: NOW - 60_000,
  ...over,
})

const policy = (over = {}) => ({
  version: 3,
  acceptMode: 'off',
  allowed: [{ source: SRC, id: 'alice' }],
  bots: [],
  disabledSources: [],
  ...over,
})

/** A Source whose poll result (or throw) the test decides. */
function sourceOf(next, id = SRC) {
  return {
    id,
    label: 'test source',
    calls: [],
    async poll(input) {
      this.calls.push(input)
      const value = typeof next === 'function' ? next(input) : next
      if (value instanceof Error) throw value
      return value
    },
  }
}

const run = ({ sources, ledger = memoryLedger(), policy: p = policy(), now = NOW, executor }) =>
  runPass({ sources, ledger, policy: p, now, signal: new AbortController().signal, executor })

/** Records what the pass handed to the executor; the pass must never await one. */
const executorOf = () => {
  const calls = []
  return { calls, deliver: input => calls.push(input) }
}

// ── 正常一轮 ────────────────────────────────────────────────────
await test('被授权的 @ → 开一个 Case，带 Mandate 与 origin', async () => {
  const ledger = memoryLedger()
  const report = await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })

  eq(report.sources[0], { sourceId: SRC, opened: 1, observed: 0, refused: 0, delivered: 0, skipped: 0, error: null })
  eq(ledger.cases.length, 1)

  const [record] = ledger.cases
  eq(record.id, caseIdOf(trigger().key))
  eq(record.origin, trigger().key)
  eq(record.brief, 'please fix the flaky test')
  eq(record.openedAt, NOW)
  eq(record.closed, null)
  eq(record.mandate, { strength: 'explicit', actor: human('alice'), scope: [trigger().thread], policyVersion: 3 })
  eq(ledger.progressOf(SRC), { cursor: 'c1', lastError: null, lastPolledAt: NOW })
})

await test('一次提交同时落 Case、游标与审计：三者要么都在，要么都不在', async () => {
  const ledger = memoryLedger()
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })

  eq(ledger.audit.length, 1)
  eq(ledger.audit[0].kind, 'case.opened')
  eq(ledger.progressOf(SRC).cursor, 'c1')
  eq(ledger.cases.length, 1)
})

// ── 归属与扇出 ────────────────────────────────────────────────
await test('开 Case 时同一笔提交写下 thread 订阅：谁归这个 Case 是表里的事实', async () => {
  const ledger = memoryLedger()
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })

  eq(ledger.threads, [{ key: trigger().thread, subscriptions: [caseIdOf(trigger().key)], lastAt: NOW }])
})

await test('同 thread 第二条评论不开新 Case：投给已有 Case，审计 case.followed-up', async () => {
  const ledger = memoryLedger()
  const executor = executorOf()
  const second = trigger({ key: `${SRC}:comment-2`, text: '  还有一处 flaky  ' })
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger, executor })
  executor.calls.length = 0
  const report = await run({
    sources: [sourceOf({ triggers: [trigger(), second], cursor: 'c1' })],
    ledger,
    executor,
    now: NOW + 15_000,
  })

  eq(report.sources[0], { sourceId: SRC, opened: 0, observed: 0, refused: 0, delivered: 1, skipped: 1, error: null })
  eq(ledger.cases.length, 1, '一个 thread 上的第二条评论不建第二个 Case')
  eq(executor.calls, [{ caseId: caseIdOf(trigger().key), text: '还有一处 flaky', trigger: second.key }])
  eq(ledger.audit.filter(event => event.kind === 'case.followed-up'), [
    { kind: 'case.followed-up', at: NOW + 15_000, caseId: caseIdOf(trigger().key), trigger: second.key },
  ])
  eq(ledger.threads[0].subscriptions, [caseIdOf(trigger().key)], '订阅只增不减，也不会因为追问多出一条')
  eq(ledger.threads[0].lastAt, NOW + 15_000, '追问把 lastAt 推到最近一次看到它的时候')
})

await test('人停掉的不复活：不往 stopped 的 Case 投递，新要求按新 Case 开', async () => {
  const ledger = memoryLedger()
  const executor = executorOf()
  const first = caseIdOf(trigger().key)
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })
  await ledger.closeCase(first, 'stopped', NOW + 1_000)

  const next = trigger({ key: `${SRC}:comment-3`, text: '那换个做法，做 Y' })
  const report = await run({ sources: [sourceOf({ triggers: [next], cursor: 'c2' })], ledger, executor, now: NOW + 20_000 })

  eq(report.sources[0].opened, 1)
  eq(executor.calls.map(call => call.caseId), [caseIdOf(next.key)], '被停掉的 Case 一条消息也不接；新 Case 正常派工')
  eq(ledger.cases.length, 2)
  eq(ledger.cases.find(record => record.id === first).closed, { reason: 'stopped', at: NOW + 1_000 })
  eq(ledger.threads[0].subscriptions, [first, caseIdOf(next.key)])
})

await test('已完成的 Case 被追问时是恢复：投给同一个 Case，不开新的', async () => {
  const ledger = memoryLedger()
  const executor = executorOf()
  const first = caseIdOf(trigger().key)
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })
  await ledger.closeCase(first, 'completed', NOW + 1_000)
  executor.calls.length = 0

  const again = trigger({ key: `${SRC}:comment-4`, text: '再补一个测试' })
  await run({ sources: [sourceOf({ triggers: [again], cursor: 'c2' })], ledger, executor, now: NOW + 20_000 })

  eq(executor.calls, [{ caseId: first, text: '再补一个测试', trigger: again.key }])
  eq(ledger.cases.length, 1)
})

await test('订阅投递绕过闸门：名单外的人在自己 Case 的 thread 上说话也能抵达', async () => {
  const ledger = memoryLedger()
  const executor = executorOf()
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })

  const stranger = trigger({ key: `${SRC}:comment-5`, actor: human('mallory'), text: '@agent 还有个细节' })
  const report = await run({ sources: [sourceOf({ triggers: [stranger], cursor: 'c2' })], ledger, executor })

  eq(report.sources[0].delivered, 1)
  eq(report.sources[0].refused, 0, '归属不是一次新的授权判断')
  eq(executor.calls.length, 1)
})

await test('同一批里同一 thread 两条被授权的新消息：只开一个 Case，第二条投给它', async () => {
  const ledger = memoryLedger()
  const executor = executorOf()
  const second = trigger({ key: `${SRC}:comment-2`, text: '顺便修下文档' })
  const report = await run({ sources: [sourceOf({ triggers: [trigger(), second], cursor: 'c1' })], ledger, executor })

  eq(report.sources[0].opened, 1)
  eq(report.sources[0].delivered, 1)
  eq(ledger.cases.length, 1)
  eq(ledger.threads, [{ key: trigger().thread, subscriptions: [caseIdOf(trigger().key)], lastAt: NOW }])
  eq(executor.calls.map(call => call.text), ['please fix the flaky test', '顺便修下文档'], '开 Case 与第二条消息都交给 executor，顺序不变')
})

await test('没有 executor 的装配：有主的消息计 skipped，一个字也不审计', async () => {
  const ledger = memoryLedger()
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })

  const second = trigger({ key: `${SRC}:comment-2`, text: '还有一处' })
  const report = await run({ sources: [sourceOf({ triggers: [second], cursor: 'c2' })], ledger })

  eq(report.sources[0], { sourceId: SRC, opened: 0, observed: 0, refused: 0, delivered: 0, skipped: 1, error: null })
  eq(ledger.audit.map(event => event.kind), ['case.opened'], 'case.followed-up 不能在没有投递的地方出现')
  eq(ledger.cases.length, 1)
})

await test('新 issue 正常开：另一个 thread 不受已有 Case 影响', async () => {
  const ledger = memoryLedger()
  const executor = executorOf()
  await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })
  executor.calls.length = 0

  const otherThread = trigger({ key: `${SRC}:issue-77`, thread: `${SRC}:issue-77`, text: '@agent 新活' })
  const report = await run({ sources: [sourceOf({ triggers: [otherThread], cursor: 'c2' })], ledger, executor })

  eq(report.sources[0].opened, 1)
  eq(executor.calls.map(call => call.caseId), [caseIdOf(otherThread.key)], '新 issue 开新 Case 并派工，别的 thread 不受影响')
  eq(ledger.cases.map(record => record.origin), [trigger().key, otherThread.key])
  eq(ledger.threads.map(row => row.subscriptions.length), [1, 1])
})

// ── 幂等 ────────────────────────────────────────────────────────
await test('同一个事件在同一批里出现两次 → 只算一次', async () => {
  const ledger = memoryLedger()
  const report = await run({ sources: [sourceOf({ triggers: [trigger(), trigger()], cursor: 'c1' })], ledger })

  eq(report.sources[0].opened, 1)
  eq(report.sources[0].skipped, 1)
  eq(ledger.cases.length, 1)
})

await test('第二轮又读到同一事件（重叠窗口）→ 已有 Case，不开第二个', async () => {
  const ledger = memoryLedger()
  const src = sourceOf({ triggers: [trigger()], cursor: 'c1' })
  await run({ sources: [src], ledger })
  const second = await run({ sources: [src], ledger, now: NOW + 10_000 })

  eq(second.sources[0].opened, 0)
  eq(second.sources[0].skipped, 1)
  eq(ledger.cases.length, 1)
  eq(ledger.audit.length, 1, '重复一次不该多写一条审计')
})

// ── 拒绝 ────────────────────────────────────────────────────────
await test('陌生人的请求被拒，且进审计（这是运营要看的）', async () => {
  const ledger = memoryLedger()
  const report = await run({
    sources: [sourceOf({ triggers: [trigger({ actor: human('mallory') })], cursor: 'c1' })],
    ledger,
  })

  eq(report.sources[0].refused, 1)
  eq(ledger.cases.length, 0)
  eq(ledger.audit, [{ kind: 'trigger.refused', at: NOW, trigger: trigger().key, reason: 'sender-not-allowed' }])
})

await test('没点名的消息被拒，但不进审计——否则每条闲聊都记一条', async () => {
  const ledger = memoryLedger()
  await run({ sources: [sourceOf({ triggers: [trigger({ kind: 'ambient' })], cursor: 'c1' })], ledger })

  eq(ledger.audit, [])
})

// ── observe ─────────────────────────────────────────────────────
await test('observe：记下本来会做什么，一个 Case 都不建', async () => {
  const ledger = memoryLedger()
  const p = policy({ bots: [{ source: SRC, id: 'ci-bot' }], acceptMode: 'observe' })
  const report = await run({ sources: [sourceOf({ triggers: [trigger({ actor: bot('ci-bot') })], cursor: 'c1' })], ledger, policy: p })

  eq(report.sources[0].observed, 1)
  eq(report.sources[0].opened, 0)
  eq(ledger.cases.length, 0)
  eq(ledger.audit[0].kind, 'case.observed')
})

// ── 失败 ────────────────────────────────────────────────────────
await test('poll 抛错 → 记进 lastError 与审计，游标不动，不装成"没有新活"', async () => {
  const ledger = memoryLedger()
  const report = await run({ sources: [sourceOf(new Error('502 Bad Gateway'))], ledger })

  eq(report.sources[0].error, '502 Bad Gateway')
  eq(report.sources[0].opened, 0)
  eq(ledger.progressOf(SRC), { cursor: null, lastError: '502 Bad Gateway', lastPolledAt: NOW })
  eq(ledger.audit, [{ kind: 'poll.failed', at: NOW, source: SRC, message: '502 Bad Gateway' }])
})

await test('一个源挂了不影响后面的源', async () => {
  const OTHER = 'chat:oc_room'
  const ledger = memoryLedger()
  const report = await run({
    sources: [
      sourceOf(new Error('timeout'), SRC),
      sourceOf({ triggers: [trigger({ source: OTHER, thread: `${OTHER}:t1` })], cursor: 'c2' }, OTHER),
    ],
    ledger,
  })

  eq(report.sources.map(s => s.opened), [0, 1])
  eq(ledger.cases.length, 1)
})

await test('恢复后 lastError 被清掉，游标继续推进', async () => {
  const ledger = memoryLedger()
  let fail = true
  const src = sourceOf(() => (fail ? new Error('boom') : { triggers: [], cursor: 'c9' }))
  await run({ sources: [src], ledger })
  fail = false
  await run({ sources: [src], ledger, now: NOW + 1_000 })

  eq(ledger.progressOf(SRC), { cursor: 'c9', lastError: null, lastPolledAt: NOW + 1_000 })
})

// ── brief ───────────────────────────────────────────────────────
await test('brief 去掉首尾空白', () => {
  eq(briefOf('  fix it  '), 'fix it')
})
await test('超长 brief 被截断并留下标记，不假装是全文', () => {
  const brief = briefOf('x'.repeat(MAX_BRIEF_CHARS + 100))

  eq(brief.startsWith('x'.repeat(MAX_BRIEF_CHARS)), true)
  eq(brief.includes('truncated'), true)
})
await test('刚好等于上限的不截断', () => {
  eq(briefOf('y'.repeat(MAX_BRIEF_CHARS)).includes('truncated'), false)
})

console.log(`pass: ${checks} checks`)
