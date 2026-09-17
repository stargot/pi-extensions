import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BRIDGE_GRACE_MS,
	JOB_TIMEOUT_MS,
	MAX_CHARS,
} from "../fetch/bridge-protocol.ts";
import {
	MAX_IN_FLIGHT_PER_CLIENT,
	MAX_QUEUE,
	checkToken,
	createBridgeCore,
	type BridgeTimers,
	type DispatchedJob,
} from "../fetch/bridge-core.ts";

const URL_A = "https://example.com/article";
const RESULT = {
	markdown: "# Heading\n\nBody text long enough.",
	title: "Example",
	finalUrl: "https://example.com/final",
};

/**
 * Fake clock: timers are queued, `tick(ms)` advances the clock and fires
 * everything due, in deadline order (insertion order on ties). No real
 * waiting anywhere.
 */
function makeFakeTimers() {
	let nowMs = 1_000_000;
	let seq = 0;
	const scheduled = new Map<number, { at: number; fn: () => void }>();
	const timers: BridgeTimers = {
		setTimeout(fn, ms) {
			const id = ++seq;
			scheduled.set(id, { at: nowMs + Math.max(0, ms), fn });
			return id;
		},
		clearTimeout(handle) {
			scheduled.delete(handle as number);
		},
		now: () => nowMs,
	};
	function tick(ms: number): void {
		const target = nowMs + ms;
		for (;;) {
			let dueId: number | null = null;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [id, entry] of scheduled) {
				// Map iteration is insertion-ordered, so strict < keeps the
				// earliest-inserted callback among equal deadlines (FIFO).
				if (entry.at <= target && entry.at < dueAt) {
					dueAt = entry.at;
					dueId = id;
				}
			}
			if (dueId === null) break;
			const entry = scheduled.get(dueId)!;
			scheduled.delete(dueId);
			nowMs = Math.max(nowMs, entry.at);
			entry.fn();
		}
		nowMs = target;
	}
	return { timers, tick, pending: () => scheduled.size };
}

function deliveryLog() {
	const got: Array<{ id: string; clientId: string }> = [];
	return {
		got,
		onDeliver: (job: DispatchedJob, clientId: string) => {
			got.push({ id: job.id, clientId });
		},
	};
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true, () => true),
		Promise.resolve().then(() => false),
		// A settled promise wins the race after one microtask hop; a pending
		// one loses to the synchronous `false`. (Never rejects in practice.)
	]);
}

test("constants: in-flight cap and queue bound match the plan §2 defaults", () => {
	assert.equal(MAX_IN_FLIGHT_PER_CLIENT, 4);
	assert.equal(MAX_QUEUE, 32);
});

test("config defaults come from bridge-protocol constants", () => {
	const { timers } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	core.addClient("c1");
	const job = core.dispatch(URL_A);
	assert.equal(job.timeoutMs, JOB_TIMEOUT_MS);
	assert.equal(job.maxChars, MAX_CHARS);
	core.failAll("timeout"); // leave no live jobs behind
});

test("checkToken: equal tokens pass; every mismatch fails, any lengths", () => {
	assert.equal(checkToken("token", "token"), true);
	assert.equal(checkToken("", ""), true);
	assert.equal(checkToken("token", "tokss"), false);
	assert.equal(checkToken("", "token"), false);
	assert.equal(checkToken("token", ""), false);
	// Different lengths are the timingSafeEqual throw case — must be false,
	// not an exception.
	assert.equal(checkToken("short", "a-much-longer-expected-token"), false);
	assert.equal(checkToken("a".repeat(200), "b".repeat(3)), false);
});

test("client registry: add/count/remove, pick on empty registry is null", () => {
	const { timers } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	assert.equal(core.count(), 0);
	assert.equal(core.pick(), null);
	core.addClient("c1", { client: "pi-web-companion", clientVersion: "0.1.0" });
	assert.equal(core.count(), 1);
	// Re-adding the same id is a metadata refresh, not a second client.
	core.addClient("c1", { clientVersion: "0.2.0" });
	assert.equal(core.count(), 1);
	core.addClient("c2");
	assert.equal(core.count(), 2);
	core.removeClient("c1");
	assert.equal(core.count(), 1);
	core.removeClient("ghost"); // unknown id — no-op, no throw
	assert.equal(core.count(), 1);
	core.removeClient("c2");
	assert.equal(core.count(), 0);
});

test("dispatch → resolve maps the browser result onto the job promise", async () => {
	const { timers } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver });
	core.addClient("c1");
	const job = core.dispatch(URL_A);
	assert.match(job.id, /^[0-9a-f-]{36}$/);
	assert.equal(job.url, URL_A);
	assert.deepEqual(got, [{ id: job.id, clientId: "c1" }]);
	// maxChars override travels on the ticket (it feeds the JobMsg).
	const job2 = core.dispatch(URL_A, 500);
	assert.equal(job2.maxChars, 500);

	assert.equal(core.resolve(job.id, RESULT), true);
	assert.deepEqual(await job.promise, RESULT);
	core.fail(job2.id, "unreadable");
	assert.equal(await job2.promise, null);
});

