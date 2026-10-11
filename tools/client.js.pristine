/**
 * Browser half of the DSH device-monitor plugin.
 *
 * Registers two seats in the Web shell, following the same contract the SSH
 * plugin uses:
 *
 *  1. a row in the sidebar's global panel list (`sidebar.panellist`), so the
 *     shell owns the row box, label, active highlight and collapsed rail;
 *  2. the page itself in the layout's keyed `main` slot, mounted only while
 *     this panel is selected.
 *
 * Both registrations go through `ctx.slots.inject`, which fires only once the
 * owning shell entry has declared the seat — so load order does not matter and
 * a shell that cannot serve the seats simply never runs the callback.
 *
 * Every mount failure is logged, never thrown: an `apply` that throws fails
 * the whole Web shell boot, which would take the user's session down over a
 * panel that merely failed to draw.
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-device-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		//#region locale
		const NS = "dsh-device-monitor";
		const zh = {
			"entry.label": "设备",
			"entry.tooltip": "设备监管面板",
			"panel.title": "设备监管",
			"panel.subtitle": "通过 SSH 采集设备运行指标",
			"panel.refreshAll": "全部刷新",
			"panel.add": "添加设备",
			"panel.count": "{count} / {max} 台设备",
			"panel.full": "已达上限（最多 {max} 台）",
			"panel.empty.title": "尚未登记设备",
			"panel.empty.body": "添加一台设备并填写 SSH 地址即可开始采集 CPU、内存、磁盘、负载与温度。",
			"panel.loading": "加载中…",
			"panel.loadFailed": "无法读取设备列表：{error}",
			"card.collect": "采集",
			"card.test": "测试连接",
			"card.edit": "编辑",
			"card.delete": "删除",
			"card.failed": "采集失败",
			"card.never": "尚未采集",
			"card.collectedAt": "采集于 {time}",
			"card.uptime": "运行 {value}",
			"card.cores": "{count} 核",
			"metric.cpu": "CPU",
			"metric.memory": "内存",
			"metric.disk": "磁盘",
			"metric.load": "负载",
			"metric.temp": "温度",
			"metric.processes": "进程",
			"metric.uptime": "运行时长",
			"detail.title": "设备详情",
			"detail.trend": "趋势",
			"detail.filesystems": "文件系统",
			"detail.colDevice": "设备",
			"detail.colMount": "挂载点",
			"detail.colUsed": "已用",
			"detail.colAvail": "可用",
			"detail.colPercent": "占用",
			"detail.services": "运行服务",
			"detail.diagnostics": "采集明细",
			"detail.model": "型号",
			"detail.kernel": "内核",
			"detail.back": "返回",
			"detail.exec": "命令",
			"detail.execPlaceholder": "在此设备上执行 shell 命令…",
			"detail.execRun": "执行",
			"detail.execRunning": "执行中…",
			"detail.execEmpty": "尚无输出。",
			"detail.noServices": "无法读取服务列表（可能没有 systemd）。",
			"form.addTitle": "添加设备",
			"form.editTitle": "编辑设备",
			"form.name": "名称",
			"form.namePlaceholder": "例如：边缘网关 01",
			"form.host": "主机地址",
			"form.hostPlaceholder": "192.168.1.10",
			"form.port": "端口",
			"form.username": "用户名",
			"form.auth": "认证方式",
			"form.authPassword": "密码",
			"form.authKey": "私钥文件",
			"form.authAgent": "SSH Agent",
			"form.password": "密码",
			"form.privateKeyPath": "私钥路径",
			"form.privateKeyPlaceholder": "C:\\Users\\me\\.ssh\\id_rsa",
			"form.description": "备注",
			"form.location": "位置",
			"form.tags": "标签（逗号分隔）",
			"card.location": "位置",
			"card.description": "备注",
			"card.tags": "标签",
			"form.cancel": "取消",
			"form.save": "保存",
			"form.saving": "保存中…",
			"form.required": "请填写名称、主机地址和用户名。",
			"confirm.delete": "确定删除设备「{name}」？",
			"test.ok": "连接成功（{ms} ms）",
			"test.fail": "连接失败：{error}",
			"alert.cpu": "CPU {value}%",
			"alert.mem": "内存 {value}%",
			"alert.disk": "磁盘 {mount} {value}%",
			"alert.temp": "温度 {type} {value}°C",
			"view.list": "设备",
			"view.settings": "设置",
			"view.logs": "日志",
			"metric.net": "网络",
			"metric.netRx": "下行",
			"metric.netTx": "上行",
			"metric.diskio": "磁盘 IO",
			"metric.diskRead": "读",
			"metric.diskWrite": "写",
			"metric.tcp": "TCP",
			"metric.top": "高占用进程",
			"wave.title": "波形",
			"wave.cpu": "CPU",
			"wave.mem": "内存",
			"wave.disk": "磁盘",
			"wave.temp": "温度",
			"wave.loading": "正在读取历史…",
			"wave.hidden": "该指标未勾选，不采集也不显示。",
			"watch.active": "自动刷新中（每 {sec} 秒）",
			"watch.paused": "面板不可见，已暂停采集",
			"watch.idle": "尚未开始自动刷新",
			"watch.leases": "观察者 {count}",
			"settings.title": "采集设置",
			"settings.interval": "刷新间隔（秒）",
			"settings.intervalHint": "允许 5–3600 秒；默认 60 秒。设备可单独覆盖。",
			"settings.deviceInterval": "本设备刷新间隔（秒，留空跟随全局）",
			"settings.thresholds": "阈值告警",
			"settings.thresholdHint": "填 0 表示关闭该项告警。",
			"settings.threshold.cpu": "CPU %",
			"settings.threshold.mem": "内存 %",
			"settings.threshold.disk": "磁盘 %",
			"settings.threshold.temp": "温度 °C",
			"settings.metrics": "显示与采集的指标",
			"settings.metricsHint": "未勾选的指标不会下发采集命令，设备端真的不执行；因此也不会显示在卡片上。",
			"settings.metricsAlways": "必选",
			"settings.rawLog": "记录采集原始数据",
			"settings.rawLogWarning": "原始数据未做脱敏，命令输出会原样落盘（含设备返回的任何内容）。日志根目录与配置文件分开，可随时删除。",
			"settings.incidents.offlineAfter": "连续失败几次判定离线",
			"settings.incidents.rebootDetect": "检测重启",
			"settings.incidents.rebootMinDrop": "重启判定：运行时间回落超过（秒）",
			"settings.save": "保存设置",
			"settings.saving": "保存中…",
			"settings.saved": "设置已保存。",
			"settings.loadFailed": "无法读取设置：{error}",
			"settings.deviceTitle": "本设备的采集设置",
			"settings.cleared": "已恢复为跟随全局设置。",
			"settings.custom": "自定义采集命令（高级）",
			"settings.customEnable": "启用命令覆盖",
			"settings.customHint": "按指标键替换默认命令体。未勾选的指标仍然一条命令都不下发——覆盖只替换命令，不打开门控。",
			"settings.customWarning": "风险：这些命令会随定时采集自动执行，且不受 Agent 工具的命令白名单约束。默认关闭；每次实际执行都会写入审计日志。留空表示该指标用回内置命令。",
			"settings.customPlaceholder": "留空 = 使用内置命令",
			"logs.title": "采集日志",
			"logs.raw": "原始数据",
			"logs.audit": "操作审计",
			"logs.incidents": "异常记录",
			"logs.dir": "日志目录",
			"logs.enabled": "记录已启用",
			"logs.disabled": "记录已关闭（不会写入任何原始数据）",
			"logs.total": "日志总量",
			"logs.empty": "暂无记录。",
			"logs.deviceHeader": "设备原始日志",
			"logs.auditHeader": "操作审计（只记录字段名，不记录取值）",
			"logs.incidentHeader": "离线 / 重启事件",
			"logs.loadFailed": "无法读取日志：{error}",
			"incident.offline": "离线",
			"incident.online": "恢复在线",
			"incident.reboot": "重启",
			"incident.fails": "连续失败 {count} 次",
			"incident.down": "已离线 {sec} 秒",
			"incident.none": "无异常记录。",
			"panel.metricsNote": "指标在「设置」中配置。",
			"panel.noAlerts": "无告警。",
			"panel.notWatching": "未采集（面板不可见）",
			"panel.watchFailed": "自动刷新失败：{error}",
			"form.testDraft": "测试连接",
			"form.testing": "测试中…",
			"form.testOk": "连接成功（{ms} ms）",
			"form.testFail": "连接失败：{error}",
			"form.testDraftHint": "未保存的设备用表单中的凭据试连，不会写入任何配置。",
			"form.keepSecret": "留空表示不修改当前密码 / 私钥。",
			"term.title": "终端调试",
			"term.open": "终端调试",
			"term.openHint": "在这台设备上打开一个交互式 shell（需要在设置中先开启终端调试）",
			"term.close": "关闭",
			"term.warning": "⚠️ 调试模式 · 这里的输入不经命令白名单，会直接在设备上执行",
			"term.disabled": "终端未开启。请到「设置 → 终端调试」里打开后重试。",
			"term.connecting": "正在连接 {host} …",
			"term.connected": "已连接。输入命令后回车执行，输出显示在这里。\n（提示：命令卡住时点上面的 ⌃C 可以中断它；top / vim 这类全屏程序在这个逐行输入框里显示不正常，请用 top -b -n1 这类一次性输出的写法。）\n\n",
			"term.timeout": "连接超时（{sec} 秒内没有完成握手）。可能是代理拦了 WebSocket，或设备不可达。",
			"term.timeoutSession": "服务端在 {sec} 秒内没有确认会话（远端 SSH 可能卡住或设备不可达）。请关闭后重试，或先用卡片上的「测试连接」确认这台设备能不能连上。",
			"term.failed": "无法建立终端连接：可能终端未开启，或来源地址不在终端的允许列表里。",
			"term.createFailed": "无法创建终端连接：{error}",
			"term.sendFailed": "输入发送失败：{error}",
			"term.disconnected": "连接已断开{detail}。请关闭后重新打开终端。",
			"term.exited": "远端已结束会话",
			"term.notOpen": "终端未连接，没有发送。请关闭后重新打开终端。",
			"term.stillConnecting": "终端还在连接中，没有发送。请等出现「已连接」后再试。",
			"term.keySent": "␃ {key} 已发送",
			"term.placeholder": "输入命令后回车（上面的控制键可随时中止它）",
			"term.run": "执行",
			"term.onlyOne": "已经有一个终端在运行，请先关闭它。",
			"term.sessions": "当前会话 {count} / {max}",
			"settings.terminal": "终端调试（高级）",
			"settings.terminalEnable": "允许在设备上打开交互式终端",
			"settings.terminalHint": "默认关闭。打开后，设备卡片上会出现「终端调试」按钮，可在该设备上打开一个交互式 shell。",
			"settings.terminalWarning": "风险：终端里的输入不受 Agent 工具的命令白名单约束，会被原样发到设备上执行。服务端只要求来源为本机回环地址，并做了会话数上限与空闲自动断开；审计只记录会话的开启与关闭，不记录敲了什么。",
			"settings.terminalHosts": "允许的来源地址（每行一个，留空不限）",
			"settings.terminalHostsHint": "支持精确 IP、CIDR（如 192.168.1.0/24）与主机名。留空表示不限制——此时唯一的要求是连接来自本机回环地址。主机名在每次连接时解析。",
			"settings.terminalIdle": "空闲自动断开（秒）",
			"settings.terminalIdleHint": "允许 30–3600 秒。超过这个时间没有任何输入就自动关闭会话，避免忘记关闭的终端一直挂在设备上。",
		};
		const en = {
			"entry.label": "Devices",
			"entry.tooltip": "Device monitoring panel",
			"panel.title": "Device Monitor",
			"panel.subtitle": "Collect device metrics over SSH",
			"panel.refreshAll": "Refresh all",
			"panel.add": "Add device",
			"panel.count": "{count} / {max} devices",
			"panel.full": "Limit reached (max {max}) — remove a device to add another.",
			"panel.empty.title": "No devices yet",
			"panel.empty.body": "Add a device with its SSH address to start collecting CPU, memory, disk, load and temperature.",
			"panel.loading": "Loading…",
			"panel.loadFailed": "Could not load devices: {error}",
			"card.collect": "Collect",
			"card.test": "Test",
			"card.edit": "Edit",
			"card.delete": "Delete",
			"card.failed": "Collection failed",
			"card.never": "Not collected yet",
			"card.collectedAt": "Collected {time}",
			"card.uptime": "up {value}",
			"card.cores": "{count} cores",
			"metric.cpu": "CPU",
			"metric.memory": "Memory",
			"metric.disk": "Disk",
			"metric.load": "Load",
			"metric.temp": "Temp",
			"metric.processes": "Processes",
			"metric.uptime": "Uptime",
			"detail.title": "Device detail",
			"detail.trend": "Trend",
			"detail.filesystems": "Filesystems",
			"detail.colDevice": "Device",
			"detail.colMount": "Mount",
			"detail.colUsed": "Used",
			"detail.colAvail": "Avail",
			"detail.colPercent": "Used %",
			"detail.services": "Running services",
			"detail.diagnostics": "Collection detail",
			"detail.model": "Model",
			"detail.kernel": "Kernel",
			"detail.back": "Back",
			"detail.exec": "Command",
			"detail.execPlaceholder": "Run a shell command on this device…",
			"detail.execRun": "Run",
			"detail.execRunning": "Running…",
			"detail.execEmpty": "No output yet.",
			"detail.noServices": "Service list unavailable (no systemd?).",
			"form.addTitle": "Add device",
			"form.editTitle": "Edit device",
			"form.name": "Name",
			"form.namePlaceholder": "e.g. Edge gateway 01",
			"form.host": "Host",
			"form.hostPlaceholder": "192.168.1.10",
			"form.port": "Port",
			"form.username": "Username",
			"form.auth": "Authentication",
			"form.authPassword": "Password",
			"form.authKey": "Private key file",
			"form.authAgent": "SSH agent",
			"form.password": "Password",
			"form.privateKeyPath": "Private key path",
			"form.privateKeyPlaceholder": "C:\\Users\\me\\.ssh\\id_rsa",
			"form.description": "Description",
			"form.location": "Location",
			"form.tags": "Tags (comma separated)",
			"card.location": "Location",
			"card.description": "Notes",
			"card.tags": "Tags",
			"form.cancel": "Cancel",
			"form.save": "Save",
			"form.saving": "Saving…",
			"form.required": "Name, host and username are required.",
			"confirm.delete": "Delete device \"{name}\"?",
			"test.ok": "Connected ({ms} ms)",
			"test.fail": "Connection failed: {error}",
			"alert.cpu": "CPU {value}%",
			"alert.mem": "Memory {value}%",
			"alert.disk": "Disk {mount} {value}%",
			"alert.temp": "Temp {type} {value}°C",
			"view.list": "Devices",
			"view.settings": "Settings",
			"view.logs": "Logs",
			"metric.net": "Network",
			"metric.netRx": "Down",
			"metric.netTx": "Up",
			"metric.diskio": "Disk IO",
			"metric.diskRead": "Read",
			"metric.diskWrite": "Write",
			"metric.tcp": "TCP",
			"metric.top": "Top processes",
			"wave.title": "Trend",
			"wave.cpu": "CPU",
			"wave.mem": "Memory",
			"wave.disk": "Disk",
			"wave.temp": "Temp",
			"wave.loading": "Loading history…",
			"wave.hidden": "This metric is not selected — it is neither collected nor shown.",
			"watch.active": "Auto-refreshing every {sec}s",
			"watch.paused": "Panel hidden — collection paused",
			"watch.idle": "Auto-refresh not started yet",
			"watch.leases": "Watchers {count}",
			"settings.title": "Collection settings",
			"settings.interval": "Refresh interval (seconds)",
			"settings.intervalHint": "Allowed 5–3600s; default 60s. A device can override it.",
			"settings.deviceInterval": "This device's interval (seconds; empty follows the global)",
			"settings.thresholds": "Threshold alerts",
			"settings.thresholdHint": "0 disables that alert.",
			"settings.threshold.cpu": "CPU %",
			"settings.threshold.mem": "Memory %",
			"settings.threshold.disk": "Disk %",
			"settings.threshold.temp": "Temp °C",
			"settings.metrics": "Metrics collected and shown",
			"settings.metricsHint": "An unselected metric sends no command at all — the device really does not run it, so it is not shown either.",
			"settings.metricsAlways": "always",
			"settings.rawLog": "Record raw collection data",
			"settings.rawLogWarning": "Raw data is NOT redacted: command output is written verbatim, including anything the device returns. The log root is separate from the config file and can be deleted at any time.",
			"settings.incidents.offlineAfter": "Consecutive failures before offline",
			"settings.incidents.rebootDetect": "Detect reboots",
			"settings.incidents.rebootMinDrop": "Reboot when uptime drops by (seconds)",
			"settings.save": "Save settings",
			"settings.saving": "Saving…",
			"settings.saved": "Settings saved.",
			"settings.loadFailed": "Could not load settings: {error}",
			"settings.deviceTitle": "Per-device collection settings",
			"settings.cleared": "Reverted to following the global settings.",
			"settings.custom": "Custom collection commands (advanced)",
			"settings.customEnable": "Enable command overrides",
			"settings.customHint": "Replace the default command body per metric key. An unselected metric still sends no command at all — an override replaces a command, it never opens the gate.",
			"settings.customWarning": "Risk: these commands run automatically on the collection timer and are NOT constrained by the Agent tool command whitelist. Off by default; every actual execution is written to the audit log. Leave empty to use the built-in command for that metric.",
			"settings.customPlaceholder": "empty = built-in command",
			"logs.title": "Collection logs",
			"logs.raw": "Raw data",
			"logs.audit": "Audit",
			"logs.incidents": "Incidents",
			"logs.dir": "Log directory",
			"logs.enabled": "Recording enabled",
			"logs.disabled": "Recording disabled (no raw data is written)",
			"logs.total": "Total",
			"logs.empty": "No records yet.",
			"logs.deviceHeader": "Per-device raw logs",
			"logs.auditHeader": "Audit trail (field names only, never values)",
			"logs.incidentHeader": "Offline / reboot events",
			"logs.loadFailed": "Could not load logs: {error}",
			"incident.offline": "Offline",
			"incident.online": "Back online",
			"incident.reboot": "Rebooted",
			"incident.fails": "{count} consecutive failures",
			"incident.down": "down {sec}s",
			"incident.none": "No incidents.",
			"panel.metricsNote": "Configure metrics under Settings.",
			"panel.noAlerts": "No alerts.",
			"panel.notWatching": "Not collected (panel hidden)",
			"panel.watchFailed": "Auto-refresh failed: {error}",
			"form.testDraft": "Test",
			"form.testing": "Testing…",
			"form.testOk": "Connected ({ms} ms)",
			"form.testFail": "Connection failed: {error}",
			"form.testDraftHint": "An unsaved device is tested with the credentials in this form; nothing is written.",
			"form.keepSecret": "Leave empty to keep the current password / key.",
			"term.title": "Terminal",
			"term.open": "Terminal",
			"term.openHint": "Open an interactive shell on this device (turn the debug terminal on in Settings first)",
			"term.close": "Close",
			"term.warning": "⚠️ Debug mode · input here bypasses the command whitelist and runs on the device",
			"term.disabled": "The terminal is off. Turn it on under Settings → Terminal, then retry.",
			"term.connecting": "Connecting to {host} …",
			"term.connected": "Connected. Type a command and press Enter; output appears here.\n(Tip: if a command hangs, ⌃C above interrupts it. Full-screen programs such as top and vim do not display correctly in this line-oriented box — use one-shot forms like top -b -n1.)\n\n",
			"term.timeout": "Connection timed out (no handshake within {sec}s). A proxy may be blocking WebSockets, or the device is unreachable.",
			"term.timeoutSession": "The server did not confirm a session within {sec}s (the remote SSH may be stuck or the device unreachable). Close and retry, or use the card's Test button to check reachability first.",
			"term.failed": "Could not open the terminal: it may be switched off, or this address is not on its allowlist.",
			"term.createFailed": "Could not create the terminal connection: {error}",
			"term.sendFailed": "Send failed: {error}",
			"term.disconnected": "Disconnected{detail}. Close and reopen the terminal.",
			"term.exited": "The remote end closed the session",
			"term.notOpen": "The terminal is not connected; nothing was sent. Close and reopen it.",
			"term.stillConnecting": "The terminal is still connecting; nothing was sent. Wait for the connected notice.",
			"term.keySent": "␃ {key} sent",
			"term.placeholder": "Type a command and press Enter (the control keys above can interrupt it)",
			"term.run": "Run",
			"term.onlyOne": "A terminal is already running; close it first.",
			"term.sessions": "{count} / {max} sessions",
			"settings.terminal": "Debug terminal (advanced)",
			"settings.terminalEnable": "Allow an interactive terminal on a device",
			"settings.terminalHint": "Off by default. Once on, each device card offers a Terminal button that opens an interactive shell on that device.",
			"settings.terminalWarning": "Risk: input in the terminal is not constrained by the Agent tool command whitelist and is sent to the device verbatim. The server requires a loopback source address and enforces session caps plus an idle timeout; the audit records when a session opened and closed, never what was typed.",
			"settings.terminalHosts": "Allowed source addresses (one per line, empty = any)",
			"settings.terminalHostsHint": "Accepts exact IPs, CIDR (e.g. 192.168.1.0/24) and host names. Empty means no restriction — the only remaining requirement is that the connection comes from loopback. Host names are resolved on each connection.",
			"settings.terminalIdle": "Disconnect when idle (seconds)",
			"settings.terminalIdleHint": "Accepts 30–3600. A session with no input for this long is closed automatically, so a forgotten terminal does not stay attached to the device.",
		};
		const dictionaries = { zh, en };
		let runtimeTranslate;
		/**
		 * Translate a key; falls back to the zh dictionary, then the key itself.
		 *
		 * Interpolation uses the shell's own single-brace form `{name}` — the
		 * bound translator substitutes with `/\{(\w+)\}/g`, so a doubled
		 * `{{name}}` would be left behind as a stray `{name}`. The local
		 * replacement below accepts optional inner padding purely so a
		 * hand-written `{ name }` still resolves.
		 */
		function t(key, values) {
			if (runtimeTranslate !== undefined) {
				const translated = runtimeTranslate(key, values);
				if (typeof translated === "string" && translated !== key) return translated;
			}
			const template = zh[key] ?? key;
			if (values === undefined) return template;
			return template.replace(/\{\s*(\w+)\s*\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));
		}
		//#endregion

		//#region api
		const API_BASE = "/api/dsh-device-monitor";
		/**
		 * This browser tab's watch identity.
		 *
		 * Per-tab rather than per-install: two open windows are two watchers, and
		 * closing one must not cancel the other's lease.
		 */
		const CLIENT_ID = `ddm-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
		const API = {
			overview: `${API_BASE}/overview`,
			devices: `${API_BASE}/devices`,
			test: `${API_BASE}/test`,
			testDraft: `${API_BASE}/test-draft`,
			collect: `${API_BASE}/collect`,
			metrics: `${API_BASE}/metrics`,
			exec: `${API_BASE}/exec`,
			settings: `${API_BASE}/settings`,
			catalog: `${API_BASE}/catalog`,
			watch: `${API_BASE}/watch`,
			rawlog: `${API_BASE}/rawlog`,
			incidents: `${API_BASE}/incidents`,
			audit: `${API_BASE}/audit`,
			logs: `${API_BASE}/logs/status`,
			// Two different things on two different paths, deliberately: the JSON
			// route reports the terminal's state, and the sibling WebSocket path
			// (same base, no `/status`) carries the shell itself. Merging them
			// would make one handler decide between a status read and a shell
			// upgrade from the request alone.
			terminal: `${API_BASE}/terminal/status`,
			terminalSocket: `${API_BASE}/terminal`,
		};
		class ApiError extends Error {
			constructor(message, status) {
				super(message);
				this.name = "ApiError";
				this.status = status;
			}
		}
		/** One JSON request against the same-origin device API. */
		async function request(url, options = {}) {
			const response = await fetch(url, {
				...options,
				headers: { "content-type": "application/json", ...(options.headers ?? {}) },
			});
			const text = await response.text();
			let body;
			try {
				body = text === "" ? undefined : JSON.parse(text);
			} catch {
				body = undefined;
			}
			if (!response.ok) {
				throw new ApiError(body?.error ?? `request failed with status ${response.status}`, response.status);
			}
			return body;
		}
		const api = {
			overview: () => request(API.overview),
			list: () => request(API.devices),
			create: (payload) => request(API.devices, { method: "POST", body: JSON.stringify(payload) }),
			update: (id, patch) => request(`${API.devices}?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
			remove: (id) => request(`${API.devices}?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
			test: (id) => request(`${API.test}?id=${encodeURIComponent(id)}`, { method: "POST" }),
			testDraft: (payload) => request(API.testDraft, { method: "POST", body: JSON.stringify(payload) }),
			collect: (id) => request(id === undefined ? API.collect : `${API.collect}?id=${encodeURIComponent(id)}`, { method: "POST" }),
			metrics: (id, limit = 60) => request(`${API.metrics}?id=${encodeURIComponent(id)}&limit=${limit}`),
			exec: (id, command, timeoutMs) => request(`${API.exec}?id=${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ command, timeoutMs }) }),
			settings: () => request(API.settings),
			saveSettings: (patch) => request(API.settings, { method: "PATCH", body: JSON.stringify(patch) }),
			catalog: () => request(API.catalog),
			/**
			 * Renew this client's watch lease. The Host polls a device only while
			 * some client has heartbeat recently, so a closed panel stops traffic
			 * instead of dialling 10 devices forever.
			 */
			watch: (clientId, intervalSec) => request(API.watch, { method: "POST", body: JSON.stringify({ clientId, intervalSec }) }),
			unwatch: (clientId) => request(API.watch, { method: "POST", body: JSON.stringify({ clientId, release: true }) }),
			rawlog: (id, limit = 200) => request(`${API.rawlog}?id=${encodeURIComponent(id)}&limit=${limit}`),
			incidents: (limit = 200) => request(`${API.incidents}?limit=${limit}`),
			audit: (limit = 200) => request(`${API.audit}?limit=${limit}`),
			logs: () => request(API.logs),
			terminal: () => request(API.terminal),
		};
		//#endregion

		//#region styles
		const CSS = `
.ddm-view{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.ddm-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.ddm-head-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ddm-title{font-size:15px;font-weight:600}
.ddm-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ddm-spacer{flex:1}
.ddm-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap}
.ddm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ddm-btn:disabled{opacity:.45;cursor:not-allowed}
.ddm-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.ddm-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}
.ddm-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ddm-body{flex:1;min-height:0;overflow:auto;padding:16px 18px 24px}
.ddm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.ddm-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ddm-card-top{display:flex;align-items:center;gap:8px;min-width:0}
.ddm-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.ddm-dot-ok{background:var(--dsw-alias-state-success-primary)}
.ddm-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.ddm-dot-err{background:var(--dsw-alias-state-error-primary)}
.ddm-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddm-addr{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddm-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.ddm-tag{font-size:10px;line-height:1;padding:2px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary);color:var(--dsw-alias-label-secondary)}
.ddm-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow-wrap:anywhere}
.ddm-note-key{opacity:.75;margin-right:4px}
.ddm-notes{display:flex;flex-direction:column;gap:2px}
.ddm-row{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ddm-alerts{display:flex;flex-wrap:wrap;gap:6px}
.ddm-alert{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.ddm-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:4px}
.ddm-card-actions .ddm-btn{height:24px;padding:0 8px;font-size:11px}
.ddm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;min-height:220px;text-align:center;color:var(--dsw-alias-label-secondary)}
.ddm-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ddm-error{padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);margin-bottom:12px}
.ddm-notice{padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-bottom:12px;font-size:12px}
.ddm-panel{display:flex;flex-direction:column;gap:14px}
.ddm-section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.ddm-section-title{font-size:12px;font-weight:600;margin-bottom:10px}
.ddm-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.ddm-kv-key{color:var(--dsw-alias-label-secondary)}
.ddm-table{width:100%;border-collapse:collapse;font-size:12px}
.ddm-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 8px 4px 0}
.ddm-table td{padding:4px 8px 4px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ddm-services{display:flex;flex-wrap:wrap;gap:6px}
.ddm-chip{font-size:11px;padding:2px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ddm-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px;margin:0}
.ddm-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}
.ddm-modal{width:min(480px,100%);max-height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px}
.ddm-form{display:flex;flex-direction:column;gap:12px}
.ddm-field{display:flex;flex-direction:column;gap:4px}
.ddm-field > label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ddm-field input,.ddm-field select,.ddm-field textarea{height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}
.ddm-field textarea{height:auto;min-height:60px;padding:6px 8px;resize:vertical}
.ddm-field input:focus,.ddm-field select:focus,.ddm-field textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ddm-inline{display:flex;gap:10px}
.ddm-inline > .ddm-field{flex:1}
.ddm-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.ddm-spark{display:block;width:100%;height:56px}
.ddm-exec-row{display:flex;gap:8px;align-items:flex-start}
.ddm-exec-row input{flex:1;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ddm-exec-row input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
/* The debug terminal, pinned to the bottom-right corner rather than centred.
   Two reasons: the right column is far too narrow for a centred dialog, and the
   whole point of the feature is to watch a command on a device WHILE reading the
   conversation — a modal would hide exactly the thing being debugged.
   ABSOLUTE, not fixed, so the corner is the corner of the column this plugin was
   opened in rather than the corner of the window. Width and height use
   percentages for the same reason: "as wide as the pane, less a gutter" is the
   intent, and 100vw/100vh would make an 720px panel overflow a 380px sidebar.
   Fixed positioning was the m09258 defect: see ddm-term-panel-full below. */
.ddm-term-panel{position:absolute;right:18px;bottom:18px;z-index:70;display:flex;flex-direction:column;width:min(720px,calc(100% - 36px));max-height:min(560px,calc(100% - 36px));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
/* Expanding means FILLING THE COLUMN THE PANEL WAS OPENED FROM, never the
   browser window. Both the corner rule and this one are therefore ABSOLUTE,
   not fixed, and they resolve against the view root this plugin renders
   (.ddm-view, position:relative above) — a box the plugin owns in EVERY seat.
   That is the whole point: an earlier version used position:fixed and trusted
   the sidebar to trap it, which is false. Measured in the installed
   dsh-better-sidebar bundle, the only containing-block-creating ancestor is
   [data-dsh-panel-host]{z-index:25;pointer-events:none;position:fixed;inset:0;
   overflow:clip} — a FULL-VIEWPORT layer — and .nArs4W_pane is merely
   position:relative, which does not capture a fixed descendant at all. So the
   four insets at 0 resolved against the window, the panel swallowed the screen,
   and its own restore button ended up under the shell's title bar and could not
   be clicked. Anchoring to our own root cannot make that mistake: the panel is
   a child of .ddm-view in both seats, so it fills the right column in the
   sidebar and the main area in the main seat, and the button stays reachable.

   The element-level Fullscreen API is still deliberately NOT used. It lifts the
   panel into the browser's top layer and covers the whole window, which defeats
   the feature (watch a command on a device WHILE reading the conversation).

   The insets must be 0 and not 18px: a matching gutter is what made an even
   earlier attempt look like it had merely grown rather than filled.
   max-height:none is required because the base rule caps it; height is left
   auto so the inset pair keeps driving the box. */
.ddm-term-panel-full{position:absolute;left:0;top:0;right:0;bottom:0;width:auto;max-height:none;border:0;border-radius:0}
.ddm-term-panel-full .ddm-term-out{font-size:13px}
.ddm-term-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;min-width:0}
.ddm-term-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ddm-term-warn{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ddm-term-out{flex:1;min-height:120px;margin:0;padding:10px;overflow:auto;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
/* Output is written as spans so a system notice can be toned without touching
   the device's own bytes. The classes carry meaning, not colour, so the same
   tree renders correctly under either theme. */
.ddm-term-sys{color:var(--dsw-alias-label-secondary)}
.ddm-term-err{color:var(--dsw-alias-state-error-primary)}
/* The control-key bar: each button sends ONE control byte, not a line. ⌃C comes
   first because its whole purpose is interrupting a command that is already
   running — and in a line-oriented input box, typing into it cannot do that. */
.ddm-term-keys{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.ddm-term-key{height:22px;min-width:30px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer}
.ddm-term-key:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ddm-term-key-sep{width:1px;height:14px;background:var(--dsw-alias-border-l1);margin:0 3px}
.ddm-term-form{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.ddm-term-prompt{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.ddm-term-form input{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ddm-term-form input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ddm-view,.ddm-view *{box-sizing:border-box}
.ddm-view{overflow-x:hidden}
.ddm-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:8px 18px 0;flex:none}
.ddm-tab{height:26px;padding:0 10px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.ddm-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.ddm-tab-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.ddm-body-narrow{padding:12px 12px 20px}
.ddm-head-narrow{padding:10px 12px}
/* One trend chart per ROW (the user's requirement) — a stack, not a grid. As a
   multi-column grid each chart got about 112px, which is too narrow to read a
   trend from, and four of them competed for the same line. Each row is now
   [name + reading | full-width chart], which is what makes the shape legible. */
.ddm-waves{display:flex;flex-direction:column;gap:8px}
.ddm-wave{display:grid;grid-template-columns:88px minmax(0,1fr);align-items:center;gap:10px;min-width:0}
.ddm-wave-label{display:flex;flex-direction:column;gap:1px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}
.ddm-wave-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ddm-wave .ddm-spark{height:34px}
.ddm-spark-empty{font-size:11px;color:var(--dsw-alias-label-secondary);height:34px;display:flex;align-items:center}
/* The plot area: the line and its y labels share one grid cell row, so the tick
   values are aligned to the geometry they describe rather than eyeballed. The
   x labels sit under the line in the chart's own column, so they start and end
   with the line instead of with the label gutter beside it. */
.ddm-wave-plot{display:grid;grid-template-columns:40px minmax(0,1fr);grid-template-rows:auto auto;column-gap:6px;min-width:0}
.ddm-wave-plot .ddm-spark{grid-column:2;grid-row:1}
.ddm-wave-plot .ddm-spark-empty{grid-column:2;grid-row:1}
.ddm-axis{display:flex;font-size:9px;line-height:1;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ddm-axis-y{grid-column:1;grid-row:1;flex-direction:column;justify-content:space-between;align-items:flex-end}
/* A tick label is centred on the value it marks, so the first and last must
   hang half a line outside the plot box. Without this the top tick's centre
   sits 4px below the line's high end on a 34px chart — a small offset, but it
   is exactly the kind of quiet disagreement between the numbers and the
   geometry that a shared scale exists to prevent. A transform is used because
   it shifts paint without changing layout, so the row keeps the plot's height. */
.ddm-axis-y > :first-child{transform:translateY(-50%)}
.ddm-axis-y > :last-child{transform:translateY(50%)}
.ddm-axis-x{grid-column:2;grid-row:2;justify-content:space-between;padding-top:1px}
/* The numbers WITHOUT a chart: side by side, wrapping into as many columns as
   fit (the user's requirement). Label-over-value per cell, so a longer label
   never shifts its value out of alignment with the neighbouring cells. */
.ddm-nums{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px 12px;font-size:11px}
.ddm-num{display:flex;flex-direction:column;gap:1px;min-width:0}
.ddm-num-label{color:var(--dsw-alias-label-secondary)}
.ddm-num-value{color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.ddm-form-panel{display:flex;flex-direction:column;gap:12px}
/* Scoped AWAY from checkboxes on purpose. The bare input selector below has
   specificity (0,2,1) and beats .ddm-check input (0,1,1), so writing
   width:100% over every input stretched each 15px checkbox across the whole
   form column — the box grew to the width of the panel and pushed its own
   label text into a narrow strip on the right. The reference system carries the
   same regression note on its own #device-form label.check input.
   :not([type="checkbox"]) keeps the text fields full-width without winning
   the specificity fight against the checkbox rule. */
.ddm-form-panel .ddm-field input:not([type="checkbox"]),.ddm-form-panel .ddm-field select,.ddm-form-panel .ddm-field textarea{width:100%}
.ddm-form-panel .ddm-field .ddm-check input[type="checkbox"]{width:15px;height:15px;flex:none;margin:0;padding:0}
.ddm-form-actions-wrap{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.ddm-checks{display:flex;flex-direction:column;gap:6px}
.ddm-check{display:flex;align-items:center;gap:8px;font-size:12px}
.ddm-check input{width:15px;height:15px;flex:none;margin:0}
.ddm-check-always{color:var(--dsw-alias-label-secondary)}
/* A metric row stacks its name and its sampling hint, so the hint wraps under
   the label instead of stretching the row. The current value sits at the end and
   must not be squeezed by a long hint. */
.ddm-check-row{align-items:flex-start;gap:10px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ddm-check-row:last-child{border-bottom:none}
.ddm-check-row input{margin-top:2px}
.ddm-check-body{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.ddm-check-name{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
.ddm-check-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.ddm-check-value{font-size:11px;color:var(--dsw-alias-label-primary);white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
.ddm-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ddm-warn{border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:11px;line-height:1.5}
.ddm-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.ddm-custom-rows{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding:10px;border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.ddm-custom-rows > .ddm-field{gap:4px}
.ddm-grid-2 > .ddm-field{min-width:0}
.ddm-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px;margin:0;line-height:1.5}
.ddm-scroll{max-height:240px;overflow:auto}
.ddm-actions{display:flex;flex-wrap:wrap;gap:6px}
.ddm-btn-block{width:100%;justify-content:center}
.ddm-device-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.ddm-device-row:hover{background:var(--dsw-alias-bg-layer-2)}
.ddm-tag{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ddm-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ddm-incident{display:flex;align-items:center;gap:8px;font-size:11px;padding:3px 0}
.ddm-incident-offline{color:var(--dsw-alias-state-error-primary)}
.ddm-incident-online{color:var(--dsw-alias-state-success-primary)}
.ddm-incident-reboot{color:var(--dsw-alias-state-warn-primary)}
`;
		//#endregion

		//#region helpers
		/**
		 * The four waveforms drawn on a card.
		 *
		 * Mirrors `WAVE_COLUMNS` in `src/series.js`, duplicated because the client
		 * bundle is standalone and cannot import from the Host half. `key` is the
		 * series-row column, `metric` the config key that gates it.
		 */
		const WAVE_COLUMNS = [
			{ key: "cpu", metric: "cpu", ceiling: 100, unit: "%", stroke: "var(--dsw-alias-brand-primary)" },
			{ key: "mem", metric: "mem", ceiling: 100, unit: "%", stroke: "var(--dsw-alias-state-success-primary)" },
			{ key: "disk", metric: "disk", ceiling: 100, unit: "%", stroke: "var(--dsw-alias-state-warn-primary)" },
			{ key: "temp", metric: "temp", ceiling: null, unit: "°C", stroke: "var(--dsw-alias-state-error-primary)" },
		];
		/**
		 * Whether a metric already has its own waveform column.
		 *
		 * A metric that draws a chart should not ALSO draw a bar: its chart prints
		 * the same reading as a header, so the bar repeated the number in a second
		 * visual language and the card read as duplicated gauges.
		 */
		function hasWaveColumn(metric) {
			return WAVE_COLUMNS.some((column) => column.metric === metric);
		}
		/**
		 * The threshold keys, mirroring `THRESHOLD_KEYS` in `src/settings.js`.
		 *
		 * Duplicated for the same reason as {@link WAVE_COLUMNS}: the client
		 * bundle is standalone. These are also the alert `metric` names, which is
		 * what `alertText` switches on.
		 */
		const THRESHOLD_KEYS = ["cpu", "mem", "disk", "temp"];
		/**
		 * Clamp a value into 0..100.
		 *
		 * Named for bar widths historically; the only remaining caller is the
		 * disk table's red-text threshold, and clamping keeps that comparison
		 * safe against a malformed percentage.
		 */
		function pct(value) {
			const number = numOrNull(value);
			if (number === null) return 0;
			return Math.max(0, Math.min(100, number));
		}
		/** The status-dot class for a device row. */
		function dotTone(device) {
			if (device.error !== undefined && device.error !== null) return "ddm-dot ddm-dot-err";
			if ((device.alerts ?? []).length > 0) return "ddm-dot ddm-dot-warn";
			if (device.collectedAt === undefined) return "ddm-dot";
			return "ddm-dot ddm-dot-ok";
		}
		/** A local HH:MM:SS stamp. */
		function clockTime(ts) {
			if (typeof ts !== "number") return "—";
			const date = new Date(ts);
			return date.toLocaleTimeString(undefined, { hour12: false });
		}
		/** Render the localised message for one alert object. */
		function alertText(alert) {
			if (alert.metric === "cpu") return t("alert.cpu", { value: alert.rawValue ?? "" });
			if (alert.metric === "mem") return t("alert.mem", { value: alert.rawValue ?? "" });
			if (alert.metric === "disk") return t("alert.disk", { mount: alert.mount ?? "", value: alert.rawValue ?? "" });
			if (alert.metric === "temp") return t("alert.temp", { type: alert.type ?? "", value: alert.rawValue ?? "" });
			return alert.message ?? "";
		}
		/**
		 * A number, or null when the value is genuinely missing.
		 *
		 * `Number(null) === 0` and `Number("") === 0`, so the obvious
		 * `Number.isFinite(Number(x))` idiom would paint "never collected" as a
		 * real zero. That is why this mirror of the Host's `numOrNull` exists,
		 * and why the string form is deliberately never scanned for a bare
		 * `Number.isFinite(Number(...))` anywhere in this file.
		 */
		function numOrNull(value) {
			if (typeof value === "number") return Number.isFinite(value) ? value : null;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : null;
			}
			return null;
		}
		/**
		 * Shallow equality over two settings-shaped objects.
		 *
		 * The overview poll rebuilds `settings` on every tick, and the settings
		 * form re-seeds itself in an effect keyed on that object. Handing back a
		 * fresh object every 60 s would therefore wipe whatever the user was
		 * halfway through typing — the form would look like it "randomly
		 * reverts". Comparing first and keeping the previous reference when
		 * nothing changed is what makes the deps array meaningful.
		 */
		function sameSettings(a, b) {
			if (a === b) return true;
			if (a === null || a === undefined || b === null || b === undefined) return false;
			const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
			for (const key of keys) {
				if (!sameValue(a[key], b[key])) return false;
			}
			return true;
		}

		/**
		 * Structural equality over the JSON shapes a setting can take.
		 *
		 * This has to RECURSE, and the array case is why. `terminal.allowedHosts`
		 * is an array inside an object, and the Host serialises a fresh one on
		 * every poll: comparing it by reference made the settings object look
		 * changed on every refresh tick, which handed the form a new reference and
		 * re-seeded it — wiping a half-typed allowlist on a 60 s cycle.
		 */
		function sameValue(a, b) {
			if (a === b) return true;
			if (a === null || b === null || a === undefined || b === undefined) return false;
			if (typeof a !== "object" || typeof b !== "object") return false;
			if (Array.isArray(a) !== Array.isArray(b)) return false;
			const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
			for (const key of keys) {
				if (!sameValue(a[key], b[key])) return false;
			}
			return true;
		}
		/**
		 * Whether a metric column should be shown, as a THREE-state gate.
		 *
		 * `undefined`/`null` means "no choice recorded" — an upgraded device that
		 * predates the picker has no `metrics` field, and hiding everything would
		 * make its card look broken. `[]` is a real choice and means only the
		 * always-on keys remain, which is NOT the same as "unconfigured".
		 */
		function hasMetric(metrics, key) {
			if (key === "uptime") return true;
			if (!Array.isArray(metrics)) return true;
			return metrics.includes(key);
		}
		/** A compact byte count for log sizes. */
		function formatBytes(value) {
			const number = numOrNull(value);
			if (number === null || number <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let index = 0;
			let size = number;
			while (size >= 1024 && index < units.length - 1) {
				size /= 1024;
				index += 1;
			}
			return `${size < 10 && index > 0 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
		}
		/** One label-over-value pair in the side-by-side numeric strip. */
		function NumCell(key, label, value) {
			return h("div", { className: "ddm-num", key, "data-dsh-num": key },
				h("span", { className: "ddm-num-label" }, label),
				h("span", { className: "ddm-num-value", title: value }, value),
			);
		}
		/**
		 * The numeric cells for a card, in a fixed order.
		 *
		 * A metric is SKIPPED when it already appears elsewhere on the card — as a
		 * chart header — because printing the same reading twice in two visual
		 * languages is exactly the duplication this strip exists to avoid. What
		 * remains is "the other numeric information", which the user asked to see
		 * laid out side by side.
		 *
		 * `load` used to be excluded here and drawn as a bar instead. That bar is
		 * gone: its length was `load1 / cores`, and `cores` came from the CPU
		 * metric, so on any device with CPU switched off the divisor was a
		 * fabricated 1 and the bar ran up to four times too long. A bar that
		 * reports an idle box as busy is worse than no bar, so load is now an
		 * ordinary cell whose text carries the core count it is measured against.
		 *
		 * A metric with nothing collected renders `—`, never a fabricated `0`:
		 * "we did not ask" and "the device reported 0" stay different facts.
		 */
		const NUM_ORDER = [
			["uptime", "metric.uptime"],
			["load", "metric.load"],
			["cpu", "metric.cpu"],
			["mem", "metric.memory"],
			["disk", "metric.disk"],
			["temp", "metric.temp"],
			["procs", "metric.processes"],
			["tcp", "metric.tcp"],
			["top", "metric.top"],
			["net", "metric.net"],
			["diskio", "metric.diskio"],
		];
		function numericCells(sample, metrics) {
			const cells = [];
			for (const [key, labelKey] of NUM_ORDER) {
				if (!hasMetric(metrics, key)) continue;
				if (hasWaveColumn(key)) continue;
				cells.push(NumCell(key, t(labelKey), metricDetail(key, sample) ?? "—"));
			}
			return cells;
		}
		/** The worst disk usage across a sample. */
		function worstDisk(sample) {
			let worst = 0;
			for (const row of sample?.disk ?? []) worst = Math.max(worst, pct(row.usagePercent));
			return worst;
		}
		/** The hottest thermal reading across a sample. */
		function hottest(sample) {
			let best = null;
			for (const row of sample?.thermal ?? []) if (best === null || row.celsius > best.celsius) best = row;
			return best;
		}
		/**
		 * A short human-readable reading for one metric key, or null when there is
		 * nothing to show.
		 *
		 * This exists because a checkbox alone does not answer the question the
		 * user actually has when they open the edit form — "CPU 使用率" with a tick
		 * beside it says nothing about what is being sampled or what it currently
		 * reads. The catalog's `hint` explains the sampling; this explains the
		 * value. Together they turn a bare tick box into a sentence.
		 *
		 * Every branch returns null rather than a placeholder when the metric was
		 * not collected: `null` means "we never asked", and rendering "0" for that
		 * case is the one error this whole codebase is built to avoid.
		 */
		function metricDetail(key, sample) {
			if (sample === undefined || sample === null) return null;
			switch (key) {
				case "uptime":
					return sample.uptimeText ?? null;
				case "load": {
					const load = sample.load;
					if (load === undefined || load === null) return null;
					const one = numOrNull(load.load1);
					if (one === null) return null;
					const five = numOrNull(load.load5);
					const fifteen = numOrNull(load.load15);
					const averages = [one, five, fifteen].every((n) => n !== null)
						? `${one.toFixed(2)} / ${five.toFixed(2)} / ${fifteen.toFixed(2)}`
						: one.toFixed(2);
					// The core count is part of the READING, not a decoration: 1.0 is
					// saturation on one core and a quarter-load on four, so the three
					// averages alone do not say whether the box is busy. It is read
					// from the load collector's own tally first (which works with the
					// CPU metric switched off) and only then from the CPU metric.
					const cores = numOrNull(load.cores) ?? numOrNull(sample.cpu?.cores);
					return cores === null ? averages : `${averages} · ${t("card.cores", { count: cores })}`;
				}
				case "cpu": {
					const percent = numOrNull(sample.cpu?.percent);
					if (percent === null) return null;
					const cores = numOrNull(sample.cpu?.cores);
					return cores === null ? `${percent}%` : `${percent}% · ${t("card.cores", { count: cores })}`;
				}
				case "mem": {
					const memory = sample.memory;
					if (memory === undefined || memory === null) return null;
					const used = numOrNull(memory.usedMB);
					const total = numOrNull(memory.totalMB);
					const percent = numOrNull(memory.usagePercent);
					if (used === null || total === null) return percent === null ? null : `${percent}%`;
					return `${used} / ${total} MB（${percent === null ? "—" : `${percent}%`}）`;
				}
				case "disk": {
					// Name the mount point that is actually being alerted on, so the
					// number the user sees here matches the threshold they set.
					const worst = (sample.disk ?? []).reduce((best, row) => (best === null || row.usagePercent > best.usagePercent ? row : best), null);
					if (worst === null) return null;
					const percent = numOrNull(worst.usagePercent);
					return percent === null ? worst.mount ?? null : `${worst.mount ?? "—"} ${percent}%`;
				}
				case "temp": {
					const hot = hottest(sample);
					if (hot === null) return null;
					return `${hot.celsius}°C${hot.type === undefined ? "" : ` · ${hot.type}`}`;
				}
				case "procs": {
					const processes = numOrNull(sample.processes);
					return processes === null ? null : `${processes} 个`;
				}
				case "tcp": {
					const tcp = numOrNull(sample.tcp);
					return tcp === null ? null : `${tcp} 条`;
				}
				case "top": {
					const rows = Array.isArray(sample.top) ? sample.top : [];
					if (rows.length === 0) return null;
					const first = rows[0];
					return `${first.user ?? "?"} pid ${first.pid ?? "?"} ${first.cpu ?? "?"}%`;
				}
				case "net": {
					const net = sample.net;
					if (net === undefined || net === null) return null;
					const rx = numOrNull(net.rxTotal);
					const tx = numOrNull(net.txTotal);
					if (rx === null && tx === null) return null;
					return `↓${formatRate(rx)} ↑${formatRate(tx)}`;
				}
				case "diskio": {
					const dio = sample.diskio;
					if (dio === undefined || dio === null) return null;
					// `rateSince` names its two totals rxTotal/txTotal for BOTH callers
					// (net and disk stats) — it does not know which counter table it
					// was handed. `metrics.js:sampleColumn` maps the diskRead/diskWrite
					// SERIES columns onto the same two fields.
					const read = numOrNull(dio.rxTotal);
					const write = numOrNull(dio.txTotal);
					if (read === null && write === null) return null;
					return `读 ${formatRate(read)} 写 ${formatRate(write)}`;
				}
				default:
					return null;
			}
		}
		/**
		 * Bytes/second as a short human string.
		 *
		 * `rateSince` returns BYTES per second (it scales sectors by 512), so the
		 * divisor is 1024-based and the suffix is `B/s`, not `bit/s`.
		 */
		function formatRate(value) {
			const number = numOrNull(value);
			if (number === null) return "—";
			if (number >= 1024 * 1024) return `${(number / (1024 * 1024)).toFixed(1)} MB/s`;
			if (number >= 1024) return `${(number / 1024).toFixed(1)} KB/s`;
			return `${Math.round(number)} B/s`;
		}
		/** Format one wave column's latest value for its label. */
		function waveText(column, value) {
			const number = numOrNull(value);
			if (number === null) return "—";
			if (column.unit === "%") return `${Math.round(number)}%`;
			if (column.unit === "°C") return `${number.toFixed(1)}°C`;
			return number.toFixed(2);
		}
		/**
		 * An SVG sparkline over one numeric series.
		 *
		 * `values` may hold `null` for a sample that was never collected. Those
		 * entries advance the x axis but break the polyline, so a gap reads as a
		 * gap instead of a dive to zero.
		 *
		 * The y axis is scaled to the data's own range rather than to a fixed
		 * 0..100 for percentages. A fixed axis sounds more comparable but reads as
		 * broken: a healthy CPU (2%) and a steady disk (49%) both collapse onto a
		 * dead-flat line, while temperature — which had no ceiling and therefore
		 * did auto-scale — was the only chart that moved. Four charts drawn to two
		 * different rules, three of them flat, is what "波形显示混乱" describes.
		 *
		 * The padding is what keeps auto-scaling honest: a minimum band stops
		 * sensor jitter from being amplified into a mountain range, and the axis
		 * never clamps at zero unless the data is actually near zero. The band is
		 * published on the element so a caller (or a test) can read the scale
		 * rather than infer it from a squiggle.
		 */
		function waveScale(values, max, ceiling) {
			const finite = (Array.isArray(values) ? values : []).map((value) => numOrNull(value)).filter((value) => value !== null);
			if (finite.length < 2) return null;
			const hardTop = numOrNull(ceiling) ?? numOrNull(max);
			const dataMin = Math.min(...finite);
			const dataMax = Math.max(...finite);
			// A minimum band: 4% of the scale when there is a known ceiling, else
			// 4% of the largest reading. This is the floor that stops noise from
			// being magnified.
			const pad = Math.max((dataMax - dataMin) * 0.25, hardTop !== null ? hardTop * 0.04 : dataMax * 0.04, 1e-6);
			let lo = Math.max(0, dataMin - pad);
			let hi = dataMax + pad;
			if (hardTop !== null) hi = Math.min(hardTop, hi);
			// Re-assert the band after the clamps above can collapse it.
			if (hi - lo < pad) hi = lo + pad;
			return { lo, hi };
		}
		function axisText(column, value, span) {
			const number = numOrNull(value);
			if (number === null) return "";
			const digits = span < 1 ? 2 : span < 5 ? 1 : 0;
			const text = number.toFixed(digits);
			if (column.unit === "%") return `${text}%`;
			if (column.unit === "°C") return `${text}°`;
			return text;
		}
		function Sparkline({ values, max, stroke, ceiling, scale }) {
			const width = 240;
			const height = 56;
			if (!Array.isArray(values)) {
				return h("div", { className: "ddm-spark-empty" }, t("card.never"));
			}
			const computed = scale ?? waveScale(values, max, ceiling);
			if (computed === null) {
				return h("div", { className: "ddm-spark-empty" }, t("card.never"));
			}
			const { lo, hi } = computed;
			const step = width / Math.max(1, values.length - 1);
			const yOf = (value) => height - ((value - lo) / (hi - lo)) * height;
			// Split into runs of consecutive present samples; each run is one polyline.
			const runs = [];
			let run = [];
			values.forEach((raw, index) => {
				const value = numOrNull(raw);
				if (value === null) {
					if (run.length > 0) runs.push(run);
					run = [];
					return;
				}
				run.push(`${(index * step).toFixed(2)},${yOf(value).toFixed(2)}`);
			});
			if (run.length > 0) runs.push(run);
			return h("svg", {
				className: "ddm-spark",
				viewBox: `0 0 ${width} ${height}`,
				preserveAspectRatio: "none",
				"aria-hidden": "true",
				// The scale, published rather than inferred: a reader can tell a
				// genuinely quiet metric from a chart that failed to draw.
				"data-dsh-wave-lo": lo.toFixed(3),
				"data-dsh-wave-hi": hi.toFixed(3),
			},
				runs.map((points, index) => points.length < 2
					? h("circle", { key: index, cx: points[0].split(",")[0], cy: points[0].split(",")[1], r: "1.5", fill: stroke ?? "var(--dsw-alias-brand-primary)" })
					: h("polyline", { key: index, points: points.join(" "), fill: "none", stroke: stroke ?? "var(--dsw-alias-brand-primary)", strokeWidth: "1.5", vectorEffect: "non-scaling-stroke" }),
				),
			);
		}
		/**
		 * The current reading for each waveform column.
		 *
		 * The chart header prints the LIVE reading, so it must come from the freshest
		 * sample rather than from the last history row. They are usually the same
		 * thing, but not always: a device can have a sample and no series yet (a
		 * first poll, or a card rendered before the series fetch lands), and reading
		 * the series alone would print `—` beside a chart while a perfectly good
		 * reading sat right there in the sample. Series values fill in only where the
		 * sample has nothing to say.
		 */
		function waveLatest(sample, lastRow) {
			const fromSample = {
				cpu: numOrNull(sample?.cpu?.percent),
				mem: numOrNull(sample?.memory?.usagePercent),
				disk: worstDisk(sample),
				temp: (() => {
					const hot = hottest(sample);
					return hot === null ? null : numOrNull(hot.celsius);
				})(),
			};
			const merged = {};
			for (const column of WAVE_COLUMNS) {
				merged[column.key] = fromSample[column.key] ?? numOrNull(lastRow?.[column.key]);
			}
			return merged;
		}
		/**
		 * The four mini waveforms shown on every card and in the detail view.
		 *
		 * Each column is independently gated by the metric config, so an
		 * unselected metric renders neither a chart nor a host round-trip.
		 */
		function WaveRow({ series, latest, sample, metrics }) {
			const columns = WAVE_COLUMNS.filter((column) => hasMetric(metrics, column.metric));
			if (columns.length === 0) return h("div", { className: "ddm-hint" }, t("panel.metricsNote"));
			const rows = Array.isArray(series) ? series : [];
			const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
			const readings = waveLatest(sample, latest ?? lastRow);
			return h("div", { className: "ddm-waves" }, columns.map((column) => {
				const values = rows.map((row) => row?.[column.key]);
				// One scale, computed once and handed to BOTH the line and its
				// labels. Recomputing it inside the axis would let the printed
				// numbers drift from the geometry they claim to describe — the
				// exact failure this whole chart exists to stop.
				const scale = waveScale(values, undefined, column.ceiling);
				return h("div", { className: "ddm-wave", key: column.key, "data-dsh-metric": column.metric },
					h("div", { className: "ddm-wave-label" },
						h("span", null, t(`wave.${column.key}`)),
						h("span", { className: "ddm-wave-value" }, waveText(column, readings[column.key])),
					),
					h("div", { className: "ddm-wave-plot" },
						scale === null ? null : h("div", {
							className: "ddm-axis ddm-axis-y",
							"data-dsh-axis": "y",
							"data-dsh-axis-lo": scale.lo.toFixed(3),
							"data-dsh-axis-hi": scale.hi.toFixed(3),
						},
							h("span", null, axisText(column, scale.hi, scale.hi - scale.lo)),
							h("span", null, axisText(column, scale.lo, scale.hi - scale.lo)),
						),
						h(Sparkline, { values, ceiling: column.ceiling, stroke: column.stroke, scale }),
						scale === null ? null : h("div", { className: "ddm-axis ddm-axis-x", "data-dsh-axis": "x" },
							h("span", null, clockTime(rows.length > 0 ? rows[0]?.ts : undefined)),
							h("span", null, clockTime(rows.length > 0 ? rows[rows.length - 1]?.ts : undefined)),
						),
					),
				);
			}));
		}
		//#endregion

		//#region form
		/** The empty add/edit form state. */
		function blankForm() {
			return { name: "", host: "", port: "22", username: "", authKind: "password", password: "", privateKeyPath: "", description: "", location: "", tags: "", intervalSec: "", metrics: null };
		}
		/** Seed the form from a stored device summary. */
		function formFromDevice(device) {
			return {
				name: device.name ?? "",
				host: device.host ?? "",
				port: String(device.port ?? 22),
				username: device.username ?? "",
				authKind: device.authKind ?? "password",
				password: "",
				privateKeyPath: "",
				description: device.description ?? "",
				location: device.location ?? "",
				tags: (device.tags ?? []).join(", "),
				intervalSec: device.intervalSec === undefined || device.intervalSec === null ? "" : String(device.intervalSec),
				// No recorded choice stays `null` in the form, so saving an edit
				// never silently narrows an upgraded device to a subset.
				metrics: Array.isArray(device.metrics) ? [...device.metrics] : null,
			};
		}
		/** Turn form state into the API payload. */
		function formPayload(form) {
			const auth = { kind: form.authKind };
			if (form.authKind === "password" && form.password !== "") auth.password = form.password;
			if (form.authKind === "key" && form.privateKeyPath.trim() !== "") auth.privateKeyPath = form.privateKeyPath.trim();
			const payload = {
				name: form.name.trim(),
				host: form.host.trim(),
				port: Number(form.port) || 22,
				username: form.username.trim(),
				auth,
				description: form.description.trim(),
				location: form.location.trim(),
				tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
			};
			// An empty interval box means "follow the global setting", which the
			// Host expresses as an explicit undefined rather than 0.
			const interval = numOrNull(form.intervalSec);
			if (interval === null) payload.intervalSec = undefined;
			else payload.intervalSec = Math.max(5, Math.min(3600, Math.round(interval)));
			if (Array.isArray(form.metrics)) payload.metrics = [...form.metrics];
			return payload;
		}
		/** One labelled text/select field. */
		function Field({ label, children }) {
			return h("div", { className: "ddm-field" }, h("label", null, label), children);
		}
		/**
		 * The add/edit form.
		 *
		 * Rendered directly in the column rather than in a modal overlay: the
		 * right sidebar is too narrow for a centred dialog, and the requirement is
		 * that adding a device works while the conversation stays visible.
		 */
		function DeviceForm({ device, busy, error, onCancel, onSubmit }) {
			const [form, setForm] = React.useState(() => (device === undefined ? blankForm() : formFromDevice(device)));
			const [testResult, setTestResult] = React.useState(undefined);
			const [testing, setTesting] = React.useState(false);
			const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
			const catalog = store.snapshot.catalog;
			const submit = (event) => {
				event.preventDefault();
				if (form.name.trim() === "" || form.host.trim() === "" || form.username.trim() === "") {
					onSubmit(null);
					return;
				}
				onSubmit(formPayload(form));
			};
			/** Try the credentials typed in the form without saving anything. */
			const testDraft = async () => {
				setTesting(true);
				setTestResult(undefined);
				try {
					// The probe carries the device id so the Host can resolve an
					// omitted password exactly the way SAVING would: `Store#update`
					// merges `{...current.auth, ...fields.auth}` by id, so a blank
					// password box keeps the stored one. Without the id the Host
					// would have to guess from host/username, and a blank box would
					// dial with an empty password instead of the saved one. The id is
					// added HERE rather than in `formPayload`, which stays the exact
					// save payload.
					const body = await api.testDraft({ ...formPayload(form), id: device?.id });
					const result = body?.result;
					setTestResult(result?.ok === true ? t("form.testOk", { ms: result.latencyMs ?? 0 }) : t("form.testFail", { error: result?.error ?? "unknown" }));
				} catch (error) {
					setTestResult(t("form.testFail", { error: error instanceof Error ? error.message : String(error) }));
				} finally {
					setTesting(false);
				}
			};
			const toggleMetric = (key) => () => setForm((current) => {
				const base = Array.isArray(current.metrics) ? current.metrics : catalog.map((row) => row.key);
				const next = base.includes(key) ? base.filter((row) => row !== key) : [...base, key];
				return { ...current, metrics: next };
			});
			const selectedMetrics = Array.isArray(form.metrics) ? form.metrics : catalog.map((row) => row.key);
			// A checkbox with only a name beside it cannot answer "what does this
			// actually read, and what will be sampled". Each row therefore carries
			// the catalog's sampling hint AND, for an existing device, the last
			// collected value. A brand-new device has no sample, so the value is
			// omitted rather than faked as 0.
			const sample = device?.sample;
			const metricRow = (row, checked, disabled, onToggle) => {
				const detail = checked ? metricDetail(row.key, sample) : null;
				return h("label", { className: "ddm-check ddm-check-row", key: row.key },
					h("input", { type: "checkbox", checked, disabled, onChange: onToggle, "data-dsh-metric-key": row.key }),
					h("span", { className: "ddm-check-body" },
						h("span", { className: "ddm-check-name" },
							row.label,
							row.always === true ? h("span", { className: "ddm-check-always" }, t("settings.metricsAlways")) : null,
						),
						row.hint === undefined || row.hint === "" ? null : h("span", { className: "ddm-check-hint" }, row.hint),
					),
					detail === null ? null : h("span", { className: "ddm-check-value", "data-dsh-metric-value": row.key }, detail),
				);
			};
			return h("form", { className: "ddm-form-panel", onSubmit: submit, "data-dsh-device-form": "" },
				h("div", { className: "ddm-section-title" }, device === undefined ? t("form.addTitle") : t("form.editTitle")),
				error === undefined ? null : h("div", { className: "ddm-error" }, error),
				h(Field, { label: t("form.name") }, h("input", { value: form.name, onChange: set("name"), placeholder: t("form.namePlaceholder"), autoFocus: true })),
				h("div", { className: "ddm-grid-2" },
					h(Field, { label: t("form.host") }, h("input", { value: form.host, onChange: set("host"), placeholder: t("form.hostPlaceholder") })),
					h(Field, { label: t("form.port") }, h("input", { value: form.port, onChange: set("port"), inputMode: "numeric" })),
				),
				h(Field, { label: t("form.username") }, h("input", { value: form.username, onChange: set("username"), placeholder: "root" })),
				h(Field, { label: t("form.auth") },
					h("select", { value: form.authKind, onChange: set("authKind") },
						h("option", { value: "password" }, t("form.authPassword")),
						h("option", { value: "key" }, t("form.authKey")),
						h("option", { value: "agent" }, t("form.authAgent")),
					),
				),
				form.authKind === "password"
					? h(Field, { label: t("form.password") },
						h("input", { type: "password", value: form.password, onChange: set("password"), placeholder: device !== undefined && device.hasPassword ? "••••••" : "" }),
						device !== undefined ? h("div", { className: "ddm-hint" }, t("form.keepSecret")) : null,
					)
					: null,
				form.authKind === "key"
					? h(Field, { label: t("form.privateKeyPath") },
						h("input", { value: form.privateKeyPath, onChange: set("privateKeyPath"), placeholder: t("form.privateKeyPlaceholder") }),
						device !== undefined ? h("div", { className: "ddm-hint" }, t("form.keepSecret")) : null,
					)
					: null,
				h("div", { className: "ddm-grid-2" },
					h(Field, { label: t("form.location") }, h("input", { value: form.location, onChange: set("location") })),
					h(Field, { label: t("form.tags") }, h("input", { value: form.tags, onChange: set("tags") })),
				),
				h(Field, { label: t("form.description") }, h("textarea", { value: form.description, onChange: set("description") })),
				h(Field, { label: t("settings.deviceInterval") }, h("input", { value: form.intervalSec, onChange: set("intervalSec"), inputMode: "numeric" })),
				h("div", { className: "ddm-field" },
					h("label", null, t("settings.metrics")),
					h("div", { className: "ddm-checks" }, catalog.map((row) =>
						metricRow(row, row.always === true || selectedMetrics.includes(row.key), row.always === true, toggleMetric(row.key)),
					)),
					h("div", { className: "ddm-hint" }, t("settings.metricsHint")),
				),
				h("div", { className: "ddm-form-actions-wrap" },
					h("button", { type: "button", className: "ddm-btn", onClick: onCancel, disabled: busy }, t("form.cancel")),
					h("button", { type: "button", className: "ddm-btn", onClick: () => void testDraft(), disabled: testing }, testing ? t("form.testing") : t("form.testDraft")),
					h("button", { type: "submit", className: "ddm-btn ddm-btn-primary", disabled: busy }, busy ? t("form.saving") : t("form.save")),
				),
				testResult === undefined ? null : h("div", { className: "ddm-hint" }, testResult),
				h("div", { className: "ddm-hint" }, t("form.testDraftHint")),
			);
		}
		//#endregion

		//#region store
		/**
		 * One subscription hook, tolerant of a React without `useSyncExternalStore`.
		 *
		 * DSH ships React 18.3.1 so the real hook is always present; the fallback
		 * exists for the smoke harness, which stubs a minimal React.
		 */
		const useStore = typeof React.useSyncExternalStore === "function"
			? (subscribe, getSnapshot) => React.useSyncExternalStore(subscribe, getSnapshot)
			: (subscribe, getSnapshot) => {
				const [value, setValue] = React.useState(getSnapshot);
				React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot]);
				return value;
			};

		/**
		 * The single shared view state for the device panel.
		 *
		 * Deliberately MODULE level, not component state: the panel is mounted in
		 * the left sidebar, the main slot and the better-sidebar right column at
		 * once. Per-component state would mean three pollers dialling the same
		 * ten devices, three leases, and edits visible in only one seat.
		 */
		const store = {
			listeners: new Set(),
			snapshot: {
				rev: 0,
				status: "loading",
				error: undefined,
				devices: [],
				maxDevices: 10,
				settings: null,
				catalog: [],
				view: "list",
				selected: null,
				editing: null,
				formError: undefined,
				busyIds: [],
				busyForm: false,
				notice: undefined,
				lastLoaded: 0,
				seriesById: {},
				watch: null,
				visibleOwners: {},
				// The debug terminal lives in the shared store rather than in
				// component state for the same reason the roster does: two seats
				// are mounted at once, and a per-component socket would give each
				// its own shell on the same device while hiding the other's output.
				terminal: emptyTerminal(),
			},
			loadTimer: null,
			heartbeatTimer: null,
			heartbeatsSent: 0,
		};

		/** Publish a partial state change to every subscriber. */
		function publish(patch) {
			store.snapshot = { ...store.snapshot, ...patch, rev: store.snapshot.rev + 1 };
			for (const listener of Array.from(store.listeners)) {
				try {
					listener();
				} catch (error) {
					console.warn("[dsh-device-monitor] store listener failed:", error);
				}
			}
		}

		/** Subscribe to shared state; returns the unsubscribe function. */
		function subscribe(listener) {
			store.listeners.add(listener);
			return () => store.listeners.delete(listener);
		}

		/** The current immutable state object, stable between changes. */
		function getSnapshot() {
			return store.snapshot;
		}

		/**
		 * Record whether one mounted seat can currently be seen.
		 *
		 * ANY visible seat keeps the lease alive; the lease lapses only once the
		 * last one hides, which is what stops the Host from dialling devices for
		 * a panel nobody is looking at.
		 */
		function setSeatVisible(owner, visible) {
			const owners = { ...store.snapshot.visibleOwners };
			if (visible) owners[owner] = true;
			else delete owners[owner];
			publish({ visibleOwners: owners });
			syncTimers();
		}

		/** Drop a seat that unmounted so it can never pin the lease open. */
		function dropSeat(owner) {
			if (store.snapshot.visibleOwners[owner] === undefined) return;
			setSeatVisible(owner, false);
		}

		/** Whether at least one seat is on screen right now. */
		function anyVisible() {
			return Object.keys(store.snapshot.visibleOwners).length > 0;
		}

		/** The refresh cadence in seconds, from settings unless overridden. */
		function currentIntervalSec() {
			const settings = store.snapshot.settings;
			const value = numOrNull(settings?.refreshIntervalSec);
			if (value === null) return 60;
			return Math.max(5, Math.min(3600, Math.round(value)));
		}

		/** Load the roster and its latest samples. */
		async function loadOverview() {
			try {
				const body = await api.overview();
				// Keep the previous settings object when nothing changed: the form
				// re-seeds on this reference, so a fresh-but-identical object every
				// tick would clobber an in-progress edit.
				const merged = body.settings === undefined
					? store.snapshot.settings
					: { ...(store.snapshot.settings ?? {}), ...body.settings };
				publish({
					status: "ready",
					error: undefined,
					devices: Array.isArray(body.devices) ? body.devices : [],
					maxDevices: numOrNull(body.maxDevices) ?? 10,
					settings: sameSettings(merged, store.snapshot.settings) ? store.snapshot.settings : merged,
					watch: body.watch ?? null,
					lastLoaded: Date.now(),
				});
			} catch (error) {
				publish({ status: "error", error: error instanceof Error ? error.message : String(error) });
			}
		}

		/**
		 * Load one series per device for the card waveforms.
		 *
		 * Ten devices means ten requests; they are issued together so the total
		 * wall time is one round trip rather than ten, and a single failure only
		 * blanks that device's chart.
		 */
		async function loadSeries(limit = 60) {
			const devices = store.snapshot.devices;
			const targets = devices.filter((device) => device.sample !== undefined && device.sample !== null);
			if (targets.length === 0) return;
			const results = await Promise.all(targets.map(async (device) => {
				try {
					const body = await api.metrics(device.id, limit);
					return [device.id, { status: "ready", series: Array.isArray(body.series) ? body.series : [] }];
				} catch (error) {
					return [device.id, { status: "error", series: [], error: error instanceof Error ? error.message : String(error) }];
				}
			}));
			const next = { ...store.snapshot.seriesById };
			for (const [id, value] of results) next[id] = value;
			publish({ seriesById: next });
		}

		/** The full visible-panel refresh: roster, then waveforms. */
		async function refreshAll() {
			await loadOverview();
			await loadSeries(60);
		}

		/**
		 * Load global settings and the metric catalog once.
		 *
		 * Re-syncs the timers afterwards: `setSeatVisible` takes the lease as
		 * soon as the panel mounts, which is BEFORE this resolves, so without
		 * this call the lease would keep the 60 s fallback forever and a
		 * configured cadence would never reach the Host.
		 */
		async function loadSettings() {
			try {
				const body = await api.settings();
				const next = body.settings ?? null;
				publish({
					// Same reasoning as loadOverview: an identical payload must not
					// hand the form a new reference and reset it.
					settings: sameSettings(next, store.snapshot.settings) ? store.snapshot.settings : next,
					catalog: Array.isArray(body.catalog) ? body.catalog : store.snapshot.catalog,
				});
				// Only rebuild when a seat is on screen; otherwise this would
				// re-take a lease that was deliberately released.
				if (anyVisible()) syncTimers();
			} catch (error) {
				publish({ notice: t("settings.loadFailed", { error: error instanceof Error ? error.message : String(error) }) });
			}
		}

		/** Refresh whatever the current view needs. */
		async function refreshView() {
			const view = store.snapshot.view;
			if (view === "settings") {
				await Promise.all([loadOverview(), loadSettings()]);
				return;
			}
			await refreshAll();
		}

		/**
		 * Rebuild the heartbeat, the refresh timer and the lease.
		 *
		 * Called on every visibility or interval change. When the last seat hides
		 * the lease is released outright rather than left to expire, so the Host
		 * stops dialling immediately instead of one interval later.
		 */
		function syncTimers() {
			const visible = anyVisible();
			const intervalSec = currentIntervalSec();
			const intervalMs = intervalSec * 1000;
			if (store.loadTimer !== null) {
				window.clearInterval(store.loadTimer);
				store.loadTimer = null;
			}
			if (store.heartbeatTimer !== null) {
				window.clearInterval(store.heartbeatTimer);
				store.heartbeatTimer = null;
			}
			if (!visible) {
				// Stop advertising; the Host reaps the lease on its own clock.
				void api.unwatch(CLIENT_ID).catch(() => {});
				return;
			}
			void api.watch(CLIENT_ID, intervalSec).then((body) => publish({ watch: body?.watch ?? null })).catch(() => {});
			store.heartbeatTimer = window.setInterval(() => {
				void api.watch(CLIENT_ID, currentIntervalSec()).then((body) => publish({ watch: body?.watch ?? null })).catch(() => {});
			}, intervalMs);
			store.loadTimer = window.setInterval(() => {
				void refreshView();
			}, intervalMs);
		}

		/** Mark one device busy while an async action runs. */
		async function withBusy(id, work) {
			publish({ busyIds: [...store.snapshot.busyIds, id] });
			try {
				return await work();
			} finally {
				publish({ busyIds: store.snapshot.busyIds.filter((row) => row !== id) });
			}
		}

		/** Collect one device now, then refresh the view. */
		async function collectOne(id) {
			const result = await withBusy(id, () => api.collect(id));
			await refreshAll();
			const outcome = result?.results?.[0];
			publish({ notice: outcome !== undefined && outcome.ok !== true ? String(outcome.error) : undefined });
		}

		/** Collect every device now. */
		async function collectEverything() {
			publish({ notice: undefined });
			await api.collect(undefined);
			await refreshAll();
		}

		/** Test one saved device's connection. */
		async function testOne(id) {
			const result = await withBusy(id, () => api.test(id));
			const outcome = result?.result;
			publish({ notice: outcome?.ok === true ? t("test.ok", { ms: outcome.latencyMs ?? 0 }) : t("test.fail", { error: outcome?.error ?? "unknown" }) });
		}

		/** Delete one device after confirmation. */
		async function removeDevice(id, name) {
			if (!window.confirm(t("confirm.delete", { name }))) return;
			await api.remove(id);
			if (store.snapshot.selected === id) publish({ selected: null, view: "list" });
			await refreshAll();
		}

		/** Switch the shared view. */
		function showView(view, selected = store.snapshot.selected) {
			publish({ view, selected, editing: null, formError: undefined });
		}

		/** Create or update a device from the form payload. */
		async function submitForm(payload) {
			if (payload === null) {
				publish({ formError: t("form.required") });
				return;
			}
			const editing = store.snapshot.editing;
			publish({ busyForm: true, formError: undefined });
			try {
				if (editing === undefined || editing === null) await api.create(payload);
				else await api.update(editing, payload);
				publish({ editing: null, view: "list" });
				await refreshAll();
			} catch (error) {
				publish({ formError: error instanceof Error ? error.message : String(error) });
			} finally {
				publish({ busyForm: false });
			}
		}

		/** Save a settings patch, then re-read the roster to pick up new metrics. */
		async function saveSettings(patch) {
			try {
				const body = await api.saveSettings(patch);
				publish({
					settings: body.settings ?? store.snapshot.settings,
					catalog: Array.isArray(body.catalog) ? body.catalog : store.snapshot.catalog,
					notice: t("settings.saved"),
				});
				await refreshAll();
			} catch (error) {
				publish({ notice: t("settings.loadFailed", { error: error instanceof Error ? error.message : String(error) }) });
			}
		}
		//#endregion

		//#region terminal
		/**
		 * The debug terminal.
		 *
		 * Deliberately NOT a terminal emulator. The reference system reached the
		 * same conclusion and shipped a line-oriented input box plus a `<pre>`
		 * output pane, and there is a hard reason to follow it: a real emulator
		 * needs an xterm-class renderer. DSH's own built-in terminal loads one
		 * through `require.async`, which is a private loader a plugin's client
		 * bundle cannot reach, so hand-rolling ANSI handling here would produce a
		 * half-finished emulator that renders `vim` as garbage — worse than
		 * saying plainly that full-screen programs are out of scope.
		 *
		 * The connection is a MODULE-LEVEL singleton, not component state. Two
		 * seats can be mounted at once (the main slot and the right-column tab),
		 * and a per-component socket would give each its own shell on the same
		 * device while each hid the other's output.
		 */

		/**
		 * How long the whole handshake may take, including the Host's SSH dial.
		 *
		 * A browser WebSocket can sit in CONNECTING forever: `onopen`, `onerror`
		 * and `onclose` all stay silent, and the panel is left showing "正在连接"
		 * while every keystroke is refused. Without this timer that failure is
		 * completely silent — only a page reload recovers from it.
		 */
		const TERM_CONNECT_TIMEOUT_MS = 8_000;

		/** Output is appended as spans; the buffer is capped so a chatty command
		 *  cannot grow the store without bound. */
		const TERM_MAX_LINES = 400;

		/**
		 * Control sequences this pane cannot draw, in the order they must be
		 * consumed.
		 *
		 * The first version stripped ONLY the bracketed-paste toggles, on the
		 * theory that also dropping colour and cursor moves would "mangle the
		 * output into something that looks like output but is not". That was
		 * backwards. This `<pre>` renders no ANSI whatsoever, so a sequence left
		 * in place does not preserve meaning — it is printed as literal text,
		 * and the user reads `[0m[01;34m` in front of every directory name and
		 * `[?1l>[58;1H` after every prompt. The honest behaviour is to remove
		 * what the pane cannot draw and keep every byte of the actual text.
		 *
		 * Order matters: an OSC payload may itself contain `ESC [`, so the OSC
		 * form has to be consumed first or the CSI rule would match inside it
		 * and leave the tail behind.
		 */
		/** OSC — `ESC ] … BEL` or `ESC ] … ST` (window title, hyperlinks). */
		const TERM_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
		/** CSI — `ESC [ params intermediates final`. Covers SGR colour, cursor
		 *  addressing (`[58;1H`), erase-in-line (`[K`), and the bracketed-paste
		 *  / cursor-visibility private modes (`[?2004h`, `[?25h`). */
		const TERM_CSI = /\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]/g;
		/** Two-character escapes — `ESC >` (keypad), `ESC =`, `ESC 7` / `ESC 8`,
		 *  `ESC M D E H N O Z`, and a bare string terminator. `[` and `]` are
		 *  deliberately absent so they cannot pre-empt the rules above. */
		const TERM_ESC = /\x1b[0-9<=>A-Za-z\\]/g;
		/** Whatever C0 control is left, plus DEL — but NOT `\x08` (backspace) and
		 *  not CR/LF, which the rules below handle by name. */
		const TERM_C0 = /[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]/g;

		/** The tail of an escape sequence that was cut in half by a frame
		 *  boundary. Prepended to the next chunk so the two halves are stripped
		 *  together instead of leaking `ESC` as a visible glyph. */
		let termPending = "";

		/**
		 * The control-key bar.
		 *
		 * Each entry sends ONE control byte, which is a different act from typing
		 * a line and pressing Enter. ⌃C leads because its only purpose is
		 * interrupting a command that is already running — and with a
		 * line-oriented input box, typing into the box cannot do that.
		 */
		const TERM_KEYS = [
			{ byte: "\u0003", label: "⌃C", title: "中断当前前台进程（SIGINT）" },
			{ byte: "\u0004", label: "⌃D", title: "EOF / 退出登录" },
			{ byte: "\u001a", label: "⌃Z", title: "挂起到后台（SIGTSTP）" },
			{ byte: "\u000c", label: "⌃L", title: "清屏" },
			{ separator: true },
			{ byte: "\u0001", label: "⌃A", title: "移到行首" },
			{ byte: "\u0005", label: "⌃E", title: "移到行尾" },
			{ byte: "\u0015", label: "⌃U", title: "清空当前输入行" },
			{ byte: "\u0017", label: "⌃W", title: "删除前一个词" },
			{ separator: true },
			{ byte: "\u0009", label: "⇥", title: "补全（与 shell 的读行编辑配合）" },
			{ byte: "\u001b", label: "⎋", title: "Esc：退出模式 / 关闭菜单" },
		];

		/**
		 * Decode one base64 output frame into text.
		 *
		 * The Host deliberately sends base64 rather than a JSON string: a PTY
		 * emits arbitrary bytes, and decoding them as UTF-8 on the Host would
		 * replace every invalid sequence with U+FFFD before it ever reached the
		 * browser. `fatal:false` here does the same substitution, but only for
		 * bytes that are genuinely undecodable, and it happens after the
		 * transmission is already lossless.
		 */
		function b64ToText(b64) {
			try {
				const binary = atob(b64);
				const bytes = new Uint8Array(binary.length);
				for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
				return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			} catch {
				return "";
			}
		}

		/** Encode text for the wire. The Host decodes it back to a UTF-8 string. */
		function textToB64(text) {
			const bytes = new TextEncoder().encode(text);
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return btoa(binary);
		}

		/** The live connection. Exactly one at a time, by design. */
		const terminal = {
			socket: null,
			deviceId: null,
			sessionId: null,
			/** Which seat is showing the overlay, so exactly one renders it. */
			owner: null,
			connectTimer: null,
			/** User asked to close: a later `onclose` must not report a fault. */
			closing: false,
			/** The Host already explained the refusal; `onclose` must not repeat it. */
			rejected: false,
			/** The timeout already spoke; `onclose` must not pile on. */
			timedOut: false,
			fullscreen: false,
		};

		/** The empty terminal view, so a closed panel renders nothing odd. */
		function emptyTerminal() {
			return { open: false, owner: null, deviceId: null, title: "", host: "", status: "idle", lines: [], fullscreen: false };
		}

		/** Append one chunk to the visible buffer, capped. */
		function termWrite(text, kind) {
			if (text === "") return;
			const before = store.snapshot.terminal ?? emptyTerminal();
			const lines = [...before.lines, { text, kind: kind ?? "" }];
			const trimmed = lines.length > TERM_MAX_LINES ? lines.slice(lines.length - TERM_MAX_LINES) : lines;
			publish({ terminal: { ...before, lines: trimmed } });
		}

		/** Patch the terminal slice of the store without touching the buffer. */
		function termPatch(patch) {
			const before = store.snapshot.terminal ?? emptyTerminal();
			publish({ terminal: { ...before, ...patch } });
		}

		function termClearConnectTimer() {
			if (terminal.connectTimer !== null) {
				window.clearTimeout(terminal.connectTimer);
				terminal.connectTimer = null;
			}
		}

		/**
		 * Open a terminal on one device, owned by the seat that asked for it.
		 *
		 * `owner` is recorded rather than assumed: the overlay is pinned to the
		 * bottom-right of whichever pane mounts it, so if BOTH mounted seats
		 * rendered it the two copies would land on top of each other and each
		 * would append every output chunk to its own buffer.
		 */
		function openTerminal(deviceId, owner) {
			if (terminal.socket !== null) {
				publish({ notice: t("term.onlyOne") });
				return;
			}
			// The Host is the real gate — it refuses a `open` frame outright when
			// the terminal is off. Checking here too is not security (the socket
			// is public), it is so the user gets a sentence pointing at the
			// setting instead of watching a socket open and immediately close.
			if (store.snapshot.settings?.terminal?.enabled !== true) {
				publish({ notice: t("term.disabled") });
				return;
			}
			const device = store.snapshot.devices.find((row) => row.id === deviceId);
			terminal.deviceId = deviceId;
			terminal.owner = owner ?? null;
			terminal.closing = false;
			terminal.rejected = false;
			terminal.timedOut = false;
			terminal.sessionId = null;
			terminal.fullscreen = false;
			// A half-received escape sequence belongs to the session that was
			// just closed; carrying it into the next one would print it there.
			termPending = "";
			const title = device === undefined ? deviceId : device.name;
			const host = device === undefined ? "" : device.host;
			publish({
				notice: undefined,
				terminal: {
					open: true,
					owner: terminal.owner,
					deviceId,
					title,
					host,
					status: "connecting",
					lines: [{ text: `${t("term.connecting", { host })}\n`, kind: "ddm-term-sys" }],
					fullscreen: false,
				},
			});
			// The Host is NOT at `window.location`.
			//
			// The desktop shell loads this page from the custom scheme
			// `dsh-app://app/`, so `location.host` is the literal string `app` and
			// `location.origin` is `null`. Building the socket from it produced
			// `ws://app/api/dsh-device-monitor/terminal` — an authority-less URL
			// the renderer refuses before a single byte leaves the process. That
			// was m07341: the server saw nothing, so the terminal said "cannot
			// connect" with no audit row anywhere, and no amount of server-side
			// probing could reproduce it.
			//
			// `__DSH_TRANSPORT__.streamBaseUrl` is the renderer's one published
			// way to learn the real Host origin (the shell resolves it from the
			// desktop boot handshake). DSH's own gateway builds its WebSocket the
			// same way, against `document.baseURI` as the fallback — which is
			// right for this plugin too, because in a plain browser tab the page
			// IS served by the Host and the two agree. `https:` still maps to
			// `wss:`: a mixed-content upgrade is blocked, and that failure is
			// indistinguishable from an unreachable Host.
			const url = (() => {
				const transport = window.__DSH_TRANSPORT__;
				const published = typeof transport?.streamBaseUrl === "string" && transport.streamBaseUrl !== "" ? transport.streamBaseUrl : "";
				const base = published !== "" ? published : document?.baseURI ?? "";
				try {
					const resolved = new URL(API.terminalSocket.slice(1), base === "" ? undefined : base);
					resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
					return resolved.href;
				} catch {
					// No usable base at all. Fall back to the old same-origin shape
					// rather than throwing: a wrong-but-syntactic URL still reports
					// a connection failure, while a throw here would bypass the
					// `term.failed` sentence the user needs.
					const scheme = window.location?.protocol === "https:" ? "wss" : "ws";
					return `${scheme}://${window.location?.host ?? ""}${API.terminalSocket}`;
				}
			})();
			let socket;
			try {
				socket = new window.WebSocket(url);
			} catch (error) {
				termPatch({ status: "closed" });
				termWrite(`${t("term.createFailed", { error: error instanceof Error ? error.message : String(error) })}\n`, "ddm-term-err");
				terminal.owner = null;
				return;
			}
			terminal.socket = socket;
			// The timeout covers the ENTIRE setup, not just the handshake: the
			// handshake can succeed and the Host still never answer `ready` while
			// the remote SSH dial hangs, which leaves the same silent "connecting".
			termClearConnectTimer();
			terminal.connectTimer = window.setTimeout(() => {
				terminal.connectTimer = null;
				if (terminal.socket !== socket) return;
				const state = socket.readyState;
				if (state !== 0 && state !== 1) return;
				terminal.timedOut = true;
				termPatch({ status: "closed" });
				termWrite(state === 0
					? `\n${t("term.timeout", { sec: TERM_CONNECT_TIMEOUT_MS / 1000 })}\n`
					: `\n${t("term.timeoutSession", { sec: TERM_CONNECT_TIMEOUT_MS / 1000 })}\n`, "ddm-term-err");
				try {
					socket.close();
				} catch {
					// ignore
				}
				if (terminal.socket === socket) terminal.socket = null;
			}, TERM_CONNECT_TIMEOUT_MS);

			socket.onopen = () => {
				// The timer is NOT cleared here — see above.
				try {
					socket.send(JSON.stringify({ t: "open", deviceId, cols: termCols(), rows: termRows(), by: "web" }));
				} catch (error) {
					termClearConnectTimer();
					termWrite(`\n${t("term.sendFailed", { error: error instanceof Error ? error.message : String(error) })}\n`, "ddm-term-err");
				}
			};
			socket.onmessage = (event) => {
				let frame;
				try {
					frame = JSON.parse(event.data);
				} catch {
					return;
				}
				termReceive(frame);
			};
			socket.onerror = () => {
				// The timer is deliberately left armed. The spec promises an
				// `onclose` after `onerror`, but the whole reason this handler
				// exists is that browsers do not always keep that promise; if
				// `onclose` never comes, clearing the timer would put us straight
				// back into the silent hang. The cost of leaving it is one extra
				// line after a failure that has already been reported.
				termWrite(`\n${t("term.failed")}\n`, "ddm-term-err");
			};
			socket.onclose = (event) => {
				termClearConnectTimer();
				const wasCurrent = terminal.socket === socket;
				if (wasCurrent) terminal.socket = null;
				terminal.owner = null;
				// The store's `owner` deliberately SURVIVES: the panel must stay
				// on screen to show why the connection ended. Clearing the store
				// owner here would make the overlay vanish at the exact moment the
				// user most needs to read the reason.
				termPatch({ status: "closed" });
				// An unexplained disconnect must say so. Leaving the panel claiming
				// "已连接" while `send` silently refuses every command is the worst
				// version of this bug: the user types and nothing at all happens.
				if (terminal.closing || terminal.rejected || terminal.timedOut) return;
				const code = event?.code;
				const detail = code === undefined || code === 0 ? "" : `（code ${code}${event?.reason === undefined || event.reason === "" ? "" : `：${event.reason}`}）`;
				termWrite(`\n${t("term.disconnected", { detail })}\n`, "ddm-term-err");
			};
		}

		/** Handle one frame from the Host. */
		function termReceive(frame) {
			if (frame === null || typeof frame !== "object") return;
			if (frame.t === "ready") {
				termClearConnectTimer();
				terminal.sessionId = frame.session?.id ?? null;
				if (typeof frame.session?.host === "string") termPatch({ host: frame.session.host });
				termPatch({ status: "connected" });
				termWrite(`\n${t("term.connected")}`, "ddm-term-sys");
				return;
			}
			if (frame.t === "out") {
				termWrite(stripAnsi(b64ToText(typeof frame.data === "string" ? frame.data : "")));
				return;
			}
			if (frame.t === "error") {
				terminal.rejected = true;
				termPatch({ status: "closed" });
				termWrite(`\n❌ ${frame.message ?? frame.reason ?? ""}\n`, "ddm-term-err");
				return;
			}
			if (frame.t === "exit") {
				termWrite(`\n[${t("term.exited")}]\n`, "ddm-term-sys");
			}
		}

		/**
		 * Make one chunk of device output readable in a `<pre>`.
		 *
		 * The transcript is a text pane, not a screen: it has no cursor to move
		 * and no cell colours to set, so an escape sequence has no effect other
		 * than being printed. Dropping them is therefore not "losing what the
		 * device said" — it is the only way the words are visible at all.
		 *
		 * Three real behaviours are why this cannot be a single regex:
		 *
		 *  1. bash redraws the prompt line with `\r` and no `\n` (a progress
		 *     bar, a long command). A bare `\r` in a `white-space:pre-wrap` pane
		 *     does nothing — the rewritten line would concatenate onto the old
		 *     one — so it becomes a newline. The cursor-addressing sequences that
		 *     would overwrite in a real terminal are dropped, because this pane
		 *     cannot overwrite.
		 *  2. A sequence can be split across two frames. Held back only when the
		 *     tail looks like the beginning of a sequence AND the chunk is not
		 *     already well-formed; that residue is prepended to the next chunk.
		 *  3. Backspace is honoured as a deletion, because the device may use it
		 *     for line editing and leaving the raw `\b` shows a stray glyph.
		 */
		function stripAnsi(text) {
			if (typeof text !== "string") return "";
			let out = termPending + text;
			termPending = "";
			// Complete sequences first. Whatever starts a sequence but never
			// finishes it SURVIVES this pass, which is what makes the frame
			// boundary detectable below without a second theory of grammar.
			out = out
				.replace(TERM_OSC, "")
				.replace(TERM_CSI, "")
				.replace(TERM_ESC, "");
			const tail = /(?:\x1b\[[0-9;:?<>=!\x20-\x2f]*|\x1b\][\s\S]*|\x1b)$/.exec(out);
			if (tail !== null) {
				// A sequence cut in half by a frame boundary is not output. Hold
				// the fragment for the next chunk so the two halves are stripped
				// together instead of leaking `ESC[` as visible text. The cap
				// stops a device that only ever sends `ESC]` from growing the
				// buffer without bound.
				termPending = tail[0].length > 512 ? tail[0].slice(-512) : tail[0];
				out = out.slice(0, out.length - tail[0].length);
			}
			out = out
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "\n")
				.replace(TERM_C0, "")
				// Backspace cancels the previous visible character; a backspace
				// at the start of a line has nothing to cancel.
				.replace(/[^\n]\x08/g, "")
				.replace(/\x08/g, "");
			return out;
		}

		/** Close the terminal, whether or not the socket is still alive. */
		function closeTerminal() {
			terminal.closing = true;
			termClearConnectTimer();
			const socket = terminal.socket;
			if (socket !== null) {
				try {
					socket.send(JSON.stringify({ t: "close" }));
				} catch {
					// The socket is already gone; the Host reaps the session on its
					// own idle timer either way.
				}
				try {
					socket.close();
				} catch {
					// ignore
				}
			}
			terminal.socket = null;
			terminal.owner = null;
			terminal.deviceId = null;
			terminal.sessionId = null;
			terminal.fullscreen = false;
			termPending = "";
			const before = store.snapshot.terminal ?? emptyTerminal();
			publish({ terminal: { ...before, open: false, owner: null, status: "idle", fullscreen: false } });
		}

		/** Whether a frame can be sent right now. */
		function termLive() {
			return terminal.socket !== null && terminal.socket.readyState === 1;
		}

		/**
		 * Report why a keystroke was not sent.
		 *
		 * Silently returning is what makes a dead terminal look like a slow
		 * device: the user sees their click do nothing and concludes the machine
		 * is busy. The three states get three different sentences.
		 */
		function termRefuse() {
			if (terminal.socket === null) {
				termWrite(`\n${t("term.notOpen")}\n`, "ddm-term-err");
				return true;
			}
			if (!termLive()) {
				termWrite(`\n${terminal.socket.readyState === 0 ? t("term.stillConnecting") : t("term.notOpen")}\n`, "ddm-term-err");
				return true;
			}
			return false;
		}

		/** Send one already-composed frame, reporting a failure to the user. */
		function termSend(payload) {
			if (termRefuse()) return false;
			try {
				terminal.socket.send(JSON.stringify(payload));
				return true;
			} catch (error) {
				termWrite(`\n${t("term.sendFailed", { error: error instanceof Error ? error.message : String(error) })}\n`, "ddm-term-err");
				return false;
			}
		}

		/**
		 * Submit one line.
		 *
		 * The terminator is `\r`, not `\n`. In a raw-mode PTY the shell's line
		 * discipline treats the carriage return as the "confirm" key; sending a
		 * newline produces a command that is typed but never executed, which
		 * reads as "the terminal is broken".
		 */
		function termSubmit(text) {
			if (text === "") return false;
			return termSend({ t: "in", data: text + "\r" });
		}

		/**
		 * Send one control byte.
		 *
		 * The local echo below is an ACTION CONFIRMATION, not fabricated device
		 * output: a control character has no visible effect of its own, so
		 * without it the user cannot tell whether the click registered. The
		 * remote's own echo still arrives afterwards and is appended verbatim.
		 */
		function termSendKey(byte) {
			if (!termSend({ t: "in", data: byte })) return false;
			const shown = byte === "\u001b" ? "Esc" : byte === "\u0009" ? "Tab" : `^${String.fromCharCode(byte.charCodeAt(0) + 64)}`;
			termWrite(`${t("term.keySent", { key: shown })}\n`, "ddm-term-sys");
			return true;
		}

		/** Tell the Host how wide the pane is, so the shell wraps correctly. */
		function termResize(element) {
			if (!termLive()) return;
			const cols = termCols(element);
			const rows = termRows(element);
			try {
				terminal.socket.send(JSON.stringify({ t: "resize", cols, rows }));
			} catch {
				// A PTY that refuses a resize keeps working at the old size.
			}
		}

		/**
		 * Estimate the pane size in character cells.
		 *
		 * Measured from the rendered element rather than assumed, because the
		 * same panel is 720px wide in the main area and pane-wide in
		 * fullscreen. The constants are the usual 7.2px advance and 16px line box
		 * for the monospace stack below, which is close enough: the consequence
		 * of being off by one column is a slightly early wrap.
		 */
		function termCols(element) {
			const width = element?.clientWidth;
			if (!Number.isFinite(width) || width <= 0) return 80;
			return Math.max(40, Math.min(400, Math.floor(width / 7.2)));
		}

		function termRows(element) {
			const height = element?.clientHeight;
			if (!Number.isFinite(height) || height <= 0) return 24;
			return Math.max(10, Math.min(200, Math.floor(height / 16)));
		}

		/**
		 * The terminal overlay.
		 *
		 * Rendered by the OWNING seat only (see `openTerminal`). It is positioned
		 * in the corner rather than centred: the feature exists to watch a
		 * command on a device while reading the conversation, and a modal would
		 * cover precisely the thing being debugged.
		 */
		function TerminalPanel({ state, owner }) {
			const pane = React.useRef(null);
			const input = React.useRef(null);
			const [draft, setDraft] = React.useState("");
			const term = state.terminal ?? emptyTerminal();
			const mine = term.owner === owner;

			// EVERY hook runs before any early return. React identifies hooks by
			// call ORDER, so returning `null` here before the effects below made a
			// seat render 3 hooks while it did not own the terminal and 5 once it
			// did — "Rendered more hooks than during the previous render", which is
			// minified error #310 and crashed the tab in the running GUI.

			// Keep the shell's idea of the pane size current. Re-measured whenever
			// the frame is rebuilt (connect, fullscreen), because a resize of the
			// ELEMENT does not fire a window `resize` event.
			React.useEffect(() => {
				if (!mine) return;
				termResize(pane.current);
			}, [term.status, term.fullscreen, mine]);
			// Leave the terminal when the owning seat goes away. Otherwise the
			// socket outlives the panel that shows it: the shell stays attached to
			// the device and the only way to reach it again is a page reload.
			//
			// The deps are EMPTY because unmount is the only event being
			// described. `owner` is a constant per MOUNTED seat in production (the
			// main slot hard-codes "main", the tab passes "sidebar-tab"), so
			// keying on it would be equivalent in the current app — but it is not
			// equivalent in general, and an empty array is the honest expression
			// of "on unmount". It also matters here because BOTH seats render
			// this same component function at once: a per-owner dep array lets
			// one live instance's dep change run the other instance's cleanup.
			React.useEffect(() => () => {
				if (terminal.owner === owner) closeTerminal();
			}, []);

			// The guard belongs AFTER the hooks. A non-owning seat renders
			// nothing, so two fixed-position overlays never stack.
			if (!mine) return null;
			/**
			 * Expand the panel to fill the column it was opened from, or restore it.
			 *
			 * Pure class toggle. The word "fullscreen" survives in this state field
			 * for compatibility with the stored shape, but the USER-FACING verb is
			 * 扩大 / 还原: the user corrected this explicitly (m09258) after the
			 * button said 全屏 and the panel did something else entirely. There is
			 * no Fullscreen API call here — see the CSS rules for why the API was
			 * tried and rejected. Writing the flag is all that is needed, and
			 * because `term.fullscreen` comes from the store the label and the
			 * class are computed from the same value and cannot disagree.
			 */
			const toggleFullscreen = () => {
				termPatch({ fullscreen: term.fullscreen !== true });
			};
			const submit = (event) => {
				event.preventDefault();
				if (draft === "") return;
				// Echo the line locally so the transcript shows what was asked even
				// if the remote is slow to echo it back.
				termWrite(`$ ${draft}\n`, "ddm-term-sys");
				if (termSubmit(draft)) setDraft("");
			};
			return h("div", { className: `ddm-term-panel${term.fullscreen === true ? " ddm-term-panel-full" : ""}`, "data-dsh-terminal": "", "data-dsh-terminal-device": term.deviceId ?? "" },
				h("div", { className: "ddm-term-head" },
					h("span", { className: "ddm-term-title", title: `${term.title} — ${term.host}` }, `🖥 ${term.title} — ${term.host}`),
					h("span", { className: "ddm-term-warn", title: t("term.warning") }, t("term.warning")),
					h("button", { type: "button", className: "ddm-btn", onClick: toggleFullscreen, "data-dsh-term-full": "" }, term.fullscreen === true ? "⛶ 还原" : "⛶ 扩大"),
					h("button", { type: "button", className: "ddm-btn", onClick: () => closeTerminal(), "data-dsh-term-close": "" }, t("term.close")),
				),
				h("pre", { className: "ddm-term-out", ref: pane, "data-dsh-term-out": "" },
					term.lines.map((line, index) => h("span", { className: line.kind ?? "", key: index }, line.text)),
				),
				// The control keys send single bytes, which is a DIFFERENT act from
				// the input box's "type a line and press Enter".
				h("div", { className: "ddm-term-keys" }, TERM_KEYS.map((entry, index) => (entry.separator === true
					? h("span", { className: "ddm-term-key-sep", key: `sep-${index}` })
					: h("button", {
						type: "button",
						className: "ddm-term-key",
						key: entry.label,
						title: entry.title,
						onClick: () => termSendKey(entry.byte),
						"data-dsh-term-key": entry.label,
					}, entry.label)))),
				h("form", { className: "ddm-term-form", onSubmit: submit },
					h("span", { className: "ddm-term-prompt" }, "$"),
					h("input", { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: t("term.placeholder"), autoComplete: "off", spellCheck: false, ref: input, "data-dsh-term-in": "" }),
					h("button", { type: "submit", className: "ddm-btn ddm-btn-primary" }, t("term.run")),
				),
			);
		}
		//#endregion

		//#region page
		/**
		 * The device view, mounted in the left panel, the main slot and the
		 * better-sidebar right column.
		 *
		 * All three read one shared store, so there is exactly one poller and one
		 * lease no matter how many seats are open. `owner` distinguishes the seats
		 * for the visibility bookkeeping; `narrow` only tightens the padding,
		 * because the same component has to fit both a full-width main area and a
		 * ~360px right column.
		 */
		function DevicePanel({ owner, visible, narrow }) {
			const state = useStore(subscribe, getSnapshot);
			const seat = owner ?? "default";

			// Visibility from the better-sidebar tab is authoritative when given;
			// every other seat is visible whenever it is mounted at all.
			const seatVisible = visible === undefined ? true : visible === true;

			React.useEffect(() => {
				setSeatVisible(seat, seatVisible);
				return () => dropSeat(seat);
			}, [seat, seatVisible]);

			// One initial load per store lifetime, triggered by the first seat.
			React.useEffect(() => {
				if (store.snapshot.lastLoaded === 0 && store.snapshot.status === "loading") {
					void refreshView();
					void loadSettings();
				}
			}, []);

			const detail = state.selected === null ? undefined : state.devices.find((device) => device.id === state.selected);
			const editingDevice = state.editing === null || state.editing === undefined ? undefined : state.devices.find((device) => device.id === state.editing);
			const narrowClass = narrow === true ? " ddm-narrow" : "";

			return h("div", { className: `ddm-view${narrowClass}`, "data-dsh-device-monitor-view": "", "data-dsh-plugin": "device-monitor" },
				h("div", { className: `ddm-head${narrow === true ? " ddm-head-narrow" : ""}` },
					h("div", { className: "ddm-head-text" },
						h("div", { className: "ddm-title" }, state.view === "settings" ? t("settings.title") : state.view === "logs" ? t("logs.title") : detail === undefined ? t("panel.title") : detail.name),
						h("div", { className: "ddm-sub" }, watchLine(state, t)),
					),
					h("div", { className: "ddm-spacer" }),
					state.view === "list" && detail === undefined
						? h("span", { className: "ddm-sub" }, t("panel.count", { count: state.devices.length, max: state.maxDevices }))
						: null,
					state.view === "list" && detail === undefined
						? h("button", { type: "button", className: "ddm-btn", onClick: () => void collectEverything(), disabled: state.devices.length === 0 }, h(RefreshIcon), t("panel.refreshAll"))
						: null,
					state.view === "detail" || state.view === "form"
						? h("button", { type: "button", className: "ddm-btn", onClick: () => showView("list", null) }, t("detail.back"))
						: null,
					state.view === "list" && detail === undefined
						? h("button", { type: "button", className: "ddm-btn ddm-btn-primary", onClick: () => { publish({ formError: undefined, editing: null, view: "form" }); }, disabled: state.devices.length >= state.maxDevices }, h(PlusIcon), t("panel.add"))
						: null,
				),
				h("div", { className: "ddm-tabs" },
					h("button", { type: "button", className: `ddm-tab${state.view === "settings" ? " ddm-tab-active" : ""}`, onClick: () => showView("settings", null) }, t("view.settings")),
					h("button", { type: "button", className: `ddm-tab${state.view === "logs" ? " ddm-tab-active" : ""}`, onClick: () => showView("logs", null) }, t("view.logs")),
					h("button", { type: "button", className: `ddm-tab${state.view === "list" || state.view === "detail" || state.view === "form" ? " ddm-tab-active" : ""}`, onClick: () => showView("list", null) }, t("view.list")),
				),
				h("div", { className: `ddm-body${narrow === true ? " ddm-body-narrow" : ""}` },
					state.notice === undefined ? null : h("div", { className: "ddm-notice" }, state.notice),
					state.status === "error" ? h("div", { className: "ddm-error" }, t("panel.loadFailed", { error: state.error ?? "" })) : null,
					state.view === "settings"
						? h(SettingsView, { state })
						: state.view === "logs"
							? h(LogsView, { state })
							: state.view === "form"
								? h(DeviceForm, {
									device: editingDevice,
									busy: state.busyForm,
									error: state.formError,
									onCancel: () => showView("list", null),
									onSubmit: (payload) => void submitForm(payload),
								})
								: state.status === "loading"
									? h("div", { className: "ddm-empty" }, t("panel.loading"))
									: state.status === "ready" && state.devices.length >= state.maxDevices
										? h("div", { className: "ddm-notice" }, t("panel.full", { max: state.maxDevices }))
										: null,
					state.view !== "settings" && state.view !== "logs" && state.view !== "form" && state.status === "ready"
						? detail !== undefined
							? h(DeviceDetail, { device: detail, state, onExec: (command) => api.exec(detail.id, command) })
							: state.devices.length === 0
								? h("div", { className: "ddm-empty" },
									h("div", { className: "ddm-empty-title" }, t("panel.empty.title")),
									h("div", null, t("panel.empty.body")),
									h("button", { type: "button", className: "ddm-btn ddm-btn-primary", onClick: () => publish({ formError: undefined, editing: null, view: "form" }) }, h(PlusIcon), t("panel.add")),
								)
								: h("div", { className: "ddm-grid" }, state.devices.map((device) =>
									h(DeviceCard, {
										key: device.id,
										device,
										state,
										busy: state.busyIds.includes(device.id),
										onOpen: () => showView("detail", device.id),
										onCollect: () => void collectOne(device.id),
										onTest: () => void testOne(device.id),
										onTerminal: () => openTerminal(device.id, seat),
										onEdit: () => publish({ formError: undefined, editing: device.id, view: "form" }),
										onDelete: () => void removeDevice(device.id, device.name),
									}),
								))
						: null,
				),
				// The terminal overlay is rendered by the seat that opened it, and
				// only by that one: both seats pin it to the same bottom-right
				// corner of their own pane, so two copies would sit on top of each
				// other and each would append every output chunk to its own copy
				// of the transcript.
				h(TerminalPanel, { state, owner: seat }),
			);
		}

		/** The one-line watch state shown under the panel title. */
		function watchLine(state, translate) {
			if (Object.keys(state.visibleOwners).length === 0) return translate("watch.idle");
			const sec = Math.max(5, Math.min(3600, Math.round(numOrNull(state.settings?.refreshIntervalSec) ?? 60)));
			return translate("watch.active", { sec });
		}

		/**
		 * The settings view: cadence, thresholds, metric picker, logging.
		 *
		 * The metric checkboxes are the same contract the Host enforces — an
		 * unchecked metric stops the SSH command being sent at all, which is why
		 * the hint says so explicitly rather than presenting it as a display
		 * filter.
		 */
		function SettingsView({ state }) {
			const settings = state.settings;
			const [interval, setInterval] = React.useState("");
			const [thresholds, setThresholds] = React.useState({});
			const [metrics, setMetrics] = React.useState(null);
			const [rawLog, setRawLog] = React.useState(true);
			const [incidents, setIncidents] = React.useState({});
			const [custom, setCustom] = React.useState({ enabled: false, overrides: {} });
			// `termCfg`, not `terminal`: that name is taken by the live-connection
			// singleton in the terminal region above. `idleMs` stays in
			// MILLISECONDS to match the Host field; the input below shows seconds.
			const [termCfg, setTermCfg] = React.useState({ enabled: false, allowedHosts: [], idleMs: 300_000 });
			const [busy, setBusy] = React.useState(false);

			// Seed the local form once the Host settings arrive, and re-seed
			// whenever a save changes them, so the form never drifts from truth.
			React.useEffect(() => {
				if (settings === null || settings === undefined) return;
				setInterval(String(settings.refreshIntervalSec ?? 60));
				setThresholds({ ...(settings.thresholds ?? {}) });
				setRawLog(settings.rawLog?.enabled !== false);
				setIncidents({ ...(settings.incidents ?? {}) });
				// The checkbox must reflect a REAL boolean `true`, exactly as the
				// Host normalizer requires: a stray string in the file renders as
				// OFF rather than as a silently armed override.
				setCustom({
					enabled: settings.customCommands?.enabled === true,
					overrides: { ...(settings.customCommands?.overrides ?? {}) },
				});
				// Same strict-boolean rule as the override switch: the terminal
				// hands out a full shell, so a stray `"true"` string in the file
				// must render as OFF rather than as an armed backdoor.
				setTermCfg({
					enabled: settings.terminal?.enabled === true,
					allowedHosts: Array.isArray(settings.terminal?.allowedHosts) ? [...settings.terminal.allowedHosts] : [],
					idleMs: Math.round(numOrNull(settings.terminal?.idleMs) ?? 300_000),
				});
			}, [settings]);

			const catalog = state.catalog;
			// `null` here means "no choice recorded" — show everything checked,
			// matching what the Host will actually collect for that device.
			React.useEffect(() => {
				if (metrics !== null) return;
				setMetrics(catalog.map((row) => row.key));
			}, [catalog, metrics]);

			const selected = Array.isArray(metrics) ? metrics : [];
			const toggleMetric = (key) => () => setMetrics((current) => {
				const base = Array.isArray(current) ? current : catalog.map((row) => row.key);
				return base.includes(key) ? base.filter((row) => row !== key) : [...base, key];
			});
			const save = async () => {
				setBusy(true);
				try {
					await saveSettings({
						refreshIntervalSec: Math.round(numOrNull(interval) ?? 60),
						thresholds: {
							cpu: numOrNull(thresholds.cpu) ?? 0,
							mem: numOrNull(thresholds.mem) ?? 0,
							disk: numOrNull(thresholds.disk) ?? 0,
							temp: numOrNull(thresholds.temp) ?? 0,
						},
						rawLog: { enabled: rawLog === true },
						incidents: {
							offlineAfter: Math.round(numOrNull(incidents.offlineAfter) ?? 2),
							rebootDetect: incidents.rebootDetect !== false,
							rebootMinDrop: Math.round(numOrNull(incidents.rebootMinDrop) ?? 120),
						},
						customCommands: {
							enabled: custom.enabled === true,
							// Blank = "use the built-in command". Sending the empty
							// string would be dropped by the Host normalizer anyway,
							// but omitting it keeps the stored file honest about
							// what the user actually configured.
							overrides: Object.fromEntries(
								Object.entries(custom.overrides ?? {})
									.map(([key, value]) => [key, String(value ?? "").trim()])
									.filter(([, value]) => value !== ""),
							),
						},
						terminal: {
							// A real boolean, never a truthy value: the Host
							// normalizer requires `=== true` before it will hand out
							// a shell, and a string here would be silently dropped
							// while the switch on screen said "on".
							enabled: termCfg.enabled === true,
							// One rule per line. Blank lines and surrounding spaces
							// are dropped here rather than sent: the Host would
							// discard them anyway, and sending them would make the
							// stored file differ from what the field shows.
							allowedHosts: String(termCfg.allowedHosts.join("\n"))
								.split(/\r?\n/)
								.map((row) => row.trim())
								.filter((row) => row !== ""),
							// The field is in seconds because that is what a person
							// reasons about; the Host stores milliseconds. Rounding
							// is not cosmetic — a fractional ms would be clamped
							// anyway, and 0 must stay 0 so "off" is expressible.
							idleMs: Math.round((numOrNull(termCfg.idleMs) ?? 300_000)),
						},
					});
				} finally {
					setBusy(false);
				}
			};
			if (settings === null || settings === undefined) {
				return h("div", { className: "ddm-empty" }, t("panel.loading"));
			}
			return h("div", { className: "ddm-form-panel", "data-dsh-device-settings": "" },
				h(Field, { label: t("settings.interval") },
					h("input", { value: interval, onChange: (event) => setInterval(event.target.value), inputMode: "numeric" }),
					h("div", { className: "ddm-hint" }, t("settings.intervalHint")),
				),
				h("div", { className: "ddm-field" },
					h("label", null, t("settings.thresholds")),
					h("div", { className: "ddm-grid-2" },
						THRESHOLD_KEYS.map((key) => h("label", { className: "ddm-field", key },
							h("span", { className: "ddm-hint" }, t(`settings.threshold.${key}`)),
							h("input", { value: thresholds[key] ?? "", onChange: (event) => setThresholds((current) => ({ ...current, [key]: event.target.value })), inputMode: "numeric", "data-dsh-threshold": key }),
						)),
					),
					h("div", { className: "ddm-hint" }, t("settings.thresholdHint")),
				),
				h("div", { className: "ddm-field" },
					h("label", null, t("settings.metrics")),
					h("div", { className: "ddm-checks" }, catalog.map((row) =>
						h("label", { className: "ddm-check ddm-check-row", key: row.key },
							h("input", { type: "checkbox", checked: row.always === true || selected.includes(row.key), disabled: row.always === true, onChange: toggleMetric(row.key), "data-dsh-metric-key": row.key }),
							h("span", { className: "ddm-check-body" },
								h("span", { className: "ddm-check-name" },
									row.label,
									row.always === true ? h("span", { className: "ddm-check-always" }, t("settings.metricsAlways")) : null,
								),
								row.hint === undefined || row.hint === "" ? null : h("span", { className: "ddm-check-hint" }, row.hint),
							),
						),
					)),
					h("div", { className: "ddm-hint" }, t("settings.metricsHint")),
				),
				h("div", { className: "ddm-field" },
					h("label", { className: "ddm-check" },
						h("input", { type: "checkbox", checked: rawLog === true, onChange: (event) => setRawLog(event.target.checked) }),
						h("span", null, t("settings.rawLog")),
					),
					// Stated next to the switch, not only in the README: the raw log
					// contains verbatim device output and is never redacted.
					h("div", { className: "ddm-warn" }, t("settings.rawLogWarning")),
				),
				h("div", { className: "ddm-field" },
					h("label", null, t("logs.incidents")),
					h("div", { className: "ddm-grid-2" },
						h("label", { className: "ddm-field" },
							h("span", { className: "ddm-hint" }, t("settings.incidents.offlineAfter")),
							h("input", { value: incidents.offlineAfter ?? "", onChange: (event) => setIncidents((current) => ({ ...current, offlineAfter: event.target.value })), inputMode: "numeric" }),
						),
						h("label", { className: "ddm-field" },
							h("span", { className: "ddm-hint" }, t("settings.incidents.rebootMinDrop")),
							h("input", { value: incidents.rebootMinDrop ?? "", onChange: (event) => setIncidents((current) => ({ ...current, rebootMinDrop: event.target.value })), inputMode: "numeric" }),
						),
					),
					h("label", { className: "ddm-check" },
						h("input", { type: "checkbox", checked: incidents.rebootDetect !== false, onChange: (event) => setIncidents((current) => ({ ...current, rebootDetect: event.target.checked })) }),
						h("span", null, t("settings.incidents.rebootDetect")),
					),
				),
				h("div", { className: "ddm-field" },
					h("label", null, t("settings.custom")),
					h("label", { className: "ddm-check" },
						h("input", { type: "checkbox", checked: custom.enabled === true, onChange: (event) => setCustom((current) => ({ ...current, enabled: event.target.checked })), "data-dsh-custom-commands": "" }),
						h("span", null, t("settings.customEnable")),
					),
					h("div", { className: "ddm-hint" }, t("settings.customHint")),
					// The risk sits next to the switch, not only in the README:
					// this is the one setting that can run arbitrary commands on
					// every device on a timer, outside the tool whitelist.
					h("div", { className: "ddm-warn" }, t("settings.customWarning")),
					custom.enabled === true ? h("div", { className: "ddm-custom-rows" }, catalog.filter((row) => row.always !== true).map((row) =>
						h("label", { className: "ddm-field", key: row.key },
							h("span", { className: "ddm-hint" }, row.label),
							h("input", {
								value: custom.overrides?.[row.key] ?? "",
								placeholder: t("settings.customPlaceholder"),
								onChange: (event) => setCustom((current) => ({ ...current, overrides: { ...(current.overrides ?? {}), [row.key]: event.target.value } })),
								"data-dsh-custom-key": row.key,
							}),
						),
					)) : null,
				),
				// The terminal sits LAST, after every read-only setting: it is the
				// only control in this panel that can hand out a shell, and the
				// reference system gives it the same "advanced, at the bottom"
				// treatment so nobody arms it on the way past.
				h("div", { className: "ddm-field" },
					h("label", null, t("settings.terminal")),
					h("label", { className: "ddm-check" },
						h("input", {
							type: "checkbox",
							checked: termCfg.enabled === true,
							onChange: (event) => setTermCfg((current) => ({ ...current, enabled: event.target.checked })),
							"data-dsh-terminal-commands": "",
						}),
						h("span", null, t("settings.terminalEnable")),
					),
					h("div", { className: "ddm-hint" }, t("settings.terminalHint")),
					// The risk is stated where the switch is, not only in the
					// README. This is the sharpest control in the plugin: unlike a
					// collection command it is not fixed in advance, and unlike
					// `device_exec` it is typed by a human rather than by a tool.
					h("div", { className: "ddm-warn" }, t("settings.terminalWarning")),
					termCfg.enabled !== true ? null : h("div", null,
						h("label", { className: "ddm-field" },
							h("span", { className: "ddm-hint" }, t("settings.terminalHosts")),
							h("textarea", {
								value: termCfg.allowedHosts.join("\n"),
								placeholder: "127.0.0.1\n192.168.1.0/24",
								onChange: (event) => setTermCfg((current) => ({ ...current, allowedHosts: event.target.value.split(/\r?\n/) })),
								"data-dsh-terminal-hosts": "",
							}),
						),
						h("div", { className: "ddm-hint" }, t("settings.terminalHostsHint")),
						h("label", { className: "ddm-field" },
							h("span", { className: "ddm-hint" }, t("settings.terminalIdle")),
							// Seconds on screen, milliseconds in state: the Host
							// field is ms, but a person configures a timeout in
							// seconds and a ms field would invite a typo of 1000×.
							h("input", {
								value: String(Math.round((numOrNull(termCfg.idleMs) ?? 300_000) / 1000)),
								inputMode: "numeric",
								onChange: (event) => setTermCfg((current) => ({ ...current, idleMs: (numOrNull(event.target.value) ?? 300) * 1000 })),
								"data-dsh-terminal-idle": "",
							}),
						),
						h("div", { className: "ddm-hint" }, t("settings.terminalIdleHint")),
					),
				),
				h("div", { className: "ddm-form-actions-wrap" },
					h("button", { type: "button", className: "ddm-btn ddm-btn-primary ddm-btn-block", onClick: () => void save(), disabled: busy }, busy ? t("settings.saving") : t("settings.save")),
				),
			);
		}

		/**
		 * The logs view: raw capture, audit trail and incidents.
		 *
		 * Raw lines are shown exactly as the device returned them, which is the
		 * point of the feature — this is the debugging surface for "what did that
		 * command actually print on that box".
		 */
		function LogsView({ state }) {
			const [tab, setTab] = React.useState("raw");
			const [deviceId, setDeviceId] = React.useState(null);
			const [logs, setLogs] = React.useState(null);
			const [raw, setRaw] = React.useState(null);
			const [auditRows, setAuditRows] = React.useState([]);
			const [incidentRows, setIncidentRows] = React.useState([]);
			const [error, setError] = React.useState(undefined);

			React.useEffect(() => {
				let cancelled = false;
				void (async () => {
					try {
						const body = await api.logs();
						if (cancelled) return;
						setLogs(body);
						// Prefer a device that already has a file; fall back to the
						// roster so a never-collected device is still selectable.
						setDeviceId((current) => current ?? body?.devices?.[0]?.id ?? state.devices?.[0]?.id ?? null);
					} catch (problem) {
						if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
					}
				})();
				return () => {
					cancelled = true;
				};
			}, []);

			React.useEffect(() => {
				if (deviceId === null) return;
				let cancelled = false;
				void (async () => {
					try {
						const body = await api.rawlog(deviceId, 200);
						if (!cancelled) setRaw(body);
					} catch (problem) {
						if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [deviceId]);

			React.useEffect(() => {
				if (tab !== "audit") return undefined;
				let cancelled = false;
				void (async () => {
					try {
						const body = await api.audit(200);
						if (!cancelled) setAuditRows(Array.isArray(body.audit) ? body.audit : []);
					} catch (problem) {
						if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [tab]);

			React.useEffect(() => {
				if (tab !== "incidents") return undefined;
				let cancelled = false;
				void (async () => {
					try {
						const body = await api.incidents(200);
						if (!cancelled) setIncidentRows(Array.isArray(body.incidents) ? body.incidents : []);
					} catch (problem) {
						if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [tab]);

			const lines = Array.isArray(raw?.lines) ? raw.lines : [];
			/**
			 * The devices offered in the raw-log picker.
			 *
			 * The Host lists only devices that already have a log file. Falling
			 * back to the roster matters because a device registered but never
			 * collected has no file yet, and "it is missing from the picker" is
			 * indistinguishable from "logging is broken".
			 */
			const picker = (logs?.devices ?? []).length > 0
				? logs.devices
				: (state.devices ?? []).map((device) => ({ id: device.id, name: device.name, bytes: 0 }));
			return h("div", { className: "ddm-form-panel", "data-dsh-device-logs": "" },
				h("div", { className: "ddm-tabs" },
					h("button", { type: "button", className: `ddm-tab${tab === "raw" ? " ddm-tab-active" : ""}`, onClick: () => setTab("raw") }, t("logs.raw")),
					h("button", { type: "button", className: `ddm-tab${tab === "audit" ? " ddm-tab-active" : ""}`, onClick: () => setTab("audit") }, t("logs.audit")),
					h("button", { type: "button", className: `ddm-tab${tab === "incidents" ? " ddm-tab-active" : ""}`, onClick: () => setTab("incidents") }, t("logs.incidents")),
				),
				error === undefined ? null : h("div", { className: "ddm-error" }, t("logs.loadFailed", { error })),
				h("div", { className: "ddm-kv" },
					h("span", { className: "ddm-kv-key" }, t("logs.dir")),
					h("span", { title: logs?.dir }, logs?.dir ?? "—"),
					h("span", { className: "ddm-kv-key" }, t("logs.title")),
					h("span", null, logs?.enabled === true ? t("logs.enabled") : t("logs.disabled")),
					h("span", { className: "ddm-kv-key" }, t("logs.total")),
					h("span", null, formatBytes(logs?.totalBytes ?? 0)),
				),
				tab === "raw"
					? h("div", null,
						h("div", { className: "ddm-section-title" }, t("logs.deviceHeader")),
						h("div", { className: "ddm-checks" }, picker.map((row) =>
							h("label", { className: "ddm-check", key: row.id },
								h("input", { type: "radio", name: "ddm-log-device", checked: deviceId === row.id, onChange: () => setDeviceId(row.id), "data-dsh-log-device": row.id }),
								h("span", null, `${row.name} · ${formatBytes(row.bytes)}`),
							),
						)),
						(raw?.dir === undefined ? null : h("div", { className: "ddm-hint" }, `${raw.dir} · ${formatBytes(raw.bytes)}`)),
						lines.length === 0
							? h("div", { className: "ddm-sub" }, t("logs.empty"))
							: h("pre", { className: "ddm-log" }, lines.map((line) => (typeof line === "string" ? line : line.raw ?? JSON.stringify(line))).join("\n")),
					)
					: tab === "audit"
						? h("div", null,
							h("div", { className: "ddm-section-title" }, t("logs.auditHeader")),
							auditRows.length === 0
								? h("div", { className: "ddm-sub" }, t("logs.empty"))
								: h("pre", { className: "ddm-log" }, auditRows.map((row) => JSON.stringify(row)).join("\n")),
						)
						: h("div", null,
							h("div", { className: "ddm-section-title" }, t("logs.incidentHeader")),
							incidentRows.length === 0
								? h("div", { className: "ddm-sub" }, t("incident.none"))
								: h("pre", { className: "ddm-log" }, incidentRows.map((row) => JSON.stringify(row)).join("\n")),
						),
			);
		}

		/**
		 * One device tile.
		 *
		 * Every metric row is gated by the device's OWN metric config, so a card
		 * never offers a number the Host was told not to collect. The gate reads
		 * the config, never whether the value happened to come back null.
		 */
		function DeviceCard({ device, state, busy, onOpen, onCollect, onTerminal, onEdit, onDelete }) {
			const sample = device.sample;
			const metrics = device.metrics;
			const series = state?.seriesById?.[device.id]?.series ?? [];
			const nums = numericCells(sample, metrics);
			// `description` / `location` / `tags` were stored, shipped and editable
			// long before anything drew them, so a user could type a note and a
			// rack number into the form and then never see them again. Rendering
			// them here is what makes the form fields honest. Both are optional and
			// absent means "not filled in", never an empty row.
			const tags = Array.isArray(device.tags) ? device.tags : [];
			const location = typeof device.location === "string" ? device.location.trim() : "";
			const description = typeof device.description === "string" ? device.description.trim() : "";
			return h("div", { className: "ddm-card" },
				h("div", { className: "ddm-card-top" },
					h("span", { className: dotTone(device) }),
					h("div", { style: { minWidth: 0, flex: 1 } },
						h("div", { className: "ddm-name", title: device.name, style: { cursor: "pointer" }, onClick: onOpen }, device.name),
						h("div", { className: "ddm-addr" }, `${device.username}@${device.host}:${device.port}`),
						tags.length === 0
							? null
							: h("div", { className: "ddm-tags" }, tags.map((tag) => h("span", { className: "ddm-tag", key: tag, "data-dsh-card-tag": tag }, tag))),
					),
				),
					location === "" && description === ""
					? null
					: h("div", { className: "ddm-notes" },
						location === "" ? null : h("div", { className: "ddm-note" }, h("span", { className: "ddm-note-key" }, t("card.location")), location),
						description === "" ? null : h("div", { className: "ddm-note" }, h("span", { className: "ddm-note-key" }, t("card.description")), description),
					),
				device.error !== undefined && device.error !== null
					? h("div", { className: "ddm-alert" }, `${t("card.failed")}: ${device.error}`)
					: h("div", null,
						// Order matters: the numeric strip first, then one chart per
						// row. The numbers are the summary, the charts the detail.
						nums.length === 0 ? null : h("div", { className: "ddm-nums" }, nums),
						h("div", { style: { marginTop: nums.length === 0 ? 0 : 8 } }, h(WaveRow, {
							series,
							latest: series.length > 0 ? series[series.length - 1] : undefined,
							sample,
							metrics,
						})),
					),
				h("div", { className: "ddm-row" },
					h("span", null, sample === undefined ? t("card.never") : t("card.collectedAt", { time: clockTime(device.collectedAt) })),
				),
				h(IncidentLine, { incident: device.incident }),
				(device.alerts ?? []).length === 0 ? null : h("div", { className: "ddm-alerts" }, (device.alerts ?? []).map((alert, index) =>
					h("span", { className: "ddm-alert", key: `${alert.metric}-${index}` }, alertText(alert)),
				)),
				h("div", { className: "ddm-card-actions" },
					h("button", { type: "button", className: "ddm-btn", onClick: onOpen }, t("detail.title")),
					h("button", { type: "button", className: "ddm-btn", onClick: onCollect, disabled: busy }, busy ? t("detail.execRunning") : t("card.collect")),
					// Two different questions, two different buttons — the
					// reference system draws the same distinction. "Can I reach
					// this device?" is answered by a test in the edit form, where
					// the credentials being checked are the ones on screen. The
					// card has a SAVED device, so it offers the full debug
					// terminal instead. Collapsing them would mean one label for
					// two actions, and the terminal is the one that can actually
					// diagnose a device that connects but misbehaves.
					h("button", {
						type: "button",
						className: "ddm-btn",
						onClick: onTerminal,
						disabled: busy,
						title: t("term.openHint"),
						"data-dsh-card-terminal": device.id,
					}, t("term.open")),
					h("button", { type: "button", className: "ddm-btn", onClick: onEdit }, t("card.edit")),
					h("button", { type: "button", className: "ddm-btn ddm-btn-danger", onClick: onDelete }, t("card.delete")),
				),
			);
		}

		/**
		 * The durable offline/reboot state for one device.
		 *
		 * Renders from `device.incident`, which the Host persists across restarts,
		 * so a device that went offline overnight still explains itself here.
		 */
		function IncidentLine({ incident }) {
			if (incident === undefined || incident === null || incident.offline !== true) return null;
			return h("div", { className: "ddm-incident ddm-incident-offline" },
				h("span", null, t("incident.offline")),
				incident.fails === undefined ? null : h("span", null, t("incident.fails", { count: incident.fails })),
				incident.downSeconds === undefined ? null : h("span", null, t("incident.down", { sec: Math.round(incident.downSeconds) })),
			);
		}

		/** The detail page for one device: waveforms, filesystems, services, command runner. */
		function DeviceDetail({ device, state, onExec }) {
			const [history, setHistory] = React.useState({ status: "loading", series: [], sample: device.sample });
			const [command, setCommand] = React.useState("");
			const [output, setOutput] = React.useState(undefined);
			const [running, setRunning] = React.useState(false);
			const metrics = device.metrics;

			const loadHistory = React.useCallback(async () => {
				try {
					const body = await api.metrics(device.id, 120);
					setHistory({ status: "ready", series: body.series ?? [], sample: body.sample ?? device.sample });
				} catch (error) {
					setHistory({ status: "error", series: [], sample: device.sample, error: error instanceof Error ? error.message : String(error) });
				}
			}, [device.id]);

			React.useEffect(() => {
				void loadHistory();
			}, [loadHistory, device.collectedAt]);

			const run = async () => {
				const trimmed = command.trim();
				if (trimmed === "") return;
				setRunning(true);
				setOutput(undefined);
				try {
					const body = await onExec(trimmed);
					const result = body?.result;
					if (result === undefined) setOutput("(no result)");
					else setOutput([result.stdout ?? "", result.stderr === undefined || result.stderr === "" ? "" : `\n[stderr]\n${result.stderr}`, result.error === undefined ? "" : `\n[error] ${result.error}`].join("").trim() || `(exit ${result.exitCode ?? "?"})`);
				} catch (error) {
					setOutput(error instanceof Error ? error.message : String(error));
				} finally {
					setRunning(false);
				}
			};

			const sample = history.sample ?? device.sample;
			const series = history.series;
			const tags = Array.isArray(device.tags) ? device.tags : [];
			const location = typeof device.location === "string" ? device.location.trim() : "";
			const description = typeof device.description === "string" ? device.description.trim() : "";
			return h("div", { className: "ddm-panel" },
				device.error !== undefined && device.error !== null ? h("div", { className: "ddm-error" }, device.error) : null,
				h(IncidentLine, { incident: device.incident }),
				h("div", { className: "ddm-section" },
					h("div", { className: "ddm-section-title" }, t("detail.trend")),
					h(WaveRow, {
						series,
						latest: series.length > 0 ? series[series.length - 1] : undefined,
						sample,
						metrics,
					}),
				),
				h("div", { className: "ddm-section" },
					h("div", { className: "ddm-section-title" }, t("detail.title")),
					h("div", { className: "ddm-kv" },
						h("span", { className: "ddm-kv-key" }, t("detail.model")),
						h("span", null, sample?.model ?? "—"),
						h("span", { className: "ddm-kv-key" }, t("detail.kernel")),
						h("span", null, sample?.kernel ?? "—"),
						hasMetric(metrics, "cpu") ? h("span", { className: "ddm-kv-key" }, t("metric.cpu")) : null,
						// Same single source of truth as the load row below: the card
						// cell and this row must not disagree about whether the core
						// count is known. The old inline `?? 1` fabricated a core when
						// /proc/stat had not been read.
						hasMetric(metrics, "cpu") ? h("span", null, metricDetail("cpu", sample) ?? "—") : null,
						hasMetric(metrics, "load") ? h("span", { className: "ddm-kv-key" }, t("metric.load")) : null,
						// metricDetail is the ONE place that decides how a reading
						// reads, so the detail row cannot drift from the card cell.
						// Printing the three raw averages here (as this row used to)
						// left the user to guess what they were measured against.
						hasMetric(metrics, "load") ? h("span", null, metricDetail("load", sample) ?? "—") : null,
						h("span", { className: "ddm-kv-key" }, t("metric.uptime")),
						h("span", null, sample?.uptimeText ?? "—"),
						// The card shows these as free text; the detail view is where
						// the full value fits, which is the whole reason a note field
						// exists. Same source as the card, so the two cannot disagree.
						location === "" ? null : h("span", { className: "ddm-kv-key" }, t("card.location")),
						location === "" ? null : h("span", { "data-dsh-detail-location": location }, location),
						description === "" ? null : h("span", { className: "ddm-kv-key" }, t("card.description")),
						description === "" ? null : h("span", { "data-dsh-detail-description": description }, description),
						tags.length === 0 ? null : h("span", { className: "ddm-kv-key" }, t("card.tags")),
						tags.length === 0 ? null : h("span", { "data-dsh-detail-tags": tags.join(",") }, tags.join(" · ")),
					),
				),
				hasMetric(metrics, "disk")
					? h("div", { className: "ddm-section" },
						h("div", { className: "ddm-section-title" }, t("detail.filesystems")),
						(sample?.disk ?? []).length === 0
							? h("div", { className: "ddm-sub" }, t("card.never"))
							: h("div", { className: "ddm-scroll" }, h("table", { className: "ddm-table" },
								h("thead", null, h("tr", null,
									h("th", null, t("detail.colDevice")),
									h("th", null, t("detail.colMount")),
									h("th", null, t("detail.colUsed")),
									h("th", null, t("detail.colAvail")),
									h("th", null, t("detail.colPercent")),
								)),
								h("tbody", null, (sample?.disk ?? []).map((row) =>
									h("tr", { key: row.mount },
										h("td", { title: row.fs }, row.fs),
										h("td", null, row.mount),
										h("td", null, `${row.usedMB} MB`),
										h("td", null, `${row.availableMB} MB`),
										h("td", { style: { color: pct(row.usagePercent) >= 90 ? "var(--dsw-alias-state-error-primary)" : undefined } }, `${row.usagePercent}%`),
									),
								)),
							)),
					)
					: null,
				h("div", { className: "ddm-section" },
					h("div", { className: "ddm-section-title" }, t("detail.services")),
					(sample?.services ?? []).length === 0
						? h("div", { className: "ddm-sub" }, t("detail.noServices"))
						: h("div", { className: "ddm-services ddm-scroll" }, (sample?.services ?? []).map((service) => h("span", { className: "ddm-chip", key: service }, service))),
				),
				h("div", { className: "ddm-section" },
					h("div", { className: "ddm-section-title" }, t("detail.exec")),
					h("div", { className: "ddm-exec-row" },
						h("input", { value: command, onChange: (event) => setCommand(event.target.value), placeholder: t("detail.execPlaceholder"), onKeyDown: (event) => { if (event.key === "Enter") void run(); } }),
						h("button", { type: "button", className: "ddm-btn ddm-btn-primary", onClick: () => void run(), disabled: running || command.trim() === "" }, running ? t("detail.execRunning") : t("detail.execRun")),
					),
					h("pre", { className: "ddm-code", style: { marginTop: 10 } }, output ?? t("detail.execEmpty")),
				),
			);
		}
		//#endregion

		//#region icons
		function RefreshIcon() {
			return h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", "aria-hidden": "true" },
				h("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9" }),
				h("path", { d: "M13.5 2.5V5H11" }),
			);
		}
		function PlusIcon() {
			return h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", "aria-hidden": "true" },
				h("path", { d: "M8 3.25v9.5M3.25 8h9.5" }),
			);
		}
		/**
		 * The row glyph inside the shell-owned sidebar row. It carries
		 * `data-dsh-panel-entry` because it is the only DOM this panel owns
		 * inside that row, and the shell/skins resolve which row belongs to
		 * which plugin through it.
		 */
		function DevicePanelIcon({ size }) {
			return h("svg", {
				"data-dsh-panel-entry": "device-monitor",
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
				h("rect", { x: "1.75", y: "2.25", width: "12.5", height: "9", rx: "1.5" }),
				h("path", { d: "M5.5 14.25h5" }),
				h("path", { d: "M8 11.25v3" }),
				h("path", { d: "M4.5 6.25h2.25" }),
				h("path", { d: "M4.5 8.5h5.5" }),
				h("circle", { cx: "11.5", cy: "6.25", r: "1", fill: "currentColor", stroke: "none" }),
			);
		}
		//#endregion

		//#region registration
		/** Sidebar row order: after the built-in panels and the SSH entry. */
		const PANEL_ORDER = 60;
		/** The panel id shared by the sidebar row and the main-slot key. */
		const PANEL_ID = "device-monitor";

		/**
		 * Register the main-slot seat. Registration is wrapped in
		 * `ctx.slots.inject`, so it runs only once the owning shell entry has
		 * declared the seat and a shell that cannot serve it never calls back.
		 *
		 * There is deliberately NO `sidebar.panellist` registration. That seat is
		 * the left rail, whose rows are buttons that call `layout.selectPanel(id)`
		 * to swap the centre column (`dsh-client-ui-sidebar/lib/client.js:185`).
		 * The panel's real home is the right column beside the conversation, so a
		 * left-rail row would be a second entrance to a view the user already has
		 * open — and clicking it would blank the conversation to show it.
		 * @returns a disposer releasing the registration.
		 */
		function registerPanel(ctx) {
			const slots = ctx.slots;
			const disposers = [];
			disposers.push(slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({}),
			}, MainSeat)));
			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}

		/** The main-slot seat: full width, always visible while mounted. */
		function MainSeat() {
			return h(DevicePanel, { owner: "main", narrow: false });
		}

		/**
		 * Register the right-sidebar tab with the better-sidebar plugin.
		 *
		 * This is deliberately a SOFT dependency. The tab is the nicer home for
		 * the panel — it sits beside the conversation — but the plugin must keep
		 * working when better-sidebar is absent or disabled, so the caller wraps
		 * this in a guard and the registration only happens through the service
		 * the plugin publishes. Taking the raw `sidebar.right.pane.tab` seat
		 * instead would fight better-sidebar for ownership of its own tab bar.
		 *
		 * `visible` is honoured rather than ignored: when the tab is hidden the
		 * seat releases its watch lease, which is what stops the Host dialling
		 * ten devices for a panel nobody can see.
		 *
		 * @returns a disposer, or null when the service is unavailable.
		 */
		function registerSidebarTab(ctx) {
			const sidebar = ctx.betterSidebar;
			if (sidebar === undefined || sidebar === null) return null;
			if (typeof sidebar.registerTab !== "function") return null;
			const dispose = sidebar.registerTab({
				id: PANEL_ID,
				title: () => t("entry.label"),
				description: () => t("panel.subtitle"),
				icon: DevicePanelIcon,
				order: PANEL_ORDER,
				// A global view: one tab no matter how many devices are open.
				single: true,
				badge: () => {
					const count = store.snapshot.devices.reduce((total, device) => total + (device.alerts ?? []).length, 0);
					return count > 0 ? String(count) : undefined;
				},
				component: (props) => h(DevicePanel, { owner: "sidebar-tab", visible: props?.visible, narrow: true }),
			});
			return typeof dispose === "function" ? dispose : () => {};
		}
		//#endregion

		const inject = ["slots", "locale", "betterSidebar"];
		/**
		 * Client plugin body: dictionary registration plus the shell seats.
		 * Mount problems are logged, never thrown — an `apply` that throws
		 * fails the whole Web shell boot.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				try {
					const dispose = ctx.locale.register(NS, dictionaries);
					try {
						runtimeTranslate = ctx.locale.bind(NS);
					} catch {
						// keep the dictionary fallback
					}
					return typeof dispose === "function" ? dispose : () => {};
				} catch {
					return () => {};
				}
			}, "dsh-device-monitor: dictionaries");
			const disposers = [];
			ctx.effect(() => {
				try {
					const style = document.createElement("style");
					style.dataset.plugin = "@local/dsh-device-monitor";
					style.dataset.pluginCss = "@local/dsh-device-monitor/panel.css";
					style.textContent = CSS;
					document.head.appendChild(style);
					disposers.push(() => style.remove());
				} catch (error) {
					console.warn("[dsh-device-monitor] style registration failed:", error);
				}
				try {
					disposers.push(registerPanel(ctx));
				} catch (error) {
					console.warn("[dsh-device-monitor] panel registration failed:", error);
				}
				try {
					const disposeTab = registerSidebarTab(ctx);
					if (disposeTab !== null) disposers.push(disposeTab);
				} catch (error) {
					// better-sidebar is optional; losing the tab must not cost the
					// panel its two working seats.
					console.warn("[dsh-device-monitor] right-sidebar tab registration failed:", error);
				}
				return () => {
					for (const dispose of disposers.splice(0)) dispose();
				};
			}, "dsh-device-monitor: ui mounts");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
