#!/usr/bin/env node
/**
 * The V0 loop in a real Loader composition: @ once → one Case → one worker
 * session → a follow-up in the same conversation → a restart that knows where it
 * stopped.
 *
 * ### Why a real composition and not a fake Context
 *
 * The executor's dependencies only exist in a real one: `sessionController` lives in
 * the web app's own patch, `agent/status` is emitted by the agent loop, and a
 * message id's idempotency depends on DSH's own inbox and session log. A hand-made
 * Context would only prove that the code calls the methods it calls. This boots the
 * shipped `web` profile under its own DSH_HOME (`--port 0`), inserts the stub adapter
 * and the built plugin by overlay, and points `ingress.baseUrl` at a fake GitHub
 * served from this process — no network, no real token.
 *
 * ### The restart is a second process
 *
 * A process kill mid-turn leaves exactly one durable trace: a `steps` row that is
 * still `running` with no report. Phase 1 ends with that state (the test writes the
 * missing report back as `null`), and phase 2 is a **new DSH process** on the same
 * home — the same thing that happens when a person restarts the app. Its startup scan
 * must end the orphaned assignment and start the next one with the recovery note, in
 * the same session.
 *
 * Two boots inside one process are not an option: `@deepseek-ai/dsh-client-modules`
 * keeps a process-wide registry that treats the second boot's two file-path entries
 * as one package from two sources and refuses to compose.
 *
 * Usage: node packages/dsh-oncall/tests/oncall-loop.mjs
 * Requires `npm run bundle` in the package directory first.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  boot,
  createRuntimeResolution,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { assertFreshBuild } from './freshness.mjs'
import { RECOVERY_NOTE } from '../src/contract/defaults.ts'
import { caseSessionId } from '../src/runtime/executor.ts'

assertFreshBuild()

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PKG = `${ROOT}packages/dsh-oncall`
const DSH_INSTALL = `${ROOT}node_modules/@deepseek-ai/dsh/package.json`
const DSH_BIN = `${ROOT}node_modules/@deepseek-ai/dsh/lib/bin.js`
const STUB = `${HERE}stub-adapter.mjs`.replaceAll('\\', '/')
const HOME = `${HERE}.dshhome-oncall-loop`
const SESSIONS = `${HERE}.sessions-oncall-loop`
const OVERLAY = `${HERE}oncall-loop-overlay.yml`
const SCRIPT = `${HERE}stub-script-oncall-loop.json`
const CHILD_LOG = `${HERE}oncall-loop-child.log`
const AGENT = 'alice-bot'
const REPO = 'acme/widgets'
const SRC = `github:${REPO}#issues`

// Test-owned scratch directories (gitignored), reset per run: a stale ledger would
// make the assertions read the previous run's history.
rmSync(HOME, { recursive: true, force: true })
rmSync(SESSIONS, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

// ---------- the fake GitHub ----------

/**
 * Everything the source reads and writes: the issues, their comments, and the POSTs.
 * `gone` makes every comment POST answer 404, which is what a deleted issue does.
 */
const github = { issues: [], comments: new Map(), posted: [], gone: false }

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(url.pathname)
  const issues = /^\/repos\/[^/]+\/[^/]+\/issues$/.exec(url.pathname)
  if (request.method === 'POST' && comments !== null) {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      github.posted.push({ number: Number(comments[1]), body: JSON.parse(body).body })
      response.writeHead(github.gone ? 404 : 201, { 'content-type': 'application/json' })
      response.end('{}')
    })
    return
  }
  const send = body => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (comments !== null) return send(github.comments.get(Number(comments[1])) ?? [])
  if (issues !== null) return send(github.issues)
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE_URL = `http://127.0.0.1:${server.address().port}`

