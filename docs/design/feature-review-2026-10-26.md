---
title: "功能完成度与逻辑语义审查（2026-10-26）"
status: "findings"
kind: "review"
last_updated: "2026-10-26"
---

# 功能完成度与逻辑语义审查

对 `packages/dsh-oncall` 的一次全量功能审查记录：九项交付是否真的存在、逻辑语义是否正确、证据在哪。**记录事实与证据，不记录修复排期**（排期见 [决策登记簿](open-questions.md) 十三节）。

**2026-10-26 复核**：第四节每条都回到源码重核过一遍，判定写作 真 / 真·窄（触发面比记录小）/ 不成立，并给出最小修法；同轮新增 4.17。三条 Critical 维持原判。审查自己也栽过同一类：4.13 的依据是 `index.ts:363-368` 的注释而不是 `resolveChain` 的代码，实际的错位见 4.17。

## 一、范围与方法

- 基线：commit `95ca438`，工作树干净；被审对象为 whole plugin（host `src/` ~350 KB、client `src/client/` ~380 KB、四套 `tests/` ~480 KB）。
- 契约来源：[AGENTS.md](../../AGENTS.md) 的「当前交付」九项 + [架构总入口](../architecture.md)。
- 方法：主审逐行读 host 路由主干，另设五个分域独立审查（host 主干 / host 支撑层 / 交接与右栏 / client UI / 测试真实性），每条结论回到源码与该版本 DSH 声明核对。DSH 事实一律在 `0.2.1-rc.3`（仓内 `node_modules/@deepseek-ai/*` 与本仓 devDependency 同版）上实读，不引用未发布 HEAD。

### 本次实跑的证据

| 检查 | 结果 |
|---|---|
| `npm test` | unit **233** / client-controller **123** / remote **25** / run **35 场景 0 失败** |
| host `tsc --strict`（AGENTS.md 标准命令） | exit 0 |
| 组合测试是否为真实 Loader | 是：`tests/run.mjs:1093-1097` 拉起真实 `dsh --profile headless --patch`；`tests/remote.mjs:136-189` 进程内 boot 真实 headless profile 并走真实网关 |
| 计数断言与代码结构 | 逐项精确吻合（行首 `test(` 注册点、`SCENARIOS` 条目数） |
| 代码对 DSH 的事实断言 | 抽查 10 个错误码、7 个扩展点在真实包内全部存在，无编造 |

**产物新鲜度（`npm test` 不构建，三套件跑 `lib/`）**：审查时 `lib/` 最新写入 `2026-10-26 11:05:26`，`src/` 最新 `11:05:20`，产物晚于源码 6 秒，因此上表数字对应当前源码。**复核（同日 18:00）按同一证据基础复点**：行首 `test(` 注册点仍为 233 / 123 / 25，`SCENARIOS` 仍 35 条；`lib/` 14:13:12 比 `src/` 14:13:07 新 5 秒。复核未重跑套件（无代码改动）。`lib/` 未被 git 跟踪，任何人改完 `src/` 直接 `npm test` 都会让后三套验证旧产物——这是流程风险，见 5.2。

## 二、九项交付状态

| # | 交付 | 状态 | 关键证据 |
|---|---|---|---|
| 1 | 命名链与按会话绑定 | 可用 | `chain.ts:314-343`、`bindings.ts:55-59,106-236`；组合场景 `session-binding-selects-a-named-chain`、`session-binding-without-storage-domain` |
| 2 | 失败切换与插件自有重试 | 可用 | `router.ts:471-582` 裁决表 + `index.ts:510-589` 解释器；预算换算单点 `router.ts:148` |
| 3 | 立即切换白名单 | 可用 | `router.ts:350-353,493-506`；默认 `defaults.ts:258`；场景 `immediate-switch-skips-the-retry-budget` |
| 4 | 截断续跑 | 可用 | `index.ts:599-634`、`state.ts:231-259`；场景 `truncated-output-continues-then-switches-candidate` |
| 5 | 候选预校验 | 可用 | `index.ts:396-419` 走 `resolveCallConfig`；三档 `precheck.ts:32-63` |
| 6 | 渠道健康与探测 | 可用（2026-10-26 修） | 被动折叠 `health.ts:183-286`、真探测 `probe.ts`、熔断 `breaker.ts:67-114` 均在；4.4 / 4.5 / 4.6 已修，见第七节 |
| 7 | 中文通知 | 可用（2026-10-26 修） | `notice.ts` 各构造器全中文、标签按 `SwitchOnCode` 联合键控；4.7 的假话已改，见第七节 |
| 8 | Agent Fleet 右栏 | 覆盖不足 | 仅伪 DOM 组件调用 + 源码正则守卫；无真实浏览器/组合验证 |
| 9 | 委派名册与交接 | 可用（2026-10-26 修，opt-in） | 四动作、名册校验、预算闸均在；3.3 已换公开面，`newSession` 由 `tests/handoff-relay.mjs` 在真实 `web` 组合里端到端覆盖，见第七节 |

