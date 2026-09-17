/**
 * web_fetch orchestration: SSRF-guarded fetch, content-type routing, capped
 * streaming body reads, one retry on transient failures, and extraction with
 * the Jina fallback.
 *
 * Port of the third-party web-fetch extension's extractViaHttp +
 * fetchAndExtract with the web-merge decisions applied:
 * - the SSRF guard runs before any network activity, Jina included (P0a);
 * - redirects are followed manually (redirect: "manual"): the target of
 *   every hop is re-checked by the SSRF guard before it is fetched, up to
 *   MAX_REDIRECT_HOPS fetches per attempt — a blocked/unparseable hop
 *   target or an exhausted hop budget fails as errorKind "redirect"
 *   (closes the redirect-rebinding hole of a native redirect follower);
 * - the content-type check runs on headers alone, before the body is read
 *   — a 10 MB image reports "unsupported", never "too-large";
 * - size caps are chosen before a single body byte is read and enforced on
 *   the bytes actually streamed — content-length is never trusted (P0b);
 * - one retry with ~1.5 s backoff for 429/5xx/network failures; other 4xx
 *   and aborts fail immediately, and transport-level failures never reach
 *   Jina (decision 5);
 * - Jina is consulted only when direct extraction comes up empty (null
 *   article or a JS-rendered shell); a short but real article succeeds with
 *   a warning instead of being thrown away (decision 5);
 * - the RSC extractor is not ported (decision 3).
 *
 * Pure orchestration, no pi-host imports — unit-testable standalone per the
 * repo rule. Both network touchpoints (fetchImpl, jinaFn) are injectable
 * for tests that run without network.
 */
import {
	combineSignals,
	isAbort,
	readBodyCapped,
	withRetry,
	type BodyResult,
} from "../http.ts";
import {
	extractWithJinaReader,
	type JinaResult,
} from "./jina.ts";
import {
	extractArticle,
	extractHeadingTitle,
	isLikelyJSRendered,
} from "./markdown.ts";
import { extractPdf, isPdfUrl } from "./pdf.ts";
import { assertPublicHttpUrl } from "./ssrf.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 1_500;
/**
 * Fetch budget per attempt: the original request plus redirect hops. A
 * redirect landing on the last budgeted fetch fails with a "redirect"
 * error instead of issuing a further request — redirect loops cannot
 * spin. At most MAX_REDIRECT_HOPS - 1 redirects are actually followed.
 */
const MAX_REDIRECT_HOPS = 5;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;

const FETCH_HEADERS: Record<string, string> = {
	"User-Agent": USER_AGENT,
	"Accept":
		"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "no-cache",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
};

/** Hint appended when even the Jina fallback couldn't get the content. */
const FALLBACK_HINT =
	"The page may be JavaScript-rendered. Try:\n" +
	"  • A different URL for the same content\n" +
	"  • web_search to find cached/alternative versions";

/**
 * Coarse failure class of an error outcome. "redirect" covers the manual
 * redirect-following phase: a hop target blocked by the SSRF guard, an
 * unparseable Location, or the hop budget exhausted (see
 * fetchFollowRedirects).
 */
export type FetchErrorKind =
	| "ssrf"
	| "http"
	| "redirect"
	| "too-large"
	| "unsupported"
	| "empty";

/**
 * Result of fetchAndExtract. Errors are values, not exceptions: `status`
 * discriminates, `errorKind` gives the coarse class and `errorMessage` the
 * human-readable detail (the tool layer surfaces it verbatim). `warning`
 * marks an ok result whose content may be unreliable (e.g. a thin article).
 */
export interface FetchOutcome {
	status: "ok" | "error";
	/** URL as requested by the caller. */
	url: string;
	/**
	 * URL of the last hop actually fetched (redirects are followed
	 * manually), falling back to the requested URL.
	 */
	finalUrl: string;
	/** Extracted title; null when none could be determined or on error. */
	title: string | null;
	content: string;
	/** Present on status "ok" when the content may be incomplete. */
	warning?: string;
	/** Present on status "error": coarse failure class. */
	errorKind?: FetchErrorKind;
	/** Present on status "error": human-readable failure message. */
	errorMessage?: string;
}

/** Network touchpoints, injectable for tests (defaults are the real ones). */
export interface FetcherDeps {
	/** Fetch used for the page itself (default: globalThis.fetch). */
	fetchImpl?: typeof fetch;
	/** Jina Reader fallback (default: extractWithJinaReader). */
	jinaFn?: (
		url: string,
		signal: AbortSignal | undefined,
	) => Promise<JinaResult | null>;
	/** Backoff between retry attempts; default 1.5 s (short in tests). */
	retryBackoffMs?: number;
}

/**
 * Fetch `url` and extract readable content (markdown for HTML/PDF, text
 * otherwise). Never throws — every failure mode resolves to an error
 * FetchOutcome. See the module docblock for the routing and fallback rules.
 */
