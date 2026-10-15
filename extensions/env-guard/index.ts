import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { basename, resolve } from "node:path";
import {
	buildRedactor,
	escapeRegExp,
	mergeHits,
	redactDeep,
	redactEnvLines,
	redactMessage,
	redactText,
	walkDeep,
	type Redactor,
} from "./redact.ts";
import { collectSecrets, type CollectDeps, type FileSource, type SecretEntry } from "./secrets.ts";

export interface NotifyContext {
	hasUI: boolean;
	cwd: string;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface GuardState {
	secrets: SecretEntry[];
	redactor: Redactor;
	files: FileSource[];
	envNames: string[];
	counters: Map<string, number>;
	reported: Set<string>;
}

export function createState(): GuardState {
	return {
		secrets: [],
		redactor: { regex: null, lookup: new Map() },
		files: [],
		envNames: [],
		counters: new Map(),
		reported: new Set(),
	};
}

export async function refresh(state: GuardState, startDir: string, deps: CollectDeps = {}): Promise<void> {
	const collected = await collectSecrets(startDir, deps);
	state.secrets = collected.secrets;
	state.redactor = buildRedactor(collected.secrets);
	state.files = collected.sources.files;
	state.envNames = collected.sources.envNames;
	const keys = new Set(state.secrets.map((secret) => secret.key));
	state.reported = new Set([...state.reported].filter((key) => keys.has(key)));
}

function recordHits(state: GuardState, hits: Map<string, number>): void {
	for (const [key, count] of hits) state.counters.set(key, (state.counters.get(key) ?? 0) + count);
}

function notifyNewKeys(state: GuardState, hits: Map<string, number>, ctx: NotifyContext): void {
	for (const key of hits.keys()) {
		if (state.reported.has(key)) continue;
		state.reported.add(key);
		if (ctx.hasUI) ctx.ui.notify(`env-guard: redacted ${key}`, "warning");
	}
}

function redactEnvLineFallback(text: string, hits: Map<string, number>): string {
	const result = redactEnvLines(text);
	mergeHits(hits, result.hits);
	return result.text;
}

const ENV_BASENAME_PATTERN = /(?:^|[^\w.])(\.env(?:\.[A-Za-z0-9_-]+)?|\.envrc)(?![\w-])/i;

export function isEnvFamilyPath(path: string, cwd: string): boolean {
	const name = basename(resolve(cwd, path)).toLowerCase();
	return name === ".env" || name === ".env.local" || name.startsWith(".env.") || name === ".envrc";
}

export function findEnvReference(command: string, files: FileSource[]): string | undefined {
	for (const file of files) {
		if (command.includes(file.path)) return file.path;
	}
	const match = ENV_BASENAME_PATTERN.exec(command);
	return match?.[1];
}

export function findEnvNameReference(command: string, names: string[]): string | undefined {
	for (const name of names) {
		if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(command)) return name;
	}
	return undefined;
}

export function createToolCallDenyHandler(state: GuardState) {
	return async (event: ToolCallEvent, ctx: NotifyContext): Promise<ToolCallEventResult | undefined> => {
		let reason: string | undefined;
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("edit", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event)
		) {
			const path = event.input.path;
			if (typeof path === "string" && isEnvFamilyPath(path, ctx.cwd)) {
				reason = `env-guard: access to ${path} is denied`;
			}
		}
		if (!reason && (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event))) {
			const file = findEnvReference(event.input.command, state.files);
			const name = file === undefined ? findEnvNameReference(event.input.command, state.envNames) : undefined;
			if (file !== undefined) reason = `env-guard: access to ${file} is denied`;
			else if (name !== undefined) reason = `env-guard: command references secret env var ${name}`;
		}
		if (!reason) return undefined;
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	};
}

export function createUserBashHandler(state: GuardState) {
	return async (event: UserBashEvent, ctx: NotifyContext): Promise<UserBashEventResult | undefined> => {
		const file = findEnvReference(event.command, state.files);
		const name = file === undefined ? findEnvNameReference(event.command, state.envNames) : undefined;
		let reason: string | undefined;
		if (file !== undefined) reason = `env-guard: access to ${file} is denied`;
		else if (name !== undefined) reason = `env-guard: command references secret env var ${name}`;
		if (!reason) return undefined;
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
	};
}

export function createInputHandler(state: GuardState) {
	return async (event: InputEvent, ctx: NotifyContext): Promise<InputEventResult | undefined> => {
		const redactor = state.redactor;
		const valueResult = redactText(event.text, redactor);
		const lineResult = redactEnvLines(valueResult.text);
		if (!valueResult.changed && !lineResult.changed) return undefined;
		const hits = new Map<string, number>();
		mergeHits(hits, valueResult.hits);
		mergeHits(hits, lineResult.hits);
		recordHits(state, hits);
		notifyNewKeys(state, hits, ctx);
		return { action: "transform", text: lineResult.text };
	};
}

