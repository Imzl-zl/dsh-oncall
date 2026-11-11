---
title: "DSH 超级插件 — 一个包的架构"
status: "proposed"
kind: "architecture-proposal"
last_updated: "2026-11-09"
---

# DSH 超级插件 — 一个包的架构

## 摘要

**一个包，一台状态机，一份状态，一个面板。** 不是装两个插件，不是把两个仓库拼起来，是把三件事原生做在一个代码库里：接活（盯消息 / issue / PR）、把活干成、干挂了换条路。

**产品命题：无人值守是渠道故障唯一真痛的场景。** 人盯着的时候，429 只是重试一下；没人盯着的时候，429 就是任务卡到早上。所以"能自动接活"和"挂了能换路"不是两个功能，是同一个产品——越无人值守，路由层的价值越大。

**交付方式：纵向切片。** 每一刀都端到端跑通一件事，V0 就是"在 issue 里 @ 它，它改完回一条评论"——窄，但是完整的产品。入口排在 V0，因为**没有入口就不是产品**。

**核心设计：把"一件事"切成三个粒度，每个粒度只有一个所有者。**

| 粒度 | 是什么 | 唯一所有者 | 活多久 |
|---|---|---|---|
| **Case** | 一件被授权的工作 | 授权与生命周期 | 永久 |
| **Step** | Case 里的一次推进 | 确定性决定下一步 | 随 Case |
| **Attempt** | 一次模型调用 | 选渠道、失败切换 | 有界（审计流） |

superagent 只设计到 Case，comet 只设计到 Step，oncall 只设计到 Attempt。**三家各占一层，谁也不吞并谁**——这才是能合成一个包而不打架的原因。

另一条同样关键：**确定性加在闸门上，不加在每一步上**。我们不拥有 agent loop，所以插件只决定"该进入哪个阶段 / 该问人 / 该收工"，阶段内部模型自由发挥。

## 一、为什么不是拼装

| | 拼装（并排装两个） | 融合（一个包） |
|---|---|---|
| 状态机 | 两套，靠人脑对齐 | 一台 |
| 存储 | 两套 schema，两个迁移器 | 五张表，一个迁移 |
| 面板 | 两个侧栏入口，两套术语 | 一个页面，一套术语 |
| 配置 | 两个 ns，两次保存 | 一个 ns |
| 失败时 | 两个日志，先猜是谁的 | 一条审计流，一眼到底 |
| 升级 | 两个版本门槛互相卡 | 一个版本 |

拼装唯一的优势是"能分别关掉"，代价是**所有跨边界的事实都要靠人对齐**。这个产品的全部价值都在跨边界上，所以拼装等于抵消产品本身。

## 二、执行循环

只有一台循环，而且它跑在 DSH 的 agent loop 上——插件不自己跑循环，它开会话、喂下一步、等回报。

```
ingress ──► Case(created, mandate)
              │
              ▼
        ┌─────────────────────────────────────┐
        │ step ← resolveStep(case, run, ctx)   │  纯函数
        │ if step.type == end → close(Case)    │
        │                                      │
        │ for attempt in candidates:           │
        │   route ← resolveRoute(attempt, …)   │  纯函数
        │   result ← session.run(step, route)  │  经 port，DSH 执行
        │   if ok     → record, break          │
        │   if switch → record, continue       │
        │                                      │
        │ checkpoint(run)                      │  机器态
        └─────────────────────────────────────┘
```

三段各有唯一决定者：**哪一步**（`resolveStep`）、**哪条渠道**（`resolveRoute`）、**算不算完成**（`outcome` 判定）。三者都是纯函数，输入只读。

### 为什么确定性只加在闸门上

comet 能让每一步都确定，因为它拥有循环。我们不拥有——DSH 的 agent loop 在跑模型。

所以：

- **闸门确定**：进入哪个阶段、能不能派人、要不要问人、算不算完成——这些由插件判定，可复算、可审计。
- **阶段内部自由**：模型在"实现"这个阶段里怎么改代码，插件不管，只在结束时读它交回的结构化回报。

