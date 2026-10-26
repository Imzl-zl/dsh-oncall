---
title: "DSH Model Desk — 下一轮：运行时对齐与委派名册（P2）"
status: "implemented"
kind: "handoff-brief"
last_updated: "2026-10-24"
---

# 下一轮：运行时对齐与委派名册（P2）

## 摘要

右栏 Agent Fleet 的优化已经落地并通过四套件与真实浏览器验证；配置中枢仍只有**路由链**和**渠道健康**两个页签，第三块（委派名册 = 子智能体预设）因为仓库没有 handoff host 而按 F-09 保持空缺。下一轮做两件事，顺序固定：

1. **运行时对齐**：把仓库的 `@deepseek-ai/dsh` 基线从 `0.2.0-rc.2` 升到与只读 checkout 同版（`0.2.1-rc.3`；先到 `latest` 的 `0.2.1-rc.2`，随后按 checkout 再对一次，见 §四之一与 [rc3 笔记](../../.agents/notes/implemented/2026-10-24-runtime-alignment-rc3.md)），让 `npm test`、本地启动与浏览器验证跑在同一条运行时上。
2. **P2 委派名册整包**：host 配置段 + 一个 `handoff` 工具 + `router/handoff` 投影与三本账 + 配置页第三页签。host 不落地就不注册页签（不造空壳、不放假名册）。

## 一、起点基线（2026-10-23 实跑）

| 项 | 事实 |
|---|---|
| 代码 | 右栏：`client/fleet/`（全局/单会话、共享导轨 + 1.8s 流动点、`DisclosureRow` 分组、`Tooltip` 长标题、`pause()/resume()`）；配置页：路由链 + 渠道健康（本轮未改） |
| 测试 | `207 unit` / `108 client-controller` / `21 remote` / `35 scenarios, 0 failure`（`.sessions/cap22-npm-test-final.log`） |
| 类型/构建 | 指定 host `tsc` exit 0；`node --check lib/client.js` exit 0；客户端半包有独立 tsc（`tsconfig.client.json`，已接进 `bundle`） |
| 浏览器 | 隔离 home + 桌面 `0.2.1-rc.2` 运行时：1440→648、1025 展开→345、1025 收起→569、801→345、全屏列 920；22 个真实会话、`已加载 20 / 22`；4f20 = 8 chip + `+5`；截图 `docs/assets/ui/fleet-cap-*.png` |
| 已知差距 | F-02（无原生 batch）、F-03（无步数/预算/进度）、F-07（`SessionListState` 无 error）、F-09（无 handoff host）、F-12（文档数字已更正）；流动点在隔离 home 无 running 数据，仅样式探针 + 组件测试 |
| 环境差异 | 仓库 devDependency 是 `0.2.0-rc.2`，桌面产品是 `0.2.1-rc.2`；旧宿主拒绝解析新运行时写的日志（`job/registered` → `gateway/internal`，禁用插件同样复现） |

## 二、任务 A：运行时对齐（先做）

> 本节保留 2026-10-23 的计划原文（当时目标是 `0.2.1-rc.2`）；最终依赖值以 §四之一 为准：
> 根 `0.2.1-rc.3`、peer 六个 `^0.2.1-rc.3`。

**为什么先做**：浏览器验证已经被迫换运行时；测试基线停在旧版，等于“验收环境 ≠ 交付环境”。产品只跟随最新 rc，旧 rc 没有维护价值。

**改什么（范围最小化）**：

1. 根 `package.json`：`@deepseek-ai/dsh` `0.2.0-rc.2` → `0.2.1-rc.2`（当时 npm `latest` 就是它）；最终基线随后按只读 checkout 定在 **`0.2.1-rc.3`**，以 §四之一 与 rc3 笔记为准。
2. 插件 `package.json`：`devDependencies.@deepseek-ai/dsh-typert-generator` 同步到 `0.2.1-rc.2`；`peerDependencies` 的五个 `@deepseek-ai/dsh-*` 从 `^0.2.0-rc.2` 改为 `^0.2.1-rc.2`。**semver 预发布坑**：`^0.2.0-rc.2` 不匹配 `0.2.1-rc.2`（只有同 `major.minor.patch` 元组带预发布才放行），不改 peer 范围会在安装期报冲突。
3. 重新生成锁文件与 typert 产物；不动 `CHANGELOG` 版本号（版本号是发布决定，不是对齐决定）。

