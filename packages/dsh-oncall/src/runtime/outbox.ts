/**
 * Receipts: one comment per settled assignment, at most once.
 *
 * ### One row per `caseId#seq`, never a GitHub search
 *
 * The `replies` table is the idempotency key. Before sending, the outbox checks
 * whether a row exists; the row is written before the comment goes out, and its
 * state says what happened (`pending` → `sent` / `gone` / `failed`). Searching GitHub
 * for the marker would race its own eventual consistency and, after an edit, find a
 * comment that no longer says what it said — the reference implementation keeps a row
 * for exactly the same reason (`app/outbox.ts`).
 *
 * ### What each state means
 *
 * - `sent` — the comment is on the issue. Never sent again.
 * - `gone` — the issue was deleted or transferred. Not retried: no attempt can ever
 *   reach it, and a pending row would stay pending for the life of the deployment.
 * - `failed` — every in-process attempt failed. The row stays for the audit; a
 *   restart does not resurrect it, because the failure was already reported.
 * - `pending` — owed. A restart resumes these (`resume()`), which is the only path
 *   that recovers a receipt interrupted between the ledger write and the POST.
 *
 * ### Why the queue is fire-and-forget
 *
 * A sender is a network call, and its caller is a settle loop that must not wait on
 * GitHub to finish a turn. `queue` returns immediately; the attempts run in the
 * background with their own timers, which `stop()` clears when the fiber unloads.
 *
 * Note: 为何不扫 GitHub、为何 gone 不重试 —— 见 docs/design/oncall-v0-architecture.md 四节 4。
 */

import type { CaseId, ReplyIntent, ReplyRecord, ThreadKey } from '../contract/types.ts'
import type { Ledger } from './ledger.ts'
import type { ReplySender } from '../sources/github-reply.ts'

/** The default attempts per receipt inside one process, and the waits between them. */
const ATTEMPTS = 3
const DELAYS_MS: readonly number[] = [1_000, 2_000]

export interface OutboxInput {
  readonly caseId: CaseId
  readonly seq: number
  readonly thread: ThreadKey
  readonly intent: ReplyIntent
  readonly text: string
}

export interface OutboxOptions {
  readonly ledger: Ledger
  readonly sender: ReplySender
  readonly now: () => number
  readonly logger: { warn(message: string): void; error(message: string): void }
  readonly attempts?: number
  readonly delaysMs?: readonly number[]
}

export class Outbox {
  private readonly options: OutboxOptions
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private stopped = false

  constructor(options: OutboxOptions) {
    this.options = options
  }

  private get ledger(): Ledger { return this.options.ledger }

  /** Owe one comment, unless this assignment already owed (or sent) one. */
  queue(input: OutboxInput): void {
    if (this.stopped) return
    const key = `${input.caseId}#${input.seq}`
    if (this.ledger.replyOf(input.caseId, input.seq) !== undefined || this.inFlight.has(key)) return
    const record: ReplyRecord = {
      caseId: input.caseId,
      seq: input.seq,
      intent: input.intent,
      text: input.text,
      state: 'pending',
      at: this.options.now(),
    }
    this.inFlight.set(key, this.send(record, input.thread, 0).finally(() => { this.inFlight.delete(key) }))
  }

  /**
   * Pick up the receipts a restart interrupted.
   *
   * Only `pending` rows are retried: `sent` is done, and `gone`/`failed` were already
   * decided. The thread comes from the Case, because a receipt row stores what to say,
   * not where — the Case is the one owner of "which conversation is this".
   */
  async resume(): Promise<void> {
    for (const record of this.ledger.pendingReplies()) {
      const theCase = this.ledger.caseOf(record.caseId)
      const thread = theCase?.mandate.scope[0]
      if (thread === undefined) {
        this.options.logger.warn(`oncall: receipt ${record.caseId}#${record.seq} has no thread to land on; leaving it pending`)
        continue
      }
      const key = `${record.caseId}#${record.seq}`
      if (this.inFlight.has(key)) continue
      this.inFlight.set(key, this.send(record, thread, 0).finally(() => { this.inFlight.delete(key) }))
    }
  }

  /** Stop sending; timers are cleared, in-flight attempts finish unobserved. Idempotent. */
  stop(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** Resolves when every attempt currently owed has settled. For tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()])
  }

  private async send(record: ReplyRecord, thread: ThreadKey, attempt: number): Promise<void> {
    if (this.stopped) return
    try {
      const outcome = await this.options.sender.send({ thread, text: record.text, signal: new AbortController().signal })
      await this.settle(record, outcome)
    } catch (error) {
      const attempts = this.options.attempts ?? ATTEMPTS
      if (attempt + 1 >= attempts) {
        this.options.logger.error(`oncall: could not post the receipt for ${record.caseId}#${record.seq}: ${String(error)}`)
        await this.settle(record, 'failed')
        return
      }
      const delays = this.options.delaysMs ?? DELAYS_MS
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          resolve()
        }, delay)
        this.timers.add(timer)
      })
      await this.send(record, thread, attempt + 1)
    }
  }

  private async settle(record: ReplyRecord, state: 'sent' | 'gone' | 'failed'): Promise<void> {
    await this.ledger.writeReply(
      { ...record, state, at: this.options.now() },
      [{
        kind: 'reply.settled',
        at: this.options.now(),
        caseId: record.caseId,
        seq: record.seq,
        intent: record.intent,
        state,
      }],
    )
  }
}
