/**
 * session-ledger: расходы и активность по всем сессиям pi.
 *
 *   /stats                         за 7 дней по проектам
 *   /stats <period> [<group>] [<project>]
 *       period: today | yesterday | 7d | 30d | all
 *       group:  project | model | day | tool | session
 *       project: подстрока имени проекта или пути cwd
 *
 * Читает ~/.pi/agent/sessions/**\/*.jsonl. Ничего не пишет.
 */
import { join } from "node:path";
import { BorderedLoader, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ScrollReport } from "../shared/scroll-report.ts";
import { buildLedger, GROUPS, parseArgs, PERIODS, type SessionSummary, type StatsArgs } from "./ledger.ts";
import { loadIndex, refreshSharedIndex, saveIndex } from "../shared/session-index.ts";
import { renderLedger, summaryLine } from "./report.ts";

export default function (pi: ExtensionAPI) {
	const sessionsDir = () => join(getAgentDir(), "sessions");

	const indexFile = () => join(getAgentDir(), "cache", "session-index.json");

	const build = (args: StatsArgs) => {
		// Персистентный индекс: полный разбор только изменившихся файлов.
		const data = loadIndex(indexFile());
		const refreshed = refreshSharedIndex(sessionsDir(), data);
		saveIndex(indexFile(), data);
		const sessions = Object.values(data.files)
			.filter((r) => r.summary)
			.map((r) => r.summary as SessionSummary);
		const skipped = refreshed.files - sessions.length;
		return buildLedger(sessions, args.period, { scanned: refreshed.files, skipped, project: args.project });
	};

	pi.registerCommand("stats", {
		description: "Session ledger: cost, tokens, cache, tool errors across all pi sessions (period, group, project)",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			const last = words.at(-1) ?? "";
			const before = words.slice(0, -1).join(" ");
			const candidates = [...PERIODS, ...GROUPS].filter((v) => v.startsWith(last) && !before.includes(v));
			const items = candidates.map((v) => ({ value: before ? `${before} ${v}` : v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");

			if (ctx.mode !== "tui") {
				// CLI/не-TUI путь: синхронный билд, как раньше — без лоадера и оверлея.
				const ledger = build(parsed);
				const text = renderLedger(ledger, parsed.by, 120).join("\n");
				ctx.ui.notify(ctx.hasUI ? summaryLine(ledger) : text, "info");
				if (!ctx.hasUI) process.stdout.write(`${text}\n`);
				return;
			}

			// Холодный /stats не должен выглядеть зависшим: оверлей открывается сразу
			// с лоадером («indexing sessions…»), тяжёлая индексация стартует после yield —
			// через два кадра рендера pi-tui (троттлинг MIN_RENDER_INTERVAL_MS = 16мс),
			// затем лоадер подменяется на отчёт. Esc во время индексации закрывает оверлей
			// и отменяет ожидание билда.
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let closed = false;
				let report: ScrollReport | undefined;

				const finish = () => {
					if (closed) return;
					closed = true;
					done();
				};

				const loader = new BorderedLoader(tui, theme, "indexing sessions…");
				loader.onAbort = () => finish();

				const timer = setTimeout(() => {
					if (closed || loader.signal.aborted) return;
					report = new ScrollReport({
						tui,
						theme,
						onClose: finish,
						// Как и раньше: первый рендер и `r` пересобирают ledger (перечитывают индекс).
						render: (width, th) => renderLedger(build(parsed), parsed.by, width, th),
						helpSuffix: " · args: today|yesterday|7d|30d|all · project|model|day|tool|session · <project>",
					});
					loader.dispose(); // гасим спиннер — дальше рисует ScrollReport
					tui.requestRender();
				}, 32);

				return {
					render: (width) => (report ?? loader).render(width),
					handleInput: (data) => (report ?? loader).handleInput(data),
					handleMouse: (event) => report?.handleMouse(event),
					invalidate: () => {
						loader.invalidate();
						report?.invalidate();
					},
					dispose: () => {
						clearTimeout(timer);
						loader.dispose();
					},
				};
			});
		},
	});
}
