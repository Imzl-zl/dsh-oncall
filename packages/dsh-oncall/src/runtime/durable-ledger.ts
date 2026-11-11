/**
 * The ledger that survives a restart.
 *
 * ### Shape
 *
 * Three tables behind DSH's `ctx.storageDomain`, the sidecar the host sanctions for
 * durable host state that must not enter the session log (the same choice
 * `src/bindings.ts` makes for routing bindings):
 *
 * - `progress` — one row per source: cursor, last error, last poll time.
 * - `cases` — one row per Case, keyed by id.
 * - `audit` — append-only, keyed by a random id so two records written in the same
 *   millisecond cannot overwrite each other.
 *
 * ### Why the caller must await `ready`
 *
 * The interface is synchronous for reads, because the pass reads progress before
 * every poll and the routing path has the same constraint. Opening is asynchronous,
 * so reads answer "nothing" until the domain is open. For routing bindings that is
 * harmless (the default chain is a fine answer); here it is not — "no progress"
 * means "poll from the beginning", and "no cases" means "open every Case again".
 * So the loop waits for `ready` before its first pass, and refuses to run at all
 * when the domain did not open.
 *
 * Note: 为何游标与 Case 同一次提交、为何无存储时拒绝启动 —— 见 docs/design/super-plugin.md 7.4。
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AuditEvent, CaseId, CaseRecord, ClosedReason, SourceId, ThreadKey, TriggerKey } from '../contract/types.ts'
import { NO_PROGRESS, type Commit, type Ledger, type Progress } from './ledger.ts'

/** The one domain the ingress declares. Lowercase letters, digits and `_` only. */
export const INGRESS_DOMAIN = 'oncall_ingress'

const progressSchema = z.object({
  cursor: z.string().nullable(),
  lastError: z.string().nullable(),
  lastPolledAt: z.number().nullable(),
})

const actorSchema = z.object({
  source: z.string(),
  id: z.string(),
  handle: z.string(),
  kind: z.enum(['human', 'bot', 'system']),
})

const caseSchema = z.object({
  id: z.string(),
  mandate: z.object({
    strength: z.enum(['explicit', 'inferred']),
    actor: actorSchema,
    scope: z.array(z.string()),
    policyVersion: z.number(),
  }),
  origin: z.string(),
  brief: z.string(),
  openedAt: z.number(),
  closed: z.object({ reason: z.enum(['completed', 'merged', 'stopped', 'failed', 'dropped']), at: z.number() }).nullable(),
})

const auditSchema = z.object({
  kind: z.enum(['case.opened', 'case.observed', 'trigger.refused', 'poll.failed']),
  at: z.number(),
  caseId: z.string().optional(),
  trigger: z.string().optional(),
  strength: z.enum(['explicit', 'inferred']).optional(),
  brief: z.string().optional(),
  reason: z.string().optional(),
  source: z.string().optional(),
  message: z.string().optional(),
})

type StoredCase = z.infer<typeof caseSchema>
type StoredAudit = z.infer<typeof auditSchema>

/** The three tables this ledger uses, as the storage domain exposes them. */
export interface IngressTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
}

interface OpenDomain {
  table(name: string): IngressTable<unknown>
  close(): Promise<void>
}

/** The slice of `ctx` this module uses; narrow so a test can stand in for it. */
export interface IngressStorageContext {
  get(name: string): unknown
  logger: { error(message: string): void }
  effect(execute: () => () => void, label?: string): void
}

/**
 * Mint a branded id from a stored string.
 *
 * Brands are erased at runtime, so the value read from the table *is* the id it was
 * written as; the schema above already proved the shape. This function is the single
 * place that says so, rather than scattering `as` through every reader.
 */
const asCaseId = (value: string): CaseId => value as CaseId
const asTriggerKey = (value: string): TriggerKey => value as TriggerKey
const asSourceId = (value: string): SourceId => value as SourceId

/** The durable ledger; `ready` resolves once the domain is open or has failed. */
export class DurableLedger implements Ledger {
  readonly ready: Promise<void>
  // Declared explicitly rather than as a parameter property: the headless
  // composition loads this file from source through Node's strip-only type removal,
  // which rejects parameter properties outright (same reason `index.ts` does it).
  private readonly ctx: IngressStorageContext
  private progressTable: IngressTable<Progress> | undefined
  private caseTable: IngressTable<StoredCase> | undefined
  private auditTable: IngressTable<StoredAudit> | undefined
  private closed = false

