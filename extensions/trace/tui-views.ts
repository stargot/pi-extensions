/**
 * Виды TUI-оверлея trace — чистые построители строк по модели ядра:
 * Timeline (эры, ходы, брошенные ветки), Flow (главный агент и субагенты),
 * Context (состав и дифф контекста хода), инспектор и полоса эр.
 * Без терминала и ввода: TraceView (graph.ts) режет строки по ширине и скроллу.
 *
 * kinds — класс каждой строки для мини-карты: E ошибка, R идёт, U промпт,
 * C субагент, B команда, t ход, «.» служебная.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chip } from "../shared/chip.ts";
import { CONTEXT_ROLES, type ContextRole, diffContext, projectContext } from "./core/context.ts";
import { cacheHit, type Era, promptTokens, type SessionView, type Turn } from "./core/model.ts";
import { fmtClock, fmtDur, fmtK, fmtMoney, oneLine } from "./core/text.ts";
import type { SessionTree } from "./core/tree.ts";

export interface Th {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold(text: string): string;
}

export interface Built {
	lines: string[];
	kinds: string[];
	/** Строки, с которых начинаются элементы под фильтром (n/N). */
	matchStarts: number[];
	/** Строка заголовка хода по entryId — прокрутка к выбранному ходу. */
	anchors: Map<string, number>;
	/** В кадре есть идущий инструмент — спиннер надо анимировать. */
	running: boolean;
}

/** Состояние субагента для Flow: ссылка trace:subagents или живой воркер + его сессия. */
export interface ChildState {
	name: string;
	task: string;
	model?: string;
	state: "running" | "ok" | "error";
	turns: number;
	out: number;
	cost: number;
	/** Идущий или последний инструмент. */
	tool?: string;
	elapsedMs?: number;
	session?: string;
}

export const MARKER_ICON: Record<string, string> = {
	compaction: "↻",
	branch: "⑂",
	label: "⚑",
	model: "⚙",
	thinking: "✦",
	edit: "✎",
};

const ROLE_FG: Record<ContextRole, string> = {
	system: "dim",
	user: "userMessageText",
	assistant: "thinkingText",
	toolResult: "toolTitle",
	bash: "bashMode",
	custom: "success",
	summary: "muted",
};

const BLOCKS = "▁▂▃▄▅▆▇█";
const pct = (x: number) => `${Math.round(x * 100)}%`;

function built(): Built {
	return { lines: [], kinds: [], matchStarts: [], anchors: new Map(), running: false };
}

function push(b: Built, line: string, kind = "."): void {
	b.lines.push(line);
	b.kinds.push(kind);
}

/** Строка «слева … справа» ровно в width (или обрезанная). */
export function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(`${left} ${right}`, width);
}

/** Перенос по словам в строки не шире width, не больше max строк (последняя — с «…»). */
export function wrap(text: string, width: number, max: number): string[] {
	const words = oneLine(text, 4000).split(" ").filter(Boolean);
	const out: string[] = [];
	let cur = "";
	for (const w of words) {
		const next = cur ? `${cur} ${w}` : w;
		if (visibleWidth(next) <= width) cur = next;
		else {
			if (cur) out.push(cur);
			cur = visibleWidth(w) > width ? truncateToWidth(w, width) : w;
		}
		if (out.length >= max) break;
	}
	if (cur && out.length < max) out.push(cur);
	if (out.length === max && words.join(" ").length > out.join(" ").length) {
		out[max - 1] = truncateToWidth(`${out[max - 1]}…`, width);
	}
	return out;
}

export function turnState(v: SessionView, t: Turn): "running" | "error" | "ok" {
	if (t.tools.some((x) => x.status === "running")) return "running";
	if (v.running && t === v.turns.at(-1)) return "running";
	if (t.stopReason === "error" || t.tools.some((x) => x.status === "error")) return "error";
	return "ok";
}

const stateColor = (s: string) => (s === "running" ? "accent" : s === "error" ? "error" : "success");

