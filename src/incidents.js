/**
 * The exception (incident) state machine.
 *
 * Ported from the reference device-manager's `lib/incidents.js`. Without it a
 * failure is a single transient `error` string that the very next successful
 * collection overwrites — so "this device has been unreachable since Tuesday"
 * is unknowable, and the panel looks identical whether a device blipped once
 * or has been dead for three days.
 *
 * Two rules carry the whole design:
 *
 *   Offline is N CONSECUTIVE failures, not the first one (default 2). One
 *   dropped packet during a Wi-Fi handover would otherwise raise an alert on
 *   a perfectly healthy device, and an alert that cries wolf is switched off
 *   by the user within a day.
 *
 *   The offline message is REFRESHED on every collection cycle, not only when
 *   the threshold is first crossed. Recording it once leaves the panel frozen
 *   at "2 次失败" while the device has actually failed 50 times, which reads as
 *   "recovery is imminent". The consequence is that firing an alert that
 *   ALREADY exists must only bump `count` and refresh `message` — it must never
 *   append another log line, or a device that is down overnight writes
 *   thousands of records and buries everything else.
 *
 * State is deliberately memory-only (DESIGN.md §6.3/D20): an incident is a
 * claim about right now. After a Host restart no device has ever been observed
 * failing, and starting every device at "already offline" would be a
 * fabricated history. The DURABLE record is the exception log, which
 * {@link IncidentTracker} writes through its `onRecord` callback.
 */

/** Defaults, matching the reference's `monitor` settings subtree. */
export const INCIDENT_DEFAULTS = {
	offlineAfter: 2,
	rebootDetect: true,
	rebootMinDrop: 120,
};

/**
 * Clamp a stored incident setting into a usable value.
 * `offlineAfter` outside 1..20 is clamped rather than rejected, because a
 * hand-edited config should not disable monitoring entirely.
 */
export function normalizeIncidentSettings(input) {
	const raw = typeof input === "object" && input !== null ? input : {};
	const int = (value, fallback, min, max) => {
		const n = Number(value);
		if (!Number.isFinite(n)) return fallback;
		return Math.max(min, Math.min(max, Math.round(n)));
	};
	return {
		offlineAfter: int(raw.offlineAfter, INCIDENT_DEFAULTS.offlineAfter, 1, 20),
		rebootDetect: raw.rebootDetect === undefined ? INCIDENT_DEFAULTS.rebootDetect : raw.rebootDetect === true,
		rebootMinDrop: int(raw.rebootMinDrop, INCIDENT_DEFAULTS.rebootMinDrop, 1, 3600),
	};
}

/** One device's live exception state. */
function emptyState() {
	return {
		fails: 0,
		downSince: null,
		offline: false,
		message: null,
		lastUptimeMs: null,
		lastSeenAt: null,
		lastRebootAt: null,
	};
}

/** Tracks offline / recovery / reboot transitions across devices. */
export class IncidentTracker {
	/**
	 * @param opts.onRecord - called with a durable exception record whenever a
	 *   state transition happens. Wrapped in try/catch: a logging failure must
	 *   not break monitoring.
	 * @param opts.now - injectable clock, for tests.
	 */
	constructor(opts = {}) {
		this.devices = new Map();
		this.onRecord = typeof opts.onRecord === "function" ? opts.onRecord : null;
		this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
	}

	/** The mutable state for one device, created on first use. */
	state(id) {
		let entry = this.devices.get(id);
		if (entry === undefined) {
			entry = emptyState();
			this.devices.set(id, entry);
		}
		return entry;
	}

