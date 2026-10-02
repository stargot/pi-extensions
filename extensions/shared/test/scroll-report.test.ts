/**
 * Модульные тесты ScrollReport (без живого TUI).
 *
 * Состояние скролла принадлежит pi-tui ScrollView; проверяем вьюпорт-нарезку,
 * клампы, help-строку с позицией, инвалидацию кэша ширины и wheel через
 * handleMouse. Терминал и тема мокаются duck-typed объектами
 * (как TuiLike в session-trace/graph.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollReport } from "../scroll-report.ts";
import { loadAuditThemes } from "../theme-contrast.ts";

interface TuiLike {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

function mockTui(rows: number, columns: number): { tui: TUI; renders: () => number } {
	let renders = 0;
	const tui: TuiLike = {
		requestRender: () => {
			renders++;
		},
		terminal: { rows, columns },
	};
	return { tui: tui as unknown as TUI, renders: () => renders };
}

function mockTheme(): Theme {
	return { fg: (_color: string, text: string) => text } as unknown as Theme;
}

/** raw-последовательности навигационных клавиш (как их отдаёт терминал). */
const KEYS = {
	escape: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
};

function wheelEvent(delta: number): Parameters<ScrollReport["handleMouse"]>[0] {
	return {
		type: "wheel",
		button: "none",
		x: 0,
		y: 0,
		screenX: 0,
		screenY: 0,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
	};
}

/** Отчёт из n строк «line i» без ANSI. */
function reportLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

test("render: нарезка по вьюпорту + help-строка с позицией", () => {
	// rows=13 → вьюпорт max(6, 13-3)=10 строк контента + help; ширина 100 — help влезает целиком.
	const { tui } = mockTui(13, 100);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
	});
	const out = view.render(100);
	assert.equal(out.length, 11, "10 строк контента + help");
	for (let i = 0; i < 10; i++) {
		assert.ok(out[i].trimEnd().startsWith(`line ${i + 1}`), `строка ${i}: ${out[i]}`);
		assert.ok(visibleWidth(out[i]) <= 100, "строки влезают в ширину");
	}
	assert.ok(out[10].startsWith("↑↓ PgUp PgDn Home End scroll"), `help: ${out[10]}`);
	assert.ok(out[10].includes(" 1-10/30"), `позиция: ${out[10]}`);
});

test("render: короткий отчёт — без позиции, всё видно", () => {
	const { tui } = mockTui(24, 80);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(3),
		onClose: () => {},
	});
	const out = view.render(80);
	assert.equal(out.length, 4, "3 строки + help");
	assert.ok(out[0].trimEnd().startsWith("line 1"));
	assert.ok(!out[3].includes("/3"), "позиция не рисуется, когда всё влезло");
});

test("скролл-клавиши: end/home/pageDown/up с клампами", () => {
	const { tui } = mockTui(13, 100); // вьюпорт 10
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
	});
	view.render(100);

	view.handleInput(KEYS.end);
	let out = view.render(100);
	assert.ok(out[0].trimEnd().startsWith("line 21"), `последняя страница: ${out[0]}`);
	assert.ok(out[10].includes(" 21-30/30"));

	// end внизу: pageDown не уезжает за конец
	view.handleInput(KEYS.pageDown);
	out = view.render(100);
	assert.ok(out[10].includes(" 21-30/30"), "кламп по концу");

	view.handleInput(KEYS.home);
	out = view.render(100);
	assert.ok(out[0].trimEnd().startsWith("line 1"));

	// up с самого верха не уходит в минус
	view.handleInput(KEYS.up);
	out = view.render(100);
	assert.ok(out[10].includes(" 1-10/30"));
});

test("стрелки и j/k сдвигают на строку", () => {
	const { tui } = mockTui(13, 40);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
	});
	view.render(40);
	view.handleInput(KEYS.down);
	view.handleInput("j");
	let out = view.render(40);
	assert.ok(out[0].trimEnd().startsWith("line 3"), `после down+j: ${out[0]}`);
	view.handleInput(KEYS.up);
	out = view.render(40);
	assert.ok(out[0].trimEnd().startsWith("line 2"));
});

test("wheel через handleMouse крутит ScrollView", () => {
	const { tui } = mockTui(13, 40);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
	});
	view.render(40);
	assert.equal(view.handleMouse(wheelEvent(3))?.handled, true);
	const out = view.render(40);
	assert.ok(out[0].trimEnd().startsWith("line 4"), `после wheel+3: ${out[0]}`);
	assert.ok(view.handleMouse(wheelEvent(-5))?.handled);
	assert.ok(view.render(40)[0].trimEnd().startsWith("line 1"), "wheel вверх до упора");
	assert.equal(view.handleMouse(wheelEvent(0)), undefined, "wheel без дельты не перехватывается");
});

