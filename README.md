# 设备监管（dsh-device-monitor）

DSH 插件：在**右侧边栏**（结合 `dsh-better-sidebar`）登记**最多 10 台**设备，
通过 SSH 定时采集运行指标、画波形图，并对 CPU / 内存 / 磁盘 / 温度做阈值告警。
同时在 Host 侧向 Agent 暴露五个工具（含读历史）。

参考系统：一个本地只读的设备托管平台（设计取舍见其 `DESIGN.md` / `IMPROVEMENT-PLAN.md`，
本插件的完整功能设计见 [`docs/DESIGN.md`](docs/DESIGN.md)，安全模型见 [`SECURITY.md`](SECURITY.md)）。

## 功能

| 能力 | 说明 |
| --- | --- |
| 右栏面板 | 通过 `ctx.betterSidebar.registerTab()` 在 DSH 原生右侧边栏获得真实 Tab，**一边对话一边看设备**；主区页面同样保留，两处共用一个状态（左栏入口已按需求移除） |
| 定时刷新 | 默认 **60 秒**一次（可配置 5–3600），可按设备覆盖；采用**租约**机制——面板可见才续约，隐藏即停止拨号 |
| 波形图 | 每台设备一行一个指标（CPU / 内存 / 磁盘 / 温度），环形缓冲按刷新周期自动定容（约 3 小时窗口）；其余数值信息在旁边的数值条里并排显示 |
| 指标可配置 | 11 项指标（运行时间 / 系统负载 / CPU / 内存 / 磁盘 / 温度 / 高占用进程 / 网络吞吐 / 磁盘 IO / 进程数 / TCP 连接数），勾选项**决定下发哪些采集命令** |
| 阈值告警 | CPU / 内存 / 磁盘 / 温度逐项可调，设为 0 即关闭该项 |
| 自定义命令 | **默认关闭**。按指标键替换内置命令体，便于适配非 busybox 的设备；**只替换命令，不打开门控**——未勾选的指标仍然一条命令都不下发。每次实际执行都写入审计日志（只记指标名，不记命令体） |
| 终端调试 | 每张卡片一个按钮，在右下角开一个交互式 shell 浮层（**不是模态**，对话区同时可见）。**默认关闭**，须先在「设置」里打开；不受 Agent 工具的命令白名单约束，输入原样发到设备。上限 3 会话/设备、10 会话/进程，空闲超时兜底。审计只记开关与字节数，**不记击键** |
| 原始日志 | 每台设备的采集原文（未脱敏）写入 `$DSH_HOME/dsh-device-monitor-logs/log/devices/<名称>-<id>.log`，**纯文本块（非 JSONL）**，单文件上限 20 MB、保留 3 份，失败也留痕 |
| 异常记录 | 离线 / 恢复 / 重启检测，独立的 `log/incidents.log`，面板「日志」页可查 |
| 审计日志 | 增删改 / 测试 / 采集 / 设置变更 / 终端开关 / 远程执行，**只记字段名不记值**（`log/audit.log`）。`device_exec` 记的是**命令长度**，不是命令文本——审计日志不该成为用户命令的永久明文副本 |
| Agent 工具 | `device_list` / `device_status` / `device_collect` / `device_exec` / `device_history` |
| 历史查询 | `device_history` 把异常记录与审计记录**合并成一条时间线**（新的在前），可按设备与 `kind` 过滤——回答「这台设备昨晚稳定吗」，而 `device_status` 只能描述此刻 |


## 结构

