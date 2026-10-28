/**
 * The delegation roster page: master list + editor.
 *
 * Layout contract from docs/design/agent-fleet-drawer.md §5.3:
 * - a 224px role list that scrolls on its own, capped at 420px, with the
 *   selected row scrolled into view — twelve roles must not stretch the page;
 * - the editor beside it: identity, the three text fields with their one reader
 *   each, the physical route, and the attach vocabulary;
 * - the validation summary is the page's own problem list (it sits above the
 *   tab panel), and this view marks the offending fields red so the two agree;
 * - every control writes through the controller's `onField`/`onEntry` actions,
 *   which mutate the same draft the existing sections use. There is no second
 *   save path here.
 *
 * `purpose` is compiled into the tool description (main model); `instructions`
 * and `preset` only ever reach the child. The permanent hint says so, because
 * putting the wrong text in the wrong box is the one mistake this page cannot
 * detect for the user.
 *
 * Note: 名册页的字段归属、校验同源与"一个保存链路" —— 见
 * .agents/notes/implemented/2026-10-24-handoff-roster-and-gates.md
 */

import { useEffect, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { h } from './dom.ts'
import { Button, Checkbox, Input, SegmentedControl, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  HANDOFF_ATTACH_ITEMS,
  HANDOFF_BRIEFING_ITEMS,
  HANDOFF_INSTRUCTIONS_MAX,
  HANDOFF_NEXT_ACTIONS,
  HANDOFF_OUTCOMES,
  HANDOFF_ROLES,
} from '../defaults.ts'
import { fill } from './format.ts'
import { routeKeyOf } from '../routes.ts'
import type { HandoffConfig, NamedChain, RosterEntry } from '../config.ts'
import type { Problem } from './validate.ts'

/** The value one roster field carries: text, a budget, or the attach list. */
type RosterFieldValue = string | number | readonly string[]

/**
 * What the roster page needs from the workbench.
 *
 * Declared because this is the one seam where a typo is silent: `onEntry`'s
 * field name is a `keyof RosterEntry`, so writing `'maxRuns'` instead of
 * `'maxRunsPerUserMessage'` stops compiling instead of writing nothing. The
 * page passes values it already has typed (`RouterSnapshot.draft.handoff`,
 * `RouterSnapshot.problems`), so the wiring is checked at its single call site.
 */
interface RosterViewProps {
  t: (key: string) => string
  handoff: HandoffConfig
  chains: readonly NamedChain[]
  disabled: boolean
  /** The page's whole problem list; this view filters it per role. */
  problems: readonly Problem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onField: (path: readonly string[], value: unknown) => void
  onEntry: (id: string, field: keyof RosterEntry, value: RosterFieldValue) => void
  onAdd: () => void
  onRemove: (id: string) => void
}

/**
 * The number inputs on this page: every one of them is a "at most" budget.
 *
 * `Input` spreads its props onto a native `<input>` (ui-primitives/src/Input.tsx:14-23),
 * so `onChange` is React's change event, not a value: the text typed is on
 * `currentTarget.value`. Reading the handler's argument as a value used to write
 * the string `"[object Object]"` into every text field and `NaN` into every number.
 */
function NumberField(props) {
  return h('div', { className: 'dsh-router-field dsh-router-field-compact' },
    h('label', { className: 'dsh-router-label', htmlFor: props.id }, props.label),
    h(Input, {
      id: props.id,
      type: 'text',
      inputMode: 'numeric',
      value: String(props.value),
      disabled: props.disabled,
      onChange: function (event: ChangeEvent<HTMLInputElement>) {
        var parsed = Number(event.currentTarget.value.trim())
        if (!Number.isFinite(parsed)) return
        props.onChange(Math.max(0, Math.round(parsed)))
      },
    }),
    props.hint ? h('span', { className: 'dsh-router-hint' }, props.hint) : null)
}

/** A labelled text input; `mono` marks ids and route keys. */
function TextField(props) {
  return h('div', { className: 'dsh-router-field' },
    h('label', { className: 'dsh-router-label', htmlFor: props.id }, props.label),
    h(Input, {
      id: props.id,
      type: 'text',
      className: props.mono ? 'dsh-router-mono' : undefined,
      value: props.value,
      placeholder: props.placeholder,
      disabled: props.disabled,
      'aria-invalid': props.invalid ? 'true' : undefined,
      onChange: function (event: ChangeEvent<HTMLInputElement>) { props.onChange(event.currentTarget.value) },
    }),
    props.hint ? h('span', { className: 'dsh-router-hint' }, props.hint) : null)
}

/** A labelled textarea (purpose / instructions). */
function AreaField(props) {
  return h('div', { className: 'dsh-router-field' },
    h('label', { className: 'dsh-router-label', htmlFor: props.id },
      props.label,
      props.counter === undefined ? null : h('span', { className: 'dsh-router-counter' }, props.counter)),
    h('textarea', {
      id: props.id,
      className: 'dsh-router-textarea' + (props.invalid ? ' dsh-router-invalid' : ''),
      value: props.value,
      rows: props.rows ?? 4,
      placeholder: props.placeholder,
      disabled: props.disabled,
      'aria-invalid': props.invalid ? 'true' : undefined,
      // A native textarea: the handler names its element so `currentTarget` keeps
      // `.value` (React's string-element overload has no other source for it).
      onChange: function (event: ChangeEvent<HTMLTextAreaElement>) { props.onChange(event.currentTarget.value) },
    }),
    props.hint ? h('span', { className: 'dsh-router-hint' }, props.hint) : null)
}

/** One outcome / action checkbox row. */
function ChoiceRow(props) {
  return h('div', { className: 'dsh-router-check-grid' }, props.options.map(function (option) {
    return h(Checkbox, {
      key: option.value,
      className: 'dsh-router-check',
      checked: props.selected.indexOf(option.value) >= 0,
      disabled: props.disabled,
      label: option.label,
      onChange: function (next) { props.onToggle(option.value, next) },
    })
  }))
}

export function RosterView(props: RosterViewProps) {
  var t = props.t
  var handoff = props.handoff
  var selectedRef = useRef<HTMLDivElement | null>(null)
  var selected = handoff.roster.find(function (entry) { return entry.id === props.selectedId }) ?? null

  // The selected row must stay reachable in a list that scrolls on its own:
  // twelve roles at 44px overflow the 420px cap.
  useEffect(function () {
    var node = selectedRef.current
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }, [props.selectedId])

  /**
   * The editor for one selected role.
   *
   * Takes the entry as a parameter rather than closing over `selected`: the two
   * lookups it needs are the same one (position in the roster, which the problem
   * list is filtered by), and a non-null parameter is what lets the callbacks
   * below read `entry.id` without a null check.
   */
  function rosterEditor(entry: RosterEntry) {
    var index = handoff.roster.findIndex(function (candidate) { return candidate.id === entry.id })
    return h(RosterEditor, {
      t: t,
      entry: entry,
      index: index,
      chains: props.chains,
      disabled: props.disabled,
      problems: problemsFor(index),
      onEntry: props.onEntry,
      onRemove: props.onRemove,
    })
  }

  /** Whether the section's global route is half-filled (blocks the save). */
  var halfDefault = function () {
    return props.problems.some(function (problem) {
      return problem.key === 'problemHandoffHalfDefaultRoute'
    })
  }

  var problemsFor = function (index) {
    return props.problems.filter(function (problem) {
      return problem.key.indexOf('problemRoster') === 0 && problem.vars && problem.vars.index === index + 1
    })
  }

  /**
   * Walk the master list with the keyboard: ArrowUp/ArrowDown move the selection
   * one row, Home/End jump to the ends, and neither wraps — the list is a
   * position, not a carousel.
   *
   * This is the listbox's keyboard half, not a second selection path: every move
   * ends in `props.onSelect(entry.id)`, the same entry point a click and the rows'
   * Enter/Space use. The rows stay individually focusable (their Tab order and
   * the page's are unchanged), and nothing here edits the draft. DSH exports no
   * listbox primitive, and `Menu` is an anchored popover that would cover the
   * editor — so the handler stays on this list.
   */
  function walkList(event) {
    var index = handoff.roster.findIndex(function (entry) { return entry.id === props.selectedId })
    var last = handoff.roster.length - 1
    var next
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : Math.min(index + 1, last)
    else if (event.key === 'ArrowUp') next = index < 0 ? last : Math.max(index - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    var entry = handoff.roster[next]
    if (entry !== undefined && entry.id !== props.selectedId) props.onSelect(entry.id)
  }

  var outcomeOptions = HANDOFF_OUTCOMES.map(function (outcome) {
    return { value: outcome, label: t('handoffOutcome_' + outcome) }
  })
  var actionOptions = HANDOFF_NEXT_ACTIONS.map(function (action) {
    return { value: action, label: t('handoffNext_' + action.replace(/-/g, '_')) }
  })

  return h('div', { className: 'dsh-router-roster' },
    // ---- top: the master switch, the backend, the three budgets ----
    h('section', { className: 'dsh-router-section' },
      h('div', { className: 'dsh-router-section-head' },
        h('h2', { className: 'dsh-router-section-title' }, t('handoffTitle')),
        h(Tag, { tone: handoff.enabled ? 'success' : 'outline' },
          handoff.enabled ? t('handoffOn') : t('handoffOff'))),
      h('p', { className: 'dsh-router-hint' }, t('handoffIntro')),
      h('div', { className: 'dsh-router-field-grid' },
        h('div', { className: 'dsh-router-field' },
          h('span', { className: 'dsh-router-label' }, t('handoffEnabledLabel')),
          h(Switch, {
            checked: handoff.enabled,
            label: t('handoffEnabledLabel'),
            disabled: props.disabled,
            onChange: function (next) { props.onField(['enabled'], next) },
          }),
          h('span', { className: 'dsh-router-hint' }, t('handoffEnabledHint'))),
        h(TextField, {
          id: 'handoff-backend',
          label: t('handoffBackendLabel'),
          value: handoff.subagentBackend,
          placeholder: 'spawn',
          disabled: props.disabled,
          hint: t('handoffBackendHint'),
          onChange: function (next) { props.onField(['subagentBackend'], next) },
        }),
        h(NumberField, {
          id: 'handoff-max-delegations',
          label: t('handoffBudgetDelegations'),
          value: handoff.limits.maxDelegationsPerUserMessage,
          disabled: props.disabled,
          hint: t('handoffBudgetDelegationsHint'),
          onChange: function (next) { props.onField(['limits', 'maxDelegationsPerUserMessage'], next) },
        }),
        h(NumberField, {
          id: 'handoff-max-reviews',
          label: t('handoffBudgetReviews'),
          value: handoff.limits.maxReviewsPerUserMessage,
          disabled: props.disabled,
          hint: t('handoffBudgetReviewsHint'),
          onChange: function (next) { props.onField(['limits', 'maxReviewsPerUserMessage'], next) },
        }),
        h(NumberField, {
          id: 'handoff-max-sessions',
          label: t('handoffBudgetSessions'),
          value: handoff.limits.maxNewSessionsPerUserMessage,
          disabled: props.disabled,
          hint: t('handoffBudgetSessionsHint'),
          onChange: function (next) { props.onField(['limits', 'maxNewSessionsPerUserMessage'], next) },
        }),
        h(NumberField, {
          id: 'handoff-max-turn',
          label: t('handoffBudgetPerTurn'),
          value: handoff.limits.maxDelegationsPerTurn,
          disabled: props.disabled,
          hint: t('handoffBudgetPerTurnHint'),
          onChange: function (next) { props.onField(['limits', 'maxDelegationsPerTurn'], next) },
        })),

      // ---- the section's global delegation model ----
      //
      // Two supported shapes, one control group: fill this once and every role
      // without its own route uses it; leave it empty and those roles follow the
      // parent agent. The route is chosen whole — a half-filled pair blocks the
      // save through the shared structural rule (./validate.ts).
      h('h3', { className: 'dsh-router-subtitle' }, t('handoffDefaultsTitle')),
      h('p', { className: 'dsh-router-hint' }, t('handoffDefaultsHint')),
      h('div', { className: 'dsh-router-field-grid' },
        h(TextField, {
          id: 'handoff-default-provider',
          label: t('handoffProviderLabel'),
          value: handoff.delegateDefaults.provider,
          mono: true,
          disabled: props.disabled,
          invalid: halfDefault(),
          hint: t('handoffProviderHint'),
          onChange: function (next) { props.onField(['delegateDefaults', 'provider'], next) },
        }),
        h(TextField, {
          id: 'handoff-default-model',
          label: t('handoffModelLabel'),
          value: handoff.delegateDefaults.model,
          mono: true,
          disabled: props.disabled,
          invalid: halfDefault(),
          hint: t('handoffModelHint'),
          onChange: function (next) { props.onField(['delegateDefaults', 'model'], next) },
        }),
        h(TextField, {
          id: 'handoff-default-effort',
          label: t('handoffEffortLabel'),
          value: handoff.delegateDefaults.reasoningEffort,
          mono: true,
          disabled: props.disabled,
          hint: t('handoffEffortHint'),
          onChange: function (next) { props.onField(['delegateDefaults', 'reasoningEffort'], next) },
        }),
        h(NumberField, {
          id: 'handoff-default-max-tokens',
          label: t('handoffMaxTokensLabel'),
          value: handoff.delegateDefaults.maxTokens,
          disabled: props.disabled,
          hint: t('handoffMaxTokensHint'),
          onChange: function (next) { props.onField(['delegateDefaults', 'maxTokens'], next) },
        }))),

    // ---- master-detail ----
    h('section', { className: 'dsh-router-section' },
      h('div', { className: 'dsh-router-section-head' },
        h('h2', { className: 'dsh-router-section-title' }, t('handoffRosterTitle')),
        h('span', { className: 'dsh-router-hint' }, fill(t('handoffRosterCount'), { count: handoff.roster.length })),
        h(Button, {
          variant: 'outline',
          size: 'sm',
          disabled: props.disabled,
          onClick: props.onAdd,
        }, t('handoffAddRole'))),
      h('p', { className: 'dsh-router-hint' }, t('handoffReaderHint')),
      handoff.roster.length === 0
        ? h('div', { className: 'dsh-router-empty', role: 'status' },
            h('strong', null, t('handoffEmptyTitle')),
            h('p', null, t('handoffEmptyBody')))
        : h('div', { className: 'dsh-roster-body' },
            h('div', { className: 'dsh-roster-list', role: 'listbox', 'aria-label': t('handoffRosterTitle'), onKeyDown: walkList },
              handoff.roster.map(function (entry, index) {
                var active = entry.id === props.selectedId
                var bad = problemsFor(index).length > 0
                return h('div', {
                  key: entry.id + ':' + index,
                  ref: active ? selectedRef : undefined,
                  className: 'dsh-roster-item' + (active ? ' dsh-roster-item-active' : '') + (bad ? ' dsh-roster-item-invalid' : ''),
                  role: 'option',
                  'aria-selected': active ? 'true' : 'false',
                  tabIndex: 0,
                  onClick: function () { props.onSelect(entry.id) },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      props.onSelect(entry.id)
                    }
                  },
                },
                  h('span', { className: 'dsh-roster-item-name' }, entry.name || entry.id || t('handoffUnnamedRole')),
                  h('span', { className: 'dsh-roster-item-meta' },
                    h('span', null, t(entry.role === 'review' ? 'handoffRoleReview' : 'handoffRoleWork')),
                    entry.provider && entry.model ? h('span', { className: 'dsh-router-mono' }, routeKeyOf(entry.provider, entry.model)) : null),
                  bad ? h('span', { className: 'dsh-roster-item-badge' }, String(problemsFor(index).length)) : null)
              })),
            h('div', { className: 'dsh-roster-editor' },
              selected === null ? h('p', { className: 'dsh-router-hint' }, t('handoffSelectHint')) : rosterEditor(selected)))),

    // ---- protocol: the tool's visible actions and the review gate ----
    h('section', { className: 'dsh-router-section' },
      h('h2', { className: 'dsh-router-section-title' }, t('handoffProtocolTitle')),
      h('p', { className: 'dsh-router-hint' }, t('handoffProtocolHint')),
      h('div', { className: 'dsh-router-check-grid' },
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.protocol.delegate,
          disabled: props.disabled,
          label: t('handoffActionDelegate'),
          onChange: function (next) { props.onField(['protocol', 'delegate'], next) },
        }),
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.protocol.finish,
          disabled: props.disabled,
          label: t('handoffActionFinish'),
          onChange: function (next) { props.onField(['protocol', 'finish'], next) },
        }),
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.protocol.facts,
          disabled: props.disabled,
          label: t('handoffActionFacts'),
          onChange: function (next) { props.onField(['protocol', 'facts'], next) },
        })),
      h('h3', { className: 'dsh-router-subtitle' }, t('handoffReviewGateTitle')),
      h('p', { className: 'dsh-router-hint' }, t('handoffReviewGateHint')),
      h(ChoiceRow, {
        options: outcomeOptions,
        selected: handoff.protocol.requireReviewFor,
        disabled: props.disabled,
        onToggle: function (value, next) {
          props.onField(['protocol', 'requireReviewFor'], toggle(handoff.protocol.requireReviewFor, value, next))
        },
      }),
      h('div', { className: 'dsh-router-check-grid' },
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.protocol.allowReviewOverride,
          disabled: props.disabled,
          label: t('handoffAllowOverride'),
          onChange: function (next) { props.onField(['protocol', 'allowReviewOverride'], next) },
        }))),

    // ---- relay: what happens after a receipt ----
    h('section', { className: 'dsh-router-section' },
      h('h2', { className: 'dsh-router-section-title' }, t('handoffRelayTitle')),
      h('p', { className: 'dsh-router-hint' }, t('handoffRelayHint')),
      h('h3', { className: 'dsh-router-subtitle' }, t('handoffRelayOnFinish') + ' · ' + t('handoffRelayDefaultOff')),
      h(ChoiceRow, {
        options: outcomeOptions,
        selected: handoff.newSession.onFinish,
        disabled: props.disabled,
        onToggle: function (value, next) {
          props.onField(['newSession', 'onFinish'], toggle(handoff.newSession.onFinish, value, next))
        },
      }),
      h('div', { className: 'dsh-router-field-grid' },
        h('div', { className: 'dsh-router-field' },
          h('span', { className: 'dsh-router-label' }, t('handoffRelayNextAction')),
          h(SegmentedControl, {
            id: 'handoff-next-action',
            value: handoff.newSession.nextAction,
            label: t('handoffRelayNextAction'),
            disabled: props.disabled,
            options: actionOptions,
            onChange: function (next) { props.onField(['newSession', 'nextAction'], next) },
          })),
        h('div', { className: 'dsh-router-field' },
          h('span', { className: 'dsh-router-label' }, t('handoffRelayBriefing')),
          h('div', { className: 'dsh-router-check-grid' },
            HANDOFF_BRIEFING_ITEMS.map(function (item) {
              return h(Checkbox, {
                key: item,
                className: 'dsh-router-check',
                checked: handoff.newSession.briefing.indexOf(item) >= 0,
                disabled: props.disabled,
                label: t('handoffBriefing_' + item),
                onChange: function (next) { props.onField(['newSession', 'briefing'], toggle(handoff.newSession.briefing, item, next)) },
              })
            })))),
      h('div', { className: 'dsh-router-check-grid' },
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.newSession.keepGoal,
          disabled: props.disabled,
          label: t('handoffRelayKeepGoal'),
          onChange: function (next) { props.onField(['newSession', 'keepGoal'], next) },
        }),
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.newSession.carrySelection,
          disabled: props.disabled,
          label: t('handoffRelayCarrySelection'),
          onChange: function (next) { props.onField(['newSession', 'carrySelection'], next) },
        }),
        h(Checkbox, {
          className: 'dsh-router-check',
          checked: handoff.newSession.carryChainBinding,
          disabled: props.disabled,
          label: t('handoffRelayCarryChain'),
          onChange: function (next) { props.onField(['newSession', 'carryChainBinding'], next) },
        }))),

    // ---- the unreceipted stop: nudge and fallback ----
    h('section', { className: 'dsh-router-section' },
      h('h2', { className: 'dsh-router-section-title' }, t('handoffStopTitle')),
      h('p', { className: 'dsh-router-hint' }, t('handoffStopHint')),
      h('div', { className: 'dsh-router-field-grid' },
        h('div', { className: 'dsh-router-field' },
          h('span', { className: 'dsh-router-label' }, t('handoffNudgeLabel')),
          h(Switch, {
            checked: handoff.limits.nudgeWhenUnreceipted,
            label: t('handoffNudgeLabel'),
            disabled: props.disabled,
            onChange: function (next) { props.onField(['limits', 'nudgeWhenUnreceipted'], next) },
          }),
          h('span', { className: 'dsh-router-hint' }, t('handoffNudgeHint'))),
        h(NumberField, {
          id: 'handoff-max-nudges',
          label: t('handoffMaxNudges'),
          value: handoff.limits.maxNudgesPerTurn,
          disabled: props.disabled,
          hint: t('handoffMaxNudgesHint'),
          onChange: function (next) { props.onField(['limits', 'maxNudgesPerTurn'], next) },
        }),
        h(TextField, {
          id: 'handoff-delegate-to',
          label: t('handoffDelegateTo'),
          value: handoff.onUnreceiptedStop.delegateTo,
          placeholder: t('handoffDelegateToEmpty'),
          disabled: props.disabled,
          hint: t('handoffDelegateToHint'),
          onChange: function (next) { props.onField(['onUnreceiptedStop', 'delegateTo'], next) },
        }),
        h('div', { className: 'dsh-router-field' },
          h('span', { className: 'dsh-router-label' }, t('handoffReportToUser')),
          h(Switch, {
            checked: handoff.onUnreceiptedStop.reportToUser,
            label: t('handoffReportToUser'),
            disabled: props.disabled,
            onChange: function (next) { props.onField(['onUnreceiptedStop', 'reportToUser'], next) },
          }),
          h('span', { className: 'dsh-router-hint' }, t('handoffReportToUserHint'))))))
}

