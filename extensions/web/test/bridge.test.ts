/**
 * Integration tests for the WS bridge server (plan §4, task B2): a REAL
 * server bound to port 0 (OS-assigned, no conflicts) plus real `ws`
 * clients speaking protocol v1. The kernel timers run for real — the
 * config below shortens the TTLs (grace 200ms, job 400ms) so every
 * failure path waits at most ~1s instead of the production 10s/45s.
 *
 * Covered: origin filter (evil page 403, extension origin passes), hello
 * auth (wrong token → hello_err+close, right token → hello_ok), ban after
 * 3 auth failures, framing diagnostics (bad JSON, wrong version), app
 * ping→pong, job delivery → result mapping (including the server-side
 * min-length gate and maxChars re-check), client death mid-job → null
 * after TTL, zero clients → null after grace, late results → ignored +
 * error/unknown-id, abort → immediate null, port exhaustion → disabled
 * handle, token-file pairing (generate + persist + reuse), and idempotent
 * close releasing the port.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import {
	MIN_MARKDOWN_LENGTH,
	type BridgeMessage,
	type ErrorMsg,
	type HelloReplyMsg,
	type JobMsg,
	type PongMsg,
	type ResultMsg,
} from "../fetch/bridge-protocol.ts";
import {
	parsePortRange,
	readBridgeConfig,
	resolveTokenFilePath,
	startBridge,
	type BridgeConfig,
} from "../fetch/bridge.ts";

const TOKEN = "test-token";
const URL_A = "https://example.com/article";

type HelloErr = Extract<HelloReplyMsg, { type: "hello_err" }>;

/** Real timers, but production TTLs shortened to keep the suite fast. */
function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		ports: [0],
		token: TOKEN,
		tokenFile: join(tmpdir(), "bridge-test-unused-token"),
		graceMs: 200,
		jobTimeoutMs: 400,
		...overrides,
	};
}

function helloMsg(token: string = TOKEN): BridgeMessage {
	return {
		v: 1,
		type: "hello",
		token,
		client: "pi-web-companion",
		clientVersion: "test",
	};
}

/**
 * Minimal ws client harness: collects protocol frames, answers
 * per-predicate waits, and exposes the close event as a promise.
 */
class TestClient {
	readonly ws: WebSocket;
	readonly received: BridgeMessage[] = [];
	readonly closed: Promise<{ code: number; reason: string }>;
	readonly open: Promise<void>;
	#waiters: Array<{
		match: (message: BridgeMessage) => boolean;
		resolve: (message: BridgeMessage) => void;
	}> = [];

	constructor(port: number, headers: Record<string, string> = {}) {
		this.ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
		this.open = new Promise((resolve, reject) => {
			this.ws.once("open", resolve);
			this.ws.once("error", reject);
		});
		this.closed = new Promise((resolve) => {
			this.ws.on("close", (code, reason) =>
				resolve({ code, reason: reason.toString() }),
			);
		});
		this.ws.on("message", (data) => {
			const message = JSON.parse(String(data)) as BridgeMessage;
			const waiter = this.#waiters.findIndex((w) => w.match(message));
			if (waiter >= 0) this.#waiters.splice(waiter, 1)[0].resolve(message);
			else this.received.push(message);
		});
	}

	send(message: object): void {
		this.ws.send(JSON.stringify(message));
	}

	/** Say hello with `token` and await the server's verdict. */
	async hello(
		token = TOKEN,
	): Promise<Extract<BridgeMessage, { type: "hello_ok" | "hello_err" }>> {
		await this.open;
		this.send(helloMsg(token));
		return this.next(
			(message) => message.type === "hello_ok" || message.type === "hello_err",
		);
	}

	/** Next message matching the predicate (scans the backlog first). */
	async next<T extends BridgeMessage>(
		match: (message: BridgeMessage) => boolean,
		ms = 2_000,
	): Promise<T> {
		const index = this.received.findIndex(match);
		if (index >= 0) return this.received.splice(index, 1)[0] as T;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for a message")),
				ms,
			);
			this.#waiters.push({
				match,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message as T);
				},
			});
		});
	}

	close(): void {
		this.ws.close();
	}
}

