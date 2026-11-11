---
title: "DSH On-call — 总览：产品、架构、进度"
status: "proposed"
kind: "overview"
last_updated: "2026-11-11"
---

# DSH On-call — 总览

## 摘要

**一句话**：给一个仓库配一个不睡觉的同事——有人在 issue 里 @ 它，它就去把活干完，回来告诉你结果。渠道挂了它自己换。

**它解决的问题不是"让模型更聪明"，是"没人盯着的时候，活还能不能干完"。** 人盯着时，429 只是重试一下；没人盯着时，429 就是任务卡到早上。所以"能自动接活"和"挂了能换路"不是两个功能，是同一个产品。

现有实现已经把这套的**眼睛与手**都装好了：读 GitHub、判授权、开 Case、起 worker 会话干活、等回合结束、写报告、回评论、重启接着上一刀；渠道挂了在请求内换路。

## 一、名字

| 候选 | 含义 | npm |
|---|---|---|
| **`dsh-oncall`（推荐）** | 值班：你下班，它顶班 | 可用 |
| `dsh-shiftdesk` | 值班台，更「台」一点 | 可用 |
| `dsh-ticketdesk` | 工单台，突出 Case | 可用 |
| `dsh-casework` | 案子，与领域名词一致 | 可用 |
| ~~`dsh-dispatch`~~ | 派工台，语义最准 | **已被占用 0.4.0** |

选 `dsh-oncall` 的理由：这个词同时表达了「无人值守」和「出事了顶上」，而这两个正是产品的全部价值。`dispatch` 语义最准但拿不到。

**改名已执行（2026-11-11）**：`dsh-oncall` 在 npm 上是 404，从未发布，所以改名零成本；越晚改越贵，因为行 id 就是设置命名空间。已改：包名与仓库名 `dsh-oncall`、目录 `packages/dsh-oncall/`、配置 ns 与行 id `oncall`、service key `oncall`、typert ns `oncallHealth`、样式前缀 `dsh-oncall-*`、持久化标识（`oncall_sessions`、`oncall/*` 投影键）、中文名「值班台」。冻结不改：`.agents/notes/` 与 `spike/` 的历史记录、CHANGELOG 旧版本条目——它们记录的是当时的事实。

**迁移**：加载时检测 profile 里的旧 `model-desk` 行与旧 `router/*` 投影键，打错误日志给出改法，不静默接管。旧配置不自动迁移：字段形状已经变了，猜错了比重配更贵。

## 二、三个粒度，各有一个所有者

这是整个架构的骨架。**不是把两家功能摆进一个目录，是把「一件事」切成三层，每层只归一个人管。**

| 粒度 | 是什么 | 唯一所有者 | 活多久 | 状态 |
|---|---|---|---|---|
| **Case** | 一件被授权的工作 | 授权与生命周期 | 永久 | ✅ 已实现 |
| **Step** | Case 里的一次推进（= `Assignment`） | executor 写、core 决定下一步 | 随 Case | ✅ 已实现 |
| **Attempt** | 一次模型调用 | 选渠道、失败切换 | 有界（审计流） | 🟡 复用现有路由 |

superagent 只设计到 Case，comet 只设计到 Step，原路由插件（路由核现仍在同包内）只设计到 Attempt。三家各占一层，谁也不吞并谁——这是能合成一个包而不打架的原因。

## 三、五层

```
L5  faces     ingress / route / tool / panel
      ↓
L4  runtime   pass、executor、sources、channels、notify
      ↓
L3  state     七张表（progress / cases / threads / inputs / steps / replies / audit，域版本 1）
      ↓
L2  core      纯函数：闸门、状态派生、计划、路由决策
      ↓
L1  contract  类型、常量、默认值、配置 schema
```

**依赖只能向下。** L2 无 I/O（`tests/layers.mjs` 强制）：不读时钟、不碰 `ctx`、不写库。时间从参数进来，所以每条决策都能重放。

**确定性只加在闸门上。** 该不该开始、该问人、该收工——插件判；阶段内部模型自由发挥。因为我们不拥有 agent loop，强行确定性就是跟 DSH 抢。

