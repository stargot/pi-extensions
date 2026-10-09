/**
 * Terminal multiplexer dispatch — herdr OR wezterm.
 *
 * Detection precedence: HERDR_ENV=1 wins unconditionally. herdr-managed panes
 * inherit WEZTERM_PANE from the herdr client's own WezTerm pane, but that pane
 * belongs to herdr's client process — splitting through wezterm from inside a
 * herdr pane fails with "pane_id N invalid". Inside herdr, the surface is
 * herdr. Only when HERDR_ENV is absent does WEZTERM_PANE select wezterm.
 *
 * The exported surface mirrors the old wezterm.ts API one-to-one, so callers
 * (index.ts, manual e2e scripts) stay backend-agnostic.
 */
import type { ChildProcess } from "node:child_process";
import { parseSentinel, SENTINEL_PATTERN } from "./shared.ts";
import { herdrBackend, isHerdrAvailable, isHerdrEnv, type AgentPromptOutcome } from "./herdr.ts";
import { isWezTermAvailable, weztermBackend } from "./wezterm.ts";

export type MuxBackendName = "herdr" | "wezterm";

export interface CreatePaneOptions {
	/** Launcher script the new pane executes. */
	ps1Path: string;
	/** Working directory for the pane and its program. */
	cwd: string;
	/** Number of subagents already running (decides right-split vs stack). */
	runningCount: number;
	/** Top pane of the existing subagent column (required when runningCount > 0). */
	topPane?: string;
	/** Stable herdr agent label for the new pane (ADR-3); best-effort, ignored by wezterm. */
	label?: string;
}

export interface MuxBackend {
	readonly name: MuxBackendName;
	createSubagentPane(opts: CreatePaneOptions): string;
	listPaneIds(): Set<string>;
	listPaneIdsAsync(): Promise<Set<string>>;
	paneExists(paneId: string, known?: Set<string>): boolean;
	readScreenTail(paneId: string, lines?: number): string;
	readScreenTailAsync(paneId: string, lines?: number): Promise<string>;
	sendText(paneId: string, text: string): Promise<void>;
	sendInterrupt(paneId: string, key: "escape" | "ctrl-c"): Promise<void>;
	runScriptInPane(paneId: string, scriptPath: string): Promise<void>;
	closePane(paneId: string): void;
	activatePane(paneId: string): void;
	promptAgent?(paneId: string, text: string): Promise<AgentPromptOutcome>;
	applyPaneLabel?(paneId: string, label: string): boolean;
	applyPaneLabelAsync?(paneId: string, label: string): Promise<boolean>;
	spawnDoneWaiter?(paneId: string, untilStatuses: string[]): ChildProcess | null;
}

export type NativeAgentOps = Required<Pick<MuxBackend, "applyPaneLabelAsync" | "spawnDoneWaiter">>;

const backends: Record<MuxBackendName, MuxBackend> = { herdr: herdrBackend, wezterm: weztermBackend };

/**
 * Pure selection logic — exported for tests. The regression case: both
 * HERDR_ENV=1 and WEZTERM_PANE set (pi inside a herdr pane) must pick herdr.
 */
export function selectBackend(env: NodeJS.ProcessEnv, herdrOk: boolean, weztermOk: boolean): MuxBackendName | null {
	if (env.HERDR_ENV === "1") return herdrOk ? "herdr" : null;
	if (env.WEZTERM_PANE) return weztermOk ? "wezterm" : null;
	return null;
}

let cachedBackend: MuxBackendName | null | undefined;

/** The backend this session drives, or null when no mux is usable. */
export function activeBackend(): MuxBackendName | null {
	if (cachedBackend === undefined) {
		cachedBackend = selectBackend(process.env, isHerdrAvailable(), isWezTermAvailable());
	}
	return cachedBackend;
}

/** Setup advice tailored to the environment the user actually runs pi in. */
export function muxSetupHint(): string {
	if (isHerdrEnv()) {
		return "pi is running inside herdr (HERDR_ENV=1) — make sure the `herdr` CLI is on PATH.";
	}
	if (process.env.WEZTERM_PANE) {
		return "Start pi inside WezTerm and make sure `wezterm` and `pwsh` are on PATH.";
	}
	return "Start pi inside WezTerm or herdr (https://herdr.dev) and make sure the matching CLI (`wezterm`/`herdr`) and `pwsh` are on PATH.";
}

function activeImpl(): MuxBackend | null {
	const name = activeBackend();
	return name ? backends[name] : null;
}

function requireBackend(): MuxBackend {
	const backend = activeImpl();
	if (!backend) throw new Error(`No terminal multiplexer available. ${muxSetupHint()}`);
	return backend;
}

/**
 * Create a pane for a subagent. First subagent: a right split off the parent
 * pane (50/50); subsequent ones stack downward with an even-stack percent.
 * Throws when no mux surface is available.
 */
export function createSubagentPane(opts: CreatePaneOptions): string {
	const backend = requireBackend();
	return backend.createSubagentPane(opts);
}

