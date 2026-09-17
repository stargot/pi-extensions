import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicHttpUrl } from "../fetch/ssrf.ts";

test("assertPublicHttpUrl: allowed URLs pass and return the parsed URL", () => {
	const allowed = [
		"https://example.com",
		"http://172.32.0.1/", // just outside 172.16.0.0/12
		"http://172.15.255.255/", // just below it
		"http://8.8.8.8/",
		"http://[2001:db8::1]/",
		"https://EXAMPLE.com", // case is not localhost
	];
	for (const url of allowed) {
		const parsed = assertPublicHttpUrl(url);
		assert.ok(parsed instanceof URL, `expected a URL for ${url}, got block`);
		assert.equal(parsed.href, new URL(url).href);
	}
});

test("assertPublicHttpUrl: blocked literals, schemes and hosts", () => {
	const blocked: ReadonlyArray<[url: string, reason: RegExp]> = [
		// localhost, any case, and *.localhost
		["http://localhost/", /is localhost/],
		["http://LOCALHOST/", /is localhost/],
		["http://api.localhost/", /is localhost/],
		["http://localhos%74/", /is localhost/], // URL parser decodes the host
		// 127.0.0.0/8, including the shorthand form the parser canonicalizes
		["http://127.0.0.1/", /127\.0\.0\.0\/8/],
		["http://127.1/", /127\.0\.0\.0\/8/],
		["http://127.255.255.254/", /127\.0\.0\.0\/8/],
		// 10.0.0.0/8
		["http://10.0.0.1/", /10\.0\.0\.0\/8/],
		// 172.16.0.0/12 — strictly 172.16..172.31
		["http://172.16.0.1/", /172\.16\.0\.0\/12/],
		["http://172.31.255.255/", /172\.16\.0\.0\/12/],
		// 192.168.0.0/16
		["http://192.168.1.1/", /192\.168\.0\.0\/16/],
		// 169.254.0.0/16 — the cloud metadata endpoint
		["http://169.254.169.254/latest/meta-data/", /169\.254\.0\.0\/16/],
		// 0.0.0.0/8 — the whole range, not just 0.0.0.0
		["http://0.0.0.0/", /0\.0\.0\.0\/8/],
		["http://0.1.2.3/", /0\.0\.0\.0\/8/],
		// IPv6 loopback, unspecified, unique-local
		["http://[::1]/", /loopback address \(::1\)/],
		["http://[::]/", /unspecified address \(::\)/],
		["http://[fc00::1]/", /fc00::\/7/],
		["http://[fd12:3456::1]/", /fc00::\/7/],
		// IPv4-mapped IPv6 — embedded v4 checked by the same rules
		["http://[::ffff:10.0.0.1]/", /10\.0\.0\.0\/8/],
		["http://[::ffff:127.0.0.1]/", /127\.0\.0\.0\/8/],
		// userinfo must not hide the real host
		["http://example.com@127.0.0.1/", /127\.0\.0\.0\/8/],
		// non-http(s) schemes
		["ftp://x/", /only http\/https/],
		["file:///etc/passwd", /only http\/https/],
	];
	for (const [url, reason] of blocked) {
		assert.throws(
			() => assertPublicHttpUrl(url),
			reason,
			`expected ${url} to be blocked`,
		);
	}
});

test("assertPublicHttpUrl: invalid URLs throw Invalid URL", () => {
	for (const url of ["not a url", "http://"]) {
		assert.throws(
			() => assertPublicHttpUrl(url),
			/Invalid URL/,
			`expected ${url} to be rejected as invalid`,
		);
	}
});

test("assertPublicHttpUrl: returns the normalized URL for callers", () => {
	const parsed = assertPublicHttpUrl("http://EXAMPLE.com:8080/doc");
	assert.equal(parsed.hostname, "example.com");
	assert.equal(parsed.port, "8080");
	assert.equal(parsed.pathname, "/doc");
});
