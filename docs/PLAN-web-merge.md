# PLAN: слияние стороннего web-fetch в пакет pi-web

Дата: 2026-09-17.
Источники: `C:\Users\starg\.pi\agent\excluded-extensions\web-fetch\index.ts` (~700 строк, сторонний),
этот репо (`extensions/web-search/`), доки pi (`docs/extensions.md`, `docs/packages.md`).
Зафиксированные решения пользователя (1–6) не пересматриваются; задача 10 — чек-лист их приёмки.

## Цель

Добавить `web_fetch` вторым инструментом в существующий пакет: каталог
`extensions/web-search` → `extensions/web`, package name `pi-web`, ленивые
импорты тяжёлых deps, P0-фиксы (SSRF-гард, стримовый size-лимит) встроены,
P2-фиксы (Abort-хелпер, retry-политика, Jina только на пустой экстракции,
резолв ссылок, warning-instead-of-throw) включены, RSC-экстрактор не переносится.

## Проверенные факты (не предположения)

- Пакет ставлен как `git:github.com/stargot/pi-extensions` (без пина рефов) в
  `~/.pi/agent/settings.json`; клон — **этот самый каталог**. По `docs/packages.md`:
  при reconciliation pi делает `git reset --hard` + `git clean` в клоне и затем
  `npm install`, если есть `package.json`. Следствия: (а) незакоммиченную работу
  pi может стереть — коммитить рано; (б) новые deps лочатся в **корневом**
  `package.json` в секции `dependencies` (не dev!), pi сам прогонит `npm install`.
- Список расширений — **явные пути** в корневом `pi.extensions`. Переименование
  каталога безопасно только одним атомарным коммитом: `git mv` + правка
  манифеста вместе. Фильтров/отключений ресурсов в settings.json нет (ключа
  `extensions` нет) — мигрировать per-resource state не нужно.
- `package-lock.json` сейчас **untracked**. С появлением реальных deps
  предлагаю его закоммитить (детерминированный `npm install` при reconciliation).
- Baseline: `npm test` → **167 pass / 0 fail** (html/parse/query).
- Версии (npm view, 2026-09-17): linkedom 0.18.13, @mozilla/readability 0.6.0,
  turndown 7.2.4, unpdf 1.8.1.
- `Text` экспортируется из `@earendil-works/pi-tui` (проверено по d.ts);
  `ExtensionAPI` — type-only из `@earendil-works/pi-coding-agent`. Старый импорт
  `@mariozechner/*` из исходника web-fetch **не копировать**.
- `node --test extensions/**/test/*.test.ts` в npm-скрипте работает на этом Node
  (glob разворачивает сам Node) — переезд тестов ничего не ломает.

## Отклонение от исходной фазировки (аргументация)

P0-фиксы (SSRF, стримовый лимит) встраиваются сразу в каркас (фаза 3), а не
отдельной фазой после: это не патчи поверх, а части `http.ts`/`fetcher.ts` —
строить `response.text()`, а потом переписывать на поток — двойная работа.
Вместо фазы «P0-фиксы» появляется фаза-приёмка «чек-лист решений» (задача 10).

## Целевая структура

```
extensions/web/
├── index.ts          ← тонкая точка входа: registerWebSearch(pi) + registerWebFetch(pi)
├── search.ts         ← бывший index.ts (web_search как есть, кроме http-хелперов)
├── http.ts           ← общий: combineSignals, isAbort, sleep, withRetry, readBodyCapped
├── fetch/
│   ├── ssrf.ts       ← чистый гард URL (P0a), без I/O
│   ├── fetcher.ts    ← fetchPage + content-type роутинг + 1 ретрай + оркестрация (P0b внутри)
│   ├── markdown.ts   ← ленивые linkedom+Readability+turndown, isLikelyJSRendered, резолв ссылок
│   ├── pdf.ts        ← порт extractPDF (unpdf лениво, как в исходнике)
│   ├── jina.ts       ← порт Jina-фолбэка
│   └── tool.ts       ← registerWebFetch: схема, execute, renderCall/renderResult
├── html.ts, parse.ts, query.ts   ← без изменений
├── test/             ← старые + новые (node:test, без хоста, стиль query.test.ts)
└── package.json      ← name pi-web, свои dependencies (для standalone pi -e ./extensions/web)
```

Чистая логика (ssrf, markdown-хелперы, readBodyCapped) — отдельно от pi-хоста,
юнит-тесты не импортируют index/tool (правило репо, как query.ts/parse.ts).

