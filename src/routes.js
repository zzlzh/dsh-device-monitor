/**
 * The `/api/dsh-device-monitor` route family.
 *
 * Every route is loopback-only: these endpoints run commands on remote hosts
 * and accept device credentials, so a Harness Web deployment exposed to a LAN
 * must not serve them. The check lives in {@link isLoopbackRequest} and runs
 * before any handler body.
 */
import { MAX_DEVICES, metricsOf } from "./store.js";
import { evaluateAlerts, RING_MAX } from "./metrics.js";
import { METRIC_KEYS, metricCatalog } from "./metrics-keys.js";
import { readAudit, readIncidents, audit } from "./logs.js";
import { deviceLogBytes, readRawLines, removeDeviceLog, renameDeviceLog, rawLogDir } from "./raw-log.js";
import {
	errorBody,
	isLoopbackRequest,
	queryParam,
	readJsonBody,
	statusOf,
	writeJson,
} from "./http.js";
import { publicSample } from "./monitor.js";
import { MAX_SESSIONS_PER_DEVICE, MAX_SESSIONS_TOTAL } from "./terminal.js";

/** Base path of the device-monitor API. */
export const API_BASE = "/api/dsh-device-monitor";

/** The named routes, used by both halves. */
export const API = {
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
	terminal: `${API_BASE}/terminal/status`,
	rawlog: `${API_BASE}/rawlog`,
	incidents: `${API_BASE}/incidents`,
	logs: `${API_BASE}/logs/status`,
	audit: `${API_BASE}/audit`,
};

/** Guard a route: loopback only, and only the listed methods. */
function guard(req, res, methods) {
	if (!isLoopbackRequest(req)) {
		writeJson(res, 403, { error: "forbidden: loopback-only" });
		return false;
	}
	const method = req.method ?? "GET";
	if (!methods.includes(method)) {
		writeJson(res, 405, { error: `method not allowed: ${method}` });
		return false;
	}
	return true;
}

/** Resolve the `id` query parameter, or answer 400. */
function requireId(url, res) {
	const id = queryParam(url, "id");
	if (id === undefined) {
		writeJson(res, 400, { error: "id query parameter is required" });
		return undefined;
	}
	return id;
}

/**
 * Clamp a `limit` query parameter.
 *
 * Clamping is mandatory on the log-reading routes, not cosmetic:
 * `readRawLines` reads whole files before slicing, so an unclamped
 * `?limit=999999999` would pull the entire 20 MB rotation into memory.
 */
function clampLimit(url, fallback, max) {
	const raw = queryParam(url, "limit");
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1, Math.min(max, Math.round(n)));
}

/**
 * Build the `/api/dsh-device-monitor` route table.
 *
 * @param store - the device roster.
 * @param metrics - the metric ring store.
 * @param monitor - the poller/executor.
 * @param terminal - optional terminal manager. When absent the status route
 *   reports the feature as unavailable rather than 404-ing, so the panel can
 *   tell "this build has no terminal" apart from "the route is missing".
 */
