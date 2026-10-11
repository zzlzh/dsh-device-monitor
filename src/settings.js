/**
 * Global settings: refresh interval, alert thresholds, log switches, incident
 * tuning, and custom command overrides.
 *
 * Ported from the reference device-manager's `lib/settings.js` + `lib/alerts.js`
 * defaults. Two deliberate differences from that system:
 *
 *   Settings live in the SAME JSON document as the device roster
 *   (DESIGN.md §7.4/D13), not a separate `data/settings.json`. One atomic
 *   write means a settings change can never land while a device edit is
 *   half-written, and there is one file for the user to back up.
 *
 *   `refreshIntervalSec` has a per-DEVICE override (`device.intervalSec`).
 *   A NAS and a battery-powered sensor want very different cadences, and a
 *   single global value forces the user to pick the slower one for everything.
 */

/** Refresh interval bounds, matching the reference's `MIN/MAX_INTERVAL_SEC`. */
export const MIN_INTERVAL_SEC = 5;
export const MAX_INTERVAL_SEC = 3600;

/** Default poll cadence for this plugin, per the user's requirement. */
export const DEFAULT_REFRESH_INTERVAL_SEC = 60;

/** Alert thresholds. NOTE: these REPLACE the plugin's older hardcoded names. */
export const DEFAULT_THRESHOLDS = { cpu: 90, mem: 90, disk: 85, temp: 80 };

/** Only these four participate in threshold alerts; see DESIGN.md §5.7. */
export const THRESHOLD_KEYS = ["cpu", "mem", "disk", "temp"];

/** A fresh settings subtree. */
export function defaultSettings() {
	return {
		refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
		thresholds: { ...DEFAULT_THRESHOLDS },
		rawLog: { enabled: true },
		incidents: { offlineAfter: 2, rebootDetect: true, rebootMinDrop: 120 },
		customCommands: { enabled: false, overrides: {} },
		terminal: { enabled: false, allowedHosts: [], idleMs: DEFAULT_TERMINAL_IDLE_MS },
	};
}

/** Clamp an interval into the legal range, falling back when unusable. */
export function normalizeIntervalSec(value, fallback = DEFAULT_REFRESH_INTERVAL_SEC) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.round(n)));
}

/**
 * Clamp one threshold.
 *
 * `0` DISABLES that alert — it is a meaningful value, not an error, and it also
 * avoids a zero threshold firing on every single collection. The reference
 * documents the same semantics (`normalizeThresholds()`).
 *
 * `Number.isFinite` rather than a bare NaN check is load-bearing: `NaN >= limit`
 * is ALWAYS false, so a NaN threshold would silently stop that metric alerting
 * forever with no error anywhere. Rejecting NaN turns it into a visible default.
 */
export function normalizeThreshold(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.min(200, n));
}

/** Clamp the whole threshold set. */
export function normalizeThresholds(input) {
	const raw = typeof input === "object" && input !== null ? input : {};
	const out = {};
	for (const key of THRESHOLD_KEYS) out[key] = normalizeThreshold(raw[key], DEFAULT_THRESHOLDS[key]);
	return out;
}

/** A metric key's override body cap, matching the reference. */
export const CUSTOM_COMMAND_MAX = 2000;

/** Terminal idle timeout bounds. The floor matches the reference. */
export const MIN_TERMINAL_IDLE_MS = 30_000;
export const MAX_TERMINAL_IDLE_MS = 3_600_000;
export const DEFAULT_TERMINAL_IDLE_MS = 300_000;

/** Cap on the terminal source allowlist. */
export const TERMINAL_ALLOWED_HOSTS_MAX = 20;

/**
 * Normalize the interactive-terminal subtree.
 *
 * `enabled` accepts ONLY a real boolean `true`, for the same reason
 * {@link normalizeCustomCommands} does: this switch arms a full remote shell,
 * and a hand-edited `"true"` string must not be able to turn it on. The
 * default is OFF — the user turned it on deliberately in the panel.
 *
 * An EMPTY `allowedHosts` means "no host restriction". That is not a hole
 * here: the only way to reach this route at all is a loopback socket with a
 * loopback Host header (see `src/http.js`), so the list is a second lock on a
 * door that is already bolted to localhost. It matters for a deployment that
 * tunnels the Web port, which is exactly the case the list exists for.
 *
 * A hostname rule is KEPT as a hostname rather than resolved here: resolution
 * happens at connect time, so a rule naming a DHCP host follows the address
 * instead of freezing the one it had when the settings were saved.
 */
export function normalizeTerminal(input) {
	const raw = typeof input === "object" && input !== null ? input : {};
	const allowedHosts = [];
	if (Array.isArray(raw.allowedHosts)) {
		for (const rule of raw.allowedHosts) {
			if (typeof rule !== "string") continue;
			const trimmed = rule.trim();
			if (trimmed === "") continue;
			if (!allowedHosts.includes(trimmed)) allowedHosts.push(trimmed);
			if (allowedHosts.length >= TERMINAL_ALLOWED_HOSTS_MAX) break;
		}
	}
	return {
		enabled: raw.enabled === true,
		allowedHosts,
		idleMs: clampInt(raw.idleMs, DEFAULT_TERMINAL_IDLE_MS, MIN_TERMINAL_IDLE_MS, MAX_TERMINAL_IDLE_MS),
	};
}

