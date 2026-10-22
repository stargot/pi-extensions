/**
 * Автодополнение /trace: первый Tab получает варианты (а не null, пока грузится
 * список сессий), живые task_batch-воркеры не теряются, когда список догружается.
 * Агентский каталог — временный (PI_CODING_AGENT_DIR), индекс воркеров пишется
 * настоящим addRunningWorker с PID этого процесса (он жив).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addRunningWorker, runningIndexPath } from "../../subagents/running-index.ts";
import trace from "../index.ts";

test("/trace completions: first call resolves with live workers kept", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trace-agent-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const workerFile = join(agentDir, "sessions", "subagents", "w1.jsonl");
		addRunningWorker(runningIndexPath(join(agentDir, "sessions", "subagents")), {
			id: "w1",
			pid: process.pid,
			label: "scout",
			task: "look around",
			startedAt: Date.now(),
			sessionFile: workerFile,
		});

		const commands = new Map<string, any>();
		trace({
			on: () => {},
			registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
		} as any);
		const complete = commands.get("trace").getArgumentCompletions;

		const first = await complete("");
		assert.ok(first, "первый вызов уже с вариантами");
		assert.deepEqual(
			first.slice(0, 3).map((c: { value: string }) => c.value),
			["web", "on", "off"],
			"подкоманды — первыми",
		);
		assert.equal(first[3].value, workerFile);
		assert.match(first[3].label, /● live · scout/);
		assert.deepEqual(
			(await complete("o")).map((c: { value: string }) => c.value),
			["on", "off"],
		);
		const webFiles = await complete("web ");
		assert.equal(webFiles[0].value, `web ${workerFile}`, "web дополняется теми же сессиями");

		// Повторный вызов из кэша, когда список сессий уже догрузился: воркер на месте
		// (раньше .then() списка затирал варианты, собранные вместе с воркерами).
		await new Promise((r) => setTimeout(r, 200));
		const again = await complete("");
		assert.ok(again.some((c: { value: string }) => c.value === workerFile));
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