const isJob = (m: BridgeMessage): boolean => m.type === "job";
const isError = (m: BridgeMessage): boolean => m.type === "error";

const LONG_MARKDOWN = `${"# Long enough\n\n".repeat(10)}body text`.slice(
	0,
	MIN_MARKDOWN_LENGTH + 20,
);
const OK_RESULT = (
	id: string,
	markdown = LONG_MARKDOWN,
): ResultMsg => ({
	v: 1,
	type: "result",
	id,
	ok: true,
	markdown,
	title: "Example",
	finalUrl: "https://example.com/final",
});

// ── handshake ──────────────────────────────────────────────────────

test("wrong token → hello_err(auth) and close", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		const reply = await client.hello("wrong-token");
		assert.equal(reply.type, "hello_err");
		if (reply.type === "hello_err") assert.equal(reply.reason, "auth");
		const closing = await client.closed;
		assert.equal(closing.code, 1008); // policy violation
	} finally {
		await bridge.close();
	}
});

test("correct token → hello_ok and the client is counted", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		const reply = await client.hello();
		assert.equal(reply.type, "hello_ok");
		if (reply.type === "hello_ok") {
			assert.equal(reply.server, "pi-web");
			assert.ok(reply.serverVersion.length > 0);
		}
		assert.equal(bridge.clients(), 1);
		client.close();
	} finally {
		await bridge.close();
	}
});

test("evil web Origin is rejected with 403 at upgrade", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const evil = new TestClient(bridge.port, {
			origin: "https://evil.example",
		});
		await assert.rejects(evil.open, /403/);
		assert.equal(bridge.clients(), 0);
	} finally {
		await bridge.close();
	}
});

test("extension origins pass the origin filter to token auth", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		for (const origin of [
			"chrome-extension://abcdefghijklmnop",
			"moz-extension://uuid-here",
		]) {
			const client = new TestClient(bridge.port, { origin });
			const reply = await client.hello();
			assert.equal(reply.type, "hello_ok");
			client.close();
		}
	} finally {
		await bridge.close();
	}
});

test("three auth failures from one IP → ban (even the right token is 403)", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const offender = new TestClient(bridge.port);
			const reply = await offender.hello("bad");
			assert.equal(reply.type, "hello_err");
			await offender.closed;
		}
		const victim = new TestClient(bridge.port);
		await assert.rejects(victim.open, /403/);
	} finally {
		await bridge.close();
	}
});

test("bad JSON before hello → error(bad-json) and close", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.open;
		client.ws.send("this is not json");
		const error = await client.next<ErrorMsg>(isError);
		assert.equal(error.reason, "bad-json");
		const closing = await client.closed;
		assert.equal(closing.code, 1002);
	} finally {
		await bridge.close();
	}
});

test("wrong protocol version before hello → hello_err(version) and close", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.open;
		client.send({ ...helloMsg(), v: 99 });
		const reply = await client.next<HelloErr>((m) => m.type === "hello_err");
		assert.equal(reply.reason, "version");
		await client.closed;
	} finally {
		await bridge.close();
	}
});

test("app-level ping → pong echoes ts", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		client.send({ v: 1, type: "ping", ts: 1_234 });
		const pong = await client.next<PongMsg>((m) => m.type === "pong");
		assert.equal(pong.ts, 1_234);
		client.close();
	} finally {
		await bridge.close();
	}
});

// ── job round-trip ─────────────────────────────────────────────────

test("job → ok result resolves the render promise (wire → RenderResult)", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const rendering = bridge.render(URL_A);
		const job = (await client.next(isJob)) as JobMsg;
		assert.equal(job.url, URL_A);
		assert.equal(job.timeoutMs, 400); // from the test config
		assert.ok(job.maxChars >= MIN_MARKDOWN_LENGTH);
		client.send(OK_RESULT(job.id));
		assert.deepEqual(await rendering, {
			markdown: LONG_MARKDOWN,
			title: "Example",
			finalUrl: "https://example.com/final",
		});
		client.close();
	} finally {
		await bridge.close();
	}
});

