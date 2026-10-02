import assert from "node:assert/strict";
import { test } from "node:test";
import {
	herdrAgentName,
	labelWithIdSuffix,
	parseAgentPromptOutput,
	parseAgentRenameOutput,
	parseAgentStatus,
	parseHerdrErrorCode,
	parsePaneListIds,
	parseSplitPaneId,
	pickFailureOutput,
	selectSplitTarget,
} from "../herdr.ts";

// Real response captured from herdr 0.9.0 (`herdr pane split …`).
const SPLIT_OK =
	'{"id":"cli:pane:split","result":{"pane":{"agent_status":"unknown","cwd":"C:\\\\Temp\\\\x\\\\","focused":false,"pane_id":"w6:p2","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":36},"tab_id":"w6:t1","terminal_id":"term_x","workspace_id":"w6"},"type":"pane_info"}}';

test("parseSplitPaneId: real herdr 0.9.0 response", () => {
	assert.equal(parseSplitPaneId(SPLIT_OK), "w6:p2");
});

test("parseSplitPaneId: tolerates a flat result pane_id", () => {
	assert.equal(parseSplitPaneId('{"result":{"pane_id":"w1:p9"}}'), "w1:p9");
});

test("parseSplitPaneId: unexpected shape throws", () => {
	assert.throws(() => parseSplitPaneId('{"result":{}}'));
	assert.throws(() => parseSplitPaneId("not json at all"));
	assert.throws(() => parseSplitPaneId(""));
});

// Real response captured from herdr 0.9.0 (`herdr pane list`).
const LIST_OK =
	'{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w6:p1","agent":"pi","agent_status":"working"},{"pane_id":"w8:p1","agent_status":"idle"},{"pane_id":"wA:p1","agent_status":"unknown"}],"type":"pane_list"}}';

test("parsePaneListIds: real herdr 0.9.0 response", () => {
	assert.deepEqual(parsePaneListIds(LIST_OK), ["w6:p1", "w8:p1", "wA:p1"]);
});

test("parsePaneListIds: defensive against shape drift", () => {
	assert.deepEqual(parsePaneListIds('{"result":[{"pane_id":"w1:p1"}]}'), ["w1:p1"]);
	assert.deepEqual(parsePaneListIds('{"result":{"panes":[{"nope":1},{"pane_id":"w1:p2"}]}}'), ["w1:p2"]);
	assert.deepEqual(parsePaneListIds('{"result":{"panes":[]}}'), []);
	assert.deepEqual(parsePaneListIds("garbage"), []);
	assert.deepEqual(parsePaneListIds("{}"), []);
});

// ── parseAgentStatus (T4 probe, herdr 0.9.1-preview) ──

// Real response captured from herdr 0.9.1-preview (`herdr agent get <pane>`):
// pi inside the pane, turn finished. herdr's pi states, live-probed: boot →
// idle, turn running → working, turn finished → done; once pi EXITS the
// record is removed entirely (error envelope below), never lingering as
// done/unknown — that probe decided the waiter's --until list.
const AGENT_GET_DONE =
	'{"id":"cli:agent:get","result":{"agent":{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"C:\\\\Users\\\\starg\\\\.pi\\\\agent\\\\sessions\\\\probe.jsonl"},"agent_status":"done","cwd":"C:\\\\Temp\\\\probe","focused":false,"pane_id":"w1P:pB","revision":9,"screen_detection_skipped":true,"state_change_seq":141,"tab_id":"w1P:t1","terminal_id":"term_x","terminal_title":"π - probe","workspace_id":"w1P"},"type":"agent_info"}}';

test("parseAgentStatus: real herdr 0.9.1 agent get envelope (pi, done)", () => {
	assert.equal(parseAgentStatus(AGENT_GET_DONE, 0), "done");
});

test("parseAgentStatus: error envelope — exited pi leaves no record → null", () => {
	const NOT_FOUND =
		'{"error":{"code":"agent_not_found","message":"agent target w1P:pB not found"},"id":"cli:agent:get"}';
	assert.equal(parseAgentStatus(NOT_FOUND, 1), null);
});

test("parseAgentStatus: defensive against shape drift", () => {
	assert.equal(parseAgentStatus("garbage", 0), null);
	assert.equal(parseAgentStatus("", 0), null);
	assert.equal(parseAgentStatus('"{"result":{"agent":{}}}"', 0), null);
	assert.equal(parseAgentStatus('"{"result":{"agent":{"agent_status":7}}}"', 0), null);
	assert.equal(parseAgentStatus(AGENT_GET_DONE, 1), null); // non-zero exit never yields a status
});

