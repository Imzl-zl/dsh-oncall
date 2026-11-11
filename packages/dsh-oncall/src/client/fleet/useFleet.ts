/**
 * The Fleet tab's data layer: native standard hooks in, view models out.
 *
 * No projection is read in JSX. The hook schedules the recent-session reads
 * through the controller, keeps the local search/filter state, and returns the
 * pure models from `model.ts`. The view is a function of this object.
 */

import { useEffect, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  FLEET_SCOPE_LIMIT,
  filterFleetRows,
  fleetGroups,
  fleetQueue,
  fleetRows,
  fleetScope,
  fleetSession,
  fleetSummary,
  topLevelSessions,
  type FleetFilter,
  type FleetGroup,
  type FleetQueueItem,
  type FleetRow,
  type FleetScope,
  type FleetSession,
  type FleetSummary,
} from './model.ts'
import type { FleetController } from './controller.ts'

export interface FleetHooks {
  readonly useSessions: <T>(selector: (state: SessionListState) => T) => T
  readonly useSessionStatus: <T>(selector: (state: SessionStatusSnapshot) => T) => T
  readonly useWorkspaces: <T>(selector: (state: WorkspaceSnapshot) => T) => T
}

export interface FleetRuntimeProps extends FleetHooks {
  readonly controller: FleetController
  readonly sessionId: string
  readonly resolveSubagentAddress: (childId: string) => unknown
  readonly t: (key: string) => string
}

export interface FleetModel {
  readonly list: SessionListState
  readonly statuses: SessionStatusSnapshot
  readonly workspaces: WorkspaceSnapshot
  readonly rows: readonly FleetRow[]
  readonly summary: FleetSummary
  readonly queue: readonly FleetQueueItem[]
  readonly groups: readonly FleetGroup[]
  readonly filteredGroups: readonly FleetGroup[]
  readonly filteredRows: readonly FleetRow[]
  readonly scope: FleetScope
  readonly session: FleetSession | undefined
  readonly listError: unknown
  readonly workspaceError: unknown
  readonly refreshing: boolean
  readonly query: string
  readonly filter: FleetFilter
  readonly now: number
  readonly setQuery: (value: string) => void
  readonly setFilter: (value: FleetFilter) => void
  readonly refreshAll: () => void
  readonly loadUnknown: () => void
  readonly loadSession: (sessionId: string) => void
}

/**
 * Read the native list/status/workspace sources and derive the Fleet models.
 * @param props - the slot's standard hooks plus the controller and navigation callbacks.
 * @param viewSessionId - the drilled session, or `undefined` for the global view.
 * @param visible - the tab's own visibility, from `useTabInfo`: it owns scheduling.
 * @returns every model and action the view paints.
 */
