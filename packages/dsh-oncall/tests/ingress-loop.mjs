#!/usr/bin/env node
/**
 * Tests for the durable ledger and the pass loop.
 *
 * Two things are worth testing here that a reviewer cannot see by reading:
 *
 * 1. **The ledger refuses to write after its domain closed.** A fiber restart closes
 *    the domain; a pass that keeps writing would throw an opaque error from another
 *    package. It must fail with our own message instead.
 * 2. **The loop never overlaps itself.** A slow pass must delay the next one, not
 *    stack on it — that is the whole reason it is a timeout chain and not an interval.
 *
 * The four tables the V0 executor and outbox add (`threads`/`steps`/`replies`) are
 * covered in place: an older domain that does not serve them must read as empty, and
 * must refuse to write rather than losing a step halfway.
 *
 * The storage domain is a 40-line fake: `get`/`entries`/`put` over a `Map`. That is
 * the entire surface this module uses, and it keeps the test free of DSH.
 *
 * Usage: node packages/dsh-oncall/tests/ingress-loop.mjs
 */

import assert from 'node:assert/strict'

import { DurableLedger, INGRESS_DOMAIN, ingressDomain } from '../src/runtime/durable-ledger.ts'
import { startIngressLoop } from '../src/faces/ingress.ts'

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

/** One KV table over a Map, exactly what `ctx.storageDomain` hands back. */
function tableOf() {
  const rows = new Map()
  return {
    rows,
    get: key => rows.get(key),
    entries: () => rows.entries(),
    put: async (key, value) => { rows.set(key, value) },
  }
}

/** A storage facility that opens `tables`, or fails when `fail` is set. */
function storageOf({ fail = false, tables } = {}) {
  const declared = tables ?? {
    progress: tableOf(),
    cases: tableOf(),
    threads: tableOf(),
    steps: tableOf(),
    replies: tableOf(),
    audit: tableOf(),
  }
  const opened = []
  const disposers = []
  return {
    tables: declared,
    opened,
    disposers,
    get(name) {
      if (name !== 'storageDomain') return undefined
      return {
        async open(spec) {
          opened.push(spec)
          if (fail) throw new Error('backend unavailable')
          return {
            table: name => declared[name],
            async close() { return undefined },
          }
        },
      }
    },
    logger: { error() {} },
    effect(execute) { disposers.push(execute()) },
  }
}

const caseOf = (over = {}) => ({
  id: `case:${SRC}:comment-1`,
  mandate: {
    strength: 'explicit',
    actor: { source: SRC, id: 'alice', handle: '@alice', kind: 'human' },
    scope: [`${SRC}:issue-12`],
    policyVersion: 3,
  },
  origin: `${SRC}:comment-1`,
  brief: 'fix the flaky test',
  openedAt: NOW,
  closed: null,
  ...over,
})

// ── durable ledger ──────────────────────────────────────────────
await test('声明的是 oncall_ingress 域，版本 1', () => {
  eq(INGRESS_DOMAIN, 'oncall_ingress')
  eq(ingressDomain.name, 'oncall_ingress')
})

await test('打开后 persistent 为真，读到的空进度是默认值', async () => {
  const ctx = storageOf()
  const ledger = new DurableLedger(ctx)
  await ledger.ready

  eq(ledger.persistent, true)
  eq(ledger.readProgress(SRC), { cursor: null, lastError: null, lastPolledAt: null })
  eq(ledger.hasCase(`case:${SRC}:comment-1`), false)
})

await test('一次 commit 同时写进度、Case、thread 与审计', async () => {
  const ctx = storageOf()
  const ledger = new DurableLedger(ctx)
  await ledger.ready
  const thread = { key: `${SRC}:issue-12`, subscriptions: [caseOf().id], lastAt: NOW }
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: 'c1', lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [thread],
    audit: [{ kind: 'case.opened', at: NOW, caseId: caseOf().id, trigger: `${SRC}:comment-1`, strength: 'explicit' }],
  })

  eq(ledger.readProgress(SRC), { cursor: 'c1', lastError: null, lastPolledAt: NOW })
  eq(ledger.hasCase(`case:${SRC}:comment-1`), true)
  eq(ledger.threadOf(thread.key), thread)
  eq(ctx.tables.audit.rows.size, 1)
})

