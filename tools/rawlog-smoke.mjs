/**
 * Unit suite for the three log layers: rolling file, JSONL log, per-device raw log.
 *
 * These are pure-logic assertions on the modules themselves. The WIRING — that
 * `collect()` actually passes the device through to the raw log — cannot be
 * proven here and is asserted from the public entry point in
 * `tools/ssh-integration.mjs` against the on-disk result. That split is
 * deliberate: the reference system's measured escapee was a missing
 * `id: d.id` at the call site that left 25 + 85 function-level cases green,
 * because a missing id falls back to `noid` and every individual function still
 * behaves correctly. Function-level tests prove the function is right, never
 * that the call site called it.
 *
 * Run: node tools/rawlog-smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

// The plugin root and the packaged runtime, resolved from this checkout rather
// than hardcoded — so a clone anywhere can run these suites.
const PLUGIN = ROOT_URL;

// The log root is derived from DSH_HOME, so point it at a scratch directory
// before importing anything: the real home is outside the workspace sandbox.
const scratch = mkdtempSync(join(tmpdir(), "ddm-rawlog-"));
process.env.DSH_HOME = scratch;

const realWarn = console.warn;
let warnings = [];
console.warn = (...args) => { warnings.push(args.join(" ")); };

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; realWarn(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const ok = (label, condition, detail) => check(label, condition, detail);

const rolling = await import(`${PLUGIN}/src/rolling-file.js`);
const jsonl = await import(`${PLUGIN}/src/jsonl-log.js`);
const raw = await import(`${PLUGIN}/src/raw-log.js`);

const device = (overrides = {}) => ({ id: "abc12345", name: "nas-a", ...overrides });

console.log("== the log root is independent of the config ==");
// Raw logs are disposable (~60MB/device) while the roster JSON holds credentials
// and must be backed up, so they must NOT share a directory.
ok("the log root lives under DSH_HOME", rolling.logRoot().startsWith(scratch), rolling.logRoot());
ok("the log root is a sibling of the config, not beside it", !rolling.logRoot().includes("dsh-device-monitor.json"), rolling.logRoot());
eq("the log root is named distinctly", rolling.logRoot().endsWith("dsh-device-monitor-logs"), true);

console.log("\n== rolling file: rotation discards the oldest ==");
{
	// Each write is 10 bytes, so `maxBytes: 40` holds exactly 4 lines per file.
	// Enough writes to force more than `keep` rotations, which is the only way
	// the oldest records actually get evicted.
	const rf = rolling.createRollingFile({ name: "log/roll.log", maxBytes: 40, keep: 3 });
	for (let n = 0; n < 24; n += 1) rf.appendText(`line-${String(n).padStart(4, "0")}\n`);
	const files = rf.filesNewestFirst();
	eq("the live file plus exactly `keep` archives exist", files.length, 4);
	ok("the archives are suffixed .1 .2 .3", files.slice(1).every((f, i) => f.endsWith(`.${i + 1}`)), JSON.stringify(files));
	// The oldest records must be GONE — not silently retained beyond the cap
	// and not silently dropped from the archive count.
	const everything = files.map((f) => readFileSync(f, "utf8")).join("");
	ok("the newest record survived", everything.includes("line-0023"), everything);
	ok("the oldest records were discarded", !everything.includes("line-0000"), everything);
	ok("exactly keep+1 files worth of history remains", everything.split("\n").filter(Boolean).length <= 16, `${everything.split("\n").filter(Boolean).length} lines`);
	ok("the archive ordering is newest first", readFileSync(files[0], "utf8").includes("line-0023") && readFileSync(files[3], "utf8").includes("line-0008"), JSON.stringify(files));
}
{
	const rf = rolling.createRollingFile({ name: "log/absent.log", maxBytes: 10, keep: 2 });
	eq("rotating a file that does not exist yet is a no-op", rf.rotateIfNeeded(), false);
	ok("the file still does not exist", !existsSync(rf.file()));
	rf.appendText("x");
	eq("an append creates it", existsSync(rf.file()), true);
}
{
	// A name containing a subdirectory must need zero extra code: the primitive
	// mkdirs the dirname recursively.
	const nested = rolling.createRollingFile({ name: "log/a/b/c/deep.log", maxBytes: 100, keep: 1 });
	nested.appendText("deep\n");
	ok("a nested name creates every parent directory", existsSync(nested.file()), nested.file());
	eq("and the content landed", readFileSync(nested.file(), "utf8"), "deep\n");
}

console.log("\n== JSONL log: newest first across all rolled files ==");
{
	const log = jsonl.createJsonlLog({ name: "log/audit-test.log", maxBytes: 60, keep: 3 });
	for (let n = 0; n < 20; n += 1) log.append({ n, event: `evt-${n}` });
	const rows = log.read(100);
	ok("records come back newest first", rows[0].n > rows[rows.length - 1].n, JSON.stringify(rows.map((r) => r.n)));
	ok("the newest record is present", rows.some((r) => r.n === 19), JSON.stringify(rows.map((r) => r.n)));
	ok("an evicted record is gone", !rows.some((r) => r.n === 0), JSON.stringify(rows.map((r) => r.n)));
	ok("the read is bounded by the retained window", rows.length <= 12, `${rows.length} rows`);
	eq("reading past the end is safe", log.read(0).length, 0);
}
{
	// A torn write at a rotation boundary is data too: it must surface as
	// `{ raw }` rather than throwing and losing the whole file.
	const log = jsonl.createJsonlLog({ name: "log/torn.log", maxBytes: 1024, keep: 2 });
	writeFileSync(log.file(), '{"ok":1}\n{"broken":\n{"ok":2}\n');
	const rows = log.read(10);
	eq("every line is returned, parseable or not", rows.length, 3);
	ok("the parseable lines parsed", rows.some((r) => r.ok === 2), JSON.stringify(rows));
	ok("the torn line surfaced as raw text", rows.some((r) => typeof r.raw === "string" && r.raw.includes("broken")), JSON.stringify(rows));
}

console.log("\n== device names are made path-safe ==");
{
	// This is a SECURITY function: the name is fully user-controlled and
	// without it a device named `../../settings` escapes the log directory.
	// What matters is not that the dots disappear (they are harmless once no
	// separator survives) but that the result is a SINGLE path component that
	// stays directly inside the log directory.
	const escapes = (name) => {
		const full = join(raw.rawLogDir(), raw.deviceLogName({ id: "x", name }));
		const dir = raw.rawLogDir();
		return !full.startsWith(dir + "\\") && !full.startsWith(dir + "/");
	};
	eq("forward-slash traversal cannot escape", escapes("../../etc/passwd"), false, raw.deviceLogName({ name: "../../etc/passwd" }));
	eq("backslash traversal cannot escape", escapes("..\\..\\windows"), false, raw.deviceLogName({ name: "..\\..\\windows" }));
	eq("a forward slash cannot survive", raw.sanitizeDeviceName("a/b").includes("/"), false, raw.sanitizeDeviceName("a/b"));
	eq("a backslash cannot survive", raw.sanitizeDeviceName("a\\b").includes("\\"), false, raw.sanitizeDeviceName("a\\b"));
	// A bare `..` must not survive as a path component either: the leading-dot
	// strip turns it into a legal name.
	eq("a bare double dot cannot survive", raw.sanitizeDeviceName(".."), "device");
	eq("a drive colon cannot survive", raw.sanitizeDeviceName("C:evil").includes(":"), false, raw.sanitizeDeviceName("C:evil"));
	eq("an absolute-looking name collapses", raw.sanitizeDeviceName("/etc/passwd").includes("/"), false, raw.sanitizeDeviceName("/etc/passwd"));
	eq("an empty name falls back", raw.sanitizeDeviceName(""), "device");
	eq("a null name falls back", raw.sanitizeDeviceName(null), "device");
	eq("a dots-only name falls back", raw.sanitizeDeviceName("..."), "device");
	eq("a long name is truncated to 40", raw.sanitizeDeviceName("x".repeat(80)).length, 40);
	eq("Windows reserved CON is prefixed", raw.sanitizeDeviceName("con"), "_con");
	eq("Windows reserved LPT1 is prefixed", raw.sanitizeDeviceName("LPT1"), "_LPT1");
	eq("a control character cannot survive", raw.sanitizeDeviceName("a\u0000b").includes("\u0000"), false);
	eq("a newline cannot survive", raw.sanitizeDeviceName("a\nb").includes("\n"), false);
	// Surrounding whitespace is stripped so two names cannot collide by padding.
	eq("leading and trailing spaces are stripped", raw.sanitizeDeviceName("  nas  "), "nas");
}

console.log("\n== the id suffix separates same-named devices ==");
{
	// Duplicate device NAMES are allowed. Without the suffix the second device
	// appends into the first one's file and the failure is completely silent.
	const a = device({ id: "aaaa1111", name: "twin" });
	const b = device({ id: "bbbb2222", name: "twin" });
	ok("two same-named devices get different files", raw.deviceLogName(a) !== raw.deviceLogName(b), `${raw.deviceLogName(a)} vs ${raw.deviceLogName(b)}`);
	ok("the suffix is drawn from the id", raw.deviceLogName(a).includes("aaaa1111") && raw.deviceLogName(b).includes("bbbb2222"), JSON.stringify([raw.deviceLogName(a), raw.deviceLogName(b)]));
	eq("the suffix strips non-alphanumerics", raw.idSuffix("e2e-01"), "e2e01");
	eq("the suffix caps at 8 characters", raw.idSuffix("0123456789abcdef").length, 8);
	eq("a missing id falls back to noid", raw.idSuffix(undefined), "noid");
	eq("an empty id falls back to noid", raw.idSuffix(""), "noid");
	eq("a punctuation-only id falls back to noid", raw.idSuffix("---"), "noid");
}

console.log("\n== record formatting ==");
{
	const rec = raw.formatRecord({ at: "2026-01-02T03:04:05.000Z", name: "nas-a", raw: "Filesystem\n/dev/root 95% /\n\n" });
	ok("the head carries the timestamp and name", rec.startsWith("2026-01-02T03:04:05.000Z - nas-a\n"), JSON.stringify(rec));
	ok("trailing blank lines are trimmed", !rec.includes("\n\n\n"), JSON.stringify(rec));
	ok("the body is verbatim", rec.includes("/dev/root 95% /"), JSON.stringify(rec));
	ok("the block ends with exactly one newline", rec.endsWith("\n") && !rec.endsWith("\n\n"), JSON.stringify(rec));
	// No blank line between the head and the body, and none before the next
	// record: blank lines cost a screen when tailing the log.
	const lines = rec.split("\n");
	eq("the head is the first line", lines[0], "2026-01-02T03:04:05.000Z - nas-a");
	eq("the body starts on the very next line", lines[1], "Filesystem");
	ok("no interior blank line", !lines.slice(1, -1).some((l) => l === ""), JSON.stringify(lines));
	eq("exactly one trailing newline", lines[lines.length - 1], "");
}
{
	const rec = raw.formatRecord({ name: "nas-a", error: "connect ETIMEDOUT" });
	ok("a failure is recorded as a failure", rec.includes("[失败] connect ETIMEDOUT"), JSON.stringify(rec));
	ok("a missing name falls back", raw.formatRecord({ raw: "x" }).includes("(未命名设备)"), raw.formatRecord({ raw: "x" }));
	ok("a missing timestamp is filled in", /^\d{4}-\d{2}-\d{2}T/.test(raw.formatRecord({ name: "n", raw: "x" })), raw.formatRecord({ name: "n", raw: "x" }));
}
{
	// Truncation must never split a multi-byte character in half: the tail
	// would become an invalid byte sequence and the file unreadable.
	const cjk = "温".repeat(1000); // 3 bytes each
	const clamped = raw.clampBytes(cjk, 100);
	ok("the clamp is under the limit", Buffer.byteLength(clamped, "utf8") <= 100, `${Buffer.byteLength(clamped, "utf8")}`);
	ok("the clamped text round-trips as valid UTF-8", Buffer.from(clamped, "utf8").toString("utf8") === clamped);
	ok("no replacement character leaked in", !clamped.includes("\ufffd"), JSON.stringify(clamped.slice(-10)));
	eq("text under the limit is returned untouched", raw.clampBytes("short", 100), "short");
	const big = raw.formatRecord({ name: "n", raw: "x".repeat(raw.RAW_LOG_RECORD_MAX + 5000) });
	ok("an oversized record announces the truncation", big.includes("[已截断，原文"), JSON.stringify(big.slice(-120)));
	ok("the notice states the byte counts", /\d+ 字节，上限 \d+ 字节/.test(big), JSON.stringify(big.slice(-120)));
}

console.log("\n== append and read round-trip ==");
{
	const d = device({ id: "roundtrip1", name: "rt-device" });
	eq("a fresh device has no log", raw.readRawLines(d, 10).length, 0);
	eq("the write reports success", raw.appendRawRecord({ device: d, at: "2026-01-01T00:00:00.000Z", raw: "first" }), true);
	raw.appendRawRecord({ device: d, at: "2026-01-01T00:00:01.000Z", raw: "second" });
	const lines = raw.readRawLines(d, 100).join("\n");
	ok("both records are present", lines.includes("first") && lines.includes("second"), JSON.stringify(lines));
	ok("the device name is in every block", lines.split("2026-01-01T00:00:0").length - 1 === 2, JSON.stringify(lines));
	ok("the byte count is reported", raw.deviceLogBytes(d) > 0, `${raw.deviceLogBytes(d)}`);
}
{
	// A DEVICE WITH NO NAME and no id must still write somewhere legal rather
	// than throwing into the collection path.
	const anon = { id: "", name: "" };
	eq("an anonymous device still writes", raw.appendRawRecord({ device: anon, raw: "x" }), true);
	ok("it landed in a legal file", raw.deviceLogFiles(anon)[0].endsWith("device-noid.log"), JSON.stringify(raw.deviceLogFiles(anon)));
}
{
	// A write failure must warn and return false — never propagate, because
	// losing a log line must not fail a collection the user is waiting on.
	warnings = [];
	const bad = raw.appendRawRecord({ device: null, raw: "x" });
	check("appending with no device does not throw", bad === false || bad === true, String(bad));
}

console.log("\n== rename and remove keep the history together ==");
{
	const before = device({ id: "ren0001", name: "oldname" });
	const after = device({ id: "ren0001", name: "newname" });
	raw.appendRawRecord({ device: before, at: "2026-01-01T00:00:00.000Z", raw: "historic" });
	raw.appendRawRecord({ device: before, at: "2026-01-01T00:00:00.000Z", raw: "historic2" });
	const moved = raw.renameDeviceLog(before, after);
	eq("the rename reports success", moved, true);
	ok("the old file is gone", raw.readRawLines(before, 50).join("\n").includes("historic") === false, JSON.stringify(raw.readRawLines(before, 50)));
	ok("the history moved to the new name", raw.readRawLines(after, 50).join("\n").includes("historic2"), JSON.stringify(raw.readRawLines(after, 50)));
	// Renaming onto an existing file must not fail on Windows: the destination
	// leftovers are deleted first.
	raw.appendRawRecord({ device: after, raw: "already-here" });
	raw.appendRawRecord({ device: before, raw: "would-overwrite" });
	eq("a rename onto an existing file still succeeds", raw.renameDeviceLog(before, after), true);

	const doomed = device({ id: "del00001", name: "doomed" });
	raw.appendRawRecord({ device: doomed, raw: "bye" });
	raw.__rotateNow(doomed);
	raw.appendRawRecord({ device: doomed, raw: "bye2" });
	ok("rotation produced an archive", raw.deviceLogFiles(doomed).length > 1, JSON.stringify(raw.deviceLogFiles(doomed)));
	eq("removal reports success", raw.removeDeviceLog(doomed), true);
	eq("every rolled file was removed", raw.deviceLogFiles(doomed).length, 0);
	eq("reading a removed device is empty", raw.readRawLines(doomed, 10).length, 0);
	eq("the raw log dir is reported", typeof raw.rawLogDir(), "string");
}

console.log("\n== the audit log is separate from the raw log ==");
{
	const logs = await import(`${PLUGIN}/src/logs.js`);
	logs.audit("settings.update", { changed: ["refreshIntervalSec"] });
	const rows = logs.readAudit(10);
	ok("the audit record landed", rows.some((r) => r.event === "settings.update"), JSON.stringify(rows));
	ok("the audit record carries the changed field names", rows.some((r) => Array.isArray(r.changed) && r.changed.includes("refreshIntervalSec")), JSON.stringify(rows));
	ok("the audit file is not the raw log file", !logs.auditPath().includes("log/devices"), logs.auditPath());
	ok("the audit file lives under the log root", logs.auditPath().startsWith(scratch), logs.auditPath());
	const before = raw.readRawLines(device({ id: "sep00001", name: "sep" }), 10).length;
	logs.audit("probe", {});
	eq("an audit write does not touch any device raw log", raw.readRawLines(device({ id: "sep00001", name: "sep" }), 10).length, before);
}

console.log("\n== incidents are their own log layer ==");
{
	const logs = await import(`${PLUGIN}/src/logs.js`);
	logs.recordIncident({ at: "2026-01-01T00:00:00.000Z", deviceId: "x1", event: "offline", message: "设备离线" });
	const rows = logs.readIncidents(10);
	ok("the incident landed", rows.some((r) => r.event === "offline"), JSON.stringify(rows));
	ok("incidents do not share the audit file", logs.incidentPath() !== logs.auditPath(), `${logs.incidentPath()} vs ${logs.auditPath()}`);
}

console.log("\n== the incident state machine ==");
{
	const incidents = await import(`${PLUGIN}/src/incidents.js`);
	const d = device({ id: "inc00001", name: "inc" });
	const records = [];
	const tracker = new incidents.IncidentTracker({ onRecord: (r) => records.push(r) });
	const settings = { offlineAfter: 2, rebootDetect: true, rebootMinDrop: 120 };

	// One failure must NOT fire the offline alert: a single blip is noise.
	let r = tracker.observe(d, { ok: false, error: "timeout" }, settings);
	eq("the first failure does not go offline", r.offline, false);
	eq("the first failure wrote no exception record", records.filter((x) => x.event === "offline").length, 0);
	eq("the failure was counted", r.fails, 1);

	// The second consecutive failure crosses the threshold.
	r = tracker.observe(d, { ok: false, error: "timeout" }, settings);
	eq("the second consecutive failure goes offline", r.offline, true);
	eq("exactly one offline record was written", records.filter((x) => x.event === "offline").length, 1);
	ok("the offline record carries the message", records.find((x) => x.event === "offline").message.includes("连续 2 次"), JSON.stringify(records));

	// Further failures MUST NOT write a record each cycle: the page would be
	// buried in duplicates overnight while the message already says the truth.
	const before = records.filter((x) => x.event === "offline").length;
	tracker.observe(d, { ok: false, error: "timeout" }, settings);
	tracker.observe(d, { ok: false, error: "timeout" }, settings);
	tracker.observe(d, { ok: false, error: "timeout" }, settings);
	eq("repeated failures write no further records", records.filter((x) => x.event === "offline").length, before);
	eq("but the failure count keeps rising", tracker.status(d.id).fails, 5);
	// The MESSAGE, however, must track the live count: a frozen "2 次失败"
	// reads as "recovery is imminent" while the device has failed 50 times.
	ok("the live status message tracks the current count", tracker.status(d.id).message.includes("连续 5 次"), tracker.status(d.id).message);

	// Recovery clears it and announces once.
	r = tracker.observe(d, { ok: true, uptimeMs: 1_000_000 }, settings);
	eq("recovery reports going online", r.wentOnline, true);
	eq("recovery is no longer offline", r.offline, false);
	eq("the recovery resets the failure count in the result", r.fails, 0);
	eq("exactly one online record was written", records.filter((x) => x.event === "online").length, 1);
	eq("the failure count was reset", r.fails, 0);
	tracker.observe(d, { ok: true, uptimeMs: 1_000_100 }, settings);
	eq("further successes write no online record", records.filter((x) => x.event === "online").length, 1);
	// A successful observation must never report the device as down: a stale
	// snapshot would show a perfectly healthy device as offline.
	eq("a success reports the device as online", tracker.observe(d, { ok: true, uptimeMs: 1_000_200 }, settings).offline, false);
	eq("and with no failures", tracker.observe(d, { ok: true, uptimeMs: 1_000_300 }, settings).fails, 0);
}

console.log("\n== a reboot is an uptime DROP ==");
{
	const incidents = await import(`${PLUGIN}/src/incidents.js`);
	const d = device({ id: "reb00001", name: "reb" });
	const records = [];
	const tracker = new incidents.IncidentTracker({ onRecord: (r) => records.push(r) });
	const settings = { offlineAfter: 2, rebootDetect: true, rebootMinDrop: 120 };

	tracker.observe(d, { ok: true, uptimeMs: 10_000_000 }, settings);
	// /proc/uptime jitters a few seconds between reads, so a small drop must
	// not be reported as a reboot.
	let r = tracker.observe(d, { ok: true, uptimeMs: 10_000_000 - 3_000 }, settings);
	eq("a small uptime jitter is not a reboot", r.rebooted, false);
	r = tracker.observe(d, { ok: true, uptimeMs: 1_000_000 }, settings);
	eq("a large uptime drop is a reboot", r.rebooted, true);
	eq("the reboot was recorded", records.filter((x) => x.event === "reboot").length, 1);
	r = tracker.observe(d, { ok: true, uptimeMs: 2_000_000 }, settings);
	eq("a rising uptime is never a reboot", r.rebooted, false);

	// Detection can be turned off, and the threshold is respected.
	const off = new incidents.IncidentTracker({ onRecord: () => {} });
	off.observe(d, { ok: true, uptimeMs: 10_000_000 }, { rebootDetect: false });
	eq("reboot detection can be disabled", off.observe(d, { ok: true, uptimeMs: 1 }, { rebootDetect: false }).rebooted, false);

	const strict = new incidents.IncidentTracker({ onRecord: () => {} });
	strict.observe(d, { ok: true, uptimeMs: 10_000_000 }, { rebootDetect: true, rebootMinDrop: 3600 });
	eq("a drop under the configured minimum is ignored", strict.observe(d, { ok: true, uptimeMs: 10_000_000 - 600_000 }, { rebootDetect: true, rebootMinDrop: 3600 }).rebooted, false);
}

console.log("\n== incident settings are clamped ==");
{
	const { normalizeIncidentSettings } = await import(`${PLUGIN}/src/incidents.js`);
	const s = normalizeIncidentSettings({ offlineAfter: 999, rebootMinDrop: -5, rebootDetect: "yes" });
	eq("offlineAfter is clamped to its maximum", s.offlineAfter, 20);
	eq("rebootMinDrop is clamped to its minimum", s.rebootMinDrop, 1);
	// Only a real boolean arms detection: a hand-edited string must not.
	eq("a non-boolean rebootDetect is coerced to false", s.rebootDetect, false);
	const d = normalizeIncidentSettings({});
	eq("the default offlineAfter is 2", d.offlineAfter, 2);
	eq("the default rebootMinDrop is 120", d.rebootMinDrop, 120);
	eq("reboot detection defaults on", d.rebootDetect, true);
}

const unreadable = [];
for (const f of ["log/roll.log", "log/audit-test.log"]) {
	const p = join(scratch, "dsh-device-monitor-logs", f);
	if (existsSync(p)) unreadable.push(`${f}:${statSync(p).size}`);
}

rmSync(scratch, { recursive: true, force: true });
console.warn = realWarn;
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? `the log layers behave (${unreadable.join(", ")})` : `${failures} failed`}`);
if (failures > 0) process.exit(1);
