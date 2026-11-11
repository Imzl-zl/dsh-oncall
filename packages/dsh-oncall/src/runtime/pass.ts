/**
 * One pass over every Source: read, judge, open, record — in that order, once.
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
 * It does not decide authorization (that is `admit`), it does not choose a channel
 * (that is the router), and it does not execute work — it stops once the Case
 * exists. A pass that starts running sessions becomes the second scheduler in the
 * harness, which is exactly the layering this design is avoiding.
 *
 * ### Failures
 *
 * A Source that throws does not stop the pass: its error is written to `lastError`,
 * one `poll.failed` record goes into the audit stream, and the other sources still
 * run. The error is never turned into an empty result — "GitHub is down" and "no new
 * work" must stay distinguishable, or an outage looks like a quiet night.
 *
 * Note: 为何拒绝只审计四类原因 —— 见 docs/design/super-plugin.md 11 节第 5 条（不吵）。
 */

import { admit } from '../core/admission.ts'
import { briefOf } from '../core/brief.ts'
import { caseIdOf } from '../core/case-id.ts'
import type { Policy } from '../contract/policy.ts'
import type { AuditEvent, CaseRecord, RefusalReason, SourceId, Trigger, TriggerKey } from '../contract/types.ts'
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

export interface PassInput {
  readonly sources: readonly Source[]
  readonly ledger: Ledger
  readonly policy: Policy
  readonly now: number
  readonly signal: AbortSignal
}

/** What one source contributed to this pass. */
export interface SourceReport {
  readonly sourceId: SourceId
  readonly opened: number
  readonly observed: number
  readonly refused: number
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
    return { sourceId: source.id, opened: 0, observed: 0, refused: 0, skipped: 0, error: message }
  }

  const cases: CaseRecord[] = []
  const audit: AuditEvent[] = []
  const seen = new Set<TriggerKey>()
  let opened = 0
  let observed = 0
  let refused = 0
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
    if (ledger.hasCase(caseId)) {
      skipped += 1
      continue
    }

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
    cases.push(caseOf(trigger, caseId, verdict.strength, policy, now))
    audit.push({ kind: 'case.opened', at: now, caseId, trigger: trigger.key, strength: verdict.strength })
  }

  const commit: Commit = {
    sourceId: source.id,
    progress: { cursor: polled.cursor, lastError: null, lastPolledAt: now },
    cases,
    threads: [],
    audit,
  }
  await ledger.commit(commit)

  return { sourceId: source.id, opened, observed, refused, skipped, error: null }
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
