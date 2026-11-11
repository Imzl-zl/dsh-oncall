# Agent Note: 产品路线定为 on-call，入口进 V0，merge.md 的「只做底座」作废

Status: implemented

## Problem

两份 `proposed` 文档给出相反指令，而且代码已经站在其中一边：

- `super-plugin-merge.md` §七 的目标形态是「一个包、一个核、两个面（route / session）」，没有 ingress；§九 明确「不做」Ticket/Mandate/Thread 领域模型、GitHub/飞书事件源、自建调度器/poller。
- `super-plugin.md` / `overview.md` 的 V0 是「issue 里 @ 它 → 改代码 → 回评论」，而 `contract/types.ts`、`sources/github-issue.ts`、`faces/ingress.ts` 已经把前两件做了。

冲突的根因不是谁写错了，是**产品定义变了而旧约束没跟着改**：merge.md 写于「做路由底座」的假设下，那个假设里入口确实不该由插件拥有；后来产品定为「给仓库配一个不睡觉的同事」，入口就成了前门。

## Decision

**做 on-call 产品；路由是底座，入口是前门。**

1. `super-plugin-merge.md` 标 `superseded`，保留原文与失效范围；新判断写在本笔记。
2. **入口只产 Case，不驱动会话**。`faces/ingress.ts` 读 GitHub、判授权、开 Case、落库、自循环；执行交给 DSH 的 `sessionController.create`。这条把 merge.md:289「自建 poller 会抢所有权」的担忧限制在「驱动会话」上——读外部变化不抢宿主调度权。
3. **`thread` 映射与最小 `step` 表提前进 V0**。理由：幂等键是 trigger 级，同一张 issue 的追问会开出第二个 Case（两个 Case 抢同一分支）；executor 一旦写 outcome，outcome 必须有归属，否则 V1 要迁移并重新解释历史。
4. **merge.md §九 的前三条作废，其余保留**。领域模型仍不抄 superagent 的（它为独立部署而造），但 Case/Mandate 是自己的领域；事件源必须做；comet 的 runtime 仍不搬，只借三分法与「机器态不可写」。

## Alternatives considered

- **回退 ingress，只做路由底座**：文档自洽，但产品退回成基础设施，V0 的验收变成「别的插件愿意依赖我」——无法验证，也没有用户。
- **把 Case 层并入 route 面**：减少一层，但 Case 的授权与生命周期和「这次调用走哪条渠道」是两个问题；合并后 Case 会开始感知渠道，V2 的「渠道挂了任务不停」就做不成。
- **`thread` 与 `step` 等 V1/V3**：能少写两张表，但 V0 的第一周就会重复开 Case，且 executor 的 outcome 无处可写；返工成本高于现在多写一张表。

## Consequences

- 插件开始承担 GitHub API 生命周期（分页、限流、token、App vs PAT）——这是 merge.md 警告过的成本，接受，因为它是产品前门。
- 出现两份状态：Case 表（权威）与 DSH 会话（执行器）。重启时以 Case 表为准，会话只是某一次执行；这条要写进 executor 的设计。
- 仍不做：多仓库/多租户、飞书（V4）、面板与任务线（V5）、自建 agent loop、独立部署形态。
- 缺口不变：executor 与回执是唯一堵点；`step`/`thread` 表与恢复是下一刀。
- 验证：现状 11 套全绿（见 `memory.md` 2026-11-11 条）；本笔记不改变任何代码行为，只改文档与后续验收口径。
