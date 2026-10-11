/**
 * Host half of the DSH device-monitor plugin.
 *
 * Modeled on the `device-manager` device-supervision system that lives beside
 * this package: a roster of embedded/host devices, spoken to over SSH, whose
 * CPU / memory / disk / load / temperature / process / service state is
 * collected with busybox-compatible commands and shown in a live panel.
 *
 * The differences from that system are deliberate. It ran as a standalone
 * Express server with its own WebSocket hub and SPA; inside the Harness this
 * is a plugin, so the Host process supplies the HTTP server
 * (`ctx.webServer`), the tool registry (`ctx.tools`) and the system-prompt
 * band (`ctx.systemPrompt`), and the browser half is a Client module rather
 * than a bundled frontend.
 *
 * Collection is on demand AND on a lease. The browser half renews a watch
 * lease while a device panel is actually visible, and only then does the Host
 * poll on the configured interval (60 s by default). With no visible panel the
 * lease expires within two intervals and every socket goes quiet again, so an
 * idle Harness still dials no device. Metric history is in-memory (a ring per
 * device sized from the interval); the raw collected data and the exception
 * records are the only things written to disk, under
 * `$DSH_HOME/dsh-device-monitor-logs`.
 *
 * The device cap is {@link MAX_DEVICES} (10), enforced by the store.
 */
import { DeviceStore, MAX_DEVICES, storePath } from "./src/store.js";
import { MetricsStore, evaluateAlerts } from "./src/metrics.js";
import { Monitor } from "./src/monitor.js";
import { makeRoutes } from "./src/routes.js";
import { makeTerminal } from "./src/terminal-route.js";
import { makeTools } from "./src/tools.js";
import { softImport } from "./src/resolve.js";

/** Stable cordis plugin name. */
export const name = "device-monitor";

/** Services this plugin needs before it can mount. */
export const inject = ["webServer", "tools", "systemPrompt"];

/** How this plugin wants the model to think about devices. */
const DEVICE_GUIDANCE = [
	"本机已安装 dsh-device-monitor 插件（DSH 设备监管）：侧边栏「设备」入口，最多登记 10 台设备。",
	"设备配置存于 $DSH_HOME/dsh-device-monitor.json（默认 ~/.dsh），密码/密钥路径以明文保存在该用户私有文件中，权限 0600，不会写入日志，也不会传给浏览器。",
	"能力：设备列表与增删改；通过 SSH 连接设备并采集 CPU / 内存 / 磁盘 / 负载 / 温度 / 进程数 / 服务 / 运行时长；采集命令全部兼容 busybox（/proc、/sys、df -P -k、mount、systemctl），缺失的项目自动降级为空值；阈值告警（默认 CPU 90%、内存 90%、磁盘 85%、温度 80°C，可在面板「设置」中逐项调整，设为 0 即关闭该项告警）。",
	"采集只在浏览器面板可见时进行：面板每 60 秒（默认，可配置 5–3600 秒）续一次租约，若无可见面板则租约在 2 个周期内过期、停止一切拨号。可在面板「设置」中按设备覆盖刷新周期，并勾选要显示/采集的指标——未勾选的指标不会下发任何采集命令。",
	"采集到的原始数据（逐设备原文）与异常记录（离线 / 恢复 / 重启）写在 $DSH_HOME/dsh-device-monitor-logs 下；原始日志按设计不做脱敏，可在面板「日志」页查看，也可在「设置」中关闭。",
	// `device_history` is listed here deliberately: the guidance is
	// machine-checked against the tool roster, so a tool the prompt forgets to
	// mention is a capability the model will not know it has.
	"工具：device_list 列出设备、device_status 查看最新指标（refresh=true 先采集）、device_collect 采集一台或全部设备、device_exec 在某台设备上执行 shell 命令、device_history 查看某台设备（或全部设备）的历史事件。",
	// The model needs to be told which of its two windows is the right one for
	// a question about the past: `device_status` structurally cannot answer it,
	// and a model that does not know `device_history` exists will answer "this
	// instant" to a question about last night.
	"回答「这台设备昨晚稳定吗 / 什么时候掉的线 / 最近改了什么」这类关于**过去**的问题时用 device_history——device_status 只能描述此刻；device_history 合并异常记录（掉线 / 恢复 / 重启）与审计记录（设备增删改、设置变更、远程执行、终端使用），可按设备 id 与时间倒序查看。",
	"面板上每台设备还有一个「终端调试」按钮，在右下角开一个交互式 shell 浮层：默认关闭，须先在「设置」里打开；它不受上面这些 Agent 工具的命令白名单约束，输入会原样发到设备上，所以提醒用户自行确认命令内容。",
	"路径区分：本机（dsh host）上的文件与命令一律用本地工具（read / write / edit / pwsh）；device_exec 只在远程设备上执行。",
	"限制：设备增删改由用户在侧边栏面板中完成；采集与执行会真实占用远程设备资源，执行非只读命令前先确认。",
	"用户提到「设备 / 设备列表 / 设备监控 / 采集设备指标 / 在设备上执行」时即指本插件，请据此协作。",
].join("\n");

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152;

