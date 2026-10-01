// Manual E2E for the herdr surface (not part of npm test: opens real panes).
// Fake child — no pi, no tokens: the launcher just prints lines, writes a
// .done sidecar and the screen sentinel, then leaves the pane at a prompt.
// Steps 7 and 9 spawn a REAL pi child instead (one trivial turn, see
// e2e-pi.manual.ts): herdr only recognizes pi panes as agents — a plain
// shell pane answers agent_not_found to agent get/prompt/rename.
// Run INSIDE herdr (HERDR_ENV=1):  node extensions/subagents/test/e2e-herdr.manual.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, type ChildProcess } from "node:child_process";
import {
	activeBackend,
	createSubagentPane,
	listPaneIds,
	readScreenTail,
	sendText,
	closePane,
	parseSentinel,
	labelPane,
} from "../mux.ts";
import {
	herdrAgentName,
	labelWithIdSuffix,
	parseAgentStatus,
	promptAgent,
	spawnDoneWaiter,
	type AgentPromptOutcome,
} from "../herdr.ts";
import { renderLauncherPs1 } from "../launcher.ts";

if (process.env.HERDR_ENV !== "1") {
	console.error("HERDR_ENV=1 required — run this from a pi/terminal session inside herdr.");
	process.exit(1);
}
console.log("backend:", activeBackend());

const dir = mkdtempSync(join(tmpdir(), "pi-subagents-herdr-"));
const ps1Path = join(dir, "launcher.ps1");
writeFileSync(
	ps1Path,
	[
		"param()",
		"Write-Output 'HERDR_E2E_HELLO'",
		"Start-Sleep -Milliseconds 300",
		"Set-Content -Path (Join-Path $PSScriptRoot 'child.done') -Value '0'",
		"Write-Output '__SUBAGENT_DONE_0__'",
		"",
	].join("\r\n"),
	"utf8",
);

// One-shot panes created by steps 7-9; closed on every way out.
const disposablePanes: string[] = [];

const fail: (msg: string) => never = (msg) => {
	for (const p of disposablePanes) closePane(p);
	console.error("FAIL:", msg);
	process.exit(1);
};

const busySleep = (ms: number): void => {
	const untilMs = Date.now() + ms;
	while (Date.now() < untilMs) {}
};

// 1. Split + launch.
const paneId = createSubagentPane({ ps1Path, cwd: dir, runningCount: 0 });
// herdr pane ids: "w<workspace>:p<pane>", both parts alphanumeric (e.g. w1:p2,
// and this workspace's w1P:pE/pH — a digit-only regex dropped real panes).
if (!/^w[0-9a-z]+:p[0-9a-z]+$/i.test(paneId)) fail(`unexpected pane id: ${paneId}`);
console.log("pane:", paneId);

// 2. Launcher output shows up.
const until = (needle: string, what: () => string, timeoutMs = 15_000): void => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (what().includes(needle)) return;
		busySleep(500);
	}
	fail(`timeout waiting for "${needle}"`);
};
until("HERDR_E2E_HELLO", () => readScreenTail(paneId, 10));
console.log("launcher output: OK");

// 3. Steering: text + Enter reaches the pane's shell.
sendText(paneId, "echo STEER_OK_$((6 * 7))");
until("STEER_OK_", () => readScreenTail(paneId, 10));
console.log("steer: OK");

// 4. Sentinel parsing from the screen.
if (parseSentinel(readScreenTail(paneId, 8)) !== 0) fail("sentinel not parsed from screen");
console.log("sentinel: OK");

// 5. Liveness via pane list.
if (!listPaneIds().has(paneId)) fail("pane missing from pane list");
console.log("pane list: OK");

// 6. Close and confirm disappearance.
closePane(paneId);
const goneDeadline = Date.now() + 10_000;
while (Date.now() < goneDeadline && listPaneIds().has(paneId)) {
	busySleep(500);
}
if (listPaneIds().has(paneId)) fail("pane still listed after close");
console.log("close: OK");

// ── Agent-surface scenarios (steps 7-9) ──

/** `herdr agent get <id>` → status via parseAgentStatus + raw .result.agent.name. */
const agentGet = (id: string): { status: string | null; name: string | null } => {
	try {
		const out = execFileSync("herdr", ["agent", "get", id], { encoding: "utf8", timeout: 15_000, windowsHide: true });
		const parsed = JSON.parse(out) as { result?: { agent?: { name?: unknown } } };
		const name = parsed.result?.agent?.name;
		return { status: parseAgentStatus(out, 0), name: typeof name === "string" && name.length > 0 ? name : null };
	} catch {
		return { status: parseAgentStatus("", 1), name: null };
	}
};

