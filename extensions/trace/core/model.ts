/**
 * Модель сессии для видов trace — свёртка дерева (SessionTree) в эры, ходы,
 * маркеры и брошенные ветки. Активный путь — от листа к корню; эра начинается
 * с user-сообщения на пути. Ветка — поддерево, отходящее от записи пути
 * (точка ⑂), показывается по своему самому позднему листу.
 *
 * Итоги токенов и стоимости — по всему файлу, как session totals в pi:
 * брошенные ветки, usage-записи, суммаризация компакций и веток тоже оплачены.
 *
 * Чистый модуль: без Node/DOM API (его же грузит веб-вьюер).
 */
import { contentText, entryEndMs, entryMs, oneLine } from "./text.ts";
import type { Entry, SessionTree } from "./tree.ts";

export interface Tokens {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

export interface Tool {
	callId: string;
	name: string;
	label: string;
	status: "running" | "ok" | "error";
	/** Старт — конец стрима хода: инструмент запускается после генерации. */
	startMs: number;
	endMs?: number;
}

export interface Turn {
	/** Сквозной номер хода на пути (T1…); в ветке продолжает нумерацию от точки ветвления. */
	index: number;
	entryId: string;
	/** Начало генерации (message.timestamp). */
	startMs: number;
	/** Конец генерации (entry.timestamp: запись по message_end). */
	endMs: number;
	model?: string;
	tokens: Tokens;
	cost: number;
	text?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	tools: Tool[];
}

export type MarkerKind = "compaction" | "branch" | "label" | "model" | "thinking" | "edit";

export interface Marker {
	kind: MarkerKind;
	entryId: string;
	ts: number;
	text: string;
}

/** Связка с сессией субагента (custom trace:subagents). */
export interface ChildLink {
	entryId: string;
	ts: number;
	agent: string;
	task: string;
	session: string;
	model?: string;
	tokensOut?: number;
	cost?: number;
}

export interface Era {
	/** 1…; эра 0 — ходы до первого промпта (если были). */
	index: number;
	promptId: string | null;
	prompt: string;
	startMs: number;
	endMs: number;
	turns: Turn[];
	markers: Marker[];
	children: ChildLink[];
	cost: number;
	tokensOut: number;
	/** Инструменты с ошибкой и ходы с stopReason error. */
	errors: number;
}

export interface Branch {
	/** Запись активного пути, от которой ушла ветка; null — отдельный корень. */
	forkId: string | null;
	/** Номер последнего хода пути до точки ветвления (0 — до первого хода). */
	forkTurn: number;
	leafId: string;
	eras: Era[];
	/** Текст branch_summary, которым pi подытожил эту ветку при уходе с неё. */
	summary?: string;
	startMs: number;
	endMs: number;
	cost: number;
}

export interface TimeBreakdown {
	/** От первой до последней записи пути. */
	spanMs: number;
	/** Сумма генераций ходов. */
	modelMs: number;
	/** Объединение интервалов инструментов (параллельные не суммируются дважды). */
	toolsMs: number;
	/** Остаток: ожидание пользователя и прочее. */
	idleMs: number;
}

export interface Totals extends Tokens {
	cost: number;
}

export interface SessionView {
	name?: string;
	cwd?: string;
	leafId: string | null;
	eras: Era[];
	turns: Turn[];
	markers: Marker[];
	children: ChildLink[];
	branches: Branch[];
	/** По всему файлу (включая ветки и служебные usage). */
	totals: Totals;
	/** По моделям активного пути. */
	models: Map<string, { turns: number; output: number; cost: number }>;
	time: TimeBreakdown;
	/** Агент работает: последняя запись пути ждёт модель или инструмент ещё идёт. */
	running: boolean;
}

/** Промпт-токены запроса: весь вход модели, включая кэш. */
export function promptTokens(t: Tokens): number {
	return t.input + t.cacheRead + t.cacheWrite;
}

/** Cache hit хода: cacheRead / промпт; null — провайдер не репортит кэш. */
export function cacheHit(t: Tokens): number | null {
	const prompt = promptTokens(t);
	return (t.cacheRead > 0 || t.cacheWrite > 0) && prompt > 0 ? t.cacheRead / prompt : null;
}

function tokensOf(u: any): Tokens {
	return { input: u?.input ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0, output: u?.output ?? 0 };
}

/** Сводка аргументов вызова для чипа: агент и задача, путь, команда, запрос… */
export function toolLabel(args: any): string {
	const a = args ?? {};
	if (typeof a.agent === "string" && a.agent && a.task) return oneLine(`${a.agent}: ${a.task}`, 60);
	for (const k of ["path", "file_path", "command", "query", "url"]) {
		if (typeof a[k] === "string" && a[k]) return oneLine(a[k], k === "command" ? 48 : 42);
	}
	try {
		return oneLine(JSON.stringify(a), 42);
	} catch {
		return "";
	}
}

/** Самые поздние метки по целям (по всему файлу, как labelsById в pi); пустая метка — снята. */
function labelsOf(tree: SessionTree): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of tree.entries) {
		if (e.type !== "label" || typeof e.targetId !== "string") continue;
		if (e.label) out.set(e.targetId, oneLine(e.label, 60));
		else out.delete(e.targetId);
	}
	return out;
}

