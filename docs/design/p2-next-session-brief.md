---
title: "DSH On-call — P2 委派名册：后续会话交接"
status: "handoff-brief"
kind: "handoff-brief"
last_updated: "2026-10-24"
---

# P2 委派名册：后续会话交接

本页是**状态与配方的快照**：本轮做到哪、怎么验的、还剩什么、下一会话从哪下手。设计真值在
[handoff-proposal.md](handoff-proposal.md)（字段/默认值）与 [agent-fleet-drawer.md](agent-fleet-drawer.md)
（§5.3 界面、§9.3 偏离、§10.1 落地记录）；取舍理由在 `.agents/notes/implemented/2026-10-24-*.md` 两篇。
本页不重复它们的表格。

## 一、当前基线（2026-10-24 实跑，不是估计）

| 项 | 事实 |
|---|---|
| 依赖 | 根 `@deepseek-ai/dsh` **0.2.1-rc.3**（跟只读 checkout；桌面仍装 rc.2）；`zod` 根 **4.4.3 精确**；插件 peer 六个 `@deepseek-ai/dsh-*` = `^0.2.1-rc.3`（含 `dsh-tools`）+ cordis / schemastery / zod；`packages/dsh-oncall/.npmrc` 有 `legacy-peer-deps=true`（替代方案已实测否决，见 §四.5） |
| 构建 | `npm run bundle --prefix packages/dsh-oncall`：host 208.13 kB / client ≈464.8 kB（client 里 `zod` 是外部 require；tsdown 报十进制 kB。数字随注释与代码改动漂移，以当次 bundle 输出为准） |
| 四套件 | **233 unit / 123 client-controller / 25 remote / 35 scenarios, 0 failure**（rc.3 上实跑，2026-10-24） |
| 类型 | 指定 `npx tsc --noEmit --skipLibCheck --strict --module nodenext --moduleResolution nodenext --target es2022 --allowImportingTsExtensions packages/dsh-oncall/src/index.ts` → exit 0 |
| 语法 | `node --check packages/dsh-oncall/lib/client.js` → exit 0 |
| 客户端 tsc | `tsconfig.client.json`（照 DSH 的 `tsconfig.base.client.json` 形状：DOM lib、`noEmit`、与 host 声明工程分开；`noImplicitAny:false` 是棘轮而非政策）。`npx tsc -p packages/dsh-oncall/tsconfig.client.json` → **exit 0**，且已接进 `bundle`（`tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown`）。棘轮是否收紧见 `.agents/notes/implemented/2026-10-24-client-half-typecheck.md` 的 Consequences。 |
| 浏览器 | npm 宿主 + 隔离 home（`%TEMP%\dsh-fleet-cap-22`）起 web profile；1440 / 1025 / 801 / 大屏（CDP `emulate` 实测 1920×1080，配置页列 960）；12 角色列表 224px / 420px 独立滚动；空态、校验拒绝、保存回写（磁盘核对）均通过；DOM 无本插件自绘 `position: fixed` / 遮罩 / 标签条 / 关闭全屏。收口轮冒烟（1468×880，端口 3499，另跑 801 与 CDP `emulate` 1920×1080）：名册页 12 角色 + 编辑器在 801/1468/1920 三档布局不变；方向键走位真机实测 `ArrowDown ×2 → End → ArrowDown → ArrowUp → Home → ArrowUp` 落在 侦察/测试/清理/清理/复核二/复核/复核（编辑器 id 同步，`defaultPrevented` 全 true）；重试 stepper 输入 5→3、`+` →4，按权重策略下权重框 0→40（两处 `ChangeEvent` 收窄的实证）；chip 弹层 `role="menu"` + portal 正常，`items` 渲染出「链 默认 ›」、`extras` 渲染出按目录命名的重试行（placeholder「跟随」）；右栏「本会话」三本预算 0/8、0/1、0/2 与"已接入但为空"的活动流；渠道健康页 6 条路由标签与"历史留痕"徽标照旧 |
| 截图 | `docs/assets/ui/roster-p2-{1440-12roles,1025,801,1920-12roles,fullscreen-editor,1440-empty,validation-blocked}.png`、`fleet-p2-activity-1920.png`（活动流“已接入但为空”）、`fleet-p2-budgets-1920.png`（三本预算 0/8、0/1、0/2）；收口轮（2026-10-24）`roster-p3-typecheck-{1468,801,1920}.png`、`fleet-p3-typecheck-{session,global}-1468.png`、`health-p3-typecheck-1468.png`、`chip-p3-typecheck-popover-1468.png` |
| DSH checkout | `git status --porcelain` 0 行（未改）；live profile 未碰 |

