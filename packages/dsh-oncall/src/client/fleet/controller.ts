/**
 * Projection and binding reads for the Agent Fleet tab.
 *
 * The tab is a read-only observer. It loads the Session list, then the recent
 * 20 sessions' projections with four reads in flight; a session already read is
 * remembered so a re-render cannot turn into an RPC storm. The controller is
 * owned by the plugin fiber, so closing the tab stops scheduling immediately.
 *
 * `refreshProjections` has no AbortSignal in DSH's client contract
 * (`api/session-controller/src/client/contract/sessions.ts:101-106`). Hiding or
 * closing the tab therefore stops the queue and skips repaints (`pause()`); it
 * cannot abort an already-dispatched Host read. The view says "loaded" only for
 * a ready projection, so a late result cannot fabricate a loaded row while the
 * body is paused, and `resume()` repaints once to fold in what settled.
 *
 * Note: 加载策略与“停止调度 ≠ 取消在飞读”的真实边界 —— 见
 * docs/design/agent-fleet-drawer.md §6.2；为何不假装 abort、为何流动点只画一个 —— 见
 * .agents/notes/implemented/2026-10-23-agent-fleet-capability-review.md
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { effectiveChains } from '../../chain.ts'
import { reviewRosterIds } from '../../handoff-wire.ts'
import type { HandoffCarriedView, SessionBindingView } from '../../types.ts'
import { fill } from '../format.ts'
import { normalizeHandoff } from '../validate.ts'
import { FLEET_CONCURRENCY, type FleetBudgetConfig } from './model.ts'

/** The Remote face this controller reads; the generated client carries the envelope. */
interface OnCallHealthRemote {
  sessionBinding?: (sessionId: string) => Promise<{ ok: boolean; value?: SessionBindingView; error?: unknown }>
  handoffCarried?: (sessionId: string) => Promise<{ ok: boolean; value?: HandoffCarriedView; error?: unknown }>
}

/**
 * A list refresh that never settles (dead transport) must become an error, not
 * eternal loading. The message is a localized key, not English prose: the card
 * shows it as the concrete reason (see `fleetListTimeout`).
 */
const REFRESH_TIMEOUT_MS = 8000

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, REFRESH_TIMEOUT_MS)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface FleetControllerOptions {
  /** The plugin's own settings scope, read only for chain display names. */
  readonly scope: { getSnapshot(): { value?: unknown } }
  /** Namespace-bound translate, used for the default-chain fallback label. */
  readonly t: (key: string) => string
}

export interface FleetController {
  /** Read the Host Session list once (the tab's first paint). */
  refreshSessions(): Promise<void>
  /** Queue projection reads for the recent sessions; idempotent per session id. */
  ensureSessions(ids: readonly string[]): void
  /** Queue projection reads for one session's direct children. */
  ensureChildren(parentId: string, ids: readonly string[]): void
  /** Re-read one session's projections on an explicit user action. */
  loadSession(sessionId: string): void
  /** Read one session's routing binding; cached after the first answer. */
  loadBinding(sessionId: string, force?: boolean): Promise<SessionBindingView | undefined>
  /** The bindings read so far; absent means "not read", never "no binding". */
  bindingsSnapshot(): ReadonlyMap<string, SessionBindingView | undefined>
  /** Read the budget a relayed session inherited; cached after the first answer. */
  loadCarried(sessionId: string, force?: boolean): Promise<HandoffCarriedView | undefined>
  /** The carried budgets read so far; absent means "not read", never "nothing carried". */
  carriedSnapshot(): ReadonlyMap<string, HandoffCarriedView>
  /** The configured limits + reviewer ids, or `undefined` when handoff is off. */
  handoffBudgetConfig(): FleetBudgetConfig | undefined
  /** A chain's display name for a binding, or `undefined` while unread. */
  chainLabel(binding: SessionBindingView | undefined): string | undefined
  /** Observe scheduler completions (the hook uses this to repaint). */
  subscribe(listener: () => void): () => void
  /**
   * Stop scheduling new reads and skip repaints. Reads already dispatched to the
   * Host still settle; nothing claims to cancel them.
   */
  pause(): void
  /** Resume scheduling: repaint once, then keep draining the queue. */
  resume(): void
  /** Stop scheduling and drop late results. */
  dispose(): void
}

