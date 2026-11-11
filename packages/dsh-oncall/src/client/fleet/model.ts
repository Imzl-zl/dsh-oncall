/**
 * Pure derivations for the Agent Fleet tab.
 *
 * The view never reads a projection directly: everything it paints comes from
 * these functions, so the "unknown is not zero" rule is testable without React.
 * A missing projection is `undefined` (unknown); a ready projection that carries
 * an empty catalog is `[]` (a known zero). The two must never collapse.
 *
 * Data sources (all read-only, all native DSH):
 * - `SessionListState.projectionsBySession[id].values.subagentCatalog`
 * - `SessionListState.projectionsBySession[id].values.subagentTiming`
 * - `SessionListState.projectionsBySession[id].values.tokenUsage`
 * - `SessionListState.projectionsBySession[id].values.contextPressure`
 * - `SessionStatusSnapshot.get(id).running / pendingInteraction`
 *
 * Note: 右栏数据口径与“未知不是 0” —— 见 docs/design/agent-fleet-drawer.md §6；
 * 为何只统计已加载会话、为何保留 unknown 计数 —— 见
 * .agents/notes/implemented/2026-10-23-agent-fleet-p1-and-config-surfaces.md
 */

import type {
  SessionListState,
  SessionProjectionMap,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { SessionBindingView } from '../../types.ts'
import type { HandoffCarriedView } from '../../types.ts'
import {
  addCarried,
  HANDOFF_KEY,
  handoffCounters,
  type HandoffCountable,
  type HandoffRecord,
} from '../../handoff-wire.ts'
import { routeKeyOf } from '../../routes.ts'

type SubagentCatalogEntry = SessionProjectionMap['subagentCatalog'][number]
type SubagentTimingProjection = SessionProjectionMap['subagentTiming']
type TokenUsageProjection = SessionProjectionMap['tokenUsage']
type ContextPressureProjection = SessionProjectionMap['contextPressure']
type ModelSelectionProjection = SessionProjectionMap['modelSelection']

/** How many recent sessions the first paint may load projections for. */
export const FLEET_SCOPE_LIMIT = 20

/** How many projection reads may be in flight at once. */
export const FLEET_CONCURRENCY = 4

/** The pending-interaction kinds the workspace tree already treats as visible. */
export type FleetPendingKind = 'approval' | 'plan-review' | 'question'

/** The filter row above the groups. */
export type FleetFilter = 'all' | 'running' | 'pending' | 'anomaly'

/** A session row's coarse state. `undefined` means the status is not known. */
export type FleetSessionState = 'running' | 'pending' | 'anomaly' | 'idle' | 'unknown'

/** A direct child's coarse state. No review ledger exists in P1, so no "review" arm. */
export type FleetAgentState = 'running' | 'anomaly' | 'done' | 'idle' | 'unknown'

/** One direct child, as the cards and the topology paint it. */
export interface FleetAgent {
  readonly id: string
  readonly label: string
  readonly mode: SubagentCatalogEntry['mode']
  readonly state: FleetAgentState
  readonly running: boolean | undefined
  readonly lastTurnCompleted: boolean | undefined
  readonly model: { readonly provider: string; readonly model: string } | undefined
  readonly timing: SubagentTimingProjection | undefined
  readonly tokenUsage: TokenUsageProjection | undefined
  /** Child title when it is more than the creation label; otherwise absent. */
  readonly task: string | undefined
  /** settled + currently open interval, when the timing projection exists. */
  readonly durationMs: number | undefined
  /** Whether `sessions.subagentAddress(id)` can address this child. */
  readonly addressable: boolean
}

/** The handoff receipt kinds the projection actually folds (the fold writes no other kind). */
export type FleetActivityKind = 'delegate' | 'finish' | 'newSession' | 'facts'

/**
 * One row of the activity stream: what the model declared, when.
 *
 * Built only from the projection's own `records`; nothing here is derived from
 * task text or guessed from a running child.
 */
export interface FleetActivity {
  readonly at: number
  readonly kind: FleetActivityKind
  /** The roster role a `delegate` named. */
  readonly rosterId: string | undefined
  /** The outcome a `finish` declared. */
  readonly outcome: string | undefined
}

/** One budget's "已用 / 上限". Both numbers are known; the block is hidden otherwise. */
export interface FleetBudgetItem {
  readonly used: number
  readonly limit: number
}

/** The three per-user-message budgets D7 paints (delegations / reviews / new sessions). */
export interface FleetBudget {
  readonly delegations: FleetBudgetItem
  readonly reviews: FleetBudgetItem
  readonly newSessions: FleetBudgetItem
}

/** The configured limits plus which roster roles count as reviewers. */
export interface FleetBudgetConfig {
  readonly limits: { readonly delegations: number; readonly reviews: number; readonly newSessions: number }
  readonly reviewIds: ReadonlySet<string>
}

/**
 * What the fleet tab needs for D7.
 *
 * `carried` is the ledger's answer for this session: `undefined` means "not read
 * yet", which is *unknown* — the block stays hidden rather than painting the
 * projection's numbers as if nothing had been inherited.
 */
export interface FleetHandoffInput {
  readonly carried: HandoffCarriedView | undefined
  readonly config: FleetBudgetConfig | undefined
}

/** One session row in the global view. */
export interface FleetRow {
  readonly id: string
  readonly title: string
  readonly cwd: string | undefined
  readonly parentId: string | undefined
  readonly updatedAt: number
  readonly running: boolean | undefined
  readonly pending: FleetPendingKind | undefined
  readonly statusKnown: boolean
  readonly state: FleetSessionState
  /** `undefined` means the parent catalog projection is not loaded. */
  readonly children: readonly SubagentCatalogEntry[] | undefined
  readonly childrenRunning: number | undefined
  readonly childrenUnknown: number
  /** True only when a loaded child timing says its latest turn did not complete. */
  readonly anomaly: boolean | undefined
  readonly model: { readonly provider: string; readonly model: string } | undefined
  /** Chain display name from the plugin's session binding, when it was read. */
  readonly chain: string | undefined
  readonly tokenUsage: TokenUsageProjection | undefined
  readonly contextPressure: ContextPressureProjection | undefined
}

/** The four summary cells. `undefined` paints `—`, never `0`. */
export interface FleetSummary {
  readonly listError: boolean
  readonly runningSessions: number | undefined
  readonly runningSessionsUnknown: number
  readonly runningAgents: number | undefined
  readonly runningAgentsUnknown: number
  readonly pending: number | undefined
  readonly pendingUnknown: number
  readonly anomalies: number | undefined
  readonly anomaliesUnknown: number
  readonly childrenUnknown: number
}

/** One row in the pending queue. */
export interface FleetQueueItem {
  readonly row: FleetRow
  readonly kind: FleetPendingKind
}

/** One workspace group. */
export interface FleetGroup {
  readonly id: string
  readonly title: string
  readonly path: string | undefined
  readonly rows: readonly FleetRow[]
  readonly runningCount: number
}

/** The single-session view model. */
export interface FleetSession {
  readonly row: FleetRow
  readonly workspaceTitle: string | undefined
  readonly workspacePath: string | undefined
  readonly chain: string | undefined
  readonly retryOverrides: number
  readonly contextPercent: number | undefined
  readonly agents: readonly FleetAgent[]
  readonly topologyAgents: readonly FleetAgent[]
  readonly extraAgents: number
  readonly runningAgents: number
  readonly anomalyAgents: number
  readonly doneAgents: number
  readonly unknownAgents: number
  readonly catalogLoaded: boolean
  readonly readOnly: boolean
  /** Handoff receipts, newest first. `undefined` = the projection is not loaded. */
  readonly activity: readonly FleetActivity[] | undefined
  /** D7's three budgets. `undefined` = numeric unknown, so the block is hidden. */
  readonly budget: FleetBudget | undefined
}

const PENDING_ORDER: Readonly<Record<FleetPendingKind, number>> = {
  approval: 0,
  'plan-review': 1,
  question: 2,
}

const AGENT_ORDER: Readonly<Record<FleetAgentState, number>> = {
  running: 0,
  anomaly: 1,
  done: 2,
  idle: 3,
  unknown: 4,
}

/** The pending kind the workspace tree exposes, or `undefined` for any other domain request. */
export function pendingKindOf(kind: string | undefined): FleetPendingKind | undefined {
  if (kind === 'approval' || kind === 'plan-review' || kind === 'question') return kind
  return undefined
}

/** Top-level sessions: subagent children are shown under their parent, never as peers. */
export function topLevelSessions(list: SessionListState): SessionSummary[] {
  return list.ids
    .map((id) => list.byId[id])
    .filter((summary): summary is SessionSummary => summary !== undefined && summary.origin !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

/** The projection snapshot for one session, when the service has one. */
function projectionOf(list: SessionListState, sessionId: string): SessionProjectionMap | undefined {
  const snapshot = list.projectionsBySession[sessionId]
  if (snapshot === undefined || snapshot.state !== 'ready') return undefined
  return snapshot.values as SessionProjectionMap
}

const ACTIVITY_KINDS: ReadonlySet<string> = new Set(['delegate', 'finish', 'newSession', 'facts'])

function isActivityKind(value: unknown): value is FleetActivityKind {
  return typeof value === 'string' && ACTIVITY_KINDS.has(value)
}

/**
 * The plugin's own `oncall/handoff` projection, parsed once for two readers.
 *
 * `undefined` means the key is not in the snapshot (the plugin fiber is not
 * loaded, or the Host has not carried it yet) — the activity stream says "not
 * connected" and the budget block stays hidden, instead of painting zeros.
 * An empty `records` array is a known zero and gets its own sentences.
 */
function parseHandoff(list: SessionListState, sessionId: string): HandoffCountable | undefined {
  const projection = projectionOf(list, sessionId) as unknown as Record<string, unknown> | undefined
  if (projection === undefined) return undefined
  const handoff = projection[HANDOFF_KEY] as { epoch?: unknown; openTurn?: unknown; records?: unknown } | undefined
  if (handoff === undefined || handoff === null) return undefined
  const records: HandoffRecord[] = []
  for (const raw of Array.isArray(handoff.records) ? handoff.records : []) {
    if (typeof raw !== 'object' || raw === null) continue
    // `epoch` rides every receipt: the fold writes it so a row can say which user
    // message its budget belongs to. It was missing from this shape, not from the
    // data.
    const record = raw as { at?: unknown; kind?: unknown; epoch?: unknown; rosterId?: unknown; outcome?: unknown }
    const at = record.at
    const epoch = record.epoch
    if (typeof at !== 'number' || !Number.isFinite(at) || !isActivityKind(record.kind)) continue
    records.push({
      at,
      epoch: typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0,
      kind: record.kind,
      ...typeof record.rosterId === 'string' ? { rosterId: record.rosterId } : {},
      ...typeof record.outcome === 'string' ? { outcome: record.outcome } : {},
    })
  }
  const epoch = typeof handoff.epoch === 'number' && Number.isFinite(handoff.epoch) ? handoff.epoch : 0
  const openTurn = typeof handoff.openTurn === 'number' && Number.isFinite(handoff.openTurn) ? handoff.openTurn : undefined
  return { epoch, ...openTurn === undefined ? {} : { openTurn }, records }
}

/** The activity rows, newest first; the fold stores them oldest first. */
function activityOf(state: HandoffCountable): readonly FleetActivity[] {
  return state.records.slice().reverse().map(record => ({
    at: record.at,
    kind: record.kind,
    rosterId: record.rosterId,
    outcome: record.outcome,
  }))
}

/**
 * D7's three budgets: projection counts plus what a relay carried in.
 *
 * Hidden — not zeroed — when the projection is not loaded, when the carried
 * read has not answered, or when handoff is off. The addition is `addCarried`,
 * the same expression the gate refuses on.
 */
function budgetOf(state: HandoffCountable | undefined, handoff: FleetHandoffInput | undefined): FleetBudget | undefined {
  if (state === undefined || handoff === undefined) return undefined
  if (handoff.carried === undefined || handoff.config === undefined) return undefined
  const total = addCarried(handoffCounters(state, handoff.config.reviewIds), handoff.carried)
  return {
    delegations: { used: total.delegations, limit: handoff.config.limits.delegations },
    reviews: { used: total.reviews, limit: handoff.config.limits.reviews },
    newSessions: { used: total.newSessions, limit: handoff.config.limits.newSessions },
  }
}

/** `HH:mm` in the viewer's zone: the stream dates a row, it does not bucket it. */
export function formatActivityTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function statusOf(statuses: SessionStatusSnapshot, sessionId: string): SessionStatus | undefined {
  // `SessionId` is a branded string: the map is keyed by the Host's ids, and a
  // plain string is one by construction here (it comes from the session list, not
  // from user input). DSH itself casts at this boundary
  // (`ui-session/src/client/index.ts:502`: `Object.keys(list.byId) as SessionId[]`).
  return statuses.get(sessionId as SessionId)
}

function runningOf(status: SessionStatus | undefined, summary: SessionSummary | undefined): boolean | undefined {
  return status?.running ?? summary?.running
}

/** The model a session would use next, or `undefined` when the projection has none. */
function modelOf(projection: SessionProjectionMap | undefined): ModelSelectionProjection['next'] | undefined {
  return projection?.modelSelection?.next ?? undefined
}

function modelRoute(model: ModelSelectionProjection['next'] | undefined): { provider: string; model: string } | undefined {
  if (model === null || model === undefined) return undefined
  if (typeof model.provider !== 'string' || typeof model.model !== 'string') return undefined
  return { provider: model.provider, model: model.model }
}

function anomalyOf(
  list: SessionListState,
  children: readonly SubagentCatalogEntry[] | undefined,
): { value: boolean | undefined; unknown: number } {
  if (children === undefined) return { value: undefined, unknown: 0 }
  let sawFalse = false
  let sawUnknown = false
  for (const child of children) {
    const timing = projectionOf(list, child.id)?.subagentTiming
    if (timing === undefined) {
      sawUnknown = true
      continue
    }
    if (timing.lastTurnCompleted === false) sawFalse = true
  }
  return { value: sawFalse ? true : sawUnknown ? undefined : false, unknown: sawUnknown ? 1 : 0 }
}

/** Build one global row. Missing projections stay `undefined` all the way through. */
export function fleetRow(
  list: SessionListState,
  statuses: SessionStatusSnapshot,
  summary: SessionSummary,
  binding: SessionBindingView | undefined,
  chainLabel: (binding: SessionBindingView | undefined) => string | undefined,
): FleetRow {
  const projection = projectionOf(list, summary.id)
  const status = statusOf(statuses, summary.id)
  const children = projection?.subagentCatalog
  const childrenLoaded = Array.isArray(children)
  const pending = pendingKindOf(status?.pendingInteraction?.kind)
  const running = runningOf(status, summary)
  const anomaly = anomalyOf(list, childrenLoaded ? children : undefined)

  let childrenRunning: number | undefined
  let childrenUnknown = 0
  if (childrenLoaded) {
    childrenRunning = 0
    for (const child of children) {
      const childStatus = statusOf(statuses, child.id)
      const childSummary = list.byId[child.id]
      const childRunning = runningOf(childStatus, childSummary)
      if (childRunning === true) childrenRunning += 1
      if (childRunning === undefined) childrenUnknown += 1
    }
  }

  return {
    id: summary.id,
    title: summary.displayTitle,
    cwd: summary.cwd,
    parentId: summary.parentId,
    updatedAt: summary.updatedAt,
    running,
    pending,
    statusKnown: status !== undefined,
    state: running === true
      ? 'running'
      : anomaly.value === true
        ? 'anomaly'
        : pending !== undefined
          ? 'pending'
          : running === false
            ? 'idle'
            : 'unknown',
    children: childrenLoaded ? children : undefined,
    childrenRunning,
    childrenUnknown,
    anomaly: anomaly.value,
    model: modelRoute(modelOf(projection)),
    chain: chainLabel(binding),
    tokenUsage: projection?.tokenUsage,
    contextPressure: projection?.contextPressure,
  }
}

/** Every top-level row, in list order (updatedAt desc). */
export function fleetRows(
  list: SessionListState,
  statuses: SessionStatusSnapshot,
  bindings: ReadonlyMap<string, SessionBindingView | undefined>,
  chainLabel: (binding: SessionBindingView | undefined) => string | undefined,
): FleetRow[] {
  return topLevelSessions(list).map((summary) =>
    fleetRow(list, statuses, summary, bindings.get(summary.id), chainLabel))
}

/** The four summary cells, with unknown counts kept separate from zero. */
export function fleetSummary(rows: readonly FleetRow[], listError: boolean): FleetSummary {
  if (listError) {
    return {
      listError: true,
      runningSessions: undefined,
      runningSessionsUnknown: 0,
      runningAgents: undefined,
      runningAgentsUnknown: 0,
      pending: undefined,
      pendingUnknown: 0,
      anomalies: undefined,
      anomaliesUnknown: 0,
      childrenUnknown: 0,
    }
  }
  const knownRunning = rows.filter((row) => row.running !== undefined)
  const runningSessions = rows.length === 0
    ? 0
    : knownRunning.length === 0
      ? undefined
      : knownRunning.filter((row) => row.running === true).length
  const loaded = rows.filter((row) => row.children !== undefined)
  const runningAgents = rows.length === 0
    ? 0
    : loaded.length === 0
      ? undefined
      : loaded.reduce((sum, row) => sum + (row.childrenRunning ?? 0), 0)
  const knownStatus = rows.filter((row) => row.statusKnown)
  const pending = rows.length === 0
    ? 0
    : knownStatus.length === 0
      ? undefined
      : knownStatus.filter((row) => row.pending !== undefined).length
  const knownAnomaly = rows.filter((row) => row.anomaly !== undefined)
  const anomalies = rows.length === 0
    ? 0
    : knownAnomaly.length === 0
      ? undefined
      : knownAnomaly.filter((row) => row.anomaly === true).length
  return {
    listError: false,
    runningSessions,
    runningSessionsUnknown: rows.length - knownRunning.length,
    runningAgents,
    runningAgentsUnknown: rows.length - loaded.length,
    pending,
    pendingUnknown: rows.length - knownStatus.length,
    anomalies,
    anomaliesUnknown: rows.length - knownAnomaly.length,
    childrenUnknown: rows.reduce((sum, row) => sum + (row.children === undefined ? 0 : row.childrenUnknown), 0),
  }
}

/** Pending rows, approval → plan-review → question, then newest first. */
export function fleetQueue(rows: readonly FleetRow[]): FleetQueueItem[] {
  return rows
    .filter((row): row is FleetRow & { pending: FleetPendingKind } => row.pending !== undefined)
    .map((row) => ({ row, kind: row.pending }))
    .sort((left, right) =>
      PENDING_ORDER[left.kind] - PENDING_ORDER[right.kind] || right.row.updatedAt - left.row.updatedAt)
}

/** The workspace a session belongs to, from the Workspace controller's manual order. */
export function workspaceOf(
  workspaces: WorkspaceSnapshot,
  sessionId: string,
): WorkspaceView | undefined {
  return workspaces.items.find((workspace) => (workspace.sessionIds as readonly string[]).includes(sessionId))
}

/** Group rows by workspace, preserving Host workspace order; strays go last. */
export function fleetGroups(
  rows: readonly FleetRow[],
  workspaces: WorkspaceSnapshot,
): FleetGroup[] {
  const groups: FleetGroup[] = []
  const claimed = new Set<string>()
  for (const workspace of workspaces.items) {
    const members = rows.filter((row) => (workspace.sessionIds as readonly string[]).includes(row.id))
    if (members.length === 0) continue
    for (const row of members) claimed.add(row.id)
    groups.push({
      id: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      rows: sortGroupRows(members),
      runningCount: members.filter((row) => row.running === true).length,
    })
  }
  const strays = rows.filter((row) => !claimed.has(row.id))
  if (strays.length > 0) {
    groups.push({
      id: '__ungrouped__',
      title: '',
      path: undefined,
      rows: sortGroupRows(strays),
      runningCount: strays.filter((row) => row.running === true).length,
    })
  }
  return groups
}

function sortGroupRows(rows: readonly FleetRow[]): FleetRow[] {
  return rows.slice().sort((left, right) => {
    const leftRunning = left.running === true ? 0 : 1
    const rightRunning = right.running === true ? 0 : 1
    return leftRunning - rightRunning || right.updatedAt - left.updatedAt
  })
}

/** Local search/filter over the already-loaded rows; never triggers a read. */
export function filterFleetRows(
  rows: readonly FleetRow[],
  query: string,
  filter: FleetFilter,
): FleetRow[] {
  const needle = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter === 'running' && row.running !== true) return false
    if (filter === 'pending' && row.pending === undefined) return false
    if (filter === 'anomaly' && row.anomaly !== true) return false
    if (needle === '') return true
    const haystack = [
      row.title,
      row.cwd ?? '',
      row.model === undefined ? '' : routeKeyOf(row.model.provider, row.model.model),
      row.chain ?? '',
      ...(row.children ?? []).map((child) => child.label ?? ''),
    ].join('\n').toLowerCase()
    return haystack.includes(needle)
  })
}

