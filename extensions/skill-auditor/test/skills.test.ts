import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { discoverSkillLocations, discoverSkills, parseSkillFrontmatter, validateSkillName } from "../skills.ts";

// ── parseSkillFrontmatter ────────────────────────────────────────────────────

test("parseSkillFrontmatter: full frontmatter, nested metadata recorded as presence", () => {
	const parsed = parseSkillFrontmatter(
		[
			"---",
			"name: pdf-tools",
			"description: Extract text from PDFs. Use when reading PDFs.",
			"license: MIT",
			"compatibility: needs poppler",
			"allowed-tools: read, bash",
			"disable-model-invocation: true",
			"metadata:",
			"  owner: bob",
			"  version: 2",
			"---",
			"",
			"# PDF tools",
			"",
			"Run scripts/extract.sh.",
			"",
		].join("\n"),
	);
	assert.equal(parsed.malformed, false);
	assert.equal(parsed.attrs["name"], "pdf-tools");
	assert.equal(parsed.attrs["description"], "Extract text from PDFs. Use when reading PDFs.");
	assert.equal(parsed.attrs["license"], "MIT");
	assert.equal(parsed.attrs["compatibility"], "needs poppler");
	assert.equal(parsed.attrs["allowed-tools"], "read, bash");
	assert.equal(parsed.attrs["disable-model-invocation"], "true");
	// вложенный блок не разворачивается, но факт присутствия зафиксирован
	assert.equal(parsed.attrs["metadata"], "");
	assert.equal("owner" in parsed.attrs, false);
	assert.equal(parsed.body, "# PDF tools\n\nRun scripts/extract.sh.");
});

test("parseSkillFrontmatter: strips single and double quotes", () => {
	const parsed = parseSkillFrontmatter("---\nname: 'quoted'\ndescription: \"Double quoted\"\n---\nBody.");
	assert.equal(parsed.attrs["name"], "quoted");
	assert.equal(parsed.attrs["description"], "Double quoted");
});

test("parseSkillFrontmatter: handles CRLF line endings", () => {
	const parsed = parseSkillFrontmatter("---\r\nname: crlf\r\ndescription: d\r\n---\r\n\r\nBody.");
	assert.equal(parsed.malformed, false);
	assert.equal(parsed.attrs["name"], "crlf");
	assert.equal(parsed.body, "Body.");
});

test("parseSkillFrontmatter: no frontmatter → malformed, whole input is body", () => {
	const parsed = parseSkillFrontmatter("Just a body, no frontmatter.");
	assert.equal(parsed.malformed, true);
	assert.deepEqual(parsed.attrs, {});
	assert.equal(parsed.body, "Just a body, no frontmatter.");
});

test("parseSkillFrontmatter: unclosed frontmatter → malformed, nothing lost", () => {
	const raw = "---\nname: x\ndescription: d\n\nBody without a closing fence.";
	const parsed = parseSkillFrontmatter(raw);
	assert.equal(parsed.malformed, true);
	assert.deepEqual(parsed.attrs, {});
	assert.equal(parsed.body, raw);
});

test("parseSkillFrontmatter: empty frontmatter block is closed and valid", () => {
	const parsed = parseSkillFrontmatter("---\n---\nBody.");
	assert.equal(parsed.malformed, false);
	assert.deepEqual(parsed.attrs, {});
	assert.equal(parsed.body, "Body.");
});

test("parseSkillFrontmatter: folded (>) block scalar — newlines become spaces, dedent ends the block", () => {
	const parsed = parseSkillFrontmatter(
		[
			"---",
			"name: folded",
			"description: >",
			"  Аудит скиллов pi-агента:",
			"  структура SKILL.md, ссылки и файлы.",
			"",
			"  Используй когда пользователь просит проверить скиллы.",
			"license: MIT",
			"---",
			"",
			"Body.",
		].join("\n"),
	);
	assert.equal(parsed.malformed, false);
	assert.equal(
		parsed.attrs["description"],
		"Аудит скиллов pi-агента: структура SKILL.md, ссылки и файлы. Используй когда пользователь просит проверить скиллы.",
	);
	assert.equal(parsed.attrs["license"], "MIT", "ключ после dedent парсится как top-level");
	assert.equal(parsed.body, "Body.");
});

