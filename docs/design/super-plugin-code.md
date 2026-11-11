---
title: "DSH 超级插件 — V0 代码设计"
status: "proposed"
kind: "code-design"
last_updated: "2026-11-09"
---

# DSH 超级插件 — V0 代码设计

## 摘要

架构决定"东西放哪"，代码设计决定"写错了会不会被发现"。

三条规则贯穿全文：

1. **决策用结果值，失败用异常**：拒绝是正常业务路径（`{ allowed: false, reason }`），读不到 GitHub 才是异常（throw，带上下文）。边界**转换一次**，不允许核心和边界各翻译一遍。
2. **纯函数入参全 `readonly`，时间从外面传**：`now: number` 是参数，不是 `Date.now()`。这样每一层都能被确定性地测。
3. **类型里不出现 `type: string` + 一堆可选字段**：用联合类型把非法状态排除，让编译器替你守不变量。

## 一、类型地图

### 1.1 五个实体

```ts
// ── 外部来的东西 ─────────────────────────────
export type SourceId = string & { readonly __brand: 'SourceId' }
export type CaseId = string & { readonly __brand: 'CaseId' }
export type TriggerKey = string & { readonly __brand: 'TriggerKey' }

/** 一个外部事件。不可变，且带幂等键。 */
export interface Trigger {
  readonly key: TriggerKey          // sourceId + 外部 id，唯一构造点
  readonly source: SourceId
  readonly thread: ThreadKey        // issue #12 / 群聊 oc_xxx / PR #7
  readonly kind: 'direct' | 'mention' | 'follow-up' | 'ci'
  readonly actor: Actor
  readonly text: string
  readonly at: number
}

/** 谁在哪个源上。身份不跨源映射（跨源是提示词，不是实体）。 */
export interface Actor {
  readonly source: SourceId
  readonly id: string
  readonly handle: string
}
```

`TriggerKey`、`CaseId` 用 branded type，不是为了好看：它们都是 `string`，混用一次就是数据错乱，而 `brand` 让编译器当场报错，且零运行时开销。

### 1.2 状态是派生的，不是存的

```ts
/** 存在表里的只有这些事实。 */
export interface CaseRecord {
  readonly id: CaseId
  readonly mandate: Mandate
  readonly origin: TriggerKey
  readonly openedAt: number
  readonly closed: ClosedReason | null
}

export interface Mandate {
  readonly strength: 'explicit' | 'inferred'
  readonly actor: Actor
  readonly scope: readonly ThreadKey[]
  readonly policyVersion: number
}

/** 从事实算出来的状态。永不落库。 */
export type Stage =
  | { readonly kind: 'needs-person'; readonly reason: PersonReason }
  | { readonly kind: 'queued' }
  | { readonly kind: 'waiting'; readonly since: number }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly how: ClosedReason }

export type PersonReason = 'delivery-failed' | 'question' | 'review' | 'blocked'
export type ClosedReason = 'completed' | 'merged' | 'stopped' | 'failed' | 'dropped'
```

**为什么状态不落库**：落了就有两份事实，它们迟早矛盾。派生的代价是每次算一遍——这是纯函数，算一遍是微秒级。

### 1.3 下一步是联合类型

```ts
export type Step =
  | { readonly kind: 'work'; readonly brief: string; readonly preset: PresetId }
  | { readonly kind: 'ask'; readonly question: Question }
  | { readonly kind: 'close'; readonly reason: ClosedReason }
```

没有 `kind: 'work' | 'ask' | 'close'` 加五个可选字段——那样每个消费者都要判断"这个字段在不在"，判断错就是运行时 `undefined`。

## 二、六个核心函数

全部在 L2，全部纯函数，全部只读入参。

### 2.1 闸门：这条 Trigger 能不能变成 Case

```ts
export type Admission =
  | { readonly admitted: true; readonly strength: 'explicit' | 'inferred' }
  | { readonly admitted: false; readonly reason: RefusalReason }

export type RefusalReason =
  | 'sender-not-allowed'
  | 'bot-not-allowed'
  | 'not-addressed'
  | 'source-disabled'
  | 'inferred-mode-off'

export function admit(input: {
  readonly trigger: Trigger
  readonly policy: Readonly<Policy>
}): Admission
```

不变量：`admitted: true` 时 `strength` 必填；`admitted: false` 时 `reason` 必填。**拒绝不是异常**——调用方用 `switch` 处理，不用 `try/catch` 做流程控制。

