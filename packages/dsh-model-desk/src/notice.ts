/**
 * The Chinese failover notice.
 *
 * Appended to the session surface as a `user/message` with
 * `source.form: 'notice'`, the same shape DSH's own model-switch notice uses
 * (`model-selection.ts`). The client renders any `notice` form as a collapsed
 * row regardless of the producer kind, and an unknown kind falls back to a
 * visible label — both verified in the Phase 1 spike (see
 * docs/design/dsh-capability-boundary.md 7.7).
 *
 * One failover therefore shows two notices: DSH's English "model changed" row
 * (unavoidable, factual) and this one (the reason). That trade-off is a
 * recorded product decision, not an oversight.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { BreakerScope } from './config.ts'
import type { SwitchOnCode } from './defaults.ts'
import { routeKeyOf, routeLabel } from './routes.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'model-desk': { readonly kind: 'model-desk'; readonly form: 'notice'; readonly summary: string }
  }
}

/**
 * Chinese labels for the codes the switch-on table names. Keyed by that
 * table's own code union, so a code added there without a label is a compile
 * error — the label map cannot drift from the list of codes that switch.
 * `codeLabel` still answers for any code (a breaker rule may name one the
 * chain never switches on), falling back to the raw code.
 */
const CODE_LABELS: Readonly<Record<SwitchOnCode, string>> = {
  RATE_LIMIT: '限流',
  SERVER: '服务端错误',
  TIMEOUT: '超时',
  TRANSPORT: '网络传输中断',
  EMPTY_RESPONSE: '空回复',
  INVALID_REQUEST: '请求被拒绝',
  AUTH: '凭证或权限被拒',
  QUOTA: '额度用尽',
}

/**
 * 不在 `switchOn` 那 8 个具名码里的失败码、以及不是失败码的原因，在通知里怎么说。
 *
 * `MAX_TOKENS` 是 `FinishReason`，不是失败码：输出被截断不会经过
 * `agent/request-error`。它出现在截断续跑/换候选的通知里。
 *
 * `ACCOUNT_QUOTA` 是真码（`llm/src/error.ts` 的 `ACCOUNT_QUOTA_EXCEEDED_CODE`），
 * 由 deepseek-account 渠道把 `QUOTA` 改写而来。它归 `quota` 键（见
 * `defaults.ts` 的别名表），但键表只有 8 行、一码一键，所以中文标签放这里——
 * 否则用户在通知里读到的是英文码。
 */
const SYNTHETIC_LABELS: Readonly<Record<string, string>> = {
  MAX_TOKENS: '输出被截断',
  ACCOUNT_QUOTA: '账户额度用尽',
}

export function codeLabel(code: string): string {
  if (Object.hasOwn(CODE_LABELS, code)) return CODE_LABELS[code as SwitchOnCode]
  return Object.hasOwn(SYNTHETIC_LABELS, code) ? SYNTHETIC_LABELS[code]! : code
}

function notice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'model-desk', form: 'notice', summary: boundContextSummary(text) },
  })
}

/**
 * The chain moved to the next candidate after a failure.
 *
 * The wording says "降级 N/M", not "候选 N/M", and never "主模型": there is one
 * global chain and its first hop is whatever the user selected, so a failing
 * hop may itself be a fallback. `position` is the user-visible fallback number
 * (1-based, the order they configured), not the rotated index. `position === 0`
 * means the chain moved BACK to the user's own model (possible under the
 * weight/round-robin start strategies), which is not a fallback at all — saying
 * "降级 0/N" there would be a number that cannot exist.
 */
export function failoverNotice(
  from: { provider: string; model: string },
  to: { provider: string; model: string },
  position: number,
  total: number,
  code: string | undefined,
): UserMessage {
  const reason = code === undefined ? '连续失败' : `失败（${codeLabel(code)}）`
  const target = routeLabel(to.provider, to.model, from.provider)
  const move = position <= 0
    ? `已切回你选择的模型 ${target}`
    : `已切换至 ${target}（降级 ${position}/${total}）`
  return notice(
    `[路由切换] ${routeLabel(from.provider, from.model, to.provider)} ${reason}，${move}`,
  )
}

