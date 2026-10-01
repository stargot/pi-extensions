/**
 * Построчный дифф (pure TS, ноль зависимостей) — порт src/web-editor/line-diff.ts из pi-forge (MIT),
 * адаптированный под терминальные расширения pi.
 *
 * Отличия от оригинала:
 * - плоский результат `diffLines`: спаренные delete/insert сливаются в строки `modify` с inline-сегментами;
 *   типы `equal | insert | delete | modify` вместо `same | added | removed | note`;
 * - раскраска не захардкожена: рендер принимает инъекционный `DiffStyler`
 *   (структурно совместим с `Styler` из session-ledger/report.ts);
 * - бюджет LCS-клеток настраивается через `opts.maxLcsCells` (по умолчанию 500_000).
 *
 * Алгоритм: тримминг общего префикса/суффикса строк → LCS-матрица над срединой (при превышении
 * бюджета — replace-блок без inline-пар) → inline-дифф изменённых пар по графемам `Intl.Segmenter`
 * (CJK-строки и эмодзи не рвутся по суррогатам).
 */

export type DiffRowType = "equal" | "insert" | "delete" | "modify";

export interface DiffSegment {
	text: string;
	/** Изменилась ли эта часть строки относительно другой стороны. */
	changed: boolean;
}

export interface DiffRow {
	type: DiffRowType;
	/** Содержимое строки; для `modify` — сторона «до» (парная строка «после» — в `afterText`). */
	text: string;
	/** 1-based номера строк по сторонам; отсутствуют там, где строки нет. */
	beforeLine?: number;
	afterLine?: number;
	/** Inline-сегменты строки (какие части изменились). */
	segments: DiffSegment[];
	/** Только для `modify`: парная вставленная строка. */
	afterText?: string;
	afterSegments?: DiffSegment[];
}

export interface DiffSeparator {
	type: "separator";
}

export type DiffDisplayRow = DiffRow | DiffSeparator;

/** Строка side-by-side вида: пара колонок «до | после» или разделитель. */
export interface SideBySideRow {
	type: "line" | "separator";
	before?: DiffRow;
	after?: DiffRow;
}

export interface DiffLinesOptions {
	/**
	 * Бюджет клеток LCS-матрицы; при превышении средина диффа заменяется replace-блоком
	 * (delete-строки, затем insert-строки, без modify-пар и inline-сегментов). По умолчанию 500_000.
	 */
	maxLcsCells?: number;
}

const DEFAULT_MAX_LCS_CELLS = 500_000;
/** Не считать inline-дифф для слишком длинных пар строк — дорогой проход по графемам. */
const MAX_INLINE_DIFF_CHARS = 50_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Главный API: построчный дифф двух массивов строк. */
export function diffLines(a: readonly string[], b: readonly string[], opts?: DiffLinesOptions): DiffRow[] {
	const operations = lineOperations(a, b, opts?.maxLcsCells ?? DEFAULT_MAX_LCS_CELLS);
	return mergeModifications(operations);
}

/** Удобная обёртка над `diffLines` для текстов (как оригинальный `diffTextLines`). */
export function diffText(beforeText: string, afterText: string, opts?: DiffLinesOptions): DiffRow[] {
	return diffLines(splitLines(beforeText), splitLines(afterText), opts);
}

/** Фильтр контекста: `contextLines = 0` — только изменённые строки, `null` — всё; разрывы — `separator`. */
export function filterRows(rows: readonly DiffRow[], contextLines: number | null): DiffDisplayRow[] {
	if (contextLines === null) return [...rows];
	const context = Math.max(0, Math.floor(contextLines));
	const keep = rows.map(() => false);
	for (let index = 0; index < rows.length; index++) {
		if (rows[index]!.type === "equal") continue;
		for (let nearby = Math.max(0, index - context); nearby <= Math.min(rows.length - 1, index + context); nearby++) {
			keep[nearby] = true;
		}
	}

	const result: DiffDisplayRow[] = [];
	let previousKept = -1;
	for (let index = 0; index < rows.length; index++) {
		if (!keep[index]) continue;
		if (previousKept >= 0 && index > previousKept + 1) result.push({ type: "separator" });
		result.push(rows[index]!);
		previousKept = index;
	}
	return result;
}

/**
 * Side-by-side раскладка: `equal` дублируется в обе колонки, `modify` даёт пару view-строк
 * (delete-вид слева, insert-вид справа), остаточные delete/insert спариваются позиционно.
 */
