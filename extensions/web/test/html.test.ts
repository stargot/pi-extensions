import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, parseHtml } from "../html.ts";

test("querySelectorAll: tag.class compound, descendant-scoped", () => {
	const doc = parseHtml(`
		<div class="outer"><span class="result">not a div</span></div>
		<div class="result"><a class="result__a">one</a></div>
		<div class="result deep"><a class="result__a">two</a></div>
	`);
	const blocks = doc.querySelectorAll("div.result");
	assert.equal(blocks.length, 2); // span.result and div.outer don't match
	const links = blocks.map((b) => b.querySelector("a.result__a")?.textContent);
	assert.deepEqual(links, ["one", "two"]);

	// scoped: querySelector only sees descendants
	assert.equal(blocks[0]!.querySelectorAll("div.result").length, 0);
});

test("querySelectorAll: unsupported selector grammar fails loud", () => {
	const doc = parseHtml("<div></div>");
	assert.throws(() => doc.querySelectorAll("div > span"), /Unsupported selector/);
	assert.throws(() => doc.querySelectorAll("#id"), /Unsupported selector/);
});

test("raw text: script content cannot leak elements into the tree", () => {
	const doc = parseHtml(`<div class="result"><a class="result__a" href="https://real.test">Real</a></div>
		<script>var tpl = '<div class="result"><a class="result__a" href="https://evil.test">FAKE</a></div>';</script>`);
	assert.equal(doc.querySelectorAll("div.result").length, 1);
	assert.equal(doc.querySelector("a.result__a")?.getAttribute("href"), "https://real.test");
	// script text is preserved verbatim, entities NOT decoded inside raw text
	const script = doc.querySelector("script")!;
	assert.match(script.textContent, /<div class="result">/);
});

test("raw text: style and title are raw text too", () => {
	const doc = parseHtml("<title>a < b</title><style>div > a { color: red }</style>");
	assert.equal(doc.querySelector("title")?.textContent, "a < b");
	assert.equal(doc.querySelector("style")?.textContent, "div > a { color: red }");
});

test("void elements: never pushed on the stack, self-closing or not", () => {
	const doc = parseHtml(`<div class="result">
		<img src="x.ico" alt=""><input type="hidden"><br>
		<a class="result__a" href="https://y.test">after voids</a>
	</div>`);
	assert.equal(doc.querySelectorAll("a.result__a").length, 1);
	assert.equal(doc.querySelectorAll("input").length, 1);
});

test("attributes: '>' inside quoted values, unquoted, empty, value-less", () => {
	const doc = parseHtml(`<a title="a > b" data-x=plain data-empty="" disabled href=/rel?q=1>z</a>`);
	const el = doc.querySelector("a")!;
	assert.equal(el.getAttribute("title"), "a > b");
	assert.equal(el.getAttribute("data-x"), "plain");
	assert.equal(el.getAttribute("data-empty"), "");
	assert.equal(el.getAttribute("disabled"), "");
	assert.equal(el.getAttribute("href"), "/rel?q=1");
	assert.equal(el.getAttribute("missing"), null);
});

test("attributes: unquoted value ending in / keeps the slash, tag not self-closed", () => {
	// per HTML5, a trailing / after an unquoted value is part of the value
	const doc = parseHtml(`<div><a href=/foo/>text</a></div>`);
	const a = doc.querySelector("a")!;
	assert.equal(a.getAttribute("href"), "/foo/");
	assert.equal(a.textContent, "text");
});

test("attributes: names are case-insensitive, tag names lowercase", () => {
	const doc = parseHtml(`<DIV CLASS="result"><A HREF="https://u.test" CLASS="result__a">Up</A></DIV>`);
	assert.equal(doc.querySelectorAll("div.result").length, 1);
	assert.equal(doc.querySelector("a.result__a")?.getAttribute("href"), "https://u.test");
});

test("selector tags are case-insensitive, class matching is case-sensitive (DOM parity)", () => {
	const doc = parseHtml(
		`<DIV CLASS="Result  DEEP"></DIV><div class="result deep"></div>`,
	);
	assert.equal(doc.querySelectorAll("div").length, 2); // tag case-insensitive
	assert.equal(doc.querySelectorAll("DIV.Result").length, 1); // class: exact match
	assert.equal(doc.querySelectorAll("div.result").length, 1);
	assert.equal(doc.querySelectorAll("div.result.deep").length, 1);
});

test("comments, doctype and processing instructions are skipped", () => {
	const doc = parseHtml(`<!DOCTYPE html><!-- a > "quoted" comment --><?xml version="1.0"?><div class="result"><a class="result__a" href="https://c.test">ok</a></div>`);
	assert.equal(doc.querySelectorAll("div.result").length, 1);
	assert.equal(doc.querySelector("a")?.textContent, "ok");
});

test("malformed markup: stray close tags discarded, unclosed tags tolerated", () => {
	// stray </span> must not close div.result; missing inner </div> must not either
	const doc = parseHtml(`<div class="result"></span><div class="x">
		<a class="result__a" href="https://m.test">M</a></div>`);
	assert.equal(doc.querySelectorAll("div.result").length, 1);
	assert.equal(doc.querySelector("a.result__a")?.textContent, "M");
});

test("lone < in text is preserved", () => {
	const doc = parseHtml("<p>3 < 5 &amp; 10 > 2</p>");
	assert.equal(doc.querySelector("p")?.textContent, "3 < 5 & 10 > 2");
});

test("decodeEntities: numeric, hex, named, unknown stays literal, no semicolon", () => {
	assert.equal(decodeEntities("&#39;&#x27;&#X27;"), "'''");
	assert.equal(decodeEntities("&amp; &lt; &nbsp; &mdash; &eacute;"), "& <   — é");
	assert.equal(decodeEntities("&nosuchentity;"), "&nosuchentity;");
	assert.equal(decodeEntities("&#39"), "'");
	assert.equal(decodeEntities("&ampersand"), "&ampersand"); // no prefix matching
	assert.equal(decodeEntities("plain"), "plain");
	assert.equal(decodeEntities("&#x110000;"), "&#x110000;"); // out of range
	assert.equal(decodeEntities("&amp;"), "&"); // single decode pass
});

test("entities: decode in text but not in script/style raw content", () => {
	const doc = parseHtml(`<p>a &amp; b</p><script>if (a &amp;&amp; b) {}</script>`);
	assert.equal(doc.querySelector("p")?.textContent, "a & b");
	assert.equal(doc.querySelector("script")?.textContent, "if (a &amp;&amp; b) {}");
});

test("truncated input never throws", () => {
	for (const chunk of ["<div class='a", "<div class='a'", "<!-- unterminated", "<script>var x", "<a href=\"x", "</div", "<!DOCTY", "<", "</", "<!-->x"]) {
		assert.doesNotThrow(() => parseHtml(chunk));
	}
});

test("empty input yields an empty document", () => {
	assert.equal(parseHtml("").children.length, 0);
	assert.equal(parseHtml("").querySelectorAll("div.result").length, 0);
});
