/**
 * The Agent Fleet tab's presentation.
 *
 * Every value comes from `useFleet`/`model.ts`; this file only chooses the
 * native primitive and the DOM shape. The carrier is the dockkit tab body, so
 * there is no drawer, mask, close button or fullscreen button here.
 *
 * Density is a container-query decision (344 / 648 / >=700), never a viewport
 * decision: the right column is draggable and each docked pane has its own
 * width. Unknown values paint `—` or "未知"; they never become `0`.
 *
 * Note: 容器断点、动效与可访问性 —— 见 docs/design/agent-fleet-drawer.md §4.2/§7；
 * 为何长标题/折叠行走原生 Tooltip/DisclosureRow、为何只有一个流动点 —— 见
 * .agents/notes/implemented/2026-10-23-agent-fleet-capability-review.md
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  DisclosureRow,
  IconFolderCloseRegular,
  Input,
  PathLabel,
  SegmentedControl,
  StateDot,
  Tag,
  Tooltip,
  relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from '../dom.ts'
import { OfficeRoom } from './office-view.ts'
import { fill } from '../format.ts'
import { routeKeyOf } from '../../routes.ts'
import { Icon, ICON_ARROW_LEFT, ICON_REFRESH } from '../icons.ts'
import {
  formatActivityTime,
  formatTokenCount,
  totalTokens,
  type FleetActivity,
  type FleetActivityKind,
  type FleetAgent,
  type FleetAgentState,
  type FleetBudget,
  type FleetBudgetItem,
  type FleetGroup,
  type FleetPendingKind,
  type FleetQueueItem,
  type FleetRow,
  type FleetSession,
  type FleetSessionState,
  type FleetSummary,
} from './model.ts'
import type { FleetModel } from './useFleet.ts'

/** The dot state a session/agent state paints. */
function dotOf(state: FleetSessionState | FleetAgentState): StateDotState {
  if (state === 'running') return 'ongoing'
  if (state === 'pending') return 'warning'
  if (state === 'anomaly') return 'error'
  if (state === 'done') return 'done'
  return 'idle'
}

/**
 * One tooltip around its anchor.
 *
 * `Tooltip` takes its anchor as the required `children` prop, and React's
 * `createElement` typing wants a required prop in the props argument — a
 * positional child satisfies JSX, not `h()`. This wrapper states the anchor once,
 * so the five call sites below read like the JSX they replace, and the element it
 * passes is untouched (same props, same tree). The anchor type is derived from
 * the component itself, so a future change there is a type error here.
 */
type TooltipAnchor = Parameters<typeof Tooltip>[0]['children']

function tooltip(label: string, child: ReactElement): ReactElement {
  // `Tooltip`'s anchor is `ReactElement<AnchorProps>`, and every `AnchorProps`
  // member is optional — which makes it a weak type: an anchor that happens to
  // carry none of them (the plain `div` around an agent's task text) is rejected
  // even though a div takes exactly the ref and handlers Tooltip injects. One
  // cast, here, at the DSH boundary, instead of one per anchor.
  return h(Tooltip, { label: label, children: child as TooltipAnchor })
}

function stateLabel(t, state: FleetSessionState | FleetAgentState): string {
  if (state === 'running') return t('fleetStatusRunning')
  if (state === 'pending') return t('fleetStatusPending')
  if (state === 'anomaly') return t('fleetAgentAnomaly')
  if (state === 'done') return t('fleetAgentDone')
  if (state === 'idle') return t('fleetStatusIdle')
  return t('fleetStatusUnknown')
}

function pendingLabel(t, kind: FleetPendingKind): string {
  if (kind === 'approval') return t('fleetPendingApproval')
  if (kind === 'plan-review') return t('fleetPendingPlanReview')
  return t('fleetPendingQuestion')
}

function modeLabel(t, mode: string): string {
  if (mode === 'one-shot') return t('fleetModeOneShot')
  if (mode === 'continuable') return t('fleetModeContinuable')
  if (mode === 'external') return t('fleetModeExternal')
  return t('fleetModeUnknown')
}

function modelLabel(model: { provider: string; model: string } | undefined, t): string {
  return model === undefined ? t('fleetUnknown') : routeKeyOf(model.provider, model.model)
}