/**
 * 输出被截断后的自动续跑。
 *
 * 这条消息是**模型也读得到的用户消息**（steer 进 inbox，下一步被 claim），所以
 * 文案本身就是给模型的指令：接着说、别重述。前半句是给用户看的解释。
 */
export function truncationContinueNotice(remaining?: number): UserMessage {
  const budget = remaining === undefined ? '' : `（本候选还可自动续 ${remaining} 次）`
  return notice(
    `[路由续跑] 上一条回复达到输出 token 上限${budget}。`
    + '请从中断处直接接着写完，不要重复已经输出的内容。',
  )
}

/**
 * 续跑次数用尽、且输出仍在被截断：换下一条候选接着写。
 *
 * 与普通失败切换的差别只在原因与"接着写"这句：换候选对模型是新上下文，不点明
 * 它会从头再答一遍。
 */
export function truncationSwitchNotice(
  from: { provider: string; model: string },
  to: { provider: string; model: string },
  position: number,
  total: number,
  continues: number,
): UserMessage {
  const move = position <= 0
    ? `已切回你选择的模型 ${routeLabel(to.provider, to.model, from.provider)}`
    : `已切换至 ${routeLabel(to.provider, to.model, from.provider)}（降级 ${position}/${total}）`
  const why = continues <= 0
    ? `${routeLabel(from.provider, from.model, to.provider)} 的输出被截断（未配置自动续跑）`
    : `输出连续被截断（${routeLabel(from.provider, from.model, to.provider)} 上已自动续 ${continues} 次）`
  return notice(
    `[路由切换] ${why}，${move}，请从中断处接着写完，不要重复已经输出的内容`,
  )
}

/** A candidate was skipped before any call: it cannot serve this request. */
export function skipNotice(candidate: { provider: string; model: string }): UserMessage {
  return notice(
    `[路由切换] 候选 ${routeKeyOf(candidate.provider, candidate.model)} 不支持当前请求参数，已跳过`,
  )
}

/**
 * A candidate the router could not even address: the provider has no adapter
 * registered here, or the model is not in its catalog. The wording points at
 * the Models page rather than at this chain — nothing in the chain is wrong,
 * and the previous catch-all notice sent users to edit the wrong thing.
 */
export function routeMissingNotice(
  candidate: { provider: string; model: string },
  code: string,
): UserMessage {
  return notice(
    `[路由切换] 候选 ${routeKeyOf(candidate.provider, candidate.model)} 无法路由（${code}）：该 provider 未注册或模型不在目录里，请到「模型」页确认这条渠道；已跳过`,
  )
}

/**
 * A candidate whose adapter broke its own contract: it returned exact-model
 * metadata that fails the runtime's shape check. Not rethrown — one broken
 * adapter must not take the whole chain down, which is the opposite of what
 * this plugin is for — but it is loud: `ctx.logger.error` on the Host and a
 * notice that says outright this is an adapter defect, not a chain problem.
 */
export function adapterDefectNotice(
  candidate: { provider: string; model: string },
  code: string,
): UserMessage {
  return notice(
    `[路由切换] 候选 ${routeKeyOf(candidate.provider, candidate.model)} 的适配器返回了无效的模型元数据（${code}）：这是适配器缺陷，不是这条链的问题，请向该 provider 的适配器反馈；已跳过`,
  )
}

/**
 * A candidate was skipped because its `needs` condition is not met. This is
 * not a failure — the candidate is servable, just not for this request's
 * shape — but the chain visibly jumped over it, so the reason is recorded.
 */
export function conditionSkipNotice(
  candidate: { provider: string; model: string },
  reason: string,
): UserMessage {
  return notice(
    `[路由切换] 候选 ${routeKeyOf(candidate.provider, candidate.model)} 的使用条件不满足（${reason}），已跳过`,
  )
}

/**
 * The session is bound to a chain the config no longer defines.
 *
 * It is a notice and not a silent reroute: the user picked that chain in this
 * session, and falling back to the default one while still showing the old
 * choice would be the kind of quiet divergence this project refuses. The
 * session keeps its binding — recreating a chain with that id restores it.
 */
export function bindingMissingNotice(missingChainId: string, fallbackLabel: string): UserMessage {
  return notice(
    `[路由切换] 本会话绑定的链「${missingChainId}」已不存在，本次按默认链「${fallbackLabel}」路由；在会话里的路由设置中重新选择即可恢复`,
  )
}

