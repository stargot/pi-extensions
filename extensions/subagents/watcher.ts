import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";
import type { ActivityReadResult, SubagentActivityState } from "./activity.ts";
import { herdrAgentName, type MuxBackendName, type NativeAgentOps } from "./mux.ts";
import { formatUsage, type SessionSummary } from "./session-read.ts";
import { cancelSidecarPath, classifyExitSidecar, fmtElapsed, parseSentinel } from "./shared.ts";

export const POLL_INTERVAL_MS = 1000;
// Five minutes of ZERO events — streaming deltas and tool output count as
// events (activity heartbeats), so a healthy long model stream no longer
// trips this. Only a truly silent pane does.
export const STALLED_AFTER_MS = 5 * 60_000;
// After subagent_cancel, the child should honor the flag within ~1s; if the
// pane is still there after this grace period, force-close it.
export const CANCEL_KILL_AFTER_MS = 10_000;

// ADR-2: one background `herdr agent wait` per auto-exit subagent, armed with
// a delay from the pane spawn. Pi registers with herdr within ~2–5s of boot
// (probe: visible at +3s); a waiter aimed at a not-yet-registered pane fails
// fast with agent_not_found (exit 1 — harmless, no false done), so the delay
// only has to cover a slow boot: 10s does, with margin.
export const NATIVE_WAITER_DELAY_MS = 10_000;
// Deferred re-label ceiling (ADR-3): the +10s re-label can still miss (slow
// boot), so pollTick retries the rename while labelPending — then
// surrenders for good here. Renaming stays cosmetics (all addressing goes
// through pane ids); the ceiling just bounds how long the cosmetics retry.
export const LABEL_PENDING_MAX_MS = 60_000;
// R10: pollTick re-label retry cadence. Every failed rename makes herdr
// print a raw error envelope at the calling pane (agent_not_found while the
// record is not up — the R9 leak), so the safety net retries at a 10s
// cadence, not once per 1s tick: 6 attempts inside the 60s ceiling are
// plenty for a slow boot, and a record that never appears stops being
// hammered.
export const LABEL_RETRY_INTERVAL_MS = 10_000;
// A native done flag older than this means the launcher sidecars are truly
// lost, not "pi just exited, .done is mid-write" — the grace re-opens that
// race so the sidecar path (step 1) still wins whenever it can.
export const NATIVE_DONE_GRACE_MS = 5000;
// Settled states the done-waiter fires on (probe, herdr 0.9.1-preview): pi
// never reported "unknown", but a wedged/unclassifiable agent should still
// end the wait; "done" (turn finished) is the only state pi reaches before
// its record is removed on exit. --until is repeatable, one flag per state.
export const NATIVE_DONE_UNTIL = ["done", "unknown"];
export const MAX_SUMMARY_CHARS = 2000;

export interface ActivityObservation {
	state: SubagentActivityState | null;
	lastChangeAt: number;
	stalled: boolean;
}

export interface RunningSubagent {
	id: string;
	name: string;
	agentName: string;
	task: string;
	paneId: string;
	startTime: number;
	sessionFile: string;
	activityFile: string;
	doneFile: string;
	exitSidecarFile: string;
	autoExit: boolean;
	agentDef: AgentDef | null;
	activity: ActivityObservation;
	/** Set by subagent_cancel — armed the pane force-close grace period. */
	cancelRequested: boolean;
	cancelStartedAt?: number;
	/** Set when the herdr done-waiter observed a terminal agent state (ADR-2). */
	nativeDoneAt?: number;
	/** Background `herdr agent wait` child and its pending arming timer (herdr backend, auto-exit only). */
	doneWaiter?: ChildProcess;
	doneWaiterTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Herdr only: the split-time label inside createSubagentPane reliably
	 * misses (the agent record appears only when the child registers), so a
	 * deferred re-label — the +10s timer, with pollTick retrying to
	 * LABEL_PENDING_MAX_MS — still has to apply it.
	 */
	labelPending?: boolean;
	/** Last deferred re-label attempt (any outcome) — paces pollTick retries (R10). */
	labelLastAttemptAt?: number;
	vanishedSince?: number;
}

