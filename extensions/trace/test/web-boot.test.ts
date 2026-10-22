/**
 * Смоук веб-вьюера: web/app.js грузится в vm с заглушкой DOM, boot() отрабатывает
 * на ответе /session.jsonl, лента рисует карточки ходов. Ловит ReferenceError
 * на необъявленных переменных (selectedTurn жила в canvas-IIFE, а читалась из
 * draw() ленты — страница падала на старте и молча оставалась пустой).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const APP_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "app.js");

/** Duck-typed DOM-узел: присвоенные свойства хранятся, остальное — вложенная заглушка. */
function stub(): any {
	const store = new Map<PropertyKey, unknown>();
	const target = () => stub();
	return new Proxy(target, {
		get(_t, key) {
			if (key === Symbol.toPrimitive) return () => 0;
			if (key === "then") return undefined; // не thenable — иначе await зависнет
			if (!store.has(key)) store.set(key, stub());
			return store.get(key);
		},
		set(_t, key, value) {
			store.set(key, value);
			return true;
		},
		apply: () => stub(),
	});
}

const line = (e: object) => `${JSON.stringify(e)}\n`;
const SESSION = [
	line({ type: "session", version: 3, id: "s1", timestamp: "2026-09-05T12:00:00.000Z", cwd: "/x" }),
	line({
		type: "message",
		id: "u1",
		timestamp: "2026-09-05T12:00:01.000Z",
		message: { role: "user", content: "fix the bug" },
	}),
	line({
		type: "message",
		id: "a1",
		timestamp: "2026-09-05T12:00:05.000Z",
		message: {
			role: "assistant",
			model: "glm-5.3",
			usage: { input: 10, output: 5 },
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
		},
	}),
].join("");

/**
 * Мок /session.jsonl с семантикой web/serve.ts: ?from=<байт> — только хвост,
 * from за концом файла — весь файл с x-session-from: 0.
 */
function sessionResponse(url: string, session: Buffer, requests: string[]) {
	const m = /^session\.jsonl(?:\?from=(\d+))?$/.exec(url);
	if (!m) return { ok: false, headers: { get: () => null } };
	requests.push(url);
	let from = Number(m[1] ?? 0);
	if (from > session.length) from = 0;
	const chunk = new Uint8Array(session.subarray(from)); // копия: свой ArrayBuffer
	return {
		ok: true,
		headers: { get: (h: string) => (h === "x-session-from" ? String(from) : null) },
		arrayBuffer: async () => chunk.buffer,
	};
}

/** Поднимает app.js; session() — текущее содержимое /session.jsonl. */
async function boot(session: () => Buffer | string) {
	const requests: string[] = [];
	const nodes = new Map<string, any>();
	const q = stub();
	q.value = ""; // пустой фильтр: заглушка иначе отфильтрует всё
	nodes.set("q", q);
	const intervals: (() => void)[] = [];
	let onReady: (() => void) | undefined;
	const document = {
		getElementById: (id: string) => {
			if (!nodes.has(id)) nodes.set(id, stub());
			return nodes.get(id);
		},
		addEventListener: (type: string, fn: () => void) => {
			if (type === "DOMContentLoaded") onReady = fn;
		},
	};
	const sandbox = {
		document,
		window: { addEventListener() {}, devicePixelRatio: 1 },
		location: { search: "?noplay=1", hash: "#end" },
		performance: { now: () => 0 },
		requestAnimationFrame: () => 0,
		setInterval: (fn: () => void) => intervals.push(fn),
		fetch: async (url: string) => sessionResponse(url, Buffer.from(session()), requests),
		TextDecoder,
		console,
	};
	runInNewContext(readFileSync(APP_JS, "utf8"), sandbox, { filename: APP_JS });
	assert.ok(onReady, "app.js подписался на DOMContentLoaded");
	onReady!();
	await settle();
	/** Прогнать все setInterval-колбэки (опрос хвоста, воркеры, плеер). */
	const tickIntervals = async () => {
		for (const fn of intervals) fn();
		await settle();
	};
	return { nodes, tickIntervals, requests };
}

const settle = () => new Promise((r) => setTimeout(r, 20)); // цепочки fetch → load

test("web/app.js: boot() рисует ленту из /session.jsonl без исключений", async () => {
	const { nodes } = await boot(() => SESSION);
	const html = String(nodes.get("timeline")?.innerHTML ?? "");
	assert.match(html, /id="t-1"/, "карточка T1 в ленте");
	assert.match(html, /fix the bug/, "user-сообщение в ленте");
});

test("web/app.js: шкала ползунка растёт вместе с живой сессией", async () => {
	let text = SESSION;
	const { nodes, tickIntervals } = await boot(() => text);
	assert.equal(nodes.get("slider").max, "5000"); // 12:00:00 → 12:00:05
	text += line({ type: "message", timestamp: "2026-09-05T12:01:00.000Z", message: { role: "user", content: "more" } });
	await tickIntervals();
	assert.equal(nodes.get("slider").max, "60000");
});

test("web/app.js: живой хвост тянется по байтовому offset, недописанная строка ждёт конца", async () => {
	const next = Buffer.from(
		line({ type: "message", timestamp: "2026-09-05T12:01:00.000Z", message: { role: "user", content: "ещё" } }),
	);
	const half = next.indexOf(Buffer.from("щ")) + 1; // посреди двухбайтовой «щ»
	const size = Buffer.byteLength(SESSION);
	let data = Buffer.from(SESSION);
	const { nodes, tickIntervals, requests } = await boot(() => data);
	const feed = () => String(nodes.get("timeline").innerHTML);

	data = Buffer.concat([Buffer.from(SESSION), next.subarray(0, half)]);
	await tickIntervals();
	assert.equal(requests.at(-1), `session.jsonl?from=${size}`, "опрос просит только хвост");
	assert.doesNotMatch(feed(), /ещё/, "полстроки не рисуется");

	data = Buffer.concat([Buffer.from(SESSION), next]);
	await tickIntervals();
	assert.equal(requests.at(-1), `session.jsonl?from=${size + half}`);
	assert.match(feed(), /ещё/, "строка дописана — в ленте");
	assert.doesNotMatch(feed(), /�/, "без replacement-символов на стыке кусков");
});

test("web/app.js: файл пересоздан короче прочитанного — сессия перечитывается целиком", async () => {
	let data = Buffer.from(SESSION);
	const { nodes, tickIntervals, requests } = await boot(() => data);
	data = Buffer.from(
		line({ type: "message", timestamp: "2026-09-05T13:00:00.000Z", message: { role: "user", content: "fresh" } }),
	);
	await tickIntervals();
	assert.equal(requests.at(-1), "session.jsonl?from=0", "после сброса offset — полная перезагрузка");
	const html = String(nodes.get("timeline").innerHTML);
	assert.match(html, /fresh/);
	assert.doesNotMatch(html, /fix the bug/, "старая сессия не смешивается с новой");
});
