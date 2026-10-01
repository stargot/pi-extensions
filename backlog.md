# Backlog: better-ui заимствования (T1–T5 → B1–B9)

Источник: `docs/better-ui-analyse.md`, `~/.pi/agent/forge-report.md`, `~/.pi/agent/ui-scout-report.md`.
Каждая задача = один PR worker'а. Проверенные факты: экспорты `@earendil-works/pi-tui` (Box, VStack, HStack, ScrollView, SelectList, Loader, CancellableLoader, MouseRegion, KeybindingsManager, mixColors, styleText), `Theme.style(text, {fg,bg})`, событие `before_provider_request` (payload: unknown, результат может заменить payload), `ctx.isProjectTrusted()`, `ctx.ui.custom(tui, theme, keybindings, done)` — keybindings-менеджер уже инжектится 3-м аргументом и всеми расширениями игнорируется.

Рекомендуемый порядок: **B1 → {B2 ∥ B3 ∥ B4 ∥ B5 ∥ B9} → {B6 ∥ B7 ∥ B8}**.
Общий гейт каждой задачи: `npm run check` (biome lint + format + tsc + node:test) зелёный.

---

## B1. shared/scroll-report.ts → ScrollView + Box/VStack (drop-in)

**Цель.** Заменить самодельный строчный скроллер на примитивы pi-tui, сохранив публичный API, чтобы session-ledger и context-inspector переехали без правок потребителей.

**Файлы-цели**
- `extensions/shared/scroll-report.ts` — переписать (имя файла и класса сохранить)
- `extensions/shared/test/scroll-report.test.ts` — новый

**Шаги**
1. Прочитать `docs/tui.md` (разделы ScrollView, Box, VStack) и `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/scroll-view.d.ts`, `box.d.ts`, `v-stack.d.ts`.
2. Сохранить API: `ScrollReportOptions{tui, theme, render(width, theme)→string[], onClose, helpSuffix?}` + `invalidate()`. Внутри: строки `render()` → `Text` → `ScrollView`; help-строка и позиция (`n-m/total`) — через `VStack` под вьюпортом.
3. Скролл-клавиши делегировать ScrollView; в `handleInput` перехватывать только q/Esc/Ctrl+C и `r` (invalidate + перерендер). Wheel-scroll должен работать бесплатно (docs/tui.md: «Unhandled wheel events scroll the nearest ScrollView») — проверить в оверлее.
4. Опциональный флаг `border?: boolean` на Box-рамку (по умолчанию off — потребители рисуют свои заголовки).
5. Тесты (node:test, без живого TUI): clamp offset, invalidate сбрасывает кэш ширины, help-суффикс, slice по вьюпорту (мокать терминал duck-typed объектом, как `TuiLike` в graph.ts).

**Критерии приёмки**
- `npm run check` зелёный; новые тесты проходят.
- `npm run stats` (CLI) работает; вручную `/stats` и `/context`: скролл стрелками/jk/PgUp/PgDn/Home/End/g/G, колесо мыши, `r` обновляет, `q`/`Esc` закрывают.
- `grep -rn "new ScrollReport" extensions/` — потребители (`session-ledger/index.ts`, `context-inspector`) не изменились либо минимально.

**Зависимости:** нет. **Оценка: M**

---

## B2. session-recall: SelectList вместо самодельного списка

**Цель.** Заменить ручные выделение/пейджинг `ResultsView` на `SelectList`, оставив двухстрочный хит (заголовок + фрагмент) и подсветку терминов.

**Файлы-цели**
- `extensions/session-recall/view.ts` — переписать `ResultsView` (публичные опции конструктора сохранить)
- `extensions/session-recall/test/search.test.ts` — дописать кейсы маппинга выбора

**Шаги**
1. `docs/tui.md` SelectList + `select-list.d.ts` (`SelectItem`, `SelectListTheme`, лейаут-опции).
2. `ResultsView` композиционно: SelectList с `SelectItem.value = Hit`; рендер primary/secondary через `TruncatedText`, подсветка терминов — существующий `highlight()` из `search.ts`.
3. Клавиши Enter/↑↓/PgUp/PgDn — от SelectList; закрытие q/Esc — через контейнер из B1.
4. Тест: выбор i-го хита вызывает `onSelect(hits[i])`; пейджинг не ломает индексацию.

**Критерии приёмки**
- `npm run check`; вручную `/recall <запрос>`: навигация, Enter открывает выбранный хит, подсветка терминов на месте, `q` закрывает.

**Зависимости:** B1. **Оценка: S**

---

## B3. session-trace: TraceView на Box/ScrollView

