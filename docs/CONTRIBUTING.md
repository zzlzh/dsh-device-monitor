# 参与开发

面向要改这个插件的人。**先读 [PITFALLS.md](PITFALLS.md)**——这里省略的很多「显然可以那样写」
的写法，都在那里记录过它们为什么不行。

## 环境

| 需要 | 说明 |
| --- | --- |
| Node.js | `>= 20`（`.mjs` 测试脚本用的是顶层 `await` 与 `node:fs` 现代 API） |
| PowerShell | 只需 Windows 下跑 `run-all.ps1` / `run-mutations.ps1`；其余套件 `node` 直接可跑 |
| DSH Desktop 外壳 | **只有三个套件需要**（`verify-define-tool` / `verify-host-boot` / `verify-fresh-boot-e2e`），因为它们要读 `app.asar` 里的真 `defineTool` |
| `ssh2` / `ws` | 声明在 `dependencies`；宿主 profile 里已装就不用另装 |

不需要安装 React——客户端半通过 `require("react")` 取 DSH 自带的 18.3.1。

## 跑测试

```powershell
# 全部，一条命令，一个退出码
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-all.ps1
```

**只改了一处、要看单个套件时**（对照 README「测试」一节的清单）：

```powershell
node tools\smoke.mjs          # Host 半：路由、采集、解析、审计
node tools\client-smoke.mjs   # 浏览器半：mock React/DOM/ModuleLoader
```

> `run-all.ps1` 与 `run-mutations.ps1` **绝不能并发**：变异驱动器会**就地改写**目标源文件，
> 而 `run-all` 正在读那些文件。并发跑会得到两个都不可信的结论。

## 改代码的硬规矩

1. **源文件用 Tab 缩进、LF 换行**（`.editorconfig` / `.gitattributes` 已固化）。
   `*.pristine` 是**逐字节**基线，被排除在换行翻译之外——任何对它们的规范化都会让
   `apply-mutation.mjs check` 的字面锚点匹配失败。
2. **不要在 `const CSS = \`…\`` 里出现反引号**，注释也不行。模板字符串会提前闭合，
   报出来的却是 `SyntaxError: Unexpected identifier <某个 CSS 单词>`，看起来像语法写错了。
   这个坑踩过六次。
3. **客户端半不能 `import` Host 半的任何东西。** bundle 是独立发布的，
   `WAVE_COLUMNS` / `THRESHOLD_KEYS` 这类常量因此是**有意重复**的两份。
4. **只用主题变量**（`var(--dsw-alias-*)`），不要写死颜色。
5. **改了 Host 半要重启进程**才生效；Client 半刷新页面即可。详见 README「改动 Host 半之后需要重启」。

## 加一条断言

标准是**从公开入口断言**，而不是从内部函数。一个调用点把参数传错、而函数本身是对的，
纯函数测试永远看不见——`withStoredSecret` 那个缺陷就是这样漏掉的。

```js
const check = (label, condition, detail) => { /* … */ };
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
```

- **`eq` 的第二参是 actual、第三参是 expected。** 写反了报错信息会反过来读。
- 每条断言都必须**先证明它非空**：断言两个集合相等之前，先断言集合不为空。
  否则「树里根本没有这个节点」会被当成「它没有画错」。
- **不要对 `undefined` 取下标。** 缺元素时那是一次 `TypeError`，而**靠崩溃抓到的变异体
  不是被覆盖的变异体**——那是没问到问题的测试。用 `(x[0] ?? "")`。
- 断言里的**范围要写准**：统计一张卡片的 chip 数时，别把整张网格传进去。
- 一个**写不进也读不出**的字段、一个**只写不读**的变量，都是断言陷阱。见到就删，或补断言。

## 加一个变异体

变异测试的价值在于它回答「**如果没有这段代码，有没有断言会红**」。
`tools/apply-mutation.mjs` 里的每个条目是一次**单点**改写：

```js
{
	name: "M72 monitor: dial the probe around the injected connect",
	target: "monitor",
	edits: [["conn = await this.connect(device);", "conn = await connect(device);"]],
}
```

流程：

```powershell
node tools\apply-mutation.mjs list          # 看编号与目标
node tools\apply-mutation.mjs apply 71      # 就地写入变异体
node tools\smoke.mjs                        # 手动看它红在哪
node tools\apply-mutation.mjs restore       # 从 pristine 恢复
node tools\apply-mutation.mjs check         # 每条锚点都在基线里吗
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-mutations.ps1 -From 71 -To 71
```

规则：

- **`target` 必须是 `TARGETS` 里已有的键**，且 `edits` 的查找串必须**逐字节**存在于该目标的
  `.pristine` 里（`check` 会告诉你哪条没对上）。注意缩进：`package.json` 是**两空格**，
  源码是 **Tab**。
- **改了目标源文件之后必须刷新它的 pristine**，否则 `apply` 会拿旧基线覆盖你的新代码。
  `check` 绿只说明「锚点在**基线**里」，不说明「锚点在**当前源码**里」。
- 新增变异体后，在 `run-mutations.ps1` 的 `$suiteFor` 里确认该 `target` 指向**能观察到它**的套件。
  一个 target 可以映射**多个**套件（数组），驱动器取第一个变红的。
- **判据放在正确的层**：打包缺陷只有 `pack-dist.mjs` 看得见（其余套件跑在工作树上，
  而工作树正是隐藏该缺陷的地方）。

三种**非红**结果都要当成缺陷处理：

| 结果 | 含义 |
| --- | --- |
| `SURVIVED` | 没有任何断言问过这个问题。**变异体存活是测试缺口，不是合格证。** |
| `CAUGHT-CRASH` | 断言崩溃而非失败。**靠崩溃抓到的变异体不是被覆盖的变异体。** |
| `ANCHOR-MISSING` | 查找串对不上，变异体根本没被写进去。 |

变异体**只在基线为绿时才算数**：先让 `run-all.ps1` 全绿，再跑变异。
一个本来就红的基线会让某个变异体「恰好」被那条红断言抓住，得出虚假的 CAUGHT。

## 改文档

| 改动 | 要同步的地方 |
| --- | --- |
| 断言总数 / 逐套件计数 | `README.md` 的「测试」一节、`docs/DESIGN.md` 的 §9.1 与 §9.3 验收清单 |
| 变异体数量 | 同上，以及 `docs/DESIGN.md` 的 §9.1 变异说明 |
| 新撞到一个坑 | `docs/PITFALLS.md` 加一条 + README 的「坑 N」链接 |
| 一条行为是刻意这样设计的 | `docs/TRADEOFFS.md` |

**计数是断言的一部分。** 文档里的数字必须能对上实测输出——写死一个「大概」的数目，
下一次就没人知道它是错的。

## 提交前

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-all.ps1   # 期望 EVERY SUITE THAT RAN IS GREEN
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-mutations.ps1
node tools\apply-mutation.mjs check                                      # ALL 73 ANCHORS PRESENT
```

外加：把每个改过的目标文件与它的 `.pristine` 对比一次 `SHA256`，确认 `IN SYNC`；
源文件 `node --check` 过一遍。

## 分发

```powershell
node tools\pack-dist.mjs                 # pre-flight + 读打出来的包
node tools\verify-dist-installable.mjs   # 解开到新目录，按解出来的那份验证
```

**不要手工编辑宿主 profile 的 `package.json` 或 `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。**
安装只走 Desktop 外壳的 CLI（见 README「安装」）。
