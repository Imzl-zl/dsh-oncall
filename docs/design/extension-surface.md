---
title: "DSH On-call — 扩展面设计建议"
status: "proposed"
kind: "design-proposal"
last_updated: "2026-10-29"
---

# DSH On-call — 扩展面设计建议

## 摘要

本页回答一个问题：**"何时说话 / 何时派人 / 何时换场"这类判断该住在哪里，才能加第十条规则时不用改核心。**

结论三句：① 我们的形态是 **policy-vs-mechanism**（纯函数裁决 + 解释器），不是 hook/rule engine，更不是 workflow DSL；`src/skip-plan.ts` 已经是这个形态的样板，缺的是把它横向推广到"说话面"。② 缺口不在架构而在归属：`index.ts` 的 9 处发言（3 `steer` + 6 `append`）各自把条件写死在回调里，这是"加第 5、6 处"的唯一原因。③ 该抽的顺序是 **key → 说话 → 动作 → 文件拆分**，模式层（"全自动/半自动"）应做成**纯派生视图**而不是新配置实体，且建议最后做、或不做。

**本页只出设计与迁移清单，不改代码。** 列在第七节的改动待你拍板后才执行；未拍板前 `src/` 与 `tests/` 保持现状。

## 一、现状清点（已实测，不重测）

本页引用的 `review N.N` / `4.12` 编号，条目原文与断言位置见[功能完成度与逻辑语义审查](feature-review-2026-10-26.md)第七节；`五.1` / `十二.3` 等是[决策登记簿](open-questions.md)的节号。

### 1.1 对外接缝：5 处，全部注册在 `src/index.ts`

| # | 事件 | 注册位置 | 注册契约 | 插件在此能做什么 | 不能做什么 |
|---|---|---|---|---|---|
| 1 | `agent/request` | `index.ts:301`（`prepend: true`，`index.ts:510`） | waterfall；先 `await next()` 再覆盖返回值 | 换候选 route、发跳过/切换 notice | 不能取消请求（必须返回一个 config，只能 redirect 不能 cancel——`open-questions.md` 五.1）；不能改 messages/tool 请求体 |
| 2 | `agent/request-error` | `index.ts:525`（`prepend: true`，`index.ts:604`） | waterfall；`await next()` 拿内层裁决后处置 | 返回 `{kind:'retry'}` 或 `undefined`；记录熔断 | 不能伪造 `llm/retry` 记录 |
| 3 | `agent/pre-step` | `index.ts:290` | waterfall；**只观察** | 采集条件（图片/上下文压力）写进 `states` | 不改 decision |
| 4 | `agent/turn-stopping` | `index.ts:614`（路由）、`index.ts:721`（交接，经 `ctx.inject` 子 fiber） | 普通事件；先于 `turn/end` | `agent.steer(...)` 续跑/追问；派人；发 notice | 不能用 `concludesTurn` 替模型收尾 |
| 5 | `session/event` | `index.ts:236` | 纯观察 | 折叠 attempt 失败码、截断、`tool/result` 里的图 | 不写事件 |