这不是妥协，是 **superagent 的 Eval 与 comet 的 guardrail 本来就该有的位置**：前者判"该不该开始"，后者判"这个动作许不许"，都不管中间怎么干。

## 三、五层

只能向下依赖，允许跳层。

```
L5  faces     ingress / route / tool / panel / remote
      ↓
L4  runtime   Case 生命周期、Executor 编排、通道执行
      ↓
L3  state     五张表的读写 + 审计流
      ↓
L2  core      纯函数：状态派生、resolveStep、resolveRoute、guardrails
      ↓
L1  contract  类型、常量、默认值、wire 格式、配置 schema
```

| 层 | 准入条件 | 禁止 |
|---|---|---|
| L1 | 只有类型、常量、字面量、纯构造 | 任何外部调用 |
| L2 | `(只读输入) → 裁决数据` | `ctx`、`Date.now()`、`Math.random()`、写状态、`await` |
| L3 | 只读写五张表，不做业务判断 | 网络、`ctx.on` |
| L4 | 有 I/O，但只经 port | 直接注册事件、直接读全局配置 |
| L5 | 唯一允许 `ctx.on` / `ctx.tools.register` / `@Remote` | 任何业务判断 |

L2 里**没有** DSH 类型（连 `import type` 都限制在三个白名单），这样它既能被宿主编译，也能被浏览器编译——面板要预览"这一步会走哪条渠道"时直接复用。

## 四、模块

| 层 | 模块 | 职责 | 明确不含 |
|---|---|---|---|
| L1 | `contract` | Wire 类型、跨端形状、审计事件枚举 | 逻辑 |
| L1 | `defaults` | 全部默认值与码表，单一来源 | 校验 |
| L1 | `config-shape` | schemastery schema | 跨字段规则 |
| L2 | `case-state` | Case 状态派生（不存储） | 存储 |
| L2 | `resolve-step` | `(case, run, context) → Step` | 执行 |
| L2 | `resolve-route` | `(candidates, attempts, health) → Route` | 真正调用 |
| L2 | `guardrails` | `checkAction(action, run, rules) → allowed \| refused` | 副作用 |
| L2 | `config-rules` | 跨字段校验 | 默认值 |
| L3 | `store` | 五张表 + 迁移 | 业务判断 |
| L3 | `audit` | 追加流：只写不改 | 读取以外的能力 |
| L4 | `case-runtime` | 建 Case、推进、关闭、恢复 | 渠道细节 |
| L4 | `executor` | 开 DSH 会话、发 Step、等回报、目录准备 | 状态机 |
| L4 | `sources` | Source 轮询、游标推进、幂等、失败退避 | 授权判断（那是 L2） |
| L4 | `channels` | 健康、探测、熔断、退避等待 | 选哪条（那是 L2） |
| L4 | `notify` | 中文通知构造与投递 | 何时说（L2 决定） |
| L5 | `face-route` | `agent/request` × 2 | 装配 |
| L5 | `face-tool` | 模型可调的工具（委派、收工、查状态） | 判断 |
| L5 | `face-ingress` | 手动 / 定时 / Source 的接线与 pass 循环 | 授权与解析（L2 / L4） |
| L5 | `face-panel` | 页面 + 右栏 + chip | 业务规则 |
| L5 | `bootstrap` | Cordis 装配、生命周期 | 一切判断 |

**19 个模块，每个一个变更理由。** 判据：改一个需求，应该只动一到两个模块。

## 五、状态机

Case 的状态**不存储，是派生的**——存的是事实，状态从事实算出来。这样状态永远不会和事实矛盾。

| 派生状态 | 条件（首个匹配） | 面板标签 |
|---|---|---|
| `needs-person` | 投递失败 / 在等人答 / 等审核 / blocked / failed | 需要你 |
| `queued` | 没有进行中的 Step | 排队 |
| `waiting` | 上一 Step 回报 waiting | 等触发 |
| `working` | 其余 | 进行中 |
| `done` | 已关闭 | 完成 |

