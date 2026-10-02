/**
 * Job registry: `.pi/jobs/jobs.json` in the project cwd — the single source
 * of truth that lets bg-jobs survive /reload and pi restarts. The runtime is
 * NOT the owner of processes; anyone (fresh runtime, CLI, tests) rebuilds the
 * picture by reading this file and PID-checking running entries.
 *
 * Writes are tmp+rename (atomic swap, a crash mid-write never corrupts the
 * file) and serialized through a module-level mutex, so parallel bg_run tool
 * calls from one assistant message can never interleave read-modify-write
 * cycles and lose an update. Cross-process writers remain last-writer-wins
 * on the whole file — same advisory semantics the subagents running-index
 * uses; readers heal via PID checks.
 *
 * Job ids are generated (8 hex chars) and inserted BEFORE the process is
 * spawned, so a crash between spawn and bookkeeping can never orphan an
 * unregistered process.
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const REGISTRY_VERSION = 1;

/** running → alive; everything else is terminal. */
export type JobStatus = "running" | "completed" | "failed" | "timeout" | "killed" | "orphaned";

/** One bg job as persisted in jobs.json (§4.3 of the spec). */
export interface JobRecord {
	/** 8 hex chars, locally unique, generated before spawn. */
	id: string;
	/** Human label — table rows, widget, notifications. */
	name: string;
	/** Raw command as given; executed via pwsh (see runner.buildShellCommand). */
	command: string;
	/** Absolute working directory the command runs in. */
	cwd: string;
	shell: "pwsh";
	/** OS pid after spawn; null in the gap between registration and spawn. */
	pid: number | null;
	status: JobStatus;
	exitCode: number | null;
	/** ISO timestamp. */
	startedAt: string;
	/** ISO timestamp; null while running. */
	endedAt: string | null;
	/** Registry-relative path of the durable output log. */
	outputPath: string;
	/** model = bg_run tool, user = /bg command. */
	origin: "model" | "user";
	/** Wake the model with a follow-up turn on terminal state (model origin). */
	wake: boolean;
	timeoutSeconds: number | null;
	/** pi session id that spawned the job. */
	sessionId: string;
	/** Survive pi exit (session_shutdown) as an ownerless orphan. */
	surviveExit: boolean;
}

/** Stored shape: `{ version, jobs: { [id]: JobRecord } }`. */
export interface RegistryFile {
	version: number;
	jobs: Record<string, JobRecord>;
}

export function jobsDir(cwd: string): string {
	return join(cwd, ".pi", "jobs");
}

export function registryFile(cwd: string): string {
	return join(jobsDir(cwd), "jobs.json");
}

/** Registry-relative log path, as stored in JobRecord.outputPath. */
export function outputLogRelPath(id: string): string {
	return `.pi/jobs/${id}/output.log`;
}

export function outputLogAbsPath(cwd: string, id: string): string {
	return join(cwd, outputLogRelPath(id));
}

export function isTerminal(status: JobStatus): boolean {
	return status !== "running";
}

/** Read the registry; missing or corrupt file → a fresh empty registry. */
export function readRegistry(cwd: string): RegistryFile {
	let parsed: RegistryFile;
	try {
		parsed = JSON.parse(readFileSync(registryFile(cwd), "utf8")) as RegistryFile;
	} catch {
		// Missing or corrupt — start clean (a corrupt file is overwritten by
		// the next write; that was always the deal).
		foreignRegistry = null;
		return { version: REGISTRY_VERSION, jobs: {} };
	}
	if (parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object") {
		if (parsed.version === REGISTRY_VERSION) {
			foreignRegistry = null;
			return parsed;
		}
		// Чужая версия: файл писан не нами — молча затирать его нельзя.
		// Read-only режим (записи отказываются), один раз снимается архивная
		// копия jobs.json.bak; режим сбрасывается, когда на диске снова v1.
		foreignRegistry = { version: parsed.version };
		archiveForeignRegistry(cwd);
		return { version: parsed.version, jobs: {} };
	}
	foreignRegistry = null;
	return { version: REGISTRY_VERSION, jobs: {} };
}

