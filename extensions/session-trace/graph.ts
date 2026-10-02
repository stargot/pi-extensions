/**
 * session-trace — TUI-компонент: лента ходов агента как flow-граф.
 * Режимы: live (follow за хвостом файла) и replay (проигрывание по timestamp'ам).
 *
 * Композиция на примитивах pi-tui (паттерн — shared/scroll-report.ts):
 * карточки — Box, лента — ScrollView, мини-карта — соседняя колонка HStack.
 * Клавиши действий (/, e, m, d, n/N, f, q и replay-набор) — action'ы ext.trace.*
 * из shared/keybindings.ts (переопределяются в <agentDir>/keybindings.json);
 * скролл-навигация и esc/ctrl+c — как раньше, литерально.
 * Состояние скролла (scrollTop, клампы) принадлежит ScrollView; follow-режим
 * («держать хвост») остаётся флагом TraceView и каждый рендер пинокает
 * scrollToEnd() — так бейдж LIVE/PAUSED/▶ не зависит от внутреннего
 * followingEnd у ScrollView. Колесо мыши приходит в handleMouse компонента через
 * dispatchMouseToLayout (и в editor-dock fullscreen-хоста, и в cli-alt-screen);
 * { handled: true } не пускает routeWheel до transcript'а хоста.
 * Высоту вью берёт из terminal.rows минус reserveRows (резерв хоста — см. поле).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import {
	Box,
	type Component,
	HStack,
	Key,
	matchesKey,
	ScrollView,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { chip } from "../shared/chip.ts";
import {
	diffKindColors,
	diffLines,
	filterRows,
	renderDiffRow,
	type DiffColor,
	type DiffDisplayRow,
	type DiffRow,
} from "../shared/line-diff.ts";
import { actionHint, getExtKeybindings, matchAction, matchActionIndex } from "../shared/keybindings.ts";
import { GraphModel, type ChildItem, type Item, fmtClock, fmtDur, fmtK, fmtMoney, oneLine } from "./session.ts";
import { cacheHitRatio, cacheLevel, CONTEXT_HISTORY_LIMIT } from "./context-history.ts";

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Ширина мини-карты: колонка силуэта + колонка позиции вьюпорта. */
const MAP = 2;
// класс строки ленты: вес для выборки и цвет на карте
const KIND_WEIGHT: Record<string, number> = { E: 5, R: 4, U: 3, C: 2, B: 2, t: 1, ".": 0 };
const MAP_COLOR: Record<string, string> = {
	E: "error",
	R: "accent",
	U: "userMessageText",
	C: "toolTitle",
	B: "muted",
	t: "dim",
};

interface UiTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold(text: string): string;
}

interface TuiLike {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

/** Однострочный компонент для Box: отдаёт готовую строку, ширины касается сам Box. */
function textLine(s: string): Component {
	return { render: () => [s], invalidate: () => {} };
}

export class TraceView {
	private tui: TuiLike;
	private theme: UiTheme;
	private file: string;
	private mode: "live" | "replay";
	private onClose: () => void;
	/** Строк терминала, зарезервированных хостом под своё окружение (не для вьюпорта).
	 * fullscreen-хост pi рендерит оверлей в editor-dock чат-вьюпорта и держит над ним
	 * минимум 1 строку транскрипта (chat-viewport: transcript minSize 1) — без резерва
	 * footer оверлея (позиция + подсказки) всегда обрезается на одну строку. cli.ts
	 * ставит view корнем собственного alt-screen — там резерв не нужен (0). */
	private readonly reserveRows: number;

	private entries: { ms: number; e: any }[] = [];
	private model: GraphModel = new GraphModel();
	private fedCount = 0;
	private byteOffset = 0;
	private pending = "";

	private playheadMs = 0;
	private speed = 8;
	private paused = false;
	private follow: boolean;
	private lastTick = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private lineKinds: string[] = [];
	private matchStarts: number[] = []; // строки ленты, где начинаются элементы под фильтром
	private matchCursor = -1; // индекс последнего совпадения, к которому прыгали (n/N)
	private filterQ = ""; // активный фильтр подстроки
	private editing = false; // идёт ввод фильтра
	private errorsOnly = false; // режим «только ошибки»
	private summary = false; // сводка по моделям вместо ленты
	// B6: режим контекст-диффа (клавиша d): таблица последних ходов + построчный
	// дифф подписей prev→curr для выбранного хода. q/esc/d — назад к ленте.
	private diffMode = false;
	private diffSel = 0; // индекс выбранного хода в history.snapshots
	private diffTail = true; // выбран последний ход (догоняет новые при live-дозаписи)
	private diffCache: { width: number; rev: number; lines: string[]; kinds: string[] } | undefined;
	private followBeforeDiff?: boolean;
	private cache:
		| { width: number; version: number; lines: string[]; kinds: string[]; matchStarts: number[] }
		| undefined;
	/** Клавиши ext.*: свой менеджер с definitions расширений (см. shared/keybindings.ts). */
	private readonly kb = getExtKeybindings();