// ── selectSplitTarget ──

const LIVE = new Set(["w1:p1", "w1:p2", "w1:p3"]);

// The regression: completeSubagent closes collapsed panes, so cached column
// ids go stale — a stale stacking target must fall back to the live parent,
// not feed `pane split` a dead id (herdr pane_not_found).
test("selectSplitTarget: live stacking target wins", () => {
	assert.deepEqual(selectSplitTarget({ stackingTarget: "w1:p2", parentPaneId: "w1:p1", livePaneIds: LIVE }), {
		target: "w1:p2",
		stacking: true,
	});
});

test("selectSplitTarget: dead stacking target falls back to live parent", () => {
	assert.deepEqual(selectSplitTarget({ stackingTarget: "w9:p9", parentPaneId: "w1:p1", livePaneIds: LIVE }), {
		target: "w1:p1",
		stacking: false,
	});
});

test("selectSplitTarget: no stacking target → parent", () => {
	assert.deepEqual(selectSplitTarget({ parentPaneId: "w1:p1", livePaneIds: LIVE }), {
		target: "w1:p1",
		stacking: false,
	});
	// Empty-string stacking target (runningCount 0 collapse) behaves the same.
	assert.deepEqual(selectSplitTarget({ stackingTarget: "", parentPaneId: "w1:p1", livePaneIds: LIVE }), {
		target: "w1:p1",
		stacking: false,
	});
});

test("selectSplitTarget: everything dead → throws, mentioning the parent pane id", () => {
	assert.throws(
		() => selectSplitTarget({ stackingTarget: "w9:p9", parentPaneId: "w1:p1", livePaneIds: new Set() }),
		/w1:p1/,
	);
	assert.throws(() => selectSplitTarget({ parentPaneId: "w1:p1", livePaneIds: new Set() }), /w1:p1/);
});

// ── Agent-surface fixtures (T1 step 0, captured live 2026-10-01) ──
//
// Captured inside herdr 0.9.1-preview: a disposable pane (w1P:p7) was split
// off the worker session and pi was started in it; the responses below are
// verbatim `agent get` / `agent prompt --wait` / `agent rename` output.
// Live: AGENT_GET_OK, AGENT_GET_NOT_FOUND, PROMPT_OK, PROMPT_NOT_FOUND,
// RENAME_OK, WAIT_TIMEOUT. Synthesized: PROMPT_BLOCKED, PROMPT_STALLED — a
// live refusal needs an agent parked in an approval UI and could not be
// triggered on demand, so their shape is copied from the live error envelope
// of WAIT_TIMEOUT and the codes come from `herdr agent prompt --help`.

// `herdr agent get w1P:p7` while pi sat idle in the pane (exit 0).
const AGENT_GET_OK =
	'{"id":"cli:agent:get","result":{"agent":{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"C:\\\\Users\\\\starg\\\\.pi\\\\agent\\\\sessions\\\\--C--SFT_Storage-Projects-pi-extensions--\\\\2026-10-01T04-12-16-844Z_01a0f5a9-bc4c-7701-9c2f-a02a63bdffa5.jsonl"},"agent_status":"idle","cwd":"C:\\\\SFT_Storage\\\\Projects\\\\pi-extensions","focused":true,"pane_id":"w1P:p7","revision":7,"screen_detection_skipped":true,"state_change_seq":65,"tab_id":"w1P:t1","terminal_id":"term_65cbf9b06a54114","terminal_title":"π - pi-extensions","terminal_title_stripped":"π - pi-extensions","workspace_id":"w1P"},"type":"agent_info"}}';

// `herdr agent get w1P:p7` while the pane still ran a plain pwsh (exit 1):
// herdr only knows agents it has recognized — a shell is agent_not_found.
const AGENT_GET_NOT_FOUND =
	'{"error":{"code":"agent_not_found","message":"agent target w1P:p7 not found"},"id":"cli:agent:get"}';

