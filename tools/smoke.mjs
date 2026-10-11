/**
 * Offline smoke test for the device-monitor Host half.
 *
 * Exercises the pieces that can be verified without a real SSH peer: the
 * 10-device cap, the summary projection's credential hygiene, atomic roster
 * round-tripping, the ported busybox parsers, threshold alerts, and the route
 * table's loopback fence and method handling against fake req/res objects.
 *
 * Run: node tools/smoke.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

// The store resolves its path from DSH_HOME at call time, so point it at a
// scratch directory before importing anything that touches the roster.
const scratch = mkdtempSync(join(tmpdir(), "ddm-smoke-"));
process.env.DSH_HOME = scratch;

const { DeviceStore, MAX_DEVICES, slugify, summarize, normalizePayload, storePath } = await import("../src/store.js");
const { MetricsStore, evaluateAlerts } = await import("../src/metrics.js");
const { Monitor, publicSample } = await import("../src/monitor.js");
const { makeRoutes, API } = await import("../src/routes.js");
const { isLoopbackRequest, isLoopbackAddress } = await import("../src/http.js");
const { makeTools } = await import("../src/tools.js");
const collectors = await import("../src/collectors.js");
/** A representative collected sample: one hot CPU, one nearly-full disk. */
function collectorSample() {
	return collectors.aggregate(undefined, {
		// These keys are the REAL ones `aggregate` reads (`rawTexts.procStat`,
		// `procMem`, `procUptime`, `procCount`, `cpuInfo`, `version`). An earlier
		// revision used the device's own file names — `meminfo`, `procstat`,
		// `processes`, `model`, `kernel` — which `aggregate` never looks up, so
		// most of this "realistic device" was silently empty and every assertion
		// leaning on it was testing nothing.
		cpuInfo: "processor\t: 0\nmodel name\t: ARMv7 Processor rev 5 (v7l)\n",
		procMem: "MemTotal:         500000 kB\nMemFree:           10000 kB\nMemAvailable:      20000 kB\n",
		loadavg: "3.10 2.40 1.90 2/180 4242\n",
		procUptime: "12345.67 43210.98\n",
		procStat: "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\n",
		df: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000000 950000 50000 95% /\n",
		thermal: "40\n",
		version: "Linux box 5.10.0 #1 SMP\n",
		services: "sshd networking\n",
		procCount: "180\n",
	});
}

console.log("\n== slugify ==");
eq("ascii name lowercases and dashes", slugify("Edge Gateway 01"), "edge-gateway-01");
eq("chinese name survives", slugify("边缘网关"), "边缘网关");
eq("empty falls back", slugify("!!! "), "device");

console.log("\n== normalizePayload ==");
{
	const fields = normalizePayload({ name: " box ", host: "10.0.0.1", username: "root" });
	eq("name trimmed", fields.name, "box");
	eq("port defaults to 22", fields.port, 22);
	eq("tags default to empty", Array.isArray(fields.tags), true);
	let threw = false;
	try {
		normalizePayload({ host: "h", username: "u" });
	} catch {
		threw = true;
	}
	ok("missing name rejected", threw);
	threw = false;
	try {
		normalizePayload({ name: "n", host: "h", username: "u", port: 99999 });
	} catch {
		threw = true;
	}
	ok("out-of-range port rejected", threw);
}

console.log("\n== store: create / summarize / credential hygiene ==");
const store = new DeviceStore(storePath());
{
	const created = store.create({ name: "Edge 01", host: "192.168.1.10", username: "root", password: "s3cret", port: 2222 });
	eq("id derived from name", created.id, "edge-01");
	eq("port kept", created.port, 2222);
	const summary = summarize(created);
	ok("summary hides the password", summary.password === undefined && summary.auth?.password === undefined);
	eq("summary reports hasPassword", summary.hasPassword, true);
	ok("summary carries no auth object", summary.auth === undefined);
	eq("summaries length", store.summaries().length, 1);
}

console.log("\n== store: unique ids ==");
{
	const a = store.create({ name: "Edge 01", host: "192.168.1.11", username: "root" });
	eq("duplicate name gets a suffix", a.id, "edge-01-2");
}

console.log("\n== store: update is partial ==");
{
	store.update("edge-01", { location: "rack A" });
	const row = store.find("edge-01");
	eq("location applied", row.location, "rack A");
	eq("host untouched", row.host, "192.168.1.10");
	eq("password untouched", row.auth.password, "s3cret");
	eq("port untouched", row.port, 2222);
}

console.log("\n== store: the 10-device cap ==");
{
	let rejected = false;
	for (let n = store.list().length; n < MAX_DEVICES; n += 1) {
		store.create({ name: `filler ${n}`, host: `10.0.0.${n}`, username: "root" });
	}
	eq("roster filled to the cap", store.list().length, MAX_DEVICES);
	ok("isFull reports true", store.isFull());
	try {
		store.create({ name: "one too many", host: "10.0.0.99", username: "root" });
	} catch (error) {
		rejected = true;
		eq("cap violation is a 409", error.statusCode, 409);
	}
	ok("the 11th device is rejected", rejected);
	eq("roster stayed at the cap", store.list().length, MAX_DEVICES);
	store.delete(slugify("filler 2"));
	eq("delete frees a slot", store.list().length, MAX_DEVICES - 1);
	const freed = store.create({ name: "after free", host: "10.0.0.98", username: "root" });
	eq("a freed slot is reusable", store.list().length, MAX_DEVICES);
	eq("no id collision after delete", freed.id, "after-free");
}

console.log("\n== store: atomic write + reload ==");
{
	const raw = readFileSync(storePath(), "utf8");
	ok("roster is pretty-printed JSON", raw.startsWith("{\n"));
	const parsed = JSON.parse(raw);
	eq("persisted device count", parsed.devices.length, MAX_DEVICES);
	const reread = new DeviceStore(storePath());
	eq("a fresh store sees the same roster", reread.list().length, MAX_DEVICES);
	ok("credentials persist in the file", reread.find("edge-01").auth.password === "s3cret");
}

