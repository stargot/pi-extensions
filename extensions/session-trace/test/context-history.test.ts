import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cacheHitRatio,
	cacheLevel,
	ContextHistory,
	CONTEXT_HISTORY_LIMIT,
	diffTurns,
	makeSignature,
	zeroDiff,
	type TurnSnapshot,
} from "../context-history.ts";
import { GraphModel } from "../session.ts";

const iso = (m: number) =>
	`2026-09-05T12:${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}.000Z`;

function snap(turnIndex: number, sigs: string[], tokens: Partial<TurnSnapshot["tokens"]> = {}): TurnSnapshot {
	return {
		turnIndex,
		ts: Date.parse(iso(turnIndex)),
		model: "glm-5.3",
		tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, ...tokens },
		messageSignature: sigs,
	};
}

// ---------- подписи ----------

test("makeSignature: роль + первые ~80 символов, пробелы схлопнуты", () => {
	assert.equal(makeSignature("user", "  fix   the bug  "), "user: fix the bug");
	const long = "a".repeat(200);
	const sig = makeSignature("assistant", long);
	assert.ok(sig.startsWith("assistant: "));
	assert.ok(sig.length <= "assistant: ".length + 80);
	assert.ok(sig.endsWith("…"));
	assert.equal(makeSignature("user", ""), "user: ");
	assert.equal(makeSignature("user", undefined), "user: ");
});

// ---------- кольцевой буфер ----------

test("buffer: keeps only the last 20 turns, evicting the oldest", () => {
	const h = new ContextHistory();
	for (let i = 1; i <= CONTEXT_HISTORY_LIMIT + 5; i++) {
		h.push(snap(i, [`user: msg ${i}`, `assistant: reply ${i}`]));
	}
	assert.equal(h.length, CONTEXT_HISTORY_LIMIT);
	assert.equal(h.snapshots[0]!.turnIndex, 6); // 1..5 вытеснены
	assert.equal(h.snapshots.at(-1)!.turnIndex, 25);
	assert.equal(h.revision, 25);
	// у первого оставшегося хода сосед вытеснен — prev нет; у второго — есть
	const first = h.diffAt(0);
	assert.equal(first.prev, undefined);
	const { prev, curr } = h.diffAt(1);
	assert.equal(prev!.turnIndex, 6);
	assert.equal(curr.turnIndex, 7);
});

test("buffer: push returns diff against previous turn", () => {
	const h = new ContextHistory();
	const d0 = h.push(snap(1, ["user: a"]));
	assert.equal(d0.prefixRatio, 0); // первый ход — переиспользовать нечего
	assert.equal(d0.summary.added, 1);
	const d1 = h.push(snap(2, ["user: a", "assistant: b"]));
	assert.equal(d1.summary.added, 1);
	assert.equal(d1.summary.same, 1);
});

// ---------- delta / prefix-ratio / changedBlocks на фикстурах ----------

test("diffTurns: empty diff between identical turns", () => {
	const s = snap(1, ["user: a", "assistant: b", "toolResult(read): ok"]);
	const d = diffTurns(s, snap(2, s.messageSignature, { input: 250 }));
	assert.equal(d.summary.changedBlocks, 0);
	assert.equal(d.summary.same, 3);
	assert.equal(d.prefixRatio, 1);
	assert.equal(d.prefixSignatures, 3);
	assert.equal(d.deltaTokens, 150); // 250+0+0 − 100
	assert.equal(d.promptTokens, 250);
});

test("diffTurns: append at the tail keeps the whole prefix", () => {
	const prev = snap(1, ["user: a", "assistant: b"]);
	const curr = snap(2, ["user: a", "assistant: b", "user: c", "assistant: d"]);
	const d = diffTurns(prev, curr);
	assert.equal(d.prefixRatio, 2 / 4);
	assert.equal(d.prefixSignatures, 2);
	assert.deepEqual(
		{ added: d.summary.added, removed: d.summary.removed, modified: d.summary.modified },
		{ added: 2, removed: 0, modified: 0 },
	);
});

