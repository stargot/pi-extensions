/**
 * Testable render surface for the subagents extension: the renderResult
 * bodies of the four pane tools plus the subagent_result completion card.
 * Pure functions over (result, options, theme, context) — no extension
 * state, no filesystem access — so tests can drive them with a fake theme
 * and read `render(width)` output directly. index.ts wires them into
 * pi.registerTool / pi.registerMessageRenderer.
 */
import type {
	AgentToolResult,
	MessageRenderOptions,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	batchWallTime,
	displayItems,
	elapsedOf,
	finalOutput,
	firstLines,
	formatDuration,
	formatToolCall,
	formatTokens,
	formatUsageStats,
	isFailedResult,
	isQueued,
	isRunning,
	oneline,
	progressBar,
	spinnerFrame,
	summarizeTools,
	type BatchResult,
} from "./batch.ts";
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

export function renderSubagentResult(
	result: ToolResult,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
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

export function renderSubagentMessageResult(
	result: ToolResult,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
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
	// Close-race (R10): the steer hit a subagent that finished in flight —
	// reported as a normal result, not an error.
	if (details.status === "finished") {
		return new Text(
			theme.fg("dim", `○ ${details.name ?? "?"} already finished — resume with subagent_message to continue`),
			0,
			0,
		);
	}
	// steered (default): the message went to a live pane.
	let text = verdictChip(theme, "running", "STEERED") + ` ${theme.fg("accent", details.name ?? "?")}`;
	if (details.interrupted) text += theme.fg("warning", " · interrupted");
	return new Text(text, 0, 0);
}

// ── Tool: subagent_cancel ──

export function renderSubagentCancelResult(
	result: ToolResult,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
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

export function renderSubagentsListResult(
	result: ToolResult,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
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
export function subagentResultCard(
	message: SubagentResultMessage,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
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

export interface BatchDetails {
	mode: "single" | "parallel" | "chain";
	results: BatchResult[];
	/**
	 * Chain only: size (utf8 bytes) of the {previous} output handed into
	 * step i; aligns with results by index, 0 for the first step.
	 */
	handOff?: number[];
}

export function renderBatchResult(
	result: ToolResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	_context: RenderContext,
): Component {
	const expanded = options.expanded;
	const details = result.details as BatchDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0] as { type?: string; text?: string } | undefined;
		return new Text(first?.type === "text" ? (first.text ?? "(no output)") : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const statusIcon = (r: BatchResult): string => {
		if (isQueued(r)) return theme.fg("dim", "○");
		if (isRunning(r)) return theme.fg("warning", spinnerFrame());
		if (isFailedResult(r)) return theme.fg("error", "✗");
		return theme.fg("success", "✓");
	};
	const elapsedTag = (r: BatchResult): string => {
		const ms = elapsedOf(r);
		return ms === undefined ? "" : ` ${theme.fg("dim", formatDuration(ms))}`;
	};
	// Verdict chips and error banners come from the shared render helpers.
	const stderrExcerpt = (r: BatchResult): string => (isFailedResult(r) && r.stderr ? firstLines(r.stderr, 3) : "");
	// One line per task for the collapsed parallel view (No.7).
	const taskLine = (r: BatchResult): string => {
		const head = `${statusIcon(r)} ${theme.fg("accent", r.agent)}${elapsedTag(r)}`;
		if (isQueued(r)) return `${head} ${theme.fg("muted", "queued")}`;
		const bits: string[] = [];
		if (isFailedResult(r)) {
			const reason = oneline(r.errorMessage || r.stopReason || `exit ${r.exitCode}`);
			bits.push(theme.fg("error", `failed (${reason})`));
		} else {
			const tools = summarizeTools(displayItems(r.messages));
			if (tools) bits.push(theme.fg("muted", tools));
			if (isRunning(r) && r.liveTool) {
				// Mid-turn tool progress — arrives via tool_execution_start,
				// so this updates without waiting for the turn to end.
				bits.push(theme.fg("warning", `${r.liveTool.name}…`));
			} else if (!isRunning(r)) {
				const out = finalOutput(r.messages);
				if (out) bits.push(theme.fg("dim", `→ ${formatTokens(out.length)}`));
			}
		}
		return bits.length > 0 ? `${head} ${bits.join(" ")}` : head;
	};
	const collapsedItems = (items: ReturnType<typeof displayItems>, limit: number): string => {
		const toShow = items.slice(-limit);
		const skipped = items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = expanded ? (item.text ?? "") : (item.text ?? "").split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg)}\n`;
			}
		}
		return text.trimEnd();
	};
	const childCard = (container: Container, r: BatchResult, header: string): void => {
		const usageStr = formatUsageStats(r.usage, r.model);
		const card = new BatchCard((s) => theme.fg("borderMuted", s), header, usageStr || undefined);
		card.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
		for (const item of displayItems(r.messages)) {
			if (item.type === "toolCall") {
				card.addChild(
					new Text(theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg), 0, 0),
				);
			}
		}
		const output = finalOutput(r.messages);
		if (output) {
			card.addChild(new Spacer(1));
			card.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
		}
		container.addChild(new Spacer(1));
		container.addChild(card);
	};
	const aggregateUsage = (results: BatchResult[]) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		for (const r of results) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.turns += r.usage.turns;
		}
		return total;
	};
	// Done-state header tail: cost · wall time, then failed agent names.
	const costWallTag = (results: BatchResult[]): string => {
		const usage = aggregateUsage(results);
		const bits: string[] = [];
		if (usage.cost > 0) bits.push(`$${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`);
		const wall = batchWallTime(results);
		if (wall !== undefined) bits.push(formatDuration(wall));
		return theme.fg("dim", bits.join(" · "));
	};
	const failedTag = (results: BatchResult[]): string => {
		const failed = results.filter((r) => !isRunning(r) && !isQueued(r) && isFailedResult(r));
		if (failed.length === 0) return "";
		const names = failed.map((r) => r.agent);
		const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
		return theme.fg("error", `${failed.length} failed: ${shown}`);
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const isError = isFailedResult(r);
		const isBusy = isRunning(r);
		const icon = isBusy
			? theme.fg("warning", spinnerFrame())
			: isError
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const items = displayItems(r.messages);
		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${elapsedTag(r)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage) container.addChild(new Text(errorLine(theme, r.errorMessage), 0, 0));
			const stderr = stderrExcerpt(r);
			if (stderr) container.addChild(new Text(theme.fg("dim", stderr), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			const output = finalOutput(r.messages);
			if (items.length === 0 && !output) {
				container.addChild(new Text(theme.fg("muted", isBusy ? "(running...)" : "(no output)"), 0, 0));
			} else {
				for (const item of items) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg), 0, 0),
						);
					}
				}
				if (output) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}
		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${elapsedTag(r)}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) {
			text += `\n${errorLine(theme, r.errorMessage)}`;
			const stderr = stderrExcerpt(r);
			if (stderr) text += `\n${theme.fg("dim", stderr)}`;
		} else if (items.length === 0) text += `\n${theme.fg("muted", isBusy ? "(running...)" : "(no output)")}`;
		else text += `\n${collapsedItems(items, 10)}`;
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "chain") {
		const activeCount = details.results.filter((r) => isRunning(r) || isQueued(r)).length;
		const successCount = details.results.filter((r) => !isRunning(r) && !isQueued(r) && !isFailedResult(r)).length;
		const doneCount = details.results.length - activeCount;
		const total = details.results.length;
		const kind = activeCount > 0 ? "running" : doneCount > successCount ? "fail" : "ok";
		const head = verdictChip(
			theme,
			kind,
			activeCount > 0 ? `${spinnerFrame()} CHAIN ${doneCount}/${total}` : `CHAIN ${successCount}/${total}`,
		);
		const bar = theme.fg("muted", `[${progressBar(doneCount, total)}] `);
		const tailBits =
			activeCount > 0 ? [] : [costWallTag(details.results), failedTag(details.results)].filter((s) => s.length > 0);
		if (expanded) {
			const container = new Container();
			container.addChild(new Text(`${head} ${bar}${tailBits.map((s) => ` ${s}`).join("")}`, 0, 0));
			// Frames supersede the No.6 rail glyphs; ← +Nk still marks the flow.
			for (let i = 0; i < details.results.length; i++) {
				const r = details.results[i];
				const handIn = details.handOff?.[i] ?? 0;
				const hand = i > 0 && handIn > 0 ? theme.fg("muted", ` ← +${formatTokens(handIn)}`) : "";
				const stepHeader = `${statusIcon(r)} ${theme.fg("muted", `Step ${r.step ?? i + 1} ·`)} ${theme.fg(
					"accent",
					r.agent,
				)}${hand}${elapsedTag(r)}`;
				childCard(container, r, stepHeader);
			}
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}
		let text = `${head} ${bar}${tailBits.map((s) => ` ${s}`).join("")}`;
		for (const r of details.results) {
			text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${statusIcon(r)}${elapsedTag(r)}`;
			const items = displayItems(r.messages);
			text += items.length === 0 ? `\n${theme.fg("muted", "(no output)")}` : `\n${collapsedItems(items, 5)}`;
		}
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		return new Text(text, 0, 0);
	}

	// parallel
	const queuedCount = details.results.filter((r) => isQueued(r)).length;
	const runningCount = details.results.filter((r) => isRunning(r)).length;
	const doneCount = details.results.length - queuedCount - runningCount;
	const failCount = details.results.filter((r) => !isRunning(r) && !isQueued(r) && isFailedResult(r)).length;
	const successCount = doneCount - failCount;
	const total = details.results.length;
	const isRunningBatch = runningCount > 0 || queuedCount > 0;
	const head = verdictChip(
		theme,
		isRunningBatch ? "running" : failCount > 0 ? "fail" : "ok",
		isRunningBatch ? `${spinnerFrame()} PARALLEL ${doneCount}/${total}` : `PARALLEL ${successCount}/${total}`,
	);
	const bar = theme.fg("muted", `[${progressBar(doneCount, total)}] `);
	let tail: string;
	if (isRunningBatch) {
		const live = [runningCount > 0 ? `${runningCount} running` : "", queuedCount > 0 ? `${queuedCount} queued` : ""]
			.filter(Boolean)
			.join(" · ");
		tail = `${bar}${live ? ` ${theme.fg("muted", live)}` : ""}`;
	} else {
		const bits = [costWallTag(details.results), failedTag(details.results)].filter((s) => s.length > 0);
		tail = bar + bits.map((s) => ` ${s}`).join("");
	}
	if (expanded && !isRunningBatch) {
		const container = new Container();
		container.addChild(new Text(`${head} ${tail}`, 0, 0));
		for (const r of details.results) {
			container.addChild(new Spacer(1));
			childCard(
				container,
				r,
				`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${statusIcon(r)}${elapsedTag(r)}`,
			);
		}
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}
	// Collapsed: one line per task — status, duration, tools, output size.
	let text = `${head} ${tail}`;
	for (const r of details.results) {
		text += `\n${taskLine(r)}`;
	}
	if (!isRunningBatch) {
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
