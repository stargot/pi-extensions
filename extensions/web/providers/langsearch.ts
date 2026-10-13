import { combineSignals, isAbort, withRetry } from "../http.ts";
import { normalizeSite, quoteForSearch, type BuiltSearchQuery, type SearchResult } from "../query.ts";
import type { SearchProvider, SearchProviderOptions } from "./provider.ts";

export const LANGSEARCH_URL = "https://api.langsearch.com/v1/web-search";

const LANGSEARCH_TIMEOUT_MS = 20_000;
const LANGSEARCH_BACKOFF_MS = 1_000;

const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function isDomainLike(value: string): boolean {
	return DOMAIN_LIKE.test(value);
}

export interface LangSearchRequest {
	query: string;
	count: number;
	includeDomains?: string[];
	excludeDomains?: string[];
}

export function toLangSearchParams(built: BuiltSearchQuery, count: number): LangSearchRequest {
	const parts: string[] = [];
	if (built.baseQuery) parts.push(built.baseQuery);
	for (const phrase of built.exactPhrases) {
		parts.push(quoteForSearch(phrase));
	}

	const excludeDomains: string[] = [];
	const textExcludes: string[] = [];
	for (const term of built.excludeTerms) {
		const host = normalizeSite(term);
		if (host !== undefined && isDomainLike(host)) {
			excludeDomains.push(host);
		} else {
			textExcludes.push(term);
		}
	}
	for (const term of textExcludes) {
		parts.push(`-${term.includes(" ") ? quoteForSearch(term) : term}`);
	}

	const numeric = typeof count === "number" && Number.isFinite(count) ? Math.round(count) : 5;
	const clamped = Math.max(1, Math.min(10, numeric));

	return {
		query: parts.join(" "),
		count: clamped,
		includeDomains: built.site ? [built.site] : undefined,
		excludeDomains: excludeDomains.length > 0 ? excludeDomains : undefined,
	};
}

export function parseLangSearchResponse(payload: unknown): SearchResult[] {
	const pages = (payload as { data?: { webPages?: { value?: unknown } } })?.data?.webPages?.value;
	if (!Array.isArray(pages)) throw new Error("LangSearch returned unexpected response shape");
	const results: SearchResult[] = [];
	for (const item of pages) {
		const entry = item as { name?: unknown; url?: unknown; snippet?: unknown };
		results.push({
			title: typeof entry.name === "string" ? entry.name : "",
			url: typeof entry.url === "string" ? entry.url : "",
			snippet: typeof entry.snippet === "string" ? entry.snippet : "",
		});
	}
	return results;
}

function transientError(message: string): Error {
	return Object.assign(new Error(message), { transient: true });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createLangSearchProvider(options: { apiKey: string; backoffMs?: number }): SearchProvider {
	const backoffMs = options.backoffMs ?? LANGSEARCH_BACKOFF_MS;
	return {
		async search(args: BuiltSearchQuery, opts?: SearchProviderOptions): Promise<SearchResult[]> {
			const payload = toLangSearchParams(args, opts?.count ?? 5);
			const body = JSON.stringify(payload);
			return withRetry(
				async () => {
					let response: Response;
					try {
						response = await fetch(LANGSEARCH_URL, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${options.apiKey}`,
							},
							body,
							signal: combineSignals(opts?.signal, LANGSEARCH_TIMEOUT_MS),
						});
					} catch (error) {
						if (isAbort(error)) throw error;
						throw transientError(`LangSearch request failed: ${errorText(error)}`);
					}

					if (!response.ok) {
						const status = response.status;
						if (status === 401 || status === 403 || status === 429 || status >= 500) {
							throw transientError(`LangSearch HTTP ${status}`);
						}
						throw new Error(`LangSearch HTTP ${status}`);
					}

					let parsed: unknown;
					try {
						parsed = await response.json();
					} catch (error) {
						throw new Error(`LangSearch returned invalid JSON: ${errorText(error)}`);
					}
					return parseLangSearchResponse(parsed);
				},
				{
					retries: 1,
					backoffMs,
					isTransient: (error) => (error as { transient?: boolean })?.transient === true,
					signal: opts?.signal,
				},
			);
		},
	};
}

export const langSearchProvider: SearchProvider = {
	search(args: BuiltSearchQuery, opts?: SearchProviderOptions): Promise<SearchResult[]> {
		const apiKey = process.env.LANGSEARCH_API_KEY?.trim();
		if (!apiKey) {
			return Promise.reject(new Error("LANGSEARCH_API_KEY is not set."));
		}
		return createLangSearchProvider({ apiKey }).search(args, opts);
	},
};