/** Last foreign registry version seen on disk; null = writable ours. */
let foreignRegistry: { version: number } | null = null;

/**
 * Version of an on-disk registry this build refuses to touch (read-only
 * mode), as of the most recent readRegistry. session_start surfaces this as
 * a warning; last read wins — reading a v1/missing/corrupt file re-enables
 * writes.
 */
export function foreignRegistryVersion(): number | null {
	return foreignRegistry?.version ?? null;
}

/**
 * One archival copy of the foreign file before anything could threaten it.
 * Best effort: a failed copy must not break reads — the original stays
 * untouched either way, read-only mode never writes.
 */
function archiveForeignRegistry(cwd: string): void {
	try {
		copyFileSync(registryFile(cwd), `${registryFile(cwd)}.bak`);
	} catch {
		// No backup — the original file itself is the only copy and it is
		// never overwritten in this mode.
	}
}

/** Atomic full-file write (tmp + rename). Prefer mutateJob. */
export function writeRegistry(cwd: string, registry: RegistryFile): void {
	if (foreignRegistry !== null) {
		throw new Error(
			`refusing to write .pi/jobs/jobs.json: on-disk registry version ${foreignRegistry.version} is not supported (this build understands version ${REGISTRY_VERSION}); the foreign file is preserved untouched, backup at jobs.json.bak`,
		);
	}
	mkdirSync(jobsDir(cwd), { recursive: true });
	const path = registryFile(cwd);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

// ── Module-level write mutex ──
// All read-modify-write cycles queue behind one promise chain, so parallel
// tool calls within a runtime serialize instead of clobbering each other.

let writeQueue: Promise<unknown> = Promise.resolve();

/** Run `fn` serialized after every previously queued mutation. */
export function locked<T>(fn: () => T): Promise<T> {
	const next = writeQueue.then(fn, fn);
	// The queue never rejects; individual results may.
	writeQueue = next.catch(() => undefined);
	return next;
}

/**
 * Stale-safe single-job mutation: reads the registry fresh from disk inside
 * the lock, applies `patch` to one job, writes back. Only the job's own
 * fields change — other entries are carried over verbatim from the fresh
 * read, never from a stale in-memory copy.
 */
export async function mutateJob(cwd: string, id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
	return locked(() => {
		const registry = readRegistry(cwd);
		const current = registry.jobs[id];
		if (!current) throw new Error(`bg job "${id}" is not in the registry`);
		const updated: JobRecord = { ...current, ...patch };
		registry.jobs[id] = updated;
		writeRegistry(cwd, registry);
		return updated;
	});
}

/** Serialized insertion of a pre-registered job (id must be unique). */
export async function insertJob(cwd: string, record: JobRecord): Promise<void> {
	await locked(() => {
		const registry = readRegistry(cwd);
		if (registry.jobs[record.id]) throw new Error(`bg job id collision: ${record.id}`);
		registry.jobs[record.id] = record;
		writeRegistry(cwd, registry);
	});
}

export interface TransitionResult {
	record: JobRecord;
	/** False when the job was already terminal — the call changed nothing. */
	changed: boolean;
}

function applyTransition(cwd: string, id: string, status: JobStatus, exitCode: number | null): TransitionResult | null {
	const registry = readRegistry(cwd);
	const current = registry.jobs[id];
	if (!current) return null;
	// Разрешимые источники: running (любой терминальный статус) и orphaned
	// (разрешение сироты — bg_kill//kill по пережившему reload джобу).
	// Повторный «orphaned → orphaned» — no-op, идемпотентность сохранена.
	const resolvable = current.status === "running" || (current.status === "orphaned" && status !== "orphaned");
	if (!resolvable) return { record: current, changed: false };
	const updated: JobRecord = { ...current, status, exitCode, endedAt: new Date().toISOString() };
	registry.jobs[id] = updated;
	writeRegistry(cwd, registry);
	return { record: updated, changed: true };
}

/**
 * running → terminal state machine step, serialized through the write mutex.
 * Idempotent: settling an already-settled job is a no-op that reports the
 * existing record (kill path races the child's exit event — exactly once
 * delivery is what matters).
 */
export async function transitionJob(
	cwd: string,
	id: string,
	status: JobStatus,
	exitCode: number | null,
): Promise<TransitionResult | null> {
	return locked(() => applyTransition(cwd, id, status, exitCode));
}

/**
 * Same transition without the mutex — ONLY for the session_shutdown/quit
 * path: the runtime is single-threaded, no other write can interleave, and
 * the final registry state must be on disk synchronously before pi exits.
 */
export function transitionJobSync(
	cwd: string,
	id: string,
	status: JobStatus,
	exitCode: number | null,
): TransitionResult | null {
	return applyTransition(cwd, id, status, exitCode);
}

/**
 * orphaned → running (session_start adopt path, synchronous like the rest
 * of startup): a job marked orphaned whose pid is ALIVE again after a pi
 * restart is a surviveExit survivor — the watcher adopts it by PID polling
 * and settles it on real exit. Clears the terminal bookkeeping (endedAt
 * back to null, exitCode stays null) so elapsed and timeout budgets measure
 * honestly. Delivery stays notify-only when the session changed — the wake
 * guard in index.ts checks sessionId at delivery time.
 */
export function resurrectJobSync(cwd: string, id: string): TransitionResult | null {
	const registry = readRegistry(cwd);
	const current = registry.jobs[id];
	if (!current || current.status !== "orphaned") return null;
	const updated: JobRecord = { ...current, status: "running", exitCode: null, endedAt: null };
	registry.jobs[id] = updated;
	writeRegistry(cwd, registry);
	return { record: updated, changed: true };
}

/** New 8-hex id, checked against the registry for local uniqueness. */
export function newJobId(cwd: string): string {
	const taken = new Set(Object.keys(readRegistry(cwd).jobs));
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (!taken.has(id)) return id;
	}
}

