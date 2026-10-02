/**
 * Контраст-аудит цветовых пар расширений (автоматизация пунктов R5/R9 из backlog.md).
 *
 * Каталог CONTRAST_PAIRS — только пары, реально встречающиеся в нашем коде (источник
 * в поле source). Модуль ничего не рендерит и не меняет настроек: загружает реальные
 * темы pi 1.0.0 (dark, light — из dist; system — сгенерированная generateSystemThemeColors
 * из опорных цветов терминала, отдельно для тёмного и светлого облика) и считает
 * WCAG 2 контраст по формуле самого pi (wcagContrast из system-theme.js).
 *
 * fg-only пары (виджеты в транскрипте) считаются на дефолтном фоне терминала —
 * те же допущения, что GUESSED_DEFAULT_COLORS в theme.js pi: #000000 для dark,
 * #ffffff для light. System-тема в pi выводится из палитры живого терминала;
 * здесь она считается для обеих опорных точек (чёрный/белый фон) — это и есть
 * договорённость R5: «для system-темы — обе опорные палитры».
 *
 * Вердикты: fail — ниже 3:1 (порог UI/крупного текста; такие пары чинятся заменой
 * токена), borderline — 3:1…4:1 (UI) / 3:1…4.5:1 (текст), pass — выше. Гейты
 * проверяет тест extensions/shared/test/theme-contrast.test.ts; печатную таблицу
 * даёт scripts/visual-audit.mjs (ручной запуск, в npm test не входит).
 */
