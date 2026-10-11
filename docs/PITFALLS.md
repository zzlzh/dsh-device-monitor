# 十八个值得记住的坑

这些是开发过程中真实撞到、并且**花过代价**才修对的问题。每一条都保留了当时的错误判断、
它为什么看起来对、以及最后是靠什么证据推翻的——因为「结论」在 README 里一句就够了，
**值钱的是判据是怎么找错的**。

（前五个的修复已经写进代码；第六个是阶段收敛前由用户的 GUI 实测打回来的那个；
第九个是终端调试上线后打回来的显示退化，**并且在 m09014 被用户推翻了结论、返工重写过**
（现在的第九个记的是那次返工，而不是第一版的答案）；第十个是同一轮的第二处显示退化；
第十一个是顺手扫出来的测试缺陷；第十二个是**修第十一个时自己引入的**，
由合成日志的分支测试抓回来；第十三个是 m09625 那句「负载为什么显示和其他不同」
问出来的——**一个从未被测量的分母**；第十四个是 m10224 那六个字「波形显示横纵坐标」
带出来的——**一个会自己算刻度的坐标轴**；第十五个是 m10487 那句「怎么共享到其他设备」
问出来的——**能跑，和能装，是两个问题**；第十六个是 m10991「从产品功能的角度出发」
问出来的三件事——**审计写了但记错了、字段存了但没出口、日志记了但没读者**；
第十七个不是用户问出来的，而是**给第十六个做取证时自己撞出来的**——
**一个只接了一半的接缝**；第十八个是 m11801「按github标准格式整理」时，
给新加的打包守卫做**证伪**才发现的——**一个验证自己的守卫**。）

**1. 每个工具都必须提供 `output.render`。**
`@deepseek-ai/dsh-tools` 的 `defineTool` 会无条件包装这个字段：

```js
const userRender = options.output.render;
// …
output: { schema, render(args, value) { return userRender(args, value); } }
```

缺少它不会在定义时报错，而是在第一次调用时抛出
`output.render failed: userRender is not a function`。
`tools\smoke.mjs` 用一个忠实复刻该包装的 shim 守住这一点，`verify-*` 脚本则
直接跑真实现。

**2. 词典占位符是单花括号。**
`@deepseek-ai/dsh-client-locale` 用 `/\{(\w+)\}/g` 插值，所以写成
`{{count}}` 不会报错——它会被替换成字面量 `{0}`，于是面板上显示
`{0} / {10} 台设备`。`tools\client-smoke.mjs` 因此刻意使用**严格**的插值替身，
并断言渲染结果里不残留任何 `{…}` 记号；用一个宽容的替身会让这类 bug 溜过去。

**3. 按引用安装的插件看不到 profile 的依赖，而 `DSH_PROFILE_DIR` 不一定存在。**
插件装进 profile 后是以 Junction 指回工作区的，Node 从插件目录往上走**走不到**
`profiles/desktop/node_modules`。所以 `src\ssh.js` 要自己建解析阶梯；最初的版本
只试 `DSH_PROFILE_DIR`（若为空就跳过）和 `$DSH_HOME`，而正在运行的 Host 里
前者并没有设置，于是真机上直接报：

```
cannot load the ssh2 module: Cannot find module 'ssh2'
Require stack:
- C:\Users\<user>\.dsh\index.js
```

`Require stack` 指到 `$DSH_HOME` 恰好证明它是最后一级——`DSH_PROFILE_DIR` 缺席。
修法是让 `src\ssh.js` 复用 `src\resolve.js` 里那份阶梯，并且那份阶梯额外扫一遍
`$DSH_HOME/profiles/*`（只认带 `package.json` 的真 profile），
这样**不依赖任何环境变量**也能找到依赖。
`tools\verify-ssh-fix-causality.mjs` 会把旧阶梯原样重建，在同一环境里证明它失败、
新阶梯成功——只差阶梯本身。

**4. 「部件是对的」不等于「调用点接对了」——而保存与测试可以走两套语义。**

用户在编辑页点「测试连接」拿到
`连接失败：All configured authentication methods failed`（m06456），
但同一台设备的卡片「测试」和 `device_collect` 都正常。

根因不在 SSH：**保存与测试对同一份表单做了相反的事**。
`formFromDevice()` 打开编辑页时把密码框清空，`formPayload()` 因为密码为空
**整个 `password` 键都不发**；而保存走 `Store#update`，那里是
`{...current.auth, ...fields.auth}` 的**合并**，空密码框因此保留了旧密码、保存成功；
测试走 `Monitor#testDraft`，那里直接把 payload 展开成设备行，是**替换**，
于是同一个空密码框拿着空密码去认证。

修法不是「让客户端补发密码」——那会把明文密码无谓地多走一趟——
而是让 Host 侧**只补「缺失」的密码**，并且**按表单带回的设备 `id` 解析**，
用的键与 `Store#update` 合并时**完全一致**。显式空串原样保留，
因为「这台设备没有密码」是一句决定，「没填」才是遗漏。

三条教训：

> **同一个表单的两条出口必须有同一个凭据语义。** 保存合并、测试替换，
> 用户不可能从界面上看出这个差别；而失败信息（「认证方法都失败了」）
> 还把矛头指向凭据，**读起来像是密码错了**。
> **先复现再动手。** 第一版假设是终端缺 `keyboard-interactive` 处理器——
> 探针证明两条路径都能连上，真正的失败来自 `/test-draft`，
> 而且错误文案 `连接失败：{error}` 属于表单、不属于终端（终端用的是
> `term.failed`「无法建立终端连接」）。**错误文案本身的归属就是证据。**
> **纯函数测得再全，也看不见调用点。** `withStoredSecret` 的断言全绿时，
> M30（把 `testDraft` 里的调用删掉）仍然 **SURVIVED**；补的断言必须从
> `Monitor#testDraft` 这个公共入口出发，注入拨号替身，检查**真正送到 ssh2 的那一行**。