test("TTL: fake tick past jobTimeoutMs → null; late resolve/fail ignored", async () => {
	const { timers, tick } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	core.addClient("c1");
	const job = core.dispatch(URL_A);
	tick(JOB_TIMEOUT_MS);
	assert.equal(await job.promise, null);
	// The registry record is gone: late results are ignored, the settled
	// promise is never touched again.
	assert.equal(core.resolve(job.id, RESULT), false);
	assert.equal(core.fail(job.id, "render-failed"), false);
	assert.equal(await job.promise, null);
});

test("fail(reason) maps to null; double-settle is rejected", async () => {
	const { timers } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	core.addClient("c1");
	const a = core.dispatch(URL_A);
	const b = core.dispatch(URL_A);
	assert.equal(core.fail(a.id, "navigation-failed"), true);
	assert.equal(await a.promise, null);
	assert.equal(core.resolve(a.id, RESULT), false); // already settled
	assert.equal(core.fail(b.id, "timeout"), true);
	assert.equal(await b.promise, null);
});

test("queued job expires by its own TTL while waiting in the queue", async () => {
	const { timers, tick } = makeFakeTimers();
	const core = createBridgeCore({ timers, maxInFlightPerClient: 1 });
	core.addClient("c1");
	const busy = core.dispatch(URL_A);
	const queued = core.dispatch(URL_A);
	tick(JOB_TIMEOUT_MS);
	assert.equal(await busy.promise, null);
	assert.equal(await queued.promise, null);
	// After both expired, settling the freed... nothing is pending anymore:
	// no deliveries, no capacity leaks.
	assert.equal(core.resolve("whatever", RESULT), false);
});

test("no client: null only after the grace window (fake tick)", async () => {
	const { timers, tick } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	const job = core.dispatch(URL_A);
	tick(BRIDGE_GRACE_MS - 1);
	assert.equal(await isSettled(job.promise), false);
	tick(1);
	assert.equal(await job.promise, null);
});

test("client arrives within grace: job delivered, grace timer cleared", async () => {
	const { timers, tick } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver });
	const job = core.dispatch(URL_A);
	assert.equal(got.length, 0);

	core.addClient("c1");
	assert.deepEqual(got, [{ id: job.id, clientId: "c1" }]);

	// If the grace timer had not been cleared, this tick would settle the
	// job with null and the resolve below would return false.
	tick(BRIDGE_GRACE_MS);
	assert.equal(await isSettled(job.promise), false);
	assert.equal(core.resolve(job.id, RESULT), true);
	assert.deepEqual(await job.promise, RESULT);
});

test("queue is FIFO with a single busy client", async () => {
	const { timers } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver, maxInFlightPerClient: 1 });
	core.addClient("c1");
	const j1 = core.dispatch(URL_A);
	const j2 = core.dispatch(URL_A);
	const j3 = core.dispatch(URL_A);
	const j4 = core.dispatch(URL_A);
	assert.deepEqual(got, [{ id: j1.id, clientId: "c1" }]);

	// Each settle frees the single slot and the queue head takes it —
	// strictly in arrival order.
	assert.equal(core.resolve(j1.id, RESULT), true);
	await j1.promise;
	assert.deepEqual(got.map((g) => g.id), [j1.id, j2.id]);
	assert.equal(core.resolve(j2.id, RESULT), true);
	await j2.promise;
	assert.deepEqual(got.map((g) => g.id), [j1.id, j2.id, j3.id]);
	assert.equal(core.fail(j3.id, "render-failed"), true);
	await j3.promise;
	assert.deepEqual(got.map((g) => g.id), [j1.id, j2.id, j3.id, j4.id]);
	assert.equal(core.resolve(j4.id, RESULT), true);
	assert.deepEqual(await Promise.all([j2.promise, j3.promise, j4.promise]), [
		RESULT,
		null,
		RESULT,
	]);
});

test("queue overflow fails the arriving job immediately (reject the arrival)", async () => {
	const { timers, tick } = makeFakeTimers();
	const core = createBridgeCore({
		timers,
		maxInFlightPerClient: 1,
		maxQueue: 2,
	});
	core.addClient("c1");
	const j1 = core.dispatch(URL_A); // assigned
	const j2 = core.dispatch(URL_A); // queued
	const j3 = core.dispatch(URL_A); // queued (queue full now)
	const j4 = core.dispatch(URL_A); // overflow → immediate "timeout"
	assert.equal(await j4.promise, null);
	// Immediate: nothing to wait out — a resolve attempt is already late.
	assert.equal(core.resolve(j4.id, RESULT), false);
	// The accepted jobs keep their FIFO place and live on.
	assert.equal(core.resolve(j1.id, RESULT), true);
	assert.equal(await isSettled(j2.promise), false);
	tick(JOB_TIMEOUT_MS); // hygiene: settle leftovers, no live jobs behind
	assert.equal(await j2.promise, null);
	assert.equal(await j3.promise, null);
});

