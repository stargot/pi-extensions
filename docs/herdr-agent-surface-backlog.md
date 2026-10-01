# BACKLOG: subagents × herdr agent-surface (узкий скоуп)

Дата: 2026-10-01 · Статус: план к исполнению (worker-задачи, 6 штук)
Цель: три точки интеграции расширения `extensions/subagents/` с нативным
agent-surface herdr — (1) доставка `subagent_message` через `herdr agent prompt`,
(2) `herdr agent wait --until done` как дополнительный сигнал завершения ребёнка
рядом с существующим вотчером (вотчер НЕ заменяется), (3) `herdr agent rename`
для стабильных имён панелей. Пункт TODO про native blocked — отложен (см. T6).

## 0. Проверенные факты

Архитектура (scout, file:line):

- Выбор поверхности: `selectBackend` (mux.ts:39-44) — `HERDR_ENV === "1"` выигрывает
  у `WEZTERM_PANE`; все обращения к herdr — через `herdr` CLI (`runHerdr` = execFileSync,
  herdr.ts:62-64; проба `herdr --version` кешируется, herdr.ts:41-56).
- Спавн: `pane split` → `parseSplitPaneId` → `launchScript` = `pane run` с pwsh-лаунчером
  (splitPane, herdr.ts:196-226). `sendText` = `pane run <id> <text>` — единственный
  вызов в steer-пути (index.ts:1067); interrupt = `pane send-keys esc|ctrl+c`.
- Steer: `subagent_message` (index.ts:1054-1078) → `resolveInterrupt` (shared.ts:66-73) →
  опц. Esc + `sleep(INTERRUPT_SETTLE_MS=1200)` → `sendText`. Ошибки доставки уже
  превращаются в tool error с расшифровкой (стиль «pane … is already gone»).
- Вотчер: `pollTick` (index.ts:530-595), тик 1 c (`POLL_INTERVAL_MS`, index.ts:101),
  цепочка: `.done` сайдкар → `.exit` сайдкар (`classifyExitSidecar`, shared.ts:42-60) →
  панель исчезла → сентинел на экране (`readScreenTail`) → cancel grace. Все пути
  завершения проходят через `completeSubagent` (index.ts:361) — единая точка для
  kill-логики. `RunningSubagent` — index.ts:152-169.
- Реестр имён рестарт-стойкий (registry.ts, `<artifacts>/<sessionId>/subagent-registry.json`);
  имена субагентов уникальны в пределах родительской сессии (`uniqueName` против
  running+registry, index.ts:714-715); `doResume` (index.ts:820+) переиспользует живую
  панель или создаёт новую.
- Гейт: `npm run check` (biome + tsc + `node --test extensions/**/test/*.test.ts`).
  `*.manual.ts` в тестовый glob не попадают. Парсеры herdr тестируются чисто, на
  зафиксированных JSON-фикстурах живых ответов (прецедент `SPLIT_OK`/`LIST_OK` в
  test/herdr.test.ts).

Agent-surface (researcher, живые прогоны herdr 0.9.1-preview, протокол 22):

- `herdr agent prompt <TARGET> <TEXT> [--wait] [--until <S>] [--timeout <MS>]` — JSON-вывод;
  агент уже blocked → отказ `agent_blocked` ДО отправки текста; `--wait` из non-working
  требует наблюдаемого working|blocked в течение 5000 мс, иначе `agent_prompt_stalled`;
  без флагов ждёт первого settled idle|done|blocked (минуты!); `--timeout` истёк → `timeout`.
- `herdr agent wait <TARGET> [--until <S>]… [--timeout <MS>]` — settled = idle|working|
  blocked|done|unknown; без `--timeout` — бесконечно; exit 0/1/2.
- `TARGET` = имя `[a-z][a-z0-9_-]{0,31}` ИЛИ pane id — безымянные панели адресуются по
  pane id (проверено: `agent get w1P:p4` → exit 0).
- `herdr agent rename <target> <name>|--clear`; `herdr agent list` — JSON с
  agent_status, pane_id, agent_session.

## Зафиксированные решения (не пересматривать)

- Ветвление только в herdr-бэкенде (herdr.ts); WezTerm-код (wezterm.ts) не меняется —
  новые операции диспетчеризуются в mux.ts, wezterm-реализация = существующий `sendText`
  либо no-op. Существующий вотчер (тик 1 с, сайдкары, сентинел) остаётся источником истины.
- ADR-1 (семантика доставки): `agent prompt <paneId> <text> --wait --timeout 15000`,
  TARGET — всегда pane id (не имя). Fire-and-forget отклонён: отказ `agent_blocked`
  происходит ДО отправки — сообщение пропало бы молча, что хуже текущего `pane run`.
  `--wait` даёт наблюдаемое подтверждение (ребёнок увиден working) либо явный код сбоя
  (`agent_blocked` / `agent_prompt_stalled` / `timeout` / `agent_not_found`) → tool error
  с расшифровкой по образцу существующей. Worst case — блокировка tool-вызова 15 с,
  приемлемо для steer. Esc-ветка (`interrupt`) без изменений, идёт до доставки.