function relativeLabel(t, at: number, now: number): string {
  const bucket = relativeTime(at, now)
  if (bucket.unit === 'now') return t('fleetTimeNow')
  const key = bucket.unit === 'minutes' ? 'fleetTimeMinutes'
    : bucket.unit === 'hours' ? 'fleetTimeHours'
      : bucket.unit === 'days' ? 'fleetTimeDays'
        : bucket.unit === 'months' ? 'fleetTimeMonths'
          : 'fleetTimeYears'
  return fill(t(key), { n: bucket.n })
}

function durationLabel(t, ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  if (ms < 1000) return fill(t('fleetDurationMs'), { n: Math.round(ms) })
  if (ms < 60_000) return fill(t('fleetDurationSeconds'), { n: (ms / 1000).toFixed(1) })
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  if (minutes < 60) return fill(t('fleetDurationMinutes'), { m: minutes, s: seconds })
  return fill(t('fleetDurationHours'), { h: Math.floor(minutes / 60), m: minutes % 60 })
}

function tokenLabel(t, usage): string | undefined {
  const total = totalTokens(usage)
  return total === undefined ? undefined : fill(t('fleetTokenTotal'), { n: formatTokenCount(total) })
}

function tokenTitle(t, usage): string | undefined {
  if (usage === undefined) return undefined
  return fill(t('fleetTokenTitle'), {
    input: formatTokenCount(usage.uncachedInputTokens),
    output: formatTokenCount(usage.outputTokens),
    cacheRead: formatTokenCount(usage.cacheReadTokens),
    cacheWrite: formatTokenCount(usage.cacheWriteTokens),
  })
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (error === null || error === undefined) return ''
  return String(error)
}

function StatusLine(props) {
  return h('span', { className: 'dsh-fleet-status' },
    h(StateDot, { state: dotOf(props.state), size: 8, className: 'dsh-fleet-status-dot' }),
    h('span', { className: 'dsh-fleet-status-text' }, props.label))
}

function SummaryCell(props) {
  return h('div', { className: 'dsh-fleet-summary-cell' },
    h('div', { className: 'dsh-fleet-summary-value' }, props.value === undefined ? '—' : String(props.value)),
    h('div', { className: 'dsh-fleet-summary-label' }, props.label),
    props.sub === undefined || props.sub === null ? null : h('div', { className: 'dsh-fleet-summary-sub' }, props.sub))
}

function Summary(props) {
  const t = props.t
  const summary: FleetSummary = props.summary
  const loading = props.loading
  // A partial sample is not a count. When any session in the cell's scope is
  // unknown, the value is `—` and the subtitle names how many are unknown.
  const value = (next: number | undefined, unknown: number): number | undefined =>
    loading || unknown > 0 ? undefined : next
  return h('div', { className: 'dsh-fleet-summary' },
    h(SummaryCell, {
      label: t('fleetSummaryRunningSessions'),
      value: value(summary.runningSessions, summary.runningSessionsUnknown),
      sub: summary.runningSessionsUnknown > 0
        ? fill(t('fleetUnknownSessions'), { n: summary.runningSessionsUnknown })
        : null,
    }),
    h(SummaryCell, {
      label: t('fleetSummaryRunningAgents'),
      value: value(summary.runningAgents, summary.runningAgentsUnknown),
      sub: summary.runningAgentsUnknown > 0
        ? fill(t('fleetUnknownSessions'), { n: summary.runningAgentsUnknown })
        : summary.childrenUnknown > 0
          ? fill(t('fleetUnknownChildren'), { n: summary.childrenUnknown })
          : null,
    }),
    h(SummaryCell, {
      label: t('fleetSummaryPending'),
      value: value(summary.pending, summary.pendingUnknown),
      sub: summary.pendingUnknown > 0
        ? fill(t('fleetUnknownSessions'), { n: summary.pendingUnknown })
        : null,
    }),
    h(SummaryCell, {
      label: t('fleetSummaryAnomalies'),
      value: value(summary.anomalies, summary.anomaliesUnknown),
      sub: summary.anomaliesUnknown > 0
        ? fill(t('fleetUnknownSessions'), { n: summary.anomaliesUnknown })
        : null,
    }))
}

