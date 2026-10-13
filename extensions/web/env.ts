import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function parseDotEnv(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!key) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

export function loadDotEnv(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): Record<string, string> {
	const ceiling = projectRoot !== undefined ? resolve(projectRoot) : undefined;
	let dir = resolve(process.cwd());
	for (;;) {
		let text: string | undefined;
		try {
			text = readFileSync(join(dir, ".env"), "utf8");
		} catch {
			text = undefined;
		}
		if (text !== undefined) {
			const parsed = parseDotEnv(text);
			for (const [key, value] of Object.entries(parsed)) {
				if (env[key] === undefined) env[key] = value;
			}
			return parsed;
		}
		const parent = dirname(dir);
		if (ceiling !== undefined && dir === ceiling) break;
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}
