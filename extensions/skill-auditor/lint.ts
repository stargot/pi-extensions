/**
 * Mechanical lint over skill discovery data for the skill-auditor extension.
 * Pure: input is a SkillDiscoveryResult (see skills.ts), output is findings
 * plus a scope map; no fs access, no pi imports.
 *
 * Finding codes:
 *   - skill-unloadable (error): malformed frontmatter or empty description —
 *     pi silently does NOT load such a skill (the headline audit finding);
 *   - name-invalid (warning): validateSkillName rejected the name;
 *   - name-dir-mismatch (warning): frontmatter name ≠ directory name (pi does not warn);
 *   - description-too-long (error): description over 1024 chars (pi silently does not load);
 *   - unknown-frontmatter-key (info): keys outside the 7 spec fields;
 *   - name-collision (warning): from the discovery collision list (first-wins);
 *   - broken-reference (warning): relative paths mentioned in the SKILL.md body
 *     (backtick spans and markdown `](…)` links) that are missing from the
 *     skill's file inventory; http(s):, mailto:, other schemes, `#anchors` and
 *     absolute paths are ignored; candidates must look like file paths (see
 *     KNOWN_EXTENSIONS / isIgnoredCandidate — globs, domains without scheme,
 *     home paths, placeholders and owner/repo shorthands are not references);
 *     a bare name resolves when an inventory path segment-ends with it
 *     (`cost.py` → `scripts/cost.py`);
 *   - orphan-file (info): inventory files the body never references
 *     (SKILL.md itself and hidden files are never orphans); references resolve
 *     through the same single resolver, so a suffix-resolved file is never an
 *     orphan;
 *   - vague-description (warning): heuristic — a description without any
 *     routing trigger (see ROUTING_TRIGGERS) may never be selected by the
 *     model; false positives/negatives are possible by design;
 *   - personal-content (warning): home paths (Windows `C:\Users\<user>`,
 *     `/Users/<user>`, `/home/<user>`) and email addresses in the description
 *     or body; with `opts.username` only that user's home paths are flagged,
 *     without it a generic `<user>` pattern is matched.
 *
 * At most one finding per (skill, code): aggregate codes enumerate every
 * occurrence in the message. Findings are sorted by skill → severity → code →
 * message, so output is deterministic.
 */
import { validateSkillName } from "./skills.ts";
import type { SkillDiscoveryResult, SkillNameCollision, SkillRecord } from "./skills.ts";

export type FindingSeverity = "error" | "warning" | "info";

export type FindingCode =
	| "skill-unloadable"
	| "name-invalid"
	| "name-dir-mismatch"
	| "description-too-long"
	| "unknown-frontmatter-key"
	| "name-collision"
	| "broken-reference"
	| "orphan-file"
	| "vague-description"
	| "personal-content";

export interface Finding {
	/** Skill name (frontmatter name, or the directory name when there is none). */
	skill: string;
	severity: FindingSeverity;
	code: FindingCode;
	/** Short English message with the concrete path/value. */
	message: string;
}

export interface AuditOptions {
	/** Current OS username; when given, only that user's home paths are flagged. */
	username?: string;
}

/** One row of the scope map: where a skill name lives (user vs project). */
export interface ScopeMapEntry {
	name: string;
	scope: "user" | "project";
	/** Skills root the skill lives in (the project path for project scope). */
	location: string;
	/** Absolute path of the skill directory. */
	dir: string;
	/** Another directory claimed this name first — pi loads the other copy. */
	shadowed: boolean;
}

export interface SkillAuditResult {
	findings: Finding[];
	scopeMap: ScopeMapEntry[];
}

const SPEC_FRONTMATTER_KEYS = new Set([
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
	"disable-model-invocation",
]);

const DESCRIPTION_MAX_LENGTH = 1024;

/** Расширения, делающие голое имя/путь кандидатом в ссылку на файл скилла. */
const KNOWN_EXTENSIONS = new Set([
	".md",
	".py",
	".ts",
	".js",
	".mjs",
	".cjs",
	".sh",
	".json",
	".txt",
	".html",
	".css",
	".yaml",
	".yml",
	".toml",
]);

/** Расширение последнего сегмента пути в нижнем регистре; "" без точки. */
const extensionOf = (path: string): string => {
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	return dot > slash ? path.slice(dot).toLowerCase() : "";
};

/**
 * Кандидаты, не являющиеся ссылками на файлы скилла. Это эвристика против
 * шума реальных баз: glob-паттерны со звёздочками и фигурными скобками
 * (`*.py`, `**`), домены без схемы
 * (`store.steampowered.com/app/...`), home-пути (`~/.pi/agent/sessions/`),
 * точечные свойства (`.outerHTML`), ВСЕКАПС-плейсхолдеры (`YYYY-MM`, `TODO`,
 * `<...>`) и ellipsis-срезы. Домен проверяется только для путей со слэшем:
 * голые имена вида `cost.py`/`CLAUDE.md` на домен не похожи и проверяются
 * обычным резолвом.
 */
