# PLAN: browser bridge — компаньон-расширение + локальный WS-мост для web_fetch

Дата: 2026-09-17 · Статус: план к исполнению (worker-задачи)
Цель: ПОЛНОСТЬЮ уйти от внешних API — убрать r.jina.ai из pi-web; рендеринг
JS-страниц и страниц за авторизацией делается в браузере пользователя локально.

Треки: **(A)** новый репо `pi-web-companion` (MV3-расширение для Chrome MVP);
**(B)** pi-web в pi-extensions: WS-сервер-мост + `deps.renderFn` вместо `jinaFn`.
Интеграционная веха: **живой e2e — web_fetch JS-rendered страницы через мост**.

---

## 0. Проверенные факты (scout, не догадки)

- Тесты репо: 232, все зелёные (`npm test`, node:test, Node v26.1.0).
- `extensions/web/fetch/fetcher.ts`: `jinaFn` — инъекция в `FetcherDeps`, вызывается
  только на путях «статья пуста ИЛИ JS-rendered» (decision 5); SSRF-гард
  `assertPublicHttpUrl` стоит **до любого** сетевого касания, включая фолбэк —
  свойство сохранить и покрыть регрессионным тестом.
- `extensions/web/fetch/jina.ts` + `test/jina.test.ts` (10 тестов) — удаляются целиком;
  `test/fetcher.test.ts` (21 тест) обновляется (двойник `fakeJina` → `fakeRenderer`).
- **Lifecycle-прецедент**: доки `extensions.md` прямо запрещают стартовать сокеты/
  таймеры в фабрике расширения — «Defer background resource startup until
  `session_start`… Register an idempotent `session_shutdown` handler». `session_shutdown`
  срабатывает на exit (Ctrl+C/SIGHUP/SIGTERM), /new, /resume, /fork, /clone, /reload —
  т.е. сервер моста живёт ровно столько, сколько жива сессия, и честно пересоздаётся
  на смену сессии. Прецеденты в репо: `subagents/index.ts` (module state + reset в
  `session_start`, аборт/клир в `session_shutdown`), `session-trace/web/serve.ts`
  (bind строго 127.0.0.1).
- `ws@8.21.3` уже резолвится (транзитивно через pi-coding-agent → genai/openai),
  `esbuild` тоже. В план: объявить `ws` **прямой** dependency (транзитив не гарантирован).
- pi-config `extensions/browser` — это Playwright headless Chromium (не MV3-компаньон):
  тяжёлый инсталл, без пользовательских сессий. НЕ копируем; наш подход (реальный
  браузер пользователя) закрывает страницы за авторизацией, чего Playwright-вариант не даёт.
- Пакет ставится из git (`pi install git:github.com/stargot/pi-extensions`), runtime-deps
  должны быть в `dependencies` (доки extensions.md).

## 1. Зафиксированные решения пользователя

1. Расширение = **WS-клиент**; pi-web = **WS-сервер** на 127.0.0.1, диапазон портов
   на несколько параллельных pi-сессий + env-override.
2. Протокол — JSON-джобы; content script делает Readability+Turndown по уже
   отрендеренному DOM; вкладка `tabs.create({active:false})`, существующая вкладка
   с этим URL — переиспользуется (без повторного логина).
3. `jina.ts` удалить, `deps.jinaFn` → `deps.renderFn`; нет моста → честная empty-ошибка
   (поведение как сейчас без Jina).
4. Zero внешних API, всё localhost.
5. Сервер только на 127.0.0.1 + shared token; SSRF-гард остаётся ДО renderFn.
6. Новый репо `C:\Users\starg\.pi\agent\git\github.com\stargot\pi-web-companion`
   (git init + README делает worker; GitHub-remote и push — ГЕЙТ пользователя).
   Бандл расширения — esbuild.

## 2. Ключевые архитектурные решения (с обоснованием)

