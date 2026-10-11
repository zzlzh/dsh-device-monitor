// Read the terminal-related audit rows, newest first.
//
// Written for the m07341 diagnosis. Before the upgrade fence was instrumented,
// a refused upgrade wrote NOTHING anywhere — so 「无法建立终端连接」 left no
// server-side trace and could not be told apart from a request that never
// arrived. With the fence recording `terminal.upgrade` before it judges, one
// row now answers the question the user's report could not:
//
//   a `terminal.upgrade` row appears  -> the request REACHED the Host, and its
//                                       `host`/`origin`/`site` say what the
//                                       browser actually sent. If the same
//                                       request has no `terminal.upgradeDenied`,
//                                       the fence let it through and the fault
//                                       is after the handshake.
//   NO row at all                     -> the request never reached the handler.
//                                       That is a client-side block: a CSP
//                                       `connect-src` refusal, a wrong scheme
//                                       (the desktop shell's `dsh-app://`), or
//                                       an extension. No server-side change can
//                                       fix it.
//
// Usage: node tools\read-terminal-audit.mjs [limit]

import net from "node:net";
import crypto from "node:crypto";

import { readAudit } from "../src/logs.js";

const limit = Number(process.argv[2] ?? 40);

/**
 * Skip the live self-proof.
 *
 * `DDM_AUDIT_ASSUME_INSTRUMENTED=1` exists so the VERDICT LOGIC can be exercised
 * against a synthetic log. Without it, the self-proof tries to reach the running
 * Host — which fails from a scratch `DSH_HOME`, so the tool answers
 * INDETERMINATE and no branch below is ever tested. A verdict function nobody
 * can feed a case to is a verdict nobody can trust.
 */
const assumeInstrumented = process.env.DDM_AUDIT_ASSUME_INSTRUMENTED === "1";

/**
 * Prove the RUNNING Host has the instrumented fence before trusting absence.
 *
 * This is the whole reason the tool exists, so it must not fall for its own
 * trap: on the pre-instrumentation build a refused upgrade wrote nothing, so
 * "no rows" was equally consistent with "never arrived" and with "refused".
 * Firing one upgrade that is guaranteed to be refused and then looking for its
 * row is what separates the two readings. Without this, the tool would report a
 * confident verdict from an empty log — the exact error being fixed.
 */
async function fenceIsInstrumented() {
	const before = readAudit(500).filter((row) => row.event === "terminal.upgrade").length;
	await new Promise((resolve) => {
		const socket = net.connect(19387, "127.0.0.1");
		const key = crypto.randomBytes(16).toString("base64");
		// A deliberately non-loopback Host: the fence must refuse this, and a
		// refusal is exactly the path that used to be silent.
		const request = [
			"GET /api/dsh-device-monitor/terminal HTTP/1.1",
			"Host: 192.168.124.10:19387",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${key}`,
			"Sec-WebSocket-Version: 13",
			"Origin: http://192.168.124.10:19387",
			"",
			"",
		].join("\r\n");
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve();
		};
		socket.on("connect", () => socket.write(request));
		socket.on("data", () => setTimeout(finish, 120));
		socket.on("error", finish);
		socket.on("close", finish);
		setTimeout(finish, 2000);
	});
	// Allow the append to land before reading back.
	await new Promise((resolve) => setTimeout(resolve, 250));
	const after = readAudit(500).filter((row) => row.event === "terminal.upgrade").length;
	return after > before;
}

const instrumented = assumeInstrumented ? true : await fenceIsInstrumented();

const rows = readAudit(500).filter((row) => String(row.event ?? "").startsWith("terminal."));
const shown = rows.slice(0, limit);

console.log(`\nterminal.* rows in the audit: ${rows.length} (showing ${shown.length}, newest first)\n`);

// The counts are the fastest read: a non-zero `terminal.upgrade` with zero
// `terminal.upgradeDenied` means the browser's request was ACCEPTED, which
// moves the whole investigation off the server.
const tally = new Map();
for (const row of rows) tally.set(row.event, (tally.get(row.event) ?? 0) + 1);
for (const [event, count] of [...tally].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${String(count).padStart(4)}  ${event}`);
}

if (shown.length === 0) {
	console.log("\n  (no terminal.* rows at all)");
} else {
	console.log("");
	for (const row of shown) {
		const { at, event, ...rest } = row;
		console.log(`  ${at}  ${event}  ${JSON.stringify(rest)}`);
	}
}

// Call out the decisive shapes rather than making the reader derive them.
//
// The verdict itself lives in `tools/audit-verdict.mjs` so that
// `tools/verify-audit-verdict.mjs` can drive every branch from synthetic rows.
// That separation is not tidiness: two logic bugs in this verdict were found
// only by feeding it cases, and neither was visible by reading it.
const { classify, verdictFor } = await import("./audit-verdict.mjs");

const c = classify(rows);

console.log("");
console.log(`  by origin: ${c.shellUpgrades.length} desktop-shell upgrade(s), ${c.shellDenied.length} of them refused`);
console.log(`  browser-opened sessions (by=web): ${c.webSessions.length}`);
if (c.shellDenied.length > 0 && c.denialIsStale) {
	console.log(`  note: the newest shell refusal is ${c.newestShellDeny}, older than the newest shell`);
	console.log(`        success (${c.newestSuccess}) — stale, from a previous Host generation.`);
}
console.log("");
for (const line of verdictFor({ instrumented, rows }).lines) console.log(line);

