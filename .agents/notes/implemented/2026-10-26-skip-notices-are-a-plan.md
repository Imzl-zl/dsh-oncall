# Agent Note: 跳过通知的裁决抽成纯函数，才有一张能红的网

Status: implemented

## Problem

`feature-review-2026-10-26.md` 的 4.12 记的是条件跳过用"整组拼串"当去重键：一轮里跳过集合变大（第二步多一条候选被跳过）时，整组键也跟着变，于是**已经说过的路由被再说一遍**。这些 notice 是 durable 的 `user/message`，进模型上下文，重报就是重复计 token。

四条 Important 修法里唯独它没有自动网：组合 harness 一次 boot 只有一个 step，"同一步跳过 {A}、下一步跳过 {A, C}"这个触发面在真实组合里到不了。修法本身（键改逐路由）落地了，但靠的是"与 `capability:`/`breaker:` 同形"的形状一致与代码审读。

## Decision

把"这一击该报哪几条"从 `index.ts` 的 listener 里搬进 `src/skip-plan.ts` 的 `planSkipNotices()`：输入是三类跳过、落回裁决、`resolved` 与"本轮已报键集合"，输出是**纯数据的通知计划**（`notices` + 本次消耗的 `keys`）。消息文案仍归 `./notice.ts`，append 仍归 `index.ts`——裁决与解释器分开，与 `router.ts` 的裁决表 + `index.ts` 解释器的既有分工一致。宿主侧账本收成一处（`RouterState.turnNoticeKeys` / `recordTurnNoticeKeys`），原来 `shouldNoteSkip` 的"判一次"变成"读一次 + 记一批"，绑定链被删的那条通知也走同一本账。

准入门槛（可机械判定）：

1. **键只有一处产生**：全仓 `shouldNoteSkip` 不再出现，三类跳过键（`condition:`/`capability:`/`breaker:` + 路由）只在 `skip-plan.ts` 拼。通过的样子：`grep -rc shouldNoteSkip packages/dsh-model-desk/src` 全 0；不通过：listener 里还留一处手拼。
2. **集合变大只报新增**：对同一 turn 连调两次（第二次 `alreadyNoted` = 第一次的 `keys`），第二次的 `notices` 只含新加入的路由。通过的样子：单测 `a skip set that grows mid-turn announces only the candidate that joined it` 绿；不通过：把键改回整组拼串，该用例必须红（已抽样，三条断言同时红）。
3. **裁决是纯的**：`alreadyNoted` 不被改写（`ledger.size` 断言），`notices`/`keys` 是返回值而不是副作用。

## Alternatives considered

1. 给 `tests/stub-adapter.mjs` 加 tool-call outcome，让一轮真的多 step
   - 最强的理由：唯一能在真实 Loader 组合里证明"同一个 turn 的两次决策"的东西，顺带把 stub 的表达力从"成功/失败/截断"扩到工具调用，以后跨 step 的语义（预算跨轮、绑定改写）都能用。
   - 为何被否：**触发面本身在组合里造不出来**。条件只有"带图/无图"这类互斥判据，第二步只会换一条被跳过的路由（集合是 {A} → {B}，不是 {A} → {A, B}），要让集合单调变大就得再发明一条"随上下文增长而失效"的条件——那是为测试新造一套触发机制，而不是观测生产形态。加上 tool-call 的 wire 形状（`block-start` 的 `blockType` 与 tool-call delta）要重核，成本落在最不确定的地方。
2. 保留 `shouldNoteSkip`，只把三条键的拼串抽成一个小函数
   - 最强的理由：改动最小，三行搬个位置，现有单测一行不动。
   - 为何被否：4.12 的修法**就是**键的语义。把拼串抽走但留在 listener 的循环里，测的仍然是"给了同一个键会去重"，测不到"集合变大时键会不会变"——而那正是错的那一半。
3. 整个 `agent/request` 分支都做成纯函数（任务书字面要求）
   - 最强的理由：一次把整段控制流变成可测数据，覆盖裁决、跳过、落点全部。
   - 为何被否：分支里每一步都夹着 `await ctx.llm.resolveCallConfig()`（外部能力校验，有真实 I/O）与 `append`（durable 写）。要纯化就得先发明"能力裁决注入"的抽象层，等于为测试重写生产控制流；而能力预检的三档已经有自己的单测（`precheck.ts`）。

## Consequences

- 收益：4.12 有一张会红的网；三类跳过键收进一处（原先 listener 里手拼三次）；4.13 的"落回第一跳不报"从注释变成断言；`conditionSkipKey` 这类"键是什么形状"的知识不再散在调用点。
- 代价：`index.ts` 多一个模块依赖，每 fire 多一次 plan 对象分配（可忽略但不为零）；state 的账本 API 从"判一次"变成"读一次 + 记一批"，调用方必须记得记（不记就重复报）——今天只有两处调用，另一处是绑定通知；`unit.mjs` 里原来那条直接打 `shouldNoteSkip` 的用例改写为对账本 API 的用例，覆盖面没丢（账本语义 + 计划语义各一条）。
