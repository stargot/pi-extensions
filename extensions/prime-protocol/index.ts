/**
 * Prime protocol injector + orchestrator dashboard + solo enforcement.
 *
 * Part 1 — protocol. Appends the prime protocol to the system prompt of MAIN
 * sessions only, so every pi session runs as "prime" — an orchestrator that
 * works through the subagent swarm instead of doing everything itself.
 * The inject is assembled from a single source of truth — the agent pool:
 *   1. the body of ~/.pi/agent/agents/prime.md (frontmatter stripped) —
 *      intro (first lines), prime directive, hard rules, delegation
 *      contract, result handling, stop conditions, report format;
 *   2. a dispatch table generated at inject time by scanning agents/*.md —
 *      every role file except prime itself, each row filled with the
 *      file's own `description` and `model` frontmatter; a role opts out
 *      with `dispatch: false`. Adding, removing or retargeting a role
 *      updates the protocol on the next session — no hand-maintained role
 *      list (frontmatter or otherwise) can drift;
 *   3. the solo budget rule, rendered from the enforcement constants —
 *      the injected numbers always match what the tools actually block.
 *
 * Part 2 — dashboard (TUI only). Makes the orchestrator's decisions visible:
 *   - when the first user message of a session arrives, a notification
 *     banner greets the user (model, pool size);
 *   - a status widget below the editor tracks the session live: the
 *     per-turn enforcement budget (lookups/files) while armed, plus
 *     dispatched agents by name and count. Pure facts for the human.
 *
 * Part 3 — solo enforcement (code, not prompt). Prompt-only limits proved
 * unenforceable: live sessions ran 40+ solo lookups with the protocol
 * injected and zero dispatches. Now the tools themselves say no:
 *   - orientation lookups (read/grep/find/ls/glob, and file-reading shell
 *     commands) are blocked past the allowance: 3 per user turn + 3 more
 *     for each dispatched agent (verification of child results);
 *   - re-reading an already-read file (pagination) never spends budget;
 *   - edits/writes beyond 3 distinct files per user turn are blocked —
 *     bulk file work belongs to a worker; shell writes (redirects,
 *     Set-Content/Out-File/tee) count against the same cap;
 *   - the allowance grows only after a dispatch succeeds (tool_result),
 *     and `task_batch` chain steps count like parallel tasks;
 *   - /solo <N> raises the lookup allowance for the turn, /solo off
 *     disables enforcement until the next user message;
 *   - counters reset on every user message; children (PI_SUBAGENT_SESSION)
 *     and un-armed sessions are never blocked.
 *
 * Subagent children must NOT receive the protocol: a scout told to delegate
 * stops doing work. Injection is skipped when the process is a child:
 *   1. pane children run with PI_SUBAGENT_SESSION set by the subagents launcher;
 *   2. headless (task_batch) children receive an agent identity via
 *      --append-system-prompt → systemPromptOptions.appendSystemPrompt.
 *      An append ending with the body of an agents/*.md file means child
 *      identity → skip (a shared APPEND_SUBAGENT.md may come first). Any OTHER append (e.g. the user's global
 *      APPEND_SYSTEM.md) is not a child signal: the session stays armed and
 *      the protocol is injected alongside it. Comparing for "any non-empty
 *      append" silently disarmed every main session with APPEND_SYSTEM.md;
 *   3. tool-allowlisted children have no `subagent` tool at all → selectedTools.
 * The same guards arm parts 1 and 3 — an un-armed session is neither
 * injected nor blocked. A missing prime.md file makes part 1 a no-op; an
 * empty pool (no eligible agents) drops the dispatch table.
 */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	asInput,
	buildBudgetRule,
	buildDispatchTable,
	dispatchTargets,
	isChildAppend,
	knownAgentBodies,
	readIfExists,
	shellLooksLikeLookup,
	shellWriteTargets,
	splitFrontmatter,
	spawnAgents,
} from "./protocol.ts";

const PRIME_NAME = "prime";
const PRIME_DEF_PATH = join(getAgentDir(), "agents", `${PRIME_NAME}.md`);
const AGENTS_DIR = join(getAgentDir(), "agents");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

const WIDGET_KEY = "prime-status";

const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

const BASE_LOOKUP_ALLOWANCE = 3;
const PER_DISPATCH_ALLOWANCE = 3;
const FILE_TURN_LIMIT = 3;