export function buildSideBySideRows(rows: readonly DiffDisplayRow[]): SideBySideRow[] {
	const result: SideBySideRow[] = [];
	let index = 0;
	while (index < rows.length) {
		const row = rows[index]!;
		if (row.type === "separator") {
			result.push({ type: "separator" });
			index++;
			continue;
		}
		if (row.type === "equal") {
			result.push({ type: "line", before: row, after: row });
			index++;
			continue;
		}
		if (row.type === "modify") {
			result.push({
				type: "line",
				before: { type: "delete", text: row.text, beforeLine: row.beforeLine, segments: row.segments },
				after: {
					type: "insert",
					text: row.afterText ?? "",
					afterLine: row.afterLine,
					segments: row.afterSegments ?? [],
				},
			});
			index++;
			continue;
		}
		const deleted: DiffRow[] = [];
		const inserted: DiffRow[] = [];
		while (index < rows.length) {
			const changed = rows[index]!;
			if (changed.type !== "delete" && changed.type !== "insert") break;
			if (changed.type === "delete") deleted.push(changed);
			else inserted.push(changed);
			index++;
		}
		for (let pair = 0; pair < Math.max(deleted.length, inserted.length); pair++) {
			result.push({ type: "line", before: deleted[pair], after: inserted[pair] });
		}
	}
	return result;
}

export type DiffColor =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "toolTitle"
	| "borderMuted";

/** Узкий интерфейс раскраски, структурно совместим с `Styler` из session-ledger/report.ts. */
export interface DiffStyler {
	fg(color: DiffColor, text: string): string;
	bold(text: string): string;
}

export const plainDiffStyler: DiffStyler = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Семантические цвета видов строк: неизменное — приглушённо, вставки — успех, удаления — ошибка, правки — предупреждение. */
export const diffKindColors: Record<DiffRowType, DiffColor> = {
	equal: "muted",
	insert: "success",
	delete: "error",
	modify: "warning",
};

/** Одна строка диффа в терминал: базовый цвет по виду строки, изменённые сегменты — жирным. */
export function renderDiffRow(
	row: DiffRow,
	styler: DiffStyler,
	colors: Record<DiffRowType, DiffColor> = diffKindColors,
): string {
	const color = colors[row.type];
	return row.segments
		.map((segment) => {
			const painted = styler.fg(color, segment.text);
			return segment.changed ? styler.bold(painted) : painted;
		})
		.join("");
}

interface LineOp {
	kind: "equal" | "insert" | "delete";
	text: string;
	beforeLine?: number;
	afterLine?: number;
	/** Replace-блок при превышении LCS-бюджета: такие строки не спариваются в modify. */
	fallback?: boolean;
}

function lineOperations(before: readonly string[], after: readonly string[], maxLcsCells: number): LineOp[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - suffix - 1] === after[after.length - suffix - 1]
	)
		suffix++;

	const operations: LineOp[] = [];
	for (let index = 0; index < prefix; index++) operations.push({ kind: "equal", text: before[index]! });
	operations.push(
		...diffMiddle(
			before.slice(prefix, before.length - suffix),
			after.slice(prefix, after.length - suffix),
			maxLcsCells,
		),
	);
	for (let index = before.length - suffix; index < before.length; index++)
		operations.push({ kind: "equal", text: before[index]! });

	let beforeLine = 0;
	let afterLine = 0;
	for (const operation of operations) {
		if (operation.kind !== "insert") operation.beforeLine = ++beforeLine;
		if (operation.kind !== "delete") operation.afterLine = ++afterLine;
	}
	return operations;
}