## 四、已实现（1681 行）

### 契约与决策（L1 / L2）

| 模块 | 行 | 职责 | 测试 |
|---|---|---|---|
| `contract/types.ts` | 180 | 品牌类型、Trigger、Mandate、Case、Outcome、Step、Stage、审计事件 | 类型即测 |
| `contract/policy.ts` | 47 | Policy、AcceptMode、身份匹配 | — |
| `contract/defaults.ts` | 59 | 全部默认值与码表 | — |
| `core/admission.ts` | 77 | 闸门：一条 Trigger 能不能变成 Case | `ingress` |
| `core/stage.ts` | 57 | 状态派生（不落库） | `ingress` |
| `core/plan-step.ts` | 53 | 下一步做什么 | `ingress` |
| `core/mentions.ts` | 39 | `@login` 判定（避开 `@alice-bot`、邮箱） | `github-issue` |
| `core/case-id.ts` | 18 | Case 身份 = `case:<trigger>`，幂等 | `pass` |
| `core/brief.ts` | 23 | 请求正文的边界与截断标记 | `pass` |
| `core/trigger-key.ts` | 44 | 两个键的唯一构造点（含反向取 external id） | `ingress` |
| `core/thread-owner.ts` | 47 | 「这条消息归谁」：thread 最新订阅，`stopped` 不恢复 | `pass` |
| `core/reply-plan.ts` | 63 | report → 回执意图与正文（回执门禁） | `executor` |

### 入口与运行时（L4）

| 模块 | 行 | 职责 | 测试 |
|---|---|---|---|
| `sources/source.ts` | 62 | Source 契约：不持有游标、不做授权、无状态 | — |
| `sources/github-face.ts` | 71 | 自己声明的窄接口（不依赖 Octokit 类型） | — |
| `sources/github-http.ts` | 155 | fetch 实现，分页、错误映射、形状校验 | `github-http` |
| `sources/github-issue.ts` | 193 | issue/评论 → Trigger，游标回看一分钟 | `github-issue` |
| `runtime/ledger.ts` | 200 | 账本端口（命名操作）+ 内存实现 | `pass` / `executor` |
| `runtime/durable-ledger.ts` | 500 | storageDomain 七张表 + 品牌还原，加表不升版本 | `ingress-loop` |
| `runtime/pass.ts` | 258 | 一轮：读 → 归属 → 闸门 → 开 Case/扇出，一次提交 | `pass` |
| `runtime/executor.ts` | 520 | 派工生命周期：起会话、投递、等回合、结算、重启恢复、层 B | `executor` / `oncall-loop` |
| `runtime/outbox.ts` | 190 | 回执：一条一个 `caseId#seq`，重试/`gone`/重启补发 | `executor` |
| `sources/github-reply.ts` | 55 | 回执发到 issue（`ReplySender` 的 GitHub 实现） | `executor` / `oncall-loop` |

### 面（L5）

| 模块 | 行 | 职责 | 测试 |
|---|---|---|---|
| `faces/ingress.ts` | 110 | 自调度循环（timeout 非 interval） | `ingress-loop` |
| `faces/env.ts` | 18 | 唯一的 `process.env` 读取点 | — |
| `faces/reports.ts` | 130 | `oncall_report` 工具：全局注册、按会话判归属 | `executor` / `oncall-loop` |

**接线**：`config.ts` 加 `ingress` 段（含 `baseUrl` / `workdir`），`index.ts` 的 `installIngress()` 装配 source、账本、executor、outbox 与 `oncall_report`。

**测试**：13 套全绿。入口侧 7 套：`layers` 守卫、`ingress` 29、`github-issue` 16、`pass` 27、`github-http` 10、`ingress-loop` 19、`executor` 28；组合两套：`oncall-loop` 38（真实 web profile + 本地假 GitHub：@ 一次只开一个 Case、追问进同一会话、实时工具调用回执、重启带 recovery note）、`handoff-relay`（真实 web 组合的接力）；原有 `unit` 259 / `client-controller` 129 / `remote` 25 / `run` 37 场景不变。一个用例常同时覆盖两个模块，所以上表只标套件，不按模块拆条数。