```
dsh-device-monitor/
├── package.json          插件清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      把本插件插入 profile 的 patch 行
├── index.js              Host 半：注册路由、工具、system prompt 段落
├── client.js             浏览器半：侧边栏入口 + 面板页面
├── icon.svg              面板图标
├── src/
│   ├── store.js          设备名单（$DSH_HOME/dsh-device-monitor.json，0600）
│   ├── ssh.js            SSH 连接 / 执行 / 采集
│   ├── collectors.js     busybox 兼容的指标解析
│   ├── metrics.js        历史样本（环形缓冲）与阈值告警
│   ├── monitor.js        轮询编排、租约、去重
│   ├── settings.js       刷新周期 / 阈值 / 指标 / 日志 / 自定义命令
│   ├── raw-log.js        逐设备原始采集原文（未脱敏）
│   ├── incidents.js      离线 / 恢复 / 重启跟踪
│   ├── logs.js           审计日志（只记字段名）与异常记录
│   ├── rolling-file.js   滚动文件基元
│   ├── jsonl-log.js      JSONL 追加 + 倒序读取
│   ├── series.js         波形图列定义
│   ├── metrics-keys.js   指标词表
│   ├── terminal.js       终端会话策略：闸门、允许列表、上限、空闲兜底
│   ├── terminal-route.js 终端 WS 传输：回环围栏、帧循环、PTY 桥接
│   ├── http.js           回环校验与 JSON 读写
│   ├── routes.js         /api/dsh-device-monitor/* 十五个 JSON 路由
│   ├── resolve.js        从 profile 根解析依赖
│   └── tools.js          device_list / device_status / device_collect / device_exec / device_history
├── locale/{zh,en}.json   面板标题与描述
├── docs/                 设计与踩坑长文（不随包发布）
│   ├── DESIGN.md         功能与设计文档（功能概述、方案决策、数据模型、测试验收）
│   ├── PITFALLS.md       十八个值得记住的坑
│   ├── TRADEOFFS.md      已知取舍
│   └── CONTRIBUTING.md   如何改代码、跑测试、加变异体
├── README.md             你正在读的这一份
├── CHANGELOG.md          版本变更
├── SECURITY.md           凭据、门控、审计范围
├── LICENSE               MIT
└── tools/                测试与校验脚本（不随包发布）
```

> **源文件用 Tab 缩进、LF 换行**（见 `.editorconfig` / `.gitattributes`）。
> `*.pristine` 是**逐字节**的变异基线，任何换行翻译都会让
> `apply-mutation.mjs check` 失败，因此它们被排除在 `eol=lf` 规则之外。

## 安装

插件由 Desktop 外壳管理（`desktop` profile 为保留 profile，普通启动器会拒绝）：

```powershell
# 把这两条改成你自己的实际路径
$exe = 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$cli = 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$src = '<你 clone 本插件的目录>'          # 例如 D:\code\dsh-device-monitor

$env:ELECTRON_RUN_AS_NODE=1
& $exe --expose-internals $cli plugin --profile desktop add $src
```

> asar 内层的那条路径 `Test-Path` 会返回 `False`（Win32 看不进 asar），但
> **Electron 的 fs 补丁读得进去**，这条命令本身是有效的。跑起来若报
> `EPERM … package.json.lock`，那是权限问题，不是路径不存在。

安装后 `GET /api/dsh-device-monitor/overview` 返回
`{"devices":[],"maxDevices":10}`。

> **终端调试还需要 Host 提供 `webServer.registerUpgrade`**。若宿主的
> `dsh-host-webserver` 版本较旧、没有这个方法，插件会记一条 warn 并**只停用终端**，
> 其余功能（路由、工具、面板）照常工作——`activate-smoke.mjs` 里有一组断言专门钉这条降级路径。

## 分享到另一台电脑

在作者机器上能跑，**不等于**在别人的机器上能装。这台机器上有三样东西是
tarball 必须自己带上或自己声明的，而它们的缺失**在作者的工作树里完全看不出来**：
文件还在那里。所以分发有自己的一道验证，见下面的「为什么需要单独验一次」。

```powershell
# 1. 在作者机器上：打包，并把打出来的包解开再验一遍能不能装
$N = '<本机 node.exe>'
& $N tools\pack-dist.mjs              # -> dist\local-dsh-device-monitor-1.0.0.tgz
& $N tools\verify-dist-installable.mjs
```

把 `dist\local-dsh-device-monitor-1.0.0.tgz` 拷到另一台电脑，然后：