	/** Вьюпорт: нарезает кэш ленты по scrollTop (в оверлее layout-движка нет). */
	private readonly viewport: Component = {
		render: (_width: number) => {
			const lines = (this.diffMode ? this.diffCache?.lines : this.cache?.lines) ?? [];
			const body = this.mapState.body;
			const top = this.scrollView.scrollTop;
			const out: string[] = [];
			for (let r = 0; r < body; r++) out.push(lines[top + r] ?? "");
			return out;
		},
		invalidate: () => {},
	};
	private readonly scrollView = new ScrollView(this.viewport, { scrollbar: "hidden" });
	/** Состояние мини-карты на текущий кадр; читается map-колонкой HStack. */
	private mapState = { kinds: [] as string[], top: 0, body: 0, total: 0, show: false };
	/** Мини-карта: силуэт ленты (▪ по самому «тяжёлому» классу) + ▐ позиция вьюпорта. */
	private readonly mapComp: Component = {
		render: () => {
			const { kinds, top, body, total, show } = this.mapState;
			const out: string[] = [];
			for (let r = 0; r < body; r++) {
				if (!show || total === 0) {
					out.push("  ");
					continue;
				}
				// диапазон исходных строк, который представляет эта строка карты
				const a = Math.floor((total * r) / body);
				const bEnd = Math.max(a + 1, Math.floor((total * (r + 1)) / body));
				let bestW = 0;
				let bestK = ".";
				for (let i = a; i < kinds.length && i < bEnd + 1; i++) {
					const w = KIND_WEIGHT[kinds[i]] ?? 0;
					if (w > bestW) {
						bestW = w;
						bestK = kinds[i];
					}
				}
				const inView = bEnd > top && a < top + body;
				const glyph = bestK === "." ? " " : this.theme.fg(MAP_COLOR[bestK] ?? "dim", "▪");
				out.push(glyph + (inView ? this.theme.fg("accent", "▐") : " "));
			}
			return out;
		},
		invalidate: () => {},
	};
	private readonly feedRow = new HStack([
		{ component: this.scrollView, grow: 1 },
		{ component: this.mapComp, basis: MAP, grow: 0, shrink: 0 },
	]);

	constructor(opts: {
		tui: TuiLike;
		theme: UiTheme;
		file: string;
		mode: "live" | "replay";
		speed?: number;
		reserveRows?: number;
		onClose: () => void;
	}) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.file = opts.file;
		this.mode = opts.mode;
		this.speed = opts.speed ?? 8;
		this.reserveRows = Math.max(0, Math.floor(opts.reserveRows ?? 0));
		this.onClose = opts.onClose;
		this.follow = opts.mode === "live";
		this.poll();
		this.playheadMs = this.entries[0]?.ms ?? 0;
		if (this.mode === "live") this.feedAvailable();
		this.timer = setInterval(() => this.tick(), 150);
	}

