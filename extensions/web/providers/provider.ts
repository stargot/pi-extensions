import type { BuiltSearchQuery, SearchResult } from "../query.ts";

export interface SearchProviderOptions {
	signal?: AbortSignal;
	count?: number;
}

export interface SearchProvider {
	search(args: BuiltSearchQuery, opts?: SearchProviderOptions): Promise<SearchResult[]>;
}
