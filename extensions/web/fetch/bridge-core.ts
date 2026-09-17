/**
 * Pure kernel for the local browser bridge (plan §4, task B1).
 *
 * Owns all bridge state — connected clients, in-flight render jobs, the FIFO
 * queue of jobs waiting for a free slot — as plain data in the factory
 * closure. No `ws` import, no sockets, no I/O of any kind except timers,
 * which are injected (config.timers, defaulting to the globals) so tests
 * drive the whole lifecycle with a fake clock and zero real waiting.
 *
 * Division of labour with the WS layer (task B2, fetch/bridge.ts): that
 * module owns sockets, ports, the origin filter, hello handshakes and
 * heartbeats; it serializes a DispatchedJob into a JobMsg and calls
 * resolve()/fail() as results arrive. Policy gates — the SSRF guard
 * upstream of dispatch, the min-markdown-length gate and the maxChars
 * re-check — also live there, not here.
 *
 * Failure semantics (plan §3): the bridge never throws at callers. Every
 * job failure — a client ok:false, server-side TTL expiry, zero-client
 * grace expiry, queue overflow, shutdown — settles the job's promise with
 * null; only a successful render settles it with a BridgeRenderResult.
 * Results and failures for unknown/expired ids are ignored (→ false); the
 * promise is never touched twice.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	BRIDGE_GRACE_MS,
	JOB_TIMEOUT_MS,
	MAX_CHARS,
	type ResultMsg,
} from "./bridge-protocol.ts";

/** Failure reasons a job can settle with; mirrors result/ok:false on the wire. */
export type BridgeFailReason = Extract<ResultMsg, { ok: false }>["reason"];

/** Successful render outcome, ready to be mapped onto fetcher's RenderResult. */
export interface BridgeRenderResult {
	markdown: string;
	title: string | null;
	/** URL after redirects, as reported by the browser. */
	finalUrl: string;
}

/**
 * Timer seam: everything time-based in the kernel goes through here, so
 * tests inject a fake clock and never actually wait. Defaults are the
 * global setTimeout/clearTimeout and Date.now.
 */
export interface BridgeTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

const defaultTimers: BridgeTimers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	now: () => Date.now(),
};

/** Identity the WS layer attaches at hello time; purely informational. */
export interface BridgeClientMeta {
	client?: string;
	clientVersion?: string;
}

/** Default per-client in-flight cap (plan §2: concurrency cap 4). */
export const MAX_IN_FLIGHT_PER_CLIENT = 4;

/**
 * Bound on jobs parked in the FIFO queue (clients connected but every slot
 * busy). When the queue is full, the ARRIVING job fails immediately with
 * "timeout" — reject the arrival, never evict the oldest: accepted jobs
 * keep their FIFO place, and the new caller gets the honest fast null
 * (→ fetcher's empty message) instead of an unbounded wait. 32 pending
 * renders is far beyond what one browser can serve (≤ 4 concurrent tabs),
 * so hitting the cap means the bridge is saturated and failing fast
 * surfaces that immediately rather than piling latency onto everyone.
 */
export const MAX_QUEUE = 32;

export interface BridgeCoreConfig {
	/** How long a zero-client dispatch waits for a reconnect before → null. */
	graceMs: number;
	/** Server-side TTL for every dispatched job (queued or assigned). */
	jobTimeoutMs: number;
	/** Default maxChars for dispatched jobs (sent to the client in JobMsg). */
	maxChars: number;
	/** Concurrent jobs a single client may carry; pick skips saturated ones. */
	maxInFlightPerClient: number;
	/** Pending-job bound; overflow fails the arriving job immediately. */
	maxQueue: number;
	/** Clock/timer seam; tests inject a fake clock. */
	timers: BridgeTimers;
	/**
	 * Called synchronously, exactly once, when a job is assigned to a client
	 * — immediately at dispatch, or later when a settle frees a slot and the
	 * queue advances. This is where the WS layer sends the JobMsg. A throw
	 * from onDeliver is swallowed (the job stays assigned and its TTL remains
	 * the backstop); the WS layer should fail the job itself if its send
	 * failed hard.
	 */
	onDeliver?: (job: DispatchedJob, clientId: string) => void;
}

/**
 * Handle returned by dispatch: everything the WS layer needs to emit a
 * JobMsg (id/url/timeoutMs/maxChars) plus the promise that settles with the
 * render outcome. The promise resolves null on every failure path and never
 * rejects.
 */
export interface DispatchedJob {
	readonly id: string;
	readonly url: string;
	readonly timeoutMs: number;
	readonly maxChars: number;
	readonly promise: Promise<BridgeRenderResult | null>;
}