function PendingQueue(props) {
  const t = props.t
  const items: readonly FleetQueueItem[] = props.items
  if (items.length === 0) return null
  const shown = items.slice(0, 4)
  return h('section', { className: 'dsh-fleet-queue', 'aria-label': t('fleetPendingQueueTitle') },
    h('div', { className: 'dsh-fleet-section-head' },
      h('h2', { className: 'dsh-fleet-section-title' }, t('fleetPendingQueueTitle')),
      h('span', { className: 'dsh-fleet-section-count' }, items.length)),
    h('ul', { className: 'dsh-fleet-queue-list' },
      shown.map((item) => h('li', { key: item.row.id + ':' + item.kind },
        // A focusable row whose text can be elided gets the native Tooltip; the
        // spans below it keep their plain `title` because they are not tab stops.
        tooltip(item.row.title,
          h('button', {
            type: 'button',
            className: 'dsh-fleet-queue-row',
            onClick: function () { props.onOpenSession(item.row.id) },
          },
            h(StateDot, { state: 'warning', size: 8 }),
            h('span', { className: 'dsh-fleet-queue-title' }, item.row.title),
            h(Tag, { tone: 'warning' }, pendingLabel(t, item.kind)),
            h('span', { className: 'dsh-fleet-queue-time' }, relativeLabel(t, item.row.updatedAt, props.now))))))),
    items.length > shown.length
      ? h('p', { className: 'dsh-fleet-hint' }, fill(t('fleetPendingMore'), { n: items.length - shown.length }))
      : null)
}

function Toolbar(props) {
  const t = props.t
  return h('div', { className: 'dsh-fleet-toolbar' },
    h('div', { className: 'dsh-fleet-search' },
      h(Input, {
        value: props.query,
        placeholder: t('fleetSearchPlaceholder'),
        'aria-label': t('fleetSearchPlaceholder'),
        onChange: function (event) { props.onQuery(event.target.value) },
      })),
    h(SegmentedControl, {
      id: 'fleet-filter',
      value: props.filter,
      label: t('fleetFilterLabel'),
      options: [
        { value: 'all', label: t('fleetFilterAll') },
        { value: 'running', label: t('fleetFilterRunning') },
        { value: 'pending', label: t('fleetFilterPending') },
        { value: 'anomaly', label: t('fleetFilterAnomaly') },
      ],
      onChange: function (next) { props.onFilter(next) },
    }))
}

function SessionRow(props) {
  const t = props.t
  const row: FleetRow = props.row
  const childrenText = row.children === undefined
    ? t('fleetRowUnknownAgents')
    : row.children.length === 0
      ? t('fleetRowNoAgents')
      : fill(t('fleetRowAgents'), { n: row.children.length })
  const runningText = row.childrenRunning === undefined || row.childrenRunning === 0
    ? null
    : fill(t('fleetRowRunningAgents'), { n: row.childrenRunning })
  return h('li', { className: 'dsh-fleet-session-row' + (props.current ? ' is-current' : '') },
    // The drill target is one focusable button; the Tooltip replaces its native
    // `title`, which keyboard users never see. Inner meta spans keep `title`.
    tooltip(row.title,
      h('button', {
        type: 'button',
        className: 'dsh-fleet-session-main',
        'aria-current': props.current ? 'true' : undefined,
        onClick: function () { props.onDrill(row.id) },
      },
        h(StatusLine, { state: row.state, label: stateLabel(t, row.state) }),
        h('span', { className: 'dsh-fleet-session-title' }, row.title),
        h('span', { className: 'dsh-fleet-session-meta' },
          h('span', { className: 'dsh-fleet-row-model', title: modelLabel(row.model, t) }, modelLabel(row.model, t)),
          row.chain === undefined
            ? null
            : h('span', { className: 'dsh-fleet-row-chain', title: fill(t('fleetRowChain'), { name: row.chain }) },
                fill(t('fleetRowChain'), { name: row.chain })),
          h('span', { className: 'dsh-fleet-row-agents' }, childrenText),
          runningText === null ? null : h('span', { className: 'dsh-fleet-row-running' }, runningText),
          h('span', { className: 'dsh-fleet-row-time' }, relativeLabel(t, row.updatedAt, props.now))))),
    h('button', {
      type: 'button',
      className: 'dsh-fleet-session-open',
      title: fill(t('fleetRowOpenAria'), { title: row.title }),
      'aria-label': fill(t('fleetRowOpenAria'), { title: row.title }),
      onClick: function () { props.onOpenSession(row.id) },
    }, t('fleetOpenShort')))
}

