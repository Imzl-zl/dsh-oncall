---
title: "功能完成度与逻辑语义审查（2026-10-26）"
status: "findings"
kind: "review"
last_updated: "2026-10-26"
---

# 功能完成度与逻辑语义审查

对 `packages/dsh-models-router` 的一次全量功能审查记录：九项交付是否真的存在、逻辑语义是否正确、证据在哪。**记录事实与证据，不记录修复排期**（排期见 [决策登记簿](open-questions.md) 十三节）。

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

**产物新鲜度（`npm test` 不构建，三套件跑 `lib/`）**：审查时 `lib/` 最新写入 `2026-10-26 11:05:26`，`src/` 最新 `11:05:20`，产物晚于源码 6 秒，因此上表数字对应当前源码。`lib/` 未被 git 跟踪，任何人改完 `src/` 直接 `npm test` 都会让后三套验证旧产物——这是流程风险，见 5.2。

## 二、九项交付状态

| # | 交付 | 状态 | 关键证据 |
|---|---|---|---|
| 1 | 命名链与按会话绑定 | 可用 | `chain.ts:314-343`、`bindings.ts:55-59,106-236`；组合场景 `session-binding-selects-a-named-chain`、`session-binding-without-storage-domain` |
| 2 | 失败切换与插件自有重试 | 可用 | `router.ts:471-582` 裁决表 + `index.ts:510-589` 解释器；预算换算单点 `router.ts:148` |
| 3 | 立即切换白名单 | 可用 | `router.ts:350-353,493-506`；默认 `defaults.ts:258`；场景 `immediate-switch-skips-the-retry-budget` |
| 4 | 截断续跑 | 可用 | `index.ts:599-634`、`state.ts:231-259`；场景 `truncated-output-continues-then-switches-candidate` |
| 5 | 候选预校验 | 可用 | `index.ts:396-419` 走 `resolveCallConfig`；三档 `precheck.ts:32-63` |
| 6 | 渠道健康与探测 | 有缺陷 | 被动折叠 `health.ts:183-286`、真探测 `probe.ts`、熔断 `breaker.ts:67-114` 均在；缺陷见 4.4、4.5、4.6 |
| 7 | 中文通知 | 有缺陷 | `notice.ts` 12 条构造器全中文、标签按 `SwitchOnCode` 联合键控；事实错误见 4.7 |
| 8 | Agent Fleet 右栏 | 覆盖不足 | 仅伪 DOM 组件调用 + 源码正则守卫；无真实浏览器/组合验证 |
| 9 | 委派名册与交接 | 不可用（opt-in 后崩） | 四动作、名册校验、预算闸均在；`newSession` 运行时抛 TypeError，见 3.3 |

主干结论：**失败切换、重试预算、截断续跑、按会话绑定四条的语义正确**，游标在两条 seam 上自洽，与 DSH 原生 `llm-retry` 不会重复重试同一条路由。

## 三、Critical

### 3.1 图片粘滞窗口永不归零

`index.ts:325` 在**每个 step** 调用 `setStickyTurns`，而 `state.ts:336-338` 的守卫是 `stickyRemaining === 0 && turns > 0`，不判断本轮是否带图。

`stickyTurns = 2` 且全程纯文本时的实际序列：T1 文本 → T2 `hasImages = true` → T3 归零后再次补满 → T4 起 `hasImages` 恒为真。后果是 `needs.images: false` 的文本候选被持续跳过、只带图的识图候选对所有文本请求变为可用，与该字段语义（`config.ts:133-134`：「带图轮**之后**……无图轮数」）相反。默认 `stickyTurns = 0`，故默认配置不触发。

现有测试为何不报：三处粘滞单测（`tests/unit.mjs:1360-1405`）只在序列开头调一次 `setStickyTurns`，与生产「每步一次」的时序不同；组合层的 `stickyTurns: 2` 场景（`tests/run.mjs:663`）是单轮任务，跨轮衰减在组合层不可触发。

修法方向：`stickyTurns` 在 `agent/pre-step` 写入，删除事后补写点。`chainForSession`（`chain.ts:362-379`）只需配置与会话绑定，pre-step 时可求值。

### 3.2 健康设置越界值导致保存永久失败且无原因

前端钳位与 host schema 各写一份边界，且浏览器校验不含 health：

- 前端只钳下限、无上限：`client/modals.ts:193,257`（`Math.max(0,…)`）、`:264,339,422`（`Math.max(1,…)`）；`NumberInput` 未传 `min`/`max`。
- host schema：周期 `0..86400`（`config.ts:170,185`）、探测超时 `2..60`（`config.ts:193`）、冷却 `1..86400`（`config.ts:207`）。
- 浏览器校验 `client/validate.ts:154-172` 只覆盖候选路由/重试次数与名册两个数值，health 无任何字段。

复现：把「单次探测超时」减到 1 → 保存被 host 拒绝 → `client/controller.ts:825-828` 丢弃拒绝原因 → `client/page.ts:119` 只显示「保存失败，请重试」→ 重复保存永远失败且不指向任何字段。

