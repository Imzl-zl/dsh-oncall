---
title: "DSH 原生能力与架构设计：调研结论"
status: "research-conclusions"
kind: "review-conclusions"
last_updated: "2026-10-24"
---

# DSH 原生能力与架构设计：调研结论

本页是 2026-10-24 调研轮（不是实现轮）的产出：本页的前一版是**任务书**（5 组条目，每条写了
"我们现状 + 原生候选 + 要回答 + 判据"），本轮把每条的「要回答」换成了「结论 / 证据 / 建议」。
范围仍是**方法与机制的使用**与**架构设计**；图标、截图、静态资源、样式数值不在范围内。

判定标准（每条都按这三问裁，答案写在各条的「判据」里）：

1. 原生机制是否**语义相同**（不是"看起来像"）？冲突时以 DSH 源码为准。
2. 换过去是否**减少一处第二表达**（我们的实现是否可整段删除）？
3. 换的代价是**多一个 inject / 多一层耦合 / 失去一条我们独有的语义**吗？

证据约定：每条都给**双侧** `file:line`。DSH 侧两个来源——只读 checkout
`D:\sudy\github\deepseek-harness`（源码）与本仓库 `node_modules`（发布声明）；两者同一版本
（根 `@deepseek-ai/dsh` 0.2.1-rc.3）。本轮未重测基线（四套件 233/123/25/35、两份 tsc、bundle 465 kB
按任务书作为起点）。

## 结论摘要

- **A1 不换。** `SettingsFormModel` 的字段是**顶层标称字段**：specs 以字段名为键、edits 以
  `{op:'set', path:[field]}` 单段路径写入，`format`/`parse` 只在"一段文本 ↔ 一个值"之间转换
  （[form-model.ts:342-349](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/settings-form/form-model.ts)）。
  我们的草稿是嵌套数组（`chains[].candidates[]`、`roster[]` 的增删与重排），换成它只能把整段嵌套值
  JSON 化成文本暂存——比现状差。它能替的"暂存/脏/围栏"实测只有约 **93 行**，不是任务书说的 300+；
  而真正被替掉的 revision 围栏我们已经**就在用原生** `scope.mutate(ops, expectedRevision)`。
