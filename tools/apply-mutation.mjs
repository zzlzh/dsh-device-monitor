#!/usr/bin/env node
/**
 * Applies or restores ONE mutation of the m03697 fixes.
 *
 * Split from the runner on purpose: this process must never spawn a child. The
 * sandbox denies piped stdio (spawnSync -> EPERM), so the suite is driven by
 * PowerShell, whose own pipelines are unaffected.
 *
 *   node apply-mutation.mjs list
 *   node apply-mutation.mjs check          # every anchor present in pristine?
 *   node apply-mutation.mjs apply <index>
 *   node apply-mutation.mjs restore        # restore EVERY mutated target
 *
 * Each mutation names the file it edits, and is applied to that file's
 * PRISTINE byte-copy rather than to whatever is currently on disk. That is
 * deliberate: an earlier version edited the working file and unlinked its backup
 * only AFTER spawning a child, so one crashed run left `client.js` as a
 * FOUR-DEEP STACKED MUTANT — every anchor lookup then failed and every mutation
 * reported the same red list, which looks like a mass regression rather than a
 * broken harness.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// Derived from this file's own location rather than hardcoded, so a checkout
// anywhere works. Mutation targets are addressed relative to the repo root,
// which is one level up from tools/.
const ROOT = resolve(import.meta.dirname, "..");

/** Mutation target => its immutable baseline. Never written by a mutation. */
const TARGETS = {
	client: { file: ROOT + "/client.js", pristine: process.env.DDM_PRISTINE ?? ROOT + "/tools/client.js.pristine" },
	collectors: { file: ROOT + "/src/collectors.js", pristine: process.env.DDM_PRISTINE_COLLECTORS ?? ROOT + "/src/collectors.js.pristine" },
	// The terminal's Host half is two files, and the two halves fail differently:
	// `terminal.js` owns the policy (the gate, the caps, the idle floor), while
	// `terminal-route.js` owns the transport (the fence, the frame loop, the race
	// between two `open` frames). They get separate targets so a mutation names
	// which half it is supposed to break.
	terminal: { file: ROOT + "/src/terminal.js", pristine: process.env.DDM_PRISTINE_TERMINAL ?? ROOT + "/src/terminal.js.pristine" },
	route: { file: ROOT + "/src/terminal-route.js", pristine: process.env.DDM_PRISTINE_ROUTE ?? ROOT + "/src/terminal-route.js.pristine" },
	// The plugin entry point owns what gets MOUNTED: which routes, which
	// upgrade paths, and what happens on an older Host that has no upgrade
	// registry at all. `activate-smoke.mjs` registers into separate tables for
	// exactly this reason — a route count alone cannot say WHICH route went
	// missing, so a mutation here would otherwise be caught by luck.
	host: { file: ROOT + "/index.js", pristine: process.env.DDM_PRISTINE_HOST ?? ROOT + "/tools/index.js.pristine" },
	// The poll/probe orchestration. `withStoredSecret` lives here, and it is the
	// function whose absence produced the reported "All configured authentication
	// methods failed": the edit form's blank password box reached ssh2 verbatim.
	monitor: { file: ROOT + "/src/monitor.js", pristine: process.env.DDM_PRISTINE_MONITOR ?? ROOT + "/src/monitor.js.pristine" },
	// The shared trust fence. It owns the decision that admits the desktop
	// shell's page origin, which is half of m07341 — and the ORDER in which that
	// decision is reached, which is the half that is easy to get wrong.
	http: { file: ROOT + "/src/http.js", pristine: process.env.DDM_PRISTINE_HTTP ?? ROOT + "/src/http.js.pristine" },
	// The manifest itself. A packaging defect is invisible to every other
	// suite, because they all run against the WORKING TREE — the one context
	// where a file that never ships is still present. `pack-dist.mjs` is the
	// only suite that asks what the tarball contains, so it is the one this
	// target is paired with.
	manifest: { file: ROOT + "/package.json", pristine: process.env.DDM_PRISTINE_MANIFEST ?? ROOT + "/tools/package.json.pristine" },
	// The Agent-facing tool definitions. They own the ONE thing the model can
	// ask that the panel never shows — the durable event history — plus how a
	// device row is rendered to the model.
	tools: { file: ROOT + "/src/tools.js", pristine: process.env.DDM_PRISTINE_TOOLS ?? ROOT + "/src/tools.js.pristine" },
	// The distribution checker itself. It is the only suite whose subject is the
	// PACKED ARTEFACT, so the only way to test its own expectations is to mutate
	// the checker. A guard that reads the thing it is validating can never fail,
	// and no mutation of the product would reveal that.
	packdist: { file: ROOT + "/tools/pack-dist.mjs", pristine: process.env.DDM_PRISTINE_PACKDIST ?? ROOT + "/tools/pack-dist.mjs.pristine" },
};