派生规则住 L2（`case-state`），**唯一一处**。面板、通知、右栏都读它，不允许各自判断。

## 六、存储

五张表，一个迁移器（当前落地三张：`progress` / `case` / `audit`；`step` 在 V1、`thread` 在 V3 补）：

| 表 | 主键 | 存什么 | 谁能写 |
|---|---|---|---|
| `case` | caseId | 授权（Mandate）、范围、来源、关闭原因 | L4 |
| `step` | caseId + seq | 阶段、输入、outcome、检查点 | L4 |
| `attempt` | stepId + seq | 渠道、错误码、耗时、是否切换 | L4 |
| `thread` | sourceId + threadKey | 外部会话（issue / PR / 群聊）→ case 的订阅关系 | L4 |
| `audit` | 自增序号 | 追加事实：切换/跳过/熔断/派工/收工/接活 | **只追加，不改** |

`thread` 表是整个入口设计的关键：**一个 Case 只开一次，后续的评论与 CI 结果都回到它**。没有这张表，同一张 issue 上第二条评论会开出第二个 Case，然后两个 Case 抢同一个分支。

**机器态模型不可写。** 这条从 comet 借来：它们让 `comet-state set` 拒绝写 machine-owned 字段，并用原子写 + 文件身份校验保护运行态。我们对应做法是：模型只能通过工具**提交 outcome**，不能写表；浏览器只读。

底子是 `ctx.storageDomain`（DSH 认可的侧车），无存储时退化为内存并如实告知。

## 七、入口：盯消息、issue、pr

这是产品的前门，也是 **V0 就要交付的东西**——没有它，这个包只是基础设施。它只有三件事：**读得到、判得准、不重复**。

### 7.1 一个 Source 接口，三种实现

```ts
interface Source {
  readonly id: string
  /** 从游标读到 now；游标与失败重试由 L4 持有，不进领域。 */
  poll(cursor: Cursor | null, signal: AbortSignal): Promise<{ triggers: Trigger[]; cursor: Cursor }>
  /** 设置页要显示的事：读哪儿、读到哪、上次错在哪。 */
  describe(): SourceStatus
}
```

| 实现 | 读什么 | 什么算"对我说话" |
|---|---|---|
| `github-issue` | issue 正文、评论、label 变化 | `@agent` 提及 / 被指派 / label 命中 |
| `github-pr` | review 评论、CI 状态、合并与关闭 | 同上，加"CI 在我分支上失败" |
| `chat` | 群聊与私聊消息 | `direct`（私聊）或 `mention`（群里 @） |

**一个调度器，不是每个 Source 一个定时器**：一次 pass 按顺序问所有 Source，慢的 Source 不拖累快的。这是 superagent 的做法（每 2 秒一次 pass），也是单进程里唯一能保证顺序的做法。

### 7.2 闸门：Trigger → Case 之间必须有判断

```
Trigger ──► gate ──► Case
```

gate 只回答两件事，都是纯函数（L2）：

1. **这人能不能派活**：允许名单 / 群成员 / bot 名单——按 Source 各自的身份体系，不跨源映射（superagent 的结论：跨源身份映射是提示词，不是实体）
2. **这话算不算请求**：`direct` 与 `mention` 是明确请求；其余进"候选"，按 accept mode 处理

**accept mode 三档**，直接借 superagent 的设计：

| 模式 | 行为 | 用在哪 |
|---|---|---|
| `off` | 只接明确请求 | 默认 |
| `observe` | 候选也评估，只记录"本来会怎么干"，不真干 | 第一次上线 |
| `auto` | 候选也真干 | 团队规则写好之后 |

`observe` 是这个产品能被信任的唯一原因：**先看它想干什么，再允许它干**。

### 7.3 订阅：同一张 issue 的后续评论不许开新 Case

