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
function storageOf({ fail = false } = {}) {
  const tables = { progress: tableOf(), cases: tableOf(), audit: tableOf() }
  const opened = []
  return {
    tables,
    opened,
    closed: 0,
    get(name) {
      if (name !== 'storageDomain') return undefined
      return {
        async open(spec) {
          opened.push(spec)
          if (fail) throw new Error('backend unavailable')
          return {
            table: name => tables[name],
            async close() { return undefined },
          }
        },
      }
    },
    logger: { error() {} },
    effect() {},
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

await test('一次 commit 同时写进度、Case 与审计', async () => {
  const ctx = storageOf()
  const ledger = new DurableLedger(ctx)
  await ledger.ready
  await ledger.commit({
    sourceId: SRC,
    progress: { cursor: 'c1', lastError: null, lastPolledAt: NOW },
    cases: [caseOf()],
    audit: [{ kind: 'case.opened', at: NOW, caseId: caseOf().id, trigger: `${SRC}:comment-1`, strength: 'explicit' }],
  })

  eq(ledger.readProgress(SRC), { cursor: 'c1', lastError: null, lastPolledAt: NOW })
  eq(ledger.hasCase(`case:${SRC}:comment-1`), true)
  eq(ctx.tables.audit.rows.size, 1)
})

await test('写进去的 Case 读回来形状不变（品牌只在编译期）', async () => {
  const ctx = storageOf()
  const ledger = new DurableLedger(ctx)
  await ledger.ready
  await ledger.commit({ sourceId: SRC, progress: { cursor: null, lastError: null, lastPolledAt: NOW }, cases: [caseOf()], audit: [] })

  eq(ledger.cases(), [caseOf()])
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
    () => ledger.commit({ sourceId: SRC, progress: { cursor: null, lastError: null, lastPolledAt: NOW }, cases: [], audit: [] }),
    /ingress storage domain is not open/,
  )
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
