/**
 * HTTP plumbing for the device-monitor route family.
 *
 * The trust fence is the important part. These endpoints execute commands on
 * remote machines and hand out device credentials, so they must never be
 * reachable from a LAN-exposed Harness deployment: every request is checked
 * for a loopback socket address AND a loopback `Host` header before it is
 * allowed through. A socket address is authoritative; `X-Forwarded-For` is
 * never consulted.
 */

/** Cap on a request body; a device payload is tiny. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
};

/** True when a dotted-quad names the 127/8 range. */
function isIPv4Loopback(value) {
	const parts = value.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** True when a socket remote address is loopback (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
	if (address === undefined) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}

/** True when a hostname names a loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}

/**
 * The desktop shell's own page origin.
 *
 * The shell loads the app page from the custom scheme `dsh-app://app/`, so a
 * WebSocket it opens carries `Origin: dsh-app://app` — not a loopback hostname,
 * and not even a hostname in the DNS sense. Refusing it was half of m07341:
 * the terminal could not connect from the desktop window even though the same
 * code worked in a plain browser tab.
 *
 * Accepting it is safe HERE and only here, because it is consulted solely after
 * `isLoopbackAddress(request.socket.remoteAddress)` and a loopback `Host` header
 * have both already passed. A remote attacker cannot forge either of those, so
 * this constant widens the set of accepted *page origins* without widening the
 * set of accepted *callers*. `dsh-app://shell` is deliberately NOT accepted:
 * only the app document talks to this plugin.
 */
const DESKTOP_APP_ORIGIN = "dsh-app://app";

/**
 * Whether a request may reach a device-monitor route.
 * @returns `true` for a same-origin loopback request.
 */
export function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let parsed;
	try {
		parsed = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(parsed.hostname)) return false;
	const origin = request.headers.origin;
	// The desktop shell's page is judged as a WHOLE, before `sec-fetch-site`.
	//
	// That ordering is deliberate, not incidental. The shell page is
	// `dsh-app://app` and the Host is `http://127.0.0.1:<port>`: a different
	// scheme AND a different host, so the browser labels the upgrade
	// `Sec-Fetch-Site: cross-site` even though it is our own UI. Checking
	// cross-site first would therefore refuse the very caller we are trying to
	// admit, and the fix would look like it did nothing.
	//
	// Why this is still a fence and not a hole: `Origin` is set by the browser
	// and a web page cannot claim a custom scheme, so a hostile page sends its
	// own origin (or `null`) and is still refused below. A non-browser client
	// can forge the header, but it must also present a loopback socket address
	// and a loopback `Host` to get this far — by which point it already has
	// local access, which is the thing this fence was never able to defend
	// against.
	if (origin === DESKTOP_APP_ORIGIN) return true;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	if (origin === undefined) return true;
	try {
		return isLoopbackHostname(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/** Write one JSON response. */
export function writeJson(res, status, body) {
	res.writeHead(status, JSON_HEADERS);
	res.end(JSON.stringify(body));
}

/** Read and parse a JSON request body; `null` when absent or malformed. */
export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) {
			req.destroy();
			return null;
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return null;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The value of a query parameter, or undefined. */
export function queryParam(url, name) {
	const value = url.searchParams.get(name);
	return value === null || value === "" ? undefined : value;
}

/** A JSON error body from any thrown value. */
export function errorBody(error) {
	return { error: error instanceof Error ? error.message : String(error) };
}

/** The HTTP status a thrown store/validation error should carry. */
export function statusOf(error, fallback = 400) {
	const status = error?.statusCode;
	return typeof status === "number" && status >= 400 && status < 600 ? status : fallback;
}