主干结论：**失败切换、重试预算、截断续跑、按会话绑定四条的语义正确**，游标在两条 seam 上自洽，与 DSH 原生 `llm-retry` 不会重复重试同一条路由。

## 三、Critical

### 3.1 图片粘滞窗口永不归零

`index.ts:325` 在**每个 step** 调用 `setStickyTurns`，而 `state.ts:336-338` 的守卫是 `stickyRemaining === 0 && turns > 0`，不判断本轮是否带图。

`stickyTurns = 2` 且全程纯文本时的实际序列：T1 文本 → T2 `hasImages = true` → T3 归零后再次补满 → T4 起 `hasImages` 恒为真。后果是 `needs.images: false` 的文本候选被持续跳过、只带图的识图候选对所有文本请求变为可用，与该字段语义（`config.ts:133-134`：「带图轮**之后**……无图轮数」）相反。默认 `stickyTurns = 0`，故默认配置不触发。

现有测试为何不报：三处粘滞单测（`tests/unit.mjs:1360-1405`）只在序列开头调一次 `setStickyTurns`，与生产「每步一次」的时序不同；组合层的 `stickyTurns: 2` 场景（`tests/run.mjs:663`）是单轮任务，跨轮衰减在组合层不可触发。

最小修法（复核后）：turn note 里区分「本轮自有图」与「被粘滞延长」，补满只在本轮自有图为真时发生——`state.ts:293-299` 多存一个标记、`state.ts:336` 的守卫多一个条件，窗口仍由 `agent/request` 写入。被否方案：把窗口写入搬到 `agent/pre-step`。它拿不到 `resolved`，而 `stickyTurns` 虽是链级标量、`chainForSession` 在 pre-step 可求值，为它复制一次链解析不划算。

### 3.2 健康设置越界值导致保存永久失败且无原因

前端钳位与 host schema 各写一份边界，且浏览器校验不含 health：

- 前端只钳下限、无上限：`client/modals.ts:193,257`（`Math.max(0,…)`）、`:264,339,422`（`Math.max(1,…)`）；`NumberInput` 未传 `min`/`max`。
- host schema：周期 `0..86400`（`config.ts:170,185`）、探测超时 `2..60`（`config.ts:193`）、冷却 `1..86400`（`config.ts:207`）。
- 浏览器校验 `client/validate.ts:154-172` 只覆盖候选路由/重试次数与名册两个数值，health 无任何字段。

复现：把「单次探测超时」减到 1 → 保存被 host 拒绝 → `client/controller.ts:825-828` 丢弃拒绝原因 → `client/page.ts:119` 只显示「保存失败，请重试」→ 重复保存永远失败且不指向任何字段。

这一条与 `client/validate.ts:151-152` 自述的不变量正面冲突（「浏览器要在保存前挡住，否则用户吃到的是 host 的英文拒绝」）。

最小修法：health 的四个边界（`config.ts:170,185,193,207,229`）并入 `validate()`（key + 中英文案），`save()` 把 host 拒绝原因带进 problems 列表——两处都必须有，缺任一半仍是「永久失败且不知原因」。`NumberInput` 的 `min`/`max` 从 `defaults.ts` 同源派生属顺手项，不是必需。

### 3.3 交接 `newSession` / `finish + onFinish` 调用不存在的方法

`handoff-tool.ts:84-88` 为 `sessionController` 手写结构类型，声明 `createSession` / `selectionFor` / `selectForNextRequest`，并在 relay 中直接调用（`:420`、`:422`、`:427`）。

真实服务：注册键确为 `sessionController`（`dsh-api-session-controller/lib/index.js:2952` `super(ctx, "sessionController", …)`），其公开面只有 `create(request)` / `selectModel(request)`（同包 `lib/types/index.d.ts:101,107`）；那三个方法位于内部私有类 `ApiSessionAgentController`（`lib/types/agent.d.ts:130,136,142`）。因为 `index.ts:679` 是 `as` 强转，TypeScript 无法发现；`sessionController === undefined` 的优雅拒绝分支（`handoff-tool.ts:404-409`）也不会触发，服务确实存在 —— 结果为 `TypeError: controller.selectionFor is not a function`。

