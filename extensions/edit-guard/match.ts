/**
 * edit-guard/match: чистая логика поиска oldText в файле с фазами возрастающей
 * свободы (exact → whitespace → indent → fuzzy). Без I/O.
 *
 * Контракт: `actual` в Recovered — ВСЕГДА сырая подстрока исходного файла
 * (с её родными EOL и отступами), чтобы встроенный инструмент edit после
 * подмены oldText := actual совпал байт-в-байт.
 */

export const FUZZY_THRESHOLD = 0.85;
/** Файлов больше этого числа строк fuzzy-фаза не сканирует (дорого). */
export const MAX_FUZZY_FILE_LINES = 20000;
/**
 * Жёсткий кап длины строки для fuzzy-фазы D — применяется к паре строк после
 * среза общего префикса/суффикса. Цена DP одной пары квадратична: при капе
 * 4096 это ≤ ~17M ячеек (десятки мс), а пара без капа вида «две 90KB-строки,
 * расходящиеся в середине» — минуты синхронного мороза edit-пути. Пары,
 * всё ещё более длинные после среза, дисквалифицируют окно: блокировка
 * с диагностикой лучше минутного зависания.
 */
const FUZZY_MAX_LINE_CHARS = 4096;

/** Худшая допустимая похожесть отдельной строки в fuzzy-фазе. */
const WORST_LINE_SIMILARITY = 0.6;
/** Минимальная похожесть первых непустых строк, чтобы вообще пробовать fuzzy. */
const PREFILTER_SIMILARITY = 0.5;

export type Method = "exact" | "whitespace" | "indent" | "fuzzy";

export type Recovered = {
	status: "recovered";
	method: Method;
	/** Сырая подстрока исходного файла, байт-в-байт пригодная для oldText. */
	actual: string;
	similarity: number;
	/** 1-based номер строки файла, с которой начинается совпадение. */
	line: number;
};

export type NotFound = {
	status: "not-found";
	similarity: number;
	/** 1-based строка лучшего (или единственного спорного) кандидата. */
	line: number;
	detail: string;
};

export type ResolveResult = Recovered | NotFound;

const BOM = "﻿";

/**
 * BOM → снять, CRLF и CR → LF, плюс та же карта типографики, что в
 * normalizeForFuzzyMatch встроенного edit (умные кавычки, тире, юникод-пробелы
 * → ASCII), чтобы гард не блокировал то, что инструмент сам прощает. NFKC
 * оттуда сознательно не переносится: он меняет длины строк и ломает перенос
 * смещений 1:1 из нормализованной строки в сырую.
 */
