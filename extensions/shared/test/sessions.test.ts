import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { addUsage, discoverSessionFiles, emptyUsageTotals, resolveSessionsDir } from "../sessions.ts";

test("resolveSessionsDir: env override wins, default falls back to ~/.pi/agent", () => {
	assert.equal(resolveSessionsDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), join("/custom/agent", "sessions"));
	assert.equal(resolveSessionsDir({}), join(homedir(), ".pi", "agent", "sessions"));
	assert.equal(resolveSessionsDir({ PI_CODING_AGENT_DIR: "" }), join(homedir(), ".pi", "agent", "sessions"), "empty env value falls back");
});

test("discoverSessionFiles: recursive .jsonl discovery, sorted, others ignored", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shared-sessions-"));
	try {
		mkdirSync(join(root, "sub", "deep"), { recursive: true });
		mkdirSync(join(root, "empty-dir"));
		writeFileSync(join(root, "a.jsonl"), "{}");
		writeFileSync(join(root, "sub", "b.jsonl"), "{}");
		writeFileSync(join(root, "sub", "deep", "c.jsonl"), "{}");
		writeFileSync(join(root, "notes.txt"), "not a session");
		writeFileSync(join(root, "sub", "d.jsonl.bak"), "{}");

		const files = discoverSessionFiles(root);
		assert.deepEqual(
			files.map((f) => f.slice(root.length + 1)),
			[join("a.jsonl"), join("sub", "b.jsonl"), join("sub", "deep", "c.jsonl")],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSessionFiles: missing root and empty dir yield empty list", () => {
	assert.deepEqual(discoverSessionFiles(join(tmpdir(), "does-not-exist-pi-shared")), []);
	const empty = mkdtempSync(join(tmpdir(), "pi-shared-empty-"));
	try {
		assert.deepEqual(discoverSessionFiles(empty), []);
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});

test("addUsage: sums optional pi usage into the accumulator", () => {
	const t = emptyUsageTotals();
	assert.deepEqual(t, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	addUsage(t, undefined);
	addUsage(t, { input: 10, output: 2, cost: { total: 0.001 } });
	addUsage(t, { input: 5, cacheRead: 3, cost: { total: 0.002 } });
	assert.deepEqual(t, { input: 15, output: 2, cacheRead: 3, cacheWrite: 0, cost: 0.003 });
});
