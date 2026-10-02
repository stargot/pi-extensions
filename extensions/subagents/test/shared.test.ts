import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelSidecarPath, classifyExitSidecar, describePromptFailure, resolveInterrupt } from "../shared.ts";

test("cancelSidecarPath: appends .cancel to the session file", () => {
	assert.equal(
		cancelSidecarPath("/tmp/sessions/2025-01-01_scout-abc.jsonl"),
		"/tmp/sessions/2025-01-01_scout-abc.jsonl.cancel",
	);
	assert.equal(cancelSidecarPath("s.jsonl"), "s.jsonl.cancel");
});

// Truth table for subagent_message's interrupt param: explicit wins,
// undefined → auto-interrupt stalled agents only.
test("resolveInterrupt: explicit true/false wins", () => {
	assert.equal(resolveInterrupt(true, false), true);
	assert.equal(resolveInterrupt(true, true), true);
	assert.equal(resolveInterrupt(false, true), false);
	assert.equal(resolveInterrupt(false, false), false);
});

test("resolveInterrupt: undefined → auto-interrupt stalled agents only", () => {
	assert.equal(resolveInterrupt(undefined, true), true);
	assert.equal(resolveInterrupt(undefined, false), false);
});

// ── classifyExitSidecar — the pollTick exit-sidecar verdict ──

test("classifyExitSidecar: cancelled type", () => {
	assert.deepEqual(classifyExitSidecar('{"type":"cancelled"}'), { kind: "cancelled" });
});

test("classifyExitSidecar: error with message", () => {
	assert.deepEqual(classifyExitSidecar('{"errorMessage":"boom"}'), { kind: "error", errorMessage: "boom" });
	// Real child-ext shape (subagent-done.ts writes type:"error").
	assert.deepEqual(classifyExitSidecar('{"type":"error","errorMessage":"API 500"}'), {
		kind: "error",
		errorMessage: "API 500",
	});
});

test("classifyExitSidecar: empty or missing errorMessage → unknown", () => {
	// Empty string means unknown per spec — the caller falls back to its
	// generic error text, same as the old truthiness check.
	assert.deepEqual(classifyExitSidecar('{"errorMessage":""}'), { kind: "unknown" });
	assert.deepEqual(classifyExitSidecar("{}"), { kind: "unknown" });
});

test("classifyExitSidecar: garbage input → unknown", () => {
	assert.deepEqual(classifyExitSidecar("not json at all"), { kind: "unknown" });
	assert.deepEqual(classifyExitSidecar('"just a string"'), { kind: "unknown" });
	assert.deepEqual(classifyExitSidecar("[1,2]"), { kind: "unknown" });
});

test("classifyExitSidecar: empty string → unknown", () => {
	assert.deepEqual(classifyExitSidecar(""), { kind: "unknown" });
});

// ── describePromptFailure — steer delivery outcomes (ADR-1) ──

test("describePromptFailure: refused_blocked — text rejected before reaching the pane", () => {
	const text = describePromptFailure("refused_blocked", "scout");
	// House style shared with the pane-gone delivery error in index.ts.
	assert.ok(text.startsWith("Could not deliver the message"));
	assert.match(text, /scout/);
	assert.match(text, /NOT delivered/);
	// The two escape hatches the caller actually has.
	assert.match(text, /answer/);
	assert.match(text, /interrupt/);
});

test("describePromptFailure: stalled — submitted, but the child never showed working", () => {
	const text = describePromptFailure("stalled", "worker");
	assert.ok(text.startsWith("Could not deliver the message"));
	assert.match(text, /worker/);
	assert.match(text, /working/);
});

test("describePromptFailure: timeout — wait elapsed, message may have landed: no blind resend", () => {
	const text = describePromptFailure("timeout", "scout");
	assert.match(text, /scout/);
	assert.match(text, /timed out/);
	// With --wait the submission itself went through — the old "retry" advice
	// risked a duplicate: the text may already sit in the child's queue.
	assert.match(text, /may have reached/);
	assert.match(text, /NOT resend blindly/);
	assert.match(text, /interrupt/);
	assert.doesNotMatch(text, /\bretry\b/);
});

test("describePromptFailure: not_found — the pane runs no agent anymore", () => {
	const text = describePromptFailure("not_found", "scout");
	assert.match(text, /scout/);
	assert.match(text, /already gone/);
});

test("R10 leak regression: the screenshot envelope normalizes to readable text, never raw JSON", () => {
	// The R9 acceptance saw the RAW herdr envelope
	// {"error":{"code":"agent_not_found",…}} rendered in the parent's input
	// field (the applyPaneLabel close-race double emission). Whatever path a
	// failed agent-surface call takes, the text that reaches the model/UI must
	// be the human-readable verdict — parsed envelope fields stay internal.
	const envelope =
		'{"error":{"code":"agent_not_found","message":"agent target w1W:pE not found"},"id":"cli:agent:rename"}';
	const text = describePromptFailure("not_found", "reviewer-070");
	assert.match(text, /reviewer-070/);
	assert.match(text, /already gone/);
	// No raw JSON anywhere in the surfaced text.
	assert.doesNotMatch(text, /\{"error"/);
	assert.ok(!text.includes(envelope));
	assert.ok(!text.includes("w1W:pE"));
});

test("describePromptFailure: error — unrecognized herdr failure", () => {
	const text = describePromptFailure("error", "scout");
	assert.ok(text.startsWith("Could not deliver the message"));
	assert.match(text, /scout/);
	assert.match(text, /unrecognized/);
});

test("describePromptFailure: delivered fallback stays readable for exhaustiveness", () => {
	// Unreachable through the ok:false path, but must still return text.
	assert.match(describePromptFailure("delivered", "scout"), /Could not deliver the message/);
});
