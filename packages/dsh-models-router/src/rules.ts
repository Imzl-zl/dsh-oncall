/**
 * The CROSS-FIELD config rules: one expression, two consumers.
 *
 * The host throws the first violation — a config update fails loudly and
 * whole; the browser half formats every violation into its problem list —
 * the user fixes what the form shows, not what a log says. Both sides used
 * to carry their own copy of these rules, stitched together by comments
 * promising they were in sync, and they had already drifted. The rules now
 * exist once, here.
 *
 * Single-field bounds (an empty provider, maxRetries out of range) are NOT
 * here and never were: the schema owns them on the host, and the browser's
 * draft-shape checks (client/validate.ts) own them pre-save. That boundary
 * is deliberate — see assertStructural's docstring in config.ts.
 *
 * Note: 为何跨字段校验收编到一处、被否的「两边各留 + 对账测试」方案 —— 见
 * .agents/notes/implemented/2026-10-17-policy-into-the-decision-core.md
 */

import type { HandoffConfig, HealthConfig, NamedChain } from './config.ts'
import { chainLabel } from './chain.ts'
import { HANDOFF_FAILOVER_INHERIT, HANDOFF_FAILOVER_NONE, HANDOFF_INSTRUCTIONS_MAX, isSwitchOnKey } from './defaults.ts'
import { routeKeyOf } from './routes.ts'

/**
 * One broken cross-field rule. `key`/`vars` feed the browser's dictionary;
 * `message` is the host's load-failure text. The host reads only `message`,
 * the browser only `key`/`vars` — one rule, two renderings.
 */
export interface Violation {
  readonly key: string
  readonly vars: Record<string, string | number>
  readonly message: string
}

/** The config shape both sides validate: a host Config's plain value, or a browser draft. */
export type StructuralInput = {
  chains: NamedChain[]
  defaultChainId: string
  health?: HealthConfig
  handoff?: HandoffConfig
}

/**
 * Every cross-field violation, in the order the host used to throw them —
 * so the first-thrown message is unchanged for a config that breaks several
 * rules at once. The browser reports all of them.
 *
 * The per-chain rules run once PER CHAIN: two chains may legitimately name the
 * same route (they are alternative orders for different tasks), while a repeat
 * inside one chain is still the same wasted-budget bug as before.
 */
export function structuralViolations(config: StructuralInput): Violation[] {
  const violations: Violation[] = []
  const seenIds = new Set<string>()
  config.chains.forEach((chain, chainIndex) => {
    const label = chainLabel(chain)
    if (seenIds.has(chain.id)) {
      violations.push({
        key: 'problemDuplicateChainId',
        vars: { chain: chainIndex + 1, id: chain.id },
        message: `model-router: two chains share the id '${chain.id}' `
          + '— a session binding names an id, so two chains with one id make the binding ambiguous',
      })
    }
    seenIds.add(chain.id)
    const candidates = chain.candidates
    // 同一条链上重复的 provider/model 没有意义：它会被各打一遍（各含一次退避等待），
    // 白吃 attempt 预算，而用户看到的是「我配了两条备用」。目录选择和多条目手录都可能
    // 录出重复，所以在结构校验就挡住。
    const seen = new Set<string>()
    candidates.forEach((candidate, index) => {
      const key = routeKeyOf(candidate.provider, candidate.model)
      if (seen.has(key)) {
        violations.push({
          key: 'problemDuplicateRouteInChain',
          vars: { chain: chainIndex + 1, route: key, index: index + 1 },
          message: `model-router: the chain "${label}" names ${key} more than once `
            + `— a repeated candidate is attempted twice and burns the budget twice`,
        })
      }
      seen.add(key)
    })
    // 白名单里拼错的键等于一条永远不命中的规则：保存得下、什么也不做。键清单与
    // 「失败切换」同一套，所以这里能逐项判定，不需要枚举失败码。
    // `?? []`：rules 是纯函数，也可能被手工构造的输入调用；缺这个键 = 一条白名单
    // 也没有（路由侧总由 chainFrom 填上默认名单，这里只校验用户写了什么）。
    for (const key of chain.immediateSwitch ?? []) {
      if (!isSwitchOnKey(key)) {
        violations.push({
          key: 'problemUnknownImmediateSwitch',
          vars: { chain: chainIndex + 1, entry: key },
          message: `model-router: the chain "${label}" lists '${key}' in immediateSwitch, `
            + 'which is not a switchOn key — the entry would never match a failure',
        })
      }
    }
    // A weight strategy with no positive weight has nothing to draw from, and the
    // failure would surface as every request silently starting at the same hop.
    if (chain.strategy === 'weight'
      && candidates.length > 0
      && candidates.every(candidate => !(candidate.weight > 0))) {
      violations.push({
        key: 'problemWeightNoPositive',
        vars: { chain: chainIndex + 1 },
        message: `model-router: the chain "${label}" uses the weight strategy but no candidate has a positive weight`,
      })
    }
  })
  // 默认链 id 必须指向一条存在的链：它是"没绑定的会话走哪条"的唯一答案，
  // 悬空时每次请求都会退到"第一条"，而这与用户看到的设置不是一回事。
  if (config.chains.length > 0 && !config.chains.some(chain => chain.id === config.defaultChainId)) {
    violations.push({
      key: 'problemUnknownDefaultChain',
      vars: { id: config.defaultChainId },
      message: `model-router: defaultChainId '${config.defaultChainId}' names no chain — `
        + 'sessions without a binding would route on a chain the configuration does not define',
    })
  }
  // 一条两个字段都空白的规则永远命中不了任何东西，留着只会让人以为配过了。
  // 空规则在任何状态下都是配置错误：breaker.ts 对 code/message 全空的规则命中每一次
  // 失败，「关着开关存下一条空规则」会让所有候选被禁。所以这里不看 enabled——规则
  // 可以留着（再开时不用重填），空白规则不行。
  for (const [index, rule] of (config.health?.breaker?.rules ?? []).entries()) {
    if (!rule.code && !rule.message) {
      violations.push({
        key: 'problemBreakerEmptyRule',
        vars: {},
        message: `model-router: health.breaker rule ${index + 1} matches nothing — fill in a code or a message`,
      })
    }
  }
  violations.push(...handoffViolations(config))
  return violations
}

