/**
 * Integration test for the extension factory — no live pi, a minimal fake of
 * the ExtensionAPI/ExtensionContext surface bg-jobs touches. Verifies the
 * full job lifecycle: launch → registry state → terminal transition →
 * delivery (steer for model+wake, notify otherwise) → trace card → widget
 * bookkeeping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bgJobs from "../index.ts";
import { readRegistry } from "../registry.ts";

const havePwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$true"], { stdio: "ignore" }).status === 0;

interface TraceEntry {
	type: string;
	data: {
		id: string;
		name: string;
		status: string;
		exitCode: number | null;
		durationSec: number | null;
		[k: string]: unknown;
	};
}

interface DeliveredMessage {
	message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

interface ToolResultLike {
	content: { type: string; text: string }[];
	details: Record<string, any>;
}

interface AnyTool {
	name: string;
	execute: (
		id: string,
		params: any,
		signal?: undefined,
		onUpdate?: undefined,
		ctx?: ExtensionContext,
	) => Promise<ToolResultLike>;
}

/** Minimal fake of pi's ExtensionAPI + ExtensionContext — only what bg-jobs touches. */
function fakePi(cwd: string, opts: { sessionId?: string; mode?: string } = {}) {
	const tools = new Map<string, AnyTool>();
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
	>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const entries: TraceEntry[] = [];
	const messages: DeliveredMessage[] = [];
	const notifications: { message: string; type?: string }[] = [];
	let widget: string[] | undefined;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
			handlers.set(event, handler);
		},
		registerTool(tool: AnyTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(
			name: string,
			cmd: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
		) {
			commands.set(name, cmd);
		},
		appendEntry(type: string, data: TraceEntry["data"]) {
			entries.push({ type, data });
		},
		sendMessage(message: DeliveredMessage["message"], options?: DeliveredMessage["options"]) {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		mode: opts.mode ?? "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => opts.sessionId ?? "sess-1" },
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			confirm: async () => true,
			setWidget(_key: string, content: string[] | undefined) {
				widget = content;
			},
			theme: { fg: (_c: string, t: string) => t },
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		tools,
		commands,
		handlers,
		entries,
		messages,
		notifications,
		get widget() {
			return widget;
		},
		async fireStart() {
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		},
		async fireShutdown(reason: string) {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason }, ctx);
		},
	};
}

/** Wait until `pred()` is true or the timeout elapses (watcher/exit are async). */
async function until(pred: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
	const start = Date.now();
	while (!(await pred())) {
		if (Date.now() - start > ms) throw new Error("condition not reached in time");
		await new Promise((r) => setTimeout(r, 50));
	}
}

function getTool(fake: ReturnType<typeof fakePi>, name: string): AnyTool {
	const t = fake.tools.get(name);
	assert.ok(t, `tool ${name} registered`);
	return t;
}

function getCommand(fake: ReturnType<typeof fakePi>, name: string) {
	const c = fake.commands.get(name);
	assert.ok(c, `command ${name} registered`);
	return c;
}