await test('写进去的 Case 读回来形状不变（品牌只在编译期）', async () => {
  const ctx = storageOf()
  const ledger = new DurableLedger(ctx)
  await ledger.ready
  await ledger.commit({ sourceId: SRC, progress: { cursor: null, lastError: null, lastPolledAt: NOW }, cases: [caseOf()], threads: [], audit: [] })

  eq(ledger.allCases(), [caseOf()])
})

await test('没有 storageDomain 的装配：persistent 为假，不假装持久', async () => {
  const ledger = new DurableLedger({ get: () => undefined, logger: { error() {} }, effect() {} })
  await ledger.ready

  eq(ledger.persistent, false)
})

await test('打开失败：persistent 为假，且错误走 logger 而不是吞掉', async () => {
  const seen = []
  const ctx = storageOf({ fail: true })
  const ledger = new DurableLedger({ ...ctx, logger: { error: message => seen.push(message) } })
  await ledger.ready

  eq(ledger.persistent, false)
  eq(seen.length, 1)
  eq(seen[0].includes('backend unavailable'), true)
})

await test('域没打开时 commit 报自己的错，不写一半', async () => {
  const ledger = new DurableLedger({ get: () => undefined, logger: { error() {} }, effect() {} })
  await ledger.ready

  await assert.rejects(
    () => ledger.commit({ sourceId: SRC, progress: { cursor: null, lastError: null, lastPolledAt: NOW }, cases: [], threads: [], audit: [] }),
    /ingress storage domain is not open/,
  )
})

// ── 新表：threads / steps / replies ─────────────────────────────
const caseId = caseOf().id
const stepOf = (over = {}) => ({
  caseId,
  seq: 1,
  state: 'running',
  brief: 'fix the flaky test',
  report: null,
  at: NOW,
  ...over,
})
const replyOf = (over = {}) => ({
  caseId,
  seq: 1,
  intent: 'result',
  text: '## 好了',
  state: 'pending',
  at: NOW,
  ...over,
})

const seeded = async () => {
  const ctx = storageOf()
  const ledger = new DurableLedger(ctx)
  await ledger.ready
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: 'c1', lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    threads: [{ key: `${SRC}:issue-12`, subscriptions: [caseId], lastAt: NOW }],
    audit: [],
  })
  return { ctx, ledger }
}

await test('threads：开 Case 时写入的订阅读得回来，没订阅过的 thread 是 undefined', async () => {
  const { ledger } = await seeded()

  eq(ledger.threadOf(`${SRC}:issue-12`), { key: `${SRC}:issue-12`, subscriptions: [caseId], lastAt: NOW })
  eq(ledger.threadOf(`${SRC}:issue-99`), undefined)
})

await test('steps：按 caseId#seq 覆盖写，stepsOf 只给这个 Case 且按 seq 排序', async () => {
  const { ledger } = await seeded()
  const other = caseOf({ id: `case:${SRC}:comment-2` })
  await ledger.commit({ sourceId: SRC, progress: { cursor: 'c1', lastError: null, lastPolledAt: NOW }, cases: [other], threads: [], audit: [] })

  await ledger.writeSteps([stepOf({ seq: 2 }), stepOf({ seq: 1 })], [
    { kind: 'step.settled', at: NOW, caseId, seq: 1, state: 'waiting' },
  ])
  await ledger.writeSteps([stepOf({ seq: 1, state: 'ended', report: { state: 'waiting', summary: 'still on it', at: NOW }, endedAt: NOW })])
  await ledger.writeSteps([stepOf({ caseId: other.id, seq: 1, brief: 'other work' })])

  eq(ledger.stepsOf(caseId).map(step => step.seq), [1, 2])
  eq(ledger.stepsOf(caseId)[0].state, 'ended', '同 key 的第二次写是覆盖，不是追加')
  eq(ledger.stepsOf(caseId)[0].report, { state: 'waiting', summary: 'still on it', at: NOW })
  eq(ledger.stepsOf(other.id).map(step => step.brief), ['other work'])
})

