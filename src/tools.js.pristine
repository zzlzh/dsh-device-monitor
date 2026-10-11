/**
 * Agent-facing tools for the device-monitor plugin.
 *
 * These mirror the panel's capabilities so the model can answer questions
 * about the monitored fleet without the user opening the sidebar. They read
 * the same {@link DeviceStore} and {@link Monitor} the panel uses, so a device
 * added in the panel is immediately visible to the tools and vice versa.
 *
 * `defineTool` comes from the Host's own tool package; it is injected rather
 * than imported so this module keeps no opinion about how it was resolved.
 */
import { evaluateAlerts, numOrNull } from "./metrics.js";
import { readAudit, readIncidents } from "./logs.js";
import { metricsOf } from "./store.js";

/**
 * Human labels for the durable events, for the history tool.
 *
 * Deliberately a MAP rather than a chain of conditionals: an event kind the
 * table does not know must fall through to its raw name, not be silently
 * dropped. A new audit event should appear in the timeline the day it is
 * written, even before anyone adds a label for it.
 */
const EVENT_LABELS = {
	offline: "掉线",
	online: "恢复",
	reboot: "重启",
	"device.create": "登记设备",
	"device.update": "修改设备",
	"device.delete": "删除设备",
	"device.test": "测试连接",
	"device.exec": "远程执行",
	"command.custom": "自定义命令",
	"terminal.open": "打开终端",
	"terminal.close": "关闭终端",
	"terminal.denied": "终端被拒",
	"settings.update": "设置变更",
};

/** The most records a single history call will scan. See MAX_HISTORY_SCAN. */
const MAX_HISTORY_SCAN = 200;
/** The default number of timeline rows returned. */
const DEFAULT_HISTORY_LIMIT = 40;

/**
 * One text content block — the only render shape these tools emit.
 *
 * `defineTool` installs a wrapper that calls `output.render` on every call, so
 * a definition without one throws `userRender is not a function` the first
 * time the model uses the tool. Every tool below therefore supplies a render.
 */
function text(value) {
	return [{ type: "text", text: value }];
}

/**
 * Format one metric value for the model.
 *
 * Returns `未采集` for null rather than 0. A metric the user did not select, or
 * one the device could not report, is NOT a zero — and handing the model a
 * confident "温度: 0°C" for a device with no sensor is how a wrong answer gets
 * written into a summary. See DESIGN.md ADR 52.
 */
function metric(value, unit = "") {
	const n = numOrNull(value);
	return n === null ? "未采集" : `${n}${unit}`;
}

/** Render a sample as a compact, model-readable block. */
function renderSample(sample) {
	if (sample === undefined) return "（尚未采集）";
	const disks = (sample.disk ?? []).map((row) => `${row.mount} ${row.usagePercent}%`).join(", ") || "未采集";
	const thermal = (sample.thermal ?? []).map((row) => `${row.type} ${row.celsius}°C`).join(", ") || "未采集";
	const net = sample.net === null || sample.net === undefined ? "未采集" : `${sample.net.rxTotal ?? "?"} B/s 收 / ${sample.net.txTotal ?? "?"} B/s 发`;
	const diskio =
		sample.diskio === null || sample.diskio === undefined ? "未采集" : `${sample.diskio.rxTotal ?? "?"} B/s 读 / ${sample.diskio.txTotal ?? "?"} B/s 写`;
	const top = (sample.top ?? []).map((row) => `${row.user}/${row.pid} ${row.cpu}%`).join(", ") || "未采集";
	// Cores are a property of the BOX, so either collector that happened to read
	// them can answer: /proc/stat via the CPU metric, or the tally that rides
	// with /proc/loadavg. Reading only `cpu.cores` reported "? 核" for every
	// device whose CPU metric was switched off, even though the load collector
	// had counted the cores in the same round-trip.
	const cores = sample.cpu?.cores ?? sample.load?.cores ?? null;
	const loadText =
		sample.load === null || sample.load === undefined
			? "未采集"
			: `${sample.load.load1} / ${sample.load.load5} / ${sample.load.load15}${cores === null ? "" : `（${cores} 核，1 分钟占用 ${Math.round((sample.load.load1 / cores) * 100)}%）`}`;
	return [
		`主机型号: ${sample.model || "unknown"}`,
		`内核: ${sample.kernel || "unknown"}`,
		`运行时长: ${sample.uptimeText ?? "未采集"} (${cores ?? "?"} 核)`,
		`CPU: ${metric(sample.cpu?.percent, "%")}`,
		`内存: ${metric(sample.memory?.usagePercent, "%")} (${sample.memory?.usedMB ?? "?"}/${sample.memory?.totalMB ?? "?"} MB)`,
		`磁盘: ${disks}`,
		`负载: ${loadText}`,
		`温度: ${thermal}`,
		`进程数: ${metric(sample.processes)}`,
		`TCP 连接: ${metric(sample.tcp)}`,
		`网络: ${net}`,
		`磁盘 IO: ${diskio}`,
		`高占用进程: ${top}`,
		`服务: ${(sample.services ?? []).slice(0, 8).join(", ") || "n/a"}`,
	].join("\n");
}

