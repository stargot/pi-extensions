# Backlog: better-ui заимствования (T1–T5 → B1–B9)

Источник: `docs/better-ui-analyse.md`, `~/.pi/agent/forge-report.md`, `~/.pi/agent/ui-scout-report.md`.
Каждая задача = один PR worker'а. Проверенные факты: экспорты `@earendil-works/pi-tui` (Box, VStack, HStack, ScrollView, SelectList, Loader, CancellableLoader, MouseRegion, KeybindingsManager, mixColors, styleText), `Theme.style(text, {fg,bg})`, событие `before_provider_request` (payload: unknown, результат может заменить payload), `ctx.isProjectTrusted()`, `ctx.ui.custom(tui, theme, keybindings, done)` — keybindings-менеджер уже инжектится 3-м аргументом и всеми расширениями игнорируется.

Рекомендуемый порядок: **B1 → {B2 ∥ B3 ∥ B4 ∥ B5 ∥ B9} → {B6 ∥ B7 ∥ B8}**.
Общий гейт каждой задачи: `npm run check` (biome lint + format + tsc + node:test) зелёный.

> **Статус (2026-10-02):** B1–B9 реализованы и закрыты релизами 0.4.0–0.6.0. B4 (nested-модель
> ledger) реализована в 0.5.0: `session-ledger/report.ts` (nested-колонки, em-dash, бары),
> `shared/session-index.ts` (`nested`/`isNested`, `INDEX_VERSION = 2`).
> Активный план — **«Релиз 0.7.0 — pi 1.0.0»** ниже; B-секции ниже — архив.

---

## Релиз 0.7.0 — pi 1.0.0 (активный)

> **Статус (2026-10-02):** R0–R8 выполнены; центральные гейты зелёные (596/596 тестов,
> smoke exit 0). Открыт R9 — ручной fullscreen-чеклист (гейт пользователя).

