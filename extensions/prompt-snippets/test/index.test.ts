/**
 * Unit tests for prompt-snippets' pure surface: frontmatter parsing, snippet
 * loading (with PI_SNIPPETS_DIR pointing at a fixture dir) and the message
 * transform. The TUI menu itself stays manual-verified.
 *
 * PI_SNIPPETS_DIR must be set before the module import (snippetsDir is read
 * at module load) — hence the dynamic import below.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_SNIPPETS_DIR = mkdtempSync(join(tmpdir(), "pi-snippets-test-"));
const { applySnippets, loadSnippets, parseSnippet } = await import("../index.ts");

const dir = process.env.PI_SNIPPETS_DIR!;

test("parseSnippet: full frontmatter, quotes stripped", () => {
	const s = parseSnippet("concise.md", [
		"---",
		'name: "Concise mode"',
		"description:  Be brief. ",
		"placement: prepend",
		"order: 10",
		"---",
		"Answer in one sentence.",
	].join("\n"));
	assert.ok(s);
	assert.equal(s.id, "concise.md");
	assert.equal(s.name, "Concise mode");
	assert.equal(s.description, "Be brief.");
	assert.equal(s.placement, "prepend");
	assert.equal(s.order, 10);
	assert.equal(s.body, "Answer in one sentence.");
});

test("parseSnippet: defaults — name from filename, append placement, order 9999", () => {
	const s = parseSnippet("my-rule.md", ["---", "description: some rule", "---", "Body text"].join("\n"));
	assert.ok(s);
	assert.equal(s.name, "my-rule");
	assert.equal(s.placement, "append");
	assert.equal(s.order, 9999);
	assert.equal(s.description, "some rule");
});

test("parseSnippet: rejects missing frontmatter and empty body", () => {
	assert.equal(parseSnippet("a.md", "just text, no frontmatter"), null);
	assert.equal(parseSnippet("b.md", ["---", "name: x", "---", "   "].join("\n")), null);
});

test("parseSnippet: CRLF frontmatter tolerated", () => {
	const s = parseSnippet("c.md", "---\r\nname: win\r\n---\r\nBody\r\n");
	assert.ok(s);
	assert.equal(s.name, "win");
	assert.equal(s.body, "Body");
});

test("loadSnippets: prepend group first, each sorted by (order, name); non-md skipped", () => {
	writeFileSync(join(dir, "b-append.md"), ["---", "name: B Append", "order: 1", "---", "b1"].join("\n"));
	writeFileSync(join(dir, "a-append.md"), ["---", "name: A Append", "order: 2", "---", "b2"].join("\n"));
	writeFileSync(join(dir, "z-prepend.md"), ["---", "name: Zed", "placement: prepend", "order: 5", "---", "p1"].join("\n"));
	writeFileSync(join(dir, "a-prepend.md"), ["---", "name: Aaa", "placement: prepend", "order: 5", "---", "p2"].join("\n"));
	writeFileSync(join(dir, "notes.txt"), "not a snippet");
	writeFileSync(join(dir, "broken.md"), "no frontmatter");

	const names = loadSnippets().map((s) => s.name);
	assert.deepEqual(names, ["Aaa", "Zed", "B Append", "A Append"]);
});

test("applySnippets: prepends, typed text, appends — joined with blank lines", () => {
	const mk = (placement: "prepend" | "append", body: string) =>
		parseSnippet(`${placement}-${body}.md`, ["---", `placement: ${placement}`, "---", body].join("\n"))!;
	const active = [mk("prepend", "P1"), mk("append", "A1"), mk("prepend", "P2")];
	assert.equal(applySnippets(active, "QUESTION"), "P1\n\nP2\n\nQUESTION\n\nA1");
	assert.equal(applySnippets([], "QUESTION"), "QUESTION");
});
