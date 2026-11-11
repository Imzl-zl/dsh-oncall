/**
 * The ledger that survives a restart.
 *
 * ### Shape
 *
 * Six tables behind DSH's `ctx.storageDomain`, the sidecar the host sanctions for
 * durable host state that must not enter the session log (the same choice
 * `src/bindings.ts` makes for routing bindings):
 *
 * - `progress` — one row per source: cursor, last error, last poll time.
 * - `cases` — one row per Case, keyed by id.
 * - `threads` — one row per external conversation, keyed by `ThreadKey`: which
 *   Cases its messages belong to.
 * - `steps` — one row per assignment, keyed by `caseId#seq`.
 * - `replies` — one row per receipt owed, keyed by `caseId#seq`.
 * - `audit` — append-only, keyed by a random id so two records written in the same
 *   millisecond cannot overwrite each other.
 *
 * The domain stays at **version 1** when tables are added. `parse()` treats a table
 * with no stored rows as empty, so an existing deployment gains the new tables by
 * reading them as empty; bumping the version instead would answer
 * `version-mismatch` and take a working ingress down (`oncall-v0-architecture.md`
 * §三).
 *
 * ### Why the caller must await `ready`
 *
 * The interface is synchronous for reads, because the pass reads progress before
 * every poll and the executor reads steps on every turn end. Opening is
 * asynchronous, so reads answer "nothing" until the domain is open. For routing
 * bindings that is harmless (the default chain is a fine answer); here it is not —
 * "no progress" means "poll from the beginning", and "no cases" means "open every
 * Case again". So the loop waits for `ready` before its first pass, and refuses to
 * run at all when the domain did not open.
 *
 * Note: 为何游标与 Case 同一次提交、为何无存储时拒绝启动 —— 见 docs/design/super-plugin.md 7.4。
 * Note: 为何加表不升域版本 —— 见 docs/design/oncall-v0-architecture.md 三节。
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  AuditEvent,
  CaseId,
  CaseRecord,
  ClosedReason,
  InputRecord,
  ReplyRecord,
  SourceId,
  StepRecord,
  StampedReport,
  ThreadKey,
  ThreadRecord,
  TriggerKey,
} from '../contract/types.ts'
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

const inputSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  trigger: z.string(),
  text: z.string(),
  at: z.number(),
  deliveredAt: z.number().nullable(),
})

const threadSchema = z.object({
  key: z.string(),
  subscriptions: z.array(z.string()),
  lastAt: z.number(),
})

const reportSchema = z.object({
  state: z.enum(['progress', 'ready', 'blocked', 'failed', 'waiting', 'dropped']),
  summary: z.string(),
  question: z.string().optional(),
  code: z.string().optional(),
  at: z.number(),
})

const stepSchema = z.object({
  caseId: z.string(),
  seq: z.number(),
  state: z.enum(['running', 'ended']),
  brief: z.string(),
  report: reportSchema.nullable(),
  at: z.number(),
  endedAt: z.number().optional(),
})

const replySchema = z.object({
  caseId: z.string(),
  seq: z.number(),
  intent: z.enum(['result', 'attention', 'failed']),
  text: z.string(),
  state: z.enum(['pending', 'sent', 'gone', 'failed']),
  at: z.number(),
})

const auditSchema = z.object({
  kind: z.enum([
    'case.opened',
    'case.observed',
    'case.followed-up',
    'step.settled',
    'step.interrupted',
    'reply.settled',
    'trigger.refused',
    'poll.failed',
  ]),
  at: z.number(),
  caseId: z.string().optional(),
  trigger: z.string().optional(),
  strength: z.enum(['explicit', 'inferred']).optional(),
  brief: z.string().optional(),
  reason: z.string().optional(),
  source: z.string().optional(),
  message: z.string().optional(),
  seq: z.number().optional(),
  state: z.string().optional(),
  code: z.string().optional(),
  intent: z.string().optional(),
})

type StoredCase = z.infer<typeof caseSchema>
type StoredThread = z.infer<typeof threadSchema>
type StoredInput = z.infer<typeof inputSchema>
type StoredStep = z.infer<typeof stepSchema>
type StoredReply = z.infer<typeof replySchema>
type StoredAudit = z.infer<typeof auditSchema>

/** The tables this ledger uses, as the storage domain exposes them. */
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
const asThreadKey = (value: string): ThreadKey => value as ThreadKey

/** The key both child tables use: one step (and its receipt) per `caseId#seq`. */
const sequenceKey = (caseId: CaseId, seq: number): string => `${caseId}#${seq}`

/** The durable ledger; `ready` resolves once the domain is open or has failed. */
export class DurableLedger implements Ledger {
  readonly ready: Promise<void>
  // Declared explicitly rather than as a parameter property: the headless
  // composition loads this file from source through Node's strip-only type removal,
  // which rejects parameter properties outright (same reason `index.ts` does it).
  private readonly ctx: IngressStorageContext
  private progressTable: IngressTable<Progress> | undefined
  private caseTable: IngressTable<StoredCase> | undefined
  private threadTable: IngressTable<StoredThread> | undefined
  private inputTable: IngressTable<StoredInput> | undefined
  private stepTable: IngressTable<StoredStep> | undefined
  private replyTable: IngressTable<StoredReply> | undefined
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

