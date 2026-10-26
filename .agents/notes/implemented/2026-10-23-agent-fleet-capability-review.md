# Agent Note: the fleet stopped hand-drawing what DSH already ships, and stops scheduling when it is off screen

Status: implemented

## Problem

The P1 fleet was honest about its data but not about its means: it drew its own
group fold button, kept long titles in native `title` attributes that keyboard
users never see, and had no way to stop reading when the tab went off screen.
The design page (`docs/design/agent-fleet-drawer.md` §7.4) also asks for an
activity edge — one slow pulse on the running root and a 1.8s flow dot — that
P1 had left out because the chip topology has no edges.

Before changing anything, every "DSH has this" claim in the design was checked
against the read-only checkout, because a design assumption is not an API. The
per-item verdict is recorded in `docs/design/agent-fleet-next-session-brief.md`
§3/§4; this note keeps the choices that were not mechanical.

## Decision

1. **Group folding and long labels use the public primitives.** `GroupList`
   renders DSH's `DisclosureRow` (its 24px row, chevron cross-fade, Enter/Space
   and `aria-expanded`), wrapped in a 2px-padded, sticky header for the 28px
   design tier. Session rows, agent cards, the topology root and the pending
   queue wrap their one focusable button in DSH's `Tooltip` and drop that
   button's native `title`; spans, the `h2` and other non-tab-stop metadata keep
   `title`, because a hover-only affordance is not an accessibility fix.
2. **Visibility owns scheduling.** The fleet controller grew `pause()` and
   `resume()`. `useFleet` takes the tab's own `visible` and pauses on hide and
   on unmount; while paused nothing new is dispatched and no listener is
   called, so a read that settles late cannot repaint a hidden body. `resume()`
   repaints once and continues the queue.
3. **The 8s liveness guard speaks the locale.** Its message reads
   `fleetListTimeout` and fills the seconds from `REFRESH_TIMEOUT_MS`, so the
   number has one source. The `phase === 'pending'` rule for "no successful
   pull" stays as it was, now with the exact `file:line` in the comment.
4. **Two animations, both optional.** The root keeps its 2.4s pulse; the first
   running child gets a 4px dot dripping 1.8s down its chip stem, on a shared
   rail (`::before` line over the row, a stem per chip, one stem from the
   root). Hiding the tab pauses both via `animation-play-state`;
   `prefers-reduced-motion: reduce` removes both. The chip's status dot no
   longer pulses — that would have been the third animation.
5. **The narrow row keeps its title.** Below the 430px container breakpoint the
   title keeps 72px, the route key ellipses first (42% cap), the two-glyph
   state word never truncates, and the header's `flex-wrap` is scoped to
   `.dsh-fleet-session-head` so it can no longer widen a list row.

Code entry points: `client/fleet/controller.ts` (`pause`/`resume`,
`REFRESH_TIMEOUT_MS`), `client/fleet/useFleet.ts` (visibility effect, the F-07
comment), `client/fleet/index.ts` (`tab.visible`), `client/fleet/view.ts`
(`Tooltip`/`DisclosureRow`, `dsh-fleet-chip-flow`, `dsh-fleet-topo-rail`),
`client/fleet/styles.ts` (the two `@keyframes`, pause and reduced-motion
selectors).

## Alternatives considered

1. Give every running child its own flow dot (or a long edge per child).
   - Strongest reason: it shows exactly which child is working, and the
     prototype's single dot is itself a simplification of that idea.
   - Why rejected: §7.4 caps one view at two continuous animations; eight
     running children would be eight dots plus the root pulse, and the card
     grid's height is driven by chips. One dot reads as "there is activity";
     the per-chip `is-active` border and the status text carry "which one".
2. Cancel the in-flight `refreshProjections` when the tab closes.
   - Strongest reason: stopping the read is strictly better than letting a
     result land that nobody will see, and it is what "close cancels" sounds
     like.
   - Why rejected: `refreshProjections(sessionId): Promise<void>` has no
     `AbortSignal`
     (`api/session-controller/src/client/contract/sessions.ts:101-106`), and
     `retain({ signal })` only cancels waiting for an open, not a dispatched
     projection read (`:36-39`, `sessions/service.ts:285-292`). Promising a
     cancellation that cannot happen would be a lying comment, so the code says
     "stop scheduling" and nothing more.
