# 设备监管插件 —— 功能与设计文档

> 版本 3.0 · 目标插件 `@local/dsh-device-monitor`
> 本文档是插件的**功能说明书**与**设计文档**：前半部分完整介绍它能做什么，后半部分说明每个方案为什么这么设计（内部 ADR 编号「决策 1–26」贯穿全文）。
> 实现细节的坑与取舍见 [`PITFALLS.md`](PITFALLS.md)（18 个真实踩过的坑）与 [`TRADEOFFS.md`](TRADEOFFS.md)；安全模型见 [`SECURITY.md`](SECURITY.md)；安装与使用见 [`README.md`](../README.md)。

---

## 1. 插件功能概述

### 1.1 这是什么

一个运行在 DeepSeek Harness（DSH）内的设备监管插件：通过 SSH 连接用户登记的设备（服务器、NAS、嵌入式板卡等），按可配置的周期采集 CPU、内存、磁盘、负载、温度、进程、服务等指标，在 **DSH 原生右侧边栏**（与对话并排）展示实时状态与趋势波形，并把采集原始数据与异常事件（掉线 / 恢复 / 重启）落盘留痕。同时向 Agent 提供 5 个工具，让对话可以直接查询设备、执行命令、翻阅历史。

设计要点一句话：**「只有有人在看才采集」**——面板可见时才续租约并轮询，面板关掉后 Host 停止一切拨号，不打扰嵌入式设备。

### 1.2 功能清单

| 功能域 | 能力 | 说明 |
|---|---|---|
| 界面 | 右侧边栏集成（better-sidebar） | 「+」菜单出现「设备监管」，Tab 常驻右栏与对话并排；Tab 上可显示告警角标（badge）；未启用 better-sidebar 时**静默降级**为主区（完整视图） |
| 界面 | 三视图状态机（列表 / 详情 / 表单） | 右栏内完成「列表 → 详情 → 添加 → 编辑 → 删除」全流程，不切主区、不弹模态框 |
| 界面 | 卡片 / 详情 / 设置 / 日志 | 卡片含状态、4 条波形与数值；详情含服务列表、挂载表、异常区；设置与日志页均在面板内 |
| 采集 | 定时刷新，默认 **60 s**，可配 `5–3600` s | 面板**可见才采集**（观察租约，见 §4.2）；关闭面板 / 切走 Tab 后租约过期，Host 停止拨号 |
| 采集 | **11 项可配置指标** | `uptime/load/cpu/mem/disk/temp/top/net/diskio/procs/tcp`；**未勾选的指标连命令都不下发**（设备端真的不执行）；`uptime` 强制采集且不可取消 |
| 采集 | busybox 兼容 | 命令全部走 `/proc`、`/sys`、`df -P -k`、`mount`、`systemctl`；设备缺失的项目自动降级为空值 |
| 展示 | 每卡片 **4 条迷你波形**（CPU / 内存 / 磁盘 / 温度） | 缺失值**断线**而非画 0；波形坐标轴刻度与线同源 |
| 展示 | 数值条 | 有波形列的指标不重复进数值条；负载以「0.54 / 0.53 / 0.54 · 4 核」形式带核数显示 |
| 告警 | 阈值告警（`cpu/mem/disk/temp`） | 阈值可在设置页逐项调整，**设为 0 即关闭**该告警；告警总数显示为右栏 Tab 角标 |
| 落盘 | 采集**原始数据**落盘 | 每台设备一个文件 `log/devices/<清洗名>-<id 前 8 位>.log`，权限 `0600`；单文件 20 MB、保留 3 份；**采集失败也留痕**（`[失败] <原因>`） |
| 异常 | 掉线 / 恢复 / 重启检测 | 连续 N 次失败才判离线（默认 2）；恢复计时；uptime 突降判重启；异常状态纯内存（见决策 20） |
| 终端 | 终端调试（**默认关闭**） | 右下角交互式 shell 浮层；三重围栏（见 §7.3）；不解释 ANSI、非模拟器；每次连接审计留痕 |
| 工具 | **5 个 Agent 工具** | `device_list` 列出设备；`device_status` 查看最新指标；`device_collect` 采集；`device_exec` 远程执行命令（只记 `commandLength`，不记命令文本）；`device_history` 合并异常与审计历史 |
| 审计 | 审计日志 | 记录设备增删改、设置变更、远程执行、终端使用；**只记字段名与事件，绝不记值**；5 MB × 5 份滚动 |
| 设置 | 刷新周期 / 阈值 / 指标 / 日志 / 自定义命令 / 终端 | 全部在面板内配置，持久化到文档 v2（见 §8.4）；自定义命令默认关闭 |
| 本地化 | 简体中文 / English | 词典走严格占位符正则 |

### 1.3 不变量（不可破坏）

- 设备上限 **10** 台（`MAX_DEVICES = 10`），创建时强制，超限 409。
- 凭据明文存于用户私有文件、权限 `0600`，**永不进日志、永不进浏览器、永不进模型上下文**。
- 路由**仅限回环**：非回环请求一律 `403 forbidden: loopback-only`。
- 客户端 `apply` **永不抛异常**（抛了就拖垮整个 Web shell 启动）。
- 只用主题变量，不硬编码颜色。
- 客户端不自带 React、不引 CDN/UMD、不 import 任何 `@deepseek-ai/dsh-client-*` 包（用宿主注入的 React 18.3.1，`useSyncExternalStore` 无需状态库）。

---

## 2. 总体架构

### 2.1 组成与模块

插件分 **Host 半**（Node 进程内，负责存储 / 采集 / 调度 / 路由 / 工具）与**客户端半**（浏览器，负责界面与交互）。同一份代码两个半，`client.js` 由 DSH Web 注入。

| 半 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 入口。`name = "device-monitor"`；`inject = ["webServer","tools","systemPrompt"]`；`SECTION_ORDER = 152`；`sync()` 在 `ctx.effect` 内挂载 section + 路由 + 工具 |
| Host | `src/store.js` | 设备 + 设置持久化。`MAX_DEVICES=10`；`$DSH_HOME/dsh-device-monitor.json`；临时文件 + `renameSync` 原子写、`mode 0o600`；`summarize()` 只暴露 `authKind/hasPassword/hasPrivateKey`；文档 v2 含 `settings` 区与 v1 升级；`patchSettings()` 与名单**同一次原子写** |
| Host | `src/settings.js` | 设置默认值与夹取（`DEFAULT_THRESHOLDS`、`normalizeThresholds` clamp 0–200 且拒绝 NaN） |
| Host | `src/metrics-keys.js` | 指标词汇表（11 键 + 顺序契约）、`ALWAYS_METRICS`/`DEFAULT_METRICS`/`LABELS`/`HINTS`、`normalizeMetrics`、`metricCatalog()` |
| Host | `src/collectors.js` | 采集命令计划与解析。`commandPlan(metrics, customCommands)` **门控**（未勾选不下发）；11 + 3 个收集器的纯函数解析器 |
| Host | `src/ssh.js` | SSH 层。`loadSsh2()` 走 `roots()` 阶梯（profile 依赖探测）；`connect/exec/test/collect`；`withStoredSecret` 凭据回填；`collect()` 成功与失败都写原始日志 |
| Host | `src/metrics.js` | 内存环形历史 `series`、`ringSizeFor` 保留窗口、`evaluateAlerts(sample, thresholds, metrics)`（阈值可注入，0 即关闭） |
| Host | `src/monitor.js` | 调度。观察租约 `watch(clientId, intervalSec)`、`syncTimer()` 按租约重建/停止、过期收割、`unref()`；`pollMany(concurrency=4)` 去重；`testConnection` / `testDraft` / `execOn` / `overview()` |
| Host | `src/incidents.js` | 异常状态机：掉线（连续 N 次失败）、恢复（`wentOnline`）、重启检测（uptime 突降 > `rebootMinDrop`）；记录失败不影响采集（try/catch） |
| Host | `src/rolling-file.js` | 落盘一层：只管文件——路径、按大小轮转、按新→旧列出全部滚动份 |
| Host | `src/raw-log.js` | 落盘二层：记录格式——纯文本块 + 设备名净化；每设备一文件、失败留痕、改名跟随、删设备连带删 |
| Host | `src/jsonl-log.js` | 落盘三层：JSONL——每行 `JSON.stringify(rec)`（审计 / 异常记录用） |
| Host | `src/terminal.js` | 终端会话管理器（上限 3/设备、10/总；空闲超时下限；会话拨号与拆除） |
| Host | `src/terminal-route.js` | 终端 WS 升级处理器（升级请求**绕过** JSON 路由守卫，必须自己重做回环检查） |
| Host | `src/http.js` | 回环围栏 + 受信来源判定（`dsh-app://app`） |
| Host | `src/routes.js` | 15 条 exact 路由（见 §8.2） |
| Host | `src/tools.js` | 5 个 Agent 工具（注册、schema、render、系统提示） |
| Host | `src/logs.js` | 日志读取（原始日志 / 审计 / 异常，跨全部滚动份、按扫描上限读整份再过滤） |
| Host | `src/series.js` | 序列与点格式工具 |
| Host | `src/resolve.js` | 路径与资源定位 |
| Client | `client.js` | 右栏 Tab 注册、三视图、卡片 + 4 波形、设置页、日志页、终端浮层、zh/en 词典、模块级共享 store |

