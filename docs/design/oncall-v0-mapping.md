---
title: "DSH On-call — V0 设计核对：照抄参考实现，只加两类增强"
status: "researched"
kind: "code-mapping"
last_updated: "2026-11-11"
---

# V0 设计核对

**设计现状看 [`oncall-v0-architecture.md`](oncall-v0-architecture.md)；本文只保留逐条核对记录。**

前提：架构照 superagent / comet，**不重新设计**。凡参考实现已经写清的，抄形状、抄语义、抄判据；我们在它之上只加两类增强（跨渠道失败切换、外部入口），并写清哪些参数必须按我们的渠道现实改。

这篇里的每一句都标了 `file:line`。**没有引用的一律是待核实**，不当结论用。

## 一、结论

1. V0 的每块在两处都能找到现成实现：入口 pass（superagent `passes.ts`）、工作单元（`Assignment` + comet `run-state`）、执行会话（`sessions.ts` + `executor/dsh.ts`）、投递幂等（`delivery.ts`）、对外回执（`replies.ts` + `outbox.ts`）、状态派生（`core/stage.ts`）、机器态不可写（comet）。
2. 我们只加两件事：**层 A** 跨渠道切换（他们单渠道，没有这一层）和 **入口**（他们为独立部署做的 Source 体系，我们只要 GitHub issue 一条）。**层 A 是包含关系不是对立**：一条候选、默认重试的配置下，它退化成 DSH 原生行为（先自己重试、不行才动），官方渠道用户不需要改任何配置。
3. 之前我"凭印象定方案"错了六处，全部在第三节列清；其中影响实现的是三条：等结束的接缝、`done` 的来源、重启的判据。

## 二、逐组件对照

| V0 组件 | 参考实现（抄什么） | 我们的增强（加什么） |
|---|---|---|
| 入口循环 | `src/app/passes.ts:28` 定时、`:64` 只 `effects.kick()` + `evaluateDue()`；pass 不干活 | 已实现，且用 timeout 链而非 interval（不叠跑） |
| 工作单元 | `Assignment`：`state: pending→running→ended`（`core/model.ts:36`）、`report{state,summary,at}` / `deliveredAt` / `idleAt`（`:104-115`）；comet 的 `run-state` 存 `current_step` / `iteration`（`classic-store.ts:123-129`） | `steps` 表按此压缩（见第四节 1） |
| 谁判结束 | **引擎判**：`assignments.report()` 里 `ready` → 以 `completed` 结束工单，`dropped` → 以 `dropped` 结束（`core/assignments.ts:132`）；executor 只报事实 | 我们照抄：executor 只写 step，关 Case 由 core 决定 |
| 执行会话 | `src/executor/dsh.ts:24` 的 `workerSessionId = 'worker-' + ticketId`（纯函数）；`src/app/sessions.ts:138-153` 的 `ensure()`：`resolveAgent` → 没有才 `create({ sessionId, workspaceId, agentPreset })`（`:144`）→ 再 `resolveAgent` → `rename`（`:153`） | 会话 id `oncall-case-<id>`；不设 `danger-full-access`（`sessions.ts:152` 那条我们不要，见第五节） |
| 等回合结束 | `dsh.ts:479-486`：订阅 `agent/status`，`status === 'idle'` 时**在后台任务里**跑 `workerIdle`，里面 `await agent.whenIdle()`（`:602`） | 无（照抄） |
| 投递幂等 | `delivery.ts:16` `messageId = MessageId('dsh-superagent:' + requestId)`；`:40` 从 `sessionPersistence.open(id,'read')` 重放已投递 id；`:61` `holds()` 并上 `inbox.nextTurn/nextStep`（`:74`）；`:81` `followup` 后 `flush` | 无（照抄；我们的 request id = `caseId#seq`） |
| 对外回执 | `core/replies.ts:13-18` 四种 purpose；`:79` id = `key('reply', trigger|ticket, text)`（`core/ids.ts:3` 是 sha256 前 32 位）；`app/outbox.ts:31` 同事务写 receipt + enqueue；`:24` 退避 5s→300s；`:46/:50` 结算 `channelIgnored`/`channelGone`/`sent` | 渠道只有 GitHub 一种，退避与顺序留形状、参数后置（第四节 4） |
| 状态派生 | `core/stage.ts`（26 行纯函数）+ `docs/003-execution.md`「Ticket stages」七行表 | 已实现（`core/stage.ts` 同构） |
| 机器态不可写 | comet `classic-state-command.ts:604-605`：`'<field>' is a machine-owned field and cannot be set directly`；`state-events.jsonl` 是追加审计、不是第二份可编辑状态（`ARCHITECTURE.md:130`） | 账本只由插件写；浏览器只读 |
| 失败处理层 B | `dsh.ts:30` 瞬时 3 次 15/30/60s；`docs/003`「Failure and recovery」；`assignments.interrupted()` 用 `RECOVERY_NOTE` 重启 | 判据改成"层 A 报 exhausted 才开火"，见第四节 5 |
| 报告工具 | `app/tools/executor.ts:75` 的 `orchestrator_report`：`state ∈ {progress, ready, blocked, failed, dropped}` + `summary` + `human_action` + `question_for_trigger_id` + `reply_to_trigger_id`，闭包里绑死 ticketId。注意 **`waiting` 不在模型可报的枚举里**——它只由 executor 在回合结束时写（`dsh.ts:665`） | V0 一个同形的最小 `oncall_report`：`state ∈ {progress, ready, blocked, failed, dropped}` + `summary` + `question`，否则"完成"只能从自由文本猜 |
| 会话获取顺序 | `sessions.ts:140-146`：先 `resolveAgent`（`dsh-api-session-controller/lib/index.js:221-236` 对不活的会话**走 resume，从持久化加载**），只有 `session/not-found` 才 `create` | 照抄。我们的 `create({sessionId, cwd})` 合法：`lib/index.js:756` 只禁止 `workspaceId`+`cwd` 同时出现，`:766` 接受调用方给的 `sessionId` |