export function normalize(text: string): string {
	return text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		// U+2018-U+201B: умные одинарные кавычки → '
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		// U+201C-U+201F: умные двойные кавычки → "
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		// U+2010-U+2015, U+2212: дефисы и тире → -
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		// U+00A0, U+2002-U+200A, U+202F, U+205F, U+3000: специальные пробелы → ' '
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Убрать хвостовые пробелы/табы в конце каждой строки. */
export function trimTrailing(text: string): string {
	return text.replace(/[ \t]+$/gm, "");
}

/** Убрать ведущие пробелы/табы в начале каждой строки. */
export function stripIndent(text: string): string {
	return text.replace(/^[ \t]+/gm, "");
}

/**
 * Срезать общий префикс и суффикс: расстояние Левенштейна не меняется, а DP
 * становится пропорциональной расхождению, а не длине строк. Это сводит
 * суффикс-дрейф длинных строк (типичный кейс зависания) к тривиальному DP.
 */
function trimCommon(a: string, b: string): [string, string] {
	let lo = 0;
	const minLen = Math.min(a.length, b.length);
	while (lo < minLen && a.charCodeAt(lo) === b.charCodeAt(lo)) lo++;
	let hiA = a.length;
	let hiB = b.length;
	while (hiA > lo && hiB > lo && a.charCodeAt(hiA - 1) === b.charCodeAt(hiB - 1)) {
		hiA -= 1;
		hiB -= 1;
	}
	return [a.slice(lo, hiA), b.slice(lo, hiB)];
}

/**
 * DP Левенштейна по уже обрезанной паре; maxLen — знаменатель по исходным
 * длинам (расстояние при срезе не изменилось, похожесть считается от них).
 * budget — максимально допустимая доля расстояния: если уже видно, что
 * levenshtein > budget * maxLen, выходим рано и возвращаем оценку (< 1 - budget).
 */
function levenshteinSimilarity(ta: string, tb: string, maxLen: number, budget: number): number {
	if (ta.length === 0) return Math.max(0, 1 - tb.length / maxLen);
	if (tb.length === 0) return Math.max(0, 1 - ta.length / maxLen);
	const limit = budget * maxLen;

	let prev = new Array<number>(tb.length + 1);
	let curr = new Array<number>(tb.length + 1);
	for (let j = 0; j <= tb.length; j++) prev[j] = j;

	for (let i = 1; i <= ta.length; i++) {
		const ca = ta.charCodeAt(i - 1);
		curr[0] = i;
		let rowMin = i;
		for (let j = 1; j <= tb.length; j++) {
			const cost = ca === tb.charCodeAt(j - 1) ? 0 : 1;
			const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			curr[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > limit) return Math.max(0, 1 - rowMin / maxLen);
		[prev, curr] = [curr, prev];
	}
	return Math.max(0, 1 - prev[tb.length] / maxLen);
}

/**
 * Похожесть 1 - levenshtein(a, b) / max(len(a), len(b)) со срезом общего
 * префикса/суффикса перед DP (см. trimCommon).
 */
export function similarity(a: string, b: string, budget = 1): number {
	if (a === b) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	const [ta, tb] = trimCommon(a, b);
	return levenshteinSimilarity(ta, tb, maxLen, budget);
}

interface RawLine {
	/** Содержимое строки без EOL. */
	text: string;
	/** "" | "\n" | "\r\n" | "\r". */
	eol: string;
	/** Смещение содержимого строки в исходном тексте (BOM пропущен). */
	start: number;
}

/**
 * Разобрать сырой текст на строки. BOM не входит ни в одну строку (первая
 * строка начинается сразу после него). Если файл кончается EOL, добавляется
 * виртуальная пустая строка — тогда число строк совпадает с
 * normalize(text).split("\n") и окно фиксированной длины всегда отображается
 * в сырой диапазон.
 */
function splitRawLines(text: string): RawLine[] {
	const lines: RawLine[] = [];
	const bomLen = text.startsWith(BOM) ? 1 : 0;
	let start = bomLen;
	let i = bomLen;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\r" || ch === "\n") {
			const eol = ch === "\r" ? (text[i + 1] === "\n" ? "\r\n" : "\r") : "\n";
			lines.push({ text: text.slice(start, i), eol, start });
			i += eol.length;
			start = i;
		} else {
			i += 1;
		}
	}
	if (start < text.length || lines.length === 0) {
		lines.push({ text: text.slice(start), eol: "", start });
	} else {
		// Файл кончается EOL: виртуальная пустая строка без EOL.
		lines.push({ text: "", eol: "", start: text.length });
	}
	return lines;
}

