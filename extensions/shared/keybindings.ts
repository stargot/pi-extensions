/**
 * Единый реестр клавиш ext.* для оверлеев расширений (B7).
 *
 * Session-менеджер из ctx.ui.custom знает только встроенные tui.* и app.* action'ы —
 * дополнить его definitions нельзя (приватные поля, API нет), а keyText/keyHint
 * на кастомных id читают глобальный менеджер и вернут "". Поэтому схема такая:
 *  1) типы — declaration merging `interface Keybindings` (канон pi: core/keybindings.d.ts);
 *  2) runtime — СВОЙ KeybindingsManager с нашими definitions и дефолтами = текущим
 *     литералам кода; компоненты берут его из ленивого синглтона getExtKeybindings();
 *  3) пользовательские переопределения — <agentDir>/keybindings.json (формат pi:
 *     `"ext.report.close": "x"` или `["x","y"]`, `[]` = отключить). Глобальный
 *     менеджер ext.* id из этого файла молча скипает, поэтому читаем файл сами
 *     и передаём как userBindings. Отсутствие/битый JSON → {} без ошибок.
 *
 * Guard-фоллбэк: matchAction() при пустом getKeys(id) (например, действие отключено
 * через `[]`) срабатывает на дефолты из definitions — оверлеи остаются управляемыми.
 * Хелперы pi keyText/keyHint не используем — рендер клавиш свой (getKeys().join("/"),
 * конвенция pi), красит переданный в компонент theme.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Keybinding,
	KeybindingsManager,
	type KeybindingDefinition,
	type KeybindingsConfig,
	type KeyId,
	matchesKey,
} from "@earendil-works/pi-tui";

// Типы action'ов расширений: после merging id вида ext.* участвуют в
// Keybinding = keyof Keybindings, поэтому kb.getKeys("ext.report.close")
// типобезопасно (проверяет tsc), а опечатка в id — ошибка компиляции.
declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"ext.report.refresh": true;
		"ext.report.close": true;
		"ext.recall.close": true;
		"ext.trace.filter": true;
		"ext.trace.errors": true;
		"ext.trace.models": true;
		"ext.trace.diff": true;
		"ext.trace.jumpMatch": true;
		"ext.trace.follow": true;
		"ext.trace.close": true;
		"ext.trace.pause": true;
		"ext.trace.faster": true;
		"ext.trace.slower": true;
		"ext.trace.seekBack": true;
		"ext.trace.seekForward": true;
		"ext.trace.live": true;
		"ext.trace.restart": true;
	}
}

/** Только ext.* action'ы — Record по ним гарантирует: id из merging не останется без definition. */
export type ExtAction = Extract<Keybinding, `ext.${string}`>;

/**
 * Definitions: дефолты = литералы, зашитые в коде до B7 (сверены grep'ом).
 * Ctrl+C/прерывание сознательно не заведено как action — остаётся литералом.
 */
export const EXT_KEYBINDINGS: Record<ExtAction, KeybindingDefinition> = {
	// shared/scroll-report.ts
	"ext.report.refresh": { defaultKeys: "r", description: "Refresh report" },
	"ext.report.close": { defaultKeys: ["q", "escape"], description: "Close report" },
	// session-recall/view.ts
	"ext.recall.close": { defaultKeys: ["q", "escape"], description: "Close results" },
	// session-trace/graph.ts — лента
	"ext.trace.filter": { defaultKeys: "/", description: "Filter feed" },
	"ext.trace.errors": { defaultKeys: "e", description: "Toggle errors-only" },
	"ext.trace.models": { defaultKeys: "m", description: "Model summary" },
	"ext.trace.diff": { defaultKeys: "d", description: "Context diff" },
	"ext.trace.jumpMatch": { defaultKeys: ["n", "shift+n"], description: "Jump to match" },
	"ext.trace.follow": { defaultKeys: "f", description: "Follow tail" },
	"ext.trace.close": { defaultKeys: "q", description: "Close trace" },
	// session-trace/graph.ts — replay
	"ext.trace.pause": { defaultKeys: "space", description: "Pause/resume replay" },
	"ext.trace.faster": { defaultKeys: ["+", "="], description: "Replay faster" },
	"ext.trace.slower": { defaultKeys: ["-", "_"], description: "Replay slower" },
	"ext.trace.seekBack": { defaultKeys: "left", description: "Seek back 5s" },
	"ext.trace.seekForward": { defaultKeys: "right", description: "Seek forward 5s" },
	"ext.trace.live": { defaultKeys: "l", description: "Jump to live edge" },
	"ext.trace.restart": { defaultKeys: "r", description: "Restart replay" },
};

