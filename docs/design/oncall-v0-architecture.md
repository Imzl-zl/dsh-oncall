---
title: "DSH On-call — V0 架构设计（照参考实现落地）"
status: "proposed"
kind: "architecture"
last_updated: "2026-11-11"
---

# V0 架构设计

设计原则一句话：**每一块都先问"superagent / comet 怎么做的"，同形落地；只有"我们没有它那个前提"时才收窄，收窄处写清代价。** 逐条核对记录（含 `file:line`）在 [`oncall-v0-mapping.md`](oncall-v0-mapping.md)，本文只写"做成什么样"。

## 〇、它们的设计优势在哪（我们照什么）

**superagent（`docs/000-philosophy.md:5`）**：公理是 *Take as little human attention as possible, and give as much value as possible.* 推论：

| 原则 | 原文锚点 | 我们的对应物 |
|---|---|---|
| 只在被要求或有书面规则时行动 | `:15` | 闸门 + `acceptMode: off/observe/auto`（已有） |
| **只在“人要行动或结果可用”时说话**，干活时安静 | `:16` | 回执门禁：`progress`/`waiting`/`interrupted` 不发；`ready`/`blocked`/做不到时才发 |
| 一次只问一个具体问题，结构化 | `:17` | `oncall_report` 的 `question` 字段，不埋在 summary 里 |
| 按影响停，不按工作量停 | `:18` | 关 Case 由 `ready`/`dropped` 报告决定，不由插件拿步数猜 |
| 诚实报告：失败就是失败，不为避问而绕限 | `:19` | 无报告时回合结束算 `waiting`（不冒充完成）；`interrupted` 不结算；失败带 `code` |
| 少概念 | `:25` | V0 只加 3 张表 + 1 个工具；不加“订阅管理页”“评估开关”这类概念 |
| 少设置 | `:26` | 新设置只有一个 `ingress.baseUrl`（测试与企业版共用），其余全是默认值 |

**comet（`docs/architecture/ARCHITECTURE.md` 四节）**：公理是**状态可信、可恢复、不可被 agent 误改**。

| 原则 | 原文锚点 | 我们的对应物 |
|---|---|---|
| 用户态 / 机器态 / 审计流三分 | `:130` | `cases`（用户可读）+ `steps`/`replies`（机器态）+ `audit`（追加） |
| machine-owned 字段拒绝直接写 | `classic-state-command.ts:604-605` | 三张表只由插件写；工具只交 `report`，不写表 |
| 一张转移表，多消费者共享语义 | `:129` | `core/stage.ts` 一处派生，面板/通知/审计都读它 |
| 审计流不取代状态文件、不做第二份可编辑源 | `:130` | `audit` 只追加，从不被读来推状态 |

**没抄到的**：comet 的 checkpoint / trajectory 精确恢复（我们 V0 是 superagent 的“重启重派 + `RECOVERY_NOTE`”）；superagent 的评估层与 observe 两道闸（我们只有闸门的 observe）。两条都写在第五节。

## 一、V0 与参考实现的对应

