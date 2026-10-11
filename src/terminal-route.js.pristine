/**
 * The terminal WebSocket upgrade route.
 *
 * This is the transport half of the 「终端调试」 feature: it upgrades a
 * loopback HTTP request into a WebSocket, opens a PTY on the device, and
 * pumps bytes in both directions. Everything it can be wrong about lives in
 * {@link file://./terminal.js} instead — session caps, the idle timer, the
 * allowlist — so this module stays deliberately dumb.
 *
 * Three transport decisions worth stating outright:
 *
 *   A SEPARATE PATH. The terminal gets its own upgrade path rather than
 *   sharing a channel with the read-only metric stream. Merging them would
 *   mean a read-only consumer and a write-capable shell travel the same
 *   handler, and the loopback/allowlist checks would have to be made
 *   conditional on the frame type — a mistake that quietly hands out a shell.
 *
 *   OUTPUT IS BASE64. A remote PTY emits arbitrary bytes. Decoding them into
 *   a JSON string as UTF-8 replaces every invalid sequence with U+FFFD, and
 *   that is not recoverable downstream: `vim` and `top` visibly corrupt,
 *   because they paint with escape sequences and box-drawing bytes.
 *
 *   THE HOST DOES NOT LOOK AT INPUT. See the module docblock in
 *   `src/terminal.js` for why: with a full-screen program there is no command
 *   boundary on this side to inspect. The client composes bytes (a line plus
 *   `\r`, or a bare `\x03` for Ctrl+C) and the Host forwards them verbatim.
 *   Writing `\n` instead of `\r` does not confirm the line in a raw-mode PTY.
 */
import { API_BASE } from "./routes.js";
import { isLoopbackRequest } from "./http.js";
import { audit } from "./logs.js";
import { softImport } from "./resolve.js";
import { TerminalManager } from "./terminal.js";

/** The upgrade path. Distinct from every JSON route, and from the API base. */
export const TERMINAL_PATH = `${API_BASE}/terminal`;

/** How often to probe a socket that has gone quiet. */
const HEARTBEAT_MS = 30_000;

/** Largest single input frame accepted, in bytes of decoded text. */
const MAX_INPUT_BYTES = 8 * 1024;

/** Largest single output frame sent, before the PTY stream is chunked. */
const MAX_OUTPUT_CHUNK = 64 * 1024;

/**
 * Build the terminal session manager and the upgrade route.
 *
 * @param store - the device roster.
 * @param options.getSettings - live settings reader for the terminal subtree.
 * @param options.openShell - injectable PTY opener, for tests.
 * @param options.lookup - injectable DNS resolver, for tests.
 * @param options.logger - optional cordis logger.
 * @returns `{manager, route}` where `route` is `{path, handler}` for
 *   `ctx.webServer.registerUpgrade`.
 */
