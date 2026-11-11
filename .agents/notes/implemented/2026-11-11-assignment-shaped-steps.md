# Agent Note: 入口的 step 形状改成参考实现的 `Assignment`，删掉重复的重试默认值

Status: implemented

## Problem

`core/plan-step.ts`、`core/stage.ts`、以及 `contract/types.ts` 里那组 `Outcome/StepRecord/Step` 是"先设计后接线"留下的形状，三处都不对：

1. **词汇对不上。** 我们写 `done/waiting/blocked/failed`，参考实现（`dsh-superagent` 的 `ReportState`）是 `progress/ready/blocked/failed/waiting/dropped`。两边各一套词，意味着 `oncall_report`、状态派生、回执门禁之间要多一层翻译，而翻译层是漂移的入口。
2. **`StepRecord` 少了状态与输入。** 它只有 `{seq, step, startedAt, outcome}`。参考实现的 `Assignment` 是 `state: pending→running→ended` + `report{state,summary,at}` + `deliveredAt/idleAt`。少了 `state` 就分不出"派工还活着"和"这一轮在跑"——而这两件事在参考实现里是不同的生命周期（回合结束只写 report，派工仍是 running）。
3. **两份"每路由重试"默认值。** `contract/defaults.ts` 的 `DEFAULT_RETRIES_PER_ROUTE = 1` 全树无人引用，`src/defaults.ts` 的 `DEFAULT_MAX_RETRIES = 5` 才是路由器在用的。两个默认值互相矛盾，下一个人改错一个就是行为不一致。

## Decision

1. 采用参考实现的词汇：`ReportState` + `Report`（`blocked` 带 `question`、`failed` 带 `code`），`StepRecord` 改成 `Assignment` 的压缩版（`caseId/seq/state/brief/report/at`），`Step` 变成 `work | close | idle`（`ask` 与 `preset` 删掉，V0 不做 role preset）。
2. `deriveStage` 从"一堆并行的派生输入"改成读 `steps` 数组：一行一个事实来源，`since` 永远来自触发那个分支的记录。
3. 终局报告先于"running"判断：`ready`/`dropped` 在派工还跑着的时候就把 Case 收掉——参考实现的 `report()` 里 `tickets.end()` 就是这么做的。
4. 删掉 `DEFAULT_RETRIES_PER_ROUTE`。

## Alternatives considered

- **保留 `done` 这个词、在边界翻译成 `ready`**：能少改几个文件，但翻译层正是两边词汇分叉的根源；而且 `oncall_report` 是模型直接读的工具描述，词越少越不容易写错。
- **`planStep` 在"有 running step"时返回 `work`**：那会让同一个 Case 起第二个 worker。返回 `idle` 是唯一诚实的答案。
- **把预算检查放在 running 之前**：那会在派工正跑着的时候把它判死。预算的目的是拦住"一轮轮空转"，所以它只能落在两轮之间。

## Consequences

- 行为没有变化：`plan-step`/`stage` 本来就没有接进生产路径（只有 `tests/ingress.mjs` 引用），这次是把形状对齐到即将使用的 executor。
- `tests/ingress.mjs` 的派生/计划两节按新形状重写，并补了 `dropped`、`ended 派工`、`progress` 三个用例（26 → 29 checks）。
- 验证：`npm test` 11 套全绿（layers 守卫 / ingress 29 / github-issue 16 / pass 13 / github-http 10 / ingress-loop 11 / unit 259 / client-controller 129 / remote 25 / handoff-relay 0 失败 / run 37 场景 0 失败），`npm run bundle` 通过，host `tsc` 干净。
- 设计位置：`docs/design/oncall-v0-architecture.md` 第八节（清理清单）与第三节（数据模型）。