## 三、我此前猜错、被源码否掉的六处

| # | 我之前的说法 | 源码事实 |
|---|---|---|
| 1 | 等结束挂 `session/event` 听 `turn/end`、自设回合超时 | 接缝是 `agent/status` 的 `idle`（`dsh.ts:479-486`），`whenIdle()` 在后台任务里确认；回合无超时，只有准备 10min（`:28`）与后台 30min（`docs/003`） |
| 2 | 回执幂等一张表就够 | 分两层：会话投递的幂等在会话日志里（`delivery.ts:40,61`），对外发出的幂等在 receipt（`outbox.ts:31`） |
| 3 | 回合正常结束 = `done`，summary 取末条 assistant 文本 | **错**：没有 report 工具调用时，回合结束他们报的是 `waiting`（`dsh.ts:659,665`：`engine.report(..., {state:'waiting', summary: said})`）；`done(ready)` 只来自 `orchestrator_report`（`app/tools/executor.ts:75`） |
| 4 | 已关闭 Case 收到追问"只记审计、不重开" | `docs/001-domain.md:37`：ended Ticket 保留订阅，人的消息以同一 Mandate 恢复它 |
| 5 | 两层重试重复，不该抄 | 主体不同：层 A 是"一次请求"，层 B 是"一次回合收尾"；`turn/end.error` 里带的就是 `LlmFailure` 原文（`dsh-session/lib/types/types.d.ts:183-186`、`dsh-llm/lib/types/types.d.ts:26-36`），两张表共用一套码 |
| 6 | 加表要升 domain 版本 | **升版本会砸掉现场**：`single` 布局下版本不等直接 `version-mismatch`（`node_modules/@deepseek-ai/dsh-storage-json/lib/index.js:102`）；而 `parse()` 对"文档里没有这张表"按空表处理（同文件 `:115-121`）。所以加表**保持 version 1**，不迁移 |

## 四、必须精确对齐的六个细节

**1. `steps` 的形状 = `Assignment` 的压缩版，不是新发明。**
`caseId`、`seq`、`state(running|ended)`、`brief`、`report{state,summary,at}|null`、`at`、`endedAt?`；key `caseId#seq`。回合结束只写 `report`（派工仍 `running`），`ended` 只在 Case 关闭、重启顶掉上一刀、层 B 换新派工时写——与 `Assignment` 的 `running → ended` 独立于 Ticket 是同一条规则（`docs/001-domain.md:36`）。丢掉的 `pending` 是因为 V0 的 follow-up 直接投进活会话，不排队。
（2026-11-11 更新：本文早前写的四列版 `outcome` 已被实现取代；现状见 `oncall-v0-architecture.md` §三。）

