/**
 * Unit tests for quiz web payload assembly: the question payload must NEVER
 * contain the answer key (correctIndices/explanation) in any form, the
 * feedback payload carries it only after an answer, and POST body parsing is
 * strict. The HTTP layer itself is covered by test/web-server.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeedbackState, buildPendingState, parseAnswerBody, type QuizOption } from "../web/payload.ts";
import { resolveCorrect } from "../index.ts";

const options: QuizOption[] = [
	{ label: "Mercury", value: "mercury" },
	{ label: "Venus", value: "venus" },
	{ label: "Earth", value: "earth" },
];

// Secrets that must never appear in the pending payload, whatever the author
// wrote into the tool call.
const SECRET_EXPLANATION = "SECRET-explanation-text";
const SECRET_CORRECT_VALUE = "venus";

test("buildPendingState: question, context, mode, display-ordered options, dontKnow label", () => {
	const state = buildPendingState("Which planet is closest to the sun?", "Solar system 101", "single-select", options);
	assert.equal(state.kind, "pending");
	assert.equal(state.question, "Which planet is closest to the sun?");
	assert.equal(state.context, "Solar system 101");
	assert.equal(state.mode, "single-select");
	assert.deepEqual(state.options, [
		{ index: 1, label: "Mercury" },
		{ index: 2, label: "Venus" },
		{ index: 3, label: "Earth" },
	]);
	assert.equal(state.dontKnowLabel, "I don't know");

	const noContext = buildPendingState("Q?", undefined, "multi-select", options);
	assert.equal(noContext.context, undefined);
	assert.equal(noContext.mode, "multi-select");
});

test("ANTI-LEAK: pending payload carries no correctIndices/explanation/correct values in any form", () => {
	// Resolve the key exactly like execute() would, then build the page payload.
	const { indices, error } = resolveCorrect(SECRET_CORRECT_VALUE, options);
	assert.equal(error, undefined);
	const state = buildPendingState("Which planet is closest to the sun?", undefined, "single-select", options);

	// The regression: if the key ever leaks into the payload, this fails.
	assert.equal("correctIndices" in state, false);
	assert.equal("explanation" in state, false);
	const serialized = JSON.stringify(state);
	assert.equal(serialized.includes("correctIndices"), false);
	assert.equal(serialized.includes("explanation"), false);
	assert.equal(serialized.includes(SECRET_EXPLANATION), false);
	// The correct option's value/identity must not stand out: only {index,label}
	// pairs are sent, and the label alone is not a key (labels go out for ALL options).
	assert.equal(serialized.includes(SECRET_CORRECT_VALUE), false);
	// Keep this test honest: the key WOULD match if it leaked.
	assert.ok(JSON.stringify({ correctIndices: indices }).includes("correctIndices"));
});

test("buildFeedbackState: reveals the key and grades via isCorrect", () => {
	const pending = buildPendingState("Q?", "ctx", "single-select", options);
	const feedback = buildFeedbackState(
		pending,
		{ dontKnow: false, answers: [{ label: "Venus", value: "venus", index: 2 }] },
		[1],
		SECRET_EXPLANATION,
	);
	assert.equal(feedback.kind, "feedback");
	assert.equal(feedback.correct, false);
	assert.deepEqual(feedback.selectedIndices, [2]);
	assert.deepEqual(feedback.correctIndices, [1]);
	assert.equal(feedback.dontKnow, false);
	assert.equal(feedback.explanation, SECRET_EXPLANATION);
	// question shell is preserved for the page
	assert.equal(feedback.question, "Q?");
	assert.equal(feedback.context, "ctx");
	assert.deepEqual(feedback.options, pending.options);
});

test("buildFeedbackState: correct multi-select, dontKnow is never correct, note passthrough", () => {
	const pending = buildPendingState("Q?", undefined, "multi-select", options);
	const multi = buildFeedbackState(
		pending,
		{
			dontKnow: false,
			answers: [
				{ label: "Earth", value: "earth", index: 3 },
				{ label: "Mercury", value: "mercury", index: 1 },
			],
		},
		[1, 3],
		undefined,
	);
	assert.equal(multi.correct, true);
	// selectedIndices are sorted by display index regardless of submit order
	assert.deepEqual(multi.selectedIndices, [1, 3]);
	assert.equal(multi.explanation, undefined);

	const dontKnow = buildFeedbackState(
		pending,
		{ dontKnow: true, note: "no idea", answers: [] },
		[2],
		SECRET_EXPLANATION,
	);
	assert.equal(dontKnow.dontKnow, true);
	assert.equal(dontKnow.correct, false); // dontKnow is a distinct signal, never graded correct
	assert.deepEqual(dontKnow.selectedIndices, []);
	assert.equal(dontKnow.note, "no idea");
	assert.equal(dontKnow.explanation, SECRET_EXPLANATION);
});

test("parseAnswerBody: valid bodies, note trimming, dontKnow clears answers", () => {
	assert.deepEqual(parseAnswerBody('{"dontKnow":false,"answers":[{"label":"Venus","value":"venus","index":2}]}'), {
		dontKnow: false,
		note: undefined,
		answers: [{ label: "Venus", value: "venus", index: 2 }],
	});
	assert.deepEqual(parseAnswerBody('{"dontKnow":true,"note":"  honestly unsure  ","answers":[]}'), {
		dontKnow: true,
		note: "honestly unsure",
		answers: [],
	});
	// whitespace-only note is dropped, like the TUI note field
	assert.deepEqual(parseAnswerBody('{"dontKnow":false,"note":"   ","answers":[{"label":"A","value":"a","index":1}]}'), {
		dontKnow: false,
		note: undefined,
		answers: [{ label: "A", value: "a", index: 1 }],
	});
});

test("parseAnswerBody: rejects malformed bodies", () => {
	// not JSON / not an object
	assert.equal(parseAnswerBody("nope"), null);
	assert.equal(parseAnswerBody("[1,2]"), null);
	// missing/invalid dontKnow or answers
	assert.equal(parseAnswerBody('{"answers":[]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":"yes","answers":[]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false,"answers":"venus"}'), null);
	// answer entry shape
	assert.equal(parseAnswerBody('{"dontKnow":false,"answers":[{}]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false,"answers":[{"label":"V","value":"venus","index":0}]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false,"answers":[{"label":"V","value":"venus","index":1.5}]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false,"answers":[{"label":"V","value":7,"index":1}]}'), null);
	// dontKnow is exclusive with real answers; real answers cannot be empty
	assert.equal(parseAnswerBody('{"dontKnow":true,"answers":[{"label":"V","value":"venus","index":2}]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false,"answers":[]}'), null);
	assert.equal(parseAnswerBody('{"dontKnow":false,"note":5,"answers":[{"label":"A","value":"a","index":1}]}'), null);
});
