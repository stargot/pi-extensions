/**
 * Модульные тесты chip() (B8): bg-подложка при наличии токена, fg-only без него,
 * guard на бросающий Theme.bg и на стайлер вовсе без bg (CLI plainStyler).
 * Тема мокается duck-typed объектом с настоящими ANSI-кодами.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChipStyler, CHIP_PAD, chip } from "../chip.ts";

const FG: Record<string, string> = { success: "32", error: "31", warning: "33", accent: "36", toolTitle: "97" };
const BG: Record<string, string> = {
	toolSuccessBg: "42",
	toolErrorBg: "41",
	toolPendingBg: "43",
	customMessageBg: "44",
};

/** Duck-typed тема с парными fg/bg-методами, как Theme в pi-coding-agent 0.85. */
const ansiTheme: ChipStyler = {
	fg: (color, text) => `\x1b[${FG[color] ?? "37"}m${text}\x1b[39m`,
	bg: (color, text) => `\x1b[${BG[color] ?? "47"}m${text}\x1b[49m`,
};

test("chip с bg-токеном: подложка оборачивает fg-текст, паддинг внутри подложки", () => {
	const out = chip(ansiTheme, "ok", { fg: "success", bg: "toolSuccessBg" });
	// Порядок композиции: bg снаружи, fg внутри; сброс fg (39) раньше сброса bg (49).
	assert.equal(out, "\x1b[42m\x1b[32m ok \x1b[39m\x1b[49m");
	assert.equal(CHIP_PAD, 1);
});

test("chip без bg: только fg, никаких bg-escape", () => {
	const out = chip(ansiTheme, "glm", { fg: "toolTitle" });
	assert.equal(out, "\x1b[97m glm \x1b[39m");
	// bg-escape (\x1b[4Xm) отсутствует: fg-коды 3X и сбросы 39/49 префикса \x1b[4 не дают
	assert.ok(!out.includes("\x1b[4"), "no background escape");
});

test("guard: bg-токен отсутствует в теме (Theme.bg бросает) → деградация в fg-only без падения", () => {
	const partialTheme: ChipStyler = {
		fg: (_color, text) => text,
		bg: (color, _text) => {
			throw new Error(`Unknown theme background color: ${color}`);
		},
	};
	// searchMatchBg — опциональный токен темы; чип обязан отрендериться и без него.
	assert.equal(chip(partialTheme, "74%", { fg: "success", bg: "searchMatchBg" }), " 74% ");
});

test("guard: у стайлера нет метода bg вовсе (CLI plainStyler) → fg-only", () => {
	const plain: ChipStyler = { fg: (_color, text) => text };
	assert.equal(chip(plain, "2 errors", { fg: "error", bg: "toolErrorBg" }), " 2 errors ");
});

test("pad=0 снимает обрамление, отрицательный pad зажимается в 0", () => {
	assert.equal(chip(ansiTheme, "x", { fg: "error", bg: "toolErrorBg" }, 0), "\x1b[41m\x1b[31mx\x1b[39m\x1b[49m");
	assert.equal(chip(ansiTheme, "x", { fg: "error", bg: "toolErrorBg" }, -3), "\x1b[41m\x1b[31mx\x1b[39m\x1b[49m");
	assert.equal(chip(ansiTheme, "x", { fg: "error" }, 2), "\x1b[31m  x  \x1b[39m");
});