function eraRange(era: Era): string {
	const a = era.turns[0]?.index;
	const b = era.turns.at(-1)?.index;
	return a === undefined ? "без ходов" : a === b ? `T${a}` : `T${a}–T${b}`;
}

// ---------- фильтр ----------

export interface Filter {
	query: string;
	errorsOnly: boolean;
}

function turnBad(t: Turn): boolean {
	return Boolean(t.errorMessage) || t.stopReason === "error" || t.tools.some((x) => x.status === "error");
}

function turnHay(t: Turn): string {
	return `${t.text ?? ""} ${t.thinking ?? ""} ${t.model ?? ""} ${t.errorMessage ?? ""} ${t.tools.map((x) => `${x.name} ${x.label}`).join(" ")}`;
}

function passes(f: Filter, hay: string, bad: boolean): boolean {
	if (f.errorsOnly && !bad) return false;
	return !f.query || hay.toLowerCase().includes(f.query.toLowerCase());
}

const active = (f: Filter) => Boolean(f.query) || f.errorsOnly;

// ---------- Timeline ----------

export interface TimelineOpts {
	filter: Filter;
	spin: string;
	selId?: string;
}

/** Карточка хода: заголовок, чипы инструментов, рассуждение, ответ, ошибка. */
function turnCard(b: Built, v: SessionView, t: Turn, th: Th, width: number, o: TimelineOpts): void {
	const inner = Math.max(8, width - 4);
	const st = turnState(v, t);
	const ends = t.tools.map((x) => x.endMs).filter((x): x is number => x !== undefined);
	const end = Math.max(t.endMs, ...ends);
	const sel = t.entryId === o.selId;
	const title = [
		`T${t.index}`,
		fmtClock(t.startMs),
		end > t.startMs ? fmtDur(end - t.startMs) : "",
		t.model ?? "",
		t.tokens.output ? `↓${fmtK(t.tokens.output)}` : "",
		fmtMoney(t.cost),
		t.stopReason === "aborted" ? "aborted" : "",
		st === "running" ? "working" : "",
	]
		.filter(Boolean)
		.join(" · ");
	b.anchors.set(t.entryId, b.lines.length);
	push(b, `${sel ? th.fg("accent", " ❯ ") : "   "}${th.fg(sel ? "text" : "dim", title)}`, st === "running" ? "R" : "t");
	for (const c of t.tools) {
		const glyph =
			c.status === "ok"
				? th.fg("success", "✓")
				: c.status === "error"
					? th.fg("error", "✗")
					: th.fg("accent", `${o.spin} running`);
		if (c.status === "running") b.running = true;
		const badge = chip(
			th as any,
			`⚒ ${c.name}`,
			c.status === "error"
				? { fg: "error", bg: "toolErrorBg" }
				: c.status === "running"
					? { fg: "accent", bg: "toolPendingBg" }
					: { fg: "toolTitle", bg: "toolSuccessBg" },
		);
		const dur = c.endMs !== undefined ? fmtDur(c.endMs - c.startMs) : "";
		push(
			b,
			`   ${spread(`${badge} ${th.fg("dim", c.label)}`, `${th.fg("muted", dur)} ${glyph}`, inner)}`,
			c.status === "error" ? "E" : c.status === "running" ? "R" : "t",
		);
	}
	if (t.thinking) push(b, `   ${th.fg("muted", `⋮ ${t.thinking}`)}`, "t");
	if (t.text) push(b, `   ${th.fg("text", `«${t.text}»`)}`, "t");
	if (t.errorMessage) push(b, `   ${th.fg("error", `✗ ${oneLine(t.errorMessage, inner - 2)}`)}`, "E");
}

/** Элементы эры в порядке времени: ходы, маркеры, команды, субагенты. */
type EraItem =
	| { ts: number; kind: "turn"; turn: Turn }
	| { ts: number; kind: "marker"; icon: string; text: string }
	| { ts: number; kind: "shell"; command: string; exitCode?: number }
	| { ts: number; kind: "child"; agent: string; task: string; session: string; out?: number; cost?: number };

