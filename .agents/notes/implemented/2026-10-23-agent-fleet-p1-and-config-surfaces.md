# Agent Note: Agent Fleet is a native dockkit tab, and the config page keeps two retry entries

Status: implemented

## Problem

The right sidebar had no cross-session fleet view, so "what is running and what
needs me" could only be answered by opening sessions one by one. The design
(`docs/design/agent-fleet-drawer.md`) fixed the carrier (dockkit tab, not a
drawer), the scope (global first, one session drilled in), and the data
semantics (unknown is not zero). The config page mixed output continuation into
the failure-retry section and kept a numeric "max real calls" line that read
like a second budget. The handoff roster was not implemented, so a third tab
would have been an empty shell.

The client module system also handed the local `ROUTER_CSS` array back as one
joined string at runtime, while the imported `FLEET_CSS` stayed an array. A
plain `.join` therefore threw `TypeError: ROUTER_CSS.join is not a function`
during plugin apply, which the boot page reduced to `dsh-models-router: failed`.

## Decision

P1 ships as one dockkit tab (`kind: agent-fleet`) with a global view and a
read-only single-session drill-down. P2 (roster, budgets, handoff receipts) is
not registered until the handoff host exists.

Mechanical thresholds:

1. The type goes through `ctx.sidebarRightTabs.register` and the body through
   `sidebar.right.pane.tab`; no `position: fixed`, portal, mask, self-drawn
   close/fullscreen button, or second tab strip.
2. A missing projection is `undefined`/`—`; a ready empty `subagentCatalog` is
   `0`. Any summary cell with an unknown session in its scope paints `—` and
   names the unknown count.
3. Candidate rows and the first-hop row each own one retry input; the session
   chip keeps its per-route override; there is no `maxTotalAttempts` field and
   no numeric total-call calculation in the UI.
4. Output continuation is its own section, reading
   `DEFAULT_MAX_TOKEN_AUTO_CONTINUE` / `DEFAULT_MAX_TOKEN_CONTINUES`; failure
   retries read `DEFAULT_MAX_RETRIES` / `DEFAULT_FIRST_HOP_MAX_RETRIES`.
5. CSS injection normalizes both the string and array shapes the module system
   can hand over; the local array is not assumed.
6. A `handoff` roster tab is added only after the host has the config schema,
   the four-action tool, and the `router/handoff` projection.

## Alternatives considered

1. Build a fixed right-side drawer with a mask, like the Gemini template.
   - Strongest reason: full control of width, animation, close affordance and
     focus, and it works even where no dockkit seat exists.
   - Why rejected: it violates the hard carrier constraint (H1), duplicates the
     native tab strip and focus handling, and blocks the main column the user
     is still working in. The native tab also gets drag, split, float and
     fullscreen for free.
2. Reuse the experimental `agentTeam` projection and its Lead/teammate UI.
   - Strongest reason: it is native DSH data with a roster, task board and
     teammate navigation already built.
   - Why rejected: its product concept is a Lead with teammates, which the user
     explicitly forbade ("no 主控脑/Leader"); it is an experimental package not
     in the base web profile; and the handoff proposal's roster is a different
     contract (purpose/instructions/preset/failover).
3. Load every session's projections on first paint.
   - Strongest reason: the summary and every row would be complete, with no
     "unknown" count to explain.
   - Why rejected: a session list can hold hundreds of rows (measured: 222 in
     the isolated home), and `refreshProjections` has no cancellation signal.
     The design's recent-20, concurrency-4 budget keeps the first paint finite;
     the data-scope line states what is loaded.
4. Keep output continuation inside the retry section.
   - Strongest reason: one section is fewer sections, and both are "what
     happens when the model stops".
   - Why rejected: `max-tokens` is not a failure and never reaches
     `agent/request-error`; putting its switch next to failure retries makes
     users read it as another retry count. The user asked for a separate
     configuration, and the UI now says so.
5. Keep the numeric "max real calls" summary.
   - Strongest reason: it is transparent arithmetic over the per-route budgets.
   - Why rejected: the user asked to remove the duplicate calculation; it reads
     like a request-wide cap even when labelled read-only, and there is no such
     configuration. A prose note states the per-candidate rule without a number.
6. Keep `.join('\n')` on the CSS arrays.
   - Strongest reason: it is the obvious way to turn a line array into a sheet.
   - Why rejected: measured in the browser, `ROUTER_CSS` is a string after the
     client module system's handling while `FLEET_CSS` remains an array;
     `.join` throws and the whole plugin entry fails. `cssText` accepts both.
7. Ship an empty "委派名册" third tab now.
   - Strongest reason: the three-tab information architecture becomes visible
     immediately and the page does not change shape later.
   - Why rejected: there is no handoff config, tool or ledger; the tab would be
     an empty shell and the user explicitly forbade a fake roster.

## Consequences

- Gains: the right sidebar is a native tab with global/session views, honest
  unknown/empty/error states, compact root-to-direct-children topology, and
  measured widths at 1440 (648), 1024 (344) and 800 (344), plus a 920 reading
  column in fullscreen. The config page has separate output continuation and
  keeps both retry entries.
- Costs: the global list still renders every top-level session (222 in the
  stress home) while only the recent 20 load automatically; chain names are
  read only for the current/drilled session to avoid per-session RPCs; child
  cards have no step/budget/review data because the projections do not exist
  yet; P2 is not delivered. `subagentChatAddress` is mirrored because the
  native helper is not public. The first list pull has an 8s plugin-side timeout
  and treats the public `phase === 'pending'` as "no successful pull", because
  `SessionListState` does not expose the manager's error. A later refresh
  failure keeps the last successful list; `phase` is monotone and the connection
  banner is the only public signal for that case.
