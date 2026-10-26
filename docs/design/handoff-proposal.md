---
title: "DSH Model Desk — 遗留任务交接（handoff）"
status: "proposal"
kind: "design"
last_updated: "2026-10-23"
---

# 遗留任务交接（handoff）

## 摘要

**这不是判断器，是委派基础设施。** 插件不判断任务做没做完——那件事在 DSH 里没有真值，任何"判据表"最后都会退化成
枚举加关键词。插件只做四件机器能做的事：给模型一张**用户预设的名册**、一个**派人 / 收工 / 开新会话 / 看事实**的工具、按名册
**自动备料**（会话事实，不是模型自述）、以及**在原生唤醒之上不添乱**。

模型的判断权一条不少：什么时候派、派谁、派去干什么、复核结论算不算过、要不要开新会话重来，全由模型决定。
用户配置的是**菜单和闸门**，不是 `if`。

路由与交接是**正交**的两件事：只开路由、只开交接、两个都开都成立；两个都开时，子会话同样吃重试、熔断与自动切换（§4.5）。

唯一一处插件必须主动发言的地方是"**会话要安静下来的那一瞬间**"：模型觉得自己做完了、直接停、连收工都没签字。
那里用"收工回执 + 追问一次 + 用户指定的兜底"三层接住（§7），判断内容仍然不在插件手里。

## 一、五条诉求落在哪

| 用户要的 | 由谁回答 | 落在本文 |
|---|---|---|
| 1. 跑到一半就停，人不在就断在那里 | 模型签字 + 用户配的兜底 | §4.4、§7-B |
| 2. 指定子智能体的渠道 / 模型 / 人格 | 用户（名册） | §4.1、§5 |
| 3. 在某个节点派它去干某件事 | 模型（调工具） | §4.2、§6 |
| 4. 压缩多次后开新会话重跑，主模型不变、熔断照旧 | 模型发起 + 插件执行 | §4.6、§7-C |
| 5. 各种情况用配置表达，不要插件猜 | 名册 + 闸门 + 指令文本 | §5、§8 |

## 二、判断权归属

| 问题 | 谁回答 | 凭什么 |
|---|---|---|
| 现在该不该派人 | 主模型 | 它读得到上下文，也读得到工具描述里的名册 |
| 派谁 | 主模型 | 名册里每条的 `purpose` |
| 派去干什么 | 主模型 | `task` 字段 |
| 给它看什么料 | **插件** | 会话事实：goal / todos / 统计 / 原始诉求 |
| 它做完算不算过 | 复核者 | 工件 + 结构化结论 |
| 有缺口要不要继续 | 主模型（门在 `finish`） | 有缺口时 `finish{done}` 被拒：只能修完再复核，或交人；预算见 §8 |
| 这一轮是不是收工了 | 主模型（签 `finish`） | 回执是它自己写的 |
| 没签字就停了怎么办 | 用户（闸门） | `nudgeWhenUnreceipted` / `delegateTo` |
| 该不该开新会话 | 主模型 | 它调 `newSession`，并说明理由 |

**唯一的边界**：插件只碰"能被机器数出来或从日志折叠出来的事实"，以及"协议是否被遵守"。它不读模型话里的意思。

**互补的分工**：代码负责模型做不了的——计数、封顶、时序、原生机制（建会话、唤醒、路由）；模型负责代码做不了的——
缺口算不算数、还要不要再看一遍、下一步做什么、在哪儿做。代码一旦开始判断内容，就把模型降级成执行器；
模型一旦负责记账，就会忘记、会刷、会自己给自己放行。

**方向判据**（以后新增任何能力，先过这三问）：

1. 这件事是在**给模型选项**，还是在**替模型做选择**？后者会写成 `if` / 谓词表，不做。
2. 送进判断的输入是**事实**（日志折叠、配置、模型自己写的结构化声明），还是**推断**（文本语义、任务类型猜测）？后者不做。
3. 用户配的是**菜单与闸门**，还是**分支与状态**？后者不做。

三问都答"前者"，方向就没跑偏；任何一问答"后者"，先想能不能改写成工具契约或工具描述，再谈实现。

**约束分级见 §十三**：A 类是硬约束（动了就是换方案），B 类是形态（实施时按更简单的来），C 类是假设与退路。

## 三、DSH 原生给了什么（已核实）