本轮代码入口：`src/config.ts`（`handoffSchema`）、`src/defaults.ts`（HANDOFF 常量）、`src/rules.ts`
（名册保存期校验）、`src/handoff.ts`（投影 + 账本 + 闸门 + 描述/提示词）、`src/handoff-tool.ts`
（一个工具四动作）、`src/index.ts`（`installHandoff` / `onTurnStopping`）、`src/notice.ts`（4 条 notice）、
`src/client/{page,controller,validate,apply,locales,styles,roster}.ts`、`tests/{unit,client-controller,remote}.mjs`。

## 二、已经定下来的语义（下一会话不要再推导一遍）

1. **一个工具、四个动作**：`delegate` / `finish` / `newSession` / `facts`。前三个可关（`protocol.*`），
   `newSession` 随接力配置。非顶层会话在 handler 里拒绝（`HANDOFF_NOT_TOP_LEVEL`），不做动态注册。
2. **投影与账本分工**：`oncall/handoff` 投影只折叠**可数事实**（`user/message` 的 epoch、
   `tool/call`+`tool/result` 的回执、`step/start` 的回合、`turn/end`、`compaction/start`、`lastUserText`）；
   复核结论与携带预算在**账本**（`storageDomain` 的 `oncall_handoff`，`reviews` + `budgets` 两张表）。
   闸门读"投影计数 + 携带计数"。
3. **预算的 epoch 只由人说话推进**：插件自己的消息用 `source.kind = 'oncall-handoff'`，
   接力简报不清零（F-14）。
4. **复核按派发时 epoch 记账**：复核期间人说话 → 这次复核作废（F-18）。
5. **拒绝 = 抛 `HarnessError`**：`tool/result.isError` 是折叠判"没花预算"的唯一依据（F-15）。
6. **复核结论的形状由插件拥有**（`pass` / `gaps` + `gaps[]`），`roster[].outputSchema` 不存在（F-16）。
7. **闸门与接力分开**：`protocol.requireReviewFor` 是拒绝条件；`newSession.*` 是行为。UI 上也是两个分区。
8. **一个保存链路**：名册页改同一份 draft，保存走 `controller.save()` 的同一次 `scope.mutate`，多一条
   `{ op: 'set', path: ['handoff'] }`。校验与 host 同源（`rules.ts` 的 `structuralViolations`）。
9. **接力先重建 goal、再拼简报**：`goals.create` 排在简报之前，重建失败时把目标写进简报（§4.6 步 6 的兜底）；
   简报只发一次，所以失败必须在那之前知道。旧 goal 的 `clear` 仍在简报之后。
10. **活动流读的是投影，不是账本**：`oncall/handoff` 的 `records` 只有模型自己写下的回执（派发 / 收工 / 开新会话 / 读事实）；
   复核结论与预算在账本里，浏览器还读不到——所以活动流不显示复核结论，也不显示预算数字。
11. **三本预算的"已用"只有一个表达式**：投影计数 + 接力携带（`handoff-wire.ts` 的 `addCarried`），闸门与界面共用；
   账本只通过 `oncallHealth.handoffCarried` 补"带了什么"这一半（浏览器读一次、缓存）。任何一半未知就整块隐藏。

