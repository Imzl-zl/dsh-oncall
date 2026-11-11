---
title: "DSH On-call — 分层与模块架构"
status: "proposed"
kind: "architecture-proposal"
last_updated: "2026-11-09"
---

# DSH On-call — 分层与模块架构

## 摘要

**五层、一条依赖规则、一个可执行的守卫。** 目标不是"看起来分层"，而是**新加第 60 个文件时，放错层会立刻报错**。

三条结论：

1. **同构核已经存在，只是没有被命名**。浏览器的 `client/controller.ts` 直接 `import { effectiveChains } from '../chain.ts'`、`client/chip.ts` 直接引 `../routes.ts` 与 `../defaults.ts`。也就是说 `chain / defaults / routes / rules / timeline / breaker / skip-plan / precheck` 这一组**宿主与浏览器共用**。分层要做的第一件事就是把它命名为 **L2 同构核** 并锁死。
2. **现有两处真违规**：`config.ts → rules.ts → config.ts` 是一处**值依赖成环**（`config.ts:56` import `structuralViolations`，`rules.ts:20` 又 `import type` 回 `config.ts`）；`index.ts`（1167 行）同时承担装配、路由解释器、工具注册、Remote 四件事。这两处是本页要修的，其余文件基本已经在正确的位置上。
3. **职责靠端口切开，不靠文件夹**。L4 能力层只通过三个端口接触外部世界（渠道、账本、时钟），这样 90% 的失败切换逻辑可以在没有 DSH 的情况下测。

本页只定义结构与迁移次序，不改代码。

## 一、约束（为什么是这个形状）

套模板是没有意义的，这个形状是被四条真实约束压出来的：

| 约束 | 事实 | 对结构的后果 |
|---|---|---|
| **两个编译程序** | `tsconfig.json` 编宿主（产出类型），`tsconfig.client.json` 只 `include: src/client`，但会顺着 import 把宿主纯模块拉进来 | 必须显式区分"能两边跑"与"只能宿主跑"的模块，否则浏览器侧会引到 Node 专有代码 |
| **五个生命周期时刻** | `agent/request`、`agent/request-error`、`agent/pre-step`、`agent/turn-stopping`、`session/event`（见[扩展面设计建议](extension-surface.md) 1.1） | 新增能力只能进"决策数据"，不能新增监听器——决定了 L2 必须是纯函数 |
| **一个设置命名空间** | 行 id 即 `ns: entry.options.id`（`cordis.patch.yml:3-4`） | 配置形状（L1）与跨字段校验（L2）必须分开，否则校验会反向依赖 schema |
| **两半共用同一份默认值** | `client/controller.ts` 从 `../defaults.ts` import 了 9 个常量 | 默认值必须是零依赖的 L1，否则两半会各抄一份并漂移（`client/validate.ts` 已有这个隐患） |

## 二、五层

只能向下依赖，允许跳层。

```
L5  面        Cordis 事件 / 工具注册 / Remote / 浏览器
      ↓
L4  能力      有 I/O 的服务：渠道表、会话账本、通知
      ↓
L3  状态      每 step / turn 的内存账本（可快照）
      ↓
L2  决策      纯函数：事实 → 裁决
      ↓
L1  契约      类型、常量、默认值、wire 格式、配置 schema
```

### 每层的准入条件（机械可查）

| 层 | 唯一准入标准 | 禁止 |
|---|---|---|
| **L1 契约** | 只有类型、常量、字面量与纯构造 | 任何函数调用外部、任何 import 自 L2 以上 |
| **L2 决策** | `(不可变事实) → 裁决数据` | `ctx`、`Date.now()`、`Math.random()`、写会话、`await` |
| **L3 状态** | 内存账本，能被 JSON 快照与还原 | 文件 / 网络 / `ctx` |
| **L4 能力** | 有 I/O，但只经**端口**接触外部 | 直接 `ctx.on(...)` 注册事件、直接读 `config` 全局 |
| **L5 面** | 唯一允许 `ctx.on` / `ctx.tools.register` / `@Remote` 的层 | 任何业务判断（判断必须在 L2/L3 产出） |

### L2 再分两档（这是本架构的关键取舍）

浏览器的编译程序会把 L2 拉进去，所以 L2 内部还要再切一刀：

| 分档 | 判据 | 现有文件 |
|---|---|---|
| **L2a 同构核** | 零 `@deepseek-ai/*` import（连 `import type` 都没有） | `routes.ts` `defaults.ts` `rules.ts` `chain.ts` `timeline.ts` `breaker.ts` `skip-plan.ts` `precheck.ts` |
| **L2b 宿主决策** | 只 `import type` 自 `dsh-llm` / `dsh-agent` / `dsh-session` | `router.ts` `state.ts` `backoff.ts` |

**为什么重要**：`router.ts` 只 `import type { LlmCallConfig, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'`（`router.ts:34`），类型在编译期擦除，所以它其实**也能被浏览器引用**。今天没引，是因为没必要。这条边界留着，将来面板要"预览这次会切到哪条渠道"时可以直接复用裁决函数，不用重写一遍。

