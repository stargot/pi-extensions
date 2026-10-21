import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionCommandContext,
	ExtensionContext,
	MessageStartEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../agents.ts";
import { discoverAgents } from "../agents.ts";
import { readPrimeState, writePrimeState } from "../index.ts";
import { createPrimePolicy, type PrimeDeps, type PrimePolicy, type PrimeStateRead } from "../prime.ts";

/**
 * `test` with PI_SUBAGENT_SESSION neutralized: save → delete → restore in
 * finally (same pattern as the guards test below). An ambient value — set
 * in pi child sessions, where this suite runs via npm run smoke — would
 * flip the policy into its child guard and fail half the file.
 */
function test(name: string, fn: () => unknown): void {
	nodeTest(name, async () => {
		const saved = process.env.PI_SUBAGENT_SESSION;
		delete process.env.PI_SUBAGENT_SESSION;
		try {
			await fn();
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = saved;
		}
	});
}

// ── Fixtures ──

const def = (name: string, body: string, over: Partial<AgentDef> = {}): AgentDef => ({
	name,
	description: `${name} role`,
	model: undefined,
	thinking: undefined,
	tools: undefined,
	subagents: undefined,
	readonly: false,
	dispatch: true,
	autoExit: true,
	body,
	warnings: [],
	scope: "global",
	path: `/agents/${name}.md`,
	...over,
});

const basePool = (): Map<string, AgentDef> =>
	new Map([
		["prime", def("prime", "You are the prime orchestrator.")],
		["scout", def("scout", "You are scout.", { description: "fast recon" })],
		["worker", def("worker", "Worker body.", { description: "does work" })],
	]);

const SCOUT_BODY = "You are scout.";

const beforeEvent = (over: { append?: string; selectedTools?: string[] } = {}): BeforeAgentStartEvent =>
	({
		type: "before_agent_start",
		prompt: "do things",
		systemPrompt: "BASE SYSTEM PROMPT",
		systemPromptOptions: {
			appendSystemPrompt: over.append ?? "",
			selectedTools: over.selectedTools ?? ["subagent", "read", "grep", "bash", "edit", "write"],
		},
	}) as unknown as BeforeAgentStartEvent;

const userMessage = (): MessageStartEvent =>
	({ type: "message_start", message: { role: "user", content: "hi" } }) as unknown as MessageStartEvent;

const callEvent = (toolName: string, input: Record<string, unknown>): ToolCallEvent =>
	({ type: "tool_call", toolCallId: "c1", toolName, input }) as unknown as ToolCallEvent;

const resultEvent = (toolName: string, input: Record<string, unknown>, isError = false): ToolResultEvent =>
	({ type: "tool_result", toolCallId: "c1", toolName, input, content: [], isError }) as unknown as ToolResultEvent;

const lookupBlockReason = (spent: number): string =>
	`Prime solo enforcement: ${spent} lookup calls already spent this user turn (allowance 3 + 3 per dispatched agent). Delegate now: dispatch a scout (subagent tool) or a task_batch, then verify its report — verification is covered by the per-dispatch allowance. The user can raise the cap with /solo <N> or /solo off.`;

const fileBlockReason = (n: number): string =>
	`Prime solo enforcement: ${n} files already edited this user turn (limit 3). Bulk file work belongs to a worker: dispatch it (subagent/task_batch) with an exact task, then verify the diff. The user can relax this with /solo off.`;

function makeCtx(): {
	ctx: ExtensionContext & ExtensionCommandContext;
	notifications: Array<{ message: string; type?: string }>;
	widgets: string[];
} {
	const notifications: Array<{ message: string; type?: string }> = [];
	const widgets: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
			setWidget: (_key: string, content: unknown) => {
				if (typeof content !== "function") return;
				const component = (content as (_tui: null, theme: unknown) => { render: () => string[] })(null, {
					fg: (_role: string, text: string) => text,
				});
				widgets.push(component.render().join("\n"));
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContext & ExtensionCommandContext, notifications, widgets };
}