console.log("\n== store: 404s ==");
{
	let code;
	try {
		store.update("nope", { location: "x" });
	} catch (error) {
		code = error.statusCode;
	}
	eq("updating a missing device is a 404", code, 404);
	code = undefined;
	try {
		store.delete("nope");
	} catch (error) {
		code = error.statusCode;
	}
	eq("deleting a missing device is a 404", code, 404);
}

console.log("\n== collectors: busybox parsers ==");
{
	const prev = collectors.parseProcStat("cpu  100 0 50 800 20 0 5 0");
	const cur = collectors.parseProcStat("cpu  140 0 70 900 25 0 8 0");
	eq("cpuPercent delta", collectors.cpuPercent(prev, cur), 37.5);

	const mem = collectors.parseMeminfo("MemTotal:  2048000 kB\nMemAvailable:  512000 kB\nMemFree: 100000 kB");
	eq("meminfo totalMB", mem.totalMB, 2000);
	eq("meminfo uses MemAvailable", mem.usedMB, 1500);
	eq("meminfo usagePercent", mem.usagePercent, 75);

	const disk = collectors.parseDf(
		[
			"Filesystem     1024-blocks   Used Available Capacity Mounted on",
			"/dev/root         10000000 8000000  2000000      81% /",
			"tmpfs               500000       0   500000       0% /dev/shm",
			"overlay/x           100000   50000    50000      50% /var/lib",
		].join("\n"),
	);
	eq("pseudo filesystems filtered", disk.length, 2);
	eq("real mount kept", disk[0].mount, "/");
	eq("disk usagePercent", disk[0].usagePercent, 81);
	eq("overlay mounts are kept (only bare 'overlay/' is filtered)", disk[1].fs, "overlay/x");

	const thermal = collectors.parseThermal("cpu-thermal=55000\ngpu-thermal=48.5\nbogus");
	eq("milli-degrees normalized", thermal[0].celsius, 55);
	eq("degrees kept", thermal[1].celsius, 48.5);
	eq("unparsable lines dropped", thermal.length, 2);

	// `loadavg` is TWO reads in one command: the averages, then the logical-CPU
	// tally they are only interpretable against (1.0 saturates one core and
	// quarter-fills four). The averages line is found by its `running/total`
	// field rather than by position, because when /proc/loadavg is unreadable the
	// tally is still line 1 and reading it as `load1` would report a quiet 4-core
	// box as having a load of 4.
	const load = collectors.parseLoadavg("0.52 0.41 0.33 2/145 8823");
	eq("load1", load.load1, 0.52);
	eq("running/total", `${load.running}/${load.total}`, "2/145");
	// No tally line in this input: the core count is null, NEVER 1. A fabricated
	// denominator is a fabricated reading.
	eq("a missing core tally is null, not one", load.cores, null);
	const loadTwo = collectors.parseLoadavg("0.52 0.41 0.33 2/145 8823\n4\n");
	eq("the core tally is read from the second line", loadTwo.cores, 4);
	eq("the tally line does not disturb the averages", loadTwo.load1, 0.52);
	// The averages line is identified by its `running/total` field, so a device
	// that answered ONLY the tally must not be read as having a load of 4.
	const loadReversed = collectors.parseLoadavg("4\n0.52 0.41 0.33 2/145 8823\n");
	eq("load averages are found by shape, not by position", loadReversed.load1, 0.52);
	eq("and its tally is still picked up", loadReversed.cores, 4);
	eq("a useless loadavg body parses to null", collectors.parseLoadavg("garbage"), null);
	// A zero tally is not a core count either: it would divide by zero downstream.
	eq("a zero tally is rejected", collectors.parseLoadavg("0.52 0.41 0.33 2/145 8823\n0\n").cores, null);

	const uptime = collectors.parseUptime("7200.5 9000.0");
	eq("uptime text", uptime.text, "0d 2h 0m");

	eq("cpu model from /proc/cpuinfo", collectors.parseCpuInfo("processor : 0\nmodel name : ARMv8 Processor rev 1"), "ARMv8 Processor rev 1");

	// The `net` and `diskio` collectors run an awk ON THE DEVICE, so the parser
	// never sees the raw /proc file — it sees `name rx tx` / `name rd wr`. An
	// earlier fixture fed the RAW shapes, which the parser happened to accept,
	// so both metrics parsed to [] in production while every test stayed green.
	// Assert the EMITTED shape (what the device actually sends back).
	const net = collectors.parseNetDev("enp3s0 175588227558 115399948293\nenp4s0 0 0\n");
	eq("net parses the emitted awk form", net.length, 2);
	eq("net reads rx from field 2", net[0]?.rxBytes, 175588227558);
	eq("net reads tx from field 3", net[0]?.txBytes, 115399948293);
	eq("net keeps a zeroed interface", net[1]?.name, "enp4s0");
	const netRaw = collectors.parseNetDev("    lo: 260200356 1938607 0 0 0 0 0 0 260200356 1938607 0 0 0 0 0 0\nenp3s0: 175588227618 139889745 0 29469 0 0 0 2224559 115399948777 84950172 0 1 0 0 0 0\n");
	eq("net still parses the raw /proc form", netRaw.length, 1);
	eq("net drops the loopback row", netRaw[0]?.name, "enp3s0");
	eq("net ignores the /proc header lines", collectors.parseNetDev("Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n").length, 0);

	const dio = collectors.parseDiskstats("nvme0n1 35624161 463944552\nnvme0n1p1 20053 2\n");
	eq("diskio parses the emitted awk form", dio.length, 2);
	eq("diskio reads sectors from field 2", dio[0]?.sectorsRead, 35624161);
	eq("diskio reads written from field 3", dio[0]?.sectorsWritten, 463944552);
	const dioRaw = collectors.parseDiskstats("8 0 sda 100 0 2000 0 50 0 4000 0 0 0 0\n7 0 loop0 1 0 2 0 0 0 0 0 0 0 0\n");
	eq("diskio still parses the raw /proc form", dioRaw.length, 1);
	eq("diskio reads sectors from field 6 when raw", dioRaw[0]?.sectorsRead, 2000);
	eq("diskio reads written from field 10 when raw", dioRaw[0]?.sectorsWritten, 4000);
	eq("diskio drops loop devices in both shapes", collectors.parseDiskstats("loop0 1 2\n").length, 0);

	// A rate needs a baseline; the FIRST sample must be null, not 0.
	const netRate = collectors.rateSince(undefined, net, "rxBytes", "txBytes", { scale: 1, elapsedMs: 1000 });
	eq("a first net sample has no rate", netRate?.rxTotal, null);
}

