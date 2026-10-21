# План исполнения: слияние prime-protocol в subagents

- **Статус:** готов к исполнению
- **Дата:** 2026-10-21
- **Основание:** `docs/specs/2026-10-21-prime-subagents-merge-adr.md` (ADR прошёл adversarial review)
- **Привязка номеров строк:** HEAD `8676cc1` (2026-10-19). Перед врезкой worker обязан
  сверить якорь по содержимому (grep по имени функции/комментария), а не слепо по номеру.
- **Формат:** каждый шаг — самостоятельная worker-задача (worker не видит этот разговор и
  ADR не перечитывает: всё нужное продублировано здесь). Один шаг = один коммит.
  После каждого шага `npm run check` зелёный.

## Общие правила для всех worker'ов (сводка §10 ADR — дословно обязательна)

- Не менять: константы `BASE_LOOKUP_ALLOWANCE=3` / `PER_DISPATCH_ALLOWANCE=3` /
  `FILE_TURN_LIMIT=3` и их имена; тексты block-reason'ов; порядок guard'ов в
  `before_agent_start` (env → append → selectedTools → armed); trace-записи
  `trace:subagents`; регистрацию инструментов и команд `/subagent`, `/workers`;
  `subagent-done.ts` и `readonly-guard.ts`.
- Границы модулей: подписки и команды — только в `index.ts`; `prime.ts` не импортирует
  pi-runtime (только `import type`) и не трогает fs напрямую (только через `PrimeDeps`);
  `prime-protocol.ts` — без pi-импортов и без fs.
- Все ui-выходы prime (notify, banner, виджет) — за `ctx.hasUI` / `ctx.mode !== "tui"`
  guard'ами, как в текущем коде: headless/RPC-сессии не получают ui-вызовов.
- Один читатель пула: `discoverAgents` (`extensions/subagents/agents.ts`); никакого
  `readdirSync` по agents/ вне `agents.ts`.
- Персистентность режима — только `<cwd>/.pi/prime.json`; в pi `settings.json` ничего не пишем.
- Существующие 257 тестов subagents не регрессируют (кроме плановых правок `agents.test.ts`).

---

## Шаг 0 — runbook пользователя (до кода, не worker-задача)

Если локальная копия `~/.pi/agent/extensions/prime-protocol.ts` существует — удалить/отключить
её ДО включения слитого кода (иначе двойная инъекция и двойные бюджеты). На момент ADR файл
отсутствует.
**Приёмка:** `pi config` не показывает prime-protocol дважды.

---

## Шаг 1 — `agents.ts`: поле `dispatch`

**Цель:** `AgentDef` получает булево поле `dispatch` (default `true`), парсится в
`parseAgentMarkdown` по образцу `readonly`. Поведение остальных модулей не меняется.

**Файлы:**
- `extensions/subagents/agents.ts` — изменить:
  - в `interface AgentDef` (после поля `readonly`, ~строка 47) добавить
    `/** `dispatch: false` — роль не попадает в dispatch-таблицу prime. */ dispatch: boolean;`
  - в `parseAgentMarkdown` в возвращаемом объекте (~строки 148–160) добавить
    `dispatch: AUTO_EXIT_TRUE.has(attrs["dispatch"]?.trim().toLowerCase() ?? "")` — семантика
    как у `dispatchTargets` в старом `extensions/prime-protocol/protocol.ts:78`:
    `dispatch: false` (и `"false"`) → `false`; отсутствие ключа/`true` → `true`.
    Значения вне true/false трактовать как `true` (fail-open, как `readonly`).
  - ключ `dispatch` уже есть в `KNOWN_KEYS` — предупреждение не появится.
- `extensions/subagents/test/agents.test.ts` — расширить: `dispatch: false` → `false`;
  `dispatch: "false"` (в кавычках) → `false`; отсутствие ключа → `true`; `dispatch: true` → `true`.

**Приёмка:** `npm run check` зелёный; ни один модуль вне `agents.ts` не изменён.
**Commit:** `feat(subagents): parse dispatch frontmatter key into AgentDef`

---

## Шаг 2 — перенос pure-модуля `prime-protocol.ts`

