import type { PaneListSnapshot, WatcherPaneOps } from "./watcher.ts";

export interface PaneSource {
	listPaneIds(): Promise<Set<string>>;
	readScreenTail(paneId: string, lines: number): Promise<string>;
}

export const WATCHER_READ_THROTTLE_MS = 1_000;

export function createWatcherPaneOps(
	source: PaneSource,
	opts: { now?: () => number; readThrottleMs?: number; tailLines?: number } = {},
): WatcherPaneOps {
	const now = opts.now ?? (() => Date.now());
	const readThrottleMs = opts.readThrottleMs ?? WATCHER_READ_THROTTLE_MS;
	const tailLines = opts.tailLines ?? 4;
	let listInFlight = false;
	let listSnapshot: PaneListSnapshot | null = null;
	const tails = new Map<string, string>();
	const tailStartedAt = new Map<string, number>();
	const tailsInFlight = new Set<string>();
	const tailGenerations = new Map<string, number>();
	return {
		refreshPaneList() {
			if (listInFlight) return;
			listInFlight = true;
			source
				.listPaneIds()
				.then(
					(ids) => {
						listSnapshot = { ok: true, ids, completedAt: now() };
					},
					() => {
						listSnapshot = { ok: false, completedAt: now() };
					},
				)
				.finally(() => {
					listInFlight = false;
				});
		},
		paneListSnapshot() {
			return listSnapshot;
		},
		requestScreenTail(paneId) {
			if (tailsInFlight.has(paneId)) return;
			const startedAt = tailStartedAt.get(paneId);
			if (startedAt !== undefined && now() - startedAt < readThrottleMs) return;
			tailStartedAt.set(paneId, now());
			tailsInFlight.add(paneId);
			const generation = tailGenerations.get(paneId) ?? 0;
			source
				.readScreenTail(paneId, tailLines)
				.then(
					(text) => {
						if ((tailGenerations.get(paneId) ?? 0) === generation) tails.set(paneId, text);
					},
					() => {
						if ((tailGenerations.get(paneId) ?? 0) === generation) {
							tails.set(paneId, "");
							tailStartedAt.delete(paneId);
						}
					},
				)
				.finally(() => {
					if ((tailGenerations.get(paneId) ?? 0) === generation) tailsInFlight.delete(paneId);
				});
		},
		screenTailSnapshot(paneId) {
			return tails.get(paneId) ?? "";
		},
		dropPane(paneId) {
			tails.delete(paneId);
			tailStartedAt.delete(paneId);
			tailsInFlight.delete(paneId);
			tailGenerations.set(paneId, (tailGenerations.get(paneId) ?? 0) + 1);
		},
	};
}