**2. 投递的幂等键是消息 id，不是行锁。**
`followup(freezeMessage({ id: MessageId('oncall:'+caseId+'#'+seq), … }))`；投递前用 `holds()` 同款判断（重放会话日志 + 看 `inbox.nextTurn/nextStep`）。这样"崩溃在投递与写表之间"不会重复投递。

**3. 重启的判据来自 DSH，不是自己猜。**
`turn/end{kind:'interrupted'}` 由 agent-loop resume 追加（`dsh-session/lib/types/types.d.ts:197-206`）。我们的规则照 `assignments.interrupted()`：**未结算的 step → 开 `seq+1` 带 `RECOVERY_NOTE`**；已结算 → 不动。`RECOVERY_NOTE` 原文取自 `core/assignments.ts:21`（先看 worktree / git / GitHub，不重复已完成的外部动作）。

**4. 回执按用途，不按 step。**
`core/replies.ts` 的允许规则是硬的（不是建议）：`result` 只在工单 `ready`/`completed`/`merged`/`dropped` 时允许；`attention` 必须匹配当前未关闭的问题；`answer` 必须回答一个人的问题。`app/notices.ts:127`：`progress` 且不带回答时不转送。所以映射是：`ready` → result；`blocked`（带问题） → attention；`progress` → 不发。
**唯一一处有意偏离**：他们的 `failed` **不发渠道消息**（不在 `result` 的允许集里，`core/replies.ts`），只在中控台与主 Session 的 relay 里可见。我们的主 Session 没有人读，读者在 GitHub —— 所以 V0 在**终局失败**时发一条 comment（`## 卡住了` + 原因 + 需要人做什么）。理由写在决策笔记里，不是默认行为变更。

**5. 两层失败处理的分工（我们的增强点）。**
层 A（已有）：一次模型请求内，判 `LlmFailure.code` × `switchOn` × 立即切换白名单，账本是每候选 `maxRetries`。
层 B（抄形状）：**只在层 A 报 `exhausted` 时开火**，退避用 `turn/end.error.providerRetryAfterMs` 优先（三方网关的 429 常带这个，`dsh-llm/lib/types/types.d.ts:34`），否则 30/60s，≤2 次，每次都是**新 step**。这样"一个 step 最多多少真实调用"仍只由层 A 决定，两笔账分开，不违背"不与 provider 重试、跨渠道 failover 混成一个次数"。

**6. `thread` 用哪张表：最终建了 `threads`（本条早前的"不建表"已被裁定取代）。**
早前的论据是"一个 Case 只覆盖一个 thread，扫 `mandate.scope` 就够"；`open-questions §14.2` 第 1 条最终按参考实现的形状定案——**订阅存在 Thread 上**（`subscriptions: caseId[]`），`mandate.scope` 只是授权范围。两个事实源的风险用"同一次 commit 写入 + 只有 pass 写订阅"消掉，不再靠派生。现状见 `oncall-v0-architecture.md` §三。

## 五、V0 落定的形状

```
threads(key=ThreadKey)    { key, subscriptions: caseId[], lastAt }
inputs (key=caseId:trigger) { caseId, trigger, text, at, deliveredAt|null }
steps  (key=caseId#seq)   { caseId, seq, state, brief, report|null, at, endedAt? }
replies(key=caseId#seq)   { caseId, seq, intent, text, state, at }
audit（追加）              case.opened / case.observed / case.followed-up /
                          step.settled / step.interrupted / reply.settled /
                          trigger.refused / poll.failed
```
（2026-11-11 更新：上表是实施后的形状；本文早前的三行版少了 `threads`/`inputs`/`state`。）

| 事件 | step outcome | 回执 | 下一步 |
|---|---|---|---|
| `oncall_report{state:'ready'}` | `done{summary}` | result | 引擎关 Case `completed` |
| `oncall_report{state:'blocked'}`（带 `question`） | `blocked{question}` | attention | Case 留开 |
| `oncall_report{state:'progress'}` | 不结算（只更新 summary） | 不发 | 继续 |
| `oncall_report{state:'dropped'}` | `done{summary}` + 关闭原因 `dropped` | result | 关 Case `dropped` |
| `oncall_report{state:'failed'}` | `failed{code}` | **V0 偏离：发一条失败 comment** | Case 留开 |
| `turn/end{completed}` 且无 report | `waiting{summary=末条文本}` | 不发 | Case 留开（等人 / 等触发） |
| `turn/end{error}` + 层 A `exhausted` + 瞬态码 | `failed{code}` | 不发 | 新 step，退避 30/60s，≤2 |
| `turn/end{error}` 其它 | `failed{code}` | 发失败 comment | Case 留开 |
| `turn/end{interrupted}` | `failed{code:'INTERRUPTED'}` | 不发 | 新 step + `RECOVERY_NOTE` |
| `turn/end{max-tokens}` | 不结算 | — | 插件既有的续跑逻辑 |