function eraItems(era: Era): EraItem[] {
	const items: EraItem[] = [
		...era.turns.map((turn) => ({ ts: turn.startMs, kind: "turn" as const, turn })),
		...era.markers.map((m) => ({ ts: m.ts, kind: "marker" as const, icon: MARKER_ICON[m.kind] ?? "·", text: m.text })),
		...era.shell.map((c) => ({ ts: c.ts, kind: "shell" as const, command: c.command, exitCode: c.exitCode })),
		...era.children.map((c) => ({
			ts: c.ts,
			kind: "child" as const,
			agent: c.agent,
			task: c.task,
			session: c.session,
			out: c.tokensOut,
			cost: c.cost,
		})),
	];
	return items.sort((a, b) => a.ts - b.ts);
}

export function timelineLines(v: SessionView, th: Th, width: number, o: TimelineOpts): Built {
	const b = built();
	const f = o.filter;
	const hostOf = (forkTurn: number) => {
		let host = v.eras[0];
		for (const e of v.eras) if (e.turns.length && e.turns[0]!.index <= forkTurn) host = e;
		return host;
	};
	for (const era of v.eras) {
		const items = eraItems(era).filter((it) =>
			it.kind === "turn"
				? passes(f, turnHay(it.turn), turnBad(it.turn))
				: it.kind === "shell"
					? passes(f, it.command, it.exitCode !== undefined && it.exitCode !== 0)
					: it.kind === "child"
						? passes(f, `${it.agent} ${it.task} ${it.session}`, false)
						: passes(f, it.text, false),
		);
		const promptHit = passes(f, era.prompt, false);
		if (active(f) && items.length === 0 && !promptHit) continue;

		push(b, th.fg("borderMuted", "  │"));
		if (!active(f) || promptHit) b.matchStarts.push(b.lines.length);
		const label = era.index ? `эра ${era.index}` : "до промпта";
		const meta = [eraRange(era), fmtDur(era.endMs - era.startMs), fmtMoney(era.cost)].filter(Boolean).join(" · ");
		push(
			b,
			spread(
				`${th.fg("accent", "━")} ${th.fg("accent", label)} ${th.fg("userMessageText", era.prompt ? oneLine(era.prompt, 200) : "")}`,
				th.fg("dim", meta),
				width,
			),
			"U",
		);
		for (const it of items) {
			if (active(f)) b.matchStarts.push(b.lines.length);
			if (it.kind === "turn") turnCard(b, v, it.turn, th, width, o);
			else if (it.kind === "marker") push(b, `  ${th.fg("muted", `├ ${it.icon} ${it.text}`)}`);
			else if (it.kind === "shell") {
				const bad = it.exitCode !== undefined && it.exitCode !== 0;
				push(
					b,
					`  ${th.fg("bashMode", "$")} ${th.fg("dim", it.command)}${bad ? ` ${th.fg("error", `exit ${it.exitCode}`)}` : ""}`,
					bad ? "E" : "B",
				);
			} else {
				const meta2 = [it.out ? `↓${fmtK(it.out)}` : "", it.cost ? fmtMoney(it.cost) : ""].filter(Boolean).join(" · ");
				push(b, `  ${th.fg("toolTitle", `⧉ ${it.agent}`)} ${th.fg("text", it.task)}`, "C");
				push(b, `    ${th.fg("dim", `${meta2 ? `${meta2} · ` : ""}→ /trace ${it.session}`)}`, "C");
			}
		}
		for (const br of v.branches) {
			if (hostOf(br.forkTurn) !== era || active(f)) continue;
			const bar = th.fg("dim", "  ┆ ");
			push(
				b,
				`${bar}${th.fg("muted", `⑂ ответвление от T${br.forkTurn} · брошена${br.cost ? ` · ${fmtMoney(br.cost)}` : ""}`)}`,
			);
			if (br.summary) push(b, `${bar}${th.fg("dim", `branch_summary: ${br.summary}`)}`);
			for (const be of br.eras) {
				if (be.prompt) push(b, `${bar}${th.fg("muted", `«${oneLine(be.prompt, 160)}»`)}`);
				for (const t of be.turns) {
					b.anchors.set(t.entryId, b.lines.length);
					const sel = t.entryId === o.selId;
					const tools = t.tools.map((x) => x.name).join(", ");
					push(
						b,
						`${bar}${sel ? th.fg("accent", "❯ ") : "  "}${th.fg("dim", [`T${t.index}`, t.model ?? "", `↓${fmtK(t.tokens.output)}`, tools].filter(Boolean).join(" · "))}`,
					);
				}
			}
		}
	}
	if (b.lines.length === 0) {
		push(b, th.fg("dim", v.eras.length === 0 ? "  ждём первую запись сессии…" : "  под фильтр ничего не попало"));
	}
	return b;
}

