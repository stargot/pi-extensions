/**
 * Testable render surface for the subagents extension: the renderResult
 * bodies of the four pane tools plus the subagent_result completion card.
 * Pure functions over (result, options, theme, context) — no extension
 * state, no filesystem access — so tests can drive them with a fake theme
 * and read `render(width)` output directly. index.ts wires them into
 * pi.registerTool / pi.registerMessageRenderer.
 */
import type { AgentToolResult, MessageRenderOptions, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, TruncatedText, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { oneline } from "./batch.ts";
import { formatUsage, type SessionUsageTotals } from "./session-read.ts";
import { fmtElapsed } from "./shared.ts";

type ToolResult = AgentToolResult<unknown>;

/** Minimal render context — the renderers only branch on `isError`. */
export interface RenderContext {
	isError: boolean;
}

/** First text block of an error result, for the error banner. */
const errorTextOf = (result: ToolResult, fallback: string): string => {
	const first = result.content[0] as { type?: string; text?: string } | undefined;
	return first?.type === "text" ? (first.text ?? fallback) : fallback;
};

// ── Shared render helpers (task_batch + pane tools + result card) ──

/** Verdict chip: reads before any text does. bg resets only itself, so the
 *  tail after the chip stays unhighlighted. */
export function verdictChip(theme: Theme, kind: "running" | "ok" | "fail" | "warning", label: string): string {
	const [bg, fg] =
		kind === "running"
			? (["toolPendingBg", "accent"] as const)
			: kind === "fail"
				? (["toolErrorBg", "error"] as const)
				: kind === "warning"
					? (["toolPendingBg", "warning"] as const)
					: (["toolSuccessBg", "success"] as const);
	return theme.bg(bg, theme.fg(fg, ` ${label} `));
}

/** One-line tool error banner. */
export function errorLine(theme: Theme, msg: string): string {
	return theme.bg("toolErrorBg", theme.fg("error", ` Error: ${oneline(msg, 120)} `));
}

/**
 * Rebuild the summary from a legacy subagent_result body — entries that
 * predate the `summary` detail. The content is LINE-joined (completeSubagent
 * glues its parts with a single "\n"): optional cancel banner, status line,
 * optional usage line, the summary itself (possibly multiline), and the
 * follow-up hint. Strip that envelope line-wise — a "\n\n" paragraph split
 * would swallow single-paragraph summaries whole (the typical case) and keep
 * only the middle paragraph out of three.
 */
export function legacyResultSummary(body: string): string {
	const lines = body.split("\n");
	// Leading envelope, in the order completeSubagent writes it: optional
	// cancel notice, status line, optional Usage line — at most 3 lines. The
	// cap keeps a summary whose first line merely starts with an envelope-like
	// prefix from being swallowed (best-effort heuristic either way).
	for (let stripped = 0; stripped < 3; stripped++) {
		const head = lines[0];
		if (
			head === undefined ||
			!(head.startsWith("⚠ Sub-agent") || head.startsWith('Sub-agent "') || head.startsWith("Usage: "))
		)
			break;
		lines.shift();
	}
	// Trailing follow-up hint.
	while (lines.length > 0 && lines[lines.length - 1].startsWith("Follow up with subagent_message")) {
		lines.pop();
	}
	return lines.join("\n").trim();
}

// ── Tool: subagent (spawn) ──

export function renderSubagentResult(result: ToolResult, _options: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
	if (context.isError) {
		return new Text(errorLine(theme, errorTextOf(result, "spawn failed")), 0, 0);
	}
	const details = (result.details ?? {}) as { name?: string; agent?: string; pane?: string | number };
	const text =
		verdictChip(theme, "ok", "SPAWNED") +
		` ${theme.fg("accent", details.name ?? "?")}` +
		theme.fg("muted", ` · pane ${details.pane ?? "?"} · ${details.agent ?? "?"}`);
	return new Text(text, 0, 0);
}

// ── Tool: subagent_message ──

export function renderSubagentMessageResult(result: ToolResult, _options: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
	if (context.isError) {
		return new Text(errorLine(theme, errorTextOf(result, "delivery failed")), 0, 0);
	}
	const details = (result.details ?? {}) as {
		name?: string;
		agent?: string;
		pane?: string | number;
		status?: string;
		interrupted?: boolean;
		resumed?: boolean;
	};
	if (details.resumed) {
		const text =
			verdictChip(theme, "ok", "RESUMED") +
			` ${theme.fg("accent", details.agent ?? details.name ?? "?")}` +
			theme.fg("muted", ` · pane ${details.pane ?? "?"}`);
		return new Text(text, 0, 0);
	}
	// Defensive: subagent_message never returns status "not-running" today
	// (only subagent_cancel does); kept so a misrouted details object still
	// renders sensibly.
	if (details.status === "not-running") {
		return new Text(theme.fg("dim", `○ ${details.name ?? "?"} not running — result already delivered`), 0, 0);
	}
	// steered (default): the message went to a live pane.
	let text = verdictChip(theme, "running", "STEERED") + ` ${theme.fg("accent", details.name ?? "?")}`;
	if (details.interrupted) text += theme.fg("warning", " · interrupted");
	return new Text(text, 0, 0);
}

// ── Tool: subagent_cancel ──

export function renderSubagentCancelResult(result: ToolResult, _options: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
	if (context.isError) {
		return new Text(errorLine(theme, errorTextOf(result, "cancel failed")), 0, 0);
	}
	const details = (result.details ?? {}) as { name?: string; status?: string };
	const name = details.name ?? "?";
	if (details.status === "cancelling") {
		const text =
			verdictChip(theme, "warning", "CANCELLING") +
			` ${theme.fg("accent", name)}` +
			theme.fg("muted", " · result still arrives as a steer message");
		return new Text(text, 0, 0);
	}
	if (details.status === "already-finished") {
		return new Text(theme.fg("dim", `○ ${name} already finished — result is being delivered`), 0, 0);
	}
	// not-running (default): registered, but no live pane to cancel.
	return new Text(theme.fg("dim", `○ ${name} not running — already finished, resume with subagent_message`), 0, 0);
}

// ── Tool: subagents_list ──

export function renderSubagentsListResult(result: ToolResult, _options: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
	if (context.isError) {
		return new Text(errorLine(theme, errorTextOf(result, "list failed")), 0, 0);
	}
	const details = (result.details ?? {}) as {
		count?: number;
		names?: string[];
		agents?: Array<{
			name: string;
			scope: string;
			mode: string;
			model: string;
			tools: string;
			subagents: string[];
			description: string;
		}>;
	};
	const agents = details.agents ?? [];
	if (agents.length === 0) {
		// Legacy details ({ count, names } — entries predating the agents
		// array) still carry real definitions; render the bare name list
		// instead of a false "no definitions found".
		const count = details.count ?? 0;
		if (count > 0) {
			const lines = [theme.fg("success", `✓ ${count} definitions`)];
			for (const name of details.names ?? []) lines.push(theme.fg("accent", name));
			return new Text(lines.join("\n"), 0, 0);
		}
		return new Text(theme.fg("muted", "no definitions found"), 0, 0);
	}
	const lines = [theme.fg("success", `✓ ${agents.length} definitions`)];
	for (const a of agents) {
		// Meta segments skip empties: no model, nothing to spawn → no segment.
		const meta = [
			a.scope,
			a.mode,
			a.model,
			`tools: ${a.tools || "default"}`,
			a.subagents?.length ? `may spawn: ${a.subagents.join(",")}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(`${theme.fg("accent", a.name)} ${theme.fg("muted", `(${meta})`)}`);
		if (a.description) lines.push(`  ${theme.fg("dim", a.description)}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}

// ── Message renderer: subagent_result ──

/** Structural subset of CustomMessage the card reads. CustomMessage itself
 *  is not re-exported from the package root, so tests feed a plain object. */
export interface SubagentResultMessage {
	content?: unknown;
	details?: unknown;
}

// Completion card: the verdict rides the top border, usage sits on the
// bottom border, the summary renders as Markdown inside. Display-only —
// the LLM context is the message content, untouched. The renderer also
// runs on session restore, so every field degrades gracefully on old or
// partial entries (optional chaining everywhere).
export function subagentResultCard(message: SubagentResultMessage, options: MessageRenderOptions, theme: Theme): Component {
	const details = (message.details ?? {}) as {
		name?: string;
		task?: string;
		session?: string;
		status?: string;
		elapsedSec?: number;
		usageText?: string;
		usage?: SessionUsageTotals;
		errorMessage?: string;
		cancelled?: boolean;
		summary?: string;
	};
	// Cancelled outranks failed: a force-closed cancel carries an
	// errorMessage too, but the verdict the reader needs is "cancelled".
	// Entries from before the status field exist derive it from the flags.
	const status = details.status ?? (details.cancelled ? "cancelled" : details.errorMessage ? "failed" : "finished");
	const chip =
		status === "cancelled"
			? verdictChip(theme, "warning", "⚠ CANCELLED")
			: status === "failed"
				? verdictChip(theme, "fail", "✗ FAILED")
				: verdictChip(theme, "ok", "✓ FINISHED");
	const header =
		`${chip} ${theme.fg("accent", details.name ?? "?")}` +
		(details.elapsedSec !== undefined ? theme.fg("dim", ` · ${fmtElapsed(details.elapsedSec)}`) : "");
	// Legacy entries carry no usageText/summary details — reconstruct both
	// (legacyResultSummary strips the line-joined envelope).
	const usageText = details.usageText ?? (details.usage ? formatUsage(details.usage) : undefined);
	const body = typeof message.content === "string" ? message.content : "";
	const summary = details.summary ?? legacyResultSummary(body);
	const card = new BatchCard((s) => theme.fg("borderMuted", s), header, usageText || undefined);
	if (options.expanded && details.task) {
		// One line: TruncatedText cuts at the viewport width, so a long task
		// cannot wrap the card into a tall block.
		card.addChild(new TruncatedText(theme.fg("muted", "Task: ") + theme.fg("dim", oneline(details.task, 400)), 0, 0));
	}
	if (summary) card.addChild(new Markdown(summary, 0, 0, getMarkdownTheme()));
	else card.addChild(new Text(theme.fg("muted", "(no summary)"), 0, 0));
	if (options.expanded && details.session) {
		card.addChild(new Text(theme.fg("dim", details.session), 0, 0));
	}
	if (options.outputPad) {
		const box = new Box(options.outputPad, 0, (text) => text);
		box.addChild(card);
		return box;
	}
	return card;
}

/**
 * Framed card for expanded batch results (idea No.5b): corners ╭╮╰╯ adapt to
 * the viewport width, the header rides the top border, the footer (usage)
 * sits right-aligned on the bottom border. Children render inside at
 * width−4; frame lines are cached per width and dropped on invalidate.
 */
export class BatchCard extends Container {
	private readonly borderColor: (s: string) => string;
	private readonly header: string;
	private readonly footer: string | undefined;
	private frameWidth?: number;
	private frameLines?: string[];

	constructor(borderColor: (s: string) => string, header: string, footer?: string) {
		super();
		this.borderColor = borderColor;
		this.header = header;
		this.footer = footer;
	}

	override render(width: number): string[] {
		if (this.frameWidth === width && this.frameLines) return this.frameLines;
		const inner = Math.max(width - 4, 8); // "│ " on the left, " │" on the right
		const lines = [this.topLine(width)];
		for (const line of super.render(inner)) {
			const pad = Math.max(inner - visibleWidth(line), 0);
			lines.push(`${this.borderColor("│")} ${truncateToWidth(line, inner)}${" ".repeat(pad)}${this.borderColor(" │")}`);
		}
		lines.push(this.bottomLine(width));
		this.frameWidth = width;
		this.frameLines = lines;
		return lines;
	}

	override invalidate(): void {
		this.frameWidth = undefined;
		this.frameLines = undefined;
		super.invalidate();
	}

	private topLine(width: number): string {
		// ╭─ {header} ────╮
		const header = truncateToWidth(this.header, Math.max(width - 6, 1), "…");
		const fill = Math.max(width - 5 - visibleWidth(header), 1);
		return `${this.borderColor("╭─ ")}${header}${this.borderColor(` ${"─".repeat(fill)}╮`)}`;
	}

	private bottomLine(width: number): string {
		// ╰────────╯  /  ╰───── {footer} ─╯ (footer right-aligned)
		if (!this.footer) return this.borderColor(`╰${"─".repeat(Math.max(width - 2, 2))}╯`);
		const footer = truncateToWidth(this.footer, Math.max(width - 6, 1), "…");
		const fill = Math.max(width - 4 - visibleWidth(footer), 1);
		return `${this.borderColor(`╰${"─".repeat(fill)} `)}${footer}${this.borderColor(" ╯")}`;
	}
}
