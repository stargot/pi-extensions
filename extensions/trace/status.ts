/**
 * Строка состояния trace над редактором pi (/trace on|off). Модель —
 * deriveSession ядра по записям SessionManager; живое состояние агента
 * (генерация, идущий инструмент) приходит из событий pi, потому что
 * в файл ход попадает только по message_end.
 *
 * Включённость хранится глобально в <agentDir>/trace.json:
 * { "statusLine": boolean }; файла нет или он битый — строка включена.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheHit, promptTokens, type SessionView } from "./core/model.ts";
import { fmtDur, fmtK, fmtMoney, oneLine } from "./core/text.ts";

export type StatusColor = "accent" | "muted" | "dim" | "success" | "error" | "warning";
export type Fg = (color: StatusColor, text: string) => string;

/** Живое состояние агента из событий pi. */
export interface LiveState {
	/** Агент между agent_start и agent_end. */
	busy: boolean;
	/** Начало текущего запроса к модели (turn_start). */
	turnStartMs?: number;
	/** Идущий инструмент (tool_execution_start → _end). */
	tool?: { name: string; label: string; startMs: number };
	/** Живые task_batch-воркеры (глобальный индекс subagents). */
	workers: number;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(nowMs: number): string {
	return SPIN[Math.floor(nowMs / 100) % SPIN.length]!;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Одна строка: состояние · промпт и cache hit · стоимость · воркеры. */
export function renderStatusLine(v: SessionView, live: LiveState, nowMs: number, fg: Fg): string {
	const sep = fg("dim", " · ");
	const last = v.turns.at(-1);
	const parts: string[] = [];

	if (live.busy) {
		const n = (last?.index ?? 0) + (live.tool ? 0 : 1);
		const head = `${fg("accent", "◐")} T${n}`;
		if (live.tool) {
			const t = live.tool;
			parts.push(
				`${head} ${fg("accent", `⚒ ${t.name}`)}${t.label ? ` ${oneLine(t.label, 36)}` : ""} ${fmtDur(nowMs - t.startMs)} ${fg("accent", spinner(nowMs))}`,
			);
		} else {
			const since = live.turnStartMs !== undefined ? ` ${fmtDur(nowMs - live.turnStartMs)}` : "";
			parts.push(`${head} ${fg("muted", "генерация")}${since} ${fg("accent", spinner(nowMs))}`);
		}
	} else if (last) {
		const era = v.eras.at(-1);
		const took = era ? fmtDur(Math.max(0, era.endMs - era.startMs)) : "";
		const failed = last.stopReason === "error";
		parts.push(
			`${fg(failed ? "error" : "muted", "◐")} ${fg("muted", `T${last.index} · ${failed ? "ошибка" : "готово"}${took ? ` за ${took}` : ""}${era ? ` · ↓${fmtK(era.tokensOut)}` : ""}`)}`,
		);
	} else {
		parts.push(`${fg("muted", "◐")} ${fg("muted", "trace · ходов пока нет")}`);
	}

	if (last) {
		const hit = cacheHit(last.tokens);
		// Компакция после последнего хода или холодный хит на нём — кэш прогреется со следующего.
		const compacted = v.markers.some((m) => m.kind === "compaction" && m.ts >= last.startMs);
		const cold = compacted || (hit !== null && hit < 0.4);
		const hitText = hit === null ? "" : ` ${fg(cold ? "warning" : "accent", `hit ${pct(hit)}${cold ? " ↻" : ""}`)}`;
		parts.push(`↑${fmtK(promptTokens(last.tokens))}${hitText}`);
	}
	const cost = fmtMoney(v.totals.cost);
	if (cost) parts.push(cost);
	if (live.workers > 0) parts.push(fg("accent", `${live.workers} воркер${live.workers === 1 ? "" : "а"} ●`));
	if (!live.busy && v.time.spanMs > 0) {
		parts.push(
			fg("dim", `модель ${pct(v.time.modelMs / v.time.spanMs)} · инстр. ${pct(v.time.toolsMs / v.time.spanMs)}`),
		);
	}
	return parts.join(sep);
}

// ---------- включённость ----------

export function statusPrefPath(agentDir: string): string {
	return join(agentDir, "trace.json");
}

export function readStatusPref(agentDir: string): boolean {
	try {
		const data = JSON.parse(readFileSync(statusPrefPath(agentDir), "utf8"));
		return data?.statusLine !== false;
	} catch {
		return true;
	}
}

export function writeStatusPref(agentDir: string, on: boolean): void {
	const file = statusPrefPath(agentDir);
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(file, "utf8")) ?? {};
	} catch {
		// нет файла — создаём
	}
	writeFileSync(file, `${JSON.stringify({ ...data, statusLine: on }, null, 2)}\n`);
}
