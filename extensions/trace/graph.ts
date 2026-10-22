/**
 * trace — TUI-оверлей сессии на ядре trace (core/): дерево записей по parentId,
 * эры промптов, брошенные ветки, контекст запроса как его собирает pi.
 * Режимы: live (follow за хвостом файла) и replay (проигрывание по timestamp'ам).
 *
 * Раскладка: шапка (итоги, разбивка времени, бейдж) · вкладки 1 Flow / 2 Timeline /
 * 3 Context · тело (ScrollView + мини-карта, справа — инспектор выбранного хода
 * на широком терминале) · полоса эр · подсказки с позицией n/total.
 * На низком терминале вкладки и полоса эр прячутся — тело важнее.
 *
 * Виды строятся чистыми функциями tui-views.ts; здесь — данные, ввод, скролл.
 * Клавиши действий — action'ы ext.trace.* из shared/keybindings.ts
 * (переопределяются в <agentDir>/keybindings.json); скролл и esc/ctrl+c — литерально.
 * Колесо мыши приходит в handleMouse через dispatchMouseToLayout; { handled: true }
 * не пускает routeWheel хоста до transcript'а.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
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
import { actionHint, getExtKeybindings, matchAction, matchActionIndex } from "../shared/keybindings.ts";
import { resolveSessionsDir } from "../shared/sessions.ts";
import { readRunningWorkers, runningIndexPath } from "../subagents/running-index.ts";
import { deriveSession, type SessionView } from "./core/model.ts";
import { fmtClock, fmtK, fmtMoney, oneLine } from "./core/text.ts";
import { SessionTree } from "./core/tree.ts";
import {
	type Built,
	type ChildState,
	contextLines,
	eraStrip,
	flowLines,
	inspectorLines,
	spread,
	type Th,
	timelineLines,
	turnState,
} from "./tui-views.ts";

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Ширина мини-карты: колонка силуэта + колонка позиции вьюпорта. */
const MAP = 2;
/** С этой ширины справа появляется инспектор выбранного хода. */
const INSPECTOR_MIN_WIDTH = 110;
/** Ниже этой высоты вкладки и полоса эр прячутся. */
const COMPACT_ROWS = 14;
// класс строки ленты: вес для выборки и цвет на карте
const KIND_WEIGHT: Record<string, number> = { E: 5, R: 4, U: 3, C: 2, B: 2, t: 1, ".": 0 };
const MAP_COLOR: Record<string, string> = {
	E: "error",
	R: "accent",
	U: "userMessageText",
	C: "toolTitle",
	B: "muted",
	// R9-контраст: dim на светлой system-теме 2.83:1 (<3, гейт аудита силуэта) — muted
	// (совпадает с B: оба «тихие» виды строк, различие весов выборки сохраняется).
	t: "muted",
};

type ViewMode = "flow" | "timeline" | "context";
const VIEW_LABEL: Record<ViewMode, string> = { flow: "1 Flow", timeline: "2 Timeline", context: "3 Context" };

interface TuiLike {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

/** Состояние субагента из его сессии: ходы, текущий инструмент, ошибка. */
function childFromSession(file: string): Omit<ChildState, "name" | "task"> | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const tree = new SessionTree();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			tree.add(JSON.parse(line));
		} catch {
			// недописанная строка
		}
	}
	const v = deriveSession(tree);
	const last = v.turns.at(-1);
	const running = last?.tools.find((x) => x.status === "running");
	return {
		model: last?.model,
		state: v.running ? "running" : last && turnState(v, last) === "error" ? "error" : "ok",
		turns: v.turns.length,
		out: v.turns.reduce((s, t) => s + t.tokens.output, 0),
		cost: v.totals.cost,
		tool: running ? `${running.name} ${running.label}` : last?.tools.at(-1)?.name,
		session: file,
	};
}

