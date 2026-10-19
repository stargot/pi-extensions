import assert from "node:assert/strict";
import { test } from "node:test";
import { readonlyViolation } from "../readonly-guard.ts";

test("readonlyViolation: edit/write always blocked", () => {
	assert.ok(readonlyViolation("edit", { path: "a.ts" }));
	assert.ok(readonlyViolation("write", { path: "a.ts" }));
});

test("readonlyViolation: shell checked by command, other tools pass", () => {
	assert.equal(readonlyViolation("bash", { command: "git diff" }), undefined);
	assert.ok(readonlyViolation("bash", { command: "git commit -m x" }));
	assert.ok(readonlyViolation("powershell", { command: "Set-Content a.txt 1" }));
	assert.equal(readonlyViolation("read", { path: "a.ts" }), undefined);
	assert.equal(readonlyViolation("bash", {}), undefined);
});