/** Create the fleet controller. */
export function createFleetController(ctx: Context, options: FleetControllerOptions): FleetController {
  const sessions = ctx.sessions
  const remote = (ctx.remote as { oncallHealth?: OnCallHealthRemote } | undefined)?.oncallHealth
  const requested = new Set<string>()
  const inflight = new Set<string>()
  const bindings = new Map<string, SessionBindingView | undefined>()
  const bindingRequests = new Map<string, Promise<SessionBindingView | undefined>>()
  const carried = new Map<string, HandoffCarriedView>()
  const carriedRequests = new Map<string, Promise<HandoffCarriedView | undefined>>()
  const listeners = new Set<() => void>()
  let queue: string[] = []
  let active = 0
  let disposed = false
  // Paused is "the body is not on screen": the queue is kept, but nothing new is
  // dispatched and no listener is called until `resume()`.
  let paused = false
  // The config value is a stable object per revision; do not re-fold 222 rows
  // through effectiveChains on every projection update.
  let chainCache: { value: unknown; chains: ReturnType<typeof effectiveChains>['chains']; defaultChainId: string } | null = null

  function notify(): void {
    if (disposed || paused) return
    for (const listener of listeners) listener()
  }

  function pump(): void {
    if (disposed || paused) return
    while (active < FLEET_CONCURRENCY && queue.length > 0) {
      const id = queue.shift() as string
      if (requested.has(id) || inflight.has(id)) continue
      requested.add(id)
      inflight.add(id)
      active += 1
      Promise.resolve(sessions.refreshProjections(id as SessionId)).then(
        () => undefined,
        () => { requested.delete(id) },
      ).finally(() => {
        inflight.delete(id)
        active -= 1
        notify()
        pump()
      })
    }
  }

  function enqueue(ids: readonly string[]): void {
    if (disposed) return
    for (const id of ids) {
      if (requested.has(id) || inflight.has(id) || queue.includes(id)) continue
      queue.push(id)
    }
    pump()
  }

  function loadBinding(sessionId: string, force = false): Promise<SessionBindingView | undefined> {
    if (!force && bindings.has(sessionId)) return Promise.resolve(bindings.get(sessionId))
    const pending = bindingRequests.get(sessionId)
    if (pending !== undefined) return pending
    if (remote === undefined || typeof remote.sessionBinding !== 'function') {
      return Promise.resolve(undefined)
    }
    const request = Promise.resolve(remote.sessionBinding(sessionId)).then(
      (result) => {
        const value = result !== null && result !== undefined && result.ok === true ? result.value : undefined
        bindings.set(sessionId, value)
        notify()
        return value
      },
      () => {
        // A refused read is "unknown", not "no binding": leave the cache empty
        // so an explicit refresh can ask again.
        notify()
        return undefined
      },
    ).finally(() => {
      bindingRequests.delete(sessionId)
    })
    bindingRequests.set(sessionId, request)
    return request
  }

  function loadCarried(sessionId: string, force = false): Promise<HandoffCarriedView | undefined> {
    if (!force && carried.has(sessionId)) return Promise.resolve(carried.get(sessionId))
    const pending = carriedRequests.get(sessionId)
    if (pending !== undefined) return pending
    if (remote === undefined || typeof remote.handoffCarried !== 'function') {
      return Promise.resolve(undefined)
    }
    const request = Promise.resolve(remote.handoffCarried(sessionId)).then(
      (result) => {
        const value = result !== null && result !== undefined && result.ok === true ? result.value : undefined
        // A refused read is unknown, not "nothing carried": leave the cache empty
        // so the budget block stays hidden rather than painting the carried half
        // as zero and under-reporting a budget the gate would refuse on.
        if (value !== undefined) carried.set(sessionId, value)
        notify()
        return value
      },
      () => {
        notify()
        return undefined
      },
    ).finally(() => {
      carriedRequests.delete(sessionId)
    })
    carriedRequests.set(sessionId, request)
    return request
  }

  /**
   * The numbers D7 paints next to "已用".
   *
   * Read from the same config snapshot the chain labels use, through the
   * browser's own normalizer, so the limits are the values the user sees in the
   * roster page. Handoff off means there is no budget to speak of: the block
   * stays hidden rather than painting 0/8 for a feature that cannot run.
   */
  function handoffBudgetConfig(): FleetBudgetConfig | undefined {
    const value = options.scope.getSnapshot().value as { handoff?: unknown } | undefined
    const handoff = normalizeHandoff(value?.handoff)
    if (!handoff.enabled) return undefined
    return {
      limits: {
        delegations: handoff.limits.maxDelegationsPerUserMessage,
        reviews: handoff.limits.maxReviewsPerUserMessage,
        newSessions: handoff.limits.maxNewSessionsPerUserMessage,
      },
      reviewIds: reviewRosterIds(handoff),
    }
  }

  function chainLabel(binding: SessionBindingView | undefined): string | undefined {
    if (binding === undefined) return undefined
    const value = options.scope.getSnapshot().value ?? {}
    if (chainCache === null || chainCache.value !== value) {
      const effective = effectiveChains(value)
      chainCache = { value, chains: effective.chains, defaultChainId: effective.defaultChainId }
    }
    const id = binding.chain ?? chainCache.defaultChainId
    const chain = chainCache.chains.find((entry) => entry.id === id)
    if (chain === undefined) return binding.chain ?? options.t('chainDefaultName')
    return chain.name !== '' ? chain.name : options.t('chainDefaultName')
  }

  return {
    refreshSessions: () => withTimeout(
      sessions.refresh(),
      fill(options.t('fleetListTimeout'), { seconds: REFRESH_TIMEOUT_MS / 1000 }),
    ),
    ensureSessions(ids) {
      enqueue(ids)
    },
    ensureChildren(_parentId, ids) {
      enqueue(ids)
    },
    loadSession(sessionId) {
      requested.delete(sessionId)
      queue = queue.filter((id) => id !== sessionId)
      enqueue([sessionId])
    },
    loadBinding,
    bindingsSnapshot: () => bindings,
    loadCarried,
    carriedSnapshot: () => carried,
    handoffBudgetConfig,
    chainLabel,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    pause() {
      paused = true
    },
    resume() {
      if (disposed || !paused) return
      paused = false
      // One repaint folds in every read that settled while the body was hidden;
      // the queue then continues from where it stopped.
      notify()
      pump()
    },
    dispose() {
      disposed = true
      queue = []
      requested.clear()
      inflight.clear()
      bindingRequests.clear()
      carriedRequests.clear()
      listeners.clear()
    },
  }
}
