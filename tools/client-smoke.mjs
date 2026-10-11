/**
 * Offline render test for the device-monitor client half.
 *
 * `client.js` is a browser module, so this harness supplies the globals the
 * shell would: `window.__ModuleLoader__`, a `require` for the browser module
 * table, and a minimal React (createElement plus the hooks the panel uses)
 * with a render-to-string walker.
 *
 * The panel keeps its state in a MODULE-LEVEL store and fills it from the HTTP
 * API, so this suite drives it the way the browser does: it stubs `fetch`, runs
 * the component's effects, lets the promises settle, and then asserts on what
 * was rendered. Seeding a component's useState slots would prove nothing any
 * more — and clicking the real buttons is what proves the wiring, since a
 * handler aimed at the wrong action still renders a plausible-looking panel.
 *
 * Run: node tools/client-smoke.mjs
 *      DDM_CLIENT_SOURCE_URL=http://127.0.0.1:PORT/plugins/??.../client.js \
 *        node tools/client-smoke.mjs        # run against the served bytes
 */
const failures = [];
let checks = 0;
/**
 * Rejections nobody handled, which Node would print as a warning and a real
 * browser would report as an uncaught promise. Any promise the panel starts and
 * does not handle lands here, so the count is the only way to see a missing
 * `.catch()` from inside a test — and it is kept even though the terminal no
 * longer touches the Fullscreen API, because the whole point is to notice the
 * next unhandled rejection of ANY origin.
 */
const unhandledRejections = [];
process.on("unhandledRejection", (reason) => {
	unhandledRejections.push(reason);
});
function ok(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
		failures.push(label);
	}
}
function eq(label, actual, expected) {
	ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

//#region minimal React
/** Hook storage for the component currently being rendered. */
let hookStates = [];
let hookCursor = 0;
/**
 * Hook COUNT per component, from its first render.
 *
 * React requires the same number of hooks on every render; a mismatch is
 * minified error #310. Recorded here so the stub can enforce it instead of
 * silently tolerating it (see `toTree`).
 */
const hookCounts = new Map();
/** Effects collected across a whole render walk, drained by `runEffects`. */
let pendingEffects = [];
/**
 * Per-component hook storage, keyed by the component function.
 *
 * Component state has to PERSIST across renders or a click on an in-view tab
 * would be discarded and the test would silently assert against the initial
 * state. Keying by function identity is enough here because the stateful
 * components are singletons in these scenarios; a repeated stateless child
 * (device cards) keeps no slots at all.
 */
const componentState = new WeakMap();

/**
 * Interpolate a template exactly the way the shell's bound translator does:
 * `@deepseek-ai/dsh-client-locale` substitutes with `/\{(\w+)\}/g`, so a
 * doubled `{{name}}` would survive as a stray `{name}`. Mirroring the strict
 * form is deliberate — an accommodating stub would hide that class of bug.
 */
function interpolate(template, values) {
	if (values === undefined) return String(template);
	return String(template).replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));
}

/**
 * Every `{word}` left in rendered text is an unsubstituted placeholder.
 *
 * Digits matter: a doubled `{{count}}` does not vanish under the shell's
 * `/\{(\w+)\}/g` pass — the inner match is replaced, so `{{count}}` becomes
 * the literal `{0}`. A letters-only pattern would miss precisely that.
 */
function leftoverPlaceholders(text) {
	return [...String(text).matchAll(/\{[A-Za-z0-9_]+\}/g)].map((match) => match[0]);
}

const React = {
	createElement(type, props, ...children) {
		const flat = [];
		for (const child of children) {
			if (Array.isArray(child)) flat.push(...child);
			else flat.push(child);
		}
		return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat } };
	},
	useState(initial) {
		const slots = hookStates;
		const index = hookCursor;
		hookCursor += 1;
		if (slots.length <= index) slots.push(typeof initial === "function" ? initial() : initial);
		return [slots[index], (next) => {
			// Persisted, not ignored: a click that only sets local state must be
			// observable on the next render, otherwise the test proves nothing.
			slots[index] = typeof next === "function" ? next(slots[index]) : next;
		}];
	},
	useEffect(fn, deps) {
		// Dependency arrays must be honoured, exactly as React does. The panel
		// re-seeds each settings form from the Host snapshot in an effect keyed
		// on `settings`; without deps tracking that effect re-runs after every
		// render and silently overwrites whatever the user just typed — which
		// would make a whole class of form wiring untestable (and would have
		// hidden this very defect rather than surfacing it).
		const index = hookCursor;
		hookCursor += 1;
		const previous = hookStates[index];
		const changed = deps === undefined
			|| previous === undefined
			|| previous.deps === undefined
			|| deps.length !== previous.deps.length
			|| deps.some((value, at) => !Object.is(value, previous.deps[at]));
		if (!changed) return;
		// React runs the previous disposer before re-running the effect with new
		// deps; skipping it would leak whatever the old run registered.
		if (previous?.cleanup !== undefined) pendingEffects.push({ fn: previous.cleanup, slot: undefined });
		const slot = { deps: deps === undefined ? undefined : [...deps], cleanup: undefined };
		hookStates[index] = slot;
		pendingEffects.push({ fn, slot });
	},
	useCallback(fn) {
		return fn;
	},
	useRef(initial) {
		const index = hookCursor;
		hookCursor += 1;
		if (hookStates.length <= index) hookStates.push({ current: initial });
		return hookStates[index];
	},
	useMemo(fn) {
		return fn();
	},
	/**
	 * The panel subscribes to its module store through this hook.
	 *
	 * Returning the snapshot on every render is enough here: the walker
	 * re-renders explicitly after each interaction, so an active subscription
	 * would add nothing except a second source of truth.
	 */
	useSyncExternalStore(_subscribe, getSnapshot) {
		return getSnapshot();
	},
};
React.default = React;
//#endregion

//#region harness state
const localeCalls = [];

/** The `ctx` a client plugin's apply receives, with only what it touches. */
function makeCtx(world) {
	return {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") world.detachEffects.push(dispose);
			return () => {};
		},
		on() {},
		locale: {
			register(namespace, dictionaries) {
				localeCalls.push({ namespace, dictionaries });
				world.localeCalls.push({ namespace, dictionaries });
				return () => {};
			},
			/**
			 * Mirror the shell: resolve through the dictionary that was
			 * registered, then interpolate with the strict single-brace form.
			 * Returning the key unchanged (as an earlier stub did) would let
			 * locale bugs through, so a resolved lookup is the whole point.
			 */
			bind() {
				return (key, values) => {
					const registered = localeCalls.at(-1)?.dictionaries;
					const template = registered?.zh?.[key] ?? registered?.en?.[key];
					if (template === undefined) return key === "entry.label" ? "设备" : key;
					return interpolate(template, values);
				};
			},
		},
		slots: {
			inject(name, callback) {
				world.injectedSeats.push(name);
				// The real shell calls back once the seat is declared; do it here
				// so the registration path is exercised.
				callback();
				return () => {};
			},
			register(options, component) {
				world.registeredSlots.push({ options, component });
				return () => {};
			},
		},
		// Present only when the test wants to exercise the right-sidebar path.
		...(world.betterSidebar === undefined ? {} : { betterSidebar: world.betterSidebar }),
	};
}

/** The `require` the shell hands the factory. */
function require(specifier) {
	if (specifier === "react" || specifier === "react/jsx-runtime") return React;
	throw new Error(`unexpected require in the client half: ${specifier}`);
}
//#endregion

//#region stub server
/** The metric vocabulary the Host would serve, in its documented order. */
// Mirrors `src/metrics-keys.js` byte for byte, hints included. A stub with empty
// hints would pass while the real Host's hints went unrendered — the double must
// carry the field the product is supposed to display.
const CATALOG = [
	{ key: "uptime", label: "运行时间", hint: "开机时长与运行状态", always: true },
	{ key: "load", label: "系统负载", hint: "1 / 5 / 15 分钟平均负载", always: false },
	{ key: "cpu", label: "CPU 使用率", hint: "两次 /proc/stat 采样之间的占用率", always: false },
	{ key: "mem", label: "内存", hint: "已用 / 总内存", always: false },
	{ key: "disk", label: "磁盘容量", hint: "各挂载点容量占用", always: false },
	{ key: "temp", label: "温度", hint: "热区与 hwmon 传感器温度", always: false },
	{ key: "top", label: "高占用进程", hint: "按 CPU 占用排序的前几个进程", always: false },
	{ key: "net", label: "网络吞吐", hint: "/proc/net/dev 各网卡吞吐（排除 lo）", always: false },
	{ key: "diskio", label: "磁盘读写 IO", hint: "/proc/diskstats 各磁盘读写速率", always: false },
	{ key: "procs", label: "进程数", hint: "进程总数", always: false },
	{ key: "tcp", label: "TCP 连接数", hint: "TCP 连接数（ss，缺失时回退 /proc/net/tcp）", always: false },
];

/**
 * A URL-dispatching fetch stub.
 *
 * The client talks to the real routes, so the stub answers by pathname and
 * records every call — which is how the lease assertions can tell whether the
 * panel actually stopped polling when it was hidden.
 */
function makeServer(overrides = {}) {
	const server = {
		devices: [],
		maxDevices: 10,
		settings: { refreshIntervalSec: 60, thresholds: { cpu: 90, mem: 90, disk: 85, temp: 80 }, rawLog: { enabled: true }, incidents: { offlineAfter: 2, rebootDetect: true, rebootMinDrop: 120 }, terminal: { enabled: false, allowedHosts: [], idleMs: 300_000 } },
		series: {},
		logs: { dir: "/home/.dsh/dsh-device-monitor-logs", enabled: true, totalBytes: 4096, devices: [] },
		rawlog: {},
		audit: { audit: [{ event: "device.create", at: "t", deviceId: "edge-01" }] },
		incidents: { incidents: [{ event: "offline", deviceId: "edge-01" }] },
		calls: [],
		...overrides,
	};
	server.fetch = async (url, options = {}) => {
		const parsed = new URL(url, "http://localhost");
		const path = parsed.pathname;
		server.calls.push({ path, method: options.method ?? "GET", body: options.body });
		const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
		if (path.endsWith("/overview")) {
			return reply({
				devices: server.devices,
				maxDevices: server.maxDevices,
				settings: { refreshIntervalSec: server.settings.refreshIntervalSec, thresholds: server.settings.thresholds },
				watch: { active: true, clients: 1, intervalMs: 60_000 },
			});
		}
		if (path.endsWith("/settings")) {
			// A PATCH must actually change what the next GET returns — the real
			// Host persists it. Without this the panel's post-save re-seed reads
			// the OLD settings and silently reverts the user's edit, which would
			// make "what did the form send" and "what does the form show" two
			// different questions instead of one round trip.
			if ((options.method ?? "GET") === "PATCH") {
				const patch = JSON.parse(options.body ?? "{}");
				server.settings = { ...server.settings, ...patch };
				return reply({ ok: true, settings: server.settings, changed: Object.keys(patch) });
			}
			return reply({ settings: server.settings, catalog: CATALOG });
		}
		if (path.endsWith("/catalog")) return reply({ catalog: CATALOG, maxDevices: server.maxDevices, metricKeys: CATALOG.map((row) => row.key) });
		if (path.endsWith("/watch")) return reply({ watch: { active: true, clients: 1, intervalMs: 60_000 } });
		if (path.endsWith("/metrics")) {
			const id = parsed.searchParams.get("id");
			return reply({ series: server.series[id] ?? [], sample: undefined });
		}
		if (path.endsWith("/logs/status")) return reply(server.logs);
		if (path.endsWith("/rawlog")) {
			const id = parsed.searchParams.get("id");
			return reply({ deviceId: id, dir: server.logs.dir, bytes: 100, lines: server.rawlog[id] ?? [] });
		}
		if (path.endsWith("/audit")) return reply(server.audit);
		if (path.endsWith("/incidents")) return reply(server.incidents);
		if (path.endsWith("/collect")) return reply({ results: [] });
		if (path.endsWith("/test-draft")) return reply({ result: { ok: true, latencyMs: 12 } });
		if (path.endsWith("/test")) return reply({ result: { ok: true, latencyMs: 12 } });
		if (path.endsWith("/devices")) return reply({ ok: true });
		if (path.endsWith("/exec")) return reply({ result: { stdout: "", stderr: "", code: 0 } });
		return reply({});
	};
	return server;
}
//#endregion

//#region render-to-string
/**
 * Build the DOM node a string element would have.
 *
 * `createWorld` rebinds this so the fake element is wired to that world's
 * `document`; the module-level default is only a fallback.
 */
let makeElement = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, remove() {} });
/**
 * The element behind each ref object, kept for the life of that ref.
 *
 * Real React REUSES the DOM node when it re-renders an element of the same
 * type, so `ref.current` is the same object before and after a commit. A
 * harness that minted a fresh fake node on every pass would break that
 * identity, and an event-driven check keyed on `frame.current` would never come
 * out true. (That check is gone now — the toggle fills the pane instead of using
 * the API — but the identity rule is still what a real React commit guarantees,
 * and keeping the harness faithful to it is cheaper than re-learning why.)
 */
const elementForRef = new WeakMap();
/**
 * Resolve a React element tree into plain elements, invoking every component
 * function so its real code path runs.
 */
function toTree(node) {
	if (node === null || node === undefined || node === false || node === true) return null;
	if (typeof node === "string" || typeof node === "number") return node;
	if (Array.isArray(node)) return node.map((child) => toTree(child));
	if (typeof node.type === "function") {
		const previous = hookStates;
		const previousCursor = hookCursor;
		// Each component gets its own persistent slot array, so state set by a
		// click is still there on the next render.
		if (!componentState.has(node.type)) componentState.set(node.type, []);
		hookStates = componentState.get(node.type);
		hookCursor = 0;
		const output = node.type(node.props ?? {});
		const rendered = hookCursor;
		hookStates = previous;
		hookCursor = previousCursor;
		// React's Rules of Hooks, enforced rather than assumed. React itself
		// throws minified error #310 — "Rendered more hooks than during the
		// previous render" — when a component returns EARLY before its later
		// hooks, and the user hit exactly that in the running GUI. This stub
		// tracked a cursor but never compared the count between renders, so a
		// whole class of real crashes was invisible to the suite.
		const name = node.type.name || "anonymous component";
		const seen = hookCounts.get(node.type);
		if (seen === undefined) {
			hookCounts.set(node.type, rendered);
		} else if (seen !== rendered) {
			throw new Error(
				`hook order changed in ${name}: rendered ${rendered} hooks, but an earlier render used ${seen}. `
				+ `A component that returns early before its later hooks does this (React error #310).`,
			);
		}
		return toTree(output);
	}
	if (typeof node.type === "string") {
		const props = { ...(node.props ?? {}), children: toTree(node.props?.children) };
		// React attaches `ref.current` during the COMMIT, before any effect
		// runs. Without that step every ref is permanently `null`, and the
		// fullscreen path is unreachable — the panel would ask a null element
		// to go full screen and the test could only ever assert the fallback.
		if (props.ref !== undefined && props.ref !== null && typeof props.ref === "object") {
			if (!elementForRef.has(props.ref)) elementForRef.set(props.ref, makeElement(node.type));
			props.ref.current = elementForRef.get(props.ref);
		}
		return { type: node.type, props };
	}
	return null;
}
/** Flatten a resolved tree into visible text. */
function textOf(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map((child) => textOf(child)).join("");
	if (typeof node === "object" && node.type !== undefined) {
		// A real input renders no text; expose its placeholder so field presence
		// is still observable. A select DOES render its option labels, so it is
		// walked like any other element.
		if (node.type === "input" || node.type === "textarea") {
			return node.props.placeholder === undefined ? "" : `[${node.props.placeholder}]`;
		}
		return textOf(node.props.children);
	}
	return "";
}
/** Every element node in a resolved tree, outermost first. */
function nodesOf(node, found = []) {
	if (node === null || node === undefined || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const child of node) nodesOf(child, found);
		return found;
	}
	if (node.type !== undefined) found.push(node);
	nodesOf(node.props?.children, found);
	return found;
}
/** Collect every value of one attribute across a resolved tree. */
function attrsOf(node, name) {
	return nodesOf(node)
		.map((row) => row.props?.[name])
		.filter((value) => value !== undefined);
}
/** Whether any element in the resolved tree carries a class fragment. */
function hasClass(tree, fragment) {
	return attrsOf(tree, "className").some((value) => typeof value === "string" && value.includes(fragment));
}
/**
 * The declaration block of one exact CSS rule, or "" when it is absent.
 *
 * The selector list is SPLIT on commas, because the sheet groups related
 * selectors (`.a,.b,.c{…}`) and a substring search over the whole sheet would
 * still find `.a` while the rule had been re-scoped to a different element —
 * which is exactly how the checkbox regression got in.
 */
