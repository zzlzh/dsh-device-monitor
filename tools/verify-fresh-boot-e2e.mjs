/**
 * The whole deliverable, booted fresh in one process.
 *
 * Every other suite isolates one layer. This one mounts the plugin's real
 * `apply()` against a mock cordis context, publishes its real routes on a real
 * HTTP server, and drives the full stack against a real `ssh2.Server`
 * impersonating a busybox device — roster, loopback fence, SSH auth, metric
 * collection, alert evaluation, history, exec, and all four Agent tools.
 *
 * It exists because the running Harness still holds a pre-fix module (HMR's
 * module roots are empty and it excludes `/node_modules/`, so a plugin mounted
 * there cannot be hot-reloaded). This is what the host will do on its next
 * boot, proven without waiting for one.
 *
 * Fully isolated: a scratch `DSH_HOME`, so the user's real roster is untouched.
 *
 * Run: node tools/verify-fresh-boot-e2e.mjs
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

const PLUGIN = ROOT_URL;
const REAL_PROFILE = dshHomePosix() + "/profiles/desktop";
const ASAR_TOOLS = ASAR_TOOLS_URL;

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

//#region an isolated home that still resolves the real dependencies
const scratch = mkdtempSync(join(tmpdir(), "ddm-fresh-"));
const profileDir = join(scratch, "profiles", "freshboot");
mkdirSync(join(profileDir, "node_modules", "@deepseek-ai"), { recursive: true });
writeFileSync(join(profileDir, "package.json"), JSON.stringify({ name: "ddm-freshboot", version: "0.0.0" }, null, 2));

process.env.DSH_HOME = scratch;
// Deliberately NOT setting DSH_PROFILE_DIR: that is the exact environment
// shape in which the live Host failed with
//   cannot load the ssh2 module: Cannot find module 'ssh2'
// so this run doubles as proof that the resolution fix reaches the real
// dependency without relying on an environment variable pointing at it.
process.env.DSH_PROFILE = "freshboot";
delete process.env.DSH_PROFILE_DIR;

/**
 * Thin forwarders rather than copies: the plugin's own resolution ladder must
 * still find them in the profile, and the implementations must be the real
 * ones (the same ssh2 the host uses, the same `defineTool` from the asar).
 */
mkdirSync(join(profileDir, "node_modules", "ssh2"), { recursive: true });
writeFileSync(join(profileDir, "node_modules", "ssh2", "package.json"), JSON.stringify({ name: "ssh2", version: "0.0.0", main: "index.cjs" }, null, 2));
writeFileSync(join(profileDir, "node_modules", "ssh2", "index.cjs"), `module.exports = require(${JSON.stringify(`${REAL_PROFILE}/node_modules/ssh2`)});\n`);

