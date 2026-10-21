/**
 * Prime policy: protocol injection, orchestrator dashboard, solo
 * enforcement and the /prime toggle — the behavior of the former standalone
 * prime extension, rebuilt as a pure factory.
 *
 * Part 1 — protocol. Every main session runs as "prime", an orchestrator
 * working through the subagent swarm: the body of the pool's `prime`
 * definition (project overrides global), a dispatch table generated from
 * the live pool, and the solo budget rule rendered from the enforcement
 * constants are appended to the system prompt.
 *
 * Part 2 — dashboard (TUI only). A greeting banner on the first user
 * message and a status widget below the editor: per-turn budget while
 * armed, dispatched agents by name and count, and the on/off/broken state
 * of the toggle.
 *
 * Part 3 — solo enforcement (code, not prompt). Lookups (read/grep/find/
 * ls/glob and file-reading shell commands) are blocked past the allowance:
 * 3 per user turn + 3 per dispatched agent. Re-reading an already-read
 * file is free. Edits are capped at 3 distinct files per turn; shell
 * writes share the cap. /solo <N> raises the lookup cap, /solo off lifts
 * enforcement until the next user message. Counters reset on every user
 * message.
 *
 * Toggle (`.pi/prime.json`, `{ "enabled": boolean }`): read on session
 * start, on every before_agent_start and in /prime. An absent file means
 * on; an unreadable/invalid file keeps the session's last-known-good mode
 * (a fresh session starts on), warns once and shows the widget as
 * "unknown (broken .pi/prime.json)". Writes happen only from /prime on|off.
 * With the toggle off nothing is injected or blocked, no counters or stats
 * are kept, but the widget stays visible as "⚡ Prime · off".
 *
 * Guard order is invariant: env (PI_SUBAGENT_SESSION) → append (child
 * identity) → selectedTools → armed — and only then the toggle. Children
 * are never injected and never blocked, toggle on or off.
 *
 * Boundaries: pi is imported for types only; no direct fs — the pool, the
 * model label and the state-file read/write arrive via PrimeDeps (real
 * implementations live in index.ts, as do the pi subscriptions/commands
 * that delegate here).
 */
import { basename } from "node:path";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionCommandContext,
	ExtensionContext,
	MessageStartEvent,
	Theme,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";
import {
	asInput,
	buildBudgetRule,
	buildDispatchTable,
	isChildAppend,
	shellLooksLikeLookup,
	shellWriteTargets,
	spawnAgents,
	type DispatchRow,
} from "./prime-protocol.ts";

const PRIME_NAME = "prime";

const WIDGET_KEY = "prime-status";

const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

const BASE_LOOKUP_ALLOWANCE = 3;
const PER_DISPATCH_ALLOWANCE = 3;
const FILE_TURN_LIMIT = 3;

/** Classification of one read of the toggle file (real impl: index.ts). */
export type PrimeStateRead = { kind: "absent" } | { kind: "ok"; enabled: boolean } | { kind: "error"; message: string };

/** Everything the policy needs from the outside world; injected by index.ts. */
export interface PrimeDeps {
	/** The merged agent pool (project overrides global), discovered live. */
	agents: () => Map<string, AgentDef>;
	/** Toggle file path: `<cwd>/.pi/prime.json`. */
	stateFile: string;
	/** Model label for the banner/widget, re-read per render ("" = default model). */
	model: () => string | undefined;
	/** Read the toggle file with absent/ok/error classification (error carries a message). */
	readState: (path: string) => PrimeStateRead;
	/** Persist the toggle (tmp+rename); throws on failure. */
	writeState: (path: string, enabled: boolean) => void;
}

/** Event/command handlers index.ts subscribes and registers for. */
export interface PrimePolicy {
	onSessionStart: (ctx: ExtensionContext) => void;
	onUserMessageStart: (event: MessageStartEvent, ctx: ExtensionContext) => void;
	onToolCall: (event: ToolCallEvent) => ToolCallEventResult | undefined;
	onToolResult: (event: ToolResultEvent, ctx: ExtensionContext) => void;
	onBeforeAgentStart: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | undefined;
	onPrimeCommand: (args: string, ctx: ExtensionCommandContext) => void;
	onSoloCommand: (args: string, ctx: ExtensionCommandContext) => void;
}