**可能出问题的地方（按概率）**：

- `dsh-typert-generator` 生成物（`lib/typert.*`、remote 契约）字段或签名变化 → `remote.mjs` 的 21 个用例先红。
- Loader 组合/`cordis.patch.yml` 的 bundle 形态变化 → `run.mjs` 的 35 场景先红。
- 桌面版新增的 durable 事件类型（如 `job/*`）进入 `SessionEvent` 联合 → 我们的两个投影 `apply` 需要穷尽分支或显式忽略（`health.ts`、`lineage.ts`）。
- `ui-primitives` 0.2.1 的 `DisclosureRow`/`Tooltip` 已经在本轮浏览器里实际跑过（桌面运行时就是 0.2.1），所以客户端侧风险低。

**验收**：`npm run bundle` → 四套件全绿（35 场景 0 失败）→ 指定 `tsc` exit 0 → `node --check lib/client.js` → 用 **npm 宿主**（`node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web`）起隔离 home，能读出 22 个会话的投影（不再出现 `gateway/internal`）。失败就回滚依赖并在这里记下具体红点，不把“升不上去”写成“新版不支持”。

## 三、任务 B：P2 委派名册（host 先行）

单源：字段、默认值、闸门语义全部以 [handoff-proposal.md](handoff-proposal.md) §5/§12 为准，本页不复述表格，避免第二真相源。落点与次序：

| 步 | 落点 | 内容 | 完成判据 |
|---|---|---|---|
| B1 | `src/config.ts` | 新增 `handoff` 段（`enabled`、`subagentBackend`、`protocol`、`limits`、`newSession`、`onUnreceiptedStop`、`roster[]`），默认值照 §12；保存期校验：`purpose` 非空、`preset` 与 `instructions` 至少一个非空、`instructions ≤ 4000`、`id` 唯一、`provider/model` 可解析 | 配置能存能读；坏值被拒并给出字段级原因；不新增 durable 事件类型、不改 `SESSION_FORMAT_VERSION` |
| B2 | `src/index.ts` | 一个 `handoff` 工具四个动作：`delegate` / `finish` / `newSession` / `facts`（前三可关，`newSession` 随接力配置）。派发用 `ctx.subagents.startActivation`；唤醒只用 `agent.followup` / `agent.steer`；接力用 `ctx.agents.createSession` + `selectForNextRequest`；目标用 `ctx.goals`；非顶层会话在 handler 内拒绝 | 工具在真实 Loader 组合里注册成功；拒绝路径有明确错误，不静默降级 |
| B3 | `src/index.ts` + `src/handoff.ts` | 一个 `ctx.sessionProjections.register('router/handoff')`：折叠 `tool/call`、`subagent-settled` 与 `finish` 回执；三本账（派发 / 复核 / 新会话）按 user message 重置，接力不重置；复核账本落 `storageDomain`，无 storage 时内存 + 可见 notice | 投影可回放；账本与闸门在组合测试里可断言；没有 storage 时不假装持久 |
| B4 | `src/client/page.ts` | `SegmentedTabs` 两个 → 三个；名册页：224px 列表（最大高 420px，独立滚动，选中项滚入视野）+ 编辑器；校验摘要置顶；保存走现有 `configForms` / `scope.mutate` / `validate` | 12 角色压力下不撑爆页面；保存被拒时摘要 + 字段级红框同时出现；**页签只在 B1 落地后注册** |
| B5 | 验证 | Loader 组合（工具注册、投影折叠、三本账闸门、接力六步）+ 浏览器（12 角色 / 10 智能体 / 800-1440 / 空态 / 校验拒绝） | 四套件 + 指定 tsc + 浏览器截图 |

**优雅约束**：

- 一个工具、一个投影、一个账本；不给每个动作各造一条保存链路。
- “一个字段只有一个读者”：`purpose` 只给主模型，`instructions` 只给子智能体——这条写在名册页常驻 hint 里。
- 闸门与接力分开：`protocol.requireReviewFor` 是收工拒绝条件，`newSession.*` 是工具与接力行为；不合并成一组开关。
- 第三页签的可见性绑定 host：没有 `handoff` 段就不注册，也不放“即将上线”占位。