// GitHub's own field names: the face validates them and refuses a response without
// `created_at` rather than inventing a timestamp nobody could reproduce.
const issue = (number, body) => ({
  number,
  title: `issue ${number}`,
  body,
  user: { login: 'alice', type: 'User' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  assignee: null,
})
const comment = (id, body) => ({
  id,
  body,
  user: { login: 'alice', type: 'User' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

github.issues.push(issue(12, `@${AGENT} 修一下 flaky 测试`))

// ---------- the overlay ----------

// The primary fails once, so the FIRST worker request has to be switched by the
// router: the acceptance row "渠道挂了换路且审计可见" is about an on-call session
// being an ordinary routed session, not a special one.
// `maxRetries: 0` keeps DSH's own `llm-retry` from healing the same route first: the
// point is the plugin's cross-channel switch, not the inner retry budget.
writeFileSync(SCRIPT, JSON.stringify({
  policy: { maxRetries: 0, retryableCodes: ['SERVER'] },
  'stub-primary': { outcomes: ['fail:SERVER'] },
  'stub-backup': { outcomes: ['ok'] },
}, null, 2))
writeFileSync(OVERLAY, `- id: llm-deepseek
  disabled: true

- id: llm-deepseek-account
  disabled: true

- id: session-persistence-jsonl
  config:
    root: '${SESSIONS.replaceAll('\\', '/')}'
    compression: none

- id: agent-default-model
  config:
    provider: stub-primary
    model: stub-model

- insert:
    - id: stub-adapter
      name: '${STUB}'
    - id: oncall
      name: '${PKG}/lib/index.js'
      config:
        enabled: true
        policyVersion: 2
        chain:
          candidates:
            - { provider: stub-backup, model: stub-model, maxRetries: 0 }
          switchOn: { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: true, invalidRequest: true, auth: true, quota: true, other: true }
        ingress:
          enabled: true
          repository: '${REPO}'
          baseUrl: '${BASE_URL}'
          agentLogin: '${AGENT}'
          allowed: ['alice']
          acceptMode: 'auto'
          pollSeconds: 5
`)

process.env.DSH_HOME = HOME
process.env.STUB_SCRIPT = SCRIPT
process.env.GITHUB_TOKEN = 'test-token'

const profile = loadProfile('oncall-loop-test', 'web', DSH_INSTALL, undefined, { userLayer: false })
const configPath = fileURLToPath(new URL('./cordis.yml', `file:///${profile.dir.replaceAll('\\', '/')}/`))
writeFileSync(configPath, '[]\n')
const overlays = [loadOverlayPatches('oncall-loop-test', OVERLAY)]
const moduleLayers = [{ packageName: 'oncall', packageDir: PKG, patchPaths: [OVERLAY], patches: [] }]
const resolution = await createRuntimeResolution({
  installAnchor: DSH_INSTALL,
  profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
})

/**
 * Dispose the in-process boot completely.
 *
 * `ctx.fiber.dispose()` is the root's own teardown (the `ctx.dispose()` shortcut some
 * DSH versions expose is not part of this one). This has to be awaited and has to
 * finish before the fixture edit and the child process: a still-running ingress keeps
 * its storage unit in memory and rewrites the whole document on its next commit,
 * which would silently undo the edit (`remote.mjs` uses the same call).
 */
const shutdown = async (instance) => {
  if (instance?.fiber?.dispose !== undefined) await instance.fiber.dispose()
  else if (typeof instance?.dispose === 'function') await instance.dispose()
}

// ---------- reading the durable facts ----------

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`    ok  ${label}`)
  else {
    failures += 1
    console.log(`    FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

const DOMAIN = `${HOME}/storages/oncall_ingress.json`
/** The stored ledger, or `undefined` before the ingress has written anything. */
const ledgerOf = () => {
  try {
    return JSON.parse(readFileSync(DOMAIN, 'utf8')).tables ?? {}
  } catch {
    return undefined
  }
}
const rows = table => Object.entries(ledgerOf()?.[table] ?? {}).map(([key, record]) => ({ key, ...record }))
const stepsOf = caseId => rows('steps').filter(step => step.caseId === caseId).sort((left, right) => left.seq - right.seq)

/** One session's events, read straight out of the jsonl persistence root. */
const sessionEvents = (sessionId) => {
  let entries
  try {
    entries = readdirSync(SESSIONS, { recursive: true, withFileTypes: true })
  } catch {
    return [] // the persistence root appears with the first flush
  }
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')
    && entry.parentPath.replaceAll('\\', '/').split('/').includes(sessionId))
  return files.flatMap(file => readFileSync(`${file.parentPath}/${file.name}`, 'utf8')
    .trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line)))
}
/** Our own messages in that session: injected context also arrives as `user/message`. */
const ourMessages = sessionId => sessionEvents(sessionId)
  .filter(event => event.type === 'user/message' && String(event.data?.id ?? '').startsWith('oncall:'))
  .map(event => ({ id: String(event.data.id), text: (event.data.content ?? []).map(block => block.text ?? '').join('') }))

/** Poll until `probe()` answers something, or fail the check and carry on. */
const waitFor = async (label, probe, deadlineMs = 40_000) => {
  const until = Date.now() + deadlineMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= until) {
      check(label, false, `timed out after ${deadlineMs}ms`)
      return undefined
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

// ---------- phase 1: @ once, then a follow-up ----------

let caseCount = 0
/** The Case phase 2 recovers: the one left open by phase 1 (blocked, so still live). */
let recoveryCase = ''
let ctx = await boot(
  'oncall-loop-test',
  configPath,
  [...profile.layers.flatMap(layer => layer.patches), ...overlays.flat()],
  async (composing) => {
    provideCmdline(composing, { args: ['--no-open', '--port', '0'], exit: () => {} })
    composing.provide('profileContext', {
      name: 'web', dir: profile.dir, patchPath: profile.patchPath, installAnchor: DSH_INSTALL,
      cwd: process.cwd(), home: HOME,
      startedBundles: profile.layers.map(layer => layer.packageName),
      overlays: overlays.flat(), telemetryDisabledEnv: undefined,
    })
    await composing.plugin(PluginPackages, { resolution })
  },
)

try {
  const caseRecord = await waitFor('the first pass opened exactly one Case', () => {
    const cases = rows('cases')
    return cases.length === 1 ? cases[0] : undefined
  })
  check('the Case remembers the issue body as its brief', caseRecord?.brief === `@${AGENT} 修一下 flaky 测试`,
    String(caseRecord?.brief))

  const caseId = caseRecord.key
  const sessionId = caseSessionId(caseId)
  check('the session id is derived from the Case', /^[a-zA-Z0-9_-]+$/.test(sessionId), sessionId)

  const thread = await waitFor('the thread row subscribes exactly that Case', () => {
    const found = rows('threads')
    return found.length === 1 ? found[0] : undefined
  })
  check('the thread is the issue, and the subscription is the Case',
    thread?.key === `${SRC}:issue-12` && JSON.stringify(thread?.subscriptions) === JSON.stringify([caseId]),
    JSON.stringify(thread))

  const delivered = await waitFor('the worker session received the Case brief', () => {
    const found = ourMessages(sessionId)
    return found[0]
  })
  check('the message carries the id the executor chose', delivered?.id === `oncall:${caseId}#1`, String(delivered?.id))
  check('the message is the requested work', delivered?.text === `@${AGENT} 修一下 flaky 测试`, String(delivered?.text))

  const settled = await waitFor('the first assignment settled', () => {
    const steps = rows('steps')
    return steps.length === 1 && steps[0].report !== null ? steps[0] : undefined
  })
  check('the settled step is seq 1, still running, and says waiting', settled?.seq === 1 && settled?.state === 'running'
    && settled?.report?.state === 'waiting', JSON.stringify(settled))

  // A second mention on the same issue must reach the SAME session; the thread's
  // subscription routes it, and no second Case may appear.
  github.comments.set(12, [comment(9001, `@${AGENT} 再补一个回归测试`)])
  const followUp = await waitFor('the follow-up reached the same session', () =>
    ourMessages(sessionId).find(message => message.id === `oncall:${caseId}:${SRC}:comment-9001`))
  check('the follow-up carries its trigger in the message id', Boolean(followUp?.id), String(followUp?.id))
  check('the follow-up is the comment, not a copy of the brief', followUp?.text === `@${AGENT} 再补一个回归测试`,
    String(followUp?.text))
  check('the follow-up opened no second Case', rows('cases').length === 1, `${rows('cases').length} cases`)
  check('the follow-up opened no second assignment', stepsOf(caseId).length === 1,
    JSON.stringify(stepsOf(caseId).map(step => step.seq)))
  const followed = await waitFor('the follow-up was audited', () => rows('audit').find(event => event.kind === 'case.followed-up'))
  check('the audit names the owning Case and the trigger', followed?.caseId === caseId
    && followed?.trigger === `${SRC}:comment-9001`, JSON.stringify(followed))
  const inputRow = rows('inputs').find(row => row.trigger === `${SRC}:comment-9001`)
  check('the routed message has an input row, stamped delivered', inputRow?.caseId === caseId
    && typeof inputRow?.deliveredAt === 'number', JSON.stringify(rows('inputs')))

  // ---- the worker session is an ordinary routed session ----
  //
  // The stub's primary always fails; only a cross-candidate switch can produce the
  // backup's answer. That answer in the session log is the durable fact the
  // `oncall/failover-history` projection folds (its own fold is covered by `run.mjs`).
  const answered = sessionEvents(sessionId)
    .filter(event => event.type === 'assistant/message')
    .map(event => (event.data?.message?.content ?? []).map(block => block.text ?? '').join(''))
  check('a failing route did not stop the worker: the fallback answered',
    answered.some(text => text.includes('STUB_OK:stub-backup')), JSON.stringify(answered))
  const switched = sessionEvents(sessionId).filter(event => event.type === 'request/header')
    .map(event => ({
      route: `${String(event.data?.header?.config?.provider)}/${String(event.data?.header?.config?.model)}`,
      // `reason` sits next to the header, not inside it (`SessionEventMap['request/header']`).
      reason: event.data?.reason,
    }))
  check('the durable log records the switch', switched.at(-1)?.route === 'stub-backup/stub-model'
    && switched.at(-1)?.reason === 'change', JSON.stringify(switched))

  // ---- the report tool, through the real registry ----
  //
  // Called on the worker's own agent (the stub adapter cannot emit a tool call),
  // which is exactly the identity the handler checks.
  const report = ctx.get('tools').get('oncall_report')
  check('the report tool is registered globally', report !== undefined)
  const workerAgent = ctx.get('agents').get(sessionId)
  const call = args => report.execute(args, { agent: workerAgent, signal: new AbortController().signal })

  const receipt = await call({ state: 'ready', summary: '修好了，回归也加了' })
  check('the tool answers with the assignment it settled', receipt?.seq === 1 && receipt?.state === 'ready', JSON.stringify(receipt))
  await waitFor('the receipt is on the issue', () => (github.posted.length > 0 ? github.posted[0] : undefined))
  check('ready → one comment on the issue, with the marker', github.posted.length === 1
    && github.posted[0].number === 12
    && github.posted[0].body.includes(`<!-- oncall:${caseId}#1 -->`), JSON.stringify(github.posted))
  check('the comment is the result, not progress chatter', github.posted[0]?.body.includes('## 完成了') === true,
    String(github.posted[0]?.body).slice(0, 120))
  check('ready closed the Case as completed', rows('cases').find(item => item.key === caseId)?.closed?.reason === 'completed',
    JSON.stringify(rows('cases').find(item => item.key === caseId)?.closed))
  check('the receipt is recorded as sent', rows('replies').find(item => item.key === `${caseId}#1`)?.state === 'sent',
    JSON.stringify(rows('replies')))

  const replay = await call({ state: 'progress', summary: '再来一次' }).then(
    () => 'accepted',
    error => String(error?.code ?? error),
  )
  check('a second report on a closed Case is refused', replay === 'ONCALL_REPORT_REFUSED', replay)
  check('the replay posted nothing', github.posted.length === 1, `${github.posted.length} comments`)

  // ---- a second issue, whose receipt cannot be posted (gone) ----
  github.issues.push(issue(13, `@${AGENT} 看一下日志`))
  const second = await waitFor('a second issue opened its own Case and assignment', () => {
    const found = rows('cases').find(item => String(item.origin).endsWith('issue-13'))
    const steps = found === undefined ? [] : stepsOf(found.key)
    return found !== undefined && steps.length === 1 ? { found, steps } : undefined
  })
  const secondSession = caseSessionId(second.found.key)
  await waitFor('the second worker session got its brief', () => {
    const found = ourMessages(secondSession)
    return found.length > 0 ? found[0] : undefined
  })
  // A question belongs to `blocked` only (reference `core/assignments.ts:96,101`).
  const contradictory = await ctx.get('tools').get('oncall_report').execute(
    { state: 'ready', summary: '做完了', question: '要不要合并？' },
    { agent: ctx.get('agents').get(secondSession), signal: new AbortController().signal },
  ).then(() => 'accepted', error => String(error?.code ?? error))
  check('a result carrying a question is refused', contradictory === 'ONCALL_REPORT_QUESTION_WITH_RESULT', contradictory)

  github.gone = true
  const blocked = await ctx.get('tools').get('oncall_report').execute(
    { state: 'blocked', summary: '缺一个环境变量', question: 'CI 的 token 用哪个？' },
    { agent: ctx.get('agents').get(secondSession), signal: new AbortController().signal },
  )
  check('the blocked report settled the second assignment', blocked?.seq === 1, JSON.stringify(blocked))
  await waitFor('the gone receipt is recorded', () =>
    rows('replies').find(item => item.key === `${second.found.key}#1` && item.state !== 'pending'))
  check('a 404 from GitHub marks the receipt gone',
    rows('replies').find(item => item.key === `${second.found.key}#1`)?.state === 'gone', JSON.stringify(rows('replies')))
  check('gone is not retried: exactly one POST for that receipt',
    github.posted.filter(item => item.number === 13).length === 1, JSON.stringify(github.posted.map(item => item.number)))
  check('the second Case stays open (blocked waits for a person)',
    rows('cases').find(item => item.key === second.found.key)?.closed === null,
    JSON.stringify(rows('cases').find(item => item.key === second.found.key)?.closed))
  check('re-reads of an already routed message added no audit rows (input ledger)',
    rows('audit').filter(event => event.kind === 'case.followed-up').length === 1,
    JSON.stringify(rows('audit').filter(event => event.kind === 'case.followed-up').map(event => event.trigger)))
  check('both receipts are in the audit stream',
    JSON.stringify(rows('audit').filter(event => event.kind === 'reply.settled').map(event => event.state))
      === JSON.stringify(['sent', 'gone']),
    JSON.stringify(rows('audit').filter(event => event.kind === 'reply.settled')))
  caseCount = rows('cases').length
  recoveryCase = second.found.key
} finally {
  await shutdown(ctx)
  ctx = undefined
}

// ---- the durable state a process kill mid-turn leaves behind ----
//
// The open Case's step loses its report: exactly what a kill between the message
// delivery and the settle writes. The closed Case keeps everything, so the restart
// must leave it alone.
const document = JSON.parse(readFileSync(DOMAIN, 'utf8'))
document.tables.steps[`${recoveryCase}#1`].report = null
writeFileSync(DOMAIN, `${JSON.stringify(document, null, 2)}\n`)

// ---------- phase 2: a new process on the same home ----------

const child = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--patch', OVERLAY, '--no-open', '--port', '0'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_HOME: HOME,
    STUB_SCRIPT: SCRIPT,
    GITHUB_TOKEN: 'test-token',
    PI_OFFLINE: '1',
    PI_PROVIDER: '',
    PI_MODEL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOutput = ''
child.stdout.on('data', chunk => { childOutput += String(chunk) })
child.stderr.on('data', chunk => { childOutput += String(chunk) })

try {
  const recovered = await waitFor('the restart scan started a second assignment', () => {
    const steps = stepsOf(recoveryCase)
    return steps.length === 2 ? steps : undefined
  }, 60_000)
  check('the orphaned assignment was ended, not deleted',
    recovered?.[0].state === 'ended' && recovered?.[0].seq === 1, JSON.stringify(recovered?.[0]))
  check('the orphaned assignment keeps no report', recovered?.[0].report === null, JSON.stringify(recovered?.[0].report))
  check('the new assignment is seq 2 and running',
    recovered?.[1]?.seq === 2 && recovered?.[1]?.state === 'running', JSON.stringify(recovered?.[1]))
  check('the new assignment carries the recovery note', String(recovered?.[1]?.brief ?? '').includes(RECOVERY_NOTE),
    String(recovered?.[1]?.brief).slice(0, 160))
  check('the interruption is in the audit stream',
    rows('audit').some(event => event.kind === 'step.interrupted' && event.seq === 1),
    JSON.stringify(rows('audit').map(event => event.kind)))

  const sessionId = caseSessionId(recoveryCase)
  const recovery = await waitFor('the recovery note reached the same session', () =>
    ourMessages(sessionId).find(message => message.id === `oncall:${recoveryCase}#2`))
  check('it is delivered under seq 2, in the same session', String(recovery?.text ?? '').includes(RECOVERY_NOTE),
    String(recovery?.text).slice(0, 160))
  check('it is still one session', readdirSync(SESSIONS, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name === sessionId).length === 1)

  const settledAgain = await waitFor('the recovered assignment settled too', () => {
    const steps = stepsOf(recoveryCase)
    return steps.length === 2 && steps[1].report !== null ? steps[1] : undefined
  }, 60_000)
  check('the recovered step reports waiting, not done', settledAgain?.report?.state === 'waiting',
    JSON.stringify(settledAgain?.report))
  check('the first pass after the restart opened no new Case (overlap window)', rows('cases').length === caseCount,
    `${rows('cases').length} cases (was ${String(caseCount)})`)
  check('the thread still subscribes exactly one Case',
    JSON.stringify(rows('threads').find(item => item.key === `${SRC}:issue-13`)?.subscriptions) === JSON.stringify([recoveryCase]),
    JSON.stringify(rows('threads').find(item => item.key === `${SRC}:issue-13`)))
  check('the closed Case stayed closed (the overlap window did not resume it)',
    rows('cases').find(item => item.key !== recoveryCase)?.closed?.reason === 'completed',
    JSON.stringify(rows('cases').map(item => [item.key, item.closed])))
  check('the closed Case gained no assignment', stepsOf(rows('cases').find(item => item.key !== recoveryCase).key).length === 1,
    JSON.stringify(rows('steps')))
} finally {
  child.kill()
  writeFileSync(CHILD_LOG, childOutput)
  server.close()
}

console.log(failures === 0 ? '\n0 failure(s)' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
