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

const SESSION = [
	{ type: "session", version: 3, id: "s1", timestamp: "2026-09-05T12:00:00.000Z", cwd: "/x" },
	{
		type: "message",
		id: "u1",
		timestamp: "2026-09-05T12:00:01.000Z",
		message: { role: "user", content: "fix the bug" },
	},
	{
		type: "message",
		id: "a1",
		timestamp: "2026-09-05T12:00:05.000Z",
		message: {
			role: "assistant",
			model: "glm-5.3",
			usage: { input: 10, output: 5 },
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
		},
	},
]
	.map((e) => JSON.stringify(e))
	.join("\n");

test("web/app.js: boot() рисует ленту из /session.jsonl без исключений", async () => {
	const nodes = new Map<string, any>();
	const q = stub();
	q.value = ""; // пустой фильтр: заглушка иначе отфильтрует всё
	nodes.set("q", q);
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
		setInterval: () => 0,
		fetch: async (url: string) => ({
			ok: url === "session.jsonl",
			headers: { get: () => null },
			text: async () => SESSION,
			json: async () => ({}),
		}),
		console,
	};
	runInNewContext(readFileSync(APP_JS, "utf8"), sandbox, { filename: APP_JS });
	assert.ok(onReady, "app.js подписался на DOMContentLoaded");
	onReady!();
	await new Promise((r) => setTimeout(r, 20)); // дождаться цепочки fetch → load

	const html = String(nodes.get("timeline")?.innerHTML ?? "");
	assert.match(html, /id="t-1"/, "карточка T1 в ленте");
	assert.match(html, /fix the bug/, "user-сообщение в ленте");
});
