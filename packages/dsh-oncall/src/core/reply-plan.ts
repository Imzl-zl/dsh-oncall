/**
 * What a report owes the people reading the thread.
 *
 * The gate is `dsh-superagent`'s (`src/core/replies.ts`): a receipt is written only
 * when a person can act on it or the result is usable. `progress` and `waiting` say
 * nothing a reader needs — an agent that comments "still working" on every turn is
 * the noise that makes people mute the bot.
 *
 * The one deliberate deviation is `failed`: the reference keeps it out of `result`
 * because its reader sits in the main session and the relay already said it. Our
 * reader is on GitHub, so "failed" is exactly the kind of thing they must hear
 * (`docs/design/oncall-v0-architecture.md` §五).
 *
 * Pure on purpose: the comment's wording and the decision to send it are one table,
 * testable without a ledger, a channel or a clock.
 *
 * Note: 为何终局失败也发、为何 progress 不发 —— 见 oncall-v0-architecture.md 五节与
 * docs/design/open-questions.md §14.2 第 8 条。
 */

import type { CaseId, ReplyIntent, Report } from '../contract/types.ts'

export interface ReplyPlan {
  readonly intent: ReplyIntent
  /** The whole comment body, marker included. */
  readonly text: string
}

/**
 * The marker at the end of every receipt.
 *
 * It is for a person reading the issue ("which assignment is this?") and never for
 * dedupe: one receipt per `caseId#seq` is enforced by the `replies` table, not by
 * scanning GitHub — a search would race its own eventual consistency and, after an
 * edit, find a comment that no longer says what it said.
 */
export function replyMarker(caseId: CaseId, seq: number): string {
  return `<!-- oncall:${caseId}#${seq} -->`
}

/** What one settled report owes the thread, or `undefined` when it owes nothing. */
export function planReply(input: { readonly caseId: CaseId; readonly seq: number; readonly report: Report }): ReplyPlan | undefined {
  const { caseId, seq, report } = input
  const marker = replyMarker(caseId, seq)
  const body = report.summary.trim()

  switch (report.state) {
    case 'progress':
    case 'waiting':
      return undefined
    case 'ready':
      return { intent: 'result', text: `## 完成了\n\n${body}\n\n${marker}` }
    case 'dropped':
      return { intent: 'result', text: `## 已放弃\n\n${body}\n\n${marker}` }
    case 'blocked':
      return {
        intent: 'attention',
        text: `## 需要你决定\n\n${body}\n\n**问题：** ${report.question.trim()}\n\n${marker}`,
      }
    case 'failed':
      // "什么时候能修好" is the reader's next question; the code is the one fact
      // that makes it answerable without a log hunt.
      return { intent: 'failed', text: `## 卡住了\n\n${body}\n\n原因代码：\`${report.code}\`\n\n${marker}` }
  }
}
