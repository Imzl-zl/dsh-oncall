---
title: "DSH On-call — 架构"
status: "implemented"
kind: "architecture-overview"
last_updated: "2026-10-24"
---

# DSH On-call — 架构

## 摘要

本项目是 DeepSeek Harness（DSH）上的一个独立 Cordis 插件，提供模型渠道选择与跨渠道失败切换。它复用已注册的 provider adapters，并让一次请求使用的实际渠道、重试与恢复状态都可以从 durable 日志解释。

## 设计页面

> **从这里开始**：[总览：产品、架构、进度](design/overview.md)——一句话产品定义、命名、三个粒度、五层、已实现 19 个模块与 1681 行、未实现清单、V0–V5 路线。

- [产品形态与配置面](design/product-plan.md)：用户视角这是什么、能配什么、看得到什么、做不了什么、分期。
- [详细架构与行为提案](design/architecture.md)：请求路径、路由配置、失败策略、Session 与 UI 影响。
- [工作台布局重构](design/ui-layout-redesign.md)：DSH 原生页面契约、分区/行/弹窗的布局规格、落地状态与同步修的逻辑语义。
- [Agent Fleet 右栏与三页签配置中枢](design/agent-fleet-drawer.md)：右栏全局/单会话、三页签配置、数据口径与实施偏离记录。
- [运行时对齐与委派名册（P2）](design/p2-roster-and-runtime-alignment.md)：基线对齐到 `0.2.1-rc.3`、名册 host→UI 次序与验收。
- [P2 后续会话交接](design/p2-next-session-brief.md)：已落地的事实、已定语义、原生能力核对、剩余缺口与验证配方。
- [Gemini 模板审查](design/ui-review-gemini-template.md)：模板的载体、关系图、数据与排版问题，以及可保留的部分。
- [DSH 能力边界](design/dsh-capability-boundary.md)：DSH 原生支持什么、不支持什么、每个缺口的最优雅补法、外置插件须遵守的社区规范。
- [DSH 源码地图](design/source-map.md)：已核实的扩展点与消费者。
- [未决问题](design/open-questions.md)：仍需产品 owner 决定或技术 spike 验证的事项。
- [构建管线与插件自有 Remote](design/build-pipeline-and-plugin-remote.md)：让插件拥有自己的 Remote 服务（主动探测档位的前提）所需的构建改动；提案待确认。
- [按会话选择降级链](design/per-session-chains.md)：命名链 + 会话绑定；DSH 原生提供什么、缺什么，以及绑定存哪、熔断归谁。
- [遗留任务交接](design/handoff-proposal.md)：名册 + 一个 `handoff` 工具（派人 / 收工 / 重启 / 状态）+ 插件备料；判断权在模型，插件只守协议与闸门。
- [每个渠道到底能重试几次](design/retry-budget-ownership.md)：`1 + min(插件配置, 渠道策略)` 的来历与三种修法。
- [超级插件：一个包的架构](design/super-plugin.md)：**总方案**。一个包、一台状态机、三层粒度（Case / Step / Attempt）、五层依赖、五张表、19 个模块；V0–V5 纵向切片与四条验收不变量。
- [V0 代码设计](design/super-plugin-code.md)：三条代码规则、类型地图、六个核心函数签名、Source 接口与窄接口、五层测试策略、禁止写法、V0 的 11 个文件清单。
- [超级插件融合方案](design/super-plugin-merge.md)：**已 superseded（2026-11-11）**。两个参考项目的设计意图、三种接入方式、可借的纪律与不借的部分仍有效；§七 目标形态与 §九 前三条「不做」已被[产品路线变更](../../.agents/notes/implemented/2026-11-11-oncall-product-route.md)取代。
- [分层与模块架构](design/super-plugin-architecture.md)：现有代码的分层体检与 M0–M4 迁移次序；含两处现有违规。
- [建议实施阶段](design/implementation-plan.md)：从技术验证到可选核心扩展的次序。
- [功能完成度与逻辑语义审查](design/feature-review-2026-10-26.md)：2026-10-26 的全量审查记录——九项交付状态、三条 Critical 的现象与证据、Minor 分类；修复排期见[决策登记簿](design/open-questions.md)十三节。
- [扩展面设计建议](design/extension-surface.md)：接缝/纯函数核/单一事实源清点，policy 层形状（输入/输出/一次性 key）、"加一个旋钮要改哪几处"、被否方案、迁移顺序与回滚；提案待确认。
- [主流产品先例](references/prior-art.md)：LiteLLM、Portkey 和 OpenRouter 官方文档对照。

## 当前形态

插件不改 DSH 核心。实际候选选择在 `agent/request`，失败切换在 `agent/request-error`；已由 `prepareCall()` 捕获 adapter 之后，不能靠后续 `llm/stream` 改路由。

产品模式是**透明物理故障转移**：用户照旧选真实模型，插件在第一跳失败后按配置的有序候选切换。逻辑模型不进官方选择器（那要改 DSH 核心的 catalog/selection/projection），候选索引也不跨重启（进程内存，重启即重置）。能力边界的两条结论：**attempt lineage 可由插件自有 session projection 折叠核心事件 durable 重建，无需新事件类型或 plugin record**；**每次尝试的总量只能由 Router 自己持有**，因为 Agent step 循环本身没有上限。详见[能力边界](design/dsh-capability-boundary.md)第七节。

另有一个**默认关闭的入口面**：按 `ingress` 配置轮询一个 GitHub 仓库，把被授权的要求写成 Case。它只产 Case、不驱动会话；执行器（executor）与回评论仍未实现，打开入口只会看到 Case 被建出来。
