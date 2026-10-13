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

test("decideProvider: langsearch with a non-empty key", () => {
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "langsearch", LANGSEARCH_API_KEY: "k" }), {
		name: "langsearch",
	});
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "  LangSearch  ", LANGSEARCH_API_KEY: " k " }), {
		name: "langsearch",
	});
});

test("decideProvider: langsearch without a key falls back to ddg with a reason", () => {
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "langsearch" }), {
		name: "ddg",
		fallbackReason: "PI_WEB_SEARCH_PROVIDER=langsearch but LANGSEARCH_API_KEY is not set",
	});
	assert.deepEqual(decideProvider({ PI_WEB_SEARCH_PROVIDER: "langsearch", LANGSEARCH_API_KEY: "   " }), {
		name: "ddg",
		fallbackReason: "PI_WEB_SEARCH_PROVIDER=langsearch but LANGSEARCH_API_KEY is not set",
	});
});