```powershell
# 2. 解到一个**纯英文、无空格**的目录（路径会进 package.json 的 link: 值）
$target = 'C:\dsh-plugins\dsh-device-monitor'
New-Item -ItemType Directory -Force $target | Out-Null
tar -xzf local-dsh-device-monitor-1.0.0.tgz -C $target --strip-components 1

# 3. 用 Desktop 外壳的 CLI 安装（这台机器上的路径，与「安装」一节同形）
$exe = 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$cli = 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$env:ELECTRON_RUN_AS_NODE=1
& $exe --expose-internals $cli plugin --profile desktop add $target

# 4. 验收：应返回 {"devices":[],"maxDevices":10}
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-device-monitor/overview' -UseBasicParsing
```

`--strip-components 1` 是必需的：包里所有条目都在一个 `package/` 根下，
不去掉这一层，`files[]` 里那些路径就会多一级前缀而**一个都对不上**。
`pack-dist.mjs` 跑完会把这条命令连同实际产物的文件名一起打印出来。

设备名单**不在包里**。它是 `$DSH_HOME\dsh-device-monitor.json`（含明文密码，
权限 `0600`），换机器要重新登记——这是有意的：密码不该跟着代码走。

### 为什么分发需要单独验一次

三个缺陷的共同点是：**它们都是「在作者机器上仍然能跑」**。

| 缺陷 | 工作树里 | 装到别的机器上 |
|---|---|---|
| `cordis.patch.yml` 不在 `files[]` | 文件在，一切正常 | `npm pack` 悄悄不打包它，而 `dsh.bundle.patch` 指向它 → 装上了却**永远加载不出来** |
| `ssh2` 没有声明为依赖 | 能解析——因为另一个插件（`@linxin666/dsh-ssh`）恰好把它提升到了 profile 的 `node_modules` | 全新 profile 里没有东西提升它 → Host 半 `cannot load the ssh2 module` |
| `ws` 没有声明为依赖 | 同上 | 同族，但轻一些：`ws` 缺失只让**终端**降级（路由回 503 并记一行审计），其余照常 |

`pack-dist.mjs` 因此分两段：**pre-flight** 读清单自己的说法（patch 声明了吗、
依赖覆盖代码真正 `require` 的模块了吗），**post-flight** 读**打出来的那个包**
（`npm pack` 遵守 `files`/`.npmignore`，所以 pre-flight 全绿**不能说明**包里有什么）。
`verify-dist-installable.mjs` 再进一步：把包解开到一个新目录，**按解出来的那一份**
去解析 `dsh.bundle.patch`、`exports` 和目标模块——只有作者工作树里才成立的路径会在这里失败。

这两个脚本的守卫本身也被证明过不是空的：把 `cordis.patch.yml` 从 `files[]` 里拿掉
再打一个包，`verify-dist-installable.mjs` 会**报出来**（而不是崩掉）并以 1 退出。
变异体 M60/M61/M73 把这三个缺陷钉住——注意它们的**执行套件是 `pack-dist.mjs`**，
因为只有它问「包里有什么」，其余套件都跑在工作树上，那是唯一看不出发这个缺陷的地方。

`pack-dist.mjs` 里还有一条断言专门钉住**它自己的那份「应该发什么」的清单**。
第一版清单是**从 `files[]` 读出来的**，于是把一个条目从 `files[]` 删掉时，
那条断言连同被检查的对象一起消失了——守卫永远绿。这正是它本来要防的那种
「自己验证自己」的形状，只是高了一层。现在清单在源码里写死，另有一条断言
（变异体 **M72**）规定它的长度，删条目会红而不是静默消失。


### 改动 Host 半之后需要重启

`dsh-hmr` 的模块监听根默认为空（`root: []`），因此：

- **Client 半改动即时生效**——重新计算 rev 后由 `/plugins/??…&rev=…` 重新发布。
- **Host 半改动必须重启进程**才能加载新的 JavaScript 模块。这也是
  `dsh-plugin-manager` README「Known Limitations」第 130 行的既有结论：
  *Package replacements require restarting the process to load a fresh JavaScript
  module generation.*

补充两点实测结论（2026-10，本机）：

