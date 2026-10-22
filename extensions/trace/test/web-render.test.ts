/**
 * Рендеры веб-вьюера (web/render.js) на сессии-фикстуре ядра: эры, ветка,
 * контекст, инспектор, фильтр, шкала со сжатием пауз, экранирование.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSession } from "../core/model.ts";
import { SessionTree } from "../core/tree.ts";
import {
	makeScale,
	matchTurn,
	parseFilter,
	renderContext,
	renderFlow,
	renderInspector,
	renderScrubber,
	renderStats,
	renderTimeline,
} from "../web/render.js";
import { ENTRIES, HEADER } from "./fixture-tree.ts";

function session(entries = ENTRIES) {
	const tree = new SessionTree();
	tree.add(HEADER);
	for (const e of entries) tree.add(e);
	return { tree, v: deriveSession(tree) };
}

test("renderTimeline: эры по порядку, брошенная ветка — сразу после эры точки ветвления", () => {
	const { v } = session();
	const html = renderTimeline(v, null, null);
	const at = (s: string) => html.indexOf(s);
	assert.ok(at("«fix the bug»") < at("⑂ ответвление от T2"), "ветка после эры 1");
	assert.ok(at("⑂ ответвление от T2") < at("«back to single-flight»"), "и до эры 2");
	assert.match(html, /branch_summary: mutex made it worse/);
	assert.match(html, /data-sel="turn:a5"/);
	assert.match(html, /⚑ release/);
});

test("renderTimeline: фильтр приглушает несовпавшие ходы", () => {
	const { v } = session();
	const html = renderTimeline(v, null, parseFilter("tool:read"));
	assert.match(html, /class="bar" data-sel="turn:a1"/);
	assert.match(html, /class="bar dimmed" data-sel="turn:a2"/);
});

test("parseFilter/matchTurn: диапазон, ошибки, инструмент, текст", () => {
	const { v } = session();
	const [t1, t2, t3, t4] = v.turns;
	const era = v.eras[0];
	assert.equal(parseFilter("  "), null);
	assert.ok(matchTurn(parseFilter("T2..T3"), t2, era) && !matchTurn(parseFilter("T2..T3"), t1, era));
	assert.ok(matchTurn(parseFilter("err"), t4, era) && !matchTurn(parseFilter("err"), t3, era));
	assert.ok(matchTurn(parseFilter("found"), t2, era), "текст ответа");
	assert.ok(matchTurn(parseFilter("bug"), t1, era), "промпт эры");
});

test("renderContext: состав, граница кэша и дифф к прошлому ходу", () => {
	const { v, tree } = session();
	const html = renderContext(v, tree, { kind: "turn", id: "a2" });
	assert.match(html, /Контекст хода T2/);
	assert.match(html, /T1 → T2/);
	assert.match(html, /cache hit 91%/, "cacheRead 1000 / промпт 1100");
	assert.match(html, /toolResult\(read\)/, "результат read пришёл в контекст");
	const after = renderContext(v, tree, { kind: "turn", id: "a5" });
	assert.match(after, /compaction: user wants single-flight/, "после компакции — summary");
});

test("renderInspector: ход с инструментами и ошибкой, эра, ход ветки", () => {
	const { v } = session();
	const t1 = renderInspector(v, { kind: "turn", id: "a1" }, [], 0);
	assert.match(t1, /read first/);
	assert.match(t1, /a\.ts/);
	assert.match(renderInspector(v, null, [], 0), /overloaded/, "по умолчанию — последний ход");
	assert.match(renderInspector(v, { kind: "era", index: 2 }, [], 0), /back to single-flight/);
	assert.match(renderInspector(v, { kind: "turn", id: "a3" }, [], 0), /брошенной ветки/);
});

test("renderFlow: чипы свёрнуты по имени, живые воркеры — карточками", () => {
	const { v } = session();
	const worker = { label: "worker", task: "run e2e", startedAt: 0, pid: 7, sessionFile: "w.jsonl" };
	const html = renderFlow(v, null, [worker], 72_000);
	assert.match(html, /⚒ read<\/span><span class="dim">×1/);
	assert.match(html, /работает · 1m12s/);
	assert.match(html, /data-sel="worker:0"/);
});

test("renderStats и renderScrubber: итоги, разбивка времени, полосы эр", () => {
	const { v } = session();
	assert.match(renderStats(v), /\$0\.08/);
	const scale = makeScale([v.eras[0].startMs, v.eras.at(-1)!.endMs], true);
	const html = renderScrubber(v, scale, Infinity);
	assert.equal((html.match(/class="band/g) ?? []).length, 3);
	assert.match(html, /↻/);
});

test("makeScale: паузы длиннее порога сжимаются, обратное преобразование сходится", () => {
	const s = makeScale([0, 1000, 3_601_000], true);
	assert.equal(s.total, 6000, "час простоя → 5 с");
	assert.equal(s.toS(500), 500);
	assert.equal(Math.round(s.toMs(s.toS(1_801_000))), 1_801_000);
	assert.equal(makeScale([0, 1000, 3_601_000], false).total, 3_601_000);
});

test("рендеры экранируют текст сессии", () => {
	const evil = ENTRIES.map((e) =>
		e.id === "u1" ? { ...e, message: { ...e.message, content: '<img src=x onerror="alert(1)">' } } : e,
	);
	const { v } = session(evil);
	const html = renderTimeline(v, null, null) + renderInspector(v, { kind: "era", index: 1 }, [], 0);
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /&lt;img/);
});
