/**
 * Веб-вьюер trace: состояние, опрос живого хвоста, плеер и разбор кликов.
 * Модель — ядро trace (../core, serve.ts отдаёт его со стёртыми типами),
 * HTML — render.js. Плейхед Infinity — живой край: показываем всю сессию.
 */
import { deriveSession } from "../core/model.ts";
import { entryMs } from "../core/text.ts";
import { SessionTree } from "../core/tree.ts";
import {
	effectiveSel,
	makeScale,
	parseFilter,
	renderContext,
	renderFlow,
	renderInspector,
	renderScrubber,
	renderStats,
	renderTimeline,
} from "./render.js";
import { parseLines, SessionTail } from "./tail.js";

const $ = (id) => document.getElementById(id);
const LIVE_MS = 5 * 60 * 1000; // записи свежее этого — сессия живая
const AUTOPLAY_MS = 5000; // за сколько проиграть законченную сессию при открытии
const VIEWS = ["flow", "timeline", "context"];

const fileMs = (e) => {
	const p = Date.parse(e?.timestamp ?? "");
	return Number.isFinite(p) ? p : entryMs(e);
};

const S = {
	entries: [],
	full: new SessionTree(),
	fileName: "",
	served: false,
	view: VIEWS.includes(load("trace.view", "")) ? load("trace.view", "") : "flow",
	sel: null,
	playhead: Infinity,
	playing: false,
	speed: 8,
	autoplay: 0,
	gaps: load("trace.gaps", "1") === "1",
	filter: null,
	workers: [],
	tree: null,
	v: null,
	scale: null,
};

function load(key, fallback) {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

function save(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// приватное окно — без запоминания
	}
}

// ---------- данные ----------

function setEntries(entries) {
	S.entries = entries;
	S.full = new SessionTree();
	for (const e of entries) S.full.add(e);
	S.sel = null;
	recompute();
}

function appendEntries(entries) {
	if (entries.length === 0) return;
	S.entries.push(...entries);
	for (const e of entries) S.full.add(e);
	recompute();
}

/** Дерево на момент ms: записи файла, написанные не позже плейхеда. */
function treeAt(ms) {
	if (ms === Infinity) return S.full;
	const t = new SessionTree();
	for (const e of S.entries) {
		if (e.type !== "session" && fileMs(e) > ms) break;
		t.add(e);
	}
	return t;
}

function recompute() {
	S.scale = makeScale(S.entries.filter((e) => e.type !== "session").map(fileMs), S.gaps);
	S.tree = treeAt(S.playhead);
	S.v = deriveSession(S.tree, S.tree.leafId, S.playhead === Infinity ? Date.now() : S.playhead);
	schedule();
}

const tail = new SessionTail((url) => fetch(url, { cache: "no-store" }));

async function pollServed() {
	const got = await tail.poll();
	if (!got) return false;
	S.served = true;
	S.fileName = tail.file;
	if (got.reset) setEntries(got.entries);
	else appendEntries(got.entries);
	return true;
}

async function openServerFile(file) {
	const r = await fetch("load", { method: "POST", body: JSON.stringify({ file }) });
	if (!r.ok) return;
	S.playhead = Infinity;
	S.playing = false;
	await pollServed();
}

function openLocalFile(f) {
	f.text().then((text) => {
		S.served = false; // локальный файл: хвост сервера больше не тянем
		S.fileName = f.name;
		S.playhead = Infinity;
		setEntries(parseLines(text.split("\n")));
	});
}

async function fetchWorkers() {
	if (!S.served) return;
	try {
		const r = await fetch("workers", { cache: "no-store" });
		S.workers = r.ok ? ((await r.json()).workers ?? []) : [];
		schedule();
	} catch {
		// сервер остановлен
	}
}

