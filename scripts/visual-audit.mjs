#!/usr/bin/env node
/**
 * Ручной контраст-аудит (R5/R9): печатает таблицу WCAG-контраста всех цветовых пар
 * расширений в четырёх опорах — dark, light и system (тёмный + светлый облик, оба
 * выведены из опорных цветов терминала). В npm test НЕ входит; запуск:
 *
 *   node scripts/visual-audit.mjs
 *
 * Пары и пороги живут в extensions/shared/theme-contrast.ts (единый каталог с тестом).
 */
import { auditPairs, loadAuditThemes } from "../extensions/shared/theme-contrast.ts";

const themes = loadAuditThemes();
const rows = auditPairs(themes);

const fmt = (n) => n.toFixed(2).padStart(6);
const pad = (s, w) => String(s).padEnd(w);

const nameWidth = Math.max(...rows.map((r) => r.pair.name.length)) + 1;
console.log(
	`WCAG contrast audit — ${rows.length} пар × ${themes.length} тем (${themes.map((t) => `${t.name} (${t.appearance})`).join(", ")})\n`,
);
console.log(`${pad("пара", nameWidth)}${themes.map((t) => pad(`${t.name}/${t.appearance}`, 14)).join("")}verdict`);
console.log("-".repeat(nameWidth + 14 * themes.length + 8));

let worst = { ratio: Infinity, name: "" };
for (const row of rows) {
	const cells = row.results.map((r) => {
		if (r.ratio < worst.ratio) worst = { ratio: r.ratio, name: `${row.pair.name} @ ${r.theme}/${r.appearance}` };
		return pad(fmt(r.ratio), 14);
	});
	const verdicts = row.results.map((r) => r.verdict);
	const overall = verdicts.includes("fail") ? "fail" : verdicts.includes("borderline") ? "BORDER" : "pass";
	console.log(
		`${pad(row.pair.name, nameWidth)}${cells.join("")}${overall.padEnd(8)}[${row.pair.kind}] ${row.pair.source}`,
	);
}

console.log(
	"\nЛегенда: pass — текст ≥4.5:1 / UI ≥4:1; BORDER — спорная зона 3:1…4(4.5):1 (в отчёт, НЕ править); FAIL — <3:1 (чинить заменой токена).",
);
console.log(`Худшая пара: ${worst.name} — ${fmt(worst.ratio)}:1`);
