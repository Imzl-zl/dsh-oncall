# Agent Note: the client half now has a type-check program, and its first finding was a real bug

Status: implemented

## Problem

DSH's own client packages each carry a tsconfig extending
`tsconfig.base.client.json` (`packages/client/ui-primitives/tsconfig.json`), and
the root `tsconfig.client.json` aggregates the client tests. This package had
none: `tsconfig.json` excludes `src/client` because the Typert host-face program
must not compile browser modules, and nobody added the second project. The
browser half — twenty files, hand-written JavaScript with `.ts` extensions — was
bundled by tsdown without any type-check pass.

The cost showed up on 2026-10-24. `probeAll` called a bare `loadProbeReport()`.
No such binding exists: at runtime the call threw a `ReferenceError` inside the
`.then`, the chained `.catch` swallowed it, and "probe all" therefore never
re-read the Host's last report — the health view kept only the routes that run
had just measured. Nothing failed loudly, and no behavioural test drove that
path.

## Decision

1. **The client gets its own program** (`packages/dsh-models-router/tsconfig.client.json`),
   mirroring DSH's split: DOM libs, `noEmit`, separate from the host-declaration
   project.
2. **Install the three platform packages the browser imports through the shell's
   module table** (`@deepseek-ai/dsh-client-ui-primitives`, `dsh-client-store`,
   `dsh-client-ui-slots`) plus `@types/react`, as devDependencies pinned to the
   runtime version. They carry only declarations — the install added 5 packages,
   no nested `zod`, no `react` runtime — and the shipped bundle still externalizes
   them by name.
3. **`noImplicitAny` stays off as a ratchet.** With it on the program reports 473
   implicit-any sites (every handler parameter in a JS-authored component) and
   buries the ~98 findings that are real shape errors.
4. **Wire it into `bundle` only once it exits 0 — done the same day.** The 98 findings
   were cleared first (annotation debt, not signals of broken behaviour), then `bundle`
   became `tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown`. A check that
   fails is a check nobody reads; a check the build runs cannot be skipped.
5. **The published snapshot is a type, and the page renders from it.** Clearing the
   findings left the seam that matters most still `any`: `project()` had no return type,
   so the shape the controller publishes and the shape the page reads could drift without
   a word. `RouterSnapshot` now names it, with `ui: Omit<RouterUi, 'chainId'>` so the field
   list exists once (the controller mutates `chainId`, the page reads the derived
   `draft.chain`), and `page.ts` types the value it gets from the store. Reading a field
   that is no longer published is a compile error — measured: asking for `state.ui.chainId`
   there fails with `Property 'chainId' does not exist on type 'Omit<RouterUi, "chainId">'`.
   The roster page's props became an interface in the same spirit, with `onEntry`'s field
   name typed `keyof RosterEntry`, so a mistyped field name stops compiling instead of
   writing nothing; that immediately turned two null-dereference sites inside closures into
   a parameter (`rosterEditor(entry: RosterEntry)`) and collapsed a duplicated `findIndex`.

## Alternatives considered

1. Turn the check on `strict` and annotate everything first.
   - Strongest reason: one standard, nothing to remember, exactly what DSH's own
     packages do.
   - Why rejected: 473 + 98 findings across twenty files is a multi-hour
     refactor of a half with thin behavioural coverage; the value (catching new
     defects) is available today with the narrower setting, and the ratchet can
     be tightened file by file.
2. Write local `declare module` shims for the platform modules instead of
   installing them.
   - Strongest reason: no second copy of anything, no install cost.
   - Why rejected: the shims would be hand-written lies about DSH's own
     signatures, and the packages are published at the exact runtime version
     (`0.2.1-rc.2`); types never execute.
3. A committed baseline plus a script that fails only on *new* errors.
   - Strongest reason: the whole program could run strict from day one and still
     catch regressions.
   - Why rejected: ~50 lines of machinery and a baseline keyed on messages
     rather than lines, for a debt that annotations remove outright — "no detour"
     was the explicit instruction.
