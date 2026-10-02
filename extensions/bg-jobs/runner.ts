/**
 * Process mechanics for bg-jobs: pwsh wrapping, independent background
 * spawning into a durable log file, PID liveness, timeout math and log
 * tailing.
 *
 * Ownership model (spec §4.1): the runtime is not the owner of processes.
 * Jobs spawn as independent background processes, all state lives in the
 * on-disk registry, and any
 * component rebuilds the picture from registry + PID checks — after /reload,
 * after a watcher crash, after pi restart.
 *
 * Tree kill lives in extensions/shared/proctree.ts (taskkill /T /F on
 * Windows) — the same verified mechanism subagents uses. TODO(posix): the
 * POSIX branch there signals only the direct child; when a POSIX port of
 * bg-jobs is wanted, extend proctree with process-group kill (setsid +
 * SIGKILL to -pgid) and reuse it here unchanged.
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobRecord } from "./registry.ts";
import { truncateTail, type LogTail } from "./format.ts";

/** Timeout budget spent? Pure — unit-tested without processes. */
export function shouldTimeout(record: JobRecord, nowMs: number): boolean {
	if (record.status !== "running" || record.timeoutSeconds == null) return false;
	const started = Date.parse(record.startedAt);
	return Number.isFinite(started) && nowMs - started >= record.timeoutSeconds * 1000;
}

