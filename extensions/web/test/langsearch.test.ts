import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createLangSearchProvider,
	isDomainLike,
	LANGSEARCH_URL,
	parseLangSearchResponse,
	toLangSearchParams,
} from "../providers/langsearch.ts";
import type { BuiltSearchQuery } from "../query.ts";

const FIXTURE = {
	data: {
		webPages: {
			value: [
				{
					name: "First result",
					url: "https://example.com/first",
					snippet: "First snippet.",
				},
				{
					name: "Second result",
					url: "https://example.com/second",
					snippet: "Second snippet.",
				},
			],
		},
	},
};

interface RecordedCall {
	url: string;
	init: RequestInit;
}

function scriptedFetch(responses: Array<Response | Error>): { impl: typeof fetch; calls: RecordedCall[] } {
	const queue = [...responses];
	const calls: RecordedCall[] = [];
	const impl: typeof fetch = (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = queue.shift();
		if (next instanceof Error) return Promise.reject(next);
		return Promise.resolve(next!);
	};
	return { impl, calls };
}

async function withFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

function built(over: Partial<BuiltSearchQuery> = {}): BuiltSearchQuery {
	return {
		query: "postgres",
		exactPhrases: [],
		excludeTerms: [],
		...over,
	};
}

async function rejectsTransient(promise: Promise<unknown>): Promise<void> {
	await assert.rejects(promise, (error: { transient?: boolean }) => {
		assert.equal(error.transient, true);
		return true;
	});
}

test("parseLangSearchResponse: data.webPages.value maps to SearchResult in order", () => {
	assert.deepEqual(parseLangSearchResponse(FIXTURE), [
		{ title: "First result", url: "https://example.com/first", snippet: "First snippet." },
		{ title: "Second result", url: "https://example.com/second", snippet: "Second snippet." },
	]);
});

test("parseLangSearchResponse: missing fields become empty strings", () => {
	const results = parseLangSearchResponse({
		data: { webPages: { value: [{ name: "Only name" }, { url: "https://example.com/x" }, {}] } },
	});
	assert.deepEqual(results, [
		{ title: "Only name", url: "", snippet: "" },
		{ title: "", url: "https://example.com/x", snippet: "" },
		{ title: "", url: "", snippet: "" },
	]);
});

test("parseLangSearchResponse: empty value is no results, absent shape throws", () => {
	assert.deepEqual(parseLangSearchResponse({ data: { webPages: { value: [] } } }), []);
	assert.throws(
		() => parseLangSearchResponse({ data: { webPages: {} } }),
		/LangSearch returned unexpected response shape/,
	);
	assert.throws(() => parseLangSearchResponse({}), /LangSearch returned unexpected response shape/);
	assert.throws(() => parseLangSearchResponse(null), /LangSearch returned unexpected response shape/);
});

test("isDomainLike: bare hostnames with a dot only", () => {
	assert.equal(isDomainLike("example.com"), true);
	assert.equal(isDomainLike("bad.example.com"), true);
	assert.equal(isDomainLike("localhost"), false);
	assert.equal(isDomainLike("sqlite 3"), false);
	assert.equal(isDomainLike("not a url ??"), false);
	assert.equal(isDomainLike("mysql"), false);
});

test("toLangSearchParams: phrases stay quoted, non-domain excludes stay in the query", () => {
	const params = toLangSearchParams(
		built({
			query: 'postgres "skip locked" -mysql -"sqlite 3" site:stackoverflow.com',
			baseQuery: "postgres",
			exactPhrases: ["skip locked"],
			excludeTerms: ["mysql", "sqlite 3"],
			site: "stackoverflow.com",
		}),
		5,
	);
	assert.equal(params.query, 'postgres "skip locked" -mysql -"sqlite 3"');
	assert.equal(params.count, 5);
	assert.deepEqual(params.includeDomains, ["stackoverflow.com"]);
	assert.equal(params.excludeDomains, undefined);
});

test("toLangSearchParams: domain-like excludes move to excludeDomains", () => {
	const params = toLangSearchParams(
		built({
			baseQuery: "docs",
			excludeTerms: ["bad.example.com", "https://other.example.org/page", "sqlite 3"],
		}),
		5,
	);
	assert.equal(params.query, 'docs -"sqlite 3"');
	assert.deepEqual(params.excludeDomains, ["bad.example.com", "other.example.org"]);
	assert.equal(params.includeDomains, undefined);
});

