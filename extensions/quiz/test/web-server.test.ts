/**
 * Tests for the in-process quiz web server, driven through real HTTP (fetch on
 * an ephemeral loopback port): loopback Host guard, per-server token, Origin
 * check on POST, the payload anti-leak invariant over the wire (GET
 * /api/v1/state before an answer carries no correctIndices/explanation), the
 * answer → waitForAnswer promise lifecycle (timeout / abort / close), the
 * 409/400/413 error paths, and static file serving.
 * The page itself (index.html/app.js) is step 4 of the web-quiz plan.
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPendingState, type PendingPageState } from "../web/payload.ts";
import { startQuizServer, type QuizServerHandle } from "../web/server.ts";

const options = [
	{ label: "Mercury", value: "mercury" },
	{ label: "Venus", value: "venus" },
	{ label: "Earth", value: "earth" },
];

function pendingState(): PendingPageState {
	return buildPendingState("Which planet is closest to the sun?", "Solar system 101", "single-select", options);
}

function arm(handle: QuizServerHandle): { ok: true } | { ok: false; conflict: true } {
	return handle.setQuestion(pendingState(), { correctIndices: [2], explanation: "SECRET-explanation" });
}

function answerBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		dontKnow: false,
		answers: [{ label: "Venus", value: "venus", index: 2 }],
		...overrides,
	});
}

function stateUrl(handle: QuizServerHandle, token = handle.token): string {
	return `${pathUrl(handle, "/api/v1/state")}?t=${token}`;
}

/** Прямые пути (в обход join-ловушки: handle.url кончается на ?t=…). */
function pathUrl(handle: QuizServerHandle, path: string): string {
	return `http://127.0.0.1:${handle.port}${path}`;
}

function getState(handle: QuizServerHandle, token?: string): Promise<{ status: number; body: string }> {
	return fetch(stateUrl(handle, token)).then(async (r) => ({ status: r.status, body: await r.text() }));
}

function postAnswer(
	handle: QuizServerHandle,
	body: string,
	extraHeaders: Record<string, string> = {},
	token = handle.token,
): Promise<{ status: number; body: string }> {
	return fetch(`${pathUrl(handle, "/api/v1/answer")}?t=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...extraHeaders },
		body,
	}).then(async (r) => ({ status: r.status, body: await r.text() }));
}

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

test("startQuizServer: /ping, ephemeral loopback port, token in URL", async () => {
	const handle = await startQuizServer();
	try {
		assert.notEqual(handle.port, 0);
		assert.match(handle.url, new RegExp(`^http://127\\.0\\.0\\.1:${handle.port}/\\?t=[0-9a-f]+$`));
		assert.equal(await fetch(pathUrl(handle, "/ping")).then((r) => r.text()), "quiz-web");
	} finally {
		await handle.close();
	}
});

