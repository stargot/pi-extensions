import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { composition, diffContext, projectContext } from "../core/context.ts";
import { SessionTree } from "../core/tree.ts";
import { ENTRIES, HEADER } from "./fixture-tree.ts";

function tree(): SessionTree {
	const t = new SessionTree();
	t.add(HEADER);
	for (const e of ENTRIES) t.add(e);
	return t;
}

const ROLE: Record<string, string> = {
	system: "system",
	user: "user",
	assistant: "assistant",
	toolResult: "toolResult",
	bashExecution: "bash",
	custom: "custom",
	branchSummary: "summary",
	compactionSummary: "summary",
};

test("SessionTree: лист — последняя запись, путь идёт по parentId мимо брошенной ветки", () => {
	const t = tree();
	assert.equal(t.leafId, "a5");
	const ids = t.path().map((e) => e.id);
	assert.ok(ids.includes("bs1") && ids.includes("cm1"));
	assert.ok(!ids.includes("u2") && !ids.includes("a3"), "брошенная ветка не на пути");
	assert.deepEqual(
		t.children("cm1").map((e) => e.id),
		["u2", "bs1"],
	);
	assert.equal(t.latestIn("u2")?.id, "a3");
});

test("SessionTree: v1-записи без id связываются в линейную цепочку", () => {
	const t = new SessionTree();
	t.add({ type: "message", message: { role: "user", content: "a" } });
	t.add({ type: "message", message: { role: "assistant", content: [] } });
	assert.deepEqual(
		t.path().map((e) => e.id),
		["#0", "#1"],
	);
});

test("projectContext: паритет с buildSessionProjection pi на каждом листе дерева", () => {
	const t = tree();
	for (const leaf of ENTRIES) {
		const pi = buildSessionProjection(ENTRIES as any, leaf.id!).entries.flatMap((p: any) =>
			p.messages
				.filter((m: any) => !(m.role === "bashExecution" && m.excludeFromContext))
				.map((m: any) => `${p.sourceEntry.id}/${ROLE[m.role]}`),
		);
		const ours = projectContext(t.path(leaf.id!)).map((p) => `${p.entryId}/${p.role}`);
		assert.deepEqual(ours, pi, `лист ${leaf.id}`);
	}
});

test("projectContext: context_edit подменяет content, компакция обрезает до firstKept", () => {
	const t = tree();
	const beforeCompaction = projectContext(t.path("ce2"));
	const r1 = beforeCompaction.find((p) => p.entryId === "r1")!;
	assert.equal(r1.edited, true);
	assert.match(r1.text, /\[trimmed\]/);
	assert.equal(
		beforeCompaction.find((p) => p.entryId === "a2"),
		undefined,
		"replacement: null убирает сообщение",
	);

	const after = projectContext(t.path("u4"));
	assert.deepEqual(
		after.slice(0, 3).map((p) => `${p.entryId}/${p.role}`),
		["k1/system", "k1/summary", "u3/user"],
	);
	assert.ok(!after.some((p) => p.entryId === "u1"), "до firstKept — только в summary");
});

test("composition: символы масштабируются к реальному промпту", () => {
	const parts = projectContext(tree().path("a4"));
	const c = composition(parts, 1400);
	const sum = Object.values(c).reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(sum - 1400) <= 7, `сумма ${sum}`);
	assert.ok(c.summary > 0, "branch_summary в составе");
	assert.ok(c.custom > 0, "custom_message в составе");
});

test("diffContext: префикс, новые, ушедшие и изменённые части", () => {
	const t = tree();
	const d = diffContext(projectContext(t.path("x2")), projectContext(t.path("ce2")));
	assert.deepEqual(
		d.removed.map((p) => p.entryId),
		["a2"],
	);
	assert.deepEqual(
		d.changed.map((p) => p.entryId),
		["r1"],
	);
	assert.equal(d.added.length, 0);
	assert.equal(d.prefix, 3, "s0, u1, a1 — до первой правки");

	const k = diffContext(projectContext(t.path("ce2")), projectContext(t.path("k1")));
	assert.equal(k.prefix, 0, "компакция переписывает префикс — кэш холодный");
});
