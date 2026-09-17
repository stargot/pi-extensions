import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fetchAndExtract,
	type FetchOutcome,
	type RenderResult,
} from "../fetch/fetcher.ts";

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

/** Renderer double that records calls and always answers with `result`. */
function fakeRenderer(result: RenderResult | null): {
	fn: (url: string, signal: AbortSignal | undefined) => Promise<RenderResult | null>;
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

/** 3xx response with a Location header (manual-redirect hop). */
function redirectResponse(location: string, status = 302): Response {
	return new Response(null, { status, headers: { Location: location } });
}

const HTML_URL = "https://docs.example.com/post/1";

/**
 * Marker result for tests where the render fallback must NOT be consulted:
 * a distinctive finalUrl/title so that any accidental use of the result
 * would flip an assertion instead of passing silently.
 */
const BRIDGE_RESULT: RenderResult = {
	title: "Bridge Title",
	markdown: "# Bridge Title\n\nBridge-rendered content.",
	finalUrl: "https://bridge.example/rendered",
};

function baseDeps(overrides: {
	impl: typeof fetch;
	renderer: ReturnType<typeof fakeRenderer>;
}) {
	return {
		fetchImpl: overrides.impl,
		renderFn: overrides.renderer.fn,
		retryBackoffMs: 1,
	};
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
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
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
	assert.equal(renderer.calls.length, 0);

	// Full browser header set from the ported source.
	assert.equal(calls.length, 1);
	const headers = calls[0].init.headers as Record<string, string>;
	assert.match(headers["User-Agent"], /^Mozilla\/5\.0 \(Macintosh;/);
	assert.equal(headers["Sec-Fetch-Dest"], "document");
	assert.equal(headers["Sec-Fetch-Mode"], "navigate");
	assert.equal(headers["Upgrade-Insecure-Requests"], "1");
	assert.ok(calls[0].init.signal, "fetch receives a combined signal");
});

test("429 then 429 → error 'http' after the single retry, renderFn 0 calls", async () => {
	const rateLimited = () =>
		new Response("slow down", { status: 429, statusText: "Too Many Requests" });
	const { impl, calls } = scriptedFetch([rateLimited(), rateLimited()]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		"https://example.com/rate-limited",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /HTTP 429/);
	assert.equal(calls.length, 2, "exactly one retry on 429");
	assert.equal(renderer.calls.length, 0);
});

test("429 then 200 → ok after one retry", async () => {
	const { impl, calls } = scriptedFetch([
		new Response("slow down", { status: 429 }),
		okResponse(articleHtml(), "text/html; charset=utf-8", HTML_URL),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "My Article");
	assert.equal(calls.length, 2);
	assert.equal(renderer.calls.length, 0);
});

test("404 → error without retry, renderFn 0 calls", async () => {
	const { impl, calls } = scriptedFetch([
		new Response("nope", { status: 404, statusText: "Not Found" }),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		"https://example.com/missing",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /HTTP 404/);
	assert.equal(calls.length, 1);
	assert.equal(renderer.calls.length, 0);
});

test("article null + JS-rendered → renderFn called once with finalUrl and caller signal", async () => {
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const renderer = fakeRenderer({
		title: "Rendered Title",
		markdown: "# Rendered Title\n\nRendered content.",
		finalUrl: HTML_URL,
	});
	const controller = new AbortController();
	const outcome = await fetchAndExtract(HTML_URL, controller.signal, {
		fetchImpl: impl,
		renderFn: renderer.fn,
		retryBackoffMs: 1,
	});

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "Rendered Title");
	assert.equal(outcome.content, "# Rendered Title\n\nRendered content.");
	assert.equal(outcome.finalUrl, HTML_URL);
	assert.equal(renderer.calls.length, 1);
	assert.equal(renderer.calls[0].url, HTML_URL);
	// The caller's own signal is handed to the renderer (the bridge combines
	// it with its own timeouts).
	assert.equal(renderer.calls[0].signal, controller.signal);
});

test("article null + JS-rendered + renderFn null → honest error 'empty'", async () => {
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "empty");
	assert.match(outcome.errorMessage!, /JavaScript-rendered/);
	assert.match(
		outcome.errorMessage!,
		/browser-bridge fallback was unavailable or came up empty/,
	);
	assert.match(outcome.errorMessage!, /web_search/);
	assert.equal(outcome.content, "");
	assert.equal(renderer.calls.length, 1);
});

// ── Render fallback: result mapping ─────────────────────────────────

test("render lands on its own finalUrl (in-browser redirect) → outcome carries the render's finalUrl, title falls back to it", async () => {
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const renderedUrl = "https://docs.example.com/rendered/page-name";
	const renderer = fakeRenderer({
		title: null,
		markdown: "# Rendered\n\nBody.",
		finalUrl: renderedUrl,
	});
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.finalUrl, renderedUrl);
	// Title fallback reads the basename off the render's final URL.
	assert.equal(outcome.title, "page-name");
	assert.equal(outcome.content, "# Rendered\n\nBody.");
});

