/**
 * Repo-root resolution for the verification scripts.
 *
 * The suites import the plugin's real modules by URL, and those URLs used to be
 * absolute paths of the author's machine — so a fresh clone could not run a
 * single test. Everything now derives from this file's own location instead.
 *
 * `tools/` sits one level below the repo root, so the root is its parent.
 */
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

/** Absolute filesystem path of the repository root. */
export const ROOT = dirname(import.meta.dirname);

/**
 * Absolute filesystem path of something inside the repo.
 * @param {string} relative path relative to the repo root, e.g. "src/store.js"
 */
export const at = (relative) => join(ROOT, relative);

/**
 * A `file://` URL for something inside the repo, for use with dynamic `import`.
 *
 * Goes through `pathToFileURL` rather than string concatenation because the
 * author's checkout path contained a space (`DeepSeek Harness`), which has to
 * be percent-encoded in a URL — a hand-built `file://C:/...` silently fails on
 * that. Doing it through the platform API makes the encoding the platform's
 * problem instead of ours.
 *
 * @param {string} relative path relative to the repo root, e.g. "src/store.js"
 */
export const url = (relative) => pathToFileURL(at(relative)).href;

/** The plugin root as a URL, for scripts that append sub-paths themselves. */
export const ROOT_URL = pathToFileURL(ROOT).href;

/**
 * A URL for something in the plugin, for use with dynamic `import`.
 *
 * Unlike `url()` this preserves a query string or hash on the relative part,
 * which several suites rely on to defeat Node's module cache and force a fresh
 * evaluation of a module they are about to change the environment for.
 *
 * @param {string} relative path relative to the repo root, e.g. "src/store.js"
 */
export const pu = (relative) => `${ROOT_URL}/${relative}`;

/**
 * The real DSH home, for the few suites that deliberately reach for the LIVE
 * profile (dependency-resolution tests, the live-service e2e scripts).
 *
 * These are the only tests that are not hermetic, so they are the only ones
 * that should ever read this. Honors `DSH_HOME` first, exactly like the plugin
 * itself does (`src/store.js`), then falls back to `~/.dsh`.
 */
export function dshHome() {
	if (process.env.DSH_HOME) return process.env.DSH_HOME;
	if (process.env.USERPROFILE) return join(process.env.USERPROFILE, ".dsh");
	if (process.env.HOME) return join(process.env.HOME, ".dsh");
	return join(ROOT, ".dsh");
}

/**
 * The real DSH home with forward slashes, for scripts that interpolate it into
 * paths handed to `createRequire` / `import`. Those APIs accept backslashes on
 * Windows, but a forward-slash form keeps the same string valid on every
 * platform and in the `.../x.js` sentinel these scripts pass.
 */
export const dshHomePosix = () => dshHome().replace(/\\/g, "/");

/**
 * A `file://` URL for a module inside the packaged Harness runtime (app.asar).
 *
 * Three verifiers import the REAL `@deepseek-ai/dsh-tools` `defineTool` from
 * there, which is the only way to prove the render contract without a GUI. The
 * location is machine-specific, so it is overridable: set `DSH_ASAR_DHS` to the
 * `.../resources/app.asar/dsh` directory. Otherwise the default install path is
 * tried, then the path is derived from `DSH_EXE` if that is set.
 *
 * @param {string} relative path relative to the `dsh` directory inside the asar
 */
export function asarUrl(relative) {
	// An explicit override wins outright: these three verifiers are the only
	// scripts that need the packaged runtime, and on a non-default install the
	// guess below cannot be trusted.
	if (process.env.DSH_ASAR_DHS) {
		return pathToFileURL(join(process.env.DSH_ASAR_DHS, relative)).href;
	}

	const candidates = [];
	if (process.env.DSH_EXE) {
		candidates.push(join(dirname(process.env.DSH_EXE), "resources", "app.asar", "dsh"));
	}
	if (process.env.LOCALAPPDATA) {
		candidates.push(join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar", "dsh"));
	}
	candidates.push(join("C:", "Program Files", "DeepSeek Harness", "resources", "app.asar", "dsh"));

	// Probe the .asar itself, not the directory inside it: `app.asar` is a real
	// file, whereas its inner paths are invisible to every filesystem call
	// outside Electron's patched fs — including the `existsSync` here when this
	// module is loaded by plain Node.
	const found = candidates.find((dir) => existsSync(dirname(dir))) ?? candidates[candidates.length - 1];
	return pathToFileURL(join(found, relative)).href;
}

/** The packaged `@deepseek-ai/dsh-tools` entry point, as a URL. */
export const ASAR_TOOLS_URL = asarUrl("node_modules/@deepseek-ai/dsh-tools/lib/index.js");
