/**
 * Live-service integration: drive the RUNNING Harness plugin API against a real
 * SSH peer.
 *
 * `ssh-integration.mjs` proves the transport in isolation. This goes one level
 * up: it stands up the same fake busybox device and then talks to the plugin
 * THROUGH the running host's HTTP API, so the store, the routes, the monitor,
 * the metrics history and the alert evaluation all run in the real Host process.
 *
 * That is the closest thing to "point it at a real machine" that is possible
 * without one — and it exercises every layer above the socket.
 *
 * Run: node tools/live-ssh-e2e.mjs
 */
import { createRequire } from "node:module";
import { commandPlan } from "../src/collectors.js";

const require = createRequire(dshHomePosix() + "/profiles/desktop/x.js");
const { Server, utils } = require("ssh2");

const BASE = "http://127.0.0.1:19387/api/dsh-device-monitor";
const PASSWORD = "correct-horse";

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/**
 * Fixture bodies, keyed by the COLLECTOR KEY that `commandPlan()` uses.
 *
 * Deliberately NOT keyed by the command text. The previous version was, and the
 * command strings are long, shared with `src/collectors.js`, and get reworded
 * whenever a collector is tightened — so the map silently drifted. A miss
 * answers exit 127 with an empty body, which is INDISTINGUISHABLE from a real
 * device that has nothing to report: two stale keys turned a 95% filesystem and
 * a 71.2°C sensor into `undefined`, and four collectors (`top`, `net`,
 * `diskio`, `tcp`) had no fixture at all. Keying by collector means a renamed
 * command cannot desynchronise this file, and a collector added without a body
 * fails loudly below instead of quietly returning empty output.
 */
const BODIES = {
	procStat: "cpu  1200 30 400 8000 20 0 15 0 0 0\ncpu0 600 15 200 4000 10 0 7 0 0 0\ncpu1 600 15 200 4000 10 0 8 0 0 0\n",
	procMem: "MemTotal:        1024000 kB\nMemFree:          204800 kB\nMemAvailable:     409600 kB\nBuffers:           30720 kB\nCached:          204800 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
	procUptime: "86400.55 345600.20\n",
	loadavg: "0.15 0.10 0.05 1/128 4321\n2\n",
	cpuInfo: "processor\t: 0\nmodel name\t: ARMv8 Processor rev 4 (v8l)\n\nprocessor\t: 1\nmodel name\t: ARMv8 Processor rev 4 (v8l)\n",
	version: "Linux e2e-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux\nLinux version 5.15.0-rc1\n",
	df: "Filesystem  1024-blocks Used Available Capacity Mounted on\n/dev/root 7565120 6808608 756512 95% /\n",
	procCount: "128\n",
	thermal: "cpu-thermal 71200\n",
	services: "sshd.service\n",
	rootfs: "/dev/root on / type ext4 (rw,relatime)\n",
	// The awk ALREADY picked the columns, so these are the emitted three-field
	// forms — not the raw /proc files. See src/collectors.js#parseNetDev.
	net: "eth0 175588227558 115399948293\ndocker0 0 0\n",
	diskio: "nvme0n1 35624161 463944552\nloop0 1 2\n",
	top: "root 1 12.5 3.1\nwww-data 812 8.0 5.4\nroot 44 3.2 0.8\n",
	tcp: "17\n",
};

/** Commands that are not part of the collector plan (user-typed exec probes). */
const ADHOC = {
	// The connection banner probe from src/ssh.js: not a collector, so it has no
	// plan key to derive from. The `test` route asserts on its output.
	"uname -a 2>/dev/null || echo unknown": "Linux e2e-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux\n",
	"echo e2e-ok": "e2e-ok\n",
	"exit 3": "",
};

const PLAN = commandPlan();
const FIXTURES = new Map();
for (const [key, body] of Object.entries(BODIES)) {
	const entry = PLAN[key];
	if (entry === undefined) throw new Error(`fixture names a collector that no longer exists: ${key}`);
	FIXTURES.set(entry.cmd, body);
}
for (const [command, body] of Object.entries(ADHOC)) FIXTURES.set(command, body);
// The inverse check: a collector with no body would answer 127 and read as "the
// device reported nothing". Fail at startup, loudly, instead.
const uncovered = Object.keys(PLAN).filter((key) => !(key in BODIES));
if (uncovered.length > 0) throw new Error(`collectors have no fixture body: ${uncovered.join(", ")}`);


