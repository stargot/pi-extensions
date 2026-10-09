import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef } from "./agents.ts";

export function safeFilePart(s: string): string {
	const cleaned = s
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned || "subagent";
}

export function subagentId(name: string): string {
	return `${safeFilePart(name)}-${randomUUID().slice(0, 8)}`;
}

function fileTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

export function sessionFilePath(sessionsRoot: string, id: string): string {
	return join(sessionsRoot, `${fileTimestamp().slice(0, 23)}Z_${id}.jsonl`);
}

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

export function dispatchParentModel(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function resolveLaunchModel(
	modelOverride: string | undefined,
	def: Pick<AgentDef, "model">,
	parentModel?: string,
): string | undefined {
	return modelOverride?.trim() || def.model || parentModel || undefined;
}

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

export function resolveLaunchCwd(cwd: string | undefined, fallback: string): string {
	const dir = cwd?.trim() || fallback;
	const problem = cwdProblemMessage(dir);
	if (problem) throw new Error(problem);
	return dir;
}

export interface LaunchPlan {
	id: string;
	model?: string;
	sessionFile: string;
	identityFile?: string;
	taskFile?: string;
}

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
