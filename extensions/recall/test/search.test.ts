import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	extractUnits,
	highlight,
	type Hit,
	type IndexCache,
	makeSnippet,
	parseQuery,
	refreshIndex,
	search,
} from "../search.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ResultsView } from "../view.ts";

function sessionText(opts: { cwd?: string; name?: string } = {}): string {
	const lines: unknown[] = [
		{
			type: "session",
			version: 3,
			id: "s1",
			timestamp: "2026-09-05T12:00:00.000Z",
			cwd: opts.cwd ?? "C:\\Proj\\alpha",
		},
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
				content: [
					{ type: "thinking", thinking: "secret thoughts about wezterm" },
					{ type: "text", text: "We patched resurrect.wezterm to store sessions." },
					{
						type: "toolCall",
						id: "c1",
						name: "edit",
						arguments: { path: "wezterm.lua", oldText: "old", newText: "new" },
					},
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
				content: [{ type: "text", text: "oldText not found in wezterm.lua" }],
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
			firstKeptEntryId: "a1",
			tokensBefore: 10,
		},
	];
	if (opts.name) lines.push({ type: "session_info", id: "n1", timestamp: "2026-09-05T12:00:06.000Z", name: opts.name });
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

test("extractUnits builds one unit per message with roles, tools and session name", () => {
	const units = extractUnits(sessionText({ name: "WezTerm fix" }), "/x/s1.jsonl");
	assert.deepEqual(
		units.map((u) => u.role),
		["user", "assistant", "tool", "custom", "summary"],
	);
	assert.equal(units[0].project, "alpha");
	assert.equal(units[0].sessionName, "WezTerm fix");
	assert.ok(units[1].text.includes("→ edit"));
	assert.ok(!units[1].text.includes("secret thoughts"));
	assert.equal(units[2].tool, "edit");
	assert.equal(units[3].tool, "plan");
	assert.equal(units[4].entryId, "z1");
	assert.equal(extractUnits('{"type":"message"}\n', "/x").length, 0);
});

test("parseQuery handles words, quoted phrases and filters", () => {
	assert.deepEqual(parseQuery("fix wezterm"), { terms: ["fix", "wezterm"] });
	assert.deepEqual(parseQuery('"session plugin" role:user project:Alpha tool:Edit'), {
		terms: ["session plugin"],
		phrases: ["session plugin"],
		role: "user",
		project: "Alpha",
		tool: "edit",
	});
	assert.deepEqual(parseQuery("role:bogus x"), { terms: ["x"] });
	assert.deepEqual(parseQuery('"role:user"'), { terms: ["role:user"], phrases: ["role:user"] });
});

test("search: BM25 ranks term density first, then filters and snippets apply", () => {
	const units = extractUnits(sessionText(), "/x/s1.jsonl");
	const all = search(units, parseQuery("wezterm"));
	assert.equal(all.total, 4);
	// Ответ ассистента упоминает wezterm дважды (текст + путь в вызове) — плотность выигрывает.
	assert.equal(all.hits[0].unit.role, "assistant");
	assert.ok(all.hits.every((h) => h.snippet.toLowerCase().includes("wezterm")));
	// Скор убывает по хитам.
	for (let i = 1; i < all.hits.length; i++) assert.ok(all.hits[i - 1].score >= all.hits[i].score);

	const both = search(units, parseQuery("wezterm plugin"));
	assert.equal(both.total, 1);
	assert.equal(both.hits[0].unit.role, "user");

	// Фраза весит ×2: хит с точной фразой выше хита с одним совпадением терма.
	const phrase = search(units, parseQuery('"wezterm work"'));
	assert.equal(phrase.hits[0].unit.role, "summary");

	assert.equal(search(units, parseQuery("wezterm role:tool")).total, 1);
	assert.equal(search(units, parseQuery("wezterm tool:edit")).total, 1);
	assert.equal(search(units, parseQuery("wezterm project:beta")).total, 0);
	assert.equal(search(units, parseQuery("project:alpha")).total, 5);
	assert.equal(search(units, parseQuery('"not found"')).hits[0].unit.role, "tool");
	assert.equal(search(units, parseQuery("wezterm"), { limit: 2 }).hits.length, 2);
	assert.equal(search(units, parseQuery("nomatch")).total, 0);
});

test("search: recency breaks ties — fresher identical text ranks higher", () => {
	const old = extractUnits(
		[
			'{"type":"session","version":3,"id":"old","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/a"}',
			'{"type":"message","id":"u1","timestamp":"2025-01-01T00:00:01.000Z","message":{"role":"user","content":"needle"}}',
		].join("\n"),
		"/old.jsonl",
	);
	const fresh = extractUnits(
		[
			'{"type":"session","version":3,"id":"new","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/a"}',
			'{"type":"message","id":"u1","timestamp":"2026-09-01T00:00:01.000Z","message":{"role":"user","content":"needle"}}',
		].join("\n"),
		"/new.jsonl",
	);
	const ranked = search([...old, ...fresh], parseQuery("needle"));
	assert.equal(ranked.hits[0].unit.file, "/new.jsonl");
	assert.equal(ranked.hits[1].unit.file, "/old.jsonl");
});

test("makeSnippet and highlight", () => {
	const text = `${"a".repeat(100)}NEEDLE${"b".repeat(100)}`;
	const snippet = makeSnippet(text, 100, 6, 10);
	assert.equal(snippet, `…${"a".repeat(10)}NEEDLE${"b".repeat(10)}…`);
	assert.equal(makeSnippet("short", 0, 0, 10), "short");
	assert.equal(
		highlight("Fix wezterm now", ["wezterm", "fix"], (s) => `[${s}]`),
		"[Fix] [wezterm] now",
	);
	assert.equal(
		highlight("a.b", ["."], (s) => `[${s}]`),
		"a[.]b",
	);
});

test("refreshIndex caches by mtime and size and drops removed files", () => {
	const dir = mkdtempSync(join(tmpdir(), "recall-"));
	try {
		const a = join(dir, "proj", "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(join(dir, "note.txt"), "ignored");
		mkdirSync(join(dir, "proj"));
		writeFileSync(a, sessionText());
		writeFileSync(b, sessionText({ cwd: "/home/u/beta" }));

		const cache: IndexCache = new Map();
		const first = refreshIndex(dir, cache);
		assert.equal(first.files, 2);
		assert.equal(first.reparsed, 2);
		assert.equal(first.units.length, 10);

		const second = refreshIndex(dir, cache);
		assert.equal(second.reparsed, 0);

		writeFileSync(
			b,
			`${sessionText({ cwd: "/home/u/beta" })}${JSON.stringify({ type: "message", id: "u9", timestamp: "2026-09-06T00:00:00.000Z", message: { role: "user", content: "later" } })}\n`,
		);
		utimesSync(b, new Date(), new Date(Date.now() + 5000));
		const third = refreshIndex(dir, cache);
		assert.equal(third.reparsed, 1);
		assert.equal(third.units.length, 11);

		const excluded = refreshIndex(dir, cache, { exclude: a });
		assert.equal(excluded.files, 1);
		assert.ok(excluded.units.every((u) => u.file === b));

		rmSync(a);
		const fourth = refreshIndex(dir, cache);
		assert.equal(fourth.files, 1);
		assert.equal(cache.size, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- ResultsView (SelectList): маппинг выбора, пейджинг, закрытие ---

function mockTui(rows: number): TUI {
	const tui = { requestRender: () => {}, terminal: { rows, columns: 100 } };
	return tui as unknown as TUI;
}

function mockTheme(): Theme {
	return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
}

/** raw-последовательности навигационных клавиш (как их отдаёт терминал). */
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	enter: "\r",
};

function makeHits(units: ReturnType<typeof extractUnits>, n: number): Hit[] {
	return Array.from({ length: n }, (_, i) => ({
		unit: units[i % units.length],
		score: n - i,
		snippet: `snippet ${i} wezterm`,
		position: 0,
	}));
}

function makeView(hits: Hit[], handlers: { onSelect: (hit: Hit) => void; onClose: () => void }): ResultsView {
	return new ResultsView({
		tui: mockTui(12), // pageSize = max(3, 12-6) = 6 строк на страницу
		theme: mockTheme(),
		hits,
		total: hits.length,
		terms: ["wezterm"],
		queryText: "wezterm",
		onSelect: handlers.onSelect,
		onClose: handlers.onClose,
	});
}

test("ResultsView: Enter вызывает onSelect(hits[i]) для выделенного хита", () => {
	const units = extractUnits(sessionText(), "/x/s1.jsonl");
	const hits = makeHits(units, units.length);
	const picked: Hit[] = [];
	const view = makeView(hits, { onSelect: (h) => picked.push(h), onClose: () => {} });

	view.handleInput(KEYS.enter);
	assert.equal(picked.length, 1);
	assert.equal(picked[0], hits[0]);

	view.handleInput(KEYS.down);
	view.handleInput(KEYS.down);
	view.handleInput(KEYS.enter);
	assert.equal(picked[1], hits[2]);
});

test("ResultsView: пейджинг не ломает индексацию хитов", () => {
	const units = extractUnits(sessionText(), "/x/s1.jsonl");
	const hits = makeHits(units, 30);
	const picked: Hit[] = [];
	const view = makeView(hits, { onSelect: (h) => picked.push(h), onClose: () => {} });

	// Две страницы вниз: выделение 0 → 6 → 12, Enter открывает ровно hits[12].
	view.handleInput(KEYS.pageDown);
	view.handleInput(KEYS.pageDown);
	view.handleInput(KEYS.enter);
	assert.equal(picked[0], hits[12]);

	// Внутри страницы j сдвигает на один: 12 → 13.
	view.handleInput("j");
	view.handleInput(KEYS.enter);
	assert.equal(picked[1], hits[13]);

	// end → последний, home → первый: value-индексы глобальные, не страничные.
	view.handleInput(KEYS.end);
	view.handleInput(KEYS.enter);
	assert.equal(picked[2], hits[29]);
	view.handleInput(KEYS.home);
	view.handleInput(KEYS.enter);
	assert.equal(picked[3], hits[0]);

	// SelectList рисует своё окно: после первой страницы видна позиция 7/30 и «→» на snippet 6.
	view.handleInput(KEYS.pageDown);
	const out = view.render(100);
	assert.ok(
		out.some((line) => line.includes("(7/30)")),
		`позиция SelectList: ${out.join("\n")}`,
	);
	const marked = out.find((line) => line.includes("→"));
	assert.ok(marked?.includes("snippet 6"), `выделенная строка: ${marked}`);
});

test("ResultsView: рендер — заголовок, подсветка, подсказка; q/Esc закрывают", () => {
	const units = extractUnits(sessionText(), "/x/s1.jsonl");
	const hits = makeHits(units, units.length);
	let closed = 0;
	const view = makeView(hits, { onSelect: () => {}, onClose: () => closed++ });

	const out = view.render(100);
	assert.ok(out[0].includes("Recall") && out[0].includes("wezterm"), `заголовок: ${out[0]}`);
	assert.ok(out[1].includes("─"), "разделитель");
	assert.ok(out[2].includes("→") && out[2].includes("snippet 0 wezterm"), `первая строка: ${out[2]}`);
	assert.ok(out.at(-1)?.startsWith("↑↓ PgUp PgDn"), `подсказка: ${out.at(-1)}`);
	assert.ok(
		out.some((line) => line.includes("snippet 0 wezterm")),
		"фрагмент с подсветкой на месте",
	);

	view.handleInput("q");
	view.handleInput("\x1b");
	view.handleInput("\x03");
	assert.equal(closed, 3);
});

test("ResultsView: пустой результат — Nothing found, Enter и q безопасны", () => {
	let selected = 0;
	let closed = 0;
	const view = makeView([], { onSelect: () => selected++, onClose: () => closed++ });
	const out = view.render(80);
	assert.ok(
		out.some((line) => line.includes("Nothing found.")),
		`пустой список: ${out.join("\n")}`,
	);
	view.handleInput(KEYS.enter);
	view.handleInput("q");
	assert.equal(selected, 0);
	assert.equal(closed, 1);
});