---

## Задачи

### Фаза 1 — deps + переименование

**1. `[S]` Установить deps в корень + обновить package.json расширения** (~15 мин)
- Команды (PowerShell, из корня репо):
  `npm install linkedom@^0.18.13 "@mozilla/readability@^0.6.0" turndown@^7.2.4 unpdf@^1.8.1`
  (кавычки на @scope-пакете обязательны). Это добавит корневую секцию
  `dependencies` и обновит package-lock.json.
- `extensions/web-search/package.json` (до переименования): добавить те же
  четыре пакета в `dependencies` (для standalone-использования каталога),
  name пока не менять.
- Решить судьбу package-lock.json: **закоммитить** (рекомендация — см. факты).
- Готово когда: `npm ls linkedom @mozilla/readability turndown unpdf` резолвится;
  `node -e "await import('linkedom')"` из корня — ок; `npm test` — 167 pass.

**2. `[S]` Переименовать каталог атомарно с манифестом** (~10 мин; зависит от 1)
- `git mv extensions/web-search extensions/web`;
  в корневом `package.json` `pi.extensions`: `./extensions/web-search/index.ts`
  → `./extensions/web/index.ts`; в `extensions/web/package.json`: name →
  `pi-web`, description упомянуть оба инструмента, `pi.extensions: ["./index.ts"]`.
- Точечные правки путей в `extensions/web/README.md` (команда `node --test
  extensions/web-search/test/...` → новый путь) и ссылки в корневом `README.md`.
- Один коммит: переименование + манифест вместе (см. факты про резолв путей).
- Готово когда: `npm test` зелёный (glob ловит переехавшие тесты);
  `grep -rn "extensions/web-search" package.json README.md` — пусто;
  рабочий дерево чистое после коммита.

### Фаза 2 — общий http-модуль

**3. `[S]` Создать `extensions/web/http.ts`, перевести web_search на общие хелперы** (~45 мин; зависит от 2)
- В http.ts: `combineSignals(signal, timeoutMs)` (AbortSignal.any +
  AbortSignal.timeout), `isAbort(error)`, `sleep(ms, signal)`,
  `withRetry(fn, { retries, backoffMs, isTransient, signal })`,
  `readBodyCapped(response, maxBytes)` — читает `response.body` потоково
  (for await по чанкам), считает байты, при превышении отменяет чтение
  (reader.cancel) и возвращает структурированную ошибку kind:"too-large";
  content-length не доверяем (P0b).
- `index.ts` → `search.ts` (переименование файла, логика web_search без
  изменений): локальные combineSignals/isAbort/sleep заменить импортом из
  http.ts; ретрай-политика web_search (202/403/429 + challenge, один ретрай)
  **остаётся в search.ts** — её не обобщать.
- Готово когда: новый `test/http.test.ts`: (а) readBodyCapped на fake `Response`
  с ReadableStream — маленький body проходит бит-в-бит, body больше cap режется
  с kind:"too-large"; (б) withRetry: 429→ok делает ровно 1 ретрай, 404 — ни
  одного, ошибка при исчерпании; 167 старых тестов зелёные;
  `npx tsc -p tsconfig.json` чисто.

### Фаза 3 — каркас web_fetch, P0 встроен

**4. `[P]` `fetch/ssrf.ts` + `test/ssrf.test.ts`** (~40 мин; зависит от 3)
- Чистая `assertPublicHttpUrl(url)`: только http/https; hostname-литералы —
  блок-лист: localhost (любой регистр), `*.localhost`, 127.0.0.0/8, 10/8,
  172.16.0.0/12 (только 172.16–172.31!), 192.168/16, 169.254/16 (включая
  169.254.169.254), 0.0.0.0/8, `::1`, `::` (unspecified), fc00::/7,
  IPv4-mapped IPv6 (`::ffff:10.0.0.1` — проверять замапленный v4).
  Не-литеральные имена хостов проходят; DNS-rebinding — known limitation,
  комментарий в коде + строка в CHANGELOG (решение 4a).
- Готово когда: табличный тест — allowed: `https://example.com`,
  `http://172.32.0.1/`; blocked: `http://localhost/`, `http://127.0.0.1/`,
  `http://169.254.169.254/latest/meta-data/`, `http://10.0.0.1/`,
  `http://172.16.0.1/`, `http://192.168.1.1/`, `http://0.0.0.0/`,
  `http://[::1]/`, `http://[fc00::1]/`, `ftp://x/`, `file:///etc/passwd`;
  suite зелёный.