test("toLangSearchParams: count is clamped into [1, 10]", () => {
	assert.equal(toLangSearchParams(built(), 99).count, 10);
	assert.equal(toLangSearchParams(built(), 0).count, 1);
	assert.equal(toLangSearchParams(built(), 3.7).count, 4);
	assert.equal(toLangSearchParams(built(), Number.NaN).count, 5);
});

test("createLangSearchProvider: POSTs JSON with bearer auth and maps the response", async () => {
	const { impl, calls } = scriptedFetch([
		new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } }),
	]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "test-key", backoffMs: 1 });
		const results = await provider.search(
			built({
				baseQuery: "postgres",
				exactPhrases: ["skip locked"],
				excludeTerms: ["mysql"],
				site: "stackoverflow.com",
			}),
			{ count: 7 },
		);
		assert.deepEqual(results, [
			{ title: "First result", url: "https://example.com/first", snippet: "First snippet." },
			{ title: "Second result", url: "https://example.com/second", snippet: "Second snippet." },
		]);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, LANGSEARCH_URL);
	assert.equal(calls[0]!.init.method, "POST");
	const headers = new Headers(calls[0]!.init.headers as HeadersInit);
	assert.equal(headers.get("Authorization"), "Bearer test-key");
	assert.equal(headers.get("Content-Type"), "application/json");
	const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
	assert.equal(body.query, 'postgres "skip locked" -mysql');
	assert.equal(body.count, 7);
	assert.deepEqual(body.includeDomains, ["stackoverflow.com"]);
	assert.equal("excludeDomains" in body, false);
});

test("createLangSearchProvider: 401 is transient and exhausts one retry", async () => {
	const { impl, calls } = scriptedFetch([new Response(null, { status: 401 }), new Response(null, { status: 401 })]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "k", backoffMs: 1 });
		await rejectsTransient(provider.search(built(), { count: 5 }));
	});
	assert.equal(calls.length, 2);
});

test("createLangSearchProvider: 500 is transient and retried once", async () => {
	const { impl, calls } = scriptedFetch([new Response(null, { status: 500 }), new Response(null, { status: 500 })]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "k", backoffMs: 1 });
		await rejectsTransient(provider.search(built(), {}));
	});
	assert.equal(calls.length, 2);
});

test("createLangSearchProvider: network failure is transient", async () => {
	const { impl, calls } = scriptedFetch([new Error("socket hang up"), new Error("socket hang up")]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "k", backoffMs: 1 });
		await rejectsTransient(provider.search(built(), {}));
	});
	assert.equal(calls.length, 2);
});

test("createLangSearchProvider: other 4xx fail fast without retry", async () => {
	const { impl, calls } = scriptedFetch([new Response(null, { status: 400 })]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "k", backoffMs: 1 });
		await assert.rejects(provider.search(built(), {}), /LangSearch HTTP 400/);
	});
	assert.equal(calls.length, 1);
});

test("createLangSearchProvider: invalid JSON on 2xx is not transient", async () => {
	const { impl, calls } = scriptedFetch([new Response("not json{", { status: 200 })]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "k", backoffMs: 1 });
		await assert.rejects(provider.search(built(), {}), (error: { transient?: boolean; message: string }) => {
			assert.equal(error.transient, undefined);
			assert.match(error.message, /invalid JSON/);
			return true;
		});
	});
	assert.equal(calls.length, 1);
});

test("createLangSearchProvider: 2xx without data.webPages.value is not transient", async () => {
	const { impl, calls } = scriptedFetch([
		new Response(JSON.stringify({ code: 200, msg: "ok, but no data" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	]);
	await withFetch(impl, async () => {
		const provider = createLangSearchProvider({ apiKey: "k", backoffMs: 1 });
		await assert.rejects(provider.search(built(), {}), (error: { transient?: boolean; message: string }) => {
			assert.equal(error.transient, undefined);
			assert.match(error.message, /LangSearch returned unexpected response shape/);
			return true;
		});
	});
	assert.equal(calls.length, 1);
});
