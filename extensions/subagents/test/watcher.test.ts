import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import type { ActivityReadResult } from "../activity.ts";
import type { AgentDef } from "../agents.ts";
import type { TraceEntry } from "../watcher.ts";
import {
	CANCEL_KILL_AFTER_MS,
	createSubagentWatcher,
	LABEL_RETRY_INTERVAL_MS,
	MAX_SUMMARY_CHARS,
	NATIVE_DONE_GRACE_MS,
	NATIVE_WAITER_DELAY_MS,
	POLL_INTERVAL_MS,
	STALLED_AFTER_MS,
	type RunningSubagent,
	type WatcherDeps,
} from "../watcher.ts";

const START = 1_000_000;
const SESSION = "C:/sessions/subagents/scout.jsonl";
const DONE = `${SESSION}.done`;
const EXIT = `${SESSION}.exit`;
const CANCEL = `${SESSION}.cancel`;
const ACTIVITY = "C:/artifacts/activity/scout-abc12345.json";

interface Steer {
	message: { customType: string; content: string; details: Record<string, unknown> };
	opts: { triggerTurn: boolean; deliverAs: string };
}

interface FakeWaiter {
	exit(code: number): void;
}

interface Harness {
	nowMs: number;
	backend: "herdr" | "wezterm" | null;
	files: Map<string, string>;
	panes: Set<string>;
	tails: Map<string, string>;
	summaries: Map<
		string,
		{ summary: string; usage: { input: number; output: number; cost: number } | null; model: string | null }
	>;
	activities: Map<string, ActivityReadResult>;
	steers: Steer[];
	traces: Array<TraceEntry>;
	closedPanes: string[];
	forgottenPanes: string[];
	labelCalls: Array<[string, string]>;
	waiterCalls: Array<[string, string[]]>;
	waiter: FakeWaiter | null;
	applyResult: boolean;
	waiterKilled: boolean;
	widgetUpdates: number;
	listPaneCalls: number;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
	return {
		nowMs: START,
		backend: "wezterm",
		files: new Map(),
		panes: new Set(["pane-1"]),
		tails: new Map(),
		summaries: new Map(),
		activities: new Map(),
		steers: [],
		traces: [],
		closedPanes: [],
		forgottenPanes: [],
		labelCalls: [],
		waiterCalls: [],
		waiter: null,
		applyResult: true,
		waiterKilled: false,
		widgetUpdates: 0,
		listPaneCalls: 0,
		...overrides,
	};
}

function makeDeps(h: Harness): WatcherDeps {
	return {
		now: () => h.nowMs,
		existsSync: (path) => h.files.has(path),
		readFileSync: (path) => {
			const raw = h.files.get(path);
			if (raw === undefined) throw new Error(`ENOENT: ${path}`);
			return raw;
		},
		rmSync: (path) => {
			h.files.delete(path);
		},
		readActivityState: (file) => h.activities.get(file) ?? { ok: false, reason: "missing" },
		listPaneIds: () => {
			h.listPaneCalls++;
			return h.panes;
		},
		closePane: (paneId) => {
			h.closedPanes.push(paneId);
		},
		readScreenTail: (paneId) => h.tails.get(paneId) ?? "",
		activeBackend: () => h.backend,
		loadHerdr: () => {
			let exitCb: ((code: number) => void) | undefined;
			h.waiter = {
				exit: (code) => exitCb?.(code),
			};
			return Promise.resolve({
				applyPaneLabel: (paneId: string, label: string) => {
					h.labelCalls.push([paneId, label]);
					return h.applyResult;
				},
				spawnDoneWaiter: (paneId: string, until: string[]) => {
					h.waiterCalls.push([paneId, until]);
					return {
						on: (event: string, cb: (code: number) => void) => {
							if (event === "exit") exitCb = cb;
						},
						kill: () => {
							h.waiterKilled = true;
						},
					} as unknown as ChildProcess;
				},
			} as unknown as typeof import("../herdr.ts"));
		},
		sendMessage: (message, opts) => {
			h.steers.push({ message, opts } as Steer);
		},
		appendTraceCard: (entry) => {
			h.traces.push(entry);
		},
		summarizeSessionFile: (file, fallback) => h.summaries.get(file) ?? { summary: fallback, usage: null, model: null },
		forgetPane: (paneId) => {
			h.forgottenPanes.push(paneId);
		},
		updateWidget: () => {
			h.widgetUpdates++;
		},
	};
}

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "scout-abc12345",
		name: "scout",
		agentName: "researcher",
		task: "explore the codebase",
		paneId: "pane-1",
		startTime: START,
		sessionFile: SESSION,
		activityFile: ACTIVITY,
		doneFile: DONE,
		exitSidecarFile: EXIT,
		autoExit: true,
		agentDef: null,
		activity: { state: null, lastChangeAt: START, stalled: false },
		cancelRequested: false,
		...overrides,
	};
}

