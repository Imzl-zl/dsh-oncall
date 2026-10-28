# Agent Note: 像素办公室按「模板 → 场景 → 渲染 → 组件」四层落地，而不是一个大组件

Status: implemented

## Problem

需求是"把一列文字变成一间能看懂谁在忙、谁卡住的房间"，但第一版实现（spike 里）是边画边挪坐标：桌子被画成小方凳、人被桌子吞掉、显示器悬在桌沿外、六个工位叠在一起。每一次修正都靠我改一个像素再截图看，因此同一类错误反复出现（单位混淆、遮挡顺序、可行域没算）。

真正的问题不是美术能力，而是**没有把"摆放"和"画"分开**：几何、状态映射、绘制、组件生命周期四件事写在一处时，任何一处改动都无法被测试固定住，只能靠眼睛。

## Decision

按四层落地，依赖只往下：

1. `office-template.ts` — 模板数值与投影；三条不变量（脚在桌沿内 / 显示器底座在桌面内 / chip 挂桌面下方）作为**函数**存在；
2. `office-scene.ts` — `FleetAgent[]` → `RoomScene`（座位、待命、溢出、chip 锚点）；**状态→视觉态只在这里映射一次**；
3. `office-render.ts` — 唯一接触 2D context 的模块；静态房间烘一次、每帧只贴角色；`FrameClock` 全局共享；
4. `office-view.ts` — React 组件只管测量、整数放大、订阅时钟、点击上抛；无 2D context 时只剩 chips。

准入门槛（可机械判定）：

1. **不变量可反证**：单测里把 `monitorDX` 推出去 20px，检查必须报"底座出界"；只断言"通过"不算。
2. **场景可测**：`buildScene` 的座位顺序 = 输入顺序、第 6 个非空闲计入溢出、全空闲时 `animating === false`；房间不允许自己重排。
3. **渲染器只认场景**：`paintFrame` 的入参是 `RoomScene` + tick，不认识 `FleetAgent`；假 context 测试断言"每帧静态层只 blit 一次"。
4. **降级不靠平台能力**：没有 `document`/2D context 时组件仍然渲染 chips（测试渲染器没有 canvas，不能因此红）。

## Alternatives considered

1. 一个大组件（canvas + 逻辑写在 `SessionView` 里）
   - 最强的理由：改动最小，一个文件放得下，调试时不用来回跳。
   - 为何被否：放置逻辑无法被单测覆盖，只能截图验收——这正是前几版反复错同一类的原因；而且 `SessionView` 已经有 7 个职责。
2. 纯 DOM 画房间（每张桌子若干 div）
   - 最强的理由：可访问性天然好、可用 CSS 主题、无需 canvas 能力探测。
   - 为何被否：一间房要几十个绝对定位盒子，每次状态变化都触发布局；而画面本身是"一张静态图 + 几个小人"，canvas 的静态层缓存正好匹配这个形状。文字仍然留在 DOM（chips），两边各拿自己的强项。
3. 直接把 spike 的 HTML 搬进来（iframe / 内联页面）
   - 最强的理由：原型已验证过观感，几乎零重写。
   - 为何被否：iframe 拿不到 DSH 的会话数据与打开会话的能力；内联页面等于在插件里维护第二套视图层，样式与主题都会分叉。

## Consequences

- 收益：摆放从"靠眼睛"变成"靠断言"；新增状态只改 `office-scene.ts` 一张表；渲染器可被假 context 测试，不必开浏览器；`FrameClock` 是单例，将来多房间不会各开一个 rAF。
- 代价：文件数从 1 变 4，跨文件读代码；模板数值集中在 `DESK_WORKSTATION`，改比例要同时看 `office-template` 与 `office-scene` 两张表；`office-render.ts` 仍需 `document` 才能建精灵与静态层，Node 侧测试只能验证调用形状而不是像素。