**Цель:** создать `extensions/subagents/prime-protocol.ts` (контракт §5 ADR) и его тесты.
Старое расширение `extensions/prime-protocol/` в этом шаге НЕ трогается — оно ещё активно и
работает по-старому (временное дублирование кода, не поведения).

**Файлы:**
- Создать `extensions/subagents/prime-protocol.ts`. Перенести из
  `extensions/prime-protocol/protocol.ts` дословно (только имена/сигнатуры по контракту):
  `cell`, `buildBudgetRule`, `isChildAppend`, `asInput`, `spawnAgents`,
  `shellLooksLikeLookup`, `shellWriteTargets` (включая `SPAWN_TOOLS`, `SHELL_READERS`,
  `GIT_READERS`). Импорт shell-helpers тот же: `../shared/shell.ts` (глубина каталогов
  совпадает — путь не меняется).
- НЕ переносить: `readIfExists`, `splitFrontmatter`, `dispatchTargets`, `knownAgentBodies`
  (их роли заберут `agents.ts`/`prime.ts` в шаге 3; старые копии живут в старом расширении
  до шага 4).
- `buildDispatchTable` — переписать на новый контракт:

  ```ts
  export interface DispatchRow { name: string; description: string }
  /** Пустой пул → "". Колонки: Role | Purpose. Сортировка по name (localeCompare). */
  export function buildDispatchTable(rows: DispatchRow[]): string
  ```

  Тело — из старой `buildDispatchTable`/`dispatchTargets` (`protocol.ts:85-107`) с дельтами:
  вход уже готовые строки; сортировка `rows.sort((a,b) => a.name.localeCompare(b.name))`
  переезжает внутрь; колонка Model убирается — заголовок `| Role | Purpose |`, строка
  `| ${cell(name)} | ${cell(description || "—")} |`; пустой массив → `""`; шапка
  `## Dispatch table` + строка «Generated from the live agent pool» — сохранить
  (в тексте шапки убрать `~/.pi/agent/agents/`-привязку: пул теперь объединённый —
  написать «the live agent pool»).
- Создать `extensions/subagents/test/prime-protocol.test.ts` — адаптация
  `extensions/prime-protocol/test/protocol.test.ts` (маппинг ниже). Хелперы
  `makeAgentsDir`/`withAgentsDir` нужны только кейсам фильтрации пула — они переезжают в
  `prime.test.ts` (шаг 3), здесь удалить.

**Приёмка:** `npm run check` зелёный (257 + 19 адаптированных); `npm run smoke` зелёный.
**Commit:** `refactor(subagents): add pure prime-protocol module with dispatch table builder`

---

## Шаг 3 — переключение: `prime.ts` + врезка в `index.ts` (атомарно, один коммит)

**Цель:** policy-модуль `prime.ts` активен, hook-слой и команды — в `index.ts`
(ADR-4), toggle `/prime on|off|status` с файлом `<cwd>/.pi/prime.json`, и **одновременно**
снимается entry `./extensions/prime-protocol/index.ts` из `pi.extensions`. Разделять
нельзя — иначе два активных enforcement-слоя. `npm run check` и `npm run smoke` зелёные.

### 3a. Создать `extensions/subagents/prime.ts`

Контракт — §5 ADR; реализация — перенос `extensions/prime-protocol/index.ts:100-329` в
фабрику `createPrimePolicy(deps: PrimeDeps): PrimePolicy`. Переносится: `Turn`/`Stats`
и `emptyTurn`/`emptyStats`, `LOOKUP_TOOLS`, `EDIT_TOOLS`, константы 3/3/3 (литералами,
имена сохранить), `lookupAllowance`, `banner`, `statusLine`, `claimFiles`, вся логика
обработчиков и тексты block-reason'ов — дословно. Дельты против старого кода:

- Pi-runtime не импортируется: `getAgentDir`, `readIfExists`, чтение `settings.json`
  уходят в `PrimeDeps` (их передаёт index.ts). Разрешён только `import type` для типов
  событий/контекста.
