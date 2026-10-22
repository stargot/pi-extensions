import assert from "node:assert/strict";
import { test } from "node:test";
import { decideProvider } from "../providers/select.ts";

test("decideProvider: default is ddg", () => {
	assert.deepEqual(decideProvider({}), { name: "ddg" });
});

test("decideProvider: explicit ddg and unknown values resolve to ddg", () => {
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "ddg" }), { name: "ddg" });
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "DDG" }), { name: "ddg" });
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "ddq" }), { name: "ddg" });
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "  " }), { name: "ddg" });
});