function makeAgentDef(overrides: Partial<AgentDef> = {}): AgentDef {
	return {
		name: "researcher",
		description: "researches things",
		autoExit: true,
		body: "",
		warnings: [],
		scope: "project",
		path: "C:/agents/researcher.md",
		...overrides,
	};
}

const flush = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

function oneTick(t: { mock: { timers: { tick(ms: number): void } } }): void {
	t.mock.timers.tick(POLL_INTERVAL_MS);
}

function lastSteer(h: Harness): Steer {
	assert.equal(h.steers.length, 1, `expected exactly one steer, got ${h.steers.length}`);
	return h.steers[0] as Steer;
}

test(".done sidecar alone finishes with the parsed exit code, steers and traces", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "7");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	assert.equal(steer.opts.triggerTurn, true);
	assert.equal(steer.opts.deliverAs, "steer");
	assert.equal(steer.message.customType, "subagent_result");
	const details = steer.message.details;
	assert.equal(details["name"], "scout");
	assert.equal(details["agent"], "researcher");
	assert.equal(details["task"], "explore the codebase");
	assert.equal(details["session"], SESSION);
	assert.equal(details["exitCode"], 7);
	assert.equal(details["elapsedSec"], 0);
	assert.equal(details["status"], "finished");
	assert.match(steer.message.content, /Sub-agent "scout" \(researcher\) finished in 0s\./);
	assert.match(steer.message.content, /Follow up with subagent_message\(\{ name: "scout"/);
	assert.equal(watcher.running.size, 0);
	assert.deepEqual(h.traces, [
		{ agent: "researcher", task: "explore the codebase", session: SESSION, usage: undefined, model: undefined },
	]);
	assert.deepEqual(h.closedPanes, []);
	assert.deepEqual(h.forgottenPanes, []);
});

test(".done with exit code 1 alone reports a failure and keeps the pane open", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "1");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	assert.equal(steer.message.details["exitCode"], 1);
	assert.equal(steer.message.details["status"], "finished");
	assert.match(steer.message.content, /Sub-agent exited with code 1/);
	assert.deepEqual(h.closedPanes, []);
});

test(".done with unparsable body falls back to exit code 0", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "not-a-number");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	assert.equal(lastSteer(h).message.details["exitCode"], 0);
	assert.equal(lastSteer(h).message.details["status"], "finished");
	assert.deepEqual(h.closedPanes, ["pane-1"]);
	assert.deepEqual(h.forgottenPanes, ["pane-1"]);
});

test(".exit error verdict wins when both .exit and .done sidecars exist", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(EXIT, JSON.stringify({ type: "error", errorMessage: "boom" }));
	h.files.set(DONE, "0");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	assert.equal(steer.message.details["exitCode"], 1);
	assert.equal(steer.message.details["errorMessage"], "boom");
	assert.equal(steer.message.details["status"], "failed");
	assert.equal(steer.message.details["cancelled"], undefined);
	assert.deepEqual(h.closedPanes, []);
});

test(".exit unknown body falls back to the generic error message", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(EXIT, JSON.stringify({ type: "whatever" }));
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	assert.equal(lastSteer(h).message.details["errorMessage"], "Subagent exited with stopReason=error.");
});

test("honored cancel (.exit cancelled) completes as cancelled and removes the cancel sidecar", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(EXIT, JSON.stringify({ type: "cancelled" }));
	h.files.set(CANCEL, JSON.stringify({ requestedAt: 1 }));
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	assert.equal(steer.message.details["status"], "cancelled");
	assert.equal(steer.message.details["cancelled"], true);
	assert.match(steer.message.content, /was CANCELLED before finishing/);
	assert.equal(h.files.has(CANCEL), false);
	assert.deepEqual(h.closedPanes, ["pane-1"]);
});

