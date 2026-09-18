/**
 * Unit tests for the bridge configuration surface (plan §4, task B4):
 * parsePortRange / parseSinglePort (the port grammars shared with the
 * companion's options validator), readBridgeConfig (env priorities and
 * degradation), and the token-pairing file logic (loadOrCreateToken:
 * read-back, generate AND persist, content shape, and the create-race
 * where a concurrent first start must adopt the winner's token).
 *
 * Pure config/fs only — no server is started here; the live socket
 * lifecycle (listen, hello, close) is bridge.test.ts's job.
 */

import assert from "node:assert/strict";
import fsModule, {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	loadOrCreateToken,
	parsePortRange,
	parseSinglePort,
	readBridgeConfig,
	resolveTokenFilePath,
} from "../fetch/bridge.ts";

// ── parsePortRange ──────────────────────────────────────────────────

test("parsePortRange: valid ranges and single ports", () => {
	assert.deepEqual(
		parsePortRange("8790-8799"),
		[8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799],
	);
	assert.deepEqual(parsePortRange("8800"), [8800]);
	// Surrounding whitespace is tolerated (env vars pick it up easily).
	assert.deepEqual(parsePortRange("  9090-9091 "), [9090, 9091]);
});

test("parsePortRange: bounds accepted (1024…65535, inclusive)", () => {
	assert.deepEqual(parsePortRange("1024"), [1024]);
	assert.deepEqual(parsePortRange("65535"), [65535]);
	assert.deepEqual(parsePortRange("1024-1026"), [1024, 1025, 1026]);
	assert.deepEqual(parsePortRange("65534-65535"), [65534, 65535]);
});

test("parseSinglePort: PI_WEB_BRIDGE_PORT's grammar — one port, same bounds", () => {
	assert.equal(parseSinglePort("8790"), 8790);
	assert.equal(parseSinglePort("  9001 \t"), 9001, "whitespace tolerated");
	assert.equal(parseSinglePort("1024"), 1024);
	assert.equal(parseSinglePort("65535"), 65535);
	// A range is NOT this variable's grammar (use PI_WEB_BRIDGE_PORTS).
	assert.throws(() => parseSinglePort("8790-8799"));
	assert.throws(() => parseSinglePort(""));
	assert.throws(() => parseSinglePort("abc"));
	assert.throws(() => parseSinglePort("1023"));
	assert.throws(() => parseSinglePort("0"));
	assert.throws(() => parseSinglePort("65536"));
});

test("parsePortRange: garbage and out-of-bounds throw", () => {
	// Not a number / not the "from" or "from-to" grammar at all.
	assert.throws(() => parsePortRange("abc"));
	assert.throws(() => parsePortRange(""));
	assert.throws(() => parsePortRange("8790-"));
	assert.throws(() => parsePortRange("-1"));
	assert.throws(() => parsePortRange("1-2-3"));
	// Privileged ports are rejected, same as the companion's validator.
	assert.throws(() => parsePortRange("1023"));
	assert.throws(() => parsePortRange("1023-1030"));
	assert.throws(() => parsePortRange("0"));
	// Above the TCP port ceiling.
	assert.throws(() => parsePortRange("65536"));
	assert.throws(() => parsePortRange("65535-65536"));
	// Inverted range.
	assert.throws(() => parsePortRange("8799-8790"));
});

// ── readBridgeConfig: port priorities ───────────────────────────────

test("readBridgeConfig: PI_WEB_BRIDGE_PORT > PI_WEB_BRIDGE_PORTS > default", () => {
	assert.deepEqual(readBridgeConfig({ PI_WEB_BRIDGE_PORT: "9001" }).ports, [9001]);
	// PI_WEB_BRIDGE_PORTS carries the range grammar — a single port too.
	assert.deepEqual(readBridgeConfig({ PI_WEB_BRIDGE_PORTS: "9002" }).ports, [9002]);
	assert.deepEqual(
		readBridgeConfig({ PI_WEB_BRIDGE_PORTS: "9002-9004" }).ports,
		[9002, 9003, 9004],
	);
	// The single-port override wins when both are set.
	assert.deepEqual(
		readBridgeConfig({
			PI_WEB_BRIDGE_PORT: "9001",
			PI_WEB_BRIDGE_PORTS: "9002-9004",
		}).ports,
		[9001],
	);
	// No env at all → the default range (plan §2: 8790–8799).
	assert.deepEqual(readBridgeConfig({}).ports, parsePortRange("8790-8799"));
});

test("readBridgeConfig: an invalid port env degrades to the default, never throws", () => {
	const invalid = readBridgeConfig({ PI_WEB_BRIDGE_PORT: "not-a-port" });
	assert.deepEqual(invalid.ports, parsePortRange("8790-8799"));
	// PI_WEB_BRIDGE_PORT is single-port-only: a range value is invalid for
	// it (the range grammar lives in PI_WEB_BRIDGE_PORTS) and degrades.
	assert.deepEqual(
		readBridgeConfig({ PI_WEB_BRIDGE_PORT: "9001-9003" }).ports,
		parsePortRange("8790-8799"),
	);
	// Out-of-bounds range is invalid the same way.
	const outOfBounds = readBridgeConfig({ PI_WEB_BRIDGE_PORTS: "700-800" });
	assert.deepEqual(outOfBounds.ports, parsePortRange("8790-8799"));
});