function isIgnoredCandidate(raw: string): boolean {
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return true; // home-путь
	if (/[*{}]/.test(raw)) return true; // glob: *, **, {a,b}
	if (raw.includes("...")) return true; // срез/усечение: path/to/...
	if (raw.includes("/") && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) return true; // домен без схемы
	if (/^\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(raw)) return true; // .outerHTML / .env.local — свойство
	if (/\b(?:YYYY|MM|TODO)\b/.test(raw)) return true; // ВСЕКАПС-плейсхолдеры
	if (/<[^<>]*>/.test(raw)) return true; // <Project>, <button>…</button>
	return false;
}

/**
 * Похоже ли на путь файла/каталога: голое имя — только с известным расширением;
 * путь со слэшем — с известным расширением либо явный каталог (хвостовой слэш).
 * Прочее (owner/repo shorthand вроде `kepano/obsidian-skills`, `document.body`)
 * ссылкой на файл не считается. Остаточный шум — концептуальные ссылки на файлы
 * проекта (CLAUDE.md, docs/specs/, package.json) и явные каталоги — остаётся
 * флагаться намеренно: задокументированная эвристика, не истина в последней инстанции.
 */
function isFileLikeCandidate(raw: string, normalized: string): boolean {
	const known = KNOWN_EXTENSIONS.has(extensionOf(normalized));
	if (known) return true;
	return (raw.includes("/") || raw.includes("\\")) && (raw.endsWith("/") || raw.endsWith("\\"));
}

/**
 * Единый резолв кандидата по инвентарю: точное совпадение либо сегментный
 * (case-insensitive) суффикс какого-нибудь пути инвентаря — `cost.py` закрывает
 * `scripts/cost.py`. Возвращает нормализованный путь инвентаря или null.
 */
function resolveAgainstInventory(normalized: string, inventory: string[]): string | null {
	if (inventory.includes(normalized)) return normalized;
	const lower = normalized.toLowerCase();
	return inventory.find((file) => file.toLowerCase().endsWith(`/${lower}`)) ?? null;
}