**5. `[P]` `fetch/markdown.ts` + `test/markdown.test.ts`** (~60 мин; зависит от 3)
- Ленивые импорты: `parseHTML` из linkedom и `Readability` — внутри
  `extractArticle(html, baseUrl)`; turndown-инстанс — module-level let,
  инициализируется при первом вызове (конфиг исходника: atx, fenced).
- Turndown-хук резолвит относительные href/src: `new URL(href, baseUrl)`
  (решение 5); baseUrl = `response.url` (финальный URL после редиректов) —
  параметр прокидывается из fetcher.
- Чистые хелперы без deps: `isLikelyJSRendered(html)` (исходник ~строка 315),
  `extractHeadingTitle(markdown)`.
- RSC-экстрактор (extractRSCContent, ~113–312 исходника) **не переносится**
  (решение 3).
- Готово когда: тесты на маленьких inline-HTML: extractArticle возвращает
  {title, markdown}; `<a href="/x">` при базе `https://a.com/b/c` →
  `https://a.com/x` в markdown; `<img src="...">` резолвится;
  isLikelyJSRendered: пустой body + 5 `<script>` → true, обычная статья → false;
  grep по `from "linkedom"` / `from "@mozilla/readability"` / `from "turndown"`
  в extensions/web — 0 статических импортов (только `await import()`).

**6. `[P]` `fetch/pdf.ts`** (~20 мин; зависит от 3)
- Порт `extractPDF` из исходника: ленивый `import("unpdf")`, ленивый
  `node:path` для basename, лимит 100 страниц, метаданные Title/Author,
  заголовок `# title` + `> Source/Pages/Author`, маркер обрезки.
- Юнит-тесты на реальных PDF не пишем (unpdf/pdf.js тяжёлые — см. риски);
  проверка типов + ручной смок (задача 12).
- Готово когда: `npx tsc -p tsconfig.json` чисто; модуль экспортирует
  `extractPdf(buffer, url)` и `isPdfUrl(url, contentType)` (порт isPDF).

**7. `[P]` `fetch/jina.ts` + `test/jina.test.ts`** (~30 мин; зависит от 3)
- Порт `extractWithJinaReader`: `https://r.jina.ai/<url>`, Accept: text/markdown,
  X-No-Cache: true, `AbortSignal.any([AbortSignal.timeout(30_000), toolSignal])`,
  парсинг после `Markdown Content:`, маркеры `Loading...` /
  `Please enable JavaScript` → null, title через extractHeadingTitle.
- fetch подменяемый: параметр `fetchImpl` (по умолчанию globalThis.fetch) —
  тесты без monkey-patching.
- Готово когда: тесты: валидный markdown → результат; без `Markdown Content:`
  → null; страница-маркер → null; fetch кинул / !ok → null (не throw);
  URL передаётся как `https://r.jina.ai/<original>`.

**8. `[S]` `fetch/fetcher.ts` — роутинг, P0, ретраи, оркестрация** (~90 мин; зависит от 3,4,5,6,7)
- `fetchAndExtract(url, signal, deps?)` (deps = injectable fetchImpl/jinaFn для тестов):
  1. `assertPublicHttpUrl` — блок до любого fetch (в т.ч. до Jina);
  2. `fetchPage`: Chrome UA и полный набор заголовков из исходника,
     `combineSignals(signal, 30_000)`, **один** ретрай с backoff ~1.5 с на
     429/5xx/сетевые ошибки (образец — search.ts:36-39,78-91,140-153); 4xx и
     aborts без ретрая; после исчерпания ретрая — ошибка, **Jina не вызывается**
     (решение 5);
  3. `readBodyCapped`: 5 MB для не-PDF, 20 MB для PDF (лимиты исходника),
     кап выбирается до чтения по isPdfUrl;
  4. content-type роутинг (порт extractViaHttp): PDF → pdf.ts; image/audio/
     video/zip/octet-stream → фатальная «unsupported» (тоже без Jina);
     не-HTML → текст как есть + extractHeadingTitle; HTML → markdown.ts;
  5. пустая экстракция (Readability null) или isLikelyJSRendered → **Jina**;
     «content appears incomplete» → **успешный результат с warning в details**,
     не throw (решение 5 — в исходнике контент терялся);
  6. итоговый тип: `FetchOutcome { status: "ok"|"error", url, finalUrl, title,
     content, warning?, errorKind? }`.