## 三、模块（16 个，每个一个变更理由）

模块 = 一个职责单元，不是文件夹。列"吸收哪些现有文件"是为了让迁移可机械执行。

### L1 契约

| 模块 | 吸收 | 唯一职责 | 明确不含 |
|---|---|---|---|
| `contract` | `types.ts`(169) `handoff-wire.ts`(132) `release.generated.ts`(4) | 跨端共享的形状与 wire 键 | 任何逻辑 |
| `defaults` | `defaults.ts`(385) | 全部默认值 + 开关码表 | 校验（那是 `config-rules`） |
| `route-id` | `routes.ts`(88) | 路由身份：一个 `provider/model` 怎么变成键 | 名称显示（那是 `client/naming`） |
| `config-shape` | `config.ts`(695) **去掉** `assertStructural` 的调用 | schemastery schema 与导出类型 | 跨字段规则 |

> `config.ts` 现在有 695 行，其中 `Config` 在 `:380`、`chainSchema` 在 `:172`、`handoffSchema` 在 `:366`、`assertStructural` 在 `:686`。第 686 行那个函数**要搬走**，见第五节。

### L2 决策

| 模块 | 吸收 | 唯一职责 | 明确不含 |
|---|---|---|---|
| `config-rules` | `rules.ts`(259) | 跨字段校验：`structuralViolations` | 默认值（读 `defaults`，不重写） |
| `chain-model` | `chain.ts`(428) | 命名链、legacy 迁移、`chainForSession` 回落 | 路由裁决 |
| `routing` | `router.ts`(608) `skip-plan.ts`(132) `precheck.ts`(64) | `resolveStartIndex` / `decideBeforeInner` / `decideAfterInner` / 跳过计划 | I/O、通知、计时 |
| `resilience` | `breaker.ts`(116) `timeline.ts`(186) `backoff.ts`(81) | 熔断判定、24 格窗口、退避**计划** | 真正 `await` 等待（那在 L4） |
| `step-state` | `state.ts`(413) | 每 step 的候选游标与条件快照 | 持久化 |

### L4 能力

| 模块 | 吸收 | 唯一职责 | 端口 |
|---|---|---|---|
| `channels` | `health.ts`(290) `probe.ts`(214) `connectivity.ts`(195) | 渠道表：健康、探测、零 token 连通性 | `ChannelPort`、`ClockPort` |
| `sessions` | `bindings.ts`(264) `lineage.ts`(179) `handoff.ts`(762) | 会话账本：绑定、接力预算、失败序列 | `LedgerPort` |
| `notify` | `notice.ts`(296) | 中文通知构造（14 个构造函数 + `codeLabel`） | `NotifyPort` |
| `update` | `update.ts`(215) | 版本检查 | `ClockPort` |

### L5 面

| 模块 | 吸收 | 唯一职责 | 明确不含 |
|---|---|---|---|
| `face-route` | `index.ts` 路由段（约 `169-650`） | 两个 `agent/request*` 监听器 + 按裁决执行副作用 | 注册装配、Remote |
| `face-tool` | `handoff-tool.ts`(842) | `handoff` 工具的四个动作 | 账本实现（在 `sessions`） |
| `face-remote` | `index.ts` Remote 段（约 `774-1166`） | 7 个 `@Remote` 方法的薄壳 | 计算 |
| `bootstrap` | `index.ts` 剩余部分 | Cordis 装配、生命周期、依赖注入 | 任何业务判断 |
| `ui` | `client/**`（约 11k 行） | 面板与右栏 | 业务规则（只读 L1/L2） |

### `index.ts` 拆完后的目标形状

```
src/
  l1/  contract.ts defaults.ts route-id.ts config-shape.ts
  l2/  config-rules.ts chain-model.ts routing.ts resilience.ts step-state.ts
  l4/  channels/ sessions/ notify.ts update.ts
  l5/  bootstrap.ts face/route.ts face/tool-handoff.ts face/remote.ts
  client/            （不动，只加一条 import 约束）
tests/
  layers.mjs         （新增，第六套件）
```

## 四、三个端口（让 L4 可测）

分层最容易做成"文件夹好看、代码照样耦合"。真正的分界是这三个接口——L4 只认它们，不认识 Cordis：

```ts
/** 渠道解析：候选 → 可调用的物理路由。生产实现包 ctx.llm.resolveCallConfig。 */
export interface ChannelPort {
  resolve(candidate: Candidate): Promise<ResolvedRoute>
}

/** 会话账本：读写一份绑定。生产实现包 ctx.storageDomain。 */
export interface LedgerPort {
  read(sessionId: string): Promise<SessionBinding | undefined>
  write(sessionId: string, binding: SessionBinding): Promise<void>
}

/** 通知：一条中文消息进会话。生产实现包 session.append / agent.steer。 */
export interface NotifyPort {
  emit(sessionId: string, message: UserMessage): void
}
```