## 四、决策点（需要产品 owner 拍板）

1. **已定**：依赖跟只读 checkout（`0.2.1-rc.3`），不跟 npm 的 `latest` / `next` 标签浮动（当时 `latest` 是 rc.2，`next` 是 rc.3）。理由与代价见 [rc3 笔记](../../.agents/notes/implemented/2026-10-24-runtime-alignment-rc3.md)。
2. 名册 v1 是否包含 `newSession` 接力？建议包含，但 `onFinish` 默认为空（不自动接力）。
3. 复核账本在无 storage 时的降级：内存 + notice（建议），还是禁用复核闸门？
4. 三本预算的入口：放页签顶部（提案 §5.3），还是收进“收工闸门”分区？建议顶部，和“每回合派发”分开。

## 四之一、实施结果（2026-10-24 实跑）

> 这里是第一次对齐（`0.2.1-rc.2`）的记录；当天随后按只读 checkout 再对齐到 **`0.2.1-rc.3`**
> （四个声明型 devDependency 同步、六 peer 改 `^0.2.1-rc.3`，测试重测为 233/123/25/35）。
> 最终值与取舍见 [rc3 笔记](../../.agents/notes/implemented/2026-10-24-runtime-alignment-rc3.md)。

**任务 A（运行时对齐）已落地**，依赖与锁文件：

- 根 `package.json`：`@deepseek-ai/dsh` 0.2.1-rc.2；`zod` 由 `^4.6.6` 固定为 `4.4.3`（DSH 每个包都精确钉 4.4.3，见下）。
- 插件 `package.json`：`@deepseek-ai/dsh-typert-generator` 0.2.1-rc.2；peer 的五个 `@deepseek-ai/dsh-*` 改 `^0.2.1-rc.2`，新增 `@deepseek-ai/dsh-tools`；`zod` peer 改 `^4.4.3`。
- `packages/dsh-model-desk/.npmrc`：`legacy-peer-deps=true`，让 peer 由根 workspace 解析。否则 npm 会在这个包下自动装 peer，并选中 **0.2.1-rc.3（next）** 与第二份 zod（4.6.7）。

四个真实差异（都不是"新版不支持"）：

1. **zod 精确钉版 → 类型同一性**：0.2.0-rc.2 的包依赖 `zod: ^4.4.3`，0.2.1-rc.2 全部改成 `zod: 4.4.3`。out-of-tree 安装于是出现两份 zod（根的 4.6.7 与嵌套的 4.4.3），`domainTable(bindingSchema)` 的推断爆栈（`TS2589`，默认堆直接 OOM）。修法是把 dev 环境的 zod 对齐到 4.4.3 并让 peer 从根解析，不是给调用点加类型断言。
2. **typert 生成物注入 zod runtime**：0.2.1-rc.2 的生成器把 zod 传进 remote metadata 工厂（`@deepseek-ai/dsh-typert-generator` 提交 `bd91a4a570`），`client/apply.ts` 又 import 了 `dsh-model-desk/remote`，于是客户端 bundle 一度内联了整份 zod（562 kB → 874 kB）。DSH 的 shell 模块表本来就 seed 了 `zod`（`packages/client/web/src/platform.ts:12`），所以 `tsdown.config.ts` 的 `clientModules` 补上 `zod`，bundle 回到 445 kB。
3. **`TypertGateway.invoke` 现在必须带 peer**：`assertPeerLive(peer)` 读 `peer.signal`，不传 peer 就是 TypeError（`api-gateway` 0.2.1-rc.2）。测试按 DSH 自己的 gateway spec 造 owner peer（`new Peer(ctx.root, { principal: { kind: 'owner' } })`）。
4. **`SessionBindings` 的首读早于域打开**：`persistent` 在 open 落定前是 `false`，remote 首读会把一份持久绑定报成"仅内存"。补 `ready()`，`sessionBinding` 先 await 它。

验收（原始输出见 `.sessions/p2-npm-test-2.log`）：