const MUTATIONS = [
	{
		name: "M1 wave axis: restore the fixed 0..100 ceiling",
		target: "client",
		edits: [
			["const hardTop = numOrNull(ceiling) ?? numOrNull(max);", "const hardTop = 100;"],
			[
				"const pad = Math.max((dataMax - dataMin) * 0.25, hardTop !== null ? hardTop * 0.04 : dataMax * 0.04, 1e-6);\n\t\t\tlet lo = Math.max(0, dataMin - pad);\n\t\t\tlet hi = dataMax + pad;",
				"const pad = 0;\n\t\t\tlet lo = 0;\n\t\t\tlet hi = 100;",
			],
		],
	},
	{
		name: "M2 wave axis: stop publishing the scale",
		target: "client",
		edits: [['\t\t\t\t"data-dsh-wave-lo": lo.toFixed(3),\n\t\t\t\t"data-dsh-wave-hi": hi.toFixed(3),\n', ""]],
	},
	{
		name: "M3 metric hint: stop rendering the catalog hint in the form",
		target: "client",
		edits: [
			[
				'\t\t\t\t\t\trow.hint === undefined || row.hint === "" ? null : h("span", { className: "ddm-check-hint" }, row.hint),\n\t\t\t\t\t),\n\t\t\t\t\tdetail === null ? null : h("span", { className: "ddm-check-value", "data-dsh-metric-value": row.key }, detail),',
				'\t\t\t\t\t),\n\t\t\t\t\tdetail === null ? null : h("span", { className: "ddm-check-value", "data-dsh-metric-value": row.key }, detail),',
			],
		],
	},
	{
		name: "M4 metric value: stop rendering the collected detail",
		target: "client",
		edits: [['\t\t\t\t\tdetail === null ? null : h("span", { className: "ddm-check-value", "data-dsh-metric-value": row.key }, detail),', ""]],
	},
	{
		name: "M5 left rail: re-add the sidebar.panellist injection",
		target: "client",
		edits: [
			[
				'\t\t\tdisposers.push(slots.inject("main", () => slots.register({',
				'\t\t\tdisposers.push(slots.inject("sidebar.panellist", () => slots.register({\n\t\t\t\tname: "sidebar.panellist",\n\t\t\t\tid: PANEL_ID,\n\t\t\t\torder: PANEL_ORDER,\n\t\t\t\tlabel: () => t("entry.label"),\n\t\t\t}, DevicePanelIcon)));\n\t\t\tdisposers.push(slots.inject("main", () => slots.register({',
			],
		],
	},
	{
		name: "M6 metric detail: fabricate a value when the metric was never collected",
		target: "client",
		edits: [
			[
				'\t\t\tif (sample === undefined || sample === null) return null;',
				'\t\t\tif (sample === undefined || sample === null) return "0%";',
			],
		],
	},
	{
		// M7 originally drew a bar beside a chart that already printed its reading.
		// That whole gauge strip is gone (see M53–M55 for why), so the surviving
		// form of "one number, two visual languages" is the strip itself. This
		// mutant deletes load's ONLY remaining home: it has no chart column, so
		// without a cell the card goes silent about load entirely.
		name: "M7 card: drop load's cell, leaving the reading with nowhere to appear",
		target: "client",
		edits: [
			['\t\t\t["load", "metric.load"],\n', ""],
		],
	},
	{
		name: "M8 chart header: read the series instead of the live sample",
		target: "client",
		edits: [
			[
				"const readings = waveLatest(sample, latest ?? lastRow);",
				"const readings = latest ?? lastRow ?? {};",
			],
		],
	},
	{
		name: "M9 net parser: drop the compact emitted-form branch",
		target: "collectors",
		edits: [
			[
				'    // The collector\'s own output: "name rxBytes txBytes".\n    const p = line.trim().split(/\\s+/);\n    if (p.length < 3) continue;\n    const name = p[0];\n    if (!name || name === "lo") continue;',
				'    // The collector\'s own output: "name rxBytes txBytes".\n    const p = line.trim().split(/\\s+/);\n    if (p.length < 3) continue;\n    const name = "";\n    if (!name || name === "lo") continue;',
			],
		],
	},
	{
		name: "M10 diskio parser: drop the compact emitted-form branch",
		target: "collectors",
		edits: [
			["    const compact = p.length >= 3 && p.length < 10;", "    const compact = false;"],
		],
	},
	{
		name: "M11 diskio parser: drop the raw /proc branch",
		target: "collectors",
		edits: [
			["    const raw = p.length >= 10;", "    const raw = false;"],
		],
	},
	{
		// Item ③ — the terminal's Host-side policy. Each of these turns a real
		// guard into the state a hasty implementation would have shipped.
		name: "M12 terminal: default the gate to open",
		target: "terminal",
		edits: [
			["if (!config.enabled) {", "if (false) {"],
		],
	},
	{
		name: "M13 terminal: accept a truthy `enabled` instead of a real boolean",
		target: "terminal",
		edits: [
			["enabled: raw.enabled === true,", "enabled: Boolean(raw.enabled),"],
		],
	},
	{
		name: "M14 terminal: drop the empty-address refusal in hostAllowed",
		target: "terminal",
		edits: [
			['if (ip === "") return false;', 'if (ip === "") return true;'],
		],
	},
	{
		name: "M15 terminal: remove the idle-timeout floor",
		target: "terminal",
		edits: [
			["\treturn Math.max(MIN_IDLE_MS, ms);", "\treturn ms;"],
		],
	},
	{
		name: "M16 terminal: let an empty socket id close every unattached session",
		target: "terminal",
		edits: [
			['if (socket === "") return 0;', 'if (socket === "") return this.closeAll("socket closed");'],
		],
	},
	{
		// Item ③ — the transport. M17 is the double-`open` race and M18 the dial
		// that finishes after its socket died; both leak a live PTY with no owner.
		name: "M17 terminal route: drop the in-flight open guard",
		target: "route",
		edits: [
			["if (session !== undefined || opening) return;\n\t\t\topening = true;", "if (session !== undefined) return;"],
		],
	},
	{
		name: "M18 terminal route: keep a PTY whose socket died mid-dial",
		target: "route",
		edits: [
			['if (ws.readyState !== 1) {\n\t\t\t\tmanager.close(result.session.id, "连接已断开");\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tsession = result.session;', "session = result.session;"],
		],
	},
	{
		// Item ③ — the client half.
		name: "M19 terminal client: send a newline instead of a carriage return",
		target: "client",
		edits: [
			['return termSend({ t: "in", data: text + "\\r" });', 'return termSend({ t: "in", data: text + "\\n" });'],
		],
	},
	{
		name: "M20 terminal client: clear the connect guard as soon as the socket opens",
		target: "client",
		edits: [
			["socket.onopen = () => {\n\t\t\t\t// The timer is NOT cleared here — see above.", "socket.onopen = () => {\n\t\t\t\ttermClearConnectTimer();"],
		],
	},
	{
		name: "M21 terminal client: render the overlay into every seat",
		target: "client",
		edits: [
			["if (!mine) return null;", "if (owner === null) return null;"],
		],
	},
	{
		// Items ① and ② — the two layout regressions the user reported.
		name: "M22 form: let the full-width input rule stretch the checkboxes again",
		target: "client",
		edits: [
			['.ddm-form-panel .ddm-field input:not([type="checkbox"])', ".ddm-form-panel .ddm-field input"],
		],
	},
	{
		name: "M23 form: drop the checkbox size override",
		target: "client",
		edits: [
			['.ddm-form-panel .ddm-field .ddm-check input[type="checkbox"]{width:15px;height:15px;flex:none;margin:0;padding:0}', ".ddm-form-panel .ddm-field .ddm-check input[type=\"checkbox\"]{}"],
		],
	},
	{
		name: "M24 card: stack the waveforms into a grid instead of one per row",
		target: "client",
		edits: [
			[".ddm-waves{display:flex;flex-direction:column;gap:8px}", ".ddm-waves{display:grid;grid-template-columns:1fr 1fr;gap:8px}"],
		],
	},
	{
		// The de-duplication rule, in the negative. A charted metric already prints
		// its reading in the chart header, so re-adding it to the numeric strip
		// puts one number on screen twice in two visual languages. The check reads
		// `ddm-nums` membership, so this must still be caught now that the gauge
		// strip (and its own copy of this rule) is gone.
		name: "M25 card: re-duplicate a charted metric into the numeric strip",
		target: "client",
		edits: [
			["if (hasWaveColumn(key)) continue;", "if (false) continue;"],
		],
	},
	{
		// M26's original premise — "dropping load from the bar AND the cell would
		// leave the card silent about load" — no longer holds, because the bar is
		// gone. The surviving inverse is about the CORE COUNT: load's cell is the
		// only place the reading appears, so if the cell loses its dimension the
		// number survives but stops meaning anything. That is the m09671 defect in
		// its milder form, and it is what this now guards.
		name: "M26 card: print the load cell without the core count it is measured against",
		target: "client",
		edits: [
			["const cores = numOrNull(load.cores) ?? numOrNull(sample.cpu?.cores);\n\t\t\t\t\treturn cores === null ? averages : `${averages} · ${t(\"card.cores\", { count: cores })}`;",
				"return averages;"],
		],
	},
	{
		// The exact m09671 bug, restored: decide the core count from the CPU metric
		// alone. On a load-only device `sample.cpu` is null, so the load reading
		// loses its dimension entirely — and under the OLD bar-based rendering this
		// same expression was what fabricated a 1-core box.
		name: "M53 client: take the load dimension from the CPU metric only",
		target: "client",
		edits: [
			["const cores = numOrNull(load.cores) ?? numOrNull(sample.cpu?.cores);", "const cores = numOrNull(sample.cpu?.cores);"],
		],
	},
	{
		// The device-side half of the same bug: stop collecting the tally, so the
		// parser's `cores` is null and the client has nothing to fall back to even
		// when it is willing to look. A client-only fix would keep this green,
		// which is why the collector needs its own mutant.
		name: "M54 host: collect the load averages without the core tally",
		target: "collectors",
		edits: [
			['metric("load", "cat /proc/loadavg 2>/dev/null; grep -c \'^cpu[0-9]\' /proc/stat 2>/dev/null || true", 8000);',
				'metric("load", "cat /proc/loadavg 2>/dev/null", 8000);'],
		],
	},
	{
		// A fabricated denominator in its purest form: assume one core when the
		// tally is missing, which is what reported a 4-core box's 0.54 load as a
		// 54% saturation.
		name: "M55 host: assume a single core when the load tally is missing",
		target: "collectors",
		edits: [
			["const loadCores = load === null ? null : (load.cores ?? (rawTexts.procStat ? coresOf(rawTexts.procStat) : null));",
				"const loadCores = load === null ? null : (load.cores ?? 1);"],
		],
	},
	{
		// The obvious implementation, and the one that silently lies: recompute
		// the scale inside the axis. Each chart then labels a range its line was
		// not drawn in, and nothing on screen reveals the disagreement.
		name: "M56 wave axis: relabel the axis from a scale recomputed on its own",
		target: "client",
		edits: [
			['\t\t\t\t\t\t\t"data-dsh-axis-lo": scale.lo.toFixed(3),\n\t\t\t\t\t\t\t"data-dsh-axis-hi": scale.hi.toFixed(3),\n',
				'\t\t\t\t\t\t\t"data-dsh-axis-lo": (waveScale(values.map((value) => (value === null ? null : value * 2)), undefined, column.ceiling)?.lo ?? 0).toFixed(3),\n\t\t\t\t\t\t\t"data-dsh-axis-hi": (waveScale(values.map((value) => (value === null ? null : value * 2)), undefined, column.ceiling)?.hi ?? 0).toFixed(3),\n'],
		],
	},
	{
		// The ticks are what a human reads; the attributes only exist so a test
		// can compare them. Mutating only the printed text proves the tick
		// assertion is not just re-reading the scale it was handed.
		name: "M59 wave axis: print a plausible top tick that is not the scale's",
		target: "client",
		edits: [
			['h("span", null, axisText(column, scale.hi, scale.hi - scale.lo)),',
				'h("span", null, axisText(column, (waveScale(values.map((value) => (value === null ? null : value * 2)), undefined, column.ceiling)?.hi ?? 0), scale.hi - scale.lo)),'],
		],
	},
	{
		// A chart with no coordinates is a shape, not a reading. The y range is
		// the only thing that says HOW MUCH the line moved.
		name: "M57 wave axis: draw the line without its y range",
		target: "client",
		edits: [
			['\t\t\t\t\t\t\th("span", null, axisText(column, scale.hi, scale.hi - scale.lo)),\n\t\t\t\t\t\t\th("span", null, axisText(column, scale.lo, scale.hi - scale.lo)),\n\t\t\t\t\t\t),\n',
				'\t\t\t\t\t\t),\n'],
		],
	},
	{
		// The x axis must follow the series. A constant stamp is a plausible-
		// looking axis that carries no information about when anything happened.
		name: "M58 wave axis: print the time span as a constant",
		target: "client",
		edits: [
			['h("span", null, clockTime(rows.length > 0 ? rows[0]?.ts : undefined)),',
				'h("span", null, clockTime(rows.length > 0 ? rows[rows.length - 1]?.ts : undefined)),'],
		],
	},
	{
		name: "M27 host: mount the terminal socket as an ordinary route",
		target: "host",
		edits: [
			["return ctx.webServer.registerUpgrade(terminal.route);", "return ctx.webServer.register(terminal.route);"],
		],
	},
	{
		name: "M28 host: drop the terminal socket registration entirely",
		target: "host",
		edits: [
			["\t\t\treturn ctx.webServer.registerUpgrade(terminal.route);", "\t\t\treturn () => {};"],
		],
	},
	{
		// A Host with no upgrade registry must still mount everything else. If the
		// guard is weakened into a throw, the whole plugin dies on an older Host
		// over a feature the user never asked for.
		name: "M29 host: assume every Host has an upgrade registry",
		target: "host",
		edits: [
			['\t\t\tif (typeof ctx.webServer?.registerUpgrade !== "function") {', "\t\t\tif (false) {"],
		],
	},
	{
		// The reported bug: an edit form whose password box is blank dialled with
		// an EMPTY password and answered "All configured authentication methods
		// failed". Saving merges the stored auth, so testing must resolve it too.
		name: "M30 monitor: probe a blank password box literally",
		target: "monitor",
		edits: [
			["const device = { id: \"draft\", name: payload?.name ?? \"draft\", ...withStoredSecret(payload, this.store), port: payload?.port ?? 22 };", "const device = { id: \"draft\", name: payload?.name ?? \"draft\", ...payload, port: payload?.port ?? 22 };"],
		],
	},
	{
		// The identity fallback must not become a wildcard. Matching on host alone
		// would hand device B's password to a probe of device A.
		name: "M31 monitor: resolve the stored secret by host only",
		target: "monitor",
		edits: [
			["(row) => row.host === host && Number(row.port ?? 22) === port && row.username === username && row.auth?.kind === \"password\",", "(row) => row.host === host,"],
		],
	},
	{
		// An explicit empty password is a DECISION, not an omission. Treating it
		// as omitted would make "this device has no password" unreachable.
		name: "M32 monitor: treat an explicit empty password as omitted",
		target: "monitor",
		edits: [
			['if (auth.kind !== "password" || typeof auth.password === "string") return payload;', 'if (auth.kind !== "password") return payload;'],
		],
	},
	{
		// React error #310 (minified): "Rendered more hooks than during the
		// previous render". The user hit this in the running GUI as a
		// `dsh-better-sidebar` crash. `TerminalPanel` returned early BEFORE its
		// two effects, so a seat rendered 3 hooks while it did not own the
		// terminal and 5 once it did.
		name: "M33 terminal client: return early before the later hooks (#310)",
		target: "client",
		edits: [
			[
				"			const mine = term.owner === owner;\n\n			// EVERY hook runs before any early return.",
				"			const mine = term.owner === owner;\n			if (!mine) return null;\n\n			// EVERY hook runs before any early return.",
			],
		],
	},
	{
		// The second half of the same fix. Keyed on `[owner]`, the unmount cleanup
		// runs whenever the seat identity changes — and both seats render the
		// same component function, so it closes a terminal that is still on
		// screen.
		name: "M34 terminal client: key the unmount cleanup on the seat owner",
		target: "client",
		edits: [
			[
				"				if (terminal.owner === owner) closeTerminal();\n			}, []);",
				"				if (terminal.owner === owner) closeTerminal();\n			}, [owner]);",
			],
		],
	},
	{
		// The blind spot that made the user's report unanswerable: a refused
		// upgrade wrote nothing at all, so "the browser was refused" and "the
		// request never arrived" left identical evidence. Recording the attempt
		// BEFORE the fence decides is what makes the two distinguishable.
		name: "M35 terminal route: judge the upgrade without recording the attempt",
		target: "route",
		edits: [['\t\taudit("terminal.upgrade", attempt);\n', ""]],
	},
	{
		// And the refusal itself. Without this row the log shows an attempt that
		// simply has no outcome, which reads as a crash rather than a decision.
		name: "M36 terminal route: refuse the upgrade silently",
		target: "route",
		edits: [['\t\t\taudit("terminal.upgradeDenied", attempt);\n', ""]],
	},
	{
		// The third silent exit. A Host without `ws` and a refused caller show
		// the user the same sentence, so they must not look the same in the log.
		name: "M37 terminal route: answer 503 without recording why",
		target: "route",
		edits: [['\t\t\taudit("terminal.upgradeUnavailable", attempt);\n', ""]],
	},
	{
		// The injection point itself. `loadWs` defaults to `softImport`; if the
		// handler ignored the option it would always load the real module, and
		// the 503 branch could never be reached — the assertions that cover it
		// would silently stop covering anything.
		name: "M38 terminal route: ignore the injected ws loader",
		target: "route",
		edits: [['const loadWs = options.loadWs ?? softImport;', 'const loadWs = softImport;']],
	},
	{
		// m07341, the server half. The desktop shell serves the app page from
		// `dsh-app://app`, so its Origin is not loopback and the fence refused it:
		// the plugin was turning away its own UI. Dropping the acceptance restores
		// exactly that.
		name: "M39 fence: refuse the desktop shell's own page origin",
		target: "http",
		edits: [['\tif (origin === DESKTOP_APP_ORIGIN) return true;\n', ""]],
	},
	{
		// The subtle one, and the reason this mutant exists at all: the shell's
		// scheme AND host both differ from the Host's, so the browser labels its
		// upgrade `Sec-Fetch-Site: cross-site`. Writing the acceptance AFTER the
		// cross-site rule is a plausible, well-intentioned edit that fixes
		// nothing — the row reads as "fixed" while the terminal stays broken. A
		// mutation is the only way to hold that ordering in place.
		name: "M40 fence: judge cross-site before the desktop origin",
		target: "http",
		edits: [[
			'\tif (origin === DESKTOP_APP_ORIGIN) return true;\n\tif (request.headers["sec-fetch-site"] === "cross-site") return false;\n',
			'\tif (request.headers["sec-fetch-site"] === "cross-site") return false;\n\tif (origin === DESKTOP_APP_ORIGIN) return true;\n',
		]],
	},
	{
		// The over-broad version of the same fix. `dsh-app://shell` is the shell's
		// OTHER document and must not be able to open device terminals; a prefix
		// match would also swallow `dsh-app://app.evil.example`.
		name: "M41 fence: accept every dsh-app origin, not just the app",
		target: "http",
		edits: [['\tif (origin === DESKTOP_APP_ORIGIN) return true;', '\tif (typeof origin === "string" && origin.startsWith("dsh-app:")) return true;']],
	},
	{
		// m08259 bug 2. Reverting to the original bracket-only stripper: the
		// sequences the user actually saw (`[?1l`, `[58;1H`, `[0m`, `[01;34m`)
		// go straight back into the transcript. This is the ONE edit that
		// reproduces the reported defect exactly, so it is the control for the
		// whole ANSI test group.
		name: "M42 terminal client: strip only the bracketed-paste toggles",
		target: "client",
		edits: [
			[
				"\t\t\tout = out\n\t\t\t\t.replace(TERM_OSC, \"\")\n\t\t\t\t.replace(TERM_CSI, \"\")\n\t\t\t\t.replace(TERM_ESC, \"\");",
				"\t\t\tout = out.replace(/\\x1b\\[\\?2004[hl]/g, \"\");",
			],
		],
	},
	{
		// The over-broad stripper: matching a bracket run WITHOUT requiring the
		// leading ESC. This deletes legitimate text — `[0m` typed by a user, a
		// `[2024-01-01]` log prefix — and nothing in the transcript shows that
		// anything was lost. Its assertion is the "bracket text that is not a
		// real sequence is preserved verbatim" case.
		name: "M43 terminal client: strip bracket runs with no ESC",
		target: "client",
		edits: [
			[
				"\t\tconst TERM_CSI = /\\x1b\\[[0-9;:?<>=!]*[ -/]*[@-~]/g;",
				"\t\tconst TERM_CSI = /\\x1b?\\[[0-9;:?<>=!]*[ -/]*[@-~]/g;",
			],
		],
	},
	{
		// m08259/m09014. The gutter is the whole difference between "the panel
		// grew" and "the panel filled the pane", and it is the exact shape the
		// user complained about twice. Keeping the old 18px inset on all four
		// edges makes the expanded panel a slightly larger floating card — which
		// is what an earlier attempt shipped, and what looked plausible enough
		// that only the user's own eyes caught it.
		name: "M44 terminal client: expand to the pane but keep a gutter",
		target: "client",
		edits: [
			[
				".ddm-term-panel-full{position:absolute;left:0;top:0;right:0;bottom:0;width:auto;max-height:none;border:0;border-radius:0}",
				".ddm-term-panel-full{position:absolute;left:18px;top:18px;right:18px;bottom:18px;width:auto;max-height:none;border:0;border-radius:0}",
			],
		],
	},
	{
		// m08259/m09014. The base rule caps the height at 560px; without lifting
		// it the expanded panel spans the pane horizontally and still stops a
		// third of the way down — "fills the width but not the pane". A vertical
		// cap is invisible in any assertion that only looks at left/right.
		name: "M45 terminal client: keep the base height cap when expanded",
		target: "client",
		edits: [
			[
				".ddm-term-panel-full{position:absolute;left:0;top:0;right:0;bottom:0;width:auto;max-height:none;border:0;border-radius:0}",
				".ddm-term-panel-full{position:absolute;left:0;top:0;right:0;bottom:0;width:auto;max-height:min(560px,calc(100vh - 36px));border:0;border-radius:0}",
			],
		],
	},
	{
		// The toggle itself. `!== true` is what makes the control reversible; a
		// predicate written the other way round applies the class exactly when it
		// is already applied, so the button reads as dead from the second click
		// onward. Both directions are asserted (fill, then restore), so either
		// sign error is caught.
		name: "M46 terminal client: invert the expand/restore predicate",
		target: "client",
		edits: [
			[
				"\t\t\t\ttermPatch({ fullscreen: term.fullscreen !== true });",
				"\t\t\t\ttermPatch({ fullscreen: term.fullscreen === true });",
			],
		],
	},
	{
		// The regression this whole section exists to prevent: putting the
		// element-level Fullscreen API path BACK. Nothing on the class side
		// changes, so every class assertion still passes — only the inverse
		// assertion (no viewport-covering rule, API not called) can see it.
		name: "M47 terminal client: restore the viewport-covering fullscreen rule",
		target: "client",
		edits: [
			[
				".ddm-term-panel-full .ddm-term-out{font-size:13px}",
				".ddm-term-panel:fullscreen{left:0;top:0;right:0;bottom:0;width:100vw;height:100vh;max-height:none;border:0;border-radius:0}\n.ddm-term-panel-full .ddm-term-out{font-size:13px}",
			],
		],
	},
	{
		// m09258, the shipped defect in its purest form. `fixed` escapes to the
		// nearest fixed-ish ancestor, and the only one in the real app is the
		// shell's full-viewport [data-dsh-panel-host] — so the expanded panel
		// covers the window AND its own restore button goes under the shell's
		// title bar. Everything about the CLASS is still correct here, which is
		// the point: the class was never what broke. Only an assertion about the
		// containing block can see this.
		name: "M48 terminal client: pin the expanded panel to the viewport",
		target: "client",
		edits: [
			[
				".ddm-term-panel-full{position:absolute;",
				".ddm-term-panel-full{position:fixed;",
			],
		],
	},
	{
		// The other half of m09258: the panel is absolute, but nothing in the
		// plugin establishes a containing block, so it climbs to whatever
		// positioned ancestor the shell happens to provide — this plugin's own
		// root stops being the anchor, and the panel's box is decided by another
		// plugin's DOM again. Confined to a single declaration so the failure is
		// attributable.
		name: "M49 terminal client: drop the containing block on the view root",
		target: "client",
		edits: [
			[
				".ddm-view{position:relative;display:flex;",
				".ddm-view{display:flex;",
			],
		],
	},
	{
		// A viewport unit inside a narrow column. 100vw of a 1600px window is
		// still 1600px when the panel lives in a 380px sidebar, so the panel
		// overflows its column even though the POSITIONING is correct. Guards the
		// "sized against its column" assertion specifically.
		name: "M50 terminal client: size the corner panel in viewport units",
		target: "client",
		edits: [
			[
				"width:min(720px,calc(100% - 36px));max-height:min(560px,calc(100% - 36px))",
				"width:min(720px,calc(100vw - 36px));max-height:min(560px,calc(100vh - 36px))",
			],
		],
	},
	{
		// The label the user objected to (m09258). The panel never goes
		// fullscreen, so a button that SAYS 全屏 is the mislabelling that made
		// both earlier bugs hard to describe in the first place — the user's own
		// words were that the verb is 扩大. A behaviour assertion cannot see this
		// one, because the class and the box are both still right.
		name: "M51 terminal client: call the expand control fullscreen again",
		target: "client",
		edits: [
			[
				'term.fullscreen === true ? "⛶ 还原" : "⛶ 扩大"',
				'term.fullscreen === true ? "⛶ 还原" : "⛶ 全屏"',
			],
		],
	},
	{
		// The escape hatch behind the escape hatch. The `publish` below REPLACES
		// the terminal slice, so its `fullscreen: false` is the line that decides
		// what a newly opened terminal looks like — the module-level
		// `terminal.fullscreen` assignment just above it is write-only and is
		// never read by anything that renders.
		//
		// "Carry the previous display state across a reconnect" is the
		// plausible-sounding intent that produces the bug, and it is what the
		// m09258 report felt like from the user's side: expanded once, and then
		// every later terminal opened expanded too with no obvious cause.
		//
		// It can only be observed by a path that opens a SECOND terminal while
		// the panel stays on screen, because otherwise the store flag is never
		// rendered again and any assertion about it passes vacuously.
		name: "M52 terminal client: reopen the terminal with the old expanded flag",
		target: "client",
		edits: [
			[
				"\t\t\t\t\tfullscreen: false,",
				"\t\t\t\t\tfullscreen: store.snapshot.terminal?.fullscreen === true,",
			],
		],
	},
	{
		// The pack's own `files` list. Dropping the bundle patch here is the
		// exact defect that shipped silently: `npm pack` omits it, the install
		// reports success, and the bundle can never be loaded because
		// `dsh.bundle.patch` points at a file that is not in the tarball.
		//
		// Nothing in the working tree notices, which is the point — the file is
		// still there, so every other suite stays green.
		name: "M60 manifest: ship a bundle whose patch file is not in the package",
		target: "manifest",
		edits: [['    "cordis.patch.yml",\n', ""]],
	},
	{
		// The mirror-image defect: the patch ships, but the runtime dependency
		// it needs is never declared. On the author's machine `ssh2` resolves
		// only because another installed plugin happens to hoist it, so the
		// omission is invisible until a fresh profile tries to load the Host.
		name: "M61 manifest: require ssh2 without declaring it",
		target: "manifest",
		edits: [['  "dependencies": {\n    "ssh2": "^1.17.0",\n    "ws": "^8.18.0"\n  },', '  "dependencies": {\n    "ws": "^8.18.0"\n  },']],
	},
	{
		// The exact defect this change removed: the audit row keeps a permanent
		// plaintext copy of whatever the model was asked to run. `mysql -p…` and
		// `curl -H 'Authorization: …'` are ordinary commands here, so "record the
		// value" means "record a credential" — which the module's own HARD RULE
		// forbids. The assertion matches on a password-shaped token, so it fails
		// on the leak itself rather than on a field name.
		name: "M62 monitor: write the exec command body back into the audit log",
		target: "monitor",
		edits: [
			['audit("device.exec", { deviceId: id, deviceName: device.name, commandLength: commandText.length });',
				'audit("device.exec", { deviceId: id, deviceName: device.name, command: commandText });'],
		],
	},
	{
		// The other direction: no row at all. An audit trail that records nothing
		// cannot be distinguished from one that recorded something harmless, so
		// the suite asserts the row EXISTS before it asserts what is in it.
		name: "M63 monitor: run the command without auditing it at all",
		target: "monitor",
		edits: [
			['audit("device.exec", { deviceId: id, deviceName: device.name, commandLength: commandText.length });\n', ""],
		],
	},
	{
		// The device filter is applied AFTER reading, so reading only `limit`
		// rows searches just the newest handful. A device that goes offline every
		// night would report an empty history the moment the log carried more
		// recent traffic than the caller asked for.
		name: "M64 tools: truncate the history before filtering by device",
		target: "tools",
		edits: [
			["\t\t\tconst incidents = kind === \"audit\" ? [] : readIncidents(MAX_HISTORY_SCAN);\n\t\t\tconst audits = kind === \"incidents\" ? [] : readAudit(MAX_HISTORY_SCAN);",
				"\t\t\tconst incidents = kind === \"audit\" ? [] : readIncidents(limit);\n\t\t\tconst audits = kind === \"incidents\" ? [] : readAudit(limit);"],
		],
	},
	{
		// Dropping the filter puts every device's crashes under one device's name,
		// which is worse than returning nothing: it is a confident wrong answer.
		name: "M65 tools: report the whole fleet's history as one device's",
		target: "tools",
		edits: [
			['const keep = (row) => args.id === undefined || row?.deviceId === args.id;',
				'const keep = (row) => true;'],
		],
	},
	{
		// Two logs concatenated are not a timeline. Without the sort, incidents
		// always precede audits regardless of when they happened, so "what
		// happened last" silently answers with the wrong era.
		name: "M66 tools: merge the two logs without sorting them",
		target: "tools",
		edits: [
			['\t\t\trows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));\n', ""],
		],
	},
	{
		// The `kind` filter exists so a caller asking about stability is not
		// handed settings changes, and vice versa.
		name: "M67 tools: ignore the kind filter",
		target: "tools",
		edits: [
			['const kind = args.kind === "incidents" || args.kind === "audit" ? args.kind : "all";',
				'const kind = "all";'],
		],
	},
	{
		// The ghost field, mutation #1: the tags are still in the device object
		// and still in the form, and are simply not drawn. That is precisely the
		// shape of the reported defect, so this mutant is the regression test.
		name: "M68 card: accept the tags and draw none of them",
		target: "client",
		edits: [
			['\t\t\t\t\t\ttags.length === 0\n\t\t\t\t\t\t\t? null\n\t\t\t\t\t\t\t: h("div", { className: "ddm-tags" }, tags.map((tag) => h("span", { className: "ddm-tag", key: tag, "data-dsh-card-tag": tag }, tag))),\n', ""],
		],
	},
	{
		// The same defect one screen further in. The detail view is where a long
		// note actually fits, so losing it there defeats the note field's purpose.
		name: "M69 detail: stop drawing the recorded location",
		target: "client",
		edits: [
			['\t\t\t\t\t\tlocation === "" ? null : h("span", { className: "ddm-kv-key" }, t("card.location")),\n\t\t\t\t\t\tlocation === "" ? null : h("span", { "data-dsh-detail-location": location }, location),\n', ""],
		],
	},
	{
		// The other failure mode of the same field: render the ROW even when the
		// value is absent. An empty "位置" row claims the user recorded a location
		// and it is blank, which is a different statement from "not recorded" —
		// the same rule the metric strip follows for a never-collected metric.
		//
		// TWO edits, because one is not enough: the outer guard suppresses the
		// whole container for a device with neither field, so dropping only the
		// inner guard would produce a mutant that is byte-different and
		// behaviourally identical — the exact shape of a mutant that survives for
		// no reason. Both guards have to go for a row to appear.
		name: "M70 card: draw an empty note row for a device with nothing recorded",
		target: "client",
		edits: [
			['\t\t\t\t\tlocation === "" && description === ""\n\t\t\t\t\t? null\n',
				'\t\t\t\t\tfalse\n\t\t\t\t\t? null\n'],
			['location === "" ? null : h("div", { className: "ddm-note" }, h("span", { className: "ddm-note-key" }, t("card.location")), location),',
				'h("div", { className: "ddm-note" }, h("span", { className: "ddm-note-key" }, t("card.location")), location),'],
		],
	},
	{
		// m11685. The dial seam covers only HALF the dials. `testDraft` went
		// through `this.connect` and `execOn` went through the imported `connect`,
		// so a substitute supplied to keep a harness off the network was silently
		// bypassed and a real socket was opened. The seam was added for exactly
		// that purpose, so "exists but is not used here" is the defect.
		//
		// Note what makes this observable: the suite counts CALLS on the
		// substitute. A substitute that is never called looks identical to no
		// substitute at all, which is why the assertion is a counter and not a
		// check that `this.connect` appears somewhere in the file.
		name: "M71 monitor: dial the exec route around the injected connect",
		target: "monitor",
		edits: [
			['conn = await this.connect(device);\n\t\t\tconst result = await exec(conn, command, timeoutMs);',
				'conn = await connect(device);\n\t\t\tconst result = await exec(conn, command, timeoutMs);'],
		],
	},
	{
		// m11801. The shipped-file roster must come from the REQUIREMENT, not
		// from the manifest. The first version read `files[]` to decide what to
		// verify, so deleting an entry deleted its own check — removing LICENSE
		// left the guard green, which is exactly the self-referential shape the
		// assertion was supposed to prevent.
		//
		// This mutant removes a file from the expected roster. It must be caught
		// by the declaration check, independent of what `files[]` says.
		name: "M72 pack-dist: stop expecting LICENSE to ship",
		target: "packdist",
		edits: [['\t"LICENSE",\n\t"SECURITY.md",\n', '\t"SECURITY.md",\n']],
	},
	{
		// The mirror image: the roster is right, but the manifest lost the file.
		// Distinct from M60 (which drops the PATCH) because this one exercises
		// the declaration half of the guard for a non-patch entry, where a
		// missing file costs documentation rather than a non-loadable bundle —
		// and therefore nothing else in the suite would notice.
		//
		// The edit swallows the PRECEDING COMMA as well as the entry. Removing
		// the last array element on its own leaves a trailing comma and the
		// manifest stops parsing, so the suite died in `JSON.parse` before it
		// read a single assertion — a CAUGHT-CRASH, which is not a covered
		// mutant. The mutant has to reach the assertion it is aimed at.
		name: "M73 pack-dist: ship a build whose files[] omits SECURITY.md",
		target: "manifest",
		edits: [[',\n    "SECURITY.md"', '']],
	},
];

