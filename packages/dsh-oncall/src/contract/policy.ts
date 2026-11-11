/**
 * Who may ask the agent for work, on which source, in that source's own
 * identity system.
 *
 * Identities are never mapped across sources. `dsh-superagent` tried and rejected
 * that: the same person having accounts on two platforms is prompt text, not an
 * entity (`docs/001-domain.md:39`, `:49`). Here that decision shows up as
 * `ActorRef` always carrying its `SourceId`.
 *
 * Note: 闸门的判定次序与三档 accept mode —— 见 docs/design/super-plugin.md 7.2。
 */

import type { Actor, SourceId } from './types.ts'

/** One identity as it appears on exactly one source. */
export interface ActorRef {
  readonly source: SourceId
  readonly id: string
}

/**
 * What happens to work nobody explicitly asked for.
 *
 * - `off`: only explicit requests are admitted.
 * - `observe`: candidates are admitted, but with `effect: 'record-only'` — the
 *   Case is recorded and nothing runs. This is the only mode that lets a team
 *   see what the agent *would* have done before it does anything.
 * - `auto`: candidates run like explicit requests.
 */
export type AcceptMode = 'off' | 'observe' | 'auto'

/** The versioned rules one deployment runs under. */
export interface Policy {
  readonly version: number
  readonly acceptMode: AcceptMode
  /** People who may ask for work. Bots are never admitted from this list. */
  readonly allowed: readonly ActorRef[]
  /** Bots whose messages may become candidates. Never explicit requests. */
  readonly bots: readonly ActorRef[]
  /** Sources switched off. Their triggers are dropped before any other rule. */
  readonly disabledSources: readonly SourceId[]
}

/** Whether `actor` appears in `list`, compared on (source, id). */
export function listsActor(list: readonly ActorRef[], actor: Actor): boolean {
  return list.some(entry => entry.source === actor.source && entry.id === actor.id)
}
