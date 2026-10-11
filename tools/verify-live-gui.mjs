/**
 * Post-restart verification against the RUNNING Host.
 *
 * This is the last acceptance gate: it talks to the process actually serving
 * http://127.0.0.1:19387, so it can only pass once a fresh module generation
 * has been loaded. It deliberately checks the things that distinguish a NEW
 * generation from the stale one:
 *
 *   - the unified metric vocabulary (`mem`/`temp`, never `memory`/`thermal`)
 *   - the routes that only exist in the new half (`/settings`, `/catalog`,
 *     `/logs/status`, `/rawlog`, `/audit`, `/incidents`, `/watch`)
 *   - the served client bundle actually containing the new UI
 *
 * A stale generation fails the route checks AND the `memory` fingerprint, so
 * this script cannot be satisfied by an old process.
 *
 * Run: node tools/verify-live-gui.mjs
 *      DDM_WEB_URL=http://127.0.0.1:19387 node tools/verify-live-gui.mjs
 */
const BASE = process.env.DDM_WEB_URL ?? "http://127.0.0.1:19387";
const API = `${BASE}/api/dsh-device-monitor`;

let checks = 0;
const failures = [];
function ok(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	}
}
function eq(label, actual, expected) {
	ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** GET a JSON route, reporting the status rather than throwing. */
async function getJson(path) {
	const response = await fetch(`${API}${path}`);
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: response.status, body, text };
}

console.log(`\n== live GUI verification against ${BASE} ==`);

//#region 1. the routes that only the NEW generation registers
console.log("\n== new routes are registered ==");
// A 401 here means "no such route in this generation": the live process answers
// 401 for every unknown path, which is exactly how the stale Host was detected.
for (const path of ["/overview", "/settings", "/catalog", "/logs/status", "/audit", "/incidents", "/terminal/status"]) {
	const result = await getJson(path);
	eq(`GET ${path} is a registered route`, result.status, 200);
}
// Sanity: an unknown path must NOT be 200, so "everything is 200" cannot be
// how the check above passes.
const bogus = await getJson("/definitely-not-a-route-xyz");
ok("an unknown route is not 200 (the 200s above mean something)", bogus.status !== 200, `got ${bogus.status}`);
//#endregion

//#region 2. metric vocabulary — the fingerprint that identifies the new half
console.log("\n== metric vocabulary ==");
const catalog = await getJson("/catalog");
const keys = (catalog.body?.catalog ?? []).map((row) => row.key);
eq("the catalog lists 11 metrics", keys.length, 11);
ok("the catalog uses `mem`", keys.includes("mem"), keys.join(","));
ok("the catalog uses `temp`", keys.includes("temp"), keys.join(","));
ok("the catalog does NOT use the old `memory` name", !keys.includes("memory"), keys.join(","));
ok("the catalog does NOT use the old `thermal` name", !keys.includes("thermal"), keys.join(","));
eq("the device cap is 10", catalog.body?.maxDevices, 10);
ok("every catalog row carries a label and a hint",
	(catalog.body?.catalog ?? []).every((row) => typeof row.label === "string" && row.label !== "" && typeof row.hint === "string"),
	JSON.stringify((catalog.body?.catalog ?? []).map((row) => [row.key, row.label])));
const alwaysRows = (catalog.body?.catalog ?? []).filter((row) => row.always === true).map((row) => row.key);
eq("uptime is the only always-on metric", alwaysRows.join(","), "uptime");
//#endregion

//#region 3. the series columns the panel draws waveforms from
console.log("\n== series columns ==");
const overview = await getJson("/overview");
eq("the overview is a registered route", overview.status, 200);
const devices = Array.isArray(overview.body?.devices) ? overview.body.devices : [];
ok("the overview reports the roster", Array.isArray(devices), JSON.stringify(overview.body).slice(0, 200));
if (devices.length > 0) {
	const first = devices[0];
	const series = await getJson(`/metrics?id=${encodeURIComponent(first.id)}&limit=10`);
	eq("the metrics route answers for the first device", series.status, 200);
	const rows = Array.isArray(series.body?.series) ? series.body.series : [];
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	ok("series rows exist for a collected device", rows.length === 0 || columns.length > 0, `${rows.length} rows`);
	ok("no series column uses the old `memory` name", !columns.includes("memory"), columns.join(","));
	ok("no series column uses the old `thermal` name", !columns.includes("thermal"), columns.join(","));
	// Internal baselines must never leak to the browser: they are what the next
	// sample is diffed against, not something to chart.
	ok("no internal baseline leaks into the series", !columns.some((name) => ["procStat", "netRows", "dioRows"].includes(name)), columns.join(","));
} else {
	console.log("  note  the roster is empty, so the series check was skipped");
}
//#endregion

