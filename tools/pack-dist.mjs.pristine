/**
 * Build a shareable tarball of this plugin and PROVE it is installable.
 *
 * A plugin that runs in the author's profile has not been shown to be
 * shareable. The author's machine supplies three things the tarball must
 * either carry or declare:
 *
 *   1. `cordis.patch.yml` — the bundle's entry point. `package.json` points
 *      `dsh.bundle.patch` at it, so a tarball built from a `files` list that
 *      omits it installs "successfully" and then cannot be loaded.
 *   2. `ssh2` — required at runtime, but resolvable on the author's machine
 *      only because another installed plugin happens to hoist it. On a fresh
 *      profile there is nothing to hoist it, so it must be declared.
 *   3. `ws` — the same shape of problem, softened: a missing `ws` disables
 *      only the terminal (the route answers 503 and audits a row), so it is a
 *      degradation rather than a failure. Declared all the same.
 *
 * The checks below are the point of this script, not the packing. Each one
 * reads the FINISHED tarball rather than the directory it came from, because
 * "the file is in the working tree" and "the file shipped" are different
 * facts and only the second one reaches the other machine.
 *
 * Usage:
 *   node tools/pack-dist.mjs [--out <dir>]
 *
 * Exit code 0 means every check passed; 1 means at least one did not, and the
 * tarball should not be handed to anyone.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * List the entries of a `.tgz` by reading it directly.
 *
 * Deliberately not `tar -tzf`: capturing a child process's stdout through a
 * pipe is refused under the confined sandbox (`spawnSync tar EPERM`), and the
 * point of this script is to be runnable in exactly the environment it
 * verifies. A gzipped tar is a flat sequence of 512-byte headers followed by
 * each file's bytes, which is little enough format to read here.
 *
 * @param path - the tarball to read.
 * @returns the entry names, in archive order.
 */
function tarEntries(path) {
	const buf = gunzipSync(readFileSync(path));
	const names = [];
	let offset = 0;
	while (offset + 512 <= buf.length) {
		const header = buf.subarray(offset, offset + 512);
		// Two zero blocks mark the end of the archive.
		if (header.every((byte) => byte === 0)) break;
		// The name occupies bytes 0..99; the ustar prefix (if any) 345..499.
		const readField = (start, length) => {
			const slice = header.subarray(start, start + length);
			const end = slice.indexOf(0);
			return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
		};
		const name = readField(0, 100);
		const prefix = readField(345, 155);
		names.push(prefix === "" ? name : `${prefix}/${name}`);
		// The size is octal in bytes 124..135. Round the data up to a block.
		const size = parseInt(readField(124, 12).trim() || "0", 8);
		offset += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
	}
	return names;
}

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const OUT = outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]) : join(ROOT, "dist");

const failures = [];
const checks = [];