// ── SSRF regression: the render fallback sits behind the guard ──────

test("SSRF regression: renderFn 0 calls when the guard blocks the URL or a redirect hop", async () => {
	const renderer = fakeRenderer(BRIDGE_RESULT);

	// The requested URL itself is private: blocked before any network
	// activity, the render fallback included.
	const blocked = await fetchAndExtract("http://127.0.0.1/secret", undefined, {
		fetchImpl: scriptedFetch([]).impl,
		renderFn: renderer.fn,
		retryBackoffMs: 1,
	});
	assert.equal(errorKindOf(blocked), "ssrf");
	assert.match(blocked.errorMessage!, /loopback/);

	// A public URL redirecting into the private network: the blocked hop
	// fails the fetch before extraction — the render fallback is never
	// consulted either.
	const { impl, calls } = scriptedFetch([
		redirectResponse("http://169.254.169.254/latest/meta-data/"),
	]);
	const redirected = await fetchAndExtract(
		"https://example.com/start",
		undefined,
		{ fetchImpl: impl, renderFn: renderer.fn, retryBackoffMs: 1 },
	);
	assert.equal(errorKindOf(redirected), "redirect");
	assert.match(redirected.errorMessage!, /link-local/);
	assert.equal(calls.length, 1, "only the original URL is fetched");

	assert.equal(
		renderer.calls.length,
		0,
		"the render fallback is never consulted for guard-blocked fetches",
	);
});

test("oversized HTML body → error 'too-large', renderFn 0 calls", async () => {
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
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "too-large");
	assert.match(outcome.errorMessage!, /too large/);
	assert.equal(renderer.calls.length, 0);
});

test("SSRF guard: http://127.0.0.1/ blocked before any fetch or renderFn call", async () => {
	const { impl, calls } = scriptedFetch([]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		"http://127.0.0.1/secret",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "ssrf");
	assert.match(outcome.errorMessage!, /loopback/);
	assert.equal(calls.length, 0);
	assert.equal(renderer.calls.length, 0);
});

test("short non-JS article → status ok with a warning, content kept", async () => {
	const { impl } = scriptedFetch([
		okResponse(THIN_HTML, "text/html; charset=utf-8", HTML_URL),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.warning, "Extracted content appears incomplete");
	assert.ok(outcome.content.length > 0);
	assert.equal(outcome.title, "Thin");
	assert.equal(renderer.calls.length, 0);
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
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		"https://example.com/report",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /body stream failed mid-read/);
	assert.equal(renderer.calls.length, 0);
});

test(".pdf URL with octet-stream header → not rejected as unsupported, PDF branch chosen", async () => {
	// Common CDN/attachment case: the pathname says .pdf, the header says
	// application/octet-stream. The pdf flag (isPdfUrl) must win over the
	// header-level content-type rejection. The body is bogus bytes, so
	// extractPdf may fail on them — that surfaces as "empty", which still
	// proves the extractPdf branch was chosen ("unsupported" would mean the
	// header check fired first); real extraction is covered by the manual
	// smoke test, plan task 12.
	const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xde, 0xad]);
	const { impl } = scriptedFetch([
		okResponse(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(pdfBytes);
					controller.close();
				},
			}),
			"application/octet-stream",
			HTML_URL,
		),
	]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		"https://example.com/report.pdf",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.notEqual(
		outcome.errorKind,
		"unsupported",
		`expected the PDF branch, got "${outcome.errorKind}": ${outcome.errorMessage}`,
	);
	// Deterministic branch proof: extractPdf is entered and fails on the
	// bogus bytes (pdf.js error wrapped as "empty" by the fetcher) — the
	// octet-stream header never fired the unsupported check.
	assert.equal(outcome.errorKind, "empty");
	assert.match(outcome.errorMessage!, /Invalid PDF structure/);
	assert.equal(renderer.calls.length, 0);
});

test("unsupported content-type (image) → error 'unsupported', renderFn 0 calls", async () => {
	const { impl, calls } = scriptedFetch([
		okResponse("fake-bytes", "image/png", HTML_URL),
	]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "unsupported");
	assert.match(outcome.errorMessage!, /image\/png/);
	assert.equal(calls.length, 1);
	assert.equal(renderer.calls.length, 0);
});

