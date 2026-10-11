// The WebSocket upgrade probe: what the Host answers for a given handshake.
//
// This is the control that diagnosed m07341. The user's browser showed
// 「无法建立终端连接」+「code 1006」 while every probe here got `101`, and the
// refusal path wrote nothing to the audit — so the failing shape could not be
// found from the server side at all. The value of this file is that it varies
// ONE header at a time against the real listener, which is the only way to tell
// which input the fence is actually keying on.
//
// What it established (all measured, not assumed):
//
//   * every LOOPBACK shape gets `101` — `127.0.0.1`, `localhost`, with or
//     without the port, `http`/`https`, any Sec-Fetch-Site except cross-site,
//     and a full Chrome handshake including permessage-deflate.
//   * a NON-loopback Host header gets `403` (`Host: <lan-ip>`), and so does
//     every non-http custom scheme the fence does not know about: `file://`,
//     `null`, `app://desktop`, `dsh://local`, `chrome-extension://`.
//   * `Sec-Fetch-Site: cross-site` gets `403` by design.
//   * an UNREGISTERED upgrade path does not answer at all — the socket is
//     destroyed with zero bytes. That is not a 404: `registerUpgrade` matches
//     the exact pathname only, and a miss calls `socket.destroy()`.
//
// So a 403, a destroyed socket, and a request that never left the browser are
// three different things — and for m07341 the third was the answer. The real
// cause was on the CLIENT side: the desktop shell serves the app page from the
// custom scheme `dsh-app://app/`, so `location.host` is the bare word `app`,
// and the old code built `ws://app/...` — a URL the renderer rejects before
// sending anything. The server therefore saw NOTHING, which is why no row here
// could ever reproduce it.
//
// Two fixes, and this file checks the second one:
//
//   1. `client.js` now builds the socket from
//      `__DSH_TRANSPORT__.streamBaseUrl` (the Host origin the shell publishes),
//      falling back to `document.baseURI`.
//   2. `src/http.js` now accepts the shell's `Origin: dsh-app://app`. That page
//      has a different scheme AND a different host than the Host, so the
//      browser labels the upgrade `Sec-Fetch-Site: cross-site` — the fence must
//      judge the desktop origin BEFORE the cross-site rule, or it refuses its
//      own UI. The rows under "-- the desktop shell --" below pin exactly that.
//
// Usage: node tools\probe-ws.mjs

import net from "node:net";
import crypto from "node:crypto";

const BASE = process.env.DDM_URL ?? "http://127.0.0.1:19387";
const API = `${BASE}/api/dsh-device-monitor`;
const status = await (await fetch(`${API}/terminal/status`)).json();
const { hostname, port } = new URL(BASE);

// A plausible LAN address, to exercise "the GUI was opened by IP" — the one
// shape that a loopback-only probe can never reach.
const lanIp = (process.env.DDM_LAN ?? "192.168.124.10").trim();

/**
 * Send one handshake and print the first response line.
 *
 * `overrides` REPLACES a default header; `null` REMOVES it. Removal has to be
 * expressible because "the header is absent" is itself a case the fence reads.
 */
const CHROME = {
	Upgrade: "websocket",
	Connection: "Upgrade",
	Origin: BASE,
	"Sec-Fetch-Site": "same-origin",
	"Sec-Fetch-Mode": "websocket",
	"Sec-Fetch-Dest": "websocket",
	"Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
	"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	"Cache-Control": "no-cache",
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

const handshake = (label, { path = status.path, headers: overrides = {} } = {}) =>
	new Promise((resolve) => {
		const headers = { Host: `${hostname}:${port}`, ...CHROME, ...overrides };
		const lines = [`GET ${path} HTTP/1.1`];
		for (const [k, v] of Object.entries(headers)) if (v !== null) lines.push(`${k}: ${v}`);
		lines.push(`Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`);
		lines.push("Sec-WebSocket-Version: 13");
		const request = [...lines, "", ""].join("\r\n");

		const socket = net.connect(Number(port), hostname);
		let buf = "";
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			socket.destroy();
			const [first, ...rest] = buf.split("\r\n");
			const body = rest.join(" ").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 46);
			console.log(`  ${label.padEnd(46)} ${(first || "(no response — socket died with no bytes)").trim()} ${body}`);
			resolve();
		};
		socket.on("connect", () => socket.write(request));
		socket.on("data", (d) => {
			buf += d.toString("latin1");
			if (buf.includes("\r\n\r\n")) setTimeout(finish, 150);
		});
		socket.on("error", (e) => {
			if (buf === "") buf = `(socket error: ${e.message})`;
			finish();
		});
		socket.on("close", () => setTimeout(finish, 80));
		setTimeout(finish, 3000);
	});