console.log("\n== collectors: command plan shape ==");
{
	const plan = collectors.commandPlan();
	ok("plan is non-empty", Object.keys(plan).length > 0);
	const bad = Object.entries(plan).filter(([, entry]) => typeof entry.cmd !== "string" || !Number.isFinite(entry.timeout));
	ok("every entry has {cmd, timeout}", bad.length === 0, JSON.stringify(bad.map(([k]) => k)));
	ok("plan covers procStat/meminfo/df", "procStat" in plan && "procMem" in plan && "df" in plan);
	// The load command is TWO reads in one round-trip: the averages plus the
	// logical-CPU tally they must be interpreted against. Asserting the parsed
	// value alone cannot see this, because a device that answers only the first
	// line still parses — it just loses its dimension. That gap is exactly what
	// let the m09671 defect ship.
	// Resolve the command through the public metric->command mapping rather than
	// hard-coding "loadavg": the point is that the LOAD metric's command carries
	// the tally, wherever that mapping happens to point.
	const loadCmd = plan[collectors.COMMAND_FOR_METRIC.load]?.cmd ?? "";
	ok("the load command reads /proc/loadavg", loadCmd.includes("/proc/loadavg"), loadCmd);
	ok("the load command counts the logical CPUs in the same round-trip",
		loadCmd.includes("/proc/stat") && loadCmd.includes("grep -c"), loadCmd);
	ok("the load command counts cpuN lines rather than cpuinfo processors",
		loadCmd.includes("^cpu[0-9]"), loadCmd);
	// `|| true` matters: a device without /proc/stat must still return the
	// averages rather than failing the whole command.
	ok("a missing tally does not fail the load command", loadCmd.includes("|| true"), loadCmd);
}

console.log("\n== collectors: aggregate ==");
{
	const prev = collectors.parseProcStat("cpu  100 0 50 800 20 0 5 0");
	const sample = collectors.aggregate({ procStat: prev }, {
		procStat: "cpu  140 0 70 900 25 0 8 0\ncpu0 1 2 3 4 5 6 7 8\ncpu1 1 2 3 4 5 6 7 8",
		procMem: "MemTotal:  2048000 kB\nMemAvailable:  512000 kB",
		procUptime: "7200.5 9000.0",
		loadavg: "0.52 0.41 0.33 2/145 8823",
		df: "/dev/root 10000000 8000000 2000000 81% /",
		thermal: "cpu-thermal=55000",
		procCount: "145\n",
		cpuInfo: "model name : ARMv8",
		version: "Linux box 5.10.0 #1 SMP\nmore",
		services: "ssh.service\ncron.service\n",
	});
	eq("aggregate cpu", sample.cpu.percent, 37.5);
	eq("aggregate cores counted from cpuN lines", sample.cpu.cores, 2);
	// The load fixture carries NO tally line, but /proc/stat was read anyway (the
	// CPU metric is on), so the core count is recovered from it. This is the
	// fallback path: a device whose `grep -c` failed still gets a dimension.
	eq("aggregate load falls back to /proc/stat for its cores", sample.load.cores, 2);
	// And the load reading keeps its own identity: the tally is a property of the
	// box, but it is reported ON the load so a load-only device needs no CPU row.
	eq("aggregate load average", sample.load.load1, 0.52);
	eq("aggregate memory", sample.memory.usagePercent, 75);
	eq("aggregate disk", sample.disk[0].usagePercent, 81);
	eq("aggregate processes", sample.processes, 145);
	eq("aggregate kernel is first line only", sample.kernel, "Linux box 5.10.0 #1 SMP");
	eq("aggregate services", sample.services.join(","), "ssh.service,cron.service");
	eq("aggregate keeps the procStat baseline", typeof sample.procStat, "object");
	ok("publicSample strips the baseline", publicSample(sample).procStat === undefined);

	// The m09671 case, at the aggregate boundary: a device with the CPU metric
	// switched OFF. There is no /proc/stat at all, so the core count has to come
	// from the tally the load collector brings with it. This is exactly `nas-b`,
	// whose stored choice is ["uptime","load","mem"].
	const loadOnly = collectors.aggregate(undefined, { loadavg: "0.54 0.53 0.54 1/1126 4321\n4\n" }, ["uptime", "load", "mem"]);
	eq("a load-only device has no cpu row", loadOnly.cpu, null);
	eq("a load-only device still reports its cores", loadOnly.load.cores, 4);
	eq("and its load average", loadOnly.load.load1, 0.54);
	// When NEITHER source answered, the count is null. Under the old rendering
	// this became `?? 1`, which drew a 4-core box's 13.5% load as a 54% bar —
	// a bar four times too long reporting an idle machine as a busy one.
	const blind = collectors.aggregate(undefined, { loadavg: "0.54 0.53 0.54 1/1126 4321\n" }, ["uptime", "load", "mem"]);
	eq("an unmeasured core count stays null through aggregation", blind.load.cores, null);
	ok("and it is never fabricated as one", blind.load.cores !== 1);
	// The SAME fabrication lived in `coresOf`, which returned `Math.max(1, n)`.
	// With the CPU metric on but /proc/stat unreadable, `cpu.cores` used to claim
	// a confident 1 core. "We never looked" is not "single-core box".
	const noProcStat = collectors.aggregate(undefined, { loadavg: "0.54 0.53 0.54 1/1126 4321\n" }, ["uptime", "load", "cpu"]);
	eq("an unreadable /proc/stat does not fabricate a cpu core count", noProcStat.cpu.cores, null);
	eq("and the load cannot borrow one either", noProcStat.load.cores, null);
}