| Решение | Выбор | Обоснование |
|---|---|---|
| Порт | Диапазон **8790–8799**, перебор до первого свободного; env `PI_WEB_BRIDGE_PORT` (один) / `PI_WEB_BRIDGE_PORTS` (`"8790-8799"`); исчерпан — мост отключён с warning | Несколько параллельных pi-сессий — норма; фикс-порт + fallback-перебор даёт стабильный дефолт и живучесть. 8787 занят прецедентом session-trace |
| Клиент к портам | Расширение коннектится **ко всем** живым портам диапазона (по WS на каждый hello_ok), а не к первому | Иначе при двух pi-сессиях рендерит только первая. Idle-WS дёшевы; чужие сервисы в диапазоне отсекаются hello-авторизацией |
| Pairing | Shared token: файл `~/.pi/agent/web-bridge-token` (генерится при первом старте сервера, `crypto.randomBytes(32)` → base64url; env `PI_WEB_BRIDGE_TOKEN`/`PI_WEB_BRIDGE_TOKEN_FILE`), пользователь один раз вставляет его в options расширения | UX «вставить один раз». Честная модель угроз: токен защищает от других пользователей машины и слепых локальных сканеров, но не от процессов того же пользователя (они и так могут всё) |
| Origin-фильтр | На upgrade: Origin отсутствует (node-клиент/тесты) ИЛИ `chrome-extension://*` / `moz-extension://*`; остальное — reject до рукопожатия | Злой веб-странице браузер пришьёт Origin — она отсекается ещё до токена (defence in depth) |
| Lifecycle сервера | Старт в `session_start` (не в фабрике!), идемпотентный close в `session_shutdown`; на /new//resume сервер перезапустится — клиент переподключится по backoff | Прямое требование доков pi; прецедент subagents. Параллельные сессии не конфликтуют из-за перебора портов |
| WS-библиотека | `ws` (прямая dependency pi-extensions; `@types/ws` в devDependencies) | У Node (вплоть до 26) есть только WS-**клиент**, сервера нет. Hand-rolled WS-сервер — лишний риск. EventSource+POST не годится: EventSource недоступен в MV3 service worker |
| renderFn wiring | `registerWebFetch(pi, { renderFn })` — замыкание на module-singleton моста в `index.ts`; `fetcher.ts` остаётся pure-оркестрацией (дефолта renderFn нет: нет моста → сразу honest empty) | Сохраняет правило репо «чистая логика без pi-host импортов»; lazy-start и чистота тестов |
| Таймауты | job `timeoutMs=45s` (сервер, TTL в реестре); нет клиента при диспетче — grace до 10s в ожидании переподключения, иначе `null`; клиент: ожидание load ≤30s, ретрай экстракции 3× по 1.5s | «Браузер закрыт» деградирует быстро и честно, не подвешивая tool-вызов |
| Мин. длина markdown | `< 100` символов после trim → трактуется как неудача (гейт в мосте, как MIN_MARKDOWN_LENGTH у Jina) | Заглушки/страницы логина не проходят как «контент» |
| Лимит размера | `maxChars=1_000_000` в job; клиент truncирует, сервер перепроверяет | Согласовано с философией капов fetcher (cap выбран до чтения) |
| Версионирование | Поле `v: 1` в каждом сообщении; hello согласовывает: несовпадение → `hello_err` + close | Дёшево теперь, расширяемо потом |
| Сборка расширения | esbuild (bundle iife): `background.js`, `content/extract.js` (бандлит @mozilla/readability + turndown), `options.js`; manifest/иконки копируются | Проще vite; CJS-пакеты Readability/Turndown бандлятся без настроек |

## 3. Протокол WS v1 (точные типы; общий контракт, держать синхронно:
`extensions/web/fetch/bridge-protocol.ts` ↔ `pi-web-companion/src/shared/protocol.ts`)