不变量：状态派生不落库；机器态只有插件写；一次投递一个消息 id；一次外发一条 receipt；Case 不感知渠道（executor 不出现 provider/model）。

## 六、两处已裁定（原"仍需裁定"）

1. **thread 单值 / 要不要建表**：已裁定——**建 `threads` 表，存 `subscriptions`**（`open-questions §14.2` 第 1 条）。V0 的策略仍是"一个 thread 最多一个活 Case"，但那是策略不是表结构；接评估层时只改策略。与 `docs/001-domain.md`「Rejected concepts」的差异因此收窄成"策略更保守"，不再是模型差异。
2. **终局失败要不要发 GitHub comment**：已裁定——**发**（`open-questions §14.2` 第 8 条）。理由：我们的读者在 GitHub，不在 DSH 主会话；参考实现把 `failed` 排在 `result` 门禁外，是因为它的 relay 已经说了。

`oncall_report` 不再列为待裁定项：它是 superagent 已有的设计（`app/tools/executor.ts:75`），不加就只能从自由文本猜状态，而那正是他们明确拒绝的做法（`docs/001-domain.md:60`）。

## 七、引用清单

superagent（`D:\sudy\github\dsh-superagent-prototype`）：`src/app/passes.ts:28,64`；`src/app/effects.ts:30,62,83`；`src/app/outbox.ts:24,31,46,50`；`src/app/delivery.ts:16,40,61,74,81`；`src/app/sessions.ts:138-153,289`；`src/executor/dsh.ts:24,26,28,30,479-486,602,659,665`；`src/core/model.ts:36,75-85,104-115`；`src/core/assignments.ts:21,132`；`src/core/engine.ts`（`turnEnded`/`assignmentInterrupted`/`report`）；`src/core/replies.ts:13-18,79`；`src/core/ids.ts:3`；`src/app/tools/executor.ts:75`；`docs/001-domain.md:36,37,41,55,60,64`；`docs/003-execution.md`（stages / failure / restart / stored work）。

comet（`D:\sudy\github\comet`）：`domains/comet-classic/classic-state.ts`（phase 枚举与字段）；`classic-transitions.ts`（转移表 + `guardRefs` + 非法 phase 抛错 + `effects[]`）；`classic-store.ts:123-129`（`run_id`/`skill_hash`/`current_step`/`iteration`）；`classic-state-events.ts:7-18`（`event/from/to/effects`）；`classic-state-command.ts:604-605`（machine-owned 拒绝写）；`docs/architecture/ARCHITECTURE.md:128,130,147`。

DSH rc.3（本项目 `node_modules/@deepseek-ai/`）：`dsh-api-session-controller/lib/types/types.d.ts:284-293`；`.../index.d.ts:72,101,156`；`dsh-agent/lib/types/runtime-types.d.ts:164,192,200,209,219,252`；`dsh-agent-loop/lib/types/inbox.d.ts:44,46`；`dsh-session-persistence/lib/types/index.d.ts:126` 与 `handle.d.ts:75`；`dsh-session/lib/types/types.d.ts:167-206`（`TurnEndReasonMap`，`:183-186` error 带 `LlmFailure`，`:197` interrupted）；`dsh-llm/lib/types/types.d.ts:26-36,34`；`dsh-llm/lib/types/message.d.ts:190`；`dsh-tools/lib/types/index.d.ts:645,656`；`dsh-storage-json/lib/index.js:102,115-121`。

## 八、参考实现对我们未决项与收窄项的现成答案（2026-11-11 实施后补）

`open-questions.md` 登记的问题、以及架构文档里"有意收窄"的条目，逐条对到 `dsh-superagent` 的文档上。**没有一条是无人回答的**——区别只是我们要不要现在付代价。

