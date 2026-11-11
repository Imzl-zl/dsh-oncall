/**
 * The gate: whether one Trigger becomes a Case, and whether that Case runs or is
 * only recorded.
 *
 * This is the whole authorization surface. It is a pure function on purpose —
 * `dsh-superagent` put the same decision behind a versioned Policy and made the
 * judgement a pure `Eval` (`docs/001-domain.md:33`), because a decision that
 * reads the clock or the database cannot be replayed when someone asks "why did
 * it take that?".
 *
 * ### Precedence, and why it is written down
 *
 * 1. `follow-up` is refused before any list is consulted: it belongs to a Case
 *    that already owns its thread, and routing it there is a subscription lookup
 *    (`docs/design/super-plugin.md` 7.3). Letting it through here would open a
 *    second Case for work already running.
 * 2. A disabled source is refused before identities are looked at.
 * 3. `system` actors (manual, schedule) are trusted: nobody can forge them from
 *    outside, so they need no allowlist.
 * 4. A bot is never an explicit request, even when it mentions the agent — the
 *    list decides whether it may be a candidate at all.
 * 5. A human not on the list is refused before "does it address the agent" is
 *    answered: an unlisted person asking politely is still an unlisted person.
 *
 * Note: 三档 accept mode 的来历（observe 是唯一能让团队先看再用的模式）—— 见
 * docs/design/super-plugin.md 7.2。
 * Note: 为何拒绝用结果值而不是异常 —— 见 .agents/notes/implemented/2026-11-09-ingress-decision-layer.md
 */

import { listsActor, type Policy } from '../contract/policy.ts'
import type { RefusalReason, Trigger } from '../contract/types.ts'

/**
 * What the gate decided.
 *
 * `effect: 'record-only'` is the `observe` mode: nothing is created, and the pass
 * writes one `case.observed` audit record instead. Keeping `effect` in the verdict
 * (rather than letting the caller re-read `acceptMode`) is what makes "who decides
 * whether this runs" have exactly one answer.
 */
export type Admission =
  | {
      readonly admitted: true
      readonly strength: 'explicit' | 'inferred'
      readonly effect: 'work' | 'record-only'
    }
  | { readonly admitted: false; readonly reason: RefusalReason }

const refuse = (reason: RefusalReason): Admission => ({ admitted: false, reason })

/** Admission for one Trigger under one Policy. Same input, same verdict. */
export function admit(input: { readonly trigger: Trigger; readonly policy: Policy }): Admission {
  const { trigger, policy } = input

  if (trigger.kind === 'follow-up') return refuse('follow-up-owned')
  if (policy.disabledSources.includes(trigger.source)) return refuse('source-disabled')

  if (trigger.actor.kind === 'system') return { admitted: true, strength: 'explicit', effect: 'work' }

  if (trigger.actor.kind === 'bot') {
    if (!listsActor(policy.bots, trigger.actor)) return refuse('bot-not-allowed')
    return inferred(policy)
  }

  if (!listsActor(policy.allowed, trigger.actor)) return refuse('sender-not-allowed')

  const addresses = trigger.kind === 'direct' || trigger.kind === 'mention'
  if (!addresses) return refuse('not-addressed')

  return { admitted: true, strength: 'explicit', effect: 'work' }
}

/** A candidate's verdict depends only on the accept mode. */
function inferred(policy: Policy): Admission {
  if (policy.acceptMode === 'off') return refuse('inferred-mode-off')
  return { admitted: true, strength: 'inferred', effect: policy.acceptMode === 'auto' ? 'work' : 'record-only' }
}
