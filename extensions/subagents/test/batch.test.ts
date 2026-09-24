import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	batchWallTime,
	cancelledResult,
	emptyResult,
	emptyUsage,
	elapsedOf,
	finalOutput,
	firstLines,
	formatDuration,
	formatToolCall,
	formatUsageStats,
	getPiInvocation,
	ingestBatchEvent,
	isFailedResult,
	isQueued,
	isRunning,
	mapWithConcurrencyLimit,
	oneline,
	progressBar,
	resultOutput,
	runHeadlessChild,
	SPINNER_FRAMES,
	spinnerFrame,
	substitutePrevious,
	summarizeTools,
	truncateOutput,
	type BatchResult,
} from "../batch.ts";
const assistantEvent = (overrides: Record<string, unknown> = {}) => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 12 },
		model: "glm-test",
		stopReason: "end",
		...overrides,
	},
});

test("ingestBatchEvent: collects messages, usage, model, stopReason", () => {
	const r = emptyResult("a", "t");
	assert.equal(ingestBatchEvent(r, assistantEvent()), true);
	assert.equal(ingestBatchEvent(r, assistantEvent({ content: [{ type: "text", text: "final" }] })), true);
	assert.equal(r.messages.length, 2);
	assert.equal(r.usage.turns, 2);
	assert.equal(r.usage.input, 20);
	assert.equal(r.usage.output, 4);
	assert.equal(r.usage.cost > 0, true);
	assert.equal(r.usage.contextTokens, 12);
	assert.equal(r.model, "glm-test");
	assert.equal(r.stopReason, "end");
	assert.equal(finalOutput(r.messages), "final");
});

test("ingestBatchEvent: ignores garbage and unknown events, collects tool_result_end", () => {
	const r = emptyResult("a", "t");
	assert.equal(ingestBatchEvent(r, null), false);
	assert.equal(ingestBatchEvent(r, "string"), false);
	assert.equal(ingestBatchEvent(r, { type: "turn_start" }), false);
	assert.equal(ingestBatchEvent(r, { type: "tool_result_end", message: { role: "toolResult" } }), true);
	assert.equal(r.messages.length, 1);
});

test("ingestBatchEvent: captures errors and failure detection", () => {
	const r = emptyResult("a", "t");
	ingestBatchEvent(r, assistantEvent({ stopReason: "error", errorMessage: "boom" }));
	assert.equal(r.stopReason, "error");
	assert.equal(r.errorMessage, "boom");
	assert.equal(isFailedResult(r), true);
	assert.equal(resultOutput(r), "boom");
});

test("resultOutput fallbacks: stderr, then no-output", () => {
	const r = emptyResult("a", "t");
	r.exitCode = 3;
	r.stderr = "crash";
	assert.equal(resultOutput(r), "crash");
	const ok = emptyResult("a", "t");
	assert.equal(resultOutput(ok), "(no output)");
});

test("substitutePrevious replaces every placeholder", () => {
	assert.equal(substitutePrevious("A {previous} B {previous}", "x"), "A x B x");
	assert.equal(substitutePrevious("no placeholder", "x"), "no placeholder");
});

test("truncateOutput: under cap unchanged, over cap cut with marker", () => {
	const small = "abc";
	assert.equal(truncateOutput(small, 100), small);
	const big = "x".repeat(300);
	const out = truncateOutput(big, 100);
	assert.ok(out.startsWith("x".repeat(100)));
	assert.match(out, /\[Output truncated: \d+ bytes omitted\.\]/);
});

test("mapWithConcurrencyLimit: preserves order, respects limit", async () => {
	let concurrent = 0;
	let maxConcurrent = 0;
	const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await new Promise((r) => setTimeout(r, 10));
		concurrent--;
		return n * 2;
	});
	assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
	assert.ok(maxConcurrent <= 2, `max concurrency ${maxConcurrent} exceeded limit`);
});

test("progressBar: fills proportionally and clamps", () => {
	assert.equal(progressBar(0, 8, 8), "▱▱▱▱▱▱▱▱");
	assert.equal(progressBar(3, 8, 8), "▰▰▰▱▱▱▱▱");
	assert.equal(progressBar(8, 8, 8), "▰▰▰▰▰▰▰▰");
	assert.equal(progressBar(9, 8, 8), "▰▰▰▰▰▰▰▰", "over-done clamps to full");
	assert.equal(progressBar(-1, 8, 8), "▱▱▱▱▱▱▱▱", "negative clamps to empty");
	assert.equal(progressBar(1, 0, 4), "▱▱▱▱", "degenerate total stays empty");
});

