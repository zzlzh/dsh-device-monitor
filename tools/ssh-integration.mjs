/**
 * Integration test for the SSH transport, against a REAL ssh2 server.
 *
 * `src/ssh.js` is the one module the other suites cannot exercise: they stub
 * everything below it. This suite stands up an in-process `ssh2.Server`
 * impersonating a busybox device, then drives the plugin's own
 * `connect` / `exec` / `test` / `collect` against it over a real TCP socket
 * with real SSH framing, real authentication, and real channel I/O.
 *
 * The fake device answers each `commandPlan()` command with captured busybox
 * output, so `collect()` also gets an end-to-end test from socket to sample.
 *
 * Run: node tools/ssh-integration.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

// The plugin root and the packaged runtime, resolved from this checkout rather
// than hardcoded — so a clone anywhere can run these suites.
const PLUGIN = ROOT_URL;

const require = createRequire(dshHomePosix() + "/profiles/desktop/x.js");
const { Server, utils } = require("ssh2");

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

//#region the fake busybox device
/** Captured /proc and command output for a plausible small Linux device. */
const FIXTURES = {
	"cat /proc/stat": [
		"cpu  1200 30 400 8000 20 0 15 0 0 0",
		"cpu0 600 15 200 4000 10 0 7 0 0 0",
		"cpu1 600 15 200 4000 10 0 8 0 0 0",
		"intr 12345 0 0",
		"ctxt 98765",
		"btime 1700000000",
		"processes 4321",
		"procs_running 2",
		"procs_blocked 0",
		"",
	].join("\n"),
	"cat /proc/meminfo": [
		"MemTotal:        1024000 kB",
		"MemFree:          204800 kB",
		"MemAvailable:     409600 kB",
		"Buffers:           30720 kB",
		"Cached:           204800 kB",
		"SwapTotal:             0 kB",
		"SwapFree:              0 kB",
		"",
	].join("\n"),
	"cat /proc/uptime 2>/dev/null": "86400.55 345600.20\n",
	// The load collector is TWO reads in one command: the averages and the
	// logical-CPU tally those averages are only interpretable against. A fixture
	// answering only the first line would leave `load.cores` null and make every
	// downstream scaling assertion pass for the wrong reason.
	"cat /proc/loadavg 2>/dev/null; grep -c '^cpu[0-9]' /proc/stat 2>/dev/null || true": "0.15 0.10 0.05 1/128 4321\n2\n",
	"cat /proc/cpuinfo 2>/dev/null | head -40 || true": [
		"processor\t: 0",
		"model name\t: ARMv8 Processor rev 4 (v8l)",
		"BogoMIPS\t: 50.00",
		"Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid",
		"CPU implementer\t: 0x41",
		"CPU architecture: 8",
		"CPU variant\t: 0x0",
		"CPU part\t: 0xd03",
		"CPU revision\t: 4",
		"",
		"processor\t: 1",
		"model name\t: ARMv8 Processor rev 4 (v8l)",
		"BogoMIPS\t: 50.00",
		"",
	].join("\n"),
	"uname -a; cat /proc/version 2>/dev/null || true": [
		"Linux edge-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux",
		"Linux version 5.15.0-rc1 (build@host) (gcc 11.2.0) #1 SMP aarch64 GNU/Linux",
		"",
	].join("\n"),
	"LC_ALL=C df -P 2>/dev/null || df -P -k 2>/dev/null || true": [
		"Filesystem           1024-blocks    Used Available Capacity Mounted on",
		"/dev/root                7565120 6808608    756512      95% /",
		"tmpfs                     512000      12    511988       1% /tmp",
		"overlay/x                7565120 6808608    756512      95% /overlay",
		"",
	].join("\n"),
	"ls /proc | grep -c '^[0-9]' 2>/dev/null || echo 0": "128\n",
	'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; n=$(cat "$z/type" 2>/dev/null); v=$(cat "$z/temp" 2>/dev/null); [ -n "$v" ] && echo "${n:-thermal} $v"; done 2>/dev/null || true': "cpu-thermal 71200\n",
	"LC_ALL=C ps axo user,pid,pcpu,pmem --sort=-pcpu 2>/dev/null | awk 'NR>1 && NR<=6{print $1, $2, $3, $4}' || true": [
		"root 1 12.5 3.1",
		"www-data 812 8.0 5.4",
		"root 44 3.2 0.8",
		"",
	].join("\n"),
	"awk 'NR>2 { n=$1; sub(/:$/,\"\",n); if (n != \"lo\") print n, $2, $10 }' /proc/net/dev 2>/dev/null || true": [
		// What the awk really emits: the name, then the two columns it selected.
		// An earlier fixture listed the RAW 16-column file here, which the parser
		// accepted, so the parser's inability to read the emitted form went
		// unnoticed — `net` parsed to [] in production and stayed empty forever.
		"eth0 175588227558 115399948293",
		"docker0 0 0",
		"",
	].join("\n"),
	"awk '{ n=$3; if (n !~ /^(loop|ram|sr|fd)/) print n, $6, $10 }' /proc/diskstats 2>/dev/null || true": [
		// Same reasoning: the awk already picked $3=$name, $6=sectors_read,
		// $10=sectors_written, so the emitted line has THREE fields.
		"nvme0n1 35624161 463944552",
		"loop0 1 2",
		"",
	].join("\n"),
	"if command -v ss >/dev/null 2>&1; then ss -tan 2>/dev/null | awk 'NR>1 { n++ } END { print n+0 }'; else cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk 'NR>1 { n++ } END { print n+0 }'; fi": "17\n",
	"systemctl --no-pager --no-legend list-units --type=service --state=running 2>/dev/null | awk '{print $1}' | head -30 || true": "sshd.service\nnginx.service\ncron.service\n",
	"mount | head -20 2>/dev/null || true": [
		"/dev/root on / type ext4 (rw,relatime)",
		"proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)",
		"sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)",
		"",
	].join("\n"),
	"uname -a 2>/dev/null || echo unknown": "Linux edge-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux\n",
	"echo hello": "hello\n",
	"echo to-stderr 1>&2; echo to-stdout": "to-stdout\n",
	"exit 7": "",
	"sleep 30": "",
};

