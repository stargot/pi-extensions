/**
 * trace — живой flow-граф сессии pi: ходы агента как карточки, вызовы
 * инструментов как чипы, компакции/смены модели как маркеры на таймлайне.
 *
 *   /trace            — текущая сессия, follow за живым хвостом
 *   /trace <file>     — replay любого JSONL по его timestamp'ам (space, ←→, +/-, l, r);
 *                       сессия живого task_batch-воркера — сразу live
 *   /trace web [file] — веб-вьюер в браузере (локальный сервер в процессе pi)
 *   /trace on | off   — строка состояния над редактором (запоминается глобально)
 *
 * Read-only по отношению к сессиям: только читает session-файл, ничего не пишет
 * и не блокирует агента. Пишет только свой <agentDir>/trace.json (on/off).
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { readRunningWorkers, runningIndexPath } from "../subagents/running-index.ts";

import { deriveSession, type SessionView, toolLabel } from "./core/model.ts";
import { SessionTree } from "./core/tree.ts";
import { TraceView } from "./graph.ts";
import { type LiveState, readStatusPref, renderStatusLine, writeStatusPref } from "./status.ts";
import { DEFAULT_PORT, newestSession, openBrowser, type ServeHandle, startServer } from "./web/serve.ts";

const subagentSessionsRoot = () => join(getAgentDir(), "sessions", "subagents");

/** Живые task_batch-воркеры из глобального индекса subagents; без индекса — пусто. */
function liveWorkers() {
	try {
		return readRunningWorkers(runningIndexPath(subagentSessionsRoot())).workers;
	} catch {
		return []; // индекс опционален
	}
}

type Completion = { value: string; label: string };

const SUBCOMMANDS: Completion[] = [
	{ value: "web", label: "web [файл] — веб-вьюер в браузере" },
	{ value: "on", label: "on — строка состояния над редактором" },
	{ value: "off", label: "off — скрыть строку состояния" },
];

/** Варианты аргумента /trace: живые воркеры (их нет среди сессий проекта) + 20 последних сессий cwd. */
async function loadCompletions(cwd: string): Promise<Completion[]> {
	const live = liveWorkers().map((w) => ({
		value: w.sessionFile,
		label: `● live · ${w.label}${w.mode ? ` (${w.mode})` : ""} · pid ${w.pid}`,
	}));
	const sessions = await SessionManager.list(cwd).catch(() => []);
	const recent = sessions.slice(0, 20).map((s) => ({
		value: s.path,
		label: `${basename(s.path)}${s.modified ? ` · ${new Date(s.modified).toLocaleString()}` : ""}`,
	}));
	return [...live, ...recent].slice(0, 30);
}

const STATUS_KEY = "trace";

