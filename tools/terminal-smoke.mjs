/**
 * Offline test for the terminal feature's Host half.
 *
 * `src/terminal.js` and `src/terminal-route.js` are the two places where a
 * mistake hands out something real: a live shell on a production device, held
 * open after everyone has forgotten about it. So this suite drives both through
 * their own entry points — the session manager's public methods, and the
 * upgrade route's frame handler — against injected transports, and asserts on
 * what actually crossed the boundary: the bytes written to the PTY, the frames
 * sent to the WebSocket, the audit records on disk, and the timers armed.
 *
 * The thing it CANNOT check is the ssh2 handshake itself; `openShell` is
 * injected everywhere so the protocol logic is exercised without a peer.
 *
 * Run: node tools/terminal-smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const failures = [];
let checks = 0;
/** Assert a condition, recording failures instead of throwing. */
function ok(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
		failures.push(label);
	}
}
/** Assert equality with a readable diff. */
function eq(label, actual, expected) {
	ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// The audit log resolves its path from DSH_HOME at call time, so point it at a
// scratch directory before importing anything that writes. DSH_PROFILE_DIR is
// kept pointed at a real profile so `softImport("ws")` can still be checked:
// an uninstalled `ws` must be reported as "not checked", never as a pass.
const scratch = mkdtempSync(join(tmpdir(), "ddm-terminal-"));
process.env.DSH_HOME = scratch;
if (process.env.DSH_PROFILE_DIR === undefined) {
	process.env.DSH_PROFILE_DIR = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "desktop");
}

const { TerminalManager, hostAllowed, cidrMatch, normalizeIp, MIN_IDLE_MS, MAX_SESSIONS_PER_DEVICE, MAX_SESSIONS_TOTAL } = await import("../src/terminal.js");
const { makeTerminal, TERMINAL_PATH } = await import("../src/terminal-route.js");
const { API_BASE, API } = await import("../src/routes.js");
const { readAudit } = await import("../src/logs.js");
const { softImport } = await import("../src/resolve.js");

//#region helpers

/** A device row shaped the way the manager expects one. */
function device(id, overrides = {}) {
	return { id, name: `Box ${id}`, host: `10.0.0.${id.length}`, port: 22, username: "root", auth: { kind: "password", password: "p" }, ...overrides };
}

/**
 * A PTY stream the test drives by hand.
 *
 * A stub that merely recorded `write` calls would prove nothing about the
 * plumbing BETWEEN the socket and the shell, which is where the bugs live, so
 * this one is a real EventEmitter: the test can emit `data` and watch a frame
 * appear, which is the actual contract.
 */
class FakeStream extends EventEmitter {
	constructor() {
		super();
		this.written = [];
		this.windows = [];
		this.stderr = new EventEmitter();
		this.closed = false;
	}
	write(data) {
		if (this.failWrite === true) throw new Error("EPIPE");
		this.written.push(data);
		return true;
	}
	setWindow(rows, cols, height, width) {
		this.windows.push({ rows, cols, height, width });
	}
	close() {
		this.closed = true;
	}
}