const [, , action, arg] = process.argv;

const pristineOf = (mutation) => TARGETS[mutation.target].pristine;

if (action === "list") {
	MUTATIONS.forEach((m, i) => console.log(`${i}\t[${m.target}]\t${m.name}`));
	process.exit(0);
}

if (action === "check") {
	// Prove every anchor is present BEFORE mutating anything, so a stale anchor is
	// reported as a broken test rather than as an uncaught defect.
	let bad = 0;
	MUTATIONS.forEach((m, i) => {
		const source = readFileSync(pristineOf(m), "utf8");
		for (const [from] of m.edits) {
			if (!source.includes(from)) {
				console.log(`MISSING ${i} :: ${m.name}`);
				bad += 1;
			}
		}
	});
	console.log(bad === 0 ? `ALL ${MUTATIONS.length} ANCHORS PRESENT` : `${bad} ANCHOR(S) MISSING`);
	process.exit(bad === 0 ? 0 : 2);
}

if (action === "apply") {
	const index = Number(arg);
	const mutation = MUTATIONS[index];
	if (mutation === undefined) throw new Error("no such mutation: " + arg);
	const { file } = TARGETS[mutation.target];
	copyFileSync(pristineOf(mutation), file + ".mutation.bak");
	let source = readFileSync(pristineOf(mutation), "utf8");
	let applied = 0;
	for (const [from, to] of mutation.edits) {
		if (!source.includes(from)) {
			console.log(`ANCHOR-MISSING ${index} ${mutation.name}`);
			process.exit(2);
		}
		source = source.replace(from, to);
		applied += 1;
	}
	writeFileSync(file, source);
	console.log(`APPLIED ${index} edits=${applied} :: ${mutation.name}`);
	process.exit(0);
}

if (action === "restore") {
	// Every target, unconditionally: a per-mutation restore would leave the other
	// file mutated if a run died between apply and restore.
	for (const { file, pristine } of Object.values(TARGETS)) {
		copyFileSync(pristine, file);
		const bak = file + ".mutation.bak";
		if (existsSync(bak)) unlinkSync(bak);
	}
	console.log("RESTORED every target from pristine");
	process.exit(0);
}

throw new Error("usage: apply-mutation.mjs list|check|apply <n>|restore");
