import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { MessageEndEvent, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	buildRedactor,
	escapeRegExp,
	redactAssistantMessage,
	redactDeep,
	redactEnvLines,
	redactText,
	valueVariants,
} from "../redact.ts";
import { collectSecrets, isCollectableEntry, isTrackableValue, matchesSecretName, parseDotenv } from "../secrets.ts";
import {
	createMessageEndHandler,
	createState,
	createToolCallHandler,
	createToolResultHandler,
	formatStatus,
	type GuardState,
	type NotifyContext,
	refresh,
	rescan,
} from "../index.ts";

const SECRET = "sk-test-0123456789abcdef";
const OTHER = "gl-test-fedcba9876543210";

test("parseDotenv: plain, quoted, export, comments, blank lines", () => {
	const text = [
		"# header comment",
		"",
		"PLAIN_KEY=abc12345",
		"export EXPORTED_KEY=def67890",
		'DOUBLE_KEY="quoted value 1"',
		"SINGLE_KEY='quoted value 2'",
		"INLINE_KEY=tail12345 # trailing comment",
		"EMPTY_KEY=",
		"no equals sign here",
		"=NO_KEY_NAME",
		"   SPACED_KEY  =   spaced12345   ",
	].join("\n");
	const entries = parseDotenv(text);
	const map = new Map(entries.map((e) => [e.key, e.value]));
	assert.equal(entries.length, 6);
	assert.equal(map.get("PLAIN_KEY"), "abc12345");
	assert.equal(map.get("EXPORTED_KEY"), "def67890");
	assert.equal(map.get("DOUBLE_KEY"), "quoted value 1");
	assert.equal(map.get("SINGLE_KEY"), "quoted value 2");
	assert.equal(map.get("INLINE_KEY"), "tail12345");
	assert.equal(map.get("SPACED_KEY"), "spaced12345");
	assert.equal(map.has("EMPTY_KEY"), false);
});

test("parseDotenv: hash inside quoted value is kept", () => {
	const entries = parseDotenv('HASH_KEY="a#b#c123"');
	assert.deepEqual(entries, [{ key: "HASH_KEY", value: "a#b#c123" }]);
});

test("matchesSecretName: pattern cases", () => {
	assert.equal(matchesSecretName("LANGSEARCH_API_KEY"), true);
	assert.equal(matchesSecretName("GITHUB_TOKEN"), true);
	assert.equal(matchesSecretName("DB_PASSWORD"), true);
	assert.equal(matchesSecretName("DB_PASSWD"), true);
	assert.equal(matchesSecretName("AWS_SECRET_ACCESS_KEY"), true);
	assert.equal(matchesSecretName("client_private.pem_marker"), true);
	assert.equal(matchesSecretName("MY_CREDENTIALS"), false);
	assert.equal(matchesSecretName("VEGA_EMAIL"), true);
	assert.equal(matchesSecretName("MY_KEY"), true);
	assert.equal(matchesSecretName("KEY_ID"), true);
	assert.equal(matchesSecretName("MY.API_KEY"), true);
	assert.equal(matchesSecretName("SECRET_OF_SECRETS"), true);
	assert.equal(matchesSecretName("VERY_SECRET_LINK"), true);
	assert.equal(matchesSecretName("VOICEMAIL_GREETING"), false);
	assert.equal(matchesSecretName("EMAILS_SENT"), false);
	assert.equal(matchesSecretName("XKEY"), false);
	assert.equal(matchesSecretName("PATH"), false);
	assert.equal(matchesSecretName("HOME"), false);
	assert.equal(matchesSecretName("EDITOR"), false);
});

test("isTrackableValue: filters", () => {
	assert.equal(isTrackableValue("short"), false);
	assert.equal(isTrackableValue("seven777"), true);
	assert.equal(isTrackableValue("has space123"), false);
	assert.equal(isTrackableValue("true"), false);
	assert.equal(isTrackableValue("FALSE"), false);
	assert.equal(isTrackableValue("none"), false);
	assert.equal(isTrackableValue("null"), false);
	assert.equal(isTrackableValue("undefined"), false);
	assert.equal(isTrackableValue("0"), false);
	assert.equal(isTrackableValue("1"), false);
	assert.equal(isTrackableValue("12345678"), false);
	assert.equal(isTrackableValue("-12345678"), false);
	assert.equal(isTrackableValue("https://example.com/abc"), false);
	assert.equal(isTrackableValue("http://example.com/abc"), false);
	assert.equal(isTrackableValue("https://way.toolong.value"), false);
	assert.equal(isTrackableValue("p@ssw0rd!123"), true);
});

