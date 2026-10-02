/**
 * bg-jobs — фоновые shell-джобы для pi (Windows 11 + pwsh).
 *
 * Долгие команды (dev-серверы, watch'и, миграции, длинные тесты) запускаются
 * в фоне и не блокируют ход сессии. Модель и пользователь получают:
 * мгновенный возврат id + пути к output-файлу, durable-лог на диске,
 * уведомление о терминальном состоянии и (для модельных запусков) follow-up
 * ход с кратким итогом.
 *
 * Инструменты:  bg_run, bg_status, bg_logs, bg_kill
 * Команды:      /bg, /jobs, /logs, /kill
 *
 * Ключевой принцип (спека §4.1): рантайм расширения — НЕ владелец процессов.
 * Джобы спавнятся как независимые фоновые процессы, всё состояние живёт в
 * реестре на диске
 * (.pi/jobs/jobs.json в проекте), watcher тикает раз в секунду и восстанавливает
 * картину из реестра + PID-проверок — после /reload, после краша watcher'а,
 * после рестарта pi. Выход pi по умолчанию убивает живые джобы (kill дерева
 * через shared/proctree), при surviveExit — оставляет сирот с записью PID.
 *
 * БЕЗ песочницы: команда исполняется как локальный процесс с правами
 * пользователя и его доступами — тот же уровень доверия, что обычный bash-тул.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../shared/proctree.ts";
import {
	cleanTempFiles,
	ensureGitExcluded,
	foreignRegistryVersion,
	insertJob,
	isTerminal,
	mutateJob,
	newJobId,
	outputLogAbsPath,
	outputLogRelPath,
	readRegistry,
	resurrectJobSync,
	transitionJob,
	transitionJobSync,
	type JobRecord,
	type JobStatus,
} from "./registry.ts";
import { fmtElapsed, formatJobsTable, formatStatus, oneline } from "./format.ts";
import { isPidAlive, readLogTail, shouldTimeout, spawnJob, verifyKillTarget, type LogTailInfo } from "./runner.ts";

const WATCHER_TICK_MS = 1000;
const DEFAULT_TAIL_CHARS = 4096;
const MAX_TAIL_CHARS = 65536;
// Хвост в follow-up ходе модели: exit code + хвост ≤ 2К + путь к полному логу.
const WAKE_TAIL_CHARS = 2048;
const WIDGET_KEY = "bg-jobs";

// ── Module state (one set per live session; reset in session_start) ──
let latestPi: ExtensionAPI | null = null;
let latestCtx: ExtensionContext | null = null;
let projectCwd = "";
let sessionId = "";
/** Child handles for jobs spawned by THIS runtime — exit events settle them. */
let children = new Map<string, ChildProcess>();
/** Ids between registry insertion and child-handle attach (watcher skips). */
let launching = new Set<string>();
/** Terminal events the user has not seen yet (widget shows them until read). */
let unseen = new Set<string>();
let tickTimer: NodeJS.Timeout | null = null;

/**
 * MCP-style destructive hint for approval policies; pi 1.0.0 has no such
 * field in ToolDefinition, so it rides along structurally. Spread into the
 * bg_run/bg_kill tool literals — spread keeps registerTool's parameter
 * inference intact while attaching the extra property.
 */
const destructiveHint = { destructiveHint: true } as const;

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Report a bg-jobs runtime failure (watcher tick, exit handling, registry
 * I/O): notify in a TUI session, stderr otherwise. Fire-and-forget paths
 * must never throw or rethrow — an unhandled rejection here would crash pi.
 */
function reportRuntime(text: string, severity: "error" | "warning" = "error"): void {
	const ctx = latestCtx;
	if (ctx?.hasUI && ctx.mode === "tui") {
		try {
			ctx.ui.notify(text, severity);
			return;
		} catch {
			// Fall through to stderr.
		}
	}
	console.error(text);
}