test("empty pane list makes the tick a no-op — nothing is marked crashed", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.panes = new Set();
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	watcher.ensureTicker();
	oneTick(t);
	oneTick(t);

	assert.equal(h.steers.length, 0);
	assert.equal(watcher.running.size, 1);
	assert.equal(h.listPaneCalls, 2);
	assert.equal(h.widgetUpdates, 0);
	assert.equal(entry.activity.stalled, false);
});

test("native done completes after the 5s grace window with the sidecar-lost note", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ nativeDoneAt: h.nowMs - (NATIVE_DONE_GRACE_MS - 1) });
	watcher.track(entry);
	watcher.ensureTicker();
	oneTick(t);
	assert.equal(h.steers.length, 0);

	h.nowMs += 1;
	oneTick(t);
	const steer = lastSteer(h);
	assert.equal(steer.message.details["exitCode"], 0);
	assert.equal(steer.message.details["note"], "native done, sidecar lost");
	assert.equal(steer.message.details["status"], "finished");
});

test("a landed .done sidecar beats an older native done signal", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "5");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning({ nativeDoneAt: h.nowMs - 10_000 }));
	watcher.ensureTicker();
	oneTick(t);

	assert.equal(lastSteer(h).message.details["exitCode"], 5);
	assert.equal(lastSteer(h).message.details["note"], undefined);
});

test("native done beats the pane-vanished crash path", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.panes = new Set(["other-pane"]);
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning({ nativeDoneAt: h.nowMs - NATIVE_DONE_GRACE_MS }));
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	assert.equal(steer.message.details["note"], "native done, sidecar lost");
	assert.equal(steer.message.details["crashed"], undefined);
	assert.deepEqual(h.closedPanes, ["pane-1"]);
	assert.deepEqual(h.forgottenPanes, ["pane-1"]);
});

test("pane missing from the alive set completes as crashed and is dropped from the column cache", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.panes = new Set(["other-pane"]);
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	assert.equal(steer.message.details["crashed"], undefined);
	assert.equal(steer.message.details["errorMessage"], "pane closed");
	assert.equal(steer.message.details["status"], "failed");
	assert.equal(steer.message.details["exitCode"], 1);
	assert.match(steer.message.content, /Subagent error: pane closed/);
	assert.deepEqual(h.forgottenPanes, ["pane-1"]);
	assert.deepEqual(h.closedPanes, []);
});

test("screen sentinel fallback parses the exit code when sidecars never landed", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.tails.set("pane-1", "doing things...\n__SUBAGENT_DONE_3__");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	assert.equal(lastSteer(h).message.details["exitCode"], 3);
});

test("cancel grace period force-closes the pane only after CANCEL_KILL_AFTER_MS", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ cancelRequested: true, cancelStartedAt: h.nowMs });
	watcher.track(entry);
	watcher.ensureTicker();
	h.nowMs += CANCEL_KILL_AFTER_MS;
	oneTick(t);
	assert.equal(h.steers.length, 0);

	h.nowMs += 1;
	oneTick(t);
	const steer = lastSteer(h);
	assert.equal(steer.message.details["cancelled"], true);
	assert.equal(steer.message.details["status"], "cancelled");
	assert.equal(steer.message.details["errorMessage"], "cancelled — pane force-closed after grace period");
	assert.deepEqual(h.closedPanes, ["pane-1", "pane-1"]);
	assert.deepEqual(h.forgottenPanes, ["pane-1", "pane-1"]);
});

test("double completeFromSidecars is a no-op the second time (orphan guard)", () => {
	const h = makeHarness();
	h.files.set(DONE, "0");
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	assert.equal(watcher.completeFromSidecars(entry), true);
	assert.equal(watcher.completeFromSidecars(entry), false);
	assert.equal(h.steers.length, 1);
	assert.equal(watcher.completeFromSidecars(makeRunning({ id: "ghost-1", name: "ghost" })), false);
	assert.equal(h.steers.length, 1);
});

