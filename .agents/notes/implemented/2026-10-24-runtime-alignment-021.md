# Agent Note: aligning to 0.2.1-rc.2 cost four small fixes, and none of them was "the new version does not work"

Status: implemented

## Problem

The dev workspace pinned `@deepseek-ai/dsh` 0.2.0-rc.2 while the desktop product
ships 0.2.1-rc.2, and the old host refuses to parse logs the new runtime writes
(`job/registered` is "unknown to this harness", reproduced with the plugin
disabled). Moving the pin surfaced four differences that had nothing to do with
the plugin's own behaviour:

1. Every 0.2.1-rc.2 package pins `zod` **exactly** (`4.4.3`); 0.2.0-rc.2 used the
   range `^4.4.3`. An out-of-tree install therefore got two zod instances (root
   4.6.7, nested 4.4.3), and `domainTable(bindingSchema)` in `bindings.ts` blew
   the checker's instantiation budget (`TS2589`, and an OOM at the default heap).
2. The typert generator now injects the zod runtime into the generated remote
   metadata factories (`@deepseek-ai/dsh-typert-generator`, commit
   `bd91a4a570`). `client/apply.ts` imports `dsh-models-router/remote`, so the
   browser bundle inlined a whole zod (562 kB → 874 kB).
3. `TypertGateway.invoke` now requires `request.peer` (`assertPeerLive` reads
   `peer.signal`); the remote suite's calls had none and threw.
4. `SessionBindings.persistent` answered `false` when the first Remote read beat
   the storage-domain open, reporting a durable binding as memory-only.

## Decision

1. **One zod, pinned where the host pins it.** Root devDependency `zod: 4.4.3`
   (exact), plugin peer `^4.4.3`, and `packages/dsh-models-router/.npmrc` with
   `legacy-peer-deps=true` so this package's peers resolve from the root
   workspace. Without the `.npmrc`, npm auto-installs peers here and picks the
   highest matching prerelease — `0.2.1-rc.3`, the `next` tag — plus a second zod
   under it. The plugin must be type-checked against the same zod instance the
   host validates with; an assertion at the call site would hide that.
2. **`zod` joins the client module table.** DSH's shell seeds it
   (`packages/client/web/src/platform.ts:12`), so `tsdown.config.ts` keeps it a
   `require` instead of inlining a second copy. 874 kB → 445 kB.
3. **The remote tests build a real owner Peer**, the way DSH's own gateway specs
   do (`new Peer(ctx.root, { principal: { kind: 'owner' } })`), rather than
   fabricating a `{ signal }` object.
4. **`SessionBindings.ready()` and an await in `sessionBinding`.** The routing
   path keeps its synchronous read; only the Remote that *reports* durability
   waits for the open to settle.

**Superseded in part (2026-10-24)**: the root pin moved to `0.2.1-rc.3` (the
checkout's version, npm's `next`) and the peer ranges with it — see
[2026-10-24-runtime-alignment-rc3](2026-10-24-runtime-alignment-rc3.md). That note
also replaces the reason stated under alternative 3 below ("the product follows
`latest`"): the workspace now follows the checkout, and rc.3 is reached by an
exact pin rather than by the peer range's highest match. The other four decisions
above (exact zod, zod in the client module table, a real owner Peer, `ready()` +
the await) are unchanged.

## Alternatives considered

1. Silence the type error with `domainTable<string, SessionBinding>(schema)`.
   - Strongest reason: one line, no dependency changes.
   - Why rejected: the two zod instances remain, so the next `defineDomain` call
     hits the same wall, and the dev environment keeps drifting from the host's.
2. Keep inlining zod in the client bundle.
   - Strongest reason: the bundle becomes self-contained; no assumption about the
     shell's module table.
   - Why rejected: DSH's own client packages externalize it, and a second zod in
     the browser is a second schema runtime for no benefit. The table row exists;
     using it is the faithful replication.
3. Follow `next` (0.2.1-rc.3) because npm offered it for the peer range.
   - Strongest reason: `^0.2.1-rc.2` matches it, so it is "allowed".
   - Why rejected: the product follows `latest`; a dev install on rc.3 would test
     against a runtime no user runs. The pin is exact at the root and the
     `.npmrc` keeps this package on it.
4. Roll the upgrade back and keep 0.2.0-rc.2.
   - Strongest reason: it was green before.
   - Why rejected: the acceptance environment (the desktop) is 0.2.1-rc.2, and the
     old host cannot even read its logs. "Green on a runtime nobody ships" is not
     a baseline.

## Consequences

- Gains: `npm test`, the local browser run and the desktop all speak 0.2.1-rc.2;
  one zod instance in the type graph; the client bundle is smaller than before the
  upgrade (445 kB vs 562 kB); `persistent` is no longer a race.
- Costs: the root `zod` is pinned to an exact patch (a DSH bump means bumping it
  here too), and `legacy-peer-deps` means this package never gets its own copy of
  a peer — the root workspace must install `@deepseek-ai/dsh` at the host's exact
  version, which is what its `devDependencies` already does.
- Measured: bundle host 202.60 kB / client 444.92 kB; `npm test` 220 / 116 / 24 /
  35 scenarios 0 failure; specified `tsc` exit 0; `node --check lib/client.js`
  exit 0; the npm host reads the isolated home's sessions with no
  `gateway/internal` in its log.