## 五、未实现

| 缺什么 | 影响 | 在哪个阶段 |
|---|---|---|
| 评估层（一张 issue 两件独立的活自动分开） | 同 thread 的补充与新活由 worker 自己判，判不了就都算补充 | V1 |
| comet 式检查点（精确回到断点） | 重启是「重开一次派工 + recovery note」，长任务的恢复质量有限 | V1 |
| attempt 审计表 | 切换记录目前折在会话投影里，没有跨 Case 的审计流 | V1 |
| 回执的重试上限与退避可配 | 现在是固定 3 次 / 1s、2s | V1 |
| PR / CI 结果回到同一 Case | 只能认评论 | V3 |
| 面板、任务线 | 只能翻日志 | V5 |
| thread 订阅（PR / CI 结果回到同一 Case） | 只能认评论，PR 与 CI 不回写 | V3 |
| PR / 飞书 Source | 只能盯 issue | V3 / V4 |
| 面板、任务线 | 只能翻日志 | V5 |

## 六、路线

| 刀 | 端到端能做什么 | 验收 |
|---|---|---|
| **V0** | issue 里 @ → 改代码 → 回评论 | 设 `GITHUB_TOKEN`、填仓库、加白名单；@ 一次就动，且**只动一次**（同 thread 追问不另开 Case）；最小 `step` 让重启后知道上一刀干到哪 |
| V1 | 重启/中断后接着干 | 进程重启后不重头再来 |
| V2 | 渠道挂了任务不停 | 断网后任务继续，审计里知道换过 |
| V3 | 一张 issue 回三次不动三个 Case | 同一 thread 后续消息回到同一 Case |
| V4 | 飞书群里 @ 也能干 | 群里 @ 一次就动 |
| V5 | 任务线、为什么换，看得见 | 不用翻日志 |

## 七、关键决定（附理由）

| 决定 | 一句话理由 | 笔记 |
|---|---|---|
| 状态派生不落库 | 两份事实必然漂移，漂移方向不确定 | [决策层](../../.agents/notes/implemented/2026-11-09-ingress-decision-layer.md) |
| 拒绝用结果值、失败用异常 | 拒绝是常态，用 `try/catch` 做流程控制是错的 | 同上 |
| 守卫先只守新目录 | 第一天就红的检查活不过一周 | 同上 |
| 游标回看一分钟 | `updatedAt` 会倒退，会反向移动的量不能当游标 | [游标](../../.agents/notes/implemented/2026-11-09-github-source-cursor-overlap.md) |
| 令牌走环境变量 | 配置会被复制、备份、贴进 issue | [令牌](../../.agents/notes/implemented/2026-11-10-ingress-token-and-persistence.md) |
| 无持久存储拒绝启动 | 幂等键丢了会重复开 Case，两个 Case 改同一批文件 | 同上 |
| 循环用 timeout 不用 interval | interval 会让两轮读同一个游标 | [入口设计](super-plugin.md) 7.1 |

## 八、三条实话

1. **现在还不能给别人用。** 打开入口只会建 Case，不会干活。能验证闸门和账本，不能交付。
2. **executor 是唯一的堵点。** 它要碰真实 DSH 会话编排，必须用真实 Loader 组合验证，不能靠单测——这是项目规则里的硬要求。
3. **watch 部分是全系统最贵、最不独特的。** GitHub 的读取、游标、幂等、限流占了新增代码的 40%，写完大家都一样。真正的差异在"挂了能不能自己活过来"——所以 V2 比 V3 重要。

## 九、文档地图

| 想知道 | 读 |
|---|---|
| 总方案与取舍 | [super-plugin.md](super-plugin.md) |
| 代码怎么组织 | [super-plugin-code.md](super-plugin-code.md) |
| 为什么这么合、两个参考项目是什么 | [super-plugin-merge.md](super-plugin-merge.md) |
| 现有代码的分层体检 | [super-plugin-architecture.md](super-plugin-architecture.md) |
| 外部先例 | [../references/prior-art.md](../references/prior-art.md) |
