/**
 * Boot-level proof for the HOST half, in a fresh process.
 *
 * The running Harness holds the host half in Node's ESM cache: `dsh-hmr`
 * excludes `/node_modules/` and its module roots are empty, so editing
 * `index.js` on disk cannot reach the already-loaded instance. This script
 * reproduces what the host will do on its NEXT boot — it imports the plugin's
 * real entry, mounts it against a mock cordis context, and drives every
 * registered tool's `render` exactly as the tool runner does.
 *
 * Unlike `verify-define-tool.mjs` (which calls `makeTools` directly), this goes
 * through `apply()`, so it also proves the ENTRY wires the tools up.
 *
 * Run with the Electron binary in Node mode (it can read inside app.asar):
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals tools/verify-host-boot.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { at, url, ROOT_URL, ASAR_TOOLS_URL } from "./paths.mjs";

const scratch = mkdtempSync(join(tmpdir(), "ddm-boot-"));
process.env.DSH_HOME = scratch;
process.env.DSH_PROFILE = "bootcheck";
process.env.DSH_PROFILE_DIR = join(scratch, "profiles", "bootcheck");

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};

const ASAR_TOOLS = ASAR_TOOLS_URL;
const PLUGIN = ROOT_URL;

/**
 * The plugin resolves `@deepseek-ai/dsh-tools` from the profile roots, which a
 * scratch home does not have. Provide a re-export stub so the host half gets
 * the REAL packaged `defineTool` — nothing else about the run is substituted.
 */
const stubDir = join(process.env.DSH_PROFILE_DIR, "node_modules", "@deepseek-ai", "dsh-tools");
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-tools", version: "0.0.0", type: "module", main: "index.mjs", exports: { ".": "./index.mjs" } }, null, 2));
writeFileSync(join(stubDir, "index.mjs"), `export * from "${ASAR_TOOLS}";\nexport { default } from "${ASAR_TOOLS}";\n`);

// Sanity: the stub must actually carry the real implementation.
const { defineTool } = await import(`file:///${join(stubDir, "index.mjs").replace(/\\/g, "/")}`);
check("the resolver stub re-exports the real defineTool", typeof defineTool === "function");

// Mount the plugin's real host half the way the loader does.
const plugin = await import(`${PLUGIN}/index.js`);
check("the host half exports apply", typeof plugin.apply === "function");
check("the host half declares an inject list", Array.isArray(plugin.inject));

const registeredTools = [];
const routes = [];
const sections = [];
const listeners = [];
const effects = [];

const ctx = {
	effect(fn) { effects.push(fn()); return () => {}; },
	on(event, handler) { listeners.push({ event, handler }); return () => {}; },
	webServer: { register(row) { routes.push(row); return () => {}; } },
	tools: { register(tool) { registeredTools.push(tool); return () => {}; } },
	systemPrompt: { section(row) { sections.push(row); return () => {}; } },
	logger: { info() {}, warn(message) { console.log("  [host warn]", message); }, error(message) { console.log("  [host error]", message); } },
};

plugin.apply(ctx, undefined);
// Tool registration happens inside a promise chain started by ctx.effect.
await new Promise((resolve) => setTimeout(resolve, 200));

check("the host half mounted a row per tool", registeredTools.length === 5, `${registeredTools.length} tools: ${registeredTools.map((tool) => tool.name).join(", ")}`);
/*
 * Assert the exact route SET, not a bare count.
 *
 * A count is the weakest possible form of this assertion: adding a route makes
 * it red for no reason (which is what happened when the terminal-status route
 * landed — this said `=== 14` and the plugin had 15), while REPLACING a route
 * keeps it green while silently dropping one. The set pins both directions.
 */
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
const mountedPaths = routes.map((row) => row.path).sort();
const missingRoutes = EXPECTED_ROUTES.filter((path) => !mountedPaths.includes(path));
const extraRoutes = mountedPaths.filter((path) => !EXPECTED_ROUTES.includes(path));
check(
	"the host half mounted exactly its routes",
	missingRoutes.length === 0 && extraRoutes.length === 0,
	`missing: ${missingRoutes.join(", ") || "none"}; unexpected: ${extraRoutes.join(", ") || "none"}`,
);
check("the host half published its prompt section", sections.length === 1);
check("the host half subscribed to volatile updates", listeners.some((row) => row.event === "loader/volatile-update"));

console.log("\n== every registered tool renders through the wrapper defineTool installed ==");
const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
for (const name of ["device_list", "device_status", "device_collect", "device_exec", "device_history"]) {
	const tool = byName.get(name);
	if (tool === undefined) { check(`${name} is registered`, false); continue; }
	check(`${name} exposes a callable render`, typeof tool.output?.render === "function");

	// `device_exec` requires a command; the others take an optional id.
	const args = name === "device_collect" ? {} : name === "device_exec" ? { id: "no-such-device", command: "true" } : { id: "no-such-device" };
	let value;
	try {
		value = await tool.execute(args);
	} catch (error) {
		check(`${name} executes`, false, String(error?.message ?? error));
		continue;
	}
	let blocks;
	try {
		blocks = tool.output.render(args, value);
	} catch (error) {
		// This is the precise historical failure: userRender is not a function.
		check(`${name} renders without throwing`, false, `${error?.message ?? error}`);
		continue;
	}
	check(`${name} renders without throwing`, true);
	check(`${name} returns a text block`, Array.isArray(blocks) && blocks[0]?.type === "text" && typeof blocks[0]?.text === "string",
		JSON.stringify(blocks)?.slice(0, 120));
}

// The reported call: device_list on an empty roster.
const emptyValue = await byName.get("device_list").execute({});
const emptyText = byName.get("device_list").output.render({}, emptyValue)[0].text;
check("device_list names the sidebar panel when the roster is empty", emptyText.includes("设备"), emptyText.slice(0, 120));

// And a populated roster, to be sure the table path renders too.
const { DeviceStore } = await import(`${PLUGIN}/src/store.js`);
new DeviceStore().create({ name: "Boot 01", host: "10.0.0.9", username: "root", password: "pw" });
const populatedValue = await byName.get("device_list").execute({});
const populatedText = byName.get("device_list").output.render({}, populatedValue)[0].text;
check("device_list renders the populated roster", populatedText.includes("Boot 01"), populatedText.slice(0, 200));
check("device_list renders a markdown table header", populatedText.includes("|"), populatedText.slice(0, 200));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — the host half boots and renders in a fresh process`);
if (failures > 0) process.exit(1);