test("isCollectableEntry: trackable shape or secret-named key with sane value", () => {
	assert.equal(isCollectableEntry({ key: "SOME_KEY", value: "144888554" }), true);
	assert.equal(isCollectableEntry({ key: "VERY_SECRET_LINK", value: "https://vega.domeno.sh/144888554/" }), true);
	assert.equal(isCollectableEntry({ key: "NUMBERS_TOKEN", value: "12345678" }), true);
	assert.equal(isCollectableEntry({ key: "SHORT_KEY", value: "abc" }), false);
	assert.equal(isCollectableEntry({ key: "DEBUG_SECRET", value: "true" }), false);
	assert.equal(isCollectableEntry({ key: "MY_SECRET", value: "1" }), false);
	assert.equal(isCollectableEntry({ key: "PORT", value: "3000" }), false);
	assert.equal(isCollectableEntry({ key: "TIMEOUT", value: "30" }), false);
	assert.equal(isCollectableEntry({ key: "PLAIN_VALUE", value: "short" }), false);
	assert.equal(isCollectableEntry({ key: "SECRET_PIN", value: "" }), false);
	assert.equal(isCollectableEntry({ key: "SECRET_PHRASE", value: "has space inside" }), false);
});

test("escapeRegExp: special characters become literal", () => {
	assert.equal(escapeRegExp("a.b*c+d(e)"), "a\\.b\\*c\\+d\\(e\\)");
});

test("buildRedactor: regex-escaped value with special characters redacts", () => {
	const value = "a.b*c+d(e)";
	const redactor = buildRedactor([{ key: "WEIRD_KEY", value }]);
	const result = redactText(`prefix ${value} suffix`, redactor);
	assert.equal(result.changed, true);
	assert.equal(result.text, "prefix [REDACTED:WEIRD_KEY] suffix");
});

test("valueVariants: raw, json, url, base64", () => {
	const value = "p@ssw0rd!123";
	const variants = valueVariants(value);
	assert.ok(variants.includes(value));
	assert.ok(variants.includes("p%40ssw0rd!123"));
	assert.ok(variants.includes(Buffer.from(value, "utf8").toString("base64")));
	const jsonValue = 'a"b"c"d"e"f';
	const jsonVariants = valueVariants(jsonValue);
	assert.ok(jsonVariants.includes('a\\"b\\"c\\"d\\"e\\"f'));
});

test("redactText: url-encoded and base64 occurrences are redacted", () => {
	const value = "p@ssw0rd!123";
	const redactor = buildRedactor([{ key: "URL_KEY", value }]);
	const urlForm = "p%40ssw0rd!123";
	const b64Form = Buffer.from(value, "utf8").toString("base64");
	assert.equal(redactText(`see ${urlForm} here`, redactor).text, "see [REDACTED:URL_KEY] here");
	assert.equal(redactText(`see ${b64Form} here`, redactor).text, "see [REDACTED:URL_KEY] here");
});

test("redactText: longest alternative wins over its prefix", () => {
	const short = "sk-test-0123456789abcdef";
	const long = "sk-test-0123456789abcdefXYZ";
	const redactor = buildRedactor([
		{ key: "SHORT_KEY", value: short },
		{ key: "LONGER_KEY", value: long },
	]);
	const result = redactText(`both ${long} and ${short}`, redactor);
	assert.equal(result.text, "both [REDACTED:LONGER_KEY] and [REDACTED:SHORT_KEY]");
	assert.deepEqual(
		[...result.hits.entries()],
		[
			["LONGER_KEY", 1],
			["SHORT_KEY", 1],
		],
	);
});

test("redactText: shared value maps to shortest key", () => {
	const redactor = buildRedactor([
		{ key: "AAA_LONG_KEY_NAME", value: SECRET },
		{ key: "B", value: SECRET },
	]);
	const result = redactText(SECRET, redactor);
	assert.equal(result.text, "[REDACTED:B]");
});