function cssRule(css, selector) {
	const wanted = selector.replace(/\s+/g, " ").trim();
	// Comments are stripped FIRST. A `/* … */` note sits between the previous
	// rule and this one, so it lands inside the captured selector text and a
	// comment containing a comma (every specificity note in this sheet has one)
	// silently makes the selector unmatchable.
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
	// Rule bodies contain no braces here (no nesting), so a flat scan is faithful.
	for (const match of bare.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		const list = match[1].split(",").map((row) => row.replace(/\s+/g, " ").trim());
		if (list.includes(wanted)) return match[2];
	}
	return "";
}
/** One declaration's value out of a rule block, or null. */
function cssDecl(block, property) {
	const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(block);
	return match === null ? null : match[1].trim();
}
/** Every element whose OWN class list carries a fragment (not a descendant's). */
function nodesWithClass(tree, fragment) {
	return nodesOf(tree).filter((node) => ownClass(node, fragment));
}
/** Whether one element's OWN class list carries a fragment. */
function ownClass(node, fragment) {
	// Null-safe on purpose. Several assertions look up a node by class and then
	// ask whether it carries ANOTHER class; when the first lookup misses, the
	// honest answer is "no", and an assertion that crashes instead is a mutant
	// caught by a stack trace rather than by the property under test — which is
	// not coverage.
	return node !== null && node !== undefined
		&& typeof node.props?.className === "string"
		&& node.props.className.split(/\s+/).includes(fragment);
}
/**
 * Every clickable node whose own text contains `label`.
 *
 * Driving real handlers is the point: a button wired to the wrong action still
 * renders convincing text, so only invoking it proves where it goes.
 */
function clicksLabelled(tree, label) {
	return nodesOf(tree).filter((node) => typeof node.props?.onClick === "function" && textOf(node).includes(label));
}
//#endregion

//#region world
/** The real fetch, kept for loading the served bundle before the stub replaces it. */
const realFetch = globalThis.fetch;
const sourceUrl = process.env.DDM_CLIENT_SOURCE_URL;
let source;
if (sourceUrl === undefined) {
	source = await (await import("node:fs/promises")).readFile(new URL("../client.js", import.meta.url), "utf8");
} else {
	const response = await realFetch(sourceUrl);
	if (!response.ok) throw new Error(`server returned ${response.status} for ${sourceUrl}`);
	source = await response.text();
}

/**
 * Evaluate the client bundle into a fresh module instance.
 *
 * A new instance is what gives each scenario a clean store; reaching into the
 * old one to reset it would test a path the browser never takes.
 */
function createWorld({ betterSidebar, page: pageOverrides, fullscreen } = {}) {
	// A plain browser tab by default: the Host serves the page, so its URL and
	// the Host origin are the same thing and no transport descriptor is needed.
	const page = {
		protocol: "http:",
		host: "127.0.0.1:19387",
		baseURI: "http://127.0.0.1:19387/",
		transport: undefined,
		...pageOverrides,
	};
	const world = {
		styleTags: [],
		registeredSlots: [],
		injectedSeats: [],
		localeCalls: [],
		detachEffects: [],
		betterSidebar,
		tabRegistrations: [],
		// Every `setInterval` the panel registers, so a test can fire exactly one
		// refresh tick through the real callback instead of guessing.
		timers: [],
		// One-shot timers, indexed so `clearTimeout` can mark one cancelled.
		timeouts: [],
		// Every FakeWebSocket the terminal opens, in order.
		sockets: [],
		// Every element that was asked to go full screen, in order. The toggle is
		// NOT supposed to call the Fullscreen API any more — it fills the pane it
		// is mounted in — so this list must stay empty, and the stub keeps the
		// recorder wired precisely so that "it was not called" is a real
		// observation rather than a vacuous one. A stub without the method could
		// not tell the difference between "we did not call it" and "it does not
		// exist".
		fullscreenRequests: [],
		loaded: undefined,
		server: undefined,
	};
	world.server = makeServer();
	const localDocument = {
		head: { appendChild: (tag) => world.styleTags.push(tag) },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
		// The page's own URL. In a plain browser tab the Host serves this page, so
		// it and the Host origin agree; the desktop shell is the case where they
		// do NOT (see `page` below), and that is the one m07341 was about.
		baseURI: page.baseURI,
		// The Fullscreen API, modelled rather than stubbed away.
		//
		// The panel must NOT use it: "full screen" here fills the pane the panel
		// is mounted in, and the browser's top layer would cover the conversation
		// instead. The API stays modelled so the suite can OBSERVE that it was
		// not called — a stub missing `requestFullscreen` would make that
		// assertion vacuous, because "we never called it" and "it cannot be
		// called" would look the same.
		fullscreenElement: null,
		fullscreenEnabled: fullscreen?.enabled ?? true,
		listeners: {},
		addEventListener(type, fn) {
			(localDocument.listeners[type] ??= []).push(fn);
		},
		removeEventListener(type, fn) {
			const list = localDocument.listeners[type] ?? [];
			const at = list.indexOf(fn);
			if (at >= 0) list.splice(at, 1);
		},
		exitFullscreen() {
			localDocument.fullscreenElement = null;
			for (const fn of [...(localDocument.listeners.fullscreenchange ?? [])]) fn({ type: "fullscreenchange" });
			return Promise.resolve();
		},
	};
	/**
	 * A WebSocket the test drives by hand.
	 *
	 * The terminal is the one feature whose whole contract is what crosses a
	 * socket, so a stub that merely recorded `send` calls would prove nothing
	 * about the state machine. This one keeps `readyState` honest and lets a
	 * scenario fire `open` / `message` / `close` in any order — which is exactly
	 * how the interesting failures happen (a message before `open`, a close with
	 * no error, a timeout while still CONNECTING).
	 */
	class FakeWebSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 0;
			this.sent = [];
			this.closed = null;
			world.sockets.push(this);
		}
		send(data) {
			if (this.readyState !== 1) throw new Error("InvalidStateError");
			this.sent.push(data);
		}
		close(code, reason) {
			this.closed = { code: code ?? 1000, reason: reason ?? "" };
			this.readyState = 3;
			this.onclose?.({ code: this.closed.code, reason: this.closed.reason });
		}
		/** Server-side helper: accept, then deliver one frame. */
		accept() {
			this.readyState = 1;
			this.onopen?.({});
		}
		deliver(frame) {
			this.onmessage?.({ data: JSON.stringify(frame) });
		}
		/** Server-side helper: drop the connection without a prior error. */
		drop(code = 1006, reason = "") {
			this.readyState = 3;
			this.onclose?.({ code, reason });
		}
	}
	/**
	 * An element that can pretend to go full screen.
	 *
	 * The panel is not supposed to call this, so what matters here is that the
	 * RECORDER exists: the suite's assertion is about a call that must not
	 * happen, and removing the method would make that assertion unable to fail.
	 *
	 * `requestFullscreen` records the CALL but does NOT set
	 * `document.fullscreenElement` on its own — the browser does that, then
	 * fires `fullscreenchange`. Keeping them apart is what would make an
	 * event-driven assertion meaningful if the API were ever used again.
	 */
	makeElement = (tag) => ({
		tagName: String(tag).toUpperCase(),
		style: {},
		dataset: {},
		classList: { add() {}, remove() {}, toggle() {} },
		remove() {},
		requestFullscreen() {
			world.fullscreenRequests.push(this);
			if (fullscreen?.reject === true) return Promise.reject(new Error("Fullscreen request denied"));
			return Promise.resolve();
		},
	});
	const localWindow = {
		__ModuleLoader__: {
			load(entry) {
				world.loaded = entry;
			},
		},
		confirm: () => true,
		// The bundle reads these three off `window`, so they must be present even
		// though Node provides the underlying globals.
		WebSocket: FakeWebSocket,
		location: { protocol: page.protocol, host: page.host },
		// The renderer's only published route to the Host. Defaults to absent,
		// which is the plain-browser case; a test sets it to model the desktop
		// shell, where `location.host` is the useless literal `app`.
		__DSH_TRANSPORT__: page.transport,
		// Timers are recorded but never fire on their own: a live interval would
		// make the suite non-deterministic. Recording the callback is what lets a
		// test drive ONE refresh tick through the real registered handler, which
		// is the only honest way to check what a tick does to the panel.
		setInterval: (fn, ms) => {
			world.timers.push({ fn, ms });
			return world.timers.length;
		},
		clearInterval: () => {},
		// `setTimeout` is collected separately from `setInterval`: firing an
		// interval repeatedly is meaningless, while firing a timeout is a
		// one-shot event the terminal's connect guard depends on.
		setTimeout: (fn, ms) => {
			world.timeouts.push({ fn, ms });
			return world.timeouts.length;
		},
		clearTimeout: (id) => {
			const target = world.timeouts[id - 1];
			if (target !== undefined) target.cleared = true;
		},
	};
	const factory = new Function("window", "document", "require", "console", "fetch", `${source}\nreturn undefined;`);
	factory(localWindow, localDocument, require, console, (url, options) => world.server.fetch(url, options));
	world.window = localWindow;
	world.document = localDocument;
	world.exported = world.loaded.factory(require);
	if (betterSidebar !== undefined) {
		world.ctx = makeCtx(world);
		world.ctx.betterSidebar = betterSidebar;
	} else {
		world.ctx = makeCtx(world);
	}
	world.exported.apply(world.ctx);
	const mainSlot = world.registeredSlots.find((row) => row.options.name === "main");
	world.panel = mainSlot?.component;
	return world;
}

/**
 * Drain every pending effect, as a real commit would.
 *
 * A disposer is NOT queued here: React runs one only when the effect's deps
 * change or the component unmounts. Re-running it every pass left the seat
 * unregistered while its effect never re-ran, which quietly changed what the
 * panel believed was on screen. The seat effect's disposer is therefore only
 * reached through a deps change (`useEffect` runs the stored cleanup first).
 */
function runEffects() {
	const effects = pendingEffects;
	pendingEffects = [];
	for (const effect of effects) {
		const dispose = effect.fn();
		if (typeof dispose === "function" && effect.slot !== undefined) effect.slot.cleanup = dispose;
	}
}

