/**
 * Drive EVERY branch of the audit verdict from synthetic rows.
 *
 * Why this file exists: two logic bugs in `read-terminal-audit.mjs`'s verdict
 * were found only by feeding it cases, and neither was visible by reading it.
 *
 *   Bug 1 — keyed on `denied > 0`. The reader's own self-proof fires ONE
 *           guaranteed refusal on every run, so `denied` was never zero and the
 *           tool said "the fence is still refusing" on a perfectly healthy Host.
 *   Bug 2 — `totalAttempts` counted ACCEPTED rows only, so a log containing
 *           nothing but refusals still answered "nothing ever arrived" — turning
 *           「arrived and refused」 into 「never arrived」, the single error this
 *           tool exists to prevent.
 *
 * Bug 2 was introduced WHILE fixing bug 1. That is the argument for this file:
 * a verdict whose cases are not written down gets fixed by guesswork, and the
 * fix is as likely to add a second bug as to remove the first.
 *
 * Run: node tools/verify-audit-verdict.mjs
 */
import { verdictFor, classify, isDesktopShell, DESKTOP_ORIGIN } from "./audit-verdict.mjs";

let failures = 0;
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	}
}

const at = (stamp) => `2026-10-06T${stamp}.000Z`;

/** The desktop shell's own request: its origin AND a loopback Host. */
const upgrade = (stamp, host = "127.0.0.1:19387") => ({
	at: at(stamp),
	event: "terminal.upgrade",
	from: "127.0.0.1",
	host,
	origin: DESKTOP_ORIGIN,
	site: "cross-site",
	url: "/api/dsh-device-monitor/terminal",
});
const deniedRow = (stamp, host = "127.0.0.1:19387") => ({
	...upgrade(stamp, host),
	event: "terminal.upgradeDenied",
});
/** A probe forging the shell's Origin at a LAN Host — a refusal that MUST happen. */
const probeLan = (stamp) => deniedRow(stamp, "192.168.124.10:19387");
const browserSession = (stamp) => ({ at: at(stamp), event: "terminal.open", session: "t1-x", deviceId: "nas-a", by: "web" });
/** A session opened by a SCRIPT, not the panel — not evidence about the client. */
const scriptSession = (stamp) => ({ at: at(stamp), event: "terminal.open", session: "t2-y", deviceId: "nas-b", by: "live-terminal-e2e" });

const code = (rows, instrumented = true) => verdictFor({ instrumented, rows }).code;

console.log("== the shell-vs-probe discriminator ==");
check("the shell's own origin at a loopback host IS the shell", isDesktopShell(upgrade("10:00:00")));
check("the same origin at ::1 is also the shell", isDesktopShell({ origin: DESKTOP_ORIGIN, host: "[::1]:19387" }));
check("the same origin at localhost is also the shell", isDesktopShell({ origin: DESKTOP_ORIGIN, host: "localhost:19387" }));
check("the probe's origin at a LAN host is NOT the shell", !isDesktopShell(probeLan("10:00:00")));
check("a loopback host with a foreign origin is NOT the shell", !isDesktopShell({ origin: "file://", host: "127.0.0.1:19387" }));
check("a missing host is not the shell", !isDesktopShell({ origin: DESKTOP_ORIGIN }));

console.log("\n== A: the shell is refused and nothing else happened ==");
check("verdict is still-refuses", code([upgrade("10:00:00"), deniedRow("10:00:00.050")]) === "still-refuses");
check(
	"the refusal is not reported as 'never arrived'",
	!verdictFor({ instrumented: true, rows: [upgrade("10:00:00"), deniedRow("10:00:00.050")] }).lines.join(" ").includes("no upgrade ever reached"),
);

console.log("\n== B: a refusal, then a later browser session ==");
check("verdict is fixed (the session is newer)", code([upgrade("10:00:00"), deniedRow("10:00:00.050"), browserSession("10:00:01")]) === "fixed");

console.log("\n== C: a stale refusal from an earlier generation, then a session ==");
check("verdict is fixed", code([deniedRow("01:00:00"), browserSession("10:00:01")]) === "fixed");
check("the staleness is detected", classify([deniedRow("01:00:00"), browserSession("10:00:01")]).denialIsStale === true);
check(
	"a refusal NEWER than the session is not stale",
	classify([browserSession("10:00:01"), deniedRow("11:00:00")]).denialIsStale === false,
);
check(
	"a fresh refusal outranks the older session",
	code([browserSession("10:00:01"), deniedRow("11:00:00")]) === "still-refuses",
);

console.log("\n== D: only the probe's LAN-host refusal (a healthy Host, no browser yet) ==");
check("verdict is no-shell-attempt, never still-refuses", code([probeLan("10:00:02")]) === "no-shell-attempt");
check("it does NOT claim nothing arrived", code([probeLan("10:00:02")]) !== "never-arrived");

console.log("\n== E: nothing at all ==");
check("verdict is never-arrived", code([{ at: at("10:00:00"), event: "device.create", id: "x" }]) === "never-arrived");

console.log("\n== the self-proof's own refusal must not be readable as the bug ==");
// This is bug 1, stated as a case. On a healthy Host the log ALWAYS contains at
// least one refusal — the reader's self-proof — so a verdict that keys on
// `denied > 0` answers "still refuses" on every run.
check(
	"a lone probe refusal is not the m07341 bug",
	code([probeLan("10:00:02")]) !== "still-refuses",
);
check(
	"a probe refusal plus a script session is not the m07341 bug",
	code([probeLan("10:00:02"), scriptSession("10:00:03")]) !== "still-refuses",
);

console.log("\n== other terminal shapes ==");
check("an unavailable ws module is its own verdict", code([upgrade("10:00:00"), { at: at("10:00:00.1"), event: "terminal.upgradeUnavailable" }]) === "unavailable");
check("a uniform-instrumented build with no rows is never-arrived", code([]) === "never-arrived");
check("not instrumented short-circuits to indeterminate", code([upgrade("10:00:00")], false) === "indeterminate");
check(
	"indeterminate names the ambiguity rather than guessing",
	verdictFor({ instrumented: false, rows: [] }).lines.join(" ").includes("never arrived"),
);

console.log("\n== only a real browser session proves the client works ==");
// A script session proves the SERVER half opens shells — it says nothing about
// whether the browser's own URL construction is right. Only `by: "web"` is
// emitted by the panel's own code.
check("a script session alone does not yield 'fixed'", code([upgrade("10:00:00"), scriptSession("10:00:01")]) !== "fixed");
check("a browser session does", code([browserSession("10:00:01")]) === "fixed");

console.log("");
if (failures > 0) {
	console.log(`FAILURES — ${failures} check(s) failed`);
	process.exit(1);
}
console.log("ALL PASS");
