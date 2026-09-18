import assert from "node:assert/strict";
import { test } from "node:test";
import { FUZZY_THRESHOLD, MAX_FUZZY_FILE_LINES, normalize, resolveEdit, similarity, stripIndent, trimTrailing } from "../match.ts";

test("normalize снимает BOM и унифицирует EOL", () => {
	assert.equal(normalize("﻿abc"), "abc");
	assert.equal(normalize("a\r\nb\rc\nd"), "a\nb\nc\nd");
	assert.equal(normalize("x"), "x");
});

test("normalize прощает типографику так же, как встроенный edit (без NFKC)", () => {
	// Умные кавычки, тире и юникод-пробелы → ASCII; обычные символы не трогаем.
	assert.equal(normalize("“a” ‘b’ —c–d\u00A0e\u3000f"), '"a" \'b\' -c-d e f');
	// NFKC-преобразования (меняют длину) сознательно не применяются.
	assert.equal(normalize("ﬁ"), "ﬁ");
});

test("trimTrailing и stripIndent работают построчно", () => {
	assert.equal(trimTrailing("a  \n\tb \t\n"), "a\n\tb\n");
	assert.equal(stripIndent("  a\n\t\tb\n  c"), "a\nb\nc");
});

test("similarity: границы 1 и 0, early-abandon ниже бюджета", () => {
	assert.equal(similarity("", ""), 1);
	assert.equal(similarity("abc", "abc"), 1);
	assert.equal(similarity("abc", "xyz"), 0);
	assert.equal(similarity("", "abc"), 0);
	// Расстояние заведомо больше бюджета — рано бросаем с оценкой < 1 - budget.
	const abandoned = similarity("aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", 0.15);
	assert.ok(abandoned < 1 - 0.15, `abandoned=${abandoned}`);
	assert.ok(abandoned >= 0);
	// Без бюджета считаем честно.
	assert.equal(similarity("kitten", "sitting"), 1 - 3 / 7);
});

test("resolveEdit: пустой oldText — exact pass-through", () => {
	const r = resolveEdit("abc", "");
	assert.deepEqual({ ...r }, { status: "recovered", method: "exact", actual: "", similarity: 1, line: 1 });
});

test("resolveEdit: точное совпадение с корректной строкой", () => {
	const file = "one\ntwo\nthree\n";
	const r = resolveEdit(file, "two\nthree");
	assert.equal(r.status, "recovered");
	assert.equal(r.method, "exact");
	assert.ok(r.status === "recovered");
	assert.equal(r.actual, "two\nthree");
	assert.equal(r.line, 2);
});

test("resolveEdit: CRLF-файл против LF-oldText — actual содержит \\r\\n", () => {
	const file = "first\r\nsecond\r\nthird\r\n";
	const r = resolveEdit(file, "second\nthird");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "second\r\nthird");
	assert.equal(r.similarity, 1);
	// Сырая подстрока файла: после подмены oldText встроенный edit совпадёт байт-в-байт.
	assert.ok(file.includes(r.actual));
});

test("resolveEdit: BOM не попадает в actual", () => {
	const file = "﻿first\r\nsecond";
	const r = resolveEdit(file, "first\nsecond");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "first\r\nsecond");
});

test("resolveEdit: хвостовые пробелы восстанавливаются", () => {
	const file = "foo  \nbar\n";
	const r = resolveEdit(file, "foo\nbar");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "foo  \nbar");
});

test("resolveEdit: хвостовые пробелы в самом oldText тоже прощаются", () => {
	const r = resolveEdit("foo\nbar\n", "foo  \nbar  ");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "foo\nbar");
});

test("resolveEdit: неверный отступ — фаза indent", () => {
	const file = "function f() {\n    return 1;\n}\n";
	const r = resolveEdit(file, "      return 1;\n}"); // отступ длиннее, чем в файле — exact исключён
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "indent");
	assert.equal(r.actual, "    return 1;\n}");
	assert.equal(r.similarity, 1);
	assert.equal(r.line, 2);
});

test("resolveEdit: табы против пробелов — фаза indent", () => {
	const file = "\tfoo\n\tbar\n";
	const r = resolveEdit(file, "    foo\n    bar");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "indent");
	assert.equal(r.actual, "\tfoo\n\tbar");
});

test("resolveEdit: однострочный фрагмент внутри строки", () => {
	const r = resolveEdit("bar foo baz\nqux\n", "foo");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "exact");
	assert.equal(r.actual, "foo");
	assert.equal(r.line, 1);

	// Внутри строки с лишними хвостовыми пробелами — фаза whitespace:
	// сырой файл не содержит needle с пробелами, нормализованный — содержит.
	const r2 = resolveEdit("qux\nfoo\n", "foo  ");
	assert.ok(r2.status === "recovered");
	assert.equal(r2.method, "whitespace");
	assert.equal(r2.actual, "foo");
	assert.equal(r2.line, 2);
});

