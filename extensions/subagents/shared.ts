/**
 * Pure helpers shared by the mux backends: completion sentinel parsing,
 * split-layout math and steer-delivery failure texts. No child_process,
 * no env reads — safe to unit-test.
 */

// Type-only: erased at runtime, so this creates no import cycle with herdr.ts
// (which imports shared.ts for the runtime helpers below).
import type { AgentPromptOutcome } from "./herdr.ts";

// ── Completion detection ──

export const SENTINEL_PATTERN = /__SUBAGENT_DONE_(\d+)__/;

/** Extract an exit code from a `__SUBAGENT_DONE_<code>__` sentinel line, or null. */
export function parseSentinel(screenText: string): number | null {
	const match = SENTINEL_PATTERN.exec(screenText);
	if (!match) return null;
	const code = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(code) ? code : null;
}

// ── Layout math ──

/**
 * Percent for splitting the top pane of an existing, evenly stacked column of
 * `runningCount` panes so that the new stack stays even.
 *
 * A column of k equal panes has each pane at height H/k; the new pane must get
 * H/(k+1), which is k/(k+1) of the split target: k=1 → 50%, k=2 → 67%,
 * k=3 → 75%, k=4 → 80%.
 */
export function computeStackPercent(runningCount: number): number {
	if (runningCount < 1) return 50;
	return Math.round((runningCount * 100) / (runningCount + 1));
}

// ── Cancel / interrupt ──

/** Sidecar file whose presence tells the child its run was cancelled. */
export function cancelSidecarPath(sessionFile: string): string {
	return `${sessionFile}.cancel`;
}

/** Verdict of an `.exit` sidecar body — what pollTick should do with it. */
export type ExitSidecarVerdict = { kind: "error"; errorMessage?: string } | { kind: "cancelled" } | { kind: "unknown" };

/**
 * Classify a raw `.exit` sidecar body written by the child extension:
 * {type:"cancelled"} → cancelled; an object with a non-empty string
 * errorMessage → error; anything else (bad JSON, empty/missing message) →
 * unknown — the caller then falls back to its generic error text.
 */
export function classifyExitSidecar(raw: string): ExitSidecarVerdict {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "unknown" };
	}
	if (parsed === null || typeof parsed !== "object") return { kind: "unknown" };
	const obj = parsed as { type?: unknown; errorMessage?: unknown };
	if (obj.type === "cancelled") return { kind: "cancelled" };
	if (typeof obj.errorMessage === "string" && obj.errorMessage.length > 0) {
		return { kind: "error", errorMessage: obj.errorMessage };
	}
	return { kind: "unknown" };
}

/**
 * Resolve the `interrupt` flag of subagent_message. Explicit true/false wins;
 * when omitted, a stalled subagent is interrupted automatically — steering a
 * stalled worker is pointless if it only lands at the next turn boundary,
 * which is exactly what "stalled" says never comes.
 */
export function resolveInterrupt(interrupt: boolean | undefined, stalled: boolean): boolean {
	if (interrupt === true) return true;
	if (interrupt === false) return false;
	return stalled;
}

// ── Steer delivery failures (herdr `agent prompt`, ADR-1) ──

/**
 * Human-readable tool-error text for a failed `agent prompt` delivery, named
 * after the outcome herdr reported (ADR-1 in docs/herdr-agent-surface-backlog.md).
 * Same "Could not deliver the message" house style as the pane-gone error in
 * index.ts, but each outcome tells its own story and what to do next:
 * refused_blocked — the text was rejected BEFORE reaching the pane (the child
 * sits in an approval UI), so a blind retry would fail the same way; stalled —
 * the text was submitted but the child never showed working; timeout — the
 * wait window elapsed with the pane still alive, but the submission itself
 * went through, so the message may have already landed (no blind resend);
 * not_found — the pane no longer runs
 * an agent, the subagent is gone (R10: subagent_message reports this case as
 * a normal "already finished" result instead of an error, so this branch is
 * defensive — kept for exhaustiveness); error — anything unmapped.
 */
export function describePromptFailure(outcome: AgentPromptOutcome, name: string): string {
	const head = `Could not deliver the message to subagent "${name}"`;
	switch (outcome) {
		case "refused_blocked":
			return (
				`${head}: the subagent is waiting for input (blocked) and the message was NOT delivered — ` +
				`answer its question, or resend with interrupt: true to break it out first.`
			);
		case "stalled":
			return (
				`${head}: the subagent never showed working after the message was submitted — ` +
				`it may have finished or crashed; its pane tells which.`
			);
		case "timeout":
			return (
				`${head}: herdr timed out waiting for the subagent to settle — but with --wait the text was ` +
				`already submitted, so it may have reached the subagent; do NOT resend blindly (duplicate risk) — ` +
				`check the subagent's state first (its pane, or its next update), ` +
				`or use interrupt: true if it is stuck in a long turn.`
			);
		case "not_found":
			return `${head}: the pane of subagent "${name}" runs no agent anymore (it finished or crashed) — it is already gone.`;
		case "error":
			return `${head}: herdr reported an unrecognized failure — check the subagent's pane and retry.`;
		case "delivered":
			// Unreachable through the ok:false path; kept so the switch is
			// exhaustive over AgentPromptOutcome without a crash.
			return `${head}: delivery reported as delivered but could not be confirmed — check the subagent's pane.`;
	}
}

// ── Display formatting ──

/** Compact elapsed time for headers and stall warnings: 5s / 01m05s / 2h03m. */
export function fmtElapsed(sec: number): string {
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}