export async function fetchAndExtract(
	url: string,
	signal: AbortSignal | undefined,
	deps: FetcherDeps = {},
): Promise<FetchOutcome> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const jinaFn =
		deps.jinaFn ??
		((jinaUrl: string, jinaSignal: AbortSignal | undefined) =>
			extractWithJinaReader(jinaUrl, jinaSignal));
	const backoffMs = deps.retryBackoffMs ?? RETRY_BACKOFF_MS;

	// Guard before any network activity — including the Jina fallback.
	let guarded: URL;
	try {
		guarded = assertPublicHttpUrl(url);
	} catch (error) {
		return errorOutcome(url, "ssrf", errorMessage(error));
	}

	let response: Response;
	let finalUrl: string;
	try {
		({ response, finalUrl } = await withRetry(
			() => fetchFollowRedirects(guarded.href, signal, fetchImpl),
			{
				retries: 1,
				backoffMs,
				isTransient: isTransientError,
				signal,
			},
		));
	} catch (error) {
		// Exhausted retries (429/5xx/network), a non-transient 4xx, an
		// abort, or a redirect-phase failure (blocked/unparseable hop,
		// hop budget exhausted). Transport-level failures never reach
		// Jina (decision 5).
		return errorOutcome(
			url,
			isRedirectError(error) ? "redirect" : "http",
			errorMessage(error),
		);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const pdf = isPdfUrl(url, contentType || undefined);

	// Header-level rejection before a single body byte is read: a 10MB zip
	// reports "unsupported", not "too-large", and is never streamed.
	const unsupported = unsupportedContentType(contentType);
	if (unsupported) {
		// The body is deliberately ignored — release the socket now.
		void response.body?.cancel().catch(() => {});
		return errorOutcome(
			url,
			"unsupported",
			`Unsupported content type: ${unsupported}`,
			finalUrl,
		);
	}

	let body: BodyResult;
	try {
		// Cap chosen before a single byte is read (P0b): the stream is cut
		// on the bytes actually seen, content-length is never consulted.
		body = await readBodyCapped(
			response,
			pdf ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE,
		);
	} catch (error) {
		return errorOutcome(url, "http", errorMessage(error), finalUrl);
	}
	if (!body.ok) {
		const capMb = Math.round(
			(pdf ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE) / 1024 / 1024,
		);
		return errorOutcome(
			url,
			"too-large",
			`Response too large (received ${Math.round(body.received / 1024 / 1024)}MB, cap ${capMb}MB)`,
			finalUrl,
		);
	}

	try {
		return await routeAndExtract({
			url,
			finalUrl,
			contentType,
			pdf,
			buffer: body.buffer,
			signal,
			jinaFn,
		});
	} catch (error) {
		// Extraction-level failure (corrupt/encrypted PDF, unexpected parse
		// blowup) — an honest "no content" rather than a tool crash.
		return errorOutcome(url, "empty", errorMessage(error), finalUrl);
	}
}

/** Content-type routing and extraction, shared by every non-error path. */
async function routeAndExtract(input: {
	url: string;
	finalUrl: string;
	contentType: string;
	pdf: boolean;
	buffer: Uint8Array;
	signal: AbortSignal | undefined;
	jinaFn: (
		url: string,
		signal: AbortSignal | undefined,
	) => Promise<JinaResult | null>;
}): Promise<FetchOutcome> {
	const { url, finalUrl, contentType, pdf, buffer, signal, jinaFn } = input;

	if (pdf) {
		const { title, markdown } = await extractPdf(buffer, finalUrl);
		return { status: "ok", url, finalUrl, title, content: markdown };
	}

	const text = new TextDecoder().decode(buffer);
	const isHtml =
		contentType.includes("text/html") ||
		contentType.includes("application/xhtml+xml");
	if (!isHtml) {
		// Plain text (or anything textual): pass through as-is, title from
		// the first markdown-style heading if there is one, else the URL
		// basename (port of the source's fallback).
		return {
			status: "ok",
			url,
			finalUrl,
			title: extractHeadingTitle(text) ?? titleFromUrl(finalUrl),
			content: text,
		};
	}

	const article = await extractArticle(text, finalUrl);
	const jsRendered = isLikelyJSRendered(text);
	if (
		!article ||
		(article.markdown.length < MIN_USEFUL_CONTENT && jsRendered)
	) {
		// Empty extraction or a JS-rendered shell — the only paths that
		// consult Jina (decision 5).
		const jina = await jinaFn(finalUrl, signal);
		if (jina) {
			return {
				status: "ok",
				url,
				finalUrl,
				// Jina's heading is often missing — fall back to the URL
				// basename (port of the source's fallback).
				title: jina.title ?? titleFromUrl(finalUrl),
				content: jina.markdown,
			};
		}
		return errorOutcome(
			url,
			"empty",
			emptyExtractionMessage(jsRendered),
			finalUrl,
		);
	}
	if (article.markdown.length < MIN_USEFUL_CONTENT) {
		// A real but thin article: succeed with a warning instead of
		// throwing the content away (decision 5; the source lost it).
		return {
			status: "ok",
			url,
			finalUrl,
			title: article.title || null,
			content: article.markdown,
			warning: "Extracted content appears incomplete",
		};
	}
	return {
		status: "ok",
		url,
		finalUrl,
		title: article.title || null,
		content: article.markdown,
	};
}

