/**
 * Prime protocol injector + orchestrator dashboard + solo enforcement.
 *
 * Part 1 — protocol. Appends the prime protocol to the system prompt of MAIN
 * sessions only, so every pi session runs as "prime" — an orchestrator that
 * works through the subagent swarm instead of doing everything itself.
 * The inject is assembled from a single source of truth — the agent pool:
 *   1. ~/.pi/agent/PRIME.md — short manifest: role, model economics,
 *      pointer to the protocol below;
 *   2. the body of ~/.pi/agent/agents/prime.md (frontmatter stripped) —
 *      prime directive, hard rules, delegation contract, result handling,
 *      stop conditions, report format;
 *   3. a dispatch table generated at inject time from the `subagents`
 *      frontmatter list of agents/prime.md, each row filled with the role
 *      file's own `description` and `model` frontmatter. Adding, removing
 *      or retargeting a role updates the protocol on the next session —
 *      no hand-maintained role list can drift.
 *
 * Part 2 — dashboard (TUI only). Makes the orchestrator's decisions visible:
 *   - when the first user message of a session arrives, a notification
 *     banner greets the user (model, pool size);
 *   - a status widget below the editor tracks the session live: solo
 *     lookups/edits vs dispatched agents by name and count, with the
 *     remaining enforcement budget. Pure facts for the human.
 *
 * Part 3 — solo enforcement (code, not prompt). Prompt-only limits proved
 * unenforceable: live sessions ran 40+ solo lookups with the protocol
 * injected and zero dispatches. Now the tools themselves say no:
 *   - orientation lookups (read/grep/find/ls/glob, and file-reading shell
 *     commands) are blocked past the allowance: 3 per user turn + 3 more
 *     for each dispatched agent (verification of child results);
 *   - re-reading an already-read file (pagination) never spends budget;
 *   - edits/writes beyond 3 distinct files per user turn are blocked —
 *     bulk file work belongs to a worker;
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
 *      That append is compared against the bodies of agents/*.md — a match
 *      means child identity → skip. Any OTHER append (e.g. the user's global
 *      APPEND_SYSTEM.md) is not a child signal: the session stays armed and
 *      the protocol is injected alongside it. Comparing for "any non-empty
 *      append" silently disarmed every main session with APPEND_SYSTEM.md;
 *   3. tool-allowlisted children have no `subagent` tool at all → selectedTools.
 * The same guards arm parts 1 and 3 — an un-armed session is neither
 * injected nor blocked. Missing or empty PRIME.md makes part 1 a no-op;
 * missing pieces degrade stepwise (no agent file → intro only, no role
 * file → "definition missing" row).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const PROTOCOL_PATH = join(getAgentDir(), "PRIME.md");
const PRIME_DEF_PATH = join(getAgentDir(), "agents", "prime.md");
const AGENTS_DIR = join(getAgentDir(), "agents");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

const WIDGET_KEY = "prime-status";

const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const SPAWN_TOOLS = new Set(["subagent", "task_batch"]);

const BASE_LOOKUP_ALLOWANCE = 3;
const PER_DISPATCH_ALLOWANCE = 3;
const FILE_TURN_LIMIT = 3;

const SHELL_READERS =
	/(^|[\s;|&])(cat|head|tail|less|more|type|rg|grep|find|ls|dir|file|wc|stat|tree|du|df|where|which|gc|gci|cat|Get-Content|Get-ChildItem|Get-Item|Select-String)(\s|$)/;

function readIfExists(path: string): string {
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

function splitFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
	const normalized = raw.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return { attrs: {}, body: normalized };
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) return { attrs: {}, body: normalized };
	const header = normalized.slice(4, end);
	const body = normalized.slice(end + 4).trim();
	const attrs: Record<string, string> = {};
	for (const line of header.split("\n")) {
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = (match[1] ?? "").toLowerCase();
		let value = (match[2] ?? "").trim();
		if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
			value = value.slice(1, -1);
		}
		if (key) attrs[key] = value;
	}
	return { attrs, body };
}

function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildDispatchTable(primeAttrs: Record<string, string>): string {
	const names = (primeAttrs["subagents"] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (names.length === 0) return "";

	const rows = names.map((name) => {
		const raw = readIfExists(join(AGENTS_DIR, `${name}.md`));
		if (!raw) return `| ${cell(name)} | ⚠ definition missing — nobody provides this capability | — |`;
		const { attrs } = splitFrontmatter(raw);
		const purpose = attrs["description"]?.trim() || "—";
		const model = attrs["model"]?.trim() || "—";
		return `| ${cell(name)} | ${cell(purpose)} | ${cell(model)} |`;
	});

	return [
		"## Dispatch table",
		"",
		"Generated from the live agent pool (`~/.pi/agent/agents/`).",
		"",
		"| Role | Purpose | Model |",
		"|---|---|---|",
		...rows,
	].join("\n");
}

function knownAgentBodies(): Set<string> {
	const bodies = new Set<string>();
	try {
		for (const entry of readdirSync(AGENTS_DIR)) {
			if (!entry.endsWith(".md")) continue;
			const body = splitFrontmatter(readIfExists(join(AGENTS_DIR, entry))).body;
			if (body) bodies.add(body.trim());
		}
	} catch {
		/* fail-open: treat as no known identities */
	}
	return bodies;
}

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