| V0 部件 | 参考实现 | 关系 |
|---|---|---|
| 入口 pass | superagent `app/passes.ts`：定时只做 `effects.kick()` + `evaluateDue()`，pass 不干活 | 同形（已实现，timeout 链） |
| 收消息与扇出 | `core/intake.ts`：trigger 存一次→按 Thread 订阅扇出 Input→**没人拥有才进评估** | **同形**（评估层见第六节） |
| 闸门 | `core/evals.ts` 的 `policy.gate()` + `core/admission`（我们已有） | 同形，纯函数 |
| 工作单元 | `Assignment`：`state: pending→running→ended`、`report{state,summary,at}`、`deliveredAt`、`idleAt` | **同形压缩**（去掉 Input 队列，见三、2） |
| 执行会话 | `sessions.ts:138-153` `resolveAgent`→`create({sessionId,cwd})`→`rename`；`dsh.ts:24` 会话 id 是纯函数 | 同形（`oncall-case-<id>`） |
| 等回合结束 | `dsh.ts:479-486` 订阅 `agent/status` 的 `idle`，后台任务里 `whenIdle()`；`agent/created` 里不得 await | 同形 |
| 投递幂等 | `delivery.ts`：`MessageId('…:requestId')` + 重放会话日志 + `inbox` | 同形 |
| 状态派生 | `core/stage.ts` 26 行 + `docs/003` 七行表 | 同形（我们 `core/stage.ts`） |
| 回执 | `core/replies.ts` 四种 purpose + `app/outbox.ts` receipt + `(kind,key)` 去重 + 5s→300s 退避 | 同形，参数后置 |
| 机器态 | comet：`run-state` 只由插件写，`state-events.jsonl` 追加审计，`set` 拒写 machine-owned | 同形 |
| 失败处理 | 层 A（我们独有）+ 层 B（`dsh.ts:30` 的瞬时重试形状，判据换成"层 A 报 exhausted"） | 增强 + 收窄参数 |

**增强（不属于取舍，是它们没有的前提）**：① 一次请求内的跨渠道切换；② 入口（它们为独立部署做的 Source 体系）；③ 把"链已耗尽"交给层 B 的 `turn-verdict`。

## 二、分层与模块

守则由 `tests/layers.mjs` 强制：`contract/` 只依赖自己；`core/` 只依赖 `contract/` + `core/`，且**无 I/O**（`ctx.`、`Date.now(`、`Math.random(`、`.append(`、`.put(`、`await ` 一律禁）。

```
L1 contract/   types.ts（CaseRecord / StepRecord / ReplyRecord / Outcome）
               defaults.ts（RECOVERY_NOTE / 瞬态重试次数与起点 / 回执重试表 / 标题上限）
L2 core/       thread-owner.ts   给定 threads 订阅与 case 列表 → 这条 trigger 归谁（纯）
               stage.ts         扩：assignment 级（照参考 stage.ts 的七行）
               plan-step.ts     扩：从「无 step / 已结算」推下一条 step（纯）
               reply-plan.ts    report/关闭结果 → 要发哪一条回执（纯，照 replies 的 purpose 门禁）
               scopes.ts        追加式文本 → 发给 worker 的 brief（含 recovery note）
L3 state/      runtime/ledger.ts（端口）+ runtime/durable-ledger.ts（表与迁移）
L4 runtime/    pass.ts          读 → 扇出/闸门 → 开 Case/订订阅 → 一次 commit
               executor.ts      Assignment 生命周期：起会话、投递、等 idle、结算、重启
               outbox.ts        回执：写 receipt → 发 → 结算
L5 faces/      ingress.ts（不变）、index.ts（接线）、reports.ts（oncall_report 工具）
```

`core/thread-owner.ts` 是唯一回答"这条消息归谁"的地方；`executor.ts` 不解析 thread key，`thread-key.ts` 仍是唯一构造点。

## 二之一、耦合控制（功能变多时靠这张表不互相踩）

### 1. 三条硬规则（可被守卫/评审机械执行）

1. **依赖只向内**：`faces/` → `runtime/` → `state/` → `core/` → `contract/`。反向零条；`core/` 里出现 `ctx`/`Date.now`/`await` 已由 `tests/layers.mjs` 判失败。
2. **一个事实一个写者**：每张表的写者在下表里唯一，两个模块不可写同一张表。
3. **跨模块只经两种缝**：**端口**（同步调用，带接口）或**表**（异步事实）。两个 runtime 模块之间不直接引用对方的导出函数。

### 2. 模块所有权

