/**
 * Receipts: one comment per settled assignment, at most once, in order.
 *
 * ### The row is written before the POST
 *
 * `pending` lands first; the comment goes out; the row settles `sent` / `gone` /
 * `failed`. A crash between the write and the POST therefore leaves an owed receipt
 * that the next start resumes, and the row itself is the idempotency check — one row
 * per `caseId#seq`, never a GitHub search (a search races its own eventual
 * consistency and, after an edit, finds a comment that no longer says what it said).
 * The reference keeps a receipt row for exactly this reason (`app/store.ts`:
 * `receipts.add` inserts `pending`, `settle` only moves a `pending` row).
 *
 * ### One conversation, one lane
 *
 * Two receipts for the same Case must not overtake each other: assignment 2 settling
 * while assignment 1's comment is still retrying would put the newer answer above the
 * older one on the issue. Sends are therefore chained per `caseId` — the reference's
 * `receipts.behind()` enforces the same order between a ticket's pending messages.
 * A failed send does not block the next one: the failure is already recorded.
 *
 * ### What each state means
 *
 * - `sent` — the comment is on the issue. Never sent again.
 * - `gone` — the issue was deleted or transferred. Not retried: no attempt can ever
 *   reach it, and a pending row would stay pending for the life of the deployment.
 * - `failed` — every in-process attempt failed. The row stays for the audit; a
 *   restart does not resurrect it, because the failure was already reported.
 * - `pending` — owed. A restart resumes these (`resume()`).
 *
 * ### Why the queue is fire-and-forget
 *
 * A sender is a network call, and its caller is a settle loop that must not wait on
 * GitHub to finish a turn. `queue` returns immediately; the lane runs in the
 * background with its own timers, which `stop()` clears when the fiber unloads.
 *
 * Note: 为何不扫 GitHub、为何 gone 不重试、为何要按会话串行 —— 见
 * docs/design/oncall-v0-architecture.md 四节 4 与参考实现 `app/outbox.ts` / `app/store.ts`。
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
  /** Receipts this process already owes, keyed by `caseId#seq` (the row is written later in the lane). */
  private readonly owed = new Set<string>()
  /** One lane per Case: the tail of its receipt chain. */
  private readonly lanes = new Map<string, Promise<void>>()
  private stopped = false

  constructor(options: OutboxOptions) {
    this.options = options
  }

  private get ledger(): Ledger { return this.options.ledger }

  /** Owe one comment, unless this assignment already owed (or sent) one. */
  queue(input: OutboxInput): void {
    if (this.stopped) return
    const key = `${input.caseId}#${input.seq}`
    if (this.owed.has(key) || this.ledger.replyOf(input.caseId, input.seq) !== undefined) return
    this.owed.add(key)
    const record: ReplyRecord = {
      caseId: input.caseId,
      seq: input.seq,
      intent: input.intent,
      text: input.text,
      state: 'pending',
      at: this.options.now(),
    }
    this.lane(input.caseId, async () => {
      // The row lands before the POST: a crash in between leaves `pending`, which a
      // restart resumes, and the row is what makes a second `queue` a no-op.
      if (this.ledger.replyOf(record.caseId, record.seq) === undefined) await this.ledger.writeReply(record)
      await this.send(record, input.thread, 0)
    })
  }

  /**
   * Pick up the receipts a restart interrupted.
   *
   * Only `pending` rows are retried: `sent` is done, and `gone`/`failed` were already
   * decided. The thread comes from the Case, because a receipt row stores what to say,
   * not where — the Case is the one owner of "which conversation is this".
   */
  resume(): void {
    const pending = [...this.ledger.pendingReplies()].sort((left, right) => left.at - right.at)
    for (const record of pending) {
      const key = `${record.caseId}#${record.seq}`
      if (this.owed.has(key)) continue
      const theCase = this.ledger.caseOf(record.caseId)
      const thread = theCase?.mandate.scope[0]
      if (thread === undefined) {
        this.options.logger.warn(`oncall: receipt ${key} has no thread to land on; leaving it pending`)
        continue
      }
      this.owed.add(key)
      this.lane(record.caseId, () => this.send(record, thread, 0))
    }
  }

  /** Stop sending; timers are cleared, a lane in flight finishes unobserved. Idempotent. */
  stop(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** Resolves when every lane currently running has settled. For tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.lanes.values()])
  }

  /** Append one receipt to its Case's lane; a failure of the previous one does not block this one. */
  private lane(caseId: string, run: () => Promise<void>): void {
    const tail = this.lanes.get(caseId) ?? Promise.resolve()
    const next = tail
      .then(run)
      .catch(error => { this.options.logger.error(`oncall: receipt for ${caseId} failed to record: ${String(error)}`) })
    this.lanes.set(caseId, next)
    void next.then(() => {
      if (this.lanes.get(caseId) === next) this.lanes.delete(caseId)
    })
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
    const at = this.options.now()
    await this.ledger.writeReply(
      { ...record, state, at },
      [{ kind: 'reply.settled', at, caseId: record.caseId, seq: record.seq, intent: record.intent, state }],
    )
  }
}
