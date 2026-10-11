/**
 * Prove the packed tarball is INSTALLABLE, not merely well-formed.
 *
 * pack-dist.mjs shows the right bytes shipped; this shows those bytes are
 * usable. It extracts the tarball into a fresh directory and then reads the
 * extracted package the way the plugin manager would: resolve the manifest,
 * resolve `dsh.bundle.patch` against the EXTRACTED root, and derive the client
 * bundle URL. A path that is correct only in the author's working tree fails
 * here, which is the point of the check.
 *
 * `tar` is never spawned: capturing a child's output through a pipe is refused
 * under the confined sandbox (`spawnSync tar EPERM`), and this script must run
 * in the environment it verifies.
 *
 * Usage: node tools/verify-dist-installable.mjs [<tarball>]
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const TARBALL = process.argv[2] ?? join(ROOT, "dist", "local-dsh-device-monitor-1.0.0.tgz");

let total = 0;
let failed = 0;
function check(label, ok, detail) {
	total += 1;
	if (!ok) failed += 1;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${detail}`}`);
}

/** Read one NUL-terminated tar header field. */
function tarField(header, start, length) {
	const slice = header.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

/**
 * Read a file, or return null if it is absent.
 *
 * Used for every read inside the checks. A missing file is one of the things
 * being tested for, so letting the read throw would turn a reported defect
 * into a stack trace — and a check that fails by crashing cannot be told apart
 * from one that never ran.
 */
function safeRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Unpack a gzipped tar in-process, returning the extracted entry names. */
function extract(tgzPath, destination) {
	const buf = gunzipSync(readFileSync(tgzPath));
	const names = [];
	let offset = 0;
	while (offset + 512 <= buf.length) {
		const header = buf.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = tarField(header, 0, 100);
		const prefix = tarField(header, 345, 155);
		const entry = prefix === "" ? name : `${prefix}/${name}`;
		const size = parseInt(tarField(header, 124, 12).trim() || "0", 8);
		const start = offset + 512;
		if (size > 0) {
			const target = join(destination, entry);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, buf.subarray(start, start + size));
		}
		names.push(entry);
		offset = start + Math.ceil(size / 512) * 512;
	}
	return names;
}

const scratch = mkdtempSync(join(tmpdir(), "ddm-install-"));
try {
	console.log(`== extracting ${TARBALL} ==`);
	const names = extract(TARBALL, scratch);
	check("the tarball extracted", names.length > 0, `${names.length} entries`);
	// `npm pack` always nests everything under a single `package/` prefix. The
	// installer extracts and points at that directory, so every path below is
	// resolved against it rather than against the author's tree.
	const root = join(scratch, "package");
	check("the archive nests under package/", names.every((entry) => entry.startsWith("package/")));

	// 1. The manifest must parse from the EXTRACTED copy. A manifest that only
	//    parses in the source tree would mean the pack rewrote something.
	const manifestText = safeRead(join(root, "package.json"));
	check("the extracted package.json is present", manifestText !== null);
	if (manifestText === null) throw new Error("no manifest to verify");
	const manifest = JSON.parse(manifestText);
	check("the extracted manifest parses", typeof manifest.name === "string", manifest.name);
	check("the extracted manifest keeps the package name",
		manifest.name === "@local/dsh-device-monitor", manifest.name);
	// 2. THE check this script exists for: the bundle patch must resolve against
	//    the extracted root. `dsh.bundle.patch` is read as a path relative to the
	//    package directory, so a `files` list that omitted it produces a bundle
	//    that installs and then cannot be loaded.
	const patchRel = manifest.dsh?.bundle?.patch;
	check("the manifest declares a bundle patch", typeof patchRel === "string", String(patchRel));
	if (typeof patchRel === "string") {
		// Read defensively rather than letting the read throw: a check that
		// fails by crashing is indistinguishable from a check that was never
		// reached, and this is precisely the defect the script exists to name.
		const patchPath = join(root, patchRel);
		const patchText = safeRead(patchPath);
		check(`the bundle patch resolves from the extracted root (${patchRel})`, patchText !== null);
		if (patchText !== null) {
			check("the extracted bundle patch names this package",
				patchText.includes(manifest.name), patchText.trim().split("\n").slice(0, 3).join(" / "));
		}
	}

	// 3. Every declared export must resolve from the extracted copy. The client
	//    half is fetched by subpath (`./client`), so a missing target is a panel
	//    that silently never renders rather than a load error.
	for (const [key, value] of Object.entries(manifest.exports ?? {})) {
		if (typeof value !== "string" || value.includes("*")) continue;
		check(`exports["${key}"] resolves from the extracted root (${value})`,
			safeRead(join(root, value)) !== null);
	}

	// 4. The dependency closure must be satisfiable. `ssh2` and `ws` are
	//    required at runtime; on the author's machine they resolve only because
	//    another plugin hoists them, which will not be true on a fresh profile.
	//    Declaring them is what lets the installer fetch them.
	for (const name of ["ssh2", "ws"]) {
		check(`the manifest declares the runtime dependency "${name}"`,
			manifest.dependencies?.[name] !== undefined,
			JSON.stringify(manifest.dependencies ?? {}));
	}
	// ...and the code must actually be the thing that needs them.
	const sshSource = safeRead(join(root, "src", "ssh.js"));
	check("src/ssh.js is present in the extracted copy", sshSource !== null);
	check("src/ssh.js requires ssh2 in the extracted copy",
		sshSource !== null && sshSource.includes('"ssh2"'));

	// 5. The Host half must be importable from the extracted copy. Loading it
	//    proves the module graph is complete: an entry point that imports a src
	//    module the pack omitted fails right here rather than at boot on the
	//    other machine.
	let hostDetail = "loaded";
	let hostResolves = true;
	try {
		await import(new URL(`file:///${join(root, "index.js").replace(/\\/g, "/")}`).href);
	} catch (error) {
		// A bare import may also fail for a reason that is NOT a packaging
		// defect: the Host half expects a cordis context that does not exist
		// here. Only an unresolvable module is a packaging failure, so the
		// message is classified rather than the bare fact of throwing.
		const message = String(error?.message ?? error).split("\n")[0];
		if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(message)) {
			hostResolves = false;
			hostDetail = message;
		} else {
			hostDetail = `imported; then threw a non-resolution error (${message})`;
		}
	}
	check("the extracted Host half resolves all its imports", hostResolves, hostDetail);

	// 6. The client bundle must be present and self-registering. It is fetched
	//    by subpath and evaluated as a plain script, so a missing or truncated
	//    bundle is a panel that silently never renders — never a load error.
	const clientSource = safeRead(join(root, "client.js"));
	check("the extracted client bundle is present", clientSource !== null);
	const clientLength = clientSource === null ? 0 : clientSource.length;
	check("the extracted client bundle is non-trivial", clientLength > 10_000, `${clientLength} chars`);
	check("the extracted client bundle registers itself with the module loader",
		clientSource !== null && clientSource.includes("__ModuleLoader__"));
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? `ALL PASS — ${total}/${total} checks` : `FAILURES — ${failed} of ${total} checks failed`}`);
process.exit(failed === 0 ? 0 : 1);
