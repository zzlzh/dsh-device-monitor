/**
 * Activation smoke test: mount the real Host half against a mock cordis
 * context and exercise the surfaces it registers.
 *
 * `smoke.mjs` tests the modules; this tests `index.js` itself — the export
 * shape, the `inject` contract, `ctx.effect` cleanup, the volatile-update
 * re-sync, and that the registered route table is what the HTTP driver
 * expects. It mirrors `applyImpl` in the installed `@linxin666/dsh-ssh` host
 * half so a shape mistake here is caught before installation.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { at, ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

// The plugin root and the packaged runtime, resolved from this checkout rather
// than hardcoded — so a clone anywhere can run these suites.
const PLUGIN = ROOT_URL;

const scratch = mkdtempSync(join(tmpdir(), "ddm-activate-"));
process.env.DSH_HOME = scratch;
process.env.DSH_PROFILE = "activate-smoke";
process.env.DSH_PROFILE_DIR = join(scratch, "profiles", "activate-smoke");

let passed = 0;
const failures = [];
function ok(label, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	}
}
function eq(label, actual, expected) {
	ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A mock service registry recording registrations and disposals. */
function makeRegistry() {
	const items = [];
	return {
		items,
		register(item) {
			items.push(item);
			let live = true;
			return () => {
				if (!live) return;
				live = false;
				const index = items.indexOf(item);
				if (index >= 0) items.splice(index, 1);
			};
		},
	};
}