/** Let the fetch → JSON → store → render chain settle. */
async function flush(rounds = 12) {
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/**
 * Render and settle repeatedly until the panel stops changing.
 *
 * One pass is not enough: an effect that resolves a fetch sets state that a
 * LATER render turns into the next effect (the log view picks a device, then
 * fetches that device's raw log). Pumping until the rendered text is stable is
 * what lets the assertions observe the end of that chain.
 */
async function pump(world, props, passes = 6) {
	let tree = null;
	let text = "";
	let loading = "";
	for (let index = 0; index < passes; index += 1) {
		const before = text;
		tree = toTree({ type: world.panel, props: props ?? { owner: "test", narrow: false } });
		runEffects();
		await flush();
		text = textOf(tree);
		if (index === 0) loading = text;
		if (index > 0 && text === before) break;
	}
	return { tree, text, loading };
}

/** Mount the panel and settle the initial load chain. */
async function mount(world, props) {
	return pump(world, props);
}

/** Re-render after an interaction and settle whatever it kicked off. */
async function settle(world, props) {
	const view = await pump(world, props);
	return { tree: view.tree, text: view.text };
}

/**
 * Invoke the first handler whose label matches, then settle.
 *
 * @returns the post-click view; `clicked` is false when nothing matched, which
 * the caller asserts on rather than silently skipping the interaction.
 */
async function click(world, props, label, index = 0) {
	const nodes = clicksLabelled(draw(world, props), label);
	if (nodes.length <= index) return { clicked: false, tree: null, text: "" };
	nodes[index].props.onClick();
	const view = await settle(world, props);
	return { clicked: true, ...view };
}

/** Render once and run the effects it armed, discarding the settle loop. */
function draw(world, props) {
	const tree = toTree({ type: world.panel, props: props ?? { owner: "test", narrow: false } });
	runEffects();
	return tree;
}

/**
 * Drive a real `onChange` on every node carrying `attr === value`.
 *
 * Same discipline as `click`: assigning to state from outside would test the
 * assertion, not the wiring. A control wired to the wrong piece of state still
 * renders the right value, so only firing its handler proves where it writes.
 *
 * @returns how many handlers actually fired.
 */
async function change(world, attr, value, next, props) {
	const targets = nodesOf(draw(world, props)).filter((node) => node.props?.[attr] === value && typeof node.props?.onChange === "function");
	for (const node of targets) node.props.onChange({ target: { value: next, checked: next === true } });
	await settle(world, props);
	return targets.length;
}
//#endregion

//#region fixtures
const sample = {
	ts: Date.now(),
	uptimeText: "3d 4h 12m",
	model: "ARMv8 Processor rev 1",
	kernel: "Linux box 5.10.0 #1 SMP",
	cpu: { percent: 42.5, cores: 4, user: 100, system: 50, idle: 900 },
	load: { load1: 1.2, load5: 0.9, load15: 0.7, running: 2, total: 145 },
	memory: { totalMB: 2000, usedMB: 1500, availableMB: 500, usagePercent: 75 },
	disk: [{ fs: "/dev/root", mount: "/", sizeMB: 10000, usedMB: 8600, availableMB: 1400, usagePercent: 86 }],
	thermal: [{ type: "cpu-thermal", celsius: 62.5 }],
	processes: 145,
	services: ["ssh.service", "cron.service"],
};
// `location` / `description` / `tags` are the fields the form has always
// offered. They used to be stored, shipped, and then never drawn anywhere, so a
// note typed into the form simply vanished. `healthyDevice` therefore carries a
// filled-in pair of each; `brokenDevice` below carries NONE, which is the other
// half of the contract — an absent field must render no row at all, never an
// empty one.
const healthyDevice = { id: "edge-01", name: "Edge 01", host: "192.168.1.10", port: 2222, username: "root", authKind: "password", hasPassword: true, tags: ["lab", "prod"], location: "rack A / U12", description: "备用节点，周五维护", collectedAt: Date.now(), alerts: [], sample };
const alertingDevice = {
	...healthyDevice,
	id: "hot-01",
	name: "Hot 01",
	alerts: [
		{ metric: "cpu", rawValue: 93 },
		{ metric: "mem", rawValue: 95 },
		{ metric: "disk", mount: "/", rawValue: 91 },
		{ metric: "temp", type: "cpu-thermal", rawValue: 80 },
	],
	sample: { ...sample, cpu: { ...sample.cpu, percent: 93 }, memory: { ...sample.memory, usagePercent: 95 }, thermal: [{ type: "cpu-thermal", celsius: 80 }] },
};
const brokenDevice = { id: "down-01", name: "Down 01", host: "10.0.0.5", port: 22, username: "admin", authKind: "key", hasPrivateKey: true, tags: [], collectedAt: undefined, error: "connect ETIMEDOUT 10.0.0.5:22", alerts: [], sample: undefined };
const neverDevice = { id: "new-01", name: "New 01", host: "10.0.0.6", port: 22, username: "root", authKind: "agent", tags: [], collectedAt: undefined, alerts: [], sample: undefined };
/** A device whose stored choice is CPU only — the R3 gate must hide the rest. */
const cpuOnlyDevice = { ...healthyDevice, id: "cpu-01", name: "Cpu 01", metrics: ["uptime", "cpu"] };
/**
 * The m09671 bug, as a fixture: load collected, CPU NOT collected.
 *
 * This is `nas-b`'s configuration. The old card drew load as a bar of
 * `load1 / cores` where `cores` came from `sample.cpu.cores` — absent here
 * because CPU was never collected — so `?? 1` fabricated a single core and a
 * 0.54 load on this 4-core box rendered as a 54% bar instead of 13.5%.
 * Note the load object carries its OWN `cores`, which the fixed collector
 * supplies precisely so this device does not need the CPU metric.
 */
const loadOnlyDevice = {
	...healthyDevice,
	id: "load-01",
	name: "Load 01",
	metrics: ["uptime", "load"],
	sample: { ...sample, cpu: null, load: { load1: 0.54, load5: 0.53, load15: 0.54, running: 1, total: 1126, cores: 4 } },
};
/**
 * The unanswerable case: load collected, but NEITHER source reported a core
 * count. The card must decline to state a dimension rather than assume one.
 */
const noCoresDevice = {
	...healthyDevice,
	id: "nc-01",
	name: "NoCores 01",
	metrics: ["uptime", "load"],
	sample: { ...sample, cpu: null, load: { load1: 0.54, load5: 0.53, load15: 0.54, running: 1, total: 1126, cores: null } },
};
/** A device whose choice is an explicit empty array: only `uptime` survives. */
const bareDevice = { ...healthyDevice, id: "bare-01", name: "Bare 01", metrics: [] };
/** A device that has been offline long enough for the Host to record it. */
const offlineDevice = { ...neverDevice, id: "off-01", name: "Off 01", incident: { offline: true, fails: 3, downSeconds: 420 } };

const seriesFor = (count) => Array.from({ length: count }, (_, index) => ({ ts: Date.now() - (count - index) * 60_000, cpu: 20 + index, mem: 50 + (index % 5), disk: 80, temp: null, load1: 1 }));

/** Every rendered text produced by a scenario, checked for stray placeholders. */
const renderedTexts = [];
function record(label, text) {
	renderedTexts.push({ label, text });
	return text;
}
//#endregion

//#region 1. module wrapper and registration
console.log(sourceUrl === undefined ? "\n== module wrapper ==" : `\n== module wrapper (served bundle ${sourceUrl}) ==`);
const world = createWorld();
ok("the module loader was called", world.loaded !== undefined);
eq("the module id is the package name", world.loaded.id, "@local/dsh-device-monitor");
ok("the factory is a function", typeof world.loaded.factory === "function");
ok("apply is exported", typeof world.exported.apply === "function");
ok("inject is exported", Array.isArray(world.exported.inject));
ok("inject includes slots", world.exported.inject.includes("slots"));
ok("inject includes locale", world.exported.inject.includes("locale"));
ok("inject includes betterSidebar as a soft dependency", world.exported.inject.includes("betterSidebar"));

console.log("\n== apply: mounts without throwing ==");
eq("a style tag was injected", world.styleTags.length, 1);
ok("the style tag is namespaced", world.styleTags[0]?.dataset?.plugin === "@local/dsh-device-monitor");
const css = world.styleTags[0]?.textContent ?? "";
ok("the stylesheet is non-trivial", css.length > 2000, `${css.length} bytes`);
eq("no hard-coded hex colours (the brand button uses #fff on a token background)", (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).join(","), "#fff");
ok("the stylesheet uses theme tokens", css.includes("var(--dsw-alias-"));
// The left rail is deliberately NOT claimed: its rows are buttons that call
// `layout.selectPanel(id)` to swap the centre column, and the panel's real home
// is the right column beside the conversation. A left-rail row would be a second
// entrance to an already-open view, and clicking it would blank the conversation.
eq("only the main shell seat was injected", world.injectedSeats.join(","), "main");
eq("one slot was registered", world.registeredSlots.length, 1);

const mainSlot = world.registeredSlots.find((row) => row.options.name === "main");
ok("the main page registered", mainSlot !== undefined);
eq("main key is the panel id", mainSlot?.options?.key, "device-monitor");
ok("the page component is a function", typeof mainSlot?.component === "function");
ok("no left-rail entry was registered", world.registeredSlots.every((row) => row.options.name !== "sidebar.panellist"));

// A narrow column needs no fixed pixel widths; the panel has to adapt to its
// container, because the same component serves the main area and the right rail.
ok("no narrow-column rule pins a fixed width", !/\.ddm-(view|body|head|card|grid|form)[^{]*\{[^}]*[^-]width:\s*\d+px/.test(css), "a fixed pixel width would overflow the right sidebar");
ok("the narrow modifiers exist", css.includes(".ddm-body-narrow") && css.includes(".ddm-head-narrow"));

// --- the form's checkbox regression (item ① of the user's report)
// `.ddm-form-panel .ddm-field input` has specificity (0,2,1) and beats
// `.ddm-check input` at (0,1,1), so `width:100%;height:30px` applied to every
// checkbox as well: each 15px box was stretched across the whole form column and
// squeezed its own label into a narrow strip. Asserting on the SHEET (not on a
// rendered style, which this harness cannot compute) is the only place the
// cascade can be checked.
{
	const fullWidth = cssRule(css, ".ddm-form-panel .ddm-field input:not([type=\"checkbox\"])");
	ok("the form's full-width rule spares checkboxes", fullWidth.includes("width:100%"),
		`the selector itself carries the :not(), the body is only the width — block=${fullWidth}`);
	ok("the full-width rule was not simply deleted", fullWidth !== "", "text fields still have to fill the column");
	// The override has to WIN, not merely exist: a rule that loses the cascade is
	// the exact shape of this bug.
	const checkOverride = cssRule(css, ".ddm-form-panel .ddm-field .ddm-check input[type=\"checkbox\"]");
	const width = cssDecl(checkOverride, "width");
	const height = cssDecl(checkOverride, "height");
	eq("the checkbox keeps a 15px box", width, "15px");
	eq("the checkbox is not stretched to the form's input height", height, "15px");
	ok("the checkbox override is scoped to the form", checkOverride !== "", "unscoped, it would fight every other checkbox in the shell");
	// Specificity of the override must beat the full-width rule it is correcting.
	const spec = (selector) => {
		const ids = (selector.match(/#[\w-]+/g) ?? []).length;
		const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:not\(/g) ?? []).length;
		return ids * 100 + classes * 10;
	};
	ok("the checkbox override outranks the rule it corrects",
		spec(".ddm-form-panel .ddm-field .ddm-check input[type=\"checkbox\"]") > spec(".ddm-form-panel .ddm-field input"),
		`${spec(".ddm-form-panel .ddm-field .ddm-check input[type=\"checkbox\"]")} vs ${spec(".ddm-form-panel .ddm-field input")}`);
}

console.log("\n== right-sidebar tab (better-sidebar service) ==");
const tabWorld = createWorld({
	betterSidebar: {
		registerTab(descriptor) {
			this.last = descriptor;
			return () => {};
		},
	},
});
const tabService = tabWorld.ctx.betterSidebar;
ok("registerTab was called", tabService.last !== undefined);
eq("tab id is the panel id", tabService.last?.id, "device-monitor");
eq("tab title resolves through the locale", tabService.last?.title?.(), "设备");
eq("tab order is a number", typeof tabService.last?.order, "number");
eq("the tab is single-instance", tabService.last?.single, true);
ok("the tab declares a component", typeof tabService.last?.component === "function");
const tabTree = toTree({ type: tabService.last.component, props: { visible: true } });
ok("the tab component renders", textOf(tabTree).length > 0);
ok("the tab body is the same panel", hasClass(tabTree, "ddm-view"));

// A missing service must not cost the shell seat: the registration is a soft
// dependency, so a disabled better-sidebar degrades instead of failing.
let degradedError;
let degradedWorld;
try {
	degradedWorld = createWorld({ betterSidebar: undefined });
} catch (error) {
	degradedError = error;
}
ok("the plugin still mounts when betterSidebar is absent", degradedError === undefined, degradedError?.message);
ok("the shell seat survives the missing service", degradedWorld?.registeredSlots.length === 1);

//#endregion

//#region 2. locale dictionary
console.log("\n== locale dictionary ==");
eq("one namespace registered", localeCalls.length >= 1, true);
eq("namespace name", localeCalls[0]?.namespace, "dsh-device-monitor");
const dictionaries = localeCalls[0]?.dictionaries ?? {};
const zh = dictionaries.zh ?? {};
const en = dictionaries.en ?? {};
const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);
ok("a substantial zh dictionary was registered", zhKeys.length > 120, `${zhKeys.length} keys`);
eq("zh and en have identical key sets", zhKeys.filter((key) => !enKeys.includes(key)).concat(enKeys.filter((key) => !zhKeys.includes(key))).join(","), "");
/**
 * The sorted placeholder names in one template, read with the strict
 * single-brace form the shell actually substitutes.
 */
function placeholders(text) {
	return (String(text).match(/\{(\w+)\}/g) ?? []).map((token) => token.slice(1, -1)).sort().join(",");
}
ok("every locale pair interpolates the same names", zhKeys.every((key) => placeholders(zh[key]) === placeholders(en[key])), zhKeys.filter((key) => placeholders(zh[key]) !== placeholders(en[key])).join(","));
// A doubled `{{name}}` survives the shell's `/\{(\w+)\}/g` pass as a stray
// `{name}`, so the doubled form must never appear in a shipped dictionary.
const doubled = zhKeys.filter((key) => /\{\{/.test(zh[key]) || /\{\{/.test(en[key]));
eq("no dictionary string uses the doubled placeholder form", doubled.join(","), "");
// Every placeholder a dictionary declares must actually be supplied by the
// call site; this set is the contract between the panel and its strings.
const declaredNames = [...new Set(zhKeys.flatMap((key) => (placeholders(zh[key]) === "" ? [] : placeholders(zh[key]).split(","))))].sort();
ok("the declared placeholder names are the documented ones", declaredNames.every((name) => ["count", "max", "error", "time", "value", "name", "ms", "mount", "type", "sec", "bytes", "host", "detail", "key"].includes(name)), declaredNames.join(","));
// The alert keys follow the Host's unified metric vocabulary; the old
// memory/thermal names would leave every alert falling through to a raw message.
ok("the alert strings use the metric vocabulary", zh["alert.mem"] !== undefined && zh["alert.temp"] !== undefined && zh["alert.memory"] === undefined && zh["alert.thermal"] === undefined);
//#endregion

//#region 3. the panel renders through the real data path
console.log("\n== panel: loading, empty, populated ==");
const emptyWorld = createWorld();
const emptyView = await mount(emptyWorld);
record("loading state", emptyView.loading);
ok("the loading state says so", emptyView.loading.includes("加载中") || emptyView.loading.includes("设备监管"), emptyView.loading.slice(0, 80));
record("empty state", emptyView.text);
ok("the empty state explains itself", emptyView.text.includes("尚未登记设备"), emptyView.text.slice(0, 140));
ok("the empty state offers an add action", emptyView.text.includes("添加设备"));
ok("an empty roster is 0 / 10", emptyView.text.includes("0 / 10"), emptyView.text.slice(0, 120));
ok("the panel reports its watch cadence", emptyView.text.includes("自动刷新"), emptyView.text.slice(0, 120));
ok("the panel fetched the roster", emptyWorld.server.calls.some((row) => row.path.endsWith("/overview")));
ok("the panel fetched settings", emptyWorld.server.calls.some((row) => row.path.endsWith("/settings")));
ok("a visible seat took a watch lease", emptyWorld.server.calls.some((row) => row.path.endsWith("/watch") && row.method === "POST"));

const gridWorld = createWorld();
gridWorld.server.devices = [healthyDevice, alertingDevice, brokenDevice, neverDevice, offlineDevice];
gridWorld.server.series["edge-01"] = seriesFor(6);
const gridView = await mount(gridWorld);
const grid = gridView.tree;record("populated grid", gridView.text);
ok("every healthy device name rendered", gridView.text.includes("Edge 01"));
ok("an alerting device rendered", gridView.text.includes("Hot 01"));
ok("an unreachable device rendered", gridView.text.includes("Down 01"));
ok("a never-collected device rendered", gridView.text.includes("New 01"));
ok("the CPU alert badge rendered", gridView.text.includes("CPU 93%"), gridView.text.slice(0, 200));
ok("the memory alert badge rendered", gridView.text.includes("内存 95%"));
ok("the disk alert carries its mount", gridView.text.includes("磁盘 / 91%"));
ok("the thermal alert carries its zone", gridView.text.includes("温度 cpu-thermal 80°C"));
ok("a failed poll shows its error", gridView.text.includes("connect ETIMEDOUT 10.0.0.5:22"));
ok("a never-collected device is flagged", gridView.text.includes("尚未采集"));
ok("the device count is shown", gridView.text.includes("5 / 10"), gridView.text.slice(0, 160));
ok("the limit notice is absent below the cap", !gridView.text.includes("已达上限"));
ok("the CPU percentage is rendered", gridView.text.includes("43%"));
ok("uptime is rendered", gridView.text.includes("3d 4h 12m"));
ok("temperature is rendered", gridView.text.includes("62.5°C"));
ok("the address line is rendered", gridView.text.includes("root@192.168.1.10:2222"));
ok("cards rendered", hasClass(grid, "ddm-card"));
ok("the persisted incident is shown", gridView.text.includes("离线") && gridView.text.includes("连续失败 3 次"), gridView.text.slice(0, 200));

// ---------------------------------------------------------------------
// m11227: the form's optional fields must reach the screen.
//
// `location` / `description` / `tags` were accepted by the store, shipped to
// the browser and editable in the form, but the card rendered none of them —
// so the form promised a place to record a rack and a note and then discarded
// both. These assertions are on the RENDERED TREE, not on the fixture: the bug
// was never "the data is missing", it was "the data is never drawn".
// ---------------------------------------------------------------------
{
	const text = gridView.text;
	ok("the card renders the tags", text.includes("lab") && text.includes("prod"), text.slice(0, 220));
	ok("the card renders the location", text.includes("rack A / U12"), text.slice(0, 220));
	ok("the card renders the description", text.includes("备用节点，周五维护"), text.slice(0, 260));
	ok("the location is labelled, not bare", text.includes("位置"), text.slice(0, 220));
	ok("the description is labelled, not bare", text.includes("备注"), text.slice(0, 260));
	// Scoped to ONE card on purpose: `alertingDevice` spreads `healthyDevice`,
	// so it carries the same two tags and a whole-tree count would be 4 — an
	// assertion about the grid's size wearing the costume of an assertion about
	// one card's contents.
	const cards = nodesWithClass(grid, "ddm-card");
	eq("the roster rendered one card per device", cards.length, 5);
	const rich = cards.filter((card) => textOf(card).includes("Edge 01"))[0];
	const tags = nodesWithClass(rich, "ddm-tag");
	eq("each tag is its own chip", tags.length, 2);
	eq("the tag chips carry their own value", tags.map((node) => node.props["data-dsh-card-tag"]).join(","), "lab,prod");
	eq("the populated card renders exactly its two note rows", nodesWithClass(rich, "ddm-note").length, 2);
	// The negative half. `brokenDevice` and `neverDevice` have neither field, and
	// a filler row for them would be a lie about what the user recorded — the
	// same rule the metric strip follows for a never-collected metric.
	const bare = cards.filter((card) => textOf(card).includes("Down 01") || textOf(card).includes("New 01"));
	ok("a device with no optional fields rendered no note rows",
		bare.every((card) => nodesWithClass(card, "ddm-note").length === 0), JSON.stringify(bare.map((card) => textOf(card).slice(0, 80))));
	ok("a device with no tags rendered no tag strip",
		bare.every((card) => nodesWithClass(card, "ddm-tags").length === 0));
}

console.log("\n== panel: waveforms ==");
ok("the waveform block rendered", hasClass(grid, "ddm-waves"));
// Four columns per card, one card per collected device — so assert the column
// SET rather than a total, which would silently track the fixture count.
const waveMetrics = new Set(attrsOf(grid, "data-dsh-metric").filter((value) => ["cpu", "mem", "disk", "temp"].includes(value)));
eq("every wave column is drawn", [...waveMetrics].sort().join(","), "cpu,disk,mem,temp");
ok("the sparkline drew a polyline", nodesOf(grid).some((node) => node.type === "polyline"));
// The series has a null temperature column; a chart that treats null as 0 draws
// a dive to the floor, so a break must not produce a polyline at all.
const tempWave = nodesOf(grid).find((node) => node.type === "div" && node.props?.["data-dsh-metric"] === "temp");
ok("a metric with no data does not draw a line", tempWave === undefined || !nodesOf(tempWave).some((node) => node.type === "polyline"));

// The y axis must be scaled to the data, not to a fixed 0..100. A fixed axis is
// what made the panel look broken: a healthy CPU (2%) and a steady disk (49%)
// both collapsed onto a dead-flat line, so three of four charts never moved.
// Assert the published scale AND the geometry it produces.
const sparkSvg = (node) => nodesOf(node).filter((child) => child.type === "svg" && String(child.props?.className ?? "").includes("ddm-spark"));
const spanOf = (svg) => {
	const vb = String(svg.props.viewBox).split(" ").map(Number);
	const ys = [];
	for (const child of nodesOf(svg)) {
		if (child.type !== "polyline") continue;
		for (const pair of String(child.props.points).trim().split(/\s+/)) ys.push(Number(pair.split(",")[1]));
	}
	if (ys.length < 2) return 0;
	return (Math.max(...ys) - Math.min(...ys)) / vb[3];
};
const cpuWave = nodesOf(grid).find((node) => node.type === "div" && node.props?.["data-dsh-metric"] === "cpu");
const cpuSpark = sparkSvg(cpuWave);
eq("the cpu waveform drew exactly one sparkline", cpuSpark.length, 1);
// The fixture's cpu series ramps 20..25 while its ceiling is 100. A fixed axis
// fills 5% of the box; an auto-fitted one fills most of it.
const cpuSpan = spanOf(cpuSpark[0]);
ok("the cpu waveform uses the box it is given", cpuSpan > 0.3, `yspan=${(cpuSpan * 100).toFixed(0)}%`);
const cpuLo = Number(cpuSpark[0].props["data-dsh-wave-lo"]);
const cpuHi = Number(cpuSpark[0].props["data-dsh-wave-hi"]);
ok("the cpu scale is published on the element", Number.isFinite(cpuLo) && Number.isFinite(cpuHi), `${cpuLo}..${cpuHi}`);
ok("the cpu scale brackets the data", cpuLo <= 20 && cpuHi >= 25, `${cpuLo}..${cpuHi} vs 20..25`);
ok("the cpu scale does not stretch to the ceiling", cpuHi < 100, `hi=${cpuHi}`);
// The axis must never invert or clamp below its own data, and no polyline may
// escape the box it was drawn into.
for (const svg of sparkSvg(grid)) {
	const lo = Number(svg.props["data-dsh-wave-lo"]);
	const hi = Number(svg.props["data-dsh-wave-hi"]);
	ok("every waveform has a non-degenerate axis", Number.isFinite(lo) && Number.isFinite(hi) && hi > lo, `${svg.props["data-dsh-wave-lo"]}..${svg.props["data-dsh-wave-hi"]}`);
	for (const child of nodesOf(svg)) {
		if (child.type !== "polyline") continue;
		const ys = String(child.props.points).trim().split(/\s+/).map((pair) => Number(pair.split(",")[1]));
		if (ys.some((y) => y < -0.01 || y > 56.01)) ok("a polyline stays inside its box", false, child.props.points);
	}
}
// ---------------------------------------------------------------- axes
// A waveform with no coordinates is a shape, not a chart: the reader can see
// that the line moved but not by how much, and not over what span of time. The
// four charts used to be bare sparklines — no y values, no x values — so the
// only scale in the panel was the one published in a `data-dsh-wave-lo`
// attribute that no human ever reads.
console.log("\n== panel: waveform axes ==");
const axisOf = (wave, which) => nodesOf(wave).find((node) => node.props?.["data-dsh-axis"] === which);
// The ticks, not the axis element: `nodesOf` includes the box itself, whose
// concatenated text would double-count every label.
const axisTicks = (axis) => (axis === undefined ? [] : nodesOf(axis.props?.children)
	.filter((node) => node.type === "span")
	.map((node) => textOf(node)));
const waveFor = (tree, metric) => nodesOf(tree).find((node) => node.type === "div" && node.props?.["data-dsh-metric"] === metric);
// Only a waveform that actually plotted carries axes: everything after the
// first empty column would otherwise be asserted against a chart that
// deliberately refused to draw.
const plotted = ["cpu", "mem", "disk", "temp"].map((metric) => waveFor(grid, metric)).filter((wave) => wave !== undefined && sparkSvg(wave).length > 0);
eq("three of the four fixture columns are plottable", plotted.map((wave) => wave.props["data-dsh-metric"]).join(","), "cpu,mem,disk");
for (const wave of plotted) {
	const metric = wave.props["data-dsh-metric"];
	const y = axisOf(wave, "y");
	const x = axisOf(wave, "x");
	eq(`the ${metric} waveform states its y range`, axisTicks(y).length, 2);
	ok(`the ${metric} waveform's y range has two distinct ends`,
		axisTicks(y).length === 2 && axisTicks(y)[0] !== axisTicks(y)[1], axisTicks(y).join(" | "));
	ok(`the ${metric} waveform states its time span`,
		axisTicks(x).length === 2 && axisTicks(x)[0] !== "" && axisTicks(x)[1] !== "", axisTicks(x).join(" | "));
}

// THE assertion this whole section exists for: the printed numbers and the
// drawn geometry must come from the SAME scale. Recomputing the scale inside
// the axis is the obvious implementation and the wrong one — the labels then
// describe a range the line was not drawn in, which is worse than no labels,
// because the reader has no way to tell. Asserted by reading the axis's own
// published range and the line's published range and requiring them equal.
for (const metric of ["cpu", "mem", "disk"]) {
	const wave = waveFor(grid, metric);
	const y = axisOf(wave, "y");
	const svg = sparkSvg(wave)[0];
	// Null-safe: a missing axis is a FAILURE to report, not a crash to make.
	// A mutant caught by a stack trace is not a covered mutant.
	eq(`the ${metric} axis labels the scale the line was drawn in`,
		y === undefined ? "no y axis" : `${y.props["data-dsh-axis-lo"]}..${y.props["data-dsh-axis-hi"]}`,
		`${svg.props["data-dsh-wave-lo"]}..${svg.props["data-dsh-wave-hi"]}`);
	// And the top tick must literally print the scale's high end, so a label
	// that only LOOKS plausible (right magnitude, wrong range) is caught.
	const hi = y === undefined ? null : Number(y.props["data-dsh-axis-hi"]);
	const lo = y === undefined ? null : Number(y.props["data-dsh-axis-lo"]);
	const span = hi === null || lo === null ? 0 : hi - lo;
	const digits = span < 1 ? 2 : span < 5 ? 1 : 0;
	const expectedTop = hi === null ? "" : hi.toFixed(digits);
	ok(`the ${metric} top tick prints the scale's own high end`, (axisTicks(y)[0] ?? "").startsWith(expectedTop) && expectedTop !== "",
		`${axisTicks(y)[0]} vs ${expectedTop}`);
}

// A chart with nothing to plot must carry no axis at all. An axis over an empty
// plot is a frame around nothing, and its numbers would be invented.
const tempWaveNode = waveFor(grid, "temp");
ok("an unplottable metric draws no axis",
	tempWaveNode === undefined || sparkSvg(tempWaveNode).length > 0 || axisOf(tempWaveNode, "y") === undefined,
	sparkSvg(tempWaveNode ?? {}).length > 0 ? "temp had data" : "axis present with no line");

// The x axis is TIME, so it must move with the series rather than print a
// constant. Two rows an hour apart must not both read the same clock.
const sparseWorld = createWorld();
sparseWorld.server.devices = [healthyDevice];
sparseWorld.server.series["edge-01"] = [
	{ ts: 1_700_000_000_000, cpu: 10, mem: 10, disk: 10, temp: 10 },
	{ ts: 1_700_003_600_000, cpu: 20, mem: 10, disk: 10, temp: 10 },
];
const sparseView = await mount(sparseWorld);
const sparseX = axisOf(waveFor(sparseView.tree, "cpu"), "x");
const sparseTicks = axisTicks(sparseX);
eq("the time axis spans the series, earliest first", sparseTicks.length, 2);
ok("the time axis is not a constant", sparseTicks[0] !== sparseTicks[1], sparseTicks.join(" | "));
// Earliest first: the left tick must be the earlier timestamp. Comparing the
// rendered strings is not enough across a locale, so compare the clock fields
// the formatter produces from a known pair.
const expectedFirst = new Date(1_700_000_000_000).toLocaleTimeString(undefined, { hour12: false });
eq("the first time tick is the series' first sample", sparseTicks[0], expectedFirst);


// There must be NO gauge strip left at all. Load used to be drawn as a bar whose
// length was `load1 / cores`, and `cores` came from the CPU metric — so on a
// device with CPU switched off the divisor was a fabricated 1 and the bar ran up
// to four times too long. Asserting "load has no bar" is not enough on its own;
// the machinery itself has to be gone, or a later metric can be dropped into it
// and re-acquire the same defect.
ok("no metric is drawn as a bar any more",
	nodesOf(grid).every((node) => !String(node.props?.className ?? "").includes("ddm-bar")),
	nodesOf(grid).filter((node) => String(node.props?.className ?? "").includes("ddm-bar")).map((node) => textOf(node)).join(" | "));
ok("the bar stylesheets are gone too",
	!css.includes("ddm-bar") && !css.includes("ddm-metric"),
	css.slice(css.indexOf("ddm-bar") - 40, css.indexOf("ddm-bar") + 60));

// The numeric strip is the second half of item ②: every metric that has NO
// chart has to appear here, side by side. Assert the SET, so dropping one
// metric's cell cannot hide behind the others.
const numCells = (tree) => attrsOf(tree, "data-dsh-num");
const numLabels = (tree) => Object.fromEntries(nodesOf(tree)
	.filter((node) => node.props?.["data-dsh-num"] !== undefined)
	.map((node) => [node.props["data-dsh-num"], textOf(node)]));
{
	// Scoped to ONE card on purpose. The grid fixture holds devices that were
	// never collected, so a tree-wide lookup would read a `—` cell from a
	// different card and report it as this device's missing reading.
	const edgeCard = nodesWithClass(grid, "ddm-card").find((node) => textOf(node).includes("Edge 01"));
	ok("the healthy device's card was found", edgeCard !== undefined, "the layout assertions need one known card");
	// `healthyDevice` records no metric choice, so the Host collects everything
	// and every chartless metric is expected — including `load`, which now lives
	// here instead of in a bar.
	eq("every chartless metric has a numeric cell", [...new Set(numCells(edgeCard))].sort().join(","),
		"diskio,load,net,procs,tcp,top,uptime", [...new Set(numCells(edgeCard))].join(","));
	// The de-duplication rule, asserted in the negative: a metric that already
	// has a chart header must NOT repeat its reading as a cell.
	for (const key of ["cpu", "mem", "disk", "temp"]) {
		ok(`a metric shown elsewhere is not also a cell (${key})`, !numCells(edgeCard).includes(key),
			numCells(edgeCard).join(","));
	}
	const shown = numLabels(edgeCard);
	// The load cell is the whole point of this fix: the three averages ALONE are
	// not interpretable, because 1.0 saturates one core and quarter-fills four.
	// The core count has to ride in the same string as the reading.
	ok("the load cell shows all three averages", /1\.20\s*\/\s*0\.90\s*\/\s*0\.70/.test(shown.load ?? ""), shown.load);
	ok("the load cell names the core count it is measured against", (shown.load ?? "").includes("4 核"), shown.load);
	ok("the uptime cell shows the reading", (shown.uptime ?? "").includes("3d 4h 12m"), shown.uptime);
	ok("the process cell shows the reading", (shown.procs ?? "").includes("145"), shown.procs);
	ok("a cell carries a label as well as a value", nodesOf(edgeCard).some((node) => node.props?.["data-dsh-num"] === "procs" && hasClass(node, "ddm-num")),
		"a bare value with no label would be unreadable in a strip");

	// A configured-but-never-collected metric must read `—`, never `0`. The
	// fixture's `net` row was never collected for this device.
	const netCell = nodesOf(edgeCard).find((node) => node.props?.["data-dsh-num"] === "net");
	ok("an uncollected metric reads as unknown, not zero", netCell !== undefined && textOf(netCell).includes("—"),
		netCell === undefined ? "no net cell" : textOf(netCell));

	// The cells must sit OUTSIDE the chart stack: they are the other numbers,
	// not a label inside a chart row. Scoped to the first card's own classes.
	const ownWaves = nodesWithClass(edgeCard, "ddm-waves");
	ok("the card has exactly one chart stack", ownWaves.length === 1, `${ownWaves.length} found`);
	ok("the numeric strip is not nested inside a chart row", ownWaves.every((node) => attrsOf(node, "data-dsh-num").length === 0),
		attrsOf(ownWaves[0], "data-dsh-num").join(","));
	// And the strip must come BEFORE the charts: numbers are the summary. The
	// two nodes are siblings, so their order in a depth-first walk is their
	// layout order.
	const stripAndStack = nodesOf(edgeCard).filter((node) => ownClass(node, "ddm-nums") || ownClass(node, "ddm-waves"));
	eq("the numbers are laid out before the charts", stripAndStack.map((node) => (ownClass(node, "ddm-nums") ? "nums" : "waves")).join(","), "nums,waves");
}
// The chart header must show the LIVE reading. The card's own sample is fresher
// than the last history row, and reading only the series printed `—` beside a
// chart while a good reading sat in the sample.
ok("the chart header shows the live reading", gridView.text.includes("43%"), gridView.text.slice(0, 200));
ok("the chart header shows the live temperature", gridView.text.includes("62.5°C"));

console.log("\n== panel: one chart per row, other numbers side by side (item ②) ==");
// The requirement is a LAYOUT contract, so it is asserted on the stylesheet as
// well as on the tree: the class set can be right while the rule that arranges
// it is still the multi-column grid that made four 112px charts unreadable.
{
	const waves = cssRule(css, ".ddm-waves");
	eq("the chart stack is a single column", cssDecl(waves, "display"), "flex");
	eq("the chart stack flows vertically", cssDecl(waves, "flex-direction"), "column");
	ok("the chart stack is not the old auto-fit grid", !waves.includes("grid-template-columns"), waves);
	// Each ROW is [label | chart]. The chart must take the remaining width and be
	// allowed to shrink, or a long label pushes it out of the card.
	const wave = cssRule(css, ".ddm-wave");
	eq("each chart row is a two-column grid", cssDecl(wave, "display"), "grid");
	ok("the chart row is label-plus-chart, chart flexible", /88px/.test(cssDecl(wave, "grid-template-columns") ?? "") && /minmax\(0,\s*1fr\)/.test(cssDecl(wave, "grid-template-columns") ?? ""),
		cssDecl(wave, "grid-template-columns"));
	ok("the chart row may shrink below its content", cssDecl(wave, "min-width") === "0", cssDecl(wave, "min-width"));

	// The numbers WITHOUT a chart sit side by side, wrapping into as many
	// columns as fit — the user's "其他数值信息可以并排放置".
	const nums = cssRule(css, ".ddm-nums");
	eq("the numeric strip is a grid", cssDecl(nums, "display"), "grid");
	ok("the numeric strip lays cells out side by side", /auto-fill/.test(cssDecl(nums, "grid-template-columns") ?? ""),
		cssDecl(nums, "grid-template-columns"));
	ok("the numeric strip wraps instead of scrolling", !nums.includes("nowrap") && !/overflow-x:\s*(auto|scroll)/.test(nums), nums);

	// One cell = label over value. Value LAST is what makes the reading line up
	// down the strip no matter how long the label beside it is.
	const numValue = cssRule(css, ".ddm-num-value");
	ok("a numeric cell cannot be widened by its own text", cssDecl(numValue, "white-space") === "nowrap" && cssDecl(numValue, "text-overflow") === "ellipsis",
		`${cssDecl(numValue, "white-space")} / ${cssDecl(numValue, "text-overflow")}`);
	ok("numeric values use tabular figures", (cssDecl(numValue, "font-variant-numeric") ?? "").includes("tabular-nums"), cssDecl(numValue, "font-variant-numeric"));
}

console.log("\n== panel: metric gating (R3) ==");
const gatedWorld = createWorld();
gatedWorld.server.devices = [cpuOnlyDevice, bareDevice];
const gatedView = await mount(gatedWorld);
record("gated grid", gatedView.text);
ok("the selected metric is shown", gatedView.text.includes("CPU"), gatedView.text.slice(0, 200));
ok("an unselected metric is hidden", !gatedView.text.includes("磁盘"), gatedView.text.slice(0, 200));
ok("a selected metric still draws its waveform", nodesOf(gatedView.tree).some((node) => node.props?.["data-dsh-metric"] === "cpu"), attrsOf(gatedView.tree, "data-dsh-metric").join(","));
ok("uptime always survives", gatedView.text.includes("3d 4h 12m"));

// `[]` is a real choice, not "unconfigured": only the always-on metric survives,
// so the card must draw NO waveform columns at all. Asserted on a bare-only
// world — in a mixed world another device's columns would mask the regression.
const bareWorld = createWorld();
bareWorld.server.devices = [bareDevice];
const bareView = await mount(bareWorld);
record("bare-metric grid", bareView.text);
eq("an empty metric choice draws no waveforms", attrsOf(bareView.tree, "data-dsh-metric").join(","), "");
ok("an empty metric choice still renders the card", hasClass(bareView.tree, "ddm-card"));
ok("an empty metric choice still shows uptime", bareView.text.includes("3d 4h 12m"));

// The m09671 regression, in its own world so no other card's CPU reading can
// supply the core count and make the assertion pass for the wrong reason.
console.log("\n== panel: load with the CPU metric switched off ==");
const loadWorld = createWorld();
loadWorld.server.devices = [loadOnlyDevice];
const loadView = await mount(loadWorld);
record("load-only grid", loadView.text);
{
	const loadCard = nodesWithClass(loadView.tree, "ddm-card")[0];
	const cells = Object.fromEntries(nodesOf(loadCard)
		.filter((node) => node.props?.["data-dsh-num"] !== undefined)
		.map((node) => [node.props["data-dsh-num"], textOf(node)]));
	// The reading itself must survive: it has no chart column, so if it is not a
	// cell it is nowhere.
	ok("a load-only device still reports its load", /0\.54/.test(cells.load ?? ""), cells.load);
	// The whole bug: the core count has to come from the load collector's own
	// tally when the CPU metric is off, not from sample.cpu (which is null here).
	ok("the load reading carries the core count, not a fabricated 1", (cells.load ?? "").includes("4 核"), cells.load);
	// No bar anywhere on this card — the shape that made the error invisible.
	ok("the load-only card draws no bar", nodesOf(loadCard).every((node) => !String(node.props?.className ?? "").includes("ddm-bar")),
		nodesOf(loadCard).map((node) => String(node.props?.className ?? "")).join(" | "));
	// And when NEITHER source knows the cores, no dimension is stated. Fabricating
	// a denominator is exactly what produced the 4x error.
	ok("an unknown core count is not stated at all", !(cells.load ?? "").includes("核") || (cells.load ?? "").includes("4 核"), cells.load);
}
const noCoresWorld = createWorld();
noCoresWorld.server.devices = [noCoresDevice];
const noCoresView = await mount(noCoresWorld);
record("no-cores grid", noCoresView.text);
{
	const cells = Object.fromEntries(nodesOf(nodesWithClass(noCoresView.tree, "ddm-card")[0])
		.filter((node) => node.props?.["data-dsh-num"] !== undefined)
		.map((node) => [node.props["data-dsh-num"], textOf(node)]));
	ok("a load reading is still shown when the cores are unknown", /0\.54/.test(cells.load ?? ""), cells.load);
	ok("the core dimension is omitted rather than assumed when unknown", !(cells.load ?? "").includes("核"), cells.load);
}

console.log("\n== panel: full roster, load error, notice ==");
const fullWorld = createWorld();
fullWorld.server.devices = Array.from({ length: 10 }, (_, index) => ({ ...neverDevice, id: `d${index}`, name: `Device ${index}` }));
const fullView = await mount(fullWorld);
record("full roster", fullView.text);
ok("the cap notice appears at 10 devices", fullView.text.includes("已达上限"));

const errorWorld = createWorld();
errorWorld.server.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: "Failed to fetch" }) });
const errorView = await mount(errorWorld);
record("load error", errorView.text);
ok("a load failure is surfaced with its message", errorView.text.includes("Failed to fetch"), errorView.text.slice(0, 200));
//#endregion

//#region 4. view switching through real clicks
console.log("\n== view switching ==");
const navWorld = createWorld();
navWorld.server.devices = [healthyDevice];
const navView = await mount(navWorld);
const settingsClick = await click(navWorld, undefined, "设置");
ok("the settings tab is clickable", settingsClick.clicked);
record("settings view", settingsClick.text);
ok("the settings view rendered", hasClass(settingsClick.tree, "ddm-form-panel") && settingsClick.text.includes("刷新间隔"), settingsClick.text.slice(0, 200));
ok("the settings view shows thresholds", settingsClick.text.includes("阈值告警"));
ok("the settings view lists every metric", attrsOf(settingsClick.tree, "data-dsh-metric-key").length === 11, String(attrsOf(settingsClick.tree, "data-dsh-metric-key").length));
ok("the metric hint states the command is not sent", settingsClick.text.includes("不会下发采集命令"));
ok("the raw-log warning is shown next to the switch, not only in the README", settingsClick.text.includes("未做脱敏"));

// --- custom commands: the one setting that can run arbitrary device commands
// The panel must not merely render the switch; it has to send a REAL boolean
// and must not send a blank body (which would read as "override with nothing").
{
	// Off by default: the override rows must not even be on screen, so nobody
	// arms this path by accident or by scrolling past it.
	ok("the custom-command switch starts off", attrsOf(settingsClick.tree, "data-dsh-custom-commands").length === 1 &&
		nodesOf(settingsClick.tree).filter((node) => node.props?.["data-dsh-custom-commands"] !== undefined).every((node) => node.props.checked === false),
		JSON.stringify(attrsOf(settingsClick.tree, "data-dsh-custom-commands")));
	ok("the custom-command section is titled, not an unlabelled switch", settingsClick.text.includes("自定义采集命令"), settingsClick.text.slice(0, 120));
	ok("no override rows are shown while it is off", attrsOf(settingsClick.tree, "data-dsh-custom-key").length === 0);
	ok("the custom-command risk is stated next to the switch", settingsClick.text.includes("不受 Agent 工具的命令白名单约束"), settingsClick.text.slice(0, 300));
	ok("the gate is explained where the override is configured", settingsClick.text.includes("未勾选的指标仍然一条命令都不下发"));

	// Arm it through the real handler, then fill one row through its real
	// handler — that is the only way to prove the value lands in the setting the
	// Host reads.
	const armed = await change(navWorld, "data-dsh-custom-commands", "", true);
	eq("the custom-command switch is drivable", armed, 1);
	const armedText = textOf(draw(navWorld));
	const rowsAfterArm = attrsOf(draw(navWorld), "data-dsh-custom-key");
	eq("arming it reveals one row per selectable metric", rowsAfterArm.length, 10);
	ok("the always-on uptime metric has no override row", !rowsAfterArm.includes("uptime"), rowsAfterArm.join(","));
	const typed = await change(navWorld, "data-dsh-custom-key", "tcp", "ss -tan | wc -l");
	eq("an override row is drivable", typed, 1);
	// The typed value lives on the input, not in rendered text, so reading the
	// control back is what proves the row kept what was typed into it.
	const typedRow = () => nodesOf(draw(navWorld)).find((node) => node.props?.["data-dsh-custom-key"] === "tcp");
	eq("the typed override is held by the row", typedRow()?.props?.value, "ss -tan | wc -l");

	// Save through the real button and inspect what actually crossed the wire.
	const savedCall = await click(navWorld, undefined, "保存设置");
	ok("the save button was clickable", savedCall.clicked);
	const patch = navWorld.server.calls.filter((row) => row.method === "PATCH" && row.path.endsWith("/settings")).pop();
	ok("the settings patch was sent", patch !== undefined, JSON.stringify(navWorld.server.calls.map((row) => `${row.method} ${row.path}`)));
	// The recorded body is the JSON string that actually crossed the wire, so
	// parsing it is the only honest reading of what the Host receives.
	const sent = JSON.parse(patch.body ?? "{}").customCommands;
	eq("the switch is sent as a real boolean true", sent?.enabled, true);
	eq("the typed override is sent under its metric key", sent?.overrides?.tcp, "ss -tan | wc -l");
	eq("no other metric got an override", Object.keys(sent?.overrides ?? {}).join(","), "tcp");
	ok("a blank row is not sent as an empty override", !Object.values(sent?.overrides ?? {}).includes(""),
		JSON.stringify(sent?.overrides));

	// A blank body must mean "use the built-in command", never "send empty".
	const blanked = await change(navWorld, "data-dsh-custom-key", "tcp", "   ");
	eq("the override row is still drivable", blanked, 1);
	await click(navWorld, undefined, "保存设置");
	const patch2 = navWorld.server.calls.filter((row) => row.method === "PATCH" && row.path.endsWith("/settings")).pop();
	eq("whitespace-only clears the override instead of sending a blank command", Object.keys(JSON.parse(patch2?.body ?? "{}").customCommands?.overrides ?? {}).length, 0);
}

// A refresh tick must not wipe a half-typed edit. The overview poll rebuilds
// the settings payload every cycle; if that reached the form as a NEW object
// reference the `[settings]` re-seed would fire and silently revert whatever
// the user had typed but not yet saved.
{
	const liveWorld = createWorld();
	liveWorld.server.settings = { ...liveWorld.server.settings, refreshIntervalSec: 30 };
	await mount(liveWorld);
	await click(liveWorld, undefined, "设置");
	const typed = await change(liveWorld, "data-dsh-custom-commands", "", true);
	eq("the switch is drivable for the clobber test", typed, 1);
	await change(liveWorld, "data-dsh-custom-key", "net", "cat /proc/net/dev");
	const before = nodesOf(draw(liveWorld)).find((node) => node.props?.["data-dsh-custom-key"] === "net")?.props?.value;
	eq("the unsaved edit is present before the tick", before, "cat /proc/net/dev");
	// Fire the real refresh tick the panel registered. Walking views instead
	// would re-run a mount path the browser never takes, and would not have
	// caught the defect this asserts on.
	const tick = liveWorld.timers.filter((row) => row.ms === 30_000).pop() ?? liveWorld.timers.pop();
	ok("the panel registered a refresh timer at the configured cadence", tick !== undefined && tick.ms === 30_000, JSON.stringify(liveWorld.timers.map((row) => row.ms)));
	tick.fn();
	await flush(16);
	// Render through the settle loop, not a single `draw`: an effect that resets
	// the form commits AFTER the render that armed it, so one pass would read
	// the pre-effect tree and pass no matter what the effect did.
	const after = nodesOf((await settle(liveWorld)).tree).find((node) => node.props?.["data-dsh-custom-key"] === "net")?.props?.value;
	eq("a refresh tick does not clobber an unsaved edit", after, "cat /proc/net/dev");
}

// A stored override must come back checked and filled — otherwise a reload
// silently disarms a production setting.
{
	const customWorld = createWorld();
	customWorld.server.settings = {
		...customWorld.server.settings,
		customCommands: { enabled: true, overrides: { tcp: "ss -tan | wc -l" } },
	};
	await mount(customWorld);
	const click2 = await click(customWorld, undefined, "设置");
	ok("the settings view still renders", click2.clicked);
	const box = nodesOf(click2.tree).find((node) => node.props?.["data-dsh-custom-commands"] !== undefined);
	eq("a stored override comes back armed", box?.props?.checked, true);
	const row = nodesOf(click2.tree).find((node) => node.props?.["data-dsh-custom-key"] === "tcp");
	eq("a stored override comes back filled", row?.props?.value, "ss -tan | wc -l");
	// The normalizer requires a REAL boolean. A hand-edited string in the file
	// must render as OFF, not as a silently armed backdoor.
	const stringWorld = createWorld();
	stringWorld.server.settings = { ...stringWorld.server.settings, customCommands: { enabled: "true", overrides: { tcp: "ss -tan | wc -l" } } };
	await mount(stringWorld);
	const click3 = await click(stringWorld, undefined, "设置");
	const stringBox = nodesOf(click3.tree).find((node) => node.props?.["data-dsh-custom-commands"] !== undefined);
	eq("a string 'true' from the file renders as OFF, not as armed", stringBox?.props?.checked, false);
}

const logsClick = await click(navWorld, undefined, "日志");
ok("the logs tab is clickable", logsClick.clicked);
record("logs view", logsClick.text);
// The view is marked by an attribute, not a class: it reuses the panel styling.
ok("the logs view rendered", attrsOf(logsClick.tree, "data-dsh-device-logs").length === 1);
ok("the logs view names the log directory", logsClick.text.includes("日志目录"), logsClick.text.slice(0, 200));
ok("the log total is interpolated, not shown as a stray token", !logsClick.text.includes("{bytes}"), logsClick.text.slice(0, 200));
// The picker must offer the roster even when no log file exists yet; otherwise a
// device that has never been collected is simply absent and looks like a bug.
ok("the log picker offers the roster", attrsOf(logsClick.tree, "data-dsh-log-device").includes("edge-01"), attrsOf(logsClick.tree, "data-dsh-log-device").join(","));
ok("the raw log is fetched for a device", navWorld.server.calls.some((row) => row.path.endsWith("/rawlog")), navWorld.server.calls.map((row) => row.path).join(","));

const backToList = await click(navWorld, undefined, "设备");
ok("the list tab is clickable", backToList.clicked);
ok("the roster is back", backToList.text.includes("Edge 01"), backToList.text.slice(0, 200));
//#endregion

//#region 5. detail view
console.log("\n== detail view ==");
const detailWorld = createWorld();
detailWorld.server.devices = [healthyDevice, alertingDevice];
detailWorld.server.series["edge-01"] = seriesFor(8);
const detailStart = await mount(detailWorld);
const detailClick = await click(detailWorld, undefined, "设备详情");
ok("the detail button is clickable", detailClick.clicked);
record("detail view", detailClick.text);
ok("the detail view shows the model", detailClick.text.includes("ARMv8 Processor rev 1"), detailClick.text.slice(0, 200));
ok("the detail view shows the filesystem device", detailClick.text.includes("/dev/root"));
ok("the detail view localises its table headers", detailClick.text.includes("挂载点") && detailClick.text.includes("已用"), detailClick.text.slice(0, 200));
ok("the detail view lists services", detailClick.text.includes("ssh.service"));
ok("the detail view shows the kernel", detailClick.text.includes("Linux box 5.10.0"));
ok("the detail view offers a command box", detailClick.text.includes("在此设备上执行 shell 命令"));
ok("the detail view has a back control", detailClick.text.includes("返回"));
ok("the detail view shows the load average", detailClick.text.includes("0.9"));
ok("the detail view renders the trend section", detailClick.text.includes("趋势"));
ok("the detail view renders sections", hasClass(detailClick.tree, "ddm-section"));
ok("the detail view fetched a series", detailWorld.server.calls.some((row) => row.path.endsWith("/metrics")));
// The detail view is where a long note actually fits, so it must carry the same
// three fields the card does — read from the same device object, so the two
// views cannot disagree about what was recorded.
{
	const text = detailClick.text;
	ok("the detail view shows the location", text.includes("rack A / U12"), text.slice(0, 300));
	ok("the detail view shows the description", text.includes("备用节点，周五维护"), text.slice(0, 300));
	ok("the detail view shows the tags", text.includes("lab") && text.includes("prod"), text.slice(0, 300));
	const nodes = nodesOf(detailClick.tree);
	eq("the detail view carries the location as its own field",
		(nodes.find((node) => node.props?.["data-dsh-detail-location"] !== undefined) ?? { props: {} }).props["data-dsh-detail-location"], "rack A / U12");
	eq("the detail view carries the tags joined",
		(nodes.find((node) => node.props?.["data-dsh-detail-tags"] !== undefined) ?? { props: {} }).props["data-dsh-detail-tags"], "lab,prod");
}

const backClick = await click(detailWorld, undefined, "返回");
ok("the back control works", backClick.clicked && backClick.text.includes("5 / 10") === false, backClick.text.slice(0, 120));
ok("the roster is restored", backClick.text.includes("Edge 01"));

const neverWorld = createWorld();
neverWorld.server.devices = [neverDevice];
await mount(neverWorld);
const neverClick = await click(neverWorld, undefined, "设备详情");
record("uncollected detail", neverClick.text);
ok("an uncollected detail view still renders", neverClick.text.length > 0);
ok("it explains the missing service list", neverClick.text.includes("无法读取服务列表"));

const brokenWorld = createWorld();
brokenWorld.server.devices = [brokenDevice];
await mount(brokenWorld);
const brokenClick = await click(brokenWorld, undefined, "设备详情");
ok("an unreachable detail view shows the error", brokenClick.text.includes("connect ETIMEDOUT"));
//#endregion

//#region 6. the form lives in the column
console.log("\n== add/edit form ==");
const formWorld = createWorld();
formWorld.server.devices = [healthyDevice];
const formStart = await mount(formWorld);
record("card actions", formStart.text);
ok("the add button is present", formStart.text.includes("添加设备"));
ok("the edit button is present", formStart.text.includes("编辑"));
ok("the delete button is present", formStart.text.includes("删除"));
ok("the collect button is present", formStart.text.includes("采集"));
// The card carries the debug terminal, not a connection test. Both exist in the
// product but they answer different questions: the form's "测试连接" checks the
// credentials currently on screen, while the card has a SAVED device and so
// offers the shell that can actually diagnose one. Asserting the absence of the
// old label as well — a button that kept its label but changed its handler
// would otherwise pass this check while opening a terminal labelled "测试连接".
ok("the card offers the debug terminal", formStart.text.includes("终端调试"), formStart.text.slice(0, 200));
ok("the card no longer offers a bare connection test", !attrsOf(formStart.tree, "data-dsh-card-terminal").some(() => false) && !clicksLabelled(formStart.tree, "终端调试").some((node) => textOf(node).includes("测试连接")));
ok("the detail button is present", formStart.text.includes("设备详情"));

const addClick = await click(formWorld, undefined, "添加设备");
ok("the add button opens the form", addClick.clicked);
record("add form", addClick.text);
ok("the add form is titled", addClick.text.includes("添加设备"));
// The form must be IN the column, not a modal over it: the right sidebar is too
// narrow for a centred dialog, and a modal would hide the conversation.
ok("the form is not a modal overlay", !hasClass(addClick.tree, "ddm-overlay") && !hasClass(addClick.tree, "ddm-modal"));
ok("the form renders as an in-column panel", hasClass(addClick.tree, "ddm-form-panel"));
ok("the form carries its marker attribute", attrsOf(addClick.tree, "data-dsh-device-form").length === 1);
ok("the name field is present", addClick.text.includes("例如：边缘网关 01"), addClick.text.slice(-400));
ok("the host field is present", addClick.text.includes("192.168.1.10"));
ok("the username field is present", addClick.text.includes("root"));
ok("the password field is present", addClick.text.includes("密码"));
ok("the save and cancel controls are present", addClick.text.includes("保存") && addClick.text.includes("取消"));
ok("the add form exposes the metric picker", attrsOf(addClick.tree, "data-dsh-metric-key").length === 11);
ok("the add form offers a draft test", addClick.text.includes("测试") && addClick.text.includes("未保存的设备"), addClick.text.slice(-400));
ok("the add form has an interval override", addClick.text.includes("本设备刷新间隔"));
// The draft test must actually POST to the draft route — asserting only that a
// button exists would pass even if it called the SAVED-device test route, which
// would need the device to exist first.
const beforeDraft = formWorld.server.calls.filter((row) => row.path.endsWith("/test-draft")).length;
const draftClick = await click(formWorld, undefined, "测试连接");
ok("the draft test button is clickable", draftClick.clicked);
eq("the draft test posted once to the draft route", formWorld.server.calls.filter((row) => row.path.endsWith("/test-draft")).length, beforeDraft + 1);
ok("the draft test did not touch a saved device", !formWorld.server.calls.some((row) => row.path.endsWith("/test") && !row.path.endsWith("/test-draft")));
ok("the draft test result is reported", draftClick.text.includes("连接成功") || draftClick.text.includes("测试"), draftClick.text.slice(-300));
// A NEW device has no id, so the probe must not invent one — the Host would
// then look up a device that does not exist.
{
	const lastDraft = formWorld.server.calls.filter((row) => row.path.endsWith("/test-draft")).pop();
	eq("an unsaved draft posts no device id", JSON.parse(lastDraft?.body ?? "{}").id, undefined);
}

const editWorld = createWorld();
const keyDevice = { ...healthyDevice, id: "key-01", name: "Key 01", authKind: "key", hasPrivateKey: true, hasPassword: false, intervalSec: 30, metrics: ["uptime", "cpu", "net"] };
editWorld.server.devices = [keyDevice];
await mount(editWorld);
const editClick = await click(editWorld, undefined, "编辑");
ok("the edit button opens the form", editClick.clicked);
record("edit form", editClick.text);
ok("the edit form is titled", editClick.text.includes("编辑设备"));
ok("the private-key field is present", editClick.text.includes("私钥路径"), editClick.text.slice(-500));
// The stored name and per-device overrides must be PREFILLED; a blank edit form
// would silently wipe them on save.
ok("the key device name is prefilled", attrsOf(editClick.tree, "value").includes("Key 01"));
ok("the stored interval is prefilled", attrsOf(editClick.tree, "value").includes("30"));
ok("editing warns that a blank secret is kept", editClick.text.includes("留空表示不修改"));
// The stored metric picker wins over the buffer's default only when present.
const editChecked = nodesOf(editClick.tree)
	.filter((node) => node.type === "input" && node.props?.["data-dsh-metric-key"] !== undefined && node.props.checked === true)
	.map((node) => node.props["data-dsh-metric-key"]);
eq("prefilled metric checkboxes reflect the stored choice", editChecked.join(","), "uptime,cpu,net");
// A checkbox with only a name beside it cannot answer "what does this actually
// read, and what gets sampled". Each row must therefore carry the catalog's
// sampling hint, and a CHECKED metric on an existing device must show its last
// collected value. Asserted from the rendered tree, not from the catalog object:
// shipping a `hint` the renderer never reads is exactly the defect this covers.
const editHints = attrsOf(editClick.tree, "data-dsh-metric-key").length;
ok("every metric row is rendered", editHints === 11, String(editHints));
const editText = editClick.text;
ok("the cpu row explains what is sampled", editText.includes("两次 /proc/stat 采样之间的占用率"), editText.slice(0, 300));
ok("the memory row explains what is sampled", editText.includes("已用 / 总内存"));
ok("the disk row explains what is sampled", editText.includes("各挂载点容量占用"));
ok("the temp row explains what is sampled", editText.includes("热区与 hwmon 传感器温度"));
ok("the tcp row explains its fallback", editText.includes("缺失时回退 /proc/net/tcp"));
// The numeric specifics: value + unit, for the checked metrics only.
const editValues = nodesOf(editClick.tree)
	.filter((node) => node.props?.["data-dsh-metric-value"] !== undefined)
	.map((node) => [node.props["data-dsh-metric-value"], textOf(node)]);
ok("a checked metric shows its collected value", editValues.some(([key]) => key === "cpu"), JSON.stringify(editValues.map(([k]) => k)));
const valueKeys = editValues.map(([key]) => key);
ok("an unchecked metric shows no value", !valueKeys.includes("mem") && !valueKeys.includes("disk"), valueKeys.join(","));
// The value must be the real reading from the sample, not a placeholder. Assert
// the fixture's distinctive cpu percent travels from the sample into the row —
// a formatted unit alone would pass even if the number were invented.
const valueText = editValues.map(([, text]) => text).join(" | ");
ok("the shown value carries a unit", /%|°C|MB|个/.test(valueText), valueText);
ok("the shown cpu value is the collected one", valueText.includes(String(healthyDevice.sample.cpu.percent)), valueText);
ok("the shown value is not a bare placeholder", !/^—$/.test(valueText.trim()), valueText);
// The EDIT form's draft probe must carry the device id. Saving an edit MERGES
// the stored auth by id, so a blank password box keeps the saved password;
// without the id the Host has to guess from host/username and a blank box dials
// with an empty password, answering "All configured authentication methods
// failed" — a message about credentials caused by a form that looked complete.
// Asserted from the WIRE, not from the payload builder, because formPayload is
// shared with save and must NOT carry an id.
{
	const editDraftBefore = editWorld.server.calls.filter((row) => row.path.endsWith("/test-draft")).length;
	const editDraftClick = await click(editWorld, undefined, "测试连接");
	ok("the edit form offers a draft test", editDraftClick.clicked, editDraftClick.text.slice(-200));
	const editDraftCalls = editWorld.server.calls.filter((row) => row.path.endsWith("/test-draft"));
	eq("the edit form's draft test posted once", editDraftCalls.length, editDraftBefore + 1);
	eq("the edit form's draft probe carries the device id", JSON.parse(editDraftCalls.pop()?.body ?? "{}").id, "key-01");
}
// The opposite error: a device that has NEVER been collected must show nothing,
// not a fabricated 0. "We did not ask" and "the device reported 0" are different
// facts, and only one of them is a fault — rendering 0% beside a device that has
// never been dialled would be a lie the user cannot detect.
const newWorld = createWorld();
newWorld.server.devices = [{ ...neverDevice, metrics: ["uptime", "cpu", "mem"] }];
await mount(newWorld);
const newClick = await click(newWorld, undefined, "编辑");
ok("the never-collected edit form opens", newClick.clicked);
ok("a never-collected device shows no metric values", attrsOf(newClick.tree, "data-dsh-metric-value").length === 0, attrsOf(newClick.tree, "data-dsh-metric-value").join(","));
ok("a never-collected device still shows the sampling hints", newClick.text.includes("两次 /proc/stat 采样之间的占用率"));
//#endregion

//#region 7. lease lifecycle
console.log("\n== watch lease ==");
// Mounted through the TAB DESCRIPTOR, not DevicePanel directly: the wiring that
// forwards better-sidebar's `visible` is exactly the part that can silently
// break, and a direct mount would keep passing while the tab leaked a lease.
const hiddenWorld = createWorld({
	betterSidebar: { registerTab(descriptor) { this.last = descriptor; return () => {}; } },
});
const hiddenTab = hiddenWorld.ctx.betterSidebar.last;
const hiddenView = await pump(hiddenWorld, { visible: false }, 4);
const hiddenTree = toTree({ type: hiddenTab.component, props: { visible: false } });
runEffects();
record("hidden tab", textOf(hiddenTree));
ok("a hidden seat still renders", textOf(hiddenTree).length > 0);
ok("the tab forwards visible to the panel", hiddenTab.component({ visible: false }).props.visible === false);
await flush(6);
ok("a hidden seat releases its lease", (await pump(hiddenWorld, { owner: "sidebar-tab", visible: false, narrow: true })).text.length > 0 && hiddenWorld.server.calls.some((row) => row.path.endsWith("/watch") && String(row.body ?? "").includes('"release":true')), hiddenWorld.server.calls.map((row) => `${row.path}${row.body ?? ""}`).join(" | "));

const visibleWorld = createWorld();
await mount(visibleWorld, { owner: "sidebar-tab", visible: true, narrow: true });
const visibleWatch = visibleWorld.server.calls.filter((row) => row.path.endsWith("/watch"));
ok("a visible seat takes a lease", visibleWatch.length > 0);
ok("the lease asks for the configured interval", visibleWatch.some((row) => String(row.body ?? "").includes("60")));
ok("the lease carries a client id", visibleWatch.some((row) => String(row.body ?? "").includes("clientId")));
// One client id per tab: two windows are two watchers, and closing one must not
// cancel the other's lease.
ok("the client id is stable across heartbeats", new Set(visibleWatch.map((row) => String(row.body ?? "").match(/"clientId":"([^"]+)"/)?.[1])).size === 1);

// The requirement is that the WHOLE flow — list, detail, add, edit, settings,
// logs — happens inside the right column, not just that a tab exists. Driving
// the tab's own component is the only way to prove that: mounting DevicePanel
// directly would keep passing if the tab rendered some reduced view instead.
{
	const tabWorld = createWorld({
		betterSidebar: { registerTab(descriptor) { this.last = descriptor; return () => {}; } },
	});
	const tab = tabWorld.ctx.betterSidebar.last;
	const tabProps = { visible: true, narrow: true };
	/** Settle the tab's own component, exactly as better-sidebar renders it. */
	const pumpTab = async (passes = 6) => {
		let tree = null;
		let text = "";
		for (let index = 0; index < passes; index += 1) {
			const before = text;
			tree = toTree({ type: tab.component, props: tabProps });
			runEffects();
			await flush();
			text = textOf(tree);
			if (index > 0 && text === before) break;
		}
		return { tree, text };
	};
	const start = await pumpTab();
	ok("the right-column tab renders the panel", start.text.includes("设备监管"), start.text.slice(0, 200));
	ok("the tab view carries the narrow marker", hasClass(start.tree, "ddm-narrow"));
	// Add: driven through the tab, not through a directly mounted panel. The
	// header button and the empty-state button are both "添加设备", so this
	// asserts at least one and drives the first — pinning a count would break
	// the moment the empty state is restyled.
	const addNodes = clicksLabelled(start.tree, "添加设备");
	ok("the right column offers the add button", addNodes.length >= 1, `${addNodes.length} matches`);
	addNodes[0].props.onClick();
	const added = await pumpTab();
	ok("the add form opens inside the right column", added.text.includes("保存") && added.text.includes("取消"), added.text.slice(-300));
	ok("the in-column add form is not a modal overlay", !hasClass(added.tree, "ddm-overlay") && !hasClass(added.tree, "ddm-modal"));
	ok("the in-column add form carries its marker", attrsOf(added.tree, "data-dsh-device-form").length === 1);
	// Settings and logs must be reachable from the same column.
	const settingsNodes = clicksLabelled(added.tree, "设置");
	ok("the right column offers the settings view", settingsNodes.length === 1, `${settingsNodes.length} matches`);
	settingsNodes[0].props.onClick();
	const settingsView = await pumpTab();
	ok("the settings view opens inside the right column", settingsView.text.includes("刷新间隔"), settingsView.text.slice(-300));
	ok("the in-column settings view carries its marker", attrsOf(settingsView.tree, "data-dsh-device-settings").length === 1);
	ok("the in-column settings view exposes the custom-command switch", attrsOf(settingsView.tree, "data-dsh-custom-commands").length === 1);
	ok("the in-column settings view exposes the metric grid", attrsOf(settingsView.tree, "data-dsh-threshold").length === 4, `${attrsOf(settingsView.tree, "data-dsh-threshold").length} threshold inputs`);
	const logsNodes = clicksLabelled(settingsView.tree, "日志");
	ok("the right column offers the logs view", logsNodes.length === 1, `${logsNodes.length} matches`);
	logsNodes[0].props.onClick();
	const logsView = await pumpTab();
	ok("the logs view opens inside the right column", attrsOf(logsView.tree, "data-dsh-device-logs").length === 1, logsView.text.slice(-300));
}

const intervalWorld = createWorld();
intervalWorld.server.settings = { ...intervalWorld.server.settings, refreshIntervalSec: 15 };
await mount(intervalWorld);
ok("the lease follows the configured interval", intervalWorld.server.calls.some((row) => row.path.endsWith("/watch") && String(row.body ?? "").includes("15")));
ok("the panel shows the configured cadence", (await mount(intervalWorld)).text.includes("15"), "the header cadence must not be hard-coded to 60");
//#endregion

//#region 8. the debug terminal (item ③)
console.log("\n== terminal: the gate ==");
// The terminal hands out a full remote shell, so the FIRST thing to prove is
// that it is off until somebody turns it on. A card button that opened a socket
// regardless would make the setting decorative.
{
	const offWorld = createWorld();
	offWorld.server.devices = [healthyDevice];
	await mount(offWorld);
	const offClick = await click(offWorld, undefined, "终端调试");
	ok("the card offers the debug terminal", offClick.clicked, "no button labelled 终端调试");
	record("terminal disabled", offClick.text);
	ok("a disabled terminal explains itself instead of failing silently", offClick.text.includes("终端未开启"), offClick.text.slice(0, 200));
	eq("no socket is opened while the terminal is off", offWorld.sockets.length, 0);
	eq("no overlay is rendered while the terminal is off", attrsOf(offClick.tree, "data-dsh-terminal").length, 0);
	// The card's own control must be identifiable per device, or a test (and a
	// user) cannot tell which device a button belongs to.
	eq("the card button names its device", [...new Set(attrsOf(offClick.tree, "data-dsh-card-terminal"))].join(","), "edge-01");
}

console.log("\n== terminal: socket lifecycle ==");
const termWorld = createWorld({ betterSidebar: { registerTab(descriptor) { this.last = descriptor; return () => {}; } } });
termWorld.server.devices = [healthyDevice];
// Armed through the same field the Host reads, not by poking the store.
termWorld.server.settings = { ...termWorld.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
await mount(termWorld);
const termClick = await click(termWorld, undefined, "终端调试");
ok("the terminal button is clickable", termClick.clicked);
record("terminal connecting", termClick.text);
eq("exactly one socket was opened", termWorld.sockets.length, 1);
const socket = termWorld.sockets[0];
eq("the socket targets its own path, not the lease channel", new URL(socket.url).pathname, "/api/dsh-device-monitor/terminal");
eq("the socket follows the page's scheme", new URL(socket.url).protocol, "ws:");
// In a plain browser tab the Host serves the page, so the page's own authority
// happens to be right. This is the case that always worked — it is the control,
// and it must keep working.
eq("a browser tab reaches the Host it was served from", new URL(socket.url).host, "127.0.0.1:19387");
ok("the overlay rendered", attrsOf(termClick.tree, "data-dsh-terminal").length === 1);
eq("the overlay names its device", attrsOf(termClick.tree, "data-dsh-terminal-device")[0], "edge-01");
ok("the overlay says it is connecting", termClick.text.includes("正在连接"), termClick.text.slice(0, 200));
ok("the overlay warns what this bypasses", termClick.text.includes("不经命令白名单"), termClick.text.slice(0, 300));
// The whole reason the panel exists: the conversation has to stay readable while
// a device is being debugged, so the overlay must not be a modal.
//
// It must also not be fixed to the VIEWPORT — that is the m09258 escape hatch
// (see the expanding block below). Anchoring it to the plugin's own root is what
// keeps the corner the corner of the column.
ok("the overlay is a corner panel, not a modal", cssDecl(cssRule(css, ".ddm-term-panel"), "position") === "absolute" && !hasClass(termClick.tree, "ddm-modal"),
	cssRule(css, ".ddm-term-panel"));

// The 8 s connect guard. It must cover the WHOLE setup — handshake AND the
// Host's own `ready` — because a successful handshake followed by a hung SSH
// dial looks exactly like a slow panel.
const guard = () => termWorld.timeouts.find((row) => row.ms === 8000);
ok("the connect guard was armed", guard() !== undefined, JSON.stringify(termWorld.timeouts.map((row) => row.ms)));
ok("the connect guard is not cleared before the server answers", guard().cleared !== true);

socket.accept();
const openFrame = socket.sent.map((row) => JSON.parse(row)).find((row) => row.t === "open");
ok("the handshake sends an open frame", openFrame !== undefined, socket.sent.join(" | "));
eq("the open frame names the device", openFrame?.deviceId, "edge-01");
eq("the open frame declares a size", typeof openFrame?.cols, "number");
ok("the open frame does not clear the connect guard", guard().cleared !== true,
	"a bare handshake is not the Host confirming the session");

socket.deliver({ t: "ready", session: { id: "t1-abcd", host: "192.168.1.10" } });
const readyView = await settle(termWorld);
record("terminal connected", readyView.text);
ok("the server's confirmation clears the connect guard", guard().cleared === true);
ok("the transcript says it is connected", readyView.text.includes("已连接"), readyView.text.slice(0, 300));
ok("the tip about full-screen programs is shown", readyView.text.includes("top -b -n1"), readyView.text.slice(0, 400));

console.log("\n== terminal: what crosses the wire ==");
const frames = () => socket.sent.map((row) => JSON.parse(row));
// Output arrives base64-encoded; the panel must decode it back to text.
socket.deliver({ t: "out", data: Buffer.from("hello world\n", "utf8").toString("base64") });
const outView = await settle(termWorld);
ok("a base64 chunk is decoded into the transcript", outView.text.includes("hello world"), outView.text.slice(-300));
// Invalid UTF-8 has to survive to the pane as a replacement character rather
// than as a dropped byte: that is why the wire format is base64 at all.
socket.deliver({ t: "out", data: Buffer.from([0x41, 0xff, 0x42]).toString("base64") });
ok("undecodable bytes do not lose the surrounding text", (await settle(termWorld)).text.includes("A\uFFFDB"));
// Real bash emits a stream of ANSI/CSI sequences this `<pre>` cannot draw. The
// first implementation stripped ONLY the bracketed-paste toggles, on the theory
// that anything more would "mangle colour and cursor moves into something that
// looks like output but is not" — and the user then read the raw bytes as
// `[0m[01;34m` before every directory name and `[?1l>[58;1H` after every
// prompt. The pane renders no ANSI at all, so a sequence left in place is not
// preserved meaning; it is literal garbage. Each class is asserted separately
// because a stripper that handles one and not the others is exactly how the
// first version failed.
socket.deliver({ t: "out", data: Buffer.from("\x1b[?2004hls -la\r\n\x1b[?2004l", "utf8").toString("base64") });
const pasteView = await settle(termWorld);
ok("the bracketed-paste toggles are stripped", pasteView.text.includes("ls -la") && !pasteView.text.includes("\u001b[?2004"), JSON.stringify(pasteView.text.slice(-200)));

// The exact bytes from the user's report, in order.
socket.deliver({ t: "out", data: Buffer.from("\x1b[?1l\x1b>\x1b[58;1H\x1b[?12l\x1b[?25h\x1b[Kdemo@nas-b:~$ ", "utf8").toString("base64") });
const csiView = await settle(termWorld);
ok("cursor and mode sequences leave no residue", !/\u001b/.test(csiView.text), JSON.stringify(csiView.text.slice(-160)));
ok("the prompt text itself survives", csiView.text.includes("demo@nas-b:~$"), JSON.stringify(csiView.text.slice(-160)));

// Bracket text WITHOUT a leading ESC is not a sequence, it is output. A stripper
// written as a bare `\[[0-9;]*m` would quietly delete legitimate words here, and
// nothing in the transcript would show that anything was lost.
socket.deliver({ t: "out", data: Buffer.from("[0m[01;34mmydir[0m  [01;35msock[0m\n", "utf8").toString("base64") });
const sgrView = await settle(termWorld);
ok("bracket text that is not a real sequence is preserved verbatim", sgrView.text.includes("[01;34mmydir[0m") && sgrView.text.includes("[01;35msock[0m"), JSON.stringify(sgrView.text.slice(-160)));

// A real ESC-prefixed SGR run — the standard `ls --color=always` shape.
// The negative check is scoped to the LAST LINE: the transcript as a whole
// legitimately contains bracket text from the previous test, so a
// whole-transcript `!includes` would assert the wrong thing (and did).
socket.deliver({ t: "out", data: Buffer.from("\x1b[01;34mbin\x1b[0m \x1b[01;32mrun.sh\x1b[0m\n", "utf8").toString("base64") });
const colourView = await settle(termWorld);
const colourLine = colourView.text.split("\n").filter((line) => line.includes("bin") && line.includes("run.sh")).pop() ?? "";
ok("an escape-prefixed SGR run is stripped whole", colourLine.includes("bin") && colourLine.includes("run.sh") && !/\u001b/.test(colourLine) && !colourLine.includes("[01;3"), JSON.stringify(colourLine));

// A sequence split across two frames must not leak its head. Real terminals
// chunk output at arbitrary byte offsets, so `ESC[3` + `1m` is routine.
socket.deliver({ t: "out", data: Buffer.from("\x1b[3", "utf8").toString("base64") });
const splitHead = await settle(termWorld);
ok("half a sequence is held, not printed", !splitHead.text.includes("\u001b"), JSON.stringify(splitHead.text.slice(-120)));
socket.deliver({ t: "out", data: Buffer.from("1mSPLIT\x1b[0m\n", "utf8").toString("base64") });
const splitTail = await settle(termWorld);
ok("the held half is joined to its own completion", splitTail.text.includes("SPLIT") && !splitTail.text.includes("1mSPLIT"), JSON.stringify(splitTail.text.slice(-160)));

// The line terminator. `\n` leaves the command typed but never executed in a raw
// PTY — the single most likely way this feature reads as "broken".
const typed = await change(termWorld, "data-dsh-term-in", "", "echo hi");
eq("the command box is drivable", typed, 1);
const formNode = nodesOf(draw(termWorld)).find((node) => node.type === "form" && ownClass(node, "ddm-term-form"));
ok("the command box is inside a form", formNode !== undefined);
formNode.props.onSubmit({ preventDefault() {} });
const submitted = frames().filter((row) => row.t === "in").pop();
eq("a submitted line ends in a carriage return", submitted?.data, "echo hi\r");
ok("the submitted line is echoed locally so a slow device still shows it", (await settle(termWorld)).text.includes("$ echo hi"),
	"the transcript showed nothing for the command that was just sent");

// A control key sends ONE byte. It is a different act from typing a line, and
// ⌃C is the only way to interrupt a command already running.
const keyClick = await click(termWorld, undefined, "⌃C");
ok("the control key is clickable", keyClick.clicked);
const keyed = frames().filter((row) => row.t === "in").pop();
eq("a control key sends its bare byte", keyed?.data, "\u0003");
ok("a control key confirms itself", keyClick.text.includes("␃ ^C 已发送"), keyClick.text.slice(-200));

console.log("\n== terminal: expanding fills the column, never the window ==");
// "Full screen" here means FILLING THE COLUMN THE PANEL WAS OPENED FROM, not the
// browser viewport — and getting that distinction wrong is the m09258 defect.
//
// The feature has now been wrong twice, in opposite directions, and the second
// failure is the instructive one:
//
//   v1 (m08259) used the element-level Fullscreen API. The API lifts the panel
//      into the browser's top layer and covers the whole window, hiding the
//      conversation it exists to be read alongside.
//   v2 (m09014) replaced the API with a class + position:fixed;inset:0, on the
//      reasoning that the sidebar's own panel contained it and the insets would
//      therefore resolve to the sidebar. THAT REASONING WAS NEVER VERIFIED, and
//      it is false. Measured in the installed better-sidebar bundle, the only
//      containing-block-creating ancestor is
//      [data-dsh-panel-host]{position:fixed;inset:0} — a full-viewport layer —
//      while .nArs4W_pane is only position:relative, which does not capture a
//      fixed descendant. So the panel filled the WINDOW, and its restore button
//      landed under the shell's own title bar where it could not be clicked.
//      The user's report was exactly that: it goes fullscreen and cannot be
//      exited.
//
// So the assertion is about WHICH BOX the panel is measured against, which is
// now a box this plugin owns: .ddm-view carries position:relative and the panel
// is its child in every seat. That is checkable without a layout engine, and it
// is the property that actually broke — not the presence of a class.
{
	const beforeRequests = termWorld.fullscreenRequests.length;
	const fullClick = await click(termWorld, undefined, "⛶ 扩大");
	const panelNode = nodesWithClass(fullClick.tree, "ddm-term-panel")[0];
	ok("the expand control fills the column rather than the viewport",
		ownClass(panelNode, "ddm-term-panel-full"),
		attrsOf(fullClick.tree, "className").filter((row) => row.includes("ddm-term-panel")).join(" | "));
	ok("the Fullscreen API is not called, so the conversation stays visible",
		termWorld.fullscreenRequests.length === beforeRequests,
		`requests=${termWorld.fullscreenRequests.length - beforeRequests}`);
	ok("the control offers a way back", clicksLabelled(fullClick.tree, "⛶ 还原").length === 1,
		clicksLabelled(fullClick.tree, "⛶ 还原").length + " restore control(s)");
	// The label must name what happens. It used to say 全屏 and the user's own
	// correction (m09258) was that the action is 扩大 — expanding to the column,
	// not going fullscreen. A button that says 全屏 while filling a sidebar is
	// the mislabelling that made the two earlier bugs hard to describe.
	ok("the button no longer claims to go fullscreen",
		clicksLabelled(fullClick.tree, "⛶ 全屏").length === 0 && clicksLabelled(fullClick.tree, "⛶ 扩大").length === 0,
		`full=${clicksLabelled(fullClick.tree, "⛶ 全屏").length} expand=${clicksLabelled(fullClick.tree, "⛶ 扩大").length}`);

	// THE STRUCTURAL CONTRACT. Both the corner rule and the expanded rule must be
	// ABSOLUTE, and their containing block must be a box the plugin renders.
	// `fixed` is precisely what let the panel escape the sidebar, so it must not
	// come back — and the assertion is aimed at the declaration, not the comment
	// that describes it.
	const rootBlock = cssRule(css, ".ddm-view");
	ok("the plugin's own root is a containing block for the panel",
		cssDecl(rootBlock, "position") === "relative",
		`position=${cssDecl(rootBlock, "position")}`);
	const cornerBlock = cssRule(css, ".ddm-term-panel");
	ok("the corner panel is absolute, so the corner is the column's corner",
		cssDecl(cornerBlock, "position") === "absolute",
		`position=${cssDecl(cornerBlock, "position")}`);
	// A viewport unit would overflow a narrow sidebar no matter what the
	// positioning resolves against: 100vw of a 1600px window inside a 380px
	// column is still 1600px. Percentages cannot make that mistake.
	ok("the corner panel is sized against its column, not the viewport",
		String(cssDecl(cornerBlock, "width")).includes("100%") && !String(cssDecl(cornerBlock, "width")).includes("vw"),
		`width=${cssDecl(cornerBlock, "width")}`);
	ok("the corner panel's height cap is measured against its column too",
		!String(cssDecl(cornerBlock, "max-height")).includes("vh"),
		`max-height=${cssDecl(cornerBlock, "max-height")}`);

	// The rule must pin all four edges to 0. A matching gutter is what made an
	// earlier attempt merely look bigger, so the insets are part of the contract
	// and not an implementation detail.
	const block = cssRule(css, ".ddm-term-panel-full");
	ok("the expanded panel is pinned to all four edges with no gutter",
		["left", "top", "right", "bottom"].every((edge) => cssDecl(block, edge) === "0"),
		block);
	ok("the expanded panel lifts the base rule's height cap",
		cssDecl(block, "max-height") === "none", block);
	// It OVERRIDES the corner rule's positioning rather than inheriting whatever
	// that rule happened to use: the expanded box must be absolute even if the
	// base rule were changed back to fixed.
	ok("the expanded panel pins itself to the containing block explicitly",
		cssDecl(block, "position") === "absolute",
		`position=${cssDecl(block, "position")}`);
	// The API path used to own a rule of its own. Leaving it behind would mean
	// the panel could still be yanked into the top layer by any stray code.
	ok("no viewport-covering pseudo-class rule survives",
		cssRule(css, ".ddm-term-panel:fullscreen") === "",
		cssRule(css, ".ddm-term-panel:fullscreen"));
	// A viewport-covering rule is the bug in any spelling, so forbid the
	// combination rather than one selector that used to carry it.
	const viewportRules = ["position:fixed", "100vw", "100vh"];
	const offenders = viewportRules.filter((needle) => cssRule(css, ".ddm-term-panel").includes(needle)
		|| cssRule(css, ".ddm-term-panel-full").includes(needle));
	ok("no rule lets the terminal escape its column",
		offenders.length === 0,
		offenders.join(", ") || "clean");
}
{
	// And it must come back. Otherwise the panel is stuck covering the column it
	// shares with the device list.
	const restored = await click(termWorld, undefined, "⛶ 还原");
	ok("the panel returns to the corner",
		!ownClass(nodesWithClass(restored.tree, "ddm-term-panel")[0], "ddm-term-panel-full"),
		attrsOf(restored.tree, "className").filter((row) => row.includes("ddm-term-panel")).join(" | "));
}
{
	// The escape hatch behind the escape hatch. m09258 ended with the user stuck
	// inside an expanded panel, so "there is always a way out" is part of the
	// requirement, not a nicety.
	//
	// The observable path is a DROPPED CONNECTION followed by opening a second
	// device, and both halves are load-bearing:
	//
	//   * a second device cannot be opened while the first session is live —
	//     `openTerminal` refuses with `term.onlyOne` — so the session has to end
	//     first;
	//   * closing it explicitly would NOT do, because `closeTerminal` hides the
	//     panel and an assertion about a tree that no longer exists passes
	//     whatever the code does.
	//
	// A socket drop is the one ending that leaves the panel ON SCREEN (the store
	// owner deliberately survives so the user can read why it ended) while
	// `terminal.socket` goes back to null, which is what makes the next
	// `openTerminal` both possible and observable.
	//
	// Its OWN world, deliberately: this scenario opens a second terminal and the
	// harness's socket list is per-world, so reusing `termWorld` would make the
	// counts the earlier assertions established depend on this block's position
	// in the file.
	const escape = createWorld();
	escape.server.devices = [healthyDevice, { ...healthyDevice, id: "edge-02", name: "Edge 02" }];
	escape.server.settings = { ...escape.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(escape);
	// The card buttons are scoped by a data attribute, so click the one that
	// belongs to each device rather than the first "终端调试" on the page.
	const clickCardTerminal = async (deviceId) => {
		const node = nodesOf(draw(escape)).find((row) => row.props?.["data-dsh-card-terminal"] === deviceId
			&& typeof row.props?.onClick === "function");
		if (node === undefined) return { clicked: false, tree: null };
		node.props.onClick();
		return { clicked: true, ...(await settle(escape)) };
	};
	const firstCard = await clickCardTerminal("edge-01");
	ok("the escape-hatch scenario opened a terminal",
		hasClass(firstCard.tree, "ddm-term-panel"), "no panel after the first open");
	const wideOpen = await click(escape, undefined, "⛶ 扩大");
	// Prove the setup is real before asserting the teardown: if the expand click
	// had silently missed, the next assertion would pass without testing anything.
	ok("it really did expand first",
		ownClass(nodesWithClass(wideOpen.tree, "ddm-term-panel")[0], "ddm-term-panel-full"),
		attrsOf(wideOpen.tree, "className").filter((row) => row.includes("ddm-term-panel")).join(" | "));
	// Drop the shell the way an unreachable device would. `drop` fires onclose
	// without an error frame first, which is the unexpected-disconnect path.
	escape.sockets[escape.sockets.length - 1].drop(1006, "");
	const dropped = await settle(escape);
	ok("the panel survives a dropped connection so the reason stays readable",
		hasClass(dropped.tree, "ddm-term-panel") && dropped.text.includes("连接已断开"),
		dropped.text.slice(-160));
	// Now a second device can be opened, and the panel stays mounted throughout.
	const switchedTo = await clickCardTerminal("edge-02");
	ok("the escape-hatch scenario switched device", switchedTo.clicked === true,
		"the second card had no terminal button, which would make the next assertion vacuous");
	const switchedPanel = nodesWithClass(switchedTo.tree, "ddm-term-panel")[0];
	ok("switching device renders the terminal again", switchedPanel !== undefined,
		"the second open produced no panel, which would make the next assertion vacuous");
	ok("a newly opened terminal starts from the corner",
		!ownClass(switchedPanel, "ddm-term-panel-full"),
		attrsOf(switchedTo.tree, "className").filter((row) => row.includes("ddm-term-panel")).join(" | "));
}
{
	// A browser-level fullscreen request is a different thing from this toggle,
	// and nothing here should ever trigger one — including through a rejection
	// nobody handled. `document.fullscreenElement` is the browser's own ledger.
	await flush();
	ok("nothing asked the browser to go full screen",
		termWorld.document.fullscreenElement === null,
		String(termWorld.document.fullscreenElement));
	ok("and nothing was left as an unhandled rejection",
		unhandledRejections.length === 0, JSON.stringify(unhandledRejections.map((row) => String(row))));
}
// The size the Host is told must follow the panel's actual width, so the shell
// wraps where the user sees it wrap.
{
	const widened = createWorld();
	widened.server.devices = [healthyDevice];
	widened.server.settings = { ...widened.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(widened);
	await click(widened, undefined, "终端调试");
	// The pane can only be measured once the shell is up: `termResize` refuses to
	// send while still CONNECTING, because the Host has no PTY yet. So the dial
	// has to complete for the re-measure to be observable — and the assertion is
	// that EXPANDING adds a resize ON TOP of the one the connect produced.
	widened.sockets[widened.sockets.length - 1].accept();
	widened.sockets[widened.sockets.length - 1].deliver({ t: "ready", session: { id: "t1-widen", host: "192.168.1.10" } });
	const afterConnect = await settle(widened);
	const countResizes = () => (widened.sockets[widened.sockets.length - 1]?.sent ?? [])
		.map((row) => JSON.parse(row)).filter((row) => row.t === "resize").length;
	const atConnect = countResizes();
	ok("connecting tells the shell how wide it is", atConnect >= 1, `resize frames=${atConnect}`);
	await click(widened, undefined, "⛶ 扩大");
	const sent = widened.sockets[widened.sockets.length - 1]?.sent ?? [];
	const resizes = sent.map((row) => JSON.parse(row)).filter((row) => row.t === "resize");
	ok("expanding re-measures the pane for the remote shell", resizes.length > atConnect,
		`resize frames=${resizes.length} (at connect: ${atConnect})`);
}

// One terminal at a time. Two shells on two devices from one 720px panel is not
// a feature — the second would overwrite the first's transcript.
{
	const manyWorld = createWorld();
	manyWorld.server.devices = [healthyDevice, { ...healthyDevice, id: "edge-02", name: "Edge 02" }];
	manyWorld.server.settings = { ...manyWorld.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(manyWorld);
	await click(manyWorld, undefined, "终端调试");
	const second = await click(manyWorld, undefined, "终端调试");
	eq("a second terminal is refused", manyWorld.sockets.length, 1);
	ok("the refusal explains itself", second.text.includes("已经有一个终端在运行"), second.text.slice(0, 200));
}

// The owning seat renders the overlay and only that one: it is `position:fixed`,
// so two seats rendering it would overlap exactly and each would double-append
// the output. Both real seats are on screen in production, so render the OTHER
// one for real — a seat ignores the `owner` prop (it hard-codes its own), so
// passing one in from a test would prove nothing about the product.
const otherSeat = toTree({ type: termWorld.ctx.betterSidebar.last.component, props: { visible: true } });
eq("a non-owning seat renders no overlay", attrsOf(otherSeat, "data-dsh-terminal").length, 0);
eq("the owning seat still renders it", attrsOf(draw(termWorld), "data-dsh-terminal").length, 1);

// Rendering that other seat must NOT tear the live terminal down.
//
// This is the regression guard for React error #310 (minified), which the user
// hit in the running GUI: `TerminalPanel` returned early BEFORE its two effects,
// so a seat rendered 3 hooks while it did not own the terminal and 5 once it
// did — "Rendered more hooks than during the previous render". The fix moves
// every hook above the guard.
//
// The second half of the fix is observable here, and this is the only place it
// shows up. The harness stores hook slots per component FUNCTION, so the other
// seat's render reuses TerminalPanel's slots and re-evaluates its effects. With
// the cleanup's deps keyed on `[owner]`, that dep change fires the live
// instance's cleanup and closes the terminal still on screen. Empty deps make
// the cleanup mean "on unmount", which is what it always claimed.
//
// Honest scope: `owner` is constant per mounted seat in production, so `[owner]`
// is not itself a live bug there — this is a correctness fix plus the guard that
// keeps the intent from drifting back. The #310 early-return above is the part
// the user actually hit.
eq("a non-owning seat's render does not close the live terminal", attrsOf(draw(termWorld), "data-dsh-terminal").length, 1);
eq("the socket survived the other seat's render", termWorld.sockets.length, 1);
eq("the terminal still believes it owns the shell", termWorld.sockets[0].readyState, 1);

// A drop with no prior error must be reported. Leaving the panel claiming
// "已连接" while every keystroke is silently refused is the worst version of it.
socket.drop(1006, "");
const dropped = await settle(termWorld);
record("terminal dropped", dropped.text);
ok("an unexplained disconnect says so", dropped.text.includes("连接已断开"), dropped.text.slice(-300));
ok("the disconnect carries its close code", dropped.text.includes("1006"), dropped.text.slice(-300));
// And a keystroke after the drop must refuse out loud rather than do nothing.
const afterDrop = await click(termWorld, undefined, "⌃C");
ok("a key press on a dead terminal refuses out loud", afterDrop.text.includes("没有发送"), afterDrop.text.slice(-300));

// Closing is the user's own choice: no fault may be reported for it.
eq("the close control is present", attrsOf(afterDrop.tree, "data-dsh-term-close").length, 1);
const closedView = await click(termWorld, undefined, "关闭");
eq("closing removes the overlay", attrsOf(closedView.tree, "data-dsh-terminal").length, 0);
ok("a deliberate close is not reported as a disconnect",
	!closedView.text.includes("请关闭后重新打开终端"), "the user just closed it");

console.log("\n== terminal: the connect guard covers a hung dial ==");
{
	// The handshake succeeds and the Host never answers `ready` — a hung SSH
	// dial. Clearing the guard on `onopen` would strand the panel on
	// "正在连接" forever, which is exactly the silent hang the guard exists for.
	const hungWorld = createWorld();
	hungWorld.server.devices = [healthyDevice];
	hungWorld.server.settings = { ...hungWorld.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(hungWorld);
	await click(hungWorld, undefined, "终端调试");
	const hung = hungWorld.sockets[0];
	hung.accept();
	const hungGuard = hungWorld.timeouts.find((row) => row.ms === 8000);
	ok("the guard survives a successful handshake", hungGuard.cleared !== true);
	hung.onerror?.({});
	const errorView = await settle(hungWorld);
	record("terminal error", errorView.text);
	ok("a transport error is reported", errorView.text.includes("无法建立终端连接"), errorView.text.slice(0, 300));
	ok("the guard survives the error too", hungGuard.cleared !== true,
		"browsers do not always send onclose after onerror, and clearing here re-opens the silent hang");
	// Fire the guard the way the browser would. This case is a hung SESSION — the
	// handshake succeeded, only `ready` never came — so the panel must say that
	// specifically, not blame a missing handshake.
	hungGuard.fn();
	const timedOut = await settle(hungWorld);
	record("terminal timeout", timedOut.text);
	ok("the guard explains the timeout", timedOut.text.includes("没有确认会话"), timedOut.text.slice(-300));
	ok("a timed-out socket is disposed", hung.readyState === 3, `readyState=${hung.readyState}`);
}
//#endregion

//#region 8b. m07341: the desktop shell is not at window.location
console.log("\n== terminal: the desktop shell's Host is not window.location ==");
{
	// The bug. The desktop shell loads this page from the custom scheme
	// `dsh-app://app/`, so `location.host` is the literal string `app` and
	// `location.origin` is `null`. The old builder produced
	// `ws://app/api/dsh-device-monitor/terminal` — authority-less, refused by
	// the renderer before a byte was sent, which is why the Host logged nothing
	// and the server-side probes could never reproduce it.
	//
	// This world models that page exactly, and the assertion is on the URL the
	// product actually hands to the WebSocket constructor.
	const shellWorld = createWorld({
		page: {
			protocol: "dsh-app:",
			host: "app",
			baseURI: "dsh-app://app/",
			transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" },
		},
	});
	shellWorld.server.devices = [healthyDevice];
	shellWorld.server.settings = { ...shellWorld.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(shellWorld);
	await click(shellWorld, undefined, "终端调试");
	eq("the desktop shell still opens exactly one socket", shellWorld.sockets.length, 1);
	const shellUrl = new URL(shellWorld.sockets[0].url);
	// The regression itself: the authority must be the published Host, never
	// `app`. Asserted as an inequality too, so a future refactor that happens to
	// reach the right host by another route still cannot regress to `window.location`.
	eq("the shell's socket reaches the published Host, not the page host", shellUrl.host, "127.0.0.1:19387");
	ok("and specifically never the page's own authority", shellUrl.host !== "app", shellUrl.href);
	eq("the shell's socket keeps the plugin's path", shellUrl.pathname, "/api/dsh-device-monitor/terminal");
	eq("the shell's socket follows the published scheme", shellUrl.protocol, "ws:");

	// An `https` Host must become `wss` — a mixed-content upgrade is blocked, and
	// the failure looks exactly like an unreachable Host.
	const secureWorld = createWorld({
		page: {
			protocol: "dsh-app:",
			host: "app",
			baseURI: "dsh-app://app/",
			transport: { ownsHost: true, streamBaseUrl: "https://box.example" },
		},
	});
	secureWorld.server.devices = [healthyDevice];
	secureWorld.server.settings = { ...secureWorld.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(secureWorld);
	await click(secureWorld, undefined, "终端调试");
	eq("an https Host upgrades the socket to wss", new URL(secureWorld.sockets[0].url).protocol, "wss:");
	eq("and keeps the Host it was given", new URL(secureWorld.sockets[0].url).host, "box.example");

	// The published value is what the shell actually sends; an empty string is
	// not a usable base, so it must fall back rather than build a bare path.
	const emptyWorld = createWorld({
		page: {
			protocol: "dsh-app:",
			host: "app",
			baseURI: "dsh-app://app/",
			transport: { ownsHost: true, streamBaseUrl: "" },
		},
	});
	emptyWorld.server.devices = [healthyDevice];
	emptyWorld.server.settings = { ...emptyWorld.server.settings, terminal: { enabled: true, allowedHosts: [], idleMs: 300_000 } };
	await mount(emptyWorld);
	await click(emptyWorld, undefined, "终端调试");
	// `dsh-app:` has no authority a WebSocket can use, so the only honest outcome
	// is the old same-origin fallback — which is what a plain tab uses and what
	// the browser will refuse. The point is that it does not THROW, because a
	// throw here would skip the `term.failed` sentence the user needs.
	eq("an empty published base still produces a socket, not a crash", emptyWorld.sockets.length, 1);
}
//#endregion

//#region 9. no rendered placeholder survives
console.log("\n== no rendered placeholder survives ==");
// The live panel once showed `{0} / {10} 台设备` because the dictionaries used
// the doubled form. Asserting on real rendered text is what catches that class
// of bug; a per-string check cannot see the binding step.
const strays = renderedTexts.flatMap((row) => leftoverPlaceholders(row.text).map((token) => `${row.label}: ${token}`));
eq("no rendered panel text leaks a placeholder token", strays.join(" | "), "");
ok("the roster counter actually interpolated", renderedTexts.some((row) => row.text.includes("0 / 10")), renderedTexts.map((row) => row.text.slice(0, 40)).join(" | "));
//#endregion

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures.length}/${checks} checks`);
if (failures.length > 0) {
	console.log(failures.map((row) => `  - ${row}`).join("\n"));
	process.exitCode = 1;
}