DSH 侧的语义锚（行号与核对口径见[源码地图](source-map.md)）：`agent/request` 定义在 [`runtime-types.ts`](file:///D:/sudy/github/deepseek-harness/packages/core/agent/src/runtime-types.ts#L373)，在 `prepareRequest()` 里先跑 waterfall 再 `prepareCall()`（[`agent.ts`](file:///D:/sudy/github/deepseek-harness/packages/core/agent-loop/src/agent.ts#L606)）；failure 结算成 `assistant/attempt` 之后才分发 `agent/request-error`（[`agent.ts`](file:///D:/sudy/github/deepseek-harness/packages/core/agent-loop/src/agent.ts#L515)）；`prepareCall()` 已经捕获 adapter（[`llm/index.ts`](file:///D:/sudy/github/deepseek-harness/packages/llm/llm/src/index.ts#L956)），所以 `llm/stream` 不是本插件的 route 选择面。

**为什么接缝只有 5 个而不是"每功能一个"**：DSH 暴露的是**生命周期的时刻**，不是功能挂点。这一条决定了后面的取向选择——见第三节宿主插件系统。

### 1.2 内部注册点（同一份文件，非接缝）

`src/index.ts` 共 1166 行，三个 section：路由 `169-650`、交接 `652-773`、插件自有 Remote `774-1166`。文件内另有 8 处 listener 注册（上表 5 个 + `internal/config` `:194` + `agent/created` `:267` + 交接侧的 `child.on` `:721`）与 3 个投影注册（`:218`/`:219`/`:224`），7 个 `@Remote`（`:782`/`:825`/`:847`/`:877`/`:894`/`:916`/`:942`）。

职责叠了四层：注册（`install`/`installHandoff`）、接线（读 config、读 bindings、取 projections）、解释器（按裁决 apply 副作用）、Remote（7 个方法）。**这是①缺口的准确描述**：不是"文件太大"，是"解释器与 Remote 也在同一个类里，抽裁决时无处安放"。

### 1.3 纯函数核清单（可继续长）

| 模块 | 纯函数 / 数据 | 输入 → 输出 | 现有读者 |
|---|---|---|---|
| `src/router.ts`（607 行） | `resolveStartIndex` `:51`、`resolveChain` `:104`、`startStep` `:167`、`planFire` `:215`、`skipTo` `:247`、`jumpTo` `:258`、`decideRecovery` `:378`、`decideBeforeInner` `:476`、`decideAfterInner` `:571` | `StepState × 事实 → 裁决数据` | `index.ts` 两个 handler |
| `src/skip-plan.ts`（131 行） | `planSkipNotices` `:97` | `SkipPlanInput → { notices, keys }` | `index.ts:436`（唯一调用点） |
| `src/rules.ts`（258 行） | `structuralViolations` `:53` | `StructuralInput → Violation[]` | host 抛第一条 / 浏览器收全部 |
| `src/state.ts`（412 行） | `RouterState`（类，无 I/O）、`emptyConditions` `:109`、`candidateConfig` `:410` | 内存账本读写 | 全部路由路径 |
| `src/timeline.ts`（185 行） | `bucketTimeline` `:130`、`windowSuccessRate` `:96`、`bucketTone` `:111`、`pruneTimeline` `:178` | 观测点 → 24 格 | 健康页 |
| `src/backoff.ts`（80 行） | `planBackoff` `:38`（纯）+ `waitBeforeRetry` `:66`（**唯一有 I/O 的"核"**） | 次数 → 延迟 | `index.ts:596` |
| `src/precheck.ts`、`src/routes.ts`、`src/health.ts` 的 `classifyHealth` | 分类与键 | code → tier/key | 多处 |

判据（沿用现有）：**核不 import `ctx`、不读 `Date.now()`、不 append**。`backoff.ts` 的 `waitBeforeRetry` 是例外且被切成两半（计划纯、执行不纯），这个切法就是 policy 层的模板。

### 1.4 单一事实源清单

| 事实 | 唯一来源 | 第二份会出现在哪 |
|---|---|---|
| 边界与默认值 | `src/defaults.ts`（384 行；`MAX_RETRIES` `:49`、`MAX_TOKEN_CONTINUES` `:202`、`HANDOFF_INSTRUCTIONS_MAX` `:312`） | schema 字面量、浏览器钳位、文案里的 `0~99` |
| 配置形状与类型 | `src/config.ts`（694 行；`Config` `:380`、`chainSchema` `:172`、`handoffSchema` `:366`、`assertStructural` `:686`） | 客户端草稿类型 |
| 跨字段规则 | `src/rules.ts` 的 `structuralViolations` | 两侧各写一份（曾漂移，见 `rules.ts:1-18`） |
| 浏览器侧归一化/钳位 | `src/client/validate.ts`（360 行） | 与 defaults 抄一份数字 |
| 投影键与计数口径 | `src/handoff-wire.ts`（131 行；`HANDOFF_KEY` `:23`）、`src/lineage.ts` 的 `FAILOVER_HISTORY_KEY` `:45`、`src/health.ts` 的 `CHANNEL_HEALTH_KEY` `:139` | UI 侧自行拼 key |
| 通知文案 | `src/notice.ts`（295 行，14 个通知构造函数 + `codeLabel`）+ `src/client/locales.ts` 中英两份 | 模块内手写中文（`validate.ts:43-44` 记着这条教训） |

### 1.5 发声点清单（这是②③缺口的量化）

`agent.steer` 3 处：`index.ts:631`（截断续跑）、`:648`（续满后换候选前再催一次）、`:747`（未交回执 nudge）。
`session.append('user/message')` 6 处：`:323`（绑定链已删）、`:456`（跳过通知，**已按 plan 执行**）、`:478`（截断换候选）、`:494`（失败切换）、`:756`/`:766`（未交回收工）。
交接侧另有 `handoff-tool.ts:526` 的 `newAgent.followup(...)`（接力首条消息）。

合计 **9 个插件自发的说话点 + 1 个接力入口**。去重则是四套并行的土办法：`skip-plan` 的 `keys`（`:456`）、内联的 `binding:` 键（`:319-329`）、`nudges` 计数器（`:743-749`）、续跑计数（`:628-631`）。**不是"没有去重"，是"每句自己发明了一套"**——这才是加第 10 句时要重新想一遍"用哪种"的原因。你给的"4 处 `agent.steer`（612/631/648/747）"里，612 是**注释**（解释官方 `/loop` 模式在同一事件里 `steer`），真正的 `steer` 调用是 3 处——这正好说明条件写在注释与回调里、只能靠读代码清点。

## 二、"何时说话 / 派人 / 换场"该怎么分层

### 2.1 三种取向与它们的失败模式

| 取向 | 形态 | 多智能体场景下的失败模式（按发生概率） | 我们已经/即将吃到哪一条 |
|---|---|---|---|
| **A. policy-vs-mechanism**（纯函数裁决表 + 解释器） | `decision = f(不可变事实) → 裁决数据`；副作用由解释器按数据执行 | ① **输入快照不全**：裁决与真实世界脱节；② **判决时机错**：函数纯但被放在错误的时间点调用；③ **一次性账本漂移**：谁说、谁记账分家就去重失效；④ 跨调用状态（如 `pendingAdvance`）藏在两个纯函数之间 | ①已吃：`agent/request` payload 不带 messages，图片条件必须靠 `pre-step` 累积（`index.ts:284-289`）。②已吃且是 Critical 级：可服务性判断藏在 `planFire` 的"顺带前进"里，`decideRecovery` 晚一步才看到 `exhausted`，多打一次（`open-questions.md` 五.1）。③已防住：keys 由裁决产出、解释器写入（`skip-plan.ts:78-83`）。④现存：`state.pendingAdvance` |
| **B. 事件驱动 hook/rule engine** | N 个 listener 挂在生命周期事件上，各自决定是否动作；顺序与优先级是注册契约 | ① **顺序成为隐式契约**，上游改顺序即静默变行为；② 同事件多 listener **重复说话**（durable message 进模型上下文，token 双付）；③ "中止/收尾"没有类型化语义，靠返回 `undefined` 表达；④ 组合才可测：单 listener 单测全绿、合起来错 | ①已吃两次：`prepend` 内层实测打 7 次、外层 2 次（`tools.md:45`），且上游已把这套顺序契约列为要废止（`open-questions.md` 十二.3）。②是 4.12 的原发 bug（`skip-plan.ts:8-15`）。③是 `decideAfterInner` 要返回四种裁决（honor/retry-self/advance/放弃，`index.ts:590-603`）的原因 |
| **C. workflow DSL** | 一份声明式图/表达式，引擎解释执行 | ① **引擎是第二个执行器**，与宿主回合循环抢所有权；② **表达式语言必然生长**：要评测器、校验、以及"用户写坏了"的支持成本；③ durable 后要**确定性回放**与版本化；④ 静态图难表达运行期判断（边集在编译期固定） | ①②见第六节；③见 Temporal 一节；④正是"模型自己决定何时交接"与 LangGraph 的张力 |

外部证据：

- **C 的语法债是公开的**：Argo 的 `when` 由 [`govaluate`](https://argo-workflows.readthedocs.io/en/latest/walk-through/conditionals/) 实现，同一页还要为"参数里含引号"再提供一套 `{{= ... }}` 内嵌表达式语法；GitHub Actions 的 `if` 需要 [`${{ }}` 与 `!` 的 YAML 转义例外](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)。表达式语言一旦发布就不能小改。
- **A 的"纯"是可以被平台强制的**：Temporal 要求 [Replay 时生成的 Command 必须与既有 Event History 吻合](https://docs.temporal.io/workflow-execution)，并由 [Deterministic constraints](https://docs.temporal.io/workflow-definition#deterministic-constraints) 约束工作流代码。我们的裁决函数就是这个意义上的"确定性代码"，只是没有引擎替我们校验——所以必须靠结构（不读时钟、不读 ctx）而不是靠运行时。
- **B 的顺序问题不在我们这儿**：DSH 的 waterfall 语义是"数组首个 listener 最外层，`await next()` 之后改写覆盖内层"（`tools.md:44`），顺序由 `prepend` 标志决定而非书写顺序。这已经是"host 强制的顺序契约"，我们只能在它之上减少依赖。

### 2.2 结论：A 作骨、B 作皮、C 只借一点

- **骨用 A**：所有"要不要说 / 要不要派人 / 换到哪 / 终不终止"都写成 `(facts) → plan` 的纯函数。理由不是洁癖：②③ 两类 bug（时机错、去重失效）只有在纯函数 + 单一账本写者下才可测。
- **皮用 B**：接缝本来就是 5 个事件，不额外造调度器。B 的问题（顺序、重复）用 A 的产物压住：解释器只有一个，且有一次性 key。
- **从 C 只借一件事**：用**数据**描述转移（`planFire` 的 FirePlan、`SkipPlan`），而不是用语法描述。不要借第二件事——表达式求值。

## 三、参考对象：各一条可迁移结论

| 对象 | 官方文档 | 可迁移结论（一句话） | 明确不迁移的部分 |
|---|---|---|---|
| **LangGraph** | [Graph API overview](https://docs.langchain.com/oss/python/langgraph/graph-api) | "节点干活、边决定下一步"，边是**函数**且可条件化——所以"何时换场"在它那里也是代码不是配置；其代价是图在 `compile()` 时定型（检查孤儿节点、绑定 checkpointer）。**我们对应物：`router.ts` 的决策函数；不做对应物：compile 期图校验** | 图/超步（Pregel 式 message passing）、checkpointer、`interrupt()` 式挂起（[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)）——DSH 的回合循环已经是那张图 |
| **AutoGen** | [Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html) | **最接近我们的一种形状**：termination condition 是"接收**自上次调用以来**的增量消息、返回 StopMessage 或 None 的可调用对象"，可 `&`/`\|` 组合，且**每次 run 后自动 reset**。增量视图 + 可组合谓词 + 每轮重置，正好是"一次性 key"的三个要素 | 把组合谓词做成对象树（`A \| B & C`）——我们的组合在配置里是勾选与档位，不是表达式；`reset()` 生命周期由 DSH 的 turn 边界免费提供 |
| **CrewAI** | [Flows](https://docs.crewai.com/en/concepts/flows) | **把"智能体"与"编排"拆成两个对象**（Crew vs Flow），Flow 用 `@start`/`@listen`/`@router`，而 `@router` 只**返回一个标签**、由 dispatcher 去触发 listener。**这正是"裁决产出数据、解释器执行"的工业写法**；也是"模式层"该有的样子（一种编排形态是一个对象，不是一个枚举字段） | Flow 自己的 `@persist`/state、`flow.plot()` 可视化、`@human_feedback` 的 LLM 归并反馈——我们的人机边界是 DSH 的 turn 边界 |
| **OpenAI Swarm**（参考对象）／其官方维护面 | [swarm 仓库](https://github.com/openai/swarm)；结论取自官方 [Agents SDK · Handoffs](https://openai.github.io/openai-agents-python/handoffs/) | handoff 呈现给模型**就是一个工具**（`transfer_to_<agent>`），可选 `is_enabled` **函数**在运行期决定是否可用，官方还提供 `RECOMMENDED_PROMPT_PREFIX` 教模型"何时交接"。**迁移结论：交接的可用性是一个谓词，不是一段编排；教学走工具描述**（与 `handoff.ts:470` 的 `compileDescription` 同构） | 把交接做成"换 agent 继续同一段对话"。我们是换场地（新会话/子会话）且历史各自独立；`input_filter` 式的历史裁剪不引入 |
| **Temporal** | [Workflow Execution](https://docs.temporal.io/workflow-execution) | **durable 的代价是确定性**：Replay 时生成的 Command 必须与既有 Event History 吻合。**迁移结论：任何要"可解释、可重放"的判断，必须是 (事件历史, 状态) 的纯函数**——这就是我们把裁决抽出来的第一性理由 | 事件历史、Command/Awaitable 模型、Worker/缓存、sticky execution。我们不拥有执行，也就没有 replay 负担 |
| **Argo Workflows** | [Conditionals](https://argo-workflows.readthedocs.io/en/latest/walk-through/conditionals/) | `when` 是**按节点**的表达式，条件写在"这一步要不要跑"上，而不是写在一个中央 dispatcher 里。**迁移结论：条件应贴着它约束的那个动作声明**（我们的"跳过某候选"就是这样），但条件必须是**枚举/勾选可表达的**，不能是字符串表达式 | govaluate 表达式、`{{= }}` 转义、DAG/step 模板、suspend/hooks |
| **GitHub Actions** | [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) | 三件可迁移：① `if` 条件、`needs` 依赖、`strategy.matrix` 扇出是**三件不同的事**，不要用一个字段表达；② `concurrency` 组是**去重键**的成熟形态（同组同时最多一个，排队者默认被新者取代）——我们的"每轮每路由一次"就是同一想法的 local 版；③ 复用走 `uses`+`with`（`workflow_call`），而不是复制 | YAML/表达式/contexts、runner 语义、secrets 传递。**特别地：不引入"用户可写`if`"** |
| **宿主插件系统**（eslint / webpack / rollup） | [ESLint Custom Rules](https://eslint.org/docs/latest/extend/custom-rules)、[webpack Compiler Hooks](https://webpack.js.org/api/compiler-hooks/)、[Rollup Plugin Development](https://rollupjs.org/plugin-development/) | 三者做"加功能不改核心"的**同一手法**：核心只暴露**固定、命名、有文档的生命周期点**，新功能 = 新插件；并且把"谁能否决、谁先跑"变成**类型化/数据化**而不是隐式约定（webpack 的 `SyncBailHook`/`AsyncSeriesHook`，Rollup 的 `first`/`sequential`/`parallel` 与 `order: 'pre' \| 'post'`，以及"返回 `null` 即交还给其他插件和默认行为"）。**ESLint 的关键一步**：扩展点是**遍历位置**（节点类型、selector、`:exit`、代码路径事件），不是"每条规则一个钩子"——所以规则数量增长不改变核心 | 把我们的 5 个接缝扩成"每功能一个钩子"。我们只允许新增 **policy 规则项**（数据），不允许新增 DSH listener |

三条从这张表直接落地的判断：

1. **接缝不增**（ESLint/webpack/Rollup 的共同点：扩展面是时刻，不是功能）。新增能力只能进 policy 表。
2. **裁决产出数据、解释器执行**（CrewAI `@router` 返回标签、AutoGen 返回 `StopMessage`、Temporal 的 Command 都是这个形状）。
3. **一次性语义靠"增量视图 + 每轮重置"**（AutoGen 的 delta + reset；GH Actions 的 concurrency 组），不靠调用方自觉。

## 四、建议形状：policy 层

### 4.1 分层图

```
                       ┌────────────────────────────────────────────┐
   DSH 事件 ──────────▶ │ L0 接缝层  (index.ts 现状，只做两件事)      │
   agent/request        │  payload → facts       plan → 副作用       │
   agent/request-error  └───────┬────────────────────────┬───────────┘
   agent/pre-step               │ facts                  │ append / steer /
   agent/turn-stopping          ▼                        │ return / delegate
   session/event        ┌──────────────────┐             │
                        │ L2 裁决层(纯函数) │             │
                        │ router / skip-    │             │
                        │ plan / rules /    │             │
                        │ policy.speak      │             │
                        │ policy.act        │             │
                        └───────┬──────────┘             │
                                │ 读 facts 快照           │ 写一次性 key
                                ▼                         ▼
                        ┌──────────────────┐      ┌──────────────────────┐
                        │ L1 事实层         │◀─────│ 一次性键账本          │
                        │ RouterState /     │      │ (agent, turn) 内存    │
                        │ 3 个 durable 投影  │      │ + durable 投影        │
                        └──────────────────┘      └──────────────────────┘
                                ▲
                        ┌───────┴──────────┐
                        │ L4 配置层         │  defaults / config / rules /
                        │ (旋钮与边界)      │  client/validate / locales
                        └──────────────────┘
```

要点：**只有 L0 能说话**；**只有 L0 写 key**；**L2 不 import `ctx`、不读 `Date`**。L1 是唯一的可变状态，L4 是唯一的配置真相。

### 4.2 输入：一次 fire 一个不可变快照

草案形状（示意类型，未编译，不进 `src/`）：

```ts
// 草案：DeskFacts —— 裁决层唯一的输入形状；由 L0 组装，L2 只读
interface DeskFacts {
  readonly where: { sessionId: string; turn: number; step: number; parentSession?: string }
  readonly chain?: { id: string; order: readonly number[]; candidates: readonly Candidate[] }
  readonly position?: { index: number; of: number }
  readonly conditions?: { hasImages: boolean; projectedTokens?: number }
  readonly failure?: { code: string }                        // 本步最近一次失败码
  readonly truncation?: { routeKey: string; used: number; continues: number }
  readonly cooling?: readonly string[]                        // 冷却中的 routeKey
  readonly handoff?: {
    readonly receiptCalled: boolean
    readonly pendingTodos: number
    readonly goalActive: boolean
    readonly lastReview?: { verdict: 'pass' | 'gap' }
    readonly budget: { delegations: number; reviews: number; newSessions: number }
  }
  readonly said: ReadonlySet<string>                          // 本 turn 已用过的 key，只读
}
```

事实从哪来（每条都有现成来源，不需要新数据）：`where`/`chain`/`position` ← `states.current(...)`（`state.ts:55`）；`conditions` ← `agent/pre-step` 的 `noteConditions`（`index.ts:293`）；`failure` ← `session/event` 折叠的 `assistant/attempt`（`index.ts:262-264`）；`truncation` ← `noteTruncation`（`index.ts:252`）；`cooling` ← `CircuitBreaker`（`breaker.ts:67`）；`handoff` ← `runtime.receiptState`（`index.ts:738`）；`said` ← `states.turnNoticeKeys`（`index.ts:442`）。

### 4.3 输出：计划，不是动作

```ts
// 草案：DeskPlan —— 只有数据；文案在 notice.ts，副作用在 L0
type DeskAction =
  | { kind: 'say';   key: string; at: 'surface' | 'steer'; notice: NoticeSpec }
  | { kind: 'carry'; key: string; to: SkipCandidate }            // 截断续满后换候选
  | { kind: 'delegate'; key: string; role: string }
  | { kind: 'relay'; key: string; outcome: HandoffOutcome }       // 开新会话
  | { kind: 'end';   key: string; reason: string }                // 只表示"没有下一步"

interface DeskPlan { readonly actions: readonly DeskAction[]; readonly consumedKeys: readonly string[] }
```

与现状的对应：`say@surface` = `session.append('user/message', …, {surfaceOp:'append'})`；`say@steer` = `agent.steer(...)`；`carry` = `states.carryTo(...)`；`delegate`/`relay` = `HandoffRuntime` 的两个入口。**`at` 必须显式**——现在"说给模型听的下一轮"（steer 进 inbox）与"留在会话里的记录"（append 进 surface）在代码里只差一个方法名，是最容易写错的一处（`notice.ts:105` 就专门解释了 steer 的读者是模型）。

### 4.4 一次性 key 的规则

- **形状**：`<kind>:<subject>[@<scope>]`，`kind ∈ {condition, capability, breaker, skip, failover, truncation, nudge, relay, …}`，`subject` = `routeKeyOf(...)` / 角色 id / 动作名。
- **谁产出**：裁决（因为"要不要说"和"叫什么名字"是同一个判断）。**谁写入**：L0，且**只在副作用成功之后同一同步块内**（`index.ts:458` 现成的写法）。
- **作用域**：绝大多数是 `turn`（`states.recordTurnNoticeKeys`，`:458`）；跨轮一次的是例外，要显式起名（gh Actions 的 `concurrency` 组就是这个语义）。
- **迁移硬约束**：抽 key 时**键字符串必须逐字不变**（`condition:`/`capability:`/`breaker:` 现有字面量见 `skip-plan.ts:111/118/125`）。改形状 = 一次性语义变化 = 静默多说话或漏说话，`unit` 里"跳过集合变大只报新增"那条用例会红（`feature-review` 4.12 的断言）。

### 4.5 四条不变量与守卫

| 不变量 | 含义 | 守卫方式 |
|---|---|---|
| I1 纯 | 同一 `facts` + 同一 `said` ⇒ 同一 `plan` | 源级：`decisions/` 下禁止 import `ctx`/`node:timers`/`Date`；照 `client-controller.mjs` 的源级守卫写法 |
| I2 一次 | 同一 key 一个 turn 内最多一个动作 | 单元：两次调用传第一次的 `consumedKeys`（`skip-plan.ts:92-96` 已证明这种测法可行） |
| I3 分离 | 裁决不 append、不 steer、不 `await next()` | 类型：`DeskPlan` 只有数据；执行在 L0 唯一函数 |
| I4 文案外置 | 改措辞不改裁决 | 现状已满足（`skip-plan.ts:40-43`），抽层时保持 |

## 五、"加一个旋钮要改哪几处"

以最近一个已落地的旋钮 `handoff.delegateDefaults` 为实测样本（`grep delegateDefaults` 命中 6 个源文件）：

| # | 文件 | 职责（不变量） | 漏掉的后果 |
|---|---|---|---|
| 1 | `src/defaults.ts` | 数值默认值与上下界（`DEFAULT_*`/`MAX_*`） | 两个半包各抄一份数字 → 漂移（review 3.2） |
| 2 | `src/config.ts` `:372` + `:637` | schema 字段 + `.description()`（**两个半包同源**）+ 值类型 | 界面能配、host 不认，或反之 |
| 3 | `src/rules.ts` `:152-160` | 跨字段规则（半条路由不是路由） | 保存出一个不可达状态，代码去模拟它 → 两套真相 |
| 4 | `src/client/validate.ts` `:214` | 浏览器归一化/钳位/默认（草稿形状） | 显示值与磁盘值不同；保存被 host 拒而 UI 说成功 |
| 5 | `src/client/roster.ts` `:312-344` | 控件 | 配置存在但没人能改 |
| 6 | `src/client/locales.ts` | 中英两份字典键（label + hint） | 英文用户看到中文，或键悬空（`feature-review` 5.4 的守卫专抓这个） |
| 7 | **读者**：`handoff-tool.ts:758`（本例） | 执行该字段的那一处 | **死配置**：schema 与 UI 都能走，没人读（review 4.5/4.8 删字段的原因） |
| 8 | 若进 durable/投影：`src/handoff-wire.ts` / 新投影 | 键带命名空间、`stateVersion` 只增、state plain JSON | 重启后计数回放不一致 |
| 9 | 测试：`tests/unit.mjs`（纯函数/字段）；`tests/client-controller.mjs`（草稿/钳位）；`tests/run.mjs`（改请求路径时） | 断言 | 无断言的新字段下次审查必被重新发现 |

**若旋钮属于"何时说话"**：第 7 项从"某个 handler 里的一处 if"变成 **policy 表的一行 + 一条 key 命名规则**——这是抽 policy 层唯一的现实收益：第 7 项不再随规则数量扩散到 `index.ts`，也就不再需要"复制成第 5、6 处"。

**为什么这样划分**：一条字段有四类真理——形状（schema）、数字（defaults）、组合约束（rules）、呈现（validate/locales/控件）。现有的每一处"第二真相源"事故都发生在其中一类被复制的时候（`rules.ts:1-18` 的注释就是一次实测记录）。所以清单不是"要改的文件"，是"这四类真理各自的住所"。

## 六、不该做（逐条给理由）

1. **不引入执行引擎 / 调度器**（Temporal、LangGraph 式）。DSH 已有一个 `while (true)` 的 step 循环且**没有 attempt 上限**（`tools.md:47`）——再放一个执行器就是两个循环争谁"结束这一步"。我们只需记账（预算在 `RouterState`）与在接缝上说一句。
2. **不做 durable 化到需要 replay**。一旦我们的状态是"重放出来的"，就要满足 Temporal 那条 [Replay 必须与历史吻合](https://docs.temporal.io/workflow-execution) 的约束，并处理语义迁移；而现有能力边界已经明确 durable lineage 只能靠**插件自有 projection 折叠核心事件**（`source-map.md` 第 41-43 行、`session/index.ts:806` 只收 `SessionEventMap`）。
3. **不自定义 DSL（用户可写 `if`/`when`）**。Argo 与 GitHub Actions 都证明表达式语言会生长（专属求值器、转义例外、参数含引号的二次语法）。我们的用户是在三档控件里勾选的人，不是写 YAML 的人；代价是求值器 + 保存期校验 + 中英文案 + "写坏了"支持面。
4. **不把 handoff 段做成项目编排器**（DAG / 任务依赖 / 分派计划）。名册已有 `role`/`purpose`/`instructions`/闸门，再加任务图就与 `goal`/`todos` 投影抢所有权，产生"任务状态两个来源"（review 5.1 的教训即此类）。
5. **不引入状态机框架**（xstate 之类）。我们的状态是 `(turn, step)` 内的小整数 + 链位置，`router.ts` 的决策表已经表达；而同一步内既有内层重试、又有 compaction 先接手的路径（`CONTEXT_WINDOW_EXCEEDED`/`IMAGE_OFFLOAD_REQUIRED` 永远先问内层，见[决策登记簿](open-questions.md) 一.5），`llm-retry` 的额度又按 `step/start` 清零（`tools.md:125`）——状态机会强迫我们声明一张假的完备转移表。
6. **不做"用户可注册规则"的通用 hook 引擎**。通用引擎的价值在多主题；我们只有一个主题（渠道 + 委派）。而它的核心难点正是上游要废止的东西：listener 顺序（`open-questions.md` 十二.3、`tools.md:44`）。
7. **不新增 durable 事件类型 / plugin record**。仓库外实际封闭（`tools.md:48`）。所有"新事实"只能走 projection 折叠或内存账本。
8. **不让 policy 层读 `ctx` 或 `Date.now()`**。这不是风格：C2 那类 bug（判决时机错导致多打一次真实调用）只有在"输入显式、时间显式"时才可测。
9. **不新增接缝**。ESLint/webpack/Rollup 的共同结论是扩展面必须是**时刻**；我们只有 5 个时刻，够了。需要新能力时先问"这是新时刻还是新条件"——新条件进 policy 表。

## 七、迁移顺序、判据、风险与回滚

总原则：**每步一个可 revert 的提交，行为不变优先于结构漂亮**；五套件（unit / client-controller / remote / handoff-relay / run）在每步结束时全绿是唯一"没坏"的证据。

| 步骤 | 抽什么 | 判据（谁的断言） | 风险 | 回滚 |
|---|---|---|---|---|
| **S0**（本页） | 只出文档 | 你拍板 | 文档与实现漂移 | 删文件 |
| **S1** | `src/decisions/keys.ts`：一次性键的唯一构造（`noticeKey(kind, subject, scope)`），把 `condition:`/`capability:`/`breaker:` 改成调用它，**键字面量逐字不变** | unit「同轮两次调用、第二次集合变大只报新增」（`feature-review` 4.12 断言）；run 37 场景 | 键形状微变 → 静默多/少一次 durable 消息 | 单 commit revert；键是对外语义，不接受"新旧并存" |
| **S2** | `src/decisions/speak.ts`：**先只搬 3 个 `steer`**（`index.ts:631`/`:648`/`:747`）+ nudge 的 `nudges` 账本，变成 `planSpeech(facts)`；`index.ts` 只 `steer`/`append` | unit：截断续跑次数、nudge 每轮一次；`handoff-relay` 19 项 | `agent/turn-stopping` 的时序（先于 `turn/end`，`index.ts:611-613`）与 `signal.aborted` 分支搬错 | 切换提交与新增函数**分开**：新增纯函数先落地（无读者，死代码由 CI 阶段短），下一次提交才切换调用点；revert 后者即回旧 |
| **S3** | 同文件扩到 `surface` 类：`index.ts:323`/`:478`/`:494`/`:756`/`:766` 进 policy 表（`:456` 已是解释器样板） | unit：绑定缺失文案、截断换候选文案、未交回收工文案；run 场景 `first-hop-skip-is-not-announced…` | 这些 notice 与 `planFire` 的落点耦合（`:474-507` 依赖"落点确定后才发"），搬错会说假话 | 同上；每条 notice 拆一个提交（5 条 = 5 次可独立回滚） |
| **S4** | `src/decisions/act.ts`：派人/换场（`onUnreceiptedStop.delegateTo`、`onFinish`、`delegateOnStop`）变成 actions | unit：闸门四态（review 4.9）、`report` 三处（4.10）；`handoff-relay`：`newSession` 端到端 | fire-and-forget 与 abort（`index.ts:752` 的 `void …catch`）；`signal` 传递 | 交接段整段独立成文件后再改；revert 只影响交接（`handoff.enabled` 默认关，风险面小） |
| **S5** | 拆文件：`apply-routing.ts` / `apply-handoff.ts` / `remote.ts`，`index.ts` 只留注册与接线（目标 ≤200 行） | 纯搬运，五套件全绿即等价；`tests/remote.mjs:221-227` 枚举全部 7 个 `oncallHealth/*` 方法，搬漏一个即红 | fiber 归属（`ctx.inject` 子 fiber、`dispose` 清理 `probeTimerId`/`holdBusy`）、`this.` 状态搬迁遗漏；**热更新会整体重启 fiber**（`tools.md:63`） | 纯文件移动 + re-export，revert 无行为差异；建议单独一个 commit，不参任何逻辑改动 |
| **S6**（建议最后做或不做） | `src/modes.ts`：模式 = **已有字段的一组值**的具名派生（`resolveMode(config)` 只读），UI 提供"一键设成某组合"，保存后就是普通字段 | cc：设模式 → 草稿变为那组值；再手改任一字段 → 显示"自定义" | 若把模式做成"持续约束"就成第三真相源：用户改字段会被模式覆盖 | 删 `modes.ts` 与 UI 入口即回；**不要**在 schema 里加 `mode` 字段，除非先证明它不能被现有字段表达 |

**S6 的判据（先证明再写）**：任何模式都必须满足"存在一组现有字段值，与它逐字段等价"。满足不了，说明它引入的是新语义而不是组合——那就该单独立项，而不是塞进模式列表。参考 CrewAI 把编排做成**独立对象**（[Flows](https://docs.crewai.com/en/concepts/flows)）而不是给 Crew 加一个 `mode` 字段；以及 Agents SDK 用 `is_enabled` **函数**表达"这次能不能交接"（[Handoffs](https://openai.github.io/openai-agents-python/handoffs/)）——组合关系是谓词/对象，不是枚举。

## 八、待拍板

| # | 问题 | 建议 | 影响 |
|---|---|---|---|
| 1 | 是否接受"policy 层只许 L0 说话、L2 不读 ctx/Date"这两条硬约束 | 接受 | 决定 S2/S3 能不能用源级守卫，而不是靠人记 |
| 2 | S2 先搬的 3 个 `steer` 是否包含 `nudges` 账本（它现在在 `this.nudges`，是实例字段而非 `states` ） | 一起搬，账本收进 L1 | 决定 policy 输入能否只靠 `facts`（否则要传一个可变账本） |
| 3 | 一次性 key 是否扩到"每会话一次"的作用域 | 暂不扩，先只做 `turn` | 现有 4 类 key 都是 turn 级；扩作用域要先有一个真实诉求 |
| 4 | 模式层（S6）现在做还是等 4 个真实诉求 | 等；先只做 `resolveMode` 的只读显示 | 早做会把"组合"变成"新语义" |
| 5 | `docs/design/open-questions.md` 是否新开一节登记本节五项 | 建议同批登记（本页是提案，登记簿是裁定） | 不登记，下次审查会重复发现同一批问题 |
