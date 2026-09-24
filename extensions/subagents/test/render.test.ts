/**
 * Tests for the extracted render surface (render.ts): tool renderResult
 * bodies + the subagent_result completion card, driven with an identity
 * fake theme and asserted on visible text (ANSI stripped).
 *
 * Includes the MAJOR regression guard: the legacy subagent_result body is
 * line-joined (single "\n"), so the summary fallback must strip the
 * envelope line-wise — a "\n\n" paragraph split yields "(no summary)" for
 * the typical one-paragraph summary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
	legacyResultSummary,
	renderSubagentCancelResult,
	renderSubagentMessageResult,
	renderSubagentResult,
	renderSubagentsListResult,
	subagentResultCard,
	type SubagentResultMessage,
} from "../render.ts";

// The completion card renders its summary via Markdown, which needs the
// package theme initialized — once for the whole file.
initTheme("dark");

// Identity theme: fg/bg drop the color name and return the text as-is, so
// rendered lines carry no ANSI codes from OUR calls (the real Markdown
// theme still may — strip() removes those).
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

/** Render a component at a width and join the visible lines. */
const flat = (component: { render(width: number): string[] }, width = 120): string =>
	component
		.render(width)
		.map((line) => stripTerminalSequences(line))
		.join("\n");

const result = (text: string, details?: unknown): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details,
});
const renderOpts = (expanded = false): ToolRenderResultOptions => ({ expanded, isPartial: false });
const ctx = (isError: boolean) => ({ isError });
const card = (content: string, details?: unknown): SubagentResultMessage => ({
	content,
	details,
});
const cardOpts = (expanded = false) => ({ expanded, outputPad: 0 });

const FOLLOW_UP =
	'Follow up with subagent_message({ name: "x", message: "…" }) — the same name works whether the pane is still open or has since been closed.';

// ── legacyResultSummary — the MAJOR-fix fallback parser ──

test("legacyResultSummary: one-paragraph summary survives line-wise stripping", () => {
	const body = ['Sub-agent "x" (scout) finished in 5s.', "Usage: 1k in, 0 out.", "Summary text.", FOLLOW_UP].join("\n");
	assert.equal(legacyResultSummary(body), "Summary text.");
});

test("legacyResultSummary: multiline summary is kept whole", () => {
	const body = [
		'⚠ Sub-agent "x" was CANCELLED before finishing — treat everything below as partial work, do not assume the task completed.',
		'Sub-agent "x" (scout) cancelled by user after 5s.',
		"Usage: 1k in, 0 out.",
		"First line.",
		"Second line.",
		FOLLOW_UP,
	].join("\n");
	assert.equal(legacyResultSummary(body), "First line.\nSecond line.");
});

test("legacyResultSummary: empty summary (envelope only) → empty string", () => {
	const body = ['Sub-agent "x" (scout) exited without output.', "Usage: 0.", FOLLOW_UP].join("\n");
	assert.equal(legacyResultSummary(body), "");
});

test("legacyResultSummary: mid-summary lines that resemble envelope prefixes are kept", () => {
	const body = ['Sub-agent "x" (scout) finished in 5s.', "Report:\nUsage: unknown.\nSub-agent \"y\" mentioned.", FOLLOW_UP].join("\n");
	assert.equal(legacyResultSummary(body), "Report:\nUsage: unknown.\nSub-agent \"y\" mentioned.");
});

// ── subagent_result card ──

test("card: legacy one-paragraph body renders its summary, not (no summary) — MAJOR regression", () => {
	const body = ['Sub-agent "x" (scout) finished in 5s.', "Usage: 1k in, 0 out.", "Summary text.", FOLLOW_UP].join("\n");
	const out = flat(subagentResultCard(card(body), cardOpts(), fakeTheme));
	assert.match(out, /Summary text\./);
	assert.doesNotMatch(out, /\(no summary\)/);
});

test("card: new details — verdict, usage, summary", () => {
	const out = flat(
		subagentResultCard(card("", { name: "x", status: "finished", elapsedSec: 5, summary: "Done.", usageText: "1k in, 0 out" }), cardOpts(), fakeTheme),
	);
	assert.match(out, /✓ FINISHED/);
	assert.match(out, /\bx\b/);
	assert.match(out, /· 5s/);
	assert.match(out, /1k in, 0 out/);
	assert.match(out, /Done\./);
});

test("card: status failed → ✗ FAILED; cancelled → ⚠ CANCELLED", () => {
	const failed = flat(subagentResultCard(card("", { name: "x", status: "failed" }), cardOpts(), fakeTheme));
	assert.match(failed, /✗ FAILED/);
	const cancelled = flat(subagentResultCard(card("", { name: "x", status: "cancelled" }), cardOpts(), fakeTheme));
	assert.match(cancelled, /⚠ CANCELLED/);
});