/** pane_id → agent name from `herdr agent list` (empty map on any hiccup). */
const agentListNames = (): Map<string, string> => {
	try {
		const out = execFileSync("herdr", ["agent", "list"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
		const parsed = JSON.parse(out) as { result?: { agents?: Array<{ pane_id?: unknown; name?: unknown }> } };
		const names = new Map<string, string>();
		for (const a of parsed.result?.agents ?? []) {
			if (typeof a.pane_id === "string" && typeof a.name === "string" && a.name.length > 0) {
				names.set(a.pane_id, a.name);
			}
		}
		return names;
	} catch {
		return new Map();
	}
};

/** Resolve when a spawned waiter process has exited (or after the timeout). */
const waitExit = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
};

// 7. Label: spawn with `label` (the real spawn path) → agent get / agent list
// show the expected name. Live facts this step encodes (herdr 0.9.1): the
// agent record only exists once pi is up, so the split-time rename inside
// createSubagentPane lands nowhere (agent_not_found, dropped silently —
// renaming is best-effort per ADR-3); the label sticks when applied to the
// live agent, which is what doResume does on reuse. The step asserts that
// contract and prints the split-time state for the record.
const wherePi = execFileSync("where.exe", ["pi"], { encoding: "utf8" });
const piPath =
	wherePi
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.toLowerCase().endsWith("pi.cmd")) ?? "";
if (!piPath) fail("pi.cmd not found — steps 7/9 need a real pi child");

const agentSession = join(dir, "agent", "sessions", "subagents", "e2e-agent-child.jsonl");
mkdirSync(dirname(agentSession), { recursive: true });
const doneFile = `${agentSession}.done`;
const taskFile = join(dir, "agent-task.md");
writeFileSync(taskFile, "Reply with exactly one line: HERDR_E2E_AGENT_OK. Then stop.", "utf8");
const doneExt = join(dirname(dirname(fileURLToPath(import.meta.url))), "subagent-done.ts");
const spec = {
	name: "herdr-e2e",
	id: "herde2e-001",
	piPath,
	sessionFile: agentSession,
	extensionPaths: [doneExt],
	noExtensions: false,
	taskFile,
	doneFile,
	cwd: dir,
	env: {
		PI_SUBAGENT_NAME: "herdr-e2e",
		PI_SUBAGENT_AGENT: "adhoc",
		PI_SUBAGENT_AUTO_EXIT: "1",
		PI_SUBAGENT_ID: "herde2e-001",
		PI_SUBAGENT_SESSION: agentSession,
	},
} as never;
const piLauncherPath = join(dir, "agent-launcher.ps1");
writeFileSync(piLauncherPath, renderLauncherPs1(spec), "utf8");

const expectedLabel = herdrAgentName("herdr-e2e");
const agentPane = createSubagentPane({ ps1Path: piLauncherPath, cwd: dir, runningCount: 0, label: expectedLabel });
disposablePanes.push(agentPane);
console.log("agent pane:", agentPane, "| label:", expectedLabel);

// Wait for pi to register with herdr's agent surface (probe: visible at +3s).
const regDeadline = Date.now() + 30_000;
let registered: string | null = null;
while (Date.now() < regDeadline) {
	registered = agentGet(agentPane).status;
	if (registered !== null) break;
	busySleep(500);
}
if (registered === null) fail("pi child never appeared in `agent get` within 30s");
console.log("agent registered:", registered);
const splitTimeName = agentGet(agentPane).name;
console.log(
	"label after spawn:",
	splitTimeName ?? "<none> — split-time rename precedes the agent record (agent_not_found)",
);

// The repair path (as in doResume): label the live agent, then the name is
// what both `agent get` and `agent list` report.
labelPane(agentPane, expectedLabel);
const labeled = agentGet(agentPane);
const suffixed = labelWithIdSuffix(expectedLabel, agentPane);
if (labeled.name !== expectedLabel && labeled.name !== suffixed) {
	fail(`agent get name is ${labeled.name ?? "<none>"}, expected ${expectedLabel} (or ${suffixed})`);
}
const listName = agentListNames().get(agentPane);
if (listName !== labeled.name) fail(`agent list name is ${listName ?? "<none>"}, expected ${labeled.name}`);
console.log(`label: OK (agent get + agent list show "${labeled.name}")`);

