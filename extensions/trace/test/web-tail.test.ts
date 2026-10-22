/**
 * Живой хвост веб-вьюера (web/tail.js): ?from=<байт>, недописанная строка ждёт
 * конца, UTF-8 на стыке кусков, файл пересоздан короче — полная перезагрузка.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionTail } from "../web/tail.js";

const line = (e: object) => `${JSON.stringify(e)}\n`;
const SESSION =
	line({ type: "session", version: 3, id: "s1" }) +
	line({ type: "message", id: "u1", message: { role: "user", content: "fix" } });

/** Опрос, который обязан дойти до сервера. */
async function poll(tail: SessionTail) {
	const got = await tail.poll();
	assert.ok(got, "сервер ответил");
	return got;
}

/** Мок /session.jsonl с семантикой serve.ts. */
function server(data: () => Buffer, file = () => "a.jsonl") {
	const requests: string[] = [];
	const fetchFn = async (url: string) => {
		requests.push(url);
		const buf = data();
		let from = Number(/from=(\d+)/.exec(url)?.[1] ?? 0);
		if (from > buf.length) from = 0;
		const chunk = new Uint8Array(buf.subarray(from));
		return {
			ok: true,
			headers: {
				get: (h: string) => (h === "x-session-from" ? String(from) : h === "x-session-file" ? file() : null),
			},
			arrayBuffer: async () => chunk.buffer,
		};
	};
	return { fetchFn, requests };
}

test("SessionTail: первый опрос — весь файл, дальше только дописанное", async () => {
	let data = Buffer.from(SESSION);
	const { fetchFn, requests } = server(() => data);
	const tail = new SessionTail(fetchFn);
	const first = await poll(tail);
	assert.equal(first.reset, true);
	assert.equal(first.entries.length, 2);
	data = Buffer.concat([data, Buffer.from(line({ type: "label", id: "l" }))]);
	const next = await poll(tail);
	assert.equal(requests.at(-1), `session.jsonl?from=${Buffer.byteLength(SESSION)}`);
	assert.equal(next.reset, false);
	assert.deepEqual(
		next.entries.map((e: any) => e.id),
		["l"],
	);
});

test("SessionTail: недописанная строка ждёт конца, UTF-8 на стыке собирается", async () => {
	const more = Buffer.from(line({ type: "message", id: "u2", message: { role: "user", content: "ещё" } }));
	const half = more.indexOf(Buffer.from("щ")) + 1; // посреди двухбайтовой «щ»
	let data = Buffer.from(SESSION);
	const { fetchFn } = server(() => data);
	const tail = new SessionTail(fetchFn);
	await poll(tail);
	data = Buffer.concat([Buffer.from(SESSION), more.subarray(0, half)]);
	assert.equal((await poll(tail)).entries.length, 0, "полстроки не разбирается");
	data = Buffer.concat([Buffer.from(SESSION), more]);
	const got = (await poll(tail)).entries;
	assert.equal(got[0].message.content, "ещё");
});

test("SessionTail: файл короче прочитанного или другой файл — reset и вся сессия", async () => {
	let data = Buffer.from(SESSION);
	let name = "a.jsonl";
	const { fetchFn, requests } = server(
		() => data,
		() => name,
	);
	const tail = new SessionTail(fetchFn);
	await poll(tail);
	data = Buffer.from(line({ type: "message", id: "x", message: { role: "user", content: "fresh" } }));
	const shrunk = await poll(tail);
	assert.equal(shrunk.reset, true);
	assert.deepEqual(
		shrunk.entries.map((e: any) => e.id),
		["x"],
	);
	name = "b.jsonl";
	const switched = await poll(tail);
	assert.equal(switched.reset, true, "сервер переключён на другой файл");
	assert.equal(requests.at(-1), `session.jsonl?from=${data.length}`);
});
