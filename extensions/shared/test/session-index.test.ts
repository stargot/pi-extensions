/**
 * Equivalence + cache tests for the shared session index.
 *
 * The unified parser (parseSessionCombined) must produce results identical
 * to the legacy per-consumer parsers (ledger.parseSessionText and
 * recall.extractUnits) on the same fixtures — the golden expectations live
 * in ledger.test.ts and search.test.ts; here we compare the two paths
 * directly against each other.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUnits } from "../../session-recall/search.ts";
import { parseSessionText } from "../../session-ledger/ledger.ts";
import { loadIndex, parseSessionCombined, refreshSharedIndex, saveIndex } from "../session-index.ts";

function sessionText(opts: { cwd?: string; name?: string } = {}): string {
	const lines: unknown[] = [
		{ type: "session", version: 3, id: "s1", timestamp: "2026-09-05T12:00:00.000Z", cwd: opts.cwd ?? "/work/alpha" },
		{ type: "message", id: "u1", timestamp: "2026-09-05T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "How did we fix the WezTerm session plugin?" }] } },
		{
			type: "message",
			id: "a1",
			timestamp: "2026-09-05T12:00:02.000Z",
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5.3",
				usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } },
				stopReason: "end",
				content: [
					{ type: "thinking", thinking: "secret thoughts about wezterm" },
					{ type: "text", text: "We patched resurrect.wezterm to store sessions." },
					{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "wezterm.lua" } },
				],
			},
		},
		{ type: "message", id: "t1", timestamp: "2026-09-05T12:00:03.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "oldText not found" }], isError: true } },
		{ type: "message", id: "k1", timestamp: "2026-09-05T12:00:04.000Z", message: { role: "custom", customType: "plan", content: "Plan: migrate config" } },
		{ type: "compaction", id: "z1", timestamp: "2026-09-05T12:00:05.000Z", summary: "Summary: wezterm work done", usage: { input: 50, output: 5, cost: { total: 0.002 } } },
	];
	if (opts.name) lines.push({ type: "session_info", id: "n1", timestamp: "2026-09-05T12:00:06.000Z", name: opts.name });
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

test("parseSessionCombined: summary equivalent to ledger.parseSessionText", () => {
	const text = sessionText({ name: "WezTerm fix" });
	const combined = parseSessionCombined(text, "/x/s1.jsonl");
	const legacy = parseSessionText(text, "/x/s1.jsonl");
	assert.ok(combined && legacy);
	assert.deepEqual(combined.summary, legacy);
});

test("parseSessionCombined: units equivalent to recall.extractUnits", () => {
	const text = sessionText({ name: "WezTerm fix" });
	const combined = parseSessionCombined(text, "/x/s1.jsonl");
	const legacy = extractUnits(text, "/x/s1.jsonl");
	assert.ok(combined);
	assert.deepEqual(combined.units, legacy);
});

test("parseSessionCombined: headerless file yields undefined", () => {
	assert.equal(parseSessionCombined('{"type":"message"}\n', "/x"), undefined);
});

test("loadIndex/saveIndex: roundtrip, corrupt file, version mismatch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-shared-index-"));
	const file = join(dir, "cache", "session-index.json");
	try {
		const combined = parseSessionCombined(sessionText(), "/x/s1.jsonl")!;
		saveIndex(file, { version: 1, files: { "/x/s1.jsonl": { mtimeMs: 1, size: 2, summary: combined.summary, units: combined.units } } });
		const loaded = loadIndex(file);
		assert.equal(loaded.version, 1);
		assert.deepEqual(loaded.files["/x/s1.jsonl"]?.summary, combined.summary);

		writeFileSync(file, "{corrupt", "utf8");
		const healed = loadIndex(file);
		assert.deepEqual(healed.files, {});

		writeFileSync(file, JSON.stringify({ version: 999, files: {} }), "utf8");
		assert.deepEqual(loadIndex(file).files, {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refreshSharedIndex: incremental by mtime+size, drops removed, honors exclude", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shared-refresh-"));
	const file = join(root, "cache", "session-index.json");
	try {
		mkdirSync(join(root, "proj"), { recursive: true });
		const a = join(root, "proj", "a.jsonl");
		const b = join(root, "b.jsonl");
		writeFileSync(a, sessionText());
		writeFileSync(b, sessionText({ cwd: "/work/beta" }));

		const data = loadIndex(file);
		const first = refreshSharedIndex(root, data);
		assert.equal(first.files, 2);
		assert.equal(first.changed, 2);
		assert.equal(first.units, 10);

		const second = refreshSharedIndex(root, data);
		assert.equal(second.changed, 0);

		writeFileSync(b, sessionText({ cwd: "/work/beta" }) + `${JSON.stringify({ type: "message", id: "u9", timestamp: "2026-09-06T00:00:00.000Z", message: { role: "user", content: "later" } })}\n`);
		utimesSync(b, new Date(), new Date(Date.now() + 5000));
		const third = refreshSharedIndex(root, data);
		assert.equal(third.changed, 1);
		assert.equal(third.units, 11);

		const excluded = refreshSharedIndex(root, data, { exclude: a });
		assert.equal(excluded.files, 1);
		assert.ok(Object.keys(data.files).every((f) => f === b));

		rmSync(a);
		const fourth = refreshSharedIndex(root, data);
		assert.equal(fourth.files, 1);
		assert.equal(data.files[a], undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refreshSharedIndex: headerless file is skipped and unit text is capped", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shared-cap-"));
	const file = join(root, "cache", "session-index.json");
	try {
		writeFileSync(join(root, "noheader.jsonl"), '{"type":"message"}\n');
		const huge = "z".repeat(10_000);
		writeFileSync(join(root, "big.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-09-05T12:00:00.000Z", cwd: "/a" })}\n${JSON.stringify({ type: "message", id: "u1", timestamp: "2026-09-05T12:00:01.000Z", message: { role: "user", content: huge } })}\n`);

		const data = loadIndex(file);
		refreshSharedIndex(root, data);
		assert.equal(data.files[join(root, "noheader.jsonl")], undefined, "headerless file not indexed");
		const big = data.files[join(root, "big.jsonl")];
		assert.ok(big && big.units[0].text.length <= 4097, `unit text capped, got ${big?.units[0].text.length}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
