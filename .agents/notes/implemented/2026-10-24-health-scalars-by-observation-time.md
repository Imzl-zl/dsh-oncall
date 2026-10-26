# Agent Note: health scalars are picked by the record's observation time, not by session order

Status: implemented

## Problem

The 渠道健康 page kept showing an old measurement after a real conversation:
`本步耗时 4.51s` / `吞吐 48.1t/s` for `wb/cn:deepseek-v4.1-flash`, with no
"could not read" warning, unchanged by a reload. The new observation existed
(13.9 s); the page just never let it win.

The cause was one field answering two questions. `readRecentSessions` sorts
sessions by `SessionSummary.updatedAt` and folds their health records in that
order, and `mergeHealthRecord` gave the scalars to whichever record arrived last
(`Object.assign({}, newer, …)`). But `updatedAt` is
`max(createdAt, lastPromptAt)` (`packages/api/session-controller/src/list.ts:349-351`),
and for a cold session that value comes from the persisted projection cache,
which lags the log (`list.ts:291-312`). Measured on the 43-session isolation home:
15 sessions lagged by more than a minute, one by 13.7 h. So "merged last" meant
"the session someone spoke in most recently according to a stale cache", not
"the session with the newest observation" — a 13 947 ms observation was silently
overwritten by a 4 507 ms one from a session that merely sorted later.

## Decision

`mergeHealthRecord` keeps the timeline as a union (dedupe by `time:status`, sort,
`pruneTimeline`) and picks the scalar set — `status` / `latencyMs` /
`throughputTps` / the error — from the record with the larger own
`lastCheckedAt`. `ChannelHealthRecord.lastCheckedAt` is required (`src/health.ts:84`)
and the Host writes it on every observation (`src/health.ts:245`, `:268`), so the
record carries its own watermark.

Two guards, both deliberate:

1. **Both records must state an observation time.** If either side is missing
   `lastCheckedAt`, the merge falls back to the caller's order — i.e. the old
   behaviour. Unknown is not 0 and is not "newest": a record that does not
   declare when it was observed is not ranking evidence.
2. **`older` / `newer` stay the parameter names but stop being a semantic
   claim.** The previous doc comment asserted "调用方保证 older 来自较旧的会话";
   that assertion is false (it is the bug), so the method doc was rewritten to
   say what the caller's order actually means (`updatedAt` = which session last
   had a human speaking) and to point at `lastCheckedAt` as the only ranking key.

The timeline half of the earlier decision is untouched: availability stays a
global fact folded across sessions, not the winner's private history — see
[2026-10-15-health-monitoring-cross-session-merge](2026-10-15-health-monitoring-cross-session-merge.md).

## Alternatives considered

1. **Sort the sessions by their health record's `lastCheckedAt` inside
   `readRecentSessions`.**
   - Strongest reason: one sort key, one place, and the merge then keeps its
     simple "last one wins" shape — fewer moving parts than comparing per merge.
   - Why rejected: that read is **shared** (the failover drawer calls it too,
     `src/client/controller.ts:908`), so it would make one reading answer two
     questions at once — the same disease moved to a different organ. It also
     does not fix the merge itself, so any other caller folding records in a
     different order hits the bug again.
2. **Whole-record overwrite, last writer wins.**
   - Strongest reason: dead simple, and "the newest observation" trivially
     includes the newest timeline.
   - Why rejected (already, on 2026-10-15): availability would degrade into one
     session's data, and channel health is a global fact — the same route is used
     by this session, that session, and three concurrently.
3. **Leave it; the window fix (the separate 20-session cap defect) will hide it.**
   - Strongest reason: the `.slice(-20)` window is independently wrong and is
     scheduled as its own item, so touching the merge now costs a second pass.
   - Why rejected: the two are independent. Even folding all 43 sessions, the
     merge still hands the scalars to the last record, and the last record is
     still chosen by a lagging key.

## Consequences

- Gains: the health page's measured numbers now come from the newest observation
  regardless of how sessions are ordered. The regression case is an inverted
  input (the fresher observation sits in the session with the smaller
  `updatedAt`), which the old code fails — the pre-existing merge test only fed
  the ascending order, which is why it stayed green through the bug.
- Costs: one property (`lastCheckedAt`) is now read on the client outside the
  host projection's own window logic, and the merge has a two-sided precondition
  (unknown time ⇒ caller order) that a reader must not "simplify" away.
- Bounded: fallback behaviour is exactly the pre-fix behaviour, so a record
  shape that loses the timestamp degrades to the old merge rather than to a new
  failure mode.
- Preserved on purpose: the frozenset of scalar readers did not change —
  `health-ui.ts:123` (page), `format.ts:130`, `workspace.ts:287` still read
  `record.latencyMs` and friends; only who wins the merge moved.
- Out of scope, tracked separately: our self-invented `.slice(-20)` session
  window (`docs/design/native-and-architecture-review.md:141`).
