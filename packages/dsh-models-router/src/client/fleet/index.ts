/**
 * The Agent Fleet dockkit tab: one type registration, one body seat.
 *
 * The type is a page type (`kind: 'agent-fleet'`), so it is opened by kind from
 * the guide entry and carries its own navigation parameters. The body is the
 * keyed `sidebar.right.pane.tab` seat under the type's `id`; DSH's dockkit owns
 * the tab strip, the close/fullscreen actions, the drag handle and the
 * fullscreen transition. This module adds no second carrier.
 *
 * Note: 右栏载体、导航参数与“不自建抽屉” —— 见 docs/design/agent-fleet-drawer.md §4.1；
 * 为何 P1 只做两视图、P2 等 handoff 宿主 —— 见
 * .agents/notes/implemented/2026-10-23-agent-fleet-p1-and-config-surfaces.md
 */

import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SidebarRightNavigationParams,
  SidebarRightTabDefinition,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the `ctx.slots` Context merge (SlotRegistry) into this program.
// The renderer owns that service; a value import would drag a second copy of it
// into our bundle, which the client-purity rule forbids.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, SegmentedControl, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from '../dom.ts'
import { NS } from '../locales.ts'
import { Icon, ICON_REFRESH } from '../icons.ts'
import { createFleetController } from './controller.ts'
import { subagentChatAddress } from './address.ts'
import { useFleet } from './useFleet.ts'
import { GlobalView, SessionView } from './view.ts'

/** The tab type's implementation id: the package name, as DSH's registry expects. */
export const FLEET_TAB_ID = 'dsh-models-router'

/** The page kind the guide entry opens. */
export const FLEET_TAB_KIND = 'agent-fleet'

/** The guide entry identity within this type. */
export const FLEET_GUIDE_ID = 'agent-fleet'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The Fleet page's remembered scope and drilled session. */
    'agent-fleet': { view: 'global' | 'session'; sessionId?: SessionId }
  }
}

/** Narrow the tab's navigation parameters; no parameters means the global view. */
export function fleetParams(params: SidebarRightNavigationParams): { view: 'global' | 'session'; sessionId: SessionId | undefined } {
  if (params !== null && typeof params === 'object' && 'view' in params) {
    const value = params as { view?: unknown; sessionId?: unknown }
    return {
      view: value.view === 'session' ? 'session' : 'global',
      sessionId: typeof value.sessionId === 'string' ? value.sessionId as SessionId : undefined,
    }
  }
  return { view: 'global', sessionId: undefined }
}