```ts
export const PROTOCOL_VERSION = 1;

// ── client → server ────────────────────────────────────────────────
export interface HelloMsg {
  v: 1; type: "hello";
  token: string;                        // shared token
  client: "pi-web-companion";
  clientVersion: string;
}
export type ResultMsg =
  | { v: 1; type: "result"; id: string; ok: true;
      markdown: string; title: string | null; finalUrl: string }
  | { v: 1; type: "result"; id: string; ok: false;
      reason: "timeout" | "navigation-failed" | "render-failed" | "unreadable";
      message?: string };
export interface PingMsg { v: 1; type: "ping"; ts: number }

// ── server → client ────────────────────────────────────────────────
export type HelloReplyMsg =
  | { v: 1; type: "hello_ok"; server: "pi-web"; serverVersion: string }
  | { v: 1; type: "hello_err"; reason: "auth" | "version"; detail?: string };
export interface JobMsg {
  v: 1; type: "job";
  id: string;                           // crypto.randomUUID() сервера
  url: string;                          // уже прошёл assertPublicHttpUrl
  timeoutMs: number;                    // клиентский бюджет на страницу
  maxChars: number;                     // truncate client-side
}
export interface PongMsg { v: 1; type: "pong"; ts: number }
export interface ErrorMsg {
  v: 1; type: "error";
  reason: "unknown-type" | "bad-json" | "bad-v" | "unknown-id";
  detail?: string;
}

export type BridgeMessage =
  | HelloMsg | ResultMsg | PingMsg                      // client → server
  | HelloReplyMsg | JobMsg | PongMsg | ErrorMsg;        // server → client
```

Семантика:
- Результат на неизвестный/просроченный id → `error/unknown-id`, промис не трогаем.
- `ok:false` и таймауты сервера маппятся мостом в `renderFn → null` (мост **никогда
  не бросает**); fetcher превращает `null` в честную empty-ошибку.
- Гейт min-length 100 и cap maxChars применяются в мосте (сервер), не в fetcher.
- Heartbeat: клиентский app-ping каждые 20s (держит MV3 service worker живым —
  в Chrome ≥116 активность WS продлевает жизнь SW); серверный ws-ping каждые 30s,
  2 пропуска → terminate.

---

## 4. Фазы и задачи

Оценки — время одной worker-сессии (часы). `[P]` — параллелится с предыдущей,
`[S]` — требует результата предыдущей.

### Фаза 0 — контракт протокола

**0.1 [S] Типы протокола в pi-web.**
`extensions/web/fetch/bridge-protocol.ts`: типы из §3 + `PROTOCOL_VERSION` + чистый
парсер `parseBridgeMessage(raw: string): BridgeMessage | null` (JSON, поле `v`,
известный type — иначе null) + константы дефолтов (`DEFAULT_PORT_RANGE`,
`JOB_TIMEOUT_MS`, `MAX_CHARS`, `MIN_MARKDOWN_LENGTH`).
Тест `extensions/web/test/bridge-protocol.test.ts`: валидные/битые JSON, чужой `v`,
неизвестный type.
- Done when: `node --test extensions/web/test/bridge-protocol.test.ts` зелёный.
- Оценка: 2ч. Блокирует всё остальное (обе стороны копируют отсюда).

### Фаза B — pi-web: WS-мост + renderFn (параллелится с фазой A после 0.1)

**B1 [S] Чистое ядро моста.**
`extensions/web/fetch/bridge-core.ts`: реестр клиентов (add/remove, round-robin pick),
реестр джобов (create с TTL-таймером, resolve/fail, sweep), авторизация
(`crypto.timingSafeEqual`), правило «нет клиента → ждать до 10s переподключения,
потом null», конкурсность (cap in-flight на клиента 4, FIFO-очередь с TTL),
late-result → ignore. Без импорта `ws` — только логика.
Тест `bridge-core.test.ts`: auth ok/неверный токен; dispatch→resolve маппинг;
TTL → null; поздний результат игнорируется; нет клиента → null через grace;
переполнение очереди разрешается честно.
- Done when: тесты ядра зелёные; файл не импортирует `ws`.
- Оценка: 5ч. Зависимость: 0.1.

