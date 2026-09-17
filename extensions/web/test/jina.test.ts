import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWithJinaReader } from "../fetch/jina.ts";

const VALID_PAGE = [
	"Title: Example Domain",
	"URL Source: https://example.com/page",
	"Markdown Content:",
	"# Example Domain",
	"",
	"Welcome to the example page. A few more sentences follow so the tail",
	"clears the minimum-length gate that discards shorter stub payloads.",
	"",
].join("\n");

interface CapturedCall {
	url: string;
	init: RequestInit;
}

/** Injectable fetch that records every call — no monkey-patching of globals. */
function recordingFetch(
	status: number,
	body: string,
): { impl: typeof fetch; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	const impl: typeof fetch = (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return Promise.resolve(new Response(body, { status }));
	};
	return { impl, calls };
}

test("valid Jina payload → { title, markdown } after the marker", async () => {
	const { impl } = recordingFetch(200, VALID_PAGE);
	const result = await extractWithJinaReader(
		"https://example.com/page",
		undefined,
		impl,
	);
	assert.deepEqual(result, {
		title: "Example Domain",
		markdown:
			"# Example Domain\n\nWelcome to the example page. A few more sentences follow so the tail\nclears the minimum-length gate that discards shorter stub payloads.",
	});
});

test("payload without the 'Markdown Content:' marker → null", async () => {
	const { impl } = recordingFetch(200, "Totally unexpected body shape.");
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.equal(result, null);
});

test("'Loading...' placeholder page → null", async () => {
	const { impl } = recordingFetch(200, "Markdown Content:\nLoading...");
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.equal(result, null);
});

test("'Please enable JavaScript' placeholder page → null", async () => {
	const body = "Markdown Content:\nPlease enable JavaScript to view this page.";
	const { impl } = recordingFetch(200, body);
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.equal(result, null);
});

test("fetch rejection → null, never throws", async () => {
	const impl: typeof fetch = () => Promise.reject(new Error("network down"));
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.equal(result, null);
});

test("HTTP 500 → null", async () => {
	const { impl } = recordingFetch(500, "Markdown Content:\n# Broken");
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.equal(result, null);
});

test("request goes to https://r.jina.ai/<original> with the Jina headers", async () => {
	const { impl, calls } = recordingFetch(200, VALID_PAGE);
	await extractWithJinaReader("https://example.com/a?b=1", undefined, impl);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://r.jina.ai/https://example.com/a?b=1");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Accept, "text/markdown");
	assert.equal(headers["X-No-Cache"], "true");
});

test("caller signal is forwarded as a combined signal, abort propagates", async () => {
	const controller = new AbortController();
	const { impl, calls } = recordingFetch(200, VALID_PAGE);
	await extractWithJinaReader(
		"https://example.com",
		controller.signal,
		impl,
	);
	const forwarded = calls[0].init.signal as AbortSignal;
	assert.ok(forwarded, "fetch receives a signal");
	assert.notEqual(forwarded, controller.signal);
	assert.equal(forwarded.aborted, false);
	controller.abort();
	assert.equal(forwarded.aborted, true);
});

test("markdown without a heading → title null, content kept", async () => {
	// Body must clear MIN_MARKDOWN_LENGTH (100) — shorter tails are treated
	// as stubs (see the next test).
	const body =
		"Just plain text, no heading here, but enough words follow to push " +
		"this paragraph well past the one-hundred-character minimum that a " +
		"payload has to clear before it counts as real content.";
	const { impl } = recordingFetch(200, `Markdown Content:\n${body}`);
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.deepEqual(result, {
		title: null,
		markdown: body,
	});
});

test("markdown tail shorter than 100 chars after the marker → null (min-length check)", async () => {
	const { impl } = recordingFetch(
		200,
		"Markdown Content:\n# Tiny\n\nStub body, no real article.",
	);
	const result = await extractWithJinaReader(
		"https://example.com",
		undefined,
		impl,
	);
	assert.equal(result, null);
});
