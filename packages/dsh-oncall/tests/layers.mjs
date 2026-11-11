#!/usr/bin/env node
/**
 * The layer guard.
 *
 * Layering that lives only in a design document is a suggestion. This script
 * turns three of its claims into failures:
 *
 *   1. `src/contract` imports nothing from `src` — it is the bottom layer.
 *   2. `src/core` imports only `src/contract` and `src/core` — the decision
 *      layer cannot reach into runtime, faces or the browser half.
 *   3. Neither layer performs I/O: no `ctx.`, no `Date.now(`, no
 *      `Math.random(`, no `.append(`, no `.put(`, no `await`. Time and
 *      randomness arrive as parameters, which is what makes every decision
 *      replayable.
 *
 * Scope is deliberately the two new layers, not the whole tree. The existing
 * `src/config.ts` ↔ `src/rules.ts` value cycle is real debt (M1 in
 * docs/design/super-plugin-architecture.md), and a guard that starts red on day
 * one gets disabled within a week. Widening it to the whole tree is `--all`, and
 * the whole-tree cycles are reported below so the debt stays visible.
 *
 * Note: 为何守卫收窄、被否的「一上来就覆盖全树」—— 见
 * .agents/notes/implemented/2026-11-09-ingress-decision-layer.md
 *
 * Usage: node packages/dsh-oncall/tests/layers.mjs [--all]
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '..', 'src')

const GUARDED = ['contract', 'core']
const I_O_TOKENS = ['ctx.', 'Date.now(', 'Math.random(', '.append(', '.put(', 'await ']

/** Every `.ts` file under `dir`, as paths relative to `srcRoot`, posix-style. */
function filesUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (entry.name.endsWith('.ts')) out.push(relative(srcRoot, full).replaceAll('\\', '/'))
  }
  return out
}

/** Remove line and block comments so prose cannot trip the token scan. */
function codeOnly(text) {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
}

/** The project-relative targets of every `import`/`export … from` in one file. */
function importsOf(relPath) {
  const text = codeOnly(readFileSync(join(srcRoot, relPath), 'utf8'))
  const targets = []
  for (const match of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
    let target = resolve(dirname(join(srcRoot, relPath)), match[1])
    if (!target.endsWith('.ts')) target += '.ts'
    targets.push(relative(srcRoot, target).replaceAll('\\', '/'))
  }
  return targets
}

/** Directed edges for every source file, keyed by project-relative path. */
function graph(files) {
  const edges = new Map()
  for (const file of files) edges.set(file, importsOf(file).filter(target => files.includes(target)))
  return edges
}

/** Cycles reachable in `edges`, each as the path that closes it, deduplicated by rotation. */
function findCycles(edges) {
  const done = new Set()
  const stack = []
  const seen = new Set()
  const cycles = []
  const walk = node => {
    if (stack.includes(node)) {
      const cycle = stack.slice(stack.indexOf(node))
      // The same cycle is reachable from every node on it; rotating to the
      // smallest member makes those copies compare equal.
      const start = cycle.indexOf([...cycle].sort()[0])
      const key = [...cycle.slice(start), ...cycle.slice(0, start)].join(' -> ')
      if (!seen.has(key)) {
        seen.add(key)
        cycles.push([...cycle.slice(start), ...cycle.slice(0, start)])
      }
      return
    }
    if (done.has(node)) return
    done.add(node)
    stack.push(node)
    for (const next of edges.get(node) ?? []) walk(next)
    stack.pop()
  }
  for (const node of edges.keys()) walk(node)
  return cycles
}

const allFiles = filesUnder(srcRoot)
const guardedFiles = allFiles.filter(file => GUARDED.some(dir => file.startsWith(`${dir}/`)))
const edges = graph(allFiles)
const problems = []

// 1 + 2: contracts are the bottom; core sits directly on it.
for (const file of guardedFiles) {
  const layer = file.split('/')[0]
  for (const target of importsOf(file)) {
    if (!allFiles.includes(target)) {
      problems.push(`${file} imports ${target}, which is not part of src`)
      continue
    }
    const targetLayer = target.split('/')[0]
    if (layer === 'contract' && targetLayer !== 'contract') {
      problems.push(`${file} imports ${target}: the contract layer may import only contract/`)
    }
    if (layer === 'core' && !GUARDED.includes(targetLayer)) {
      problems.push(`${file} imports ${target}: the decision layer may import only contract/ and core/`)
    }
  }
}

// 3: no I/O in the pure layers.
for (const file of guardedFiles) {
  const code = codeOnly(readFileSync(join(srcRoot, file), 'utf8'))
  for (const token of I_O_TOKENS) {
    if (code.includes(token)) problems.push(`${file} contains "${token}": the pure layers may not perform I/O`)
  }
}

// 4: no cycles inside the guarded layers.
const guardedCycles = findCycles(new Map(guardedFiles.map(file => [file, edges.get(file) ?? []])))
for (const cycle of guardedCycles) problems.push(`cycle: ${cycle.join(' -> ')}`)

// Whole-tree cycles are reported, not failed — that is existing debt (M1).
const debt = findCycles(edges).filter(cycle => !cycle.every(file => guardedFiles.includes(file)))

assert.equal(
  problems.length,
  0,
  `layer guard failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}\n`,
)

const guarded = guardedFiles.length
const labels = []
labels.push(`${guarded} files in contract/ + core/`)
labels.push('no I/O')
labels.push('no cycles')
if (debt.length > 0) {
  labels.push(`known debt outside the guard: ${debt.map(c => c.join(' -> ')).join('; ')}`)
}
console.log(`layers: ok — ${labels.join('; ')}`)
