import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface SecretEntry {
	key: string;
	value: string;
}

export interface FileSource {
	path: string;
	count: number;
}

export interface CollectionSources {
	files: FileSource[];
	envNames: string[];
}

export interface CollectedSecrets {
	secrets: SecretEntry[];
	sources: CollectionSources;
}

export interface CollectDeps {
	readFile?: typeof readFile;
	env?: NodeJS.ProcessEnv;
}

export const SECRET_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIAL|PRIVATE)/i;

export const ENV_FILE_NAMES: readonly string[] = [".env", ".env.local"];

export function matchesSecretName(name: string): boolean {
	return SECRET_NAME_PATTERN.test(name);
}

export function isTrackableValue(value: string): boolean {
	if (value.length < 8) return false;
	if (/\s/.test(value)) return false;
	if (/^(?:true|false|none|null|undefined|0|1)$/i.test(value)) return false;
	if (/^[+-]?\d+$/.test(value)) return false;
	if (/^https?:\/\//i.test(value)) return false;
	return true;
}

export function parseDotenv(text: string): SecretEntry[] {
	const entries: SecretEntry[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		let rest = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
		const eq = rest.indexOf("=");
		if (eq <= 0) continue;
		const key = rest.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
		let value = rest.slice(eq + 1).trim();
		if (value.length === 0) continue;
		const first = value[0];
		if ((first === '"' || first === "'") && value.length >= 2) {
			const last = value.lastIndexOf(first);
			if (last > 0) value = value.slice(1, last);
		} else {
			const hash = value.indexOf(" #");
			if (hash >= 0) value = value.slice(0, hash).trimEnd();
		}
		if (value.length === 0) continue;
		entries.push({ key, value });
	}
	return entries;
}

export async function collectSecrets(startDir: string, deps: CollectDeps = {}): Promise<CollectedSecrets> {
	const doRead = deps.readFile ?? readFile;
	const env = deps.env ?? process.env;
	const seen = new Set<string>();
	const secrets: SecretEntry[] = [];
	const files: FileSource[] = [];

	let dir = resolve(startDir);
	for (;;) {
		for (const name of ENV_FILE_NAMES) {
			const path = join(dir, name);
			let text: string;
			try {
				text = await doRead(path, "utf8");
			} catch {
				continue;
			}
			let count = 0;
			for (const entry of parseDotenv(text)) {
				if (!isTrackableValue(entry.value)) continue;
				const id = `${entry.key}\u0000${entry.value}`;
				if (seen.has(id)) continue;
				seen.add(id);
				secrets.push(entry);
				count += 1;
			}
			files.push({ path, count });
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const envNames: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (!matchesSecretName(name)) continue;
		if (!isTrackableValue(value)) continue;
		const id = `${name}\u0000${value}`;
		if (seen.has(id)) continue;
		seen.add(id);
		secrets.push({ key: name, value });
		envNames.push(name);
	}

	return { secrets, sources: { files, envNames } };
}
