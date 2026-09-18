/**
 * One-slot in-flight memoization for async startup work — the bridge start
 * in ../index.ts. Same idea as the companion's dedupeInFlight
 * (pi-web-companion src/connect.ts), kept as a local pure module so the
 * repo rule holds (testable logic lives outside index.ts, which imports
 * the pi host and is never imported by tests).
 *
 * Why not a bare wrapped function: shutdown must be able to AWAIT a start
 * that is already going (overlapping session_start / session_shutdown)
 * and close its result — without ever TRIGGERING a fresh one. Hence the
 * handle exposes the in-flight promise (current) separately from the
 * join-or-start entry point (run).
 */

export interface InFlightTask<A> {
	/** Run the task — or, while a run is pending, join it. */
	run(): Promise<A>;
	/**
	 * The currently in-flight run, or null when idle. Reading (and
	 * awaiting) it never starts a new run.
	 */
	current(): Promise<A> | null;
}

export function dedupeInFlight<A>(task: () => Promise<A>): InFlightTask<A> {
	let inFlight: Promise<A> | null = null;
	return {
		run(): Promise<A> {
			if (inFlight) return inFlight;
			const run: Promise<A> = Promise.resolve().then(task); // sync throws → rejections
			const clear = (): void => {
				if (inFlight === run) inFlight = null;
			};
			run.then(clear, clear);
			inFlight = run;
			return run;
		},
		current(): Promise<A> | null {
			return inFlight;
		},
	};
}
