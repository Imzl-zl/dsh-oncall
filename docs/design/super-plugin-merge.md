---
title: "DSH On-call — 超级插件融合方案"
status: "superseded"
kind: "design-proposal"
last_updated: "2026-11-11"
---

# DSH On-call — 超级插件融合方案

> **状态：superseded（2026-11-11）。** 本页「只做路由底座、不做入口」的判断已被[产品路线变更](../../.agents/notes/implemented/2026-11-11-oncall-product-route.md)取代：入口（GitHub issue → Case）已是 V0 前门，且已实现；`thread` 映射与 `step` 表也按新的 V0 验收提前。
>
> 仍然有效：§二 三种接入方式、§三/§四 可借与不借清单、§五 三条纪律、§八 P0–P3 的拆法。失效：§七 的目标形态（未含 ingress）与 §九 的前三条「不做」（领域模型 / 事件源 / poller）。
>
> 旧决策保留不重写：本页记录的是 2026-11-09 时点的判断。

## 摘要

**能不能做成一个超级插件：能。但"超级"的判据不是功能数量，是被依赖程度。**

三句结论：

1. **定位**：不做第二个 superagent，做所有长任务插件的**执行底座**——凡是 DSH 里开出来的会话，默认就跑在你的路由上。这一条今天已经成立（`chainForSession` 对未绑定的会话回落到默认链，`index.ts:316-317`），方案只是把它从"碰巧成立"变成"显式承诺"。
2. **融合的正确对象是四类具体设计，不是两个项目**：按角色裁剪 preset（含两层限制）、会话目录隔离、外部会话的链绑定继承、状态词汇（Run / Action / Wait / Checkpoint）。Ticket 领域模型、事件源、Eval 平台都不该进这个包。
3. **触发面不要自建**。DSH 原生已有 `goal` + `goal-round-driver` + `schedule` + `agent-team`，它们合起来覆盖了 superagent 的"无人值守长任务"，superagent 自建那一套是为了**独立部署**（自有 profile、自有端口、自有 stateDir），不是因为它更强。

**本页只出设计与迁移清单，不改代码。** 第八节的改动待拍板后才执行。

## 一、参考物与路径

后面统一用左列的简称。本页所有引用都可按这张表回溯。

| 简称 | 路径 | 身份 | 接入 DSH 的方式 |
|---|---|---|---|
| **本插件** / oncall | `D:\sudy\myproject\dsh-oncall`（包在 `packages/dsh-oncall/`） | 你在做的产品 | `dsh.bundle.patch` 一行 `oncall` |
| **DSH** | `D:\sudy\github\deepseek-harness`（只读参考 checkout） | 宿主平台 | — |
| **superagent** | `D:\sudy\github\dsh-superagent-prototype` | DSH 团队发布的研究原型 | `dsh.bundle.patch` 五行 |
| **comet** | `D:\sudy\github\comet` | 独立产品（`@rpamis/comet`） | skill 文件 + 一行 hook 桥 |

三条身份事实，避免后续混淆：