单元测试固化了这个错误契约：`tests/unit.mjs:3671-3674` 的假 faces 正好实现这三个不存在的方法，`:3708` 还断言其调用顺序。

影响面：`handoff.enabled` 默认 `false`、`onFinish` 默认 `[]`，仅 opt-in 用户命中；但四动作中的 `newSession` 完全不可用，而交接被列为已交付。

最小修法：走公开面——`create({cwd})` → `sessionId`（内部走 `agents.createSession`，agent 已在注册表）→ `ctx.agents.get(sessionId)`（`dsh-agent/lib/types/index.d.ts:343`）→ `selectModel({sessionId, provider, model})`；旧会话的 selection 用 `agent.session.requestHeader()?.config` 读，不碰私有类。假 faces（`tests/unit.mjs:3671-3674`）按真实签名重写，并给 `tests/run.mjs` 加一条组合场景（4.16）——否则同一个错契约会再长回来。

## 四、Important

判定口径：**真** = 现象与后果都成立；**真·窄** = 成立但触发条件比记录更窄；**不成立** = 记录有误。处置栏的 A / B 是批次（见[决策登记簿](open-questions.md) 十三节），「删」表示字段或代码应当删除而不是补齐，「记账」表示只登记不修。

| # | 判定 | 触发与后果 | 最小修法 | 处置 |
|---|---|---|---|---|
| 4.1 | 真·窄 | 用户为某 provider 选 `always`，且选中模型正属于它。第一跳是 `router.ts:112-117` 现造的隐式候选，加载期审计只走链候选（`index.ts:1074-1078`），看不到它；`dsh-llm-retry/lib/index.js:153-164` 对 always 既不查码表也不查上限；插件在 `index.ts:568-571` 恒判「内层已重试」→ `honor` → 同路由无限重试。触发面比记录窄：默认策略是 `normal`，always 是显式 opt-in | 判据放请求期而不是加载期：当前候选的 provider 策略为 always、且该码不归插件接管（`index.ts:486-488` 的 delegate 分支）时，不再把控制权交进无界重试——改为带 warn 的终态，或按插件预算收口（二选一以组合场景实测为准）。always 的 resolved policy 只有 `mode`/`backoff`（`dsh-llm:340-344`），没有 `retryableCodes`，「照可重试集判断」行不通 | 修·A |
| 4.2 | 真·低频 | 订阅回调只比 host 新旧值，不判草稿脏（`controller.ts:617-626`）：外部保存本 namespace 会冲掉未保存的链/名册，并清 `failed` | 脏草稿时保留草稿 + 一条 notice；不做询问弹窗。单窗口下触发面小 | 记账 |
| 4.3 | 真（记录需修正） | `catalogFailed` 置位后无消费者（全仓仅 store 透传），`modals.ts:505` 只按 `catalog === null` 画「正在加载」。**「失败后无法重试」不成立**：`ensureCatalog` 在 `catalog===null && !loading` 时会再进（`controller.ts:367-368`） | 把 `catalogFailed` 渲染成错误行 + 重试按钮；断言失败态不显示「正在加载」 | 修·A |
| 4.4 | 真 | 探测只把 `deadline.signal` 交给适配器（`probe.ts:108-119`），从不 race `whenExpired`（`deadline.ts:66-70` 自述）；适配器不理 abort 时 `probeInFlight` 不减（`index.ts:758-771`），`index.ts:935` 让定时探测永久静默停摆 | 照抄 `connectivity.ts:166-169` 的 `Promise.race`（4 行） | 修·A |
| 4.5 | 真·空闸 | `health.passive` 只出现在 schema、UI 与透传里（`config.ts:224`、`modals.ts:85,416`、`validate.ts:271`）；注册与读取都无条件（`index.ts:214`、`controller.ts:556`） | **删字段**（四处），不接线：被动折叠零成本、读的是已有日志 | 删·A |
| 4.6 | 真 | `ACCOUNT_QUOTA` 真实存在（`dsh-llm/lib/index.js:140`；`dsh-llm-deepseek-account/lib/index.js:88` 由 `QUOTA` 改写），八码表（`defaults.ts:204-215`）与 `classifyHealth`（`health.ts:103-113`）都没有它 → 只经 `other` 归口：白名单点不到「额度」，余额耗尽的渠道仍绿灯，通知印英文码 | `switchOnKeyOf` 加一条别名 `ACCOUNT_QUOTA → quota` + `classifyHealth` 一个 case（4 行）。不要往码表加第二行：一码一键，重复 key 会污染界面网格 | 修·A |
| 4.7 | 真 | `notice.ts:216` 写「约 N 秒后自动重试」，而 breaker 只回答「何时解除」，解除后等下一条进来的请求（`breaker.ts:99-104`）；`unit.mjs:614` 把错文案钉住。这是 durable 通知、进模型上下文 | 改一句「约 N 秒后重新可用，本次跳过」+ 改那条断言 | 修·A |
| 4.8 | 真·空闸 | 全仓 6 处（schema `config.ts:287`、type `:548`、`defaults.ts:311`、名册 UI `roster.ts:284,287`、`validate.ts:209`）+ 测试 2 处，`handoff.ts` 内 0 处；真闸只有 per-turn / per-user-message / per-role / maxReviews / maxNewSessions（`handoff.ts:621-668`） | **删字段**。实现「每天」要引入新的时间源与跨重启口径，收益为负 | 删·A |
| 4.9 | 真·窄 | `handoff.ts:596` 的 override 直接 `return`，把 `:610-617` 的 `handoffNote` 闸整个跳过 → 一句 override 就能开一个没有下一步任务的接力会话——`finish` 路径绕过的正是 `newSession` 动作上仍会拒绝空 note 的那道闸（`handoff.ts:657-660`） | 闸序调到 review 闸之前，或 `return` 改 `else`（4 行） | 修·B |
| 4.10 | 真·窄 | `report` 在 schema 声明、也向模型宣传（`handoff-tool.ts:213`、`handoff.ts:488`），`finish()`（`handoff-tool.ts:352-377`）从不读 `args.report` → 「做了什么/还剩什么」无人接收 | receipt 带 report，收工通知与接力简报各引一句（约 10 行）。也可删字段，但设计把它当 `needs_user` 的载荷 | 修·B |
| 4.11 | 真·更窄 | 无 `sessionProjections`（可选服务，`index.ts:212`）时 `compactions/turns/toolFailures` 与 delegations 全报 0（`handoff-tool.ts:582-584`）；同函数 `:588` 的 todos 正确返回 null。正常组合有投影，不触发 | 三处改 `state === undefined ? null : …`（3 行） | 修·B |
| 4.12 | 真 | 条件跳过用整组键（`index.ts:424`、`conditionSkipKey` `:998-1000`），同函数另两类跳过是逐路由键（`:430`、`:441`）：一轮里集合变化会整组重发 durable `user/message`，重复进上下文、重复计 token | 键搬进循环用 `condition:${routeKeyOf(...)}`（3 行） | 修·A |
| 4.13 | **不成立** | 隐式第一跳不带 `needs`（`router.ts:112-117`），与选中路由同名的候选又被 `resolveChain:110` 过滤，`conditionSkipped` 永不含第一跳——「通知说跳过 X 而请求发回 X」不可达；落回 `resolved` 时被跳过的仍是降级候选，文案为真 | 无需改代码（当前形态不可达）。错的是 `index.ts:363-368` 与 `router.ts:305-310` 的注释。**一旦 4.17 给第一跳挂上条件，这条立刻变成可达**：头被条件跳过、链上其余候选全不可用时，`:444-453` 会落回 head，而「已跳过第一跳」的通知已经发了。实现 4.17 必须同批处理这条文案 | 随 4.17 |
| 4.14 | 真·轻 | 健康页位次标签读 `draft.chain`（`workspace.ts:146`），而它由 `published.chain = edited(published)`（`controller.ts:285`）填成**当前编辑链**；检查/探测走 `configuredRouteList`（全链，`controller.ts:975,1128`、`page.ts:273`）→ 切链后同一渠道结论变化，可显示假的「未配置到降级链」 | 传全链或按链逐条标注；断言「切到另一条链后，A 链的渠道仍显示在位次里」 | 修·A |
| 4.15 | 真·一次性 | 缺 `policyVersion` 时 `switchOnOf` 整表丢弃用户值（`chain.ts:162-164`），而 `:152-157` 的理由只覆盖 `emptyResponse`/`invalidRequest` 两个旧默认 false 的键 | `policyCurrent ? {…DEFAULT, …over} : {...over, emptyResponse: true, invalidRequest: true}`（1 行） | 修·A |
| 4.16 | 真·流程 | `tests/run.mjs` 中 `handoff` 出现 0 次；`tests/remote.mjs:276-310` 只有注册与两次拒绝（`:273-274` 自认造不出真会话）；3.3 因此存活 | 加 1 个 `newSession` 场景（overlay 设 `handoff.enabled: true`）即可把 3.3 打红，不必覆盖四动作矩阵 | 修·B |
| 4.17 | 真（新增） | `product-plan.md:93` 与 `index.ts:363-368` 称条件对第一跳生效，当前形态不可表达（机制同 4.13）。后果：`primary needs.images: false` 这个写法不存在，纯文本轮也会先打到识图模型——§2.4 的零点击识图路由在一条全局链之后不成立。缺的只有一个字段：图片检测、条件过滤、跳过通知、每轮重判四件机制都已存在，只有隐式第一跳没有 `needs` 位 | **补 `chain.primaryNeeds`**（与候选 `needs` 同形）：`resolveChain` 把它挂到隐式第一跳；条件检查本来就对 index 0 生效（`index.ts:376-383`），跳过、通知、落回全部复用现有代码。约 100 行含配置页三态控件 + 3 单测 + 1 组合场景。**必须同批处理 4.13**：头被条件跳过而链上无可用候选时会落回 head，「已跳过第一跳」的通知不能先发。「改文档承认做不到」被否——不是能力缺失，是字段缺失 | 修·A |