function check(label, ok, detail) {
	checks.push({ label, ok, detail });
	if (!ok) failures.push(`${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** Read the package manifest as the tarball will ship it. */
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

console.log("== pre-flight: the manifest's own claims ==");

// 1. Every path the manifest points at must exist on disk. A dangling
//    `dsh.bundle.patch` is the failure mode this whole script exists for.
const patch = manifest.dsh?.bundle?.patch;
check("the manifest names a bundle patch", typeof patch === "string" && patch !== "", String(patch));
if (typeof patch === "string") {
	const patchPath = join(ROOT, patch);
	check(`the bundle patch exists on disk (${patch})`, existsSync(patchPath));
	// ...and it must be in `files`, or `npm pack` silently drops it.
	const base = patch.replace(/^\.\//, "");
	check(`the bundle patch is declared in files[] (${base})`,
		(manifest.files ?? []).includes(base),
		JSON.stringify(manifest.files));

	// A patch that does not parse is worse than a missing one: the bundle is
	// present, so the failure surfaces later as an unexplained missing panel.
	if (existsSync(patchPath)) {
		const text = readFileSync(patchPath, "utf8");
		check("the bundle patch names this package",
			text.includes(manifest.name),
			text.trim().split("\n").slice(0, 4).join(" / "));
	}
}

// 2. Every `exports` target must exist. The client bundle is fetched by
//    subpath (`./client`), so a typo here is a blank panel, not a load error.
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
	if (typeof value !== "string" || value.includes("*")) continue;
	const target = join(ROOT, value);
	check(`exports["${key}"] resolves to a real file (${value})`, existsSync(target));
}

// 3. Declared dependencies must cover what the code actually loads. Read the
//    specifiers out of the source rather than trusting a hand-kept list.
const sourceSpecifiers = new Set();
for (const file of ["src/ssh.js", "src/terminal-route.js", "src/resolve.js", "index.js"]) {
	const path = join(ROOT, file);
	if (!existsSync(path)) continue;
	const text = readFileSync(path, "utf8");
	for (const match of text.matchAll(/(?:require|softRequire|softImport|loadWs)\(\s*"([^"]+)"/g)) {
		if (match[1].startsWith(".") || match[1].startsWith("node:")) continue;
		if (match[1].startsWith("@deepseek-ai/")) continue; // shipped with dsh itself
		sourceSpecifiers.add(match[1]);
	}
}
for (const specifier of sourceSpecifiers) {
	check(`the runtime dependency "${specifier}" is declared in package.json`,
		(manifest.dependencies ?? {})[specifier] !== undefined,
		`dependencies=${JSON.stringify(manifest.dependencies ?? {})}`);
}

console.log(checks.map((row) => `  ${row.ok ? "ok  " : "FAIL"} ${row.label}`).join("\n"));
// Remember where the pre-flight ended so the post-flight can print ONLY the
// checks that are new. Printing the accumulated list again would double every
// pre-flight line in the runner's count, inflating the suite's score with
// assertions that were never re-evaluated.
const preflightCount = checks.length;

if (failures.length > 0) {
	console.error(`\nFAILURES — ${failures.length} pre-flight failure(s); not packing.`);
	process.exit(1);
}

console.log("\n== packing ==");
const scratch = mkdtempSync(join(tmpdir(), "ddm-pack-"));
let tarball;
try {
	// `stdio: "ignore"` rather than a pipe: piping a child's output is refused
	// under the confined sandbox, and the JSON report is not needed anyway —
	// the tarball's name is read from the directory below.
	//
	// npm is invoked through its OWN cli.js with this same node binary rather
	// than through the `npm` shim. The shim is a `.cmd` on Windows, which can
	// only be run by handing the arguments to a shell — and Node deprecates
	// that (DEP0190: arguments are concatenated, not escaped). Running the
	// script directly needs no shell on any platform. If npm is installed
	// somewhere this guess cannot see, fall back to the shim.
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const viaScript = existsSync(npmCli);
	const npmArgs = ["pack", "--pack-destination", scratch, "--silent"];
	execFileSync(viaScript ? process.execPath : "npm", viaScript ? [npmCli, ...npmArgs] : npmArgs, {
		cwd: ROOT,
		stdio: "ignore",
		// A dedicated cache keeps the pack reproducible and keeps this script
		// from depending on whatever state the user's npm cache is in.
		env: { ...process.env, npm_config_cache: join(scratch, "cache") },
		shell: !viaScript && process.platform === "win32",
	});
	const produced = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
	if (produced.length !== 1) throw new Error(`expected exactly one tarball, found ${produced.length}`);
	tarball = join(scratch, produced[0]);
	console.log(`  ${produced[0]}  ${statSync(tarball).size} bytes`);
} catch (error) {
	console.error(`npm pack failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

// 4. The checks that matter: read the FINISHED tarball. `npm pack` honours
//    `files` and `.npmignore`, so a passing pre-flight says nothing about
//    what shipped.
console.log("\n== post-flight: what actually shipped ==");
const shipped = new Set(tarEntries(tarball));

// Every file the product is SUPPOSED to ship, listed here rather than read out
// of `files[]`. Deriving this set from the manifest made the check vacuous: an
// entry removed from `files[]` also disappeared from the list being verified,
// so dropping LICENSE left the guard green. The expectation has to come from
// the requirement, not from the thing under test.
//
// npm silently skips a listed path that does not exist (it warns and packs
// anyway), so a deleted LICENSE would otherwise leave `files[]` pointing at
// nothing with every other check still passing.
//
// `package.json` is absent here on purpose: npm always includes it whatever
// `files[]` says, so requiring it to be DECLARED would assert a rule npm does
// not have. It is checked for presence on its own, below.
const REQUIRED_FILES = [
	"index.js",
	"client.js",
	String(patch).replace(/^\.\//, ""),
	"icon.svg",
	"README.md",
	"LICENSE",
	"SECURITY.md",
	"locale/zh.json",
	"locale/en.json",
];
for (const entry of REQUIRED_FILES) {
	check(`the tarball ships ${entry}`, shipped.has(`package/${entry}`));
	check(`${entry} is declared in files[]`, (manifest.files ?? []).some((pattern) => {
		// `files[]` is glob-ish: `locale/*.json` covers `locale/zh.json`.
		const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
		return regex.test(entry);
	}), JSON.stringify(manifest.files));
}
check("the tarball ships package.json", shipped.has("package/package.json"));

// GUARD THE GUARD. The loop above asks a question once per roster entry, so the
// roster is itself an input: drop an entry from it and that entry's check
// disappears rather than failing. The first version of this guard was written
// that way by accident and survived exactly that mutation — which is the same
// self-referential shape it was introduced to prevent, one level up.
//
// So the roster is pinned by a literal the roster does not contain. This number
// is an expectation, not a measurement: if a file is added or removed
// deliberately, the change is to this line as well.
const EXPECTED_ROSTER_SIZE = 9;
check(`the required-file roster is intact (${EXPECTED_ROSTER_SIZE} entries)`,
	REQUIRED_FILES.length === EXPECTED_ROSTER_SIZE,
	`found ${REQUIRED_FILES.length}: ${REQUIRED_FILES.join(", ")}`);
check("the roster lists no file twice",
	new Set(REQUIRED_FILES).size === REQUIRED_FILES.length,
	REQUIRED_FILES.join(", "));

// Every src module the entry point imports must be present — a plugin that
// loads `index.js` and then fails on a missing import is worse than one that
// refuses to install, because the failure appears at panel-open time. Checked
// against the directory rather than a list, so a new module is covered the
// moment it is written.
const srcShipped = [...shipped].filter((line) => /^package\/src\/.+\.js$/.test(line));
const srcOnDisk = readdirSync(join(ROOT, "src")).filter((file) => file.endsWith(".js"));
check("the tarball ships at least one src module", srcShipped.length > 0);
for (const file of srcOnDisk) {
	check(`the tarball contains package/src/${file}`, shipped.has(`package/src/${file}`));
}

// Dev-only artefacts leaking into a distributed build is the mirror-image
// defect: it ships the mutation baselines, which are not part of the product
// and would let a reader diff the source against a stale copy.
const leaked = [...shipped].filter((line) => /pristine|\.mutation\.|^package\/tools\/|^package\/docs\//.test(line));
check("no development-only files leaked into the tarball", leaked.length === 0, leaked.join(", "));

// Only the post-flight checks: the pre-flight block already printed its own.
console.log(checks.slice(preflightCount).map((row) => `  ${row.ok ? "ok  " : "FAIL"} ${row.label}`).join("\n"));

if (failures.length > 0) {
	console.error(`\nFAILURES — ${failures.length} of ${checks.length} checks failed:`);
	for (const line of failures) console.error(`  - ${line}`);
	rmSync(scratch, { recursive: true, force: true });
	process.exit(1);
}

// 5. Land the tarball. Copied rather than packed straight into place so a
//    failed run never leaves a half-verified tarball where someone will find
//    it and assume it passed.
mkdirSync(OUT, { recursive: true });
const destination = join(OUT, tarball.split(/[\\/]/).pop());
copyFileSync(tarball, destination);
rmSync(scratch, { recursive: true, force: true });

console.log(`\nALL PASS — ${checks.length}/${checks.length} checks`);
console.log(`\n  ${destination}  (${statSync(destination).size} bytes)`);
console.log(`
Install it on the other machine by extracting it into a directory and
pointing the profile's installer at that directory — a tarball path is not
itself an installable target:

  mkdir <target> && tar -xzf ${destination.split(/[\\/]/).pop()} -C <target> --strip-components 1

(The archive has a single package/ root, hence --strip-components 1.)
`);