- Готово когда: юнит-тесты на fake fetch: 200 HTML → markdown с резолвленными
  ссылками; 429,429 → error, jinaFn вызван 0 раз; 200 + пустой article +
  JS-rendered → jinaFn вызван 1 раз; oversized body → kind:"too-large", Jina 0
  раз; `http://127.0.0.1/` → ошибка SSRF, fetch не вызван; неполный контент →
  status:"ok" c warning.

**9. `[S]` `fetch/tool.ts` + `index.ts` — регистрация второго инструмента** (~45 мин; зависит от 8)
- `registerWebFetch(pi)`: порт registration-блока исходника — Type.Object({url}),
  description/promptSnippet из исходника; execute: error →
  `throw new Error(url + ": " + error)`, ok → заголовок
  `# title\n\nSource: url\n\n---\n\n` + content, details
  {url, finalUrl, title, chars, warning?}; renderCall/renderResult — порт с
  Text из `@earendil-works/pi-tui`; `ExtensionAPI` — type-only из
  `@earendil-works/pi-coding-agent`; при details.warning — значок ⚠ в status.
- `index.ts`: `export default function (pi) { registerWebSearch(pi); registerWebFetch(pi); }`.
- Корневой `package.json`: в script `smoke` добавить `-e ./extensions/web/index.ts`;
  в peerDependencies добавить `"typebox": "*"` (импортируем bundled peer —
  требование docs/packages.md).
- Готово когда: `pi --list-models -e ./extensions/web/index.ts` стартует без
  ошибок загрузки и регистрирует оба инструмента; grep `@mariozechner` в
  extensions/web — пусто; tsc чисто.

### Фаза 4 — приёмка зафиксированных решений

**10. `[S]` Чек-лист решений 1–6 по коду** (~20 мин; зависит от 9)
- Пройти grep-ом: (1) каталог web/, имя pi-web, оба инструмента в одном индексе;
  (2) linkedom/readability/turndown/unpdf — только `await import()`, старт pi их
  не тянет; (3) extractRSCContent отсутствует, isLikelyJSRendered на месте;
  (4) SSRF-блок-лист полный (список задачи 4), стримовый лимит без доверия
  content-length, комментарий про DNS-rebinding; (5) Jina только на пустой
  экстракции, «incomplete» — warning в details, type-only ExtensionAPI из
  @earendil-works; (6) http.ts общий для обоих, заголовки search/fetch свои.
- Готово когда: каждый пункт подтверждён grep/чтением, расхождений нет.

### Фаза 5 — тесты

**11. `[S]` Полный автопрогон** (~10 мин; зависит от 9; параллелен 10)
- `npm test` (167 старых + новые ssrf/http/markdown/jina/fetcher),
  `npx tsc -p tsconfig.json`.
- Готово когда: 0 fail; tsc без ошибок.

**12. `[S]` Ручной смок живым pi** (~30 мин; зависит от 10, 11)
- `pi -e ./extensions/web/index.ts`, затем web_fetch: обычная статья (markdown,
  title, Source); URL на PDF; JS-rendered SPA → Jina-фолбэк сработал;
  `http://127.0.0.1:9/` → SSRF-блок; страница с относительными ссылками →
  абсолютные; большой файл (>5 MB) → внятная ошибка; неполный контент →
  результат + ⚠. web_search — не сломан. Перезапуск pi — старт без ощутимого
  замедления (ленивые импорты).
- Готово когда: чек-лист пройден, вывод приложен к задаче.

### Фаза 6 — документация

**13. `[P]` CHANGELOG.md** (~15 мин; зависит от 9; параллелен 11–12)
- Unreleased: Added — web_fetch (markdown/PDF/текст, Jina-фолбэк, SSRF-гард,
  стримовые лимиты 5/20 MB), пакет переименован в pi-web; Changed — каталог
  web-search → web; известные ограничения: DNS-rebinding out of scope,
  Jina — внешний сервис без гарантий.
- Готово когда: формат Keep a Changelog соблюдён, запись в [Unreleased].

**14. `[P]` README (корневой + extensions/web/README.md)** (~25 мин; зависит от 9; параллелен 11–12)
- Корневой: строка таблицы — пакет `web` с `web_search` + `web_fetch`.
- extensions/web/README.md: секция web_fetch (content-type роутинг, лимиты,
  SSRF, Jina-фолбэк), обновлённые таблицы файлов и тестов, раздел
  «Ограничения» (DNS-rebinding, Jina, RSC не поддерживается).
