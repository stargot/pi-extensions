import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { childExtensionPaths, childToolEnv, headlessChildTools, PANE_TOOLS, paneChildTools } from "../child-tools.ts";

const roots = { packageDir: join("C:", "pkg", "extensions"), agentExtDir: join("C:", "agent", "extensions") };
const envGuard = join(roots.packageDir, "env-guard", "index.ts");
const editGuard = join(roots.packageDir, "edit-guard", "index.ts");
const web = join(roots.packageDir, "web", "index.ts");
const browser = join(roots.agentExtDir, "browser", "index.ts");
const all = () => true;

test("childExtensionPaths: discovery children get no explicit extensions", () => {
	assert.deepEqual(childExtensionPaths(undefined, roots, all), []);
	assert.deepEqual(childExtensionPaths([], roots, all), []);
});

test("childExtensionPaths: allowlisted children always get the guards", () => {
	assert.deepEqual(childExtensionPaths(["read", "bash"], roots, all), [envGuard, editGuard]);
});

test("childExtensionPaths: web tools resolve inside the package, once", () => {
	assert.deepEqual(childExtensionPaths(["web_search", "web_fetch", "bash"], roots, all), [envGuard, editGuard, web]);
});

test("childExtensionPaths: browser tools resolve in the agent extension dir", () => {
	assert.deepEqual(childExtensionPaths(["browser_goto", "browser_click"], roots, all), [envGuard, editGuard, browser]);
});

test("childExtensionPaths: missing entry points are skipped", () => {
	assert.deepEqual(
		childExtensionPaths(["browser_goto"], roots, (path) => path !== browser),
		[envGuard, editGuard],
	);
});

test("paneChildTools: spawning agents get the pane tools appended without duplicates", () => {
	assert.deepEqual(paneChildTools(["read", "subagent"], true), ["read", "subagent", ...PANE_TOOLS.slice(1)]);
});

test("paneChildTools: non-spawning or unrestricted agents are unchanged", () => {
	assert.deepEqual(paneChildTools(["read"], false), ["read"]);
	assert.equal(paneChildTools(undefined, true), undefined);
});

test("headlessChildTools: strips pane tools, keeps the rest", () => {
	assert.deepEqual(headlessChildTools(["read", "subagent", "subagents_list", "bash"]), ["read", "bash"]);
	assert.equal(headlessChildTools(undefined), undefined);
});

test("headlessChildTools: a pane-only allowlist becomes empty, not unrestricted", () => {
	assert.deepEqual(headlessChildTools(["subagent"]), []);
});

test("childToolEnv: browser tools in the allowlist switch the browser extension on", () => {
	assert.deepEqual(childToolEnv(["browser_goto", "read"]), { PI_BROWSER_ENABLED: "1" });
	assert.deepEqual(childToolEnv(["read", "web_search"]), {});
	assert.deepEqual(childToolEnv(undefined), {});
});
