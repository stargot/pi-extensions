/**
 * Skill discovery for the skill-auditor extension: frontmatter parsing, name
 * validation and location/record discovery, mirroring how pi itself loads
 * skills (docs/skills.md; pi 0.85.1 dist: package-manager.js
 * addAutoDiscoveredResources → resource-loader → loadSkills first-wins):
 *
 *   - project skills live in `<cwd>/.pi/skills` and in `.agents/skills`,
 *     discovered from cwd through its ancestors, stopping at the repository
 *     root (dir with `.git`), which is itself included; project locations come
 *     first, so a project skill shadows a same-name user skill (pi gates the
 *     project locations behind the trusted-project flag — the auditor reports
 *     them unconditionally);
 *   - user skills live in `<agentDir>/skills` and then `~/.agents/skills`;
 *   - a directory containing SKILL.md is a skill root — recursion does not
 *     descend into it;
 *   - name collisions keep the first discovered skill (earlier locations and,
 *     within a location, lexicographically earlier dirs win) and the losers
 *     are reported separately;
 *   - pi silently skips unreadable/malformed SKILL.md files — discovery keeps
 *     them as records (with `malformed` / empty `description`) so the auditor
 *     can report what pi silently dropped.
 *
 * Deviations from pi, accepted for v1: children are visited in sorted order
 * (deterministic first-wins), hidden directories (`.`-prefixed) and
 * `node_modules` are not descended into, symlinks are not followed.
 *
 * Deliberately dependency-free (no pi imports) so tests and the CLI run
 * standalone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export type SkillScope = "user" | "project";

export interface SkillLocation {
	scope: SkillScope;
	/** Absolute path of the skills root. Only existing directories are listed. */
	path: string;
}

/** Result of parseSkillFrontmatter. */
export interface ParsedSkillFile {
	/** Top-level `key: value` pairs. Nested YAML blocks are not expanded — a bare
	 * `metadata:` key records the fact of presence with an empty value. */
	attrs: Record<string, string>;
	/** Content after the frontmatter (trimmed); the whole input when there is no
	 * usable frontmatter block. */
	body: string;
	/** True when the file does not start with a closed `--- … ---` block — pi
	 * silently skips such files. */
	malformed: boolean;
}

export interface SkillRecord {
	/** Frontmatter name; falls back to the directory name like pi does. */
	name: string;
	/** Basename of the skill directory. */
	dirName: string;
	/** Frontmatter description, trimmed; "" when absent (pi does not load such skills). */
	description: string;
	/** All frontmatter keys as parsed (raw string values), incl. unknown ones. */
	attrs: Record<string, string>;
	disableModelInvocation: boolean;
	/** Markdown body after the frontmatter (trimmed). */
	body: string;
	/** Absolute path of the skill directory. */
	dir: string;
	scope: SkillScope;
	/** Absolute path of the skills root this skill was found in. */
	location: string;
	/** Relative inventory of regular files in the skill directory (recursive,
	 * platform separators, hidden dirs and node_modules skipped). */
	files: string[];
	/** SKILL.md has no closed frontmatter block. */
	malformed: boolean;
}

/** Two directories claimed the same skill name; first found keeps it. */
export interface SkillNameCollision {
	name: string;
	/** Directory of the skill that won (first discovered). */
	winnerDir: string;
	/** Directory of the skill that lost. */
	loserDir: string;
}

export interface SkillDiscoveryResult {
	/** All found skills, including collision losers and records pi would not load. */
	skills: SkillRecord[];
	collisions: SkillNameCollision[];
}

/**
 * Parse `---\nkey: value\n…\n---\nbody`. Minimal YAML subset (same style as
 * subagents/agents.ts): one top-level `key: value` per line, values may be
 * single/double-quoted or bare; `\r\n` is normalized first. Indented lines
 * (nested blocks like `metadata:`) are not top-level keys and are ignored —
 * the bare key still records presence. Keys keep their original case.
 *
 * Block scalars are supported for single-line use in descriptions: `key: >`
 * (folded — newlines become spaces) and `key: |` (literal — newlines kept),
 * with optional chomping indicator (`>-`, `|+`, …). The block spans the
 * indented lines that follow (indentation of the first content line is
 * stripped) until a dedent or the closing fence; edge quotes are trimmed.
 */
