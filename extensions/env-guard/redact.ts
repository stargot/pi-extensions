import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SECRET_NAME_PATTERN, type SecretEntry } from "./secrets.ts";

export interface Redactor {
	regex: RegExp | null;
	lookup: Map<string, string>;
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function valueVariants(value: string): string[] {
	const variants = new Set<string>();
	variants.add(value);
	variants.add(JSON.stringify(value).slice(1, -1));
	variants.add(encodeURIComponent(value));
	const base64 = Buffer.from(value, "utf8").toString("base64");
	if (base64.length >= 12) variants.add(base64);
	return [...variants];
}

const markerFor = (key: string): string => `[REDACTED:${key}]`;

const ENV_ASSIGNMENT_PATTERN = /^([+\-<>]?)([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_.]*)([ \t]*=)(.*)\r?$/gm;
const REDACTED_MARKER_VALUE = /^["']?\[REDACTED:[^\]]*\]["']?$/;
const EMPTY_QUOTED_VALUE = /^["']{2}$/;

export function redactEnvLines(text: string): { text: string; hits: Map<string, number>; changed: boolean } {
	const hits = new Map<string, number>();
	const replaced = text.replace(
		ENV_ASSIGNMENT_PATTERN,
		(line: string, prefix: string, lead: string, key: string, separator: string, value: string) => {
			if (!SECRET_NAME_PATTERN.test(key)) return line;
			const trimmed = value.trim();
			if (trimmed.length === 0 || EMPTY_QUOTED_VALUE.test(trimmed) || REDACTED_MARKER_VALUE.test(trimmed)) return line;
			hits.set(key, (hits.get(key) ?? 0) + 1);
			const carriage = line.endsWith("\r") ? "\r" : "";
			return `${prefix}${lead}${key}${separator}${markerFor(key)}${carriage}`;
		},
	);
	return { text: replaced, hits, changed: replaced !== text };
}

export function buildRedactor(secrets: SecretEntry[]): Redactor {
	const candidates: Array<{ variant: string; key: string }> = [];
	for (const secret of secrets) {
		for (const variant of valueVariants(secret.value)) {
			candidates.push({ variant, key: secret.key });
		}
	}
	candidates.sort(
		(a, b) =>
			a.variant.length - b.variant.length ||
			a.key.length - b.key.length ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
	);
	const lookup = new Map<string, string>();
	for (const candidate of candidates) {
		if (!lookup.has(candidate.variant)) lookup.set(candidate.variant, candidate.key);
	}
	const unsafe = new Set<string>();
	const markers = [...new Set(lookup.values())].map(markerFor);
	for (const [variant] of lookup) {
		if (markers.some((marker) => marker.includes(variant))) unsafe.add(variant);
	}
	const alternatives = [...lookup.keys()]
		.filter((variant) => !unsafe.has(variant))
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	if (alternatives.length === 0) return { regex: null, lookup };
	return { regex: new RegExp(alternatives.join("|"), "g"), lookup };
}

export function redactText(
	text: string,
	redactor: Redactor,
): { text: string; hits: Map<string, number>; changed: boolean } {
	if (!redactor.regex) return { text, hits: new Map(), changed: false };
	const hits = new Map<string, number>();
	const replaced = text.replace(redactor.regex, (match) => {
		const key = redactor.lookup.get(match);
		if (key === undefined) return match;
		hits.set(key, (hits.get(key) ?? 0) + 1);
		return markerFor(key);
	});
	return { text: replaced, hits, changed: replaced !== text };
}

export function mergeHits(target: Map<string, number>, source: Map<string, number>): void {
	for (const [key, count] of source) target.set(key, (target.get(key) ?? 0) + count);
}

export const isPlainObject = (input: object): boolean => {
	const prototype = Object.getPrototypeOf(input);
	return prototype === Object.prototype || prototype === null;
};

export function walkDeep(
	input: unknown,
	redactor: Redactor,
	copy: boolean,
	stringTransform?: (text: string, hits: Map<string, number>) => string,
): { value: unknown; hits: Map<string, number> } {
	const hits = new Map<string, number>();
	const copies = new WeakMap<object, unknown>();
	const mutated = new WeakSet<object>();
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") {
			const result = redactText(node, redactor);
			mergeHits(hits, result.hits);
			if (!stringTransform) return result.text;
			return stringTransform(result.text, hits);
		}
		if (Array.isArray(node)) {
			if (copy) {
				const existing = copies.get(node);
				if (existing !== undefined) return existing;
				const output: unknown[] = [...node];
				copies.set(node, output);
				for (let index = 0; index < output.length; index += 1) {
					const next = visit(output[index]);
					if (next !== output[index]) output[index] = next;
				}
				return output;
			}
			if (mutated.has(node)) return node;
			mutated.add(node);
			for (let index = 0; index < node.length; index += 1) {
				const next = visit(node[index]);
				if (next !== node[index]) node[index] = next;
			}
			return node;
		}
		if (node !== null && typeof node === "object" && isPlainObject(node)) {
			const source = node as Record<string, unknown>;
			if (copy) {
				const existing = copies.get(source);
				if (existing !== undefined) return existing;
				const output = { ...source };
				copies.set(source, output);
				for (const key of Object.keys(output)) {
					const next = visit(output[key]);
					if (next !== output[key]) output[key] = next;
				}
				return output;
			}
			if (mutated.has(source)) return source;
			mutated.add(source);
			for (const key of Object.keys(source)) {
				const next = visit(source[key]);
				if (next !== source[key]) source[key] = next;
			}
			return source;
		}
		return node;
	};
	const value = visit(input);
	return { value, hits };
}

export function redactDeep<T>(
	value: T,
	redactor: Redactor,
	stringTransform?: (text: string, hits: Map<string, number>) => string,
): { value: T; hits: Map<string, number>; changed: boolean } {
	const { value: walked, hits } = walkDeep(value, redactor, true, stringTransform);
	if (hits.size === 0) return { value, hits, changed: false };
	return { value: walked as T, hits, changed: true };
}

function redactTextBlocks<T extends { type: string; text?: unknown }>(
	blocks: T[],
	redactor: Redactor,
	hits: Map<string, number>,
): { content: T[]; changed: boolean } {
	let changed = false;
	const content = blocks.map((block): T => {
		const text = block.text;
		if (block.type !== "text" || typeof text !== "string") return block;
		const result = redactText(text, redactor);
		if (!result.changed) return block;
		changed = true;
		mergeHits(hits, result.hits);
		return { ...block, text: result.text } as T;
	});
	return { content, changed };
}

export function redactMessage(
	message: AgentMessage,
	redactor: Redactor,
): { message: AgentMessage; hits: Map<string, number> } | undefined {
	if (message.role === "assistant") return redactAssistantMessage(message, redactor);
	if (message.role === "user") {
		const hits = new Map<string, number>();
		if (typeof message.content === "string") {
			const result = redactText(message.content, redactor);
			if (!result.changed) return undefined;
			return { message: { ...message, content: result.text }, hits: result.hits };
		}
		const mapped = redactTextBlocks(message.content, redactor, hits);
		if (!mapped.changed) return undefined;
		return { message: { ...message, content: mapped.content }, hits };
	}
	if (message.role === "toolResult") {
		const hits = new Map<string, number>();
		const mapped = redactTextBlocks(message.content, redactor, hits);
		if (!mapped.changed) return undefined;
		return { message: { ...message, content: mapped.content }, hits };
	}
	if (message.role === "system") {
		const hits = new Map<string, number>();
		if (typeof message.content === "string") {
			const result = redactText(message.content, redactor);
			if (!result.changed) return undefined;
			return { message: { ...message, content: result.text }, hits: result.hits };
		}
		const mapped = redactTextBlocks(message.content, redactor, hits);
		if (!mapped.changed) return undefined;
		return { message: { ...message, content: mapped.content }, hits };
	}
	return undefined;
}

export function redactAssistantMessage(
	message: AgentMessage,
	redactor: Redactor,
): { message: AgentMessage; hits: Map<string, number> } | undefined {
	if (message.role !== "assistant") return undefined;
	const hits = new Map<string, number>();
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type === "text") {
			const result = redactText(block.text, redactor);
			if (!result.changed) return block;
			changed = true;
			mergeHits(hits, result.hits);
			return { ...block, text: result.text };
		}
		if (block.type === "thinking") {
			const result = redactText(block.thinking, redactor);
			if (!result.changed) return block;
			changed = true;
			mergeHits(hits, result.hits);
			return { ...block, thinking: result.text };
		}
		return block;
	});
	if (!changed) return undefined;
	return { message: { ...message, content }, hits };
}
