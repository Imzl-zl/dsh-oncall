/**
 * The two identity keys the ingress builds: one per external event, one per
 * external conversation.
 *
 * Both are built here and nowhere else. Two call sites formatting these
 * themselves is how idempotence dies: `github:12:3456` and `github/12/3456` name
 * the same comment, produce different keys, and the second poll opens a second
 * Case for work already running. `dsh-superagent` reached the same conclusion
 * about route keys (`src/routes.ts` in this package: one rule, four consumers).
 *
 * The separator is `:` and it is only unambiguous because a registered source id
 * may not contain one — enforced at registration, not here.
 *
 * Note: 为何拼键只有一个构造点、被否的方案（在调用处拼、用 join）—— 见
 * docs/design/super-plugin-code.md 2.6。
 */

import type { SourceId, ThreadKey, TriggerKey } from '../contract/types.ts'

/** The key of one external event: `source:externalId`. */
export function triggerKey(source: SourceId, externalId: string): TriggerKey {
  return `${source}:${externalId}` as TriggerKey
}

/** The key of one external conversation: `source:externalId`. */
export function threadKey(source: SourceId, external: string): ThreadKey {
  return `${source}:${external}` as ThreadKey
}

/**
 * The external id inside a thread key, when the thread belongs to `source`.
 *
 * The inverse exists because a delivery has to address the conversation it answers:
 * `undefined` for another source's thread is what keeps one source from posting into
 * another's issue numbering.
 */
export function threadExternal(thread: ThreadKey, source: SourceId): string | undefined {
  const prefix = `${source}:`
  return thread.startsWith(prefix) ? thread.slice(prefix.length) : undefined
}