- `npm run bundle`：host 202.60 kB / client 444.92 kB。
- `npm test`：**220 unit / 116 client-controller / 24 remote / 35 scenarios, 0 failure**。
- 指定 `tsc`：exit 0；`node --check lib/client.js`：exit 0。
- 浏览器（npm 宿主 `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 3499`，`DSH_HOME=%TEMP%\dsh-fleet-cap-22`）：能读出同一批会话的投影（"已加载 20 / 23"），宿主日志无 `gateway/internal`。

落地后的状态快照、原生能力核对、剩余缺口与下一会话提示词见 [p2-next-session-brief.md](p2-next-session-brief.md)。

**任务 B（P2 委派名册）已落地**：B1 配置段与校验、B3 投影与账本、B2 一个工具四个动作、B4 第三页签与主从编辑器、B5 验证。偏离见 [agent-fleet-drawer.md](agent-fleet-drawer.md) §9.3 的 F-09 / F-14…F-21；取舍理由见 [决策笔记](../../.agents/notes/implemented/2026-10-24-handoff-roster-and-gates.md)。

浏览器实测（截图在 `docs/assets/ui/`）：1440 右栏列 960、12 角色列表 224px / 420px 独立滚动（scrollHeight 592）、1025 两列、801 侧栏收成图标且无横向溢出、大屏列 960；空态是激活卡；清空 purpose 后保存按钮 disabled + 摘要置顶 + 字段 `aria-invalid`；改回后保存把 `handoff` 整段写回 profile patch（磁盘核对到新文本与 host 补全的字段）。DOM 里没有本插件自绘的 `position: fixed`、遮罩、标签条或关闭/全屏按钮。

**仍未做**：右栏活动流未接 `router/handoff`（F-21）；`facts` 的 goal/todos 依赖宿主投影与 `ctx.goals`，headless 组合里没有 `sessionController`，因此 `newSession` 的真实建会话只在浏览器侧手工可用、没有自动化用例覆盖（组件测试覆盖拒绝路径与闸门）。

## 五、新会话提示词（复制到新会话）

> 本提示词对应的任务 A/B 均已执行；其中"升到 `0.2.1-rc.2`"与"客户端无独立 tsc"两条已被
> [rc3 笔记](../../.agents/notes/implemented/2026-10-24-runtime-alignment-rc3.md) 与
> [p2-next-session-brief.md](p2-next-session-brief.md) §一 取代。当前基线以那份简报为准，不要照本段重新升级。

