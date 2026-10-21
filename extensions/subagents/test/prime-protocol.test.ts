import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildBudgetRule,
	buildDispatchTable,
	isChildAppend,
	shellLooksLikeLookup,
	shellWriteTargets,
	spawnAgents,
} from "../prime-protocol.ts";

test("buildDispatchTable: rows sorted by name whatever the input order", () => {
	const table = buildDispatchTable([
		{ name: "worker", description: "does work" },
		{ name: "scout", description: "recon" },
	]);
	const rows = table.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Role"));
	assert.deepEqual(rows, ["| scout | recon |", "| worker | does work |"]);
	assert.equal(table.split("\n")[0], "## Dispatch table");
	assert.ok(table.includes("Generated from the live agent pool."));
});

test("buildDispatchTable: markdown rows, Role/Purpose columns, pipes escaped, empty description → —", () => {
	const table = buildDispatchTable([
		{ name: "scout", description: "fast recon" },
		{ name: "worker", description: "bulk | work" },
		{ name: "plain", description: "" },
	]);
	const lines = table.split("\n");
	assert.ok(lines.includes("| Role | Purpose |"));
	assert.ok(lines.includes("|---|---|"));
	assert.ok(lines.includes("| scout | fast recon |"));
	assert.ok(lines.includes("| worker | bulk \\| work |"));
	assert.ok(lines.includes("| plain | — |"));
	assert.ok(!lines.some((line) => line.includes("Model")));
});

test("buildDispatchTable: empty pool → no table", () => {
	assert.equal(buildDispatchTable([]), "");
});

test("buildBudgetRule: numbers come from the enforcement constants, not hardcoded text", () => {
	const rule = buildBudgetRule({ base: 3, perDispatch: 3, files: 3 });
	assert.ok(rule.startsWith("## Solo budget — enforced in code"));
	assert.ok(rule.includes("3 solo lookup calls per user turn"));
	assert.ok(rule.includes("+3 more for each dispatched agent"));
	assert.ok(rule.includes("capped at 3 distinct files"));
	assert.ok(rule.includes("/solo <N>"));
	assert.ok(rule.includes("/solo off"));

	// Different constants → different numbers: the string tracks the code.
	const tuned = buildBudgetRule({ base: 5, perDispatch: 2, files: 7 });
	assert.ok(tuned.includes("5 solo lookup calls"));
	assert.ok(tuned.includes("+2 more for each dispatched agent"));
	assert.ok(tuned.includes("capped at 7 distinct files"));
	assert.ok(!tuned.includes("3 solo lookup calls"));
});

test("spawnAgents: subagent and task_batch inputs", () => {
	assert.deepEqual(spawnAgents("subagent", { agent: " scout " }), ["scout"]);
	assert.deepEqual(spawnAgents("subagent", { agent: "  " }), []);
	assert.deepEqual(spawnAgents("task_batch", { tasks: [{ agent: "a" }, { agent: "b" }] }), ["a", "b"]);
	assert.deepEqual(spawnAgents("task_batch", { agent: "chain-agent", tasks: [] }), ["chain-agent"]);
	assert.deepEqual(spawnAgents("read", { path: "x" }), []);
	assert.deepEqual(spawnAgents("task_batch", undefined), []);
});

test("spawnAgents: task_batch chain steps count as dispatches", () => {
	assert.deepEqual(spawnAgents("task_batch", { chain: [{ agent: "planner" }, { agent: "worker" }] }), [
		"planner",
		"worker",
	]);
});

test("shellLooksLikeLookup: reader commands count, cd-prefixed real work does not", () => {
	assert.equal(shellLooksLikeLookup({ command: "ls src" }), true);
	assert.equal(shellLooksLikeLookup({ command: "Get-Content a.txt" }), true);
	assert.equal(shellLooksLikeLookup({ command: "cd pkg && rg foo" }), true);
	assert.equal(shellLooksLikeLookup({ command: "cd other && npm test" }), false);
	assert.equal(shellLooksLikeLookup({ command: "npm run build" }), false);
	assert.equal(shellLooksLikeLookup({ command: "" }), false);
});

test("shellLooksLikeLookup: every sequenced command counts, pipe consumers do not", () => {
	assert.equal(shellLooksLikeLookup({ command: "echo start; cat secrets.txt" }), true);
	assert.equal(shellLooksLikeLookup({ command: "npm test || sed -n 1,40p log.txt" }), true);
	assert.equal(shellLooksLikeLookup({ command: "npm test | tail -20" }), false);
	assert.equal(shellLooksLikeLookup({ command: "Set-Location pkg; npm run build" }), false);
});

test("shellLooksLikeLookup: read-only git and extra readers count, git writes do not", () => {
	assert.equal(shellLooksLikeLookup({ command: "git show HEAD:src/a.ts" }), true);
	assert.equal(shellLooksLikeLookup({ command: "git log --oneline -5" }), true);
	assert.equal(shellLooksLikeLookup({ command: "awk '{print $1}' a.txt" }), true);
	assert.equal(shellLooksLikeLookup({ command: "findstr /n foo a.txt" }), true);
	assert.equal(shellLooksLikeLookup({ command: "git commit -m x" }), false);
});

test("shellWriteTargets: redirects and writer cmdlets, null sinks ignored", () => {
	assert.deepEqual(shellWriteTargets({ command: "cat > notes.md <<'EOF'" }), ["notes.md"]);
	assert.deepEqual(shellWriteTargets({ command: "echo a >> 'log.txt'" }), ["log.txt"]);
	assert.deepEqual(shellWriteTargets({ command: "Set-Content -Path out.txt -Value 1" }), ["out.txt"]);
	assert.deepEqual(shellWriteTargets({ command: "npm test | tee run.log" }), ["run.log"]);
	assert.deepEqual(shellWriteTargets({ command: "npm test 2>&1 > /dev/null" }), []);
	assert.deepEqual(shellWriteTargets({ command: "cmd 2> err.txt; echo x > $null" }), []);
});

test("shellWriteTargets: arrows and comparisons are not redirects", () => {
	assert.deepEqual(shellWriteTargets({ command: `node -e "[1].map((x) => x)"` }), []);
	assert.deepEqual(shellWriteTargets({ command: "if ($a -gt 1) { git status }" }), []);
});

test("isChildAppend: identity alone or after a shared prompt; other appends are not children", () => {
	const bodies = new Set(["You are scout."]);
	assert.equal(isChildAppend("You are scout.", bodies), true);
	assert.equal(isChildAppend("Shared rules.\n\nYou are scout.\n", bodies), true);
	assert.equal(isChildAppend("## Основные принципы\n- brevity", bodies), false);
	assert.equal(isChildAppend(undefined, bodies), false);
	assert.equal(isChildAppend("  ", bodies), false);
});
