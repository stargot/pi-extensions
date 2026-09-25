/**
 * session-recall: полнотекстовый поиск по всем сессиям pi.
 *
 * Единица поиска — одно сообщение (user, assistant, tool, custom, summary) с датой, проектом и id записи.
 * Чистый модуль без runtime-зависимостей от pi: работает в расширении, CLI и тестах.
 */
import { readFileSync, statSync } from "node:fs";
import { discoverSessionFiles } from "../shared/sessions.ts";
import { parseSessionCombined, type Unit, type UnitRole } from "../shared/session-index.ts";

// Канонические типы живут в shared/session-index.ts — ре-экспорт для совместимости.
export type { Unit, UnitRole } from "../shared/session-index.ts";

export interface Hit {
	unit: Unit;
	/** BM25-lite скор × затухание свежести. */
	score: number;
	/** Фрагмент вокруг первого вхождения. */
	snippet: string;
	/** Позиция первого вхождения в тексте. */
	position: number;
}

export interface Query {
	terms: string[];
	/** Quoted phrases — весят ×2 в скоринге. Ключ отсутствует, если фраз нет. */
	phrases?: string[];
	role?: UnitRole;
	project?: string;
	tool?: string;
}

export interface IndexEntry {
	mtimeMs: number;
	size: number;
	units: Unit[];
}

export type IndexCache = Map<string, IndexEntry>;

export const ROLES: UnitRole[] = ["user", "assistant", "tool", "custom", "summary"];

/**
 * Разбор строки запроса: слова через пробел (все должны встретиться), "фраза в кавычках" как один терм,
 * фильтры role:user, project:name, tool:edit.
 */
export function parseQuery(input: string): Query {
	const query: Query = { terms: [] };
	const phrases: string[] = [];
	const re = /"([^"]+)"|(\S+)/g;
	for (const match of input.matchAll(re)) {
		const token = match[1] ?? match[2] ?? "";
		if (match[1]) phrases.push(match[1]);
		const filter = /^(role|project|tool):(.+)$/.exec(token);
		if (filter && !match[1]) {
			const [, key, value] = filter;
			if (key === "role" && (ROLES as string[]).includes(value.toLowerCase())) query.role = value.toLowerCase() as UnitRole;
			else if (key === "project") query.project = value;
			else if (key === "tool") query.tool = value.toLowerCase();
			continue;
		}
		if (token) query.terms.push(token);
	}
	if (phrases.length > 0) query.phrases = phrases;
	return query;
}

export function extractUnits(text: string, file: string): Unit[] {
	// Обёртка над единым парсером (shared/session-index.ts) — совместимость с тестами.
	return parseSessionCombined(text, file)?.units ?? [];
}

export function refreshIndex(root: string, cache: IndexCache, options: { exclude?: string } = {}): { units: Unit[]; files: number; reparsed: number } {
	const files = discoverSessionFiles(root).filter((f) => !options.exclude || f !== options.exclude);
	const seen = new Set(files);
	for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);

	let reparsed = 0;
	for (const file of files) {
		let mtimeMs = 0;
		let size = 0;
		try {
			const st = statSync(file);
			mtimeMs = st.mtimeMs;
			size = st.size;
		} catch {
			continue;
		}
		const cached = cache.get(file);
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) continue;
		try {
			cache.set(file, { mtimeMs, size, units: extractUnits(readFileSync(file, "utf8"), file) });
			reparsed += 1;
		} catch {
			cache.delete(file);
		}
	}
	const units: Unit[] = [];
	for (const file of files) {
		const entry = cache.get(file);
		if (entry) units.push(...entry.units);
	}
	return { units, files: files.length, reparsed };
}

export function search(units: Unit[], query: Query, options: { limit?: number; snippetRadius?: number } = {}): { hits: Hit[]; total: number } {
	const limit = options.limit ?? 50;
	const radius = options.snippetRadius ?? 60;
	const terms = query.terms.map((t) => t.toLowerCase()).filter(Boolean);
	const phrases = (query.phrases ?? []).map((t) => t.toLowerCase());
	const project = query.project?.toLowerCase();
	const hits: Hit[] = [];

	// Предфильтрация + сбор df (число документов с термом) для idf по отфильтрованной коллекции.
	const corpus: Array<{ unit: Unit; lower: string }> = [];
	for (const unit of units) {
		if (query.role && unit.role !== query.role) continue;
		if (project && !unit.project.toLowerCase().includes(project) && !unit.cwd.toLowerCase().includes(project)) continue;
		if (query.tool && (unit.tool ?? "").toLowerCase() !== query.tool) continue;
		corpus.push({ unit, lower: unit.text.toLowerCase() });
	}
	const df = new Map<string, number>();
	for (const { lower } of corpus) {
		for (const term of terms) {
			if (lower.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	const totalDocs = corpus.length || 1;
	// Свежесть: 1.0 сейчас → 0.5 через 30 дней → далее плавно вниз.
	const recency = (timestamp: number): number => {
		const days = Math.max(0, (Date.now() - timestamp) / 86_400_000);
		return 1 / (1 + days / 30);
	};

	for (const { unit, lower } of corpus) {
		if (terms.length === 0) {
			hits.push({ unit, score: 0, snippet: makeSnippet(unit.text, 0, 0, radius), position: 0 });
			continue;
		}
		let ok = true;
		let first = -1;
		let firstLen = 0;
		let bm = 0;
		for (const term of terms) {
			let idx = lower.indexOf(term);
			if (idx < 0) {
				ok = false;
				break;
			}
			if (first < 0 || idx < first) {
				first = idx;
				firstLen = term.length;
			}
			let tf = 0;
			while (idx >= 0) {
				tf += 1;
				idx = lower.indexOf(term, idx + term.length);
			}
			const idf = Math.log(1 + totalDocs / (df.get(term) ?? 1));
			bm += tf * idf * (phrases.includes(term) ? 2 : 1);
		}
		if (!ok) continue;
		hits.push({ unit, score: bm * recency(unit.timestamp), snippet: makeSnippet(unit.text, first, firstLen, radius), position: first });
	}

	// Скор решает, при равенстве — свежее выше.
	hits.sort((a, b) => b.score - a.score || b.unit.timestamp - a.unit.timestamp);
	return { hits: hits.slice(0, limit), total: hits.length };
}

export function makeSnippet(text: string, position: number, length: number, radius: number): string {
	const start = Math.max(0, position - radius);
	const end = Math.min(text.length, position + length + radius);
	const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${raw}${end < text.length ? "…" : ""}`;
}

/** Подсветка термов в строке через переданную функцию стиля. */
export function highlight(text: string, terms: string[], style: (s: string) => string): string {
	let out = text;
	for (const term of terms) {
		if (!term) continue;
		const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
		out = out.replace(re, (m) => style(m));
	}
	return out;
}

export function projectName(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.split("/").filter(Boolean).at(-1) ?? "?";
}

export function formatDate(ms: number): string {
	if (!ms) return "????-??-??";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