interface Fold {
	eras: Era[];
	turns: Turn[];
	markers: Marker[];
	children: ChildLink[];
}

/** Свёртка отрезка пути в эры; turnBase — номер хода перед отрезком. */
function foldPath(path: readonly Entry[], labels: Map<string, string>, turnBase: number): Fold {
	const out: Fold = { eras: [], turns: [], markers: [], children: [] };
	const calls = new Map<string, Tool>();
	let era: Era | undefined;
	let turnNo = turnBase;

	const open = (index: number, promptId: string | null, prompt: string, ts: number): Era => {
		era = {
			index,
			promptId,
			prompt,
			startMs: ts,
			endMs: ts,
			turns: [],
			markers: [],
			children: [],
			cost: 0,
			tokensOut: 0,
			errors: 0,
		};
		out.eras.push(era);
		return era;
	};
	const current = (ts: number) => era ?? open(0, null, "", ts);
	// Маркеры до первого промпта (смена модели, thinking) эру 0 не открывают —
	// она только для ходов без промпта.
	const mark = (kind: MarkerKind, e: Entry, ts: number, text: string) => {
		const m: Marker = { kind, entryId: e.id!, ts, text };
		out.markers.push(m);
		era?.markers.push(m);
	};

	for (const e of path) {
		const ts = entryMs(e);
		if (era && ts > era.endMs) era.endMs = ts;
		const label = labels.get(e.id!);
		switch (e.type) {
			case "message": {
				const m = e.message ?? {};
				if (m.role === "user") {
					open((era?.index ?? 0) + 1, e.id!, oneLine(contentText(m.content), 200), ts);
				} else if (m.role === "assistant") {
					const endMs = entryEndMs(e, ts);
					const turn: Turn = {
						index: ++turnNo,
						entryId: e.id!,
						startMs: ts,
						endMs,
						model: m.model,
						tokens: tokensOf(m.usage),
						cost: m.usage?.cost?.total ?? 0,
						stopReason: m.stopReason,
						errorMessage: m.errorMessage,
						tools: [],
					};
					for (const b of Array.isArray(m.content) ? m.content : []) {
						if (b?.type === "toolCall" && b.id) {
							const tool: Tool = {
								callId: b.id,
								name: b.name ?? "?",
								label: toolLabel(b.arguments),
								status: "running",
								startMs: endMs,
							};
							turn.tools.push(tool);
							calls.set(b.id, tool);
						} else if (b?.type === "thinking" && !turn.thinking) turn.thinking = oneLine(b.thinking, 200);
						else if (b?.type === "text" && !turn.text && b.text) turn.text = oneLine(b.text, 200);
					}
					const host = current(ts);
					host.turns.push(turn);
					host.cost += turn.cost;
					host.tokensOut += turn.tokens.output;
					if (turn.stopReason === "error") host.errors++;
					if (endMs > host.endMs) host.endMs = endMs;
					out.turns.push(turn);
				} else if (m.role === "toolResult") {
					const tool = calls.get(m.toolCallId);
					if (tool) {
						tool.status = m.isError ? "error" : "ok";
						tool.endMs = ts;
						if (m.isError) current(ts).errors++;
					}
				}
				break;
			}
			case "compaction":
				mark("compaction", e, ts, e.tokensBefore ? `компакция · ${e.tokensBefore} tok` : "компакция");
				break;
			case "branch_summary":
				mark("branch", e, ts, oneLine(e.summary ?? "", 200));
				break;
			case "model_change":
				mark("model", e, ts, `${e.provider}/${e.modelId}`);
				break;
			case "thinking_level_change":
				mark("thinking", e, ts, String(e.thinkingLevel));
				break;
			case "context_edit":
				mark("edit", e, ts, `${oneLine(e.targetId ?? "?", 12)} ${e.replacement == null ? "убрана" : "заменена"}`);
				break;
			case "custom":
				if ((e.customType === "trace:subagents" || e.customType === "pitrace:subagents") && e.data?.session) {
					const d = e.data;
					const link: ChildLink = {
						entryId: e.id!,
						ts,
						agent: String(d.agent ?? "?"),
						task: oneLine(d.task ?? "", 200),
						session: String(d.session),
						model: d.model,
						tokensOut: d.usage?.output,
						cost: d.usage?.cost,
					};
					out.children.push(link);
					current(ts).children.push(link);
				}
				break;
			default:
				break;
		}
		if (label) mark("label", e, ts, label);
	}
	return out;
}