**B2 [S] WS-обвязка сервера.**
`extensions/web/fetch/bridge.ts`: `readBridgeConfig(env)` (порт/диапазон, токен,
token-file), `startBridge(config) → { port, render(url, signal): Promise<RenderResult|null>, clients(): number, close(): Promise<void> }`.
Перебор портов (все заняты → bridge «отключён» с причиной в статусе), bind строго
`127.0.0.1`, Origin-фильтр на upgrade, hello/hello_ok/hello_err (3 неудачных токена
→ close), server-ping/terminate, гейт min-length и cap maxChars, генерация id.
В этом же шаге: `package.json` — `ws` в `dependencies`, `@types/ws` в `devDependencies`,
`npm install`.
Интеграционный тест `bridge.test.ts` с **реальным** сервером на порту 0 (random,
без конфликтов) и ws-клиентом из `ws`: неверный токен → hello_err+close; верный →
hello_ok; job → result резолвит промис; клиент отвалился посреди job → null после
TTL; результат после TTL игнорируется.
- Done when: интеграционный тест зелёный; `npm ls ws` показывает прямую зависимость.
- Оценка: 4ч. Зависимость: B1.

**B3 [S] fetcher: jinaFn → renderFn.**
`extensions/web/fetch/fetcher.ts`: `FetcherDeps.jinaFn` →
`renderFn?: (url, signal) => Promise<RenderResult | null>`; тип
`RenderResult { title: string | null; markdown: string; finalUrl: string }` определить
в fetcher.ts (bridge маппит wire-типы в него). В `routeAndExtract`: вызов renderFn
вместо jinaFn; в ok-исходе `finalUrl: render.finalUrl || finalUrl`,
`title: render.title ?? titleFromUrl(render.finalUrl)`; текст `emptyExtractionMessage`
без упоминания Jina («the browser-bridge fallback was unavailable or came up empty»);
докблоки модуля почищены от Jina.
`test/fetcher.test.ts`: `fakeJina` → `fakeRenderer`, переименовать ассерты
(«renderFn 0 calls»), добавить: render с собственным finalUrl попадает в исход;
**регрессия SSRF**: renderFn не вызывается, если гард отклонил URL или редирект-хоп.
Удалить `fetch/jina.ts` и `test/jina.test.ts`.
- Done when: `npm test` зелёный; `grep -ri jina extensions/web` → 0 совпадений
  (кроме исторических записей CHANGELOG).
- Оценка: 4ч. Зависимость: 0.1 (параллелится с B1/B2; мержить после B2).

**B4 [S] Wiring в pi + команда статуса.**
`extensions/web/index.ts`: module-singleton моста (паттерн subagents):
`session_start` → `startBridge(readBridgeConfig(process.env))` идемпотентно и
**нефатально** при ошибке портов; `session_shutdown` → `close()` идемпотентно;
`registerWebFetch(pi, { renderFn: (url, signal) => bridge?.render(url, signal) ?? Promise.resolve(null) })`.
`extensions/web/fetch/tool.ts`: сигнатура `registerWebFetch(pi, deps?: { renderFn? })`,
прокидка в `fetchAndExtract`; description/promptSnippet — убрать «Jina Reader»,
добавить «falls back to the local browser bridge (pi-web-companion extension)»;
в `details` при рендере мостом — `via: "browser-bridge"`.
Команда `pi.registerCommand("bridge")` в index.ts: notify со статусом (порт, клиентов,
путь токен-файла, причина отключения).
- Done when: `npm run smoke` зелёный; запуск pi поднимает сервер (порт виден из
  `/bridge`), повторный `session_start` (/new) не создаёт второй сервер;
  `session_shutdown` закрывает его (проверка ws-клиентом/сnetstat).
- Оценка: 2ч. Зависимость: B2, B3.