test("diffTurns: edit in the middle stops the prefix at the boundary", () => {
	const prev = snap(1, ["user: a", "assistant: OLD", "user: c", "assistant: d"]);
	const curr = snap(2, ["user: a", "assistant: NEW", "user: c", "assistant: d"]);
	const d = diffTurns(prev, curr);
	assert.equal(d.prefixSignatures, 1); // граница на изменённом блоке
	assert.equal(d.prefixRatio, 1 / 4);
	assert.equal(d.summary.modified, 1);
	assert.equal(d.summary.changedBlocks, 1);
	// остальной хвост совпал позиционно и считается тем же
	assert.equal(d.summary.same, 3);
});

test("diffTurns: removal and mixed churn (positional alignment pairs the tail)", () => {
	const prev = snap(1, ["user: a", "assistant: b", "user: c"]);
	const curr = snap(2, ["user: a", "user: c", "user: e"]);
	const d = diffTurns(prev, curr);
	// позиционное выравнивание после границы: b→c и c→e — две modify-пары
	assert.equal(d.summary.modified, 2);
	assert.equal(d.summary.added, 0);
	assert.equal(d.summary.removed, 0);
	assert.equal(d.summary.changedBlocks, 2);
	assert.equal(d.prefixSignatures, 1);
});

test("diffTurns: first turn and empty context", () => {
	const curr = snap(1, ["user: hi"]);
	const d0 = diffTurns(undefined, curr);
	assert.equal(d0.prefixRatio, 0);
	assert.equal(d0.summary.added, 1);
	assert.equal(d0.deltaTokens, 100); // промпт текущего − 0 (нет предыдущего)
	// пустой контекст — деление на ноль не должно давать NaN
	const empty = snap(1, []);
	assert.equal(diffTurns(undefined, empty).prefixRatio, 1);
	assert.equal(diffTurns(empty, snap(2, [])).prefixRatio, 1);
	assert.equal(zeroDiff(empty).summary.changedBlocks, 0);
});

test("diffTurns: prefixTokens ≈ chars/4 over the shared prefix", () => {
	const sig = `user: ${"x".repeat(80)}`; // 86 символов
	const prev = snap(1, [sig]);
	const curr = snap(2, [sig, "assistant: y"]);
	const d = diffTurns(prev, curr);
	assert.equal(d.prefixTokens, Math.floor(sig.length / 4));
});

// ---------- кэш-метрики ----------

test("cacheHitRatio: reported only when the provider sends cache fields", () => {
	assert.equal(cacheHitRatio({ input: 100, cacheRead: 300, cacheWrite: 100, output: 5 }), 0.6);
	assert.equal(cacheHitRatio({ input: 400, cacheRead: 0, cacheWrite: 0, output: 5 }), null);
	assert.equal(cacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }), null);
});

test("cacheLevel: warm/partial/cold thresholds", () => {
	assert.equal(cacheLevel(0.95), "warm");
	assert.equal(cacheLevel(0.7), "warm");
	assert.equal(cacheLevel(0.69), "partial");
	assert.equal(cacheLevel(0.4), "partial");
	assert.equal(cacheLevel(0.1), "cold");
});

// ---------- интеграция с GraphModel ----------

function turnEntry(id: string, time: string, opts: Record<string, unknown> = {}): unknown {
	return {
		type: "message",
		id,
		timestamp: time,
		message: {
			role: "assistant",
			model: "glm-5.3",
			usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			content: [{ type: "text", text: "ответ" }],
			...opts,
		},
	};
}