export class TraceView {
	private tui: TuiLike;
	private theme: Th;
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
	private tree = new SessionTree();
	private fedCount = 0;
	private byteOffset = 0;
	private pending = "";
	/** Держит неполный UTF-8-символ на границе чтения до следующего poll. */
	private decoder = new StringDecoder("utf8");
	/** Модель ядра на текущем дереве; пересчёт — только при смене revision. */
	private derived: { rev: number; v: SessionView } | undefined;

	private playheadMs = 0;
	private speed = 8;
	private paused = false;
	private follow: boolean;
	private lastTick = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	private viewMode: ViewMode = "timeline";
	private viewBeforeContext: ViewMode = "timeline";
	/** Выбранный ход (entryId); undefined — прилипает к последнему ходу. */
	private selId: string | undefined;
	private inspectorOn = true;
	private matchCursor = -1; // индекс последнего совпадения, к которому прыгали (n/N)
	private filterQ = ""; // активный фильтр подстроки
	private editing = false; // идёт ввод фильтра
	private errorsOnly = false; // режим «только ошибки»
	private summary = false; // сводка по моделям вместо ленты
	private cache:
		| (Built & {
				key: string;
				/** Кадр спиннера, с которым собраны строки; null — идущих инструментов нет. */
				spinFrame: string | null;
		  })
		| undefined;
	private children: { at: number; list: ChildState[] } | undefined;
	/** Клавиши ext.*: свой менеджер с definitions расширений (см. shared/keybindings.ts). */
	private readonly kb = getExtKeybindings();