**B5 [P] Документация pi-web.**
`extensions/web/README.md`: секцию Jina → секция «Browser bridge» (архитектура,
порт-диапазон, env-переменные, pairing-токен, таблица файлов + bridge-*.ts,
ограничения), таблица тестов обновлена; корневой `README.md` — строка web
(убрать «Jina-фолбэк», добавить «браузерный мост»); корневой `CHANGELOG.md` —
Unreleased: **Removed** Jina Reader, **Added** browser bridge (порты, токен, env),
ссылка на новый репо.
- Done when: `grep -ri jina extensions/web/README.md README.md` → 0; CHANGELOG
  содержит обе записи.
- Оценка: 2ч. Зависимость: B3, B4.

### Фаза A — pi-web-companion (параллельный трек после 0.1)

**A1 [S] Скелет репо.**
`C:\Users\starg\.pi\agent\git\github.com\stargot\pi-web-companion`: `git init`,
README-stub, `.gitignore` (dist/, node_modules/), `package.json` (private, type module;
deps: `@mozilla/readability`, `turndown`; devDeps: `esbuild`, `@types/chrome`),
`build.mjs` (esbuild: `src/background.ts` → `dist/background.js` iife,
`src/content/extract.ts` → `dist/content/extract.js`, `src/options/options.ts` →
`dist/options.js`; копирование `manifest.json`, `options.html`, `icons/`; флаг `--watch`),
`manifest.json` MV3: `permissions: ["scripting","tabs","storage"]`,
`host_permissions: ["<all_urls>"]`, `background: { service_worker: "dist/background.js" }`,
`options_ui`, `action`, иконки), `gen-icons.mjs` (solid-PNG 16/32/48/128 через
node:zlib, результат закоммичен).
- Done when: `npm install && npm run build` даёт `dist/`, chrome://extensions →
  Load unpacked грузится без ошибок консоли.
- Оценка: 2ч. Зависимость: 0.1 (типы копируются в A2, но скелет не ждёт).

**A2 [S] WS-клиент background.**
`src/shared/protocol.ts` — копия §3 с заголовком «sync with pi-extensions
…/fetch/bridge-protocol.ts». `src/background.ts` (часть 1): чтение настроек
(chrome.storage.local: portRange `"8790-8799"`, token), коннект **ко всем** живым
портам диапазона, hello с токеном, hello_err/auth → порт помечается невалидным до
пересканирования; reconnect с backoff 1s→30s + jitter; ping каждые 20s;
`chrome.runtime.onStartup`/`onInstalled` + top-level connect; badge «N» = число
подключённых мостов; `storage.onChanged` → пересканирование.
- Done when: при поднятом мосте (B4 или фейковый ws-сервер) расширение подключается
  (клиенты видны в `/bridge`), при остановке — reconnect-цикл без ошибок SW.
- Оценка: 4ч. Зависимость: A1, 0.1.

**A3 [S] Таб-менеджер + content extract.**
`src/background.ts` (часть 2): обработка job → `tabs.query` точного URL: нашли
(самую свежую) → переиспользуем (не закрываем), нет → `tabs.create({ active: false })`
(запомнить created); ждать `status === "complete"` (tabs.onUpdated, таймаут 30s);
`chrome.scripting.executeScript({ target: { tabId }, files: ["dist/content/extract.js"] })`,
затем сообщение `{ type: "pi-extract", jobId }`; ответ через `chrome.runtime.sendMessage`.
`src/content/extract.ts`: listener pi-extract → `document.cloneNode(true)` →
`new Readability(clone).parse()` → `TurndownService({ headingStyle: "atx",
codeBlockStyle: "fenced" })` → резолв относительных ссылок против `location.href` →
ответ; markdown < 400 символов → ретрай экстракции до 3× с паузой 1.5s (SPA дозревает);
truncate до `maxChars`. Ошибки → `ok:false` c reason (`navigation-failed`,
`render-failed`, `unreadable`, `timeout`); созданные вкладки закрываются после ответа,
переиспользованные остаются.
- Done when: скриптованный ws-клиент (харнес из теста B2) шлёт job на SPA-URL →
  ok-результат с markdown > 1000 символов; job на несуществующий URL →
  navigation-failed; созданная вкладка закрыта, переиспользованная — жива.
