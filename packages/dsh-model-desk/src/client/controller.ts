/**
 * The page's controller: a draft over the Host section, saved through
 * whole-section path ops. The Host is the only authority on acceptance, so
 * a save that did not land keeps the draft and the scope subscription
 * re-seeds from whatever the Host holds next.
 *
 * Note: host/draft 基准必须是两个独立对象 —— 见
 * .agents/notes/implemented/2026-10-15-host-draft-baseline-independence.md
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { UpdateCheck } from '../types.ts'
import type { HandoffConfig, HealthConfig, NamedChain } from '../config.ts'
import { clone, deepEqual, fill, summarize } from './format.ts'
import { defaultChainValue, normalizeNamedChain, normalizeHealth, normalizeHandoff, validate } from './validate.ts'
import type { Problem } from './validate.ts'
import { defaultChainOf, effectiveChains } from '../chain.ts'
import { pruneTimeline, TIMELINE_RETENTION_SECONDS } from '../timeline.ts'
import { configuredRouteList, routeKeyOf, routeParts } from '../routes.ts'
import { DEFAULT_FIRST_HOP_MAX_RETRIES, DEFAULT_HANDOFF_MAX_RUNS_PER_USER_MESSAGE, DEFAULT_MAX_RETRIES, DEFAULT_MAX_TOKEN_CONTINUES, HANDOFF_ATTACH_ITEMS, HANDOFF_FAILOVER_INHERIT, MAX_RETRIES, MAX_TOKEN_CONTINUES, POLICY_VERSION } from '../defaults.ts'
import { RELEASE_VERSION } from '../release.generated.ts'

/** Where the browser remembers the last release whose notes it has shown. */
var SEEN_VERSION_KEY = 'dsh-model-desk:seen-version'

/**
 * 故障转移抽屉往回看多远，毫秒。与健康时间线的保留时长同一个数字（24 h），
 * 但它是抽屉自己的窗口：账本条目跨会话折进来没有别的裁剪，不给窗口就会把很久
 * 以前的转移当成"最近"。理由与锚点的差别见 `foldFailoverRows`。
 */
var FAILOVER_WINDOW_MS = TIMELINE_RETENTION_SECONDS * 1000

/**
 * The release whose notes this browser last acknowledged, or null when it has
 * never seen one (fresh install, or storage denied).
 */
function seenVersion() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(SEEN_VERSION_KEY)
  } catch (error) {
    return null
  }
}

/** Remember the running release after the user dismisses its notes. */
function rememberVersion() {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(SEEN_VERSION_KEY, RELEASE_VERSION)
  } catch (error) {
    // Storage can be denied while the app still works. The dialog then appears
    // again on the next load; that is better than failing the page over a
    // courtesy notice.
  }
}

/**
 * Whether this activation should open the release notes.
 *
 * Read by the browser-half entry **before its first await**: the activation has
 * the page's real `localStorage` then, while a later read can race the client
 * module system swapping the global window between test/browser contexts.
 * Exported so `apply.ts` can compute it synchronously and hand it in.
 */
export function notesForCurrentVersion() {
  return seenVersion() !== RELEASE_VERSION
}

/** What one manual run found, kept on screen until the next run. */
interface RunSummary {
  total: number
  counts: Record<string, number>
  text: string
}

/**
 * The workbench's view state.
 *
 * Nothing here is config: it is not saved, not part of the draft, and not
 * compared for dirtiness. Declared because most of these fields start empty
 * (`null`, `{}`, `[]`) and only the declaration says what they will hold — a
 * `null` inferred from the initializer would reject the first real write.
 */
interface RouterUi {
  /** `'__health__'` / `'__roster__'` / `'__chain__'`, or nothing selected yet. */
  activeId: string | null
  /** Which chain the editor is on (null = the default chain). */
  chainId: string | null
  /** Which roster entry the editor is on (null = none). */
  rosterId: string | null
  modal: { kind: string } | null
  riskAck: boolean
  /** The Host's catalog payload (`session/modelCatalog`), or null until read. */
  catalog: ModelCatalog | null
  catalogFailed: boolean
  catalogLoading: boolean
  /** The Host's own words for the last refused save; null when we have none. */
  saveError: string | null
  /**
   * The Host's stored value changed while this draft had unsaved edits.
   *
   * The edits were KEPT (losing them is worse than showing a stale Host value),
   * so the page has to say so instead of letting the footer read "unsaved".
   */
  externalChange: boolean
  drawerOpen: boolean
  drawerLoading: boolean
  drawerError: boolean
  /** One row per session with entries inside the window (see `foldFailoverRows`). */
  drawerRows: readonly FailoverRow[]
  passive: Record<string, unknown>
  discover: Record<string, unknown>
  checking: boolean
  checkingRoutes: Record<string, boolean>
  probe: Record<string, unknown>
  probing: boolean
  probingRoutes: Record<string, boolean>
  checkSummary: RunSummary | null
  probeSummary: RunSummary | null
  /** Why the passive read failed, or null when it was whole. */
  passiveError: string | null
  notesOpen: boolean
  updateOpen: boolean
  updateChecking: boolean
  /** The Host's answer to "is there a newer release". */
  updateResult: UpdateCheck | null
  updateError: string | null
}

/**
 * One session's slice of the failover history, as the drawer reads it.
 *
 * The envelope is typed; the two payload columns stay `unknown` on purpose. They
 * do have types — `ChannelHealthRecord` (`health.ts:76`) and `FailoverEntry`
 * (`lineage.ts:29`) — but importing either here is not a type-only decision:
 * those modules import the **host** session entries, and pulling them into this
 * program replaces the browser's `Context.sessions` merge with the host face, so
 * `refreshProjections` / `refresh` / `subagentAddress` vanish and the fleet code
 * stops compiling (measured 2026-10-24: three errors, that shape). The columns
 * are folded on the Host and reach the drawer through `any` props, so naming
 * them here would buy a comment, not a check — not worth un-typing the client
 * session store for.
 */
interface HistoryRead {
  sessionId: string
  /** The session's `router/channel-health` map, keyed by route; null when absent. */
  health: Record<string, unknown> | null
  /** Its `router/failover-history` ledger entries, oldest first. */
  entries: readonly unknown[]
}

/**
 * One row the failover dialog paints: the session and the entries that survived
 * the window, oldest first. Health is deliberately not carried — that view reads
 * the same fold and needs the other column.
 */
interface FailoverRow {
  sessionId: string
  entries: readonly unknown[]
}

/** The page's editable config value: the Host's section, normalized for the form. */
interface ConfigDraft {
  enabled: boolean
  chains: NamedChain[]
  defaultChainId: string
  health: HealthConfig
  handoff: HandoffConfig
}

/**
 * What the store publishes, which is what the page renders.
 *
 * Declared because this is the seam that used to drift silently: `ui` is the same
 * bag the controller mutates, minus `chainId` (which chain the editor is on is
 * the controller's own business — the page reads the derived `draft.chain`), so
 * `Omit` keeps one list of fields instead of two, and `project()` has to supply
 * every one of them. `page.ts` types the value it renders from the store with
 * this, so a field that stops being published breaks the reader, not the user.
 */
export interface RouterSnapshot {
  /** The config scope answered; a pending read renders the unavailable line. */
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  /** The draft plus the `chain` alias the one-chain editor reads. */
  draft: ConfigDraft & { chain: NamedChain }
  problems: Problem[]
  ui: Omit<RouterUi, 'chainId'>
}

/**
 * @param initialNotesOpen - whether to open the release notes on this activation.
 */
