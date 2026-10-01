/**
 * Модульные тесты реестра клавиш ext.* (без живого TUI).
 *
 * Проверяем: дефолты definitions, переопределение фикстурой userBindings,
 * отключение через `[]` + guard-фоллбэк matchAction/matchActionKey на дефолты,
 * направление jumpMatch по индексу совпавшего ключа (не по регистру), мемоизация
 * синглтона, тихое поведение на незнакомом id, чистый parseUserBindings (битый
 * JSON / не-строковые значения / фильтрация не-ext.* ключей), формат actionHint
 * и чтение keybindings.json.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Keybinding, KeybindingsManager, type KeybindingsConfig, matchesKey } from "@earendil-works/pi-tui";
import {
	EXT_KEYBINDINGS,
	actionHint,
	getExtKeybindings,
	loadUserBindings,
	matchAction,
	matchActionIndex,
	matchActionKey,
	parseUserBindings,
} from "../keybindings.ts";

const manager = (userBindings?: KeybindingsConfig) => new KeybindingsManager(EXT_KEYBINDINGS, userBindings);

test("дефолты резолвятся из definitions", () => {
	const kb = manager();
	assert.deepEqual(kb.getKeys("ext.report.refresh"), ["r"]);
	assert.deepEqual(kb.getKeys("ext.report.close"), ["q", "escape"]);
	assert.deepEqual(kb.getKeys("ext.recall.close"), ["q", "escape"]);
	assert.deepEqual(kb.getKeys("ext.trace.filter"), ["/"]);
	assert.deepEqual(kb.getKeys("ext.trace.jumpMatch"), ["n", "shift+n"]); // shift+n legacy-матчит заглавную N
	// типобезопасность обращений проверяет tsc: id вне Keybindings не скомпилируется
	assert.equal(kb.getDefinition("ext.trace.diff").description, "Context diff");
});

test("фикстура userBindings переопределяет дефолт", () => {
	const kb = manager({ "ext.report.close": "x" });
	assert.deepEqual(kb.getKeys("ext.report.close"), ["x"]);
	assert.equal(kb.matches("x", "ext.report.close"), true);
	assert.equal(kb.matches("q", "ext.report.close"), false);
	assert.equal(matchAction(kb, "x", "ext.report.close"), true);
	assert.equal(matchAction(kb, "q", "ext.report.close"), false);
});

test("массив-фикстура расширяет биндинг", () => {
	const kb = manager({ "ext.report.close": ["x", "escape"] });
	assert.deepEqual(kb.getKeys("ext.report.close"), ["x", "escape"]);
	assert.equal(kb.matches("x", "ext.report.close"), true);
	assert.equal(kb.matches("\x1b", "ext.report.close"), true);
});

test("[] отключает действие: getKeys пуст, matchAction падает на дефолты definitions", () => {
	const kb = manager({ "ext.report.close": [] });
	assert.deepEqual(kb.getKeys("ext.report.close"), []);
	assert.equal(kb.matches("q", "ext.report.close"), false);
	// guard-фоллбэк: у отключённого биндинга срабатывают дефолты из definitions
	assert.equal(matchAction(kb, "q", "ext.report.close"), true);
	assert.equal(matchAction(kb, "\x1b", "ext.report.close"), true);
	assert.equal(matchesKey("\x1b", "escape"), true);
});

test("незнакомый id — тихо: getKeys → [], matches → false, matchAction → false, без throw", () => {
	const kb = manager();
	const unknown = "ext.nope.missing" as Keybinding;
	assert.deepEqual(kb.getKeys(unknown), []);
	assert.equal(kb.matches("q", unknown), false);
	// дефолтов у незнакомого id нет — матч просто false (реальные call-site'ы
	// используют только id из merging, так что это чисто defensive-семантика)
	assert.equal(matchAction(kb, "q", unknown), false);
	assert.equal(matchActionKey(kb, "q", unknown), undefined);
	assert.equal(matchActionIndex(kb, "q", unknown), -1);
});

test("parseUserBindings: валидный JSON разбирается", () => {
	const raw = JSON.stringify({ "ext.report.close": "x", "ext.trace.filter": ["/", ","] });
	assert.deepEqual(parseUserBindings(raw), { "ext.report.close": "x", "ext.trace.filter": ["/", ","] });
});

test("parseUserBindings: битый JSON и undefined → {}", () => {
	assert.deepEqual(parseUserBindings("{oops"), {});
	assert.deepEqual(parseUserBindings(""), {});
	assert.deepEqual(parseUserBindings(undefined), {});
	assert.deepEqual(parseUserBindings("[1,2]"), {}); // не объект
	assert.deepEqual(parseUserBindings("42"), {});
});

test("parseUserBindings: не-строковые значения отфильтрованы", () => {
	const raw = JSON.stringify({
		"ext.report.close": 42,
		"ext.trace.filter": null,
		"ext.trace.close": { key: "x" },
		"ext.trace.live": ["l", 5], // массив с не-строкой — целиком бракуем
		"ext.trace.models": ["m"],
	});
	assert.deepEqual(parseUserBindings(raw), { "ext.trace.models": ["m"] });
});

test("parseUserBindings: не-ext.* ключи отфильтрованы", () => {
	const raw = JSON.stringify({ "tui.select.up": "x", "app.interrupt": "esc", "ext.report.refresh": "R" });
	assert.deepEqual(parseUserBindings(raw), { "ext.report.refresh": "R" });
});

test("actionHint рендерит 'keys: description'", () => {
	const kb = manager();
	assert.equal(actionHint(kb, "ext.report.close", "Close"), "q/escape: Close");
	assert.equal(actionHint(kb, "ext.report.refresh", "refresh"), "r: refresh");
	assert.equal(actionHint(kb, "ext.trace.jumpMatch", "jump"), "n/shift+n: jump");
	assert.equal(actionHint(kb, "ext.trace.filter"), "/"); // без description — только клавиши
});

test("actionHint при отключённом действии показывает дефолт из definitions", () => {
	const kb = manager({ "ext.report.close": [] });
	assert.equal(actionHint(kb, "ext.report.close", "Close"), "q/escape: Close");
});

test("loadUserBindings: файл читается, отсутствие/битый JSON → {}", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-kb-"));
	try {
		writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "ext.report.close": "x", junk: 1 }));
		assert.deepEqual(loadUserBindings(dir), { "ext.report.close": "x" });

		writeFileSync(join(dir, "keybindings.json"), "{oops");
		assert.deepEqual(loadUserBindings(dir), {});

		rmSync(join(dir, "keybindings.json"));
		assert.deepEqual(loadUserBindings(dir), {});

		assert.deepEqual(loadUserBindings(join(dir, "no-such-dir")), {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("синглтон-конфигурация: менеджер на наших definitions с пустыми переопределениями", () => {
	// как getExtKeybindings() строит менеджер при отсутствии keybindings.json
	const kb = manager(loadUserBindings(join(tmpdir(), "pi-kb-absent")));
	assert.deepEqual(kb.getKeys("ext.report.refresh"), ["r"]);
	assert.deepEqual(kb.getKeys("ext.report.close"), ["q", "escape"]);
});

test("matchActionIndex: направление jumpMatch — по индексу совпавшего ключа, не по регистру", () => {
	const kb = manager();
	// дефолты ["n","shift+n"]: "n" → индекс 0 (вперёд), "N" → индекс 1 (назад)
	assert.equal(matchActionKey(kb, "n", "ext.trace.jumpMatch"), "n");
	assert.equal(matchActionKey(kb, "N", "ext.trace.jumpMatch"), "shift+n"); // legacy-матч заглавной
	assert.equal(matchActionKey(kb, "x", "ext.trace.jumpMatch"), undefined);
	assert.equal(matchActionIndex(kb, "n", "ext.trace.jumpMatch"), 0);
	assert.equal(matchActionIndex(kb, "N", "ext.trace.jumpMatch"), 1);
	assert.equal(matchActionIndex(kb, "x", "ext.trace.jumpMatch"), -1);

	// переопределение ["j","k"]: обе строчные — старая регистр-эвристика (data ===
	// data.toLowerCase() → +1) молча вела обе клавиши вперёд; по индексу — корректно
	const over = manager({ "ext.trace.jumpMatch": ["j", "k"] });
	assert.equal(matchActionKey(over, "j", "ext.trace.jumpMatch"), "j");
	assert.equal(matchActionKey(over, "k", "ext.trace.jumpMatch"), "k");
	assert.equal(matchActionIndex(over, "j", "ext.trace.jumpMatch"), 0);
	assert.equal(matchActionIndex(over, "k", "ext.trace.jumpMatch"), 1);
	assert.equal(matchAction(over, "k", "ext.trace.jumpMatch"), true);
});

test("matchActionIndex: отключённый биндинг [] фоллбэчится на дефолты definitions", () => {
	const kb = manager({ "ext.trace.jumpMatch": [] });
	assert.deepEqual(kb.getKeys("ext.trace.jumpMatch"), []);
	assert.equal(matchActionKey(kb, "n", "ext.trace.jumpMatch"), "n");
	assert.equal(matchActionKey(kb, "N", "ext.trace.jumpMatch"), "shift+n");
	assert.equal(matchActionIndex(kb, "n", "ext.trace.jumpMatch"), 0);
	assert.equal(matchActionIndex(kb, "N", "ext.trace.jumpMatch"), 1);
	assert.equal(matchAction(kb, "N", "ext.trace.jumpMatch"), true);
});

test("getExtKeybindings(): мемоизация — два вызова возвращают один инстанс", () => {
	assert.strictEqual(getExtKeybindings(), getExtKeybindings());
});