function GroupList(props) {
  const t = props.t
  const [collapsed, setCollapsed] = useState({})
  function toggle(id: string) {
    setCollapsed(Object.assign({}, collapsed, { [id]: !collapsed[id] }))
  }
  return h('div', { className: 'dsh-fleet-groups' },
    props.groups.map(function (group: FleetGroup) {
      const isCollapsed = collapsed[group.id] === true
      // DSH's own 24px disclosure row owns the toggle, the chevron cross-fade,
      // Enter/Space and `aria-expanded`; the group only supplies its content.
      // The workspace path rides `collapsedContent` (kept while open) and the
      // counts are a non-interactive accessory beside the title row.
      return h(DisclosureRow, {
        key: group.id,
        className: 'dsh-fleet-group-disclosure',
        icon: h(IconFolderCloseRegular),
        title: group.title === '' ? t('fleetUnassigned') : group.title,
        open: !isCollapsed,
        expandable: true,
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        titleClassName: 'dsh-fleet-group-title',
        contentClassName: 'dsh-fleet-group-text',
        contentLayoutClassName: 'dsh-fleet-group-content',
        collapsedContent: group.path === undefined
          ? null
          // DSH's `PathLabel` instead of a hand-rolled ellipsised span: it keeps the
          // trailing segment (the part that identifies a workspace) visible, fades the
          // clipped left edge, and carries the full path on hover itself — so no
          // `title` of ours to lose.
          : h(PathLabel, { className: 'dsh-fleet-group-path', path: group.path }),
        headerAccessory: h('span', { className: 'dsh-fleet-group-counts' },
          fill(t('fleetGroupCounts'), { running: group.runningCount, sessions: group.rows.length })),
        onToggle: function () { toggle(group.id) },
      },
        isCollapsed
          ? null
          : h('ul', { className: 'dsh-fleet-session-list' },
              group.rows.map(function (row) {
                return h(SessionRow, {
                  key: row.id,
                  t: t,
                  row: row,
                  current: row.id === props.currentSessionId,
                  now: props.now,
                  onDrill: props.onDrill,
                  onOpenSession: props.onOpenSession,
                })
              })))
    }))
}

function DataScope(props) {
  const t = props.t
  const scope = props.model.scope
  const text = scope.loaded === scope.total
    ? fill(t('fleetDataScopeAll'), { loaded: scope.loaded, total: scope.total })
    : fill(t('fleetDataScopeMore'), { scope: scope.scope, loaded: scope.loaded, total: scope.total, unknown: scope.unknown })
  return h('div', { className: 'dsh-fleet-data-scope' },
    props.model.workspaceError === null || props.model.workspaceError === undefined
      ? null
      : h('p', { className: 'dsh-fleet-hint dsh-fleet-warning', role: 'status' },
          fill(t('fleetWorkspaceError'), { reason: errorText(props.model.workspaceError) })),
    h('div', { className: 'dsh-fleet-data-scope-row' },
      h('span', { className: 'dsh-fleet-data-scope-text' }, text),
      h('div', { className: 'dsh-fleet-data-scope-actions' },
        scope.unknown > 0
          ? h(Button, { size: 'sm', variant: 'ghost', onClick: props.model.loadUnknown }, t('fleetLoadUnknown'))
          : null,
        h(Button, {
          size: 'sm',
          variant: 'ghost',
          icon: h(Icon, { d: ICON_REFRESH, size: 12 }),
          onClick: props.model.refreshAll,
          title: t('fleetRefresh'),
        }, t('fleetRefresh')))))
}

function EmptyState(props) {
  return h('div', { className: 'dsh-fleet-state', role: 'status' },
    h('p', { className: 'dsh-fleet-state-title' }, props.title),
    props.hint === undefined ? null : h('p', { className: 'dsh-fleet-hint' }, props.hint))
}

function LoadingState(props) {
  return h('div', { className: 'dsh-fleet-state', role: 'status' },
    h('p', { className: 'dsh-fleet-state-title' }, props.t('fleetLoading')),
    h('div', { className: 'dsh-fleet-skeleton' },
      h('span', null), h('span', null), h('span', null)))
}

function ErrorCard(props) {
  return h('div', { className: 'dsh-fleet-error', role: 'alert' },
    h('p', { className: 'dsh-fleet-error-title' }, props.t('fleetListErrorTitle')),
    h('p', { className: 'dsh-fleet-hint' }, props.t('fleetListErrorHint')),
    props.detail === '' ? null : h('p', { className: 'dsh-fleet-error-detail' }, props.detail),
    h(Button, { size: 'sm', variant: 'outline', onClick: props.onRetry }, props.t('fleetRetry')))
}