async function fetchSessions() {
	try {
		const r = await fetch("sessions", { cache: "no-store" });
		if (!r.ok) return;
		const { sessions } = await r.json();
		$("pick-session").innerHTML =
			'<option value="">другая сессия…</option>' +
			sessions
				.map(
					(s) =>
						`<option value="${escAttr(s.file)}">${escHtml(`${s.title} · ${s.project} · ${new Date(s.mtime).toLocaleString()}`)}</option>`,
				)
				.join("");
	} catch {
		// без списка — только перетаскивание файла
	}
}

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escAttr = (s) => escHtml(s).replace(/"/g, "&quot;");

// ---------- плеер ----------

function seek(ms) {
	S.playhead = ms >= S.scale.end ? Infinity : Math.max(S.scale.start, ms);
	recompute();
}

function stop() {
	S.playing = false;
	S.autoplay = 0;
}

function goLive() {
	stop();
	S.playhead = Infinity;
	recompute();
}

function togglePlay() {
	if (!S.v) return;
	S.autoplay = 0;
	if (!S.playing && S.playhead === Infinity) S.playhead = S.scale.start; // ⟲ с начала
	S.playing = !S.playing;
	recompute();
}

let lastTick = performance.now();
setInterval(() => {
	const now = performance.now();
	const dt = now - lastTick;
	lastTick = now;
	if (!S.playing) return;
	const at = S.scale.toS(S.playhead) + dt * (S.autoplay || S.speed);
	if (at >= S.scale.total) goLive();
	else seek(S.scale.toMs(at));
}, 100);

function eraStep(dir) {
	const eras = S.v?.eras ?? [];
	if (eras.length === 0) return;
	const at = S.playhead === Infinity ? S.scale.end + 1 : S.playhead;
	const idx = eras.findLastIndex((e) => e.startMs < at);
	const target = eras[Math.min(eras.length - 1, Math.max(0, idx + dir))];
	stop();
	seek(target.startMs);
}

function selectStep(dir) {
	const v = S.v;
	if (!v) return;
	const cur = effectiveSel(v, S.sel);
	if (!cur) return;
	if (cur.kind === "era") {
		const i = v.eras.findIndex((e) => e.index === cur.index);
		const era = v.eras[Math.min(v.eras.length - 1, Math.max(0, i + dir))];
		if (era) S.sel = { kind: "era", index: era.index };
	} else {
		const i = v.turns.findIndex((t) => t.entryId === cur.id);
		const t = v.turns[Math.min(v.turns.length - 1, Math.max(0, (i < 0 ? v.turns.length : i) + dir))];
		if (t) S.sel = { kind: "turn", id: t.entryId };
	}
	schedule();
}

function eraSelectStep(dir) {
	const v = S.v;
	if (!v) return;
	const cur = effectiveSel(v, S.sel);
	let i = v.eras.length - 1;
	if (cur?.kind === "era") i = v.eras.findIndex((e) => e.index === cur.index);
	else if (cur?.kind === "turn") i = v.eras.findIndex((e) => e.turns.some((t) => t.entryId === cur.id));
	const era = v.eras[Math.min(v.eras.length - 1, Math.max(0, i + dir))];
	if (era) S.sel = { kind: "era", index: era.index };
	schedule();
}

// ---------- рендер ----------

// Рендер склеивается в один на кадр. setTimeout, а не requestAnimationFrame:
// rAF может замереть (headless, перекрытое окно), и пауза не перерисуется.
let queued = false;
function schedule() {
	if (queued) return;
	queued = true;
	setTimeout(() => {
		queued = false;
		render();
	}, 16);
}

function render() {
	const v = S.v;
	if (!v) return;
	const now = S.playhead === Infinity ? Date.now() : S.playhead;
	const last = S.entries.at(-1);
	const live = S.playhead === Infinity && last && Date.now() - fileMs(last) < LIVE_MS;
	$("live").hidden = !live;
	$("replay").hidden = S.playhead === Infinity;
	$("title").textContent = v.name || v.eras.find((e) => e.prompt)?.prompt || S.fileName || "сессия не выбрана";
	$("title").title = S.fileName;
	$("subtitle").textContent = [v.cwd, S.entries[0] ? new Date(fileMs(S.entries[0])).toLocaleString() : ""]
		.filter(Boolean)
		.join(" · ");
	$("stats").innerHTML = renderStats(v);
	for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === S.view);
	const pane = $("view");
	pane.innerHTML =
		S.view === "timeline"
			? renderTimeline(v, S.sel, S.filter)
			: S.view === "context"
				? renderContext(v, S.tree, S.sel)
				: renderFlow(v, S.sel, S.workers, now);
	$("inspector").innerHTML = renderInspector(v, S.sel, S.workers, now);
	$("scrub").innerHTML = renderScrubber(v, S.scale, S.playhead === Infinity ? S.scale.end : S.playhead);
	$("play").textContent = S.playing ? "⏸" : "▶";
	$("gaps").classList.toggle("on", S.gaps);
	$("speed").value = String(S.speed);
	$("drop").hidden = S.entries.length > 0;
}

