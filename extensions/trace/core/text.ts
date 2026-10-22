/**
 * Текстовые хелперы ядра trace. Чистый модуль: без Node/DOM API — его же
 * грузит веб-вьюер (serve.ts отдаёт .ts со стёртыми типами).
 */

/** Строка в одну линию: пробелы схлопнуты, хвост обрезан до max символов с «…». */
export function oneLine(s: unknown, max = 80): string {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Текст content сообщения: строка как есть, из массива — только text-блоки. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text ?? "")
		.join(" ");
}

/** Время записи в мс: message.timestamp (число), иначе ISO entry.timestamp, иначе 0. */
export function entryMs(e: any): number {
	const t = e?.message?.timestamp;
	if (typeof t === "number") return t;
	const p = Date.parse(e?.timestamp ?? "");
	return Number.isFinite(p) ? p : 0;
}

/** Время записи entry в файл (для assistant — конец стрима); не раньше fallback. */
export function entryEndMs(e: any, fallback: number): number {
	const p = Date.parse(e?.timestamp ?? "");
	return Number.isFinite(p) && p > fallback ? p : fallback;
}