type Stats = { spawned: number; agentUse: Map<string, number> };

function emptyStats(): Stats {
	return { spawned: 0, agentUse: new Map() };
}

type Turn = {
	lookups: number;
	readPaths: Set<string>;
	files: Set<string>;
	dispatches: number;
	override: number | null;
};

function emptyTurn(): Turn {
	return { lookups: 0, readPaths: new Set(), files: new Set(), dispatches: 0, override: null };
}

export function createPrimePolicy(deps: PrimeDeps): PrimePolicy {
	const isChild = () => Boolean(process.env.PI_SUBAGENT_SESSION);

	const modelShort = (): string => deps.model() ?? "";

	// Toggle state: last-known-good mode (a session starts on) plus whether
	// the state file is currently unreadable.
	let enabled = true;
	let stateBroken = false;
	let stateBrokenNotified = false;

	let armed = false;
	let greeted = false;
	let stats = emptyStats();
	let turn = emptyTurn();

	/** Apply a state-file read: ok/absent set the mode, error keeps the last-known-good one. */
	const applyState = (read: PrimeStateRead): void => {
		if (read.kind === "error") {
			stateBroken = true;
			return;
		}
		enabled = read.kind === "ok" ? read.enabled : true;
		stateBroken = false;
		stateBrokenNotified = false;
	};

	/** Warn once per broken-state episode (reset by a good read or a new session). */
	const notifyBrokenOnce = (ctx: ExtensionContext): void => {
		if (!stateBroken || stateBrokenNotified || isChild() || !ctx.hasUI) return;
		stateBrokenNotified = true;
		ctx.ui.notify(`Prime state file unreadable — keeping last-known ${enabled ? "on" : "off"} until fixed.`, "warning");
	};

	const dispatchRows = (): DispatchRow[] =>
		[...deps.agents().values()]
			.filter(
				(def) =>
					// Self-exclusion by either marker (OR), then dispatch opt-out.
					!(def.name === PRIME_NAME || basename(def.path) === `${PRIME_NAME}.md`) && def.dispatch !== false,
			)
			.map((def) => ({ name: def.name, description: def.description }));

	/** Bodies of the live pool — child-identity detection. Empty bodies must
	 * not enter the set: `append.endsWith("")` is always true and would mark
	 * every session a child. */
	const agentBodies = (): Set<string> => new Set([...deps.agents().values()].map((def) => def.body).filter(Boolean));

	const lookupAllowance = (): number =>
		turn.override ?? BASE_LOOKUP_ALLOWANCE + PER_DISPATCH_ALLOWANCE * turn.dispatches;

	const banner = (): string => {
		const poolSize = dispatchRows().length;
		const pool = poolSize > 0 ? `${poolSize} agents` : "no agents";
		const model = modelShort() || "default model";
		return `⚡ Prime online — orchestrator mode · ${model} · ${pool} in the pool`;
	};

	const statusLine = (): string => {
		const head = stateBroken
			? "⚡ Prime · unknown (broken .pi/prime.json)"
			: enabled
				? `⚡ Prime · ${modelShort() || "?"}`
				: "⚡ Prime · off";
		const capLabel =
			turn.override === null
				? String(lookupAllowance())
				: turn.override === Number.POSITIVE_INFINITY
					? "off"
					: `cap ${turn.override}`;
		// Budget counters are only meaningful while enforcing: when off they
		// are frozen and would only mislead.
		const budget =
			armed && enabled ? ` │ lookup ${turn.lookups}/${capLabel} · files ${turn.files.size}/${FILE_TURN_LIMIT}` : "";
		if (stats.spawned === 0) return `${head}${budget} │ sent 0`;
		const agents = [...stats.agentUse.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
		const shown = agents.slice(0, 4).join(", ");
		const rest = agents.length > 4 ? ` +${agents.length - 4}` : "";
		return `${head}${budget} │ sent ${stats.spawned}: ${shown}${rest}`;
	};

	const drawWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || isChild()) return;
		try {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme: Theme) => ({
					render: () => [theme.fg("success", statusLine())],
					invalidate: () => {},
				}),
				{ placement: "belowEditor" },
			);
		} catch {
			/* fail-safe */
		}
	};

	/** Claim edit-cap slots for new paths; a block result once the cap is spent. /solo off lifts it. */
	const claimFiles = (paths: unknown[]): { block: true; reason: string } | undefined => {
		if (turn.override === Number.POSITIVE_INFINITY) return undefined;
		for (const path of paths) {
			if (typeof path !== "string" || !path || turn.files.has(path)) continue;
			if (turn.files.size >= FILE_TURN_LIMIT) {
				return {
					block: true,
					reason: `Prime solo enforcement: ${turn.files.size} files already edited this user turn (limit ${FILE_TURN_LIMIT}). Bulk file work belongs to a worker: dispatch it (subagent/task_batch) with an exact task, then verify the diff. The user can relax this with /solo off.`,
				};
			}
			turn.files.add(path);
		}
		return undefined;
	};

	const primeStateLabel = (): string =>
		stateBroken
			? `unknown (broken .pi/prime.json; enforcement last-known ${enabled ? "on" : "off"})`
			: enabled
				? "on"
				: "off";

	return {
		onSessionStart: (ctx) => {
			greeted = false;
			stateBrokenNotified = false;
			stats = emptyStats();
			turn = emptyTurn();
			applyState(deps.readState(deps.stateFile));
			notifyBrokenOnce(ctx);
			drawWidget(ctx);
		},

		onUserMessageStart: (event, ctx) => {
			try {
				const message = event.message as { role?: string } | undefined;
				if (!message || message.role !== "user") return;
				turn = emptyTurn();
				notifyBrokenOnce(ctx);
				if (greeted || isChild() || ctx.mode !== "tui") {
					drawWidget(ctx);
					return;
				}
				// Off suppresses the banner; the greeting retries on a later
				// message, so re-enabling mid-session still announces itself.
				if (enabled) {
					greeted = true;
					ctx.ui.notify(banner(), "info");
				}
				drawWidget(ctx);
			} catch {
				/* fail-safe */
			}
		},

		onToolCall: (event) => {
			try {
				if (!armed || isChild() || !enabled) return undefined;
				const tool = event.toolName;
				const input = asInput(event);

				// Dispatches raise the allowance only once they succeed (tool_result):
				// a spawn of an unknown agent must not buy lookup budget.
				if (spawnAgents(tool, input).length > 0) return undefined;

				const isShell = tool === "bash" || tool === "powershell";
				// Shell writes (redirects, Set-Content, tee) share the edit cap with
				// edit/write — checked before the lookup branch, since `cat > f` is both.
				const shellTargets = isShell ? shellWriteTargets(input) : [];
				const capped = claimFiles(EDIT_TOOLS.has(tool) ? [input.path] : shellTargets);
				if (capped) return capped;
				if (shellTargets.length > 0) return undefined;

				const isRead = tool === "read";
				const isShellReader = isShell && shellLooksLikeLookup(input);
				if (LOOKUP_TOOLS.has(tool) || isRead || isShellReader) {
					if (isRead) {
						const path = typeof input.path === "string" ? input.path : "";
						if (path && turn.readPaths.has(path)) return undefined;
						if (path) turn.readPaths.add(path);
					}
					if (turn.lookups >= lookupAllowance()) {
						return {
							block: true,
							reason: `Prime solo enforcement: ${turn.lookups} lookup calls already spent this user turn (allowance ${BASE_LOOKUP_ALLOWANCE} + ${PER_DISPATCH_ALLOWANCE} per dispatched agent). Delegate now: dispatch a scout (subagent tool) or a task_batch, then verify its report — verification is covered by the per-dispatch allowance. The user can raise the cap with /solo <N> or /solo off.`,
						};
					}
					turn.lookups += 1;
				}
				return undefined;
			} catch {
				/* fail-safe */
			}
		},

		onToolResult: (event, ctx) => {
			try {
				if (isChild() || event.parentToolCallId) return;
				if (enabled) {
					const spawned = event.isError ? [] : spawnAgents(event.toolName, event.input);
					if (armed) turn.dispatches += spawned.length;
					for (const agent of spawned) {
						stats.spawned += 1;
						stats.agentUse.set(agent, (stats.agentUse.get(agent) ?? 0) + 1);
					}
				}
				drawWidget(ctx);
			} catch {
				/* fail-safe */
			}
		},

		onBeforeAgentStart: (event) => {
			if (process.env.PI_SUBAGENT_SESSION) {
				armed = false;
				return undefined;
			}

			const append = event.systemPromptOptions?.appendSystemPrompt;
			if (isChildAppend(append, agentBodies())) {
				armed = false;
				return undefined;
			}

			const tools = event.systemPromptOptions?.selectedTools ?? [];
			if (tools.length > 0 && !tools.includes("subagent")) {
				armed = false;
				return undefined;
			}

			armed = true;

			// Toggle check strictly after the guards and after arming: child
			// detection outranks the off state.
			applyState(deps.readState(deps.stateFile));
			if (!enabled) return undefined;

			const primeDef = deps.agents().get(PRIME_NAME);
			if (!primeDef) return undefined;

			const budget = buildBudgetRule({
				base: BASE_LOOKUP_ALLOWANCE,
				perDispatch: PER_DISPATCH_ALLOWANCE,
				files: FILE_TURN_LIMIT,
			});
			const table = buildDispatchTable(dispatchRows());

			const protocol = [primeDef.body, budget, table].filter(Boolean).join("\n\n");
			if (!protocol) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${protocol}` };
		},

		onPrimeCommand: (args, ctx) => {
			try {
				const arg = args.trim().toLowerCase();
				if (arg !== "on" && arg !== "off") {
					// status — and unknown arguments, with usage alongside.
					applyState(deps.readState(deps.stateFile));
					if (ctx.hasUI) {
						if (arg && arg !== "status") ctx.ui.notify("Usage: /prime on | off | status", "warning");
						// ADR §2 status: mode, state-file path, what on-mode
						// enforces, and the toggles — the numbers rendered from
						// the same constants the enforcement uses.
						ctx.ui.notify(
							`Prime is ${primeStateLabel()}. State file: ${deps.stateFile}. On: protocol injection, ` +
								`${BASE_LOOKUP_ALLOWANCE} lookups + ${PER_DISPATCH_ALLOWANCE} per dispatched agent, ` +
								`${FILE_TURN_LIMIT} distinct files per user turn. ` +
								"Toggle: /prime on | off · lookup cap: /solo <N> | off",
							"info",
						);
					}
					notifyBrokenOnce(ctx);
					drawWidget(ctx);
					return;
				}

				const next = arg === "on";
				// Write first: a failure throws and the mode stays as it was.
				deps.writeState(deps.stateFile, next);
				enabled = next;
				stateBroken = false;
				stateBrokenNotified = false;
				if (ctx.hasUI) {
					ctx.ui.notify(
						next
							? // ADR §2 verbatim: the toggle lands on the next run
								// (before_agent_start), the current one keeps the old
								// protocol; off never touches the subagent tools.
								"Prime on — протокол и solo-enforcement вернутся со следующего хода"
							: "Prime off — инъекция и блокировки сняты со следующего хода; инструменты субагентов остаются доступны",
						"info",
					);
				}
				drawWidget(ctx);
			} catch (err) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Failed to write ${deps.stateFile}: ${err instanceof Error ? err.message : String(err)} — Prime mode unchanged.`,
						"error",
					);
				}
			}
		},

		onSoloCommand: (args, ctx) => {
			try {
				if (!enabled) {
					if (ctx.hasUI) ctx.ui.notify("Prime выключен — сначала /prime on", "warning");
					return;
				}
				const arg = args.trim().toLowerCase();
				if (arg === "off") turn.override = Number.POSITIVE_INFINITY;
				else if (/^\d+$/.test(arg)) turn.override = Number.parseInt(arg, 10);
				if (ctx.hasUI) {
					const cap =
						turn.override === null
							? `default (${BASE_LOOKUP_ALLOWANCE}+${PER_DISPATCH_ALLOWANCE}/dispatch)`
							: turn.override === Number.POSITIVE_INFINITY
								? "off"
								: String(turn.override);
					ctx.ui.notify(`Solo lookups this turn: ${cap}`, "info");
				}
				drawWidget(ctx);
			} catch {
				/* fail-safe */
			}
		},
	};
}
