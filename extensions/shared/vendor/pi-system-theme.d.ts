/**
 * Типы для вендоренного движка системной темы pi (pi-system-theme.js): поверхность
 * оригинального dist/modes/interactive/theme/system-theme.d.ts из
 * @earendil-works/pi-coding-agent 1.0.0, типы перенаправлены на публичные корни
 * пакетов (pi-tui и корень pi-coding-agent). Обновлять вместе с .js.
 */
import type { RgbColor } from "@earendil-works/pi-tui";
import type { ThemeAppearance, ThemeColor, ThemeToken } from "@earendil-works/pi-coding-agent";

export declare const SYSTEM_THEME_NAME = "system";

export interface SystemThemeInput {
	foreground?: RgbColor;
	background?: RgbColor;
	/** ANSI colors 0-15. */
	palette?: RgbColor[];
	/** Saturation multiplier from 0 (grayscale) to 1. The first frame renders in grayscale until colors arrive. */
	saturation?: number;
	/** Appearance when the terminal did not report its background, e.g. from its light/dark report or COLORFGBG. */
	appearanceHint?: ThemeAppearance;
}

export interface SystemThemeColors {
	/** Hex colors, ANSI palette indices, or "" for the terminal default. */
	colors: Record<ThemeToken, string | number>;
	/** Foreground tokens rendered faint (SGR 2), for terminals that did not report colors. */
	dim: ThemeColor[];
	appearance: ThemeAppearance | undefined;
}

/** WCAG 2 relative luminance. */
export declare function relativeLuminance({ r, g, b }: RgbColor): number;

/** WCAG 2 contrast ratio, 1-21. */
export declare function wcagContrast(first: RgbColor, second: RgbColor): number;

/**
 * Whether a terminal is dark or light, from its reported colors: the direction of its own foreground
 * when text can be readable that way, otherwise dark when white text has more contrast on the
 * background than black text.
 */
export declare function terminalAppearance(background: RgbColor, foreground?: RgbColor): ThemeAppearance;

/**
 * Generate the system theme's colors from the terminal's reported colors.
 */
export declare function generateSystemThemeColors(input: SystemThemeInput): SystemThemeColors;
