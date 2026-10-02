import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtElapsed, formatJobsTable, formatStatus, jobRows, oneline, truncateTail } from "../format.ts";
import type { JobRecord } from "../registry.ts";

/** Minimal job record for table tests — only the fields formatting reads. */
function job(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		id: "b12ab34c",
		name: "Typecheck watch",
		command: "npm run typecheck -- --watch",
		cwd: "C:\\proj",
		shell: "pwsh",
		pid: 12345,
		status: "running",
		exitCode: null,
		startedAt: new Date(Date.now() - 30_000).toISOString(),
		endedAt: null,
		outputPath: ".pi/jobs/b12ab34c/output.log",
		origin: "model",
		wake: true,
		timeoutSeconds: null,
		sessionId: "s1",
		surviveExit: false,
		...overrides,
	};
}

test("fmtElapsed: seconds, minutes, hours", () => {
	assert.equal(fmtElapsed(0), "0s");
	assert.equal(fmtElapsed(42_000), "42s");
	assert.equal(fmtElapsed(130_000), "2m10s");
	assert.equal(fmtElapsed(3_723_000), "1h02m");
	assert.equal(fmtElapsed(-5), "0s", "negative clamps to 0s");
});

test("oneline: flattens whitespace and caps with ellipsis", () => {
	assert.equal(oneline("  a\n\nb\tc  ", 10), "a b c");
	assert.equal(oneline("abcdefghij", 5), "abcd…");
	assert.equal(oneline("abc", 5), "abc");
});

test("formatStatus: every status has a stable human form", () => {
	assert.equal(formatStatus("running"), "▶ running");
	assert.equal(formatStatus("completed"), "✓ completed");
	assert.equal(formatStatus("failed"), "✗ failed");
	assert.equal(formatStatus("timeout"), "⏱ timeout");
	assert.equal(formatStatus("killed"), "✖ killed");
	assert.equal(formatStatus("orphaned"), "⚠ orphaned");
});

test("truncateTail: short log passes through untouched", () => {
	const r = truncateTail("hello", 100, ".pi/jobs/x/output.log");
	assert.equal(r.text, "hello");
	assert.equal(r.truncated, false);
	assert.equal(r.totalChars, 5);
});

test("truncateTail: long log cut with honest marker naming the full log", () => {
	const log = `x`.repeat(1000) + "THE_TAIL";
	const r = truncateTail(log, 100, ".pi/jobs/b12ab34c/output.log");
	assert.equal(r.truncated, true);
	assert.equal(r.totalChars, 1008);
	assert.ok(r.text.endsWith("THE_TAIL"), "keeps the tail");
	assert.ok(r.text.includes("showing last 100 of 1008 chars"), "marker states sizes");
	assert.ok(r.text.includes(".pi/jobs/b12ab34c/output.log"), "marker names the full log");
	assert.ok(r.text.length <= 100 + 200, "tail stays within budget plus marker");
});

test("truncateTail: maxChars 0 yields pointer-only view", () => {
	const r = truncateTail("data", 0, ".pi/jobs/x/output.log");
	assert.equal(r.truncated, true);
	assert.ok(r.text.includes(".pi/jobs/x/output.log"));
	assert.equal(r.totalChars, 4);
});

test("truncateTail: cut never splits a surrogate pair", () => {
	// U+1D7D8 «𝟘» — пара из высокого (D835) и низкого (DFD8) суррогатов.
	// Резать ровно между половинами нельзя — хвост начинался бы сиротой.
	const pair = "𝟘";
	const log = `x`.repeat(10) + pair + "TAIL";
	const cut = 11; // log[11] — низкий суррогат пары
	assert.equal(log.charCodeAt(cut) >= 0xdc00, true, "precondition: cut lands on a low surrogate");
	const r = truncateTail(log, log.length - cut, ".pi/jobs/x/output.log");
	assert.equal(r.truncated, true);
	const body = r.text.split("\n")[1] ?? "";
	assert.ok(body.startsWith(pair), "tail starts with the intact surrogate pair");
	assert.ok(body.endsWith("TAIL"));
});

test("truncateTail: totalCharsOverride reports the FULL log size, not the window", () => {
	const windowText = `y`.repeat(30);
	const r = truncateTail(windowText, 10, ".pi/jobs/x/output.log", 100_000);
	assert.equal(r.truncated, true);
	assert.equal(r.totalChars, 100_000, "override wins over window length");
	assert.ok(r.text.includes("of 100000 chars"));
	assert.ok(r.text.endsWith("yyyyyyyyyy"), "last maxChars of the window kept");
});

test("jobRows: running first, then newest first; elapsed honest", () => {
	const now = Date.now();
	const old = job({
		id: "aaaaaaaa",
		name: "old dev",
		status: "completed",
		startedAt: new Date(now - 120_000).toISOString(),
		endedAt: new Date(now - 60_000).toISOString(),
	});
	const fresh = job({ id: "bbbbbbbb", name: "fresh dev", startedAt: new Date(now - 5_000).toISOString() });
	const mid = job({
		id: "cccccccc",
		name: "mid tests",
		status: "failed",
		exitCode: 1,
		startedAt: new Date(now - 90_000).toISOString(),
		endedAt: new Date(now - 30_000).toISOString(),
	});

	const rows = jobRows([old, mid, fresh], now);
	assert.deepEqual(
		rows.map((r) => r.id),
		["bbbbbbbb", "cccccccc", "aaaaaaaa"],
		"running first, then newest ended",
	);
	assert.equal(rows[1]?.status, "✗ failed");
	assert.match(rows[1]?.elapsed ?? "", /^\d+m\d{2}s$/);
	assert.match(rows[2]?.elapsed ?? "", /^1m00s$/, "ended jobs measure started→ended, not started→now");
});

test("formatJobsTable: aligned header + one row per job", () => {
	const now = Date.now();
	const a = job({ id: "aaaaaaaa", name: "dev" });
	const b = job({ id: "bbbbbbbb", name: "tests", status: "completed", exitCode: 0 });
	const table = formatJobsTable([a, b], now);
	const lines = table.split("\n");
	assert.equal(lines.length, 3, "header + 2 rows");
	assert.match(lines[0] ?? "", /^\s*id\s+status\s+name\s+elapsed\s+command$/);
	assert.ok(
		lines.every((l) => l.split("  ").every((_, __, arr) => arr.length >= 5)),
		"columns split consistently",
	);
	assert.ok((lines[1] ?? "").includes("aaaaaaaa"), "running job first");
	assert.ok((lines[1] ?? "").includes("▶ running"));
	assert.ok((lines[2] ?? "").includes("bbbbbbbb"));
});
