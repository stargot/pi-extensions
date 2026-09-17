/**
 * HTML → markdown extraction for web_fetch.
 *
 * Readability (over a linkedom document) picks the article, turndown
 * converts it to markdown. All three heavy dependencies (linkedom,
 * @mozilla/readability, turndown) load lazily via `await import()` inside
 * extractArticle — importing this module, and therefore starting pi, never
 * pays their cost (web-merge decision 2). The turndown converter instance
 * is built once on first use and cached at module level; the URL-resolution
 * rule is a single shared instance too — turndown's addRule does not
 * replace an existing key (it unshifts onto the rule list), so re-registering
 * per call would pile up copies. The shared rule reads its baseUrl from a
 * holder refreshed in the synchronous tail of extractArticle (see there).
 *
 * Ported from the third-party web-fetch extension, minus the RSC extractor
 * (decision 3) and with link/img URLs resolved against the page's final
 * URL (decision 5).
 */

/** Readability-extracted article, converted to markdown. */
export interface ExtractedArticle {
	title: string;
	markdown: string;
}

/**
 * Articles with less text than this count as "no article" (the caller
 * falls back). Readability's own default, passed explicitly so the
 * contract doesn't drift with library defaults.
 */
const CHAR_THRESHOLD = 500;

type TurndownRule = import("turndown").Rule;

/**
 * Structural slice of the turndown converter this module uses. The
 * concrete constructor arrives via the lazy `await import("turndown")`;
 * its `export =` type shape doesn't round-trip through dynamic-import
 * type positions, so the cached instance is typed structurally.
 */
interface TurndownConverter {
	addRule(key: string, rule: TurndownRule): unknown;
	turndown(html: string): string;
}

/** Built on first use (lazy `await import("turndown")`), cached forever. */
let turndownInstance: TurndownConverter | null = null;

/**
 * Base URL the shared resolve-relative-urls rule currently resolves
 * against. Written only in the synchronous tail of extractArticle — no
 * await between the write and turndown() — so even interleaved concurrent
 * extractions always convert with their own page's base URL (a synchronous
 * block is atomic in JS).
 */
const ruleContext = { baseUrl: "" };

/** Shared resolve-relative-urls rule, built once on first use (see build). */
let resolveRelativeUrlsRule: TurndownRule | null = null;

/**
 * Build the shared URL-resolution rule. It must read the base URL through
 * the ruleContext holder rather than a captured copy: the rule object is
 * registered with turndown exactly once and serves every later call.
 */
function buildResolveRelativeUrlsRule(): TurndownRule {
	return {
		filter: (node) =>
			(node.nodeName === "A" && !!node.getAttribute("href")) ||
			(node.nodeName === "IMG" && !!node.getAttribute("src")),
		replacement: (content, node) => {
			const baseUrl = ruleContext.baseUrl;
			if (node.nodeName === "A") {
				const href = resolveAttr(node.getAttribute("href"), baseUrl);
				if (!href) return content;
				const title = cleanAttribute(node.getAttribute("title"));
				return title
					? `[${content}](${href} "${title}")`
					: `[${content}](${href})`;
			}
			const src = resolveAttr(node.getAttribute("src"), baseUrl);
			if (!src) return "";
			const alt = cleanAttribute(node.getAttribute("alt"));
			const title = cleanAttribute(node.getAttribute("title"));
			return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
		},
	};
}

async function getTurndown(): Promise<TurndownConverter> {
	if (!turndownInstance) {
		const { default: TurndownService } = await import("turndown");
		turndownInstance = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
		});
	}
	return turndownInstance;
}

/**
 * Extract the readable article from HTML as markdown.
 *
 * Returns null when Readability finds no article (the caller decides on
 * fallbacks). Relative link and image URLs in the article are resolved
 * against baseUrl — the response's final URL after redirects.
 */
export async function extractArticle(
	html: string,
	baseUrl: string,
): Promise<ExtractedArticle | null> {
	const { parseHTML } = await import("linkedom");
	const { Readability } = await import("@mozilla/readability");

	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document, {
		charThreshold: CHAR_THRESHOLD,
	});
	const article = reader.parse();
	if (!article) return null;

	// The shared rule is registered exactly once — turndown's addRule does
	// NOT replace an existing key, it unshifts onto the rule list, so
	// re-adding per call would accumulate copies and slow every lookup.
	// Rebinding the base URL happens in the synchronous tail below: there
	// is no await between ruleContext.baseUrl = ... and turndown(), so
	// concurrent extractions can interleave around the awaits above, yet
	// each conversion still runs with its own page's base URL (each sync
	// block is atomic in JS). The rule unshifts ahead of turndown's default
	// link/image rules, so ours wins.
	const turndown = await getTurndown();
	if (!resolveRelativeUrlsRule) {
		resolveRelativeUrlsRule = buildResolveRelativeUrlsRule();
		turndown.addRule("resolve-relative-urls", resolveRelativeUrlsRule);
	}
	ruleContext.baseUrl = baseUrl;

	return {
		title: article.title ?? "",
		markdown: turndown.turndown(article.content ?? ""),
	};
}

/**
 * Resolve a link/img attribute against the page's final URL. Unresolvable
 * values pass through unchanged (decision 5: degrade to the original
 * attribute, never throw mid-conversion).
 */
function resolveAttr(value: string | null, baseUrl: string): string | null {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).href;
	} catch {
		return value;
	}
}

function cleanAttribute(value: string | null): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Heuristic for "this page needs JavaScript to render": a <body> with
 * almost no visible text (< 500 chars) alongside many <script> tags.
 * Drives the fetcher's Jina fallback (decision 5). Pages without a <body>
 * are not considered JS-rendered (matches the ported source).
 */
export function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const textContent = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return textContent.length < 500 && scriptCount > 3;
}

/**
 * First markdown heading (`#`/`##`) as a fallback title — plain text
 * responses and Jina markdown start with `# Title` before `Source:`/`---`.
 * Bold markers are stripped; null when no matching heading exists.
 */
export function extractHeadingTitle(markdown: string): string | null {
	const match = markdown.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}
