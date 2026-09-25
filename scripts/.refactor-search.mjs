import fs from "node:fs";

const p = "extensions/session-recall/search.ts";
let s = fs.readFileSync(p, "utf8");

function replaceOnce(from, to, label) {
	const count = s.split(from).length - 1;
	if (count !== 1) {
		console.error(`FAIL [${label}]: expected 1 occurrence, found ${count}`);
		process.exit(1);
	}
	s = s.replace(from, to);
	console.log(`ok [${label}]`);
}

// ── 1. Types: canonical Unit/UnitRole live in shared — re-export ──
replaceOnce(
`export type UnitRole = "user" | "assistant" | "tool" | "custom" | "summary";

export interface Unit {
	file: string;
	sessionId: string;
	sessionName?: string;
	project: string;
	cwd: string;
	entryId: string;
	role: UnitRole;
	/** Имя инструмента для role === "tool". */
	tool?: string;
	timestamp: number;
	text: string;
}`,
`// Канонические типы живут в shared/session-index.ts — ре-экспорт для совместимости.
export type { Unit, UnitRole } from "../shared/session-index.ts";`,
"types -> re-export",
);

// ── 2. Hit.score doc: now BM25-lite ──
replaceOnce(
`\t/** Число вхождений всех термов. */
\tscore: number;`,
`\t/** BM25-lite скор × затухание свежести. */
\tscore: number;`,
"Hit.score doc",
);

// ── 3. Query.phrases (вес ×2 для quoted-термов; ключ появляется только при наличии фраз) ──
replaceOnce(
`export interface Query {
	terms: string[];
	role?: UnitRole;
	project?: string;
	tool?: string;
}`,
`export interface Query {
	terms: string[];
	/** Quoted phrases — весят ×2 в скоринге. Ключ отсутствует, если фраз нет. */
	phrases?: string[];
	role?: UnitRole;
	project?: string;
	tool?: string;
}`,
"Query.phrases",
);

// ── 4. parseQuery: collect quoted phrases ──
replaceOnce(
`	const query: Query = { terms: [] };
	const re = /"([^"]+)"|(\\S+)/g;
	for (const match of input.matchAll(re)) {
		const token = match[1] ?? match[2] ?? "";`,
`	const query: Query = { terms: [] };
	const phrases: string[] = [];
	const re = /"([^"]+)"|(\\S+)/g;
	for (const match of input.matchAll(re)) {
		const token = match[1] ?? match[2] ?? "";
		if (match[1]) phrases.push(match[1]);`,
"parseQuery collect phrases",
);
replaceOnce(
`\t\tif (token) query.terms.push(token);
	}
	return query;`,
`\t\tif (token) query.terms.push(token);
	}
	if (phrases.length > 0) query.phrases = phrases;
	return query;`,
"parseQuery attach phrases",
);

// ── 5. extractUnits -> wrapper over the unified parser ──
const extractStart = s.indexOf("export function extractUnits");
const rawEntryStart = s.indexOf("interface RawEntry {");
const extractEnd = s.indexOf("export function refreshIndex");
if (extractStart < 0 || rawEntryStart < 0 || extractEnd <= extractStart || rawEntryStart < extractStart) {
	console.error("FAIL [extract anchors]", extractStart, rawEntryStart, extractEnd);
	process.exit(1);
}
// Replace [extractStart..extractEnd) with the wrapper; this drops extractUnits body,
// RawEntry interface and the private helpers (toMs/blocksOf/textOf/assistantText) —
// canonical versions live in shared/session-index.ts.
s = s.slice(0, extractStart)
	+ `export function extractUnits(text: string, file: string): Unit[] {
	// Обёртка над единым парсером (shared/session-index.ts) — совместимость с тестами.
	return parseSessionCombined(text, file)?.units ?? [];
}

`
	+ s.slice(extractEnd);
console.log("ok [extractUnits -> wrapper]");

// ── 6. search(): BM25-lite scoring ──
const searchStart = s.indexOf("export function search(");
const searchEnd = s.indexOf("export function makeSnippet");
if (searchStart < 0 || searchEnd <= searchStart) {
	console.error("FAIL [search anchors]", searchStart, searchEnd);
	process.exit(1);
}
const newSearch = `export function search(units: Unit[], query: Query, options: { limit?: number; snippetRadius?: number } = {}): { hits: Hit[]; total: number } {
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

	hits.sort((a, b) => b.score - a.score || b.unit.timestamp - a.unit.timestamp);
	return { hits: hits.slice(0, limit), total: hits.length };
}

`;
s = s.slice(0, searchStart) + newSearch + s.slice(searchEnd);
console.log("ok [search -> BM25-lite]");

// ── 7. Import the unified parser ──
replaceOnce(
'import { discoverSessionFiles } from "../shared/sessions.ts";',
'import { discoverSessionFiles } from "../shared/sessions.ts";\nimport { parseSessionCombined, type Unit } from "../shared/session-index.ts";',
"import unified parser",
);

fs.writeFileSync(p, s);
console.log("search.ts refactored OK");
