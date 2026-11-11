#!/usr/bin/env node
/**
 * Measures the four runtime facts the V0 executor depends on, in an isolated
 * process: its own DSH_HOME, its own working directory, and a real provider turn.
 *
 * The four facts (docs/design/oncall-v0-architecture.md 第六节):
 *   1. `agent/status` publishes running → idle around a turn;
 *   2. `freezeMessage` accepts a MessageId we chose, and it reaches the log;
 *   3. `resolveAgent` answers `session/not-found` for an unknown id, and a fresh
 *      process resumes the same session from persistence;
 *   4. `sessionPersistence.flush/open/read` works in the `web` composition.
 *
 * Two child runs: phase A creates + runs a real turn, phase B resumes in a new
 * process. Both must pass; a failure changes the design, not the assertion.
 *
 * Usage: node packages/dsh-oncall/tests/executor-probe.mjs
 * Needs tests/probe-provider.local.json (gitignored): { baseURL, apiKey, model }
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..')
const HOME = join(here, '.dshhome-probe')
const WORK = join(here, '.probe-work')
const OUT_A = join(here, '.probe-a.json')
const OUT_B = join(here, '.probe-b.json')
const OVERLAY = join(here, 'probe-overlay.yml')
const SESSIONS = join(here, '.sessions-probe')
const DSH_BIN = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

let provider
try {
  provider = JSON.parse(readFileSync(join(here, 'probe-provider.local.json'), 'utf8'))
} catch {
  console.error('missing tests/probe-provider.local.json (gitignored) — { baseURL, apiKey, model }')
  process.exit(2)
}
if (!provider.baseURL || !provider.apiKey || !provider.model) {
  console.error('tests/probe-provider.local.json needs baseURL, apiKey and model')
  process.exit(2)
}

// Fresh directories under new names; nothing is deleted, so a stale probe never
// looks like a fresh one.
for (const dir of [HOME, WORK, SESSIONS]) mkdirSync(dir, { recursive: true })
for (const file of [OUT_A, OUT_B]) if (existsSync(file)) writeFileSync(file, '{}')

const forward = path => path.replaceAll('\\', '/')
// Unique per run: `create({sessionId})` only reuses a session that is still blank, so a
// fixed id makes the *second* run of this probe fail at fact 3 with a `session-<uuid>`
// instead of the id we chose. The home directory is reused on purpose (the run is
// cheap); the id is not.
const sessionId = `oncall-probe-${Date.now().toString(36)}`

// The provider is declared here rather than in a committed fixture: the key comes
// from the caller's environment, never from a file in the repository.
writeFileSync(OVERLAY, `- id: llm-deepseek
  disabled: true

- id: llm-deepseek-account
  disabled: true

- id: session-persistence-jsonl
  config:
    root: '${forward(SESSIONS)}'
    compression: none

- id: agent-default-model
  config:
    provider: probe
    model: '${provider.model}'

- id: llm-pi-ai
  config:
    providers:
      probe:
        apiKeyEnv: PROBE_KEY
        displayName: 'Probe MaaS'
        api: 'openai-completions'
        baseURL: '${provider.baseURL}'
        models:
          - { id: '${provider.model}', name: '${provider.model}', contextWindow: 32768, maxTokens: 4096 }

- insert:
    - id: oncall-probe
      name: '${forward(join(here, 'probe-plugin.mjs'))}'
`)

const run = (phase, out) => {
  console.log(`\n=== phase ${phase} ===`)
  const result = spawnSync(process.execPath, [
    DSH_BIN, '--profile', 'web', '--patch', OVERLAY, '--no-open', '--port', '0',
  ], {
    cwd: WORK,
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...process.env,
      DSH_HOME: HOME,
      PROBE_OUT: out,
      PROBE_PHASE: phase,
      PROBE_SESSION: sessionId,
      PROBE_WORK: WORK,
      PROBE_PROVIDER: 'probe',
      PROBE_MODEL: provider.model,
      PROBE_KEY: provider.apiKey,
      PI_OFFLINE: '1',
      // The probe must not inherit the caller's model routing.
      PI_PROVIDER: '', PI_MODEL: '',
    },
  })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (stdout) console.log(stdout.split('\n').slice(0, 12).join('\n'))
  if (stderr) console.log(stderr.split('\n').slice(0, 20).join('\n'))
  let parsed
  try {
    parsed = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    console.error(`phase ${phase} wrote no result (exit ${result.status})`)
    return { checks: [{ name: `phase ${phase} produced a result`, ok: false, detail: `exit ${result.status}` }] }
  }
  return parsed
}

const report = []
for (const [phase, out] of [['A', OUT_A], ['B', OUT_B]]) {
  const result = run(phase, out)
  for (const item of result.checks ?? []) {
    const mark = item.ok ? 'ok  ' : 'FAIL'
    console.log(`  ${mark} ${item.name}${item.ok ? '' : ` — ${String(item.detail ?? '')}`}`)
  }
  if (result.statuses) console.log(`  statuses: ${result.statuses.join(' → ')}`)
  if (result.turnEndReasons) console.log(`  turn/end: ${result.turnEndReasons.join(', ')}`)
  report.push(...(result.checks ?? []))
}

const failed = report.filter(item => !item.ok)
console.log(`\n${report.length} checks, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