/** Every command this server was asked to run, in order. */
const received = [];
/** Set to fail authentication for the next connections. */
let authMode = "accept";
/** Artificial delay before a command answers, to exercise the timeout path. */
let commandDelayMs = 0;

function respond(command) {
	if (Object.hasOwn(FIXTURES, command)) return { body: FIXTURES[command], code: 0 };
	// Command-specific exit codes for the negative cases.
	if (command === "exit 7") return { body: "", code: 7 };
	return { body: "", code: 127 }; // unknown command, like a real shell
}
//#endregion

//#region server
const hostKey = utils.generateKeyPairSync("ed25519").private;
const PASSWORD = "correct-horse";

const server = new Server({ hostKeys: [hostKey] }, (client) => {
	client.on("authentication", (authCtx) => {
		received.push({ type: "auth", method: authCtx.method, username: authCtx.username });
		if (authMode === "reject") return authCtx.reject();
		if (authMode === "keyboard" && authCtx.method === "keyboard-interactive") {
			// Mimic a device that answers with a password prompt instead of
			// the "password" method.
			return authCtx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
				if (answers[0] === PASSWORD) authCtx.accept();
				else authCtx.reject();
			});
		}
		if (authCtx.method !== "password") return authCtx.reject(["password", "keyboard-interactive"]);
		if (authCtx.password === PASSWORD) return authCtx.accept();
		return authCtx.reject();
	});
	client.on("ready", () => {
		client.on("session", (accept) => {
			const session = accept();
			session.on("exec", (acceptExec, _reject, info) => {
				const command = info.command;
				received.push({ type: "exec", command });
				const stream = acceptExec();
				const { body, code } = respond(command);
				const send = () => {
					if (command === "exit 7") {
						stream.exit(7);
						stream.end();
						return;
					}
					if (command === "sleep 30") return; // never answers; the client times out
					// Emulate the shell redirect: a real `echo x 1>&2` lands on
					// the channel's extended-data stream, which is what
					// `stream.stderr` is.
					if (command === "echo to-stderr 1>&2; echo to-stdout") {
						stream.stderr.write("to-stderr\n");
						stream.write("to-stdout\n");
						stream.exit(0);
						stream.end();
						return;
					}
					stream.write(body);
					stream.exit(code);
					stream.end();
				};
				if (commandDelayMs > 0) setTimeout(send, commandDelayMs);
				else send();
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
console.log(`fake busybox device listening on 127.0.0.1:${PORT}\n`);
//#endregion

// The plugin resolves ssh2 from DSH_PROFILE_DIR; point it at the profile that owns it.
process.env.DSH_PROFILE_DIR = dshHomePosix() + "/profiles/desktop";
// Raw-data logging writes under $DSH_HOME, so point it at a scratch directory:
// the real home is outside the workspace sandbox and the write would EPERM.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "ddm-ssh-"));

const ssh = await import(`${PLUGIN}/src/ssh.js`);
const { commandPlan, aggregate } = await import(`${PLUGIN}/src/collectors.js`);

/** A stored device row pointing at the fake server. */
const device = (overrides = {}) => ({
	id: "fake-01",
	name: "Fake 01",
	host: "127.0.0.1",
	port: PORT,
	username: "root",
	auth: { kind: "password", password: PASSWORD },
	...overrides,
});

console.log("== the module loads ssh2 ==");
check("loadSsh2 returns a module with Client", typeof ssh.loadSsh2()?.Client === "function");
eq("COLLECT_TIMEOUT_MS", ssh.COLLECT_TIMEOUT_MS, 60_000);

console.log("\n== connect / exec against a real SSH server ==");
let conn;
try {
	conn = await ssh.connect(device());
	check("connect resolved a live client", conn !== undefined && typeof conn.exec === "function");

	const ok = await ssh.exec(conn, "echo hello");
	eq("stdout round-trips", ok.stdout, "hello\n");
	eq("exit code is 0", ok.code, 0);
	eq("stderr is empty", ok.stderr, "");
	check("duration is recorded", typeof ok.durationMs === "number" && ok.durationMs >= 0);

	const both = await ssh.exec(conn, "echo to-stderr 1>&2; echo to-stdout");
	eq("stdout and stderr are separated", `${both.stdout}|${both.stderr}`, "to-stdout\n|to-stderr\n");

	const bad = await ssh.exec(conn, "exit 7");
	eq("a non-zero exit code is reported", bad.code, 7);
	check("a non-zero exit is not an error object", bad.error === undefined);

	const unknown = await ssh.exec(conn, "definitely-not-a-command");
	eq("an unknown command reports 127", unknown.code, 127);
} finally {
	if (conn) ssh.dispose(conn);
}

console.log("\n== authentication paths ==");
const goodProbe = await ssh.test(device());
check("test() reports ok for valid credentials", goodProbe.ok === true, JSON.stringify(goodProbe));
check("test() reports a latency", typeof goodProbe.latencyMs === "number" && goodProbe.latencyMs >= 0);
check("test() returns the uname banner", goodProbe.banner.includes("edge-gw-01"), goodProbe.banner);

const badPassword = await ssh.test({ ...device(), auth: { kind: "password", password: "wrong" } });
check("test() reports failure for a bad password", badPassword.ok === false, JSON.stringify(badPassword));
check("test() surfaces an error message", typeof badPassword.error === "string" && badPassword.error.length > 0, badPassword.error);

// A device that only offers keyboard-interactive must still authenticate,
// because connectOptions sets tryKeyboard for the password path.
authMode = "keyboard";
const keyboardProbe = await ssh.test(device());
check("test() succeeds when the device answers with keyboard-interactive", keyboardProbe.ok === true, JSON.stringify(keyboardProbe));
authMode = "accept";

// A device that rejects everything must fail cleanly rather than hang.
authMode = "reject";
const rejected = await ssh.test(device());
check("test() reports failure when every method is rejected", rejected.ok === false, JSON.stringify(rejected));
authMode = "accept";

// An unreachable port must fail fast, not hang.
const dead = await ssh.test({ ...device(), port: 1 });
check("test() fails for a closed port", dead.ok === false);
check("a closed port does not hang", dead.latencyMs < 15_000, `${dead.latencyMs}ms`);

console.log("\n== exec timeout ==");
let timeoutConn;
try {
	timeoutConn = await ssh.connect(device());
	const started = Date.now();
	const hung = await ssh.exec(timeoutConn, "sleep 30", 700);
	eq("a hung command reports timedOut", hung.timedOut, true);
	check("the timeout fires near its budget", Date.now() - started < 5_000, `${Date.now() - started}ms`);
} finally {
	if (timeoutConn) ssh.dispose(timeoutConn);
}

console.log("\n== collect() end to end ==");
const plan = commandPlan();
const { sample, diagnostics } = await ssh.collect(device(), undefined);
check("every planned command has a diagnostic row", diagnostics.length === Object.keys(plan).length,
	`${diagnostics.length} rows for ${Object.keys(plan).length} commands`);
check("every diagnostic carries a duration", diagnostics.every((row) => typeof row.durationMs === "number"));
check("no diagnostic failed against the fixture device", diagnostics.every((row) => row.exitCode === 0 && row.timedOut === false && row.error === undefined),
	JSON.stringify(diagnostics.filter((row) => row.exitCode !== 0 || row.timedOut || row.error)));
eq("the sample is tagged with the device id", sample.deviceId, "fake-01");
check("the sample records a duration", typeof sample.durationMs === "number" && sample.durationMs >= 0);

// The parsed values, straight from the fixture text. Field names follow the
// aggregate shape in src/collectors.js (e.g. memory is reported in MB).
eq("cpu core count", sample.cpu?.cores, 2);
eq("cpu model", sample.model, "ARMv8 Processor rev 4 (v8l)");
eq("memory total", sample.memory?.totalMB, 1000);
eq("memory available", sample.memory?.availableMB, 400);
eq("memory used percent", sample.memory?.usagePercent, 60);
eq("uptime (ms)", sample.uptimeMs, 86400550);
eq("uptime text", sample.uptimeText, "1d 0h 0m");
eq("load average 1m", sample.load?.load1, 0.15);
// The load reading carries the core count it must be measured against, read
// from the tally that rides with /proc/loadavg rather than from the CPU metric.
// Without this the client has to borrow `cpu.cores` — which is absent whenever
// CPU is switched off, and was filled in with a fabricated 1 instead.
eq("load carries its own core count", sample.load?.cores, 2);
eq("process count", sample.processes, 128);
eq("kernel", sample.kernel, "Linux edge-gw-01 5.15.0-rc1 #1 SMP aarch64 GNU/Linux");
check("running services were parsed", Array.isArray(sample.services) && sample.services.includes("sshd.service"), JSON.stringify(sample.services));
check("filesystems were parsed", Array.isArray(sample.disk) && sample.disk.length >= 1, JSON.stringify(sample.disk?.map((row) => row.mount)));
const root = sample.disk?.find((row) => row.mount === "/");
eq("root filesystem capacity is 95%", root?.usagePercent, 95);
eq("root filesystem size", root?.sizeMB, 7388);
eq("thermal is reported in celsius", sample.thermal?.[0]?.celsius, 71.2);
eq("thermal zone type", sample.thermal?.[0]?.type, "cpu-thermal");

// `net` and `diskio` are RATE metrics, so a first sample legitimately has no
// figure — but the ROWS must be there, or the rate can never be computed on the
// next poll. Asserting only the rate would pass with an empty row list, which is
// exactly how the emitted-vs-raw parse bug survived: the metric stayed empty and
// `rxTotal: null` looked like the expected "no baseline yet".
check("the network interfaces were parsed", Array.isArray(sample.netRows) && sample.netRows.length >= 1,
	JSON.stringify(sample.netRows));
eq("the network rows carry the emitted interface", sample.netRows?.[0]?.name, "eth0");
eq("the network rows carry the emitted rx counter", sample.netRows?.[0]?.rxBytes, 175588227558);
eq("the network rows carry the emitted tx counter", sample.netRows?.[0]?.txBytes, 115399948293);
check("the disk devices were parsed", Array.isArray(sample.dioRows) && sample.dioRows.length >= 1,
	JSON.stringify(sample.dioRows));
eq("the disk rows carry the emitted device", sample.dioRows?.[0]?.name, "nvme0n1");
eq("the disk rows carry the emitted read counter", sample.dioRows?.[0]?.sectorsRead, 35624161);
eq("the disk rows carry the emitted write counter", sample.dioRows?.[0]?.sectorsWritten, 463944552);
check("the fixture's loop device was filtered by the awk", !(sample.dioRows ?? []).some((row) => row.name === "loop0"),
	JSON.stringify(sample.dioRows));
// The tcp collector is a plain integer, and 0 is a legitimate reading.
eq("the tcp connection count was parsed", sample.tcp, 17);

console.log("\n== the CPU delta needs a prior sample ==");
// A single sample cannot know CPU% without a previous procStat baseline; it
// must report 0 rather than a fabricated value, and a changed baseline must
// yield a real percentage.
const first = await ssh.collect(device(), undefined);
eq("the first sample reports 0% cpu (no baseline)", first.sample.cpu?.percent, 0);

// Feed a synthetic previous sample whose procStat is 100 units lower, so the
// delta is unambiguous: 100 busy units out of 200 total across 2 cores.
const prev = aggregate(undefined, { procStat: "cpu  1100 30 400 8000 20 0 15 0 0 0\n" });
const second = await ssh.collect(device(), prev);
check("a previous sample yields a cpu percent", typeof second.sample.cpu?.percent === "number", JSON.stringify(second.sample.cpu));
check("the cpu percent is within 0..100", second.sample.cpu?.percent >= 0 && second.sample.cpu?.percent <= 100, `${second.sample.cpu?.percent}%`);

console.log("\n== a partially broken device still collects ==");
// Remove the /sys answer: the thermal command exits non-zero, which must
// degrade to an empty value without aborting the pass.
const THERMAL_CMD = 'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; n=$(cat "$z/type" 2>/dev/null); v=$(cat "$z/temp" 2>/dev/null); [ -n "$v" ] && echo "${n:-thermal} $v"; done 2>/dev/null || true';
const savedThermal = FIXTURES[THERMAL_CMD];
delete FIXTURES[THERMAL_CMD];
const degraded = await ssh.collect(device(), undefined);
check("collection still succeeds without a thermal zone", degraded.sample.cpu?.cores === 2, JSON.stringify(degraded.sample.cpu));
check("the missing temperature degrades to an empty list", (degraded.sample.thermal ?? []).length === 0, JSON.stringify(degraded.sample.thermal));
check("memory still parsed on the degraded device", degraded.sample.memory?.totalMB === 1000, JSON.stringify(degraded.sample.memory));
check("the degraded device still reports a kernel", degraded.sample.kernel.includes("edge-gw-01"));
FIXTURES[THERMAL_CMD] = savedThermal;

console.log("\n== R3: an unselected metric never runs a command ==");
// The whole point of the metric selection is that an unticked metric costs the
// device NOTHING — not "the command runs and the row is hidden". A mocking
// suite cannot prove this: it stubs `exec`, so it cannot see which command
// strings crossed the wire. This is the only place the real gate is observable,
// and it must be asserted against what the SERVER received.
{
	const before = received.filter((row) => row.type === "exec").length;
	const only = await ssh.collect(device(), undefined, ["mem"]);
	const sent = received.filter((row) => row.type === "exec").slice(before).map((row) => row.command);
	check("only the selected metric plus the context collectors ran", !sent.includes("cat /proc/stat"),
		`cat /proc/stat was sent while only 'mem' was ticked: ${JSON.stringify(sent)}`);
	check("an unselected metric is absent from the wire", !sent.includes("cat /proc/uptime 2>/dev/null"), JSON.stringify(sent));
	check("the selected metric did run", sent.includes("cat /proc/meminfo"), JSON.stringify(sent));
	// The context collectors (kernel line, service list, mount table) are
	// deliberately NOT part of the vocabulary, so they run regardless: the
	// existing card UI depends on them.
	check("the context collectors still ran", sent.includes("uname -a; cat /proc/version 2>/dev/null || true"), JSON.stringify(sent));
	check("an unselected metric parses to null, not 0", only.sample.cpu === null, JSON.stringify(only.sample.cpu));
	check("the selected metric parsed", only.sample.memory?.totalMB === 1000, JSON.stringify(only.sample.memory));
}

console.log("\n== custom commands replace a body but never open the gate ==");
// The design's risk is specific: a custom command is an execution path that
// bypasses the Agent tool command whitelist. Three things must therefore hold
// on the WIRE, not in a mock: the override replaces the body, it is armed only
// by a real boolean `true`, and it can never resurrect an unselected metric.
{
	const CUSTOM = "echo custom-mem-probe";
	const before = received.filter((row) => row.type === "exec").length;
	const pass = await ssh.collect(device(), undefined, ["mem"], {
		customCommands: { enabled: true, overrides: { mem: CUSTOM } },
	});
	const sent = received.filter((row) => row.type === "exec").slice(before).map((row) => row.command);
	check("the override body reached the device", sent.includes(CUSTOM), JSON.stringify(sent));
	check("the built-in body was replaced, not appended", !sent.includes("cat /proc/meminfo"), JSON.stringify(sent));
	check("only the selected metric was overridden", sent.includes("uname -a; cat /proc/version 2>/dev/null || true"), JSON.stringify(sent));
	check("the overridden pass still returns a sample", typeof pass.sample === "object", JSON.stringify(pass).slice(0, 200));

	// `"true"` is the typo the normalizer exists to reject — but the plan is a
	// second, independent gate, so a caller that hand-builds the object (a test,
	// a migration, a future route) cannot bypass it.
	{
		const gateBefore = received.filter((row) => row.type === "exec").length;
		await ssh.collect(device(), undefined, ["mem"], {
			customCommands: { enabled: "true", overrides: { mem: CUSTOM } },
		});
		const gated = received.filter((row) => row.type === "exec").slice(gateBefore).map((row) => row.command);
		check("a string 'true' does not arm the override", !gated.includes(CUSTOM), JSON.stringify(gated));
		check("the built-in body runs when the override is not armed", gated.includes("cat /proc/meminfo"), JSON.stringify(gated));
	}

	// The SELECTION gate runs first, so an override on an unticked metric must
	// produce no command at all — an override is a replacement, never a licence
	// to collect something the user switched off.
	{
		const offBefore = received.filter((row) => row.type === "exec").length;
		await ssh.collect(device(), undefined, ["mem"], {
			customCommands: { enabled: true, overrides: { cpu: "echo custom-cpu-probe" } },
		});
		const off = received.filter((row) => row.type === "exec").slice(offBefore).map((row) => row.command);
		check("an override on an UNSELECTED metric runs nothing", !off.includes("echo custom-cpu-probe"), JSON.stringify(off));
		check("the unselected built-in is still absent too", !off.includes("cat /proc/stat"), JSON.stringify(off));
	}

	check("an unarmed override leaves the built-in plan intact",
		Object.values(commandPlan(["mem"])).every((entry) => entry.overridden === undefined),
		JSON.stringify(commandPlan(["mem"])));
	check("an armed override is marked so it can be audited",
		commandPlan(["mem"], { enabled: true, overrides: { mem: CUSTOM } }).procMem?.overridden === true,
		JSON.stringify(commandPlan(["mem"], { enabled: true, overrides: { mem: CUSTOM } })));
}

console.log("\n== R6: the raw log records what the device actually said ==");
// Asserted from the PUBLIC entry point against the ON-DISK result. The
// reference's measured escapee was exactly this wiring: dropping the device id
// from the write still produced a legal file, a created directory and a
// successful append, so every function-level unit stayed green while two
// same-named devices silently shared one file.
{
	const { readRawLines, deviceLogFiles, rawLogDir } = await import(`${PLUGIN}/src/raw-log.js`);
	// `readRawLines` returns plain LINES, newest first — so the trailing blank
	// line of the last block comes back before anything interesting. Join the
	// whole tail to reconstruct the block rather than reading the first rows.
	const drain = (d) => readRawLines(d, 500).join("\n");
	const rows = readRawLines(device(), 5);
	check("a successful pass left at least one raw record", rows.length > 0, `${rows.length} rows in ${rawLogDir()}`);
	const text = drain(device());
	check("the raw record names the device", text.includes("Fake 01"), text.slice(0, 200));
	check("the raw record carries the command it came from", text.includes("==procMem==") && text.includes("cat /proc/meminfo"), text.slice(0, 300));
	check("the raw record carries the verbatim stdout", text.includes("MemTotal:"), text.slice(0, 300));
	check("the raw record is per-device, named with the id suffix", deviceLogFiles(device()).some((f) => f.includes("Fake 01-fake01")), JSON.stringify(deviceLogFiles(device())));

	// A DIFFERENT device with the SAME name must not read or write this file.
	const twin = device({ id: "zz9999999", name: "Fake 01" });
	check("a same-named device is separated by the id suffix", deviceLogFiles(twin).every((f) => !deviceLogFiles(device()).includes(f)), JSON.stringify(deviceLogFiles(twin)));
	check("a same-named device reads none of its twin's records", readRawLines(twin, 5).length === 0, JSON.stringify(readRawLines(twin, 5).length));

	// A FAILED pass must still leave evidence: "why is this metric unreadable"
	// is almost always answered by the failure path, never the success path.
	const dead = device({ port: PORT + 1 });
	let threw = false;
	try {
		await ssh.collect(dead, undefined, ["mem"]);
	} catch { threw = true; }
	check("a failed collection still throws to the caller", threw);
	const failed = drain(dead);
	check("a failed pass was recorded too", failed.trim() !== "", JSON.stringify(failed.slice(0, 120)));
	check("the failure record says it failed", failed.includes("[失败]"), failed.slice(0, 200));

	// And the log switch must be honoured: `rawLog: false` writes nothing.
	const quiet = device({ id: "quiet01", name: "Quiet" });
	await ssh.collect(quiet, undefined, ["mem"], { rawLog: false });
	check("disabling the raw log writes nothing", readRawLines(quiet, 5).length === 0, JSON.stringify(readRawLines(quiet, 5).length));
}

console.log("\n== the connection is actually short-lived ==");
const sessionsBefore = received.filter((row) => row.type === "exec").length;
await ssh.collect(device(), undefined);
const sessionsAfter = received.filter((row) => row.type === "exec").length;
check("collect ran the whole plan over one connection", sessionsAfter - sessionsBefore === Object.keys(plan).length,
	`${sessionsAfter - sessionsBefore} execs for ${Object.keys(plan).length} commands`);

console.log("\n== what the server actually saw ==");
const commands = received.filter((row) => row.type === "exec").map((row) => row.command);
check("every planned command was sent verbatim", Object.values(plan).every((entry) => commands.includes(entry.cmd)),
	Object.values(plan).filter((entry) => !commands.includes(entry.cmd)).map((entry) => entry.cmd).join(" | "));
check("authentication was attempted as the stored username", received.some((row) => row.type === "auth" && row.username === "root"));
const passwordAuths = received.filter((row) => row.type === "auth" && row.method === "password").length;
check("password auth was attempted", passwordAuths > 0, `${passwordAuths}`);

server.close();
rmSync(process.env.DSH_HOME, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? "the SSH transport works against a real ssh2 server" : `${failures} failed`}`);
if (failures > 0) process.exit(1);