/** Usage записи, оплаченный в сессии (pi session totals). */
function entryUsage(e: Entry): any {
	if (e.type === "message") {
		const m = e.message ?? {};
		return m.role === "assistant" || m.role === "toolResult" ? m.usage : undefined;
	}
	return e.type === "usage" || e.type === "compaction" || e.type === "branch_summary" ? e.usage : undefined;
}

function unionMs(intervals: [number, number][]): number {
	intervals.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let end = -Infinity;
	for (const [s, e] of intervals) {
		if (e <= end) continue;
		total += e - Math.max(s, end);
		end = e;
	}
	return total;
}

/**
 * Модель сессии на листе leafId. nowMs — для идущих инструментов в разбивке
 * времени (без него идущий инструмент не учитывается).
 */
export function deriveSession(tree: SessionTree, leafId: string | null = tree.leafId, nowMs?: number): SessionView {
	const labels = labelsOf(tree);
	const path = tree.path(leafId);
	const onPath = new Set(path.map((e) => e.id!));
	const main = foldPath(path, labels, 0);

	const totals: Totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
	let name: string | undefined;
	const summaries = new Map<string, string>();
	for (const e of tree.entries) {
		const u = entryUsage(e);
		if (u) {
			const t = tokensOf(u);
			totals.input += t.input;
			totals.cacheRead += t.cacheRead;
			totals.cacheWrite += t.cacheWrite;
			totals.output += t.output;
			totals.cost += u.cost?.total ?? 0;
		}
		if (e.type === "session_info" && e.name) name = String(e.name);
		if (e.type === "branch_summary" && typeof e.fromId === "string" && e.summary) summaries.set(e.fromId, e.summary);
	}

	// Ветки: дети записей пути (и корни), не лежащие на пути.
	const turnAt = new Map<string, number>();
	let n = 0;
	for (const e of path) {
		if (e.type === "message" && e.message?.role === "assistant") n++;
		turnAt.set(e.id!, n);
	}
	const branches: Branch[] = [];
	for (const fork of [null, ...path.map((e) => e.id!)]) {
		for (const child of tree.children(fork)) {
			if (onPath.has(child.id!)) continue;
			const leaf = tree.latestIn(child.id!)!;
			const segment = tree.path(leaf.id!).filter((e) => !onPath.has(e.id!));
			const forkTurn = fork === null ? 0 : (turnAt.get(fork) ?? 0);
			const f = foldPath(segment, labels, forkTurn);
			const ids = new Set(segment.map((e) => e.id!));
			const summary = [...summaries].find(([from]) => ids.has(from))?.[1];
			branches.push({
				forkId: fork,
				forkTurn,
				leafId: leaf.id!,
				eras: f.eras,
				summary: summary ? oneLine(summary, 200) : undefined,
				startMs: entryMs(segment[0]),
				endMs: Math.max(...segment.map((e) => entryEndMs(e, entryMs(e)))),
				cost: f.eras.reduce((s, e) => s + e.cost, 0),
			});
		}
	}

	const models = new Map<string, { turns: number; output: number; cost: number }>();
	const toolSpans: [number, number][] = [];
	let modelMs = 0;
	for (const t of main.turns) {
		const agg = models.get(t.model || "?") ?? { turns: 0, output: 0, cost: 0 };
		agg.turns++;
		agg.output += t.tokens.output;
		agg.cost += t.cost;
		models.set(t.model || "?", agg);
		modelMs += Math.max(0, t.endMs - t.startMs);
		for (const tool of t.tools) {
			const end = tool.endMs ?? nowMs;
			if (end !== undefined && end > tool.startMs) toolSpans.push([tool.startMs, end]);
		}
	}
	const firstMs = path.length > 0 ? entryMs(path[0]) : 0;
	const lastMs = path.reduce((m, e) => Math.max(m, entryEndMs(e, entryMs(e))), firstMs);
	const spanMs = Math.max(0, lastMs - firstMs);
	const toolsMs = unionMs(toolSpans);

	const last = path.at(-1);
	const lastRole = last?.type === "message" ? last.message?.role : undefined;
	const running =
		lastRole === "user" ||
		lastRole === "toolResult" ||
		main.turns.at(-1)?.tools.some((t) => t.status === "running") === true;

	return {
		name,
		cwd: tree.header?.cwd,
		leafId,
		eras: main.eras,
		turns: main.turns,
		markers: main.markers,
		children: main.children,
		branches,
		totals,
		models,
		time: { spanMs, modelMs, toolsMs, idleMs: Math.max(0, spanMs - modelMs - toolsMs) },
		running,
	};
}
