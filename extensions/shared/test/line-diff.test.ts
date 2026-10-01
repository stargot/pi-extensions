import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildSideBySideRows,
	type DiffColor,
	type DiffRow,
	type DiffStyler,
	diffKindColors,
	diffLines,
	diffText,
	filterRows,
	plainDiffStyler,
	renderDiffRow,
} from "../line-diff.ts";

function types(rows: readonly DiffRow[]): string[] {
	return rows.map((row) => row.type);
}

/** Убирает undefined-свойства: deepStrictEqual считает {a:1,b:undefined} и {a:1} разными. */
function compact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

test("diffLines: empty inputs produce no rows", () => {
	assert.deepEqual(diffLines([], []), []);
	assert.deepEqual(compact(diffLines([], ["a"])), [
		{ type: "insert", text: "a", afterLine: 1, segments: [{ text: "a", changed: true }] },
	]);
	assert.deepEqual(compact(diffLines(["a"], [])), [
		{ type: "delete", text: "a", beforeLine: 1, segments: [{ text: "a", changed: true }] },
	]);
	assert.deepEqual(diffText("", ""), []);
});

test("diffLines: identical inputs yield equal rows with both line numbers", () => {
	const rows = diffLines(["x", "y"], ["x", "y"]);
	assert.deepEqual(types(rows), ["equal", "equal"]);
	assert.deepEqual(
		rows.map((row) => [row.beforeLine, row.afterLine]),
		[
			[1, 1],
			[2, 2],
		],
	);
	for (const row of rows) {
		assert.deepEqual(row.segments, [{ text: row.text, changed: false }]);
		assert.equal(row.afterText, undefined);
	}
});

test("diffText: single inline change becomes a modify row with both sides numbered", () => {
	const rows = diffText("a\nb\nc\nd\n", "a\nX\nc\nY\n");
	assert.deepEqual(types(rows), ["equal", "modify", "equal", "modify"]);
	assert.equal(rows[1]!.text, "b");
	assert.equal(rows[1]!.afterText, "X");
	assert.deepEqual([rows[1]!.beforeLine, rows[1]!.afterLine], [2, 2]);
	assert.deepEqual([rows[3]!.beforeLine, rows[3]!.afterLine], [4, 4]);
	assert.equal(rows[1]!.segments.map((segment) => segment.text).join(""), "b");
	assert.equal(rows[1]!.afterSegments!.map((segment) => segment.text).join(""), "X");
});

test("diffLines: inline modify segments highlight only the changed part", () => {
	const rows = diffLines(["hello world"], ["hello there"]);
	assert.deepEqual(types(rows), ["modify"]);
	assert.deepEqual(rows[0]!.segments, [
		{ text: "hello ", changed: false },
		{ text: "world", changed: true },
	]);
	assert.deepEqual(rows[0]!.afterSegments, [
		{ text: "hello ", changed: false },
		{ text: "there", changed: true },
	]);
});

test("diffLines: completely different lines get full-line changed segments and both numbers", () => {
	const rows = diffLines(["old"], ["new", "two"]);
	assert.deepEqual(types(rows), ["modify", "insert"]);
	assert.deepEqual(rows[0]!.segments, [{ text: "old", changed: true }]);
	assert.deepEqual(rows[0]!.afterSegments, [{ text: "new", changed: true }]);
	assert.equal(rows[0]!.afterText, "new");
	assert.deepEqual([rows[0]!.beforeLine, rows[0]!.afterLine], [1, 1]);
	assert.deepEqual([rows[1]!.beforeLine, rows[1]!.afterLine], [undefined, 2]);
});

test("diffLines: unequal runs pair positionally, leftovers stay delete/insert", () => {
	const rows = diffLines(["d1", "d2", "d3"], ["i1", "i2"]);
	assert.deepEqual(types(rows), ["modify", "modify", "delete"]);
	assert.equal(rows[0]!.text, "d1");
	assert.equal(rows[0]!.afterText, "i1");
	assert.equal(rows[1]!.text, "d2");
	assert.equal(rows[1]!.afterText, "i2");
	assert.equal(rows[2]!.text, "d3");
	assert.deepEqual([rows[2]!.beforeLine, rows[2]!.afterLine], [3, undefined]);
});

test("diffLines: grapheme segmentation keeps CJK and emoji intact", () => {
	const cjk = diffLines(["一二三四五"], ["一二三四六"]);
	assert.deepEqual(types(cjk), ["modify"]);
	assert.deepEqual(cjk[0]!.segments, [
		{ text: "一二三四", changed: false },
		{ text: "五", changed: true },
	]);
	assert.deepEqual(cjk[0]!.afterSegments, [
		{ text: "一二三四", changed: false },
		{ text: "六", changed: true },
	]);

	const emoji = diffLines(["ok 👍"], ["ok 👍🏽"]);
	assert.deepEqual(types(emoji), ["modify"]);
	assert.equal(emoji[0]!.segments[1]!.text, "👍", "emoji must stay one grapheme, not split into lone surrogates");
	assert.equal(emoji[0]!.afterSegments![1]!.text, "👍🏽");
});

