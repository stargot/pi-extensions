/**
 * Unit tests for ask-user-question's pure logic: option normalization,
 * answer formatting/sorting and the model-facing result payloads. The
 * interactive TUI flow (ctx.ui.custom) stays manual-verified.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAuditThemes } from "../../shared/theme-contrast.ts";
import askUserQuestion, {
	buildResult,
	cancelledResult,
	formatAnswerForModel,
	getOtherLabel,
	normalizeOptions,
	sortAnswers,
	unavailableResult,
	type AskAnswer,
} from "../index.ts";

const option = (index: number, label: string): AskAnswer => ({ type: "option", label, value: label, index });

test("normalizeOptions: trims, defaults value to label, drops blank labels", () => {
	const options = normalizeOptions([
		{ label: "  Yes  ", description: "  agree  " },
		{ label: "No" },
		{ label: "   " },
		{ label: "Custom", value: " custom-value " },
	]);
	assert.deepEqual(options, [
		{ label: "Yes", value: "Yes", description: "agree" },
		{ label: "No", value: "No", description: undefined },
		{ label: "Custom", value: "custom-value", description: undefined },
	]);
	assert.deepEqual(normalizeOptions(undefined), []);
});

test("getOtherLabel: disambiguates when an option is already named other", () => {
	assert.equal(getOtherLabel(normalizeOptions([{ label: "Other" }])), "Other (custom)");
	assert.equal(getOtherLabel(normalizeOptions([{ label: "Yes" }, { label: "No" }])), "Other");
});

test("formatAnswerForModel: text, other and option shapes", () => {
	assert.equal(formatAnswerForModel({ type: "text", value: "", label: "typed answer" }), "typed answer");
	assert.equal(formatAnswerForModel({ type: "other", value: "", label: "my own words" }), "Other: my own words");
	assert.equal(formatAnswerForModel(option(2, "Second")), "2. Second");
});

test("sortAnswers: options by index first, then other, then free text", () => {
	const sorted = sortAnswers([
		{ type: "text", value: "", label: "free text" },
		option(3, "Third"),
		{ type: "other", value: "", label: "custom" },
		option(1, "First"),
	]);
	assert.deepEqual(
		sorted.map((a) => (a.type === "option" ? a.index : a.type)),
		[1, 3, "other", "text"],
	);
});

test("buildResult: text mode distinguishes empty response", () => {
	const empty = buildResult("Q?", undefined, "text", [{ type: "text", value: "", label: "   " }]);
	assert.equal(empty.content[0].text, "User submitted an empty response");
	assert.equal(empty.details.status, "answered");

	const answered = buildResult("Q?", "ctx", "text", [{ type: "text", value: "", label: "hello" }]);
	assert.equal(answered.content[0].text, "User answered: hello");
	assert.equal(answered.details.context, "ctx");
});

test("buildResult: single-select and multi-select formats", () => {
	const single = buildResult("Q?", undefined, "single-select", [option(2, "Second")]);
	assert.equal(single.content[0].text, "User selected: 2. Second");

	const multi = buildResult("Q?", undefined, "multi-select", [
		option(1, "First"),
		{ type: "other", value: "", label: "own" },
	]);
	assert.equal(multi.content[0].text, "User selected:\n- 1. First\n- Other: own");
});

test("cancelled and unavailable results carry status + message", () => {
	const cancelled = cancelledResult("Q?", "multi-select", "ctx");
	assert.equal(cancelled.details.status, "cancelled");
	assert.equal(cancelled.content[0].text, "User cancelled the question");

	const unavailable = unavailableResult("Q?", "text", "no UI here");
	assert.equal(unavailable.details.status, "unavailable");
	assert.equal(unavailable.content[0].text, "no UI here");
});

// ── Автоматизация R9: headless-рендер оверлея ask_user_question ──────────────
// Оверлей живёт внутри ctx.ui.custom(...): хост мокается — фабрика компонента
// захватывается и драйвится duck-typed tui + реальными Theme pi (dark/light/
// system в обоих обликax). text-режим (ctx.ui.editor) и хостовые обрезки/мышь/
// resize — остаются ручными пунктами живого чеклиста R9.

interface OverlayComponent {
	render(width: number): string[];
	handleInput(data: string): void;
}

const OVERLAY_SIZES = [
	[40, 100],
	[20, 60],
	[10, 25],
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function askTool() {
	const registered: Array<{ execute: (...args: any[]) => Promise<any> }> = [];
	askUserQuestion({
		registerTool: (tool: never) => registered.push(tool),
	} as never);
	return registered[0];
}

async function captureOverlay(tool: ReturnType<typeof askTool>, params: Record<string, unknown>) {
	let factory:
		| ((tui: unknown, theme: unknown, kb: unknown, done: (result: unknown) => void) => OverlayComponent)
		| undefined;
	let resolveOverlay!: (result: unknown) => void;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (captured: typeof factory) => {
				factory = captured;
				return new Promise((resolve) => {
					resolveOverlay = resolve;
				});
			},
			notify: () => {},
			editor: () => new Promise(() => {}),
		},
	};
	const execution = tool.execute("t1", params, undefined, undefined, ctx);
	for (let i = 0; i < 200 && !factory; i++) await sleep(5);
	assert.ok(factory, "фабрика оверлея захвачена через ctx.ui.custom");
	const close = async () => {
		resolveOverlay(null);
		await sleep(0);
	};
	return { factory: factory!, close, execution };
}

test("оверлей ask single-select: матрица 100x40 / 60x20 / 25x10 × 4 темы — без крэша и сырого JSON", async () => {
	const tool = askTool();
	const overlay = await captureOverlay(tool, {
		question: "Deploy now?",
		options: [{ label: "Yes" }, { label: "No" }],
	});
	try {
		for (const audit of loadAuditThemes()) {
			for (const [rows, cols] of OVERLAY_SIZES) {
				const tui = { requestRender() {}, terminal: { rows, columns: cols } };
				const component = overlay.factory(tui, audit.theme, undefined, () => {});
				const out = component.render(cols);
				const joined = out.join("\n");
				assert.ok(joined.includes("Deploy now?"), `${audit.name}/${audit.appearance} @${cols}: вопрос`);
				assert.ok(joined.includes("Other"), `${audit.name}/${audit.appearance} @${cols}: опция Other`);
				assert.ok(joined.includes("↑↓ navigate"), `${audit.name}/${audit.appearance} @${cols}: подсказка`);
				assert.equal(joined.includes('{"error"'), false, "сырой JSON в рендере");
			}
		}
	} finally {
		await overlay.close();
	}
	const result = await overlay.execution;
	assert.equal(result.details.status, "cancelled");
});

test("оверлей ask multi-select: Submit блокируется warning-строкой; матрица размеров × 4 темы", async () => {
	const tool = askTool();
	const overlay = await captureOverlay(tool, {
		question: "Pick targets.",
		options: [{ label: "alpha" }, { label: "beta" }],
		multiSelect: true,
	});
	try {
		for (const audit of loadAuditThemes()) {
			for (const [rows, cols] of OVERLAY_SIZES) {
				const tui = { requestRender() {}, terminal: { rows, columns: cols } };
				const component = overlay.factory(tui, audit.theme, undefined, () => {});
				const out = component.render(cols);
				const joined = out.join("\n");
				assert.ok(joined.includes("Pick targets."), `${audit.name}/${audit.appearance} @${cols}: вопрос`);
				assert.ok(joined.includes("Submit"), `${audit.name}/${audit.appearance} @${cols}: строка Submit`);
				assert.ok(
					joined.includes("Select at least"),
					`${audit.name}/${audit.appearance} @${cols}: warning блокировки Submit`,
				);
				assert.equal(joined.includes('{"error"'), false, "сырой JSON в рендере");
			}
		}
	} finally {
		await overlay.close();
	}
	const result = await overlay.execution;
	assert.equal(result.details.status, "cancelled");
});
