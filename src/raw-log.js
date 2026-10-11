/**
 * Per-device raw collection log: exactly what the device replied, verbatim.
 *
 * Ported from the reference device-manager's `lib/rawLog.js`. The motivating
 * failure is worth restating because it is the entire justification for this
 * module: the collector parses stdout and then throws the text away, so when a
 * metric comes back as `null` the Host genuinely cannot answer "设备到底回了
 * 什么". Debug mode does not help — it only widens the AI command whitelist.
 * Keeping the raw reply is the difference between "温度读不到" and "设备返回了
 * `cat: /sys/class/thermal: No such file or directory`".
 *
 * Three deliberate format decisions:
 *
 *   Per-device FILES, not one shared raw.log. The only use case is looking
 *   back at ONE device's replies; a mixed file forces the reader to identify
 *   the device on every block, and interleaved polls from ten devices make
 *   that unreadable.
 *
 *   Plain text BLOCKS, not JSONL. JSON escaping collapses aligned `df`/`free`
 *   output onto one long line, destroying the exact property the feature exists
 *   for: 1:1 fidelity as evidence.
 *
 *   NOT redacted, by design. A command reading `/etc/shadow` or `env` is
 *   recorded verbatim. 0700/0600 permissions are the only protection, which is
 *   why this data stays in a local directory and never crosses the network.
 *   This is disclosed to the user in the README and in the settings UI, not
 *   only here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { createRollingFile, logRoot } from "./rolling-file.js";

/** Bytes per device before rotating: 20 MB × 3 + live ≈ 60 MB. */
export const RAW_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** Rotated copies retained per device. */
export const RAW_LOG_KEEP = 3;

/** Largest single record; a runaway command cannot fill the disk in one write. */
export const RAW_LOG_RECORD_MAX = 256 * 1024;

/** Device logs live under this subdirectory of the log root. */
export const RAW_LOG_DIR = "log/devices";

/** Windows device names that cannot be used as a file name without a prefix. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Make a device name safe to use as a path component.
 *
 * This is a SECURITY function, not a tidiness one: without it a device named
 * `../../settings` (or `..\\..\\x`) writes outside the log directory entirely,
 * and the name is fully user-controlled. Control characters are stripped
 * because they also break the log's own line-oriented format.
 */
