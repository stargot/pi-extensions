/**
 * env-guard extension: keep collected secret values out of the session
 * transcript. Secrets are collected once per session (secrets.ts) and every
 * channel is then guarded: tool calls reading .env-family files or naming
 * secret env vars are blocked outright; user bash commands get the same
 * check; model input, tool_call arguments, tool results and finished
 * messages are redacted by exact value (redact.ts) so a secret that slips
 * into any payload never reaches the model or the session log.
 *
 * Handlers are thin closures over a shared GuardState, built by the
 * create*Handler factories — that shape keeps each hook testable in
 * isolation with a fake NotifyContext.
 */
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

/** What each handler needs besides the event: project cwd for path checks
 *  and a notify channel that only exists when a UI does (headless hosts). */
export interface NotifyContext {
	hasUI: boolean;
	cwd: string;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/**
 * Shared mutable guard state: the current secret inventory, the matcher
 * compiled from it, the sources it came from, and the /env-guard
 * bookkeeping (per-key redaction counters, keys already notified about).
 * refresh() swaps the inventory in place; handlers only read the matcher.
 */
export interface GuardState {
	secrets: SecretEntry[];
	redactor: Redactor;
	files: FileSource[];
	envNames: string[];
	counters: Map<string, number>;
	reported: Set<string>;
}

/** Empty state: no secrets, inert redactor (regex null). Kept separate
 *  from the handlers so tests can start from a known baseline. */
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

/**
 * Re-collect secrets and swap them into the state. Reported keys that no
 * longer resolve (source file edited, env changed) are forgotten so a
 * removed secret gets re-notified if it ever reappears; hit counters are
 * deliberately kept — past redactions still happened.
 */
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

/** True for `.env`, `.env.local`, any `.env.*` and `.envrc`, resolved
 *  against cwd and case-insensitive. The check is on the basename, so env
 *  files in any directory are caught, not just the project root. */
export function isEnvFamilyPath(path: string, cwd: string): boolean {
	const name = basename(resolve(cwd, path)).toLowerCase();
	return name === ".env" || name === ".env.local" || name.startsWith(".env.") || name === ".envrc";
}

/**
 * Detect a command touching a known env file: verbatim path of any tracked
 * file first, else a bare .env-family basename (catches variants like
 * `.env.production` that exist on disk but were never collected). Returns
 * the file path to report in the refusal.
 */
export function findEnvReference(command: string, files: FileSource[]): string | undefined {
	for (const file of files) {
		if (command.includes(file.path)) return file.path;
	}
	const match = ENV_BASENAME_PATTERN.exec(command);
	return match?.[1];
}

/** First secret-named env var whose NAME the command references (word-
 *  bounded, e.g. `echo $OPENAI_API_KEY`). Name-only by design: blocking
 *  needs no value, and the value must never appear in a command. */
export function findEnvNameReference(command: string, names: string[]): string | undefined {
	for (const name of names) {
		if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(command)) return name;
	}
	return undefined;
}

/**
 * tool_call hook factory: hard-block env access — read/edit/write/grep/find
 * on any .env-family path, and bash/powershell commands mentioning a
 * tracked env file or a secret env var name. Blocked rather than redacted:
 * the tool would read the raw file and the secret would land in the result
 * before any redaction could catch it.
 */
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

/** user_bash hook factory: same file/name detection as the deny handler
 *  for commands the user runs directly, returned as a failed result so the
 *  refusal shows up in the shell output slot. */
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

/**
 * input hook factory: the one channel where raw secrets legitimately
 * appear — the user typing or pasting them. Redact values and secret-keyed
 * KEY=value lines from the typed text before it becomes a message, then
 * tally and notify the keys hit.
 */
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

/**
 * tool_call hook factory: scrub secret values found anywhere in the
 * arguments (in place — a model echoing a secret back into a tool call
 * must not pass it on). Values only; access control lives in
 * createToolCallDenyHandler. No-op while the redactor has no patterns.
 */
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

/**
 * tool_result hook factory: redact secret values in text blocks, and (via
 * the env-line fallback) `KEY=<value>` lines under secret-named keys inside
 * structuredContent/details — output the model is about to see. Returns a
 * patch containing only the fields that changed; no hits → no patch.
 */
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

/** message_end hook factory: last-chance scrub of a finished message (all
 *  roles with text, plus thinking) before it is stored or sent. */
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

/** Multi-line /env-guard status: tracked secret count, per-file counts,
 *  secret-named process.env vars, per-key redaction tallies sorted by key. */
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

/** Re-run collection and describe the delta (added/removed/unchanged
 *  keys) as the /env-guard rescan report. Unlike refresh, the output is
 *  for the user, not silent state repair. */
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

/**
 * Wire the guard onto an ExtensionAPI: collect on session_start, register
 * every hook handler and the /env-guard command (`rescan` re-reads
 * sources, a bare call prints formatStatus). Returns the state so hosts
 * and tests can inspect counters or force a refresh.
 */
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

/** Extension entry point: install env-guard with default collection deps. */
export default function (pi: ExtensionAPI) {
	createEnvGuard(pi);
}
