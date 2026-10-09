/**
 * Golden-output guard for the task_batch renderResult: renders a fixed
 * fixture matrix through the tool renderer registered by index.ts and
 * compares the visible lines (ANSI stripped) against
 * batch-render.golden.json. Time is frozen, the theme is an identity fake —
 * the output must be byte-identical across refactors of the render path.
 * The golden file is captured on the first run (pre-refactor state) and
 * asserted on every run after that.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { BatchResult } from "../batch.ts";
import subagentsExtension from "../index.ts";

initTheme("dark");

// Frozen clock: spinnerFrame(), elapsedOf() and batchWallTime() all read
// Date.now() — a constant makes every render deterministic.
const FIXED_NOW = 1_750_000_000_000;
Date.now = () => FIXED_NOW;

// Identity theme: fg/bg/bold return the text as-is, so golden lines carry
// only the structural glyphs and the real Markdown theme's ANSI (stripped).
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

const usage = (over: Partial<BatchResult["usage"]> = {}): BatchResult["usage"] => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
	...over,
});

const singleOk: BatchResult = {
	agent: "scout",
	task: "Find the failing test",
	exitCode: 0,
	messages: [
		{ role: "user", content: [{ type: "text", text: "Task: Find the failing test" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "TODO", path: "src" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "src/a.ts:12: TODO fix me" }] },
		{
			role: "assistant",
			model: "claude-x",
			stopReason: "stop",
			usage: { input: 1200, output: 340, cost: { total: 0.0042 }, totalTokens: 9000 },
			content: [{ type: "text", text: "Found it in **src/a.ts** — the TODO marks the spot." }],
		},
	],
	stderr: "",
	usage: usage({ input: 1200, output: 340, cost: 0.0042, contextTokens: 9000, turns: 2 }),
	model: "claude-x",
	stopReason: "stop",
	elapsedMs: 65_000,
};

const singleFailed: BatchResult = {
	agent: "writer",
	task: "Write the docs",
	exitCode: 1,
	messages: [{ role: "assistant", stopReason: "error", errorMessage: "Model overloaded after 3 retries", content: [] }],
	stderr: ["WARN deprecated flag", "Error: ECONNRESET", " at retry (cli.ts:88)", " at main (cli.ts:12)", "exit 1"].join(
		"\n",
	),
	usage: usage({ input: 800, turns: 1 }),
	stopReason: "error",
	errorMessage: "Model overloaded after 3 retries",
	elapsedMs: 4000,
};

const singleRunning: BatchResult = {
	agent: "scout",
	task: "long hunt",
	exitCode: -1,
	messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] }],
	stderr: "",
	usage: usage(),
	startedAt: FIXED_NOW - 42_000,
	liveTool: { name: "bash" },
};

const singleManyItems: BatchResult = {
	...singleOk,
	task: "Sweep the repo for stale TODOs",
	messages: [
		...Array.from({ length: 12 }, (_, i) => ({
			role: "assistant",
			content: [{ type: "toolCall", name: "grep", arguments: { pattern: `todo-${i}`, path: "src" } }],
		})),
		{
			role: "assistant",
			model: "claude-x",
			stopReason: "stop",
			usage: { input: 1200, output: 340, cost: { total: 0.0042 }, totalTokens: 9000 },
			content: [{ type: "text", text: "Found 12 stale TODOs." }],
		},
	],
	usage: usage({ input: 1200, output: 340, cost: 0.0042, contextTokens: 9000, turns: 13 }),
};

const chainOk: BatchResult[] = [
	{ ...singleOk, step: 1, startedAt: FIXED_NOW - 100_000, finishedAt: FIXED_NOW - 35_000 },
	{ ...singleOk, agent: "writer", task: "Expand the finding", step: 2, elapsedMs: 31_000 },
	{ ...singleOk, agent: "reviewer", task: "Review the draft", step: 3, elapsedMs: 12_000 },
];

const chainRunning: BatchResult[] = [
	chainOk[0],
	chainOk[1],
	{ ...singleRunning, agent: "reviewer", task: "Review the draft", step: 3 },
];

const chainFailed: BatchResult[] = [...chainOk.slice(0, 2), { ...singleFailed, agent: "reviewer", step: 3 }];

const parallelDone: BatchResult[] = [
	{ ...singleOk, startedAt: FIXED_NOW - 90_000, finishedAt: FIXED_NOW - 40_000 },
	{
		...singleOk,
		agent: "writer",
		task: "Draft the changelog",
		usage: usage({ input: 2000, output: 900, cost: 0.02, contextTokens: 12_000, turns: 3 }),
		elapsedMs: 70_000,
		startedAt: FIXED_NOW - 80_000,
		finishedAt: FIXED_NOW - 10_000,
	},
	{
		...singleFailed,
		agent: "reviewer",
		elapsedMs: 20_000,
		startedAt: FIXED_NOW - 60_000,
		finishedAt: FIXED_NOW - 40_000,
	},
];

const parallelLive: BatchResult[] = [
	{ ...singleRunning, startedAt: FIXED_NOW - 10_000 },
	{ ...singleRunning, agent: "writer", task: "Draft the changelog", startedAt: FIXED_NOW - 5000, liveTool: undefined },
	{
		agent: "reviewer",
		task: "Review the draft",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: usage(),
		queued: true,
	},
];

interface RenderCase {
	name: string;
	result: AgentToolResult<unknown>;
	width: number;
	expanded: boolean;
}

const cases: RenderCase[] = [
	{
		name: "no-details-fallback",
		result: { content: [{ type: "text", text: "Plain text fallback" }], details: undefined },
		width: 120,
		expanded: false,
	},
	{
		name: "empty-results",
		result: { content: [{ type: "text", text: "Invalid parameters." }], details: { mode: "single", results: [] } },
		width: 120,
		expanded: false,
	},
	{
		name: "single-collapsed-ok",
		result: { content: [{ type: "text", text: "Found it." }], details: { mode: "single", results: [singleOk] } },
		width: 120,
		expanded: false,
	},
	{
		name: "single-collapsed-failed",
		result: { content: [{ type: "text", text: "failed" }], details: { mode: "single", results: [singleFailed] } },
		width: 120,
		expanded: false,
	},
	{
		name: "single-collapsed-running",
		result: {
			content: [{ type: "text", text: "(running...)" }],
			details: { mode: "single", results: [singleRunning] },
		},
		width: 120,
		expanded: false,
	},
	{
		name: "single-collapsed-no-output",
		result: {
			content: [{ type: "text", text: "(no output)" }],
			details: { mode: "single", results: [{ ...singleOk, messages: [], usage: usage() }] },
		},
		width: 120,
		expanded: false,
	},
	{
		name: "single-expanded-ok",
		result: { content: [{ type: "text", text: "Found it." }], details: { mode: "single", results: [singleOk] } },
		width: 120,
		expanded: true,
	},
	{
		name: "single-expanded-failed",
		result: { content: [{ type: "text", text: "failed" }], details: { mode: "single", results: [singleFailed] } },
		width: 120,
		expanded: true,
	},
	{
		name: "single-expanded-running",
		result: {
			content: [{ type: "text", text: "(running...)" }],
			details: { mode: "single", results: [singleRunning] },
		},
		width: 120,
		expanded: true,
	},
	{
		name: "single-expanded-ok-w80",
		result: { content: [{ type: "text", text: "Found it." }], details: { mode: "single", results: [singleOk] } },
		width: 80,
		expanded: true,
	},
	{
		name: "single-collapsed-item-overflow",
		result: {
			content: [{ type: "text", text: "Found 12 stale TODOs." }],
			details: { mode: "single", results: [singleManyItems] },
		},
		width: 120,
		expanded: false,
	},
	{
		name: "chain-collapsed-ok",
		result: {
			content: [{ type: "text", text: "done" }],
			details: { mode: "chain", results: chainOk, handOff: [0, 512, 1536] },
		},
		width: 120,
		expanded: false,
	},
	{
		name: "chain-expanded-ok",
		result: {
			content: [{ type: "text", text: "done" }],
			details: { mode: "chain", results: chainOk, handOff: [0, 512, 1536] },
		},
		width: 120,
		expanded: true,
	},
	{
		name: "chain-collapsed-running",
		result: {
			content: [{ type: "text", text: "(running...)" }],
			details: { mode: "chain", results: chainRunning, handOff: [0, 512, 0] },
		},
		width: 120,
		expanded: false,
	},
	{
		name: "chain-expanded-failed",
		result: {
			content: [{ type: "text", text: "stopped" }],
			details: { mode: "chain", results: chainFailed, handOff: [0, 512, 0] },
		},
		width: 120,
		expanded: true,
	},
	{
		name: "parallel-collapsed-ok",
		result: { content: [{ type: "text", text: "summaries" }], details: { mode: "parallel", results: parallelDone } },
		width: 120,
		expanded: false,
	},
	{
		name: "parallel-collapsed-failed",
		result: { content: [{ type: "text", text: "summaries" }], details: { mode: "parallel", results: parallelDone } },
		width: 120,
		expanded: false,
	},
	{
		name: "parallel-collapsed-live",
		result: {
			content: [{ type: "text", text: "Parallel: 0/3 done..." }],
			details: { mode: "parallel", results: parallelLive },
		},
		width: 120,
		expanded: false,
	},
	{
		name: "parallel-expanded-ok",
		result: { content: [{ type: "text", text: "summaries" }], details: { mode: "parallel", results: parallelDone } },
		width: 120,
		expanded: true,
	},
	{
		name: "parallel-expanded-live",
		result: {
			content: [{ type: "text", text: "Parallel: 0/3 done..." }],
			details: { mode: "parallel", results: parallelLive },
		},
		width: 120,
		expanded: true,
	},
];

// Load the extension with a recording fake — we only need the registered
// task_batch tool and its renderResult.
const registered = new Map<string, { name: string; renderResult?: (...args: unknown[]) => unknown }>();
const fakePi = {
	on: () => {},
	registerTool: (tool: { name: string; renderResult?: (...args: unknown[]) => unknown }) =>
		registered.set(tool.name, tool),
	registerCommand: () => {},
	registerMessageRenderer: () => {},
} as unknown as ExtensionAPI;
subagentsExtension(fakePi);

const renderCase = (c: RenderCase): string[] => {
	const tool = registered.get("task_batch");
	assert.ok(tool, "task_batch tool not registered");
	const component = tool.renderResult?.(
		c.result,
		{ expanded: c.expanded, isPartial: false } as ToolRenderResultOptions,
		fakeTheme,
		{
			isError: false,
		},
	) as { render(width: number): string[] };
	return component.render(c.width).map((line) => stripTerminalSequences(line));
};

const goldenUrl = new URL("./batch-render.golden.json", import.meta.url);

test("task_batch renderResult matches the captured golden output byte-for-byte", () => {
	if (!existsSync(goldenUrl)) {
		const captured = {
			fixedNow: FIXED_NOW,
			note: "Captured from the pre-refactor inline renderResult; do not edit by hand.",
			cases: cases.map((c) => ({ name: c.name, width: c.width, expanded: c.expanded, lines: renderCase(c) })),
		};
		writeFileSync(goldenUrl, `${JSON.stringify(captured, null, "\t")}\n`, "utf8");
	}
	const golden = JSON.parse(readFileSync(goldenUrl, "utf8")) as {
		fixedNow: number;
		cases: Array<{ name: string; lines: string[] }>;
	};
	assert.equal(golden.fixedNow, FIXED_NOW);
	assert.equal(golden.cases.length, cases.length);
	for (const g of golden.cases) {
		const c = cases.find((entry) => entry.name === g.name);
		assert.ok(c, `golden case ${g.name} has no fixture`);
		assert.deepEqual(renderCase(c), g.lines, `rendered output for case "${g.name}" drifted from the golden`);
	}
});