// `herdr agent prompt w1P:p7 "echo hi" --wait --timeout 15000` with pi idle
// in the pane (exit 0): accepted and settled (status done, agent_prompted).
const PROMPT_OK =
	'{"id":"cli:agent:prompt","result":{"agent":{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"C:\\\\Users\\\\starg\\\\.pi\\\\agent\\\\sessions\\\\--C--SFT_Storage-Projects-pi-extensions--\\\\2026-10-01T04-12-16-844Z_01a0f5a9-bc4c-7701-9c2f-a02a63bdffa5.jsonl"},"agent_status":"done","cwd":"C:\\\\SFT_Storage\\\\Projects\\\\pi-extensions","focused":true,"pane_id":"w1P:p7","revision":7,"screen_detection_skipped":true,"state_change_seq":67,"tab_id":"w1P:t1","terminal_id":"term_65cbf9b06a54114","terminal_title":"π - pi-extensions","terminal_title_stripped":"π - pi-extensions","workspace_id":"w1P"},"type":"agent_prompted"}}';

// The same prompt BEFORE pi was started in the pane (exit 1) — the shape any
// stale/closed pane id would produce.
const PROMPT_NOT_FOUND =
	'{"error":{"code":"agent_not_found","message":"agent target w1P:p7 not found"},"id":"cli:agent:prompt"}';

// The exact envelope pair from the R9 acceptance screenshot (R10): TWO
// identical `agent rename` refusals for the closing pane w1W:pE — the
// base-label attempt and (before the fix) the unconditioned id-suffix retry
// of one applyPaneLabel call. The id prefix "c…" in the screenshot is
// "cli:agent:rename" cut off by the viewport width.
const RENAME_NOT_FOUND_R9_LEAK =
	'{"error":{"code":"agent_not_found","message":"agent target w1W:pE not found"},"id":"cli:agent:rename"}';

// `herdr agent rename w1P:p7 t1-probe` (exit 0): the label lands at
// .result.agent.name; envelope is the same agent_info as agent get.
const RENAME_OK =
	'{"id":"cli:agent:rename","result":{"agent":{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"C:\\\\Users\\\\starg\\\\.pi\\\\agent\\\\sessions\\\\--C--SFT_Storage-Projects-pi-extensions--\\\\2026-10-01T04-12-16-844Z_01a0f5a9-bc4c-7701-9c2f-a02a63bdffa5.jsonl"},"agent_status":"done","cwd":"C:\\\\SFT_Storage\\\\Projects\\\\pi-extensions","focused":true,"name":"t1-probe","pane_id":"w1P:p7","revision":7,"screen_detection_skipped":true,"state_change_seq":67,"tab_id":"w1P:t1","terminal_id":"term_65cbf9b06a54114","terminal_title":"π - pi-extensions","terminal_title_stripped":"π - pi-extensions","workspace_id":"w1P"},"type":"agent_info"}}';

// `herdr agent wait w1P:p7 --until blocked --timeout 300` (exit 1): the live
// error envelope the synthesized prompt refusals borrow their shape from.
const WAIT_TIMEOUT =
	'{"error":{"code":"timeout","message":"timed out waiting for agent status"},"id":"cli:agent:wait"}';

// Synthesized, shape from live timeout error (WAIT_TIMEOUT), code from
// `agent prompt --help`: the child is already blocked, herdr rejects the
// text BEFORE delivery (the reason ADR-1 wants --wait, not fire-and-forget).
const PROMPT_BLOCKED =
	'{"error":{"code":"agent_blocked","message":"agent is blocked; prompt rejected before delivery"},"id":"cli:agent:prompt"}';

// Synthesized, same provenance: --wait saw no working|blocked within 5000ms
// of an accepted submission.
const PROMPT_STALLED =
	'{"error":{"code":"agent_prompt_stalled","message":"no working or blocked state observed after submission"},"id":"cli:agent:prompt"}';

// ── parseAgentPromptOutput ──

test("parseAgentPromptOutput: live delivered response (exit 0)", () => {
	assert.equal(parseAgentPromptOutput(PROMPT_OK, 0), "delivered");
});

test("parseAgentPromptOutput: live not_found refusal", () => {
	assert.equal(parseAgentPromptOutput(PROMPT_NOT_FOUND, 1), "not_found");
});

test("parseAgentPromptOutput: blocked refusal (synthesized fixture)", () => {
	assert.equal(parseAgentPromptOutput(PROMPT_BLOCKED, 1), "refused_blocked");
});

test("parseAgentPromptOutput: stalled (synthesized fixture)", () => {
	assert.equal(parseAgentPromptOutput(PROMPT_STALLED, 1), "stalled");
});

test("parseAgentPromptOutput: live wait timeout shape maps to timeout", () => {
	assert.equal(parseAgentPromptOutput(WAIT_TIMEOUT, 1), "timeout");
});

