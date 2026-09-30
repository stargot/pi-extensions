import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSemanticPrompt } from "../prompt.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Abbreviated but realistic mechanical report (the shape buildReport emits). */
const REPORT = [
	"# Skill audit",
	"",
	"- cwd: `/proj`",
	"- date: 2026-09-30 17:51",
	"",
	"## Scope map (2)",
	"",
	"- alpha — user — `/root/user-skills`",
	"- beta — project — `/proj/.agents/skills`",
	"",
	"## Findings",
	"",
	"### Warnings (1)",
	"",
	"- **alpha**",
	'  - vague-description: description has no routing trigger (e.g. "use when ...") — the model may never select this skill',
	"",
	"## Summary",
	"",
	"0 errors, 1 warning, 0 info — 2 skills audited.",
	"",
].join("\n");

// ── content ──────────────────────────────────────────────────────────────────

test("buildSemanticPrompt: embeds the mechanical report verbatim and the cwd", () => {
	const prompt = buildSemanticPrompt(REPORT, "/proj");
	assert.ok(prompt.includes(REPORT), "mechanical report must be included in full");
	assert.ok(prompt.includes("/proj"), "cwd must be included");
	// все три задачи разбора упомянуты
	assert.ok(prompt.includes("роутинга description"));
	assert.ok(prompt.includes("Пересечения и дубли"));
	assert.ok(prompt.includes(".agents/skills"));
	assert.ok(prompt.includes("disable-model-invocation"));
	// требование к формату рекомендаций присутствует
	assert.ok(prompt.includes("name → действие → почему"));
});

test("buildSemanticPrompt: explicit read-only rule — no moving/editing/deleting skill files", () => {
	const prompt = buildSemanticPrompt(REPORT, "/proj");
	for (const word of ["не двигать", "не править", "не удалять"]) {
		assert.ok(prompt.includes(word), `prohibition "${word}" must be stated explicitly`);
	}
});

// ── determinism ──────────────────────────────────────────────────────────────

test("buildSemanticPrompt: deterministic — two calls with the same input give equal strings", () => {
	const first = buildSemanticPrompt(REPORT, "/proj");
	const second = buildSemanticPrompt(REPORT, "/proj");
	assert.equal(first, second);
});
