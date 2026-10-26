# Agent Note: the delegation roster is one tool, one projection and one ledger — and the budget has to survive a new session

Status: implemented

## Problem

The handoff proposal (docs/design/handoff-proposal.md) described the roster, the
four actions and the gates, but three of its mechanics could not be built as
written once the real 0.2.1-rc.2 host was in front of us:

1. A budget that resets on "a human message" has to be *replayable*. The
   proposal's "the plugin holds the ids of the messages it injected" is process
   memory; a session projection folds durable events only.
2. A rejected `delegate` must not spend budget, and the only durable signal that
   distinguishes a rejection from a success is `tool/result.isError`.
3. `newSession` carries the counters into the new session, but a projection is
   per session and cannot be seeded from another session's state.

The config section, the roster page and the runtime alignment had to land in the
same batch: the third tab must not exist before the host section does (F-09).

## Decision

1. **The plugin's own messages carry their own source kind.**
   `model-desk-handoff` (role `user`, form `notice`) marks a briefing or a
   nudge. The fold resets the budget epoch only on `source.kind === 'user'`, so a
   human speaking resets it and the relay's own first message does not. The
   alternative — an in-memory id set — cannot survive replay, and would have reset
   exactly the budget the relay had just copied.
2. **Refusals throw `HarnessError`.** The durable `tool/result` then carries
   `isError`, which is what the fold reads to skip the record; the model still
   reads the same Chinese sentence in the tool result. Returning
   `{rejected: true}` would have made a refused `delegate` indistinguishable from
   a successful one at fold time, silently charging the budget.
3. **The reviewer's verdict shape belongs to the plugin, not the roster.**
   `role: review` entries get a fixed `outputSchema` (`pass` / `gaps` +
   `gaps[]`). A gate has to read the verdict; a user-defined shape would force the
   plugin to guess which field means "passed", which is the content judgement A1
   forbids. `roster[].outputSchema` therefore does not exist (F-16).
4. **The ledger owns what the projection cannot.** One `storageDomain`
   (`model_router_handoff`) with two tables: `reviews` (a verdict written when the
   activation settles) and `budgets` (the counters a `newSession` carried). Gates
   read `projection counts + carried counts`. Without storage the same reads hit
   process memory and the session gets one visible notice the first time a review
   lands — not at enable time, when the user may never delegate.
5. **The review epoch is the dispatch epoch.** A human who speaks while a
   reviewer runs makes that review stale: it never saw the new instruction. A
   settlement-time epoch would have accepted an outdated verdict.
6. **Registration waits for the services.** The plugin's `inject` is `['llm']`,
   so at construction time `tools`/`subagents` are not mounted (measured: the
   headless composition registered no tool). `ctx.inject(['tools','subagents'], …)`
   registers into a child fiber that dies with this one.
7. **One save path.** The roster page mutates the same draft as the chain and
   health sections and rides the same `scope.mutate` with one extra
   `{ op: 'set', path: ['handoff'], value }`. `validate()` calls the shared
   `structuralViolations`, so the browser and the host cannot disagree about what
   a bad roster is.
8. **The goal is rebuilt before the briefing.** §4.6 step 6 says a failed
   `keepGoal` writes the objective into the briefing, but the briefing is step 5
   and is sent once — a `goals.create` that ran afterwards had nowhere to put the
   objective unless the configured briefing already listed `goal`. `relay` now
   calls `rebuildGoal` before composing the message and passes the goal to the
   briefing when the rebuild failed; the old goal is still retired after it.
   Found by the runtime test that pinned the fallback.
9. **The budget the UI paints is the budget the gate refuses on.** "已用" is
   `handoffCounters` (projection) plus `addCarried` (the ledger's carried
   counts), and both live in the dependency-free `handoff-wire.ts` so the gate
   and the fleet tab evaluate one expression. Only the half the projection
   cannot know — what a relay carried — crosses the Remote
   (`deskHealth.handoffCarried`, one read per session, cached); a read that is
   refused leaves the cache empty and the block hidden, because "unknown" must
   not paint as `0 / 8`. The limits come from the browser's own
   `normalizeHandoff`, the same values the roster page shows.

## Alternatives considered

1. Keep `source.kind: 'user'` for the briefing and record injected ids in the
   projection state.
   - Strongest reason: §4.6 says "an ordinary user message", and a distinct kind
     is a visible deviation.
   - Why rejected: the projection is a pure fold over events; ids minted by this
     process are not in the log. The message role stays `user`, so the model's
     behaviour is unchanged, and the first line still says the plugin wrote it.
2. Count `tool/call` alone and accept that a refused delegation spends budget.
   - Strongest reason: it is one event, no pairing, no pending queue in the fold.
   - Why rejected: the budgets are the only thing keeping "delegate until it
     works" from being free; a refused call that costs a slot teaches the model
     to retry less, not to delegate better.
3. Let the roster carry a free-form `outputSchema` and search the result for a
   `verdict`-ish field.
   - Strongest reason: the proposal's §5 sketch shows one, and a user might want
     a richer verdict.
   - Why rejected: that search is content judgement by another name. A fixed
     shape with a `gaps[]` array is expressive enough for the gate and honest
     about who owns the contract.
4. Put the carried counters in the new session's first user message and let the
   projection read them back.
   - Strongest reason: no second table; the log is the only source.
   - Why rejected: the fold would have to parse its own briefing text, and a
     model could edit that text in its own message history. The ledger already
     exists for verdicts; a second table costs one `put`.
5. Gate on "the last review is passing" without an epoch, and trust the model to
   re-review after a human speaks.
   - Strongest reason: simpler, no epoch plumbing.
   - Why rejected: §4.4 asks for "after the most recent user message", and
     trusting the model to notice is exactly the judgement the plugin must not
     make. Fail closed.

## Consequences

- Gains: budgets are replayable and survive a Host restart; a refused call costs
  nothing; the relay cannot launder a budget by opening a session; the reviewer's
  verdict is machine-readable without reading prose; the roster page cannot save
  a config the host would reject, because both read `rules.ts`.
- Costs: one extra durable table; the fold keeps a `pending` list so a call's
  action can be paired with its result; the plugin owns a message source kind
  that other consumers will render as a notice row (F-14); `newSession` needs
  `sessionController`, which the headless composition does not mount, so the
  six-step relay is covered by unit tests against fake faces rather than by an
  end-to-end scenario — the composition proves registration and the refusal
  paths, not the happy path.
- Measured (2026-10-24, second round): `npm test` 233 unit / 118
  client-controller / 25 remote / 35 scenarios 0 failure; specified `tsc` exit 0;
  `node --check lib/client.js` exit 0; browser at 1440/1025/801/1920 with a
  12-role roster, empty state, validation rejection, a save round-trip verified
  on disk, the activity stream reading "connected but empty", and the three
  budgets painting 0/8 · 0/1 · 0/2 (`docs/assets/ui/roster-p2-*.png`,
  `fleet-p2-*.png`).
