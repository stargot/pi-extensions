/**
 * Cross-platform process-tree termination, shared by the /workers kill command
 * and the task_batch abort/timeout paths. Windows: `taskkill /T /F` — Node's
 * kill() only reaches the direct child, while pi children spawn their own
 * grandchildren (bash, editors) that would otherwise survive. POSIX: signal
 * the direct child; escalating TERM → KILL is the caller's job.
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { execFileSync } from "node:child_process";

/**
 * Terminate `pid` and (on Windows) its whole process tree. Returns false when
 * the pid was already gone or could not be signalled — callers treat that as
 * success, the close event is what actually settles the wait.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (process.platform === "win32") {
		// /T = tree, /F = force. There is no graceful terminate on Windows;
		// this is the same mechanism the /workers kill command uses.
		try {
			execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
			return true;
		} catch {
			return false; // Already gone.
		}
	}
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false; // ESRCH — already gone.
	}
}
