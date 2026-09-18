/**
 * Unit tests for the in-flight memoization used by the bridge startup
 * (index.ts ensureBridge/shutdownBridge). Pure async logic — no sockets,
 * no pi host. The same dedupe semantics live on the companion side
 * (pi-web-companion src/connect.ts dedupeInFlight) for its BridgeSet
 * restarts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeInFlight } from "../fetch/in-flight.ts";

const settle = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

test("concurrent runs join one in-flight task (one server-start equivalent)", async () => {
	let started = 0;
	const task = dedupeInFlight(async (): Promise<string> => {
		started += 1;
		await settle(20);
		return "handle";
	});

	const [a, b, c] = await Promise.all([task.run(), task.run(), task.run()]);
	assert.equal(started, 1, "overlapping calls share one run");
	assert.deepEqual([a, b, c], ["handle", "handle", "handle"]);
});

test("after a run settles, the next call starts a fresh run", async () => {
	let started = 0;
	const task = dedupeInFlight(async (): Promise<number> => {
		started += 1;
		await settle(5);
		return started;
	});

	assert.equal(await task.run(), 1);
	assert.equal(task.current(), null, "the slot clears on settle");
	assert.equal(await task.run(), 2, "a settled run is not memoized forever");
});

test("a failed run also clears the slot (the next call retries)", async () => {
	let started = 0;
	const task = dedupeInFlight(async (): Promise<void> => {
		started += 1;
		await settle(5);
		throw new Error(`boom ${started}`);
	});

	await assert.rejects(task.run(), /boom 1/);
	assert.equal(task.current(), null);
	await assert.rejects(task.run(), /boom 2/, "failures must not poison the slot");
});

test("current() exposes the in-flight promise without starting a run", async () => {
	let started = 0;
	const task = dedupeInFlight(async (): Promise<string> => {
		started += 1;
		await settle(20);
		return "handle";
	});

	assert.equal(task.current(), null, "idle before any run");
	const run = task.run();
	await settle(5); // the task body starts on the next microtask
	const pending = task.current();
	assert.ok(pending, "the run is visible while in flight");
	assert.equal(started, 1, "reading current() never triggers a run");

	// The shutdown path: await the pending run WITHOUT a new one starting.
	assert.equal(await pending, "handle");
	assert.equal(started, 1);
	assert.equal(task.current(), null);
	await run; // the joiner got the same outcome
});
