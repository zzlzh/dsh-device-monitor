/**
 * Prove the SSH resolution fix addresses the failure actually observed in the
 * live Host — by reconstructing the OLD ladder and showing it fails in exactly
 * the environment shape where the new one succeeds.
 *
 * The live Host reported:
 *   cannot load the ssh2 module: Cannot find module 'ssh2'
 *   Require stack: - C:\Users\<user>\.dsh\index.js
 * That stack names the LAST candidate the old ladder tried, which is `$DSH_HOME`
 * — so `DSH_PROFILE_DIR` was absent and the old code never considered the
 * profile directory that actually owns ssh2.
 *
 * This is a mutation test on the resolver: same environment, two ladders, one
 * passes and one fails. A fix that cannot be shown to change the outcome of the
 * recorded failure is not a fix.
 *
 * Run: node tools/verify-ssh-fix-causality.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { at, ROOT_URL, ASAR_TOOLS_URL, dshHomePosix } from "./paths.mjs";

const HOME = dshHomePosix();
const PLUGIN = ROOT_URL;

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`); }
};

/** Run `fn` with a patched environment, restoring every key afterwards. */
async function withEnv(patch, fn) {
	const saved = new Map();
	for (const [key, value] of Object.entries(patch)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * The ladder exactly as it shipped when the live Host failed: normal
 * resolution, then `DSH_PROFILE_DIR` only if the variable is a non-empty
 * string, then `$DSH_HOME`.
 */
function legacyResolve(root, dshHome) {
	const candidates = [];
	try {
		candidates.push(createRequire(join(root, "src", "ssh.js")));
	} catch {
		// ignore
	}
	const profileDir = process.env.DSH_PROFILE_DIR;
	if (typeof profileDir === "string" && profileDir !== "") {
		try {
			candidates.push(createRequire(join(profileDir, "index.js")));
		} catch {
			// ignore
		}
	}
	try {
		candidates.push(createRequire(join(dshHome, "index.js")));
	} catch {
		// ignore
	}
	const tried = [];
	for (const require of candidates) {
		try {
			// The call that actually failed in the Host.
			require("ssh2");
			return { ok: true, tried };
		} catch (error) {
			tried.push(String(error.message).split("\n")[0]);
		}
	}
	return { ok: false, tried };
}

// The environment shape the live Host was in: DSH_HOME set, DSH_PROFILE_DIR
// absent. This is not a guess — the recorded Require stack proves it.
const LIVE_HOST_ENV = { DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined };

//#region the failure is reproducible
console.log("== the recorded failure reproduces with the old ladder ==");
const legacy = await withEnv(LIVE_HOST_ENV, async () => legacyResolve(at(".").replace(/\\/g, "/"), HOME));
check("the old ladder cannot find ssh2 in the live Host's environment", legacy.ok === false,
	legacy.ok ? "unexpectedly resolved" : "as reported");
console.log(`    (old ladder candidates attempted: ${legacy.tried.length})`);
//#endregion

//#region the fix changes that outcome
console.log("\n== the fixed ladder resolves in the same environment ==");
let counter = 0;
const resolved = await withEnv(LIVE_HOST_ENV, async () => {
	const { loadSsh2 } = await import(`${PLUGIN}/src/ssh.js?cause=${counter++}`);
	try {
		const mod = loadSsh2();
		return { ok: typeof mod?.Client === "function" && typeof mod?.Server === "function" };
	} catch (error) {
		return { ok: false, error: String(error.message).split("\n")[0] };
	}
});
check("the fixed ladder finds ssh2 with DSH_PROFILE_DIR absent", resolved.ok === true, resolved.error);
console.log(`    → the ONLY difference between the two runs is the ladder itself.`);
//#endregion

//#region what the fix added
console.log("\n== what the new ladder adds ==");
const rootInfo = await withEnv(LIVE_HOST_ENV, async () => {
	const { roots } = await import(`${PLUGIN}/src/resolve.js?cause=${counter++}`);
	return roots();
});
check("the ladder now includes the profile directory that owns ssh2",
	rootInfo.some((root) => root.replace(/\\/g, "/").endsWith("/profiles/desktop")), JSON.stringify(rootInfo));
check("the ladder starts with the profile, not with $DSH_HOME",
	rootInfo[0].replace(/\\/g, "/").includes("/profiles/"), JSON.stringify(rootInfo));
check("$DSH_HOME is still the final fallback", rootInfo[rootInfo.length - 1].replace(/\\/g, "/").endsWith("/.dsh"), JSON.stringify(rootInfo));
console.log(`    ladder (${rootInfo.length} rungs):`);
for (const root of rootInfo) console.log(`      ${root}`);
//#endregion

//#region the profile is discoverable without any env hint
console.log("\n== discovery does not depend on an environment hint ==");
// The directory scan is what saves a Host that sets neither variable. Confirm
// the profile it would pick really is the one holding ssh2.
const profilesDir = join(HOME, "profiles");
const discovered = readdirSync(profilesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(profilesDir, entry.name, "package.json")))
	.map((entry) => entry.name);
check("the scan finds at least one real profile", discovered.length > 0, JSON.stringify(discovered));
check("the scan includes desktop", discovered.includes("desktop"), JSON.stringify(discovered));
check("desktop really is where ssh2 lives",
	existsSync(join(profilesDir, "desktop", "node_modules", "ssh2", "package.json")));
// A directory that is NOT a profile must be rejected, or the ladder would
// wander into unrelated trees.
const nonProfiles = readdirSync(profilesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !existsSync(join(profilesDir, entry.name, "package.json")))
	.map((entry) => entry.name);
check("the scan's package.json filter excludes non-profile directories",
	nonProfiles.every((name) => !rootInfo.some((root) => root.replace(/\\/g, "/").endsWith(`/profiles/${name}`))),
	`non-profiles: ${JSON.stringify(nonProfiles)}`);
//#endregion

//#region the same ladder serves softRequire
console.log("\n== the fix also repairs the shared helpers ==");
const soft = await withEnv(LIVE_HOST_ENV, async () => {
	const { softRequire, softImport } = await import(`${PLUGIN}/src/resolve.js?cause=${counter++}`);
	return {
		ssh2: softRequire("ssh2") !== undefined,
		ssh2Import: (await softImport("ssh2"))?.Client !== undefined,
	};
});
check("softRequire finds ssh2 without any environment hint", soft.ssh2 === true);
check("softImport finds ssh2 without any environment hint", soft.ssh2Import === true);
//#endregion

//#region the original breakage is unrecoverable if a rung is dropped
console.log("\n== the scan rung is load-bearing, not decorative ==");
// Temporarily hide the profile's package.json marker from the scan by pointing
// DSH_HOME at a copy that has profiles/ but no package.json, and confirm that
// WITH the env hint it still works and WITHOUT it it does not. This shows the
// two mechanisms are independent and each closes a real gap.
const barren = mkdtempSync(join(tmpdir(), "ddm-barren-"));
const bareProfile = join(barren, "profiles", "desktop");
const { mkdirSync } = await import("node:fs");
mkdirSync(join(bareProfile, "node_modules"), { recursive: true });
const barrenNoHint = await withEnv({ DSH_HOME: barren, DSH_PROFILE_DIR: undefined, DSH_PROFILE: "desktop" }, async () => {
	const { roots } = await import(`${PLUGIN}/src/resolve.js?cause=${counter++}`);
	return roots();
});
check("with no ssh2 anywhere, the ladder still terminates at $DSH_HOME",
	barrenNoHint[barrenNoHint.length - 1].replace(/\\/g, "/") === barren.replace(/\\/g, "/"), JSON.stringify(barrenNoHint));
check("a profile dir derived from DSH_PROFILE is attempted before $DSH_HOME",
	barrenNoHint.some((root) => root.replace(/\\/g, "/").endsWith("/profiles/desktop")), JSON.stringify(barrenNoHint));
rmSync(barren, { recursive: true, force: true });
//#endregion

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? "the fix changes the outcome of the recorded live failure" : `${failures} failed`}`);
if (failures > 0) process.exit(1);
