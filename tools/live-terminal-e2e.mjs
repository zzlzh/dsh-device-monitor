// Live terminal check: dial the REAL upgrade route and drive ONE real shell.
//
// Every other terminal assertion runs against a stubbed `openShell`, so until
// this script exists nobody has ever proved that the socket the browser is
// pointed at is the socket the Host actually serves. The two are registered by
// different calls (`registerUpgrade` vs `register`), and pointing the client at
// the wrong one fails only at runtime, only for the user who clicks 终端调试.
//
// It is deliberately narrow: open, prove the frames arrive, run one read-only
// command, close. It does not type anything destructive, and it never enables
// the terminal itself — if the gate is off it reports that and exits 0, because
// "the user has not turned this on" is not a defect.
//
//   node tools\live-terminal-e2e.mjs [deviceId]

import { createRequire } from "node:module";
import { dshHomePosix } from "./paths.mjs";

const BASE = process.env.DDM_URL ?? "http://127.0.0.1:19387";
const API = `${BASE}/api/dsh-device-monitor`;
const require_ = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
	if (cond) {
		pass += 1;
		console.log(`  ok   ${label}`);
	} else {
		fail += 1;
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	}
};
const eq = (label, got, want) => ok(label, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const getJson = async (path) => {
	const res = await fetch(API + path);
	return { status: res.status, body: await res.json().catch(() => null) };
};

// `ws` lives in the profile's node_modules, which is how the Host itself loads
// it (`softImport("ws")` in src\terminal-route.js). Resolve it the same way.
const loadWs = async () => {
	for (const spec of ["ws", dshHomePosix() + "/profiles/desktop/node_modules/ws/index.js"]) {
		try {
			const mod = await import(spec.startsWith("C:") ? new URL("file:///" + spec) : spec);
			return mod.default ?? mod.WebSocket ?? mod;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
};

const status = await getJson("/terminal/status");
console.log(`\n== live terminal at ${API} ==`);
eq("terminal/status is served", status.status, 200);
ok("the socket path is reported", typeof status.body?.path === "string", String(status.body?.path));

if (status.body?.enabled !== true) {
	console.log(`\nSKIP — the terminal is switched off in settings (enabled=${JSON.stringify(status.body?.enabled)}).`);
	console.log("       That is the shipped default, not a failure. Turn it on in 设置 to run this check.");
	process.exit(0);
}

const devices = await getJson("/devices");
const target = process.argv[2] ?? devices.body?.devices?.[0]?.id;
ok("there is a device to open a shell on", typeof target === "string", JSON.stringify(target));
if (typeof target !== "string") process.exit(1);
console.log(`  ..   using device ${target}`);

const WebSocket = await loadWs();
if (WebSocket === null) {
	console.log("\nSKIP — could not resolve the `ws` module from this Node.");
	process.exit(0);
}

// Pull the credential material the frame needs. It is a loopback-only route, so
// this is the same trust boundary the browser sits behind.
// NOTE: the device is NOT passed as a query parameter. The Host reads it from
// the `open` FRAME (src\terminal-route.js:166) and derives the socket id
// server-side exactly so a browser cannot claim another terminal's socket. The
// query string below is deliberately left off; carrying it would suggest a
// trust boundary that does not exist.
const url = new URL(status.body.path, BASE);
url.protocol = "ws:";
const ws = new WebSocket(url.href, { headers: { Origin: BASE } });
const frames = [];
let out = "";
let ready = null;
let closed = false;

const done = new Promise((resolve) => {
	const finish = () => resolve();
	ws.on("message", (buf) => {
		let frame;
		try {
			frame = JSON.parse(String(buf));
		} catch {
			frames.push({ t: "<unparsable>" });
			return;
		}
		frames.push(frame);
		if (frame.t === "ready") {
			ready = frame;
			// One read-only command. `\r` not `\n` — a shell only runs the line
			// when it sees a carriage return; this is M19's whole subject.
			ws.send(JSON.stringify({ t: "in", data: "echo DDM-ALIVE-$$\r" }));
			setTimeout(() => {
				ws.send(JSON.stringify({ t: "close" }));
				setTimeout(finish, 400);
			}, 2500);
		}
		if (frame.t === "out") out += Buffer.from(frame.data, "base64").toString("utf8");
		if (frame.t === "error") setTimeout(finish, 50);
	});
	ws.on("error", (err) => {
		frames.push({ t: "<socket error>", message: String(err?.message ?? err) });
		finish();
	});
	ws.on("close", () => {
		closed = true;
		finish();
	});
	setTimeout(() => {
		try {
			ws.close();
		} catch {
			/* already gone */
		}
		finish();
	}, 15_000);
});

try {
	ws.on("open", () => {
		ws.send(JSON.stringify({ t: "open", deviceId: target, cols: 80, rows: 24, by: "live-terminal-e2e" }));
	});
} catch {
	/* the error handler above reports it */
}

await done;
try {
	ws.close();
} catch {
	/* already closed */
}

console.log("\n== frames ==");
ok("the socket opened and answered", frames.length > 0, `${frames.length} frames`);
ok("a ready frame arrived", ready !== null, frames.map((f) => f.t).join(","));
if (ready !== null) {
	eq("the per-device session cap is reported", ready.limits?.maxPerDevice, 3);
	eq("the total session cap is reported", ready.limits?.maxTotal, 10);
	// `session` is an OBJECT, not a bare id — the frame carries the identity the
	// Host derived server-side (deviceId/host/from), which is what makes
	// `socketIdOf` un-spoofable from the browser.
	ok("the session was given an id", typeof ready.session?.id === "string" && ready.session.id !== "", JSON.stringify(ready.session));
	eq("the session was pinned to the device we asked for", ready.session?.deviceId, target);
}
ok("no error frame was sent", !frames.some((f) => f.t === "error"), JSON.stringify(frames.find((f) => f.t === "error")));
ok("the real shell echoed our marker", /DDM-ALIVE-\d+/.test(out), JSON.stringify(out.slice(-200)));
ok("output arrived base64-decoded, not as raw bytes", typeof out === "string" && out.length > 0, `${out.length} chars`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass}/${pass + fail} checks`);
console.log(`       device=${target} frames=${frames.map((f) => f.t).join(",")} closed=${closed}`);
process.exit(fail === 0 ? 0 : 1);
