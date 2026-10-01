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
 *   - `agent wait <id> --until <S>… [--timeout MS]` exits 0 the moment the
 *     agent reaches one of the wanted settled states; for pi the usable
 *     terminal state is "done" (turn finished — probed: idle at boot,
 *     working during a turn, done at its end), a pane with no agent fails
 *     fast with agent_not_found (exit 1), and once pi exits its agent
 *     record is removed entirely (agent get → agent_not_found)
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
	/** Stable herdr agent label for the new pane (ADR-3); best-effort, never fails the split. */
	label?: string;
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
	// Best-effort FIRST attempt only (ADR-3): the agent record comes into
	// being when the child registers (~+3s after boot), so this split-time
	// rename reliably misses (agent_not_found) — the spawner re-applies the
	// label deferred, once the record is up. Cosmetics: a failed rename
	// never fails the spawn.
	if (opts.label) applyPaneLabel(paneId, opts.label);
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
 * never throws: herdr's JSON errors (printed on STDERR of the non-zero exit
 * and reaped off the thrown execFileSync error via pickFailureOutput) and any
 * CLI failure (missing binary, our own timeout kill) collapse into an
 * outcome; "error" is the catch-all.
 */
export function promptAgent(paneId: string, text: string, timeoutMs = 15_000): AgentPromptOutcome {
	try {
		const args = ["agent", "prompt", paneId, text, "--wait", "--timeout", String(timeoutMs)];
		// The herdr-side timeout bounds the wait; execFileSync gets a small
		// grace on top so herdr's own timeout JSON wins the race, not our kill.
		const out = runHerdr(args, timeoutMs + 2_000);
		return parseAgentPromptOutput(out, 0);
	} catch (err) {
		const failure = err as { stdout?: unknown; stderr?: unknown; status?: unknown };
		const exitCode = typeof failure.status === "number" ? failure.status : 1;
		return parseAgentPromptOutput(pickFailureOutput(failure.stdout, failure.stderr), exitCode);
	}
}

/**
 * Raw body for failure classification, from both pipes of a failed
 * execFileSync. Live-probed (herdr 0.9.1): error envelopes are printed on
 * STDERR of the non-zero exit, so a stdout-only read collapsed every
 * structured refusal (not_found, blocked, …) into the catch-all "error".
 * Takes whichever pipe actually carries text (stdout wins when both do);
 * "" when neither does (e.g. our own timeout kill).
 */
export function pickFailureOutput(stdout: unknown, stderr: unknown): string {
	const out = [stdout, stderr].find((s): s is string => typeof s === "string" && s.trim().length > 0);
	return out ?? "";
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

/**
 * Collision-retry label (ADR-3): the base (already sanitized) shortened to
 * make room for a `-<id8>` suffix derived from the pane id — pane ids are
 * unique, so the suffixed label is, which settles clashes between two parent
 * sessions spawning the same agent name. The result stays within the 32-char
 * herdr label cap.
 */
export function labelWithIdSuffix(base: string, paneId: string): string {
	const id8 = herdrAgentName(paneId).slice(0, 8); // "w6:p2" → "w6-p2"
	return `${base.slice(0, 31 - id8.length)}-${id8}`;
}

/**
 * Label a pane's agent with the ADR-3 retry: first attempt is the plain
 * sanitized label; on refusal or collision one retry with the pane-id
 * suffix, then a silent give-up — renaming is cosmetics, all addressing
 * goes through pane ids. Never throws. Returns whether either attempt
 * stuck, so deferred re-label callers know to stop retrying.
 */
export function applyPaneLabel(paneId: string, label: string): boolean {
	const base = herdrAgentName(label);
	if (renameAgent(paneId, base)) return true;
	return renameAgent(paneId, labelWithIdSuffix(base, paneId));
}

// ── Agent wait / status parsing (shapes captured from 0.9.1-preview) ──

/**
 * Decode `herdr agent get <id>`: `.result.agent.agent_status` (idle | working
 * | blocked | done | unknown). Live-probed against a pi pane (T4 probe):
 * boot → idle, turn running → working, turn finished → done (persists while
 * pi sits at its prompt). Defensive like parsePaneListIds: garbage, error
 * envelopes (e.g. agent_not_found — the record is REMOVED once pi exits, it
 * never lingers as done/unknown) or a non-zero exit → null.
 */
export function parseAgentStatus(out: string, exitCode: number): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return null;
	}
	if (exitCode !== 0) return null;
	const status = (parsed as { result?: { agent?: { agent_status?: unknown } } } | null)?.result?.agent?.agent_status;
	return typeof status === "string" && status.length > 0 ? status : null;
}

// ── Done waiter (ADR-2 in docs/herdr-agent-surface-backlog.md) ──

/**
 * Two hours: a leak-proof net, not a working assumption. The waiter is killed
 * by completeSubagent when the subagent finishes; the timeout only bounds the
 * leftover process if the parent itself dies without a cleanup pass. On
 * timeout herdr exits non-zero, so a stale waiter can never set the done flag.
 */
const DONE_WAITER_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Start one background `herdr agent wait <paneId> --until <S>… ` process for
 * a subagent pane. Exit 0 means herdr saw the agent reach one of the wanted
 * settled states — index.ts turns that into its nativeDoneAt flag (ADR-2).
 * Never throws: sync spawn failures return null, and async ones (ENOENT,
 * herdr hiccup) arrive as an "error" event, which is swallowed here so an
 * unhandled 'error' cannot crash the parent — the exit code just stays
 * non-zero and the sidecar watcher remains the source of truth.
 *
 * Probe notes driving the --until choice (herdr 0.9.1-preview): a pane with
 * no agent yet fails the wait fast with agent_not_found (exit 1 — harmless,
 * never a false done), and an exited pi leaves no agent record at all, so
 * "done" (the last pre-exit state) is the only reachable terminal signal.
 */
export function spawnDoneWaiter(paneId: string, untilStatuses: string[]): ChildProcess | null {
	try {
		const args = ["agent", "wait", paneId];
		// --until is repeatable ("repeat for more than one state"), one flag
		// per status — a bare spread would feed the 2nd status as a positional.
		for (const status of untilStatuses) args.push("--until", status);
		args.push("--timeout", String(DONE_WAITER_TIMEOUT_MS));
		const child = spawn(HERDR, args, { stdio: "ignore", windowsHide: true, detached: false });
		child.on("error", () => {});
		child.unref();
		return child;
	} catch {
		return null;
	}
}