test("parseSkillFrontmatter: literal (|) block scalar keeps newlines; chomping and edge quotes are stripped", () => {
	const literal = parseSkillFrontmatter(
		"---\nname: lit\ndescription: |\n  Первая строка.\n  Вторая строка.\n---\nBody.",
	);
	assert.equal(literal.attrs["description"], "Первая строка.\nВторая строка.");

	const chomped = parseSkillFrontmatter('---\nname: ch\ndescription: >-\n  "Use when auditing skills"\n---\nBody.');
	assert.equal(chomped.attrs["description"], "Use when auditing skills");
});

// ── validateSkillName ────────────────────────────────────────────────────────

test("validateSkillName: accepts valid names incl. 64 chars", () => {
	assert.equal(validateSkillName("pdf-tools"), null);
	assert.equal(validateSkillName("a"), null);
	assert.equal(validateSkillName("v2-ripper-9000"), null);
	assert.equal(validateSkillName("a".repeat(64)), null);
});

test("validateSkillName: rejects uppercase, wrong length, bad hyphens, empty", () => {
	assert.match(validateSkillName("PDF-tools") ?? "", /lowercase/);
	assert.match(validateSkillName("a".repeat(65)) ?? "", /max 64/);
	assert.match(validateSkillName("-leading") ?? "", /hyphen/);
	assert.match(validateSkillName("trailing-") ?? "", /hyphen/);
	assert.match(validateSkillName("dou--ble") ?? "", /consecutive/);
	assert.match(validateSkillName("") ?? "", /empty/);
});

// ── discoverSkillLocations ───────────────────────────────────────────────────

