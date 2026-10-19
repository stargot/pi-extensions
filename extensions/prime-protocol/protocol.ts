/**
 * Pure helpers for the prime protocol extension — file parsing, dispatch
 * table generation and tool-input classification. Deliberately
 * dependency-free (no pi imports) so tests can run standalone: every
 * filesystem access takes its directory as an argument.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shellPipelines, shellWriteTargets as writeTargets } from "../shared/shell.ts";

export function readIfExists(path: string): string {
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

export function splitFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
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

export function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export type DispatchTarget = { name: string; description: string; model: string };

/**
 * The dispatchable agent pool: every agents/*.md except prime itself and
 * agents that opt out with `dispatch: false` in frontmatter. Names come
 * from the `name` frontmatter (fallback: file name), sorted for a stable
 * table — adding, removing or retargeting a role file updates the pool on
 * the next session with no hand-maintained list to drift.
 */
export function dispatchTargets(agentsDir: string, selfName: string): DispatchTarget[] {
	let entries: string[];
	try {
		entries = readdirSync(agentsDir);
	} catch {
		return [];
	}
	const targets: DispatchTarget[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const raw = readIfExists(join(agentsDir, entry));
		if (!raw) continue;
		const { attrs } = splitFrontmatter(raw);
		const name = attrs["name"]?.trim() || entry.slice(0, -".md".length);
		if (name === selfName || entry === `${selfName}.md`) continue;
		if ((attrs["dispatch"] ?? "").trim().toLowerCase() === "false") continue;
		targets.push({
			name,
			description: attrs["description"]?.trim() || "—",
			model: attrs["model"]?.trim() || "—",
		});
	}
	return targets.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildDispatchTable(agentsDir: string, selfName: string): string {
	const targets = dispatchTargets(agentsDir, selfName);
	if (targets.length === 0) return "";

	const rows = targets.map(
		(target) => `| ${cell(target.name)} | ${cell(target.description)} | ${cell(target.model)} |`,
	);

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

/**
 * The solo budget rule as the tools actually enforce it — rendered from
 * the enforcement constants so the injected prompt can never drift from
 * what the code blocks. The prompt-only "at most 3 lookups" wording in
 * the agent body is advisory; this section is the contract.
 */
export function buildBudgetRule(allowance: { base: number; perDispatch: number; files: number }): string {
	return [
		"## Solo budget — enforced in code",
		"",
		`The extension blocks, it does not remind: ${allowance.base} solo lookup calls per user turn (read/grep/find/ls/glob and file-reading shell commands), +${allowance.perDispatch} more for each dispatched agent (verifying its report is covered). Re-reading an already-read file never spends the budget. Edits are capped at ${allowance.files} distinct files per user turn — bulk file work belongs to a worker. /solo <N> raises the lookup cap for the turn; /solo off disables enforcement until the next user message.`,
	].join("\n");
}

export function knownAgentBodies(agentsDir: string): Set<string> {
	const bodies = new Set<string>();
	try {
		for (const entry of readdirSync(agentsDir)) {
			if (!entry.endsWith(".md")) continue;
			const body = splitFrontmatter(readIfExists(join(agentsDir, entry))).body;
			if (body) bodies.add(body.trim());
		}
	} catch {
		/* fail-open: treat as no known identities */
	}
	return bodies;
}

/**
 * True when a session's appended system prompt carries a child identity.
 * The identity is the LAST append (a shared APPEND_SUBAGENT.md may precede
 * it), so the append ends with a known agent body. Any other append — the
 * user's APPEND_SYSTEM.md in a main session — is not a child signal.
 */
export function isChildAppend(append: string | undefined, bodies: Set<string>): boolean {
	const appended = append?.trim() ?? "";
	if (!appended) return false;
	for (const body of bodies) if (appended.endsWith(body)) return true;
	return false;
}

export function asInput(event: unknown): Record<string, unknown> {
	const input = (event as { input?: unknown }).input;
	return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

export function spawnAgents(toolName: string, input: Record<string, unknown> | undefined): string[] {
	if (!input || !SPAWN_TOOLS.has(toolName)) return [];
	if (toolName === "subagent") {
		const agent = typeof input.agent === "string" ? input.agent.trim() : "";
		return agent ? [agent] : [];
	}
	// task_batch: parallel `tasks` and sequential `chain` both dispatch one agent per entry.
	const tasks = [
		...(Array.isArray(input.tasks) ? input.tasks : []),
		...(Array.isArray(input.chain) ? input.chain : []),
	];
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

const SPAWN_TOOLS = new Set(["subagent", "task_batch"]);

const SHELL_READERS =
	/^(cat|head|tail|less|more|type|rg|grep|find|ls|dir|file|wc|stat|tree|du|df|where|which|gc|gci|sed|awk|bat|nl|od|xxd|findstr|Get-Content|Get-ChildItem|Get-Item|Select-String)(\s|$)/i;

/** git subcommands that only read history or the tree. */
const GIT_READERS = /^git\s+(show|log|diff|grep|blame|ls-files|ls-tree|cat-file)(\s|$)/i;

/**
 * Every command in a `;` / `&&` / `||` sequence is checked — `echo x; cat f`
 * reads a file however it starts. Pipe consumers are not: `npm test | tail`
 * filters a test run, it does not look anything up.
 */
export function shellLooksLikeLookup(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command : "";
	return shellPipelines(command)
		.map((stages) => stages[0] ?? "")
		.filter((head) => !/^(cd|pushd|Set-Location)(\s|$)/i.test(head))
		.some((head) => SHELL_READERS.test(head) || GIT_READERS.test(head));
}

/**
 * Files a shell command writes — counted against the per-turn edit cap like
 * edit/write, so a `cat > f` heredoc is not a way around it.
 */
export function shellWriteTargets(input: Record<string, unknown>): string[] {
	return writeTargets(typeof input.command === "string" ? input.command : "");
}
