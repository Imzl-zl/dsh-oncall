---
title: "DSH Model Desk — Agent Fleet 能力复核与下一会话实施交接"
status: "proposal"
kind: "handoff-brief"
last_updated: "2026-10-23"
---

# Agent Fleet 能力复核与下一会话实施交接

## 摘要

P1（Agent Fleet 右栏 + 配置页修正）已落地并通过测试，但设计文档里的“DSH 原生能力”假设尚未逐项回到源码求证。本页记录 2026-10-23 的复核结果、每项 keep / adjust / replace / remove、文件级实施计划、验证路径，以及下一会话可直接粘贴的提示词。

**本轮没有改源码**；下一会话按本页实施，目标是“逻辑语义清晰、实现优雅、UI 美观、尽量用 DSH 原生能力、不绕弯路”。

## 一、当前基线（实跑）

**工作树**：`master`，P1 未提交改动仍在（`apply/chain/chip/index/locales/pipeline/styles`、两套测试、`fleet/`、设计文档、原型、截图）。下一会话先 `git status` / `git diff`，不要 reset、checkout 或覆盖。

**基线测试**（干净串行，运行的是现有 `lib/client.js`）：

```text
203 unit test(s) passed
102 client-controller test(s) passed
21 remote test(s) passed
35 scenario(s), 0 failure(s)
```

unit 套件中途还会打印 `59 unit test(s) passed`，那是中途快照；总数以最后 203 为准，不能相加。原始日志：`.sessions/baseline-npm-test.log`。

**指定 host tsc**：无输出，`EXIT:0`；命令见 §6.1。

**客户端半包有独立 tsc**：`packages/dsh-model-desk/tsconfig.client.json`（DOM lib、`noEmit`）已接进 `bundle`；`npx tsc -p packages/dsh-model-desk/tsconfig.client.json` 当前 exit 0。`tsconfig.json` 仍 `exclude` `src/client`，两份工程分开。

**复核轮未做（实施轮已补跑，见 §1.1）**：`npm run bundle`、`node --check`、浏览器实测、加载器组合重跑。

### 1.1 实施结果（2026-10-23 夜，已落地）

- 代码：`client/fleet/` 的 `controller.ts`（`pause()/resume()` + `fleetListTimeout`）、`useFleet.ts`（`visible` 驱动调度、F-07 行号注释）、`index.ts`（传 `tab.visible`）、`view.ts`（`Tooltip`/`DisclosureRow`、共享导轨 + 流动点）、`styles.ts`（两个 `@keyframes`、暂停/减弱动效、窄栏行排版）、`locales.ts`（zh/en 超时文案）。
- 测试（干净串行，实跑）：`207 unit` / `108 client-controller` / `21 remote` / `35 scenarios, 0 failure`；指定 host tsc 无输出；`node --check lib/client.js` 通过。（客户端半包当时无独立 tsc；2026-10-24 起有 `tsconfig.client.json`，见 §一。）
- 浏览器（隔离 home + 新版桌面运行时，端口 3499）：1440 右栏 648、1025 左栏展开 345、801 右栏 345、全屏列 920；22 个真实顶层会话，数据范围行 `已加载 20 / 22`；4f20 会话 8 个 chip + `+5`（catalog 13）；`DisclosureRow` 头 28px、标题 11.5/16；Tooltip 焦点气泡；键盘 Enter 折叠；复制→“已复制”；子会话侧栏打开（`preferNewPane` 分栏）；`prefers-reduced-motion` 下两个动画均为 `none`；`data-visible=false`/`data-page-hidden=true` 下 `animation-play-state: paused`；DOM 无 `position: fixed`（Tooltip 气泡除外）、无遮罩、无自绘关闭/全屏。截图见 `docs/assets/ui/fleet-cap-*.png`。
- 环境事实：本仓库 `devDependencies` 已跟只读 checkout 对齐到 `0.2.1-rc.3`（桌面仍装 `0.2.1-rc.2`，仓库领先一拍）；浏览器验证用 npm 宿主起隔离 home，不再靠桌面运行时。旧宿主拒绝新运行时日志（`job/registered` → `gateway/internal`）的差异已随对齐消失。页面每次以“新会话”加载会创建一条空白草稿会话，因此不同截图的顶层行数会是 22 / 23。
- 未在浏览器覆盖：空 home、首屏 list 失败（真实宿主上无法只断 list：拦截会连模块加载一起破坏）、运行中子节点的流动点（隔离 home 里没有 running 会话；流动点用样式探针 + 组件测试验证 1.8s/暂停/减弱动效，生产数据下未出现）。这三项由组件测试覆盖，不声称已做浏览器验证。

