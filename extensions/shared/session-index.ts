/**
 * Shared persistent session index: one parse pass per changed file feeds BOTH
 * consumers — recall's searchable units and ledger's per-file aggregates.
 *
 * Cache: a single JSON at (consumer-chosen path, typically
 * `~/.pi/agent/cache/session-index.json`). Records are keyed by absolute file
 * path with mtime+size change detection; a version mismatch or corrupt file
 * triggers a full rebuild. Atomic writes (unique tmp + rename); concurrent
 * writers remain last-writer-wins — the cache is rebuildable by design.
 *
 * Canonical types (Unit, Stats, SessionSummary, ...) live HERE; ledger.ts and
 * search.ts re-export them for backwards compatibility.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { addUsage, discoverSessionFiles } from "./sessions.ts";

// ── Canonical types ──

export type UnitRole = "user" | "assistant" | "tool" | "custom" | "summary";

export interface Unit {
	file: string;
	sessionId: string;
	sessionName?: string;
	project: string;
	cwd: string;
	entryId: string;
	role: UnitRole;
	/** Имя инструмента для role === "tool". */
	tool?: string;
	timestamp: number;
	text: string;
}

export interface Stats {
	sessions: number;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	toolCalls: number;
	toolErrors: number;
	compactions: number;
	branchSummaries: number;
	errors: number;
	aborted: number;
}

export interface ToolStats {
	calls: number;
	errors: number;
}

export interface SessionSummary {
	file: string;
	id: string;
	cwd: string;
	project: string;
	name?: string;
	firstPrompt?: string;
	startedAt: number;
	endedAt: number;
	userMessages: number;
	stats: Stats;
	byModel: Record<string, Stats>;
	byDay: Record<string, Stats>;
	byTool: Record<string, ToolStats>;
}

export function emptyStats(): Stats {
	return {
		sessions: 0,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		toolCalls: 0,
		toolErrors: 0,
		compactions: 0,
		branchSummaries: 0,
		errors: 0,
		aborted: 0,
	};
}

// ── Shared low-level helpers (canonical — ledger/recall re-export or consume) ──