**5. 测试替身以「命令原文」为键，会把失配伪装成「设备没数据」。**

假设备（`tools\live-ssh-e2e.mjs`）原本按**命令原文**查找要回送的字节。采集器命令一旦
被改写（`df` 与温度循环都改过），键就不匹配，而查不到的实现是 `exit(127)` 回空输出——
**外观与「这台设备确实没什么可报」完全一致**。实测后果是 95% 的根分区与 71.2°C 的传感器
一起变成 `undefined`，**而周围的断言照旧全绿**。

修正是把键换成 `commandPlan()` 的**采集器名**，并在启动时双向校验：命名了不存在的采集器、
或新增采集器却没有 fixture，都**当场抛错**。同时补一条服务端记录，让任何一条落到 127
回退的命令都会红。

> 同源的两个教训：
> **替身保真度的失效方向，决定它遮住还是暴露缺陷。** 以命令原文为键的替身，
> 在命令改写时会把自己的失配伪装成被监控系统的正常静默。
> **测试桩里字段填得越敷衍，越会掩盖被测缺陷**——`client-smoke.mjs` 的
> `CATALOG` 常量曾有 11 个空的 `hint` 字段，于是「采样说明根本没渲染」这个缺陷
> 会被替身吃掉；把它们补成与 `src/metrics-keys.js` 逐字一致之后才测得出来。

**6. 测试桩「数了钩子却没比对钩子数」，等于没数。**

用户在 GUI 里报 `dsh-better-sidebar: Minified React error #310`，含义是
**这次渲染比上次多调用了钩子**。真凶是 `client.js:2069` 的 `TerminalPanel`：

```js
const pane  = React.useRef(null);      // 钩子 1
const input = React.useRef(null);      // 钩子 2
const [draft, setDraft] = React.useState("");  // 钩子 3
if (term.owner !== owner) return null;         // ← 在这里就跑了
React.useEffect(...);                  // 钩子 4（不拥有终端时永远不执行）
React.useEffect(...);                  // 钩子 5
```

React 靠**调用顺序**认钩子。主槽位用 `owner:"main"`、右栏标签页用 `owner:"sidebar-tab"`，
**同一个组件函数被挂载两次**：不拥有终端的那次渲染 3 个钩子，一旦终端开起来
就变成 5 个，于是抛 #310，整个标签页崩掉。修法是把钩子全部提到守卫之前
（先算 `const mine = term.owner === owner;`，两个 effect 内部各自 `if (!mine) return;`），
`if (!mine) return null;` 移到钩子之后。

真正值得记住的是**为什么 304 条断言没抓住它**。`tools\client-smoke.mjs` 的手写渲染器
本来就在维护一个 `hookCursor`，但**只是递增，从不比较**——它数得对，却从不说出口。
补上「首次渲染记下每个组件的钩子数、之后每次渲染比对、不一致就抛错」之后，
测试桩立刻原样复现了用户看到的那次崩溃：

```
Error: hook order changed in TerminalPanel: rendered 5 hooks, but an earlier render used 3.
```

> 两条教训：
> **观测到了不等于断言了。** 一个只记录不比较的计数器，给人的安心感和一条真断言完全一样，
> 但它永远不会红。**凡是被记下来的量，问一句「它跟谁比」**——没有对手方的记录，是装饰品。
> **同一个组件被挂载两次，是手写渲染器最容易骗过自己的场景。** 桩按组件**函数**存钩子槽位，
> 两个座位共用一套槽位数组，于是第二个座位的渲染会驱动第一个座位的 effect 清理。
> 这也是把卸载清理的依赖从 `[owner]` 改成 `[]`（它描述的只有「卸载」这一件事）的原因。

## 坑 7：静默的拒绝，和「没到」长得一模一样

用户报告「终端连不上」，界面上的原话是：

```
无法建立终端连接：可能终端未开启，或来源地址不在终端的允许列表里。
连接已断开（code 1006）。请关闭后重新打开终端。
```

两条一起出现，其实是**一次**握手失败：`onerror` 报第一句，`onclose` 拿到没有关闭帧的
1006 报第二句。

难的地方在于**查不下去**：升级入口的拒绝分支（`src\terminal-route.js` 的
`isLoopbackRequest`）当年既没写审计、也没写日志，于是「浏览器被拒了」和
「请求根本没到服务器」在证据上**完全一样**——都是空的。而用原始 socket 逐个字段试出来的结果
是：所有回环形态（`127.0.0.1` / `localhost` / 带不带端口 / 各种 `Origin`）**全部 101**，
只有非回环的自定义 scheme（`file://`、`null`、`app://`、`dsh://`、`chrome-extension://`）
和 `Sec-Fetch-Site: cross-site` 才 403。也就是说，从服务端一侧**无论怎么试都复现不了**。

修法不是猜，而是**先把盲区补上**：升级请求在判定之前先记一条 `terminal.upgrade`
（只记 `from`/`host`/`origin`/`site`/`url` 五个头部输入——**永远不记 cookie、不记凭据**），
三条静默出口各自再记一条 `terminal.upgradeDenied`（403）/ `terminal.upgradeUnavailable`（503）。

```json
{"event":"terminal.upgrade","from":"127.0.0.1","host":"127.0.0.1:19387","origin":"http://127.0.0.1:19387","site":"same-origin","url":"/api/dsh-device-monitor/terminal"}
```

> 三条教训：
> **「没有任何记录」也是一种证据，而且是最容易被误读的那种。** 在断言「这个功能坏了」之前，
> 先确认**坏掉的那条路径本来会不会留下记录**；否则你是在用一个空日志证明一个空白结论。
> **一个拒绝分支必须说得出它拒了谁。** 只写 `403` + `socket.destroy()` 的守卫，
> 对用户是黑箱，对维护者等于没有。
> **审计只记判定所需的头部，不记整包。** 升级请求可能带 Cookie，而审计行是永久的——
> 记 `origin` 就能复现这次判定，记 Cookie 只是把凭据抄了一遍。

