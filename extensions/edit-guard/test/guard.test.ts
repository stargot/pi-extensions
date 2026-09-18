import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import guard, { createEditGuardHandler } from "../index.ts";

interface FakePi {
	pi: ExtensionAPI;
	handler: ((event: ToolCallEvent, ctx: { cwd: string }) => Promise<unknown>) | undefined;
	entries: { type: string; data: unknown }[];
}

function fakePi(): FakePi {
	const state: FakePi = { pi: {} as ExtensionAPI, handler: undefined, entries: [] };
	state.pi = {
		on: (event: string, handler: never) => {
			assert.equal(event, "tool_call");
			state.handler = handler as FakePi["handler"];
		},
		appendEntry: (type: string, data: unknown) => {
			state.entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
	guard(state.pi);
	return state;
}

function makeEvent(input: unknown): ToolCallEvent {
	return { type: "tool_call", toolCallId: "t1", toolName: "edit", input } as ToolCallEvent;
}

function setup(): { f: FakePi; dir: string; run: (input: unknown) => Promise<unknown> } {
	const f = fakePi();
	const dir = mkdtempSync(join(tmpdir(), "edit-guard-"));
	const run = (input: unknown) => f.handler!(makeEvent(input), { cwd: dir });
	return { f, dir, run };
}

test("guard: happy path — exact совпадение, input не изменён, action pass", async () => {
	const { f, dir, run } = setup();
	const file = join(dir, "a.ts");
	writeFileSync(file, "one\ntwo\nthree\n", "utf8");
	const input = { path: file, edits: [{ oldText: "two", newText: "два" }] };

	const result = await run(input);

	assert.equal(result, undefined);
	assert.deepEqual(input.edits[0], { oldText: "two", newText: "два" });
	assert.equal(f.entries.length, 1);
	assert.equal(f.entries[0].type, "edit-guard");
	assert.deepEqual(f.entries[0].data, {
		path: file,
		action: "pass",
		edits: [{ index: 0, method: "exact", similarity: 1 }],
	});
});

test("guard: CRLF-файл — oldText подменяется сырой подстрокой", async () => {
	const { f, dir, run } = setup();
	const file = join(dir, "b.ts");
	writeFileSync(file, "first\r\nsecond\r\n", "utf8");
	const input = { path: file, edits: [{ oldText: "first\nsecond", newText: "1\n2" }] };

	const result = await run(input);

	assert.equal(result, undefined);
	assert.equal(input.edits[0].oldText, "first\r\nsecond");
	assert.equal(input.edits[0].newText, "1\n2"); // newText не трогаем
	const entry = f.entries[0].data as { action: string; edits: { method: string }[] };
	assert.equal(entry.action, "patched");
	assert.equal(entry.edits[0].method, "whitespace");
});

test("guard: безнадёжный oldText — block с строкой и сниппетом в reason", async () => {
	const { f, dir, run } = setup();
	const file = join(dir, "c.ts");
	writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
	const input = { path: file, edits: [{ oldText: "alpha\ndelta\nomega", newText: "x" }] };

	const result = (await run(input)) as { block?: boolean; reason?: string };

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /alpha/);
	assert.match(result?.reason ?? "", /строк/);
	assert.match(result?.reason ?? "", /edits\[0\]/);
	const entry = f.entries[0].data as { action: string };
	assert.equal(entry.action, "blocked");
});

test("guard: несуществующий файл — undefined, без телеметрии", async () => {
	const { f, run } = setup();
	const result = await run({ path: join(tmpdir(), "edit-guard-nope-", "missing.ts"), edits: [{ oldText: "a", newText: "b" }] });
	assert.equal(result, undefined);
	assert.equal(f.entries.length, 0);
});

test("guard: смешанные edits — одна плохая блокирует весь вызов", async () => {
	const { f, dir, run } = setup();
	const file = join(dir, "d.ts");
	writeFileSync(file, "one\r\ntwo\r\n", "utf8");
	const input = {
		path: file,
		edits: [
			{ oldText: "one\ntwo", newText: "1\n2" }, // спасётся (whitespace)
			{ oldText: " completely unrelated text", newText: "y" }, // не найдётся
		],
	};

	const result = (await run(input)) as { block?: boolean; reason?: string };

	assert.equal(result?.block, true);
	// Спасённая правка уже вшита в input — но вызов заблокирован целиком.
	assert.equal(input.edits[0].oldText, "one\r\ntwo");
	assert.match(result?.reason ?? "", /спасены: edits\[0\]/);
	assert.match(result?.reason ?? "", /edits\[1\]/);
	const entry = f.entries[0].data as { action: string; edits: { index: number; method: string }[] };
	assert.equal(entry.action, "blocked");
	assert.deepEqual(entry.edits.map((e) => e.method), ["whitespace", "not-found"]);
});

test("guard: относительный путь резолвится от cwd", async () => {
	const { f, dir, run } = setup();
	const file = join(dir, "rel.ts");
	writeFileSync(file, "const x = 1;\n", "utf8");
	const input = { path: "rel.ts", edits: [{ oldText: "const x = 2;", newText: "const x = 3;" }] };

	const result = (await run(input)) as { block?: boolean; reason?: string };

	// "const x = 2;" не найдено, но "const x = 1;" рядом — fuzzy или блок;
	// главное: файл найден и телеметрия записана.
	assert.equal(f.entries.length, 1);
	assert.equal((f.entries[0].data as { path: string }).path, "rel.ts");
	assert.ok(result === undefined || result?.block === true);
});

test("guard: не-edit событие отсекается до чтения файла", async () => {
	const f = fakePi();
	// isToolCallEventType различает по toolName — имитируем bash-событие.
	const event = { type: "tool_call", toolCallId: "t2", toolName: "bash", input: { command: "ls" } } as unknown as ToolCallEvent;
	const result = await f.handler!(event, { cwd: tmpdir() });
	assert.equal(result, undefined);
	assert.equal(f.entries.length, 0);
});

test("guard: сбой внутри хендлера — undefined и телеметрия action:error, edit не ломается", async () => {
	// pi emitToolCall исключения не ловит: бросивший гард сломал бы сам edit.
	// Подменяем readFile так, чтобы после чтения (внутренний catch уже прошёл)
	// хендлер упал на нестроковом результате — внешний catch обязан вернуть
	// undefined и записать телеметрию.
	const f = fakePi();
	const handler = createEditGuardHandler(f.pi, {
		readFile: (async () => 42) as unknown as typeof readFile,
	});
	const event = makeEvent({ path: "whatever.ts", edits: [{ oldText: "a", newText: "b" }] });
	const result = await handler(event, { cwd: tmpdir() });
	assert.equal(result, undefined);
	assert.equal(f.entries.length, 1);
	assert.equal(f.entries[0].type, "edit-guard");
	const entry = f.entries[0].data as { action: string; error?: string; path?: string };
	assert.equal(entry.action, "error");
	assert.equal(entry.path, "whatever.ts");
	assert.ok(typeof entry.error === "string" && entry.error.length > 0, JSON.stringify(entry));
});

test("guard: отклонившийся readFile — тихий пропуск без телеметрии (файл не читается)", async () => {
	const f = fakePi();
	const handler = createEditGuardHandler(f.pi, {
		readFile: (async () => {
			throw new Error("EACCES");
		}) as unknown as typeof readFile,
	});
	const event = makeEvent({ path: "locked.ts", edits: [{ oldText: "a", newText: "b" }] });
	const result = await handler(event, { cwd: tmpdir() });
	assert.equal(result, undefined);
	assert.equal(f.entries.length, 0);
});
