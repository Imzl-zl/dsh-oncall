/**
 * The chain editor's sections and the failover-history dialog.
 *
 * Layout follows DSH's own pages: each section is a title row plus content,
 * rows are flat list items separated by a hairline (ui-plugin-manager `.row`),
 * and controls are the primitives (Button / Checkbox / Input / SegmentedControl
 * / Tag). There is no card inside a card: the page already owns the surface.
 *
 * Note: 分区/行/弹窗的布局契约与原生出处 —— 见 docs/design/ui-layout-redesign.md
 */

import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button, Checkbox, Input, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './dom.ts'
import { fill, routeStatus } from './format.ts'
import { routeNames } from './naming.ts'
import { Icon, ICON_BOLT, ICON_DOWN, ICON_GRIP, ICON_MINUS, ICON_PLUS, ICON_TRASH, ICON_UP } from './icons.ts'
import { routeKeyOf, routeParts } from '../routes.ts'
import { DEFAULT_FIRST_HOP_MAX_RETRIES, DEFAULT_MAX_TOKEN_CONTINUES, MAX_RETRIES, MAX_TOKEN_CONTINUES, OTHER_SWITCH_KEY, STRATEGIES, SWITCH_ON_CODES, SWITCH_ON_KEYS } from '../defaults.ts'

/** The status text one route's health tag carries. */
function statusLabel(t, status) {
  if (status === 'healthy') return t('healthStatusHealthy')
  if (status === 'degraded') return t('healthStatusDegraded')
  if (status === 'unhealthy') return t('healthStatusUnhealthy')
  return t('compactHealthIdle')
}

/** The tag tone one health status uses. */
function statusTone(status) {
  if (status === 'healthy') return 'success'
  if (status === 'degraded') return 'warning'
  if (status === 'unhealthy') return 'danger'
  return 'outline'
}

/** The dictionary label for one failure code, falling back to the raw code. */
export function codeLabel(t, code) {
  var entry = SWITCH_ON_CODES.find(function (candidate) { return candidate.code === code })
  return entry === undefined ? code : t(entry.labelKey + 'Name')
}

/** 白名单里一个键的名字与说明：与「失败切换」网格同一套字典，`other` 是兜底键。 */
function switchOnText(t, key, suffix) {
  var entry = SWITCH_ON_CODES.find(function (candidate) { return candidate.key === key })
  return entry === undefined ? t(OTHER_SWITCH_KEY + suffix) : t(entry.labelKey + suffix)
}

/**
 * A compact numeric stepper: one button per direction, a text field between
 * them. The field stays controlled so the draft is the only source of truth.
 */
function Stepper(props) {
  var t = props.t
  var value = props.value
  var min = props.min ?? 1
  var max = props.max
  var atMin = value <= min
  var atMax = max !== undefined && value >= max
  return h('span', { className: 'dsh-oncall-stepper' },
    h('button', {
      type: 'button',
      className: 'dsh-oncall-stepper-btn',
      disabled: props.disabled || atMin,
      title: t('stepMinus'),
      'aria-label': t('stepMinus'),
      onClick: function () { props.onChange(Math.max(min, value - 1)) },
    }, h(Icon, { d: ICON_MINUS, size: 10 })),
    h('input', {
      className: 'dsh-oncall-stepper-input',
      type: 'text',
      inputMode: 'numeric',
      value: String(value),
      disabled: props.disabled,
      'aria-label': props.label,
      // A native `input` made by `h()`: the handler has to name its element, because
      // the generic in React's string-element overload has nothing else to infer
      // from and would leave `currentTarget` as a bare `Element` (no `.value`).
      onChange: function (event: ChangeEvent<HTMLInputElement>) {
        var parsed = Number(event.currentTarget.value)
        if (!Number.isFinite(parsed)) return
        var next = Math.max(min, Math.round(parsed))
        if (max !== undefined) next = Math.min(max, next)
        props.onChange(next)
      },
    }),
    h('button', {
      type: 'button',
      className: 'dsh-oncall-stepper-btn',
      disabled: props.disabled || atMax,
      title: t('stepPlus'),
      'aria-label': t('stepPlus'),
      onClick: function () { props.onChange(max === undefined ? value + 1 : Math.min(max, value + 1)) },
    }, h(Icon, { d: ICON_PLUS, size: 10 })))
}

