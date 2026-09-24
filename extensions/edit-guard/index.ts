/**
 * edit-guard: страховка инструмента edit.
 *
 * До выполнения правки читает целевой файл и сверяет каждый edits[].oldText
 * с содержимым (match.ts, фазы exact → whitespace → indent → fuzzy):
 *
 *   exact     — старый текст и так совпадает байт-в-байт, не вмешиваемся;
 *   recovered — oldText не совпал, но найден надёжно: подменяем oldText на
 *               точную сырую подстроку файла, чтобы встроенный edit применился
 *               ровно там, где нашлось совпадение (newText не трогаем);
 *   not-found — совпадение ненадёжное (ниже порога или несколько разных
 *               кандидатов): блокируем весь вызов с перечнем строк и сниппетами.
 *
 * Нечитаемый файл и не-edit инструменты пропускаются без вмешательства.
 * Каждое вмешательство пишет одну запись телеметрии "edit-guard" в сессию.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	type ExtensionAPI,
	type ToolCallEvent,
	type ToolCallEventResult,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { resolveEdit } from "./match.ts";

interface TelemetryEdit {
	index: number;
	method: string;
	similarity: number;
}

/**
 * Обработчик события tool_call инструмента edit. deps.readFile — точка подмены
 * в тестах. Хендлер никогда не бросает: сбой внутри пиранья сломал бы сам edit
 * (runner не ловит исключения из emitToolCall), поэтому всё тело под общим
 * try/catch — в catch пишем телеметрию action:"error" и пропускаем вызов.
 */
export function createEditGuardHandler(
	pi: ExtensionAPI,
	deps: { readFile: typeof readFile } = { readFile },
): (event: ToolCallEvent, ctx: { cwd: string }) => Promise<ToolCallEventResult | undefined> {
	return async (event, ctx) => {
		if (!isToolCallEventType("edit", event)) return undefined;

		const input = event.input;
		try {
			const edits = input.edits;
			// Формат строго канонический: { path, edits: [{ oldText, newText }] } —
			// prepareEditArguments встроенного edit разворачивает любые legacy-форматы
			// до вызова хендлера, невалидное пропускаем — инструмент сам выдаст ошибку.
			if (!Array.isArray(edits) || edits.length === 0) return undefined;

			const filePath = isAbsolute(input.path) ? input.path : join(ctx.cwd, input.path);
			let fileText: string;
			try {
				fileText = await deps.readFile(filePath, "utf8"); // raw, с BOM
			} catch {
				return undefined; // файл не читается — не мешаем
			}

			const telemetry: TelemetryEdit[] = [];
			const patched: number[] = [];
			const missing: string[] = [];

			for (let i = 0; i < edits.length; i++) {
				const r = resolveEdit(fileText, edits[i].oldText, { fuzzy: true });
				if (r.status === "recovered") {
					if (r.method !== "exact") {
						edits[i].oldText = r.actual;
						patched.push(i);
					}
					telemetry.push({ index: i, method: r.method, similarity: r.similarity });
				} else {
					telemetry.push({ index: i, method: "not-found", similarity: r.similarity });
					missing.push(`  edits[${i}] (строка ${r.line}, похожесть ${r.similarity.toFixed(2)}): ${r.detail}`);
				}
			}

			const action = missing.length > 0 ? "blocked" : patched.length > 0 ? "patched" : "pass";
			let reason: string | undefined;
			if (action === "blocked") {
				const parts: string[] = [];
				if (patched.length > 0) parts.push(`остальные правки спасены: edits[${patched.join(", ")}]`);
				parts.push(...missing);
				reason = [
					`edit-guard: oldText не найден в ${input.path} — вызов заблокирован целиком.`,
					...parts,
					"",
					"Прочитай файл и исправь oldText так, чтобы он совпал с реальным содержимым (учитывай точные отступы и пробелы), затем повтори правку.",
				].join("\n");
			}
			pi.appendEntry("edit-guard", { path: input.path, action, edits: telemetry, ...(reason !== undefined ? { reason } : {}) });

			if (action === "blocked") return { block: true, reason };
			return undefined;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			try {
				pi.appendEntry("edit-guard", {
					path: typeof input?.path === "string" ? input.path : undefined,
					action: "error",
					error: message,
				});
			} catch {
				// даже телеметрия не должна уронить хендлер
			}
			return undefined; // сбой гарда не должен ломать сам edit
		}
	};
}

export default function (pi: ExtensionAPI) {
	const handler = createEditGuardHandler(pi);
	pi.on("tool_call", handler);
}
