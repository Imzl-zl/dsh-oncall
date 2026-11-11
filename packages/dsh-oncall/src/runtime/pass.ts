/**
 * One pass over every Source: read, route, judge, open, record — once.
 *
 * ### Why one pass and not a timer per source
 *
 * A pass is a sequence of awaits, so a slow source delays the ones after it, and
 * that is the intended trade: one pass cannot overlap itself, which removes the
 * whole class of "two polls both decided to open a Case". `dsh-superagent` runs the
 * same shape every two seconds (`src/app/passes.ts`).
 *
 * ### What a pass may not do
 *
 * It does not decide authorization for work it hands to an existing Case (that is
 * the Case's own mandate, `docs/002-authorization.md` "Subscriptions"), it does not
 * choose a channel (that is the router), and it does not run sessions — a follow-up
 * is handed to the executor through a port, so the pass never awaits a model turn
 * and the next poll is never delayed by one. A pass that started sessions becomes
 * the second scheduler in the harness, which is exactly the layering this design is
 * avoiding.
 *
 * ### Two decisions, in this order
 *
 * 1. **Ownership** (`core/thread-owner.ts`, pure): the thread's newest Case is the
 *    owner, unless it was stopped. Owned messages bypass the gate — routing a
 *    message to a Case it already belongs to is a subscription lookup, not a new
 *    authorization.
 * 2. **Admission** (`core/admission.ts`, pure): only when nobody owns the thread.
 *
 * ### Failures
 *
 * A Source that throws does not stop the pass: its error is written to `lastError`,
 * one `poll.failed` record goes into the audit stream, and the other sources still
 * run. The error is never turned into an empty result — "GitHub is down" and "no new
 * work" must stay distinguishable, or an outage looks like a quiet night.
 *
 * Note: 为何拒绝只审计四类原因 —— 见 docs/design/super-plugin.md 11 节第 5 条（不吵）。
 * Note: 为何订阅投递绕过闸门 —— 见 docs/design/oncall-v0-architecture.md 四节 1。
 */

import { admit } from '../core/admission.ts'
import { briefOf } from '../core/brief.ts'
import { caseIdOf } from '../core/case-id.ts'
import { threadOwner } from '../core/thread-owner.ts'
import type { Policy } from '../contract/policy.ts'
import type {
  AuditEvent,
  CaseId,
  CaseRecord,
  RefusalReason,
  SourceId,
  ThreadKey,
  ThreadRecord,
  Trigger,
  TriggerKey,
} from '../contract/types.ts'
import type { Source } from '../sources/source.ts'
import type { Commit, Ledger } from './ledger.ts'

/**
 * Refusals worth a durable record.
 *
 * These four mean "someone asked, and the rules said no" — the operator's first
 * question after a quiet week. `not-addressed` and `follow-up-owned` are routine
 * routing: every unmentioned comment on a busy repo would produce one, and a stream
 * nobody reads is worse than no stream (`dsh-superagent` docs/005-panel.md:57,
 * "quiet by default").
 */
const AUDITED_REFUSALS: ReadonlySet<RefusalReason> = new Set([
  'source-disabled',
  'bot-not-allowed',
  'sender-not-allowed',
  'inferred-mode-off',
])

/** One further message for a Case that already owns its thread. */
export interface FollowUpDelivery {
  readonly caseId: CaseId
  /** The message as the person wrote it. Bounding it is the executor's job when it stores a brief. */
  readonly text: string
  /** Becomes part of the message id, which is what makes a re-delivery a no-op. */
  readonly trigger: TriggerKey
}

/**
 * Where a message for a Case goes — the trigger that opened it as well as a follow-up.
 *
 * For the trigger that opened the Case the executor sees "nothing is running yet"
 * and starts the first assignment from the Case's own brief; for a later one it
 * delivers into the live session. One port, one idempotency rule (the message id).
 * `deliver` must not block: a model turn takes minutes, and a pass that awaited one
 * would stop reading the repository.
 */
export interface FollowUpPort {
  deliver(input: FollowUpDelivery): void
}

export interface PassInput {
  readonly sources: readonly Source[]
  readonly ledger: Ledger
  readonly policy: Policy
  readonly now: number
  readonly signal: AbortSignal
  /**
   * The executor, when this composition has one.
   *
   * Absent is a real state: `installIngress` builds the loop before the executor is
   * wired. An owned trigger is then counted as `skipped` and **nothing is audited** —
   * writing `case.followed-up` would claim a delivery that never happened, and the
   * audit is the only place a person can check what the agent did with their message.
   */
  readonly executor?: FollowUpPort
}

/** What one source contributed to this pass. */
export interface SourceReport {
  readonly sourceId: SourceId
  readonly opened: number
  readonly observed: number
  readonly refused: number
  /** Messages routed to a Case that already owned their thread. */
  readonly delivered: number
  readonly skipped: number
  readonly error: string | null
}

export interface PassReport {
  readonly sources: readonly SourceReport[]
}

/** Read every source once and commit whatever that produced. */
export async function runPass(input: PassInput): Promise<PassReport> {
  const reports: SourceReport[] = []
  for (const source of input.sources) reports.push(await passOne(source, input))
  return { sources: reports }
}

