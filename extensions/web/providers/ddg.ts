import { combineSignals, withRetry } from "../http.ts";
import { looksLikeBotChallenge, parseDdgResults } from "../parse.ts";
import { DEFAULT_RESULT_COUNT, type BuiltSearchQuery, type SearchResult } from "../query.ts";
import type { SearchProvider, SearchProviderOptions } from "./provider.ts";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20_000;
const RETRYABLE_STATUS = new Set([202, 403, 429]);
const RETRY_BACKOFF_MS = 1500;

function searchHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		"User-Agent": USER_AGENT,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		Origin: "https://html.duckduckgo.com",
		Referer: "https://html.duckduckgo.com/",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "same-origin",
		"Upgrade-Insecure-Requests": "1",
	};
}

async function fetchResultsPage(query: string, signal: AbortSignal | undefined): Promise<string> {
	const resp = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: searchHeaders(),
		body: new URLSearchParams({ q: query }).toString(),
		signal: combineSignals(signal, REQUEST_TIMEOUT_MS),
	});

	if (!resp.ok) {
		throw Object.assign(
			new Error(`DuckDuckGo HTTP ${resp.status}${resp.status === 403 || resp.status === 202 ? " (bot-check)" : ""}`),
			{ transient: RETRYABLE_STATUS.has(resp.status) },
		);
	}

	const html = await resp.text();
	if (looksLikeBotChallenge(html)) {
		throw Object.assign(new Error("DuckDuckGo returned a bot-challenge page instead of results."), { transient: true });
	}
	return html;
}

export const ddgProvider: SearchProvider = {
	async search(args: BuiltSearchQuery, opts?: SearchProviderOptions): Promise<SearchResult[]> {
		const html = await withRetry(() => fetchResultsPage(args.query, opts?.signal), {
			retries: 1,
			backoffMs: RETRY_BACKOFF_MS,
			isTransient: (error) => (error as { transient?: boolean })?.transient === true,
			signal: opts?.signal,
		});
		return parseDdgResults(html).slice(0, opts?.count ?? DEFAULT_RESULT_COUNT);
	},
};
