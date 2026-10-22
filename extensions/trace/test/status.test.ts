/**
 * Строка состояния trace: рендер по модели ядра и живому состоянию агента,
 * /trace on|off с сохранением в <agentDir>/trace.json, перерисовка по событиям pi.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveSession } from "../core/model.ts";
import { SessionTree } from "../core/tree.ts";
import trace from "../index.ts";
import { readStatusPref, renderStatusLine, writeStatusPref } from "../status.ts";
import { ENTRIES, HEADER } from "./fixture-tree.ts";

const plain = (_c: string, t: string) => t;

function view(entries = ENTRIES) {
	const t = new SessionTree();
	t.add(HEADER);
	for (const e of entries) t.add(e);
	return deriveSession(t);
}

test("renderStatusLine: идущий инструмент — имя, аргумент, таймер, спиннер", () => {
	const line = renderStatusLine(
		view(),
		{ busy: true, tool: { name: "edit", label: "src/auth.ts", startMs: 1000 }, workers: 2 },
		1400,
		plain,
	);
	assert.match(line, /^◐ T4 ⚒ edit src\/auth\.ts 400ms ./);
	assert.match(line, /↑2\.4k hit 83%/);
	assert.match(line, /2 воркера ●/);
	assert.doesNotMatch(line, /модель \d+%/, "разбивка времени — только в простое");
});

test("renderStatusLine: генерация без инструмента — следующий ход и время запроса", () => {
	const line = renderStatusLine(view(), { busy: true, turnStartMs: 0, workers: 0 }, 3200, plain);
	assert.match(line, /^◐ T5 генерация 3\.2s/);
});

test("renderStatusLine: простой — итог эры, ошибка последнего хода, разбивка времени", () => {
	const line = renderStatusLine(view(), { busy: false, workers: 0 }, 0, plain);
	assert.match(line, /T4 · ошибка за \d/);
	assert.match(line, /\$0\.08/);
	assert.match(line, /модель \d+% · инстр\. \d+%/);
});

test("renderStatusLine: компакция после последнего хода — холодный кэш ↻", () => {
	const upto = ENTRIES.slice(0, ENTRIES.findIndex((e) => e.id === "k1") + 1);
	const colors: string[] = [];
	const line = renderStatusLine(view(upto), { busy: false, workers: 0 }, 0, (c, t) => {
		if (t.startsWith("hit")) colors.push(c);
		return t;
	});
	assert.match(line, /hit \d+% ↻/);
	assert.deepEqual(colors, ["warning"]);
});

test("readStatusPref/writeStatusPref: по умолчанию включено, чужие ключи сохраняются", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-pref-"));
	try {
		assert.equal(readStatusPref(dir), true, "файла нет");
		writeFileSync(join(dir, "trace.json"), "{broken");
		assert.equal(readStatusPref(dir), true, "битый файл");
		writeFileSync(join(dir, "trace.json"), JSON.stringify({ other: 1 }));
		writeStatusPref(dir, false);
		assert.equal(readStatusPref(dir), false);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "trace.json"), "utf8")), { other: 1, statusLine: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Расширение на заглушке pi: команды, обработчики событий, виджет. */
function harness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, ((e: any, ctx: any) => unknown)[]>();
	const widgets: (string[] | undefined)[] = [];
	const notes: string[] = [];
	trace({
		on: (name: string, fn: (e: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
	} as any);
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/x",
		ui: {
			theme: { fg: (_c: string, t: string) => t },
			setWidget: (_k: string, lines: string[] | undefined) => widgets.push(lines),
			notify: (m: string) => notes.push(m),
		},
		sessionManager: {
			getHeader: () => HEADER,
			getEntries: () => ENTRIES.slice(),
			getLeafId: () => "a5",
			getSessionFile: () => undefined,
		},
	};
	const emit = async (name: string, event: object = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	const flush = () => new Promise((r) => setTimeout(r, 150)); // склейка перерисовки 100 мс
	return { commands, ctx, emit, flush, widgets, notes };
}

test("/trace on|off: строка рисуется по событиям pi и скрывается, выбор сохраняется", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trace-agent-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const h = harness();
		await h.emit("session_start");
		await h.flush();
		assert.match(h.widgets.at(-1)?.[0] ?? "", /T4 · ошибка/);

		await h.emit("agent_start");
		await h.emit("tool_execution_start", { toolName: "bash", args: { command: "npm test" } });
		await h.flush();
		assert.match(h.widgets.at(-1)?.[0] ?? "", /⚒ bash npm test/);
		await h.emit("agent_end");

		await h.commands.get("trace").handler("off", h.ctx);
		await h.flush();
		assert.equal(h.widgets.at(-1), undefined, "строка снята");
		assert.match(h.notes.at(-1) ?? "", /\/trace on — вернуть/);
		assert.equal(readStatusPref(agentDir), false);

		await h.commands.get("trace").handler("on", h.ctx);
		await h.flush();
		assert.ok(h.widgets.at(-1)?.[0], "строка вернулась");
		await h.emit("session_shutdown");
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("/trace-web: старое имя работает с подсказкой про /trace web", async () => {
	const h = harness();
	await h.commands.get("trace-web").handler("missing.jsonl", h.ctx);
	assert.match(h.notes[0] ?? "", /\/trace-web устарела — используйте \/trace web/);
	assert.match(h.notes[1] ?? "", /файл сессии не найден/);
});