test("diffLines: budget fallback replaces the middle with a delete/insert block (no modify)", () => {
	const merged = diffLines(["x", "b"], ["x", "c"]);
	assert.deepEqual(types(merged), ["equal", "modify"], "same input with default budget pairs into modify");

	const fallback = diffLines(["x", "b"], ["x", "c"], { maxLcsCells: 0 });
	assert.deepEqual(types(fallback), ["equal", "delete", "insert"]);
	assert.deepEqual(
		fallback.map((row) => row.text),
		["x", "b", "c"],
	);
	assert.deepEqual(fallback[1]!.segments, [{ text: "b", changed: true }]);
	assert.deepEqual(fallback[2]!.segments, [{ text: "c", changed: true }]);

	const block = diffLines(["o1", "o2"], ["n1", "n2", "n3"], { maxLcsCells: 0 });
	assert.deepEqual(types(block), ["delete", "delete", "insert", "insert", "insert"]);
	assert.deepEqual(
		block.map((row) => row.text),
		["o1", "o2", "n1", "n2", "n3"],
	);
});

test("diffLines: oversized line pair skips inline segmentation", () => {
	const long = "x".repeat(30_000);
	const rows = diffLines([long], [`${"y".repeat(30_000)}`]);
	assert.deepEqual(types(rows), ["modify"]);
	assert.deepEqual(rows[0]!.segments, [{ text: long, changed: true }]);
	assert.deepEqual(rows[0]!.afterSegments, [{ text: "y".repeat(30_000), changed: true }]);
});

test("filterRows: context=0 keeps changed rows only, gaps become separators", () => {
	const rows = diffText("a\nb\nc\nd\ne\nf\ng\n", "a\nX\nc\nd\ne\nY\ng\n");
	const tight = filterRows(rows, 0);
	assert.deepEqual(
		tight.map((row) => (row.type === "separator" ? "sep" : row.type)),
		["modify", "sep", "modify"],
	);
	assert.equal(
		tight.every((row) => row.type !== "equal"),
		true,
	);

	const full = filterRows(rows, null);
	// deepEqual с исходными DiffRow[] уже доказывает отсутствие separator'ов.
	assert.deepEqual(full, [...rows]);
});

test("filterRows: context=1 pulls in neighbouring lines and merges close hunks", () => {
	const rows = diffText("a\nb\nc\nd\ne\nf\ng\n", "a\nX\nc\nd\ne\nY\ng\n");
	const expanded = filterRows(rows, 1);
	// modify-строки несут сторону «до»: b и f, а не X и Y.
	assert.deepEqual(
		expanded.map((row) => (row.type === "separator" ? "sep" : row.text)),
		["a", "b", "c", "sep", "e", "f", "g"],
	);
});

test("buildSideBySideRows: equal/modify/delete/insert map to paired columns", () => {
	const rows = diffText("a\nb\n", "a\nc\nd\n");
	const split = buildSideBySideRows(rows);
	assert.deepEqual(
		split.map((row) => row.type),
		["line", "line", "line"],
	);
	assert.equal(split[0]!.before!.text, "a");
	assert.equal(split[0]!.after!.text, "a", "equal rows appear on both sides");
	assert.equal(split[1]!.before!.type, "delete");
	assert.equal(split[1]!.before!.text, "b");
	assert.equal(split[1]!.after!.type, "insert");
	assert.equal(split[1]!.after!.text, "c", "modify row splits into before/after views");
	assert.equal(split[2]!.before, undefined);
	assert.equal(split[2]!.after!.text, "d");
});

test("buildSideBySideRows: leftover delete/insert runs pair positionally, separators pass through", () => {
	const rows = diffLines(["o1", "o2"], ["n1", "n2"], { maxLcsCells: 0 });
	const split = buildSideBySideRows([...filterRows(rows, 0), { type: "separator" }]);
	assert.deepEqual(
		split.map((row) => row.type),
		["line", "line", "separator"],
	);
	assert.equal(split[0]!.before!.text, "o1");
	assert.equal(split[0]!.after!.text, "n1");
	assert.equal(split[1]!.before!.text, "o2");
	assert.equal(split[1]!.after!.text, "n2");
});

test("renderDiffRow: plain styler returns the raw line, recording styler applies kind colors", () => {
	const rows = diffLines(["hello world"], ["hello there"]);
	const plain = renderDiffRow(rows[0]!, plainDiffStyler);
	assert.equal(plain, "hello world");

	const fgCalls: Array<[DiffColor, string]> = [];
	const boldCalls: string[] = [];
	const recording: DiffStyler = {
		fg: (color, text) => {
			fgCalls.push([color, text]);
			return text;
		},
		bold: (text) => {
			boldCalls.push(text);
			return text;
		},
	};
	renderDiffRow(rows[0]!, recording, diffKindColors);
	assert.deepEqual(
		fgCalls,
		[
			["warning", "hello "],
			["warning", "world"],
		],
		"row color comes from diffKindColors",
	);
	assert.deepEqual(boldCalls, ["world"], "only changed segments are bold");

	const equalRow = diffLines(["same"], ["same"])[0]!;
	fgCalls.length = 0;
	boldCalls.length = 0;
	renderDiffRow(equalRow, recording);
	assert.deepEqual(fgCalls, [["muted", "same"]]);
	assert.deepEqual(boldCalls, []);
});

test("line-diff module is self-contained: no pi or DOM imports", () => {
	const source = readFileSync(fileURLToPath(new URL("../line-diff.ts", import.meta.url)), "utf8");
	assert.equal(source.includes("@earendil-works"), false, "must not import pi-coding-agent or pi-tui");
	assert.equal(source.includes('from "'), false, "must have no imports at all");
	assert.equal(source.includes("document"), false);
	assert.equal(source.includes("window"), false);
});
