/**
 * Device roster store for the dsh-device-monitor plugin.
 *
 * Devices live in a single JSON document under `$DSH_HOME`, written
 * atomically (temp file + rename) so a crash mid-write cannot truncate the
 * roster. The roster is capped at {@link MAX_DEVICES}; the cap is enforced at
 * create time, not at read time, so an over-full file still loads.
 *
 * Credentials are stored as plaintext in a user-owned file, exactly like the
 * reference device-manager system. They are never logged and never leave the
 * host half: the summary projection used by the browser side carries only
 * whether a secret is configured, never the secret itself.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { METRIC_KEYS, normalizeMetrics, hasMetricChoice } from "./metrics-keys.js";
import { applySettingsPatch, defaultSettings, normalizeIntervalSec, normalizeSettings } from "./settings.js";

/** The hard device cap requested for this plugin. */
export const MAX_DEVICES = 10;

/** Authentication kinds a device row may use. */
export const AUTH_KINDS = ["password", "key", "agent"];

/** Resolve `$DSH_HOME`, honouring the environment override first. */
export function dshHome() {
	const override = process.env.DSH_HOME;
	if (typeof override === "string" && override.trim() !== "") return override;
	return join(homedir(), ".dsh");
}

/** Path of the roster document. */
export function storePath() {
	return join(dshHome(), "dsh-device-monitor.json");
}

/**
 * A fresh, empty roster document.
 *
 * Version 2 added `settings` plus the per-device `metrics` / `intervalSec`
 * fields. A version-1 file upgrades by filling in the SETTINGS DEFAULTS but
 * deliberately NOT `device.metrics`: a device with no recorded metric choice
 * must render everything, and writing `DEFAULT_METRICS` into it during the
 * upgrade would silently hide the four metrics the user never chose.
 * See DESIGN.md §7.4/D10.
 */
function emptyDoc() {
	return { version: 2, devices: [], settings: defaultSettings() };
}

/** Turn arbitrary text into a url-safe slug. */
export function slugify(value) {
	const slug = String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "device" : slug;
}

/** Read the roster, tolerating a missing or unreadable file. */
function readDoc(path) {
	if (!existsSync(path)) return emptyDoc();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.devices)) return emptyDoc();
		return {
			version: 2,
			devices: parsed.devices.filter((row) => typeof row === "object" && row !== null),
			// A v1 document has no `settings` key at all, so normalizeSettings
			// fills every default. Round-tripping a v2 document through the same
			// clamp keeps a hand-edited out-of-range value away from the
			// collectors.
			settings: normalizeSettings(parsed.settings, METRIC_KEYS),
		};
	} catch {
		// A corrupt roster must not take the whole plugin down; the user can
		// still add devices and the next save replaces the bad document.
		return emptyDoc();
	}
}

/** Write the roster atomically with owner-only permissions. */
function writeDoc(path, doc) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Throw a validation error the route layer can surface as HTTP 400. */
function invalid(message) {
	const error = new Error(message);
	error.statusCode = 400;
	return error;
}

