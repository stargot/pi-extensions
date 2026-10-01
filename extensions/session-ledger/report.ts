/**
 * session-ledger: табличный отчёт из Ledger. Стилизация через минимальный интерфейс, совместимый с Theme.
 */
import {
	cachePercent,
	emptyStats,
	type GroupKey,
	groupRows,
	type Ledger,
	promptTokens,
	type Row,
	type Stats,
	topSessions,
	dayOf,
} from "./ledger.ts";
import { chip } from "../shared/chip.ts";

export type Color = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text" | "toolTitle" | "borderMuted";

export interface Styler {
	fg(color: Color, text: string): string;
	/** B8: опциональная подложка (есть у Theme, нет у CLI plainStyler — чип деградирует в fg-only). */
	bg?(color: string, text: string): string;
	bold(text: string): string;
}

export const plainStyler: Styler = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

export function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(2)}K`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function fmtPercent(n: number | null): string {
	// Em-dash (U+2014), не en-dash: «—» = «нет данных» (нулевой знаменатель hit-rate).
	return n === null ? "—" : `${Math.round(n)}%`;
}

/** Блочные глифы бара: индекс = уровень заполненности клетки (0 — пробел). */
const BAR_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Бар относительной величины value/max шириной `width` через блочные глифы ▁▂▃▄▅▆▇█:
 * заполненные клетки — █, граничная — частичный глиф, пустые — пробелы (моноширинно).
 * Длина всегда width; value > max зажимается; max <= 0 или value <= 0 — пустой бар.
 */
export function bar(value: number, max: number, width: number): string {
	const cells = Math.max(0, Math.floor(width));
	if (cells === 0) return "";
	if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return " ".repeat(cells);
	const top = BAR_GLYPHS.length - 1;
	const units = Math.round(Math.min(1, value / max) * cells * top);
	let out = "";
	for (let i = 0; i < cells; i++) {
		const level = Math.max(0, Math.min(top, units - i * top));
		out += BAR_GLYPHS[level];
	}
	return out;
}

/**
 * fg с guard'ом на отсутствие токена в теме: Theme.fg бросает на неизвестном токене —
 * откатываемся к некрашеному тексту (бар обязан рендериться в любой теме).
 */
function safeFg(st: Styler, color: Color, text: string): string {
	try {
		return st.fg(color, text);
	} catch {
		return text;
	}
}

interface Column {
	title: string;
	align: "left" | "right";
	value: (row: Row) => string;
	color?: (row: Row) => Color | undefined;
}

function errorRate(s: Stats): number | null {
	return s.toolCalls > 0 ? Math.round((s.toolErrors / s.toolCalls) * 1000) / 10 : null;
}

/** main-часть промпт-токенов строки: комбинированный Stats минус его nested-часть (nested ⊆ stats). */
function mainPromptTokens(r: Row): number {
	return promptTokens(r.stats) - promptTokens(r.nested);
}

/** Ширина бара в колонке share (таблицы by-project/by-model). */
const BAR_WIDTH = 8;

function columnsFor(by: GroupKey, maxPrompt: number): Column[] {
	const name: Column = { title: by, align: "left", value: (r) => r.key };
	if (by === "tool") {
		return [
			name,
			{ title: "calls", align: "right", value: (r) => String(r.stats.toolCalls) },
			{ title: "errors", align: "right", value: (r) => String(r.stats.toolErrors) },
			{
				title: "err%",
				align: "right",
				value: (r) => fmtPercent(errorRate(r.stats)),
				color: (r) =>
					(errorRate(r.stats) ?? 0) >= 20 ? "error" : (errorRate(r.stats) ?? 0) >= 10 ? "warning" : undefined,
			},
			{ title: "sessions", align: "right", value: (r) => String(r.stats.sessions) },
		];
	}
	const columns: Column[] = [
		name,
		{ title: "sess", align: "right", value: (r) => String(r.stats.sessions) },
		{ title: "turns", align: "right", value: (r) => String(r.stats.turns) },
		{ title: "in", align: "right", value: (r) => fmtTokens(r.stats.input) },
		{ title: "main", align: "right", value: (r) => fmtTokens(mainPromptTokens(r)) },
		{ title: "nested", align: "right", value: (r) => fmtTokens(promptTokens(r.nested)) },
		{ title: "cache", align: "right", value: (r) => fmtTokens(r.stats.cacheRead) },
		{
			// Hit-rate кэша: pi-forge-совместимая формула из сумм токенов (см. cachePercent в ledger.ts).
			title: "cache%",
			align: "right",
			value: (r) => fmtPercent(cachePercent(r.stats)),
			color: (r) => {
				const c = cachePercent(r.stats);
				return c === null ? undefined : c >= 70 ? "success" : c < 30 ? "warning" : undefined;
			},
		},
		{ title: "out", align: "right", value: (r) => fmtTokens(r.stats.output) },
		{ title: "cost", align: "right", value: (r) => fmtCost(r.stats.cost) },
	];
	// Бар относительной величины (доля промпт-токенов от максимума по строкам) — только
	// в by-project/by-model таблицах; цвет — accent через guard (safeFg в renderTable).
	if (by === "project" || by === "model") {
		columns.push({
			title: "share",
			align: "left",
			value: (r) => bar(promptTokens(r.stats), maxPrompt, BAR_WIDTH),
			color: () => "accent",
		});
	}
	columns.push(
		{ title: "tools", align: "right", value: (r) => String(r.stats.toolCalls) },
		{
			title: "err%",
			align: "right",
			value: (r) => fmtPercent(errorRate(r.stats)),
			color: (r) =>
				(errorRate(r.stats) ?? 0) >= 20 ? "error" : (errorRate(r.stats) ?? 0) >= 10 ? "warning" : undefined,
		},
		{ title: "compact", align: "right", value: (r) => String(r.stats.compactions) },
	);
	return columns;
}

export function renderTable(
	rows: Row[],
	by: GroupKey,
	total: Stats | Row | undefined,
	width: number,
	st: Styler,
): string[] {
	const maxPrompt = Math.max(0, ...rows.map((r) => promptTokens(r.stats)));
	const columns = columnsFor(by, maxPrompt);
	const totalRow: Row | undefined = total
		? "nested" in total
			? (total as Row)
			: { key: "total", stats: total, nested: emptyStats() }
		: undefined;
	const allRows = totalRow ? [...rows, totalRow] : rows;
	const widths = columns.map((c, i) => {
		const cells = allRows.map((r) => c.value(r).length);
		const max = Math.max(c.title.length, ...cells);
		// Первая колонка (имя) может быть длинной; остальные фиксируем по содержимому.
		// Бюджет под фиксированные колонки зависит от таблицы (у non-tool их больше из-за main/nested/share).
		const budget = by === "tool" ? 70 : 100;
		return i === 0 ? Math.min(max, Math.max(12, width - budget)) : max;
	});

	const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

	const cell = (c: Column, i: number, text: string) => {
		const clipped = text.length > widths[i] ? `${text.slice(0, widths[i] - 1)}…` : text;
		return c.align === "left" ? clipped.padEnd(widths[i]) : clipped.padStart(widths[i]);
	};

	const lines: string[] = [];
	lines.push(st.fg("muted", columns.map((c, i) => cell(c, i, c.title)).join("  ")));
	lines.push(st.fg("borderMuted", widths.map((w) => "─".repeat(w)).join("  ")));
	for (const row of rows) {
		lines.push(
			columns
				.map((c, i) => {
					const text = cell(c, i, c.value(row));
					if (i === 0) return st.fg("toolTitle", text);
					const color = c.color?.(row);
					return color ? safeFg(st, color, text) : text;
				})
				.join("  "),
		);
		// Имя сессии или первый промпт не влезает в колонку, поэтому отдельной строкой под строкой сессии.
		if (by === "session" && row.detail) lines.push(st.fg("dim", `  ${clip(row.detail, Math.max(20, width - 2))}`));
	}
	if (totalRow) {
		lines.push(st.fg("borderMuted", widths.map((w) => "─".repeat(w)).join("  ")));
		lines.push(st.bold(columns.map((c, i) => cell(c, i, i === 0 ? "total" : c.value(totalRow))).join("  ")));
	}
	return lines;
}

export function renderLedger(
	ledger: Ledger,
	by: GroupKey,
	width: number,
	st: Styler = plainStyler,
	options: { top?: number } = {},
): string[] {
	const lines: string[] = [];
	const dim = (t: string) => st.fg("dim", t);
	const muted = (t: string) => st.fg("muted", t);
	const t = ledger.total;
	const n = ledger.nested;

	const nestedSessions = n.sessions;
	const since = ledger.since > 0 ? `since ${dayOf(ledger.since)}` : "all time";
	lines.push(
		`${st.bold(st.fg("accent", " Session ledger"))}  ${muted(`${ledger.period} (${since}) · by ${by}`)}  ${dim(`${ledger.sessions.length} of ${ledger.scanned} sessions${nestedSessions ? ` (${nestedSessions} nested)` : ""}${ledger.skipped ? `, ${ledger.skipped} unreadable` : ""}`)}`,
	);
	lines.push(st.fg("borderMuted", "─".repeat(Math.min(width, 110))));
	const promptTotal = promptTokens(t);
	const nestedPrompt = promptTokens(n);
	// B8: bg-чипы на статусных метриках totals-строки. Токены — из ThemeBg pi-coding-agent
	// (docs/themes.md): customMessageBg/toolSuccessBg/toolPendingBg/toolErrorBg. Guard:
	// chip() деградирует до fg-only, если у стайлера нет bg (CLI plainStyler) или токена
	// нет в теме (Theme.bg бросает).
	const cachePct = cachePercent(t);
	const cacheChip =
		cachePct === null
			? `cache ${fmtPercent(null)}`
			: chip(
					st,
					`cache ${fmtPercent(cachePct)}`,
					cachePct >= 70
						? { fg: "success", bg: "toolSuccessBg" }
						: cachePct < 30
							? { fg: "warning", bg: "toolPendingBg" }
							: { fg: "muted" },
				);
	const errorsChip =
		t.toolErrors > 0
			? chip(st, `${t.toolErrors} errors`, { fg: "error", bg: "toolErrorBg" })
			: `${t.toolErrors} errors`;
	lines.push(
		`${muted("Totals")}  ${st.bold(chip(st, fmtCost(t.cost), { fg: "accent", bg: "customMessageBg" }))} · ${t.turns} turns · prompt ${fmtTokens(promptTotal)} (main ${fmtTokens(promptTotal - nestedPrompt)} · nested ${fmtTokens(nestedPrompt)} · ${cacheChip}) · output ${fmtTokens(t.output)} · ${t.toolCalls} tool calls (${errorsChip}) · ${t.compactions} compactions${t.branchSummaries ? ` · ${t.branchSummaries} branch summaries` : ""}${t.errors ? ` · ${t.errors} LLM errors` : ""}${t.aborted ? ` · ${t.aborted} aborted` : ""}`,
	);
	lines.push("");

	const rows = groupRows(ledger, by);
	if (rows.length === 0) {
		lines.push(dim("No sessions in this period."));
		return lines;
	}
	lines.push(
		...renderTable(
			rows,
			by,
			by === "tool" || by === "session" ? undefined : { key: "total", stats: t, nested: n },
			width,
			st,
		),
	);

	if (by !== "session") {
		const top = topSessions(ledger, options.top ?? 5);
		if (top.length > 0) {
			lines.push("");
			lines.push(muted(`Most expensive sessions`));
			for (const s of top) {
				const label = s.name ?? s.firstPrompt ?? "(no prompt)";
				lines.push(
					`  ${fmtCost(s.stats.cost).padStart(8)}  ${dim(dayOf(s.startedAt))}  ${st.fg("toolTitle", s.project.padEnd(18).slice(0, 18))}  ${String(s.stats.turns).padStart(3)} turns  ${dim(label)}`,
				);
			}
		}
	}
	lines.push("");
	lines.push(
		dim(
			"Cost comes from pi's per-message usage.cost; models without pricing show $0. Sessions count in a period if any entry falls into it.",
		),
	);
	// Счётчики честности: вложенные запросы без usage и битые файлы; nested = субагентские сессии.
	const counters: string[] = ["nested = subagent sessions under sessions/subagents/**"];
	if (t.unknownUsage) counters.push(`${t.unknownUsage} assistant messages without usage`);
	if (ledger.invalidFiles) counters.push(`${ledger.invalidFiles}/${ledger.scanned} files invalid/skipped`);
	lines.push(dim(`Counters: ${counters.join(" · ")}.`));
	return lines;
}

export function summaryLine(ledger: Ledger): string {
	const t = ledger.total;
	const nestedPrompt = promptTokens(ledger.nested);
	let line = `${ledger.period}: ${fmtCost(t.cost)} · ${ledger.sessions.length} sessions · ${t.turns} turns · cache ${fmtPercent(cachePercent(t))} · ${t.toolErrors}/${t.toolCalls} tool errors`;
	if (nestedPrompt > 0) line += ` · nested ${fmtTokens(nestedPrompt)}`;
	if (t.unknownUsage > 0) line += ` · ${t.unknownUsage} unknown usage`;
	if (ledger.invalidFiles > 0) line += ` · ${ledger.invalidFiles} invalid files`;
	return line;
}