Контекст: хост pi обновился 0.85.1 → 1.0.0 (0.86.0, 0.87.0, 0.99.0–0.99.2, 1.0.0; релизов
0.88–0.98 не было). Совместимость уже проверена эмпирически: boot-smoke 13/13 расширений ✓,
`tsc` против типов 1.0.0 — 0 ошибок ✓, `npm run check` — 584/584 ✓; node_modules уже на
pi-coding-agent/pi-tui 1.0.0. Type surface 1.0.0 чисто аддитивный, pi-tui component API
не изменился. `shouldStopAfterTurn`, присваивания `state.messages`, удалённые из pi-tui
функции — не используются (проверено grep'ами).

Зависимости: **R0 → {R1 ∥ R2 ∥ R3 ∥ R4} → R5 → R6 → R7 → R8 → R9.**
Общий гейт каждой задачи: `npm run check` зелёный; `npm run smoke` — после R4, R6, R8.
Scope-решение пользователя: adoption новых API — НЕ в 0.7.0 (см. секцию 0.8+ в конце файла).

### R1. shared/session-index.ts — формат сессий 1.0.0 `[P]`
**Файлы:** `extensions/shared/session-index.ts`, `extensions/shared/test/session-index.test.ts`.
Фикстуры: `{"type":"context_edit","targetId":…,"replacement":null}` и с replacement-content;
компакция retain-none (`"summary":null,"firstKeptEntryId":null`). Поведение: context_edit
молча пропускается (в recall/ledger не индексируем — задокументировать комментарием);
null-summary компакция учитывает `compactions`/usage; индекс не крэшится и не
невалидируется. Если в `~/.pi/agent/sessions` есть реальная 1.0.0-сессия — сверить форму
записей. **Готово:** новые тесты зелёные, `npm run check` зелёный.

### R2. context-inspector — retain-none + context_edit `[P]`
**Файлы:** `extensions/context-inspector/analyze.ts` (~строки 226–236),
`extensions/context-inspector/test/analyze.test.ts`. Реальная точка отказа: при retain-none
`buildContextEntries()` возвращает compaction-запись с `summary: null`, а `estimate(...) `/`
preview(...)` на ней крэшат → `/context` падает. Фикс: `entry.summary ?? ""` + guard в
`preview`. СНАЧАЛА верифицировать ASSUMPTION: читая
`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`, проверить,
применяет ли `buildContextEntries` context_edit; если НЕТ — применить в `analyzeEntries`
(replacement null → исключить вклад targetId; content → подменить вклад) с комментарием-ссылкой.
**Готово:** тесты null-summary + context_edit зелёные, `/context` на retain-none сессии не падает.

### R3. session-trace — маркер context_edit `[P]`
**Файлы:** `extensions/session-trace/session.ts` (switch в `feedEntry`, после case
branch_summary), `extensions/session-trace/test/session.test.ts`. `case "context_edit"` →
маркер «✎» (targetId коротко + cleared/replaced); регресс-тесты на null-summary
(сейчас парсер к ним устойчив: `?? "branch"`, стр. 169–178 — зафиксировать тестами).
**Готово:** тесты зелёные, replay сессии с context_edit показывает маркер.

### R4. Housekeeping пакета `[P]`
**Файлы:** `package.json`. peerDependencies `@earendil-works/pi-coding-agent` и
`@earendil-works/pi-tui`: `*` → `^1.0.0` (typebox оставить `*`); engines node
`>=22.18` → `>=22.19.0` (требование pi 1.0.0); убедиться, что хост-пакеты не в dependencies
(pi 0.99+ предупреждает warning'ом). package-lock.json уже обновлён под 1.0.0 — коммиты
структурируются в R8, worker не коммитит. **Готово:** `npm run smoke` + `npm run check` зелёные.

### R5. Аудит цветов (статический проход) `[S]`
`extensions/session-trace/cli.ts:135,138` — единственный raw ANSI вне тестов (CLI-путь со
своим styler без Theme; решить: оставить с комментарием или pi-tui colors/styleText — решение
задокументировать); `extensions/shared/chip.ts` — fg-only деградация под system-темой.
Остальные ~240 вхождений — theme.fg/theme.bg, они поддержаны в 1.0.0 — НЕ переписывать;
выборочно пометить сомнительные для визуальной проверки R9 (список дописать в backlog).
**Готово:** raw ANSI вне cli.ts нет (или решение задокументировано), `npm run check` зелёный.

#### Результаты R5: пункты для визуальной проверки в R9

Решение по `cli.ts:135,138`: **оставлен raw ANSI**, задокументировано комментарием в коде
(fallbackTheme живёт вне TUI/Theme; базовые bright-коды SGR 90–97 резолвит сам терминал —
цвета следуют пользовательской палитре; перевод на styleText потребовал бы фикс. RGB
(Color-объектов) и сменил бы поведение при большем диффе). Guard fg-only деградации в
`shared/chip.ts` уже был (нет токена / нет метода bg / Theme.bg бросает) и покрыт тестами —
без изменений. Офф-палитровых токенов не найдено: все литеральные и динамические
theme.fg/theme.bg в 11 файлах входят в ThemeColor/ThemeBg pi 1.0.0.

Для визуальной проверки в R9 (темы dark/light/system):
1. `subagents/render.ts:47–57` (verdictChip) и `:61` (errorLine) — контраст fg/bg-пар
   `warning` на `toolPendingBg` и `error` на `toolErrorBg` (в system-теме, выведенной из
   палитры терминала, warning может слиться с подложкой).
2. `quiz/index.ts:919` — чекбокс «I don't know» при checked красится в `warning`, тогда
   как все остальные checked-чекбоксы того же диалога — `success` (строки 910, 927;
   ask-user-question:505). Проверить, что жёлтый [x] читается как осмысленный статус.
3. `quiz/index.ts:910` и `ask-user-question/index.ts:486` — строка Submit: цвет всей строки
   зависит не от её собственного состояния, а от `selected.size > 0` (success/dim) —
   success-цвет для «кнопка стала доступной» читается спорно, проверить.
4. `session-trace/cli.ts:134–156` (fallbackTheme, raw ANSI) — фиксированные bright-коды
   рассчитаны на тёмный терминал: `wrap("97")` (ярко-белый текст) и `wrap("37")` нечитаемы
   на светлом фоне; CLI не опрашивает палитру терминала и вне system-темы.
5. `session-trace/graph.ts:51–58,154` (MAP_COLOR) — токены валидны, но `t→dim` и faint-рендер:
   силуэт мини-карты может стать неразличимым при светлой теме; заодно проверить заметность
   ▐-индикатора вьюпорта (`accent`) на фоне цветных ▪.
6. `prompt-snippets/index.ts:112,115` — prepend ↑ = `accent`, append ↓ = `warning`: warning
   для штатного действия append выглядит как тревога (не баг, но проверить восприятие).

#### R6: ручной fullscreen-чеклист (R9)

Итог код-аудита R6: реальный fullscreen-баг один — `TraceView` рендерил ровно
`terminal.rows` строк, а fullscreen-хост pi держит над editor-dock минимум 1 строку
транскрипта (chat-viewport, transcript `minSize: 1`) → footer /trace (позиция + подсказки)
обрезался всегда. Фикс: `reserveRows` (graph.ts; `/trace` передаёт `tui.mode === "fullscreen"
? 1 : 0`), единый расчёт тела в render/atTail/PgDn + тесты `session-trace/test/graph.test.ts`.
Остальные зоны чисты: ask-user-question/quiz — широтно-кэшированный render, без абсолютных
рядов и своей мыши; quiz web-режим изолирован от TUI (свой FIFO, без shared-lock); recall
SelectList и scroll-report читают `terminal.rows` live и резервируют строку запаса; cli.ts
(свой `TuiAltScreen`, view — layout root) от tuiMode хоста не зависит.

Как гонять (каждый пункт): pi 1.0.0, темы dark/light/system (`/theme`); открыть оверлей →
клавиши → колесо над оверлеем и вне его → resize терминала (расширить/сузить, минимум
~25×10) при открытом → выход (q/Esc) → повторное открытие. Один прогон каждого оверлея —
при `tuiMode: "regular"` в settings.json: мышь остаётся терминалу (колесо скроллит
scrollback, оверлей — только клавиатура), это норма, но ничего не должно крэшиться.
Диагностика рендера — `PI_TUI_WRITE_LOG`.

1. **ask-user-question** (тул `ask_user_question`; text-режим идёт в `ctx.ui.editor`).
   Single-select: ↑↓/Enter/Esc; Other → editor (Enter submit, Esc back). Multi-select:
   Space/Enter toggle, Submit блокируется до первого выбора (warning-строка), Other.
   R5-п.3: цвет строки Submit зависит от `selected.size` (success/dim), а не от её
   собственного фокуса — проверить читаемость. Узкий терминал (~25 строк): длинный
   вопрос + 5 опций с описаниями — низ оверлея (подсказка/рамка) может срезаться
   (косметика хоста, оценить критичность).
2. **quiz** (тул `quiz`; `/quiz-web on|off|auto`). TUI: ↑↓, n/Tab — note-поле (Ctrl+J —
   перенос строки; в live-цепочке WezTerm→herdr Tab может не доходить — тогда работает
   «n»), Enter — ответ, feedback (✓/✗ + correct + explanation), Enter/Esc — закрыть.
   R5-п.2: checked «I don't know» — warning-жёлтый [x] против success у остальных.
   R5-п.3: цвет Submit от `selected.size`. Web: `/quiz-web on` → вопрос в браузере, TUI
   свободен (колесо скроллит transcript — не баг), URL в транскрипте; таймаут
   `PI_QUIZ_WEB_TIMEOUT_MS`; Esc (abort) снимает web-вопрос; `/quiz-web off` — назад в TUI.
3. **session-recall** (`/recall <запрос>`, пустой — диалог ввода). Список: ↑↓/j/k/
   PgUp/PgDn/Home/End/g/G, Enter; подсветка термов (warning bold) в обеих темах; колесо
   над списком двигает выделение (SelectList), вне — transcript. Enter → Show full
   (ScrollReport: скролл, `r`, позиция n-m/total, колесо) / Insert snippet / Switch session.
   Resize при открытом списке: pageSize фиксируется на момент открытия — при сильном
   уменьшении высоты нижняя подсказка может срезаться (known cosmetic; навигация не
   должна ломаться — подтвердить).
4. **session-trace** (`/trace` live, `/trace <file>` replay, CLI `npm run trace [-r]`).
   Live: бейдж LIVE ●; ↑↓ (по 3), PgUp/PgDn, Home/End, `f` follow; колесо над лентой
   скроллит, у хвоста вниз возвращает LIVE, вверх — отлипает; колесо НЕ должно крутить
   transcript за оверлеем. Фильтр `/` (ввод, enter, esc-сброс), n/N — прыжки по
   совпадениям, `e` — только ошибки, `m` — сводка моделей, `d` — контекст-дифф (↑↓ ход,
   PgUp/PgDn, выход d/Esc/q), Esc — снять фильтры, повторный — выход. **Footer (позиция
   n/total + подсказки) в fullscreen обязан быть виден — это регресс-тест фикса R6.**
   Replay: space пауза, ←→ seek ±5s, `+`/`-` скорость, `l` live, `r` restart, бейджи
   ▶/PAUSED/END. R5-п.5: мини-карта на светлой теме (силуэт dim/faint) и заметность
   ▐-вьюпорта. Resize при открытом /trace: header/footer/тело перестраиваются без
   артефактов. CLI: R5-п.4 — фиксированные bright-ANSI на светлом фоне (known,
   решение задокументировано); esc/q — выход; колесо в alt-screen скроллит ленту.
5. **shared/scroll-report** (`/stats`, `/context`, `npm run stats`, /recall Show full):
   ↑↓ j k PgUp/PgDn Space Home End g G, `r` — refresh, q/Esc/Ctrl+C — закрыть; колесо
   крутит только вьюпорт отчёта; позиция n-m/total в help-строке; resize по высоте
   меняет вьюпорт live, по ширине — перерендер без артефактов ширины.
6. **Прочие dock/панели** (санити, вкл. R5-пункты): subagents-панели (R5-п.1: verdictChip
   warning на toolPendingBg, error на toolErrorBg, errorLine — контраст в system-теме);
   prompt-snippets `alt+s` (R5-п.6: ↑ accent / ↓ warning — восприятие); `/payload arm|show`,
   `/handoff`, `/audit` — открыть/закрыть, скролл, resize, темы.

### R6. Аудит fullscreen-оверлеев `[S]`
Код-проверка (и правки при находках) предположений о не-fullscreen (жёсткие ряды/высота,
alt-screen, render editor-оверлея): ask-user-question (Editor overlay), quiz (overlay +
web-режим), session-recall (SelectList + мышь), session-trace (graph ScrollView + мышь;
cli.ts `TuiAltScreen`), shared/scroll-report (мышь). pi 1.0.0: fullscreen — дефолт
(`tuiMode: "regular"` — откат), `fullscreenWheelScrollLines` поддерживает `"auto"`.
Составить ручной чеклист (оверлей × клавиши/мышь × темы dark/light/system) и записать сюда.
**Готово:** аудит проведён (находка одна: footer /trace срезался в fullscreen — фикс
`reserveRows`, тесты graph.test.ts); чеклист — «R6: ручной fullscreen-чеклист (R9)» выше;
lint/format/tsc чисто, тесты затронутых расширений 153/153, smoke 13/13 ✓.

### R7. Документация `[S]`
**Файлы:** `README.md`, `CHANGELOG.md`. README: секция «Совместимость» (pi ≥ 1.0.0,
node ≥ 22.19; fullscreen и тема system — дефолты pi 1.0.0, расширения проверены).
CHANGELOG: `[0.7.0]` — Fixed: парсеры формата 1.0.0, retain-none крэш `/context`;
Changed: peerDeps ^1.0.0, engines, аудит UI. Дата — Unreleased (проставит R8).

### R8. Подготовка релиза `[S]`
`package.json` version → 0.7.0; дата в CHANGELOG 0.7.0; финальные check+smoke;
коммиты по логике: парсеры / housekeeping / UI / docs / release.

### R9. Ручной fullscreen-чеклист + приёмка (гейт пользователя)
Пройти чеклист из R6 в живом pi 1.0.0 (fullscreen): `/stats`, `/context`, `/recall`, `/trace`
(live, replay, `d`, CLI `npm run trace`), ask-user-question, quiz (+`/quiz-web`), `alt+s`
snippets, `/payload arm|show`, subagents-панели, `/handoff`, `/audit` — в темах
dark/light/system, мышь и скролл. Тег/push — отдельный гейт пользователя после приёмки.
Замечания → fix-задачи → снова worker.

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

---

## 0.8+ Adoption новых API pi 1.0.0 (будущее, НЕ в 0.7.0)

Кандидаты из CHANGELOG/доков pi 1.0.0 (0.86.0–1.0.0); рекомендуемый порядок — снизу вверх,
брать по одному, каждый с собственным исследованием поверх docs/ 1.0.0:

1. **tool exposure/namespace/annotations** — `direct`/`model-only`/`codemode`/`deferred`/`hidden`,
   MCP-style `readOnlyHint`/`destructiveHint` для permission-гейтов; docs/extensions.md#tool-exposure.
2. **`ctx.executeTool(name, args, {signal, onUpdate})`** — вложенные вызовы инструментов
   (например, web-инструменты поверх общего механизма).
3. **`outputSchema` + `structuredContent`** — структурированные результаты для codemode-скриптов.
4. **`appendContextEdit(entryId, null | entry)`** — memory-style правки контекста без изменения
   raw history (кандидат: context-inspector, session-handoff).
5. **`provider_stream_event`** — отладка стриминга (кандидат: session-trace).
6. Мелочь по случаю: unsubscribe, возвращаемый `pi.on()`; `fullscreenWheelScrollLines: "auto"`;
   виртуальные модели (`pi.registerVirtualModel`, референс jev-router.ts).