test("formatDuration: sub-second, seconds, minutes", () => {
	assert.equal(formatDuration(400), "<1s");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(64_000), "1m04s");
	assert.equal(formatDuration(3_600_000), "60m00s");
});

test("spinnerFrame: deterministic within a step, cycles across steps", () => {
	assert.equal(spinnerFrame(0), spinnerFrame(139));
	assert.notEqual(spinnerFrame(0), spinnerFrame(140));
	assert.ok(SPINNER_FRAMES.includes(spinnerFrame(123_456)), "frame is always a known glyph");
});

test("oneline: flattens whitespace and caps length", () => {
	assert.equal(oneline("a\nb\n\nc"), "a b c");
	assert.equal(oneline("x".repeat(100)), `${"x".repeat(59)}…`);
	assert.equal(oneline("short", 60), "short");
	assert.equal(oneline("   "), "");
});

test("firstLines: keeps first non-empty lines, marks the rest", () => {
	assert.equal(firstLines("a\n\nb\nc\nd", 3), "a\nb\nc\n[+1 more lines]");
	assert.equal(firstLines("one", 3), "one");
	assert.equal(firstLines("\n\n", 3), "");
});

test("summarizeTools: groups calls by name with counts", () => {
	const items = [
		{ type: "toolCall" as const, name: "bash" },
		{ type: "text" as const, text: "hi" },
		{ type: "toolCall" as const, name: "bash" },
		{ type: "toolCall" as const, name: "read" },
	];
	assert.equal(summarizeTools(items), "bash ×2, read");
	assert.equal(summarizeTools([]), "");
	assert.equal(summarizeTools([{ type: "text", text: "only text" }]), "");
});

test("batchWallTime: min start to max end, projects to now while running", () => {
	const mk = (startedAt?: number, finishedAt?: number) => ({ ...emptyResult("a", "t"), startedAt, finishedAt });
	const done = [mk(1_000, 2_500), mk(1_500, 4_000)];
	assert.equal(batchWallTime(done), 3_000);
	const running = [mk(1_000, 2_500), mk(3_000)];
	assert.equal(batchWallTime(running, 5_000), 4_000);
	assert.equal(batchWallTime([emptyResult("a", "t")]), undefined);
});

test("queued vs running placeholders: queued waits for a slot, then runs", () => {
	const queued: BatchResult = { ...emptyResult("a", "t"), exitCode: -1, queued: true };
	assert.equal(isQueued(queued), true);
	assert.equal(isRunning(queued), false);

	const started = { ...queued, queued: false };
	assert.equal(isQueued(started), false);
	assert.equal(isRunning(started), true);
});

test("elapsedOf: measured duration when finished, projected while running", () => {
	const done: BatchResult = { ...emptyResult("a", "t"), elapsedMs: 1234 };
	assert.equal(elapsedOf(done), 1234);

	const running: BatchResult = { ...emptyResult("a", "t"), exitCode: -1, startedAt: 1_000 };
	assert.equal(elapsedOf(running, 3_500), 2_500);
	assert.equal(elapsedOf(emptyResult("a", "t")), undefined, "no timestamps — nothing to show");
});

test("formatUsageStats: compact stats line", () => {
	const usage = { ...emptyUsage(), input: 12300, output: 4500, cost: 0.0123, contextTokens: 9500, turns: 3 };
	const line = formatUsageStats(usage, "glm-test");
	assert.match(line, /3 turns/);
	assert.match(line, /↑12k/);
	assert.match(line, /↓4\.5k/);
	assert.match(line, /\$0\.01/);
	assert.match(line, /ctx:9\.5k/);
	assert.match(line, /glm-test/);
	assert.equal(formatUsageStats(emptyUsage()), "");
});

test("formatToolCall: bash/read/default shapes", () => {
	const fg = (_c: string, t: string) => t;
	assert.match(formatToolCall("bash", { command: "git status" }, fg), /\$ git status/);
	assert.match(formatToolCall("read", { path: "/a/b.ts", offset: 2, limit: 5 }, fg), /\/a\/b\.ts:2-6/);
	assert.match(formatToolCall("custom", { k: 1 }, fg), /custom \{"k":1\}/);
});

