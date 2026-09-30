/**
 * skill-auditor: read-only audit of pi skills — frontmatter validity, routing
 * triggers, references and the user-vs-project scope map. Skill files are
 * never moved or edited; the pipeline (discoverSkillLocations → discoverSkills
 * → auditSkills → buildReport) is pure and lives in ./skills.ts, ./lint.ts and
 * ./report.ts — this file is the thin pi wiring.
 *
 * `/audit` runs the pipeline for the session cwd and shows the markdown
 * report: in a TUI session in a scrollable viewer (ScrollReport, like
 * /handoff), elsewhere as a brief notify (severity counters + hint).
 * `/audit go` runs the same pipeline and, after a confirm, injects the report
 * into the model as a semantic review prompt (buildSemanticPrompt) via
 * pi.sendUserMessage — recommendations only, skill files stay untouched.
 */
import { userInfo } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScrollReport } from "../shared/scroll-report.ts";
import { auditSkills } from "./lint.ts";
import { buildSemanticPrompt } from "./prompt.ts";
import { buildReport, countBySeverity, summaryLine } from "./report.ts";
import { discoverSkillLocations, discoverSkills } from "./skills.ts";

/** OS username for the personal-content check; undefined when unavailable. */
function currentUsername(): string | undefined {
	try {
		return userInfo().username;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("audit", {
		description: "Read-only skill audit: frontmatter, routing, references, scope map",
		handler: async (args, ctx) => {
			try {
				const locations = discoverSkillLocations(ctx.cwd, process.env);
				const discovery = discoverSkills(locations);
				const audit = auditSkills(discovery, { username: currentUsername() });
				const report = buildReport(audit, { now: new Date(), cwd: ctx.cwd });

				// Same verb extraction as /handoff: "go" or anything starting with "go ".
				const verb = args.trim().split(/\s+/)[0] ?? "";
				if (verb === "go") {
					const ok = await ctx.ui.confirm(
						"Отправить отчёт модели на семантический разбор?",
						"Механический отчёт уйдёт модели как промпт: роутинг description, пересечения скиллов, кандидаты на перенос в .agents/skills и на disable-model-invocation. Только рекомендации — файлы скиллов не затрагиваются.",
					);
					if (!ok) return;
					pi.sendUserMessage(buildSemanticPrompt(report, ctx.cwd));
					return;
				}

				if (ctx.hasUI && ctx.mode === "tui") {
					await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
						return new ScrollReport({
							tui,
							theme,
							onClose: () => done(),
							render: (_width, th) => [
								th.fg("dim", " go — семантический разбор · esc — закрыть"),
								...report.split("\n"),
							],
							helpSuffix: " · /audit go",
						});
					});
					return;
				}
				// Та же формулировка, что и в секции Summary отчёта (report.ts) — единый источник.
				ctx.ui.notify(
					`${summaryLine(countBySeverity(audit.findings), audit.scopeMap.length)} · /audit go — семантический разбор`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`skill-auditor: audit failed: ${message}`, "error");
			}
		},
	});
}
