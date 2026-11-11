# Agent Note: V0 接通 executor 与回执——@ 一次就干、干完回评论、重启知道断在哪

Status: implemented

## Problem

入口能读 GitHub、判授权、开 Case、落库，然后**停在那儿**：`steps` 类型有了但没有任何人写，与参考实现的三处差距实测存在：

1. **没人干活。** `pass` 提交完 Case 就结束了，没有会话、没有投递。README 与 CHANGELOG 都写着「只建 Case，不执行」。
2. **同一句评论会开第二个 Case。** 幂等键是 trigger 级（`case:<trigger>`），issue 上第二条被 @ 的评论是一条新 trigger，于是第二个 Case、第二个 worker，两份工作在同一个分支上撞车。
3. **干完没法交付。** 没有 `oncall_report`，模型只能用正文说"我干完了"，插件要么猜、要么把每一次回合结束都当完成；`replies` 表也在设计里，没有任何东西写它。

## Decision

按 `docs/design/oncall-v0-architecture.md`（已定稿）落地，不重新设计。四条关键形状：

1. **归属用 `threads` 表，不用 `mandate.scope` 派生。** `pass` 在处理一条 trigger 时先问 `core/thread-owner`（纯函数）：thread 最新一条订阅的 Case 就是主人，`closed.reason === 'stopped'` 除外。有主人就审计 `case.followed-up` 并交给 executor；没有才走闸门。订阅投递**绕过闸门**——归谁不是一次新的授权。代价：V0 一张 issue 上两件独立的活不会自动分开（V1 评估层）。
2. **`steps` 就是 `Assignment`。** 回合结束只写 `report`，派工仍是 `running`；`ended` 只在 Case 关闭、重启顶掉上一刀、或层 B 换一次新派工时写。重启的判据是"running 且没有 report"，新派工带 `RECOVERY_NOTE`。
3. **回执是一个派工一条，`caseId#seq` 是幂等键。** 先写 `pending` 再发：`sent` 不再发，`gone`（404/410）不重试，传输失败按次数重试后记 `failed`，重启只补 `pending`。不扫 GitHub 判重（会撞上它自己的最终一致性）。
4. **层 B 只在层 A 报 `exhausted` 且是瞬态码时开火。** 判据从路由层自己的 `StepState.exhausted` + 链的 `switchOn`/`immediateSwitch` 读（`TurnHost.exhausted`），不另立一张码表；退避优先 `turn/end.error.providerRetryAfterMs`，否则 30/60 秒，最多两次。层 B 接手时**不发**"卡住了"——先报坏消息再悄悄修好，比两者都差。

## Alternatives considered

- **`executor` 里放 `selectModel` 并让它选 worker 的路由**：设计文档的端口清单里有这个名字，但 executor 一旦拿到 provider/model 就等于把渠道知识搬进生命周期，而禁令（`executor` 不出现 `provider`/`model`）正是这轮要立的结构线。worker 走会话默认模型、失败由路由层管，端口里就不需要它。
- **follow-up 的消息 id 带 seq（`oncall:<case>#<seq>:<trigger>`）**：实现过，`oncall-loop.mjs` 的 phase 2 抓到了后果——源回看 60 秒，重启后重读同一句评论；带 seq 的 id 换了一条新 seq，于是"这不是旧的"，已关闭的 Case 被重新打开、worker 被同一句评论再叫一次。改成 `oncall:<case>:<trigger>`（不含 seq）后，跨关闭也能认出"这句已经投过"。
- **把工具的报告攒到回合结束再写**：worker 说 `ready` 之后还要等它把这一轮说完，评论才出去；而且回合里的 `progress` 会覆盖掉 `ready`。改成工具立即落报告（`ready`/`dropped` 立即关 Case、回执立即排队），回合结束时只在没有更新的话时才补 `waiting`/`failed`。
- **层 B 复用同一步（只再投一次）**：那会让"一个 step 最多多少真实调用"这个由路由层拥有的账被 executor 重开；新派工是参考实现的形状，也是唯一边界清楚的做法。
- **`pass` 在 commit 前把新 Case 交给 executor**：实现过，executor 读账本读不到这个 Case（`caseOf` 返回 `undefined`），Case 就没人干。投递必须在 commit 之后。

## Consequences

- 行为：worker 会话就是普通路由会话——`oncall-loop` 让 stub 的首跳永远失败，备用候选答上了，durable log 里两条 `request/header`（第二条 `reason: 'change'`）就是 `oncall/failover-history` 折叠的那份事实。`@` 一次只开一个 Case 并真的开始干；追问进同一会话、不再开 Case；`ready` 关 Case 并回一条带 marker 的评论；`blocked` 问一个问题；`failed` 回"卡住了"（层 B 接手时不回）；进程重启后旧派工被顶掉、新派工带 recovery note、会话还是那一个。
- 已知代价：60 秒重叠窗口内，同一句追问会在每一轮 `pass` 里被"路由一次"并各写一条 `case.followed-up` 审计（投递本身幂等，消息 id 挡住重复）。参考实现用 intake 的输入账本消掉这份噪音，V0 没有输入表。
- 账本：`threads`/`steps`/`replies` 三张新表加在域版本 **1** 上（`parse()` 对缺表按空表处理，实测 `dsh-storage-json` 的 `parse` 逐表缺省即空）；`DurableLedger` 的写入口收成命名操作（`writeSteps`/`writeReply`/`closeCase`/`reopenCase`），"executor 不会开 Case"因此是类型事实。
- 测试：新增 `tests/executor.mjs`（25 checks，假 TurnHost + 内存账本，覆盖恢复、不结算、层 B、回执计划与 outbox）与 `tests/oncall-loop.mjs`（38 checks，真实 `web` profile + `--port 0` + 独立 `DSH_HOME` + 本地假 GitHub + stub adapter 两个进程）。`npm test` 13 套全绿；`executor-probe.mjs` 复跑 19 checks 0 失败（四条运行时事实未被这轮破坏）。
- 一个测试基础设施事实写进了 `tools.md`：`@deepseek-ai/dsh-client-modules` 是进程级注册表，同一个包里两个 file-path 插件条目会在**第二次** boot 时被判"同一包来自两个来源"，所以"重启"必须起第二个进程；而 `boot()` 返回的根 context 只有 `ctx.fiber.dispose()`，`ctx.dispose()` 不存在——不 await 它，进程内的入口会继续轮询并按内存副本整篇重写存储文件，把测试的 fixture 编辑悄悄覆盖掉。
- 设计位置：`docs/design/oncall-v0-architecture.md` 三/四/五节；边界与禁令见其二之一节。
