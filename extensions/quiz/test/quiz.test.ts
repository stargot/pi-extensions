/**
 * Unit tests for quiz's pure logic: option normalization/shuffling, correct
 * answer coercion/resolution, grading and the model-facing result payloads,
 * plus a renderCall anti-leak regression (the call preview must not reveal
 * the correct answer or the explanation). The interactive TUI flow
 * (ctx.ui.custom) stays manual-verified.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import quiz, {
	buildResult,
	cancelledResult,
	coerceCorrectAnswer,
	formatOptionRef,
	isCorrect,
	isNoteToggleKey,
	normalizeOptions,
	resolveCorrect,
	shuffleOptions,
	sortAnswers,
	unavailableResult,
} from "../index.ts";

const options = [
	{ label: "Mercury", value: "mercury" },
	{ label: "Venus", value: "venus" },
	{ label: "Earth", value: "earth" },
];

test("normalizeOptions: trims, defaults value to label, drops blank labels", () => {
	const normalized = normalizeOptions([
		{ label: "  Mercury  ", description: "  closest to the sun  " },
		{ label: "Venus", value: " venus-value " },
		{ label: "   " },
	]);
	assert.deepEqual(normalized, [
		{ label: "Mercury", value: "Mercury", description: "closest to the sun" },
		{ label: "Venus", value: "venus-value", description: undefined },
	]);
	assert.deepEqual(normalizeOptions(undefined), []);
});

test("normalizeOptions: throws on duplicate option value", () => {
	assert.throws(() => normalizeOptions([{ label: "A" }, { label: "B", value: "A" }]), /duplicate option value "A"/);
});

test("shuffleOptions: returns a non-mutating permutation of the input", () => {
	const input = [
		{ label: "A", value: "a" },
		{ label: "B", value: "b" },
		{ label: "C", value: "c" },
		{ label: "D", value: "d" },
	];
	const out = shuffleOptions(input);
	assert.equal(out.length, input.length);
	assert.deepEqual(out.map((o) => o.value).sort(), ["a", "b", "c", "d"]);
	assert.deepEqual(out.map((o) => o.label).sort(), ["A", "B", "C", "D"]);
	// the input list itself must be untouched (shuffle works on a copy)
	assert.deepEqual(input, [
		{ label: "A", value: "a" },
		{ label: "B", value: "b" },
		{ label: "C", value: "c" },
		{ label: "D", value: "d" },
	]);
});

test("shuffleOptions: deterministic under a Math.random stub", () => {
	const original = Math.random;
	Math.random = () => 0;
	try {
		// Fisher-Yates with j always 0: [a,b,c] → swap(2,0) → [c,b,a] → swap(1,0) → [b,c,a]
		const out = shuffleOptions([
			{ label: "A", value: "a" },
			{ label: "B", value: "b" },
			{ label: "C", value: "c" },
		]);
		assert.deepEqual(
			out.map((o) => o.value),
			["b", "c", "a"],
		);
	} finally {
		Math.random = original;
	}
});

test("coerceCorrectAnswer: array passes through, string wraps, JSON-string parses, garbage stays literal", () => {
	assert.deepEqual(coerceCorrectAnswer(["a", "b"]), ["a", "b"]);
	assert.deepEqual(coerceCorrectAnswer("mercury"), ["mercury"]);
	assert.deepEqual(coerceCorrectAnswer('["a","b"]'), ["a", "b"]);
	// starts with [ but no closing ] — never enters the JSON branch
	assert.deepEqual(coerceCorrectAnswer("[oops"), ["[oops"]);
	// bracketed but not valid JSON — JSON.parse fails, falls back to a literal
	assert.deepEqual(coerceCorrectAnswer("[not json]"), ["[not json]"]);
});

test("resolveCorrect: requires correctAnswer and maps values to 1-based indices", () => {
	assert.deepEqual(resolveCorrect(undefined, options), { indices: [], error: "correctAnswer is required" });
	assert.deepEqual(resolveCorrect([], options), { indices: [], error: "correctAnswer is required" });
	assert.deepEqual(resolveCorrect("venus", options), { indices: [2] });
});

test("resolveCorrect: unknown value is a hard error listing the known ones", () => {
	assert.deepEqual(resolveCorrect("nope", options), {
		indices: [],
		error: 'correctAnswer "nope" does not match any option value ("mercury", "venus", "earth")',
	});
});

test("resolveCorrect: deduplicates and sorts indices; accepts a JSON-stringified array", () => {
	assert.deepEqual(resolveCorrect(["earth", "mercury", "earth"], options), { indices: [1, 3] });
	assert.deepEqual(resolveCorrect('["earth","mercury"]', options), { indices: [1, 3] });
});

test("isCorrect: exact-set match regardless of order; length mismatch is wrong", () => {
	assert.equal(isCorrect([2, 1], [1, 2]), true);
	assert.equal(isCorrect([1, 2, 3], [3, 2, 1]), true);
	assert.equal(isCorrect([1], [1, 2]), false);
	assert.equal(isCorrect([1, 2], [1, 3]), false);
});

test("sortAnswers: orders multi-select answers by their display index", () => {
	const sorted = sortAnswers([
		{ label: "Earth", value: "earth", index: 3 },
		{ label: "Mercury", value: "mercury", index: 1 },
	]);
	assert.deepEqual(
		sorted.map((a) => a.index),
		[1, 3],
	);
});

test("formatOptionRef: 1-based label reference, (unknown) for out-of-range", () => {
	assert.equal(formatOptionRef(options, 2), "2. Venus");
	assert.equal(formatOptionRef(options, 9), "9. (unknown)");
});

test("buildResult: correct answer branch", () => {
	const result = buildResult(
		"Closest planet to the sun?",
		undefined,
		"single-select",
		options,
		{ dontKnow: false, answers: [{ label: "Mercury", value: "mercury", index: 1 }] },
		[1],
		undefined,
	);
	assert.match(result.content[0].text, /^User answered correctly\./);
	assert.match(result.content[0].text, /Selected: 1\. Mercury/);
	assert.match(result.content[0].text, /Correct: 1\. Mercury/);
	assert.equal(result.details.correct, true);
	assert.equal(result.details.dontKnow, false);
	// note reaches the model only when the user typed one
	assert.equal(result.content[0].text.includes("User's note"), false);
});

test("buildResult: incorrect answer branch appends explanation", () => {
	const result = buildResult(
		"Closest planet to the sun?",
		"context here",
		"single-select",
		options,
		{ dontKnow: false, answers: [{ label: "Venus", value: "venus", index: 2 }] },
		[1],
		"Mercury is the closest planet.",
	);
	assert.match(result.content[0].text, /^User answered incorrectly\./);
	assert.match(result.content[0].text, /Selected: 2\. Venus/);
	assert.match(result.content[0].text, /Correct: 1\. Mercury/);
	assert.match(result.content[0].text, /Explanation: Mercury is the closest planet\./);
	assert.equal(result.details.correct, false);
	assert.equal(result.details.context, "context here");
});

test("buildResult: dontKnow is a distinct signal, never graded as correct", () => {
	const result = buildResult(
		"Closest planet to the sun?",
		undefined,
		"single-select",
		options,
		{ dontKnow: true, note: "not sure at all", answers: [] },
		[2],
		undefined,
	);
	assert.match(result.content[0].text, /did not attempt an answer/);
	assert.match(result.content[0].text, /Correct: 2\. Venus/);
	assert.match(result.content[0].text, /User's note: not sure at all/);
	assert.equal(result.details.correct, false);
	assert.equal(result.details.dontKnow, true);
	assert.deepEqual(result.details.answers, []);
});

test("buildResult: details.options lists all options 1-based in display order", () => {
	const result = buildResult(
		"Q?",
		undefined,
		"multi-select",
		options,
		{ dontKnow: false, answers: [] },
		[1],
		undefined,
	);
	assert.deepEqual(result.details.options, [
		{ index: 1, label: "Mercury" },
		{ index: 2, label: "Venus" },
		{ index: 3, label: "Earth" },
	]);
});

test("cancelled and unavailable results carry status + message", () => {
	const cancelled = cancelledResult("Q?", "single-select", [1]);
	assert.equal(cancelled.details.status, "cancelled");
	assert.equal(cancelled.content[0].text, "User cancelled the quiz");
	assert.deepEqual(cancelled.details.correctIndices, [1]);

	const unavailable = unavailableResult("Q?", "multi-select", "quiz requires at least two options", [2], "ctx");
	assert.equal(unavailable.details.status, "unavailable");
	assert.equal(unavailable.content[0].text, "quiz requires at least two options");
	assert.equal(unavailable.details.message, "quiz requires at least two options");
	assert.equal(unavailable.details.context, "ctx");
});

test("renderCall: preview never leaks correctAnswer or explanation", () => {
	const registered: Array<{ renderCall: (args: any, theme: any) => { render: (width: number) => string[] } }> = [];
	quiz({
		registerTool: (tool: never) => registered.push(tool),
		on: () => {},
		registerCommand: () => {},
	} as never);
	const tool = registered[0];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const args = {
		question: "Which planet is closest to the sun?",
		options: [
			{ label: "Venus", value: "venus" },
			{ label: "Mercury", value: "mercury" },
			{ label: "Earth", value: "earth" },
		],
		multiSelect: false,
		correctAnswer: "SECRET-correct-value",
		explanation: "SECRET-explanation-text",
	};
	const rendered = tool.renderCall(args, theme).render(200).join("\n");
	// sanity: the call preview itself rendered
	assert.match(rendered, /quiz/);
	assert.match(rendered, /Which planet is closest to the sun\?/);
	assert.match(rendered, /\(3 options\)/);
	// anti-leak: neither the correct answer value nor the explanation appears
	assert.equal(rendered.includes("SECRET-correct-value"), false);
	assert.equal(rendered.includes("SECRET-explanation-text"), false);
});

test("renderCall: web:true adds a [web] badge without leaking the URL/token", () => {
	const registered: Array<{ renderCall: (args: any, theme: any) => { render: (width: number) => string[] } }> = [];
	quiz({
		registerTool: (tool: never) => registered.push(tool),
		on: () => {},
		registerCommand: () => {},
	} as never);
	const tool = registered[0];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const args = {
		question: "Q?",
		options: [
			{ label: "A", value: "a" },
			{ label: "B", value: "b" },
		],
		correctAnswer: "a",
		explanation: "E",
		web: true,
		// simulates any token-ish material that must never reach the preview
		token: "SECRET-token",
	};
	const rendered = tool.renderCall(args, theme).render(200).join("\n");
	assert.match(rendered, /\[web\]/);
	assert.equal(rendered.includes("SECRET-token"), false);
	assert.equal(rendered.includes("http://127.0.0.1"), false);
});

test("isNoteToggleKey: plain 'n' toggles the note field; Tab and modified keys do not", () => {
	// Regression guard for the Windows fallback: the live chain (WezTerm → herdr/
	// ConPTY) never delivered Tab in a form matchesKey("tab") accepts, so the
	// note field got an additional 'n' toggle (checked in the options focus
	// only). Deliberate deviation from upstream amosblomqvist/learn, which uses
	// Tab alone.
	assert.equal(isNoteToggleKey("n"), true);
	// must NOT fire on anything else — in particular not on Tab (handled
	// separately) and not on letters the note editor must receive as text when
	// the note field is focused ('N', ctrl+n via C0 byte, alt+n, multi-char paste)
	assert.equal(isNoteToggleKey("\t"), false);
	assert.equal(isNoteToggleKey("N"), false);
	assert.equal(isNoteToggleKey("\x06"), false); // ctrl+n
	assert.equal(isNoteToggleKey("\x1bn"), false); // alt+n
	assert.equal(isNoteToggleKey("nX"), false); // paste chunk, not a single key
});
