/**
 * Polling orchestration for the dsh-device-monitor plugin.
 *
 * A poll is on-demand or lease-driven, never an unconditional always-on timer.
 *
 * The lease exists because neither extreme is acceptable. Polling only when the
 * user clicks gives no waveform — a chart with one point is a dot. Polling
 * always, from Host boot, would dial up to ten devices around the clock even
 * when nobody has opened the panel for a week, which on a battery-powered board
 * is a real cost and on a metered link is a real bill.
 *
 * So the browser takes a LEASE while the panel is open and renews it with each
 * heartbeat. The timer runs only while at least one lease is live, and stops
 * {@link LEASE_MULTIPLIER} intervals after the last renewal. The multiplier is
 * 2 rather than 1 so a single late heartbeat (a slow poll, a browser hiccup)
 * does not tear the timer down and immediately rebuild it.
 *
 * Concurrent requests for the same device share one in-flight poll, so a
 * double-click cannot open two SSH sessions to the same box.
 */
import { collect, test, connect, exec, dispose } from "./ssh.js";
import { evaluateAlerts, ringSizeFor } from "./metrics.js";
import { intervalMsOf, metricsOf } from "./store.js";
import { audit, recordIncident } from "./logs.js";
import { IncidentTracker } from "./incidents.js";

/** How many intervals a lease stays live without a renewal. */
export const LEASE_MULTIPLIER = 2;

/** Cap on how many devices are dialled at once. */
export const MAX_CONCURRENT = 4;

/** Orchestrates collection across the device roster. */
export class Monitor {
	/**
	 * @param store - the device roster.
	 * @param metrics - the rolling metric store.
	 */
	constructor(store, metrics, options = {}) {
		this.store = store;
		this.metrics = metrics;
		/**
		 * The dial. Injectable so a test can observe the DEVICE ROW the probe
		 * actually hands to ssh2 — the defect this covers was a blank password
		 * box reaching the wire, which no assertion on a pure helper can see.
		 */
		this.connect = options.connect ?? connect;
		/** @type {Map<string, Promise<object>>} */
		this.inflight = new Map();
		/** Live watch leases, keyed by an opaque client id. */
		this.leases = new Map();
		this.timer = null;
		this.timerIntervalMs = 0;
		/** Durable exception state, fed by every collection. */
		this.incidents = new IncidentTracker({ onRecord: (record) => recordIncident(record) });
	}

	// --- watch lease ---------------------------------------------------------

	/**
	 * Take or renew a watch lease.
	 * @param clientId - opaque id supplied by the browser.
	 * @param intervalSec - the cadence this client wants.
	 * @returns the current lease summary.
	 */
	watch(clientId, intervalSec) {
		const intervalMs = Math.max(5, Math.min(3600, Number(intervalSec) || 60)) * 1000;
		const now = Date.now();
		this.leases.set(clientId, { expiresAt: now + intervalMs * LEASE_MULTIPLIER, intervalMs, renewedAt: now });
		this.syncTimer();
		return this.watchStatus();
	}

	/** Drop one lease immediately (the panel closed). */
	unwatch(clientId) {
		this.leases.delete(clientId);
		this.syncTimer();
		return this.watchStatus();
	}

	/** Drop leases that have not been renewed in time. */
	pruneLeases(now = Date.now()) {
		for (const [id, lease] of this.leases) {
			if (lease.expiresAt <= now) this.leases.delete(id);
		}
	}

	/** The live watch state, including whether the timer is running. */
	watchStatus(now = Date.now()) {
		this.pruneLeases(now);
		let nextExpiry = null;
		let intervalMs = null;
		for (const lease of this.leases.values()) {
			if (nextExpiry === null || lease.expiresAt < nextExpiry) nextExpiry = lease.expiresAt;
			if (intervalMs === null || lease.intervalMs < intervalMs) intervalMs = lease.intervalMs;
		}
		return {
			active: this.leases.size > 0,
			clients: this.leases.size,
			intervalMs,
			expiresInMs: nextExpiry === null ? null : Math.max(0, nextExpiry - now),
			timerRunning: this.timer !== null,
		};
	}

