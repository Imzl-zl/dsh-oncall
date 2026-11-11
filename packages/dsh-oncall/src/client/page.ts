/**
 * The router workbench page: one page-level scroller, one 960px column.
 *
 * Layout contract, taken from DSH's own panel pages and adjusted for a form:
 * - the page itself is the scroller and owns the horizontal padding, the way
 *   `PluginManagerPage.module.css` `.page` does; every direct row is the same
 *   960px column, so the head, the view switch, the content and the save bar
 *   share one left edge by construction instead of by four copies of the same
 *   padding. A separately padded row cannot line up with the scroller it sits
 *   next to: the scrollbar takes 9px out of the scroller's client width only,
 *   which moves the centred column by half of it.
 * - the head and the view switch travel in one sticky wrapper and the save bar
 *   is sticky to the bottom, so both stay reachable while a long chain scrolls
 *   without becoming rows that own their own geometry;
 * - the save/discard pair lives in one footer bar that is ALWAYS present: a
 *   clean draft shows a disabled save plus "all changes saved", so the action
 *   has a stable place instead of appearing only after the first edit.
 *
 * Note: 布局契约与原生出处 —— 见 docs/design/ui-layout-redesign.md
 * Note: 为什么列宽必须单源、固定行不许自带 padding —— 见
 * .agents/notes/implemented/2026-10-20-page-owns-the-column.md
 */