// Эвристика роутинга: description без триггера вряд ли выберется моделью.
// Возможны ложные срабатывания (хорошие description, сформулированные иначе)
// и пропуски — это warning-эвристика, не истина в последней инстанции.
const ROUTING_TRIGGERS = [
	"use when",
	"when the user",
	"используй когда",
	"используй, когда",
	"если пользователь",
	"когда пользователь",
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
const SCOPE_RANK: Record<ScopeMapEntry["scope"], number> = { user: 0, project: 1 };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Audit discovered skills: mechanical findings plus a scope map (which names
 * live where: user vs project, which project path). Deterministic.
 */
export function auditSkills(discovery: SkillDiscoveryResult, opts: AuditOptions = {}): SkillAuditResult {
	const findings: Finding[] = [];
	for (const skill of discovery.skills) findings.push(...auditSkill(skill, opts.username));
	findings.push(...auditCollisions(discovery.collisions));
	findings.sort(
		(a, b) =>
			compareStrings(a.skill, b.skill) ||
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
			compareStrings(a.code, b.code) ||
			compareStrings(a.message, b.message),
	);
	const shadowedDirs = new Set(discovery.collisions.map((collision) => collision.loserDir));
	const scopeMap: ScopeMapEntry[] = discovery.skills
		.map(
			(skill): ScopeMapEntry => ({
				name: skill.name,
				scope: skill.scope,
				location: skill.location,
				dir: skill.dir,
				shadowed: shadowedDirs.has(skill.dir),
			}),
		)
		.sort(
			(a, b) =>
				compareStrings(a.name, b.name) || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || compareStrings(a.dir, b.dir),
		);
	return { findings, scopeMap };
}

function auditSkill(skill: SkillRecord, username: string | undefined): Finding[] {
	const findings: Finding[] = [];
	if (skill.malformed) {
		findings.push({
			skill: skill.name,
			severity: "error",
			code: "skill-unloadable",
			message: "SKILL.md has no closed frontmatter block — pi silently skips this skill",
		});
	} else if (skill.description === "") {
		findings.push({
			skill: skill.name,
			severity: "error",
			code: "skill-unloadable",
			message: "frontmatter has no description — pi silently skips this skill",
		});
	}
	const nameReason = validateSkillName(skill.name);
	if (nameReason !== null) {
		findings.push({
			skill: skill.name,
			severity: "warning",
			code: "name-invalid",
			message: `invalid skill name "${skill.name}": ${nameReason}`,
		});
	}
	if (skill.name !== skill.dirName) {
		findings.push({
			skill: skill.name,
			severity: "warning",
			code: "name-dir-mismatch",
			message: `frontmatter name "${skill.name}" does not match directory name "${skill.dirName}"`,
		});
	}
	if (skill.description.length > DESCRIPTION_MAX_LENGTH) {
		findings.push({
			skill: skill.name,
			severity: "error",
			code: "description-too-long",
			message: `description is ${skill.description.length} characters (max ${DESCRIPTION_MAX_LENGTH})`,
		});
	}
	const unknownKeys = Object.keys(skill.attrs).filter((key) => !SPEC_FRONTMATTER_KEYS.has(key));
	if (unknownKeys.length > 0) {
		findings.push({
			skill: skill.name,
			severity: "info",
			code: "unknown-frontmatter-key",
			message: `unknown frontmatter keys: ${unknownKeys.map((key) => `"${key}"`).join(", ")}`,
		});
	}

	const inventory = skill.files.map(normalizeSlashes);
	const broken: string[] = [];
	const referenced = new Set<string>();
	for (const reference of extractReferences(skill.body)) {
		// Выход за корень скилла — sentinel normalizeRelativePath: путь по построению,
		// всегда вне инвентаря; эвристики игнора/валидности к нему не применяются.
		if (reference.normalized !== "..") {
			if (isIgnoredCandidate(reference.raw)) continue;
			if (!isFileLikeCandidate(reference.raw, reference.normalized)) continue;
		}
		const resolved = resolveAgainstInventory(reference.normalized, inventory);
		if (resolved === null) broken.push(`"${reference.raw}" (line ${reference.line})`);
		else referenced.add(resolved);
	}
	if (broken.length > 0) {
		findings.push({
			skill: skill.name,
			severity: "warning",
			code: "broken-reference",
			message: `SKILL.md body references missing files: ${broken.join(", ")}`,
		});
	}
	const orphans = skill.files.filter((file) => {
		if (file === "SKILL.md") return false; // сам SKILL.md — не сирота
		if (file.split(/[\\/]/).some((segment) => segment.startsWith("."))) return false; // скрытые — не сироты
		return !referenced.has(normalizeSlashes(file));
	});
	if (orphans.length > 0) {
		findings.push({
			skill: skill.name,
			severity: "info",
			code: "orphan-file",
			message: `files not referenced from SKILL.md: ${orphans.map((file) => `"${file}"`).join(", ")}`,
		});
	}

	// Пустой description уже флагается skill-unloadable — второй раз как vague не ругаем.
	if (
		skill.description !== "" &&
		!ROUTING_TRIGGERS.some((trigger) => skill.description.toLowerCase().includes(trigger))
	) {
		findings.push({
			skill: skill.name,
			severity: "warning",
			code: "vague-description",
			message: 'description has no routing trigger (e.g. "use when ...") — the model may never select this skill',
		});
	}

	const personal = findPersonalContent(skill, username);
	if (personal.length > 0) {
		findings.push({
			skill: skill.name,
			severity: "warning",
			code: "personal-content",
			message: `personal content: ${personal.join("; ")}`,
		});
	}
	return findings;
}

/** Group collisions by name — one finding per name even with several losing copies. */
function auditCollisions(collisions: SkillNameCollision[]): Finding[] {
	const byName = new Map<string, { winners: string[]; losers: string[] }>();
	for (const collision of collisions) {
		const entry = byName.get(collision.name) ?? { winners: [], losers: [] };
		if (!entry.winners.includes(collision.winnerDir)) entry.winners.push(collision.winnerDir);
		entry.losers.push(collision.loserDir);
		byName.set(collision.name, entry);
	}
	return [...byName.entries()].map(([name, { winners, losers }]) => ({
		skill: name,
		severity: "warning" as const,
		code: "name-collision" as const,
		message: `name "${name}" is already claimed by ${winners.join(", ")} — shadowed copies: ${losers.join(", ")} (first-wins)`,
	}));
}

const normalizeSlashes = (path: string): string => path.replace(/\\/g, "/");

interface ReferenceOccurrence {
	/** Raw candidate as written in the body. */
	raw: string;
	/** 1-based line number in the body. */
	line: number;
	/** Path normalized against the file inventory (forward slashes, no `./`). */
	normalized: string;
}

/**
 * Relative-path candidates from backtick spans and markdown `](…)` links.
 * Whether a candidate is a file reference at all is decided later (see
 * isIgnoredCandidate / isFileLikeCandidate) — uniformly for both sources.
 * References to directories count as missing — the inventory lists files only.
 */
function extractReferences(body: string): ReferenceOccurrence[] {
	const occurrences: ReferenceOccurrence[] = [];
	const seen = new Set<string>();
	const lines = body.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const candidates: { raw: string; fromBacktick: boolean }[] = [];
		for (const match of line.matchAll(/`([^`\n]+)`/g)) {
			const raw = (match[1] ?? "").trim();
			if (raw !== "") candidates.push({ raw, fromBacktick: true });
		}
		for (const match of line.matchAll(/\]\(([^)]*)\)/g)) {
			let raw = (match[1] ?? "").trim();
			const spaceIndex = raw.search(/\s/); // [text](path "title") — заголовок отбрасываем
			if (spaceIndex !== -1) raw = raw.slice(0, spaceIndex).trim();
			if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
			if (raw !== "") candidates.push({ raw, fromBacktick: false });
		}
		for (const candidate of candidates) {
			if (seen.has(candidate.raw)) continue;
			const normalized = normalizeRelativePath(candidate.raw, candidate.fromBacktick);
			if (normalized === null) continue;
			seen.add(candidate.raw);
			occurrences.push({ raw: candidate.raw, line: index + 1, normalized });
		}
	}
	return occurrences;
}

/**
 * Reduce a raw candidate to an inventory-comparable path; null when it is not
 * a relative path at all (scheme like http(s):/mailto:/node:, `#anchor`,
 * absolute path, whitespace, empty). A `..` that escapes the skill directory
 * yields a path that is never in the inventory, i.e. reported as broken.
 */
function normalizeRelativePath(raw: string, fromBacktick: boolean): string | null {
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // http:, https:, mailto:, node: …
	if (raw.startsWith("#")) return null; // якорь
	if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[/\\]/.test(raw)) return null; // absolute
	if (/\s/.test(raw)) return null; // не путь
	const segments: string[] = [];
	for (const segment of raw.split(/[\\/]/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.pop() === undefined) return ".."; // выход за корень скилла
		} else {
			segments.push(segment);
		}
	}
	const candidate = segments.join("/");
	if (candidate === "") return null;
	// Бэктики матчатся щедро — берём только похоже на путь, чтобы не флагать произвольный код.
	if (fromBacktick && !candidate.includes("/") && !/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(candidate)) return null;
	return candidate;
}

