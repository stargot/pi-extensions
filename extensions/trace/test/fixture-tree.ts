/**
 * Сессия-фикстура для тестов ядра: ветка через /tree с branch_summary,
 * custom_message, bash с excludeFromContext, context_edit (замена и удаление),
 * компакция с firstKeptEntryId и system-чекпойнтом, патч system, label, custom.
 *
 *   s0 ─ u1 ─ a1 ─ r1 ─ a2 ─ cm1 ─┬─ u2 ─ a3                      (брошена)
 *                                 └─ bs1 ─ u3 ─ a4 ─ … ─ u4 ─ a5   (активна)
 */
import type { Entry } from "../core/tree.ts";

let clock = Date.parse("2026-09-05T12:00:00.000Z");
const at = (sec: number) => {
	clock += sec * 1000;
	return new Date(clock).toISOString();
};

const msg = (id: string, parentId: string | null, sec: number, message: object): Entry => {
	const timestamp = at(sec);
	return { type: "message", id, parentId, timestamp, message: { timestamp: Date.parse(timestamp), ...message } };
};

const usage = (input: number, cacheRead: number, output: number, cost: number) => ({
	input,
	cacheRead,
	cacheWrite: 0,
	output,
	cost: { total: cost },
});

export const HEADER: Entry = {
	type: "session",
	version: 3,
	id: "sess",
	timestamp: "2026-09-05T12:00:00.000Z",
	cwd: "/x",
};

export const ENTRIES: Entry[] = [
	msg("s0", null, 0, {
		role: "system",
		content: "",
		sections: { preamble: "You are pi.", tools: "<tools/>" },
		toolsAdded: [{ name: "read" }],
	}),
	msg("u1", "s0", 1, { role: "user", content: "fix the bug" }),
	msg("a1", "u1", 4, {
		role: "assistant",
		model: "glm-5.3",
		usage: usage(1000, 0, 50, 0.01),
		stopReason: "toolUse",
		content: [
			{ type: "thinking", thinking: "read first" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
		],
	}),
	msg("r1", "a1", 1, {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "text", text: "export const a = 1;" }],
		isError: false,
	}),
	msg("a2", "r1", 3, {
		role: "assistant",
		model: "glm-5.3",
		usage: usage(100, 1000, 30, 0.002),
		stopReason: "stop",
		content: [{ type: "text", text: "Found it." }],
	}),
	{
		type: "custom_message",
		id: "cm1",
		parentId: "a2",
		timestamp: at(1),
		customType: "subagent_status",
		content: "worker running",
		display: true,
	},
	msg("u2", "cm1", 10, { role: "user", content: "try a mutex" }),
	msg("a3", "u2", 5, {
		role: "assistant",
		model: "glm-5.3",
		usage: usage(200, 1100, 80, 0.004),
		stopReason: "stop",
		content: [{ type: "text", text: "Mutex added." }],
	}),
	{
		type: "branch_summary",
		id: "bs1",
		parentId: "cm1",
		timestamp: at(20),
		fromId: "a3",
		summary: "mutex made it worse",
	},
	msg("u3", "bs1", 1, { role: "user", content: "back to single-flight" }),
	msg("a4", "u3", 6, {
		role: "assistant",
		model: "glm-5.3",
		usage: usage(300, 1100, 40, 0.003),
		stopReason: "stop",
		content: [{ type: "text", text: "Done." }],
	}),
	msg("x1", "a4", 2, {
		role: "bashExecution",
		command: "ls",
		output: "a.ts",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
	}),
	msg("x2", "x1", 2, {
		role: "bashExecution",
		command: "npm test",
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	}),
	{
		type: "context_edit",
		id: "ce1",
		parentId: "x2",
		timestamp: at(1),
		targetId: "r1",
		replacement: { content: "[trimmed]" },
	},
	{ type: "context_edit", id: "ce2", parentId: "ce1", timestamp: at(1), targetId: "a2", replacement: null },
	{
		type: "compaction",
		id: "k1",
		parentId: "ce2",
		timestamp: at(30),
		summary: "user wants single-flight",
		firstKeptEntryId: "u3",
		tokensBefore: 412000,
		usage: usage(5000, 0, 400, 0.05),
		systemMessage: { role: "system", content: "You are pi (checkpoint).", toolsAdded: [], timestamp: clock },
	},
	msg("s1", "k1", 1, { role: "system", content: "", sections: { skills: "<skills/>" } }),
	msg("u4", "s1", 5, { role: "user", content: "and add e2e" }),
	{ type: "label", id: "lb", parentId: "u4", timestamp: at(1), targetId: "u3", label: "release" },
	{ type: "custom", id: "cu", parentId: "lb", timestamp: at(1), customType: "x", data: {} },
	msg("a5", "cu", 7, {
		role: "assistant",
		model: "glm-5.3",
		usage: usage(400, 2000, 60, 0.006),
		stopReason: "error",
		errorMessage: "overloaded",
		content: [],
	}),
];
