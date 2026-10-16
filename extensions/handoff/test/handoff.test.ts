import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandoffMarkdown, capLine, projectSlug, type HandoffInput } from "../handoff.ts";

const NOW = new Date("2026-09-24T17:20:00").getTime();

const base: HandoffInput = {
	projectDir: "/work/alpha",
	sessionFile: "/sessions/2026-09-24_session.jsonl",
	startedAt: NOW - 45 * 60_000,
	lastUser: "Нужно проанализировать и улучшить task_batch",
	lastAssistant: "Готово: 6 коммитов, 354 теста зелёные.",
	git: {
		branch: "main",
		status: [" M CHANGELOG.md", "?? docs/"],
		diffStat: [" CHANGELOG.md | 38 +++"],
		commits: ["9095874 docs: RESEARCH.md", "60435e6 fix: running-index"],
		dirtyCount: 2,
	},
	now: NOW,
};

test("buildHandoffMarkdown: full dump — header, exchange, git section", () => {
	const md = buildHandoffMarkdown(base);
	assert.match(md, /^# Handoff — alpha — 2026-09-24 17:20/);
	assert.match(md, /Session: \/sessions\/2026-09-24_session\.jsonl/);
	assert.match(md, /Длительность: ~45 мин/);
	assert.match(md, /## Последний запрос\nНужно проанализировать/);
	assert.match(md, /## Последний ответ\nГотово: 6 коммитов/);
	assert.match(md, /## Git — main/);
	assert.match(md, /Незакоммиченных файлов: 2/);
	assert.match(md, /M CHANGELOG\.md/);
	assert.match(md, /- 9095874 docs: RESEARCH\.md/);
});

test("buildHandoffMarkdown: no git and no exchange — still valid, notes the absence", () => {
	const md = buildHandoffMarkdown({ projectDir: "/tmp/empty", now: NOW });
	assert.match(md, /^# Handoff — empty — 2026-09-24 17:20/);
	assert.match(md, /не репозиторий или git недоступен/);
	assert.doesNotMatch(md, /Последний запрос/);
});

test("capLine: flattens whitespace and caps with ellipsis", () => {
	assert.equal(capLine("a\n\n  b   c", 20), "a b c");
	assert.equal(capLine("x".repeat(50), 10), "xxxxxxxxx…");
	assert.equal(capLine("short", 10), "short");
});

test("projectSlug: lowercased, separators/spaces collapsed, capped at 80", () => {
	assert.equal(projectSlug("projects/alpha beta/"), "projects-alpha-beta");
	// Windows-style backslashes and drive colon are just characters to collapse —
	// the function is pure string handling, so this is deterministic everywhere.
	assert.equal(projectSlug("X:\\data\\my app\\"), "x-data-my-app");
	assert.equal(projectSlug("!!!"), "unknown");
	assert.ok(projectSlug("x".repeat(200) + ".deep").length <= 80);
});
