import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { ScrollReport } from "../../shared/scroll-report.ts";
import { loadAuditThemes } from "../../shared/theme-contrast.ts";
import {
	buildLedger,
	cachePercent,
	dayOf,
	emptyStats,
	groupRows,
	inPeriod,
	parseArgs,
	parseSessionText,
	periodStart,
	promptTokens,
	projectName,
	subtractStats,
	topSessions,
} from "../ledger.ts";
import { bar, fmtCost, fmtPercent, fmtTokens, renderLedger, renderTable, summaryLine } from "../report.ts";

const usage = (input: number, output: number, cacheRead = 0, cost = 0.01) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function sessionText(opts: { cwd?: string; start?: string; model?: string } = {}): string {
	const start = opts.start ?? "2026-09-05T12:00:00.000Z";
	const model = opts.model ?? "glm-5.3-flash";
	const lines = [
		{ type: "session", version: 3, id: "s1", timestamp: start, cwd: opts.cwd ?? "C:\\Proj\\alpha" },
		{ type: "model_change", id: "a", parentId: null, timestamp: start, provider: "zai", modelId: model },
		{
			type: "message",
			id: "u1",
			parentId: "a",
			timestamp: start,
			message: { role: "user", content: [{ type: "text", text: "  fix   the bug in auth  " }] },
		},
		{
			type: "message",
			id: "m1",
			parentId: "u1",
			timestamp: "2026-09-05T12:00:05.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
				provider: "zai",
				model,
				usage: usage(1000, 50, 0, 0.01),
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "t1",
			parentId: "m1",
			timestamp: "2026-09-05T12:00:06.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "x" }],
				isError: false,
			},
		},
		{
			type: "message",
			id: "m2",
			parentId: "t1",
			timestamp: "2026-09-05T12:00:10.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c2", name: "edit", arguments: {} }],
				provider: "zai",
				model,
				usage: usage(200, 40, 1800, 0.02),
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "t2",
			parentId: "m2",
			timestamp: "2026-09-05T12:00:11.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "edit",
				content: [{ type: "text", text: "oldText not found" }],
				isError: true,
			},
		},
		{
			type: "compaction",
			id: "k1",
			parentId: "t2",
			timestamp: "2026-09-05T12:00:12.000Z",
			summary: "s",
			firstKeptEntryId: "m2",
			tokensBefore: 3000,
			usage: usage(500, 100, 0, 0.005),
		},
		{
			type: "branch_summary",
			id: "b1",
			parentId: "k1",
			timestamp: "2026-09-05T12:00:13.000Z",
			fromId: "u1",
			summary: "branch",
			usage: usage(300, 20, 0, 0.002),
		},
		{
			type: "message",
			id: "m3",
			parentId: "k1",
			timestamp: "2026-09-06T01:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "zai",
				model,
				usage: usage(100, 10, 0, 0.001),
				stopReason: "error",
				errorMessage: "boom",
			},
		},
		{ type: "session_info", id: "n1", parentId: "m3", timestamp: "2026-09-06T01:00:01.000Z", name: "Auth fix" },
	];
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