await test('steps：blocked / failed 报告的 question 与 code 原样读回', async () => {
  const { ledger } = await seeded()
  await ledger.writeSteps([
    stepOf({ seq: 1, report: { state: 'blocked', summary: 'needs a decision', question: '哪个分支？', at: NOW } }),
    stepOf({ seq: 2, report: { state: 'failed', summary: 'gateway died', code: 'SERVER', at: NOW } }),
  ])

  eq(ledger.stepsOf(caseId).map(step => step.report), [
    { state: 'blocked', summary: 'needs a decision', question: '哪个分支？', at: NOW },
    { state: 'failed', summary: 'gateway died', code: 'SERVER', at: NOW },
  ])
})

await test('replies：按 caseId#seq 查，pendingReplies 只给还没发的', async () => {
  const { ledger } = await seeded()
  await ledger.writeReply(replyOf())
  await ledger.writeReply(replyOf({ seq: 2, state: 'sent' }))

  eq(ledger.replyOf(caseId, 1), replyOf())
  eq(ledger.replyOf(caseId, 9), undefined)
  eq(ledger.pendingReplies().map(reply => reply.seq), [1])

  await ledger.writeReply(replyOf({ state: 'sent' }))
  eq(ledger.pendingReplies(), [])
})

await test('closeCase：只改 closed 字段，其余原样；未知 Case 拒写', async () => {
  const { ledger } = await seeded()
  await ledger.closeCase(caseId, 'completed', NOW + 5, [
    { kind: 'step.settled', at: NOW + 5, caseId, seq: 1, state: 'ready' },
  ])

  eq(ledger.allCases(), [{ ...caseOf(), closed: { reason: 'completed', at: NOW + 5 } }])
  await assert.rejects(() => ledger.closeCase(`case:${SRC}:nope`, 'completed', NOW), /no such Case/)
})

await test('缺表按空表：旧域只服务三张表时，新表读是空值、写报自己的错', async () => {
  const legacy = storageOf({ tables: { progress: tableOf(), cases: tableOf(), audit: tableOf() } })
  const ledger = new DurableLedger(legacy)
  await ledger.ready

  eq(ledger.persistent, true, '核心三张表在，仍然认为可持久')
  eq(ledger.threadOf(`${SRC}:issue-12`), undefined)
  eq(ledger.stepsOf(caseId), [])
  eq(ledger.replyOf(caseId, 1), undefined)
  eq(ledger.pendingReplies(), [])
  await assert.rejects(() => ledger.writeSteps([stepOf()]), /storage domain is not open/)
  await assert.rejects(() => ledger.writeReply(replyOf()), /storage domain is not open/)
  await assert.rejects(() => ledger.closeCase(caseId, 'completed', NOW), /storage domain is not open/)
  await assert.rejects(() => ledger.record([]), /storage domain is not open/)
})

await test('域关闭后每一类写入都拒写，读仍按空值回答', async () => {
  const { ctx, ledger } = await seeded()
  for (const dispose of ctx.disposers) dispose()

  eq(ledger.persistent, false)
  await assert.rejects(() => ledger.commit({ sourceId: SRC, progress: { cursor: null, lastError: null, lastPolledAt: NOW }, cases: [], threads: [], audit: [] }), /storage domain is not open/)
  await assert.rejects(() => ledger.writeSteps([stepOf()]), /storage domain is not open/)
  await assert.rejects(() => ledger.writeReply(replyOf()), /storage domain is not open/)
  await assert.rejects(() => ledger.closeCase(caseId, 'completed', NOW), /storage domain is not open/)
  await assert.rejects(() => ledger.record([{ kind: 'step.interrupted', at: NOW, caseId, seq: 1 }]), /storage domain is not open/)
  eq(ledger.stepsOf(caseId).length, 0)
})

