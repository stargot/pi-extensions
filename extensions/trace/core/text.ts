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

export function fmtK(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDur(ms?: number): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
	return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

export function fmtClock(ms: number): string {
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtMoney(c: number): string {
	if (!Number.isFinite(c) || c === 0) return "";
	return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}
