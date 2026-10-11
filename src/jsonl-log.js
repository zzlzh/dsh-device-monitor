/**
 * A JSONL log on top of {@link createRollingFile}: one JSON object per line.
 *
 * Ported from the reference device-manager's `lib/jsonlLog.js`. Used for the
 * audit trail and the exception (incident) records.
 *
 * Reads go newest-first across EVERY rolled file, not just the live one:
 * reading only the live file makes the history look empty immediately after a
 * rotation, which is exactly when someone is most likely to be looking.
 */
import { readFileSync } from "node:fs";

import { createRollingFile } from "./rolling-file.js";

/**
 * @param opts.name - path relative to the log root.
 * @param opts.maxBytes - rotate size (default 5 MB).
 * @param opts.keep - rotated copies retained (default 5).
 * @param opts.warnPrefix - warn text on failure.
 */
export function createJsonlLog({ name, maxBytes = 5 * 1024 * 1024, keep = 5, warnPrefix = "写入 JSONL 日志失败" }) {
	const rolling = createRollingFile({ name, maxBytes, keep, warnPrefix });

	/** Append one record as a single line. */
	function append(record) {
		return rolling.appendText(`${JSON.stringify(record)}\n`);
	}

	/**
	 * Read up to `limit` records, newest first, across all rolled files.
	 * A line that will not parse is returned as `{raw: line}` rather than
	 * dropped: a torn write at a rotation boundary is data too, and silently
	 * skipping it makes the log look like it lost events.
	 */
	function read(limit = 100) {
		const out = [];
		for (const path of rolling.filesNewestFirst()) {
			if (out.length >= limit) break;
			let text;
			try {
				text = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n");
			for (let n = lines.length - 1; n >= 0; n -= 1) {
				const line = lines[n].trim();
				if (line === "") continue;
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					parsed = { raw: line };
				}
				out.push(parsed);
				if (out.length >= limit) break;
			}
		}
		return out;
	}

	return { name, file: rolling.file, append, read, rotateNow: rolling.rotateNow, filesNewestFirst: rolling.filesNewestFirst };
}