// ---------- Flow ----------

function box(title: string, body: string[], color: string, th: Th, width: number): string[] {
	const w = Math.max(16, Math.min(width, 48));
	const inner = w - 4;
	const head = truncateToWidth(`╭ ${title} `, w - 1);
	const top = `${head}${"─".repeat(Math.max(0, w - 1 - visibleWidth(head)))}╮`;
	const rows = body.map((l) => {
		const cut = truncateToWidth(l, inner);
		return `${th.fg(color, "│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${th.fg(color, "│")}`;
	});
	return [th.fg(color, top), ...rows, th.fg(color, `╰${"─".repeat(w - 2)}╯`)];
}

export function flowLines(
	v: SessionView,
	children: ChildState[],
	th: Th,
	width: number,
	o: { spin: string; nowMs: number },
): Built {
	const b = built();
	const last = v.turns.at(-1);
	const st = last ? turnState(v, last) : "ok";
	const running = last?.tools.find((x) => x.status === "running");
	if (running) b.running = true;
	const color = v.running || running ? "accent" : stateColor(st);
	const stateText = v.running || running ? `работает · T${last?.index ?? 0}` : st === "error" ? "ошибка" : "ждёт";
	const now = running
		? `${th.fg("accent", `⚒ ${running.name}`)} ${running.label} ${fmtDur(o.nowMs - running.startMs)} ${th.fg("accent", o.spin)}`
		: last
			? th.fg(
					"dim",
					oneLine(last.errorMessage || last.text || last.tools.map((x) => `⚒ ${x.name}`).join(" ") || "", 60),
				)
			: th.fg("dim", "нет ходов");
	const out = v.turns.reduce((s, t) => s + t.tokens.output, 0);
	const cost = v.turns.reduce((s, t) => s + t.cost, 0);
	const main = box(
		`pi · ${last?.model ?? "?"}`,
		[
			`${th.fg(color, "●")} ${stateText}`,
			now,
			th.fg("dim", [`${v.turns.length} ход.`, `↓${fmtK(out)}`, fmtMoney(cost)].filter(Boolean).join(" · ")),
		],
		color,
		th,
		width - 2,
	);
	for (const l of main) push(b, `  ${l}`, color === "error" ? "E" : color === "accent" ? "R" : "t");

	// Инструменты пути, свёрнутые по имени: ⚒ bash×9 ✗1.
	const by = new Map<string, { n: number; err: number; run: number }>();
	for (const t of v.turns)
		for (const x of t.tools) {
			const c = by.get(x.name) ?? { n: 0, err: 0, run: 0 };
			c.n++;
			if (x.status === "error") c.err++;
			if (x.status === "running") c.run++;
			by.set(x.name, c);
		}
	const chips = [...by.entries()]
		.sort((a, z) => z[1].n - a[1].n)
		.map(
			([name, c]) =>
				`${th.fg("toolTitle", `⚒ ${name}`)}${th.fg("dim", `×${c.n}`)} ${c.run ? th.fg("accent", o.spin) : c.err ? th.fg("error", `✗${c.err}`) : th.fg("success", "✓")}`,
		);
	let row = "  ";
	for (const c of chips) {
		if (visibleWidth(row) + visibleWidth(c) + 2 > width && row.trim()) {
			push(b, row, "t");
			row = "  ";
		}
		row += `${c}  `;
	}
	if (row.trim()) push(b, row, "t");

	if (children.length === 0) {
		push(b, "");
		push(b, th.fg("dim", "  Субагентов в этой сессии нет."));
		return b;
	}
	push(b, `  ${th.fg("borderMuted", "┃")}`);
	children.forEach((c, i) => {
		const lastChild = i === children.length - 1;
		const color2 = stateColor(c.state);
		if (c.state === "running") b.running = true;
		const head =
			c.state === "running"
				? `● ${c.elapsedMs !== undefined ? fmtDur(c.elapsedMs) : ""}`
				: c.state === "error"
					? "✗"
					: "✓";
		const stats = [c.turns ? `${c.turns} ход.` : "", c.out ? `↓${fmtK(c.out)}` : "", fmtMoney(c.cost)]
			.filter(Boolean)
			.join(" · ");
		const body = [
			th.fg("text", c.task),
			c.tool ? `${th.fg("toolTitle", `⚒ ${c.tool}`)}${c.state === "running" ? ` ${th.fg("accent", o.spin)}` : ""}` : "",
			th.fg("dim", stats),
		].filter(Boolean);
		const card = box(`${c.name} ${head}${c.model ? ` · ${c.model}` : ""}`, body, color2, th, width - 8);
		card.forEach((l, j) => {
			const stem = j === 0 ? (lastChild ? "┗━━ " : "┣━━ ") : lastChild ? "    " : "┃   ";
			push(b, `  ${th.fg("borderMuted", stem)}${l}`, c.state === "error" ? "E" : c.state === "running" ? "R" : "C");
		});
	});
	return b;
}