### 2.2 数据流

```
设备勾选的指标 + 自定义命令
        │
        ▼
commandPlan(metrics, customCommands) ──► 只含被选中采集器的命令清单（未勾选 ⇒ 一条都不下发）
        │
        ▼
SSH 拨号（每台设备、按租约周期）──► 原始 stdout 原样写 raw-log（成功与失败都写）
        │
        ▼
解析器（collectors）──► sample（11 键快照 + 上下文：内核版本/服务/挂载）
        │
        ├─► 内存环 series（ringSizeFor 保留窗口，读时截断）──► GET /metrics ──► 卡片 4 波形
        ├─► evaluateAlerts（阈值注入）──► 告警 ──► 右栏 Tab badge
        └─► incidents 状态机（掉线/恢复/重启）──► overview ──► 卡片状态条、badge
```

---

## 3. 方案 A —— 右侧边栏集成（better-sidebar）

### 3.1 依赖的真实契约

`dsh-better-sidebar` 对外提供一个**客户端 cordis 服务** `ctx.betterSidebar`，第三方插件调 `registerTab(descriptor)` 即可在 DSH 原生右侧边栏获得一个真实 Tab（返回 disposer 函数；此契约实测自已安装产物，非文档转述）。

`TabDescriptor` 字段（实测）：

| 字段 | 必要性 | 本插件用法 |
|---|---|---|
| `id: string` | **必填** | `"device-monitor"`，同时也是 `SidebarTab.type` |
| `title` | **必填** | `() => t("entry.label")`，跟随语言 |
| `description` | 可选 | `() => t("panel.subtitle")`，渲染在「+」菜单里 |
| `icon` | 可选 | 复用现有 `DevicePanelIcon` |
| `order` | 可选（默认 100） | `60`，与主区一致（低于默认值，排在前面） |
| `single` | 可选 | `true` —— 同类 Tab 只开一个，重复点聚焦既有 |
| `badge` | 可选 | 告警数：`(ctx,scope,state) => 告警条数 \|\| null` |
| `component` | **必填** | `DevicePanel`（与主区共用同一组件） |

`TabComponentProps` 关键一条：

```ts
/** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
visible: boolean;
```

→ **这是节流开关**：`visible === false` 时必须停止续租约（见 §4.2）。

### 3.2 接线方式

1. `package.json` 的 `dsh.client.inject` 追加 `"dsh-better-sidebar"`：

```json
"inject": [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "dsh-better-sidebar"
]
```

> **这里装的是「包 id」，不是「服务名」。** `arriveGraphRow` 把 `inject` 的每一项当作**要在本模块之前 import 的 package id**，所以第 5 项必须是 `dsh-better-sidebar/package.json` 里的 `name`。写成服务名 `"betterSidebar"` 会让 Web 启动时报「无法解析该模块」。

2. `client.js` 运行时注入数组同步追加：`const inject = ["slots", "locale", "betterSidebar"];`

> **这里装的才是「服务名」。** cordis 的 `Inject.resolve` 按**服务名**解析数组元素，所以运行时数组写 `betterSidebar`（`ctx.provide` 的名字），而 `package.json` 写包 id。两处不能互换。

3. 在现有 `ctx.effect` 里，紧跟 `registerPanel` 之后追加：

```js
try {
  disposers.push(registerSidebarTab(ctx));
} catch (error) {
  console.warn("[dsh-device-monitor] right-sidebar tab registration failed:", error);
}
```

4. `registerSidebarTab` 的形态：

```js
function registerSidebarTab(ctx) {
  const sidebar = ctx.betterSidebar;
  // 未装 / 未启用 better-sidebar 时返回 null，静默降级为主区（完整视图）。
  // 返回 null（而非空 disposer）让调用方能区分「没注册」和「注册了要释放」。
  if (sidebar === undefined || sidebar === null) return null;
  if (typeof sidebar.registerTab !== "function") return null;
  const dispose = sidebar.registerTab({
    id: PANEL_ID,                       // "device-monitor"
    title: () => t("entry.label"),
    description: () => t("panel.subtitle"),
    icon: DevicePanelIcon,
    order: PANEL_ORDER,                 // 60
    single: true,
    badge: () => alertTotal() || undefined,
    // `visible` 必须转发给面板：它不是装饰，而是租约的开关。
    component: (props) =>
      h(DevicePanel, { owner: "sidebar-tab", visible: props?.visible, narrow: true }),
  });
  return typeof dispose === "function" ? dispose : () => {};
}
```

> **`visible` 是承重的，不能省。** 面板靠它决定是否续租；丢掉它，右栏被折叠时面板仍会每 60 秒拨 10 台设备。这条接线被 `client-smoke.mjs` 的变异测试专门覆盖。

### 3.3 关键决策

- **决策 1：注册 Tab，不去直接抢底层 `sidebar.right.pane.tab` 座位。**
  理由：底层座位虽然存在，但绕开 better-sidebar 就拿不到 Tab 生命周期、去重、开关、「+」菜单引导页——用户要的正是「结合 better-sidebar 插件」。
- **决策 2：`if (ctx.betterSidebar)` 守卫 + try/catch，绝不硬依赖。**
  理由：若用户禁用/卸载 better-sidebar，客户端必须仍能降级到主区（完整视图），而不是整个 Web shell 起不来。
- **决策 3：`single: true`。**
  理由：设备面板是**全局视图**（一个设备列表），不是「每会话一份」。开多个 Tab 只会重复轮询同一批设备。
- **决策 4：保留主区座位，左栏座位已按需求移除；右栏 Tab 与主区共用同一个 `DevicePanel` 组件。**
  理由：主区座位**不能删**——它是宽屏下的完整视图，也是 better-sidebar 缺失时的降级兜底；**左栏（`sidebar.panellist`）刻意不注册**，因为它是「已打开的视图的第二个入口」，点击会把对话区顶掉（`client.js` 注释原文）。`client-smoke.mjs` 断言只注入 `main`（`injectedSeats === "main"`），并断言**不存在** `sidebar.panellist`。右栏与主区靠容器宽度自适应，不做两份实现（两份必然漂移）。

### 3.4 右栏布局约束

右栏是**完整功能面板**：列表、详情、添加/编辑表单全部在右栏内完成。右栏窄（约 300–360 px），布局按窄栏设计：

- 面板内部用**单列纵向布局**，不做左右分栏。
- 列表 ↔ 详情 ↔ 表单是右栏内的**三个视图状态**，靠现有 `selected` / `editing` 状态切换，不弹模态框。
- 表单控件 `width: 100%` + `box-sizing: border-box`；凭据输入框不设固定宽度。
- 按钮组用 `flex-wrap: wrap`，避免窄栏下溢出。
- 卡片内指标用紧凑网格（2 列或 3 列），CSS 自适应而非固定像素。
- 详情页的「运行中服务」列表与挂载表给 `max-height` + `overflow: auto`。

> **窄栏适配的验证要求**：`main` 座位与右栏 Tab 渲染的是同一组件，因此组件必须对**宽度**而非**位置**自适应。测试断言组件不使用固定 `width` 像素值，只用 `max-width`/`min-width`/`flex`。

### 3.5 右栏 Tab 与主区的状态共享

两个座位渲染同一组件、各持一份 React 状态，会产生两个问题：两处各自轮询（双倍拨号）、一处改了设备另一处不刷新。

- **决策 4b：把「设备列表状态 + 轮询」上提到模块级共享 store，两个座位订阅它。**
  理由：若各持一份，右栏与主区同时打开时会有**两个定时器**分别拨号 10 台设备，采集量翻倍；且在一处添加设备后另一处要等自己的下一个轮询周期才更新。
  实现：模块内的轻量订阅容器（`subscribe(listener)` / `getSnapshot()`），用 `React.useSyncExternalStore` 订阅。DSH 打包的 React 是 **18.3.1**（`useSyncExternalStore` 自 18.0 起内置），**无需引入任何状态库**；客户端插件获得的 `require("react")` 就是宿主这一份 React（注入式，不由插件自带）。轮询租约因此也是**进程级一份**，与 §4.2 一致。