1. `dsh-hmr` 确实实现了 `partialReload()`，它会清掉 Node 的 ESM `loadCache`
   （`dsh-hmr/lib/index.js` 第 516 行起，注释里专门说明了 Node 22/23 与 24 的差异）。
   所以**缺的不是重载能力，而是监听根本身**——`root: []` 让这个机制根本没有触发条件。
2. 关于 `isExcluded`（第 478 行，凡 URL 含 `/node_modules/` 就排除）：对本插件**并不构成
   额外障碍**。Node 会把 profile 里那个 junction 解析成真实路径，实测
   `require.resolve("@local/dsh-device-monitor")` 指向的是**仓库根下的 `index.js` 真实路径**，
   不含 `/node_modules/`。

结论：想让 Host 半热重载，需要给 `dsh-hmr` 配一个指向本插件目录的命令行 `root`——
但这只解决**开发期**的迭代效率；**已经加载进内存的那一代模块**无论如何
都要靠重启才能换掉。因此判断改动是否生效，一律以重启后的实机表现为准。

### 改动生效前如何验证

`tools\verify-fresh-boot-e2e.mjs` 在全新进程里挂载真实的 Host 半，用真实 HTTP 端口 +
真实 `ssh2.Server` 对端跑完整交付物，并且**故意不设置 `DSH_PROFILE_DIR`**（即真机当时
失败的那个环境形态），同时使用隔离的临时 `DSH_HOME`。它证明的就是「下次启动会怎样」。

## 测试

**先跑这一条。** 它跑**所有**套件（包括需要打包运行时的那些），汇总断言数，失败就非零退出：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-all.ps1
# TOTAL 1641 assertions from 15 suites  PASSED 1641  FAILED 0
# EVERY SUITE THAT RAN IS GREEN
```

> 它会存在，是因为 `verify-host-boot` 与 `verify-fresh-boot-e2e` 过去**不在任何
> 「跑全部」的命令里**，于是它们的路由计数在终端路由加进来之后就一直红着没人发现。
> **没有任何命令会跑的套件，是一个会静静烂掉的套件。** 详见 [坑 11](docs/PITFALLS.md)。

单独的套件：

```powershell
# 普通 Node 即可；打包运行时那几条需要 Electron 自带的二进制
$N   = 'node'
$exe = '<DeepSeek Harness 安装目录>\DeepSeek Harness.exe'

# Host 半（mock cordis ctx + 假 defineTool）
& $N tools\smoke.mjs            # 244 checks

# 浏览器半（mock React/DOM/ModuleLoader，含右栏 Tab 内的完整流程、自定义命令表单与终端浮层）
& $N tools\client-smoke.mjs     # 384 checks
#   也可对真实下发的 bundle 运行：
$env:DDM_CLIENT_SOURCE_URL = 'http://127.0.0.1:19387/plugins/??@local/dsh-device-monitor/client.js&rev=<rev>'

# 真实 Host 挂载（真路由 + 真 HTTP 回环围栏 + 真升级路由表）
& $N tools\activate-smoke.mjs   # 72 checks

# 设置 / 指标词表 / 阈值
& $N tools\settings-smoke.mjs   # 332 checks

# 终端 Host 半（地址规则、会话上限、空闲兜底、WS 帧循环、回环围栏）
& $N tools\terminal-smoke.mjs   # 162 checks

# 原始日志 + 异常记录（隔离的临时 DSH_HOME）
& $N tools\rawlog-smoke.mjs     # 115 checks

# SSH 传输（起一个真的 ssh2.Server 当被监管设备）
& $N tools\ssh-integration.mjs  # 92 checks

# 依赖解析阶梯（每种 Host 环境形态各跑一遍）
& $N tools\verify-ssh-resolution.mjs     # 25 checks
& $N tools\verify-ssh-fix-causality.mjs  # 13 checks

# 对打包运行时里的真 defineTool 校验工具约定
$env:ELECTRON_RUN_AS_NODE = 1
& $exe --expose-internals tools\verify-define-tool.mjs    # 16
& $exe --expose-internals tools\verify-host-boot.mjs      # 25

# 一条命令跑完整交付物：全新进程里挂真 Host 半，真 HTTP + 真 SSH 对端
# （隔离的临时 DSH_HOME，不碰你自己的设备名单）
& $exe --expose-internals tools\verify-fresh-boot-e2e.mjs # 67