	/** Вьюпорт: нарезает кэш ленты по scrollTop (в оверлее layout-движка нет). */
	private readonly viewport: Component = {
		render: (_width: number) => {
			const lines = this.cache?.lines ?? [];
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
					const w = KIND_WEIGHT[kinds[i]!] ?? 0;
					if (w > bestW) {
						bestW = w;
						bestK = kinds[i]!;
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
	/** Инспектор: строки на текущий кадр, слева — разделитель. */
	private inspector: string[] = [];
	private readonly inspectorComp: Component = {
		render: (width: number) => {
			const out: string[] = [];
			const bar = this.theme.fg("borderMuted", "│ ");
			for (let r = 0; r < this.mapState.body; r++) {
				out.push(`${bar}${truncateToWidth(this.inspector[r] ?? "", Math.max(0, width - 2))}`);
			}
			return out;
		},
		invalidate: () => {},
	};

	constructor(opts: {
		tui: TuiLike;
		theme: Th;
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
				this.decoder = new StringDecoder("utf8");
				this.entries = [];
				this.resetTree();
			}
			if (size === this.byteOffset) return false;
			const buf = Buffer.alloc(size - this.byteOffset);
			readSync(fd, buf, 0, buf.length, this.byteOffset);
			this.byteOffset = size;
			const lines = (this.pending + this.decoder.write(buf)).split("\n");
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

	private resetTree(): void {
		this.tree = new SessionTree();
		this.fedCount = 0;
		this.cache = undefined;
	}

	private feedOne(): void {
		if (this.fedCount >= this.entries.length) return;
		this.tree.add(this.entries[this.fedCount]!.e);
		this.fedCount++;
	}

	private feedAvailable(): void {
		while (this.fedCount < this.entries.length) this.feedOne();
		if (this.entries.length > 0) {
			this.playheadMs = Math.max(this.playheadMs, this.entries[this.entries.length - 1]!.ms);
		}
	}

	private seekTo(ms: number): void {
		let lo = 0;
		let hi = this.entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.entries[mid]!.ms <= ms) lo = mid + 1;
			else hi = mid;
		}
		this.resetTree();
		for (let i = 0; i < lo; i++) this.feedOne();
		// Плейхед — ровно в цель (в границах сессии), а не на последнюю скормленную
		// запись: иначе при паузе >5с между записями → откатывал его назад и залипал.
		const first = this.entries[0]?.ms ?? ms;
		const last = this.entries[this.entries.length - 1]?.ms ?? ms;
		this.playheadMs = Math.min(last, Math.max(first, ms));
	}

	/** Модель ядра на скормленном дереве. now — для идущих инструментов. */
	private view(): SessionView {
		if (this.derived?.rev !== this.tree.revision) {
			const now = this.mode === "live" || this.follow ? Date.now() : this.playheadMs;
			this.derived = { rev: this.tree.revision, v: deriveSession(this.tree, this.tree.leafId, now) };
		}
		return this.derived.v;
	}

	/** Субагенты для Flow: ссылки trace:subagents + живые воркеры, состояние — из их сессий. Раз в секунду. */
	private childStates(v: SessionView): ChildState[] {
		const now = Date.now();
		if (this.children && now - this.children.at < 1000) return this.children.list;
		let workers: { sessionFile: string; label: string; task?: string; startedAt: number }[] = [];
		try {
			workers = readRunningWorkers(runningIndexPath(join(resolveSessionsDir(), "subagents"))).workers;
		} catch {
			// индекс subagents опционален
		}
		const live = new Map(workers.map((w) => [w.sessionFile, w]));
		const seen = new Set<string>();
		const list: ChildState[] = [];
		for (const link of v.children) {
			seen.add(link.session);
			const fromFile = childFromSession(link.session);
			const w = live.get(link.session);
			list.push({
				name: link.agent,
				task: link.task,
				model: link.model,
				state: w ? "running" : "ok",
				turns: 0,
				out: link.tokensOut ?? 0,
				cost: link.cost ?? 0,
				session: link.session,
				...fromFile,
				...(w ? { state: "running" as const, elapsedMs: now - w.startedAt } : {}),
			});
		}
		for (const w of workers) {
			if (seen.has(w.sessionFile)) continue;
			// Живой воркер этой сессии ещё не записал карточку: показываем по индексу,
			// если его сессия началась не раньше нашей.
			const started = this.entries[0]?.ms ?? 0;
			if (w.startedAt < started) continue;
			const fromFile = childFromSession(w.sessionFile);
			list.push({
				name: w.label,
				task: w.task ?? "",
				turns: 0,
				out: 0,
				cost: 0,
				...fromFile,
				state: "running",
				elapsedMs: now - w.startedAt,
				session: w.sessionFile,
			});
		}
		this.children = { at: now, list };
		return list;
	}

	private tick(): void {
		if (this.closed) return;
		const now = Date.now();
		const dt = now - this.lastTick;
		this.lastTick = now;
		const fedBefore = this.fedCount;
		const treeBefore = this.tree;
		const grew = this.poll();
		if (this.mode === "live" || this.follow) {
			this.feedAvailable();
		} else if (!this.paused) {
			this.playheadMs += dt * this.speed;
			while (this.fedCount < this.entries.length && this.entries[this.fedCount]!.ms <= this.playheadMs) {
				this.feedOne();
			}
			if (this.fedCount >= this.entries.length && grew) {
				this.poll(); // догнать дозапись на «живом» краю replay
			}
		}
		// Перерисовка всего TUI хоста — только когда кадр изменился: новые записи
		// (шапка считает entries), скормленное/пересобранное дерево или крутящийся
		// спиннер идущего инструмента.
		const spinning = this.cache?.spinFrame != null;
		if (grew || this.fedCount !== fedBefore || this.tree !== treeBefore || spinning) this.tui.requestRender();
	}

	// ---------- ввод ----------

	handleInput(data: string): void {
		const rows = this.bodyRows();

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

		if (matchesKey(data, Key.ctrl("c")) || matchAction(this.kb, data, "ext.trace.close")) {
			this.dispose();
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			// esc: сначала снимает фильтры и выбор, и только потом закрывает
			if (this.filterQ || this.errorsOnly || this.summary || this.selId || this.viewMode === "context") {
				this.filterQ = "";
				this.errorsOnly = false;
				this.summary = false;
				this.selId = undefined;
				if (this.viewMode === "context") this.viewMode = this.viewBeforeContext;
				this.matchCursor = -1;
				this.cache = undefined;
			} else {
				this.dispose();
				this.onClose();
				return;
			}
		} else if (matchAction(this.kb, data, "ext.trace.viewFlow")) {
			this.setView("flow");
		} else if (matchAction(this.kb, data, "ext.trace.viewTimeline")) {
			this.setView("timeline");
		} else if (matchAction(this.kb, data, "ext.trace.viewContext")) {
			this.setView("context");
		} else if (matchAction(this.kb, data, "ext.trace.diff")) {
			// d — контекст выбранного хода и обратно (раньше — отдельный режим диффа)
			this.setView(this.viewMode === "context" ? this.viewBeforeContext : "context");
		} else if (matchAction(this.kb, data, "ext.trace.inspector")) {
			this.inspectorOn = !this.inspectorOn;
		} else if (matchAction(this.kb, data, "ext.trace.prevTurn")) {
			this.stepTurn(-1);
		} else if (matchAction(this.kb, data, "ext.trace.nextTurn")) {
			this.stepTurn(1);
		} else if (matchAction(this.kb, data, "ext.trace.prevEra")) {
			this.stepEra(-1);
		} else if (matchAction(this.kb, data, "ext.trace.nextEra")) {
			this.stepEra(1);
		} else if (matchAction(this.kb, data, "ext.trace.filter")) {
			this.editing = true;
		} else if (matchAction(this.kb, data, "ext.trace.errors")) {
			this.errorsOnly = !this.errorsOnly;
			this.matchCursor = -1;
			this.cache = undefined;
		} else if (matchAction(this.kb, data, "ext.trace.models")) {
			this.summary = !this.summary;
			this.cache = undefined;
		} else {
			// направление — по индексу совпавшего ключа в резолвнутом списке: первая
			// клавиша — вперёд (+1), вторая и далее — назад (-1).
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

	/** Колесо мыши: { handled: true } не пускает routeWheel хоста до transcript'а. */
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

	private setView(mode: ViewMode): void {
		if (mode === this.viewMode) return;
		if (mode === "context") this.viewBeforeContext = this.viewMode;
		this.viewMode = mode;
		this.cache = undefined;
		this.matchCursor = -1;
		if (mode === "timeline" && this.follow) this.scrollView.scrollToEnd();
		else this.scrollView.scrollToStart();
	}

	/** , / . — соседний ход активного пути; выбор прокручивает Timeline к нему. */
	private stepTurn(dir: 1 | -1): void {
		const turns = this.view().turns;
		if (turns.length === 0) return;
		const cur = this.selId ? turns.findIndex((t) => t.entryId === this.selId) : turns.length - 1;
		const next = turns[Math.min(turns.length - 1, Math.max(0, (cur < 0 ? turns.length - 1 : cur) + dir))]!;
		this.select(next.entryId === turns.at(-1)?.entryId && dir === 1 ? undefined : next.entryId, next.entryId);
	}

	/** [ / ] — первая ход соседней эры. */
	private stepEra(dir: 1 | -1): void {
		const v = this.view();
		const eras = v.eras.filter((e) => e.turns.length > 0);
		if (eras.length === 0) return;
		const selId = this.selId ?? v.turns.at(-1)?.entryId;
		const cur = eras.findIndex((e) => e.turns.some((t) => t.entryId === selId));
		const era = eras[Math.min(eras.length - 1, Math.max(0, (cur < 0 ? eras.length - 1 : cur) + dir))]!;
		this.select(era.turns[0]!.entryId, era.turns[0]!.entryId);
	}

	private select(selId: string | undefined, scrollTo: string): void {
		this.selId = selId;
		this.cache = undefined;
		if (this.viewMode !== "timeline") return;
		this.render(this.tui.terminal.columns); // прогрев якорей
		// render() выше заполнил кэш; TS сужает this.cache до undefined по присваиванию.
		const at = (this.cache as Built | undefined)?.anchors.get(scrollTo);
		if (at === undefined) return;
		this.follow = false;
		this.scrollView.scrollTo(Math.max(0, at - 2), { disableFollow: true });
	}

	/** Строки терминала, доступные оверлею, с учётом резерва хоста. */
	private availRows(): number {
		return Math.max(6, this.tui.terminal.rows - this.reserveRows);
	}

	private compact(): boolean {
		return this.availRows() < COMPACT_ROWS;
	}

	/** Строки тела: минус шапка и подсказки, и (не в компактном режиме) вкладки с полосой эр. */
	private bodyRows(): number {
		return this.availRows() - 2 - (this.compact() ? 0 : 2);
	}

	/** Вьюпорт сидит на хвосте ленты (последняя строка контента видна). */
	private atTail(): boolean {
		const total = this.cache?.lines.length ?? 0;
		return this.scrollView.scrollTop >= Math.max(0, total - this.bodyRows());
	}

	/** n/N: к следующему/предыдущему совпадению фильтра (без фильтра — к соседнему элементу). */
	private jumpMatch(dir: 1 | -1): void {
		if (!this.cache) this.render(this.tui.terminal.columns);
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
					if (ms[i]! < cur) {
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

		const target = ms[this.matchCursor]!;
		this.follow = false;
		this.scrollView.scrollTo(target, { disableFollow: true });
		this.tui.requestRender();
	}

	private jumpToEnd(): void {
		this.follow = true;
		this.feedAvailable();
		if (this.viewMode === "timeline") this.scrollView.scrollToEnd();
	}

	// ---------- рендер ----------

	invalidate(): void {
		this.cache = undefined;
	}

	private spin(): string {
		return SPIN[Math.floor(Date.now() / 90) % SPIN.length]!;
	}

	private showInspector(width: number): boolean {
		return this.inspectorOn && width >= INSPECTOR_MIN_WIDTH && !this.summary;
	}

	private inspectorWidth(width: number): number {
		return Math.max(30, Math.min(48, Math.floor(width * 0.32)));
	}

	render(width: number): string[] {
		const rows = this.availRows();
		const body = this.bodyRows();
		const withInspector = this.showInspector(width);
		const inspW = withInspector ? this.inspectorWidth(width) : 0;
		const contentW = Math.max(20, width - MAP - inspW);
		const v = this.view();
		const frame = this.spin();
		const key = [
			this.viewMode,
			contentW,
			this.tree.revision,
			this.selId,
			this.filterQ,
			this.errorsOnly,
			this.summary,
		].join("|");
		const childrenStale = this.viewMode === "flow" && (!this.children || Date.now() - this.children.at >= 1000);
		if (
			!this.cache ||
			this.cache.key !== key ||
			childrenStale ||
			(this.cache.spinFrame !== null && this.cache.spinFrame !== frame)
		) {
			const built = this.build(v, contentW, frame);
			this.cache = {
				...built,
				lines: built.lines.map((l) => truncateToWidth(l, contentW)),
				key,
				spinFrame: built.running ? frame : null,
			};
		}
		const { lines, kinds } = this.cache;
		this.scrollView.updateLayout(lines.length, body, () => this.tui.requestRender());
		// follow-режим и играющий replay держат хвост ленты; стоит пользователю
		// уехать вверх — вьюпорт больше не дёргается. Flow и Context начинаются сверху.
		if (this.viewMode === "timeline" && (this.follow || (this.mode === "replay" && this.atTail()))) {
			this.scrollView.scrollToEnd();
		}
		const top = this.scrollView.scrollTop;
		this.mapState = { kinds, top, body, total: lines.length, show: lines.length > body };
		this.inspector = withInspector ? inspectorLines(v, this.theme, inspW - 2, this.selId, Date.now(), frame) : [];

		const row = new HStack([
			{ component: this.scrollView, grow: 1 },
			{ component: this.mapComp, basis: MAP, grow: 0, shrink: 0 },
			...(withInspector ? [{ component: this.inspectorComp, basis: inspW, grow: 0, shrink: 0 }] : []),
		]);
		const out = [this.header(width, top, v)];
		if (!this.compact()) out.push(this.tabs(width, withInspector ? inspW : 0));
		out.push(...row.render(width).slice(0, body));
		while (out.length < rows - 1 - (this.compact() ? 0 : 1)) out.push("");
		if (!this.compact())
			out.push(eraStrip(v, this.theme, width, this.selId ?? v.turns.at(-1)?.entryId, this.stripRight()));
		while (out.length < rows) out.push("");
		out[rows - 1] = this.footer(width, top, lines.length);
		return out.slice(0, rows).map((l) => truncateToWidth(l, width));
	}

	private build(v: SessionView, width: number, frame: string): Built {
		if (this.summary) return this.summaryLines(v, width);
		const filter = { query: this.filterQ, errorsOnly: this.errorsOnly };
		if (this.viewMode === "flow")
			return flowLines(v, this.childStates(v), this.theme, width, { spin: frame, nowMs: Date.now() });
		if (this.viewMode === "context") return contextLines(v, this.tree, this.theme, width, this.selId);
		return timelineLines(v, this.theme, width, { filter, spin: frame, selId: this.selId });
	}

	/** Правый край полосы эр: в реплее — скорость и время плейхеда. */
	private stripRight(): string {
		if (this.mode === "live" || this.follow) return "";
		return this.theme.fg("dim", `▶ ${this.speed}× · ${fmtClock(this.playheadMs)}`);
	}

	private badge(top: number): string {
		const th = this.theme;
		let b: string;
		if (this.mode === "live" || this.follow) b = th.fg("accent", th.bold("LIVE ●"));
		else if (this.paused) b = th.fg("warning", "PAUSED ⏸");
		else if (this.fedCount >= this.entries.length) b = th.fg("muted", "END");
		else b = th.fg("dim", `▶ ${this.speed}×`);
		if (this.errorsOnly) b += ` ${th.fg("error", "err-only")}`;
		if (this.filterQ) b += ` ${th.fg("accent", `«${oneLine(this.filterQ, 14)}»`)}`;
		const ms = this.cache?.matchStarts;
		if (this.matchCursor >= 0 && ms && this.matchCursor < ms.length) {
			b += ` ${th.fg("dim", `${this.matchCursor + 1}/${ms.length}`)}`;
		} else if ((this.filterQ || this.errorsOnly) && ms && ms.length) {
			let idx = 0;
			for (const s of ms) if (s <= top) idx++;
			b += ` ${th.fg("dim", `${Math.min(idx + 1, ms.length)}/${ms.length}`)}`;
		}
		return b;
	}

	private header(width: number, top: number, v: SessionView): string {
		const th = this.theme;
		const fileLabel =
			this.mode === "replay" ? oneLine(basename(this.file).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, ""), 18) : "";
		const name = v.name ? oneLine(v.name, 24) : "";
		const sep = th.fg("dim", " · ");
		const prompt = v.totals.input + v.totals.cacheRead + v.totals.cacheWrite;
		const hit = prompt > 0 && v.totals.cacheRead > 0 ? v.totals.cacheRead / prompt : null;
		// ⏱ модель / инструменты / ожидание — 10 клеток
		const t = v.time;
		let tbar = "";
		if (t.spanMs > 0) {
			const m = Math.round((t.modelMs / t.spanMs) * 10);
			const k = Math.min(10 - m, Math.round((t.toolsMs / t.spanMs) * 10));
			tbar = `⏱ ${th.fg("accent", "█".repeat(m))}${th.fg("toolTitle", "█".repeat(k))}${th.fg("dim", "█".repeat(10 - m - k))}`;
		}
		const parts = [
			` ${th.fg("accent", "◐")} ${th.bold("trace")}`,
			fileLabel && th.fg("dim", fileLabel),
			th.fg("dim", `${name ? `${name} · ` : ""}${this.entries.length} entries`),
			v.totals.cost > 0 ? fmtMoney(v.totals.cost) : "",
			`↑${fmtK(prompt)}${hit === null ? "" : ` ${th.fg("accent", `hit ${Math.round(hit * 100)}%`)}`} ↓${fmtK(v.totals.output)}`,
			tbar,
		].filter(Boolean) as string[];
		return spread(parts.join(sep), this.badge(top), width);
	}

	private tabs(width: number, inspW: number): string {
		const th = this.theme;
		const tabs = (Object.keys(VIEW_LABEL) as ViewMode[])
			.map((m) =>
				m === this.viewMode && !this.summary
					? th.bold(th.fg("accent", `[${VIEW_LABEL[m]}]`))
					: th.fg("muted", ` ${VIEW_LABEL[m]} `),
			)
			.join(" ");
		if (!inspW) return truncateToWidth(` ${tabs}`, width);
		// Подпись — ровно над колонкой инспектора.
		const left = truncateToWidth(` ${tabs}`, width - inspW);
		return `${left}${" ".repeat(Math.max(0, width - inspW - visibleWidth(left)))}${th.fg("borderMuted", "│ ")}${th.fg("dim", "инспектор")}`;
	}

	private footer(width: number, top: number, total: number): string {
		const pos = this.theme.fg("dim", `${Math.min(top + 1, total)}/${total}`);
		let hints: string;
		if (this.editing) {
			hints = ` filter: ${this.filterQ}▏ enter — применить · esc — сброс `;
		} else {
			const h = (a: Parameters<typeof actionHint>[1], label?: string) => actionHint(this.kb, a, label);
			const nav =
				this.mode === "live"
					? `↑↓ scroll · ${h("ext.trace.follow", "follow")}`
					: `space pause · ←→ seek · +/- speed · ${h("ext.trace.live", "live")} · ${h("ext.trace.restart", "restart")}`;
			hints = ` ${nav} · 1-3 вид · [ ] эра · , . ход · ${h("ext.trace.inspector", "inspector")} · ${h("ext.trace.filter", "filter")} · ${h("ext.trace.jumpMatch", "jump")} · ${h("ext.trace.errors", "errors")} · ${h("ext.trace.models", "models")} · esc · ${h("ext.trace.close", "close")} `;
		}
		const right = `${hints}${pos} `;
		const pad = width - visibleWidth(right);
		if (pad > 0) return `${" ".repeat(pad)}${right}`;
		// Узкий терминал: подсказки режем, но позиция n/total обязана дожить до
		// рендера (регресс-тест R9: footer на 25 колонках без позиции).
		const hintsWidth = Math.max(0, width - visibleWidth(pos) - 1);
		return `${truncateToWidth(hints, hintsWidth)} ${pos}`;
	}

	private summaryLines(v: SessionView, width: number): Built {
		const th = this.theme;
		const out: Built = {
			lines: ["", ` ${th.bold("Модели")}`],
			kinds: [".", "."],
			matchStarts: [],
			anchors: new Map(),
			running: false,
		};
		const rows = [...v.models.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].turns - a[1].turns);
		for (const [name, s] of rows) {
			out.lines.push(
				spread(
					` ${th.fg("toolTitle", oneLine(name, Math.max(12, width - 40)))}`,
					th.fg("dim", `${s.turns} turns · ↓${fmtK(s.output)} · ${fmtMoney(s.cost)}`),
					width,
				),
			);
			out.kinds.push(".");
		}
		if (rows.length === 0) {
			out.lines.push(th.fg("dim", " пока нет ответов модели"));
			out.kinds.push(".");
		}
		out.lines.push("", th.fg("dim", ` ${actionHint(this.kb, "ext.trace.models")} — вернуться · esc — сбросить всё`));
		out.kinds.push(".", ".");
		return out;
	}
}
