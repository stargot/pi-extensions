import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BRIDGE_GRACE_MS,
	DEFAULT_PORT_RANGE,
	JOB_TIMEOUT_MS,
	MAX_CHARS,
	MIN_MARKDOWN_LENGTH,
	PING_INTERVAL_MS,
	PROTOCOL_VERSION,
	SERVER_PING_INTERVAL_MS,
	parseBridgeMessage,
	type BridgeMessage,
} from "../fetch/bridge-protocol.ts";

test("protocol constants match the plan §2/§3 defaults", () => {
	assert.equal(PROTOCOL_VERSION, 1);
	assert.equal(DEFAULT_PORT_RANGE, "8790-8799");
	assert.equal(JOB_TIMEOUT_MS, 45_000);
	assert.equal(BRIDGE_GRACE_MS, 10_000);
	assert.equal(MAX_CHARS, 1_000_000);
	assert.equal(MIN_MARKDOWN_LENGTH, 100);
	// Heartbeat: client app-ping 20s, server ws-ping 30s (plan §3).
	assert.equal(PING_INTERVAL_MS, 20_000);
	assert.equal(SERVER_PING_INTERVAL_MS, 30_000);
});

test("parseBridgeMessage: every message type parses", () => {
	const samples: BridgeMessage[] = [
		{
			v: 1,
			type: "hello",
			token: "secret",
			client: "pi-web-companion",
			clientVersion: "0.1.0",
		},
		{
			v: 1,
			type: "result",
			id: "j1",
			ok: true,
			markdown: "# Heading\n\nBody text.",
			title: "Example",
			finalUrl: "https://example.com/redirected",
		},
		{
			v: 1,
			type: "result",
			id: "j1",
			ok: false,
			reason: "timeout",
			message: "page load exceeded 30s",
		},
		{ v: 1, type: "ping", ts: 1_768_700_000_000 },
		{ v: 1, type: "hello_ok", server: "pi-web", serverVersion: "0.2.0" },
		{ v: 1, type: "hello_err", reason: "auth", detail: "token mismatch" },
		{
			v: 1,
			type: "job",
			id: "0f0c9b1e-1d2e-4f3a-8b4c-5d6e7f8091a2",
			url: "https://example.com/page",
			timeoutMs: 45_000,
			maxChars: 1_000_000,
		},
		{ v: 1, type: "pong", ts: 1_768_700_000_000 },
		{ v: 1, type: "error", reason: "unknown-id" },
	];
	for (const sample of samples) {
		assert.deepEqual(parseBridgeMessage(JSON.stringify(sample)), sample, sample.type);
	}
});

test("parseBridgeMessage: result ok:false parses for each failure reason", () => {
	for (const reason of [
		"timeout",
		"navigation-failed",
		"render-failed",
		"unreadable",
	] as const) {
		const wire = { v: 1, type: "result", id: "j1", ok: false, reason };
		assert.deepEqual(parseBridgeMessage(JSON.stringify(wire)), wire, reason);
	}
});

test("parseBridgeMessage: broken JSON → null", () => {
	assert.equal(parseBridgeMessage("{not json"), null);
	assert.equal(parseBridgeMessage(""), null);
	assert.equal(parseBridgeMessage('{"v":1,"type":"ping",'), null);
	assert.equal(parseBridgeMessage('{"v":1,"type":"ping"}trailing'), null);
});

test("parseBridgeMessage: wrong protocol version → null", () => {
	assert.equal(parseBridgeMessage('{"v":2,"type":"ping","ts":1}'), null);
	// String "1" is not the number 1 — v must match strictly.
	assert.equal(parseBridgeMessage('{"v":"1","type":"ping","ts":1}'), null);
	assert.equal(parseBridgeMessage('{"type":"ping","ts":1}'), null);
});

test("parseBridgeMessage: unknown type → null", () => {
	assert.equal(parseBridgeMessage('{"v":1,"type":"hello2","token":"t"}'), null);
	assert.equal(parseBridgeMessage('{"v":1,"type":"PING","ts":1}'), null);
	assert.equal(parseBridgeMessage('{"v":1,"type":""}'), null);
	assert.equal(parseBridgeMessage('{"v":1}'), null);
});

test("parseBridgeMessage: non-object payloads → null", () => {
	for (const raw of ["null", "42", "-0.5", '"ping"', "true", "[]", '[{"v":1,"type":"ping"}]']) {
		assert.equal(parseBridgeMessage(raw), null, raw);
	}
});

test("parseBridgeMessage: never throws, deep fields are not validated", () => {
	// Wrong-typed fields pass the shallow envelope check — validating them
	// is the consumer's job; the parser only guarantees type discrimination.
	const loose = '{"v":1,"type":"job","id":42,"url":null,"timeoutMs":"x"}';
	const parsed = parseBridgeMessage(loose);
	assert.ok(parsed && parsed.type === "job");
});
