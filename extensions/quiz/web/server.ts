/**
 * quiz web: in-process HTTP-сервер страницы вопроса (node:http, эфемерный порт).
 *
 * Контракт для execute() (шаг 5 плана web-quiz):
 *   const handle = await startQuizServer({ timeoutMs, signal });
 *   handle.setQuestion(buildPendingState(...), { correctIndices, explanation });
 *   const response = await handle.waitForAnswer(); // QuizResponse | null
 *
 * Анти-утечка: ключ ответа (correctIndices/explanation) передаётся серверу
 * рядом с payload'ом, но НЕ внутри него; GET /api/v1/state до ответа отдаёт
 * PendingPageState без ключа. POST /api/v1/answer грейдит НА СЕРВЕРЕ через
 * buildFeedbackState (isCorrect из ../index.ts) — ключ попадает в state
 * только после принятого ответа, так что его не видно даже в devtools.
 *
 * Безопасность: bind строго 127.0.0.1, проверка Host на loopback (общий гард
 * из shared/loopback.ts, анти-DNS-rebinding), пер-серверный случайный токен в
 * URL (обязателен на /api/*, сравнение через sha256+timingSafeEqual), проверка
 * Origin на POST (CSRF), капа тела POST, CSP на статику, никакой записи на диск.
 *
 * Жизненный цикл: сервер живёт всю сессию, страница переиспользуется поллингом;
 * setQuestion заменяет состояние (idle→pending, feedback→pending), фидбек
 * остаётся на странице до следующего вопроса. Один активный вопрос: второй
 * setQuestion в pending-фазе → {ok:false, conflict:true} (FIFO параллельных
 * вызовов — забота расширения, шаг 5). Таймаут вопроса (дефолт 10 мин, 0 = ∞),
 * cancel()/abort — текущий вопрос гасится, ждущие получают null.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost } from "../../shared/loopback.ts";
import {
	buildFeedbackState,
	parseAnswerBody,
	type PendingPageState,
	type QuizPageState,
	type QuestionPhase,
	type QuizResponse,
} from "./payload.ts";

const defaultWebDir = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 мин; 0 = ∞
/** Капа тела POST /api/v1/answer: там только JSON ответа с заметкой. */
const MAX_BODY_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

/**
 * CSP для статики: script/style/font — только CDN-хосты, которые app.js
 * пиннит с SRI (шаг 4: marked, KaTeX, mermaid); стили инлайном нужны mermaid/
 * KaTeX-рендеру. connect-src 'self' — поллинг /api/v1/*.
 */
const CSP = [
	"default-src 'none'",
	"script-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
	"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
	"font-src https://cdn.jsdelivr.net https://unpkg.com",
	"img-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
].join("; ");

/** Ключ ответа: живёт ТОЛЬКО на сервере, в state попадает после ответа. */
export interface QuizQuestionKey {
	correctIndices: number[];
	explanation?: string;
}

export interface QuizServerOptions {
	/** Порт; 0 — эфемерный (дефолт), чтобы параллельные сессии не конфликтовали. */
	port?: number;
	/** Таймаут одного вопроса, мс; 0 = без таймаута. Дефолт DEFAULT_TIMEOUT_MS. */
	timeoutMs?: number;
	/**
	 * Сигнал отмены (Esc/interrupt): гасит текущий вопрос (waiters → null)
	 * и закрывает сервер. Для отмены отдельного вопроса есть waitForAnswer(signal).
	 */
	signal?: AbortSignal;
	/** Папка статики; по умолчанию — рядом с этим модулем (web/index.html). */
	webDir?: string;
}

export interface QuizServerHandle {
	port: number;
	/** URL с токеном: http://127.0.0.1:PORT/?t=TOKEN — его открывает браузер. */
	url: string;
	token: string;
	/**
	 * Выставить новый вопрос. Пока предыдущий ждёт ответа — конфликт
	 * (второй активный вопрос на сервере запрещён; FIFO — на стороне расширения).
	 */
	setQuestion(pending: PendingPageState, key: QuizQuestionKey): { ok: true } | { ok: false; conflict: true };
	/**
	 * Ждать ответ активного/следующего вопроса: QuizResponse после принятого
	 * POST, null при таймауте/отмене/close. `signal` отменяет текущий вопрос
	 * (сервер продолжает жить — вкладка переиспользуется).
	 */
	waitForAnswer(signal?: AbortSignal): Promise<QuizResponse | null>;
	/** Гасит текущий вопрос (state → idle, waiters → null); сервер продолжает жить. */
	cancel(): void;
	/** Закрывает сервер; ждущие получают null. */
	close(): Promise<void>;
}