3. Keep the hand-drawn group button and just make it prettier.
   - Strongest reason: it is already a real `<button>` with `aria-expanded`,
     so the accessibility story is not broken and a rewrite risks a visual
     regression.
   - Why rejected: the chevron cross-fade, the 24px rhythm and the disclosure
     keyboard contract already exist in `ui-primitives`, and two fold controls
     in one product drift. The measured cost is 2px of wrapper padding plus the
     title tier (see F-11 in the drawer page).
4. Put the task text in a second `Tooltip` on a wrapper instead of the button.
   - Strongest reason: keeps one tooltip per element and avoids nesting.
   - Why rejected: the card's only tab stop is the button; wrapping a `div`
     would be a hover-only affordance. DSH's nested-tooltip suppression
     (`Tooltip.tsx:20`, `:96-98`, `:225-226`) already makes the task bubble
     withdraw the name bubble, so nesting is the supported shape.
5. Load the whole list eagerly on mount so `visible` never matters.
   - Strongest reason: the first pull would never race the visibility flag.
   - Why rejected: the tab body mounts and unmounts with the pane, and a hidden
     body that still pulls is exactly the RPC pattern §6.2 rules out. The pull
     now waits for `visible` and runs once per mount.
6. Import `ui-subagent/src/*` to reuse `subagentChatAddress`, or adopt the
   experimental `agentTeam` roster for the "agents" page.
   - Strongest reason: both are native code, so they would stay in sync with
     DSH without a local mirror; `agentTeam` even ships a roster UI.
   - Why rejected: importing the chat UI source inlines the whole subagent
     surface into this package instead of resolving it through the module
     loader, and `agentTeam`'s Lead/teammate model is the product concept the
     user forbade. The 6-line `subagentChatAddress` mirror stays, pinned by the
     native fixture in `tests/unit.mjs`.

## Consequences

- Gains: one fold control and one hover/focus surface come from `ui-primitives`
  instead of this package; keyboard users can reach the full session title and
  the agent name/task; a hidden tab stops dispatching projection reads and
  stops repainting; the topology finally expresses "there is activity" the way
  §7.4 asks, within the two-animation budget.
- Costs: the group header is 2px taller than a bare `DisclosureRow` (24 + 2 + 2
  = 28px) and its title tier only holds because the injected sheet wins by
  specificity — `.dsh-fleet-group-disclosure .dsh-fleet-group-title` has two
  classes against the module's one (F-11). The flow dot is decoration derived
  from `state === 'running'`, so it says nothing about progress. `pause()`
  cannot stop a Host read that is already in flight; a late result is folded in
  on `resume()`, which means the view can jump once after the tab comes back.
  `refreshProjections` still has no cancellation, so a fast hide/show cycle can
  still overlap one read with the next. The narrow-tier row budget is now
  explicit CSS (72px title, 42% route key) and needs the same care if the
  status word ever becomes longer than two glyphs.
- Measured in the browser (`docs/assets/ui/fleet-cap-*.png`, isolated home with
  22 real sessions): 1440 right column 648; 1025 with the left rail 569 (the
  461 figure in the design table is the first-open 45% ratio, and the layout
  remembers a pixel width); 801 → 345; fullscreen column 920. `DisclosureRow`
  header measures 28px with an 11.5/16 title, `dsh-fleet-pulse` 2.4s and
  `dsh-fleet-flow` 1.8s, both `paused` under `data-visible="false"` and
  `none` under reduced motion. The npm `@deepseek-ai/dsh 0.2.0-rc.2` host
  refuses logs written by the desktop `0.2.1-rc.2` runtime
  (`job/registered` is "unknown to this harness"), so the fixture was served by
  the desktop runtime — not a plugin behaviour and reproduced with the plugin
  disabled.
