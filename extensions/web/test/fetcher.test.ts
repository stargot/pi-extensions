import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAndExtract, type FetchOutcome } from "../fetch/fetcher.ts";
import type { JinaResult } from "../fetch/jina.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

// ~210 chars of visible text per paragraph; three of them clear
// Readability's charThreshold (500) so the fixture parses as an article.
const paragraph = (marker: string): string =>
	`<p>${marker}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>`;

function articleHtml(extra = ""): string {
	return [
		"<!DOCTYPE html>",
		"<html><head><title>My Article</title></head>",
		"<body>",
		"<article>",
		"<h1>My Article</h1>",
		"<h2>Overview</h2>",
		paragraph("First"),
		paragraph("Second"),
		paragraph("Third"),
		extra,
		"</article>",
		"</body></html>",
	].join("");
}

// JS-rendered shell: < 500 chars of visible text, 5 <script> tags —
// isLikelyJSRendered true, Readability finds no article.
const SPA_HTML =
	"<html><head><title>App</title><script src=\"/app.js\"></script></head>" +
	"<body><div id=\"root\"></div>" +
	"<script>a</script><script>b</script><script>c</script><script>d</script>" +
	"</body></html>";

// A real-but-thin article: whitespace padding puts its textContent over
// Readability's 500-char threshold, but turndown collapses the padding, so
// the markdown lands under MIN_USEFUL_CONTENT (the "appears incomplete"
// path). Verified: textContent ~890 chars, markdown 409 chars.
const THIN_HTML =
	"<html><head><title>Thin</title></head><body><article><p>" +
	Array.from({ length: 60 }, (_, i) => `word${i}`).join("\n        ") +
	"</p></article></body></html>";

// ── Injectable doubles ───────────────────────────────────────────────

interface RecordedCall {
	url: string;
	init: RequestInit;
}

/**
 * Fetch double that answers each call with the next scripted response
 * (an Error instance is thrown instead) and records every call.
 */
function scriptedFetch(
	responses: Array<Response | Error>,
): { impl: typeof fetch; calls: RecordedCall[] } {
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

/** Jina double that records calls and always answers with `result`. */
function fakeJina(result: JinaResult | null): {
	fn: (url: string, signal: AbortSignal | undefined) => Promise<JinaResult | null>;
	calls: Array<{ url: string; signal: AbortSignal | undefined }>;
} {
	const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
	const fn = async (url: string, signal: AbortSignal | undefined) => {
		calls.push({ url, signal });
		return result;
	};
	return { fn, calls };
}

/** 200 response with a Content-Type and a final URL after "redirects". */
function okResponse(
	body: string | ReadableStream<Uint8Array>,
	contentType: string,
	url?: string,
): Response {
	const response = new Response(body, {
		status: 200,
		headers: { "Content-Type": contentType },
	});
	if (url) Object.defineProperty(response, "url", { value: url });
	return response;
}

const HTML_URL = "https://docs.example.com/post/1";

function baseDeps(overrides: {
	impl: typeof fetch;
	jina: ReturnType<typeof fakeJina>;
}) {
	return { fetchImpl: overrides.impl, jinaFn: overrides.jina.fn, retryBackoffMs: 1 };
}

function errorKindOf(outcome: FetchOutcome): string {
	assert.equal(outcome.status, "error");
	return outcome.errorKind!;
}

// ── Tests ────────────────────────────────────────────────────────────

test("200 HTML article → ok markdown with links resolved against response.url", async () => {
	const { impl, calls } = scriptedFetch([
		okResponse(
			articleHtml("<p>See the <a href=\"/related\">related page</a>.</p>"),
			"text/html; charset=utf-8",
			HTML_URL,
		),
	]);
	const jina = fakeJina(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.url, HTML_URL);
	assert.equal(outcome.finalUrl, HTML_URL);
	assert.equal(outcome.title, "My Article");
	assert.equal(outcome.warning, undefined);
	assert.ok(
		outcome.content.includes("[related page](https://docs.example.com/related)"),
		`link not resolved against final URL: ${outcome.content.slice(0, 200)}`,
	);
	assert.equal(jina.calls.length, 0);

	// Full browser header set from the ported source.
	assert.equal(calls.length, 1);
	const headers = calls[0].init.headers as Record<string, string>;
	assert.match(headers["User-Agent"], /^Mozilla\/5\.0 \(Macintosh;/);
	assert.equal(headers["Sec-Fetch-Dest"], "document");
	assert.equal(headers["Sec-Fetch-Mode"], "navigate");
	assert.equal(headers["Upgrade-Insecure-Requests"], "1");
	assert.ok(calls[0].init.signal, "fetch receives a combined signal");
});

test("429 then 429 → error 'http' after the single retry, jinaFn 0 calls", async () => {
	const rateLimited = () =>
		new Response("slow down", { status: 429, statusText: "Too Many Requests" });
	const { impl, calls } = scriptedFetch([rateLimited(), rateLimited()]);
	const jina = fakeJina({ title: "Jina", markdown: "# Jina" });
	const outcome = await fetchAndExtract(
		"https://example.com/rate-limited",
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /HTTP 429/);
	assert.equal(calls.length, 2, "exactly one retry on 429");
	assert.equal(jina.calls.length, 0);
});

test("429 then 200 → ok after one retry", async () => {
	const { impl, calls } = scriptedFetch([
		new Response("slow down", { status: 429 }),
		okResponse(articleHtml(), "text/html; charset=utf-8", HTML_URL),
	]);
	const jina = fakeJina(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "My Article");
	assert.equal(calls.length, 2);
	assert.equal(jina.calls.length, 0);
});

test("404 → error without retry, jinaFn 0 calls", async () => {
	const { impl, calls } = scriptedFetch([
		new Response("nope", { status: 404, statusText: "Not Found" }),
	]);
	const jina = fakeJina(null);
	const outcome = await fetchAndExtract(
		"https://example.com/missing",
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /HTTP 404/);
	assert.equal(calls.length, 1);
	assert.equal(jina.calls.length, 0);
});

test("article null + JS-rendered → jinaFn called once with finalUrl and caller signal", async () => {
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const jina = fakeJina({
		title: "Jina Title",
		markdown: "# Jina Title\n\nRendered content.",
	});
	const controller = new AbortController();
	const outcome = await fetchAndExtract(HTML_URL, controller.signal, {
		fetchImpl: impl,
		jinaFn: jina.fn,
		retryBackoffMs: 1,
	});

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "Jina Title");
	assert.equal(outcome.content, "# Jina Title\n\nRendered content.");
	assert.equal(jina.calls.length, 1);
	assert.equal(jina.calls[0].url, HTML_URL);
	// The caller's own signal is handed to Jina (Jina combines its timeout).
	assert.equal(jina.calls[0].signal, controller.signal);
});

test("article null + JS-rendered + Jina null → honest error 'empty'", async () => {
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const jina = fakeJina(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "empty");
	assert.match(outcome.errorMessage!, /JavaScript-rendered/);
	assert.match(outcome.errorMessage!, /web_search/);
	assert.equal(outcome.content, "");
	assert.equal(jina.calls.length, 1);
});

test("oversized HTML body → error 'too-large', jinaFn 0 calls", async () => {
	// Endless pull-based stream of 1MB chunks — like a real body that never
	// ends; the cap must cut it on streamed bytes, not content-length.
	const mb = new Uint8Array(1024 * 1024);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(mb);
		},
	});
	const { impl } = scriptedFetch([
		okResponse(body, "text/html; charset=utf-8", HTML_URL),
	]);
	const jina = fakeJina({ title: "Jina", markdown: "# Jina" });
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "too-large");
	assert.match(outcome.errorMessage!, /too large/);
	assert.equal(jina.calls.length, 0);
});