export interface BridgeCore {
	addClient(id: string, meta?: BridgeClientMeta): void;
	/**
	 * Drop a client. Its in-flight jobs are NOT failed — they ride their TTL
	 * (plan §4/B2: "клиент отвалился посреди job → null после TTL"). Queued
	 * jobs stay queued and go to the next client that shows up.
	 */
	removeClient(id: string): void;
	/** Number of currently connected clients. */
	count(): number;
	/**
	 * Round-robin over live clients, skipping saturated ones; the chosen
	 * client's id, or null when every client is at capacity (or none are
	 * connected). Advances the rotation but does NOT reserve capacity —
	 * reservation happens when dispatch/pump assigns a job. Exposed for
	 * status/introspection and tests; the WS layer consumes dispatch
	 * tickets, not pick().
	 */
	pick(): string | null;
	/**
	 * Register a render job and try to hand it to a client. With a free
	 * client the job is delivered immediately (onDeliver); with clients
	 * connected but all saturated it parks in the FIFO queue (overflow →
	 * immediate "timeout" fail, see MAX_QUEUE); with zero clients it waits
	 * up to graceMs for a reconnect, then settles "timeout" → null. Never
	 * throws; the returned ticket's promise never rejects.
	 */
	dispatch(url: string, maxChars?: number): DispatchedJob;
	/** Settle a job with a successful render. Unknown/expired id → false. */
	resolve(id: string, result: BridgeRenderResult): boolean;
	/** Settle a job with a failure (→ promise null). Unknown/expired → false. */
	fail(id: string, reason: BridgeFailReason): boolean;
	/**
	 * Belt-and-braces purge of expired-but-unsettled job records. In normal
	 * operation TTL timers settle jobs on time and this returns 0; it exists
	 * for hosts whose timers stall or never run (dropped/injected clocks),
	 * so the "expired jobs never linger" invariant stays checkable.
	 */
	sweep(): number;
	/** Settle every live job (assigned + queued) with reason; returns count. */
	failAll(reason: BridgeFailReason): number;
}

type SettleOutcome =
	| { ok: true; result: BridgeRenderResult }
	| { ok: false; reason: BridgeFailReason };

/**
 * Constant-time shared-token check (hello auth). Both strings are hashed
 * with sha256 first: crypto.timingSafeEqual throws on length mismatch, and
 * a token's length is itself secret-ish information a cheap early return
 * would leak — hashing normalizes every input to the same 32 bytes. Never
 * throws; any failure counts as a rejection.
 */