/**
 * The first hop: the model the user selected in DSH. It is not configured here
 * because it is not a constant — only its retry budget is.
 */
export function FirstHopSection(props) {
  var t = props.t
  // Note: 为什么合法的 0 必须原样显示 —— 见
  // .agents/notes/implemented/2026-10-23-honest-surfaces.md
  // 0 是合法值（说明文案自己写着"0 = 失败即切"），所以只兜"没有值"，不用 `||`：
  // `0 || 5` 会让界面显示 5、note 写 5，而草稿与宿主其实是 0——同一页的两个分区
  // 于是对同一个字段给出两个答案。数值范围由 validate() 与 host schema 负责，
  // 这里不夹值（夹值会让越界值看起来像已修正）。
  var retries = typeof props.maxRetries === 'number' && Number.isFinite(props.maxRetries)
    ? props.maxRetries
    : DEFAULT_FIRST_HOP_MAX_RETRIES
  return h('section', { className: 'dsh-oncall-section' },
    h('div', { className: 'dsh-oncall-section-head' },
      h('h2', { className: 'dsh-oncall-section-title' }, t('firstHopSectionTitle')),
      h('span', { className: 'dsh-oncall-section-hint' }, t('firstHopSectionHint'))),
    // 第一跳的条件：它没有候选行可挂，所以是链级的 `primaryNeeds`。用的是与候选
    // 同一块面板——同一套三态语义，只有一个落点不同。
    props.onPrimaryNeeds === undefined ? null : h('div', { className: 'dsh-oncall-conditions' },
      ConditionsPanel({
        t: t,
        index: 'primary',
        candidate: { needs: props.primaryNeeds },
        disabled: props.disabled,
        onNeeds: props.onPrimaryNeeds,
      }),
      h('span', { className: 'dsh-oncall-hint' }, t('firstHopNeedsHint'))),
    h('div', { className: 'dsh-oncall-row dsh-oncall-row-firsthop' },
      h('div', { className: 'dsh-oncall-row-line' },
        h('span', { className: 'dsh-oncall-icon' }, h(Icon, { d: ICON_BOLT, size: 16 })),
        h('div', { className: 'dsh-oncall-row-main' },
          h('div', { className: 'dsh-oncall-row-title' },
            t('firstHopTitle'),
            h(Tag, { tone: 'info' }, t('firstHopBadge'))),
          h('div', { className: 'dsh-oncall-row-sub' }, t('firstHopDesc'))),
        h('div', { className: 'dsh-oncall-row-end' },
          h('span', { className: 'dsh-oncall-muted' }, t('retryLimit')),
          h(Stepper, {
            t: t,
            value: retries,
            min: 0,
            max: MAX_RETRIES,
            disabled: props.disabled,
            label: t('retryLimit'),
            onChange: function (next) { if (props.onMaxRetries) props.onMaxRetries(next) },
          }),
          h('span', { className: 'dsh-oncall-muted' }, t('timesUnit')))),
    h('p', { className: 'dsh-oncall-note' },
      fill(t('firstHopRetriesNote'), { n: retries }))))
}

/** The conditions panel under one candidate row. */
function ConditionsPanel(props) {
  var t = props.t
  var candidate = props.candidate
  var index = props.index
  var images = candidate.needs?.images
  var imagesMode = images === true ? 'require' : images === false ? 'forbid' : 'any'
  var minContext = candidate.needs?.minContextTokens
  return h('div', { className: 'dsh-oncall-conditions' },
    h('div', { className: 'dsh-oncall-field' },
      h('span', { className: 'dsh-oncall-label' }, t('needImagesTitle')),
      h(SegmentedControl, {
        id: 'needs-images-' + index,
        value: imagesMode,
        label: t('needImagesTitle'),
        disabled: props.disabled,
        options: [
          { value: 'any', label: t('needImagesAnyLabel') },
          { value: 'require', label: t('needImagesRequireLabel') },
          { value: 'forbid', label: t('needImagesForbidLabel') },
        ],
        onChange: function (next) {
          if (next === 'any') props.onNeeds({ imagesMode: 'any' })
          else if (next === 'require') props.onNeeds({ imagesMode: 'require' })
          else props.onNeeds({ imagesMode: 'forbid' })
        },
      }),
      h('span', { className: 'dsh-oncall-hint' }, t('needImagesHint'))),
    h('div', { className: 'dsh-oncall-field' },
      h('label', { className: 'dsh-oncall-label', htmlFor: 'needs-context-' + index }, t('needContextTitle')),
      h(Input, {
        id: 'needs-context-' + index,
        type: 'text',
        inputMode: 'numeric',
        value: minContext === undefined ? '' : String(minContext),
        placeholder: '0',
        disabled: props.disabled,
        onChange: function (event) {
          var parsed = Number(event.target.value)
          props.onNeeds({ minContextTokens: Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0 })
        },
      }),
      h('span', { className: 'dsh-oncall-hint' }, t('needContextHint'))))
}

