/**
 * The GitHub face over plain `fetch`, with pagination.
 *
 * ### Why not Octokit
 *
 * The only thing this source needs is two list endpoints. Octokit would add a
 * dependency, its own retry and throttle behaviour, and a version that has to track
 * the API — for two `GET`s. A narrow fetch face also lets the test drive pagination
 * and rate limiting by hand, which is where the bugs actually are.
 *
 * ### Pagination is not optional
 *
 * `per_page` caps at 100. A repo with more than 100 issues updated since the cursor
 * would silently lose the rest: `poll` would advance the cursor past them and they
 * would never be read. So the loop keeps asking until a page comes back short, and
 * throws past `MAX_PAGES` rather than pretending it finished.
 *
 * Rate limiting is left to throw: a 403 with `X-RateLimit-Remaining: 0` becomes an
 * error the pass records as `lastError` and retries next tick. Turning it into an
 * empty result would look like a quiet repo.
 *
 * Note: 为何只用 fetch、为何分页不省略 —— 见 .agents/notes/implemented/2026-11-09-github-source-cursor-overlap.md
 */

import type { GithubFace, RawComment, RawIssue } from './github-face.ts'

/** The narrow fetch shape this module uses; the test supplies its own. */
export type FetchFace = (
  url: string,
  init: {
    readonly method?: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal: AbortSignal
  },
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  json(): Promise<unknown>
}>

/** Pages one request may walk before giving up. 100 items each = 1000 per poll. */
const MAX_PAGES = 10

export interface GithubHttpOptions {
  readonly token: string
  readonly baseUrl?: string
  readonly fetch?: FetchFace
}

/**
 * A `GithubFace` backed by the REST API.
 *
 * The token is read once, at construction: a source that re-read a credential on
 * every poll would leak it into every error message and every log line that
 * formats the options object.
 */
export function githubHttpFace(options: GithubHttpOptions): GithubFace {
  const base = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const call = options.fetch ?? (globalThis.fetch as unknown as FetchFace)
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-oncall',
  }

  const read = async (path: string, signal: AbortSignal): Promise<readonly unknown[]> => {
    const items: unknown[] = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const url = `${base}${path}${separator}per_page=100&page=${page}`
      const response = await call(url, { headers, signal })
      if (!response.ok) {
        throw new Error(`GitHub ${response.status} ${response.statusText} on ${path}`)
      }
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error(`GitHub returned a non-array body on ${path}`)
      items.push(...body)
      if (body.length < 100) return items
    }
    throw new Error(`GitHub ${path} exceeded ${MAX_PAGES} pages; narrow the cursor before polling again`)
  }

  return {
    async listIssues({ owner, repo, since, signal }) {
      const path = `/repos/${enc(owner)}/${enc(repo)}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}`
      return (await read(path, signal)).map(rawIssue)
    },

    async listComments({ owner, repo, number, since, signal }) {
      const path = `/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments?since=${encodeURIComponent(since)}`
      return (await read(path, signal)).map(rawComment)
    },

    async createComment({ owner, repo, number, body, signal }) {
      const path = `/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments`
      const response = await call(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
        signal,
      })
      // A deleted or transferred issue answers 404/410 forever: retrying it would
      // leave the receipt pending for the life of the deployment.
      if (response.status === 404 || response.status === 410) return 'gone'
      if (!response.ok) throw new Error(`GitHub ${response.status} ${response.statusText} on ${path}`)
      return 'sent'
    },
  }
}

const enc = (segment: string): string => encodeURIComponent(segment)

/**
 * One API issue, narrowed to what the source reads.
 *
 * A missing `number` is a broken response, not a defaulted one: inventing a number
 * would create a trigger key that no later poll can reproduce, and the Case would be
 * orphaned. Everything else has a defensible default (an empty body, a deleted user).
 */
function rawIssue(value: unknown): RawIssue {
  const item = record(value, 'issue')
  return {
    number: requireNumber(item, 'number', 'issue'),
    title: text(item.title),
    body: item.body == null ? null : text(item.body),
    user: rawUser(item.user),
    createdAt: requireString(item, 'created_at', 'issue'),
    updatedAt: requireString(item, 'updated_at', 'issue'),
    assignee: rawUser(item.assignee),
    ...(item.pull_request === undefined ? {} : { pull_request: item.pull_request }),
  }
}

function rawComment(value: unknown): RawComment {
  const item = record(value, 'comment')
  return {
    id: requireNumber(item, 'id', 'comment'),
    body: item.body == null ? null : text(item.body),
    user: rawUser(item.user),
    createdAt: requireString(item, 'created_at', 'comment'),
    updatedAt: requireString(item, 'updated_at', 'comment'),
  }
}

function rawUser(value: unknown): RawIssue['user'] {
  if (value == null) return null
  const item = record(value, 'user')
  return { login: requireString(item, 'login', 'user'), type: text(item.type) || 'User' }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub returned a non-object ${what}`)
  }
  return value as Record<string, unknown>
}

function requireNumber(item: Record<string, unknown>, key: string, what: string): number {
  const value = item[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`GitHub ${what} has no integer ${key}`)
  }
  return value
}

function requireString(item: Record<string, unknown>, key: string, what: string): string {
  const value = item[key]
  if (typeof value !== 'string' || value === '') throw new Error(`GitHub ${what} has no ${key}`)
  return value
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