### 2.2 派生状态

```ts
export function deriveStage(input: {
  readonly theCase: CaseRecord
  readonly steps: readonly StepRecord[]
  readonly attempts: readonly AttemptRecord[]
  readonly now: number
}): Stage
```

不变量：**输入相同，输出必然相同**。这条由守卫脚本强制（文件里出现 `Date.now` 或 `Math.random` 即失败）。

### 2.3 下一步做什么

```ts
export function planStep(input: {
  readonly theCase: CaseRecord
  readonly stage: Extract<Stage, { kind: 'queued' | 'waiting' | 'working' }>
  readonly steps: readonly StepRecord[]
  readonly budget: Readonly<Budget>
}): Step
```

参数类型直接排除 `needs-person` 和 `done`——**调用方拿错阶段编译不过**，不需要运行时 `if`。

### 2.4 走哪条渠道

```ts
export function resolveRoute(input: {
  readonly candidates: readonly Candidate[]
  readonly tried: readonly AttemptRecord[]
  readonly health: Readonly<RouteHealth>
  readonly retriesPerRoute: number
}): { readonly route: Candidate } | { readonly exhausted: true; readonly lastCode: string }
```

不变量：返回的 `route` 一定不在 `tried` 里超过 `retriesPerRoute` 次。

### 2.5 这个动作许不许

抄 comet 的形状（`guardrails.ts` 的 `checkAction`）：

```ts
export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export function checkAction(input: {
  readonly action: Action
  readonly run: Readonly<RunState>
  readonly limits: Readonly<Limits>
}): Verdict
```

### 2.6 幂等键

```ts
/** 唯一构造点。任何地方都不许自己拼字符串。 */
export function triggerKey(source: SourceId, externalId: string): TriggerKey
export function threadKey(source: SourceId, external: string): ThreadKey
```

这是**最容易出跨文件 bug 的地方**：两处拼接格式不一致 = 幂等失效 = 重复开 Case。所以它是一个函数，不是一段模板字符串。

## 三、Source 接口与 GitHub 实现

```ts
export interface Source {
  readonly id: SourceId
  /** 从游标读到 now。游标与失败重试由调用方持有，不进 Source。 */
  poll(input: PollInput): Promise<PollResult>
  /** 设置页要显示的事：读哪儿、读到哪、上次错在哪。 */
  describe(): SourceStatus
}

export interface PollInput {
  readonly cursor: Cursor | null
  readonly now: number
  readonly signal: AbortSignal
}

export interface PollResult {
  readonly triggers: readonly Trigger[]
  readonly cursor: Cursor
}
```

三条设计约束：

1. **`poll` 不写游标**。它只报告"读到哪了"。写游标和写 `case` 必须在**同一个事务**里，那是 L4 的事——否则重启后重复处理。
2. **`poll` 不判断授权**。它只把"谁说了什么"翻译成 `Trigger`，`admit` 是纯函数，在它之后。
3. **`now` 是参数**。测试里传固定值，不用假时钟库。

GitHub issue 的实现骨架：

```ts
export function githubIssueSource(input: {
  readonly octokit: OctokitFace      // 只声明用到的方法
  readonly repo: { owner: string; name: string }
  readonly agentLogin: string
}): Source
```

`OctokitFace` 是**我们自己声明的窄接口**，不是 Octokit 的类型：

```ts
export interface OctokitFace {
  listIssueComments(input: { owner: string; name: string; since: string }): Promise<readonly RawComment[]>
  getIssue(input: { owner: string; name: string; number: number }): Promise<RawIssue>
}
```

理由：测试里写一个 20 行的对象就能覆盖全部分支，不用起 mock server，也不会因为 Octokit 升级而红一片。

## 四、存储的读模型

写用 `ctx.storageDomain`（DSH 认可的侧车），读用**明确的快照类型**：

```ts
export interface CaseSnapshot {
  readonly theCase: CaseRecord
  readonly steps: readonly StepRecord[]
  readonly attempts: readonly AttemptRecord[]
  readonly stage: Stage           // 算好的，不是存的
}

export interface Ledger {
  load(caseId: CaseId): Promise<CaseSnapshot | undefined>
  append(event: AuditEvent): Promise<void>
  /** 一个 thread 现在归哪个 Case；没有就是 undefined。 */
  caseOfThread(thread: ThreadKey): Promise<CaseId | undefined>
}
```

