/**
 * Child tool loadout: which tools and extension entry points a subagent
 * process gets, for both launch paths.
 *
 * pi's `--tools` allowlist applies to extension tools too, and a pane child
 * with a `tools:` list runs with `-ne` (no extension discovery — only the
 * explicit `-e` paths load). Three consequences this module owns:
 *   - an extension tool named in `tools:` (web_search, browser_*) exists
 *     only if its extension is attached explicitly;
 *   - the session guards (env-guard, edit-guard) must be attached too, or a
 *     `-ne` child runs unguarded — free to read .env into its transcript;
 *   - an agent with `subagents:` needs the pane tools in its allowlist, or
 *     the spawning extension loads but `subagent` is filtered out.
 * Headless (task_batch) children never get pane tools: a background
 * process must not open terminal panes.
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { join } from "node:path";

/** Tools registered by the subagents extension that drive terminal panes. */
export const PANE_TOOLS = ["subagent", "subagent_message", "subagent_cancel", "subagents_list"];

/** Extensions every `-ne` child loads regardless of its tool list. */
const GUARD_EXTENSIONS = ["env-guard", "edit-guard"];

/** Where extension entry points live: this package, and pi's user extension dir. */
export interface ExtensionRoots {
	/** The package's `extensions/` folder (sibling of subagents/). */
	packageDir: string;
	/** `~/.pi/agent/extensions` — local, non-package extensions. */
	agentExtDir: string;
}

/** Entry point providing `tool`, or undefined for built-ins and unknown tools. */
function extensionForTool(tool: string, roots: ExtensionRoots): string | undefined {
	if (tool === "web_search" || tool === "web_fetch") return join(roots.packageDir, "web", "index.ts");
	if (tool.startsWith("browser_")) return join(roots.agentExtDir, "browser", "index.ts");
	return undefined;
}

/**
 * Explicit `-e` paths for a pane child: the guards plus the extensions
 * behind its extension tools. Empty when the child keeps discovery (no
 * `tools:` list) — discovery already loads them, and a second `-e` would
 * register the same tools twice. Missing files are skipped silently.
 */
export function childExtensionPaths(
	tools: string[] | undefined,
	roots: ExtensionRoots,
	exists: (path: string) => boolean,
): string[] {
	if (!tools || tools.length === 0) return [];
	const paths = new Set<string>();
	for (const guard of GUARD_EXTENSIONS) paths.add(join(roots.packageDir, guard, "index.ts"));
	for (const tool of tools) {
		const path = extensionForTool(tool, roots);
		if (path) paths.add(path);
	}
	return [...paths].filter(exists);
}

/** Pane allowlist: the definition's list plus the pane tools when the agent may spawn. */
export function paneChildTools(tools: string[] | undefined, grantSpawning: boolean): string[] | undefined {
	if (!tools || !grantSpawning) return tools;
	return [...tools, ...PANE_TOOLS.filter((tool) => !tools.includes(tool))];
}

/** Headless allowlist: the definition's list minus the pane tools. May come back empty. */
export function headlessChildTools(tools: string[] | undefined): string[] | undefined {
	if (!tools) return undefined;
	return tools.filter((tool) => !PANE_TOOLS.includes(tool));
}