/**
 * Normalize the custom-command subtree.
 *
 * Three rules, each guarding a specific failure:
 *   - `enabled` accepts ONLY a real boolean `true`. A hand-edited `"true"`
 *     string must not silently arm a path that bypasses the Agent tool command
 *     whitelist; a permanent backdoor from a typo is unacceptable.
 *   - `overrides` keys must be real metric keys, so a typo cannot sit dormant
 *     and then start executing when a key is added later.
 *   - An EMPTY object or `null` CLEARS every override. This is the opposite of
 *     the credential rule ("only non-empty overrides"), and deliberately so:
 *     clearing all overrides is a meaningful operation a user will want.
 */
export function normalizeCustomCommands(input, metricKeys) {
	const raw = typeof input === "object" && input !== null ? input : {};
	const enabled = raw.enabled === true;
	const overrides = {};
	if (raw.overrides === null || raw.overrides === undefined) {
		// clear
	} else if (typeof raw.overrides === "object") {
		for (const [key, value] of Object.entries(raw.overrides)) {
			if (!metricKeys.includes(key)) continue;
			if (typeof value !== "string") continue;
			const body = value.trim();
			if (body === "") continue;
			overrides[key] = body.slice(0, CUSTOM_COMMAND_MAX);
		}
	}
	return { enabled, overrides };
}

/** Normalize the raw-log switch. Unknown values fall back to ON. */
export function normalizeRawLog(input) {
	const raw = typeof input === "object" && input !== null ? input : {};
	return { enabled: raw.enabled === undefined ? true : raw.enabled === true };
}

/** Normalize the full settings subtree. */
export function normalizeSettings(input, metricKeys) {
	const raw = typeof input === "object" && input !== null ? input : {};
	return {
		refreshIntervalSec: normalizeIntervalSec(raw.refreshIntervalSec),
		thresholds: normalizeThresholds(raw.thresholds),
		rawLog: normalizeRawLog(raw.rawLog),
		incidents: {
			offlineAfter: clampInt(raw.incidents?.offlineAfter, 2, 1, 20),
			rebootDetect: raw.incidents?.rebootDetect === undefined ? true : raw.incidents.rebootDetect === true,
			rebootMinDrop: clampInt(raw.incidents?.rebootMinDrop, 120, 1, 3600),
		},
		customCommands: normalizeCustomCommands(raw.customCommands, metricKeys),
		terminal: normalizeTerminal(raw.terminal),
	};
}

function clampInt(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Apply a partial settings patch, returning both the merged settings and the
 * list of field names that actually changed.
 *
 * The changed list is what the audit log records — field NAMES only, never
 * values, because setting values may hold credentials (the reference's
 * `server.js:1132` makes the same choice).
 */
export function applySettingsPatch(current, patch, metricKeys) {
	const before = normalizeSettings(current, metricKeys);
	if (typeof patch !== "object" || patch === null) return { settings: before, changed: [] };
	const merged = {
		...before,
		...(patch.refreshIntervalSec === undefined ? {} : { refreshIntervalSec: patch.refreshIntervalSec }),
		...(patch.thresholds === undefined ? {} : { thresholds: { ...before.thresholds, ...patch.thresholds } }),
		...(patch.rawLog === undefined ? {} : { rawLog: { ...before.rawLog, ...patch.rawLog } }),
		...(patch.incidents === undefined ? {} : { incidents: { ...before.incidents, ...patch.incidents } }),
		...(patch.customCommands === undefined
			? {}
			: {
					customCommands: {
						enabled: patch.customCommands.enabled === undefined ? before.customCommands.enabled : patch.customCommands.enabled,
						overrides: patch.customCommands.overrides === undefined ? before.customCommands.overrides : patch.customCommands.overrides,
					},
				}),
		...(patch.terminal === undefined
			? {}
			: {
					terminal: {
						enabled: patch.terminal.enabled === undefined ? before.terminal.enabled : patch.terminal.enabled,
						allowedHosts: patch.terminal.allowedHosts === undefined ? before.terminal.allowedHosts : patch.terminal.allowedHosts,
						idleMs: patch.terminal.idleMs === undefined ? before.terminal.idleMs : patch.terminal.idleMs,
					},
				}),
	};
	const after = normalizeSettings(merged, metricKeys);
	const changed = [];
	if (after.refreshIntervalSec !== before.refreshIntervalSec) changed.push("refreshIntervalSec");
	for (const key of THRESHOLD_KEYS) {
		if (after.thresholds[key] !== before.thresholds[key]) changed.push(`thresholds.${key}`);
	}
	if (after.rawLog.enabled !== before.rawLog.enabled) changed.push("rawLog.enabled");
	for (const key of ["offlineAfter", "rebootDetect", "rebootMinDrop"]) {
		if (after.incidents[key] !== before.incidents[key]) changed.push(`incidents.${key}`);
	}
	if (after.customCommands.enabled !== before.customCommands.enabled) changed.push("customCommands.enabled");
	const beforeKeys = Object.keys(before.customCommands.overrides).sort();
	const afterKeys = Object.keys(after.customCommands.overrides).sort();
	if (beforeKeys.join(",") !== afterKeys.join(",")) changed.push("customCommands.overrides");
	if (after.terminal.enabled !== before.terminal.enabled) changed.push("terminal.enabled");
	if (after.terminal.allowedHosts.join(",") !== before.terminal.allowedHosts.join(",")) changed.push("terminal.allowedHosts");
	if (after.terminal.idleMs !== before.terminal.idleMs) changed.push("terminal.idleMs");
	return { settings: after, changed };
}