| 能力 | 事实 | 出处 |
|---|---|---|
| 注册工具 | `ctx.tools.register(defineTool({…}))`，返回 disposer；重名直接抛 | [`schema.ts:554`](file:///D:/sudy/github/deepseek-harness/packages/core/tools/src/schema.ts) |
| 工具知道谁在调 | `ToolExecutionInput.agent?: Agent`（agent loop 填入） | [`index.ts:340`](file:///D:/sudy/github/deepseek-harness/packages/core/tools/src/index.ts) |
| 工具可以让回合当场结束 | 结果带 `concludesTurn: true` 时在该 step 结束回合（本设计**不用**，见 §10） | [同上 `:582`](file:///D:/sudy/github/deepseek-harness/packages/core/tools/src/index.ts) |
| 回合末拦截 | `agent/turn-stopping`（serial）：listener 反对就 `agent.steer(...)`，机器重读 inbox 再跑一步 | [`runtime-types.ts:364-381`](file:///D:/sudy/github/deepseek-harness/packages/core/agent/src/runtime-types.ts) |
| 往会话里塞消息 | `agent.followup(msg)` / `agent.steer(msg)` / `agent.inject(msg)` | [同上 `:222`、`:231`、`:241`](file:///D:/sudy/github/deepseek-harness/packages/core/agent/src/runtime-types.ts) |
| 子智能体默认模型 | `AgentOptions { provider, model, reasoningEffort, maxTokens }` | [同上 `:26-35`](file:///D:/sudy/github/deepseek-harness/packages/core/agent/src/runtime-types.ts) |
| 程序化派子智能体 | **`ctx.subagents.startActivation(spec)`**，`spec = {provider, label, request, signal, delivery}` | [`subagent/src/index.ts:269-284`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/index.ts)、[`types.ts:31-44`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/types.ts) |
| 派发请求 | `{cwd?, agentPreset?, label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?}` | [`types.ts:136-183`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/types.ts) |
| 结构化结论 | `outputSchema` + `SubagentResult.structured` | [`types.ts:252-278`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/types.ts) |
| 子会话身份 | `activation.childId: SessionId`；子会话 header 带 `parentSession`、`origin:'subagent'`、`delegationDepth = 父+1` | [`types.ts:47-59`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/types.ts)、[`child-agent.ts:146-152`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/child-agent.ts)、[`session/types.ts:95-132`](file:///D:/sudy/github/deepseek-harness/packages/core/session/src/types.ts)、[`session/index.ts:540`](file:///D:/sudy/github/deepseek-harness/packages/core/session/src/index.ts) |
| **原生唤醒** | `delivery:'parent'` 时结算**自动通知父会话**：父 idle 走 `followup`、running 走 `steer`；**`delivery:'caller'` 不通知**（`manager.ts:1188` 直接 return） | [`manager.ts:1186-1206`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/manager.ts) |
| 结算消息内容 | 摘要 + 子会话收尾正文 + `Structured result: <json>` + `diagnostic`，`source.kind = 'subagent-settled'`、带 `senderSessionId` | [`continuation-messages.ts:138-168`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/continuation-messages.ts) |
| 能力门槛 | 请求 `agentOptions` / `agentPreset` / `outputSchema` 时，provider 必须声明对应 capability，否则 start 直接拒 | [`index.ts:630-646`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/index.ts) |
| 目标 | `ctx.goals.get(agent)` / `clear` / `create` / `complete`；resume/fork 后 active goal 是 **disarmed** | [`goal/src/index.ts:276-277`、`:390-391`、`:432-433`、`:646`](file:///D:/sudy/github/deepseek-harness/packages/goal/goal/src/index.ts)、[`tool-goal/src/index.ts:117-119`](file:///D:/sudy/github/deepseek-harness/packages/goal/tool-goal/src/index.ts) |
| todo 投影 | `todos` 投影键，值为 `TodoItem[] \| null`（`pending/in_progress/completed`） | [`tool-todo/src/types.ts:35-45`](file:///D:/sudy/github/deepseek-harness/packages/todo/tool-todo/src/types.ts)、[`index.ts:123-132`](file:///D:/sudy/github/deepseek-harness/packages/todo/tool-todo/src/index.ts) |
| 建新会话 | `ctx.agents.createSession({sessionId?, cwd, agentPreset?})`，**不接受模型选择** | [`agent.ts:278-282`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/agent.ts) |
| 会话级选模型 | `selectionFor(agent).current` 读、`selectForNextRequest(agent, sel)` 写（追加 durable `model/selection`） | [同上 `:289-332`、`:339-342`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/agent.ts) |
| 可数事实 | `tool/call{name,arguments}`、`turn/end`、`compaction/start`·`compaction/summary`·`compaction/end`、`request/header` | [`session/types.ts:289,298,362`](file:///D:/sudy/github/deepseek-harness/packages/core/session/src/types.ts)、[`compaction-basic/src/region.ts:210-245`](file:///D:/sudy/github/deepseek-harness/packages/compaction/compaction-basic/src/region.ts) |
| 子智能体 provider 名 | `ctx.subagents.listProviders()`（常见 `spawn` / `fork`） | [`subagent/src/index.ts:578-582`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/index.ts) |

> 派发与唤醒的准确口径：公开方法是 `startActivation(spec)` 且必须给 `provider`；`delivery:'caller'` 只把结果还给
> 调用方，父会话不会被叫醒（`manager.ts:1188`）——要原生唤醒就用 `'parent'`。

## 四、形态

### 4.1 名册（用户配，模型选）

每个 roster 项是一张"工牌"：稳定 id、给**主模型**看的一句话 `purpose`（选人依据）、给**子智能体**看的
`instructions`（岗位规范与注意事项）、可选的 DSH Agent Preset（系统层人格 + 工具集）、物理路由（`provider`/`model`，
可选 `reasoningEffort`/`maxTokens`）、备料清单、可选的结构化输出、角色（`review` / `work`）、以及自最近一条用户消息
以来最多被派几次。

三个文本字段、三个读者，不许混：

| 字段 | 谁读 | 作用 | 不是什么 |
|---|---|---|---|
| `purpose` | 主模型 | 选人依据，编进工具描述 | 不进子会话 |
| `instructions` | 子智能体 | 每次派活时随任务一起给的岗位规范 | 不是系统提示，优先级是用户消息级 |
| `preset` | 子智能体 | 真正的系统层人格 + 工具集（DSH 原生组合） | 不由本插件编写 |

`preset` 与 `instructions` **至少一个非空**：两个都空，这个角色就退化成"随便一个子智能体，只知道这次任务"，
保存期直接拒绝。

`instructions` 怎么写：**轻量 Markdown 或纯文本都行**——插件不解析，原样拼进派发消息。建议固定四段
（职责 / 必须遵守 / 禁止 / 输出格式），每条一行，不用表格和代码块；总长 4000 字符以内（超了保存期拒绝）。
它随**每一次**派发重复进入子会话，写长就是每次都多付一遍 token；也**不要写密钥**，它每次都进模型上下文。

- **名册是唯一的"谁可以被派"来源。** 模型不能现场拼 `agentOptions`，也不能派名册外的人。
- 原生的 `subagent` 工具**不动**：想自由发挥的用户照旧用它；名册只解决"指定机构、指定人格、指定备料"。
- `purpose` 决定模型选谁。它不是给用户看的说明，是**给模型看的招聘启事**，所以要求写清楚"适合什么、不适合什么"。
  `purpose` 必填：空白的工牌只能让模型凭名字猜人，保存期直接拒绝。

### 4.2 一个工具，四个动作

模型对外的输出只有两种：**文本**，和**工具调用**。要让"它自己决定派谁"，就必须有一个它**能调用的东西**——这就是工具。
hook（插件监听事件）是插件侧的代码，它没有"问模型一句"的能力：要么自己判断（我们不要），要么往会话里塞一条消息
（那是追问，不是选择）。

所以分工是：**选择用工具**（模型调 `handoff`），**兜底用 hook**（`turn-stopping` 里发现没签字，追问一次）。

先把三个东西分开——它们的读者不同，混在一起一定会乱：

| 东西 | 是什么 | 谁读它 | 不承担什么 |
|---|---|---|---|
| `handoff` 工具 | 真正被调用的工具：名字、参数 schema、`execute` | **主模型调用**，插件执行 | 不是子智能体的定义 |
| 工具的 `description` | 一段由配置**编译**出来的文字，随工具列表每轮进上下文 | **主模型每轮读** | 不发给子智能体 |
| `roster[]` | 用户在配置里写的角色条目 | 插件（编译描述、组装派发请求） | 不是 DSH 的概念，是插件的配置 |

编译关系只有一条：

```
roster[] ──编译──┬─→ handoff.description（有谁可派 + 每条 purpose + 收工规则 + facts 口径）
                 └─→ 派发请求（agentPreset + agentOptions + instructions + prompt + outputSchema）
```

由此三条语义规则，实现时不许混：

1. **子智能体的角色来自 `preset`（系统层人格 + 工具）与 `instructions`（每次随任务给的规范）**，不是由工具描述决定。
2. **工具描述只负责告诉主模型"有谁、什么时候用、收工要做什么"**；它不构成子智能体的任何定义。
3. **一个字段只有一个读者**：`purpose` 只进主模型的菜单；`instructions` 与 `preset` 只给子智能体；谁也不复用对方的话。

配置变更会重启插件 fiber，工具描述随之重新生成（先 dispose 再 register），所以不存在"描述与名册不一致"的窗口。

动作：

- `delegate{rosterId, task, focusPaths?}` → 派名册里的人，立刻返回回执，**不阻塞回合**。
- `finish{outcome, report, handoffNote?, reviewId?, reviewOverride?}` → 收工回执：`done` / `needs_user`（要人拍板）/ `abandoned`（放弃）。
- `newSession{reason, handoffNote}` → 按配置开新会话接力。
- `facts{}` → 返回可数事实（压缩次数、轮次、工具失败数、goal、todos、已派次数），给模型决策用。

工具注册在插件自己的 ctx 上（注册表层面全局可见，具体 agent 还受 preset 的 `toolFilter` 影响），**按会话过滤放在
handler 里**：非顶层会话调用直接返回错误。不做"同一工具名在不同会话里时隐时现"的动态注册——工具列表每轮都进上下文，
隐身会让模型的行为随会话身份漂移。

工具的 `description` 就是策略的落点：模型每轮都读得到，不需要往 system prompt 里插话。

### 4.3 备料：给工件，不给自述

`delegate` 的载荷由插件组装，模型只提供 `rosterId` 和 `task`。`attach` 的封闭词表：

| 项 | 内容 | 来源 |
|---|---|---|
| `goal` | objective / phase / 已用轮次 | `ctx.goals.get(agent)` |
| `todos` | 未完成与进行中的条目原文 | `todos` 投影 |
| `userRequest` | 本会话最近一条用户原话 | `user/message`（`source.kind === 'user'`） |
| `stats` | 压缩次数、轮次、工具失败数、已派名单 | `session/event` 折叠 |
| `notes` | 模型在 `task` 里写的说明 | 工具参数 |

开新会话的简报另有一项 `lastReview`：最近一条 `subagent-settled` 的正文与结构化结论。它只用于接力，不参与 `delegate`。

派发请求的 prompt 顺序固定：`instructions`（若有）→ `task` → `attach` 采到的事实。规范在前、任务居中、工件在后——
子智能体先知道自己该怎么干，再看这次要干什么。

**不给**主模型的总结、自述、结论——复核者一旦拿到这些，只会复述它。文件内容、diff、测试输出由复核者**自己的
工具**去读去跑（那是它的 preset 的事），插件不代劳、也不假装代劳。

### 4.4 收工：三个落点，两个维度

"结束了是开新会话、派子智能体、还是真结束"——这不是三选一，因为它把三个问题混成了一个：

| 问题 | 取值 | 谁答 |
|---|---|---|
| 还要不要有下一步 | 要 / 不要 | 模型（`finish` 三选一，或者干脆继续干） |
| 下一步在哪个场地 | 本会话 / 新会话 | 模型（调不调 `newSession`） |
| 下一步谁来做 | 主会话 / 派的子会话 | 模型（调不调 `delegate`） |

`finish` 的三种落点属于第一个问题：

- `done` —— 我干完了（可带 `handoffNote`，给新会话用）
- `needs_user` —— 需要人拍板（带 `report`）
- `abandoned` —— 放弃（带理由）

**复核不是落点，是动作。** 它可以在任何场地、由任何执行者做；它产出"通过 / 有缺口"，这两个值决定能不能 `done`。

收工的门，按顺序判，全部写在工具返回值里：

1. 有 active goal 时 `done` 被拒——完成只由 goal 说了算。
2. `requireReviewFor` 命中时，这次收工必须引用一次 `role: review` 角色的复核回执，**复核发生在最近一条用户消息之后**，
   且**最近一次结论是通过**；没复核、或最近一次是缺口，都拒；拒绝文案里列出缺口原文。
3. `allowReviewOverride` 时模型可以写明理由跳过；理由进账，UI 可见。
4. 不用 `concludesTurn`——它会当场结束回合，模型来不及写收尾消息。

**结论从哪来，不需要解析自然语言**：复核者由插件自己起，`activation.result` 里有 `structured`（按 roster 的
`outputSchema` 产出）；插件把它记进复核账本（storageDomain，无 storage 时内存 + 可见 notice）。`finish` 只查账本。

### 4.5 合流：子会话同样吃重试、熔断、切换

路由与交接是**两个正交的功能**，各自能单独用，合起来才是完整形态：

| 开关组合 | 行为 |
|---|---|
| 只开路由（`handoff.enabled: false`） | 与今天完全一致：没有名册、没有 `handoff` 工具 |
| 只开交接（路由总闸关，或 `chain` 为空） | 子会话用名册钉死的 route；失败如实报错返回，不静默改道 |
| 两个都开 | 子会话第一跳 = 名册钉死的 route，失败后按**它绑定的链**重试、熔断、切换 |

**不变量（一条，对所有会话成立）**：第一跳 = 这条请求自己声明的模型——顶层会话是用户当前选中的，子会话是名册钉死的
（或继承父会话的）；失败之后切不切、切到哪，看**这个会话绑定的链**。没有"子会话特殊处理"这个分支。

链的归属按顺序解析，唯一解析点：

1. 会话自己的绑定（`sessionId` 侧车，见[按会话选择降级链](per-session-chains.md)）
2. 没有 → `session.header.parentSession` 的绑定——子会话天然带这一格（[`child-agent.ts:146-152`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/child-agent.ts) 写入 `parentSession` / `origin` / `delegationDepth`）
3. 没有 → `defaultChainId`
4. 名册的 `failover` 可覆盖：`inherit`（默认）/ `none` / `<chainId>`

**熔断状态是全局的，所以"相辅相成"是真实发生的**：子会话在某条渠道上踩坏的，主会话下一轮会跳过；主会话的冷却，
子会话也躲开。这既不是共享一个计数器，也不是各记一份——渠道事实本来就只有一个。

**钉死 route 与链的关系**：第一跳已在链上时，从它在链上的位置之后开始降级；不在链上时，从候选首位开始。
两条路都不改第一跳。

### 4.6 开新会话：接力，不是重启插件

**模型开不了会话**——它能做的只有说话和调工具；`ctx.agents.createSession` 是宿主服务，只有插件代码能调。
所以形态是**模型给指令、插件代劳**，入口两条，执行的是同一个函数：

| 入口 | 什么时候 | 谁决定 |
|---|---|---|
| 工具 `handoff{action:'newSession', reason, handoffNote}` | 模型觉得这个会话跑偏了 / 该换场了，随时可调 | 模型 |
| 收工后的自动接力（`newSession.onFinish`） | 模型刚写完 `finish{outcome}` 回执 | 用户配置的 outcome 列表 |

自动那条**不是判断任务完成**，而是对一份刚写完的回执做固定后续——触发点是模型自己写下的声明，不是插件采样出来的状态。

**新会话的第一条消息由两半拼成**：配置定的"下一步类型" + 模型写的 `handoffNote`（具体做什么），再附上工件：

```
【接力】上一会话收工：done / needs_user / abandoned，附 report
【下一步】<配置的 nextAction>：continue（接着干）/ review（先复核）/ review-then-continue（复核完再接着干）
【交接说明】<模型写的 handoffNote：从哪继续、哪些别重做、先看什么>
【工件】goal / todos / 最近一次复核结论 / stats
```

首条消息用**普通用户消息**（`source.kind: 'user'`），正文第一行写明"由插件按接力配置生成"——新会话必须把它当任务执行，
notice 形式会让模型只当背景。代价是 UI 上它看起来像用户打的字，用第一行说明来补。

执行步骤：

1. 读旧会话的选择（`selectionFor(agent).current`，回退最后一条 `request/header`）。
2. `createSession({cwd})` 建**顶层**会话（不是子智能体），拿到 agent。
3. `carrySelection` 为真时 `selectForNextRequest(newAgent, selection)` → 首跳就是主模型，durable 落 `model/selection`。
4. `carryChainBinding` 为真时，把旧会话的链绑定**与预算计数**写到新会话 id 下（会话侧车）；熔断状态本来就是全局的，自动照旧。
5. 按上面的模板拼首条消息，`followup` 进新会话。
6. `keepGoal` 为真时，用原 objective 在新会话 `create` 一个 goal（失败则把目标写进简报，由模型用 goal 工具重建）。
7. 旧会话：active goal 用 `ctx.goals.clear(agent, ref)` 作废；记一条中文 notice 指向新会话；不自动归档。

**闸门**：`limits.maxNewSessionsPerUserMessage`（默认 2）**随会话复制、不因开新会话而重置**，防止"每次收工都开一个新会话"滚成爆炸。
`onFinish` 非空时，`finish` 必须带 `handoffNote`——否则新会话拿到的只有工件、没有"下一步"，接力等于把问题原样搬过去。
这条也写进工具描述，模型不必靠试错发现。

## 五、配置 schema（参考形状，不是验收标准）

下面是字段的**参考粒度**：名字、分组、能不能合并，实施时可以改；不能改的是 §13-A 的硬约束。
（草案，尚未进 `schema.ts`。）

```yaml
handoff:
  enabled: false                  # 总闸；关时零注册（工具都不出现）

  subagentBackend: spawn          # 派发后端（DSH subagent provider 名），不是模型渠道

  roster:
    - id: reviewer
      name: 复核
      role: review                # review | work
      purpose: "独立复核：判断目标是否真的达成，列出缺口。"  # 编进工具描述，只给主模型看
      instructions: |             # 轻量 Markdown，≤4000 字符；只给子智能体，随每次派发注入任务前面
        你只读工件，不改文件。发现问题逐条列出，标明文件与行号。
        不要复述主会话的结论；没有证据就写"未验证"。
      preset: reviewer            # 可选：DSH Agent Preset（系统层人格 + 工具集，只给它自己用）
      provider: acme-gw           # 模型渠道，与路由链同一标识空间
      model: reviewer-model
      reasoningEffort: high       # 可选
      maxTokens: 32000            # 可选
      failover: inherit           # inherit | none | <chainId>：失败后跟哪条链走
      attach: [goal, todos, userRequest, stats]   # 派发时附上的会话事实
      outputSchema:               # 可选：结构化结论（需要 provider 支持 outputSchema）
        verdict: done | gaps
        gaps: [string]
        recommend: continue | newSession | done
      maxRunsPerUserMessage: 6    # 本角色自最近一条用户消息以来的上限

  protocol:
    delegate: true
    finish: true
    facts: true
    requireReviewFor: []          # done | needs_user | abandoned 的子集；严格模式写 [done]
    allowReviewOverride: true

  limits:                         # 这里每个数字都是"最多"，不是"必须"
    maxDelegationsPerTurn: 1      # 一个回合内最多派几次（防同轮爆发）
    maxDelegationsPerUserMessage: 8   # 自最近一条用户消息以来；复核也计入
    maxReviewsPerUserMessage: 1   # 复核上限：第一次就通过就收工
    maxNewSessionsPerUserMessage: 2  # 开新会话上限
    maxDelegationsPerDay: 24      # 进程内计数，重启归零
    nudgeWhenUnreceipted: false   # 没交回执就停时追问一次（默认关：会触发真实调用）
    maxNudgesPerTurn: 1           # 每回合最多追问几次

  onUnreceiptedStop:
    delegateTo: ""                # 空 = 只报告；填 roster id = 自动派它兜底
    reportToUser: true

  newSession:
    onFinish: []                  # finish 的哪些 outcome 之后自动开新会话；空 = 不自动
    nextAction: continue          # continue | review | review-then-continue
    briefing: [goal, todos, userRequest, lastReview, stats]
    keepGoal: true                # 新会话里按原 objective 重建 goal
    carrySelection: true          # 主模型不变
    carryChainBinding: true       # 链绑定与预算计数跟过去
```

字段的存在理由只有三类：**决定菜单**（roster）、**决定协议**（protocol）、**决定闸门**（limits / onUnreceiptedStop / newSession）。
没有任何字段用来描述"任务状态"。

## 六、工具契约（参考形状）

参数名与拒绝文案在实现时可以改；四个动作的**职责划分**（派人 / 签字 / 开新会话 / 看事实）与"拒绝写在返回值里"不变。

| 动作 | 参数 | 成功返回 | 拒绝条件 |
|---|---|---|---|
| `delegate` | `rosterId`、`task`（string）、`focusPaths?`（文件路径数组） | 回执：`{child:<SessionId>, rosterId, attached:[…]}` | 名册无此项 / 该角色 `maxRunsPerUserMessage` 用尽 / 本回合或本区间超限 / 后端不支持所需 capability |
| `finish` | `outcome`（`done` / `needs_user` / `abandoned`）、`report`、`handoffNote?`、`reviewId?`、`reviewOverride?` | `{recorded:true, outcome, newSessionId?}` | 有 active goal 却报 `done` / 自最近一条用户消息以来未复核或最近一次不是通过且未 `reviewOverride` / `onFinish` 非空却没写 `handoffNote` / 工具未启用 |
| `newSession` | `reason`、`handoffNote` | `{newSession:<SessionId>}` | 超限 / 建会话失败 / `handoffNote` 为空 |
| `facts` | — | 可数事实的 JSON | 工具未启用 |

## 七、时序

### A. 派人 → 复核 → 继续或收工

```
turn 内
  ├─ 主模型调用 handoff{action:'delegate', rosterId:'reviewer', task:'…'}
  ├─ 插件：查名册/闸门 → 采集 attach → ctx.subagents.startActivation({
  │        provider:'spawn', label:'reviewer',
  │        request:{parent:agent, prompt:工件+task, agentOptions:{provider,model,…},
  │                 agentPreset:'reviewer', outputSchema},
  │        signal: exec.signal, delivery:'parent'})
  └─ 立刻返回回执（childId），回合照常继续或结束（不 await 结果）
子会话里
  └─ 独立 preset / 路由 / 上下文跑完；结论按 outputSchema 结构化
结算（原生）
  ├─ notifySettlement → 父 idle: followup；running: steer
  └─ 消息含摘要 + 收尾正文 + Structured result + diagnostic
主会话醒来
  ├─ 结算消息里自带缺口清单；想 done 必须再复核一次（见 §7-D）
  └─ 模型决定：继续干活 / delegate 再派 / finish{outcome, reviewId:'<childId>'}
```

### B. 没签字就停

```
agent/turn-stopping(turn N)
  ├─ 非顶层会话 / 未启用 / 本回合已调过 delegate·finish·newSession / goal armed active → 直接返回
  ├─ 本回合无回执 && todos 有 pending|in_progress && nudge 未用完
  │     → agent.steer("还有 N 项未完成：要么继续，要么 handoff finish（done/needs_user/abandoned），要么 delegate")
  ├─ 模型继续或签字 → 正常结束
  └─ 追问用完仍然停
        ├─ onUnreceiptedStop.delegateTo 有值 → 按 A 的第 2 步派兜底复核者
        └─ 否则 → 放行停止 + 中文 notice（剩余项、最后一句、可一键重跑）
```

### C. 开新会话

```
turn 内
  ├─ 主模型调用 handoff{action:'newSession', reason:'…', handoffNote:'…'}
  ├─ 插件：读旧选择 → createSession(cwd) → selectForNextRequest(新agent, 旧选择)
  ├─ 复制链绑定 → 拼首条消息（配置的 nextAction + 模型写的 handoffNote + 工件）
  ├─ 新会话 followup(首条消息)
  ├─ 旧会话：goal clear（若 active）+ notice「已接力到 <id>」
  └─ 返回 {newSession}
新会话
  └─ 首跳 = 旧会话选中的模型；链绑定同旧会话；熔断/失败切换照旧

自动那条（newSession.onFinish 命中）：
  finish 成功落账 → 插件直接用 finish 的 handoffNote 执行上面第 2–6 步 → 旧会话记 notice
```

### D. 复核 → 修 → 再复核（循环怎么收敛）

```
复核 verdict = gaps
  ├─ 主会话自己修，或派 role:work 的角色修
  ├─ 这时想 finish{done} → 被拒（最近一次结论不是通过）
  ├─ 再派一次复核 → 花掉一次 maxReviewsPerUserMessage（上限，不是配额）
  │    ├─ 通过 → 可以 done，立刻收工，不必跑满
  │    └─ 又有缺口 → 回到开头
  └─ 复核预算用完 → 只能 finish{needs_user}，缺口清单一并交出去
```

**预算按"人说话"计，这是唯一的重置开关**：真人一发消息，这些计数全部清零；人不在，三本账（派发 / 复核 / 开新会话）
只减不增。**开新会话不重置**——计数随绑定复制过去，否则"收工→开新会话→再收工"就能靠换会话刷满预算。
所以"审 → 改 → 审 → 改"必然收敛到一个落点，不靠模型自觉。

## 八、默认值与闸门

- **默认全关**（`enabled: false`）：装好不改任何现有行为，工具不注册、名册不出现。开启后名册为空则工具描述为空，
  模型不会调用；设置页给一条"先建一个角色"的提示。
- **会花钱的自动动作默认全关**：`nudgeWhenUnreceipted: false`（追问会触发一次真实模型调用）、
  `onUnreceiptedStop.delegateTo: ""`（不自动派）、`newSession.onFinish: []`（收工后不自动开新会话）、
  `requireReviewFor: []`（不强制复核）。打开交接后，**只有模型自己调工具才会发生事**；没签字就停只写一条 notice，
  不叫醒模型、不派子会话。
- **名册的 `failover` 默认 `inherit`**：子会话失败后跟父会话绑定的链走。想钉死就让填 `none`，想换一条就填链 id。
- **闸门按三个时间尺度计**：每回合（`maxDelegationsPerTurn`）、自最近一条用户消息以来（三个 `max…PerUserMessage`）、
  每天（`maxDelegationsPerDay`），外加每角色的 `maxRunsPerUserMessage`。**人一说话，三本 `…PerUserMessage` 清零**——这是循环收敛的唯一开关；
  `maxDelegationsPerDay` 不随人清零，进程内累计、重启归零（与熔断、候选索引同口径，见 `open-questions.md` 一.2）。
- **上限不是配额**：三个 `max…PerUserMessage` 都是"最多"，不是"必须"。复核第一次就通过就收工，不必跑满；
  只有超过上限才拒。填 3 的意思是"最多看三次"，不是"非要看三次"。
- **"用户消息"的准确口径**：`source.kind === 'user'` 且**不是插件自己注入的**（接力简报等；插件持有这些消息的 id）。
  计数随链绑定一起复制到新会话，所以**"开新会话"不重置**——只有人真的说话才重置。否则"收工→开新会话→再收工"
  就能靠换会话把预算刷满，闸门形同虚设。
- **到顶就停并说明**：中文 notice 写清"哪个闸、已用多少、在哪一步停"，不做静默降级。
- **追问默认关，打开也只一次**：默认 `nudgeWhenUnreceipted: false`；打开后 `maxNudgesPerTurn: 1` 保证只问一次，
  第二次停就放行——无限追问是另一种廉价。

## 九、做不到

1. **动机判断**：模型是懒、是误判、还是在合理收尾，插件没有真值。
2. **无工件的自欺**：它说做完了但没做，只有复核者看工件能发现；没有工件可看时，谁也发现不了。
3. **既没有 goal 也没有 todo 的会话**：`turn-stopping` 那一层没有可依据的声明，只能靠模型自觉与复核者。
   这不是实现缺口，是"声明渠道不存在"。
4. **模型不读工具描述、无视错误返回**：插件无法强迫；只能记账并在 UI 上显示"未按协议收工"。
5. **子会话再派孙会话**：受 DSH `maxDepth`（默认 1）限制，插件不额外放行、也不绕开。
6. **fork 不继承会话侧车**：新 fork 出来的会话回到默认链（既有裁定，`per-session-chains.md` 二.4）。
7. **旧会话仍可继续用**：交接只留提示，不锁会话。
8. **复核质量**：取决于 preset、模型与工件完整度，插件不承诺"一定发现缺口"。
9. **复核账本随会话**：fork 不继承账本（与链绑定同因），新 fork 的会话里 `finish{done}` 会要求重新复核或说明理由——
   失败关闭，不会默认放行。
10. **接力首条消息的身份**：它在 UI 上是一条用户消息（模型必须把它当任务执行），只能靠正文第一行注明来源。
11. **`instructions` 不是系统提示**：它随派发进入子会话的第一条用户消息，优先级低于 preset 的系统提示。
    需要"最高优先级、不被任务覆盖"的规范，就去建一个 Agent Preset。

## 十、被否方案

1. **`stages = when 谓词 → run 动作` 的判据表**
   - 最强的理由：零模型成本、结果可预测、能在设置页里画成一张表，不依赖模型是否听话。
   - 为何被否：它要求插件先给"任务处于什么状态"下定义，而状态本来就是模型的判断。词表一旦不全（必然不全），
     用户就会撞上"这个场景表达不了"，然后要么加谓词要么绕开——加谓词就是枚举的连续体，正是用户明确拒绝的形态。
2. **末条消息关键词匹配（`stopText`）**
   - 最强的理由：零配置、立刻可用，能兜住"模型说了未完成但停了"。
   - 为何被否：把"我做完了，剩下几个可选优化"读成"未完成"的误报无法收敛，而每次误报都要花钱派一次子会话。
3. **插件在 `turn-stopping` 自动派复核者（不问模型）**
   - 最强的理由：人不在也不会断，触发完全确定。
   - 为何被否：派谁、派去干什么全靠猜，复核者拿不到意图只能盲审；且每轮都派，费用不可控。
4. **只依赖原生 `subagent` 工具 + 模型自选**
   - 最强的理由：零新增配置，DSH 已经支持 `agentPreset` 与模型白名单。
   - 为何被否：用户要的是**指定**渠道/人格/工具；模型每次现场拼 `agentOptions` 等于每次重配，且无法预先定义
     "复核者只读不改、不看自述"。名册是预置，不是限制。
5. **`delivery:'caller'` + 自己 `followup`**
   - 最强的理由：消息内容与时机完全可控，不会被原生结算文本"污染"。
   - 为何被否：`caller` 明确不通知父会话（`manager.ts:1188`），要自己实现空闲判断、队列、去重，等于重写
     `notifySettlement`；原生那条路径已经处理了 idle/running 两种状态（`:1199`）。
6. **用 `agentDefaultModel.saveSelection` 让新会话继承主模型**
   - 最强的理由：一行调用，DSH 原生，影响面"恰好只有新会话"（`agent.ts:299-304`）。
   - 为何被否：它写的是**全局**配置，用户每次手动换模型都会覆盖它；且 2026-10-19 已裁定不再写 DSH 全局配置。
     `selectForNextRequest` 只作用于该会话且 durable。
7. **插件自建"任务状态机"（open / done / handed-off）**
   - 最强的理由：能画进度条、能做准入门、能统计。
   - 为何被否：任务完成在 DSH 没有真值，第二个真相源必然与 goal / todo 打架；回执只记"谁在什么时候说了什么"，
     不记"任务是什么状态"。
8. **把策略注入 system prompt**
   - 最强的理由：模型每轮必读，比工具描述更难被忽略。
   - 为何被否：工具描述本来就是每轮都进上下文的，且随名册变化自动更新；额外插一段还要处理与其他 prompt 段的
     竞争与去重，收益不明显。
9. **子会话完全绕开路由链**
   - 最强的理由：钉死的就是钉死的，绝不会因为降级偷偷换成更贵的模型；行为最容易解释，也最省钱。
   - 为何被否：它让子智能体成为系统里唯一没有韧性的执行者。熔断状态本来就全局，子会话踩坏的渠道主会话照样踩到，
    绕开并不能"隔离"；而失败后无处可去，等于把一次可恢复的渠道抖动升级成一次任务失败。
    要防"偷偷换贵模型"，用 `failover: none` 或 `failover: <便宜的链>`，不需要一个全局例外。

## 十一、实现前必须实测（含退路）

| # | 假设 | 怎么验 | 不成立时怎么走 |
|---|---|---|---|
| 1 | 插件注册的 `handoff` 工具对顶层会话的模型可见 | 真实 Loader 组合里让模型调用一次，看 `tool/call` 事件 | roster 保存期要求 preset 的 `toolFilter` 显式放行；仍不行就拒绝该组合 |
| 2 | `turn-stopping` 里能读 `todos` 投影 | 本项目已对 `contextPressure` 用同一读法；补一个 boot 场景断言 | 退成"只在有 active goal 时提醒"；再不行放弃自动追问，只留 `finish` 与 `facts` |
| 3 | `ctx.goals.create/clear` 允许插件调用 | `tool-goal` 的 authority 只在工具层，服务层需实跑确认 | 不自动建 / 清 goal：简报要求模型用 goal 工具重建，旧 goal 由模型标 blocked |
| 4 | 新会话首条消息前 `selectForNextRequest` 生效 | 断言新会话首条 `request/header` 的 provider/model | 插件在该会话的 `agent/request` 里钉第一跳（只作用该会话，不写全局配置） |
| 5 | `delivery:'parent'` 在父会话 idle 时确实 `followup` | 组合场景：父回合结束后子会话收尾，观察父会话被唤醒 | 退回 `'caller'` + 插件 `followup`：失去原生结算文案，方向不变 |
| 6 | `tool/call.arguments` 是 JSON 字符串、可回折叠回执 | 单测直接解析日志，不看内存状态 | 回执改用插件自有 session projection 折叠（项目已有同类先例） |
| 7 | roster 指定 preset/route 时 provider capability 满足 | 加载期校验 + 组合场景断言 start 被拒的文案 | 保存期拒绝该组合，要求换 preset 或 provider |
| 8 | 子会话请求按"自己 → `parentSession` → 默认链"解析绑定 | 组合场景：父会话绑 `coding` 链，子会话的请求失败后走 `coding` 的候选 | 派发时记 `childId → 父会话 id` 的内存映射（子会话不跨进程存活） |

## 十二、默认值（2026-10-23 已定）

用户裁定：**会真实跑的一律默认关**。下面全部是默认值，不再作为待决项；想开哪个就单独打开，各字段互相独立。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 整个交接关着：不注册工具、不出名册 |
| `requireReviewFor` | `[]` | 不强制复核；想强制就写 `[done]` |
| `nudgeWhenUnreceipted` | `false` | 没签字就停时不追问（追问会触发一次真实模型调用） |
| `maxNudgesPerTurn` | `1` | 即使打开追问，每回合也只问一次 |
| `onUnreceiptedStop.delegateTo` | `""` | 不自动派兜底角色 |
| `onUnreceiptedStop.reportToUser` | `true` | 只写一条 notice 告诉你 |
| `newSession.onFinish` | `[]` | 收工后不自动开新会话 |
| `roster[].purpose` | 必填 | 空则拒绝保存 |
| `roster[].instructions` | `""` | 与 `preset` 至少一个非空，否则拒绝保存 |
| `maxReviewsPerUserMessage` | `1` | 复核上限，**不是配额**：通过即收工 |

`newSession.onFinish` 的场景：一个大任务分多段交付，每段做完都换一个干净会话继续下一段（避免上下文越压越乱）。
填 `[done]` 才会发生；不填就什么都不做——模型想换场时自己调 `newSession`。

**保存期校验（恒定，与默认值无关）**：`purpose` 非空；`preset` 与 `instructions` 至少一个非空；
`instructions` ≤ **4000 字符**；`id` 唯一；`provider`/`model` 能解析。

## 十三、约束分级：哪些不能动，哪些实施时可以改

本文是**方向 + 可验证的骨架**，不是逐行规格。实施时如果发现更简单的做法，只要不违背 A 类，就按更简单的做；
如果 A 类本身站不住，停下来讨论——不要在它外面套一层补丁绕过去。

### A. 硬约束（违反就是换了方案，不是换了实现）

| # | 约束 | 机械判定 |
|---|---|---|
| A1 | 插件不判断任务状态 | 代码里没有"完成 / 未完成 / 跑偏"的判定分支；只有协议记账与事实折叠。唯一允许的"条件"是**模型自己写下的声明事件**（`finish` 回执、goal 相位变化），不是对状态的采样与推断 |
| A2 | 第一跳不变量 | 第一跳 = 请求声明的模型；切换只发生在失败之后 |
| A3 | 唤醒只走 agent 的 inbox | 只用 `agent.followup` / `agent.steer`；不自建队列、不直接改 transcript |
| A4 | 回执不制造第二真相源 | 有 active goal 时，`done` 由 goal 说了算 |
| A5 | 默认关，两半都能独立工作 | 关掉交接不影响路由；关掉路由不影响交接 |
| A6 | 不改 DSH、不新增 durable 事件类型 | 回执与统计全部从既有事件折叠 |

### B. 方向（朝这边走，形态实施时定）

- 名册字段的粒度与命名、是否可以合并成更少的键。
- 工具是一个还是两个：本文是单工具四动作；如果实测发现模型容易混用，拆成两个工具不违背方向。
- 备料：**能可靠拿到什么就给什么，拿不到的项删掉**，不要为了凑清单造数据。
- 唤醒优先用原生结算（`delivery:'parent'` + `notifySettlement`）；实测不成立时退回 `'caller'` + `followup`，仍受 A3 约束。
- 追问文案、简报排版、UI 落点（设置页表格 / 轨迹里的行 / 会话 chip）。

### C. 假设与退路

八条假设、验证方式与"不成立时怎么走"都在 §十一 的表里（第三列），这里不重复列。只强调一条：
**退路只能换实现，不能换 A 类约束**——如果某条退路要求插件开始判断任务状态，那它不是退路，是另一个方案。

## 十四、落地检查清单

实现时逐条对照；漏一条是行为不对，不是风格问题。

- [ ] **保存期校验**：`purpose` 非空；`preset` 与 `instructions` 至少一个非空；`instructions` ≤ 4000 字符；
      `id` 唯一；`provider`/`model` 能解析。
- [ ] **`instructions` 是轻量 Markdown 文本**：不解析、不改写，按 `instructions → task → attach` 拼进派发消息；
      UI 上提示"别写密钥"。
- [ ] **一个字段一个读者**：工具描述只含 `purpose`，不含 `instructions`；`instructions`/`preset` 只进子会话。
- [ ] **默认全关**：`enabled` / `requireReviewFor` / `nudgeWhenUnreceipted` / `delegateTo` / `newSession.onFinish`。
- [ ] **收工门**：有 active goal 时 `done` 被拒；`requireReviewFor` 命中时只认最近一条用户消息之后、最近一次通过的复核。
- [ ] **预算**：三本 `max…PerUserMessage` 只由"人真的说话"清零；接力复制，不因开新会话重置；上限不是配额。
- [ ] **路由合流**：子会话第一跳 = 声明 route；失败后按 自身 → `parentSession` → 默认链；重试与熔断照旧。
- [ ] **不新增 durable 事件类型**：复核账本落 storageDomain；无 storage 时内存 + 可见 notice。
- [ ] **`newSession` 的六步**：`createSession` → `selectForNextRequest` → 复制绑定与计数 → 拼简报 `followup`
      → 旧 goal `clear` → notice。