test("statics: index.html and app.js served from webDir with CSP and no-store; unknown path 404", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiz-web-"));
	try {
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><p>quiz-web page</p>");
		writeFileSync(join(dir, "app.js"), "console.log('quiz-web app');");
		const handle = await startQuizServer({ webDir: dir });
		try {
			const index = await fetch(handle.url);
			assert.equal(index.status, 200);
			assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
			assert.match(index.headers.get("content-security-policy") ?? "", /script-src 'self' https:\/\/cdn/);
			assert.equal(index.headers.get("cache-control"), "no-store");
			assert.match(await index.text(), /quiz-web page/);

			const app = await fetch(pathUrl(handle, "/app.js"));
			assert.equal(app.status, 200);
			assert.match(app.headers.get("content-type") ?? "", /^text\/javascript/);
			assert.match(await app.text(), /quiz-web app/);

			assert.equal((await fetch(pathUrl(handle, "/nope"))).status, 404);
			// statics must not serve server sources
			assert.equal((await fetch(pathUrl(handle, "/server.ts"))).status, 404);
		} finally {
			await handle.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loopback Host guard (DNS rebinding) and token required on /api/*", async () => {
	const handle = await startQuizServer();
	try {
		assert.equal(await getWithHost(handle.port, `/api/v1/state?t=${handle.token}`, "evil.example:1"), 403);
		assert.equal(await getWithHost(handle.port, `/api/v1/state?t=${handle.token}`, "localhost:1"), 200);

		const noToken = await getState(handle, "");
		assert.equal(noToken.status, 403);
		const wrongToken = await getState(handle, "deadbeef");
		assert.equal(wrongToken.status, 403);
		// token is also required on POST, before any grading
		const postNoToken = await postAnswer(handle, answerBody(), {}, "");
		assert.equal(postNoToken.status, 403);

		const ok = await getState(handle);
		assert.equal(ok.status, 200);
		assert.deepEqual(JSON.parse(ok.body), { kind: "idle" });
	} finally {
		await handle.close();
	}
});

test("POST /api/v1/answer rejects a cross-origin request (CSRF)", async () => {
	const handle = await startQuizServer();
	try {
		const csrf = await postAnswer(handle, answerBody(), { origin: "http://evil.example" });
		assert.equal(csrf.status, 403);
		// own-origin POST (what the page does) is accepted shape-wise: the
		// question is simply not armed yet → conflict, not forbidden
		arm(handle);
		const own = await postAnswer(handle, answerBody(), { origin: `http://127.0.0.1:${handle.port}` });
		assert.equal(own.status, 200);
	} finally {
		await handle.close();
	}
});

test("ANTI-LEAK over the wire: GET /api/v1/state while pending carries no answer key", async () => {
	const handle = await startQuizServer();
	try {
		assert.equal(arm(handle).ok, true);
		const res = await getState(handle);
		assert.equal(res.status, 200);

		const state = JSON.parse(res.body);
		assert.equal(state.kind, "pending");
		assert.equal(state.question, "Which planet is closest to the sun?");
		assert.deepEqual(state.options, [
			{ index: 1, label: "Mercury" },
			{ index: 2, label: "Venus" },
			{ index: 3, label: "Earth" },
		]);
		// The regression: neither the key fields nor the secret values may
		// appear anywhere in the wire payload before the user answers.
		assert.equal("correctIndices" in state, false);
		assert.equal("explanation" in state, false);
		assert.equal(res.body.includes("correctIndices"), false);
		assert.equal(res.body.includes("explanation"), false);
		assert.equal(res.body.includes("SECRET-explanation"), false);
		assert.equal(res.body.includes("venus"), false);
	} finally {
		await handle.close();
	}
});

test("POST answer resolves waitForAnswer with the QuizResponse; state becomes feedback with the key", async () => {
	const handle = await startQuizServer();
	try {
		arm(handle);
		const waited = handle.waitForAnswer();
		const post = await postAnswer(handle, answerBody({ note: "  hmm mercury?  " }));
		assert.equal(post.status, 200);
		assert.deepEqual(await waited, {
			dontKnow: false,
			note: "hmm mercury?",
			answers: [{ label: "Venus", value: "venus", index: 2 }],
		});

		// Only now may the key cross the wire.
		const feedback = JSON.parse((await getState(handle)).body);
		assert.equal(feedback.kind, "feedback");
		assert.deepEqual(feedback.correctIndices, [2]);
		assert.equal(feedback.explanation, "SECRET-explanation");
		assert.equal(feedback.correct, true);
		assert.deepEqual(feedback.selectedIndices, [2]);
		assert.equal(feedback.note, "hmm mercury?");

		// feedback stays on the page until the next question
		const again = JSON.parse((await getState(handle)).body);
		assert.equal(again.kind, "feedback");
	} finally {
		await handle.close();
	}
});

test("second POST → 409; POST without a pending question → 409", async () => {
	const handle = await startQuizServer();
	try {
		const none = await postAnswer(handle, answerBody());
		assert.equal(none.status, 409);

		arm(handle);
		assert.equal((await postAnswer(handle, answerBody())).status, 200);
		const repeat = await postAnswer(handle, answerBody());
		assert.equal(repeat.status, 409);
	} finally {
		await handle.close();
	}
});

test("setQuestion conflicts while a question is pending, works again after it is answered", async () => {
	const handle = await startQuizServer();
	try {
		assert.equal(arm(handle).ok, true);
		const second = handle.setQuestion(buildPendingState("Q2?", undefined, "multi-select", options), {
			correctIndices: [1],
		});
		assert.deepEqual(second, { ok: false, conflict: true });
		// the first question is untouched
		const state = JSON.parse((await getState(handle)).body);
		assert.equal(state.question, "Which planet is closest to the sun?");

		assert.equal((await postAnswer(handle, answerBody())).status, 200);
		assert.deepEqual(
			handle.setQuestion(buildPendingState("Q2?", undefined, "multi-select", options), { correctIndices: [1] }),
			{
				ok: true,
			},
		);
		const next = JSON.parse((await getState(handle)).body);
		assert.equal(next.kind, "pending");
		assert.equal(next.question, "Q2?");
	} finally {
		await handle.close();
	}
});

test("malformed answer bodies → 400", async () => {
	const handle = await startQuizServer();
	try {
		arm(handle);
		for (const body of [
			"not json",
			"[]",
			"{}",
			'{"dontKnow":false}',
			'{"dontKnow":"yes","answers":[]}',
			'{"dontKnow":false,"answers":[]}',
			'{"dontKnow":true,"answers":[{"label":"V","value":"venus","index":2}]}',
			'{"dontKnow":false,"answers":[{"label":"V","value":"venus","index":0}]}',
		]) {
			const res = await postAnswer(handle, body);
			assert.equal(res.status, 400, body);
		}
		// the question is still pending and answerable after rejected bodies
		const res = await postAnswer(handle, answerBody());
		assert.equal(res.status, 200);
	} finally {
		await handle.close();
	}
});

test("oversized answer body → 413", async () => {
	const handle = await startQuizServer();
	try {
		arm(handle);
		const big = answerBody({ note: "x".repeat(70 * 1024) });
		assert.equal((await postAnswer(handle, big)).status, 413);
	} finally {
		await handle.close();
	}
});

test("timeout resolves waitForAnswer(null), returns the page to idle, later POSTs → 409", async () => {
	const handle = await startQuizServer({ timeoutMs: 50 });
	try {
		arm(handle);
		const waited = handle.waitForAnswer();
		assert.equal(await waited, null);
		assert.deepEqual(JSON.parse((await getState(handle)).body), { kind: "idle" });
		assert.equal((await postAnswer(handle, answerBody())).status, 409);
		// a new question can be armed after the timeout
		assert.equal(arm(handle).ok, true);
	} finally {
		await handle.close();
	}
});

test("waitForAnswer(signal): abort cancels the current question, the server keeps living", async () => {
	const handle = await startQuizServer();
	try {
		const ac = new AbortController();
		arm(handle);
		const waited = handle.waitForAnswer(ac.signal);
		ac.abort();
		assert.equal(await waited, null);
		assert.deepEqual(JSON.parse((await getState(handle)).body), { kind: "idle" });
		// server still alive and reusable
		assert.equal(await fetch(pathUrl(handle, "/ping")).then((r) => r.text()), "quiz-web");
		assert.equal(arm(handle).ok, true);

		// pre-aborted signal resolves null immediately
		const dead = new AbortController();
		dead.abort();
		assert.equal(await handle.waitForAnswer(dead.signal), null);
	} finally {
		await handle.close();
	}
});

test("server-level signal: abort disarms the question and closes the server", async () => {
	const ac = new AbortController();
	const handle = await startQuizServer({ signal: ac.signal });
	arm(handle);
	const waited = handle.waitForAnswer();
	ac.abort();
	assert.equal(await waited, null);
	await assert.rejects(fetch(pathUrl(handle, "/ping")), Error);
	// further questions are refused on a closed server
	assert.deepEqual(arm(handle), { ok: false, conflict: true });
});

test("close() resolves pending waiters with null", async () => {
	const handle = await startQuizServer();
	arm(handle);
	const waited = handle.waitForAnswer();
	await handle.close();
	assert.equal(await waited, null);
});

test("dontKnow answer: graded as feedback with correct=false and the key revealed", async () => {
	const handle = await startQuizServer();
	try {
		arm(handle);
		const waited = handle.waitForAnswer();
		const res = await postAnswer(handle, answerBody({ dontKnow: true, answers: [] }));
		assert.equal(res.status, 200);
		assert.deepEqual(await waited, { dontKnow: true, note: undefined, answers: [] });

		const feedback = JSON.parse((await getState(handle)).body);
		assert.equal(feedback.dontKnow, true);
		assert.equal(feedback.correct, false);
		assert.deepEqual(feedback.selectedIndices, []);
		assert.deepEqual(feedback.correctIndices, [2]);
	} finally {
		await handle.close();
	}
});

// ── регресс-тесты по ревью (FIX REQUIRED): TOCTOU, abort-листенер, границы ──

test("TOCTOU: POST whose body arrives after disarm → 409, no crash (re-validation after readBody)", async () => {
	const handle = await startQuizServer();
	try {
		assert.deepEqual(arm(handle), { ok: true });
		const waited = handle.waitForAnswer();
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: handle.port,
					path: `/api/v1/answer?t=${handle.token}`,
					method: "POST",
					headers: { "content-type": "application/json" },
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode ?? 0));
				},
			);
			req.on("error", reject);
			// Запрос ушёл (первая валидация phase/pending/key пройдена — вопрос
			// ещё pending), но тело держим в сети:
			req.write(" ");
			setTimeout(() => {
				handle.cancel(); // деактивация МЕЖДУ чеками
				req.end(answerBody()); // теперь тело доезжает
			}, 50);
		});
		assert.equal(status, 409);
		assert.equal(await waited, null);
		const state = JSON.parse((await getState(handle)).body);
		assert.equal(state.kind, "idle");
	} finally {
		await handle.close();
	}
});

test("abort listener removed after POST resolution: a stale signal abort does not disarm the NEW question", async () => {
	const handle = await startQuizServer();
	try {
		assert.deepEqual(arm(handle), { ok: true });
		const ac = new AbortController();
		const waited = handle.waitForAnswer(ac.signal);
		const res = await postAnswer(handle, answerBody());
		assert.equal(res.status, 200);
		assert.ok(await waited, "waiter resolved by POST");

		// Новый вопрос тем же вызовом; старый сигнал «протух» и срабатывает позже.
		assert.deepEqual(arm(handle), { ok: true });
		ac.abort();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const state = JSON.parse((await getState(handle)).body);
		assert.equal(state.kind, "pending"); // вопрос выжил: слушатель снят
	} finally {
		await handle.close();
	}
});

test("forged answer index beyond options → 400, question stays pending and still answerable", async () => {
	const handle = await startQuizServer();
	try {
		assert.deepEqual(arm(handle), { ok: true });
		const bad = await postAnswer(handle, answerBody({ answers: [{ label: "X", value: "x", index: 99 }] }));
		assert.equal(bad.status, 400);
		const still = JSON.parse((await getState(handle)).body);
		assert.equal(still.kind, "pending"); // не превратился в feedback
		const good = await postAnswer(handle, answerBody());
		assert.equal(good.status, 200);
	} finally {
		await handle.close();
	}
});
