/**
 * web_fetch — fetch a URL and extract readable content as markdown.
 *
 * Registration layer over fetchAndExtract (./fetcher.ts): typebox schema,
 * LLM-facing error surfacing, and TUI rendering. Port of the third-party
 * web-fetch extension's registration block. Errors are thrown so the LLM
 * sees the failure as tool-error text; a ⚠ marker is appended to the
 * result status when extraction succeeded but the content may be
 * incomplete (FetchOutcome.warning).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fetchAndExtract } from "./fetcher.ts";

export function registerWebFetch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract readable content as clean markdown. Uses Readability + Turndown for high-quality HTML→markdown conversion. Handles PDFs, plain text, and falls back to Jina Reader for JS-rendered pages.",
		promptSnippet:
			"Fetch a URL and extract readable content as markdown. Supports HTML pages, PDFs, and plain text.",

		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
		}),

		async execute(_toolCallId, params: { url: string }, signal) {
			const outcome = await fetchAndExtract(params.url, signal);

			if (outcome.status === "error") {
				throw new Error(`${outcome.url}: ${outcome.errorMessage}`);
			}

			const header = outcome.title
				? `# ${outcome.title}\n\nSource: ${outcome.finalUrl}\n\n---\n\n`
				: "";
			return {
				content: [
					{
						type: "text" as const,
						text: header + outcome.content,
					},
				],
				details: {
					url: outcome.url,
					finalUrl: outcome.finalUrl,
					title: outcome.title,
					chars: outcome.content.length,
					...(outcome.warning ? { warning: outcome.warning } : {}),
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			// Streaming delivers partial args: url may not have arrived yet.
			const { url } = args as { url?: string };
			if (!url) {
				text.setText(
					theme.fg("toolTitle", theme.bold("fetch ")) +
						theme.fg("error", "(no URL)"),
				);
				return text;
			}
			const display =
				url.length > 70 ? url.slice(0, 67) + "..." : url;
			text.setText(
				theme.fg("toolTitle", theme.bold("fetch ")) +
					theme.fg("accent", display),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Fetching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				title?: string;
				chars?: number;
				warning?: string;
			};

			const title = details?.title || "Untitled";
			const chars = details?.chars ?? 0;
			const status =
				theme.fg("success", title) +
				theme.fg("muted", ` (${chars} chars)`) +
				(details?.warning
					? " " + theme.fg("warning", `⚠ ${details.warning}`)
					: "");

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500
					? content.slice(0, 500) + "..."
					: content;
			text.setText(status + "\n" + theme.fg("dim", preview));
			return text;
		},
	});
}