test("getPiInvocation: prefers node+script for existing .js argv, else pi shim", () => {
	const original = process.argv[1];
	try {
		const fixture = join(tmpdir(), `pi-batch-fixture-${Date.now()}.js`);
		writeFileSync(fixture, "console.log(1)", "utf8");
		process.argv[1] = fixture;
		let inv = getPiInvocation(["--mode", "json"]);
		assert.equal(inv.command, process.execPath);
		assert.equal(inv.args[0], fixture);

		process.argv[1] = join(tmpdir(), "does-not-exist.js");
		inv = getPiInvocation(["--mode", "json"]);
		assert.equal(inv.command, "pi");
		rmSync(fixture, { force: true });
	} finally {
		process.argv[1] = original;
	}
});

test("runHeadlessChild: spawns fixture, parses events, pre-creates session, cleans prompt file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-run-"));
	const sessionsRoot = join(dir, "sessions");
	const fixture = join(dir, "fixture.js");
	writeFileSync(
		fixture,
		[
			`console.log(JSON.stringify({type:"message_end", message:{role:"assistant", content:[{type:"text",text:"partial"}], usage:{input:10,output:2,cost:{total:0.001}}}}));`,
			`console.log(JSON.stringify({type:"tool_result_end", message:{role:"toolResult"}}));`,
			`console.log(JSON.stringify({type:"message_end", message:{role:"assistant", content:[{type:"text",text:"FINAL OUTPUT"}], model:"fixture-model", stopReason:"end", usage:{input:5,output:1,cost:{total:0.002}}}}));`,
			`console.error("some stderr");`,
			`process.exit(0);`,
		].join("\n"),
		"utf8",
	);

	const original = process.argv[1];
	try {
		process.argv[1] = fixture;
		const events: BatchResult[] = [];
		const result = await runHeadlessChild({
			agentName: "fix",
			agentLabel: "fix",
			task: "do things",
			cwd: dir,
			defaultCwd: dir,
			sessionsRoot,
			appendSystemPrompt: "identity body",
			denyTools: ["subagent"],
			onEvent: (r) => events.push({ ...r, messages: [...r.messages], usage: { ...r.usage } }),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "fixture-model");
		assert.equal(finalOutput(result.messages), "FINAL OUTPUT");
		assert.ok(result.stderr.includes("some stderr"));
		assert.ok(result.usage.cost > 0);
		assert.ok(result.sessionFile && existsSync(result.sessionFile), "session file pre-created");
		assert.ok(events.length >= 2, "onEvent fired during streaming");
		assert.ok(typeof result.startedAt === "number" && result.startedAt > 0, "startedAt recorded");
		assert.ok(typeof result.elapsedMs === "number" && result.elapsedMs >= 0, "elapsedMs recorded on exit");

		// The --append-system-prompt temp file must be cleaned up.
		const leftovers = readdirSync(sessionsRoot).filter((f) => f.startsWith(".identity-"));
		assert.equal(leftovers.length, 0, "identity temp file removed after run");
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runHeadlessChild: non-zero exit code propagates", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-exit-"));
	const fixture = join(dir, "fail.js");
	writeFileSync(fixture, `process.exit(3);`, "utf8");
	const original = process.argv[1];
	try {
		process.argv[1] = fixture;
		const result = await runHeadlessChild({
			agentName: "x",
			agentLabel: "x",
			task: "t",
			cwd: dir,
			defaultCwd: dir,
			sessionsRoot: join(dir, "sessions"),
		});
		assert.equal(result.exitCode, 3);
		assert.equal(isFailedResult(result), true);
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("BatchMessage shape: text-only message_end without usage is tolerated", () => {
	const r = emptyResult("a", "t");
	ingestBatchEvent(r, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
	assert.equal(r.usage.turns, 1);
	assert.equal(r.usage.input, 0);
	assert.equal(finalOutput(r.messages), "hi");
});

// ── Reliability fixes: chaining, cancel, timeout, compaction ──

test("substitutePrevious: replacement output is data, not a pattern ($&, $$ survive)", () => {
	const out = 'git log --format="%h %s" && echo "$$" done$&';
	assert.equal(substitutePrevious("Analyze: {previous}", out), `Analyze: ${out}`);
	assert.equal(substitutePrevious("no placeholder", out), "no placeholder");
});

test("cancelledResult: counts as failed with aborted stopReason", () => {
	const r = cancelledResult("scout", "task");
	assert.equal(isFailedResult(r), true);
	assert.equal(r.exitCode !== 0, true);
	assert.equal(r.stopReason, "aborted");
	assert.match(resultOutput(r), /cancelled/);
});

test("ingestBatchEvent: tool_execution_start/end track liveTool", () => {
	const r = emptyResult("a", "t");
	assert.equal(ingestBatchEvent(r, { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} }), true);
	assert.deepEqual(r.liveTool, { name: "bash" });
	assert.equal(ingestBatchEvent(r, { type: "tool_execution_end", toolCallId: "1" }), true);
	assert.equal(r.liveTool, undefined);
	// end without start is a no-op, unknown toolName is ignored
	assert.equal(ingestBatchEvent(r, { type: "tool_execution_end", toolCallId: "2" }), false);
	assert.equal(ingestBatchEvent(r, { type: "tool_execution_start" }), false);
});

test("runHeadlessChild: abort marks the result aborted/failed, not success", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-abort-"));
	const fixture = join(dir, "hang.js");
	writeFileSync(fixture, `setInterval(() => {}, 1000);`, "utf8");
	const original = process.argv[1];
	const ac = new AbortController();
	try {
		process.argv[1] = fixture;
		setTimeout(() => ac.abort(), 150);
		const started = Date.now();
		const result = await runHeadlessChild({
			agentName: "x",
			agentLabel: "x",
			task: "t",
			cwd: dir,
			defaultCwd: dir,
			sessionsRoot: join(dir, "sessions"),
			timeoutMs: 0, // off — abort is the killer here
			signal: ac.signal,
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 5000, `resolved promptly after abort (${elapsed}ms)`);
		assert.equal(isFailedResult(result), true, "aborted child is a failure, not a false success");
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.exitCode !== 0, true);
		assert.ok(result.errorMessage && result.errorMessage.length > 0);
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runHeadlessChild: timeout kills a hung child and reports timeout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-timeout-"));
	const fixture = join(dir, "hang.js");
	writeFileSync(fixture, `setInterval(() => {}, 1000);`, "utf8");
	const original = process.argv[1];
	try {
		process.argv[1] = fixture;
		const started = Date.now();
		const result = await runHeadlessChild({
			agentName: "x",
			agentLabel: "x",
			task: "t",
			cwd: dir,
			defaultCwd: dir,
			sessionsRoot: join(dir, "sessions"),
			timeoutMs: 300,
			killEscalationMs: 250,
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 5000, `timeout resolved promptly (${elapsed}ms)`);
		assert.equal(isFailedResult(result), true);
		assert.equal(result.stopReason, "timeout");
		assert.match(result.errorMessage || "", /timed out/);
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runHeadlessChild: SIGTERM-ignoring child is SIGKILLed after escalation (posix)", async () => {
	if (process.platform === "win32") return; // TerminateProcess cannot be ignored
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-escalate-"));
	const fixture = join(dir, "stubborn.js");
	writeFileSync(fixture, `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`, "utf8");
	const original = process.argv[1];
	try {
		process.argv[1] = fixture;
		const started = Date.now();
		const result = await runHeadlessChild({
			agentName: "x",
			agentLabel: "x",
			task: "t",
			cwd: dir,
			defaultCwd: dir,
			sessionsRoot: join(dir, "sessions"),
			timeoutMs: 200,
			killEscalationMs: 300,
		});
		const elapsed = Date.now() - started;
		// 200ms timeout + ~300ms escalation grace → well under 5s.
		assert.ok(elapsed < 5000, `escalation fired (${elapsed}ms)`);
		assert.equal(isFailedResult(result), true);
		assert.equal(result.stopReason, "timeout");
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runHeadlessChild: stderr is capped to a tail with a truncation marker", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-stderr-"));
	const fixture = join(dir, "noisy.js");
	writeFileSync(
		fixture,
		// One big write + a grace timeout: process.exit() would drop still-
		// buffered pipe output and the parent would never cross the cap.
		`let out = ""; for (let i = 0; i < 4000; i++) out += "noisy line " + i + " " + "x".repeat(60) + "\\n"; process.stderr.write(out); setTimeout(() => process.exit(0), 300);`,
		"utf8",
	);
	const original = process.argv[1];
	try {
		process.argv[1] = fixture;
		const result = await runHeadlessChild({
			agentName: "x",
			agentLabel: "x",
			task: "t",
			cwd: dir,
			defaultCwd: dir,
			sessionsRoot: join(dir, "sessions"),
			timeoutMs: 0,
		});
		assert.ok(result.stderr.startsWith("[...stderr truncated"), "marker present");
		assert.ok(result.stderr.length < 200 * 1024, `bounded (${result.stderr.length} bytes)`);
		assert.ok(result.stderr.includes("3999"), "tail (the useful end) preserved");
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
});