test("round-robin: two clients alternate; rotation survives removal", async () => {
	const { timers } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver });
	core.addClient("c1");
	core.addClient("c2");
	const jobs = [core.dispatch(URL_A), core.dispatch(URL_A), core.dispatch(URL_A), core.dispatch(URL_A)];
	assert.deepEqual(got, [
		{ id: jobs[0].id, clientId: "c1" },
		{ id: jobs[1].id, clientId: "c2" },
		{ id: jobs[2].id, clientId: "c1" },
		{ id: jobs[3].id, clientId: "c2" },
	]);
	// pick() itself rotates too: next turn is c1 again.
	assert.equal(core.pick(), "c1");
	assert.equal(core.pick(), "c2");
	// Removing a client must not corrupt the rotation.
	core.removeClient("c1");
	assert.equal(core.pick(), "c2"); // only live client, 2/4 slots busy
	core.removeClient("c2");
	assert.equal(core.pick(), null);
	assert.equal(core.count(), 0);
	core.failAll("timeout");
});

test("in-flight cap: pick skips a saturated client", async () => {
	const { timers } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver, maxInFlightPerClient: 2 });
	core.addClient("c1");
	core.dispatch(URL_A);
	core.dispatch(URL_A); // c1 now saturated
	assert.equal(core.pick(), null); // nothing with a free slot
	core.addClient("c2");
	assert.equal(core.pick(), "c2"); // saturated c1 skipped
	const next = core.dispatch(URL_A);
	assert.deepEqual(got, [
		{ id: got[0].id, clientId: "c1" },
		{ id: got[1].id, clientId: "c1" },
		{ id: next.id, clientId: "c2" },
	]);
	core.failAll("timeout");
});

test("client disconnect mid-job: job rides TTL → null; queued job moves on", async () => {
	const { timers, tick } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver });
	core.addClient("c1");
	const assigned = core.dispatch(URL_A);
	core.removeClient("c1");
	tick(JOB_TIMEOUT_MS);
	assert.equal(await assigned.promise, null); // plan §4/B2: null after TTL

	// A queued job is not stranded: the next client that shows up gets it.
	const core2 = createBridgeCore({ timers, onDeliver, maxInFlightPerClient: 1 });
	core2.addClient("c1");
	const busy = core2.dispatch(URL_A);
	const queued = core2.dispatch(URL_A);
	core2.removeClient("c1");
	core2.addClient("c2");
	assert.deepEqual(got, [
		{ id: assigned.id, clientId: "c1" },
		{ id: busy.id, clientId: "c1" },
		{ id: queued.id, clientId: "c2" },
	]);
	assert.equal(core2.resolve(queued.id, RESULT), true);
	assert.deepEqual(await queued.promise, RESULT);
	core2.failAll("timeout");
});

test("failAll settles assigned and queued jobs and shuts the queue up", async () => {
	const { timers } = makeFakeTimers();
	const { got, onDeliver } = deliveryLog();
	const core = createBridgeCore({ timers, onDeliver, maxInFlightPerClient: 1 });
	core.addClient("c1");
	const a = core.dispatch(URL_A); // assigned
	const b = core.dispatch(URL_A); // queued
	assert.equal(core.failAll("render-failed"), 2);
	assert.equal(await a.promise, null);
	assert.equal(await b.promise, null);
	assert.equal(core.resolve(a.id, RESULT), false);
	// No further work starts: a client joining afterwards gets no backlog.
	core.addClient("c9");
	assert.deepEqual(got, [{ id: a.id, clientId: "c1" }]);
});

test("sweep purges expired records when timers stall; returns 0 normally", async () => {
	const { timers, tick } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	core.addClient("c1");
	core.dispatch(URL_A);
	tick(1000);
	assert.equal(core.sweep(), 0); // TTL timers settle on time — nothing to do

	// Timers that never fire (stalled event loop / dropped schedule): the
	// sweep is the backstop that still settles expired records.
	let nowMs = 5_000_000;
	const stalled: BridgeTimers = {
		setTimeout: () => null, // drop every timer
		clearTimeout: () => {},
		now: () => nowMs,
	};
	const core2 = createBridgeCore({ timers: stalled, maxInFlightPerClient: 1 });
	core2.addClient("c1");
	const a = core2.dispatch(URL_A);
	const b = core2.dispatch(URL_A); // queued
	nowMs += JOB_TIMEOUT_MS + 1;
	assert.equal(core2.sweep(), 2);
	assert.equal(await a.promise, null);
	assert.equal(await b.promise, null);
	assert.equal(core2.sweep(), 0); // nothing left to purge
});

test("the kernel never throws at callers; unknown ids are ignored", async () => {
	const { timers } = makeFakeTimers();
	const core = createBridgeCore({ timers });
	assert.equal(core.resolve("unknown", RESULT), false);
	assert.equal(core.fail("unknown", "timeout"), false);
	assert.equal(core.fail("", "unreadable"), false);
	core.removeClient("ghost");
	// The core does not validate URLs (SSRF guard lives upstream in B2) —
	// hostile input must still not throw and must stay cancellable.
	const job = core.dispatch("not-a-url at all", -5);
	assert.equal(job.url, "not-a-url at all");
	assert.equal(job.promise instanceof Promise, true);
	assert.equal(core.fail(job.id, "unreadable"), true);
	assert.equal(await job.promise, null);
});
