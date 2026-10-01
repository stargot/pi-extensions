/**
 * herdr surface layer — https://herdr.dev
 *
 * herdr is a terminal multiplexer for coding agents with server-owned PTYs.
 * When pi runs inside a herdr pane (HERDR_ENV=1), herdr owns the terminal
 * surface: splitting through wezterm fails ("pane_id N invalid") because the
 * inherited WEZTERM_PANE belongs to the herdr client's pane, not to a pane
 * this process may manage. Everything here therefore goes through the
 * `herdr` CLI, which talks to the session socket the pane was created with.
 *
 * Mapping from the wezterm surface:
 *   split-pane  → `pane split` (right/down, --ratio 0..1, --no-focus — herdr
 *                 never steals focus, so no activate-pane dance is needed),
 *                 then `pane run` to launch the pwsh launcher in the new pane
 *   send-text   → `pane run` (types the text and presses Enter atomically)
 *   interrupt   → `pane send-keys <id> esc|ctrl+c` (raw key, no Enter)
 *   get-text    → `pane read --source recent --lines N`
 *   list        → `pane list` (JSON, .result.panes[].pane_id, e.g. "w1:p2")
 *   kill-pane   → `pane close`
 *
 * Live-verified against herdr 0.9.0:
 *   - `pane split` answers {"result":{"pane":{"pane_id":"w6:p2",…}}}
 *   - `pane run <id> <text…>` types text + Enter; do NOT pass a `--`
 *     separator (it is typed into the pane literally); leading "-" is fine
 *     when steering a TUI — the text is delivered, whatever the shell makes
 *     of it afterwards
 *   - `pane read` answers with plain text
 *   - herdr never reuses closed pane ids, so stale registry paneIds from
 *     finished sessions reliably report as gone
 *
 * Agent surface (live-verified against herdr 0.9.1-preview):
 *   - a pane counts as an agent only once a recognized agent (pi) runs in
 *     it; a plain shell pane answers {"error":{"code":"agent_not_found"}}
 *     to agent get/prompt
 *   - `agent prompt <id> <text> --wait --timeout MS` exits 0 with
 *     {"result":{…,"type":"agent_prompted"}}; failures exit 1 with
 *     {"error":{"code":…}} — agent_blocked (rejected BEFORE the text is
 *     sent), agent_prompt_stalled (no working|blocked seen within 5s),
 *     timeout, agent_not_found
 *   - `agent rename <id> <name>` exits 0 with the agent_info envelope, the
 *     label at .result.agent.name (same envelope as `agent get`)
 */
import { execFileSync } from "node:child_process";
import { computeStackPercent } from "./shared.ts";

const HERDR = "herdr";
const PWSH = "pwsh";

let herdrBinaryProbe: boolean | null = null;

/** True when the process runs inside a herdr-managed pane. */
export function isHerdrEnv(): boolean {
	return process.env.HERDR_ENV === "1";
}

/** HERDR_ENV=1 with the herdr CLI actually on PATH. */
export function isHerdrAvailable(): boolean {
	if (!isHerdrEnv()) return false;
	if (herdrBinaryProbe !== null) return herdrBinaryProbe;
	try {
		execFileSync(HERDR, ["--version"], { stdio: "ignore", timeout: 10_000, windowsHide: true });
		herdrBinaryProbe = true;
	} catch {
		herdrBinaryProbe = false;
	}
	return herdrBinaryProbe;
}

/** The parent pi's own herdr pane id (e.g. "w1:p2"). Empty when not in herdr. */
export function parentPaneId(): string {
	return process.env.HERDR_PANE_ID ?? "";
}

