#!/usr/bin/env node
/**
 * Tests for the GitHub issue source and mention detection.
 *
 * No network, no mock server: `GithubFace` is one object with two methods, so
 * every branch — including the ones the real API only produces under rate
 * limiting — is reachable in a process that never opens a socket.
 *
 * The suite is mostly about two invariants:
 *
 * 1. **The keys are stable.** A poll may report the same event twice (the overlap
 *    window guarantees it); what must never happen is the same event arriving
 *    under two different keys, because that is what opens two Cases for one piece
 *    of work.
 * 2. **A cursor we cannot read is no cursor.** Falling back to the lookback
 *    re-reads; falling back to "skip" loses work silently.
 *
 * Usage: node packages/dsh-oncall/tests/github-issue.mjs
 */

import assert from 'node:assert/strict'

import { mentions } from '../src/core/mentions.ts'
import { githubIssueSource, GITHUB_OVERLAP_MS } from '../src/sources/github-issue.ts'

const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = ms => new Date(ms).toISOString()

const LOGIN = 'agent'
const OWNER = 'acme'
const REPO = 'widgets'
const SOURCE = `github:${OWNER}/${REPO}#issues`

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

const user = (login, type = 'User') => ({ login, type })
const issue = (over = {}) => ({
  number: 12,
  title: 'Flaky login test',
  body: 'the suite is flaky',
  user: user('alice'),
  createdAt: iso(NOW - 2 * HOUR),
  updatedAt: iso(NOW - HOUR),
  assignee: null,
  ...over,
})
const comment = (id, body, over = {}) => ({
  id,
  body,
  user: user('alice'),
  createdAt: iso(NOW - HOUR),
  updatedAt: iso(NOW - HOUR),
  ...over,
})

/**
 * A `GithubFace` that honours `since` the way GitHub does, so the tests exercise
 * cursor narrowing rather than a stub that always returns everything.
 */
function fakeFace({ issues = [], comments = {} } = {}) {
  const calls = []
  return {
    calls,
    async listIssues({ since }) {
      calls.push({ kind: 'issues', since })
      return issues.filter(item => Date.parse(item.updatedAt) >= Date.parse(since))
    },
    async listComments({ number, since }) {
      calls.push({ kind: 'comments', number, since })
      return (comments[number] ?? []).filter(item => Date.parse(item.updatedAt) >= Date.parse(since))
    },
  }
}

const source = face => githubIssueSource({ face, owner: OWNER, repo: REPO, login: LOGIN, initialLookbackMs: 7 * DAY })
const poll = (src, { now = NOW, cursor = null } = {}) =>
  src.poll({ cursor, now, signal: new AbortController().signal })

// ── mentions ────────────────────────────────────────────────────
await test('mentions: 普通 @ 命中', () => {
  eq(mentions('hey @agent please look', LOGIN), true)
})
await test('mentions: 句末的 @ 命中（后面只有标点）', () => {
  eq(mentions('cc @agent.', LOGIN), true)
})
await test('mentions: @agent-bot 不算——否则机器人会被自己的回复唤醒', () => {
  eq(mentions('from @agent-bot', LOGIN), false)
})
await test('mentions: 邮箱里的 @ 不算', () => {
  eq(mentions('mail ops@agent.example', LOGIN), false)
})
await test('mentions: 空 login 永不命中', () => {
  eq(mentions('@', ''), false)
})

// ── GitHub issue source ─────────────────────────────────────────
await test('第一次 poll：评论里的 @ 变成 Trigger，键与 thread 稳定', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(900, '@agent fix it')] } })
  const result = await poll(source(face))

  eq(result.triggers.length, 1)
  const [trigger] = result.triggers
  eq(trigger.key, `${SOURCE}:comment-900`)
  eq(trigger.thread, `${SOURCE}:issue-12`)
  eq(trigger.kind, 'mention')
  eq(trigger.actor, { source: SOURCE, id: 'alice', handle: '@alice', kind: 'human' })
  eq(trigger.text, '@agent fix it')
  eq(trigger.at, NOW - HOUR)
})

await test('没点名的评论被忽略', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(901, 'looks fine to me')] } })
  eq((await poll(source(face))).triggers.length, 0)
})

await test('指派给 agent 的 issue 也算，kind 是 direct', async () => {
  const face = fakeFace({ issues: [issue({ assignee: user(LOGIN) })] })
  const result = await poll(source(face))

  eq(result.triggers.length, 1)
  eq(result.triggers[0].key, `${SOURCE}:issue-12`)
  eq(result.triggers[0].kind, 'direct')
})

await test('PR 被跳过：它有自己的 thread 键', async () => {
  const face = fakeFace({
    issues: [issue({ number: 7, pull_request: { url: 'x' }, body: '@agent review' })],
    comments: { 7: [comment(902, '@agent ptal')] },
  })
  eq((await poll(source(face))).triggers.length, 0)
})

await test('机器人发的评论 actor.kind 是 bot', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(903, '@agent ci failed', { user: user('ci[bot]', 'Bot') })] } })
  const [trigger] = (await poll(source(face))).triggers

  eq(trigger.actor.kind, 'bot')
  eq(trigger.actor.id, 'ci[bot]')
})

await test('已删除账号按 bot 处理：不允许凭空继承人的权限', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(904, '@agent hi', { user: null })] } })
  eq((await poll(source(face))).triggers[0].actor.kind, 'bot')
})

await test('游标推进到 now 减回看窗口', async () => {
  const face = fakeFace()
  const result = await poll(source(face))

  eq(JSON.parse(result.cursor), { since: NOW - GITHUB_OVERLAP_MS })
})

await test('第二次 poll：窗口外的老评论不再上报', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(900, '@agent fix it')] } })
  const src = source(face)
  const first = await poll(src)
  const second = await poll(src, { now: NOW + 10_000, cursor: first.cursor })

  eq(first.triggers.length, 1)
  eq(second.triggers.length, 0)
})

await test('窗口内的重复上报：键必须一模一样，靠键去重而不是靠游标', async () => {
  const face = fakeFace({
    issues: [issue({ updatedAt: iso(NOW) })],
    comments: { 12: [comment(905, '@agent again', { updatedAt: iso(NOW - 30_000) })] },
  })
  const src = source(face)
  const first = await poll(src)
  const second = await poll(src, { now: NOW + 10_000, cursor: first.cursor })

  eq(first.triggers.length, 1)
  eq(second.triggers.length, 1)
  eq(second.triggers[0].key, first.triggers[0].key)
})

await test('游标损坏 → 退回回看窗口，绝不跳过', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(906, '@agent hi')] } })
  const result = await poll(source(face), { cursor: '{not json' })

  eq(result.triggers.length, 1)
  eq(face.calls[0].since, iso(NOW - 7 * DAY))
})

await test('首次 poll 默认不回看历史：only from switch-on', async () => {
  const face = fakeFace({ issues: [issue()], comments: { 12: [comment(907, '@agent hi')] } })
  const src = githubIssueSource({ face, owner: OWNER, repo: REPO, login: LOGIN })
  const result = await poll(src)

  eq(result.triggers.length, 0)
  eq(face.calls[0].since, iso(NOW))
})

console.log(`github-issue: ${checks} checks`)
