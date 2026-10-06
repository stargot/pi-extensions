/**
 * Pure helpers for the prime protocol extension — file parsing, dispatch
 * table generation and tool-input classification. Deliberately
 * dependency-free (no pi imports) so tests can run standalone: every
 * filesystem access takes its directory as an argument.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
		const { attrs } = splitFrontmatter(readIfExists(join(agentsDir, entry)));
		const name = attrs["name"]?.trim() || entry.slice(0, -".md".length);
		if (name === selfName) continue;
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

const SPAWN_TOOLS = new Set(["subagent", "task_batch"]);

const SHELL_READERS =
	/(^|[\s;|&])(cat|head|tail|less|more|type|rg|grep|find|ls|dir|file|wc|stat|tree|du|df|where|which|gc|gci|cat|Get-Content|Get-ChildItem|Get-Item|Select-String)(\s|$)/;

export function shellLooksLikeLookup(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command : "";
	const segments = command.split(/(?:&&|\|\||;|\|)/);
	const first = segments.find((segment) => !/^\s*(cd|pushd)\s/.test(segment)) ?? segments[0] ?? "";
	return SHELL_READERS.test(first.trim().slice(0, 120));
}