## 五、Minor（按类归并）

复核范围（2026-10-26）：5.1 的前三条、5.2 的构建一条、5.4 的字典与文案四条、5.5 全部已回到代码确认；5.3、5.6 与 5.2 的并行互污未复核，按原记录保留。

### 5.1 第二事实源 / 重复实现

- 浏览器手写 `parseHandoff`（`client/fleet/model.ts:259-285`）是 host `projectionStateSchema`（`handoff.ts:147-154`）的第二份解读，且把缺失 `epoch` 兜底成 0。
- `statusTone`/`statusLabel` 在 `client/pipeline.ts:23-36` 与 `client/workspace.ts:55-68` 逐字重复。
- `chain.ts:184` 把 `continues` 上界写成字面量 `9`，同文件已 import `DEFAULT_MAX_TOKEN_CONTINUES`，而 `MAX_TOKEN_CONTINUES`（`defaults.ts:188`）是同一约束的正式常量。
- 旧字段迁移未按上界夹取：`chain.ts:212`（`firstHopMaxAttempts`）、`:222-223`（`maxAttempts`）绕过 `MAX_RETRIES`（`defaults.ts:49`）。
- `config.ts:251` 在描述串里手写「≤4000」，与 `defaults.ts:281` 的 `HANDOFF_INSTRUCTIONS_MAX` 重复。