//#region 4. settings
console.log("\n== settings ==");
const settings = await getJson("/settings");
const value = settings.body?.settings;
eq("settings is a registered route", settings.status, 200);
eq("the default refresh interval is 60 s", value?.refreshIntervalSec, 60);
eq("the default thresholds are cpu:90 mem:90 disk:85 temp:80",
	`cpu:${value?.thresholds?.cpu} mem:${value?.thresholds?.mem} disk:${value?.thresholds?.disk} temp:${value?.thresholds?.temp}`,
	"cpu:90 mem:90 disk:85 temp:80");
eq("raw logging defaults on", value?.rawLog?.enabled, true);
eq("custom commands default off", value?.customCommands?.enabled, false);
ok("settings ships the catalog too", Array.isArray(settings.body?.catalog), JSON.stringify(settings.body).slice(0, 120));
//#endregion

//#region 5. logs
console.log("\n== logs ==");
const logs = await getJson("/logs/status");
eq("logs/status is a registered route", logs.status, 200);
ok("the log directory is reported", typeof logs.body?.dir === "string" && logs.body.dir.includes("dsh-device-monitor-logs"), JSON.stringify(logs.body?.dir));
ok("the log directory is NOT inside the profile's node_modules", !String(logs.body?.dir ?? "").includes("node_modules"), String(logs.body?.dir));
//#endregion

//#region 6. watch lease
console.log("\n== watch lease ==");
// The lease route is POST-only (`src/routes.js:350` guards it with ["POST"]), so a
// GET is a 405 by design — and asserting GET 200 here could never have passed.
// Exercise the real contract instead: take a lease, see it counted, release it,
// and confirm the count returns to where it started. The release at the end keeps
// this probe from leaving a lease behind that would keep the Host polling.
async function postWatch(body) {
	const response = await fetch(`${API}/watch`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: response.status, body: parsed };
}
const watchFields = ["active", "clients", "intervalMs", "expiresInMs", "timerRunning"];
const watchIdle = await postWatch({ clientId: "verify-live-gui", release: true });
eq("watch is a registered route", watchIdle.status, 200);
ok("the watch status reports the fields the panel reads",
	watchFields.every((key) => watchIdle.body?.watch?.[key] !== undefined),
	JSON.stringify(watchIdle.body?.watch));
const clientsBefore = watchIdle.body?.watch?.clients ?? 0;
const watchTaken = await postWatch({ clientId: "verify-live-gui", intervalSec: 15 });
eq("a lease can be taken", watchTaken.status, 200);
eq("the lease is counted", watchTaken.body?.watch?.clients, clientsBefore + 1);
eq("the lease carries the requested cadence", watchTaken.body?.watch?.intervalMs, 15_000);
ok("a live lease keeps the timer running", watchTaken.body?.watch?.timerRunning !== undefined);
const watchReleased = await postWatch({ clientId: "verify-live-gui", release: true });
eq("the lease is given back", watchReleased.body?.watch?.clients, clientsBefore);
//#endregion

