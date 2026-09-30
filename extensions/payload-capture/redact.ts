/**
 * Pure redaction for captured provider-request payloads.
 *
 * One recursive walk produces a JSON-safe deep copy in which credential-looking
 * fields are masked and oversized content is replaced by markers. The module has
 * no pi imports and no IO, so it is trivially unit-testable.
 *
 * Privacy red line: the walk never returns (parts of) the original object — the
 * result is always a freshly built structure, so a failed/aborted capture can
 * never leak raw payload data.
 */

/** Backlog-specified credential-field matcher: any key containing these substrings is masked. */
export const SENSITIVE_KEY_RE = /key|token|secret|credential|authorization|api[-_]?key/i;

/** Replacement applied to every field whose key matches SENSITIVE_KEY_RE. */
export const REDACTED_VALUE = "***";

export interface RedactLimits {
	/** Nesting depth cap (default 8). */
	maxDepth?: number;
	/** Array length cap (default 80). */
	maxArrayItems?: number;
	/** Object key cap (default 120). */
	maxObjectKeys?: number;
	/** Single-string length cap (default 12 000 chars). */
	maxStringLength?: number;
	/** Base64-like blob length cap (default 8 000 chars). */
	maxBase64Length?: number;
	/** Serialized-text cap (default ~2 MB). Longer output is cut and marked. */
	maxTotalBytes?: number;
}

const DEFAULTS = {
	maxDepth: 8,
	maxArrayItems: 80,
	maxObjectKeys: 120,
	maxStringLength: 12_000,
	maxBase64Length: 8_000,
	maxTotalBytes: 2 * 1024 * 1024,
} as const;

export const MAX_DEPTH_MARKER = "[payload-capture: max depth reached]";
export const MORE_ITEMS_MARKER = "[payload-capture: more items omitted]";
export const MORE_KEYS_MARKER = "[payload-capture: more keys omitted]";
export const CIRCULAR_MARKER = "[payload-capture: circular reference]";
export const UNSERIALIZABLE_MARKER = "[payload-capture: unserializable value omitted]";

export interface RedactResult {
	/** Redacted, JSON-safe deep copy. */
	value: unknown;
	/** JSON text of the redacted copy, size-capped with a truncation marker. */
	text: string;
	/** UTF-8 byte length of `text`. */
	bytes: number;
	/** True when any depth/size/shape limit was hit. */
	truncated: boolean;
}

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_RE.test(key);
}

/**
 * Deep-copy + mask + size-limit `value`. Never throws and never returns the
 * input object (or a structure sharing its sub-objects).
 */
export function redactPayload(value: unknown, limits?: RedactLimits): RedactResult {
	const cfg = { ...DEFAULTS, ...limits };
	let truncated = false;

	const walk = (node: unknown, depth: number, ancestors: Set<object>): unknown => {
		if (node === null || typeof node !== "object") {
			// Primitives pass through, with defensive conversions for JSON-unsafe types.
			if (typeof node === "bigint") return `${node}n`;
			if (typeof node === "function" || typeof node === "symbol" || node === undefined) {
				truncated = true;
				return UNSERIALIZABLE_MARKER;
			}
			if (typeof node === "string") return walkString(node);
			return node;
		}
		if (depth >= cfg.maxDepth) {
			truncated = true;
			return MAX_DEPTH_MARKER;
		}
		if (ancestors.has(node)) {
			truncated = true;
			return CIRCULAR_MARKER;
		}
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(node);

		if (Array.isArray(node)) {
			const items = node.slice(0, cfg.maxArrayItems).map((item) => walk(item, depth + 1, nextAncestors));
			if (node.length > cfg.maxArrayItems) {
				truncated = true;
				items.push(`${MORE_ITEMS_MARKER} (${node.length - cfg.maxArrayItems})`);
			}
			return items;
		}

		const result: Record<string, unknown> = {};
		let count = 0;
		for (const [key, raw] of Object.entries(node as Record<string, unknown>)) {
			if (++count > cfg.maxObjectKeys) {
				truncated = true;
				result[MORE_KEYS_MARKER] = `> ${cfg.maxObjectKeys} keys`;
				break;
			}
			result[key] = isSensitiveKey(key) ? REDACTED_VALUE : walk(raw, depth + 1, nextAncestors);
		}
		return result;
	};

	const walkString = (text: string): string => {
		if (/^data:image\//.test(text)) {
			truncated = true;
			return "[payload-capture: image data omitted]";
		}
		if (text.length > cfg.maxBase64Length && /^[A-Za-z0-9+/=\r\n]+$/.test(text)) {
			truncated = true;
			return `[payload-capture: base64-like data omitted: ${text.length} chars]`;
		}
		if (text.length > cfg.maxStringLength) {
			truncated = true;
			return `${text.slice(0, cfg.maxStringLength)} [payload-capture: string truncated from ${text.length} chars]`;
		}
		return text;
	};

	const copied = walk(value, 0, new Set());
	const rendered = JSON.stringify(copied, null, 2);
	let text = rendered === undefined ? String(copied) : rendered;
	const total = Buffer.byteLength(text, "utf8");
	if (total > cfg.maxTotalBytes) {
		truncated = true;
		text = `${text.slice(0, cfg.maxTotalBytes)}\n[payload-capture: payload truncated at ~${cfg.maxTotalBytes} bytes]`;
	}
	return { value: copied, text, bytes: Buffer.byteLength(text, "utf8"), truncated };
}
