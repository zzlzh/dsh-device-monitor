/**
 * Extract, from the installed dsh-better-sidebar bundle, the facts needed to
 * decide HOW to make the terminal panel fill the right column.
 *
 * This exists because guessing twice in a row is worse than not guessing: the
 * first attempt assumed a class-only stretch would be trapped by an ancestor's
 * containing block, and the second assumed the SAME containing block would make
 * `inset:0` fill the pane. Both are claims about a DOM this plugin does not own,
 * and neither was verified. So: read the host's own stylesheet and REPORT.
 *
 * Read-only. Prints:
 *   1. every rule carrying a containment / containing-block-creating property
 *   2. every rule whose selector mentions a pane/panel/tab body, with its
 *      position / height / overflow / contain / flex declarations
 *   3. the class names that appear as containers, so the ancestor chain can be
 *      reconstructed from the host's own markup
 */
import { readFileSync } from "node:fs";
import { dshHomePosix } from "./paths.mjs";

const FILE = dshHomePosix() + "/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js";
const source = readFileSync(FILE, "utf8");
console.log(`file: ${FILE}`);
console.log(`chars: ${source.length}\n`);

/** Every `selector{body}` pair in the bundle's CSS-in-JS strings. */
function rules(text) {
	const out = [];
	for (const match of text.matchAll(/([^{};\n]{1,220})\{([^{}]{1,4000})\}/g)) {
		const selector = match[1].trim();
		if (selector === "" || /^(return|function|const|let|var|if|for|while|catch|else)/.test(selector)) continue;
		out.push({ selector, body: match[2] });
	}
	return out;
}
const all = rules(source);
console.log(`rules scanned: ${all.length}\n`);

const CONTAINMENT = /(?:^|;)\s*(transform|will-change|filter|backdrop-filter|perspective|contain|container-type|content-visibility)\s*:/i;
console.log("=== rules that CREATE a containing block for position:fixed ===");
let containmentCount = 0;
for (const rule of all) {
	const decls = rule.body
		.split(";")
		.map((row) => row.trim())
		.filter((row) => CONTAINMENT.test(`;${row}`));
	if (decls.length === 0) continue;
	containmentCount += 1;
	console.log(`  ${rule.selector}`);
	console.log(`      ${decls.join(" ; ")}`);
}
console.log(`  total: ${containmentCount}\n`);

const PANEISH = /(?:^|[^a-z])(pane|tabbody|tab-body|tabContent|tab-content|panel|sidebar|column)/i;
const INTERESTING = /(?:^|;)\s*(position|height|max-height|min-height|overflow|overflow-y|contain|display|flex|flex-direction|align-items|inset|top|bottom)\s*:/i;
console.log("=== rules whose selector mentions a pane/panel/tab/column ===");
for (const rule of all) {
	if (!PANEISH.test(rule.selector)) continue;
	const decls = rule.body
		.split(";")
		.map((row) => row.trim())
		.filter((row) => row !== "" && INTERESTING.test(`;${row}`));
	if (decls.length === 0) continue;
	console.log(`  ${rule.selector}`);
	console.log(`      ${decls.join(" ; ")}`);
}

// The class names actually used as containers, to rebuild the ancestor chain.
console.log("\n=== every distinct class token seen in a selector, with a pane-ish role ===");
const tokens = new Map();
for (const rule of all) {
	for (const token of rule.selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
		const name = token[1];
		if (!PANEISH.test(name)) continue;
		if (!tokens.has(name)) tokens.set(name, new Set());
		tokens.get(name).add(rule.selector.trim());
	}
}
for (const [name, selectors] of [...tokens].sort((a, b) => a[0].localeCompare(b[0]))) {
	console.log(`  .${name}`);
	for (const selector of [...selectors].slice(0, 4)) console.log(`      ${selector}`);
}