export function GlobalView(props) {
  const t = props.t
  const model: FleetModel = props.model
  const loading = model.list.phase !== 'ready' && model.listError === null
  const error = model.listError !== null
  const noRows = model.rows.length === 0
  const noMatch = !noRows && model.filteredRows.length === 0
  return h('div', { className: 'dsh-fleet-global' },
    h(Summary, { t: t, summary: model.summary, loading: loading || error }),
    error
      ? h(ErrorCard, { t: t, detail: errorText(model.listError), onRetry: model.refreshAll })
      : loading
        ? h(LoadingState, { t: t })
        : noRows
          ? h(EmptyState, { title: t('fleetEmptyTitle'), hint: t('fleetEmptyHint') })
          : h('div', { className: 'dsh-fleet-global-body' },
              h(PendingQueue, {
                t: t,
                items: model.queue,
                now: model.now,
                onOpenSession: props.onOpenSession,
              }),
              h(Toolbar, {
                t: t,
                query: model.query,
                filter: model.filter,
                onQuery: model.setQuery,
                onFilter: model.setFilter,
              }),
              noMatch
                ? h('div', { className: 'dsh-fleet-state', role: 'status' },
                    h('p', { className: 'dsh-fleet-state-title' }, t('fleetNoMatch')),
                    h(Button, {
                      size: 'sm',
                      variant: 'outline',
                      onClick: function () { model.setQuery(''); model.setFilter('all') },
                    }, t('fleetClearFilters')))
                : h(GroupList, {
                    t: t,
                    groups: model.filteredGroups,
                    currentSessionId: props.currentSessionId,
                    now: model.now,
                    onDrill: props.onDrill,
                    onOpenSession: props.onOpenSession,
                  }),
              h(DataScope, { t: t, model: model })))
}

function initialOf(label: string): string {
  const text = String(label).trim()
  return text === '' ? '?' : (Array.from(text)[0] as string)
}

function shortSessionId(id: string): string {
  return id.startsWith('session-') ? id.slice(8, 16) : id.slice(0, 8)
}

function Topology(props) {
  const t = props.t
  const session: FleetSession = props.session
  const agents = session.topologyAgents
  const activeIndex = agents.findIndex((agent) => agent.state === 'running')
  const aria = fill(t('fleetTopologyAria'), {
    state: stateLabel(t, session.row.state),
    n: session.agents.length,
    running: session.runningAgents,
    anomaly: session.anomalyAgents,
  })
  return h('section', { className: 'dsh-fleet-topology', role: 'group', 'aria-label': aria },
    h('div', { className: 'dsh-fleet-section-head' },
      h('h2', { className: 'dsh-fleet-section-title' }, t('fleetTopologyTitle')),
      h('span', { className: 'dsh-fleet-section-count' }, fill(t('fleetSessionAgentsCount'), { n: session.agents.length })),
      h('span', { className: 'dsh-fleet-section-hint' },
        fill(t('fleetTopologyCounts'), { running: session.runningAgents, anomaly: session.anomalyAgents }))),
    h('div', { className: 'dsh-fleet-topology-root' },
      tooltip(session.row.title,
        h('button', {
          type: 'button',
          className: 'dsh-fleet-topology-root-main' + (session.row.running === true ? ' is-live' : ''),
          onClick: function () { props.onOpenSession(session.row.parentId ?? session.row.id) },
        },
          h('span', { className: 'dsh-fleet-topology-avatar', 'aria-hidden': 'true' }, initialOf(session.row.title)),
          h('span', { className: 'dsh-fleet-topology-root-text' },
            h('span', { className: 'dsh-fleet-topology-kicker' }, t('fleetTopologyRoot')),
            h('span', { className: 'dsh-fleet-topology-title' }, session.row.title)),
          h(StatusLine, { state: session.row.state, label: stateLabel(t, session.row.state) }))),
      // The shared rail: one stem from the root, one line over the chips, one
      // short stem per chip. It is decoration and carries no meaning by itself.
      h('div', { className: 'dsh-fleet-topo-rail', 'aria-hidden': 'true' }),
      h('div', {
        className: 'dsh-fleet-topology-chips',
        role: 'group',
        'aria-label': fill(t('fleetTopologyChildrenAria'), { n: agents.length }),
      },
        agents.map(function (agent, index) {
          const label = agent.label + ' · ' + stateLabel(t, agent.state)
          const active = index === activeIndex
          return h('button', {
            key: agent.id,
            type: 'button',
            className: 'dsh-fleet-chip' + (active ? ' is-active' : ''),
            title: label,
            'aria-label': label,
            onClick: function () { props.onOpenSession(agent.id) },
          },
            h('span', { className: 'dsh-fleet-chip-initial', 'aria-hidden': 'true' }, initialOf(agent.label)),
            h(StateDot, { state: dotOf(agent.state), size: 6, className: 'dsh-fleet-chip-dot' }),
            // Only the first running child drips: activity, not health. The root
            // pulse plus this dot are the view's two continuous animations.
            active ? h('span', { className: 'dsh-fleet-chip-flow', 'aria-hidden': 'true' }) : null)
        }),
        session.extraAgents > 0
          ? h('span', { className: 'dsh-fleet-chip dsh-fleet-chip-more', 'aria-hidden': 'true' },
              fill(t('fleetTopologyMore'), { n: session.extraAgents }))
          : null),
      h('div', { className: 'dsh-fleet-topology-legend' },
        h('span', null, h(StateDot, { state: 'ongoing', size: 6 }), t('fleetStatusRunning')),
        h('span', null, h(StateDot, { state: 'error', size: 6 }), t('fleetTopologyLegendAnomaly')),
        h('span', null, h(StateDot, { state: 'done', size: 6 }), t('fleetAgentDone')),
        h('span', null, h(StateDot, { state: 'idle', size: 6 }), t('fleetStatusIdle')))))
}