// ── readBridgeConfig: token priorities and file resolution ──────────

test("readBridgeConfig: token from env wins over the token-file override", () => {
	const withToken = readBridgeConfig({ PI_WEB_BRIDGE_TOKEN: "inline-token" });
	assert.equal(withToken.token, "inline-token");
	// The file path is still resolved (shown by /bridge) even when unused.
	assert.equal(withToken.tokenFile, resolveTokenFilePath());

	const both = readBridgeConfig({
		PI_WEB_BRIDGE_TOKEN: "inline-token",
		PI_WEB_BRIDGE_TOKEN_FILE: "C:\\somewhere\\token",
	});
	assert.equal(both.token, "inline-token");
	assert.equal(both.tokenFile, "C:\\somewhere\\token");

	// File override without an inline token: path respected, token deferred
	// to server start (loadOrCreateToken reads it then).
	const fromFile = readBridgeConfig({
		PI_WEB_BRIDGE_TOKEN_FILE: "C:\\somewhere\\token",
	});
	assert.equal(fromFile.token, undefined);
	assert.equal(fromFile.tokenFile, "C:\\somewhere\\token");
});

test("readBridgeConfig: default token file lives in the agent dir", () => {
	const tokenFile = resolveTokenFilePath();
	assert.ok(tokenFile.endsWith("web-bridge-token"));
	assert.ok(join(tokenFile, "..").length > 0, "token file has a parent directory");
});

// ── loadOrCreateToken: pairing without a server ─────────────────────

test("loadOrCreateToken: missing file → generated, written back, content round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
	const file = join(dir, "web-bridge-token");
	try {
		assert.equal(existsSync(file), false, "precondition: file does not exist");
		const token = loadOrCreateToken(file);

		// Generated: 32 random bytes → 43 base64url characters.
		assert.equal(token.length, 43);
		assert.match(token, /^[A-Za-z0-9_-]+$/, "base64url alphabet");

		// AND persisted: the file now holds exactly the token + newline.
		assert.equal(existsSync(file), true);
		assert.equal(readFileSync(file, "utf8"), `${token}\n`);

		// A second (missing) file yields an independent random token.
		const other = loadOrCreateToken(join(dir, "other-token"));
		assert.notEqual(other, token);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadOrCreateToken: existing file → read back trimmed, not overwritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
	const file = join(dir, "web-bridge-token");
	try {
		writeFileSync(file, "  my-paired-token\n", "utf8");
		assert.equal(loadOrCreateToken(file), "my-paired-token");
		assert.equal(readFileSync(file, "utf8"), "  my-paired-token\n", "file untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadOrCreateToken: empty file → regenerated and overwritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
	const file = join(dir, "web-bridge-token");
	try {
		writeFileSync(file, "\n", "utf8");
		const token = loadOrCreateToken(file);
		assert.equal(token.length, 43);
		assert.equal(readFileSync(file, "utf8"), `${token}\n`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadOrCreateToken: two parallel first starts race → both adopt ONE token (the file's)", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
	const file = join(dir, "web-bridge-token");
	try {
		assert.equal(existsSync(file), false, "precondition: two sessions, no token file yet");
		const rivalToken = "rival-pi-session-token-0123456789abcdefghijklmnopqr";

		// Deterministically replay the concurrent-first-start race at its
		// exact window: this session's initial read missed (ENOENT), then
		// the rival session created the file with ITS token, and only then
		// our 'wx' create ran. The write is intercepted to replay that
		// interleaving: the rival wins the file, our create throws EEXIST.
		// loadOrCreateToken must adopt the rival's token — if both sessions
		// kept their own, the companion (paired with one of them) could not
		// authenticate the other bridge.
		const realWrite = fsModule.writeFileSync;
		t.mock.method(fsModule, "writeFileSync", (
			path: Parameters<typeof realWrite>[0],
			data: Parameters<typeof realWrite>[1],
			options?: Parameters<typeof realWrite>[2],
		) => {
			// The rival's atomic O_EXCL create wins the race…
			realWrite(path, `${rivalToken}\n`, { mode: 0o600, flag: "wx" });
			// …and our own create loses with EEXIST (file already exists).
			const error = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
			error.code = "EEXIST";
			throw error;
		});

		// The loser of the race must not keep its freshly generated token:
		assert.equal(loadOrCreateToken(file), rivalToken, "the rival's token is adopted");
		// …and the file still holds exactly the shared (rival) token.
		assert.equal(readFileSync(file, "utf8"), `${rivalToken}\n`, "file untouched by the loser");
	} finally {
		t.mock.restoreAll();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadOrCreateToken: non-EEXIST write failures still surface", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
	const file = join(dir, "web-bridge-token");
	try {
		// Only the create-race EEXIST is handled (adopt the winner); any
		// other failure (EACCES, ENOSPC, …) must propagate — startBridge
		// turns it into a disabled bridge, but the error itself stays true.
		t.mock.method(fsModule, "writeFileSync", () => {
			const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});
		assert.throws(() => loadOrCreateToken(file), /EACCES/);
	} finally {
		t.mock.restoreAll();
		rmSync(dir, { recursive: true, force: true });
	}
});