- ADR-2 (встраивание agent wait): один фоновый waiter-процесс на субагента, запускается
  при спавне: `herdr agent wait <paneId> --until done` (без --timeout, detached,
  windowsHide, unref). Exit 0 → in-process флаг `nativeDoneAt` на `RunningSubagent`.
  pollTick CLI не вызывает вовсе — только читает флаг (нулевой оверхед на тик); новый
  шаг между `.exit`-сайдкаром и «панель исчезла»: флаг старше `NATIVE_DONE_GRACE_MS=5000`
  → `completeSubagent({ exitCode: 0 }, note "native done, sidecar lost")`. Грейс
  закрывает гонку «pi вышел, лаунчер ещё не записал .done». Отклонено: poll `agent list`
  каждый тик (процесс в секунду) и блокирующий `wait` внутри тика (замораживает вотчер).
- ADR-3 (rename): сразу после `pane split` и ДО `pane run` (внутри splitPane herdr.ts),
  чтобы имя было верным с первого кадра. Лейбл = `herdrAgentName(name)`: lowercase,
  не-`[a-z0-9]` → `-`, схлопывание дефисов, обрезка 32, первый символ приводится к
  `[a-z]` (иначе префикс `a-`), пусто → `subagent`. Отказ/коллизия → один ретрай с
  суффиксом `-<id8>`, затем молча сдаться: вся адресация и так по pane id, rename —
  косметика. `doResume` переименовывает повторно используемую/новую панель тем же
  лейблом. `--clear` не используем (панели схлопываются после завершения).

## Задачи

### T1 [S] herdr.ts: примитивы agent-surface + чистые парсеры
- Файлы: `extensions/subagents/herdr.ts`, `extensions/subagents/test/herdr.test.ts`.
- Шаг 0 (обязательный): внутри herdr зафиксировать живые образцы `agent prompt` (ok и
  blocked-отказ), `agent rename`, `agent get` — они становятся тестовыми фикстурами
  (прецедент `SPLIT_OK`).
- Добавить: `spawn` из node:child_process; тип `AgentPromptOutcome`
  (`"delivered" | "refused_blocked" | "stalled" | "timeout" | "not_found" | "error"`);
  чистый `parseAgentPromptOutput(out, exitCode)` — дефенсивный разбор JSON;
  `promptAgent(paneId, text, timeoutMs = 15_000)` — `runHerdr(["agent","prompt",paneId,
  text,"--wait","--timeout",String(timeoutMs)])` в try/catch, никогда не бросает;
  чистый санитайзер `herdrAgentName(raw)`; best-effort `renameAgent(paneId, name): boolean`.
- Критерий: herdr.test.ts покрывает фикстуры prompt (delivered + blocked) и rename,
  таблицу санитайзера (кириллица, верхний регистр, >32, цифра в начале, пусто);
  `npm run check` зелёный.

### T2 [S] Доставка steer через `agent prompt`
- Файлы: `extensions/subagents/mux.ts`, `extensions/subagents/shared.ts`,
  `extensions/subagents/index.ts`, `extensions/subagents/test/shared.test.ts`.
- `shared.ts`: чистая `describePromptFailure(outcome, name)` → человекочитаемый текст
  (blocked → «субагент ждёт ввода, сообщение НЕ доставлено — ответь на его вопрос или
  пошли с interrupt:true»; stalled → «ребёнок не показал working после доставки»;
  timeout/not_found/error — аналогично) + тесты.
- `mux.ts`: `deliverMessage(paneId, text): { ok: boolean; outcome?: AgentPromptOutcome }`
  — herdr → `promptAgent`, иначе существующий `sendText` (wezterm.ts не трогаем).
- `index.ts` (subagent_message, ~1054-1078): `sendText` → `deliverMessage`; outcome
  ≠ delivered → `throw new Error(describePromptFailure(...))`; успех — прежний ответ.
- Критерий: тесты describePromptFailure; `npm run check`; grep подтверждает, что
  прямых вызовов herdr-специфики в index.ts нет.

### T3 [S] `agent rename` — стабильные лейблы панелей
- Файлы: `extensions/subagents/herdr.ts` (CreatePaneOptions + splitPane),
  `extensions/subagents/mux.ts` (CreatePaneOptions.label + `labelPane`),
  `extensions/subagents/index.ts` (spawn ~735-760, doResume ~860-880).