function findPersonalContent(skill: SkillRecord, username: string | undefined): string[] {
	const patterns = username ? userHomePathPatterns(username) : genericHomePathPatterns();
	const parts: string[] = [];
	const descriptionHits = collectHits(skill.description, patterns);
	if (descriptionHits.length > 0) parts.push(`description: ${descriptionHits.map((hit) => `"${hit}"`).join(", ")}`);
	const bodyHits: string[] = [];
	const lines = skill.body.split("\n");
	for (let index = 0; index < lines.length; index++) {
		for (const hit of collectHits(lines[index] ?? "", patterns)) bodyHits.push(`"${hit}" (line ${index + 1})`);
	}
	if (bodyHits.length > 0) parts.push(`body: ${bodyHits.join(", ")}`);
	return parts;
}

// Символ внутри домашнего пути: не пробел, не кавычка/скобка/разделитель аргументов.
// Класс без квантификатора — квантификатор ставится в каждом шаблоне явно.
const HOME_PATH_CHAR = String.raw`[^\s"'` + "`" + String.raw`)\]},;]`;

/** Home-path patterns for a concrete user (personal paths of other users are not flagged). */
function userHomePathPatterns(username: string): RegExp[] {
	const safe = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		new RegExp(String.raw`[A-Za-z]:[\\/]+Users[\\/]+${safe}(?:[\\/]+${HOME_PATH_CHAR}*)?`, "g"),
		new RegExp(`/Users/${safe}(?:/${HOME_PATH_CHAR}*)?`, "g"),
		new RegExp(`/home/${safe}(?:/${HOME_PATH_CHAR}*)?`, "g"),
	];
}

/** Generic home-path patterns: any single path segment as the user name. */
function genericHomePathPatterns(): RegExp[] {
	return [
		new RegExp(String.raw`[A-Za-z]:[\\/]+Users[\\/]+${HOME_PATH_CHAR}+`, "g"),
		new RegExp(`/Users/${HOME_PATH_CHAR}+`, "g"),
		new RegExp(`/home/${HOME_PATH_CHAR}+`, "g"),
	];
}

/** All pattern matches in one line; earlier (longer) matches mask later overlapping ones. */
function collectHits(line: string, patterns: RegExp[]): string[] {
	const hits: string[] = [];
	let work = line;
	for (const pattern of [...patterns, EMAIL_PATTERN]) {
		work = work.replace(pattern, (match) => {
			hits.push(match);
			return "\0".repeat(match.length);
		});
	}
	return hits;
}