test("redactEnvLines: masks dotenv assignments for secret-named keys only", () => {
	const result = redactEnvLines(
		[
			"export VEGA_EMAIL=ivan@domeno.sh",
			"  SECRET_OF_SECRETS=hunter2123",
			'MY_TOKEN  =  "abcdef123456"',
			"SECRET_CODE=12345678 # trailing comment",
			"PORT=3000",
			"TIMEOUT=30",
			"DATABASE_URL=postgres://localhost/db",
			"SECRET_PIN=",
			"rate = 0.9",
		].join("\n"),
	);
	assert.equal(result.changed, true);
	assert.equal(
		result.text,
		[
			"export VEGA_EMAIL=[REDACTED:VEGA_EMAIL]",
			"  SECRET_OF_SECRETS=[REDACTED:SECRET_OF_SECRETS]",
			"MY_TOKEN  =[REDACTED:MY_TOKEN]",
			"SECRET_CODE=[REDACTED:SECRET_CODE]",
			"PORT=3000",
			"TIMEOUT=30",
			"DATABASE_URL=postgres://localhost/db",
			"SECRET_PIN=",
			"rate = 0.9",
		].join("\n"),
	);
	assert.deepEqual(
		[...result.hits.entries()],
		[
			["VEGA_EMAIL", 1],
			["SECRET_OF_SECRETS", 1],
			["MY_TOKEN", 1],
			["SECRET_CODE", 1],
		],
	);
});

test("redactEnvLines: already-redacted lines stay unchanged and remain idempotent", () => {
	const text =
		"OPENROUTER_API_KEY=[REDACTED:OPENROUTER_API_KEY]\nSECOND_KEY=[REDACTED:OTHER_TOKEN]\nTHIRD_TOKEN=realvalue12345";
	const once = redactEnvLines(text);
	assert.equal(once.changed, true);
	assert.equal(
		once.text,
		"OPENROUTER_API_KEY=[REDACTED:OPENROUTER_API_KEY]\nSECOND_KEY=[REDACTED:OTHER_TOKEN]\nTHIRD_TOKEN=[REDACTED:THIRD_TOKEN]",
	);
	assert.deepEqual([...once.hits.entries()], [["THIRD_TOKEN", 1]]);
	const twice = redactEnvLines(once.text);
	assert.equal(twice.changed, false);
	assert.equal(twice.hits.size, 0);
});

test("redactEnvLines: unified diff prefix chars are preserved", () => {
	const result = redactEnvLines(
		["+MY_TOKEN=abcdef123456", "-OLD_SECRET=xyz12345678", "+ export NEW_KEY=abcdef123", " CONTEXT=plain"].join("\n"),
	);
	assert.equal(
		result.text,
		[
			"+MY_TOKEN=[REDACTED:MY_TOKEN]",
			"-OLD_SECRET=[REDACTED:OLD_SECRET]",
			"+ export NEW_KEY=[REDACTED:NEW_KEY]",
			" CONTEXT=plain",
		].join("\n"),
	);
	assert.deepEqual(
		[...result.hits.entries()],
		[
			["MY_TOKEN", 1],
			["OLD_SECRET", 1],
			["NEW_KEY", 1],
		],
	);
});

test("redactEnvLines: CRLF line endings are preserved on masked lines", () => {
	const result = redactEnvLines("VEGA_EMAIL=ivan@domeno.sh\r\nPORT=3000\r\n");
	assert.equal(result.changed, true);
	assert.equal(result.text, "VEGA_EMAIL=[REDACTED:VEGA_EMAIL]\r\nPORT=3000\r\n");
});

test("redactEnvLines: dotted keys are masked", () => {
	const result = redactEnvLines("MY.API_KEY=abcdef123456\nport.option=3000");
	assert.equal(result.text, "MY.API_KEY=[REDACTED:MY.API_KEY]\nport.option=3000");
});

test("redactEnvLines: quoted-empty values are skipped", () => {
	const text = "SECRET_PIN=''\nSECRET_PIN2=\"\"\nPORT=3000";
	const result = redactEnvLines(text);
	assert.equal(result.changed, false);
	assert.equal(result.text, text);
});

test("redactEnvLines: inline comment is masked together with the value", () => {
	const result = redactEnvLines("SECRET_CODE=12345678 # note\nOTHER=plain");
	assert.equal(result.text, "SECRET_CODE=[REDACTED:SECRET_CODE]\nOTHER=plain");
});

test("redaction is idempotent", () => {
	const redactor = buildRedactor([
		{ key: "LANGSEARCH_API_KEY", value: SECRET },
		{ key: "OTHER_TOKEN", value: OTHER },
	]);
	const once = redactText(`curl -H "Authorization: Bearer ${SECRET}" ${OTHER}`, redactor);
	assert.equal(once.changed, true);
	const twice = redactText(once.text, redactor);
	assert.equal(twice.changed, false);
	assert.equal(twice.text, once.text);
	assert.equal(twice.hits.size, 0);
});