// 9a. Arm the done waiter NOW, while the turn still runs: the agent record
// vanishes the moment pi exits, so a waiter armed after done would see
// agent_not_found (exit 1) instead of the done transition (exit 0).
const doneWaiter = spawnDoneWaiter(agentPane, ["done", "unknown"]);
if (!doneWaiter) fail("spawnDoneWaiter returned null");

// 8. promptAgent against a busy fake child: whatever herdr answers, the
// caller gets a structured AgentPromptOutcome — never a raw exception. The
// busy pane runs plain pwsh (no pi), so herdr has no agent record and
// refuses with agent_not_found; live-probed, that envelope arrives on
// STDERR, which promptAgent (stdout-only) maps to the catch-all "error" —
// still structured. The assertion only requires a valid outcome.
const busyPs1Path = join(dir, "busy-launcher.ps1");
writeFileSync(
	busyPs1Path,
	[
		"param()",
		"Write-Output 'HERDR_E2E_BUSY'",
		"Start-Sleep -Seconds 20",
		"Set-Content -Path (Join-Path $PSScriptRoot 'busy.done') -Value '0'",
		"Write-Output '__SUBAGENT_DONE_0__'",
		"",
	].join("\r\n"),
	"utf8",
);
const busyPane = createSubagentPane({ ps1Path: busyPs1Path, cwd: dir, runningCount: 0 });
disposablePanes.push(busyPane);
until("HERDR_E2E_BUSY", () => readScreenTail(busyPane, 10));
let outcome: AgentPromptOutcome;
try {
	outcome = promptAgent(busyPane, "HERDR_E2E probe — expect a structured refusal, not a crash", 5_000);
} catch (err) {
	fail(`promptAgent threw instead of returning an outcome: ${String(err)}`);
}
const PROMPT_OUTCOMES: readonly AgentPromptOutcome[] = [
	"delivered",
	"refused_blocked",
	"stalled",
	"timeout",
	"not_found",
	"error",
];
if (!PROMPT_OUTCOMES.includes(outcome))
	fail(`promptAgent returned a value outside AgentPromptOutcome: ${String(outcome)}`);
console.log(`prompt: OK (structured outcome "${outcome}"; not_found expected — plain shell pane)`);
until("__SUBAGENT_DONE_0__", () => readScreenTail(busyPane, 10), 40_000);
console.log("busy child: finished after the sleep");

// 9b. kill() lifecycle: a killed waiter must not exit 0 (it would stamp a
// false nativeDoneAt on the running entry) and a second kill() must be a
// safe no-op.
const killProbe = spawnDoneWaiter(agentPane, ["done", "unknown"]);
if (!killProbe) fail("spawnDoneWaiter returned null for the kill probe");
killProbe.kill();
await waitExit(killProbe, 10_000);
if (killProbe.exitCode === 0) fail("killed waiter exited 0 — a killed waiter must never look done");
const reKill = killProbe.kill();
console.log(`waiter kill: OK (exit ${killProbe.exitCode}, signal ${killProbe.signalCode}, re-kill → ${reKill})`);

// 9c. The surviving waiter fires with exit 0 when the turn reaches done.
await waitExit(doneWaiter, 240_000);
if (doneWaiter.exitCode !== 0) {
	fail(`done waiter exited ${doneWaiter.exitCode} (signal ${doneWaiter.signalCode}), expected 0`);
}
console.log("waiter done: OK (exit 0; agent_status:", agentGet(agentPane).status ?? "<record gone — pi exited>", ")");
const sidecarDeadline = Date.now() + 30_000;
while (Date.now() < sidecarDeadline && !existsSync(doneFile)) busySleep(500);
if (!existsSync(doneFile)) fail("child .done sidecar missing 30s after the native done signal");
console.log("child .done:", readFileSync(doneFile, "utf8").trim());

// Cleanup: one-shot panes close on every way out (fail() above included).
for (const p of disposablePanes) closePane(p);
const cleanDeadline = Date.now() + 10_000;
while (Date.now() < cleanDeadline && disposablePanes.some((p) => listPaneIds().has(p))) busySleep(500);
if (disposablePanes.some((p) => listPaneIds().has(p))) fail("disposable panes still listed after cleanup");
console.log("cleanup: OK");

console.log("E2E_OK (herdr surface + agent surface)");