const hostKey = utils.generateKeyPairSync("ed25519").private;
/**
 * Every command the live Host actually sent. R3 is a promise about the WIRE, so
 * the only way to check it is to look at what arrived at the device — an
 * assertion on the returned sample alone would pass even if the Host had
 * collected everything and merely hidden it.
 */
const SEEK = { commands: [] };
/**
 * Commands the fixture map had no answer for.
 *
 * Recorded at SERVE time, not at cleanup: `SEEK.commands` is deliberately reset
 * partway through (to measure one collection in isolation), so a cleanup-time
 * scan would only see the last window and could miss an earlier fall-through.
 * The serve site sees every command exactly once.
 */
const UNMATCHED = [];
const server = new Server({ hostKeys: [hostKey] }, (client) => {
	client.on("authentication", (authCtx) => {
		if (authCtx.method === "password" && authCtx.password === PASSWORD) return authCtx.accept();
		if (authCtx.method === "none") return authCtx.reject(["password"]);
		return authCtx.reject();
	});
	client.on("ready", () => {
		client.on("session", (accept) => {
			const session = accept();
			session.on("exec", (acceptExec, _reject, info) => {
				const stream = acceptExec();
				SEEK.commands.push(info.command);
				const body = FIXTURES.get(info.command);
				if (info.command === "exit 3") { stream.exit(3); stream.end(); return; }
				if (body === undefined) { UNMATCHED.push(info.command); stream.exit(127); stream.end(); return; }
				stream.write(body);
				stream.exit(0);
				stream.end();
			});
		});
	});
	client.on("error", () => {});
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
const PORT = server.address().port;
console.log(`fake device on port ${PORT}; driving the LIVE plugin API at ${BASE}\n`);

/** One JSON call against the live host API. */
async function api(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, {
		...options,
		headers: { "content-type": "application/json", ...(options.headers ?? {}) },
	});
	const text = await response.text();
	let body;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: response.status, body };
}

let createdId;

