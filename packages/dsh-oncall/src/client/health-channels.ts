/**
 * The health page's channel list: one row per physical route, with where each
 * route is configured and where it has been observed.
 *
 * Extracted from `workspace.ts` so it can be asserted without a DOM, and so the
 * "where is this route used" rule has one home. That rule was wrong once: it
 * read `draft.chain` (the chain being *edited*), so cutting to another chain
 * changed what the page said about a channel — including showing "not
 * configured in a fallback chain" for a route that the checks and probes were
 * still running over the whole chain set.
 *
 * The first hop is deliberately absent from the configured half: it is whatever
 * model the user picked in DSH, which the plugin only learns once a request
 * arrives, so it can appear here only after it has been observed.
 */

import { chainDisplayName, fill } from './format.ts'
import { routeKeyOf, routeParts } from '../routes.ts'

/** One physical route as the health page lists it. */
export interface HealthChannel {
  /** `provider/model`, the key every fold and the Host are keyed by. */
  route: string
  provider: string
  model: string
  /** Where this route appears: one entry per (chain, position). */
  usages: { label: string }[]
}

/** What the list reads: the draft's chains plus every observation map. */
export interface HealthChannelsInput {
  draft?: {
    chains?: readonly {
      name?: string
      candidates?: readonly { provider?: string; model?: string }[]
    }[]
  }
  /** Route → record, from the passive fold / the last check / the last probe. */
  passive?: Record<string, unknown>
  discover?: Record<string, unknown>
  probe?: Record<string, unknown>
  t: (key: string) => string
}

/** Every route the page can show, with its positions across ALL chains. */
export function healthChannels(input: HealthChannelsInput): HealthChannel[] {
  const map: Record<string, HealthChannel> = {}
  const ensure = (provider?: string, model?: string): HealthChannel | null => {
    if (!provider || !model) return null
    const key = routeKeyOf(provider, model)
    if (!map[key]) map[key] = { route: key, provider, model, usages: [] }
    return map[key]
  }

  for (const chain of input.draft?.chains ?? []) {
    ;(chain.candidates ?? []).forEach((candidate, index) => {
      const channel = ensure(candidate.provider, candidate.model)
      if (channel === null) return
      channel.usages.push({
        // 整句模板 + 占位符：拼 `t(key) + ' #' + n` 会印出「降级链第 #1」这种半中半英的序号。
        label: fill(input.t('channelUsedInChainNamed'), { chain: chainDisplayName(input.t, chain), n: index + 1 }),
      })
    })
  }

  for (const observations of [input.passive, input.discover, input.probe]) {
    for (const key of Object.keys(observations ?? {})) {
      const parts = routeParts(key)
      ensure(parts.provider, parts.model)
    }
  }

  return Object.values(map)
}