- Оценка: 6ч. Зависимость: A2.

**A4 [P] Options-страница.**
`options.html` + `src/options/options.ts`: поля «Диапазон портов» (default 8790-8799),
«Токен» (password-input, chrome.storage.local), Save, статус сохранения, подсказка
`cat ~/.pi/agent/web-bridge-token`. Читается background'ом через storage.onChanged.
- Done when: save/load roundtrip работает; смена настроек триггерит переподключение
  без перезагрузки расширения.
- Оценка: 2ч. Зависимость: A1 (параллелится с A2/A3).

**A5 [S] Прогон problem-страниц (валидация).**
Ручной чек-лист (результаты зафиксировать в README, раздел «Проверено»): обычная
SSR-страница; SPA (svelte.dev/docs или vitejs.dev); страница за логином — открыть
залогиненную вкладку, web_fetch URL того же сайта → переиспользование (новая вкладка
не создаётся, логин не спрашивается); длинная страница → truncate по maxChars;
не-HTML URL в браузере (PDF-viewer) → unreadable; короткий redirect → finalUrl целевой.
Мелкие фиксы по ходу.
- Done when: чек-лист пройден, наблюдения/ограничения описаны в README.
- Оценка: 3ч. Зависимость: A3.

**A6 [P, опционально] Firefox.**
`manifest.firefox.json` (background scripts вместо service_worker; остальное то же),
скрипт сборки `build:firefox`, smoke в FF (namespace chrome.* в FF совместим).
- Done when: расширение грузится в FF, один e2e-job проходит. Может быть срезано
  без ущерба MVP.
- Оценка: 3ч. Зависимость: A3.

### Фаза I — интеграция (веха)

**I1 [S] Живой e2e.**
pi с обновлённым pi-web + расширение в Chrome (unpacked, token в options):
1. `web_fetch` JS-rendered страницы → ok, markdown осмысленный,
   `details.via === "browser-bridge"`;
2. браузер закрыт → web_fetch JS-страницы → честная empty-ошибка быстро (≤ ~60s),
   tool-вызов не подвешивается;
3. два параллельных pi → мосты на 8790 и 8791, расширение подключено к обоим,
   оба рендерят;
4. обычная SSR-страница рендерится как раньше (мост не участвует);
5. `npm test` (≥ 230 зелёных, jina-тестов нет) и `npm run smoke` — зелёные.
- Done when: все пять пунктов воспроизведены, вывод зафиксирован в отчёте worker.
- Оценка: 2ч. Зависимость: B4, A3 (минимум). A5 параллелит сюрпризы, но не блокирует.

## 5. Критический путь и зависимости

```
0.1 ──► B1 ──► B2 ──► B4 ──► I1 ──► (гейт пользователя: GitHub-remote + push)
 │             └──► B3 ─┘  └─► B5
 └──► A1 ──► A2 ──► A3 ──► A5 ──► I1 (полный чек-лист)
        └──► A4 (P)     └──► A6 (P, опц.)
```
Сумма ≈ 37–41ч; критический путь (B-трек) ≈ 17ч; A-трек ≈ 17ч параллельно.
После 0.1 треки A и B идут одновременно (два worker-спавна); внутри B шаг B3
можно вести параллельно с B1/B2 до правки тестов fetcher.

## 6. Files to Modify (pi-extensions)

- `extensions/web/fetch/fetcher.ts` — jinaFn → renderFn (тип RenderResult), финальный
  finalUrl/title из рендера, тексты empty-сообщений, докблоки.
- `extensions/web/fetch/tool.ts` — deps-прокидка renderFn, description/promptSnippet,
  `details.via`.
- `extensions/web/index.ts` — session_start/session_shutdown lifecycle моста,
  registerWebFetch(pi, { renderFn }), команда `/bridge`.
- `extensions/web/test/fetcher.test.ts` — fakeJina → fakeRenderer, ассерты,
  SSRF-регрессия.