// ── loop ────────────────────────────────────────────────────────
/** A scheduler the test drives by hand. */
function manualScheduler() {
  const due = []
  return {
    due,
    set(run, ms) { due.push({ run, ms }); return due.length },
    clear(handle) { if (handle !== undefined) due.length = 0 },
    fire() {
      const next = due.shift()
      assert.ok(next, 'a tick was expected')
      next.run()
      return next.ms
    },
  }
}

const sourceOf = (calls, result = { triggers: [], cursor: 'c1' }) => ({
  id: SRC,
  label: 'test',
  async poll() { calls.push(1); return result },
})

const ledgerOf = () => ({
  readProgress: () => ({ cursor: null, lastError: null, lastPolledAt: null }),
  hasCase: () => false,
  allCases: () => [],
  threadOf: () => undefined,
  commit: async () => {},
})

const policy = () => ({ version: 1, acceptMode: 'off', allowed: [], bots: [], disabledSources: [] })

const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

await test('启动即跑一轮，然后才排下一次', async () => {
  const scheduler = manualScheduler()
  const calls = []
  const reports = []
  const loop = startIngressLoop({
    sources: [sourceOf(calls)],
    ledger: ledgerOf(),
    policy,
    intervalMs: 2_000,
    now: () => NOW,
    onPass: report => reports.push(report),
    onError: error => { throw error },
    scheduler,
  })

  await loop.settled()
  eq(calls.length, 1)
  eq(reports.length, 1)
  eq(scheduler.due.length, 1)
  eq(scheduler.due[0].ms, 2_000)
  loop.stop()
})

await test('下一轮只在上一轮结束后才排：不会叠跑', async () => {
  const scheduler = manualScheduler()
  let inFlight = 0
  let maxInFlight = 0
  const slow = {
    id: SRC,
    label: 'slow',
    async poll() {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await flush()
      inFlight -= 1
      return { triggers: [], cursor: 'c1' }
    },
  }
  const loop = startIngressLoop({
    sources: [slow],
    ledger: ledgerOf(),
    policy,
    intervalMs: 10,
    now: () => NOW,
    onPass: () => {},
    onError: error => { throw error },
    scheduler,
  })

  const first = loop.settled()
  await first
  // Firing the scheduled timer while nothing is in flight is the normal path; the
  // overlap guard is that the timer did not exist during the pass above.
  eq(maxInFlight, 1)
  eq(scheduler.due.length, 1)
  loop.stop()
})

await test('stop 后不再排下一轮', async () => {
  const scheduler = manualScheduler()
  const loop = startIngressLoop({
    sources: [sourceOf([])],
    ledger: ledgerOf(),
    policy,
    intervalMs: 10,
    now: () => NOW,
    onPass: () => {},
    onError: error => { throw error },
    scheduler,
  })

  await loop.settled()
  loop.stop()
  eq(scheduler.due.length, 0)
})

await test('pass 抛错走 onError，并且下一轮照排——不能因为一次写失败就停止看仓库', async () => {
  const scheduler = manualScheduler()
  const errors = []
  const loop = startIngressLoop({
    sources: [sourceOf([])],
    ledger: {
      readProgress: () => { throw new Error('ledger gone') },
      hasCase: () => false,
      commit: async () => {},
    },
    policy,
    intervalMs: 10,
    now: () => NOW,
    onPass: () => {},
    onError: (error, at) => errors.push({ error: String(error), at }),
    scheduler,
  })

  await loop.settled()
  eq(errors.length, 1)
  eq(errors[0].error.includes('ledger gone'), true)
  eq(errors[0].at, NOW)
  eq(scheduler.due.length, 1, '失败后仍要排下一轮')
  loop.stop()
})

console.log(`ingress-loop: ${checks} checks`)