## 三、原生能力核对（已核实，别再绕弯）

| 能力 | 事实（file:line 见代码注释） | 本轮用法 |
|---|---|---|
| 工具注册 | `ctx.tools.register(defineTool({name, description, parameters, output:{schema, render}, execute}))` | `handoff-tool.ts` |
| 工具调用方 | `ToolRunContext.agent?`（agent loop 填入） | 顶层判定、gate |
| 派子智能体 | `ctx.subagents.startActivation({provider, label, request, signal, delivery})`；`delivery:'parent'` 才会原生唤醒父会话 | `delegate` |
| 结构化结论 | `request.outputSchema`（`ObjectJsonSchema`）+ `activation.result.structured` | 复核 verdict |
| 建会话/选模型 | **`ctx.sessionController.createSession({cwd, reusable})`**、`selectionFor(agent)`、`selectForNextRequest(agent, sel)`（不是 `ctx.agents.createSession`，F-17） | `relay` |
| 目标 | `ctx.goals.get(agent)` / `create(agent, {objective, maxGoalRounds?})` / `clear(agent, ref)` | `rebuildGoal` / `retireGoal`、`done` 闸门 |
| todo | `ctx.sessionProjections.snapshot(session, ['todos']).values.todos`（`TodoItem[] \| null`） | `facts`、`attach` |
| 投影注册/读 | `ctx.sessionProjections.register(def)`、`stateOf(session, key)`、`snapshot(session, keys)`；带 `wire` 的注册项随会话快照下发给浏览器 | 计数、facts；右栏活动流在浏览器按同一个 key 读 `records` |
| 可选服务 | `ctx.get(name)`；**服务晚挂上时用 `ctx.inject([...], cb)`**（F-20） | 工具注册 |
| 持久侧车 | `ctx.storageDomain` + `defineDomain` / `domainTable`（zod schema） | 账本 |
| 组件原语 | 已用 `Button` `Tag` `Switch` `Input` `Checkbox` `SegmentedControl` `SegmentedTabs` `Tooltip` `DisclosureRow`（fleet） | 名册页 |

**已评估的原语**（2026-10-24 读 `packages/client/ui-primitives/src/index.ts` 后逐项判定）：