function makePolicy(options: { pool?: Map<string, AgentDef>; state?: PrimeStateRead; failWrite?: boolean } = {}): {
	prime: PrimePolicy;
	stateBox: { value: PrimeStateRead };
	writes: Array<{ path: string; enabled: boolean }>;
	ctx: ExtensionContext & ExtensionCommandContext;
	notifications: Array<{ message: string; type?: string }>;
	widgets: string[];
} {
	const stateBox = { value: options.state ?? ({ kind: "absent" } as PrimeStateRead) };
	const writes: Array<{ path: string; enabled: boolean }> = [];
	const deps: PrimeDeps = {
		agents: () => options.pool ?? basePool(),
		stateFile: "/project/.pi/prime.json",
		model: () => "zai/glm-5.3-flash",
		readState: () => stateBox.value,
		writeState: (path, enabled) => {
			if (options.failWrite) throw new Error("disk on fire");
			writes.push({ path, enabled });
			stateBox.value = { kind: "ok", enabled };
		},
	};
	const { ctx, notifications, widgets } = makeCtx();
	return { prime: createPrimePolicy(deps), stateBox, writes, ctx, notifications, widgets };
}

const lookup = (prime: PrimePolicy, path: string) => prime.onToolCall(callEvent("read", { path }));
const edit = (prime: PrimePolicy, path: string) => prime.onToolCall(callEvent("edit", { path }));
const bash = (prime: PrimePolicy, command: string) => prime.onToolCall(callEvent("bash", { command }));

