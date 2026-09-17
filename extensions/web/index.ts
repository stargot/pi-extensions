/**
 * Entry point of the pi-web package: registers both web tools.
 *
 * web_search — DuckDuckGo HTML-endpoint search (./search.ts);
 * web_fetch — page fetching to markdown with PDF extraction and the
 * Jina Reader fallback (./fetch/tool.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebFetch } from "./fetch/tool.ts";
import registerWebSearch from "./search.ts";

export default function (pi: ExtensionAPI) {
	registerWebSearch(pi);
	registerWebFetch(pi);
}
