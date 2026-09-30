/**
 * quiz web: чистая сборка payload'ов для страницы вопроса (без HTTP).
 *
 * Инвариант анти-утечки: `buildPendingState` структурно НЕ МОЖЕТ содержать
 * ключ ответа — тип `PendingPageState` не имеет полей correctIndices/explanation,
 * и варианты превращаются в {index,label} без значений/описаний. Ключ живёт
 * только на сервере (server.ts хранит его рядом, но вне page state) и попадает
 * на страницу лишь в `FeedbackPageState` — строго ПОСЛЕ ответа.
 *
 * Типы QuizOption/QuizResponse/... структурно повторяют внутренние типы
 * ../index.ts (они оттуда не экспортируются; index.ts в этом спавне не трогаем).
 * Грейд-хелперы (isCorrect/sortAnswers) переиспользуются из ../index.ts —
 * как в test/quiz.test.ts, чтобы страница и TUI грейдили одинаково.
 *
 * ⚠ ЦИКЛИЧЕСКИЙ ИМПОРТ ../index.ts: index.ts импортирует buildPendingState
 * отсюда, а мы — его isCorrect/sortAnswers. Это безопасно ТОЛЬКО потому, что
 * здесь они не вызываются на top-level (живые биндинги ESM; обращение к ещё
 * не инициализированному биндингу на top-level дало бы TDZ ReferenceError).
 * Держи использование внутри тел функций.
 */
import { isCorrect, sortAnswers } from "../index.ts";

export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

/** Вариант в финальном (перемешанном) порядке показа; как DisplayedOption в index.ts. */
export interface DisplayedOption {
	index: number; // 1-based
	label: string;
}

export interface OptionAnswer {
	label: string;
	value: string;
	index: number; // 1-based, как показано пользователю
}

/** Ответ страницы; структурно равен QuizResponse в index.ts. */
export interface QuizResponse {
	dontKnow: boolean;
	note?: string; // только непустая заметка
	answers: OptionAnswer[]; // пуст при dontKnow
}

export type QuizMode = "single-select" | "multi-select";

// Тот же текст, что у TUI-строки (index.ts), — интерфейс не должен расходиться.
export const DONT_KNOW_LABEL = "I don't know";

/** Жизненный цикл вопроса на сервере: нет вопроса → ждёт ответ → отвечен. */
export type QuestionPhase = "idle" | "pending" | "answered";

// ── Состояния страницы (payload GET /api/v1/state) ─────────────────────────

/** Сервер жив, вопроса нет — переиспользуемая вкладка просто ждёт. */
export interface IdlePageState {
	kind: "idle";
}

/**
 * Вопрос ждёт ответа. БЕЗ correctIndices/explanation — это проверяется типом
 * и регресс-тестом (payload.test.ts).
 */
export interface PendingPageState {
	kind: "pending";
	question: string;
	context?: string;
	mode: QuizMode;
	/** Варианты в порядке показа (перемешаны вызывающим кодом заранее). */
	options: DisplayedOption[];
	dontKnowLabel: string;
}

/** Фидбек после ответа — единственное состояние, где ключ ответа разрешён. */
export interface FeedbackPageState {
	kind: "feedback";
	question: string;
	context?: string;
	mode: QuizMode;
	options: DisplayedOption[];
	dontKnowLabel: string;
	selectedIndices: number[]; // 1-based, отсортированы
	correctIndices: number[]; // 1-based, отсортированы
	correct: boolean; // dontKnow никогда не «правильно»
	dontKnow: boolean;
	note?: string;
	explanation?: string;
}

export type QuizPageState = IdlePageState | PendingPageState | FeedbackPageState;

// ── Сборка ──────────────────────────────────────────────────────────────────

/**
 * Payload вопроса для страницы. `options` — уже нормализованные и
 * перемешанные варианты (порядок = порядок показа); превращаются в
 * {index,label} — value/description на страницу не уходят.
 */
export function buildPendingState(
	question: string,
	context: string | undefined,
	mode: QuizMode,
	options: QuizOption[],
): PendingPageState {
	return {
		kind: "pending",
		question,
		context,
		mode,
		options: options.map((o, i) => ({ index: i + 1, label: o.label })),
		dontKnowLabel: DONT_KNOW_LABEL,
	};
}

/**
 * Payload фидбека после ответа: тот же вопрос + ключ (correctIndices,
 * explanation) и разбор ответа. Грейд — через isCorrect из ../index.ts,
 * dontKnow отдельной веткой (никогда не «правильно»).
 */
export function buildFeedbackState(
	pending: PendingPageState,
	response: QuizResponse,
	correctIndices: number[],
	explanation: string | undefined,
): FeedbackPageState {
	const selectedIndices = sortAnswers(response.answers).map((a) => a.index);
	const correct = response.dontKnow ? false : isCorrect(selectedIndices, correctIndices);
	return {
		kind: "feedback",
		question: pending.question,
		context: pending.context,
		mode: pending.mode,
		options: pending.options,
		dontKnowLabel: pending.dontKnowLabel,
		selectedIndices,
		correctIndices,
		correct,
		dontKnow: response.dontKnow,
		note: response.note,
		explanation,
	};
}

// ── Разбор POST /api/v1/answer ─────────────────────────────────────────────

/**
 * Строгий разбор тела ответа страницы → QuizResponse, null при любом
 * отклонении от контракта (сервер ответит 400). dontKnow взаимоисключаем
 * с реальными вариантами; заметка обрезается и остаётся только непустой.
 */
export function parseAnswerBody(raw: string): QuizResponse | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (typeof record.dontKnow !== "boolean") return null;
	if (!Array.isArray(record.answers)) return null;

	const answers: OptionAnswer[] = [];
	for (const entry of record.answers) {
		if (typeof entry !== "object" || entry === null) return null;
		const item = entry as Record<string, unknown>;
		if (typeof item.label !== "string" || typeof item.value !== "string") return null;
		if (typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 1) return null;
		answers.push({ label: item.label, value: item.value, index: item.index });
	}
	if (record.dontKnow && answers.length > 0) return null;
	if (!record.dontKnow && answers.length === 0) return null;

	let note: string | undefined;
	if (record.note !== undefined) {
		if (typeof record.note !== "string") return null;
		note = record.note.trim() || undefined;
	}
	return { dontKnow: record.dontKnow, note, answers: record.dontKnow ? [] : answers };
}
