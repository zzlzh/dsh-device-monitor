/**
 * Host suite for the settings / watch-lease / route surface added in R2 + R3.
 *
 * `tools/smoke.mjs` covers the device CRUD and the collectors; this suite owns
 * everything that arrived with the configurable-metrics and timed-refresh work:
 * the settings document and its normalization, the metric vocabulary's exact
 * semantics, threshold clamping, the watch lease, and the new routes' fences
 * and clamps.
 *
 * Run: node tools/settings-smoke.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

// The plugin root and the packaged runtime, resolved from this checkout rather
// than hardcoded — so a clone anywhere can run these suites.
const PLUGIN = ROOT_URL;
import { EventEmitter } from "node:events";

const scratch = mkdtempSync(join(tmpdir(), "ddm-settings-"));
process.env.DSH_HOME = scratch;
process.env.DSH_PROFILE_DIR = join(scratch, "profiles", "settings-smoke");

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const ok = (label, condition, detail) => check(label, condition, detail);

const keys = await import(`${PLUGIN}/src/metrics-keys.js`);
const settings = await import(`${PLUGIN}/src/settings.js`);
const series = await import(`${PLUGIN}/src/series.js`);
const metrics = await import(`${PLUGIN}/src/metrics.js`);
const { DeviceStore, storePath, MAX_DEVICES } = await import(`${PLUGIN}/src/store.js`);
const { Monitor } = await import(`${PLUGIN}/src/monitor.js`);
const monitorModule = await import(`${PLUGIN}/src/monitor.js`);
const { makeRoutes, API } = await import(`${PLUGIN}/src/routes.js`);

console.log("== the metric vocabulary matches the reference exactly ==");
{
	eq("there are eleven metrics", keys.METRIC_KEYS.length, 11);
	eq("the order is the reference's", keys.METRIC_KEYS.join(","), "uptime,load,cpu,mem,disk,temp,top,net,diskio,procs,tcp");
	eq("uptime is always collected", keys.ALWAYS_METRICS.join(","), "uptime");
	eq("the defaults are the reference's", keys.DEFAULT_METRICS.join(","), "uptime,load,cpu,mem,disk,temp,top");
	eq("every metric has a label", keys.METRIC_KEYS.every((k) => typeof keys.METRIC_LABELS[k] === "string" && keys.METRIC_LABELS[k] !== ""), true);
	eq("the labels are the reference's", keys.METRIC_LABELS.cpu, "CPU 使用率");
	eq("the catalog exposes every metric", keys.metricCatalog().length, 11);
	ok("the catalog marks uptime as always", keys.metricCatalog().find((m) => m.key === "uptime").always === true);
	ok("the catalog marks tcp as optional", keys.metricCatalog().find((m) => m.key === "tcp").always === false);
}

console.log("\n== normalizeMetrics: three semantics, all load-bearing ==");
{
	// (1) A MISSING value means "never configured" and renders everything.
	eq("undefined falls back to the defaults", keys.normalizeMetrics(undefined).join(","), keys.DEFAULT_METRICS.join(","));
	eq("null falls back to the defaults", keys.normalizeMetrics(null).join(","), keys.DEFAULT_METRICS.join(","));
	eq("a non-array falls back to the defaults", keys.normalizeMetrics("cpu").join(","), keys.DEFAULT_METRICS.join(","));
	eq("a number falls back to the defaults", keys.normalizeMetrics(7).join(","), keys.DEFAULT_METRICS.join(","));

	// (2) An EXPLICIT empty array is a real choice — "the user unticked
	// everything they could" — and must NOT fall back to the defaults, which
	// would silently re-enable six metrics the user just turned off.
	eq("an explicit empty array is respected", keys.normalizeMetrics([]).join(","), "uptime");
	ok("an empty array is not the defaults", keys.normalizeMetrics([]).join(",") !== keys.DEFAULT_METRICS.join(","));
	// `hasMetricChoice` is what lets the browser tell the two apart.
	eq("an empty array IS a recorded choice", keys.hasMetricChoice([]), true);
	eq("a missing value is NOT a recorded choice", keys.hasMetricChoice(undefined), false);
	eq("null is NOT a recorded choice", keys.hasMetricChoice(null), false);

	// (3) Illegal keys are dropped and the order is always METRIC_KEYS order,
	// regardless of the order the client sent.
	eq("illegal keys are dropped", keys.normalizeMetrics(["cpu", "evil", "mem", 42, null]).join(","), "uptime,cpu,mem");
	eq("the output follows METRIC_KEYS order, not the input order", keys.normalizeMetrics(["tcp", "cpu", "mem"]).join(","), "uptime,cpu,mem,tcp");
	eq("uptime is force-added", keys.normalizeMetrics(["cpu"]).includes("uptime"), true);
	eq("a duplicate collapses", keys.normalizeMetrics(["cpu", "cpu"]).join(","), "uptime,cpu");
	eq("an all-illegal array still keeps uptime", keys.normalizeMetrics(["nope", "nada"]).join(","), "uptime");
	eq("every metric selected round-trips", keys.normalizeMetrics([...keys.METRIC_KEYS]).join(","), keys.METRIC_KEYS.join(","));
	// Order is recovered from the vocabulary, so two spellings of the same set
	// compare equal — the client can rely on it for dirty-checking.
	eq("input order cannot change the result", keys.normalizeMetrics(["mem", "cpu"]).join(","), keys.normalizeMetrics(["cpu", "mem"]).join(","));
}

console.log("\n== the default refresh interval ==");
{
	eq("the default is 60 seconds", settings.DEFAULT_REFRESH_INTERVAL_SEC, 60);
	eq("the minimum is 5 seconds", settings.MIN_INTERVAL_SEC, 5);
	eq("the maximum is one hour", settings.MAX_INTERVAL_SEC, 3600);
	eq("no value falls back to 60", settings.normalizeIntervalSec(undefined), 60);
	eq("below the minimum is clamped up", settings.normalizeIntervalSec(1), 5);
	eq("above the maximum is clamped down", settings.normalizeIntervalSec(99999), 3600);
	eq("zero is clamped to the minimum", settings.normalizeIntervalSec(0), 5);
	eq("a negative is clamped to the minimum", settings.normalizeIntervalSec(-5), 5);
	eq("NaN falls back to the default", settings.normalizeIntervalSec(Number.NaN), 60);
	eq("a numeric string is accepted", settings.normalizeIntervalSec("120"), 120);
	eq("a fraction is rounded", settings.normalizeIntervalSec(90.6), 91);
	eq("the boundary value is kept", settings.normalizeIntervalSec(3600), 3600);
}

console.log("\n== thresholds: configurable, clamped, and 0 disables ==");
{
	eq("the defaults are the reference's", JSON.stringify(settings.DEFAULT_THRESHOLDS), JSON.stringify({ cpu: 90, mem: 90, disk: 85, temp: 80 }));
	eq("only four metrics alert", settings.THRESHOLD_KEYS.join(","), "cpu,mem,disk,temp");
	eq("a missing value falls back", settings.normalizeThreshold(undefined, 90), 90);
	eq("above 200 is clamped", settings.normalizeThreshold(500, 90), 200);
	eq("a negative is clamped to 0", settings.normalizeThreshold(-10, 90), 0);
	// 0 is a real setting meaning "never alert on this", not "unset".
	eq("zero is preserved, not treated as unset", settings.normalizeThreshold(0, 90), 0);
	// Number.isFinite, not a NaN check: NaN >= limit is always FALSE, so a NaN
	// threshold would silently kill that alert forever with no error anywhere.
	eq("NaN falls back rather than disabling the alert", settings.normalizeThreshold(Number.NaN, 90), 90);
	eq("Infinity falls back", settings.normalizeThreshold(Number.POSITIVE_INFINITY, 90), 90);
	eq("a numeric string is accepted", settings.normalizeThreshold("75", 90), 75);

	const t = settings.normalizeThresholds({ cpu: 50, mem: 0 });
	eq("an explicit threshold is kept", t.cpu, 50);
	eq("an explicit zero disables that alert", t.mem, 0);
	eq("an unspecified threshold takes the default", t.disk, 85);
	eq("an unspecified temperature takes the default", t.temp, 80);
}

console.log("\n== 0 threshold really silences the alert ==");
{
	const sample = { cpu: { percent: 99 }, memory: { usagePercent: 99 }, disk: [{ mount: "/", usagePercent: 99, sizeMB: 1, usedMB: 1, availableMB: 0 }], thermal: [{ type: "z", celsius: 99 }] };
	const all = metrics.evaluateAlerts(sample, { cpu: 90, mem: 90, disk: 85, temp: 80 });
	eq("every breach fires with the defaults", all.length, 4);
	const none = metrics.evaluateAlerts(sample, { cpu: 0, mem: 0, disk: 0, temp: 0 });
	eq("a zero threshold silences every alert", none.length, 0);
	const mixed = metrics.evaluateAlerts(sample, { cpu: 90, mem: 0, disk: 85, temp: 0 });
	eq("a zero threshold silences only its own metric", mixed.length, 2);
	ok("the silenced metric is absent", !mixed.some((a) => a.metric === "mem"), JSON.stringify(mixed.map((a) => a.metric)));
	ok("the alert names match the threshold keys, so one vocabulary spans both", all.every((a) => settings.THRESHOLD_KEYS.includes(a.metric)), JSON.stringify(all.map((a) => a.metric)));
	ok("every alert carries the limit that produced it", all.every((a) => typeof a.limit === "number"), JSON.stringify(all));
	// An unselected metric must not alert even when the value is in the sample.
	const gated = metrics.evaluateAlerts(sample, { cpu: 90, mem: 90, disk: 85, temp: 80 }, ["uptime", "cpu"]);
	eq("an unselected metric raises no alert", gated.length, 1);
	eq("the selected one still does", gated[0].metric, "cpu");
}

console.log("\n== custom commands: strict boolean, clearing, and bounds ==");
{
	const base = settings.defaultSettings();
	// Only a real `true` arms a path that bypasses the Agent command whitelist.
	eq("a string true does not arm it", settings.normalizeCustomCommands({ enabled: "true" }, keys.METRIC_KEYS).enabled, false);
	eq("the number 1 does not arm it", settings.normalizeCustomCommands({ enabled: 1 }, keys.METRIC_KEYS).enabled, false);
	eq("a real true arms it", settings.normalizeCustomCommands({ enabled: true }, keys.METRIC_KEYS).enabled, true);
	eq("it defaults to off", base.customCommands.enabled, false);
	eq("it defaults to no overrides", Object.keys(base.customCommands.overrides).length, 0);

	const o = settings.normalizeCustomCommands({ enabled: true, overrides: { cpu: "cat /proc/stat", evil: "rm -rf /" } }, keys.METRIC_KEYS);
	eq("a legal override is kept", o.overrides.cpu, "cat /proc/stat");
	eq("an illegal key is dropped", o.overrides.evil, undefined);
	eq("a non-string body is dropped", settings.normalizeCustomCommands({ overrides: { cpu: 42 } }, keys.METRIC_KEYS).overrides.cpu, undefined);
	eq("an empty body is dropped", settings.normalizeCustomCommands({ overrides: { cpu: "" } }, keys.METRIC_KEYS).overrides.cpu, undefined);
	eq("a body at the cap is kept", settings.normalizeCustomCommands({ overrides: { cpu: "x".repeat(2000) } }, keys.METRIC_KEYS).overrides.cpu.length, 2000);
	eq("a body over the cap is truncated", settings.normalizeCustomCommands({ overrides: { cpu: "x".repeat(5000) } }, keys.METRIC_KEYS).overrides.cpu.length, 2000);
	// Clearing is a meaningful operation, so an empty object/null DOES clear —
	// deliberately the opposite of the credential "only non-empty overrides" rule.
	eq("a null clears all overrides", Object.keys(settings.normalizeCustomCommands({ overrides: null }, keys.METRIC_KEYS).overrides).length, 0);
	eq("an empty object clears all overrides", Object.keys(settings.normalizeCustomCommands({ overrides: {} }, keys.METRIC_KEYS).overrides).length, 0);
	eq("an absent overrides key clears all overrides", Object.keys(settings.normalizeCustomCommands({ enabled: true }, keys.METRIC_KEYS).overrides).length, 0);
	eq("overrides do not arm by themselves", settings.normalizeCustomCommands({ overrides: { cpu: "x" } }, keys.METRIC_KEYS).enabled, false);
}

console.log("\n== raw logging defaults on and stays off once turned off ==");
{
	eq("the default is on", settings.defaultSettings().rawLog.enabled, true);
	eq("a missing value keeps it on", settings.normalizeRawLog(undefined).enabled, true);
	eq("an explicit false turns it off", settings.normalizeRawLog({ enabled: false }).enabled, false);
	eq("a string false does not turn it on", settings.normalizeRawLog({ enabled: "false" }).enabled, false);
	// Silently re-enabling after a restart would make "我明明关了" unexplainable.
	eq("an explicit true stays on", settings.normalizeRawLog({ enabled: true }).enabled, true);
}

console.log("\n== the terminal defaults off and cannot be armed by a string ==");
{
	const base = settings.defaultSettings();
	eq("the terminal defaults off", base.terminal.enabled, false);
	eq("it starts with no source restriction", base.terminal.allowedHosts.length, 0);
	eq("the idle default is five minutes", base.terminal.idleMs, settings.DEFAULT_TERMINAL_IDLE_MS);
	// This switch arms a full remote shell, so only a real boolean may open it —
	// exactly the customCommands rule, and for a stronger reason.
	eq("a string true does not arm it", settings.normalizeTerminal({ enabled: "true" }).enabled, false);
	eq("the number 1 does not arm it", settings.normalizeTerminal({ enabled: 1 }).enabled, false);
	eq("a real true arms it", settings.normalizeTerminal({ enabled: true }).enabled, true);
	eq("a missing subtree falls back to off", settings.normalizeTerminal(undefined).enabled, false);
	eq("a null subtree falls back to off", settings.normalizeTerminal(null).enabled, false);

	// The idle timeout has a FLOOR. A hand-edited 0 must not mean "never".
	eq("a zero idle is raised to the floor", settings.normalizeTerminal({ idleMs: 0 }).idleMs, settings.MIN_TERMINAL_IDLE_MS);
	eq("a negative idle is raised to the floor", settings.normalizeTerminal({ idleMs: -1 }).idleMs, settings.MIN_TERMINAL_IDLE_MS);
	eq("a below-floor idle is raised", settings.normalizeTerminal({ idleMs: 1000 }).idleMs, settings.MIN_TERMINAL_IDLE_MS);
	eq("an above-ceiling idle is lowered", settings.normalizeTerminal({ idleMs: 99_999_999 }).idleMs, settings.MAX_TERMINAL_IDLE_MS);
	eq("a legal idle is kept", settings.normalizeTerminal({ idleMs: 60_000 }).idleMs, 60_000);

	const hosts = settings.normalizeTerminal({ allowedHosts: [" 10.0.0.1 ", "10.0.0.1", "", 42, null, "dev.lan"] }).allowedHosts;
	eq("the allowlist is trimmed and de-duplicated", hosts.join(","), "10.0.0.1,dev.lan");
	eq("a non-string rule is dropped", settings.normalizeTerminal({ allowedHosts: [42] }).allowedHosts.length, 0);
	eq("the allowlist is capped", settings.normalizeTerminal({ allowedHosts: Array.from({ length: 50 }, (_, i) => `10.0.0.${i}`) }).allowedHosts.length, settings.TERMINAL_ALLOWED_HOSTS_MAX);
	// An empty list means "do not restrict the source"; the route is already
	// loopback-only, so this is a second lock rather than the first one.
	eq("an empty list stays empty", settings.normalizeTerminal({ allowedHosts: [] }).allowedHosts.length, 0);

	const { changed } = settings.applySettingsPatch(base, { terminal: { enabled: true } }, keys.METRIC_KEYS);
	eq("arming the terminal is reported", changed.join(","), "terminal.enabled");
	const idle = settings.applySettingsPatch(base, { terminal: { idleMs: 60_000 } }, keys.METRIC_KEYS);
	eq("an idle change is reported", idle.changed.join(","), "terminal.idleMs");
	eq("an idle change leaves the switch alone", idle.settings.terminal.enabled, false);
	const noop = settings.applySettingsPatch(base, { terminal: {} }, keys.METRIC_KEYS);
	eq("a no-op terminal patch reports nothing", noop.changed.length, 0);
}

console.log("\n== a settings patch reports only the changed field NAMES ==");
{
	const current = settings.defaultSettings();
	const { settings: next, changed } = settings.applySettingsPatch(current, { refreshIntervalSec: 120 }, keys.METRIC_KEYS);
	eq("the change applied", next.refreshIntervalSec, 120);
	eq("the changed list names the field", changed.join(","), "refreshIntervalSec");
	// Values may hold credentials, so the audit trail records NAMES only.
	ok("the changed list carries no values", changed.every((c) => typeof c === "string" && !c.includes("120")), JSON.stringify(changed));
	// An unchanged patch must report nothing, or the audit log fills with no-ops.
	const same = settings.applySettingsPatch(current, { refreshIntervalSec: 60 }, keys.METRIC_KEYS);
	eq("a no-op patch reports no change", same.changed.length, 0);
	const nested = settings.applySettingsPatch(current, { thresholds: { cpu: 50 } }, keys.METRIC_KEYS);
	ok("a nested change is reported with its path", nested.changed.some((c) => c.includes("thresholds")), JSON.stringify(nested.changed));
	eq("the nested change applied", nested.settings.thresholds.cpu, 50);
	eq("sibling nested values survive", nested.settings.thresholds.mem, 90);
	ok("the original object was not mutated", current.thresholds.cpu === 90, String(current.thresholds.cpu));
	const many = settings.applySettingsPatch(current, { refreshIntervalSec: 300, thresholds: { cpu: 10, mem: 20 } }, keys.METRIC_KEYS);
	ok("every changed path is listed", many.changed.length >= 3, JSON.stringify(many.changed));
}

console.log("\n== the store persists settings atomically with the roster ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	eq("a fresh store has the default interval", store.settings().refreshIntervalSec, 60);
	eq("a fresh store logs raw data", store.settings().rawLog.enabled, true);
	const { changed } = store.updateSettings({ refreshIntervalSec: 300 });
	eq("the update reports the change", changed.includes("refreshIntervalSec"), true);
	// One document, one write: settings and the roster cannot drift apart.
	const onDisk = JSON.parse(readFileSync(storePath(), "utf8"));
	eq("the settings landed on disk", onDisk.settings.refreshIntervalSec, 300);
	eq("the document is version 2", onDisk.version, 2);
	eq("a re-read store sees the persisted value", new DeviceStore(storePath()).settings().refreshIntervalSec, 300);
	// The roster shares the same document.
	store.create({ name: "persisted", host: "10.0.0.9", username: "root", auth: { kind: "password", password: "x" } });
	const both = JSON.parse(readFileSync(storePath(), "utf8"));
	eq("the roster still holds the device", both.devices.length, 1);
	eq("the settings survived a roster write", both.settings.refreshIntervalSec, 300);
}

console.log("\n== a version 1 file upgrades without inventing metric choices ==");
{
	// A v1 file has no settings block and no per-device `metrics`. Filling in
	// `device.metrics` during the upgrade would silently HIDE the four metrics
	// the user never chose, so the upgrade must leave it absent.
	writeFileSync(storePath(), JSON.stringify({
		version: 1,
		devices: [{ id: "legacy01", name: "legacy", host: "10.0.0.1", username: "root", auth: { kind: "password", password: "x" } }],
	}), "utf8");
	const store = new DeviceStore(storePath());
	eq("the legacy device survived", store.list().length, 1);
	eq("settings defaults were filled in", store.settings().refreshIntervalSec, 60);
	const row = store.list()[0];
	eq("the legacy device has NO metric choice recorded", row.metrics, undefined);
	// Which means the display layer renders everything for it.
	eq("an absent choice renders every metric", new Monitor(store, new metrics.MetricsStore()).overview().devices[0].metrics, undefined);
	eq("and the resolved set is the defaults, not empty", keys.normalizeMetrics(row.metrics).length, 7);
	// A NEW device also starts with no choice, for the same reason.
	const fresh = store.create({ name: "fresh", host: "10.0.0.2", username: "root", auth: { kind: "password", password: "x" } });
	eq("a newly added device records no choice", store.find(fresh.id).metrics, undefined);
}

console.log("\n== a device can record an explicit empty choice ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	const d = store.create({ name: "ticked", host: "10.0.0.3", username: "root", auth: { kind: "password", password: "x" }, metrics: [] });
	const row = store.find(d.id);
	// An explicit `[]` is a recorded choice, and it legalises to `["uptime"]`
	// because uptime is *always* collected. What matters is that the row is an
	// ARRAY (a choice was made) rather than absent (no choice was made).
	ok("the empty choice was recorded as an array", Array.isArray(row.metrics), JSON.stringify(row.metrics));
	eq("it legalises to uptime alone", row.metrics.join(","), "uptime");
	eq("the summary reports the recorded choice", store.summaries().find((r) => r.id === d.id).metrics.join(","), "uptime");
	// `metricsOf` is the resolver the collectors use.
	const { metricsOf } = await import(`${PLUGIN}/src/store.js`);
	eq("metricsOf resolves the choice to uptime alone", metricsOf(row).join(","), "uptime");
	eq("metricsOf returns undefined with no choice", metricsOf({ id: "x" }), undefined);
	eq("a partial choice is normalized", metricsOf({ id: "x", metrics: ["tcp", "cpu"] }).join(","), "uptime,cpu,tcp");
	// An update that omits the field must NOT clear the ticks.
	store.update(d.id, { name: "renamed" });
	eq("an update omitting metrics keeps the choice", store.find(d.id).metrics.join(","), "uptime");
	eq("the rename applied", store.find(d.id).name, "renamed");
	// And a recorded choice must survive a reload, not just a read.
	eq("the choice survives a store reload", new DeviceStore(storePath()).find(d.id).metrics.join(","), "uptime");
}

console.log("\n== the history ring is sized from the interval ==");
{
	// 3 hours of history, floored at 240 points and capped at 4320.
	eq("a 5s interval is 2160 points", metrics.ringSizeFor(5_000), 2160);
	eq("a 60s interval is below the floor, so 240", metrics.ringSizeFor(60_000), 240);
	eq("a 1h interval hits the floor", metrics.ringSizeFor(3_600_000), 240);
	eq("a 15s interval is 720 points", metrics.ringSizeFor(15_000), 720);
	eq("a 2.5s interval hits the cap", metrics.ringSizeFor(2_500), 4320);
	ok("a tiny interval never exceeds the cap", metrics.ringSizeFor(1) <= 4320, String(metrics.ringSizeFor(1)));
	ok("a huge interval never drops below the floor", metrics.ringSizeFor(10_000_000) >= 240, String(metrics.ringSizeFor(10_000_000)));
	// Three hours is the target: a longer interval trades resolution for reach.
	ok("the span is at least three hours when uncapped", metrics.ringSizeFor(5_000) * 5_000 >= 3 * 3600 * 1000, String(metrics.ringSizeFor(5_000) * 5_000));
	// Too little data presents as "collection is broken", which sends the user
	// after a fault that does not exist, so an unknown interval keeps the max.
	eq("an unknown interval keeps the maximum", metrics.ringSizeFor(Number.NaN), 4320);
	eq("a zero interval keeps the maximum", metrics.ringSizeFor(0), 4320);
	eq("a negative interval keeps the maximum", metrics.ringSizeFor(-1), 4320);
}

console.log("\n== the series row projects onto the chart columns ==");
{
	// numOrNull must not use Number(): Number(null) === 0, which would draw a
	// device with no temperature sensor as a plausible "温度 0°C".
	eq("a real zero survives", metrics.numOrNull(0), 0);
	eq("null becomes null, not 0", metrics.numOrNull(null), null);
	eq("undefined becomes null", metrics.numOrNull(undefined), null);
	eq("an empty string becomes null", metrics.numOrNull(""), null);
	eq("a non-numeric string becomes null", metrics.numOrNull("n/a"), null);
	eq("NaN becomes null", metrics.numOrNull(Number.NaN), null);
	eq("a numeric string is accepted", metrics.numOrNull("42"), 42);
	eq("false is not coerced to 0", metrics.numOrNull(false), null);

	const sample = {
		ts: 1,
		cpu: { percent: 42 },
		memory: { usagePercent: 55 },
		disk: [{ mount: "/", usagePercent: 60 }, { mount: "/data", usagePercent: 81 }],
		thermal: [{ type: "a", celsius: 40 }, { type: "b", celsius: 72 }],
		load: { load1: 0.5 },
		net: { rxTotal: 100, txTotal: 200 },
		diskio: { rxTotal: 300, txTotal: 400 },
		processes: 120,
		tcp: 17,
	};
	const row = metrics.toSeriesRow(sample);
	eq("cpu is projected", row.cpu, 42);
	eq("mem is projected", row.mem, 55);
	// The WORST row is used for disk and temperature, matching the alert engine:
	// charting the root filesystem while alerting on /data would be incoherent.
	eq("disk takes the worst mount", row.disk, 81);
	eq("temp takes the hottest zone", row.temp, 72);
	eq("load1 is projected", row.load1, 0.5);
	eq("net rx is projected", row.netRx, 100);
	eq("net tx is projected", row.netTx, 200);
	eq("diskio read is projected", row.diskRead, 300);
	eq("diskio write is projected", row.diskWrite, 400);
	eq("procs is projected", row.procs, 120);
	eq("tcp is projected", row.tcp, 17);
	eq("the timestamp rides along", row.ts, 1);
	// A metric that was not collected must be null, never 0.
	const sparse = metrics.toSeriesRow({ ts: 2 });
	eq("an uncollected cpu is null", sparse.cpu, null);
	eq("an uncollected temperature is null", sparse.temp, null);
	eq("an empty disk list is null, not 0", sparse.disk, null);
	eq("an empty thermal list is null", sparse.temp, null);
	ok("every column exists even when empty", series.DEFAULT_METRIC_COLUMNS.every((c) => c in sparse), JSON.stringify(Object.keys(sparse)));
}

console.log("\n== the four card waveforms are declared ==");
{
	eq("there are four waveforms", series.WAVE_COLUMNS.length, 4);
	eq("they are cpu, mem, disk and temp", series.WAVE_COLUMNS.map((w) => w.key).join(","), "cpu,mem,disk,temp");
	ok("the percentage waveforms have a ceiling", series.WAVE_COLUMNS.filter((w) => w.key !== "temp").every((w) => w.ceiling === 100), JSON.stringify(series.WAVE_COLUMNS));
	// Temperature has no fixed ceiling: a device at 45°C and one at 95°C must
	// both produce a readable trace.
	eq("temperature has no fixed ceiling", series.WAVE_COLUMNS.find((w) => w.key === "temp").ceiling, null);
	ok("every waveform names the metric it charts", series.WAVE_COLUMNS.every((w) => series.DEFAULT_METRIC_COLUMNS.includes(w.metric)), JSON.stringify(series.WAVE_COLUMNS));
	eq("the disk waveform reads the disk column", series.WAVE_COLUMNS.find((w) => w.key === "disk").metric, "disk");
}

console.log("\n== the watch lease keeps the timer alive only while watched ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	store.create({ name: "w1", host: "10.0.0.10", username: "root", auth: { kind: "password", password: "x" } });
	const mon = new Monitor(store, new metrics.MetricsStore());

	eq("nothing is watched at boot", mon.watchStatus().active, false);
	eq("no timer runs at boot", mon.watchStatus().timerRunning, false);
	// A lease is a promise to renew; it exists because neither extreme works:
	// on-demand alone gives a one-point chart, and always-on dials ten devices
	// around the clock for a panel nobody has opened in a week.
	const lease = mon.watch("tab-1", 60);
	eq("watching activates", mon.watchStatus().active, true);
	eq("the interval is honoured", mon.watchStatus().intervalMs, 60_000);
	eq("the lease counts one client", lease.clients, 1);
	ok("a timer now runs", mon.watchStatus().timerRunning === true);
	// The multiplier is 2, not 1, so a single late heartbeat does not tear the
	// timer down and rebuild it. One full interval must still be in hand.
	ok("the lease outlives one interval", mon.watchStatus().expiresInMs > 60_000, String(mon.watchStatus().expiresInMs));
	ok("but not two", mon.watchStatus().expiresInMs <= 120_000, String(mon.watchStatus().expiresInMs));

	// A short interval from a second panel must take effect NOW, not after the
	// current period of the longer one.
	mon.watch("tab-2", 10);
	eq("the shortest live lease wins", mon.watchStatus().intervalMs, 10_000);
	eq("both clients are counted", mon.watchStatus().clients, 2);

	eq("releasing one client keeps the timer", mon.unwatch("tab-2").active, true);
	eq("the remaining client still holds the lease", mon.watchStatus().active, true);
	eq("the interval reverts to the remaining lease", mon.watchStatus().intervalMs, 60_000);
	eq("releasing the last client stops it", mon.unwatch("tab-1").active, false);
	eq("nothing is watched now", mon.watchStatus().active, false);
	eq("and the timer stopped", mon.watchStatus().timerRunning, false);
	eq("releasing an unknown client is harmless", mon.unwatch("never-existed").active, false);
	// Renewal must extend the lease, or a long-running panel would drop it.
	mon.watch("tab-renew", 60);
	const first = mon.watchStatus().expiresInMs;
	await new Promise((r) => setTimeout(r, 20));
	mon.watch("tab-renew", 60);
	const second = mon.watchStatus().expiresInMs;
	// Both readings are wall-clock DELTAS (`expiresAt - Date.now()`), so they
	// differ by sub-millisecond measurement noise depending on how the two
	// `Date.now()` calls land. Comparing them with `>=` made this assertion a
	// coin flip — it failed once in ~20 runs, which is worse than useless
	// because a flaky green weakens every other green in the suite.
	//
	// What a BROKEN renewal looks like is the 20ms sleep showing up as a
	// SHRUNKEN lease, so a few ms of tolerance separates the two cases cleanly
	// without weakening what is being asserted.
	ok("renewing extends the lease", second >= first - 5, `${first} -> ${second}`);
	// The property that actually matters, asserted directly: a renewed lease is
	// back to (nearly) the full window, so a panel that keeps renewing never
	// expires. This does not compare two noisy measurements at all.
	ok("a renewed lease is back to the full window", second > 120_000 - 50, String(second));
	mon.unwatch("tab-renew");
	// An out-of-range interval is clamped, never rejected: a rejected lease
	// would leave the panel silently frozen with no way to recover.
	mon.watch("tab-3", 99999);
	eq("an oversized interval is clamped", mon.watchStatus().intervalMs, 3_600_000);
	mon.watch("tab-4", 1);
	eq("an undersized interval is clamped", mon.watchStatus().intervalMs, 5_000);
	mon.unwatch("tab-4");
	mon.stopTimer();
	eq("stopping the timer clears it", mon.watchStatus().timerRunning, false);
	eq("but the lease survives a stop", mon.watchStatus().active, true);
	mon.unwatch("tab-3");
	// An expired lease is pruned on read, not left to hold the timer open.
	mon.watch("tab-5", 5);
	eq("a fresh lease is live", mon.watchStatus().active, true);
	eq("an expired lease is pruned", mon.watchStatus(Date.now() + 5 * 2 * 1000 + 1).active, false);
}

console.log("\n== a device interval override beats the global ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	const d = store.create({ name: "ov", host: "10.0.0.11", username: "root", auth: { kind: "password", password: "x" }, intervalSec: 15 });
	const mon = new Monitor(store, new metrics.MetricsStore());
	eq("the device override is used", mon.deviceIntervalMs(store.find(d.id)), 15_000);
	const plain = store.create({ name: "plain", host: "10.0.0.12", username: "root", auth: { kind: "password", password: "x" } });
	eq("a device with no override uses the global", mon.deviceIntervalMs(store.find(plain.id)), 60_000);
	store.updateSettings({ refreshIntervalSec: 120 });
	eq("the override still wins", mon.deviceIntervalMs(store.find(d.id)), 15_000);
	eq("the global change reaches the plain device", mon.deviceIntervalMs(store.find(plain.id)), 120_000);
}

console.log("\n== the settings routes are fenced and clamped ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	const mon = new Monitor(store, new metrics.MetricsStore());
	const routes = makeRoutes(store, new metrics.MetricsStore(), mon);
	const call = async (path, { method = "GET", body, remoteAddress = "127.0.0.1", host = "127.0.0.1:19387" } = {}) => {
		const route = routes.find((r) => r.path === path.split("?")[0]);
		if (route === undefined) throw new Error(`no route for ${path}`);
		const req = new EventEmitter();
		req.method = method;
		req.url = path;
		req.socket = { remoteAddress };
		req.headers = { host };
		req.destroy = () => {};
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
		req[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
		setImmediate(() => { for (const c of chunks) req.emit("data", c); req.emit("end"); });
		const res = {
			status: undefined, headers: undefined, payload: "",
			writeHead(s, h) { this.status = s; this.headers = h; },
			end(p) { this.payload = p ?? ""; },
		};
		await route.handler(req, res);
		let parsed;
		try { parsed = JSON.parse(res.payload); } catch { parsed = res.payload; }
		return { status: res.status, body: parsed };
	};

	const got = await call(API.settings);
	eq("settings GET is 200", got.status, 200);
	eq("it returns the settings", got.body.settings.refreshIntervalSec, 60);
	eq("it returns the catalog too, so the picker is never hardcoded", got.body.catalog.length, 11);
	ok("the catalog rows carry labels", got.body.catalog.every((m) => typeof m.label === "string"), JSON.stringify(got.body.catalog[0]));

	const patched = await call(API.settings, { method: "PATCH", body: { refreshIntervalSec: 90 } });
	eq("settings PATCH is 200", patched.status, 200);
	eq("the patch applied", patched.body.settings.refreshIntervalSec, 90);
	ok("the response lists the changed names", patched.body.changed.includes("refreshIntervalSec"), JSON.stringify(patched.body.changed));

	const bad = await call(API.settings, { method: "PATCH", body: { refreshIntervalSec: "not-a-number" } });
	check("an unparseable interval is handled without a crash", bad.status === 200 || bad.status === 400, String(bad.status));

	// The loopback fence and method check are mandatory on every new route.
	for (const { path, method } of [
		{ path: API.settings, method: "GET" }, { path: API.catalog, method: "GET" }, { path: API.watch, method: "POST" },
		{ path: API.rawlog + "?id=x", method: "GET" }, { path: API.incidents, method: "GET" },
		{ path: API.audit, method: "GET" }, { path: API.logs, method: "GET" }, { path: API.terminal, method: "GET" },
	]) {
		const remote = await call(path, { method, remoteAddress: "10.0.0.5" });
		eq(`${path.split("/").pop()} refuses a non-loopback caller`, remote.status, 403);
		const wrong = await call(path, { method: method === "GET" ? "POST" : "GET" });
		eq(`${path.split("/").pop()} refuses the wrong method`, wrong.status, 405);
	}

	// /rawlog reads whole files before slicing, so an unclamped limit would
	// pull the entire rotation into memory.
	const huge = await call(`${API.rawlog}?id=no-such-device&limit=999999999`);
	check("an oversized rawlog limit does not error", huge.status === 200 || huge.status === 404, String(huge.status));
	if (huge.status === 200) ok("the rawlog limit was clamped", (huge.body.lines ?? []).length <= 2000, String((huge.body.lines ?? []).length));
	const neg = await call(`${API.rawlog}?id=no-such-device&limit=-5`);
	check("a negative rawlog limit does not error", neg.status === 200 || neg.status === 404, String(neg.status));
	const hugeAudit = await call(`${API.audit}?limit=999999999`);
	check("an oversized audit limit is handled", hugeAudit.status === 200, String(hugeAudit.status));
	if (hugeAudit.status === 200) ok("the audit limit was clamped", (hugeAudit.body.records ?? []).length <= 1000, String((hugeAudit.body.records ?? []).length));

	const watch = await call(API.watch, { method: "POST", body: { clientId: "c1", intervalSec: 30 } });
	eq("watch is 200", watch.status, 200);
	eq("watch activates the lease", mon.watchStatus().active, true);
	eq("the requested interval was used", mon.watchStatus().intervalMs, 30_000);
	const release = await call(API.watch, { method: "POST", body: { clientId: "c1", release: true } });
	eq("releasing through the route works", release.status, 200);
	eq("the lease is gone", mon.watchStatus().active, false);
	// A missing clientId is NOT an error: the panel is the only caller and a
	// random id per request would leak a lease on every reload. It falls back
	// to a single shared slot instead.
	const noClient = await call(API.watch, { method: "POST", body: {} });
	eq("a missing clientId still activates", noClient.status, 200);
	eq("and it lands on the default slot", mon.watchStatus().clients, 1);
	await call(API.watch, { method: "POST", body: { release: true } });
	eq("the default slot can be released too", mon.watchStatus().active, false);

	const logs = await call(API.logs);
	eq("the log status route is 200", logs.status, 200);
	ok("it reports the log directory", typeof logs.body.dir === "string" && logs.body.dir.length > 0, JSON.stringify(logs.body));
	ok("it reports the raw-log switch", logs.body.enabled === true, JSON.stringify(logs.body));
	// The directory must be the INDEPENDENT log root, not beside the roster.
	ok("the log dir is not the config directory", !logs.body.dir.includes("dsh-device-monitor.json"), logs.body.dir);

	// This store was built without a terminal manager, so the route must say so
	// rather than 404. The panel words "this build has none" and "switched off"
	// differently, and it can only do that if the two are distinguishable.
	const term = await call(API.terminal);
	eq("the terminal status route is 200 without a manager", term.status, 200);
	eq("it reports itself unavailable", term.body.available, false);
	eq("and not enabled", term.body.enabled, false);
	ok("it still names the upgrade path", String(term.body.path).endsWith("/terminal"), JSON.stringify(term.body));
}

console.log("\n== the terminal manager refuses, counts, and closes by socket ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	store.create({ name: "term-a", host: "10.0.0.1", username: "u", auth: { kind: "password", password: "p" } });
	store.create({ name: "term-b", host: "10.0.0.2", username: "u", auth: { kind: "password", password: "p" } });
	const [devA, devB] = store.list();
	const terminal = await import(`${PLUGIN}/src/terminal.js`);

	// A fake PTY: an EventEmitter with the two methods the pump uses.
	const fakeShell = () => {
		const stream = new EventEmitter();
		stream.setWindow = () => {};
		stream.write = () => true;
		stream.close = () => {};
		return { stream, client: {}, close: () => {} };
	};
	let opened = 0;
	const off = { enabled: false, allowedHosts: [], idleMs: 60_000 };
	const on = { enabled: true, allowedHosts: [], idleMs: 60_000 };
	const make = (cfg) => new terminal.TerminalManager(store, { getSettings: () => cfg, openShell: async () => { opened += 1; return fakeShell(); } });

	const disabled = make(off);
	const denied = await disabled.open({ deviceId: devA.id, remoteAddress: "127.0.0.1" });
	eq("a disabled terminal refuses", denied.ok, false);
	eq("with a machine-readable reason", denied.reason, "terminal.disabled");
	eq("and it never dialed the device", opened, 0);

	const manager = make(on);
	eq("an unknown device is refused", (await manager.open({ deviceId: "nope", remoteAddress: "127.0.0.1" })).reason, "terminal.noDevice");

	// The three refusal reasons must be distinguishable — the user's next action
	// differs completely between "turn it on" and "your address is not allowed".
	const restricted = make({ enabled: true, allowedHosts: ["10.1.2.3"], idleMs: 60_000 });
	eq("an unlisted source is refused", (await restricted.open({ deviceId: devA.id, remoteAddress: "10.9.9.9" })).reason, "terminal.hostDenied");
	eq("a listed source is allowed", (await restricted.open({ deviceId: devA.id, remoteAddress: "10.1.2.3", socketId: "s1" })).ok, true);
	// An IPv4-mapped loopback address is the normal shape on a dual-stack host.
	eq("a mapped loopback source matches 127.0.0.1", await terminal.hostAllowed("::ffff:127.0.0.1", ["127.0.0.1"]), true);
	eq("a zone-tagged address is normalized", terminal.normalizeIp("fe80::1%eth0"), "fe80::1");
	eq("a CIDR rule matches inside", terminal.cidrMatch("192.168.1.44", "192.168.1.0/24"), true);
	eq("a CIDR rule rejects outside", terminal.cidrMatch("192.168.2.44", "192.168.1.0/24"), false);
	eq("a malformed CIDR rejects", terminal.cidrMatch("192.168.1.44", "192.168.1.0/99"), false);
	// A hostname rule must resolve at CHECK time; frozen at save time it would
	// silently stop matching after a DHCP lease changed.
	eq("a hostname rule resolves at check time", await terminal.hostAllowed("10.1.2.3", ["devbox.lan"], async () => [{ address: "10.1.2.3" }]), true);
	eq("a hostname that resolves elsewhere does not match", await terminal.hostAllowed("10.9.9.9", ["devbox.lan"], async () => [{ address: "10.1.2.3" }]), false);
	eq("a hostname that does not resolve is not an error", await terminal.hostAllowed("10.1.2.3", ["nope.lan"], async () => { throw new Error("ENOTFOUND"); }), false);
	// No source address is not "unknown, allow it".
	eq("a missing source address is refused", await terminal.hostAllowed(undefined, ["10.1.2.3"]), false);
	eq("an empty allowlist allows the already-fenced loopback caller", await terminal.hostAllowed("127.0.0.1", []), true);

	restricted.closeAll("test");
	eq("closeAll emptied the registry", restricted.count, 0);
	eq("closeAll closed the session it had", restricted.close("no-such"), false);

	// Per-device cap: 3, the reference's number.
	const capped = make(on);
	for (let i = 0; i < terminal.MAX_SESSIONS_PER_DEVICE; i += 1) {
		eq(`session ${i + 1} on the first device opens`, (await capped.open({ deviceId: devA.id, remoteAddress: "127.0.0.1", socketId: "s1" })).ok, true);
	}
	const over = await capped.open({ deviceId: devA.id, remoteAddress: "127.0.0.1", socketId: "s1" });
	eq("a fourth session on the same device is refused", over.ok, false);
	eq("with the per-device reason", over.reason, "terminal.tooManyForDevice");
	eq("a different device is still allowed", (await capped.open({ deviceId: devB.id, remoteAddress: "127.0.0.1", socketId: "s2" })).ok, true);
	eq("the cap is three per device", terminal.MAX_SESSIONS_PER_DEVICE, 3);
	eq("the global cap is ten", terminal.MAX_SESSIONS_TOTAL, 10);
	eq("the idle floor is thirty seconds", terminal.MIN_IDLE_MS, 30_000);
	eq("the manager counted four sessions", capped.count, 4);

	// closeBySocket: ownership must be exact. An empty id means "we do not know
	// who this is", and without the guard it would read as "it is all of them".
	eq("an empty socket id closes nothing", capped.closeBySocket(""), 0);
	eq("and the sessions survive it", capped.count, 4);
	eq("a wrong socket id closes nothing", capped.closeBySocket("s-other"), 0);
	eq("the right socket id closes its own sessions", capped.closeBySocket("s1"), 3);
	eq("the other socket's session survives", capped.count, 1);
	eq("the surviving session belongs to the other device", capped.list()[0].deviceId, devB.id);

	// list() must not leak live handles — they cannot be serialized anyway.
	const row = capped.list()[0];
	eq("the list has no stream handle", row.stream, undefined);
	eq("the list has no close handle", row.close, undefined);
	ok("the list still names the device", row.deviceName === "term-b", JSON.stringify(row));
	ok("the list survives JSON", JSON.stringify(capped.list()).length > 10, "serialization failed");

	// The idle timer is what closes a terminal whose owner vanished without a
	// close event — a killed process, a sleeping machine, a dropped network.
	//
	// The floor is applied where the timer is ARMED, not in `config()`. Two
	// clamps in series cannot be told apart by any test (mutating either one
	// leaves the other in place), so the second was deleted. Assert the delay
	// that actually reaches `setTimeout` rather than the value `config()`
	// happens to return, or this check would pass for a manager that arms a
	// zero-millisecond timer.
	const idle = make({ enabled: true, allowedHosts: [], idleMs: 0 });
	const realSetTimeout = globalThis.setTimeout;
	const armedDelays = [];
	globalThis.setTimeout = (fn, ms, ...rest) => {
		armedDelays.push(ms);
		return realSetTimeout(fn, ms, ...rest);
	};
	let s;
	try {
		s = await idle.open({ deviceId: devA.id, remoteAddress: "127.0.0.1", socketId: "s9" });
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	eq("a zero idle still opens", s.ok, true);
	// Armed, not disabled: a hand-edited 0 must not mean "never time out".
	ok("an idle timer was armed anyway", s.session.idleTimer !== null && s.session.idleTimer !== undefined, String(s.session.idleTimer));
	ok("the armed delay is a real timeout, never the configured 0",
		armedDelays.length === 1 && armedDelays[0] >= terminal.MIN_IDLE_MS,
		`armed with ${JSON.stringify(armedDelays)}`);
	eq("closing the session is reported", idle.close(s.session.id, "test"), true);
	eq("closing it twice is not", idle.close(s.session.id, "test"), false);
	eq("the timer was cleared with it", s.session.idleTimer, null);
	idle.closeAll("test");
	capped.closeAll("test");
}

console.log("\n== the terminal audits the session, never the keystrokes ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	store.create({ name: "audit-term", host: "10.0.0.100", username: "u", auth: { kind: "password", password: "t3rm-s3cret" } });
	const dev = store.list()[0];
	const terminal = await import(`${PLUGIN}/src/terminal.js`);
	const logs = await import(`${PLUGIN}/src/logs.js`);
	const before = logs.readAudit(1000).length;

	const stream = new EventEmitter();
	stream.setWindow = () => {};
	stream.write = () => true;
	const manager = new terminal.TerminalManager(store, {
		getSettings: () => ({ enabled: true, allowedHosts: [], idleMs: 60_000 }),
		openShell: async () => ({ stream, client: {}, close: () => {} }),
	});
	const opened = await manager.open({ deviceId: dev.id, remoteAddress: "127.0.0.1", by: "panel", socketId: "s1" });
	eq("the session opened", opened.ok, true);
	// The manager counts bytes so a runaway session is visible; it does not
	// record WHAT was typed. This plugin's standing rule (see `src/monitor.js`)
	// is that the audit log carries field names, never payloads.
	opened.session.bytesIn = 42;
	manager.close(opened.session.id, "用户关闭");

	const records = logs.readAudit(1000);
	ok("the open was audited", records.some((r) => r.event === "terminal.open"), JSON.stringify(records.map((r) => r.event)));
	const closeRecord = records.find((r) => r.event === "terminal.close");
	ok("the close was audited", closeRecord !== undefined, JSON.stringify(records.map((r) => r.event)));
	eq("the close carries the byte count", closeRecord.bytesIn, 42);
	ok("the close carries a duration", typeof closeRecord.durationMs === "number", String(closeRecord.durationMs));
	ok("the open names the device", records.find((r) => r.event === "terminal.open").device === "audit-term", JSON.stringify(records.find((r) => r.event === "terminal.open")));
	// The password must not reach the trail, exactly as for device CRUD.
	const serialized = JSON.stringify(records.slice(before - 1));
	ok("no credential value reached the terminal trail", !serialized.includes("t3rm-s3cret"), serialized.slice(0, 400));
	ok("no keystroke text appears in the trail", !serialized.includes("keystroke-canary"), serialized.slice(0, 200));
	manager.closeAll("test");
}

console.log("\n== a blank password box on an edit probes with the stored credential ==");
{
	// The bug: SAVING an edit merges the stored auth, so leaving the password
	// box blank keeps the old password. TESTING took the payload as-is, so the
	// same blank box dialled with an empty password and the device answered
	// "All configured authentication methods failed" — a message about
	// credentials, caused by a form that looked complete.
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	store.create({ name: "alpha", host: "10.0.0.1", port: 22, username: "root", auth: { kind: "password", password: "s3cret-alpha" } });
	store.create({ name: "beta", host: "10.0.0.2", port: 22, username: "root", auth: { kind: "password", password: "s3cret-beta" } });
	const { withStoredSecret } = monitorModule;

	// The edit form's own payload: formFromDevice() blanks the password, and
	// formPayload() then OMITS the key entirely (client.js:1177).
	const blank = { name: "alpha", host: "10.0.0.1", port: 22, username: "root", auth: { kind: "password" } };
	const filled = withStoredSecret(blank, store);
	eq("an omitted password is filled from the stored device", filled.auth.password, "s3cret-alpha");

	// The identity match must not borrow another device's secret.
	const otherHost = withStoredSecret({ ...blank, host: "10.0.0.2" }, store);
	eq("a different host gets that host's secret", otherHost.auth.password, "s3cret-beta");
	const unknown = withStoredSecret({ ...blank, host: "10.0.0.9" }, store);
	eq("an unknown host stays unfilled", unknown.auth.password, undefined);
	const otherPort = withStoredSecret({ ...blank, port: 2222 }, store);
	eq("a different port stays unfilled", otherPort.auth.password, undefined);
	const otherUser = withStoredSecret({ ...blank, username: "admin" }, store);
	eq("a different username stays unfilled", otherUser.auth.password, undefined);

	// An EXPLICIT empty string is a decision ("this device has no password"),
	// not an omission, so it must survive untouched.
	const explicitEmpty = withStoredSecret({ ...blank, auth: { kind: "password", password: "" } }, store);
	eq("an explicit empty password is not overwritten", explicitEmpty.auth.password, "");
	const typed = withStoredSecret({ ...blank, auth: { kind: "password", password: "typed-now" } }, store);
	eq("a typed password wins over the stored one", typed.auth.password, "typed-now");

	// A key-auth draft must not grow a password.
	const keyDraft = withStoredSecret({ ...blank, auth: { kind: "key", privateKeyPath: "/k" } }, store);
	eq("a key draft is left alone", keyDraft.auth.password, undefined);
	// Shape tolerance: a bare string auth, or no auth at all, must not throw.
	eq("a string auth is passed through", withStoredSecret({ ...blank, auth: "password" }, store).auth, "password");
	eq("a missing auth is passed through", withStoredSecret({ name: "x" }, store).auth, undefined);
	eq("a missing store is tolerated", withStoredSecret(blank, undefined).auth.password, undefined);

	// The edit form sends the device id, and by id the answer must not depend on
	// the user having left host/port/username untouched.
	const byId = withStoredSecret({ id: "beta", auth: { kind: "password" } }, store);
	eq("an id resolves the secret even with no host in the payload", byId.auth.password, "s3cret-beta");
	// An id that is no longer in the roster falls back to the identity match.
	const staleId = withStoredSecret({ id: "gone", name: "alpha", host: "10.0.0.1", port: 22, username: "root", auth: { kind: "password" } }, store);
	eq("a stale id falls back to the identity match", staleId.auth.password, "s3cret-alpha");
	// A key-auth device must never be resolved through the password branch.
	const keyDevice = withStoredSecret({ id: "alpha", auth: { kind: "key", privateKeyPath: "/k" } }, store);
	eq("a key draft is left alone even with a matching id", keyDevice.auth.password, undefined);

	// The payload itself must not be mutated: the caller still owns it.
	const frozen = JSON.stringify(blank);
	withStoredSecret(blank, store);
	eq("the input payload is not mutated", JSON.stringify(blank), frozen);

	// Asserting the HELPER alone cannot catch the real defect: the helper can be
	// perfect while `testDraft` forgets to call it, which is precisely the bug
	// the user hit. So drive the PUBLIC entry point with an injected dial and
	// inspect the device row that actually reaches ssh2.
	const seen = [];
	const injected = async (device) => {
		seen.push(device);
		// `testDraft` runs one banner command once the dial succeeds, so the
		// double must answer it with the shape `ssh.js#exec` reads: a `data`
		// event, a `stderr`, and a `close` carrying the exit code. The
		// assertions below are about the ROW, not about the command.
		return {
			end() {},
			exec(_command, callback) {
				setImmediate(() => {
					const stream = new EventEmitter();
					stream.stderr = new EventEmitter();
					callback(undefined, stream);
					setImmediate(() => {
						stream.emit("data", Buffer.from("Linux probe\n", "utf8"));
						stream.emit("close", 0);
					});
				});
			},
		};
	};
	const probing = new Monitor(store, new metrics.MetricsStore(), { connect: injected });
	await probing.testDraft({ ...blank });
	eq("the probe dialled once", seen.length, 1);
	eq("the probe dialled WITH the stored password", seen[0]?.auth?.password, "s3cret-alpha");

	// And the negative: a typed password must reach the dial unchanged, so the
	// fill-in is an omission repair and never an override.
	seen.length = 0;
	await probing.testDraft({ ...blank, auth: { kind: "password", password: "typed-direct" } });
	eq("a typed password reaches the dial unchanged", seen[0]?.auth?.password, "typed-direct");

	// A device that matches nothing must dial with NO password rather than
	// borrowing one — the fill-in is not a fallback to "some credential".
	seen.length = 0;
	await probing.testDraft({ ...blank, host: "10.0.0.9", username: "nobody" });
	eq("an unmatched probe dials with no password", seen[0]?.auth?.password, undefined);
}

console.log("\n== testDraft has no side effects ==");
{
	rmSync(storePath(), { force: true });
	const store = new DeviceStore(storePath());
	const mon = new Monitor(store, new metrics.MetricsStore());
	const routes = makeRoutes(store, new metrics.MetricsStore(), mon);
	const route = routes.find((r) => r.path === API.testDraft);
	const req = new EventEmitter();
	req.method = "POST";
	req.url = API.testDraft;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "127.0.0.1:19387" };
	req.destroy = () => {};
	const payload = JSON.stringify({ name: "draft", host: "127.0.0.1", port: 1, username: "root", auth: { kind: "password", password: "x" } });
	req[Symbol.asyncIterator] = async function* () { yield Buffer.from(payload, "utf8"); };
	setImmediate(() => { req.emit("data", Buffer.from(payload, "utf8")); req.emit("end"); });
	const res = { status: undefined, payload: "", writeHead(s) { this.status = s; }, end(p) { this.payload = p ?? ""; } };
	await route.handler(req, res);
	// A refused connection is the expected outcome here; what matters is that
	// the draft was NOT persisted and NOT audited.
	eq("a draft against a dead port fails", res.status, 400);
	eq("no device was persisted", store.list().length, 0);
	const audit = await (async () => {
		const logs = await import(`${PLUGIN}/src/logs.js`);
		return logs.readAudit(50);
	})();
	ok("the draft test was NOT audited", !audit.some((r) => String(r.event).includes("draft")), JSON.stringify(audit));
}

console.log("\n== device CRUD is audited, without credential values ==");
{
	rmSync(storePath(), { force: true });
	rmSync(join(scratch, "dsh-device-monitor-logs"), { recursive: true, force: true });
	const store = new DeviceStore(storePath());
	const mon = new Monitor(store, new metrics.MetricsStore());
	const routes = makeRoutes(store, new metrics.MetricsStore(), mon);
	const call = async (path, { method = "GET", body } = {}) => {
		const route = routes.find((r) => r.path === path.split("?")[0]);
		const req = new EventEmitter();
		req.method = method;
		req.url = path;
		req.socket = { remoteAddress: "127.0.0.1" };
		req.headers = { host: "127.0.0.1:19387" };
		req.destroy = () => {};
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
		req[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
		setImmediate(() => { for (const c of chunks) req.emit("data", c); req.emit("end"); });
		const res = { status: undefined, payload: "", writeHead(s) { this.status = s; }, end(p) { this.payload = p ?? ""; } };
		await route.handler(req, res);
		let parsed; try { parsed = JSON.parse(res.payload); } catch { parsed = res.payload; }
		return { status: res.status, body: parsed };
	};

	const created = await call(API.devices, { method: "POST", body: { name: "audited", host: "10.0.0.20", username: "root", auth: { kind: "password", password: "sup3r-s3cret" } } });
	eq("the device was created", created.status, 201);
	const logs = await import(`${PLUGIN}/src/logs.js`);
	const audit = logs.readAudit(100);
	ok("the create was audited", audit.some((r) => String(r.event).includes("create")), JSON.stringify(audit.map((r) => r.event)));
	const serialized = JSON.stringify(audit);
	// The audit log must never carry a credential value, in any field.
	ok("the audit trail never contains the password", !serialized.includes("sup3r-s3cret"), serialized.slice(0, 400));
	// A create records the identity but NOT the whole payload: there is no
	// reason to echo an auth block into a durable file.
	ok("the create records the device identity", serialized.includes("audited") && serialized.includes("10.0.0.20"), serialized.slice(0, 400));
	ok("the create does not record the auth block", !serialized.includes('"kind"'), serialized.slice(0, 400));

	// An UPDATE does record the field NAMES — with the credential filtered out.
	// The device routes address a row by `?id=`, not by a path segment.
	const id = created.body.device.id;
	const updated = await call(`${API.devices}?id=${id}`, { method: "PATCH", body: { name: "renamed", password: "another-s3cret" } });
	eq("the update succeeded", updated.status, 200);
	const audit2 = logs.readAudit(100);
	const row = audit2.find((r) => String(r.event).includes("update"));
	ok("the update was audited", row !== undefined, JSON.stringify(audit2.map((r) => r.event)));
	ok("the update audit lists the changed field names", Array.isArray(row.fields) && row.fields.includes("name"), JSON.stringify(row));
	// The credential's NAME is filtered out of the field list as well: the trail
	// is about which fields were touched, not about the auth scheme.
	ok("the update audit omits the credential field entirely", !row.fields.includes("password"), JSON.stringify(row.fields));
	ok("no credential value reached the trail", !JSON.stringify(audit2).includes("another-s3cret"), JSON.stringify(audit2).slice(0, 500));

	// A delete is audited by identity so "who removed nas-a" has an answer.
	const removed = await call(`${API.devices}?id=${id}`, { method: "DELETE" });
	eq("the delete succeeded", removed.status, 200);
	ok("the delete was audited", logs.readAudit(100).some((r) => String(r.event).includes("delete")), JSON.stringify(logs.readAudit(100).map((r) => r.event)));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? "the settings, lease, series and route surface behave" : `${failures} failed`}`);
if (failures > 0) process.exit(1);