test("redaction stays idempotent when a value is a marker substring", () => {
	const redactor = buildRedactor([
		{ key: "MARKER_KEY", value: "REDACTED" },
		{ key: "OTHER_TOKEN", value: SECRET },
	]);
	const once = redactText("value REDACTED and secret sk-test-0123456789abcdef", redactor);
	const twice = redactText(once.text, redactor);
	assert.equal(twice.changed, false);
	assert.equal(twice.text, once.text);
});

test("redactDeep: walks nested objects and arrays, keeps structure", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const input = {
		stdout: `token ${SECRET}`,
		nested: { list: [1, "two", { deep: SECRET }], empty: null },
		count: 5,
		flag: true,
	};
	const result = redactDeep(input, redactor);
	assert.equal(result.changed, true);
	assert.deepEqual(result.value, {
		stdout: "token [REDACTED:LANGSEARCH_API_KEY]",
		nested: { list: [1, "two", { deep: "[REDACTED:LANGSEARCH_API_KEY]" }], empty: null },
		count: 5,
		flag: true,
	});
});

test("redactDeep: no hit returns original value unchanged", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const input = { stdout: "nothing here" };
	const result = redactDeep(input, redactor);
	assert.equal(result.changed, false);
	assert.equal(result.value, input);
});

test("redactDeep: cyclic object is redacted without throwing", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const input: Record<string, unknown> = { stdout: `token ${SECRET}` };
	input.self = input;
	const result = redactDeep(input, redactor);
	assert.equal(result.changed, true);
	const output = result.value as Record<string, unknown>;
	assert.equal(output.stdout, "token [REDACTED:LANGSEARCH_API_KEY]");
	assert.equal(output.self, output);
	assert.equal((output.self as Record<string, unknown>).stdout, "token [REDACTED:LANGSEARCH_API_KEY]");
	assert.equal(result.hits.get("LANGSEARCH_API_KEY"), 1);
});

test("redactDeep: shared diamond reference yields one redacted copy", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const shared = { token: SECRET };
	const input = { a: shared, b: shared };
	const result = redactDeep(input, redactor);
	assert.equal(result.changed, true);
	const output = result.value as { a: { token: string }; b: { token: string } };
	assert.equal(output.a.token, "[REDACTED:LANGSEARCH_API_KEY]");
	assert.equal(output.b.token, "[REDACTED:LANGSEARCH_API_KEY]");
	assert.equal(output.a, output.b);
});

test("redactDeep: Date, Map, Set and Buffer pass through unchanged", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const date = new Date(0);
	const map = new Map([["a", 1]]);
	const set = new Set([1, 2]);
	const buffer = Buffer.from("binary0001");
	const input = { when: date, lookup: map, tags: set, raw: buffer, note: `has ${SECRET}` };
	const result = redactDeep(input, redactor);
	assert.equal(result.changed, true);
	const output = result.value as typeof input;
	assert.equal(output.when, date);
	assert.equal(output.lookup, map);
	assert.equal(output.tags, set);
	assert.ok(Buffer.isBuffer(output.raw));
	assert.equal(output.note, "has [REDACTED:LANGSEARCH_API_KEY]");
});

test("redactAssistantMessage: redacts text and thinking, preserves role", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: `the key is ${SECRET}` },
			{ type: "thinking", thinking: `checking ${SECRET}` },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } },
		],
	};
	const result = redactAssistantMessage(message as never, redactor);
	assert.ok(result);
	assert.equal(result.message.role, "assistant");
	assert.deepEqual(result.message, {
		role: "assistant",
		content: [
			{ type: "text", text: "the key is [REDACTED:LANGSEARCH_API_KEY]" },
			{ type: "thinking", thinking: "checking [REDACTED:LANGSEARCH_API_KEY]" },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } },
		],
	});
	assert.equal(result.hits.get("LANGSEARCH_API_KEY"), 2);
});

test("redactAssistantMessage: user messages are untouched", () => {
	const redactor = buildRedactor([{ key: "LANGSEARCH_API_KEY", value: SECRET }]);
	const result = redactAssistantMessage({ role: "user", content: SECRET } as never, redactor);
	assert.equal(result, undefined);
});