// ---------- Context ----------

export function contextLines(v: SessionView, tree: SessionTree, th: Th, width: number, selId?: string): Built {
	const b = built();
	const all = [...v.turns, ...v.branches.flatMap((br) => br.eras.flatMap((e) => e.turns))];
	const turn = all.find((t) => t.entryId === selId) ?? v.turns.at(-1);
	if (!turn) {
		push(b, th.fg("dim", "  ходов пока нет — контекст появится после первого ответа модели"));
		return b;
	}
	const list = v.turns.includes(turn)
		? v.turns
		: (v.branches.find((br) => br.eras.some((e) => e.turns.includes(turn)))?.eras.flatMap((e) => e.turns) ?? []);
	const prev = list[list.indexOf(turn) - 1];
	const partsOf = (t: Turn) => {
		const parent = tree.get(t.entryId)?.parentId ?? null;
		return parent ? projectContext(tree.path(parent)) : [];
	};
	const parts = partsOf(turn);
	const diff = diffContext(prev ? partsOf(prev) : [], parts);
	const prompt = promptTokens(turn.tokens);
	const total = parts.reduce((s, p) => s + p.chars, 0) || 1;
	const scale = prompt > 0 ? prompt / total : 1 / 4;
	const hit = cacheHit(turn.tokens);

	push(b, "");
	push(
		b,
		` ${th.bold(`Контекст хода T${turn.index}`)} ${th.fg("dim", `${fmtK(prompt)} токенов · ${parts.length} сообщений${prev ? ` · Δ${prompt - promptTokens(prev.tokens) >= 0 ? "+" : ""}${fmtK(prompt - promptTokens(prev.tokens))} к T${prev.index}` : ""}`)}`,
	);
	// Полоса состава: доля каждой роли — блок своего цвета.
	const barW = Math.max(10, width - 4);
	const chars: Record<string, number> = {};
	for (const p of parts) chars[p.role] = (chars[p.role] ?? 0) + p.chars;
	let bar = "";
	let used = 0;
	const roles = CONTEXT_ROLES.filter((r) => (chars[r] ?? 0) > 0);
	roles.forEach((r, i) => {
		const n = i === roles.length - 1 ? barW - used : Math.round(((chars[r] ?? 0) / total) * barW);
		if (n <= 0) return;
		bar += th.fg(ROLE_FG[r], "█".repeat(n));
		used += n;
	});
	push(b, ` ${bar}`);
	if (hit !== null) {
		const at = Math.min(barW - 1, Math.round(hit * barW));
		const label = `cache hit ${pct(hit)}`;
		// Подпись справа от отметки, а у правого края — слева от неё.
		push(
			b,
			at + 2 + label.length <= barW
				? ` ${" ".repeat(at)}${th.fg("text", `┴ ${label}`)}`
				: ` ${" ".repeat(Math.max(0, at - label.length - 1))}${th.fg("text", `${label} ┴`)}`,
		);
	}
	push(
		b,
		` ${roles
			.filter((r) => (chars[r] ?? 0) / total >= 0.005)
			.map((r) => `${th.fg(ROLE_FG[r], "■")} ${th.fg("dim", `${r} ${pct((chars[r] ?? 0) / total)}`)}`)
			.join("  ")}`,
	);

	const upto = list.slice(Math.max(0, list.indexOf(turn) - 19), list.indexOf(turn) + 1);
	const spark = upto
		.map((t) => {
			const h = cacheHit(t.tokens);
			const glyph = BLOCKS[Math.min(7, Math.max(0, Math.round((h ?? 0) * 7)))]!;
			return th.fg(h === null ? "dim" : h >= 0.7 ? "accent" : h >= 0.4 ? "warning" : "error", glyph);
		})
		.join("");
	push(b, "");
	push(b, ` ${th.fg("dim", `cache hit, ${upto.length} ход.`)}  ${spark}`);

	push(b, "");
	push(
		b,
		` ${th.fg("toolTitle", prev ? `Дифф T${prev.index} → T${turn.index}` : `T${turn.index}: весь контекст новый`)} ${th.fg("dim", `· общий префикс ${diff.prefix} · +${diff.added.length} ~${diff.changed.length} −${diff.removed.length}`)}`,
	);
	const row = (g: string, color: string, p: { text: string; chars: number }, kind: string) =>
		push(
			b,
			` ${th.fg(color, g)} ${spread(th.fg("text", p.text), th.fg("dim", `~${fmtK(p.chars * scale)}`), width - 4)}`,
			kind,
		);
	const CAP = 40;
	for (const p of diff.changed.slice(0, CAP)) row("~", "warning", p, "R");
	for (const p of diff.added.slice(0, CAP)) row("+", "success", p, "U");
	for (const p of diff.removed.slice(0, CAP)) row("−", "error", p, "E");
	const hidden =
		Math.max(0, diff.changed.length - CAP) +
		Math.max(0, diff.added.length - CAP) +
		Math.max(0, diff.removed.length - CAP);
	if (hidden) push(b, th.fg("dim", `   ⋮ ещё ${hidden}`));
	if (prev && diff.added.length + diff.changed.length + diff.removed.length === 0)
		push(b, th.fg("dim", "   контекст не изменился"));
	push(b, "");
	push(b, th.fg("dim", " размеры — оценка по символам, масштабированная к реальному промпту хода"));
	return b;
}

