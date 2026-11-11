/**
 * The GitHub surface this source uses, declared here rather than imported.
 *
 * Three reasons, in order of how much they matter:
 *
 * 1. **The test needs no network and no mock server.** A 20-line object in
 *    `tests/github-issue.mjs` covers every branch, including the ones the real
 *    API only produces under rate limiting.
 * 2. **An Octokit upgrade cannot break this file.** Only the shapes below matter;
 *    how Octokit paginates, retries or renames its client is not our business.
 * 3. **It documents exactly what we read.** Anyone reviewing permissions can see
 *    that this source reads issues and comments, and nothing else.
 *
 * Everything is `readonly`: a source never mutates a response. Dates stay ISO
 * strings, as GitHub sends them — converting at the edge would hide which clock a
 * value came from.
 */

export interface RawUser {
  readonly login: string
  /** GitHub's `User.type`: `User` or `Bot`. */
  readonly type: string
}

/**
 * One issue **or pull request**.
 *
 * GitHub returns both from the issues endpoint and distinguishes them by the
 * presence of `pull_request`. Pull requests are ignored here: they are a separate
 * source with their own thread keys, so treating one as an issue would let two
 * views of the same work open two Cases.
 */
export interface RawIssue {
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly user: RawUser | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly assignee: RawUser | null
  readonly pull_request?: unknown
}

export interface RawComment {
  readonly id: number
  readonly body: string | null
  readonly user: RawUser | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ListIssuesInput {
  readonly owner: string
  readonly repo: string
  /** ISO timestamp; GitHub returns issues updated at or after it. */
  readonly since: string
  readonly signal: AbortSignal
}

export interface ListCommentsInput {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly since: string
  readonly signal: AbortSignal
}

export interface GithubFace {
  listIssues(input: ListIssuesInput): Promise<readonly RawIssue[]>
  listComments(input: ListCommentsInput): Promise<readonly RawComment[]>
}
