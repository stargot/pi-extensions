/**
 * WS server for the local browser bridge (plan §4, task B2): binds
 * ws://127.0.0.1 over a small port range so parallel pi sessions coexist,
 * speaks protocol v1 (./bridge-protocol.ts) with the pi-web-companion
 * browser extension, and exposes the render surface fetcher's `renderFn`
 * consumes (the extension wiring is task B4).
 *
 * Division of labour with the kernel (./bridge-core.ts): this module owns
 * everything with a socket in it — ports, the origin filter, hello
 * handshakes, the per-IP auth-failure ban, heartbeats — and delegates all
 * state (client registry, job registry, FIFO queue, TTL/grace timers,
 * token checks) to the kernel. Job delivery rides the kernel's onDeliver
 * hook: when the kernel assigns a job, the ticket is serialized into a
 * JobMsg and sent to the chosen client's socket.
 *
 * Security posture (plan §2):
 * - bind strictly 127.0.0.1, never a routable interface;
 * - upgrade-time origin filter: browsers attach Origin to WS handshakes,
 *   so an evil web page is rejected (403) before any token is exchanged;
 *   node clients and browser extensions (chrome-extension:// /
 *   moz-extension://) pass through to token auth;
 * - shared token checked by the kernel's constant-time checkToken; a
 *   missing token file is generated (crypto.randomBytes(32), base64url)
 *   and persisted so the user can paste it into the extension once;
 * - 3 failed auths from one IP → that IP is banned for 60s (defence
 *   against blind local scanners hitting the port range).
 *
 * Failure semantics (plan §3): the bridge never throws at callers.
 * startBridge exhausting the port range → a handle with status
 * "disabled" (render always resolves null), not a throw. Policy gates —
 * the min-markdown-length check and the maxChars re-check — run here on
 * the result path, server-side. close() is idempotent: it fails all live
 * jobs, terminates every socket and closes the server exactly once.
 */

import { randomBytes, randomUUID } from "node:crypto";
// The fs module is imported as a namespace-style default (property access
// at call time) so tests can intercept writeFileSync and replay the
// concurrent-first-start race deterministically (see
// test/bridge-config.test.ts): named ESM imports bind to a module
// snapshot and would bypass such a patch.
import fs from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
} from "node:http";
import type { Duplex } from "node:stream";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";
import {
	checkToken,
	createBridgeCore,
	type BridgeCore,
	type BridgeCoreConfig,
	type DispatchedJob,
} from "./bridge-core.ts";
import {
	MIN_MARKDOWN_LENGTH,
	PROTOCOL_VERSION,
	SERVER_PING_INTERVAL_MS,
	DEFAULT_PORT_RANGE,
	parseBridgeMessage,
	type BridgeMessage,
	type HelloReplyMsg,
	type JobMsg,
	type PingMsg,
	type ResultMsg,
} from "./bridge-protocol.ts";
import type { RenderResult } from "./fetcher.ts";

/**
 * Bridge server version reported in hello_ok. Informational only (the
 * companion displays it); independent of the npm package version.
 */
const SERVER_VERSION = "1.0.0";

/** How long an unauthenticated connection has to say hello. */
const HELLO_TIMEOUT_MS = 5_000;

/** Failed auths from one IP before it is banned. */
const MAX_AUTH_FAILURES = 3;

/** How long an IP stays banned after MAX_AUTH_FAILURES bad tokens. */
const AUTH_BAN_MS = 60_000;

/** Missed server pings before a socket is terminated (plan §3: two). */
const MAX_MISSED_PINGS = 2;

// ── config ─────────────────────────────────────────────────────────

/** Static configuration for startBridge (see readBridgeConfig). */
export interface BridgeConfig {
	/** Ports to try in order; the first free one wins. 0 → OS-assigned. */
	ports: number[];
	/**
	 * Shared token. When absent, it is read from tokenFile at server
	 * start; a missing file is generated and written back (pairing).
	 */
	token?: string;
	/** Path of the pairing token file (see resolveTokenFilePath). */
	tokenFile: string;
	/** Remaining fields pass through to createBridgeCore (tests tune TTLs). */
	graceMs?: number;
	jobTimeoutMs?: number;
	maxChars?: number;
	/** Clock/timer seam forwarded to the kernel; default: the globals. */
	timers?: BridgeCoreConfig["timers"];
}