留痕补上之后，根因很快就查出来了——但它不在服务端，见坑 8。

## 坑 8：页面在哪儿，不等于 Host 在哪儿

坑 7 的留痕一上线，「浏览器被拒」就被排除了：审计里浏览器**一条升级记录都没有**。
不是被拒（那会留 `terminal.upgradeDenied`），是**压根没到**。于是问题回到客户端。

决定性的一次比对来自 DSH 自己的代码。`app.asar` 里唯一会开 WebSocket 的客户端
（`dsh-api-gateway/lib/client.js`，它承载 DSH 全部的 Remote 流）是这样拼 URL 的：

```js
function remoteStreamUrl() {
  const url = new URL("/api/remote.mux".slice(1),
    globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
```

**它从不读 `window.location`。** 因为桌面壳把界面装在自定义 scheme 上：
`lib/main.js:11272` `const applicationUrl = \`dsh-app://app/\``，
再由 `:11545` `if (url.hostname === "app")` 把 SPA 端出来。也就是说 GUI 页面里：

| | 值 |
|---|---|
| `location.protocol` | `"dsh-app:"` |
| `location.host` | `"app"` |
| `location.origin` | `"null"` |

而修复前的本插件据此拼出了 **`ws://app/api/dsh-device-monitor/terminal`** —— 一个没有真正
authority 的 URL。Chromium 在**发出任何字节之前**就拒绝了它。这解释了全部现象：
服务端看不见、探针复现不了、界面同时报 `onerror` 和 `1006` 两句。

这也解释了**为什么只有 WebSocket 坏、HTTP 一直是好的**：面板的 `fetch` 被壳的
`forwardWebRequest`（Node `fetch` 反向代理）接管了，而 `:7436-7448` 的
`WITHHELD_RESPONSE_HEADERS` **明确包含 `"upgrade"`**，整个 `main.js` 里没有任何升级代理。

修法是两处，缺一不可：

1. **`client.js`** 改从 `__DSH_TRANSPORT__?.streamBaseUrl` 取 authority（回退
   `document.baseURI`），写法与 DSH 自己的 `remoteStreamUrl()` 一致。
2. **`src/http.js`** 把 `dsh-app://app` 加进受信任的页面来源（**精确字符串比较**）。

第 2 处有个**极易写错**的地方：`dsh-app://app` 与 `http://127.0.0.1:<port>` 的 scheme 和
host 都不同，浏览器会把这次升级标成 **`Sec-Fetch-Site: cross-site`**。若把「接受桌面来源」
写在 cross-site 规则**之后**，代码看起来修好了，**终端依旧连不上**。

```js
if (!isLoopbackAddress(...)) return false;      // ① socket 必须回环
if (!isLoopbackHostname(host)) return false;    // ② Host 必须回环
if (origin === DESKTOP_APP_ORIGIN) return true; // ③ 桌面壳整体放行（必须在 ④ 之前）
if (secFetchSite === "cross-site") return false;
```

> 三条教训：
> **页面所在的位置，不等于 Host 所在的位置。** 在自定义 scheme 里
> `window.location.host` 是一个**没有 authority 的词**；信任它的渲染器会拼出语法合法、
> 语义为空的 URL，而失败发生在**本进程内部**——服务端永远看不到。
> **「HTTP 通」不能推出「WebSocket 也通」。** 反向代理会接管 `fetch`，却不接管升级请求；
> 一个功能坏而另一个功能好，恰恰指向传输层，而不是业务逻辑。
> **修复的位置也是修复的一部分。** M39（删掉放行）和 M40（把放行挪到 cross-site 之后）
> 是同一批断言变红——但如果没有 M40，一个顺序写反的实现会拿到全绿。

## 坑 9：修对了根因，却答错了问题——然后第三次才量对

这一条被用户退回了**两次**，两次的方向正好相反。留档是因为第二次那种失败更隐蔽。

### 第一版：技术事实全对，需求理解反了

用户点了「全屏」按钮，面板只长到**侧边栏**那么大（m08259）。根因不在全屏代码里，而在 CSS 的
**包含块（containing block）**规则上：`position: fixed` 的后代，其包含块**不一定是视口**。
只要祖先链上有任何一个属性建立包含块——`transform`、`will-change: transform`、`filter`、
`backdrop-filter`、`perspective`、`contain: paint`、**`contain: layout`**——
那么 `left/top/right/bottom` 相对的就是**那个祖先**，而不是窗口。

**第一版修复**据此改用**元素级 Fullscreen API**：把面板元素本身 `requestFullscreen()`，
它进入浏览器的 **top layer**，不受任何祖先包含块约束。参考系统 `device-manager` 早就是
这么做的，它的 CSS 注释把这个 bug 一字不差地写着：「用元素级 Fullscreen API 把
`#term-panel` 本身全屏，而不是自己拉伸 CSS —— 后者会被浏览器地址栏/任务栏挡住，只是
『看起来大了』」。推理链每一步都对，代码也真的按它跑起来，测试全绿。

**然后用户说（m09014）：「需求是点击调试窗口全屏时实际去填满右侧栏，而不需要全屏显示」。**

原来「被祖先包含块困在侧边栏里」**不是缺陷，正是需求**。`contain: layout style` 既可以是
缺陷的原因，也可以是需求的实现——**取决于你想填满的是哪一个盒子**。

### 第二版：需求理解对了，技术前提没量过

于是改成只用 CSS 类，四个边归零：

```css
.ddm-term-panel-full{left:0;top:0;right:0;bottom:0;width:auto;max-height:none;border:0;border-radius:0}
```

并在注释里写下理由：「侧边栏的面板携带 `contain: layout style`，所以 `inset:0` 会解析到那一栏」。

**然后用户说（m09258）：「问题没解决，反而导致了全屏后无法退出了，需求是点击调试窗口
扩大时实际去填满右侧栏 dsh-better-sidebar 部分，而不显示到全屏」。**

这次前提**根本没验证过**。写一个只读探针把 `dsh-better-sidebar\lib\client.js`
（1087696 字符、2626 条规则）扫一遍，量出来的真相是：