function agentStateOf(
  running: boolean | undefined,
  timing: SubagentTimingProjection | undefined,
): FleetAgentState {
  if (running === true) return 'running'
  if (timing?.lastTurnCompleted === false) return 'anomaly'
  if (timing?.lastTurnCompleted === true) return 'done'
  if (running === false && timing !== undefined) return 'idle'
  return 'unknown'
}

function durationOf(timing: SubagentTimingProjection | undefined): number | undefined {
  if (timing === undefined) return undefined
  const active = timing.active === undefined ? 0 : Math.max(0, timing.active.through - timing.active.since)
  return Math.max(0, timing.settledMs) + active
}

function fleetAgent(
  list: SessionListState,
  statuses: SessionStatusSnapshot,
  entry: SubagentCatalogEntry,
  addressable: boolean,
): FleetAgent {
  const projection = projectionOf(list, entry.id)
  const status = statusOf(statuses, entry.id)
  const summary = list.byId[entry.id]
  const running = runningOf(status, summary)
  const timing = projection?.subagentTiming
  const label = entry.label ?? entry.id
  const title = summary?.title
  return {
    id: entry.id,
    label,
    mode: entry.mode,
    state: agentStateOf(running, timing),
    running,
    lastTurnCompleted: timing?.lastTurnCompleted,
    model: modelRoute(modelOf(projection)),
    timing,
    tokenUsage: projection?.tokenUsage,
    task: title !== undefined && title !== '' && title !== label ? title : undefined,
    durationMs: durationOf(timing),
    addressable,
  }
}