- Пул: `deps.agents()` → `Map<string, AgentDef>`; dispatch-пул = все defs минус
  самоисключение prime по обоим признакам (`def.name === "prime"` ИЛИ `basename(def.path)
  === "prime.md"` — как `protocol.ts:68`, OR-семантика) минус `dispatch === false`;
  `DispatchRow[]` = `{ name, description }`; тело протокола = `def.body` того же Map
  (def с именем `prime` из объединённого пула: проектный переопределяет глобальный).
- `isChildAppend(append, bodies)`: `bodies` = `new Set(pool.values().map(d => d.body))`
  из того же `deps.agents()`.
- Toggle (ADR-2): чтение через `deps.readState(stateFile)` на `onSessionStart`, каждом
  `onBeforeAgentStart` и в `/prime`; absent → `enabled=true` молча; error
  (файл есть, но нечитаем/невалиден) → keep-last-known-good сессии (стартует `true`),
  одноразовый notify, виджет `⚡ Prime · unknown (broken .pi/prime.json)`. Запись —
  только в `onPrimeCommand("on"|"off")`, через `deps.writeState`; ошибка записи бросается
  вызывающему → notify об ошибке, режим не меняется. Реальные fs-реализации
  `readState`/`writeState` (tmp+rename, tmp-суффикс с pid/sessionId) живут в `index.ts`.
- off-семантика (ADR-2, все 6 пунктов): `onBeforeAgentStart` без override; `onToolCall` →
  `undefined` немедленно, счётчики не ведутся; `onToolResult`-статистика не ведётся;
  banner подавлен; инструменты/команды механики не трогаются; trace не меняется.
  `/solo` в off-режиме → notify «Prime выключен — сначала /prime on», состояние не меняет.
- Порядок guard'ов в `onBeforeAgentStart` — дословно: env (`PI_SUBAGENT_SESSION`) →
  append (`isChildAppend`) → selectedTools → `armed = true`. Toggle-проверка — строго
  ПОСЛЕ guard'ов и после `armed` (guard'ы имеют приоритет над toggle, инвариант I1).
  В `onToolCall`: `if (!armed || isChild() || !enabled) return undefined;` — тот же порядок.