/**
 * Port-range spec shared by the PI_WEB_BRIDGE_PORTS env var and the
 * default: a single "8790" or an inclusive "8790-8799". Canonical
 * semantics, kept identical on the companion side
 * (pi-web-companion src/options/validate.ts, plan §4/B2): integers,
 * from ≥ 1024 (no privileged ports), to ≤ 65535, from ≤ to; a single port
 * is the from == to degenerate range. Throws on any deviation —
 * readBridgeConfig translates that into the default range.
 */
export function parsePortRange(range: string): number[] {
	const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
	if (!match) {
		throw new Error(`Invalid port range: ${JSON.stringify(range)}`);
	}
	const from = Number(match[1]);
	const to = match[2] === undefined ? from : Number(match[2]);
	if (!Number.isInteger(from) || !Number.isInteger(to)) {
		throw new Error(`Invalid port range: ${JSON.stringify(range)}`);
	}
	if (from < 1024 || to > 65535 || from > to) {
		throw new Error(
			`Port range out of bounds (1024–65535, from ≤ to): ${JSON.stringify(range)}`,
		);
	}
	const ports: number[] = [];
	for (let port = from; port <= to; port++) ports.push(port);
	return ports;
}

/**
 * Parse a single port ("8790", whitespace-tolerant) with the same bounds
 * as parsePortRange: integer, ≥ 1024, ≤ 65535. This is the grammar of
 * PI_WEB_BRIDGE_PORT — a range there is invalid (PI_WEB_BRIDGE_PORTS is
 * the range variable). Throws on any deviation.
 */
export function parseSinglePort(port: string): number {
	const trimmed = port.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid port: ${JSON.stringify(port)}`);
	}
	const value = Number(trimmed);
	if (value < 1024 || value > 65535) {
		throw new Error(
			`Port out of bounds (1024–65535): ${JSON.stringify(port)}`,
		);
	}
	return value;
}

/**
 * Default location of the pairing token file: <agentDir>/web-bridge-token,
 * with agentDir resolved by the pi host (getAgentDir). Extracted so the
 * wiring step (B4) can re-point it if the host's docs say otherwise, and
 * so tests never touch the real file (they pass tokenFile explicitly).
 */
export function resolveTokenFilePath(): string {
	return join(getAgentDir(), "web-bridge-token");
}

/**
 * Bridge configuration from the environment (plan §2):
 * - PI_WEB_BRIDGE_PORT — a single port (the range grammar lives in
 *   PI_WEB_BRIDGE_PORTS, which it overrides); the default range applies
 *   otherwise. An invalid value never throws — it degrades to the default
 *   range;
 * - PI_WEB_BRIDGE_TOKEN (inline) wins over PI_WEB_BRIDGE_TOKEN_FILE
 *   (path); the default is resolveTokenFilePath().
 */
export function readBridgeConfig(
	env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
	let ports: number[];
	try {
		ports = env.PI_WEB_BRIDGE_PORT
			? [parseSinglePort(env.PI_WEB_BRIDGE_PORT)]
			: parsePortRange(env.PI_WEB_BRIDGE_PORTS ?? DEFAULT_PORT_RANGE);
	} catch {
		ports = parsePortRange(DEFAULT_PORT_RANGE);
	}
	const token = env.PI_WEB_BRIDGE_TOKEN || undefined;
	const tokenFile = env.PI_WEB_BRIDGE_TOKEN_FILE || resolveTokenFilePath();
	return { ports, token, tokenFile };
}

// ── handle ─────────────────────────────────────────────────────────

/** Live (or disabled) bridge server, the unit the extension wires up. */
export interface BridgeHandle {
	/** Actually bound port (OS-assigned when the range contained 0). */
	port: number;
	/** "disabled" = every port in the range was taken (or startup failed). */
	status: "listening" | "disabled";
	/** Why the bridge is disabled; present only when status is. */
	disabledReason?: string;
	/**
	 * Render a page through a connected browser client. Never throws and
	 * never rejects: every failure — no client, TTL, abort, unreadable
	 * page — resolves null (fetcher's honest-empty contract).
	 */
	render(url: string, signal?: AbortSignal): Promise<RenderResult | null>;
	/** Number of currently connected authenticated clients. */
	clients(): number;
	/** Idempotent shutdown: fail jobs, drop sockets, release the port. */
	close(): Promise<void>;
}

// ── token pairing ──────────────────────────────────────────────────

/**
 * Read the shared token from `file`; when absent, generate one
 * (crypto.randomBytes(32) → base64url) and persist it (plan §2 pairing:
 * the user pastes it into the extension's options once). The write is
 * mkdir -p + mode 600 — silently relaxed on NTFS, matching the threat
 * model (same-user processes can read anything anyway). Creation is
 * race-safe ('wx', O_EXCL): two pi sessions first-starting simultaneously
 * converge on ONE token — the create's winner persists its token, the
 * loser gets EEXIST, re-reads and adopts the winner's token (each session
 * generating its own would leave the companion, pairable with only one,
 * locked out of the other bridge). Throws only when neither reading nor
 * writing is possible — startBridge turns that into a disabled bridge
 * rather than a crashed session.
 *
 * Exported so the config unit tests (test/bridge-config.test.ts) can cover
 * the generate-and-persist pairing without a live server (socket lifecycle
 * is bridge.test.ts's job).
 */
export function loadOrCreateToken(file: string): string {
	// Bounded loop: the fast path is a read of an existing file; on a miss
	// we create with 'wx' (O_EXCL) so exactly one concurrent first-start
	// writes its token and the losers adopt it. The loop (not a bare
	// EEXIST branch) also covers the transient window where the winner has
	// created the file but not flushed its bytes yet: re-read and adopt
	// instead of generating a rival token.
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const existing = fs.readFileSync(file, "utf8").trim();
			if (existing) return existing;
		} catch {
			// Fall through to creation (ENOENT is the expected path).
		}
		const token = randomBytes(32).toString("base64url");
		fs.mkdirSync(dirname(file), { recursive: true });
		try {
			fs.writeFileSync(file, `${token}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			// Lost the create race: loop back and adopt the winner's token
			// (see the docblock — divergent tokens break pairing).
		}
	}
	// The file exists but still reads empty after every attempt (an aborted
	// first write — no paired token exists anywhere to adopt). Heal it the
	// historical way: plain truncating overwrite.
	const token = randomBytes(32).toString("base64url");
	fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
	return token;
}