function diffMiddle(before: readonly string[], after: readonly string[], maxLcsCells: number): LineOp[] {
	if (before.length === 0) return after.map((text) => ({ kind: "insert" as const, text }));
	if (after.length === 0) return before.map((text) => ({ kind: "delete" as const, text }));
	if ((before.length + 1) * (after.length + 1) > maxLcsCells) {
		return [
			...before.map((text) => ({ kind: "delete" as const, text, fallback: true as const })),
			...after.map((text) => ({ kind: "insert" as const, text, fallback: true as const })),
		];
	}

	const width = after.length + 1;
	const matrix = new Uint32Array((before.length + 1) * width);
	for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex--) {
		for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex--) {
			const offset = beforeIndex * width + afterIndex;
			matrix[offset] =
				before[beforeIndex] === after[afterIndex]
					? matrix[(beforeIndex + 1) * width + afterIndex + 1]! + 1
					: Math.max(matrix[(beforeIndex + 1) * width + afterIndex]!, matrix[offset + 1]!);
		}
	}

	const result: LineOp[] = [];
	let beforeIndex = 0;
	let afterIndex = 0;
	while (beforeIndex < before.length && afterIndex < after.length) {
		if (before[beforeIndex] === after[afterIndex]) {
			result.push({ kind: "equal", text: before[beforeIndex]! });
			beforeIndex++;
			afterIndex++;
		} else if (matrix[(beforeIndex + 1) * width + afterIndex]! >= matrix[beforeIndex * width + afterIndex + 1]!) {
			result.push({ kind: "delete", text: before[beforeIndex++]! });
		} else {
			result.push({ kind: "insert", text: after[afterIndex++]! });
		}
	}
	while (beforeIndex < before.length) result.push({ kind: "delete", text: before[beforeIndex++]! });
	while (afterIndex < after.length) result.push({ kind: "insert", text: after[afterIndex++]! });
	return result;
}

/** Слияние подряд идущих delete/insert в modify-пары (позиционно, как inline-аннотация в оригинале). */
function mergeModifications(operations: readonly LineOp[]): DiffRow[] {
	const rows: DiffRow[] = [];
	let index = 0;
	while (index < operations.length) {
		const operation = operations[index]!;
		if (operation.kind === "equal") {
			rows.push(simpleRow(operation));
			index++;
			continue;
		}
		const start = index;
		while (index < operations.length && operations[index]!.kind !== "equal") index++;
		const run = operations.slice(start, index);
		if (run.some((op) => op.fallback)) {
			for (const op of run) rows.push(simpleRow(op));
			continue;
		}
		const deleted = run.filter((op) => op.kind === "delete");
		const inserted = run.filter((op) => op.kind === "insert");
		const pairs = Math.min(deleted.length, inserted.length);
		for (let pair = 0; pair < pairs; pair++) {
			const before = deleted[pair]!;
			const after = inserted[pair]!;
			const [segments, afterSegments] = inlineSegments(before.text, after.text);
			rows.push({
				type: "modify",
				text: before.text,
				beforeLine: before.beforeLine,
				afterLine: after.afterLine,
				segments,
				afterText: after.text,
				afterSegments,
			});
		}
		for (let pair = pairs; pair < deleted.length; pair++) rows.push(simpleRow(deleted[pair]!));
		for (let pair = pairs; pair < inserted.length; pair++) rows.push(simpleRow(inserted[pair]!));
	}
	return rows;
}

function simpleRow(operation: LineOp): DiffRow {
	if (operation.kind === "equal") {
		return {
			type: "equal",
			text: operation.text,
			beforeLine: operation.beforeLine,
			afterLine: operation.afterLine,
			segments: [{ text: operation.text, changed: false }],
		};
	}
	return {
		type: operation.kind,
		text: operation.text,
		beforeLine: operation.beforeLine,
		afterLine: operation.afterLine,
		segments: [{ text: operation.text, changed: true }],
	};
}

function inlineSegments(before: string, after: string): [DiffSegment[], DiffSegment[]] {
	if (before.length + after.length > MAX_INLINE_DIFF_CHARS) {
		return [[{ text: before, changed: true }], [{ text: after, changed: true }]];
	}
	const beforeGraphemes = splitGraphemes(before);
	const afterGraphemes = splitGraphemes(after);
	let prefix = 0;
	while (
		prefix < beforeGraphemes.length &&
		prefix < afterGraphemes.length &&
		beforeGraphemes[prefix] === afterGraphemes[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < beforeGraphemes.length - prefix &&
		suffix < afterGraphemes.length - prefix &&
		beforeGraphemes[beforeGraphemes.length - suffix - 1] === afterGraphemes[afterGraphemes.length - suffix - 1]
	)
		suffix++;
	return [segmentsForLine(beforeGraphemes, prefix, suffix), segmentsForLine(afterGraphemes, prefix, suffix)];
}

function segmentsForLine(graphemes: readonly string[], prefix: number, suffix: number): DiffSegment[] {
	const segments: DiffSegment[] = [];
	if (prefix > 0) segments.push({ text: graphemes.slice(0, prefix).join(""), changed: false });
	segments.push({ text: graphemes.slice(prefix, graphemes.length - suffix).join(""), changed: true });
	if (suffix > 0) segments.push({ text: graphemes.slice(graphemes.length - suffix).join(""), changed: false });
	return segments;
}

function splitGraphemes(text: string): string[] {
	return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}