const toolsStub = join(profileDir, "node_modules", "@deepseek-ai", "dsh-tools");
mkdirSync(toolsStub, { recursive: true });
writeFileSync(join(toolsStub, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-tools", version: "0.0.0", type: "module", main: "index.mjs", exports: { ".": "./index.mjs" } }, null, 2));
writeFileSync(join(toolsStub, "index.mjs"), `export * from "${ASAR_TOOLS}";\nexport { default } from "${ASAR_TOOLS}";\n`);

const require = createRequire(join(profileDir, "index.js"));
const { Server, utils } = require("ssh2");
check("the scratch profile resolves the REAL ssh2", typeof Server === "function" && typeof utils?.generateKeyPairSync === "function");
//#endregion

//#region the fake busybox device
const PASSWORD = "correct-horse";
const FIXTURES = {
	"cat /proc/stat": "cpu  1200 30 400 8000 20 0 15 0 0 0\ncpu0 600 15 200 4000 10 0 7 0 0 0\ncpu1 600 15 200 4000 10 0 8 0 0 0\n",
	"cat /proc/meminfo": "MemTotal:        1024000 kB\nMemFree:          204800 kB\nMemAvailable:     409600 kB\nBuffers:           30720 kB\nCached:           204800 kB\n",
	"cat /proc/uptime 2>/dev/null": "86400.55 345600.20\n",
	// Two reads in one command: the averages plus the logical-CPU tally they are
	// only interpretable against (see src/collectors.js#parseLoadavg).
	"cat /proc/loadavg 2>/dev/null; grep -c '^cpu[0-9]' /proc/stat 2>/dev/null || true": "0.15 0.10 0.05 1/128 4321\n2\n",
	"cat /proc/cpuinfo 2>/dev/null | head -40 || true": "processor\t: 0\nmodel name\t: ARMv8 Processor rev 4 (v8l)\n",
	"uname -a; cat /proc/version 2>/dev/null || true": "Linux fresh-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux\n",
	"LC_ALL=C df -P 2>/dev/null || df -P -k 2>/dev/null || true": "Filesystem  1024-blocks Used Available Capacity Mounted on\n/dev/root 7565120 6808608 756512 95% /\n",
	"ls /proc | grep -c '^[0-9]' 2>/dev/null || echo 0": "128\n",
	'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; n=$(cat "$z/type" 2>/dev/null); v=$(cat "$z/temp" 2>/dev/null); [ -n "$v" ] && echo "${n:-thermal} $v"; done 2>/dev/null || true': "cpu-thermal 71200\n",
	"systemctl --no-pager --no-legend list-units --type=service --state=running 2>/dev/null | awk '{print $1}' | head -30 || true": "sshd.service\n",
	"mount | head -20 2>/dev/null || true": "/dev/root on / type ext4 (rw,relatime)\n",
	"echo probe-ok": "probe-ok\n",
};

const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (client) => {
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
				const body = FIXTURES[info.command];
				if (body === undefined) { stream.exit(127); stream.end(); return; }
				stream.write(body);
				stream.exit(0);
				stream.end();
			});
		});
	});
	client.on("error", () => {});
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const sshPort = server.address().port;
console.log(`fake busybox device on 127.0.0.1:${sshPort}\n`);
//#endregion

//#region mount the real host half on a real HTTP server
const registeredTools = [];
const routeRows = [];
const sections = [];
const listeners = [];
const effects = [];
const ctx = {
	effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; },
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	webServer: { register(row) { routeRows.push(row); return () => {}; } },
	tools: { register(tool) { registeredTools.push(tool); return () => {}; } },
	systemPrompt: { section(row) { sections.push(row); return () => {}; } },
	logger: { info() {}, warn(message) { console.log("  [warn]", message); }, error(message) { console.log("  [error]", message); } },
};

const plugin = await import(`${PLUGIN}/index.js?fresh=${Date.now()}`);
check("the host half exports apply", typeof plugin.apply === "function");
plugin.apply(ctx, undefined);
await new Promise((resolve) => setTimeout(resolve, 300));

check("the host half mounted five Agent tools", registeredTools.length === 5, registeredTools.map((tool) => tool.name).join(", "));
// Exact set, not a count: a count is reddened by an ADDED route and stays green
// when one route is REPLACED by another. See verify-host-boot.mjs for the list.
const EXPECTED_ROUTES = [
	"/api/dsh-device-monitor/overview",
	"/api/dsh-device-monitor/devices",
	"/api/dsh-device-monitor/test",
	"/api/dsh-device-monitor/test-draft",
	"/api/dsh-device-monitor/collect",
	"/api/dsh-device-monitor/metrics",
	"/api/dsh-device-monitor/exec",
	"/api/dsh-device-monitor/settings",
	"/api/dsh-device-monitor/catalog",
	"/api/dsh-device-monitor/watch",
	"/api/dsh-device-monitor/rawlog",
	"/api/dsh-device-monitor/incidents",
	"/api/dsh-device-monitor/audit",
	"/api/dsh-device-monitor/logs/status",
	"/api/dsh-device-monitor/terminal/status",
];
const mounted = routeRows.map((row) => row.path).sort();
check(
	"the host half mounted exactly fifteen routes",
	EXPECTED_ROUTES.every((path) => mounted.includes(path)) && mounted.length === EXPECTED_ROUTES.length,
	`missing: ${EXPECTED_ROUTES.filter((p) => !mounted.includes(p)).join(", ") || "none"}; unexpected: ${mounted.filter((p) => !EXPECTED_ROUTES.includes(p)).join(", ") || "none"}`,
);
eq("the host half published one prompt section", sections.length, 1);
check("the host half subscribed to volatile updates", listeners.some((row) => row.event === "loader/volatile-update"));