// ---------- события ----------

document.addEventListener("click", (ev) => {
	const el = ev.target.closest?.("[data-sel],[data-open],[data-view],[data-era]");
	if (!el) return;
	if (el.dataset.open) {
		void openServerFile(el.dataset.open);
		return;
	}
	if (el.dataset.view) {
		S.view = el.dataset.view;
		save("trace.view", S.view);
		schedule();
		return;
	}
	if (el.dataset.era) {
		const era = S.v?.eras.find((e) => e.index === Number(el.dataset.era));
		if (era) {
			stop();
			seek(era.startMs);
		}
		return;
	}
	const [kind, key] = el.dataset.sel.split(":");
	S.sel =
		kind === "turn" ? { kind, id: key } : kind === "era" ? { kind, index: Number(key) } : { kind, i: Number(key) };
	ev.stopPropagation();
	schedule();
});

$("play").onclick = togglePlay;
$("prev").onclick = () => eraStep(-1);
$("next").onclick = () => eraStep(1);
$("tolive").onclick = goLive;
$("gaps").onclick = () => {
	S.gaps = !S.gaps;
	save("trace.gaps", S.gaps ? "1" : "0");
	recompute();
};
$("speed").onchange = () => {
	S.autoplay = 0;
	S.speed = Number($("speed").value);
};
$("q").oninput = () => {
	S.filter = parseFilter($("q").value);
	if (S.filter && S.view === "flow") S.view = "timeline"; // фильтр подсвечивает ходы на таймлайне
	schedule();
};
$("pick-session").onchange = () => {
	const file = $("pick-session").value;
	$("pick-session").value = "";
	if (file) void openServerFile(file);
};
$("pick-file").onchange = () => {
	const f = $("pick-file").files?.[0];
	if (f) openLocalFile(f);
};

const scrub = $("scrub");
scrub.addEventListener("pointerdown", (ev) => {
	if (ev.target.closest("[data-era]")) return;
	const seekAt = (e) => {
		const r = scrub.querySelector(".track").getBoundingClientRect();
		const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		stop();
		seek(S.scale.toMs(f * S.scale.total));
	};
	seekAt(ev);
	const move = (e) => seekAt(e);
	const up = () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
});

document.addEventListener("keydown", (ev) => {
	const typing = ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT";
	if (typing) {
		if (ev.key === "Escape") ev.target.blur();
		return;
	}
	if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
	const k = ev.key;
	if (k >= "1" && k <= "3") {
		S.view = VIEWS[Number(k) - 1];
		save("trace.view", S.view);
		schedule();
	} else if (k === "[") eraSelectStep(-1);
	else if (k === "]") eraSelectStep(1);
	else if (k === "ArrowLeft") selectStep(-1);
	else if (k === "ArrowRight") selectStep(1);
	else if (k === "g") goLive();
	else if (k === "s") $("gaps").onclick();
	else if (k === " ") togglePlay();
	else if (k === "/") $("q").focus();
	else if (k === "Escape") {
		S.sel = null;
		schedule();
	} else return;
	ev.preventDefault();
});

for (const t of ["dragover", "drop"]) {
	document.addEventListener(t, (ev) => {
		ev.preventDefault();
		document.body.classList.toggle("dragging", t === "dragover");
	});
}
document.addEventListener("drop", (ev) => {
	const f = ev.dataTransfer?.files?.[0];
	if (f) openLocalFile(f);
});
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));

// ---------- старт ----------

setInterval(() => {
	if (S.served) pollServed().catch(() => {});
	else if (S.v) schedule(); // идущие таймеры
}, 1000);
setInterval(fetchWorkers, 5000);

pollServed()
	.then((ok) => {
		if (!ok) return;
		void fetchWorkers();
		void fetchSessions();
		const last = S.entries.at(-1);
		const stale = last && Date.now() - fileMs(last) >= LIVE_MS;
		if (stale && location.hash !== "#end" && !/[?&]noplay=1/.test(location.search) && S.scale.total > 0) {
			S.playhead = S.scale.start;
			S.autoplay = Math.max(1, S.scale.total / AUTOPLAY_MS);
			S.playing = true;
			recompute();
		}
	})
	.catch(() => {
		$("drop").hidden = false;
	});
