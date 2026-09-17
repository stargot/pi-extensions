import assert from "node:assert/strict";
import { test } from "node:test";
import {
	combineSignals,
	isAbort,
	readBodyCapped,
	sleep,
	withRetry,
} from "../http.ts";

const enc = new TextEncoder();

const transient = (error: unknown): boolean =>
	(error as { transient?: boolean })?.transient === true;

function transientError(status: number): Error {
	return Object.assign(new Error(`HTTP ${status} (transient)`), {
		transient: true,
	});
}

function streamOf(
	chunks: Uint8Array[],
	onCancel?: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
		cancel() {
			onCancel?.();
		},
	});
}

// Pull-based stream that yields one chunk per pull and never closes on its
// own — like a real network body. Needed for cancel assertions: on an
// already-closed stream reader.cancel() is a spec no-op (source cancel is
// not called), which is not the situation being tested.
function endlessStream(
	makeChunk: () => Uint8Array,
	onCancel?: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(makeChunk());
		},
		cancel() {
			onCancel?.();
		},
	});
}

function fakeResponse(body: ReadableStream<Uint8Array> | null): Response {
	// readBodyCapped only touches response.body; a stub keeps header behavior
	// (like a lying content-length) fully under test control.
	return { body } as unknown as Response;
}

test("isAbort: matches AbortError by name, nothing else", () => {
	const abort = new Error("The operation was aborted");
	abort.name = "AbortError";
	assert.equal(isAbort(abort), true);
	assert.equal(isAbort(new Error("nope")), false);
	assert.equal(isAbort("AbortError"), false);
	assert.equal(isAbort(undefined), false);
});

test("combineSignals: caller signal abort propagates, timeout fires alone", async () => {
	const controller = new AbortController();
	const combined = combineSignals(controller.signal, 60_000);
	assert.equal(combined.aborted, false);
	controller.abort();
	assert.equal(combined.aborted, true);

	const timed = combineSignals(undefined, 5);
	assert.equal(timed.aborted, false);
	await sleep(50, undefined);
	assert.equal(timed.aborted, true);
});

test("sleep: resolves after the delay", async () => {
	const start = Date.now();
	await sleep(15, undefined);
	assert.ok(Date.now() - start >= 10);
});

test("sleep: rejects as soon as the signal aborts", async () => {
	const controller = new AbortController();
	const pending = sleep(60_000, controller.signal);
	setTimeout(() => controller.abort(), 1);
	await assert.rejects(pending, /Aborted/);
});

test("readBodyCapped: small body passes bit-for-bit", async () => {
	const bytes = new Uint8Array([0, 1, 250, 251, 255]);
	const result = await readBodyCapped(fakeResponse(streamOf([bytes])), 16);
	assert.ok(result.ok);
	assert.deepEqual(result.buffer, bytes);
});

test("readBodyCapped: chunks are concatenated in order", async () => {
	const result = await readBodyCapped(
		fakeResponse(streamOf([enc.encode("hello "), enc.encode("cap")])),
		64,
	);
	assert.ok(result.ok);
	assert.deepEqual(result.buffer, enc.encode("hello cap"));
});

test("readBodyCapped: body over the cap → too-large, stream cancelled", async () => {
	let cancelled = false;
	const result = await readBodyCapped(
		fakeResponse(
			endlessStream(
				() => new Uint8Array(600),
				() => {
					cancelled = true;
				},
			),
		),
		500,
	);
	assert.deepEqual(result, { ok: false, kind: "too-large", received: 600 });
	assert.equal(cancelled, true);
});

test("readBodyCapped: cap crossed mid-stream, remaining chunks never pulled", async () => {
	let cancelled = false;
	let pulled = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += 1;
			controller.enqueue(new Uint8Array(300));
		},
		cancel() {
			cancelled = true;
		},
	});
	const result = await readBodyCapped(fakeResponse(stream), 500);
	assert.deepEqual(result, { ok: false, kind: "too-large", received: 600 });
	assert.equal(cancelled, true);
	assert.equal(pulled, 2);
});

test("readBodyCapped: lying content-length is ignored — cap on actual bytes", async () => {
	// 1000 real bytes behind a (stubbed) response; a real-world lying header
	// claims fewer. readBodyCapped never reads headers, so the cap bites.
	const result = await readBodyCapped(
		fakeResponse(endlessStream(() => new Uint8Array(1000))),
		500,
	);
	assert.ok(!result.ok);
	assert.equal(result.kind, "too-large");
	assert.equal(result.received, 1000);
});

test("readBodyCapped: exactly at the cap is allowed", async () => {
	const bytes = new Uint8Array(500);
	const result = await readBodyCapped(fakeResponse(streamOf([bytes])), 500);
	assert.ok(result.ok);
	assert.deepEqual(result.buffer, bytes);
});

test("readBodyCapped: null body → empty buffer", async () => {
	const result = await readBodyCapped(fakeResponse(null), 100);
	assert.deepEqual(result, { ok: true, buffer: new Uint8Array(0) });
});

test("withRetry: transient (429) → exactly one retry, then ok", async () => {
	let calls = 0;
	const result = await withRetry(
		() => {
			calls += 1;
			if (calls === 1) throw transientError(429);
			return "ok";
		},
		{ retries: 1, backoffMs: 1, isTransient: transient },
	);
	assert.equal(result, "ok");
	assert.equal(calls, 2);
});

test("withRetry: non-transient (404) → no retries", async () => {
	let calls = 0;
	await assert.rejects(
		withRetry(
			() => {
				calls += 1;
				throw Object.assign(new Error("HTTP 404"), { transient: false });
			},
			{ retries: 3, backoffMs: 1, isTransient: transient },
		),
		/HTTP 404/,
	);
	assert.equal(calls, 1);
});

test("withRetry: retries exhausted → last error thrown", async () => {
	let calls = 0;
	await assert.rejects(
		withRetry(
			() => {
				calls += 1;
				throw transientError(503);
			},
			{ retries: 2, backoffMs: 1, isTransient: transient },
		),
		/HTTP 503/,
	);
	assert.equal(calls, 3); // initial attempt + 2 retries
});

test("withRetry: abort error → no retry even if marked transient", async () => {
	let calls = 0;
	await assert.rejects(
		withRetry(
			() => {
				calls += 1;
				const error = new Error("The operation was aborted");
				error.name = "AbortError";
				throw error;
			},
			{ retries: 3, backoffMs: 1, isTransient: () => true },
		),
		(error: unknown) => isAbort(error),
	);
	assert.equal(calls, 1);
});

test("withRetry: signal aborted during backoff → no further attempts", async () => {
	let calls = 0;
	const controller = new AbortController();
	const pending = withRetry(
		() => {
			calls += 1;
			throw transientError(429);
		},
		{
			retries: 1,
			backoffMs: 30_000,
			isTransient: transient,
			signal: controller.signal,
		},
	);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(pending, /Aborted/);
	assert.equal(calls, 1);
});