| 模块 | 它知道 | 它不知道 | 改它会波及 |
|---|---|---|---|
| `sources/*` | 某个外部系统的协议 | Case、执行器、账本 | 只有自己的测试与新 Source 实现 |
| `core/*` | 只读记录（纯函数） | ctx / 时钟 / 网络 / 表 | 只被自己单测与对应调用方用；改语义才需要看调用方 |
| `runtime/pass.ts` | Source + Ledger + `core/admission` | 会话、DSH 服务 | executor 无感；只写 `progress/cases/threads/audit` |
| `runtime/executor.ts` | 会话端口（sessionController/agents/persistence）+ Ledger + `core/stage|plan-step` | Source、GitHub、HTTP、provider/model | outbox 与 pass 无感；只写 `steps/audit` |
| `runtime/outbox.ts` | ReplySender（GitHub 评论）+ Ledger + `core/reply-plan` | 会话、Source 轮询 | executor 只依赖一个 `queue(reply)` 接口 |
| `faces/ingress.ts` | 调度（timeout 链） | 业务判断 | 只影响入口生命周期 |
| `faces/reports.ts` | 工具 schema + 会话归属校验 | 表结构 | 只影响模型可调面板 |
| `index.ts` | 装配（把上面接起来） | 业务规则 | 改装配不影响任何一层的内部 |

### 3. 端口清单（业务逻辑只认接口）

| 端口 | 谁实现 | 测试替身 |
|---|---|---|
| `Source` | `sources/github-issue.ts` | 已有假 source |
| `GithubFace`（read + `createComment`） | `sources/github-http.ts` | 已有假 face（`github-http.mjs`） |
| `Ledger` | `runtime/durable-ledger.ts` / `memoryLedger` | 内存实现（已有） |
| `TurnHost`（`resolveAgent/create/selectModel` + `followup` + `whenIdle` + `persistence`） | `index.ts` 传给 executor 的窄接口 | 假对象（单测）；真实组合套件 |
| `ReplySender` | `sources/github-reply.ts`（新增） | 假 sender 记调用次数 |
| `Clock` | `() => Date.now()`（仅 L4 注入） | 固定时钟 |

### 4. 新功能加在哪（不碰已有代码）

| 要加的东西 | 落点 | 不动的部分 |
|---|---|---|
| 新事件源（飞书/PR/CI） | 新 `sources/*.ts` + `index.ts` 注册一行 + config 一段 | `core/`、`executor`、`outbox` |
| 新交付面（PR 评论、IM） | 新 `ReplySender` + `core/reply-plan` 加一个 intent 分支（纯函数 + 单测） | `executor`、`pass` |
| 换执行后端 | 新 `TurnHost` 实现 | `core/`、`pass`、`outbox` |
| 新面板/任务线 | 读派生（`core/stage`）+ 投影；只读 | 任何表写者 |
| 新闸门规则 | `core/admission.ts` + `contract/policy.ts` | 其余全部 |

### 5. 禁止清单（比“应该”更好用）

- `core/` 里出现 `ctx` / 时钟 / `await` / 表名；
- `executor` 里出现 `provider` / `model` / `github` / `fetch`；
- `pass` 里出现会话或 `sessionController`；
- 浏览器半包写任何表；
- 第二个地方回答“这条消息归谁”或“这个 Case 下一步干什么”；
- 为同一件事新增第二个默认值（本轮的 `DEFAULT_RETRIES_PER_ROUTE` 就是例子）。

## 三、数据模型

同一个 `oncall_ingress` 域，**版本保持 1**（升版本会 `version-mismatch` 砸现场；`parse()` 对缺失表按空表处理，见 mapping 三节 6）。