test("parseSessionText aggregates tokens, cost, tools, compactions and errors", () => {
	const s = parseSessionText(sessionText(), "/x/s1.jsonl");
	assert.ok(s);
	assert.equal(s.project, "alpha");
	assert.equal(s.name, "Auth fix");
	assert.equal(s.firstPrompt, "fix the bug in auth");
	assert.equal(s.userMessages, 1);
	assert.equal(s.stats.turns, 3);
	assert.equal(s.stats.input, 1000 + 200 + 500 + 300 + 100);
	assert.equal(s.stats.cacheRead, 1800);
	assert.equal(s.stats.output, 50 + 40 + 100 + 20 + 10);
	assert.ok(Math.abs(s.stats.cost - 0.038) < 1e-9);
	assert.equal(s.stats.toolCalls, 2);
	assert.equal(s.stats.toolErrors, 1);
	assert.equal(s.stats.compactions, 1);
	assert.equal(s.stats.branchSummaries, 1);
	assert.equal(s.stats.errors, 1);
	assert.deepEqual(s.byTool, { read: { calls: 1, errors: 0 }, edit: { calls: 1, errors: 1 } });
	assert.deepEqual(Object.keys(s.byModel), ["zai/glm-5.3-flash"]);
	assert.equal(s.byModel["zai/glm-5.3-flash"].turns, 3);
	assert.equal(s.byModel["zai/glm-5.3-flash"].toolErrors, 1);
	// Расход компакции и итога ветки приписан модели: разрез по моделям сходится с итогом сессии.
	assert.equal(s.byModel["zai/glm-5.3-flash"].input, s.stats.input);
	assert.equal(s.byModel["zai/glm-5.3-flash"].compactions, 1);
	assert.equal(s.byModel["zai/glm-5.3-flash"].branchSummaries, 1);
	assert.ok(Math.abs(s.byModel["zai/glm-5.3-flash"].cost - s.stats.cost) < 1e-9);
	assert.equal(Object.keys(s.byDay).length, 2);
	assert.equal(s.startedAt, Date.parse("2026-09-05T12:00:00.000Z"));
	assert.equal(s.endedAt, Date.parse("2026-09-06T01:00:01.000Z"));
});

test("parseSessionText rejects files without a session header and tolerates broken lines", () => {
	assert.equal(parseSessionText('{"type":"message"}\n', "/x"), undefined);
	assert.equal(parseSessionText("", "/x"), undefined);
	const s = parseSessionText(`${sessionText()}not json\n{"type":"message","id":"z"}\n`, "/x");
	assert.ok(s);
	assert.equal(s.stats.turns, 3);
});

test("cachePercent, projectName, dayOf, periods", () => {
	const s = parseSessionText(sessionText(), "/x")!;
	assert.equal(cachePercent(s.stats), 46.2);
	assert.equal(projectName("C:\\A\\B\\"), "B");
	assert.equal(projectName("/home/u/proj"), "proj");
	assert.equal(dayOf(0), "unknown");
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	assert.equal(periodStart("all", now), 0);
	assert.equal(periodStart("7d", now), now - 7 * 86_400_000);
	assert.ok(periodStart("today", now) <= now);
	assert.ok(inPeriod(s, "7d", now));
	assert.ok(!inPeriod(s, "7d", now + 30 * 86_400_000));
	assert.ok(inPeriod(s, "all", now + 365 * 86_400_000));
});

test("buildLedger filters by period and project, groupRows groups correctly", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const a = parseSessionText(sessionText(), "/a")!;
	const b = parseSessionText(
		sessionText({ cwd: "/home/u/beta", start: "2026-07-01T00:00:00.000Z", model: "glm-5.2" }),
		"/b",
	)!;
	// b заканчивается 2026-09-06 (последняя запись), поэтому попадает в 7d несмотря на старый старт
	const ledger = buildLedger([a, b], "7d", { now });
	assert.equal(ledger.sessions.length, 2);
	assert.equal(ledger.total.turns, 6);
	assert.equal(ledger.total.sessions, 2);

	const byProject = groupRows(ledger, "project");
	assert.deepEqual(byProject.map((r) => r.key).sort(), ["alpha", "beta"]);
	assert.equal(byProject[0].stats.sessions, 1);

	const byModel = groupRows(ledger, "model");
	assert.deepEqual(byModel.map((r) => r.key).sort(), ["zai/glm-5.2", "zai/glm-5.3-flash"]);

	const byDay = groupRows(ledger, "day");
	assert.deepEqual(
		byDay.map((r) => r.key),
		["2026-09-05", "2026-09-06"],
	);
	assert.equal(byDay[0].stats.sessions, 2);

	const byTool = groupRows(ledger, "tool");
	assert.equal(byTool[0].stats.toolCalls, 2);
	assert.equal(byTool.find((r) => r.key === "edit")?.stats.toolErrors, 2);

	const bySession = groupRows(ledger, "session");
	assert.equal(bySession.length, 2);
	assert.ok(bySession[0].detail === "Auth fix");

	const onlyBeta = buildLedger([a, b], "all", { now, project: "BETA" });
	assert.equal(onlyBeta.sessions.length, 1);
	assert.equal(topSessions(onlyBeta)[0].project, "beta");
});