test("the ticker interval is cleared when the running map empties", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "0");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);
	assert.equal(h.steers.length, 1);
	assert.equal(h.listPaneCalls, 1);
	assert.equal(h.widgetUpdates, 2);

	t.mock.timers.tick(5 * POLL_INTERVAL_MS);
	assert.equal(h.steers.length, 1);
	assert.equal(h.listPaneCalls, 1);
	assert.equal(h.widgetUpdates, 2);
});

test("session_start reset clears the map and stops completions", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);
	assert.equal(h.widgetUpdates, 1);

	watcher.reset();
	assert.equal(watcher.running.size, 0);
	oneTick(t);
	assert.equal(h.steers.length, 0);
	assert.equal(h.widgetUpdates, 1);
	assert.equal(h.listPaneCalls, 1);
});

test("done-waiter arms after NATIVE_WAITER_DELAY_MS and stamps nativeDoneAt on exit 0", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS - POLL_INTERVAL_MS);
	await flush();
	assert.equal(h.waiterCalls.length, 0);
	t.mock.timers.tick(POLL_INTERVAL_MS);
	await flush();
	assert.deepEqual(h.waiterCalls, [["pane-1", ["done", "unknown"]]]);
	assert.notEqual(h.waiter, null);
	h.waiter?.exit(0);
	assert.equal(entry.nativeDoneAt, h.nowMs);
	assert.notEqual(entry.doneWaiter, undefined);
});

test("done-waiter exit code 1 does not stamp nativeDoneAt", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	h.waiter?.exit(1);
	assert.equal(entry.nativeDoneAt, undefined);
});

test("done-waiter is skipped for agents that may spawn children", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ agentDef: makeAgentDef({ subagents: ["child-agent"] }) });
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.equal(h.waiterCalls.length, 0);
	assert.equal(entry.doneWaiterTimer, undefined);
});

test("done-waiter is skipped for interactive (non auto-exit) agents", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ autoExit: false });
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.equal(h.waiterCalls.length, 0);
	assert.equal(entry.doneWaiterTimer, undefined);
});

test("no waiter is armed on the wezterm backend", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.equal(h.waiterCalls.length, 0);
	assert.equal(entry.doneWaiterTimer, undefined);
});

test("armed done-waiter applies the deferred re-label before spawning", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ labelPending: true });
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.deepEqual(h.labelCalls, [["pane-1", "scout"]]);
	assert.equal(entry.labelPending, false);
	assert.deepEqual(h.waiterCalls, [["pane-1", ["done", "unknown"]]]);
});

test("standalone deferred re-label fires for entries without a done-waiter timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ autoExit: false, labelPending: true });
	watcher.track(entry);
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.deepEqual(h.labelCalls, [["pane-1", "scout"]]);
	assert.equal(entry.labelPending, false);
});

test("session reset orphans a pending done-waiter arm — no waiter is spawned", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.reset();
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.equal(h.waiterCalls.length, 0);
	assert.equal(h.labelCalls.length, 0);
});

test("shutdown kills live waiters, clears the ticker and empties the map", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	watcher.ensureTicker();
	t.mock.timers.tick(NATIVE_WAITER_DELAY_MS);
	await flush();
	assert.equal(h.waiterCalls.length, 1);
	assert.notEqual(entry.doneWaiter, undefined);

	watcher.shutdown();
	assert.equal(h.waiterKilled, true);
	assert.equal(watcher.running.size, 0);
	const listPaneCallsAtShutdown = h.listPaneCalls;
	t.mock.timers.tick(5 * POLL_INTERVAL_MS);
	assert.equal(h.listPaneCalls, listPaneCallsAtShutdown);
});

test("pollTick retries the deferred re-label no earlier than LABEL_RETRY_INTERVAL_MS", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ labelPending: true, labelLastAttemptAt: START });
	watcher.track(entry);
	watcher.ensureTicker();
	h.nowMs = START + LABEL_RETRY_INTERVAL_MS - POLL_INTERVAL_MS;
	oneTick(t);
	await flush();
	assert.equal(h.labelCalls.length, 0);

	h.nowMs = START + LABEL_RETRY_INTERVAL_MS;
	oneTick(t);
	await flush();
	assert.deepEqual(h.labelCalls, [["pane-1", "scout"]]);
	assert.equal(entry.labelPending, false);
});

