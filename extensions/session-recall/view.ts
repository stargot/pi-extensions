/**
 * session-recall: интерактивный список результатов на SelectList из pi-tui.
 * Строка результата: primary — заголовок (дата, проект, роль, сессия), secondary — фрагмент
 * с подсветкой термов (highlight из search.ts). Выделение, пейджинг и колесо мыши принадлежат
 * SelectList; ResultsView — контейнер: заголовок, разделитель, подсказка и закрытие через
 * action ext.recall.close (по умолчанию q/Esc, переопределяется в keybindings.json), Ctrl+C.
 * ↑↓ j k PgUp PgDn Home End · Enter выбрать.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	TruncatedText,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";
import { formatDate, type Hit, highlight } from "./search.ts";
import { actionHint, getExtKeybindings, matchAction } from "../shared/keybindings.ts";

export interface ResultsViewOptions {
	tui: TUI;
	theme: Theme;
	hits: Hit[];
	total: number;
	terms: string[];
	queryText: string;
	onSelect: (hit: Hit) => void;
	onClose: () => void;
}

/** Обрезка ANSI-строки до ширины тем же примитивом, что рендерит остальные строки вью. */
function truncateRow(text: string, maxWidth: number): string {
	return new TruncatedText(text).render(Math.max(1, maxWidth))[0]?.trimEnd() ?? "";
}

export class ResultsView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly hits: Hit[];
	private readonly total: number;
	private readonly terms: string[];
	private readonly queryText: string;
	private readonly onSelect: (hit: Hit) => void;
	private readonly onClose: () => void;
	private readonly selectList: SelectList;
	private readonly root: Component;
	/** Зеркало selectedIndex SelectList — для относительных PgUp/PgDn/j/k. */
	private selected = 0;
	/** Клавиши ext.*: свой менеджер с definitions расширений (см. shared/keybindings.ts). */
	private readonly kb = getExtKeybindings();

	constructor(options: ResultsViewOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.hits = options.hits;
		this.total = options.total;
		this.terms = options.terms;
		this.queryText = options.queryText;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		const th = this.theme;

		// value — индекс в hits: внутренний пейджинг SelectList не смещает нумерацию,
		// поэтому выбор элемента всегда маппится обратно в hits[i].
		const items: SelectItem[] = this.hits.map((hit, i) => {
			const u = hit.unit;
			const role =
				u.role === "tool" ? `tool:${u.tool ?? "?"}` : u.role === "custom" ? `custom:${u.tool ?? "?"}` : u.role;
			const name = u.sessionName ? `  ${th.fg("dim", u.sessionName)}` : "";
			return {
				value: String(i),
				label: `${th.fg("dim", formatDate(u.timestamp))}  ${th.fg("toolTitle", u.project)}  ${th.fg("muted", role)}${name}`,
				description: highlight(hit.snippet, this.terms, (s) => th.fg("warning", th.bold(s))),
			};
		});

		const selectTheme: SelectListTheme = {
			selectedPrefix: (text) => th.fg("accent", text),
			selectedText: (text) => th.bold(text),
			// Фрагмент уже покрашен highlight() — не перекрашиваем.
			description: (text) => text,
			scrollInfo: (text) => th.fg("muted", text),
			noMatch: () => th.fg("dim", "  Nothing found."),
		};
		const layout: SelectListLayoutOptions = {
			minPrimaryColumnWidth: 32,
			maxPrimaryColumnWidth: 48,
			truncatePrimary: ({ text, maxWidth }) => truncateRow(text, maxWidth),
		};

		this.selectList = new SelectList(items, this.pageSize(), selectTheme, layout);
		this.selectList.onSelect = (item) => {
			const hit = this.hits[Number(item.value)];
			if (hit) this.onSelect(hit);
		};
		this.selectList.onSelectionChange = (item) => {
			this.selected = Number(item.value);
		};

		const shown = this.hits.length;
		const header = `${th.bold(th.fg("accent", " Recall"))}  ${th.fg("muted", this.queryText)}  ${th.fg("dim", `${shown === this.total ? shown : `${shown} of ${this.total}`} results`)}`;
		const help = th.fg("dim", `↑↓ PgUp PgDn move · Enter open · ${actionHint(this.kb, "ext.recall.close", "close")}`);
		// Разделитель — точно по ширине (без ellipsis-артефактов TruncatedText), как раньше.
		const separator: Component = {
			render: (w) => [th.fg("borderMuted", "─".repeat(Math.min(w, 110)))],
			invalidate: () => {},
		};
		this.root = new VStack([new TruncatedText(header), separator, this.selectList, new TruncatedText(help)]);
	}

	private pageSize(): number {
		// Заголовок, разделитель, подсказка и строка позиции занимают ~4 строки.
		return Math.max(3, this.tui.terminal.rows - 6);
	}

	/** Сдвиг выделения SelectList (с клампом) + зеркало для относительных клавиш. */
	private moveTo(index: number): void {
		this.selectList.setSelectedIndex(index);
		this.selected = Math.max(0, Math.min(index, Math.max(0, this.hits.length - 1)));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchAction(this.kb, data, "ext.recall.close", ["q", "escape"])) {
			this.onClose();
			return;
		}
		const page = this.pageSize();
		const last = Math.max(0, this.hits.length - 1);
		// SelectList обрабатывает только ↑↓/Enter/Esc — пейджинг и vi-клавиши мостим к его выделению.
		if (matchesKey(data, "pageUp")) this.moveTo(Math.max(0, this.selected - page));
		else if (matchesKey(data, "pageDown")) this.moveTo(Math.min(last, this.selected + page));
		else if (data === "j") this.moveTo(Math.min(last, this.selected + 1));
		else if (data === "k") this.moveTo(Math.max(0, this.selected - 1));
		else if (matchesKey(data, "home") || data === "g") this.moveTo(0);
		else if (matchesKey(data, "end") || data === "G") this.moveTo(last);
		else this.selectList.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.selectList.handleMouse(event);
		if (result?.render) this.tui.requestRender();
		return result;
	}

	render(width: number): string[] {
		return this.root.render(width);
	}

	invalidate(): void {
		this.selectList.invalidate();
		this.root.invalidate();
	}
}