/**
 * Чистый разбор содержимого keybindings.json: битый/отсутствующий JSON → {},
 * форма значений валидируется (string | string[] | undefined), не-ext.* ключи
 * отфильтровываются — глобальный менеджер их всё равно бы скипнул.
 */
export function parseUserBindings(raw: string | undefined): KeybindingsConfig {
	if (raw === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const out: KeybindingsConfig = {};
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!id.startsWith("ext.")) continue;
		if (typeof value === "string") {
			out[id] = value as KeyId;
		} else if (Array.isArray(value) && value.every((k) => typeof k === "string")) {
			out[id] = value as KeyId[];
		}
		// числа/объекты/null и массивы с не-строками — молча пропускаем (форма pi)
	}
	return out;
}

/** Чтение <agentDir>/keybindings.json: отсутствие файла или каталога → undefined-путь → {}. */
export function loadUserBindings(agentDir: string = getAgentDir()): KeybindingsConfig {
	let raw: string | undefined;
	try {
		raw = readFileSync(join(agentDir, "keybindings.json"), "utf8");
	} catch {
		return {};
	}
	return parseUserBindings(raw);
}

let singleton: KeybindingsManager | undefined;

/** Ленивый синглтон: наши definitions + пользовательские переопределения из agent dir. */
export function getExtKeybindings(): KeybindingsManager {
	singleton ??= new KeybindingsManager(EXT_KEYBINDINGS, loadUserBindings());
	return singleton;
}

/** Дефолты id из definitions; незнакомый id дефолтов не имеет → []. */
function defaultKeysFor(id: Keybinding): KeyId[] {
	const def = (EXT_KEYBINDINGS as Partial<Record<Keybinding, KeybindingDefinition>>)[id];
	return def ? toKeyIds(def.defaultKeys) : [];
}

/**
 * Единый путь резолва клавиш действия: getKeys менеджера, при пустом списке —
 * дефолты из definitions (отключённый `[]`-биндинг уводит на дефолты; у
 * незнакомого менеджеру id дефолтов нет → []).
 */
export function resolveKeys(kb: KeybindingsManager, id: Keybinding): KeyId[] {
	const keys = kb.getKeys(id);
	return keys.length > 0 ? keys : defaultKeysFor(id);
}

/**
 * Конкретный совпавший ключ из резолвнутого списка resolveKeys — например, для
 * направления jumpMatch (индекс ключа, а не регистр data); undefined — не совпало.
 */
export function matchActionKey(kb: KeybindingsManager, data: string, id: Keybinding): KeyId | undefined {
	return resolveKeys(kb, id).find((key) => matchesKey(data, key));
}

/**
 * Единая формула направления jumpMatch: индекс совпавшего ключа в resolveKeys
 * (один резолв, один проход), -1 — не совпало. Одна клавиша — индекс 0 — «вперёд»,
 * вторая и далее — «назад». Одно-клавишное переопределение (["j"]) даёт всегда
 * индекс 0 → направление всегда «вперёд» — осознанный компромисс.
 */
export function matchActionIndex(kb: KeybindingsManager, data: string, id: Keybinding): number {
	return resolveKeys(kb, id).findIndex((key) => matchesKey(data, key));
}

/**
 * Проверка клавиши с guard-фоллбэком: пока действие известно менеджеру — матчится
 * через него (пользовательские переопределения и отключение работают), при пустом
 * getKeys (незнакомый менеджеру id или `[]` в конфиге) — на дефолты из definitions.
 */
export function matchAction(kb: KeybindingsManager, data: string, id: Keybinding): boolean {
	return matchActionKey(kb, data, id) !== undefined;
}

/**
 * Человекочитаемый рендер клавиш действия: "q/escape" или "q/escape: Close".
 * Пустые keys (действие отключено) → дефолт из definitions — дефолты всё равно
 * срабатывают через guard-фоллбэк matchAction, подсказка должна им соответствовать.
 */
export function actionHint(kb: KeybindingsManager, id: ExtAction, description?: string): string {
	const base = resolveKeys(kb, id).join("/");
	return description ? `${base}: ${description}` : base;
}

function toKeyIds(defaultKeys: KeyId | KeyId[]): KeyId[] {
	return Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys];
}