// ---------- Инспектор ----------

export function inspectorLines(
	v: SessionView,
	th: Th,
	width: number,
	selId: string | undefined,
	nowMs: number,
	spin: string,
): string[] {
	const out: string[] = [];
	const w = Math.max(10, width - 1);
	const all = [...v.turns, ...v.branches.flatMap((br) => br.eras.flatMap((e) => e.turns))];
	const t = all.find((x) => x.entryId === selId) ?? v.turns.at(-1);
	if (!t) return [th.fg("dim", "нет ходов")];
	const era = [...v.eras, ...v.branches.flatMap((br) => br.eras)].find((e) => e.turns.includes(t));
	const st = turnState(v, t);
	const sect = (s: string) => out.push("", th.fg("dim", s));
	out.push(
		spread(
			`${th.fg(stateColor(st), "●")} ${th.bold(`T${t.index}`)} ${th.fg("dim", t.model ?? "")}`,
			th.fg(stateColor(st), st === "running" ? `идёт ${spin}` : st === "error" ? "ошибка" : fmtClock(t.startMs)),
			w,
		),
	);
	if (!v.turns.includes(t)) out.push(th.fg("dim", "⑂ ход брошенной ветки"));
	if (era?.prompt) {
		sect("промпт");
		for (const l of wrap(era.prompt, w, 3)) out.push(l);
	}
	const hit = cacheHit(t.tokens);
	sect("ход");
	out.push(
		`↑${fmtK(promptTokens(t.tokens))}${hit === null ? "" : ` ${th.fg(hit < 0.4 ? "warning" : "accent", `hit ${pct(hit)}`)}`}  ↓${fmtK(t.tokens.output)}`,
	);
	out.push(
		th.fg(
			"dim",
			[`генер. ${fmtDur(t.endMs - t.startMs) || "—"}`, fmtMoney(t.cost), t.stopReason ?? ""].filter(Boolean).join("  "),
		),
	);
	if (t.tools.length) {
		sect("вызовы");
		for (const x of t.tools) {
			const end = x.endMs ?? (x.status === "running" ? nowMs : undefined);
			const mark =
				x.status === "running"
					? th.fg("accent", spin)
					: x.status === "error"
						? th.fg("error", "✗")
						: th.fg("success", "✓");
			out.push(
				spread(
					`${th.fg("toolTitle", x.name)} ${th.fg("dim", x.label)}`,
					`${end ? fmtDur(end - x.startMs) : ""} ${mark}`,
					w,
				),
			);
		}
	}
	if (t.thinking) {
		sect("рассуждение");
		for (const l of wrap(t.thinking, w - 2, 4)) out.push(th.fg("muted", `⋮ ${l}`));
	}
	if (t.text) {
		sect("ответ");
		for (const l of wrap(t.text, w, 4)) out.push(l);
	}
	if (t.errorMessage) {
		sect("ошибка");
		for (const l of wrap(t.errorMessage, w, 3)) out.push(th.fg("error", l));
	}
	return out.map((l) => truncateToWidth(l, w));
}