function makeCtx(notified: string[]): NotifyContext {
	return { hasUI: true, ui: { notify: (message: string) => notified.push(message) } };
}

function makeStateWithSecrets(): GuardState {
	const state = createState();
	state.secrets = [
		{ key: "LANGSEARCH_API_KEY", value: SECRET },
		{ key: "OTHER_TOKEN", value: OTHER },
	];
	state.redactor = buildRedactor(state.secrets);
	state.files = [{ path: "/tmp/proj/.env", count: 2 }];
	state.envNames = ["LANGSEARCH_API_KEY"];
	return state;
}

const TOOL_RESULT_EVENT = {
	type: "tool_result",
	toolCallId: "t1",
	toolName: "bash",
	input: { command: "echo" },
	content: [{ type: "text", text: `output ${SECRET}` }],
	structuredContent: { out: `output ${SECRET}`, rows: [OTHER] },
	isError: false,
	details: { command: "echo key", output: `output ${SECRET}` },
} as unknown as ToolResultEvent;

test("tool_result handler: redacts content, structuredContent and details, keeps structuredContent", async () => {
	const state = makeStateWithSecrets();
	const notified: string[] = [];
	const handler = createToolResultHandler(state);
	const patch = await handler(TOOL_RESULT_EVENT, makeCtx(notified));
	assert.ok(patch);
	assert.deepEqual(patch.content, [{ type: "text", text: "output [REDACTED:LANGSEARCH_API_KEY]" }]);
	assert.deepEqual(patch.structuredContent, {
		out: "output [REDACTED:LANGSEARCH_API_KEY]",
		rows: ["[REDACTED:OTHER_TOKEN]"],
	});
	assert.deepEqual(patch.details, { command: "echo key", output: "output [REDACTED:LANGSEARCH_API_KEY]" });
	assert.deepEqual(
		[...state.counters.entries()],
		[
			["LANGSEARCH_API_KEY", 3],
			["OTHER_TOKEN", 1],
		],
	);
	assert.deepEqual(notified, ["env-guard: redacted LANGSEARCH_API_KEY", "env-guard: redacted OTHER_TOKEN"]);
});

test("tool_result handler: notifies each key once per session", async () => {
	const state = makeStateWithSecrets();
	const notified: string[] = [];
	const handler = createToolResultHandler(state);
	const event = {
		...TOOL_RESULT_EVENT,
		content: [{ type: "text", text: `again ${SECRET}` }],
		structuredContent: undefined,
		details: undefined,
	} as ToolResultEvent;
	const first = await handler(event, makeCtx(notified));
	const second = await handler(event, makeCtx(notified));
	assert.ok(first);
	assert.ok(second);
	assert.deepEqual(notified, ["env-guard: redacted LANGSEARCH_API_KEY"]);
	assert.equal(state.counters.get("LANGSEARCH_API_KEY"), 2);
});

test("tool_result handler: returns undefined when nothing matches", async () => {
	const state = makeStateWithSecrets();
	const handler = createToolResultHandler(state);
	const patch = await handler(
		{
			...TOOL_RESULT_EVENT,
			content: [{ type: "text", text: "clean output" }],
			structuredContent: { out: "clean" },
			details: undefined,
		} as never,
		makeCtx([]),
	);
	assert.equal(patch, undefined);
});

test("tool_result handler: no-op without secrets", async () => {
	const state = createState();
	const handler = createToolResultHandler(state);
	const patch = await handler(TOOL_RESULT_EVENT, makeCtx([]));
	assert.equal(patch, undefined);
});

test("tool_result handler: name-based fallback masks dotenv lines with zero collected secrets", async () => {
	const state = createState();
	const notified: string[] = [];
	const handler = createToolResultHandler(state);
	const event = {
		...TOOL_RESULT_EVENT,
		content: [
			{
				type: "text",
				text: [
					"$ cat /d/Projects/diego/.env",
					"VEGA_EMAIL=ivan@domeno.sh",
					"SECRET_OF_SECRETS=hunter2123",
					"PORT=3000",
				].join("\n"),
			},
		],
		structuredContent: undefined,
		details: undefined,
	} as unknown as ToolResultEvent;
	const patch = await handler(event, makeCtx(notified));
	assert.ok(patch);
	assert.deepEqual(patch.content, [
		{
			type: "text",
			text: [
				"$ cat /d/Projects/diego/.env",
				"VEGA_EMAIL=[REDACTED:VEGA_EMAIL]",
				"SECRET_OF_SECRETS=[REDACTED:SECRET_OF_SECRETS]",
				"PORT=3000",
			].join("\n"),
		},
	]);
	assert.deepEqual(notified, ["env-guard: redacted VEGA_EMAIL", "env-guard: redacted SECRET_OF_SECRETS"]);
	assert.equal(state.counters.get("VEGA_EMAIL"), 1);
	assert.equal(state.counters.get("SECRET_OF_SECRETS"), 1);
	assert.equal(state.counters.get("PORT"), undefined);
});