/**
 * This plugin exports no `Config` schema: every setting it has is either
 * derived from the roster file or fixed (the 10-device cap), so there is
 * nothing for a settings form to edit. The `config` argument is therefore
 * always undefined and {@link readConfig} falls back to its defaults.
 */

/** Mount the device roster, routes, and tools. */
export function apply(ctx, config) {
	const store = new DeviceStore();
	const metrics = new MetricsStore();
	const monitor = new Monitor(store, metrics);

	/** Live view of the resolved config, following the volatile references. */
	const readConfig = () => {
		const read = (field, fallback) => {
			if (field === undefined) return fallback;
			if (typeof field === "object" && field !== null && typeof field.get === "function") {
				const value = field.get();
				return value === undefined ? fallback : value;
			}
			return field;
		};
		return {
			enabled: read(config?.enabled, true) !== false,
			announceToAgent: read(config?.announceToAgent, true) !== false,
		};
	};

	/**
	 * The interactive-terminal manager and its upgrade route.
	 *
	 * Built once at mount rather than per `sync()` so a settings change cannot
	 * strand a live session: the manager is what owns open shells, and
	 * rebuilding it on every volatile update would drop the only references to
	 * them while the connections stayed up on the devices.
	 *
	 * Settings are read through a live closure, so flipping the switch in the
	 * panel takes effect on the next open rather than at the next restart.
	 */
	const terminal = makeTerminal(store, {
		getSettings: () => store.settings().terminal,
		logger: ctx.logger,
	});

	const routes = makeRoutes(store, metrics, monitor, terminal.manager);
	const toolDefinitions = [];
	const defineTool = async () => {
		if (toolDefinitions.length > 0) return toolDefinitions;
		const toolsModule = await softImport("@deepseek-ai/dsh-tools");
		if (toolsModule?.defineTool === undefined) {
			ctx.logger?.warn?.("[dsh-device-monitor] @deepseek-ai/dsh-tools is unavailable; agent tools are disabled");
			return toolDefinitions;
		}
		toolDefinitions.push(...makeTools(toolsModule.defineTool, store, monitor, metrics));
		return toolDefinitions;
	};

	let disposeSection;
	let disposeRoutes;
	let disposeTools;
	let disposeTerminal;

	const disposeAll = () => {
		if (disposeSection !== undefined) {
			disposeSection();
			disposeSection = undefined;
		}
		if (disposeRoutes !== undefined) {
			disposeRoutes();
			disposeRoutes = undefined;
		}
		if (disposeTools !== undefined) {
			disposeTools();
			disposeTools = undefined;
		}
		if (disposeTerminal !== undefined) {
			disposeTerminal();
			disposeTerminal = undefined;
			// The upgrade route is gone, so no new session can open; close the
			// ones that are already open rather than leaving live shells on the
			// devices with no way left to reach or close them.
			terminal.manager.closeAll("插件已停用");
		}
	};

	const sync = () => {
		disposeAll();
		const value = readConfig();
		if (!value.enabled) return;
		if (value.announceToAgent) {
			disposeSection = ctx.systemPrompt?.section?.({
				name: "plugin:dsh-device-monitor",
				order: SECTION_ORDER,
				text: DEVICE_GUIDANCE,
			});
		}
		disposeRoutes = ctx.effect(() => {
			const disposers = routes.map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-device-monitor: routes");
		disposeTools = ctx.effect(() => {
			let cancelled = false;
			const disposers = [];
			void defineTool().then((definitions) => {
				if (cancelled) return;
				for (const tool of definitions) disposers.push(ctx.tools.register(tool));
			});
			return () => {
				cancelled = true;
				for (const dispose of disposers.splice(0)) dispose();
			};
		}, "dsh-device-monitor: tools");
		disposeTerminal = ctx.effect(() => {
			// `registerUpgrade` is newer than the rest of the host API. An older
			// Host simply has no upgrade registry, in which case the terminal is
			// unavailable rather than fatal — every other feature still works.
			if (typeof ctx.webServer?.registerUpgrade !== "function") {
				ctx.logger?.warn?.("[dsh-device-monitor] webServer.registerUpgrade is unavailable; the terminal is disabled");
				return () => {};
			}
			return ctx.webServer.registerUpgrade(terminal.route);
		}, "dsh-device-monitor: terminal");
	};

	ctx.on("loader/volatile-update", () => {
		sync();
	});
	sync();
}

export { DEVICE_GUIDANCE, MAX_DEVICES, SECTION_ORDER, storePath, evaluateAlerts };