/**
 * 名册的保存期校验（提案 §十二「保存期校验（恒定，与默认值无关）」）：
 * `purpose` 非空；`preset` 与 `instructions` 至少一个非空；`instructions`
 * ≤ {@link HANDOFF_INSTRUCTIONS_MAX} 字符；`id` 唯一。
 *
 * 这些是"在任何环境里都错"的规则，所以和链的规则一样放在这里、两边同源：
 * host 抛第一条，浏览器把每一条渲染成字段级提示。`provider`/`model` 能不能
 * 真的解析是环境事实（与候选同一条裁定），降级成界面上的警告，不在这里拒绝。
 */
function handoffViolations(config: StructuralInput): Violation[] {
  const violations: Violation[] = []
  const handoff = config.handoff
  if (handoff === undefined) return violations
  const chainIds = new Set(config.chains.map(chain => chain.id))
  const rosterIds = new Set<string>()
  for (const [index, entry] of (handoff.roster ?? []).entries()) {
    const label = entry.name || entry.id || `#${index + 1}`
    if (entry.id.trim() === '') {
      violations.push({
        key: 'problemRosterEmptyId',
        vars: { index: index + 1 },
        message: `model-router: handoff roster entry ${index + 1} has no id — the tool and the review ledger address a role by id`,
      })
    } else if (rosterIds.has(entry.id)) {
      violations.push({
        key: 'problemRosterDuplicateId',
        vars: { index: index + 1, id: entry.id },
        message: `model-router: two roster entries share the id '${entry.id}' — delegate would name an ambiguous role`,
      })
    }
    rosterIds.add(entry.id)
    // purpose 是模型选人的唯一依据：空白的工牌只能让模型凭名字猜人。
    if (entry.purpose.trim() === '') {
      violations.push({
        key: 'problemRosterEmptyPurpose',
        vars: { index: index + 1, role: label },
        message: `model-router: roster entry '${label}' has an empty purpose — the model picks a role by it, so a blank one is a guess`,
      })
    }
    // preset 与 instructions 都空 = "随便一个子智能体，只知道这次任务"，角色退化成摆设。
    if (entry.preset.trim() === '' && entry.instructions.trim() === '') {
      violations.push({
        key: 'problemRosterNoDefinition',
        vars: { index: index + 1, role: label },
        message: `model-router: roster entry '${label}' sets neither preset nor instructions — the role would carry no personality at all`,
      })
    }
    if (entry.instructions.length > HANDOFF_INSTRUCTIONS_MAX) {
      violations.push({
        key: 'problemRosterInstructionsTooLong',
        vars: { index: index + 1, role: label, max: HANDOFF_INSTRUCTIONS_MAX, length: entry.instructions.length },
        message: `model-router: roster entry '${label}' has ${entry.instructions.length} characters of instructions, `
          + `over the ${HANDOFF_INSTRUCTIONS_MAX} limit — it enters the child's context on every delegation`,
      })
    }
    // 只填一半不是路由：provider 没有 model 无处可发，反之亦然。
    if ((entry.provider.trim() === '') !== (entry.model.trim() === '')) {
      violations.push({
        key: 'problemRosterHalfRoute',
        vars: { index: index + 1, role: label },
        message: `model-router: roster entry '${label}' sets only one of provider/model — a half route is not a route`,
      })
    }
    // failover 指向一条不存在的链 = 失败后无处可去；点名拒绝，不静默当 inherit。
    if (entry.failover !== HANDOFF_FAILOVER_INHERIT
      && entry.failover !== HANDOFF_FAILOVER_NONE
      && !chainIds.has(entry.failover)) {
      violations.push({
        key: 'problemRosterUnknownFailoverChain',
        vars: { index: index + 1, role: label, chain: entry.failover },
        message: `model-router: roster entry '${label}' fails over to '${entry.failover}', which names no chain`,
      })
    }
  }
  // 兜底角色必须真的存在：填错了就是一个永远不会发生的"自动派"。
  const delegateTo = handoff.onUnreceiptedStop?.delegateTo ?? ''
  if (delegateTo !== '' && !rosterIds.has(delegateTo)) {
    violations.push({
      key: 'problemUnreceiptedUnknownRole',
      vars: { id: delegateTo },
      message: `model-router: onUnreceiptedStop.delegateTo names '${delegateTo}', which is not in the roster`,
    })
  }
  return violations
}
