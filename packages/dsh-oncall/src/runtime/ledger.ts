/**
 * The ledger port: the only place the ingress stores anything.
 *
 * ### Why one `commit` instead of separate writes
 *
 * The read position and the Case it produced must land together. If the poll's
 * cursor advanced while the Case write failed, the work is lost silently — the
 * next poll starts after an event nobody handled. Bundling them into one call makes
 * that failure mode unrepresentable rather than merely discouraged, and
 * `dsh-superagent` reaches the same conclusion with a SQLite savepoint
 * (`src/app/store.ts`: `atomic()`).
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
 */

import type { AuditEvent, CaseId, CaseRecord, SourceId } from '../contract/types.ts'
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
  readonly audit: readonly AuditEvent[]
}

export interface Ledger {
  readProgress(sourceId: SourceId): Progress
  /** Whether this Case already exists — the dedupe that makes repeats harmless. */
  hasCase(id: CaseId): boolean
  commit(batch: Commit): Promise<void>
}

/** The initial state of a source nobody has polled yet. */
export const NO_PROGRESS: Progress = { cursor: null, lastError: null, lastPolledAt: null }

/** Everything a test (or a storage-less composition) needs, in memory. */
export interface MemoryLedger extends Ledger {
  readonly cases: readonly CaseRecord[]
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
  const audit: AuditEvent[] = []

  return {
    get cases() { return [...cases.values()] },
    get audit() { return [...audit] },

    readProgress(sourceId) { return progress.get(sourceId) ?? NO_PROGRESS },

    hasCase(id) { return cases.has(id) },

    async commit(batch) {
      progress.set(batch.sourceId, batch.progress)
      for (const record of batch.cases) cases.set(record.id, record)
      audit.push(...batch.audit)
    },

    progressOf(sourceId) { return progress.get(sourceId) ?? NO_PROGRESS },
  }
}