test("resolveEdit: многострочное окно с середины файла", () => {
	const file = Array.from({ length: 10 }, (_, i) => `line ${i}  `).join("\r\n") + "\r\n";
	const needle = "line 4\nline 5\nline 6";
	const r = resolveEdit(file, needle);
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "line 4  \r\nline 5  \r\nline 6  ");
	assert.equal(r.line, 5);
});

test("resolveEdit: fuzzy выше порога восстанавливает", () => {
	const file = "export function calculateTotal(lst: Item[]): number {\n  return lst.reduce((s, i) => s + i.p, 0);\n}\n";
	const needle = "export function calculateTotal(items: Item[]): number {\n  return items.reduce((s, i) => s + i.p, 0);\n}";
	const r = resolveEdit(file, needle);
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "fuzzy");
	assert.ok(r.similarity >= FUZZY_THRESHOLD, `similarity=${r.similarity}`);
	assert.equal(r.line, 1);
	assert.ok(file.includes(r.actual));
});

test("resolveEdit: fuzzy ниже порога — not-found с detail", () => {
	// Первая строка совпадает (проходит prefilter), остальные расходятся —
	// средняя похожесть не дотягивает до порога.
	const file = "alpha\nzzz\nqqq\n";
	const r = resolveEdit(file, "alpha\nbeta\ngamma");
	assert.equal(r.status, "not-found");
	assert.ok(r.status === "not-found");
	assert.ok(r.similarity < FUZZY_THRESHOLD);
	assert.ok(r.detail.includes("ближайший кандидат"), r.detail);
	assert.ok(r.detail.includes("ожидалось"), r.detail);
	assert.ok(r.line >= 1);
});

test("resolveEdit: неоднозначность — несколько разных кандидатов", () => {
	// Оба окна совпадают только после нормализации, но сырые подстроки разные —
	// ни exact, ни однозначный выбор невозможны.
	const file = "a \nb\nx\na  \nb\n";
	const r = resolveEdit(file, "a\nb");
	assert.equal(r.status, "not-found");
	assert.ok(r.status === "not-found");
	assert.ok(r.detail.includes("неоднозначно"), r.detail);
	assert.ok(r.detail.includes("1"), r.detail);
	assert.ok(r.detail.includes("4"), r.detail);
});

test("resolveEdit: одинаковые кандидаты не считаются неоднозначностью", () => {
	const file = "foo\nmiddle\nfoo\n";
	const r = resolveEdit(file, "foo ");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	// Оба окна в сыром виде "foo" — фактическая подстрока одна и та же.
	assert.equal(r.actual, "foo");
});

test("resolveEdit: юникод — кириллица и эмодзи", () => {
	const file = "привет мир 🌍\r\nвторая строка ✅\r\n";
	const r = resolveEdit(file, "привет мир 🌍\nвторая строка ✅");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.actual, "привет мир 🌍\r\nвторая строка ✅");

	const r2 = resolveEdit("кот 🐈\n", "щука 🐟🐟🐟");
	assert.equal(r2.status, "not-found");
	assert.ok(r2.status === "not-found");
	assert.ok(r2.detail.includes("ожидалось"), r2.detail);
});

test("resolveEdit: CR-only файл нормализуется", () => {
	const file = "a\rb\r";
	const r = resolveEdit(file, "a\nb");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.actual, "a\rb");
});

test("resolveEdit: needle с завершающим \\n — середина CRLF-файла", () => {
	// Раньше такой needle не находился никогда: split("\n") давал хвостовой
	// пустой сегмент, и окно требовало пустую строку файла вместо EOL needle.
	const r = resolveEdit("a\r\nb\r\nc\r\nd\r\n", "b\n");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "b\r\n");
	assert.equal(r.line, 2);
});

test("resolveEdit: needle с завершающим \\n — граница EOF (LF и CRLF)", () => {
	// В LF-файле сырая подстрока "b\n" существует — хватает exact-фазы.
	const lf = resolveEdit("a\nb\n", "b\n");
	assert.ok(lf.status === "recovered");
	assert.equal(lf.method, "exact");
	assert.equal(lf.actual, "b\n");
	assert.equal(lf.line, 2);

	// В CRLF-файле сырого "b\n" нет — восстанавливает whitespace-фаза (C2).
	const crlf = resolveEdit("a\r\nb\r\n", "b\n");
	assert.ok(crlf.status === "recovered");
	assert.equal(crlf.method, "whitespace");
	assert.equal(crlf.actual, "b\r\n");
	assert.equal(crlf.line, 2);

	// Многострочный needle с хвостовым EOL: раньше окно требовало пустую
	// строку файла после "c" и не находилось даже в LF-файле без неё.
	const multi = resolveEdit("a\nb\nc", "b\nc\n");
	assert.equal(multi.status, "not-found");
	assert.ok(multi.status === "not-found");

	const multiOk = resolveEdit("a\nb\nc\n", "b\nc\n");
	assert.ok(multiOk.status === "recovered");
	assert.equal(multiOk.actual, "b\nc\n");
	assert.equal(multiOk.line, 2);
});