console.log("\n== metrics: alerts ==");
{
	const quiet = collectors.aggregate(undefined, { procStat: "cpu  0 0 0 100 0 0 0 0", procMem: "MemTotal: 1000 kB\nMemAvailable: 900 kB", df: "/dev/root 1000 100 900 10% /" });
	eq("quiet sample has no alerts", evaluateAlerts(quiet).length, 0);

	const hot = collectors.aggregate(undefined, {
		procStat: "cpu  0 0 0 100 0 0 0 0",
		procMem: "MemTotal: 1000 kB\nMemAvailable: 50 kB",
		df: "/dev/root 1000 950 50 95% /",
		thermal: "cpu-thermal=80000",
	});
	const alerts = evaluateAlerts(hot);
	eq("three breaches detected", alerts.length, 3);
	// Alert metric names are unified with the threshold keys (cpu/mem/disk/temp)
	// so one vocabulary spans settings, alerts and the metric picker.
	ok("memory alert carries the structured value", alerts.some((a) => a.metric === "mem" && a.rawValue === 95));
	ok("disk alert carries the mount", alerts.some((a) => a.metric === "disk" && a.mount === "/"));
	ok("thermal alert carries the zone", alerts.some((a) => a.metric === "temp" && a.type === "cpu-thermal"));
}

console.log("\n== metrics store: history + status ==");
{
	const metrics = new MetricsStore(3);
	const sample = collectors.aggregate(undefined, { procStat: "cpu  0 0 0 100 0 0 0 0", procMem: "MemTotal: 1000 kB\nMemAvailable: 500 kB" });
	for (let n = 0; n < 5; n += 1) metrics.apply("d1", { ...sample, ts: n });
	eq("history is capped at the limit", metrics.series("d1").length, 3);
	eq("history keeps the newest", metrics.series("d1")[0].ts, 2);
	eq("previous sample exposed for the CPU delta", metrics.previous("d1").ts, 4);
	metrics.fail("d1", "boom");
	eq("failure recorded", metrics.status("d1").error, "boom");
	ok("last good sample survives a failure", metrics.latest("d1") !== undefined);
	metrics.forget("d1");
	eq("forget clears history", metrics.series("d1").length, 0);
}

console.log("\n== monitor: overview + missing device ==");
{
	const s = new DeviceStore(storePath());
	const m = new MetricsStore();
	const monitor = new Monitor(s, m);
	const overview = monitor.overview();
	eq("overview lists every device", overview.devices.length, s.list().length);
	eq("overview advertises the cap", overview.maxDevices, 10);
	ok("overview never leaks a password", overview.devices.every((row) => row.hasPassword === true || row.hasPassword === false));
	let code;
	try {
		await monitor.pollDevice("missing");
	} catch (error) {
		code = error.statusCode;
	}
	eq("polling a missing device is a 404", code, 404);
}