`thread` 表存 `sourceId + threadKey → caseId`。规则：

- 一个 Trigger 落到已有 thread 的 Case → 作为**上下文**投给该 Case 的当前 Step，**不进闸门、不授予新权限**
- 没有对应 Case → 进闸门，可能开新 Case
- Case 关闭后，同一 thread 的新消息**不自动复活**它，除非有人明确要求

这三条是整个入口最容易被写错的地方。写错的症状：一张 issue 上回复三次，开出三个 Case，三个都去改同一个文件。

### 7.4 游标与幂等

- **游标**存在 `case` 之外的独立 KV（每 Source 一条），和 Trigger 一起原子推进——`读到了` 与 `记下了` 必须同一个事务，否则重启会重复处理
- **幂等键** = `sourceId + 外部事件 id`（issue number + comment id、message id）。同一个 Trigger 被接两次，只产生一个 Case
- **失败重试**：Source 读失败按退避重试（2s → 翻倍 → 上限 1 分钟），状态进 `describe()`，不要静默

## 八、四个面

| 面 | 位置 | 内容 |
|---|---|---|
| **route 面** | 会话内 | `agent/request` 选链、`agent/request-error` 决定切换；chip 显示当前链 |
| **tool 面** | 会话内 | 模型可调：`delegate` / `finish` / `handback` / `status` |
| **ingress 面** | 会话外 | Source 轮询 → 闸门 → Case；含订阅与 observe 模式（见第七节） |
| **panel 面** | 浏览器 | 一个页面四页签：概览 / 工作项 / 渠道 / 名册；右栏任务线 |

四个面共用 L2 的同一批纯函数。**面板不自己算任何东西**——它读派生结果。

## 九、契约

别的插件要接进来，只需要三样：

```ts
/** 解析一条可用渠道；实现包 ctx.llm.resolveCallConfig。 */
interface ChannelPort {
  resolve(candidate: Candidate): Promise<ResolvedRoute>
  health(): Promise<RouteHealth[]>
}

/** 开一个执行会话；实现包 sessionController.create + presets。 */
interface ExecutorPort {
  open(input: { preset: string; cwd: string; label: string }): Promise<SessionRef>
  deliver(ref: SessionRef, step: Step): Promise<Outcome>
}

/** 账本：Case / Step / Attempt 的读写；实现包 storageDomain。 */
interface LedgerPort {
  read(caseId: string): Promise<CaseSnapshot>
  append(event: AuditEvent): Promise<void>
}
```

**这就是"可被依赖"的技术含义**：superagent 那种插件不必装两个包，它能直接调 `ChannelPort`。

## 十、构建次序：纵向切片，不是横向铺层

**代码分层，交付切片。** 五层是代码结构，五刀是交付结构，两者不冲突：每一刀都同时落到五个层里，只是每层只落一小块。

原则：**每一刀都必须能端到端跑通一件事**，否则不算交付。

| 刀 | 端到端能做什么 | 新增的层内件 | 验收（用户视角） |
|---|---|---|---|
| **V0** | 在 issue 里 @ 它 → 开一个 worker 会话 → 改代码 → 回一条评论 | `github-issue` Source + 闸门（允许名单）+ 最小 `case`/`audit` + `executor` | **5 分钟内接上**：设 `GITHUB_TOKEN`、填仓库、加白名单，@ 一次就动 |
| **V1** | 上面那件事**断了能续**：进程重启、会话中断、worker 失败 | `step` 表 + `resolveStep` + 检查点 + 恢复 | 重启后它接着干，不重头再来；面板能看到卡在哪 |
| **V2** | 长活跑几十轮不因渠道挂掉而停 | 失败切换接入 Case/Step（今天只在单次调用内） | 渠道断了任务继续，且审计里知道换过 |
| **V3** | 同一 thread 的后续评论回到同一个 Case；PR 与 CI 也接 | `thread` 表 + 订阅 + `github-pr` Source | 一张 issue 回三次不会开出三个 Case |
| **V4** | 飞书群里 @ 它也能干 | `chat` Source + bot 身份 + 成员名单 | 群里 @ 一次就动，回复在原群 |
| **V5** | 看得见：任务线、为什么换、谁在等 | 面板 + 右栏 | 不需要翻日志 |

