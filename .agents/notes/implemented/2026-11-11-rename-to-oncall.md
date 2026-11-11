# Agent Note: 改名 `dsh-oncall`，并把持久化标识与样式前缀一并改掉

Status: implemented

## Problem

三个名字同时在用，而且都说错了一件事：

1. **`dsh-model-desk` / `model-desk`** 描述的是「模型工作台」——一个调模型的地方。产品实际做的是「值班」：有人在 issue 里 @ 它，它把活干完，渠道挂了它自己换。名字把产品说小了。
2. **改名窗口在关闭**。包从未发布（npm 上 `dsh-model-desk` 是 404），所以现在改是零成本；但 bundle patch 的行 id 就是设置命名空间，一旦有人把 `model-desk` 写进 profile，改名就要连带迁移配置。越晚越贵。
3. **上次改名留了尾巴**。2026-10-26 从 `dsh-models-router` 改到 `dsh-model-desk` 时，有意保留了 `model_router_sessions`、`router/*` 投影键、`dsh-router-*` 样式前缀，理由是「改了会丢历史」。这留下两套词根，读代码的人要在两个词汇表之间翻译。

## Decision

选 **`dsh-oncall`**，中文名 **「值班台」**，一次改到底：

| 面 | 旧 | 新 |
|---|---|---|
| 包 / 仓库 / 目录 | `dsh-model-desk` | `dsh-oncall` |
| 根工作区 | `dsh-model-desk-dev` | `dsh-oncall-dev` |
| 配置 ns / bundle 行 id | `model-desk` | `oncall` |
| Cordis service key | `modelDesk` | `oncall` |
| Typert ns | `deskHealth` | `oncallHealth` |
| 类与组件 | `ModelDesk*` | `OnCallDesk*` |
| CSS 前缀 | `dsh-router-*` | `dsh-oncall-*` |
| 持久化域 | `model_router_sessions` | `oncall_sessions` |
| 投影键 | `router/failover-history` 等 | `oncall/failover-history` 等 |
| 中文显示名 | 模型工作台 | 值班台 |

**冻结不改**：`.agents/notes/`（决定记录）、`spike/`（Phase 1 实证产物）、`CHANGELOG.md` 的旧版本条目。它们记录的是当时的事实，改写等于伪造历史。

**保留不改**：通知前缀 `[路由切换]` / `[委派]`——它们描述行为，不是品牌。

## Alternatives considered

- **`dsh-shiftdesk` / `dsh-ticketdesk` / `dsh-casework`**：都在描述「台」（载体），没有一个描述「值班」（行为）。产品的一句话是「给仓库配一个不睡觉的同事」，只有 oncall 同时表达「没人盯着也在」和「出事顶上」。
- **只改显示名、不改包名**：省一次迁移，但 npm 上永远叫 model-desk，`dsh.oncall` 这类检索永远找不到；而且行 id 仍是 `model-desk`，设置里显示的名字和命名空间对不上。
- **保留持久化键**：能留住旧绑定与历史投影。但包从未发布，唯一可能的存量是开发者本机；而这些键恰是「两套词根」的主要来源。改掉，并在 `installIngress` 检测旧 `model-desk` 行时报错给改法，比长期背债便宜。

## Consequences

- 旧 profile 里的 `model-desk` 行不会被认领；加载入口时会打一条错误日志指出改法。旧 `router/*` 投影读不到，历史切换记录看起来是空的——这是改名的代价，接受。
- 根目录 `D:\sudy\myproject\dsh-model-desk` → `dsh-oncall` 需要先退出当前进程：Windows 不允许改一个正在被当作 cwd 的目录；脚本为 `D:\sudy\myproject\rename-root.ps1`。
- `GITHUB_TOKEN` 等外部契约不变。
- 验证：`npm run bundle` 通过；11 套全绿（unit 259 / client-controller 129 / remote 25 / handoff-relay 20 / ingress 25 / github-issue 16 / pass 13 / github-http 10 / ingress-loop 11 / layers 守卫 / run 37 场景 0 失败）。