- Готово когда: все пути в README существуют на диске, таблица файлов
  совпадает с фактической структурой.

**15. `[S]` Финальный коммит и пуш** (~5 мин; зависит от 10–14)
- Гейт пуша — пользователь (по протоколу). После пуша следующая reconciliation
  pi подтянет переименование и deps (`npm install` в клоне) — пользовательских
  настроек не требуется.

---

## Files to Modify

- `package.json` (корень) — pi.extensions путь, dependencies, peerDependencies (+typebox), smoke-скрипт
- `extensions/web-search/` → `extensions/web/` — git mv (задача 2)
- `extensions/web/package.json` — name pi-web, description, pi.extensions, dependencies
- `extensions/web/index.ts` — станет тонкой точкой входа на оба инструмента (содержимое уедет в search.ts)
- `extensions/web/search.ts` — новый файл из бывшего index.ts (общие http-хелперы)
- `README.md`, `CHANGELOG.md`, `extensions/web/README.md` — документация

## New Files

- `extensions/web/http.ts` — общие сетевые хелперы + стримовый size-лимит
- `extensions/web/fetch/ssrf.ts` — SSRF-гард (чистый)
- `extensions/web/fetch/fetcher.ts` — fetchPage + роутинг + ретраи + оркестрация
- `extensions/web/fetch/markdown.ts` — Readability+turndown (лениво), эвристики
- `extensions/web/fetch/pdf.ts` — unpdf-экстракция (лениво)
- `extensions/web/fetch/jina.ts` — Jina Reader-фолбэк
- `extensions/web/fetch/tool.ts` — регистрация web_fetch + рендеры
- `extensions/web/test/http.test.ts`, `test/ssrf.test.ts`, `test/markdown.test.ts`, `test/jina.test.ts`, `test/fetcher.test.ts`

## Verification (всё целиком)

```powershell
cd C:\Users\starg\.pi\agent\git\github.com\stargot\pi-extensions
npm test                                        # 167 старых + все новые, 0 fail
npx tsc -p tsconfig.json                        # без ошибок типов
pi --list-models -e ./extensions/web/index.ts   # оба инструмента регистрируются
# ручной смок задачи 12 — по чек-листу
```
Плюс grep-приёмки из задач 2, 5, 9, 10 (нет статических импортов тяжёлых
пакетов, нет @mariozechner, нет путей extensions/web-search в манифесте).

## Риски и что отложить

- **pi reconciliation стирает незакоммиченное**: этот каталог — живой клон
  пакета; `pi update --extensions` / рестарт с reconciliation делает
  `git reset --hard` + `git clean`. Коммитить после каждой задачи, пуш — по гейту.
- **Окно переименования**: если каталог и манифест разъедутся по коммитам,
  pi не найдёт `./extensions/web-search/index.ts` — задача 2 строго одним коммитом.
- **Jina Reader** — внешний сервис: контент и доступность не гарантированы;
  таймаут 30 с, любая ошибка → null и честная ошибка инструмента. Best-effort.
- **unpdf в тестах тяжёлый** (тянет pdf.js) — ASSUMPTION: заметный размер в
  node_modules и секунды на первый импорт. Юнит-тестов на реальные PDF нет,
  только ручной смок; в рантайме unpdf грузится лениво и только при PDF.
- **Readability поверх linkedom**: известны расхождения с полным DOM на
  сложной разметке (исходник тоже жил на linkedom — поведение совместимо,
  но проверить на живых страницах в смоке задачи 12).
- **DNS-rebinding** — осознанно out of scope (решение 4a), зафиксирован в
  комментарии и CHANGELOG.
- **Дубликат инструмента**: не возвращать `excluded-extensions/web-fetch` в
  зону загрузки — будет второй `web_fetch`.
- ASSUMPTION: `pi -e ./extensions/web/index.ts` корректно регистрирует два
  инструмента из одной точки входа (registerTool дважды — docs это допускают);
  проверяется смоком задачи 9.
- Отложено (сознательно): RSC-экстрактор (решение 3), DNS-rebinding-защита
  (резолв hostname и проверка IP до fetch), кэширование результатов web_fetch,
  поддержка file:// (блокируется гардом).

## Оценка

14 задач + финальный коммит, суммарно ~440–460 мин (~7.5 ч чистого времени).
Критический путь: 1 → 2 → 3 → {4,5,6,7} → 8 → 9 → {10,11,12} → 15.
