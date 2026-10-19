import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBudgetRule,
	buildDispatchTable,
	dispatchTargets,
	knownAgentBodies,
	shellLooksLikeLookup,
	shellWriteTargets,
	spawnAgents,
} from "../protocol.ts";

function makeAgentsDir(files: Record<string, string>): string {
	const dir = join(mkdtempSync(join(tmpdir(), "pi-prime-protocol-test-")), "agents");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content, "utf8");
	}
	return dir;
}

function withAgentsDir(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = makeAgentsDir(files);
	try {
		run(dir);
	} finally {
		rmSync(join(dir, ".."), { recursive: true, force: true });
	}
}

test("dispatchTargets: every agent file except prime, sorted by name", () => {
	withAgentsDir(
		{
			"prime.md": "---\nname: prime\ndescription: orchestrator\n---\nPrime body.",
			"worker.md": "---\nname: worker\ndescription: does work\nmodel: fast-model\n---\nBody.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nBody.",
		},
		(dir) => {
			const targets = dispatchTargets(dir, "prime");
			assert.deepEqual(
				targets.map((t) => t.name),
				["scout", "worker"],
			);
			assert.equal(targets[0]?.description, "recon");
			assert.equal(targets[0]?.model, "—");
			assert.equal(targets[1]?.model, "fast-model");
		},
	);
});

test("dispatchTargets: dispatch: false opts out, name falls back to file name", () => {
	withAgentsDir(
		{
			"librarian.md": "---\nname: librarian\ndescription: archive\ndispatch: false\n---\nBody.",
			"auditor.md": "---\ndescription: audits\n---\nBody.",
			"archived.md": '---\nname: archived\ndescription: old\ndispatch: "false"\n---\nBody.',
			"active.md": "---\nname: active\ndescription: on\ndispatch: true\n---\nBody.",
		},
		(dir) => {
			assert.deepEqual(
				dispatchTargets(dir, "prime").map((t) => t.name),
				["active", "auditor"],
			);
		},
	);
});

test("dispatchTargets: self excluded by frontmatter name even when the file is named differently", () => {
	withAgentsDir(
		{
			"orchestrator.md": "---\nname: prime\ndescription: self under another file name\n---\nBody.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nBody.",
		},
		(dir) => {
			assert.deepEqual(
				dispatchTargets(dir, "prime").map((t) => t.name),
				["scout"],
			);
		},
	);
});

test("dispatchTargets: self excluded by file name even when frontmatter names it differently", () => {
	withAgentsDir(
		{
			"prime.md":
				"---\nname: retired-orchestrator\ndescription: renamed role keeps the canonical file name\n---\nBody.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nBody.",
		},
		(dir) => {
			assert.deepEqual(
				dispatchTargets(dir, "prime").map((t) => t.name),
				["scout"],
			);
		},
	);
});

test("dispatchTargets: md without frontmatter keeps the file name", () => {
	withAgentsDir(
		{
			"plain.md": "Body only, no frontmatter block.",
			"prime.md": "---\nname: prime\n---\nBody.",
		},
		(dir) => {
			assert.deepEqual(
				dispatchTargets(dir, "prime").map((t) => t.name),
				["plain"],
			);
			assert.equal(dispatchTargets(dir, "prime")[0]?.description, "—");
		},
	);
});

test("dispatchTargets: non-md files ignored, missing dir → empty", () => {
	withAgentsDir({ "notes.txt": "not an agent" }, (dir) => {
		assert.deepEqual(dispatchTargets(dir, "prime"), []);
	});
	assert.deepEqual(dispatchTargets(join(tmpdir(), "no-such-agents-dir"), "prime"), []);
});

test("buildDispatchTable: markdown rows from description/model frontmatter", () => {
	withAgentsDir(
		{
			"prime.md": "---\nname: prime\n---\nPrime body.",
			"scout.md": "---\nname: scout\ndescription: fast recon\nmodel: zai/glm-5.3-flash\n---\nBody.",
			"worker.md": "---\nname: worker\ndescription: bulk | work\n---\nBody.",
		},
		(dir) => {
			const table = buildDispatchTable(dir, "prime");
			const lines = table.split("\n");
			assert.equal(lines[0], "## Dispatch table");
			assert.ok(lines.includes("| Role | Purpose | Model |"));
			assert.ok(lines.includes("| scout | fast recon | zai/glm-5.3-flash |"));
			assert.ok(lines.includes("| worker | bulk \\| work | — |"));
			assert.ok(!lines.some((line) => line.startsWith("| prime")));
		},
	);
});

test("buildDispatchTable: empty pool → no table", () => {
	withAgentsDir({ "prime.md": "---\nname: prime\n---\nBody." }, (dir) => {
		assert.equal(buildDispatchTable(dir, "prime"), "");
	});
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

test("knownAgentBodies: frontmatter stripped, prime body included (child-detect match source)", () => {
	withAgentsDir(
		{
			"prime.md": "---\nname: prime\n---\nPrime identity.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nScout identity.",
		},
		(dir) => {
			const bodies = knownAgentBodies(dir);
			assert.equal(bodies.size, 2);
			assert.ok(bodies.has("Prime identity."));
			assert.ok(bodies.has("Scout identity."));
			assert.ok(!bodies.has("name: scout"));
		},
	);
});

test("knownAgentBodies: missing dir → empty set (fail-open)", () => {
	assert.equal(knownAgentBodies(join(tmpdir(), "no-such-agents-dir")).size, 0);
});

test("spawnAgents: subagent and task_batch inputs", () => {
	assert.deepEqual(spawnAgents("subagent", { agent: " scout " }), ["scout"]);
	assert.deepEqual(spawnAgents("subagent", { agent: "  " }), []);
	assert.deepEqual(spawnAgents("task_batch", { tasks: [{ agent: "a" }, { agent: "b" }] }), ["a", "b"]);
	assert.deepEqual(spawnAgents("task_batch", { agent: "chain-agent", tasks: [] }), ["chain-agent"]);
	assert.deepEqual(spawnAgents("read", { path: "x" }), []);
	assert.deepEqual(spawnAgents("task_batch", undefined), []);
});

test("shellLooksLikeLookup: reader commands count, cd-prefixed real work does not", () => {
	assert.equal(shellLooksLikeLookup({ command: "ls src" }), true);
	assert.equal(shellLooksLikeLookup({ command: "Get-Content a.txt" }), true);
	assert.equal(shellLooksLikeLookup({ command: "cd pkg && rg foo" }), true);
	assert.equal(shellLooksLikeLookup({ command: "cd other && npm test" }), false);
	assert.equal(shellLooksLikeLookup({ command: "npm run build" }), false);
	assert.equal(shellLooksLikeLookup({ command: "" }), false);
});

test("spawnAgents: task_batch chain steps count as dispatches", () => {
	assert.deepEqual(spawnAgents("task_batch", { chain: [{ agent: "planner" }, { agent: "worker" }] }), [
		"planner",
		"worker",
	]);
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