### 5.2 流程与可复现性

- `npm test` 不构建，`lib/` 未跟踪，后三套件读产物（`client-controller.mjs:33`、`remote.mjs:87`、`run.mjs:27`；只有 `unit.mjs` 直读 `src/`）。复核时 `lib/` 恰比 `src/` 新 5 秒，所以既有数字有效，但无机制保证。**建议只做 mtime 断言**（三套件共用 5 行：最新 `src/` 晚于最旧 `lib/` 即失败并提示构建）：`pretest` 每次多几十秒，还会掩盖「忘了构建」这件事本身。
- 组合场景的配置形状是反的：`chainConfigYaml`（`tests/run.mjs:1020-1036`）有意支持两种形状，但 35 条里 34 条写旧 `chain`/`profiles`，canonical `chains` 只有 `session-binding-selects-a-named-chain` 一条（`run.mjs:502-517`）。建议新场景一律写 `chains`，旧形状只留 1–2 条迁移场景；不改写既有 34 条。
- 固定路径并行互污：`tests/run.mjs:1088` 与 `tests/remote.mjs:127` 写同一份 `tests/stub-script.json`，并各自删除自己的 sessions 目录。
- 弱断言 4 处：`tests/remote.mjs:248,261` 与 `tests/unit.mjs:2897` 为裸 `assert.throws`；`tests/remote.mjs:262` 的字符串第二参数在 Node 中是断言失败提示语、不是匹配器，等价于裸调用。
- 浏览器层 123 条中 31 条为读源码文本的正则守卫；界面中文在 `client-controller.mjs:1236` 以 `t = key => key` 驱动，只验键名不验译文。真实浏览器实测的 `web*.overlay.yml` 被 gitignore 且不在 `npm test` 内。

### 5.3 状态与资源