**Цель.** Убрать ручные бордеры `"│"`/`"─"` и собственный scroll-offset: Box для карточек, ScrollView для ленты; сохранить live/replay, фильтр `/` и мини-карту.

**Файлы-цели**
- `extensions/session-trace/graph.ts` — крупный рефакторинг (637 строк)
- `extensions/session-trace/index.ts` — минимальные правки передачи опций
- `extensions/session-trace/cli.ts` — убедиться, что `TraceView` в `TuiAltScreen` не сломался (cli.ts:113)

**Шаги**
1. Рамки карточек (graph.ts:467–547) → `Box` с соответствующим border-стилем; чипы инструментов пока как есть (bg-полировка — B8).
2. Свой offset → `ScrollView`; live-режим: автоскролл к хвосту только когда пользователь у низа (иначе не дёргать вьюпорт).
3. Мини-карта — кастомный Component-сосед через `HStack` (2 колонки: силуэт + позиция); логика `KIND_WEIGHT`/`MAP_COLOR` не меняется.
4. Клавиши `space`/`←→`/`+/-`/`l` (replay) и фильтр `/` сохранить в `handleInput`; скролл делегировать ScrollView.
5. Проверить оба входа: оверлей `/trace` (index.ts) и `npm run trace` (cli.ts через `TuiAltScreen`).

**Критерии приёмки**
- `npm run check`; `grep -n '"│"' extensions/session-trace/graph.ts` пуст.
- Вручную: `/trace` (live) скроллится колесом и клавишами, follow работает; `/trace <file>` — replay-клавиши живы; `npm run trace` рендерит в alt-screen.

**Зависимости:** B1. **Оценка: L**

---

## B4. Ledger-модель à la pi-forge: main/nested, hit-rate, em-dash, бары

**Цель.** Честная таблица `/stats`: раздельные main/nested токены, hit-rate из сумм токенов, em-dash при нулевом знаменателе, счётчики битых записей, визуальные бары.

**Файлы-цели**
- `extensions/shared/session-index.ts` — Stats/парсер: nested-агрегация + счётчики
- `extensions/session-ledger/ledger.ts` — проброс nested в Ledger/Row
- `extensions/session-ledger/report.ts` — колонки nested/hit-rate/бар, em-dash
- `extensions/session-ledger/test/ledger.test.ts`, `extensions/shared/test/session-index.test.ts`

**Шаги**
1. Референс — `session-usage.ts` из pi-forge (MIT, 184 строки): `cacheHitRate = cacheRead/(input+cacheRead+cacheWrite)`; агрегация суммированием токенов, не средним %.
2. **ASSUMPTION:** nested = usage из сессий под `sessions/subagents/**` (см. `subagents/running-index.ts`); сверить с реальным JSONL в `~/.pi/agent/sessions` и уточнить определение при необходимости (у pi-forge nested — вызовы моделей внутри tool-выполнения). Добавить `nested: Stats` в `SessionSummary`; `total` = main + nested (обратная совместимость колонок).
3. Счётчики: `unknownUsage` (assistant-сообщение без usage), `invalidFiles` (unparseable/skipped) — в `emptyStats()`/Ledger, вывод в footer/summaryLine.
4. `fmtPercent(null)` → `"—"` (сейчас en-dash `"–"`, report.ts).
5. Бар-колонка: `bar(value, max, width)` через `mixColors` + блочные глифы `▁▂▃▄▅▆▇█`; цвет от `theme.colors.<token>` (guard на отсутствие токена). Вставить в by-project/by-model таблицы.
6. Формула hit-rate уже считается из сумм (`cachePercent`, ledger.ts:86) — оставить с док-комментом «pi-forge-совместимая»; тест на нулевой знаменатель → `—`.

**Критерии приёмки**
- Юнит-тесты: nested-сплит на фикстуре, hit-rate 0/0 → `—`, ширины бара, счётчики unknownUsage/invalidFiles.
- Вручную `/stats`: колонки main/nested, hit-rate, бар; итог сходится с суммой строк.
- `npm run check`.

**Зависимости:** B1 (контейнер отчёта стабилен). **Оценка: M**

---

## B5. Порт line-diff (pure TS)

**Цель.** Самодостаточный модуль построчного диффа из pi-forge (`src/web-editor/line-diff.ts`, MIT) — фундамент для B6.

**Файлы-цели**
- `extensions/shared/line-diff.ts` — новый
- `extensions/shared/test/line-diff.test.ts` — новый