/**
 * A candidate is sitting out a cooldown. The deadline is stated because
 * "skipped" alone reads like the channel is broken, and the whole point of a
 * cooldown is that it comes back on its own. A channel-scope block says so,
 * because the user configured it to take the whole provider out and would
 * otherwise wonder why the sibling models vanished too.
 *
 * Two wording rules, both learned from what this line used to say:
 *
 * - The cooldown does NOT retry anything. `CircuitBreaker` only answers "when
 *   does it lift" (`breaker.ts`); the next attempt happens when the next
 *   request arrives. "约 N 秒后自动重试" was simply false.
 * - The message is durable, so a relative delay freezes into the history and
 *   reads wrong tomorrow. A clock time stays true.
 */
export function breakerNotice(
  candidate: { provider: string; model: string },
  block: { until: number; scope: BreakerScope },
): UserMessage {
  const subject = block.scope === 'channel'
    ? `渠道 ${candidate.provider} 已整体自动禁用（该渠道下所有模型）`
    : `候选 ${routeKeyOf(candidate.provider, candidate.model)} 已被自动禁用`
  return notice(`${subject}，冷却至 ${clockOf(block.until)}，本次跳过；冷却到期不会自己重试，下一条请求才会再试它`)
}

/** `HH:MM` in the host's local time, for a message that outlives this second. */
function clockOf(time: number): string {
  const at = new Date(time)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

// ---- handoff (delegation) ----
//
// 交接侧的 notice 全部是"插件替用户说一句"，不是判断：它们陈述已经发生的事实
// （账本没落盘、已经接力到哪个会话、还有几项没做完），不评价任务做没做完。

/**
 * The review ledger is memory-only.
 *
 * Said once, when the first review lands: from then on a restart loses the
 * verdicts, and a `finish{done}` that cited one will be refused. Saying it at
 * enable time instead would warn about a risk the user may never take.
 */
export function handoffLedgerMemoryNotice(): UserMessage {
  return notice(
    '[委派] 复核账本只存在进程内存里（这个组合没有 storageDomain）：重启后已通过的复核会丢失，'
    + '届时 finish{done} 会被要求重新复核。',
  )
}

/**
 * The model's own finish report, said once so the user does not have to open the
 * collapsed tool-result row to find out what was done.
 *
 * Only written when the model actually passed `report`; the outcome word is
 * translated here so the notice does not print the raw action value.
 */
export function handoffReceiptNotice(outcome: string, report: string): UserMessage {
  const label = outcome === 'done' ? '已完成' : outcome === 'needs_user' ? '需要你决定' : outcome === 'abandoned' ? '已放弃' : outcome
  return notice(`[委派] 收工回执（${label}）：${report}`)
}

/** A new session was opened and the task was carried over. */
export function handoffRelayNotice(newSessionId: string, outcome: string): UserMessage {
  return notice(
    `[委派] 已按接力配置把任务交接到新会话 ${newSessionId}（上一会话收工：${outcome}）。本会话不再自动继续。`,
  )
}

/**
 * The model stopped without a receipt.
 *
 * This is the plugin's one proactive line, and it only says what it can count:
 * how many todos are still open, and what the model can do about it. It never
 * claims the work is unfinished — that judgment is the model's.
 */
export function handoffUnreceiptedNotice(pendingTodos: number, delegateTo: string): UserMessage {
  const action = delegateTo === ''
    ? '可以继续干、调用 handoff finish 交回执，或调用 handoff delegate 派人'
    : `可以继续干、调用 handoff finish 交回执，或已按配置自动派「${delegateTo}」兜底`
  return notice(`[委派] 本回合没有收工回执，还有 ${pendingTodos} 项待办未完成。${action}。`)
}

/** The nudge the model receives inside `agent/turn-stopping` (steer, once per turn). */
export function handoffNudgeNotice(pendingTodos: number): UserMessage {
  return notice(
    `[委派] 还有 ${pendingTodos} 项待办处于未完成/进行中。要么继续做完，`
    + '要么调用 handoff finish（done / needs_user / abandoned）交回执，要么 handoff delegate 派人。',
  )
}