- 会话绑定只写不删（`bindings.ts` 无 delete 路径），域按 sessionId 只增不减。
- `nudges` Map（`index.ts:709-713`）键 `sessionId:turn` 永不清理。
- `holdBusy` 的 `setTimeout`（`client/controller.ts:1059-1063`）未纳入 dispose。
- `openDrawer`（`client/controller.ts:956`）未判 `ctx.remote.session` 就调用，而 `loadPassive` 有守卫。

### 5.4 文案与字典

- `t('noMatchingProfiles')` 在 zh/en 两份字典都未定义（仅 `client/modals.ts:507` 使用），界面回退键名；现有测试只验 zh/en 键集互等，不验调用点。
- 英文界面夹硬编码全角括号（`client/workspace.ts:17,19,20,48,340,342`）。
- `problemBadMaxRetries`/`problemBadFirstHopRetries` 把 `0~99` 写进文案而非用 `{max}` 占位（`client/locales.ts:136,139,670,673`）：`MAX_RETRIES` 改动时文案不会跟。
- 同一状态两名：筛选「未调用」 vs 胶囊「待观测」。
- `client/chip.ts:283-284` 注释写「0..9 / 夹到 9」，实际 `MAX_SESSION_RETRIES = 99`（`defaults.ts:60`）。
- 宿主通知印原始 `provider/model` 键，界面印目录名（`client/naming.ts`），同一对象两套称呼。

### 5.5 死代码 / 死键

- `allPhysicalRoutes`（`client/page.ts:75-83`）全仓仅 1 处出现。
- `openNotes`/`onOpenNotes` 不可达（`client/controller.ts:1163`、`client/apply.ts:222`；`page.ts` 从不传 `onOpenNotes`）。删掉后「重开本版说明」这个入口正式不存在——自动打开走 `initialNotesOpen`。
- `handoff-wire.ts:35-36` 的 `settled` 取值与 `child?` 字段 fold 从不写、UI 从不读；`client/locales.ts:411` 同属死键。

### 5.6 DSH 引用与 API

- 5 处源码行号漂移（`probe.ts:50,131,150`、`connectivity.ts:14-16,70`、`health.ts:198`）。
- `stateOf`（`handoff-tool.ts:651-655`）在 rc.3 已 deprecated 且每次调用打 warn，交接每个动作都会走它。
- `probe.prompts[].route` 不校验（`probe.ts:186-193` 精确匹配，写错即静默 no-op）。

## 六、系统性结论

三个 Critical 全部通过了 233 条单测，漏检机制各不相同：

1. **单测时序与生产时序不同**（3.1）：单测在序列开头调一次，生产每步调。
2. **手造 faces 把错误契约固化成断言**（3.3）：单测断言了不存在的接口与调用顺序。
3. **整块能力没有任何校验**（3.2）：health 的数值边界从未进入 `validate()`。

对应的五条改进判据：

- 组合套件不能是单轮任务（跨轮语义——粘滞、预算跨轮、绑定改写——在单轮场景里不可观测）。
- 手造 faces 必须与真实 `d.ts` 对账；可加一条把 fake 的属性集与真实服务公开面比对的测试。
- 「浏览器要在保存前挡住」这类不变量需要一条覆盖全部 schema 数值边界的测试，否则漏一整块没人发现。
- **配置项必须有执行点**：4.5 与 4.8 说明 schema 与 UI 可以先走，而「谁读它」无人核对。判据：每个配置键要么有一个读者测试，要么出现在一张源级清单里被逐项点名——两者都没有的键不许进 schema。
- **注释与设计页会顶替代码成为「事实」**：4.13 依据的是 `index.ts:363-368` 的注释、4.17 是同一句注释与实现相反。写「某事对 primary 生效」这类断言时，要么同时指到具体分支，要么不写。

## 七、修复落地（2026-10-26 晚）

四节各条按后一轮的复核结论分两批落地；每条都有会失败的断言，位置如下（`unit` = `tests/unit.mjs`，`cc` = `tests/client-controller.mjs`，场景 = `tests/run.mjs`）。