- `package.json` — `ws` в dependencies, `@types/ws` в devDependencies.
- `extensions/web/README.md`, `README.md`, `CHANGELOG.md` — Jina → Bridge.

## 7. New Files

pi-extensions:
- `extensions/web/fetch/bridge-protocol.ts` — протокол v1 (§3), парсер, дефолты.
- `extensions/web/fetch/bridge-core.ts` — чистое ядро: реестры клиентов/джобов,
  auth, TTL.
- `extensions/web/fetch/bridge.ts` — ws-сервер: порты, Origin, hello, heartbeat,
  start/close.
- `extensions/web/test/bridge-protocol.test.ts`, `bridge-core.test.ts`,
  `bridge.test.ts`.

pi-web-companion (новое репо,
`C:\Users\starg\.pi\agent\git\github.com\stargot\pi-web-companion`):
- `manifest.json`, `build.mjs`, `gen-icons.mjs`, `package.json`, `README.md`,
  `.gitignore`
- `src/shared/protocol.ts`, `src/background.ts`, `src/content/extract.ts`,
  `src/options/options.ts`, `options.html`, `icons/icon{16,32,48,128}.png`

Deleted: `extensions/web/fetch/jina.ts`, `extensions/web/test/jina.test.ts`.

## 8. Verification

1. `npm test` — все зелёные, jina-тестов нет (≈ 232 − 10 + ~25 новых ≈ 247).
2. `npm run smoke` — пакет грузится в pi.
3. `grep -ri "jina" extensions/web README.md` — упоминаний нет (исторические
   записи в CHANGELOG допустимы).
4. Интеграционный тест `bridge.test.ts` — реальный ws-сервер на порту 0:
   auth/job/TTL/late-result.
5. Живой e2e I1 (пять пунктов выше) — главный критерий.
6. `/bridge` в pi показывает порт и клиентов; закрытие pi освобождает порт.

## 9. Риски

- **Несколько pi-сессий**: портов 10 — хватает с запасом; исчерпание → мост
  отключён с warning (не ломает pi). Клиент коннектится ко всем портам —
  «дубли клиентов» между сессиями исключены (клиентов столько, сколько живых мостов).
- **Браузер закрыт / service worker спит**: grace 10s + TTL 45s → быстрая честная
  деградация к empty; ping 20s держит MV3 SW (гарантия Chrome ≥116; старее не
  поддерживаем).
- **Злой webpage → ws://127.0.0.1**: отсекается Origin-фильтром + токеном.
  Процессы того же пользователя токен-файл читают — за пределами модели угроз
  (задокументировать в README).
- **CSP/permissions**: расширению нужны `scripting`, `tabs`,
  `host_permissions: <all_urls>` — широкий пермишен, неизбежный для инъекций
  в произвольные страницы; явно описать в README.
- **Firefox**: отличия манифеста (background scripts), moz-extension Origin,
  нюансы tabs.onUpdated — поэтому FF опциональный A6; код с первого дня пишется
  совместимо (chrome.* + promises).
- **Readability на живом DOM**: обязательно клонировать document (мутирует вход).
- **Страницы логина**: экстракция может вернуть markdown формы логина — честный
  результат; переиспользование вкладки решает только «не логиниться повторно».
- **ws — сегодня транзитив**: фиксируем прямую dependency, иначе обновление
  pi-coding-agent может молча убрать его.
- **Windows**: chmod-прав на NTFS нет — принято (та же модель угроз); путь
  токен-файла через `getAgentDir()`, не хардкодом `.pi`.
- ASSUMPTION: WebSocket из MV3 service worker шлёт заголовок
  `Origin: chrome-extension://<id>` (ожидается по документации Chrome; если нет —
  Origin-фильтр вырождается в «нет Origin = ок», токен остаётся главной защитой;
  проверить на шаге A2).

## 10. Гейт пользователя (после I1)

- Создание GitHub-репозитория `stargot/pi-web-companion`, добавление remote, push.
- Пуш изменений pi-extensions (затем `pi update --extensions`).
