import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding, FindingSeverity, SkillAuditResult } from "../lint.ts";
import { buildReport, reportToJson } from "../report.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const finding = (skill: string, severity: FindingSeverity, code: Finding["code"], message: string): Finding => ({
	skill,
	severity,
	code,
	message,
});

const EMPTY_AUDIT: SkillAuditResult = { findings: [], scopeMap: [] };

/** Mixed-severity audit in deliberately non-sorted input order. */
function mixedAudit(): SkillAuditResult {
	return {
		findings: [
			finding("zeta", "info", "orphan-file", 'files not referenced from SKILL.md: "extra.md"'),
			finding(
				"beta",
				"warning",
				"vague-description",
				'description has no routing trigger (e.g. "use when ...") — the model may never select this skill',
			),
			finding("alpha", "error", "skill-unloadable", "frontmatter has no description — pi silently skips this skill"),
			finding("beta", "error", "description-too-long", "description is 1029 characters (max 1024)"),
			finding(
				"gamma",
				"warning",
				"name-invalid",
				'invalid skill name "Gamma": name must be lowercase (a-z, 0-9, hyphens only)',
			),
			finding("beta", "warning", "name-dir-mismatch", 'frontmatter name "beta" does not match directory name "Beta"'),
		],
		scopeMap: [
			{ name: "gamma", scope: "user", location: "/root/user-skills", dir: "/root/user-skills/gamma", shadowed: false },
			{ name: "alpha", scope: "user", location: "/root/user-skills", dir: "/root/user-skills/alpha", shadowed: false },
			{
				name: "beta",
				scope: "project",
				location: "/proj/.agents/skills",
				dir: "/proj/.agents/skills/beta",
				shadowed: false,
			},
		],
	};
}

/** Byte-exact expected markdown for mixedAudit() without opts. */
const EXPECTED_MIXED = [
	"# Skill audit",
	"",
	"## Scope map (3)",
	"",
	"- alpha — user — `/root/user-skills`",
	"- beta — project — `/proj/.agents/skills`",
	"- gamma — user — `/root/user-skills`",
	"",
	"## Findings",
	"",
	"### Errors (2)",
	"",
	"- **alpha**",
	"  - skill-unloadable: frontmatter has no description — pi silently skips this skill",
	"- **beta**",
	"  - description-too-long: description is 1029 characters (max 1024)",
	"",
	"### Warnings (3)",
	"",
	"- **beta**",
	'  - name-dir-mismatch: frontmatter name "beta" does not match directory name "Beta"',
	'  - vague-description: description has no routing trigger (e.g. "use when ...") — the model may never select this skill',
	"- **gamma**",
	'  - name-invalid: invalid skill name "Gamma": name must be lowercase (a-z, 0-9, hyphens only)',
	"",
	"### Info (1)",
	"",
	"- **zeta**",
	'  - orphan-file: files not referenced from SKILL.md: "extra.md"',
	"",
	"## Summary",
	"",
	"2 errors, 3 warnings, 1 info — 3 skills audited.",
	"",
].join("\n");

// ── empty audit ──────────────────────────────────────────────────────────────

test("buildReport: empty audit — explicit no-findings line, empty scope map, zero counters", () => {
	const report = buildReport(EMPTY_AUDIT);
	assert.ok(report.includes("No findings — all skills pass"));
	assert.ok(report.includes("No skills discovered."));
	assert.ok(report.includes("0 errors, 0 warnings, 0 info — 0 skills audited."));
	// детерминизм и на пустом входе
	assert.equal(report, buildReport(EMPTY_AUDIT));
});

// ── grouping and sorting ─────────────────────────────────────────────────────

test("buildReport: findings grouped error → warning → info, skills alphabetical inside groups", () => {
	const report = buildReport(mixedAudit());
	const errors = report.indexOf("### Errors (2)");
	const warnings = report.indexOf("### Warnings (3)");
	const info = report.indexOf("### Info (1)");
	assert.ok(errors !== -1 && warnings !== -1 && info !== -1);
	assert.ok(errors < warnings && warnings < info);
	const alpha = report.indexOf("- **alpha**");
	const beta = report.indexOf("- **beta**", errors);
	const gamma = report.indexOf("- **gamma**");
	assert.ok(alpha !== -1 && beta !== -1 && gamma !== -1);
	assert.ok(alpha < beta && beta < gamma);
	// each finding renders as "code: message"
	assert.ok(report.includes("  - skill-unloadable: frontmatter has no description — pi silently skips this skill\n"));
	// counters close the report
	assert.ok(report.endsWith("2 errors, 3 warnings, 1 info — 3 skills audited.\n"));
});