export interface TraceEntry {
	agent: string;
	task: string;
	session?: string;
	usage?: unknown;
	model?: string;
}

export type PaneListSnapshot = { ok: true; ids: Set<string>; completedAt: number } | { ok: false; completedAt: number };

export interface WatcherPaneOps {
	refreshPaneList(): void;
	paneListSnapshot(): PaneListSnapshot | null;
	requestScreenTail(paneId: string): void;
	screenTailSnapshot(paneId: string): string;
	dropPane(paneId: string): void;
}

export interface WatcherDeps {
	now(): number;
	existsSync(path: string): boolean;
	readFileSync(path: string, options: BufferEncoding): string;
	rmSync(path: string, options: { force: true }): void;
	readActivityState(activityFile: string, runningChildId: string): ActivityReadResult;
	panes: WatcherPaneOps;
	closePane(paneId: string): void;
	activeBackend(): MuxBackendName | null;
	loadNativeAgentOps(): Promise<NativeAgentOps> | null;
	sendMessage(
		message: Parameters<ExtensionAPI["sendMessage"]>[0],
		opts: { triggerTurn: boolean; deliverAs: "steer" },
	): void;
	appendTraceCard(entry: TraceEntry): void;
	summarizeSessionFile(sessionFile: string, fallback: string): SessionSummary;
	forgetPane(paneId: string): void;
	updateWidget(): void;
}

export interface SubagentWatcher {
	readonly running: Map<string, RunningSubagent>;
	track(running: RunningSubagent): void;
	ensureTicker(): void;
	completeFromSidecars(running: RunningSubagent): boolean;
	reset(): void;
	shutdown(): void;
}

