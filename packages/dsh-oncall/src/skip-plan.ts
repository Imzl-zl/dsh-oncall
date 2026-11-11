/**
 * Which "this candidate was skipped" notices one `agent/request` fire must emit,
 * as data — the ruling half of the skip path, with the appending left to
 * `index.ts` (the interpreter).
 *
 * Why this is a separate pure function instead of three loops inside the
 * listener: the notices are the one part of the request path whose *identity*
 * (did we already say this?) is a decision, not an effect. A tool-loop turn
 * re-decides every step, so the same candidate is skipped again and again; a
 * duplicate is a durable `user/message` that enters the model's context and
 * costs tokens twice. Keeping the decision here makes "the skip set grows
 * mid-turn" testable without a real code path that grows it — the composition
 * harness boots one step per turn, so the shape that broke (a group key that
 * changes when a second candidate joins the same set) could not be reached
 * there at all. See docs/design/feature-review-2026-10-26.md 4.12.
 *
 * The key is per ROUTE, the same shape `capability:` and `breaker:` use, because
 * every skip has a subject: "candidate X was skipped" is a fact about X, and a
 * key naming the whole set says "this exact set of candidates was skipped",
 * which is a different fact — one a second candidate invalidates. Keyed by the
 * set, a step that skips {A, C} after a step that skipped {A} re-announces A.
 *
 * Note: 取舍与被否方案（为何不把整个分支做成纯函数、为何不做多 step 组合场景）
 * —— 见 .agents/notes/implemented/2026-10-26-skip-notices-are-a-plan.md
 */

import type { RouteBlock } from './breaker.ts'
import type { PrecheckTier } from './precheck.ts'
import { routeKeyOf } from './routes.ts'

/** The route half a skip notice names; the notice constructors take exactly this. */
export interface SkipCandidate {
  readonly provider: string
  readonly model: string
}

/**
 * One notice the interpreter must append, in the order it must append them.
 *
 * Data only: the Chinese wording lives in ./notice.ts, so a reworded notice does
 * not change what this function decides, and this function never needs a session
 * to answer.
 */
export type SkipNotice =
  | { readonly kind: 'condition'; readonly key: string; readonly candidate: SkipCandidate; readonly reason: string }
  | {
    readonly kind: 'capability'
    readonly key: string
    readonly candidate: SkipCandidate
    readonly tier: PrecheckTier | undefined
    readonly code: string | undefined
  }
  | { readonly kind: 'breaker'; readonly key: string; readonly candidate: SkipCandidate; readonly block: RouteBlock }

export interface SkipPlanInput {
  /** Candidates whose `needs` condition this request does not meet. */
  readonly conditionSkipped: readonly { readonly candidate: SkipCandidate; readonly reason: string }[]
  /** Candidates `ctx.llm.resolveCallConfig()` refused (three tiers, ./precheck.ts). */
  readonly capabilitySkipped: readonly {
    readonly candidate: SkipCandidate
    readonly tier: PrecheckTier | undefined
    readonly code: string | undefined
  }[]
  /** Candidates a breaker is cooling down. */
  readonly blocked: readonly { readonly candidate: SkipCandidate; readonly block: RouteBlock }[]
  /**
   * Nothing in the chain could serve this request, so the request goes to the
   * user's own route. The implicit first hop IS that route: announcing "skipped
   * the first hop" while sending the request to it is a lie (review 4.13).
   */
  readonly fellBackToOwnRoute: boolean
  /** The route the request would go to without this plugin. */
  readonly resolved: SkipCandidate
  /** Keys this turn has already announced (same `agent`, same `turn`). */
  readonly alreadyNoted: ReadonlySet<string>
}

export interface SkipPlan {
  /** The notices to append, in order: conditions, then capabilities, then cooling. */
  readonly notices: readonly SkipNotice[]
  /** The keys this fire consumed; the caller records them on the turn's ledger. */
  readonly keys: readonly string[]
}

function sameRoute(a: SkipCandidate, b: SkipCandidate): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * Decide the notices for one fire.
 *
 * @param input - the three skip lists, the fallback verdict, and what this turn
 *   has already announced.
 * @returns the notices to append and the keys to record. Pure: the same input
 *   always answers the same plan, and `alreadyNoted` is never mutated.
 */
export function planSkipNotices(input: SkipPlanInput): SkipPlan {
  const taken = new Set(input.alreadyNoted)
  const notices: SkipNotice[] = []
  const keys: string[] = []
  const take = (key: string): boolean => {
    if (taken.has(key)) return false
    taken.add(key)
    keys.push(key)
    return true
  }

  for (const entry of input.conditionSkipped) {
    if (input.fellBackToOwnRoute && sameRoute(entry.candidate, input.resolved)) continue
    const candidate = { provider: entry.candidate.provider, model: entry.candidate.model }
    const key = `condition:${routeKeyOf(candidate.provider, candidate.model)}`
    if (!take(key)) continue
    notices.push({ kind: 'condition', key, candidate, reason: entry.reason })
  }

  for (const entry of input.capabilitySkipped) {
    const candidate = { provider: entry.candidate.provider, model: entry.candidate.model }
    const key = `capability:${routeKeyOf(candidate.provider, candidate.model)}`
    if (!take(key)) continue
    notices.push({ kind: 'capability', key, candidate, tier: entry.tier, code: entry.code })
  }

  for (const entry of input.blocked) {
    const candidate = { provider: entry.candidate.provider, model: entry.candidate.model }
    const key = `breaker:${routeKeyOf(candidate.provider, candidate.model)}`
    if (!take(key)) continue
    notices.push({ kind: 'breaker', key, candidate, block: entry.block })
  }

  return { notices, keys }
}
