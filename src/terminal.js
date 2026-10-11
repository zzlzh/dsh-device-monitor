/**
 * Interactive terminal sessions (the 「终端调试」 feature).
 *
 * This is a faithful port of the reference device-manager's `lib/terminal.js`,
 * with the same central and deliberately uncomfortable trade-off:
 *
 *   THE SERVER DOES NOT INSPECT COMMANDS.
 *
 * It cannot. A terminal forwards keystrokes verbatim to a remote PTY, and the
 * server never sees a command boundary — a full-screen program receives
 * individual keypresses, not lines, so there is no point at which a
 * "command string" exists to be checked. Any attempt to filter here would be
 * defeated by `vim`, by a here-doc, by `sh -c '...'`, or simply by base64.
 * Pretending otherwise would be worse than admitting it.
 *
 * The compensation is three layers, and all three are required:
 *
 *   1. DEFAULT OFF. `terminal.enabled` must be a real boolean `true`; the user
 *      turns it on deliberately in the panel (see the `normalizeTerminal` note).
 *   2. LOOPBACK + ALLOWLIST. Every route already refuses a non-loopback socket
 *      (`src/http.js`), and the WS upgrade re-checks it. `terminal.allowedHosts`
 *      is an optional second lock for a tunneled deployment.
 *   3. SESSION LIMITS AND AN IDLE TIMER. A forgotten terminal otherwise holds a
 *      live root shell on the device until the device reboots.
 *
 * On auditing: this plugin's standing rule is that the audit log records field
 * NAMES, never command bodies (`src/monitor.js` does the same for `device_exec`),
 * and the user confirmed that choice for the terminal. So the audit records
 * session open/close/deny and the byte counters — never the keystrokes. That is
 * a deliberate departure from the reference, which logs every input.
 *
 * Output is base64 on the wire. A remote PTY emits arbitrary bytes; decoding
 * them as UTF-8 would replace every invalid sequence with U+FFFD, which is not
 * recoverable downstream and visibly corrupts `vim` and `top`.
 */
import { readFileSync } from "node:fs";

import { audit } from "./logs.js";
import { loadSsh2 } from "./ssh.js";

/** Concurrent sessions on one device. */
export const MAX_SESSIONS_PER_DEVICE = 3;

/** Concurrent sessions in the whole Host process. */
export const MAX_SESSIONS_TOTAL = 10;

/** Floor on the idle timeout, so a misconfigured 0 cannot disable it. */
export const MIN_IDLE_MS = 30_000;

/** The idle timeout used when the configured value is missing or nonsense. */
export const DEFAULT_IDLE_MS = 300_000;

/**
 * Resolve a configured idle timeout into the delay actually used.
 *
 * ONE function, because `config()` reports the value to the panel while
 * `armIdleTimer` enforces it: resolving in two places let the panel state a
 * timeout the session did not actually use, and it left two clamps in series
 * that no test could tell apart. A `0`, a negative number and a non-number all
 * collapse to the default; a positive value below the floor is raised to it.
 * The one thing that must never come out is "no timeout at all", because what
 * the timer releases is a full shell on someone's device.
 */
export function resolveIdleMs(value) {
	const ms = Number(value);
	if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_IDLE_MS;
	return Math.max(MIN_IDLE_MS, ms);
}

/** The injected default; `src/ssh.js` is the module that knows about ssh2. */
export { loadSsh2 };
let sequence = 0;

/**
 * Reject a source address that is not on an explicitly configured list.
 *
 * An empty list allows everything, which is safe because the caller has
 * already established a loopback socket. The list exists for the tunneled
 * case, where "loopback" no longer means "the person at this keyboard".
 *
 * A hostname rule is resolved at check time (one DNS lookup) rather than at
 * save time: `["devbox.lan"]` frozen to whatever address it had when the
 * settings were written would silently stop matching after a DHCP lease
 * changed, and the user would conclude the setting does not work.
 */
export async function hostAllowed(remoteAddress, allowedHosts, lookup) {
	const list = Array.isArray(allowedHosts) ? allowedHosts : [];
	if (list.length === 0) return true;
	const ip = normalizeIp(remoteAddress);
	// No source address at all is not "unknown, allow it" — it means the
	// request did not come through the normal socket path, so it is refused.
	if (ip === "") return false;
	for (const rule of list) {
		if (rule === ip) return true;
		if (rule.includes("/") && cidrMatch(ip, rule)) return true;
		if (!isIpLiteral(rule)) {
			try {
				const resolve = lookup ?? (await import("node:dns/promises")).lookup;
				const found = await resolve(rule, { all: true });
				if (found.some((row) => row.address === ip)) return true;
			} catch {
				// A name that does not resolve simply does not match.
			}
		}
	}
	return false;
}

/** Restore an IPv4-mapped or zone-tagged address to its canonical form. */
export function normalizeIp(address) {
	if (address === undefined || address === null) return "";
	let value = String(address).trim();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
	if (mapped !== null) return mapped[1];
	const zone = value.indexOf("%");
	if (zone > 0) value = value.slice(0, zone);
	return value;
}

