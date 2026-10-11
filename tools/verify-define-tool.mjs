/**
 * Verify src/tools.js against the REAL `@deepseek-ai/dsh-tools` `defineTool`.
 *
 * `tools/smoke.mjs` uses a faithful shim so it can run on plain Node. This
 * script removes the shim: it imports the actual `defineTool` out of the
 * packaged runtime and mounts the plugin's tools through it, which is the only
 * way to prove the render contract end to end without the GUI.
 *
 * Run with the Electron binary in Node mode (it can read inside app.asar):
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals verify-define-tool.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

// The plugin root and the packaged runtime, resolved from this checkout rather
// than hardcoded — so a clone anywhere can run these suites.
const PLUGIN = ROOT_URL;

const scratch = mkdtempSync(join(tmpdir(), "ddm-verify-"));
process.env.DSH_HOME = scratch;

const root = ASAR_TOOLS_URL;
const { defineTool } = await import(root);
console.log("defineTool loaded from the packaged runtime:", typeof defineTool);

const { DeviceStore } = await import(`${PLUGIN}/src/store.js`);
const { MetricsStore } = await import(`${PLUGIN}/src/metrics.js`);
const { Monitor } = await import(`${PLUGIN}/src/monitor.js`);
const { makeTools } = await import(`${PLUGIN}/src/tools.js`);

const store = new DeviceStore();
const metrics = new MetricsStore();
const tools = makeTools(defineTool, store, metrics ? new Monitor(store, metrics) : undefined, metrics);
console.log("tools defined:", tools.map((tool) => tool.name).join(", "));

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};

// Every tool must survive the real wrapper calling `render`.
for (const tool of tools) {
	check(`${tool.name} exposes a callable render`, typeof tool.output.render === "function");
	check(`${tool.name} was wrapped by the real defineTool`, tool.output.schema !== undefined && typeof tool.execute === "function");
}

const byName = new Map(tools.map((tool) => [tool.name, tool]));

// The exact call that failed in the GUI: device_list with no devices.
const listValue = await byName.get("device_list").execute({});
const listBlocks = byName.get("device_list").output.render({}, listValue);
check("device_list renders through the real wrapper", Array.isArray(listBlocks) && listBlocks[0]?.type === "text",
	JSON.stringify(listBlocks));
check("device_list renders readable text", typeof listBlocks[0]?.text === "string" && listBlocks[0].text.length > 0,
	String(listBlocks[0]?.text));

// A populated roster plus a recorded sample, so the other three render too.
const device = store.create({ name: "Verify 01", host: "10.0.0.7", username: "root", password: "pw" });
const statusValue = await byName.get("device_status").execute({ id: device.id });
const statusBlocks = byName.get("device_status").output.render({}, statusValue);
check("device_status renders through the real wrapper", Array.isArray(statusBlocks) && statusBlocks[0]?.type === "text",
	JSON.stringify(statusBlocks));

const execValue = await byName.get("device_exec").execute({ id: device.id, command: "true", timeoutMs: 1200 });
const execBlocks = byName.get("device_exec").output.render({}, execValue);
check("device_exec renders through the real wrapper", Array.isArray(execBlocks) && execBlocks[0]?.type === "text",
	JSON.stringify(execBlocks));
check("device_exec renders the exit-code line", execBlocks[0].text.includes("[exit code:"), execBlocks[0].text);

const collectValue = await byName.get("device_collect").execute({ id: device.id });
const collectBlocks = byName.get("device_collect").output.render({}, collectValue);
check("device_collect renders through the real wrapper", Array.isArray(collectBlocks) && collectBlocks[0]?.type === "text",
	JSON.stringify(collectBlocks));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} against the real defineTool`);
if (failures > 0) process.exit(1);