  constructor(ctx: IngressStorageContext) {
    this.ctx = ctx
    this.ready = this.open()
  }

  /** Whether a write survives a restart. False = the ingress must not run. */
  get persistent(): boolean {
    return this.caseTable !== undefined && !this.closed
  }

  readProgress(sourceId: SourceId): Progress {
    return this.progressTable?.get(sourceId) ?? NO_PROGRESS
  }

  hasCase(id: CaseId): boolean {
    return this.caseTable?.get(id) !== undefined
  }

  async commit(batch: Commit): Promise<void> {
    await this.ready
    const { progressTable, caseTable, auditTable } = this
    if (progressTable === undefined || caseTable === undefined || auditTable === undefined || this.closed) {
      throw new Error('oncall: the ingress storage domain is not open; refusing to lose the pass')
    }
    await progressTable.put(batch.sourceId, batch.progress)
    for (const record of batch.cases) await caseTable.put(record.id, toStoredCase(record))
    for (const event of batch.audit) await auditTable.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  /** Every Case, for the panel. Ordered by open time, oldest first. */
  cases(): readonly CaseRecord[] {
    if (this.caseTable === undefined) return []
    return [...this.caseTable.entries()]
      .map(([, stored]) => fromStoredCase(stored))
      .sort((left, right) => left.openedAt - right.openedAt)
  }

  private async open(): Promise<void> {
    const facility = this.ctx.get('storageDomain') as { open(spec: unknown): Promise<OpenDomain> } | undefined
    if (facility === undefined) {
      this.ctx.logger.error('oncall: no storageDomain in this composition; the ingress stays off')
      return
    }
    try {
      const domain = await facility.open(ingressDomain)
      this.progressTable = domain.table('progress') as IngressTable<Progress>
      this.caseTable = domain.table('cases') as IngressTable<StoredCase>
      this.auditTable = domain.table('audit') as IngressTable<StoredAudit>
      this.ctx.effect(() => () => { this.closed = true; void domain.close() }, 'oncall ingress domain')
    } catch (error) {
      this.ctx.logger.error(`oncall: opening the ingress storage domain failed: ${String(error)}`)
    }
  }
}

/** The domain declaration handed to `ctx.storageDomain.open`. */
export const ingressDomain = defineDomain({
  name: INGRESS_DOMAIN,
  version: 1,
  tables: {
    progress: domainTable(progressSchema),
    cases: domainTable(caseSchema),
    audit: domainTable(auditSchema),
  },
})

function toStoredCase(record: CaseRecord): StoredCase {
  return {
    id: record.id,
    mandate: {
      strength: record.mandate.strength,
      actor: record.mandate.actor,
      scope: [...record.mandate.scope],
      policyVersion: record.mandate.policyVersion,
    },
    origin: record.origin,
    brief: record.brief,
    openedAt: record.openedAt,
    closed: record.closed === null ? null : { reason: record.closed.reason, at: record.closed.at },
  }
}

function fromStoredCase(stored: StoredCase): CaseRecord {
  return {
    id: asCaseId(stored.id),
    mandate: {
      strength: stored.mandate.strength,
      actor: { ...stored.mandate.actor, source: asSourceId(stored.mandate.actor.source) },
      scope: stored.mandate.scope.map(value => value as ThreadKey),
      policyVersion: stored.mandate.policyVersion,
    },
    origin: asTriggerKey(stored.origin),
    brief: stored.brief,
    openedAt: stored.openedAt,
    closed: stored.closed === null ? null : { reason: stored.closed.reason as ClosedReason, at: stored.closed.at },
  }
}

/**
 * Flatten one audit event into the stored row.
 *
 * The union is stored flat because a key-value table has no variant type; the
 * discriminator is `kind`, and every reader switches on it. Keeping the optional
 * fields explicit here is what stops a `case.observed` row from carrying a `caseId`
 * nobody set.
 */
function toStoredAudit(event: AuditEvent): StoredAudit {
  switch (event.kind) {
    case 'case.opened':
      return { kind: event.kind, at: event.at, caseId: event.caseId, trigger: event.trigger, strength: event.strength }
    case 'case.observed':
      return { kind: event.kind, at: event.at, trigger: event.trigger, brief: event.brief }
    case 'trigger.refused':
      return { kind: event.kind, at: event.at, trigger: event.trigger, reason: event.reason }
    case 'poll.failed':
      return { kind: event.kind, at: event.at, source: event.source, message: event.message }
  }
}
