/**
 * Rolling metric history for the dsh-device-monitor plugin.
 *
 * History is deliberately in-memory: it is a live view of the last few hours,
 * not a time-series database. The reference device-manager system persists
 * samples to disk, but inside the Host process that would mean unbounded writes
 * for a view the browser only ever reads while the panel is open.
 *
 * The store also owns the previous-sample baseline each device needs: CPU
 * percentage is a delta between two `/proc/stat` readings, and the net/diskio
 * rates are deltas between two counter tables, so none of them can be derived
 * from a single sample.
 */
import { DEFAULT_METRIC_COLUMNS } from "./series.js";

/**
 * Ring sizing, ported from the reference's `lib/history.js`.
 *
 * The ring is sized from the POLL INTERVAL so that every device retains
 * roughly the same TIME WINDOW regardless of cadence: a device polled every
 * 5 s would otherwise hold only 20 minutes, while one polled every 10 minutes
 * would hold the same 240 points spanning 40 hours. Retention itself is NOT
 * configurable — it is derived, and the user has no business tuning it.
 */
export const RING_TARGET_MS = 3 * 3600 * 1000;
export const RING_MIN = 240;
export const RING_MAX = 4320;

/**
 * How many samples to retain at a given interval.
 *
 * An unknown or absurd interval yields `RING_MAX` rather than `RING_MIN`:
 * giving back too little data presents as "the collection is broken", which
 * sends the user hunting a monitoring fault that does not exist.
 */
export function ringSizeFor(intervalMs) {
	const n = Number(intervalMs);
	if (!Number.isFinite(n) || n <= 0) return RING_MAX;
	return Math.max(RING_MIN, Math.min(RING_MAX, Math.ceil(RING_TARGET_MS / n)));
}

/**
 * Alert thresholds, mirroring the reference system's defaults.
 *
 * These are DEFAULTS ONLY: the live values come from settings and are passed
 * into {@link evaluateAlerts} by the caller, so a user edit takes effect on the
 * next collection without restarting the Host.
 *
 * A threshold of `0` DISABLES that alert (a `>= 0` comparison on a percentage
 * would otherwise fire on every single sample).
 */
export const THRESHOLDS = {
	cpu: 90,
	mem: 90,
	disk: 85,
	temp: 80,
};

/**
 * Evaluate a sample against the thresholds.
 *
 * Each alert carries structured fields so the client can render the message in
 * its own locale. Only cpu/mem/disk/temp participate: net/diskio/procs/tcp are
 * collected, displayed and charted, but they have no threshold, because the
 * alert engine is built on a 0-100 percentage assumption and rate metrics need
 * that decoupled first (the reference reached the same conclusion).
 *
 * @param sample - one aggregated sample.
 * @param thresholds - `{cpu, mem, disk, temp}`; each `0` disables that alert.
 * @param metrics - the device's selected keys, or `undefined` for all. A metric
 *   the user did not select must NOT raise an alert: alerting on something the
 *   user switched off is how alerts get ignored.
 */
export function evaluateAlerts(sample, thresholds = THRESHOLDS, metrics) {
	const alerts = [];
	if (sample === undefined || sample === null) return alerts;
	const wanted = metrics === undefined || metrics === null ? null : new Set(metrics);
	const on = (key) => wanted === null || wanted.has(key);
	const limitOf = (key) => {
		const n = Number(thresholds?.[key]);
		return Number.isFinite(n) ? n : THRESHOLDS[key];
	};

	const cpuLimit = limitOf("cpu");
	if (on("cpu") && cpuLimit > 0 && typeof sample.cpu?.percent === "number" && sample.cpu.percent >= cpuLimit) {
		alerts.push({ metric: "cpu", level: "warn", rawValue: sample.cpu.percent, limit: cpuLimit, message: `CPU ${sample.cpu.percent}% ≥ ${cpuLimit}%` });
	}
	const memLimit = limitOf("mem");
	if (on("mem") && memLimit > 0 && typeof sample.memory?.usagePercent === "number" && sample.memory.usagePercent >= memLimit) {
		alerts.push({ metric: "mem", level: "warn", rawValue: sample.memory.usagePercent, limit: memLimit, message: `内存 ${sample.memory.usagePercent}% ≥ ${memLimit}%` });
	}
	const diskLimit = limitOf("disk");
	if (on("disk") && diskLimit > 0) {
		const worstDisk = (sample.disk ?? []).reduce((worst, row) => (worst === null || row.usagePercent > worst.usagePercent ? row : worst), null);
		if (worstDisk !== null && worstDisk.usagePercent >= diskLimit) {
			alerts.push({ metric: "disk", level: "warn", mount: worstDisk.mount, rawValue: worstDisk.usagePercent, limit: diskLimit, message: `磁盘 ${worstDisk.mount} ${worstDisk.usagePercent}% ≥ ${diskLimit}%` });
		}
	}
	const tempLimit = limitOf("temp");
	if (on("temp") && tempLimit > 0) {
		const hottest = (sample.thermal ?? []).reduce((worst, row) => (worst === null || row.celsius > worst.celsius ? row : worst), null);
		if (hottest !== null && hottest.celsius >= tempLimit) {
			alerts.push({ metric: "temp", level: "warn", type: hottest.type, rawValue: hottest.celsius, limit: tempLimit, message: `温度 ${hottest.type} ${hottest.celsius}°C ≥ ${tempLimit}°C` });
		}
	}
	return alerts;
}

