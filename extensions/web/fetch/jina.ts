/**
 * Jina Reader fallback for web_fetch.
 *
 * Port of the third-party web-fetch extension's extractWithJinaReader: when
 * direct extraction yields nothing (empty article or a JS-rendered page), the
 * caller asks https://r.jina.ai/<url> to render the page server-side and
 * return markdown. Strictly best-effort — every failure mode (network error,
 * non-2xx, missing marker, bot-marker payload) resolves to null, never
 * throws; the caller decides how to surface a missed fallback.
 */
import { combineSignals } from "../http.ts";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;

const MARKDOWN_MARKER = "Markdown Content:";
const BOT_MARKERS = ["Loading...", "Please enable JavaScript"];

/** Successful Jina extraction: heading title (or null) and the markdown body. */
export interface JinaResult {
	title: string | null;
	markdown: string;
}

// TODO(task-8): dedupe with markdown.ts extractHeadingTitle — markdown.ts is
// being written by a parallel worker, so the helper lives here for now.
function extractHeadingTitle(markdown: string): string | null {
	const match = markdown.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

/**
 * Fetch `url` through the Jina Reader service and return its markdown.
 *
 * Resolves null when the service is unreachable, answers non-2xx, the payload
 * has no "Markdown Content:" section, or the payload is a bot/placeholder
 * page ("Loading...", "Please enable JavaScript"). The caller signal is
 * combined with a 30 s timeout; either firing resolves null. `fetchImpl` is
 * injectable for tests.
 */
export async function extractWithJinaReader(
	url: string,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<JinaResult | null> {
	try {
		const response = await fetchImpl(JINA_READER_BASE + url, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: combineSignals(signal, JINA_TIMEOUT_MS),
		});
		if (!response.ok) return null;

		const content = await response.text();
		const contentStart = content.indexOf(MARKDOWN_MARKER);
		if (contentStart < 0) return null;

		const markdown = content
			.slice(contentStart + MARKDOWN_MARKER.length)
			.trim();
		if (BOT_MARKERS.some((marker) => markdown.startsWith(marker))) {
			return null;
		}

		return { title: extractHeadingTitle(markdown), markdown };
	} catch {
		return null;
	}
}