export default function (pi: ExtensionAPI) {
	let active: TraceView | undefined;
	// Веб-сервер живёт в процессе pi: умирает вместе с ним (без сирот на порту),
	// а повторный /trace web просто переключает файл — без гонки kill/spawn.
	let web: Promise<ServeHandle> | undefined;

	// cwd сессии: в getArgumentCompletions ctx нет, а process.cwd() у pi может отличаться.
	let sessionCwd = process.cwd();

	// ---------- строка состояния ----------

	let statusOn = readStatusPref(getAgentDir());
	const live: LiveState = { busy: false, workers: 0 };
	let uiCtx: ExtensionContext | undefined;
	// Дерево копится инкрементально из записей SessionManager; модель пересчитывается
	// только при новых записях или смене листа (/tree), живые части — на каждом кадре.
	let tree = new SessionTree();
	let fed = 0;
	let view: { key: string; v: SessionView } | undefined;
	let workersAt = 0;
	let paintTimer: ReturnType<typeof setTimeout> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function paint(): void {
		paintTimer = undefined;
		const ctx = uiCtx;
		if (!ctx || ctx.mode !== "tui") return;
		if (!statusOn) {
			ctx.ui.setWidget(STATUS_KEY, undefined);
			return;
		}
		const sm = ctx.sessionManager;
		const entries = sm.getEntries();
		if (entries.length < fed) {
			tree = new SessionTree();
			fed = 0;
		}
		if (fed === 0) {
			const header = sm.getHeader();
			if (header) tree.add(header);
		}
		for (; fed < entries.length; fed++) tree.add(entries[fed]!);
		const now = Date.now();
		const leaf = sm.getLeafId();
		const key = `${fed}:${leaf}`;
		if (view?.key !== key) view = { key, v: deriveSession(tree, leaf, now) };
		if (now - workersAt > 5000) {
			workersAt = now;
			live.workers = liveWorkers().length;
		}
		const theme = ctx.ui.theme;
		ctx.ui.setWidget(STATUS_KEY, [renderStatusLine(view.v, live, now, (c, t) => theme.fg(c, t))]);
	}

	function schedulePaint(ctx?: ExtensionContext): void {
		if (ctx) uiCtx = ctx;
		paintTimer ??= setTimeout(paint, 100);
	}

	function setTicking(on: boolean): void {
		if (on && !ticker) {
			// Таймер инструмента и спиннер, пока агент работает.
			ticker = setInterval(() => schedulePaint(), 250);
			ticker.unref?.();
		} else if (!on && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		tree = new SessionTree();
		fed = 0;
		view = undefined;
		live.busy = false;
		live.tool = undefined;
		schedulePaint(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		live.busy = true;
		setTicking(true);
		schedulePaint(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		live.busy = false;
		live.tool = undefined;
		live.turnStartMs = undefined;
		setTicking(false);
		schedulePaint(ctx);
	});
	pi.on("turn_start", (_event, ctx) => {
		live.turnStartMs = Date.now();
		schedulePaint(ctx);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		live.tool = { name: event.toolName, label: toolLabel(event.args), startMs: Date.now() };
		schedulePaint(ctx);
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		live.tool = undefined;
		live.turnStartMs = Date.now(); // дальше модель отвечает на результат
		schedulePaint(ctx);
	});
	// Новые записи (ход, компакция, переход по /tree, имя) — перерисовать.
	pi.on("message_end", (_event, ctx) => schedulePaint(ctx));
	pi.on("session_compact", (_event, ctx) => schedulePaint(ctx));
	pi.on("session_tree", (_event, ctx) => schedulePaint(ctx));
	pi.on("session_info_changed", (_event, ctx) => schedulePaint(ctx));

	// Если сессию переключили/закрыли pi, пока оверлей открыт — прибрать за собой.
	pi.on("session_shutdown", async () => {
		setTicking(false);
		if (paintTimer) clearTimeout(paintTimer);
		paintTimer = undefined;
		uiCtx = undefined;
		active?.dispose();
		active = undefined;
		const server = web;
		web = undefined;
		await server?.then((h) => h.close()).catch(() => {});
	});

	// Кэш вариантов автодополнения /trace (промис: первый Tab ждёт загрузку, а не
	// получает пустоту; живые воркеры и сессии собираются в одном месте).
	let completions: Promise<Completion[]> | undefined;
	let completionsAt = 0;
	const sessionCompletions = () => {
		if (!completions || Date.now() - completionsAt > 10_000) {
			completionsAt = Date.now();
			completions = loadCompletions(sessionCwd);
		}
		return completions;
	};

	async function openWeb(arg: string, ctx: ExtensionCommandContext): Promise<void> {
		const file = arg ? resolve(ctx.cwd, arg) : ctx.sessionManager.getSessionFile();
		if (file && !existsSync(file)) {
			ctx.ui.notify(`trace: файл сессии не найден: ${file}`, "error");
			return;
		}
		const target = file ?? newestSession();
		let handle: ServeHandle;
		try {
			if (web) {
				handle = await web;
				handle.setFile(target);
			} else {
				// Привычный 8787, а если он занят (другой pi, чужой процесс) — любой свободный.
				web = startServer({ file: target, port: DEFAULT_PORT }).catch(() => startServer({ file: target, port: 0 }));
				handle = await web;
			}
		} catch (error) {
			web = undefined;
			ctx.ui.notify(`trace: веб-сервер не запустился: ${(error as Error).message}`, "error");
			return;
		}
		openBrowser(handle.url);

		const message = `trace: web — ${handle.url}${target ? ` · ${basename(target)}` : ""} · сервер остановится при закрытии сессии`;
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		else process.stdout.write(`${message}\n`);
	}

	function setStatusLine(on: boolean, ctx: ExtensionCommandContext): void {
		statusOn = on;
		try {
			writeStatusPref(getAgentDir(), on);
		} catch (error) {
			ctx.ui.notify(`trace: не удалось сохранить настройку: ${(error as Error).message}`, "warning");
		}
		schedulePaint(ctx);
		ctx.ui.notify(
			on
				? "trace: строка состояния включена · /trace off — скрыть"
				: "trace: строка состояния скрыта · /trace on — вернуть",
			"info",
		);
	}

	async function openOverlay(arg: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("trace: только в TUI-режиме", "warning");
			return;
		}
		const file = arg ? resolve(ctx.cwd, arg) : ctx.sessionManager.getSessionFile();
		if (!file || !existsSync(file)) {
			ctx.ui.notify(`trace: файл сессии не найден: ${file ?? "(ephemeral)"}`, "error");
			return;
		}
		// Явный файл — replay с начала, но сессию живого воркера смотрим с хвоста:
		// автодополнение помечает её «● live», и реплей ×8 там бесполезен.
		const isLiveWorker = liveWorkers().some((w) => resolve(w.sessionFile) === file);
		const mode = !arg || isLiveWorker ? "live" : "replay";

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const traceView = new TraceView({
				tui,
				theme,
				file,
				mode,
				// fullscreen (дефолт pi 1.0.0): оверлей живёт в editor-dock чат-вьюпорта,
				// над которым хост держит минимум 1 строку транскрипта (chat-viewport,
				// transcript minSize 1) — без резерва footer вью (позиция + подсказки)
				// обрезается. В regular-режиме вью рендерится во всю высоту, резерв
				// не нужен; cli.ts (свой alt-screen) использует дефолт 0.
				reserveRows: tui.mode === "fullscreen" ? 1 : 0,
				onClose: () => done(undefined),
			});
			active = traceView;
			return traceView;
		});

		active = undefined;
	}

	pi.registerCommand("trace", {
		description: "Flow graph of the session (trace): live follow or replay; web, on, off",
		getArgumentCompletions: async (prefix: string) => {
			// «web <файл>» — те же сессии, что и для оверлея.
			const webArg = /^web\s+(.*)$/.exec(prefix);
			if (webArg) {
				const rest = webArg[1]!;
				const files = (await sessionCompletions())
					.filter((c) => c.value.startsWith(rest))
					.map((c) => ({ value: `web ${c.value}`, label: c.label }));
				return files.length > 0 ? files : null;
			}
			const subs = SUBCOMMANDS.filter((c) => c.value.startsWith(prefix));
			const files = (await sessionCompletions()).filter((c) => c.value.startsWith(prefix));
			const all = [...subs, ...files];
			return all.length > 0 ? all : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const [sub = "", ...rest] = arg.split(/\s+/);
			if (sub === "on" || sub === "off") {
				setStatusLine(sub === "on", ctx);
				return;
			}
			if (sub === "web") {
				await openWeb(rest.join(" "), ctx);
				return;
			}
			await openOverlay(arg, ctx);
		},
	});

	// Старое имя: один релиз работает с подсказкой, затем будет удалено.
	pi.registerCommand("trace-web", {
		description: "Deprecated: use /trace web",
		handler: async (args, ctx) => {
			ctx.ui.notify("trace: /trace-web устарела — используйте /trace web", "warning");
			await openWeb((args ?? "").trim(), ctx);
		},
	});
}