// Serve the plugin's own routes on a real socket, with the loopback fence
// intact — the handlers do their own guarding.
const http = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const row = routeRows.find((candidate) => candidate.path === url.pathname);
	if (row === undefined) { res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); return; }
	row.handler(req, res);
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const port = http.address().port;
const BASE = `http://127.0.0.1:${port}/api/dsh-device-monitor`;

async function api(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
	const text = await response.text();
	let body; try { body = JSON.parse(text); } catch { body = text; }
	return { status: response.status, body };
}
//#endregion

try {
	console.log("\n== the roster is empty and capped at ten ==");
	const initial = await api("/overview");
	eq("overview returns 200", initial.status, 200);
	eq("the roster starts empty", initial.body.devices.length, 0);
	eq("maxDevices is 10", initial.body.maxDevices, 10);

	console.log("\n== the loopback fence holds on a real socket ==");
	// `fetch` refuses to set a `Host` header (it is a forbidden header name), so
	// the fence is probed with a raw socket instead — which is also closer to
	// what a LAN client would actually send.
	const rawStatus = await new Promise((resolve, reject) => {
		const { connect } = require("node:net");
		const socket = connect(port, "127.0.0.1", () => {
			socket.write("GET /api/dsh-device-monitor/overview HTTP/1.1\r\nHost: example.com:1234\r\nConnection: close\r\n\r\n");
		});
		let data = "";
		socket.on("data", (chunk) => { data += chunk; });
		socket.on("end", () => resolve({ status: Number(data.split(" ")[1]), data }));
		socket.on("error", reject);
	});
	eq("a non-loopback Host header is refused", rawStatus.status, 403);
	check("the refusal names the reason", rawStatus.data.includes("loopback-only"), rawStatus.data.slice(0, 160));

	console.log("\n== register the device through the plugin's own HTTP API ==");
	const created = await api("/devices", { method: "POST", body: JSON.stringify({ name: "Fresh 01", host: "127.0.0.1", port: sshPort, username: "root", password: PASSWORD, tags: ["fresh"] }) });
	eq("create returns 201", created.status, 201);
	const id = created.body?.device?.id;
	check("the device got an id", typeof id === "string" && id.length > 0, JSON.stringify(created.body));
	eq("the password was not echoed", created.body?.device?.password, undefined);
	eq("the device knows it has a password", created.body?.device?.hasPassword, true);

	console.log("\n== SSH over the plugin's own stack ==");
	const tested = await api(`/test?id=${encodeURIComponent(id)}`, { method: "POST" });
	eq("test returns 200", tested.status, 200);
	eq("the SSH connection succeeded", tested.body?.result?.ok, true);
	check("a latency was measured", typeof tested.body?.result?.latencyMs === "number", JSON.stringify(tested.body?.result));

	const collected = await api(`/collect?id=${encodeURIComponent(id)}`, { method: "POST" });
	eq("collect returns 200", collected.status, 200);
	const result = collected.body?.results?.[0];
	eq("the collection reported success", result?.ok, true);
	const sample = result?.sample;
	check("a sample came back", sample !== undefined, JSON.stringify(collected.body).slice(0, 240));
	eq("cpu cores", sample?.cpu?.cores, 2);
	eq("cpu model", sample?.model, "ARMv8 Processor rev 4 (v8l)");
	eq("memory total MB", sample?.memory?.totalMB, 1000);
	eq("memory usage percent", sample?.memory?.usagePercent, 60);
	eq("uptime ms", sample?.uptimeMs, 86400550);
	eq("load 1m", sample?.load?.load1, 0.15);
	// The load reading carries its own core count, so a device with the CPU
	// metric switched off can still state what its load is measured against.
	eq("load carries its own core count", sample?.load?.cores, 2);
	eq("processes", sample?.processes, 128);
	eq("kernel", sample?.kernel, "Linux fresh-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux");
	eq("root filesystem usage", sample?.disk?.[0]?.usagePercent, 95);
	eq("thermal celsius", sample?.thermal?.[0]?.celsius, 71.2);

	console.log("\n== alerts, history, and exec ==");
	const overview = await api("/overview");
	const row = overview.body.devices.find((entry) => entry.id === id);
	check("the device appears in the overview", row !== undefined, JSON.stringify(overview.body).slice(0, 240));
	check("no collection error was recorded", row?.error === undefined, JSON.stringify(row?.error));
	const diskAlert = (row?.alerts ?? []).find((alert) => String(alert.metric) === "disk");
	check("the 95% root filesystem raised a disk alert", diskAlert !== undefined, JSON.stringify(row?.alerts));
	eq("the alert names the mount", diskAlert?.mount, "/");
	eq("the alert carries the value", diskAlert?.rawValue, 95);
	check("the alert carries a human message", typeof diskAlert?.message === "string" && diskAlert.message.includes("95"), diskAlert?.message);

	const series = await api(`/metrics?id=${encodeURIComponent(id)}&limit=10`);
	eq("metrics returns 200", series.status, 200);
	check("history accumulated a sample", Array.isArray(series.body?.series) && series.body.series.length >= 1, JSON.stringify(series.body).slice(0, 160));
	eq("metrics reports no error", series.body?.error, undefined);

	const exec = await api(`/exec?id=${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ command: "echo probe-ok" }) });
	eq("exec returns 200", exec.status, 200);
	eq("stdout round-trips", exec.body?.result?.stdout, "probe-ok\n");
	eq("exit code is 0", exec.body?.result?.code, 0);

	console.log("\n== the five Agent tools render through the REAL defineTool ==");
	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	for (const name of ["device_list", "device_status", "device_collect", "device_exec", "device_history"]) {
		const tool = byName.get(name);
		if (tool === undefined) { check(`${name} is registered`, false); continue; }
		check(`${name} exposes a callable render`, typeof tool.output?.render === "function");
		const args = name === "device_collect" ? {} : name === "device_exec" ? { id, command: "echo probe-ok" } : { id };
		let value;
		try { value = await tool.execute(args); } catch (error) { check(`${name} executes`, false, String(error?.message ?? error)); continue; }
		let blocks;
		try { blocks = tool.output.render(args, value); } catch (error) { check(`${name} renders without throwing`, false, `${error?.message ?? error}`); continue; }
		check(`${name} renders without throwing`, true);
		check(`${name} returns a text block`, Array.isArray(blocks) && blocks[0]?.type === "text" && typeof blocks[0]?.text === "string", JSON.stringify(blocks)?.slice(0, 140));
	}

	const listText = byName.get("device_list").output.render({}, await byName.get("device_list").execute({}))[0].text;
	check("device_list renders the roster name", listText.includes("Fresh 01"), listText.slice(0, 200));
	check("device_list renders a markdown table", listText.includes("|"), listText.slice(0, 200));
	const statusText = byName.get("device_status").output.render({ id }, await byName.get("device_status").execute({ id }))[0].text;
	check("device_status reports the sampled host", statusText.includes("fresh-gw-01") || statusText.includes("Fresh 01"), statusText.slice(0, 200));

	console.log("\n== the ten-device cap ==");
	const accepted = [];
	for (let index = 0; index < 10; index += 1) {
		accepted.push(await api("/devices", { method: "POST", body: JSON.stringify({ name: `Fresh cap ${index}`, host: "127.0.0.1", username: "u" }) }));
	}
	eq("the roster stops at ten", (await api("/overview")).body.devices.length, 10);
	const refused = accepted.filter((entry) => entry.status !== 201);
	check("the overflow was refused with an explanation", refused.length > 0 && typeof refused[0]?.body?.error === "string", JSON.stringify(refused[0]?.body));

	console.log("\n== removal ==");
	const removed = await api(`/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
	eq("delete returns 200", removed.status, 200);
	check("the device is gone from the overview", !(await api("/overview")).body.devices.some((entry) => entry.id === id));
	eq("metrics for a removed device are forgotten", (await api(`/metrics?id=${encodeURIComponent(id)}`)).status, 404);
} finally {
	http.close();
	server.close();
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? "the fixed host half serves the whole deliverable end to end" : `${failures} failed`}`);
if (failures > 0) process.exit(1);
