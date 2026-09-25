/**
 * session-ledger: разбор JSONL-сессий pi и агрегаты по проектам, моделям, дням и инструментам.
 *
 * Чистый модуль без runtime-зависимостей от pi: работает и в расширении, и в CLI, и в тестах.
 * Считает все записи файла независимо от ветки дерева: деньги потрачены на каждую.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { discoverSessionFiles } from "../shared/sessions.ts";
import { dayOf, parseSessionCombined, type SessionSummary, type Stats } from "../shared/session-index.ts";

// Ре-экспорт: /stats-расширение и CLI импортируют discovery отсюда (исторически).
export { discoverSessionFiles };

// Канонические типы живут в shared/session-index.ts — ре-экспорт для совместимости.
export type { Stats, ToolStats, SessionSummary } from "../shared/session-index.ts";
export { dayOf, projectName } from "../shared/session-index.ts";

export type GroupKey = "project" | "model" | "day" | "tool" | "session";
export type Period = "today" | "yesterday" | "7d" | "30d" | "all";

export interface Row {
	key: string;
	stats: Stats;
	detail?: string;
}

export interface Ledger {
	period: Period;
	since: number;
	sessions: SessionSummary[];
	scanned: number;
	skipped: number;
	total: Stats;
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

export function emptyStats(): Stats {
	return {
		sessions: 0,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		toolCalls: 0,
		toolErrors: 0,
		compactions: 0,
		branchSummaries: 0,
		errors: 0,
		aborted: 0,
	};
}

export function addStats(target: Stats, source: Stats): Stats {
	for (const key of Object.keys(target) as Array<keyof Stats>) target[key] += source[key];
	return target;
}

export function promptTokens(s: Stats): number {
	return s.input + s.cacheRead + s.cacheWrite;
}

export function cachePercent(s: Stats): number | null {
	const prompt = promptTokens(s);
	return prompt > 0 ? Math.round((s.cacheRead / prompt) * 1000) / 10 : null;
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

export function buildLedger(all: SessionSummary[], period: Period, options: { scanned?: number; skipped?: number; now?: number; project?: string } = {}): Ledger {
	const now = options.now ?? Date.now();
	const needle = options.project?.toLowerCase();
	const sessions = all.filter(
		(s) => inPeriod(s, period, now) && (!needle || s.project.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)),
	);
	const total = emptyStats();
	for (const s of sessions) addStats(total, s.stats);
	return { period, since: periodStart(period, now), sessions, scanned: options.scanned ?? all.length, skipped: options.skipped ?? 0, total };
}

export function groupRows(ledger: Ledger, by: GroupKey): Row[] {
	const rows = new Map<string, Row>();
	const rowFor = (key: string, detail?: string) => {
		let row = rows.get(key);
		if (!row) {
			row = { key, stats: emptyStats(), detail };
			rows.set(key, row);
		}
		return row;
	};

	for (const s of ledger.sessions) {
		switch (by) {
			case "project":
				addStats(rowFor(s.project, s.cwd).stats, s.stats);
				break;
			case "model":
				for (const [model, stats] of Object.entries(s.byModel)) addStats(rowFor(model).stats, stats);
				break;
			case "day":
				for (const [day, stats] of Object.entries(s.byDay)) addStats(rowFor(day).stats, stats);
				break;
			case "tool":
				for (const [tool, t] of Object.entries(s.byTool)) {
					const row = rowFor(tool);
					row.stats.toolCalls += t.calls;
					row.stats.toolErrors += t.errors;
					row.stats.sessions += 1;
				}
				break;
			case "session": {
				const label = s.name ?? s.firstPrompt ?? basename(s.file);
				addStats(rowFor(`${dayOf(s.startedAt)} ${s.project}`, label).stats, s.stats);
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
	return [...ledger.sessions].sort((a, b) => b.stats.cost - a.stats.cost || b.stats.turns - a.stats.turns).slice(0, limit);
}