function AgentCard(props) {
  const t = props.t
  const agent: FleetAgent = props.agent
  const token = tokenLabel(t, agent.tokenUsage)
  const duration = durationLabel(t, agent.durationMs)
  return h('article', { className: 'dsh-fleet-agent-card', 'data-state': agent.state },
    tooltip(agent.label,
      h('button', {
        type: 'button',
        className: 'dsh-fleet-agent-main',
        onClick: function () { props.onOpen(agent.id) },
      },
        h('div', { className: 'dsh-fleet-agent-head' },
          h(StatusLine, { state: agent.state, label: stateLabel(t, agent.state) })),
        h('div', { className: 'dsh-fleet-agent-name' }, agent.label),
        h('div', { className: 'dsh-fleet-agent-model', title: modelLabel(agent.model, t) }, modelLabel(agent.model, t)),
        // The task is clamped to two lines; its Tooltip is hover/focus-shared
        // through DSH's nested-tooltip suppression, so the card never shows two
        // bubbles at once. Unknown stays a sentence, never blank.
        tooltip(agent.task === undefined ? t('fleetAgentTaskUnknown') : agent.task,
          h('div', { className: 'dsh-fleet-agent-task' },
            agent.task === undefined ? t('fleetAgentTaskUnknown') : agent.task)),
        h('div', { className: 'dsh-fleet-agent-meta' },
          h('span', null, modeLabel(t, agent.mode)),
          duration === undefined ? null : h('span', null, fill(t('fleetAgentDuration'), { value: duration })),
          token === undefined
            ? null
            : h('span', { title: tokenTitle(t, agent.tokenUsage) }, fill(t('fleetAgentTokens'), { value: token }))))),
    h('button', {
      type: 'button',
      className: 'dsh-fleet-agent-aside',
      disabled: !agent.addressable,
      title: agent.addressable ? t('fleetAgentAside') : t('fleetAgentAsideUnavailable'),
      onClick: function () { props.onOpenAside(agent.id) },
    }, t('fleetAgentAside')))
}

/** One budget: "已用 / 上限" plus a hairline bar. The numbers are the paint; the bar is decoration. */
function budgetItem(t, key: string, item: FleetBudgetItem) {
  const percent = item.limit > 0 ? Math.min(100, Math.round((item.used / item.limit) * 100)) : 0
  return h('div', { className: 'dsh-fleet-budget-item', 'data-kind': key },
    h('span', { className: 'dsh-fleet-budget-label' }, t('fleetBudget_' + key)),
    h('span', { className: 'dsh-fleet-budget-value' },
      fill(t('fleetBudgetValue'), { used: item.used, limit: item.limit })),
    // A data-driven width is the one thing a class cannot express; the track and
    // fill colors still come from tokens.
    h('span', { className: 'dsh-fleet-budget-bar', 'aria-hidden': 'true' },
      h('span', { className: 'dsh-fleet-budget-fill', style: { width: percent + '%' } })))
}

/**
 * D7: the three per-user-message budgets (delegations / reviews / new sessions).
 *
 * Hidden — not zeroed — when any number is unknown: an unloaded projection, an
 * unanswered carried read, or handoff turned off. The numbers are the ones the
 * gate refuses on, so the block must never show a smaller "已用" than the gate
 * would.
 */
