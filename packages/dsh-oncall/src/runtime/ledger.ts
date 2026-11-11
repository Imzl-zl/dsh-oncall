/**
 * The ledger port: the only place the plugin stores anything.
 *
 * ### Why one `commit` instead of separate writes
 *
 * The read position and the Case it produced must land together. If the poll's
 * cursor advanced while the Case write failed, the work is lost silently — the
 * next poll starts after an event nobody handled. The thread subscription rides in
 * the same commit for the same reason: a Case nobody can address is worse than no
 * Case. Bundling them into one call makes that failure mode unrepresentable rather
 * than merely discouraged, and `dsh-superagent` reaches the same conclusion with a
 * SQLite savepoint (`src/app/store.ts`: `atomic()`).
 *
 * ### Why the port is named operations, not raw tables
 *
 * Three writers share this ledger (`pass`, `executor`, `outbox`) and each owns one
 * set of facts (`docs/design/oncall-v0-architecture.md` §二之一). A generic
 * `put(table, key, value)` would let any of them write any row; the named methods
 * below make "the executor cannot open a Case" a property of the type rather than
 * a convention. `closeCase` exists for the one fact the executor does own on the
 * `cases` row: the Case's end.
 *
 * ### Why this is a port and not the store
 *
 * Two implementations already exist by necessity: the in-memory one below (every
 * test, and any composition without `ctx.storageDomain`) and the durable one built
 * on DSH's storage domain. The in-memory one is not a mock — it is a supported
 * deployment, and the panel is told which one is in use (`docs/design/bindings.ts`
 * documents the same choice for routing bindings).
 *
 * Note: 为何游标与 Case 必须同一次提交 —— 见 docs/design/super-plugin.md 7.4。
 * Note: 为何关 Case 是一个命名操作（而不是让 executor 写 cases 表）——
 * 见 docs/design/oncall-v0-architecture.md 二之一「一个事实一个写者」。
 */

import type {
  AuditEvent,
  CaseId,
  CaseRecord,
  ClosedReason,
  ReplyRecord,
  SourceId,
  StepRecord,
  ThreadKey,
  ThreadRecord,
} from '../contract/types.ts'
import type { Cursor } from '../sources/source.ts'

/** A source's durable read position, plus how its last read went. */
export interface Progress {
  readonly cursor: Cursor | null
  /** The last transport failure, cleared by the next successful poll. */
  readonly lastError: string | null
  readonly lastPolledAt: number | null
}

/** Everything one source's poll produced, written in one step. */
export interface Commit {
  readonly sourceId: SourceId
  readonly progress: Progress
  readonly cases: readonly CaseRecord[]
  readonly threads: readonly ThreadRecord[]
  readonly audit: readonly AuditEvent[]
}

export interface Ledger {
  readProgress(sourceId: SourceId): Progress
  /** One Case's record, or `undefined` when the id is unknown. */
  caseOf(id: CaseId): CaseRecord | undefined
  /** One thread's subscriptions, or `undefined` when no Case was ever opened on it. */
  threadOf(key: ThreadKey): ThreadRecord | undefined
  /** Every Case, oldest first — the executor's startup scan. */
  allCases(): readonly CaseRecord[]
  /** One Case's steps, oldest first. */
  stepsOf(caseId: CaseId): readonly StepRecord[]
  /** The receipt owed for one step, if one was queued. */
  replyOf(caseId: CaseId, seq: number): ReplyRecord | undefined
  /** Receipts still owed, for the outbox's restart scan. */
  pendingReplies(): readonly ReplyRecord[]
  commit(batch: Commit): Promise<void>
  /** The executor's writes: a step and the audit facts that explain it. */
  writeSteps(records: readonly StepRecord[], audit?: readonly AuditEvent[]): Promise<void>
  /** The outbox's write: one receipt, plus its audit fact. */
  writeReply(record: ReplyRecord, audit?: readonly AuditEvent[]): Promise<void>
  /**
   * The facts the executor writes on a `cases` row.
   *
   * Closing is a read-modify-write so no caller has to hold the whole record; an
   * unknown id throws, because "closed a Case that does not exist" is a bug in the
   * caller, not a fact to absorb. `reopenCase` is the resume path: a message on a
   * thread whose Case ended (anything but `stopped`) brings that Case back to
   * `closed: null` — the subscription never went away, so neither may the Case.
   */
  closeCase(id: CaseId, reason: ClosedReason, at: number, audit?: readonly AuditEvent[]): Promise<void>
  reopenCase(id: CaseId, audit?: readonly AuditEvent[]): Promise<void>
  /** Append audit facts on their own, for a writer with nothing else to record. */
  record(events: readonly AuditEvent[]): Promise<void>
}

