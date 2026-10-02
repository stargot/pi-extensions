import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { killProcessTree } from "../proctree.ts";

/** PID liveness probe — same signal-0 approach pi uses (running-index). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code !== "ESRCH"; // EPERM = alive but owned by someone else.
	}
}

/**
 * Shared kill-tree module, consumed by subagents and bg-jobs. Tests spawn
 * real processes (node itself — no network, no external services) and assert
 * the tree is actually gone after killProcessTree.
 */

/** Long-running node child that prints its own pid and never exits on its own. */
function spawnSleeper(): { pid: number; waitPid: Promise<number> } {
	const child = spawn(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000);"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const waitPid = (async () => {
		const [chunk] = (await once(child.stdout, "data")) as [Buffer];
		return Number.parseInt(chunk.toString().trim(), 10);
	})();
	return { pid: child.pid ?? -1, waitPid };
}

test("killProcessTree: rejects non-positive pids", () => {
	assert.equal(killProcessTree(0), false);
	assert.equal(killProcessTree(-5), false);
	assert.equal(killProcessTree(Number.NaN), false);
});

test("killProcessTree: kills a direct child", { skip: process.platform !== "win32" }, async () => {
	const { pid, waitPid } = spawnSleeper();
	const realPid = await waitPid;
	assert.equal(realPid, pid);
	assert.equal(isPidAlive(pid), true);
	try {
		assert.equal(killProcessTree(pid), true);
		// Wait until the pid is actually reaped (kill is async at the OS level).
		for (let i = 0; i < 50 && isPidAlive(pid); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.equal(isPidAlive(pid), false, "child should be dead after killProcessTree");
	} finally {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already dead — expected.
		}
	}
});

test("killProcessTree: kills grandchildren (cmd → node), Windows tree semantics", {
	skip: process.platform !== "win32",
}, async () => {
	// cmd.exe wraps node: the node process is a grandchild from the caller's
	// perspective — exactly the npm-wrapper shape proctree exists for.
	const wrapper = spawn(
		"cmd.exe",
		["/c", process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000);"],
		{
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const [chunk] = (await once(wrapper.stdout, "data")) as [Buffer];
	const grandchildPid = Number.parseInt(chunk.toString().trim(), 10);
	assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
	assert.equal(isPidAlive(grandchildPid), true);
	try {
		// Kill the cmd wrapper tree; the node grandchild must die with it.
		assert.equal(killProcessTree(wrapper.pid ?? -1), true);
		for (let i = 0; i < 50 && isPidAlive(grandchildPid); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.equal(isPidAlive(grandchildPid), false, "grandchild should die with the tree");
	} finally {
		for (const pid of [wrapper.pid, grandchildPid]) {
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already dead — expected.
				}
			}
		}
	}
});