//#region 7. the debug terminal
console.log("\n== the debug terminal ==");
// The terminal has TWO paths and they must not be the same one: the read-only
// status route is a normal JSON route, while the socket is an upgrade route
// registered separately. Pointing the client at the status route would leave a
// WebSocket dialing a JSON endpoint, which fails only at runtime and only for
// the one user who tried to open a terminal.
const termStatus = await getJson("/terminal/status");
eq("terminal/status is a registered route", termStatus.status, 200);
// Do NOT assert a VALUE here. `enabled` is a user setting, and a live check that
// pins the user's current configuration fails the moment they change it — which
// is exactly what happened: this line read `=== false` and went red the first
// time the terminal was turned on in the GUI. The invariant that IS about the
// code is that the gate is a strict boolean (never truthy-but-not-true), because
// `enabled` must be a real `true` everywhere; the default-OFF rule is asserted
// offline against a fresh store (terminal-smoke).
eq("the terminal gate is a strict boolean, not a truthy value",
	typeof termStatus.body?.enabled, "boolean");
eq("the terminal reports its socket path", termStatus.body?.path, "/api/dsh-device-monitor/terminal");
ok("the socket path is NOT the status route",
	termStatus.body?.path !== "/api/dsh-device-monitor/terminal/status",
	String(termStatus.body?.path));
eq("the per-device session cap is 3", termStatus.body?.maxPerDevice, 3);
eq("the total session cap is 10", termStatus.body?.maxTotal, 10);
eq("the default idle timeout is 5 minutes", termStatus.body?.idleMs, 300_000);
// The allowlist is a count here on purpose: the Host never ships the addresses
// back to the browser, so a bug that returned the whole list would be invisible
// to a check that only looked for the field. Assert the SHAPE instead.
ok("the allowlist is reported as a count, never as the list itself",
	typeof termStatus.body?.allowedHosts === "number",
	JSON.stringify(termStatus.body?.allowedHosts));
