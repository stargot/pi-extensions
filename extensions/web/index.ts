/**
 * Entry point of the pi-web package.
 *
 * TODO(task-9): thin entry for both tools — registerWebSearch(pi) from
 * ./search.ts + registerWebFetch(pi) from ./fetch/tool.ts. Until web_fetch
 * lands, this re-exports the search tool so the manifest path
 * ./extensions/web/index.ts keeps working.
 */
export { default } from "./search.ts";
