/**
 * Shared session-file helpers: sessions-directory resolution and discovery of
 * session JSONL files. Deliberately dependency-free (node built-ins only) so
 * the CLIs (ledger / recall / trace) and tests run without the pi runtime.
 *
 * Дедупликация: до 0.3.0 discoverSessionFiles жил копиями в session-recall и
 * session-ledger, а каталог сессий резолвился в четырёх местах — и trace CLI
 * успел отъехать от остальных (хардкод ~/.pi/agent/sessions без env).
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Sessions root: `$PI_CODING_AGENT_DIR/sessions`, по умолчанию
 * `~/.pi/agent/sessions`. `env` — параметр для тестируемости.
 */
export function resolveSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
	// || вместо ??: пустая PI_CODING_AGENT_DIR давала бы join('', 'sessions').
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
}

/** All session JSONL files under root (recursive), sorted by path. */
export function discoverSessionFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue; // файл исчез между readdir и stat
			}
			if (isDir) walk(full);
			else if (name.endsWith(".jsonl")) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

/** Накопитель usage поверх pi-формата сообщения (все поля опциональны). */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Прибавляет usage одного сообщения к накопителю; undefined безопасен. */
export function addUsage(
	target: UsageTotals,
	usage:
		| {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
		  }
		| undefined,
): void {
	if (!usage) return;
	target.input += usage.input ?? 0;
	target.output += usage.output ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.cacheWrite += usage.cacheWrite ?? 0;
	target.cost += usage.cost?.total ?? 0;
}
