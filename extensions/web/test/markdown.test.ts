import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractArticle,
	extractHeadingTitle,
	isLikelyJSRendered,
} from "../fetch/markdown.ts";

// ~210 chars of visible text per paragraph; three of them clear
// Readability's charThreshold (500) so the fixture parses as an article.
const paragraph = (marker: string): string =>
	`<p>${marker}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>`;

function articleHtml(extra = ""): string {
	return [
		"<!DOCTYPE html>",
		"<html><head><title>My Article</title></head>",
		"<body>",
		"<article>",
		// h1 == article title is stripped by Readability from the content, so
		// heading conversion is asserted on the h2 below.
		"<h1>My Article</h1>",
		"<h2>Overview</h2>",
		paragraph("First"),
		paragraph("Second"),
		paragraph("Third"),
		extra,
		"</article>",
		"</body></html>",
	].join("");
}

test("extractArticle: simple article → title + markdown with atx headings", async () => {
	const result = await extractArticle(
		articleHtml(),
		"https://docs.example.com/post/1",
	);
	assert.ok(result);
	assert.equal(result.title, "My Article");
	assert.match(result.markdown, /^## Overview$/m);
	assert.match(result.markdown, /Lorem ipsum dolor sit amet/);
});

test("extractArticle: relative <a href> resolves against baseUrl", async () => {
	const result = await extractArticle(
		articleHtml('<p>See <a href="/x">this link</a> for details.</p>'),
		"https://a.com/b/c",
	);
	assert.ok(result);
	assert.ok(
		result.markdown.includes("[this link](https://a.com/x)"),
		`got: ${result.markdown}`,
	);
});

test("extractArticle: relative <img src> resolves (../ against base dir), title kept", async () => {
	const result = await extractArticle(
		articleHtml('<p><img src="../i.png" alt="a pic" title="A Pic"></p>'),
		"https://a.com/b/c",
	);
	assert.ok(result);
	assert.ok(
		result.markdown.includes('![a pic](https://a.com/i.png "A Pic")'),
		`got: ${result.markdown}`,
	);
});

test("extractArticle: unresolvable href passes through unchanged", async () => {
	const result = await extractArticle(
		articleHtml('<p>Try <a href="http://">this bad link</a>.</p>'),
		"https://a.com/b/c",
	);
	assert.ok(result);
	assert.ok(
		result.markdown.includes("](http://)"),
		`got: ${result.markdown}`,
	);
});

test("extractArticle: consecutive calls with different baseUrls each resolve against their own base (shared rule, no stale base)", async () => {
	const html = articleHtml('<p>See <a href="/x">this link</a> for details.</p>');
	const first = await extractArticle(html, "https://first.com/a/b");
	const second = await extractArticle(html, "https://second.org/c/d");
	assert.ok(first);
	assert.ok(second);
	assert.ok(
		first.markdown.includes("[this link](https://first.com/x)"),
		`first call got: ${first.markdown}`,
	);
	assert.ok(
		second.markdown.includes("[this link](https://second.org/x)"),
		`second call got: ${second.markdown}`,
	);
});

test("extractArticle: no extractable article → null", async () => {
	const result = await extractArticle(
		"<html><head><title>x</title></head><body>" +
			"<script>var a = 1;</script>" +
			"<style>.x { color: red }</style>" +
			"</body></html>",
		"https://a.com/",
	);
	assert.equal(result, null);
});

test("isLikelyJSRendered: empty body + 5 scripts → true", () => {
	const html =
		"<html><head><script>0</script></head><body>" +
		"<script>a</script><script>b</script><script>c</script><script>d</script>" +
		"</body></html>";
	assert.equal(isLikelyJSRendered(html), true);
});

test("isLikelyJSRendered: real article → false", () => {
	assert.equal(isLikelyJSRendered(articleHtml()), false);
});

test("isLikelyJSRendered: no <body> → false", () => {
	assert.equal(isLikelyJSRendered("<div>hello</div>"), false);
});

test("extractHeadingTitle: tool header (# + Source: + ---)", () => {
	assert.equal(
		extractHeadingTitle("# My Page\n\nSource: https://a.com/x\n\n---\n\nBody"),
		"My Page",
	);
});

test("extractHeadingTitle: first h2 heading wins", () => {
	assert.equal(
		extractHeadingTitle("intro text\n\n## Second Level\n\nmore"),
		"Second Level",
	);
});

test("extractHeadingTitle: h3-only markdown → null", () => {
	assert.equal(extractHeadingTitle("### deep\n\ntext"), null);
});

test("extractHeadingTitle: bold markers stripped", () => {
	assert.equal(extractHeadingTitle("# **Bold** title"), "Bold title");
});

test("extractHeadingTitle: no heading → null", () => {
	assert.equal(extractHeadingTitle("just text"), null);
	assert.equal(extractHeadingTitle(""), null);
});