import { Theme } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
// Глубокие импорты в dist pi: публичный экспорт пакета не отдаёт loadThemeFromPath
// и generateSystemThemeColors, а считать контраст нужно именно их цветами.
import {
	generateSystemThemeColors,
	wcagContrast,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/system-theme.js";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

/** Токены ThemeBg pi 1.0.0 — для разбора системной темы на fg/bg-слоты. */
const BACKGROUND_TOKENS = new Set([
	"selectedBg",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

/** Опорные цвета терминала — допущения самого pi (GUESSED_DEFAULT_COLORS в theme.js). */
const REFERENCE_TERMINAL = {
	dark: { foreground: { r: 229, g: 229, b: 231 }, background: { r: 0, g: 0, b: 0 } },
	light: { foreground: { r: 0, g: 0, b: 0 }, background: { r: 255, g: 255, b: 255 } },
} as const;

export type Appearance = "dark" | "light";

/** Тема аудита: имя, облик (какой фон считаем «терминалом») и живой Theme-объект. */
export interface AuditTheme {
	name: string;
	appearance: Appearance;
	theme: Theme;
}

/** Путь к каталогу тем встроенных тем pi 1.0.0 в node_modules. */
function piThemesDir(): string {
	return fileURLToPath(
		new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/", import.meta.url),
	);
}

/** System-тема из опорных цветов терминала (оба облика). */
function systemTheme(appearance: Appearance): AuditTheme {
	const terminal = REFERENCE_TERMINAL[appearance];
	const generated = generateSystemThemeColors({ ...terminal });
	const fgColors: Record<string, string | number> = {};
	const bgColors: Record<string, string | number> = {};
	for (const [token, value] of Object.entries(generated.colors)) {
		(BACKGROUND_TOKENS.has(token) ? bgColors : fgColors)[token] = value;
	}
	return {
		name: "system",
		appearance,
		theme: new Theme(fgColors as never, bgColors as never, "truecolor", {
			name: "system",
			appearance,
			dim: generated.dim,
		}),
	};
}

/** Темы аудита: dark, light и system (в обоих обликax — тёмном и светлом). */
export function loadAuditThemes(): AuditTheme[] {
	const dir = piThemesDir();
	return [
		{ name: "dark", appearance: "dark", theme: loadThemeFromPath(`${dir}dark.json`) },
		{ name: "light", appearance: "light", theme: loadThemeFromPath(`${dir}light.json`) },
		systemTheme("dark"),
		systemTheme("light"),
	];
}

/**
 * Спецификация пары. kind — порог восприятия: "text" — обычный текст (WCAG AA 4.5:1),
 * "ui" — глифы/чипы/крупное (3:1). Порог ЧИНКИ во всех случаях 3:1 (договорённость R9):
 * всё, что ниже, — явный fail; 3…4(4.5) — спорная зона, только фиксируется.
 */
export interface ContrastPairSpec {
	/** Короткое имя пары для таблицы и тестов. */
	name: string;
	/** Где пара живёт в нашем коде. */
	source: string;
	fg: string;
	/** ThemeBg-токен или "terminal" — дефолтный фон терминала (fg-only пары). */
	bg?: string;
	kind: "text" | "ui";
}

const toolPanelChips: ContrastPairSpec[] = [
	{
		name: "verdictChip running: accent/toolPendingBg",
		source: "subagents/render.ts verdictChip",
		fg: "accent",
		bg: "toolPendingBg",
		kind: "ui",
	},
	{
		name: "verdictChip fail: error/toolErrorBg",
		source: "subagents/render.ts verdictChip",
		fg: "error",
		bg: "toolErrorBg",
		kind: "ui",
	},
	{
		name: "verdictChip warning: warning/toolPendingBg",
		source: "subagents/render.ts verdictChip",
		fg: "warning",
		bg: "toolPendingBg",
		kind: "ui",
	},
	{
		name: "verdictChip ok: success/toolSuccessBg",
		source: "subagents/render.ts verdictChip",
		fg: "success",
		bg: "toolSuccessBg",
		kind: "ui",
	},
	{
		name: "errorLine: error/toolErrorBg",
		source: "subagents/render.ts errorLine",
		fg: "error",
		bg: "toolErrorBg",
		kind: "ui",
	},
	{
		name: "trace badge error: error/toolErrorBg",
		source: "session-trace/graph.ts chip",
		fg: "error",
		bg: "toolErrorBg",
		kind: "ui",
	},
	{
		name: "trace badge running: accent/toolPendingBg",
		source: "session-trace/graph.ts chip",
		fg: "accent",
		bg: "toolPendingBg",
		kind: "ui",
	},
	{
		name: "trace badge ok: toolTitle/toolSuccessBg",
		source: "session-trace/graph.ts chip",
		fg: "toolTitle",
		bg: "toolSuccessBg",
		kind: "ui",
	},
	{
		name: "ledger chip cache-ok: success/toolSuccessBg",
		source: "session-ledger/report.ts",
		fg: "success",
		bg: "toolSuccessBg",
		kind: "ui",
	},
	{
		name: "ledger chip cache-low: warning/toolPendingBg",
		source: "session-ledger/report.ts",
		fg: "warning",
		bg: "toolPendingBg",
		kind: "ui",
	},
	{
		name: "ledger chip errors: error/toolErrorBg",
		source: "session-ledger/report.ts",
		fg: "error",
		bg: "toolErrorBg",
		kind: "ui",
	},
	{
		name: "ledger chip cost: accent/customMessageBg",
		source: "session-ledger/report.ts",
		fg: "accent",
		bg: "customMessageBg",
		kind: "ui",
	},
];

const fgOnlyPairs: ContrastPairSpec[] = [
	{
		name: "quiz dont-know checked [x]: warning",
		source: "quiz/index.ts (I don't know)",
		fg: "warning",
		bg: "terminal",
		kind: "text",
	},
	{
		name: "Submit доступен: success",
		source: "quiz/index.ts, ask-user-question/index.ts",
		fg: "success",
		bg: "terminal",
		kind: "text",
	},
	{
		name: "Submit недоступен: muted",
		source: "quiz/index.ts, ask-user-question/index.ts",
		fg: "muted",
		bg: "terminal",
		kind: "text",
	},
	{
		name: "MAP silhouette E: error",
		source: "session-trace/graph.ts MAP_COLOR",
		fg: "error",
		bg: "terminal",
		kind: "ui",
	},
	{
		name: "MAP silhouette R: accent",
		source: "session-trace/graph.ts MAP_COLOR",
		fg: "accent",
		bg: "terminal",
		kind: "ui",
	},
	{
		name: "MAP silhouette U: userMessageText",
		source: "session-trace/graph.ts MAP_COLOR",
		fg: "userMessageText",
		bg: "terminal",
		kind: "ui",
	},
	{
		name: "MAP silhouette C: toolTitle",
		source: "session-trace/graph.ts MAP_COLOR",
		fg: "toolTitle",
		bg: "terminal",
		kind: "ui",
	},
	{
		name: "MAP silhouette B: muted",
		source: "session-trace/graph.ts MAP_COLOR",
		fg: "muted",
		bg: "terminal",
		kind: "ui",
	},
	// t был dim: на светлой system-теме 2.83:1 (<3) — заменён на muted (фикс R9).
	{
		name: "MAP silhouette t: muted",
		source: "session-trace/graph.ts MAP_COLOR",
		fg: "muted",
		bg: "terminal",
		kind: "ui",
	},
	{
		name: "snippets prepend ↑: accent",
		source: "prompt-snippets/index.ts",
		fg: "accent",
		bg: "terminal",
		kind: "text",
	},
	{
		name: "snippets append ↓: warning",
		source: "prompt-snippets/index.ts",
		fg: "warning",
		bg: "terminal",
		kind: "text",
	},
	{
		name: "recall highlight: warning bold",
		source: "session-recall/view.ts",
		fg: "warning",
		bg: "terminal",
		kind: "text",
	},
	// help был dim: на светлой system-теме 2.83:1 (<3) — заменён на muted (фикс R9).
	{ name: "report help: muted", source: "shared/scroll-report.ts", fg: "muted", bg: "terminal", kind: "text" },
];

/** Каталог всех проверяемых пар (R5-список backlog.md, плюс чипы ledger/trace на тех же токенах). */
export const CONTRAST_PAIRS: ContrastPairSpec[] = [...toolPanelChips, ...fgOnlyPairs];

export type Verdict = "pass" | "borderline" | "fail";

export interface PairContrastResult {
	theme: string;
	appearance: Appearance;
	/** WCAG 2 контраст, 1…21. */
	ratio: number;
	verdict: Verdict;
}

export interface ContrastRow {
	pair: ContrastPairSpec;
	results: PairContrastResult[];
}

/** Цвет токена с подстановкой дефолта терминала для "" (system-тема может отдать пустую строку). */
function tokenColor(audit: AuditTheme, token: string): { r: number; g: number; b: number } {
	const fallback =
		token === "terminal"
			? REFERENCE_TERMINAL[audit.appearance].background
			: BACKGROUND_TOKENS.has(token)
				? REFERENCE_TERMINAL[audit.appearance].background
				: REFERENCE_TERMINAL[audit.appearance].foreground;
	if (token === "terminal") return fallback;
	const value = (audit.theme.colors as Record<string, { r: number; g: number; b: number } | undefined>)[token];
	if (!value) return fallback;
	// Индекс палитры (число) в системной теме при непойченном терминале: контраст не считаем —
	// сам терминал красит; для аудита подставляем дефолт.
	return typeof value === "number" ? fallback : value;
}

const BORDERLINE_TEXT = 4.5;
const BORDERLINE_UI = 4;
const FAIL = 3;

function verdictOf(kind: "text" | "ui", ratio: number): Verdict {
	if (ratio < FAIL) return "fail";
	return ratio < (kind === "text" ? BORDERLINE_TEXT : BORDERLINE_UI) ? "borderline" : "pass";
}

/** Контраст пары в теме. */
export function pairRatio(audit: AuditTheme, pair: ContrastPairSpec): number {
	return wcagContrast(tokenColor(audit, pair.fg), tokenColor(audit, pair.bg ?? "terminal"));
}

/** Полная таблица: каждая пара во всех темах аудита. */
export function auditPairs(themes: AuditTheme[] = loadAuditThemes()): ContrastRow[] {
	return CONTRAST_PAIRS.map((pair) => ({
		pair,
		results: themes.map((audit) => {
			const ratio = pairRatio(audit, pair);
			return { theme: audit.name, appearance: audit.appearance, ratio, verdict: verdictOf(pair.kind, ratio) };
		}),
	}));
}