test("re-label gives up at the 60s ceiling even when applyPaneLabel keeps failing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.backend = "herdr";
	h.applyResult = false;
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({
		startTime: START - 60_000,
		labelPending: true,
		labelLastAttemptAt: START - LABEL_RETRY_INTERVAL_MS,
	});
	watcher.track(entry);
	watcher.ensureTicker();
	oneTick(t);
	await flush();
	assert.deepEqual(h.labelCalls, [["pane-1", "scout"]]);
	assert.equal(entry.labelPending, false);
});

test("a silent auto-exit subagent flips to stalled and sends one status steer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.activities.set(ACTIVITY, {
		ok: true,
		state: {
			version: 1,
			runningChildId: "scout-abc12345",
			createdAt: START,
			updatedAt: START,
			sequence: 1,
			latestEvent: "tool_execution_start",
			phase: "active",
			agentActive: true,
			toolActive: true,
			toolName: "bash",
		},
	});
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning();
	watcher.track(entry);
	watcher.ensureTicker();
	oneTick(t);
	assert.equal(entry.activity.stalled, false);

	h.nowMs = START + STALLED_AFTER_MS + 1;
	oneTick(t);
	assert.equal(entry.activity.stalled, true);
	const steer = h.steers.find((s) => s.message.customType === "subagent_status");
	assert.notEqual(steer, undefined);
	assert.equal(steer?.message.details["stalled"], true);
	assert.match(steer?.message.content ?? "", /looks stalled/);
	assert.match(steer?.message.content ?? "", /last seen: tool bash/);
});

test("activity recovery clears the stalled flag and reports active again", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	let sequence = 1;
	const state = (): ActivityReadResult => ({
		ok: true,
		state: {
			version: 1,
			runningChildId: "scout-abc12345",
			createdAt: START,
			updatedAt: h.nowMs,
			sequence,
			latestEvent: "tool_execution_start",
			phase: "active",
			agentActive: true,
			toolActive: true,
			toolName: "bash",
		},
	});
	h.activities.set(ACTIVITY, state());
	const watcher = createSubagentWatcher(makeDeps(h));
	const entry = makeRunning({ activity: { state: null, lastChangeAt: START - STALLED_AFTER_MS - 1, stalled: true } });
	watcher.track(entry);
	watcher.ensureTicker();
	oneTick(t);
	assert.equal(entry.activity.stalled, false);

	sequence = 2;
	h.activities.set(ACTIVITY, state());
	oneTick(t);
	assert.equal(entry.activity.stalled, false);
	const steer = h.steers.find((s) => s.message.customType === "subagent_status");
	assert.notEqual(steer, undefined);
	assert.equal(steer?.message.details["stalled"], false);
	assert.match(steer?.message.content ?? "", /is active again/);
});

test("usage totals land in the steer content and details", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "0");
	h.summaries.set(SESSION, { summary: "All done.", usage: { input: 1234, output: 20, cost: 0 }, model: null });
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	assert.match(lastSteer(h).message.content, /Usage: 1\.2k in \/ 20 out\./);
	assert.equal(lastSteer(h).message.details["usageText"], "1.2k in / 20 out");
});

test("over-long summaries are truncated with the transcript pointer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "0");
	h.summaries.set(SESSION, { summary: "x".repeat(MAX_SUMMARY_CHARS + 500), usage: null, model: null });
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning());
	watcher.ensureTicker();
	oneTick(t);

	const steer = lastSteer(h);
	const tail = `… [truncated — full transcript: ${SESSION}]`;
	assert.match(steer.message.content, new RegExp(tail.replace(/[[\](){}*+?|^$\\.-]/g, "\\$&")));
	assert.equal(steer.message.details["summary"], `${"x".repeat(MAX_SUMMARY_CHARS)}\n${tail}`);
});

test("trace card falls back to the display name when agentName is empty", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = makeHarness();
	h.files.set(DONE, "0");
	const watcher = createSubagentWatcher(makeDeps(h));
	watcher.track(makeRunning({ agentName: "" }));
	watcher.ensureTicker();
	oneTick(t);

	assert.equal(h.traces[0]?.["agent"], "scout");
});