test("markdown shorter than MIN_MARKDOWN_LENGTH fails as unreadable → null", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const rendering = bridge.render(URL_A);
		const job = (await client.next(isJob)) as JobMsg;
		client.send(OK_RESULT(job.id, "log in please"));
		assert.equal(await rendering, null);
		client.close();
	} finally {
		await bridge.close();
	}
});

test("ok:false result maps to null", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const rendering = bridge.render(URL_A);
		const job = (await client.next(isJob)) as JobMsg;
		client.send({
			v: 1,
			type: "result",
			id: job.id,
			ok: false,
			reason: "navigation-failed",
		} satisfies ResultMsg);
		assert.equal(await rendering, null);
		client.close();
	} finally {
		await bridge.close();
	}
});

test("maxChars is re-checked server-side (client truncation not trusted)", async () => {
	const bridge = await startBridge(bridgeConfig({ maxChars: 50 }));
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const rendering = bridge.render(URL_A);
		const job = (await client.next(isJob)) as JobMsg;
		assert.equal(job.maxChars, 50);
		client.send(OK_RESULT(job.id, "x".repeat(MIN_MARKDOWN_LENGTH + 80)));
		const render = await rendering;
		assert.equal(render?.markdown.length, 50);
		client.close();
	} finally {
		await bridge.close();
	}
});

test("client dying mid-job → null after the job TTL", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const rendering = bridge.render(URL_A);
		await client.next(isJob); // job assigned…
		client.ws.terminate(); // …then the client vanishes
		assert.equal(await rendering, null); // TTL (400ms) settles it
	} finally {
		await bridge.close();
	}
});

test("render with zero clients → null after the grace window", async () => {
	const bridge = await startBridge(bridgeConfig());
	const rendering = bridge.render(URL_A); // nobody will ever connect
	assert.equal(await rendering, null); // graceMs (200ms) settles it
	await bridge.close();
});

test("result arriving after the TTL is ignored: error(unknown-id), promise stays null", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const rendering = bridge.render(URL_A);
		const job = (await client.next(isJob)) as JobMsg;
		assert.equal(await rendering, null); // TTL already settled it
		client.send(OK_RESULT(job.id)); // late result must not touch it
		const error = await client.next<ErrorMsg>(isError);
		assert.equal(error.reason, "unknown-id");
		assert.equal(error.detail, job.id);
		client.close();
	} finally {
		await bridge.close();
	}
});

test("render(url, signal) aborts the job immediately → null", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		const client = new TestClient(bridge.port);
		await client.hello();
		const controller = new AbortController();
		const rendering = bridge.render(URL_A, controller.signal);
		const job = (await client.next(isJob)) as JobMsg;
		controller.abort();
		assert.equal(await rendering, null);
		// The client never learns of the abort; its late result lands on
		// error/unknown-id.
		client.send(OK_RESULT(job.id));
		const error = await client.next<ErrorMsg>(isError);
		assert.equal(error.reason, "unknown-id");
		client.close();
	} finally {
		await bridge.close();
	}
});

// ── ports, pairing, lifecycle ──────────────────────────────────────

test("every port taken → disabled handle (never throws), render → null", async () => {
	const holder = await startBridge(bridgeConfig());
	try {
		const bridge = await startBridge(
			bridgeConfig({ ports: [holder.port] }),
		);
		assert.equal(bridge.status, "disabled");
		assert.match(bridge.disabledReason ?? "", /no free port/);
		assert.equal(bridge.port, 0);
		assert.equal(bridge.clients(), 0);
		assert.equal(await bridge.render(URL_A), null);
		await bridge.close(); // disabled close is a no-op
	} finally {
		await holder.close();
	}
});

test("the range is tried in order: taken port skipped, 0 binds", async () => {
	const holder = await startBridge(bridgeConfig());
	try {
		const bridge = await startBridge(
			bridgeConfig({ ports: [holder.port, 0] }),
		);
		assert.equal(bridge.status, "listening");
		assert.notEqual(bridge.port, holder.port);
		await bridge.close();
	} finally {
		await holder.close();
	}
});