/** The single-session view: root, direct children, budgets, activity. */
export function fleetSession(
  list: SessionListState,
  statuses: SessionStatusSnapshot,
  sessionId: string,
  bindings: ReadonlyMap<string, SessionBindingView | undefined>,
  chainLabel: (binding: SessionBindingView | undefined) => string | undefined,
  workspaces: WorkspaceSnapshot,
  addressable: (childId: string) => boolean,
  currentSessionId: string,
  handoff?: FleetHandoffInput,
): FleetSession | undefined {
  const summary = list.byId[sessionId]
  if (summary === undefined) return undefined
  const binding = bindings.get(sessionId)
  const row = fleetRow(list, statuses, summary, binding, chainLabel)
  const workspace = workspaceOf(workspaces, sessionId)
  const children = row.children ?? []
  const agents = children
    .map((entry) => fleetAgent(list, statuses, entry, addressable(entry.id)))
    .sort((left, right) => AGENT_ORDER[left.state] - AGENT_ORDER[right.state] || left.id.localeCompare(right.id))
  const pressure = row.contextPressure
  const contextPercent = pressure?.projectedTokens !== undefined && pressure.contextWindow !== undefined && pressure.contextWindow > 0
    ? Math.round((pressure.projectedTokens / pressure.contextWindow) * 100)
    : undefined
  const handoffState = parseHandoff(list, sessionId)
  return {
    row,
    workspaceTitle: workspace?.title,
    workspacePath: workspace?.path,
    chain: row.chain,
    retryOverrides: binding === undefined ? 0 : Object.keys(binding.retries).length,
    contextPercent,
    agents,
    topologyAgents: agents.slice(0, 8),
    extraAgents: Math.max(0, agents.length - 8),
    runningAgents: agents.filter((agent) => agent.state === 'running').length,
    anomalyAgents: agents.filter((agent) => agent.state === 'anomaly').length,
    doneAgents: agents.filter((agent) => agent.state === 'done').length,
    unknownAgents: agents.filter((agent) => agent.state === 'unknown').length,
    catalogLoaded: row.children !== undefined,
    readOnly: sessionId !== currentSessionId,
    activity: handoffState === undefined ? undefined : activityOf(handoffState),
    budget: budgetOf(handoffState, handoff),
  }
}

/** Compact token count for a card/header: 1234 → 1.2k. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** Total provider-reported tokens: the four buckets are disjoint. */
export function totalTokens(usage: TokenUsageProjection | undefined): number | undefined {
  if (usage === undefined) return undefined
  return Math.max(0, usage.uncachedInputTokens)
    + Math.max(0, usage.outputTokens)
    + Math.max(0, usage.cacheReadTokens)
    + Math.max(0, usage.cacheWriteTokens)
}

/** The data-scope line's numbers. */
export interface FleetScope {
  readonly total: number
  readonly scope: number
  readonly loaded: number
  readonly unknown: number
}

export function fleetScope(rows: readonly FleetRow[], limit = FLEET_SCOPE_LIMIT): FleetScope {
  // `scope` is the first-paint budget, not a cap on what the user may load:
  // "load unknown" can make every row known, and the line must say so.
  const loaded = rows.filter((row) => row.children !== undefined).length
  return {
    total: rows.length,
    scope: Math.min(rows.length, limit),
    loaded,
    unknown: rows.length - loaded,
  }
}
