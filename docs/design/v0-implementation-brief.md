---
title: "V0 实施交接单：把 executor 与回执接上"
status: "proposed"
kind: "handoff-brief"
last_updated: "2026-11-11"
---

# V0 实施交接单

**目标一句话**：让 `ingress` 从"只建 Case"走到"@ 一次就干、干完回评论、重启知道断在哪、渠道挂了换路"，全程照 `docs/design/oncall-v0-architecture.md`，不重新设计。

## 起点

- 仓库 `D:\sudy\myproject\dsh-oncall`，HEAD `647bced`，工作树干净，前三个 commit 是设计定稿。
- 设计现状：`docs/design/oncall-v0-architecture.md`（权威）。核对记录：`oncall-v0-mapping.md`（只在需要查出处时读）。裁定：`open-questions.md` §14.2。
- 已实测的四条运行时事实：`tests/executor-probe.mjs`（19 checks 0 failed，含真实 provider 一轮对话）。配方在 `tools.md`。

## 必读（按序，只读指定节）

1. `AGENTS.md` → `memory.md` 顶部条目 → `tools.md`（**"executor 依赖的四条运行时事实已实测"那一段**与陷阱）。
2. `docs/design/oncall-v0-architecture.md`：§〇 理念、§二之一 耦合控制、§三 数据模型、§四 流程、§五 差异、§六 实测、§八 清理清单、§九 不做。
3. `docs/design/open-questions.md` §14.2（八条已定案）。
4. 参考实现按需查：`D:\sudy\github\dsh-superagent-prototype`（`core/intake.ts`、`core/tickets.ts`、`core/assignments.ts`、`app/delivery.ts`、`app/outbox.ts`、`executor/dsh.ts`、`app/tools/executor.ts`）；`D:\sudy\github\comet`（`domains/comet-classic/classic-transitions.ts`、`classic-state-command.ts`）。**只读，不改。**

## 已定案，不要重开

1. `threads` 表存 `subscriptions: caseId[]`（订阅在开 Case 时建立），`mandate.scope` 只是授权范围 —— 不要用 scope 派生归属。
2. `steps` 就是 `Assignment`：`{caseId, seq, state: running|ended, brief, report, at}`；回合结束只写 `report`，派工仍 `running`。
3. 回执是 receipt：`caseId#seq` → `pending/sent/gone/failed`；投递幂等靠消息 id（`MessageId('oncall:caseId#seq')`），不靠扫 GitHub。
4. 关 Case 由 core 决定：`ready` → `completed`，`dropped` → `dropped`；`blocked/failed` 留开。
5. 无 report 的回合结束 = `waiting`（不冒充完成）；`turn/end{interrupted}` 不结算，走"新派工 + `RECOVERY_NOTE`"。
6. `oncall_report` 的 `state` 只有 `progress/ready/blocked/failed/dropped`（`waiting` 是 executor 写的，模型不能报）。
7. 层 B 只在层 A 报 `exhausted` 时开火；退避优先 `turn/end.error.providerRetryAfterMs`，否则 30/60s，≤2 次。
8. V0 **没有评估层**：thread 有 owner 就投给 owner，没有才过闸门。一张 issue 上两件独立的活不分开（V1 再说）。
9. 域版本**保持 1**：加表不改版本（升版本会 `version-mismatch` 砸现场）。
10. 终局失败**发一条 comment**（增强：我们读者在 GitHub）。

## 实施顺序（每步单独 commit，可单独回退）

### 第 1 步：账本地基（无行为变化）
- 改：`contract/types.ts`（`ThreadRecord` + 审计事件三种）、`runtime/ledger.ts`（`Commit.threads` + 新读写方法）、`runtime/durable-ledger.ts`（三张表，版本 1）。
- 验：`tests/ingress-loop.mjs` 加"缺表按空表 / 域关闭后拒写 / 新表读写"；`npm test` 全绿。

