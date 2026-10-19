import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentDef } from "../agents.ts";
import {
	buildIdentityFile,
	buildLaunchPlan,
	buildTaskFile,
	cwdProblemMessage,
	dispatchParentModel,
	resolveAgentDef,
	resolveHeadlessThinking,
	resolveLaunchCwd,
	resolveLaunchModel,
	resolveSubagentAppendFile,
	safeFilePart,
	sessionFilePath,
	subagentId,
} from "../launch-plan.ts";

const makeDef = (overrides: Partial<AgentDef> = {}): AgentDef => ({
	name: "scout",
	description: "",
	autoExit: true,
	body: "You are scout.",
	warnings: [],
	scope: "global",
	path: "",
	...overrides,
});

test("safeFilePart: lowercases, collapses separators, falls back", () => {
	assert.equal(safeFilePart("Research Lead v2"), "research-lead-v2");
	assert.equal(safeFilePart("???"), "subagent");
});

test("resolveAgentDef: returns the definition for a known name", () => {
	const defs = new Map<string, AgentDef>([["scout", makeDef()]]);
	assert.equal(resolveAgentDef(defs, "scout").name, "scout");
});

test("resolveAgentDef: canonical unknown-agent error, pane variant, lists available names", () => {
	const defs = new Map<string, AgentDef>([
		["scout", makeDef()],
		["writer", makeDef({ name: "writer" })],
	]);
	assert.throws(
		() => resolveAgentDef(defs, "ghost"),
		(err: unknown) => err instanceof Error && err.message === 'Unknown agent "ghost". Available: scout, writer.',
	);
});

test("resolveAgentDef: canonical unknown-agent error when no definitions exist at all", () => {
	assert.throws(
		() => resolveAgentDef(new Map<string, AgentDef>(), "ghost"),
		(err: unknown) =>
			err instanceof Error &&
			err.message === 'Unknown agent "ghost". No agent definitions found in .pi/agents/ or ~/.pi/agent/agents/.',
	);
});

test("model precedence: explicit tool-call override wins over def and parent", () => {
	assert.equal(resolveLaunchModel("custom/model", makeDef({ model: "def/model" }), "parent/model"), "custom/model");
	assert.equal(resolveLaunchModel("  custom/model  ", makeDef({ model: "def/model" })), "custom/model");
});

test("model precedence: agent definition model wins over the dispatching parent's model", () => {
	assert.equal(resolveLaunchModel(undefined, makeDef({ model: "def/model" }), "parent/model"), "def/model");
});

test("model precedence: parent fallback applies on the pane path (blank override, no def model)", () => {
	assert.equal(resolveLaunchModel("   ", makeDef({ model: undefined }), "parent/model"), "parent/model");
	assert.equal(resolveLaunchModel(undefined, makeDef({ model: undefined }), "parent/model"), "parent/model");
});

test("model precedence: parent fallback covers batch dispatch (task_batch has no override)", () => {
	assert.equal(resolveLaunchModel(undefined, makeDef({ model: undefined }), "parent/model"), "parent/model");
});

test("model precedence: nothing set anywhere resolves to undefined (pi default)", () => {
	assert.equal(resolveLaunchModel(undefined, makeDef({ model: undefined }), undefined), undefined);
	assert.equal(resolveLaunchModel(undefined, makeDef({ model: undefined }), ""), undefined);
});

test("headless thinking: agent definition level wins, even with its own model", () => {
	assert.equal(resolveHeadlessThinking(makeDef({ model: "def/model", thinking: "low" }), "max"), "low");
	assert.equal(resolveHeadlessThinking(makeDef({ thinking: "low" }), "max"), "low");
});

test("headless thinking: parent level applies only when the parent model is inherited too", () => {
	assert.equal(resolveHeadlessThinking(makeDef({ model: undefined }), "high"), "high");
	assert.equal(resolveHeadlessThinking(makeDef({ model: "def/model" }), "high"), undefined);
});