| 表 | 键 | 值 | 写者 |
|---|---|---|---|
| `progress` | sourceId | cursor / lastError / lastPolledAt | pass |
| `cases` | caseId | `CaseRecord`（mandate/scope/origin/brief/openedAt/closed） | pass |
| `threads` | ThreadKey | `{ key, subscriptions: caseId[], lastAt }` | pass（开 Case 时订阅、人关 Case 时不删） |
| `inputs` | `caseId:trigger` | `{ caseId, trigger, text, at, deliveredAt \| null }` | pass（路由一条追问时写）、executor（投递后盖 `deliveredAt`） |
| `steps` | `caseId#seq` | `{ caseId, seq, state: 'running'|'ended', brief, report: {state,summary,at}|null, at, endedAt? }` | executor |
| `replies` | `caseId#seq` | `{ caseId, seq, intent: 'result'|'attention'|'failed', state: 'pending'|'sent'|'gone'|'failed', at }` | outbox |
| `audit` | uuid | 追加事实 | 三者 |

两条同形说明：

1. **`threads.subscriptions` 是权威的"谁收这条 thread 的消息"**，`mandate.scope` 只是授权范围（参考实现也是分开的：`Mandate.scope` 是字符串，`Thread.subscriptions` 是 Case 列表）。两者在开 Case 的同一次 commit 里写入，之后只有订阅会变。
2. **`steps` 就是 `Assignment`**：`state` 不是"这一轮在跑"而是"这次派工还活着"——回合结束写 `report`，派工仍在 `running`，直到 Case 关闭或重启替换。`pending` 不落地：因为 V0 的 follow-up 是**投进正在跑的会话**，不是排下一轮（见五、2）。

## 四、流程

### 1. pass（每 `pollSeconds`，一次 commit）

```
读 progress → poll → 去重（case:<trigger> 已存在则跳过）
每个 trigger:
  owner = core/thread-owner（查 threads.subscriptions，取最新一条订阅；stopped 的 Case 不算 owner）
  owner 存在且 mayWake（open 一律，ended 需人 + Mandate 重新校验通过）
      → 审计 case.followed-up{caseId, trigger}；交给 executor.deliver(caseId, text, triggerKey)
  否则（无主 / 停掉的 / 醒不来的）→ admit()（纯函数）
       record-only → 审计 case.observed
       work        → 开 Case（case:<trigger>）+ 订阅 threads.subscriptions += caseId + 审计 case.opened
commit(progress, cases, threads, audit)
```

`owner 存在` 时**不过闸门**（参考实现：订阅投递绕过闸门、不授予新权限）；人主动 `stopped` 的 Case 不恢复，保持安静。

**醒一个已结束的 Case 有两条前提，都是参考实现写死的规则**（`docs/001-domain.md:34,37`、`docs/002-authorization.md:127,131`）：

1. **只有人的消息能醒它**——机器人与 CI 的评论"不唤醒已结束的工单"：它们照常投给*活着的* Case（订阅不看发送者），但对已结束的 Case 视为"没归属任何 Case"，交给闸门（V0 里闸门就是评估层的确定性替身）。
2. **恢复前按当前 Policy 重新校验 Mandate**——把人从名单里移除之后，他不能靠一句评论把旧 Case 续上；校验不通过就当作没归属，旧 Case 保持结束。

### 2. executor（事件驱动 + 启动扫描）

```
启动扫描：每个 open case
  有 running step 且 report 已结算（waiting/ready/blocked/failed）→ 什么都不做（它在等 trigger）
  有 running step 但 report 为空 → 视作被打断：end 掉旧派工，开 seq+1，brief 带 RECOVERY_NOTE
  没有 running step → 开 seq+1（brief = 引用 scopes.briefOf(case)），起会话、投递、等 idle

起会话：resolveAgent('oncall-case-'+hash(caseId)) → 不存在才 create({sessionId, cwd}) → rename(标题=Case brief 首行)
投递：followup(freezeMessage({ id: MessageId('oncall:'+caseId+'#'+seq), content:[text], source:{kind:'oncall'} }))
     投递前按参考 delivery.holds() 判断：重放会话日志 + inbox，已存在则跳过
等结束：agent/status 的 idle 事件 → 后台任务 await whenIdle() → 读该回合的 turn/end.reason
结算：写 report（state 映射见下）→ 由 core 决定是否关 Case
follow-up 投递：该 case 有 running step 且会话活着 → 直接 followup（消息 id 含 triggerKey，重复即跳过）
```

`turn/end` ↔ report ↔ 回执（与 mapping 第五节一致）：

| `turn/end` | step.report | 回执 | Case |
|---|---|---|---|
| `completed` 且本回合调过 `oncall_report` | 报告值 | 按 purpose | 按报告 |
| `completed` 未调 | `waiting{summary=末条 assistant 文本}` | 不发 | 留开 |
| `error` + 层 A `exhausted` + 瞬态码 | **不写报告**（同一派工再投一句"从中断处继续"，≤3 次，15/30/60s） | 不发 | 留开；三次用尽才落 `failed{code}` 并回一条 |
| `error` 其它 | `failed{code}` | `failed`（我们的增强） | 留开 |
| `interrupted` | 不结算 | 不发 | 重启路径 |
| `max-tokens` | 不结算 | — | 既有续跑逻辑 |

### 3. `oncall_report`（worker 端唯一能改状态的入口）

参数照参考 `orchestrator_report` 收窄：`state ∈ {progress, ready, blocked, failed, dropped}`、`summary`、`question?`。行为：

- `ready` → Case 关 `completed`，回执 `result`；
- `dropped` → Case 关 `dropped`，回执 `result`；
- `blocked` + `question` → 留开，回执 `attention`；
- `failed` → 留开，回执 `failed`；
- `progress` → 只更新 summary，不回执。

工具全局注册，执行时按会话判：`ticketOfSession(agent.session.header)` 找不到就拒（照参考"只有 worker 会话能报"）。

### 4. outbox

同一次 commit 写 `replies{pending}` + 审计；发送 `POST /repos/{o}/{r}/issues/{n}/comments`；结算 `sent` / `gone`（404/410 不可再发）/ `failed`（重试上限后）。重启时 `pending` 重试、`sent` 跳过。正文末尾带 `<!-- oncall:caseId#seq -->` 仅供人读，不参与判重。

### 没有步数上限（2026-11-11 删除一条自造的保护）

上一版有 `MAX_STEPS_PER_CASE = 40`：第 40 个派工之后关成 `stopped`。**参考实现没有这个数**，它也不需要：

- worker 不能给自己开回合——回合只由一条输入触发；我们的输入来自 pass（人/@/CI）或重启扫描。
- 瞬态失败最多重试 3 次（`executor/dsh.ts:30,548-576`），后台工作 30 分钟封顶。
- `blocked`/`failed` 之后自动输入被扣住，直到有人说话（`core/model.ts:349` `waitsForPerson`）。

所以"一个 Case 无限滚"在这套状态机里不成立，那个 40 只会在第 40 次"卡住了/问人"时把 Case 关掉——第一个 bug 就是这么来的。已删：`contract/defaults.ts` 的常量、`plan-step.ts` 的 `Budget`/`budgetOf`/预算分支、executor 里两处预算判断。`stopped` 这个关闭原因保留（人停、重新校验失败），只是不再由计数产生。

## 五、三处与参考实现不同的地方（都写清代价）

1. **没有评估层**。参考实现的“新活还是补充”由主会话的模型用 `orchestrator_eval_decide` 判（`app/assessment.ts`，评估卡带 `relatedTickets`），而评估器就是**主会话本身**（`effects` 的 `assessment` 种类把卡送进主会话）。我们没有那个人在读的主会话，所以 V0 用确定性替代：**thread 有 owner 就投给 owner**，没有才过闸门开新 Case。代价：一张 issue 上两件独立的活不会自动分成两个 Case；补救是 V1 引入评估会话（表结构不用改）。
2. **Input 只保留最小一列**。参考实现把每条消息落成 `TicketInput`，带 `undelivered`、`readAt`、`deliveredTo`，并据此决定“哪些消息没读到、Case 结束时退回哪里”（`core/tickets.ts:231` 的 `addInput`、`:330` 的 `requeueUntaken`）。V0 取它的**幂等骨架**：一条消息一行（`caseId:trigger`），`deliveredAt` 为空即"欠着没投"，这挡住源回看 60 秒带来的重复路由与重复审计。**没有取**的是 `readAt` 与"Case 结束时把没读的消息退回评估"——V0 没有评估层可退，硬造一个只会让消息掉进没有消费者的队列。代价：跨重启的"这条追问读没读"仍然不知道；投递幂等靠消息 id，不是输入行。
3. **层 B 的判据换成“层 A 报 exhausted”，形状照抄参考实现**：不是"新派工"，而是**同一个派工**在退避后再收一句"从中断处继续"（`executor/dsh.ts:548-576`），最多 3 次、15/30/60s，正常收尾就清零（`:606`）。渠道自己给了 `providerRetryAfterMs`（三方网关 429 常带）时只把等待**拉长**、不缩短。用尽三次才落 `failed` 报告并回一条——先报"卡住了"再悄悄修好比两者都差。
4. **没有 comet 的 checkpoint**。恢复粒度是“重开一次派工 + recovery note”，不是“精确回到断点”。**注意这不是相对 superagent 的收窄**——superagent 的 `docs/003-execution.md`「Restart」也是同一做法（运行中的派工以“宿主重启过”结束，新派工带 recovery note），检查点只有 comet 有。长任务的恢复质量属 V1。

关于“失败也发一条评论”：**不是偏离哲学**。`docs/000-philosophy.md:16` 原文就是 “It writes again when a result is ready, when it needs a decision, or **when it cannot finish**”。它们的 `Replies` 把 `failed` 排在外，是因为读者就在主会话里（relay 已经说了）；我们的读者在 GitHub，所以同一个原则落在另一个面上。

## 六、开工前的四个运行时事实：已实测（2026-11-11）

不是推断，是跑出来的。隔离进程（独立 `DSH_HOME`、独立工作目录、真实 provider 一轮对话），
`node packages/dsh-oncall/tests/executor-probe.mjs` → **19 checks, 0 failed**。

| # | 事实 | 实测结果 |
|---|---|---|
| 1 | `agent/status` 在真回合里会发 `running → idle` | ✅ 实测序列 `running → idle`；同期 `turn/end.completed` |
| 2 | `MessageId('oncall:…')` + `freezeMessage` 接受自定义 id，且它进会话日志 | ✅ 无校验；持久化日志里能读到该 id |
| 3 | `resolveAgent` 对不存在 id 答 `session/not-found`；同 id 可创建；**新进程**能凭库恢复同一会话 | ✅ 三条全中；同进程二次 resolve 身份不变 |
| 4 | `sessionPersistence.flush/open/read` 在 `web` 组合可用 | ✅ 读出事件，包含我们投递的那条 |

其余观察：`create({sessionId, cwd})` 接受调用方给的 id；`selectModel` 接受 probed route；没有任何一条与设计冲突。

**复跑**：需要 `tests/probe-provider.local.json`（gitignored，`{baseURL, apiKey, model}`），会花一次极小的真实调用。它不进 `npm test`（花真钱），判据与配方记在 `tools.md`。

## 七、验证

| 层 | 套件 | 断言要点 |
|---|---|---|
| 分层 | `layers.mjs` | 新 core 文件无 I/O、只依赖 contract/core |
| 纯函数 | `pass.mjs` / 新增 core 用例 | thread-owner（live/ended/stopped/无订阅）、plan-step、reply-plan 的门禁 |
| 账本 | `ingress-loop.mjs` | 新表读写、缺少表按空表、域关闭后拒写、版本仍为 1 |
| 真实 Loader | 新增 `oncall-loop.mjs`（`--port 0`，独立 `DSH_HOME`） | 用本地假 GitHub（`ingress.baseUrl` 指向本机 http server）+ stub adapter 模型：@ 一次只开一个 Case、同 thread 追问进同一会话、重启后带 recovery note 续、渠道挂掉切路且 `oncall/failover-history` 有记录 |

## 八、现有代码的清理与改造（2026-11-11 审计）

依据：`grep` 全树查引用（`plan-step|deriveStage|CaseFacts|StepRecord|PresetId|DEFAULT_RETRIES_PER_ROUTE|MAX_STEPS_PER_CASE|progressOf|cases()`）。

| # | 现状（证据） | 处理 |
|---|---|---|
| 1 | `core/plan-step.ts`、`core/stage.ts` **只被 `tests/ingress.mjs` 引用**，生产代码一行未接（本来就没接线） | 把两者改成最终形状（`Assignment` 语义）并接进 executor；不删，它们就是 V0 的两个决策函数 |
| 2 | `contract/types.ts` 的 `Outcome`（`done/waiting/blocked/failed`）与参考的 `ReportState`（`progress/ready/blocked/failed/waiting/dropped`）不同名，翻译层会多一处 | 改用参考词汇：`report.state: 'ready'` 取代 `done`；加 `progress`/`dropped` |
| 3 | `StepRecord` 是 `{seq, step, startedAt, outcome}`，没有状态与输入 | 重写成 `Assignment` 形状：`{ caseId, seq, state: 'running'|'ended', brief, report, at }` |
| 4 | `Step` 联合里的 `ask` 分支、`preset` 字段、`PresetId` 全树无人使用（V0 不做 role preset） | 删（YAGNI）。将来接 preset 时按 `create({agentPreset})` 加回 |
| 5 | **两份“每路由重试”默认值**：`contract/defaults.ts:29` 的 `DEFAULT_RETRIES_PER_ROUTE = 1`（无人引用）与 `src/defaults.ts:33` 的 `DEFAULT_MAX_RETRIES = 5` | 删前者（单一来源，否则两处默认值互相矛盾） |
| 6 | `runtime/ledger.ts` 的 `Commit` 只有 `progress/cases/audit`，没有 thread | 加 `threads`；`MemoryLedger` 同步 |
| 7 | `runtime/durable-ledger.ts` 只有三张表；`toStoredAudit` 的 switch 穷尽枚举 | 加 `threads`/`steps`/`replies`（域版本保持 1）；新增三种审计事件，switch 会强迫补齐 |
| 8 | `runtime/pass.ts` 只做 `hasCase` 去重，没有归属与扇出 | 加 `core/thread-owner`（纯函数）+ follow-up 路由 |
| 9 | `sources/github-face.ts` 只有 listIssues/listComments，没有发评论 | 加 `createComment`（参数化路径拼接，与 list 同风格） |
| 10 | `config.ts` 的 `ingress` 缺 `baseUrl`（GitHub Enterprise / 测试）与 `workdir`（worker 在哪跑） | 加两个字段；**client 半包根本没有读 `ingress`**（grep 零命中），无 UI 改动 |
| 11 | `index.ts` 的 `installIngress` 只建 source+ledger+loop | 接线 executor / outbox / `oncall_report` |
| 12 | 旧形状被三套测试钉住：`ingress.mjs`（stage/planStep）、`pass.mjs`（fixture）、`ingress-loop.mjs`（表） | 第一批先改测试与实现同步，保持“改前改后套件全绿” |

**第一批（已做完，2026-11-11）**：第 2、3、4、5 项 + 对应测试。`npm test` 11 套全绿（`ingress` 26 → 29 checks），`npm run bundle` 通过，host `tsc` 干净；笔记 [2026-11-11-assignment-shaped-steps](../../.agents/notes/implemented/2026-11-11-assignment-shaped-steps.md)。下面 1、6–12 项是第二批（带行为）。

## 九、V0 不做

评估层 / PR 与 CI 线程 / handback / 并发上限 / 面板与任务线 / 多仓库 / 飞书 / 派工重试（`retryTicket`）。