export function checkToken(presented: string, expected: string): boolean {
	try {
		const a = createHash("sha256").update(presented, "utf8").digest();
		const b = createHash("sha256").update(expected, "utf8").digest();
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

export function createBridgeCore(
	config?: Partial<BridgeCoreConfig>,
): BridgeCore {
	const cfg = {
		graceMs: config?.graceMs ?? BRIDGE_GRACE_MS,
		jobTimeoutMs: config?.jobTimeoutMs ?? JOB_TIMEOUT_MS,
		maxChars: config?.maxChars ?? MAX_CHARS,
		maxInFlightPerClient:
			config?.maxInFlightPerClient ?? MAX_IN_FLIGHT_PER_CLIENT,
		maxQueue: config?.maxQueue ?? MAX_QUEUE,
		timers: config?.timers ?? defaultTimers,
	};
	const onDeliver = config?.onDeliver;
	const timers = cfg.timers;

	interface ClientRecord {
		id: string;
		client?: string;
		clientVersion?: string;
		inFlight: number;
	}
	interface JobRecord {
		id: string;
		resolve: (value: BridgeRenderResult | null) => void;
		deadline: number;
		clientId: string | null;
		settled: boolean;
		ttl: unknown;
		grace: unknown;
	}
	interface QueueEntry {
		job: JobRecord;
		ticket: DispatchedJob;
	}

	const clients = new Map<string, ClientRecord>();
	const jobs = new Map<string, JobRecord>();
	const queue: QueueEntry[] = [];
	let cursor = 0;

	function clearHandle(handle: unknown): void {
		if (handle !== null) timers.clearTimeout(handle);
	}

	/** Round-robin scan from the cursor; advances only on a hit. */
	function pickClient(): ClientRecord | null {
		const size = clients.size;
		if (size === 0) return null;
		const start = ((cursor % size) + size) % size;
		const list = [...clients.values()];
		for (let i = 0; i < size; i++) {
			const candidate = list[(start + i) % size];
			if (candidate.inFlight < cfg.maxInFlightPerClient) {
				cursor = (start + i + 1) % size;
				return candidate;
			}
		}
		return null;
	}

	function assign(entry: QueueEntry, client: ClientRecord): void {
		client.inFlight += 1;
		entry.job.clientId = client.id;
		clearHandle(entry.job.grace);
		entry.job.grace = null;
		if (onDeliver) {
			try {
				onDeliver(entry.ticket, client.id);
			} catch {
				/* swallowed — the job's TTL remains the backstop */
			}
		}
	}

	/** Settle a job at most once; release its slot; never pumps. */
	function settleJob(job: JobRecord, outcome: SettleOutcome): boolean {
		if (job.settled) return false;
		job.settled = true;
		jobs.delete(job.id);
		clearHandle(job.ttl);
		job.ttl = null;
		clearHandle(job.grace);
		job.grace = null;
		if (job.clientId !== null) {
			const client = clients.get(job.clientId);
			if (client && client.inFlight > 0) client.inFlight -= 1;
		}
		job.resolve(outcome.ok ? outcome.result : null);
		return true;
	}

	/** Deliver queued jobs while any client has a free slot (FIFO). */
	function pump(): void {
		while (queue.length > 0) {
			const entry = queue[0];
			if (entry.job.settled) {
				queue.shift(); // lazy compaction: settled entries hold no place
				continue;
			}
			const client = pickClient();
			if (!client) return;
			queue.shift();
			assign(entry, client);
		}
	}

	/** Shared TTL/grace expiry path; safe to fire late (settled → no-op). */
	function expire(id: string): void {
		const job = jobs.get(id);
		if (!job) return;
		if (settleJob(job, { ok: false, reason: "timeout" })) pump();
	}

	function failedTicket(
		url: string,
		maxChars: number,
	): DispatchedJob {
		let resolveFn!: (value: BridgeRenderResult | null) => void;
		const promise = new Promise<BridgeRenderResult | null>((res) => {
			resolveFn = res;
		});
		resolveFn(null);
		return {
			id: "unassigned",
			url,
			timeoutMs: cfg.jobTimeoutMs,
			maxChars,
			promise,
		};
	}

	return {
		addClient(id, meta) {
			try {
				const existing = clients.get(id);
				if (existing) {
					existing.client = meta?.client;
					existing.clientVersion = meta?.clientVersion;
					return;
				}
				clients.set(id, {
					id,
					client: meta?.client,
					clientVersion: meta?.clientVersion,
					inFlight: 0,
				});
				pump();
			} catch {
				/* never throws */
			}
		},

		removeClient(id) {
			try {
				const index = [...clients.keys()].indexOf(id);
				if (!clients.delete(id)) return;
				if (index >= 0 && index < cursor) cursor -= 1;
				if (cursor >= clients.size) cursor = 0;
			} catch {
				/* never throws */
			}
		},

		count() {
			return clients.size;
		},

		pick() {
			try {
				const client = pickClient();
				return client ? client.id : null;
			} catch {
				return null;
			}
		},

		dispatch(url, maxChars) {
			try {
				const chars = maxChars ?? cfg.maxChars;
				const id = randomUUID();
				let resolveFn!: (value: BridgeRenderResult | null) => void;
				const promise = new Promise<BridgeRenderResult | null>((res) => {
					resolveFn = res;
				});
				const job: JobRecord = {
					id,
					resolve: resolveFn,
					deadline: timers.now() + cfg.jobTimeoutMs,
					clientId: null,
					settled: false,
					ttl: timers.setTimeout(() => expire(id), cfg.jobTimeoutMs),
					grace: null,
				};
				jobs.set(id, job);
				const ticket: DispatchedJob = {
					id,
					url,
					timeoutMs: cfg.jobTimeoutMs,
					maxChars: chars,
					promise,
				};
				const client = pickClient();
				if (client) {
					assign({ job, ticket }, client);
					return ticket;
				}
				// Not assignable right now: park it. Zero clients ⇒ also arm the
				// grace timer (reconnect window); queue TTL is the job's own TTL.
				if (clients.size === 0) {
					job.grace = timers.setTimeout(() => expire(id), cfg.graceMs);
				}
				if (queue.length >= cfg.maxQueue) {
					// Overflow: reject the arrival immediately (see MAX_QUEUE).
					if (settleJob(job, { ok: false, reason: "timeout" })) pump();
					return ticket;
				}
				queue.push({ job, ticket });
				return ticket;
			} catch {
				// The kernel never throws at callers: an internal surprise
				// degrades to an already-failed job.
				return failedTicket(url, maxChars ?? cfg.maxChars);
			}
		},

		resolve(id, result) {
			try {
				const job = jobs.get(id);
				if (!job) return false;
				if (!settleJob(job, { ok: true, result })) return false;
				pump();
				return true;
			} catch {
				return false;
			}
		},

		fail(id, reason) {
			try {
				const job = jobs.get(id);
				if (!job) return false;
				if (!settleJob(job, { ok: false, reason })) return false;
				pump();
				return true;
			} catch {
				return false;
			}
		},

		sweep() {
			try {
				const now = timers.now();
				let purged = 0;
				for (const job of [...jobs.values()]) {
					if (!job.settled && job.deadline <= now) {
						if (settleJob(job, { ok: false, reason: "timeout" })) {
							purged += 1;
						}
					}
				}
				if (purged > 0) pump();
				return purged;
			} catch {
				return 0;
			}
		},

		failAll(reason) {
			try {
				let settledCount = 0;
				// Detach the queue first so the sweep below sees only assigned
				// jobs; no pump afterwards — a shutdown starts nothing new.
				for (const entry of queue.splice(0)) {
					if (settleJob(entry.job, { ok: false, reason })) settledCount += 1;
				}
				for (const job of [...jobs.values()]) {
					if (settleJob(job, { ok: false, reason })) settledCount += 1;
				}
				return settledCount;
			} catch {
				return 0;
			}
		},
	};
}