# 对着**正在运行**的 Host 打整条链路（真 SSH 对端 → 真 HTTP API）
& $N tools\live-ssh-e2e.mjs

# 编辑页「测试连接」的空密码回归：对真实设备名单拨号，要求 4 项判定全过
& $N tools\live-draft-e2e.mjs nas-b

# 终端真的开一次：连真实升级路由、开真 shell、跑一条只读命令等回显
# （终端在设置里关闭时它报 SKIP 并以 0 退出——「用户没打开」不是缺陷）
& $N tools\live-terminal-e2e.mjs nas-b    # 12 checks

# 重启后的最后一道验收：确认在跑的这一代就是当前这一代
& $N tools\verify-live-gui.mjs    # 105 checks

# 变异测试：73 个变异体逐条应用（每条一个独立子进程），实测 73/73 被捕获
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-mutations.ps1

# 分发：打一个包，然后**把打出来的包解开**再验一遍它能不能装
& $N tools\pack-dist.mjs              # 51 checks（含 pre-flight）
& $N tools\verify-dist-installable.mjs # 19 checks
```

常驻离线套件共 **1463 条断言，0 失败**（`smoke` 244 / `client-smoke` 384 / `settings-smoke` 332 /
`terminal-smoke` 162 / `rawlog-smoke` 115 / `ssh-integration` 92 / `activate-smoke` 72 /
`verify-audit-verdict` 24 / `verify-ssh-resolution` 25 / `verify-ssh-fix-causality` 13），
外加 **215 条联机断言**（`verify-live-gui` 105 / `live-ssh-e2e` 98 / `live-terminal-e2e` 12）。
另有 **108 条**跑在打包运行时里或依赖特定 Host 形态的断言
（`verify-define-tool` 16 / `verify-host-boot` 25 / `verify-fresh-boot-e2e` 67），
**它们不在上面的 1463 里**——因为需要 `ELECTRON_RUN_AS_NODE=1` 或特定依赖形态而被单独列出，
也因此**曾经长期红着没人发现**（见 [坑 11](docs/PITFALLS.md)：`verify-host-boot` 与 `verify-fresh-boot-e2e`
的路由计数在终端路由加进来之后就一直红着）。
再外加 **70 条分发断言**（`pack-dist` 51 / `verify-dist-installable` 19），
它们回答的是另一个问题：**打出来的包里到底有什么**。
`tools\run-all.ps1` 现在把三组一起跑，**1641 条断言、0 失败**。
`live-*` 与 `verify-live-gui` 打的是**正在运行的 Host**，
所以它们仅在宿主已重启、加载了当前一代模块时才会全绿。

> 联机断言**不能把用户的当前配置写死成期望值**。`verify-live-gui.mjs` 原本断言
> `/terminal/status` 的 `enabled === false`（出厂默认关闭），用户第一次在设置里
> 打开终端，这条就红了——它测的是**用户的选择**，不是代码。现在只断言
> `typeof enabled === "boolean"`（这确实是契约：`enabled` 必须是真的 `true`），
> 「默认关闭」改由 `terminal-smoke` 对**全新 store** 断言。

`verify-live-gui.mjs` 专门检查那些**能区分新旧两代**的东西：统一后的指标词表
（有 `mem`/`temp`，绝无 `memory`/`thermal`）、只有新半才注册的路由
（`/settings`、`/catalog`、`/logs/status`、`/audit`、`/incidents`、`/watch`、`/terminal/status`），
以及**实际下发的 client bundle 里确实含有新 UI**。旧一代进程不但路由会 401，
连 `memory` 指纹都对不上，因此这个脚本**不可能被一个旧进程满足**。

> 一个容易误判的现象：**同一个进程里「Host 是旧的」和「client 是新的」可以同时成立。**
> 浏览器半是从磁盘读的（重新计算 rev 后重新发布），不经过已加载的模块代，
> 所以重启前跑 `verify-live-gui.mjs` 会看到 9 条 `/terminal/status` 401（Host 旧），
> 而 4 条 bundle 标记断言全绿（client 新）。
> **只看 bundle 会以为已经生效，只看路由会以为整个插件都没装。** 两者必须分开取证。

## 日志与隐私

- **原始日志完全不做脱敏**（这是设计决定，与 device-manager 一致）：逐设备的采集原文以**纯文本块**按行写入
  `$DSH_HOME/dsh-device-monitor-logs/log/devices/<名称>-<id>.log`（非 JSONL），单文件上限 20 MB、保留 3 份。
  面板「设置」页有显式警告，可整体关闭（关掉后仍然采集，只是不落盘）。
- **审计日志只记字段名，绝不记值**——`settings.update` 记 `thresholds.cpu`，不记 `90`；
  `device.update` 记 `["host","port"]`，不记主机名与端口。密码与私钥**从不**进入任何日志。
- **`device_exec` 的审计只记 `commandLength`，不记命令文本。** 这条路径一度记的是 `command` 原文，
  与上面那句话直接矛盾——而在这台机器上 `mysql -p'…'`、`curl -H 'Authorization: …'` 都是寻常命令，
  所以「把值记下来」在这里等于「把凭据记下来」。**修法是整段不记，而不是发明一套「哪部分是安全的」
  规则**：任何靠检查命令内容来决定保留什么的规则，本身就可能判断错。保留长度是有意的，
  它仍然回答唯一不需要文本的取证问题——手敲的一行 vs 一个脚本。
  调用方仍看得到 stdout/stderr，对话记录里也仍有原文；不该成为永久明文副本的是审计日志。详见 [坑 16](docs/PITFALLS.md)。
- 异常记录（离线 / 恢复 / 重启）写在 `log/incidents.log`，与审计日志分开两个文件。
- 设备名单与凭据在 `$DSH_HOME/dsh-device-monitor.json`（0600），既不写日志也不下发浏览器。
- **终端调试的审计只记会话开关与字节数（`terminal.open` / `terminal.close` / `terminal.denied`），
  绝不记录击键内容。** 这是刻意接受的代价：终端出问题时**无法回溯当时输入了什么**，
  换取的是「用户在这个框里敲的任何东西都不会落到磁盘上」。补偿手段是默认关闭、
  回环围栏 + 可选允许列表、会话上限与空闲超时，而不是记录输入。

## 参与开发

```powershell
git clone <this repo> dsh-device-monitor
cd dsh-device-monitor
node --version    # >= 20
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-all.ps1
```

**不需要 `npm install` 就能跑测试**——`ssh2` / `ws` 在测试里都是可选的（缺失时相关套件会降级，
但不会静默通过）。要真正连设备时，在宿主 profile 里装它们即可。

测试与工具链**不依赖仓库所在的绝对路径**：全部路径都从脚本自身位置推导
（`tools/paths.mjs`、`Split-Path -Parent $PSScriptRoot`），
**已在一个带空格的陌生目录里把 12 个套件全部跑绿**（见 [坑 18](docs/PITFALLS.md)）。
打包运行时那三个套件需要一个 DeepSeek Harness 二进制，用 `$env:DSH_EXE` 指过去；
找不到时会**显式跳过并说明**，而不是假装通过（`tools/run-all.ps1 -RequireRuntime` 可让它变成硬失败）。

改代码、加断言、加变异体的规矩见 **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**。

> 仓库元数据（`package.json` 的 `repository` / `bugs` / `homepage`）已指向 `zzlzh/dsh-device-monitor`；
> 若 fork 到其他账号，记得同步改这几处。

## 更多文档

| 文档 | 内容 |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | 功能与设计文档：功能概述、总体架构、方案 ADR（决策 1–26）、数据模型与 API、测试与验收清单 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 十八个值得记住的坑——每条都保留了当时的错误判断与推翻它的证据 |
| [docs/TRADEOFFS.md](docs/TRADEOFFS.md) | 已知取舍：哪些行为是刻意这样设计的 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 改代码、跑测试、加变异体的流程 |
| [SECURITY.md](SECURITY.md) | 凭据存放、命令执行门控、审计范围、**不**做的事 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |