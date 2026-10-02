import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRecord } from "../registry.ts";
import {
	buildShellInvocation,
	isPidAlive,
	readLogTail,
	readLogText,
	shouldTimeout,
	spawnJob,
	verifyKillTarget,
} from "../runner.ts";

// pwsh — platform requirement of the package (Windows 11 + pwsh); CI runs on
// windows-latest. Everywhere else these fixture tests just skip.
const havePwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$true"], { stdio: "ignore" }).status === 0;
const pwshOnly = { skip: !havePwsh };

function job(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		id: "b12ab34c",
		name: "fixture",
		command: "echo hi",
		cwd: tmpdir(),
		shell: "pwsh",
		pid: null,
		status: "running",
		exitCode: null,
		startedAt: new Date().toISOString(),
		endedAt: null,
		outputPath: ".pi/jobs/b12ab34c/output.log",
		origin: "model",
		wake: true,
		timeoutSeconds: null,
		sessionId: "s1",
		surviveExit: false,
		...overrides,
	};
}

test("buildShellInvocation: pwsh -NoProfile wrapper embeds command and exit-code propagation", () => {
	const { file, args } = buildShellInvocation("npm run dev");
	assert.equal(file, "pwsh");
	assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
	const wrapped = args[3] ?? "";
	assert.ok(wrapped.startsWith("[Console]::OutputEncoding"), "UTF-8 output encoding set first");
	assert.ok(wrapped.includes("npm run dev"), "user command embedded verbatim");
	assert.ok(wrapped.endsWith("exit $LASTEXITCODE"), "native exit codes propagate");
});

test("shouldTimeout: pure math on running jobs only", () => {
	const now = Date.now();
	assert.equal(shouldTimeout(job({ timeoutSeconds: 10, startedAt: new Date(now - 11_000).toISOString() }), now), true);
	assert.equal(shouldTimeout(job({ timeoutSeconds: 10, startedAt: new Date(now - 9_000).toISOString() }), now), false);
	assert.equal(
		shouldTimeout(job({ timeoutSeconds: null, startedAt: new Date(now - 999_999).toISOString() }), now),
		false,
		"no timeout set",
	);
	assert.equal(
		shouldTimeout(
			job({ timeoutSeconds: 1, status: "completed", startedAt: new Date(now - 999_999).toISOString() }),
			now,
		),
		false,
		"terminal jobs never time out",
	);
});

test("isPidAlive: self alive, nonsense pids dead", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(-1), false);
	assert.equal(isPidAlive(null), false);
	assert.equal(isPidAlive(undefined), false);
});

test("verifyKillTarget: nonsense pid dead, own (non-pwsh) process is a reuse, pwsh is safe", pwshOnly, () => {
	assert.equal(verifyKillTarget(0), "dead");
	assert.equal(verifyKillTarget(-5), "dead");
	assert.equal(verifyKillTarget(null), "dead");
	// Заведомо несуществующий PID.
	assert.equal(verifyKillTarget(999_999), "dead");
	// Свой процесс — node, не pwsh: живой чужой образ = переиспользование.
	assert.equal(verifyKillTarget(process.pid), "reused");
	// Реальный pwsh — наш ожидаемый образ: safe.
	const child = spawn("pwsh", ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], { stdio: "ignore" });
	try {
		assert.ok(child.pid != null && isPidAlive(child.pid), "pwsh fixture alive");
		assert.equal(verifyKillTarget(child.pid), "safe", "our pwsh wrapper is the expected image");
	} finally {
		child.kill();
	}
});

