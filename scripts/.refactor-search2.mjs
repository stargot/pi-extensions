import fs from "node:fs";

const p = "extensions/session-recall/search.ts";
let s = fs.readFileSync(p, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const j = (...arr) => arr.join(nl);

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
	j(
		'export type UnitRole = "user" | "assistant" | "tool" | "custom" | "summary";',
		"",
		"export interface Unit {",
		"\tfile: string;",
		"\tsessionId: string;",
		"\tsessionName?: string;",
		"\tproject: string;",
		"\tcwd: string;",
		"\tentryId: string;",
		"\trole: UnitRole;",
		'\t/** Имя инструмента для role === "tool". */',
		"\ttool?: string;",
		"\ttimestamp: number;",
		"\ttext: string;",
		"}",
	),
	j(
		"// Канонические типы живут в shared/session-index.ts — ре-экспорт для совместимости.",
		'export type { Unit, UnitRole } from "../shared/session-index.ts";',
	),
	"types -> re-export",
);

// ── 2. Hit.score doc: now BM25-lite ──
replaceOnce(
	j("\t/** Число вхождений всех термов. */", "\tscore: number;"),
	j("\t/** BM25-lite скор × затухание свежести. */", "\tscore: number;"),
	"Hit.score doc",
);

// ── 3. Query.phrases ──
replaceOnce(
	j(
		"export interface Query {",
		"\tterms: string[];",
		"\trole?: UnitRole;",
		"\tproject?: string;",
		"\ttool?: string;",
		"}",
	),
	j(
		"export interface Query {",
		"\tterms: string[];",
		'\t/** Quoted phrases — весят ×2 в скоринге. Ключ отсутствует, если фраз нет. */',
		"\tphrases?: string[];",
		"\trole?: UnitRole;",
		"\tproject?: string;",
		"\ttool?: string;",
		"}",
	),
	"Query.phrases",
);