/** One-line device label used by the list and status tools. */
function renderDevice(device, status) {
	const state = status?.error !== undefined && status.error !== null ? `不可达: ${status.error}` : status?.collectedAt !== undefined ? "正常" : "未采集";
	// The same three optional fields the card now draws. Kept as ONE trailing
	// column so a roster without them renders exactly as it did before, and a
	// roster with them never shifts the columns a reader is scanning.
	const extras = [];
	if (typeof device.location === "string" && device.location !== "") extras.push(device.location);
	if (Array.isArray(device.tags) && device.tags.length > 0) extras.push(device.tags.join("/"));
	if (typeof device.description === "string" && device.description !== "") extras.push(device.description);
	return `${device.id}\t${device.name}\t${device.username}@${device.host}:${device.port}\t${state}${extras.length === 0 ? "" : `\t${extras.join(" · ")}`}`;
}

/**
 * Build every tool this plugin registers.
 * @param defineTool - the Host's tool definition helper.
 * @param store - the device roster.
 * @param monitor - the polling orchestrator.
 * @param metrics - the rolling metric store.
 * @returns the tool definitions.
 */
export function makeTools(defineTool, store, monitor, metrics) {
	const listTool = defineTool({
		name: "device_list",
		description:
			"List the devices registered in the DSH device-monitor panel (id, name, user@host:port, last status). Use the id with the other device_* tools. Triggers: 设备, 设备列表, device, device list, 监控设备.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					devices: { type: "array", required: true, items: { type: "string" } },
					maxDevices: { type: "integer", required: true },
				},
			},
			render(_args, value) {
				const rows = value.devices ?? [];
				if (rows.length === 0) return text(`尚未登记设备（上限 ${value.maxDevices ?? 10} 台）。请在侧边栏「设备」面板中添加。`);
				return text([
					`已登记 ${rows.length}/${value.maxDevices ?? 10} 台设备：`,
					"id | 名称 | 连接 | 状态",
					"--- | --- | --- | ---",
					...rows,
				].join("\n"));
			},
		},
		async execute() {
			const settings = store.settings();
			const statuses = metrics.statuses(settings.thresholds);
			return {
				devices: store.summaries().map((device) => renderDevice(device, statuses[device.id])),
				maxDevices: 10,
			};
		},
	});

	const statusTool = defineTool({
		name: "device_status",
		description:
			"Show the latest collected metrics for one monitored device (CPU, memory, disk, load, temperature, uptime, services). Pass refresh=true to collect a fresh sample first. Triggers: 设备状态, 设备指标, device status, device metrics.",
		parameters: {
			id: { type: "string", required: true, description: "Device id from device_list." },
			refresh: { type: "boolean", description: "Collect a fresh sample before reporting (default false)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					found: { type: "boolean", required: true },
					summary: { type: "string", required: true },
					alerts: { type: "array", required: true, items: { type: "string" } },
				},
			},
			render(_args, value) {
				const alerts = value.alerts ?? [];
				const parts = [value.summary];
				if (alerts.length > 0) parts.push(`告警:\n${alerts.map((alert) => `- ${alert}`).join("\n")}`);
				return text(parts.join("\n"));
			},
		},
		async execute(args) {
			const device = store.find(args.id);
			if (device === undefined) return { found: false, summary: `未找到设备: ${args.id}`, alerts: [] };
			if (args.refresh === true) await monitor.pollDevice(device.id);
			const settings = store.settings();
			const selected = metricsOf(device);
			const status = metrics.status(device.id, settings.thresholds, selected);
			const sample = metrics.latest(device.id);
			const summary = sample === undefined ? [] : evaluateAlerts(sample, settings.thresholds, selected).map((alert) => alert.message);
			const incident = monitor.incidents.status(device.id);
			const incidentLine =
				incident.offline === true ? `\n异常: 连续 ${incident.fails} 次失败，已持续 ${incident.downSeconds}s` : "";
			return {
				found: true,
				summary: `${device.name} (${device.username}@${device.host})${status.error === undefined ? "" : `\n采集错误: ${status.error}`}${incidentLine}\n${renderSample(sample)}`,
				alerts: summary,
			};
		},
	});

	const collectTool = defineTool({
		name: "device_collect",
		description:
			"Collect a fresh metric sample over SSH from one device, or from every device when no id is given. Triggers: 采集设备, 刷新设备指标, collect device metrics, refresh device.",
		parameters: {
			id: { type: "string", description: "Device id; omit to poll every device." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					results: { type: "array", required: true, items: { type: "string" } },
				},
			},
			render(_args, value) {
				const rows = value.results ?? [];
				if (rows.length === 0) return text("没有需要采集的设备（尚未登记）。");
				return text(rows.join("\n"));
			},
		},
		async execute(args) {
			const results = args.id === undefined ? await monitor.pollAll() : [await monitor.pollDevice(args.id)];
			return {
				results: results.map((result) =>
					result.ok === true
						? `${result.deviceId}: CPU ${metric(result.sample?.cpu?.percent, "%")} / 内存 ${metric(result.sample?.memory?.usagePercent, "%")} / 磁盘 ${(result.sample?.disk ?? []).map((row) => `${row.mount} ${row.usagePercent}%`).join(", ") || "未采集"}`
						: `${result.deviceId}: 采集失败 - ${result.error}`,
				),
			};
		},
	});

	const execTool = defineTool({
		name: "device_exec",
		description:
			"Execute a shell command on a REMOTE monitored device over SSH. The command runs on the device, never on this machine — use the local bash tool for local commands. Triggers: 在设备上执行, 远程执行, run command on device.",
		parameters: {
			id: { type: "string", required: true, description: "Device id from device_list." },
			command: { type: "string", required: true, description: "Shell command to run on the device." },
			timeoutMs: { type: "integer", description: "Timeout in milliseconds (default 20000)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true },
					exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
					stdout: { type: "string", required: true },
					stderr: { type: "string", required: true },
					error: { type: "string" },
				},
			},
			/** Mirror the ssh_exec and bash exit-code convention. */
			render(_args, value) {
				const parts = [`[exit code: ${value.exitCode ?? "null"}]`];
				if ((value.stdout ?? "") !== "") parts.push(`stdout:\n${value.stdout}`);
				if ((value.stderr ?? "") !== "") parts.push(`stderr:\n${value.stderr}`);
				if (value.error !== undefined) parts.push(`error: ${value.error}`);
				return text(parts.join("\n"));
			},
		},
		async execute(args) {
			const device = store.find(args.id);
			if (device === undefined) return { success: false, exitCode: null, stdout: "", stderr: "", error: `未找到设备: ${args.id}` };
			try {
				const result = await monitor.execOn(args.id, args.command, args.timeoutMs ?? 20_000);
				return {
					success: result.success === true,
					exitCode: result.code,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					...(result.error === undefined ? {} : { error: result.error }),
				};
			} catch (error) {
				return { success: false, exitCode: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
			}
		},
	});

	const historyTool = defineTool({
		name: "device_history",
		description:
			"Show the durable event history for one monitored device (or the whole fleet): offline / recovery / reboot transitions and audited actions such as registration, settings changes and terminal use, newest first. Use this whenever the question is about what happened EARLIER — `device_status` can only ever describe this instant. Triggers: 设备历史, 异常记录, 什么时候掉线, 审计日志, device history, incidents, audit log.",
		parameters: {
			id: { type: "string", description: "Device id from device_list; omit for the whole fleet." },
			limit: { type: "integer", description: `Maximum rows to return (default ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_SCAN}).` },
			kind: { type: "string", description: "Filter by kind: all (default), incidents, or audit." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					events: { type: "array", required: true, items: { type: "string" } },
					count: { type: "integer", required: true },
					note: { type: "string" },
				},
			},
			render(_args, value) {
				const rows = value.events ?? [];
				if (rows.length === 0) return text(value.note ?? "没有历史记录。");
				const parts = [`最近 ${value.count} 条历史（新的在前）：`, ...rows];
				if (value.note !== undefined) parts.push(value.note);
				return text(parts.join("\n"));
			},
		},
		async execute(args) {
			const limit = Number.isFinite(Number(args.limit))
				? Math.max(1, Math.min(MAX_HISTORY_SCAN, Math.floor(Number(args.limit))))
				: DEFAULT_HISTORY_LIMIT;
			const kind = args.kind === "incidents" || args.kind === "audit" ? args.kind : "all";

			// Both logs are read at the scan cap rather than at `limit`: a device
			// filter is applied AFTER reading, so asking the log for only `limit`
			// rows would search just the newest handful and report an empty
			// history for a device that goes offline every night.
			const incidents = kind === "audit" ? [] : readIncidents(MAX_HISTORY_SCAN);
			const audits = kind === "incidents" ? [] : readAudit(MAX_HISTORY_SCAN);

			const keep = (row) => args.id === undefined || row?.deviceId === args.id;
			const rows = [
				...incidents.filter(keep).map((row) => ({ ...row, _kind: "incident" })),
				...audits.filter(keep).map((row) => ({ ...row, _kind: "audit" })),
			];
			// Both logs are appended chronologically, so `at` is a total order and
			// a plain sort is enough. Ties keep the incident first (stable sort).
			rows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

			const events = rows.slice(0, limit).map((row) => {
				const label = EVENT_LABELS[row.event] ?? row.event ?? "(未知事件)";
				const when = String(row.at ?? "").replace("T", " ").replace(/\.\d+Z$/, "Z");
				const detail = [];
				if (args.id === undefined && row.deviceId !== undefined) detail.push(row.deviceName ?? row.deviceId);
				if (typeof row.downSeconds === "number") detail.push(`已持续 ${row.downSeconds}s`);
				if (typeof row.fails === "number") detail.push(`连续 ${row.fails} 次失败`);
				if (typeof row.commandLength === "number") detail.push(`命令 ${row.commandLength} 字符`);
				if (Array.isArray(row.metrics) && row.metrics.length > 0) detail.push(row.metrics.join("/"));
				if (Array.isArray(row.changed) && row.changed.length > 0) detail.push(row.changed.join("/"));
				if (row.error !== undefined && row.error !== null) detail.push(String(row.error));
				return `${when} [${row._kind === "incident" ? "异常" : "审计"}] ${label}${detail.length === 0 ? "" : ` — ${detail.join(" · ")}`}`;
			});

			return {
				events,
				count: events.length,
				...(rows.length === 0
					? {
							note:
								args.id === undefined
									? "日志里还没有任何记录。异常记录只在探测到掉线/恢复/重启时写入，审计记录只在设备或设置被改动时写入。"
									: `设备 ${args.id} 没有历史记录。异常记录只在探测到掉线/恢复/重启时写入。`,
						}
					: {}),
			};
		},
	});

	return [listTool, statusTool, collectTool, execTool, historyTool];
}
