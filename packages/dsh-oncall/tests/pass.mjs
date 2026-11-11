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

const run = ({ sources, ledger = memoryLedger(), policy: p = policy(), now = NOW }) =>
  runPass({ sources, ledger, policy: p, now, signal: new AbortController().signal })

// ── 正常一轮 ────────────────────────────────────────────────────
await test('被授权的 @ → 开一个 Case，带 Mandate 与 origin', async () => {
  const ledger = memoryLedger()
  const report = await run({ sources: [sourceOf({ triggers: [trigger()], cursor: 'c1' })], ledger })

  eq(report.sources[0], { sourceId: SRC, opened: 1, observed: 0, refused: 0, skipped: 0, error: null })
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