test("report renders tables and summary without throwing", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const a = parseSessionText(sessionText(), "/a")!;
	const ledger = buildLedger([a], "30d", { now, scanned: 3, skipped: 1 });
	for (const by of ["project", "model", "day", "tool", "session"] as const) {
		const lines = renderLedger(ledger, by, 100);
		assert.ok(lines.length > 4, by);
		assert.ok(lines[0].includes(`by ${by}`));
		assert.ok(lines.some((l) => l.includes("1 unreadable")));
	}
	const empty = renderLedger(buildLedger([], "today", { now }), "project", 80);
	assert.ok(empty.some((l) => l.includes("No sessions")));
	const table = renderTable(groupRows(ledger, "project"), "project", ledger.total, 100, {
		fg: (_c, t) => t,
		bold: (t) => `*${t}*`,
	});
	assert.ok(table.at(-1)?.startsWith("*total"));
	assert.equal(fmtTokens(1500), "1.50K");
	assert.equal(fmtCost(0), "$0");
	assert.equal(fmtCost(0.0042), "$0.0042");
	assert.equal(fmtCost(0.25), "$0.250");
	assert.equal(fmtCost(Math.PI), "$3.14");
	assert.ok(summaryLine(ledger).startsWith("30d: $0.038"));
	const sessionView = renderLedger(ledger, "session", 100);
	assert.ok(sessionView.some((l) => l.includes("Auth fix")));
});

test("parseArgs accepts period, group and project in any order", () => {
	assert.deepEqual(parseArgs(""), { period: "7d", by: "project" });
	assert.deepEqual(parseArgs("model all"), { period: "all", by: "model" });
	assert.deepEqual(parseArgs("today tool"), { period: "today", by: "tool" });
	assert.deepEqual(parseArgs("mediahub 30d"), { period: "30d", by: "project", project: "mediahub" });
});

test("nested-сплит: total = main + nested, строки атрибутируют nested точно", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const main = parseSessionText(sessionText(), "/x/main.jsonl")!;
	// Файл субагента: тот же проект, вложенный путь sessions/subagents/**
	const child = parseSessionText(sessionText(), "/x/subagents/2026-09-05_worker.jsonl")!;
	assert.equal(child.isNested, true);
	assert.equal(main.isNested, false);

	const ledger = buildLedger([main, child], "7d", { now, skipped: 2, scanned: 5 });
	assert.equal(ledger.invalidFiles, 2);
	assert.equal(ledger.nested.sessions, 1);
	// Инвариант total = main + nested по каждому числовому ключу Stats
	for (const key of Object.keys(ledger.total) as Array<keyof typeof ledger.total>) {
		assert.equal(ledger.main[key] + ledger.nested[key], ledger.total[key], key);
	}
	assert.ok(ledger.nested.input > 0);
	assert.ok(ledger.main.input > 0);
	assert.deepEqual(subtractStats(ledger.total, ledger.nested), ledger.main);

	const byProject = groupRows(ledger, "project");
	const row = byProject.find((r) => r.key === "alpha");
	assert.ok(row);
	assert.equal(row.nested.input, ledger.nested.input);
	assert.equal(promptTokens(row.stats) - promptTokens(row.nested), promptTokens(ledger.main));

	// Разрез по моделям/дням: у nested-файла все его byModel/byDay записи — nested
	const byModel = groupRows(ledger, "model");
	assert.deepEqual(
		byModel.map((r) => r.key),
		["zai/glm-5.3-flash"],
	);
	assert.equal(byModel[0].nested.turns, child.byModel["zai/glm-5.3-flash"].turns);
	const byDay = groupRows(ledger, "day");
	assert.ok(byDay.every((r) => r.nested.turns > 0));

	// Сессии: ключ — день+проект, поэтому два файла сливаются в одну строку; её nested — ровно вложенная часть
	const bySession = groupRows(ledger, "session");
	assert.equal(bySession.length, 1);
	assert.equal(bySession[0].nested.turns, child.stats.turns);
	assert.equal(bySession[0].stats.turns, main.stats.turns + child.stats.turns);
	assert.ok(bySession[0].nested.turns > 0);
});

