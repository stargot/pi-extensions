/**
 * skill-auditor: read-only audit of pi skills — frontmatter validity, routing
 * triggers, references and the user-vs-project scope map. Skill files are
 * never moved or edited; the pipeline (discoverSkillLocations → discoverSkills
 * → auditSkills → buildReport) is pure and lives in ./skills.ts, ./lint.ts and
 * ./report.ts — this file is the thin pi wiring.
 *
 * `/audit` runs the pipeline for the session cwd and shows the markdown
 * report: in a TUI session in a scrollable viewer (ScrollReport, like
 * /handoff), elsewhere as a brief notify (severity counters + hint). The `go`
 * verb (semantic review prompt) arrives in T6 — the footer hint is plain text
 * for now.
 */
import { userInfo } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScrollReport } from "../shared/scroll-report.ts";
import { type Finding, auditSkills } from "./lint.ts";
import { buildReport } from "./report.ts";
import { discoverSkillLocations, discoverSkills } from "./skills.ts";

/** OS username for the personal-content check; undefined when unavailable. */
function currentUsername(): string | undefined {
	try {
		return userInfo().username;
	} catch {
		return undefined;
	}
}

/** "2 errors, 1 warning, 0 info — 3 skills audited" for the brief notify. */
function countersLine(findings: Finding[], skills: number): string {
	let errors = 0;
	let warnings = 0;
	let info = 0;
	for (const finding of findings) {
		if (finding.severity === "error") errors += 1;
		else if (finding.severity === "warning") warnings += 1;
		else info += 1;
	}
	const unit = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
	const skillsPart = skills === 1 ? "1 skill audited" : `${skills} skills audited`;
	return `${unit(errors, "error", "errors")}, ${unit(warnings, "warning", "warnings")}, ${info} info — ${skillsPart}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("audit", {
		description: "Read-only skill audit: frontmatter, routing, references, scope map",
		handler: async (_args, ctx) => {
			try {
				const locations = discoverSkillLocations(ctx.cwd, process.env);
				const discovery = discoverSkills(locations);
				const audit = auditSkills(discovery, { username: currentUsername() });

				if (ctx.hasUI && ctx.mode === "tui") {
					const report = buildReport(audit, { now: new Date(), cwd: ctx.cwd });
					await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
						return new ScrollReport({
							tui,
							theme,
							onClose: () => done(),
							render: (_width, th) => [
								// T6: здесь появится обработка go, пока это просто подсказка.
								th.fg("dim", " go — семантический разбор · esc — закрыть"),
								...report.split("\n"),
							],
							helpSuffix: " · /audit go",
						});
					});
					return;
				}
				ctx.ui.notify(
					`${countersLine(audit.findings, audit.scopeMap.length)} · /audit go — семантический разбор`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`skill-auditor: audit failed: ${message}`, "error");
			}
		},
	});
}