export function createController(ctx, scope, t, initialNotesOpen = notesForCurrentVersion()) {
  var seed = function () {
    var value = scope.getSnapshot().value ?? {}
    // 旧配置（单链 / 按模型分规则 + 默认兜底池）在这里迁成命名链：规则模块与宿主读的
    // 是同一个 effectiveChains。
    //
    // 但两边拿到的**形状不一样**：宿主读 `fiber._config`（原始配置，"有没有这个键"
    // 是形状判据），而 settings 快照是**校验后**的值——schemastery 会给任何数组盖上
    // `[]`，于是只有旧 `chain` 的配置在界面上变成"一条空链"：降级候选全消失，而按
    // 一下保存就会把空链写回宿主（`save()` 还顺手 unset 旧键），用户的链被清空。
    // 这里按宿主那条规则把可用信息还原：空的 `chains` 且旧 `chain` 有候选 = 旧形状。
    // （只有校验后的值会出现这个组合；`save()` 保存新形状时会 unset `chain`。）
    var validated = value
    var looksLegacy = Array.isArray(validated.chains) && validated.chains.length === 0
      && Array.isArray(validated.chain?.candidates) && validated.chain.candidates.length > 0
    var effective = effectiveChains(looksLegacy ? { ...validated, chains: undefined } : validated)
    return {
      // 与 host schema 的默认值同源：接管会改请求实际打到的渠道，默认关。
      enabled: value.enabled ?? false,
      chains: effective.chains.map(normalizeNamedChain),
      defaultChainId: effective.defaultChainId,
      // A config saved by an older build carries the flat health shape; the
      // three tiers are re-derived here so one old row cannot leave the UI
      // reading `undefined` for a tier that has a perfectly good default.
      health: normalizeHealth(value.health),
      // 委派名册：旧配置里没有这一节，缺省即"整段的默认值"（总闸关），不是"用户全关了"。
      handoff: normalizeHandoff(value.handoff),
    }
  }
  var host = seed()
  var draft = seed()
  var ui: RouterUi = {
    activeId: null,
    // 链列表里正在编辑的那一条（null = 默认链）。这是视图状态，不是配置：不写进 draft，
    // 也不参与脏检查——"我在看哪条链"与"配置改了什么"是两件事。
    chainId: null,
    // 名册里正在编辑的那一个角色（null = 没选）。同一条规矩：视图状态不进 draft。
    rosterId: null,
    modal: null,
    riskAck: false,
    catalog: null,
    catalogFailed: false,
    catalogLoading: false,
    saveError: null,
    externalChange: false,
    drawerOpen: false,
    drawerLoading: false,
    drawerError: false,
    // 抽屉里"没有记录"与"读不到"必须是两种渲染：后者是 drawerError
    // （整份列表被拒），前者是读到了一条窗口内的记录都没有。
    drawerRows: [],
    // Passive observation, folded by the host projection out of real
    // conversation outcomes. Keyed by route, merged across recent sessions.
    passive: {},
    // Verdicts from the last connectivity check, keyed by route. Ephemeral
    // by nature: a check answers "right now", so it is never persisted.
    discover: {},
    checking: false,
    checkingRoutes: {},
    // Verdicts from the last end-to-end probe (1 token, TTFT cut), keyed by
    // route. Ephemeral for the same reason as `discover`; a scheduled run's
    // report is read from the Host when the health view opens.
    probe: {},
    probing: false,
    probingRoutes: {},
    // What the last manual run found, kept on screen until the next run. A
    // check that changes nothing visible reads as "nothing happened" — the
    // counts are the feedback, not the dots.
    checkSummary: null,
    probeSummary: null,
    // Why the channel history could not be read, or null when the last read was
    // whole. A failed read used to fall through to an empty fold, which renders
    // exactly like "no channel has ever run" — the one lie this workspace cannot
    // afford, since its whole job is telling the user what a channel did.
    //
    // Note: 为何"读不到"必须上屏 —— 见
    // .agents/notes/implemented/2026-10-21-connectivity-deadline-and-honest-history.md
    passiveError: null,
    // 这一版更新日志是否该弹：只在浏览器记录的版本与当前产物不同（或从没记过）
    // 时为真。关掉即记账，所以同版本不会每次打开都弹。
    notesOpen: initialNotesOpen,
    // 「检查更新」弹窗：它问宿主"有没有更新的版本"，并把新版本的说明读回来。
    // 三种状态分开存：检查中、查到的结果、以及连宿主都没答上来的那一层失败。
    updateOpen: false,
    updateChecking: false,
    updateResult: null,
    updateError: null,
  }
  var saving = false
  var failed = false
  // 本插件"面"的在位计数。唯一的持有者是侧栏弹窗里的工作台（page.ts 的挂载
  // 副作用）——侧栏入口按钮本身不计数：它常驻，一计数 surfaceActive() 就恒真，
  // Ctrl+S 会被全局认领（regions 覆盖输入框与终端），而只读时 save() 只是空转、
  // 并不阻止认领。仍然是计数不是布尔：React 的 effect 成对到来（严格模式下
  // 挂-卸-挂），一次不配对的释放不该把门永久焊死。
  // 原生快捷键命令靠它判断"现在该不该由我接这个键"——DSH 的快捷键上下文只告诉
  // 它有没有模态、是哪個模态，不告诉它哪个设置面在前台。
  var surfaceCount = 0
  /** Busy-state floor timers in flight; cleared on dispose (`holdBusy`). */
  var busyTimers = new Set<ReturnType<typeof setTimeout>>()

  function project(): RouterSnapshot {
    var snapshot = scope.getSnapshot()
    var problems = validate(draft)
    // The store freezes what it is given, so the published state must be a
    // detached snapshot: the controller keeps mutating its own draft.
    var published = clone(draft)
    // 默认链在快照里还有一份别名 `chain`：界面按"一条链"编辑，而链列表里的哪一条
    // 是默认链只有 draft 知道。它是派生的视图、不是第二份状态——draft 上并没有这个
    // 键，`dirty` 比较的也是没有它的那一份；冻结发生在 clone 之后，所以草稿不受影响。
    published.chain = edited(published)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: !deepEqual(draft, host),
      invalid: problems.length > 0,
      saving: saving,
      failed: failed,
      draft: published,
      problems: problems,
      ui: {
        activeId: ui.activeId,
        rosterId: ui.rosterId,
        modal: ui.modal,
        riskAck: ui.riskAck,
        catalog: ui.catalog,
        catalogFailed: ui.catalogFailed,
        catalogLoading: ui.catalogLoading,
        saveError: ui.saveError,
        externalChange: ui.externalChange,
        drawerOpen: ui.drawerOpen,
        drawerLoading: ui.drawerLoading,
        drawerError: ui.drawerError,
        drawerRows: ui.drawerRows,
        passive: ui.passive,
        discover: ui.discover,
        checking: ui.checking,
        checkingRoutes: ui.checkingRoutes,
        probe: ui.probe,
        probing: ui.probing,
        probingRoutes: ui.probingRoutes,
        checkSummary: ui.checkSummary,
        probeSummary: ui.probeSummary,
        passiveError: ui.passiveError,
        notesOpen: ui.notesOpen,
        updateOpen: ui.updateOpen,
        updateChecking: ui.updateChecking,
        updateResult: ui.updateResult,
        updateError: ui.updateError,
      },
    }
  }
  var store = createSnapshotStore(project())
  var disposed = false
  function publish() {
    // 卸载之后的迟到发布（在飞远程调用的回调、忙态下限的 setTimeout）会经
    // armDiscoverTimer 把定时器复活——dispose 清掉的 interval 又回来了，而 UI
    // 早已不在，巡检周期对着一个卸载了的 fiber 空转。卸载后 publish 什么都不做。
    if (disposed) return
    store.set(project()); armDiscoverTimer()
  }

  /**
   * 定时连通性检查。跑在浏览器/桌面壳里，所以只在整个 DSH 界面开着的时候有效——
   * 这一点在设置里写明了，不假装是后台常驻。周期由用户按自己渠道的限流承受
   * 能力定，插件不设下限：限流是每个渠道各自的，不是几个渠道加起来算的。
   *
   * 周期读 **host**（已保存的配置）而不是 draft：未保存的编辑不该改变正在跑的
   * 巡检节奏，保存成功才重新武装——与宿主侧探针定时器"保存即 fiber 重启按新周期
   * 重武装"是同一套语义。
   */
  var discoverTimer: ReturnType<typeof setInterval> | null = null
  var armedSeconds = -1
  // 忙态的最短可见时长：长到看得清、短到不觉慢。见 controller.holdBusy 的注释——
  // 预检即失败的路由（NO_ADAPTER / MISSING_CREDENTIAL）会在微任务里 resolve，
  // 不设下限的话"忙"和"完成"被 React 批进同一帧，用户看不到任何反馈。
  var MIN_BUSY_MS = 450
  function armDiscoverTimer() {
    var health = host.health || {}
    var seconds = health.discover && health.discover.enabled ? (health.discover.intervalSeconds || 0) : 0
    if (seconds === armedSeconds) return
    armedSeconds = seconds
    if (discoverTimer !== null) { clearInterval(discoverTimer); discoverTimer = null }
    if (seconds > 0) discoverTimer = setInterval(function () { controller.checkAll() }, seconds * 1000)
  }

  /**
   * Load the model catalog once per activation.
   *
   * It is no longer only the add-candidate dialog's data source: every row that
   * names a route reads the user's display names from it, so the workbench asks
   * for it when the page mounts. Read once — the catalog does not change under a
   * running host generation, and a second read would only re-ask the Host.
   */
  function ensureCatalog() {
    if (ui.catalog !== null || ui.catalogLoading) return
    ui.catalogLoading = true
    publish()
    ctx.remote.session.modelCatalog().then(function (result) {
      // Remote calls resolve to the `{ ok, value }` envelope, not the bare
      // value (the ui-settings-models / ui-model-selection precedent).
      if (!result.ok) throw new Error(result.error?.message ?? 'model catalog refused')
      ui.catalog = result.value
      ui.catalogLoading = false
      publish()
    }).catch(function () {
      ui.catalogFailed = true
      ui.catalogLoading = false
      publish()
    })
  }

  /**
   * 合并一条渠道在新旧两份记录里的观测。时间线取**去重后的并集**并按时间排序——
   * 可用率是全局事实：同一个渠道这个会话用、那个会话也用，并发三个会话更是同时在用，
   * 统计必须合在一起算，没有"属于哪个会话"这一说。
   *
   * 标量（状态/延迟/吞吐/最后错误）取**观测时间**较新的那份，不是"后合进来的那份"。
   * 参数名 older/newer 只表示调用方的合并顺序，不构成观测新旧：`readSessionBlocks`
   * 按会话的 `updatedAt` 排序，而那个读数是"哪个会话最近有人说话"
   * （`session.list` 的 `max(createdAt, lastPromptAt)`），冷会话那份来自会滞后的
   * 持久化投影缓存——拿它当观测新旧，就会让"排序靠前但观测更晚"的记录输给
   * "排序靠后但观测更早"的记录。所以判据是记录自带的 `lastCheckedAt`。
   *
   * 两份里只有一份写了 `lastCheckedAt` 时无从比较，退回调用方顺序（修复前的行为）：
   * 未知既不是 0，也不等于最新——不声明观测时间的记录不构成排名证据。
   *
   * 去重是必须的：`loadPassive()` 会在挂载、打开健康页、每轮巡检后重读同样 20 个
   * 会话，同一批观测点会被反复并进来。不按 time 去重，数组随页面停留时间无界增长，
   * 工作台的可用率与"观测点数"也跟着漂移。窗口与 host 的 `pushTimelinePoint` 同口径
   * （MAX_TIMELINE_POINTS），不立第二套标准。
   *
   * Note: 为何不是"整记录覆盖 + 最新会话赢"、为何不合并时间线窗口 —— 见
   * .agents/notes/implemented/2026-10-15-health-monitoring-cross-session-merge.md
   * Note: 为何标量按 lastCheckedAt 而不是会话顺序 —— 见
   * .agents/notes/implemented/2026-10-24-health-scalars-by-observation-time.md
   */
  function mergeHealthRecord(older, newer) {
    if (older === undefined || older === null) return newer
    var seen = {}
    var points = (older.timeline ?? []).concat(newer.timeline ?? [])
      .filter(function (point) {
        var key = point.time + ':' + point.status
        if (seen[key]) return false
        seen[key] = true
        return true
      })
      .sort(function (a, b) { return a.time - b.time })
    // 窗口规则与 host 的 pushTimelinePoint 同源（../timeline.ts 的 pruneTimeline：
    // 按时间戳保留 24 小时 + 条数上限）。此前这里是"最近 24 次观测"，与 host 的
    // 同一句注释说的是两件事——合并后看到的比投影里存的多/少，而时间轴现在画的是
    // 固定格数 × 时长桶，裁剪规则不一致就会让柱子与可用率各算一套。
    var olderAt = observationTime(older)
    var newerAt = observationTime(newer)
    // 只有两份都写明了观测时间才重排；任一缺失就退回调用方顺序（= 修复前行为）。
    var base = olderAt !== null && newerAt !== null && olderAt > newerAt ? older : newer
    return Object.assign({}, base, { timeline: pruneTimeline(points) })
  }

  /**
   * 记录自带的观测时间，作为"哪份标量更新"的唯一判据。缺失返回 `null` 而不是 0：
   * 一个不声明观测时间的记录不构成排名证据，未知不等于最新。
   */
  function observationTime(record) {
    var at = record === undefined || record === null ? undefined : record.lastCheckedAt
    return typeof at === 'number' && isFinite(at) ? at : null
  }

  /**
   * 把一批会话的记录按旧→新合进目标表。
   *
   * 目标由调用方传入而不是直接读 `ui.passive`：被动快照描述的是"最近这批会话
   * 里发生过什么"，每次读取必须从空表折起。合进上一份 `ui.passive` 会让一条
   * 已经从所有链里删掉的渠道以幽灵行留在健康页，直到刷新。
   */
  function mergeHealthRecords(target, records) {
    if (!records) return target
    Object.keys(records).forEach(function (route) {
      target[route] = mergeHealthRecord(target[route], records[route])
    })
    return target
  }

  /**
   * 故障转移历史的跨会话窗口与行序，两件事都只由条目自身的 `time` 决定。
   *
   * 账本没有"哪条最新"的跨会话读数可用：会话的 `updatedAt` 是会滞后的缓存水位
   * （`max(createdAt, lastPromptAt)`），拿它挑成员正是上一版 20 会话窗口的毛病。
   * 所以这里只做一次纯折叠：每条会话的条目按窗口筛，行按各自最新条目的时间降序
   * 排，筛空的会话整行不出现。条目缺时间戳按未知处理（未知不是 0）。
   *
   * 窗口从**墙上时钟**算，不从最新条目算：抽屉标题是"最近故障转移历史"，
   * 三天前的转移不是最近。24 h 与健康时间线保留的时长同一个数字
   * （../timeline.ts 的 TIMELINE_RETENTION_SECONDS），但锚点不同——那边从最新
   * 观测算，因为冷会话是事后才折进来的，按墙上时钟会把它的整段历史丢掉；抽屉
   * 回答的是"现在往回看最近发生过什么"。
   */
  function foldFailoverRows(reads, now) {
    var oldest = now - FAILOVER_WINDOW_MS
    var rows: Array<{ sessionId: string, entries: any[], newest: number }> = []
    reads.forEach(function (read) {
      var kept = read.entries.filter(function (entry) {
        return typeof entry.time === 'number' && entry.time >= oldest
      })
      if (kept.length === 0) return
      var ordered = kept.slice().sort(function (a, b) { return a.time - b.time })
      rows.push({ sessionId: read.sessionId, entries: ordered, newest: ordered[ordered.length - 1].time })
    })
    rows.sort(function (a, b) { return b.newest - a.newest })
    return rows.map(function (row) { return { sessionId: row.sessionId, entries: row.entries } })
  }

  /** An error as one line of text, for a message that has to be shown as-is. */
  function describeError(error) {
    if (error && typeof error.message === 'string' && error.message.length > 0) return error.message
    return String(error)
  }

  /**
   * Fold `session.list` into the two projection blocks both views need: the
   * passive health map and the failover ledger, one entry per session.
   *
   * This is a pure fold over DSH's own listing. `session.list` returns **every**
   * visible session, already ordered by `updatedAt`, and each row inlines its
   * `projections` block (`packages/api/session-controller/src/list.ts:132-165`,
   * `types.ts:178-191`; `hintsOf` carries the wire values out unchanged,
   * `list.ts:321-329`). So the previous shape — one `session.projections()`
   * round-trip per session inside a self-invented "last 20" window — is gone.
   * That window picked its members by `updatedAt`, a read that lags the log by up
   * to 13.7 h on this machine, so the newest observation could sit outside it.
   *
   * A missing key means "this session never wrote it" (a session that never used
   * the router has neither block, and `hintsOf` only emits a block that holds
   * values), not "the read failed". The one real refusal left is the list itself,
   * which the callers report as a wholesale failure.
   *
   * Note: 为何两个视图必须共用这一份读取、失败为何不能折成空 —— 见
   * .agents/notes/implemented/2026-10-23-honest-surfaces.md
   * Note: 为何去掉 20 会话窗口、抽屉为何自带时间窗 —— 见
   * .agents/notes/implemented/2026-10-24-folds-the-whole-session-list.md
   */
  function readSessionBlocks(session) {
    return session.list({}).then(function (result) {
      if (!result.ok) throw new Error(describeError(result.error) || 'session.list was refused')
      return (result.value?.items ?? []).map(function (entry) {
        var block = entry.projections
        var values = block !== undefined && block !== null ? (block.values ?? {}) : {}
        return {
          sessionId: entry.sessionId,
          health: values['router/channel-health'] ?? null,
          entries: values['router/failover-history'] ?? [],
        }
      })
    })
  }

  /**
   * Read the host projection's passive records. Health is a cross-session
   * fact, so this folds every session DSH lists rather than pretending one
   * session is the whole story; the per-record `lastCheckedAt` decides which
   * scalars win (see `mergeHealthRecord`).
   */
  function loadPassive() {
    var session = ctx.remote && ctx.remote.session
    if (!session) return
    readSessionBlocks(session).then(function (reads) {
      // 先拷贝再写入：store 的 set 会 dev-freeze 它收到的对象，之后往原对象上
      // 赋值在 dev 构建里会静默失败（圆点永远显示"未探测"）。所以折进一张新表，
      // 折完整体换上——也顺便让"这批会话之外"的旧记录自然消失。
      var folded = {}
      for (var i = 0; i < reads.length; i++) mergeHealthRecords(folded, reads[i].health)
      ui.passive = folded
      // 整份列表读到了就没有"部分失败"可言：一条缺块的行只说明那个会话没写过，
      // 不是读不到（见 readSessionBlocks）。真正的失败走下面的 catch。
      ui.passiveError = null
      publish()
    }).catch(function (error) {
      // The list itself failed, so not one session was read. Say that instead of
      // publishing the empty fold the old code left behind.
      ui.passiveError = fill(t('healthHistoryUnreadable'), { error: describeError(error) })
      publish()
    })
  }
  loadPassive()

  /**
   * Connectivity check: ask the Host for one or more routes' model lists
   * through DSH's own discovery — the same call the Models page's "fetch
   * available models" button makes. It sends no content, so it costs no tokens,
   * and it proves three things a stale config cannot: the endpoint answers,
   * the credential is accepted, and this model id is advertised.
   *
   * The call goes to this plugin's own Host face rather than to
   * `remote.llm.discoverModels` directly, because the classification has to
   * happen where the `LlmError` code is still alive — see
   * ../connectivity.ts. The browser receives an already-classified verdict and
   * never has to guess from a message.
   *
   * A run always answers for every route it was asked about: the Host
   * guarantees one verdict per requested route, and the two paths that cannot
   * reach it at all (the face unmounted, the call refused) synthesize the
   * honest "could not check" verdict per route instead of leaving holes — a
   * route nobody answered for is exactly 没能检查, and a summary that silently
   * omits it would under-report what the user asked for.
   *
   * Note: 为何这条路必须走宿主（LlmError.code 过不了 Remote 信封）—— 见
   * .agents/notes/implemented/2026-10-16-connectivity-no-discovery-is-not-a-refusal.md
   */
  // 在飞的连通性检查：卸载时全部 abort。发现调用是真实网络请求，"0 Token"
  // 不等于"0 后果"——UI 走了还继续打端点既是浪费，也可能把渠道打出限流。
  // 信号经 Typert 的 cancellation 通道到宿主（描述符声明 signal 末参即注入，
  // 与 probeAll 同一机制），宿主把取消传进 discoverModels。
  var checkAborts = new Set<AbortController>()
  // 在飞的探测：与连通性检查同契约。探测花的是真 token，面板一关就必须停，
  // 不能只靠宿主侧的超时兜底。
  var probeAborts = new Set<AbortController>()
  function runCheck(routes, signal) {
    var health = ctx.remote && ctx.remote.deskHealth
    var cannotCheck = function () {
      return routes.map(function (route) {
        return { provider: route.provider, model: route.model, kind: 'unavailable', reason: 'hostUnavailable' }
      })
    }
    if (!health || typeof health.checkConnectivity !== 'function') return Promise.resolve(cannotCheck())
    return health.checkConnectivity({ routes: routes }, signal).then(function (result) {
      if (!result || result.ok !== true) return cannotCheck()
      return result.value ?? []
    }, cannotCheck)
  }

  /** Ask one route whether its endpoint answers and advertises this model. */
  function checkRoute(provider, model, signal) {
    return runCheck([{ provider: provider, model: model }], signal).then(function (verdicts) {
      return verdicts[0] ?? { provider: provider, model: model, kind: 'unavailable', reason: 'hostUnavailable' }
    })
  }

  // 订阅返回退订函数（DSH 的 settings scope 就是一个 store）：卸载时退掉，
  // 否则已卸载的控制器会继续被宿主的每次发布唤醒，一遍遍重算一份没人看的快照。
  var unsubscribeScope = scope.subscribe(function () {
    // mirror 的每次发布都会走到这里：保存被拒后的恢复读、连接重置、用户在
    // 别的设置页保存，都会重发整个文档。本 namespace 的值没变就什么都不做——
    // 把用户未保存的草稿冲掉，比晚一步反映宿主变化糟得多。裁定与代价见
    // .agents/notes/implemented/2026-10-15-ui-refactor-hardening.md。
    var next = seed()
    if (deepEqual(next, host)) return
    // 草稿有未保存的编辑时保留它：把用户正在改的东西整份换成宿主的值，比晚一步
    // 反映宿主变化糟得多。基线照样前进，所以 dirty 仍然如实（保存会覆盖外部值），
    // 页脚也会说出这件事（externalChange），不静默。
    var dirtyDraft = !deepEqual(draft, host)
    host = next
    // 宿主值恰好等于我们的草稿 = 这是刚才那次保存落地的回声，照常采纳。
    if (dirtyDraft && !deepEqual(next, draft)) {
      ui.externalChange = true
      publish()
      return
    }
    // The baseline and the draft must be two independent snapshots. Sharing
    // one object behind both names makes every edit mutate the baseline
    // too, and `dirty` — the whole unsaved-changes signal — then reads
    // false forever. See .agents/notes/implemented/2026-10-15-host-draft-baseline-independence.md。
    draft = clone(next)
    failed = false
    ui.externalChange = false
    publish()
  })

  /**
   * The chain the editor is editing: the default one.
   *
   * Every section of the workbench (start strategy, first hop, fallbacks,
   * switch-on, budget) edits ONE chain, and `seed()` guarantees the draft has at
   * least one (a config with no chains is normalized to one empty chain). Chain
   * management — adding, renaming, deleting, choosing the default — is what the
   * settings panel's chain list does; it edits `draft.chains` directly.
   */
  function edited(target) {
    var picked = ui.chainId === null
      ? undefined
      : target.chains.filter(function (chain) { return chain.id === ui.chainId })[0]
    return picked !== undefined ? picked : defaultChainOf(target)
  }

  /**
   * One tri-state `needs` write, for both landings (a candidate, the first hop).
   *
   * `images` is three-valued: require/forbid set an extreme, `any` removes the
   * field; a non-positive `minContextTokens` is "no bound" and is removed too.
   * An empty result is `undefined`, not `{}` — the host reads absence as
   * "unconstrained" and a shape with no keys would be a second way to say it.
   */
  function applyNeeds(current, patch) {
    var next = Object.assign({}, current ?? {})
    if (patch.imagesMode !== undefined) {
      if (patch.imagesMode === 'require') next.images = true
      else if (patch.imagesMode === 'forbid') next.images = false
      else delete next.images
    }
    if (patch.minContextTokens !== undefined) {
      if (patch.minContextTokens > 0) next.minContextTokens = patch.minContextTokens
      else delete next.minContextTokens
    }
    return Object.keys(next).length > 0 ? next : undefined
  }

  /** 链名的上限：够写清任务，又不至于把链列表撑爆。 */
  var CHAIN_NAME_MAX = 40

  /** 新链的 id：chain-2、chain-3… 取第一个没被占用的（id 是身份，不能撞）。 */
  function nextChainId(chains) {
    for (var index = 2; index < 1000; index += 1) {
      var candidate = 'chain-' + index
      if (!chains.some(function (chain) { return chain.id === candidate })) return candidate
    }
    return 'chain-' + String(Date.now())
  }

  /** 新角色的 id：role-2、role-3… 同样取第一个没被占用的（工具与账本按 id 引用）。 */
  function nextRosterId(roster) {
    for (var index = 2; index < 1000; index += 1) {
      var candidate = 'role-' + index
      if (!roster.some(function (entry) { return entry.id === candidate })) return candidate
    }
    return 'role-' + String(Date.now())
  }

  var controller = {
    store: store,
    /** The dialog's workbench mounted. */
    retainSurface: function () { surfaceCount += 1 },
    /** That workbench unmounted. */
    releaseSurface: function () { if (surfaceCount > 0) surfaceCount -= 1 },
    /** Whether our workbench is mounted at all — the shortcut command's gate. */
    surfaceActive: function () { return surfaceCount > 0 },
    setEnabled: function (value) { draft.enabled = value; publish() },
    /** 选一条链来编辑（五个分区改的就是它）。 */
    selectChain: function (id) { ui.chainId = id; publish() },
    /** 新增一条空链，并立刻切到它上面编辑。 */
    addChain: function () {
      var id = nextChainId(draft.chains)
      draft.chains.push(Object.assign({ id: id, name: '' }, defaultChainValue()))
      ui.chainId = id
      publish()
    },
    /**
     * 复制一条链：候选 / switchOn / 预算 / 粘滞 / 策略整份带走，只换 id 与显示名。
     *
     * 用户要的是"同一条链只换一条候选"时不重配。副本是**显式动作**（对某条链点「复制」），
     * 不是"添加链"的默认行为——新链默认仍是空链，否则"两条完全一样"会成为默认状态。
     * 名字在这里落成当前语言的一份快照：它是显示名、可改，不值得为它建一套跨语言引用。
     */
    copyChain: function (id) {
      var source = draft.chains.filter(function (entry) { return entry.id === id })[0]
      if (source === undefined) return
      var copy = clone(source)
      copy.id = nextChainId(draft.chains)
      copy.name = fill(t('chainCopyName'), { name: source.name !== '' ? source.name : t('chainDefaultName') }).slice(0, CHAIN_NAME_MAX)
      draft.chains.push(copy)
      ui.chainId = copy.id
      publish()
    },
    renameChain: function (id, value) {
      var chain = draft.chains.filter(function (entry) { return entry.id === id })[0]
      if (chain === undefined) return
      // 名字只是显示；id 才是身份，所以改名不会动任何会话绑定。
      chain.name = String(value === undefined || value === null ? '' : value).slice(0, CHAIN_NAME_MAX)
      publish()
    },
    setDefaultChain: function (id) {
      if (!draft.chains.some(function (entry) { return entry.id === id })) return
      draft.defaultChainId = id
      publish()
    },
    removeChain: function (id) {
      // 最后一条链不能删：没有链的配置等于"插件完全不接管"，那不是用户点删除时想要的。
      if (draft.chains.length <= 1) return
      draft.chains = draft.chains.filter(function (entry) { return entry.id !== id })
      if (draft.defaultChainId === id) draft.defaultChainId = draft.chains[0].id
      if (ui.chainId === id) ui.chainId = null
      publish()
    },
    // ---- delegation roster (P2) ----
    //
    // 三个动作覆盖整页：一个标量（含嵌套路径）、一条角色、以及新增/删除。写的是
    // 同一份 draft，保存仍走 save() 的那一次 mutate —— 页签没有自己的保存链路。
    /** Set one scalar in the handoff section, by path (`['limits','maxReviewsPerUserMessage']`). */
    setHandoffField: function (path, value) {
      var target = draft.handoff
      for (var index = 0; index < path.length - 1; index += 1) {
        if (target[path[index]] === undefined || target[path[index]] === null) return
        target = target[path[index]]
      }
      target[path[path.length - 1]] = value
      publish()
    },
    /** Select one role in the master list (view state, not config). */
    selectRoster: function (id) {
      ui.rosterId = id
      publish()
    },
    /** Add an empty role and select it: the empty state's one action. */
    addRoster: function () {
      var id = nextRosterId(draft.handoff.roster)
      draft.handoff.roster.push({
        id: id,
        name: '',
        role: 'work',
        purpose: '',
        instructions: '',
        preset: '',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxTokens: 0,
        failover: HANDOFF_FAILOVER_INHERIT,
        attach: HANDOFF_ATTACH_ITEMS.slice(),
        maxRunsPerUserMessage: DEFAULT_HANDOFF_MAX_RUNS_PER_USER_MESSAGE,
      })
      ui.rosterId = id
      publish()
    },
    /** Edit one field of one role. `id` may itself be changing, so rows are addressed by identity. */
    updateRoster: function (id, field, value) {
      var entry = draft.handoff.roster.filter(function (candidate) { return candidate.id === id })[0]
      if (entry === undefined) return
      entry[field] = value
      // 改 id 时选中项跟着走：选中是视图状态，不是"第 N 行"，否则改完 id 列表跳走。
      if (field === 'id' && ui.rosterId === id) ui.rosterId = value
      publish()
    },
    removeRoster: function (id) {
      draft.handoff.roster = draft.handoff.roster.filter(function (entry) { return entry.id !== id })
      if (ui.rosterId === id) ui.rosterId = null
      // 兜底角色指向一个已删除的 id 会变成永远不会发生的自动派：一起清掉，而不是留给
      // 结构校验去拒绝（那条规则留给手写配置）。
      if (draft.handoff.onUnreceiptedStop.delegateTo === id) draft.handoff.onUnreceiptedStop.delegateTo = ''
      publish()
    },
    setActive: function (id) {
      ui.activeId = id
      // 打开名册页时默认选中第一个角色：主从布局的编辑器不能一进来就是空面板，
      // 而"用户还没选"与"没有角色"是两件事。选中是视图状态，不改 draft。
      if (id === '__roster__' && ui.rosterId === null && draft.handoff.roster.length > 0) {
        ui.rosterId = draft.handoff.roster[0].id
      }
      // 打开健康工作台时重取一次被动快照。它原本只在控制器创建时读一次，
      // 故障转移发生后工作台还显示着旧延迟/旧可用率——监控视图在事故进行中
      // 给人看旧数字，比没有这个数字更糟。重取是同一套 20 会话合并，代价是
      // 几次本地投影读。定时探测的报告同理：它是 Host 内存里最近一次运行的
      // 结果，打开视图时读，而不是假装有实时推送。
      if (id === '__health__') { loadPassive(); controller.loadProbeReport() }
      publish()
    },
    discard: function () {
      draft = seed()
      ui.chainId = null
      ui.rosterId = null
      ui.saveError = null
      ui.externalChange = false
      failed = false
      publish()
    },
    save: function () {
      if (saving || !scope.getSnapshot().writable) return
      if (validate(draft).length) { publish(); return }
      saving = true
      failed = false
      ui.saveError = null
      publish()
      // mutate 拒绝（wire 抛错、恢复读失败）时必须自己收尾：saving 卡在 true
      // 会让保存按钮永久转圈，且用户看不到任何失败原因。
      scope.mutate([
        { op: 'set', path: ['enabled'], value: draft.enabled },
        { op: 'set', path: ['chains'], value: draft.chains },
        { op: 'set', path: ['defaultChainId'], value: draft.defaultChainId },
        // 旧形状的单链键：迁移之后就不能留第二份「当前链」，否则下一次加载看到两个
        // 形状并存，谁赢取决于一条迁移规则，而用户以为自己改的是另一份。
        { op: 'unset', path: ['chain'] },
        // 策略版本标记：没有它，host 会把这次保存的 switchOn 也当成旧默认值再改一遍，
        // 用户在这里取消的勾选就永远不算数。
        { op: 'set', path: ['policyVersion'], value: POLICY_VERSION },
        { op: 'set', path: ['health'], value: draft.health },
        // 委派名册：整段一次写。它不是第二个保存链路——同一次 mutate、同一个 revision。
        { op: 'set', path: ['handoff'], value: draft.handoff },
      ], scope.getSnapshot().revision).then(function (accepted) {
        saving = false
        failed = !accepted
        if (accepted) ui.externalChange = false
        publish()
      }, function (e) {
        saving = false
        failed = true
        // 拒绝原因必须上屏：没有它，页脚只会说「保存失败，请重试」，用户对着同一个
        // 越界值反复重试而不知道改哪儿。
        ui.saveError = describeError(e)
        publish()
      })
    },
    /** Add fallback candidates to the one chain. */
    addCandidates: function (entries) {
      entries.forEach(function (entry) {
        // 目录选择只带 route（provider/model）：重试次数先给默认值，之后在链上逐条改。
        edited(draft).candidates.push(Object.assign({ maxRetries: DEFAULT_MAX_RETRIES }, entry))
      })
      ui.modal = null
      publish()
    },
    removeCandidate: function (index) {
      edited(draft).candidates.splice(index, 1)
      publish()
    },
    reorderCandidates: function (fromIndex, toIndex) {
      var list = edited(draft).candidates
      if (fromIndex >= list.length || toIndex >= list.length || fromIndex === toIndex) return
      var item = list.splice(fromIndex, 1)[0]
      list.splice(toIndex, 0, item)
      publish()
    },
    moveCandidate: function (index, direction) {
      // 一次移动就是一次换位：与拖拽走同一条重排路径。曾有两套实现（splice 搬家
      // 与相邻交换），边界守卫各写各的，改一边忘了另一边就静默出错。
      controller.reorderCandidates(index, index + direction)
    },
    setMaxRetries: function (index, value) {
      var candidate = edited(draft).candidates[index]
      var parsed = Number(value)
      candidate.maxRetries = Number.isFinite(parsed) ? Math.min(MAX_RETRIES, Math.max(0, Math.round(parsed))) : DEFAULT_MAX_RETRIES
      publish()
    },
    /** Patch one candidate's `needs`; an empty patch clears the field. */
    setNeeds: function (index, patch) {
      var candidate = edited(draft).candidates[index]
      candidate.needs = applyNeeds(candidate.needs, patch)
      publish()
    },
    /**
     * The first hop's condition — the chain's `primaryNeeds`.
     *
     * Same tri-state as a candidate's `needs`, different landing spot: the first
     * hop is the model DSH selected, so it has no candidate row to hang a
     * condition on.
     */
    setPrimaryNeeds: function (patch) {
      var chain = edited(draft)
      chain.primaryNeeds = applyNeeds(chain.primaryNeeds, patch)
      publish()
    },
    setStickyTurns: function (value) {
      var parsed = Number(value)
      edited(draft).stickyTurns = Number.isFinite(parsed) ? Math.min(99, Math.max(0, Math.round(parsed))) : 0
      publish()
    },
    /** 截断时是否自动续跑（`max-tokens` 不是错误，走不到恢复扩展点）。 */
    setMaxTokensContinue: function (value) {
      edited(draft).maxTokens.autoContinue = Boolean(value)
      publish()
    },
    /** 同一个候选上一轮最多自动续几次；用完换下一条候选。 */
    setMaxTokenContinues: function (value) {
      var parsed = Number(value)
      edited(draft).maxTokens.continues = Number.isFinite(parsed)
        ? Math.min(MAX_TOKEN_CONTINUES, Math.max(0, Math.round(parsed)))
        : DEFAULT_MAX_TOKEN_CONTINUES
      publish()
    },
    setFirstHopMaxRetries: function (value) {
      var parsed = Number(value)
      edited(draft).firstHopMaxRetries = Number.isFinite(parsed) ? Math.min(MAX_RETRIES, Math.max(0, Math.round(parsed))) : DEFAULT_FIRST_HOP_MAX_RETRIES
      publish()
    },
    toggleSwitchOn: function (key) {
      edited(draft).switchOn[key] = !edited(draft).switchOn[key]
      publish()
    },
    /**
     * 白名单：勾上 = 这个失败码不重试、直接切下一条候选。
     *
     * 与 `switchOn` 是同一套键，但回答的是另一个问题（要不要再打一次），所以是
     * 两份独立状态：取消勾选「失败切换」时，白名单里的条目留着——再勾回来时
     * 用户的选择还在。
     */
    toggleImmediateSwitch: function (key) {
      var chain = edited(draft)
      var at = chain.immediateSwitch.indexOf(key)
      if (at >= 0) chain.immediateSwitch.splice(at, 1)
      else chain.immediateSwitch.push(key)
      publish()
    },
    setStrategy: function (value) {
      // 策略只管起点，所以名单本身不动——只改"从哪条开始"。
      edited(draft).strategy = value
      publish()
    },
    setWeight: function (index, value) {
      var parsed = Number(value)
      var clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0
      if (edited(draft).candidates[index] !== undefined) edited(draft).candidates[index].weight = clamped
      publish()
    },
    /**
     * The workbench's rows name routes from the catalog, so the page asks for it
     * on mount (`onLoadCatalog`); the dialog would otherwise be the only entry.
     */
    loadCatalog: function () { ensureCatalog() },
    openModal: function (modal) {
      ui.modal = modal
      ui.riskAck = false
      // 打开添加候选时再确认一次：目录可能在上一次读失败后被重建（宿主重启），
      // 而这一层是幂等的——读到过就直接返回。
      if (modal.kind === 'add-candidate') ensureCatalog()
      publish()
    },
    closeModal: function () { ui.modal = null; ui.riskAck = false; publish() },
    setRiskAck: function (value) { ui.riskAck = value; publish() },
    /** Open the drawer and load the recent failover ledger across sessions. */
    openDrawer: function () {
      ui.drawerOpen = true
      ui.drawerLoading = true
      ui.drawerError = false
      ui.drawerRows = []
      // 与 `loadPassive` 同一条守卫：这个组合里没有 `ctx.remote.session` 时直接说读不到，
      // 而不是让 `readSessionBlocks(undefined)` 抛进 `.catch`（那条路径报的是"没有记录"
      // 之外的另一句话，用户分不出是"没转移"还是"读不了"）。
      var sessionFace = ctx.remote && ctx.remote.session
      if (!sessionFace) {
        ui.drawerLoading = false
        ui.drawerError = true
        publish()
        return
      }
      publish()
      // 与健康历史走同一次读取（readSessionBlocks）：那是同一批会话、同一套
      // 失败口径。此前这里是第二份实现，还把逐会话失败吞成空记录——"读不到"
      // 于是渲染成"没有转移"，正是健康历史那轮修掉的同一句话。
      readSessionBlocks(sessionFace).then(function (reads) {
        ui.drawerRows = foldFailoverRows(reads, Date.now())
        ui.drawerLoading = false
        publish()
      }).catch(function () {
        // 列表本身失败 = 一个会话都没读到，抽屉里只能报错，不能报"没有记录"。
        ui.drawerError = true
        ui.drawerLoading = false
        publish()
      })
    },
    closeDrawer: function () { ui.drawerOpen = false; publish() },
    /** Run a connectivity check on every configured route (the chain's candidates). */
    checkAll: function () {
      if (ui.checking) return
      ui.checking = true
      ui.checkSummary = null
      publish()
      var started = Date.now()
      var keys = configuredRouteList(draft)
      // keys 是 `provider/model` 字符串（拼拆规则都在 ../routes.ts）；拆回两半
      // 交给检查器。
      var routes = keys.map(routeParts)
      var abort = new AbortController()
      checkAborts.add(abort)
      // 一次调用问完整轮：分类在宿主侧，一轮检查因此也只是一次往返。
      runCheck(routes, abort.signal).then(function (verdicts) {
        checkAborts.delete(abort)
        // 先拷贝后写入——store 的 set 会 dev-freeze 它收到的对象，往原对象
        // 上赋值在 dev 构建里会静默失败。
        var next = Object.assign({}, ui.discover)
        verdicts.forEach(function (verdict) { next[routeKeyOf(verdict.provider, verdict.model)] = verdict })
        ui.discover = next
        // 汇总按"这一轮被问到的每一条"算：宿主对每条请求都给一个判定，两条
        // 到不了宿主的路径也按条补上"没能检查"。少算一条就是少报一次故障。
        ui.checkSummary = summarizeChecks(routes.map(function (route) {
          return next[routeKeyOf(route.provider, route.model)]
            ?? { provider: route.provider, model: route.model, kind: 'unavailable', reason: 'hostUnavailable' }
        }), t)
        // 连通性检查跑完顺带重取被动快照：定时轮次开着的时候，健康工作台要跟着
        // 真实发生的事走，而不是停在页面挂载那一刻。
        loadPassive()
        controller.holdBusy(started, function () {
          ui.checking = false
          publish()
        })
      }).catch(function () {
        checkAborts.delete(abort)
        controller.holdBusy(started, function () {
          ui.checking = false
          publish()
        })
      })
    },
    /** Run a connectivity check on a single route (0 Token discovery check). */
    checkRouteSingle: function (provider, model) {
      var key = routeKeyOf(provider, model)
      if (ui.checkingRoutes && ui.checkingRoutes[key]) return
      ui.checkingRoutes = Object.assign({}, ui.checkingRoutes)
      ui.checkingRoutes[key] = true
      publish()
      var started = Date.now()
      var abort = new AbortController()
      checkAborts.add(abort)
      return checkRoute(provider, model, abort.signal).then(function (verdict) {
        checkAborts.delete(abort)
        ui.discover = Object.assign({}, ui.discover)
        ui.discover[key] = verdict
        controller.holdBusy(started, function () {
          ui.checkingRoutes = Object.assign({}, ui.checkingRoutes)
          delete ui.checkingRoutes[key]
          publish()
        })
      }).catch(function () {
        checkAborts.delete(abort)
        controller.holdBusy(started, function () {
          ui.checkingRoutes = Object.assign({}, ui.checkingRoutes)
          delete ui.checkingRoutes[key]
          publish()
        })
      })
    },
    updateHealth: function (patch) {
      draft.health = Object.assign({}, draft.health, patch)
      publish()
    },
    /**
     * Hold the busy state on screen long enough to be perceived, then `settle`.
     *
     * A route the Host cannot even assemble fails before any I/O —
     * `NO_ADAPTER` when the provider is not registered here,
     * `MISSING_CREDENTIAL` when it has no key — so the promise resolves in a
     * microtask. React then batches the "busy" and "done" publishes into one
     * render and the user sees nothing at all: measured on such a route, the two
     * DOM commits land 2ms and 7ms after the click, i.e. the spinner exists for
     * five milliseconds and is never painted. A click that looks ignored reads
     * as a frozen app, which is worse than a slow one, so the busy state is held
     * for a floor. The real duration still wins whenever it is longer — this
     * only ever adds visible time to a failure that was instantaneous.
     *
     * @param started - `Date.now()` taken when the busy state was published.
     * @param settle - clears the busy state and publishes the result.
     */
    holdBusy: function (started, settle) {
      var left = MIN_BUSY_MS - (Date.now() - started)
      if (left <= 0) { settle(); return }
      // 记在册上：卸载时一起清掉。否则已卸载的控制器会在几毫秒后醒来 publish 一次，
      // 而 `publish()` 又会 re-arm 巡检定时器（`disposed` 守卫是最后一道，不是唯一一道）。
      var timer = setTimeout(function () {
        busyTimers.delete(timer)
        settle()
      }, left)
      busyTimers.add(timer)
    },
    /**
     * Read the Host's last probe report — what the scheduled run measured. The
     * browser holds no subscription, so this is read when the health view opens
     * and after every manual run, the same snapshot pattern the passive fold
     * uses.
     */
    loadProbeReport: function () {
      var health = ctx.remote && ctx.remote.deskHealth
      if (!health || typeof health.probeReport !== 'function') return
      health.probeReport().then(function (result) {
        if (!result || result.ok !== true || !result.value) return
        // 合并而不是整份替换：宿主只保留"最后一次运行"，而一次单条探测只代表
        // 它自己那一条。整份替换会让打开健康页的一次读取抹掉这个浏览器里其它
        // 路由刚测出来的结论（显示回"未探测"）。
        // Note: 为何合并、为何不改宿主的"最后一次"契约 —— 见
        // .agents/notes/implemented/2026-10-23-honest-surfaces.md
        var next = Object.assign({}, ui.probe)
        ;(result.value.routes ?? []).forEach(function (entry) {
          next[routeKeyOf(entry.provider, entry.model)] = entry
        })
        ui.probe = next
        publish()
      }).catch(function () {})
    },
    /** Probe one route end to end (1 token, cut at the first content byte). */
    probeRouteSingle: function (provider, model) {
      var key = routeKeyOf(provider, model)
      if (ui.probingRoutes && ui.probingRoutes[key]) return
      var health = ctx.remote && ctx.remote.deskHealth
      if (!health || typeof health.probeAll !== 'function') return
      ui.probingRoutes = Object.assign({}, ui.probingRoutes)
      ui.probingRoutes[key] = true
      publish()
      var started = Date.now()
      var abort = new AbortController()
      probeAborts.add(abort)
      health.probeAll({ routes: [{ provider: provider, model: model }] }, abort.signal).then(function (result) {
        probeAborts.delete(abort)
        if (result && result.ok === true) {
          var next = Object.assign({}, ui.probe)
          ;(result.value.routes ?? []).forEach(function (entry) {
            next[routeKeyOf(entry.provider, entry.model)] = entry
          })
          ui.probe = next
        }
        controller.holdBusy(started, function () {
          ui.probingRoutes = Object.assign({}, ui.probingRoutes)
          delete ui.probingRoutes[key]
          publish()
        })
      }).catch(function () {
        probeAborts.delete(abort)
        controller.holdBusy(started, function () {
          ui.probingRoutes = Object.assign({}, ui.probingRoutes)
          delete ui.probingRoutes[key]
          publish()
        })
      })
    },
    /** Probe every configured route (the chain's candidates). */
    probeAll: function () {
      if (ui.probing) return
      var health = ctx.remote && ctx.remote.deskHealth
      if (!health || typeof health.probeAll !== 'function') return
      var routes = configuredRouteList(draft).map(routeParts)
      ui.probing = true
      ui.probeSummary = null
      publish()
      var started = Date.now()
      var abort = new AbortController()
      probeAborts.add(abort)
      health.probeAll({ routes: routes }, abort.signal).then(function (result) {
        probeAborts.delete(abort)
        if (result && result.ok === true) {
          var next = Object.assign({}, ui.probe)
          ;(result.value.routes ?? []).forEach(function (entry) {
            next[routeKeyOf(entry.provider, entry.model)] = entry
          })
          ui.probe = next
          ui.probeSummary = summarizeProbes(result.value.routes ?? [], t)
        }
        controller.loadProbeReport()
        controller.holdBusy(started, function () {
          ui.probing = false
          publish()
        })
      }).catch(function () {
        probeAborts.delete(abort)
        controller.holdBusy(started, function () {
          ui.probing = false
          publish()
        })
      })
    },
    openHealthModal: function () {
      ui.modal = { kind: 'health' }
      publish()
    },
    /**
     * Open the update check and ask the Host whether a newer version is out.
     *
     * The Host does the two requests (the registry for the newest published
     * version, the release for that version's notes): the browser half opens no
     * connection to a third party. A refused call is shown as such — the dialog
     * never falls back to "you are up to date" for a check that did not run.
     */
    openUpdateCheck: function () {
      ui.updateOpen = true
      ui.updateChecking = true
      ui.updateResult = null
      ui.updateError = null
      publish()
      var host = ctx.remote && ctx.remote.deskHealth
      if (host === undefined || typeof host.checkUpdate !== 'function') {
        ui.updateError = t('updateHostUnavailable')
        ui.updateChecking = false
        publish()
        return
      }
      host.checkUpdate().then(function (result) {
        // Remote 调用回来的是 `{ ok, value }` 信封，不是裸值。
        if (!result || result.ok !== true) {
          throw new Error(result?.error?.message ?? t('updateHostUnavailable'))
        }
        ui.updateResult = result.value
        ui.updateChecking = false
        publish()
      }).catch(function (error) {
        ui.updateError = describeError(error)
        ui.updateChecking = false
        publish()
      })
    },
    /** Close the update dialog; the check itself is a one-shot read. */
    closeUpdateCheck: function () {
      ui.updateOpen = false
      publish()
    },
    /** Dismiss the notes and remember this release, so they do not nag on reload. */
    closeNotes: function () {
      rememberVersion()
      ui.notesOpen = false
      publish()
    },
    /** 供插件半包卸载时调用：停掉定时轮询、取消在飞的检查，别留下孤儿 interval 与孤儿请求。 */
    dispose: function () {
      if (disposed) return
      disposed = true
      if (typeof unsubscribeScope === 'function') unsubscribeScope()
      if (discoverTimer !== null) { clearInterval(discoverTimer); discoverTimer = null }
      armedSeconds = -1
      checkAborts.forEach(function (abort) { abort.abort() })
      checkAborts.clear()
      probeAborts.forEach(function (abort) { abort.abort() })
      probeAborts.clear()
      busyTimers.forEach(function (timer) { clearTimeout(timer) })
      busyTimers.clear()
    },
  }
  return controller
}

/**
 * What a connectivity run found: reachable, advertised-but-not-this-model,
 * refused, and could-not-check are four different answers and are counted
 * separately — the last one says nothing about the channel.
 */
function summarizeChecks(verdicts, t) {
  return summarize(verdicts, function (verdict) {
    if (verdict.kind === 'reachable') return 'ok'
    if (verdict.kind === 'notAdvertised') return 'partial'
    if (verdict.kind === 'unreachable') return 'bad'
    return 'unknown'
  }, [
    { key: 'ok', label: t('checkSummaryOk') },
    { key: 'partial', label: t('checkSummaryPartial') },
    { key: 'bad', label: t('checkSummaryBad') },
    { key: 'unknown', label: t('checkSummaryUnknown') },
  ])
}

/** What a probe run found: passed, refused, and could-not-run. */
function summarizeProbes(routes, t) {
  return summarize(routes, function (entry) {
    if (entry.kind === 'reachable') return 'ok'
    if (entry.kind === 'unreachable') return 'bad'
    return 'unknown'
  }, [
    { key: 'ok', label: t('probeSummaryOk') },
    { key: 'bad', label: t('probeSummaryBad') },
    { key: 'unknown', label: t('probeSummaryUnknown') },
  ])
}