/** The tab body: header (scope + refresh), then the global or single-session view. */
export function AgentFleetTab(props) {
  const t = props.t
  const { tab, sidebar } = props.useTabInfo()
  const params = fleetParams(tab.navigation.params)
  const view = params.view
  const viewSessionId = view === 'session' ? (params.sessionId ?? props.sessionId) : undefined
  // `tab.visible` is the native "this body is on screen" answer
  // (`ui-sidebar-right/src/client/tab-info.ts:46`); it owns scheduling, so a
  // hidden body stops the projection queue instead of stampeding the Host.
  const model = useFleet(props, viewSessionId, tab.visible)
  const pageHiddenState = useState(false)
  const pageHidden = pageHiddenState[0]
  const setPageHidden = pageHiddenState[1]
  // The scroll container, which exists only once the body has mounted: `null` is
  // "not attached yet", and the effect below narrows it before reading `scrollTop`.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const globalScroll = useRef(0)
  const sessionScroll = useRef(0)
  const lastView = useRef(view)

  useEffect(function () {
    if (typeof document === 'undefined') return function () {}
    function sync() { setPageHidden(document.visibilityState === 'hidden') }
    document.addEventListener('visibilitychange', sync)
    sync()
    return function () { document.removeEventListener('visibilitychange', sync) }
  }, [])

  useEffect(function () {
    const element = scrollRef.current
    if (element === null) return
    if (lastView.current !== view) {
      if (lastView.current === 'global') globalScroll.current = element.scrollTop
      else sessionScroll.current = element.scrollTop
      lastView.current = view
      element.scrollTop = view === 'global' ? globalScroll.current : sessionScroll.current
    }
  }, [view])

  function navigate(next: { view: 'global' | 'session'; sessionId?: SessionId }) {
    tab.actions.openTab(FLEET_TAB_KIND, { params: next })
  }

  function switchScope(next: string) {
    if (next === 'global') navigate({ view: 'global' })
    else navigate({ view: 'session', sessionId: props.sessionId })
  }

  function drill(sessionId: string) {
    navigate({ view: 'session', sessionId: sessionId as SessionId })
  }

  function openAside(childId: string) {
    const address = props.resolveSubagentAddress(childId)
    if (address === undefined || address === null) return
    tab.actions.openResource(subagentChatAddress(address), { kind: 'subagentchat', preferNewPane: true })
  }

  return h('div', {
    className: 'dsh-fleet',
    'data-visible': tab.visible ? 'true' : 'false',
    'data-page-hidden': pageHidden ? 'true' : 'false',
    'data-fullscreen': sidebar.fullscreen ? 'true' : 'false',
  },
    h('header', { className: 'dsh-fleet-head' },
      h('div', { className: 'dsh-fleet-column dsh-fleet-head-row' },
        h('div', { className: 'dsh-fleet-head-title' },
          h('h1', { className: 'dsh-fleet-title' }, t('fleetTabTitle')),
          h('span', { className: 'dsh-fleet-head-hint' }, t('fleetHeadHint'))),
        h(SegmentedControl, {
          id: 'fleet-scope',
          value: view,
          label: t('fleetScopeLabel'),
          options: [
            { value: 'global', label: t('fleetScopeGlobal') },
            { value: 'session', label: t('fleetScopeSession') },
          ],
          onChange: switchScope,
        }),
        h(Button, {
          size: 'sm',
          variant: 'ghost',
          icon: h(Icon, { d: ICON_REFRESH, size: 12 }),
          title: t('fleetRefresh'),
          'aria-label': t('fleetRefresh'),
          onClick: model.refreshAll,
        }, t('fleetRefresh')))),
    h('div', { className: 'dsh-fleet-body', ref: scrollRef },
      h('div', { className: 'dsh-fleet-column' },
        view === 'global'
          ? h(GlobalView, {
              t: t,
              model: model,
              currentSessionId: props.sessionId,
              onDrill: drill,
              onOpenSession: function (sessionId) { props.openSession(sessionId) },
            })
          : h(SessionView, {
              t: t,
              model: model,
              onBack: function () { navigate({ view: 'global' }) },
              onOpenSession: function (target) { props.openSession(target) },
              onOpenAside: openAside,
              copyText: props.copyText,
            }))))
}

/** Name the failing registration step before rethrowing into the boot audit. */
function guard<T>(label: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    // A failed dockkit registration otherwise reaches the boot page as a bare
    // "dsh-models-router: failed"; name the exact step in the console and
    // rethrow so the fiber still fails loudly.
    console.error(`model-router: ${label} failed`, error)
    throw error
  }
}

/**
 * Register the tab type and its body on the UI fiber.
 * @param ctx - the UI fiber's context (it carries sidebarRightTabs, slots, sessions, uiWorkspace).
 * @param t - namespace-bound translate.
 * @param scope - the plugin's settings scope, read only for chain names.
 */
export function registerAgentFleet(ctx: Context, t: (key: string) => string, scope): void {
  const controller = guard('fleet controller', () => createFleetController(ctx, { scope, t }))
  const definition: SidebarRightTabDefinition = {
    id: FLEET_TAB_ID,
    kind: FLEET_TAB_KIND,
    priority: 'extension',
    multiple: false,
    keepMounted: false,
    title: function () { return t('fleetTabTitle') },
    guide: [{
      id: FLEET_GUIDE_ID,
      order: 40,
      title: function () { return t('fleetGuideTitle') },
      description: function () { return t('fleetGuideHint') },
    }],
  }
  ctx.effect(function () {
    return guard('fleet tab type', () => ctx.sidebarRightTabs.register(definition))
  }, 'router: agent fleet tab type')
  ctx.effect(function () {
    return guard('fleet tab body', () => ctx.slots.inject('sidebar.right.pane.tab', function () {
      return guard('fleet tab seat', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: FLEET_TAB_ID,
        locale: NS,
        inject: function () {
          return {
            controller: controller,
            openSession: function (target) { ctx.uiWorkspace.openSession(target) },
            resolveSubagentAddress: function (childId) { return ctx.sessions.subagentAddress(childId as SessionId) },
            copyText: writeClipboard,
          }
        },
      }, AgentFleetTab))
    }))
  }, 'router: agent fleet tab body')
  ctx.effect(function () {
    return function () { controller.dispose() }
  }, 'router: agent fleet controller')
}