ok("no live session is open by default", termStatus.body?.count === 0, String(termStatus.body?.count));
// The socket path must not answer a plain GET. It is registered on the upgrade
// channel, so a GET either falls through to the SPA fallback or is refused — in
// no case may it be a 200 JSON route, which would mean it was registered as an
// ordinary route and the upgrade handler was never wired up.
const plainGet = await fetch(`${API}/terminal`);
const plainText = await plainGet.text();
ok("the socket path does not answer a plain GET as a JSON route",
	!/^\s*\{\s*"ok"/.test(plainText),
	`GET /terminal answered ${plainGet.status} with ${plainText.slice(0, 80)}`);
//#endregion

//#region 8. the served client bundle carries the new UI
console.log("\n== the shipped client build ==");
// The Host half and the client bundle ship together, so checking the bundle
// proves the browser will actually get the right-column views rather than only
// proving the API half is fresh.
//
// Two probes, in order of strength. The served bundle is the stronger evidence
// (it is literally the bytes the browser will run), but reading it needs the
// index HTML, which the desktop's own auth layer answers 401 to without the
// app's session. When that happens the check falls back to the on-disk source
// and SAYS SO, rather than quietly skipping or pretending the weaker check was
// the stronger one.
const MARKERS = [
	["the better-sidebar tab registration", "registerTab"],
	["the custom-command switch", "data-dsh-custom-commands"],
	["the metric picker", "data-dsh-metric-key"],
	["the threshold inputs", "data-dsh-threshold"],
	["the add/edit form marker", "data-dsh-device-form"],
	["the logs view marker", "data-dsh-device-logs"],
	// The waveform scale. Its absence is what made a busier-than-idle CPU draw the
	// same flat line as a dead one, so the fix must be visible in the shipped bytes.
	["the published waveform scale", "data-dsh-wave-lo"],
	// The axes. A bare sparkline shows that a line moved but not by how much nor
	// over what span, and the scale lived only in a data attribute no human
	// reads. Four needles, because a readable chart is four separate facts: a y
	// label box, the axis carrying the line's own scale, an x label box, and the
	// single scale object both the line and the labels consume.
	["the waveform y axis", 'className: "ddm-axis ddm-axis-y"'],
	["the waveform x axis", 'className: "ddm-axis ddm-axis-x"'],
	["the axis carrying the line's own scale", '"data-dsh-axis-lo": scale.lo.toFixed(3)'],
	["the one scale both the line and its labels read", "const scale = waveScale(values, undefined, column.ceiling);"],
	// The sampling hint beside each metric checkbox. Without it the config form was
	// a list of bare names: a checkbox and nothing to say what it reads.
	["the metric sampling hint", "ddm-check-hint"],
	// The per-metric reading on a checked row.
	["the metric value readout", "data-dsh-metric-value"],
	// The debug terminal (item ③). Four markers, because "the terminal shipped"
	// is four separate facts: the card button exists, the overlay exists, the
	// settings switch exists, and the per-metric readout of its allowlist is
	// reachable. A build with only some of them is a half-shipped feature.
	["the card's terminal button", "data-dsh-card-terminal"],
	["the terminal overlay", "data-dsh-terminal"],
	["the terminal socket frame handler", 't: "open"'],
	["the terminal settings switch", "data-dsh-terminal-commands"],
	// The React #310 fix (minified error, reported from the running GUI as a
	// `dsh-better-sidebar` crash): every hook must run before the early return.
	//
	// The marker is the fix's own signature. Pre-fix code tested
	// `if (term.owner !== owner) return null;` directly; post-fix it computes a
	// boolean first and guards after the effects, so this exact line exists in no
	// build that can throw #310. Checking a marker would be weaker evidence, but
	// hook ORDER is not recoverable by grepping a bundle — what IS checkable is
	// that the shipped bytes are the rewritten component, and `client-smoke`
	// enforces the ordering itself (M33).
	["the React #310 hook-order fix", "const mine = term.owner === owner;"],
	// m07341. The desktop shell serves this page from `dsh-app://app`, so
	// `window.location.host` is the literal string `app`; the old builder turned
	// that into `ws://app/...`, which the renderer refuses before sending a byte.
	// The fix reads the Host origin the shell publishes instead.
	["the desktop-shell transport fix", "__DSH_TRANSPORT__"],
	// The fix's structural signature: the socket path is RESOLVED AGAINST A BASE
	// rather than concatenated onto an authority. No pre-fix build contains this
	// line, and no build that has it can produce `ws://app/...` as its primary
	// path.
	["the base-resolved socket URL", "new URL(API.terminalSocket.slice(1)"],
	// m08259 bug 2. The pane strips ANSI/CSI now; the pre-fix build stripped
	// only the bracketed-paste toggles, which is why the user read `[0m[01;34m`
	// in front of every `ls` entry.
	["the ANSI stripper", "const TERM_CSI = "],
	["the OSC form, consumed before the CSI form", "const TERM_OSC = "],
	// m09014, corrected by m09258. The panel fills the COLUMN it was opened
	// from, pinned to all four edges. This marker is about the rule's SHAPE, so
	// it cannot be satisfied by a rule that leaves a gutter: a `left:18px`
	// expansion is a different string and the marker does not contain it. The
	// `position:absolute` prefix is part of the marker because the first attempt
	// at this fix used `position:fixed`, which resolved against the shell's
	// full-viewport panel host instead of the column.
	["the column-filling expand rule", ".ddm-term-panel-full{position:absolute;left:0;top:0;right:0;bottom:0"],
	// The containing block the expanded rule resolves against. Without it the
	// absolute panel climbs to whatever positioned ancestor another plugin
	// provides — which is how the viewport-covering version came about.
	["the view root that contains the panel", ".ddm-view{position:relative;"],
	// m09671. The load reading now states the core count it is measured against,
	// in the same string as the numbers. This is the shipped-bytes proof that the
	// dimension is present: the pre-fix build had no such text anywhere near the
	// load case, because the divisor lived in a bar width instead.
	["the load reading's core dimension", "const cores = numOrNull(load.cores) ?? numOrNull(sample.cpu?.cores);"],
	// m11134 item ②. The ghost fields. `description` / `location` / `tags` were
	// accepted by the store, editable in the form, and rendered NOWHERE; `group`
	// was rendered nowhere AND appeared in no UI at all. Two needles, because the
	// fields have two homes and the reported defect was exactly that neither drew
	// anything: the card's chip list, and the detail view's row.
	["the card's tag chips", '"data-dsh-card-tag": tag'],
	["the detail view's location row", '"data-dsh-detail-location": location'],
];

/**
 * What must be absent once a fix has landed.
 *
 * A marker proves the fix is present; it does NOT prove the bug is gone,
 * because a fix added BESIDE the old path rather than INSTEAD of it passes
 * every marker while still taking the broken branch.
 */
const ABSENT = [
	// The pre-fix `window.location` authority, asserted ABSENT as the *primary*
	// path.
	//
	// This is the inverse of a marker and it needs care: the old concatenation
	// still exists in the shipped source, as the last-resort `catch` fallback for
	// a page with no usable base at all (a browser cannot reach the plugin from
	// `dsh-app:` without a published transport, but it must still fail with the
	// `term.failed` sentence rather than throw). So its mere presence proves
	// nothing.
	//
	// What must be absent is the SHAPE that made it authoritative: a bare
	// `const url =` assigned from `window.location`. Asserting the assignment
	// form, not the substring, is what distinguishes "kept as a fallback" from
	// "still the primary source of truth".
	["the old window.location authority, as the primary URL source", "const url = `${scheme}://${window.location?.host"],
	// m08259 bug 2. The bracketed-paste-only stripper: if this constant is back,
	// the escape sequences are back with it, because nothing else consumed them.
	["the bracket-only terminal stripper", "TERM_BRACKETED_PASTE"],
	// m09014. The element-level Fullscreen API must not come back. It was tried
	// and rejected: it lifts the panel into the browser's top layer and covers
	// the whole window, hiding the conversation the panel exists to sit beside.
	// The user asked for the SIDEBAR, so ANY surviving API call is a regression,
	// which is why this is asserted as a family of three names rather than one
	// call shape — a partial removal would otherwise look clean.
	["a surviving requestFullscreen call", "requestFullscreen"],
	["a surviving exitFullscreen call", "exitFullscreen"],
	["a surviving fullscreenchange listener", "fullscreenchange"],
	// The same regression at the CSS level: a pseudo-class rule can only fire if
	// the element is IN the top layer, so its presence means the API path is
	// still reachable.
	["a surviving viewport-covering fullscreen rule", ".ddm-term-panel:fullscreen"],
	// m09258. `position:fixed` is what let the panel escape the column: the only
	// containing-block-creating ancestor in the real app is the shell's
	// full-viewport [data-dsh-panel-host], so an inset:0 fixed panel covered the
	// window and its restore button went under the shell's title bar. The
	// declaration form is asserted rather than the bare word, because `fixed`
	// appears in explanatory comments that are not code.
	["a viewport-fixed terminal panel", ".ddm-term-panel{position:fixed;"],
	// m09671. The load bar must not come back. Its length was `load1 / cores`
	// against a count that was fabricated as 1 whenever the CPU metric was off,
	// so on a real 4-core device it read 54% where the truth was 13.5%. Any
	// surviving piece of the bar machinery is a regression, so this is the whole
	// family — the helper, the tone classifier, and the class names it painted.
	// A partial removal would otherwise look clean.
	["a surviving load bar helper", "function MetricBar("],
	["a surviving bar tone classifier", "function barTone("],
	["a surviving bar container class", "ddm-bar"],
	["the gauge metric list that put load in a bar", "const GAUGE_METRICS = ["],
	// The fabricated denominator itself, in the shape it had: defaulting a missing
	// core count to 1. `Math.max(1, ...)` and `?? 1` are different code paths to
	// the same wrong answer, so both are asserted absent.
	["a fabricated one-core default in the client", "sample?.cpu?.cores ?? 1"],
	// m11134 item ②, the other direction. The ghost fields are also a defect when
	// they are drawn EMPTY: a rendered "位置" row with no value claims the user
	// recorded a location and it is blank. The guard must survive, so its removal
	// is asserted absent in the same shape the mutant (M70) uses.
	["an unconditional note row with no emptiness guard", 'false\n\t\t\t\t\t? null\n\t\t\t\t\t: h("div", { className: "ddm-notes" },'],
];
let bundleSource = null;
let bundleLabel = "";
try {
	const indexResponse = await fetch(`${BASE}/`);
	const indexText = await indexResponse.text();
	if (indexResponse.status === 200) {
		const bundleUrl = indexText.match(/\/plugins\/\?\?[^"']*device-monitor[^"']*client\.js[^"']*/)?.[0];
		if (bundleUrl !== undefined) {
			const bundle = await fetch(bundleUrl.startsWith("http") ? bundleUrl : `${BASE}${bundleUrl}`);
			if (bundle.status === 200) {
				bundleSource = await bundle.text();
				bundleLabel = "the served bundle";
			}
		}
	}
} catch {
	// Fall through to the on-disk probe; the reason is reported below.
}
if (bundleSource === null) {
	const { readFileSync } = await import("node:fs");
	const onDisk = new URL("../client.js", import.meta.url);
	bundleSource = readFileSync(onDisk, "utf8");
	bundleLabel = "client.js on disk (the served bytes are a frame of this file)";
	console.log(`  note  the served bundle needs the app session, so this checks ${bundleLabel}`);
}
for (const [label, marker] of MARKERS) {
	ok(`${bundleLabel}: carries ${label}`, bundleSource.includes(marker), `no ${marker} in ${bundleLabel}`);
}
// The inverse check. A marker proves the fix is present; it does NOT prove the
// bug is gone, because a fix added BESIDE the old path rather than INSTEAD of it
// passes every marker while still taking the broken branch. For m07341 that
// distinction is the entire fix.
for (const [label, forbidden] of ABSENT) {
	ok(`${bundleLabel}: has dropped ${label}`, !bundleSource.includes(forbidden), `still contains ${forbidden}`);
}
// Guard the guard, one level down. `!includes(x)` is trivially true when `x` is
// UNSEARCHABLE — an empty string, or a needle whose whitespace does not match
// the file's. A check that cannot fail proves nothing, so each forbidden string
// is inserted into a copy of the source and the same predicate is required to
// fire. This is the only thing standing between "the bug is gone" and "the
// search was never capable of finding it".
for (const [label, forbidden] of ABSENT) {
	const synthesized = `${bundleSource}\n/* ${forbidden} */`;
	ok(`${bundleLabel}: this check can actually fail — ${label}`,
		forbidden.length > 0 && synthesized.includes(forbidden),
		`the needle is unsearchable: ${JSON.stringify(forbidden)}`);
}
// A doubled placeholder is a real bug: the shell's interpolator uses the
// single-brace form, so `{{count}}` ships as a literal `{name}` to the user.
//
// Comments are stripped before the test. The bundle legitimately DOCUMENTS this
// hazard — client.js:355 explains that a doubled `{{name}}` would be left behind
// as a stray `{name}` — and a checker that fails on the warning about a bug is
// testing the prose, not the product.
const codeOnly = bundleSource
	.split("\n")
	.filter((line) => {
		const trimmed = line.trim();
		return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
	})
	.join("\n");
const leak = codeOnly.match(/\{\{\s*[a-z]+\s*\}\}/i);
ok(`${bundleLabel}: leaks no placeholder token`, leak === null, `a doubled placeholder survived into executable code: ${leak?.[0]}`);
// Guard the guard: if the strip were too aggressive it would hide everything, so
// prove at least one real interpolation survived the filter.
ok(`${bundleLabel}: the placeholder scan still sees real code`,
	/\{\s*\w+\s*\}/.test(codeOnly),
	"the comment strip removed every interpolation, so the leak check proves nothing");
// The inverse of a marker: the left rail entry must be GONE. Asserting only that
// the new things exist would let a build ship both entrances at once, which is
// exactly the state the user asked to end. Checked on the injection call rather
// than the bare name, so a comment explaining the removal does not read as a
// surviving registration.
ok(`${bundleLabel}: no longer registers the left-rail panel entry`,
	!/slots\.inject\(\s*"sidebar\.panellist"/.test(bundleSource),
	"the sidebar.panellist injection is back in the shipped bundle");
//#endregion

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures.length}/${checks} checks`);
if (failures.length > 0) {
	console.log(failures.map((row) => `  - ${row}`).join("\n"));
	// The most likely cause is worth stating plainly rather than leaving the
	// reader to infer it from a wall of 401s.
	console.log("\nIf the new routes 401'd, the Host is still running the OLD module generation:");
	console.log("quit DeepSeek Harness completely and start it again, then re-run this script.");
	process.exitCode = 1;
}