export function parseSkillFrontmatter(raw: string): ParsedSkillFile {
	const normalized = raw.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const empty: ParsedSkillFile = { attrs: {}, body: normalized.trim(), malformed: true };
	if ((lines[0] ?? "").trim() !== "---") return empty;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return empty;

	const attrs: Record<string, string> = {};
	let index = 1;
	while (index < close) {
		const line = lines[index] ?? "";
		index++;
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1] ?? "";
		const value = (match[2] ?? "").trim();
		// Блочный скаляр: потребляем следующие строки целиком (индекс двигаем сами).
		if (/^[|>][+-]?$/.test(value)) {
			const block = readBlockScalar(lines, index, close, value.startsWith("|"));
			attrs[key] = unquote(block.text);
			index = block.next;
		} else {
			attrs[key] = unquote(value);
		}
	}
	return {
		attrs,
		body: lines
			.slice(close + 1)
			.join("\n")
			.trim(),
		malformed: false,
	};
}

const unquote = (value: string): string =>
	(value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))
		? value.slice(1, -1)
		: value;

/**
 * Consume a YAML block scalar body between `start` (first line after
 * `key: >`/`key: |`) and `close` (closing fence). The block indent is the
 * indentation of the first non-empty line; a dedent ends the block. Folded
 * (`>`) joins lines with spaces (blank paragraph separators are dropped);
 * literal (`|`) keeps newlines.
 */