test("q / esc / ctrl+c закрывают, r инвалидирует и перерисовывает", () => {
	const { tui, renders } = mockTui(13, 40);
	let closed = 0;
	let builds = 0;
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => {
			builds++;
			return reportLines(30);
		},
		onClose: () => {
			closed++;
		},
	});
	view.render(40);
	const buildsAfterFirst = builds;
	view.handleInput("x"); // неизвестная клавиша — ничего
	assert.equal(closed, 0);
	view.handleInput("q");
	assert.equal(closed, 1);

	view.handleInput(KEYS.escape);
	view.handleInput("\x03"); // ctrl+c
	assert.equal(closed, 3);

	// r: кэш сброшен, tui дёрнут; следующий кадр (как в живом TUI после requestRender)
	// перестраивает отчёт даже при той же ширине.
	view.handleInput("r");
	assert.equal(renders(), 1, "r запрашивает перерисовку");
	view.render(40);
	assert.ok(builds > buildsAfterFirst, "r перестраивает отчёт");
});

test("invalidate сбрасывает кэш ширины: смена ширины вызывает render с новой шириной", () => {
	const { tui } = mockTui(24, 80);
	const widths: number[] = [];
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: (width) => {
			widths.push(width);
			return reportLines(30);
		},
		onClose: () => {},
	});
	view.render(80);
	view.render(80); // кэш — без нового вызова render
	assert.deepEqual(widths, [80]);
	view.render(40); // новая ширина — перестройка
	assert.deepEqual(widths, [80, 40]);
	view.invalidate();
	view.render(40); // инвалидация — перестройка даже при той же ширине
	assert.deepEqual(widths, [80, 40, 40]);
});

test("helpSuffix попадает в help-строку", () => {
	const { tui } = mockTui(13, 120);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
		helpSuffix: " · args: today|7d",
	});
	const out = view.render(120);
	assert.ok(out.at(-1)?.includes(" · args: today|7d"), `суффикс: ${out.at(-1)}`);
});

test("border: true добавляет рамку сверху и снизу", () => {
	const { tui } = mockTui(13, 40);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
		border: true,
	});
	const out = view.render(40);
	assert.equal(out.length, 13, "рамка + 10 строк + help + рамка");
	assert.match(out[0], /^─+$/);
	assert.match(out.at(-1) as string, /^─+$/);
	assert.ok(visibleWidth(out[0]) === 40, "рамка во всю ширину");
});

test("смена высоты терминала меняет размер вьюпорта", () => {
	const mock = mockTui(13, 40);
	const view = new ScrollReport({
		tui: mock.tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
	});
	assert.equal(view.render(40).length, 11);
	// Терминал стал выше: вьюпорт растёт (24-3=21 строка + help).
	(mock.tui as unknown as TuiLike).terminal.rows = 24;
	const out = view.render(40);
	assert.equal(out.length, 22);
	assert.ok(out[20].trimEnd().startsWith("line 21"), `последняя строка: ${out[20]}`);
});

test("компонент удовлетворяет интерфейсу Component (для ctx.ui.custom)", () => {
	const { tui } = mockTui(13, 40);
	const view: Component = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(30),
		onClose: () => {},
	});
	assert.equal(typeof view.render, "function");
	assert.equal(typeof view.invalidate, "function");
	assert.equal(typeof view.handleInput, "function");
});

/** Матрица «малый терминал × тема» (автоматизация R9): help-строка с позицией
 * n-m/total обязана дожить даже на 25 колонках (регресс-тест фикса R9: раньше
 * позиция срезалась подсказками), крэшей и сырых JSON нет. Темы — реальные
 * Theme pi (dark, light и system в обоих обликax). */
const SIZES = [
	[40, 100],
	[20, 60],
	[10, 25],
] as const;

for (const [rows, cols] of SIZES) {
	test(`render ${cols}x${rows} × 4 темы: позиция n-m/total в help, без крэша и сырого JSON`, () => {
		for (const audit of loadAuditThemes()) {
			const { tui } = mockTui(rows, cols);
			const view = new ScrollReport({
				tui,
				theme: audit.theme,
				render: () => reportLines(130),
				onClose: () => {},
				helpSuffix: " · args: today|7d",
			});
			const out = view.render(cols);
			const help = out.at(-1) as string;
			assert.match(help, /\d+-\d+\/130/, `${audit.name}/${audit.appearance}: позиция обязана дожить: ${help}`);
			assert.ok(help.includes("today|7d"), `${audit.name}/${audit.appearance}: helpSuffix обязан дожить: ${help}`);
			assert.ok(!out.join("\n").includes('{"error"'), "сырой JSON в рендере");
			for (const line of out) {
				assert.ok(visibleWidth(line) <= cols, `строка шире терминала: ${line}`);
			}
		}
	});
}

test("help-строка в широкой теме не изменила порядок: подсказки, потом позиция и суффикс", () => {
	const { tui } = mockTui(13, 200);
	const view = new ScrollReport({
		tui,
		theme: mockTheme(),
		render: () => reportLines(130),
		onClose: () => {},
		helpSuffix: " · args: today|7d",
	});
	const help = view.render(200).at(-1) as string;
	const hintsAt = help.indexOf("↑↓ PgUp");
	const posAt = help.indexOf(" 1-10/130");
	const suffixAt = help.indexOf("today|7d");
	assert.ok(hintsAt >= 0 && posAt > hintsAt && suffixAt > posAt, `порядок нарушен: ${help}`);
});
