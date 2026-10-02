/**
 * Pure formatting for bg-jobs: log-tail truncation with an honest marker,
 * elapsed times, human-readable statuses and the /jobs table. No pi runtime
 * imports — unit-testable standalone, shared by tools and commands.
 */
import type { JobRecord, JobStatus } from "./registry.ts";

/** "42s" / "2m10s" / "1h05m" — same shape the subagents widget uses. */
export function fmtElapsed(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Collapse newlines and cap length — for table cells and widgets. */
export function oneline(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Symbol + word for every job status, stable across widget/table/notify. */
export function formatStatus(status: JobStatus): string {
	switch (status) {
		case "running":
			return "▶ running";
		case "completed":
			return "✓ completed";
		case "failed":
			return "✗ failed";
		case "timeout":
			return "⏱ timeout";
		case "killed":
			return "✖ killed";
		case "orphaned":
			return "⚠ orphaned";
	}
}

export interface LogTail {
	/** Content ready to hand to a model or user (marker included when cut). */
	text: string;
	/** True when anything was cut from the head of the log. */
	truncated: boolean;
	/** Total characters the full log has. */
	totalChars: number;
}

/**
 * Last `maxChars` characters of the log. When the log is longer, the result
 * is prefixed with an honest truncation marker naming the full log path —
 * the full output always stays on disk.
 *
 * `totalCharsOverride` — точный/приближённый размер ПОЛНОГО лога, когда в
 * `text` передано только последнее окно файла (большие логи читаются от
 * конца, см. runner.readLogTail); без него размер считается по `text`.
 */
export function truncateTail(text: string, maxChars: number, outputPath: string, totalCharsOverride?: number): LogTail {
	const totalChars = totalCharsOverride ?? text.length;
	if (maxChars <= 0) {
		return {
			text: `[empty view requested — full log (${totalChars} chars): ${outputPath}]`,
			truncated: totalChars > 0,
			totalChars,
		};
	}
	if (totalCharsOverride == null && totalChars <= maxChars) {
		return { text, truncated: false, totalChars };
	}
	const cut = Math.max(0, text.length - maxChars);
	// Не рвём surrogate-пару: если разрез попадает между её половинами
	// (text[cut] — низкий суррогат), отступаем на один символ, чтобы хвост
	// начинался целой парой, а не осиротевшей половиной.
	const start =
		cut > 0 && cut < text.length && text.charCodeAt(cut) >= 0xdc00 && text.charCodeAt(cut) <= 0xdfff ? cut - 1 : cut;
	const tail = text.slice(start);
	const marker = `[truncated — showing last ${maxChars} of ${totalChars} chars; full log: ${outputPath}]\n`;
	return { text: marker + tail, truncated: true, totalChars };
}

export interface JobRow {
	id: string;
	status: string;
	statusRaw: JobStatus;
	name: string;
	elapsed: string;
	command: string;
}

/** Sorted rows for /jobs and bg_status: running first, then newest first. */
export function jobRows(jobs: JobRecord[], now: number): JobRow[] {
	const weight = (s: JobStatus) => (s === "running" ? 0 : 1);
	return [...jobs]
		.sort((a, b) => weight(a.status) - weight(b.status) || Date.parse(b.startedAt) - Date.parse(a.startedAt))
		.map((j) => ({
			id: j.id,
			status: formatStatus(j.status),
			statusRaw: j.status,
			name: j.name,
			elapsed: fmtElapsed((j.endedAt ? Date.parse(j.endedAt) : now) - Date.parse(j.startedAt)),
			command: oneline(j.command, 80),
		}));
}

/** Plain-text table (id, status, name, elapsed) for /jobs and bg_status. */
export function formatJobsTable(jobs: JobRecord[], now: number): string {
	const rows = jobRows(jobs, now);
	const w = {
		id: Math.max(2, ...rows.map((r) => r.id.length)),
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		name: Math.max(4, ...rows.map((r) => r.name.length)),
		elapsed: Math.max(7, ...rows.map((r) => r.elapsed.length)),
	};
	const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
	const lines = [
		`${pad("id", w.id)}  ${pad("status", w.status)}  ${pad("name", w.name)}  ${pad("elapsed", w.elapsed)}  command`,
		...rows.map(
			(r) =>
				`${pad(r.id, w.id)}  ${pad(r.status, w.status)}  ${pad(r.name, w.name)}  ${pad(r.elapsed, w.elapsed)}  ${r.command}`,
		),
	];
	return lines.join("\n");
}
