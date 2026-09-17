# web — веб-инструменты для pi: поиск и fetch

Пакет `pi-web`, два инструмента:

- `web_search` — полнотекстовый веб-поиск через HTML-endpoint DuckDuckGo.
  Без ключей, без квот, со структурированными аргументами (базовый запрос +
  точные фразы + исключения + сайт).
- `web_fetch` — fetch URL → чистый markdown: HTML-статьи (Readability +
  Turndown), PDF, plain text; Jina Reader-фолбэк для JS-rendered страниц,
  SSRF-гард и стримовые лимиты чтения.

Основа — расширение **web-search** автора **Eero Alvar
([amosblomqvist](https://github.com/amosblomqvist))** из
[pi-config](https://github.com/amosblomqvist/pi-config/tree/main/extensions/web-search),
использовавшее Google Custom Search API. Эта версия вместо него ходит на
DuckDuckGo (`html.duckduckgo.com/html/`): тот же контракт инструмента, но
без учётных данных; плюс таймаут, ретрай на бот-чек, отдельный парсер и тесты.

## Использование

```
web_search({
  query: "postgres skip locked",        // базовый запрос
  exactPhrases: ["FOR UPDATE SKIP"],    // станут "точными фразами"
  excludeTerms: ["mysql", "sqlite 3"],  // -mysql -"sqlite 3"
  site: "stackoverflow.com",            // site:stackoverflow.com
  count: 5,                             // 1..10, по умолчанию 5
})
```

Один вызов — один угол поиска: не собирай несколько запросов в один вызов,
точные фразы передавай через `exactPhrases`, а не кавычками внутри `query`.

## Как это работает

- **Запрос** строится в чистом `query.ts` (без зависимостей — полностью покрыт
  тестами): нормализация `site`, экранирование кавычек, склейка операторов.
- **Сеть**: POST form-encoded на `html.duckduckgo.com/html/` с полным набором
  браузерных заголовков (GET и голый UA получают 403/202 бот-чек). Таймаут 20 с
  (`AbortSignal.timeout`), один ретрай с паузой 1.5 с на транзиентные ответы
  (202/403/429/challenge-page). Отмена инструмента пробрасывается сразу.
- **Парсинг** (`parse.ts` + `html.ts`): `div.result` → `a.result__a` (заголовок +
  редирект-обёртка `//duckduckgo.com/l/?uddg=<encoded>` разворачивается обратно
  в целевой URL) + `a.result__snippet`.
- В `details` возвращается составленный запрос, счётчик результатов и время
  выполнения; рендереры показывают запрос при вызове и «N results in Xs» при
  результате (раскрытие — превью выдачи).

## web_fetch

```
web_fetch({
  url: "https://example.com/post",     // URL для загрузки
})
```

Загружает страницу и извлекает читаемый контент как чистый markdown.
Ошибки пробрасываются как tool-error; в `details` — `url`, `finalUrl`
(после редиректов), `title`, `chars` и `warning` (значок ⚠ в статусе),
когда контент может быть неполным.

- **Роутинг по content-type** (`fetch/fetcher.ts`): HTML → статья через
  linkedom + Readability + turndown (atx-заголовки, fenced-код; все три
  пакета импортируются лениво — старт pi их не тянет); PDF
  (`application/pdf` или `.pdf`-URL) → текст через unpdf, до 100 страниц,
  дальше маркер обрезки, Title/Author из метаданных; не-HTML (текст и
  прочее) → как есть, заголовок из первой `#`-строки;
  image/audio/video/zip/octet-stream → честная ошибка «unsupported».
- **Редиректы** следуются вручную (`redirect: "manual"`): цель каждого
  хопа заново проходит SSRF-гард до запроса — redirect-rebinding
  (публичный URL, редиректящий в private-сеть) закрыт. Бюджет — 5
  запросов на попытку; исчерпание лимита, невалидный или заблокированный
  hop — ошибка «redirect» без ретрая. `finalUrl` — URL последнего хопа.
- **Лимиты чтения**: body читается стримово и режется по реально увиденным
  байтам — content-length не доверяется; кап 5 MB для страниц, 20 MB для
  PDF (выбирается до чтения первого байта).
- **SSRF-гард** (`fetch/ssrf.ts`, чистый, до любого fetch — включая Jina):
  только http/https; блок-лист литералов — localhost и `*.localhost`,
  127.0.0.0/8, 10/8, 172.16/12 (строго 172.16–172.31), 192.168/16,
  169.254/16 (включая облачные метаданные 169.254.169.254), 0.0.0.0/8,
  IPv6 `::1`, `::`, fc00::/7 и IPv4-mapped-адреса; сокращённые формы
  (`127.1`, hex) канонизирует WHATWG-парсер до проверки.
- **Jina Reader-фолбэк** (`fetch/jina.ts`): только когда прямая экстракция
  пуста (Readability не нашёл статью) или страница похожа на JS-rendered
  (`fetch/markdown.ts`: мало видимого текста + много `<script>`): запрос
  на `r.jina.ai/<url>` (30 с, `Accept: text/markdown`); любой сбой → null,
  и инструмент вернёт честную ошибку с подсказками. Транспортные сбои
  (исчерпан ретрай, прочие 4xx) до Jina не доходят.
- **Ретрай и ссылки**: один ретрай с паузой ~1.5 с на 429/5xx и сетевые
  ошибки; прочие 4xx и отмена — сразу. Относительные `href`/`src` статьи
  резолвятся против финального URL после редиректов; нересолвимые проходят
  как есть.

## Файлы

| Файл | Роль |
|---|---|
| `index.ts` | Точка входа пакета: регистрирует `web_search` и `web_fetch` |
| `search.ts` | Инструмент `web_search`: схема, сеть, ретрай, рендереры |
| `http.ts` | Общие сетевые хелперы: `combineSignals`, `sleep`, `withRetry`, `readBodyCapped` (стримовый size-лимит) |
| `fetch/ssrf.ts` | Чистый SSRF-гард `assertPublicHttpUrl` (без I/O) |
| `fetch/fetcher.ts` | Оркестрация `fetchAndExtract`: ретрай, роутинг content-type, капы, Jina-фолбэк |
| `fetch/markdown.ts` | HTML→markdown: ленивые linkedom+Readability+turndown, резолв ссылок, эвристика JS-rendered |
| `fetch/pdf.ts` | PDF-экстракция: ленивый unpdf, лимит 100 страниц, метаданные |
| `fetch/jina.ts` | Jina Reader-фолбэк (`r.jina.ai`) |
| `fetch/tool.ts` | Инструмент `web_fetch`: схема, execute, рендереры |
| `query.ts` | Чистая логика построения запроса `web_search` (без зависимостей) |
| `html.ts` | Мини HTML-парсер без зависимостей (селекторы `tag.class`, `getAttribute`, `textContent`) |
| `parse.ts` | Парсер выдачи DuckDuckGo поверх `html.ts` |
| `test/` | Юнит-тесты чистых модулей + фикстура выдачи DuckDuckGo |

## Тесты

```bash
node --test extensions/web/test/*.test.ts   # 93 теста
```

| Файл | Тестов | Покрывает |
|---|---|---|
| `query.test.ts` | 9 | построение запроса |
| `html.test.ts` | 16 | HTML-парсер |
| `parse.test.ts` | 4 | парсер выдачи (+ фикстура `fixtures/ddg-sample.html`) |
| `http.test.ts` | 16 | `combineSignals` / `sleep` / `withRetry` / `readBodyCapped` |
| `ssrf.test.ts` | 4 | блок-лист и нормализация URL |
| `markdown.test.ts` | 14 | экстракция статьи, резолв ссылок, эвристики |
| `jina.test.ts` | 10 | фолбэк на подменяемом `fetchImpl` |
| `fetcher.test.ts` | 20 | оркестрация: роутинг, ретраи, капы, редиректы, фолбэк |

Тесты не импортируют `index.ts`/`tool.ts` (правило репо: чистая логика —
отдельно от pi-хоста), сеть в тестах подменяется.

## Ограничения

- **DNS-rebinding**: гард проверяет литералы адресов, но не резолвит
  DNS-имена — перепроверка IP до fetch осознанно не делалась (в модуле
  нет I/O). Redirect-rebinding при этом закрыт: редиректы следуются
  вручную, и цель каждого хопа заново проходит гард.
- **Jina Reader — внешний сервис** (`r.jina.ai`): доступность и качество
  не гарантированы, фолбэк строго best-effort.
- **RSC/Next.js**: payload React Server Components напрямую не извлекается
  (экстрактор не переносился) — такие страницы идут через Jina или
  возвращают честную ошибку.
- **PDF**: путь требует unpdf (тянет pdf.js) — грузится лениво, только при
  первом PDF; документы длиннее 100 страниц обрезаются.