function readSessionModel(): string {
	const raw = readIfExists(SETTINGS_PATH);
	if (!raw) return "";
	try {
		const parsed = JSON.parse(raw) as { defaultModel?: string };
		const model = parsed.defaultModel?.trim();
		return model ? (model.split("/").pop() ?? "") : "";
	} catch {
		return "";
	}
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

let modelShort = "";
let poolSize = 0;

export default function primeProtocol(pi: ExtensionAPI) {
	const isChild = () => Boolean(process.env.PI_SUBAGENT_SESSION);

	modelShort = readSessionModel();
	poolSize = dispatchTargets(AGENTS_DIR, PRIME_NAME).length;

	let armed = false;
	let greeted = false;
	let stats = emptyStats();
	let turn = emptyTurn();

	const lookupAllowance = (): number =>
		turn.override ?? BASE_LOOKUP_ALLOWANCE + PER_DISPATCH_ALLOWANCE * turn.dispatches;

	const banner = (): string => {
		const pool = poolSize > 0 ? `${poolSize} agents` : "no agents";
		const model = modelShort || "default model";
		return `⚡ Prime online — orchestrator mode · ${model} · ${pool} in the pool`;
	};

	const statusLine = (): string => {
		const head = `⚡ Prime · ${modelShort || "?"}`;
		const capLabel =
			turn.override === null
				? String(lookupAllowance())
				: turn.override === Number.POSITIVE_INFINITY
					? "off"
					: `cap ${turn.override}`;
		const budget = armed ? ` │ lookup ${turn.lookups}/${capLabel} · files ${turn.files.size}/${FILE_TURN_LIMIT}` : "";
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

	pi.registerCommand("solo", {
		description: "Prime solo enforcement for this turn: <N> lookup cap | off",
		handler: async (args, ctx) => {
			try {
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
	});

	pi.on("session_start", (_event, ctx) => {
		greeted = false;
		stats = emptyStats();
		turn = emptyTurn();
		drawWidget(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		try {
			const message = event.message as { role?: string } | undefined;
			if (!message || message.role !== "user") return;
			turn = emptyTurn();
			if (greeted || isChild() || ctx.mode !== "tui") {
				drawWidget(ctx);
				return;
			}
			greeted = true;
			ctx.ui.notify(banner(), "info");
			drawWidget(ctx);
		} catch {
			/* fail-safe */
		}
	});

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

	pi.on("tool_call", (event) => {
		try {
			if (!armed || isChild()) return;
			const tool = event.toolName;
			const input = asInput(event);

			// Dispatches raise the allowance only once they succeed (tool_result):
			// a spawn of an unknown agent must not buy lookup budget.
			if (spawnAgents(tool, input).length > 0) return;

			const isShell = tool === "bash" || tool === "powershell";
			// Shell writes (redirects, Set-Content, tee) share the edit cap with
			// edit/write — checked before the lookup branch, since `cat > f` is both.
			const shellTargets = isShell ? shellWriteTargets(input) : [];
			const capped = claimFiles(EDIT_TOOLS.has(tool) ? [input.path] : shellTargets);
			if (capped) return capped;
			if (shellTargets.length > 0) return;

			const isRead = tool === "read";
			const isShellReader = isShell && shellLooksLikeLookup(input);
			if (LOOKUP_TOOLS.has(tool) || isRead || isShellReader) {
				if (isRead) {
					const path = typeof input.path === "string" ? input.path : "";
					if (path && turn.readPaths.has(path)) return;
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
		} catch {
			/* fail-safe */
		}
	});

	pi.on("tool_result", (event, ctx) => {
		try {
			if (isChild() || event.parentToolCallId) return;
			const spawned = event.isError ? [] : spawnAgents(event.toolName, event.input);
			if (armed) turn.dispatches += spawned.length;
			for (const agent of spawned) {
				stats.spawned += 1;
				stats.agentUse.set(agent, (stats.agentUse.get(agent) ?? 0) + 1);
			}
			drawWidget(ctx);
		} catch {
			/* fail-safe */
		}
	});

	pi.on("before_agent_start", (event) => {
		if (process.env.PI_SUBAGENT_SESSION) {
			armed = false;
			return;
		}

		const append = event.systemPromptOptions?.appendSystemPrompt;
		if (isChildAppend(append, knownAgentBodies(AGENTS_DIR))) {
			armed = false;
			return;
		}

		const tools = event.systemPromptOptions?.selectedTools ?? [];
		if (tools.length > 0 && !tools.includes("subagent")) {
			armed = false;
			return;
		}

		armed = true;

		const primeRaw = readIfExists(PRIME_DEF_PATH);
		if (!primeRaw) return;

		const { body } = splitFrontmatter(primeRaw);
		const budget = buildBudgetRule({
			base: BASE_LOOKUP_ALLOWANCE,
			perDispatch: PER_DISPATCH_ALLOWANCE,
			files: FILE_TURN_LIMIT,
		});
		const table = buildDispatchTable(AGENTS_DIR, PRIME_NAME);

		const protocol = [body, budget, table].filter(Boolean).join("\n\n");
		if (!protocol) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${protocol}` };
	});
}
