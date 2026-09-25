/**
 * session-handoff: механический дамп состояния сессии при выходе и
 * «подхватить с того места» на следующем запуске.
 *
 * Ядро — чистые функции без побочных эффектов: сборка markdown из уже
 * собранных фактов и слаг проекта. Чтение сессии и запуск git живут в
 * index.ts и прокидываются сюда данными (git — колбэком).
 *
 * Формат файла (~/.pi/agent/handoff/<slug>.md), всё опционально:
 *   # Handoff — <проект> — <дата>
 *   Session: <файл> · Длительность <мин> мин
 *   ## Последний запрос   ← последний user-текст
 *   ## Последний ответ    ← последний assistant-текст
 *   ## Git                ← ветка, статус, diff --stat, последние коммиты
 */

export interface GitInfo {
	branch: string;
	/** `git status --short` — до 15 строк. */
	status: string[];
	/** Хвост `git diff --stat` — до 5 строк. */
	diffStat: string[];
	/** `git log --oneline -3`. */
	commits: string[];
	/** Число незакоммиченных файлов. */
	dirtyCount: number;
}

export interface HandoffInput {
	/** Абсолютный путь проекта (cwd сессии). */
	projectDir: string;
	/** Файл сессии (для /trace и точной идентификации). */
	sessionFile?: string;
	/** Unix ms начала сессии. */
	startedAt?: number;
	/** Последний пользовательский текст. */
	lastUser?: string;
	/** Последний ответ ассистента. */
	lastAssistant?: string;
	/** Данные git; null — не репозиторий или git недоступен. */
	git?: GitInfo | null;
	/** Unix ms текущего момента (по умолчанию Date.now()). */
	now?: number;
}

/** Обрезать строку до n символов с маркером обрезки. */
export function capLine(text: string, n: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, Math.max(n - 1, 0))}…` : flat;
}

/** Безопасное имя файла: D:\Repos\demo → d--projects-pi-extensions. */
export function projectSlug(projectDir: string): string {
	return (
		projectDir
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "unknown"
	);
}

function fmtDate(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildHandoffMarkdown(input: HandoffInput): string {
	const now = input.now ?? Date.now();
	const lines: string[] = [];

	const project = input.projectDir.split(/[\\/]/).filter(Boolean).pop() ?? input.projectDir;
	lines.push(`# Handoff — ${project} — ${fmtDate(now)}`);
	if (input.sessionFile) lines.push(`Session: ${input.sessionFile}`);
	if (input.startedAt) {
		const minutes = Math.max(1, Math.round((now - input.startedAt) / 60_000));
		lines.push(`Длительность: ~${minutes} мин`);
	}

	if (input.lastUser) {
		lines.push("", "## Последний запрос", capLine(input.lastUser, 300));
	}
	if (input.lastAssistant) {
		lines.push("", "## Последний ответ", capLine(input.lastAssistant, 600));
	}

	if (input.git) {
		const g = input.git;
		lines.push("", `## Git — ${g.branch}`);
		if (g.dirtyCount > 0) lines.push(`Незакоммиченных файлов: ${g.dirtyCount}`);
		if (g.status.length > 0) lines.push("", "```", ...g.status, "```");
		if (g.diffStat.length > 0) lines.push("", "```", ...g.diffStat, "```");
		if (g.commits.length > 0) lines.push("", "Недавние коммиты:", ...g.commits.map((c) => `- ${c}`));
	} else {
		lines.push("", "## Git", "не репозиторий или git недоступен");
	}

	lines.push("", `_Собрано автоматически (без LLM) в ${fmtDate(now)}._`);
	return lines.join("\n");
}