  caseOf(id: CaseId): CaseRecord | undefined {
    const stored = this.caseTable?.get(id)
    return stored === undefined ? undefined : fromStoredCase(stored)
  }

  inputOf(id: string): InputRecord | undefined {
    const stored = this.inputTable?.get(id)
    return stored === undefined ? undefined : fromStoredInput(stored)
  }

  inputsOf(caseId: CaseId): readonly InputRecord[] {
    if (this.inputTable === undefined) return []
    return [...this.inputTable.entries()]
      .map(([, stored]) => fromStoredInput(stored))
      .filter(record => record.caseId === caseId)
      .sort((left, right) => left.at - right.at)
  }

  threadOf(key: ThreadKey): ThreadRecord | undefined {
    const stored = this.threadTable?.get(key)
    return stored === undefined ? undefined : fromStoredThread(stored)
  }

  stepsOf(caseId: CaseId): readonly StepRecord[] {
    if (this.stepTable === undefined) return []
    return [...this.stepTable.entries()]
      .map(([, stored]) => fromStoredStep(stored))
      .filter(step => step.caseId === caseId)
      .sort((left, right) => left.seq - right.seq)
  }

  replyOf(caseId: CaseId, seq: number): ReplyRecord | undefined {
    const stored = this.replyTable?.get(sequenceKey(caseId, seq))
    return stored === undefined ? undefined : fromStoredReply(stored)
  }

  pendingReplies(): readonly ReplyRecord[] {
    if (this.replyTable === undefined) return []
    return [...this.replyTable.entries()]
      .map(([, stored]) => fromStoredReply(stored))
      .filter(reply => reply.state === 'pending')
      .sort((left, right) => left.at - right.at)
  }