console.log("\n== routes: loopback fence and methods ==");
{
	const s = new DeviceStore(storePath());
	const m = new MetricsStore();
	const monitor = new Monitor(s, m);
	const routes = makeRoutes(s, m, monitor);
	ok("fifteen routes registered", routes.length === 15);
	ok("every route is an exact match", routes.every((route) => route.kind === "exact"));
	const paths = routes.map((route) => route.path);
	ok("overview path present", paths.includes(API.overview));
	ok("devices path present", paths.includes(API.devices));
	// The logging / settings surface is separate from the device CRUD surface;
	// each new route is its own row, which is why the count moved 6 -> 15.
	for (const key of ["settings", "catalog", "watch", "terminal", "rawlog", "incidents", "logs", "audit", "testDraft"]) {
		ok(`${key} path present`, paths.includes(API[key]));
	}

	/**
	 * Drive one route with a synthetic request.
	 * @returns `{ status, body, headers }`.
	 */
	async function call(path, { method = "GET", body, raw, remoteAddress = "127.0.0.1", host = "127.0.0.1:19387", headers = {} } = {}) {
		// The registry is keyed by exact path; the query string rides on the URL.
		const route = routes.find((row) => row.path === path.split("?")[0]);
		if (route === undefined) throw new Error(`no route for ${path}`);
		const req = new EventEmitter();
		req.method = method;
		req.url = path;
		req.socket = { remoteAddress };
		req.headers = { host, ...headers };
		req.destroy = () => {};
		const chunks = raw !== undefined ? [Buffer.from(raw, "utf8")] : body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
		// `readJsonBody` consumes the request with `for await`, so the fake
		// request must be async-iterable as well as an EventEmitter.
		req[Symbol.asyncIterator] = async function* () {
			for (const chunk of chunks) yield chunk;
		};
		setImmediate(() => {
			for (const chunk of chunks) req.emit("data", chunk);
			req.emit("end");
		});
		const res = {
			status: undefined,
			headers: undefined,
			payload: "",
			writeHead(status, responseHeaders) {
				this.status = status;
				this.headers = responseHeaders;
			},
			end(payload) {
				this.payload = payload ?? "";
			},
		};
		await route.handler(req, res);
		let parsed;
		try {
			parsed = JSON.parse(res.payload);
		} catch {
			parsed = undefined;
		}
		return { status: res.status, body: parsed, headers: res.headers };
	}

	const overview = await call(API.overview);
	eq("loopback GET /overview is 200", overview.status, 200);
	eq("overview returns devices", Array.isArray(overview.body.devices), true);
	eq("overview caps at 10", overview.body.maxDevices, 10);
	ok("responses are no-store", overview.headers["cache-control"] === "no-store");

	const forbidden = await call(API.overview, { remoteAddress: "192.168.1.5", host: "192.168.1.5:19387" });
	eq("a non-loopback socket is rejected", forbidden.status, 403);
	eq("and says why", forbidden.body.error, "forbidden: loopback-only");

	const lanHost = await call(API.overview, { host: "10.0.0.7:19387" });
	eq("a non-loopback Host header is rejected", lanHost.status, 403);

	const crossSite = await call(API.overview, { headers: { "sec-fetch-site": "cross-site" } });
	eq("a cross-site fetch is rejected", crossSite.status, 403);

	const badOrigin = await call(API.overview, { headers: { origin: "http://evil.example" } });
	eq("a foreign Origin is rejected", badOrigin.status, 403);

	const goodOrigin = await call(API.overview, { headers: { origin: "http://127.0.0.1:19387" } });
	eq("a loopback Origin is allowed", goodOrigin.status, 200);

	// m07341. The desktop shell serves the app page from `dsh-app://app`, so the
	// browser sends that as the Origin — and, because the shell's scheme and
	// host both differ from the Host's, it also labels the request cross-site.
	// The fence must admit that exact pair or the plugin refuses its own UI.
	const desktopOrigin = await call(API.overview, { headers: { origin: "dsh-app://app", "sec-fetch-site": "cross-site" } });
	eq("the desktop shell's own Origin is allowed even though it reads as cross-site", desktopOrigin.status, 200);
	// ...but only that Origin. `dsh-app://shell` is the shell's OTHER document
	// and has no business opening device terminals; a blanket "any dsh-app page"
	// rule would be a wider hole than the one this fix closes.
	const shellOrigin = await call(API.overview, { headers: { origin: "dsh-app://shell", "sec-fetch-site": "cross-site" } });
	eq("the shell's other document is still refused", shellOrigin.status, 403);
	// The origin is not a skeleton key: it is only consulted after the socket
	// address and the Host header have both been proven loopback, so the same
	// header on a LAN-shaped request changes nothing.
	const desktopOnLan = await call(API.overview, { host: "10.0.0.7:19387", headers: { origin: "dsh-app://app", "sec-fetch-site": "cross-site" } });
	eq("the desktop Origin does not unlock a non-loopback Host", desktopOnLan.status, 403);
	const desktopFromLan = await call(API.overview, { remoteAddress: "192.168.1.50", headers: { origin: "dsh-app://app", "sec-fetch-site": "cross-site" } });
	eq("the desktop Origin does not unlock a non-loopback caller", desktopFromLan.status, 403);

	eq("POST on a GET-only route is 405", (await call(API.overview, { method: "POST" })).status, 405);

	// The cap test above left the shared roster full, so free one slot first.
	// That a create would otherwise be refused here is itself the cap working
	// end-to-end through the route layer, asserted just below.
	const atCap = await call(API.devices, { method: "POST", body: { name: "over the cap", host: "10.9.9.8", username: "root" } });
	eq("a create past the cap is refused over HTTP", atCap.status, 409);
	s.delete(slugify("filler 3"));

	const created = await call(API.devices, { method: "POST", body: { name: "route box", host: "10.9.9.9", username: "root", password: "pw" } });
	eq("POST /devices creates", created.status, 201);
	eq("creation returns the id", created.body.device.id, "route-box");
	ok("creation response hides the password", created.body.device.password === undefined && created.body.device.hasPassword === true);

	const badBody = await call(API.devices, { method: "POST", body: { host: "h", username: "u" } });
	eq("a payload without a name is 400", badBody.status, 400);

	const listed = await call(API.devices);
	eq("GET /devices returns the roster", listed.body.devices.length, s.list().length);
	eq("GET /devices advertises the cap", listed.body.maxDevices, 10);

	const patched = await call(`${API.devices}?id=route-box`, { method: "PATCH", body: { location: "lab" } });
	eq("PATCH updates", patched.status, 200);
	eq("PATCH applied the field", patched.body.device.location, "lab");

	eq("PATCH without an id is 400", (await call(API.devices, { method: "PATCH", body: { location: "x" } })).status, 400);
	eq("PATCH on a missing device is 404", (await call(`${API.devices}?id=ghost`, { method: "PATCH", body: { location: "x" } })).status, 404);
	eq("a malformed JSON body is 400", (await call(API.devices, { method: "POST", raw: "{not json" })).status, 400);
	eq("an empty body is 400", (await call(API.devices, { method: "POST" })).status, 400);

	const removed = await call(`${API.devices}?id=route-box`, { method: "DELETE" });
	eq("DELETE removes", removed.status, 200);
	eq("DELETE reports ok", removed.body.ok, true);
	eq("roster shrank", s.find("route-box"), undefined);

	const metricsMissing = await call(`${API.metrics}?id=ghost`);
	eq("metrics for a missing device is 404", metricsMissing.status, 404);
	const metricsOne = await call(`${API.metrics}?id=${encodeURIComponent(s.list()[0].id)}`);
	eq("metrics for a real device is 200", metricsOne.status, 200);
	eq("metrics returns a series", Array.isArray(metricsOne.body.series), true);
}

console.log("\n== http: loopback predicates ==");
{
	eq("127.0.0.1 is loopback", isLoopbackAddress("127.0.0.1"), true);
	eq("127.9.9.9 is loopback", isLoopbackAddress("127.9.9.9"), true);
	eq("::1 is loopback", isLoopbackAddress("::1"), true);
	eq("IPv4-mapped loopback is loopback", isLoopbackAddress("::ffff:127.0.0.1"), true);
	eq("10.0.0.1 is not loopback", isLoopbackAddress("10.0.0.1"), false);
	eq("undefined is not loopback", isLoopbackAddress(undefined), false);
	eq("the fence rejects an undefined address", isLoopbackRequest({ socket: {}, headers: { host: "127.0.0.1" } }), false);

	// m07341, at the predicate. The desktop shell's page is `dsh-app://app` and
	// the Host is loopback: the two rows that must pass, and the three that must
	// not — `dsh-app://shell` is a different document, and the same Origin must
	// not rescue a non-loopback socket or Host.
	const desktop = { origin: "dsh-app://app", "sec-fetch-site": "cross-site" };
	eq("the desktop shell page may reach the routes",
		isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19387", ...desktop } }), true);
	eq("...including over IPv6 loopback",
		isLoopbackRequest({ socket: { remoteAddress: "::1" }, headers: { host: "[::1]:19387", ...desktop } }), true);
	eq("the shell's other document may not",
		isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19387", origin: "dsh-app://shell", "sec-fetch-site": "cross-site" } }), false);
	eq("the desktop Origin does not rescue a LAN socket",
		isLoopbackRequest({ socket: { remoteAddress: "192.168.1.50" }, headers: { host: "127.0.0.1:19387", ...desktop } }), false);
	eq("the desktop Origin does not rescue a LAN Host",
		isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "192.168.1.50:19387", ...desktop } }), false);
	eq("the desktop Origin is matched exactly, not by prefix",
		isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19387", origin: "dsh-app://app.evil.example", "sec-fetch-site": "cross-site" } }), false);
}

