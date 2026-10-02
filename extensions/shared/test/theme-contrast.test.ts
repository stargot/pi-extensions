/**
 * Регресс-гейт контраста (автоматизация R5-пунктов приёмки): пары из каталога
 * CONTRAST_PAIRS обязаны держать ≥3:1 во всех темах pi 1.0.0 — dark, light и
 * system (в обоих обликax). Спорная зона (3…4.5:1) пинится снапшотом: изменение
 * палитры pi, утопившее пару ниже гейта, валит тест и требует ревью (замена
 * токена на более контрастный из той же палитры). Таблица для человека —
 * scripts/visual-audit.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditPairs, CONTRAST_PAIRS, loadAuditThemes, pairRatio } from "../theme-contrast.ts";

const themes = loadAuditThemes();

test("каталог пар покрывает R5-список", () => {
	const names = CONTRAST_PAIRS.map((p) => p.name);
	for (const fragment of [
		"verdictChip warning: warning/toolPendingBg",
		"verdictChip fail: error/toolErrorBg",
		"quiz dont-know checked [x]: warning",
		"Submit доступен: success",
		"MAP silhouette t: muted",
		"snippets append ↓: warning",
		"recall highlight: warning bold",
		"report help: muted",
	]) {
		assert.ok(names.includes(fragment), `нет пары ${fragment}`);
	}
});

test("все пары держат ≥3:1 в dark, light и system (оба облика) — гейт чинки", () => {
	const rows = auditPairs(themes);
	for (const row of rows) {
		for (const result of row.results) {
			assert.ok(
				result.ratio >= 3,
				`${row.pair.name} (${row.pair.source}) на ${result.theme}/${result.appearance}: ${result.ratio.toFixed(2)}:1 < 3:1 — заменить токен на более контрастный`,
			);
		}
	}
});

test("спорная зона пинится: ровно эти пары ниже текстового порога 4.5:1", () => {
	const rows = auditPairs(themes);
	const borderline = rows
		.flatMap((row) =>
			row.results.filter((r) => r.verdict === "borderline").map((r) => `${row.pair.name} @ ${r.theme}/${r.appearance}`),
		)
		.sort();
	// Снапшот на палитре pi 1.0.0 (только имена/темы: сдвиг внутри зоны не шумит,
	// но переход границы 3:1 или 4:1/4.5:1 меняет верdict и валит тест — пересмотреть
	// руками через scripts/visual-audit.mjs).
	assert.deepEqual(borderline, [
		"Submit доступен: success @ system/light",
		"Submit недоступен: muted @ system/light",
		"ledger chip cache-low: warning/toolPendingBg @ system/light",
		"ledger chip cache-ok: success/toolSuccessBg @ light/light",
		"ledger chip cache-ok: success/toolSuccessBg @ system/light",
		"ledger chip cost: accent/customMessageBg @ system/light",
		"quiz dont-know checked [x]: warning @ system/light",
		"recall highlight: warning bold @ system/light",
		"report help: muted @ system/light",
		"snippets append ↓: warning @ system/light",
		"snippets prepend ↑: accent @ system/light",
		"trace badge running: accent/toolPendingBg @ system/light",
		"verdictChip ok: success/toolSuccessBg @ light/light",
		"verdictChip ok: success/toolSuccessBg @ system/light",
		"verdictChip running: accent/toolPendingBg @ system/light",
		"verdictChip warning: warning/toolPendingBg @ system/light",
	]);
});

test("system-тема реально сгенерирована из палитры pi, а не скопирована с dark/light", () => {
	const [dark, light, sysDark, sysLight] = themes;
	// System строится по кривым светлости pi: цвета близки к built-in, но не равны —
	// иначе аудит не проверял бы ничего сверх двух предыдущих тем.
	for (const [sys, builtin] of [
		[sysDark, dark],
		[sysLight, light],
	] as const) {
		const differs = ["warning", "error", "success", "accent", "dim", "muted", "toolPendingBg"].some((token) => {
			const a = (sys.theme.colors as Record<string, { r: number; g: number; b: number }>)[token];
			const b = (builtin.theme.colors as Record<string, { r: number; g: number; b: number }>)[token];
			return a.r !== b.r || a.g !== b.g || a.b !== b.b;
		});
		assert.ok(differs, `system/${sys.appearance} совпала с ${builtin.name} канал в канал`);
	}
});

test("pairRatio согласована с wcagContrast эталона (санити направлений)", () => {
	const [dark, light] = themes;
	// error-чипы читаемее warning-чипов на тёмном фоне, dim — самый слабый из fg-only.
	assert.ok(pairRatio(dark, CONTRAST_PAIRS.find((p) => p.name.includes("errorLine"))!) > 4);
	assert.ok(
		pairRatio(dark, CONTRAST_PAIRS.find((p) => p.name === "Submit недоступен: muted")!) <
			pairRatio(dark, CONTRAST_PAIRS.find((p) => p.name === "Submit доступен: success")!),
	);
	assert.ok(
		pairRatio(light, CONTRAST_PAIRS.find((p) => p.name === "MAP silhouette t: muted")!) <=
			pairRatio(light, CONTRAST_PAIRS.find((p) => p.name === "MAP silhouette B: muted")!),
	);
});
