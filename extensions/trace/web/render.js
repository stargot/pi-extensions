/**
 * Чистые рендеры веб-вьюера: модель ядра (deriveSession) → HTML-строки.
 * Без DOM и сети — их гоняют тесты в Node; main.js только вставляет строки
 * и разбирает клики по data-атрибутам:
 *   data-sel="turn:<entryId>" | "era:3" | "child:0" | "worker:1" — выбор для инспектора;
 *   data-open="<путь .jsonl>" — открыть сессию субагента/воркера.
 */
import { CONTEXT_ROLES, diffContext, projectContext } from "../core/context.ts";
import { cacheHit, promptTokens } from "../core/model.ts";
import { fmtClock, fmtDur, fmtK, fmtMoney, oneLine } from "../core/text.ts";

export const COLOR = {
	run: "#E3B341",
	ok: "#4FD1A5",
	err: "#FF8A65",
	tool: "#6CB6FF",
	muted: "#5A6472",
	idle: "#5A6472",
};

const ROLE_COLOR = {
	system: "#5A6472",
	user: "#E3B341",
	assistant: "#8E7CC3",
	toolResult: "#6CB6FF",
	bash: "#C9A26B",
	custom: "#4FD1A5",
	summary: "#9AA5B4",
};

const MARKER_ICON = { compaction: "↻", branch: "⑂", label: "⚑", model: "⚙", thinking: "✦", edit: "✎" };

export function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

const pct = (x) => `${Math.round(x * 100)}%`;

// ---------- статус хода ----------

/** running | error | ok — цвет столбика, точки, чипа. */
export function turnState(v, t) {
	if (v.running && t === v.turns.at(-1)) return "running";
	if (t.stopReason === "error" || t.tools.some((x) => x.status === "error")) return "error";
	return "ok";
}

const stateColor = (s) => (s === "running" ? COLOR.run : s === "error" ? COLOR.err : COLOR.tool);

/** Выбор по умолчанию — последний ход пути. */
export function effectiveSel(v, sel) {
	if (sel) return sel;
	const last = v.turns.at(-1);
	return last ? { kind: "turn", id: last.entryId } : null;
}

/** Ход по id записи: номера T# у ветки и пути могут совпадать. */
export function findTurn(v, id) {
	for (const era of v.eras) for (const t of era.turns) if (t.entryId === id) return { turn: t, era };
	for (const b of v.branches)
		for (const era of b.eras) for (const t of era.turns) if (t.entryId === id) return { turn: t, era, branch: b };
	return undefined;
}

// ---------- фильтр ----------

/** «tool:bash err T12..T20 model:glm текст» → критерии; пустой → null. */
export function parseFilter(q) {
	const f = { text: [], tools: [], models: [], err: false, from: -Infinity, to: Infinity };
	let any = false;
	for (const tok of String(q ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)) {
		any = true;
		const range = /^T(\d+)(?:\.\.T?(\d+))?$/i.exec(tok);
		if (range) {
			f.from = Number(range[1]);
			f.to = range[2] ? Number(range[2]) : f.from;
		} else if (/^err(ors?)?$/i.test(tok)) f.err = true;
		else if (/^tool:/i.test(tok)) f.tools.push(tok.slice(5).toLowerCase());
		else if (/^model:/i.test(tok)) f.models.push(tok.slice(6).toLowerCase());
		else f.text.push(tok.toLowerCase());
	}
	return any ? f : null;
}

export function matchTurn(f, t, era) {
	if (!f) return true;
	if (t.index < f.from || t.index > f.to) return false;
	if (f.err && !(t.stopReason === "error" || t.tools.some((x) => x.status === "error"))) return false;
	if (f.tools.length && !t.tools.some((x) => f.tools.some((n) => x.name.toLowerCase().includes(n)))) return false;
	if (f.models.length && !f.models.some((m) => (t.model ?? "").toLowerCase().includes(m))) return false;
	if (f.text.length) {
		const hay = [era?.prompt, t.text, t.thinking, t.errorMessage, ...t.tools.map((x) => `${x.name} ${x.label}`)]
			.join(" ")
			.toLowerCase();
		if (!f.text.every((w) => hay.includes(w))) return false;
	}
	return true;
}