### 3.6 右栏内的三个视图

- **决策 4c：右栏内用 `view` 状态机（`list` | `detail` | `form`）切换，不弹模态框。**
  理由：右栏本身已有 Tab 容器，再叠一层模态框会在窄栏里形成「对话框套在窄抽屉里」的双层遮挡，且焦点管理与键盘 Esc 需要另写一套。状态机是零成本的。
  状态存模块级共享 store，因此主区与右栏切换视图互不影响对方的滚动位置；两个座位读同一份 `view`。
- 表单字段与原主区表单**完全一致**（同一 `DeviceForm` 组件），只由容器宽度决定排版。
- **凭据字段在编辑模式下留空 = 不修改**（`normalizePayload(payload, {partial:true})` 已实现该语义），表单必须显式提示「留空表示不修改」。
- 试连在设备**尚未保存**时也可用（`POST /test-draft`）。**「留空表示不修改」与试连必须语义一致**：保存是 `{...current.auth, ...fields.auth}` 的**合并**，所以编辑页留空密码后点「测试连接」，Host 必须补上已保存的密码（`withStoredSecret`，见 §10.2(2)），否则同一个空密码框保存成功、测试却拿空密码认证（`All configured authentication methods failed`）。

---

## 4. 方案 B —— 定时刷新与波形图

### 4.1 刷新间隔的默认值

- **默认 60 s**（用户指定）。
- 取值范围 `[5, 3600]` 秒。
- 单位：**对外 API 一律「秒」，内部一律「毫秒」**，只在 `intervalToMs(sec)` / `intervalToSec(ms)` 两个函数里换算。

### 4.2 「只有有人在看才采集」的租约机制

采集被刻意设计成**按需**（不要让 Host 进程一直去拨没人看的设备）。定时刷新必须在这个前提下实现，于是引入**观察租约（watch lease）**：

- 客户端在右栏 Tab **可见**时，每 `intervalSec` 秒发一次 `POST /watch`（或 `GET /overview?watch=1`）。
- Host 按「全局会话」粒度记一个 `lastSeenAt`。
- 定时器每 `intervalSec` 触发一次，**仅当 `now - lastSeenAt < 2 × intervalSec` 时**才真正轮询。
- 租约过期（面板关闭 / 切走 / 浏览器关掉）→ 定时器自动空转，**不再拨号**。

收益：既满足「定时刷新」，又保住「没人看不采集」的原设计意图。

- **决策 5：租约而非常开定时器。**
  理由：常开定时器会让 10 台设备 24×7 被拨号，即使用户从没打开面板；对嵌入式设备是实打实的开销。
- **决策 6：租约阈值取 `2 × intervalSec`，不是 `1 ×`。**
  理由：网络抖动或一次采集超时会让心跳晚到；`1×` 会造成「偶发空一拍」，`2×` 容忍一次丢失而只多跑一拍。

### 4.3 可见性降级

`TabComponentProps.visible` 为 `false` 时：

- 不停止 React 状态，但**停止发心跳** → 租约自然过期 → Host 停止轮询。
- 折线图保留最后一帧，不做动画。

### 4.4 波形图设计

- **位置**：每张设备卡片内嵌 4 条迷你折线（CPU / 内存 / 磁盘 / 温度）。
- **数据源**：`GET /metrics?id=<id>&limit=<n>` 返回 `{sample, series, ...status}`；`series` 每点形如 `{ts, cpu, mem, disk, temp, ...}`（见 §8.3）。
- **渲染**：`Sparkline`（纯 `svg` + `polyline`，`vectorEffect="non-scaling-stroke"`），按指标传色/传上限。
- **配色**：只用主题变量（`var(--dsw-alias-brand-primary)` 及状态色），不硬编码。
- **缺失值必须断线**：`Number(null) === 0` 会把「没数据」画成 0。统一用：

```js
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
```

  并**全文件禁用** `Number.isFinite(Number(x))` 写法（有静态扫描断言）。
- **坐标轴刻度与线同源**：`waveScale` 是纯函数，Sparkline 接受现成 `scale`，一次计算两处使用；轴**不得**自己重算一遍刻度（画不出线的列不印坐标轴，而不是印一个框住空白的框和编出来的数字）。

### 4.5 保留窗口

保留窗口由间隔推导：`ringSizeFor(intervalMs) = clamp(ceil(RING_TARGET_MS / intervalMs), RING_MIN, RING_MAX)`，`RING_TARGET_MS = 3h`，`RING_MIN = 240`，`RING_MAX = 4320`，**截断在读取时做**（写时修剪会让「调小间隔再调大」造成不可逆丢失），间隔未知时返回 `RING_MAX`（「少给数据的表现像采集坏了」）。

- 写时按物理上限 `RING_MAX` 裁剪；
- `GET /metrics` 的 `limit` 由**读取方**按 `ringSizeFor(device.intervalSec * 1000)` 推导，夹在 `[RING_MIN, RING_MAX]`；
- `limit` 夹取 `10..4320`。

- **决策 7：环不落盘。**
  理由：Host 进程内的历史只是「面板打开时的活视图」；落盘会带来无界写入，而浏览器只在面板打开时读。参考系统落盘是因为它是常驻服务，形态不同。

---

## 5. 方案 C —— 可配置指标

### 5.1 词汇表（11 个键）

```js
METRIC_KEYS     = ["uptime","load","cpu","mem","disk","temp","top","net","diskio","procs","tcp"]
ALWAYS_METRICS  = ["uptime"]
DEFAULT_METRICS = ["uptime","load","cpu","mem","disk","temp","top"]
METRIC_LABELS   = { uptime:"运行时间", load:"系统负载", cpu:"CPU 使用率", mem:"内存",
                    disk:"磁盘容量", temp:"温度", top:"高占用进程", net:"网络吞吐",
                    diskio:"磁盘读写 IO", procs:"进程数", tcp:"TCP 连接数" }
```

**顺序契约**：输出严格按 `METRIC_KEYS` 顺序，不提供用户自定义排序。

### 5.2 归一化

```js
export function normalizeMetrics(metrics) {
  if (!Array.isArray(metrics)) return [...DEFAULT_METRICS];
  const picked = new Set(metrics.filter((k) => typeof k === "string" && METRIC_KEYS.includes(k)));
  for (const k of ALWAYS_METRICS) picked.add(k);
  return METRIC_KEYS.filter((k) => picked.has(k));
}
```

三条必须守住、且**必须有测试**的语义：

1. `null` / `undefined` / 非数组 → 回落 `DEFAULT_METRICS`。
2. **`[]` 是合法输入**，结果只剩 `ALWAYS_METRICS`（`["uptime"]`），**不是**「没配置」→ 回落全默认。（这是最容易被实现错的地方。）
3. 非法键被过滤；`uptime` 强制并入。

### 5.3 「未勾选 ⇒ 不下发命令」

指标选择直接决定**脚本内容**，而不是决定前端显示。未勾选的指标，其命令根本不会进入脚本——设备端真的不执行：

```js
const selected = new Set(normalizeMetrics(device.metrics));   // 已含 ALWAYS
for (const [key, entry] of Object.entries(plan)) {
  if (!isCollectorSelected(key, selected)) continue;   // 未勾选 → 一条命令都不发
  …
}
```

`commandPlan(metrics, customCommands)` 只返回被选中（且已合并自定义覆盖）的条目。**门控在覆盖之前**：自定义命令覆盖体也只对已勾选指标生效。

### 5.4 收集器 → 指标键的映射

| 指标键 | 收集器 | 命令形态 |
|---|---|---|
| `uptime` | `procUptime` | `/proc/uptime` |
| `load` | `loadavg` | `/proc/loadavg`；**同一条命令里额外数一次 `grep -c '^cpu[0-9]' /proc/stat`**，让负载自带核数 |
| `cpu` | `procStat` | 跨样本差分（见 §5.6） |
| `mem` | `procMem` | `free -m`，必须 `awk '/^Mem:/'` 锚定（否则可能误取 `Swap:` 行） |
| `disk` | `df` | POSIX `df -P -k`，**不是 `df -PT`**（`-T` 插入 Type 列把字段位置整体后移，按列取值全部错位） |
| `temp` | `thermal` | 同时读 `/sys/class/thermal/thermal_zone*` 与 `/sys/class/hwmon/hwmon*/temp*_input`，单位判断（毫摄氏度 vs 摄氏度）留在 JS 侧 |
| `procs` | `procCount` | `/proc` 进程计数 |
| `top` | `ps axo user,pid,pcpu,pmem --sort=-pcpu` | 高占用进程 |
| `net` | `/proc/net/dev` | 跨样本差分 |
| `diskio` | `/proc/diskstats` | 跨样本差分 |
| `tcp` | `ss -tan`，回退 `/proc/net/tcp{,6}` | 必须用 `command -v ss` 判断而不是「跑完看输出是否为 0」——「0 条连接」是合法结果，误判会让空载设备的连接数永远显示回退值 |