/** A mock ctx with the services this plugin injects. */
function makeCtx({ upgrades = true } = {}) {
	const webServer = makeRegistry();
	// The upgrade registry is a SEPARATE table from the ordinary route table:
	// `registerUpgrade` takes `{path, handler}` and a WebSocket upgrade never
	// reaches a JSON handler. Keeping it separate is what makes "the terminal
	// route was mounted" a checkable claim instead of a side effect.
	const upgradeItems = [];
	if (upgrades) {
		webServer.registerUpgrade = (item) => {
			upgradeItems.push(item);
			let live = true;
			return () => {
				if (!live) return;
				live = false;
				const index = upgradeItems.indexOf(item);
				if (index >= 0) upgradeItems.splice(index, 1);
			};
		};
	}
	const tools = makeRegistry();
	const sections = [];
	const effects = [];
	const listeners = new Map();
	const warnings = [];
	const ctx = {
		webServer,
		tools,
		systemPrompt: {
			section(options) {
				sections.push(options);
				let live = true;
				return () => {
					if (!live) return;
					live = false;
					const index = sections.indexOf(options);
					if (index >= 0) sections.splice(index, 1);
				};
			},
		},
		logger: { warn: (...args) => warnings.push(args.join(" ")), info() {}, error() {} },
		on(event, handler) {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
			return () => {
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		effect(setup, label) {
			const dispose = setup();
			const record = { dispose, label };
			effects.push(record);
			let live = true;
			return () => {
				if (!live) return;
				live = false;
				const index = effects.indexOf(record);
				if (index >= 0) effects.splice(index, 1);
				if (typeof dispose === "function") dispose();
			};
		},
		/** Test helper: fire a lifecycle event. */
		emit(event) {
			for (const handler of [...(listeners.get(event) ?? [])]) handler();
		},
	};
	return { ctx, webServer, upgradeItems, tools, sections, effects, listeners, warnings };
}

console.log("== module contract ==");
const mod = await import(`${PLUGIN}/index.js`);
eq("the plugin declares a stable name", mod.name, "device-monitor");
ok("apply is a function", typeof mod.apply === "function");
ok("inject names the three services apply touches", Array.isArray(mod.inject)
	&& mod.inject.includes("webServer") && mod.inject.includes("tools") && mod.inject.includes("systemPrompt"),
	JSON.stringify(mod.inject));
eq("the device cap is exported", mod.MAX_DEVICES, 10);
ok("the store path lives under DSH_HOME", mod.storePath().startsWith(scratch), mod.storePath());
ok("no Config export, because nothing is editable", mod.Config === undefined);
ok("the apply export is not a default-export service class", mod.default === undefined);

console.log("\n== mount ==");
const harness = makeCtx();
let mountError;
try {
	mod.apply(harness.ctx, undefined);
} catch (error) {
	mountError = error;
}
ok("apply returns without throwing", mountError === undefined, mountError?.stack ?? "");
eq("fifteen routes were registered", harness.webServer.items.length, 15);
ok("every registered route uses the exact kind", harness.webServer.items.every((row) => row.kind === "exact"),
	JSON.stringify(harness.webServer.items.map((row) => row.kind)));
ok("every registered route carries a handler", harness.webServer.items.every((row) => typeof row.handler === "function"));
ok("every registered route is namespaced", harness.webServer.items.every((row) => row.path.startsWith("/api/dsh-device-monitor/")),
	JSON.stringify(harness.webServer.items.map((row) => row.path)));
// The terminal's socket lives in the UPGRADE table, not the route table. If it
// were asserted only by counting routes, a terminal that never mounted at all
// would still pass — the count would simply be one lower and nobody would say
// which route was missing.
eq("one WS upgrade route was registered", harness.upgradeItems.length, 1);
eq("the upgrade route is the terminal socket", harness.upgradeItems[0]?.path, "/api/dsh-device-monitor/terminal");
ok("the upgrade route carries a handler", typeof harness.upgradeItems[0]?.handler === "function");
ok("the upgrade route is NOT in the ordinary route table",
	!harness.webServer.items.some((row) => row.path === "/api/dsh-device-monitor/terminal"),
	"an upgrade request never reaches a JSON handler, so a route entry would be dead");
ok("the status route IS in the ordinary route table",
	harness.webServer.items.some((row) => row.path === "/api/dsh-device-monitor/terminal/status"),
	"the panel has to be able to ask whether the terminal is available");
eq("one system-prompt section was mounted", harness.sections.length, 1);
// The section name is the plugin's namespace, NOT a path. It is asserted
// literally because the Host keys sections by this string.
eq("the section carries the plugin namespace", harness.sections[0]?.name, "plugin:dsh-device-monitor");
eq("the section order is the declared one", harness.sections[0]?.order, mod.SECTION_ORDER);
ok("the guidance is non-empty prose", typeof harness.sections[0]?.text === "string" && harness.sections[0].text.length > 100);
ok("the guidance states the 10-device cap", harness.sections[0].text.includes("10 台设备"));
ok("the guidance names every agent tool", ["device_list", "device_status", "device_collect", "device_exec", "device_history"]
	.every((tool) => harness.sections[0].text.includes(tool)));
// The terminal is reachable only from the panel, so the guidance is the one
// place the model can learn it exists — and the one place it can be told that
// this path bypasses the command allowlist the agent tools obey.
ok("the guidance mentions the panel terminal", harness.sections[0].text.includes("终端调试"));
ok("the guidance warns that the terminal bypasses the allowlist",
	harness.sections[0].text.includes("命令白名单"), "a shell the model can point a user at must carry its own caveat");
// Three: the tool registration, the volatile-update listener, and the terminal
// WS upgrade route (`ctx.webServer.registerUpgrade`). The upgrade route cannot
// live in the ordinary route table because a WebSocket upgrade never reaches a
// JSON handler.
eq("three effects were mounted", harness.effects.length, 3);
eq("the listener for volatile updates is wired", harness.listeners.get("loader/volatile-update")?.length, 1);

console.log("\n== the route table is the documented API ==");
const paths = harness.webServer.items.map((row) => row.path).sort();
for (const suffix of ["overview", "devices", "test", "collect", "metrics", "exec"]) {
	ok(`the ${suffix} route is mounted`, paths.includes(`/api/dsh-device-monitor/${suffix}`), paths.join(", "));
}

console.log("\n== the host route answers over the real http fence ==");
/** Drive one registered route with a synthetic loopback request. */
async function callRoute(path, { method = "GET", body, query = "", loopback = true } = {}) {
	const route = harness.webServer.items.find((row) => row.path === path);
	if (route === undefined) throw new Error(`no route for ${path}`);
	const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
	const req = {
		method,
		url: `${path}${query}`,
		headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" },
		socket: { remoteAddress: loopback ? "127.0.0.1" : "10.1.2.3", remotePort: 51000 },
		[Symbol.asyncIterator]: async function* () {
			for (const chunk of chunks) yield chunk;
		},
	};
	let status = 0;
	let payload = "";
	const res = {
		headersSent: false,
		writeHead(code) {
			status = code;
			this.headersSent = true;
			return this;
		},
		setHeader() {},
		end(text) {
			if (text !== undefined) payload += text;
		},
	};
	await route.handler(req, res);
	let json;
	try {
		json = payload === "" ? undefined : JSON.parse(payload);
	} catch {
		json = undefined;
	}
	return { status, json, payload };
}

const overview = await callRoute("/api/dsh-device-monitor/overview");
eq("the overview route answers 200 on loopback", overview.status, 200);
ok("the overview reports the cap", overview.json?.maxDevices === 10, overview.payload);
ok("the overview starts with an empty roster", Array.isArray(overview.json?.devices) && overview.json.devices.length === 0);

const forbidden = await callRoute("/api/dsh-device-monitor/overview", { loopback: false });
eq("a non-loopback caller is refused", forbidden.status, 403);
eq("the refusal names its reason", forbidden.json?.error, "forbidden: loopback-only");

const created = await callRoute("/api/dsh-device-monitor/devices", {
	method: "POST",
	body: { name: "Activate 01", host: "10.0.0.9", username: "root", password: "s3cret" },
});
eq("a device can be created through the mounted route", created.status, 201, created.payload);
ok("the created device is summarised", created.json?.device?.name === "Activate 01", created.payload);
ok("the summary never carries the password", created.payload.includes("s3cret") === false, created.payload);
ok("the summary flags the stored password", created.json?.device?.hasPassword === true, created.payload);
ok("the store file was written under DSH_HOME", mod.storePath().startsWith(scratch));
eq("the created device is listed", (await callRoute("/api/dsh-device-monitor/overview")).json?.devices?.length, 1);

console.log("\n== volatile re-sync replaces, never stacks ==");
const beforeRoutes = harness.webServer.items.length;
harness.ctx.emit("loader/volatile-update");
eq("a re-sync keeps the route count stable", harness.webServer.items.length, beforeRoutes);
eq("a re-sync keeps one section", harness.sections.length, 1);
eq("a re-sync keeps the roster", (await callRoute("/api/dsh-device-monitor/overview")).json?.devices?.length, 1);

console.log("\n== disabling the plugin withdraws every surface ==");
// `sync()` re-reads the config and tears the surfaces down first, so a plugin
// disabled through its config must leave the registries empty. This is the
// path the Loader takes when a user switches the row off.
const offHarness = makeCtx();
mod.apply(offHarness.ctx, { enabled: false });
eq("a disabled plugin registers no routes", offHarness.webServer.items.length, 0);
eq("a disabled plugin mounts no section", offHarness.sections.length, 0);

// The Loader does not remount to apply an edited setting: it commits the new
// value into the volatile field's reference and announces the update. Follow
// that exact mechanism — a `get()` ref that flips to false — so this asserts
// the same path a user's switch takes.
const liveHarness = makeCtx();
let enabled = true;
let announce = true;
mod.apply(liveHarness.ctx, {
	enabled: { get: () => enabled },
	announceToAgent: { get: () => announce },
});
eq("the enabled instance mounts its routes", liveHarness.webServer.items.length, 15);
eq("the enabled instance mounts its section", liveHarness.sections.length, 1);

announce = false;
liveHarness.ctx.emit("loader/volatile-update");
eq("silencing the announcement keeps the routes", liveHarness.webServer.items.length, 15);
eq("silencing the announcement removes the section", liveHarness.sections.length, 0);

announce = true;
liveHarness.ctx.emit("loader/volatile-update");
eq("re-enabling the announcement restores one section", liveHarness.sections.length, 1);

enabled = false;
liveHarness.ctx.emit("loader/volatile-update");
eq("disabling through the volatile field withdraws the routes", liveHarness.webServer.items.length, 0);
eq("disabling through the volatile field withdraws the section", liveHarness.sections.length, 0);
// A disabled plugin must not leave a live shell socket behind: the upgrade
// route is part of the surface the switch withdraws, not an extra that only
// gets torn down at process exit.
eq("disabling through the volatile field withdraws the terminal socket", liveHarness.upgradeItems.length, 0);

enabled = true;
liveHarness.ctx.emit("loader/volatile-update");
eq("re-enabling restores exactly fifteen routes, not thirty", liveHarness.webServer.items.length, 15);
eq("re-enabling restores exactly one section", liveHarness.sections.length, 1);
eq("re-enabling restores exactly one terminal socket", liveHarness.upgradeItems.length, 1);
ok("the restored terminal socket is on the same path",
	liveHarness.upgradeItems[0]?.path === "/api/dsh-device-monitor/terminal",
	String(liveHarness.upgradeItems[0]?.path));

// Disposing the effects the enabled instance mounted must empty the shared
// registries it registered into.
for (const effect of [...harness.effects]) effect.dispose();
eq("disposing the effects withdraws the routes", harness.webServer.items.length, 0);
eq("disposing the effects withdraws the terminal socket", harness.upgradeItems.length, 0);

console.log("\n== an older Host without an upgrade registry ==");
// `registerUpgrade` is newer than the rest of the host API. The plugin must
// degrade instead of throwing: every other feature has to keep working, and the
// reason the terminal is gone has to be said out loud rather than swallowed.
const oldHarness = makeCtx({ upgrades: false });
let oldError;
try {
	mod.apply(oldHarness.ctx, undefined);
} catch (error) {
	oldError = error;
}
ok("apply survives a Host with no upgrade registry", oldError === undefined, oldError?.stack ?? "");
eq("the ordinary routes still mount", oldHarness.webServer.items.length, 15);
eq("the section still mounts", oldHarness.sections.length, 1);
ok("the degradation is announced, not swallowed",
	oldHarness.warnings.some((line) => line.includes("registerUpgrade")),
	JSON.stringify(oldHarness.warnings));
for (const effect of [...oldHarness.effects]) effect.dispose();
eq("the degraded instance still disposes cleanly", oldHarness.webServer.items.length, 0);

console.log("\n== the roster survives a disabled plugin ==");
const { DeviceStore } = await import(`${PLUGIN}/src/store.js`);
const reopened = new DeviceStore();
const storedDevice = reopened.list()[0];
eq("the persisted roster keeps the device", storedDevice?.name, "Activate 01");
eq("the persisted roster keeps the credential kind", storedDevice?.auth?.kind, "password");
const storeMode = (await import("node:fs")).statSync(mod.storePath()).mode % 0o1000;
if (process.platform === "win32") {
	// Windows has no POSIX mode bits: writeFileSync({mode}) and even chmodSync
	// report the emulated 0o666 default for every file. The store still passes
	// `mode: 0o600` when it creates the file, which is what takes effect on a
	// POSIX host, so only the assertion is platform-conditional.
	eq("Windows reports the emulated default mode", storeMode, 0o666);
	ok("the store requests 0600 for the file it creates", (await import("node:fs")).readFileSync(at("src/store.js"), "utf8")
		.includes("mode: 0o600"));
} else {
	eq("the store file is mode 0600", storeMode, 0o600);
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"} — ${passed}/${passed + failures.length} checks`);
if (failures.length > 0) {
	for (const label of failures) console.log(`  - ${label}`);
	process.exit(1);
}
