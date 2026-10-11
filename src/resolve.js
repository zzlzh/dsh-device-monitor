/**
 * Module resolution helpers.
 *
 * This plugin is authored in the workspace and installed into a Harness
 * profile by reference, so its own directory sits outside the profile's
 * `node_modules`. Node's resolver walks up from the *plugin's* directory and
 * would therefore miss every dependency the profile installed. These helpers
 * retry the same specifier from the profile directory (and from `$DSH_HOME`),
 * which is where `pnpm` actually put them.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { dshHome } from "./store.js";

/**
 * Directories to use as resolution roots, most specific first.
 *
 * `DSH_PROFILE_DIR` is the authoritative answer, but it is not always present
 * in the Host process environment, so the profile directory is also derived
 * from `DSH_HOME` + `DSH_PROFILE`, and every profile that actually has a
 * `node_modules` is offered as a last resort. The last rung matters because an
 * installed-by-reference plugin runs from its own workspace path and cannot
 * see any of these directories by walking up from itself.
 */
export function roots() {
	const out = [];
	/**
	 * Add a candidate, normalizing separators first.
	 *
	 * Normalization is what makes the de-duplication real: an environment value
	 * like `C:/Users/x/.dsh/profiles/desktop` and the same directory derived
	 * with `join` differ as strings but are the same place, and a ladder that
	 * lists it twice would attempt a resolution twice and look correct while
	 * doing so.
	 */
	const push = (candidate) => {
		if (typeof candidate !== "string" || candidate.trim() === "") return;
		const normalized = resolve(candidate);
		if (!out.includes(normalized)) out.push(normalized);
	};
	const home = resolve(dshHome());
	push(process.env.DSH_PROFILE_DIR);
	const profileName = process.env.DSH_PROFILE;
	if (typeof profileName === "string" && profileName.trim() !== "") push(join(home, "profiles", profileName));
	// A profile whose name is unknown: any sibling profile directory that looks
	// like a real profile (it has a package.json) may host the dependency. The
	// package.json requirement keeps incidental directories under `profiles/`
	// — `node_modules` and friends — out of the ladder, so a lookup cannot
	// accidentally resolve through an unrelated tree.
	try {
		for (const entry of readdirSync(join(home, "profiles"), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = join(home, "profiles", entry.name);
			if (existsSync(join(candidate, "package.json"))) push(candidate);
		}
	} catch {
		// no profiles directory; the earlier rungs stand
	}
	push(home);
	return out;
}

/**
 * Import a module by specifier, falling back to the profile's resolution
 * roots when the normal lookup fails.
 * @param specifier - the bare module specifier.
 * @returns the imported namespace, or `undefined` when it cannot be found.
 */
export async function softImport(specifier) {
	try {
		return await import(specifier);
	} catch {
		// fall through to the profile roots
	}
	for (const root of roots()) {
		try {
			const require = createRequire(join(root, "__dsh-device-monitor.js"));
			const resolved = require.resolve(specifier);
			return await import(new URL(`file://${resolved.replace(/\\/g, "/")}`).href);
		} catch {
			// try the next root
		}
	}
	return undefined;
}

/**
 * Require a CommonJS module by specifier, with the same fallback behaviour.
 * @param specifier - the bare module specifier.
 * @returns the module exports, or `undefined` when it cannot be found.
 */
export function softRequire(specifier) {
	const seen = [];
	try {
		return createRequire(import.meta.url)(specifier);
	} catch (error) {
		seen.push(error);
	}
	for (const root of roots()) {
		try {
			return createRequire(join(root, "__dsh-device-monitor.js"))(specifier);
		} catch (error) {
			seen.push(error);
		}
	}
	return undefined;
}