### 5.5 上下文收集器（不参与勾选）

本插件另有 3 条命令在 11 键之外，被现有 UI 使用：

| 收集器 | 供给 | 处置 |
|---|---|---|
| `version` | 卡片上的内核行 | **恒定采集**，不参与勾选 |
| `services` | 详情页运行中服务列表 | **恒定采集**，不参与勾选 |
| `rootfs` | 详情页挂载表 | **恒定采集**，不参与勾选 |

- **决策 8：把「上下文采集」与「可配置指标」分成两层。**
  理由：①要满足「和 device-manager 保持一致」，指标词汇表就应是那 11 个键，多塞 3 个会让两份清单漂移；②这 3 条是廉价的一次性读取，且现有 UI 依赖它们，若做成可取消会让既有功能出现空洞。文档必须显式说明这一层，否则后人会以为漏了 3 个键。

### 5.6 速率类指标：用跨样本差分，不用脚本内 sleep

`cpu/net/diskio` 是速率类指标。本插件**已有**跨样本基线机制（`src/metrics.js` 的 `previous(id)`），所以：

- `cpu` 继续用跨样本差分；
- `net` / `diskio` 也改为跨样本差分——真实间隔本来就是比脚本内 `sleep` 造出的窗口好得多的求差窗口，而且**完全不需要在设备上 sleep**。

- **决策 9：不移植参考系统 ADR 42 的脚本内 sleep。**
  理由：ADR 42 的动机是「三个 0.5 s 窗口串行睡三次浪费 1.5 s」，而本插件根本没有窗口内 sleep；强行加入 sleep 会让每次采集白等 0.5 s。**这是有意的偏离，必须在此记录**，否则看起来像漏实现。
  代价：`net`/`diskio` 的速率依赖「上一次采集」存在；首次采集只能给 `null`（用 `numOrNull` 断线，不画成 0）。

### 5.7 阈值配置化

阈值从模块常量改为可配置（`settings.thresholds`）：

- 键名 `{cpu, mem, disk, temp}`；默认值 `{cpu: 90, mem: 90, disk: 85, temp: 80}`。
- 夹取范围 `0..200`；**阈值 `0` = 关闭该指标的告警**（同时天然避免「阈值为 0 时 0 值恒触发」这个陷阱）。
- 只有 `cpu`/`mem`/`disk`/`temp` 四项参与阈值告警；`net`/`diskio`/`procs`/`tcp` **只采集、展示、画波形，不参与告警**（告警引擎建立在「0~100 百分比」假设上，接入速率类指标需要先解耦）。
- 校验必须用 `Number.isFinite`，不能只判 `NaN`——`NaN >= limit` 恒为 `false`，会让该指标告警**静默失效**且没有任何报错。

### 5.8 前端门控（`hasMetric`）

两条不可混淆的情形：

| 情形 | 判据 | 渲染 |
|---|---|---|
| 未勾选 | 配置 `device.metrics` 不含该键 | **整行不渲染**（因为命令根本没发） |
| 勾了但这次没读到 | 值 `null`，但配置里**有**该键 | 渲染 `--`（真的在采，只是没读到） |
| 字段缺失（老设备） | `device.metrics` 为 `null`/`undefined` | **一律全显示** |

```js
function hasMetric(device, key) {
  const set = metricSet(device);        // null/undefined ⇒ null
  return set === null ? true : set.has(key);   // 未知 ⇒ 显示一切
}
```

- **决策 10：字段缺失按「全显示」处理，不按「一个都没勾」。**
  理由：老设备记录里没有 `metrics` 字段；若判成「一个都没勾」，升级后所有老设备卡片会突然只剩运行时间，**用户会以为设备坏了**。
- **决策 11：行可见性取配置，不取结果是否为 null。**
  理由：两者语义**相反**。只看「值是 null」会把「没勾」（该藏）和「勾了没读到」（该显 `--`）合并成一个结果——把行藏掉等于用显示层掩盖采集异常。

### 5.9 指标清单由服务端下发

**前端不硬编码指标清单**。专用路由 `GET /catalog` 返回
`{ catalog: metricCatalog(), maxDevices, metricKeys }`，其中 `catalog` 是
`{ key, label, hint, always }` 数组（展示顺序即 `METRIC_KEYS` 顺序）；
`GET /settings`（含 `PATCH` 回包）同样携带 `catalog` 字段，客户端两处都会消费。

- **决策 12：照抄。**
  理由：加一个指标只需改 Host 一处；两份清单一定会漂移，那样用户勾的框和实际采集的对不上。

### 5.10 设置存储

扩展 `$DSH_HOME/dsh-device-monitor.json`，在顶层 `devices` 旁新增 `settings`（完整形状见 §8.4）。

- 落盘继续走**临时文件 + `renameSync` + `mode 0o600`**。
- `version` 升到 `2`：读到 `version: 1` 的老文件必须能平滑升级（缺 `settings` 补默认，缺 `device.metrics` **保持缺失**、不写默认进去，以保住决策 10 的语义）。

- **决策 13：设置与设备同文件，不分两个文件。**
  理由：两者必须一起原子写；分文件会出现「设备已保存但设置没保存」的半提交状态，而它们通过「阈值 → 告警」强耦合。
- **决策 14：`refreshIntervalSec` 是全局的，同时允许设备级覆盖。**
  理由：存在非默认的正当需求。全局值决定默认，设备级字段决定该设备实际频率。

---

## 6. 方案 D —— 采集原始数据落盘与异常记录

`collect()` 拿到的设备 stdout 若**解析完即销毁**，某个指标读不出来时，诊断信息只剩一个 `null`，无法回答「设备到底回了什么」。调试日志解决不了这个问题——它只记录工具被调用，不记录采集原文。

### 6.1 三个模块，逐层移植

| 模块 | 职责 |
|---|---|
| `src/rolling-file.js` | **只管文件**：路径、按大小轮转、按新→旧列出全部滚动份 |
| `src/raw-log.js` | **只管记录格式**：纯文本块 + 设备名净化 |
| `src/jsonl-log.js` | **只管 JSONL**：每行 `JSON.stringify(rec)`（审计 / 异常记录用） |

- **决策 15：三层分开，不合并成一个文件。**
  理由：轮转与「跨全部滚动份读取」的语义必须**只有一份实现**。复制成两份的话，将来只修好一处（例如轮转时忘了先删最旧那份）另一处不会跟着变，而这类缺陷的表现是**历史静默消失**——不报错、只是更早地丢数据，最难被发现的一类。

写入路径的子目录不需要新代码：`appendText` 本来就是 `fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })` 再 `appendFileSync`，`path.dirname` 会给出 `…/log/devices`，`recursive: true` 把 `log/` 与 `log/devices/` 一并按 0700 建出。

### 6.2 落盘位置与格式

```js
RAW_LOG_MAX_BYTES  = 20 * 1024 * 1024;   // 单文件 20MB
RAW_LOG_KEEP       = 3;                  // 保留 3 份 ⇒ 每台上限 60MB
RAW_LOG_RECORD_MAX = 256 * 1024;         // 单条记录 256KB
RAW_LOG_DIR        = "log/devices";      // 相对日志根
```

- 设备日志路径：`<logRoot>/log/devices/<净化名>-<id 前 8 位>.log`
- **目录与文件名权限 `0700` / 文件 `0600`**。
- 记录形状：首行 `` `${ISO 时间} - ${设备名}` ``，其余为原始回显，块末保证换行，**块之间不插空行**（空行会让 `tail` 翻页多出一屏空白）。

- **决策 16：按设备分文件，不是全部塞进一个 `raw.log`。**
  理由：混合文件里每个块虽带设备名，但要回溯某台设备的历史就得先逐块辨认名字——而「回溯某台设备回了什么」正是这个功能的**唯一用途**。分文件后单台的回看窗口也不会被别的设备的采集量挤掉。
- **决策 17：`id` 前 8 位后缀不是装饰，是正确性。**
  理由：本插件允许重名设备（`uniqueId` 只保证 id 唯一，不保证 name 唯一）。只按名字命名会让第二台设备**静默 append 进第一台的文件**——写入照常成功、目录照常建出、文件名照常合法，唯一变化是两台设备的回显混在一起且没有任何迹象。因此**必须在真实采集路径上断言磁盘结果**，而不是只测 `formatRecord` 这个纯函数。