// ---------- шкала времени со сжатием пауз ----------

/**
 * Кусочно-линейная шкала по моментам активности: паузы длиннее gapMs
 * сжимаются до keepMs. toS(ms) — позиция на шкале (мс шкалы), toMs — обратно.
 */
export function makeScale(times, compress, gapMs = 60_000, keepMs = 5_000) {
	const ms = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
	if (ms.length === 0) ms.push(0);
	const s = [0];
	for (let i = 1; i < ms.length; i++) {
		const d = ms[i] - ms[i - 1];
		s.push(s[i - 1] + (compress && d > gapMs ? keepMs : d));
	}
	const find = (arr, x) => {
		let lo = 0;
		let hi = arr.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (arr[mid] <= x) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const lerp = (from, to, x) => {
		if (x <= from[0]) return to[0] + (x - from[0]);
		if (x >= from.at(-1)) return to.at(-1) + (x - from.at(-1));
		const i = find(from, x);
		const span = from[i + 1] - from[i];
		return span > 0 ? to[i] + ((x - from[i]) / span) * (to[i + 1] - to[i]) : to[i];
	};
	return {
		start: ms[0],
		end: ms.at(-1),
		total: s.at(-1),
		toS: (x) => lerp(ms, s, x),
		toMs: (x) => lerp(s, ms, x),
	};
}

// ---------- шапка ----------

export function renderStats(v) {
	const prompt = v.totals.input + v.totals.cacheRead + v.totals.cacheWrite;
	const hit = prompt > 0 && v.totals.cacheRead > 0 ? v.totals.cacheRead / prompt : null;
	const agents = 1 + v.children.length;
	const t = v.time;
	const share = (x) => (t.spanMs > 0 ? x / t.spanMs : 0);
	return `<div class="nums">
<span>${esc(fmtMoney(v.totals.cost) || "$0")}</span>
<span class="dim">↑${fmtK(prompt)}${hit === null ? "" : ` <span class="c-tool">hit ${pct(hit)}</span>`}</span>
<span class="dim">↓${fmtK(v.totals.output)}</span>
<span class="dim">${v.turns.length} ход${plural(v.turns.length, "", "а", "ов")}${agents > 1 ? ` · ${agents} агент${plural(agents, "", "а", "ов")}` : ""}</span>
</div>
<div class="tbar" title="${esc(`модель ${fmtDur(t.modelMs)} · инструменты ${fmtDur(t.toolsMs)} · ожидание ${fmtDur(t.idleMs)}`)}">
<div class="tbar-track"><i style="width:${pct(share(t.modelMs))};background:${COLOR.run}"></i><i style="width:${pct(share(t.toolsMs))};background:${COLOR.tool}"></i><i style="width:${pct(share(t.idleMs))};background:${COLOR.idle}"></i></div>
<div class="tbar-legend"><span>модель ${pct(share(t.modelMs))}</span><span>инструменты ${pct(share(t.toolsMs))}</span><span>ожидание ${pct(share(t.idleMs))}</span></div>
</div>`;
}

export function plural(n, one, few, many) {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
	return many;
}

// ---------- Flow ----------

/** Чипы пути: инструменты, свёрнутые по имени — ×N и число ошибок. */
export function toolChips(v) {
	const by = new Map();
	for (const t of v.turns)
		for (const x of t.tools) {
			const c = by.get(x.name) ?? { name: x.name, n: 0, err: 0, running: 0 };
			c.n++;
			if (x.status === "error") c.err++;
			if (x.status === "running") c.running++;
			by.set(x.name, c);
		}
	return [...by.values()].sort((a, b) => b.n - a.n);
}

function chipHtml(c) {
	const mark = c.running
		? `<span style="color:${COLOR.run}">⠹</span>`
		: c.err
			? `<span style="color:${COLOR.err}">✗${c.err}</span>`
			: `<span style="color:${COLOR.ok}">✓</span>`;
	return `<span class="chip"><span class="c-tool">⚒ ${esc(c.name)}</span><span class="dim">×${c.n}</span>${mark}</span>`;
}

function isSel(sel, kind, key) {
	return sel?.kind === kind && (sel.id ?? sel.index ?? sel.i) === key;
}

export function renderFlow(v, sel, workers, nowMs) {
	const last = v.turns.at(-1);
	const state = last ? turnState(v, last) : "ok";
	const running = last?.tools.find((x) => x.status === "running");
	const now = running
		? `⚒ ${running.name}  ${running.label}  ${fmtDur(nowMs - running.startMs)} ⠹`
		: last
			? `${state === "error" ? "✗ " : ""}T${last.index} · ${oneLine(last.errorMessage || last.text || (last.tools.length ? `⚒ ${last.tools.map((x) => x.name).join(", ")}` : ""), 60)}`
			: "нет ходов";
	const out = v.turns.reduce((s, t) => s + t.tokens.output, 0);
	const pathCost = v.turns.reduce((s, t) => s + t.cost, 0);
	const mainSel = last && isSel(sel, "turn", last.entryId);
	const main = `<button type="button" class="card wide${mainSel ? " sel" : ""}" data-sel="turn:${esc(last?.entryId ?? "")}">
<div class="row"><span class="dot" style="background:${v.running ? COLOR.run : stateColor(state)}"></span><b>pi</b><span class="dim mono">${esc(last?.model ?? "")}</span><span class="mono state" style="color:${v.running ? COLOR.run : stateColor(state)}">${v.running ? `работает · T${last?.index ?? 0}` : state === "error" ? "ошибка" : "ждёт"}</span></div>
<div class="mono now" style="color:${running ? COLOR.run : "inherit"}">${esc(now)}</div>
<div class="mono dim">${v.turns.length} ход${plural(v.turns.length, "", "а", "ов")} · ↓${fmtK(out)}${pathCost ? ` · ${esc(fmtMoney(pathCost))}` : ""} · модель ${fmtDur(v.turns.length ? v.time.modelMs / v.turns.length : 0)}/ход</div>
</button>`;
	const chips = toolChips(v).map(chipHtml).join("");

	const kids = [
		...v.children.map((c, i) => ({
			key: `child:${i}`,
			sel: isSel(sel, "child", i),
			color: COLOR.ok,
			name: c.agent,
			model: c.model ?? "",
			state: "готово",
			task: c.task,
			stats: [c.tokensOut ? `↓${fmtK(c.tokensOut)}` : "", c.cost ? fmtMoney(c.cost) : "", fmtClock(c.ts)]
				.filter(Boolean)
				.join(" · "),
		})),
		...workers.map((w, i) => ({
			key: `worker:${i}`,
			sel: isSel(sel, "worker", i),
			color: COLOR.run,
			name: w.label,
			model: w.mode ?? "",
			state: `работает · ${fmtDur(nowMs - w.startedAt)}`,
			task: w.task ?? "",
			stats: `pid ${w.pid}`,
		})),
	];
	const children = kids.length
		? `<div class="kids">${kids
				.map(
					(
						k,
					) => `<div class="kid"><i class="edge" style="border-color:${k.color}"></i><button type="button" class="card${k.sel ? " sel" : ""}" data-sel="${k.key}">
<div class="row"><span class="dot" style="background:${k.color}"></span><b>${esc(k.name)}</b><span class="dim mono">${esc(k.model)}</span><span class="mono state" style="color:${k.color}">${esc(k.state)}</span></div>
<div class="task">${esc(oneLine(k.task, 140))}</div>
<div class="mono dim">${esc(k.stats)}</div>
</button></div>`,
				)
				.join("")}</div>`
		: `<div class="kids empty dim">Субагентов в этой сессии нет.</div>`;

	return `<div class="flow"><div class="main-col">${main}<div class="chips">${chips}</div></div><i class="link" aria-hidden="true"></i>${children}</div>
<div class="legend"><span><span style="color:${COLOR.run}">●</span> работает</span><span><span style="color:${COLOR.ok}">●</span> готово</span><span><span style="color:${COLOR.err}">●</span> ошибка</span><span>клик — в инспектор</span></div>`;
}

// ---------- Timeline ----------

function eraCard(v, era, sel, filter, maxOut, label) {
	const bars = era.turns
		.map((t) => {
			const st = turnState(v, t);
			const h = Math.max(4, Math.round(Math.sqrt(t.tokens.output / maxOut) * 26));
			const dim = matchTurn(filter, t, era) ? "" : " dimmed";
			const on = isSel(sel, "turn", t.entryId) ? " sel" : "";
			return `<button type="button" class="bar${dim}${on}" data-sel="turn:${esc(t.entryId)}" title="T${t.index} · ↓${fmtK(t.tokens.output)}${t.tools.length ? ` · ${esc(t.tools.map((x) => x.name).join(", "))}` : ""}" style="height:${h}px;background:${stateColor(st)}"></button>`;
		})
		.join("");
	const first = era.turns[0]?.index;
	const last = era.turns.at(-1)?.index;
	const range = first ? (first === last ? `T${first}` : `T${first}–T${last}`) : "без ходов";
	const live = v.running && era === v.eras.at(-1);
	const meta = [range, live ? "идёт" : fmtDur(era.endMs - era.startMs), fmtMoney(era.cost)].filter(Boolean).join(" · ");
	const markers = era.markers
		.filter((m) => m.kind !== "model" && m.kind !== "thinking")
		.map((m) => `<span class="mk mk-${m.kind}">${MARKER_ICON[m.kind]} ${esc(oneLine(m.text, 70))}</span>`)
		.join("");
	return `<div class="era${isSel(sel, "era", era.index) ? " sel" : ""}" data-sel="era:${era.index}">
<div class="era-head"><span class="mono c-run">${esc(label)}</span><b>${era.prompt ? `«${esc(oneLine(era.prompt, 120))}»` : '<span class="dim">до первого промпта</span>'}</b><span class="mono dim era-meta">${esc(meta)}</span></div>
<div class="bars">${bars}</div>
${markers ? `<div class="mks">${markers}</div>` : ""}
</div>`;
}

export function renderTimeline(v, sel, filter) {
	const all = [...v.turns, ...v.branches.flatMap((b) => b.eras.flatMap((e) => e.turns))];
	const maxOut = Math.max(1, ...all.map((t) => t.tokens.output));
	// Ветка рисуется после эры, в которой стоит точка ветвления: последней эры,
	// чей первый ход не позже forkTurn (ветки до первого хода — после первой эры).
	const hostOf = (b) => {
		let host = v.eras[0];
		for (const e of v.eras) if (e.turns.length && e.turns[0].index <= b.forkTurn) host = e;
		return host;
	};
	const html = [];
	for (const era of v.eras) {
		html.push(eraCard(v, era, sel, filter, maxOut, era.index ? `эра ${era.index}` : "эра 0"));
		for (const b of v.branches) {
			if (hostOf(b) !== era) continue;
			html.push(`<div class="branch">
<div class="mono dim branch-head">⑂ ответвление от T${b.forkTurn} · брошена${b.cost ? ` · ${esc(fmtMoney(b.cost))}` : ""}</div>
${b.summary ? `<div class="dim branch-sum">branch_summary: ${esc(b.summary)}</div>` : ""}
${b.eras.map((e) => eraCard(v, e, sel, filter, maxOut, "ветка")).join("")}
</div>`);
		}
	}
	if (v.eras.length === 0) html.push('<div class="dim">В сессии пока нет промптов.</div>');
	return `<div class="timeline">${html.join("")}</div>
<div class="legend">Высота столбика — выходные токены хода, цвет — статус: <span class="c-tool">ок</span>, <span class="c-err">ошибка</span>, <span class="c-run">идёт сейчас</span>. Приглушённая дорожка со сдвигом — брошенная ветка. [ / ] — соседняя эра, ← → — соседний ход.</div>`;
}

// ---------- Context ----------

/** Проекция контекста запроса хода: путь до родителя assistant-записи. */
export function turnContext(tree, turn) {
	const parent = tree.get(turn.entryId)?.parentId ?? null;
	return parent ? projectContext(tree.path(parent)) : [];
}

export function renderContext(v, tree, sel) {
	const pick = effectiveSel(v, sel);
	const found = pick?.kind === "turn" ? findTurn(v, pick.id) : undefined;
	const turn = found?.turn ?? v.turns.at(-1);
	if (!turn) return '<div class="dim">Нет ходов — контекст появится после первого ответа модели.</div>';
	const list = found?.branch ? found.branch.eras.flatMap((e) => e.turns) : v.turns;
	const prevTurn = list[list.indexOf(turn) - 1];
	const parts = turnContext(tree, turn);
	const prevParts = prevTurn ? turnContext(tree, prevTurn) : [];
	const diff = diffContext(prevParts, parts);
	const prompt = promptTokens(turn.tokens);
	// Состав по ролям; пришедшее с прошлого хода — отдельным сегментом «новое».
	const fresh = new Set([...diff.added, ...diff.changed]);
	const chars = Object.fromEntries(CONTEXT_ROLES.map((r) => [r, 0]));
	let freshChars = 0;
	for (const p of parts) {
		if (fresh.has(p)) freshChars += p.chars;
		else chars[p.role] += p.chars;
	}
	const totalChars = parts.reduce((s, p) => s + p.chars, 0) || 1;
	const scale = prompt > 0 ? prompt / totalChars : 1 / 4;
	const seg = CONTEXT_ROLES.map((r) => ({ role: r, tok: chars[r] * scale })).filter((x) => x.tok > 0);
	const shown = (tok) => tok / (seg.reduce((s, x) => s + x.tok, 0) + freshChars * scale || 1) >= 0.005;
	const newTok = freshChars * scale;
	const sum = seg.reduce((s, x) => s + x.tok, 0) + newTok || 1;
	const hit = cacheHit(turn.tokens);
	const bar = [
		...seg.map(
			(x) =>
				`<i style="width:${((x.tok / sum) * 100).toFixed(2)}%;background:${ROLE_COLOR[x.role]}" title="${x.role}"></i>`,
		),
		newTok > 0
			? `<i style="width:${((newTok / sum) * 100).toFixed(2)}%;background:${COLOR.err}" title="новое"></i>`
			: "",
	].join("");
	const legend = [
		...seg
			.filter((x) => shown(x.tok))
			.map((x) => `<span><span style="color:${ROLE_COLOR[x.role]}">■</span> ${x.role} ${pct(x.tok / sum)}</span>`),
		shown(newTok) ? `<span><span style="color:${COLOR.err}">■</span> новое ${pct(newTok / sum)}</span>` : "",
		hit !== null ? `<span class="hi">│ cache hit ${pct(hit)}</span>` : "",
	].join("");

	const upto = list.slice(Math.max(0, list.indexOf(turn) - 19), list.indexOf(turn) + 1);
	const spark = upto
		.map((t) => {
			const h = cacheHit(t.tokens);
			const color = h === null ? COLOR.muted : h >= 0.7 ? COLOR.tool : h >= 0.4 ? COLOR.run : COLOR.err;
			return `<button type="button" class="spark${t === turn ? " sel" : ""}" data-sel="turn:${esc(t.entryId)}" title="T${t.index} · hit ${h === null ? "—" : pct(h)}" style="height:${Math.max(3, Math.round((h ?? 0.05) * 60))}px;background:${color}"></button>`;
		})
		.join("");
	const cold = upto.filter((t) => (cacheHit(t.tokens) ?? 1) < 0.4).map((t) => `T${t.index}`);

	const line = (g, cls, p) =>
		`<div class="dl ${cls}"><b>${g}</b><span>${esc(p.text)}</span><span class="dim mono">~${fmtK(p.chars * scale)}</span></div>`;
	const cap = (arr, g, cls) =>
		arr
			.slice(0, 12)
			.map((p) => line(g, cls, p))
			.join("") + (arr.length > 12 ? `<div class="dim">… ещё ${arr.length - 12}</div>` : "");
	const diffHtml =
		cap(diff.changed, "~", "chg") + cap(diff.added, "+", "add") + cap(diff.removed, "−", "del") ||
		'<div class="dim">Контекст не изменился.</div>';

	return `<div class="ctx">
<div class="ctx-head"><b>Контекст хода T${turn.index}</b><span class="mono dim">${fmtK(prompt)} токенов · ${parts.length} сообщений${prevTurn ? ` · Δ${prompt - promptTokens(prevTurn.tokens) >= 0 ? "+" : ""}${fmtK(prompt - promptTokens(prevTurn.tokens))} к T${prevTurn.index}` : ""}</span></div>
<div class="stack">${bar}${hit !== null ? `<i class="cut" style="left:${(hit * 100).toFixed(1)}%"></i>` : ""}</div>
<div class="legend-row">${legend}</div>
<div class="ctx-cards">
<div class="panel"><div class="dim">Cache hit, последние ${upto.length} ход${plural(upto.length, "", "а", "ов")}</div><div class="sparks">${spark}</div><div class="dim">${cold.length ? `холодный кэш: ${esc(cold.join(", "))}` : "кэш тёплый"}</div></div>
<div class="panel wide"><div class="dim">Дифф контекста ${prevTurn ? `T${prevTurn.index} → T${turn.index}` : `T${turn.index}`} · общий префикс ${diff.prefix} сообщ.</div>${diffHtml}</div>
</div>
<div class="legend">Размеры частей — оценка по символам, масштабированная к реальному промпту хода (input + cacheRead + cacheWrite).</div>
</div>`;
}

// ---------- Инспектор ----------

const metric = (k, val) => `<div class="metric"><span>${esc(k)}</span><b class="metric-v">${esc(val)}</b></div>`;

export function renderInspector(v, sel, workers, nowMs) {
	const pick = effectiveSel(v, sel);
	if (!pick) return '<div class="dim">Выберите ход, эру или агента.</div>';
	if (pick.kind === "child") {
		const c = v.children[pick.i];
		if (!c) return "";
		return `<div class="ins-head"><span class="dot" style="background:${COLOR.ok}"></span><b>${esc(c.agent)}</b><span class="mono dim">${esc(c.model ?? "")}</span></div>
<div class="sect">Задача</div><div class="quote">${esc(c.task)}</div>
<div class="metrics">${metric("выход", c.tokensOut ? `↓${fmtK(c.tokensOut)}` : "—")}${metric("стоимость", fmtMoney(c.cost ?? 0) || "—")}${metric("запущен", fmtClock(c.ts))}</div>
<button type="button" class="btn" data-open="${esc(c.session)}">Открыть сессию субагента</button>`;
	}
	if (pick.kind === "worker") {
		const w = workers[pick.i];
		if (!w) return "";
		return `<div class="ins-head"><span class="dot" style="background:${COLOR.run}"></span><b>${esc(w.label)}</b><span class="mono dim">${esc(w.mode ?? "")}</span><span class="mono state c-run">${fmtDur(nowMs - w.startedAt)}</span></div>
<div class="sect">Задача</div><div class="quote">${esc(w.task ?? "")}</div>
<div class="metrics">${metric("pid", String(w.pid))}${metric("запущен", fmtClock(w.startedAt))}</div>
<button type="button" class="btn" data-open="${esc(w.sessionFile)}">Открыть живую сессию</button>`;
	}
	if (pick.kind === "era") {
		const era = v.eras.find((e) => e.index === pick.index);
		if (!era) return "";
		const tools = era.turns.reduce((s, t) => s + t.tools.length, 0);
		return `<div class="ins-head"><b>Эра ${era.index}</b><span class="mono dim state">${fmtClock(era.startMs)}</span></div>
<div class="sect">Промпт</div><div class="quote">${esc(era.prompt || "—")}</div>
<div class="metrics">${metric("ходов", String(era.turns.length))}${metric("инструментов", String(tools))}${metric("длительность", fmtDur(era.endMs - era.startMs))}${metric("стоимость", fmtMoney(era.cost) || "—")}${metric("выход", `↓${fmtK(era.tokensOut)}`)}${metric("ошибок", String(era.errors))}</div>`;
	}
	const found = findTurn(v, pick.id);
	if (!found) return "";
	const { turn: t, era, branch } = found;
	const st = turnState(v, t);
	const hit = cacheHit(t.tokens);
	const tools = t.tools
		.map((x) => {
			const end = x.endMs ?? (x.status === "running" ? nowMs : undefined);
			const mark = x.status === "running" ? "⠹" : x.status === "error" ? "✗" : "✓";
			const color = x.status === "running" ? COLOR.run : x.status === "error" ? COLOR.err : COLOR.ok;
			return `<div class="call"><span class="c-tool">${esc(x.name)}</span><span class="dim arg">${esc(x.label)}</span><span>${end ? fmtDur(end - x.startMs) : ""}</span><span style="color:${color}">${mark}</span></div>`;
		})
		.join("");
	return `<div class="ins-head"><span class="dot" style="background:${stateColor(st)}"></span><b>T${t.index}</b><span class="mono dim">${esc(t.model ?? "")}</span><span class="mono state" style="color:${stateColor(st)}">${st === "running" ? "идёт" : st === "error" ? "ошибка" : fmtClock(t.startMs)}</span></div>
${branch ? '<div class="note">⑂ ход брошенной ветки</div>' : ""}
<div class="sect">Промпт эры</div><div class="quote">${esc(era.prompt || "—")}</div>
${t.thinking ? `<div class="sect">Рассуждение</div><div class="think">${esc(t.thinking)}</div>` : ""}
${t.text ? `<div class="sect">Ответ</div><div class="think">${esc(t.text)}</div>` : ""}
${t.errorMessage ? `<div class="sect c-err">Ошибка</div><div class="think">${esc(t.errorMessage)}</div>` : ""}
<div class="metrics">${metric("промпт", `↑${fmtK(promptTokens(t.tokens))}`)}${metric("cache hit", hit === null ? "—" : pct(hit))}${metric("генерация", fmtDur(t.endMs - t.startMs) || "—")}${metric("стоимость", fmtMoney(t.cost) || "—")}${metric("выход", `↓${fmtK(t.tokens.output)}`)}${metric("stop", t.stopReason ?? "—")}</div>
${tools ? `<div class="sect">Вызовы инструментов</div>${tools}` : ""}`;
}

// ---------- Скраббер ----------

export function renderScrubber(v, scale, playheadMs) {
	const total = scale.total || 1;
	const frac = (ms) => Math.min(1, Math.max(0, scale.toS(ms) / total));
	const bands = v.eras
		.map((e, i) => {
			const end = v.eras[i + 1]?.startMs ?? scale.end;
			const w = Math.max(0.004, frac(end) - frac(e.startMs));
			const live = v.running && i === v.eras.length - 1;
			return `<i class="band${live ? " live" : ""}" data-era="${e.index}" style="left:${(frac(e.startMs) * 100).toFixed(2)}%;width:${(w * 100).toFixed(2)}%" title="эра ${e.index}: ${esc(oneLine(e.prompt, 60))}"></i>`;
		})
		.join("");
	const ticks = v.markers
		.filter((m) => m.kind === "compaction" || m.kind === "branch" || m.kind === "label")
		.map(
			(m) =>
				`<span class="tick" style="left:${(frac(m.ts) * 100).toFixed(2)}%" title="${esc(m.text)}">${MARKER_ICON[m.kind]}</span>`,
		)
		.join("");
	return `<div class="track">${bands}<i class="head" style="left:${(frac(playheadMs) * 100).toFixed(2)}%"></i></div>
<div class="ticks">${ticks}</div>
<div class="scale mono dim"><span>${scale.start ? fmtClock(scale.start) : ""}</span><span>${playheadMs ? fmtClock(playheadMs) : ""}</span><span>${scale.end ? fmtClock(scale.end) : ""}</span></div>`;
}