function runHerdr(args: string[], timeoutMs = 15_000): string {
	return execFileSync(HERDR, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
}

// ── Response parsing (exported for tests; shapes captured from 0.9.0) ──

/** Extract `.result.pane.pane_id` from a `pane split` response. */
export function parseSplitPaneId(out: string): string {
	const parsed = JSON.parse(out) as {
		result?: { pane?: { pane_id?: unknown }; pane_id?: unknown };
	};
	const id = parsed.result?.pane?.pane_id ?? parsed.result?.pane_id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`Unexpected herdr pane split response: ${out.slice(0, 200)}`);
	}
	return id;
}

/** Extract pane ids from a `pane list` response. Tolerates shape drift. */
export function parsePaneListIds(out: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return [];
	}
	const result = (parsed as { result?: unknown }).result;
	const panes = Array.isArray(result)
		? result
		: Array.isArray((result as { panes?: unknown })?.panes)
			? (result as { panes: unknown[] }).panes
			: [];
	const ids: string[] = [];
	for (const pane of panes) {
		const id = (pane as { pane_id?: unknown } | null)?.pane_id;
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}

// ── Agent prompt parsing (exported for tests; shapes captured from 0.9.1) ──

/**
 * Outcome of a `herdr agent prompt` delivery attempt (ADR-1 in
 * docs/herdr-agent-surface-backlog.md). "delivered" = herdr accepted the
 * submission and observed the child settle; every failure names its story:
 * refused_blocked (child sits in an approval UI, text rejected before
 * delivery), stalled (child never showed working|blocked after acceptance),
 * timeout, not_found, and error as the catch-all for anything unmapped.
 */
export type AgentPromptOutcome = "delivered" | "refused_blocked" | "stalled" | "timeout" | "not_found" | "error";

/** `error.code` of a failed prompt → outcome; unknown codes fall to "error". */
const PROMPT_ERROR_OUTCOMES: Record<string, AgentPromptOutcome> = {
	agent_blocked: "refused_blocked",
	agent_prompt_stalled: "stalled",
	timeout: "timeout",
	agent_not_found: "not_found",
};

/**
 * Classify a `herdr agent prompt` response. Defensive like parsePaneListIds:
 * garbage or empty output never throws and never counts as "delivered".
 * An explicit error.code maps through PROMPT_ERROR_OUTCOMES; a clean body
 * with exit 0 is "delivered"; everything else is "error".
 */
export function parseAgentPromptOutput(out: string, exitCode: number): AgentPromptOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return "error";
	}
	const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
	if (typeof code === "string" && code.length > 0) {
		return PROMPT_ERROR_OUTCOMES[code] ?? "error";
	}
	return exitCode === 0 ? "delivered" : "error";
}

// ── Surface primitives ──

export interface CreatePaneOptions {
	/** Launcher script the new pane executes. */
	ps1Path: string;
	/** Working directory for the pane and its program. */
	cwd: string;
	/** Number of subagents already running (decides right-split vs stack). */
	runningCount: number;
	/** Top pane of the existing subagent column (required when runningCount > 0). */
	topPane?: string;
}

/**
 * Pick the pane to split, tolerating stale ids: herdr never reuses closed
 * pane ids, but the parent's cached column of subagent panes can outlive the
 * panes it names (auto-collapse closes them). A dead stacking target falls
 * back to the parent pane; when both are gone there is nowhere to split.
 */
export function selectSplitTarget(opts: { stackingTarget?: string; parentPaneId: string; livePaneIds: Set<string> }): {
	target: string;
	stacking: boolean;
} {
	if (opts.stackingTarget && opts.livePaneIds.has(opts.stackingTarget)) {
		return { target: opts.stackingTarget, stacking: true };
	}
	if (opts.parentPaneId && opts.livePaneIds.has(opts.parentPaneId)) {
		return { target: opts.parentPaneId, stacking: false };
	}
	throw new Error(
		`Cannot split a subagent pane: the parent pane "${opts.parentPaneId}" and the stacking target` +
			`${opts.stackingTarget ? ` "${opts.stackingTarget}"` : ""} are both closed (herdr never reuses pane ids) — nothing live to split.`,
	);
}