test("resolveEdit: needle с завершающим \\n fuzzy-фазой — хвост восстанавливается", () => {
	const r = resolveEdit("alpha\nbeta1\ngamma\n", "beta2\ngamma\n");
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "fuzzy");
	assert.equal(r.actual, "beta1\ngamma\n");
});

test("resolveEdit: needle с завершающим \\n, но в файле последняя строка без EOL — not-found", () => {
	// Сырой подстроки "b\n" в файле нет — встроенный edit её тоже не найдёт.
	const r = resolveEdit("a\nb", "b\n");
	assert.equal(r.status, "not-found");
	assert.ok(r.status === "not-found");
});

test("resolveEdit: файл длиннее лимита — fuzzy-фаза пропущена", () => {
	const file = `${"x\n".repeat(MAX_FUZZY_FILE_LINES + 1)}`;
	const r = resolveEdit(file, "y", { fuzzy: true });
	assert.equal(r.status, "not-found");
	assert.ok(r.status === "not-found");
	assert.ok(r.detail.includes("fuzzy"), r.detail);
});

test("resolveEdit: 90KB-строка с дрейфом суффикса — ответ в бюджете времени", () => {
	// Раньше DP держала полную таблицу 90K×90K: early-abandon не срабатывал для
	// почти идентичных строк, расходящихся в конце. Срез общего префикса
	// сводит такую пару к тривиальному DP.
	const body = "a".repeat(90_000);
	const file = Array.from({ length: 31 }, (_, i) => (i === 15 ? `${body} TAIL` : `line ${i}`)).join("\n") + "\n";
	const needle = `${body} DRIFT`;
	const t0 = performance.now();
	const r = resolveEdit(file, needle, { fuzzy: true });
	const dt = performance.now() - t0;
	assert.ok(r.status === "recovered");
	if (r.status === "recovered") {
		assert.equal(r.method, "fuzzy");
		assert.equal(r.actual, `${body} TAIL`);
		assert.equal(r.line, 16);
	}
	assert.ok(dt < 2000, `resolveEdit занял ${dt.toFixed(0)}ms, бюджет 2000ms`);
});

test("resolveEdit: 90KB-строки, расходящиеся по всей длине — кап дисквалифицирует окно, ответ в бюджете", () => {
	// Дрейф размазан по строке: срез общих концов не помогает, пары длиннее
	// капа fuzzy-фазы не оцениваются — окно дисквалифицировано, но вызов
	// обязан завершиться быстро, а не виснуть минутами.
	const drifted = "x".repeat(90_000).split("");
	for (let p = 900; p < 90_000; p += 900) drifted[p] = "y";
	const needle = drifted.join("");
	const file = `${Array.from({ length: 31 }, () => "x".repeat(90_000)).join("\n")}\n`;
	const t0 = performance.now();
	const r = resolveEdit(file, needle, { fuzzy: true });
	const dt = performance.now() - t0;
	assert.equal(r.status, "not-found");
	assert.ok(r.status === "not-found");
	assert.ok(dt < 2000, `resolveEdit занял ${dt.toFixed(0)}ms, бюджет 2000ms`);
});

test("resolveEdit: fuzzy можно отключить опцией", () => {
	const file = "function alpha() { return 1; }\n";
	const needle = "function alpha() { return one; }";
	assert.equal(resolveEdit(file, needle, { fuzzy: true }).status, "recovered");
	assert.equal(resolveEdit(file, needle, { fuzzy: false }).status, "not-found");
});

test("resolveEdit: типографика в файле против ASCII в oldText — whitespace", () => {
	// Встроенный edit сам прощает типографику (normalizeForFuzzyMatch); гард
	// не должен блокировать такую правку — восстанавливаем сырую подстроку.
	const file = "const s = “значение”; // комментарий — хвост\n";
	const r = resolveEdit(file, 'const s = "значение"; // комментарий - хвост');
	assert.equal(r.status, "recovered");
	assert.ok(r.status === "recovered");
	assert.equal(r.method, "whitespace");
	assert.equal(r.actual, "const s = “значение”; // комментарий — хвост");
	assert.ok(file.includes(r.actual));
});