test("resolveSubagentAppendFile: project file wins, then global, else none", () => {
	const project = join("C:", "repo", ".pi", "APPEND_SUBAGENT.md");
	const global = join("C:", "agent", "APPEND_SUBAGENT.md");
	const cwd = join("C:", "repo");
	const agentDir = join("C:", "agent");
	assert.equal(
		resolveSubagentAppendFile(cwd, agentDir, () => true),
		project,
	);
	assert.equal(
		resolveSubagentAppendFile(cwd, agentDir, (p) => p === global),
		global,
	);
	assert.equal(
		resolveSubagentAppendFile(cwd, agentDir, () => false),
		undefined,
	);
});

test("dispatchParentModel: provider/id string, or undefined without a model", () => {
	assert.equal(dispatchParentModel({ provider: "acme", id: "m1" }), "acme/m1");
	assert.equal(dispatchParentModel(undefined), undefined);
});

test("sessionFilePath: one naming function for both spawn surfaces", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-launch-name-"));
	try {
		const pane = sessionFilePath(root, subagentId("scout"));
		const batch = sessionFilePath(root, subagentId("scout"));
		const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_scout-[0-9a-f]{8}\.jsonl$/;
		assert.match(basename(pane), pattern);
		assert.match(basename(batch), pattern);
		assert.notEqual(pane, batch, "unique ids keep same-millisecond spawns collision-free");
		assert.equal(dirname(pane), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("buildLaunchPlan: pane shape — identity+task persist in artifacts, unified session name", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-pane-"));
	try {
		const contextDir = join(dir, "artifacts", "context");
		const plan = buildLaunchPlan({
			def: makeDef({ model: "def/model", body: "IDENTITY BODY" }),
			name: "Scout One",
			modelOverride: undefined,
			parentModel: "parent/model",
			sessionsRoot: join(dir, "sessions", "subagents"),
			identityPolicy: { kind: "artifact", dir: contextDir },
			task: { content: "wrapped task", policy: { kind: "artifact", dir: contextDir } },
		});
		assert.match(
			basename(plan.sessionFile),
			/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_scout-one-[0-9a-f]{8}\.jsonl$/,
		);
		assert.equal(plan.model, "def/model");
		assert.ok(plan.identityFile && dirname(plan.identityFile) === contextDir);
		assert.equal(basename(plan.identityFile!), "scout-one-identity.md");
		assert.equal(readFileSync(plan.identityFile!, "utf8"), "IDENTITY BODY");
		assert.ok(plan.taskFile && dirname(plan.taskFile) === contextDir);
		assert.match(basename(plan.taskFile!), /^scout-one-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
		assert.equal(readFileSync(plan.taskFile!, "utf8"), "wrapped task");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildLaunchPlan: batch shape — a >32K task builds a plan via file delivery, model from parent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-batch-"));
	try {
		const sessionsRoot = join(dir, "sessions", "subagents");
		const bigTask = "x".repeat(40_000);
		const plan = buildLaunchPlan({
			def: makeDef({ model: undefined, body: "IDENTITY BODY" }),
			name: "scout",
			parentModel: "parent/model",
			sessionsRoot,
			identityPolicy: { kind: "temp", dir: sessionsRoot },
			task: { content: `Task: ${bigTask}`, policy: { kind: "temp", dir: sessionsRoot } },
		});
		assert.ok(plan.taskFile, ">32K task constructs a plan without throwing");
		assert.equal(readFileSync(plan.taskFile!, "utf8"), `Task: ${bigTask}`, "task text lands in the file, not argv");
		assert.match(basename(plan.taskFile!), /^\.task-[0-9a-f]{8}\.md$/);
		assert.match(basename(plan.identityFile!), /^\.identity-[0-9a-f]{8}\.md$/);
		assert.equal(dirname(plan.identityFile!), sessionsRoot, "batch identity is a temp file in sessionsRoot");
		assert.equal(plan.model, "parent/model");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildLaunchPlan: identity content is byte-identical across policies for the same def", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-identity-"));
	try {
		const panePlan = buildLaunchPlan({
			def: makeDef(),
			name: "scout",
			sessionsRoot: join(dir, "s"),
			identityPolicy: { kind: "artifact", dir: join(dir, "artifacts", "context") },
		});
		const batchPlan = buildLaunchPlan({
			def: makeDef(),
			name: "scout",
			sessionsRoot: join(dir, "s"),
			identityPolicy: { kind: "temp", dir: join(dir, "s") },
		});
		assert.ok(panePlan.identityFile && batchPlan.identityFile);
		assert.equal(readFileSync(panePlan.identityFile, "utf8"), readFileSync(batchPlan.identityFile, "utf8"));
		assert.equal(readFileSync(panePlan.identityFile, "utf8"), "You are scout.");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildIdentityFile: same pane name overwrites (deterministic), batch temp names stay unique", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-overwrite-"));
	try {
		const contextDir = join(dir, "artifacts", "context");
		const first = buildIdentityFile({ kind: "artifact", dir: contextDir }, "scout", "v1");
		const second = buildIdentityFile({ kind: "artifact", dir: contextDir }, "scout", "v2");
		assert.equal(first, second);
		assert.equal(readFileSync(first, "utf8"), "v2");
		const tempA = buildIdentityFile({ kind: "temp", dir: join(dir, "s") }, "scout", "v1");
		const tempB = buildIdentityFile({ kind: "temp", dir: join(dir, "s") }, "scout", "v1");
		assert.notEqual(tempA, tempB);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildLaunchPlan: empty def body yields no identity file and creates no context dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-nobody-"));
	try {
		const contextDir = join(dir, "artifacts", "context");
		const plan = buildLaunchPlan({
			def: makeDef({ body: "" }),
			name: "scout",
			sessionsRoot: join(dir, "s"),
			identityPolicy: { kind: "artifact", dir: contextDir },
		});
		assert.equal(plan.identityFile, undefined);
		assert.equal(existsSync(contextDir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cwdProblemMessage: ok for blank/valid dirs, structured message for missing paths and plain files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-cwd-"));
	try {
		assert.equal(cwdProblemMessage(undefined), null);
		assert.equal(cwdProblemMessage("   "), null);
		assert.equal(cwdProblemMessage(dir), null);
		assert.match(cwdProblemMessage(join(dir, "missing"))!, /does not exist/);
		const filePath = join(dir, "file.txt");
		writeFileSync(filePath, "x", "utf8");
		assert.match(cwdProblemMessage(filePath)!, /not a directory/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveLaunchCwd: trims and falls back, throws a readable error on a bad cwd", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-cwd-resolve-"));
	try {
		assert.equal(resolveLaunchCwd(`  ${dir}  `, "/elsewhere"), dir);
		assert.equal(resolveLaunchCwd(undefined, dir), dir);
		assert.equal(resolveLaunchCwd("", dir), dir);
		assert.throws(
			() => resolveLaunchCwd(join(dir, "nope"), dir),
			(err: unknown) => err instanceof Error && /does not exist/.test(err.message),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildTaskFile: artifact policy keeps per-name timestamped files, temp policy unique files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-launch-task-"));
	try {
		const contextDir = join(dir, "artifacts", "context");
		const artifact = buildTaskFile({ kind: "artifact", dir: contextDir }, "scout", "wrapped");
		assert.match(basename(artifact), /^scout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
		assert.equal(readFileSync(artifact, "utf8"), "wrapped");
		const temp = buildTaskFile({ kind: "temp", dir: join(dir, "s") }, "scout", "Task: raw");
		assert.match(basename(temp), /^\.task-[0-9a-f]{8}\.md$/);
		assert.equal(readFileSync(temp, "utf8"), "Task: raw");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
