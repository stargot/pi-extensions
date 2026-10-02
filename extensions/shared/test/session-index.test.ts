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
import {
	INDEX_VERSION,
	isNestedSessionFile,
	loadIndex,
	parseSessionCombined,
	refreshSharedIndex,
	saveIndex,
} from "../session-index.ts";

function sessionText(opts: { cwd?: string; name?: string } = {}): string {
	const lines: unknown[] = [
		{ type: "session", version: 3, id: "s1", timestamp: "2026-09-05T12:00:00.000Z", cwd: opts.cwd ?? "/work/alpha" },
		{
			type: "message",
			id: "u1",
			timestamp: "2026-09-05T12:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "How did we fix the WezTerm session plugin?" }] },
		},
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
		{
			type: "message",
			id: "t1",
			timestamp: "2026-09-05T12:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "edit",
				content: [{ type: "text", text: "oldText not found" }],
				isError: true,
			},
		},
		{
			type: "message",
			id: "k1",
			timestamp: "2026-09-05T12:00:04.000Z",
			message: { role: "custom", customType: "plan", content: "Plan: migrate config" },
		},
		{
			type: "compaction",
			id: "z1",
			timestamp: "2026-09-05T12:00:05.000Z",
			summary: "Summary: wezterm work done",
			usage: { input: 50, output: 5, cost: { total: 0.002 } },
		},
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
		saveIndex(file, {
			version: INDEX_VERSION,
			files: { "/x/s1.jsonl": { mtimeMs: 1, size: 2, summary: combined.summary, units: combined.units } },
		});
		const loaded = loadIndex(file);
		assert.equal(loaded.version, INDEX_VERSION);
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

test("loadIndex: legacy v1 cache (без nested/isNested) перестраивается, а не отдаёт неполные summary", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-shared-index-v1-"));
	const file = join(dir, "cache", "session-index.json");
	try {
		mkdirSync(join(dir, "cache"), { recursive: true });
		const legacy = parseSessionCombined(sessionText(), "/x/s1.jsonl")!.summary as unknown as Record<string, unknown>;
		delete legacy.nested;
		delete legacy.isNested;
		writeFileSync(
			file,
			JSON.stringify({ version: 1, files: { "/x/s1.jsonl": { mtimeMs: 1, size: 2, summary: legacy, units: [] } } }),
			"utf8",
		);
		assert.deepEqual(loadIndex(file).files, {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("nested-сплит: файлы под subagents/** помечаются isNested, usage зеркалится в summary.nested", () => {
	const text = sessionText();
	const main = parseSessionCombined(text, "/x/s1.jsonl")!.summary;
	const nestedPosix = parseSessionCombined(text, "/x/subagents/child.jsonl")!.summary;
	const nestedWin = parseSessionCombined(text, "C:\\pi\\sessions\\subagents\\child.jsonl")!.summary;

	assert.equal(main.isNested, false);
	assert.equal(main.nested.turns, 0);
	assert.equal(main.nested.input, 0);

	// Определение nested (сверено с реальным ~/.pi/agent/sessions): файл субагента лежит
	// под <sessionsRoot>/subagents/**; pi-forge forgeNestedUsage в данных не встречается.
	assert.equal(isNestedSessionFile("/x/subagents/child.jsonl"), true);
	assert.equal(isNestedSessionFile("C:\\pi\\sessions\\subagents\\child.jsonl"), true);
	assert.equal(isNestedSessionFile("/x/subagents-nested/s1.jsonl"), false);
	assert.equal(nestedPosix.isNested, true);
	assert.equal(nestedWin.isNested, true);

	// stats остаётся комбинированным (обратная совместимость), nested — полная копия для nested-файла.
	assert.deepEqual(nestedPosix.nested, nestedPosix.stats);
	assert.ok(nestedPosix.stats.input > 0);
});

test("unknownUsage: assistant-запросы без usage считаются счётчиком", () => {
	const lines = [
		{ type: "session", version: 3, id: "s9", timestamp: "2026-09-05T12:00:00.000Z", cwd: "/work/alpha" },
		{
			type: "message",
			id: "u1",
			timestamp: "2026-09-05T12:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "go" }] },
		},
		// abort/error: usage отсутствует вовсе
		{
			type: "message",
			id: "a1",
			timestamp: "2026-09-05T12:00:02.000Z",
			message: { role: "assistant", provider: "zai", model: "m", stopReason: "error", content: [] },
		},
		// usage есть, но все счётчики нулевые (pi-forge-совместимая трактовка «без usage»)
		{
			type: "message",
			id: "a2",
			timestamp: "2026-09-05T12:00:03.000Z",
			message: {
				role: "assistant",
				provider: "zai",
				model: "m",
				stopReason: "aborted",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				content: [],
			},
		},
		// нормальный запрос: в unknownUsage не попадает
		{
			type: "message",
			id: "a3",
			timestamp: "2026-09-05T12:00:04.000Z",
			message: {
				role: "assistant",
				provider: "zai",
				model: "m",
				stopReason: "end",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				content: [{ type: "text", text: "done" }],
			},
		},
	];
	const s = parseSessionCombined(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "/x/s9.jsonl")!.summary;
	assert.equal(s.stats.turns, 3);
	assert.equal(s.stats.unknownUsage, 2);
	// Разрез по моделям согласован с итогом
	assert.equal(s.byModel["zai/m"].unknownUsage, 2);
	assert.equal(s.byDay["2026-09-05"].unknownUsage, 2);
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

		writeFileSync(
			b,
			sessionText({ cwd: "/work/beta" }) +
				`${JSON.stringify({ type: "message", id: "u9", timestamp: "2026-09-06T00:00:00.000Z", message: { role: "user", content: "later" } })}\n`,
		);
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
		writeFileSync(
			join(root, "big.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-09-05T12:00:00.000Z", cwd: "/a" })}\n${JSON.stringify({ type: "message", id: "u1", timestamp: "2026-09-05T12:00:01.000Z", message: { role: "user", content: huge } })}\n`,
		);

		const data = loadIndex(file);
		refreshSharedIndex(root, data);
		assert.equal(data.files[join(root, "noheader.jsonl")], undefined, "headerless file not indexed");
		const big = data.files[join(root, "big.jsonl")];
		assert.ok(big && big.units[0].text.length <= 4097, `unit text capped, got ${big?.units[0].text.length}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// pi 1.0.0: сессия с context_edit (без replacement и с replacement) и retain-none
// компакцией (summary: null). Форма context_edit сверена с реальными JSONL
// ~/.pi/agent/sessions и docs/session-format.md пакета 1.0.0.
function pi100SessionText(): string {
	const lines: unknown[] = [
		{ type: "session", version: 3, id: "s10", timestamp: "2026-09-06T10:00:00.000Z", cwd: "/work/alpha" },
		{
			type: "message",
			id: "u1",
			timestamp: "2026-09-06T10:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "secret prompt about wezterm" }] },
		},
		{
			type: "message",
			id: "a1",
			timestamp: "2026-09-06T10:00:02.000Z",
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5.3",
				usage: { input: 10, output: 5, cost: { total: 0.001 } },
				stopReason: "end",
				content: [{ type: "text", text: "answer one" }],
			},
		},
		// context_edit без replacement: цель (u1) исключается из будущего контекста,
		// raw history не меняется — индекс продолжает видеть u1, правка юнита не даёт.
		{ type: "context_edit", id: "e1", timestamp: "2026-09-06T10:00:03.000Z", targetId: "u1", replacement: null },
		// context_edit с replacement: подменяется только content цели; тоже не индексируется.
		{
			type: "context_edit",
			id: "e2",
			timestamp: "2026-09-06T10:00:04.000Z",
			targetId: "a1",
			replacement: { content: [{ type: "text", text: "edited answer" }] },
		},
		// retain-none компакция (extension draft): summary и firstKeptEntryId null —
		// счётчики/usage считаются, summary-юнита нет.
		{
			type: "compaction",
			id: "z2",
			timestamp: "2026-09-06T10:00:05.000Z",
			summary: null,
			firstKeptEntryId: null,
			usage: { input: 7, output: 3, cost: { total: 0.002 } },
		},
		// Сериализованная форма хоста для retain-none: firstKeptEntryId = собственный id.
		{
			type: "compaction",
			id: "z3",
			timestamp: "2026-09-06T10:00:06.000Z",
			summary: "self retained checkpoint",
			firstKeptEntryId: "z3",
		},
	];
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

test("pi 1.0.0: context_edit пропускается, retain-none компакция не крэшит, агрегаты сходятся", () => {
	const text = pi100SessionText();
	const combined = parseSessionCombined(text, "/x/s10.jsonl");
	assert.ok(combined, "файл с context_edit/retain-none остаётся валидным");
	const { summary, units } = combined;

	// context_edit: ни одна правка не стала юнитом; исходные записи на месте.
	assert.ok(units.some((u) => u.entryId === "u1" && u.role === "user"));
	assert.ok(units.some((u) => u.entryId === "a1" && u.role === "assistant"));
	assert.ok(units.every((u) => u.entryId !== "e1" && u.entryId !== "e2"));

	// Summary-юниты: только от z3 (у z2 summary null, у e1/e2 их нет вовсе).
	const summaryUnits = units.filter((u) => u.role === "summary");
	assert.equal(summaryUnits.length, 1);
	assert.equal(summaryUnits[0].entryId, "z3");

	// Обе компакции посчитаны (включая retain-none), usage z2 сложился в итог.
	assert.equal(summary.stats.compactions, 2);
	assert.equal(summary.stats.input, 17); // 10 (a1) + 7 (z2)
	assert.equal(summary.stats.cost, 0.003);
	assert.equal(summary.byDay["2026-09-06"].input, 17);
	// Расход компакции относится к последней модели сессии — разрез сходится с итогом.
	assert.equal(summary.byModel["zai/glm-5.3"].input, 17);
	assert.equal(summary.byModel["zai/glm-5.3"].compactions, 2);

	// endedAt дотягивается до последней записи (context_edit/compaction не мешают).
	assert.equal(summary.endedAt, Date.parse("2026-09-06T10:00:06.000Z"));

	// Единый парсер согласован с legacy-обёртками на новых типах записей.
	assert.deepEqual(parseSessionText(text, "/x/s10.jsonl"), summary);
	assert.deepEqual(extractUnits(text, "/x/s10.jsonl"), units);
});

test("pi 1.0.0: refreshSharedIndex индексирует файл с context_edit/retain-none без пометки невалидным", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shared-pi100-"));
	const file = join(root, "cache", "session-index.json");
	try {
		const target = join(root, "s10.jsonl");
		writeFileSync(target, pi100SessionText());
		const data = loadIndex(file);
		const result = refreshSharedIndex(root, data);
		assert.equal(result.files, 1);
		assert.equal(result.changed, 1);
		const record = data.files[target];
		assert.ok(record?.summary, "файл проиндексирован (не discarded)");
		assert.equal(record.summary.stats.compactions, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