- **B1 不换，但要划一条线。** `sessionStats` 是**整会话口径**（turns/steps/llmMs/toolMs/ttftMs/
  decodeMs/decodeTokens，[types.d.ts:18-35](file:///D:/sudy/github/deepseek-harness/packages/session/session-stats/src/types.ts)），
  没有路由维度；渠道健康要的是"这条路由在本步里花了多久"，且必须含同一步内的失败切换与退避，
  两者不是同一个数。`fleet` 侧的 token/时长本来就读 DSH 的投影（`tokenUsage`/`subagentTiming`/
  `contextPressure`），没有自算。**结论：会话级总账读 `sessionStats`，路由级延迟/吞吐必须自算。**
- **B2 不换（换不了），但要抄走它的失效契约。** 想复用的类是 `ModelCatalogDirectory`，它**没有**
  从 `@deepseek-ai/dsh-client-ui-model-selection/client` 导出（[index.ts:33-37](file:///D:/sudy/github/deepseek-harness/packages/client/ui-model-selection/src/client/index.ts)
  只导出 `ModelDirectory`/`ModelDirectoryResolver`/类型）；能注入的 `ctx.modelDirectories` 是
  **按会话**的（`directoryFor(sessionId)`，[service.ts:66](file:///D:/sudy/github/deepseek-harness/packages/client/ui-model-selection/src/client/service.ts)），
  而我们的设置工作台没有会话。真正该抄的是它在四处事件上自动 `refresh()`
  （[service.ts:50-57](file:///D:/sudy/github/deepseek-harness/packages/client/ui-model-selection/src/client/service.ts)）。
- **C1 只有一处真的要改，任务书点的另两处证伪。** `pipeline.ts` 的 stepper **没有任何键盘处理器**
  （只有 `onClick`，`pipeline.ts:68/94`）；roster 的列表走位挂在 `role="listbox"` 容器上、行里没有输入框，
  输入法组合不进那里。真正会被抢的是 chip 的重试输入框——一个普通 `<input>` 上 `Enter` 直接提交
  （`chip.ts:458`）。

## 正确性优先：健康页「本步耗时」显示旧值（已定位，优先于本页其余各条）

**症状**（任务书 §四「剩余」）：跑完一轮真实对话后打开「渠道健康」，某路由仍显示旧
`本步耗时 4.51s` / `吞吐 48.1t/s`，同时写着 `近 4h 暂无观测`；刷新不变，也没有"读不到"警告。

**结论：不是投影没更新，是客户端合并时用"会话排序"代替了"观测时间排序"。** 已用真机数据复现：
探针对隔离 home（`%TEMP%\dsh-fleet-cap-22`，43 个会话）按页面同一套逻辑折一遍，得到
`wb/cn:deepseek-v4.1-flash latencyMs=4507 throughput=48.1`，与截图 `4.51s / 48.1t/s` 完全一致；
把排序键换成真实观测时间，同一批数据得到 `latencyMs=13947 throughput=26.5`（真正最新的观测）。
（探针是一次性脚本，放在 gitignore 的 `.sessions/`，取完数已删除；输出以本节引用为准。）

**链路三段，全部有据：**

1. `session.list` 给冷会话的 `updatedAt` 来自**持久化投影缓存**，会落后于日志：
   `updatedAt = max(createdAt, sessionListMetadata.lastPromptAt)`
   ([list.ts:349-351](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/list.ts))，
   冷行走 `cache.cachedSnapshot(header)`（[list.ts:291-312](file:///D:/sudy/github/deepseek-harness/packages/api/session-controller/src/list.ts)）。
   实测 `session-454c5777` 的缓存行写着 `lastPromptAt = 2026-10-23T13:51:19Z`，而它真实最后一次
   用户发言是 `15:10:56Z`（滞后 4777 s；43 个会话里 15 个滞后 > 1 min，最多 13.7 h）。
2. 我们按这个数排序、只取末 20 个，然后**让最后合进来的记录覆盖标量**：
   `readRecentSessions` 排序（`controller.ts:447-449`）+ `mergeHealthRecord` 的
   `Object.assign({}, newer, …)`（`controller.ts:386-401`）。
3. 于是"排序靠前但观测更晚"的会话输给"排序靠后但观测更早"的会话——13800 ms 的新观测被
   4507 ms 的旧观测盖掉。

**证据（我们侧）**：`packages/dsh-model-desk/src/client/controller.ts:440-477`（读取）、
`:386-401`（合并）、`:484-506`（折进 `ui.passive`）；`health-ui.ts:123`（页面读的正是
`record.latencyMs`，即被覆盖的那个标量）。

**修复（最小、可测、不进 D 组架构）**：`mergeHealthRecord` 改成**按 `lastCheckedAt` 取较新的那份标量**，
时间线仍取并集去重：

```text
newer.lastCheckedAt >= older.lastCheckedAt ? {...newer, timeline} : {...older, timeline}
```

删/改：`controller.ts:386-401` 的 `Object.assign({}, newer, …)` 一行语义（净增约 1 行）。用例：
喂两条会话记录、"新观测在前者、旧观测在后者"的**倒序**输入，断言标量取新观测——现有合并用例只覆盖
了正序，所以这条一直是绿的。

**另一件必须同时说清的事**：那一轮真实对话实际走的是 `deepseek-official/deepseek-flash`
（`session-0c97b3d7` 的 `request/header` 原文），**不是** `wb/cn:deepseek-v4.1-flash`。所以
`近 4h 暂无观测` 对那条路由是**真话**（该批数据里它最新的观测在 18 h 前），页面并没有撒谎；
错的只有那个"本步耗时"标量。这与 B1/B3 同源：同一个"读数键"（会话读取顺序）被用来表达两件事
（哪条会话最新 / 哪条观测最新）。

### 方案轮决定（2026-10-24）：合并期按记录自带观测时间选标量

**采用**：`mergeHealthRecord` 在合并两条记录时，按记录自身的 `lastCheckedAt` 决定标量（`status` /
`latencyMs` / `throughputTps` / 错误）取哪一份；时间线仍是"并集 → 按 `time:status` 去重 → 升序 →
`pruneTimeline`"，窗口规则不动。判据：`ChannelHealthRecord.lastCheckedAt` 必填（`src/health.ts:84`），
Host 每次观测都写（`src/health.ts:245`、`src/health.ts:268`）。

判据细节（防回归）：只有当**两份记录都写了** `lastCheckedAt` 时才重排；任一方缺失则退回调用方顺序
（即修复前行为）。理由是"未知不是 0，也不等于最新"——一个不声明观测时间的记录不构成排名证据。

**DSH 侧依据（同类功能的规则形状，不是类比）**：DSH 客户端判断"哪个投影写入更新"的唯一手段是记录
自带的水位，不看到达顺序——`packages/api/session-controller/src/client/sessions/projection-store.ts:1-11`
与 `:159-164`（`seq` 大的赢，`cached` 行无可比 seq、永远让给 sequenced）；同一个原则在两处独立出现：
`packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:218-224`（"两次读取可能
乱序落定，故只在它仍回答当前在位的 ref 时才发布"）与
`packages/client/shortcuts/src/persistence.ts:8-19`（单调 `sequence`，客户端丢弃乱序回包）。

**证伪（避免下一轮重复调研）**：

- DSH **没有**跨会话合并同类观测的规则，抄不到实现，只能抄规则形状。统计折叠一律单会话口径：
  `packages/session/session-stats/src/projection.ts:2-14`、
  `packages/client/ui-chat/src/client/chat/StatsPills.tsx:160-162`（`useProjection('sessionStats')`）、
  `packages/llm/token-meter/src/usage-projection.ts`。
- `src/client/fleet/model.ts:231-236` 的 `topLevelSessions` 同样按 `updatedAt` 排序，但那是**显示顺序**
  且**无窗口**（全仓唯一截断是 `agents.slice(0, 8)`）。它不参与观测合并，两条规则回答两个问题，
  不合并成一处。

**被否的两个备选**：

1. *按每条会话 health 的 `lastCheckedAt` 给 `readRecentSessions` 排序*。那会把"哪条观测最新"塞进一次
   **共用读取**（failover 抽屉读同一次，`src/client/controller.ts:908`），让一个读数同时回答两个问题
   ——即本条病根换个位置。
2. *整记录覆盖、最后写入者赢*。已否（
   [2026-10-15-health-monitoring-cross-session-merge](../../.agents/notes/implemented/2026-10-15-health-monitoring-cross-session-merge.md)）：
   可用率会退化成"赢家会话"的一条数据，而渠道健康是全局事实。

**删除清单**（行号为 2026-10-24 核对值）：`src/client/controller.ts:401` 的
`Object.assign({}, newer, { timeline: … })` 语义（"合进来较晚者赢"，1 行）；`src/client/controller.ts:376`
注释"调用方保证 older 来自较旧的会话"（该断言不成立，是 bug 成因，随方法文档重写）。

**改动清单**：`src/client/controller.ts:372-385` 重写方法文档 + `:386-402` 新增 `observationTime(record)`
与选主逻辑（净约 +10 / −2）；`tests/client-controller.mjs` 在 `:780` 后新增一条倒序输入用例
（观测更新的会话 `updatedAt` 更小、排在前、后合并；断言 `latencyMs` / `status` / `lastCheckedAt` 取新观测，
时间线仍是并集）。变红方式：把选主退回 `Object.assign({}, newer, …)`，该用例必须失败。
标量读者不变（`src/client/format.ts:130`、`src/client/workspace.ts:287`；`src/client/health-ui.ts:123` 不动）。

### 后续独立缺陷（方案已定，单开一条）：我们自造的 20 会话窗口

`src/client/controller.ts:447-449` 先按 `updatedAt` 升序再 `.slice(-20)`，而该键是
`max(createdAt, lastPromptAt)`（`packages/api/session-controller/src/list.ts:349-350`），冷会话那份来自会
滞后的持久化投影缓存（`packages/api/session-controller/src/list.ts:291-312`）——窗口成员按一个最多滞后
13.7 h 的键挑，实测 home 43 会话中 15 个滞后 > 1 min。根因不是排序键，而是**窗口本身是 DSH 没有的**：
`packages/api/session-controller/src/list.ts:132-165` 返回全部会话、已按 `updatedAt` 降序，且每条内联带
`projections`（`SessionSummary.projections?: SessionProjectionHints`，checkout `types.ts:190`；声明
`types.d.ts:172`、`SessionListValue` `:271-273`；`hintsOf` `:321-328`）。两个投影键都注册了 `wire`
（`src/health.ts:282-285`、`src/lineage.ts:173-176`），那些值已在 list 返回值里，现在又用 20 次
`session.projections()` 逐条重取。

**决定**：走方案 A 单开一条——`readRecentSessions` 改成对 `items` 的一次纯折叠，读内联 `projections`、
去掉 `.slice(-20)`；健康按观测时间折全部会话，failover 抽屉按条目自身 `at` 落窗口。代价：约 40–60 行
（含 `total` 与部分失败措辞的语义变化）+ 3–4 条用例 + 抽屉自己的时间窗口。被否：B（保留 RPC、只用内联
`lastCheckedAt` 挑窗口，同一份数据读两遍，是新的第二表达式）；C（不动，43 会话时会漏掉最新观测）。

---

## A 组：表单与保存机制

### A1 `SettingsFormModel` 能否替掉 controller 的保存/暂存半区 → **不换**

**原生契约（实测）**

- 构造：`new SettingsFormModel(scope, specs, secrets)`，`scope` 要有
  `getSnapshot/subscribe/mutate(ops, expectedRevision)`
  ([form-model.ts:40-70,195-218](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/settings-form/form-model.ts))。
  我们的 `ctx.configForms.get(CONFIG_NS)` 结构上就满足
  （[config-form-types.ts:36-55](file:///D:/sudy/github/deepseek-harness/packages/client/ui-settings/src/client/config-form-types.ts)），
  所以**"能不能接"不是问题，"能不能表达"才是**。
- 表达力上限：`specs` 以**字段名**为键（`Map<string, SettingsFieldSpec>`，form-model.ts:196）；
  `plan()` 只产出 `path: [field]` 的**单段**路径（form-model.ts:342/348/349）；`format/parse` 是
  "一段文本 ↔ 一个值"（form-model.ts:100-114）。**没有数组、没有多段路径、没有"一次写整段嵌套对象"
  的字段 spec**（唯一的整值通道是 `SettingsSecretSpec.write`，且必须空白起步）。
- 它有的两件事我们的确没有：`overridden`（用户层是否有该键，form-model.ts:385-388）与
  `invalid` **阻塞保存而非丢值**（form-model.ts:262-267,302-303）。

**我们现状**：`draft`/`host` 双份 + `deepEqual` 脏检测 + 订阅重播种 + 一次 `mutate` 多路径写。
`seed()`（controller.ts:175-192）、`host`/`draft`（:193-194）、`project()` 里的 `dirty`
（:262-280）、scope 订阅（:563-578）、`discard`（:744-750）、`save`（:751-781）。
revision 围栏**已经**是原生的：`scope.mutate(…, scope.getSnapshot().revision)`（:759-772）。

**判据**

1. 语义等价？**否。** 我们的草稿是嵌套数组：`chains[]` 增删改名（controller.ts:629-668）、
   `candidates[]` 增删重排（:783-801）、`roster[]` 增删（:693-726）。用模型表达只能给
   `'chains'`/`'handoff'` 各配一个 `format: JSON.stringify / parse: JSON.parse` 的字段 spec——
   脏检测退化成文本比较、逐字段 `invalid` 全部失效，比现状差。
2. 减少第二表达？**部分。** 真能删的是"暂存/脏/围栏"三件事，实测 **约 93 行**
   （175-194 共 20 行；262-280 的 available/dirty 19 行；563-578 共 16 行；744-781 共 38 行），
   **不是 300+ 行**——那 300 里的大部分是逐字段 mutator（`setEnabled`/`addChain`/`renameChain`/
   `setWeight`…），原生模型并不能表达它们。任务书这一条的收益估计需要修正。
3. 代价？多一层"两套机制拼起来"的复杂度，并失去我们独有的：一次 `mutate` 写 7 条路径的**原子保存**
   （含 `unset ['chain']` 的迁移与 `policyVersion` 版本标记，controller.ts:760-771）、
   跨字段校验的**全部**问题一起上屏（`validate.ts:137-174`）、`failed` 与 saving 的自有收尾
   （:757-780）。

**建议**：不换。若要吸收它的两个长处，取"语义"不取"模型"：
`overridden` 我们不需要（没有逐字段覆盖层，见 A3）；`invalid` 阻塞保存我们**已有**等价物
（`validate()` 非空则 `save()` 直接返回，controller.ts:753）。

### A2 数值输入的解析与夹取 → **不换；候选件是另一回事**

**原生契约**：`settingsNumberField(field)` 返回的是**字段 spec**（`format`/`parse`），不是受控输入；
`parse` 对非有限数返回 `undefined`，按模型语义是**阻塞保存**（form-model.ts:156-169,262-267），
**它不夹取、不取整、不设上下限**。DSH 自己的原则写在控件注释里：
"which drafts a field accepts is decided by its spec, so the control never silently rewrites what the
user typed"（[fields.d.ts:36-39](../../packages/dsh-model-desk/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/settings-form/fields.d.ts)）。

**我们现状**：夹取语义与它**不同且是有意的**——非有限数忽略、负数夹 0、四舍五入、
再按字段上限夹（`roster.ts:85-89`、`controller.ts:810/832/843-850/878`、
`pipeline.ts:80-95/180/271`、`modals.ts:68-71` 交给调用方夹 `:193/257/264/339/422`）。

**判据**：语义等价？否——换过去是**行为变更**（静默夹取 → 拒绝保存），不是重构。减少第二表达？
否——`settingsNumberField` 只能替"解析结果类型"，夹取那半还得我们自己写，换完是两套拼接。
代价：与 A1 同进退（它是 form model 的 spec 工厂），A1 不换则它就是死件。

**建议**：不换。真问题是**样板散在多处**（这是 D3 的题目，不是原生能力的题目；D3 实测"17"
只是 `Number.isFinite` 的出现次数，真样板 18 行）。D3 给的做法是收一个本地
`parseIntText(text, {min, max})` + 一个受控 `NumberField`，纯本地、可测、不动语义。

### A3 上一轮否决理由是否需要复核 → **不需要，理由未被 A1 推翻**

- 原否决理由："契约是设置覆盖层（`overridden`/`resetLabel`/`onReset`），我们的页面没有逐字段覆盖层"。
- A1 不采纳原生模型 ⇒ `overridden` 依然**没有**真实来源：我们的 `scope` 有 `user` 层，
  但页面按"整段草稿 + 一次 mutate"保存，没有"这一字段是否被覆盖/要不要 reset"这个概念。
  传 `overridden: false` 与空 `onReset` 仍然是给页面没有的能力立假 prop。
- 结论：**维持否决**。唯一解锁条件仍然是"整页改成逐字段覆盖层编辑"，那是一次产品改版而不是换控件。

### A4（新增候选）`client/validate.ts` 的 `normalize*` 是 schema 默认值的第二表达式

任务书没列，但它就是本页要找的那种"第二表达"，且与 A1 同区。

**事实（双侧）**

- host schema 为每个字段声明默认值：`config.ts:84-349` 共 89 处 `.default(...)`，值来自 `defaults.ts`
  （单源，好）。
- 设置通道把**已解析**的值发给浏览器，并把 `Volatile` 递归摊平：
  `settings/src/index.ts:319`（`projectForm(form, plainConfig(entry.fiber.config))`）
  + `plainConfig` 递归 `value.get()`（[schema.ts:10-17](file:///D:/sudy/github/deepseek-harness/packages/settings/settings/src/schema.ts)）。
  实测（`node --experimental-strip-types` 直接跑 `src/config.ts` 的 `Config`）：
  `Config({})` 的 `handoff` 已是
  `{enabled:false, subagentBackend:"spawn", roster:[], protocol:{…}, limits:{maxDelegationsPerTurn:1,
  maxDelegationsPerUserMessage:8, maxReviewsPerUserMessage:1, maxNewSessionsPerUserMessage:2,
  maxDelegationsPerDay:24, nudgeWhenUnreceipted:false, maxNudgesPerTurn:1}, onUnreceiptedStop:{…},
  newSession:{onFinish:[], nextAction:"continue", briefing:[…5 项], keepGoal:true, …}}`，
  `health` 同理带 `discover/probe/breaker/timelineBucketSeconds` 全部字段。
- 于是浏览器拿到的 `value` 已经是"默认值补齐后的当前形状"，而 `client/validate.ts` 又用
  **另一套结构**把每个字段的默认值再走一遍：`normalizeChain`（:71-97）、`normalizeNamedChain`
  （:100-107）、`normalizeHandoff`（:185-226）、`normalizeRosterEntry`（:233-250）、
  `normalizeHealth`（:253-297），合计约 **150 行**，字段清单与 `config.ts` 一一对应。

**这条不是纯重复，别一刀切删**（我原本以为是死代码，实测否掉了）：

- `schemastery` 的 object 是 **loose** 的：`healthSchema({intervalMinutes: 60, passive: false})`
  解析结果是 `{passive:false, …, intervalMinutes:60}`——**未知的历史键会留下来**。所以
  `normalizeHealth:258-265` 那段"旧字段是分钟"的迁移是**活的**，删不得。
- `value === undefined`（首次接受前）时也需要一份默认草稿。

**结论**：核心默认值那半是第二表达（可逐步收），迁移那半不是（必须留）。
**建议**：不删代码，先**上闸门**——在 `tests/unit.mjs` 加一条不变式用例：
`normalizeHandoff({})` 与 `normalizeHealth({})` 的**键集与值**必须等于 `Config({})` 解析出的对应节，
`normalizeChain(defaultChainValue())` 等于 `Config({}).chains[0]` 的缺省形状。
这样"schema 加了字段、validate 忘了补"会变红，而不需要现在就重写那 150 行。
（如果想更狠：把 `seed()` 改成 `value ?? defaults` 并只保留迁移分支，那是实现轮的事，需要用户批。）

---

## B 组：数据与投影

### B1 `sessionStats` 投影 vs 自算统计 → **不换，写清分界**

**原生事实**：`sessionStats` 注册了 `wire` 视图（[projection.d.ts:105-125](../../node_modules/@deepseek-ai/dsh-session-stats/lib/types/projection.d.ts)），
浏览器可读；字段是整日志口径的 turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens
（`types.d.ts:18-35`）。**没有任何 per-provider/per-model 维度**——它就是"这个会话总共花了多少模型时间"。

**我们现状（分类）**

| 数字 | 位置 | 能不能读 `sessionStats` |
|---|---|---|
| 路由的"本步耗时" | `health.ts:123-132`（`elapsedSince`，`step/start` 锚点、`request/header` 重锚、按 (turn,step) 门控） | **不能**。会话级 `llmMs` 不含路由维度，也不含同一步内失败切换前的耗时；我们的数**故意**含退避（health.ts:64-72 注释） |
| 路由吞吐 | `health.ts:256-259` | **不能**，且与 `decodeMs/decodeTokens` 是**两个不同的数**（我们含首字等待，字段名与注释都写明了） |
| 会话 token 总量 | `fleet/model.ts:667-673`（`totalTokens` 四个桶求和） | 不能——`sessionStats` 只有 `decodeTokens`（输出 token 且只覆盖有 usage 的步），没有输入/缓存桶 |
| 子智能体时长/状态 | `fleet/model.ts:576-580`（`settledMs + active`） | 已在读 DSH 投影 `subagentTiming`（[projection.ts:68-115](file:///D:/sudy/github/deepseek-harness/packages/subagent/subagent/src/projection.ts)），是我们自算的只有"加和"一步 |

**判据**：语义等价？**否**（会话口径 vs 路由口径；模型时间 vs 含切换成本的本步成本）。
减少第二表达？**否**——两类数字我们只各算一次。代价：换过来会**失去**"失败切换后仍是同一步、
但不同路由"这条归因，那正是本插件的存在理由。

**建议**：不换。分界线写死为：**会话级总账（turns/steps/llmMs/ttft/decode）读 `sessionStats`，
现在没人读是因为我们没有"会话总账"这个界面元素；路由级延迟与吞吐自算，且不与前者混合显示。**
顺带把 `health.ts:66-72` 那条注释升级成"为什么不合并"，避免下一轮再问。

### B2 `ModelCatalogDirectory` vs `remote.session.modelCatalog()` + `routeNames` → **不换；抄失效契约**

**原生事实**

- 类：`ModelCatalogDirectory`（[catalog.ts:15-107](file:///D:/sudy/github/deepseek-harness/packages/client/ui-model-selection/src/client/catalog.ts)），
  `load()` 共享一次在飞请求、按"Host generation"缓存，`refresh()`/`resetGeneration()` 失效重读。
- 暴露方式：**不导出**（client/index.ts:33-37 只导出 `ModelDirectory`、`ModelDirectoryResolver`、类型）。
  可注入的是 `ctx.modelDirectories`，其 `directoryFor(sessionId)` 是**按会话**的目录
  （service.ts:66-90），且对子智能体会话直接抛（directory.ts:151-155）。
- 自动失效：`modelDirectories` 服务在 `connection/reset`、`llm/adapters-updated`、
  `settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`
  上刷新目录（service.ts:50-57）。

**我们现状**：`ensureCatalog()` 每次激活**读一次**并缓存（controller.ts:346-369），
命名回落是自己的一套（`naming.ts:69-113`：`group.name`/`model.name`，缺名回落原始 id，
`Provider · Model` 拼接，`title` 保留原始 key）。

**判据**

1. 语义等价？**否**。它的 store 是**每会话**目录（含 `current`/`routable`/`pending` 与选择提交），
   我们的设置工作台是**无会话的主面板**；为拿一个"全局目录"去 `directoryFor(sessionId)` 等于
   自己造一个假会话 id，比现状糟。命名语义也不同：它给的是"目录行怎么显示"，我们要的是
   "任意 `provider/model` 字符串怎么显示（可能不在目录里）"。
2. 减少第二表达？只减少"读一次"这一行（`controller.ts:358`），命名实现（114 行）仍要留。
3. 代价：多一个 `modelDirectories` inject + 一层"必须有会话"的耦合，换不回等价行为。

**建议**：不换。**但要抄它的失效契约**：我们缺的是"用户刚在 DSH 的模型页加了模型，
我们的候选选择器还是旧目录"。最小改法：在 `registerUi` 里订阅同样那几个事件、调
`controller.refreshCatalog()`（新增，语义等同它的 `refresh()`）。代价是要引入一次 type-only 导入
拿到 `$on` 的键面（`@deepseek-ai/dsh-api-remotes/types`，DSH 自己在
[config-form.ts:12-27](file:///D:/sudy/github/deepseek-harness/packages/client/ui-settings/src/client/config-form.ts) 就是这么做的）。
这不是"换原生件"，是"补一条我们漏掉的失效语义"，建议进实现轮。

### B3 会话状态读取方式 → **就是原生读法，不改**

**原生事实**：`useSessionStatus` 是 `ui-session` 提供的**槽位标准 hook**
（[ui-session/src/client/index.ts:160](file:///D:/sudy/github/deepseek-harness/packages/client/ui-session/src/client/index.ts)），
DSH 自己所有列表/标题/对话面板都通过它读同一份 store。

**我们现状**：`fleet/useFleet.ts:35` 声明、`:84` 调用（`props.useSessionStatus(state => state)`）；
会话列表读 `ctx.sessions.list`（`useSessions`，同文件 `:83`），投影读
`list.projectionsBySession[sessionId]`（`fleet/model.ts:238-242`），刷新走
`controller.refreshSessions()/loadSession()`（`useFleet.ts:111-128,193-206`）。

**判据**：语义等价？**是**——这就是原生读法，没有绕过订阅，也没有自己轮询状态。
已知边界（不是缺陷，已在 `useFleet.ts:159-170` 写明并有据）：`SessionListState` 不带错误字段，
失败只能靠 `phase === 'pending'` 表达，首次成功前与"空列表"必须靠我们自己区分。

**建议**：不改。B3 的任务是用证据确认"没绕路"，确认完毕。

---

## C 组：交互机制

### C1 IME 组合输入 → **只换一处（chip 重试输入框）；任务书点的另两处证伪**

**原生契约**：`observeComposition(document)` 返回 `{ guards(event), dispose() }`
（[keyboard-composition.ts:8-35](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/keyboard-composition.ts)）：
`guards` 在**组合中 / 刚结束（`ended` 闩）/ `isComposing` / `keyCode === 229`** 时返回 true，并消费 `ended`；
它**不看 `event.key`**，也不是 hook——它按 `document` 挂 capture 监听，所以要按组件实例建一次并 dispose。
原生同构先例正是"输入框 Enter 提交"：`ModelSelect.tsx:303-304`
（`if (event.nativeEvent.isComposing) return`）与 `QuestionComposer.tsx:64-68,413-417`。

**我们现状（逐处判定）**

| 处理器 | 位置 | 会被输入法抢吗 | 判定 |
|---|---|---|---|
| chip 重试输入框 `Enter → commitRetry` | `chip.ts:447-459`（`onKeyDown` 在 :458） | **会**。这是全仓唯一"文本输入框 Enter 直接提交" | **必须加守卫** |
| roster 列表走位（Arrow/Home/End） | `roster.ts:201-213`，挂载在 `:307` | 不会。listbox 直接子节点只有 `div[role=option]` + span（:308-331），编辑器是**兄弟节点**（:332-333），焦点在列表内时没有组合宿主 | 不改 |
| roster 行 `Enter/Space → onSelect` | `roster.ts:319-324` | 不会（同上，行里没有输入框；组合期按键也进不到这里） | 不改（加守卫无害，但不算修复） |
| pipeline stepper `Enter/方向键` | `pipeline.ts:54-96` | **前提不成立**：整个文件没有任何 `keydown` 处理器；stepper 只有两个 `button onClick`（:68/:94）+ 受控 `input onChange`（:80-86） | 不改 |

**可复现场景**（chip）：打开 chip 弹层 → 焦点进重试输入框 → 中文输入法打拼音（`chip.ts:456` 每键把
拼音串写进 `retryDraft`）→ 按 Enter 选词。这个 keydown 的 `key` 就是 `Enter`，于是 `:458` 调
`commitRetry`：数字则把**未确认**的值写成覆盖，非数字则弹层红字 `sessionRetryInvalid`（`validate.ts:116-122`）；
紧接着 `onBlur`（:457）再提交一次。

**建议**：换（这一处）。代价：一个 `useEffect` + 一个 ref，约 10 行；**不加 inject**（`ui-primitives` 已在
`index.ts:38` 导出）。删除清单：无（纯增）。**注意同一段还有个既有缺陷要先修**——
`chip.ts:393-397` 的窗口捕获**不看组合态**：弹层开着时在输入框里按 Escape 取消输入法也会把
`cancelled` 置真，而 `Menu.tsx:334` 会因 `guards` 直接 return（Escape 不关），标志残留到下一次
"点外部"关闭时生效——那条路径就会静默丢掉用户刚输入的重试次数（`:486-491` 走 `close` 而不是 `dismiss`）。
所以 C1 的守卫要**同时**加到那段捕获上：组合中的 Escape 不置位。

### C2 关闭与模态层级 → **不换**

**原生事实（逐个候选）**

- `Menu.onClose` 的契约只有三种触发——**外部点击 / Escape / 焦点移进 iframe 的 window blur**，
  且**没有原因参数**（[Menu.d.ts:134-135](../../packages/dsh-model-desk/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/Menu.d.ts)）。
  普通窗口失焦**不**关闭（`Menu.tsx:405-411` 只在 `document.activeElement` 是 iframe 时 `onClose`）——
  也就是说我们 `chip.ts:389/484` 注释里的"窗口失焦"其实是"焦点进了 iframe"这一种。
- 时序：Menu 的 Escape 监听在 **document capture**（`Menu.tsx:416`），普通 keydown 在 bubble（:415），
  外点 `pointerdown` 在 bubble（:412）。事件路径是 window → document ⇒ 我们的 **window capture
  （`chip.ts:398`）必先于** Menu 的 document capture，这段时序依赖是成立的，不是巧合。
- `useModalLayer` 的层栈**只由 `useModalLayer` 自己写**（`useModalLayer.ts:58`），`Menu` 从不注册层、
  只读别人的（`Menu.tsx:334` 的 `isBehindModal`）⇒ 对我们的 chip 根节点恒为 false，既保护不了也区分不了。
- `closeTopModal` 只调栈顶 layer 的 `onClose`（`useModalLayer.ts:17-22`），同样无原因、无返回值。
- `useDismissOnOutsidePointer` 只有 `pointerdown`（:16-33），无键盘、无原因。

**判据**：语义相同？**否**——原语明确表示"关闭原因"不是它能表达的维度，而我们的 `onClose` 必须二选一
（Escape 取消、不写；外点按失焦处理、先落盘 `chip.ts:486-491`）。强换成原语只能删掉 `chip.ts:392-400`
这 8 行捕获，却要自造一个等价的"刚才那次 Escape 算谁的"探测，净增复杂度，并且会**失去**
`dismiss()`（`chip.ts:306-318`：写失败时不关闭、原地留错）的唯一触发点。
**建议**：不换。改动清单：无（保留 window capture），但把 `chip.ts:389/484` 两句注释里的
"窗口失焦"改成"焦点移进 iframe"，并在 capture 里加一句 `isBehindModal` 守卫（一行，可选）。

**C2 附带发现（真缺陷，建议进实现轮）**：`modals.ts` 的四个 `Modal`
（`:402`、`:478`、`:585`、`:649`）**都没传 `shortcutModal`**。缺省时
`data-shortcut-modal` 为空 ⇒ 快捷键上下文把模态记成 `'other'`
（`shortcuts/src/client/dom.ts:76`）⇒ `registry.ts:169-171` 挡掉一切 `modals` 不含 `'other'` 的命令。
我们的保存命令声明的是 `modals: ['model-desk']`（`apply.ts:172`），于是
**Ctrl+S 在我们自己的对话框里按不动**，而 `apply.ts:149-153` 的注释与事实相反。
修法：四处各补 `shortcutModal: 'model-desk'`，并补一条"对话框内保存生效"的用例。

### C3 焦点与跳转 → **不跟进**

**我们现状**：健康页跳转只滚不聚焦——`workspace.ts:110-116`（`scrollIntoView({behavior:'smooth', block:'center'})`），
目标是 `li` 且不加 `tabIndex`（`workspace.ts:290/300-304` 只加高亮类）；触发点在
`page.ts:64-69` + `pipeline.ts:243-248`（`at` 参数让同一行可重复触发）。

**原生先例**：DSH 同类"跳到某一行"**全部只滚不聚焦**——
`ui-plugin-manager/PluginManagerPage.tsx:1526-1532`（1524 行注释明说"highlight without changing the user's page"）、
`ui-trajectory/TrajectoryTable.tsx:2474-2476` 与 `2503-2510`、`ui-workspace/rows/Rows.tsx:581-585`。
`focusWithoutRing` 的全部调用点都是"自动进入 / 归还焦点"
（`useModalLayer.ts:61/93`、`Menu.tsx:215/316`、`shortcut Editor.tsx:156` 等），**无一处用于数据行**。
（检索范围：`packages/client/**` 全量 `scrollIntoView` 与 `focusWithoutRing`，二者从不同处出现；
"跳到某一行并聚焦"的先例**未找到**。）

**判据**：我们与原生先例逐项同构。加聚焦会改 Tab 序（`li` 变可聚焦）、抢走触发按钮的焦点、
并与 `focusWithoutRing` 的"自动聚焦不画环、键盘导航恢复环"机制重复造一套。
**建议**：不跟进，维持"只滚不聚焦"。删除清单：无。

### C4 快捷键可见性 → **不自己画；命令已自动出现在原生参考页**

**原生事实（证据链）**：`ctx.shortcuts.register` 的行会进 catalog
（`shortcuts/src/client/registry.ts:84-133`，`presentBinding` 给出当前 `keys`）→
`ui-shortcuts` 把它注册进设置页（`ui-shortcuts/src/client/index.ts:40-45` 的 `settings.general.item`，
hooks 注入 `catalog`）→ 快捷键对话框把**全部**命令按 `group === 'application'` 渲染
（`Reference.tsx:78,136-141,181-203`），每行的键帽就是 `ShortcutKeys keys={row.keys}`
（`Reference.tsx:197`，组件本体 `ShortcutKeys.tsx:10-12` 只渲染"有效键标签"）。
即：**我们已经注册的命令，连同用户自己改过的绑定，已经出现在那个页面上**，零成本。

**我们现状**：`apply.ts:154-176` 注册的是可编辑命令（`modals`/`regions`/默认绑定齐全）；
另有一套**死代码**在算键帽：`format.ts:62-69`（`isMacPlatform`/`saveShortcutKeyKey`）+
`locales.ts:193-194` 与 `:729-730`（`⌘S` / `Ctrl+S`），`src/` 内**零消费者**，只有
`tests/unit.mjs:38,1986-1988` 读它。写死键帽的本质是"平台猜测 + 注册时的绑定快照"，
用户一改绑定它就错。

**判据**：不该自己画（原生页已是单源）。**删除清单**：`format.ts:61-69`（9 行）、
`locales.ts:193-194`（2 行）与 `:729-730`（2 行）、`tests/unit.mjs:1986-1988`（3 行 + :38 的导入项），
共约 16 行，**零行为变化**。
**就地提示（可选）**：若要保存按钮自己显示当前绑定，原生姿势是
`Tooltip shortcutKeys={…}`（`Tooltip.tsx:38/218/221`，DSH 广泛用在 chrome 按钮上，如
`ui-sidebar/HeaderLeadingControls.tsx:31/42`），绑定从 `hooks` 注入的 catalog 取
（`ui-slots/src/index.ts:559-573` ⇒ 只需在 `apply.ts:239` 已有的 `hooks` 里加一项，**不是新 inject**）。
**前提**：先修 C2 的 `shortcutModal` 缺失，否则"有提示但按不动"更糟。

## D 组：架构卫生

### D1 校验归属 → **三段分工成立，保持不变**

**现状（三段，各有其责）**

| 段 | 位置 | 负责 | 违反时 |
|---|---|---|---|
| schema 边界 | `config.ts:84-349`（`.min/.max/.step`，值来自 `defaults.ts`） | 单字段值域、类型 | host 在校验期拒绝（英文） |
| 跨字段规则 | `rules.ts:53-221`（14 条 `problem*`，唯一表达式） | 链 id 唯一、链内路由唯一、权重、默认链存在、名册 id/用途/半条路由… | host 抛**第一条**；浏览器收**全部**（`validate.ts:143-150`） |
| 草稿态边界 | `client/validate.ts:137-174`（5 条 `problem*`） | `problemEmptyRoute`、`problemBadMaxRetries`、`problemBadFirstHopRetries`、`problemRosterBadRuns`、`problemRosterBadTokens` | 浏览器保存前挡住，不让用户吃英文 |

**有没有两套实现？没有。** `rules.ts` 的 14 个 key 与 `validate.ts` 的 5 个 key **零重叠**；
`config.ts:48` 与 `validate.ts:32` 都从 `rules.ts` 取 `structuralViolations`，是**同一个函数两个消费者**。

**要回答的第二个问题（若 A1 采纳，草稿态边界会不会被原生覆盖）**：
`SettingsFormModel` 的 `invalid` 只来自**逐字段 `parse` 返回 `undefined`**
（[form-model.ts:262-267,341-349](file:///D:/sudy/github/deepseek-harness/packages/client/ui-primitives/src/settings-form/form-model.ts)），
`SettingsFormShell.invalid` 是"任一 spec 的 parse 失败"（:242）。**它没有任何跨字段能力**——不能表达
"`defaultChainId` 必须存在于 `chains`"、"链内路由不得重复"、"名册 id 不得重复"。
所以即便 A1 采纳，`validate.ts` 那 5 条与 `rules.ts` 那 14 条也一条都删不掉。

**两处值得记住的细节**

- `assertStructural` 只取第一条并抛出（`config.ts:622-630`），两个调用点是加载期 `index.ts:184` 与
  热更新瀑布 `index.ts:190-198`；浏览器侧两个调用点是 `controller.ts:264`（进 `problems`）与
  `:753`（保存闸）。五个点，一条规则。
- **有一处分类不纯**：`instructions` 的长度上限
  （`rules.ts:184` 的 `problemRosterInstructionsTooLong`）是**单字段边界**，却只能放在 rules，
  因为 host schema 没声明 max（`config.ts:250-251` 只在描述里写了 ≤ 4000）。它和
  "跨字段只在 rules.ts"这条约定字面冲突，是规则自身的例外。

**结论**：三段分工成立，且**与 A1 的决定无关**（A1 已判不换）。唯一的"第二表达"是**单字段值域**
两处比较式（schema 的 `.min/.max` ↔ `validate.ts:156-170`）：候选非空、`maxRetries`、
`firstHopMaxRetries`、名册 `maxRunsPerUserMessage`、名册 `maxTokens`。这是设计内的双检
（host 的拒绝是英文且发生在保存之后，浏览器必须提前挡），常量同源 `defaults.ts`，**不是漂移源**。
**建议**：不改，只做两条文字约定：(1) 跨字段只在 `rules.ts`、单字段只在 schema、草稿边界只在
`validate.ts`、`assertStructural` 只渲染不枚举规则；(2) 把 `instructions` 那条标注成
"单字段但 schema 无表达"的例外，否则约定自身不精确。

### D2 客户端程序的依赖边界 → **边界成立；zod 只作为外部 `require` 进来；补一条闸门**

**待核实问题的答案（实测，不是推断）**

1. `controller.ts:14` 与 `roster.ts:38` 对 `../config.ts` 的 `import type` **不会**把 schemastery/zod
   拉进浏览器半包：`lib/client.js` 的模块 region 清单里**没有** `src/config.ts`（只有
   `src/chain.ts`、`src/defaults.ts`、`src/routes.ts`、`src/rules.ts`、`src/handoff-wire.ts`、
   `src/release.generated.ts` 与 `src/client/**`），全文件里 `schemastery` 只出现 **1 次且在注释里**。
2. 但它**会**把这些宿主模块纳入客户端**类型程序**：`npx tsc -p tsconfig.client.json --listFiles` 的
   仓库内文件包含 `src/config.ts`、`src/types.ts`、`src/chain.ts`、`src/rules.ts`、`src/defaults.ts`、
   `src/routes.ts`、`src/timeline.ts`、`src/handoff-wire.ts`、`src/release.generated.ts`。
   即：**类型导入不产生运行时代码，但会让宿主模块在 DOM lib 下被检查一遍**。今天是干净的
   （这些模块不碰 `Context`、不 import `node:`），代价是它们今后任何类型错误都会以"客户端 tsc 红"的形式出现。
3. `lib/client.js` 的全部外部依赖只有四个：
   `react`、`zod`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`（465163 字节）。
   **zod 的来路是生成的 Remote 客户端**——`lib/typert.remote-client.js:2` 就 `import { z } from 'zod'`，
   它被 inline 进 `lib/client.js`，于是顶层出现 `require("zod")`。这是 DSH 自己"有 Remote 的插件"的
   通用形态（同 `ui-model-selection` 的 catalog 校验），不是我们漏掉的边界。
   手写半包仍然干净：`handoff-wire.ts` 挡 zod 的设计有效（本文件 region 内无 zod）。

**判据**：`lib/client.js` 里没有 schemastery、没有任何宿主实现。**边界成立**。

**建议（闸门，低成本）**：加一条断言 `lib/client.js` 的 `require(...)` 集合恰为那四个模块名、
且内容不含 `schemastery`/`defineDomain`。这样"某人从 client 值导入了 `config.ts`"会立刻变红，
而不是等到用户侧 `require` 失败或包体悄悄翻倍。

### D3 模块规模与重复 → **先把数值样板收成一处，再谈 lint 上限；上限本身现在无处可落**

**行数（复核，PowerShell 实数）**：`controller.ts` 1215 / `fleet/view.ts` 755 / `fleet/model.ts` 693 /
`modals.ts` 670 / `roster.ts` 657 / `pipeline.ts` 631；同目录 `locales.ts` 1087、`chip.ts` 513、
`styles.ts` 485、`workspace.ts` 356、`page.ts` 312、`validate.ts` 298、`apply.ts` 281；
host 侧 `index.ts` 1116、`handoff-tool.ts` 742、`handoff.ts` 686、`config.ts` 630、`router.ts` 582。

**"先在 lint 里定上限"今天是个伪答案**：仓库**没有** lint 工具链——根 `package.json` 只有 `test`
脚本，devDependencies 只有 `dsh`/`typescript`/`zod` 一类；根目录与包目录都没有 eslint/oxlint/biome
配置；`node_modules/.bin` 里没有 linter；CI（`.github/workflows/ci.yml`）只有 install → bundle → tsc →
四套 node 测试。落地代价：一个 oxlint devDependency + 配置 + CI 一步（纯 dev 依赖、无 peer，
风险远小于 D4 那件事）。**但顺序必须反过来**：行数上限只封顶、不治病——下面那些重复一行都不会少。

**数值样板的真实规模（修正任务书）**：任务书的"17 处"实测就是 `Number.isFinite` 的**出现次数**
（正好 17），不是"解析 + 夹取样板"的处数。真样板（受控输入里解析 + 夹取）只有 **18 行**：

| 类别 | 处数 | 位置 |
|---|---|---|
| a 受控输入解析+夹取（**真样板**） | 18 行 | `roster.ts:87-88`、`pipeline.ts:82-84`、`:180`、`:271`、`modals.ts:70`、`:193`、`:257`、`:264`、`:339`、`controller.ts:810`、`:832`、`:843-844`、`:850`、`:878` |
| a′ 只夹不解析 | 4 行 | `pipeline.ts:68`、`:94`、`modals.ts:129`、`:422` |
| b 显示格式化 / c 布局几何 / d 时间差 / e 数据规整 | 33 行 | `format.ts`、`health-ui.ts`、`fleet/model.ts`、`fleet/view.ts`、`validate.ts` 等（不是样板，别收） |

**同一不变量写两遍的地方**：`controller.ts:810/832/843-844/850/878` 五个 setter 把 UI 层已经夹过的
值**再夹一次**（`roster.ts:88`、`pipeline.ts:83-84` 已经在入口夹过）。这不是重复样板，是重复**规则**。

**两套字段控件的真实差异**（不是"看起来像"，是行为不同）：

| 控件 | 位置 | 标签 | 夹取 | 读事件 | 空值 |
|---|---|---|---|---|---|
| roster `NumberField` | `roster.ts:76-92` | 自带 `label`+`hint`+`id` | `max(0, round)`，无上限 | `currentTarget.value.trim()` | 非数字 → 忽略 |
| modals `NumberInput` | `modals.ts:59-73` | 只有 `aria-label` | **不夹**，交调用方 | `target.value`，不 trim | 非有限 → 忽略 |

后果：同一个"整数秒"字段四种下限（0/0/1/1），空值三种语义（保持旧值 / 0 / 回落默认）。
**唯一逐行同构的重复**：`pipeline.ts:438-444` 的 `FieldCol` 与 `modals.ts:51-57` 的 `StackedField`
——连 `className` 都相同。

**建议**

1. **先收编，后上 linter。** 新模块只放两件事：
   `parseIntText(text, {min, max}) → number | null`（把空值语义显式化）与受控
   `NumberField({id, label, value, min, max, hint, invalid, disabled, onChange})`。
   收 15 个调用点（roster 8、modals 4、pipeline 3 个裸 handler），`Stepper` 只调 `parseIntText`
   **不搬 DOM**（它有 ±按钮夹紧的布局契约）；`FieldCol`/`StackedField` 合成一个 `Field`。
   删除 ≈65 行、新增 ≈40 行，**净减 ≈25 行**——收益是"不变量只剩一处"，不是行数。
2. 上限（ratchet，按目录分档，从当前实数取整）：`controller.ts` 1220、`fleet/**` 780、
   `modals.ts` 700、`roster.ts` 690、`pipeline.ts` 660、`client` 其余 520、`locales.ts` 1100
   （或整目录排除，纯字典）、host `src/*.ts` 1120、`tests/*.mjs` 3400。

### D4 测试方法 → **不换（自造桩保留），但把"桩的语义边界"变成会变红的守卫**

**待核实的三个事实（已实测）**

1. DSH 的 `dsh-client-shortcuts` 确实把它列为 devDependency（checkout `workspace:*`，发布版钉
   `0.2.1-rc.3`）。
2. npm 上**存在**，但 `dist-tags.latest = 0.0.1-rc.1`（`next = 0.2.1-rc.3`）——裸装会拿到最老的版本，
   必须精确钉。
3. 本仓库根 `node_modules` 与 `packages/dsh-model-desk/node_modules` 都**没有**它；根 node_modules
   连 react/vitest/jsdom 都没有（现有测试是纯 node 脚本）。

**它是什么**：jsdom + vitest 的 **slot 测试台**（`SlotTestRuntime.declare/mount/renderSlot`，挂生产
SlotRegistry/renderer/ui-session，底层 @testing-library/react 的 act/render）+ 整客户端启动层。
**不是** React 桩替代品——它驱动**组件渲染**，我们的测试驱动 **controller actions + snapshot store**
（`tests/client-controller.mjs:5-10` 明写"不渲染组件"）。

**代价（不是"加一行 devDependency"）**：peer 要求 `react/react-dom ^18.2`（我们 `@types/react ^19.3`）、
`cordis ^4.0.1-rc.1`，以及本仓库根本不存在的 `dsh-invariants`/`dsh-host-apiproxy`/`dsh-client-runtime`/
`dsh-client-web-react`。按既有实测
（[peer-resolution 笔记](../../.agents/notes/implemented/2026-10-24-peer-resolution-is-a-dev-workspace-fact.md)），
精确钉 peer 会在包内**嵌套第二份**每个 DSH 包；唯一单实例方案是根改成 npm workspace。**那是工作区改造，
不是 devDependency 改动。**

**判据**：换的成本 ≫ 继续用自造桩的成本 ⇒ **不换**。有条件换的三个条件：(1) 根改 npm workspace 并统一
react 18 + vitest + jsdom；(2) 出现必须依赖真实 effect/ref/批处理语义的缺陷（今天没有：渲染断言的都是
静态树与文本）；(3) 接受测试层从"无 DOM 状态机测试"变成 slot 渲染测试。

**自造桩的已知偏差清单**（保留即可，不必修；行号是 `tests/client-controller.mjs` 的实证）：
`useState` setter 是空函数、无第二次渲染（:180）；`useEffect` 丢 deps、flush 全跑（:182，22 处循环如
:943-944）；**无 cleanup**（返回值丢弃；:1456-1457 自己在注释里承认"卸载分支无法表达"）；
单遍渲染、更新靠整树重渲（:194-216、:1683）；`useRef` 每次新建（:181）；无 key/reconciliation（:196-204）；
`children` 是人工约定（:170-178，本轮修的正是这里）；portal 被桩成 `null`（:134）；无批处理 / 无 act；
只有 6 个导出，没有 context / useReducer / useLayoutEffect / useSyncExternalStore。
当前 `src/client` 只用 `useEffect`/`useRef`/`useState`/`useMemo`/`useCallback`，所以
"无 cleanup / 丢 deps / ref 不跨渲染"这三条是**正在承受的盲区**，不是理论风险。

**低成本动作（建议进实现轮）**：用测试里已有的 `sourceOf()`（:43）扫 `src/client` 的
`from 'react'` 导入，断言 hook 集合 ⊆ 现有 6 个；一旦有人用了 `useLayoutEffect`/`useSyncExternalStore`，
用例变红，逼他先扩桩（或改用别的写法）。这把"桩的语义边界"从注释升级成守卫。

### D5 事件订阅的 owner 规则 → **今天的答案全是"插件 ctx"；给一张核对表**

**原生规则**：`sessionProjections.register` 的实现就是范本——注册被包进 `ctx.effect`
（[session-projection/src/index.ts:273-291](file:///D:/sudy/github/deepseek-harness/packages/session/session-projection/src/index.ts)），
disposer 随**调用方 fiber** 走；插件卸载 ⇒ 键从快照里消失，客户端读作"能力缺失"。
判据因此很简单：**语义属于插件 ⇒ 挂插件 ctx；语义属于某次 agent/会话 ⇒ 挂那个 ctx（且必须自己收）**。

**核对表（我们全部订阅/注册点）**

| 订阅 / 注册 | 位置 | 现在挂谁 | 应该挂谁 | 挂错的后果 |
|---|---|---|---|---|
| `session/event`（失败/截断/工具结果记账） | `index.ts:231` | 插件 ctx | 插件 ctx | 挂 agent ctx：插件禁用后仍在跑（这就是那次事故的形态） |
| `internal/config`（保存前校验） | `index.ts:190` | 插件 ctx（且用 `this !== ctx.fiber` 限定自己那次变更） | 插件 ctx | — |
| `agent/created` / `agent/pre-step` / **`agent/request`** / `agent/request-error` / `agent/turn-stopping` | `index.ts:262` / `:285` / **`:294-494`** / `:508` / `:597` | 插件 ctx（**不是** `agent.ctx`） | 插件 ctx | `agent/request` 那一次就是历史事故本体（`index.ts:268-277` 的注释记着：挂 `agent.ctx` → 插件禁用后旧实例继续接管 → domain closed，连续 5 轮失败） |
| `tools.register`（handoff 四动作） | `handoff-tool.ts:191`，经 `index.ts:659` 的 `ctx.inject(['tools','subagents'])` 子 ctx | 子 ctx | 子 ctx（随插件 dispose；工具名不可动态注册/注销） | 挂 agent ctx：tools 名字重复注册会撞 |
| `sessionProjections.register` ×3（failover / channel-health / handoff） | `index.ts:213/214/219` | 插件 ctx | 插件 ctx | 挂 agent ctx：一个会话结束就把全插件的投影键撤掉（registry 虽有 `refs` 计数，owner 仍是错的） |
| `storageDomain` 打开 + 关闭 | `bindings.ts:193-197`、`handoff.ts:433-437` | `ctx.get` + `ctx.effect` 关闭 | 插件 ctx | 不关就泄漏域句柄 |
| `scope.subscribe`（配置镜像） | `controller.ts:563` | 浏览器半包，由 `apply.ts:140-142` 的 `ctx.effect(controller.dispose)` 收 | 与 UI fiber 同寿 | 不收：已卸载的控制器被每次发布唤醒（注释 :561-562 记着） |
| `shortcuts.register` / `slots.register` ×5 / `locale.register` / `sidebarRightTabs.register` | `apply.ts:83/154/235/248/263`、`fleet/index.ts:209/213` | 全部在 `ctx.effect` 里，返回 unregister | UI 子 ctx | — |
| 裸 `setInterval`（连通性巡检） | `controller.ts:331-344` | **不归 Cordis**，由 `controller.dispose()` 手收（`apply.ts:270-279`） | 保持现状，但这是唯一一处"不骑 fiber" | 已在注释里写明（M11 的教训） |

**插件自有状态是否也守这条**：`state.ts:170-194` 的九个容器全是 `WeakMap<Agent|Session, …>`，
`index.ts:140` 的 `agentsBySession` 也是 `WeakMap` ⇒ 会话/agent 结束后自动释放，没有"插件级 Map
按会话无限增长"这类 owner 反例。

**机制侧的证据（为什么"挂插件 ctx"就等于"随 fiber 走"）**：`ctx.on` 在当前 ctx 的 fiber 上建 effect
（cordis `src/events.ts:254-259,288-301`）；服务方法里的 `this.ctx` 是**调用方** ctx
（`service.ts:46-49` + `utils.ts:116-125`），所以"看着像挂在服务上"的注册，disposer 实际归调用方 fiber；
`tools.register` 走 `dsh-scope` 的 `ScopedLayers.effect`（`core/tools/src/index.ts:1091-1095`、
`core/scope/src/store.ts:219-266`）；`ctx.inject` 就是在当前 ctx 下**新建子 fiber**，父销毁级联
（cordis `registry.ts:300-336`、`fiber.ts:236`）。

**唯一不骑 fiber 的一处**：客户端 `scope.subscribe`（`controller.ts:563-578`）不是 effect 语义
（`ConfigForm.subscribe` = `store.subscribe`，`config-form.ts:98-99`），必须手工退订——现在由
`apply.ts:140-142` 的 effect 收尾，`controller.dispose()` 幂等（:1170），`apply.ts:278` 与它重复调用也无害。
**保持现状**，但把"订阅不是 effect"这句写进注释。

**两个同源隐患（建议进实现轮，都是小改）**

1. **`projections?.register` 用的是构造期一次性 `ctx.get`**（`index.ts:212-219`）。我们自己 brief §三
   的规则就写着"服务晚挂上时用 `ctx.inject([...], cb)`"；DSH 的注册表文档也明说可选注册应走
   `ctx.inject(['sessionProjections'], …)`（session-projection/src/index.ts:194）。
   现状的后果：`sessionProjections` 若在**本插件之后**挂载或中途重载，三个投影键要到本插件 fiber
   重启才出现——浏览器会把它们读成"能力缺失"。改法：换成 `ctx.inject(['sessionProjections'], cb)`，
   代价是一次已存在模式的重排，不加服务。
2. **`handoffLedger` 的注释与代码不符**：注释说"cleared with it"（`index.ts:130-138`），实际只有赋值
   （`:672`）没有清理，读取在 `:881`。子 fiber 因 `tools`/`subagents` 服务 churn 被销毁到重建之间，
   `carriedOf` 读到的是已 closed 的 ledger（`handoff.ts:405-410` 退化到内存残值），界面会显示
   "携带过的预算"而不是"没有携带"。改法：在子 fiber 的 effect 里置空。

**结论**：owner 规则今天全仓满足（13 处全答得上来），**不需要改挂法**；上面两条是"注册时机/清理"
的具体缺陷，不是 owner 错。**值得写成规则的**是那句判据：语义归属决定 owner，且任何注册都必须能回答
"插件禁用时它怎么消失"；会话级事实用 `session.append`/`agent.steer` 写入，**不要**用注册表达。

## 新增候选（任务书没列，本轮发现）

| 新条目 | 位置 | 为什么值得调研 | 归属 |
|---|---|---|---|
| **A4** `normalize*` 是 schema 默认值的第二表达式 | `client/validate.ts:71-297` 对 `config.ts:84-349` | 150 行的字段清单与 schema 一一对应；加字段忘补就渲染 `undefined`，且没有任何用例会发现 | A 组 |
| **B4** 健康页合并在用"会话排序"代替"观测时间" | `controller.ts:386-401` + `:447-449` | 就是 §正确性那一条；它证明"一个读数键被用来表达两件事"这类问题在本仓库是**可复现**的，不只理论 | 正确性（已单列） |
| **C5** 我们的 `Modal` 没传 `shortcutModal` | `modals.ts:402/478/585/649` vs `apply.ts:172` | 我们自己的对话框里保存快捷键被原生仲裁挡掉，`apply.ts:149-153` 的注释与事实相反 | C 组（C2 附带） |
| **C6** 死键帽（平台猜测 + 绑定快照） | `format.ts:61-69`、`locales.ts:193-194/729-730`、`tests/unit.mjs:1986-1988` | 与用户可重绑定冲突；原生参考页已是单源，这 16 行零收益 | C 组（C4 附带） |
| **D2a** 客户端半包缺"外部依赖清单"闸门 | `lib/client.js` 顶层 `require` | 今天的边界靠人自觉；一条断言就能把"从 client 值导入宿主模块"变红 | D 组 |
| **D4a** 自造桩缺 hook 集合守卫 | `tests/client-controller.mjs:43`（`sourceOf`） | 桩只实现 6 个导出，用了第七个会静默失效 | D 组 |
| **D5a** 投影注册用构造期一次性 `ctx.get` | `index.ts:212-219` | 违反我们自己的 F-20 规则（服务晚挂上要用 `ctx.inject`）；服务重载后三个投影键要到本插件重启才回来 | D 组（D5 附带） |
| **D5b** `handoffLedger` 注释承诺"随子 fiber 清理"，实际只赋值 | `index.ts:130-138` 注释 vs `:672` 赋值 / `:881` 读取 | 子 fiber churn 的空窗里会读到已关闭的账本，界面显示"携带过的预算" | D 组（D5 附带） |

## 下一轮可以直接开工的（按性价比排序）

| # | 事项 | 代价 | 为什么排在前面 |
|---|---|---|---|
| 1 | **健康页合并按观测时间取新**（§正确性那条）+ 倒序输入用例 | 改 1 行语义 + 1 用例 | 唯一一条"用户看到的数是错的"；且用例能变红 |
| 2 | **C5 `shortcutModal`** 四处补齐 + 一条"对话框内保存生效"用例 | 4 行 + 1 用例 | 功能在文档里被承诺、实际不生效 |
| 3 | **C1 chip 重试输入框 IME 守卫**（含陈旧 `cancelled`） | ≈10 行，无新 inject | 真机可复现的数据丢失路径 |
| 4 | **C6 删死键帽** | 删 ≈16 行 + 同步删 3 行用例 | 零行为变化，删完少一处错误来源 |
| 5 | **D2a / D4a 两条闸门** | 各 ≈15 行断言 | 把"边界靠自觉"变成"越界即红" |
| 6 | **A4 的相等性用例** | 1 条用例（`normalize*({}) === Config({})` 对应节） | 防"schema 加了字段、UI 忘了补" |
| 7 | **B2 的目录失效订阅**（抄 `modelDirectories` 的四处 `refresh`） | 1 个 effect + 1 次 type-only 导入 | 补一条我们确实缺的语义；**不换原生件** |
| 8 | **D5a 投影注册改 `ctx.inject`** + **D5b `handoffLedger` 清理** | 各 ≈5 行 | 前者违反我们自己的 F-20 规则，后者是注释与代码不符 |
| 9 | **D3 数值样板收编 + 上 linter** | 净减 ≈25 行，新增 oxlint 依赖与 CI 一步 | 值得做，但它是工程债不是缺陷，且不该与上面几条混在一轮 |

## 必须由用户拍板的

1. **健康页那条算不算"产品行为变更"**：修完之后旧观测会被新观测替代，时间轴不变，但"本步耗时"会从
   4.51s 变成 13.94s。按"一个字段只有一个读者/不撒谎"该修；若用户希望健康页保留"最近一次**观测到的**
   延迟"以外的语义（例如按会话分别看），那是另一种产品设计，需要先定。
2. **C1/C5 要不要一起做**：两者都在 chip/Modal 的键盘路径上，一起做只要一轮真机验证；分开做要两次。
3. **A4 是"上用例"还是"真删 150 行"**：前者安全，后者要动保存链路的 seed 语义，属于实现轮且需批准。
4. **D3 上不上 lint**：新增一个 dev 依赖与 CI 步骤，属于工作区决策（与 D4 的 workspace 化是同一类问题的
   低风险版本）。
5. **C4 要不要做就地提示**（`Tooltip.shortcutKeys` + catalog）：它依赖 C5 先修；不做也不影响正确性。

## 本轮证伪的（别再按旧假设动手）

- "A1 能删 controller 300+ 行"——实测可删约 **93 行**，且换来一套表达不了嵌套数组的模型。
- "A2 可用 `settingsNumberField` 替掉解析+夹取"——它不是受控控件，也不夹取；换过去是**行为变更**
  （静默夹取 → 拒绝保存），不是重构。
- "A3 的否决理由会随 A1 失效"——A1 不换，理由不变。
- "B1 有同一数字两套算法"——没有；会话级与路由级是两类事实，`fleet` 侧读的全是 DSH 投影。
- "B2 接一个 service 就少一条独立读口"——那个类是**不导出**的，能注入的是按会话的目录，接进来要编造会话。
- "C1 pipeline 的 stepper 用 Enter/方向键"——该文件**没有任何 keydown**；roster 列表也不会被输入法抢。
- "C3 该跟进原生聚焦"——DSH 的"跳到某一行"**全部只滚不聚焦**，没有可跟进的先例。
- "C4 界面从不展示绑定"——命令**已经**自动出现在原生快捷键参考页；界面上的键帽是死代码。
- "D3 先在 lint 里定上限"——仓库**没有** lint 工具链；上限只封顶不治病。
- "D4 换个测试运行时只是加个 devDependency"——它在 npm 上的 `latest` 停在 `0.0.1-rc.1`，peer 要
  react18 + 四个本仓库不存在的包；按既有实测只有 npm workspace 化才能单实例。

## 不再重开清单（已被否决，本轮不再调研）

`Pill`、`DisclosureRow`、`Menu`（取代 listbox）、`InlineEditor`、`Alert`（不存在）、
`SettingsValueField`/`ConfigField`/`SettingsSecretField`（A3 复核后维持）、`Toast`、
`Tooltip` 用法（fleet 用、徽标用 `title`）。理由见 [p2-next-session-brief.md §三](p2-next-session-brief.md)。

## 下一轮（方案轮）提示词（复制到新会话）

````text
你在 DSH Model Desk 仓库做**方案轮**：一条一条来，不是批量改造。仓库：D:\sudy\myproject\dsh-model-desk；
DSH 源码只读：D:\sudy\github\deepseek-harness。分支 master，工作树有大量未提交改动：先 git status 看清，
不要 reset / checkout / 覆盖任何已有改动。

先读（按顺序）：
- docs/design/native-and-architecture-review.md ← 上一轮调研的结论。每条都有双侧 file:line、代价、
  删除清单、证伪清单。它是你的**证据底座**，不是照着抄的待办：这一轮要重新研究"最佳方案"。
- docs/design/p2-next-session-brief.md（基线、已收口项、验证配方、四个浏览器坑）
- .agents/notes/implemented/2026-10-24-client-half-typecheck.md（类型工程与棘轮判据）

当前基线（2026-10-24 实跑，别重测，直接当起点）：四套件 233 unit / 123 client-controller / 25 remote /
35 scenarios，0 失败；`npx tsc -p packages/dsh-model-desk/tsconfig.client.json` exit 0；指定 host tsc
exit 0；`npm run bundle --prefix packages/dsh-model-desk` exit 0，client ≈465 kB；DSH checkout
`git status --porcelain` 0 行。

## 工作方式（硬要求）

1. **一次只做一条。** 按下面顺序，做完一条就地停下汇报：结论 / 改了哪几行（file:line）/ 用例名 /
   原始验证输出，然后问用户"继续下一条？"。不要连做两条。
2. **每条先做方案研究，再动手**，而且研究要落到 file:line：
   a. 先查 DSH 里**同类功能**是怎么设计的——不只是原语（组件），而是整个交互与数据流：它的设置页/
      健康页/名册类界面怎么表达这件事、错误怎么上屏、多会话数据怎么合并、命令键帽从哪儿取。
      给 DSH 侧 file:line（checkout 或 node_modules 声明，两者同版本 0.2.1-rc.3）。
   b. 再对照我们的现状，写"**最佳方案** + 被否的两个备选（各一句理由）"。
   c. 只有确认语义等价、或确认"这是有意的差异且更好"之后才动代码。
3. 行号会漂：文档里的行号是 2026-10-24 的，改一行就会偏。**引用前重新 grep 核对**，别直接抄。
4. 语义不等价就写"不换"，并写清差在哪。不要为了"用上原生件"换掉有行为差异的东西。
5. 每条都遵守：未知不是 0；缺失投影隐藏或写"未加载"；一个字段只有一个读者；跨字段校验只在
   rules.ts；闸门与接力分开；不新增 durable 事件类型；不改 SESSION_FORMAT_VERSION；不碰 live profile；
   不改 DSH checkout。
6. 已否决的不要重开：Pill / DisclosureRow / Menu 取代 listbox / InlineEditor / Alert（不存在）/
   SettingsValueField+ConfigField / Toast / Tooltip 用法。A3 的解锁条件（A1 采纳原生模型）已不成立，
   同样维持否决。
7. 探针放 .sessions/（已被 gitignore），用完删，结论里引用探针输出。**改产品代码之前先给两份清单**
   （删除清单：删哪几段、共几行；改动清单：新增什么、动哪些调用点），让用户批。批准的改动要么配一条
   **能变红**的用例，要么是纯类型改动。
8. 两个已知坑：① `remote.deskHealth` 不能写进客户端顶层 inject（只由 applyInner 的 $mount 提供，
   写了整个 entry 永不激活）；② 改了 src/client 必须重跑 bundle，否则 client-controller 套件读的是
   旧产物。
9. 每条的结论**写回** docs/design/native-and-architecture-review.md 对应条目（补"方案轮决定"小节），
   不要只在聊天里说完就丢。

## 条目顺序

**第 1 条（正确性问题，优先，根因已定位）健康页「本步耗时」显示旧观测**
- 现状：`src/client/controller.ts:386-401`（`mergeHealthRecord` 让最后合进来的记录覆盖标量）+
  `:447-449`（按 `session.list` 的 `updatedAt` 排序，而冷会话的该值来自会滞后的持久化投影缓存，
  DSH 侧 `packages/api/session-controller/src/list.ts:349-351`、`:291-312`）；页面读的是
  `src/client/health-ui.ts:123`。
- 目标：标量按 `lastCheckedAt` 取较新那份，时间线仍并集去重、`pruneTimeline` 窗口规则不变。
- 必做：一条**倒序输入**用例（新观测在前、旧观测在后）断言取新观测；现有正序用例保持绿。
- 顺带研究并回答（只记录，不在本条目里改）：同一个 stale `updatedAt` 是否也会把新会话挤出
  `readRecentSessions` 的末 20 窗口——若是，那是另一个独立缺陷，给出方案与代价让用户定。
- 研究点：DSH 里跨会话合并同类观测的规则在哪（`session-stats`、`token-usage`、多会话窗口折叠），
  以及我们 `fleet/model.ts` 合并 recent sessions 时用的是不是同一套规则（若是，收成一处）。

**第 2 条 我们自己的 Modal 缺 `shortcutModal`（保存快捷键在自己对话框里失效）**
- 现状：`src/client/modals.ts:402/478/585/649` 四处 `<Modal>` 都没传；`src/client/apply.ts:172` 声明
  `modals: ['model-desk']`；DSH 侧 `ui-primitives/src/Modal.tsx:18/63` →
  `dsh-client-shortcuts/client/dom.ts:76` → `registry.ts:169-171` 把模态记成 `'other'` 后挡掉。
- 研究点：DSH 自己的插件对话框传什么值（`ui-settings-*`、`ui-plugin-manager` 的 Modal 用法），
  是不是也用自己的命令命名空间；确认我们该传 `'model-desk'` 还是另有约定。
- 必做：一条"对话框内保存生效"的用例；顺带核对 `apply.ts:149-153` 的注释与事实一致。

**第 3 条 chip 重试输入框的 IME 守卫（含陈旧 `cancelled`）**
- 现状：`src/client/chip.ts:447-459`（`onKeyDown` 在 `:458`，普通 `<input>` 上 Enter 直接提交）、
  `:393-400`（window capture 不判组合态）、`:486-491`（`cancelled` 决定 close/dismiss）。
- 原生：`ui-primitives/src/keyboard-composition.ts:8-35`（`guards` 判 `composing || ended ||
  isComposing || keyCode===229`，不看 `event.key`）；`Menu.tsx:334` 自己已经用了 `guards`。
- 研究点：`observeComposition` 在 DSH 里的三种用法（`ui-shortcuts/src/client/Editor.tsx`、
  `ui-conversation` 的 QuestionComposer、`ui-model-selection/ModelSelect.tsx:303-304`）分别建在哪一层、
  怎么 dispose——选最贴我们这个组件形态的一种，不要自己发明等价物。
- 必做：组合中 Enter 不提交；组合中 Escape 不置 `cancelled`（两条用例）。

**第 4 条 删掉死键帽（C6）**
- 现状：`src/client/format.ts:61-69`、`src/client/locales.ts:193-194` 与 `:729-730`、
  `tests/unit.mjs:1986-1988`（外加 `:38` 的导入项），`src/` 内零消费者。
- 研究点：确认命令键帽的唯一来源就是 shortcuts catalog（`registry.ts:84-133` →
  `ui-shortcuts/src/client/index.ts:40-45` → `Reference.tsx:197`），删掉不会让某处 DSH 要求的文案
  失去来源；顺便确认我们注册的命令确实出现在那个参考页（能截一张真机图更好）。
- 若用户还想做"保存按钮就地显示当前绑定"，作为**第 4b 条**另开：`Tooltip shortcutKeys` +
  `hooks` 注入的 catalog（`ui-slots/src/index.ts:559-573`），前提是第 2 条已修。

**第 5 条 两条闸门（D2a / D4a）**
- D2a：断言 `lib/client.js` 的 `require(...)` 集合恰为 `react`/`zod`/`@deepseek-ai/dsh-client-ui-primitives`/
  `@deepseek-ai/dsh-client-store`，且内容不含 `schemastery`/`defineDomain`（今天 zod 只从生成的
  `lib/typert.remote-client.js` 作为外部 require 进来，属正常形态）。
- D4a：用 `tests/client-controller.mjs:43` 的 `sourceOf()` 扫 `src/client` 的 `from 'react'` 导入，
  断言 hook 集合 ⊆ 现有 6 个（桩只实现这些，用了第七个会静默失效）。
- 研究点：DSH 自己有没有同类自检（包的 build/test 里是否有"bundle 外部依赖"或"允许导入"断言、
  client tsconfig 是否有类似约束）。**有就照它的形状做**，没有才自己写，并写清为什么。

**第 6 条 A4 相等性用例（`normalize*` vs schema 默认值）**
- 现状：`src/client/validate.ts:71-297` 的五个 `normalize*` 与 `src/config.ts:84-349` 的默认值清单
  一一对应；设置通道发的是已解析并摊平 `Volatile` 的值（DSH `settings/src/index.ts:319` +
  `schema.ts:10-17`），所以浏览器拿到的已是补齐后的形状。
- 注意：**不要删那 150 行**。旧键会活下来（schemastery object 是 loose 的，实测
  `healthSchema({intervalMinutes:60})` 保留该键），迁移分支必须留。
- 必做：`tests/unit.mjs` 一条不变式用例——`normalizeHandoff({})`/`normalizeHealth({})` 的键集与值
  等于 `Config({})` 解析出的对应节，`normalizeChain(defaultChainValue())` 等于缺省链形状。
- 研究点：DSH 里有没有"schema 默认值 vs 表单默认值"的对照测试先例，照它的写法。

**第 7 条 B2 目录失效订阅**
- 现状：`src/client/controller.ts:346-369` 每次激活读一次目录并缓存；
  DSH `ui-model-selection/src/client/service.ts:50-57` 在 `connection/reset`、`llm/adapters-updated`、
  `settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated` 上刷新。
- 研究点：这五个事件里哪些**真的**会让 `session/modelCatalog` 变（读 `$on` 的键面与 emit 点），
  只订阅有影响的；注意我们 plugs 的 `ctx.remote.$on` 键面需要一次 type-only 导入
  （DSH 自己在 `ui-settings/src/client/config-form.ts:12-27` 就是这么做的）。
- 代价必须写清：这是"补一条我们漏掉的语义"，不是"换原生件"。

**第 8 条 D5a / D5b（注册时机与清理）**
- D5a：`src/index.ts:212-219` 用构造期一次性 `ctx.get('sessionProjections')`，改成
  `ctx.inject(['sessionProjections'], …)`（DSH 注册表文档 `session-projection/src/index.ts:194` 的写法），
  顺带修"服务晚到就永不注册"。
- D5b：`src/index.ts:130-138` 注释承诺"随子 fiber 清理"，实际只有赋值（`:672`）没有清理，读取在 `:881`；
  在子 fiber 的 effect 里置空，并核对 `handoff.ts:405-410` 的退化路径。
- 研究点：DSH 里 `ctx.inject(...)` 注册可选服务的标准形状，以及"子 fiber 卸载时清字段"的写法。

**第 9 条 D3 数值样板收编 + 上 lint（必须先让用户批）**
- 先给清单不动手：15 个调用点（roster 8 / modals 4 / pipeline 3）、`FieldCol`≡`StackedField`
  合并、`controller.ts` 五个 setter 的重复夹取；删除 ≈65 行、新增 ≈40 行。
- 研究点：`Stepper` 为什么不搬 DOM（它有 ±按钮夹紧的布局契约）；`parseIntText` 的空值语义要显式化
  （三种现状：保持旧值 / 0 / 回落默认），哪一种是对的必须由用户定。
- lint 是新依赖 + CI 一步，属于工作区决策：先把代价与上限建议值（按目录分档）摆出来。

## 验证配方（每条改完都跑，贴原始输出）

```powershell
npm run bundle --prefix packages/dsh-model-desk      # 内含 host tsc 与 client tsc
npm test                                                # 四套件，当前基线 233/121/25/35，只许涨或持平
npx tsc -p packages/dsh-model-desk/tsconfig.client.json
npx tsc --noEmit --skipLibCheck --strict --module nodenext --moduleResolution nodenext --target es2022 --allowImportingTsExtensions packages/dsh-model-desk/src/index.ts
node --check packages/dsh-model-desk/lib/client.js
git -C D:\sudy\github\deepseek-harness status --porcelain   # 必须 0 行
```

浏览器（隔离 home，用 npm 宿主）：
`$env:DSH_HOME = Join-Path $env:TEMP 'dsh-fleet-cap-22'; node node_modules\@deepseek-ai\dsh\lib\bin.js
--profile web --no-open --port 3499`（stdout 打印带 token 的 URL，必须用它进入）。
四个已踩过的坑见 p2-next-session-brief.md §五（截图路径被限制、`resize_page` 受物理屏限、首屏更新
日志弹窗、右栏标签会被会话顶掉）。

只改本仓库。交付时给原始输出，不声称跑过没跑的测试。
````

## 本轮边界（与任务书一致）

未改 DSH checkout（`git status --porcelain` 未跑、也未触碰）；未改 `SESSION_FORMAT_VERSION`；
未新增 durable 事件类型；未碰 live profile；未写产品代码——本轮只有本页这一份文档与一次性探针
（已删）。上面任何一条若要动手，先按 §下一轮 的顺序让用户挑，再进实现轮。