interface RawEntry {
	type?: string;
	id?: string;
	timestamp?: string | number;
	cwd?: string;
	name?: string;
	summary?: string;
	message?: {
		role?: string;
		content?: unknown;
		provider?: string;
		model?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
		stopReason?: string;
		toolName?: string;
		customType?: string;
		isError?: boolean;
		timestamp?: number;
		toolCallId?: string;
	};
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

function toMs(timestamp: string | number | undefined): number {
	if (typeof timestamp === "number") return timestamp;
	if (typeof timestamp === "string") {
		const ms = Date.parse(timestamp);
		return Number.isFinite(ms) ? ms : 0;
	}
	return 0;
}

export function dayOf(ms: number): string {
	if (!ms) return "unknown";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function projectName(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.split("/").filter(Boolean).at(-1) ?? normalized ?? "?";
}

function preview(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/** Текст юнита для поиска: блоки text склеены переводом строки (как в recall). */
function textOfJoined(content: unknown): string {
	if (typeof content === "string") return content.trim();
	return blocksOf(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => (b.text as string).trim())
		.filter(Boolean)
		.join("\n");
}

/** Плоский текст для firstPrompt: блоки text через пробел (как в ledger). */
function textOfSpaced(content: unknown): string {
	if (typeof content === "string") return content;
	return blocksOf(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

/** Текст ответа ассистента с инструментальными вызовами — как их видит поиск. */
function assistantTextWithCalls(content: unknown): string {
	const parts: string[] = [];
	for (const block of blocksOf(content)) {
		if (block.type === "text" && typeof block.text === "string") parts.push((block.text as string).trim());
		else if (block.type === "toolCall") parts.push(`→ ${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`);
	}
	return parts.filter(Boolean).join("\n");
}

// ── Unified single-pass parser ──

/**
 * Один обход записей кормит оба представления: SessionSummary (агрегаты
 * ledger) и Unit[] (поиск recall). Возвращает undefined, если первый
 * значимый вход — не заголовок сессии (не парсим «мусорные» файлы).
 */
export function parseSessionCombined(text: string, file: string): { summary: SessionSummary; units: Unit[] } | undefined {
	let header: RawEntry | undefined;
	const summary: SessionSummary = {
		file,
		id: "",
		cwd: "",
		project: "",
		startedAt: 0,
		endedAt: 0,
		userMessages: 0,
		stats: emptyStats(),
		byModel: {},
		byDay: {},
		byTool: {},
	};
	summary.stats.sessions = 1;
	const toolNameByCallId = new Map<string, string>();
	const units: Unit[] = [];
	let sessionId = "";
	let sessionName: string | undefined;

	const pushUnit = (entry: RawEntry, role: UnitRole, text: string, tool?: string): void => {
		units.push({
			file,
			sessionId,
			project: summary.project,
			cwd: summary.cwd,
			entryId: entry.id ?? "",
			timestamp: toMs(entry.timestamp),
			role,
			text,
			...(tool ? { tool } : {}),
		});
	};

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: RawEntry;
		try {
			entry = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		if (!header) {
			if (entry.type !== "session") return undefined;
			header = entry;
			sessionId = entry.id ?? "";
			summary.id = sessionId;
			summary.cwd = entry.cwd ?? "";
			summary.project = projectName(summary.cwd);
			summary.startedAt = toMs(entry.timestamp);
			summary.endedAt = summary.startedAt;
			continue;
		}

		const at = toMs(entry.timestamp);
		if (at > summary.endedAt) summary.endedAt = at;

		if (entry.type === "session_info") {
			sessionName = entry.name || undefined;
			summary.name = sessionName;
			continue;
		}

		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// Расход суммаризации относим к текущей модели сессии, иначе строки
			// разреза по моделям не сходятся с итогом.
			const lastModel = Object.keys(summary.byModel).at(-1);
			const targets = [summary.stats, bump(summary.byDay, dayOf(at)), ...(lastModel ? [summary.byModel[lastModel]] : [])];
			const usage = entry.usage;
			for (const t of targets) {
				if (entry.type === "branch_summary") t.branchSummaries += 1;
				else t.compactions += 1;
				if (usage) addUsage(t, usage);
			}
			if (entry.summary) pushUnit(entry, "summary", entry.summary);
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;

		if (message.role === "user") {
			summary.userMessages += 1;
			const joined = textOfJoined(message.content);
			if (joined) pushUnit(entry, "user", joined);
			if (!summary.firstPrompt) summary.firstPrompt = preview(textOfSpaced(message.content));
			continue;
		}

		if (message.role === "assistant") {
			const modelKey = `${message.provider ?? "?"}/${message.model ?? "?"}`;
			const day = dayOf(at);
			const usage = message.usage;
			const targets = [summary.stats, bump(summary.byModel, modelKey), bump(summary.byDay, day)];
			for (const t of targets) {
				t.turns += 1;
				addUsage(t, usage);
				if (message.stopReason === "error") t.errors += 1;
				if (message.stopReason === "aborted") t.aborted += 1;
			}
			for (const block of blocksOf(message.content)) {
				if (block.type === "toolCall" && typeof block.name === "string") {
					toolNameByCallId.set(String(block.id), block.name);
				}
			}
			const text = assistantTextWithCalls(message.content);
			if (text) pushUnit(entry, "assistant", text);
			continue;
		}

		if (message.role === "toolResult") {
			const name = message.toolName ?? toolNameByCallId.get(String(message.toolCallId ?? "")) ?? "?";
			if (!summary.byTool[name]) summary.byTool[name] = { calls: 0, errors: 0 };
			const tool = summary.byTool[name];
			tool.calls += 1;
			const isError = message.isError === true;
			if (isError) tool.errors += 1;
			for (const t of [summary.stats, bump(summary.byDay, dayOf(at))]) {
				t.toolCalls += 1;
				if (isError) t.toolErrors += 1;
			}
			// Ошибки инструментов относим к модели, которая их вызвала: последней по времени.
			const lastModel = Object.keys(summary.byModel).at(-1);
			if (lastModel) {
				summary.byModel[lastModel].toolCalls += 1;
				summary.byModel[lastModel].toolErrors += isError ? 1 : 0;
			}
			const text = textOfJoined(message.content);
			if (text) pushUnit(entry, "tool", text, name);
			continue;
		}

		if (message.role === "custom") {
			const text = textOfJoined(message.content);
			if (text) pushUnit(entry, "custom", text, message.customType);
		}
	}

	if (!header) return undefined;
	for (const stats of [...Object.values(summary.byModel), ...Object.values(summary.byDay)]) stats.sessions = 1;
	if (sessionName) for (const u of units) u.sessionName = sessionName;
	return { summary, units };
}

function bump<T extends Stats>(group: Record<string, T>, key: string): T {
	if (!group[key]) group[key] = emptyStats() as T;
	return group[key];
}

// ── Persistent cache ──

/** Текст юнита в кэше обрезается: поиск работает по началу, полный текст — в самом jsonl. */
export const UNIT_TEXT_CACHE_CAP = 4 * 1024;
const INDEX_VERSION = 1;

export interface SessionFileRecord {
	mtimeMs: number;
	size: number;
	/** null — файл без заголовка сессии (не парсится). */
	summary: SessionSummary | null;
	units: Unit[];
}

export interface SessionIndexData {
	version: number;
	files: Record<string, SessionFileRecord>;
}

export function loadIndex(path: string): SessionIndexData {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionIndexData;
		if (parsed && parsed.version === INDEX_VERSION && parsed.files && typeof parsed.files === "object") return parsed;
	} catch {
		// Missing or corrupt — full rebuild.
	}
	return { version: INDEX_VERSION, files: {} };
}

export function saveIndex(path: string, data: SessionIndexData): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(data));
			renameSync(tmp, path);
		} finally {
			try {
				unlinkSync(tmp);
			} catch {
				// Renamed away — nothing to clean.
			}
		}
	} catch {
		// Кэш не обязан сохраняться — следующий запуск пересоберёт.
	}
}