test("parseAgentPromptOutput: clean body with exit 0 is delivered", () => {
	assert.equal(parseAgentPromptOutput('{"result":{"type":"agent_prompted"}}', 0), "delivered");
});

test("parseAgentPromptOutput: defensive — garbage, empty, unknown codes never throw", () => {
	assert.equal(parseAgentPromptOutput("", 1), "error");
	assert.equal(parseAgentPromptOutput("garbage", 1), "error");
	assert.equal(parseAgentPromptOutput("{}", 1), "error");
	assert.equal(parseAgentPromptOutput('{"error":{"code":"something_new"}}', 1), "error");
	// An unparseable body never counts as delivered, whatever the exit code.
	assert.equal(parseAgentPromptOutput("", 0), "error");
	assert.equal(parseAgentPromptOutput("garbage", 0), "error");
});

// ── pickFailureOutput ──

test("pickFailureOutput: live not_found refusal arrives on STDERR (the fix-2 finding)", () => {
	// Live-probed: herdr prints error envelopes on stderr of the non-zero exit;
	// before the stderr capture this collapsed into the catch-all "error".
	assert.equal(pickFailureOutput("", PROMPT_NOT_FOUND), PROMPT_NOT_FOUND);
	assert.equal(pickFailureOutput(undefined, PROMPT_NOT_FOUND), PROMPT_NOT_FOUND);
});

test("pickFailureOutput: stdout still wins when both pipes carry text", () => {
	assert.equal(pickFailureOutput(PROMPT_NOT_FOUND, "stderr noise"), PROMPT_NOT_FOUND);
	assert.equal(pickFailureOutput(PROMPT_NOT_FOUND, undefined), PROMPT_NOT_FOUND);
});

test("pickFailureOutput: blank/whitespace-only pipes count as empty", () => {
	assert.equal(pickFailureOutput("   \r\n", "\t"), "");
	assert.equal(pickFailureOutput(undefined, undefined), "");
	assert.equal(pickFailureOutput("", ""), "");
	assert.equal(pickFailureOutput("", "   "), "");
});

test("pickFailureOutput + parseAgentPromptOutput: stderr path classifies as not_found", () => {
	// The exact promptAgent failure path: execFileSync throws, stderr carries
	// the envelope, exit code 1 — must yield the structured outcome, not "error".
	const failure = { stdout: "", stderr: PROMPT_NOT_FOUND, status: 1 } as const;
	assert.equal(parseAgentPromptOutput(pickFailureOutput(failure.stdout, failure.stderr), failure.status), "not_found");
	assert.equal(parseAgentPromptOutput(pickFailureOutput("", PROMPT_BLOCKED), 1), "refused_blocked");
});

// ── parseHerdrErrorCode + parseAgentRenameOutput (R10) ──

test("parseHerdrErrorCode: extracts error.code from the envelope family", () => {
	assert.equal(parseHerdrErrorCode(RENAME_NOT_FOUND_R9_LEAK), "agent_not_found");
	assert.equal(parseHerdrErrorCode(PROMPT_BLOCKED), "agent_blocked");
	assert.equal(parseHerdrErrorCode(WAIT_TIMEOUT), "timeout");
});

test("parseHerdrErrorCode: defensive — garbage, empty, non-string code → empty", () => {
	assert.equal(parseHerdrErrorCode(""), "");
	assert.equal(parseHerdrErrorCode("garbage"), "");
	assert.equal(parseHerdrErrorCode("{}"), "");
	assert.equal(parseHerdrErrorCode('{"error":{"code":42}}'), "");
	// A success envelope carries no error at all.
	assert.equal(parseHerdrErrorCode(RENAME_OK), "");
});

test("parseAgentRenameOutput: exit 0 is ok — the label landed", () => {
	assert.equal(parseAgentRenameOutput(RENAME_OK, 0), "ok");
	// The exit code is the truth for success; the body is not re-parsed.
	assert.equal(parseAgentRenameOutput("", 0), "ok");
});

test("parseAgentRenameOutput: the R9 leak envelope (agent_not_found) maps to not_found", () => {
	// Regression pin for the raw-JSON leak: the exact refusal from the
	// screenshot must classify as not_found — never as the catch-all error —
	// so applyPaneLabel can skip the suffix retry (the second identical
	// envelope) and give up silently.
	assert.equal(parseAgentRenameOutput(RENAME_NOT_FOUND_R9_LEAK, 1), "not_found");
});