test("tool_result handler: already-redacted dotenv lines are not double-masked", async () => {
	const state = createState();
	state.secrets = [{ key: "OPENROUTER_API_KEY", value: "sk-or-test-1234567890" }];
	state.redactor = buildRedactor(state.secrets);
	const handler = createToolResultHandler(state);
	const patch = await handler(
		{
			...TOOL_RESULT_EVENT,
			content: [{ type: "text", text: "OPENROUTER_API_KEY=[REDACTED:OPENROUTER_API_KEY]" }],
			structuredContent: undefined,
			details: undefined,
		} as unknown as ToolResultEvent,
		makeCtx([]),
	);
	assert.equal(patch, undefined);
});

test("tool_result handler: name fallback applies to structuredContent and details string leaves", async () => {
	const state = createState();
	const handler = createToolResultHandler(state);
	const patch = await handler(
		{
			...TOOL_RESULT_EVENT,
			content: [{ type: "text", text: "VEGA_EMAIL=ivan@domeno.sh" }],
			structuredContent: { config: "SECRET_OF_SECRETS=hunter2123" },
			details: { note: "SECRET_OF_SECRETS=hunter2123" },
		} as unknown as ToolResultEvent,
		makeCtx([]),
	);
	assert.ok(patch);
	assert.deepEqual(patch.content, [{ type: "text", text: "VEGA_EMAIL=[REDACTED:VEGA_EMAIL]" }]);
	assert.deepEqual(patch.structuredContent, { config: "SECRET_OF_SECRETS=[REDACTED:SECRET_OF_SECRETS]" });
	assert.deepEqual(patch.details, { note: "SECRET_OF_SECRETS=[REDACTED:SECRET_OF_SECRETS]" });
	assert.equal(state.counters.get("SECRET_OF_SECRETS"), 2);
});

test("name-based fallback never touches tool_call input or assistant messages", async () => {
	const state = createState();
	const callEvent = {
		type: "tool_call",
		toolName: "bash",
		input: { command: "SECRET_OF_SECRETS=hunter2123" },
	} as unknown as ToolCallEvent;
	await createToolCallHandler(state)(callEvent, makeCtx([]));
	assert.equal((callEvent as unknown as { input: { command: string } }).input.command, "SECRET_OF_SECRETS=hunter2123");
	const messageEvent = {
		...MESSAGE_END_EVENT,
		message: { ...MESSAGE_END_EVENT.message, content: [{ type: "text", text: "SECRET_OF_SECRETS=hunter2123" }] },
	} as unknown as MessageEndEvent;
	assert.equal(await createMessageEndHandler(state)(messageEvent, makeCtx([])), undefined);
});

test("tool_call handler: redacts arguments in place, notifies once per key", async () => {
	const state = makeStateWithSecrets();
	const notified: string[] = [];
	const handler = createToolCallHandler(state);
	const event = {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command: `curl -H "Authorization: Bearer ${SECRET}"`, nested: { list: [`x ${OTHER}`] } },
	} as unknown as ToolCallEvent;
	assert.equal(await handler(event, makeCtx(notified)), undefined);
	assert.equal(await handler(event, makeCtx(notified)), undefined);
	const input = (event as unknown as { input: { command: string; nested: { list: string[] } } }).input;
	assert.ok(!input.command.includes(SECRET));
	assert.ok(input.command.includes("[REDACTED:LANGSEARCH_API_KEY]"));
	assert.equal(input.nested.list[0], "x [REDACTED:OTHER_TOKEN]");
	assert.deepEqual(notified, ["env-guard: redacted LANGSEARCH_API_KEY", "env-guard: redacted OTHER_TOKEN"]);
	assert.equal(state.counters.get("LANGSEARCH_API_KEY"), 1);
	assert.equal(state.counters.get("OTHER_TOKEN"), 1);
});

