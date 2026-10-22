import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isLoopbackHost, newestSession, startServer } from "../web/serve.ts";

test("serve.ts serves static files and the session file, /load switches it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-web-"));
	try {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, '{"type":"session","version":3,"id":"a","timestamp":"2026-09-05T12:00:00.000Z","cwd":"/x"}\n');
		writeFileSync(b, '{"type":"session","version":3,"id":"b","timestamp":"2026-09-05T13:00:00.000Z","cwd":"/y"}\n');
		const handle = await startServer({ file: a, port: 0 });
		try {
			const indexRes = await fetch(`${handle.url}`);
			assert.equal(indexRes.headers.get("cache-control"), "no-cache", "статика ревалидируется после обновления");
			const index = await indexRes.text();
			assert.ok(index.includes("<!DOCTYPE") || index.includes("trace"));

			const first = await fetch(`${handle.url}session.jsonl`);
			assert.equal(first.status, 200);
			assert.ok((await first.text()).includes('"id":"a"'));

			const load = await fetch(`${handle.url}load`, { method: "POST", body: JSON.stringify({ file: b }) });
			assert.equal(load.status, 200);
			assert.ok((await fetch(`${handle.url}session.jsonl`).then((r) => r.text())).includes('"id":"b"'));

			// Чужая страница в браузере (Origin) не может переключать файл
			const csrf = await fetch(`${handle.url}load`, {
				method: "POST",
				headers: { origin: "http://evil.example" },
				body: JSON.stringify({ file: a }),
			});
			assert.equal(csrf.status, 403);

			assert.equal((await fetch(`${handle.url}nope`)).status, 404);
			assert.equal((await fetch(`${handle.url}../serve.ts`)).status, 404);
		} finally {
			await handle.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** GET с произвольным Host: fetch не даёт его переопределить. */
function getWithHost(port: number, path: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

test("serve.ts rejects a non-loopback Host (DNS rebinding) and an oversized /load body", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-host-"));
	try {
		const a = join(dir, "a.jsonl");
		writeFileSync(a, '{"type":"session","version":3,"id":"a","timestamp":"2026-09-05T12:00:00.000Z","cwd":"/x"}\n');
		const handle = await startServer({ file: a, port: 0 });
		try {
			assert.equal(await getWithHost(handle.port, "/session.jsonl", `evil.example:${handle.port}`), 403);
			assert.equal(await getWithHost(handle.port, "/session.jsonl", `localhost:${handle.port}`), 200);

			const big = await fetch(`${handle.url}load`, {
				method: "POST",
				body: JSON.stringify({ file: "x".repeat(70 * 1024) }),
			});
			assert.equal(big.status, 413);
		} finally {
			await handle.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isLoopbackHost accepts only loopback names, with or without a port", () => {
	for (const host of ["127.0.0.1:8787", "localhost:8787", "LOCALHOST", "[::1]:8787", "127.0.0.1"]) {
		assert.equal(isLoopbackHost(host), true, host);
	}
	for (const host of [
		undefined,
		"",
		"evil.example:8787",
		"127.0.0.1.evil.example",
		"localhost.evil.example",
		"10.0.0.1",
	]) {
		assert.equal(isLoopbackHost(host), false, String(host));
	}
});

test("serve.ts without a file answers 404 on /session.jsonl, /ping marks itself", async () => {
	const handle = await startServer({ port: 0 });
	try {
		assert.equal((await fetch(`${handle.url}session.jsonl`)).status, 404);
		assert.equal(await fetch(`${handle.url}ping`).then((r) => r.text()), "trace");
	} finally {
		await handle.close();
	}
});

test("newestSession picks the freshest jsonl across subfolders, ignores non-jsonl", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-newest-"));
	try {
		const old = join(dir, "old.jsonl");
		const newer = join(dir, "sub", "newer.jsonl");
		const note = join(dir, "note.txt");
		writeFileSync(old, "x\n");
		writeFileSync(note, "ignored");
		mkdirSync(join(dir, "sub"), { recursive: true });
		utimesSync(old, new Date(), new Date(Date.now() + 60_000));
		assert.equal(newestSession(dir), old); // свежего ещё нет
		writeFileSync(newer, "y\n");
		utimesSync(newer, new Date(), new Date(Date.now() + 120_000));
		assert.equal(newestSession(dir), newer); // рекурсия + сравнение по mtime
		assert.equal(newestSession(join(dir, "empty")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ServeHandle.setFile switches the session; close() does not wait for keep-alive clients", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-handle-"));
	try {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, '{"id":"a"}\n');
		writeFileSync(b, '{"id":"b"}\n');
		const handle = await startServer({ file: a, port: 0 });
		// Открытая вкладка: keep-alive-соединение остаётся после ответа.
		const agent = new Agent({ keepAlive: true });
		const get = () =>
			new Promise<string>((resolve, reject) => {
				request(`${handle.url}session.jsonl`, { agent }, (res) => {
					let body = "";
					res.on("data", (c) => (body += c));
					res.on("end", () => resolve(body));
				})
					.on("error", reject)
					.end();
			});
		try {
			assert.match(await get(), /"a"/);
			handle.setFile(b);
			assert.match(await get(), /"b"/);
		} finally {
			const closed = handle.close().then(() => "closed");
			const timeout = new Promise((r) => setTimeout(() => r("timeout"), 2000).unref());
			assert.equal(await Promise.race([closed, timeout]), "closed");
			agent.destroy();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/session.jsonl?from= returns only the bytes after the offset", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-from-"));
	try {
		const a = join(dir, "a.jsonl");
		writeFileSync(a, '{"n":1}\n{"n":"ё"}\n');
		const handle = await startServer({ file: a, port: 0 });
		try {
			const tail = await fetch(`${handle.url}session.jsonl?from=8`);
			assert.equal(tail.headers.get("x-session-from"), "8");
			assert.equal(await tail.text(), '{"n":"ё"}\n');

			// offset за концом (файл пересоздан короче) — весь файл с нуля
			const reset = await fetch(`${handle.url}session.jsonl?from=999`);
			assert.equal(reset.headers.get("x-session-from"), "0");
			assert.equal(await reset.text(), '{"n":1}\n{"n":"ё"}\n');
		} finally {
			await handle.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
