/**
 * Guard: the built-artifact suites must run against a bundle newer than `src/`.
 *
 * `npm test` does not build, and `lib/` is not tracked. Three suites
 * (`client-controller`, `remote`, `run`) and the relay suite load the built
 * plugin, so whatever was last bundled is what they test — a stale `lib/` makes
 * a green run prove nothing about the source in the working tree. The project
 * has been bitten by this ordering twice; the assertion is mtime, which is a
 * cheap proxy, not a hash. `unit.mjs` reads `src/` directly and does not need it.
 *
 * The failure text names the command, because the point is to make "forgot to
 * rebuild" loud rather than to guess what changed.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))

/** Newest (or oldest) mtime among the files under one directory tree. */
function boundary(dir, pick) {
  let at
  for (const name of readdirSync(dir, { recursive: true })) {
    let info
    try {
      info = statSync(join(dir, String(name)))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    at = at === undefined ? info.mtimeMs : (pick === 'newest' ? Math.max(at, info.mtimeMs) : Math.min(at, info.mtimeMs))
  }
  return at
}

/** Throw unless `lib/` is at least as new as the newest file under `src/`. */
export function assertFreshBuild() {
  const lib = boundary(join(PKG, 'lib'), 'oldest')
  if (lib === undefined) {
    throw new Error('lib/ is missing: run `npm run bundle` in packages/dsh-oncall (this suite loads the built plugin)')
  }
  const src = boundary(join(PKG, 'src'), 'newest')
  if (src !== undefined && src > lib) {
    const seconds = ((src - lib) / 1000).toFixed(1)
    throw new Error(
      `src/ is ${seconds}s newer than the oldest file in lib/: run \`npm run bundle\` before this suite — `
      + 'it loads lib/index.js, so a stale bundle would be tested instead of the working tree',
    )
  }
}