**Шаги**
1. Порт: LCS с бюджетом ~500k клеток (при превышении — fallback на replace-блок), inline-подсветка частей строки, side-by-side rows, сегментация графем через `Intl.Segmenter` (CJK-корректность).
2. Никаких DOM-импортов; раскраску принимать параметром — узкий интерфейс стилизатора (по образцу `Styler` из `session-ledger/report.ts`) или токены темы.
3. API: `diffLines(a: string[], b: string[], opts?) → DiffRow[]` с `type: "equal"|"insert"|"delete"|"modify"` и inline-сегментами.

**Критерии приёмки**
- Юнит-тесты: пустой/полный дифф, inline-modify, графемы (CJK-строка не рвётся), бюджетный fallback; модуль не импортирует pi-coding-agent.
- `npm run check`.

**Зависимости:** нет. **Оценка: S**

---

## B6. Trace: rolling-история ходов + контекст-дифф

**Цель.** Кольцевой буфер последних N=20 ходов (Δтокены, prefix-ratio, changedBlocks) + построчный дифф контекста между соседними ходами в TraceView.

**Файлы-цели**
- `extensions/session-trace/context-history.ts` — новый (+ `test/context-history.test.ts`)
- `extensions/session-trace/graph.ts` — интеграция: режим диффа по клавише `d`
- `extensions/session-trace/session.ts` — извлечение per-turn снапшотов, если текущих Item не хватает
- `extensions/session-trace/README.md` — документация

**Шаги**
1. Снапшот хода: `{turnIndex, ts, model, tokens{input,cacheRead,cacheWrite,output}, messageSignature: (role + первые ~80 символов)[]}` — из данных, которые `session.ts` уже вынимает из JSONL.
2. Референс модели — `context-diff-history.ts`/`context-diff.ts` pi-forge (MIT): ring buffer 20, `deltaTokens`, `prefixRatio = |общий префикс подписей| / |текущих|`, `changedBlocks`.
3. Дифф деталей: для выбранного хода — `diffLines` из B5 над развёрнутыми подписями сообщений prev→curr; рендер в суб-панель (клавиша `d` вкл/выкл, `q`/`Esc` — назад к ленте).
4. Кэш-статус хода: цвет чипа по prefixRatio/hit-rate (accent/warning) — только fg на этом этапе.
5. Тесты: буфер (вытеснение старых), delta/prefix-ratio на фикстурах, empty-diff между одинаковыми ходами.

**Критерии приёмки**
- Юнит-тесты кольцевого буфера и метрик; вручную `/trace` → `d` показывает дифф контекста выбранного хода; `npm run check`.

**Зависимости:** B3, B5. **Оценка: M**

---

## B7. KeybindingsManager вместо зашитых клавиш

**Цель.** Все оверлеи получают клавиши через инжектируемый KeybindingsManager (3-й аргумент `ctx.ui.custom`), help-строки рендерят фактические биндинги.

**Файлы-цели**
- `extensions/shared/scroll-report.ts`, `extensions/session-recall/view.ts`, `extensions/session-trace/graph.ts` — потребление менеджера
- `extensions/shared/keybindings.ts` — новый: декларация кастомных action'ов (declaration merging), хелпер «действие → человекочитаемая клавиша»
- `extensions/session-ledger/index.ts`, `extensions/context-inspector/index.ts` — прокинуть менеджер в конструкторы

**Шаги**
1. `docs/tui.md` (KeybindingsManager) + `keybindings.d.ts`: `getKeys(keybinding)`, `KeybindingsConfig`, «Downstream packages can add keybindings via declaration merging».
2. Завести action'ы расширений (`ext.report.refresh`, `ext.report.close`, `ext.trace.filter`…) с дефолтами `q`/`r`/`/`; при отсутствии в менеджере — guard-фоллбэк на текущие литералы.
3. В `ctx.ui.custom((tui, theme, keybindings, done) => …)` передавать менеджер в компоненты; убрать `_keybindings`-игнор.
4. Help-строка из B1 собирается через `getKeys()` (человекочитаемый рендер KeyId); суффиксы аргументов не трогать.

**Критерии приёмки**
- `grep -rn 'data === "q"' extensions/` — только fallback-ветки; оверлеи работают как раньше; кастомный биндинг (фикстура конфига в тесте) подхватывается.
- `npm run check`.

**Зависимости:** B1, B2, B3 (вьюхи консолидированы). **Оценка: M**

---

## B8. Полировка: Loader для индексации + bg-чипы

**Цель.** Холодный `/stats` не выглядит зависшим (CancellableLoader), чипы/бейджи получают подложки через `theme.style({fg,bg})`.

**Файлы-цели**
- `extensions/session-ledger/index.ts` — async-build + Loader
- `extensions/session-ledger/report.ts`, `extensions/session-trace/graph.ts` — bg-чипы