test("SSRF guard: http://127.0.0.1/ blocked before any fetch or Jina call", async () => {
	const { impl, calls } = scriptedFetch([]);
	const jina = fakeJina({ title: "Jina", markdown: "# Jina" });
	const outcome = await fetchAndExtract(
		"http://127.0.0.1/secret",
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "ssrf");
	assert.match(outcome.errorMessage!, /loopback/);
	assert.equal(calls.length, 0);
	assert.equal(jina.calls.length, 0);
});

test("short non-JS article → status ok with a warning, content kept", async () => {
	const { impl } = scriptedFetch([
		okResponse(THIN_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const jina = fakeJina(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.warning, "Extracted content appears incomplete");
	assert.ok(outcome.content.length > 0);
	assert.equal(outcome.title, "Thin");
	assert.equal(jina.calls.length, 0);
});

test("PDF content-type routes to the 20MB cap: a 7MB body passes the 5MB mark", async () => {
	// Yields seven 1MB chunks (7MB — over the 5MB HTML cap, under the 20MB
	// PDF cap), then errors. If the router picked the 5MB cap, the outcome
	// would be "too-large" at 6MB and the stream error could never surface;
	// seeing the stream error instead proves the PDF branch chose 20MB.
	// (The full extractPdf path needs real pdf.js — covered by the manual
	// smoke test, plan task 12.)
	let pulls = 0;
	const mb = new Uint8Array(1024 * 1024);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1;
			if (pulls > 7) {
				controller.error(new Error("body stream failed mid-read"));
				return;
			}
			controller.enqueue(mb);
		},
	});
	// Not a .pdf URL — the content-type alone must drive the branch.
	const { impl } = scriptedFetch([
		okResponse(body, "application/pdf", "https://example.com/report"),
	]);
	const jina = fakeJina({ title: "Jina", markdown: "# Jina" });
	const outcome = await fetchAndExtract(
		"https://example.com/report",
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /body stream failed mid-read/);
	assert.equal(jina.calls.length, 0);
});

test("unsupported content-type (image) → error 'unsupported', no Jina", async () => {
	const { impl, calls } = scriptedFetch([
		okResponse("fake-bytes", "image/png", HTML_URL),
	]);
	const jina = fakeJina({ title: "Jina", markdown: "# Jina" });
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(errorKindOf(outcome), "unsupported");
	assert.match(outcome.errorMessage!, /image\/png/);
	assert.equal(calls.length, 1);
	assert.equal(jina.calls.length, 0);
});

test("plain text → content passed through as-is, title from first heading, finalUrl falls back to url", async () => {
	const body = "# Release Notes\n\nSome plain text content.";
	// No url override: a real Response carries url "" → finalUrl = requested.
	const { impl } = scriptedFetch([
		okResponse(body, "text/plain; charset=utf-8"),
	]);
	const jina = fakeJina(null);
	const outcome = await fetchAndExtract(
		"https://example.com/notes.txt",
		undefined,
		baseDeps({ impl, jina }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "Release Notes");
	assert.equal(outcome.content, body);
	assert.equal(outcome.finalUrl, "https://example.com/notes.txt");
	assert.equal(jina.calls.length, 0);
});