function isIpLiteral(value) {
	return /^\d+\.\d+\.\d+\.\d+$/.test(value) || value.includes(":");
}

function ipToInt(ip) {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let total = 0;
	for (const part of parts) {
		const value = Number(part);
		if (!Number.isInteger(value) || value < 0 || value > 255) return null;
		total = total * 256 + value;
	}
	return total;
}

/** Whether an IPv4 address falls inside a `a.b.c.d/n` rule. */
export function cidrMatch(ip, rule) {
	const [network, bitsRaw] = String(rule).split("/");
	const bits = Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const address = ipToInt(ip);
	const base = ipToInt(network);
	if (address === null || base === null) return false;
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return (address & mask) === (base & mask);
}

/**
 * Open a PTY-backed shell on a device.
 *
 * The device row is supplied by the caller rather than looked up here, so this
 * module has no opinion about the roster and stays testable against a fake
 * connection.
 *
 * @returns `{ stream, client, close }` — `close` tears the whole connection down.
 */
export function openShell(device, { cols, rows } = {}) {
	const ssh = loadSsh2();
	return new Promise((resolve, reject) => {
		const client = new ssh.Client();
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			try {
				client.end();
			} catch {
				// ignore
			}
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		client.on("ready", () => {
			client.shell(
				{
					term: "xterm-256color",
					cols: clampDimension(cols, 80, 20, 400),
					rows: clampDimension(rows, 24, 5, 200),
				},
				(error, stream) => {
					if (error) {
						fail(error);
						return;
					}
					if (settled) {
						try {
							stream.close();
						} catch {
							// ignore
						}
						return;
					}
					settled = true;
					resolve({ stream, client, close: () => client.end() });
				},
			);
		});
		client.on("error", fail);
		client.on("close", () => fail(new Error("connection closed before the shell opened")));
		client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, done) => {
			done(prompts.map((prompt) => (/password|passwd|密码/i.test(prompt.prompt) ? device.auth?.password ?? "" : "")));
		});
		try {
			client.connect(connectOptions(device));
		} catch (error) {
			fail(error);
		}
	});
}