/** The initial state of a source nobody has polled yet. */
export const NO_PROGRESS: Progress = { cursor: null, lastError: null, lastPolledAt: null }

/** The key both child tables use: one step (and its receipt) per `caseId#seq`. */
const sequenceKey = (caseId: CaseId, seq: number): string => `${caseId}#${seq}`

/** Everything a test (or a storage-less composition) needs, in memory. */
export interface MemoryLedger extends Ledger {
  readonly cases: readonly CaseRecord[]
  readonly threads: readonly ThreadRecord[]
  readonly audit: readonly AuditEvent[]
  progressOf(sourceId: SourceId): Progress
}

/**
 * A ledger that keeps everything for the life of the process.
 *
 * `commit` appends rather than replaces, so calling it twice with the same batch
 * produces two audit copies but still one Case — the `hasCase` check upstream is
 * what prevents that, and this implementation deliberately does not hide a double
 * commit behind silent dedupe.
 */
export function memoryLedger(): MemoryLedger {
  const progress = new Map<string, Progress>()
  const cases = new Map<string, CaseRecord>()
  const threads = new Map<string, ThreadRecord>()
  const steps = new Map<string, StepRecord>()
  const replies = new Map<string, ReplyRecord>()
  const audit: AuditEvent[] = []
  const appendAudit = (events: readonly AuditEvent[] | undefined): void => { if (events !== undefined) audit.push(...events) }

  return {
    get cases() { return [...cases.values()].sort((left, right) => left.openedAt - right.openedAt) },
    get threads() { return [...threads.values()] },
    get audit() { return [...audit] },

    readProgress(sourceId) { return progress.get(sourceId) ?? NO_PROGRESS },

    caseOf(id) { return cases.get(id) },

    threadOf(key) { return threads.get(key) },

    allCases() { return [...cases.values()].sort((left, right) => left.openedAt - right.openedAt) },

    stepsOf(caseId) {
      return [...steps.values()]
        .filter(step => step.caseId === caseId)
        .sort((left, right) => left.seq - right.seq)
    },

    replyOf(caseId, seq) { return replies.get(sequenceKey(caseId, seq)) },

    pendingReplies() { return [...replies.values()].filter(reply => reply.state === 'pending') },

    async commit(batch) {
      progress.set(batch.sourceId, batch.progress)
      for (const record of batch.cases) cases.set(record.id, record)
      for (const record of batch.threads) threads.set(record.key, record)
      audit.push(...batch.audit)
    },

    async writeSteps(records, events) {
      for (const record of records) steps.set(sequenceKey(record.caseId, record.seq), record)
      appendAudit(events)
    },

    async writeReply(record, events) {
      replies.set(sequenceKey(record.caseId, record.seq), record)
      appendAudit(events)
    },

    async closeCase(id, reason, at, events) {
      const existing = cases.get(id)
      if (existing === undefined) throw new Error(`oncall: refusing to close ${id}: no such Case`)
      cases.set(id, { ...existing, closed: { reason, at } })
      appendAudit(events)
    },

    async reopenCase(id, events) {
      const existing = cases.get(id)
      if (existing === undefined) throw new Error(`oncall: refusing to reopen ${id}: no such Case`)
      cases.set(id, { ...existing, closed: null })
      appendAudit(events)
    },

    async record(events) { appendAudit(events) },

    progressOf(sourceId) { return progress.get(sourceId) ?? NO_PROGRESS },
  }
}
