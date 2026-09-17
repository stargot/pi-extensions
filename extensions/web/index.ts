/**
 * Entry point of the pi-web package: registers both web tools and owns the
 * lifecycle of the local browser-bridge WS server.
 *
 * web_search — DuckDuckGo HTML-endpoint search (./search.ts);
 * web_fetch — page fetching to markdown with PDF extraction; when the page
 * is JS-rendered and direct extraction comes up empty, it is re-rendered
 * in the user's browser through the pi-web-companion extension, which
 * connects to the bridge server started here (./fetch/bridge.ts).
 *
 * Bridge lifecycle (docs/extensions.md: "Defer background resource startup
 * until session_start… Register an idempotent session_shutdown handler";
 * precedent: extensions/subagents/index.ts): the WS server is a module
 * singleton started in session_start — never in the factory, which must not
 * open sockets — and closed in session_shutdown. pi fires session_start /
 * session_shutdown around /new, /resume, /fork and /clone too, so the server
 * honestly restarts with the session; parallel pi sessions coexist via the
 * port range. Startup is deliberately non-fatal: a bridge that cannot bind
 * (range exhausted) or pair its token only degrades web_fetch's fallback to
 * the honest empty outcome — the session itself is never at risk.
 *
 * /bridge — status command: bound port, connected companion clients, and
 * where the pairing token lives (or why the bridge is disabled).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	readBridgeConfig,
	resolveTokenFilePath,
	startBridge,
	type BridgeHandle,
} from "./fetch/bridge.ts";
import { registerWebFetch } from "./fetch/tool.ts";
import registerWebSearch from "./search.ts";

// ── Module state (one bridge per process; reset in session_start/shutdown) ──

/** Live bridge server; null when not started (no session yet, or startup failed). */
let bridge: BridgeHandle | null = null;

/**
 * Why the bridge is not listening, when startBridge reported a disabled
 * handle (port range exhausted, token file unwritable) or threw. Surfaced
 * verbatim by /bridge; cleared together with the bridge.
 */
let bridgeDisabledReason: string | null = null;

/**
 * Token file of the config the (attempted) start used — PI_WEB_BRIDGE_TOKEN_FILE
 * may override the default; /bridge shows the actual path.
 */
let bridgeTokenFile: string | null = null;

/**
 * Start the bridge once per session, idempotently and never fatally.
 * startBridge itself is idempotent-safe to call again only after close —
 * the guard here makes repeated session_start events (they fire on /new,
 * /resume, /fork, /clone, and after extension reload) skip a bridge that
 * is already listening.
 */
async function ensureBridge(): Promise<void> {
	if (bridge) return; // already listening — nothing to do
	const config = readBridgeConfig(process.env);
	bridgeTokenFile = config.tokenFile;
	try {
		const handle = await startBridge(config);
		if (handle.status === "disabled") {
			bridgeDisabledReason = handle.disabledReason ?? "unknown reason";
			console.warn(`[pi-web] browser bridge disabled: ${bridgeDisabledReason}`);
			return;
		}
		bridge = handle;
		bridgeDisabledReason = null;
	} catch (error) {
		// Defensive: startBridge is contractually non-throwing, but a
		// surprise here must still never take the session down.
		bridgeDisabledReason = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-web] browser bridge failed to start: ${bridgeDisabledReason}`);
	}
}

/** Idempotent teardown: close the bridge, forget it and its diagnostics. */
async function shutdownBridge(): Promise<void> {
	const handle = bridge;
	bridge = null;
	bridgeDisabledReason = null;
	await handle?.close(); // close() is itself idempotent
}

// ── Extension entry point ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		void ensureBridge().catch((error: unknown) => {
			// Belt and braces: ensureBridge already catches its own failures;
			// this guard only covers an unexpected throw in the plumbing.
			console.warn(
				`[pi-web] browser bridge startup error: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	});

	pi.on("session_shutdown", () => {
		void shutdownBridge();
	});

	registerWebSearch(pi);
	registerWebFetch(pi, {
		// No bridge → renderFn resolves null → fetcher's honest empty outcome.
		renderFn: (url, signal) =>
			bridge ? bridge.render(url, signal) : Promise.resolve(null),
	});

	pi.registerCommand("bridge", {
		description:
			"Show the local browser-bridge status (port, companion clients, token file)",
		handler: async (_args, ctx) => {
			if (bridge) {
				ctx.ui.notify(
					`browser bridge listening: port ${bridge.port}, clients ${bridge.clients()}, ` +
						`token: ${bridgeTokenFile ?? resolveTokenFilePath()}`,
					"info",
				);
				return;
			}
			if (bridgeDisabledReason) {
				ctx.ui.notify(`browser bridge disabled: ${bridgeDisabledReason}`, "warning");
				return;
			}
			ctx.ui.notify(
				"bridge not started (session not active or startup error)",
				"warning",
			);
		},
	});
}
