/**
 * Shared HTTP helpers for the web tools (web_search, web_fetch).
 *
 * Pure logic, no pi-host imports — unit-testable standalone per the repo
 * rule (tests never import index/tool modules). Per-tool policies stay in
 * their own modules: web_search keeps its 202/403/429 + bot-challenge retry,
 * web_fetch will keep its own header set and cap sizes.
 */

/**
 * True for abort errors: anything whose `name` is "AbortError".
 * Timeouts via AbortSignal.timeout surface as "TimeoutError" and are
 * deliberately NOT matched — callers distinguish user/tool aborts from
 * their own timeouts.
 */
export function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Combine an optional caller signal with a per-operation timeout.
 * The returned signal aborts when either the caller signal aborts or
 * timeoutMs elapses, whichever comes first.
 */
export function combineSignals(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Await a delay, rejecting early (with "Aborted") if the signal aborts
 * while waiting. Without a signal, always resolves after ms.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}

/**
 * Run fn with bounded retries.
 *
 * Attempts: 1 + retries. A failing attempt is retried only when
 * isTransient(error) is true; transient failures wait backoffMs between
 * attempts (the wait is aborted early via signal, aborting the whole loop).
 * Abort errors are never retried, whatever isTransient says. Non-transient
 * errors and exhausted retries rethrow the original error.
 */
export async function withRetry<T>(
	fn: () => T | Promise<T>,
	options: {
		/** Extra attempts after the first: total attempts = retries + 1. */
		retries: number;
		/** Delay before each retry; an aborted signal cancels the wait. */
		backoffMs: number;
		/** Decides whether a given error deserves another attempt. */
		isTransient: (error: unknown) => boolean;
		/** Cooperative cancellation, checked during backoff waits. */
		signal?: AbortSignal;
	},
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (
				isAbort(error) ||
				!options.isTransient(error) ||
				attempt >= options.retries
			) {
				throw error;
			}
			await sleep(options.backoffMs, options.signal);
		}
	}
}

/**
 * Result of readBodyCapped.
 *
 * Deliberately a discriminated union instead of a thrown error class: a
 * size-cap breach is an expected, recoverable outcome, and the `ok`
 * discriminant forces callers to handle it explicitly at the call site
 * (keeping the "don't trust content-length" contract visible).
 */
export type BodyResult =
	| { ok: true; buffer: Uint8Array }
	| { ok: false; kind: "too-large"; received: number };

/**
 * Read a response body as a byte stream, enforcing maxBytes by the bytes
 * actually read — content-length is never consulted (it can lie: compressed
 * bodies, chunked transfers, proxies). Once the cap is crossed the stream is
 * cancelled (no full download, the rest is never pulled) and the result is
 * `{ ok: false, kind: "too-large", received }` with the byte count observed
 * so far. A body at exactly maxBytes is allowed; only exceeding it fails.
 * A null body (e.g. 204 responses) yields an empty buffer.
 */
export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<BodyResult> {
	const body = response.body;
	if (!body) {
		return { ok: true, buffer: new Uint8Array(0) };
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.byteLength;
			if (received > maxBytes) {
				await reader.cancel("body exceeds size cap");
				return { ok: false, kind: "too-large", received };
			}
		}
	} finally {
		reader.releaseLock();
	}

	const buffer = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, buffer };
}
