# Agent Note: pinning the DSH peers as exact devDependencies creates the second instance; it does not avoid it

Status: implemented

## Problem

The dev workspace installs the plugin package on its own (`npm install --prefix
packages/dsh-models-router`); the root is not an npm workspace, so npm has no
tree to hoist into. `packages/dsh-models-router/.npmrc` therefore sets
`legacy-peer-deps=true`: the plugin declares its DSH peers but installs none of
them, and every `@deepseek-ai/dsh-*` import resolves upward to the root's single
copy — the same instances the Host runs.

That leaves a standing question the P2 handoff recorded as gap 4: is the
`.npmrc` still needed if the plugin pins its peers as **exact** devDependencies?
The appeal is real — versions become visible in one package.json, and a
standalone `npm install` in the package directory no longer depends on reading
the root's lockfile. The risk is the one the 0.2.1-rc.2 alignment already paid
for: two instances of `zod` (and of every DSH package) in one process.

## Decision

Keep `legacy-peer-deps=true` and keep the DSH packages out of
`devDependencies`. Pinning them exactly is what *creates* the second copy, not
what prevents it.

Measured in a temporary tree that mirrors this repo (`%TEMP%\dsh-peer-exact-24`:
a root with `@deepseek-ai/dsh` 0.2.1-rc.2 + `zod` 4.4.3, a `packages/plugin`
with the same manifest plus the nine peers pinned exactly as devDependencies):

- installing the plugin directory added **25** packages, including
  `packages/plugin/node_modules/@deepseek-ai/dsh-llm@0.2.1-rc.2` and
  `packages/plugin/node_modules/zod@4.4.3`, while the Host keeps its own copies
  at the root. `require.resolve` from each side returns different paths for the
  same version — two module instances.
- adding `.npmrc` with `legacy-peer-deps=true` to that same pinned manifest
  still installed **15** packages, including all six DSH packages and `zod`:
  the flag only suppresses *auto-installed peers*, never a declared
  devDependency.
- making the temp root a real npm workspace (`workspaces: ["packages/*"]`) and
  keeping the same exact devDependencies produced **zero** nested directories:
  npm hoisted everything next to the Host's identical versions, one `dsh-llm`,
  one `zod`.

So the only variant that keeps a single instance is the workspace one, and that
is a change to the dev workspace's shape, not a package.json edit. It is not
done here (see the third alternative).

## Alternatives considered

1. Pin the peers as exact devDependencies and drop the `.npmrc`.
   - Strongest reason: the versions become explicit in the package that uses
     them, and a fresh `npm install` inside the package directory no longer
     depends on the root's lockfile being the source of truth.
   - Why rejected: measured — the install nests a second copy of every DSH
     package and of `zod`. The plugin's `HarnessError`, `createUserMessage`,
     `defineDomain` and schema objects would then come from a different module
     graph than the Host's, which is the exact class-identity and schema-identity
     failure the 0.2.1-rc.2 alignment fixed by pinning one zod.
2. Keep the peers in devDependencies and trust `legacy-peer-deps` to suppress
   them.
   - Strongest reason: one `.npmrc`, one manifest, no tree change.
   - Why rejected: measured — declared devDependencies are installed regardless
     of the flag (15 packages, all six DSH packages plus zod, nested). The flag
     is not a filter for this.
3. Make the repo a real npm workspace and pin the peers exactly.
   - Strongest reason: it is the only measured variant with a single copy
     (hoisted to the root), and it would remove the `.npmrc` entirely.
   - Why not now: the root becomes the install root, the lockfile moves, and
     `npm install --prefix packages/dsh-models-router` starts resolving the
     workspace root instead of the package — a dev-workspace restructure that
     needs its own verification round. The constraint costs nothing today.
4. Move the DSH packages into `dependencies` of the published package.
   - Strongest reason: the published artifact would carry everything it imports
     and could be installed anywhere.
   - Why rejected: a consumer would get a second copy of the Host's own classes
     and a second `zod`; the plugin must be a guest in the Host's module graph,
     which is what a bundle patch already is.

## Consequences

- Gains: one copy of every DSH package and of `zod`; the plugin is type-checked
  and executed against the same instances the Host uses; the published package
  is unaffected either way, because npm never installs a dependency's
  devDependencies.
- Costs: the root must always install `@deepseek-ai/dsh` at the Host's exact
  version; a bare checkout without the root install cannot resolve the plugin's
  imports (correct for a bundle patch, surprising for a first-time contributor);
  the `.npmrc` is a repo-level fact that a reader has to find before touching
  dependency versions.
- Measured: `%TEMP%\dsh-peer-exact-24` (nested: 25 packages; `dsh-llm`
  0.2.1-rc.2 and `zod` 4.4.3 resolvable twice) and `%TEMP%\dsh-peer-ws-24`
  (workspace: 0 nested packages; one `dsh-llm`, one `zod`).