**DSH checkout**：`git status --porcelain` 为空；未改。运行包为 `@deepseek-ai/dsh* 0.2.1-rc.3`，源码核对使用 `D:\sudy\github\deepseek-harness` HEAD `687f282e86`。

## 二、复核方法与证据范围

核对的符号范围：

- 右栏注册与导航：`sidebarRightTabs`、`sidebar.right.pane.tab`、`SidebarRightTabParamsMap`、`openTab`、`openResource`、`split`、`float`、`focus`、`toggleFullscreen`、`AppFrame` drag、`columns.ts`、`autoFullscreen`。
- 数据 hooks：`useSessions`、`useSessionStatus`、`useWorkspaces`、`subagentCatalog`、`subagentTiming`、`tokenUsage`、`contextPressure`、`refreshProjections`、`SessionListState`、`SessionListSnapshot`、`WorkspaceSnapshot`。
- 打开会话：`uiWorkspace.openSession`、`sessions.subagentAddress`、`subagentChatAddress`、`SUBAGENT_CHAT_ADDRESS`。
- 原语：`Tooltip`、`DisclosureRow`、`SegmentedControl`、`Switch`、`Input`、`Modal`、`RiskConfirmation`、`Tag`、`StateDot`、`Button`。
- 实验包：`agent-team`、`client-ui-agent-team`、`agent-team-profile`。
- CSS 注入：`ROUTER_CSS` / `FLEET_CSS` 的 string/array 形状。

规则：设计文档是方向，不是 API 真值；源码优先。找不到不等于不支持；本页只在有明确公开接口/导出证据时写“没有原生路径”，并附搜过的符号和 `file:line`。

## 三、能力复核表

