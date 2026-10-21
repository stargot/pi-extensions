import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackTheme } from "../cli.ts";

test("fallbackTheme: bright colors are valid SGR (bold;color), not a fused code", () => {
	const th = fallbackTheme();
	assert.equal(th.fg("accent", "x"), "\x1b[1;93mx\x1b[0m");
	assert.equal(th.fg("toolTitle", "x"), "\x1b[1;96mx\x1b[0m");
	assert.equal(th.fg("text", "x"), "\x1b[97mx\x1b[0m");
	assert.equal(th.fg("accent", ""), "");
});
