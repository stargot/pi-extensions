/**
 * session-handoff: auto-dump of session state on exit and "pick up where
 * you left off" on the next start. Mechanical, no LLM — deterministic and
 * free (RESEARCH.md §3.1, pain #1 by frequency).
 *
 * - `session_shutdown` → `~/.pi/agent/handoff/<project-slug>.md`: last user
 *   request, last assistant answer, git branch/status/diff-stat/recent
 *   commits, session file and duration.
 * - `session_start` (startup|resume) → notify when a handoff exists.
 * - `/handoff` → read it in a scrollable viewer; `/handoff go` → confirm and
 *   send it to the model as a continuation prompt; `/handoff clear` → delete.
 *
 * The markdown assembly is pure (./handoff.ts, tested); this file is the
 * thin pi wiring: reading the session JSONL and running git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ScrollReport } from "../shared/scroll-report.ts";
import { buildHandoffMarkdown, capLine, projectSlug, type GitInfo } from "./handoff.ts";

const handoffDir = () => join(getAgentDir(), "handoff");
const MAX_STATUS_LINES = 15;
const MAX_DIFF_LINES = 5;
const MAX_HANDOFF_FILES = 50;

/** Last user and assistant texts from a session JSONL (one pass, best effort). */
function readLastExchange(sessionFile: string | undefined): { user?: string; assistant?: string } {
	if (!sessionFile || !existsSync(sessionFile)) return {};
	let user: string | undefined;
	let assistant: string | undefined;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message" || !entry.message) continue;
			const text = contentText(entry.message.content);
			if (!text) continue;
			if (entry.message.role === "user") user = text;
			else if (entry.message.role === "assistant") assistant = text;
		}
	} catch {
		// Unreadable session — handoff just carries less.
	}
	return { user, assistant };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

/** Git facts for cwd; null when not a repo or git is unavailable. */
function gitInfo(cwd: string): GitInfo | null {
	const run = (args: string[]): string | null => {
		try {
			return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			return null;
		}
	};
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch === null) return null;
	const statusLines = (run(["status", "--short"]) ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
	return {
		branch: branch.trim(),
		status: statusLines.slice(0, MAX_STATUS_LINES),
		dirtyCount: statusLines.length,
		diffStat: (run(["diff", "--stat", "HEAD"]) ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-MAX_DIFF_LINES),
		commits: (run(["log", "--oneline", "-3"]) ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean),
	};
}

function handoffPath(cwd: string): string {
	return join(handoffDir(), `${projectSlug(cwd)}.md`);
}

/** Keep the handoff dir bounded: drop the oldest records beyond the cap. */
function pruneHandoffs(): void {
	try {
		const files = readdirSync(handoffDir())
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ f, m: statSync(join(handoffDir(), f)).mtimeMs }))
			.sort((a, b) => b.m - a.m);
		for (const { f } of files.slice(MAX_HANDOFF_FILES)) unlinkSync(join(handoffDir(), f));
	} catch {
		// Best effort.
	}
}

export default function (pi: ExtensionAPI) {
	let sessionStart = Date.now();

	pi.on("session_start", (event, ctx) => {
		sessionStart = Date.now();
		if (event.reason !== "startup" && event.reason !== "resume") return;
		const file = handoffPath(ctx.cwd);
		if (!existsSync(file)) return;
		try {
			const mtime = statSync(file).mtimeMs;
			const when = new Date(mtime).toLocaleString();
			ctx.ui.notify(`Handoff found (${when}) — /handoff to view, /handoff go to continue.`, "info");
		} catch {
			// Vanished between existsSync and stat — ignore.
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			mkdirSync(handoffDir(), { recursive: true });
			const { user, assistant } = readLastExchange(ctx.sessionManager?.getSessionFile?.());
			const md = buildHandoffMarkdown({
				projectDir: ctx.cwd,
				sessionFile: ctx.sessionManager?.getSessionFile?.(),
				startedAt: sessionStart,
				lastUser: user ? capLine(user, 300) : undefined,
				lastAssistant: assistant,
				git: gitInfo(ctx.cwd),
			});
			writeFileSync(handoffPath(ctx.cwd), md, "utf8");
			pruneHandoffs();
		} catch {
			// Handoff must never break the shutdown.
		}
	});

	pi.registerCommand("handoff", {
		description: "Session handoff: view the auto-dump, continue (/handoff go), clear",
		handler: async (args, ctx) => {
			const file = handoffPath(ctx.cwd);
			const verb = args.trim().split(/\s+/)[0] ?? "";

			if (verb === "clear") {
				try {
					unlinkSync(file);
					ctx.ui.notify("Handoff removed.", "info");
				} catch {
					ctx.ui.notify("No handoff to remove.", "warning");
				}
				return;
			}

			if (!existsSync(file)) {
				ctx.ui.notify(`No handoff for ${ctx.cwd} yet — it is written when a session ends.`, "warning");
				return;
			}
			const md = readFileSync(file, "utf8");

			if (verb === "go") {
				const ok = await ctx.ui.confirm(
					"Continue from the handoff?",
					`Sends the saved state (${capLine(md, 80)}) to the model as a continuation prompt.`,
				);
				if (!ok) return;
				pi.sendUserMessage(`Продолжаем с того места. Вот автосохранённое состояние сессии:\n\n${md}`);
				return;
			}

			if (ctx.hasUI && ctx.mode === "tui") {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
					return new ScrollReport({
						tui,
						theme,
						onClose: () => done(),
						render: (width, th) => [
						th.fg("dim", " go — отправить модели · clear — удалить · esc — закрыть"),
						...md.split("\n").map((l) => truncateToWidth(l, width)),
					],
						helpSuffix: " · /handoff go",
					});
				});
				return;
			}
			ctx.ui.notify(capLine(md, 2000), "info");
		},
	});
}
