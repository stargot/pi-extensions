/**
 * Wire protocol v1 for the local browser bridge: the WS server hosted by
 * pi-web (extensions/web/fetch/bridge.ts) talks to the pi-web-companion
 * browser extension over ws://127.0.0.1.
 *
 * This module is the single source of the contract (plan §3); the companion
 * repo mirrors it verbatim in src/shared/protocol.ts with a "sync with
 * pi-extensions …/fetch/bridge-protocol.ts" header.
 *
 * Pure module: no I/O, no imports at all — unit-testable standalone per the
 * repo rule (tests never import index/tool modules).
 */

/** Protocol version carried in the `v` field of every message. */
export const PROTOCOL_VERSION = 1;

// ── client → server ────────────────────────────────────────────────

/** Extension → server handshake: shared token plus client identity. */
export interface HelloMsg {
	v: 1;
	type: "hello";
	/** Shared secret from ~/.pi/agent/web-bridge-token (or PI_WEB_BRIDGE_TOKEN). */
	token: string;
	client: "pi-web-companion";
	clientVersion: string;
}

/**
 * Extension → server outcome of a job. An ok:false carries a reason; the
 * bridge maps every failure — including its own server-side timeouts — to
 * renderFn → null. renderFn never throws (plan §3 semantics).
 */
export type ResultMsg =
	| {
			v: 1;
			type: "result";
			/** Job id the result answers; unknown/expired ids get error/unknown-id. */
			id: string;
			ok: true;
			markdown: string;
			title: string | null;
			/** URL after redirects, as reported by the browser. */
			finalUrl: string;
	  }
	| {
			v: 1;
			type: "result";
			id: string;
			ok: false;
			reason: "timeout" | "navigation-failed" | "render-failed" | "unreadable";
			message?: string;
	  };

/** Extension → server keep-alive; also keeps the MV3 service worker alive. */
export interface PingMsg {
	v: 1;
	type: "ping";
	/** Date.now() at send time; informational only, no clock assumptions. */
	ts: number;
}

// ── server → client ────────────────────────────────────────────────

/** Server's answer to a hello: accept, or reject with a reason (then close). */
export type HelloReplyMsg =
	| { v: 1; type: "hello_ok"; server: "pi-web"; serverVersion: string }
	| { v: 1; type: "hello_err"; reason: "auth" | "version"; detail?: string };

/** Server → extension render job; url has already passed the SSRF guard. */
export interface JobMsg {
	v: 1;
	type: "job";
	/** Server-generated id (crypto.randomUUID()). */
	id: string;
	url: string;
	/** Client-side budget for the whole page (load + extraction). */
	timeoutMs: number;
	/** Truncate markdown to this many characters client-side. */
	maxChars: number;
}

/** Server's reply to a client ping. */
export interface PongMsg {
	v: 1;
	type: "pong";
	/** Echo of the ping's ts. */
	ts: number;
}

/**
 * Server → extension protocol-level error (bad framing, unknown job id).
 * Never a job failure — those travel as result/ok:false.
 */
export interface ErrorMsg {
	v: 1;
	type: "error";
	reason: "unknown-type" | "bad-json" | "bad-v" | "unknown-id";
	detail?: string;
}

/** Any protocol message, either direction. */
export type BridgeMessage =
	| HelloMsg
	| ResultMsg
	| PingMsg // client → server
	| HelloReplyMsg
	| JobMsg
	| PongMsg
	| ErrorMsg; // server → client

// ── defaults (plan §2) ─────────────────────────────────────────────

/**
 * Default port range, in the same "from-to" string form as the
 * PI_WEB_BRIDGE_PORTS env var so config code (readBridgeConfig, task B2)
 * can treat env value and default uniformly. Ten ports leave room for
 * parallel pi sessions; 8787 is taken by the session-trace precedent.
 */
export const DEFAULT_PORT_RANGE = "8790-8799";

/** Server-side TTL for a dispatched job: past it, the render promise → null. */
export const JOB_TIMEOUT_MS = 45_000;

/**
 * How long the server waits for a client to (re)connect when a job is
 * dispatched with no client attached, before resolving null.
 */
export const BRIDGE_GRACE_MS = 10_000;

/** Default maxChars: markdown is truncated client-side, re-checked server-side. */
export const MAX_CHARS = 1_000_000;

/** Markdown shorter than this reads as a stub (login form, captcha), not content. */
export const MIN_MARKDOWN_LENGTH = 100;

/** Client application-level ping interval (also keeps the MV3 SW alive). */
export const PING_INTERVAL_MS = 20_000;

/** Server ws-level ping interval; two missed pongs → terminate. */
export const SERVER_PING_INTERVAL_MS = 30_000;

// ── parsing ────────────────────────────────────────────────────────

/** Message type discriminators known to this protocol version. */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
	"hello",
	"result",
	"ping",
	"hello_ok",
	"hello_err",
	"job",
	"pong",
	"error",
]);

/**
 * Parse one WS text frame into a BridgeMessage. Intentionally shallow:
 * JSON.parse in a try, then shape discrimination only — the payload must be
 * a non-null, non-array object with v === PROTOCOL_VERSION and a known
 * type discriminator. Every deviation returns null; this function never
 * throws. Deep field validation (token is a string, timeoutMs is a positive
 * number, …) is deliberately NOT done here — consumers validate the fields
 * they act on, after narrowing by type (and map protocol-level rejects to
 * error messages with reason "unknown-type" / "bad-json" / "bad-v").
 */
export function parseBridgeMessage(raw: string): BridgeMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const { v, type } = parsed as { v?: unknown; type?: unknown };
	if (v !== PROTOCOL_VERSION) {
		return null;
	}
	if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
		return null;
	}
	return parsed as BridgeMessage;
}
