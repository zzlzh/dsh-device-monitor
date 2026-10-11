/**
 * The series (chart) column vocabulary.
 *
 * Kept apart from `metrics.js` so the browser half can share the same column
 * list without importing the Host's history implementation. Every column is a
 * plain number or `null` — `null` means "not collected or not readable", and
 * the chart draws a break in the line there rather than a zero.
 */
export const DEFAULT_METRIC_COLUMNS = ["cpu", "mem", "disk", "temp", "load1", "netRx", "netTx", "diskRead", "diskWrite", "procs", "tcp"];

/** Which columns the four card waveforms use, in draw order. */
export const WAVE_COLUMNS = [
	{ key: "cpu", metric: "cpu", label: "CPU", ceiling: 100, unit: "%" },
	{ key: "mem", metric: "mem", label: "内存", ceiling: 100, unit: "%" },
	{ key: "disk", metric: "disk", label: "磁盘", ceiling: 100, unit: "%" },
	{ key: "temp", metric: "temp", label: "温度", ceiling: null, unit: "°C" },
];