try {
	console.log("== remove any leftover e2e device ==");
	const before = await api("/overview");
	check("the live API answers", before.status === 200, JSON.stringify(before).slice(0, 160));
	for (const row of before.body.devices ?? []) {
		if (String(row.name).startsWith("E2E")) await api(`/devices?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
	}

	console.log("\n== register the fake device through the live API ==");
	const created = await api("/devices", {
		method: "POST",
		body: JSON.stringify({ name: "E2E 01", host: "127.0.0.1", port: PORT, username: "root", password: PASSWORD, tags: ["e2e"] }),
	});
	eq("create returns 201", created.status, 201);
	createdId = created.body?.device?.id;
	check("the device got an id", typeof createdId === "string" && createdId.length > 0, JSON.stringify(created.body));
	eq("the password is not echoed", created.body?.device?.password, undefined);
	eq("the device records that it has a password", created.body?.device?.hasPassword, true);

	console.log("\n== the live test route authenticates over real SSH ==");
	// The id travels in the query string, exactly as client.js sends it; the
	// body is reserved for the device payload (and, for exec, the command).
	const tested = await api(`/test?id=${encodeURIComponent(createdId)}`, { method: "POST" });
	eq("test returns 200", tested.status, 200);
	eq("the connection succeeded", tested.body?.result?.ok, true);
	check("a latency was measured", typeof tested.body?.result?.latencyMs === "number", JSON.stringify(tested.body?.result));
	check("the banner carries the fixture hostname", String(tested.body?.result?.banner ?? "").includes("e2e-gw-01"), JSON.stringify(tested.body?.result));

	console.log("\n== the live collect route returns a parsed sample ==");
	const collected = await api(`/collect?id=${encodeURIComponent(createdId)}`, { method: "POST" });
	eq("collect returns 200", collected.status, 200);
	const sample = collected.body?.results?.[0]?.sample;
	check("a sample came back", sample !== undefined && typeof sample === "object", JSON.stringify(collected.body).slice(0, 300));
	eq("cpu cores", sample?.cpu?.cores, 2);
	eq("memory total MB", sample?.memory?.totalMB, 1000);
	eq("kernel", sample?.kernel, "Linux e2e-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux");
	eq("root disk usage percent", sample?.disk?.[0]?.usagePercent, 95);
	eq("thermal celsius", sample?.thermal?.[0]?.celsius, 71.2);
	eq("processes", sample?.processes, 128);
	// `net` and `diskio` are rate metrics, and `publicSample()` deliberately
	// strips the raw baseline rows (`netRows`/`dioRows`) — those are internal,
	// they exist only so the NEXT poll can difference. So the wire-visible
	// evidence is `net.items` / `diskio.items`, and it only becomes non-empty on
	// a SECOND poll, once there is a baseline to difference against.
	//
	// This is asserted here because the emitted-vs-raw parse bug left both
	// items lists permanently empty: `rxTotal: null` on the first sample looks
	// like the documented "no baseline yet", so nothing looked wrong.
	const second = await api(`/collect?id=${encodeURIComponent(createdId)}`, { method: "POST" });
	const after = second.body?.results?.[0]?.sample;
	check("the second sample carries net items", (after?.net?.items ?? []).length >= 1, JSON.stringify(after?.net));
	eq("the net item carries the emitted interface", after?.net?.items?.[0]?.name, "eth0");
	check("the second sample carries diskio items", (after?.diskio?.items ?? []).length >= 1, JSON.stringify(after?.diskio));
	eq("the diskio item carries the emitted device", after?.diskio?.items?.[0]?.name, "nvme0n1");
	eq("the tcp connection count was parsed", sample?.tcp, 17);

	console.log("\n== the disk alert fires from a real collection ==");
	const overview = await api("/overview");
	check("overview returns 200", overview.status === 200);
	const row = (overview.body.devices ?? []).find((entry) => entry.id === createdId);
	check("the device appears in the overview", row !== undefined, JSON.stringify(overview.body).slice(0, 300));
	check("the device reports no collection error", row?.error === undefined, JSON.stringify(row?.error));
	check("the 95% root filesystem raised a disk alert", (row?.alerts ?? []).some((alert) => String(alert.metric) === "disk"),
		JSON.stringify(row?.alerts));
	const diskAlert = (row?.alerts ?? []).find((alert) => String(alert.metric) === "disk");
	eq("the alert names the mount", diskAlert?.mount, "/");
	// The alert carries the OBSERVED value under `rawValue` and the configured
	// ceiling under `limit`; checking only the observed value would pass even if
	// the threshold were misread.
	eq("the alert carries the observed value", diskAlert?.rawValue, 95);
	eq("the alert carries the threshold it crossed", diskAlert?.limit, 85);

	console.log("\n== metrics history accumulated in the live host ==");
	const series = await api(`/metrics?id=${encodeURIComponent(createdId)}&limit=10`);
	eq("metrics returns 200", series.status, 200);
	check("at least one sample is in history", Array.isArray(series.body?.series) && series.body.series.length >= 1,
		JSON.stringify(series.body).slice(0, 200));
	eq("the history limit is clamped", (await api(`/metrics?id=${encodeURIComponent(createdId)}&limit=99999`)).status, 200);

	console.log("\n== the live exec route runs a command on the device ==");
	const okExec = await api(`/exec?id=${encodeURIComponent(createdId)}`, { method: "POST", body: JSON.stringify({ command: "echo e2e-ok" }) });
	eq("exec returns 200", okExec.status, 200);
	eq("stdout round-trips through the live stack", okExec.body?.result?.stdout, "e2e-ok\n");
	eq("exit code is 0", okExec.body?.result?.code, 0);

	const badExec = await api(`/exec?id=${encodeURIComponent(createdId)}`, { method: "POST", body: JSON.stringify({ command: "exit 3" }) });
	eq("a non-zero exit is reported", badExec.body?.result?.code, 3);
	eq("the command was still a success at the API level", badExec.status, 200);

	console.log("\n== a bad credential fails cleanly through the live stack ==");
	const wrong = await api("/devices", {
		method: "POST",
		body: JSON.stringify({ name: "E2E 02", host: "127.0.0.1", port: PORT, username: "root", password: "wrong" }),
	});
	eq("the second device was created", wrong.status, 201);
	const wrongId = wrong.body?.device?.id;
	const wrongTest = await api(`/test?id=${encodeURIComponent(wrongId)}`, { method: "POST" });
	eq("test still returns 200 (the failure is in the result)", wrongTest.status, 200);
	eq("the connection failed", wrongTest.body?.result?.ok, false);
	check("the failure carries a message", typeof wrongTest.body?.result?.error === "string" && wrongTest.body.result.error.length > 0,
		JSON.stringify(wrongTest.body?.result));
	await api(`/devices?id=${encodeURIComponent(wrongId)}`, { method: "DELETE" });

	console.log("\n== an unknown device is refused, not crashed on ==");
	const missingTest = await api("/test?id=definitely-not-a-device", { method: "POST" });
	eq("test on an unknown id returns 404", missingTest.status, 404);
	check("the 404 names the missing device", String(missingTest.body?.error ?? "").includes("not found"), JSON.stringify(missingTest.body));
	const missingExec = await api("/exec?id=definitely-not-a-device", { method: "POST", body: JSON.stringify({ command: "true" }) });
	eq("exec on an unknown id returns 404", missingExec.status, 404);
	const missingCollect = await api("/collect?id=definitely-not-a-device", { method: "POST" });
	check("collect on an unknown id does not return a bogus success", missingCollect.status === 404 || missingCollect.body?.results?.[0]?.ok === false,
		`${missingCollect.status} ${JSON.stringify(missingCollect.body).slice(0, 120)}`);

	console.log("\n== the 10-device cap holds through the live API ==");
	const capBefore = (await api("/overview")).body.devices.length;
	const extras = [];
	for (let index = 0; index < 10; index += 1) {
		const added = await api("/devices", { method: "POST", body: JSON.stringify({ name: `E2E cap ${index}`, host: "127.0.0.1", username: "u" }) });
		extras.push(added);
	}
	const accepted = extras.filter((row) => row.status === 201).length;
	const rejected = extras.filter((row) => row.status === 400 || row.status === 409 || row.status === 403);
	eq("the roster never exceeds 10", (await api("/overview")).body.devices.length, 10);
	check("overflow registrations were refused", rejected.length > 0, `accepted ${accepted}, rejected ${rejected.length}`);
	const refusal = rejected[0];
	check("the refusal explains the cap", typeof refusal?.body?.error === "string" && refusal.body.error.length > 0, JSON.stringify(refusal?.body));
	console.log(`    (started at ${capBefore}, accepted ${accepted}, refused ${rejected.length})`);
	check("maxDevices is reported as 10", (await api("/overview")).body.maxDevices === 10);

	console.log("\n== the metric vocabulary comes from the host, not the bundle ==");
	const catalog = await api("/catalog");
	eq("catalog returns 200", catalog.status, 200);
	const keys = catalog.body?.metricKeys ?? [];
	eq("the catalog carries all eleven metric keys", keys.length, 11);
	// The reference system's column names are `mem`, not `memory`. A stale Host
	// generation answered `/metrics` with `memory` columns, which is exactly how
	// the "is the running process current?" question was settled; asserting the
	// new vocabulary keeps that from regressing silently.
	check("the vocabulary uses the reference names", keys.includes("mem") && keys.includes("temp") && !keys.includes("memory") && !keys.includes("thermal"),
		JSON.stringify(keys));
	eq("maxDevices travels with the catalog", catalog.body?.maxDevices, 10);
	check("every catalog row is labelled and hinted", (catalog.body?.catalog ?? []).every((row) => typeof row.label === "string" && row.label !== "" && typeof row.hint === "string"),
		JSON.stringify(catalog.body?.catalog));
	eq("uptime is the only always-on metric", (catalog.body?.catalog ?? []).filter((row) => row.always).map((row) => row.key).join(","), "uptime");

	console.log("\n== settings round-trip and restore ==");
	const settingsBefore = await api("/settings");
	eq("settings returns 200", settingsBefore.status, 200);
	const original = settingsBefore.body?.settings;
	eq("the default refresh interval is 60 seconds", original?.refreshIntervalSec, 60);
	eq("the defaults are the reference's", JSON.stringify(original?.thresholds), JSON.stringify({ cpu: 90, mem: 90, disk: 85, temp: 80 }));
	eq("raw logging is on by default", original?.rawLog?.enabled, true);
	const patchedSettings = await api("/settings", { method: "PATCH", body: JSON.stringify({ thresholds: { cpu: 77 } }) });
	eq("the patch returns 200", patchedSettings.status, 200);
	eq("only the touched field is reported as changed", JSON.stringify(patchedSettings.body?.changed), JSON.stringify(["thresholds.cpu"]));
	eq("the new threshold is in effect", patchedSettings.body?.settings?.thresholds?.cpu, 77);
	eq("an out-of-range threshold is clamped, not rejected", (await api("/settings", { method: "PATCH", body: JSON.stringify({ refreshIntervalSec: 99999 }) })).body?.settings?.refreshIntervalSec, 3600);
	// Restore, so a suite run does not silently reconfigure the user's panel.
	await api("/settings", { method: "PATCH", body: JSON.stringify({ thresholds: original.thresholds, refreshIntervalSec: original.refreshIntervalSec, rawLog: original.rawLog, incidents: original.incidents }) });
	const restored = (await api("/settings")).body?.settings;
	eq("the original settings were put back", JSON.stringify(restored?.thresholds), JSON.stringify(original.thresholds));

	console.log("\n== the watch lease is what gates polling ==");
	// `watch.clients` is a COUNT (`src/monitor.js:93` returns `clients: this.leases.size`),
	// not the list of ids — an earlier draft of this suite asserted an array and could
	// never have passed. And the host is not necessarily idle: the user's own panel
	// legitimately holds a lease whenever it is visible. So measure the baseline and
	// assert this client's lease moves the count by exactly one, then gives it back.
	const baseline = (await api("/overview")).body?.watch;
	check("the overview reports a watch lease count", Number.isInteger(baseline?.clients), JSON.stringify(baseline));
	const baselineCount = baseline.clients;
	const watched = await api("/watch", { method: "POST", body: JSON.stringify({ clientId: "live-e2e", intervalSec: 5 }) });
	eq("watch returns 200", watched.status, 200);
	eq("the lease is active", watched.body?.watch?.active, true);
	eq("taking a lease adds exactly one client", watched.body?.watch?.clients, baselineCount + 1);
	eq("the host converted seconds to milliseconds once", watched.body?.watch?.intervalMs, 5000);
	check("the lease carries an expiry", typeof watched.body?.watch?.expiresInMs === "number" && watched.body.watch.expiresInMs > 0, JSON.stringify(watched.body?.watch));
	const released = await api("/watch", { method: "POST", body: JSON.stringify({ clientId: "live-e2e", release: true }) });
	eq("the released lease leaves no extra clients", released.body?.watch?.clients, baselineCount);
	// A renewal must not stack: the same id keeps ONE lease, not one per heartbeat.
	const renewed = await api("/watch", { method: "POST", body: JSON.stringify({ clientId: "live-e2e", intervalSec: 5 }) });
	eq("a renewal does not stack leases", renewed.body?.watch?.clients, baselineCount + 1);
	await api("/watch", { method: "POST", body: JSON.stringify({ clientId: "live-e2e", release: true }) });
	eq("the host is left as it was found", (await api("/overview")).body?.watch?.clients, baselineCount);

	console.log("\n== the raw collected data is on disk, verbatim ==");
	const logs = await api("/logs/status");
	eq("logs status returns 200", logs.status, 200);
	check("logs status names the log directory", typeof logs.body?.dir === "string" && logs.body.dir.includes("dsh-device-monitor-logs"), JSON.stringify(logs.body?.dir));
	check("the e2e device has a raw log", (logs.body?.devices ?? []).some((row) => row.id === createdId), JSON.stringify(logs.body?.devices));
	const raw = await api(`/rawlog?id=${encodeURIComponent(createdId)}&limit=200`);
	eq("rawlog returns 200", raw.status, 200);
	const rawLines = raw.body?.lines ?? [];
	check("raw records accumulated for each collection", rawLines.length >= 2, `${rawLines.length} lines`);
	const rawText = rawLines.map((line) => (typeof line === "string" ? line : line.raw ?? JSON.stringify(line))).join("\n");
	// R6's acceptance is that the ORIGINAL text is kept — not a re-rendered
	// summary. A raw record that dropped the command text would still leave a
	// plausible-looking log, so this asserts the fixture's own bytes.
	check("the raw log keeps the command text verbatim", rawText.includes("cat /proc/uptime 2>/dev/null"), rawText.slice(0, 240));
	check("the raw log keeps the device output verbatim", rawText.includes("e2e-gw-01"), rawText.slice(0, 240));
	check("rawlog clamps its limit", (await api(`/rawlog?id=${encodeURIComponent(createdId)}&limit=999999`)).status === 200);
	const missingRaw = await api("/rawlog?id=definitely-not-a-device");
	eq("rawlog on an unknown device returns 404", missingRaw.status, 404);

	console.log("\n== audit records names, incidents record events ==");
	const audit = await api("/audit?limit=200");
	eq("audit returns 200", audit.status, 200);
	const auditText = JSON.stringify(audit.body?.audit ?? []);
	check("the audit log recorded this suite's create", auditText.includes("device.create"), auditText.slice(0, 200));
	// The audit log is a NAMES-only trail by design: a credential or a host
	// address must never appear in it. The fixture password is the canary.
	check("the audit log never carries a credential value", !auditText.includes(PASSWORD), "the fixture password leaked into the audit log");
	const incidents = await api("/incidents?limit=100");
	eq("incidents returns 200", incidents.status, 200);
	check("incidents is a list", Array.isArray(incidents.body?.incidents), JSON.stringify(incidents.body).slice(0, 200));

	console.log("\n== an unselected metric sends no command to the device ==");
	// R3's core promise, asserted at the wire: with only `mem` selected the
	// device must never be asked for /proc/stat. `ssh-integration.mjs` proves
	// this at the collector; this proves the live route passes the selection
	// through instead of quietly collecting everything.
	await api(`/devices?id=${encodeURIComponent(createdId)}`, { method: "PATCH", body: JSON.stringify({ metrics: ["uptime", "mem"] }) });
	SEEK.commands.length = 0;
	const gated = await api(`/collect?id=${encodeURIComponent(createdId)}`, { method: "POST" });
	eq("collect still returns 200", gated.status, 200);
	const gatedSample = gated.body?.results?.[0]?.sample;
	check("the unselected cpu metric is null, not zero", gatedSample?.cpu === null || gatedSample?.cpu === undefined, JSON.stringify(gatedSample?.cpu));
	check("no command touched /proc/stat", !SEEK.commands.some((command) => command.includes("/proc/stat")), SEEK.commands.join(" | "));
	check("the selected memory metric was still collected", typeof gatedSample?.memory?.usagePercent === "number", JSON.stringify(gatedSample?.memory));
	const gatedRow = (await api("/overview")).body.devices.find((entry) => entry.id === createdId);
	eq("the device reports its metric selection", JSON.stringify(gatedRow?.metrics), JSON.stringify(["uptime", "mem"]));
	// A cross-sample metric cannot have a value on its first sample; reporting
	// 0 there would draw a false flat line at the bottom of the chart.
	check("a cross-sample metric with no baseline is null, never 0", gatedSample?.net === null || gatedSample?.net === undefined, JSON.stringify(gatedSample?.net));

	console.log("\n== the series uses the new column names ==");
	const liveSeries = (await api(`/metrics?id=${encodeURIComponent(createdId)}&limit=10`)).body?.series ?? [];
	check("history rows exist", liveSeries.length >= 1, JSON.stringify(liveSeries).slice(0, 200));
	const columns = Object.keys(liveSeries[0] ?? {}).join(",");
	check("the series exposes mem, not memory", columns.includes("mem") && !columns.includes("memory"), columns);
	check("the series does not leak internal baselines", !columns.includes("procStat") && !columns.includes("netRows") && !columns.includes("dioRows"), columns);

	console.log("\n== every command the host sent had a fixture ==");
	// The fixture map is keyed by the EXACT command string, and a miss answers
	// exit 127 with an empty body — which looks exactly like a device that has
	// nothing to report. That is how two stale keys (the `df` and thermal loop
	// commands had been reworded in src/collectors.js) silently turned a 95%
	// filesystem and a 71.2°C sensor into `undefined` while every surrounding
	// assertion still passed. Read the serve-time record, not SEEK.commands:
	// that array is deliberately reset mid-run to isolate one collection, so a
	// scan of it would only cover the last window.
	eq("no command fell through to the 127 fallback", [...new Set(UNMATCHED)].join(" | "), "");

	console.log("\n== cleanup ==");
	const finalList = await api("/overview");
	for (const device of finalList.body.devices) {
		if (String(device.name).startsWith("E2E")) await api(`/devices?id=${encodeURIComponent(device.id)}`, { method: "DELETE" });
	}
	const afterCleanup = await api("/overview");
	// Only THIS suite's devices must be gone. The live profile can legitimately
	// hold the user's own devices, so asserting an empty roster would fail for
	// a reason that has nothing to do with the code under test.
	const leftovers = afterCleanup.body.devices.filter((device) => String(device.name).startsWith("E2E"));
	eq("every device this suite created is gone", leftovers.map((device) => device.name).join(","), "");
} finally {
	server.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? "the live plugin API works end to end against a real SSH peer" : `${failures} failed`}`);
if (failures > 0) process.exit(1);
