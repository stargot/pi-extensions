/**
 * Secret discovery for env-guard: what counts as a secret and where to
 * look — dotenv-family files (.env, .env.local, .envrc) walking up from the
 * start dir to the filesystem root, plus process.env entries whose NAME
 * looks secret-bearing. A candidate is tracked only after passing the
 * plausibility gates, so obvious non-secrets never poison the redactor.
 * Collected values live in memory for the session; nothing is written down.
 *
 * I/O is injectable via CollectDeps so tests run without disk or env.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** One tracked secret: env-var-style key plus the exact value to redact. */
export interface SecretEntry {
	key: string;
	value: string;
}

/** An env file seen during collection: its path and how many usable
 *  secrets came out of it (drives the /env-guard status line). */
export interface FileSource {
	path: string;
	count: number;
}

/** What the last collection looked at: per-file secret counts and the
 *  secret-named env var names seen in process.env. */
export interface CollectionSources {
	files: FileSource[];
	envNames: string[];
}

/** Collection outcome: the deduped secret list plus the source summary. */
export interface CollectedSecrets {
	secrets: SecretEntry[];
	sources: CollectionSources;
}

/** Injectable I/O: tests override readFile/env instead of touching the
 *  real disk and process.env. */
export interface CollectDeps {
	readFile?: typeof readFile;
	env?: NodeJS.ProcessEnv;
}

/**
 * Secret-bearing NAME pattern: KEY/TOKEN/SECRET/PASSWD/PASSWORD/CREDENTIAL/
 * EMAIL/PRIVATE delimited by non-letters (matches OPENAI_API_KEY, not
 * MONKEY; KEYS does not match either). One pattern decides three things:
 * which process.env names to collect, the name branch of the admission
 * rule, and which KEY=value lines the redactor masks by name. False
 * positives are cheap (extra redaction); false negatives leak.
 */
export const SECRET_NAME_PATTERN =
	/(?:^|[^A-Za-z])(?:KEY|TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIAL|EMAIL|PRIVATE)(?![A-Za-z])/i;

/** Dotenv-family names collected, in lookup order per directory. Wider
 *  `.env.*` variants are denied by the guard but never parsed. */
export const ENV_FILE_NAMES: readonly string[] = [".env", ".env.local", ".envrc"];

/** True when a name looks secret-bearing (see SECRET_NAME_PATTERN). */
export function matchesSecretName(name: string): boolean {
	return SECRET_NAME_PATTERN.test(name);
}

/**
 * Shape gate for values: long enough to be real (≥ 8), no whitespace, and
 * not a trivial literal (bool/none words, plain integers, http(s) URLs).
 * First half of the admission rule's value branch — a convincing shape
 * tracks the value regardless of its key.
 */
export function isTrackableValue(value: string): boolean {
	if (value.length < 8) return false;
	if (/\s/.test(value)) return false;
	if (/^(?:true|false|none|null|undefined|0|1)$/i.test(value)) return false;
	if (/^[+-]?\d+$/.test(value)) return false;
	if (/^https?:\/\//i.test(value)) return false;
	return true;
}

/** Values that look secret-adjacent but never are (mode names, log
 *  levels, provider names); exported so the stop-list set and tests share
 *  one source of truth. */
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

/**
 * Plausibility gate applied on top of the shape gate: rejects numbers with
 * separators (versions like 10.0.19045), stop-listed common words, and
 * env-guard's own `[redacted:…]` markers — re-collecting a marker would
 * make the redactor target its own output.
 */
export function isPlausibleSecretValue(value: string): boolean {
	const normalized = value.toLowerCase();
	if (normalized.length < 8) return false;
	if (NUMERIC_VALUE_PATTERN.test(normalized)) return false;
	if (NON_SECRET_VALUES.has(normalized)) return false;
	if (REDACTED_MARKER_VALUE_PATTERN.test(normalized)) return false;
	return true;
}

/** True for values that must never be tracked even under a secret name:
 *  stop-listed words and redaction markers (case-insensitive). */
export function isStopListedSecretValue(value: string): boolean {
	const normalized = value.toLowerCase();
	return NON_SECRET_VALUES.has(normalized) || REDACTED_MARKER_VALUE_PATTERN.test(normalized);
}

/**
 * The admission rule (OR): a value with a convincing trackable+plausible
 * shape is tracked whatever its key; otherwise a secret-named key rescues
 * values clearing the relaxed floor (≥ 8 chars, no whitespace, not
 * stop-listed) — so `DATABASE_URL=https://…` is collected even though URLs
 * fail the shape gate, while `DEBUG_SECRET=true` is not. Under-collection
 * costs one unredacted value; over-collection spams the transcript with
 * markers, hence the strictness.
 */
export function isCollectableEntry(entry: SecretEntry): boolean {
	if (isTrackableValue(entry.value) && isPlausibleSecretValue(entry.value)) return true;
	if (!matchesSecretName(entry.key)) return false;
	if (isStopListedSecretValue(entry.value)) return false;
	return entry.value.length >= 8 && !/\s/.test(entry.value);
}

/**
 * Minimal dotenv parser: `KEY=VALUE` lines, optional `export ` prefix,
 * single/double quotes stripped, unquoted trailing ` # comment` trimmed.
 * Unparseable lines are skipped silently — one malformed directive (e.g.
 * direnv shell code inside .envrc) must not abort the rest of the file.
 */
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

/**
 * Walk from startDir up to the filesystem root reading every ENV_FILE_NAMES
 * file found, then scan process.env for secret-named vars; dedup across
 * sources by key+value. Every readable file is reported (even with 0
 * secrets) so the deny handler can guard it, and every secret-named env
 * var is reported by name (even when its value was not collectable) so
 * command blocking works name-only.
 */
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