| 事实 | 值 | 后果 |
|---|---|---|
| 面板宿主 | `[data-dsh-panel-host]{position:fixed;inset:0}` | **全视口**固定层，祖先链上唯一建立包含块的元素 |
| 面板容器 | `.nArs4W_pane{position:relative}` | `position:relative` **不**捕获 `position:fixed` 后代 |
| `.nArs4W_bottomPanel` | `contain:layout style` | 真实存在，但**不是**本面板的祖先 |

所以 `position:fixed;inset:0` 解析到的是**视口**——面板吞掉整个窗口，「还原」按钮落到 shell
标题栏底下点不到。**注释里那句「侧边栏面板携带 contain」是一句从未被测量过的话。**

### 第三版：换掉参照物，而不是把别人的 DOM 抄得更准

修法不是再补一条覆盖规则，因为 `position:fixed` 的落点由**祖先链**决定，
而祖先链由别的插件提供、**不受本插件控制**。改成把包含块换成本插件自己的盒子：

```css
.ddm-view{position:relative; …}                       /* 每个座位都有的自有根 */
.ddm-term-panel{position:absolute;right:18px;bottom:18px; …}
.ddm-term-panel-full{position:absolute;left:0;top:0;right:0;bottom:0;width:auto;max-height:none;border:0;border-radius:0}
```

四处各自承担一件事：**`fixed` → `absolute`**（包含块变成 `.ddm-view`）；**`100vw/100vh`
→ `100%`**（视口单位和定位无关，1600px 窗口里的 `100vw` 放进 380px 窄栏仍是 1600px）；
**`.ddm-view` 加 `position:relative`**（否则 `absolute` 会继续往上爬）；**按钮文案
「⛶ 全屏」→「⛶ 扩大」**（行为从来不是全屏，一个说「全屏」的按钮正是前两次缺陷难以描述的原因）。

返工同时拆掉了两次被推翻的东西：`:fullscreen` 规则、`frame` ref、`fullscreenchange` 监听、
`requestFullscreen`/`exitFullscreen` 调用、`closeTerminal` 里先退全屏的逻辑。
**只拆一半比不拆更坏**——CSS 按 class 写、JS 还在调 API，两边对不上。

> 四条教训：
> **根因判断正确，不代表结论方向正确。** 第一版把 `contain: layout` 的作用查得清清楚楚，
> 每一步推理都对，只是**回答错了问题**。同一个 CSS 事实既是「缺陷原因」也是「需求实现」。
> **照抄参考实现时，抄到的是它的结论，抄不到的是它的前提。** 参考系统的面板在独立窗口里，
> 「全屏」当然是铺满窗口；本插件的面板在对话旁边，「全屏」只能是填满那一栏。
> 它的注释把理由写得很明白，唯独**没有写前提**。
> **关于别的插件 DOM 的结论必须量出来，不能推理出来。** 第二版的错误比第一版更坏：
> 它**把没量过的祖先当成已知条件，还把结论写进了注释**——注释让那个假设看起来像事实，
> 以至于后来是我自己照着它改的代码。**一条断言着错误理由的注释，本身就是一个缺陷。**
> 「这些选择器存在」**不等于**「它们在这条祖先链上」。
> **断言的方向来自需求，不来自实现。** 第一版断言「真的调了 `requestFullscreen`」，
> 产品也确实调了，测试全绿——**绿的是错误的牢靠**。测试能证明「代码做了它说要做的事」，
> 不能证明「它该做那件事」。返工时断言要**反过来写**，并且必须与「按钮确实生效了」成对：
> 只说「没做那件错事」在按钮根本没接上时同样成立。

> **补记（M52）：一个存活两次的变异体，不是运气问题。**
> 为「新开的终端必须从角落开始」立的变异体（把上次的展开状态带过去）连续存活两次。
> 第一次指向 `closeTerminal` 里的 `fullscreen: false`；第二次指向 `openTerminal` 里
> 模块级的 `terminal.fullscreen = false`。两次存活揭出同一个事实：**那个模块级字段是只写的**
> ——全文件两处赋值、**零处读取**，真正被渲染的是 `publish` 进 store 的那份。
> 而最初的场景也不可能发现它：终端一关，面板就**不渲染**了，
> 对**一棵不存在的树**做断言，无论代码怎么写都成立。
> 把场景改成**掉线后开第二台设备**（掉线让 `terminal.socket` 归 null，而 store 的 `owner`
> 刻意保留，所以面板**仍在屏幕上**）之后，它才开始杀人。
> **变异体存活不是运气问题，是断言在问一个从不被回答的问题。**

## 坑 10：只剥掉自己恰好观察到的那些序列，等于没剥

同一个功能的第二处退化：终端里出现 `[?1l>[58;1H`、`[?12l[?25h[K`，
以及每条 `ls` 目录前的 `[0m[01;34m`。原因是客户端**只剥了 bracketed-paste 开关**
（`\x1b[?2004[hl]`），其余 ESC/CSI 序列原样进了 `<pre>`。

而当时的注释把理由写反了：

> ONLY these two sequences are stripped. Writing a general ANSI stripper would
> silently mangle colour and cursor moves into something that looks like output
> but is not.

**这个 `<pre>` 根本不画 ANSI**：没有光标可移动，没有单元格可上色。所以留下一个序列
不是「保留语义」，而是**把原文当字面文本打印**——用户读到的 `[0m[01;34m` 就是这句话的实证。
那句顾虑描述的是**一个写坏的剥除器的危害**，不是**什么都不做**的理由。

修法是把剥除器写对，顺序很关键：

```js
const TERM_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;   // 窗口标题、超链接（必须先于 CSI）
const TERM_CSI = /\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]/g;   // 颜色 / 光标 / [K / [?25h
const TERM_ESC = /\x1b[0-9<=>A-Za-z\\]/g;             // ESC > 、ESC = 、ESC 7/8 …
const TERM_C0  = /[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]/g; // 其余 C0，留出 \x08 与 CR/LF
```