function Budget(props) {
  const t = props.t
  const budget: FleetBudget | undefined = props.budget
  if (budget === undefined) return null
  return h('section', { className: 'dsh-fleet-budget', 'aria-label': t('fleetBudgetTitle') },
    h('div', { className: 'dsh-fleet-section-head' },
      h('h2', { className: 'dsh-fleet-section-title' }, t('fleetBudgetTitle')),
      h('span', { className: 'dsh-fleet-hint' }, t('fleetBudgetReset'))),
    h('div', { className: 'dsh-fleet-budget-grid' },
      budgetItem(t, 'delegations', budget.delegations),
      budgetItem(t, 'reviews', budget.reviews),
      budgetItem(t, 'newSessions', budget.newSessions)))
}

/** One receipt's label. The kinds are the projection's own closed set. */
function activityKindLabel(t, kind: FleetActivityKind): string {
  return t('fleetActivityKind_' + kind)
}

/**
 * The activity stream (D10).
 *
 * It reads the plugin's `oncall/handoff` projection — dispatch, finish, relay
 * and facts receipts the model itself declared — and nothing else. Three
 * states, kept apart: no projection is "not connected yet"; an empty projection
 * is "nothing happened yet"; rows are a list. It never paints an empty timeline.
 */
function ActivityStream(props) {
  const t = props.t
  const activity: readonly FleetActivity[] | undefined = props.activity
  const rows = activity ?? []
  return h('aside', { className: 'dsh-fleet-activity' },
    h('div', { className: 'dsh-fleet-section-head' },
      h('h2', { className: 'dsh-fleet-section-title' }, t('fleetActivityTitle')),
      rows.length === 0 ? null : h('span', { className: 'dsh-fleet-section-count' }, rows.length)),
    activity === undefined
      ? h('div', { className: 'dsh-fleet-activity-empty', role: 'status' },
          h('p', null, t('fleetActivityUnavailable')),
          h('p', { className: 'dsh-fleet-hint' }, t('fleetActivityHint')))
      : rows.length === 0
        ? h('div', { className: 'dsh-fleet-activity-empty', role: 'status' },
            h('p', null, t('fleetActivityEmpty')),
            h('p', { className: 'dsh-fleet-hint' }, t('fleetActivityEmptyHint')))
        : h('ol', { className: 'dsh-fleet-activity-list' },
            rows.map(function (row, index) {
              const object = row.rosterId ?? row.outcome
              return h('li', { key: index, className: 'dsh-fleet-activity-row', 'data-kind': row.kind },
                h('time', {
                  className: 'dsh-fleet-activity-time',
                  dateTime: new Date(row.at).toISOString(),
                }, formatActivityTime(row.at)),
                h('span', { className: 'dsh-fleet-activity-kind' }, activityKindLabel(t, row.kind)),
                object === undefined
                  ? null
                  : h('span', { className: 'dsh-fleet-activity-object', title: object }, object))
            })))
}

function SessionHeader(props) {
  const t = props.t
  const session: FleetSession = props.session
  return h('div', { className: 'dsh-fleet-session-head' },
    h('div', { className: 'dsh-fleet-session-head-top' },
      h('button', {
        type: 'button',
        className: 'dsh-fleet-back',
        onClick: props.onBack,
      }, h(Icon, { d: ICON_ARROW_LEFT, size: 12 }), t('fleetBackGlobal')),
      h(Button, {
        size: 'sm',
        variant: 'outline',
        onClick: function () { props.onOpenSession(session.row.parentId ?? session.row.id) },
      }, t('fleetOpenMain'))),
    h('div', { className: 'dsh-fleet-session-title-row' },
      h('h2', { className: 'dsh-fleet-session-title', title: session.row.title }, session.row.title),
      session.readOnly ? h(Tag, { tone: 'outline' }, t('fleetSessionReadonly')) : null),
    h('div', { className: 'dsh-fleet-session-meta' },
      h('span', { className: 'dsh-fleet-session-meta-item', title: session.workspacePath ?? '' },
        t('fleetSessionWorkspace') + ' ' + (session.workspaceTitle ?? t('fleetUnassigned'))),
      h('span', { className: 'dsh-fleet-session-meta-item', title: modelLabel(session.row.model, t) },
        t('fleetSessionModel') + ' ' + modelLabel(session.row.model, t)),
      h('span', { className: 'dsh-fleet-session-meta-item' },
        t('fleetSessionChain') + ' ' + (session.chain ?? t('fleetChainUnloaded'))),
      h('span', { className: 'dsh-fleet-session-meta-item dsh-fleet-mono', title: session.row.id },
        t('fleetSessionId') + ' ' + shortSessionId(session.row.id)),
      session.contextPercent === undefined
        ? null
        : h('span', { className: 'dsh-fleet-session-meta-item' }, fill(t('fleetContext'), { percent: session.contextPercent })),
      session.retryOverrides === 0
        ? null
        : h('span', { className: 'dsh-fleet-session-meta-item' }, fill(t('fleetRetryOverrides'), { n: session.retryOverrides }))))
}

function SessionUnknown(props) {
  return h('div', { className: 'dsh-fleet-state', role: 'status' },
    h('p', { className: 'dsh-fleet-state-title' }, props.t('fleetAgentsUnknownTitle')),
    h('p', { className: 'dsh-fleet-hint' }, props.t('fleetAgentsUnknownHint')),
    h(Button, { size: 'sm', variant: 'outline', onClick: props.onLoad }, props.t('fleetLoadAgents')))
}

function SessionFooter(props) {
  const t = props.t
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(function () {
    return function () { if (timer.current !== null) clearTimeout(timer.current) }
  }, [])
  function copy() {
    Promise.resolve(props.copyText(props.sessionId)).then(function (ok) {
      if (ok !== true) return
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(function () { setCopied(false) }, 1500)
    })
  }
  return h('div', { className: 'dsh-fleet-session-actions' },
    h('span', { className: 'dsh-fleet-session-actions-status', role: 'status' }, copied ? t('fleetSessionCopied') : ''),
    h(Button, { size: 'sm', variant: 'outline', onClick: copy }, t('fleetSessionCopyId')),
    h(Button, { size: 'sm', variant: 'primary', onClick: function () { props.onOpenSession(props.target) } }, t('fleetOpenMain')))
}

export function SessionView(props) {
  const t = props.t
  const session: FleetSession | undefined = props.model.session
  if (session === undefined) {
    return h('div', { className: 'dsh-fleet-session' },
      h('div', { className: 'dsh-fleet-state', role: 'status' },
        h('p', { className: 'dsh-fleet-state-title' }, t('fleetSessionMissing')),
        h('p', { className: 'dsh-fleet-hint' }, t('fleetSessionMissingHint')),
        h(Button, { size: 'sm', variant: 'outline', onClick: props.onBack }, t('fleetBackGlobal'))))
  }
  const hasChildren = session.agents.length > 0
  return h('div', { className: 'dsh-fleet-session' },
    h(SessionHeader, {
      t: t,
      session: session,
      onBack: props.onBack,
      onOpenSession: props.onOpenSession,
    }),
    h(Budget, { t: t, budget: session.budget }),
    // The room: one canvas per session, hidden under the narrow container band
    // by the fleet stylesheet (it never paints where it cannot be seen).
    hasChildren
      ? h(OfficeRoom, {
          agents: session.agents,
          onOpen: props.onOpenSession,
          label: t('fleetSessionAgentsTitle'),
        })
      : null,
    session.catalogLoaded === false
      ? h(SessionUnknown, {
          t: t,
          onLoad: function () { props.model.loadSession(session.row.id) },
        })
      : h('div', { className: 'dsh-fleet-session-body' },
          hasChildren
            ? h(Topology, { t: t, session: session, onOpenSession: props.onOpenSession })
            : h(EmptyState, { title: t('fleetSessionNoChildren'), hint: t('fleetSessionNoChildrenHint') }),
          h('div', { className: 'dsh-fleet-session-grid' },
            h('section', { className: 'dsh-fleet-agents', 'aria-label': t('fleetSessionAgentsTitle') },
              h('div', { className: 'dsh-fleet-section-head' },
                h('h2', { className: 'dsh-fleet-section-title' }, t('fleetSessionAgentsTitle')),
                h('span', { className: 'dsh-fleet-section-count' }, session.agents.length)),
              hasChildren
                ? h('div', { className: 'dsh-fleet-agent-grid' },
                    session.agents.map(function (agent) {
                      return h(AgentCard, {
                        key: agent.id,
                        t: t,
                        agent: agent,
                        onOpen: props.onOpenSession,
                        onOpenAside: props.onOpenAside,
                      })
                    }))
                : null),
            h(ActivityStream, { t: t, activity: session.activity }))),
    h(SessionFooter, {
      t: t,
      sessionId: session.row.id,
      target: session.row.parentId ?? session.row.id,
      copyText: props.copyText,
      onOpenSession: props.onOpenSession,
    }))
}