function readBlockScalar(
	lines: string[],
	start: number,
	close: number,
	literal: boolean,
): { text: string; next: number } {
	const collected: string[] = [];
	let blockIndent = -1;
	let index = start;
	while (index < close) {
		const line = lines[index] ?? "";
		if (line.trim() === "") {
			collected.push("");
			index++;
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (blockIndent === -1) blockIndent = indent;
		if (indent < blockIndent) break; // dedent — блок закончился
		collected.push(line.slice(blockIndent).trimEnd());
		index++;
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
	const text = (literal ? collected.join("\n") : collected.filter((line) => line !== "").join(" ")).trim();
	return { text, next: index };
}

/**
 * Validate a skill name per the Agent Skills spec: `^[a-z0-9]+(-[a-z0-9]+)*$`,
 * at most 64 chars (no leading/trailing/consecutive hyphens). Returns null when
 * valid, otherwise a human-readable reason.
 */
export function validateSkillName(name: string): string | null {
	if (name.length === 0) return "name is empty";
	if (name.length > 64) return `name is ${name.length} characters long (max 64)`;
	if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return null;
	if (/[A-Z]/.test(name)) return "name must be lowercase (a-z, 0-9, hyphens only)";
	if (name.startsWith("-") || name.endsWith("-")) return "name must not start or end with a hyphen";
	if (name.includes("--")) return "name must not contain consecutive hyphens";
	return "name must contain only lowercase letters, digits and hyphens";
}

/**
 * Skill locations for cwd, in pi's insertion order (0.85.1:
 * addAutoDiscoveredResources; resource-loader passes them to loadSkills in
 * this order and addSkills keeps the first copy of a name — project beats
 * user on collision):
 *
 *   1. `<cwd>/.pi/skills` — project skills;
 *   2. `.agents/skills` dirs from cwd upward, nearest first; the repo root
 *      (dir containing `.git`) is included and ends the walk;
 *   3. user skills dir `$PI_CODING_AGENT_DIR || ~/.pi/agent` + `/skills`;
 *   4. `~/.agents/skills`.
 *
 * pi shows the project locations (1–2) only when the project is trusted; the
 * auditor reports them unconditionally. Missing directories are silently
 * omitted — never an error.
 */
export function discoverSkillLocations(cwd: string, env: NodeJS.ProcessEnv = process.env): SkillLocation[] {
	const locations: SkillLocation[] = [];
	if (isDirectory(join(cwd, ".pi", "skills"))) {
		locations.push({ scope: "project", path: join(cwd, ".pi", "skills") });
	}

	let current = resolve(cwd);
	for (;;) {
		const projectSkills = join(current, ".agents", "skills");
		if (isDirectory(projectSkills)) locations.push({ scope: "project", path: projectSkills });
		if (existsSync(join(current, ".git"))) break; // корень репо включён, выше не идём
		const parent = dirname(current);
		if (parent === current) break; // корень файловой системы
		current = parent;
	}

	// || вместо ??: пустой PI_CODING_AGENT_DIR дал бы join('', 'skills') (прецедент shared/sessions.ts).
	const userSkills = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills");
	if (isDirectory(userSkills)) locations.push({ scope: "user", path: userSkills });

	const homeAgentsSkills = join(homedir(), ".agents", "skills");
	if (isDirectory(homeAgentsSkills)) locations.push({ scope: "user", path: homeAgentsSkills });

	return locations;
}

const SKIP_DIR_NAMES = new Set(["node_modules"]);
const byEntryName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Discover skills in the given locations (order defines first-wins). Returns
 * every found skill plus the name-collision losers. Unreadable directories and
 * SKILL.md files are silently skipped.
 */
export function discoverSkills(locations: SkillLocation[]): SkillDiscoveryResult {
	const skills: SkillRecord[] = [];
	const collisions: SkillNameCollision[] = [];
	const claimed = new Map<string, string>(); // name -> dir of the winner
	for (const location of locations) {
		walk(location, location.path, skills, claimed, collisions);
	}
	return { skills, collisions };
}

function walk(
	location: SkillLocation,
	dir: string,
	skills: SkillRecord[],
	claimed: Map<string, string>,
	collisions: SkillNameCollision[],
): void {
	if (isFile(join(dir, "SKILL.md"))) {
		addSkill(location, dir, skills, claimed, collisions);
		return; // skill root: не рекурсируем внутрь (как pi)
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // нечитаемый каталог — молча skip
	}
	for (const entry of entries.sort(byEntryName)) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
		walk(location, join(dir, entry.name), skills, claimed, collisions);
	}
}

function addSkill(
	location: SkillLocation,
	dir: string,
	skills: SkillRecord[],
	claimed: Map<string, string>,
	collisions: SkillNameCollision[],
): void {
	let raw: string;
	try {
		raw = readFileSync(join(dir, "SKILL.md"), "utf8");
	} catch {
		return; // нечитаемый SKILL.md — молча skip
	}
	const parsed = parseSkillFrontmatter(raw);
	const dirName = basename(dir);
	const record: SkillRecord = {
		// pi: имя из frontmatter, иначе — имя каталога.
		name: parsed.attrs["name"]?.trim() || dirName,
		dirName,
		description: parsed.attrs["description"]?.trim() ?? "",
		attrs: parsed.attrs,
		disableModelInvocation: (parsed.attrs["disable-model-invocation"]?.trim().toLowerCase() ?? "") === "true",
		body: parsed.body,
		dir,
		scope: location.scope,
		location: location.path,
		files: listSkillFiles(dir),
		malformed: parsed.malformed,
	};
	skills.push(record);
	const winnerDir = claimed.get(record.name);
	if (winnerDir !== undefined) collisions.push({ name: record.name, winnerDir, loserDir: dir });
	else claimed.set(record.name, dir);
}

/** Relative inventory of regular files under dir (sorted walk, like walk()). */
function listSkillFiles(dir: string): string[] {
	const files: string[] = [];
	const visit = (current: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort(byEntryName)) {
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
				visit(join(current, entry.name));
			} else if (entry.isFile()) {
				files.push(relative(dir, join(current, entry.name)));
			}
		}
	};
	visit(dir);
	return files;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
