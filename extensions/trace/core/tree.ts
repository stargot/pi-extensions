/**
 * Дерево записей сессии pi (JSONL v3, id/parentId) с инкрементальным add().
 * Лист — последняя записанная запись, как SessionManager при загрузке файла:
 * ветка, на которую ушли через /tree, продолжается новой записью с parentId
 * на точку ветвления, и активный путь идёт от неё к корню.
 *
 * Чистый модуль: без Node/DOM API (его же грузит веб-вьюер).
 */

/** Запись сессии: общие поля, остальное — по type (см. docs/session-format.md pi). */
export interface Entry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: any;
}

export class SessionTree {
	/** Заголовок файла (type: "session"): cwd, version, parentSession. */
	header?: Entry;
	/** Записи в порядке файла, без заголовка. */
	readonly entries: Entry[] = [];
	leafId: string | null = null;
	/** Растёт на каждый add() — инвалидация производных моделей. */
	revision = 0;

	private byId = new Map<string, Entry>();
	private kids = new Map<string | null, Entry[]>();
	private seq = new Map<string, number>();

	add(e: Entry): void {
		if (!e || typeof e !== "object") return;
		this.revision++;
		if (e.type === "session") {
			this.header = e;
			return;
		}
		// v1-сессии без id — линейная цепочка: синтезируем id и связь с листом.
		const id = typeof e.id === "string" ? e.id : `#${this.entries.length}`;
		const parentId = typeof e.id === "string" ? (e.parentId ?? null) : this.leafId;
		const entry = id === e.id && parentId === e.parentId ? e : { ...e, id, parentId };
		if (this.byId.has(id)) return; // дубль строки — первая запись главнее
		this.seq.set(id, this.entries.length);
		this.entries.push(entry);
		this.byId.set(id, entry);
		const siblings = this.kids.get(parentId);
		if (siblings) siblings.push(entry);
		else this.kids.set(parentId, [entry]);
		this.leafId = id;
	}

	get(id: string | null | undefined): Entry | undefined {
		return id == null ? undefined : this.byId.get(id);
	}

	/** Порядковый номер записи в файле (-1 — нет такой). */
	seqOf(id: string): number {
		return this.seq.get(id) ?? -1;
	}

	/** Дети записи в порядке файла; null — корни. */
	children(id: string | null): readonly Entry[] {
		return this.kids.get(id) ?? [];
	}

	/** Путь от корня до leaf (по умолчанию — текущий лист). */
	path(leafId: string | null = this.leafId): Entry[] {
		const out: Entry[] = [];
		const seen = new Set<string>();
		let cur = this.get(leafId);
		while (cur && !seen.has(cur.id!)) {
			seen.add(cur.id!);
			out.push(cur);
			cur = this.get(cur.parentId);
		}
		return out.reverse();
	}

	/** Самая поздняя по файлу запись поддерева id (сам id, если детей нет). */
	latestIn(id: string): Entry | undefined {
		let best = this.get(id);
		const stack = [...this.children(id)];
		while (stack.length > 0) {
			const e = stack.pop()!;
			if (best === undefined || this.seqOf(e.id!) > this.seqOf(best.id!)) best = e;
			stack.push(...this.children(e.id!));
		}
		return best;
	}
}