test("discoverSkillLocations: user location from PI_CODING_AGENT_DIR", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		const locations = discoverSkillLocations(join(root, "cwd"), { PI_CODING_AGENT_DIR: agentDir });
		// project-находки вне фикстуры (например, реальные ~/.agents/skills машины) не учитываем
		assert.deepEqual(
			locations.filter((l) => l.scope === "user"),
			[{ scope: "user", path: join(agentDir, "skills") }],
		);
		assert.equal(
			locations.some((l) => l.scope === "project" && l.path.startsWith(root + sep)),
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkillLocations: project chain nearest-first, without .git walks all ancestors", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "mid", ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "mid", "deep", "leaf"), { recursive: true });
		const locations = discoverSkillLocations(join(root, "mid", "deep", "leaf"), {
			PI_CODING_AGENT_DIR: join(root, "absent-agent"),
		});
		const project = locations.filter((l) => l.scope === "project" && l.path.startsWith(root + sep));
		assert.deepEqual(
			project.map((l) => [l.scope, l.path]),
			[
				["project", join(root, "mid", ".agents", "skills")],
				["project", join(root, ".agents", "skills")],
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkillLocations: repo root (.git) is included and stops the walk", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "a", ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "a", "b", ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "a", "b", "c"), { recursive: true });
		const locations = discoverSkillLocations(join(root, "a", "b", "c"), {
			PI_CODING_AGENT_DIR: join(root, "absent-agent"),
		});
		assert.deepEqual(
			locations.map((l) => l.path),
			[
				join(root, "a", "b", ".agents", "skills"),
				join(root, "a", ".agents", "skills"),
				join(root, ".agents", "skills"),
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkillLocations: missing directories are not an error", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		// ни <agentDir>/skills, ни .agents/skills внутри фикстуры не существует;
		// находки выше фикстуры (реальные каталоги машины) не учитываем
		const locations = discoverSkillLocations(root, { PI_CODING_AGENT_DIR: join(root, "absent-agent") });
		assert.equal(
			locations.some((l) => l.scope === "user"),
			false,
		);
		assert.deepEqual(
			locations.filter((l) => l.scope === "project" && l.path.startsWith(root + sep)),
			[],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── discoverSkills ───────────────────────────────────────────────────────────

function writeSkill(dir: string, frontmatter: string, body = "Body."): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

test("discoverSkills: recursive discovery, fields, inventory, hidden/node_modules/plain skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "pdf"), "name: pdf\ndescription: PDFs.");
		writeSkill(join(loc, "deep", "nested", "other"), "name: other\ndescription: Nested.");
		writeSkill(join(loc, "outer"), "description: No name in frontmatter.");
		writeSkill(join(loc, "nonfree"), "name: gated\ndescription: Only manual.\ndisable-model-invocation: true");
		writeSkill(join(loc, ".hidden", "secret"), "name: secret\ndescription: Hidden.");
		writeSkill(join(loc, "node_modules", "pkg"), "name: pkg\ndescription: Dependency.");
		// каталог без SKILL.md — не скилл
		mkdirSync(join(loc, "plain"), { recursive: true });
		writeFileSync(join(loc, "plain", "readme.txt"), "not a skill", "utf8");
		// файлы внутри скилла попадают в инвентарь
		mkdirSync(join(loc, "pdf", "references"), { recursive: true });
		writeFileSync(join(loc, "pdf", "references", "formats.md"), "x", "utf8");
		writeFileSync(join(loc, "pdf", "notes.txt"), "x", "utf8");

		const { skills, collisions } = discoverSkills([{ scope: "user", path: loc }]);
		assert.deepEqual(collisions, []);
		const byName = new Map(skills.map((s) => [s.name, s]));
		assert.deepEqual([...byName.keys()].sort(), ["gated", "other", "outer", "pdf"]); // name fallback: outer → "outer"

		const pdf = byName.get("pdf");
		assert.ok(pdf);
		assert.equal(pdf.dirName, "pdf");
		assert.equal(pdf.scope, "user");
		assert.equal(pdf.location, loc);
		assert.equal(pdf.dir, join(loc, "pdf"));
		assert.equal(pdf.description, "PDFs.");
		assert.equal(pdf.disableModelInvocation, false);
		assert.equal(pdf.malformed, false);
		assert.equal(pdf.body, "Body.");
		assert.deepEqual(pdf.files, ["SKILL.md", "notes.txt", join("references", "formats.md")]);

		const outer = byName.get("outer");
		assert.ok(outer);
		assert.equal(outer.name, "outer", "name falls back to dir name");
		assert.equal(outer.dirName, "outer");
		assert.equal(outer.description, "No name in frontmatter.");

		const gated = byName.get("gated");
		assert.ok(gated);
		assert.equal(gated.disableModelInvocation, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkills: skill root with SKILL.md is not descended into", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "outer"), "name: outer\ndescription: Parent skill.");
		writeSkill(join(loc, "outer", "inner"), "name: inner\ndescription: Nested skill.");
		const { skills } = discoverSkills([{ scope: "project", path: loc }]);
		assert.deepEqual(
			skills.map((s) => s.name),
			["outer"],
		);
		assert.equal(skills[0]?.scope, "project");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkills: name collision first-wins, loser kept in skills and listed", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		writeSkill(join(loc, "alpha"), "name: dup\ndescription: First wins.");
		writeSkill(join(loc, "zulu"), "name: dup\ndescription: Loser.");
		const { skills, collisions } = discoverSkills([{ scope: "user", path: loc }]);
		assert.equal(skills.length, 2, "both records are kept");
		assert.deepEqual(collisions, [{ name: "dup", winnerDir: join(loc, "alpha"), loserDir: join(loc, "zulu") }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkills: earlier location wins cross-location collisions", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const userLoc = join(root, "user-skills");
		const projectLoc = join(root, "project", ".agents", "skills");
		writeSkill(join(userLoc, "same"), "name: same\ndescription: User copy.");
		writeSkill(join(projectLoc, "same"), "name: same\ndescription: Project copy.");
		const { skills, collisions } = discoverSkills([
			{ scope: "user", path: userLoc },
			{ scope: "project", path: projectLoc },
		]);
		assert.equal(skills.length, 2);
		assert.deepEqual(collisions, [
			{ name: "same", winnerDir: join(userLoc, "same"), loserDir: join(projectLoc, "same") },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkills: unreadable and missing locations are silently skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		// SKILL.md как каталог — нечитаемый как файл, скилл пропускается без ошибки
		mkdirSync(join(loc, "broken", "SKILL.md"), { recursive: true });
		writeSkill(join(loc, "ok"), "name: ok\ndescription: Fine.");
		const { skills, collisions } = discoverSkills([
			{ scope: "user", path: loc },
			{ scope: "project", path: join(root, "does-not-exist") },
		]);
		assert.deepEqual(collisions, []);
		assert.deepEqual(
			skills.map((s) => s.name),
			["ok"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSkills: malformed SKILL.md is kept as a record for the auditor", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-auditor-"));
	try {
		const loc = join(root, "skills");
		mkdirSync(join(loc, "broken"), { recursive: true });
		writeFileSync(join(loc, "broken", "SKILL.md"), "No frontmatter at all.", "utf8");
		const { skills } = discoverSkills([{ scope: "user", path: loc }]);
		assert.equal(skills.length, 1);
		assert.equal(skills[0]?.malformed, true);
		assert.equal(skills[0]?.name, "broken", "name falls back to dir name");
		assert.equal(skills[0]?.description, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
