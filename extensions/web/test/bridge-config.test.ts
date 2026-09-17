/**
 * Unit tests for the bridge configuration surface (plan §4, task B4):
 * parsePortRange (the range grammar shared with the companion's options
 * validator), readBridgeConfig (env priorities and degradation), and the
 * token-pairing file logic (loadOrCreateToken: read-back, generate AND
 * persist, content shape).
 *
 * Pure config/fs only — no server is started here; the live socket
 * lifecycle (listen, hello, close) is bridge.test.ts's job.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	loadOrCreateToken,
	parsePortRange,
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