/** Ids of all panes the mux currently knows about. */
export function listPaneIds(): Set<string> {
	const backend = activeImpl();
	if (!backend) return new Set();
	return backend.listPaneIds();
}

export function listPaneIdsAsync(): Promise<Set<string>> {
	const backend = activeImpl();
	if (!backend) return Promise.resolve(new Set());
	return backend.listPaneIdsAsync();
}

export function paneExists(paneId: string, known?: Set<string>): boolean {
	const backend = activeImpl();
	if (!backend) return false;
	return backend.paneExists(paneId, known);
}

/** Read the last `lines` lines of a pane's output ("" when the pane is gone). */
export function readScreenTail(paneId: string, lines = 6): string {
	const backend = activeImpl();
	if (!backend) return "";
	return backend.readScreenTail(paneId, lines);
}

export function readScreenTailAsync(paneId: string, lines = 6): Promise<string> {
	const backend = activeImpl();
	if (!backend) return Promise.resolve("");
	return backend.readScreenTailAsync(paneId, lines);
}

/** Send text to a pane as a single submission (paste + Enter semantics). */
export async function sendText(paneId: string, text: string): Promise<void> {
	const backend = requireBackend();
	await backend.sendText(paneId, text);
}

/** Result of a steer delivery: ok = the message reached the child. */
export interface DeliveryResult {
	ok: boolean;
	/** Structured herdr prompt outcome — always set on failure; undefined on wezterm success. */
	outcome?: AgentPromptOutcome;
}

/**
 * Deliver a steering message to a pane (ADR-1 in docs/herdr-agent-surface-backlog.md):
 * herdr goes through `agent prompt` — a blocked child refuses the text BEFORE
 * it is typed, and ok means the child was seen working|settling, so nothing
 * drops silently; wezterm keeps the plain sendText. The herdr branch never
 * throws — failures return a structured outcome; the wezterm branch still
 * propagates sendText failures (pane gone) to the caller's catch.
 */
export async function deliverMessage(paneId: string, text: string): Promise<DeliveryResult> {
	const backend = requireBackend();
	if (backend.promptAgent) {
		const outcome = await backend.promptAgent(paneId, text);
		return { ok: outcome === "delivered", outcome };
	}
	await backend.sendText(paneId, text);
	return { ok: true };
}

/**
 * Set the stable pane label (ADR-3 in docs/herdr-agent-surface-backlog.md):
 * herdr renames the pane's agent — plain sanitized label first, one
 * `-<id8>`-suffixed retry on refusal/collision, then a silent give-up;
 * wezterm has no agent names, so it is a no-op. Never throws: labeling is
 * cosmetics, addressing always goes through pane ids.
 */
export function labelPane(paneId: string, label: string): void {
	const backend = activeImpl();
	if (!backend) return;
	backend.applyPaneLabel?.(paneId, label);
}

/** Interrupt the foreground program in a pane (Esc aborts pi's turn, Ctrl+C kills a command). */
export async function sendInterrupt(paneId: string, key: "escape" | "ctrl-c"): Promise<void> {
	const backend = requireBackend();
	await backend.sendInterrupt(paneId, key);
}

/** Run a launcher script in a pane sitting at a shell prompt (resume). */
export async function runScriptInPane(paneId: string, scriptPath: string): Promise<void> {
	const backend = requireBackend();
	await backend.runScriptInPane(paneId, scriptPath);
}

/** Close a pane. Best-effort: must never break the parent. */
export function closePane(paneId: string): void {
	const backend = activeImpl();
	if (!backend) return;
	backend.closePane(paneId);
}

/** Focus hand-back after splits (wezterm needs it; herdr is a no-op). */
export function activatePane(paneId: string): void {
	const backend = activeImpl();
	if (!backend) return;
	backend.activatePane(paneId);
}

// Dynamic herdr import, cached: callers must stay backend-agnostic — mux is
// the only surface, and herdr is not imported outside this module — while
// the deferred re-label (ADR-3) and the done-waiter need herdr directly.
// The ESM module promise is memoized, so repeated loads are free.
let herdrModule: Promise<typeof import("./herdr.ts")> | null = null;
function loadHerdr(): Promise<typeof import("./herdr.ts")> {
	herdrModule ??= import("./herdr.ts");
	return herdrModule;
}

export function loadNativeAgentOps(): Promise<NativeAgentOps> | null {
	const backend = activeImpl();
	if (!backend) return null;
	const { applyPaneLabelAsync, spawnDoneWaiter } = backend;
	if (!applyPaneLabelAsync || !spawnDoneWaiter) return null;
	const ops: NativeAgentOps = { applyPaneLabelAsync, spawnDoneWaiter };
	return loadHerdr().then(() => ops);
}

// ── Completion detection (backend-independent) ──

export { parseSentinel, SENTINEL_PATTERN };

/** Subagent display name → herdr agent label (ADR-3), so callers stay mux-imported. */
export { herdrAgentName } from "./herdr.ts";
