/**
 * The handoff contract both halves of the plugin read.
 *
 * Three facts have two readers each and must exist once:
 * - the projection key and the tool name — the host registers and folds them
 *   (`handoff.ts`), the browser reads the projection by the same key
 *   (`client/fleet/model.ts`);
 * - the record shape — the fold writes it, the fleet activity stream paints it;
 * - the counter fold and the "carried budget" addition (`handoffCounters`,
 *   `addCarried`, `reviewRosterIds`) — the gate reads them host-side and the
 *   fleet tab paints "已用 / 上限" browser-side. A second copy of that arithmetic
 *   would let the two halves disagree about how much budget is spent, which is
 *   exactly the number the gate refuses on.
 *
 * `handoff.ts` cannot be that source for the browser: it imports zod,
 * `storage-domain` and `dsh-llm`, so a constant imported from there would inline
 * a second schema runtime into the client bundle (the 445 kB budget in
 * `.agents/notes/implemented/2026-10-24-runtime-alignment-021.md`). Hence this
 * dependency-free module: plain data in, plain data out, one expression each.
 */

/** The session projection key. Namespaced like the plugin's other unit. */
export const HANDOFF_KEY = 'oncall/handoff'

/** The tool name: the fold, the description and the registration read it. */
export const HANDOFF_TOOL = 'handoff'

/** One receipt-shaped fact the fold saw. Counters are `records` filtered by epoch. */
export interface HandoffRecord {
  at: number
  /** The budget epoch this record belongs to (a human message opens a new one). */
  epoch: number
  /** The turn the call happened in, for `maxDelegationsPerTurn`. */
  turn?: number
  kind: 'delegate' | 'finish' | 'newSession' | 'facts'
  rosterId?: string
  outcome?: string
}

/** The slice of the projection state the counters read. */
export interface HandoffCountable {
  /** Increments on every human `user/message`. Counters are per-epoch. */
  readonly epoch: number
  /** The open turn, from `step/start`; absent before the first step. */
  readonly openTurn?: number
  /** Newest last, bounded by the fold. */
  readonly records: readonly HandoffRecord[]
}

/** What the gates — and the fleet tab — read off the projection. */
export interface HandoffCounters {
  epoch: number
  /** Delegations inside the open turn, for `maxDelegationsPerTurn`. */
  turnDelegations: number
  delegations: number
  reviews: number
  newSessions: number
  perRole: Record<string, number>
}

/** The budget a `newSession` carried into this session (the ledger's numbers). */
export interface CarriedCounts {
  readonly delegations: number
  readonly reviews: number
  readonly newSessions: number
  readonly perRole: Readonly<Record<string, number>>
}

/**
 * Count this epoch's receipts.
 *
 * `reviewRosterIds` comes from the config, not from the log: the log records
 * *which* role was called, and whether that role is a reviewer is a property of
 * the roster — reading it here keeps the fold free of config.
 */
export function handoffCounters(
  state: HandoffCountable | undefined,
  reviewRosterIds: ReadonlySet<string>,
): HandoffCounters {
  const counters: HandoffCounters = {
    epoch: 0,
    turnDelegations: 0,
    delegations: 0,
    reviews: 0,
    newSessions: 0,
    perRole: {},
  }
  if (state === undefined) return counters
  counters.epoch = state.epoch
  for (const record of state.records) {
    if (record.epoch !== state.epoch) continue
    if (record.kind === 'newSession') counters.newSessions += 1
    if (record.kind !== 'delegate') continue
    counters.delegations += 1
    if (record.turn !== undefined && record.turn === state.openTurn) counters.turnDelegations += 1
    const id = record.rosterId ?? ''
    counters.perRole[id] = (counters.perRole[id] ?? 0) + 1
    if (reviewRosterIds.has(id)) counters.reviews += 1
  }
  return counters
}

/** The roster's review roles, as the counter needs them. */
export function reviewRosterIds(config: {
  readonly roster: readonly { readonly id: string; readonly role: string }[]
}): Set<string> {
  return new Set(config.roster.filter(entry => entry.role === 'review').map(entry => entry.id))
}

/**
 * Projection counts plus what a relay carried in.
 *
 * The one "已用" both halves read: the gate refuses on this sum, and the fleet
 * tab paints it. Keeping the addition here is what stops the UI from reporting
 * 0/8 for a session that inherited 8/8 and can therefore not delegate at all.
 */
export function addCarried(
  counters: HandoffCounters,
  carried: CarriedCounts | undefined,
): { delegations: number; reviews: number; newSessions: number; perRole: Record<string, number> } {
  const perRole: Record<string, number> = { ...counters.perRole }
  for (const [role, count] of Object.entries(carried?.perRole ?? {})) {
    perRole[role] = (perRole[role] ?? 0) + count
  }
  return {
    delegations: counters.delegations + (carried?.delegations ?? 0),
    reviews: counters.reviews + (carried?.reviews ?? 0),
    newSessions: counters.newSessions + (carried?.newSessions ?? 0),
    perRole,
  }
}
