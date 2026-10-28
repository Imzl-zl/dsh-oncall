#!/usr/bin/env node
/**
 * Relay test: `handoff{action:'newSession'}` against the REAL SessionController.
 *
 * Why this suite exists: the headless profile does not mount
 * `@deepseek-ai/dsh-api-session-controller` (that row lives in
 * `dsh-web-app/cordis.patch.yml:121`), so neither `remote.mjs` (headless, in
 * process) nor `run.mjs` (headless, spawned; its stub adapter cannot emit a tool
 * call) can reach the relay. The bug this guards —
 * `TypeError: controller.selectionFor is not a function` — only exists in a
 * composition that mounts that service.
 *
 * It boots the shipped `web` profile in-process, isolated under its own
 * DSH_HOME, inserts the stub adapter and this plugin by overlay, and then walks
 * the relay's own dependencies directly: create a session through the public
 * `create`, find its live agent, select the model, call the tool. No model turn
 * is needed for the relay — the tool's dependencies are the subject.
 *
 * It also covers `delegate`, which had no composition net at all (run.mjs never
 * mentions handoff; a delegate is fire-and-forget, so a headless one-shot
 * scenario could not observe it). Two roster entries are exercised against the
 * same parent: one pinning `provider`/`model`, one leaving them blank. The
 * evidence is each child's own durable log — `subagent/descriptor` (the route
 * DSH resolved for the child) and its first `request/header` (the route it
 * actually sent) — plus its reply. That is what makes "pinned route" and
 * "inherits the parent's current route" assertions rather than claims.
 *
 * Usage: node packages/dsh-model-desk/tests/handoff-relay.mjs
 * Requires `npm run bundle` in the package directory first.
 */

import assert from 'node:assert/strict'
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

// 这条组合在独立进程里加载 `lib/index.js`。
assertFreshBuild()

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PKG = `${ROOT}packages/dsh-model-desk`
const PACKAGE_NAME = JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8')).name
const DSH_INSTALL = `${ROOT}node_modules/@deepseek-ai/dsh/package.json`
const STUB = `${HERE}stub-adapter.mjs`.replaceAll('\\', '/')
const HOME = `${HERE}.dshhome-relay`
// Absolute, so the delegation checks can read a child's durable log without
// depending on the directory `npm test` was started from.
const SESSIONS = `${HERE}.sessions-relay`

const SWITCH_ON = '{ rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: true, invalidRequest: true, auth: true, quota: true, other: true }'

// Same shape `run.mjs` and `remote.mjs` write: disable the real providers, keep
// the jsonl persistence the relay's storage domain needs, pin the default model
// to a stub route, insert the stub adapter and the built plugin.
writeFileSync(`${HERE}handoff-overlay.yml`, `- id: llm-deepseek
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
    - id: model-desk
      name: '${PKG}/lib/index.js'
      config:
        enabled: true
        policyVersion: 2
        chain:
          candidates:
            - { provider: stub-backup, model: stub-model, maxRetries: 0 }
          switchOn: ${SWITCH_ON}
        handoff:
          enabled: true
          roster:
            - id: coder
              name: coder
              role: work
              purpose: 写代码
              instructions: 只改指定文件
              provider: stub-backup
              model: stub-model
            - id: inherit
              name: inherit
              role: work
              purpose: 跟随父会话的模型
              instructions: 什么都不做
`)
// 自己的脚本文件：默认的 `stub-script.json` 被另外两个套件轮流写。
const SCRIPT = `${HERE}stub-script-relay.json`
process.env.STUB_SCRIPT = SCRIPT
writeFileSync(SCRIPT, JSON.stringify({ 'stub-primary': { outcomes: ['ok'] } }, null, 2))