test("card: legacy entry without details or summary text → (no summary)", () => {
	const out = flat(subagentResultCard(card(""), cardOpts(), fakeTheme));
	assert.match(out, /\(no summary\)/);
});

test("card: expanded — task stays on one line (TruncatedText), session shown", () => {
	const longTask = "do ".repeat(200); // ~600 chars — must not wrap the card
	const out = flat(
		subagentResultCard(
			card("", { name: "x", status: "finished", summary: "S", task: longTask, session: "/tmp/sessions/x.jsonl" }),
			cardOpts(true),
			fakeTheme,
		),
		80,
	);
	assert.match(out, /Task:/);
	assert.match(out, /\/tmp\/sessions\/x\.jsonl/);
	// top + task + summary + session + bottom — a wrapped task would inflate this
	assert.ok(out.split("\n").length <= 8, `card grew to ${out.split("\n").length} lines`);
});

// ── subagent (spawn) ──

test("subagent result: spawned chip with name, pane, agent", () => {
	const out = flat(renderSubagentResult(result("", { name: "scout", agent: "scout", pane: 7 }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /SPAWNED/);
	assert.match(out, /scout/);
	assert.match(out, /pane 7/);
});

test("subagent result: isError → error banner", () => {
	const out = flat(renderSubagentResult(result("boom"), renderOpts(), fakeTheme, ctx(true)));
	assert.match(out, /Error: boom/);
});

// ── subagent_message ──

test("subagent_message result: resumed", () => {
	const out = flat(renderSubagentMessageResult(result("", { resumed: true, agent: "scout", name: "scout", pane: 3 }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /RESUMED/);
	assert.match(out, /scout/);
	assert.match(out, /pane 3/);
});

test("subagent_message result: steered + interrupted", () => {
	const out = flat(renderSubagentMessageResult(result("", { name: "scout", status: "steered", interrupted: true }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /STEERED/);
	assert.match(out, /scout/);
	assert.match(out, /interrupted/);
});

test("subagent_message result: steered without interrupt → no interrupted tag", () => {
	const out = flat(renderSubagentMessageResult(result("", { name: "scout", status: "steered" }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /STEERED/);
	assert.doesNotMatch(out, /interrupted/);
});

test("subagent_message result: isError → error banner", () => {
	const out = flat(renderSubagentMessageResult(result("pane gone"), renderOpts(), fakeTheme, ctx(true)));
	assert.match(out, /Error: pane gone/);
});

// ── subagent_cancel ──

test("subagent_cancel result: cancelling", () => {
	const out = flat(renderSubagentCancelResult(result("", { name: "scout", status: "cancelling" }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /CANCELLING/);
	assert.match(out, /scout/);
});

test("subagent_cancel result: already-finished", () => {
	const out = flat(renderSubagentCancelResult(result("", { name: "scout", status: "already-finished" }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /already finished/);
});

test("subagent_cancel result: not-running (default)", () => {
	const out = flat(renderSubagentCancelResult(result("", { name: "scout" }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /not running/);
});

test("subagent_cancel result: isError → error banner", () => {
	const out = flat(renderSubagentCancelResult(result("no such agent"), renderOpts(), fakeTheme, ctx(true)));
	assert.match(out, /Error: no such agent/);
});

// ── subagents_list ──

const agentDef = {
	name: "scout",
	scope: "project",
	mode: "auto-exit",
	model: "",
	tools: "default",
	subagents: [],
	description: "Does recon",
};

test("subagents_list result: new details with agents — names, meta, description", () => {
	const out = flat(renderSubagentsListResult(result("", { count: 1, names: ["scout"], agents: [agentDef] }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /✓ 1 definitions/);
	assert.match(out, /scout/);
	assert.match(out, /\(project · auto-exit · tools: default\)/);
	assert.match(out, /Does recon/);
});

test("subagents_list result: legacy details {count, names} → definitions listed, not 'no definitions found'", () => {
	const out = flat(renderSubagentsListResult(result("", { count: 2, names: ["alpha", "beta"] }), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /✓ 2 definitions/);
	assert.match(out, /alpha/);
	assert.match(out, /beta/);
	assert.doesNotMatch(out, /no definitions found/);
});

test("subagents_list result: empty details → no definitions found", () => {
	const out = flat(renderSubagentsListResult(result("", {}), renderOpts(), fakeTheme, ctx(false)));
	assert.match(out, /no definitions found/);
});

test("subagents_list result: isError → error banner", () => {
	const out = flat(renderSubagentsListResult(result("discover failed"), renderOpts(), fakeTheme, ctx(true)));
	assert.match(out, /Error: discover failed/);
});