console.log(`\nsocket path : ${status.path}`);
console.log(`probing     : ${hostname}:${port}   (lanIp for the 403 rows: ${lanIp})\n`);

console.log("-- the baseline, and a full browser-shaped handshake --");
await handshake("Host=127.0.0.1, Origin=127.0.0.1");
await handshake("everything Chrome sends");
await handshake("Connection: keep-alive, Upgrade", { headers: { Connection: "keep-alive, Upgrade" } });
await handshake("no permessage-deflate", { headers: { "Sec-WebSocket-Extensions": null } });
await handshake("no Sec-Fetch-* at all", { headers: { "Sec-Fetch-Mode": null, "Sec-Fetch-Dest": null, "Sec-Fetch-Site": null } });
await handshake("+ Cookie present", { headers: { Cookie: "dsh_session=fake" } });

console.log("\n-- loopback spellings (all must be 101) --");
await handshake("Host=127.0.0.1, Origin=localhost", { headers: { Origin: `http://localhost:${port}` } });
await handshake("Host=localhost, Origin=127.0.0.1", { headers: { Host: `localhost:${port}` } });
await handshake("Origin without a port", { headers: { Origin: "http://127.0.0.1" } });
await handshake("Origin: https (not http)", { headers: { Origin: `https://127.0.0.1:${port}` } });
await handshake("Origin: [::1]", { headers: { Origin: `http://[::1]:${port}` } });
await handshake("Origin: LOCALHOST (upper case)", { headers: { Origin: `http://LOCALHOST:${port}` } });
await handshake("Sec-Fetch-Site: same-site", { headers: { "Sec-Fetch-Site": "same-site" } });
await handshake("Sec-Fetch-Site: none", { headers: { "Sec-Fetch-Site": "none" } });
await handshake("no Origin at all", { headers: { Origin: null } });

console.log("\n-- refused shapes (403 by design, NOT the bug) --");
await handshake(`Host=${lanIp} (the GUI opened by IP)`, { headers: { Host: `${lanIp}:${port}`, Origin: `http://${lanIp}:${port}` } });
await handshake("Sec-Fetch-Site: cross-site", { headers: { "Sec-Fetch-Site": "cross-site" } });
await handshake("Origin: file://", { headers: { Origin: "file://" } });
await handshake("Origin: null (sandboxed)", { headers: { Origin: "null" } });
await handshake("Origin: app://desktop", { headers: { Origin: "app://desktop" } });
await handshake("Origin: dsh://local", { headers: { Origin: "dsh://local" } });
await handshake("Origin: chrome-extension://abc", { headers: { Origin: "chrome-extension://abcdef" } });

// m07341. The desktop shell's page is `dsh-app://app` while the Host is
// `http://127.0.0.1:<port>` — a different scheme AND a different host, so
// Chromium labels the upgrade `cross-site`. The first two rows are the fix: the
// exact pair the shell produces must be 101. The third is the boundary — the
// shell's own OTHER document (`dsh-app://shell`) must stay refused, so this is
// not a blanket "any dsh-app page may open a shell".
console.log("\n-- the desktop shell (m07341: the exact pair the shell sends must be 101) --");
await handshake("Origin: dsh-app://app + Sec-Fetch-Site: cross-site", { headers: { Origin: "dsh-app://app", "Sec-Fetch-Site": "cross-site" } });
await handshake("Origin: dsh-app://app (same-origin label)", { headers: { Origin: "dsh-app://app", "Sec-Fetch-Site": "same-origin" } });
await handshake("Origin: dsh-app://shell (the OTHER document)", { headers: { Origin: "dsh-app://shell", "Sec-Fetch-Site": "cross-site" } });
// The origin must not be a skeleton key: with a LAN Host or a non-loopback
// socket the same header is still refused. The Host row below proves the header
// alone is not sufficient, which is the whole reason this is safe.
await handshake("dsh-app origin BUT a LAN Host", { headers: { Origin: "dsh-app://app", "Sec-Fetch-Site": "cross-site", Host: `${lanIp}:${port}` } });

console.log("\n-- an unregistered path (destroyed, answers nothing) --");
await handshake("a path the plugin never registered", { path: `${API}/terminal-nope` });

console.log(`
  Reading: every loopback row above should be 101, and so should the two
  dsh-app://app rows under "the desktop shell". If they are, the Host accepts
  exactly what the desktop shell sends.

  A 403 anywhere in "-- the desktop shell --" means the fence is still judging
  cross-site before the desktop origin, and the GUI terminal will keep saying
  「无法建立终端连接」even though the client-side URL is now correct.

  Then run tools\\read-terminal-audit.mjs: with this generation loaded, a browser
  attempt finally appears as a terminal.upgrade row carrying Origin:
  dsh-app://app. Before it, the browser was invisible here — "no row" and
  "refused" looked identical.
`);