**V0 就是产品的样子**，只是窄。V1–V5 都是把 V0 那件事做得更可靠、更宽、更可见。

### 为什么 Source 必须在 V0

没有入口，这东西不是产品，是基础设施。客户买的是"我睡觉的时候那张 issue 被修好了"，不是"一个能换渠道的状态机"。

Source 的脏活（游标、幂等、限流、权限）确实比状态机重，但那是**预算问题，不是优先级问题**：要在 V0 就把它算进去，而不是把它排到看不见的地方。写一次，别写五次——所以先做 GitHub issue（thread key 最干净），Feishu 放 V4。

### 分层与切片的关系

```
V0  V1  V2  V3  V4  V5        ← 交付切片（纵）
│   │   │   │   │   │
L5  ██  ██  ██  ██  ██  ██    faces
L4  ██  ██  ██  ██  ██  ██    runtime
L3  ██  ██  ██  ██  ██  ██    state
L2  ██  ██  ██  ██  ██  ██    core（纯函数）
L1  ██  ██  ██  ██  ██  ██    contract
```

每刀都穿过所有层，但只填一小块。**任何一刀跑完后，五层的边界都不能破**——守卫脚本每刀都要绿。

## 十一、产品力：六条必须成立的事

这六条比功能清单重要，它们是"客户愿不愿意用"的判据：

| # | 必须成立 | 反例（做了就废） |
|---|---|---|
| 1 | **五分钟接上**：一个 token、一个仓库、一个白名单，@ 一次就动 | 先配链、再配名册、再配预设，配到一半就跑了 |
| 2 | **默认会拒绝**：不认识的人 @ 它，它不理；未授权仓库不碰 | 装上就开始在别人仓库里干活 |
| 3 | **说人话**：结果回到 issue / 群里，不是回到自己的面板 | 让人追着去面板看它干了啥 |
| 4 | **出事说清楚**：卡在哪、需要你干什么 | 贴一串 stack trace，或者干脆沉默 |
| 5 | **不吵**：健康的时候一条消息都不发 | 每轮都汇报"我正在思考" |
| 6 | **可回退**：`observe` 先看它想干什么，再允许它干 | 上线第一天就自动合并 PR |

第 1 条直接约束架构：**配置面必须能小到一个表单**。这意味着一开始 `bindingRule` 不要暴露、链只用默认一条、名册只用一个预设。能力都在，但不许出现在首屏。

第 5 条约束通知：`notify` 只在"需要人"或"完成"时说话，其余进审计流不进消息。这是 superagent 用 9 篇文档换来的结论，直接抄。

## 十二、验收不变量

这四条比功能清单重要，任何一条破了就是设计错：

1. **一个 Case 同一时刻只有一个 owner Step。**
2. **一次 Attempt 只产生一条审计记录**，不重不漏。
3. **任何时刻 Case 的状态都能从五张表重算**——不存在只活在内存里的状态。
4. **L2 无 I/O**：删掉 `ctx`、`Date.now()`、`Math.random()` 后仍能跑完所有 L2 用例。

## 十三、待定的三件事

1. **包名与 settings ns**：`cordis.patch.yml` 的行 id 就是配置命名空间（`ns: entry.options.id`）。改名会破坏已有配置，必须在动代码前定。
2. **`agent/request` 双 `prepend` 的先后**：需要一次真实 Loader 实验，不能读代码推断。
3. **GitHub 用 App 还是 PAT**：App 能按仓库授权、能代表 bot 身份（更像"一个同事"），但要建 App、管私钥；PAT 五分钟能用，但身份是"某个人"。V0 建议 PAT，V2 之后换 App。