async function passOne(source: Source, input: PassInput): Promise<SourceReport> {
  const { ledger, policy, now } = input
  const progress = ledger.readProgress(source.id)

  let polled
  try {
    polled = await source.poll({ cursor: progress.cursor, now, signal: input.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ledger.commit({
      sourceId: source.id,
      progress: { cursor: progress.cursor, lastError: message, lastPolledAt: now },
      cases: [],
      threads: [],
      audit: [{ kind: 'poll.failed', at: now, source: source.id, message }],
    })
    return { sourceId: source.id, opened: 0, observed: 0, refused: 0, delivered: 0, skipped: 0, error: message }
  }

  const cases: CaseRecord[] = []
  const audit: AuditEvent[] = []
  /**
   * What this pass has already changed, so a second trigger on the same thread sees
   * the first one's effects without an intermediate commit.
   */
  /** Hand-offs are made after the commit: the executor reads the Case from the ledger. */
  const deliveries: FollowUpDelivery[] = []
  const known = new Map<string, CaseRecord>()
  for (const record of ledger.allCases()) known.set(record.id, record)
  const threadRows = new Map<string, ThreadRecord>()
  const threadRow = (key: ThreadKey): ThreadRecord | undefined => threadRows.get(key) ?? ledger.threadOf(key)

  const seen = new Set<TriggerKey>()
  let opened = 0
  let observed = 0
  let refused = 0
  let delivered = 0
  let skipped = 0

  for (const trigger of polled.triggers) {
    // A poll may report one event twice (the GitHub overlap window); within a single
    // batch that would otherwise count as two decisions.
    if (seen.has(trigger.key)) {
      skipped += 1
      continue
    }
    seen.add(trigger.key)

    const caseId = caseIdOf(trigger.key)
    if (known.has(caseId)) {
      skipped += 1
      continue
    }

    // 1. Someone already owns this thread: this message belongs to that Case.
    const thread = threadRow(trigger.thread)
    const owner = threadOwner({ thread, caseOf: id => known.get(id) })
    if (owner !== undefined && thread !== undefined) {
      if (input.executor === undefined) {
        skipped += 1
        continue
      }
      delivered += 1
      audit.push({ kind: 'case.followed-up', at: now, caseId: owner.id, trigger: trigger.key })
      // The subscription list never shrinks (a person's next message resumes the
      // Case), so only the observation time moves.
      threadRows.set(trigger.thread, { key: trigger.thread, subscriptions: [...thread.subscriptions], lastAt: now })
      deliveries.push({ caseId: owner.id, text: trigger.text.trim(), trigger: trigger.key })
      continue
    }

    // 2. Nobody owns it: the ordinary gate decides whether this becomes work.
    const verdict = admit({ trigger, policy })
    if (!verdict.admitted) {
      refused += 1
      if (AUDITED_REFUSALS.has(verdict.reason)) {
        audit.push({ kind: 'trigger.refused', at: now, trigger: trigger.key, reason: verdict.reason })
      }
      continue
    }

    // Observe mode: say what would have happened, create nothing. A Case that exists
    // but is closed is worse — it pollutes every list that counts open work.
    if (verdict.effect === 'record-only') {
      observed += 1
      audit.push({ kind: 'case.observed', at: now, trigger: trigger.key, brief: briefOf(trigger.text) })
      continue
    }

    opened += 1
    const record = caseOf(trigger, caseId, verdict.strength, policy, now)
    cases.push(record)
    known.set(caseId, record)
    // The subscription is written in the same commit as the Case: a Case nobody can
    // address is worse than no Case.
    threadRows.set(trigger.thread, {
      key: trigger.thread,
      subscriptions: [...(thread?.subscriptions ?? []), caseId],
      lastAt: now,
    })
    audit.push({ kind: 'case.opened', at: now, caseId, trigger: trigger.key, strength: verdict.strength })
    // A new Case is work: the executor hears about it the same way a follow-up
    // arrives. Without this the Case would sit unworked until the next restart scan
    // saw it — a whole poll interval of silence for work already authorized.
    deliveries.push({ caseId, text: trigger.text.trim(), trigger: trigger.key })
  }

  const commit: Commit = {
    sourceId: source.id,
    progress: { cursor: polled.cursor, lastError: null, lastPolledAt: now },
    cases,
    threads: [...threadRows.values()],
    audit,
  }
  await ledger.commit(commit)
  // Deliberately after the commit: the executor looks the Case up in the ledger, and
  // a new Case exists there only once the commit landed. A delivery that fails here
  // is the executor's own error to record; the pass has already recorded the fact.
  for (const delivery of deliveries) input.executor?.deliver(delivery)

  return { sourceId: source.id, opened, observed, refused, delivered, skipped, error: null }
}

/** The Case one admitted Trigger opens. Pure shape, no ids generated here. */
function caseOf(
  trigger: Trigger,
  id: ReturnType<typeof caseIdOf>,
  strength: 'explicit' | 'inferred',
  policy: Policy,
  now: number,
): CaseRecord {
  return {
    id,
    mandate: { strength, actor: trigger.actor, scope: [trigger.thread], policyVersion: policy.version },
    origin: trigger.key,
    brief: briefOf(trigger.text),
    openedAt: now,
    closed: null,
  }
}