export function createSubagentWatcher(deps: WatcherDeps): SubagentWatcher {
	const runningSubagents = new Map<string, RunningSubagent>();
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	let relabelInFlight = false;
	const {
		existsSync,
		readFileSync,
		rmSync,
		readActivityState,
		panes,
		closePane,
		activeBackend,
		loadNativeAgentOps,
		sendMessage,
		appendTraceCard,
		summarizeSessionFile,
		forgetPane,
		updateWidget,
	} = deps;

	/** Spawn/rename state shared with subagent-done.ts via a process-global. */
	function publishRunningChildrenCount(): void {
		(globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents/running-children-count")] = () =>
			runningSubagents.size;
	}
	publishRunningChildrenCount();

	/**
	 * Arm the native done-waiter for a subagent (ADR-2): one background `herdr
	 * agent wait` process, spawned NATIVE_WAITER_DELAY_MS after the pane spawn;
	 * its exit(0) stamps running.nativeDoneAt for pollTick — and the same timer
	 * carries the deferred re-label (ADR-3), since one delay covers both "pi has
	 * registered" and "safe to wait". Backend check goes through mux's
	 * activeBackend — index.ts stays herdr-agnostic (no direct herdr imports;
	 * the delayed import is of a module already in the ESM graph via mux, so it
	 * resolves without I/O). Auto-exit children only: herdr's
	 * "done" means "turn finished", which for an interactive child (one that
	 * waits for the next steering message at its prompt) is not completion.
	 * Best-effort by design: a failed/late/missing waiter changes nothing — the
	 * sidecar watcher remains the source of truth.
	 */
	function armDoneWaiter(running: RunningSubagent): void {
		const def = running.agentDef;
		const canSpawnChildren = !!(def?.subagents && def.subagents.length > 0);
		if (activeBackend() !== "herdr" || !running.autoExit || canSpawnChildren) {
			// No done-waiter timer to piggyback on (interactive child without
			// auto-exit — herdr backend is guaranteed here, labelPending is never
			// set elsewhere): the deferred re-label gets a standalone one-shot
			// with the same delay and orphan guard.
			if (running.labelPending) armDeferredRelabel(running);
			return;
		}
		const timer = setTimeout(() => {
			running.doneWaiterTimer = undefined;
			const ops = loadNativeAgentOps();
			if (!ops) return;
			void ops
				.then(async (native) => {
					// Completed (or session reset) while the module promise settled:
					// never spawn a waiter for a dead entry — it would orphan.
					if (runningSubagents.get(running.id) !== running) return;
					// Deferred re-label (ADR-3): the split-time rename inside
					// createSubagentPane reliably missed (no agent record before
					// the child registers), and this delay — the same one that
					// makes the waiter safe — now covers registration, so the
					// label can land for real. A miss leaves the flag up for the
					// pollTick safety net. The attempt is stamped so the safety
					// net's own pacing (R10) starts from here, not from boot.
					if (running.labelPending) {
						running.labelLastAttemptAt = deps.now();
						if (await native.applyPaneLabelAsync(running.paneId, herdrAgentName(running.name))) {
							running.labelPending = false;
						}
						if (runningSubagents.get(running.id) !== running) return;
					}
					const waiter = native.spawnDoneWaiter(running.paneId, NATIVE_DONE_UNTIL);
					if (!waiter) return;
					waiter.on("exit", (code) => {
						if (code === 0) running.nativeDoneAt = deps.now();
					});
					running.doneWaiter = waiter;
				})
				.catch(() => {
					// No waiter, no flag — the watcher alone finishes the entry.
				});
		}, NATIVE_WAITER_DELAY_MS);
		// A pending arm must never keep the parent alive (session_shutdown drops
		// the map without completing entries).
		timer.unref();
		running.doneWaiterTimer = timer;
	}

	/**
	 * Standalone deferred re-label for entries without a done-waiter timer to
	 * piggyback on (see armDoneWaiter). Same delay and orphan guard: at +10s the
	 * agent record is reliably up (pi registers within ~2–5s of boot), so one
	 * best-effort applyPaneLabel closes the split-time gap; a miss leaves
	 * labelPending up for the pollTick retry until LABEL_PENDING_MAX_MS. Never
	 * throws; the one-shot timer is never stored — completeSubagent need not
	 * clean it up, the orphan guard disposes of late fires.
	 */
	function armDeferredRelabel(running: RunningSubagent): void {
		const timer = setTimeout(() => {
			const ops = loadNativeAgentOps();
			if (!ops) return;
			void ops
				.then(async (native) => {
					if (runningSubagents.get(running.id) !== running || !running.labelPending) return;
					// Stamp before the attempt: paces the pollTick safety net (R10).
					running.labelLastAttemptAt = deps.now();
					if (await native.applyPaneLabelAsync(running.paneId, herdrAgentName(running.name))) {
						running.labelPending = false;
					}
				})
				.catch(() => {
					// Miss — pollTick keeps retrying until the ceiling.
				});
		}, NATIVE_WAITER_DELAY_MS);
		// Same discipline as the done-waiter arm: never keep the parent alive.
		timer.unref();
	}

	function disposeWaiter(stale: RunningSubagent): void {
		if (stale.doneWaiterTimer) {
			clearTimeout(stale.doneWaiterTimer);
			stale.doneWaiterTimer = undefined;
		}
		try {
			stale.doneWaiter?.kill();
		} catch {
			// Already gone.
		}
		stale.doneWaiter = undefined;
	}

	function completeSubagent(
		running: RunningSubagent,
		result: { exitCode: number; errorMessage?: string; crashed?: boolean; cancelled?: boolean; note?: string },
	): void {
		// ADR-2 teardown: the done-waiter (or its pending arming timer) must not
		// outlive the entry — every completion path goes through this function.
		disposeWaiter(running);

		runningSubagents.delete(running.id);
		panes.dropPane(running.paneId);
		publishRunningChildrenCount();

		if (tickTimer && runningSubagents.size === 0) {
			clearInterval(tickTimer);
			tickTimer = null;
		}

		// Cancel verdict: either we decided it, or a late cancel sidecar exists.
		// The sidecar is then removed so a resume of the same session file does
		// not instantly trip the new child's cancel poller.
		const cancelFile = cancelSidecarPath(running.sessionFile);
		const cancelled = result.cancelled === true || existsSync(cancelFile);
		if (cancelled) {
			try {
				rmSync(cancelFile, { force: true });
			} catch {
				// Best effort.
			}
		}

		const fallback = result.errorMessage
			? `Subagent error: ${result.errorMessage}`
			: result.crashed
				? "Subagent pane was closed before it finished."
				: result.exitCode !== 0
					? `Sub-agent exited with code ${result.exitCode}`
					: "Sub-agent exited without output";
		const { summary, usage, model } = summarizeSessionFile(running.sessionFile, fallback);
		const elapsedSec = Math.floor((deps.now() - running.startTime) / 1000);
		// trace integration: child card in /trace (TUI) and web viewer.
		appendTraceCard({
			agent: running.agentName || running.name,
			task: running.task,
			session: running.sessionFile,
			usage: usage ?? undefined,
			model: model ?? undefined,
		});

		const usageText = usage && (usage.input > 0 || usage.output > 0) ? formatUsage(usage) : undefined;
		const elapsedText = fmtElapsed(elapsedSec);
		// Same truncated form the LLM sees — the subagent_result card renders this exact text.
		const summaryText =
			summary.length > MAX_SUMMARY_CHARS
				? `${summary.slice(0, MAX_SUMMARY_CHARS)}\n… [truncated — full transcript: ${running.sessionFile}]`
				: summary;
		const statusLine = cancelled
			? `cancelled by user after ${elapsedText}`
			: result.errorMessage
				? `failed after ${elapsedText}`
				: `finished in ${elapsedText}`;

		const content = [
			...(cancelled
				? [
						`⚠ Sub-agent "${running.name}" was CANCELLED before finishing — treat everything below as partial work, do not assume the task completed.`,
					]
				: []),
			`Sub-agent "${running.name}" (${running.agentName || "adhoc"}) ${statusLine}.`,
			usageText ? `Usage: ${usageText}.` : "",
			"",
			summaryText,
			"",
			`Follow up with subagent_message({ name: "${running.name}", message: "…" }) — the same name works whether the pane is still open or has since been closed.`,
		]
			.filter((s) => s !== "")
			.join("\n");

		sendMessage(
			{
				customType: "subagent_result",
				content,
				display: true,
				details: {
					name: running.name,
					agent: running.agentName,
					task: running.task,
					session: running.sessionFile,
					exitCode: result.exitCode,
					elapsedSec,
					// Display-only extras for the subagent_result card renderer.
					status: cancelled ? "cancelled" : result.errorMessage ? "failed" : "finished",
					...(usageText ? { usageText } : {}),
					...(summary ? { summary: summaryText } : {}),
					...(cancelled ? { cancelled: true } : {}),
					...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
					...(usage ? { usage } : {}),
					...(model ? { model } : {}),
					...(result.note ? { note: result.note } : {}),
				},
			} as Parameters<ExtensionAPI["sendMessage"]>[0],
			{ triggerTurn: true, deliverAs: "steer" },
		);

		// Collapse the pane once the result is delivered — one policy for both
		// surfaces (herdr and WezTerm): an exited auto-exit subagent leaves a
		// dead shell pane that only clutters the workspace, and nobody wants to
		// type `exit` into it by hand. This is safe: the transcript lives in the
		// session file (/trace links to it) and resume recreates the pane on
		// demand. Failed runs keep the pane open for on-screen debugging;
		// cancelled runs close like successes (a cancelled pane has nothing left
		// to inspect). Interactive (auto-exit: false) agents never collapse —
		// their pane lives until the user closes it.
		const paneShouldCollapse = cancelled || (running.autoExit && !result.errorMessage && result.exitCode === 0);
		if (paneShouldCollapse) {
			closePane(running.paneId);
			forgetPane(running.paneId);
		}

		updateWidget();
	}

	/** What the subagent was last seen doing — feeds the stall notices. */
	function describeActivity(state: SubagentActivityState | null): string {
		if (state?.toolActive && state.toolName) return `tool ${state.toolName}`;
		return state?.phase ?? "unknown";
	}

	function notifyStalled(running: RunningSubagent, stalled: boolean): void {
		const now = deps.now();
		const elapsed = fmtElapsed(Math.floor((now - running.startTime) / 1000));
		const silentSec = Math.floor((now - running.activity.lastChangeAt) / 1000);
		const text = stalled
			? `Sub-agent "${running.name}" (${running.agentName}) looks stalled: no events for ${fmtElapsed(silentSec)} (total ${elapsed}); last seen: ${describeActivity(running.activity.state)}. ` +
				`Steer with subagent_message (it auto-interrupts stalled agents), or cancel with subagent_cancel({ name: "${running.name}" }), or ignore.`
			: `Sub-agent "${running.name}" is active again (${describeActivity(running.activity.state)}) after ${fmtElapsed(silentSec)} of silence.`;
		sendMessage(
			{
				customType: "subagent_status",
				content: text,
				display: true,
				details: {
					name: running.name,
					agent: running.agentName,
					stalled,
					silentMs: now - running.activity.lastChangeAt,
					phase: running.activity.state?.phase,
					toolName: running.activity.state?.toolName,
				},
			} as Parameters<ExtensionAPI["sendMessage"]>[0],
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	function observeActivity(running: RunningSubagent, now: number): void {
		const read = readActivityState(running.activityFile, running.id);
		if (read.ok) {
			const obs = running.activity;
			const changed = !obs.state || read.state.sequence !== obs.state.sequence;
			if (changed) obs.lastChangeAt = now;
			// Refresh state before the notice so "active again" names the NEW
			// activity, not the one that preceded the silence.
			obs.state = read.state;
			if (changed && obs.stalled) {
				obs.stalled = false;
				if (running.autoExit) notifyStalled(running, false);
			}
		}
		const stalledCandidate =
			running.autoExit && running.activity.state !== null && now - running.activity.lastChangeAt > STALLED_AFTER_MS;
		if (stalledCandidate && !running.activity.stalled) {
			running.activity.stalled = true;
			notifyStalled(running, true);
		}
	}

	function completeFromSidecars(running: RunningSubagent): boolean {
		if (runningSubagents.get(running.id) !== running) return false;
		if (existsSync(running.exitSidecarFile)) {
			const verdict = classifyExitSidecar(readDoneFile(running.exitSidecarFile));
			if (verdict.kind === "cancelled") {
				// The child honored the cancel flag and exited — not an error.
				completeSubagent(running, { exitCode: 1, cancelled: true });
				return true;
			}
			const errorMessage =
				verdict.kind === "error" && verdict.errorMessage
					? verdict.errorMessage
					: "Subagent exited with stopReason=error.";
			completeSubagent(running, { exitCode: 1, errorMessage });
			return true;
		}
		if (existsSync(running.doneFile)) {
			let exitCode = 0;
			try {
				exitCode = Number.parseInt(readDoneFile(running.doneFile), 10);
				if (!Number.isFinite(exitCode)) exitCode = 0;
			} catch {
				exitCode = 0;
			}
			completeSubagent(running, { exitCode });
			return true;
		}
		return false;
	}

	function pollTick(): void {
		if (runningSubagents.size === 0) return;
		const now = deps.now();
		panes.refreshPaneList();
		const paneSnapshot = panes.paneListSnapshot();
		const alive = paneSnapshot !== null && paneSnapshot.ok && paneSnapshot.ids.size > 0 ? paneSnapshot.ids : null;

		for (const running of Array.from(runningSubagents.values())) {
			// 1. Fast path: launcher-written sidecar with the exit code.
			if (completeFromSidecars(running)) continue;

			// 3. Native done signal (ADR-2): the background `herdr agent wait` saw
			// a terminal settled state, but no sidecar landed — the launcher's
			// writes are lost. The grace re-opens the common race where pi just
			// exited and the launcher has not written .done yet; if .done appears
			// in that window, step 1 above still wins with the real exit code.
			if (running.nativeDoneAt !== undefined && now - running.nativeDoneAt >= NATIVE_DONE_GRACE_MS) {
				completeSubagent(running, { exitCode: 0, note: "native done, sidecar lost" });
				continue;
			}

			// 4. Pane vanished without finishing → crashed or closed by the user.
			const isFresh = paneSnapshot !== null && paneSnapshot.ok && paneSnapshot.completedAt > running.startTime;
			if (alive !== null && !alive.has(running.paneId) && isFresh) {
				if (running.vanishedSince === undefined) {
					running.vanishedSince = now;
					continue;
				}
				forgetPane(running.paneId);
				completeSubagent(running, { exitCode: 1, crashed: true, errorMessage: "pane closed" });
				continue;
			}
			running.vanishedSince = undefined;

			// 5. Screen sentinel fallback (sidecars failed to write).
			panes.requestScreenTail(running.paneId);
			const sentinel = parseSentinel(panes.screenTailSnapshot(running.paneId));
			if (sentinel !== null) {
				completeSubagent(running, { exitCode: sentinel });
				continue;
			}

			// 6. Cancel grace period: the child honors the flag within ~1s; a
			// pane still alive this long later is wedged — force-close it.
			if (running.cancelRequested && now - (running.cancelStartedAt ?? now) > CANCEL_KILL_AFTER_MS) {
				closePane(running.paneId);
				forgetPane(running.paneId);
				completeSubagent(running, {
					exitCode: 1,
					cancelled: true,
					errorMessage: "cancelled — pane force-closed after grace period",
				});
				continue;
			}

			// 7. Deferred label safety net (ADR-3): the +10s re-label timer can
			// still miss (slow boot); while labelPending, retry the rename on a
			// 10s cadence (R10: every failed rename makes herdr print a raw
			// error envelope at the calling pane — agent_not_found while the
			// record is not up — so the safety net paces itself instead of
			// firing every 1s tick) until it sticks or the 60s ceiling
			// surrenders for good (renaming stays cosmetics: addressing always
			// goes through pane ids).
			if (
				running.labelPending &&
				!relabelInFlight &&
				now - (running.labelLastAttemptAt ?? running.startTime) >= LABEL_RETRY_INTERVAL_MS
			) {
				running.labelLastAttemptAt = now;
				relabelInFlight = true;
				const ops = loadNativeAgentOps();
				const flight = (ops ?? Promise.resolve(null)).then(async (native) => {
					if (!native) return;
					if (runningSubagents.get(running.id) !== running || !running.labelPending) return;
					if (
						(await native.applyPaneLabelAsync(running.paneId, herdrAgentName(running.name))) ||
						deps.now() - running.startTime >= LABEL_PENDING_MAX_MS
					) {
						running.labelPending = false;
					}
				});
				void flight
					.catch(() => {
						// herdr hiccup this tick — the ceiling surrenders eventually.
					})
					.finally(() => {
						relabelInFlight = false;
					});
			}

			observeActivity(running, now);
		}

		updateWidget();
	}

	function readDoneFile(path: string): string {
		// Small sync reads once per second per subagent — fine with node:fs.
		return readFileSync(path, "utf8").trim();
	}

	function ensureTicker(): void {
		if (tickTimer) return;
		tickTimer = setInterval(() => {
			try {
				pollTick();
			} catch {
				// A broken tick must never take the session down.
			}
		}, POLL_INTERVAL_MS);
	}
	function track(sub: RunningSubagent): void {
		runningSubagents.set(sub.id, sub);
		panes.dropPane(sub.paneId);
		publishRunningChildrenCount();
		armDoneWaiter(sub);
	}

	function reset(): void {
		for (const stale of runningSubagents.values()) disposeWaiter(stale);
		runningSubagents.clear();
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	}

	function shutdown(): void {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
		// Drop pending done-waiters: nobody reads nativeDoneAt after shutdown,
		// and an unref'd waiter would otherwise linger for its full timeout.
		for (const stale of runningSubagents.values()) disposeWaiter(stale);
		runningSubagents.clear();
	}

	return { running: runningSubagents, track, ensureTicker, completeFromSidecars, reset, shutdown };
}