### 第 2 步：归属与扇出
- 改：新 `core/thread-owner.ts`（纯）、`runtime/pass.ts`（有主→审计 `case.followed-up` + 交给 executor；无主→`admit`→开 Case + 订阅）。
- 验：`tests/pass.mjs` 加"同 thread 第二条评论不开新 Case""人停掉的不复活""新 issue 正常开"；`layers.mjs` 仍绿。

### 第 3 步：executor（必须真实 Loader 验证）
- 改：新 `runtime/executor.ts`（`TurnHost` 端口：`resolveAgent/create/selectModel/followup/whenIdle/persistence`；启动扫描；`agent/status` idle + `whenIdle`；消息 id 幂等；`interrupted` 恢复；层 B）、`index.ts` 接线。
- 验：新 `tests/oncall-loop.mjs` —— 真实 `web` profile（`--port 0`，独立 `DSH_HOME`）+ 本地假 GitHub（`ingress.baseUrl` 指向本机 http server）+ stub adapter：@ 一次只开一个 Case、追问进同一会话、重启带 recovery note。
- 不变量：executor 里不出现 `provider/model/github/fetch`。

### 第 4 步：report 工具 + 回执
- 改：新 `faces/reports.ts`（`oncall_report`，全局注册 + 会话归属校验）、新 `core/reply-plan.ts`（纯：report → `result|attention|failed|undefined`）、新 `runtime/outbox.ts`、`sources/github-face.ts` + `github-http.ts`（`createComment`）。
- 验：reply-plan 纯表单测；`oncall-loop` 断言"发一次、重放不重发、`gone` 不再发"。

### 第 5 步：配置与收尾
- 改：`config.ts` 加 `ingress.baseUrl`（默认 `''` = api.github.com）与 `ingress.workdir`（默认 `''` = 进程 cwd）；README 入口段把"现在只建 Case，不执行"翻面；`overview.md` 状态表；CHANGELOG；`memory.md`/`tools.md` 更新；决策笔记。
- 验：`npm test` 11 套 + `npm run bundle`；再跑一次 `tests/executor-probe.mjs` 确认没有破坏已实测的四条。

## 硬约束与陷阱

- DSH 源码树 `D:\sudy\github\deepseek-harness` 只读；`git -C` 必须 0 行。
- 不引入第二份状态；一个事实一个写者（表所有权见架构文档 §二之一）。
- 隔离实验只用**新目录名**（`mkdir -p`），**不做删除**；Windows PowerShell 里 `$HOME` 只读，别用 `$home` 拼路径去 `Remove-Item -Recurse`。
- 跑 DSH 用 bash：`& 'D:\soft\Git\bin\bash.exe' -lc '...'`。
- `--patch` 必须放在 app flags 之前；隔离实例一律 `--port 0`；验 GUI 保存只能用 `dsh plugin add` 装的 home。
- 四个读产物的套件开头有 `assertFreshBuild()`：改源码先 `npm run bundle`。
- 子进程组合里抓不到 `logger.warn`，要断言就走返回值 / 状态 / 落盘。

## 总验收（用户视角）

| 验收 | 判据 |
|---|---|
| @ 一次只动一次 | 同 trigger 第二次轮询 `hasCase` 命中；同 Case 有 running step 时不开第二个会话 |
| 同 thread 追问回同一 Case | `threads.subscriptions` 命中 → 不发新 Case；会话里能看到这句原文（消息 id 可查） |
| 重启后知道上一刀干到哪 | 读到 running step + `turn/end{interrupted}` → 新派工带 `RECOVERY_NOTE` |
| 渠道挂了换路且审计可见 | `step.report` 带 sessionId → 会话 `oncall/failover-history` 有切换记录 |

## 完成时

更新 `memory.md` 顶部条目（数字与结论）、`tools.md`（新命令/新坑）、README 的特性段、CHANGELOG 的 Unreleased；写决策笔记（`.agents/notes/implemented/`）；提交并（用户同意后）推送。