- superagent 的 `README.md:3` 自述 **"Research prototype for reference only, not an official DeepSeek product"**；它**不在** DSH 的官方 bundle 清单里（[`official-bundles/src/bundles.ts`](file:///D:/sudy/github/deepseek-harness/packages/util/official-bundles/src/bundles.ts) 的 `OPTIONAL_BUNDLES` / `ON_DEMAND_BUNDLES` 均无此名）。
- superagent 的 `package.json:55` 要求 `engines.dsh: ^0.2.1-alpha.2`；本机运行的是 `dsh --version` → `0.2.1-rc.5`，该范围**满足**（同 major.minor.patch 的预发布才放行）。它的 peer 基线比本插件当前声明的 `^0.2.1-rc.3` 更老。
- comet 的 `package.json` 是 `@rpamis/comet` v0.5.2，MIT，作者 benym，与 DeepSeek 无组织关系。

## 二、三种接入方式，决定能力上限

这是本页最重要的一张表。三个项目看起来在做类似的事，但它们**在 DSH 里的接入位置不同**，能力上限因此不同。

| | bundle 插件 | hook 桥 | 纯 skill 文件 |
|---|---|---|---|
| 载体 | `package.json` 的 `dsh.bundle.patch` | `.dsh/cordis.patch.yml` 里插一行桥接包 | `.dsh/skills/`、instructions |
| 能拿到什么 | 全部 Cordis 服务（session、agent、llm、tools、worktree…） | 只能是 hook 事件（会话/提示/工具/停止/子代理这些时刻） | 只有提示词 |
| 能改路由/模型调用 | 能 | 不能 | 不能 |
| 能拦工具调用 | 能 | 能（`hooks-claude-code` 支持 block） | 不能 |
| 跨宿主可移植 | 不能 | 能（同一份 hooks.json 多宿主） | 能 |
| 典型代表 | 本插件、superagent | comet | comet 的 skill 主体 |

**三者的取舍是一句话：越靠下越硬，越靠上越通用。**

comet 的 DSH 适配层是这个判断的证据：`domains/skill/dsh-adapter.ts:222-223` 定义 `DSH_HOOK_ENTRY_ID = 'comet-workflow-guard'` 与 `DSH_HOOK_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'`——它确实往 DSH 的 Cordis patch 里插了一行，但插的是**桥接包**，把自己的 Claude Code 格式 hooks 翻译成 DSH 事件。它没有拿到 Cordis 服务面，只拿到 hook 时刻。

> 更正一处此前的口头判断：comet **是**接进 DSH 的，只是方式是"skill 文件 + hook 桥"，不是 `dsh.bundle`。它既不能改路由，也不需要改路由。

**对超级插件的意思**：本插件已经在最硬的一档。往"更通用"走是降级，不是升级。所以融合的方向只能是**在同一档里吸收别人的设计**，不能是把 comet 的 runtime 搬进来。

## 三、superagent：真正独有的只有四件事

**先把设计意图说清。** `docs/000-philosophy.md:5-7` 的核心原则是**"占用人最少注意力，给出最多价值"**——每条消息、每个通知、每个问题、每个设置、每个面板元素，都要按"它花掉谁多少注意力"来审判，不值就删。由此推出两条硬约束：**概念要少**（`:19`：一个业务需求变成某个概念的属性或一段提示词，不新增概念）、**设置要少**（`:20`：一个默认值能覆盖的场景不做成设置）。

它是照着这两条写出来的，不是功能堆出来的。这一点决定了它不能被"融合"——合进来就破坏了它的公理。

它的体量不小（Git 跟踪 216 个文件；110 个源文件约 1.52 万行；65 个测试文件约 1.5 万行；`docs/000`–`008` 共 9 篇编号文档；另有独立的 Web 面板）。但把它拆开，**DSH 原生已经覆盖了大部分**。真正独有的只剩下面四条，而且都在"会话之外"。

| 它做的 | DSH 原生有没有 | 判断 |
|---|---|---|
| 长任务无人值守多轮续跑 | **有**：`dsh-goal` + `dsh-goal-round-driver`（[`base/cordis.patch.yml:327-334`](file:///D:/sudy/github/deepseek-harness/packages/bundle/base/cordis.patch.yml)） | 不重造 |
| 多智能体共享任务板 | **有**：`dsh-agent-team` + `tool-agent-team`（同文件 `:366-372`） | 不重造 |
| 工作流编排 | **有**：`dsh-workflow-ptc` + `tool-workflow`（同文件 `:408-414`） | 不重造 |
| 定时触达 | **有**：`dsh-schedule`（可投递到新会话） | 不重造 |
| 建会话 + 指定目录/preset | **有**：`sessionController.create({ cwd, agentPreset })`（[`types.ts:268-278`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/types.ts)） | 直接调用 |
| 目录隔离 | **有**：`ctx.worktrees.create()`（[`tool-worktree/src/index.ts:39`](file:///D:/sudy/github/deepseek-harness/packages/experimental/tool-worktree/src/index.ts)） | 直接调用 |
| **① 外部事件源**（GitHub / 飞书 → 会话） | 无 | 独有 |
| **② 授权策略**（谁可以派活、批准到什么程度） | 无 | 独有 |
| **③ 独立部署形态**（自有 profile / 端口 3082 / stateDir / 守护脚本） | 无 | 独有 |
| **④ 交付回路**（PR、评论回执、话题回复） | 无 | 独有 |

它自己的文档也这么说：`docs/001-domain.md:62` 的「What is reusable」一节明确区分了"概念可复用"与"Source / Policy / Executor / Channel 属于某个部署"。

**结论**：superagent 的 Ticket 领域模型是**为独立部署服务的**，不是通用能力。本插件没有独立部署形态，抄它就等于凭空造一个没人用的领域模型。

### 值得吸收的三处（带位置）

| 设计 | 位置 | 为什么值得 |
|---|---|---|
| **按角色裁剪 agent preset** | `cordis.patch.yml:20-120`（worker）、`:125-193`（router） | 纯 YAML，零 TypeScript。用 `cordis:group` + `isolate` 把 shell / compaction / workflowEngine 各自隔离，再用 `disabled` 按平台二选一 |
| **两层工具限制**（这一层最容易漏） | preset 决定"有哪些"；代码 `restrict({ allow: WORK_TOOLS ∩ 已注册 })` 兜底"profile 后来加了也不给"（`src/app/sessions.ts:61-62`、`:289-297`） | 只写 preset 是不够的：profile 升级或别的插件插入工具行，preset 继承不到的那些行会漏进会话。它用第二层把"清单外的一律不给"写死。**本插件要做角色裁剪，必须照抄这两层** |
| **每个任务一个目录 + 一条 prepare 命令** | `src/executor/dsh.ts:238-262`、`:436` | 目录只准备一次，已存在即视为准备好；prepare 失败抛 `PrepareFailed` 且**刻意不自动重试**（`dsh.ts:276-281` 的注释写明：否则会把失败留下的脏目录当成准备好的工作区）。这条**错误语义**比代码值钱 |
| **同渠道退避而非换渠道** | `src/executor/dsh.ts:44-55`、`:548-576`、`src/app/retry-health.ts` | 瞬时错误（408/429/5xx/连接类）每个 key 最多 3 次，launch 5s→300s，回合失败发续跑消息 15/30/60s。跨渠道则完全没有：`resolveRoleModel` 只解析一个 provider/model（`src/app/role-models.ts:8-12`），`RetryHealth` 对 budget 重试**只做投影**（`retry-health.ts:1-2`） |
| **持久化副作用队列** | `src/app/effects.ts:61-74`、`:130-146` | 事务内 enqueue、commit 后执行、按 `(kind,key)` + generation 防旧尝试覆盖。通知类副作用可以照这个形状 |

第三行是产品分工的书面证据：superagent 一个 ticket 要跑几十轮，单轮失败率 p、轮数 n，一次跑完的概率约 (1-p)^n；p=2%、n=30 时只有约 55%。它没有跨渠道 failover，只能退避重试到天亮。**你降低的是它公式里的 p，而它自己不做这件事。**

### 明确不吸收

- `src/core/*` 的 Ticket / Mandate / Thread / Assignment：为独立部署造的领域模型，本插件无对应场景。
- `src/sources/github*`、`src/sources/feishu*`：平台适配，几百行，且要维护外部 API 版本。
- 2 秒一次的全量 pass 轮询：为"没人说话也要推进"设计；DSH 有 `schedule` 与 `goal-round-driver`，不需要自建心跳。
- 独立 stateDir + 自有端口 + 守护脚本：那是部署形态，不是插件能力。
- **统一 `danger-full-access`**（`src/app/sessions.ts:152`）：它每个 worker 都开满权限，因为它假设跑在专用 profile 里。本插件跑在用户自己的 profile 里，不能这么干。
- **硬编码工具 allow 名单**（`sessions.ts:61-62`、`:263`）：与平台和 DSH 版本强耦合——它的主 Session 名单写 `bash`，而 Windows 上 preset 启用的是 `tool-pwsh`（注册名 `pwsh`），DSH 的 `restrict` 对未知全局工具会抛错。这处**需要在真实 Windows profile 下复核**，但结论已经够清楚：名单要由注册表推导，不能手写。
- **自建 SQLite schema 与迁移**（`src/app/store.ts:71-120`、`migration.ts` 46KB）：本插件用 `ctx.storageDomain` 就够，不必自己管表。

## 四、comet：一个在仓库里的确定性 skill 运行时

**先摆规模**：1,580 个源文件、约 66.5 万行（`comet-native` 单域 10.05 万行、`comet-classic` 4.37 万行、`engine` 1.46 万行、`eval` 1.09 万行、`workflow-contract` 1.16 万行）。是 superagent（110 个源文件、1.52 万行）的 40 倍以上。**这个量级本身就给出了结论：它不可能被融合，只能被借鉴。**

它的自我定位见 [`ARCHITECTURE.md:190-194`](../../../comet/docs/architecture/ARCHITECTURE.md)：**只依赖 Node、自带确定性 Skill 引擎、能创作和分发 Skill、状态可恢复可校验的 Agent Skill 运行时平台。**

### 它和 superagent 不是一个物种

| | superagent | comet |
|---|---|---|
| 形态 | 常驻服务（自有 profile / 端口 / SQLite） | 仓库内运行时（CLI 命令 + 文件状态） |
| 谁驱动 | 定时轮询 + 外部事件源 | agent 按 skill 指令调用 CLI |
| 状态在哪 | SQLite（WAL）+ effect 队列 | 文件三分：用户态 / 机器态 / 审计流 |
| 状态机 | 7 个派生 stage | 一张转移表，多命令共用 |
| 恢复 | 重启扫 pending 重入队 | Checkpoint + Trajectory 精确回到断点 |

### 三条能脱离代码搬走的设计

1. **状态三分**（[`ARCHITECTURE.md:106-131`](../../../comet/docs/architecture/ARCHITECTURE.md)）：`.comet.yaml` 只放用户可改的字段；`.comet/run-state.json` 放 machine-owned 运行态（`run_id / skill_hash / current_step / iteration / pending`）；`.comet/state-events.jsonl` 是**追加式**审计流，记 event / source / from-to / effects，并明确"不取代状态文件，也不是第二个可编辑状态源"。
2. **机器态字段拒绝被写**（同文件 `:128`）：`comet-state set` 拒绝写 machine-owned 字段。**这条对 oncall 直接有用**：模型不该有能力改账本。
3. **一张转移表，多消费者**（同文件 `:129`）：`classic-transitions.ts` 的 TypeScript 转移表被 `comet-state transition`、`comet-guard --apply` 和归档路径三方共用，"共享同一份转移语义"。

第 1、3 条正是本插件账本的缺口：`bindings.ts` 只存"绑哪条链"，既没有用户态/机器态之分，也没有审计流。

### 明确不吸收

- **Skill Package 的加载/校验/哈希/快照**：DSH 已有 `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill`（[`base/cordis.patch.yml:312-319`](file:///D:/sudy/github/deepseek-harness/packages/bundle/base/cordis.patch.yml)），它做的是 catalog 与按需加载。不需要第二套包格式。
- Supervisor Change（子 Change DAG + worktree 并行）：DSH 的 `agent-team` 已覆盖。
- Eval 平台（Rubric / Pass@k）、Dashboard、Bundle 分发：属于 skill 生态，不是路由。

## 五、设计意图：三个中心，三种纪律

前三节讲"能拿什么"，这一节讲**为什么不能混**。

| | 中心 | 纪律 | 明确拒绝的 |
|---|---|---|---|
| **superagent** | 领域模型：谁授权、什么算一件活 | 概念要少：业务需求变成概念的属性或提示词，不新增概念（`000-philosophy.md:19`） | 拒绝 Ticket 状态跟随 DSH 会话（`001-domain.md:56`：Ticket 可被交接、恢复、由多个 Executor 跑）；拒绝策略变更时取消进行中的工单（`:58`：半成品比保留更糟）；拒绝用自由文本推断"在等人"（`:60`） |
| **comet** | 确定性：状态可校验、可恢复 | 机器状态不可被 agent 写；决策是 `Readonly` 入参的纯函数 | 拒绝"agent 按文档自由发挥，没有执行/恢复/校验机制"（`ARCHITECTURE.md:56`）；拒绝第二份可编辑状态源（`:130`） |
| **本插件** | 调用可靠性：这次请求能不能成 | 每次尝试可解释，每个失败有下一跳 | 拒绝取消请求（只能重定向，见[扩展面设计建议](extension-surface.md) 1.1） |

三者不是同一件事的三份实现，而是**三个不同问题**的答案：谁授权、状态可不可信、这次调用成不成。

**融合会乱搞的唯一方式，就是把三个中心并成一个。** 把 Ticket 塞进 oncall，superagent 的"概念要少"当场破坏，而 oncall 根本没有授权问题——DSH 已有 `permission-presets`。

### 正确接缝：superagent 自己给出了答案

`001-domain.md:41` 原文：

> The Executor, with its Sessions and directories, is outside the domain and connects through Assignments.

Executor 不在领域里，它通过 Assignment 接进来。**本插件比 Executor 更靠外**：它不拥有会话，只拥有"这次调用走哪条渠道"。

所以融合的方向不是"oncall 吸收它们的领域"，而是"**oncall 是它们脚下的那一层**"。superagent 的一个 worker 会话、comet 的一次 Run，最终都是一串 LLM 调用；每一串都需要一条换得动的渠道。

### 三条能借的纪律（借纪律，不借结构）

| 纪律 | 出处 | 用在本插件哪 |
|---|---|---|
| **机器状态拒绝外部写** | comet `comet-state set` 拒写 machine-owned 字段（`ARCHITECTURE.md:128`）；`protected-run-file.ts` 用原子写 + 文件身份校验保护运行态 | 账本的机器态只能由插件写，模型与浏览器只读 |
| **决策是只读入参的纯函数** | comet `resolver.ts:4-17` 的 `DeterministicResolver`（`pkg`/`state`/`context` 全 `Readonly`）；`guardrails.ts:7-20` 的 `checkAction(action, state, guardrails, confirmations) → GuardrailResult` | 正是[分层与模块架构](super-plugin-architecture.md) L2 的准入条件；`router.ts` 已接近，缺的是"入参只读"的强制 |
| **概念与设置要少** | superagent `000-philosophy.md:19-21` | 加旋钮前先问：能不能是某条链的一个字段？能不能是一段提示词？ |

第三条对本插件是一记提醒：`config.ts` 695 行、`chainSchema` + `handoffSchema` + `Config` 三套形状。superagent 用 11 个注入服务、5 个 patch 行做到量级相近的事。不是说配置该砍，而是**再往上加之前，先按 superagent 的标准审一遍**。

## 六、本插件已经有的，别低估

写方案前先认账——这些是实现里已经成立、且 superagent 没有的：

| 能力 | 位置 | 说明 |
|---|---|---|
| 未绑定会话的默认链回落 | `src/chain.ts:376` `chainForSession` | 任何会话（含 schedule、agent-team、subagent 创建的）都在默认链上跑 |
| 每会话绑定，持久化 | `src/bindings.ts`（`ctx.storageDomain`） | 无存储时退化为内存，且如实告知浏览器 |
| 跨渠道失败切换 | `index.ts` 的 `agent/request` + `agent/request-error`（均 `prepend: true`） | 最外层，能覆盖内层 `llm-retry` 的裁决 |
| 熔断、退避、预检、健康探测、中文通知 | `breaker.ts` `backoff.ts` `precheck.ts` `health.ts` `notice.ts` | 见[扩展面设计建议](extension-surface.md) 1.3 |
| 会话接力（delegate / finish / newSession / facts） | `src/handoff-tool.ts` | `relay()` 在 `:488` 调 `controller.create({ cwd, reusable: () => false })` |
| 右栏 Agent Fleet | `src/client/fleet/` | 全局/单会话两视图 |

**要注意的现状**：`src/index.ts` 仍是 1166 行，四个职责叠在一起（注册、接线、解释器、Remote）。这是所有后续工作的前置约束，不是风格问题。

## 七、目标形态：一个包，一个核，两个面

> 本页写成时的目标形态**未含 ingress**。2026-11-11 起入口是 V0 前门，目标形态变为「一个包、两个面（route / ingress）、三层粒度」；见状态说明与[路线笔记](../../.agents/notes/implemented/2026-11-11-oncall-product-route.md)。

```
packages/dsh-oncall/
  cordis.patch.yml          一行 oncall（不拆行）
  src/
    core/                   纯函数 + 两张表，不认识任何 DSH 事件
      channels.ts           resolve(candidate) → 物理 route；健康/熔断/预算
      sessions.ts           会话账本：绑定、接力、失败序列、Checkpoint
    faces/                  两个薄壳，只做事件翻译
      route.ts              agent/request + agent/request-error   （搬出来）
      session.ts            preset / 目录 / 新会话绑定继承        （新增）
    notice.ts  config.ts  rules.ts  client/                      （不动）
```

**为什么仍然一行 patch**：行 id 就是设置命名空间（`cordis.patch.yml:3-4` 的注释写明 `ns: entry.options.id`）。拆成两行等于把配置劈成两个 ns，用户要在两处保存、两处校验。superagent 拆五行是因为它的 source 真的各有独立生命周期（飞书要单独配 bot）——本插件没有这个必要。

**依赖方向只有一条**：`faces → core`。core 不 import `ctx`、不读 `Date.now()`、不 append 事件——这是[扩展面设计建议](extension-surface.md) 1.3 已经定下的纯函数判据，继续沿用。

### 两个面各自负责什么

| 面 | 今天 | 目标 |
|---|---|---|
| **route 面** | 已有，全在 `index.ts` | 原样搬进 `faces/route.ts`，行为不变 |
| **session 面** | 只有 `newSession` 接力 | 补三件事：① relay 带 `agentPreset`；② 可选独立目录（走 `worktrees`）；③ **非本插件创建的会话也按规则继承绑定** |

第三件事是"超级"的技术兑现。今天的 `newSession` 只能让**本插件亲自开的**会话继承绑定；`schedule` 定时任务、`goal-round-driver` 的续跑、`agent-team` 拉起的成员，都是 DSH 原生创建的，绑定为空 → 回落到默认链。所以需要一个**绑定规则**：

```
bindingRule:
  byPreset: { <presetId>: <chainId> }   # 按 agent preset 指定链
  byCwd:    { <glob>: <chainId> }       # 按工作目录指定链
  default:  <chainId>
```

实现位置是已有的 `agent/created` 监听（`index.ts:267`）：创建时算一次规则，写进 `bindings`。**不需要新扩展点。**

### 为什么不做 trigger 面

那是本方案里最容易做错的一步。DSH 的 `schedule` 已经能把指令投递到**新会话**，`goal-round-driver` 能在同一会话里续跑，`agent-team` 能拉起子代理。再自建一个 poller，等于在 DSH 里放第二个调度器，且要和 `schedule` 抢"谁拥有触发"。

正确做法：**让 DSH 原生的触发器开出来的会话，自动落在你想要的链上**（上面那条 bindingRule）。触发是宿主的事，路由是你的事。

### 融合后能实现什么：三档效果

| 档 | 用户能感知到什么 | 依赖谁 | 什么时候能做 |
|---|---|---|---|
| **一｜路由底座** | 任何 DSH 会话（含 `schedule` / `goal` / `agent-team` 开的）都跑在指定链上；第一跳失败自动切；切了有中文通知；右栏看得见换了谁 | 只有本插件 | 现在，P1+P2 |
| **二｜可恢复长任务** | 一个跨 N 个 session 的任务，中断后新会话能回答"走到哪、试过谁、为什么切、下一步读什么" | 本插件 + comet 的状态三分（**纯设计，不搬代码**） | P3 |
| **三｜方法可换** | 换工作方法不改插件，只换一份 skill | DSH 原生 `dsh-skill` | 能做，但不该由本插件做 |

**档二才是这次融合真正的收获。** 今天的账本只记两件事（`chain`、`retries`）；档二要求它变成三份：

| 份 | 内容 | 谁能写 | 对应 comet |
|---|---|---|---|
| 用户态 | 绑哪条链、每路由重试几次 | 用户/浏览器 | `.comet.yaml` |
| 机器态 | 候选游标、接力预算、失败序列、检查点 | **只有插件**（模型不可写） | `.comet/run-state.json` |
| 审计流 | 每次切换 / 跳过 / 熔断一条，追加不改 | 只有插件 | `.comet/state-events.jsonl` |

实现仍用 `ctx.storageDomain`，不引入文件状态。借的是**三分法**和"机器态拒绝外部写"这两条纪律，不是它的实现。

**一个反直觉的结论**：融合的价值不在功能叠加。superagent 和 comet 都不需要 oncall 的功能——它们需要的是**稳定渠道**。所以"超级插件"的正确形态不是"我功能更多"，而是**别人愿意依赖我**：档一做到，你是所有会话的底座；档二做到，你是可恢复长任务的底座；档三本来就属于宿主。

## 八、分四步落地

每一步都能独立验收，且都能停。

### P0｜拆，不改行为

把 `index.ts` 的路由核搬进 `core/`、`faces/route.ts`，`index.ts` 只留装配。

- 判据：**改动前后 `npm test` 五套件数字完全一致**（unit / client-controller / remote / handoff-relay / run），37 个 Loader 组合场景 0 失败。
- 这是唯一一步"不改行为"，所以它能证明你没拆坏。
- 风险：`index.ts` 里 9 处发言点（3 `steer` + 6 `append`）与四套去重键各自为政（见[扩展面设计建议](extension-surface.md) 1.5），搬迁时**不要顺手改语义**，先原样搬。

### P1｜白捡的 preset

在 `cordis.patch.yml` 追加两行 `@deepseek-ai/dsh-agent-preset`，形状照 superagent：`id` / `name` / `description` / `order` / `plugins[]`。schema 见 [`agent-preset/src/index.ts:16-24`](file:///D:/sudy/github/deepseek-harness/packages/preset/agent-preset/src/index.ts)。

- **必须做两层，只做第一层等于没做**：preset 决定"有哪些"，还要在代码里用 `restrict({ allow })` 挡住"profile 后来加了也不给"。superagent 的教训见第三节「两层工具限制」。
- 判据：新会话能选到该 preset；工具面按预期裁剪（写一个用例断言"执行器 preset 里没有 write 工具"）。
- 代价：preset 部分**零 TypeScript**，第二层是几行代码。

### P2｜会话面三件事

1. `handoff-tool.ts` 的 `relay()` 增加 `agentPreset` 参数——`sessionController.create` **本来就支持**这个字段（`types.ts:276`），现在只是没传。
2. 增加可选 `workdir: 'inherit' | 'fresh'`；`fresh` 走 `ctx.worktrees.create()`，失败要显式报错而不是回落到继承目录。
3. `agent/created` 上实现 `bindingRule`，让外部创建的会话继承绑定。

- 判据：一个 `schedule` 创建的会话，按 `byPreset` 落在指定链上；一个 `newSession` 接力后仍带原绑定（今天已有的用例不能退化）。

### P3｜账本

按 comet 的词汇扩 `sessions.ts` 的存放内容：现在只有 `chain` 与 `retries`，增加 `checkpoint`（走到哪）、`attempts`（失败序列）。**只加读取者需要的字段，不做通用 workflow runtime。**

- 判据：右栏能显示"这个会话在链 B 上，换过 2 次渠道，最近一次失败是 429"。

## 九、明确不做

| 不做 | 理由 |
|---|---|
| Ticket / Mandate / Thread 领域模型 | 为独立部署服务；本插件没有独立部署形态 |
| GitHub / 飞书事件源 | 平台适配成本高，且与"路由"无关 |
| 自建调度器 / poller | DSH 已有 `schedule` + `goal-round-driver`；自建会抢所有权 |

> **前三条已于 2026-11-11 推翻，其余保留。** 理由差别很重要：领域模型仍不抄（superagent 的为独立部署而造），但 Case/Mandate 是自己的领域；事件源必须做（产品前门）；poller 只读外部变化、不驱动会话，不抢宿主所有权。详见[路线笔记](../../.agents/notes/implemented/2026-11-11-oncall-product-route.md)。
| 把 comet 的 runtime 搬进来 | 它是 hook 桥 + skill 文件，拿不到 Cordis 服务面；搬进来只得其形 |
| Eval 平台（Pass@k） | 属于 skill 演进，不是路由 |
| 拆多行 patch | 会让设置命名空间分裂 |
| 与 superagent 同 profile 混装 | 两者都在 `agent/request` 上 `prepend: true`（superagent 见 `src/app/role-models.ts:31`），首请求的 provider/model 谁覆盖谁取决于注册顺序，且不报错。要验证顺序再谈共用 |

## 十、待验证 / 待决

1. **`agent/request` 双 prepend 的先后顺序**：需要一次真实 Loader 组合实验确认，不能靠读代码推断。这是"能不能和 superagent 同 profile"的唯一技术前提。
2. **`agent/created` 的时机**：绑定必须写在首个 `agent/request` 之前。要确认该事件确实早于首请求（`index.ts:267` 的现有用法只做了别的事）。
3. **preset 行与 `oncall` 行的配置归属**：preset 行没有 settings ns，但 session 面要读 `bindingRule`——确认规则放在 `oncall` 行而不是 preset 行。
4. **是否提供 `bindingRule` 的 UI**：可以只做配置不改界面，等有人真的用再补。

## 十一、路径速查

复制用：

```
本插件    D:\sudy\myproject\dsh-oncall
DSH       D:\sudy\github\deepseek-harness          (只读)
superagent D:\sudy\github\dsh-superagent-prototype  (只读)
comet     D:\sudy\github\comet                      (只读)
```

关键文件：

- 本插件接缝清单：[扩展面设计建议](extension-surface.md) 1.1（5 个扩展点，全在 `src/index.ts`）
- 本插件能力边界：[DSH 能力边界](dsh-capability-boundary.md) 第七节
- superagent 领域模型：`docs/001-domain.md`、`docs/003-execution.md`
- superagent 扩展点用法：`cordis.patch.yml`（五行插入 + 两套 preset）
- comet 状态词汇：`CONTEXT.md`
- comet 的 DSH 适配：`domains/skill/dsh-adapter.ts`