```text
你在 DSH Model Desk 仓库做两件事，按顺序：先做运行时对齐，再做 P2 委派名册（配置中枢第三块）。仓库：D:\sudy\myproject\dsh-model-desk；DSH 源码只读：D:\sudy\github\deepseek-harness。当前分支 master，工作树有未提交改动（P1 + 本轮 Fleet 优化 + 文档 + 截图），先 git status / git diff 看清现状，不要 reset、checkout 或覆盖。

第一步先读：
- AGENTS.md、docs/AGENTS.md、.agents/notes/AGENTS.md
- docs/architecture.md
- docs/design/p2-roster-and-runtime-alignment.md（本计划：基线、任务 A/B、验收、决策点）
- docs/design/handoff-proposal.md §5 / §12（名册字段与默认值的唯一来源）
- docs/design/agent-fleet-drawer.md §5.3 / §9.3 / §10.1
- docs/design/agent-fleet-next-session-brief.md §1.1（上一轮实施与浏览器结论）
- packages/dsh-model-desk/src/config.ts、src/index.ts、src/client/page.ts、src/client/locales.ts、tests/
- 上一轮决策：.agents/notes/implemented/2026-10-23-agent-fleet-capability-review.md

背景事实（已核实，不要重新调研）：
- npm latest = 0.2.1-rc.2，桌面运行时也是 0.2.1-rc.2；仓库 devDependency 仍停在 0.2.0-rc.2，旧宿主拒绝解析新运行时的日志（job/registered → gateway/internal，禁用插件同样复现）。
- 配置页现在只有「降级链路」「渠道健康」两个页签（client/page.ts:37-84）；仓库 src/ 里 handoff / roster / subagentBackend / maxDelegations 零命中；Candidate 只有 provider/model/maxRetries/weight/needs。第三页签属于 P2，按 F-09 不得注册空壳。

任务 A（先做，独立可回滚）：把 @deepseek-ai/dsh 从 0.2.0-rc.2 升到 0.2.1-rc.2；插件 devDependency 的 @deepseek-ai/dsh-typert-generator 同步；peerDependencies 的 @deepseek-ai/dsh-* 改为 ^0.2.1-rc.2（注意：^0.2.0-rc.2 不匹配 0.2.1-rc.2 的预发布，必须改范围）。重生成锁文件与 typert 产物。然后 npm run bundle + 四套件（unit / client-controller / remote / run 35 场景）+ 指定 tsc + node --check。红了就逐个查真实差异（typert 生成物、Loader 组合、新的 durable 事件类型进入 SessionEvent 联合后投影 apply 的穷尽性），修不了就回滚这一项并在页面里记具体红点，不要写成“新版不支持”。

任务 B（A 绿了再做）：按 handoff-proposal §5/§12 落 B1 host 配置段（含校验）→ B3 router/handoff 投影与三本账 → B2 一个 handoff 工具四动作（delegate/finish/newSession/facts）→ B4 client 第三页签与名册主从编辑器 → B5 验证。host 不落地就不注册页签；不放假名册、不做占位页、不用 alert、不做 mock 成功路径。

实现要求：
- 不重写 47k 页面 controller；配置页复用现有 configForms / scope.mutate / validate，不建第二套保存链路。
- 字段与默认值只从 handoff-proposal §12 取，不在 UI 或 config 里再抄一份。
- 一个 handoff 工具、一个 router/handoff 投影、一个账本；闸门（requireReviewFor 等）与接力（newSession.*）分开。
- 只用 DSH token 与 @deepseek-ai/dsh-client-ui-primitives；容器查询继续，不写 vw 固定宽度；CSS 注入继续 cssText 双形状归一。
- 未知不是 0；缺失投影隐藏或写未加载；不新增 durable 事件类型、不改 SESSION_FORMAT_VERSION；不碰 live profile；不改 DSH checkout。

验证：
- npm run bundle --prefix packages/dsh-model-desk（客户端测试跑 lib/client.js）。
- npm test 四套件；指定 npx tsc --noEmit --skipLibCheck --strict --module nodenext --moduleResolution nodenext --target es2022 --allowImportingTsExtensions packages/dsh-model-desk/src/index.ts；node --check packages/dsh-model-desk/lib/client.js。
- 客户端半包有独立 tsc：`npx tsc -p packages/dsh-model-desk/tsconfig.client.json` 必须 exit 0（`bundle` 已内含）；不得声称没跑过的检查通过。
- 浏览器：DSH_HOME 指向隔离 home（例如 %TEMP%\dsh-fleet-cap-22），这次用 npm 宿主起（对齐后它应能读同一批日志）；覆盖 1440/1024/800/全屏、12 角色名册、校验拒绝、空态、保存回写、DOM 无 position:fixed/遮罩/自绘标签条/自绘关闭全屏。截图写 docs/assets/ui/，不覆盖已有文件。

文档与收尾：
- 偏离写 docs/design/agent-fleet-drawer.md §9.3（F-09 从“宿主阻塞”改为落地后的事实；新增项按需编号）。
- 非平凡决策写 .agents/notes/implemented/（工作树已有 note 格式可参照），代码入口留一行回指。
- 结束时给：改动文件、原始测试输出、截图路径、偏离表、未解决缺口；不要声称跑过没跑的测试。先做实现，不要重新输出一版大计划；本提示词与 docs/design/p2-roster-and-runtime-alignment.md 就是计划。若发现源码与计划冲突，先停下来说明冲突和证据（附 file:line），再决定是否 adjust。
```

## 六、不做

- 不跟 npm 的 `next` 标签浮动；基线跟只读 checkout（当前 `0.2.1-rc.3`），见 [rc3 笔记](../../.agents/notes/implemented/2026-10-24-runtime-alignment-rc3.md)。不跟 alpha。
- 不注册没有 host 的第三页签，不放“即将上线”占位。
- 不在本轮改右栏 Fleet 的既有语义（F-02/F-03/F-07/F-08 保持）。
- 不新增 durable 事件类型、不改 `SESSION_FORMAT_VERSION`、不碰 live profile、不改 DSH checkout。
