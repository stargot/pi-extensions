/**
 * Чип-хелпер: короткий текст с fg-цветом и bg-подложкой (бейдж статуса).
 *
 * В pi 0.85.x у Theme нет theme.style(text, {fg, bg}) — есть парные theme.fg(color, text)
 * и theme.bg(color, text). Композиция: bg оборачивает уже fg-крашеный текст — сброс
 * fg \x1b[39m не гасит активный фон, сброс фона \x1b[49m закрывает подложку.
 *
 * Guard-фоллбэк: bg-токен может отсутствовать (searchMatchBg опционален; Theme.bg бросает
 * «Unknown theme background color» на неизвестном токене), а у CLI-стилеров метода bg
 * может не быть вовсе — тогда чип деградирует до fg-only и рендер не падает.
 */

/** Минимальный интерфейс раскраски: структурно совместим с Theme и Styler report.ts. */
export interface ChipStyler {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
}

/** Токены чипа: fg обязателен, bg — по желанию (отсутствует/неизвестен → fg-only). */
export interface ChipStyle {
	fg: string;
	bg?: string;
}

/** Пробелы обрамления: подложка должна быть видна вокруг текста. */
export const CHIP_PAD = 1;

/** Чип: ` fg ` с fg-цветом и (если токен есть) bg-подложкой. Не бросает исключений. */
export function chip(styler: ChipStyler, text: string, style: ChipStyle, pad: number = CHIP_PAD): string {
	const padding = " ".repeat(Math.max(0, Math.floor(pad)));
	const fgged = styler.fg(style.fg, `${padding}${text}${padding}`);
	if (!style.bg) return fgged;
	try {
		return styler.bg ? styler.bg(style.bg, fgged) : fgged;
	} catch {
		// Неизвестный bg-токен темы — фоллбэк на fg-only.
		return fgged;
	}
}