**OSC 必须先于 CSI**：OSC 的载荷里可能含 `ESC [`，顺序反了会在 OSC 内部匹配、把尾巴留在屏幕上。

另外三处是真实终端行为，不是洁癖：

- **跨帧的半截序列**。真实 PTY 在任意字节偏移处分块，`ESC[3` + `1mSPLIT` 是常态。
  所以先删**完整**序列，剩下的如果还是序列开头就**扣住**给下一块（上限 512 字节，
  防止一个只发 `ESC]` 的设备把缓冲撑爆）。会话重建时清空。
- **`\r` 当 `\n`**。bash 用裸 `\r`（不带 `\n`）重画提示行，而 `white-space: pre-wrap` 里
  裸 `\r` **什么也不做**——重画的那行会拼到旧行上。
- **退格当删除**，行首的退格没有东西可消。

> 两条教训：
> **「只处理我见过的那两种情况」会把剩下全部变成产品的一部分。** 剩下的不是被忽略，
> 它们会**原样显示给用户**，成为缺陷本身。
> **测试桩和产品不一致时，先怀疑桩。** 新断言要求产品判断
> `document.fullscreenElement === frame.current`，而测试桩每轮重渲染都新建假节点，
> 于是这个**正确的判断看起来是错的**——顺着它去改产品，就会为迁就一个假 DOM
> 而破坏真实行为（React 在重渲染时是**复用**同类型节点的）。

## 坑 11：断「几个」而不是「哪几个」，两个方向都错

修完上面两处后顺手重跑三个 Electron 侧的验证脚本，两个红了：

```
FAIL the host half mounted its routes — 15 routes
FAIL the host half mounted fourteen routes
```

断言原文分别是 `routes.length === 14` 和 `routeRows.length === 14`，而插件实际有 **15** 条路由
（多出来的是 `/terminal/status`）。这不是回归——是**这两个脚本写完之后才加了终端路由**，
于是它们一直红着没人在意（它们在 README 里被单独列出，没有进主套件的计数）。

这个形状值得单独记一笔，因为**两个方向都会错**：

| 断言写法 | 加一条路由 | 换掉一条路由 |
|---|---|---|
| `routes.length === 14` | **假红** | **假绿**（少了一条也照样是 14） |
| 精确集合 | 红（对） | 红（对） |

`length === N` 是这条断言**最弱的形式**：它会被无关的增删惊动，却对「一条被换成了另一条」
完全无感。所以改成断言**精确集合**，并把差集的两个方向都打进失败信息：

```js
const missingRoutes = EXPECTED_ROUTES.filter((p) => !mountedPaths.includes(p));
const extraRoutes = mountedPaths.filter((p) => !EXPECTED_ROUTES.includes(p));
check("the host half mounted exactly its routes",
      missingRoutes.length === 0 && extraRoutes.length === 0,
      `missing: …; unexpected: …`);
```

> 三条教训：
> **用计数当断言，等于放弃了「是哪几个」。** 「有 15 条」和「有这 15 条」是两件事，
> 而后者才是你真正想说的。
> **长期红的断言和长期绿的断言一样没用**，而且更坏——它会训练人跳过检查。
> 这两条红色存在了很久，因为没人跑这两个脚本；它们没进合计，所以「全部套件绿」是真的，
> 却也是**不完整的**。
> **不要为了让它变绿而改数字。** `14` → `15` 也能修好它，同时把「换掉一条路由」
> 这个漏洞原样留下——这次修的是断言的形式，不是它的数值。
>
> 顺着这条还补了 `tools\run-all.ps1`：**把所有套件（含需要打包运行时的那些）
> 放进同一条命令**，而不是靠人记得单独跑。修好断言却不修「没人跑它」，
> 下一个同类缺陷只会再烂一次。它的负向对照也实测过：把旧的 `=== 14`
> 临时放回去，`run-all` 报 `verify-host-boot (1 failed)` 并以 **exit 1** 退出；
> 还原后全绿且 exit 0（当时的数字是 `1626/1626`，后来随套件增长而变）。

## 坑 12：修「被拒绝」被读成「没到」的时候，又把它写了回去

`tools\read-terminal-audit.mjs` 的任务只有一个：判断 GUI 的终端连不上究竟是
**请求被拒绝了**，还是**请求根本没到**。这两种情形在修复前的宿主上留下**完全一样的空白**，
所以这个工具必须先自证「我能看见一条拒绝」，才敢对空白下结论。

它第一版的判决依据是 `denied > 0 → 「fence 仍在拒绝」`。但那个自证探针
**每跑一次就故意制造一次拒绝**（用 LAN `Host` 打回环端口），于是 `denied` 永远不为零——
判决在**完全健康的宿主上**也会说「仍在拒绝」。实测原话：
`VERDICT: 43 upgrade(s) were refused by the loopback fence`，
而同一份日志里就躺着一次真实的 `by:"web"` 浏览器会话。

修法有四层，每一层都对应一个具体的误判：

1. **按 origin 分类，不合计。** 只有 `dsh-app://app` 才是桌面壳自己的来源。
2. **origin 要配对 Host 一起看**，不能单看 origin：`probe-ws.mjs` 会**故意**拿壳的
   Origin 去打 LAN `Host`（它的「dsh-app origin BUT a LAN Host」那一行），
   那些拒绝是**必须发生**的。判据是 **origin 是壳的 且 Host 是回环**——
   `src\http.js` 只在 socket 与 Host 都证明回环之后才求值 origin，所以探针伪造不出这个配对。
3. **代次感知。** 审计日志跨宿主重启累积，修复前的拒绝和修复后的接受在同一份文件里。
   拿最新时间戳比一比，陈旧的拒绝要标注为 `stale, from a previous Host generation`。
4. **分支顺序。** 「壳被拒绝」必须在任何「有没有东西到达」的通用分支**之前**判断。