import { useCallback, useEffect, useState } from 'react'
import { h } from './dom.ts'
import { Button, SegmentedTabs, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { fill, routeStatus } from './format.ts'
import { configuredRouteList } from '../routes.ts'
import { ChainView } from './chain.ts'
import { AddCandidateModal, HealthSettingsModal, UpdateCheckModal, WhatsNewModal } from './modals.ts'
import { RELEASE_NOTES, RELEASE_VERSION } from '../release.generated.ts'
import { FailoverHistoryModal } from './pipeline.ts'
import { GlobalHealthWorkspace } from './workspace.ts'
import type { RouterSnapshot } from './controller.ts'
import { RosterView } from './roster.ts'
import { Icon, ICON_SAVE, ICON_UNDO } from './icons.ts'

/** The three views the page has. */
const VIEW_CHAIN = 'chain'
const VIEW_ROSTER = 'roster'
const VIEW_HEALTH = 'health'

export function RouterPage(props) {
  var t = props.t
  // The published snapshot, named: this is the seam the controller and the page
  // share, so `state.ui.<field>` and `state.draft.<field>` are checked here
  // instead of being silently `any`. A field that the controller stops
  // publishing breaks this line's readers, not the user's page.
  var state: RouterSnapshot = props.useRouterPage(function (snapshot) { return snapshot })
  var draft = state.draft
  var disabled = !state.writable || state.saving
  var view = state.ui.activeId === '__health__'
    ? VIEW_HEALTH
    : state.ui.activeId === '__roster__' ? VIEW_ROSTER : VIEW_CHAIN
  var modal = state.ui.modal

  // The jump target: a route key plus the moment it was asked for, so a second
  // click on the same route re-arms the scroll. `null` = no jump pending.
  var focusRouteState = useState<{ route: string; at: number } | null>(null)
  var focusRoute = focusRouteState[0]
  var setFocusRoute = focusRouteState[1]

  var handleJumpHealth = useCallback(function (routeKey) {
    // A fresh object per jump: the same route clicked twice re-arms the
    // scroll-and-highlight in the health workspace.
    setFocusRoute({ route: routeKey, at: Date.now() })
    props.onActive('__health__')
  }, [props.onActive])

  // The save command's gate: this page is mounted while the workbench is.
  // 同一次挂载里要目录：候选行/健康行/弹窗里的下拉都拿它换显示名（用户在「模型」
  // 页映射的名字）。不加载的话行上只剩原始 id——那正是用户看不出区别的原因。
  useEffect(function () {
    props.retainSurface()
    props.onLoadCatalog()
    return function () { props.releaseSurface() }
  }, [])

  // A non-empty tuple, not an array: `SegmentedTabs` requires at least one tab
  // (a tab list with no tabs has no selection and no keyboard target). The page
  // always has three, so the tuple is the honest shape and not a workaround.
  var viewTabs: [SegmentedTab, ...SegmentedTab[]] = [
    { value: VIEW_CHAIN, label: t('viewChainTab'), id: 'oncall-tab-chain', panelId: 'oncall-panel-chain' },
    // 第三页签只在 host 落地后注册：`handoff` 段存在（B1）才到这里，页面本身没有
    // "即将上线"占位——没有这一节时第三个页签根本不存在。
    { value: VIEW_ROSTER, label: t('viewRosterTab'), id: 'oncall-tab-roster', panelId: 'oncall-panel-roster' },
    { value: VIEW_HEALTH, label: t('viewHealthTab'), id: 'oncall-tab-health', panelId: 'oncall-panel-health' },
  ]

  var panelId = view === VIEW_HEALTH
    ? 'oncall-panel-health'
    : view === VIEW_ROSTER ? 'oncall-panel-roster' : 'oncall-panel-chain'
  var tabId = view === VIEW_HEALTH
    ? 'oncall-tab-health'
    : view === VIEW_ROSTER ? 'oncall-tab-roster' : 'oncall-tab-chain'

  var footer = state.available
    ? h('footer', { className: 'dsh-oncall-footer' },
        h('div', { className: 'dsh-oncall-footer-inner' },
        h('span', {
          className: 'dsh-oncall-footer-text',
          role: state.failed ? 'alert' : 'status',
        },
          // 宿主拒绝时把它的原话报出来：只说「保存失败，请重试」会让用户反复重试
          // 同一个越界值而不知该改哪个字段（`saveError` 为空才是真的没有原因）。
          state.failed ? (state.ui.saveError ?? t('formSaveFailed'))
            : state.saving ? t('formSaving')
              : state.ui.externalChange && state.dirty ? t('draftKeptExternal')
                : state.dirty ? t('dirtyBarText')
                  : t('allSavedText')),
        h('div', { className: 'dsh-oncall-footer-actions' },
          h(Button, {
            variant: 'outline',
            icon: h(Icon, { d: ICON_UNDO, size: 12 }),
            disabled: !state.dirty || !state.writable || state.saving,
            onClick: props.onDiscard,
          }, t('formDiscard')),
          h(Button, {
            variant: 'primary',
            icon: h(Icon, { d: ICON_SAVE, size: 12 }),
            disabled: !state.dirty || !state.writable || state.saving || state.invalid,
            onClick: props.onSave,
          }, state.saving ? t('formSaving') : t('formSave')))))
    : null

  return h('div', { className: 'dsh-oncall-page' },
    h('div', { className: 'dsh-oncall-top' },
      h('header', { className: 'dsh-oncall-head' },
        h('div', { className: 'dsh-oncall-head-main' },
          h('h1', { className: 'dsh-oncall-title' }, t('pageTitle')),
          h('div', { className: 'dsh-oncall-status-row' },
            draft.enabled
              ? h(Tag, { tone: 'success' }, t('statusRunningBadge'))
              : h(Tag, { tone: 'outline' }, t('statusDisabledBadge')),
            state.dirty ? h(Tag, { tone: 'warning' }, t('unsavedChangesBadge')) : null,
            state.failed ? h(Tag, { tone: 'danger' }, t('formSaveFailed')) : null)),
        h('div', { className: 'dsh-oncall-head-actions' },
          // 这个按钮查的是"有没有新版本"，顺带把更新日志摊开——只看日志的那个
          // 按钮是鸡肋：版本号和它改了什么本来就该在一起看。
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            title: fill(t('updateCheckButtonTitle'), { version: RELEASE_VERSION }),
            onClick: props.onOpenUpdateCheck,
          }, t('updateCheckButton')),
          h('span', { className: 'dsh-oncall-head-switch-label' }, t('takeoverSwitchLabel')),
          h(Switch, {
            checked: draft.enabled,
            label: t('takeoverSwitchLabel'),
            disabled,
            onChange: function (next) { props.onEnabled(next) },
          }))),
      state.available
        ? h('div', { className: 'dsh-oncall-tabs' },
            h(SegmentedTabs, {
              items: viewTabs,
              value: view,
              label: t('viewTabsLabel'),
              onChange: function (next) { props.onActive(next === VIEW_HEALTH ? '__health__' : next === VIEW_ROSTER ? '__roster__' : '__chain__') },
            }))
        : null),
    h('div', { className: 'dsh-oncall-content' },
      state.problems.length > 0
        ? h('div', { className: 'dsh-oncall-notice dsh-oncall-notice-error', role: 'alert' },
            h('strong', null, t('problemsTitle')),
            h('ul', { className: 'dsh-oncall-problem-list' },
              state.problems.map(function (problem, index) {
                return h('li', { key: index }, fill(t(problem.key), problem.vars))
              })))
        : null,
      !state.available
        ? h('p', { className: 'dsh-oncall-notice', role: 'status' }, t('formUnavailable'))
        : !state.writable
          ? h('p', { className: 'dsh-oncall-notice', role: 'status' }, t('formReadOnly'))
          : null,
      state.available
        ? h('div', {
            id: panelId,
            role: 'tabpanel',
            'aria-labelledby': tabId,
            className: 'dsh-oncall-view',
          },
            view === VIEW_HEALTH
              ? h(GlobalHealthWorkspace, {
                  t: t,
                  draft: draft,
                  catalog: state.ui.catalog,
                  passive: state.ui.passive,
                  discover: state.ui.discover,
                  checking: state.ui.checking,
                  checkingRoutes: state.ui.checkingRoutes,
                  probe: state.ui.probe,
                  probing: state.ui.probing,
                  probingRoutes: state.ui.probingRoutes,
                  checkSummary: state.ui.checkSummary,
                  probeSummary: state.ui.probeSummary,
                  passiveError: state.ui.passiveError,
                  focusRoute: focusRoute,
                  disabled: disabled,
                  bucketSeconds: draft.health.timelineBucketSeconds,
                  onCheckAll: props.onCheckAll,
                  onProbeAll: props.onProbeAll,
                  onOpenHealthModal: props.onOpenHealthModal,
                  onOpenDrawer: props.onOpenDrawer,
                  onCheckRoute: props.onCheckRoute,
                  onProbeRoute: props.onProbeRoute,
                })
              : view === VIEW_ROSTER
            ? h(RosterView, {
                t: t,
                handoff: draft.handoff,
                chains: draft.chains,
                disabled: disabled,
                // 校验摘要就是页面顶部那一份（state.problems），名册页只按角色过滤它，
                // 不另算一套规则。
                problems: state.problems,
                selectedId: state.ui.rosterId,
                onSelect: props.onSelectRoster,
                onField: props.onSetHandoffField,
                onEntry: props.onUpdateRoster,
                onAdd: props.onAddRoster,
                onRemove: props.onRemoveRoster,
              })
                : h(ChainView, {
                    t: t,
                    chain: draft.chain,
                    chains: draft.chains,
                    defaultChainId: draft.defaultChainId,
                    disabled: disabled,
                    catalog: state.ui.catalog,
                    passive: state.ui.passive,
                    discover: state.ui.discover,
                    probe: state.ui.probe,
                    onStrategy: props.onStrategy,
                    onFirstHopMaxRetries: props.onFirstHopMaxRetries,
                    onPrimaryNeeds: props.onPrimaryNeeds,
                    onWeight: props.onWeight,
                    onMaxRetries: props.onMaxRetries,
                    onMove: props.onMove,
                    onReorder: props.onReorder,
                    onRemove: props.onRemove,
                    onStickyTurns: props.onStickyTurns,
                    onMaxTokenContinue: props.onMaxTokenContinue,
                    onMaxTokenContinues: props.onMaxTokenContinues,
                    onToggleImmediateSwitch: props.onToggleImmediateSwitch,
                    onToggleSwitchOn: props.onToggleSwitchOn,
                    onNeeds: props.onNeeds,
                    onOpenAddCandidate: props.onOpenAddCandidate,
                    onJumpHealth: handleJumpHealth,
                    onSelectChain: props.onSelectChain,
                    onRenameChain: props.onRenameChain,
                    onSetDefaultChain: props.onSetDefaultChain,
                    onRemoveChain: props.onRemoveChain,
                    onCopyChain: props.onCopyChain,
                    onAddChain: props.onAddChain,
                  }))
        : null),
    modal !== null && modal.kind === 'health' ? h(HealthSettingsModal, {
      t: t,
      health: draft.health,
      catalog: state.ui.catalog,
      routes: configuredRouteList(draft),
      disabled: disabled,
      onClose: props.onCloseModal,
      onUpdateHealth: props.onUpdateHealth,
    }) : null,
    modal !== null && modal.kind === 'add-candidate' ? h(AddCandidateModal, {
      t: t,
      catalog: state.ui.catalog,
      catalogFailed: state.ui.catalogFailed,
      onLoadCatalog: props.onLoadCatalog,
      onClose: props.onCloseModal,
      onAdd: function (entries) { props.onAddCandidates(entries) },
    }) : null,
    state.ui.drawerOpen ? h(FailoverHistoryModal, {
      key: 'history',
      t: t,
      state: state,
      onClose: props.onCloseDrawer,
      onReload: props.onOpenDrawer,
    }) : null,
    state.ui.notesOpen ? h(WhatsNewModal, {
      key: 'notes',
      t: t,
      version: RELEASE_VERSION,
      notes: RELEASE_NOTES,
      onClose: props.onCloseNotes,
    }) : null,
    state.ui.updateOpen ? h(UpdateCheckModal, {
      key: 'update',
      t: t,
      result: state.ui.updateResult,
      checking: state.ui.updateChecking,
      error: state.ui.updateError,
      currentVersion: RELEASE_VERSION,
      currentNotes: RELEASE_NOTES,
      onClose: props.onCloseUpdateCheck,
      onRecheck: props.onOpenUpdateCheck,
    }) : null,
    footer)
}