export function sanitizeDeviceName(name) {
	let out = String(name ?? "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, "_")
		.replace(/[<>:"/\\|?*]/g, "_")
		.replace(/^[. ]+|[. ]+$/g, "")
		.slice(0, 40);
	if (out === "") out = "device";
	if (WIN_RESERVED.test(out)) out = `_${out}`;
	return out;
}

/**
 * The first 8 alphanumeric characters of a device id, or `noid`.
 *
 * The suffix is a CORRECTNESS requirement, not decoration: duplicate device
 * NAMES are allowed, so without it the second device of a pair silently
 * appends its records into the first device's file. The failure is maximally
 * quiet — the write succeeds, the directory exists, the filename is legal —
 * so it is only detectable by asserting the on-disk result from the public
 * entry point. See DESIGN.md §6.2/D17.
 */
export function idSuffix(id) {
	const cleaned = String(id ?? "").replace(/[^a-zA-Z0-9]/g, "");
	return cleaned.slice(0, 8) || "noid";
}

/** Path of one device's raw log, relative to the log root. */
export function deviceLogName(device) {
	return `${RAW_LOG_DIR}/${sanitizeDeviceName(device?.name)}-${idSuffix(device?.id)}.log`;
}

/** UTF-8-safe truncation: never split a multi-byte character in half. */
export function clampBytes(text, max) {
	const buf = Buffer.from(String(text), "utf8");
	if (buf.length <= max) return String(text);
	let end = max;
	// A continuation byte has the top two bits set to 10; back off to the start
	// of the character so the tail is not a lone surrogate fragment.
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
	return buf.subarray(0, end).toString("utf8");
}

/**
 * Format one record as a plain-text block.
 *
 * Failures are recorded too, and deliberately: when a metric is unreadable the
 * answer is almost always in the failure path, not the success path.
 */
export function formatRecord({ at, name, raw = "", error = null } = {}) {
	const head = `${at ?? new Date().toISOString()} - ${name || "(未命名设备)"}`;
	const body = error === null || error === undefined ? String(raw).replace(/\n+$/, "") : `[失败] ${error}`;
	const full = `${head}\n${body}\n`;
	const clamped = clampBytes(full, RAW_LOG_RECORD_MAX);
	if (clamped === full) return full;
	const original = Buffer.byteLength(full, "utf8");
	return `${clamped}\n[已截断，原文 ${original} 字节，上限 ${RAW_LOG_RECORD_MAX} 字节]\n`;
}

/** Cache one rolling handle per device path so rotation state is not rebuilt. */
const handles = new Map();

/** The rolling handle for a device, created on first use. */
function handleFor(device) {
	const name = deviceLogName(device);
	let handle = handles.get(name);
	if (handle === undefined) {
		handle = createRollingFile({
			name,
			maxBytes: RAW_LOG_MAX_BYTES,
			keep: RAW_LOG_KEEP,
			warnPrefix: "写入设备原始数据日志失败",
		});
		handles.set(name, handle);
	}
	return handle;
}

/**
 * Append one raw record for a device.
 * A write failure warns and returns false; it never propagates, because losing
 * a log line must not fail a collection the user is waiting on.
 */
export function appendRawRecord({ device, at, raw, error }) {
	try {
		const text = formatRecord({ at, name: device?.name, raw, error });
		return handleFor(device).appendText(text);
	} catch (err) {
		console.warn(`写入设备原始数据日志失败: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/** Absolute paths of one device's log files, newest first. */
export function deviceLogFiles(device) {
	return handleFor(device).filesNewestFirst();
}

/**
 * Read the most recent raw lines for a device, newest first, across all rolled
 * files.
 */
export function readRawLines(device, limit = 200) {
	const out = [];
	for (const path of deviceLogFiles(device)) {
		if (out.length >= limit) break;
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (let n = lines.length - 1; n >= 0; n -= 1) {
			out.push(lines[n]);
			if (out.length >= limit) break;
		}
	}
	return out;
}

/** Total bytes across one device's log files. */
export function deviceLogBytes(device) {
	let total = 0;
	for (const path of deviceLogFiles(device)) {
		try {
			total += statSync(path).size;
		} catch {
			// A file that vanished between listing and stat contributes nothing.
		}
	}
	return total;
}

/**
 * Rename a device's log to follow a rename of the device itself.
 * Leftover files at the destination are removed first — on Windows a rename
 * onto an existing file fails outright. Warnings only, never throws.
 */
export function renameDeviceLog(oldDevice, newDevice) {
	const from = join(logRoot(), deviceLogName(oldDevice));
	const to = join(logRoot(), deviceLogName(newDevice));
	if (from === to) return true;
	try {
		mkdirSync(join(logRoot(), RAW_LOG_DIR), { recursive: true, mode: 0o700 });
		const dst = createRollingFile({ name: deviceLogName(newDevice), maxBytes: RAW_LOG_MAX_BYTES, keep: RAW_LOG_KEEP });
		for (const path of dst.filesNewestFirst()) rmSync(path, { force: true });
		if (existsSync(from)) renameSync(from, to);
		for (let n = 1; n <= RAW_LOG_KEEP; n += 1) {
			const src = `${from}.${n}`;
			if (existsSync(src)) renameSync(src, `${to}.${n}`);
		}
		// Both cache keys must move, or the next append recreates the old file.
		handles.delete(deviceLogName(oldDevice));
		handles.delete(deviceLogName(newDevice));
		return true;
	} catch (error) {
		console.warn(`重命名设备日志失败: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Delete every log file belonging to a device. */
export function removeDeviceLog(device) {
	try {
		const handle = handleFor(device);
		for (const path of handle.filesNewestFirst()) rmSync(path, { force: true });
		handles.delete(deviceLogName(device));
		return true;
	} catch (error) {
		console.warn(`删除设备日志失败: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Force a rotation, for tests. */
export function __rotateNow(device) {
	return handleFor(device).rotateNow();
}

/** The directory every device log lives in. */
export function rawLogDir() {
	return join(logRoot(), RAW_LOG_DIR);
}
