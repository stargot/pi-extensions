/**
 * Regression tests for the web-mode integration in ../index.ts (steps 5–6 of
 * the web-quiz plan), driven through the captured tool's execute() against the
 * real in-process server over HTTP.
 *
 * Currently covers the review's zombie-question fix: a call aborted while
 * queued in the web FIFO must NOT arm its question (waitForAnswer would
 * resolve null instantly without disarming — the question would stay pending
 * with no waiter until the timeout), so the NEXT web question must arm and
 * answer cleanly instead of hitting the armed-conflict → silent TUI fallback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import quiz from "../index.ts";

type ExecuteResult = { details?: { status?: string } };
type Tool = {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content?: unknown; details?: any }) => void) | undefined,
		ctx: { hasUI: boolean },
	) => Promise<ExecuteResult>;
};

function setup(): { tool: Tool; shutdown(): void } {
	const tools: Tool[] = [];
	const onHandlers: Record<string, () => void> = {};
	quiz({
		registerTool: (t: never) => tools.push(t as unknown as Tool),
		registerCommand: () => {},
		on: (event: string, handler: () => void) => {
			onHandlers[event] = handler;
		},
	} as never);
	return {
		tool: tools[0],
		shutdown: () => onHandlers.session_shutdown?.(),
	};
}

const params = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus", value: "venus" },
		{ label: "Mercury", value: "mercury" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury orbits closest to the sun.",
	web: true,
};

function answerBody(index: number): string {
	return JSON.stringify({ dontKnow: false, answers: [{ label: "Mercury", value: "mercury", index }] });
}

/** URL токен-вида http://127.0.0.1:PORT/?t=TOKEN из onUpdate с details.url. */
function urlOf(updates: Array<{ details?: { url?: string } }>): { port: string; token: string } {
	const raw = updates.find((u) => u.details?.url)?.details?.url;
	assert.ok(raw, "web onUpdate must carry the URL");
	const url = new URL(raw);
	return { port: url.port, token: url.searchParams.get("t") ?? "" };
}

async function postAnswer(port: string, token: string, body: string): Promise<number> {
	const res = await fetch(`http://127.0.0.1:${port}/api/v1/answer?t=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
		body,
	});
	return res.status;
}

async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 250; i++) {
		if (cond()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("condition not met within timeout");
}

test("web mode: call aborted while queued leaves no zombie — the next question arms and answers", async () => {
	const { tool, shutdown } = setup();
	const ctx = { hasUI: false };
	try {
		// Вопрос 1: armed, ждёт ответа.
		const updates1: Array<{ details?: any }> = [];
		const call1 = tool.execute("t1", params, undefined, (u) => updates1.push(u), ctx);
		await until(() => updates1.some((u) => u.details?.url));
		const q1 = urlOf(updates1);

		// Вопрос 2: встаёт в FIFO, и его прерывают, пока 1-й ещё ждёт ответа.
		const ac2 = new AbortController();
		const call2 = tool.execute("t2", params, ac2.signal, () => {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20)); // дать встать в очередь
		ac2.abort();

		// Отвечаем вопрос 1 — FIFO выпускает вызов 2 (уже прерванный).
		assert.equal(await postAnswer(q1.port, q1.token, answerBody(2)), 200);
		const r1 = await call1;
		assert.equal(r1.details?.status, "answered");
		const r2 = await call2;
		assert.equal(r2.details?.status, "cancelled");

		// Зомби-дискриминатор: вопрос 3 должен armed-нуться (URL в onUpdate) и
		// ответиться. Старый код: вызов 2 армил зомби → вопрос 3 ловил конфликт
		// → тихий TUI-фолбэк → в headless это unavailable без URL.
		const updates3: Array<{ details?: any }> = [];
		const call3 = tool.execute("t3", params, undefined, (u) => updates3.push(u), ctx);
		await until(() => updates3.some((u) => u.details?.url));
		const q3 = urlOf(updates3);
		assert.equal(await postAnswer(q3.port, q3.token, answerBody(2)), 200);
		const r3 = await call3;
		assert.equal(r3.details?.status, "answered");
	} finally {
		shutdown();
	}
});
