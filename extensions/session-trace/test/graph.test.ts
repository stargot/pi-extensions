/**
 * Модульные тесты TraceView (без живого TUI): резерв строк хоста (fullscreen),
 * паддинг рендера до доступной высоты и footer на последней строке, колесо мыши.
 * Терминал и тема мокаются duck-typed объектами (как TuiLike в graph.ts и в
 * test/render.ts); сессия — временный JSONL с user-сообщениями.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { TraceView } from "../graph.ts";

interface TuiLike {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

function mockTui(rows: number, columns = 100): TuiLike {
	return { requestRender() {}, terminal: { rows, columns } };
}

function mockTheme() {
	return { fg: (_color: string, s: string) => s, bold: (s: string) => s };
}

/** Временная сессия из n user-сообщений (по 2 строки ленты на элемент). */
function writeSession(n: number): string {
	const dir = mkdtempSync(join(tmpdir(), "trace-graph-test-"));
	const file = join(dir, "session.jsonl");
	const base = Date.parse("2026-01-01T00:00:00Z");
	const lines = Array.from({ length: n }, (_, i) =>
		JSON.stringify({
			type: "message",
			message: { role: "user", content: `question ${i + 1}` },
			timestamp: new Date(base + i * 1000).toISOString(),
		}),
	);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function wheelEvent(delta: number): TuiMouseEvent {
	return {
		type: "wheel",
		button: "none",
		x: 0,
		y: 0,
		screenX: 0,
		screenY: 0,
		width: 100,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
	};
}

const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";

test("render: без резерва паддинг до полной высоты терминала, footer на последней строке", () => {
	const file = writeSession(40);
	try {
		const view = new TraceView({
			tui: mockTui(24, 200) as any,
			theme: mockTheme() as any,
			file,
			mode: "live",
			onClose: () => {},
		});
		try {
			const out = view.render(160);
			assert.equal(out.length, 24, "высота = terminal.rows");
			assert.ok(out[0].includes("session-trace"), `header: ${out[0]}`);
			assert.ok(out[23].includes("/80"), `footer с позицией (80 строк ленты): ${out[23]}`);
		} finally {
			view.dispose();
		}
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
});

test("reserveRows: 1 (fullscreen-хост) — рендер на строку короче, footer не теряется", () => {
	const file = writeSession(40);
	try {
		const view = new TraceView({
			tui: mockTui(24, 200) as any,
			theme: mockTheme() as any,
			file,
			mode: "live",
			reserveRows: 1,
			onClose: () => {},
		});
		try {
			const out = view.render(160);
			// Хост (editor-dock чат-вьюпорта) оставляет transcript'у 1 строку: он покажет
			// первые 23 строки рендера. Footer обязан попасть в них, а не быть 24-й.
			assert.equal(out.length, 23, "высота = terminal.rows - reserveRows");
			assert.ok(out[0].includes("session-trace"), `header: ${out[0]}`);
			assert.ok(out[22].includes("/80"), `footer с позицией на последней строке: ${out[22]}`);
		} finally {
			view.dispose();
		}
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
});

test("reserveRows учитывается в теле ленты: PgDn с верха сдвигает на (rows - reserve - 5)", () => {
	const file = writeSession(40);
	try {
		// rows=15, reserve=1 → avail 14, тело 12; PgDn = тело-3 = 9 строк.
		const view = new TraceView({
			tui: mockTui(15, 200) as any,
			theme: mockTheme() as any,
			file,
			mode: "live",
			reserveRows: 1,
			onClose: () => {},
		});
		try {
			view.render(160); // прогрев кэша и follow за хвост
			view.handleInput("\x1b[H"); // home: scrollTop = 0
			view.handleInput(PAGE_DOWN);
			const out = view.render(160);
			// scrollTop 9 → верх тела = строка ленты №10 (индекс 9): вторая строка
			// пятого элемента («question 5»); out[0] — header, out[1] — верх тела.
			assert.ok(out[1].includes("question 5"), `после PgDn верх тела: ${out[1]}`);
		} finally {
			view.dispose();
		}
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
});

test("handleMouse: колесо крутит ленту и возвращает handled; вниз у хвоста возвращает follow", () => {
	const file = writeSession(40);
	try {
		const view = new TraceView({
			tui: mockTui(15, 200) as any,
			theme: mockTheme() as any,
			file,
			mode: "replay",
			onClose: () => {},
		});
		try {
			view.render(160);
			view.handleInput(END); // к хвосту, follow=true (бейдж LIVE)
			assert.ok(view.render(160)[0].includes("LIVE"), "после End — follow");
			assert.equal(view.handleMouse(wheelEvent(-3))?.handled, true, "wheel вверх перехвачен");
			assert.ok(!view.render(160)[0].includes("LIVE"), "wheel вверх снимает follow");
			assert.equal(view.handleMouse(wheelEvent(0)), undefined, "wheel без дельты не перехватывается");
			view.handleMouse(wheelEvent(3));
			view.handleInput(PAGE_DOWN); // докрутить до хвоста (кламп) → atTail вернёт follow
			assert.ok(view.render(160)[0].includes("LIVE"), "у хвоста follow вернулся");
		} finally {
			view.dispose();
		}
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
});