- `CreatePaneOptions.label?: string`; splitPane вызывает `renameAgent` после
  `parseSplitPaneId` и до `launchScript`; ретрай `-<id8>` при отказе (логика в месте
  вызова). mux: `labelPane(paneId, label)` — herdr → renameAgent, wezterm → no-op.
  spawn передаёт `label: herdrAgentName(name)`; doResume — `labelPane` по тому же
  лейблу после (ре)создания панели.
- Критерий: `npm run check`; живая проверка внутри herdr (опционально, в T5 покрывается
  e2e): `herdr agent list` показывает лейбл у панели субагента.

### T4 [S] `agent wait` — фоновый native-сигнал завершения
- Файлы: `extensions/subagents/herdr.ts` (`spawnDoneWaiter(paneId): ChildProcess`),
  `extensions/subagents/index.ts` (RunningSubagent + pollTick + completeSubagent + spawn).
- `spawnDoneWaiter`: `spawn(HERDR, ["agent","wait",paneId,"--until","done"], stdio ignore,
  windowsHide)`, unref. Живая проба перед выбором статуса: `agent get` на панели с уже
  вышедшим pi — если её статус `unknown` (pi вышел, pwsh -NoExit жив), добавить `unknown`
  в `--until`; waiter стартует с задержкой ~10 с от спавна (чтобы pi успел
  распознаться и не отдать unknown раньше времени).
- index.ts: поле `nativeDoneAt?: number` на RunningSubagent; обработчик exit(0) ставит
  флаг; pollTick — шаг между `.exit` и «панель исчезла» по ADR-2; `completeSubagent`
  убивает waiter (все пути завершения через него).
- Критерий: `npm run check`; живой прогон — после естественного завершения ребёнка
  результат приходит от основных путей, waiter не ломает тайминги и не висит после
  completeSubagent.

### T5 [P] e2e-herdr.manual.ts — сценарии agent-surface
- Файлы: `extensions/subagents/test/e2e-herdr.manual.ts`.
- Добавить шаги 7-9: (7) спавн с `label` → `herdr agent get <paneId>` / `agent list`
  показывает ожидаемое имя; (8) фейковый ребёнок перед записью `.done` держит
  длительный `Start-Sleep` → `promptAgent` возвращает структурированный outcome
  (любой из перечня, без необработанного исключения); (9) `spawnDoneWaiter` поднимается
  и корректно убивается.
- Критерий: ручной прогон внутри herdr (HERDR_ENV=1) печатает `E2E_OK`; файл по-прежнему
  вне npm-test glob (`npm run check` зелёный).

### T6 [P] Документация
- Файлы: `docs/TODO.md`, `extensions/subagents/README.md`, `CHANGELOG.md`.
- TODO.md: переписать единственный пункт — prompt/wait/rename сделаны (ссылка на этот
  backlog); blocked — «отложено: нативный blocked-эмиттер для pi в herdr 0.9.1 не
  работает (herdr:blocked не найден), собственный socket-эмиттер делать не будем».
- README.md: таблица «Поверхности» + строки для agent prompt / agent wait / agent
  rename, короткий раздел agent-surface со сводкой ADR-1..3.
- CHANGELOG.md: секция `## [Unreleased]` (сейчас её нет, последняя — 0.4.0) → Added.
- Критерий: grep находит записи во всех трёх файлах; `npm run check` зелёный.

## Порядок и параллельность

T1 → T2 → T3 → T4 → { T5 ∥ T6 }. T1–T4 линейны: все трогают herdr.ts и/или index.ts
(разные участки, но один файл на воркер-сессию — без merge-рисков). T5 и T6 независимы
и параллелятся после T4. Гейт каждой задачи — `npm run check`; T1 и T4 дополнительно
требуют живой herdr (worker-сессия внутри HERDR_ENV=1) для фиксации образцов/проб.

## Риски

- ASSUMPTION: точные ключи JSON-ответов `agent prompt`/`agent rename` и exit-коды ошибок
  (по паттерну 1) не верифицированы вживую — поэтому T1 начинается с фиксации живых
  образцов, а парсеры дефенсивные (garbage → `error`, не бросают).
- ASSUMPTION: статус панели с вышедшим pi, но живым pwsh (`-NoExit`) — `unknown`, а не
  `done`; T4 обязан проверить это живым `agent get` и подобрать `--until` по факту.
- `--wait` добавляет до 15 с блокировки tool-вызова steer при медленном ребёнке —
  осознанный компромисс ADR-1; при желании later — конфиг-constant.
- Коллизии rename между двумя родительскими сессиями (обе спавнят «scout») — best-effort
  по ADR-3: ретрай с суффиксом, затем отказ от лейбла; на адресацию не влияет.
- herdr младше/старше 0.9.1 может дрейфовать по shape ответов — существующие парсеры уже
  толерантны к дрейфу (прецедент parsePaneListIds), новые пишутся так же.