第四层做完之后，我又把 `totalAttempts` 写成只数**被接受**的行——一份只有拒绝行的日志
因此报出 `0 attempts`，落进「根本没有请求到达」。**「被拒绝」又一次被答成「没到」，
而且是在专门为了避免这件事而写的那段代码里。** 改成 `upgrades + denied` 才对。

> **第二个 bug 是修第一个的时候写进去的。** 靠读代码看不出来，靠跑一次也看不出来
> （真实日志恰好有接受行，恰好掩盖了它）。是**合成日志的分支表**把它逼出来的：
> 「只有探针那次 LAN-host 拒绝」和「什么都没有」两个用例，答案必须不同。
> 所以判决逻辑现在拆进了 `tools\audit-verdict.mjs`（纯函数，好喂数据），
> 由 `tools\verify-audit-verdict.mjs` 驱动 24 条断言覆盖每条分支，
> 并挂进 `run-all.ps1`。
> **没人能喂样例的判决函数，是没人能信的判决函数。**

## 坑 13：一个从未被测量的分母

用户问的是「负载是什么概念，为什么显示和其他不同」（m09625）。负载是什么很好答：
`/proc/loadavg` 的平均进程数，**绝对值而非百分比**。但「为什么显示不同」这一问，
指向的是这个插件里唯一一块从没被怀疑过的渲染代码。

负载没有波形列，所以它是唯一留在 **gauge/长度条** 里的指标。条长算的是 `load1 / cores`，
而 `cores` 来自 `sample.cpu.cores`——**一个只在采集了 `cpu` 指标时才存在的字段**：

```js
const cores = Math.max(1, numOrNull(sample?.cpu?.cores) ?? 1);
```

那台示例设备 `nas-b` 存的是 `metrics: ["uptime","load","mem"]`，`sample.cpu` 是 `null`。
于是真实的 4 核、负载 `0.54`：

| | 真实 | 旧渲染 |
|---|---|---|
| 占用比 | `0.54 / 4 = 13.5%` | `0.54 / 1 = 54%` |
| 条长 | — | **4 倍** |
| 阈值着色 | 正常 | 被 70/90 误判 |

**一根四倍长的条，把一台空闲机器画成了繁忙机器。** 而 `?? 1` 读起来像无害兜底，
实际是一句断言：它断言这台机器是单核的。真相是「我们没问过」——
这两件事在渲染上无法区分，所以只能回到源头去拿数据（用户选的 B 方案：让负载自带核数）。

同一处伪造还有第二份：`coresOf()` 是 `Math.max(1, n)`，「没读过 `/proc/stat`」
和「单核机器」返回同一个值。两处一起改成 `null`，界面在核数未知时**不印核数**。

三个更一般的教训：

1. **兜底值不是中性的**。`?? 1`、`Math.max(1, …)` 这类写法看起来在防崩溃，
   实际是在**编造一个事实**。能编造就说明数据链缺了一段，该修的是链。
2. **变异测试的判决必须先确认基线**。M54 一度报 `CAUGHT`，而当时 `smoke` 正红着
   （我自己新加的断言读错了键名：读了 `plan.load` 而非 `plan.loadavg`——
   计划表的键是 `COMMAND_FOR_METRIC.load` 指到的 `loadavg`）。
   **套件本来就红的时候，任何「被捕获」都是假的。**
3. **夹具的保真度就是测试的保真度**。`smoke.mjs` 那个「真实设备」夹具用的是设备侧
   **文件名**（`meminfo` / `procstat` / `processes` / `model` / `kernel`），
   而 `aggregate` 读的是**采集键**（`procMem` / `procStat` / `procCount` / `cpuInfo` / `version`）。
   于是那个「真实设备」的大部分字段长期是空的，依赖它的断言测的是空气。
   这与 M9–M11 那次（`net`/`diskio` 的 fixture 喂了 `/proc` 原始形态）是同一类缺陷。

## 坑 14：坐标轴如果自己算一遍刻度，它就在说谎

用户的原话只有六个字：「波形显示横纵坐标」（m10224）。

四个波形此前是**裸 sparkline**——一条线，一个数字都没有。读者能看出线动过，
看不出动了多少，也看不出这段线覆盖多长时间。唯一存在的刻度是 `data-dsh-wave-lo`
这个属性，它存在的理由是给测试读，**没有人会去看它**。
一个没有坐标的图是形状，不是读数。

加坐标本身不难。难的是**刻度从哪来**。最自然的写法是在画轴的时候
再算一遍 `waveScale(...)`，而那样得到的标签描述的是一个**线没有被画进去**的范围：

```js
// 一次算好，同时交给线和它的标签
const scale = waveScale(values, undefined, column.ceiling);
...
h("span", null, axisText(column, scale.hi, scale.hi - scale.lo)),
h(Sparkline, { values, ceiling: column.ceiling, stroke: column.stroke, scale }),
```

把 `waveScale` 抽成纯函数、让 `Sparkline` 接受现成的 `scale`，不是为了让代码好看，
而是为了让轴**不可能**自己算一遍。用两个不同的变异体分别攻击这两个位置：

| 变异 | 攻击点 | 被谁抓住 |
|---|---|---|
| M56 | 轴改用自己重算的刻度（连发布属性一起改） | `the cpu axis labels the scale the line was drawn in — expected "16.000..29.000", got "36.000..54.000"` |
| M59 | **只**改刻度文本，属性仍是真的 | `the cpu top tick prints the scale's own high end — 54% vs 29` |

M59 是必须的：如果只改属性，文本断言有可能只是在「重读自己刚拿到的刻度」，
那就等于没测。让属性保持正确、只污染文本，才能证明文本断言真的在比较两个独立的量。

顺带一个自己做错、被工具抓住的例子：M57（删掉 y 刻度）第一次跑出来是
`CAUGHT-CRASH`——我的断言在轴缺失时对 `undefined` 取下标，
于是「被捕获」靠的是栈回溯而不是被测属性。**靠崩溃抓到的变异体不是被覆盖的变异体**，
断言改成 null-safe 之后它才真正报红。