| 条目 | 落地形态 | 断言 |
|---|---|---|
| 3.1 | 补满只认当轮自有图（`state.ts` 的 `ownImages`） | unit：按生产时序每 step 调一次 `setStickyTurns`，纯文本轮不得读成带图 |
| 3.2 | 五个数值边界收到 `defaults.ts` 一处；`save()` 把 host 拒绝原因上屏 | unit：越界值读回即钳位且过 host schema；cc：拒绝原因进 `saveError` |
| 3.3 | 公开面 `create` → `agents.get` → `selectModel`；旧选择读 `requestHeader()?.config` | unit：公开面原型对账 + 六步顺序；`handoff-relay`：真实 web 组合端到端 |
| 4.1 | `always` 且该码归内层 → 请求期 `terminate` + warn | unit：`decideBeforeInner` 四态 |
| 4.2 | 脏草稿保留 + 页脚提示（值等于草稿时仍视为保存回声） | cc：外部改值不覆盖未保存编辑，干净草稿照旧重播 |
| 4.3 | 目录失败态渲染错误行 + 重试（`catalogFailed` 终于有读者） | cc：源级守卫 + 失败态不显示「正在加载」 |
| 4.4 | `Promise.race` 包住 `prepareCall` 与 stream | unit：无视 abort 的适配器与永不 resolve 的 prepare 都返回 TIMEOUT |
| 4.5 / 4.8 | 删字段（被动观测无开关；每日上限无读者） | unit：schema 与草稿里都不再有这两个键 |
| 4.6 | `ACCOUNT_QUOTA` 归 `quota` + 健康判定 + 中文标签 | unit：键、健康、白名单三读一致，且不进码表 |
| 4.7 | 文案改「冷却至 …，到期不会自己重试」，冻结的相对秒数一并去掉 | unit：通知不含「自动重试」与「约 N 秒」 |
| 4.9 | override 只跳过复核闸 | unit：同配置下「有 override → note 闸拒」、「无 override → 复核闸拒」 |
| 4.10 | `report` 进回执、接力简报与收工通知（模型不写就不发） | unit：回执/简报/通知三处 + 未写 report 时零通知 |
| 4.11 | 无投影时计数回 `null` | unit：`facts` 四项皆 `null`，todos 仍 `null` |
| 4.12 | 跳过通知的裁决抽成纯函数 `skip-plan.ts`：三类跳过、落回裁决、逐路由去重全在里面，`index.ts` 只按计划 append | unit：同一 turn 连调两次、第二次集合变大只报新增路由；账本不被裁决改写；把键改回整组拼串该用例变红（已抽样） |
| 4.13 | 落回第一跳时不发「已跳过第一跳」 | 场景：`first-hop-skip-is-not-announced-when-the-request-falls-back-to-it` |
| 4.14 | 位次按全链标注：收集规则抽成 `src/client/health-channels.ts`（React-free），链名走 `format.ts` 的 `chainDisplayName` 一处 | unit：`health channels list every chain position, not only the chain being edited`（共享路由两条位次、观测到但未配置的路由无位次） |
| 4.15 | 迁移只强制 `emptyResponse`/`invalidRequest` | unit：旧配置里显式取消的 `rateLimit` 必须留下 |
| 4.16 | 新套件 `tests/handoff-relay.mjs`（独立 `DSH_HOME`，shipped `web` profile） | 十九项检查：服务面、`create`、`agents.get`、`selectModel`、`newSession` 端到端、接力后有活 agent；**delegate 两向**（名册钉死 route → 子会话的 `subagent/descriptor` 与首条 `request/header` 都是该 route；名册留空 → 都是父会话当前的 route；两条子会话各自真答） |
| 4.17 | `chain.primaryNeeds` + 链级三态控件 | unit：字段进执行链且条件对 index 0 生效（含旧 `profiles` 钉死候选的 `needs` 迁移成 `primaryNeeds`）；场景：`primary-condition-skips-the-first-hop` |
| **新 1**（本套件抓到，记录里没有） | 插件在注册时把 `sessionController`/`agents` 捕获成引用，而 web 组合挂得更晚 → 服务在、每次 `newSession` 都回「does not provide both」 | 改为调用时求值的 getter；`handoff-relay` 十项检查通过 |
| **新 2**（浏览器实测抓到，记录里没有） | settings 快照是**校验后**的值：schemastery 给 `chains` 盖了 `[]`，于是只有旧 `chain` 的配置在界面上显示成"一条空链"（`0 个渠道`、0 候选），按一次保存就把空链写回宿主并 unset 旧键——**用户的降级候选被清空** | cc：`a validated snapshot of a legacy config is not read as one empty chain`；实测对照：修复前 0 候选，修复后 2 候选 + 第一跳显示「仅无图」 |

浏览器实测（隔离 `web` 实例 + Chrome MCP，2026-10-26 晚）另确认三件事：第一跳条件的三态控件与链级 hint 都在；健康设置弹窗只剩三档（连通性检查 / 真探测 / 自动熔断）+ 时间轴，**没有**「被动流量观测」开关；委派名册的闸门只剩每回合与三个「每用户消息」，**没有**「每日派发上限」。