export default function bgJobsExtension(pi: ExtensionAPI) {
	latestPi = pi;

	pi.on("session_start", (_event, ctx) => {
		latestPi = pi;
		latestCtx = ctx;
		projectCwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId() ?? "";
		children = new Map();
		launching = new Set();
		unseen = new Set();
		// First-start housekeeping: keep .pi/jobs/ out of git without touching
		// the user's .gitignore (idempotent, best effort).
		ensureGitExcluded(projectCwd);
		// Подчистить *.tmp от краша между write и rename (мусор по именованию).
		cleanTempFiles(projectCwd);
		adoptRegistry();
		// Чужая версия реестра: предупреждение и read-only сессия (файл
		// сохранён, архивная копия в jobs.json.bak).
		const foreignVersion = foreignRegistryVersion();
		if (foreignVersion !== null) {
			reportRuntime(
				`bg-jobs: .pi/jobs/jobs.json was written by unsupported registry version ${foreignVersion} — running read-only this session (foreign file preserved, backup at .pi/jobs/jobs.json.bak).`,
				"warning",
			);
		}
		startWatcher();
		updateWidget();
	});

	pi.on("session_shutdown", (event) => {
		stopWatcher();
		if (latestCtx?.hasUI && latestCtx.mode === "tui") {
			latestCtx.ui.setWidget(WIDGET_KEY, undefined);
		}
		if (event.reason === "quit" && projectCwd) {
			// Выход pi: идемпотентный kill всех running, кроме surviveExit.
			// /reload, /new, resume и fork НЕ убивают — новый session_start
			// подхватывает реестр по PID (спека §4.6, §8).
			for (const job of Object.values(readRegistry(projectCwd).jobs)) {
				if (job.status !== "running") continue;
				if (job.surviveExit) {
					transitionJobSync(projectCwd, job.id, "orphaned", null);
					continue;
				}
				if (job.pid != null) {
					// Guard переиспользованного PID: tree-kill только по своему
					// pwsh; живой чужой процесс не трогаем, джоб — orphaned.
					const check = verifyKillTarget(job.pid);
					if (check === "reused") {
						transitionJobSync(projectCwd, job.id, "orphaned", null);
						reportRuntime(
							`bg "${job.name}" (${job.id}): pid ${job.pid} now belongs to another process (not pwsh) — kill refused at shutdown, job marked orphaned.`,
							"warning",
						);
						continue;
					}
					if (check === "safe") killProcessTree(job.pid);
				}
				transitionJobSync(projectCwd, job.id, "killed", null);
			}
		}
		children = new Map();
		launching = new Set();
		unseen = new Set();
		latestCtx = null;
	});

	// ── Tool: bg_run ──

	pi.registerTool({
		...destructiveHint,
		name: "bg_run",
		label: "BG Run",
		description:
			"Run a long-lived shell command in the background (dev servers, watchers, migrations, long test suites) WITHOUT blocking your turn. " +
			"Returns immediately with { id, outputPath, pid }. When the job finishes and wake is true (the default), the harness AUTOMATICALLY " +
			"delivers the result — exit code, an output tail and the log path — as a steer message that starts a new turn; you do not need to do " +
			"anything to receive it. DO NOT write polling loops, sleep/wait commands, or repeatedly call bg_status/bg_logs to detect completion — " +
			"end the turn or keep working on other tasks; you will be woken. Set wake: false only when nobody needs the outcome (then check " +
			"bg_status/bg_logs on demand later). " +
			"NOT SANDBOXED: the command runs as a local process with the user's full permissions and accesses — the same trust level as the regular " +
			"shell tool. Do not run anything you would not run in the foreground. " +
			"Windows + PowerShell 7: the command is a PowerShell statement executed independently of the session (pwsh -NoProfile, hidden console).",
		parameters: Type.Object({
			name: Type.String({
				description: 'Short human label for tables, widget and notifications, e.g. "Typecheck watch"',
			}),
			command: Type.String({
				description: "Shell command to run (PowerShell 7, executes in the background, independent of this session)",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory (absolute, or relative to the project cwd); defaults to the project cwd",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Number({ description: "Kill the job after this many seconds; omit or null = no timeout" }),
			),
			wake: Type.Optional(
				Type.Boolean({
					description:
						"Wake the model with the result when the job finishes (default true). false = user-facing notification only",
				}),
			),
			surviveExit: Type.Optional(
				Type.Boolean({
					description: "Keep the job running when pi exits (default false — exiting pi kills running jobs)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			const record = await launch(
				{
					name: params.name,
					command: params.command,
					cwd: params.cwd,
					timeoutSeconds: params.timeoutSeconds ?? null,
					wake: params.wake ?? true,
					surviveExit: params.surviveExit ?? false,
					origin: "model",
				},
				ctx,
			);
			const wakeHint = record.wake
				? "You will be woken with the exit code, an output tail and the log path when it finishes — do not poll."
				: "wake=false: no automatic wake-up; check with bg_status/bg_logs when you need the outcome.";
			return {
				content: [
					{
						type: "text",
						text: `Background job started.\nid: ${record.id}\nname: ${record.name}\npid: ${record.pid ?? "?"}\nlog: ${record.outputPath}\n\nIt keeps running while you continue working. ${wakeHint}`,
					},
				],
				details: {
					id: record.id,
					name: record.name,
					command: record.command,
					pid: record.pid,
					outputPath: record.outputPath,
					status: record.status,
					wake: record.wake,
					surviveExit: record.surviveExit,
					timeoutSeconds: record.timeoutSeconds,
				},
			};
		},
	});

	// ── Tool: bg_status ──

	pi.registerTool({
		name: "bg_status",
		label: "BG Status",
		description:
			"Status of background shell jobs started with bg_run: id, name, status, started/ended, exit code and log path. " +
			"Without an id — all jobs (newest first, running first); with an id — a single job. " +
			"This is an on-demand inspection tool: do NOT poll it in loops to detect completion — bg_run (wake: true) wakes you automatically.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Job id; omit to list all jobs" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			if (params.id) {
				const job = jobs.find((j) => j.id === params.id);
				if (!job) throw new Error(noJobError(params.id, jobs));
				markSeen(job.id);
				return {
					content: [{ type: "text", text: formatJobsTable([job], Date.now()) }],
					details: { jobs: [jobSummary(job)] },
				};
			}
			if (jobs.length === 0) {
				return {
					content: [{ type: "text", text: "No background jobs yet — start one with bg_run." }],
					details: { jobs: [] },
				};
			}
			markSeen(); // listing all = reading every terminal event
			return {
				content: [{ type: "text", text: formatJobsTable(jobs, Date.now()) }],
				details: { jobs: jobs.map(jobSummary) },
			};
		},
	});

	// ── Tool: bg_logs ──

	pi.registerTool({
		name: "bg_logs",
		label: "BG Logs",
		description:
			"Tail of a background job's durable output log (.pi/jobs/<id>/output.log). Returns the last N characters with an honest truncation " +
			"marker, the total size and the full log path. Default tail 4096 chars, max 65536. On-demand tool: bg_run (wake: true) delivers the " +
			"tail automatically on completion — no polling loops.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id" }),
			tailChars: Type.Optional(
				Type.Number({
					description: `How many trailing characters to return (default ${DEFAULT_TAIL_CHARS}, max ${MAX_TAIL_CHARS})`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			const job = jobs.find((j) => j.id === params.id);
			if (!job) throw new Error(noJobError(params.id, jobs));
			const max = clampTailChars(params.tailChars);
			const tail = readLogTail(projectCwd, job, max);
			markSeen(job.id);
			const text = tail.exists ? tail.text : "(no output yet — the job has not written anything to its log)";
			return {
				content: [
					{
						type: "text",
						text: `bg "${job.name}" (${job.id}) · ${formatStatus(job.status)}${job.exitCode != null ? ` · exit ${job.exitCode}` : ""}\nfull log: ${job.outputPath} (${tail.totalChars} chars)\n--- last ${max} chars ---\n${text}`,
					},
				],
				details: {
					id: job.id,
					name: job.name,
					status: job.status,
					exitCode: job.exitCode,
					outputPath: job.outputPath,
					truncated: tail.truncated,
					totalChars: tail.totalChars,
				},
			};
		},
	});

	// ── Tool: bg_kill ──

	pi.registerTool({
		...destructiveHint,
		name: "bg_kill",
		label: "BG Kill",
		description:
			"Kill a running background job: terminates the whole process tree on Windows (npm wrappers, dev servers and grandchildren included) " +
			"and marks the job killed in the registry. Destructive: the job's processes die immediately without a chance to clean up.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id (from bg_run / bg_status)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			const job = jobs.find((j) => j.id === params.id);
			if (!job) throw new Error(noJobError(params.id, jobs));
			// orphaned — разрешимое состояние: живого сироту можно добить,
			// мёртвую — честно финализировать (см. guardedKill).
			if (isTerminal(job.status) && job.status !== "orphaned") {
				throw new Error(
					`bg job "${params.id}" already finished (${job.status}${job.exitCode != null ? `, exit ${job.exitCode}` : ""}). Live jobs: ${liveIds(jobs) || "none"}.`,
				);
			}
			const outcome = await guardedKill(job);
			if (outcome.orphaned) {
				throw new Error(
					`bg job "${job.name}" (${job.id}): pid ${job.pid} was reused by another process (image is not pwsh) — refusing to kill an unknown process tree; job marked orphaned in the registry.`,
				);
			}
			const record = await settleJob(job.id, "killed", null);
			const text = outcome.killed
				? `Killed bg job "${job.name}" (${job.id}) — process tree terminated. Log: ${job.outputPath}`
				: `bg job "${job.name}" (${job.id}) — its process was already gone; marked killed in the registry.`;
			return {
				content: [{ type: "text", text }],
				details: {
					id: job.id,
					name: job.name,
					status: record?.status ?? "killed",
					pid: job.pid,
					treeKilled: outcome.killed,
				},
			};
		},
	});

	// ── Commands ──

	pi.registerCommand("bg", {
		description:
			'Run a background shell job: /bg [--survive-exit] [name] :: <command> (separator " :: " needs the spaces)',
		handler: async (args, ctx) => {
			ensureSession(ctx);
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(
					'Usage: /bg [--survive-exit] [name] :: <command> — e.g. /bg dev :: npm run dev. Name is optional; the " :: " separator needs spaces around it, without it the whole line is the command (auto-named).',
					"warning",
				);
				return;
			}
			let rest = raw;
			let surviveExit = false;
			if (rest.startsWith("--survive-exit")) {
				surviveExit = true;
				rest = rest.slice("--survive-exit".length).trim();
			}
			let name = "";
			let command = rest;
			// Имя отделяется только " :: " С ПРОБЕЛАМИ вокруг: голое "::" — это
			// статический член PowerShell ([math]::Round(3.7)), резать по нему
			// значило бы искажать команды.
			const sep = rest.indexOf(" :: ");
			if (sep > 0) {
				name = rest.slice(0, sep).trim();
				command = rest.slice(sep + " :: ".length).trim();
			}
			if (!command) {
				ctx.ui.notify("No command given. Usage: /bg [--survive-exit] [name] :: <command>", "warning");
				return;
			}
			if (!name) name = oneline(command, 40);
			try {
				const record = await launch({ name, command, wake: false, surviveExit, origin: "user" }, ctx);
				ctx.ui.notify(
					`bg ${record.id} started · pid ${record.pid ?? "?"}\n${record.command}\nlog: ${record.outputPath}\n/jobs · /logs ${record.id} · /kill ${record.id}${surviveExit ? "\nsurvives pi exit (orphaned with pid on shutdown)" : ""}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`bg_run failed: ${msg(err)}`, "error");
			}
		},
	});

	pi.registerCommand("jobs", {
		description: "List background jobs: id, status, name, elapsed (bg-jobs)",
		handler: async (_args, ctx) => {
			ensureSession(ctx);
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			if (jobs.length === 0) {
				ctx.ui.notify("No background jobs yet — /bg <command> to start one.", "info");
				return;
			}
			markSeen();
			ctx.ui.notify(formatJobsTable(jobs, Date.now()), "info");
		},
	});

	pi.registerCommand("logs", {
		description: "Tail of a bg job's log: /logs <id> [chars]",
		handler: async (args, ctx) => {
			ensureSession(ctx);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const id = parts[0];
			if (!id) {
				ctx.ui.notify(
					`Usage: /logs <id> [chars] — ids via /jobs. Default tail ${DEFAULT_TAIL_CHARS} chars.`,
					"warning",
				);
				return;
			}
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			const job = jobs.find((j) => j.id === id);
			if (!job) {
				ctx.ui.notify(noJobError(id, jobs), "error");
				return;
			}
			const max = clampTailChars(parts[1] ? Number.parseInt(parts[1], 10) : undefined);
			const tail = readLogTail(projectCwd, job, max);
			markSeen(job.id);
			const body = tail.exists ? tail.text : "(no output yet — the job has not written anything to its log)";
			ctx.ui.notify(
				`bg "${job.name}" (${job.id}) · ${formatStatus(job.status)}${job.exitCode != null ? ` · exit ${job.exitCode}` : ""} · ${tail.totalChars} chars total\n${body}`,
				tail.truncated ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("kill", {
		description: "Kill a running bg job: /kill <id> (asks for confirmation)",
		handler: async (args, ctx) => {
			ensureSession(ctx);
			const id = args.trim().split(/\s+/)[0];
			if (!id) {
				ctx.ui.notify(`Usage: /kill <id> — ids via /jobs.`, "warning");
				return;
			}
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			const job = jobs.find((j) => j.id === id);
			if (!job) {
				ctx.ui.notify(noJobError(id, jobs), "error");
				return;
			}
			if (isTerminal(job.status) && job.status !== "orphaned") {
				ctx.ui.notify(`bg job "${id}" already finished (${job.status}).`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`/kill needs dialog UI to confirm — use bg_kill from the model side or a TUI session.`,
					"warning",
				);
				return;
			}
			const ok = await ctx.ui.confirm("Kill bg job?", `${job.name} (${job.id})\n${oneline(job.command, 100)}`);
			if (!ok) {
				ctx.ui.notify(`Cancelled — bg ${job.id} keeps running.`, "info");
				return;
			}
			const outcome = await guardedKill(job);
			if (outcome.orphaned) {
				ctx.ui.notify(
					`bg "${job.name}" (${job.id}): pid ${job.pid} was reused by another process (not pwsh) — kill refused, job marked orphaned.`,
					"error",
				);
				return;
			}
			await settleJob(job.id, "killed", null);
			ctx.ui.notify(
				outcome.killed
					? `Killed bg "${job.name}" (${job.id}) — process tree terminated.`
					: `bg "${job.name}" (${job.id}) — process was already gone; marked killed.`,
				"info",
			);
		},
	});

	// ── Internals ──

	/** Lightweight init if a tool/command somehow runs before session_start. */
	function ensureSession(ctx: ExtensionContext): void {
		if (projectCwd) return;
		projectCwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId() ?? "";
		ensureGitExcluded(projectCwd);
	}

	/**
	 * Подхват реестра на старте: running-джобы с мёртвым PID и без endedAt →
	 * orphaned (спека §4.6). Живые PID остаются running — watcher подхватывает
	 * их PID-опросом (эта сессия не держит их child-handle). Сирота, чей PID
	 * снова жив (surviveExit-переживенец после рестарта pi), воскресает в
	 * running — но только если образ процесса по-прежнему pwsh: живой чужой
	 * PID (reused) воскресению не подлежит. Доставка для воскресших — только
	 * notify при смене сессии: wake-гвард проверяет sessionId в момент
	 * доставки (deliverTerminal).
	 */
	function adoptRegistry(): void {
		const jobs = Object.values(readRegistry(projectCwd).jobs);
		const died: JobRecord[] = [];
		for (const job of jobs) {
			if (job.status === "orphaned") {
				if (verifyKillTarget(job.pid) !== "safe") continue;
				resurrectJobSync(projectCwd, job.id);
				continue;
			}
			if (job.status !== "running") continue;
			if (isPidAlive(job.pid)) continue;
			const settled = transitionJobSync(projectCwd, job.id, "orphaned", null);
			if (settled?.changed) died.push(settled.record);
		}
		if (died.length > 0) {
			for (const job of died) {
				unseen.add(job.id);
				appendTraceCard(job);
			}
			const list = died.map((j) => `${j.name} (${j.id})`).join(", ");
			latestCtx?.ui.notify(
				`bg job(s) died while no runtime was watching: ${list} — status orphaned. /logs <id> for output.`,
				"warning",
			);
		}
	}

	function startWatcher(): void {
		if (tickTimer) return; // уже тикает — повторный session_start/launch не плодят интервалы
		tickTimer = setInterval(() => {
			void watcherTick();
		}, WATCHER_TICK_MS);
		// pi живёт своей жизнью — тикер не должен держать event loop (важно и для
		// тестов: процесс с живым watcher'ом не зависает после конца прогона).
		tickTimer.unref?.();
	}

	function stopWatcher(): void {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	}

	async function watcherTick(): Promise<void> {
		// Fire-and-forget тик: I/O-ошибка реестра (ENOSPC/EPERM/удалённый
		// .pi/jobs/) не должна вылетать unhandled rejection'ом и ронять pi.
		try {
			if (!projectCwd) return;
			const jobs = Object.values(readRegistry(projectCwd).jobs);
			const now = Date.now();
			for (const job of jobs) {
				if (job.status !== "running" || launching.has(job.id)) continue;
				// Таймаут: бюджет исчерпан — kill дерева и статус timeout.
				if (shouldTimeout(job, now)) {
					const outcome = await guardedKill(job);
					if (!outcome.orphaned) await settleJob(job.id, "timeout", null);
					continue;
				}
				// Усыновлённый джоб (перезагрузка/краш): child-handle нет, живость —
				// только по дешёвому signal-0 (дорогая проверка имени образа —
				// только на kill-путях). Мёртв → orphaned (исход неизвестен).
				if (!children.has(job.id) && !isPidAlive(job.pid)) {
					await settleJob(job.id, "orphaned", null);
				}
			}
		} catch (err) {
			reportRuntime(`bg-jobs watcher tick failed: ${msg(err)}`);
		}
	}

	/**
	 * Общий спавн для bg_run и /bg: id генерируется до спавна, запись в
	 * реестре появляется ДО запуска процесса (краш между spawn и записью не
	 * оставляет незарегистрированных процессов), pid дописывается сразу.
	 */
	async function launch(
		opts: {
			name: string;
			command: string;
			cwd?: string;
			timeoutSeconds?: number | null;
			wake: boolean;
			surviveExit: boolean;
			origin: "model" | "user";
		},
		ctx: ExtensionContext,
	): Promise<JobRecord> {
		ensureSession(ctx);
		const spawnCwd = opts.cwd ? (isAbsolute(opts.cwd) ? opts.cwd : resolve(projectCwd, opts.cwd)) : projectCwd;
		if (!existsSync(spawnCwd)) throw new Error(`cwd does not exist: ${spawnCwd}`);
		// Таймаут 0/отрицательный убил бы джоб мгновенно после спавна — clamp.
		const timeoutSeconds =
			opts.timeoutSeconds != null && Number.isFinite(opts.timeoutSeconds) ? Math.max(1, opts.timeoutSeconds) : null;
		let id = newJobId(projectCwd);
		launching.add(id);
		try {
			const record: JobRecord = {
				id,
				name: opts.name,
				command: opts.command,
				cwd: spawnCwd,
				shell: "pwsh",
				pid: null,
				status: "running",
				exitCode: null,
				startedAt: new Date().toISOString(),
				endedAt: null,
				outputPath: outputLogRelPath(id),
				origin: opts.origin,
				wake: opts.wake,
				timeoutSeconds,
				sessionId,
				surviveExit: opts.surviveExit,
			};
			try {
				await insertJob(projectCwd, record);
			} catch (err) {
				// Коллизия id возможна только в межпроцессной гонке (внутри
				// рантайма newJobId сверяется с реестром) — одна тихая повторная
				// попытка с новым id; повторная коллизия идёт наружу.
				if (!/id collision/.test(msg(err))) throw err;
				launching.delete(id);
				id = newJobId(projectCwd);
				launching.add(id);
				record.id = id;
				record.outputPath = outputLogRelPath(id);
				await insertJob(projectCwd, record);
			}
			// Лог-файл создаёт spawn (openSync append) — до первой записи bg_logs
			// увидит пустой файл, а не отсутствие файла.
			const logFile = outputLogAbsPath(projectCwd, id);
			let child: ChildProcess;
			try {
				child = spawnJob({ id, command: opts.command, cwd: spawnCwd, logFile });
			} catch (err) {
				// Синхронный сбой спавна: джоб уже в реестре — финализируем честно.
				transitionJobSync(projectCwd, id, "failed", null);
				throw new Error(`failed to spawn bg job "${opts.name}" (${id}): ${msg(err)}`);
			}
			child.once("error", (err) => {
				// Спавн не удался (например, pwsh не найден) — финализируем.
				// Fire-and-forget с собственным catch: I/O-ошибка реестра здесь
				// тоже не должна становиться unhandled rejection'ом.
				void (async () => {
					try {
						await settleJob(id, "failed", null);
						latestCtx?.ui.notify(`bg "${opts.name}" (${id}) failed to start: ${msg(err)}`, "error");
					} catch (e) {
						reportRuntime(`bg-jobs failed to record spawn failure of "${opts.name}" (${id}): ${msg(e)}`);
					}
				})();
			});
			child.once("exit", (code) => {
				void onChildExit(id, code);
			});
			children.set(id, child);
			// Гонка launch vs session_shutdown(quit): shutdown видел запись с
			// pid:null и успел убить/помечить её, пока спавн ещё завершался.
			// Перечитываем реестр: запись больше не running — немедленно убиваем
			// свежеспавненный процесс под мёртвой записью и не воскрешаем её.
			const fresh = readRegistry(projectCwd).jobs[id];
			if (!fresh || fresh.status !== "running") {
				if (child.pid != null) killProcessTree(child.pid);
				children.delete(id);
				throw new Error(
					`bg job "${opts.name}" (${id}) was cancelled during launch (session shut down) — the just-spawned process was terminated.`,
				);
			}
			const updated = await mutateJob(projectCwd, id, { pid: child.pid ?? null });
			startWatcher();
			updateWidget();
			return updated;
		} finally {
			launching.delete(id);
		}
	}

	async function onChildExit(id: string, code: number | null): Promise<void> {
		try {
			// Сначала финализация (kill-путь мог успеть раньше — transition
			// идемпотентен), только потом удаление handle, чтобы тик между exit и
			// записью не успел пометить джоб orphaned.
			await settleJob(id, code === 0 ? "completed" : "failed", code);
		} catch (err) {
			// Fire-and-forget: I/O-ошибка реестра не должна становиться unhandled
			// rejection'ом и ронять pi; handle всё равно освобождаем.
			reportRuntime(`bg-jobs failed to settle job ${id} after exit: ${msg(err)}`);
		} finally {
			children.delete(id);
		}
	}

	/**
	 * Kill-путь с guard'ом переиспользованного PID: taskkill /T /F бьёт по
	 * дереву вслепую, поэтому перед выстрелом сверяется имя образа процесса
	 * (ожидаем наш pwsh; ожидание проверяет verifyKillTarget). PID не найден —
	 * процесс уже мёртв (killed=false, обычная финализация). Живой процесс НЕ
	 * pwsh — ОС выдала PID чужому процессу: НЕ бьём, джоб помечается orphaned
	 * с предупреждением о переиспользованном PID.
	 */
	async function guardedKill(job: JobRecord): Promise<{ killed: boolean; orphaned: boolean }> {
		const pid = job.pid;
		if (pid == null) return { killed: false, orphaned: false };
		const check = verifyKillTarget(pid);
		if (check === "reused") {
			await settleJob(job.id, "orphaned", null);
			reportRuntime(
				`bg "${job.name}" (${job.id}): pid ${pid} now belongs to another process (not pwsh) — kill refused, job marked orphaned.`,
				"warning",
			);
			return { killed: false, orphaned: true };
		}
		return { killed: check === "safe" ? killProcessTree(pid) : false, orphaned: false };
	}

	/**
	 * Единственный переход running → terminal + доставка: trace-карточка,
	 * follow-up ход модели (origin=model && wake && та же сессия) либо
	 * уведомление пользователю. Идемпотентен: повторный вызов для уже
	 * завершённого джоба ничего не доставляет. Wake-доставленный итог уже
	 * показан в диалоге — он не числится «непрочитанным» в виджете;
	 * notify-only события висят там, пока пользователь их не откроет.
	 */
	async function settleJob(id: string, status: JobStatus, exitCode: number | null): Promise<JobRecord | null> {
		const result = await transitionJob(projectCwd, id, status, exitCode);
		if (!result || !result.changed) return result?.record ?? null;
		const record = result.record;
		if (!deliverTerminal(record)) unseen.add(id);
		appendTraceCard(record);
		updateWidget();
		return record;
	}

	/** true = доставлено follow-up ходом модели; false = notify-only. */
	function deliverTerminal(record: JobRecord): boolean {
		const tail = readLogTail(projectCwd, record, WAKE_TAIL_CHARS);
		if (record.origin === "model" && record.wake && record.sessionId === sessionId && latestPi) {
			// Тот же механизм доставки итога, что у subagents: steer/new turn.
			latestPi.sendMessage(
				{
					customType: "bg_job_result",
					content: resultText(record, tail),
					display: true,
					details: {
						id: record.id,
						name: record.name,
						command: record.command,
						status: record.status,
						exitCode: record.exitCode,
						startedAt: record.startedAt,
						endedAt: record.endedAt,
						outputPath: record.outputPath,
						truncated: tail.truncated,
						totalChars: tail.totalChars,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return true;
		}
		notifyTerminal(record);
		return false;
	}

	function notifyTerminal(record: JobRecord): void {
		const ctx = latestCtx;
		if (!ctx) return;
		const exit = record.exitCode != null ? ` · exit ${record.exitCode}` : "";
		const severity = record.status === "completed" ? "info" : record.status === "failed" ? "error" : "warning";
		ctx.ui.notify(
			`${formatStatus(record.status)} · bg "${record.name}" (${record.id})${exit} · log: ${record.outputPath} — /logs ${record.id}`,
			severity,
		);
	}

	function resultText(record: JobRecord, tail: LogTailInfo): string {
		const duration = record.endedAt ? fmtElapsed(Date.parse(record.endedAt) - Date.parse(record.startedAt)) : "?";
		const header = `Background job "${record.name}" (${record.id}) ${formatStatus(record.status)} after ${duration}${
			record.exitCode != null ? ` — exit code ${record.exitCode}` : ""
		}.\nFull log: ${record.outputPath} (${tail.totalChars} chars).`;
		const body = tail.exists && tail.text ? `\n--- output tail ---\n${tail.text}` : "\n(no output was written)";
		const footer = record.status === "completed" ? "" : `\nUse bg_logs for more output if needed.`;
		return `${header}${body}${footer}`;
	}

	function appendTraceCard(record: JobRecord): void {
		// session-trace integration — по образцу session-trace:subagents.
		// Best effort by design: сломанная интеграция не роняет джобу.
		try {
			latestPi?.appendEntry("session-trace:bg-jobs", {
				id: record.id,
				name: record.name,
				command: record.command,
				status: record.status,
				exitCode: record.exitCode,
				startedAt: record.startedAt,
				endedAt: record.endedAt,
				durationSec: record.endedAt
					? Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000))
					: null,
				outputPath: record.outputPath,
				origin: record.origin,
			});
		} catch {
			// Optional integration.
		}
	}

	/** Пассивный виджет: «bg N running · M done» + свежие терминальные события. */
	function updateWidget(): void {
		const ctx = latestCtx;
		if (!ctx || ctx.mode !== "tui" || !projectCwd) return;
		const jobs = Object.values(readRegistry(projectCwd).jobs);
		const running = jobs.filter((j) => j.status === "running");
		const fresh = jobs.filter((j) => unseen.has(j.id));
		if (running.length === 0 && fresh.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const lines: string[] = [
			theme.fg("accent", `bg ${running.length} running${fresh.length > 0 ? ` · ${fresh.length} done` : ""}`),
		];
		const now = Date.now();
		for (const j of running.slice(0, 2)) {
			lines.push(theme.fg("dim", `▸ ${oneline(j.name, 40)} ${fmtElapsed(now - Date.parse(j.startedAt))}`));
		}
		for (const j of fresh.slice(0, 2)) {
			const exit = j.exitCode != null ? ` · exit ${j.exitCode}` : "";
			lines.push(
				theme.fg(
					j.status === "completed" ? "success" : "warning",
					`${formatStatus(j.status)} ${oneline(j.name, 40)}${exit}`,
				),
			);
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	function markSeen(id?: string): void {
		if (id) unseen.delete(id);
		else unseen.clear();
		updateWidget();
	}
}

// ── Module-level helpers (pure, outside the factory) ──

function clampTailChars(value: number | undefined): number {
	if (value == null || !Number.isFinite(value)) return DEFAULT_TAIL_CHARS;
	return Math.min(MAX_TAIL_CHARS, Math.max(1, Math.floor(value)));
}

function liveIds(jobs: JobRecord[]): string {
	return jobs
		.filter((j) => j.status === "running")
		.map((j) => j.id)
		.join(", ");
}

function noJobError(id: string, jobs: JobRecord[]): string {
	return `No bg job "${id}". All jobs: ${jobs.map((j) => j.id).join(", ") || "none"}.`;
}

function jobSummary(job: JobRecord) {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		startedAt: job.startedAt,
		endedAt: job.endedAt ?? undefined,
		exitCode: job.exitCode ?? undefined,
		outputPath: job.outputPath,
		pid: job.pid ?? undefined,
		origin: job.origin,
		wake: job.wake,
	};
}