test("buildReport: byte-identical output for identical input (whole-document pin)", () => {
	assert.equal(buildReport(mixedAudit()), EXPECTED_MIXED);
});

// ── header with injected now ─────────────────────────────────────────────────

test("buildReport: injected now renders local YYYY-MM-DD HH:mm; same now → identical output", () => {
	const now = new Date(2026, 8, 30, 17, 45); // 2026-09-30 17:45 local
	const a = buildReport(mixedAudit(), { now, cwd: "/proj" });
	const b = buildReport(mixedAudit(), { now, cwd: "/proj" });
	assert.equal(a, b);
	assert.ok(a.includes("- date: 2026-09-30 17:45"));
	assert.ok(a.includes("- cwd: `/proj`"));
	// zero padding of month/day/hour/minute
	const padded = buildReport(EMPTY_AUDIT, { now: new Date(2026, 0, 5, 3, 7) });
	assert.ok(padded.includes("- date: 2026-01-05 03:07"));
});

test("buildReport: without opts there is no date/cwd header meta", () => {
	const report = buildReport(mixedAudit());
	assert.ok(!report.includes("date:"));
	assert.ok(!report.includes("cwd:"));
});

// ── scope map ────────────────────────────────────────────────────────────────

test("buildReport: shadowed scope-map entries carry the (shadowed) mark; user before project", () => {
	const audit: SkillAuditResult = {
		findings: [],
		scopeMap: [
			{ name: "pdf", scope: "project", location: "/p/.agents/skills", dir: "/p/.agents/skills/pdf", shadowed: true },
			{ name: "pdf", scope: "user", location: "/h/.pi/agent/skills", dir: "/h/.pi/agent/skills/pdf", shadowed: false },
		],
	};
	const report = buildReport(audit);
	const userLine = report.indexOf("- pdf — user — `/h/.pi/agent/skills`\n");
	const projectLine = report.indexOf("- pdf — project — `/p/.agents/skills` (shadowed)\n");
	assert.ok(userLine !== -1);
	assert.ok(projectLine !== -1);
	assert.ok(userLine < projectLine);
});

// ── reportToJson ─────────────────────────────────────────────────────────────

test("reportToJson: parses, mirrors report order, stable across calls, stable key order", () => {
	const now = new Date(2026, 8, 30, 17, 45);
	const json1 = reportToJson(mixedAudit(), { now, cwd: "/proj" });
	const json2 = reportToJson(mixedAudit(), { now, cwd: "/proj" });
	assert.equal(json1, json2);

	const parsed = JSON.parse(json1) as {
		cwd?: string;
		date?: string;
		scopeMap: { name: string; scope: string; shadowed: boolean }[];
		findings: { skill: string; severity: string; code: string; message: string }[];
		summary: { errors: number; warnings: number; info: number; skills: number };
	};
	assert.equal(parsed.cwd, "/proj");
	assert.equal(parsed.date, "2026-09-30 17:45");
	assert.deepEqual(parsed.summary, { errors: 2, warnings: 3, info: 1, skills: 3 });
	assert.equal(parsed.findings.length, 6);
	assert.deepEqual(parsed.findings[0], {
		skill: "alpha",
		severity: "error",
		code: "skill-unloadable",
		message: "frontmatter has no description — pi silently skips this skill",
	});
	assert.deepEqual(
		parsed.findings.map((f) => [f.severity, f.skill]),
		[
			["error", "alpha"],
			["error", "beta"],
			["warning", "beta"],
			["warning", "beta"],
			["warning", "gamma"],
			["info", "zeta"],
		],
	);
	// fixed top-level key order: cwd, date, scopeMap, findings, summary
	assert.ok(json1.startsWith('{\n  "cwd": "/proj",\n  "date": "2026-09-30 17:45",'));
	const keyOrder = ["scopeMap", "findings", "summary"].map((key) => json1.indexOf(`"${key}"`));
	assert.deepEqual(
		[...keyOrder].sort((a, b) => a - b),
		keyOrder,
	);
});

test("reportToJson: without opts no cwd/date keys; scopeMap rows keep the shadowed flag", () => {
	const json = reportToJson({
		findings: [],
		scopeMap: [
			{ name: "pdf", scope: "project", location: "/p/.agents/skills", dir: "/p/.agents/skills/pdf", shadowed: true },
		],
	});
	const parsed = JSON.parse(json) as { cwd?: string; date?: string; scopeMap: { shadowed: boolean }[] };
	assert.ok(!("cwd" in parsed));
	assert.ok(!("date" in parsed));
	assert.equal(parsed.scopeMap[0]?.shadowed, true);
});