export function useFleet(
  props: FleetRuntimeProps,
  viewSessionId: string | undefined,
  visible: boolean,
): FleetModel {
  const list = props.useSessions((state) => state)
  const statuses = props.useSessionStatus((state) => state)
  const workspaces = props.useWorkspaces((state) => state)
  const controller = props.controller
  const [listError, setListError] = useState<unknown>(null)
  const [listAttempted, setListAttempted] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('all')
  const pulled = useRef(false)

  useEffect(() => controller.subscribe(() => setTick((tick) => tick + 1)), [controller])

  // F-06: the tab's visibility owns scheduling, not the plugin fiber. While the
  // body is hidden or unmounted the controller stops dispatching and drops
  // repaints; `refreshProjections` has no AbortSignal
  // (api/session-controller/src/client/contract/sessions.ts:101-106), so an
  // already-dispatched Host read keeps running and is folded in on resume.
  useEffect(() => {
    if (!visible) {
      controller.pause()
      return () => {}
    }
    controller.resume()
    return () => { controller.pause() }
  }, [controller, visible])

  useEffect(() => {
    if (!visible || pulled.current) return () => {}
    pulled.current = true
    setRefreshing(true)
    controller.refreshSessions().then(
      () => {
        setListError(null)
        setListAttempted(true)
        setRefreshing(false)
      },
      (error: unknown) => {
        setListError(error)
        setListAttempted(true)
        setRefreshing(false)
      },
    )
    return () => {}
  }, [controller, visible])

  const top = topLevelSessions(list)
  const scopeIds = top.slice(0, FLEET_SCOPE_LIMIT).map((summary) => summary.id)
  const scopeKey = scopeIds.join('|')
  useEffect(() => {
    if (list.phase === 'ready') controller.ensureSessions(scopeIds)
  }, [controller, list.phase, scopeKey])

  useEffect(() => {
    void controller.loadBinding(props.sessionId)
  }, [controller, props.sessionId])

  useEffect(() => {
    if (viewSessionId !== undefined) void controller.loadBinding(viewSessionId)
  }, [controller, viewSessionId])

  useEffect(() => {
    if (viewSessionId !== undefined) void controller.loadCarried(viewSessionId)
  }, [controller, viewSessionId])

  const childIds = viewSessionId === undefined
    ? []
    : (list.projectionsBySession[viewSessionId]?.values.subagentCatalog ?? []).map((child) => child.id)
  const childKey = childIds.join('|')
  useEffect(() => {
    if (viewSessionId !== undefined) controller.ensureChildren(viewSessionId, childIds)
  }, [controller, viewSessionId, childKey])

  const bindings = controller.bindingsSnapshot()
  const rows = fleetRows(list, statuses, bindings, controller.chainLabel)
  // F-07: `SessionListState` carries only ids/byId/phase/projectionsBySession
  // (`api/session-controller/src/client/sessions/service.ts:57-66`), so a failed
  // pull has no public error to read. `phase` is the public "no successful pull
  // yet" signal (`sessions/manager.ts:42`, initial value `:104-105`; it flips to
  // `ready` on the first successful host list inside `refreshList`, `:413-477`,
  // at `:443`). Manager's own `error` never reaches the store: the projection
  // sets only the four fields above (`service.ts:691`). A resolved refresh that
  // still leaves phase pending is therefore a failed read, not an empty list;
  // once a pull has succeeded the phase never falls back, so later failures keep
  // the last good list (documented partial gap, §9.3 F-07).
  const noSuccessfulPull = listAttempted && list.phase === 'pending'
  const effectiveListError = listError ?? (noSuccessfulPull ? new Error(props.t('fleetListNoPull')) : null)
  const summary = fleetSummary(rows, effectiveListError !== null)
  const queue = fleetQueue(rows)
  const groups = fleetGroups(rows, workspaces)
  const filteredRows = filterFleetRows(rows, query, filter)
  const filteredGroups = fleetGroups(filteredRows, workspaces)
  const session = viewSessionId === undefined
    ? undefined
    : fleetSession(
      list,
      statuses,
      viewSessionId,
      bindings,
      controller.chainLabel,
      workspaces,
      (childId) => props.resolveSubagentAddress(childId) !== undefined,
      props.sessionId,
      {
        carried: controller.carriedSnapshot().get(viewSessionId),
        config: controller.handoffBudgetConfig(),
      },
    )

  const refreshAll = (): void => {
    setRefreshing(true)
    controller.refreshSessions().then(
      () => { setListError(null); setListAttempted(true); setRefreshing(false) },
      (error: unknown) => { setListError(error); setListAttempted(true); setRefreshing(false) },
    )
    for (const id of scopeIds) controller.loadSession(id)
    if (viewSessionId !== undefined) controller.loadSession(viewSessionId)
    void controller.loadBinding(props.sessionId, true)
    if (viewSessionId !== undefined) {
      void controller.loadBinding(viewSessionId, true)
      void controller.loadCarried(viewSessionId, true)
    }
  }

  const loadUnknown = (): void => {
    for (const row of rows) {
      if (row.children === undefined) controller.loadSession(row.id)
    }
  }

  return {
    list,
    statuses,
    workspaces,
    rows,
    summary,
    queue,
    groups,
    filteredGroups,
    filteredRows,
    scope: fleetScope(rows),
    session,
    listError: effectiveListError,
    workspaceError: workspaces.state === 'error' ? workspaces.error : null,
    refreshing,
    query,
    filter,
    now: Date.now(),
    setQuery,
    setFilter,
    refreshAll,
    loadUnknown,
    loadSession: (sessionId) => controller.loadSession(sessionId),
  }
}
