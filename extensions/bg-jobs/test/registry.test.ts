import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanTempFiles,
	ensureGitExcluded,
	foreignRegistryVersion,
	insertJob,
	jobsDir,
	mutateJob,
	newJobId,
	outputLogRelPath,
	readRegistry,
	registryFile,
	resurrectJobSync,
	transitionJob,
	transitionJobSync,
	writeRegistry,
	type JobRecord,
} from "../registry.ts";

function tmpProject(): string {
	return mkdtempSync(join(tmpdir(), "pi-bgjobs-reg-"));
}

function record(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		id: "b12ab34c",
		name: "Typecheck watch",
		command: "npm run typecheck -- --watch",
		cwd: "C:\\proj",
		shell: "pwsh",
		pid: 12345,
		status: "running",
		exitCode: null,
		startedAt: "2026-10-01T12:00:00.000Z",
		endedAt: null,
		outputPath: outputLogRelPath("b12ab34c"),
		origin: "model",
		wake: true,
		timeoutSeconds: null,
		sessionId: "s1",
		surviveExit: false,
		...overrides,
	};
}

test("readRegistry: missing/corrupt file → fresh registry, correct version", () => {
	const dir = tmpProject();
	try {
		assert.deepEqual(readRegistry(dir), { version: 1, jobs: {} });
		mkdirSync(join(dir, ".pi", "jobs"), { recursive: true });
		writeFileSync(registryFile(dir), "{ not json", "utf8");
		assert.deepEqual(readRegistry(dir), { version: 1, jobs: {} }, "corrupt file tolerated");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("write/read roundtrip preserves records; output path is registry-relative", () => {
	const dir = tmpProject();
	try {
		writeRegistry(dir, { version: 1, jobs: { b12ab34c: record() } });
		const reg = readRegistry(dir);
		assert.equal(reg.jobs["b12ab34c"]?.name, "Typecheck watch");
		assert.equal(reg.jobs["b12ab34c"]?.outputPath, ".pi/jobs/b12ab34c/output.log");
		assert.ok(existsSync(registryFile(dir)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("insertJob: adds under lock, colliding id throws", async () => {
	const dir = tmpProject();
	try {
		await insertJob(dir, record());
		await assert.rejects(() => insertJob(dir, record()), /id collision/);
		assert.equal(Object.keys(readRegistry(dir).jobs).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mutateJob: patches one job's own fields, carries the rest verbatim", async () => {
	const dir = tmpProject();
	try {
		await insertJob(dir, record());
		await insertJob(dir, record({ id: "ffffffff", name: "dev server", pid: null }));
		const updated = await mutateJob(dir, "b12ab34c", {
			pid: 999,
			exitCode: 0,
			status: "completed",
			endedAt: "2026-10-01T12:05:00.000Z",
		});
		assert.equal(updated.pid, 999);
		assert.equal(updated.command, "npm run typecheck -- --watch", "own untouched fields survive");
		const reg = readRegistry(dir);
		assert.equal(reg.jobs["ffffffff"]?.name, "dev server", "other job untouched");
		assert.equal(reg.jobs["b12ab34c"]?.pid, 999);
		await assert.rejects(() => mutateJob(dir, "no-such", { pid: 1 }), /not in the registry/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("registry race: concurrent mutations all land (module mutex serializes)", async () => {
	const dir = tmpProject();
	try {
		// Два параллельных bg_run: обе вставки и обе pid-дописки выживают.
		await Promise.all([
			insertJob(dir, record({ id: "11111111" })),
			insertJob(dir, record({ id: "22222222" })),
			insertJob(dir, record({ id: "33333333" })),
		]);
		await Promise.all([
			mutateJob(dir, "11111111", { pid: 101 }),
			mutateJob(dir, "22222222", { pid: 202 }),
			mutateJob(dir, "33333333", { pid: 303 }),
			mutateJob(dir, "11111111", { status: "completed", exitCode: 0 }),
		]);
		const reg = readRegistry(dir);
		assert.equal(reg.jobs["11111111"]?.pid, 101);
		assert.equal(reg.jobs["11111111"]?.status, "completed");
		assert.equal(reg.jobs["22222222"]?.pid, 202);
		assert.equal(reg.jobs["33333333"]?.pid, 303);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("transitionJob: running → terminal once, then idempotent no-op", async () => {
	const dir = tmpProject();
	try {
		await insertJob(dir, record());
		const first = await transitionJob(dir, "b12ab34c", "completed", 0);
		assert.equal(first?.changed, true);
		assert.equal(first?.record.endedAt != null, true, "endedAt stamped on transition");
		const second = await transitionJob(dir, "b12ab34c", "killed", null);
		assert.equal(second?.changed, false, "double-settle is a no-op");
		assert.equal(second?.record.status, "completed", "terminal status wins");
		assert.equal(second?.record.exitCode, 0);
		assert.deepEqual(transitionJobSync(dir, "no-such", "killed", null), null, "unknown id → null");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("transitionJob: orphaned is resolvable (kill a survivor), orphaned → orphaned is not", async () => {
	const dir = tmpProject();
	try {
		await insertJob(dir, record({ status: "orphaned", endedAt: "2026-10-01T12:01:00.000Z" }));
		const again = await transitionJobSync(dir, "b12ab34c", "orphaned", null);
		assert.equal(again?.changed, false, "orphaned → orphaned is a no-op");
		const resolved = await transitionJob(dir, "b12ab34c", "killed", null);
		assert.equal(resolved?.changed, true, "orphaned → killed resolves the orphan");
		assert.equal(resolved?.record.status, "killed");
		const twice = await transitionJob(dir, "b12ab34c", "failed", 1);
		assert.equal(twice?.changed, false, "resolved orphan is terminal — no further transitions");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resurrectJobSync: orphaned with live pid → running, bookkeeping cleared; others untouched", async () => {
	const dir = tmpProject();
	try {
		await insertJob(dir, record({ status: "orphaned", endedAt: "2026-10-01T12:01:00.000Z" }));
		const up = resurrectJobSync(dir, "b12ab34c");
		assert.equal(up?.changed, true);
		assert.equal(up?.record.status, "running");
		assert.equal(up?.record.endedAt, null, "terminal bookkeeping cleared so elapsed/timeout measure honestly");
		assert.equal(resurrectJobSync(dir, "b12ab34c"), null, "running job is not a resurrect candidate");

		await insertJob(
			dir,
			record({ id: "ffffffff", status: "completed", exitCode: 0, endedAt: "2026-10-01T12:02:00.000Z" }),
		);
		assert.equal(resurrectJobSync(dir, "ffffffff"), null, "terminal jobs never resurrect");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("foreign registry version: never overwritten, backup made, writes refused until v1 returns", () => {
	const dir = tmpProject();
	try {
		mkdirSync(jobsDir(dir), { recursive: true });
		const foreign = JSON.stringify({ version: 99, jobs: { zzzzzzzz: { id: "zzzzzzzz" } } });
		writeFileSync(registryFile(dir), foreign, "utf8");

		// Чтение: чужая версия видна, записи для этого рантайма пусты, бэкап снят.
		const reg = readRegistry(dir);
		assert.deepEqual(reg.jobs, {});
		assert.equal(foreignRegistryVersion(), 99);
		const backup = `${registryFile(dir)}.bak`;
		assert.ok(existsSync(backup), "archive copy jobs.json.bak created on detection");
		assert.equal(readFileSync(backup, "utf8"), foreign, "backup holds the foreign file verbatim");

		// Запись отказана, оригинальный файл не тронут.
		assert.throws(() => writeRegistry(dir, { version: 1, jobs: {} }), /refusing to write/);
		assert.equal(readFileSync(registryFile(dir), "utf8"), foreign, "foreign file untouched by refused writes");

		// Вернулся наш формат — read-only снимается, запись снова работает.
		writeFileSync(registryFile(dir), JSON.stringify({ version: 1, jobs: {} }), "utf8");
		readRegistry(dir);
		assert.equal(foreignRegistryVersion(), null);
		writeRegistry(dir, { version: 1, jobs: {} });
		assert.deepEqual(readRegistry(dir), { version: 1, jobs: {} });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cleanTempFiles: sweeps jobs.json.<pid>.tmp leftovers, keeps everything else", () => {
	const dir = tmpProject();
	try {
		mkdirSync(jobsDir(dir), { recursive: true });
		writeFileSync(join(jobsDir(dir), "jobs.json.424242.tmp"), "garbage", "utf8");
		writeFileSync(join(jobsDir(dir), "jobs.json"), "{}", "utf8");
		writeFileSync(join(jobsDir(dir), "unrelated.tmp"), "keep", "utf8");
		assert.equal(cleanTempFiles(dir), 1);
		assert.equal(existsSync(join(jobsDir(dir), "jobs.json.424242.tmp")), false, "tmp leftover removed");
		assert.ok(existsSync(join(jobsDir(dir), "jobs.json")), "registry kept");
		assert.ok(existsSync(join(jobsDir(dir), "unrelated.tmp")), "non-matching files kept");
		assert.equal(cleanTempFiles(dir), 0, "second sweep finds nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("transitionJobSync: writes synchronously (shutdown path)", async () => {
	const dir = tmpProject();
	try {
		await insertJob(dir, record());
		const r = transitionJobSync(dir, "b12ab34c", "killed", null);
		assert.equal(r?.changed, true);
		assert.equal(readRegistry(dir).jobs["b12ab34c"]?.status, "killed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("newJobId: 8 hex chars, unique against the registry", async () => {
	const dir = tmpProject();
	try {
		const id = newJobId(dir);
		assert.match(id, /^[0-9a-f]{8}$/);
		await insertJob(dir, record({ id }));
		const other = newJobId(dir);
		assert.notEqual(other, id);
		assert.match(other, /^[0-9a-f]{8}$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureGitExcluded: appends .pi/jobs/ once, no .git → false", () => {
	const withGit = tmpProject();
	try {
		mkdirSync(join(withGit, ".git", "info"), { recursive: true });
		writeFileSync(join(withGit, ".git", "info", "exclude"), "# comment\n", "utf8");
		assert.equal(ensureGitExcluded(withGit), true, "first call appends");
		const content = readFileSync(join(withGit, ".git", "info", "exclude"), "utf8");
		assert.ok(content.includes(".pi/jobs/"));
		assert.ok(content.includes("# comment"), "existing content preserved");
		assert.equal(ensureGitExcluded(withGit), false, "second call is a no-op");

		mkdirSync(join(withGit, ".git", "info"), { recursive: true });
		writeFileSync(join(withGit, ".git", "info", "exclude"), "existing\n.pi/jobs/\n", "utf8");
		assert.equal(ensureGitExcluded(withGit), false, "already excluded → false");
	} finally {
		rmSync(withGit, { recursive: true, force: true });
	}

	const noGit = tmpProject();
	try {
		assert.equal(ensureGitExcluded(noGit), false);
	} finally {
		rmSync(noGit, { recursive: true, force: true });
	}
});
