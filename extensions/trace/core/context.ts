/**
 * Контекст модели на точке дерева — повтор buildContextEntries() /
 * buildSessionProjection() из session-manager pi (паритет — в тестах):
 * путь от листа к корню, последняя компакция заменяет всё до firstKeptEntryId
 * (system-сообщения из сохранённого диапазона выпадают в пользу её чекпойнта),
 * последний context_edit на цель заменяет content или убирает сообщение.
 *
 * Поверх проекции — оценка размера частей (символы) для состава контекста
 * по ролям и дифф двух проекций по исходным записям.
 *
 * Чистый модуль: без Node/DOM API (его же грузит веб-вьюер).
 */
import { contentText, oneLine } from "./text.ts";
import type { Entry } from "./tree.ts";

/** Роль части контекста. summary — compactionSummary и branchSummary. */
export type ContextRole = "system" | "user" | "assistant" | "toolResult" | "bash" | "custom" | "summary";

export const CONTEXT_ROLES: readonly ContextRole[] = [
	"system",
	"user",
	"assistant",
	"toolResult",
	"bash",
	"custom",
	"summary",
];

/** Одно сообщение контекста с привязкой к исходной записи. */
export interface ContextPart {
	entryId: string;
	role: ContextRole;
	/** Размер в символах — основа оценки токенов (масштабируется к реальному промпту). */
	chars: number;
	/** Превью в одну строку: «toolResult(bash): FAIL …». */
	text: string;
	/** Content подменён context_edit. */
	edited: boolean;
}

/** Записи пути, попадающие в контекст с учётом последней компакции. */
export function contextEntries(path: readonly Entry[]): Entry[] {
	let idx = -1;
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i]!.type === "compaction") {
			idx = i;
			break;
		}
	}
	if (idx < 0) return path.slice();
	const compaction = path[idx]!;
	const out: Entry[] = [compaction];
	let kept = false;
	for (let i = 0; i < idx; i++) {
		const e = path[i]!;
		if (e.id === compaction.firstKeptEntryId) kept = true;
		if (kept && !(e.type === "message" && e.message?.role === "system")) out.push(e);
	}
	out.push(...path.slice(idx + 1));
	return out;
}

/** Проекция контекста, который увидит следующий запрос к модели после leaf-записи пути. */
export function projectContext(path: readonly Entry[]): ContextPart[] {
	const entries = contextEntries(path);
	const edits = new Map<string, Entry>();
	for (const e of entries) if (e.type === "context_edit") edits.set(e.targetId, e);
	const out: ContextPart[] = [];
	entries.forEach((e, i) => {
		// Старая компакция внутри сохранённого диапазона ничего не вносит — только первая.
		if (e.type === "compaction" && i > 0) return;
		const edit = edits.get(e.id!);
		if (edit && edit.replacement === null) return;
		for (const part of entryParts(e, edit?.replacement)) out.push(part);
	});
	return out;
}

