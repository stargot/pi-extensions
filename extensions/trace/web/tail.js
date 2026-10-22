/**
 * Живой хвост /session.jsonl: первый запрос — весь файл, дальше ?from=<байт>
 * только дописанное. Недописанная строка ждёт конца, UTF-8 на стыке кусков
 * собирает потоковый TextDecoder. Файл пересоздан короче (x-session-from ≠ offset)
 * или сервер переключён на другой файл (x-session-file) — reset и полный reload.
 *
 * fetch передаётся снаружи — модуль без DOM, его гоняют тесты в Node.
 */
export class SessionTail {
	/** @param {(url: string) => Promise<any>} fetchFn */
	constructor(fetchFn) {
		this.fetch = fetchFn;
		this.file = "";
		this.reset();
	}

	reset() {
		this.offset = 0;
		this.pending = "";
		this.decoder = new TextDecoder();
	}

	/**
	 * Дочитать хвост. Возвращает { reset, entries }: reset — файл сменился и
	 * entries — сессия целиком; иначе entries — только новые записи.
	 * null — сервера нет или файла нет.
	 */
	async poll() {
		const r = await this.fetch(`session.jsonl?from=${this.offset}`);
		if (!r.ok) return null;
		const file = decodeURIComponent(r.headers.get("x-session-file") ?? "");
		const from = Number(r.headers.get("x-session-from") ?? 0);
		const reset = from !== this.offset || file !== this.file;
		if (reset) this.reset();
		this.file = file;
		const buf = new Uint8Array(await r.arrayBuffer());
		this.offset = from + buf.length;
		return { reset, entries: this.feed(buf) };
	}

	/** Разобрать байты в записи; хвост без \n остаётся в pending. */
	feed(buf) {
		const text = this.pending + this.decoder.decode(buf, { stream: true });
		const lines = text.split("\n");
		this.pending = lines.pop() ?? "";
		return parseLines(lines);
	}
}

/** JSONL → записи; битые строки пропускаются. */
export function parseLines(lines) {
	const out = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// недописанная или битая строка
		}
	}
	return out;
}
