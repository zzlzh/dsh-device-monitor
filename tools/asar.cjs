// Read files from an Electron .asar archive (read-only helper).
//
// Usage:
//   node asar.cjs list    <archive> [regex] [limit]
//   node asar.cjs cat     <archive> <inner-path>       > stdout
//   node asar.cjs extract <archive> <inner-path> <out-path>
//
// The asar header is located defensively: rather than trusting one fixed
// offset, scan the first bytes for the leading "{" of the JSON header and
// brace-match it (string-aware), so the tool survives header padding
// differences between asar writers.
const fs = require("fs");
const path = require("path");

const mode = process.argv[2];
const archive = process.argv[3];

const fd = fs.openSync(archive, "r");
const probeLen = Math.min(64 * 1024 * 1024, fs.fstatSync(fd).size);
const probe = Buffer.alloc(probeLen);
fs.readSync(fd, probe, 0, probeLen, 0);

function locateHeader(buf) {
	const start = buf.indexOf(0x7b); // "{"
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < buf.length; i += 1) {
		const c = buf[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === 0x5c) escaped = true;
			else if (c === 0x22) inString = false;
			continue;
		}
		if (c === 0x22) inString = true;
		else if (c === 0x7b) depth += 1;
		else if (c === 0x7d) {
			depth -= 1;
			if (depth === 0) return { jsonStart: start, jsonEnd: i };
		}
	}
	return null;
}

const found = locateHeader(probe);
if (found === null) {
	console.error("could not locate asar header in " + archive);
	process.exit(2);
}
const header = JSON.parse(probe.slice(found.jsonStart, found.jsonEnd + 1).toString("utf8"));
// File content begins after the JSON header, 4-byte aligned.
const dataStart = Math.ceil((found.jsonEnd + 1) / 4) * 4;

function lookup(inner) {
	const parts = inner.split("/").filter(Boolean);
	let node = header;
	for (const part of parts) {
		node = node.files ? node.files[part] : undefined;
		if (!node) return null;
	}
	return node;
}

function walk(node, prefix, out) {
	for (const key of Object.keys(node.files || {})) {
		const child = node.files[key];
		const full = prefix + "/" + key;
		if (child.files) walk(child, full, out);
		else out.push({ path: full, size: child.size, offset: Number(child.offset) });
	}
}

function readEntry(entry) {
	const buf = Buffer.alloc(entry.size);
	fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
	return buf;
}

if (mode === "list") {
	const all = [];
	walk(header, "", all);
	const pattern = new RegExp(process.argv[4] || ".", "i");
	const limit = Number(process.argv[5] || 200);
	const hits = all.filter((e) => pattern.test(e.path));
	for (const hit of hits.slice(0, limit)) console.log(hit.path + "\t" + hit.size);
	console.error("MATCHED " + hits.length + " / TOTAL " + all.length);
} else if (mode === "cat") {
	const entry = lookup(process.argv[4]);
	if (!entry || entry.files) {
		console.error("not a file: " + process.argv[4]);
		process.exit(3);
	}
	process.stdout.write(readEntry(entry));
} else if (mode === "extract") {
	const entry = lookup(process.argv[4]);
	const out = process.argv[5];
	if (!entry || entry.files) {
		console.error("not a file: " + process.argv[4]);
		process.exit(3);
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, readEntry(entry));
	console.error("extracted " + entry.size + " bytes -> " + out);
} else {
	console.error("usage: asar.cjs list|cat|extract ...");
	process.exit(1);
}