/** Сниппет для detail: до 3 строк через " ⏎ ", обрезка на 200 символах. */
function snippet(text: string): string {
	const s = text
		.split("\n")
		.slice(0, 3)
		.map((l) => l.trim())
		.join(" ⏎ ");
	return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

interface Candidate {
	line: number;
	/** Число строк в окне (для диапазона в detail). */
	span: number;
	actual: string;
	similarity: number;
}

/** Оставить первый кандидат на каждый различный сырой текст; true если осталось > 1. */
function dedupe(candidates: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	const unique: Candidate[] = [];
	for (const c of candidates) {
		if (!seen.has(c.actual)) {
			seen.add(c.actual);
			unique.push(c);
		}
	}
	return unique;
}

function recovered(method: Method, c: Candidate): Recovered {
	return { status: "recovered", method, actual: c.actual, similarity: c.similarity, line: c.line };
}

/**
 * Неоднозначность: несколько разных сырых вариантов — неизвестно, какой из них
 * имел в виду автор правки.
 */
function ambiguous(candidates: Candidate[]): NotFound {
	const ranges = candidates
		.slice(0, 5)
		.map((c) => (c.span > 1 ? `${c.line}–${c.line + c.span - 1}` : `${c.line}`))
		.join(", ");
	return {
		status: "not-found",
		similarity: candidates[0]?.similarity ?? 1,
		line: candidates[0]?.line ?? 1,
		detail: `неоднозначно: совпадение в разных местах файла (строки ${ranges}); уточните oldText, чтобы выделить нужное место`,
	};
}

function notFound(needle: string, best: Candidate | undefined, extra: string): NotFound {
	if (!best) {
		return {
			status: "not-found",
			similarity: 0,
			line: 1,
			detail: `совпадение не найдено${extra ? `; ${extra}` : ""}`,
		};
	}
	const range = best.span > 1 ? `строки ${best.line}–${best.line + best.span - 1}` : `строка ${best.line}`;
	const winLines = best.actual.split("\n").slice(0, best.span).join("\n");
	return {
		status: "not-found",
		similarity: best.similarity,
		line: best.line,
		detail: `ближайший кандидат: ${range}; ожидалось: ${snippet(needle)}; найдено: ${snippet(winLines)}${extra ? `; ${extra}` : ""}`,
	};
}

/**
 * Поиск oldText в fileText по фазам:
 *
 * A. exact       — точное вхождение.
 * B. whitespace  — после нормализации (BOM, EOL, хвостовые пробелы) окно
 *                  построчно совпало; однострочный needle ищется и внутри строки.
 * C. indent      — то же после снятия ведущих пробелов/табов с обеих сторон.
 * D. fuzzy       — посимвольная похожесть: средняя по строкам ≥ FUZZY_THRESHOLD
 *                  и худшая строка ≥ 0.6; несколько разных кандидатов — отказ.
 */
export function resolveEdit(fileText: string, oldText: string, opts?: { fuzzy?: boolean }): ResolveResult {
	// A. Точное совпадение (включая пустой oldText — pass-through).
	const exactIdx = fileText.indexOf(oldText);
	if (exactIdx !== -1) {
		// 1-based строка, содержащая начало совпадения.
		let line = 1;
		for (let k = 0; k < exactIdx; k++) {
			const ch = fileText[k];
			if (ch === "\n" || (ch === "\r" && fileText[k + 1] !== "\n")) line++;
		}
		return { status: "recovered", method: "exact", actual: oldText, similarity: 1, line };
	}
	if (oldText === "") {
		return notFound(oldText, undefined, "oldText пуст");
	}

	const rawLines = splitRawLines(fileText);
	const fuzzyEnabled = opts?.fuzzy !== false && rawLines.length <= MAX_FUZZY_FILE_LINES;

	const normFileLines = trimTrailing(normalize(fileText)).split("\n");
	const indFileLines = stripIndent(normFileLines.join("\n")).split("\n");

	const needleNorm = trimTrailing(normalize(oldText));
	const indNeedle = stripIndent(needleNorm);

	// Кандидат — совпавшее окно фазы B или C.
	const scanWindows = (
		fileLines: string[],
		needle: string,
		buildActual: (i: number, n: number, endsWithEol: boolean) => string | null,
	): Candidate[] => {
		const all = needle.split("\n");
		// Завершающий "\n" — это EOL собственной последней строки needle, а не
		// требование пустой строки файла: без этого среза needle с хвостовым
		// переводом строки не находится никогда (окно ждало бы пустую строку).
		const endsWithEol = all[all.length - 1] === "";
		const segments = endsWithEol ? all.slice(0, -1) : all;
		const n = segments.length;
		const target = segments.join("\n");
		const candidates: Candidate[] = [];
		for (let i = 0; i + n <= fileLines.length; i++) {
			if (fileLines.slice(i, i + n).join("\n") !== target) continue;
			const actual = buildActual(i, n, endsWithEol);
			if (actual === null) continue; // окно не отображается в сырую подстроку
			candidates.push({ line: i + 1, span: n, actual, similarity: 1 });
		}
		return candidates;
	};

	// Сырое окно строк [i, i+n): от начала строки i до конца содержимого строки
	// i+n-1; с EOL этой строки, если needle заканчивается на "\n". Если EOL у
	// последней строки окна нет (конец файла без перевода строки), а needle его
	// требует — сырой подстроки не существует, возвращаем null.
	const rawWindow = (i: number, n: number, endsWithEol: boolean): string | null => {
		const last = rawLines[Math.min(i + n - 1, rawLines.length - 1)];
		if (endsWithEol && last.eol === "") return null;
		const end = last.start + last.text.length + (endsWithEol ? last.eol.length : 0);
		return fileText.slice(rawLines[i].start, end);
	};

	// B. Нормализация пробелов: точное равенство окон.
	{
		const n = needleNorm.split("\n").length;
		const candidates: Candidate[] = [];
		if (needleNorm !== "") {
			if (n === 1) {
				// Однострочный needle: ищем вхождение и внутри строки (после
				// нормализации длина совпадает с сырой — смещения переносятся 1:1).
				for (let j = 0; j < normFileLines.length; j++) {
					let col = normFileLines[j].indexOf(needleNorm);
					while (col !== -1) {
						candidates.push({
							line: j + 1,
							span: 1,
							actual: rawLines[j].text.slice(col, col + needleNorm.length),
							similarity: 1,
						});
						col = normFileLines[j].indexOf(needleNorm, col + Math.max(1, needleNorm.length));
					}
				}
			} else {
				candidates.push(...scanWindows(normFileLines, needleNorm, (i, len, eol) => rawWindow(i, len, eol)));
			}
		}
		const unique = dedupe(candidates);
		if (unique.length === 1) return recovered("whitespace", unique[0]);
		if (unique.length > 1) return ambiguous(unique);
	}

	// C. Отступы: то же после снятия ведущих пробелов/табов; уникальность обязательна.
	if (indNeedle !== "") {
		const candidates = dedupe(scanWindows(indFileLines, indNeedle, (i, len, eol) => rawWindow(i, len, eol)));
		if (candidates.length === 1) return recovered("indent", candidates[0]);
		if (candidates.length > 1) return ambiguous(candidates);
	}

	if (!fuzzyEnabled) {
		const reason =
			rawLines.length > MAX_FUZZY_FILE_LINES
				? `файл длиннее ${MAX_FUZZY_FILE_LINES} строк, fuzzy-фаза пропущена`
				: "fuzzy-фаза отключена";
		return notFound(oldText, undefined, reason);
	}

	// D. Fuzzy: построчная похожесть на нормализованном и без отступов тексте.
	const fileLines = stripIndent(trimTrailing(normalize(fileText))).split("\n");
	const needleLinesAll = stripIndent(trimTrailing(normalize(oldText))).split("\n");
	// Как в scanWindows: хвостовой "\n" — EOL последней строки needle, а не
	// пустая строка файла.
	const endsWithEol = needleLinesAll[needleLinesAll.length - 1] === "";
	const needleLines = endsWithEol ? needleLinesAll.slice(0, -1) : needleLinesAll;
	const n = needleLines.length;
	if (n === 0) {
		return notFound(oldText, undefined, "oldText пуст после нормализации");
	}

	const firstNonEmpty = (lines: string[]) => lines.findIndex((l) => l !== "");
	const needleAnchor = firstNonEmpty(needleLines);

	/**
	 * Похожесть пары строк фазы D или null: пара после среза общих концов всё
	 * ещё длиннее FUZZY_MAX_LINE_CHARS — честное DP недостижимо за разумное
	 * время, окно с такой парой дисквалифицируется.
	 */
	const lineSimilarity = (fileLine: string, needleLine: string, budget: number): number | null => {
		const [ta, tb] = trimCommon(fileLine, needleLine);
		if (Math.max(ta.length, tb.length) > FUZZY_MAX_LINE_CHARS) return null;
		return levenshteinSimilarity(ta, tb, Math.max(fileLine.length, needleLine.length), budget);
	};

	const passing: Candidate[] = [];
	for (let i = 0; i + n <= fileLines.length; i++) {
		const windowLines = fileLines.slice(i, i + n);

		// Prefilter: первые непустые строки должны быть хоть немного похожи.
		if (needleAnchor !== -1) {
			const winAnchor = firstNonEmpty(windowLines);
			if (winAnchor === -1) continue;
			const pre = lineSimilarity(windowLines[winAnchor], needleLines[needleAnchor], 1 - PREFILTER_SIMILARITY);
			if (pre === null || pre < PREFILTER_SIMILARITY) continue;
		}

		let sum = 0;
		let worst = 1;
		let abandoned = false;
		for (let k = 0; k < n; k++) {
			const s = lineSimilarity(windowLines[k], needleLines[k], 1 - WORST_LINE_SIMILARITY);
			// Пару не оценить в бюджете — окно не может быть подтверждено.
			if (s === null) {
				abandoned = true;
				break;
			}
			if (s < worst) worst = s;
			sum += s;
			// Даже идеальные оставшиеся строки не вытянут среднюю до порога.
			if ((sum + (n - k - 1)) / n < FUZZY_THRESHOLD) {
				abandoned = true;
				break;
			}
		}
		if (abandoned) continue;

		const mean = sum / n;
		if (mean < FUZZY_THRESHOLD || worst < WORST_LINE_SIMILARITY) continue;

		const actual = rawWindow(i, n, endsWithEol);
		if (actual === null) continue;
		passing.push({ line: i + 1, span: n, actual, similarity: mean });
	}

	const fuzzyCandidates = dedupe(passing);
	if (fuzzyCandidates.length > 1) return ambiguous(fuzzyCandidates);
	const best = fuzzyCandidates[0];
	if (best) return recovered("fuzzy", best);

	let bestEffort: Candidate | undefined;
	for (let i = 0; i + n <= fileLines.length; i++) {
		const windowLines = fileLines.slice(i, i + n);
		if (needleAnchor !== -1) {
			const winAnchor = firstNonEmpty(windowLines);
			if (winAnchor === -1) continue;
			const pre = lineSimilarity(windowLines[winAnchor], needleLines[needleAnchor], 1 - PREFILTER_SIMILARITY);
			if (pre === null || pre < PREFILTER_SIMILARITY) continue;
		}
		let sum = 0;
		for (let k = 0; k < n; k++) {
			const s = lineSimilarity(windowLines[k], needleLines[k], 1 - WORST_LINE_SIMILARITY);
			// Слишком длинная пара в best-effort диагностике считается непохожей.
			sum += s ?? 0;
			if ((sum + (n - k - 1)) / n < FUZZY_THRESHOLD) break;
		}
		const mean = sum / n;
		const candidate: Candidate = { line: i + 1, span: n, actual: rawWindow(i, n, false) ?? "", similarity: mean };
		if (!bestEffort || candidate.similarity > bestEffort.similarity) bestEffort = candidate;
	}
	// Prefilter не пропустил ни одного окна — показываем первое окно файла.
	if (!bestEffort && fileLines.length >= n) {
		bestEffort = { line: 1, span: n, actual: rawWindow(0, n, false), similarity: 0 };
	}
	return notFound(oldText, bestEffort, "");
}
