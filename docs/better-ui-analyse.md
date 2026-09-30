# better-ui-analyse: pi-forge vs наши ledger/trace

Сводка двух исследований (researcher: pi-forge, scout: наши UI-расширения). Исходные отчёты:
`~/.pi/agent/forge-report.md`, `~/.pi/agent/ui-scout-report.md`.

## Главный вывод

«Красота» pi-forge — **не терминальный UI**. Его терминальная сторона сознательно тонкая
(только `ctx.ui.notify/setStatus/editor` + `theme.fg`). Вся тяжёлая UI — **локальный веб-редактор**:
Node-сервер (`web-host.ts`, 893 стр., REST + token-auth) + Vue 3/Vite SPA (~17 компонентов, polling).
Т.е. наш `session-trace` с его веб-вьюером (`web/app.js`, canvas-граф, зум, плейхед, live-polling)
уже играет в той же лиге — сопоставление «pi-forge vs наш TUI» это apples-to-oranges.

Ценность pi-forge для нас — **модель данных и информационный дизайн**, а не компоненты
(Vue-компоненты в pi-tui непереносимы). Переносимы pure-TS модули: `session-usage.ts` (184 стр.),
`line-diff.ts`, `context-diff*.ts` — без DOM-импортов. Лицензия MIT.

## Что наши расширения делают «по-кустарному»

Все оверлеи через `ctx.ui.custom` + самодельный `shared/scroll-report.ts` (95 стр., string[]),
ручные бордеры из `"│"`, ручное выравнивание таблиц padEnd/padStart, зашитые клавиши,
только `theme.fg` (никаких bg-подложек — чипы выглядят плоско).

При этом pi-tui имеет и **не используется ни одним расширением**: `ScrollView`, `Box`,
`VStack`/`HStack`, `SelectList`, `SettingsList`, `Loader`/`CancellableLoader`, `MouseRegion`
(мышь!), `KeybindingsManager`, `Markdown`, `TruncatedText`, `theme.style({fg,bg,bold})`,
`mixColors`, оверлеи с якорями/анимацией.

## План заимствований (по убыванию эффекта)

| # | Что | Источник | Effort | Эффект |
|---|---|---|---|---|
| T1 | Заменить `shared/scroll-report.ts` на `ScrollView`+`Box`/`VStack`; обновить ledger, trace, recall, context-inspector разом | pi-tui primitives | M | 3-4 расширения сразу получают скролл/бордеры/выделение |
| T2 | Ledger-модель à la pi-forge: main/nested usage раздельно, `cacheHitRate = cacheRead/(input+cacheRead+cacheWrite)`, суммирование токенов (не среднее %), em-dash при нулевом знаменателе, счётчики битых записей + спарклайны/бары через `mixColors` + блочные глифы | `session-usage.ts` | S–M | таблица /stats становится честной и читаемой |
| T3 | Trace: rolling-история ходов (кольцевой буфер N=20: Δтокены, prefix-ratio, changedBlocks) + построчный контекст-дифф | `context-diff-history.ts`, `context-diff.ts`, `line-diff.ts` (pure TS: LCS 500k budget, Intl.Segmenter) | M | «что изменилось в промпте за ход» — то, чего у нас нет вовсе |
| T4 | Полировка: `KeybindingsManager` вместо зашитых `q/r/j/k`, `Loader` для индексации сессий, `theme.style` с bg-токенами для чипов | pi-tui / themes.md | S | тактильно «дороже» выглядит |
| T5 | Нoвая фича: arm-once перехват следующего provider-запроса с redaction credential-полей, trust-проверкой, статус-чипом `armed` | `payload-command.ts`, `payload-state.ts`, `payload-capture.ts` | S–M | дешёвый debug-UX, у нас аналога нет |

Бонусы (по желанию): статус-чипы `setStatus` по одному на фичу; contribution port (JSON-RPC
между расширениями для общих панелей настроек) — effort L, отложить.

## Риски

- pi-forge прибит к pi `>=0.87.0 <0.88.0` — но мы переносим идеи/pure-модули (MIT), не пакет.
- 0.x-проект, nested-usage contract экспериментальный.
- Приватность: payload-захваты и diff-история содержат контент переписки — нужны те же guard'ы
  (redaction, trust).
- Иерархического span/trace-дерева в pi-forge НЕТ — если нужен терминальный trace-tree, строим
  сами поверх pi-tui, взяв у них только модель данных.

## Start here

`extensions/session-trace/graph.ts` (637 стр.) — главный кандидат на перевод на примитивы;
`extensions/shared/scroll-report.ts` — точка замены, обновляющая три расширения сразу.
