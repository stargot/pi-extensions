/**
 * trace — живой flow-граф сессии pi: ходы агента как карточки, вызовы
 * инструментов как чипы, компакции/смены модели как маркеры на таймлайне.
 *
 *   /trace            — текущая сессия, follow за живым хвостом
 *   /trace <file>     — replay любого JSONL по его timestamp'ам (space, ←→, +/-, l, r)
 *
 * Read-only: только читает session-файл, ничего не пишет и не блокирует агента.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { readRunningWorkers, runningIndexPath } from "../subagents/running-index.ts";

const subagentSessionsRoot = () => join(getAgentDir(), "sessions", "subagents");
import { TraceView } from "./graph.ts";
import { DEFAULT_PORT, newestSession, openBrowser, type ServeHandle, startServer } from "./web/serve.ts";

export default function (pi: ExtensionAPI) {
	let active: TraceView | undefined;
	// Веб-сервер живёт в процессе pi: умирает вместе с ним (без сирот на порту),
	// а повторный /trace-web просто переключает файл — без гонки kill/spawn.
	let web: Promise<ServeHandle> | undefined;

	// Если сессию переключили/закрыли pi, пока оверлей открыт — прибрать за собой.
	pi.on("session_shutdown", async () => {
		active?.dispose();
		active = undefined;
		const server = web;
		web = undefined;
		await server?.then((h) => h.close()).catch(() => {});
	});

	// Кэш списка сессий проекта для автодополнения аргумента /trace
	let completions: { value: string; label: string }[] | undefined;
	let completionsAt = 0;

	pi.registerCommand("trace", {
		description: "Flow graph of the session (trace): live follow or replay",
		getArgumentCompletions: (prefix: string) => {
			if (Date.now() - completionsAt > 10_000) {
				completionsAt = Date.now();
				SessionManager.list(process.cwd())
					.then((sessions) => {
						completions = sessions.slice(0, 20).map((s) => ({
							value: s.path,
							label: `${basename(s.path)}${s.modified ? ` · ${new Date(s.modified).toLocaleString()}` : ""}`,
						}));
					})
					.catch(() => {
						completions = [];
					});
				// Живые task_batch-воркеры лежат в глобальном subagents-кталоге, а не
				// в сессиях текущего проекта — без этого их можно найти только по PID.
				try {
					const { workers } = readRunningWorkers(runningIndexPath(subagentSessionsRoot()));
					const live = workers.map((w) => ({
						value: w.sessionFile,
						label: `● live · ${w.label}${w.mode ? ` (${w.mode})` : ""} · pid ${w.pid}`,
					}));
					completions = [...live, ...(completions ?? [])].slice(0, 30);
				} catch {
					// Индекс опционален — не ломаем автокомплит без него.
				}
			}
			if (!completions) return null;
			const filtered = completions.filter((c) => c.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("trace: только в TUI-режиме", "warning");
				return;
			}
			const arg = (args ?? "").trim();
			const file = arg ? resolve(ctx.cwd, arg) : ctx.sessionManager.getSessionFile();
			if (!file || !existsSync(file)) {
				ctx.ui.notify(`trace: файл сессии не найден: ${file ?? "(ephemeral)"}`, "error");
				return;
			}
			const mode = arg ? "replay" : "live";
			const isReplay = mode === "replay";

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const view = new TraceView({
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
				active = view;
				return view;
			});

			active = undefined;
			void isReplay; // режим выбирается внутри view; arg только выбирает файл
		},
	});

	// Веб-вьюер в браузере: локальный сервер в процессе pi (поднимается при первом
	// вызове, гаснет в session_shutdown); повторный вызов переключает файл.
	pi.registerCommand("trace-web", {
		description: "trace in the browser: local server + web viewer",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
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
		},
	});
}