/** Normalize and validate an inbound device payload. */
export function normalizePayload(payload, { partial = false } = {}) {
	if (typeof payload !== "object" || payload === null) throw invalid("device payload must be an object");
	const out = {};
	const str = (key) => {
		if (!(key in payload)) return undefined;
		const raw = payload[key];
		return raw === undefined || raw === null ? undefined : String(raw).trim();
	};

	const name = str("name");
	const host = str("host");
	const username = str("username") ?? str("user");
	if (!partial || name !== undefined) {
		if (name === undefined || name === "") throw invalid("name is required");
		out.name = name;
	}
	if (!partial || host !== undefined) {
		if (host === undefined || host === "") throw invalid("host is required");
		out.host = host;
	}
	if (!partial || username !== undefined) {
		if (username === undefined || username === "") throw invalid("username is required");
		out.username = username;
	}

	if ("port" in payload) {
		const port = payload.port === undefined || payload.port === null || payload.port === "" ? 22 : Number(payload.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid("port must be an integer between 1 and 65535");
		out.port = port;
	} else if (!partial) {
		out.port = 22;
	}

	if ("auth" in payload) {
		const auth = payload.auth;
		const kind = typeof auth === "string" ? auth : typeof auth === "object" && auth !== null ? auth.kind : undefined;
		if (kind !== undefined && !AUTH_KINDS.includes(kind)) throw invalid(`auth kind must be one of ${AUTH_KINDS.join(", ")}`);
		const password = typeof auth === "object" && auth !== null ? auth.password : undefined;
		const privateKeyPath = typeof auth === "object" && auth !== null ? auth.privateKeyPath : undefined;
		out.auth = {
			kind: kind ?? "password",
			...(password === undefined || password === null ? {} : { password: String(password) }),
			...(privateKeyPath === undefined || privateKeyPath === null ? {} : { privateKeyPath: String(privateKeyPath).trim() }),
		};
	} else if (!partial) {
		out.auth = { kind: "password" };
	}
	// Credentials may also be given as bare top-level keys, which is the shape a
	// simple form posts; fold them into `auth` so there is only one store shape.
	if ("password" in payload || "privateKeyPath" in payload) {
		const password = str("password");
		const privateKeyPath = str("privateKeyPath");
		out.auth = {
			kind: out.auth?.kind ?? (privateKeyPath !== undefined ? "key" : "password"),
			...out.auth,
			...(password === undefined ? {} : { password }),
			...(privateKeyPath === undefined ? {} : { privateKeyPath }),
		};
	}

	// `group` used to live in this list as well. It was accepted, stored and
	// shipped to the browser, but nothing ever set it and nothing ever drew it —
	// not the form, not the card, not the detail view, not the docs, and not the
	// reference system this plugin was ported from. A field that can be neither
	// written nor read is not a feature, it is a rumour, so it was removed
	// rather than given a UI nobody asked for. A roster on disk that still
	// carries the key keeps it harmlessly (`readDoc` passes rows through); it
	// simply stops being normalized or summarized.
	const optionalStrings = ["description", "location"];
	for (const key of optionalStrings) {
		if (key in payload) {
			const value = str(key);
			out[key] = value === undefined || value === "" ? undefined : value;
		} else if (!partial) {
			out[key] = undefined;
		}
	}

	if ("tags" in payload) {
		const tags = payload.tags;
		if (tags === undefined || tags === null) out.tags = [];
		else if (!Array.isArray(tags)) throw invalid("tags must be an array of strings");
		else out.tags = tags.map((tag) => String(tag).trim()).filter(Boolean);
	} else if (!partial) {
		out.tags = [];
	}

	// The metric selection. Omitting the field on a PATCH must leave the existing
	// ticks alone (`update` only spreads keys that are present); an explicit
	// `[]` is a real choice and normalizes to ALWAYS_METRICS only.
	if ("metrics" in payload) {
		out.metrics = normalizeMetrics(payload.metrics);
	} else if (!partial) {
		// A brand-new device has no recorded choice. Leaving the field OFF (rather
		// than writing DEFAULT_METRICS) is deliberate: `undefined` means "render
		// everything", which is the safe default for a user who has not been to
		// the settings screen yet. See DESIGN.md §5.1/D10.
		out.metrics = undefined;
	}

	// Per-device poll cadence override. Absent/null means "use the global value".
	if ("intervalSec" in payload) {
		const raw = payload.intervalSec;
		if (raw === undefined || raw === null || raw === "") out.intervalSec = undefined;
		else {
			const n = Number(raw);
			if (!Number.isFinite(n)) throw invalid("intervalSec must be a number of seconds");
			out.intervalSec = normalizeIntervalSec(n);
		}
	} else if (!partial) {
		out.intervalSec = undefined;
	}

	return out;
}

/**
 * The browser-facing projection of a device: identity, connection target and
 * whether a credential is configured — never the credential itself.
 *
 * `metrics` is passed through as the RAW stored value, which may be
 * `undefined`. That is intentional: the browser needs to tell "no recorded
 * choice" (render everything) apart from "explicitly empty" (render only the
 * always-on rows), and the two collapse into one if this normalizes here.
 */
export function summarize(device) {
	return {
		id: device.id,
		name: device.name,
		host: device.host,
		port: device.port,
		username: device.username,
		authKind: device.auth?.kind ?? "password",
		hasPassword: Boolean(device.auth?.password),
		hasPrivateKey: Boolean(device.auth?.privateKeyPath),
		description: device.description,
		location: device.location,
		tags: Array.isArray(device.tags) ? device.tags : [],
		metrics: hasMetricChoice(device.metrics) ? normalizeMetrics(device.metrics) : undefined,
		intervalSec: typeof device.intervalSec === "number" ? device.intervalSec : undefined,
		createdAt: device.createdAt,
		updatedAt: device.updatedAt,
	};
}

/**
 * The metric keys to actually collect for a device.
 * `undefined` = collect everything (the safe default for an unconfigured row).
 */
export function metricsOf(device) {
	if (device === undefined || device === null) return undefined;
	if (!hasMetricChoice(device.metrics)) return undefined;
	return normalizeMetrics(device.metrics);
}

/** The effective poll interval for a device, in milliseconds. */
export function intervalMsOf(device, globalSec) {
	const sec = typeof device?.intervalSec === "number" ? device.intervalSec : globalSec;
	return normalizeIntervalSec(sec) * 1000;
}

/** The device roster, capped at {@link MAX_DEVICES}. */
export class DeviceStore {
	constructor(path = storePath()) {
		this.path = path;
		this.cache = undefined;
		this.cacheMtime = -1;
	}

	/** The roster document, re-read when the file changed underneath us. */
	doc() {
		let mtime = -1;
		try {
			mtime = statSync(this.path).mtimeMs;
		} catch {
			mtime = -1;
		}
		if (this.cache === undefined || mtime !== this.cacheMtime) {
			this.cache = readDoc(this.path);
			this.cacheMtime = mtime;
		}
		return this.cache;
	}

	/** Every stored device, in insertion order. */
	list() {
		return this.doc().devices.slice();
	}

	/** Summary projection of every device, in insertion order. */
	summaries() {
		return this.list().map(summarize);
	}

	/** The raw device with this id, or undefined. */
	find(id) {
		return this.doc().devices.find((device) => device.id === id);
	}

	/** True when the roster already holds {@link MAX_DEVICES} devices. */
	isFull() {
		return this.doc().devices.length >= MAX_DEVICES;
	}

	/** Derive a roster-unique id from a device name. */
	uniqueId(name) {
		const devices = this.doc().devices;
		const base = slugify(name);
		if (!devices.some((device) => device.id === base)) return base;
		for (let n = 2; n < 1000; n += 1) {
			const candidate = `${base}-${n}`;
			if (!devices.some((device) => device.id === candidate)) return candidate;
		}
		return `${base}-${Date.now()}`;
	}

	/** Add a device. Throws when the roster is already at the cap. */
	create(payload) {
		const fields = normalizePayload(payload);
		const doc = this.doc();
		if (doc.devices.length >= MAX_DEVICES) {
			const error = new Error(`device limit reached: at most ${MAX_DEVICES} devices may be registered`);
			error.statusCode = 409;
			throw error;
		}
		const now = new Date().toISOString();
		const device = {
			id: this.uniqueId(fields.name),
			...fields,
			tags: fields.tags ?? [],
			createdAt: now,
			updatedAt: now,
		};
		doc.devices.push(device);
		writeDoc(this.path, doc);
		this.invalidate();
		return device;
	}

	/** Patch a device in place; omitted keys are left alone. */
	update(id, patch) {
		const doc = this.doc();
		const index = doc.devices.findIndex((device) => device.id === id);
		if (index < 0) {
			const error = new Error(`device not found: ${id}`);
			error.statusCode = 404;
			throw error;
		}
		const fields = normalizePayload(patch, { partial: true });
		const current = doc.devices[index];
		const next = {
			...current,
			...fields,
			auth: fields.auth === undefined ? current.auth : { ...current.auth, ...fields.auth },
			tags: fields.tags ?? current.tags ?? [],
			updatedAt: new Date().toISOString(),
		};
		doc.devices[index] = next;
		writeDoc(this.path, doc);
		this.invalidate();
		return next;
	}

	/** Remove a device; returns the removed row. */
	delete(id) {
		const doc = this.doc();
		const index = doc.devices.findIndex((device) => device.id === id);
		if (index < 0) {
			const error = new Error(`device not found: ${id}`);
			error.statusCode = 404;
			throw error;
		}
		const [removed] = doc.devices.splice(index, 1);
		writeDoc(this.path, doc);
		this.invalidate();
		return removed;
	}

	/** Drop the in-memory copy so the next read hits the file. */
	invalidate() {
		this.cache = undefined;
		this.cacheMtime = -1;
	}

	/** The normalized global settings subtree. */
	settings() {
		return this.doc().settings;
	}

	/**
	 * Patch the settings subtree and persist it in the SAME atomic write as the
	 * roster, so a settings change can never land beside a half-written device
	 * edit (DESIGN.md §7.4/D13).
	 *
	 * @returns `{settings, changed}` where `changed` lists field NAMES only.
	 */
	updateSettings(patch) {
		const doc = this.doc();
		const { settings, changed } = applySettingsPatch(doc.settings, patch, METRIC_KEYS);
		if (changed.length === 0) return { settings, changed };
		doc.settings = settings;
		writeDoc(this.path, doc);
		this.invalidate();
		return { settings, changed };
	}
}
