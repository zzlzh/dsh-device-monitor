/**
 * End-to-end check of the blank-password fix, against the REAL device roster
 * and a real ssh2 dial. Calls Monitor#testDraft with the exact payload an edit
 * form produces (password box left blank) and requires ok:true.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../src/store.js";
import { Monitor } from "../src/monitor.js";
import { MetricsStore } from "../src/metrics.js";

const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const doc = JSON.parse(readFileSync(join(home, "dsh-device-monitor.json"), "utf8"));
const stored = doc.devices.find((row) => row.id === (process.argv[2] ?? "nas-b"));
if (stored === undefined) throw new Error("no such device");

const store = new DeviceStore(join(home, "dsh-device-monitor.json"));
const mon = new Monitor(store, new MetricsStore());

async function probe(label, payload) {
  const result = await mon.testDraft(payload).then(
    (value) => (value.ok === true ? "OK" : `FAILED :: ${value.error}`),
    (error) => `THREW :: ${error?.message}`,
  );
  console.log(`${label.padEnd(46)} ${result}`);
  return result === "OK";
}

const base = { name: stored.name, host: stored.host, port: stored.port, username: stored.username };

// 1. The edit form's real payload after the fix: id present, password blank.
const okEdit = await probe("edit form (id + blank password)", { ...base, id: stored.id, auth: { kind: "password" } });
// 2. Without the id the Host falls back to the identity match — must still work.
const okFallback = await probe("no id (identity fallback)", { ...base, auth: { kind: "password" } });
// 3. A typed password must still win.
const okTyped = await probe("typed password wins", { ...base, id: stored.id, auth: { kind: "password", password: "definitely-wrong" } });
// 4. A brand-new device with no stored match must NOT be silently rescued.
const okUnknown = await probe("unknown host stays unfilled (must FAIL)", { ...base, host: "10.255.255.1", id: "nope", auth: { kind: "password" } });

console.log("");
console.log(`edit form fixed        : ${okEdit}`);
console.log(`id-less fallback works : ${okFallback}`);
console.log(`a wrong password fails : ${!okTyped}`);
console.log(`an unknown host fails  : ${!okUnknown}`);
const good = okEdit && okFallback && !okTyped && !okUnknown;
console.log(good ? "VERDICT: FIXED" : "VERDICT: STILL BROKEN");
process.exit(good ? 0 : 1);
