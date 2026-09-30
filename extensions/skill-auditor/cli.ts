/**
 * skill-auditor CLI: аудит скиллов pi без запуска pi.
 *
 *   node extensions/skill-auditor/cli.ts [--json] [--dir <cwd>] [--agent-dir <dir>] [-h]
 *
 * Находки advisory: exit code 0 при любых находках; 1 — только ошибка окружения,
 * 2 — ошибка аргументов.
 */
import { userInfo } from "node:os";
import { auditSkills } from "./lint.ts";
import { buildReport, reportToJson } from "./report.ts";
import { discoverSkillLocations, discoverSkills } from "./skills.ts";

const usage = "usage: cli.ts [--json] [--dir <cwd>] [--agent-dir <dir>] [-h]\n";

function main(argv: string[]): number {
	let json = false;
	let cwd = process.cwd();
	let agentDir: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--dir" || arg === "--agent-dir") {
			const value = argv[i + 1];
			if (value === undefined) {
				process.stderr.write(`skill-audit: ${arg} requires a value\n${usage}`);
				return 2;
			}
			if (arg === "--dir") cwd = value;
			else agentDir = value;
			i++;
		} else if (arg === "-h" || arg === "--help") {
			process.stdout.write(usage);
			return 0;
		} else {
			process.stderr.write(`skill-audit: unknown argument ${arg}\n${usage}`);
			return 2;
		}
	}

	try {
		// --agent-dir подменяет каталог агента: discovery читает PI_CODING_AGENT_DIR из env.
		const env = agentDir ? { ...process.env, PI_CODING_AGENT_DIR: agentDir } : process.env;
		const discovery = discoverSkills(discoverSkillLocations(cwd, env));
		let username: string | undefined;
		try {
			username = userInfo().username;
		} catch {
			// без username personal-content матчит общий шаблон домашних путей
		}
		const audit = auditSkills(discovery, { username });
		const now = new Date();
		process.stdout.write(json ? reportToJson(audit, { now, cwd }) : buildReport(audit, { now, cwd }));
		return 0;
	} catch (error) {
		process.stderr.write(`skill-audit: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

process.exit(main(process.argv.slice(2)));
