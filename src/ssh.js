/**
 * SSH transport for the dsh-device-monitor plugin.
 *
 * One {@link DeviceConnection} covers one device: it dials with ssh2, runs the
 * command plan, and produces an aggregated metric sample. Connections are
 * short-lived — a poll opens, collects, and closes — which keeps an idle device
 * from holding a channel open inside the Host process and avoids the
 * stale-credential problem entirely (a device whose password changed simply
 * fails the next poll).
 *
 * `ssh2` is resolved defensively: the plugin package may be installed by link
 * from a workspace directory, while the dependency itself is hoisted into the
 * profile's `node_modules`. A plain import would then walk up from the
 * workspace path and miss it, so we fall back to a require rooted at the
 * profile directory.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { aggregate, commandPlan } from "./collectors.js";
import { appendRawRecord } from "./raw-log.js";
import { roots } from "./resolve.js";

/** Per-command default timeout. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/** How long a TCP/SSH handshake may take. */
const READY_TIMEOUT_MS = 12_000;

/** Overall budget for one full collection pass. */
export const COLLECT_TIMEOUT_MS = 60_000;

let cachedSsh2;

/**
 * Load the ssh2 module, preferring normal resolution and falling back to the
 * profile directories (the plugin may be installed by reference from a
 * workspace path, where it cannot see the profile's hoisted dependencies).
 *
 * This deliberately reuses {@link roots} rather than keeping its own shorter
 * ladder: `DSH_PROFILE_DIR` is not guaranteed to be set in the Host process,
 * and a version that only consulted it left the live Host unable to load ssh2
 * at all.
 *
 * @returns the ssh2 module namespace.
 */
