/**
 * session-ledger: разбор JSONL-сессий pi и агрегаты по проектам, моделям, дням и инструментам.
 *
 * Чистый модуль без runtime-зависимостей от pi: работает и в расширении, и в CLI, и в тестах.
 * Считает все записи файла независимо от ветки дерева: деньги потрачены на каждую.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { discoverSessionFiles } from "../shared/sessions.ts";
import { dayOf, emptyStats, parseSessionCombined, type SessionSummary, type Stats } from "../shared/session-index.ts";

// Ре-экспорт: /stats-расширение и CLI импортируют discovery отсюда (исторически).
export { discoverSessionFiles };

// Канонические типы живут в shared/session-index.ts — ре-экспорт для совместимости.
export type { Stats, ToolStats, SessionSummary } from "../shared/session-index.ts";
export { dayOf, emptyStats, projectName } from "../shared/session-index.ts";

export type GroupKey = "project" | "model" | "day" | "tool" | "session";
export type Period = "today" | "yesterday" | "7d" | "30d" | "all";

export interface Row {
	key: string;
	/** Комбинированный расход строки: main + nested (как раньше — существующие колонки не меняют смысл). */
	stats: Stats;
	/** Nested-часть (субагентские сессии sessions/subagents/**); main = stats − nested. */
	nested: Stats;
	detail?: string;
}

export interface Ledger {
	period: Period;
	since: number;
	sessions: SessionSummary[];
	scanned: number;
	skipped: number;
	/** Невалидные/непарсящиеся файлы (= skipped): файлы без заголовка сессии или с ошибкой чтения. */
	invalidFiles: number;
	/** main + nested — комбинированный итог (обратная совместимость: совпадает со старым total). */
	total: Stats;
	/** main-часть: total − nested (вычитание точное, nested ⊆ total). */
	main: Stats;
	/** Nested-часть: сумма summary.nested по сессиям периода (usage сессий subagents/**). */
	nested: Stats;
}

export const PERIODS: Period[] = ["today", "yesterday", "7d", "30d", "all"];
export const GROUPS: GroupKey[] = ["project", "model", "day", "tool", "session"];

export interface StatsArgs {
	period: Period;
	by: GroupKey;
	project?: string;
}

/** Аргументы `/stats` и CLI в любом порядке: период, группа, всё остальное — фильтр проекта. */
export function parseArgs(args: string): StatsArgs {
	const result: StatsArgs = { period: "7d", by: "project" };
	for (const token of args.split(/\s+/).filter(Boolean)) {
		const lower = token.toLowerCase();
		if ((PERIODS as string[]).includes(lower)) result.period = lower as Period;
		else if ((GROUPS as string[]).includes(lower)) result.by = lower as GroupKey;
		else result.project = token;
	}
	return result;
}

export function addStats(target: Stats, source: Stats): Stats {
	for (const key of Object.keys(target) as Array<keyof Stats>) target[key] += source[key];
	return target;
}

export function promptTokens(s: Stats): number {
	return s.input + s.cacheRead + s.cacheWrite;
}

/**
 * Hit-rate кэша в процентах: cacheRead / (input + cacheRead + cacheWrite), null при нулевом
 * знаменателе (fmtPercent рендерит его как «—»).
 *
 * pi-forge-совместимая формула (MacroSony/pi-forge `src/session-usage.ts`, MIT: `cacheHitRate`):
 * считается из СУММ токенов (агрегация суммированием, не средним процентов), поэтому hit-rate
 * любой группы всегда согласован с её же токенами.
 */
export function cachePercent(s: Stats): number | null {
	const prompt = promptTokens(s);
	return prompt > 0 ? Math.round((s.cacheRead / prompt) * 1000) / 10 : null;
}

/** main-часть: total − nested по всем числовым ключам Stats (nested ⊆ total, вычитание точное). */
export function subtractStats(total: Stats, nested: Stats): Stats {
	const result = emptyStats();
	for (const key of Object.keys(result) as Array<keyof Stats>) result[key] = total[key] - nested[key];
	return result;
}

export function parseSessionText(text: string, file: string): SessionSummary | undefined {
	// Обёртка над единым парсером (shared/session-index.ts) — совместимость с тестами.
	return parseSessionCombined(text, file)?.summary;
}