4. Leave it as it was.
   - Strongest reason: the bundle builds and the behavioural suites pass.
   - Why rejected: measured — the missing check is exactly what let a swallowed
     `ReferenceError` live in the probe path.

## Consequences

- Gains: the browser half has a type program that already found one runtime bug; DSH's
  real platform signatures are available for the annotations; the build now runs it, so a
  shape error cannot ship behind a green `bundle`.
- Costs: four devDependencies that exist only for declarations; a ratchet that must be
  tightened deliberately (below).
- Ratchet: `noImplicitAny` stays **false**, deliberately. Turning it on today reports 473
  implicit-any sites — every unannotated handler parameter in a JS-authored component —
  and burying the ~0 shape findings that remain is exactly how a check stops being read.
  Tighten it **per file, not globally**: a file that has been annotated (or rewritten in
  typed style) moves into a second include list compiled with `noImplicitAny: true`,
  starting with the pure modules (`validate.ts`, `format.ts`, `naming.ts`,
  `fleet/model.ts`), where a parameter's type is a fact rather than ceremony. Precondition
  for flipping a file: it is clean at the current setting and its DOM handlers already
  read `currentTarget` with a typed event — otherwise the flip only relabels debt.
- Measured: 98 findings before (36 TS2339, 27 TS18046, 12 TS2345, 11 TS2769, 9 TS2322,
  1 TS18047, 1 TS2305, 1 TS2353), **0 after**, `bundle` exit 0 with both programs; the
  regression test (`client-controller.mjs`, "a manual full probe re-reads the Host report
  afterwards") fails when the fix is reverted and passes with it.
- Found while clearing the debt, and fixed in the same pass once the type said so: DSH's
  `Tag` has no `title` prop (`packages/client/ui-primitives/src/Tag.tsx:34-41` destructures
  only `tone`/`className`/`children` and spreads nothing), so two health-page tooltips had
  never rendered — the dead props and their now-unused dictionary key are gone; and the
  roster editor's `Input` handlers read a React event as a value (`Input` spreads its props
  onto the native `<input>`, `ui-primitives/src/Input.tsx:14-23`), which the browser showed
  as `"[object Object]"` in every text field and a silently dead number field.
- One cast, deliberate: `fleet/view.ts` wraps DSH's `Tooltip` in a local `tooltip()` helper.
  `Tooltip` takes its anchor as a required `children` prop, `createElement` typing wants a
  required prop in the props argument, and `AnchorProps` is a weak type (all members
  optional) — so the anchor goes in as that prop, with a single cast at that boundary. The
  alternative (annotating `h` in `dom.ts`) would have loosened every call site in the half
  to fix one component's shape. The test harness's `createElement` stub had to learn the
  same rule React has (a `children` prop is a child when no positional child is passed), so
  the tree the tests walk is the tree JSX would build — the fix went into the stub, not into
  the production call site.
- Two `unknown`s in `controller.ts` (`ui.catalog`, `ui.updateResult`) turned out to be
  placeholders: the Host faces already return `ModelCatalog` (`dsh-api-remotes/client`) and
  `UpdateCheck` (`../types.ts`), so the bag names them.
- Measured boundary, so the next session does not re-learn it: the drawer's two payload
  columns stay `unknown` (`HistoryRead`), because importing their real types —
  `ChannelHealthRecord` (`health.ts:76`), `FailoverEntry` (`lineage.ts:29`) — is not a
  type-only decision. Those modules import the **host** session entries, and pulling them
  into this program replaces the browser's `Context.sessions` merge with the host face:
  `refreshProjections` / `refresh` / `subagentAddress` disappear and the fleet code stops
  compiling (three errors, 2026-10-24). The envelope is typed; the columns are documented
  where they are folded and reach the drawer through `any` props.
