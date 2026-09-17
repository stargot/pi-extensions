/**
 * Pure SSRF guard for web_fetch: decides whether a URL may be fetched.
 *
 * No I/O, no imports at all (URL is a global) — unit-testable standalone
 * per the repo rule (tests never import index/tool modules).
 */

/**
 * Assert that url is fetchable by web_fetch: an absolute http(s) URL whose
 * host is not a blocked literal address. Returns the parsed URL as
 * normalized by the WHATWG parser (e.g. shorthand "http://127.1/" comes
 * back with hostname "127.0.0.1"), so callers can use it instead of
 * re-parsing.
 *
 * Blocked: non-http(s) schemes; localhost and *.localhost (any case);
 * IPv4 literals in 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12 (strictly
 * 172.16–172.31), 192.168.0.0/16, 169.254.0.0/16 (the cloud metadata
 * endpoint 169.254.169.254 included), 0.0.0.0/8; IPv6 ::1, :: (unspecified),
 * fc00::/7, and IPv4-mapped addresses (the embedded IPv4 is checked by the
 * same IPv4 rules). The WHATWG parser canonicalizes shorthand and hex IPv4
 * forms ("127.1", "0x7f.0.0.1") before we see the hostname, and
 * percent-encoded hosts ("localhos%74") are decoded to "localhost".
 *
 * Known limitation (accepted, plan solution 4a): regular DNS names always
 * pass. Resolving them to re-check the resulting IP would require I/O this
 * module deliberately avoids, so DNS rebinding is out of scope; this is
 * documented in the CHANGELOG too.
 *
 * @throws Error when the URL is invalid, non-http(s), or its host is blocked.
 */
export function assertPublicHttpUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`Blocked ${url}: protocol "${parsed.protocol}" — only http/https URLs are allowed`,
		);
	}

	// WHATWG tolerates an empty host for special schemes ("http:///path"
	// parses with hostname ""); there is no meaningful target, so treat it
	// as invalid rather than letting it pass as a "domain name".
	if (parsed.hostname === "") {
		throw new Error(`Invalid URL: ${url}`);
	}

	const reason = blockedHostReason(parsed.hostname);
	if (reason) {
		throw new Error(`Blocked ${url}: ${parsed.hostname} is ${reason}`);
	}
	return parsed;
}

/**
 * Human-readable reason when hostname is a blocked literal (loopback /
 * private / link-local / unspecified / unique-local), or null when the
 * host is allowed (a public literal or a regular DNS name — see the
 * DNS-rebinding note on assertPublicHttpUrl).
 */
function blockedHostReason(hostname: string): string | null {
	// WHATWG hostnames are already lowercased, toLowerCase is belt and braces.
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) {
		return "localhost";
	}

	// IPv6 literals keep their square brackets in URL.hostname.
	if (host.startsWith("[") && host.endsWith("]")) {
		return ipv6BlockedReason(host.slice(1, -1));
	}

	const v4 = parseDottedQuad(host);
	if (v4) {
		return ipv4BlockedReason(v4);
	}
	return null;
}

/**
 * Parse "a.b.c.d" with four decimal octets 0-255; null for anything else
 * (i.e. a regular DNS name). The URL parser has already canonicalized
 * shorthand ("127.1") and hex/octal forms to dotted-quad by the time we
 * get here, so strict parsing is enough — this is just defense in depth.
 */
function parseDottedQuad(
	hostname: string,
): readonly [number, number, number, number] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4) {
		return null;
	}
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}
		const value = Number(part);
		if (value > 255) {
			return null;
		}
		octets.push(value);
	}
	return octets as [number, number, number, number];
}

/** Block reason for an IPv4 literal, null when allowed. */
function ipv4BlockedReason(
	[a, b]: readonly [number, number, number, number],
): string | null {
	if (a === 127) return "a loopback address (127.0.0.0/8)";
	// 172.16.0.0/12 is NOT the whole 172.x — strictly 172.16 through 172.31.
	if (a === 172 && b >= 16 && b <= 31) return "a private address (172.16.0.0/12)";
	if (a === 192 && b === 168) return "a private address (192.168.0.0/16)";
	if (a === 169 && b === 254) {
		return "a link-local address (169.254.0.0/16, includes the cloud metadata endpoint)";
	}
	if (a === 10) return "a private address (10.0.0.0/8)";
	if (a === 0) return "an unspecified/this-network address (0.0.0.0/8)";
	return null;
}

/**
 * Block reason for an IPv6 literal, null when allowed. Compares on the
 * 16-bit pieces rather than string forms: WHATWG serializes mapped
 * addresses as pure hex ("::ffff:10.0.0.1" comes back as "::ffff:a00:1"),
 * so textual matching would miss them.
 */
function ipv6BlockedReason(literal: string): string | null {
	const pieces = parseIpv6(literal);
	if (!pieces) {
		return null; // unparseable literal — the URL parser vetted it, not ours
	}

	// IPv4-mapped (::ffff:a.b.c.d): the embedded IPv4 gets the same rules.
	if (
		pieces.slice(0, 5).every((piece) => piece === 0) &&
		pieces[5] === 0xffff
	) {
		const v4: [number, number, number, number] = [
			pieces[6] >> 8,
			pieces[6] & 0xff,
			pieces[7] >> 8,
			pieces[7] & 0xff,
		];
		const reason = ipv4BlockedReason(v4);
		return reason ? `an IPv4-mapped address (${literal} → ${reason})` : null;
	}

	if (pieces.every((piece) => piece === 0)) {
		return "the unspecified address (::)";
	}
	if (pieces[7] === 1 && pieces.slice(0, 7).every((piece) => piece === 0)) {
		return "the loopback address (::1)";
	}
	if ((pieces[0] & 0xfe00) === 0xfc00) {
		return "a unique-local address (fc00::/7)";
	}
	return null;
}

/**
 * Parse an IPv6 literal into eight 16-bit pieces: "::" expands to zero
 * runs and a trailing IPv4 part is folded into the last two pieces.
 * null when the literal does not parse.
 */
function parseIpv6(literal: string): readonly number[] | null {
	const halves = literal.split("::");
	if (halves.length > 2) {
		return null;
	}
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

	// A trailing dotted-quad is the only place an IPv4 tail is allowed;
	// it occupies the final two pieces.
	let v4: readonly [number, number, number, number] | null = null;
	if (tail.length > 0 && tail[tail.length - 1].includes(".")) {
		v4 = parseDottedQuad(tail.pop()!);
		if (!v4) {
			return null;
		}
	}

	const pieces: number[] = [];
	for (const group of [...head, ...tail]) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) {
			return null;
		}
		pieces.push(Number.parseInt(group, 16));
	}
	if (v4) {
		pieces.push((v4[0] << 8) | v4[1]);
		pieces.push((v4[2] << 8) | v4[3]);
	}

	const missing = 8 - pieces.length;
	if (missing < 0) {
		return null;
	}
	if (halves.length === 2) {
		if (missing === 0) {
			return null; // "::" must compress at least one group
		}
		pieces.splice(head.length, 0, ...new Array<number>(missing).fill(0));
	} else if (missing !== 0) {
		return null; // no "::" — must be exactly eight groups
	}
	return pieces;
}
