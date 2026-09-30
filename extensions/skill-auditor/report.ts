/**
 * Deterministic report rendering for the skill-auditor extension — the single
 * render source for the CLI (T4: text + `--json`), the `/audit` pi command (T5)
 * and the semantic prompt (T6). Pure: input is a SkillAuditResult (see
 * lint.ts), output is a string; no fs access, no pi imports, no implicit
 * current time.
 *
 * Determinism contract: identical input (including opts) → byte-identical
 * output. There is no `new Date()` and no locale-dependent formatting inside —
 * the caller injects `now`, rendered as local `YYYY-MM-DD HH:mm`.
 *
 * Markdown layout (buildReport):
 *
 *   # Skill audit
 *   header meta — cwd / date lines, each only when provided
 *   ## Scope map (N) — one line per skill: name — scope — location root, with
 *      "(shadowed)" when another directory claimed the name first (pi loads
 *      that other copy);
 *   ## Findings — severity groups in fixed order error → warning → info,
 *      skills alphabetical inside a group, one nested line per finding in the
 *      form "code: message"; with zero findings: "No findings — all skills
 *      pass";
 *   ## Summary — severity counters and skills audited.
 *
 * reportToJson renders the same information as stable JSON (2-space indent,
 * trailing newline): findings and scope map in the same deterministic order as
 * the markdown report, a summary object, and the header meta (cwd/date) only
 * when provided. Key order is fixed by construction, never by input shape.
 */
import type { Finding, FindingSeverity, SkillAuditResult, ScopeMapEntry } from "./lint.ts";

export interface ReportOptions {
	/** Report timestamp, rendered as `YYYY-MM-DD HH:mm` (local time). When
	 * omitted there is no date line — output stays deterministic. */
	now?: Date;
	/** Working directory for the header. When omitted there is no cwd line. */
	cwd?: string;
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ["error", "warning", "info"];

const SEVERITY_HEADINGS: Record<FindingSeverity, string> = {
	error: "Errors",
	warning: "Warnings",
	info: "Info",
};

const SCOPE_RANK: Record<ScopeMapEntry["scope"], number> = { user: 0, project: 1 };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Report ordering: severity (error → warning → info), then skill, code, message. */
function compareFindings(a: Finding, b: Finding): number {
	return (
		SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
		compareStrings(a.skill, b.skill) ||
		compareStrings(a.code, b.code) ||
		compareStrings(a.message, b.message)
	);
}

/** Scope-map ordering: name, then user before project, then dir. */
function compareScopeEntries(a: ScopeMapEntry, b: ScopeMapEntry): number {
	return compareStrings(a.name, b.name) || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || compareStrings(a.dir, b.dir);
}

/** Local `YYYY-MM-DD HH:mm`; zero-padded, no locale involvement. */
function formatTimestamp(date: Date): string {
	const part = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

function countBySeverity(findings: Finding[]): Record<FindingSeverity, number> {
	const counts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
	for (const finding of findings) counts[finding.severity] += 1;
	return counts;
}

/** "2 errors, 1 warning, 0 info — 3 skills audited." — English plural, no locale. */
function summaryLine(counts: Record<FindingSeverity, number>, skills: number): string {
	const unit = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
	const skillsPart = skills === 1 ? "1 skill audited" : `${skills} skills audited`;
	return `${unit(counts.error, "error", "errors")}, ${unit(counts.warning, "warning", "warnings")}, ${counts.info} info — ${skillsPart}.`;
}

/**
 * Render the audit as a deterministic markdown report (layout in the module
 * docs). Never sorts or mutates the input. The same input always yields
 * byte-identical output.
 */
export function buildReport(audit: SkillAuditResult, opts: ReportOptions = {}): string {
	const findings = [...audit.findings].sort(compareFindings);
	const scopeMap = [...audit.scopeMap].sort(compareScopeEntries);
	const counts = countBySeverity(findings);

	const lines: string[] = ["# Skill audit", ""];
	const meta: string[] = [];
	if (opts.cwd !== undefined) meta.push(`- cwd: \`${opts.cwd}\``);
	if (opts.now !== undefined) meta.push(`- date: ${formatTimestamp(opts.now)}`);
	if (meta.length > 0) lines.push(...meta, "");

	lines.push(`## Scope map (${scopeMap.length})`, "");
	if (scopeMap.length === 0) {
		lines.push("No skills discovered.", "");
	} else {
		for (const entry of scopeMap) {
			const shadowed = entry.shadowed ? " (shadowed)" : "";
			lines.push(`- ${entry.name} — ${entry.scope} — \`${entry.location}\`${shadowed}`);
		}
		lines.push("");
	}

	lines.push("## Findings", "");
	if (findings.length === 0) {
		lines.push("No findings — all skills pass", "");
	} else {
		for (const severity of SEVERITY_ORDER) {
			const group = findings.filter((finding) => finding.severity === severity);
			if (group.length === 0) continue;
			lines.push(`### ${SEVERITY_HEADINGS[severity]} (${group.length})`, "");
			let skill: string | null = null;
			for (const finding of group) {
				if (finding.skill !== skill) {
					skill = finding.skill;
					lines.push(`- **${skill}**`);
				}
				lines.push(`  - ${finding.code}: ${finding.message}`);
			}
			lines.push("");
		}
	}

	lines.push("## Summary", "", summaryLine(counts, scopeMap.length));
	return `${lines.join("\n")}\n`;
}

/**
 * Render the same information as the markdown report in stable JSON form
 * (2-space indent, trailing newline, fixed key order). Findings and scope map
 * come in the same deterministic order as in buildReport.
 */
export function reportToJson(audit: SkillAuditResult, opts: ReportOptions = {}): string {
	const findings = [...audit.findings].sort(compareFindings);
	const scopeMap = [...audit.scopeMap].sort(compareScopeEntries);
	const counts = countBySeverity(findings);
	const payload = {
		// undefined-поля JSON.stringify отбрасывает — порядок ключей стабилен.
		cwd: opts.cwd,
		date: opts.now === undefined ? undefined : formatTimestamp(opts.now),
		scopeMap: scopeMap.map((entry) => ({
			name: entry.name,
			scope: entry.scope,
			location: entry.location,
			dir: entry.dir,
			shadowed: entry.shadowed,
		})),
		findings: findings.map((finding) => ({
			skill: finding.skill,
			severity: finding.severity,
			code: finding.code,
			message: finding.message,
		})),
		summary: { errors: counts.error, warnings: counts.warning, info: counts.info, skills: scopeMap.length },
	};
	return `${JSON.stringify(payload, null, 2)}\n`;
}