- `sanitizeDeviceName(name)` 含 Windows 保留名前缀 `_`：设备名是用户可控自由文本，一个叫 `../settings` 的设备会让日志写到目录外，`a/b` 会在 `devices/` 下建出子目录——这是**路径穿越**，不是洁癖。

### 6.3 异常记录

「异常记录」有两层，**两层都要做**，且**都不与日志混写**：

**(a) 采集失败也写进原始数据日志。** `error` 非空时体为 `` `[失败] ${error}` ``。只在成功时记录等于把最有排查价值的一半丢掉——「为什么这个指标读不出来」几乎总是失败场景。

**(b) 异常状态机独立于日志**（`src/incidents.js`）：

| 异常 | 判据 | 状态迁移 |
|---|---|---|
| 掉线 | 连续失败次数 ≥ `offlineAfter`（默认 **2**） | `online → offline`，恢复时 clear |
| 恢复 | 失败计数归零 | `offline → online`，记录 `downSeconds` |
| 重启 | 本次 `uptimeMs` 比上次**下降**超过 `rebootMinDrop`（默认 120 s） | 累计 `rebootCount += 1` |

- **决策 18：掉线判据是「连续 N 次失败」，不是「第一次失败」。**
  理由：一次网络抖动就报掉线，会让告警变成噪声，用户很快学会忽略它。
- **决策 19：掉线告警每次采集都刷新文案，而不只在跨过阈值那一次。**
  理由：只记一次的话，页面会一直停在第 3 次失败的文案上，而设备其实已经连续失败 50 次了——用户看着「3 次」会以为它快恢复了。实现上要求 `fire()` 对**已存在**的告警只累加 `count` 并刷新 `message`，不追加流水，否则会刷爆日志。
- **决策 20：异常状态纯内存，不落盘。**
  理由：落盘会让「重启」变成攻击者的一个免费解锁手段（重启服务即清零计数），而不落盘的代价只是重启后计数归零——而重启本身已经需要主机权限。代价照实记录：重启服务后 `rebootCount` 归零、离线基准值丢失。
- **决策 21：异常记录与原始数据日志分开存，互不写入。**
  理由：原始回显体积是异常记录的数百倍，写在一起会在几小时内冲掉异常历史。两者职责不同——原始日志回答「设备回了什么」，异常记录回答「设备何时不正常了」。

### 6.4 异常记录怎么让用户看见

- **右栏卡片角标**：`TabDescriptor.badge` 返回当前异常设备数，**面板没打开时用户也能看到有异常**。
- **卡片内异常条**：处于 `offline` 的设备卡片顶部显示醒目状态条，含「已连续失败 N 次」与原因。
- **详情页异常区**：显示 `rebootCount`、`downSeconds`、最近若干条异常记录（读 JSONL，新→旧、跨全部滚动份）。
- 阈值告警（`evaluateAlerts`）与异常状态机是**两套东西**，分别命名、分别展示：阈值告警是「值超线」，异常是「连不上 / 重启了」。合并会让「CPU 90%」和「设备离线」看起来是同一类事件。

- **决策 22：`rawLog.enabled` 默认开启且落盘。**
  理由：风险是**磁盘占用**而不是权限，用户关掉后重启又自己打开，会让「我明明关了」变成不可解释的现象。默认开启是因为它正是诊断能力的来源。
- **决策 23：原始数据日志完全不做脱敏，且必须让用户知道。**
  理由：它就是原始数据。自定义采集命令若写了 `cat /etc/shadow` 或 `env`（含令牌），输出会原样进这个文件。0700/0600 是唯一保护，因此它**只写本机、绝不进 HTTP 响应、绝不进模型上下文**——这一点在 README 与设置界面都要显式告知。
- **决策 24：写失败只告警，绝不影响采集。**
  理由：日志是旁路。磁盘满时不能让「采集」这个主功能跟着挂掉。
- **决策 25：同步 `appendFileSync`，不用异步。**
  理由：2.2 KB 的同步追加约 0.1~0.5 ms，10 台 60 秒间隔是 0.17 次/秒，开销可忽略；而异步追加会引入「进程退出时最后几条丢失」与「写入顺序不保证」两个新问题，对要求「就是原始数据」的日志得不偿失。

### 6.5 日志根与设置项

```
<logRoot> = $DSH_HOME/dsh-device-monitor-logs
```

- **决策 26：日志不放进配置同目录的 `data/`，而是独立目录。**
  理由：设备配置是**必须备份的私有数据**（含凭据），原始日志是**可随时丢弃的旁路数据**（可能 60MB/台）。放在一起会让用户备份配置时意外备份 600MB 日志，也会让「删配置」时纠结日志怎么办。
- 设置项：`settings.rawLog = { enabled: true }` 与 `settings.incidents = { offlineAfter: 2, rebootDetect: true, rebootMinDrop: 120 }`，夹取范围：`offlineAfter` 1–20、`rebootMinDrop` 1–3600。
- 删除设备时**连带删除其全部滚动日志份**，保持「删设备就是删干净」；设备改名时日志文件跟着改名且**不丢历史**（base 与 base.1…base.N 一起 rename，失败只告警）。

### 6.6 读取接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/rawlog?id=<id>&limit=<n>` | 读某台设备最近若干行（新→旧，**跨全部滚动份**） |
| `GET` | `/incidents?id=<id>` | 读异常状态与最近若干条异常记录 |
| `GET` | `/logs/status` | 日志体量（文件数、字节数）——设置页显示磁盘占用 |

- 全部继续走 `guard()`（回环围栏 + 方法校验）。
- **`limit` 必须夹取**：读取要读整个文件再切片，不夹取会让一次请求把 20MB 读进内存。
- **必须跨滚动份读**：只读当前文件的话，日志一滚动界面就整片变空——历史还在磁盘上，只是改名成了 `.1` 没人去读。

---

## 7. 方案 E —— 终端调试

### 7.1 能力边界（不是模拟器）

终端**不是终端模拟器**：没有 xterm，是手写的文本窗格 + 控制键条。`vim`/`top` 等全屏类程序显示不会正确，日常命令不受影响。ANSI 输出被剥除且不解释（颜色、光标、模式切换全删；`\r` 归一为 `\n`；跨帧半截序列扣住等下一块，上限 512B）。输出**必须 base64 过线**：无效 UTF-8 字节被解码成 U+FFFD 会让花屏彻底不可读。

**「扩大」填满面板所在的那一栏，不是浏览器全屏**：用 `absolute` + 百分比、参照本插件自己的 `.ddm-view`（`position: relative`），刻意不用 Fullscreen API，也不依赖宿主祖先。按钮文案是「⛶ 扩大/还原」，没有「全屏」二字。新开的终端总从右下角开始，上一次会话的展开状态不会被带进下一个会话。同一时刻只有一个终端；非所属座位不渲染浮层。

### 7.2 WS 传输协议

终端不复用只读推送那条 WS 通道，自己占一条升级路径：

| 方向 | 帧 | 说明 |
|---|---|---|
| → | `{t:"open", deviceId, cols, rows, by}` | 唯一能建立会话的帧 |
| ← | `{t:"ready", session:{id,deviceId,deviceName,host,username,from}, limits:{maxPerDevice:3,maxTotal:10}}` | 会话建立；**客户端只在这里清掉 8 秒连接守卫** |
| → | `{t:"in", data}` | **明文**，逐字节原样转发，绝不记日志 |
| → | `{t:"resize", cols, rows}` | 维度经 `clampDimension` 夹取 |
| → | `{t:"close"}` | 主动关闭 |
| ← | `{t:"out", data:<base64>}` | 输出**必须 base64** |
| ← | `{t:"exit"}` | shell 结束，socket 以 `1000` 关闭 |
| ← | `{t:"error", reason, message}` | 拒绝；socket 以 `1008`（policy violation）关闭 |