/** A WebSocket the test drives, keeping `readyState` honest. */
class FakeSocket extends EventEmitter {
	constructor() {
		super();
		this.readyState = 1;
		this.sent = [];
		this.closed = null;
		this.pings = 0;
	}
	send(data) {
		if (this.readyState !== 1) throw new Error("InvalidStateError");
		this.sent.push(data);
	}
	close(code, reason) {
		this.readyState = 3;
		this.closed = { code, reason };
	}
	ping() {
		this.pings += 1;
	}
	/** Every JSON frame this socket was sent, in order. */
	frames() {
		return this.sent.map((row) => JSON.parse(row));
	}
	/**
	 * Deliver one inbound frame.
	 *
	 * `raw` sends the bytes verbatim instead of JSON-encoding them, which is
	 * what a malformed frame actually looks like on the wire — encoding a
	 * string would produce valid JSON and quietly test the wrong branch.
	 */
	deliver(frame, { binary = false, raw = false } = {}) {
		// A non-string, non-Buffer payload is JSON-encoded; a string is sent
		// verbatim when `raw` is set, which is what a malformed frame actually
		// looks like on the wire.
		const payload = binary ? frame : raw ? String(frame) : JSON.stringify(frame);
		this.emit("message", Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8"), binary);
	}
}

/** Build a manager over a fixed roster with an injected PTY opener. */
function makeManager(options = {}) {
	const devices = options.devices ?? [device("a"), device("b"), device("c"), device("d")];
	const opened = [];
	const store = { find: (id) => devices.find((row) => row.id === id) };
	const manager = new TerminalManager(store, {
		getSettings: options.getSettings ?? (() => ({ enabled: true, allowedHosts: [], idleMs: 300_000 })),
		openShell: async (target) => {
			if (options.openShellFails === true) throw new Error("ssh: connect ETIMEDOUT");
			const stream = new FakeStream();
			opened.push({ target, stream });
			// The manager tears a session down through the handle it was given,
			// which in production is the whole ssh2 connection — NOT the stream
			// directly. The double must route through it, or "was the shell
			// released" would be answered by the test instead of by the product.
			return { stream, client: { end() {} }, close: () => stream.close() };
		},
		lookup: options.lookup,
	});
	return { manager, opened, devices };
}

/**
 * Swap the process timers for recorders, so an idle timeout can be inspected
 * and fired on demand rather than waited for.
 *
 * Awaited, not just called: the body is async, and restoring the real timers
 * before it finishes would make the recording racy — the assertion would
 * sometimes read a list that is still being filled.
 */
async function withFakeTimers(run) {
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const timers = [];
	globalThis.setTimeout = (fn, ms) => {
		timers.push({ fn, ms, cleared: false });
		return timers.length;
	};
	globalThis.clearTimeout = (id) => {
		const timer = timers[id - 1];
		if (timer !== undefined) timer.cleared = true;
	};
	try {
		return await run(timers);
	} finally {
		globalThis.setTimeout = realSet;
		globalThis.clearTimeout = realClear;
	}
}

/** The audit records written so far, newest first. */
function auditSince() {
	return readAudit(200);
}

/**
 * Only the rows written AFTER `before`, in the same newest-first order.
 *
 * `readAudit` is newest-first, so the new rows are at the FRONT — slicing off
 * the first `before.length` entries would discard exactly the evidence being
 * looked for. Rows are matched by value with a running tally so repeats of an
 * identical event (a second denial, a second dial) stay distinguishable.
 */
function auditAfter(before) {
	const budget = new Map();
	for (const row of before) {
		const key = JSON.stringify(row);
		budget.set(key, (budget.get(key) ?? 0) + 1);
	}
	const added = [];
	for (const row of auditSince()) {
		const key = JSON.stringify(row);
		const left = budget.get(key) ?? 0;
		if (left > 0) {
			budget.set(key, left - 1);
			continue;
		}
		added.push(row);
	}
	return added;
}

/**
 * Let an in-flight `open` finish.
 *
 * One microtask round is not enough: `manager.open` awaits the allowlist check
 * and then the dial, so the frame handler needs several turns before `session`
 * exists.
 */
async function flush(rounds = 12) {
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
//#endregion

//#region 1. address rules
console.log("\n== address rules ==");
eq("an IPv4-mapped address is unwrapped", normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
eq("a zone suffix is dropped", normalizeIp("fe80::1%eth0"), "fe80::1");
eq("a missing address is empty, never a placeholder", normalizeIp(undefined), "");
eq("surrounding space is trimmed", normalizeIp("  10.0.0.1  "), "10.0.0.1");

ok("an address inside the block matches", cidrMatch("192.168.1.5", "192.168.1.0/24"), "the common case");
ok("an address outside the block does not", !cidrMatch("192.168.2.5", "192.168.1.0/24"));
ok("a /32 is an exact match", cidrMatch("10.1.2.3", "10.1.2.3/32"));
ok("a /0 matches anything", cidrMatch("10.1.2.3", "0.0.0.0/0"), "bits === 0 is a special case: the shift is undefined");
ok("a nonsense prefix length is refused", !cidrMatch("10.1.2.3", "10.1.2.0/33"), "must not silently mean /0");
ok("an IPv6 rule falls back to false, not to a crash", !cidrMatch("::1", "::1/128"));

// An empty list means "no second lock" — safe ONLY because the caller has
// already established a loopback socket.
ok("an empty allowlist allows everything", await hostAllowed("127.0.0.1", []));
ok("a non-array allowlist allows everything", await hostAllowed("127.0.0.1", undefined));
ok("an exact address matches", await hostAllowed("127.0.0.1", ["127.0.0.1"]));
ok("an address absent from the list is refused", !(await hostAllowed("10.0.0.9", ["127.0.0.1"])));
// No source address at all is not "unknown, so allow it": it means the request
// did not arrive through the normal socket path.
ok("a request with no address is refused when a list is set", !(await hostAllowed("", ["127.0.0.1"])));
ok("a CIDR rule matches", await hostAllowed("192.168.1.7", ["192.168.1.0/24"]));
{
	const lookup = async () => [{ address: "10.9.9.9", family: 4 }];
	ok("a hostname rule resolves at check time", await hostAllowed("10.9.9.9", ["devbox.lan"], lookup));
	ok("a hostname that resolves elsewhere does not match", !(await hostAllowed("10.9.9.8", ["devbox.lan"], lookup)));
	const broken = async () => {
		throw new Error("ENOTFOUND");
	};
	ok("a hostname that does not resolve simply does not match", !(await hostAllowed("10.9.9.9", ["nope.lan"], broken)));
	ok("a literal rule is never handed to the resolver", !(await hostAllowed("10.9.9.9", ["10.9.9.1"], broken)));
}
//#endregion

//#region 2. the session manager
console.log("\n== manager: the gate ==");
{
	const { manager } = makeManager({ getSettings: () => ({ enabled: false, allowedHosts: [], idleMs: 300_000 }) });
	const result = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1", socketId: "s1" });
	eq("a disabled terminal refuses to open", result.reason, "terminal.disabled");
	eq("a refused open creates no session", manager.count, 0);
	// `enabled` must be a strict boolean. A hand-edited `"true"` or `1` reading
	// as "on" would turn the feature on for a deployment that never meant to.
	for (const value of ["true", 1, "yes", {}]) {
		const loose = makeManager({ getSettings: () => ({ enabled: value, allowedHosts: [], idleMs: 300_000 }) });
		eq(`enabled=${JSON.stringify(value)} is not truthy enough`, (await loose.manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" })).reason, "terminal.disabled");
	}
}
{
	const { manager } = makeManager();
	const result = await manager.open({ deviceId: "ghost", remoteAddress: "127.0.0.1" });
	eq("an unknown device is named as such", result.reason, "terminal.noDevice");
}
{
	// The three refusals are worded separately on purpose: "turn it on" and "you
	// are not on the list" call for completely different user actions.
	const { manager } = makeManager({ getSettings: () => ({ enabled: true, allowedHosts: ["192.168.1.0/24"], idleMs: 300_000 }) });
	const denied = await manager.open({ deviceId: "a", remoteAddress: "10.0.0.5" });
	eq("an address off the allowlist is refused", denied.reason, "terminal.hostDenied");
	ok("the refusal names the address", denied.message.includes("10.0.0.5"), denied.message);
	ok("a denied open reports its own reason, not the disabled one", denied.reason !== "terminal.disabled");
}
{
	const { manager } = makeManager({ openShellFails: true });
	const failed = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" });
	eq("a transport failure is reported as a connect failure", failed.reason, "terminal.connectFailed");
	eq("a failed connect leaves no session behind", manager.count, 0);
	const record = auditSince().find((row) => row.event === "terminal.denied");
	ok("a failed connect is audited", record !== undefined, JSON.stringify(auditSince().map((row) => row.event)));
}

console.log("\n== manager: a live session ==");
{
	const { manager, opened } = makeManager();
	const result = await manager.open({ deviceId: "a", remoteAddress: "::ffff:127.0.0.1", cols: 100, rows: 30, by: "web", socketId: "sock-1" });
	ok("a permitted open succeeds", result.ok === true, result.message);
	const session = result.session;
	ok("the session id is stable-looking and unique", /^t\d+-[a-z0-9]+$/.test(session.id), session.id);
	eq("the session names its device", session.deviceId, "a");
	eq("the source address is canonicalized", session.from, "127.0.0.1");
	eq("the owning socket is recorded", session.socketId, "sock-1");
	eq("the caller is recorded", session.by, "web");
	eq("the manager counts it", manager.count, 1);
	eq("the PTY was opened once", opened.length, 1);

	// `list()` crosses into JSON: the handles must not come with it.
	const listed = manager.list();
	eq("the list carries the session", listed.length, 1);
	eq("the list drops the PTY stream", listed[0].stream, undefined);
	eq("the list drops the teardown handle", listed[0].close, undefined);
	ok("the list carries a JSON-safe activity stamp", typeof listed[0].lastActivityAt === "string" && !Number.isNaN(Date.parse(listed[0].lastActivityAt)), listed[0].lastActivityAt);

	const openedRecord = auditSince().find((row) => row.event === "terminal.open");
	ok("opening is audited", openedRecord !== undefined);
	eq("the audit names the session", openedRecord?.session, session.id);
	// The standing rule: field names and counters, never what was typed.
	ok("the audit record carries no keystrokes", openedRecord?.data === undefined, JSON.stringify(Object.keys(openedRecord ?? {})));
}

console.log("\n== manager: caps ==");
{
	const { manager } = makeManager();
	const deviceIds = [];
	for (let index = 0; index < MAX_SESSIONS_PER_DEVICE; index += 1) {
		const row = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1", socketId: "s" });
		deviceIds.push(row.session?.id);
	}
	ok("the per-device cap is reached exactly", deviceIds.every((id) => typeof id === "string"), JSON.stringify(deviceIds));
	const overflow = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1", socketId: "s" });
	eq("one more session on the same device is refused", overflow.reason, "terminal.tooManyForDevice");
	ok("the refusal states the limit", overflow.message.includes(String(MAX_SESSIONS_PER_DEVICE)), overflow.message);
	// A different device is unaffected by the per-device cap.
	eq("another device still opens", (await manager.open({ deviceId: "b", remoteAddress: "127.0.0.1" })).ok, true);
}
{
	const { manager } = makeManager();
	let total = 0;
	for (const id of ["a", "b", "c"]) {
		for (let index = 0; index < MAX_SESSIONS_PER_DEVICE; index += 1) {
			if ((await manager.open({ deviceId: id, remoteAddress: "127.0.0.1" })).ok) total += 1;
		}
	}
	eq("the roster filled to nine", total, 9);
	eq("the last slot is available", (await manager.open({ deviceId: "d", remoteAddress: "127.0.0.1" })).ok, true);
	eq("the process-wide cap is reached", manager.count, MAX_SESSIONS_TOTAL);
	const overflow = await manager.open({ deviceId: "d", remoteAddress: "127.0.0.1" });
	eq("one more session anywhere is refused", overflow.reason, "terminal.tooManyTotal");
	ok("the refusal states the total limit", overflow.message.includes(String(MAX_SESSIONS_TOTAL)), overflow.message);
}

console.log("\n== manager: the idle timer ==");
{
	const { manager, opened } = makeManager({ getSettings: () => ({ enabled: true, allowedHosts: [], idleMs: 5 }) });
	// A hand-edited 5 ms must not mean "expires immediately" — the floor is the
	// whole point, because what a session holds is a full shell.
	await withFakeTimers(async (timers) => {
		const result = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" });
		eq("an under-floor idle timeout is raised to the floor", timers[0]?.ms, MIN_IDLE_MS);
		eq("the session is still alive until the timer fires", manager.count, 1);
		timers[0].fn();
		eq("the idle timer actually closes the session", manager.count, 0);
		eq("the closed session's PTY handle is dropped", opened[0].stream.closed, true);
		const record = auditSince().find((row) => row.event === "terminal.close");
		eq("the idle close names its reason", record?.reason, "空闲超时");
	});
}
{
	const { manager } = makeManager({ getSettings: () => ({ enabled: true, allowedHosts: [], idleMs: Number.NaN }) });
	await withFakeTimers(async (timers) => {
		await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" });
		eq("a non-numeric idle timeout falls back to the default", timers[0]?.ms, 300_000);
	});
}
{
	const { manager } = makeManager();
	await withFakeTimers(async (timers) => {
		const { session } = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" });
		timers[0].cleared = false;
		manager.touch(session.id);
		eq("activity re-arms the countdown", timers.length, 2);
		eq("the old countdown is cancelled", timers[0].cleared, true);
		eq("the new countdown is the configured one", timers[1].ms, 300_000);
	});
}
{
	const { manager } = makeManager();
	await withFakeTimers(async (timers) => {
		await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" });
		manager.touch("no-such-session");
		eq("touching an unknown session arms nothing", timers.length, 1);
	});
}

console.log("\n== manager: closing ==");
{
	const { manager } = makeManager();
	const { session } = await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1", socketId: "sock-A" });
	session.bytesIn = 12;
	session.bytesOut = 34;
	eq("a session closes once", manager.close(session.id), true);
	eq("a second close reports nothing happened", manager.close(session.id), false);
	eq("the session is gone", manager.count, 0);
	const record = auditSince().find((row) => row.event === "terminal.close");
	eq("the close audit counts what went in", record?.bytesIn, 12);
	eq("the close audit counts what came out", record?.bytesOut, 34);
	ok("the close audit carries a duration", typeof record?.durationMs === "number" && record.durationMs >= 0, JSON.stringify(record?.durationMs));
}
{
	// The guard that matters: an empty socket id must NOT be read as "all of
	// them". Session ids default to "" too, so without it one unknown disconnect
	// would close every terminal in the process.
	const { manager } = makeManager();
	await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1", socketId: "" });
	await manager.open({ deviceId: "b", remoteAddress: "127.0.0.1", socketId: "sock-B" });
	eq("an empty socket id closes nothing", manager.closeBySocket(""), 0);
	eq("both sessions survive", manager.count, 2);
	eq("an unknown socket id closes nothing", manager.closeBySocket("nope"), 0);
	eq("both sessions still survive", manager.count, 2);
	eq("the matching socket id closes one", manager.closeBySocket("sock-B"), 1);
	eq("only the matching session went", manager.count, 1);
}
{
	const { manager } = makeManager();
	await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1", socketId: "same" });
	await manager.open({ deviceId: "b", remoteAddress: "127.0.0.1", socketId: "same" });
	eq("one socket can own one session per open", manager.count, 2);
	eq("closing by socket takes both of its sessions", manager.closeBySocket("same"), 2);
	eq("nothing is left", manager.count, 0);
}
{
	const { manager, opened } = makeManager();
	await manager.open({ deviceId: "a", remoteAddress: "127.0.0.1" });
	await manager.open({ deviceId: "b", remoteAddress: "127.0.0.1" });
	manager.closeAll("插件已停用");
	eq("closeAll leaves nothing behind", manager.count, 0);
	ok("closeAll tears down every PTY", opened.every((row) => row.stream.closed), JSON.stringify(opened.map((row) => row.stream.closed)));
	const record = auditSince().find((row) => row.event === "terminal.close" && row.reason === "插件已停用");
	ok("closeAll records the reason it was given", record !== undefined);
}
//#endregion

//#region 3. the upgrade route
console.log("\n== route: registration ==");
{
	const { manager, route } = makeTerminal({ find: () => undefined }, { getSettings: () => ({ enabled: false }) });
	eq("the terminal has its own path", route.path, `${API_BASE}/terminal`);
	eq("that path is the exported constant", route.path, TERMINAL_PATH);
	ok("it is NOT the read-only terminal status route", route.path !== API.terminal, `${route.path} vs ${API.terminal}`);
	eq("the manager is returned alongside the route", typeof manager.open, "function");
}

console.log("\n== route: the loopback fence ==");
{
	// An upgrade request never passes through the JSON route guard — the server
	// hands it straight to this handler — so the fence has to be repeated here.
	// Without this assertion, a LAN-exposed deployment would hand out a shell.
	const { route } = makeTerminal({ find: () => undefined }, {});
	const writes = [];
	const socket = {
		writes,
		destroyed: false,
		write(chunk) {
			writes.push(String(chunk));
		},
		destroy() {
			this.destroyed = true;
		},
	};
	const req = { method: "GET", url: TERMINAL_PATH, socket: { remoteAddress: "192.168.1.50" }, headers: { host: "192.168.1.50:19387", origin: "http://192.168.1.50:19387" } };
	await route.handler(req, socket, Buffer.alloc(0));
	ok("a non-loopback upgrade is refused", writes.join("").includes("403"), writes.join(""));
	ok("the refused socket is destroyed, not left half-open", socket.destroyed === true);

	// A refusal that leaves no trace cannot be told apart from a request that
	// never arrived — both produce an empty audit. The user hit exactly this:
	// 「无法建立终端连接」 with no server-side row to explain it. So the
	// upgrade is recorded BEFORE the fence decides, and the refusal is recorded
	// again with its inputs.
	const attempt = auditSince().find((row) => row.event === "terminal.upgrade");
	ok("an upgrade attempt is audited before it is judged", attempt !== undefined, JSON.stringify(auditSince().map((row) => row.event)));
	eq("the attempt records the Host header the fence reads", attempt?.host, "192.168.1.50:19387");
	eq("the attempt records the Origin the fence reads", attempt?.origin, "http://192.168.1.50:19387");
	eq("the attempt records the caller address", attempt?.from, "192.168.1.50");
	const denied = auditSince().find((row) => row.event === "terminal.upgradeDenied");
	ok("a refused upgrade says so out loud", denied !== undefined, JSON.stringify(auditSince().map((row) => row.event)));
	eq("the refusal names the same host", denied?.host, "192.168.1.50:19387");
	eq("the refusal carries the origin that caused it", denied?.origin, "http://192.168.1.50:19387");
	// Headers only. A shell's upgrade carries cookies on some deployments, and
	// an audit row is forever.
	ok("the attempt audit carries no cookie header", attempt?.cookie === undefined, JSON.stringify(Object.keys(attempt ?? {})));
	ok("the attempt audit carries no credential", attempt?.authorization === undefined, JSON.stringify(Object.keys(attempt ?? {})));
}
{
	// And a loopback request must get past the fence: proving only the 403 would
	// be satisfied by a handler that refuses everything. A REAL `net.Socket` is
	// used here rather than a stub, because past the fence the handler hands the
	// socket to `ws`, whose `handleUpgrade` drives the genuine handshake — a
	// three-property fake would only prove that the fake was not a socket.
	const net = await import("node:net");
	const { route } = makeTerminal({ find: () => undefined }, {});
	// Baseline the audit BEFORE the call: the previous block deliberately
	// provoked a denial, so counting denials globally would fail on a correct
	// handler. Only rows this call adds are this call's evidence.
	const auditBefore = auditSince();
	const socket = new net.Socket();
	const written = [];
	socket.on("error", () => {});
	const realWrite = socket.write.bind(socket);
	socket.write = (chunk, ...rest) => {
		written.push(String(chunk));
		return realWrite(chunk, ...rest);
	};
	const req = {
		method: "GET",
		url: TERMINAL_PATH,
		socket: { remoteAddress: "127.0.0.1", remotePort: 1234 },
		headers: { host: "127.0.0.1:19387", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": Buffer.alloc(16).toString("base64"), "sec-websocket-version": "13" },
	};
	try {
		await route.handler(req, socket, Buffer.alloc(0));
	} catch {
		// The handshake cannot complete without a peer; what matters is that the
		// fence let the request through to it rather than refusing it.
	}
	ok("a loopback upgrade is not refused by the fence", !written.join("").includes("403"), written.join("").slice(0, 200));
	ok("the loopback socket is not destroyed by the fence", socket.destroyed === false);
	// The other half of the pair: a request that gets through must NOT be
	// recorded as denied. Asserting only the 403 case would be satisfied by a
	// handler that audits a denial and then proceeds anyway.
	const added = auditAfter(auditBefore);
	const deniedForLoopback = added.filter((row) => row.event === "terminal.upgradeDenied");
	eq("a loopback upgrade is not recorded as refused", deniedForLoopback.length, 0);
	const attemptForLoopback = added.filter((row) => row.event === "terminal.upgrade");
	ok("a loopback upgrade is still recorded as attempted", attemptForLoopback.length === 1, JSON.stringify(added.map((row) => row.event)));
	socket.destroy();
}

console.log("\n== route: the ws module unwrap ==");
{
	// `ws` is CommonJS, so an ESM import yields a namespace whose default IS
	// module.exports. Reading only the top level finds nothing and reports "ws
	// is unavailable" on a Host where it is installed — this is the regression.
	const wsModule = await softImport("ws");
	if (wsModule === undefined) {
		ok("the ws module was resolvable, so the unwrap is not covered here", false, "ws is not installed in this environment; set DSH_PROFILE_DIR to a profile that has it");
	} else {
		const topLevel = wsModule?.WebSocketServer;
		const unwrapped = topLevel === undefined ? wsModule?.default : wsModule;
		ok("the top level alone would not have found the constructor", topLevel === undefined,
			"if this starts passing, the unwrap in terminal-route.js can be simplified");
		ok("the unwrapped namespace exposes WebSocketServer", typeof (unwrapped?.WebSocketServer ?? unwrapped?.Server) === "function");
	}
}
{
	// The third silent exit: a Host with no `ws` answers 503, and the browser
	// shows the SAME 「无法建立终端连接」 it shows for a refusal. So the 503 has
	// to be recorded too, or the two remain indistinguishable from the log.
	// Reaching this branch needs the import itself to fail, which the real
	// resolver cannot be made to do here.
	const { route } = makeTerminal({ find: () => undefined }, { loadWs: async () => undefined });
	// A REAL socket, not a stub. With a stub, ignoring the injected loader makes
	// the real `ws` reach `socket.on` and crash on the missing method — which
	// catches the mutant for an incidental reason instead of the intended one.
	// A real socket keeps the failure inside the assertions.
	const net = await import("node:net");
	const socket = new net.Socket();
	const writes = [];
	socket.on("error", () => {});
	const realWrite = socket.write.bind(socket);
	socket.write = (chunk, ...rest) => {
		writes.push(String(chunk));
		return realWrite(chunk, ...rest);
	};
	// Loopback on purpose: the 503 must be reached by a caller who PASSED the
	// fence, otherwise this would only re-test the 403.
	const before = auditSince();
	await route.handler(
		{ method: "GET", url: TERMINAL_PATH, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19387" } },
		socket,
		Buffer.alloc(0),
	);
	const added = auditAfter(before);
	ok("a Host without ws answers 503", writes.join("").includes("503"), writes.join(""));
	ok("the unusable-host socket is closed", socket.destroyed === true);
	ok("a missing ws module is audited, not just logged",
		added.some((row) => row.event === "terminal.upgradeUnavailable"),
		JSON.stringify(added.map((row) => row.event)));
	const unavailable = added.find((row) => row.event === "terminal.upgradeUnavailable");
	eq("the unusable-host record names the caller", unavailable?.from, "127.0.0.1");
	eq("a passed fence is still recorded as attempted", added.filter((row) => row.event === "terminal.upgrade").length, 1);
	eq("a loopback caller is not recorded as refused on the 503 path", added.filter((row) => row.event === "terminal.upgradeDenied").length, 0);
}
//#endregion

//#region 4. the frame protocol
console.log("\n== frames: opening ==");
{
	const { manager } = makeManager();
	const ws = new FakeSocket();
	const stream = new FakeStream();
	/** Drive `serve` through the module's own export, over a fake socket. */
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 5555 } }, manager, undefined);
	ws.deliver({ t: "ready" });
	eq("a frame before `open` is refused, not ignored", ws.frames().pop().reason, "terminal.noSession");
	ok("nothing was written to a PTY that does not exist", stream.written.length === 0);

	ws.deliver({ t: "open", deviceId: "a", cols: 120, rows: 40, by: "web" });
	await flush();
	const ready = ws.frames().find((row) => row.t === "ready");
	ok("the open is answered with ready", ready !== undefined, JSON.stringify(ws.frames()));
	eq("ready names the device", ready?.session?.deviceId, "a");
	ok("ready carries the limits so the UI can word its refusal", ready?.limits?.maxPerDevice === MAX_SESSIONS_PER_DEVICE && ready?.limits?.maxTotal === MAX_SESSIONS_TOTAL, JSON.stringify(ready?.limits));
	eq("the session exists on the manager", manager.count, 1);
}
{
	const { manager } = makeManager({ getSettings: () => ({ enabled: false }) });
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 1 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	await flush();
	const error = ws.frames().find((row) => row.t === "error");
	eq("a refusal is reported as an error frame", error?.reason, "terminal.disabled");
	// A refusal is terminal: leaving the socket open invites a retry loop against
	// a device that has already said no.
	eq("a refused socket is closed with a policy code", ws.closed?.code, 1008);
	eq("the close reason is the machine-readable one", ws.closed?.reason, "terminal.disabled");
	eq("a refused open created no session", manager.count, 0);
}
{
	const { manager } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 2 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	ws.deliver({ t: "open", deviceId: "b" });
	await flush();
	eq("a second open on the same socket is ignored", manager.count, 1);
	eq("exactly one ready frame was sent", ws.frames().filter((row) => row.t === "ready").length, 1);
}
{
	const { manager } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 3 } }, manager, undefined);
	ws.deliver("not json at all", { raw: true });
	eq("an unparseable frame is reported", ws.frames().pop().reason, "terminal.badFrame");
	ws.deliver(null);
	ws.deliver(42);
	eq("a non-object frame is ignored without a spurious error", ws.frames().length, 1, JSON.stringify(ws.frames()));
	// A binary frame is not JSON, so it is dropped rather than misparsed.
	ws.deliver(Buffer.from("binary junk"), { binary: true });
	eq("a binary frame is ignored", ws.frames().length, 1);
}

console.log("\n== frames: input and resize ==");
{
	const { manager, opened } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 4 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	await flush();
	const stream = opened[0].stream;

	ws.deliver({ t: "in", data: "ls -la\r" });
	eq("input is forwarded byte for byte", stream.written.join(""), "ls -la\r");
	eq("an empty input is not written", (ws.deliver({ t: "in", data: "" }), stream.written.length), 1);
	eq("a non-string input is not written", (ws.deliver({ t: "in", data: 12 }), stream.written.length), 1);
	// A carriage return is what confirms a line in a raw-mode PTY; a newline
	// leaves the command typed but unexecuted, which reads as "the terminal is
	// broken". The Host must not rewrite it either way.
	ws.deliver({ t: "in", data: "echo hi\n" });
	eq("the Host does not rewrite the terminator", stream.written[1], "echo hi\n");

	// Ctrl+C arrives as ONE byte, not as a line.
	ws.deliver({ t: "in", data: "\u0003" });
	eq("a control byte is forwarded as itself", stream.written[2], "\u0003");

	stream.failWrite = true;
	ws.deliver({ t: "in", data: "boom" });
	stream.failWrite = false;
	eq("a write failure is reported, not swallowed", ws.frames().pop().reason, "terminal.writeFailed");

	const oversized = "x".repeat(8 * 1024 + 1);
	ws.deliver({ t: "in", data: oversized });
	eq("an oversized input is refused", ws.frames().pop().reason, "terminal.inputTooLarge");
	eq("the oversized input never reached the PTY", stream.written.length, 3);

	ws.deliver({ t: "resize", cols: 9999, rows: 1 });
	eq("a resize reaches the PTY", stream.windows.length, 1);
	eq("the column count is clamped", stream.windows[0].cols, 400);
	eq("the row count is clamped", stream.windows[0].rows, 5);
	ws.deliver({ t: "resize", cols: "wide", rows: undefined });
	eq("a nonsense resize falls back rather than throwing", stream.windows[1].cols, 80);
	eq("the row fallback is the default too", stream.windows[1].rows, 24);
}

console.log("\n== frames: output ==");
{
	const { manager, opened } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 5 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	await flush();
	const stream = opened[0].stream;

	// Base64 is the whole point: a PTY emits arbitrary bytes, and a UTF-8
	// round-trip turns every invalid sequence into U+FFFD, which visibly
	// corrupts vim and top.
	stream.emit("data", Buffer.from([0x41, 0xff, 0x42]));
	const out = ws.frames().find((row) => row.t === "out");
	eq("output is base64", out.data, Buffer.from([0x41, 0xff, 0x42]).toString("base64"));
	ok("the undecodable byte survives the trip", Buffer.from(out.data, "base64").equals(Buffer.from([0x41, 0xff, 0x42])));
	ok("the session counts what came out", manager.list()[0].bytesOut === 3, String(manager.list()[0].bytesOut));

	stream.stderr.emit("data", Buffer.from("warn\n"));
	eq("stderr is forwarded as output too", ws.frames().filter((row) => row.t === "out").length, 2);

	// A large burst is chunked so one frame cannot balloon the socket buffer.
	stream.emit("data", Buffer.alloc(64 * 1024 * 2 + 5, 0x61));
	eq("an oversized burst is chunked", ws.frames().filter((row) => row.t === "out").length, 5);

	stream.emit("error", new Error("ECONNRESET"));
	eq("a stream error is reported", ws.frames().pop().reason, "terminal.streamError");

	stream.emit("close");
	eq("the shell ending is announced", ws.frames().some((row) => row.t === "exit"), true);
	eq("the session is torn down when the shell ends", manager.count, 0);
	eq("the socket is closed, not left hanging", ws.closed?.code, 1000);
}

console.log("\n== frames: teardown ==");
{
	const { manager, opened } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 6 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	await flush();
	ws.deliver({ t: "close" });
	eq("an explicit close ends the session", manager.count, 0);
	eq("the socket is closed normally", ws.closed?.code, 1000);
	eq("the PTY is released", opened[0].stream.closed, true);
}
{
	// The event a browser tab closing produces. Without this the session — and
	// the shell on the device — outlives the panel that showed it.
	const { manager, opened } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 7 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	await flush();
	ws.emit("close");
	eq("a dropped socket ends its session", manager.count, 0);
	eq("a dropped socket releases the PTY", opened[0].stream.closed, true);
	const record = auditSince().find((row) => row.event === "terminal.close" && row.reason === "连接已断开");
	ok("the drop is audited with its reason", record !== undefined);
}
{
	const { manager } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 8 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	await flush();
	ws.emit("error", new Error("boom"));
	eq("a socket error ends its session too", manager.count, 0);
}
{
	// The socket id must be derived from the connection, never from anything the
	// client sends: a client-supplied id could claim another live terminal's
	// socket and close it out from under its user.
	const { manager } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 9 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a", socketId: "sock-of-another-terminal" });
	await flush();
	const session = manager.list()[0];
	ok("the session's socket id is derived server-side", session !== undefined, "no session opened");
	const record = auditSince().find((row) => row.event === "terminal.open" && row.deviceId === "a" && row.session === session?.id);
	ok("opening was audited even though the client claimed a socket id", record !== undefined);
	// Prove the claim was not honoured: closing the OTHER id must not touch it.
	eq("a client-claimed socket id closes nothing", manager.closeBySocket("sock-of-another-terminal"), 0);
	eq("the session is untouched by the claim", manager.count, 1);
}
{
	// A socket that goes away mid-dial. `finish` already ran by the time the
	// dial resolves, and its `session === undefined` branch had nothing to
	// close — so unless the route closes the PTY right here, it stays attached
	// to the device with nobody holding its handle.
	//
	// The `close` event is deliberately NOT emitted. A browser does not
	// guarantee `onclose` after a transport error (which is why the client
	// keeps its own connect guard), and a test that emits it lets the ordinary
	// teardown path cover for a missing mid-dial guard — which is exactly how
	// this mutation survived the first time.
	const { manager } = makeManager();
	const ws = new FakeSocket();
	const { serveTerminal } = await import("../src/terminal-route.js");
	serveTerminal(ws, { socket: { remoteAddress: "127.0.0.1", remotePort: 10 } }, manager, undefined);
	ws.deliver({ t: "open", deviceId: "a" });
	ws.readyState = 3;
	await flush();
	eq("no frame is sent to a dead socket", ws.frames().filter((row) => row.t === "ready").length, 0);
	eq("the PTY is released without waiting for a close event", manager.count, 0);
}
//#endregion

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
	console.log(`ALL PASS — ${checks}/${checks} checks`);
} else {
	console.log(`FAILURES — ${checks - failures.length}/${checks} checks`);
	for (const label of failures) console.log(`  - ${label}`);
	process.exitCode = 1;
}