test("factory registers the documented surface without touching disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-factory-"));
	try {
		const fake = fakePi(dir);
		bgJobs(fake.pi);
		assert.deepEqual([...fake.tools.keys()].sort(), ["bg_kill", "bg_logs", "bg_run", "bg_status"]);
		assert.deepEqual([...fake.commands.keys()].sort(), ["bg", "jobs", "kill", "logs"]);
		assert.ok(fake.handlers.has("session_start"));
		assert.ok(fake.handlers.has("session_shutdown"));
		// Контракт фабрики: ничего не спавнит и не читает диск сверх импортов.
		assert.equal(existsSync(join(dir, ".pi", "jobs")), false, "no registry dir before session_start");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bg_run happy path: registry row, terminal steer delivery, trace card", { skip: !havePwsh }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-happy-"));
	// .git на месте — session_start обязан добавить .pi/jobs/ в info/exclude.
	mkdirSync(join(dir, ".git", "info"), { recursive: true });
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();
		const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
		assert.ok(exclude.includes(".pi/jobs/"), "first start excludes .pi/jobs/ from git");

		const result = await getTool(fake, "bg_run").execute(
			"t1",
			{ name: "echo job", command: `Write-Output ECHO-RESULT` },
			undefined,
			undefined,
			fake.ctx,
		);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /Background job started\./);
		const id = result.details.id;
		assert.match(id, /^[0-9a-f]{8}$/);
		assert.equal(result.details.outputPath, `.pi/jobs/${id}/output.log`);
		assert.ok(result.details.pid > 0, "pid captured");
		assert.ok(existsSync(join(dir, ".pi", "jobs", id, "output.log")), "durable log exists right after spawn");
		assert.equal(readRegistry(dir).jobs[id]?.status, "running");

		await until(() => fake.messages.length > 0);
		const delivery = fake.messages[0];
		assert.equal(delivery.message.customType, "bg_job_result");
		assert.deepEqual(delivery.options, { triggerTurn: true, deliverAs: "steer" });
		assert.match(delivery.message.content, /ECHO-RESULT/, "wake tail carries job output");
		assert.match(delivery.message.content, /exit code 0/);
		assert.match(delivery.message.content, new RegExp(`\\.pi/jobs/${id}/output\\.log`));

		const record = readRegistry(dir).jobs[id];
		assert.ok(record, "job record present");
		assert.equal(record.status, "completed");
		assert.equal(record.exitCode, 0);
		assert.ok(record.endedAt);

		const trace = fake.entries.find((e) => e.type === "session-trace:bg-jobs");
		assert.ok(trace, "trace card written");
		assert.equal(trace.data.id, id);
		assert.equal(trace.data.status, "completed");
		assert.equal(trace.data.exitCode, 0);
		assert.ok(typeof trace.data.durationSec === "number");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("user-origin job notifies, never wakes the model; widget clears after /jobs", { skip: !havePwsh }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-user-"));
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();
		await getCommand(fake, "bg").handler("notif :: Write-Output HELLO-USER", fake.ctx);
		assert.match(fake.notifications[0]?.message ?? "", /started · pid \d+/, "/bg answers with id + pid");

		await until(() => fake.notifications.some((n) => /completed/.test(n.message)));
		assert.equal(fake.messages.length, 0, "user jobs never send model messages");

		// Виджет: running исчез — терминальное событие числится непрочитанным.
		assert.ok(fake.widget != null, "widget shows unread terminal event");
		assert.match(fake.widget[0], /0 running · 1 done/);

		// /jobs — «прочтение»: виджет исчезает.
		await getCommand(fake, "jobs").handler("", fake.ctx);
		assert.equal(fake.widget, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bg_status / bg_logs / bg_kill cover unknown-id errors and kill path", { skip: !havePwsh }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-tools-"));
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();

		await assert.rejects(
			() => getTool(fake, "bg_status").execute("t", { id: "deadbeef" }, undefined, undefined, fake.ctx),
			/No bg job/,
		);
		await assert.rejects(
			() => getTool(fake, "bg_logs").execute("t", { id: "deadbeef" }, undefined, undefined, fake.ctx),
			/No bg job/,
		);
		await assert.rejects(
			() => getTool(fake, "bg_kill").execute("t", { id: "deadbeef" }, undefined, undefined, fake.ctx),
			/No bg job/,
		);

		const empty = await getTool(fake, "bg_status").execute("t", {}, undefined, undefined, fake.ctx);
		assert.match(empty.content[0]?.text ?? "", /No background jobs yet/);

		// Kill a real long-running job mid-flight.
		const started = await getTool(fake, "bg_run").execute(
			"t",
			{ name: "sleeper", command: `Start-Sleep -Seconds 60`, wake: false },
			undefined,
			undefined,
			fake.ctx,
		);
		const id = started.details.id;
		const killed = await getTool(fake, "bg_kill").execute("t", { id }, undefined, undefined, fake.ctx);
		assert.match(killed.content[0]?.text ?? "", /Killed bg job/);
		await until(() => readRegistry(dir).jobs[id]?.status === "killed");
		assert.equal(readRegistry(dir).jobs[id]?.exitCode, null);

		// Killing again is an honest error: already finished.
		await assert.rejects(
			() => getTool(fake, "bg_kill").execute("t", { id }, undefined, undefined, fake.ctx),
			/already finished/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bg_kill on an npm-wrapped tree kills the whole tree (port-style fixture)", { skip: !havePwsh }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-tree-"));
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();
		// cmd → pwsh (grandchild): the npm-wrapper shape.
		const started = await getTool(fake, "bg_run").execute(
			"t",
			{ name: "wrapped sleeper", command: `cmd /c pwsh -NoProfile -Command "Start-Sleep -Seconds 120"` },
			undefined,
			undefined,
			fake.ctx,
		);
		const id = started.details.id;
		const wrapperPid = started.details.pid;
		// Discover the grandchild pid via wmic-style PowerShell query on children.
		await until(async () => {
			const out = spawnSync(
				"pwsh",
				["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${wrapperPid}").ProcessId`],
				{ encoding: "utf8" },
			);
			return (out.stdout ?? "").trim().length > 0;
		});
		const out = spawnSync(
			"pwsh",
			["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${wrapperPid}").ProcessId`],
			{ encoding: "utf8" },
		);
		const grandchild = Number.parseInt((out.stdout ?? "").trim(), 10);
		assert.ok(grandchild > 0, "grandchild pwsh found");

		await getTool(fake, "bg_kill").execute("t", { id }, undefined, undefined, fake.ctx);
		await until(() => readRegistry(dir).jobs[id]?.status === "killed");
		// The grandchild must be gone too — that is the whole point of tree kill.
		await until(() => {
			const check = spawnSync(
				"pwsh",
				[
					"-NoProfile",
					"-Command",
					`if (Get-Process -Id ${grandchild} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`,
				],
				{ encoding: "utf8" },
			);
			return (check.stdout ?? "").trim() === "dead";
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session_start adopts the registry: dead pid → orphaned; quit kills, reload keeps", {
	skip: !havePwsh,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-adopt-"));
	let adopteePid: number | null = null;
	try {
		const { insertJob } = await import("../registry.ts");
		const { spawnJob, isPidAlive } = await import("../runner.ts");

		// Джоб-сирота: статус running, но PID заведомо мёртв.
		await insertJob(dir, {
			id: "aaaaaaaa",
			name: "dead orphan",
			command: "echo bye",
			cwd: dir,
			shell: "pwsh",
			pid: 999999,
			status: "running",
			exitCode: null,
			startedAt: new Date(Date.now() - 60_000).toISOString(),
			endedAt: null,
			outputPath: ".pi/jobs/aaaaaaaa/output.log",
			origin: "model",
			wake: true,
			timeoutSeconds: null,
			sessionId: "sess-1",
			surviveExit: false,
		});

		// Живой джоб: реальный спавн, registry без child-handle — «усновлённый».
		const logFile = join(dir, ".pi", "jobs", "bbbbbbbb", "output.log");
		const child = spawnJob({ id: "bbbbbbbb", command: `Start-Sleep -Seconds 60`, cwd: dir, logFile });
		adopteePid = child.pid ?? null;
		await insertJob(dir, {
			id: "bbbbbbbb",
			name: "live adoptee",
			command: "Start-Sleep -Seconds 60",
			cwd: dir,
			shell: "pwsh",
			pid: child.pid ?? null,
			status: "running",
			exitCode: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
			outputPath: ".pi/jobs/bbbbbbbb/output.log",
			origin: "user",
			wake: false,
			timeoutSeconds: null,
			sessionId: "sess-1",
			surviveExit: true,
		});

		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();

		// Мёртвый PID без endedAt → orphaned + notify; живой остаётся running.
		await until(() => readRegistry(dir).jobs["aaaaaaaa"]?.status === "orphaned");
		assert.equal(readRegistry(dir).jobs["bbbbbbbb"]?.status, "running");
		assert.ok(isPidAlive(child.pid), "adoptee keeps running across session_start");
		assert.ok(
			fake.notifications.some((n) => n.message.includes("dead orphan")),
			"orphan discovery reported",
		);

		// /reload не убивает: джоб жив после session_shutdown(reload).
		await fake.fireShutdown("reload");
		assert.ok(isPidAlive(child.pid), "reload keeps jobs alive");
		assert.equal(readRegistry(dir).jobs["bbbbbbbb"]?.status, "running");

		// Повторный session_start (новый рантайм) снова подхватывает.
		const fake2 = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake2.pi);
		await fake2.fireStart();
		assert.equal(readRegistry(dir).jobs["bbbbbbbb"]?.status, "running");

		// quit: surviveExit → сирота (жива, помечена), потом явная зачистка.
		await fake2.fireShutdown("quit");
		await until(() => readRegistry(dir).jobs["bbbbbbbb"]?.status === "orphaned");
		assert.ok(isPidAlive(child.pid), "surviveExit job survives quit");
	} finally {
		// Живой pwsh держит tmp-каталог (cwd) — убить до rmSync, иначе EPERM.
		if (adopteePid != null) {
			const { killProcessTree } = await import("../../shared/proctree.ts");
			killProcessTree(adopteePid);
			await until(async () => {
				const { isPidAlive } = await import("../runner.ts");
				return !isPidAlive(adopteePid);
			});
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("timeout: watcher settles an over-budget job", { skip: !havePwsh }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-timeout-"));
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();
		const started = await getTool(fake, "bg_run").execute(
			"t",
			{ name: "slow", command: `Start-Sleep -Seconds 30`, timeoutSeconds: 2, wake: false },
			undefined,
			undefined,
			fake.ctx,
		);
		const id = started.details.id;
		await until(() => readRegistry(dir).jobs[id]?.status === "timeout", 20_000);
		assert.equal(readRegistry(dir).jobs[id]?.exitCode, null);
		const { isPidAlive } = await import("../runner.ts");
		await until(() => !isPidAlive(started.details.pid), 5000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timeoutSeconds 0/negative clamps to 1s, not an instant kill", { skip: !havePwsh }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-clamp-"));
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();
		const zero = await getTool(fake, "bg_run").execute(
			"t",
			{ name: "zero", command: `Write-Output ok`, timeoutSeconds: 0, wake: false },
			undefined,
			undefined,
			fake.ctx,
		);
		assert.equal(zero.details.timeoutSeconds, 1, "0 clamps to 1");
		const negative = await getTool(fake, "bg_run").execute(
			"t",
			{ name: "negative", command: `Write-Output ok`, timeoutSeconds: -7, wake: false },
			undefined,
			undefined,
			fake.ctx,
		);
		assert.equal(negative.details.timeoutSeconds, 1, "negative clamps to 1");
		const id = zero.details.id;
		await until(() => readRegistry(dir).jobs[id]?.status === "completed");
		assert.equal(readRegistry(dir).jobs[id]?.status, "completed", "job ran to completion, not killed at spawn");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/bg name separator: only ' :: ' with spaces splits; bare :: stays in the command", {
	skip: !havePwsh,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-sep-"));
	try {
		const fake = fakePi(dir, { sessionId: "sess-1" });
		bgJobs(fake.pi);
		await fake.fireStart();

		// PowerShell-статический член: голое "::" не режет команду.
		await getCommand(fake, "bg").handler("[math]::Round(3.7)", fake.ctx);
		await until(() => Object.keys(readRegistry(dir).jobs).length === 1);
		const bare = Object.values(readRegistry(dir).jobs)[0];
		assert.equal(bare.command, "[math]::Round(3.7)", "bare :: stays in the command verbatim");
		assert.equal(bare.name, "[math]::Round(3.7)", "name auto-generated from the whole command");

		// Имя отделяется только ' :: ' с пробелами вокруг.
		await getCommand(fake, "bg").handler("MyName :: Start-Sleep -Seconds 30", fake.ctx);
		await until(() => Object.keys(readRegistry(dir).jobs).length === 2);
		const named = Object.values(readRegistry(dir).jobs).find((j) => j.id !== bare.id);
		assert.equal(named?.name, "MyName");
		assert.equal(named?.command, "Start-Sleep -Seconds 30");

		// Оба тестовых джоба завершаются сами — дождаться перед rmSync (Windows).
		await until(() => readRegistry(dir).jobs[bare.id]?.status === "completed");
	} finally {
		// Sleeper может быть ещё жив — убить все running до rmSync (Windows
		// не даст удалить каталог, занятый процессом как cwd).
		try {
			const { killProcessTree } = await import("../../shared/proctree.ts");
			for (const j of Object.values(readRegistry(dir).jobs)) {
				if (j.status === "running" && j.pid != null) killProcessTree(j.pid);
			}
		} catch {
			// Best effort.
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("orphaned survivor: resurrects to running on session_start, killable via bg_kill", {
	skip: !havePwsh,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-resurrect-"));
	let survivorPid: number | null = null;
	try {
		const { insertJob } = await import("../registry.ts");
		const { spawnJob } = await import("../runner.ts");

		// Живый pwsh-процесс, помеченный orphaned: surviveExit-переживенец
		// после рестарта pi.
		const logFile = join(dir, ".pi", "jobs", "cccccccc", "output.log");
		const child = spawnJob({ id: "cccccccc", command: `Start-Sleep -Seconds 60`, cwd: dir, logFile });
		survivorPid = child.pid ?? null;
		await insertJob(dir, {
			id: "cccccccc",
			name: "survivor",
			command: "Start-Sleep -Seconds 60",
			cwd: dir,
			shell: "pwsh",
			pid: child.pid ?? null,
			status: "orphaned",
			exitCode: null,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			outputPath: ".pi/jobs/cccccccc/output.log",
			origin: "model",
			wake: true,
			timeoutSeconds: null,
			sessionId: "old-session",
			surviveExit: true,
		});

		const fake = fakePi(dir, { sessionId: "sess-2" });
		bgJobs(fake.pi);
		await fake.fireStart();

		// Воскрешение: живой pwsh-сирота снова running, endedAt очищен.
		await until(() => readRegistry(dir).jobs["cccccccc"]?.status === "running");
		assert.equal(readRegistry(dir).jobs["cccccccc"]?.endedAt, null);

		// bg_kill по сироте работает (was «already finished»): убивает и
		// финализирует в killed.
		const killed = await getTool(fake, "bg_kill").execute("t", { id: "cccccccc" }, undefined, undefined, fake.ctx);
		assert.match(killed.content[0]?.text ?? "", /Killed bg job/);
		await until(() => readRegistry(dir).jobs["cccccccc"]?.status === "killed");
		const { isPidAlive } = await import("../runner.ts");
		await until(() => !isPidAlive(survivorPid), 5000);

		// Доставка финала — только notify: сессия сменилась (sess-2 ≠ old-session),
		// steer в чужую сессию не уходит.
		assert.equal(fake.messages.length, 0, "no steer across sessions (wake guard by sessionId)");
		assert.ok(
			fake.notifications.some((n) => n.message.includes("killed")),
			"orphan kill delivered as user-facing notify",
		);
	} finally {
		if (survivorPid != null) {
			const { killProcessTree } = await import("../../shared/proctree.ts");
			const { isPidAlive } = await import("../runner.ts");
			killProcessTree(survivorPid);
			await until(() => !isPidAlive(survivorPid));
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
