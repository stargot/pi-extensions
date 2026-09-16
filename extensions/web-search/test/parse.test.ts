import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeBotChallenge, parseDdgResults } from "../parse.ts";

// Synthetic HTML in the shape of the html.duckduckgo.com/html/ endpoint:
// div.result blocks with a.result__a (title + redirect href) and a.result__snippet.
const FIXTURE = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpi&amp;rut=abc">
        Pi coding agent
      </a>
    </h2>
    <a class="result__snippet" href="#">A  coding   agent   with   tools.</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://direct.example.com/page">
        Direct link result
      </a>
    </h2>
    <a class="result__snippet" href="#">Snippet two.</a>
  </div>
  <div class="result">
    <a class="result__a" href="/local/relative">No scheme — filtered out</a>
  </div>
  <div class="result">
    <div>no anchor at all</div>
  </div>
</div>
`;

test("parseDdgResults: unwraps redirects, collapses whitespace, filters junk", () => {
	const results = parseDdgResults(FIXTURE);
	assert.equal(results.length, 2);

	assert.equal(results[0]?.title, "Pi coding agent");
	assert.equal(results[0]?.url, "https://example.com/pi");
	assert.equal(results[0]?.snippet, "A coding agent with tools.");

	assert.equal(results[1]?.url, "https://direct.example.com/page");
	assert.equal(results[1]?.snippet, "Snippet two.");
});

test("parseDdgResults: empty page yields no results", () => {
	assert.deepEqual(parseDdgResults("<html><body>nothing here</body></html>"), []);
});

// Real snapshot of html.duckduckgo.com/html/?q=pi+coding+agent (2026-09-16).
// Regression net for the linkedom -> html.ts switch: the old parser's output
// on this exact page is pinned in the assertions below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL_PAGE = readFileSync(
	fileURLToPath(new URL("./fixtures/ddg-sample.html", import.meta.url)),
	"utf8",
);

test("parseDdgResults: real DDG snapshot — 10 results, entities and <b> handled", () => {
	const results = parseDdgResults(REAL_PAGE);
	assert.equal(results.length, 10);

	assert.deepEqual(
		{ ...results[0], snippet: undefined },
		{ title: "Pi Documentation · Documentation · Pi", url: "https://pi.dev/docs/latest", snippet: undefined },
	);
	assert.match(results[0]!.snippet, /^A terminal-based coding agent/);

	// entity decoding on a real entry (title contains "&amp;" in the raw HTML)
	const piagent = results.find((r) => r.url === "https://piagent.fyi/");
	assert.ok(piagent);
	assert.equal(piagent.title, "Piagent — The resource map & news hub for the Pi coding agent");

	for (const r of results) {
		assert.match(r.url, /^https?:\/\//);
		assert.ok(r.title.length > 0);
	}
});

test("looksLikeBotChallenge: detects challenge pages, not normal pages", () => {
	assert.equal(looksLikeBotChallenge("If this anomaly persists, solve the captcha"), true);
	assert.equal(looksLikeBotChallenge(FIXTURE), false);
});
