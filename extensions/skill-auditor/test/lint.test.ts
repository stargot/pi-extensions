import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditSkills, type SkillAuditResult } from "../lint.ts";
import { discoverSkills } from "../skills.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

function writeSkill(dir: string, frontmatter: string, body = "Body."): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function writeSkillFile(skillDir: string, rel: string, content = "x"): void {
	mkdirSync(join(skillDir, dirname(rel)), { recursive: true });
	writeFileSync(join(skillDir, rel), content, "utf8");
}

/** Discover the single fixture location and audit it (as the CLI would). */
function auditLocation(loc: string, username?: string): SkillAuditResult {
	const discovery = discoverSkills([{ scope: "user", path: loc }]);
	return auditSkills(discovery, username === undefined ? {} : { username });
}

const codesOf = (result: SkillAuditResult, skill: string): string[] =>
	result.findings.filter((finding) => finding.skill === skill).map((finding) => finding.code);

const severitiesOf = (result: SkillAuditResult, code: string): string[] =>
	result.findings.filter((finding) => finding.code === code).map((finding) => finding.severity);

// ── skill-unloadable ─────────────────────────────────────────────────────────

test("auditSkills: skill-unloadable — malformed frontmatter and empty description (pi silently skips)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		mkdirSync(join(loc, "broken"), { recursive: true });
		writeFileSync(join(loc, "broken", "SKILL.md"), "No frontmatter at all.", "utf8");
		writeSkill(join(loc, "empty-desc"), "name: empty-desc");

		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "broken"), ["skill-unloadable"]);
		assert.deepEqual(codesOf(result, "empty-desc"), ["skill-unloadable"]);
		assert.deepEqual(severitiesOf(result, "skill-unloadable"), ["error", "error"]);
		const messages = result.findings.filter((f) => f.code === "skill-unloadable").map((f) => f.message);
		assert.match(messages[0] ?? "", /no closed frontmatter block/);
		assert.match(messages[1] ?? "", /no description/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── name-invalid ─────────────────────────────────────────────────────────────

test("auditSkills: name-invalid — validateSkillName reason is reported", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		// имя совпадает с каталогом, чтобы изолировать код от name-dir-mismatch
		writeSkill(join(loc, "Bad_Name"), "name: Bad_Name\ndescription: Use when naming things.");
		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "Bad_Name"), ["name-invalid"]);
		const finding = result.findings.find((f) => f.code === "name-invalid");
		assert.equal(finding?.severity, "warning");
		assert.match(finding?.message ?? "", /invalid skill name "Bad_Name"/);
		assert.match(finding?.message ?? "", /lowercase/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── name-dir-mismatch ────────────────────────────────────────────────────────

test("auditSkills: name-dir-mismatch — frontmatter name differs from directory name", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "pdf"), "name: pdf-tools\ndescription: Use when handling PDFs.");
		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "pdf-tools"), ["name-dir-mismatch"]);
		const finding = result.findings.find((f) => f.code === "name-dir-mismatch");
		assert.equal(finding?.severity, "warning");
		assert.match(finding?.message ?? "", /"pdf-tools" does not match directory name "pdf"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── description-too-long ─────────────────────────────────────────────────────

test("auditSkills: description-too-long — over 1024 chars is a warning (pi still loads the skill)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		const description = `Use when ${"x".repeat(1020)}`; // 1029 chars, с триггером против vague-description
		writeSkill(join(loc, "long"), `name: long\ndescription: ${description}`);
		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "long"), ["description-too-long"]);
		const finding = result.findings.find((f) => f.code === "description-too-long");
		assert.equal(finding?.severity, "warning", "pi грузит скилл с длинным description — это не отказ загрузки");
		assert.equal(
			finding?.message,
			"description is 1029 characters (max 1024) — pi still loads the skill (warning diagnostic); spec violation, not a load failure",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── unknown-frontmatter-key ──────────────────────────────────────────────────

test("auditSkills: unknown-frontmatter-key — keys outside the 7 spec fields, one info finding", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "keyed"), "name: keyed\ndescription: Use when keys matter.\nowner: bob\npriority: high");
		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "keyed"), ["unknown-frontmatter-key"]);
		const finding = result.findings.find((f) => f.code === "unknown-frontmatter-key");
		assert.equal(finding?.severity, "info");
		assert.match(finding?.message ?? "", /"owner", "priority"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── name-collision ───────────────────────────────────────────────────────────

test("auditSkills: name-collision — one warning per name, message names winner and loser, loser shadowed", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "alpha"), "name: dup\ndescription: Use when duplicating stuff.");
		writeSkill(join(loc, "zulu"), "name: dup\ndescription: Use when duplicating other stuff.");
		const result = auditLocation(loc);
		const findings = result.findings.filter((f) => f.code === "name-collision");
		assert.equal(findings.length, 1, "один код на скилл — одна находка");
		assert.equal(findings[0]?.skill, "dup");
		assert.equal(findings[0]?.severity, "warning");
		assert.match(findings[0]?.message ?? "", /first-wins/);
		assert.ok(findings[0]?.message.includes(join(loc, "alpha")));
		assert.ok(findings[0]?.message.includes(join(loc, "zulu")));
		const zulu = result.scopeMap.find((entry) => entry.dir === join(loc, "zulu"));
		const alpha = result.scopeMap.find((entry) => entry.dir === join(loc, "alpha"));
		assert.equal(zulu?.shadowed, true);
		assert.equal(alpha?.shadowed, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── broken-reference ─────────────────────────────────────────────────────────

test("auditSkills: broken-reference — missing links/backtick paths, ignores URLs, anchors, absolute, ../", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		const skillDir = join(loc, "refs");
		const body = [
			"Use [guide](docs/guide.md) and [formats](references/formats.md).",
			"Run `scripts/run.sh` or `./notes/absent.txt`. See [parent](../outside.md).",
			"Ignored: https://example.com/x.md, [anchor](#section), [abs](/etc/hosts), [mail](mailto:someone).",
			"Present file: `notes-present.txt`. Not a path: `npm run check` and `v1.2.3`.",
			"",
			"Also [dirlink](references) is a bare directory shorthand, not a file path.",
		].join("\n");
		writeSkill(skillDir, "name: refs\ndescription: Use when checking reference integrity.", body);
		writeSkillFile(skillDir, "scripts/run.sh");
		writeSkillFile(skillDir, "references/formats.md");
		writeSkillFile(skillDir, "notes-present.txt");

		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "refs"), ["broken-reference"]);
		const finding = result.findings.find((f) => f.code === "broken-reference");
		assert.equal(finding?.severity, "warning");
		const message = finding?.message ?? "";
		// все битые ссылки перечислены в одной находке, с номерами строк тела
		assert.ok(message.includes('"docs/guide.md" (line 1)'));
		assert.ok(message.includes('"./notes/absent.txt" (line 2)'));
		assert.ok(message.includes('"../outside.md" (line 2)'));
		// owner/repo-подобный кандидат без расширения и хвостового слэша — не файл
		assert.equal(message.includes('"references" (line 6)'), false);
		// существующие файлы и не-пути не флагаются
		assert.equal(message.includes("formats.md"), false);
		assert.equal(message.includes("run.sh"), false);
		assert.equal(message.includes("notes-present.txt"), false);
		assert.equal(message.includes("example.com"), false);
		assert.equal(message.includes("#section"), false);
		assert.equal(message.includes("/etc/hosts"), false);
		assert.equal(message.includes("mailto"), false);
		assert.equal(message.includes("npm run"), false);
		assert.equal(message.includes("v1.2.3"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── orphan-file ──────────────────────────────────────────────────────────────

test("auditSkills: orphan-file — unreferenced files listed, SKILL.md/hidden/referenced are not orphans", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		const skillDir = join(loc, "orph");
		writeSkill(
			skillDir,
			"name: orph\ndescription: Use when finding orphans.",
			"Data in `data.json`.\nMore in [extras](extras/readme.md).",
		);
		writeSkillFile(skillDir, "data.json");
		writeSkillFile(skillDir, "extras/readme.md");
		writeSkillFile(skillDir, "unused.txt");
		writeSkillFile(skillDir, join("references", "deep", "extra.md"));
		writeSkillFile(skillDir, ".secret-file");

		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "orph"), ["orphan-file"]);
		const finding = result.findings.find((f) => f.code === "orphan-file");
		assert.equal(finding?.severity, "info");
		const message = finding?.message ?? "";
		assert.ok(message.includes("unused.txt"));
		assert.ok(message.includes(join("references", "deep", "extra.md")));
		assert.equal(message.includes('"SKILL.md"'), false);
		assert.equal(message.includes(".secret-file"), false);
		assert.equal(message.includes("data.json"), false);
		assert.equal(message.includes("readme.md"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── broken-reference: FP-эвристика и суффикс-резолв ─────────────────────────

test("auditSkills: broken-reference — globs, placeholders, domains, home paths, properties and owner/repo are not file references", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		const body = [
			"Glob: `**/*.py`, `**/.obsidian`, `**/*query*.md`.",
			"Placeholders: `YYYY-MM`, `YYYY-MM-DD-<slug>-<type>.md`, `projects/<Project>/`.",
			"Domain: `store.steampowered.com/app/123/...` and `github.com/owner/repo`.",
			"Home: `~/.pi/agent/sessions/`. Property: `.outerHTML` and `document.body`.",
			"Repo shorthand: `kepano/obsidian-skills`.",
		].join("\n");
		writeSkill(join(loc, "fp"), "name: fp\ndescription: Use when checking false positives.", body);

		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "fp"), [], "ни один класс FP не должен дать broken-reference (или иную находку)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("auditSkills: bare names resolve by case-insensitive segment suffix — and are not orphans", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		const skillDir = join(loc, "suffix");
		const body = "Run `COST.PY` and `prompts.py`.\nFull path: `scripts/format.py`. Broken bare: `mat.py`.";
		writeSkill(skillDir, "name: suffix\ndescription: Use when resolving bare script names.", body);
		writeSkillFile(skillDir, "scripts/cost.py");
		writeSkillFile(skillDir, "scripts/prompts.py");
		writeSkillFile(skillDir, "scripts/format.py");

		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "suffix"), ["broken-reference"], "суффикс-резолв закрывает cost.py/prompts.py");
		const finding = result.findings.find((f) => f.code === "broken-reference");
		const message = finding?.message ?? "";
		assert.ok(message.includes('"mat.py"'), "границы сегментов соблюдаются: mat.py ≠ scripts/format.py");
		assert.equal(message.includes("cost.py"), false);
		assert.equal(message.includes("prompts.py"), false);
		assert.equal(message.includes("format.py"), false);
		assert.equal(
			result.findings.some((f) => f.code === "orphan-file"),
			false,
			"файл, закрытый суффикс-резолвом, не сирота (один резолв на broken и orphan)",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("auditSkills: broken-reference — conceptual project refs (CLAUDE.md, docs/specs/) remain flagged by design", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(
			join(loc, "concept"),
			"name: concept\ndescription: Use when documenting the heuristic.",
			"Project context: `CLAUDE.md` and [specs](docs/specs/).",
		);
		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "concept"), ["broken-reference"]);
		const message = result.findings.find((f) => f.code === "broken-reference")?.message ?? "";
		assert.ok(message.includes('"CLAUDE.md" (line 1)'));
		assert.ok(message.includes('"docs/specs/" (line 1)'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── vague-description ────────────────────────────────────────────────────────

test("auditSkills: vague-description — no routing trigger flags, triggered description stays clean", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "vague"), "name: vague\ndescription: Works with PDF files.");
		writeSkill(join(loc, "routed"), "name: routed\ndescription: Используй, когда пользователь просит разобрать PDF.");
		const result = auditLocation(loc);
		assert.deepEqual(codesOf(result, "vague"), ["vague-description"]);
		const finding = result.findings.find((f) => f.code === "vague-description");
		assert.equal(finding?.severity, "warning");
		assert.deepEqual(codesOf(result, "routed"), [], "русский триггер гасит находку");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── personal-content ─────────────────────────────────────────────────────────

test("auditSkills: personal-content — username matches home paths and emails, one aggregated finding", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(
			join(loc, "leak"),
			"name: leak\ndescription: Use when cleaning C:\\Users\\tester\\logs folders.",
			"Remote home /Users/tester/data must be cleaned.\nContact dev@example.com first.",
		);
		const result = auditLocation(loc, "tester");
		assert.deepEqual(codesOf(result, "leak"), ["personal-content"]);
		const finding = result.findings.find((f) => f.code === "personal-content");
		assert.equal(finding?.severity, "warning");
		const message = finding?.message ?? "";
		assert.ok(message.includes('description: "C:\\Users\\tester\\logs"'));
		assert.ok(message.includes('"/Users/tester/data" (line 1)'));
		assert.ok(message.includes('"dev@example.com" (line 2)'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("auditSkills: personal-content — without username generic patterns match any user", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(
			join(loc, "generic"),
			"name: generic\ndescription: Use when deploying configs.",
			"Configs live in /Users/someone/else/home dir.",
		);
		const generic = auditLocation(loc);
		const finding = generic.findings.find((f) => f.code === "personal-content");
		assert.ok(finding, "generic /Users/<что-то> флагается без username");
		assert.ok(finding?.message.includes('"/Users/someone/else/home" (line 1)'));

		const strict = auditLocation(loc, "tester");
		assert.deepEqual(codesOf(strict, "generic"), [], "чужой домашний путь при заданном username не флагается");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── негативный контроль: валидный скилл не даёт находок ─────────────────────

test("auditSkills: fully valid skill produces zero findings, scopeMap has one unshadowed entry", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		const skillDir = join(loc, "pdf-tools");
		const frontmatter = [
			"name: pdf-tools",
			"description: Extract text from PDF files. Use when the user asks to read or extract PDFs.",
			"license: MIT",
			"compatibility: Requires poppler-utils.",
			"allowed-tools: read, bash",
			"disable-model-invocation: false",
			"metadata:",
			"  owner: team",
		].join("\n");
		const body = [
			"# PDF tools",
			"",
			"Run `scripts/extract.sh` and read [formats](references/formats.md).",
			"Notes live in [notes](notes.md).",
		].join("\n");
		writeSkill(skillDir, frontmatter, body);
		writeSkillFile(skillDir, "scripts/extract.sh");
		writeSkillFile(skillDir, "references/formats.md");
		writeSkillFile(skillDir, "notes.md");

		const result = auditLocation(loc);
		assert.deepEqual(result.findings, [], "валидный скилл не должен давать ни одной находки");
		assert.deepEqual(result.scopeMap, [
			{ name: "pdf-tools", scope: "user", location: loc, dir: skillDir, shadowed: false },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── детерминизм и сортировка ─────────────────────────────────────────────────

test("auditSkills: findings are deterministic and sorted by skill → severity → code → message", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "aa"), "name: AA\ndescription: Use when testing order."); // name-invalid + name-dir-mismatch
		writeSkill(join(loc, "dup-x", "dup"), "name: dup\ndescription: Use when duplicating stuff.");
		writeSkill(join(loc, "dup-y", "dup"), "name: dup\ndescription: Use when duplicating other stuff.");
		mkdirSync(join(loc, "mm"), { recursive: true });
		writeFileSync(join(loc, "mm", "SKILL.md"), "No frontmatter.", "utf8"); // skill-unloadable
		writeSkill(join(loc, "zz"), "name: zz\ndescription: Generic helper for everything."); // vague-description

		const discovery = discoverSkills([{ scope: "user", path: loc }]);
		const first = auditSkills(discovery);
		const second = auditSkills(discovery);
		assert.deepEqual(first, second, "два прогона по одним данным — одинаковый результат");

		assert.deepEqual(
			first.findings.map((f) => [f.skill, f.severity, f.code]),
			[
				["AA", "warning", "name-dir-mismatch"],
				["AA", "warning", "name-invalid"],
				["dup", "warning", "name-collision"],
				["mm", "error", "skill-unloadable"],
				["zz", "warning", "vague-description"],
			],
			"сортировка: skill asc, затем severity (error<warning<info), затем code asc",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── карта скоупов ────────────────────────────────────────────────────────────

test("auditSkills: scopeMap separates user vs project and marks shadowed copies (project-first, как в pi)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const userLoc = join(root, "user-skills");
		const projectLoc = join(root, "project", ".agents", "skills");
		writeSkill(join(userLoc, "tool"), "name: tool\ndescription: Use when fixing tools.");
		writeSkill(join(projectLoc, "tool"), "name: tool\ndescription: Use when fixing tools locally.");
		writeSkill(join(projectLoc, "app"), "name: app\ndescription: Use when running the app.");

		// Локации в порядке pi: проектные раньше пользовательских → проект побеждает коллизию.
		const discovery = discoverSkills([
			{ scope: "project", path: projectLoc },
			{ scope: "user", path: userLoc },
		]);
		const result = auditSkills(discovery);
		assert.deepEqual(result.scopeMap, [
			{ name: "app", scope: "project", location: projectLoc, dir: join(projectLoc, "app"), shadowed: false },
			// отображение сортируется name → user перед project; перевернулись только флаги shadowed
			{ name: "tool", scope: "user", location: userLoc, dir: join(userLoc, "tool"), shadowed: true },
			{ name: "tool", scope: "project", location: projectLoc, dir: join(projectLoc, "tool"), shadowed: false },
		]);
		assert.equal(result.findings.filter((f) => f.code === "name-collision").length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
