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

export const SECRET_NAME_PATTERN =
	/(?:^|[^A-Za-z])(?:KEY|TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIAL|EMAIL|PRIVATE)(?![A-Za-z])/i;

export const ENV_FILE_NAMES: readonly string[] = [".env", ".env.local", ".envrc"];

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

export const NON_SECRET_VALUE_STOP_LIST: readonly string[] = [
	"true",
	"false",
	"yes",
	"no",
	"on",
	"off",
	"none",
	"null",
	"undefined",
	"production",
	"development",
	"staging",
	"test",
	"dev",
	"prod",
	"debug",
	"info",
	"warn",
	"error",
	"ddg",
	"duckduckgo",
	"langsearch",
];

const NON_SECRET_VALUES = new Set(NON_SECRET_VALUE_STOP_LIST);
const NUMERIC_VALUE_PATTERN = /^[+-]?\d+(?:\.\d+)*$/;
const REDACTED_MARKER_VALUE_PATTERN = /^\[redacted:[^\]]*\]$/;

export function isPlausibleSecretValue(value: string): boolean {
	const normalized = value.toLowerCase();
	if (normalized.length < 8) return false;
	if (NUMERIC_VALUE_PATTERN.test(normalized)) return false;
	if (NON_SECRET_VALUES.has(normalized)) return false;
	if (REDACTED_MARKER_VALUE_PATTERN.test(normalized)) return false;
	return true;
}

export function isStopListedSecretValue(value: string): boolean {
	const normalized = value.toLowerCase();
	return NON_SECRET_VALUES.has(normalized) || REDACTED_MARKER_VALUE_PATTERN.test(normalized);
}

export function isCollectableEntry(entry: SecretEntry): boolean {
	if (isTrackableValue(entry.value) && isPlausibleSecretValue(entry.value)) return true;
	if (!matchesSecretName(entry.key)) return false;
	if (isStopListedSecretValue(entry.value)) return false;
	return entry.value.length >= 8 && !/\s/.test(entry.value);
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
				if (!isCollectableEntry(entry)) continue;
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
		envNames.push(name);
		if (!isCollectableEntry({ key: name, value })) continue;
		const id = `${name}\u0000${value}`;
		if (seen.has(id)) continue;
		seen.add(id);
		secrets.push({ key: name, value });
	}

	return { secrets, sources: { files, envNames } };
}