test("hit-rate: нулевой знаменатель → null, fmtPercent → em-dash; формула — из сумм токенов", () => {
	assert.equal(cachePercent(emptyStats()), null);
	assert.equal(fmtPercent(null), "—");
	assert.equal(fmtPercent(cachePercent(emptyStats())), "—");
	const s = { ...emptyStats(), input: 100, cacheRead: 300, cacheWrite: 100 };
	assert.equal(cachePercent(s), 60);
	// Отличимо от en-dash (регрессия: раньше рендерился «–»)
	assert.notEqual(fmtPercent(null), "–");
});

test("bar: ширины, глифы ▁▂▃▄▅▆▇█, зажим и деградации", () => {
	assert.equal(bar(100, 100, 4), "████");
	assert.equal(bar(0, 100, 4), "    ");
	assert.equal(bar(45, 100, 8), "███▅    ");
	assert.equal(bar(10, 100, 8), "▆       ");
	assert.equal(bar(50, 100, 8), "████    ");
	assert.equal(bar(150, 100, 4), "████");
	assert.equal(bar(5, 0, 3), "   ");
	assert.equal(bar(5, -1, 3), "   ");
	assert.equal(bar(50, 100, 0), "");
	assert.equal(bar(Number.NaN, 100, 4), "    ");
	for (const w of [1, 5, 12]) assert.equal(bar(7, 100, w).length, w);
});

test("колонки main/nested/share: сумма строк сходится с total, guard на отсутствие токена темы", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const main = parseSessionText(sessionText(), "/x/main.jsonl")!;
	const child = parseSessionText(sessionText(), "/x/subagents/child.jsonl")!;
	const ledger = buildLedger([main, child], "7d", { now });
	const rows = groupRows(ledger, "project");

	// Тема без токена accent (Theme.fg бросает): бар и cache% рендерятся некрашеными, без исключения
	const throwingStyler = {
		fg: (c: string, t: string) => {
			if (c === "accent") throw new Error("Unknown theme color: accent");
			return t;
		},
		bold: (t: string) => t,
	};
	const totalRow = { key: "total", stats: ledger.total, nested: ledger.nested };
	const table = renderTable(rows, "project", totalRow, 140, throwingStyler);
	assert.ok(
		table.some((l) => /[▁-█]/.test(l)),
		"bar column rendered",
	);

	// plain-стилер: total-строка содержит main/nested и сходится с суммой строк
	const plain = renderTable(rows, "project", totalRow, 140, { fg: (_c, t) => t, bold: (t) => t });
	const totalLine = plain.at(-1)!;
	assert.ok(totalLine.startsWith("total"));
	// nested в total = сумма nested по строкам
	const nestedCol = plain[0].split(/\s{2,}/).indexOf("nested");
	assert.ok(nestedCol > 0, "nested column present");
	const rowNestedSum = rows.reduce((acc, r) => acc + promptTokens(r.nested), 0);
	assert.ok(totalLine.includes(fmtTokens(promptTokens(ledger.nested))));
	assert.equal(promptTokens(ledger.nested), rowNestedSum);
});

test("renderLedger/summaryLine: nested-брейкдаун и счётчики unknownUsage/invalidFiles", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const lines2 = [
		{ type: "session", version: 3, id: "su", timestamp: "2026-09-05T12:00:00.000Z", cwd: "C:\\Proj\\alpha" },
		{
			type: "message",
			id: "u1",
			timestamp: "2026-09-05T12:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "go" }] },
		},
		{
			type: "message",
			id: "a1",
			timestamp: "2026-09-05T12:00:02.000Z",
			message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", stopReason: "error", content: [] },
		},
	];
	const withUnknown = parseSessionText(`${lines2.map((l) => JSON.stringify(l)).join("\n")}\n`, "/x/u.jsonl")!;
	const ledger = buildLedger([withUnknown], "30d", { now, skipped: 3, scanned: 9 });
	assert.equal(ledger.total.unknownUsage, 1);
	assert.equal(ledger.invalidFiles, 3);

	const lines = renderLedger(ledger, "project", 140);
	assert.ok(lines.some((l) => l.includes("without usage")));
	assert.ok(lines.some((l) => l.includes("invalid/skipped")));
	assert.ok(lines.some((l) => l.includes("sessions/subagents")));
	assert.ok(lines.some((l) => l.includes("main") && l.includes("nested")));

	const line = summaryLine(ledger);
	assert.ok(line.includes("1 unknown usage"));
	assert.ok(line.includes("3 invalid files"));
	assert.ok(line.includes("cache — ·"));
});