test("plain text → content passed through as-is, title from first heading, finalUrl falls back to url", async () => {
	const body = "# Release Notes\n\nSome plain text content.";
	// No url override: a real Response carries url "" → finalUrl = requested.
	const { impl } = scriptedFetch([
		okResponse(body, "text/plain; charset=utf-8"),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		"https://example.com/notes.txt",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "Release Notes");
	assert.equal(outcome.content, body);
	assert.equal(outcome.finalUrl, "https://example.com/notes.txt");
	assert.equal(renderer.calls.length, 0);
});

// ── Manual redirects (SSRF guard re-checked per hop) ─────────────────

test("302 to a private address → error 'redirect' at the first hop, the blocked target is never fetched", async () => {
	const { impl, calls } = scriptedFetch([
		redirectResponse("http://169.254.169.254/latest/meta-data/"),
	]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		"https://example.com/start",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "redirect");
	assert.match(outcome.errorMessage!, /link-local/);
	assert.equal(calls.length, 1, "only the original URL is fetched");
	assert.equal(calls[0].url, "https://example.com/start");
	assert.equal(renderer.calls.length, 0);
});

test("302 to a public URL → followed manually, finalUrl is the redirect target", async () => {
	const movedUrl = "https://docs.example.com/moved";
	const { impl, calls } = scriptedFetch([
		redirectResponse("/moved"),
		okResponse(articleHtml(), "text/html; charset=utf-8", movedUrl),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		"https://docs.example.com/old",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.finalUrl, movedUrl);
	assert.equal(outcome.title, "My Article");
	assert.equal(calls.length, 2);
	// The second hop goes to the absolute redirect target...
	assert.equal(calls[1].url, movedUrl);
	// ...and every hop carries redirect: "manual".
	assert.equal(calls[0].init.redirect, "manual");
	assert.equal(calls[1].init.redirect, "manual");
	assert.equal(renderer.calls.length, 0);
});

test("five redirects in a row → error 'redirect' (hop budget exhausted), no further fetch", async () => {
	const responses = Array.from({ length: 5 }, (_, i) =>
		redirectResponse(`https://example.com/step-${i + 2}`),
	);
	const { impl, calls } = scriptedFetch(responses);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		"https://example.com/step-1",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "redirect");
	assert.match(outcome.errorMessage!, /Too many redirects/);
	assert.equal(calls.length, 5, "the 6th hop is never fetched");
});

// ── Retry and abort semantics ────────────────────────────────────────

test("network error then 200 → retried exactly once, then ok", async () => {
	const { impl, calls } = scriptedFetch([
		new Error("getaddrinfo EAI_AGAIN example.com"),
		okResponse(articleHtml(), "text/html; charset=utf-8", HTML_URL),
	]);
	const renderer = fakeRenderer(null);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "My Article");
	assert.equal(calls.length, 2, "exactly one retry after a network error");
	assert.equal(renderer.calls.length, 0);
});

test("abort during fetch → no retry, error surfaced (never a renderFn case)", async () => {
	const abortError = new Error("This operation was aborted");
	abortError.name = "AbortError";
	const { impl, calls } = scriptedFetch([abortError]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "http");
	assert.match(outcome.errorMessage!, /abort/i);
	assert.equal(calls.length, 1, "aborts are never retried");
	assert.equal(renderer.calls.length, 0);
});

// ── Header-level content-type check (before the body is read) ───────

test("unsupported content-type is decided from headers before the body is streamed", async () => {
	let pulls = 0;
	// Endless 1MB-chunk body: if the body were read, the outcome would be
	// "too-large" (5MB cap) and pulls ≥ 5 — never "unsupported".
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1;
			controller.enqueue(new Uint8Array(1024 * 1024));
		},
	});
	const { impl } = scriptedFetch([
		okResponse(body, "image/png", HTML_URL),
	]);
	const renderer = fakeRenderer(BRIDGE_RESULT);
	const outcome = await fetchAndExtract(
		HTML_URL,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(errorKindOf(outcome), "unsupported");
	assert.match(outcome.errorMessage!, /image\/png/);
	// Exactly 1 pull = the spec-mandated queue fill at stream start (HWM 1),
	// which fires on the first microtask tick regardless of the fetcher. If
	// the body had actually been read, the 5MB cap would force pulls ≥ 6.
	assert.equal(pulls, 1, "the body must never be consumed past its start queue");
	assert.equal(renderer.calls.length, 0);
});

// ── Title fallback to the URL basename ──────────────────────────────

test("JS-rendered page + render title null → title falls back to the URL basename", async () => {
	const fileUrl = "https://example.com/docs/setup-guide";
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", fileUrl),
	]);
	const renderer = fakeRenderer({
		title: null,
		markdown: "# Rendered\n\nBody.",
		finalUrl: fileUrl,
	});
	const outcome = await fetchAndExtract(
		fileUrl,
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, "setup-guide");
});

test("URL with no basename (bare origin) → title stays null", async () => {
	const { impl } = scriptedFetch([
		okResponse(SPA_HTML, "text/html; charset=utf-8", "https://example.com/"),
	]);
	const renderer = fakeRenderer({
		title: null,
		markdown: "# Rendered\n\nBody.",
		finalUrl: "https://example.com/",
	});
	const outcome = await fetchAndExtract(
		"https://example.com/",
		undefined,
		baseDeps({ impl, renderer }),
	);

	assert.equal(outcome.status, "ok");
	assert.equal(outcome.title, null);
});
