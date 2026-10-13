import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDotEnv, parseDotEnv } from "../env.ts";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-env-"));
}

function withCwd(dir: string, run: () => void): void {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		run();
	} finally {
		process.chdir(cwd);
	}
}

test("parseDotEnv: keys, comments, blanks, quotes, malformed lines", () => {
	const parsed = parseDotEnv(
		[
			"# comment line",
			"",
			"KEY=value",
			"  SPACED =  trimmed value  ",
			'QUOTED="quoted value"',
			"SINGLE='single quoted'",
			"EMPTY=",
			"NO_EQUALS_SIGN",
			"=nokey",
			"A=has = inside",
		].join("\n"),
	);
	assert.deepEqual(parsed, {
		KEY: "value",
		SPACED: "trimmed value",
		QUOTED: "quoted value",
		SINGLE: "single quoted",
		EMPTY: "",
		A: "has = inside",
	});
});

test("parseDotEnv: CRLF line endings", () => {
	assert.deepEqual(parseDotEnv("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
});

test("loadDotEnv: reads the nearest .env and fills the env object", () => {
	const root = makeTmp();
	try {
		writeFileSync(join(root, ".env"), "LANGSEARCH_API_KEY=test-key\nOTHER=1\n", "utf8");
		withCwd(root, () => {
			const env: NodeJS.ProcessEnv = {};
			const loaded = loadDotEnv(env, root);
			assert.deepEqual(loaded, { LANGSEARCH_API_KEY: "test-key", OTHER: "1" });
			assert.equal(env.LANGSEARCH_API_KEY, "test-key");
			assert.equal(env.OTHER, "1");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadDotEnv: walks up from a nested cwd", () => {
	const root = makeTmp();
	try {
		mkdirSync(join(root, "a", "b"), { recursive: true });
		writeFileSync(join(root, ".env"), "WALK=yes\n", "utf8");
		withCwd(join(root, "a", "b"), () => {
			const env: NodeJS.ProcessEnv = {};
			loadDotEnv(env, root);
			assert.equal(env.WALK, "yes");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadDotEnv: no file anywhere below the ceiling", () => {
	const root = makeTmp();
	try {
		mkdirSync(join(root, "deep"), { recursive: true });
		withCwd(join(root, "deep"), () => {
			const env: NodeJS.ProcessEnv = {};
			const loaded = loadDotEnv(env, root);
			assert.deepEqual(loaded, {});
			assert.deepEqual(env, {});
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadDotEnv: never overwrites existing keys", () => {
	const root = makeTmp();
	try {
		writeFileSync(join(root, ".env"), "PRESET=from-file\nFRESH=from-file\n", "utf8");
		withCwd(root, () => {
			const env: NodeJS.ProcessEnv = { PRESET: "from-env" };
			const loaded = loadDotEnv(env, root);
			assert.equal(env.PRESET, "from-env");
			assert.equal(env.FRESH, "from-file");
			assert.equal(loaded.PRESET, "from-file");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadDotEnv: fixture above the ceiling is ignored", () => {
	const root = makeTmp();
	try {
		mkdirSync(join(root, "inner"), { recursive: true });
		writeFileSync(join(root, ".env"), "OUTSIDE=leak\n", "utf8");
		withCwd(join(root, "inner"), () => {
			const env: NodeJS.ProcessEnv = {};
			const loaded = loadDotEnv(env, join(root, "inner"));
			assert.deepEqual(loaded, {});
			assert.equal(env.OUTSIDE, undefined);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
