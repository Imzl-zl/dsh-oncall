#!/usr/bin/env node
/**
 * Tests for the `fetch`-based GitHub face.
 *
 * The bugs in an HTTP adapter are never in the happy path — they are in pagination
 * (silently dropping page 2), in error mapping (a 403 becoming an empty list) and in
 * a response the API changed shape under. All three are reachable here because
 * `fetch` is injected.
 *
 * Usage: node packages/dsh-oncall/tests/github-http.mjs
 */

import assert from 'node:assert/strict'

import { githubHttpFace } from '../src/sources/github-http.ts'

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

const SIGNAL = new AbortController().signal

const issueJson = (number, over = {}) => ({
  number,
  title: `issue ${number}`,
  body: 'please fix',
  user: { login: 'alice', type: 'User' },
  created_at: '2026-11-09T10:00:00Z',
  updated_at: '2026-11-09T11:00:00Z',
  assignee: null,
  ...over,
})

const commentJson = (id, over = {}) => ({
  id,
  body: '@agent look',
  user: { login: 'bob', type: 'User' },
  created_at: '2026-11-09T10:00:00Z',
  updated_at: '2026-11-09T11:00:00Z',
  ...over,
})

/** A fetch that answers from a list of pages, recording every URL it saw. */
function fetchOf(pages, { status = 200 } = {}) {
  const urls = []
  const calls = []
  const fetch = async (url, init) => {
    urls.push(url)
    calls.push(init)
    const page = Number(new URL(url).searchParams.get('page'))
    const body = pages[page - 1] ?? []
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Forbidden',
      async json() { return body },
    }
  }
  return { fetch, urls, calls }
}

const face = fetch => githubHttpFace({ token: 'secret-token', fetch })

// ── shapes ──────────────────────────────────────────────────────
await test('一页 issue：字段映射正确，PR 标记保留', async () => {
  const { fetch } = fetchOf([[issueJson(12), issueJson(13, { pull_request: { url: 'x' } })]])
  const items = await face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL })

  eq(items.length, 2)
  eq(items[0], {
    number: 12,
    title: 'issue 12',
    body: 'please fix',
    user: { login: 'alice', type: 'User' },
    createdAt: '2026-11-09T10:00:00Z',
    updatedAt: '2026-11-09T11:00:00Z',
    assignee: null,
  })
  eq('pull_request' in items[1], true)
})

await test('请求带上鉴权头与 API 版本', async () => {
  const { fetch, calls } = fetchOf([[]])
  await face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL })

  eq(calls[0].headers.authorization, 'Bearer secret-token')
  eq(calls[0].headers.accept, 'application/vnd.github+json')
  eq(calls[0].headers['x-github-api-version'], '2022-11-28')
  eq(calls[0].signal, SIGNAL)
})

await test('仓库与 since 进 URL，且被正确转义', async () => {
  const { fetch, urls } = fetchOf([[]])
  await face(fetch).listIssues({ owner: 'a cme', repo: 'wid gets', since: '2026-11-09T00:00:00Z', signal: SIGNAL })

  eq(urls[0].includes('/repos/a%20cme/wid%20gets/issues'), true)
  eq(urls[0].includes('since=2026-11-09T00%3A00%3A00Z'), true)
  eq(urls[0].includes('state=all'), true)
})

// ── pagination ─────────────────────────────────────────────────
await test('第一页满 100 就继续翻页，不静默丢第二页', async () => {
  const first = Array.from({ length: 100 }, (_, index) => issueJson(index + 1))
  const second = [issueJson(101), issueJson(102)]
  const { fetch, urls } = fetchOf([first, second])
  const items = await face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL })

  eq(items.length, 102)
  eq(urls.length, 2)
  eq(urls[1].includes('page=2'), true)
})

await test('翻页超过上限就报错，不假装读完了', async () => {
  const full = Array.from({ length: 100 }, (_, index) => issueJson(index + 1))
  const pages = Array.from({ length: 12 }, () => full)
  const { fetch } = fetchOf(pages)

  await assert.rejects(
    () => face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL }),
    /exceeded 10 pages/,
  )
})

// ── errors ─────────────────────────────────────────────────────
await test('403 变成错误，而不是空列表', async () => {
  const { fetch } = fetchOf([[]], { status: 403 })

  await assert.rejects(
    () => face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL }),
    /GitHub 403 Forbidden/,
  )
})

await test('issue 缺 number 直接报错：编一个 number 会让 Case 永远对不上', async () => {
  const { fetch } = fetchOf([[{ title: 'no number', created_at: 'x', updated_at: 'y' }]])

  await assert.rejects(
    () => face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL }),
    /no integer number/,
  )
})

await test('响应不是数组也报错', async () => {
  const fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ message: 'moved' }) })

  await assert.rejects(
    () => face(fetch).listIssues({ owner: 'acme', repo: 'widgets', since: '2026-11-09T00:00:00Z', signal: SIGNAL }),
    /non-array body/,
  )
})

// ── comments ───────────────────────────────────────────────────
await test('评论走 issue 子路径，since 一起传', async () => {
  const { fetch, urls } = fetchOf([[commentJson(900)]])
  const items = await face(fetch).listComments({ owner: 'acme', repo: 'widgets', number: 12, since: '2026-11-09T00:00:00Z', signal: SIGNAL })

  eq(items.length, 1)
  eq(items[0].id, 900)
  eq(urls[0].includes('/repos/acme/widgets/issues/12/comments'), true)
  eq(urls[0].includes('since=2026-11-09T00%3A00%3A00Z'), true)
})

await test('删除的账号映射成 null，交给上层决定按 bot 处理', async () => {
  const { fetch } = fetchOf([[commentJson(901, { user: null })]])
  const [item] = await face(fetch).listComments({ owner: 'acme', repo: 'widgets', number: 12, since: '2026-11-09T00:00:00Z', signal: SIGNAL })

  eq(item.user, null)
})

console.log(`github-http: ${checks} checks`)