| # | 需求 / 设计假设 | 原生 API 或组件 | 源码 file:line | 当前实现 | 结论 |
|---|---|---|---|---|---|
| 1 | 右栏类型必须走原生注册表 | `sidebarRightTabs.register` / `SidebarRightTabDefinition` | [`tab-registry.ts:94-139`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L94)、[`:253`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L253) | [`fleet/index.ts:183-201`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L183) | **keep** |
| 2 | 正文席位是 keyed `sidebar.right.pane.tab` | `SlotMap['sidebar.right.pane.tab']` | [`contract/slots.ts:59-78`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L59)、[`index.ts:203-219`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts#L203) | [`fleet/index.ts:202-218`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L202) | **keep** |
| 3 | 导航参数用 `SidebarRightTabParamsMap`，默认 global | 声明合并 map + `tab.navigation.params` | [`params.ts:32-52`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/params.ts#L32)、[`slots.ts:107-119`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/contract/slots.ts#L107) | [`fleet/index.ts:42-59`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L42) | **keep** |
| 4 | 打开/展开走 `openTab` / `openResource` | `ISidebarRight` + tab actions；`openWithFocus` 同步展开 | [`service.ts:209-216`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L209)、[`:322-334`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L322)、[`:404-407`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L404)、[`index.ts:188-196`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts#L188) | [`fleet/index.ts:96-113`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L96) 用 `tab.actions.openTab/openResource` | **keep** |
| 5 | 拖动/分屏/浮层/全屏/焦点由 DSH 负责 | `split` / `float` / `focus` / `toggleFullscreen`；AppFrame drag handles | [`service.ts:232-256`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L232)、[`:493-497`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L493)、[`:618-669`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L618)、[`AppFrame.tsx:301-304`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx#L301) | 没有自绘关闭/全屏/拖动；dockkit 承担 | **keep** |
| 6 | 列宽和 `<768` 全屏不能写死 | `computeColumns`、`autoFullscreen = viewportWidth < 768` | [`columns.ts:11-29`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-layout/src/client/columns.ts#L11)、[`:52-58`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-layout/src/client/columns.ts#L52)、[`SidebarRight.tsx:360-370`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx#L360) | [`fleet/styles.ts:14-17`](../../packages/dsh-model-desk/src/client/fleet/styles.ts#L14)、[`:134-150`](../../packages/dsh-model-desk/src/client/fleet/styles.ts#L134) 用容器查询，无 `vw` 常量 | **keep** |
| 7 | 一个类型一个页面、隐藏不保留 DOM | `multiple` / `keepMounted` | [`tab-registry.ts:105-108`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L105) | `multiple:false`、`keepMounted:false`（[`fleet/index.ts:189-190`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L189)） | **keep** |
| 8 | 全局/单会话读原生 hooks | `useSessions` / `useSessionStatus` / `useWorkspaces` | [`ui-session/index.ts:34`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-session/src/client/index.ts#L34)、[`:59-72`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-session/src/client/index.ts#L59)、[`:157-164`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-session/src/client/index.ts#L157)、[`ui-workspace/index.ts:71-77`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-workspace/src/client/index.ts#L71) | [`useFleet.ts:33-37`](../../packages/dsh-model-desk/src/client/fleet/useFleet.ts#L33)、[`:78-80`](../../packages/dsh-model-desk/src/client/fleet/useFleet.ts#L78) | **keep** |
| 9 | 子智能体读 `subagentCatalog` / `subagentTiming` | 两个投影及其字段 | [`projection-types.ts:10-38`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/projection-types.ts#L10)、[`:72-74`](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/projection-types.ts#L72) | [`model.ts:176-274`](../../packages/dsh-model-desk/src/client/fleet/model.ts#L176) | **keep**；F-03 无步数/预算 |
| 10 | Token / 上下文读 `tokenUsage` / `contextPressure` | 两个投影 | [`token-meter/projection.ts:13-48`](file:///D:/sudy/github/deepseek-harness/packages/llm/token-meter/src/projection.ts#L13)、[`:68-76`](file:///D:/sudy/github/deepseek-harness/packages/llm/token-meter/src/projection.ts#L68) | [`model.ts:96-97`](../../packages/dsh-model-desk/src/client/fleet/model.ts#L96)、[`:272-273`](../../packages/dsh-model-desk/src/client/fleet/model.ts#L272)、[`:488-491`](../../packages/dsh-model-desk/src/client/fleet/model.ts#L488) | **keep**；缺失隐藏 |
| 11 | 按需刷新投影 | `refreshProjections(sessionId): Promise<void>` | [`contract/sessions.ts:101-106`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts#L101)、[`manager.ts:346-395`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/manager.ts#L346) | [`controller.ts:100-108`](../../packages/dsh-model-desk/src/client/fleet/controller.ts#L100) | **keep**；无 signal，F-06 只做停止调度 |
| 12 | 首次列表失败显示错误，未知不是 0 | 公开 `SessionListState.phase`；manager 的 `error` 只在内部 | [`service.ts:57-66`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/service.ts#L57)、[`manager.ts:51-59`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/manager.ts#L51)、[`:413-477`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/manager.ts#L413)、[`:691`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/manager.ts#L691) | [`useFleet.ts:136-141`](../../packages/dsh-model-desk/src/client/fleet/useFleet.ts#L136)：`phase==='pending'` + 8s 超时 | **keep**；F-07 保留 |
| 13 | 工作区错误可见 | `WorkspaceSnapshot.state/error` | [`workspace-controller/model.ts:32-40`](file:///D:/sudy/github/deepseek-harness/packages/api/workspace-controller/src/client/model.ts#L32) | [`useFleet.ts:191`](../../packages/dsh-model-desk/src/client/fleet/useFleet.ts#L191) | **keep** |
| 14 | 打开会话用原生导航；子会话地址用公开读口 | `uiWorkspace.openSession(target)`、`sessions.subagentAddress(id)` | [`navigation.ts:39-44`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-workspace/src/client/navigation.ts#L39)、[`:276-278`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-workspace/src/client/navigation.ts#L276)、[`contract/sessions.ts:94-99`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts#L94) | [`fleet/index.ts:211-212`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L211)、[`view.ts:420`](../../packages/dsh-model-desk/src/client/fleet/view.ts#L420) | **keep** |
| 15 | 子会话在侧栏打开 | `openResource` + `subagentChatAddress` | [`service.ts:196-216`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-sidebar-right/src/client/service.ts#L196)、[`sidebar-chat/index.tsx:51-57`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx#L51) | [`address.ts:18-31`](../../packages/dsh-model-desk/src/client/fleet/address.ts#L18) 本地镜像；[`fleet/index.ts:109-113`](../../packages/dsh-model-desk/src/client/fleet/index.ts#L109) 用原生 `openResource` | **keep**；F-05 保留最小适配 |
| 16 | 原语 Tooltip / DisclosureRow / SegmentedControl / Switch / Input / Modal / RiskConfirmation / Tag / StateDot / Button | `ui-primitives` 公开导出 | [`index.ts:8`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/index.ts#L8)、[`:15-22`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/index.ts#L15)、[`:24`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/index.ts#L24)、[`:41-43`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/index.ts#L41)、[`:64`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/index.ts#L64) | Fleet 已用 Button/Input/SegmentedControl/StateDot/Tag，**未用 Tooltip/DisclosureRow** | **adjust** |
| 17 | `agentTeam` 是原生能力是否该用 | experimental Agent Teams，Lead/teammate + `agentTeam` 投影 | [`agent-team/projection.ts:315`](file:///D:/sudy/github/deepseek-harness/packages/experimental/agent-team/src/projection.ts#L315)、[`roster.ts:31`](file:///D:/sudy/github/deepseek-harness/packages/experimental/agent-team/src/roster.ts#L31)、`agent-team-profile/cordis.patch.yml` | 未使用 | **remove**；不引入 Lead/teammate 概念 |
| 18 | CSS 注入兼容 string/array | 无 DSH API；客户端模块系统行为 | 当前 [`styles.ts:403-430`](../../packages/dsh-model-desk/src/client/styles.ts#L403) 的 `cssText` | 两形状归一 | **keep** |
| 19 | 活动边“流动点” | 无原生拓扑组件；原型在运行节点内放 `flowdot` | [`agent-fleet.html:466`](../prototypes/agent-fleet.html#L466)、`@keyframes drip` | [`view.ts:398-454`](../../packages/dsh-model-desk/src/client/fleet/view.ts#L398) 只有节点脉冲 | **adjust**；F-04 |

补充证据：

- `subagentChatAddress` 不在公共导出面：公开的 [`ui-subagent/client/index.ts:26-34`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-subagent/src/client/index.ts#L26) 只导出类型、`apply`、`inject`；函数只在内部 [`sidebar-chat/index.tsx:51-57`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx#L51)。`./src/*` 虽可 import，但会把整块 chat UI 内联进本包。
- `refreshProjections` 没有公开 signal；`retain({signal})` 的 signal 只取消“等待 open”（[`contract/sessions.ts:36-39`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts#L36)、[`service.ts:285-292`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/service.ts#L285)），不能取消已派发的投影读。
- `SessionListState` 没有 error；manager 的 `SessionListSnapshot.error` 不在公共 store 投影里（[`service.ts:691`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/sessions/service.ts#L691) 只 set `ids/byId/phase/projectionsBySession`），`ClientSessions.manager` 是 private。F-07 的 `phase` 是原生公开信号；8s 超时只用于“transport 永不 settle”。
- `subagentTiming` 只有 `settledMs`、`active`、`lastTurnCompleted`，没有步数/预算/进度；`tokenUsage` 也只是累计 token。F-03 不伪造。
- 没有找到原生拓扑/活动边 UI 组件；`subagentCatalog` 只是数据投影。CSS 方案不是“DSH 不支持”的硬断言，而是“没有可用的公共组件，且原型本身也是节点内流动点”。

## 四、偏差与缺口逐项处置

| ID | 现状 | 处置 | 理由 |
|---|---|---|---|
| F-02 | 非当前会话行不显示链名 | **keep** | 无原生 batch；`ISessions` 只有 per-session `refreshProjections` 和 `list`（[`contract/sessions.ts:49-106`](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts#L49)）。绑定是插件 sidecar（[`bindings.ts:106-190`](../../packages/dsh-model-desk/src/bindings.ts#L106)），不是 session event，无法靠 `projectionValues` 免费带出。加 batch remote 是插件新 API，不是原生能力，本轮不做。 |
| F-03 | 卡片无步数/预算/进度/复核 | **keep** | 投影没有这些字段；预算/复核属 P2 handoff 账本。缺失即隐藏，不伪造。 |
| F-04 | 紧凑 chip 拓扑，无逐子节点流动点 | **adjust** | 保留 chip；加共享导轨 + 首个运行子节点的 1.8s 流动点；根节点保留 2.4s 脉冲；最多 2 个持续动画，reduced-motion/隐藏暂停。与原型 `flowdot` 一致。 |
| F-05 | `subagentChatAddress` 本地镜像 | **keep** | 原生 helper 未公共导出；import `./src/*` 会内联 chat UI。保留 6 行镜像 + 原生 fixture 钉住。 |
| F-06 | 关闭右栏不能 abort 已派发 `refreshProjections` | **adjust** | 无公开 signal。控制器新增 `pause()/resume()`：body 卸载或 `tab.visible=false` 时停止调度并忽略重绘；已派发 Host 读仍完成，但迟到结果不写回视图。恢复时继续队列。 |
| F-07 | 首次列表失败用 8s 超时 + `phase==='pending'` | **keep** | `phase` 是公开原生信号；manager 的 `error` 不公开。保留 8s 仅作为“transport 不 settle”的 liveness guard；超时文案本地化。后续刷新失败仍保留上次成功列表，这是已知部分缺口。 |
| F-08 | 摘要未知显示 `—` + 未知数 | **keep** | 符合“未知不是 0”；不改。 |
| F-09 | P2 第三页签未做 | **remove（from P1）** | `src/`、`tests/` 中 `handoff`/`roster`/`subagentBackend`/`maxDelegations` 零命中（只有 locale 文案和注释）。没有 host 就不注册空壳；只留 gap。 |
| F-10 | 输出续跑独立分区；候选/第一跳各自唯一重试输入；无 `maxTotalAttempts` | **keep** | 已落地且有测试；不重新引入总调用配置。 |
| 原语 | 长标签用原生 `title`，分组折叠是自绘 `button` | **adjust/replace** | 长行/卡片标题改用 `Tooltip`（[`Tooltip.tsx:62`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx#L62)）；分组折叠改用 `DisclosureRow`（[`DisclosureRow.tsx:43`](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.tsx#L43)）。非焦点路径保留原生 `title`。 |
| agentTeam | 是否用实验包 | **remove** | Lead/teammate 是错误产品概念；不在 base profile；不因“原生”采用。 |
| CSS | `ROUTER_CSS` 可能是 string，`FLEET_CSS` 是 array | **keep** | 继续 `cssText` 双形状归一；不直接 `.join`。 |

## 五、文件级实施计划

| 文件 | 动作 | 具体内容 |
|---|---|---|
| [`fleet/controller.ts`](../../packages/dsh-model-desk/src/client/fleet/controller.ts) | **adjust** | 增加 `pause()/resume()`；`pump`/`notify` 尊重暂停；`dispose` 保持清空；超时文案读 `t('fleetListTimeout')`。不改 47k 页面 controller。 |
| [`fleet/useFleet.ts`](../../packages/dsh-model-desk/src/client/fleet/useFleet.ts) | **adjust** | 接收 `visible`；挂载/可见时 `resume`，卸载/不可见时 `pause`；保留 `phase` 注释并补 manager/contract 行号。 |
| [`fleet/index.ts`](../../packages/dsh-model-desk/src/client/fleet/index.ts) | **adjust** | 把 `tab.visible` 传给 `useFleet`；注释回指新决策笔记；注册/参数映射不动。 |
| [`fleet/view.ts`](../../packages/dsh-model-desk/src/client/fleet/view.ts) | **adjust/replace** | `SessionRow`/`AgentCard` 用 `Tooltip` 包可聚焦按钮；`GroupList` 用 `DisclosureRow` 替换自绘 group button；`Topology` 给首个 running chip 加 `dsh-fleet-chip-flow`；其余视图逻辑不动。 |
| [`fleet/styles.ts`](../../packages/dsh-model-desk/src/client/fleet/styles.ts) | **adjust** | group header 外层 28px、DisclosureRow 标题/路径/计数样式、`data-disclosure-row` 焦点环；chip 导轨/竖线/flow dot；`@keyframes dsh-fleet-flow`；reduced-motion 与 `data-visible`/`data-page-hidden` 暂停选择器。 |
| [`locales.ts`](../../packages/dsh-model-desk/src/client/locales.ts) | **adjust** | 新增 zh/en `fleetListTimeout`；其余键不动。 |
| [`fleet/model.ts`](../../packages/dsh-model-desk/src/client/fleet/model.ts) | **keep** | 不改 unknown/0、分组、摘要口径。 |
| [`fleet/address.ts`](../../packages/dsh-model-desk/src/client/fleet/address.ts) | **keep** | 保留镜像与 fixture。 |
| [`apply.ts`](../../packages/dsh-model-desk/src/client/apply.ts)、[`page.ts`](../../packages/dsh-model-desk/src/client/page.ts)、[`chain.ts`](../../packages/dsh-model-desk/src/client/chain.ts)、[`pipeline.ts`](../../packages/dsh-model-desk/src/client/pipeline.ts)、[`chip.ts`](../../packages/dsh-model-desk/src/client/chip.ts)、[`styles.ts`](../../packages/dsh-model-desk/src/client/styles.ts)、[`client/controller.ts`](../../packages/dsh-model-desk/src/client/controller.ts) | **keep** | 不改配置页、写链路、chip 双入口、CSS 注入。 |
| [`tests/unit.mjs`](../../packages/dsh-model-desk/tests/unit.mjs) | **add** | 新增 `createFleetController` 的 pause/resume 调度测试；补“投影 state=error 仍是 unknown”用例。 |
| [`tests/client-controller.mjs`](../../packages/dsh-model-desk/tests/client-controller.mjs) | **add** | 测试夹具补 `Tooltip`/`DisclosureRow` stub；源级守卫断言 Fleet 使用原语、无 `agentTeam`、有 flow dot/reduced-motion；保留并扩展右栏原生注册测试。 |
| [`docs/design/agent-fleet-drawer.md`](agent-fleet-drawer.md) | **adjust** | §6.2 改为“停止调度+忽略迟到结果”；§8 P1 落地补原语/pause/flow dot；§9.3 更新 F-04/F-06/F-07，新增 F-11（DisclosureRow 原生尺寸）；F-02/03/05/08/09/10 标注“复核后保留/gap”。 |
| [`.agents/notes/implemented/2026-10-23-agent-fleet-capability-review.md`](../../.agents/notes/implemented/) | **new** | 记录本轮能力复核、被否方案（batch remote、import 内部 helper、agentTeam、逐边动画、自绘 group button）与代价；代码入口回指。 |
| [`docs/design/agent-fleet-next-session-brief.md`](agent-fleet-next-session-brief.md) | **this file** | 本页即交接；实施后把基线、F-04/F-06 状态和验证结果更新为事实。 |

不新建第二个保存链路，不改 host，不改 DSH，不碰 live profile。

## 六、验证计划

### 6.1 命令

1. `npm run bundle --prefix packages/dsh-model-desk`（客户端改动后必须重建；测试跑 `lib/client.js`）。
2. `npm test` 四套件；保留原始输出。
3. 指定 `npx tsc --noEmit ... src/index.ts`；记录 exit code。
4. `node --check packages/dsh-model-desk/lib/client.js`。
5. `git -C D:\sudy\github\deepseek-harness status --porcelain` 必须为空。
6. 真实 Cordis Loader 组合：`run.mjs` 35 场景 + `remote.mjs` 21（已包含在 npm test）。

### 6.2 隔离 home + Chrome/CDP

- 用 `%TEMP%\dsh-fleet-cap-22`：从现有真实日志选 22 个顶层会话；其中 `session-4f20ca6c-e005-4c45-86ca-2ba39868af95` 有 13 个 `subagent/catalog`（可验 8 + `+5`），`session-74b0dd9a-0d58-4691-a9a0-16c7ef7b9377` 有 9 个，`session-77ea0273-00b8-425a-8384-b48c350b7f9d` 有 8 个。
- 起 `DSH_HOME=<home> node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 3499`，用 stdout token URL。
- Chrome MCP 现在可用，优先 `new_page({ isolatedContext })`；超时则用 jshook CDP，不用假页面。
- 1440 / 1024 / 800 / 全屏；1024 左栏收起后右栏 461；22 行精确计数；13 智能体 `+5`；空 home；搜索无匹配；unknown（20/22 已加载）；键盘 Enter；侧栏打开子会话；复制；Tooltip；DisclosureRow 折叠；reduced motion；无 `position:fixed`/遮罩/自绘标签条/自绘关闭全屏。
- 错误态：首屏 list 失败在真实宿主上难以只断 list 而不破坏模块加载；尝试 CDP 请求拦截。若无法稳定复现，明确写“未浏览器验证，组件测试覆盖”，不造假。
- 截图写到 `docs/assets/ui/fleet-cap-*.png`，不覆盖现有 `fleet-verify-*`。

## 七、风险与验收

1. **`DisclosureRow` 原生尺寸**：原生 row 24px、标题 13/24；设计 T1 是 11.5/16。用外层 2px padding 凑 28px，并用 `titleClassName` 尝试压回 11.5；若 CSS Module 顺序不允许，按原生 13/24 落地并在 §9.3 F-11 记录。这是本轮唯一可能需要用户接受 1.5px 视觉偏差的地方。
2. **F-07 只能部分解决**：公开 `SessionListState` 没有 error；后续刷新失败仍保留上次列表。首屏失败用 `phase` + 8s 超时，这是源码允许的最诚实做法。
3. **F-02/F-03/F-05/F-09 不改**：分别是无原生 batch、无投影字段、未公共导出、无 handoff host；本轮只更新证据和文档，不用新概念补。
4. **客户端半包有独立 tsc**（`tsconfig.client.json`，已接进 `bundle`）：`npx tsc -p packages/dsh-model-desk/tsconfig.client.json` 必须 exit 0；不得声称没跑过的检查通过。
5. **浏览器错误态**可能只能做到组件测试；如果真实断网/拦截不可行，在最终“未解决缺口”里写清楚。

## 八、新会话提示词（复制到新会话）

```text
你在 DSH Model Desk 仓库做 Agent Fleet 的“能力复核后的优雅优化实施”。仓库：D:\sudy\myproject\dsh-model-desk；DSH 源码只读：D:\sudy\github\deepseek-harness。当前分支 master，工作树已有 P1 未提交改动（fleet/、配置页、测试、设计文档、截图）。先 git status / git diff 看清现状，不要 reset、checkout 或覆盖用户已有改动。

第一步先读：
- AGENTS.md、docs/AGENTS.md、.agents/notes/AGENTS.md
- docs/architecture.md
- docs/design/agent-fleet-next-session-brief.md（本页；含能力复核表、逐项 keep/adjust/replace/remove、文件级计划、验证路径）
- docs/design/agent-fleet-drawer.md（§4–§10，尤其 §6.2、§9.3 偏离表、§10.1 P2 gap）
- docs/design/handoff-proposal.md（§4–§8、§12、§13）
- docs/design/ui-layout-redesign.md、docs/design/ui-review-gemini-template.md、docs/design/open-questions.md
- docs/prototypes/agent-fleet.html、docs/assets/ui/proto-*.png
- packages/dsh-model-desk/src/client/fleet/*.ts、apply.ts、page.ts、chain.ts、pipeline.ts、workspace.ts、chip.ts、controller.ts、modals.ts、styles.ts、locales.ts
- defaults.ts、config.ts、src/index.ts、tests/

能力复核已经做过，不要重做大规模调研；只回核关键源码行，若设计假设与源码冲突，以源码为准，并在 agent-fleet-drawer.md §9.3 记录。任何“DSH 不支持”必须附搜过的符号和 file:line。

本轮实施范围（其余 keep）：
1. F-04 adjust：保留紧凑 chip 拓扑；加共享导轨 + 首个运行子节点的 1.8s 流动点；根节点保留 2.4s 脉冲；最多 2 个持续动画；prefers-reduced-motion 和 data-visible/data-page-hidden 暂停。对齐原型 flowdot。
2. F-06 adjust：controller 增加 pause()/resume()；body 卸载或 tab.visible=false 时停止调度并忽略重绘；已派发 refreshProjections 无法 abort，保留“停止调度 + 忽略迟到结果”，不要假装能取消 Host 读。useFleet 接收 visible，AgentFleetTab 传 tab.visible。
3. 原语 adjust/replace：GroupList 的自绘折叠 button 改用 DSH DisclosureRow；SessionRow/AgentCard 的长标题/任务用 Tooltip 包可聚焦按钮（移除被包元素的原生 title，非焦点路径保留 title）。只用 @deepseek-ai/dsh-client-ui-primitives 的 Tooltip/DisclosureRow，不新增自绘标签条/抽屉/遮罩/关闭全屏按钮。
4. 超时文案：controller 的 8s 超时读 t('fleetListTimeout')，zh/en 都加；F-07 的 phase 语义保留，并补源码行号注释。
5. 不改：F-02（无原生 batch，链名只读当前/下钻会话）、F-03（无步数/预算/进度，缺失隐藏）、F-05（subagentChatAddress 未公共导出，保留 6 行镜像 + 原生 fixture）、F-07 的 phase + 超时（只做文案与注释）、F-08（未知 — + 未知数）、F-09（无 handoff host，不注册空壳第三页签）、F-10（输出续跑独立分区、候选/第一跳各自唯一重试输入、无 maxTotalAttempts）。
6. 不用 agentTeam / Lead / teammate；不 import @deepseek-ai/dsh-client-ui-subagent/src/*（会把 chat UI 内联进包）；不改 DSH checkout；不碰 live profile。

实现要求：
- 不重写 47k 页面 controller；只在现有 fleet/ 模块上优化。
- 复用 chain/chip/controller；新逻辑按职责放 controller/useFleet/view，不把业务逻辑塞 JSX。
- 只用 DSH token 和 ui-primitives；动态值才内联；容器查询继续，不写 vw 固定宽度。
- CSS 注入继续 `cssText` 双形状归一（ROUTER_CSS 可能被模块系统交回 string，FLEET_CSS 仍可能是 array），不要直接 `.join`；不改 `styles.ts` 的注入契约。
- 未知不是 0；缺失投影隐藏/写未加载；子会话只有 lastTurnCompleted=false 时说“最近回合未正常完成”；tokenUsage 缺失隐藏；不做 TTFT/手动熔断/Nudge/导出审计。
- 不许假数据/alert/空壳/mock 成功路径；不许 fixed 抽屉/遮罩/自绘标签条/自绘关闭全屏按钮。
- 语义清晰：F-04 只表达“有活动”；F-06 只表达“停止调度”，不声称取消在飞 Host 读。

测试：
- 改完先 npm run bundle --prefix packages/dsh-model-desk（客户端测试跑 lib/client.js，必须先构建）。
- npm test 四套件：unit / client-controller / remote / run（35 场景）。
- 指定 npx tsc --noEmit --skipLibCheck --strict --module nodenext --moduleResolution nodenext --target es2022 --allowImportingTsExtensions packages/dsh-model-desk/src/index.ts
- node --check packages/dsh-model-desk/lib/client.js
- 新增测试覆盖：controller pause/resume 调度、投影 state=error 仍是 unknown、Fleet 使用 Tooltip/DisclosureRow、无 agentTeam、flow dot/reduced-motion；保留并扩展“右栏原生注册”。不删断言、不放宽断言。
- 客户端半包有独立 tsc：`npx tsc -p packages/dsh-model-desk/tsconfig.client.json`；`bundle` 已内含，必须 exit 0。

浏览器（隔离 home + Chrome/CDP，不碰 live profile）：
- 准备 %TEMP%\dsh-fleet-cap-22：从真实日志选 22 个顶层会话；其中 session-4f20ca6c-e005-4c45-86ca-2ba39868af95 有 13 个 subagent/catalog（验 8 + +5），session-74b0dd9a-0d58-4691-a9a0-16c7ef7b9377 有 9 个，session-77ea0273-00b8-425a-8384-b48c350b7f9d 有 8 个。
- 起 DSH_HOME=<home> node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 3499，用 stdout token URL。
- Chrome MCP 现在可用，优先 new_page({ isolatedContext })；超时则用 jshook CDP；不要假页面。
- 覆盖：1440 / 1024 / 800 / 全屏；1024 左栏收起后右栏 461；精确 22 顶层会话；13 智能体 +5；空 home；搜索无匹配；unknown（20/22 已加载）；键盘 Enter；侧栏打开子会话；复制；Tooltip；DisclosureRow 折叠；reduced motion；DOM 无 position:fixed/遮罩/自绘标签条/自绘关闭全屏。
- 错误态：尝试 CDP 拦截 list 请求；若无法稳定复现，写“未浏览器验证，组件测试覆盖”，不造假。
- 截图写 docs/assets/ui/fleet-cap-*.png，不覆盖现有 fleet-verify-*。

文档与注意：
- 偏离写 docs/design/agent-fleet-drawer.md §9.3；F-04/F-06 更新，新增 F-11 记录 DisclosureRow 原生尺寸（24px row + 2px wrapper = 28px；标题优先 11.5/16，若 CSS Module 顺序不允许则接受原生 13/24）。
- 非平凡决策写 .agents/notes/implemented/2026-10-23-agent-fleet-capability-review.md，并回指代码。
- 不改 DSH checkout；不碰 live profile。
- 结束时给：改动文件、原始测试输出、截图路径、偏离表、未解决缺口；不要声称跑过没跑的测试。

先做实现，不要重新输出一版大计划；本页就是已确认的计划。若发现源码与计划冲突，先停下来在回复里说明冲突和证据，再决定是否 adjust。
```

## 九、不做

- 不重写页面 controller、不改配置页写链路、不合并链行默认值与 chip 本会话覆盖。
- 不重新引入 `maxTotalAttempts`、不做总调用数字。
- 不注册空壳第三页签、不放假名册、不做 Nudge/TTFT/手动熔断/导出审计。
- 不用 `agentTeam` 的 Lead/teammate 概念；不因为“原生”就采用错误产品概念。
- 不 import `ui-subagent/src/*` 来拿 `subagentChatAddress`；保留最小镜像。
- 不用假数据、`alert()`、mock 成功路径、`position: fixed` 抽屉、遮罩、自绘标签条、自绘关闭/全屏按钮。
- 不改 DSH checkout，不碰 live profile。