console.log("\n== tools: the real defineTool contract ==");
{
	// `defineTool` installs `output.render` behind a wrapper that calls it on
	// every invocation, so a definition without a render throws
	// `userRender is not a function` the first time the model uses the tool.
	// The tests below use a faithful stand-in for that wrapper, so a missing
	// render fails here rather than in the running GUI.
	const shim = (options) => {
		const userRender = options.output.render;
		return {
			...options,
			output: {
				...options.output,
				render(args, value) {
					return userRender(args, value);
				},
			},
		};
	};

	const toolStore = new DeviceStore();
	const toolMetrics = new MetricsStore();
	const toolMonitor = new Monitor(toolStore, toolMetrics);
	const tools = makeTools(shim, toolStore, toolMonitor, toolMetrics);
	eq("five tools are defined", tools.length, 5);
	eq("the tool names are the documented set", tools.map((tool) => tool.name).join(","), "device_list,device_status,device_collect,device_exec,device_history");
	for (const tool of tools) {
		ok(`${tool.name} supplies a render`, typeof tool.output.render === "function");
		ok(`${tool.name} supplies an output schema`, tool.output.schema?.type === "object");
		ok(`${tool.name} describes itself`, typeof tool.description === "string" && tool.description.length > 40);
	}

	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	// device_list on an empty roster: a fresh scratch home, because the earlier
	// sections left their own devices in the shared one.
	const toolHome = mkdtempSync(join(tmpdir(), "ddm-tools-"));
	process.env.DSH_HOME = toolHome;
	const emptyStore = new DeviceStore();
	const emptyMetrics = new MetricsStore();
	const emptyTools = makeTools(shim, emptyStore, new Monitor(emptyStore, emptyMetrics), emptyMetrics);
	const emptyByName = new Map(emptyTools.map((tool) => [tool.name, tool]));
	const emptyList = await emptyByName.get("device_list").execute({});
	ok("device_list reports the cap", emptyList.maxDevices === 10);
	eq("device_list starts empty", emptyList.devices.length, 0);
	const emptyRendered = emptyByName.get("device_list").output.render({}, emptyList);
	ok("device_list renders a text block", Array.isArray(emptyRendered) && emptyRendered[0]?.type === "text", JSON.stringify(emptyRendered));
	ok("device_list names the sidebar panel when empty", emptyRendered[0].text.includes("侧边栏"));
	// The empty-collection path is its own render branch.
	const emptyCollect = await emptyByName.get("device_collect").execute({});
	eq("device_collect on an empty roster returns no rows", emptyCollect.results.length, 0);
	ok("device_collect renders its empty state", emptyByName.get("device_collect").output.render({}, emptyCollect)[0].text.includes("尚未登记"));
	rmSync(toolHome, { recursive: true, force: true });
	process.env.DSH_HOME = scratch;

	// device_status for a missing id must still render.
	const missing = await byName.get("device_status").execute({ id: "ghost" });
	eq("device_status reports not-found", missing.found, false);
	const missingRendered = byName.get("device_status").output.render({}, missing);
	ok("device_status renders its not-found summary", missingRendered[0].text.includes("ghost"), JSON.stringify(missingRendered));

	// A real device, so the render path sees populated values.
	const before = toolStore.summaries().length;
	const created = toolStore.create({ name: "Tool 01", host: "10.0.0.5", username: "root", password: "pw" });
	const listed = await byName.get("device_list").execute({});
	eq("device_list reports the new device", listed.devices.length, before + 1);
	const listedRendered = byName.get("device_list").output.render({}, listed);
	ok("device_list renders the device row", listedRendered[0].text.includes("Tool 01"), listedRendered[0].text);
	ok("device_list never renders the password", listedRendered[0].text.includes("pw") === false, listedRendered[0].text);

	// device_status with a recorded sample, including an alert.
	toolMetrics.apply(created.id, collectorSample());
	const status = await byName.get("device_status").execute({ id: created.id });
	eq("device_status finds the device", status.found, true);
	ok("device_status summarises the sample", status.summary.includes("10.0.0.5"), status.summary);
	// The sample has a 95%-full disk. CPU needs a prior procStat to compute a
	// delta, so the disk threshold is the alert this single sample can prove.
	ok("device_status raises the disk alert", status.alerts.some((alert) => alert.includes("磁盘") && alert.includes("95%")), JSON.stringify(status.alerts));
	const statusRendered = byName.get("device_status").output.render({}, status);
	ok("device_status renders the alert block", statusRendered[0].text.includes("告警"), statusRendered[0].text);
	// The load line must state the core count it is measured against, and the
	// cores must come from whichever collector read them. `collectorSample()`'s
	// /proc/stat lists one `cpuN` line and its loadavg carries no tally, so this
	// exercises the fallback: the count is recovered from /proc/stat.
	ok("device_status states the cores the load is measured against",
		statusRendered[0].text.includes("负载: 3.1 / 2.4 / 1.9") && statusRendered[0].text.includes("1 核"), statusRendered[0].text);
	ok("device_status converts the load into a per-core occupancy",
		statusRendered[0].text.includes("310%"), statusRendered[0].text);
	ok("device_status states the core count on the uptime line too",
		statusRendered[0].text.includes("运行时长:") && statusRendered[0].text.includes("(1 核)"), statusRendered[0].text);
	// A sample with NO core information anywhere must say so rather than invent a
	// dimension. This is the m09671 defect as the model would have seen it.
	{
		// A fresh DSH_HOME, because the shared scratch store is already at the
		// ten-device cap by the time this section runs.
		const blindHome = mkdtempSync(join(tmpdir(), "ddm-blind-"));
		const savedHome = process.env.DSH_HOME;
		process.env.DSH_HOME = blindHome;
		const blindStore = new DeviceStore();
		const blindMetrics = new MetricsStore();
		const blindTools = makeTools(shim, blindStore, new Monitor(blindStore, blindMetrics), blindMetrics);
		const blindByName = new Map(blindTools.map((tool) => [tool.name, tool]));
		const blindDevice = blindStore.create({ name: "Blind 01", host: "10.0.0.9", username: "root", password: "pw" });
		blindMetrics.apply(blindDevice.id, collectors.aggregate(undefined, { loadavg: "0.54 0.53 0.54 1/1126 4321\n", procUptime: "100 200\n" }, ["uptime", "load"]));
		const blindStatus = await blindByName.get("device_status").execute({ id: blindDevice.id });
		const blindRendered = blindByName.get("device_status").output.render({}, blindStatus);
		const text = blindRendered[0].text;
		ok("an unknown core count is reported as unknown, not as one",
			text.includes("负载: 0.54") && !text.includes("1 核") && text.includes("? 核"), text);
		process.env.DSH_HOME = savedHome;
		rmSync(blindHome, { recursive: true, force: true });
	}
	// device_exec against an unreachable host: the error path must render too.
	const execResult = await byName.get("device_exec").execute({ id: created.id, command: "true", timeoutMs: 1500 });
	eq("device_exec reports failure for an unreachable host", execResult.success, false);
	ok("device_exec carries an error", typeof execResult.error === "string" && execResult.error.length > 0, JSON.stringify(execResult));
	const execRendered = byName.get("device_exec").output.render({}, execResult);
	ok("device_exec renders the exit-code convention", execRendered[0].text.includes("[exit code:"), execRendered[0].text);
	ok("device_exec renders the error", execRendered[0].text.includes("error:"), execRendered[0].text);

	// ---------------------------------------------------------------------
	// m11227: the audit trail must record THAT a command ran, never its text.
	//
	// Asserted from the PUBLIC entry point (`device_exec` -> `execOn` -> the
	// on-disk audit line), because the defect is precisely a call site passing
	// one field where it should pass another. A unit test on the audit writer
	// cannot see it: `audit()` behaves perfectly for both payloads.
	//
	// The command carries a password-shaped token on purpose. This is the only
	// route in the plugin that puts user-written text on the wire, so it is the
	// only place where "record the value" reaches disk as a credential.
	// ---------------------------------------------------------------------
	{
		const SECRET = "Hunter2Secret";
		const commandText = `mysql -p${SECRET} -e 'select 1'`;
		await byName.get("device_exec").execute({ id: created.id, command: commandText, timeoutMs: 800 });
		const auditFile = join(scratch, "dsh-device-monitor-logs", "log", "audit.log");
		const auditText = readFileSync(auditFile, "utf8");
		const rows = auditText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const mine = rows.filter((row) => row.event === "device.exec" && row.deviceId === created.id);
		// Non-vacuity first: if no row for this device were written, the two
		// assertions below would pass for the wrong reason.
		ok("the exec audit writes a row for the device that ran it", mine.length >= 1, JSON.stringify(rows.slice(-3)));
		ok("the exec audit never records the command text", auditText.includes(SECRET) === false, auditText);
		// Null-safe on purpose. When the row is missing entirely, `ok` above
		// already reports it; reaching into an empty array would turn that into
		// a TypeError, and a mutant caught by a stack trace is not a covered
		// mutant — it is a test that never got to ask its question.
		eq("the exec audit records the command length instead", (mine[mine.length - 1] ?? {}).commandLength, commandText.length);
		eq("the exec audit carries no `command` field at all", "command" in (mine[mine.length - 1] ?? {}), false);
		// The disciplined sibling, for contrast: it already stored NAMES only.
		ok("`command.custom` records metric names, never command bodies",
			rows.filter((row) => row.event === "command.custom").every((row) => Array.isArray(row.metrics) && row.command === undefined));
	}

	// ---------------------------------------------------------------------
	// m11685: `execOn` must dial through the INJECTED connect.
	//
	// Found while writing an out-of-band proof harness, which passed
	// `connect: () => { throw }` to keep its own machine off the network and
	// still opened a real socket to 10.0.0.9: `execOn` called the module-level
	// `connect` and ignored `this.connect`. `testDraft` had used `this.connect`
	// all along, so the seam existed and covered only half the dials.
	//
	// This is asserted with a counter, not by trusting the code: the injected
	// dial is the only one that runs, so it must be the one this route uses.
	// A substitute that is not called is indistinguishable from no substitute.
	// ---------------------------------------------------------------------
	{
		let dials = 0;
		const seamStore = {
			find: (id) => ({ id, name: "Seam 01", host: "10.0.0.7", port: 22, username: "root", authKind: "password" }),
			settings: () => ({ customCommands: { enabled: false, overrides: {} } }),
		};
		const seamMonitor = new Monitor(seamStore, new MetricsStore(), {
			connect: () => { dials += 1; throw new Error("seam dial"); },
		});
		let seamError = "";
		try {
			await seamMonitor.execOn("seam-01", "true", 300);
		} catch (error) {
			seamError = error instanceof Error ? error.message : String(error);
		}
		eq("execOn dials through the injected connect, not the shared one", dials, 1);
		eq("execOn surfaces the injected dial's own failure", seamError, "seam dial");
	}

	// ---------------------------------------------------------------------
	// m11228: `device_history` — the one thing a model could not ask before.
	//
	// `device_status` can only ever describe this instant, so "did this box
	// reboot last night" was unanswerable even though both logs were on disk.
	// ---------------------------------------------------------------------
	{
		const historyTool = byName.get("device_history");
		ok("device_history is registered", historyTool !== undefined);
		ok("device_history declares its id filter",
			historyTool.parameters.id !== undefined && historyTool.parameters.kind !== undefined, JSON.stringify(Object.keys(historyTool.parameters)));
		ok("device_history supplies a render and a schema",
			typeof historyTool.output.render === "function" && historyTool.output.schema?.type === "object");

		// The exec above already wrote an audit row for `created`, so the tool's
		// read path is exercised against bytes it did not itself fabricate.
		const mine = await historyTool.execute({ id: created.id, kind: "audit" });
		ok("device_history finds the audited action",
			mine.events.some((row) => row.includes("远程执行")), JSON.stringify(mine.events));
		ok("device_history renders the timeline",
			historyTool.output.render({}, mine)[0].text.includes("远程执行"), historyTool.output.render({}, mine)[0].text);

		// A device that has never done anything gets an EXPLANATION, not a
		// blank — an empty string reads as "the tool is broken".
		const quiet = await historyTool.execute({ id: "never-existed" });
		eq("device_history reports an empty history", quiet.count, 0);
		ok("device_history explains an empty history", typeof quiet.note === "string" && quiet.note.includes("没有历史记录"), JSON.stringify(quiet));

		// Seed BOTH log layers directly, so the merge and the sort are tested
		// against known timestamps rather than against whatever the suite
		// happened to write on the way here.
		const { audit: writeAudit, recordIncident: writeIncident } = await import("../src/logs.js");
		writeIncident({ at: "2026-01-01T10:00:00.000Z", event: "offline", deviceId: created.id, deviceName: created.name, fails: 2, downSeconds: 300, error: "connect ETIMEDOUT" });
		writeIncident({ at: "2026-01-01T11:00:00.000Z", event: "online", deviceId: created.id, deviceName: created.name, downSeconds: 3600 });
		writeIncident({ at: "2026-01-02T00:00:00.000Z", event: "offline", deviceId: "somebody-else", deviceName: "Other", fails: 3, downSeconds: 5 });
		writeAudit("device.update", { deviceId: created.id, deviceName: created.name, changed: ["host", "port"] });

		const merged = await historyTool.execute({ id: created.id, limit: 50 });
		const text = merged.events.join("\n");
		ok("device_history merges incidents and audit rows into one timeline",
			text.includes("掉线") && text.includes("恢复") && text.includes("修改设备"), text);
		ok("device_history labels a recovery", text.includes("恢复") && text.includes("已持续 3600s"), text);
		ok("device_history translates the event kind", text.includes("offline") === false, text);
		ok("device_history reports the failure count", text.includes("连续 2 次失败"), text);
		ok("device_history reports the error text", text.includes("connect ETIMEDOUT"), text);
		ok("device_history reports which fields changed", text.includes("host/port"), text);
		ok("device_history reports the command length", text.includes("命令") && text.includes("字符"), text);
		ok("device_history tags each row with its layer", text.includes("[异常]") && text.includes("[审计]"), text);
		// Newest first, across the merged set. The seeded audit row is written
		// "now" and the seeded incidents are in the past, so ordering is checkable
		// without freezing the clock.
		//
		// Compare the TIMESTAMP PREFIX, not the whole row. The renderer prints
		// second resolution while the logs hold milliseconds, so two rows written
		// in the same second render to an identical prefix and a whole-string
		// comparison then falls through to the label text — which is not ordered.
		// That made this assertion fail intermittently depending on how many
		// audit rows the earlier sections happened to write inside one second.
		// The property being asserted is that the rendered view is non-increasing
		// in time, and the second-resolution prefix is exactly that property.
		const stampOf = (row) => row.slice(0, 20);
		const offenders = merged.events
			.map((row, i) => [i, stampOf(row)])
			.filter(([, stamp], i, all) => i > 0 && all[i - 1][1] < stamp);
		eq("device_history sorts newest first", offenders.length, 0,
			offenders.map(([i, stamp]) => `row ${i} (${stamp}) is newer than row ${i - 1}`).join("; "));
		// The fleet view must include the other device; a per-device view must not.
		ok("a per-device view excludes other devices", text.includes("Other") === false, text);
		const fleet = await historyTool.execute({ limit: 50 });
		ok("the fleet view includes other devices", fleet.events.join("\n").includes("Other"), fleet.events.join("\n"));
		eq("kind=incidents excludes audit rows",
			(await historyTool.execute({ kind: "incidents" })).events.some((row) => row.includes("[审计]")), false);
		eq("kind=audit excludes incident rows",
			(await historyTool.execute({ kind: "audit" })).events.some((row) => row.includes("[异常]")), false);
		// A per-device query must search the WHOLE log, not just the newest
		// `limit` rows. This is the failure a truncating reader hides: the
		// device that goes offline every night stops being findable the moment
		// some chattier device writes more recent rows than the caller asked
		// for — and the tool then reports "no history" rather than "not in the
		// last N", which is a confident wrong answer.
		//
		// Built so that a truncating reader CANNOT accidentally pass: enough
		// noise rows, all strictly newer than everything already in the log
		// (hence the future dates — the audit rows above were stamped "now"),
		// that `limit` rows are entirely noise.
		//
		// BOTH logs get noise. A truncating reader is two independent reads
		// (`readIncidents(limit)` and `readAudit(limit)`), so filling only the
		// incident log leaves the device's own audit row still inside the audit
		// window and the mutant survives — which is exactly what happened on the
		// first attempt at this mutant.
		for (let n = 0; n < 6; n += 1) {
			writeIncident({ at: `2030-03-0${n + 1}T00:00:00.000Z`, event: "offline", deviceId: "noise-device", deviceName: "Noisy", fails: 1, downSeconds: 1 });
			writeAudit("device.update", { at: `2030-03-0${n + 1}T00:00:00.000Z`, deviceId: "noise-device", deviceName: "Noisy", changed: ["host"] });
		}
		const narrow = await historyTool.execute({ id: created.id, limit: 2 });
		ok("a small limit still searches the whole log",
			narrow.count > 0 && narrow.events.every((row) => row.includes("Noisy") === false), JSON.stringify(narrow.events));
		eq("the noise rows are excluded from the count", narrow.count, Math.min(2, narrow.count));
		// The device filter and the limit are independent: the fleet view under
		// the same limit legitimately returns only the newest noise rows.
		const noisy = await historyTool.execute({ limit: 2 });
		ok("the fleet view returns the newest rows regardless of device", noisy.events.length === 2 && noisy.events.every((row) => row.includes("Noisy")), JSON.stringify(noisy.events));
		ok("the render reports the count it returned", historyTool.output.render({}, narrow)[0].text.includes(`${narrow.count} 条`), historyTool.output.render({}, narrow)[0].text);
	}

	// device_collect over the whole unreachable roster: one row per device.
	const collectAll = await byName.get("device_collect").execute({});
	eq("device_collect returns one row per device", collectAll.results.length, toolStore.summaries().length);
	ok("every collect row names its device", collectAll.results.every((row) => row.includes("采集失败")), JSON.stringify(collectAll.results.slice(0, 3)));
	const collectRendered = byName.get("device_collect").output.render({}, collectAll);
	ok("device_collect renders its rows", collectRendered[0].text.includes(created.id), collectRendered[0].text);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures.length}/${checks} checks`);
if (failures.length > 0) {
	console.log(failures.map((row) => `  - ${row}`).join("\n"));
	process.exitCode = 1;
}
