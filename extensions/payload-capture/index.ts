/**
 * payload-capture: перехват следующего provider-запроса одним выстрелом.
 *
 *   /payload arm [--save]  — вооружить захват следующего запроса
 *   /payload show          — показать последний захват (redacted) в редакторе
 *   /payload clear         — сбросить состояние и статус-чип
 *
 * Приватность (красная линия):
 *   - payload НИКОГДА не модифицируется: handler возвращает undefined;
 *   - захват хранится только в памяти и только после redaction;
 *   - запись на диск — только при `--save` И доверенном проекте, и только в
 *     `<agentDir>/cache/payload-captures/`, никогда в cwd проекта.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type PayloadCapture,
	armPayload,
	captureNextPayload,
	clearPayload,
	captureFilePath,
	createPayloadState,
	disarmPayload,
} from "./state.ts";

const STATUS_KEY = "payload-capture";

const SUBCOMMANDS = ["arm", "show", "clear", "help"] as const;

const HELP = [
	"payload-capture: перехват следующего provider-запроса (один раз)",
	"",
	"  /payload arm [--save]  вооружить захват следующего запроса",
	"  /payload show          показать последний захват (redacted) в редакторе",
	"  /payload clear         сбросить состояние и статус-чип",
	"",
	"Приватность:",
	'  - credential-поля (key/token/secret/credential/authorization/api-key) маскируются как "***";',
	"  - без --save ничего не пишется на диск;",
	"  - с --save файл пишется только в доверенном проекте и только в",
	"    <agentDir>/cache/payload-captures/, никогда в cwd проекта.",
].join("\n");

export default function (pi: ExtensionAPI) {
	const state = createPayloadState();

	const capturesDir = () => `${getAgentDir()}/cache/payload-captures`;

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// статус вторичен; ошибки UI не должны ломать захват
		}
	};

	/** Статус-чип с цветом темы; без темы — просто текст. */
	const chip = (ctx: ExtensionContext, color: "accent" | "warning" | "success", text: string) => {
		try {
			setStatus(ctx, ctx.ui.theme.fg(color, text));
		} catch {
			setStatus(ctx, text);
		}
	};

	pi.registerCommand("payload", {
		description: "Capture the next provider request once: arm [--save] | show | clear",
		getArgumentCompletions: (prefix) => {
			// хвостовой пробел значим: "arm " → предлагаем --save, а не подкоманды
			const raw = prefix ?? "";
			const trailingSpace = /\s$/.test(raw);
			const parts = raw.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) return SUBCOMMANDS.map((s) => ({ value: s, label: s }));
			if (parts.length === 1) {
				if (parts[0] === "arm" && trailingSpace) {
					return [{ value: "--save", label: "save the redacted payload to <agentDir>/cache/payload-captures/" }];
				}
				const matches = SUBCOMMANDS.filter((s) => s.startsWith(parts[0]));
				return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
			}
			if (parts[0] === "arm" && parts.length === 2 && "--save".startsWith(parts[1])) {
				return [{ value: "--save", label: "save the redacted payload to <agentDir>/cache/payload-captures/" }];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";

			if (sub === "arm") {
				const unknown = parts.slice(1).filter((p) => p !== "--save");
				if (unknown.length > 0) {
					ctx.ui.notify(
						`payload-capture: неизвестный аргумент ${unknown[0]} — использование: /payload arm [--save]`,
						"warning",
					);
					return;
				}
				let save = parts.includes("--save");
				if (save && !ctx.isProjectTrusted()) {
					// Красная линия: в недоверенном проекте --save игнорируется, arm остаётся доступным.
					ctx.ui.notify(
						"payload-capture: проект не доверенный — --save проигнорирован (захват только в память)",
						"warning",
					);
					save = false;
				}
				armPayload(state, save);
				chip(ctx, save ? "warning" : "accent", save ? "payload:armed+save" : "payload:armed");
				ctx.ui.notify(
					save
						? "payload-capture: вооружено — следующий provider-запрос будет захвачен и сохранён (redacted) в <agentDir>/cache/payload-captures/"
						: "payload-capture: вооружено — следующий provider-запрос будет захвачен (в память, без записи на диск)",
					"info",
				);
				return;
			}

			if (sub === "show") {
				const capture = state.lastCapture;
				if (!capture) {
					ctx.ui.notify("payload-capture: захватов ещё нет — сначала /payload arm", "warning");
					return;
				}
				showCapture(ctx, capture);
				return;
			}

			if (sub === "clear") {
				const hadCapture = state.armed || state.lastCapture !== undefined;
				clearPayload(state);
				setStatus(ctx, undefined);
				ctx.ui.notify(
					hadCapture ? "payload-capture: состояние и чип сброшены" : "payload-capture: нечего сбрасывать",
					"info",
				);
				return;
			}

			if (sub === "help" && parts.length === 1) {
				await showText(ctx, "payload-capture: help", HELP);
				return;
			}
			ctx.ui.notify("payload-capture: использование — /payload arm [--save] | show | clear | help", "warning");
		},
	});

	// Возврат undefined обязателен: не-undefined значение ЗАМЕНИЛО бы payload.
	pi.on("before_provider_request", (event, ctx) => {
		if (!state.armed) return undefined;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		const outcome = captureNextPayload(state, event.payload, { model });
		if (!outcome.captured || !outcome.capture) return undefined;
		const capture = outcome.capture;

		chip(ctx, "success", "payload:captured");

		if (outcome.saveRequested) {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify(
					"payload-capture: захвачено, но проект не доверенный — НЕ сохранено (только в памяти)",
					"warning",
				);
			} else {
				try {
					const file = captureFilePath(capturesDir(), capture);
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(
						file,
						JSON.stringify(
							{ ts: capture.ts, model: capture.model, truncated: capture.truncated, payload: capture.payload },
							null,
							2,
						),
						"utf8",
					);
					ctx.ui.notify(`payload-capture: захвачено и сохранено (redacted): ${file}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`payload-capture: захвачено, но НЕ сохранено: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		} else {
			ctx.ui.notify(`payload-capture: захвачено (${capture.chars} chars) — /payload show, чтобы посмотреть`, "info");
		}
		return undefined;
	});

	// При завершении сессии: разоружаем захват (иначе armed переживает смену
	// сессии и «выстреливает» в новой — сюрприз для пользователя) и снимаем чип.
	// lastCapture сознательно остаётся: /payload show всё ещё доступен.
	pi.on("session_shutdown", (_event, ctx) => {
		disarmPayload(state);
		if (ctx.hasUI) setStatus(ctx, undefined);
	});
}

function showCapture(ctx: ExtensionContext, capture: PayloadCapture): void {
	const suffix = capture.truncated ? "\n\n[payload-capture: payload был усечён лимитами redaction]" : "";
	const text = `${JSON.stringify({ ts: capture.ts, model: capture.model, payload: capture.payload }, null, 2)}${suffix}`;
	void showText(ctx, `payload-capture: ${capture.ts} ${capture.model}`, text);
}

async function showText(ctx: ExtensionContext, title: string, text: string): Promise<void> {
	if (ctx.hasUI) {
		await ctx.ui.editor(title, text);
		return;
	}
	console.log(text);
}