function clampDimension(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * The ssh2 connect options for a stored device row.
 *
 * Deliberately a near-copy of `src/ssh.js`'s own builder rather than an
 * import: that one is module-private, and the terminal needs a LONGER ready
 * timeout — a shell is opened while the user waits, so failing fast is less
 * useful than waiting a little.
 */
function connectOptions(device) {
	const auth = device.auth ?? { kind: "password" };
	const options = {
		host: device.host,
		port: device.port || 22,
		username: device.username,
		readyTimeout: 20_000,
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
		options.tryKeyboard = true;
	}
	return options;
}

/**
 * The terminal session registry.
 *
 * Owns ids, the session cap, the idle timer and the audit records. It does NOT
 * own the WebSocket: the transport hands it a `socketId` and calls
 * {@link closeBySocket} when that socket goes away.
 */
export class TerminalManager {
	/**
	 * @param store - the device roster (for `find`).
	 * @param options.getSettings - live settings reader, so turning the switch
	 *   off in the panel takes effect on the next open rather than at restart.
	 * @param options.openShell - injectable transport, for tests.
	 * @param options.lookup - injectable DNS resolver, for tests.
	 */
	constructor(store, options = {}) {
		this.store = store;
		this.getSettings = options.getSettings ?? (() => ({ enabled: false, allowedHosts: [], idleMs: DEFAULT_IDLE_MS }));
		this.openShell = options.openShell ?? openShell;
		this.lookup = options.lookup;
		this.sessions = new Map();
	}

	/** The live terminal config, re-read so a panel change applies immediately. */
	config() {
		const raw = this.getSettings() ?? {};
		return {
			enabled: raw.enabled === true,
			allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts : [],
			idleMs: resolveIdleMs(raw.idleMs),
		};
	}

	/**
	 * Open a session.
	 *
	 * The three refusal reasons are worded separately on purpose: "the terminal
	 * is switched off" and "your address is not on the allowlist" call for
	 * completely different actions from the user, and collapsing them into one
	 * "no permission" makes them guess which one they hit.
	 *
	 * @param request.deviceId - target device.
	 * @param request.remoteAddress - the socket's peer address.
	 * @param request.socketId - the owning WebSocket, passed IN rather than
	 *   assigned afterwards. An earlier design had the caller attach it to the
	 *   returned session, which is an implicit contract: a new call path that
	 *   forgets to attach it leaves `closeBySocket` closing nothing, and the
	 *   forgotten session keeps a live shell on the device.
	 * @returns `{ok, reason?, session?}`.
	 */
	async open({ deviceId, remoteAddress, cols, rows, by = "", socketId = "" } = {}) {
		const config = this.config();
		if (!config.enabled) {
			return { ok: false, reason: "terminal.disabled", message: "交互式终端未开启（需要在「设置」中打开）" };
		}
		const device = this.store.find(deviceId);
		if (device === undefined) {
			return { ok: false, reason: "terminal.noDevice", message: "设备不存在" };
		}
		if (!(await hostAllowed(remoteAddress, config.allowedHosts, this.lookup))) {
			return { ok: false, reason: "terminal.hostDenied", message: `来源地址 ${normalizeIp(remoteAddress) || "未知"} 不在终端的允许列表里` };
		}
		const perDevice = [...this.sessions.values()].filter((row) => row.deviceId === deviceId).length;
		if (perDevice >= MAX_SESSIONS_PER_DEVICE) {
			return { ok: false, reason: "terminal.tooManyForDevice", message: `该设备已有 ${perDevice} 个终端会话（上限 ${MAX_SESSIONS_PER_DEVICE}），请先关闭一个` };
		}
		if (this.sessions.size >= MAX_SESSIONS_TOTAL) {
			return { ok: false, reason: "terminal.tooManyTotal", message: `终端会话总数已达上限 ${MAX_SESSIONS_TOTAL}，请先关闭一些` };
		}
		let handle;
		try {
			handle = await this.openShell(device, { cols, rows });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			audit("terminal.denied", { deviceId, device: device.name, host: device.host, from: normalizeIp(remoteAddress), by });
			return { ok: false, reason: "terminal.connectFailed", message };
		}
		sequence += 1;
		const id = `t${sequence}-${Math.random().toString(36).slice(2, 8)}`;
		const session = {
			id,
			deviceId,
			deviceName: device.name,
			host: device.host,
			username: device.username,
			openedAt: new Date().toISOString(),
			lastActivityAt: Date.now(),
			from: normalizeIp(remoteAddress),
			by,
			socketId: String(socketId ?? ""),
			bytesIn: 0,
			bytesOut: 0,
			stream: handle.stream,
			close: handle.close,
			idleTimer: null,
			closed: false,
		};
		this.sessions.set(id, session);
		// Input is NEVER recorded — only the fact that a session opened.
		audit("terminal.open", { session: id, deviceId, device: device.name, host: device.host, from: session.from, by });
		this.armIdleTimer(session, config.idleMs);
		return { ok: true, session };
	}

	/**
	 * Arm the idle timer.
	 *
	 * [Why this must exist] A WebSocket `close` event fires when the user shuts
	 * the tab, but NOT when the process is killed, the network drops, or the
	 * machine sleeps. Without a timer a forgotten terminal stays attached to the
	 * device until the device reboots — and what it holds is a full shell.
	 *
	 * The floor is applied by {@link resolveIdleMs}: a hand-edited `0` must not
	 * mean "never time out".
	 */
	armIdleTimer(session, idleMs) {
		const ms = resolveIdleMs(idleMs);
		if (session.idleTimer !== null) clearTimeout(session.idleTimer);
		session.idleTimer = setTimeout(() => {
			session.idleTimer = null;
			this.close(session.id, "空闲超时");
		}, ms);
		session.idleTimer.unref?.();
	}

	/** Record activity and restart the idle countdown. */
	touch(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === undefined || session.closed) return;
		session.lastActivityAt = Date.now();
		this.armIdleTimer(session, this.config().idleMs);
	}

	/** Close one session. Returns whether anything was closed. */
	close(sessionId, reason = "用户关闭") {
		const session = this.sessions.get(sessionId);
		if (session === undefined) return false;
		if (session.closed) return false;
		session.closed = true;
		if (session.idleTimer !== null) clearTimeout(session.idleTimer);
		session.idleTimer = null;
		this.sessions.delete(sessionId);
		try {
			session.close();
		} catch {
			// A teardown failure must not stop the bookkeeping below.
		}
		audit("terminal.close", {
			session: session.id,
			deviceId: session.deviceId,
			device: session.deviceName,
			reason,
			durationMs: Date.now() - new Date(session.openedAt).getTime(),
			bytesIn: session.bytesIn,
			bytesOut: session.bytesOut,
		});
		return true;
	}

	/**
	 * Close every session owned by one socket.
	 *
	 * An empty `socketId` returns 0 immediately. Session ids default to the
	 * empty string too, so without that guard "we do not know who this is"
	 * would be read as "it is all of them" and one disconnect would close
	 * every terminal at once.
	 */
	closeBySocket(socketId) {
		const socket = String(socketId ?? "");
		if (socket === "") return 0;
		let closed = 0;
		for (const session of [...this.sessions.values()]) {
			if (session.socketId === socket) {
				this.close(session.id, "连接已断开");
				closed += 1;
			}
		}
		return closed;
	}

	/** Close everything, e.g. while the plugin unloads. */
	closeAll(reason = "服务停止") {
		for (const id of [...this.sessions.keys()]) this.close(id, reason);
	}

	/**
	 * The session list, de-identified of anything unserializable.
	 *
	 * `stream` and `close` are handles: they cannot be JSON-encoded and have no
	 * business leaving the Host process.
	 */
	list() {
		return [...this.sessions.values()].map((session) => ({
			id: session.id,
			deviceId: session.deviceId,
			deviceName: session.deviceName,
			host: session.host,
			username: session.username,
			openedAt: session.openedAt,
			lastActivityAt: new Date(session.lastActivityAt).toISOString(),
			from: session.from,
			bytesIn: session.bytesIn,
			bytesOut: session.bytesOut,
		}));
	}

	get count() {
		return this.sessions.size;
	}
}