还有一个更一般的教训：

**一个自己算刻度的坐标轴，比没有坐标轴更坏。** 没有坐标时读者知道自己在估；
刻度与几何不同源时，读者会相信一个错的数。所以「一次算、两处用」在这里不是复用，
是**正确性约束**——只要存在第二条计算路径，两者迟早会分叉，而分叉在界面上不可见。

## 坑 15：能跑，和能装，是两个问题

用户问「这个插件怎么共享到其他设备，在其他电脑上安装？」——这个问题的答案取决于一个
**从未被验证过的假设**：它可以跑，所以别人也能装。

要查清它，必须区分三样东西：

| 问题 | 谁来回答 |
|---|---|
| 源码完整吗？ | 工作树（**所有既有套件**都在这里跑） |
| 打包会带上哪些文件？ | `package.json` 的 `files[]`（此前没人问过） |
| 打出来的包里到底有什么？ | `npm pack` 的产物（此前没人问过） |

**第一行全绿，后两行从未被检查。** 而作者机器还额外提供了第三样东西：
**它能解析的依赖，别的机器不一定能解析。**

**缺陷一：`cordis.patch.yml` 被引用，却不在 `files[]` 里。**

```json
"dsh":   { "bundle": { "patch": "./cordis.patch.yml" } },
"files": [ "index.js", "client.js", "src/**/*.js", "locale/*.json", "icon.svg", "README.md" ]
```

`npm pack` 遵守 `files[]`，所以 tarball 里**没有这个文件**。DSH 自带的同构 bundle
（`dsh-experimental-schedule-bundle`）把 `cordis.patch.yml` **列了进去**——
**这是个能被同类实现证伪的缺陷，不是口味问题。**
后果的形状很重要：`installBundle` 会**成功**，失败要到**加载**时才出现。

**缺陷二：`ssh2` 被 `require`，却不在 `dependencies` 里**（当时该字段完全不存在）。
`src\ssh.js:66` 有 `require("ssh2")`，它在本机能解析的唯一原因是
**另一个已装插件恰好把 `ssh2` 提升到了 profile 的 `node_modules`**。
`ws` 同族但轻一些：缺它只让**终端**降级。

> **能跑不等于能装。** 作者机器是一台**配置齐全的数据库**：它顺便提供了别的机器没有的
> 依赖提升、别的机器没有的工作树文件。在这个上下文里做的一切验证，
> 都无法回答「别人装得上吗」。

修复是两个脚本，各问一个问题：`tools\pack-dist.mjs` 的 **pre-flight** 读清单自己的说法，
**post-flight** 读**打出来的那个包**（`npm pack` 遵守 `files`/`.npmignore`，
所以 pre-flight 全绿**不能说明包里有什么**）；`tools\verify-dist-installable.mjs`
把包**解开到新目录**，再**按解出来的那一份**解析 `dsh.bundle.patch`、每个 `exports`
与 `index.js` 的整个导入图。变异体 M60/M61 钉住这两个缺陷，
**执行套件是 `pack-dist.mjs`**——只有它问「包里有什么」，其余套件都跑在工作树上。

> **你以为在测什么，比你测得多仔细更重要。** 第十四个坑的难点是让坐标轴与几何同源；
> 这个坑的难点是让**验证的对象**从工作树换成产物。

## 坑 16：事实、界面与读者之间，少了一段路

m10991 的产品评审列了 19 条真实缺口，用户选了其中三件。它们看起来互不相干，
失败方式却完全是同一种：**系统里存在一个事实，而没有任何一条路径把它送到该看到它的人面前。**

**一、审计写了，但记的不是该记的。** `src\logs.js` 的 HARD RULE 写着「只记字段名、绝不记值」，
`command.custom` 守规矩地只记 `{ metrics: armed }`，而 `device.exec` 记的是：

```js
audit("device.exec", { deviceId: id, deviceName: device.name, command });
```

这台机器上 `mysql -p'…'`、`curl -H 'Authorization: …'` 都是寻常命令，所以「把值记下来」
在这里就等于「把凭据记下来」——而且是全插件**唯一**一条把用户自己写的文本永久落盘的路径。
修法是**整段不记**，而不是发明一套「哪部分是安全的」规则。保留 `commandLength` 是有意的。

**二、字段存了，但没有出口。** `description` / `location` / `tags` 能存、能编辑、
`client.js` 一处都不渲染；`group` 更彻底，UI 从没出现过，参考系统里也没有它——
**一个既写不进也读不出的字段不是功能，是传闻**，所以直接删掉而不是补一个没人要求的 UI。

**三、日志记了，但没有读者。** 模型手上只有 `device_status`，它结构上只能描述此刻，
于是「这台设备昨晚稳定吗」无法回答——而 `readIncidents` / `readAudit` 早就躺在 `src\logs.js` 里了。
补上第五个工具 `device_history`，其中最容易写错的一处是**读取量**：

```js
const incidents = kind === "audit" ? [] : readIncidents(MAX_HISTORY_SCAN);
const audits = kind === "incidents" ? [] : readAudit(MAX_HISTORY_SCAN);
```

**按扫描上限读，不是按 `limit` 读**，因为设备过滤发生在读之后。只读 `limit` 行的话，
一台每晚都掉线的设备会在日志被别处写长之后**报成空历史**——不是「没找到」，
而是**一个自信的错误答案**。

### 这一轮真正学到的，是三个工具问题

1. **判据必须放在能观测到那条行为的地方。** `run-mutations.ps1` 原先 `target → 单个套件`。
   `monitor` 名下住着两件互不相干的事：凭据解析（只有 `settings-smoke` 看得见）
   与 exec 审计行记录什么（只有 `smoke` 里那个真调用 `device_exec` 的用例看得见）。
   钉在一个套件上，这个目标里的一半变异就**不可杀**——而它们会以 `SURVIVED` 的形式
   报成测试缺口，**让问题看起来在代码里，其实在问题上**。