/**
 * Create a pane for a subagent.
 *
 * First subagent: a right split off the parent pi's pane (50/50). Subsequent
 * subagents split the top pane of that column downward with an even-stack
 * ratio (computeStackPercent / 100). The split runs with --no-focus — herdr
 * keeps the user's keyboard where it is, unlike wezterm's split-pane.
 * Stale targets are weeded out via selectSplitTarget, and a stacking target
 * that dies between the liveness check and the split gets one retry off the
 * still-live parent pane instead of failing the whole spawn.
 *
 * Returns the new pane id (e.g. "w1:p2").
 */
export function createSubagentPane(opts: CreatePaneOptions): string {
	if (!isHerdrAvailable()) {
		throw new Error("pi looks like it runs inside herdr (HERDR_ENV=1) but the `herdr` CLI was not found on PATH.");
	}
	const parent = parentPaneId();
	if (!parent) {
		throw new Error("herdr pane id of the parent session is unknown (HERDR_PANE_ID is empty).");
	}
	const stackingTarget = opts.runningCount > 0 && opts.topPane ? opts.topPane : undefined;
	const live = listPaneIds();
	if (live.size === 0) {
		// An empty list may mean a herdr CLI hiccup, not "no panes" — be
		// optimistic and treat the parent as live so the split targets it.
		// A truly dead parent still fails loudly in the split itself.
		live.add(parent);
	}
	const selection = selectSplitTarget({ stackingTarget, parentPaneId: parent, livePaneIds: live });

	try {
		return splitPane(selection.target, selection.stacking, opts);
	} catch (err) {
		// The stacking target can die between the liveness check and the split
		// (a sibling pane finished and auto-collapsed mid-spawn). One retry off
		// the parent — which outlives every subagent — beats a dead spawn.
		if (selection.stacking && paneExists(parent)) {
			return splitPane(parent, false, opts);
		}
		throw err;
	}
}

function splitPane(target: string, stacking: boolean, opts: CreatePaneOptions): string {
	// A right split (off the parent) is always 50/50: the stack percent is
	// height math for the column, and leaking it into a right split (as the
	// stacking-retry fallback once did) distorts the layout.
	const ratio = stacking ? computeStackPercent(opts.runningCount) / 100 : 0.5;
	const out = runHerdr([
		"pane",
		"split",
		"--pane",
		target,
		"--direction",
		stacking ? "down" : "right",
		"--ratio",
		ratio.toFixed(2),
		"--cwd",
		opts.cwd,
		"--no-focus",
	]);
	const paneId = parseSplitPaneId(out);
	launchScript(paneId, opts.ps1Path);
	return paneId;
}

/** Type a launcher invocation into the pane; pwsh stays open after the child exits. */
function launchScript(paneId: string, ps1Path: string): void {
	// Windows paths cannot contain `"`, so double quotes are unambiguous and
	// work under pwsh, cmd and bash alike. One argv element on purpose: herdr
	// joins COMMAND args with spaces, so quoting must survive on our side.
	runHerdr(["pane", "run", paneId, `${PWSH} -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "${ps1Path}"`]);
}

/** Send text to a pane and submit it (pane run = text + Enter, one write). */
export function sendText(paneId: string, text: string): void {
	const flattened = text.replace(/\r?\n/g, " ").trim();
	runHerdr(["pane", "run", paneId, flattened]);
}

/**
 * Interrupt the foreground program in a pane: "escape" makes pi abort the
 * running turn; "ctrl-c" kills a shell command. Key names per herdr 0.9.0
 * (`pane send-keys <id> esc|ctrl+c`).
 */
export function sendInterrupt(paneId: string, key: "escape" | "ctrl-c"): void {
	runHerdr(["pane", "send-keys", paneId, key === "escape" ? "esc" : "ctrl+c"]);
}