| 原语 | 事实 | 判定 |
|---|---|---|
| `Pill` | 24px/12px 胶囊，给 `onClick` 时是按钮（视图切换、过滤器），只读徽标是 11px 的 `Tag` | 不换。名册没有可点选的 chip；顶部开关已经是 `Tag`（`Tag.tsx` 注释写明"只读徽标是 Tag"）。把角色类型或预算换成 Pill 会让 44px 行里的静态文字看起来可点 |
| `DisclosureRow` | 24px 进程行：chevron + 13px 次级标题 + 可选折叠内容，给运行日志/分组用 | 不换。名册五个分区是**表单**分区（15px 标题）；折叠会藏起正在编辑的字段，而 §5.3 没要求折叠；换过来还要为五个分区各加一份 `open` 状态，语义只降不升 |
| `Menu` / `MenuItemButton` | `role="menu"` 的锚定弹层（`Menu.tsx:168` 收 `anchor`，`:561` 可 `createPortal`），带方向键走位 | 不换。主从语义要求列表常驻在编辑器旁（§5.3 的 224px 列表），弹层菜单一开就遮住编辑区。手写 `role="listbox"` 保留；方向键走位属可选的键盘增强，不是原语替换 |
| `InlineEditor` | Enter 保存、Shift+Enter 换行的自适应 textarea，给"排队消息 / goal"这类短草稿 | 不换。purpose/instructions 是多行长文本，Enter 保存与多行编辑冲突，且保存必须走页面唯一保存链路 |
| `Alert` / `InlineAlert` | **不存在**（`index.ts` 无此导出） | 校验摘要继续用本仓库既有的 `.dsh-oncall-notice`，不是漏用 |
| `PathLabel` | 单行路径：目录压暗、末端主色，溢出从左缘渐隐，完整路径自带 hover | **换**（fleet 工作区路径）：`D:\sudy\github\` 压暗、`CraftAgent` 主色，正是"哪一段可辨识"该有的样子；比手写 span + CSS 右省略更对。真机核对：6 个分组各一条，`title` 由原语自己带 |
| `SettingsValueField` / `ConfigField` / `SettingsSecretField` | 独立的受控字段控件（label/hint/输入），但契约是 settings 的**覆盖层**：`overridden` + `overriddenLabel` + `resetLabel` + `onReset`，且草稿一律是文本 | 不换。我们的页面是"整段草稿 + 一次 `scope.mutate` 保存"，没有逐字段覆盖层；换过来要传 `overridden: false` 与空 reset，等于给一个页面没有的能力立假 prop。四个小包装（TextField/NumberField/AreaField/ChoiceRow）保留 |
| `Toast` | 顶部居中、淡入停留淡出的临时横幅（portal） | 不换。「读不到 ≠ 空」那类通知必须**常驻**到下一次读成功，淡出横幅会把"还没读回来"变成"什么都没发生" |
| `Tooltip` | 锚点必须是真元素或 forwardRef 组件（它 clone 后注入 `ref` 与事件） | 用在该用的地方（fleet 的可聚焦行）。健康页徽标不是 tab stop、`Tag` 也不转发 ref，所以那两句提示挂在包一层的 span 的 `title` 上——与本仓库既有规矩一致（可聚焦 → Tooltip，非 tab stop → 朴素 title） |

## 四、本轮已收口与剩余缺口

2026-10-24 二轮收口（每条都有实跑证据，见 §一）：

1. **`HandoffRuntime` 有了假 faces 单测（9 条）**，不把 `@deepseek-ai/dsh-api-session-controller` 塞进 headless 组合：
   六步顺序（`selectionFor → createSession → selectForNextRequest → 绑定读写 → 账本携带 → goal 重建 → 简报 → 旧 goal clear → notice`）、
   `carrySelection` 只在有选择时调用、携带预算等于闸门读数（`delegations/reviews/perRole` 原样、`newSessions + 1`）、
   简报带配置的工件、旧会话 notice 指向新 id、`keepGoal` 失败降级、`facts` 的真实 goal/todos/按角色派发数、
   `delegate` 的请求组装（`agentPreset` / `agentOptions` / 复核 `outputSchema` / prompt 顺序）、复核结算写账本并驱动 `finish` 闸门。
   写测试时发现一处与 §4.6 步 6 的冲突：`goals.create` 原先排在简报之后，重建失败时目标已无处可写——已改为先重建、失败则写进简报。
2. **F-21 活动流已接 `oncall/handoff`**：三态（未加载 / 已接入但为空 / 有回执），不画空时间线；浏览器实测读到"已接入但为空"，
   证明投影键真的随快照到了浏览器。投影键收进 `src/handoff-wire.ts`，浏览器半包不从 `handoff.ts` 取常量（那会把 zod 拖进 bundle）。
3. **名册页原语复核完成，结论是不改**（`Pill` / `DisclosureRow` / `Menu` / `InlineEditor` 逐项判定见 §三）。
4. **大屏 1920 用 CDP `emulate` 实拍**（`roster-p2-1920-12roles.png`，1920×1080；`resize_page` 受物理屏幕限制，不能用）。
5. **`legacy-peer-deps` 的替代方案已实测否决**：把 peer 钉成 exact devDependencies 会**制造**第二份实例
   （临时目录里 25 个包，含 `dsh-llm@0.2.1-rc.2` 与 `zod@4.4.3`，`require.resolve` 两边路径不同）；
   加 `legacy-peer-deps` 也拦不住（声明的 devDependency 照装，15 个包）。只有把仓库改成真正的 npm workspace
   （`workspaces: ["packages/*"]`）才能让 exact devDeps 提升到根、只剩一份——那是开发工作区改造，不是 package.json 改动。
   结论与数据见 `.agents/notes/implemented/2026-10-24-peer-resolution-is-a-dev-workspace-fact.md`。
6. **三本预算（D7）已上会话视图**：投影计数 + 接力携带（同一条 `addCarried`），上限来自浏览器自己那份配置；
   新增只读 Remote `oncallHealth.handoffCarried` 只回答"带了多少"。浏览器实测 0/8、0/1、0/2。
   实现时被真机抓到一处真 bug（`reviewRosterIds` 传了数组而不是配置对象），已补控制器级单测。
7. **客户端半包有了类型检查工程**（照 DSH 官方形状）：`tsconfig.client.json` + 三个平台包的声明作为 devDependency；
   `noImplicitAny:false` 当棘轮用。它第一次跑就抓到 `probeAll` 里裸调 `loadProbeReport()`——运行时 `ReferenceError`
   被 `.catch` 吞掉，"探测全部"之后从不刷新宿主报告。已修 + 补回归用例（退回修复即变红）。
8. **客户端 tsc 清零并接进构建**（2026-10-24，同一轮）：98 条 → **0**（36 TS2339 / 27 TS18046 / 12 TS2345 /
   11 TS2769 / 9 TS2322 / 1 TS18047 / 1 TS2305 / 1 TS2353），`bundle` 现在两份 tsc 都跑；`noImplicitAny`
   仍为 false，收紧时机写在笔记 Consequences 里。**清账本身只改类型**；过程中被类型问出两条既有事实——
   健康页两处 `Tag` 的 `title` 从未渲染过（DSH 的 Tag 是只读徽标，只接 `tone`/`className`/`children`，
   `packages/client/ui-primitives/src/Tag.tsx:34-41`），按"渲染不变"删掉；名册编辑器把 React 事件当值传，
   是行为 bug，单独列为第 10 条并当场修。
9. **名册主列表方向键走位**：`role="listbox"` 上 ArrowUp/ArrowDown/Home/End 移动选中、首尾不环绕，
   Enter/Space 与点击仍走 `onSelect(entry.id)` 这一个入口；Tab 顺序与选中语义未动。新增一条 client-controller
   用例（`the roster list walks with the arrow keys and stops at both ends`），并经"移除处理器即变红"抽样验证；
   真机实测 `ArrowDown ×2 → End → ArrowDown → ArrowUp → Home → ArrowUp` 落在 侦察/测试/清理/清理/复核二/复核/复核。
10. **名册编辑器的输入字段读对了事件**（从类型收口里读出来，同一轮修掉）：`TextField`/`NumberField` 把 DSH `Input`
    的 onChange 参数当"值"用，而 `Input` 把 props 原样铺给原生 `<input>`
    （`packages/client/ui-primitives/src/Input.tsx:14-23`）——真机实测往「显示名」里输入，输入框与列表行都变成
    `"[object Object]"`，数字字段则静默无效。改为 `event.currentTarget.value`（数字沿用仓库既有口径：非数字忽略、
    负数夹 0），补一条 client-controller 用例（`the roster fields take the typed value, not the change event`）；
    修后真机复测：显示名 → 新名字、派发上限 → 6、复核上限 → 2，页脚转"有未保存的修改"。

11. **发布快照与名册 props 有了类型**（收口后再补的"把闸门装上"）：`RouterSnapshot` 命名 `project()` 的返回，
   `ui: Omit<RouterUi, 'chainId'>` 让字段表只有一份；`page.ts` 用该类型读快照，于是"读了不再发布的字段"是编译错误
   （实测读 `state.ui.chainId` → `Property 'chainId' does not exist on type 'Omit<RouterUi, "chainId">'`）。
   名册页 props 也成为接口，`onEntry` 的字段名收成 `keyof RosterEntry`——拼错字段从"静默不写入"变成编译错误；
   它当场抓出闭包里两处 `selected` 失去收窄，顺手抽成 `rosterEditor(entry: RosterEntry)`，重复的 `findIndex` 合成一次。
   `ui.catalog` / `ui.updateResult` 两个 `unknown` 换成 Host 面已有的 `ModelCatalog` / `UpdateCheck`。
   仍留 `unknown` 的只有抽屉的两列载荷：导入它们的真实类型会把**宿主面**的 `sessions` 增补带进客户端程序、
   让 `refreshProjections`/`refresh`/`subagentAddress` 消失（实测三处报错），故按边界只具名外壳——
   详见 `.agents/notes/implemented/2026-10-24-client-half-typecheck.md` 的 Consequences。
12. **原生原语补齐**（同上，用户要求"能用就用"）：fleet 工作区路径改用 DSH 的 `PathLabel`（目录压暗/末端主色/
   溢出左缘渐隐/自带完整路径 hover），替掉手写 span + 右省略；健康页那两句提示改挂到包一层的 span 的 `title`
   上（`Tag` 不收 `title`，`Tooltip` 的锚点必须是真元素或 forwardRef，徽标两者都不是），即"非 tab stop 用 title"
   这条既有规矩。`SettingsValueField`/`ConfigField`/`Toast` 评估后仍不换，理由见 §三 表。

剩余：**无阻塞项、无待决项**。一条待查、两条可选增强：

- **待查（2026-10-24 真机发现，预存在，不是类型收口造成）**：在隔离 home 里跑成功一轮真实对话
  （"只回两个字：收到" → "收到"，1 秒，13.9K tok），随后打开「渠道健康」，该路由（`wb/cn:deepseek-v4.1-flash`）
  仍显示 `近 4h 暂无观测`、`本步耗时 4.51s` 这些**旧值**，整页刷新后不变，且没有"读不到"警告条。
  复现：`DSH_HOME=%TEMP%\dsh-fleet-cap-22` 起 web profile → 发一句 → 开渠道健康。
  未定位，也不猜：候选原因是①`readRecentSessions` 的列表快照还没含这条新会话，②新会话的
  `oncall/channel-health` 投影尚不可读（索引延迟）。要查就从"新会话是否出现在 `session list`、
  `session.projections({sessionId})` 是否带 `oncall/channel-health`"两条查起。这轮的改动
  （`controller.ts` 类型、`workspace.ts` 的 map 标注与两个 span）都不在这条读路径的运行时上。
- 可选①：按文件收紧 `noImplicitAny`，起点与判据见
  `.agents/notes/implemented/2026-10-24-client-half-typecheck.md` 的 Consequences。
- 可选②：方向键走位目前只覆盖名册这一个 listbox，等出现第二个 listbox 再抽公共函数（现在抽等于为一份用户造抽象）。

## 五、验证配方（复制即用）

```powershell
# 构建 + 四套件 + 类型 + 语法
npm run bundle --prefix packages/dsh-oncall      # 内含 host tsc 与 client tsc
npm test
npx tsc -p packages/dsh-oncall/tsconfig.client.json   # 单独跑一遍客户端半包，应为 exit 0
npx tsc --noEmit --skipLibCheck --strict --module nodenext --moduleResolution nodenext --target es2022 --allowImportingTsExtensions packages/dsh-oncall/src/index.ts
node --check packages/dsh-oncall/lib/client.js
git -C D:\sudy\github\deepseek-harness status --porcelain   # 必须 0 行
```

浏览器（隔离 home，**用 npm 宿主**，桌面运行时只作为对照）：

```powershell
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-fleet-cap-22'
node node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --no-open --port 3499
# stdout 打印带 token 的 URL；浏览器必须用它进入
```

四个已经踩过的坑（都不需要"改用桌面运行时"）：

- **截图路径**：`take_screenshot(filePath=…)` 被限制在 MCP server 的 workspace root
  （`C:\Users\<user>\.dsh\profiles\desktop`），写不进仓库。做法：不带 `filePath` 截图，再把返回的
  normalized 副本（`C:\Users\<user>\.dsh\attachments\v1\objects\…`）复制到 `docs/assets/ui/`。
- **窗口尺寸**：`resize_page` 上限是物理屏幕（1920 请求得到 1471）。要真 1920 用 `emulate`
  （`viewport: '1920x1080x1'`；`emulate` 每次调用会替换全部仿真设置，要同时改配色就在同一次调用里给全）。
- **首屏更新日志弹窗**：版本变化时 `notesOpen` 初始为真，会盖住页面。点"关闭"，或在加载前写
  `localStorage['dsh-oncall:seen-version'] = '<RELEASE_VERSION>'`。
- **右栏标签会被会话顶掉**：点行尾的"打开"是打开会话，右栏换成该会话的「对话 / 轨迹」，fleet 标签消失；
  要在 fleet 里下钻必须点**行体**（`.dsh-fleet-session-main`）。fleet 标签本身从右栏引导页的"智能体协同"打开
  （右栏收起时先点"打开右侧边栏"）；"开始"引导页只在没有打开会话时出现，所以先点"新会话"再进引导页最稳。

保存回写核对：保存后读隔离 home 的 `profiles/web/cordis.patch.yml`——DSH 会**追加**一条同名行
（`- id: oncall`），核对值时看**最后一条**；不要因为看到两行就以为保存了两次。


## 六、下一轮提示词（复制到新会话）

本页的任务（客户端 tsc 清零并接进构建、名册方向键走位、名册输入字段读事件）已在 2026-10-24 收口，
`剩余` 为空。下一轮如果继续这个仓库，从下面两条可选增强里挑，或者按用户的新目标开工：

```text
你在 DSH On-call 仓库继续做 P2 之后的收尾。仓库：D:\sudy\myproject\dsh-oncall；
DSH 源码只读：D:\sudy\github\deepseek-harness。分支 master，工作树有大量未提交改动，先 git status
看清现状，不要 reset / checkout / 覆盖任何已有改动。