test("readLogTail: missing log → exists=false, empty tail", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const r = readLogTail(dir, job(), 100);
		assert.equal(r.exists, false);
		assert.equal(r.text, "");
		assert.equal(r.truncated, false);
		assert.equal(r.totalChars, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnJob fixture echo: durable log receives stdout, exit code 0", pwshOnly, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const logFile = join(dir, ".pi", "jobs", "aaaaaaaa", "output.log");
		const child = spawnJob({ id: "aaaaaaaa", command: `Write-Output "hello-bg"`, cwd: dir, logFile });
		const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
		assert.equal(code, 0);
		assert.ok(existsSync(logFile), "log file pre-created by spawn");
		assert.ok(readLogText(logFile).includes("hello-bg"), "stdout lands in the durable log");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnJob fixture exit-code: non-zero exit propagates through the pwsh wrapper", pwshOnly, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const logFile = join(dir, ".pi", "jobs", "bbbbbbbb", "output.log");
		const child = spawnJob({ id: "bbbbbbbb", command: `Write-Error "boom" -ErrorAction Stop`, cwd: dir, logFile });
		const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
		assert.notEqual(code, 0, "terminating pwsh error → non-zero exit");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnJob fixture native exit code: cmd /c exit 3 → job exit 3", pwshOnly, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const logFile = join(dir, ".pi", "jobs", "cccccccc", "output.log");
		const child = spawnJob({ id: "cccccccc", command: `cmd /c exit 3`, cwd: dir, logFile });
		const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
		assert.equal(code, 3, "native command exit code propagates (exit $LASTEXITCODE)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnJob fixture sleep + killProcessTree: tree dies, log tail honest", pwshOnly, async () => {
	const { killProcessTree } = await import("../../shared/proctree.ts");
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const logFile = join(dir, ".pi", "jobs", "dddddddd", "output.log");
		const child = spawnJob({
			id: "dddddddd",
			command: `Write-Output "started"; Start-Sleep -Seconds 60`,
			cwd: dir,
			logFile,
		});
		// Wait until the job actually wrote its first line, then kill the tree.
		for (let i = 0; i < 50 && !readLogText(logFile).includes("started"); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(readLogText(logFile).includes("started"), "sleep job wrote its first line");
		assert.ok(child.pid != null && isPidAlive(child.pid), "sleeper is alive before kill");

		assert.equal(killProcessTree(child.pid as number), true);
		const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
		assert.notEqual(code, 0, "killed process does not exit cleanly");
		assert.equal(isPidAlive(child.pid), false, "pid dead after killProcessTree");

		const record = job({ id: "dddddddd", outputPath: ".pi/jobs/dddddddd/output.log" });
		const tail = readLogTail(dir, record, 4096);
		assert.equal(tail.exists, true);
		assert.ok(tail.text.includes("started"), "durable log survives the kill");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readLogTail: truncation marker on a big log", pwshOnly, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const logFile = join(dir, ".pi", "jobs", "eeeeeeee", "output.log");
		const child = spawnJob({
			id: "eeeeeeee",
			command: `Write-Output ("x" * 5000); Write-Output "TAIL-MARKER"`,
			cwd: dir,
			logFile,
		});
		await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
		const raw = readFileSync(logFile, "utf8");
		assert.ok(raw.length >= 5000);
		assert.ok(raw.includes("TAIL-MARKER"), "full log on disk intact (no cap introduced)");

		const tail = readLogTail(dir, job({ id: "eeeeeeee", outputPath: ".pi/jobs/eeeeeeee/output.log" }), 100);
		assert.equal(tail.truncated, true);
		assert.equal(tail.totalChars, raw.length, "ASCII log: byte size equals char count");
		assert.ok(tail.text.includes("TAIL-MARKER"), "tail keeps the end");
		assert.ok(tail.text.includes("output.log"), "marker names the full log");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readLogTail: multibyte log — window split is repaired, no U+FFFD at the tail head", pwshOnly, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-run-"));
	try {
		const logFile = join(dir, ".pi", "jobs", "ffffffff", "output.log");
		const child = spawnJob({
			id: "ffffffff",
			// Многобайтный префикс (по 2 байта/символ) + ascii-хвост: окно чтения
			// почти наверняка разрежет символ, починка не должна оставить U+FFFD.
			command: `Write-Output (("ж" * 9000) + "TAIL-MARKER-жж")`,
			cwd: dir,
			logFile,
		});
		await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
		const tail = readLogTail(dir, job({ id: "ffffffff", outputPath: ".pi/jobs/ffffffff/output.log" }), 64);
		assert.equal(tail.truncated, true);
		assert.ok(tail.text.includes("TAIL-MARKER"), "tail keeps the end");
		// Хвост после маркера не должен начинаться с fabricated U+FFFD.
		const body = tail.text.split("\n")[1] ?? "";
		assert.ok(
			!body.startsWith("\uFFFD"),
			`no fabricated replacement char at window start, got: ${JSON.stringify(body.slice(0, 3))}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