`Ledger` 是端口，不是实现：写测试时给一个内存实现即可。真实实现包 `storageDomain`。

**模型不能写表**：它只能通过工具提交 `Outcome`，由 L4 落库。这是 comet 的结论（`comet-state set` 拒绝写 machine-owned 字段），我们照做。

## 五、测试策略：每层测法不同

| 层 | 测法 | 用什么假实现 | 数量级 |
|---|---|---|---|
| L1 | **不测**（类型即测） | — | 0 |
| L2 | 表驱动真值表：一组输入一条断言 | **无 mock** | 每函数 8–20 例 |
| L3 | 内存实现 + 一次真实 `storageDomain` | 内存 `Ledger` | 每表 3–5 例 |
| L4 | 假 port：假 GitHub、假会话、假时钟 | 3 个 | 每流程 5–10 例 |
| L5 | 真实 Loader 组合（沿用现有 37 场景） | 无 | 每面 3–5 场景 |

**关键**：L2 一条 mock 都不许有。出现 mock 就说明这个函数不纯，要拆。

一个典型 L2 用例长这样（无框架、无 mock、无 async）：

```ts
test('闸门：未授权的人 @ 也不算请求', () => {
  const verdict = admit({
    trigger: mention({ actor: actor('stranger') }),
    policy: policy({ allowed: ['alice'] }),
  })
  assert.deepEqual(verdict, { admitted: false, reason: 'sender-not-allowed' })
})
```

## 六、禁止的写法

| 禁止 | 为什么 | 换成 |
|---|---|---|
| `utils.ts` / `helpers.ts` / `common.ts` | 无主的垃圾桶，最后什么都往里塞 | 按概念命名：`trigger-key.ts`、`stage.ts` |
| `function plan(flag: boolean, ...)` | 布尔参数选择行为，读者要去看实现 | 两个函数，或联合类型参数 |
| 在 L2 里 `Date.now()` | 决策不可复现，测试必红 | `now: number` 入参 |
| 用 `try/catch` 处理拒绝 | 拒绝是常态，异常应是意外 | 结果值 + `switch` |
| `as any` / `as unknown as` | 把编译期错误推迟到线上 | 收窄接口，或在边界做一次校验 |
| 一个文件两个主导出 | 改一个动两个 | 拆文件 |
| `console.log` | 在生产里没有出口 | `ctx.logger` |

## 七、和现有代码的关系

**不重写，增量长。** 现有 `index.ts`（1258 行）继续跑 V0 的路由，新代码在旁边长：

1. 新建 `src/core/`（L2 纯函数）+ `src/sources/`（L4）
2. `index.ts` 只加两处调用：`poll` 的 pass 循环、`admit` 的闸门
3. 每一刀（V0–V5）把一块现有逻辑搬进新目录，**搬的时候不改语义**

判据不变：每次搬完 `npm test` 五套件数字必须一致。守卫脚本从第一天就跑，它守的是"新代码不许依赖老代码的私有部分"。

## 八、V0 的文件清单

```
src/
  core/                      纯函数，零 import（除 L1）
    trigger-key.ts           triggerKey / threadKey
    admission.ts             admit
    stage.ts                 deriveStage
    plan-step.ts             planStep
    route.ts                 resolveRoute
    check-action.ts          checkAction
  contract/                  类型、常量、默认值
    types.ts  defaults.ts  policy.ts
  sources/
    source.ts                Source / PollInput / PollResult
    github-issue.ts          githubIssueSource
    github-face.ts           OctokitFace（窄接口）
  runtime/
    ledger.ts                Ledger 接口 + 内存实现
    pass.ts                  一次 pass：poll → admit → openCase
  faces/
    ingress.ts               pass 循环的注册与调度
tests/
  layers.mjs                 守卫
  core/*.mjs                 表驱动
  sources/github-issue.mjs   假 OctokitFace
```

**原计划 11 个源文件 + 3 个测试；实际落地 19 个源文件 + 6 个测试**（多出 `contract/policy`、`contract/defaults`、`core/mentions`、`core/case-id`、`core/brief`、`core/trigger-key`、`sources/github-face`、`sources/github-http`、`runtime/durable-ledger` 与 `layers` 守卫）。逐文件行数与测试套件见[总览](overview.md)第四节。写完后，你能在 issue 里 @ 它一次——目前建出 Case 就停，回评论与执行器（executor）仍缺。