- **8 秒连接守卫**只在 Host 回 `ready` 帧时清除——`onopen` 不清、`onerror` 不清（拒绝与没到长得一样，必须能区分）。
- **回车提交发的是 `\r` 而不是 `\n`**（否则设备上的 shell 不会执行）。
- **在途标志（`opening`）**：`session` 只在拨号 resolve 之后才被赋值，同一 tick 里到达两个 `open` 帧时两者都会通过 `if (session !== undefined) return;`，于是拨号两次并孤立一个活着的 shell。修法是 `let opening = false;` 与 `if (session !== undefined || opening) return;`。拨号完成时 socket 可能已经死了，必须补一刀 `if (ws.readyState !== 1) { manager.close(result.session.id, "连接已断开"); return; }`。
- **socketId 由服务端推导**（`${remoteAddress}:${remotePort}:${rand}`），绝不采信客户端自报的值：否则一个客户端可以声称自己拥有别人的 socket 并把那个终端关掉。
- `src/terminal-route.js` 的 `serveTerminal(ws, req, manager, logger)` **接收 manager 而不是自己去取**，这样传输层可以在假 socket + 注入的 PTY 上被完整驱动。

### 7.3 安全围栏（三重）

终端默认**关闭**，须在设置里打开（`terminal-smoke` 对全新 store 断言默认关闭；`enabled` 必须是真的布尔 `true`，字符串 `"true"` 不生效）。

1. **回环**：升级请求**不经过** JSON 路由的 `guard()`，所以升级处理器**必须自己重做一遍** `isLoopbackRequest()`——少这一层，一个非回环的连接就能直接拿到一台设备的 shell。`GET /terminal/status`（普通 JSON 路由）与 `GET /terminal`（WS 升级路径）**故意是两条独立路径**，由一条断言钉住分离（`path === TERMINAL_PATH` 且 `!== API.terminal`）。
2. **允许列表**：`terminal.allowedHosts` 非空时只允许列表内的设备；列表**只以条数**出现在 `/terminal/status` 里，绝不回传列表本身；列表为空时走回环围栏。
3. **受信来源**：`dsh-app://app` 是受信来源，但**只在 socket + Host 头都回环之后**才求值（`dsh-app://shell` 故意排除）。桌面壳的页面在 `dsh-app://app`、`location.origin === "null"`，拼出 `ws://app/...` 这样的无 authority URL 会被 Chromium 本进程内拒绝——Host 地址必须取 `__DSH_TRANSPORT__.streamBaseUrl`（回退 `document.baseURI`），不取 `window.location`。

上限与超时：同一时刻最多 10 个会话、每台设备最多 3 个；空闲超时下限 30 秒（`resolveIdleMs`：0/负数/非数 → 默认 300 秒，正数但低于下限 → 抬到下限）。

服务端**不做命令内容检查**：默认关闭 + 回环/允许列表 + 上限与空闲超时 + 审计补偿。这个取舍在设置页显式告知（「定时自动执行」「不受命令白名单约束」）。

### 7.4 审计

- 升级请求在**判定之前**先记一条 `terminal.upgrade`（只记 `from`/`host`/`origin`/`site`/`url` 五个头部输入，永远不记 cookie、不记凭据），三条静默出口各自再记一条：`terminal.upgradeDenied`（403）、`terminal.upgradeUnavailable`（503）。
- 会话建立/关闭记 `terminal.open` / `terminal.close`（含字节数）。**拒绝与没到必须可区分**——没有审计行的那条路径，用户看到「无法建立终端连接」时无从回答「是被拒了还是根本没到」。

---

## 8. 数据模型与 API

### 8.1 设备行新增字段

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `metrics` | `string[] \| undefined` | **缺省（不是 `DEFAULT_METRICS`）** | 勾选的指标键。**缺省 = 从未配置**，前端按「全显示」处理；显式 `[]` = 只留 `uptime` |
| `intervalSec` | `number \| undefined` | 缺省 → 取全局 | 设备级刷新间隔覆盖，`5..3600` |

写入路径三处都接：
- `POST /devices` → 创建时 `metrics: normalizeMetrics(body.metrics)`，但 **`body.metrics` 缺失时保持 `undefined`**；
- `PATCH /devices/:id` → `if (body.metrics !== undefined) …`（省略字段**不得**清空勾选）；
- 老文件读取 → 不补字段。

### 8.2 路由一览

