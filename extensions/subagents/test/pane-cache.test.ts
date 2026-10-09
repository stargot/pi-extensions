import assert from "node:assert/strict";
import { test } from "node:test";
import { WATCHER_READ_THROTTLE_MS, createWatcherPaneOps, type PaneSource } from "../pane-cache.ts";

interface SourceFake {
	source: PaneSource;
	listCalls: number;
	readCalls: Array<[string, number]>;
	resolveList(ids: string[]): void;
	rejectList(): void;
	resolveRead(paneId: string, text: string): void;
	rejectRead(paneId: string): void;
	readInFlight(paneId: string): boolean;
	listInFlight(): boolean;
}

function makeSource(): SourceFake {
	const pendingLists: Array<(ids: Set<string>) => void> = [];
	const pendingReads = new Map<string, Array<(text: string) => void>>();
	const pendingReadErrors = new Map<string, Array<(err: Error) => void>>();
	const listErrorRejects: Array<(err: Error) => void> = [];
	const fake: SourceFake = {
		source: {
			listPaneIds() {
				fake.listCalls++;
				return new Promise<Set<string>>((resolve, reject) => {
					pendingLists.push(resolve);
					listErrorRejects.push(reject);
				});
			},
			readScreenTail(paneId, lines) {
				fake.readCalls.push([paneId, lines]);
				return new Promise<string>((resolve, reject) => {
					const resolvers = pendingReads.get(paneId) ?? [];
					resolvers.push(resolve);
					pendingReads.set(paneId, resolvers);
					const rejecters = pendingReadErrors.get(paneId) ?? [];
					rejecters.push(reject);
					pendingReadErrors.set(paneId, rejecters);
				});
			},
		},
		listCalls: 0,
		readCalls: [],
		resolveList(ids) {
			const next = pendingLists.shift();
			assert.ok(next);
			next(new Set(ids));
		},
		rejectList() {
			const next = listErrorRejects.shift();
			assert.ok(next);
			next(new Error("list failed"));
		},
		resolveRead(paneId, text) {
			const next = pendingReads.get(paneId)?.shift();
			assert.ok(next);
			pendingReadErrors.get(paneId)?.shift();
			next(text);
		},
		rejectRead(paneId) {
			pendingReads.get(paneId)?.shift();
			const next = pendingReadErrors.get(paneId)?.shift();
			assert.ok(next);
			next(new Error("read failed"));
		},
		readInFlight(paneId) {
			return (pendingReads.get(paneId)?.length ?? 0) > 0;
		},
		listInFlight() {
			return pendingLists.length > 0;
		},
	};
	return fake;
}

const flush = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

test("pane list: snapshot stays null while the first refresh is in flight", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source);
	ops.refreshPaneList();
	assert.equal(src.listCalls, 1);
	assert.equal(ops.paneListSnapshot(), null);

	src.resolveList(["p1", "p2"]);
	await flush();
	const snapshot = ops.paneListSnapshot();
	assert.ok(snapshot?.ok);
	assert.deepEqual([...snapshot.ids], ["p1", "p2"]);
});

test("pane list: a refresh kicked while one is in flight does not double-fire", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source);
	ops.refreshPaneList();
	ops.refreshPaneList();
	ops.refreshPaneList();
	assert.equal(src.listCalls, 1);

	src.resolveList(["p1"]);
	await flush();
	ops.refreshPaneList();
	assert.equal(src.listCalls, 2);
});

test("pane list: a failed refresh stores a failed snapshot, not an empty live set", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source);
	ops.refreshPaneList();
	src.rejectList();
	await flush();

	const snapshot = ops.paneListSnapshot();
	assert.notEqual(snapshot, null);
	assert.equal(snapshot?.ok, false);
});

test("screen tail: throttled — a request inside the throttle window does not re-read", async () => {
	const src = makeSource();
	let nowMs = 0;
	const ops = createWatcherPaneOps(src.source, { now: () => nowMs, readThrottleMs: 1_000 });
	ops.requestScreenTail("p1");
	assert.deepEqual(src.readCalls, [["p1", 4]]);
	assert.equal(ops.screenTailSnapshot("p1"), "");

	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 1);
	assert.equal(src.readInFlight("p1"), true);

	src.resolveRead("p1", "__SUBAGENT_DONE_2__");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "__SUBAGENT_DONE_2__");

	nowMs = WATCHER_READ_THROTTLE_MS - 1;
	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 1);

	nowMs = WATCHER_READ_THROTTLE_MS;
	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 2);
});

test("screen tail: a failed read caches an empty tail, never a stale sentinel", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source, { readThrottleMs: 0 });
	ops.requestScreenTail("p1");
	src.resolveRead("p1", "__SUBAGENT_DONE_0__");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "__SUBAGENT_DONE_0__");

	ops.requestScreenTail("p1");
	src.rejectRead("p1");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "");
});

test("screen tail: reads for different panes never overlap themselves", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source, { readThrottleMs: 0 });
	ops.requestScreenTail("p1");
	ops.requestScreenTail("p2");
	ops.requestScreenTail("p1");
	assert.deepEqual(src.readCalls, [
		["p1", 4],
		["p2", 4],
	]);
	assert.equal(src.readInFlight("p1"), true);
	assert.equal(src.readInFlight("p2"), true);

	src.resolveRead("p1", "one");
	src.resolveRead("p2", "two");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "one");
	assert.equal(ops.screenTailSnapshot("p2"), "two");

	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 3);
});

test("dropPane forgets the cached tail and its throttle window", async () => {
	const src = makeSource();
	let nowMs = 0;
	const ops = createWatcherPaneOps(src.source, { now: () => nowMs, readThrottleMs: 60_000 });
	ops.requestScreenTail("p1");
	src.resolveRead("p1", "stale");
	await flush();

	ops.dropPane("p1");
	assert.equal(ops.screenTailSnapshot("p1"), "");
	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 2);
	assert.equal(src.readInFlight("p1"), true);
});

test("dropPane during an in-flight read: a late completion never populates the reused pane", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source, { readThrottleMs: 0 });
	ops.requestScreenTail("p1");
	assert.equal(src.readInFlight("p1"), true);

	ops.dropPane("p1");
	assert.equal(ops.screenTailSnapshot("p1"), "");

	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 2);
	assert.equal(src.readInFlight("p1"), true);

	src.resolveRead("p1", "__SUBAGENT_DONE_0__");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "");
	assert.equal(src.readInFlight("p1"), true);

	src.resolveRead("p1", "fresh");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "fresh");
});

test("a late rejection from an old generation does not write an empty tail", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source, { readThrottleMs: 0 });
	ops.requestScreenTail("p1");
	ops.dropPane("p1");

	ops.requestScreenTail("p1");
	assert.equal(src.readCalls.length, 2);
	assert.equal(src.readInFlight("p1"), true);

	src.rejectRead("p1");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "");
	assert.equal(src.readInFlight("p1"), true);

	src.resolveRead("p1", "fresh");
	await flush();
	assert.equal(ops.screenTailSnapshot("p1"), "fresh");
});

test("unknown pane reads as an empty tail", async () => {
	const src = makeSource();
	const ops = createWatcherPaneOps(src.source);
	assert.equal(ops.screenTailSnapshot("never-requested"), "");
	assert.equal(ops.paneListSnapshot(), null);
});