	dispose(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	// ---------- данные ----------

	/** Инкрементально дочитывает файл. true — появились новые записи. */
	private poll(): boolean {
		let fd: number;
		try {
			fd = openSync(this.file, "r");
		} catch {
			return false;
		}
		try {
			const size = fstatSync(fd).size;
			if (size < this.byteOffset) {
				// файл пересоздали — начинаем заново
				this.byteOffset = 0;
				this.pending = "";
				this.resetModel();
			}
			if (size === this.byteOffset) return false;
			const buf = Buffer.alloc(size - this.byteOffset);
			readSync(fd, buf, 0, buf.length, this.byteOffset);
			this.byteOffset = size;
			const lines = (this.pending + buf.toString("utf8")).split("\n");
			this.pending = lines.pop() ?? "";
			let added = 0;
			for (const line of lines) {
				const t = line.trim();
				if (!t) continue;
				let e: any;
				try {
					e = JSON.parse(t);
				} catch {
					continue;
				}
				this.entries.push({ ms: Date.parse(e.timestamp) || 0, e });
				added++;
			}
			return added > 0;
		} finally {
			closeSync(fd);
		}
	}

	private resetModel(): void {
		this.model = new GraphModel();
		this.fedCount = 0;
		this.cache = undefined;
	}

	private feedOne(): void {
		if (this.fedCount >= this.entries.length) return;
		this.model.feedEntry(this.entries[this.fedCount].e);
		this.fedCount++;
	}

	private feedAvailable(): void {
		while (this.fedCount < this.entries.length) this.feedOne();
		if (this.entries.length > 0) {
			this.playheadMs = Math.max(this.playheadMs, this.entries[this.entries.length - 1].ms);
		}
	}

	private seekTo(ms: number): void {
		let lo = 0;
		let hi = this.entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.entries[mid].ms <= ms) lo = mid + 1;
			else hi = mid;
		}
		this.resetModel();
		for (let i = 0; i < lo; i++) this.feedOne();
		this.playheadMs = this.entries[Math.max(0, lo - 1)]?.ms ?? ms;
	}

	private tick(): void {
		if (this.closed) return;
		const now = Date.now();
		const dt = now - this.lastTick;
		this.lastTick = now;
		const grew = this.poll();
		if (this.mode === "live" || this.follow) {
			this.feedAvailable();
		} else if (!this.paused) {
			this.playheadMs += dt * this.speed;
			while (this.fedCount < this.entries.length && this.entries[this.fedCount].ms <= this.playheadMs) {
				this.feedOne();
			}
			if (this.fedCount >= this.entries.length && grew) {
				this.poll(); // догнать дозапись на «живом» краю replay
			}
		}
		this.tui.requestRender();
	}

	// ---------- ввод ----------

	handleInput(data: string): void {
		const rows = this.availRows() - 2;

		// режим ввода фильтра: печатаем подстроку, enter — применить, esc — сбросить
		if (this.editing) {
			if (matchesKey(data, Key.enter)) {
				this.editing = false;
				this.matchCursor = -1;
			} else if (matchesKey(data, Key.escape)) {
				this.editing = false;
				this.filterQ = "";
				this.matchCursor = -1;
			} else if (matchesKey(data, Key.backspace)) {
				this.filterQ = this.filterQ.slice(0, -1);
				this.matchCursor = -1;
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filterQ += data;
				this.matchCursor = -1;
			}
			this.cache = undefined;
			this.tui.requestRender();
			return;
		}

		// B6: режим контекст-диффа — свой набор клавиш; d/q (действия diff/close) и
		// esc возвращают к ленте, а не закрывают оверлей. Ctrl+C закрывает и отсюда.
		if (this.diffMode) {
			if (matchesKey(data, Key.ctrl("c"))) {
				this.dispose();
				this.onClose();
				return;
			}
			if (
				matchAction(this.kb, data, "ext.trace.diff") ||
				matchAction(this.kb, data, "ext.trace.close") ||
				matchesKey(data, Key.escape)
			) {
				this.exitDiff();
			} else if (matchesKey(data, Key.up)) {
				this.moveDiffSel(-1);
			} else if (matchesKey(data, Key.down)) {
				this.moveDiffSel(1);
			} else if (matchesKey(data, Key.pageUp)) {
				this.scrollView.scrollBy(-(rows - 3));
			} else if (matchesKey(data, Key.pageDown)) {
				this.scrollView.scrollBy(rows - 3);
			} else if (matchesKey(data, Key.home)) {
				this.scrollView.scrollToStart();
			} else if (matchesKey(data, Key.end) || matchAction(this.kb, data, "ext.trace.follow")) {
				this.scrollView.scrollToEnd();
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrl("c")) || matchAction(this.kb, data, "ext.trace.close")) {
			this.dispose();
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			// esc: сначала снимает фильтры, и только потом закрывает
			if (this.filterQ || this.errorsOnly || this.summary) {
				this.filterQ = "";
				this.errorsOnly = false;
				this.summary = false;
				this.matchCursor = -1;
				this.cache = undefined;
			} else {
				this.dispose();
				this.onClose();
				return;
			}
		} else if (matchAction(this.kb, data, "ext.trace.filter")) {
			this.editing = true;
		} else if (matchAction(this.kb, data, "ext.trace.errors")) {
			this.errorsOnly = !this.errorsOnly;
			this.matchCursor = -1;
			this.cache = undefined;
		} else if (matchAction(this.kb, data, "ext.trace.models")) {
			this.summary = !this.summary;
			this.cache = undefined;
		} else if (matchAction(this.kb, data, "ext.trace.diff")) {
			this.enterDiff();
		} else {
			// направление — по индексу совпавшего ключа в резолвнутом списке: первая
			// клавиша — вперёд (+1), вторая и далее — назад (-1). Не по регистру data:
			// при переопределении ["j","k"] обе клавиши строчные и старая регистр-
			// эвристика молча вела всё вперёд.
			const idx = matchActionIndex(this.kb, data, "ext.trace.jumpMatch");
			if (idx >= 0) {
				this.jumpMatch(idx <= 0 ? 1 : -1);
			} else if (matchesKey(data, Key.up)) {
				this.follow = false;
				this.scrollView.scrollBy(-3);
			} else if (matchesKey(data, Key.down)) {
				this.scrollView.scrollBy(3);
				if (this.atTail()) this.follow = true;
			} else if (matchesKey(data, Key.pageUp)) {
				this.follow = false;
				this.scrollView.scrollBy(-(rows - 3));
			} else if (matchesKey(data, Key.pageDown)) {
				this.scrollView.scrollBy(rows - 3);
				if (this.atTail()) this.follow = true;
			} else if (matchesKey(data, Key.home)) {
				this.follow = false;
				this.scrollView.scrollToStart();
			} else if (matchesKey(data, Key.end) || matchAction(this.kb, data, "ext.trace.follow")) {
				this.jumpToEnd();
			} else if (this.mode === "replay") {
				this.handleReplayKeys(data);
			}
		}
		this.tui.requestRender();
	}

	/** Колесо мыши: событие приходит сюда через dispatchMouseToLayout (и в editor-dock
	 * fullscreen-хоста, и в cli-alt-screen); { handled: true } не пускает routeWheel
	 * хоста до transcript'а — крутим только наш ScrollView. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollView.scrollBy(event.wheelDelta);
		if (event.wheelDelta < 0) this.follow = false;
		else if (this.atTail()) this.follow = true;
		return { handled: true };
	}

	private handleReplayKeys(data: string): void {
		if (matchAction(this.kb, data, "ext.trace.pause")) {
			this.paused = !this.paused;
		} else if (matchAction(this.kb, data, "ext.trace.faster")) {
			this.speed = Math.min(256, this.speed * 2);
		} else if (matchAction(this.kb, data, "ext.trace.slower")) {
			this.speed = Math.max(0.25, this.speed / 2);
		} else if (matchAction(this.kb, data, "ext.trace.seekBack")) {
			this.follow = false;
			this.paused = true;
			this.seekTo(Math.max(0, this.playheadMs - 5000));
			this.scrollView.scrollToEnd();
		} else if (matchAction(this.kb, data, "ext.trace.seekForward")) {
			this.follow = false;
			this.paused = true;
			this.seekTo(this.playheadMs + 5000);
			this.scrollView.scrollToEnd();
		} else if (matchAction(this.kb, data, "ext.trace.live")) {
			this.jumpToEnd();
		} else if (matchAction(this.kb, data, "ext.trace.restart")) {
			this.follow = false;
			this.paused = false;
			this.seekTo(this.entries[0]?.ms ?? 0);
			this.scrollView.scrollToEnd();
		}
	}

	/** Строки терминала, доступные оверлею, с учётом резерва хоста. Единая точка расчёта
	 * высоты: render (тело ленты), atTail (порог follow) и PgUp/PgDn должны считать
	 * одинаково, иначе follow включается на строку раньше/позже хвоста. */
	private availRows(): number {
		return Math.max(6, this.tui.terminal.rows - this.reserveRows);
	}

	/** Вьюпорт сидит на хвосте ленты (последняя строка контента видна). */
	private atTail(): boolean {
		const total = (this.diffMode ? this.diffCache?.lines.length : this.cache?.lines.length) ?? 0;
		const body = this.availRows() - 2;
		return this.scrollView.scrollTop >= Math.max(0, total - body);
	}

	/** n/N: к следующему/предыдущему совпадению фильтра (без фильтра — к соседнему элементу). */
	private jumpMatch(dir: 1 | -1): void {
		if (!this.cache) {
			// после правки фильтра кэш сброшен — прогреваем, чтобы получить matchStarts
			this.render(Math.max(20, this.tui.terminal.columns - MAP));
		}
		const ms = this.cache?.matchStarts;
		if (!ms || ms.length === 0) return;

		if (this.matchCursor < 0 || this.matchCursor >= ms.length) {
			// первый прыжок: от текущей позиции вьюпорта
			const cur = this.scrollView.scrollTop;
			this.matchCursor = dir === 1 ? ms.findIndex((s) => s > cur) : -1;
			if (dir === 1 && this.matchCursor < 0) this.matchCursor = 0; // по кругу
			if (dir === -1) {
				this.matchCursor = ms.length - 1;
				for (let i = ms.length - 1; i >= 0; i--) {
					if (ms[i] < cur) {
						this.matchCursor = i;
						break;
					}
				}
			}
		} else {
			this.matchCursor += dir;
			if (this.matchCursor >= ms.length) this.matchCursor = 0;
			if (this.matchCursor < 0) this.matchCursor = ms.length - 1;
		}

		const target = ms[this.matchCursor];
		this.follow = false;
		this.scrollView.scrollTo(target, { disableFollow: true });
		this.tui.requestRender();
	}

	private jumpToEnd(): void {
		this.follow = true;
		this.feedAvailable();
	}

	// ---------- рендер ----------

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		const rows = this.availRows();
		const body = rows - 2;
		const contentW = Math.max(20, width - MAP);
		if (this.diffMode) {
			this.syncDiffSel();
			if (!this.diffCache || this.diffCache.width !== contentW || this.diffCache.rev !== this.model.history.revision) {
				const built = this.buildDiffLines(contentW);
				this.diffCache = {
					width: contentW,
					rev: this.model.history.revision,
					lines: built.lines.map((l) => truncateToWidth(l, contentW)),
					kinds: built.kinds,
				};
			}
		} else if (!this.cache || this.cache.width !== contentW || this.cache.version !== this.model.version) {
			const lines = this.buildLines(contentW).map((l) => truncateToWidth(l, contentW));
			this.cache = {
				width: contentW,
				version: this.model.version,
				lines,
				kinds: this.lineKinds,
				matchStarts: this.matchStarts,
			};
		}
		const active = this.diffMode ? this.diffCache : this.cache;
		const lines = active?.lines ?? [];
		const kinds = active?.kinds ?? [];
		this.scrollView.updateLayout(lines.length, body, () => this.tui.requestRender());
		// follow-режим и играющий replay держат хвост; стоит пользователю
		// уехать вверх (scrollTop < хвоста) — вьюпорт больше не дёргается.
		// В диффе своего скролла не трогаем — там нет «хвоста ленты».
		if (!this.diffMode && (this.follow || (this.mode === "replay" && this.atTail()))) this.scrollView.scrollToEnd();
		const top = this.scrollView.scrollTop;
		this.mapState = { kinds, top, body, total: lines.length, show: lines.length > body };
		const out = [this.header(width, top)];
		out.push(...this.feedRow.render(width));
		while (out.length < rows) out.push("");
		out[rows - 1] = this.footer(width, top, lines.length);
		return out;
	}

	private badge(top: number): string {
		const th = this.theme;
		let b: string;
		if (this.diffMode) {
			const n = this.model.history.length;
			b = `${th.fg("accent", th.bold("DIFF ⧉"))} ${th.fg("dim", `${n === 0 ? 0 : this.diffSel + 1}/${n}`)}`;
			return b;
		}
		if (this.mode === "live" || this.follow) b = th.fg("accent", th.bold("LIVE ●"));
		else if (this.paused) b = th.fg("warning", "PAUSED ⏸");
		else if (this.fedCount >= this.entries.length) b = th.fg("muted", "END");
		else b = th.fg("dim", `▶ ${this.speed}×`);
		if (this.errorsOnly) b += " " + th.fg("error", "err-only");
		if (this.filterQ) b += " " + th.fg("accent", `«${oneLine(this.filterQ, 14)}»`);
		const ms = this.cache?.matchStarts;
		if (this.matchCursor >= 0 && ms && this.matchCursor < ms.length) {
			b += " " + th.fg("dim", `${this.matchCursor + 1}/${ms.length}`);
		} else if ((this.filterQ || this.errorsOnly) && ms && ms.length) {
			let idx = 0;
			for (const s of ms) if (s <= top) idx++;
			b += " " + th.fg("dim", `${Math.min(idx + 1, ms.length)}/${ms.length}`);
		}
		return b;
	}

	private header(width: number, top: number): string {
		const th = this.theme;
		const m = this.model;
		const fileLabel =
			this.mode === "replay" ? oneLine(basename(this.file).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, ""), 18) : "";
		const name = m.sessionName ? oneLine(m.sessionName, 24) : "";
		const sep = th.fg("dim", " · ");
		const parts = [
			` ${th.fg("accent", "◐")} ${th.bold("session-trace")}`,
			fileLabel && th.fg("dim", fileLabel),
			th.fg("dim", `${name ? `${name} · ` : ""}${this.entries.length} entries`),
			`↑${fmtK(m.totals.input)} ↓${fmtK(m.totals.output)}`,
			m.totals.cost > 0 ? fmtMoney(m.totals.cost) : "",
		].filter(Boolean) as string[];
		const left = parts.join(sep);
		const b = this.badge(top);
		const pad = width - visibleWidth(left) - visibleWidth(b) - 1;
		return pad > 0 ? `${left} ${" ".repeat(pad)}${b}` : truncateToWidth(`${left} ${b}`, width);
	}

	private footer(width: number, top: number, total: number): string {
		const th = this.theme;
		const pos = th.fg("dim", `${Math.min(top + 1, total)}/${total}`);
		let hints: string;
		if (this.diffMode) {
			hints = ` ↑↓ ход · PgUp/PgDn scroll · ${actionHint(this.kb, "ext.trace.diff")} / esc / ${actionHint(this.kb, "ext.trace.close")} — назад к ленте `;
		} else if (this.editing) {
			hints = ` filter: ${this.filterQ}▏ enter — применить · esc — сброс `;
		} else {
			const nav =
				this.mode === "live"
					? `↑↓ scroll · ${actionHint(this.kb, "ext.trace.follow", "follow")}`
					: `space pause · ←→ seek · +/- speed · ${actionHint(this.kb, "ext.trace.live", "live")} · ${actionHint(this.kb, "ext.trace.restart", "restart")}`;
			hints = ` ${nav} · ${actionHint(this.kb, "ext.trace.filter", "filter")} · ${actionHint(this.kb, "ext.trace.jumpMatch", "jump")} · ${actionHint(this.kb, "ext.trace.errors", "errors")} · ${actionHint(this.kb, "ext.trace.models", "models")} · ${actionHint(this.kb, "ext.trace.diff", "context-diff")} · esc clear · ${actionHint(this.kb, "ext.trace.close", "close")} `;
		}
		const right = `${hints}${pos} `;
		const pad = width - visibleWidth(right);
		return pad > 0 ? `${" ".repeat(pad)}${right}` : truncateToWidth(right, width);
	}

	private spin(): string {
		return SPIN[Math.floor(Date.now() / 90) % SPIN.length];
	}

	/** Контент чипа: слева имя+лейбл, справа длительность и глиф статуса. */
	private chipRow(left: string, right: string, inner: number): string {
		const gap = inner - visibleWidth(left) - visibleWidth(right);
		return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(`${left} ${right}`, inner);
	}

	private childLines(c: ChildItem, width: number, out: string[], kinds: string[]): void {
		const th = this.theme;
		const title =
			`⧉ субагент: ${c.agent}` +
			` · ${fmtClock(c.ts)}` +
			(c.tokensOut ? ` · ↓${fmtK(c.tokensOut)}` : "") +
			(c.cost ? ` · ${fmtMoney(c.cost)}` : "");
		const card = new Box(1, 0);
		card.addChild(textLine(th.fg("dim", ` ${title}`)));
		kinds.push("C");
		card.addChild(textLine(` ${th.fg("text", c.task)}`));
		kinds.push("C");
		card.addChild(textLine(` ${th.fg("dim", basename(c.session))}`));
		kinds.push("C");
		card.addChild(textLine(` ${th.fg("toolTitle", "→ /graph " + c.session)}`));
		kinds.push("C");
		card.addChild(textLine("")); // отбивка вместо нижней рамки
		kinds.push(".");
		out.push(...card.render(width));
	}

	private cardLines(t: any, width: number, out: string[], kinds: string[]): void {
		const th = this.theme;
		const inner = Math.max(8, width - 2);
		const running = t.chips.some((c: any) => c.status === "running");
		const ends = t.chips.map((c: any) => c.endMs).filter((x: any) => x !== undefined) as number[];
		const dur = ends.length > 0 ? fmtDur(Math.max(...ends) - t.startMs) : "";
		const title =
			`T${t.index} · ${fmtClock(t.startMs)}` +
			(dur ? ` · ${dur}` : "") +
			(t.model ? ` · ${t.model}` : "") +
			(t.tokensOut ? ` · ↓${fmtK(t.tokensOut)}` : "") +
			(t.cost ? ` · ${fmtMoney(t.cost)}` : "") +
			(t.stopReason === "aborted" ? " · aborted" : "") +
			(running ? " · working" : "");
		const card = new Box(1, 0);
		card.addChild(textLine(th.fg("dim", ` ${title}`)));
		kinds.push(running ? "R" : "t");

		for (const c of t.chips) {
			const glyph =
				c.status === "ok"
					? th.fg("success", "✓")
					: c.status === "error"
						? th.fg("error", "✗")
						: th.fg("accent", `${this.spin()} running`);
			const chipDur = c.endMs !== undefined ? fmtDur(c.endMs - c.startMs) : "";
			// B8: имя инструмента — чип с подложкой по статусу (ThemeBg: toolSuccessBg /
			// toolErrorBg / toolPendingBg). Guard: темы без bg-токена и duck-typed темы без
			// bg деградируют до fg-only (shared/chip.ts).
			const badge = chip(
				th,
				`⚒ ${c.name}`,
				c.status === "error"
					? { fg: "error", bg: "toolErrorBg" }
					: c.status === "running"
						? { fg: "accent", bg: "toolPendingBg" }
						: { fg: "toolTitle", bg: "toolSuccessBg" },
			);
			const left = ` ${badge} ${th.fg("dim", c.label)}`;
			card.addChild(textLine(this.chipRow(left, `${th.fg("muted", chipDur)} ${glyph}`, inner)));
			kinds.push(c.status === "error" ? "E" : c.status === "running" ? "R" : "t");
		}
		if (t.thinking) {
			card.addChild(textLine(` ${th.fg("muted", `⋮ ${t.thinking}`)}`));
			kinds.push("t");
		}
		if (t.text) {
			card.addChild(textLine(` ${th.fg("text", `«${t.text}»`)}`));
			kinds.push("t");
		}
		if (t.errorMessage) {
			card.addChild(textLine(` ${th.fg("error", `✗ ${oneLine(t.errorMessage, inner - 4)}`)}`));
			kinds.push("E");
		}
		card.addChild(textLine("")); // отбивка вместо нижней рамки
		kinds.push(".");
		out.push(...card.render(width));
	}

	/** Проходит ли элемент под активными фильтрами (подстрока и/или «только ошибки»). */
	private matches(it: Item): boolean {
		if (this.errorsOnly) {
			const bad =
				(it.kind === "turn" && (it.errorMessage || it.chips.some((c) => c.status === "error"))) ||
				(it.kind === "bash" && it.exitCode !== undefined && it.exitCode !== 0);
			if (!bad) return false;
		}
		if (!this.filterQ) return true;
		const q = this.filterQ.toLowerCase();
		const hay =
			it.kind === "turn"
				? `${it.text ?? ""} ${it.thinking ?? ""} ${it.model ?? ""} ${it.chips.map((c) => `${c.name} ${c.label}`).join(" ")}`
				: it.kind === "marker"
					? it.text
					: it.kind === "user"
						? it.text
						: it.kind === "child"
							? `${it.agent} ${it.task} ${it.session}`
							: it.command; // bash
		return hay.toLowerCase().includes(q);
	}

	private summaryLines(width: number, kinds: string[]): string[] {
		const th = this.theme;
		const out: string[] = ["", ` ${th.bold("Модели")}`];
		kinds.push(".", ".");
		const rows = [...this.model.models.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].turns - a[1].turns);
		for (const [name, s] of rows) {
			const left = ` ${th.fg("toolTitle", oneLine(name, Math.max(12, width - 44)))}`;
			const right = `${s.turns} turns · ↑${fmtK(s.input)} ↓${fmtK(s.output)} · ${fmtMoney(s.cost)}`;
			const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
			out.push(
				gap > 0 ? `${left}${" ".repeat(gap)}${th.fg("dim", right)}` : truncateToWidth(`${left} ${right}`, width),
			);
			kinds.push(".");
		}
		if (rows.length === 0) {
			out.push(th.fg("dim", " пока нет ответов модели"));
			kinds.push(".");
		}
		out.push("", th.fg("dim", ` ${actionHint(this.kb, "ext.trace.models")} — вернуться к ленте · esc — сбросить всё`));
		kinds.push(".", ".");
		return out;
	}

	// ---------- режим контекст-диффа (B6) ----------

	private enterDiff(): void {
		if (this.diffMode) return;
		this.diffMode = true;
		this.diffTail = true;
		this.diffSel = Math.max(0, this.model.history.length - 1);
		this.followBeforeDiff = this.follow;
		this.follow = false;
		this.diffCache = undefined;
		this.scrollView.scrollToStart();
	}

	private exitDiff(): void {
		this.diffMode = false;
		this.diffCache = undefined;
		this.follow = this.followBeforeDiff ?? this.follow;
		this.followBeforeDiff = undefined;
		if (this.follow) this.scrollView.scrollToEnd();
	}

	/** Клампы выбора; пока пользователь не уехал вверх — выбор прилип к последнему ходу. */
	private syncDiffSel(): void {
		const n = this.model.history.length;
		if (n === 0) return;
		if (this.diffTail || this.diffSel >= n) this.diffSel = n - 1;
		if (this.diffSel < 0) this.diffSel = 0;
	}

	private moveDiffSel(dir: 1 | -1): void {
		const n = this.model.history.length;
		if (n === 0) return;
		this.syncDiffSel();
		this.diffSel = Math.min(n - 1, Math.max(0, this.diffSel + dir));
		this.diffTail = this.diffSel === n - 1;
		this.diffCache = undefined;
	}

	/** Строки режима диффа: таблица последних ходов + детальный дифф выбранного. */
	private buildDiffLines(_width: number): { lines: string[]; kinds: string[] } {
		const th = this.theme;
		const out: string[] = [];
		const kinds: string[] = [];
		const snaps = this.model.history.snapshots;
		if (snaps.length === 0) {
			out.push(th.fg("dim", "  ходов пока нет — дифф появится после первого ответа модели"));
			out.push("", th.fg("dim", ` ${actionHint(this.kb, "ext.trace.diff")} / esc — назад к ленте`));
			kinds.push(".", ".", ".");
			return { lines: out, kinds };
		}
		out.push(
			"",
			` ${th.fg("accent", "⧉")} ${th.bold("Контекст-дифф")} ${th.fg(
				"dim",
				`· ${snaps.length} из ${CONTEXT_HISTORY_LIMIT} ходов в буфере`,
			)}`,
		);
		kinds.push(".", "t");
		for (let i = 0; i < snaps.length; i++) {
			out.push(this.diffMetricRow(i));
			kinds.push("t");
		}
		this.pushDiffDetail(out, kinds);
		out.push(
			"",
			th.fg(
				"dim",
				` + добавлено · − удалено · ~ изменено · ⋮ разрыв · ${actionHint(this.kb, "ext.trace.diff")} / esc — назад к ленте`,
			),
		);
		kinds.push(".", ".");
		return { lines: out, kinds };
	}

	/** Строка таблицы ходов: T#, время, модель, промпт-токены, Δ, чип кэша, hit-rate. */
	private diffMetricRow(i: number): string {
		const th = this.theme;
		const { prev, curr, diff } = this.model.history.diffAt(i);
		const sel = i === this.diffSel;
		const cursor = sel ? th.fg("accent", "❯") : " ";
		const idx = th.fg(sel ? "text" : "dim", `T${curr.turnIndex}`.padEnd(6));
		const clock = th.fg("dim", fmtClock(curr.ts));
		const model = th.fg("muted", oneLine(curr.model ?? "?", 16).padEnd(16));
		const prompt = th.fg("dim", `↑${fmtK(diff.promptTokens)}`.padStart(8));
		const dt = diff.deltaTokens;
		const delta =
			dt > 0
				? th.fg("success", `Δ+${fmtK(dt)}`.padStart(8))
				: dt < 0
					? th.fg("warning", `Δ-${fmtK(-dt)}`.padStart(8))
					: th.fg("dim", "Δ0".padStart(8));
		// Чип кэша — цвет по prefixRatio (см. cacheLevel): тёплый ≥70%, частичный ≥40%.
		const level = cacheLevel(diff.prefixRatio);
		const color: string =
			prev === undefined ? "dim" : level === "warm" ? "accent" : level === "partial" ? "warning" : "error";
		const cache = chip(th, prev === undefined ? "⌁—" : `⌁${Math.round(diff.prefixRatio * 100)}%`, { fg: color });
		const hit = cacheHitRatio(curr.tokens);
		const hitTxt = hit === null ? "" : th.fg("dim", `hit ${Math.round(hit * 100)}%`);
		return `${cursor} ${idx} ${clock} ${model} ${prompt} ${delta} ${cache}${hitTxt ? ` ${hitTxt}` : ""}`;
	}

	/** Детальный дифф выбранного хода: diffLines (B5) над подписями prev→curr. */
	private pushDiffDetail(out: string[], kinds: string[]): void {
		const th = this.theme;
		const { prev, curr, diff } = this.model.history.diffAt(this.diffSel);
		out.push(
			"",
			` ${th.fg("toolTitle", `Ход T${curr.turnIndex}`)} ${th.fg(
				"dim",
				prev ? `— дифф контекста с T${prev.turnIndex}` : "— первый ход в буфере (весь контекст новый)",
			)}`,
		);
		kinds.push(".", "t");
		const s = diff.summary;
		const meta = [
			`${curr.messageSignature.length} сообщений`,
			`+${s.added} −${s.removed} ~${s.modified}`,
			`prefix ${Math.round(diff.prefixRatio * 100)}% (~${fmtK(diff.prefixTokens)} tok)`,
			`Δ${diff.deltaTokens >= 0 ? "+" : ""}${fmtK(diff.deltaTokens)} tok`,
		].join(" · ");
		out.push(` ${th.fg("dim", meta)}`);
		kinds.push(".");
		if (prev && s.changedBlocks === 0) {
			out.push(th.fg("dim", "  контекст не изменился — дифф пуст"));
			kinds.push(".");
			return;
		}
		const rows = filterRows(diffLines(prev?.messageSignature ?? [], curr.messageSignature), 1);
		// Страховка на случай большого перкроя (например, после компакции):
		const CAP = 300;
		for (const row of rows.slice(0, CAP)) this.pushDiffRow(row, out, kinds);
		if (rows.length > CAP) {
			out.push(th.fg("dim", `  ⋮ ещё ${rows.length - CAP} строк`));
			kinds.push(".");
		}
	}

	/** Одна display-строка диффа в терминал; modify раскрывается в пару «−~/+». */
	private pushDiffRow(row: DiffDisplayRow, out: string[], kinds: string[]): void {
		const th = this.theme;
		if (row.type === "separator") {
			out.push(th.fg("dim", "  ⋮"));
			kinds.push(".");
			return;
		}
		if (row.type === "equal") {
			out.push(`  ${th.fg("dim", row.text)}`);
			kinds.push(".");
			return;
		}
		if (row.type === "modify") {
			// До/после спаренной пары: warning слева, success справа, жирным — изменившиеся части.
			this.pushGuttered(row.text, row.segments, "~", "warning", "R", out, kinds);
			this.pushGuttered(row.afterText ?? "", row.afterSegments ?? [], "+", "success", "U", out, kinds);
			return;
		}
		if (row.type === "insert") {
			this.pushGuttered(row.text, row.segments, "+", "success", "U", out, kinds);
		} else {
			this.pushGuttered(row.text, row.segments, "-", "error", "E", out, kinds);
		}
	}

	private pushGuttered(
		text: string,
		segments: DiffRow["segments"],
		gutter: string,
		color: DiffColor,
		kind: string,
		out: string[],
		kinds: string[],
	): void {
		const row: DiffRow = { type: gutter === "+" ? "insert" : gutter === "~" ? "modify" : "delete", text, segments };
		const body = renderDiffRow(row, this.theme, { ...diffKindColors, [row.type]: color });
		out.push(` ${gutter} ${body}`);
		kinds.push(kind);
	}

	private buildLines(width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const kinds: string[] = [];
		const m = this.model;
		if (this.summary) {
			this.matchStarts = [];
			this.lineKinds = kinds;
			return this.summaryLines(width, kinds);
		}
		const matchStarts: number[] = [];
		for (const it of m.items) {
			if (!this.matches(it)) continue;
			matchStarts.push(out.length);
			out.push(th.fg("borderMuted", "  │"));
			kinds.push(".");
			if (it.kind === "user") {
				out.push(`  ${th.fg("accent", "●")} ${th.fg("userMessageText", it.text)}`);
				kinds.push("U");
			} else if (it.kind === "bash") {
				const bad = it.exitCode !== undefined && it.exitCode !== 0;
				const mark = bad ? ` ${th.fg("error", `exit ${it.exitCode}`)}` : "";
				out.push(`  ${th.fg("bashMode", "$")} ${th.fg("dim", it.command)}${mark}`);
				kinds.push(bad ? "E" : "B");
			} else if (it.kind === "marker") {
				out.push(`  ${th.fg("muted", `├ ${it.icon} ${it.text}`)}`);
				kinds.push(".");
			} else if (it.kind === "child") {
				this.childLines(it, width, out, kinds);
			} else {
				this.cardLines(it, width, out, kinds);
			}
		}
		if (out.length === 0) {
			out.push(th.fg("dim", m.items.length === 0 ? "  ждём первую запись сессии…" : "  под фильтр ничего не попало"));
			kinds.push(".");
		}
		this.matchStarts = matchStarts;
		this.lineKinds = kinds;
		return out;
	}
}