Minor 里同批收尾：

- **5.1** `chain.ts` 的 `continues` 上界改读 `MAX_TOKEN_CONTINUES`（字面量 `9` 是同一约束的第二份，unit 断言钳位跟着常量走）。
- **5.2** 四个读产物的套件开头调 `tests/freshness.mjs` 的 `assertFreshBuild()`（mtime 断言，源码比产物新即失败并点名 `npm run bundle`，已用一次 `touch` 证明会红、`remote.mjs` 退出码 1）；弱断言收紧为 `zod.ZodError`（3 处，含把字符串当匹配器的那处——Node 里那只是失败提示语）；`stub-script` 改为每套件一份（`STUB_SCRIPT`，`run.mjs`/`remote.mjs`/接力套件各写各的），并行跑不再互读对方的 outcomes。**仍未做**：5.2 的"场景配置形状"约定（记账）。
- **5.3** `nudges` 改 `WeakMap<Agent, {turn, used}>`（旧 `sessionId:turn` 字符串 Map 只增不减）；`holdBusy` 的 timeout 入册并在 `dispose` 清空（卸载后不再醒来 publish / re-arm 巡检）；`openDrawer` 补 `ctx.remote.session` 缺失守卫（与 `loadPassive` 同一条，界面说"读不到"而不是"没有记录"），cc 新断言 `the history drawer without a session face says "cannot read", not "no records"`。**记账**：会话绑定只写不删（域按 sessionId 只增），没有可靠的删除钩子，本轮不动。
- **5.4** 补 `noMatchingProfiles` 字典键，并加一条**从调用点扫字面量 `t('…')`** 的守卫——键集互等只证明两份一致，证明不了调用点有词。其余（英文夹全角括号、`0~99` 硬编码文案、同一状态两名、通知印原始键）未动。
- **5.5** 删三处死代码：`page.ts` 的 `allPhysicalRoutes`（定义后无人用）、`openNotes`/`onOpenNotes`（page 从不传，测试改写为只钉页头常驻入口）、`handoff-wire` 的 `kind: 'settled'` 与 `child?` 字段（连同 zod 枚举、fleet 的 `FleetActivityKind`/`ACTIVITY_KINDS`、`fleetActivityKind_settled` 两份字典键）。
- **5.6** 三条逐一复核：`stateOf` **不成立**——rc.3 的声明（`dsh-session-projection/lib/types/index.d.ts:167-175`）没有 `@deprecated`，运行期（`lib/index.js:126-130`）也没有 warn，它是"materialize 后读一个单元状态"的正常读口；`probe.prompts[].route` 写错即静默 no-op **真**，改加载期 `warnStaleProbePrompts`（与 `warnUnregisteredProviders` 同一条裁定，只 warn 不拒绝）；源码行号漂移**已逐条重核**（同日第二轮）：八处对不上 rc.3 的引用改成函数名锚点（`LlmRuntime.registration`、两个 `resolveApiKey`、`usableProbeKey`、`adapterFailureChunk`、`adapterStream`、`remoteDiscoverModels`、`discoverModels`、pi-ai `apply` 里的 `registerModelDiscovery`、两个适配器的 `generate`），核对后仍对得上的三处保留行号（`llm/src/index.ts` 的 `assertUsableApiKey`、`llm-deepseek/src/host.ts:55`、`llm-pi-ai/src/discovery.ts` 的 288/301/243）；`health.ts` 的两处（`agent.ts:635-651`、`session-stats/projection.ts:133-149`）核对无误。

**4.12 的自动网已补（同日第二轮）**：触发面（"同一步跳过 {A}、下一步跳过 {A, C}"）在组合 harness 里到不了——一次 boot 只有一个 step，且现有条件（带图/无图互斥、上下文门槛）只会让被跳过的路由**换一条**，不会让集合单调变大。所以把裁决抽成 `src/skip-plan.ts` 的纯函数，用两次调用覆盖它：第二次 `alreadyNoted` 取第一次的 `keys`，只许报新增路由。取舍与被否方案见 [笔记](../../.agents/notes/implemented/2026-10-26-skip-notices-are-a-plan.md)。

## 八、本记录未覆盖

- 两份设计页与实现的偏差清单（页签计数、健康页 KPI 四格、白名单分区位置、删除确认弹窗、`styles.ts` 行数等）不在本页；记账口径见 [决策登记簿](open-questions.md) 十三节。
- client UI 与四套测试为分域审查结论，行级通读限于 host 主干；未对视觉/布局做真实浏览器复核。
