# Agent Note: the health and failover views fold DSH's whole session list, not our own last-20 window

Status: implemented

## Problem

Both cross-session views read the same thing: one `session.list`, then one
`session.projections({ sessionId })` round-trip per session, over a window we
invented — sort the rows by `updatedAt`, keep the last 20.

That window was wrong in a way the merge fix alone could not hide. `updatedAt`
is `max(createdAt, lastPromptAt)`
(`packages/api/session-controller/src/list.ts:349-351`), and for a cold session
it comes from the persisted projection cache (`list.ts:291-312`), which lags the
log by up to 13.7 h on this machine. Measured on the 43-session isolation home:
15 sessions lagged by more than a minute. So the window's membership was chosen
by a stale key, and the newest observation of a route could sit in a session the
window dropped entirely. Folding 43 sessions would not have fixed that either —
the cap, not the ordering, decided who was visible.

The window was also not DSH's idea. `session.list` already returns **every**
visible session, ordered by `updatedAt` descending, with each row carrying its
projection block inline (`SessionSummary.projections`,
`packages/api/session-controller/src/types.ts:178-191`; `hintsOf` copies the
wire values out unchanged, `list.ts:321-329`). We had the values in hand and then
asked for them again, up to 43 times, under a cap DSH does not have.

## Decision

1. **One read, one fold.** `readSessionBlocks(session)` calls `session.list({})`
   once and maps each row's inline `projections.values` to the two keys it cares
   about (`router/channel-health`, `router/failover-history`). No per-session
   RPC, no `updatedAt` sort, no `.slice(-20)`.
2. **Health folds every session by observation time.** Ordering no longer
   matters at all: `mergeHealthRecord` picks scalars by the record's own
   `lastCheckedAt` (see
   [2026-10-24-health-scalars-by-observation-time](2026-10-24-health-scalars-by-observation-time.md)),
   so the fold is order-independent by construction.
3. **The failover dialog gets its own window, on the entry's own `time`.**
   `foldFailoverRows` drops entries older than 24 h (wall clock, `Date.now()` at
   read time), drops rows left empty, drops entries with no numeric `time`
   (unknown is not 0), and orders rows by their newest surviving entry. The 24 h
   number is the same one the health timeline retains
   (`src/timeline.ts`'s `TIMELINE_RETENTION_SECONDS`), but the anchor is
   deliberately different — see below. The dialog's hint text says both bounds
   now: "最近 24 小时内、每个会话最近 20 条".
4. **The per-session "could not read" surface is gone, because the failure it
   reported is gone.** With one list call there is either a whole list or no
   list; `healthHistoryPartial` / `failoverHistoryPartial`, `ui.drawerPartial`
   and the now-unused `partialWarning` helper were removed with it.

## Alternatives considered

1. **Keep the RPC read, just choose the window by each session's inline
   `lastCheckedAt`.** (The plan's option B.)
   - Strongest reason: smallest diff; the drawer keeps its current shape and no
     wording changes.
   - Why rejected: it reads the same projection data twice — once to pick the
     window, once to get the values — and creates a second expression of "which
     observations matter" beside the merge rule. It also leaves the 20-member cap
     in place, so a home with more sessions still hides history.
2. **Do nothing; the merge fix (item 1) already picks the newest observation.**
   - Strongest reason: after item 1 the scalars are correct for every session the
     window happens to include, and the page looked right on the real home.
   - Why rejected: it is right only while the newest observation's session is
     inside the window. The window's membership test is the lagging key itself, so
     the newest observation is exactly the one at risk of being excluded. Also,
     measured: 43 sessions cost 43 sequential projection RPCs for data already in
     the list payload.
3. **Keep a "N of M sessions could not be read" line by inventing a signal.**
   - Strongest reason: that line caught a real regression once (a `.catch` folding
     a refusal into "no history"), and losing a warning feels like losing safety.
   - Why rejected: the signal no longer exists to report. DSH's listing omits the
     whole `projections` column when its cache read throws
     (`list.ts:306-311`), so a row without a block is indistinguishable from a
     session that never used the router — reusing the warning would require
     inventing a distinction. The remaining real refusal (the list itself) is
     still reported wholesale, and the test for it is unchanged.

## Consequences

- Gains: the health page sees observations from every session, so "newest
  observation wins" is now true over the whole home instead of over a stale-keyed
  sample; the steady-state cost drops from N+1 RPCs to 1; two views still share
  exactly one read.
- Costs a documented blind spot: if DSH's persisted projection cache fails for one
  session, that row arrives block-less and we render it as "never observed". The
  previous code would have shown "1 of N sessions could not be read". We chose the
  silent-but-honest-per-row reading over a fabricated failure; the Host logs the
  cache failure itself (`list.ts:307-309`).
- Costs a semantics change the user can see: a failover older than 24 h no longer
  appears in the dialog. The window is wall-clock anchored on purpose — the
  dialog's title is "最近故障转移历史", so a three-day-old switch is not recent,
  whereas the health timeline keeps a *newest-observation* anchor because a cold
  session is folded after the fact and a wall-clock retention would throw its
  whole history away.
- Cost the `total` counter: with no per-session failures there is nothing to count
  against; `drawerPartial` and both partial locale strings were deleted rather
  than left permanently null.
- Preserved: the drawer still shows each session's ledger bounded by the Host's
  own `MAX_ENTRIES` (20 per session), and health still dedupes the timeline union
  by `time:status` before pruning.
- Out of scope, still tracked in the review doc: the channel card's own
  "本步耗时" versus the `近 4h 暂无观测` line — that pairing stays, because the
  window statement is about the drawn bars, not about the scalar.