- Уточнение к сигнатурам §5 (ADR сам делегирует точные типы planner'у): методам, которые
  выводят ui или читают событие, передаются аргументы —
  `onSessionStart(ctx)`, `onUserMessageStart(event, ctx)`, `onToolResult(event, ctx)`
  (виджет), `onBeforeAgentStart(event)` — как в старом коде. Остальное по §5.
- Виджет: ключ `prime-status`, `placement: "belowEditor"`, `try/catch` fail-safe —
  дословно из старого `drawWidget`; ui-выходы за `ctx.mode !== "tui"` / `ctx.hasUI`.

### 3b. Врезка в `extensions/subagents/index.ts`

- Импорт: рядом с `./agents.ts` (строка 39) — `import { createPrimePolicy } from "./prime.ts";`
- Фабрика: сразу после `latestPi = pi;` (строка 659) — один вызов `createPrimePolicy`
  с реальными deps: `agents: () => discoverAgents(latestCtx?.cwd ?? process.cwd(), getAgentDir())`;
  `stateFile: join(process.cwd(), ".pi", "prime.json")`; `model` — перенос `readSessionModel()`
  из `prime-protocol/index.ts:100-110` (читает `join(getAgentDir(), "settings.json")`,
  `defaultModel`, последний сегмент пути; getAgentDir — pi-runtime, потому живёт в index.ts);
  `readState`/`writeState` — реальные fs-функции (чтение с классификацией ok/absent/error;
  запись tmp+rename с уникальным суффиксом, ошибка бросается).
- Подписки — все в одном месте, сразу после блока `pi.on("session_shutdown", …)`
  (строки 668–677), до комментария `// ── Tool: subagent ──` (строка 679):
  - `session_start` (строка 661) — расширяется: в существующий обработчик добавить
    `prime.onSessionStart(ctx)`;
  - `pi.on("message_start", …)` — новая подписка, делегирует `prime.onUserMessageStart(event, ctx)`;
  - `pi.on("tool_call", …)` — делегирует `prime.onToolCall(event)`, возвращает результат
    (`{ block: true; reason }` или `undefined`);
  - `pi.on("tool_result", …)` — делегирует `prime.onToolResult(event, ctx)`;
  - `pi.on("before_agent_start", …)` — делегирует `prime.onBeforeAgentStart(event)`,
    возвращает override или `undefined`.
  Инвариант I6: это единственные подписки этих событий в main-сессии (сейчас в index.ts
  их нет — проверено grep'ом по HEAD 8676cc1).
- Команды — после блока `/workers` (строка 1480), до комментария
  `// ── Renderer for results ──` (строка 1529):
  - `pi.registerCommand("prime", …)` — делегирует `prime.onPrimeCommand(args, ctx)`;
    описание: on/off/status-переключатель prime-политики;
  - `pi.registerCommand("solo", …)` — делегирует `prime.onSoloCommand(args, ctx)`;
    описание перенести из старого `prime-protocol/index.ts:177-179`.
- В `session_shutdown` для prime ничего не добавлять (паритет: у старого расширения
  обработчика нет).

### 3c. Снять entry (в том же коммите)

`package.json`: удалить строку 45 `"./extensions/prime-protocol/index.ts"` из
`pi.extensions` (каталог расширения физически удаляется только в шаге 4 — файлы остаются,
но не грузятся).

### 3d. Тесты

- Создать `extensions/subagents/test/prime.test.ts` — полный список кейсов §7:
  - **toggle/файл**: файл отсутствует → on, молча; файл без ключа `enabled` → on;
    invalid JSON при предыдущем `off` → last-known-good (off), одноразовый notify, виджет
    `unknown (broken .pi/prime.json)`; invalid при старте сессии (нет предыдущего
    значения) → on; `{enabled:false}` → off; `writeState`-депа вызывается с tmp+rename
    (мок проверяет уникальность tmp-суффикса при двух вызовах); ошибка записи бросается
    и режим не меняется; неизвестные ключи в файле игнорируются.
  - **off-семантика**: `onToolCall` не блокирует 10-й лукап подряд и 10-й файл;
    `onBeforeAgentStart` → `undefined`; banner/notify не вызываются.
  - **on-паритет** (перенос старых кейсов): 3-й лукап проходит, 4-й блок с дословным
    reason; повторное чтение того же файла бесплатно; +3 за успешный диспатч, за
    ошибочный (`isError`) — нет; файл-кап 3 с его сообщением; shell-записи считаются
    в файл-кап; `task_batch` tasks+chain дают надбавку за каждый шаг; `/solo N`
    переопределяет кап, сброс на новом user message; `/solo off` снимает всё.
  - **пул**: самоисключение prime по frontmatter-имени (файл `orchestrator.md` с
    `name: prime`) И по basename (`prime.md` с другим frontmatter-именем) — оба теста
    переносятся из `protocol.test.ts`; `dispatch:false` исключается; проектный агент
    виден в таблице.
  - deps — моки/инжекты, отдельный tmp-каталог на тест (по образцу dependency-free
    тестов `agents.test.ts`/`registry.test.ts`).
- `extensions/subagents/test/prime-protocol.test.ts` — уже создан в шаге 2.

### 3e. Ручной e2e-чеклист (из §6 ADR, дословно)

- on-паритет: banner при первом сообщении; 4-й лукап хода блокируется, 3-й проходит;
  успешный `subagent`-спавн поднимает кап на 3; повторное чтение того же файла бесплатно;
  4-й файл блокируется; `/solo 10` пропускает 10; `/solo off` снимает всё до следующего
  сообщения; ребёнок (`/subagent`) без инъекции и без блокировок; `task_batch` chain
  даёт надбавку за каждый шаг;
- off: `/prime off` → следующий ход без протокола (видно в `/context` или по поведению),
  лукапы/едиты не блокируются, `subagent`-тул доступен; `/solo` в off отвечает
  подсказкой; после перезапуска pi режим off сохранён (файл).

**Приёмка:** `npm run check` и `npm run smoke` зелёные; e2e-чеклист 3e пройден руками;
grep по `index.ts` показывает ровно по одному обработчику `message_start`/`tool_call`/
`tool_result`/`before_agent_start`.
**Commit:** `feat(subagents): merge prime policy into subagents with /prime toggle`

---

## Шаг 4 — гигиена: удаление старого расширения, docs, CHANGELOG

**Цель:** `extensions/prime-protocol/` больше не существует, документация отражает слияние.

**Файлы:**
- Удалить целиком каталог `extensions/prime-protocol/` (`index.ts`, `protocol.ts`,
  `test/protocol.test.ts`, `README.md`).
- `extensions/subagents/README.md` — добавить раздел «Prime policy»: инъекция протокола,
  бюджеты 3/3/3, `/prime on|off|status`, `/solo`, `.pi/prime.json` (контракт
  `{ "enabled": boolean }`, absent → on, broken → last-known-good), child-семантика
  (дети никогда не инжектятся/не блокируются), принятый риск ложного main-детекта при
  append, совпадающем с телом проектного агента.
- `CHANGELOG.md` — Unreleased (minor): −1 расширение prime-protocol, +`/prime`, таблица
  без Model из объединённого пула (санкционированная дельта).
- `docs/RESEARCH.md:75` — конвенция `PI_SUBAGENT_SESSION` теперь внутренняя для
  subagents (правку согласовать с формулировкой ADR §8 «расхождение child-detect»).
- Grep по `prime-protocol` в `docs/`, остальных README, `scripts/`: исторические
  упоминания (CHANGELOG, старые записи docs) оставить, живые ссылки на расширение
  поправить.

**Приёмка:** `npm run check` зелёный;
`grep -r "prime-protocol" extensions/ scripts/ package.json` — пусто; в `docs/` и
CHANGELOG остаются только исторические упоминания.
**Commit:** `refactor(subagents): remove the prime-protocol extension, update docs`

---

## Маппинг тестов: 19 тестов `prime-protocol/test/protocol.test.ts` → судьба

| # | Тест (имя) | Судьба |
|---|---|---|
| 1 | `dispatchTargets: every agent file except prime, sorted by name` | переписан: сортировка теперь внутри `buildDispatchTable(DispatchRow[])` — вход вразнобой, проверка порядка по имени |
| 2 | `dispatchTargets: dispatch: false opts out, name falls back to file name` | фильтрация `dispatch:false` → кейс пула в `prime.test.ts`; fallback имени — поведение `agents.ts`, покрыто `agents.test.ts` (шаг 1) |
| 3 | `dispatchTargets: self excluded by frontmatter name even when the file is named differently` | → `prime.test.ts` (кейс пула: self-exclusion по frontmatter-имени) |
| 4 | `dispatchTargets: self excluded by file name even when frontmatter names it differently` | → `prime.test.ts` (self-exclusion по basename `prime.md`) |
| 5 | `dispatchTargets: md without frontmatter keeps the file name` | покрыт `agents.test.ts` (parseAgentMarkdown) — в новых тестах не нужен |
| 6 | `dispatchTargets: non-md files ignored, missing dir → empty` | фильтрация не-md/пустой каталог — поведение `discoverAgents` (есть в `agents.test.ts`); пустой пул → `""` остаётся кейсом `buildDispatchTable([])` |
| 7 | `buildDispatchTable: markdown rows from description/model frontmatter` | переписан: rows из `DispatchRow[]`, заголовок `| Role | Purpose |`, колонки 2, escape `\|`, `description` пустой → `—` |
| 8 | `buildDispatchTable: empty pool → no table` | переписан: `buildDispatchTable([]) === ""` |
| 9 | `buildBudgetRule: numbers come from the enforcement constants` | перенос дословно (смена импорта на `../prime-protocol.ts`) |
| 10 | `knownAgentBodies: frontmatter stripped, prime body included` | функция удалена; тела берёт `def.body` — покрытие через кейс `isChildAppend` с телами из пула в `prime.test.ts` |
| 11 | `knownAgentBodies: missing dir → empty set (fail-open)` | аналогично №10; fail-open пустого пула покрыт кейсом `buildDispatchTable([])` |
| 12 | `spawnAgents: subagent and task_batch inputs` | перенос дословно |
| 13 | `shellLooksLikeLookup: reader commands count, cd-prefixed real work does not` | перенос дословно |
| 14 | `spawnAgents: task_batch chain steps count as dispatches` | перенос дословно |
| 15 | `shellLooksLikeLookup: every sequenced command counts, pipe consumers do not` | перенос дословно |
| 16 | `shellLooksLikeLookup: read-only git and extra readers count, git writes do not` | перенос дословно |
| 17 | `shellWriteTargets: redirects and writer cmdlets, null sinks ignored` | перенос дословно |
| 18 | `shellWriteTargets: arrows and comparisons are not redirects` | перенос дословно |
| 19 | `isChildAppend: identity alone or after a shared prompt; other appends are not children` | перенос дословно |

Итого шаг 2: `subagents/test/prime-protocol.test.ts` = №1, 7, 8 (переписанные) + №9,
12–19 (дословно, 9 шт.) = 12 тестов. №2–6 → `prime.test.ts`/`agents.test.ts` (шаги 1, 3).
Старый файл живёт нетронутым до шага 4.

## Порядок выполнения и точки контроля

1. Шаг 0 (runbook, руками) → только один раз, до шага 3.
2. Шаг 1 → `npm run check` → commit.
3. Шаг 2 → `npm run check` + `npm run smoke` → commit.
4. Шаг 3 (атомарно) → `npm run check` + `npm run smoke` + e2e-чеклист 3e → commit.
5. Шаг 4 → `npm run check` + финальный `grep -r "prime-protocol" extensions/ scripts/
   package.json` (должен быть пуст) → commit.

Шаги строго последовательны (S): 2 зависит от 1 (коммит-порядок и приёмка шага 1
предполагают зелёный базис), 3 — от 2, 4 — от 3. Параллелить шаги нельзя: каждый
следующий коммит строится на предыдущем.

## Риски исполнения (что worker проще всего сломает)

1. **Порядок guard'ов** env → append → selectedTools → armed — дословно; перестановка
   ломает child-семантику (I1). Toggle-проверка — строго после guard'ов.
2. **Тексты block-reason'ов** переносятся литералами (R5): любое «улучшение» формулировки
   ломает паритет и тесты на дословность.
3. **Инвариант I6** — один обработчик на событие в `index.ts`: подписки prime — единый
   блок после `session_shutdown`; не раскидывать по файлу.
4. **`prime.ts` без pi-runtime импортов** (только `import type`); fs — только через
   `PrimeDeps`. Реальные fs/getAgentDir-реализации — в `index.ts`. Нарушение ломает
   standalone-тесты и контракт I8.
5. **Headless-guard на ui-выходах**: каждый notify/banner/setWidget — за `ctx.hasUI` /
   `ctx.mode !== "tui"` + try/catch fail-safe, как в старом коде.
6. **Шаг 3 неатомарен по частям** — активация `prime.ts` и снятие entry из
   `package.json` обязаны попасть в один коммит; промежуточное состояние даёт двойные
   бюджеты.
7. **off-режим и счётчики**: в off счётчики и tool_result-статистика НЕ ведутся (ADR-2),
   но виджет остаётся (`⚡ Prime · off`) — не удалять виджет вместе с enforcement.
8. **Формула `lookupAllowance`** (`override ?? base + per*dispatches`) и reset-точки
   (`message_start` user / `session_start`) — дословно; потерянный reset = вечный блок.
9. `ASSUMPTION:` `stateFile` фиксируется при загрузке расширения из `process.cwd()`
   (ADR-2 говорит `<cwd>`); смена cwd через `/cwd` внутри живой сессии не отслеживается —
   соответствует ADR, выходит за рамки слияния.

## Верификация целиком

- После шага 4: `npm run check` зелёный; `npm run smoke` зелёный;
  `grep -r "prime-protocol" extensions/ scripts/ package.json` — пуст;
  `ls extensions/prime-protocol` — «No such file or directory»;
  в pi-сессии: `/prime status` отвечает, banner при первом сообщении, бюджеты блокируют
  по чеклисту 3e; `pi config` показывает 14 entry points.