2. **只灌一半的噪声，测不出截断。** M64 第一版 `SURVIVED`：噪声只写进了异常日志，
   而截断读是**两次独立的读**，该设备自己的审计行仍在窗口内。两个日志都灌、
   且日期放在 `2030` 之后（保证比「现在」的审计行更新）才真正变红。
3. **改一处不够，等于没改。** M70 第一版只改内层守卫，而外层的
   `location === "" && description === ""` 会把整个容器压掉——变异体字节不同、
   **行为完全相同**。**一个因为「没变化」而存活的变异体，和没写这个变异体是一样的。**

> **变异体存活说的往往不是代码对，而是问题问错了地方。**
> 同样是这一轮：M63 第一次是 `CAUGHT-CRASH`（断言对空数组取下标抛了 `TypeError`），
> 改成 null-safe 之后才是真红——**靠崩溃抓到的变异体不是被覆盖的变异体。**
> 这三件事都不是「功能坏了」，而是**事实与界面之间少了一段路**；
> 所以断言也必须盯住那段路：exec 审计从公开入口跑到**磁盘上的那一行**，
> 幽灵字段数的是**卡片里的 chip 数**而不是数据里的数组长度，
> `device_history` 必须覆盖**两条日志**。

## 坑 17：一个只接了一半的接缝，比没有接缝更危险

给坑 16 做取证时，写了个脚本想证明「带密码形状的命令体不再落盘」。为了不碰网络，
它给 `Monitor` 传了一个会抛异常的假拨号器：

```js
const monitor = new Monitor(store, {}, {
  connect: () => { dials += 1; throw new Error("no dial in this proof"); },
});
```

脚本却报出了 `Timed out while waiting for handshake`——**这不是替身抛的那句**，
而是 ssh2 真的去拨了 `10.0.0.9:22` 之后超时的结果。

原因：`Monitor` 的注入接缝只接了一半。

```js
conn = await this.connect(device);   // testDraft  —— 用注入的
conn = await connect(device);        // execOn     —— 用模块级的
```

注入接缝的用途是「让调用方决定这个副作用怎么发生」。它一旦存在，
**任何绕过它的调用点都会让「我已经替换掉了这个副作用」变成一句错话**。
危险不是「一半代码没被覆盖」，而是**测试和取证工具会给出一个自信的错误结论**：
一个断言「没有网络访问」的脚本会报红，但一个断言「审计行写了什么」的脚本会**通过**，
而网络上留下了真实连接。

修法是让 `execOn` 也走 `this.connect`。守住它的是两条**计数**断言：

```js
eq("execOn dials through the injected connect, not the shared one", dials, 1);
eq("execOn surfaces the injected dial's own failure", seamError, "seam dial");
```

**为什么必须数调用次数**：一个从未被调用的替身，与根本没有替身，
在外部观察下**完全一样**。只有计数才能把「接缝存在」和「接缝在生效」分开。
M71 就是把这个调用点改回模块级的 `connect`，红在 `expected 1, got 0`。

> **接缝的关键属性不是「存在」，而是「没有旁路」。**
> 这和坑 14 的坐标轴是同一条道理的两面：那里是「不要有第二条**计算**路径」，
> 这里是「不要有第二条**副作用**路径」。

## 坑 18：一个验证自己的守卫，永远是对的

整理成 GitHub 标准格式时，`files[]` 补上了 `LICENSE` 和 `SECURITY.md`。
补完顺手加了条守卫：**「`files[]` 里每个条目都真的进包了」**。

为了证明这条守卫不是空的，把 `LICENSE` 从 `files[]` 里删掉，再打一个包。

**`ALL PASS`。**

原因很朴素：那条守卫**从 `files[]` 里读出清单**，再拿清单去验证 `files[]`。
删掉一个条目，**它自己的检查连同被检查的对象一起消失了**。

```js
// 第一版（错）：期望来自「被测对象本身」
const literalFiles = (manifest.files ?? []).filter((entry) => !entry.includes("*"));
const missing = literalFiles.filter((entry) => !shipped.has(`package/${entry}`));
```

改成把清单**写在源码里**，`files[]` 只是被比对的一方：

```js
// 第二版（对）
const REQUIRED_FILES = ["index.js", "client.js", "cordis.patch.yml", "icon.svg",
  "README.md", "LICENSE", "SECURITY.md", "locale/zh.json", "locale/en.json"];
```

**但改完还不够。** 那条循环对**每个条目**问一次问题，所以**清单本身也是输入**：
删掉一个条目，那个条目的断言就没了。变异体 M72 **第二次存活**——同一个形状，只高了一层。

真正的修法是再加一条**不依赖清单内容**的锚点：

```js
const EXPECTED_ROSTER_SIZE = 9;
check(`the required-file roster is intact (${EXPECTED_ROSTER_SIZE} entries)`,
  REQUIRED_FILES.length === EXPECTED_ROSTER_SIZE, `found ${REQUIRED_FILES.length}: ...`);
```

这条数字是**期望**，不是**测量**。增删文件时，要改的是这一行——那正是它有用的原因。

同族的两条，也一起记下：

- **M73 第一版是「崩溃」而不是「红」。** 它删掉 `files[]` 最后一个条目，留下一个尾随逗号，
  `package.json` 不再可解析，套件死在 `JSON.parse` 里，**一条断言都没读到**。
  让 edit 连前面的逗号一起吃之后，它才红在真断言上。
- **改这批路径时，有 5 个文件漏了声明**，于是套件报 `ReferenceError`，
  计数变成 **`ok=0 fail=0`**——**崩溃被计成 0 条断言，而不是红**，
  「跑全部」的命令因此静默通过。

> **一个验证自己的守卫，永远是对的。** 它在两种情况下骗人：读它要验证的那份东西，
> 或者把期望写在被测对象里面。这两种情况下**删掉功能会同时删掉证据**，
> 于是「全绿」不再意味着任何事。
> **守卫必须有一条它自己的、与被测对象无关的锚点。**