| 我们的项（出处） | 参考实现的答案 | 现在 |
|---|---|---|
| 没有评估层：同 thread 两件独立的活不分开（架构 §五 1） | `docs/001-domain.md`「Eval」；`docs/002-authorization.md:9-17` 两道闸；`docs/007-architecture.md:209` `MasterAssessor`、`:145` `assessmentOutcome`（每条启用规则一个判断、方向 settled、必须匹配规则与意图证据；非 auto 的推断接受只记 "would accept"） | V1 照抄。评估器就是主会话本身，我们没有那个人读的主会话——**唯一**"前提不同"的收窄 |
| Input 只保留最小一列：不知道"读没读"、Case 结束不退回未读（架构 §五 2） | `docs/002-authorization.md:28-39`「Handing back and releasing follow-ups」；`core/tickets.ts:330` `requeueUntaken`、`:300` `letGo`；`docs/007-architecture.md:85` 定义"读"（进入 history 且随后有报告或回合结束） | 幂等骨架已抄（`inputs` + `deliveredAt`）；`readAt` 与退回随评估层一起补 |
| 没有 comet 式检查点（架构 §五 4） | **superagent 也没有**：`docs/003-execution.md:144`「Restart」与我们同法（重开派工 + recovery note） | 不是对 superagent 的偏离（已改正架构文档措辞） |
| 层 B | `docs/003-execution.md:120-134`、`executor/dsh.ts:26,548-576,606`：**同一个派工**再收一句"从中断处继续"，≤3 次、15/30/60s，正常收尾清零；不是新派工 | 判据用我们的（层 A 报 exhausted），**形状已照抄**（同一派工 + retry 消息）；渠道给的 `retryAfterMs` 只把等待拉长 |
| 同 thread 最多一个活 Case（架构 §五 1） | `docs/001-domain.md`「Rejected concepts」明确拒绝这条限制，由评估层去重 | 接评估层时拆掉 |
| 并发上限（架构 §九） | `docs/003-execution.md:55`「Concurrency」：每工单一个槽，人的消息/状态请求额外一槽 | V1 照抄（含"人不会被新活挤掉"） |
| handback（架构 §九） | `docs/002-authorization.md:28`、`docs/003-execution.md:108-116`：超出范围交还评估，每条只交还一次 | V1（依赖评估层） |
| PR / CI 回到同一 Case（架构 §九） | `docs/003-execution.md:96-107`「Pull requests」：工单跟随自己开的 PR，PR 全关才算完 | V3 照抄 |
| 派工重试（架构 §九） | `docs/003-execution.md:135-143`「Retry」：新派工，同会话/目录/分支/PR，带走等待的 Input | V1 照抄 |
| 面板与任务线（架构 §九） | `docs/005-panel.md`：三个问题、六个页签、七条原则（"会给人的数字才显示""一个概念一个地方""诚实的计数 = 列表长度"） | V5 照抄结构与原则 |
| 多仓库 / 飞书（架构 §九） | `docs/006-deployment.md`；`docs/007-architecture.md:183` Sources = 一种实现 + 一个实例配置 | V4 |

### `open-questions.md` 里问过的问题

| 问题（出处） | 参考实现的答案 | 结论 |
|---|---|---|
| §11 #5 是否显示 Token | `docs/005-panel.md` 原则 1："a number appears only when it changes what the supervisor does" | 保留"显示、缺失隐藏"，只留会改变人下一步动作的数字 |
| §11 #7 "异常"怎么措辞 | `docs/005-panel.md` 原则 2："A label says whom a row waits for and what it needs, not an internal status code"；阶段名是 `person / answer` 这种 | 改成阶段式措辞时照这条 |
| §11 #6 要不要 Nudge / 停止 | `docs/003-execution.md:135` Retry、`docs/002-authorization.md:125` stop、`docs/005-panel.md`"Ticket details show actions" | 两个动作可抄：Retry 与 stop，V1 |
| §11 #2/#3/#4/#8（标签名、投影条数、配色、切会话回全局） | 无对应：他们的面板是整页，没有"右栏按会话加载"这个形态 | 确实是我们自己的决定 |
| §12 #1 何时迁移 `agent/request` | `docs/003-execution.md:143`："The Executor model applies only when a Session is created; an existing Session keeps its model"；`docs/007-architecture.md:335` `role-models.ts` | 他们**从不**拦请求：模型按角色在创建会话时定，整段会话不变 |
| §12 #2 迁到 step 边界后"逐候选预算"怎么定义 | 同上 + `docs/003-execution.md:120-134` 的按回合瞬态重试 | 逐候选预算随那个缝一起消失；剩下"角色模型 + 按回合瞬态重试"，没有第三个数字 |
