/**
 * Rolling-история ходов для контекст-диффа в session-trace (B6).
 *
 * Референс модели — pi-forge (MIT): src/context-diff-history.ts / context-diff.ts,
 * адаптированный под JSONL-поток session.ts:
 * - вместо блоков provider-payload — подписи сообщений контекста
 *   («роль + первые ~80 символов», makeSignature);
 * - вместо chars/4-оценки — реальные usage из assistant-сообщения
 *   (input + cacheRead + cacheWrite = промпт-токены запроса);
 * - prefixRatio — по формуле из backlog: |общий префикс подписей| / |текущих|;
 *   prefixTokens — грубая chars/4-оценка общего префикса (как в pi-forge).
 *
 * Модуль чистый: без Node/DOM API, без зависимостей. Diff строк (diffLines) —
 * в shared/line-diff.ts, этот файл поставляет снимки и метрики для него.
 */

/** Ёмкость кольцевого буфера: храним последние N ходов. */
export const CONTEXT_HISTORY_LIMIT = 20;

/** Бюджет подписи сообщения: роль + первые ~80 символов. */
export const SIGNATURE_MAX = 80;

export interface TurnTokens {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

/** Снимок состояния контекста на момент ответа модели. */
export interface TurnSnapshot {
	turnIndex: number;
	ts: number;
	model?: string;
	tokens: TurnTokens;
	/** Подписи сообщений контекста по порядку: «роль: первые ~80 символов». */
	messageSignature: string[];
}

export interface TurnDiffSummary {
	same: number;
	added: number;
	removed: number;
	modified: number;
	/** added + removed + modified — блоки, изменившиеся относительно предыдущего хода. */
	changedBlocks: number;
}

export interface TurnDiff {
	/** Промпт-токены текущего хода (input + cacheRead + cacheWrite). */
	promptTokens: number;
	/** Промпт-токены текущего хода минус предыдущего. */
	deltaTokens: number;
	/** Длина общего префикса подписей (блоков, переиспользуемых из кэша). */
	prefixSignatures: number;
	/** |общий префикс подписей| / |текущих|; 1 для пустого контекста, 0 без предыдущего хода. */
	prefixRatio: number;
	/** ~токены общего префикса (chars/4, как в pi-forge). */
	prefixTokens: number;
	summary: TurnDiffSummary;
}

/** Подпись сообщения: «роль: текст», пробелы схлопнуты, хвост — до max символов с «…». */
export function makeSignature(role: string, text: unknown, max: number = SIGNATURE_MAX): string {
	const t = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const clipped = t.length > max ? `${t.slice(0, max - 1)}…` : t;
	return `${role}: ${clipped}`;
}

/** Промпт-токены запроса: весь нетто-вход модели, включая кэш. */
export function promptTokens(t: TurnTokens): number {
	return (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
}

/**
 * Реальный cache hit-rate хода: cacheRead / промпт. null — модель/провайдер не
 * репортит кэш (нет ни cacheRead, ни cacheWrite) — как cacheStatus в pi-forge.
 */
export function cacheHitRatio(t: TurnTokens): number | null {
	const reported = (t.cacheRead ?? 0) > 0 || (t.cacheWrite ?? 0) > 0;
	const prompt = promptTokens(t);
	return reported && prompt > 0 ? (t.cacheRead ?? 0) / prompt : null;
}

export type CacheLevel = "warm" | "partial" | "cold";

/** Уровень переиспользования контекста: ≥0.7 — тёплый кэш, ≥0.4 — частичный, ниже — холодный. */
export function cacheLevel(prefixRatio: number): CacheLevel {
	if (prefixRatio >= 0.7) return "warm";
	if (prefixRatio >= 0.4) return "partial";
	return "cold";
}

/** Нулевой дифф (нет предыдущего хода или нечего сравнивать по метрикам). */
export function zeroDiff(curr: TurnSnapshot): TurnDiff {
	const allAdded = curr.messageSignature.length;
	return {
		promptTokens: promptTokens(curr.tokens),
		deltaTokens: 0,
		prefixSignatures: 0,
		prefixRatio: 0,
		prefixTokens: 0,
		summary: { same: 0, added: allAdded, removed: 0, modified: 0, changedBlocks: allAdded },
	};
}

/**
 * Дифф двух соседних ходов — упрощённый prefix-walk из pi-forge:
 * общий префикс подписей считается переиспользуемым (попадание в KV-кэш),
 * хвост после границы сравнивается позиционно (same/modified/added/removed).
 */
export function diffTurns(prev: TurnSnapshot | undefined, curr: TurnSnapshot): TurnDiff {
	const before = prev?.messageSignature ?? [];
	const after = curr.messageSignature;

	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

	let same = prefix;
	let added = 0;
	let removed = 0;
	let modified = 0;
	const tail = Math.max(before.length, after.length);
	for (let i = prefix; i < tail; i++) {
		const b = before[i];
		const a = after[i];
		if (b === undefined) added++;
		else if (a === undefined) removed++;
		else if (b === a) same++;
		else modified++;
	}

	let prefixChars = 0;
	for (let i = 0; i < prefix; i++) prefixChars += after[i]!.length;

	const prompt = promptTokens(curr.tokens);
	const prevPrompt = prev ? promptTokens(prev.tokens) : 0;
	return {
		promptTokens: prompt,
		deltaTokens: prompt - prevPrompt,
		prefixSignatures: prefix,
		prefixRatio: after.length === 0 ? 1 : prefix / after.length,
		prefixTokens: Math.floor(prefixChars / 4),
		summary: { same, added, removed, modified, changedBlocks: added + removed + modified },
	};
}

/**
 * Кольцевый буфер последних CONTEXT_HISTORY_LIMIT ходов. push() возвращает дифф
 * с предыдущим ходом (до вытеснения), как appendContextDiffCapture в pi-forge.
 */
export class ContextHistory {
	private turns: TurnSnapshot[] = [];
	/** Растёт на каждый push — инвалидация кэша рендера в TraceView. */
	private rev = 0;

	get snapshots(): readonly TurnSnapshot[] {
		return this.turns;
	}

	get revision(): number {
		return this.rev;
	}

	get length(): number {
		return this.turns.length;
	}

	/** Дифф хода по индексу буфера с предыдущим ходом буфера (или zeroDiff для первого). */
	diffAt(index: number): { prev?: TurnSnapshot; curr: TurnSnapshot; diff: TurnDiff } {
		const curr = this.turns[index]!;
		const prev = index > 0 ? this.turns[index - 1] : undefined;
		return { prev, curr, diff: diffTurns(prev, curr) };
	}

	push(snapshot: TurnSnapshot): TurnDiff {
		const diff = this.turns.length > 0 ? diffTurns(this.turns[this.turns.length - 1], snapshot) : zeroDiff(snapshot);
		this.turns.push(snapshot);
		if (this.turns.length > CONTEXT_HISTORY_LIMIT) this.turns.shift();
		this.rev++;
		return diff;
	}
}
