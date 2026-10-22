/**
 * Виды TUI-оверлея (tui-views.ts) на сессии-фикстуре ядра и переключение
 * видов/выбора хода в TraceView.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { deriveSession } from "../core/model.ts";
import { SessionTree } from "../core/tree.ts";
import { TraceView } from "../graph.ts";
import { contextLines, eraStrip, flowLines, inspectorLines, timelineLines, wrap } from "../tui-views.ts";
import { ENTRIES, HEADER } from "./fixture-tree.ts";

const th = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const NO_FILTER = { query: "", errorsOnly: false };

function session() {
	const tree = new SessionTree();
	tree.add(HEADER);
	for (const e of ENTRIES) tree.add(e);
	return { tree, v: deriveSession(tree) };
}

test("timelineLines: заголовки эр, ход с якорем, ветка после эры точки ветвления", () => {
	const { v } = session();
	const b = timelineLines(v, th, 100, { filter: NO_FILTER, spin: "⠋" });
	const text = b.lines.join("\n");
	const at = (s: string) => b.lines.findIndex((l) => l.includes(s));
	assert.ok(at("эра 1 fix the bug") >= 0, text);
	assert.ok(at("⑂ ответвление от T2") > at("эра 1"), "ветка после эры 1");
	assert.ok(at("⑂ ответвление от T2") < at("эра 2"), "и до эры 2");
	assert.match(text, /branch_summary: mutex made it worse/);
	assert.match(text, /├ ⚑ release/);
	assert.match(text, /\$ npm test/);
	assert.match(b.lines[b.anchors.get("a1")!]!, /T1 · /, "якорь — строка заголовка хода");
	assert.equal(b.lines.length, b.kinds.length);
});

test("timelineLines: фильтр оставляет совпавшие ходы, «только ошибки» — ход с ошибкой", () => {
	const { v } = session();
	const read = timelineLines(v, th, 100, { filter: { query: "a.ts", errorsOnly: false }, spin: "⠋" });
	assert.match(read.lines.join("\n"), /⚒ read/);
	assert.doesNotMatch(read.lines.join("\n"), /T4 · /);
	const errs = timelineLines(v, th, 100, { filter: { query: "", errorsOnly: true }, spin: "⠋" });
	assert.match(errs.lines.join("\n"), /overloaded/);
	assert.doesNotMatch(errs.lines.join("\n"), /T1 · /);
	assert.ok(errs.matchStarts.length > 0);
});

test("flowLines: главный агент, свёрнутые инструменты и карточки субагентов", () => {
	const { v } = session();
	const b = flowLines(
		v,
		[
			{ name: "scout", task: "look", state: "ok", turns: 7, out: 7100, cost: 0.04 },
			{
				name: "worker",
				task: "run e2e",
				state: "running",
				turns: 3,
				out: 2400,
				cost: 0.03,
				tool: "bash npm run e2e",
				elapsedMs: 72_000,
			},
		],
		th,
		90,
		{ spin: "⠹", nowMs: 0 },
	);
	const text = b.lines.join("\n");
	assert.match(text, /╭ pi · glm-5\.3/);
	assert.match(text, /⚒ read×1 ✓/);
	assert.match(text, /┣━━ ╭ scout ✓/);
	assert.match(text, /┗━━ ╭ worker ● 1m12s/);
	assert.ok(b.running, "живой воркер анимирует спиннер");
	for (const l of b.lines) assert.ok(visibleWidth(l) <= 90, l);
});

test("contextLines: состав, граница cache hit, дифф по записям", () => {
	const { v, tree } = session();
	const text = contextLines(v, tree, th, 80, "a2").lines.join("\n");
	assert.match(text, /Контекст хода T2/);
	assert.match(text, /cache hit 91%/);
	assert.match(text, /Дифф T1 → T2/);
	assert.match(text, /\+ toolResult\(read\)/);
	const after = contextLines(v, tree, th, 80, "a5").lines.join("\n");
	assert.match(after, /compaction: user wants single-flight/);
});

test("inspectorLines и eraStrip: выбранный ход, маркеры эр, ширина", () => {
	const { v } = session();
	const ins = inspectorLines(v, th, 40, "a1", 0, "⠋");
	assert.match(ins[0]!, /T1/);
	assert.ok(
		ins.some((l) => l.includes("read")),
		ins.join("\n"),
	);
	assert.ok(inspectorLines(v, th, 40, "a3", 0, "⠋").some((l) => l.includes("брошенной ветки")));
	for (const l of ins) assert.ok(visibleWidth(l) <= 39, l);
	const strip = eraStrip(v, th, 60, "a2", "▶ 8×");
	assert.match(strip, /^эры /);
	assert.match(strip, /▌/, "выбранный ход");
	assert.match(strip, /↻|⑂|⚑/);
	assert.ok(visibleWidth(strip) <= 60);
});

test("wrap: по словам, не шире ширины, последняя строка — с многоточием", () => {
	const lines = wrap("one two three four five six seven", 9, 2);
	assert.equal(lines.length, 2);
	assert.ok(lines.every((l) => visibleWidth(l) <= 9));
	assert.match(lines[1]!, /…$/);
});

test("TraceView: 1/2/3 переключают вид, , выбирает ход, инспектор — на широком терминале", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-views-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${[HEADER, ...ENTRIES].map((e) => JSON.stringify(e)).join("\n")}\n`);
	const view = new TraceView({
		tui: { requestRender() {}, terminal: { rows: 30, columns: 140 } },
		theme: th,
		file,
		mode: "live",
		onClose: () => {},
	});
	try {
		let out = view.render(140);
		assert.match(out[1]!, /\[2 Timeline\]/);
		assert.ok(
			out.some((l) => l.includes("│ ● T4")),
			"инспектор показывает последний ход",
		);
		view.handleInput("1");
		out = view.render(140);
		assert.match(out[1]!, /\[1 Flow\]/);
		assert.ok(out.some((l) => l.includes("╭ pi")));
		view.handleInput("2");
		view.handleInput(",");
		out = view.render(140);
		assert.ok(
			out.some((l) => l.includes("│ ● T3")),
			"выбор сдвинулся на T3",
		);
		view.handleInput("d");
		assert.match(view.render(140)[1]!, /\[3 Context\]/);
		view.handleInput("i");
		assert.ok(!view.render(140).some((l) => l.includes("│ ● T3")), "i прячет инспектор");
		assert.ok(!view.render(100).some((l) => l.includes("инспектор")), "узкий терминал — без инспектора");
	} finally {
		view.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