// ── origin filter ──────────────────────────────────────────────────

/**
 * Upgrade-time origin filter (plan §2): browsers attach Origin to every
 * WS handshake, so a malicious web page probing ws://127.0.0.1 is
 * rejected before the token exchange. No Origin (node clients, tests)
 * and browser-extension origins are allowed through to token auth.
 */
export function originAllowed(origin: string | undefined): boolean {
	if (!origin) return true;
	return (
		origin.startsWith("chrome-extension://") ||
		origin.startsWith("moz-extension://")
	);
}

/** Reject an upgrade with a plain HTTP 403 before any WS framing. */
function rejectUpgrade(socket: Duplex): void {
	socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	socket.destroy();
}

// ── server ─────────────────────────────────────────────────────────

interface ClientEntry {
	id: string;
	ws: WebSocket;
	authenticated: boolean;
	ip: string;
	missedPings: number;
	helloTimer?: NodeJS.Timeout;
	/** Safety net for closes where the client must hear the verdict. */
	terminateTimer?: NodeJS.Timeout;
}

export async function startBridge(
	config: BridgeConfig,
): Promise<BridgeHandle> {
	// Token resolution is lazy, at server start (plan §2 pairing): the
	// file is only touched when a bridge will actually listen.
	let token: string;
	try {
		token = config.token ?? loadOrCreateToken(config.tokenFile);
	} catch (error) {
		return disabledHandle(
			`token file unavailable: ${errorMessage(error)}`,
		);
	}

	/** Tickets for jobs awaiting a client result (for gates + aborts). */
	const pending = new Map<string, DispatchedJob>();
	const clients = new Map<string, ClientEntry>();
	const authFailures = new Map<string, number>();
	const bans = new Map<string, number>(); // ip → ban expiry (epoch ms)

	let closed = false;

	// Kernel → WS delivery: when the core assigns a job — immediately at
	// dispatch, or later when a settle frees a slot and the queue advances
	// — serialize the ticket into a JobMsg. A hard send failure fails the
	// job server-side (same give-up vocabulary as TTL expiry); the job's
	// own TTL remains the backstop for anything subtler.
	const core: BridgeCore = createBridgeCore({
		graceMs: config.graceMs,
		jobTimeoutMs: config.jobTimeoutMs,
		maxChars: config.maxChars,
		timers: config.timers,
		onDeliver(job, clientId) {
			const entry = clients.get(clientId);
			if (!entry || !entry.authenticated) {
				core.fail(job.id, "timeout");
				return;
			}
			const jobMsg: JobMsg = {
				v: 1,
				type: "job",
				id: job.id,
				url: job.url,
				timeoutMs: job.timeoutMs,
				maxChars: job.maxChars,
			};
			try {
				entry.ws.send(JSON.stringify(jobMsg), (error) => {
					if (error) core.fail(job.id, "timeout");
				});
			} catch {
				core.fail(job.id, "timeout");
			}
		},
	});

	// Origin filter at upgrade time: rejected handshakes never become
	// sockets, let alone reach the token check. Banned IPs (after three
	// bad tokens) are dropped at the same gate.
	const wss = new WebSocketServer({ noServer: true });
	const server = createServer();
	server.on("upgrade", (request, socket, head) => {
		const ip = request.socket.remoteAddress ?? "unknown";
		if (closed || banned(ip) || !originAllowed(request.headers.origin)) {
			rejectUpgrade(socket);
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request);
		});
	});

	let port = 0;
	let bound = false;
	for (const candidate of config.ports) {
		try {
			await listenOn(server, candidate);
			bound = true;
			break;
		} catch {
			// EADDRINUSE (another pi session owns it) or EACCES — next port.
		}
	}
	if (!bound) {
		return disabledHandle(
			`no free port in ${config.ports.join(", ")}`,
		);
	}
	// Post-listen server errors (never expected) must not crash the host
	// session — the bridge degrades, it never throws.
	server.on("error", () => {});
	port = (server.address() as { port: number }).port;

	wss.on(
		"connection",
		(ws: WebSocket, request: IncomingMessage) => {
			if (closed) {
				ws.terminate();
				return;
			}
			const entry: ClientEntry = {
				id: randomUUID(),
				ws,
				authenticated: false,
				ip: request.socket.remoteAddress ?? "unknown",
				missedPings: 0,
			};
			clients.set(entry.id, entry);

			// Hello must arrive within HELLO_TIMEOUT_MS; the timer is
			// cleared on successful auth or socket close.
			entry.helloTimer = setTimeout(() => {
				if (!entry.authenticated) ws.terminate();
			}, HELLO_TIMEOUT_MS);
			entry.helloTimer.unref();

			ws.on("pong", () => {
				entry.missedPings = 0;
			});
			ws.on("message", (data, isBinary) => {
				if (closed) return;
				if (isBinary) {
					ws.terminate(); // binary frames are not part of protocol v1
					return;
				}
				handleMessage(entry, (data as Buffer).toString("utf8"));
			});
			ws.on("close", () => {
				cleanupClient(entry);
			});
			ws.on("error", () => {
				ws.terminate();
			});
		},
	);

	// Heartbeat (plan §3): ws-level ping every SERVER_PING_INTERVAL_MS; a
	// socket missing MAX_MISSED_PINGS is terminated (browsers and the ws
	// client answer pings automatically at the protocol level). Dead
	// sockets drop out via "close" → removeClient; their in-flight jobs
	// ride the kernel TTL instead of failing hard.
	const pingTimer = setInterval(() => {
		for (const entry of [...clients.values()]) {
			if (entry.missedPings >= MAX_MISSED_PINGS) {
				entry.ws.terminate();
				continue;
			}
			entry.missedPings += 1;
			entry.ws.ping();
		}
	}, SERVER_PING_INTERVAL_MS);
	pingTimer.unref();

	/** Send one protocol frame; a dying socket swallows the error. */
	function send(entry: ClientEntry, message: object): void {
		try {
			entry.ws.send(JSON.stringify(message));
		} catch {
			// Socket already dying; its jobs ride the kernel TTL.
		}
	}

	/** Protocol-level error frame (best effort — socket may be dying). */
	function sendError(
		entry: ClientEntry,
		reason: "unknown-type" | "bad-json" | "bad-v" | "unknown-id",
		detail?: string,
	): void {
		send(entry, { v: 1, type: "error", reason, detail });
	}

	/**
	 * One inbound text frame. Unauthenticated connections get exactly one
	 * chance to say a well-formed hello; anything else closes them (with
	 * a diagnostic frame where the protocol has one: error/bad-json, or
	 * hello_err/version for a wrong protocol version). After auth, a bad
	 * frame only earns an error reply — the connection survives.
	 */
	function handleMessage(entry: ClientEntry, raw: string): void {
		const message = parseBridgeMessage(raw);
		if (!message) {
			// Diagnose the framing failure for the reply;
			// parseBridgeMessage itself is deliberately shallow.
			const detail = frameProblem(raw);
			if (!entry.authenticated && detail === "bad-v") {
				const reply: HelloReplyMsg = {
					v: 1,
					type: "hello_err",
					reason: "version",
					detail: `server speaks protocol v${PROTOCOL_VERSION}`,
				};
				send(entry, reply);
			} else {
				sendError(entry, detail);
			}
			if (!entry.authenticated) {
				closeAfterVerdict(entry, 1002, "bad frame");
			}
			return;
		}
		if (!entry.authenticated) {
			handleHello(entry, message);
			return;
		}
		switch (message.type) {
			case "result":
				handleResult(entry, message);
				break;
			case "ping":
				// Echo the ts (protocol: informational, no clock assumptions).
				send(entry, {
					v: 1,
					type: "pong",
					ts: typeof message.ts === "number"
						? message.ts
						: Date.now(),
				});
				break;
			case "pong":
				break; // app-level keepalive; nothing to do
			case "hello":
				break; // re-hello after auth: ignored, identity already fixed
			default:
				// Server→client types are nonsense from a client.
				sendError(entry, "unknown-type", String(message.type));
		}
	}

	/** First (and only) message of a connection: the handshake. */
	function handleHello(entry: ClientEntry, message: BridgeMessage): void {
		if (banned(entry.ip)) {
			entry.ws.terminate();
			return;
		}
		if (message.type !== "hello") {
			sendError(entry, "unknown-type", "expected hello");
			closeAfterVerdict(entry, 1002, "expected hello");
			return;
		}
		const { client, clientVersion, token: presented } = message;
		if (typeof presented !== "string" || !checkToken(presented, token)) {
			recordAuthFailure(entry.ip);
			const reply: HelloReplyMsg = {
				v: 1,
				type: "hello_err",
				reason: "auth",
			};
			send(entry, reply);
			closeAfterVerdict(entry, 1008, "auth failed");
			return;
		}
		// Authenticated: clear the hello deadline, register with the
		// kernel and welcome the client.
		if (entry.helloTimer) {
			clearTimeout(entry.helloTimer);
			entry.helloTimer = undefined;
		}
		entry.authenticated = true;
		authFailures.delete(entry.ip);
		core.addClient(entry.id, {
			client: typeof client === "string" ? client : undefined,
			clientVersion:
				typeof clientVersion === "string" ? clientVersion : undefined,
		});
		const reply: HelloReplyMsg = {
			v: 1,
			type: "hello_ok",
			server: "pi-web",
			serverVersion: SERVER_VERSION,
		};
		send(entry, reply);
	}

	/**
	 * Client's answer to a job. Policy gates run here, server-side (plan
	 * §3): a too-short markdown is a failure ("unreadable" — login
	 * stubs/captchas must not pass as content), and maxChars is re-checked
	 * even though the client truncates. Unknown/expired ids (a late result
	 * after the kernel TTL already settled the job) never touch the
	 * promise — the client gets error/unknown-id instead.
	 */
	function handleResult(entry: ClientEntry, message: ResultMsg): void {
		if (typeof message.id !== "string") {
			sendError(entry, "unknown-id");
			return;
		}
		const ticket = pending.get(message.id);
		if (!ticket) {
			sendError(entry, "unknown-id", message.id);
			return;
		}
		if (message.ok !== true) {
			const reason =
				message.reason === "timeout" ||
				message.reason === "navigation-failed" ||
				message.reason === "render-failed" ||
				message.reason === "unreadable"
					? message.reason
					: "render-failed";
			core.fail(message.id, reason);
			return;
		}
		const markdown =
			typeof message.markdown === "string" ? message.markdown : "";
		if (markdown.trim().length < MIN_MARKDOWN_LENGTH) {
			core.fail(message.id, "unreadable");
			return;
		}
		const capped =
			markdown.length > ticket.maxChars
				? markdown.slice(0, ticket.maxChars)
				: markdown;
		core.resolve(message.id, {
			markdown: capped,
			title: typeof message.title === "string" ? message.title : null,
			finalUrl:
				typeof message.finalUrl === "string" ? message.finalUrl : "",
		});
	}

	/** Close with a verdict: flush pending frames, then reap the socket. */
	function closeAfterVerdict(
		entry: ClientEntry,
		code: number,
		reason: string,
	): void {
		entry.ws.close(code, reason);
		entry.terminateTimer = setTimeout(() => entry.ws.terminate(), 5_000);
		entry.terminateTimer.unref();
	}

	/** Socket gone: drop kernel registration and every local timer. */
	function cleanupClient(entry: ClientEntry): void {
		if (clients.get(entry.id) === entry) clients.delete(entry.id);
		if (entry.helloTimer) clearTimeout(entry.helloTimer);
		if (entry.terminateTimer) clearTimeout(entry.terminateTimer);
		if (entry.authenticated) core.removeClient(entry.id);
	}

	/** Ban check with lazy TTL expiry (no timer per ban). */
	function banned(ip: string): boolean {
		const until = bans.get(ip);
		if (until === undefined) return false;
		if (until <= Date.now()) {
			bans.delete(ip);
			return false;
		}
		return true;
	}

	function recordAuthFailure(ip: string): void {
		const count = (authFailures.get(ip) ?? 0) + 1;
		if (count >= MAX_AUTH_FAILURES) {
			authFailures.delete(ip);
			bans.set(ip, Date.now() + AUTH_BAN_MS);
			return;
		}
		authFailures.set(ip, count);
	}

	// Idempotent shutdown (B4 calls it from session_shutdown, possibly
	// more than once): stop the heartbeat, fail every live job (callers
	// get null, not a hang), reap sockets, release the port.
	let closePromise: Promise<void> | null = null;
	function closeBridge(): Promise<void> {
		if (closePromise) return closePromise;
		closed = true;
		clearInterval(pingTimer);
		core.failAll("timeout");
		pending.clear();
		for (const entry of [...clients.values()]) {
			entry.ws.terminate();
		}
		wss.close();
		closePromise = new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		return closePromise;
	}

	return {
		port,
		status: "listening",
		render(url, signal) {
			// Never throws (plan §3): dispatch is kernel-side and guarded;
			// any surprise degrades to null.
			try {
				if (closed) return Promise.resolve(null);
				const ticket = core.dispatch(url);
				pending.set(ticket.id, ticket);
				void ticket.promise.then(() => pending.delete(ticket.id));
				if (signal) {
					if (signal.aborted) {
						// Immediate server-side fail; the client is not told
						// (its eventual result lands on error/unknown-id).
						core.fail(ticket.id, "timeout");
					} else {
						signal.addEventListener(
							"abort",
							() => core.fail(ticket.id, "timeout"),
							{ once: true },
						);
					}
				}
				return ticket.promise;
			} catch {
				return Promise.resolve(null);
			}
		},
		clients() {
			return core.count();
		},
		close() {
			return closeBridge();
		},
	};
}

/** listen() as a promise; rejects on EADDRINUSE/EACCES etc. */
function listenOn(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resolve();
		});
	});
}

/** Handle for the "every port taken / token unusable" outcome. */
function disabledHandle(reason: string): BridgeHandle {
	return {
		port: 0,
		status: "disabled",
		disabledReason: reason,
		render: () => Promise.resolve(null),
		clients: () => 0,
		close: () => Promise.resolve(),
	};
}

/**
 * Diagnose why parseBridgeMessage rejected a frame, for the error reply:
 * "bad-json", "bad-v" (wrong protocol version — worth a hello_err before
 * the close), or "unknown-type" (right version, nonsense discriminator).
 */
function frameProblem(
	raw: string,
): "bad-json" | "bad-v" | "unknown-type" {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "bad-json";
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed)
	) {
		return "bad-json";
	}
	const { v, type } = parsed as { v?: unknown; type?: unknown };
	if (v !== PROTOCOL_VERSION) return "bad-v";
	if (typeof type !== "string") return "unknown-type";
	return "unknown-type";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Re-exported for the wiring step (B4) so index.ts needs no core import.
export type { BridgeCoreConfig };