test("GraphModel: per-turn snapshots with tokens and ordered signatures", () => {
	const m = new GraphModel();
	m.feedEntry({ type: "session", version: 3, id: "s1", timestamp: iso(0), cwd: "C:\\P" });
	m.feedEntry({
		type: "message",
		id: "u1",
		timestamp: iso(1),
		message: { role: "user", content: [{ type: "text", text: "привет" }] },
	});
	m.feedEntry(turnEntry("m1", iso(2), { usage: { input: 1000, output: 50, cacheRead: 800, cacheWrite: 100 } }));
	m.feedEntry({
		type: "message",
		id: "t1",
		timestamp: iso(3),
		message: { role: "toolResult", toolCallId: "nope", toolName: "read", content: [{ type: "text", text: "ok" }] },
	});
	m.feedEntry(turnEntry("m2", iso(4)));

	assert.equal(m.history.length, 2);
	const s1 = m.history.snapshots[0]!;
	assert.equal(s1.turnIndex, 1);
	assert.equal(s1.model, "glm-5.3");
	assert.deepEqual(s1.tokens, { input: 1000, cacheRead: 800, cacheWrite: 100, output: 50 });
	assert.deepEqual(s1.messageSignature, ["user: привет", "assistant: ответ"]);

	const s2 = m.history.snapshots[1]!;
	// подпись toolResult попала в контекст второго хода, даже без чипа
	assert.deepEqual(s2.messageSignature, [
		"user: привет",
		"assistant: ответ",
		"toolResult(read): ok",
		"assistant: ответ",
	]);
	const d = m.history.diffAt(1).diff;
	assert.equal(d.summary.added, 2);
	assert.equal(d.summary.same, 2);
	// ход-токены доступны и на TurnItem
	const turn2 = m.items.find(
		(i): i is Extract<(typeof m.items)[number], { kind: "turn" }> => i.kind === "turn" && i.index === 2,
	)!;
	assert.deepEqual(turn2.tokens, { input: 1000, cacheRead: 0, cacheWrite: 0, output: 50 });
});

test("GraphModel: compaction resets context — next turn shows a cold cache", () => {
	const m = new GraphModel();
	m.feedEntry({ type: "message", id: "u1", timestamp: iso(1), message: { role: "user", content: "первый вопрос" } });
	m.feedEntry(turnEntry("m1", iso(2)));
	m.feedEntry({ type: "compaction", id: "k1", timestamp: iso(3), tokensBefore: 3000 });
	m.feedEntry({ type: "message", id: "u2", timestamp: iso(4), message: { role: "user", content: "второй вопрос" } });
	m.feedEntry(turnEntry("m2", iso(5)));

	const s2 = m.history.snapshots[1]!;
	assert.deepEqual(s2.messageSignature, ["user: второй вопрос", "assistant: ответ"]);
	const d = m.history.diffAt(1).diff;
	assert.equal(d.prefixSignatures, 0);
	assert.equal(d.prefixRatio, 0);
	assert.equal(cacheLevel(d.prefixRatio), "cold");
});

test("GraphModel: identical contexts give an empty diff (integration)", () => {
	const m = new GraphModel();
	// баш-команда и ход с тем же содержимым: второй ход повторяет подписи первого
	m.feedEntry({ type: "message", id: "u1", timestamp: iso(1), message: { role: "user", content: "вопрос" } });
	m.feedEntry(turnEntry("m1", iso(2)));
	m.feedEntry({
		type: "message",
		id: "m2",
		timestamp: iso(3),
		message: {
			role: "assistant",
			model: "glm-5.3",
			usage: { input: 1000, output: 50, cost: { total: 0.01 } },
			content: [{ type: "text", text: "ответ" }],
			thinking: [],
		},
	});
	// ходы всегда добавляют подпись ассистента — строго пустой дифф возможен
	// только у снимка с самим собой; проверяем на уровне diffTurns
	const s = m.history.snapshots[0]!;
	const d = diffTurns(s, { ...s, turnIndex: s.turnIndex + 1 });
	assert.equal(d.summary.changedBlocks, 0);
	assert.equal(d.deltaTokens, 0);
});