**收益是可量化的**：今天测一个"第一跳 429 → 切到第二个候选 → 再 401 → 熔断"的完整链路，要在 `run.mjs` 里起真实 Loader。有了 `ChannelPort` + `ClockPort`，同样的链路是三个假实现 + 一个纯函数，毫秒级。

**代价**：多一层间接。这个代价只在有第二个实现时才值得付——而这里**已经有**：`bindings.ts` 本身就有"无 storageDomain 时退化为内存"的第二实现（见该文件头注释），这正是端口存在的证据，不是预支的抽象。

## 五、要修的两处

### 5.1 `config ↔ rules` 成环

```
config.ts:56   import { structuralViolations } from './rules.ts'                          ← 值依赖
rules.ts:20    import type { HandoffConfig, HealthConfig, NamedChain } from './config.ts' ← 反向
chain.ts:31-33 import type { ChainConfig, NamedChain, Strategy, Candidate, SwitchOn } from './config.ts'
```

`config.ts:686` 的 `assertStructural` 是**唯一**让 schema 文件反向依赖校验逻辑的原因。修法一步：

1. `assertStructural` 从 `config.ts` 搬到 `l2/config-rules.ts`；
2. `config-shape.ts` 不再 import `rules`；
3. 调用点（`index.ts` 里注册前的那次校验）改为 `import { assertStructural } from '../l2/config-rules.ts'`。

修完后依赖是单向：`config-rules → config-shape`。`chain.ts` 对 `config.ts` 的 `import type` 保留，因为类型方向是对的。

### 5.2 `index.ts` 四合一

`index.ts` 1258 行、五个职责：注册（`install` / `installHandoff`）、接线（读 config、读 bindings、取 projections）、入口接线（`installIngress`，2026-11-11 新增）、解释器（按裁决执行副作用）、Remote（7 个方法）。拆法见第三节的表，**按"谁能改它"切**：

- `face-route` 只在路由语义变时改；
- `face-remote` 只在浏览器要新查询时改；
- `bootstrap` 只在 DSH 装配变化时改。

今天的痛苦是它们共用一次改动：加一个面板查询要读 1258 行找位置。入口接线已经落在里面，所以 M2 搬家时要把它一并切出去。

## 六、守卫：`tests/layers.mjs`

分层不写成测试就等于没写。这个脚本解析源码 import，三条断言，跑在 `npm test` 里：

```
断言 1  无环：模块图不允许 cycle（当前会抓到 config ↔ rules，修完后归零）
断言 2  只能向下：l2 不得 import l4/l5，l1 不得 import l2 以上，client 只可 import l1/l2
断言 3  纯性：l1/l2 的文件里不得出现 ctx. / Date.now( / Math.random( / .append( / .put(
```

实现量约 120 行，与现有探测脚本同形（都用 Node 内置 `fs` + 正则，无新依赖）。它拦的正是这一类事故：**有人在 `router.ts` 里顺手写了个 `Date.now()`**——这类改动让决策函数不可复现，而现有五套件抓不到。

> 这是"守卫必须先红"的场合：先让断言 1 在 `config ↔ rules` 上报红，再修，再转绿。归零本身不是证据，**红过**才是。

## 七、迁移次序

五步，每步都能单独停，且都有可执行验收。

| 步 | 动作 | 验收 |
|---|---|---|
| **M0** | 写 `tests/layers.mjs`，只开断言 1 | 在 `config ↔ rules` 上报红（证明守卫生效） |
| **M1** | 搬 `assertStructural` 到 `config-rules`，接进 `npm test` | 断言 1 转绿；五套件数字不变 |
| **M2** | 建 `l1/` `l2/`，按第三节的表移动文件，只改 import 路径 | 断言 1/2/3 全绿；`npm test` 五套件数字不变；`tsc -p tsconfig.client.json` exit 0 |
| **M3** | 拆 `index.ts` → `bootstrap` + `face/route` + `face/remote` | 同上；37 个 Loader 组合场景 0 失败 |
| **M4** | 抽 `ChannelPort` / `LedgerPort` / `NotifyPort`，给 L4 补三个假实现用例 | 新增用例能覆盖"429→切换→401→熔断"整链，且不启 Loader |

**M2 是纯搬家**：只改路径不改语义。这一步必须一次做完，因为半搬状态会让两套 import 同时存在。M0/M1 可以先单独提交，风险几乎为零。

## 八、与融合方案的关系

本页只解决"内部怎么摆"。能力层面做什么、不做什么，见[超级插件融合方案](super-plugin-merge.md)：

- 那份文档的"一个核两个面"= 本页的 L2（核）+ L5 的两个 `face`；
- 那份文档的 P0「拆，不改行为」= 本页 M0–M3；
- 那份文档的 session 面新增（preset / 目录 / `bindingRule`）= 本页 `l5/face/session.ts` + `l4/sessions` 的扩展，**不触碰 L2**。

顺序上建议先做本页 M0–M2，再做那份文档的 P1/P2。理由：`bindingRule` 要改的正是 `agent/created` 的接线，而那块今天埋在 1258 行里。
