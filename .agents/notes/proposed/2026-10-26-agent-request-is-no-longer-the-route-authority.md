# Agent Note: 上游已开始收回 `agent/request` 的路由权，迁移等它发布

Status: proposed

## Problem

插件把跨渠道切换放在 `agent/request` 的返回值上：listener `await next()` 之后用自己的候选覆盖
provider/model（[`src/index.ts`](../../../packages/dsh-models-router/src/index.ts) 的 `agent/request` listener），
靠 waterfall 顺序压过 `installModelSelection` 的写回。这个做法在**已发布的 rc.3** 上成立，但上游
`main` 已经改了契约：

1. **rc.3 发布包只查非空**：`agent/request` 返回后仅要求 provider/model 有值
   （`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1197`）。
2. **checkout HEAD 改成全等校验**：返回值与 step preparation 固定的 selection 不一致就抛
   `agent/request proposed "…" after step preparation fixed "…"; use agent.model.select() before step preparation`
   （[`agent.ts:628-633`](file:///D:/sudy/github/deepseek-harness/packages/core/agent-loop/src/agent.ts#L628)）。
3. **新 API 只在 checkout HEAD**：`Model.current()` / `Model.select(selection)`
   （[`runtime-types.ts:53-72`](file:///D:/sudy/github/deepseek-harness/packages/core/agent/src/runtime-types.ts#L53)），
   注释写明 `select` 替换的是"下一个 step 的完整选择"，"不改变已经准备好的 step"。
4. **同一 step 内换候选在新契约下不可能**：step 循环每次重试都用**同一个** `decision.selection`
   调 `prepareRequest`（[`agent.ts:437-438`](file:///D:/sudy/github/deepseek-harness/packages/core/agent-loop/src/agent.ts#L437)），
   所以重试期间改返回值必触发 628 的校验。
5. **rc.3 没有 `select`**：`dsh-agent/lib/types/model-selection.d.ts` 只导出
   `ModelSelection`、`ModelSelectionRef`、`installModelSelection`；`dsh-agent-loop` 与
   `dsh-agent` 的发布 bundle 里都搜不到 `select(`。

npm 的 `@deepseek-ai/dsh` dist-tags 当前是 `latest=0.2.1-rc.2`、`next=0.2.1-rc.3`，
checkout HEAD（`22ddee3792`）是 rc.3 之后 1533 个提交。也就是说这条守卫**尚未发布**，
今天没有任何用户受影响；但下一个把该守卫发出去的版本会让插件的主路由路径整体抛错。

## Decision

**不在本轮迁移。** 触发条件写死为：npm `next`/`latest` 出现包含 `agent.ts:628-633` 的构建时，
按"失败切换降到 step 边界"重新设计路由，并在这条路径上改用 `agent.model.select()`。
在那之前不动 `src/index.ts` 的路由实现。

这不是"先不做"，而是"现在做会做成坏的"：
新 API 在用户实际运行的 rc.3 上不存在，迁移后的代码在 rc.3 上直接 `TypeError`；
而且新契约只允许 **step 之间**换模型，插件的"同 step 内逐候选重试、按候选预算切换、截断续跑
跨候选"没有等价表达——那是语义变更，不是把一处调用换个名字。

## Alternatives considered

1. **现在就改成 `agent.model.select()`，切换降到 step 边界。**
   - 最强理由：一步到位，不再依赖 listener 顺序这种隐形契约；上游把顺序依赖明确点名要废止。
   - 为什么否决：`select` 只存在于未发布的 checkout HEAD，rc.3 上没有。改完四套件在 rc.3 上直接红，
     等于把能用的插件换成不能用的；要验证只能把 devDependency 指向未发布的构建，那又违反
     "仓库跟已发布 rc 对齐"的基线（`2026-10-24-runtime-alignment-rc3.md`）。迁移必须等到能实测的运行时。
2. **运行时特性检测，两条路径都在（有 `select` 走 `select`，没有就覆盖返回值）。**
   - 最强理由：一次改动同时覆盖现在与发布后，用户升级 DSH 不需要等插件发版。
   - 为什么否决：两条路径语义不同（step 内切换 vs step 间切换），attempt 预算、中文通知、
     `max-tokens` 续跑都要各写一遍并各自配用例；而"有 `select` 的那条"在当前环境**无法实测**，
     交付的是一个从没跑过的分支。等上游发布后一次性迁移，比长期维护两套语义便宜。
3. **什么都不做，等它炸了再说。**
   - 最强理由：零成本；该守卫尚未发布，上游也可能在发布前再调整。
   - 为什么否决：炸的形式是每一跳都抛 628 的错误，插件接管整体失效、所有请求失败；
     至少要有带 `file:line` 的登记项和明确的升级检查点，否则下一个人只会看到"升级 DSH 后全红"
     而不知道根因。

## Consequences

- 收益：rc.3 上维持现状，不改一行路由代码；把"下一次 DSH 升级会打断路由"从口头风险变成可核对的
  登记项（本节 + `docs/design/source-map.md` + `open-questions.md` §十二），升级前能主动检查。
- 代价：升级窗口是被动的。上游一旦发布，插件必须在用户更新 DSH 之前完成迁移，否则那个版本的
  用户直接不可用；而迁移不小——失败切换要从 attempt 级降到 step 级，预算、通知、续跑语义全部重定义。
- 代价：rc.3 与 checkout HEAD 已分叉 1533 个提交，同类文档引用必须同时写清"发布包行为"与
  "checkout HEAD 行为"，只写一边就是新的矛盾源（本轮已在 `source-map.md` 按这个格式改）。
- 观测手段：升级 DSH 后先跑 `npm test` 的 35 个组合场景；出现
  `after step preparation fixed` 即命中本项，按上面的触发条件进入迁移。