这一条与 `client/validate.ts:151-152` 自述的不变量正面冲突（「浏览器要在保存前挡住，否则用户吃到的是 host 的英文拒绝」）。

修法方向：health 的数值边界并入 `validate()`（新增 key + 中英文案），`min`/`max` 与钳位从 `defaults.ts` 同源常量派生；`save()` 把 host 拒绝原因带进 problems 列表。

### 3.3 交接 `newSession` / `finish + onFinish` 调用不存在的方法

`handoff-tool.ts:84-88` 为 `sessionController` 手写结构类型，声明 `createSession` / `selectionFor` / `selectForNextRequest`，并在 relay 中直接调用（`:420`、`:422`、`:427`）。

真实服务：注册键确为 `sessionController`（`dsh-api-session-controller/lib/index.js:2952` `super(ctx, "sessionController", …)`），其公开面只有 `create(request)` / `selectModel(request)`（同包 `lib/types/index.d.ts:101,107`）；那三个方法位于内部私有类 `ApiSessionAgentController`（`lib/types/agent.d.ts:130,136,142`）。因为 `index.ts:679` 是 `as` 强转，TypeScript 无法发现；`sessionController === undefined` 的优雅拒绝分支（`handoff-tool.ts:404-409`）也不会触发，服务确实存在 —— 结果为 `TypeError: controller.selectionFor is not a function`。

单元测试固化了这个错误契约：`tests/unit.mjs:3671-3674` 的假 faces 正好实现这三个不存在的方法，`:3708` 还断言其调用顺序。

影响面：`handoff.enabled` 默认 `false`、`onFinish` 默认 `[]`，仅 opt-in 用户命中；但四动作中的 `newSession` 完全不可用，而交接被列为已交付。

修法方向：改用 `create({cwd})` + `ctx.agents.get(sessionId)` + `selectModel(...)`（或投影读 + 新会话 `agent/request` 钉首跳），并重写那两条假 faces。

## 四、Important

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 4.1 | `always` 重试策略的加载期拒绝只遍历配置候选，第一跳（用户当前选中模型）漏检 | `index.ts:1074-1079` 只走 `chain.candidates`；第一跳在 `router.ts:112-117` 现造。rc.3 `dsh-llm-retry/lib/index.js:153` 对 `always` 无条件返回 retry | 选中模型位于 `always` 渠道时，未勾选码可无限重试 |
| 4.2 | 外部 host 变更静默覆盖未保存草稿 | `client/controller.ts:612-627` 只比较 host 新旧值，不比较 draft 是否脏 | 改了一半的链/名册被无提示替换，`failed` 同时被清成 false |
| 4.3 | 目录读取失败被渲染成「正在加载」 | `catalogFailed` 在 `client/controller.ts:379` 置位、`:301` 进 store，全项目零消费者；`client/modals.ts:505` 只按 `catalog === null` 判 loading | 添加候选弹窗永久转圈；失败后无法重试（`ensureCatalog` 幂等） |
| 4.4 | 探测缺 `Promise.race`，超时保证依赖适配器配合 | `probe.ts:108` 只把 signal 交给适配器；`deadline.ts:66-69` 明确记录「探测不 race」 | 适配器不响应 abort 时 `probeInFlight` 永不归零，`index.ts:934-939` 使定时探测永久静默停摆 |
| 4.5 | `health.passive` 无读者 | `config.ts:224` 声明、UI 可保存（`client/modals.ts:416`），但 `index.ts:214` 注册投影与 `client/controller.ts:535-556` 的 `loadPassive()` 都无条件执行 | 该开关关掉后没有任何效果 |
| 4.6 | `ACCOUNT_QUOTA` 在码表外 | 该码真实存在于 `dsh-llm/lib/index.js`、`dsh-llm-deepseek-account`；`defaults.ts` 中 0 次出现 | 经 `other` 归口；`classifyHealth` 判不出（`health.ts:103-113`），余额耗尽的渠道保持绿灯；白名单无法只勾「额度」；通知打印英文码 |
| 4.7 | 熔断通知承诺不存在的「自动重试」 | `notice.ts:216` 写「约 N 秒后自动重试」，实际语义是冷却到期后允许下一条进来的请求再试（`breaker.ts:99-104` + `index.ts:390-395`，`breaker.ts:11-15` 亦如此描述）；`tests/unit.mjs:614` 把错误文案钉住 | durable 通知进入模型上下文，模型读到的事实错误 |
| 4.8 | `maxDelegationsPerDay` 是空闸 | 全仓 6 处出现（schema/type/defaults/roster UI/validate），`handoff.ts` 内 0 处 | 设计承诺的「三尺度 + 每天」落空，UI 提供不生效的闸 |
| 4.9 | `reviewOverride` 短路 `handoffNote` 闸 | `handoff.ts:591-608` 提前 `return`，`:610-617` 的 note 闸被跳过 | `requireReviewFor` 与 `onFinish` 同时命中时，写 override 即可带空 note 开新会话 |
| 4.10 | `finish.report` 被静默丢弃 | schema 声明（`handoff-tool.ts:213`），运行时从未读取 `args.report` | 设计把 report 作为 `needs_user` 的核心载荷，实际不入账也不进简报 |
| 4.11 | `facts` 把「没有投影」报成 0 | `handoff-tool.ts:582-584`（同函数内 todos 正确返回 null） | 告诉模型「本会话没有派过」，与事实相反 |
| 4.12 | 条件跳过通知按整组集合去重 | `index.ts:424` 传 `conditionSkipKey(整组)`（`:998-1000`） | 同一轮内集合变化时全部条目重发为 durable `user/message`，重复进上下文、重复花钱；与同函数内逐路由去重的另两类跳过（`:429-443`）不一致 |
| 4.13 | 条件跳过文案先于事实 | `index.ts:424-428` 先发「已跳过 X」，`:444-453` 随后可能把请求发回 `resolved` | 被跳过的是第一跳时，通知与实际落点相反，违反 `:333-334` 自立的规矩 |
| 4.14 | 健康页「是否配置/第几位」只读当前编辑链 | `client/workspace.ts:146` 用 `draft.chain`；检查/探测走 `configuredRouteList`（全链，`routes.ts:74-78`） | 切链后同一渠道结论变化，可显示假的「未配置到降级链」；探测集合与显示集合不一致 |
| 4.15 | `switchOn` v2 迁移面过宽 | `chain.ts:162-164` 缺 `policyVersion` 时整表覆盖为默认全 true，而 `:152-157` 的理由只覆盖 `emptyResponse`/`invalidRequest` | 用户显式关掉的键（旧默认即 true，可区分）在升级首载被静默改回并落盘 |
| 4.16 | 交接无组合级覆盖 | `tests/run.mjs` 中 `handoff` 出现 0 次；仅有注册与两次拒绝（`tests/remote.mjs:276-310`）与手造 faces 单测 | 违反 AGENTS.md §6「必须以真实 Cordis Loader composition 验证」，3.3 正是这样存活的 |