/**
 * One fetch attempt with manually followed redirects: each hop's target is
 * resolved and re-checked by the SSRF guard before it is fetched — the
 * native `redirect: "follow"` never consults our guard, which let a public
 * URL bounce fetches into the private network (redirect-rebinding).
 *
 * The caller has already guarded the original URL. Budget: at most
 * MAX_REDIRECT_HOPS fetches per attempt; a redirect landing on the last
 * budgeted fetch fails instead of issuing a further request. Failures of
 * the redirect phase (blocked/unparseable hop target, budget exhausted,
 * 3xx without a usable Location) are tagged `redirect` — surfaced as
 * errorKind "redirect" and never retried. Network errors are tagged
 * transient; non-ok statuses per their class (withRetry never retries
 * aborts, whatever the tag says). The fetched body of discarded responses
 * (redirects, non-ok) is cancelled so the socket is not held until GC.
 */
async function fetchFollowRedirects(
	url: string,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
): Promise<{ response: Response; finalUrl: string }> {
	let currentUrl = url;
	for (let hop = 0; ; hop++) {
		let response: Response;
		try {
			response = await fetchImpl(currentUrl, {
				headers: FETCH_HEADERS,
				// Follow redirects by hand so every hop passes the guard.
				redirect: "manual",
				signal: combineSignals(signal, FETCH_TIMEOUT_MS),
			});
		} catch (error) {
			if (isAbort(error)) throw error;
			throw Object.assign(
				new Error(`${errorMessage(error)} (network error)`),
				{ transient: true },
			);
		}

		const location = isRedirectStatus(response.status)
			? response.headers.get("location")
			: null;
		if (location) {
			if (hop >= MAX_REDIRECT_HOPS - 1) {
				throw redirectError(
					`Too many redirects (limit ${MAX_REDIRECT_HOPS - 1})`,
				);
			}
			let nextUrl: URL;
			try {
				nextUrl = new URL(location, currentUrl);
			} catch {
				throw redirectError(
					`Redirect to an invalid URL: ${location}`,
				);
			}
			try {
				nextUrl = assertPublicHttpUrl(nextUrl.href);
			} catch (error) {
				throw redirectError(
					`Redirect blocked by the SSRF guard: ${errorMessage(error)}`,
				);
			}
			// The 3xx body is never read — release the socket now.
			void response.body?.cancel().catch(() => {});
			currentUrl = nextUrl.href;
			continue;
		}

		if (!response.ok) {
			// Release the socket instead of holding it until GC (withRetry
			// may or may not come back to this response).
			void response.body?.cancel().catch(() => {});
			throw Object.assign(
				new Error(`HTTP ${response.status}: ${response.statusText}`),
				{ transient: response.status === 429 || response.status >= 500 },
			);
		}
		return { response, finalUrl: currentUrl };
	}
}

/** Statuses with redirect semantics (300–399; a Location decides). */
function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

/** Redirect-phase failure: non-transient (never retried), errorKind "redirect". */
function redirectError(message: string): Error {
	return Object.assign(new Error(message), { redirect: true });
}

function isRedirectError(error: unknown): boolean {
	return (error as { redirect?: boolean } | null)?.redirect === true;
}

function isTransientError(error: unknown): boolean {
	return (error as { transient?: boolean } | null)?.transient === true;
}

/**
 * Binary content the tool can't render — always fatal, never a Jina case
 * (port of the source's content-type check).
 */
function unsupportedContentType(contentType: string): string | null {
	if (contentType.includes("application/octet-stream")) {
		return "application/octet-stream";
	}
	if (contentType.includes("application/zip")) return "application/zip";
	if (contentType.includes("image/")) return contentType.split(";")[0];
	if (contentType.includes("audio/")) return contentType.split(";")[0];
	if (contentType.includes("video/")) return contentType.split(";")[0];
	return null;
}

/** Honest message for the LLM when extraction and Jina both came up empty. */
function emptyExtractionMessage(jsRendered: boolean): string {
	const reason = jsRendered
		? "Page appears to be JavaScript-rendered (content loads dynamically)"
		: "Could not extract readable content from HTML structure";
	return `${reason}; the Jina Reader fallback also came up empty.\n\n${FALLBACK_HINT}`;
}

/**
 * Last-resort title: the basename of the URL path (port of the source's
 * fallback). "https://a.com/x/post.html" → "post.html"; a path with no
 * basename (bare origin "/", directory URLs ending in "/") → null.
 */
function titleFromUrl(url: string): string | null {
	try {
		const basename = new URL(url).pathname.split("/").pop();
		if (!basename) return null;
		try {
			return decodeURIComponent(basename);
		} catch {
			// Malformed percent-encoding — the raw segment still beats null.
			return basename;
		}
	} catch {
		return null;
	}
}

function errorOutcome(
	url: string,
	errorKind: FetchErrorKind,
	message: string,
	finalUrl = url,
): FetchOutcome {
	return {
		status: "error",
		url,
		finalUrl,
		title: null,
		content: "",
		errorKind,
		errorMessage: message,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
