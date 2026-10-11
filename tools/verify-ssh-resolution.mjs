/**
 * Prove the ssh2 resolution ladder works under every environment shape the
 * Host can actually present — including the one that broke it.
 *
 * The live Host failed with:
 *   cannot load the ssh2 module: Cannot find module 'ssh2'
 *   Require stack: - C:\Users\<user>\.dsh\index.js
 * which proves `DSH_PROFILE_DIR` was absent in that process, so the old
 * two-rung ladder fell straight through to `$DSH_HOME` and gave up.
 *
 * Everything runs in-process: each case imports `src/ssh.js` under a unique
 * query string, which gives it a fresh module instance and therefore a fresh
 * `cachedSsh2`, while mutating `process.env` around the call. Spawning a child
 * per case is not possible under the confined sandbox (piped stdio is denied),
 * and it is not needed — the caching that makes a child attractive is exactly
 * what the cache-busting import resets.
 *
 * Run: node tools/verify-ssh-resolution.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

//#region static shape
console.log("== the implementation shape ==");
const resolveSource = readFileSync(at("src/resolve.js"), "utf8");
const sshSource = readFileSync(at("src/ssh.js"), "utf8");
check("resolve.js exports roots", /export function roots\(\)/.test(resolveSource));
check("ssh.js imports roots from resolve.js", /import \{ roots \} from "\.\/resolve\.js"/.test(sshSource));
check("ssh.js no longer keeps its own DSH_PROFILE_DIR special case",
	!/const profileDir = process\.env\.DSH_PROFILE_DIR/.test(sshSource));
check("ssh.js still exports loadSsh2 and COLLECT_TIMEOUT_MS",
	/export function loadSsh2\(\)/.test(sshSource) && /export const COLLECT_TIMEOUT_MS/.test(sshSource));
//#endregion

//#region roots() ordering
console.log("\n== roots() ordering and content ==");
let counter = 0;
const freshResolve = () => import(`${PLUGIN}/src/resolve.js?case=${counter++}`);

/** Compare two paths ignoring separator style and a trailing separator. */
const samePath = (a, b) => String(a).replace(/[\\/]+/g, sep).replace(new RegExp(`${sep.replace(/\\/g, "\\\\")}+$`), "").toLowerCase()
	=== String(b).replace(/[\\/]+/g, sep).toLowerCase();

const derivedOnly = await withEnv({ DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: "desktop" }, async () => (await freshResolve()).roots());
check("the derived profile dir is the first rung when DSH_PROFILE_DIR is absent",
	samePath(derivedOnly[0], join(HOME, "profiles", "desktop")), JSON.stringify(derivedOnly));
check("DSH_HOME is the last rung", samePath(derivedOnly[derivedOnly.length - 1], HOME), JSON.stringify(derivedOnly));
check("no duplicate roots", new Set(derivedOnly.map((root) => root.replace(/\\/g, "/").toLowerCase())).size === derivedOnly.length, JSON.stringify(derivedOnly));
check("a profile owning ssh2 appears in the ladder",
	derivedOnly.some((root) => root.replace(/\\/g, "/").includes("/profiles/desktop")), JSON.stringify(derivedOnly));

const explicit = await withEnv({ DSH_HOME: HOME, DSH_PROFILE_DIR: `${HOME}/profiles/desktop`, DSH_PROFILE: "desktop" }, async () => (await freshResolve()).roots());
check("an explicit DSH_PROFILE_DIR wins the first rung",
	samePath(explicit[0], join(HOME, "profiles", "desktop")), JSON.stringify(explicit));
check("the ladder does not repeat the same directory from two rungs",
	new Set(explicit.map((root) => root.replace(/\\/g, "/").toLowerCase())).size === explicit.length, JSON.stringify(explicit));

const unknownProfile = await withEnv({ DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: "no-such-profile" }, async () => (await freshResolve()).roots());
check("a non-existent DSH_PROFILE still yields the real profile via the directory scan",
	unknownProfile.some((root) => root.replace(/\\/g, "/").includes("/profiles/desktop")), JSON.stringify(unknownProfile));
