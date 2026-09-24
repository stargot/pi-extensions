import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addRunningWorker,
	capTaskText,
	isPidAlive,
	readRunningWorkers,
	removeRunningWorker,
	runningIndexPath,
	type RunningWorker,
} from "../running-index.ts";

const worker = (overrides: Partial<RunningWorker> = {}): RunningWorker => ({
	id: "w-1",
	pid: 1234,
	label: "scout",
	task: "find the missing workers",
	startedAt: Date.now(),
	sessionFile: "C:/x/s.jsonl",
	...overrides,
});

test("isPidAlive: own pid alive, bogus pids dead", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(-1), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(999999999), false);
});

test("capTaskText truncates long tasks", () => {
	const capped = capTaskText("x".repeat(500), 200);
	assert.ok(capped.length <= 200);
	assert.ok(capped.endsWith("…"));
	assert.equal(capTaskText("short"), "short");
});

test("add/read/remove roundtrip with custom liveness", () => {
	const dir = mkdtempSync(join(tmpdir(), "ri-"));
	const path = runningIndexPath(dir);
	try {
		addRunningWorker(path, worker());
		addRunningWorker(path, worker({ id: "w-2", pid: 42, startedAt: Date.now() + 1 }));
		const allAlive = readRunningWorkers(path, () => true);
		assert.equal(allAlive.workers.length, 2);
		// Sorted by startedAt.
		assert.equal(allAlive.workers[0].id, "w-1");

		// Dead entries are reaped and rewritten.
		const reaped = readRunningWorkers(path, (pid) => pid !== 42);
		assert.equal(reaped.workers.length, 1);
		assert.equal(reaped.reaped, 1);
		assert.equal(reaped.workers[0].id, "w-1");
		const stored = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(Object.keys(stored.workers).length, 1);

		// Task text is capped at write time.
		addRunningWorker(path, worker({ id: "w-3", pid: 7, task: "y".repeat(500) }));
		const capped = readRunningWorkers(path, () => true).workers.find((w) => w.id === "w-3");
		assert.ok(capped && capped.task.length <= 200);

		removeRunningWorker(path, "w-3");
		assert.equal(readRunningWorkers(path, () => true).workers.find((w) => w.id === "w-3"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing index file reads empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "ri-"));
	try {
		assert.equal(existsSync(runningIndexPath(dir)), false);
		const r = readRunningWorkers(runningIndexPath(dir));
		assert.deepEqual(r, { workers: [], reaped: 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("corrupt index file reads empty instead of throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "ri-"));
	const path = runningIndexPath(dir);
	try {
		writeFileSync(path, "{not json");
		const r = readRunningWorkers(path);
		assert.equal(r.workers.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeIndexFile: no temp-file leftovers after add/remove", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-running-tmp-"));
	const path = runningIndexPath(dir);
	try {
		addRunningWorker(path, worker({ id: "a" }));
		addRunningWorker(path, worker({ id: "b" }));
		removeRunningWorker(path, "a");
		const { workers } = readRunningWorkers(path, () => true);
		assert.equal(workers.length, 1);
		assert.equal(workers[0]?.id, "b");
		const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
		assert.equal(leftovers.length, 0, `no tmp files left: ${leftovers.join(", ")}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