	/** Emit a durable exception record. Never throws. */
	record(event, device, detail = {}) {
		if (this.onRecord === null) return;
		try {
			this.onRecord({ at: new Date(this.now()).toISOString(), event, deviceId: device?.id, deviceName: device?.name, ...detail });
		} catch (error) {
			console.warn(`写入异常记录失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Fold one collection result into the device's exception state.
	 *
	 * @param device - the device row (needs `id` and `name`).
	 * @param result.ok - whether the collection succeeded.
	 * @param result.error - the failure text, when it did not.
	 * @param result.uptimeMs - the reported uptime, when it succeeded.
	 * @returns `{offline, wentOffline, wentOnline, rebooted, fails, downSeconds}`
	 *   so the caller can attach the incident to the sample it is about to serve.
	 */
	observe(device, result, settingsInput) {
		const settings = normalizeIncidentSettings(settingsInput);
		const entry = this.state(device.id);
		const now = this.now();
		const out = { offline: entry.offline, wentOffline: false, wentOnline: false, rebooted: false, fails: entry.fails, downSeconds: null, message: entry.message };

		if (result?.ok !== true) {
			entry.fails += 1;
			if (entry.downSince === null) entry.downSince = now;
			out.fails = entry.fails;
			out.downSeconds = Math.round((now - entry.downSince) / 1000);

			if (entry.fails >= settings.offlineAfter) {
				const message = `设备连续 ${entry.fails} 次采集失败（${out.downSeconds}s）: ${result?.error ?? "unknown"}`;
				// The message is refreshed in memory on EVERY cycle so the panel
				// shows the current failure count rather than a frozen "2 次失败".
				entry.message = message;
				out.message = message;
				out.offline = true;
				if (!entry.offline) {
					entry.offline = true;
					out.wentOffline = true;
					this.record("offline", device, { fails: entry.fails, downSeconds: out.downSeconds, error: result?.error ?? null, message });
				}
				// An alert that already exists writes NOTHING. Appending a line per
				// cycle would bury every other exception within one night.
			}
			return out;
		}

		// --- success ----------------------------------------------------------
		const wasOffline = entry.offline;
		const downSeconds = entry.downSince === null ? null : Math.round((now - entry.downSince) / 1000);
		entry.fails = 0;
		entry.offline = false;
		entry.downSince = null;
		entry.lastSeenAt = now;
		// `out` was seeded from the state BEFORE this observation, so the reset
		// has to be mirrored onto it explicitly. Leaving these stale makes a
		// recovered device report `offline: true` with its old failure count on a
		// successful sample — the panel would show a green device as down.
		out.offline = false;
		out.fails = 0;
		out.message = null;

		if (wasOffline) {
			out.wentOnline = true;
			out.downSeconds = downSeconds;
			this.record("online", device, { downSeconds, message: "设备已恢复" });
		}

		const uptimeMs = typeof result.uptimeMs === "number" && Number.isFinite(result.uptimeMs) ? result.uptimeMs : null;
		if (uptimeMs !== null) {
			const previous = entry.lastUptimeMs;
			if (settings.rebootDetect && previous !== null) {
				const dropMs = previous - uptimeMs;
				// A drop larger than the floor means the counter went BACKWARDS,
				// which only happens if the device restarted. The floor exists
				// because /proc/uptime jitters by a few seconds between reads and
				// an off-by-one would report a reboot on every single poll.
				if (dropMs > settings.rebootMinDrop * 1000) {
					entry.lastRebootAt = now;
					out.rebooted = true;
					this.record("reboot", device, {
						previousUptimeMs: previous,
						uptimeMs,
						dropSeconds: Math.round(dropMs / 1000),
						message: `设备疑似重启，运行时长从 ${Math.round(previous / 1000)}s 降到 ${Math.round(uptimeMs / 1000)}s`,
					});
				}
			}
			entry.lastUptimeMs = uptimeMs;
		}
		return out;
	}

	/** The live exception view for one device. */
	status(id) {
		const entry = this.devices.get(id);
		if (entry === undefined) return { offline: false, fails: 0, message: null, downSince: null, downSeconds: null, lastSeenAt: null, lastRebootAt: null };
		return {
			offline: entry.offline,
			fails: entry.fails,
			message: entry.message,
			downSince: entry.downSince === null ? null : new Date(entry.downSince).toISOString(),
			downSeconds: entry.downSince === null ? null : Math.round((this.now() - entry.downSince) / 1000),
			lastSeenAt: entry.lastSeenAt === null ? null : new Date(entry.lastSeenAt).toISOString(),
			lastRebootAt: entry.lastRebootAt === null ? null : new Date(entry.lastRebootAt).toISOString(),
		};
	}

	/** Forget a device (used when it is removed from the roster). */
	forget(id) {
		this.devices.delete(id);
	}
}