function send(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
	res.writeHead(code, { "content-type": type });
	res.end(body);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
	send(res, code, JSON.stringify(body), "application/json");
}

export function startQuizServer(options: QuizServerOptions = {}): Promise<QuizServerHandle> {
	const webDir = options.webDir ?? defaultWebDir;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const token = randomBytes(32).toString("hex");
	// sha256 обеих сторон: timingSafeEqual требует равные длины, хэш её
	// гарантирует и не раскрывает длину настоящего токена.
	const tokenDigest = createHash("sha256").update(token).digest();

	let server: Server | undefined;
	let phase: QuestionPhase = "idle";
	let pageState: QuizPageState = { kind: "idle" };
	let pending: PendingPageState | undefined;
	let key: QuizQuestionKey | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const waiters: Array<(response: QuizResponse | null) => void> = [];

	function clearTimer(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function resolveWaiters(response: QuizResponse | null): void {
		const pendingWaiters = [...waiters];
		waiters.length = 0;
		for (const waiter of pendingWaiters) waiter(response);
	}

	function disarmQuestion(): void {
		// Вопрос гасится: страница через поллинг уходит в idle («ждём вопрос…»).
		phase = "idle";
		pending = undefined;
		key = undefined;
		pageState = { kind: "idle" };
		clearTimer();
		resolveWaiters(null);
	}

	function tokenOk(provided: string | null): boolean {
		if (!provided) return false;
		const digest = createHash("sha256").update(provided).digest();
		return timingSafeEqual(tokenDigest, digest);
	}

	function readBody(req: IncomingMessage): Promise<{ body?: string; tooLarge?: boolean }> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let tooLarge = false;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					// Дренируем до конца (не destroy): иначе 413 может не уйти.
					tooLarge = true;
					chunks.length = 0;
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(tooLarge ? { tooLarge } : { body: Buffer.concat(chunks).toString("utf8") }));
			req.on("error", () => resolve({ body: undefined }));
		});
	}

	async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (!tokenOk(url.searchParams.get("t"))) {
			send(res, 403, "forbidden");
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/v1/state") {
			// Единственный источник состояния страницы; до ответа ключа здесь нет
			// по построению (PendingPageState без ключевых полей).
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify(pageState));
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/v1/answer") {
			// CSRF: чужая страница в браузере не может постить сюда (same-origin POST).
			const ownOrigin = `http://${req.headers.host ?? ""}`;
			if (req.headers.origin && req.headers.origin !== ownOrigin) {
				send(res, 403, "forbidden");
				return;
			}
			if (phase !== "pending" || !pending || !key) {
				// Ответа нет: уже отвечен (второй POST), истёк таймаут или вопрос не ставили.
				sendJson(res, 409, { ok: false, error: "no pending question" });
				return;
			}
			const { body, tooLarge } = await readBody(req);
			if (tooLarge) {
				send(res, 413, "payload too large");
				return;
			}
			const response = body === undefined ? null : parseAnswerBody(body);
			if (!response) {
				send(res, 400, "bad request");
				return;
			}
			// TOCTOU-ревалидация: пока тело висело в сети, состояние могло измениться
			// (таймаут/abort/close/второй POST от второй вкладки) — без этой
			// перепроверки buildFeedbackState(undefined) ронял процесс. Снимаем
			// снапшот в константы: нароуинг не протекает в колбэки (.some).
			if (phase !== "pending" || !pending || !key) {
				sendJson(res, 409, { ok: false, error: "no pending question" });
				return;
			}
			const armedPending = pending;
			const armedKey = key;
			// Подделанный POST не должен создавать фантомные варианты в фидбеке.
			if (response.answers.some((answer) => answer.index < 1 || answer.index > armedPending.options.length)) {
				send(res, 400, "bad request");
				return;
			}
			// Грейд на сервере: страница получает фидбек с ключом только теперь.
			pageState = buildFeedbackState(armedPending, response, armedKey.correctIndices, armedKey.explanation);
			phase = "answered";
			pending = undefined;
			key = undefined;
			clearTimer();
			resolveWaiters(response);
			sendJson(res, 200, { ok: true });
			return;
		}

		send(res, 404, "not found");
	}

	function handle(req: IncomingMessage, res: ServerResponse): void {
		if (!isLoopbackHost(req.headers.host)) {
			send(res, 403, "forbidden");
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (url.pathname.startsWith("/api/")) {
			// Страховка от всего класса Critical: любой бросок в обработчике —
			// 500, а не необработанный rejection, убивающий процесс pi.
			handleApi(req, res, url).catch(() => {
				if (!res.headersSent) send(res, 500, "internal error");
				else res.end();
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/ping") {
			send(res, 200, "quiz-web");
			return;
		}

		if (req.method !== "GET") {
			send(res, 404, "not found");
			return;
		}

		// Статика: / → index.html, /app.js (файлы шага 4; до них — 404).
		const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
		if (rel !== "index.html" && rel !== "app.js") {
			send(res, 404, "not found");
			return;
		}
		try {
			// Сначала читаем: отсутствующий файл (шаг 4 ещё не принёс index.html/
			// app.js) должен дать чистый 404, а не writeHead-с-последующим-throw.
			const file = readFileSync(join(webDir, rel));
			res.writeHead(200, {
				"content-type": MIME[rel.slice(rel.lastIndexOf("."))] ?? "text/plain",
				"cache-control": "no-store",
				"content-security-policy": CSP,
			});
			res.end(file);
		} catch {
			send(res, 404, "not found");
		}
	}

	return new Promise((resolve, reject) => {
		server = createServer((req, res) => handle(req, res));
		server.on("error", reject);
		// unref: сервер не должен сам по себе удерживать процесс (в тестах и pi).
		server.unref();
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			const address = server?.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const url = `http://127.0.0.1:${port}/?t=${token}`;

			const handleRef: QuizServerHandle = {
				port,
				url,
				token,
				setQuestion(nextPending, nextKey) {
					if (closed) return { ok: false, conflict: true };
					if (phase === "pending") return { ok: false, conflict: true };
					phase = "pending";
					pending = nextPending;
					key = nextKey;
					pageState = nextPending;
					clearTimer();
					if (timeoutMs > 0) {
						timer = setTimeout(disarmQuestion, timeoutMs);
						timer.unref?.();
					}
					return { ok: true };
				},
				waitForAnswer(signal) {
					if (signal?.aborted) return Promise.resolve(null);
					return new Promise<QuizResponse | null>((resolveWaiter) => {
						// settled-флаг: гонка POST/abort/таймаута не должна ни дважды
						// разрешить промис, ни оставить висеть abort-листенер — иначе
						// протухший сигнал позже деактивировал бы ЧУЖОЙ активный вопрос.
						let settled = false;
						const onAbort = () => {
							// Esc/interrupt: гасим вопрос, сервер живёт дальше.
							if (phase === "pending") disarmQuestion();
							finish(null);
						};
						const finish = (value: QuizResponse | null) => {
							if (settled) return;
							settled = true;
							signal?.removeEventListener("abort", onAbort);
							resolveWaiter(value);
						};
						waiters.push(finish);
						signal?.addEventListener("abort", onAbort, { once: true });
					});
				},
				cancel() {
					if (phase === "pending") disarmQuestion();
				},
				close() {
					closed = true;
					disarmQuestion();
					const ref = server;
					if (!ref) return Promise.resolve();
					// keep-alive сокеты поллера не должны задерживать close.
					ref.closeIdleConnections();
					return new Promise<void>((done) => ref.close(() => done()));
				},
			};

			let onAbort: (() => void) | undefined;
			if (options.signal) {
				if (options.signal.aborted) {
					// Уже отменено: вопрос не ждём, сервер сразу закрываем.
					resolve(handleRef);
					handleRef.close();
					return;
				}
				onAbort = () => {
					disarmQuestion();
					handleRef.close();
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			resolve(handleRef);
		});
	});
}