	/**
	 * Start, restart or stop the poll timer to match the live leases.
	 *
	 * The timer is rebuilt (not merely left running) when the interval changes,
	 * because a shorter interval requested by a newly-opened panel must take
	 * effect now rather than at the end of the current, longer period.
	 */
	syncTimer() {
		this.pruneLeases();
		if (this.leases.size === 0) {
			this.stopTimer();
			return;
		}
		let intervalMs = null;
		for (const lease of this.leases.values()) {
			if (intervalMs === null || lease.intervalMs < intervalMs) intervalMs = lease.intervalMs;
		}
		if (this.timer !== null && this.timerIntervalMs === intervalMs) return;
		this.stopTimer();
		this.timerIntervalMs = intervalMs;
		this.timer = setInterval(() => {
			this.pruneLeases();
			if (this.leases.size === 0) {
				this.stopTimer();
				return;
			}
			// Fire and forget: a slow poll must not stack up behind the timer.
			void this.pollAll().catch((error) => {
				console.warn(`定时采集失败: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, intervalMs);
		// Do not hold the Host process open on account of a poll timer.
		if (typeof this.timer.unref === "function") this.timer.unref();
	}

	/** Stop the poll timer, if running. */
	stopTimer() {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.timerIntervalMs = 0;
	}

	// --- polling -------------------------------------------------------------

	/**
	 * Poll one device and fold the result into the metric store.
	 * @param id - device id.
	 * @returns the sample, or an object carrying `error` when the poll failed.
	 */
	async pollDevice(id) {
		const pending = this.inflight.get(id);
		if (pending !== undefined) return pending;
		const promise = this.runPoll(id).finally(() => {
			this.inflight.delete(id);
		});
		this.inflight.set(id, promise);
		return promise;
	}

	/** The effective interval for a device, in milliseconds. */
	deviceIntervalMs(device) {
		return intervalMsOf(device, this.store.settings().refreshIntervalSec);
	}

	/** The body of {@link pollDevice}, outside the in-flight dedupe. */
	async runPoll(id) {
		const device = this.store.find(id);
		if (device === undefined) {
			const error = new Error(`device not found: ${id}`);
			error.statusCode = 404;
			throw error;
		}
		const settings = this.store.settings();
		const metrics = metricsOf(device);
		const intervalMs = this.deviceIntervalMs(device);
		// A custom command bypasses the Agent tool command whitelist, so every
		// actual execution has to leave a trace. The audit entry names the
		// METRIC key only — never the command body, which can carry a credential
		// or a host address.
		const custom = settings.customCommands.enabled === true ? settings.customCommands.overrides : {};
		if (Object.keys(custom).length > 0) {
			const armed = Object.keys(custom).filter((key) => metrics === undefined || metrics.includes(key));
			if (armed.length > 0) audit("command.custom", { deviceId: id, deviceName: device.name, metrics: armed });
		}
		try {
			const { sample, diagnostics } = await collect(device, this.metrics.previous(id), metrics, {
				rawLog: settings.rawLog.enabled,
				customCommands: settings.customCommands,
			});
			this.metrics.apply(id, sample, diagnostics, ringSizeFor(intervalMs));
			const incident = this.incidents.observe(device, { ok: true, uptimeMs: sample.uptimeMs }, settings.incidents);
			const alerts = evaluateAlerts(sample, settings.thresholds, metrics);
			if (incident.rebooted) audit("device.reboot", { deviceId: id, deviceName: device.name });
			return { deviceId: id, ok: true, sample, alerts, incident };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.metrics.fail(id, message);
			const incident = this.incidents.observe(device, { ok: false, error: message }, settings.incidents);
			return { deviceId: id, ok: false, error: message, alerts: [], incident };
		}
	}

	/**
	 * Poll several devices, at most `concurrency` at a time.
	 * @param ids - device ids to poll.
	 * @returns one result per id, in the input order.
	 */
	async pollMany(ids, concurrency = MAX_CONCURRENT) {
		const results = [];
		let cursor = 0;
		const worker = async () => {
			while (cursor < ids.length) {
				const index = cursor;
				cursor += 1;
				results[index] = await this.pollDevice(ids[index]);
			}
		};
		const workers = [];
		for (let n = 0; n < Math.min(concurrency, ids.length); n += 1) workers.push(worker());
		await Promise.all(workers);
		return results;
	}

	/** Poll every device in the roster. */
	async pollAll() {
		return this.pollMany(this.store.list().map((device) => device.id));
	}

	/** Probe connectivity for one device without touching the metric history. */
	async testDevice(id) {
		const device = this.store.find(id);
		if (device === undefined) {
			const error = new Error(`device not found: ${id}`);
			error.statusCode = 404;
			throw error;
		}
		return test(device);
	}

	/**
	 * Probe a DRAFT device that is not in the roster yet.
	 *
	 * Three no-side-effect disciplines (DESIGN.md §10.2): no persistence, no
	 * broadcast, and NO AUDIT. It still needs a real connection, so the
	 * connection is closed in `finally` — a leaked ssh2 socket on every failed
	 * "test" click is the specific risk this function must not introduce.
	 *
	 * `withStoredSecret` reconciles a real asymmetry. SAVING an edit is a MERGE
	 * (`Store#update` spreads `{...current.auth, ...fields.auth}`), so leaving
	 * the password box blank keeps the stored password. Testing used to take the
	 * payload as-is REPLACEMENT, so the same blank box dialled with an empty
	 * password and failed with "All configured authentication methods failed" —
	 * a message that points at the credentials rather than at the form. The
	 * fallback below makes the probe agree with what saving would have done.
	 *
	 * Reading the roster is not a side effect; nothing is written or broadcast.
	 */
	async testDraft(payload) {
		const device = { id: "draft", name: payload?.name ?? "draft", ...withStoredSecret(payload, this.store), port: payload?.port ?? 22 };
		const started = Date.now();
		let conn;
		try {
			conn = await this.connect(device);
			const result = await exec(conn, "uname -a 2>/dev/null || echo unknown", 8000);
			return {
				ok: true,
				latencyMs: Date.now() - started,
				banner: (result.stdout ?? "").trim().split("\n")[0] ?? "",
			};
		} finally {
			if (conn) dispose(conn);
		}
	}

	/**
	 * Run an arbitrary command on one device (the `device_exec` tool path).
	 * Audited: this is the one route that runs user-supplied text remotely.
	 *
	 * The audit row records THAT a command ran and HOW LONG it was — never the
	 * text. This route is the only place in the plugin that puts text the user
	 * wrote on the wire, so it is also the only place where "record the values"
	 * would put a credential on disk: `mysql -p'…'` and
	 * `curl -H 'Authorization: …'` are ordinary things to type here. The
	 * terminal paid exactly this cost already and for exactly this reason (see
	 * README 的「已知取舍」), and `command.custom` records metric NAMES only.
	 * Dropping the body keeps the three consistent, and the length still answers
	 * the one forensic question that needs no text: a hand-typed one-liner
	 * versus a script.
	 *
	 * Note this is a SEPARATE concern from the command the CALLER keeps: the
	 * `device_exec` result still returns stdout/stderr, and the conversation
	 * transcript still holds what was asked. The audit log is simply not the
	 * place for a permanent plaintext copy of it.
	 *
	 * The dial goes through `this.connect`, NOT the module-level `connect`. That
	 * is not stylistic: a test that substitutes the dial to prevent a network
	 * call must substitute the dial this route actually uses, or it believes it
	 * blocked a call while a real socket is opened. That was observed here — a
	 * proof harness passed `connect: () => { throw }` and still reached the
	 * wire, because this line read the imported function.
	 */
	async execOn(id, command, timeoutMs) {
		const device = this.store.find(id);
		if (device === undefined) {
			const error = new Error(`device not found: ${id}`);
			error.statusCode = 404;
			throw error;
		}
		const commandText = typeof command === "string" ? command : "";
		audit("device.exec", { deviceId: id, deviceName: device.name, commandLength: commandText.length });
		let conn;
		try {
			conn = await this.connect(device);
			const result = await exec(conn, command, timeoutMs);
			return { ...result, success: result.error === undefined && result.code === 0 };
		} finally {
			if (conn) dispose(conn);
		}
	}

	/**
	 * The panel's read view: roster, per-device status, latest samples.
	 * @returns the overview payload served to the browser.
	 */
	overview() {
		const settings = this.store.settings();
		const devices = this.store.summaries();
		const now = Date.now();
		return {
			devices: devices.map((device) => {
				const status = this.metrics.status(device.id, settings.thresholds, metricsOf(device));
				const sample = this.metrics.latest(device.id);
				const incident = this.incidents.status(device.id);
				return {
					...device,
					collectedAt: status.collectedAt,
					error: status.error,
					alerts: sample === undefined ? [] : evaluateAlerts(sample, settings.thresholds, metricsOf(device)),
					sample: sample === undefined ? undefined : publicSample(sample),
					incident,
					intervalSec: Math.round(this.deviceIntervalMs(device) / 1000),
				};
			}),
			maxDevices: 10,
			settings: { refreshIntervalSec: settings.refreshIntervalSec, thresholds: settings.thresholds },
			watch: this.watchStatus(now),
		};
	}
}

/**
 * Fill an omitted credential back in from the stored device, so a draft probe
 * authenticates the way a save would have.
 *
 * Only a MISSING secret is filled. An explicitly supplied one — including an
 * empty string, which is how the form expresses "use no password" for a device
 * that genuinely has none — is passed through untouched.
 *
 * Lookup prefers the device `id` the form sent, because that is exactly what
 * `Store#update` merges against: saving an edit keeps the stored password no
 * matter which fields changed, so probing by id is the faithful preview. Only
 * when no id is sent (a brand-new device, whose form has no id) does it fall
 * back to matching host + port + username, which keeps the probe useful for a
 * hand-rolled API client that posts no id.
 *
 * @param payload - the raw draft body from the form.
 * @param store - the roster; undefined tolerated for callers with no roster.
 * @returns the payload with `auth` reconciled, or the payload unchanged.
 */
export function withStoredSecret(payload, store) {
	const auth = payload?.auth;
	if (auth === undefined || auth === null || typeof auth !== "object") return payload;
	if (auth.kind !== "password" || typeof auth.password === "string") return payload;
	if (typeof store?.find !== "function" || typeof store?.list !== "function") return payload;
	let match;
	const id = typeof payload.id === "string" ? payload.id.trim() : "";
	if (id !== "") match = store.find(id);
	if (match === undefined) {
		const host = String(payload.host ?? "").trim();
		const port = Number(payload.port ?? 22);
		const username = String(payload.username ?? "").trim();
		match = store.list().find(
			(row) => row.host === host && Number(row.port ?? 22) === port && row.username === username && row.auth?.kind === "password",
		);
	}
	if (match?.auth?.kind !== "password" || typeof match.auth.password !== "string") return payload;
	return { ...payload, auth: { ...auth, password: match.auth.password } };
}

/**
 * Strip the internal baselines from a sample before it goes over the wire:
 * `procStat` computes the next CPU delta, and `netRows`/`dioRows` are the
 * cumulative counter tables the next rate calculation subtracts. All three are
 * noise for the browser, and the counter tables alone are a few KB per device.
 */
export function publicSample(sample) {
	const { procStat: _procStat, netRows: _netRows, dioRows: _dioRows, ...rest } = sample;
	return rest;
}