/** Add or remove one value from a closed list, keeping the schema's order. */
function toggle(list, value, next) {
  if (next) return list.indexOf(value) >= 0 ? list.slice() : list.concat([value])
  return list.filter(function (item) { return item !== value })
}

/** The editor for one role. Every field's reader is named in the hint. */
function RosterEditor(props) {
  var t = props.t
  var entry = props.entry
  var invalid = function (key) {
    return props.problems.some(function (problem) { return problem.key === key }) ? 'true' : undefined
  }
  var prefix = 'roster-' + props.index
  return h('div', { className: 'dsh-roster-editor-body' },
    props.problems.length > 0
      ? h('div', { className: 'dsh-router-notice dsh-router-notice-error', role: 'alert' },
          h('strong', null, t('handoffRoleProblems')),
          h('ul', { className: 'dsh-router-problem-list' },
            props.problems.map(function (problem, index) {
              return h('li', { key: index }, fill(t(problem.key), problem.vars))
            })))
      : null,
    h('h3', { className: 'dsh-router-subtitle' }, t('handoffIdentityTitle')),
    h('div', { className: 'dsh-router-field-grid' },
      h(TextField, {
        id: prefix + '-id',
        label: t('handoffRoleId'),
        value: entry.id,
        mono: true,
        disabled: props.disabled,
        invalid: invalid('problemRosterEmptyId') !== undefined || invalid('problemRosterDuplicateId') !== undefined,
        hint: t('handoffRoleIdHint'),
        onChange: function (next) { props.onEntry(entry.id, 'id', next) },
      }),
      h(TextField, {
        id: prefix + '-name',
        label: t('handoffRoleName'),
        value: entry.name,
        disabled: props.disabled,
        hint: t('handoffRoleNameHint'),
        onChange: function (next) { props.onEntry(entry.id, 'name', next) },
      }),
      h('div', { className: 'dsh-router-field' },
        h('span', { className: 'dsh-router-label' }, t('handoffRoleKind')),
        h(SegmentedControl, {
          id: prefix + '-role',
          value: entry.role,
          label: t('handoffRoleKind'),
          disabled: props.disabled,
          options: HANDOFF_ROLES.map(function (role) {
            return { value: role, label: t(role === 'review' ? 'handoffRoleReview' : 'handoffRoleWork') }
          }),
          onChange: function (next) { props.onEntry(entry.id, 'role', next) },
        }),
        h('span', { className: 'dsh-router-hint' }, t('handoffRoleKindHint')))),

    h('h3', { className: 'dsh-router-subtitle' }, t('handoffWordsTitle')),
    h(AreaField, {
      id: prefix + '-purpose',
      label: t('handoffPurposeLabel'),
      value: entry.purpose,
      rows: 3,
      disabled: props.disabled,
      invalid: invalid('problemRosterEmptyPurpose') !== undefined,
      hint: t('handoffPurposeHint'),
      onChange: function (next) { props.onEntry(entry.id, 'purpose', next) },
    }),
    h(AreaField, {
      id: prefix + '-instructions',
      label: t('handoffInstructionsLabel'),
      value: entry.instructions,
      rows: 6,
      disabled: props.disabled,
      counter: fill(t('handoffInstructionsCounter'), {
        length: entry.instructions.length,
        max: HANDOFF_INSTRUCTIONS_MAX,
      }),
      invalid: invalid('problemRosterInstructionsTooLong') !== undefined || invalid('problemRosterNoDefinition') !== undefined,
      hint: t('handoffInstructionsHint'),
      onChange: function (next) { props.onEntry(entry.id, 'instructions', next) },
    }),
    h(TextField, {
      id: prefix + '-preset',
      label: t('handoffPresetLabel'),
      value: entry.preset,
      mono: true,
      disabled: props.disabled,
      invalid: invalid('problemRosterNoDefinition') !== undefined,
      hint: t('handoffPresetHint'),
      onChange: function (next) { props.onEntry(entry.id, 'preset', next) },
    }),

    h('h3', { className: 'dsh-router-subtitle' }, t('handoffRunTitle')),
    h('div', { className: 'dsh-router-field-grid' },
      h(TextField, {
        id: prefix + '-provider',
        label: t('handoffProviderLabel'),
        value: entry.provider,
        mono: true,
        disabled: props.disabled,
        invalid: invalid('problemRosterHalfRoute') !== undefined,
        hint: t('handoffProviderHint'),
        onChange: function (next) { props.onEntry(entry.id, 'provider', next) },
      }),
      h(TextField, {
        id: prefix + '-model',
        label: t('handoffModelLabel'),
        value: entry.model,
        mono: true,
        disabled: props.disabled,
        invalid: invalid('problemRosterHalfRoute') !== undefined,
        hint: t('handoffModelHint'),
        onChange: function (next) { props.onEntry(entry.id, 'model', next) },
      }),
      h(TextField, {
        id: prefix + '-effort',
        label: t('handoffEffortLabel'),
        value: entry.reasoningEffort,
        mono: true,
        disabled: props.disabled,
        hint: t('handoffEffortHint'),
        onChange: function (next) { props.onEntry(entry.id, 'reasoningEffort', next) },
      }),
      h(NumberField, {
        id: prefix + '-max-tokens',
        label: t('handoffMaxTokensLabel'),
        value: entry.maxTokens,
        disabled: props.disabled,
        hint: t('handoffMaxTokensHint'),
        onChange: function (next) { props.onEntry(entry.id, 'maxTokens', next) },
      }),
      h(TextField, {
        id: prefix + '-failover',
        label: t('handoffFailoverLabel'),
        value: entry.failover,
        mono: true,
        disabled: props.disabled,
        invalid: invalid('problemRosterUnknownFailoverChain') !== undefined,
        hint: fill(t('handoffFailoverHint'), { chains: props.chains.map(function (chain) { return chain.id }).join(' / ') }),
        onChange: function (next) { props.onEntry(entry.id, 'failover', next) },
      }),
      h(NumberField, {
        id: prefix + '-max-runs',
        label: t('handoffMaxRunsLabel'),
        value: entry.maxRunsPerUserMessage,
        disabled: props.disabled,
        hint: t('handoffMaxRunsHint'),
        onChange: function (next) { props.onEntry(entry.id, 'maxRunsPerUserMessage', next) },
      })),

    h('h3', { className: 'dsh-router-subtitle' }, t('handoffAttachTitle')),
    h('p', { className: 'dsh-router-hint' }, t('handoffAttachHint')),
    h('div', { className: 'dsh-router-check-grid' },
      HANDOFF_ATTACH_ITEMS.map(function (item) {
        return h(Checkbox, {
          key: item,
          className: 'dsh-router-check',
          checked: entry.attach.indexOf(item) >= 0,
          disabled: props.disabled,
          label: t('handoffAttach_' + item),
          onChange: function (next) {
            props.onEntry(entry.id, 'attach', toggle(entry.attach, item, next))
          },
        })
      })),

    h('div', { className: 'dsh-router-actions' },
      h(Button, {
        variant: 'ghost',
        size: 'sm',
        disabled: props.disabled,
        onClick: function () { props.onRemove(entry.id) },
      }, t('handoffRemoveRole'))))
}

