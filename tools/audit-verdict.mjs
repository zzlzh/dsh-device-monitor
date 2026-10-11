/**
 * The verdict logic of `read-terminal-audit.mjs`, separated so it can be TESTED.
 *
 * Why it is a module and not a block inside the reader: the first version of
 * this verdict keyed on `denied > 0`, but the reader's own self-proof fires ONE
 * guaranteed refusal on every run — so `denied` was never zero and the tool
 * answered "the fence is still refusing" on a perfectly healthy Host. The
 * second version fixed that and immediately had a second bug: it counted
 * `totalAttempts` from the ACCEPTED rows only, so a log containing nothing but
 * refusals still read as "nothing ever arrived" — burying 「被拒绝」 as 「没到」,
 * which is the one error this whole tool exists to prevent.
 *
 * Both were logic bugs invisible to eyeballing. A verdict function nobody can
 * feed a case to is a verdict nobody can trust, so it lives here where
 * `verify-audit-verdict.mjs` can drive every branch from synthetic rows.
 */

/** The desktop shell's own page origin — the one the GUI actually reports. */
export const DESKTOP_ORIGIN = "dsh-app://app";

/**
 * Is this row the DESKTOP SHELL ITSELF, or a probe wearing its Origin header?
 *
 * Matching on `origin` alone is not enough, and this is the same trap one level
 * down: `tools\probe-ws.mjs` deliberately fires `Origin: dsh-app://app` at a LAN
 * `Host` (its "dsh-app origin BUT a LAN Host" row) to prove the fence still
 * checks the socket. Those rows are refusals that MUST happen, and counting them
 * as "the shell was refused" would report the m07341 bug on a healthy Host.
 *
 * The shell's real request is identified by the PAIR: its own origin AND a
 * loopback Host. `src\http.js` evaluates the origin only after the socket and
 * the Host are both proven loopback, so the probe cannot forge this pair.
 */
export function isDesktopShell(row) {
	if (row.origin !== DESKTOP_ORIGIN) return false;
	const host = String(row.host ?? "");
	const bare = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return bare === "127.0.0.1" || bare === "::1" || bare.toLowerCase() === "localhost";
}

const newestAt = (list) =>
	list.reduce((best, row) => (String(row.at ?? "") > best ? String(row.at ?? "") : best), "");

/** Counts and timestamps the verdict is derived from, exposed for the reader's printout. */
export function classify(rows) {
	const tally = new Map();
	for (const row of rows) tally.set(row.event, (tally.get(row.event) ?? 0) + 1);

	const upgrades = tally.get("terminal.upgrade") ?? 0;
	const unavailable = tally.get("terminal.upgradeUnavailable") ?? 0;
	const shellUpgrades = rows.filter((row) => row.event === "terminal.upgrade" && isDesktopShell(row));
	const shellDenied = rows.filter((row) => row.event === "terminal.upgradeDenied" && isDesktopShell(row));
	// A session the BROWSER opened is the strongest evidence there is: the fence
	// passed, the shell opened, and the client's URL was right — all at once.
	const webSessions = rows.filter((row) => row.event === "terminal.open" && row.by === "web");

	const denied = rows.filter((row) => row.event === "terminal.upgradeDenied").length;
	// Every upgrade ATTEMPT, accepted or refused. Counting only the ACCEPTED rows
	// here is the same mistake one layer down: a log holding nothing but refusals
	// would report zero attempts, and 「arrived and refused」 would print as
	// 「never arrived」.
	const totalAttempts = upgrades + denied;

	// A refusal is only evidence about the CURRENT fence if it is newer than the
	// current fence's own successes. The audit log accumulates across Host
	// generations, so pre-fix refusals sit in the same file as post-fix accepts —
	// and counting them together reports the bug forever.
	const newestShellAccept = newestAt(shellUpgrades);
	const newestShellDeny = newestAt(shellDenied);
	const newestWebSession = newestAt(webSessions);
	const newestSuccess = newestWebSession > newestShellAccept ? newestWebSession : newestShellAccept;
	const denialIsStale = newestShellDeny !== "" && newestShellDeny < newestSuccess;

	return {
		tally,
		upgrades,
		denied,
		unavailable,
		totalAttempts,
		shellUpgrades,
		shellDenied,
		webSessions,
		newestShellAccept,
		newestShellDeny,
		newestWebSession,
		newestSuccess,
		denialIsStale,
	};
}

/**
 * Decide what the log means.
 *
 * @param opts.instrumented - the running Host demonstrably records upgrades.
 * @param opts.rows - the `terminal.*` audit rows (any order).
 * @returns `{ code, lines }`; `code` is the machine-checkable verdict kind.
 */
export function verdictFor({ instrumented, rows }) {
	const c = classify(rows);
	const out = (code, ...lines) => ({ code, lines, ...c });

	if (!instrumented) {
		// The honest answer. A tool that says "no upgrade reached the Host" while
		// running against a build that could not have recorded one is worse than no
		// tool: it converts an unknown into a confident wrong answer.
		return out(
			"indeterminate",
			"  VERDICT: INDETERMINATE — the running Host does NOT record upgrade attempts.",
			"           A refused upgrade is silent on this build, so an empty log here",
			"           cannot distinguish 「never arrived」 from 「arrived and refused」.",
			"           Restart the Host to load the instrumented fence, then rerun.",
		);
	}

	if (c.shellDenied.length > 0 && !c.denialIsStale) {
		// Decisive answer #1, and it must be tested BEFORE any generic "did anything
		// arrive" branch: a log whose only rows are refusals has zero accepts, and a
		// generic branch would answer "nothing arrived" — burying the one fact that
		// matters.
		return out(
			"still-refuses",
			`  VERDICT: the fence STILL refuses the desktop shell's own page origin (${DESKTOP_ORIGIN}).`,
			"           This is the m07341 bug; the accept branch is missing or misordered.",
		);
	}

	if (c.newestWebSession !== "") {
		// Decisive answer #2. A probe can forge any header, but it cannot make the
		// product open a session `by: "web"`, which only the panel's own code sends.
		return out(
			"fixed",
			`  VERDICT: FIXED — a browser session opened at ${c.newestWebSession}.`,
			...(c.shellDenied.length > 0
				? [`           (${c.shellDenied.length} shell refusal(s) predate it — an earlier Host generation.)`]
				: []),
		);
	}

	if (c.totalAttempts === 0) {
		return out(
			"never-arrived",
			"  VERDICT: the fence is live, yet no upgrade ever reached it — the failure is",
			"           BEFORE the Host (client-side: CSP, wrong scheme, or an extension).",
		);
	}

	if (c.shellUpgrades.length > 0 && c.unavailable === 0) {
		return out(
			"passed-fence",
			`  VERDICT: all ${c.shellUpgrades.length} desktop-shell upgrade(s) passed the fence — the fault`,
			"           is after the handshake, or the panel was never opened.",
		);
	}

	if (c.unavailable > 0) {
		return out("unavailable", `  VERDICT: ${c.unavailable} upgrade(s) reached a Host with no usable ws module (503).`);
	}

	return out(
		"no-shell-attempt",
		`  VERDICT: ${c.totalAttempts} upgrade(s) recorded, but NONE from the desktop shell's own`,
		`           origin+loopback pair (${DESKTOP_ORIGIN} at a loopback Host), so the browser`,
		"           has not attempted a connection since the current generation started.",
		"           Open the terminal in the GUI, then rerun.",
	);
}
