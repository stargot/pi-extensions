import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheHit, deriveSession } from "../core/model.ts";
import { SessionTree } from "../core/tree.ts";
import { ENTRIES, GEN_MS, HEADER } from "./fixture-tree.ts";

function tree(entries = ENTRIES): SessionTree {
	const t = new SessionTree();
	t.add(HEADER);
	for (const e of entries) t.add(e);
	return t;
}

test("deriveSession: эры по промптам активного пути, ходы нумеруются сквозь эры", () => {
	const v = deriveSession(tree());
	assert.deepEqual(
		v.eras.map((e) => [e.index, e.prompt, e.turns.map((t) => `T${t.index}`)]),
		[
			[1, "fix the bug", ["T1", "T2"]],
			[2, "back to single-flight", ["T3"]],
			[3, "and add e2e", ["T4"]],
		],
	);
	assert.equal(v.cwd, "/x");
	assert.equal(v.eras[2]!.errors, 1, "stopReason error");
});

test("deriveSession: маркеры — ветка, метка на цели, правки контекста, компакция", () => {
	const v = deriveSession(tree());
	assert.deepEqual(
		v.eras.map((e) => e.markers.map((m) => m.kind)),
		[["branch"], ["label", "edit", "edit", "compaction"], []],
	);
	assert.equal(v.eras[1]!.markers[0]!.text, "release");
});

test("deriveSession: брошенная ветка от точки ветвления со своим branch_summary", () => {
	const v = deriveSession(tree());
	assert.equal(v.branches.length, 1);
	const b = v.branches[0]!;
	assert.equal(b.forkId, "cm1");
	assert.equal(b.forkTurn, 2);
	assert.equal(b.leafId, "a3");
	assert.equal(b.summary, "mutex made it worse");
	assert.deepEqual(
		b.eras.map((e) => [e.prompt, e.turns.map((t) => t.index)]),
		[["try a mutex", [3]]],
	);
	assert.equal(b.cost, 0.004);
});

test("deriveSession: итоги по всему файлу, включая ветку и суммаризацию компакции", () => {
	const v = deriveSession(tree());
	assert.ok(Math.abs(v.totals.cost - 0.075) < 1e-9, String(v.totals.cost));
	assert.equal(v.totals.output, 50 + 30 + 80 + 40 + 400 + 60);
	assert.deepEqual([...v.models.keys()], ["glm-5.3"]);
	assert.equal(v.models.get("glm-5.3")!.turns, 4, "ход брошенной ветки — не на пути");
});

test("deriveSession: разбивка времени — генерация, инструменты, остаток", () => {
	const v = deriveSession(tree());
	assert.equal(v.time.modelMs, 4 * GEN_MS);
	assert.equal(v.time.toolsMs, 1000, "read: конец стрима a1 → toolResult r1");
	assert.equal(v.time.idleMs, v.time.spanMs - v.time.modelMs - v.time.toolsMs);
});

test("deriveSession: идущий инструмент — агент работает, время считается до nowMs", () => {
	const upto = ENTRIES.slice(0, ENTRIES.findIndex((e) => e.id === "a1") + 1);
	const t = tree(upto);
	const end = Date.parse(upto.at(-1)!.timestamp!);
	const v = deriveSession(t, t.leafId, end + 5000);
	assert.equal(v.running, true);
	assert.equal(v.turns[0]!.tools[0]!.status, "running");
	assert.equal(v.time.toolsMs, 5000);
	assert.equal(deriveSession(t).time.toolsMs, 0, "без nowMs идущий инструмент не учитывается");
});

test("deriveSession: лист в брошенной ветке — она становится путём, активная — веткой", () => {
	const v = deriveSession(tree(), "a3");
	assert.deepEqual(
		v.eras.map((e) => e.prompt),
		["fix the bug", "try a mutex"],
	);
	assert.deepEqual(
		v.branches.map((b) => [b.forkId, b.leafId]),
		[["cm1", "a5"]],
	);
});

test("cacheHit: доля cacheRead в промпте; null без отчёта о кэше", () => {
	assert.equal(cacheHit({ input: 100, cacheRead: 300, cacheWrite: 0, output: 1 }), 0.75);
	assert.equal(cacheHit({ input: 100, cacheRead: 0, cacheWrite: 0, output: 1 }), null);
});

test("deriveSession: смена модели до первого промпта не открывает эру 0", () => {
	const t = new SessionTree();
	t.add({
		type: "model_change",
		id: "m",
		parentId: null,
		timestamp: "2026-09-05T12:00:00.000Z",
		provider: "zai",
		modelId: "glm",
	});
	t.add({
		type: "message",
		id: "u",
		parentId: "m",
		timestamp: "2026-09-05T12:00:01.000Z",
		message: { role: "user", content: "hi" },
	});
	const v = deriveSession(t);
	assert.deepEqual(
		v.eras.map((e) => e.index),
		[1],
	);
	assert.deepEqual(
		v.markers.map((m) => m.kind),
		["model"],
	);
});

test("deriveSession: команды пользователя (!cmd) — в эре, ненулевой exit считается ошибкой", () => {
	const v = deriveSession(tree());
	assert.deepEqual(
		v.eras[1]!.shell.map((c) => [c.command, c.exitCode]),
		[
			["ls", 0],
			["npm test", 0],
		],
	);
});

test("deriveSession: ссылки на субагентов под новым и старым customType", () => {
	const t = new SessionTree();
	t.add({
		type: "message",
		id: "u",
		parentId: null,
		timestamp: "2026-09-05T12:00:00.000Z",
		message: { role: "user", content: "go" },
	});
	for (const [id, customType] of [
		["c1", "trace:subagents"],
		["c2", "pitrace:subagents"],
	] as const) {
		t.add({
			type: "custom",
			id,
			parentId: t.leafId,
			timestamp: "2026-09-05T12:00:01.000Z",
			customType,
			data: { agent: "scout", task: "look", session: `/s/${id}.jsonl`, usage: { output: 10, cost: 0.01 } },
		});
	}
	assert.deepEqual(
		deriveSession(t).children.map((c) => c.session),
		["/s/c1.jsonl", "/s/c2.jsonl"],
	);
});

test("SessionTree/deriveSession: битые и неизвестные записи не роняют свёртку", () => {
	const t = new SessionTree();
	for (const e of [
		null,
		42,
		"x",
		{ type: "weird", id: "w", parentId: null },
		{ type: "message", id: "m", parentId: "w" },
	])
		t.add(e as any);
	assert.doesNotThrow(() => deriveSession(t));
	assert.equal(deriveSession(t).turns.length, 0);
});