test("parseAgentRenameOutput: everything else on a non-zero exit is the catch-all", () => {
	assert.equal(parseAgentRenameOutput("garbage", 1), "error");
	assert.equal(parseAgentRenameOutput("", 1), "error");
	assert.equal(parseAgentRenameOutput('{"error":{"code":"agent_label_taken"}}', 1), "error");
});

// ── Fixture shape pins (live get / prompt / rename envelopes) ──

test("fixture AGENT_GET_OK: idle pi recognized in the pane", () => {
	const parsed = JSON.parse(AGENT_GET_OK) as {
		result: { type: string; agent: { agent: string; agent_status: string; pane_id: string } };
	};
	assert.equal(parsed.result.type, "agent_info");
	assert.equal(parsed.result.agent.agent, "pi");
	assert.equal(parsed.result.agent.agent_status, "idle");
	assert.equal(parsed.result.agent.pane_id, "w1P:p7");
});

test("fixture AGENT_GET_NOT_FOUND: a plain shell is not an agent", () => {
	const parsed = JSON.parse(AGENT_GET_NOT_FOUND) as { error: { code: string } };
	assert.equal(parsed.error.code, "agent_not_found");
});

test("fixture PROMPT_OK: agent_prompted envelope with the settled child", () => {
	const parsed = JSON.parse(PROMPT_OK) as {
		result: { type: string; agent: { pane_id: string; agent_status: string } };
	};
	assert.equal(parsed.result.type, "agent_prompted");
	assert.equal(parsed.result.agent.pane_id, "w1P:p7");
	assert.equal(parsed.result.agent.agent_status, "done");
});

test("fixture RENAME_OK: label lands on .result.agent.name", () => {
	const parsed = JSON.parse(RENAME_OK) as { result: { type: string; agent: { name?: string } } };
	assert.equal(parsed.result.type, "agent_info");
	assert.equal(parsed.result.agent.name, "t1-probe");
});

// ── herdrAgentName (ADR-3 sanitizer table) ──

test("herdrAgentName: lowercase and separator folding", () => {
	assert.equal(herdrAgentName("Scout"), "scout");
	assert.equal(herdrAgentName("  W1P Scout! "), "w1p-scout");
	assert.equal(herdrAgentName("scout--agent__x"), "scout-agent-x");
	assert.equal(herdrAgentName("a !!! b"), "a-b");
});

test("herdrAgentName: Cyrillic sanitizes away (a- prefix for a digit head)", () => {
	// "скут" is a non-[a-z0-9] run → one hyphen, trimmed; the digit head then
	// gets the a- prefix.
	assert.equal(herdrAgentName("Скут-2"), "a-2");
	// A mixed name keeps only its latin part.
	assert.equal(herdrAgentName("scout-разведка"), "scout");
	// A fully Cyrillic name sanitizes to empty → documented fallback.
	assert.equal(herdrAgentName("разведка"), "subagent");
});

test("herdrAgentName: digit head gets a- prefix", () => {
	assert.equal(herdrAgentName("7scout"), "a-7scout");
});

test("herdrAgentName: capped at 32 chars, no trailing hyphen after a cut", () => {
	assert.equal(herdrAgentName("a".repeat(40)), "a".repeat(32));
	assert.equal(herdrAgentName(`x`.repeat(31) + "-y"), "x".repeat(31));
	// The prefix must not break the cap: a- + first 30 usable chars = 32.
	assert.equal(herdrAgentName("1" + "a".repeat(40)), "a-1" + "a".repeat(29));
});

test("herdrAgentName: empty and all-separator input fall back", () => {
	assert.equal(herdrAgentName(""), "subagent");
	assert.equal(herdrAgentName("!!!"), "subagent");
	assert.equal(herdrAgentName("---"), "subagent");
});

// ── labelWithIdSuffix (ADR-3 collision retry) ──

test("labelWithIdSuffix: pane id sanitizes into the suffix", () => {
	assert.equal(labelWithIdSuffix("scout", "w6:p2"), "scout-w6-p2");
	assert.equal(labelWithIdSuffix("scout", "w1:p12"), "scout-w1-p12");
});

test("labelWithIdSuffix: base is cut so the result stays within the 32-char cap", () => {
	const suffixed = labelWithIdSuffix("a".repeat(32), "w1:p12");
	// "w1:p12" → 6-char suffix; 32-char base cut to 25 + "-" + 6 = 32.
	assert.equal(suffixed.length, 32);
	assert.equal(suffixed, "a".repeat(25) + "-w1-p12");
	assert.ok(/^[a-z][a-z0-9_-]{0,31}$/.test(suffixed));
});