/** Run a launcher script in a pane that is sitting at a shell prompt (resume). */
export function runScriptInPane(paneId: string, scriptPath: string): void {
	launchScript(paneId, scriptPath);
}

/** Read the last `lines` lines of a pane's output. Returns "" when the pane is gone. */
export function readScreenTail(paneId: string, lines = 6): string {
	try {
		return runHerdr(["pane", "read", paneId, "--source", "recent", "--lines", String(Math.max(1, lines))]);
	} catch {
		return "";
	}
}

/** Ids of all panes in the caller's herdr workspace (all workspaces if unknown). */
export function listPaneIds(): Set<string> {
	try {
		const args = ["pane", "list"];
		const workspace = process.env.HERDR_WORKSPACE_ID;
		if (workspace) args.push("--workspace", workspace);
		return new Set(parsePaneListIds(runHerdr(args)));
	} catch {
		return new Set();
	}
}

export function paneExists(paneId: string, known?: Set<string>): boolean {
	const ids = known ?? listPaneIds();
	return ids.has(paneId);
}

/** Close a pane. Best-effort: a closing pane must never break the parent. */
export function closePane(paneId: string): void {
	try {
		runHerdr(["pane", "close", paneId]);
	} catch {
		// Pane may already be gone.
	}
}

/** No-op: herdr splits run with --no-focus, so the user never loses focus. */
export function activatePane(_paneId: string): void {}

// ── Agent surface primitives (prompt / rename) ──

/**
 * Deliver a steering message to a subagent (ADR-1): unlike `pane run`, herdr
 * refuses up front (agent_blocked) when the child is waiting for input, and
 * --wait turns "typed into the pane" into "the child was seen working" — so
 * nothing is ever dropped silently. TARGET is always the pane id, never a
 * name. Never throws: herdr's JSON errors (printed on stdout of the non-zero
 * exit and reaped off the thrown execFileSync error) and any CLI failure
 * (missing binary, our own timeout kill) collapse into an outcome; "error"
 * is the catch-all.
 */
export function promptAgent(paneId: string, text: string, timeoutMs = 15_000): AgentPromptOutcome {
	try {
		const args = ["agent", "prompt", paneId, text, "--wait", "--timeout", String(timeoutMs)];
		// The herdr-side timeout bounds the wait; execFileSync gets a small
		// grace on top so herdr's own timeout JSON wins the race, not our kill.
		const out = runHerdr(args, timeoutMs + 2_000);
		return parseAgentPromptOutput(out, 0);
	} catch (err) {
		const failure = err as { stdout?: unknown; status?: unknown };
		const out = typeof failure.stdout === "string" ? failure.stdout : "";
		const exitCode = typeof failure.status === "number" ? failure.status : 1;
		return parseAgentPromptOutput(out, exitCode);
	}
}

/**
 * Sanitize a subagent display name into a herdr agent label (ADR-3), i.e.
 * something matching `[a-z][a-z0-9_-]{0,31}`: lowercase, every non-[a-z0-9]
 * run becomes one hyphen, edges trimmed, capped at 32 chars, a non-letter
 * head gets an "a-" prefix (cap preserved), and a name that sanitizes away
 * entirely falls back to "subagent".
 */
export function herdrAgentName(raw: string): string {
	let name = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	name = name.replace(/-+$/, ""); // a 32-char cut may land right after a hyphen
	if (name.length === 0) return "subagent";
	if (!/^[a-z]/.test(name)) name = `a-${name.slice(0, 30)}`;
	return name;
}

/**
 * Label a pane's agent (`agent rename`) — best-effort per ADR-3: renaming
 * is cosmetics (all addressing goes through pane ids), so any failure —
 * herdr gone, target unknown, name rejected — just reports false.
 */
export function renameAgent(paneId: string, name: string): boolean {
	try {
		runHerdr(["agent", "rename", paneId, name]);
		return true;
	} catch {
		return false;
	}
}