test("tool_call handler: no-op without matches and without secrets", async () => {
	const state = makeStateWithSecrets();
	const clean = { type: "tool_call", toolName: "bash", input: { command: "echo hi" } } as unknown as ToolCallEvent;
	assert.equal(await createToolCallHandler(state)(clean, makeCtx([])), undefined);
	const empty = createState();
	const event = {
		type: "tool_call",
		toolName: "bash",
		input: { command: `curl ${SECRET}` },
	} as unknown as ToolCallEvent;
	assert.equal(await createToolCallHandler(empty)(event, makeCtx([])), undefined);
	assert.equal((event as { input: { command: string } }).input.command, `curl ${SECRET}`);
});

test("tool_result handler: removed-and-re-added key notifies again after refresh", async () => {
	const state = createState();
	let dotenv = `LANGSEARCH_API_KEY=${SECRET}\n`;
	const dir = "/tmp/env-guard-refresh";
	const deps = {
		readFile: (async (path: string) => {
			if (path === join(resolve(dir), ".env")) return dotenv;
			throw new Error("missing");
		}) as never,
		env: {},
	};
	await refresh(state, dir, deps);
	const notified: string[] = [];
	const handler = createToolResultHandler(state);
	const event = { ...TOOL_RESULT_EVENT, structuredContent: undefined, details: undefined } as ToolResultEvent;
	await handler(event, makeCtx(notified));
	assert.deepEqual(notified, ["env-guard: redacted LANGSEARCH_API_KEY"]);
	dotenv = `OTHER_TOKEN=${OTHER}\n`;
	await refresh(state, dir, deps);
	dotenv = `LANGSEARCH_API_KEY=${SECRET}\n`;
	await refresh(state, dir, deps);
	await handler(event, makeCtx(notified));
	assert.deepEqual(notified, ["env-guard: redacted LANGSEARCH_API_KEY", "env-guard: redacted LANGSEARCH_API_KEY"]);
	assert.equal(state.counters.get("LANGSEARCH_API_KEY"), 2);
});

const MESSAGE_END_EVENT = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: `answer with ${SECRET}` }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 0,
	},
} as unknown as MessageEndEvent;

test("message_end handler: redacts finalized assistant message preserving role", async () => {
	const state = makeStateWithSecrets();
	const notified: string[] = [];
	const handler = createMessageEndHandler(state);
	const result = await handler(MESSAGE_END_EVENT, makeCtx(notified));
	assert.ok(result);
	assert.equal(result.message.role, "assistant");
	assert.deepEqual(result.message.content, [{ type: "text", text: "answer with [REDACTED:LANGSEARCH_API_KEY]" }]);
	assert.deepEqual(notified, ["env-guard: redacted LANGSEARCH_API_KEY"]);
});

test("message_end handler: skips user messages and empty state", async () => {
	const state = makeStateWithSecrets();
	const handler = createMessageEndHandler(state);
	const userEvent = {
		type: "message_end",
		message: { role: "user", content: SECRET, timestamp: 0 },
	} as unknown as MessageEndEvent;
	assert.equal(await handler(userEvent, makeCtx([])), undefined);
	const empty = createState();
	assert.equal(await createMessageEndHandler(empty)(MESSAGE_END_EVENT, makeCtx([])), undefined);
});

test("formatStatus: names and counts only, never values", () => {
	const state = makeStateWithSecrets();
	state.counters.set("LANGSEARCH_API_KEY", 2);
	const status = formatStatus(state);
	assert.ok(status.includes("2 secrets tracked"));
	assert.ok(status.includes("/tmp/proj/.env (2)"));
	assert.ok(status.includes("LANGSEARCH_API_KEY"));
	assert.ok(status.includes("LANGSEARCH_API_KEY x2"));
	assert.ok(!status.includes(SECRET));
	assert.ok(!status.includes(OTHER));
});

test("refresh: collects from files and env into state", async () => {
	const state = createState();
	const dir = resolve("/tmp/whatever");
	await refresh(state, "/tmp/whatever", {
		readFile: (async (path: string) => {
			if (path === join(dir, ".env")) return `LANGSEARCH_API_KEY=${SECRET}\nSHORT=abc\n`;
			throw new Error("missing");
		}) as never,
		env: { OTHER_TOKEN: OTHER, PATH: "C:\\Windows" },
	});
	assert.deepEqual(state.secrets, [
		{ key: "LANGSEARCH_API_KEY", value: SECRET },
		{ key: "OTHER_TOKEN", value: OTHER },
	]);
	assert.ok(state.redactor.regex);
});