test("totals-чипы (B8): с bg-стилером — ANSI-подложки на статусах, с plain — текст без падения", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const a = parseSessionText(sessionText(), "/a")!;
	const ledger = buildLedger([a], "30d", { now, scanned: 2, skipped: 0 });

	// Стилер с парой fg/bg (как Theme): totals-строка несёт bg-escape выбранных токенов
	const themed = renderLedger(ledger, "project", 200, {
		fg: (_c, t) => t,
		bold: (t) => t,
		bg: (_c, t) => t,
	});
	const totals = themed.find((l) => l.includes("Totals"));
	assert.ok(totals, "totals line present");
	// чип-паддинг вокруг метрик:
	assert.ok(totals.includes(" $"), "cost chip padded");
	assert.ok(/ cache \d+% | cache — /.test(totals), "cache chip padded");

	// Стилер с бросающим bg (нет токена): чип деградирует в fg-only, рендер не падает
	const throwing = renderLedger(ledger, "project", 200, {
		fg: (_c, t) => t,
		bold: (t) => t,
		bg: (c, _t) => {
			throw new Error(`Unknown theme background color: ${c}`);
		},
	});
	assert.ok(throwing.some((l) => l.includes("Totals")));

	// plainStyler (CLI): без bg-метода — чипы как обычный текст с паддингом
	const plain = renderLedger(ledger, "project", 200);
	const plainTotals = plain.find((l) => l.includes("Totals"));
	assert.ok(plainTotals?.includes("$"));
	assert.ok(plainTotals?.includes("errors"));
});

/** Матрица «малый терминал × тема» (автоматизация R9): ledger-отчёт через
 * ScrollReport (как /stats в оверлее) — totals-строка доживает в первом
 * вьюпорте, help с позицией n-m/total присутствует, крэшей и сырых JSON нет. */
for (const [rows, cols] of [
	[40, 100],
	[20, 60],
	[10, 25],
] as const) {
	test(`ledger через ScrollReport ${cols}x${rows} × 4 темы: Totals в первом вьюпорте, help с позицией`, () => {
		const now = Date.parse("2026-09-06T10:00:00.000Z");
		// 20 сессий: отчёт заведомо длиннее вьюпорта даже на 40 строках — иначе
		// ScrollReport честно не рисует позицию (всё и так видно).
		const sessions = Array.from(
			{ length: 20 },
			(_, i) => parseSessionText(sessionText({ cwd: `/home/u/proj-${i}` }), `/p${i}`)!,
		);
		const ledger = buildLedger(sessions, "7d", { now });
		for (const audit of loadAuditThemes()) {
			const tui = { requestRender() {}, terminal: { rows, columns: cols } } as unknown as TUI;
			const view = new ScrollReport({
				tui,
				theme: audit.theme,
				render: (width, th) => renderLedger(ledger, "project", width, th),
				onClose: () => {},
			});
			const out = view.render(cols);
			const viewport = out.slice(0, -1).join("\n");
			assert.ok(viewport.includes("Session ledger"), `${audit.name}/${audit.appearance}: заголовок отчёта`);
			assert.ok(
				viewport.includes("Totals"),
				`${audit.name}/${audit.appearance} @${cols}x${rows}: totals-строка дожила в первом вьюпорте`,
			);
			const help = out.at(-1) as string;
			assert.match(help, /\d+-\d+\/\d+/, `${audit.name}/${audit.appearance}: help с позицией`);
			assert.ok(!out.join("\n").includes('{"error"'), "сырой JSON в рендере");
		}
	});
}