  async commit(batch: Commit): Promise<void> {
    const open = await this.opened()
    await open.progress.put(batch.sourceId, batch.progress)
    for (const record of batch.cases) await open.cases.put(record.id, toStoredCase(record))
    for (const record of batch.threads) await open.threads.put(record.key, toStoredThread(record))
    for (const record of batch.inputs) await open.inputs.put(record.id, toStoredInput(record))
    for (const event of batch.audit) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  async writeSteps(records: readonly StepRecord[], audit: readonly AuditEvent[] = []): Promise<void> {
    const open = await this.opened()
    for (const record of records) await open.steps.put(sequenceKey(record.caseId, record.seq), toStoredStep(record))
    for (const event of audit) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  async writeInputs(records: readonly InputRecord[], audit: readonly AuditEvent[] = []): Promise<void> {
    const open = await this.opened()
    for (const record of records) await open.inputs.put(record.id, toStoredInput(record))
    for (const event of audit) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  async writeReply(record: ReplyRecord, audit: readonly AuditEvent[] = []): Promise<void> {
    const open = await this.opened()
    await open.replies.put(sequenceKey(record.caseId, record.seq), toStoredReply(record))
    for (const event of audit) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  async closeCase(id: CaseId, reason: ClosedReason, at: number, audit: readonly AuditEvent[] = []): Promise<void> {
    const open = await this.opened()
    const stored = open.cases.get(id)
    if (stored === undefined) throw new Error(`oncall: refusing to close ${id}: no such Case`)
    await open.cases.put(id, { ...stored, closed: { reason, at } })
    for (const event of audit) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  async reopenCase(id: CaseId, audit: readonly AuditEvent[] = []): Promise<void> {
    const open = await this.opened()
    const stored = open.cases.get(id)
    if (stored === undefined) throw new Error(`oncall: refusing to reopen ${id}: no such Case`)
    await open.cases.put(id, { ...stored, closed: null })
    for (const event of audit) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  async record(events: readonly AuditEvent[]): Promise<void> {
    const open = await this.opened()
    for (const event of events) await open.audit.put(globalThis.crypto.randomUUID(), toStoredAudit(event))
  }

  /** Every Case, for the panel and the executor's startup scan. Oldest first. */
  allCases(): readonly CaseRecord[] {
    if (this.caseTable === undefined) return []
    return [...this.caseTable.entries()]
      .map(([, stored]) => fromStoredCase(stored))
      .sort((left, right) => left.openedAt - right.openedAt)
  }

  /**
   * The open tables, or our own error.
   *
   * A fiber restart closes the domain; a pass or an executor that kept writing would
   * throw an opaque error from another package. Refusing here names the actual
   * problem, and asking for the table again catches a partially-opened domain
   * (an older build's schema served for a newer plugin) before the first write
   * rather than halfway through one.
   */
  private async opened(): Promise<{
    progress: IngressTable<Progress>
    cases: IngressTable<StoredCase>
    threads: IngressTable<StoredThread>
    inputs: IngressTable<StoredInput>
    steps: IngressTable<StoredStep>
    replies: IngressTable<StoredReply>
    audit: IngressTable<StoredAudit>
  }> {
    await this.ready
    const { progressTable, caseTable, threadTable, inputTable, stepTable, replyTable, auditTable } = this
    if (progressTable === undefined || caseTable === undefined || threadTable === undefined
      || inputTable === undefined || stepTable === undefined || replyTable === undefined || auditTable === undefined || this.closed) {
      throw new Error('oncall: the ingress storage domain is not open; refusing to lose the pass')
    }
    return {
      progress: progressTable,
      cases: caseTable,
      threads: threadTable,
      inputs: inputTable,
      steps: stepTable,
      replies: replyTable,
      audit: auditTable,
    }
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
      this.threadTable = domain.table('threads') as IngressTable<StoredThread>
      this.inputTable = domain.table('inputs') as IngressTable<StoredInput>
      this.stepTable = domain.table('steps') as IngressTable<StoredStep>
      this.replyTable = domain.table('replies') as IngressTable<StoredReply>
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
    threads: domainTable(threadSchema),
    inputs: domainTable(inputSchema),
    steps: domainTable(stepSchema),
    replies: domainTable(replySchema),
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

function toStoredInput(record: InputRecord): StoredInput {
  return {
    id: record.id,
    caseId: record.caseId,
    trigger: record.trigger,
    text: record.text,
    at: record.at,
    deliveredAt: record.deliveredAt,
  }
}

function fromStoredInput(stored: StoredInput): InputRecord {
  return {
    id: stored.id,
    caseId: asCaseId(stored.caseId),
    trigger: asTriggerKey(stored.trigger),
    text: stored.text,
    at: stored.at,
    deliveredAt: stored.deliveredAt,
  }
}

function toStoredThread(record: ThreadRecord): StoredThread {
  return { key: record.key, subscriptions: [...record.subscriptions], lastAt: record.lastAt }
}

function fromStoredThread(stored: StoredThread): ThreadRecord {
  return {
    key: asThreadKey(stored.key),
    subscriptions: stored.subscriptions.map(value => asCaseId(value)),
    lastAt: stored.lastAt,
  }
}

function toStoredReport(report: StampedReport): NonNullable<StoredStep['report']> {
  switch (report.state) {
    case 'blocked':
      return { state: report.state, summary: report.summary, question: report.question, at: report.at }
    case 'failed':
      return { state: report.state, summary: report.summary, code: report.code, at: report.at }
    default:
      return { state: report.state, summary: report.summary, at: report.at }
  }
}

/** One report back in its discriminated shape, or `undefined` for a row we cannot read. */
function fromStoredReport(stored: NonNullable<StoredStep['report']>): StampedReport | undefined {
  switch (stored.state) {
    case 'blocked':
      // A `blocked` row without its question is not a question we can relay; the
      // schema keeps it optional, the variant does not.
      return stored.question === undefined ? undefined : { state: 'blocked', summary: stored.summary, question: stored.question, at: stored.at }
    case 'failed':
      return stored.code === undefined ? undefined : { state: 'failed', summary: stored.summary, code: stored.code, at: stored.at }
    case 'progress':
    case 'waiting':
    case 'ready':
    case 'dropped':
      return { state: stored.state, summary: stored.summary, at: stored.at }
  }
}

function toStoredStep(record: StepRecord): StoredStep {
  return {
    caseId: record.caseId,
    seq: record.seq,
    state: record.state,
    brief: record.brief,
    report: record.report === null ? null : toStoredReport(record.report),
    at: record.at,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
  }
}

function fromStoredStep(stored: StoredStep): StepRecord {
  const report = stored.report === null ? null : fromStoredReport(stored.report)
  return {
    caseId: asCaseId(stored.caseId),
    seq: stored.seq,
    state: stored.state,
    brief: stored.brief,
    report: report ?? null,
    at: stored.at,
    ...(stored.endedAt === undefined ? {} : { endedAt: stored.endedAt }),
  }
}

function toStoredReply(record: ReplyRecord): StoredReply {
  return {
    caseId: record.caseId,
    seq: record.seq,
    intent: record.intent,
    text: record.text,
    state: record.state,
    at: record.at,
  }
}

function fromStoredReply(stored: StoredReply): ReplyRecord {
  return {
    caseId: asCaseId(stored.caseId),
    seq: stored.seq,
    intent: stored.intent,
    text: stored.text,
    state: stored.state,
    at: stored.at,
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
    case 'case.followed-up':
      return { kind: event.kind, at: event.at, caseId: event.caseId, trigger: event.trigger }
    case 'step.settled':
      return {
        kind: event.kind,
        at: event.at,
        caseId: event.caseId,
        seq: event.seq,
        state: event.state,
        ...(event.code === undefined ? {} : { code: event.code }),
      }
    case 'step.interrupted':
      return { kind: event.kind, at: event.at, caseId: event.caseId, seq: event.seq }
    case 'reply.settled':
      return { kind: event.kind, at: event.at, caseId: event.caseId, seq: event.seq, intent: event.intent, state: event.state }
    case 'trigger.refused':
      return { kind: event.kind, at: event.at, trigger: event.trigger, reason: event.reason }
    case 'poll.failed':
      return { kind: event.kind, at: event.at, source: event.source, message: event.message }
  }
}