test("port 0 yields the OS-assigned port in the handle", async () => {
	const bridge = await startBridge(bridgeConfig());
	try {
		assert.equal(bridge.status, "listening");
		assert.ok(bridge.port >= 1024 && bridge.port <= 65535);
	} finally {
		await bridge.close();
	}
});

test("token pairing: missing file → generated, persisted, reused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-token-"));
	const file = join(dir, "nested", "web-bridge-token"); // exercises mkdir -p
	try {
		const first = await startBridge(
			bridgeConfig({ token: undefined, tokenFile: file }),
		);
		const stored = readFileSync(file, "utf8").trim();
		// crypto.randomBytes(32) → base64url: 43 chars from the url-safe alphabet.
		assert.equal(stored.length, 43);
		assert.match(stored, /^[A-Za-z0-9_-]+$/);

		// A second bridge reading the same file pairs with the same token…
		const second = await startBridge(
			bridgeConfig({ token: undefined, tokenFile: file }),
		);
		const client = new TestClient(second.port);
		const reply = await client.hello(stored);
		assert.equal(reply.type, "hello_ok");
		client.close();

		// …and the first bridge accepts it too.
		const clientOnFirst = new TestClient(first.port);
		const replyOnFirst = await clientOnFirst.hello(stored);
		assert.equal(replyOnFirst.type, "hello_ok");
		clientOnFirst.close();

		await first.close();
		await second.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("close() is idempotent and releases the port", async () => {
	const bridge = await startBridge(bridgeConfig());
	await bridge.close();
	await bridge.close(); // second call: no throw
	assert.equal(await bridge.render(URL_A), null);
	// The port is actually free again: a fresh bridge binds it.
	const reborn = await startBridge(bridgeConfig({ ports: [bridge.port] }));
	assert.equal(reborn.status, "listening");
	await reborn.close();
});

// ── config helpers ─────────────────────────────────────────────────

test("parsePortRange: ranges, single ports, and validation", () => {
	assert.deepEqual(parsePortRange("8790-8799"), [8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799]);
	assert.deepEqual(parsePortRange(" 8800 "), [8800]);
	assert.deepEqual(parsePortRange("1024-1026"), [1024, 1025, 1026]);
	assert.deepEqual(parsePortRange("65534-65535"), [65534, 65535]);
	assert.throws(() => parsePortRange("abc"));
	assert.throws(() => parsePortRange("8790-")); // regex: no
	assert.throws(() => parsePortRange("-1"));
	assert.throws(() => parsePortRange("1023-1030")); // below 1024
	assert.throws(() => parsePortRange("65536")); // above 65535
	assert.throws(() => parsePortRange("8799-8790")); // from > to
});

test("readBridgeConfig: port/env priorities with default fallbacks", () => {
	const one = readBridgeConfig({ PI_WEB_BRIDGE_PORT: "9001" });
	assert.deepEqual(one.ports, [9001]);

	const range = readBridgeConfig({ PI_WEB_BRIDGE_PORTS: "9002-9004" });
	assert.deepEqual(range.ports, [9002, 9003, 9004]);

	// PI_WEB_BRIDGE_PORT wins over PI_WEB_BRIDGE_PORTS.
	const both = readBridgeConfig({
		PI_WEB_BRIDGE_PORT: "9001",
		PI_WEB_BRIDGE_PORTS: "9002-9004",
	});
	assert.deepEqual(both.ports, [9001]);

	const defaults = readBridgeConfig({});
	assert.deepEqual(defaults.ports, parsePortRange("8790-8799"));
	assert.equal(defaults.tokenFile, resolveTokenFilePath());

	// An invalid value degrades to the default range instead of throwing.
	const invalid = readBridgeConfig({ PI_WEB_BRIDGE_PORT: "not-a-port" });
	assert.deepEqual(invalid.ports, parsePortRange("8790-8799"));

	const tokens = readBridgeConfig({
		PI_WEB_BRIDGE_TOKEN: "inline",
		PI_WEB_BRIDGE_TOKEN_FILE: "C:\\somewhere\\token",
	});
	assert.equal(tokens.token, "inline");
	assert.equal(tokens.tokenFile, "C:\\somewhere\\token");
});