function asInput(event: unknown): Record<string, unknown> {
	const input = (event as { input?: unknown }).input;
	return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function spawnAgents(toolName: string, input: Record<string, unknown> | undefined): string[] {
	if (!input || !SPAWN_TOOLS.has(toolName)) return [];
	if (toolName === "subagent") {
		const agent = typeof input.agent === "string" ? input.agent.trim() : "";
		return agent ? [agent] : [];
	}
	const tasks = Array.isArray(input.tasks) ? input.tasks : [];
	const names = tasks
		.map((task) =>
			task && typeof task === "object" && typeof (task as { agent?: unknown }).agent === "string"
				? (task as { agent: string }).agent.trim()
				: "",
		)
		.filter(Boolean);
	if (names.length > 0) return names;
	const single = typeof input.agent === "string" ? input.agent.trim() : "";
	return single ? [single] : [];
}

function shellLooksLikeLookup(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command : "";
	const segments = command.split(/(?:&&|\|\||;|\|)/);
	const first = segments.find((segment) => !/^\s*(cd|pushd)\s/.test(segment)) ?? segments[0] ?? "";
	return SHELL_READERS.test(first.trim().slice(0, 120));
}

type Stats = { lookups: number; edits: number; spawned: number; agentUse: Map<string, number> };

function emptyStats(): Stats {
	return { lookups: 0, edits: 0, spawned: 0, agentUse: new Map() };
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

	const poolNames = (splitFrontmatter(readIfExists(PRIME_DEF_PATH)).attrs["subagents"] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	modelShort = readSessionModel();
	poolSize = poolNames.length;

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
		const head = `⚡ Prime · ${modelShort || "?"} · ${poolSize} agents`;
		const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
		const solo = `solo: ${plural(stats.lookups, "lookup")}, ${plural(stats.edits, "edit")}`;
		const capLabel =
			turn.override === null
				? String(lookupAllowance())
				: turn.override === Number.POSITIVE_INFINITY
					? "off"
					: `cap ${turn.override}`;
		const budget = armed ? ` · turn ${turn.lookups}/${capLabel}, files ${turn.files.size}/${FILE_TURN_LIMIT}` : "";
		if (stats.spawned === 0) return `${head} │ ${solo}${budget} │ dispatched: none`;
		const agents = [...stats.agentUse.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
		const shown = agents.slice(0, 4).join(", ");
		const rest = agents.length > 4 ? ` +${agents.length - 4}` : "";
		return `${head} │ ${solo}${budget} │ dispatched ${stats.spawned}: ${shown}${rest}`;
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

	pi.on("tool_call", (event) => {
		try {
			if (!armed || isChild()) return;
			const tool = event.toolName;
			const input = asInput(event);

			const spawned = spawnAgents(tool, input);
			if (spawned.length > 0) {
				turn.dispatches += spawned.length;
				return;
			}

			const isRead = tool === "read";
			const isShellReader = (tool === "bash" || tool === "powershell") && shellLooksLikeLookup(input);
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
				return;
			}

			if (EDIT_TOOLS.has(tool)) {
				const path = typeof input.path === "string" ? input.path : "";
				if (path && !turn.files.has(path)) {
					if (turn.files.size >= FILE_TURN_LIMIT) {
						return {
							block: true,
							reason: `Prime solo enforcement: ${turn.files.size} files already edited this user turn (limit ${FILE_TURN_LIMIT}). Bulk file work belongs to a worker: dispatch it (subagent/task_batch) with an exact task, then verify the diff. The user can relax this with /solo off.`,
						};
					}
					turn.files.add(path);
				}
			}
		} catch {
			/* fail-safe */
		}
	});

	pi.on("tool_result", (event, ctx) => {
		try {
			if (isChild() || event.parentToolCallId) return;
			const tool = event.toolName;
			if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls" || tool === "glob") stats.lookups += 1;
			else if (tool === "bash" || tool === "powershell") stats.lookups += 1;
			else if (EDIT_TOOLS.has(tool)) stats.edits += 1;
			for (const agent of spawnAgents(tool, event.input)) {
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
		if (append && append.trim().length > 0 && knownAgentBodies().has(append.trim())) {
			armed = false;
			return;
		}

		const tools = event.systemPromptOptions?.selectedTools ?? [];
		if (tools.length > 0 && !tools.includes("subagent")) {
			armed = false;
			return;
		}

		armed = true;

		const intro = readIfExists(PROTOCOL_PATH);
		if (!intro) return;

		const primeRaw = readIfExists(PRIME_DEF_PATH);
		if (!primeRaw) {
			return { systemPrompt: `${event.systemPrompt}\n\n${intro}` };
		}

		const { attrs, body } = splitFrontmatter(primeRaw);
		const table = buildDispatchTable(attrs);

		const protocol = [intro, body, table].filter(Boolean).join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${protocol}` };
	});
}