export function createToolCallHandler(state: GuardState) {
	return async (event: ToolCallEvent, ctx: NotifyContext): Promise<ToolCallEventResult | undefined> => {
		const redactor = state.redactor;
		if (!redactor.regex) return undefined;
		const { hits } = walkDeep(event.input, redactor, false);
		if (hits.size === 0) return undefined;
		recordHits(state, hits);
		notifyNewKeys(state, hits, ctx);
		return undefined;
	};
}

export function createToolResultHandler(state: GuardState) {
	return async (event: ToolResultEvent, ctx: NotifyContext): Promise<ToolResultEventResult | undefined> => {
		const redactor = state.redactor;
		const hits = new Map<string, number>();

		const content = event.content.map((item) => {
			if (item.type !== "text") return item;
			const valueResult = redactText(item.text, redactor);
			const lineResult = redactEnvLines(valueResult.text);
			mergeHits(hits, valueResult.hits);
			mergeHits(hits, lineResult.hits);
			if (!valueResult.changed && !lineResult.changed) return item;
			return { ...item, text: lineResult.text };
		});

		let structuredContent = event.structuredContent;
		if (structuredContent !== undefined) {
			const result = redactDeep(structuredContent, redactor, redactEnvLineFallback);
			mergeHits(hits, result.hits);
			if (result.changed) structuredContent = result.value;
		}

		let details = event.details;
		let detailsChanged = false;
		if (details !== undefined && details !== null) {
			const result = redactDeep(details, redactor, redactEnvLineFallback);
			mergeHits(hits, result.hits);
			if (result.changed) {
				details = result.value;
				detailsChanged = true;
			}
		}

		if (hits.size === 0) return undefined;

		recordHits(state, hits);
		notifyNewKeys(state, hits, ctx);

		const patch: ToolResultEventResult = { content };
		if (event.structuredContent !== undefined) patch.structuredContent = structuredContent;
		if (detailsChanged) patch.details = details;
		return patch;
	};
}

export function createMessageEndHandler(state: GuardState) {
	return async (event: MessageEndEvent, ctx: NotifyContext): Promise<{ message: AgentMessage } | undefined> => {
		if (!state.redactor.regex) return undefined;
		const result = redactMessage(event.message, state.redactor);
		if (!result) return undefined;
		recordHits(state, result.hits);
		notifyNewKeys(state, result.hits, ctx);
		return { message: result.message };
	};
}

export function formatStatus(state: GuardState): string {
	const lines: string[] = [];
	lines.push(`env-guard: ${state.secrets.length} secret${state.secrets.length === 1 ? "" : "s"} tracked`);
	const fileParts = state.files.map((file) => `${file.path} (${file.count})`);
	lines.push(`files: ${fileParts.length > 0 ? fileParts.join(", ") : "none"}`);
	lines.push(`process.env: ${state.envNames.length > 0 ? state.envNames.join(", ") : "none"}`);
	if (state.counters.size === 0) {
		lines.push("redactions: none");
	} else {
		const parts = [...state.counters.entries()]
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([key, count]) => `${key} x${count}`);
		lines.push(`redactions: ${parts.join(", ")}`);
	}
	return lines.join("\n");
}

export async function rescan(state: GuardState, cwd: string, deps: CollectDeps = {}): Promise<string> {
	const before = new Set(state.secrets.map((secret) => secret.key));
	await refresh(state, cwd, deps);
	const after = new Set(state.secrets.map((secret) => secret.key));
	const added = [...after].filter((key) => !before.has(key));
	const removed = [...before].filter((key) => !after.has(key));
	const lines = [
		`env-guard: rescan done, ${state.secrets.length} secret${state.secrets.length === 1 ? "" : "s"} tracked`,
	];
	if (added.length > 0) lines.push(`added: ${added.join(", ")}`);
	if (removed.length > 0) lines.push(`removed: ${removed.join(", ")}`);
	if (added.length === 0 && removed.length === 0) lines.push(`unchanged: ${after.size}`);
	return lines.join("\n");
}

export function createEnvGuard(pi: ExtensionAPI, deps: CollectDeps = {}): GuardState {
	const state = createState();
	pi.on("session_start", async (_event, ctx) => {
		await refresh(state, ctx.cwd, deps);
	});
	pi.on("tool_call", createToolCallDenyHandler(state));
	pi.on("tool_call", createToolCallHandler(state));
	pi.on("user_bash", createUserBashHandler(state));
	pi.on("input", createInputHandler(state));
	pi.on("tool_result", createToolResultHandler(state));
	pi.on("message_end", createMessageEndHandler(state));
	pi.registerCommand("env-guard", {
		description: "env-guard: tracked secrets and redaction stats; pass 'rescan' to re-read env sources",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "rescan") {
				const message = await rescan(state, ctx.cwd, deps);
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				return;
			}
			if (arg.length > 0) {
				if (ctx.hasUI) ctx.ui.notify("env-guard: unknown argument, use /env-guard or /env-guard rescan", "warning");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(formatStatus(state), "info");
		},
	});
	return state;
}

export default function (pi: ExtensionAPI) {
	createEnvGuard(pi);
}