export function loadSessions(files: string[]): { sessions: SessionSummary[]; skipped: number } {
	const sessions: SessionSummary[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const summary = parseSessionText(readFileSync(file, "utf8"), file);
			if (summary) sessions.push(summary);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { sessions, skipped };
}

export function periodStart(period: Period, now = Date.now()): number {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	switch (period) {
		case "today":
			return startOfToday.getTime();
		case "yesterday":
			return startOfToday.getTime() - 86_400_000;
		case "7d":
			return now - 7 * 86_400_000;
		case "30d":
			return now - 30 * 86_400_000;
		case "all":
			return 0;
	}
}

/** Сессия попадает в период, если хоть одна её запись сделана после `since`. Для "yesterday" — строго вчера. */
export function inPeriod(session: SessionSummary, period: Period, now = Date.now()): boolean {
	const since = periodStart(period, now);
	if (period === "yesterday") {
		const end = periodStart("today", now);
		return session.endedAt >= since && session.startedAt < end;
	}
	return session.endedAt >= since;
}

export function buildLedger(
	all: SessionSummary[],
	period: Period,
	options: { scanned?: number; skipped?: number; now?: number; project?: string } = {},
): Ledger {
	const now = options.now ?? Date.now();
	const needle = options.project?.toLowerCase();
	const sessions = all.filter(
		(s) =>
			inPeriod(s, period, now) &&
			(!needle || s.project.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)),
	);
	const total = emptyStats();
	const nested = emptyStats();
	for (const s of sessions) {
		addStats(total, s.stats);
		addStats(nested, s.nested);
	}
	const skipped = options.skipped ?? 0;
	return {
		period,
		since: periodStart(period, now),
		sessions,
		scanned: options.scanned ?? all.length,
		skipped,
		invalidFiles: skipped,
		total,
		main: subtractStats(total, nested),
		nested,
	};
}

export function groupRows(ledger: Ledger, by: GroupKey): Row[] {
	const rows = new Map<string, Row>();
	const rowFor = (key: string, detail?: string) => {
		let row = rows.get(key);
		if (!row) {
			row = { key, stats: emptyStats(), nested: emptyStats(), detail };
			rows.set(key, row);
		}
		return row;
	};

	for (const s of ledger.sessions) {
		switch (by) {
			case "project":
				// Атрибуция nested точная: у nested-файла (субагента) весь расход — nested.
				addStats(rowFor(s.project, s.cwd).stats, s.stats);
				addStats(rowFor(s.project, s.cwd).nested, s.nested);
				break;
			case "model":
				for (const [model, stats] of Object.entries(s.byModel)) {
					const row = rowFor(model);
					addStats(row.stats, stats);
					if (s.isNested) addStats(row.nested, stats);
				}
				break;
			case "day":
				for (const [day, stats] of Object.entries(s.byDay)) {
					const row = rowFor(day);
					addStats(row.stats, stats);
					if (s.isNested) addStats(row.nested, stats);
				}
				break;
			case "tool":
				for (const [tool, t] of Object.entries(s.byTool)) {
					const row = rowFor(tool);
					row.stats.toolCalls += t.calls;
					row.stats.toolErrors += t.errors;
					row.stats.sessions += 1;
					if (s.isNested) {
						row.nested.toolCalls += t.calls;
						row.nested.toolErrors += t.errors;
						row.nested.sessions += 1;
					}
				}
				break;
			case "session": {
				const label = s.name ?? s.firstPrompt ?? basename(s.file);
				const row = rowFor(`${dayOf(s.startedAt)} ${s.project}`, label);
				addStats(row.stats, s.stats);
				addStats(row.nested, s.nested);
				break;
			}
		}
	}

	const list = [...rows.values()];
	if (by === "day") return list.sort((a, b) => a.key.localeCompare(b.key));
	if (by === "tool") return list.sort((a, b) => b.stats.toolCalls - a.stats.toolCalls);
	return list.sort((a, b) => b.stats.cost - a.stats.cost || b.stats.turns - a.stats.turns);
}

export function topSessions(ledger: Ledger, limit = 5): SessionSummary[] {
	return [...ledger.sessions]
		.sort((a, b) => b.stats.cost - a.stats.cost || b.stats.turns - a.stats.turns)
		.slice(0, limit);
}
