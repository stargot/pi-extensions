/**
 * Read-only guard for subagent children whose definition says
 * `readonly: true` (scout, reviewer, planner, ...). Those agents need bash
 * for `git diff` or test runs, so a tool allowlist cannot keep them from
 * writing — this extension blocks the calls instead: edit/write outright,
 * shell commands that write files or mutate git, packages or remote state
 * (shared/shell.ts heuristics).
 *
 * Armed by PI_SUBAGENT_READONLY=1, which both launch paths set from the
 * definition and attach this file with `-e`. A tripwire for a cooperating
 * model, not a sandbox: interpreters (`python -c`, `node -e`) still pass.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellMutation } from "../shared/shell.ts";

export const READONLY_ENV = "PI_SUBAGENT_READONLY";

const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Block reason for a tool call in a read-only child, or undefined to let it run. */
export function readonlyViolation(toolName: string, input: Record<string, unknown>): string | undefined {
	if (WRITE_TOOLS.has(toolName)) return `\`${toolName}\` changes files`;
	if (!SHELL_TOOLS.has(toolName)) return undefined;
	return shellMutation(typeof input.command === "string" ? input.command : "");
}

export default function readonlyGuard(pi: ExtensionAPI) {
	if (process.env[READONLY_ENV] !== "1") return;
	pi.on("tool_call", (event) => {
		try {
			const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
			const violation = readonlyViolation(event.toolName, input);
			if (!violation) return undefined;
			return {
				block: true,
				reason: `Read-only agent: this call ${violation}. Your role must not modify files, git state, packages or remote systems — report what should change instead of changing it.`,
			};
		} catch {
			return undefined;
		}
	});
}