export interface RefreshResult {
	changed: number;
	files: number;
	units: number;
}

/**
 * Инкрементальное обновление: перечитывает только новые/изменившиеся файлы
 * (mtime+size), удаляет пропавшие, возвращает суммарное число юнитов.
 */
export function refreshSharedIndex(
	root: string,
	data: SessionIndexData,
	options: { exclude?: string } = {},
): RefreshResult {
	const files = discoverSessionFiles(root).filter((f) => !options.exclude || f !== options.exclude);
	const seen = new Set(files);
	for (const key of Object.keys(data.files)) if (!seen.has(key)) delete data.files[key];

	let changed = 0;
	for (const file of files) {
		let mtimeMs = 0;
		let size = 0;
		try {
			const st = statSync(file);
			mtimeMs = st.mtimeMs;
			size = st.size;
		} catch {
			continue;
		}
		const cached = data.files[file];
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) continue;
		try {
			const parsed = parseSessionCombined(readFileSync(file, "utf8"), file);
			if (!parsed) {
				delete data.files[file];
				continue;
			}
			data.files[file] = {
				mtimeMs,
				size,
				summary: parsed.summary,
				units: parsed.units.map((u) => ({ ...u, text: u.text.length > UNIT_TEXT_CACHE_CAP ? `${u.text.slice(0, UNIT_TEXT_CACHE_CAP)}…` : u.text })),
			};
			changed += 1;
		} catch {
			delete data.files[file];
		}
	}
	const units = Object.values(data.files).reduce((n, r) => n + r.units.length, 0);
	return { changed, files: files.length, units };
}

/** Проверка существования — удобство для потребителей до refresh. */
export function indexExists(path: string): boolean {
	return existsSync(path);
}