test("collectSecrets: walks parent directories, dedupes, reports sources", async () => {
	const root = await mkdtemp(join(tmpdir(), "env-guard-"));
	try {
		const sub = join(root, "sub");
		const leaf = join(sub, "leaf");
		await mkdir(leaf, { recursive: true });
		await writeFile(join(root, ".env"), `ROOT_KEY=${SECRET}\nDUPE_KEY=${OTHER}\n`, "utf8");
		await writeFile(join(sub, ".env.local"), `export SUB_TOKEN=${OTHER}\nSHORT=abc\n`, "utf8");
		await writeFile(join(leaf, ".env.local"), `DUPE_KEY=${OTHER}\n`, "utf8");
		const collected = await collectSecrets(leaf, { env: {} });
		assert.deepEqual(collected.secrets, [
			{ key: "DUPE_KEY", value: OTHER },
			{ key: "SUB_TOKEN", value: OTHER },
			{ key: "ROOT_KEY", value: SECRET },
		]);
		const fileNames = collected.sources.files.map((file) => file.path);
		assert.ok(fileNames.includes(join(root, ".env")));
		assert.ok(fileNames.includes(join(sub, ".env.local")));
		assert.ok(fileNames.includes(join(leaf, ".env.local")));
		assert.deepEqual(collected.sources.envNames, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("collectSecrets: secret-named keys are tracked despite integer and url value shapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "env-guard-"));
	try {
		await writeFile(
			join(root, ".env"),
			"SOME_KEY=144888554\nVERY_SECRET_LINK=https://vega.domeno.sh/144888554/\nPORT=3000\nTIMEOUT=30\n",
			"utf8",
		);
		const collected = await collectSecrets(root, { env: {} });
		assert.deepEqual(collected.secrets, [
			{ key: "SOME_KEY", value: "144888554" },
			{ key: "VERY_SECRET_LINK", value: "https://vega.domeno.sh/144888554/" },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("collectSecrets: degenerate secret-named values are not collected and never become patterns", async () => {
	const root = await mkdtemp(join(tmpdir(), "env-guard-"));
	try {
		await writeFile(join(root, ".env"), "DEBUG_SECRET=true\nMY_SECRET=1\nNULL_KEY=null\nFLAG=false\n", "utf8");
		const collected = await collectSecrets(root, { env: {} });
		assert.deepEqual(collected.secrets, []);
		const redactor = buildRedactor(collected.secrets);
		assert.equal(redactor.regex, null);
		assert.equal(redactText("it was true and 1 here", redactor).changed, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("collectSecrets: unreadable files are skipped, env names matched", async () => {
	const collected = await collectSecrets("/nonexistent/env-guard", {
		env: {
			LANGSEARCH_API_KEY: SECRET,
			GITHUB_TOKEN: "gh-test-12345678",
			NUMBERS_TOKEN: "12345678",
			PLAIN_VALUE: "abcdefghijklmnop",
			PATH: "C:\\Windows",
			EMPTY_TOKEN: undefined,
		},
	});
	assert.deepEqual(collected.secrets, [
		{ key: "LANGSEARCH_API_KEY", value: SECRET },
		{ key: "GITHUB_TOKEN", value: "gh-test-12345678" },
		{ key: "NUMBERS_TOKEN", value: "12345678" },
	]);
	assert.deepEqual(collected.sources.envNames, ["LANGSEARCH_API_KEY", "GITHUB_TOKEN", "NUMBERS_TOKEN"]);
	assert.equal(collected.sources.files.length, 0);
});

test("rescan: reports added and removed keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "env-guard-"));
	try {
		await writeFile(join(root, ".env"), `FIRST_KEY=${SECRET}\n`, "utf8");
		const state = createState();
		const first = await rescan(state, root, { env: {} });
		assert.ok(first.includes("1 secret tracked"));
		assert.ok(first.includes("FIRST_KEY"));
		await writeFile(join(root, ".env"), `SECOND_KEY=${OTHER}\n`, "utf8");
		const second = await rescan(state, root, { env: {} });
		assert.ok(second.includes("added: SECOND_KEY"));
		assert.ok(second.includes("removed: FIRST_KEY"));
		const third = await rescan(state, root, { env: {} });
		assert.ok(third.includes("unchanged: 1"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
