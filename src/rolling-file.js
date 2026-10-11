/**
 * A size-rolled append-only file, the primitive both log layers sit on.
 *
 * Ported from the reference device-manager's `lib/rollingFile.js`. The whole
 * reason this is a separate module is the rotation ORDER, which is easy to get
 * subtly wrong: the oldest file must be DELETED before the renames start. If
 * the delete is omitted, `base.(keep-1)` is renamed onto an existing
 * `base.keep`, and the archive silently keeps only `keep-1` files plus the
 * live one — a bug that stays invisible until someone needs the oldest records
 * and discovers they were never written.
 *
 * `name` may contain a subdirectory (`"log/devices/foo.log"`): `appendText`
 * mkdirs `path.dirname(file)` recursively, so nesting needs no extra code.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where every log file lives: an independent directory, not beside the config. */
export function logRoot() {
	const home = process.env.DSH_HOME;
	const base = typeof home === "string" && home.trim() !== "" ? home : join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
	return join(base, "dsh-device-monitor-logs");
}

/**
 * Create a rolling file handle.
 *
 * @param opts.name - path relative to {@link logRoot}, e.g. `"log/audit.log"`.
 * @param opts.maxBytes - rotate once the live file reaches this size.
 * @param opts.keep - how many rotated copies to retain (`base.1`..`base.keep`).
 * @param opts.warnPrefix - text for the warn on a write failure.
 */
export function createRollingFile({ name, maxBytes, keep = 5, warnPrefix = "写入日志失败" }) {
	/** Absolute path of the live file (rotated copies append `.1`, `.2`, …). */
	const file = () => join(logRoot(), name);

	/** Delete the oldest copy, then shift every copy up one slot. */
	function rotateNow() {
		const base = file();
		try {
			// Deleting first is REQUIRED; see the module comment.
			rmSync(`${base}.${keep}`, { force: true });
			for (let n = keep - 1; n >= 1; n -= 1) {
				const from = `${base}.${n}`;
				if (!existsSync(from)) continue;
				renameSync(from, `${base}.${n + 1}`);
			}
			if (existsSync(base)) renameSync(base, `${base}.1`);
		} catch (error) {
			console.warn(`${warnPrefix}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Rotate when the live file is at or over the limit. No file yet => false. */
	function rotateIfNeeded() {
		const base = file();
		try {
			if (!existsSync(base)) return false;
			if (statSync(base).size < maxBytes) return false;
		} catch {
			return false;
		}
		rotateNow();
		return true;
	}

	/**
	 * Append text, rolling first if needed.
	 *
	 * Synchronous on purpose: a record is ~2 KB and takes 0.1-0.5 ms, while an
	 * async write adds "the last records are lost on exit" and lets concurrent
	 * collections interleave mid-record. A write failure only warns — logging
	 * must never be able to fail a collection.
	 */
	function appendText(text) {
		const base = file();
		try {
			mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
			rotateIfNeeded();
			appendFileSync(base, text, { encoding: "utf8", mode: 0o600 });
			return true;
		} catch (error) {
			console.warn(`${warnPrefix}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/** The live file first, then each rotated copy, newest to oldest. */
	function filesNewestFirst() {
		const base = file();
		const out = [];
		if (existsSync(base)) out.push(base);
		for (let n = 1; n <= keep; n += 1) {
			const candidate = `${base}.${n}`;
			if (existsSync(candidate)) out.push(candidate);
		}
		return out;
	}

	return { file, appendText, rotateNow, rotateIfNeeded, filesNewestFirst };
}