`API_BASE = "/api/dsh-device-monitor"`；15 条 exact 路由 + 1 条 WS 升级路径；全部走 `guard()`（回环围栏 + 方法校验），终端升级路径除外（自己重做回环检查，见 §7.3）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/overview` | 概览；`devices[]` 含 `metrics`、`intervalSec`、`incident`（异常摘要，供 badge 与卡片状态条） |
| `GET/POST/PATCH/DELETE` | `/devices` | 设备增删改查（含凭据字段，仅 authKind 等摘要出网）；`PATCH`/`DELETE` 用 `?id=` 定位 |
| `POST` | `/test` | 已保存设备的试连 |
| `POST` | `/test-draft` | 未保存草稿的试连（无副作用三纪律：不落盘、不广播、不审计） |
| `POST` | `/collect` | 立即采集一台或全部 |
| `GET` | `/metrics?id=&limit=` | 最新样本 + series；`limit` 夹取 `10..4320` |
| `POST` | `/exec` | 在设备上执行命令（审计只记 `commandLength`） |
| `GET/PATCH` | `/settings` | 设置读写（`GET` 还下发指标词表） |
| `GET` | `/catalog` | 指标词表：`{ catalog: metricCatalog(), metricKeys, maxDevices }`——词表由 Host 下发，client 不硬编码（见 §5.9） |
| `POST` | `/watch` | 租约心跳，返回 `{ok:true, leaseMs}` |
| `GET` | `/rawlog?id=&limit=` | 原始回显（新→旧，跨全部滚动份） |
| `GET` | `/incidents?id=` | 异常状态 + 最近异常记录 |
| `GET` | `/logs/status` | 日志体量 |
| `GET` | `/audit?limit=` | 审计记录（新→旧） |
| `GET` | `/terminal/status` | `{available, enabled, path, sessions, count, maxTotal, maxPerDevice, allowedHosts:<条数>, idleMs}`。**只回条数，绝不回允许列表本身** |
| WS | `/terminal` | 终端会话（见 §7.2） |

### 8.3 `series` 点格式

```js
{ ts, cpu, mem, disk, temp, net, diskio, procs, tcp }
```

**缺失一律 `null`，绝不用 `0` 顶替**（`numOrNull` 纪律）。CPU 首次采样仍为 `0`（有基线语义，不是缺失）。

### 8.4 `settings` 区形状

```json
{
  "version": 2,
  "devices": [ { "id": "nas-a", "metrics": ["uptime","load","cpu"], "intervalSec": 60 } ],
  "settings": {
    "refreshIntervalSec": 60,
    "thresholds": { "cpu": 90, "mem": 90, "disk": 85, "temp": 80 },
    "rawLog": { "enabled": true },
    "incidents": { "offlineAfter": 2, "rebootDetect": true, "rebootMinDrop": 120 },
    "customCommands": { "enabled": false, "overrides": {} }
  }
}
```

- `version: 1` 的老文件平滑升级：补 `settings` 默认；**不补** `device.metrics`（保住决策 10 的语义）。
- `customCommands`：默认关闭；**严格布尔**（只接受真 `true`，字符串 `"true"` 会变成永久后门）；覆盖体**替换**该指标键的命令，但**不改变**「未勾选就不下发」的门控（门控在前）；每次实际执行覆盖命令写审计；单段命令体长度上限 2000 字符；空对象 / `null` = 清空全部覆盖。

---

## 9. 测试与验证

### 9.1 套件与断言计数

**常驻离线套件（作者工作树）**：`smoke` 244、`activate-smoke` 72、`settings-smoke` 332、`rawlog-smoke` 115、`ssh-integration` 92、`client-smoke` 384、`terminal-smoke` 162、`verify-ssh-resolution` 25、`verify-ssh-fix-causality` 13、`verify-audit-verdict` 24，共 **1463 条**。
**打包运行时验证器**（`ELECTRON_RUN_AS_NODE=1` 跑 DSH_EXE，缺 exe 时大声 SKIPPED）：`verify-define-tool` 16、`verify-host-boot` 25、`verify-fresh-boot-e2e` 67。
**分发验证**：`pack-dist` 51（pre/post-flight 自检，回答「打出来的包里到底有什么」）+ `verify-dist-installable` 19（解包到新目录按解出来的那份解析）。
`tools/run-all.ps1` 把常驻套件、打包运行时验证器与分发验证一起跑：**TOTAL 1641 / PASSED 1641 / FAILED 0**。

**联机套件**（需要运行中的 Host 与真实设备，不在常驻计数内）：`verify-live-gui` 105（只检查能区分新旧两代的东西：指标词表、新路由、下发 bundle 标记）、`live-ssh-e2e` 98（真实采集链路：勾选→采→落盘→审计）、`live-terminal-e2e` 12（连真实升级路由、开真 shell、跑一条只读命令等到回显；终端未打开时它报 SKIP 并以 0 退出）。

**变异测试**：`tools/run-mutations.ps1` 逐条应用 **73 个变异体**（每个变异体一个独立子进程：`apply-mutation.mjs apply` → 跑负责它的套件 → `restore`），**73/73 全部被捕获、0 存活**。存活即测试缺口，脚本以非零退出码报错。目标到套件是**一对多**的（`client` → `client-smoke`，`collectors` → `smoke`，`terminal`/`route` → `terminal-smoke`，`host` → `activate-smoke`，`http`/`tools` → `smoke`，`monitor` → `settings-smoke` + `smoke`，`manifest` → `pack-dist`）。

> **变异结论只在基线为绿时才算数。** 套件本来就红的时候，任何「被捕获」都是假的。先去确认基线，再去相信判决。

### 9.2 关键覆盖点

- `normalizeMetrics` 三语义（`null`→默认 / `[]`→仅 uptime / 非法键过滤）；`ringSizeFor` 边界；阈值夹取与 `0`=关闭；`sanitizeDeviceName` 路径穿越与 Windows 保留名；`clampBytes` 不切断多字节字符。
- `hasMetric` 三情形；`numOrNull`；波形断线；全文件扫描禁止 `Number.isFinite(Number(`；指标清单来自服务端、不硬编码。
- **断言实际下发的命令字符串**——只勾 `mem` 时设备端**绝不应**收到 `cat /proc/stat`（R3 最核心的行为断言）；自定义命令四线（覆盖体到达 / 内置体被替换而非追加 / 字符串 `"true"` 不触发 / **未勾选指标上的覆盖一条命令都不跑**）。
- 右栏 Tab：`registerTab` 被调用、`id==="device-monitor"`、`single===true`、`order===60`、`title()` 跟随语言、**`visible` 被转发给面板**、无 better-sidebar 时返回 null 且 `apply` 不抛、两个座位照常注册。
- 端到端（`verify-fresh-boot-e2e`）：勾选 → 采 → 波形数据 → 租约过期后定时器不再拨号；采集失败也写进原始日志；连续 2 次失败触发掉线。
- 终端：帧编解码、上限 3/10、空闲超时下限、拒绝路径、`\r` 提交、base64 输出、8 秒守卫只在 `ready` 清除、`opening` 在途标志、服务端推导 socketId、升级路径与 JSON 路由分离。
- 审计 HARD RULE：`device_exec` 审计行**不含命令文本**（只含设备与 `commandLength`）；断言按**密码形状的 token** 匹配——泄漏在字段名之外也必须被抓到；「什么都没记」与「记了但没敏感内容」必须可区分。
- `device_history`：按设备过滤时**读整份日志再过滤**（先截断再过滤会让「每晚都掉线的设备」在日志变长后报成空历史）；合并异常与审计两个日志、按时间倒序、可按 `kind` 过滤。
- 分发（`pack-dist` / `verify-dist-installable`）：`cordis.patch.yml` 真的在 `files[]` 里也真的在包里；代码 `require` 的每个非相对、非 `node:`、非 `@deepseek-ai/` 模块都在 `dependencies` 里；守卫清单**写在源码里**（`REQUIRED_FILES` + `EXPECTED_ROSTER_SIZE=9` 长度锚点），不是从 `files[]` 读出来的；设备名单不在包里。

> **测试纪律的完整记录见 [`PITFALLS.md`](PITFALLS.md)**（18 个坑，含「测试替身以命令原文为键会把失配伪装成设备没数据」「验证自己的守卫永远对」「替身补齐了产品不敢依赖的事件，就等于替产品做了它必须自己做的事」等）。

### 9.3 验收清单

- [ ] 右栏「+」菜单出现「设备监管」，点开后设备卡片常驻右侧，聊天区同时可见
- [ ] 右栏内可完成「列表 → 详情 → 添加 → 编辑 → 删除」全流程，无需切主区
- [ ] 未启用 better-sidebar 时，插件降级为主区，`apply` 不抛异常
- [ ] 主区与右栏同时打开时**只有一个定时器**、一条心跳
- [ ] 面板可见时每 60 s 自动刷新；关闭面板后 Host **停止**拨号（租约过期）
- [ ] 「设置」里改刷新周期后，租约与定时器**立即**按新周期重建（不是等下次挂载）
- [ ] 一次刷新 tick **不会**抹掉「设置」里尚未保存的输入（引用身份稳定）
- [ ] 卡片上「添加设备」「编辑设备」表单在**右栏内**完成，不跳回主区
- [ ] 「自定义采集命令」默认关闭；打开后未勾选的指标**一条命令都不下发**；空白行等于用回内置命令
- [ ] 每张卡片有 CPU / 内存 / 磁盘 / 温度 4 条波形；缺失值断线而非画 0
- [ ] 每台设备可勾选 11 个指标；`uptime` 强制勾选且禁用交互
- [ ] 只勾 1 个指标时，SSH 抓包/假设备断言**只收到对应命令**
- [ ] 阈值可改；设为 `0` 时该指标不再告警
- [ ] 老设备（无 `metrics` 字段）升级后**全部指标照常显示**
- [ ] `GET /settings` 下发指标清单，前端无硬编码清单
- [ ] 每台设备一个原始日志文件，落在 `log/devices/`，权限 `0600`；单条超 256KB 截断并注明
- [ ] **采集失败也在日志里留痕**（`[失败] <原因>`），不是只在成功时写
- [ ] 连续 2 次失败才判掉线；恢复后清除；阈值告警与异常记录**分开展示**
- [ ] 面板未打开时，异常通过右栏 Tab **badge** 可见
- [ ] 删除设备连带删掉其全部日志滚动份；改名后日志跟着改名且历史不丢
- [ ] 原始数据日志**不出现在任何 HTTP 响应体里**（只有条数与行文本，且不进模型上下文）
- [ ] 编辑页的勾选框是 15px 小方块，没有被全宽输入规则拉成整列宽；文字不被挤到一边
- [ ] 设备卡片的趋势图**一行一个指标**；没有波形列的指标在旁边的数值条里并排显示
- [ ] 已有波形列的指标**不再重复**出现在数值条里（`load` 反而是**必须**出现的那一项：它没有波形列，只以数值形式出现，并带上核数）
- [ ] 从未采集过的指标显示 `—`，绝不编造 `0`
- [ ] 每个波形都印出**横纵坐标**：y 轴给出高/低两个刻度，x 轴给出首/末两个时间戳
- [ ] 坐标轴的刻度与线**同源**——两者读同一个 `scale` 对象，轴**不得**自己重算一遍
- [ ] 画不出线的列（数据不足或有缺口）**不印坐标轴**，而不是印一个框住空白的框和编出来的数字
- [ ] `dsh.bundle.patch` 指向的 `cordis.patch.yml` **真的在 `files[]` 里**，也真的在 `npm pack` 的产物里
- [ ] 代码里 `require` 的每个非相对、非 `node:`、非 `@deepseek-ai/` 模块都**在 `dependencies` 里声明**
- [ ] 把 tarball **解开到一个新目录**后，`dsh.bundle.patch`、每个 `exports`、`index.js` 的整个导入图都能按**解出来的那一份**解析
- [ ] 守卫本身非空：把 `cordis.patch.yml` 从 `files[]` 拿掉再打包，验证器**报 FAIL 并以 1 退出**（不是抛栈崩溃）
- [ ] 设备名单**不在包里**——密码不跟着代码走，换机器重新登记
- [ ] 卡片上的按钮是「终端调试」，不是「测试连接」；表单里的「测试连接」**保留**
- [ ] 终端默认**关闭**；没在设置里打开时，点按钮只提示「终端未开启」，且**一个 socket 都不建**
- [ ] 打开后浮层停在右下角（**不是模态**），对话区同时可见——用 `absolute` + 百分比，参照本插件自己的 `.ddm-view`（不用 `position:fixed`，也不依赖宿主祖先）
- [ ] 点「⛶ 扩大」填满**面板所挂载的那一栏**（侧边栏座位就是右侧栏）、**永不铺满窗口**，且「⛶ 还原」一定回得来；按钮上**没有**「全屏」二字
- [ ] 新开的终端总是从右下角开始，上一次会话的展开状态不会被带进下一个会话
- [ ] 8 秒连接守卫**只在 Host 回 `ready` 帧时**清除——`onopen` 不清、`onerror` 不清
- [ ] 回车提交发的是 `\r` 而不是 `\n`（否则设备上的 shell 不会执行）
- [ ] 输出以 base64 过线，无效 UTF-8 不被打成 U+FFFD
- [ ] 同一时刻只有一个终端；非所属座位不渲染浮层
- [ ] 终端设置排在**所有只读设置之后**；`idleMs` 界面显示秒、存储用毫秒
- [ ] 允许列表里没有任何条目时走回环围栏；列表**只以条数**出现在 `/terminal/status` 里
- [ ] 浏览器拿到的 socket 路径**就是** Host 真正服务的那个：连真实升级路由、开一个真 shell、跑一条只读命令并等到回显（`live-terminal-e2e`）
- [ ] 编辑页密码框**留空**时点「测试连接」**能连上**（Host 补已保存的密码，与保存的合并语义一致）
- [ ] 但**填了错密码必须仍然失败**（回填是「补缺失」，不是覆盖用户输入）——`live-draft-e2e` 的 4 项判定
- [ ] 变异测试 73/73 被捕获、0 存活（`tools/run-mutations.ps1` 退出码 0）
- [ ] `device_exec` 的审计行**不含命令文本**（只含设备与 `commandLength`）；断言按密码形状的 token 匹配，泄漏在字段名之外也必须被抓到
- [ ] exec 的审计行**确实存在**——「什么都没记」与「记了但没敏感内容」必须可区分
- [ ] 审计日志的 HARD RULE（只记字段名、绝不记值）在**全插件范围**内成立：唯一会写用户自述文本的路径已经被堵住
- [ ] `description` / `location` / `tags` 三者在**卡片和详情页**都渲染；`description`/`location` 带标签前缀，`tags` 每项一个 chip
- [ ] 三项**都没有**的设备**不出现空行**——「没记录」与「记录了空内容」是两句不同的话
- [ ] `group` 字段已从 `src/store.js` 的 normalize 与 summarize 中**删除**（既写不进也读不出的字段不是功能）
- [ ] 第五个 Agent 工具 `device_history` 已注册、有 schema、有 render，且**系统提示里列出了它**
- [ ] 历史**合并**异常与审计两个日志，按时间**倒序**，可**按设备过滤**，可按 `kind` 过滤
- [ ] 按设备过滤时**读整份日志再过滤**，不是先截断再过滤
- [ ] 全队视图与单设备视图的空态文案**不同**：前者说日志为空，后者说这台设备没有记录
- [ ] 发行包里**该有的文件都在**：`LICENSE` / `SECURITY.md` / `README.md` / `icon.svg` / `cordis.patch.yml` / 两个 locale / `index.js` / `client.js`
- [ ] 「应该发什么」的清单**写在源码里**，不是从 `files[]` 读出来的——否则删掉一个条目会连同它的断言一起消失，守卫永远绿
- [ ] 清单本身被钉住：长度断言与查重断言，让「悄悄少一项」红在断言上
- [ ] `docs/` 与 `tools/` **不随包发布**（它们是开发资料，不是产品）
- [ ] 全部离线套件绿；`node --check` 干净
- [ ] 在运行中的 GUI 内实测通过

---

## 10. 范围与不做清单

### 10.1 不做

| 不做 | 理由 |
|---|---|
| 指标自定义排序 | 固定 `METRIC_KEYS` 顺序；排序需要额外的持久化与随之而来的漂移风险 |
| 新增自定义指标段 | 解析层无从下手 |
| 挂载点/网卡/温度传感器的**手动选择器** | 自动挑选（`/` 优先、最高占用、最高温）并把其余折进 tooltip |
| 历史落盘 / 时序数据库 | 见决策 7 |
| `net`/`diskio` 接入阈值告警 | 告警引擎建立在「0~100 百分比」假设上，接入速率类指标需要先解耦 |
| 可配置的历史保留条数 | 保留窗口由间隔推导，用户不需要也不应该直接调 |
| 原始数据日志的 Web 界面 | 它是本机文件，用户直接看文件即可；详情页只提供 `GET /rawlog` 最近若干行 + `GET /logs/status` 体量 |

### 10.2 纳入范围（原评估过「不做」，后按用户要求实现）

**(1) 审计日志。** JSONL 滚动（5 MB × 5 份）。记录：设备增删改、`/test`、`/test-draft`、`/collect`、`/exec`、设置变更、日志开关变更、命令覆盖变更。只读路由 `GET /audit?limit=`。

- **只记字段名，不记值**——设置值里可能有凭据。
- 审计与原始数据日志**分文件**：原始回显体积是审计记录的数百倍，写在一起会在几小时内冲光审计历史。
- 「谁」固定是本机用户（路由强制回环、无多用户），但审计的价值在「什么时候什么被改了」，这与是否多用户无关。

**(2) `test-draft`。** `POST /test-draft`，body 即表单里的设备草稿。成功 200，失败 400 `{error}`。

- **无副作用三纪律**：不落盘、不广播、**不审计**。
- 试连结束（成功或失败）**必须立即 `dispose()`**，否则会泄漏一个 ssh2 连接。
- 与已保存设备的 `/test` 共用同一个底层 `monitor.testConnection(options)`，只差「凭据从 body 来还是从 store 来」。
- **凭据语义必须与保存一致**（`withStoredSecret`）：表单里密码框留空时**只补「缺失」的密码**，显式空串原样保留（空串是「这台设备没有密码」的决定，不是「没填」）。解析优先用表单带回的设备 `id`——这正是 `Store#update` 合并 `auth` 时用的键——无 id（新建设备）才退回 `host`+`port`+`username` 三元匹配。断言打在**公共入口**上（注入拨号替身，检查送到 ssh2 的那一行）：只测 `withStoredSecret` 这个纯函数时，删掉 `testDraft` 里调用的变异仍然存活。

**(3) `customCommands`。** `settings.customCommands = { enabled: false, overrides: {} }`，按指标键覆盖命令体。

- **默认关闭，且落盘**：某台设备就是没有 `ss`、需要永久换成 `netstat`，这是长期生产配置，每次重启都要重填等于让用户放弃这个功能。
- **严格布尔**：只接受真正的 `true`。配置文件里一个手抖的 `"true"` 字符串会变成**永久后门**。
- 空对象 / `null` = **清空全部覆盖**——与凭据「只有非空才覆盖」语义相反，因为清空是有意义的操作。
- 覆盖体**替换**该指标键的命令，但**不改变**「未勾选就不下发」的门控（门控在前）。
- 每次实际执行覆盖命令**写审计**；设置页常驻风险告警（「定时自动执行」「不受命令白名单约束」）。
- 校验：非法指标键拒绝；单段命令体长度上限 2000 字符。
- 风险照实记录：它引入一条**绕过 Agent 工具命令白名单**的执行路径。补偿是三重——默认关闭 + 常驻警告 + 审计留痕，而不是「假装它没有风险」。

---

## 11. 设计决策索引

| 决策 | 主题 | 位置 |
|---|---|---|
| 1–4 | better-sidebar：注册 Tab 而非抢座位 / 不硬依赖 / single / 保留两座位 | §3.3–3.4 |
| 4b–4c | 状态上提共享 store / 右栏三视图状态机 | §3.5–3.6 |
| 5–6 | 租约而非定时器 / 阈值 `2×` | §4.2 |
| 7 | 历史环不落盘 | §4.5 |
| 8 | 上下文收集器与可配置指标分层 | §5.5 |
| 9 | 不用脚本内 sleep，用跨样本差分 | §5.6 |
| 10–12 | 字段缺失全显示 / 行可见性取配置 / 词表服务端下发 | §5.8–5.9 |
| 13–14 | 设置与设备同文件原子写 / 间隔全局默认 + 设备覆盖 | §5.10 |
| 15–17 | 落盘三层分开 / 按设备分文件 / id 后缀防重名混写 | §6.1–6.2 |
| 18–21 | 连续失败判离线 / 告警文案每次刷新 / 状态纯内存 / 与日志分存 | §6.3 |
| 22–26 | 原始日志默认开 / 不脱敏但告知 / 写失败不影响采集 / 同步写 / 独立日志根 | §6.4–6.5 |

---

## 12. 相关文档

| 文档 | 内容 |
|---|---|
| [`PITFALLS.md`](PITFALLS.md) | 18 个真实踩过的坑：测试纪律、替身保真度、等价变异、能跑≠能装、验证自己的守卫等 |
| [`TRADEOFFS.md`](TRADEOFFS.md) | 取舍清单：终端不是模拟器、扩大≠全屏、不脱敏、速率首样本为 null、子进程管道沙箱 EPERM 等 |
| [`SECURITY.md`](SECURITY.md) | 安全模型：凭据处理、三门控、审计规则、原始日志策略、终端围栏 |
| [`../README.md`](../README.md) | 安装、使用、Agent 工具、测试与分享 |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 贡献指南（含测试/变异纪律、文档更新要求） |