/** PID liveness. Signal 0 works on Windows in Node; ESRCH = dead. */
export function isPidAlive(pid: number | null | undefined): boolean {
	if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
	try {
		process.kill(pid as number, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// EPERM on Windows means "alive but owned by someone else" — alive.
		return code === "EPERM";
	}
}

/** Result of the kill-target check: safe to kill / already gone / PID reused. */
export type KillTargetCheck = "safe" | "dead" | "reused";

/**
 * Guard against PID reuse for kill paths (everything that ends in
 * `taskkill /T /F`): OSes hand a dead process's pid to an innocent newcomer
 * within minutes, and a blind tree-kill would take out an unrelated process
 * tree. Before killing, the image name of the process is verified — we
 * expect our own pwsh wrapper. On Windows the name comes from
 * `Get-CimInstance Win32_Process`; elsewhere signal-0 is all we have.
 *
 * - "safe"   — image is pwsh (or alive by signal-0 off-Windows): kill away.
 * - "dead"   — pid does not exist (or the query yielded nothing): treat the
 *              job as already finished.
 * - "reused" — pid is alive but NOT pwsh: refuse to kill; the job is marked
 *              orphaned by the caller.
 *
 * Kill paths are rare user actions (bg_kill, /kill, shutdown, timeout), so
 * the cost of a CIM query (~a second) is fine here; the hot watcher tick
 * keeps using the cheap isPidAlive signal-0 check for liveness.
 */
export function verifyKillTarget(pid: number | null | undefined): KillTargetCheck {
	if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return "dead";
	if (process.platform !== "win32") return isPidAlive(pid) ? "safe" : "dead";
	let out = "";
	try {
		const res = spawnSync(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`],
			{ encoding: "utf8", timeout: 15_000, windowsHide: true },
		);
		out = (res.stdout ?? "")
			.trim()
			.toLowerCase()
			.replace(/\.exe$/, "");
	} catch {
		// Query infrastructure failed — no verified image, no kill.
	}
	if (!out) return "dead"; // No such process — already gone.
	return out === "pwsh" ? "safe" : "reused";
}

export interface ShellInvocation {
	file: string;
	args: string[];
}

/**
 * Wrap the user command for independent background execution on Windows:
 *
 *   pwsh -NoProfile -NonInteractive -Command "<encoding>; <command>; exit $LASTEXITCODE"
 *
 * - `-NoProfile`: no user profile noise or latency in a background job.
 * - `-NonInteractive`: a command that tries to prompt fails instead of
 *   hanging the job forever on an invisible console.
 * - UTF-8 output encoding first: guards against кракозябры from cp866/1251
 *   console codepages (spec §6). The full raw log is on disk regardless.
 * - `exit $LASTEXITCODE` propagates native exit codes (npm, git, tests) as
 *   the job's exit code on every pwsh version — 7.4 made this pwsh's own
 *   behavior, older pwsh would otherwise always exit 0.
 */
export function buildShellInvocation(command: string): ShellInvocation {
	const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}; exit $LASTEXITCODE`;
	return { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", wrapped] };
}

export interface SpawnSpec {
	/** Job id — its .pi/jobs/<id>/ directory receives output.log. */
	id: string;
	/** Raw user command (PowerShell). */
	command: string;
	/** Working directory for the command (absolute). */
	cwd: string;
	/** Absolute path of the durable log file (.pi/jobs/<id>/output.log). */
	logFile: string;
}

/**
 * Spawn the job as an independent background process, stdout+stderr appended
 * into the durable log. Returns the Node handle used for the exit event; the
 * process itself is not owned by the runtime and survives watcher death.
 *
 * Why NOT detached:true on Windows: Node's detached uses DETACHED_PROCESS +
 * CREATE_NEW_PROCESS_GROUP, and under those flags PowerShell 7's console
 * host produces NO output at all (and even -Command bodies appear not to
 * run) — verified empirically; windowsHide:true alone gives the child a
 * hidden console and works. Durability does not depend on the detached flag
 * anyway: on Windows children survive parent exit by default (no job-object
 * semantics), which is exactly what ADR-6 assumes — /reload keeps pi alive,
 * a normal pi exit leaves the process for our explicit session_shutdown
 * kill, and registry + PID rebuild the picture after crashes.
 */
export function spawnJob(spec: SpawnSpec): ChildProcess {
	mkdirSync(dirname(spec.logFile), { recursive: true });
	// Append mode: a job id is never reused, "a" only guards odd recreates.
	const fd = openSync(spec.logFile, "a");
	const { file, args } = buildShellInvocation(spec.command);
	const child = spawn(file, args, {
		cwd: spec.cwd,
		windowsHide: true, // hidden console, no window flash per job
		stdio: ["ignore", fd, fd], // stdout and stderr share the durable log
	});
	// The child got a dup of the fd; drop the parent's copy.
	child.once("spawn", () => {
		try {
			closeSync(fd);
		} catch {
			// Already closed.
		}
	});
	return child;
}

/** Read the whole durable log; "" when nothing was written (or no file yet). */
export function readLogText(logFile: string): string {
	if (!existsSync(logFile)) return "";
	try {
		return readFileSync(logFile, "utf8");
	} catch {
		return "";
	}
}

/**
 * Last `maxBytes` bytes of a file, decoded as UTF-8. Reads from the end of
 * the file (openSync/readSync) — a log without a cap can grow to gigabytes,
 * and none of that may enter memory just to show a 4К tail. When the window
 * opens in the middle of a multibyte UTF-8 sequence, the orphaned leading
 * continuation bytes are skipped instead of decoding into U+FFFD.
 */
function readLastBytes(logFile: string, maxBytes: number): { text: string; sizeBytes: number } {
	let fd: number | undefined;
	try {
		fd = openSync(logFile, "r");
		const size = fstatSync(fd).size;
		const window = Math.min(size, maxBytes);
		const buf = Buffer.alloc(window);
		const read = readSync(fd, buf, 0, window, size - window);
		let start = 0;
		if (window < size) {
			// 10xxxxxx = UTF-8 continuation byte; a run of them at the window
			// start belongs to a character whose head is outside the window.
			while (start < read && (buf[start] & 0xc0) === 0x80) start++;
		}
		return { text: buf.toString("utf8", start, read), sizeBytes: size };
	} catch {
		return { text: "", sizeBytes: 0 };
	} finally {
		if (fd != null) {
			try {
				closeSync(fd);
			} catch {
				// Already closed.
			}
		}
	}
}

/** Tail of the job's log with honest truncation info. */
export interface LogTailInfo extends LogTail {
	/** False when no log file exists at all (nothing written yet). */
	exists: boolean;
	/** Absolute path of the log file. */
	logFile: string;
}

/**
 * Tail of the job's log with honest truncation info. `exists: false` means
 * no log file at all (spawn just happened or the dir was cleaned).
 *
 * Only the tail window enters memory: the last `maxChars * 4` bytes (4 =
 * UTF-8 worst case, so the window always covers maxChars characters). For
 * logs larger than the window, `totalChars` is approximated by the file
 * size in bytes (≥ the character count — the marker errs on the high side);
 * smaller logs are read whole and exact.
 */
export function readLogTail(cwd: string, record: JobRecord, maxChars: number): LogTailInfo {
	const logFile = join(cwd, record.outputPath);
	if (!existsSync(logFile)) {
		return { text: "", truncated: false, totalChars: 0, exists: false, logFile };
	}
	const windowBytes = Math.max(1, maxChars) * 4;
	let sizeBytes = 0;
	try {
		sizeBytes = statSync(logFile).size;
	} catch {
		// Raced away between existsSync and here — fall through to empty read.
	}
	if (sizeBytes <= windowBytes) {
		const text = readLogText(logFile);
		return { ...truncateTail(text, maxChars, record.outputPath), exists: true, logFile };
	}
	const { text } = readLastBytes(logFile, windowBytes);
	const tail = truncateTail(text, maxChars, record.outputPath, sizeBytes);
	return { ...tail, exists: true, logFile };
}
