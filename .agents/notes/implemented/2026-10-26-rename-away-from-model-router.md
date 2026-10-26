# Agent Note: 把插件改名为 `dsh-model-desk`，因为职责已经不止路由

Status: implemented

## Problem

名字把职责圈在「模型路由」上，而实际交付是三块正交能力：跨渠道故障转移、渠道健康与探测、委派名册与交接（外加承载三者的工作台与 Agent Fleet 右栏）。后果不是审美问题：

- 新会话与新读者据名字推断出更窄的边界，把健康与交接读成「路由的附加功能」，每次都要重新解释一遍 `AGENTS.md` 的契约。
- 用户可见面已经不止路由：安装包名、配置页标题、通知前缀都挂着 router 词根，而其中两块能力与路由正交（只开交接、不开路由是合法组合）。
- 上游收回 `agent/request` 路由权之后（见 `proposed/2026-10-26-agent-request-is-no-longer-the-route-authority.md`），「路由」不再是这个插件的主语，名字会更失真。

## Decision

改名 **`dsh-models-router` → `dsh-model-desk`**，中文自称「模型工作台」；契约面（配置 ns、面板 id、service key、typert namespace）与外观面（包名、目录、README、仓库 URL）同批改，**持久化标识保持原样**。

准入门槛（可机械判定）：

1. 名字不把边界限定在「选择/路由」上：不带只表示选路的词根（`router`、`selector`、`fallback`）。
2. 能指代三块能力：故障转移、渠道健康与探测、委派与交接。
3. 配置 ns、面板 id、service key、typert namespace 用同一词根 `desk`，不出现两套自称。
4. 持久化标识不动：storage domain `model_router_sessions` 与 projection key `router/failover-history`、`router/channel-health`、`router/handoff`。动了会丢既有会话绑定与历史投影。
5. wire 契约（typert namespace）与四套件、`web*.overlay.yml` 同批改，不允许只改一半。

### 实际改了什么（本次落地）

| 类别 | 旧 | 新 | 覆盖 |
|---|---|---|---|
| 包名、目录 | `dsh-models-router` | `dsh-model-desk` | `package.json`、`packages/` 目录、根工作区名 `dsh-model-desk-dev`、README/CHANGELOG、仓库 URL |
| 配置 ns / bundle patch 行 id | `model-router` | `model-desk` | 64 处 src + 39 处 tests + 29 处 docs |
| service key | `modelRouter` | `modelDesk` | 10 / 2 / 2 |
| typert namespace（wire） | `routerHealth` | `deskHealth` | 12 / 25 / 7 |
| 源内标识符 | `ModelRouter`、`ModelRouterPanel`、`ModelRouterPanelIcon`、`ModelRouterIcon`、`ModelRouterCardState`、`RouterHealthService`、`RouterHealthRemote` | `ModelDesk*` / `DeskHealth*` | 13 个文件 |

**有意不改**：持久化标识（门槛 4）、CSS 类前缀 `dsh-router-*`（内部样式钩子，改它只会让样式与测试一起漂移）、通知前缀 `[路由切换]` / `[委派]`（描述行为，不是产品名）、`.agents/notes/archived/` 与 `memory/archive/` 中的旧名（冻结历史）。

### 验证

`npm run bundle` 通过；`npm test` 四套件 **233 / 123 / 25 / 35 场景 0 失败**。组合套件拉起的是真实 `dsh --profile headless --patch`，因此新包名、新配置 ns、新 typert namespace 三处同时在真实 Loader 组合里成立。

## Alternatives considered

1. 保持 `dsh-models-router`
   - 最强的理由：改名有真实破坏面——配置 ns 与 wire namespace 都带词根，改一次要求用户重配、要求浏览器半包与宿主同批发版；已发布到 0.5.0，成本立刻发生而收益是长期的。
   - 为何被否：门槛 1-5 把破坏面压到只剩「配置 ns 与 wire」两处，都能与一次发版同批；名字失真的成本是持续的。
2. 只改显示名与 README，包名与标识全不动
   - 最强的理由：零迁移、用户无感、文档立刻准确。
   - 为何被否：被 agent 与用户最先读到的是包名、配置 ns 与通知前缀，显示名藏在 README 里；只改显示名等于让最显眼的地方继续说谎。
3. 一次性全改，含持久化标识，写数据迁移
   - 最强的理由：一步到位，之后不存在两套自称。
   - 为何被否：收益只是「名字一致」，代价是用户既有会话绑定与历史投影要迁移或丢失，与门槛 4 冲突。
4. `dsh-channel-desk`
   - 最强的理由：三块能力都以「渠道」为对象——选它、观测它、把活分给它，比 `desk` 更具体。
   - 为何被否：「渠道」在 DSH 语境里已指 provider 配置页，容易让用户以为这是 provider 管理插件；而交接的对象是「角色」不是「渠道」，覆盖不住第三块。
5. `dsh-model-ops`
   - 最强的理由：运维语义贴合故障转移与健康探测。
   - 为何被否：`ops` 只覆盖前两块，委派与交接既不运维也不观测。

## Consequences

- 收益：包名、配置 ns、面板 id、service key、wire namespace 收敛到同一个 `desk` 词根；`AGENTS.md` 的九项交付不再需要靠解释才能成立。
- 代价：① 配置 ns 改名意味着存量配置需重写（bundle patch 行 id 变了，旧行不再被认领），**下一次发版说明必须写这一句**；② wire namespace 改名要求浏览器半包与宿主同版本，跨版本混装会让 Remote 找不到命名空间；③ 持久化标识保留旧词根，「数据层叫 router、产品叫 desk」是**有意的债**，不要在后来的会话里当成新发现的 bug 再改一次；④ 桌面 profile 里还有一份 0.5.0 的独立旧副本（真目录、未配置任何 patch 行），它不指向本仓库，改名不涉及它，但仍是旧名旧版。

### 执行中暴露的两处构建事实

1. **清空 `lib/` 之后 `npm run bundle` 会失败**：`tsc -p tsconfig.client.json` 需要**上一轮生成的** `lib/typert.remote-client.d.ts`（`src/client/apply.ts` 自引用 `<包名>/remote`），而生成器在 `tsdown` 阶段、排在两次 `tsc` 之后。干净 checkout 必须先 `npx tsdown` 生成一次再跑 bundle。这属于构建顺序缺陷，未在本轮修复。
2. **live profile 的 junction 会悬空**：`~/.dsh/profiles/web/node_modules/dsh-models-router` 是指向本仓库包目录的 junction，改名后 target 不存在，必须同步改名并重指。