先读：docs/design/p2-next-session-brief.md（基线、已收口项、验证配方与四个浏览器坑）、
.agents/notes/implemented/2026-10-24-client-half-typecheck.md（类型工程的取舍与棘轮收紧标准）、
packages/dsh-oncall/tsconfig.client.json。

可选的下一步（都不是缺口，做之前先跟用户确认范围）：
1. 按文件收紧 noImplicitAny：把已注解干净的纯模块（validate / format / naming / fleet/model）放进
   第二个 include 列表并开 noImplicitAny，判据见笔记 Consequences；不整仓翻。
2. 若出现第二个 listbox，再把方向键走位抽成公共函数（现在只有一个用户，抽等于造抽象）。

纪律（继续有效）：未知不是 0；缺失投影隐藏或写未加载；不新增 durable 事件类型、不改 SESSION_FORMAT_VERSION、
不碰 live profile、不改 DSH checkout；一个字段只有一个读者；闸门与接力分开；校验只有 rules.ts 一个表达式；
原生能力先查源码再动手；发现源码与计划冲突先停下说明冲突与证据（file:line）。
只改本仓库；改动要么是类型、要么配一条能变红的用例；交付时给原始输出，不声称跑过没跑的测试。

验证：npm run bundle --prefix packages/dsh-oncall（内含两份 tsc，exit 0）→ npm test 四套件
（当前基线 233 unit / 123 client-controller / 25 remote / 35 scenarios, 0 failure，只许涨或持平）→
npx tsc -p packages/dsh-oncall/tsconfig.client.json（0）→ 指定 host tsc（exit 0）→
node --check packages/dsh-oncall/lib/client.js（exit 0）→
git -C D:\sudy\github\deepseek-harness status --porcelain（0 行）。
```