/** Per-device rolling history plus its latest collection state. */
export class MetricsStore {
	constructor(limit = RING_MIN) {
		this.limit = limit;
		/** @type {Map<string, object>} */
		this.devices = new Map();
	}

	/** The mutable record for one device, created on first use. */
	record(id) {
		let entry = this.devices.get(id);
		if (entry === undefined) {
			entry = { series: [], latest: undefined, previous: undefined, error: undefined, collectedAt: undefined, diagnostics: undefined, limit: this.limit };
			this.devices.set(id, entry);
		}
		return entry;
	}

	/** The previous sample for a device — the CPU / rate delta baseline. */
	previous(id) {
		return this.record(id).previous;
	}

	/**
	 * Fold a successful collection into the device's history.
	 * @param id - device id.
	 * @param sample - the aggregated sample.
	 * @param diagnostics - per-command diagnostics.
	 * @param ringSize - how many samples to retain (derived from the interval).
	 */
	apply(id, sample, diagnostics, ringSize) {
		const entry = this.record(id);
		entry.previous = sample;
		entry.latest = sample;
		entry.error = undefined;
		entry.collectedAt = Date.now();
		entry.diagnostics = diagnostics;
		if (typeof ringSize === "number" && Number.isFinite(ringSize)) entry.limit = ringSize;
		entry.series.push(toSeriesRow(sample));
		if (entry.series.length > entry.limit) entry.series.splice(0, entry.series.length - entry.limit);
		return entry.latest;
	}

	/** Record a failed collection, keeping the last good sample visible. */
	fail(id, error) {
		const entry = this.record(id);
		entry.error = error;
		return entry;
	}

	/** The latest sample for a device, or undefined before the first poll. */
	latest(id) {
		return this.record(id).latest;
	}

	/**
	 * The rolling series for a device.
	 * @param id - device id.
	 * @param limit - how many samples to return from the newest end. Truncation
	 *   happens HERE, at read time, never on the in-memory ring — the ring keeps
	 *   whatever the interval derived, and a caller asking for fewer points for
	 *   a narrow chart must not shrink what is retained for everyone else.
	 */
	series(id, limit) {
		const rows = this.record(id).series;
		if (limit === undefined || limit >= rows.length) return rows.slice();
		return rows.slice(rows.length - limit);
	}

	/** Collection status for one device, without the sample body. */
	status(id, thresholds, metrics) {
		const entry = this.record(id);
		return {
			collectedAt: entry.collectedAt,
			error: entry.error,
			alertCount: entry.latest === undefined ? 0 : evaluateAlerts(entry.latest, thresholds, metrics).length,
		};
	}

	/** Status for every device that has ever been polled. */
	statuses(thresholds, metricsOf) {
		const out = {};
		for (const id of this.devices.keys()) {
			out[id] = this.status(id, thresholds, typeof metricsOf === "function" ? metricsOf(id) : undefined);
		}
		return out;
	}

	/** Forget a device (used when it is removed from the roster). */
	forget(id) {
		this.devices.delete(id);
	}
}

/**
 * Project one sample onto a series row.
 *
 * A metric that was not collected is `null`, NOT `0`: the chart must break the
 * line rather than plot a plausible-looking zero at the bottom (DESIGN.md
 * §4.4/§7.3). The road to that bug is `Number(null) === 0`, which is why the
 * projection checks the type instead of coercing.
 */
export function toSeriesRow(sample) {
	const row = { ts: sample.ts };
	for (const key of DEFAULT_METRIC_COLUMNS) row[key] = numOrNull(sampleColumn(sample, key));
	return row;
}

/** Pull one chartable value out of a sample, or null when it is absent. */
function sampleColumn(sample, key) {
	switch (key) {
		case "cpu":
			return sample.cpu?.percent;
		case "mem":
			return sample.memory?.usagePercent;
		case "disk":
			// The worst mount, matching what the alert engine reports.
			return (sample.disk ?? []).reduce((worst, r) => (worst === null || r.usagePercent > worst ? r.usagePercent : worst), null);
		case "temp":
			return (sample.thermal ?? []).reduce((worst, r) => (worst === null || r.celsius > worst ? r.celsius : worst), null);
		case "load1":
			return sample.load?.load1;
		case "netRx":
			return sample.net?.rxTotal;
		case "netTx":
			return sample.net?.txTotal;
		case "diskRead":
			return sample.diskio?.rxTotal;
		case "diskWrite":
			return sample.diskio?.txTotal;
		case "procs":
			return sample.processes;
		case "tcp":
			return sample.tcp;
		default:
			return undefined;
	}
}

/**
 * Coerce a value to a finite number, or null.
 *
 * `Number.isFinite(Number(x))` is BANNED here for the same reason the reference
 * bans it on the client (`DESIGN.md` ADR 52): `Number(null) === 0`, so a device
 * with no temperature sensor renders "温度 0°C" — a plausible-looking number
 * that nobody investigates, which is strictly worse than `--`.
 */
export function numOrNull(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}