export function makeRoutes(store, metrics, monitor, terminal) {
	const listHandler = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		if (method === "GET") {
			writeJson(res, 200, { devices: store.summaries(), maxDevices: MAX_DEVICES });
			return;
		}
		if (method === "POST") {
			const body = await readJsonBody(req);
			if (body === null) {
				writeJson(res, 400, { error: "invalid JSON body" });
				return;
			}
			try {
				const device = store.create(body);
				audit("device.create", { deviceId: device.id, deviceName: device.name, host: device.host, port: device.port });
				writeJson(res, 201, { device: store.summaries().find((row) => row.id === device.id) });
			} catch (error) {
				writeJson(res, statusOf(error, 400), errorBody(error));
			}
			return;
		}
		const id = requireId(url, res);
		if (id === undefined) return;
		if (method === "PATCH") {
			const body = await readJsonBody(req);
			if (body === null) {
				writeJson(res, 400, { error: "invalid JSON body" });
				return;
			}
			const before = store.find(id);
			try {
				const next = store.update(id, body);
				audit("device.update", {
					deviceId: id,
					deviceName: next.name,
					// Field NAMES only. A patch body may carry a credential.
					fields: Object.keys(body).filter((key) => key !== "password"),
				});
				// A rename must follow into the log directory, or the next append
				// recreates the old file and one device ends up with two logs.
				if (before !== undefined && before.name !== next.name) {
					renameDeviceLog(before, next);
				}
				writeJson(res, 200, { device: store.summaries().find((row) => row.id === id) });
			} catch (error) {
				writeJson(res, statusOf(error, 400), errorBody(error));
			}
			return;
		}
		try {
			const removed = store.delete(id);
			metrics.forget(id);
			monitor.incidents.forget(id);
			removeDeviceLog(removed);
			audit("device.delete", { deviceId: id, deviceName: removed?.name });
			writeJson(res, 200, { ok: true });
		} catch (error) {
			writeJson(res, statusOf(error, 400), errorBody(error));
		}
	};

	const overviewHandler = (req, res) => {
		writeJson(res, 200, monitor.overview());
	};

	const testHandler = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const id = requireId(url, res);
		if (id === undefined) return;
		try {
			const result = await monitor.testDevice(id);
			audit("device.test", { deviceId: id, ok: result.ok === true });
			writeJson(res, 200, { result });
		} catch (error) {
			writeJson(res, statusOf(error, 400), errorBody(error));
		}
	};

	/**
	 * Test a DRAFT device from the form.
	 * No persistence, no audit, and the connection is always disposed — see
	 * `Monitor#testDraft`. Returns 400 on failure to match `/test`.
	 */
	const testDraftHandler = async (req, res) => {
		const body = await readJsonBody(req);
		if (body === null) {
			writeJson(res, 400, { error: "invalid JSON body" });
			return;
		}
		try {
			const result = await monitor.testDraft(body);
			writeJson(res, 200, { result });
		} catch (error) {
			writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};

	const collectHandler = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const id = queryParam(url, "id");
		try {
			if (id === undefined) {
				writeJson(res, 200, { results: await monitor.pollAll() });
				return;
			}
			writeJson(res, 200, { results: [await monitor.pollDevice(id)] });
		} catch (error) {
			writeJson(res, statusOf(error, 400), errorBody(error));
		}
	};

	const metricsHandler = (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const id = requireId(url, res);
		if (id === undefined) return;
		const device = store.find(id);
		if (device === undefined) {
			writeJson(res, 404, { error: `device not found: ${id}` });
			return;
		}
		const settings = store.settings();
		const selected = metricsOf(device);
		// The limit window widened with the ring: at a 5 s interval the ring holds
		// 4320 points, so a 240 cap would silently truncate the chart to the last
		// 20 minutes and make the earlier history look like it was never collected.
		const limit = clampLimit(url, 240, RING_MAX);
		const sample = metrics.latest(id);
		writeJson(res, 200, {
			series: metrics.series(id, limit),
			sample: sample === undefined ? undefined : publicSample(sample),
			alerts: sample === undefined ? [] : evaluateAlerts(sample, settings.thresholds, selected),
			...metrics.status(id, settings.thresholds, selected),
		});
	};

	const settingsHandler = async (req, res) => {
		const method = req.method ?? "GET";
		if (method === "GET") {
			writeJson(res, 200, { settings: store.settings(), catalog: metricCatalog() });
			return;
		}
		const body = await readJsonBody(req);
		if (body === null) {
			writeJson(res, 400, { error: "invalid JSON body" });
			return;
		}
		try {
			const { settings, changed } = store.updateSettings(body);
			if (changed.length > 0) {
				// Field NAMES only; setting VALUES may hold credentials.
				audit("settings.update", { fields: changed });
			}
			writeJson(res, 200, { ok: true, changed, settings, catalog: metricCatalog() });
		} catch (error) {
			writeJson(res, statusOf(error, 400), errorBody(error));
		}
	};

	/** The metric vocabulary, served by the Host so the client never hardcodes it. */
	const catalogHandler = (req, res) => {
		writeJson(res, 200, { catalog: metricCatalog(), maxDevices: MAX_DEVICES, metricKeys: METRIC_KEYS });
	};

	const watchHandler = async (req, res) => {
		const body = await readJsonBody(req);
		if (body === null) {
			writeJson(res, 400, { error: "invalid JSON body" });
			return;
		}
		const clientId = typeof body.clientId === "string" && body.clientId !== "" ? body.clientId : "default";
		if (body.release === true) {
			writeJson(res, 200, { watch: monitor.unwatch(clientId) });
			return;
		}
		writeJson(res, 200, { watch: monitor.watch(clientId, body.intervalSec) });
	};

	const rawlogHandler = (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const id = requireId(url, res);
		if (id === undefined) return;
		const device = store.find(id);
		if (device === undefined) {
			writeJson(res, 404, { error: `device not found: ${id}` });
			return;
		}
		const limit = clampLimit(url, 200, 2000);
		writeJson(res, 200, {
			deviceId: id,
			dir: rawLogDir(),
			bytes: deviceLogBytes(device),
			lines: readRawLines(device, limit),
		});
	};

	const incidentsHandler = (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const limit = clampLimit(url, 100, 1000);
		writeJson(res, 200, { incidents: readIncidents(limit) });
	};

	const auditHandler = (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const limit = clampLimit(url, 100, 1000);
		writeJson(res, 200, { audit: readAudit(limit) });
	};

	const logsHandler = (req, res) => {
		const settings = store.settings();
		const devices = store.list().map((device) => ({
			id: device.id,
			name: device.name,
			bytes: deviceLogBytes(device),
		}));
		writeJson(res, 200, {
			dir: rawLogDir(),
			enabled: settings.rawLog.enabled,
			totalBytes: devices.reduce((sum, row) => sum + row.bytes, 0),
			devices,
		});
	};

	/**
	 * Report the terminal's state.
	 *
	 * Read-only and carries no secret: the allowlist itself is not echoed back
	 * (it is the one part of the terminal config that describes who may reach
	 * this Host), only its size. `available: false` means the manager was never
	 * wired up, which the panel words differently from "switched off", because
	 * the two need different fixes.
	 */
	const terminalStatusHandler = (req, res) => {
		if (terminal === undefined) {
			writeJson(res, 200, { available: false, enabled: false, path: API_BASE + "/terminal", sessions: [], count: 0, maxTotal: 0, maxPerDevice: 0 });
			return;
		}
		const config = terminal.config();
		writeJson(res, 200, {
			available: true,
			enabled: config.enabled,
			path: API_BASE + "/terminal",
			sessions: terminal.list(),
			count: terminal.count,
			maxTotal: MAX_SESSIONS_TOTAL,
			maxPerDevice: MAX_SESSIONS_PER_DEVICE,
			allowedHosts: config.allowedHosts.length,
			idleMs: config.idleMs,
		});
	};

	const execHandler = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const id = requireId(url, res);
		if (id === undefined) return;
		const body = await readJsonBody(req);
		const command = typeof body?.command === "string" ? body.command.trim() : "";
		if (command === "") {
			writeJson(res, 400, { error: "command is required" });
			return;
		}
		const device = store.find(id);
		if (device === undefined) {
			writeJson(res, 404, { error: `device not found: ${id}` });
			return;
		}
		const timeoutMs = Math.max(1_000, Math.min(120_000, Number(body?.timeoutMs) || 20_000));
		try {
			writeJson(res, 200, { result: await monitor.execOn(id, command, timeoutMs) });
		} catch (error) {
			writeJson(res, 200, {
				result: { stdout: "", stderr: "", code: null, durationMs: 0, timedOut: false, success: false, error: error instanceof Error ? error.message : String(error) },
			});
		}
	};

	return [
		{ kind: "exact", path: API.overview, handler: (req, res) => guard(req, res, ["GET"]) && overviewHandler(req, res) },
		{ kind: "exact", path: API.devices, handler: (req, res) => guard(req, res, ["GET", "POST", "PATCH", "DELETE"]) && listHandler(req, res) },
		{ kind: "exact", path: API.test, handler: (req, res) => guard(req, res, ["POST"]) && testHandler(req, res) },
		{ kind: "exact", path: API.testDraft, handler: (req, res) => guard(req, res, ["POST"]) && testDraftHandler(req, res) },
		{ kind: "exact", path: API.collect, handler: (req, res) => guard(req, res, ["POST"]) && collectHandler(req, res) },
		{ kind: "exact", path: API.metrics, handler: (req, res) => guard(req, res, ["GET"]) && metricsHandler(req, res) },
		{ kind: "exact", path: API.exec, handler: (req, res) => guard(req, res, ["POST"]) && execHandler(req, res) },
		{ kind: "exact", path: API.settings, handler: (req, res) => guard(req, res, ["GET", "PATCH"]) && settingsHandler(req, res) },
		{ kind: "exact", path: API.catalog, handler: (req, res) => guard(req, res, ["GET"]) && catalogHandler(req, res) },
		{ kind: "exact", path: API.watch, handler: (req, res) => guard(req, res, ["POST"]) && watchHandler(req, res) },
		{ kind: "exact", path: API.rawlog, handler: (req, res) => guard(req, res, ["GET"]) && rawlogHandler(req, res) },
		{ kind: "exact", path: API.incidents, handler: (req, res) => guard(req, res, ["GET"]) && incidentsHandler(req, res) },
		{ kind: "exact", path: API.audit, handler: (req, res) => guard(req, res, ["GET"]) && auditHandler(req, res) },
		{ kind: "exact", path: API.logs, handler: (req, res) => guard(req, res, ["GET"]) && logsHandler(req, res) },
		{ kind: "exact", path: API.terminal, handler: (req, res) => guard(req, res, ["GET"]) && terminalStatusHandler(req, res) },
	];
}