export function loadSsh2() {
	if (cachedSsh2 !== undefined) return cachedSsh2;
	const candidates = [];
	try {
		candidates.push(createRequire(import.meta.url));
	} catch {
		// ignore
	}
	for (const root of roots()) {
		try {
			candidates.push(createRequire(join(root, "index.js")));
		} catch {
			// ignore
		}
	}
	let lastError;
	for (const require of candidates) {
		try {
			cachedSsh2 = require("ssh2");
			return cachedSsh2;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`cannot load the ssh2 module: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Build the ssh2 connect options for a stored device row. */
function connectOptions(device) {
	const auth = device.auth ?? { kind: "password" };
	const options = {
		host: device.host,
		port: device.port || 22,
		username: device.username,
		readyTimeout: READY_TIMEOUT_MS,
		keepaliveInterval: 15_000,
		keepaliveCountMax: 3,
	};
	if (auth.kind === "key" && auth.privateKeyPath) {
		options.privateKey = readFileSync(auth.privateKeyPath);
		if (auth.passphrase) options.passphrase = auth.passphrase;
	} else if (auth.kind === "agent") {
		options.agent = process.env.SSH_AUTH_SOCK;
	} else {
		options.password = auth.password ?? "";
		// Embedded/network devices frequently answer with a keyboard-interactive
		// password prompt rather than the "password" auth method.
		options.tryKeyboard = true;
	}
	return options;
}

/** Open an SSH connection to a device and resolve the live client. */
export function connect(device) {
	const { Client } = loadSsh2();
	return new Promise((resolve, reject) => {
		const conn = new Client();
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			conn.removeAllListeners();
			if (error) {
				try {
					conn.end();
				} catch {
					// ignore
				}
				reject(error);
			} else {
				resolve(conn);
			}
		};
		conn.on("ready", () => finish(undefined));
		conn.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
		conn.on("timeout", () => finish(new Error("connection timed out")));
		conn.on("close", () => finish(new Error("connection closed before it was ready")));
		if ((device.auth?.kind ?? "password") === "password") {
			conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, done) => {
				done(prompts.map((prompt) => (/password|passwd|密码/i.test(prompt.prompt) ? device.auth?.password ?? "" : "")));
			});
		}
		try {
			conn.connect(connectOptions(device));
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

/**
 * Run one command over an open connection.
 * @returns the trimmed stdout, stderr and exit code.
 */
export function exec(conn, command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		let done = false;
		let code = null;
		const finish = (extra) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, code, durationMs: Date.now() - started, ...extra });
		};
		const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
		conn.exec(command, (error, stream) => {
			if (error) {
				finish({ error: error.message });
				return;
			}
			stream.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
			});
			stream.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
			stream.on("close", (exitCode) => {
				code = typeof exitCode === "number" ? exitCode : null;
				finish({});
			});
		});
	});
}

/** Close a connection without letting teardown errors escape. */
export function dispose(conn) {
	try {
		conn.end();
	} catch {
		// ignore
	}
}

/**
 * Probe a device: connect, run `uname -a`, and report latency.
 * @returns `{ ok, latencyMs, banner, error }`.
 */
export async function test(device) {
	const started = Date.now();
	let conn;
	try {
		conn = await connect(device);
		const result = await exec(conn, "uname -a 2>/dev/null || echo unknown", 8_000);
		return {
			ok: true,
			latencyMs: Date.now() - started,
			banner: result.stdout.trim().split("\n")[0] ?? "",
		};
	} catch (error) {
		return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (conn) dispose(conn);
	}
}

/**
 * Collect one metric sample from a device.
 *
 * Every planned command runs over the same authenticated connection; failures
 * degrade to empty output rather than aborting the pass, because a busybox
 * device commonly lacks `/sys/class/thermal` or `systemctl` while still being
 * perfectly monitorable for CPU, memory, disk and load.
 *
 * @param device - the stored device row.
 * @param previous - the previous sample (supplies the CPU delta baseline and
 * the rate-metric counter baselines).
 * @param metrics - the device's selected metric keys. `undefined` collects
 *   everything. The gate lives in {@link commandPlan}, so an unselected metric
 *   costs no command and produces no network round-trip at all.
 * @param options.rawLog - write the verbatim device replies to the per-device
 *   raw log (default true). BOTH the success and the failure path are recorded:
 *   when a metric comes back null, the failure path is where the answer is.
 * @param options.customCommands - the settings' command-override subtree. It
 *   REPLACES the body of an overridden collector but never the SELECTION gate:
 *   an unselected metric still gets no command at all.
 * @returns the aggregated sample plus per-command diagnostics.
 */
export async function collect(device, previous, metrics, options = {}) {
	const plan = commandPlan(metrics, options.customCommands);
	const started = Date.now();
	const at = new Date().toISOString();
	const texts = {};
	const diagnostics = [];
	const rawLog = options.rawLog !== false;
	let conn;
	let failure = null;
	try {
		conn = await connect(device);
		for (const [key, entry] of Object.entries(plan)) {
			const result = await exec(conn, entry.cmd, entry.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS);
			texts[key] = result.stdout ?? "";
			diagnostics.push({
				name: key,
				exitCode: result.code,
				durationMs: result.durationMs,
				timedOut: result.timedOut === true,
				...(result.error === undefined ? {} : { error: result.error }),
			});
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		if (conn) dispose(conn);
		if (rawLog) {
			// Recorded AFTER the connection is closed so a log write can never
			// hold a channel open, but still inside `finally` so a mid-pass
			// throw still leaves evidence of whatever came back before it.
			appendRawRecord({
				device,
				at,
				error: failure,
				raw: failure === null ? formatRawPass(plan, texts, diagnostics) : "",
			});
		}
	}
	const sample = aggregate(previous, texts, metrics);
	sample.deviceId = device.id;
	sample.durationMs = Date.now() - started;
	return { sample, diagnostics };
}

/**
 * Render one collection pass as the plain-text block the raw log stores.
 *
 * `==KEY==` markers in command-plan order, the command itself, then its stdout
 * verbatim. Interleaving the command with its output is what makes the log
 * usable as evidence months later: without it, a bare `df` listing cannot be
 * attributed to a collector.
 */
export function formatRawPass(plan, texts, diagnostics) {
	const byName = new Map(diagnostics.map((d) => [d.name, d]));
	const parts = [];
	for (const [key, entry] of Object.entries(plan)) {
		const diag = byName.get(key);
		const notes = [];
		if (diag !== undefined) {
			if (diag.exitCode !== undefined && diag.exitCode !== 0) notes.push(`exit=${diag.exitCode}`);
			if (diag.timedOut) notes.push("timedOut");
			if (diag.error !== undefined) notes.push(`error=${diag.error}`);
			if (diag.durationMs !== undefined) notes.push(`${diag.durationMs}ms`);
		}
		parts.push(`==${key}== ${entry.cmd}`);
		if (notes.length) parts.push(`[${notes.join(" ")}]`);
		const body = String(texts[key] ?? "").replace(/\n+$/, "");
		parts.push(body === "" ? "(empty)" : body);
	}
	return parts.join("\n");
}