// ── 4. parseQuery: collect quoted phrases ──
replaceOnce(
	j(
		"\tconst query: Query = { terms: [] };",
		'	const re = /"([^"]+)"|(\\S+)/g;',
		"	for (const match of input.matchAll(re)) {",
		'		const token = match[1] ?? match[2] ?? "";',
	),
	j(
		"\tconst query: Query = { terms: [] };",
		'	const re = /"([^"]+)"|(\\S+)/g;',
		"\tconst phrases: string[] = [];",
		"	for (const match of input.matchAll(re)) {",
		'		const token = match[1] ?? match[2] ?? "";',
		"\t\tif (match[1]) phrases.push(match[1]);",
	),
	"parseQuery collect phrases",
);
replaceOnce(
	j("\t\tif (token) query.terms.push(token);", "\t}", "\treturn query;"),
	j("\t\tif (token) query.terms.push(token);", "\t}", "\tif (phrases.length > 0) query.phrases = phrases;", "\treturn query;"),
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
s = s.slice(0, extractStart)
	+ j(
		"export function extractUnits(text: string, file: string): Unit[] {",
		"	// Обёртка над единым парсером (shared/session-index.ts) — совместимость с тестами.",
		"	return parseSessionCombined(text, file)?.units ?? [];",
		"}",
		"",
	)
	+ s.slice(extractEnd);
console.log("ok [extractUnits -> wrapper]");

// ── 6. search(): BM25-lite scoring ──
const searchStart = s.indexOf("export function search(");
const searchEnd = s.indexOf("export function makeSnippet");
if (searchStart < 0 || searchEnd <= searchStart) {
	console.error("FAIL [search anchors]", searchStart, searchEnd);
	process.exit(1);
}
const newSearch = j(
	"export function search(units: Unit[], query: Query, options: { limit?: number; snippetRadius?: number } = {}): { hits: Hit[]; total: number } {",
	"\tconst limit = options.limit ?? 50;",
	"\tconst radius = options.snippetRadius ?? 60;",
	"\tconst terms = query.terms.map((t) => t.toLowerCase()).filter(Boolean);",
	"\tconst phrases = (query.phrases ?? []).map((t) => t.toLowerCase());",
	"\tconst project = query.project?.toLowerCase();",
	"\tconst hits: Hit[] = [];",
	"",
	"\t// Предфильтрация + сбор df (документы с термом) для idf по отфильтрованной коллекции.",
	"\tconst corpus: Array<{ unit: Unit; lower: string }> = [];",
	"\tfor (const unit of units) {",
	"\t\tif (query.role && unit.role !== query.role) continue;",
	"\t\tif (project && !unit.project.toLowerCase().includes(project) && !unit.cwd.toLowerCase().includes(project)) continue;",
	'\t\tif (query.tool && (unit.tool ?? "").toLowerCase() !== query.tool) continue;',
	"\t\tcorpus.push({ unit, lower: unit.text.toLowerCase() });",
	"\t}",
	"\tconst df = new Map<string, number>();",
	"\tfor (const { lower } of corpus) {",
	"\t\tfor (const term of terms) {",
	"\t\t\tif (lower.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);",
	"\t\t}",
	"\t}",
	"\tconst totalDocs = corpus.length || 1;",
	"\t// Свежесть: 1.0 сейчас → 0.5 через 30 дней → далее плавно вниз.",
	"\tconst recency = (timestamp: number): number => {",
	"\t\tconst days = Math.max(0, (Date.now() - timestamp) / 86_400_000);",
	"\t\treturn 1 / (1 + days / 30);",
	"\t};",
	"",
	"\tfor (const { unit, lower } of corpus) {",
	"\t\tif (terms.length === 0) {",
	"\t\t\thits.push({ unit, score: 0, snippet: makeSnippet(unit.text, 0, 0, radius), position: 0 });",
	"\t\t\tcontinue;",
	"\t\t}",
	"\t\tlet ok = true;",
	"\t\tlet first = -1;",
	"\t\tlet firstLen = 0;",
	"\t\tlet bm = 0;",
	"\t\tfor (const term of terms) {",
	"\t\t\tlet idx = lower.indexOf(term);",
	"\t\t\tif (idx < 0) {",
	"\t\t\t\tok = false;",
	"\t\t\t\tbreak;",
	"\t\t\t}",
	"\t\t\tif (first < 0 || idx < first) {",
	"\t\t\t\tfirst = idx;",
	"\t\t\t\tfirstLen = term.length;",
	"\t\t\t}",
	"\t\t\tlet tf = 0;",
	"\t\t\twhile (idx >= 0) {",
	"\t\t\t\ttf += 1;",
	"\t\t\t\tidx = lower.indexOf(term, idx + term.length);",
	"\t\t\t}",
	'\t\t\tconst idf = Math.log(1 + totalDocs / (df.get(term) ?? 1));',
	"\t\t\tbm += tf * idf * (phrases.includes(term) ? 2 : 1);",
	"\t\t}",
	"\t\tif (!ok) continue;",
	"\t\thits.push({ unit, score: bm * recency(unit.timestamp), snippet: makeSnippet(unit.text, first, firstLen, radius), position: first });",
	"\t}",
	"",
	"\thits.sort((a, b) => b.score - a.score || b.unit.timestamp - a.unit.timestamp);",
	"\treturn { hits: hits.slice(0, limit), total: hits.length };",
	"}",
	"",
);
s = s.slice(0, searchStart) + newSearch + s.slice(searchEnd);
console.log("ok [search -> BM25-lite]");

// ── 7. Import the unified parser ──
replaceOnce(
	'import { discoverSessionFiles } from "../shared/sessions.ts";',
	j(
		'import { discoverSessionFiles } from "../shared/sessions.ts";',
		'import { parseSessionCombined, type Unit } from "../shared/session-index.ts";',
	),
	"import unified parser",
);

fs.writeFileSync(p, s);
console.log("search.ts refactored OK");
