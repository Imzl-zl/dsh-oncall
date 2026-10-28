# Agent Note: 复核确认的四类缺陷按"删空闸、换公开面、补一个字段"落地

Status: implemented

## Problem

`docs/design/feature-review-2026-10-26.md` 记了 26 条问题，复核后又发现两条记录本身写错的地方（4.4 的修法少算一处 await、4.6 少算通知标签）。照记录任何一条都成立，但把它们当成 26 个独立任务去做，会重复读同一批文件、还会顺手造出第二套机制：被动观测再配一个开关、每日上限再引一个时间源、`needs` 再抄一份到浏览器校验里。

## Decision

每条修法只落在现成的控制流上；能删的字段直接删，绝不接线；缺的只是字段的补字段，不重开机制。

准入门槛：

1. **一个字段一个读者**：schema 与 UI 里出现、而 host 零读者的配置键必须删掉（`health.passive`、`limits.maxDelegationsPerDay`），而不是补一个语义出来。通过的样子：全仓 grep 该键只剩类型与字典，且它们一起被删；不通过：保留字段并加"以后会做"的注释。
2. **公开面优先**：调用第三方服务只许用它在 `ctx` 上注册的服务类自己的方法；手写结构类型必须能被一条运行时原型对账的测试证明（`SessionController.prototype`）。通过的样子：`unit.mjs` 里那条对账用例绿；不通过：`as` 强转后靠手造 faces 通过。
3. **边界只有一份**：数值上下限进了 `defaults.ts` 常量，host schema 与浏览器钳位都读它；不许在 `client/validate.ts` 里再抄一张边界表。
4. **第一跳的条件只补字段**：`chain.primaryNeeds` 与候选 `needs` 同形，条件过滤/跳过通知/落回全部复用现有代码；同批修掉"落回第一跳还发跳过通知"的假话。
5. **两处"形状由谁给"必须分开看**：宿主读原始配置（键是否存在），浏览器读 settings 快照（校验后的值，数组被盖章成 `[]`）。凡是判"配置是哪种形状"的地方，都要问一句"我拿到的是哪一份"；浏览器侧对旧配置的还原只允许复用宿主那条规则，不许另立判据。

## Alternatives considered

1. 按 26 条逐条独立修（每条一个提交）
   - 最强的理由：每条的因果最干净，回滚粒度最小，review 时一条对一条。
   - 为何被否：3.1/4.12/4.15 都落在 `state.ts`/`chain.ts` 同一批函数上，分三次改等于三次重读同一段代码；而 4.4 与 4.6 的修法本身要合并（一处 race、三处标签），拆开反而漏。
2. 给 `health.passive` 与 `maxDelegationsPerDay` 接线（真做一个开关、真做一个每日计数）
   - 最强的理由：字段已经在 schema 与界面里了，用户看得见，删掉是一次产品面收缩；"每天"也确实是一个合理策略。
   - 为何被否：被动观测是零成本折叠，没有"要不要记录"可决定；每日计数要引入新的时间源与跨重启口径，而它的收益（比每用户消息上限更宽的一个数）为负。删字段是唯一不制造第二个事实源的做法。
3. 让 `newSession` 继续走 `ApiSessionAgentController`（保留三个私有方法）
   - 最强的理由：那三个方法语义更直接——`selectionFor(agent)` 直接拿内存里的选择，不需要回读 durable 头。
   - 为何被否：那是私有类的成员，`ctx` 上根本拿不到；`as` 强转只让 tsc 沉默，运行期必 TypeError。公开面 `create`/`selectModel` + `agents.get` 已足够，代价只是把选择从内存改成读 `requestHeader()`。
4. 把"条件对第一跳生效"写进文档承认做不到
   - 最强的理由：少一个字段、少一段 UI，风险最小。
   - 为何被否：不是能力缺失。条件过滤、跳过通知、每轮重判都在，缺的只是"第一跳的 conditions 从哪儿来"这一个位置，补字段约 100 行即可，且 4.13 的假话可以同批修掉。
5. 只在 unit 里对账公开面，不碰组合层
   - 最强的理由：headless 不挂 `session-controller`（它由 `dsh-web-app/cordis.patch.yml:121` 挂载），组合层根本到不了 `newSession`；在 unit 里用真实类的原型对账已经能抓住 3.3 这个错。
   - 为何被否：原型对账只证明"方法名存在"，不证明 `create` 的返回值能喂给 `agents.get`、也不证明 relay 的依赖在真实组合里拿得到——而这两点才是 3.3 之后的隐患。改走 `tests/handoff-relay.mjs`：用自己的 DSH_HOME 起 shipped `web` profile，走真实 `sessionController.create` → `agents.get` → `selectModel` → 工具 `newSession`。这条新用例当场抓到一个原型对账抓不到的缺陷：插件在注册时把两个服务捕获成引用，而 web 组合把它们挂得更晚，结果是**每一次** `newSession` 都回 "this composition does not provide both"，服务明明就在那儿。修法是把 face 改成"调用时求值的 getter"。

## Consequences

- 收益：26 条里 24 条已落地并有断言；两条配置键消失（少两处的 schema/UI/校验三处维护）；`SessionController` 的错契约不可能再靠手造 faces 长回来（对账用例读真实包原型）；`primaryNeeds` 让"零点击识图路由"在一条全局链之后成立，且落回第一跳时不再说假话。
- 代价：`3.1` 的粘滞语义多一个 `ownImages` 标记（`TurnNote` 多一列）；脏草稿不再被外部写入覆盖，改为保留 + 页脚提示（用户可能因此覆盖别人的改动，这是一次有意的取向）；`npm test` 多了一套 `handoff-relay.mjs`，它在进程内起 shipped `web` profile（会绑一个本地端口，带 `--no-open`），因此比原来慢几秒，也多了一个"web 组合能启动"的依赖前提。

补充（同日晚，Minor 收尾）：这一轮里有三条判断被代码推翻，记在这里防止下次重开——① 记录说 `stateOf` 在 rc.3 已 deprecated 且每次 warn：**不成立**，声明只有普通 docblock（`dsh-session-projection/lib/types/index.d.ts:167-175`），运行期也没有 warn（`lib/index.js:126-130`），所以不动它；② 记录把 `openNotes` 列为"不可达"：对，但删掉它要同时改一条把它当入口的用例，不改就是把死代码留在 guard 里；③ `handoff-relay` 起 web app 不能绑默认 3080——用户桌面应用正占着它，测试必须 `--port 0`，否则 `npm test` 会在别人的生产端口上 `EADDRINUSE`。另：`stub-script` 从"固定路径"改成每套件一份（`STUB_SCRIPT`），并行跑不再互读 outcomes。

补充（同日晚，浏览器实测）：`seed()` 里新增了一条"校验后快照还原旧形状"的分支（空 `chains` + 旧 `chain` 有候选 → 按旧形状读）。它是启发式，之所以接受，是因为那个组合只可能来自校验（`save()` 保存新形状时会 unset `chain`），而代价是"看起来像空链"的那种配置会被读成旧链——比"显示空链、保存一次清空用户候选"小得多。真正的结构性修法是让宿主把生效链通过 Remote 发给浏览器，但那要新增一条面，本轮不做。