rmSync(HOME, { recursive: true, force: true })
rmSync(SESSIONS, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const profile = loadProfile('router-relay-test', 'web', DSH_INSTALL, undefined, { userLayer: false })
writeFileSync(fileURLToPath(new URL('./cordis.yml', `file:///${profile.dir.replaceAll('\\', '/')}/`)), '[]\n')
const overlays = [loadOverlayPatches('router-relay-test', `${HERE}handoff-overlay.yml`)]
const moduleLayers = [{
  packageName: 'model-desk',
  packageDir: PKG,
  patchPaths: [`${HERE}handoff-overlay.yml`],
  patches: [],
}]
const resolution = await createRuntimeResolution({
  installAnchor: DSH_INSTALL,
  profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
})

/** @type {import('@deepseek-ai/cordis').Context} */
let ctx
try {
  ctx = await boot(
    'router-relay-test',
    fileURLToPath(new URL('./cordis.yml', `file:///${profile.dir.replaceAll('\\', '/')}/`)),
    [...profile.layers.flatMap(layer => layer.patches), ...overlays.flat()],
    async (composing) => {
      // `--no-open`：一个测试不许弹浏览器窗口。`--port 0` 让 OS 挑端口：默认的 3080
      // 会和另一个还活着的 web 实例（或上一次没退干净的测试进程）撞上 EADDRINUSE。
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
} catch (error) {
  console.log(`boot failed: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`    ok  ${label}`)
  else {
    failures += 1
    console.log(`    FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

// ---------- the relay's real dependencies ----------

const controller = ctx.get('sessionController')
const registry = ctx.get('agents')
check('the web composition mounts sessionController', controller !== undefined)
check('the public face is the two methods our face declares',
  typeof controller?.create === 'function' && typeof controller?.selectModel === 'function',
  `create=${typeof controller?.create} selectModel=${typeof controller?.selectModel}`)
// 3.3 的那三个方法在真实服务上不存在：它们住在私有的 ApiSessionAgentController 里。
check('the private controller methods are NOT on the service face',
  ['createSession', 'selectionFor', 'selectForNextRequest'].every(name => typeof controller?.[name] !== 'function'))

const created = await controller.create({ cwd: process.cwd(), reusable: () => false })
check('create answers a session id', typeof created?.sessionId === 'string', JSON.stringify(created))
const agent = registry.get(created.sessionId)
check('the live-agent registry answers for that id', agent !== undefined)
await controller.selectModel({ sessionId: created.sessionId, provider: 'stub-primary', model: 'stub-model' })
check('selectModel accepts the session id and route', true)

// ---------- the tool, end to end ----------

const tool = ctx.get('tools').get('handoff')
check('the handoff tool is registered', tool !== undefined)
let receipt
try {
  receipt = await tool.execute(
    { action: 'newSession', handoffNote: '从接力会话继续' },
    { agent, signal: new AbortController().signal },
  )
} catch (error) {
  check('newSession does not throw', false, `${error?.code ?? ''} ${String(error)}`)
}
if (receipt !== undefined) {
  check('the receipt names the session it created', typeof receipt.newSession === 'string', JSON.stringify(receipt))
  check('it is a different session from the one the relay ran in', receipt.newSession !== created.sessionId)
  const relayed = registry.get(receipt.newSession)
  check('the relayed session has a live agent too', relayed !== undefined)
}

// ---------- delegation: does the roster's route reach the child? ----------
//
// The child is not in `ctx.agents` (that registry holds top-level sessions), so
// the evidence is its own durable log: `subagent/descriptor` records the route
// DSH resolved for the child, and `request/header` records the route it actually
// sent. Both must agree, and they must differ between "roster pins a route" and
// "roster leaves it blank".
const childEvents = (childId) => {
  const entries = readdirSync(SESSIONS, { recursive: true, withFileTypes: true })
  const hit = entries.find(entry => entry.isFile()
    && entry.name.endsWith('.jsonl')
    && entry.parentPath.replaceAll('\\', '/').split('/').includes(childId))
  if (hit === undefined) return undefined
  return readFileSync(`${hit.parentPath}/${hit.name}`, 'utf8')
    .trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
}

/**
 * Wait for the child's request AND its answer; a fire-and-forget delegate needs
 * a poll, and returning on the header alone raced the reply (the two land in
 * separate appends, so `answered` read false on an otherwise healthy child).
 */
const childRoute = async (childId, deadlineMs = 30_000) => {
  const until = Date.now() + deadlineMs
  let snapshot = { sent: undefined, offered: null, answered: false }
  while (Date.now() < until) {
    const events = childEvents(childId)
    const header = events?.find(event => event.type === 'request/header')
    if (header !== undefined) {
      const config = header.data?.header?.config ?? {}
      const descriptor = events.find(event => event.type === 'subagent/descriptor')
      const settled = events.some(event => event.type === 'assistant/message' || event.type === 'turn/end')
      snapshot = {
        sent: `${config.provider}/${config.model}`,
        offered: descriptor === undefined
          ? null
          : `${descriptor.data.agentProvider ?? '-'}/${descriptor.data.agentModel ?? '-'}`,
        answered: events.some(event => event.type === 'assistant/message'),
      }
      if (settled) return snapshot
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return snapshot
}

const delegate = async (rosterId) => {
  try {
    return { receipt: await tool.execute(
      { action: 'delegate', rosterId, task: '读一下仓库根目录，回一句话' },
      { agent, signal: new AbortController().signal },
    ) }
  } catch (error) {
    return { error: `${error?.code ?? ''} ${String(error)}`.trim() }
  }
}

const pinned = await delegate('coder')
check('delegating to a roster entry with a route does not throw', pinned.error === undefined, pinned.error)
check('the receipt names the child session', typeof pinned.receipt?.child === 'string', JSON.stringify(pinned.receipt))
if (typeof pinned.receipt?.child === 'string') {
  const route = await childRoute(pinned.receipt.child)
  check('the child was offered the roster route', route.offered === 'stub-backup/stub-model', JSON.stringify(route))
  check('the child sent its request on the roster route', route.sent === 'stub-backup/stub-model', JSON.stringify(route))
  check('the child produced an answer', route.answered === true, JSON.stringify(route))
}

const inherited = await delegate('inherit')
check('delegating to a roster entry without a route does not throw', inherited.error === undefined, inherited.error)
if (typeof inherited.receipt?.child === 'string') {
  const route = await childRoute(inherited.receipt.child)
  check('a blank roster route inherits the parent route', route.sent === 'stub-primary/stub-model', JSON.stringify(route))
  check('the inheriting child produced an answer', route.answered === true, JSON.stringify(route))
}
check('the two delegations produced two child sessions',
  typeof pinned.receipt?.child === 'string' && typeof inherited.receipt?.child === 'string'
  && pinned.receipt.child !== inherited.receipt.child,
  `${String(pinned.receipt?.child)} vs ${String(inherited.receipt?.child)}`)

if (typeof ctx.dispose === 'function') await ctx.dispose()
console.log(failures === 0 ? `\n0 failure(s)` : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