/** Real agent tree on disk → the merged pool through discoverAgents. */
function makeAgentsTree(files: { global?: Record<string, string>; project?: Record<string, string> }): {
	deps: PrimeDeps;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-prime-policy-test-"));
	const globalDir = join(root, "global");
	const cwd = join(root, "project");
	mkdirSync(join(globalDir, "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	for (const [name, content] of Object.entries(files.global ?? {})) {
		writeFileSync(join(globalDir, "agents", name), content, "utf8");
	}
	for (const [name, content] of Object.entries(files.project ?? {})) {
		writeFileSync(join(cwd, ".pi", "agents", name), content, "utf8");
	}
	return {
		deps: {
			agents: () => discoverAgents(cwd, globalDir),
			stateFile: join(cwd, ".pi", "prime.json"),
			model: () => undefined,
			readState: () => ({ kind: "absent" }),
			writeState: () => {},
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// ── Toggle / state file ──

test("toggle: absent file → on, silently (only the first-message banner)", () => {
	const { prime, ctx, notifications } = makePolicy({ state: { kind: "absent" } });
	const override = prime.onBeforeAgentStart(beforeEvent());
	assert.ok(override?.systemPrompt?.includes("## Solo budget — enforced in code"));
	prime.onUserMessageStart(userMessage(), ctx);
	assert.deepEqual(
		notifications.map((n) => n.message),
		["⚡ Prime online — orchestrator mode · zai/glm-5.3-flash · 2 agents in the pool"],
	);
});

test("toggle: {enabled:false} → off — no injection, tools pass, widget stays ⚡ Prime · off", () => {
	const { prime, ctx, notifications, widgets } = makePolicy({ state: { kind: "ok", enabled: false } });
	assert.equal(prime.onBeforeAgentStart(beforeEvent()), undefined);
	for (let i = 0; i < 10; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	for (let i = 0; i < 4; i++) assert.equal(edit(prime, `/src/f${i}.ts`), undefined);
	prime.onUserMessageStart(userMessage(), ctx);
	assert.deepEqual(notifications, []);
	assert.ok(widgets.at(-1)?.includes("⚡ Prime · off"));
});

test("toggle: broken state file after off → keeps off, warns once, widget shows unknown", () => {
	const { prime, stateBox, ctx, notifications, widgets } = makePolicy({ state: { kind: "ok", enabled: true } });
	prime.onBeforeAgentStart(beforeEvent());
	prime.onPrimeCommand("off", ctx);
	assert.deepEqual(stateBox.value, { kind: "ok", enabled: false });

	stateBox.value = { kind: "error", message: "EACCES: hand-edited garbage" };
	// The broken file is observed on the next before_agent_start read; the
	// warning (ui) fires on the next user message.
	assert.equal(prime.onBeforeAgentStart(beforeEvent()), undefined);
	prime.onUserMessageStart(userMessage(), ctx);
	prime.onUserMessageStart(userMessage(), ctx);
	const warnings = notifications.filter((n) => n.message.includes("unreadable"));
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]?.type, "warning");
	assert.ok(widgets.at(-1)?.includes("⚡ Prime · unknown (broken .pi/prime.json)"));
	// Enforcement keeps the last-known-good off: lookups pass through.
	assert.equal(lookup(prime, "/x.ts"), undefined);
});

test("toggle: broken state file at session start (no previous value) → session starts on", () => {
	const { prime, ctx, notifications } = makePolicy({ state: { kind: "error", message: "invalid JSON" } });
	prime.onSessionStart(ctx);
	assert.equal(notifications[0]?.type, "warning");
	const override = prime.onBeforeAgentStart(beforeEvent());
	assert.ok(override?.systemPrompt?.includes("## Solo budget — enforced in code"));
	// And enforcement is really on: the 4th lookup blocks.
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/f3.ts"), { block: true, reason: lookupBlockReason(3) });
});

test("toggle: /prime off and /prime on write {enabled} to the state file", () => {
	const { prime, writes, ctx } = makePolicy();
	prime.onPrimeCommand("off", ctx);
	assert.deepEqual(writes, [{ path: "/project/.pi/prime.json", enabled: false }]);
	prime.onPrimeCommand("on", ctx);
	assert.deepEqual(writes[1], { path: "/project/.pi/prime.json", enabled: true });
	prime.onPrimeCommand("status", ctx);
	assert.equal(writes.length, 2);
});

test("toggle: writeState failure → error notify, mode unchanged (still enforcing)", () => {
	const { prime, ctx, notifications } = makePolicy({ failWrite: true });
	prime.onBeforeAgentStart(beforeEvent());
	prime.onPrimeCommand("off", ctx);
	assert.ok(notifications.some((n) => n.type === "error" && n.message.includes("disk on fire")));
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/f3.ts"), { block: true, reason: lookupBlockReason(3) });
});

test("toggle: /prime status reports mode, state file, on-effects, toggles; unknown args get usage", () => {
	const { prime, ctx, notifications } = makePolicy({ state: { kind: "ok", enabled: false } });
	prime.onPrimeCommand("status", ctx);
	const status = notifications.find((n) => n.message.includes("Prime is off"))?.message ?? "";
	assert.ok(status.includes("/project/.pi/prime.json"));
	assert.ok(status.includes("3 lookups + 3 per dispatched agent"));
	assert.ok(status.includes("3 distinct files per user turn"));
	assert.ok(status.includes("/prime on | off"));
	assert.ok(status.includes("/solo"));
	notifications.length = 0;
	prime.onPrimeCommand("wat", ctx);
	assert.ok(notifications.some((n) => n.message.includes("Usage: /prime on | off | status")));
});

test("toggle: non-boolean enabled (hand-edited) → broken file, last-known-good, warns once", () => {
	const { prime, stateBox, ctx, notifications } = makePolicy({ state: { kind: "ok", enabled: false } });
	prime.onBeforeAgentStart(beforeEvent());
	// readPrimeState reports {"enabled":"false"|0|null} as an error, not as on.
	stateBox.value = { kind: "error", message: '"enabled" must be a boolean, got "false"' };
	assert.equal(prime.onBeforeAgentStart(beforeEvent()), undefined);
	prime.onUserMessageStart(userMessage(), ctx);
	const warnings = notifications.filter((n) => n.message.includes("unreadable"));
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]?.type, "warning");
	// Last-known-good off: enforcement stays lifted.
	assert.equal(lookup(prime, "/x.ts"), undefined);
});

test("toggle: /prime on|off notify the next-turn timing; off reassures about subagent tools", () => {
	const { prime, ctx, notifications } = makePolicy();
	prime.onPrimeCommand("off", ctx);
	prime.onPrimeCommand("on", ctx);
	assert.deepEqual(
		notifications.map((n) => n.message),
		[
			"Prime off — инъекция и блокировки сняты со следующего хода; инструменты субагентов остаются доступны",
			"Prime on — протокол и solo-enforcement вернутся со следующего хода",
		],
	);
});

test("toggle: /solo in off mode → hint, state untouched", () => {
	const { prime, writes, ctx, notifications } = makePolicy({ state: { kind: "ok", enabled: false } });
	prime.onSessionStart(ctx);
	prime.onSoloCommand("5", ctx);
	assert.deepEqual(
		notifications.map((n) => n.message),
		["Prime выключен — сначала /prime on"],
	);
	assert.deepEqual(writes, []);
});

// ── Off semantics (enforcement machinery is bypassed) ──

test("off: 10th lookup and 4th file edit are not blocked", () => {
	const { prime } = makePolicy({ state: { kind: "ok", enabled: false } });
	prime.onBeforeAgentStart(beforeEvent());
	for (let i = 0; i < 10; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	for (let i = 0; i < 5; i++) assert.equal(edit(prime, `/src/f${i}.ts`), undefined);
});

test("off: no banner, no notifications", () => {
	const { prime, ctx, notifications } = makePolicy({ state: { kind: "ok", enabled: false } });
	prime.onBeforeAgentStart(beforeEvent());
	prime.onUserMessageStart(userMessage(), ctx);
	assert.deepEqual(notifications, []);
});

// ── On parity with the old extension ──

test("on: 3rd lookup passes, 4th blocked with the verbatim reason", () => {
	const { prime } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	assert.equal(lookup(prime, "/a.ts"), undefined);
	assert.equal(lookup(prime, "/b.ts"), undefined);
	assert.equal(lookup(prime, "/c.ts"), undefined);
	assert.deepEqual(lookup(prime, "/d.ts"), { block: true, reason: lookupBlockReason(3) });
});

test("on: re-reading an already-read file is free", () => {
	const { prime } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	assert.equal(lookup(prime, "/a.ts"), undefined);
	assert.equal(lookup(prime, "/b.ts"), undefined);
	assert.equal(lookup(prime, "/c.ts"), undefined);
	assert.equal(lookup(prime, "/a.ts"), undefined);
	assert.deepEqual(lookup(prime, "/d.ts"), { block: true, reason: lookupBlockReason(3) });
});

test("on: a successful dispatch raises the allowance by 3, an errored one does not", () => {
	const { prime } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	prime.onToolResult(resultEvent("subagent", { agent: "scout" }), makeCtx().ctx);
	for (let i = 3; i < 6; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/f6.ts"), { block: true, reason: lookupBlockReason(6) });

	// Errored dispatch: no allowance, counters unchanged after a fresh turn.
	prime.onUserMessageStart(userMessage(), makeCtx().ctx);
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/g${i}.ts`), undefined);
	prime.onToolResult(resultEvent("subagent", { agent: "ghost" }, true), makeCtx().ctx);
	assert.deepEqual(lookup(prime, "/g3.ts"), { block: true, reason: lookupBlockReason(3) });
});

test("on: file cap 3 with its message; re-editing a claimed file is free", () => {
	const { prime } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	assert.equal(edit(prime, "/a.ts"), undefined);
	assert.equal(edit(prime, "/b.ts"), undefined);
	assert.equal(edit(prime, "/c.ts"), undefined);
	assert.equal(edit(prime, "/b.ts"), undefined);
	assert.deepEqual(edit(prime, "/d.ts"), { block: true, reason: fileBlockReason(3) });
});

test("on: shell writes count against the file cap", () => {
	const { prime } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	assert.equal(edit(prime, "/a.ts"), undefined);
	assert.equal(bash(prime, "Set-Content -Path b.txt -Value 1"), undefined);
	assert.equal(bash(prime, "echo x > c.md"), undefined);
	assert.deepEqual(bash(prime, "echo y > d.md"), { block: true, reason: fileBlockReason(3) });
	// Non-writing shell work neither blocks nor spends the file cap.
	assert.equal(bash(prime, "npm test"), undefined);
});

test("on: task_batch tasks+chain raise the allowance per step", () => {
	const { prime } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	prime.onToolResult(
		resultEvent("task_batch", { tasks: [{ agent: "a" }, { agent: "b" }], chain: [{ agent: "c" }] }),
		makeCtx().ctx,
	);
	for (let i = 3; i < 12; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/f12.ts"), { block: true, reason: lookupBlockReason(12) });
});

test("on: /solo N overrides the cap and resets on a new user message", () => {
	const { prime, ctx } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	prime.onSoloCommand("10", ctx);
	// /solo <N> is an absolute per-turn cap: 3 spent + 7 more pass, the 11th blocks.
	for (let i = 3; i < 10; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/f10.ts"), { block: true, reason: lookupBlockReason(10) });

	prime.onUserMessageStart(userMessage(), ctx);
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/g${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/g3.ts"), { block: true, reason: lookupBlockReason(3) });
});

test("on: /solo off lifts everything until the next user message", () => {
	const { prime, ctx } = makePolicy();
	prime.onBeforeAgentStart(beforeEvent());
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	prime.onSoloCommand("off", ctx);
	for (let i = 3; i < 20; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
	assert.equal(edit(prime, "/a.ts"), undefined);
	assert.equal(edit(prime, "/b.ts"), undefined);
	assert.equal(edit(prime, "/c.ts"), undefined);
	assert.equal(edit(prime, "/d.ts"), undefined);

	prime.onUserMessageStart(userMessage(), ctx);
	for (let i = 0; i < 3; i++) assert.equal(lookup(prime, `/g${i}.ts`), undefined);
	assert.deepEqual(lookup(prime, "/g3.ts"), { block: true, reason: lookupBlockReason(3) });
});

// ── Pool: dispatch table and injection content ──

test("pool: prime excluded by frontmatter name even under another file name", () => {
	const tree = makeAgentsTree({
		global: {
			"orchestrator.md": "---\nname: prime\ndescription: self under another file name\n---\nPrime body.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nScout body.",
		},
	});
	try {
		const { prime } = makePolicy({ pool: tree.deps.agents() });
		const override = prime.onBeforeAgentStart(beforeEvent());
		const table = override?.systemPrompt ?? "";
		assert.ok(table.includes("| scout | recon |"));
		assert.ok(!table.includes("self under another file name"));
		assert.ok(!table.startsWith("| prime"));
	} finally {
		tree.cleanup();
	}
});

test("pool: prime excluded by file name even when frontmatter renames it", () => {
	const tree = makeAgentsTree({
		global: {
			"prime.md": "---\nname: retired-orchestrator\ndescription: renamed role\n---\nOld body.",
			"orchestrator.md": "---\nname: prime\ndescription: canonical\n---\nCanonical prime body.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nScout body.",
		},
	});
	try {
		const { prime } = makePolicy({ pool: tree.deps.agents() });
		const override = prime.onBeforeAgentStart(beforeEvent());
		const prompt = override?.systemPrompt ?? "";
		assert.ok(prompt.includes("Canonical prime body."));
		assert.ok(prompt.includes("| scout | recon |"));
		assert.ok(!prompt.includes("retired-orchestrator"));
	} finally {
		tree.cleanup();
	}
});

test("pool: dispatch:false opts out of the table", () => {
	const tree = makeAgentsTree({
		global: {
			"prime.md": "---\nname: prime\n---\nYou are the prime orchestrator.",
			"librarian.md": "---\nname: librarian\ndescription: archive\ndispatch: false\n---\nBody.",
			"auditor.md": "---\nname: auditor\ndescription: audits\n---\nBody.",
		},
	});
	try {
		const { prime } = makePolicy({ pool: tree.deps.agents() });
		const override = prime.onBeforeAgentStart(beforeEvent());
		const prompt = override?.systemPrompt ?? "";
		assert.ok(prompt.includes("| auditor | audits |"));
		assert.ok(!prompt.includes("librarian"));
	} finally {
		tree.cleanup();
	}
});

test("pool: project agent joins the table; project prime overrides the global body", () => {
	const tree = makeAgentsTree({
		global: {
			"prime.md": "---\nname: prime\n---\nGLOBAL PRIME BODY.",
			"scout.md": "---\nname: scout\ndescription: recon\n---\nScout body.",
		},
		project: {
			"worker.md": "---\nname: worker\ndescription: project bulk work\n---\nWorker body.",
			"prime.md": "---\nname: prime\n---\nPROJECT PRIME BODY.",
		},
	});
	try {
		const { prime } = makePolicy({ pool: tree.deps.agents() });
		const override = prime.onBeforeAgentStart(beforeEvent());
		const prompt = override?.systemPrompt ?? "";
		assert.ok(prompt.includes("PROJECT PRIME BODY."));
		assert.ok(!prompt.includes("GLOBAL PRIME BODY."));
		assert.ok(prompt.includes("| worker | project bulk work |"));
		assert.ok(prompt.includes("| scout | recon |"));
	} finally {
		tree.cleanup();
	}
});

test("pool: prime-only pool → protocol without a dispatch table", () => {
	const pool = new Map([["prime", def("prime", "You are the prime orchestrator.")]]);
	const { prime } = makePolicy({ pool });
	const override = prime.onBeforeAgentStart(beforeEvent());
	assert.ok(override?.systemPrompt?.includes("You are the prime orchestrator."));
	assert.ok(override?.systemPrompt?.includes("## Solo budget — enforced in code"));
	assert.ok(!override?.systemPrompt?.includes("## Dispatch table"));
});

// ── Guards (order: env → append → selectedTools → armed, then toggle) ──

test("guards: PI_SUBAGENT_SESSION → no injection, no blocking, no banner", () => {
	process.env.PI_SUBAGENT_SESSION = "1";
	try {
		const { prime, ctx, notifications } = makePolicy();
		assert.equal(prime.onBeforeAgentStart(beforeEvent()), undefined);
		for (let i = 0; i < 5; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
		prime.onUserMessageStart(userMessage(), ctx);
		assert.deepEqual(notifications, []);
	} finally {
		delete process.env.PI_SUBAGENT_SESSION;
	}
});

test("guards: append ending with an agent body is a child — no injection, not armed", () => {
	const { prime } = makePolicy();
	const override = prime.onBeforeAgentStart(beforeEvent({ append: `Shared rules.\n\n${SCOUT_BODY}` }));
	assert.equal(override, undefined);
	for (let i = 0; i < 5; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
});

test("guards: selectedTools without subagent → not armed", () => {
	const { prime } = makePolicy();
	assert.equal(prime.onBeforeAgentStart(beforeEvent({ selectedTools: ["read", "grep"] })), undefined);
	for (let i = 0; i < 5; i++) assert.equal(lookup(prime, `/f${i}.ts`), undefined);
});

// ── Real state-file implementations (index.ts) ──

test("readPrimeState: absent, enabled:false, missing key → on, unknown keys ignored; invalid JSON and non-boolean enabled → error", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-prime-state-test-"));
	const file = join(dir, "prime.json");
	try {
		assert.deepEqual(readPrimeState(file), { kind: "absent" });
		writePrimeState(file, false);
		assert.deepEqual(readPrimeState(file), { kind: "ok", enabled: false });
		writeFileSync(file, '{"enabled":true,"junk":"x"}', "utf8");
		assert.deepEqual(readPrimeState(file), { kind: "ok", enabled: true });
		writeFileSync(file, '{"junk":1}', "utf8");
		assert.deepEqual(readPrimeState(file), { kind: "ok", enabled: true });
		writeFileSync(file, "not json at all", "utf8");
		assert.equal(readPrimeState(file).kind, "error");
		// A hand-edited truthy-but-not-boolean value is not a mode: it must
		// not silently read as on (last-known-good branch instead).
		for (const garbage of ['{"enabled":"false"}', '{"enabled":0}', '{"enabled":null}', "42"]) {
			writeFileSync(file, garbage, "utf8");
			const read = readPrimeState(file);
			assert.ok(read.kind === "error" && typeof read.message === "string", garbage);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writePrimeState: two atomic writes — no tmp debris, last value wins", () => {
	// The tmp name carries pid+time+random, so two calls in a row cannot
	// collide; each write renames its tmp file away — a leftover *.tmp would
	// mean an in-place write, not tmp+rename.
	const dir = mkdtempSync(join(tmpdir(), "pi-prime-state-test-"));
	const file = join(dir, "sub", "prime.json");
	try {
		writePrimeState(file, true);
		writePrimeState(file, false);
		assert.deepEqual(readPrimeState(file), { kind: "ok", enabled: false });
		assert.deepEqual(
			readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp")),
			[],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