//#endregion

//#region the resolution matrix, in-process
console.log("\n== ssh2 resolves from every environment the Host can present ==");
const emptyHome = mkdtempSync(join(tmpdir(), "ddm-empty-"));

const cases = [
	{
		name: "the live Host's failing shape: DSH_PROFILE_DIR absent",
		env: { DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: "desktop" },
		expect: true,
	},
	{
		name: "DSH_PROFILE_DIR present (the easy case)",
		env: { DSH_HOME: HOME, DSH_PROFILE_DIR: `${HOME}/profiles/desktop`, DSH_PROFILE: "desktop" },
		expect: true,
	},
	{
		name: "only DSH_HOME, no profile name at all",
		env: { DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined },
		expect: true, // the directory scan must carry it
	},
	{
		name: "DSH_PROFILE names a profile that does not exist",
		env: { DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: "no-such-profile" },
		expect: true,
	},
	{
		name: "DSH_HOME points somewhere with no profiles",
		env: { DSH_HOME: emptyHome, DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined },
		expect: false,
	},
];

for (const testCase of cases) {
	const outcome = await withEnv(testCase.env, async () => {
		const { loadSsh2 } = await import(`${PLUGIN}/src/ssh.js?case=${counter++}`);
		try {
			const mod = loadSsh2();
			return { ok: typeof mod?.Client === "function", server: typeof mod?.Server === "function" };
		} catch (error) {
			return { ok: false, error: String(error.message).split("\n")[0] };
		}
	});
	check(testCase.name, outcome.ok === testCase.expect, outcome.ok ? "resolved" : outcome.error);
	if (testCase.expect) check(`  ↳ ${testCase.name}: exposes both Client and Server`, outcome.server === true, JSON.stringify(outcome));
}
//#endregion

//#region failure and caching behaviour
console.log("\n== failure behaviour ==");
const voidHome = mkdtempSync(join(tmpdir(), "ddm-void-"));
const missing = await withEnv({ DSH_HOME: voidHome, DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined }, async () => {
	const { loadSsh2 } = await import(`${PLUGIN}/src/ssh.js?case=${counter++}`);
	try {
		loadSsh2();
		return { threw: false };
	} catch (error) {
		return { threw: true, message: String(error.message) };
	}
});
check("a total failure throws rather than returning undefined", missing.threw === true, JSON.stringify(missing));
check("the error names the module it could not load", /cannot load the ssh2 module/.test(missing.message ?? ""), missing.message);

console.log("\n== caching ==");
const cached = await withEnv({ DSH_HOME: HOME, DSH_PROFILE_DIR: `${HOME}/profiles/desktop`, DSH_PROFILE: "desktop" }, async () => {
	const { loadSsh2 } = await import(`${PLUGIN}/src/ssh.js?case=${counter++}`);
	return { same: loadSsh2() === loadSsh2() };
});
check("repeated loads return the identical module object", cached.same === true, JSON.stringify(cached));
//#endregion

//#region the plugin's own fallback helpers still agree
console.log("\n== resolve.js softImport uses the same ladder ==");
const soft = await withEnv({ DSH_HOME: HOME, DSH_PROFILE_DIR: undefined, DSH_PROFILE: "desktop" }, async () => {
	const { softRequire } = await import(`${PLUGIN}/src/resolve.js?case=${counter++}`);
	return { ssh2: softRequire("ssh2") !== undefined, bogus: softRequire("@local/definitely-not-installed") };
});
check("softRequire finds ssh2 through the derived profile dir", soft.ssh2 === true);
check("softRequire returns undefined for an absent package", soft.bogus === undefined, JSON.stringify(soft.bogus));
//#endregion

rmSync(emptyHome, { recursive: true, force: true });
rmSync(voidHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${failures === 0 ? "ssh2 resolves in every Host environment shape" : `${failures} failed`}`);
if (failures > 0) process.exit(1);
