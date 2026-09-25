/**
 * Unit tests for ask-user-question's pure logic: option normalization,
 * answer formatting/sorting and the model-facing result payloads. The
 * interactive TUI flow (ctx.ui.custom) stays manual-verified.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildResult,
	cancelledResult,
	formatAnswerForModel,
	getOtherLabel,
	normalizeOptions,
	sortAnswers,
	unavailableResult,
	type AskAnswer,
} from "../../ask-user-question.ts";

const option = (index: number, label: string): AskAnswer => ({ type: "option", label, value: label, index });

test("normalizeOptions: trims, defaults value to label, drops blank labels", () => {
	const options = normalizeOptions([
		{ label: "  Yes  ", description: "  agree  " },
		{ label: "No" },
		{ label: "   " },
		{ label: "Custom", value: " custom-value " },
	]);
	assert.deepEqual(options, [
		{ label: "Yes", value: "Yes", description: "agree" },
		{ label: "No", value: "No", description: undefined },
		{ label: "Custom", value: "custom-value", description: undefined },
	]);
	assert.deepEqual(normalizeOptions(undefined), []);
});

test("getOtherLabel: disambiguates when an option is already named other", () => {
	assert.equal(getOtherLabel(normalizeOptions([{ label: "Other" }])), "Other (custom)");
	assert.equal(getOtherLabel(normalizeOptions([{ label: "Yes" }, { label: "No" }])), "Other");
});

test("formatAnswerForModel: text, other and option shapes", () => {
	assert.equal(formatAnswerForModel({ type: "text", value: "", label: "typed answer" }), "typed answer");
	assert.equal(formatAnswerForModel({ type: "other", value: "", label: "my own words" }), "Other: my own words");
	assert.equal(formatAnswerForModel(option(2, "Second")), "2. Second");
});

test("sortAnswers: options by index first, then other, then free text", () => {
	const sorted = sortAnswers([
		{ type: "text", value: "", label: "free text" },
		option(3, "Third"),
		{ type: "other", value: "", label: "custom" },
		option(1, "First"),
	]);
	assert.deepEqual(
		sorted.map((a) => (a.type === "option" ? a.index : a.type)),
		[1, 3, "other", "text"],
	);
});

test("buildResult: text mode distinguishes empty response", () => {
	const empty = buildResult("Q?", undefined, "text", [{ type: "text", value: "", label: "   " }]);
	assert.equal(empty.content[0].text, "User submitted an empty response");
	assert.equal(empty.details.status, "answered");

	const answered = buildResult("Q?", "ctx", "text", [{ type: "text", value: "", label: "hello" }]);
	assert.equal(answered.content[0].text, "User answered: hello");
	assert.equal(answered.details.context, "ctx");
});

test("buildResult: single-select and multi-select formats", () => {
	const single = buildResult("Q?", undefined, "single-select", [option(2, "Second")]);
	assert.equal(single.content[0].text, "User selected: 2. Second");

	const multi = buildResult("Q?", undefined, "multi-select", [option(1, "First"), { type: "other", value: "", label: "own" }]);
	assert.equal(multi.content[0].text, "User selected:\n- 1. First\n- Other: own");
});

test("cancelled and unavailable results carry status + message", () => {
	const cancelled = cancelledResult("Q?", "multi-select", "ctx");
	assert.equal(cancelled.details.status, "cancelled");
	assert.equal(cancelled.content[0].text, "User cancelled the question");

	const unavailable = unavailableResult("Q?", "text", "no UI here");
	assert.equal(unavailable.details.status, "unavailable");
	assert.equal(unavailable.content[0].text, "no UI here");
});