**Шаги**
1. `build()` → асинхронный: оверлей открывается сразу с `CancellableLoader` («indexing sessions…»), тяжёлый `refreshSharedIndex` — после yield (`setImmediate`/чанкинг), затем подмена на отчёт; Esc отменяет. CLI-путь не менять.
2. Чипы: `theme.style(text, { fg: …, bg: "toolSuccessBg" | "toolErrorBg" | … })` — **ASSUMPTION:** имена bg-токенов сверить с `docs/themes.md` и `ThemeToken` в `theme.d.ts`; на отсутствующий токен — guard-фоллбэк на fg-only (`theme.colors` как источник конкретных цветов).
3. Покрыть: totals-строку ledger, tool-чипы trace; хелпер `chip()` — в shared.

**Критерии приёмки**
- Вручную: при холодном кэше `/stats` показывает лоадер, затем таблицу; Esc во время индексации закрывает.
- Юнит: рендер чипа содержит bg-escape при наличии токена и не падает без него. `npm run check`.

**Зависимости:** B1; trace-чипы — после B3. **Оценка: S**

---

## B9. Новое расширение payload-capture (arm-once)

**Цель.** «Перехвати следующий provider-запрос один раз»: arm-команда, захват payload через `before_provider_request`, redaction credential-полей, опциональное сохранение только в trusted-проекте, статус-чип.

**Файлы-цели**
- `extensions/payload-capture/index.ts`, `state.ts`, `redact.ts` — новые
- `extensions/payload-capture/test/payload.test.ts` — новый
- `package.json` — добавить в `pi.extensions`
- `extensions/payload-capture/README.md` — приватность и команды

**Шаги**
1. Референс — `payload-command.ts`/`payload-state.ts`/`payload-capture.ts` pi-forge (MIT).
2. `state.ts`: `{armed: boolean, save: boolean, lastCapture?: {ts, model, payload}}`.
3. Команда `/payload`: без аргументов — help; `arm [--save]` → armed (+save), `ctx.ui.setStatus("payload-capture", "payload:armed"|"payload:armed+save")` (accent/warning), notify; `show` → последний захват в `ctx.ui.editor`; `clear` → сброс и снятие чипа (`setStatus(key, undefined)`).
4. `pi.on("before_provider_request", handler)`: если armed → глубокая копия `event.payload`, disarm, обновить чип; **никогда** не менять payload (возвращать undefined).
5. `redact.ts` (pure, тестируемый): рекурсивный проход; маскировать поля по `/key|token|secret|credential|authorization|api[-_]?key/i` → `"***"`; лимиты глубины/размера (~2 МБ, усечение с пометкой).
6. Сохранение: только при `--save` **и** `ctx.isProjectTrusted()`; путь `join(getAgentDir(), "cache", "payload-captures", "<ts>-<model>.json")` — никогда не в cwd проекта.
7. Зарегистрировать в `pi.extensions` (package.json); прогнать `npm run smoke`.

**Критерии приёмки**
- Юнит-тесты: redaction (вложенные credential-поля замаскированы, остальные нет), arm-once (второй запрос не захватывается), save-гейт (не trusted / без `--save` → файла нет).
- Вручную: `/payload arm` → чип в статус-баре → следующий ход агента → `/payload show` показывает замаскированный JSON в редакторе.
- `npm run check` + `npm run smoke`.

**Зависимости:** нет. **Оценка: M**

---

## Non-goals (сознательно не делаем)

- **Contribution port** (версионируемый JSON-RPC настроек между расширениями) — effort L, отложен по анализу.
- **Перенос Vue-компонентов / веб-редактора pi-forge** — непереносимо в pi-tui; наш `session-trace/web/` (app.js, serve.ts) не трогаем.
- **Иерархический trace-tree/span-дерево в терминале** — у pi-forge его нет; в этой итерации не строим.
- **MouseRegion/клики в trace** — сверх бесплатного wheel-scroll от ScrollView; отложено.
- **i18n, перестройка alt-screen, замена мини-карты** — вне скоупа.
- **Замена парсера `session.ts` / типизация `e: any`** — отдельная техническая работа, не UI.

## Риски

- pi-forge прибит к pi `0.87.x` — берём идеи и pure-модули (MIT), не пакет; сверять поверхности API с нашей версией pi на каждом шаге.
- 0.x-дрейф: nested-usage contract экспериментальный (см. ASSUMPTION в B4).
- Приватность: B6 (дифф-история в памяти) и B9 (payload-захваты) — redaction/trust-гейты обязательны, дефолт — ничего не сохранять.
- B3/B6 — самый сложный UI-код (graph.ts, 637 строк): делать строго после B1, мелкими коммитами внутри PR.
