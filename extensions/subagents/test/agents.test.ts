import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, parseAgentMarkdown } from "../agents.ts";

test("parseAgentMarkdown: full frontmatter", () => {
	const def = parseAgentMarkdown(
		[
			"---",
			"name: scout",
			'description: "Fast recon"',
			"model: zai/glm-5.3-flash",
			"thinking: medium",
			"tools: read, grep, find, ls",
			"auto-exit: false",
			"subagents: worker, researcher",
			"---",
			"",
			"You are a scout.",
		].join("\n"),
		"fallback",
	);
	assert.equal(def.name, "scout");
	assert.equal(def.description, "Fast recon");
	assert.equal(def.model, "zai/glm-5.3-flash");
	assert.equal(def.thinking, "medium");
	assert.deepEqual(def.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(def.subagents, ["worker", "researcher"]);
	assert.equal(def.autoExit, false);
	assert.equal(def.body, "You are a scout.");
});

test("parseAgentMarkdown: auto-exit defaults to true, name falls back to file name", () => {
	const def = parseAgentMarkdown("---\ndescription: minimal\n---\n\nBody here.", "worker");
	assert.equal(def.name, "worker");
	assert.equal(def.autoExit, true);
	assert.equal(def.body, "Body here.");
	assert.equal(def.tools, undefined);
});

test("parseAgentMarkdown: auto-exit accepts true/yes/1/on and false/no/0/off, case-insensitive", () => {
	for (const value of ["true", "TRUE", "Yes", "1", "on", "ON"]) {
		const def = parseAgentMarkdown(`---\nauto-exit: ${value}\n---\nBody.`, "x");
		assert.equal(def.autoExit, true, `auto-exit: ${value}`);
		assert.deepEqual(def.warnings, [], `auto-exit: ${value} must not warn`);
	}
	for (const value of ["false", "FALSE", "No", "0", "off", "Off"]) {
		const def = parseAgentMarkdown(`---\nauto-exit: ${value}\n---\nBody.`, "x");
		assert.equal(def.autoExit, false, `auto-exit: ${value}`);
		assert.deepEqual(def.warnings, [], `auto-exit: ${value} must not warn`);
	}
});

test("parseAgentMarkdown: unrecognized auto-exit keeps the default (true) and reports a warning", () => {
	for (const value of ["maybe", "auto", "2", "waar"]) {
		const def = parseAgentMarkdown(`---\nauto-exit: ${value}\n---\nBody.`, "x");
		assert.equal(def.autoExit, true, `auto-exit: ${value} falls back to the default`);
		assert.equal(def.warnings.length, 1, `auto-exit: ${value} warns once`);
		assert.match(def.warnings[0]!, /auto-exit/);
		assert.match(def.warnings[0]!, /defaulting to true/);
	}
});

test("parseAgentMarkdown: handles CRLF line endings", () => {
	const def = parseAgentMarkdown("---\r\nname: crlf\r\ntools: a, b\r\n---\r\n\r\nBody.", "x");
	assert.equal(def.name, "crlf");
	assert.deepEqual(def.tools, ["a", "b"]);
});

test("parseAgentMarkdown: no frontmatter → whole input is body", () => {
	const def = parseAgentMarkdown("Just a body.", "x");
	assert.equal(def.body, "Just a body.");
	assert.equal(def.description, "");
});

test("discoverAgents: project overrides global, both scopes found", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
	try {
		const globalDir = join(root, "global", "agents");
		const projectDir = join(root, "project", ".pi", "agents");
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		writeFileSync(join(globalDir, "scout.md"), "---\nname: scout\ndescription: global scout\n---\nG", "utf8");
		writeFileSync(join(globalDir, "worker.md"), "---\nname: worker\ndescription: global worker\n---\nW", "utf8");
		writeFileSync(join(projectDir, "scout.md"), "---\nname: scout\ndescription: project scout\n---\nP", "utf8");

		const defs = discoverAgents(join(root, "project"), join(root, "global"));
		assert.equal(defs.size, 2);
		assert.equal(defs.get("scout")?.description, "project scout");
		assert.equal(defs.get("scout")?.scope, "project");
		assert.equal(defs.get("worker")?.scope, "global");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverAgents: missing dirs → empty map", () => {
	const defs = discoverAgents(join(tmpdir(), "no-such-project"), join(tmpdir(), "no-such-global"));
	assert.equal(defs.size, 0);
});

test("parseAgentMarkdown: subagents wildcard parses through as a list entry", () => {
	const def = parseAgentMarkdown("---\nname: prime\nsubagents: *\n---\nBody.", "prime");
	assert.deepEqual(def.subagents, ["*"]);
	assert.deepEqual(def.warnings, []);
});

test("parseAgentMarkdown: unknown frontmatter keys produce warnings", () => {
	const raw =
		"---\nname: researcher\ndescription: d\ntools: web_search, safe_bash\nsystem-prompt: append\nunknown-thing: x\n---\nBody.";
	const def = parseAgentMarkdown(raw, "fallback");
	assert.deepEqual(def.warnings.sort(), [
		'unknown frontmatter key "system-prompt"',
		'unknown frontmatter key "unknown-thing"',
	]);
});

test("parseAgentMarkdown: known keys produce no warnings", () => {
	const raw =
		"---\nname: worker\ndescription: d\nmodel: m\ntools: read, bash\nsubagents: scout\nauto-exit: false\ndispatch: true\n---\nBody.";
	const def = parseAgentMarkdown(raw, "fallback");
	assert.deepEqual(def.warnings, []);
});

test("parseAgentMarkdown: readonly is a known boolean key, default false", () => {
	const on = parseAgentMarkdown("---\nreadonly: true\n---\nBody.", "x");
	assert.equal(on.readonly, true);
	assert.deepEqual(on.warnings, []);
	assert.equal(parseAgentMarkdown("---\nname: x\n---\nBody.", "x").readonly, false);
});

test("parseAgentMarkdown: dispatch is a known boolean key, default true, only false opts out", () => {
	const off = parseAgentMarkdown("---\ndispatch: false\n---\nBody.", "x");
	assert.equal(off.dispatch, false);
	assert.deepEqual(off.warnings, []);
	const quoted = parseAgentMarkdown('---\ndispatch: "false"\n---\nBody.', "x");
	assert.equal(quoted.dispatch, false);
	assert.equal(parseAgentMarkdown("---\nname: x\n---\nBody.", "x").dispatch, true);
	const on = parseAgentMarkdown("---\ndispatch: true\n---\nBody.", "x");
	assert.equal(on.dispatch, true);
	assert.deepEqual(on.warnings, []);
});
