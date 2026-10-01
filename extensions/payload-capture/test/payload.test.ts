/**
 * Tests for payload-capture: redaction limits, arm-once semantics and the
 * save gate (nothing on disk without --save + trusted project; files only
 * under <agentDir>/cache/payload-captures/).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import install from "../index.ts";
import { MORE_ITEMS_MARKER, REDACTED_VALUE, isSensitiveKey, redactPayload } from "../redact.ts";
import { armPayload, captureFilePath, captureNextPayload, clearPayload, createPayloadState } from "../state.ts";

// ---------------------------------------------------------------------------
// redact.ts — pure redaction
// ---------------------------------------------------------------------------

test("redact: credential-поля маскируются, обычные остаются", () => {
	const payload = {
		model: "anthropic/claude-opus-4",
		temperature: 0.7,
		messages: [{ role: "user", content: "hello" }],
		apiKey: "sk-ant-live-123",
		Authorization: "Bearer abc",
		session_token: "t0k3n",
		clientSecret: "s3cr3t",
		nested: { user: { password: "p@ss" }, credentials: { password: "p@ss" }, safe: "keep me" },
		max_tokens: 4096,
	};
	const result = redactPayload(payload);
	const value = result.value as Record<string, unknown>;

	assert.equal(value.model, "anthropic/claude-opus-4");
	assert.equal(value.temperature, 0.7);
	assert.deepEqual(value.messages, [{ role: "user", content: "hello" }]);
	assert.equal(value.apiKey, REDACTED_VALUE);
	assert.equal(value.Authorization, REDACTED_VALUE);
	assert.equal(value.session_token, REDACTED_VALUE);
	assert.equal(value.clientSecret, REDACTED_VALUE);
	const nested = value.nested as Record<string, unknown>;
	assert.equal(nested.credentials, REDACTED_VALUE, "ключ credentials сам матчится — объект целиком");
	assert.equal(
		(nested.user as Record<string, unknown>).password as string,
		"p@ss",
		"regex из backlog не включает 'password' — матчатся только перечисленные подстроки",
	);
	assert.equal(nested.safe, "keep me");
	// Агрессивный regex из backlog: даже max_tokens содержит "token".
	assert.equal(value.max_tokens, REDACTED_VALUE);
	// Исходник не тронут.
	assert.equal(payload.apiKey, "sk-ant-live-123");
});

test("redact: результат — глубокая копия, не тот же объект", () => {
	const payload = { messages: [{ role: "user", content: "hi" }] };
	const copy = redactPayload(payload).value as typeof payload;
	assert.notEqual(copy, payload);
	assert.notEqual(copy.messages, payload.messages);
	// Мутация оригинала после redact не меняет копию (важно: payload живёт дальше в pi).
	payload.messages[0].content = "MUTATED";
	assert.equal((copy.messages[0] as { content: string }).content, "hi");
});

test("redact: лимиты глубины, массивов и ключей помечаются", () => {
	const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: "bottom" } } } } } } } } };
	const limited = redactPayload(deep, { maxDepth: 3 });
	const inner = limited.value as Record<string, unknown>;
	assert.equal(
		((inner.a as Record<string, unknown>).b as Record<string, unknown>).c,
		"[payload-capture: max depth reached]",
		"объект на глубине 3 заменён маркером",
	);
	assert.equal(limited.truncated, true);

	const bigArray = redactPayload({ items: Array.from({ length: 100 }, (_, i) => i) }, { maxArrayItems: 80 });
	const items = (bigArray.value as { items: unknown[] }).items;
	assert.equal(items.length, 81);
	assert.ok(String(items[80]).startsWith(MORE_ITEMS_MARKER));

	const wide = redactPayload(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i])));
	assert.ok(Object.keys(wide.value as object).some((k) => k.includes("more keys omitted")));
});

test("redact: длинные строки, base64-блобы и картинки заменяются маркерами", () => {
	// Пробел ломает base64-паттерн → срабатывает именно лимит длины строки.
	const long = redactPayload({ text: "x ".repeat(10_000) }, { maxStringLength: 12_000 });
	assert.ok(String((long.value as { text: string }).text).includes("string truncated from 20000 chars"));

	const b64 = redactPayload({ blob: "A".repeat(9_000) }, { maxBase64Length: 8_000 });
	assert.ok(String((b64.value as { blob: string }).blob).includes("base64-like data omitted"));

	const img = redactPayload({ img: "data:image/png;base64,AAAA" });
	assert.equal((img.value as { img: string }).img, "[payload-capture: image data omitted]");
});

test("redact: циклические ссылки и JSON-несовместимые типы не роняют обход", () => {
	const cyclic: Record<string, unknown> = { name: "root" };
	cyclic.self = cyclic;
	const result = redactPayload(cyclic);
	assert.equal((result.value as Record<string, unknown>).name, "root");
	assert.equal((result.value as Record<string, unknown>).self, "[payload-capture: circular reference]");

	const weird = redactPayload({ big: 10n, fn: () => 1, sym: Symbol("s"), n: undefined });
	const value = weird.value as Record<string, unknown>;
	assert.equal(value.big, "10n");
	assert.equal(value.fn, "[payload-capture: unserializable value omitted]");
	assert.equal(value.sym, "[payload-capture: unserializable value omitted]");
	assert.equal(value.n, "[payload-capture: unserializable value omitted]");
	// Текст остаётся валидным JSON.
	assert.doesNotThrow(() => JSON.parse(redactPayload(weird).text));
});

test("redact: итоговый текст обрезается на ~2 МБ с пометкой", () => {
	// 4×80 строк по ~10к символов: массивы/строки в пределах своих лимитов, сумма > 2 МБ.
	const huge = redactPayload({
		parts: Array.from({ length: 4 }, () => ({ items: Array.from({ length: 80 }, () => "y ".repeat(5_000)) })),
	});
	assert.equal(huge.truncated, true);
	assert.ok(huge.bytes <= 2 * 1024 * 1024 + 200, `bytes=${huge.bytes}`);
	assert.ok(huge.text.includes("payload truncated"));
});

test("redact: isSensitiveKey следует backlog-regex", () => {
	for (const key of [
		"apiKey",
		"api_key",
		"API-KEY",
		"token",
		"access_token",
		"SECRET",
		"clientCredentials",
		"authorization",
		"proxy-authorization",
	]) {
		assert.equal(isSensitiveKey(key), true, key);
	}
	for (const key of ["model", "messages", "temperature", "stream", "maxItems"]) {
		assert.equal(isSensitiveKey(key), false, key);
	}
});

// ---------------------------------------------------------------------------
// state.ts — arm-once
// ---------------------------------------------------------------------------

test("state: arm-once — первый запрос захватывается, второй нет", () => {
	const state = createPayloadState();
	armPayload(state, false);

	const first = captureNextPayload(state, { n: 1 }, { model: "prov/m1", ts: "2026-09-30T12:00:00.000Z" });
	assert.equal(first.captured, true);
	assert.equal(first.saveRequested, false);
	assert.equal(state.armed, false, "после захвата должно разоружиться");
	assert.equal(state.lastCapture?.payload && (state.lastCapture.payload as { n: number }).n, 1);

	const second = captureNextPayload(state, { n: 2 }, { model: "prov/m1" });
	assert.equal(second.captured, false);
	assert.equal((state.lastCapture!.payload as { n: number }).n, 1, "последний захват не перезаписан");
	assert.equal(state.armed, false);
});

test("state: захват применяет redaction и сохраняет saveRequested", () => {
	const state = createPayloadState();
	armPayload(state, true);
	const outcome = captureNextPayload(
		state,
		{ messages: [], apiKey: "leak" },
		{ model: "prov/m2", ts: "2026-09-30T12:00:00.000Z" },
	);
	assert.equal(outcome.captured, true);
	assert.equal(outcome.saveRequested, true);
	assert.equal((state.lastCapture!.payload as { apiKey: string }).apiKey, REDACTED_VALUE);
	assert.equal(state.lastCapture!.model, "prov/m2");
	assert.equal(state.lastCapture!.ts, "2026-09-30T12:00:00.000Z");
});

test("state: clearPayload полностью сбрасывает", () => {
	const state = createPayloadState();
	armPayload(state, true);
	captureNextPayload(state, { a: 1 }, { model: "m" });
	clearPayload(state);
	assert.deepEqual(state, { armed: false, save: false, lastCapture: undefined });
});

test("state: captureFilePath санитизирует ts и model", () => {
	const file = captureFilePath("/agent/cache/payload-captures", {
		ts: "2026-09-30T17:08:33.123Z",
		model: "zai/glm-5.3:thinking",
	});
	assert.match(file, /\/2026-09-30T17-08-33-123Z-zai-glm-5\.3-thinking\.json$/);
});

// ---------------------------------------------------------------------------
// index.ts — команда /payload и гейт сохранения (mock pi, tmp agentDir)
// ---------------------------------------------------------------------------

interface TestHarness {
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	command: { handler: (args: string, ctx: unknown) => Promise<void> };
	notifications: { message: string; type: string }[];
	statuses: (string | undefined)[];
	makeCtx: (opts?: { trusted?: boolean; hasUI?: boolean }) => unknown;
	agentDir: string;
	capturesDir: string;
}

function setupHarness(): TestHarness {
	const agentDir = mkdtempSync(join(tmpdir(), "payload-capture-test-"));
	const capturesDir = join(agentDir, "cache", "payload-captures");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const notifications: { message: string; type: string }[] = [];
	const statuses: (string | undefined)[] = [];

	install({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (_name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			command = cmd;
		},
	} as never); // mock ExtensionAPI: нужны только on/registerCommand

	const makeCtx = (opts: { trusted?: boolean; hasUI?: boolean } = {}) => ({
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type: type ?? "info" }),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			editor: async (title: string, prefill?: string) => prefill ?? title,
		},
		hasUI: opts.hasUI ?? false,
		isProjectTrusted: () => opts.trusted ?? false,
		model: undefined,
		cwd: process.cwd(),
		mode: "test",
	});

	return { handlers, command: command!, notifications, statuses, makeCtx, agentDir, capturesDir };
}

function cleanupHarness(h: TestHarness) {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(h.agentDir, { recursive: true, force: true });
}

test("index: arm --save без доверия — файла нет, уведомление об игноре save", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx({ trusted: false });
		await h.command.handler("arm --save", ctx);
		const onRequest = h.handlers.get("before_provider_request")!;
		const payload = { messages: [{ role: "user", content: "hi" }], apiKey: "sk-live" };
		const before = JSON.stringify(payload);
		const result = onRequest({ type: "before_provider_request", payload }, ctx);

		assert.equal(result, undefined, "handler не должен заменять payload");
		assert.equal(JSON.stringify(payload), before, "исходный payload не изменён");
		assert.ok(h.notifications.some((n) => /не доверенный|NOT/i.test(n.message)));
		assert.ok(!existsSync(h.capturesDir), "в trusted=false каталог сохранений не создаётся");
	} finally {
		cleanupHarness(h);
	}
});

test("index: arm --save + trusted — один redacted-файл в agentDir, не в cwd", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx({ trusted: true });
		await h.command.handler("arm --save", ctx);
		const onRequest = h.handlers.get("before_provider_request")!;
		onRequest({ type: "before_provider_request", payload: { messages: [], apiKey: "sk-live", model: "gpt" } }, ctx);

		assert.ok(existsSync(h.capturesDir));
		const files = readdirSync(h.capturesDir);
		assert.equal(files.length, 1);
		assert.match(files[0], /\.json$/);
		const saved = JSON.parse(readFileSync(join(h.capturesDir, files[0]), "utf8"));
		assert.equal(saved.payload.apiKey, REDACTED_VALUE);
		assert.deepEqual(saved.payload.messages, []);
		assert.ok(!existsSync(join(process.cwd(), "cache", "payload-captures")), "никогда не в cwd проекта");
		assert.ok(h.statuses.some((s) => s?.includes("payload:captured")));
	} finally {
		cleanupHarness(h);
	}
});

test("index: arm без --save — захват в память, файлов нет", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx({ trusted: true });
		await h.command.handler("arm", ctx);
		const onRequest = h.handlers.get("before_provider_request")!;
		onRequest({ type: "before_provider_request", payload: { secret: "x" } }, ctx);

		assert.equal(existsSync(h.capturesDir), false, "без --save на диск не пишем");
		assert.ok(h.statuses.some((s) => s?.includes("payload:captured")));
	} finally {
		cleanupHarness(h);
	}
});

test("index: arm-once через /payload — второй provider-запрос не захватывается", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx({ trusted: true });
		await h.command.handler("arm", ctx);
		const onRequest = h.handlers.get("before_provider_request")!;
		onRequest({ type: "before_provider_request", payload: { n: 1 } }, ctx);
		onRequest({ type: "before_provider_request", payload: { n: 2 } }, ctx);

		const capturedNotices = h.notifications.filter((n) => /захвачено/i.test(n.message));
		assert.equal(capturedNotices.length, 1, "ровно один захват на один arm");
		await h.command.handler("show", ctx); // hasUI=false → console.log, не должно падать
	} finally {
		cleanupHarness(h);
	}
});

test("index: /payload clear снимает чип и сбрасывает захват", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx({ trusted: true });
		await h.command.handler("arm", ctx);
		h.handlers.get("before_provider_request")!({ type: "before_provider_request", payload: {} }, ctx);
		await h.command.handler("clear", ctx);
		assert.ok(h.statuses.includes(undefined), "чип снят setStatus(key, undefined)");

		// После clear повторный захват не начнётся: show предупреждает о пустом состоянии.
		await h.command.handler("show", ctx);
		assert.ok(h.notifications.some((n) => n.type === "warning" && /захватов ещё нет/i.test(n.message)));
	} finally {
		cleanupHarness(h);
	}
});

test("index: /payload без аргументов и /payload help — подсказка; неизвестное — warning", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx();
		await h.command.handler("", ctx);
		assert.ok(h.notifications.some((n) => /использование|arm/i.test(n.message)));
		h.notifications.length = 0;
		await h.command.handler("help", ctx);
		assert.ok(h.notifications.length === 0, "help идёт в editor/console, а не в notify");
		h.notifications.length = 0;
		await h.command.handler("frobnicate", ctx);
		assert.ok(h.notifications.some((n) => n.type === "warning"));
	} finally {
		cleanupHarness(h);
	}
});

test("index: session_shutdown разоружает захват — в новой сессии выстрела нет", async () => {
	const h = setupHarness();
	try {
		const ctx = h.makeCtx({ hasUI: true });
		await h.command.handler("arm", ctx);
		const shutdown = h.handlers.get("session_shutdown")!;
		shutdown({ type: "session_shutdown" }, ctx);
		// чип снят
		assert.equal(h.statuses[h.statuses.length - 1], undefined);
		// вооружения больше нет: запрос проходит насквозь, захвата нет
		const onRequest = h.handlers.get("before_provider_request")!;
		const result = onRequest({ type: "before_provider_request", payload: { model: "m", messages: [] } }, ctx);
		assert.equal(result, undefined);
		assert.ok(
			!h.notifications.some((n) => n.message.includes("захвачено")),
			"захват не должен сработать после shutdown",
		);
	} finally {
		cleanupHarness(h);
	}
});
