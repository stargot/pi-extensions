/**
 * Launch preparation for subagents, shared by the pane (`subagent`) and
 * headless (`task_batch`) paths: the pieces that must exist before a child
 * pi process spawns — subagent id, session file path, identity/task
 * markdown files — plus the small resolution helpers (model precedence,
 * agent lookup, cwd validation) both launchers call first.
 *
 * File writing is transactional at the buildLaunchPlan level: a failure
 * mid-way unlinks what was already written, so a failed launch never
 * leaves half-created artifacts behind.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef } from "./agents.ts";

/** Filesystem-safe slug of an agent name: lowercase [a-z0-9-], collapsed
 *  dashes, never empty (`subagent` fallback) so a garbage name cannot
 *  produce an unlaunchable path. */
export function safeFilePart(s: string): string {
	const cleaned = s
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned || "subagent";
}

/** `<slug>-<8 hex>`: readable prefix for /trace cards, random suffix so
 *  repeated launches of the same agent never collide. */
export function subagentId(name: string): string {
	return `${safeFilePart(name)}-${randomUUID().slice(0, 8)}`;
}

function fileTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Session file path under the sessions root, ISO-timestamp-prefixed
 *  (colons/dots → dashes) so directory listings sort chronologically. The
 *  path is computed here; the file is created by the launcher. */
export function sessionFilePath(sessionsRoot: string, id: string): string {
	return join(sessionsRoot, `${fileTimestamp().slice(0, 23)}Z_${id}.jsonl`);
}

/**
 * Where launch files go. `artifact`: durable, deterministic names in the
 * artifact context dir — pane-path launches leave a readable trace.
 * `temp`: random-named dot-files in the sessions root — headless batch
 * children don't need durable context, and long system prompts must not
 * ride in a Windows command line.
 */
export type LaunchFilePolicy = { kind: "artifact"; dir: string } | { kind: "temp"; dir: string };

/** Identity is deterministic per agent name — respawn/resume overwrite, no file spam. */
export function buildIdentityFile(policy: LaunchFilePolicy, name: string, body: string): string {
	const file =
		policy.kind === "artifact" ? `${safeFilePart(name)}-identity.md` : `.identity-${randomUUID().slice(0, 8)}.md`;
	const path = join(policy.dir, file);
	mkdirSync(policy.dir, { recursive: true });
	writeFileSync(path, body, "utf8");
	return path;
}

/** Write the child's task prompt to a file — artifact policy keeps a
 *  timestamped copy for the trace, temp policy uses a throwaway random
 *  name. Tasks go through files because they are long and Windows command
 *  lines are not. */
export function buildTaskFile(policy: LaunchFilePolicy, name: string, content: string): string {
	const file =
		policy.kind === "artifact"
			? `${safeFilePart(name)}-${fileTimestamp().slice(0, 19)}.md`
			: `.task-${randomUUID().slice(0, 8)}.md`;
	const path = join(policy.dir, file);
	mkdirSync(policy.dir, { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

/** Parent's model as `provider/id`, or undefined when the parent has none
 *  — the shape resolveLaunchModel expects for its last fallback. */
export function dispatchParentModel(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

/**
 * Model precedence: explicit override → agent definition → parent's model
 * → undefined (pi default). Whitespace-only overrides count as absent, so
 * a blank `-m ` cannot silently disable the definition's model.
 */
export function resolveLaunchModel(
	modelOverride: string | undefined,
	def: Pick<AgentDef, "model">,
	parentModel?: string,
): string | undefined {
	return modelOverride?.trim() || def.model || parentModel || undefined;
}

/**
 * Headless thinking precedence: agent definition → parent's level, but the
 * parent's level only when the child also inherits the parent's model — a
 * level tuned for one model is not carried onto another. Undefined lets pi
 * apply its defaultThinkingLevel.
 */
export function resolveHeadlessThinking(
	def: Pick<AgentDef, "model" | "thinking">,
	parentThinking?: string,
): string | undefined {
	return def.thinking || (def.model ? undefined : parentThinking) || undefined;
}

/** Look up an agent definition or throw the canonical unknown-agent error,
 *  listing available names (and pointing at the agent dirs when none exist
 *  at all) so the model can self-correct on its next call. */
export function resolveAgentDef(defs: Map<string, AgentDef>, agent: string): AgentDef {
	const def = defs.get(agent);
	if (def) return def;
	const names = Array.from(defs.keys());
	throw new Error(
		names.length > 0
			? `Unknown agent "${agent}". Available: ${names.join(", ")}.`
			: `Unknown agent "${agent}". No agent definitions found in .pi/agents/ or ~/.pi/agent/agents/.`,
	);
}

/** Human-readable problem with a custom cwd (missing / not a directory),
 *  or null when it is usable. Blank counts as "not provided": there is
 *  nothing to validate and the fallback will apply. */
export function cwdProblemMessage(cwd: string | undefined): string | null {
	const dir = cwd?.trim();
	if (!dir) return null;
	try {
		if (!statSync(dir).isDirectory()) return `cwd is not a directory: ${dir}`;
	} catch {
		return `cwd does not exist: ${dir}`;
	}
	return null;
}

/** Resolve the child's working directory: the given cwd (validated) or the
 *  fallback. Throws instead of returning a bad dir — a child spawned into a
 *  missing cwd would only fail later, with a much worse error. */
export function resolveLaunchCwd(cwd: string | undefined, fallback: string): string {
	const dir = cwd?.trim() || fallback;
	const problem = cwdProblemMessage(dir);
	if (problem) throw new Error(problem);
	return dir;
}

/** Everything the launcher needs after preparation: child id, resolved
 *  model, session file path, and the identity/task files when the policies
 *  produced them. */
export interface LaunchPlan {
	id: string;
	model?: string;
	sessionFile: string;
	identityFile?: string;
	taskFile?: string;
}

/** Inputs for buildLaunchPlan: the agent definition, its display name, an
 *  optional fixed id (tests/resume), the model override chain, the sessions
 *  root, and a file policy per written file. */
export interface LaunchPlanInput {
	def: AgentDef;
	name: string;
	id?: string;
	modelOverride?: string;
	parentModel?: string;
	sessionsRoot: string;
	identityPolicy: LaunchFilePolicy;
	task?: { content: string; policy: LaunchFilePolicy };
}

/**
 * Prepare a launch: id, model (override → def → parent), session file path,
 * and identity/task files written per their policies. Transactional — a
 * failure after some writes unlinks them before rethrowing, leaving no
 * orphan files behind.
 */
export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
	const id = input.id ?? subagentId(input.name);
	const written: string[] = [];
	try {
		const identityFile = input.def.body
			? buildIdentityFile(input.identityPolicy, input.name, input.def.body)
			: undefined;
		if (identityFile) written.push(identityFile);
		const taskFile = input.task ? buildTaskFile(input.task.policy, input.name, input.task.content) : undefined;
		if (taskFile) written.push(taskFile);
		return {
			id,
			model: resolveLaunchModel(input.modelOverride, input.def, input.parentModel),
			sessionFile: sessionFilePath(input.sessionsRoot, id),
			identityFile,
			taskFile,
		};
	} catch (err) {
		for (const file of written) {
			try {
				unlinkSync(file);
			} catch {}
		}
		throw err;
	}
}