export function makeTerminal(store, options = {}) {
	const manager = new TerminalManager(store, {
		getSettings: options.getSettings,
		openShell: options.openShell,
		lookup: options.lookup,
	});
	const logger = options.logger;
	// Injectable like `openShell` and `lookup`: the third silent exit (a Host
	// with no `ws`) can only be exercised by making the import fail, and a
	// branch that is never run is a branch that is never checked.
	const loadWs = options.loadWs ?? softImport;

	const handler = async (req, socket, head) => {
		// Record that an upgrade was ATTEMPTED before deciding anything about
		// it. This exists because the refusal path below was, for a while,
		// completely silent: it wrote no audit row and no log line, so "the
		// browser was refused" and "the request never arrived" produced the
		// same empty evidence. A user staring at 「无法建立终端连接」 was
		// unanswerable.
		//
		// Headers only, never a body, and never a credential: `host`, `origin`
		// and `sec-fetch-site` are exactly the three inputs the fence reads, so
		// they are what a later reader needs to reproduce the decision.
		const attempt = {
			from: req.socket?.remoteAddress ?? "",
			host: typeof req.headers?.host === "string" ? req.headers.host : "",
			origin: typeof req.headers?.origin === "string" ? req.headers.origin : "",
			site: typeof req.headers?.["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"] : "",
			url: typeof req.url === "string" ? req.url : "",
		};
		audit("terminal.upgrade", attempt);

		// The JSON guard already refuses non-loopback callers, but an upgrade
		// request never passes through it: this handler is invoked directly by
		// the server's `upgrade` listener. So the fence is repeated here. A
		// shell is the highest-value thing this plugin can hand out, and a check
		// that is not on the only path to it is not a check.
		if (!isLoopbackRequest(req)) {
			audit("terminal.upgradeDenied", attempt);
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const wsModule = await loadWs("ws");
		// `ws` is CommonJS: an ESM import of it yields a namespace whose `default`
		// is `module.exports`, so the constructors live one level down. Reading
		// only the top level finds nothing and silently reports "ws is missing"
		// on a Host where it is installed.
		const wsRoot = wsModule?.WebSocketServer === undefined ? wsModule?.default : wsModule;
		const WebSocketServer = wsRoot?.WebSocketServer ?? wsRoot?.Server;
		if (typeof WebSocketServer !== "function") {
			// The third silent exit. A Host without `ws` answers 503, and the
			// browser reports the very same 「无法建立终端连接」 as it does for a
			// refusal, so it is recorded for the same reason: without this row a
			// 503 is indistinguishable from a request that never arrived.
			audit("terminal.upgradeUnavailable", attempt);
			socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
			socket.destroy();
			logger?.warn?.("[dsh-device-monitor] the ws module is unavailable; the terminal is disabled");
			return;
		}
		const wss = new WebSocketServer({ noServer: true });
		wss.handleUpgrade(req, socket, head, (ws) => {
			void serveTerminal(ws, req, manager, logger);
		});
	};

	return { manager, route: { path: TERMINAL_PATH, handler } };
}

/**
 * Drive one terminal connection.
 *
 * Lifecycle: the first frame must be `open`, naming the device. Until it
 * arrives the socket is inert, so an accidental connection that sends nothing
 * cannot open anything. After the shell exists, every path out of this
 * function closes the session — a WebSocket left open with no owner would
 * hold a live shell on the device.
 *
 * Exported for the test suite. It takes the manager rather than reaching for
 * one, so the transport can be driven over a fake socket with an injected PTY.
 */
export async function serveTerminal(ws, req, manager, logger) {
	let session;
	// `session` is only assigned once the dial RESOLVES, so it cannot also mean
	// "an open is already in flight". Without this flag two `open` frames that
	// arrive in the same tick both pass the `session !== undefined` test, both
	// dial, and the one that loses the race is dropped on the floor — a live
	// shell on the device that nothing will ever close.
	let opening = false;
	let stream;
	let heartbeat;
	const remoteAddress = req.socket?.remoteAddress;

	const send = (payload) => {
		if (ws.readyState !== 1) return;
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			// A send failure means the socket is going away; the close handler
			// does the bookkeeping.
		}
	};

	const finish = (reason) => {
		opening = false;
		if (session !== undefined) {
			manager.close(session.id, reason);
			session = undefined;
		}
		if (heartbeat !== undefined) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
	};

	ws.on("message", (raw, isBinary) => {
		if (isBinary) return;
		let frame;
		try {
			frame = JSON.parse(raw.toString("utf8"));
		} catch {
			send({ t: "error", reason: "terminal.badFrame", message: "无法解析的帧" });
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		void handle(frame);
	});

	const handle = async (frame) => {
		if (frame.t === "open") {
			if (session !== undefined || opening) return;
			opening = true;
			const result = await manager.open({
				deviceId: typeof frame.deviceId === "string" ? frame.deviceId : "",
				remoteAddress,
				cols: frame.cols,
				rows: frame.rows,
				by: typeof frame.by === "string" ? frame.by : "",
				socketId: socketIdOf(ws, req),
			});
			if (!result.ok) {
				opening = false;
				send({ t: "error", reason: result.reason, message: result.message });
				// A refusal is terminal: this socket exists only to carry a shell,
				// and leaving it open invites a retry loop against a device that
				// has already said no.
				try {
					ws.close(1008, result.reason);
				} catch {
					// ignore
				}
				return;
			}
			opening = false;
			// The socket may have died while the dial was in flight. The PTY is
			// open now, so it has to be closed here — `finish` already ran, and
			// its `session === undefined` branch had nothing to close yet.
			if (ws.readyState !== 1) {
				manager.close(result.session.id, "连接已断开");
				return;
			}
			session = result.session;
			stream = session.stream;
			attachStream();
			send({
				t: "ready",
				session: {
					id: session.id,
					deviceId: session.deviceId,
					deviceName: session.deviceName,
					host: session.host,
					username: session.username,
					from: session.from,
				},
				limits: { maxPerDevice: 3, maxTotal: 10 },
			});
			heartbeat = setInterval(() => {
				if (ws.readyState !== 1) {
					finish("连接已断开");
					return;
				}
				try {
					ws.ping();
				} catch {
					// ignore
				}
			}, HEARTBEAT_MS);
			heartbeat.unref?.();
			return;
		}
		// Every other frame is meaningless without a shell, and silently
		// ignoring them would make a client bug look like a slow device.
		if (session === undefined || stream === undefined) {
			send({ t: "error", reason: "terminal.noSession", message: "尚未打开终端会话" });
			return;
		}
		if (frame.t === "in") {
			const data = typeof frame.data === "string" ? frame.data : "";
			if (data === "") return;
			const bytes = Buffer.byteLength(data, "utf8");
			if (bytes > MAX_INPUT_BYTES) {
				send({ t: "error", reason: "terminal.inputTooLarge", message: `单次输入超过 ${MAX_INPUT_BYTES} 字节` });
				return;
			}
			session.bytesIn += bytes;
			manager.touch(session.id);
			// Forwarded verbatim. NOT logged: session open/close is audited, the
			// keystrokes are not (see the module docblock in `src/terminal.js`).
			try {
				stream.write(data);
			} catch (error) {
				send({ t: "error", reason: "terminal.writeFailed", message: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		if (frame.t === "resize") {
			const cols = clampDimension(frame.cols, 80, 20, 400);
			const rows = clampDimension(frame.rows, 24, 5, 200);
			try {
				stream.setWindow(rows, cols, 0, 0);
			} catch {
				// A PTY that refuses a resize is not an error worth surfacing:
				// the shell keeps working at the old size.
			}
			manager.touch(session.id);
			return;
		}
		if (frame.t === "close") {
			finish("用户关闭");
			try {
				ws.close(1000, "closed");
			} catch {
				// ignore
			}
		}
	};

	/** Pump PTY output out, then close the session when the shell ends. */
	function attachStream() {
		stream.on("data", (chunk) => {
			if (session !== undefined) session.bytesOut += chunk.length;
			if (ws.readyState !== 1) return;
			for (let offset = 0; offset < chunk.length; offset += MAX_OUTPUT_CHUNK) {
				send({ t: "out", data: chunk.subarray(offset, offset + MAX_OUTPUT_CHUNK).toString("base64") });
			}
		});
		stream.on("close", () => {
			send({ t: "exit" });
			finish("远端已结束");
			try {
				ws.close(1000, "exit");
			} catch {
				// ignore
			}
		});
		stream.on("error", (error) => {
			send({ t: "error", reason: "terminal.streamError", message: error instanceof Error ? error.message : String(error) });
		});
		stream.stderr?.on("data", (chunk) => {
			if (session !== undefined) session.bytesOut += chunk.length;
			if (ws.readyState !== 1) return;
			send({ t: "out", data: chunk.toString("base64") });
		});
	}

	ws.on("close", () => {
		// Covers the browser tab closing, a network drop, and the client's own
		// `close` frame. The idle timer covers the cases this event does NOT
		// fire for: a killed process, a sleeping machine.
		finish("连接已断开");
		logger?.debug?.("[dsh-device-monitor] terminal socket closed");
	});
	ws.on("error", () => {
		finish("连接出错");
	});
}

/**
 * A stable per-socket identifier.
 *
 * The session manager keys ownership on this and closes by it, so it must be
 * derivable from the socket itself rather than from anything the client sends
 * — a client-supplied id could claim another live terminal's socket and close
 * it. The random suffix guarantees uniqueness even when two upgrade requests
 * arrive from the same remote port over time.
 */
function socketIdOf(ws, req) {
	if (ws.__ddmSocketId === undefined) {
		const address = req.socket?.remoteAddress ?? "";
		const port = req.socket?.remotePort ?? 0;
		ws.__ddmSocketId = `${address}:${port}:${Math.random().toString(36).slice(2, 10)}`;
	}
	return ws.__ddmSocketId;
}

function clampDimension(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}