function entryParts(e: Entry, replacement: any): ContextPart[] {
	const id = e.id!;
	const edited = replacement != null;
	const part = (role: ContextRole, label: string, body: string, chars = body.length): ContextPart => ({
		entryId: id,
		role,
		chars,
		text: oneLine(`${label}: ${body}`, 100),
		edited,
	});
	switch (e.type) {
		case "message": {
			const m = e.message ?? {};
			const content = edited ? replacement.content : m.content;
			switch (m.role) {
				case "system": {
					const sections = Object.values(m.sections ?? {}).filter((s): s is string => typeof s === "string");
					const tools = Array.isArray(m.toolsAdded) ? JSON.stringify(m.toolsAdded) : "";
					const body = [contentText(m.content), ...sections].join("\n");
					return [part("system", "system", body || "(prompt patch)", body.length + tools.length)];
				}
				case "user":
					return [part("user", "user", blocksText(content))];
				case "assistant":
					return [part("assistant", "assistant", blocksText(content))];
				case "toolResult":
					return [part("toolResult", m.toolName ? `toolResult(${m.toolName})` : "toolResult", blocksText(content))];
				case "bashExecution":
					// excludeFromContext: pi не превращает команду в user-текст запроса.
					if (m.excludeFromContext) return [];
					return [part("bash", "bash", `${m.command ?? ""}\n${m.output ?? ""}`)];
				case "custom":
					return [part("custom", `custom(${m.customType ?? "?"})`, blocksText(content))];
				default:
					return [part("custom", String(m.role ?? "?"), blocksText(content))];
			}
		}
		case "custom_message": {
			const content = edited ? replacement.content : e.content;
			return [part("custom", `custom_message(${e.customType ?? "?"})`, blocksText(content))];
		}
		case "branch_summary":
			return e.summary ? [part("summary", "branch_summary", String(e.summary))] : [];
		case "compaction": {
			const summary = part("summary", "compaction", String(e.summary ?? ""));
			return e.systemMessage
				? [...entryParts({ ...e, type: "message", message: e.systemMessage }, null), summary]
				: [summary];
		}
		default:
			return []; // custom, label, usage, context_edit, model_change … — вне контекста
	}
}

/** Все блоки content в текст: text, thinking, вызовы инструментов с аргументами, картинки — меткой. */
function blocksText(content: unknown): string {
	if (!Array.isArray(content)) return contentText(content);
	return content
		.map((b: any) => {
			switch (b?.type) {
				case "text":
					return b.text ?? "";
				case "thinking":
					return b.thinking ?? "";
				case "toolCall":
					return `⚒ ${b.name ?? "?"} ${JSON.stringify(b.arguments ?? {})}`;
				case "image":
					return "[image]";
				default:
					return "";
			}
		})
		.filter(Boolean)
		.join(" ");
}

export type Composition = Record<ContextRole, number>;

/**
 * Состав контекста по ролям. С promptTokens — в токенах (символы масштабируются
 * к реальному промпту запроса), без — грубо chars/4.
 */
export function composition(parts: readonly ContextPart[], promptTokens?: number): Composition {
	const out = Object.fromEntries(CONTEXT_ROLES.map((r) => [r, 0])) as Composition;
	let total = 0;
	for (const p of parts) {
		out[p.role] += p.chars;
		total += p.chars;
	}
	const scale = promptTokens && total > 0 ? promptTokens / total : 1 / 4;
	for (const r of CONTEXT_ROLES) out[r] = Math.round(out[r] * scale);
	return out;
}

export interface ContextDiff {
	/** Общий префикс (части совпали по записи и содержимому) — то, что мог переиспользовать кэш. */
	prefix: number;
	kept: number;
	added: ContextPart[];
	removed: ContextPart[];
	/** Те же записи с другим содержимым (context_edit, патч system). */
	changed: ContextPart[];
}

const partKey = (p: ContextPart) => `${p.entryId}/${p.role}`;
const partSig = (p: ContextPart) => `${p.chars}:${p.edited}:${p.text}`;

/** Дифф двух проекций по исходным записям: что пришло, ушло и изменилось. */
export function diffContext(prev: readonly ContextPart[], curr: readonly ContextPart[]): ContextDiff {
	let prefix = 0;
	while (
		prefix < prev.length &&
		prefix < curr.length &&
		partKey(prev[prefix]!) === partKey(curr[prefix]!) &&
		partSig(prev[prefix]!) === partSig(curr[prefix]!)
	)
		prefix++;
	const before = new Map(prev.map((p) => [partKey(p), p]));
	const after = new Set(curr.map(partKey));
	const added: ContextPart[] = [];
	const changed: ContextPart[] = [];
	let kept = 0;
	for (const p of curr) {
		const old = before.get(partKey(p));
		if (!old) added.push(p);
		else if (partSig(old) !== partSig(p)) changed.push(p);
		else kept++;
	}
	const removed = prev.filter((p) => !after.has(partKey(p)));
	return { prefix, kept, added, removed, changed };
}
