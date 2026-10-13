import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isAbort } from "./http.ts";
import { ddgProvider } from "./providers/ddg.ts";
import { langSearchProvider } from "./providers/langsearch.ts";
import { decideProvider, type ProviderName } from "./providers/select.ts";
import { buildSearchQuery, clampCount, formatResults, type SearchResult, type StructuredSearchArgs } from "./query.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. DuckDuckGo is the default provider; set PI_WEB_SEARCH_PROVIDER=langsearch plus LANGSEARCH_API_KEY to use LangSearch instead. Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Returns title, URL, and snippet.",
		promptSnippet:
			"Search the web via a query string plus optional exactPhrases, excludeTerms, and site. Use one tool call per search angle.",
		promptGuidelines: [
			"Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
			"Use one web_search tool call per search angle instead of batching multiple searches into one call.",
		],

		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Base search query as a normal string. Prefer this for the main search wording.",
				}),
			),
			exactPhrases: Type.Optional(
				Type.Array(Type.String(), {
					description: "Exact phrases to match. Each item becomes a quoted phrase in the final query.",
				}),
			),
			excludeTerms: Type.Optional(
				Type.Array(Type.String(), {
					description: "Terms or phrases to exclude. Multi-word items are excluded as exact phrases.",
				}),
			),
			site: Type.Optional(
				Type.String({
					description: "Optional site/domain restriction, such as example.com or a full URL.",
				}),
			),
			count: Type.Optional(
				Type.Number({
					description: "Number of results to return (default: 5, max: 10)",
					minimum: 1,
					maximum: 10,
				}),
			),
		}),

		async execute(_toolCallId, params: StructuredSearchArgs, signal) {
			const count = clampCount(params.count);
			const built = buildSearchQuery(params);
			const startedAt = Date.now();

			const decision = decideProvider(process.env);
			let providerUsed: ProviderName = decision.name;
			const fallbackReasons: string[] = [];
			if (decision.fallbackReason) fallbackReasons.push(decision.fallbackReason);

			let results: SearchResult[];
			if (providerUsed === "langsearch") {
				try {
					results = await langSearchProvider.search(built, { signal, count });
				} catch (error) {
					if (isAbort(error) || (error as { transient?: boolean })?.transient !== true) {
						throw error;
					}
					providerUsed = "ddg";
					const message = error instanceof Error ? error.message : String(error);
					fallbackReasons.push(`langsearch failed: ${message}; fell back to DuckDuckGo`);
					results = await ddgProvider.search(built, { signal, count });
				}
			} else {
				results = await ddgProvider.search(built, { signal, count });
			}

			return {
				content: [
					{
						type: "text" as const,
						text: formatResults(results),
					},
				],
				details: {
					composedQuery: built.query,
					query: built.baseQuery,
					exactPhrases: built.exactPhrases,
					excludeTerms: built.excludeTerms,
					site: built.site,
					resultCount: results.length,
					durationMs: Date.now() - startedAt,
					providerUsed,
					...(fallbackReasons.length > 0 ? { fallbackReason: fallbackReasons.join("; ") } : {}),
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const { count, ...searchArgs } = args as StructuredSearchArgs;

			try {
				const built = buildSearchQuery(searchArgs);
				const display = built.query.length > 70 ? built.query.slice(0, 67) + "..." : built.query;
				const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`)];
				if (count && count !== 5) {
					lines.push(theme.fg("dim", `  count: ${count}`));
				}
				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(invalid query)"));
				return text;
			}
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg = result.content.find((c) => c.type === "text")?.text || "Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				composedQuery?: string;
				resultCount?: number;
				durationMs?: number;
			};
			const elapsed = details?.durationMs != null ? ` in ${(details.durationMs / 1000).toFixed(1)}s` : "";
			const status = theme.fg("success", `${details?.resultCount ?? 0} results${elapsed}`);
			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content = result.content.find((c) => c.type === "text")?.text || "";
			const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
			const queryLine = details?.composedQuery ? theme.fg("dim", `query: ${details.composedQuery}`) : "";
			text.setText([status, queryLine, theme.fg("dim", preview)].filter(Boolean).join("\n"));
			return text;
		},
	});
}