// ---------- полоса эр ----------

/** «эры ▁▂▅│↻▂▃│⑂…» — столбики ходов по эрам, маркеры у начала эры, выбранный ход — ▌. */
export function eraStrip(v: SessionView, th: Th, width: number, selId: string | undefined, right: string): string {
	const maxOut = Math.max(1, ...v.turns.map((t) => t.tokens.output));
	const cells: string[] = [];
	v.eras.forEach((era, i) => {
		if (i > 0) cells.push(th.fg("borderMuted", "│"));
		const mk = era.markers.find((m) => m.kind === "compaction" || m.kind === "branch" || m.kind === "label");
		if (mk) cells.push(th.fg("muted", MARKER_ICON[mk.kind]!));
		for (const t of era.turns) {
			if (t.entryId === selId) {
				cells.push(th.fg("text", "▌"));
				continue;
			}
			const glyph = BLOCKS[Math.min(7, Math.round(Math.sqrt(t.tokens.output / maxOut) * 7))]!;
			const st = turnState(v, t);
			cells.push(th.fg(st === "running" ? "accent" : st === "error" ? "error" : "toolTitle", glyph));
		}
	});
	const label = th.fg("dim", "эры ");
	const room = Math.max(0, width - visibleWidth(label) - visibleWidth(right) - 2);
	// Длинная сессия: показываем хвост, где обычно выбранный ход и живой край.
	const shown = cells.length > room ? [th.fg("dim", "…"), ...cells.slice(cells.length - room + 1)] : cells;
	return spread(`${label}${shown.join("")}`, right, width);
}
