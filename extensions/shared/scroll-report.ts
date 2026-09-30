/**
 * Общий прокручиваемый компонент для текстовых отчётов внутри ctx.ui.custom().
 * Клавиши: ↑↓ j k PgUp PgDn Space Home End g G · r пересчитать · q Esc Ctrl+C закрыть.
 *
 * Композиция на примитивах pi-tui: строки render() → Text → ScrollView,
 * help-строка с позицией (n-m/total) — под вьюпортом через VStack. Состояние
 * скролла (scrollTop, клампы) принадлежит ScrollView; клавиши и колесо мыши
 * транслируются в его API (scrollBy/scrollToStart/scrollToEnd).
 *
 * Нюанс оверлеев: ctx.ui.custom рендерит компонент напрямую (component.render),
 * минуя layout-движок pi-tui, поэтому updateLayout для ScrollView вызываем сами
 * из render(), а «Unhandled wheel events scroll the nearest ScrollView» здесь не
 * срабатывает (routeWheel идёт по основному layout) — wheel обрабатывается в
 * handleMouse и делегируется тому же ScrollView.
 */
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	ScrollView,
	Text,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";

export interface ScrollReportOptions {
	tui: TUI;
	theme: Theme;
	/** Строки отчёта для заданной ширины. Вызывается при первом рендере, смене ширины и по `r`. */
	render: (width: number, theme: Theme) => string[];
	onClose: () => void;
	/** Дополнительная подсказка в строке помощи, например список аргументов команды. */
	helpSuffix?: string;
	/** Рамка сверху/снизу (DynamicBorder). По умолчанию off — потребители рисуют свои заголовки. */
	border?: boolean;
}

export class ScrollReport implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly renderLines: (width: number, theme: Theme) => string[];
	private readonly onClose: () => void;
	private readonly helpSuffix: string;

	/** Полный отчёт (все строки), кэшируется Text-ом по ширине. */
	private readonly content = new Text("", 0, 0);
	/** Help-строка с позицией, обновляется в render(). */
	private readonly help = new Text("", 0, 0);
	private readonly scrollView: ScrollView;
	private readonly root: Component;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(options: ScrollReportOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.renderLines = options.render;
		this.onClose = options.onClose;
		this.helpSuffix = options.helpSuffix ?? "";

		// Вьюпорт: нарезает полный контент по текущему scrollTop. В обычном layout
		// это делает движок pi-tui (клип по scroll-rect), в оверлее — делаем сами.
		const viewport: Component = {
			render: (width: number) => {
				const full = this.content.render(width);
				const top = this.scrollView.scrollTop;
				return full.slice(top, top + Math.max(0, this.scrollView.viewportHeight));
			},
			invalidate: () => this.content.invalidate(),
		};
		this.scrollView = new ScrollView(viewport);

		this.root =
			options.border === true
				? new VStack([
						new DynamicBorder((s) => this.theme.fg("border", s)),
						this.scrollView,
						this.help,
						new DynamicBorder((s) => this.theme.fg("border", s)),
					])
				: new VStack([this.scrollView, this.help]);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		}
		if (data === "r") {
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		const rows = this.scrollView.viewportHeight > 0 ? this.scrollView.viewportHeight : this.viewportRows();
		let scrolled = true;
		if (matchesKey(data, "up") || data === "k") {
			this.scrollView.scrollBy(-1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollView.scrollBy(1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollView.scrollBy(-rows);
		} else if (matchesKey(data, "pageDown") || data === " ") {
			this.scrollView.scrollBy(rows);
		} else if (matchesKey(data, "home") || data === "g") {
			this.scrollView.scrollToStart();
		} else if (matchesKey(data, "end") || data === "G") {
			this.scrollView.scrollToEnd();
		} else {
			scrolled = false;
		}
		if (scrolled) this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollView.scrollBy(event.wheelDelta);
		return { handled: true };
	}

	private viewportRows(): number {
		// Терминал минус help-строка и воздух; минимум 6 строк контента.
		return Math.max(6, this.tui.terminal.rows - 3);
	}

	private lines(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.renderLines(width, this.theme).map((line) => truncateToWidth(line, width));
		this.cachedWidth = width;
		this.content.setText(this.cachedLines.join("\n"));
		return this.cachedLines;
	}

	render(width: number): string[] {
		const all = this.lines(width);
		const rows = this.viewportRows();
		this.scrollView.updateLayout(all.length, rows, () => this.tui.requestRender());
		const top = this.scrollView.scrollTop;
		const position = all.length > rows ? ` ${top + 1}-${Math.min(all.length, top + rows)}/${all.length}` : "";
		const help = this.theme.fg(
			"dim",
			`↑↓ PgUp PgDn Home End scroll · r refresh · q/esc close${position}${this.helpSuffix}`,
		);
		this.help.setText(truncateToWidth(help, width));
		return this.root.render(width);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.content.invalidate();
		this.help.invalidate();
		this.root.invalidate();
	}
}