/**
 * Remove `jobs.json.<pid>.tmp` leftovers of a crash between writeFileSync
 * and renameSync. Session-start housekeeping: the naming includes the
 * writer's pid, so anything matching the pattern is garbage by definition.
 * Best effort — a busy file just waits for the next start.
 */
export function cleanTempFiles(cwd: string): number {
	let entries: string[];
	try {
		entries = readdirSync(jobsDir(cwd));
	} catch {
		return 0; // No jobs dir yet.
	}
	let removed = 0;
	for (const name of entries) {
		if (!/^jobs\.json\.\d+\.tmp$/.test(name)) continue;
		try {
			rmSync(join(jobsDir(cwd), name), { force: true });
			removed++;
		} catch {
			// Busy/locked — try again next start.
		}
	}
	return removed;
}

/**
 * First-start housekeeping: keep `.pi/jobs/` out of git WITHOUT touching the
 * user's .gitignore — append one line to `.git/info/exclude` when a .git dir
 * exists and the line is not there yet. Idempotent, best effort.
 */
export function ensureGitExcluded(cwd: string): boolean {
	const gitDir = join(cwd, ".git");
	if (!existsSync(gitDir)) return false;
	const excludeFile = join(gitDir, "info", "exclude");
	try {
		let current = "";
		try {
			current = readFileSync(excludeFile, "utf8");
		} catch {
			// No exclude file yet — create below.
		}
		if (current.split(/\r?\n/).includes(".pi/jobs/")) return false;
		const line = current.endsWith("\n") || current === "" ? "" : "\n";
		mkdirSync(join(gitDir, "info"), { recursive: true });
		writeFileSync(excludeFile, `${current}${line}.pi/jobs/\n`, "utf8");
		return true;
	} catch {
		return false; // Read-only .git etc. — jobs still work, just not hidden.
	}
}