/** One fallback candidate as a flat row: identity, health, and its controls. */
function CandidateRow(props) {
  var t = props.t
  var candidate = props.candidate
  var index = props.index
  var names = props.names
  var route = routeKeyOf(candidate.provider, candidate.model)
  var status = routeStatus(props.passive, props.discover, props.probe, route)
  var needs = candidate.needs
  var hasConditions = needs !== undefined && (needs.images !== undefined || (needs.minContextTokens ?? 0) > 0)
  var dragActive = props.dragSource === index
  return h('li', {
    className: 'dsh-oncall-row' + (dragActive ? ' dsh-oncall-row-dragging' : ''),
    draggable: !props.disabled,
    onDragStart: function (event) {
      if (props.disabled) { event.preventDefault(); return }
      // 只允许从卡面本身发起拖拽：按钮/输入框上的按下不是重排手势。边界收窄到
      // 本行（row.contains），外层同角色的包裹层不再把整行判成"在交互元素里"。
      //
      // This is the one place in this file that casts `event.target`: the question
      // is "which node under the pointer was pressed", and `currentTarget` would
      // answer with the row itself. `EventTarget` has no `closest`, so the cast is
      // the boundary between the DOM's event target and the query below.
      var hit = event.target as HTMLElement | null
      if (hit && typeof hit.closest === 'function') {
        var interactive = hit.closest('button, input, select, textarea, a, [role="tab"]')
        if (interactive && event.currentTarget.contains(interactive)) { event.preventDefault(); return }
      }
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      props.onDragStart(index)
    },
    onDragOver: function (event) {
      if (props.dragSource === null) return
      // The row under the pointer is the drop target; the browser needs the
      // default prevented or it refuses the drop entirely.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    },
    onDrop: function (event) {
      event.preventDefault()
      props.onDrop(index)
    },
    onDragEnd: function () { props.onDragEnd() },
  },
    h('div', { className: 'dsh-oncall-row-line' },
      h('span', { className: 'dsh-oncall-row-grip', title: t('dragReorderHint'), 'aria-hidden': 'true' },
        h(Icon, { d: ICON_GRIP, size: 12 })),
      h('span', { className: 'dsh-oncall-order' }, String(index + 1)),
      h('div', { className: 'dsh-oncall-row-main' },
        // 标题用目录里的显示名（用户在「模型」页映射的名字），原始 `provider/model`
        // 留在 title 里——名字要好看，但排查时必须还能读到真实渠道。
        // Note: 为何显示名来自目录、缺名回落原始 id —— 见
        // .agents/notes/implemented/2026-10-22-catalog-names-on-every-surface.md
        h('div', { className: 'dsh-oncall-row-title', title: route },
          h('span', { className: 'dsh-oncall-provider' }, names.provider(candidate.provider)),
          h('span', { className: 'dsh-oncall-row-meta' }, names.model(candidate.provider, candidate.model))),
        h('div', { className: 'dsh-oncall-row-sub' },
          h('button', {
            type: 'button',
            className: 'dsh-oncall-tag-btn',
            title: t('jumpToHealth'),
            onClick: function () { if (props.onJumpHealth) props.onJumpHealth(route) },
          }, h(Tag, { tone: statusTone(status), className: 'dsh-oncall-health-tag' }, statusLabel(t, status))),
          hasConditions
            ? h(Tag, { tone: 'info' },
                needs.images === true ? t('needImagesRequireBadge')
                  : needs.images === false ? t('needImagesForbidBadge')
                    : fill(t('needContextBadge'), { n: needs.minContextTokens }))
            : null,
          props.strategy === 'weight' && (candidate.weight ?? 0) > 0
            ? h(Tag, { tone: 'quiet' }, t('weightLabel') + ' ' + candidate.weight)
            : null)),
      h('div', { className: 'dsh-oncall-row-end' },
        props.strategy === 'weight'
          ? h('span', { className: 'dsh-oncall-inline-field' },
              h('span', { className: 'dsh-oncall-muted' }, t('weightLabel')),
              h('input', {
                className: 'dsh-oncall-inline-input',
                type: 'text',
                inputMode: 'numeric',
                value: String(candidate.weight ?? 0),
                disabled: props.disabled,
                'aria-label': t('weightLabel'),
                onChange: function (event: ChangeEvent<HTMLInputElement>) {
                  var parsed = Number(event.currentTarget.value)
                  if (Number.isFinite(parsed)) props.onWeight(index, Math.max(0, Math.min(100, Math.round(parsed))))
                },
              }))
          : null,
        h('span', { className: 'dsh-oncall-inline-field' },
          h('span', { className: 'dsh-oncall-muted' }, t('retryLimit')),
          h(Stepper, {
            t: t,
            value: candidate.maxRetries,
            min: 0,
            max: MAX_RETRIES,
            disabled: props.disabled,
            label: t('retryLimit'),
            onChange: function (next) { props.onMaxRetries(index, next) },
          })),
        h('button', {
          type: 'button',
          className: 'dsh-oncall-link-btn',
          'aria-expanded': props.open,
          onClick: function () { props.onToggleConditions(index) },
        }, t('toggleNeedsBtn') + (props.open ? ' ▴' : ' ▾')),
        h('button', {
          type: 'button',
          className: 'dsh-oncall-icon-btn',
          title: t('moveUp'),
          'aria-label': t('moveUp'),
          disabled: props.disabled || index === 0,
          onClick: function () { props.onMove(index, -1) },
        }, h(Icon, { d: ICON_UP, size: 12 })),
        h('button', {
          type: 'button',
          className: 'dsh-oncall-icon-btn',
          title: t('moveDown'),
          'aria-label': t('moveDown'),
          disabled: props.disabled || index === props.total - 1,
          onClick: function () { props.onMove(index, 1) },
        }, h(Icon, { d: ICON_DOWN, size: 12 })),
        h('button', {
          type: 'button',
          className: 'dsh-oncall-icon-btn dsh-oncall-icon-btn-danger',
          title: t('removeNode'),
          'aria-label': t('removeNode'),
          disabled: props.disabled,
          onClick: function () { props.onRemove(index) },
        }, h(Icon, { d: ICON_TRASH, size: 12 })))),
    props.open
      ? h(ConditionsPanel, {
          t: t,
          candidate: candidate,
          index: index,
          disabled: props.disabled,
          onNeeds: function (patch) { props.onNeeds(index, patch) },
        })
      : null)
}

/** The fallback candidates: one flat list, one add action, one empty state. */
export function CandidatesSection(props) {
  var t = props.t
  var [openIndex, setOpenIndex] = useState(-1)
  var [dragSource, setDragSource] = useState(null)
  // 目录可能有几百个模型：一次渲染查一次表，不按行重建。
  var names = useMemo(function () { return routeNames(props.catalog) }, [props.catalog])
  var candidates = props.candidates
  var imageIndex = -1
  candidates.forEach(function (candidate, index) {
    if (imageIndex === -1 && candidate.needs && candidate.needs.images !== undefined) imageIndex = index
  })
  var toggleConditions = function (index) { setOpenIndex(openIndex === index ? -1 : index) }
  var handleDrop = function (index) {
    if (dragSource !== null) props.onReorder(dragSource, index)
    setDragSource(null)
  }
  return h('section', { className: 'dsh-oncall-section' },
    h('div', { className: 'dsh-oncall-section-head' },
      h('h2', { className: 'dsh-oncall-section-title' }, t('fallbackChainSection')),
      h('span', { className: 'dsh-oncall-section-count' }, String(candidates.length)),
      imageIndex >= 0
        ? h('button', {
            type: 'button',
            className: 'dsh-oncall-link-btn',
            title: t('imageRouteBadgeHint'),
            onClick: function () { setOpenIndex(imageIndex) },
          }, t('imageRouteBadge'))
        : null,
      h('span', { className: 'dsh-oncall-section-spacer' }),
      h(Button, {
        variant: 'primary',
        icon: h(Icon, { d: ICON_PLUS, size: 14 }),
        disabled: props.disabled,
        onClick: props.onOpenAddCandidate,
      }, t('addCandidateBtn'))),
    candidates.length === 0
      ? h('p', { className: 'dsh-oncall-empty' }, t('fallbackEmptyTitle') + ' — ' + t('fallbackEmptyDesc'))
      : h('ul', { className: 'dsh-oncall-list' },
          candidates.map(function (candidate, index) {
            return h(CandidateRow, {
              key: routeKeyOf(candidate.provider, candidate.model) + ':' + index,
              t: t,
              candidate: candidate,
              names: names,
              index: index,
              total: candidates.length,
              strategy: props.strategy,
              disabled: props.disabled,
              passive: props.passive,
              discover: props.discover,
              probe: props.probe,
              open: openIndex === index,
              onToggleConditions: toggleConditions,
              onMaxRetries: props.onMaxRetries,
              onWeight: props.onWeight,
              onMove: props.onMove,
              onNeeds: props.onNeeds,
              onRemove: props.onRemove,
              onJumpHealth: props.onJumpHealth,
              dragSource: dragSource,
              onDragStart: function (index) { setDragSource(index) },
              onDrop: handleDrop,
              onDragEnd: function () { setDragSource(null) },
            })
          })))
}

/**
 * Which failures move the chain forward: one checkbox per known code, plus one
 * catch-all row for every code the table does not name.
 *
 * The catch-all is the structural fix for "枚举覆盖不了"：a failure code the
 * table does not know (`PI_AI_ERROR`, an HTTP status a relay invented, a code a
 * future DSH release adds) is not a reason to do nothing. Unchecking a row means
 * "this failure is DSH's to finish" — the plugin then neither retries nor
 * switches it.
 */
export function SwitchOnSection(props) {
  var t = props.t
  var total = SWITCH_ON_CODES.length + 1
  var checked = SWITCH_ON_CODES.filter(function (entry) { return Boolean(props.value[entry.key]) }).length
    + (props.value[OTHER_SWITCH_KEY] ? 1 : 0)
  return h('section', { className: 'dsh-oncall-section' },
    h('div', { className: 'dsh-oncall-section-head' },
      h('h2', { className: 'dsh-oncall-section-title' }, t('switchOnTitle')),
      h('span', { className: 'dsh-oncall-section-hint' },
        fill(t('triggerSummaryLine'), { n: checked, total: total }))),
    h('div', { className: 'dsh-oncall-check-grid' },
      SWITCH_ON_CODES.map(function (entry) {
        return h(Checkbox, {
          key: entry.key,
          className: 'dsh-oncall-check',
          checked: Boolean(props.value[entry.key]),
          disabled: props.disabled,
          label: t(entry.labelKey + 'Name') + ' · ' + entry.code,
          title: t(entry.labelKey + 'Desc'),
          onChange: function () { props.onToggle(entry.key) },
        })
      }),
      h(Checkbox, {
        key: OTHER_SWITCH_KEY,
        className: 'dsh-oncall-check',
        checked: Boolean(props.value[OTHER_SWITCH_KEY]),
        disabled: props.disabled,
        label: t('otherName'),
        title: t('otherDesc'),
        onChange: function () { props.onToggle(OTHER_SWITCH_KEY) },
      })))
}

/** One field in the two-column form: label, control, hint. */
function FieldCol(props) {
  return h('div', { className: 'dsh-oncall-field-col' },
    h('span', { className: 'dsh-oncall-label' }, props.label),
    props.children,
    props.hint === undefined ? null : h('span', { className: 'dsh-oncall-hint' }, props.hint))
}

/**
 * The start strategy is the first decision a user makes — it decides which
 * FALLBACK a request starts from after the first hop fails — so it is the first
 * section, not a field buried under the budget. The first hop itself is always
 * tried first and never participates in the draw.
 */
export function StrategySection(props) {
  var t = props.t
  return h('section', { className: 'dsh-oncall-section' },
    h('div', { className: 'dsh-oncall-section-head' },
      h('h2', { className: 'dsh-oncall-section-title' }, t('strategySectionTitle')),
      h('span', { className: 'dsh-oncall-section-hint' }, t('strategySectionHint'))),
    h('div', { className: 'dsh-oncall-field-grid' },
      h(FieldCol, { label: t('strategyLabel'), hint: t('strategyDetail' + props.strategy) },
        h(SegmentedControl, {
          id: 'router-strategy',
          value: props.strategy,
          label: t('strategyLabel'),
          disabled: props.disabled,
          options: STRATEGIES.map(function (value) {
            return { value: value, label: t('strategy' + value) }
          }),
          onChange: function (next) { props.onStrategy(next) },
        }))))
}

/**
 * The turn-scoped settings that are not a retry budget.
 *
 * A request-wide "max calls" field used to live here. It could only cut a
 * request short, never switch or add a call, and it duplicated the per-route
 * numbers. The note below is read-only: the retry numbers are the budget, and
 * there is no total-call configuration to add them into.
 */
export function RetrySection(props) {
  var t = props.t
  var stickyOptions = [0, 1, 2, 3, 5]
  var current = Math.max(0, Math.min(99, Number(props.stickyTurns) || 0))
  if (stickyOptions.indexOf(current) === -1) stickyOptions.push(current)
  stickyOptions.sort(function (left, right) { return left - right })
  return h('section', { className: 'dsh-oncall-section' },
    h('div', { className: 'dsh-oncall-section-head' },
      h('h2', { className: 'dsh-oncall-section-title' }, t('retrySectionTitle')),
      h('span', { className: 'dsh-oncall-section-hint' }, t('retrySectionHint'))),
    h('div', { className: 'dsh-oncall-field-grid' },
      h(FieldCol, { label: t('stickyTurns'), hint: t('stickyTurnsHint') },
        h(SegmentedControl, {
          id: 'router-sticky-turns',
          value: String(current),
          label: t('stickyTurns'),
          disabled: props.disabled,
          options: stickyOptions.map(function (turns) {
            return { value: String(turns), label: turns === 0 ? t('stickyTurnsOff') : String(turns) }
          }),
          onChange: function (next) { props.onStickyTurns(Number(next)) },
        }))),
    // 白名单：与「失败切换」是同一套键，回答的是另一个问题——这一击要不要再打
    // 一次。失败码枚举不全，所以不做"每个码一个次数"，只做二值勾选。
    h('div', { className: 'dsh-oncall-immediate' },
      h('div', { className: 'dsh-oncall-immediate-head' },
        h('span', { className: 'dsh-oncall-label' }, t('immediateSwitchLabel')),
        h('span', { className: 'dsh-oncall-hint' }, t('immediateSwitchHint'))),
      h('div', { className: 'dsh-oncall-check-grid' },
        SWITCH_ON_KEYS.map(function (key) {
          return h(Checkbox, {
            key: key,
            className: 'dsh-oncall-check',
            checked: (props.immediateSwitch ?? []).indexOf(key) >= 0,
            disabled: props.disabled,
            label: switchOnText(t, key, 'Name'),
            title: switchOnText(t, key, 'Desc'),
            onChange: function () { props.onToggleImmediateSwitch(key) },
          })
        }))),
    h('p', { className: 'dsh-oncall-formula' }, t('retryNoTotalCapNote')),
    h('p', { className: 'dsh-oncall-note' }, t('retryHierarchyNote')))
}

/**
 * Output continuation: a separate decision from failure retries.
 *
 * `max-tokens` is not a failure and never reaches `agent/request-error`; it is
 * the model stopping at its output ceiling. The switch and the count live in
 * their own section so they cannot be read as "retry this failed route".
 * Note: 为何输出续跑与失败重试分开、为何删掉总调用数字 —— 见
 * .agents/notes/implemented/2026-10-23-agent-fleet-p1-and-config-surfaces.md
 */
export function OutputContinuationSection(props) {
  var t = props.t
  var maxTokens = props.maxTokens ?? {}
  var auto = maxTokens.autoContinue === true
  var continues = typeof maxTokens.continues === 'number' ? maxTokens.continues : DEFAULT_MAX_TOKEN_CONTINUES
  return h('section', { className: 'dsh-oncall-section' },
    h('div', { className: 'dsh-oncall-section-head' },
      h('h2', { className: 'dsh-oncall-section-title' }, t('outputContinuationTitle')),
      h('span', { className: 'dsh-oncall-section-hint' }, t('outputContinuationHint'))),
    h('div', { className: 'dsh-oncall-field-grid' },
      h(FieldCol, { label: t('maxTokenContinueLabel'), hint: t('maxTokenContinueHint') },
        h('span', { className: 'dsh-oncall-inline-field' },
          h(Checkbox, {
            className: 'dsh-oncall-check',
            checked: auto,
            disabled: props.disabled,
            label: t('maxTokenContinueOn'),
            onChange: function () { props.onMaxTokenContinue(!auto) },
          }),
          h(Stepper, {
            t: t,
            value: Math.max(0, Math.min(MAX_TOKEN_CONTINUES, Number(continues) || 0)),
            min: 0,
            max: MAX_TOKEN_CONTINUES,
            disabled: props.disabled || !auto,
            onChange: function (next) { props.onMaxTokenContinues(next) },
          })))),
    h('p', { className: 'dsh-oncall-note' }, t('outputContinuationNote')))
}

/**
 * The failover ledger as a centred dialog — the same `Modal` every other DSH
 * secondary view uses. It replaced a self-built right-edge drawer whose close
 * button sat next to the desktop window's own close control.
 */
export function FailoverHistoryModal(props) {
  var t = props.t
  var ui = props.state.ui
  var rows = ui.drawerRows
  // 账本里存的是 `provider/model` 原始键（lineage.ts）。显示名来自目录，缺名回落
  // 到键本身——历史里出现一条已经不在目录里的路由时，仍然要读得出它是哪条。
  var names = useMemo(function () { return routeNames(ui.catalog) }, [ui.catalog])
  var body
  if (ui.drawerLoading) body = h('p', { className: 'dsh-oncall-muted' }, t('failoverHistoryLoading'))
  else if (ui.drawerError) {
    body = h('div', null,
      h('p', { className: 'dsh-oncall-muted' }, t('failoverHistoryError')),
      h(Button, { variant: 'outline', size: 'sm', onClick: props.onReload }, t('failoverHistoryRetry')))
  } else if (rows.length === 0) {
    // 列表被拒是 drawerError（上面那一支）；走到这里说明整份列表读到了，只是
    // 窗口内一条转移都没有——这时"暂无记录"是真话。
    body = h('p', { className: 'dsh-oncall-muted' }, t('failoverHistoryEmpty'))
  } else {
    body = h('div', { className: 'dsh-oncall-history' },
      rows.map(function (row, rowIndex) {
        return h('section', { key: 's' + rowIndex, className: 'dsh-oncall-history-session' },
          h('h3', { className: 'dsh-oncall-history-title' },
            t('failoverSessionLabel') + ' ' + String(row.sessionId).slice(0, 8)),
          h('ul', { className: 'dsh-oncall-list' },
            row.entries.map(function (entry, index) {
              return h('li', { key: 'e' + index, className: 'dsh-oncall-history-row' },
                h('span', { className: 'dsh-oncall-history-time' }, new Date(entry.time).toLocaleString()),
                h('span', { className: 'dsh-oncall-history-text', title: entry.from + ' → ' + entry.to },
                  fill(t('failoverEntryLine'), {
                    from: names.route(routeParts(entry.from).provider, routeParts(entry.from).model),
                    code: codeLabel(t, entry.code),
                    to: names.route(routeParts(entry.to).provider, routeParts(entry.to).model),
                  })),
                h(Tag, { tone: entry.settled ? 'success' : 'warning' },
                  entry.settled ? t('failoverEntrySettled') : t('failoverEntryUnsettled')))
            })))
      }),
      h('p', { className: 'dsh-oncall-hint' }, t('failoverHistoryHint')))
  }
  return h(Modal, {
    open: true,
    onClose: props.onClose,
    title: t('failoverHistoryDrawerTitle'),
    closeLabel: t('close'),
    className: 'dsh-oncall-history-modal',
    contentClassName: 'dsh-oncall-modal-content',
    footer: h(Button, { variant: 'outline', onClick: props.onClose }, t('close')),
  }, body)
}
