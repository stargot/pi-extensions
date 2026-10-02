/**
 * Модульные тесты ResultsView (session-recall, без живого TUI): заголовок,
 * подсказка, подсветка термов и матрица «малый терминал × тема» (автоматизация
 * R9) — крэшей и сырых JSON нет, подсказка доживает даже на 25 колонках.
 * Терминал и тема мокаются/берутся реальными, как в shared/theme-contrast.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { ResultsView } from "../view.ts";
import type { Hit } from "../search.ts";
import { loadAuditThemes } from "../../shared/theme-contrast.ts";

function mockTui(rows: number, columns: number): TUI {
	return { requestRender() {}, terminal: { rows, columns } } as unknown as TUI;
}

const wheelEvent = (delta: number): TuiMouseEvent => ({
	type: "wheel",
	button: "none",
	x: 0,
	y: 1,
	screenX: 0,
	screenY: 1,
	width: 100,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
	wheelDelta: delta,
});

function hit(i: number): Hit {
	return {
		unit: {
			file: `/s/2026-09-0${(i % 8) + 1}T10-00-00.000Z_session-${i}.jsonl`,
			sessionId: `s-${i}`,
			sessionName: i % 2 === 0 ? `agent-${i}` : undefined,
			project: `proj-${i % 3}`,
			cwd: `/home/u/proj-${i % 3}`,
			entryId: `e-${i}`,
			role: i % 4 === 0 ? "tool" : "user",
			tool: i % 4 === 0 ? "read" : undefined,
			timestamp: Date.parse("2026-09-05T12:00:00.000Z") + i * 1000,
			text: `question about resize behaviour ${i}`,
		},
		score: 1 / (i + 1),
		snippet: `…asking about resize behaviour of the overlay ${i}…`,
		position: i,
	};
}

const SIZES = [
	[40, 100],
	[20, 60],
	[10, 25],
] as const;

test("render: заголовок, подсветка и подсказка на месте", () => {
	const view = new ResultsView({
		tui: mockTui(24, 100),
		theme: loadAuditThemes()[0].theme,
		hits: [hit(0), hit(1), hit(2)],
		total: 40,
		terms: ["resize"],
		queryText: "resize",
		onSelect: () => {},
		onClose: () => {},
	});
	const out = view.render(100);
	const joined = out.join("\n");
	assert.ok(joined.includes("Recall"), `заголовок: ${out[0]}`);
	assert.ok(joined.includes("3 of 40 results"), `счётчик: ${out[0]}`);
	assert.ok(joined.includes("resize"), "сниппет с термом присутствует");
	assert.ok(joined.includes("Enter open"), `подсказка: ${out.at(-1)}`);
});

test("клавиши: j/k двигают выделение, q закрывает; Enter вызывает onSelect", () => {
	let closed = 0;
	let selected: string | undefined;
	const view = new ResultsView({
		tui: mockTui(24, 100),
		theme: loadAuditThemes()[0].theme,
		hits: [hit(0), hit(1), hit(2)],
		total: 3,
		terms: ["resize"],
		queryText: "resize",
		onSelect: (h) => {
			selected = h.unit.sessionId;
		},
		onClose: () => {
			closed++;
		},
	});
	view.render(100);
	view.handleInput("j");
	view.handleInput("j");
	view.handleInput("k");
	view.handleInput("\r"); // Enter — открыть выбранного
	assert.equal(selected, "s-1");
	view.handleInput("q");
	assert.equal(closed, 1);
});

/** Матрица «малый терминал × тема» (автоматизация R9): рендер без крэша,
 * подсказка доживает, сырого JSON нет. Подсказка — TruncatedText: на узком
 * терминале режется хвост, начало («↑↓ PgUp…») обязано остаться. */
for (const [rows, cols] of SIZES) {
	test(`render ${cols}x${rows} × 4 темы: подсказка доживает, без крэша и сырого JSON`, () => {
		for (const audit of loadAuditThemes()) {
			const view = new ResultsView({
				tui: mockTui(rows, cols),
				theme: audit.theme,
				hits: Array.from({ length: 12 }, (_, i) => hit(i)),
				total: 40,
				terms: ["resize"],
				queryText: "resize",
				onSelect: () => {},
				onClose: () => {},
			});
			const out = view.render(cols);
			const joined = out.join("\n");
			assert.ok(joined.includes("Recall"), `${audit.name}/${audit.appearance}: заголовок`);
			assert.ok(joined.includes("↑↓ PgUp"), `${audit.name}/${audit.appearance} @${cols}: начало подсказки дожило`);
			assert.ok(!joined.includes('{"error"'), "сырой JSON в рендере");
			view.invalidate();
		}
	});
}

test("колесо над списком перехватывается (handled), над пустой зоной — нет", () => {
	const view = new ResultsView({
		tui: mockTui(24, 100),
		theme: loadAuditThemes()[0].theme,
		hits: [hit(0), hit(1)],
		total: 2,
		terms: ["resize"],
		queryText: "resize",
		onSelect: () => {},
		onClose: () => {},
	});
	view.render(100);
	assert.equal(view.handleMouse(wheelEvent(3))?.handled, true);
	assert.equal(view.handleMouse(wheelEvent(0)), undefined, "wheel без дельты не перехватывается");
});