## 五、Minor（按类归并）

### 5.1 第二事实源 / 重复实现

- 浏览器手写 `parseHandoff`（`client/fleet/model.ts:259-285`）是 host `projectionStateSchema`（`handoff.ts:147-154`）的第二份解读，且把缺失 `epoch` 兜底成 0。
- `statusTone`/`statusLabel` 在 `client/pipeline.ts:23-36` 与 `client/workspace.ts:55-68` 逐字重复。
- `chain.ts:184` 把 `continues` 上界写成字面量 `9`，同文件已 import `DEFAULT_MAX_TOKEN_CONTINUES`，而 `MAX_TOKEN_CONTINUES`（`defaults.ts:188`）是同一约束的正式常量。
- 旧字段迁移未按上界夹取：`chain.ts:212`（`firstHopMaxAttempts`）、`:222-223`（`maxAttempts`）绕过 `MAX_RETRIES`（`defaults.ts:49`）。
- `config.ts:251` 在描述串里手写「≤4000」，与 `defaults.ts:281` 的 `HANDOFF_INSTRUCTIONS_MAX` 重复。

### 5.2 流程与可复现性

- `npm test` 不构建，`lib/` 未跟踪，后三套件可能验证旧产物；建议 `pretest` 构建或断言产物 mtime ≥ 源码。
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
- `channelUsedInChain` 英文误译 `Chain #{n}`（`client/locales.ts:836`）；`healthProbePromptsHint` 英文把「留空的内容」写成 `Empty routes`（`:746`）。
- `problemBadMaxRetries` 等把 `0~99` 写进文案而非用 `{max}` 占位（`client/locales.ts:136,139,670,673`）。
- 同一状态两名：筛选「未调用」 vs 胶囊「待观测」。
- `client/chip.ts:283-284` 注释仍写「0..9 / 夹到 9」，实际上限为 99。
- 宿主通知印原始 `provider/model` 键，界面印目录名（`client/naming.ts`），同一对象两套称呼。

### 5.5 死代码 / 死键

- `allPhysicalRoutes`（`client/page.ts:75-83`）全仓仅 1 处出现。
- `openNotes`/`onOpenNotes` 不可达（`client/controller.ts:1162`、`client/apply.ts:222`）。
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

对应的三条改进判据：

- 组合套件不能是单轮任务（跨轮语义——粘滞、预算跨轮、绑定改写——在单轮场景里不可观测）。
- 手造 faces 必须与真实 `d.ts` 对账；可加一条把 fake 的属性集与真实服务公开面比对的测试。
- 「浏览器要在保存前挡住」这类不变量需要一条覆盖全部 schema 数值边界的测试，否则漏一整块没人发现。

## 七、本记录未覆盖

- 两份设计页与实现的偏差清单（页签计数、健康页 KPI 四格、白名单分区位置、删除确认弹窗、`styles.ts` 行数等）不在本页；记账口径见 [决策登记簿](open-questions.md) 十三节。
- client UI 与四套测试为分域审查结论，行级通读限于 host 主干；未对视觉/布局做真实浏览器复核。
