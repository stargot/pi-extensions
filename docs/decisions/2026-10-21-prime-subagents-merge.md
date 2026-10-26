# ADR: слияние prime-protocol в subagents как внутренний policy-модуль

> **type:** adr · **status:** accepted · **date:** 2026-10-21 · **last-verified:** 2026-10-25
> **supersedes:** — · **superseded-by:** — · **see-also:** CHANGELOG «Unreleased»

- **Автор идеи:** Ivan Sinyavskiy (stargot)
- **Режим:** ADR (проектные решения; нарезку на файлы/коммиты делает planner)
- **База:** пакет 0.10.0, Node ≥ 22.19.0, pi ≥ 1.0.0 (peer `@earendil-works/pi-coding-agent`)
- **Объект:** `extensions/prime-protocol/` (~520 строк src + 249 строк тестов, 19 зелёных тестов)
  и `extensions/subagents/` (~5200 строк src, 19 файлов, 257 зелёных тестов)

---

## 1. Резюме (TL;DR)

Расширение `prime-protocol` перестаёт существовать как entry point: вся его логика
переезжает внутрь `subagents` как внутренний **policy-модуль** (`prime.ts` —
состояние и enforcement, `prime-protocol.ts` — чистые функции сборки протокола).
Спавн-механика субагентов — **mechanics** — не меняется. Добавляется
переключатель **`/prime on|off|status`** с персистентностью per-project
(`<cwd>/.pi/prime.json`, дефолт `on`): `off` убирает инъекцию протокола и
бюджет-блокировки, но не трогает инструменты субагентов. Единый читатель
`agents/*.md` (`discoverAgents`), единый hook-слой в `index.ts`, dispatch-таблица
без колонки Model. Бюджеты 3/3/3 не смягчаются. Миграция — 4 шага, каждый
заканчивается зелёным `npm run check`.

## 2. Контекст и мотивация

Сегодня это два отдельных расширения (package.json → `pi.extensions`, 15 entry
points, среди них `./extensions/prime-protocol/index.ts`).

**Что делает prime-protocol** (проверено по коду):

- инъекция протокола в `before_agent_start` основной сессии:
  `extensions/prime-protocol/index.ts:294`, сборка — `:327`
  (`event.systemPrompt + "\n\n" + protocol`); протокол = тело
  `~/.pi/agent/agents/prime.md` + сгенерированная dispatch-таблица + бюджетное
  правило, отрендеренное из констант;
- solo-enforcement в коде: константы `BASE_LOOKUP_ALLOWANCE=3`,
  `PER_DISPATCH_ALLOWANCE=3`, `FILE_TURN_LIMIT=3` —
  `extensions/prime-protocol/index.ts:86-88`; подписки `session_start` (:200),
  `message_start` (:207), `tool_call` (:240), `tool_result` (:279); команда
  `/solo <N>|off` (~:177);
- child-skip тремя guard'ами: `PI_SUBAGENT_SESSION`, append-идентичность
  (`isChildAppend`), отсутствие `subagent` в `selectedTools` — тот же
  `before_agent_start`;
- dashboard: banner при первом сообщении + виджет `prime-status`.

**Что делает subagents:** спавн в панели, реестр имён, watcher доставки,
child-side auto-exit (`subagent-done.ts`), readonly-guard детей.

**Мотивация слияния** (каждый пункт проверен по коду):

1. **Два читателя одного каталога — с разными семантиками.** prime-protocol
   сканирует только `getAgentDir()/agents` (`extensions/prime-protocol/protocol.ts`,
   `dispatchTargets`). subagents читает **проект + глобальный** с приоритетом
   проекта: `discoverAgents(cwd, globalAgentDir)` —
   `extensions/subagents/agents.ts:131-164`. Уточнение к исходной сводке: второй
   читатель — `agents.ts`, а не `registry.ts` (тот — реестр имён сессии,
   `extensions/subagents/registry.ts`). Следствие расхождения: проектный агент
   (`.pi/agents/*.md`) **спавнится**, но **не виден** в dispatch-таблице
   протокола — таблица врёт относительно реально доступного пула.
2. **Два независимых hook-слоя.** Оба index.ts вешают `session_start`
   (prime `:200`, subagents `extensions/subagents/index.ts:661`) и держат
   собственные машины module-state, сбрасываемые независимо. Уточнение к сводке:
   `subagent-done.ts` (`:94-157` — `session_start`, `agent_start`,
   `message_update`, `tool_execution_start|update|end`, `agent_end`) — это
   **child-side** слой (auto-exit + heartbeat в детской сессии), он не дублирует
   prime в main; проблема — дубль layer'ов в **основной** сессии и дублированный
   child-detect (`PI_SUBAGENT_SESSION` знают оба расширения; «конвенция между
   расширениями» — формулировка из удалённого research-дока, см. git history).
3. **~2K токенов протокола в каждой главной сессии всегда.** prime.md 5.2K chars +
   таблица ~18 строк + правило ≈ 6.9K chars ≈ 1.7–2K токенов — даже когда
   оркестрация не нужна (правка одного файла, вопрос по коду). Выключить сегодня
   можно только выгрузкой расширения — вместе с инструментами субагентов.
4. **Искусственная граница policy/mechanics.** prime — это политика поверх
   механики subagents (бюджет растёт именно от диспатчей subagents/task_batch);
   отдельный entry point принуждает дублировать чтение пула, child-detect и
   reset-логику.

**Внеочередное решение пользователя:** направление (слияние) одобрено до этого
ADR; альтернатива «не сливать, только флаг» рассматривалась и отвергнута на этом
уровне (см. ADR-1).

## 3. Решения (ADR-записи)

### ADR-1 (R1): prime-protocol становится внутренним policy-модулем subagents

**Контекст.** Одно поведение (оркестрационная дисциплина) разорвано на два entry
point; граница проходит внутри одной ответственности.

**Решение.** Удалить `extensions/prime-protocol/` целиком (entry, src, тесты,
README). Внутри `extensions/subagents/` два новых модуля по линии
mechanics/policy:

- `prime.ts` — **policy**: состояние хода (счётчики, override), arming,
  toggle, команды `/prime` и `/solo`, виджет, banner. Единственный владелец
  budget-логики.
- `prime-protocol.ts` — **pure**: сборка текста протокола (dispatch-таблица,
  бюджетное правило) и классификация tool-call'ов (`spawnAgents`,
  `shellLooksLikeLookup`, `shellWriteTargets`, `isChildAppend`, `asInput`).
  Без импортов pi и без fs — всё через аргументы (наследует контракт
  `prime-protocol/protocol.ts`, тесты standalone).

`index.ts` subagents остаётся единственным местом регистрации хуков и команд
основной сессии (см. ADR-4). Спавн-механика (batch/watcher/mux/launcher/…) не
трогается.

**Отвергнутые альтернативы.**

- *Не сливать, добавить флаг в существующий prime-protocol.* Выбрано пользователем
  иное; кроме того, флаг не устраняет пункты 1–2 мотивации (два читателя, два
  hook-слоя) и не убирает искусственную границу.
- *Общие helpers в `extensions/shared/`, оба расширения остаются.* Лечит только
  дублирование кода, но не дублирование runtime: два `session_start`, два
  child-detect, два entry.
- *Третье расширение-«ядро», от которого зависят оба.* Умножает entry points и
  порядок загрузки; хуже обоих вариантов.

**Последствия.** −1 entry point в `pi.extensions`; категория «policy» получает
один дом; любые будущие изменения оркестрационной дисциплины касаются одного
каталога. Риск регрессии при переносе парируется паритет-тестами (раздел 7).

### ADR-2 (R2): переключатель `/prime` с персистентностью per-project

**Контекст.** Нужен режим «оркестрация не давит»: нет инъекции, нет блокировок,
инструменты субагентов на месте. Требование: per-project, переживает рестарт
сессии и `/reload`, дефолт `on`.

**Решение — контракт переключателя.**

**Хранение.** Файл **`<cwd>/.pi/prime.json`**, единственный ключ:

```json
{ "enabled": true }
```

- значения: `"enabled": true | false`; два случая отказа различаются:
  (а) **файл отсутствует** (или без ключа) → **`true`**, молча;
  (б) **файл присутствует, но нечитаем/невалиден** → keep-last-known-good в
  рамках сессии (стартует `true`), одноразовый notify и индикация в виджете
  (например `⚡ Prime · unknown (broken .pi/prime.json)`) — иначе после
  `/prime off` битый файл (hand-edit, EBUSY) молча вернул бы enforcement;
- запись: атомарно tmp + rename, tmp с уникальным суффиксом (pid/sessionId —
  две pi-сессии в одном cwd не коллидят); ошибка записи **бросается**
  (persist-или-ничего) — не как `writeNameRegistry`, который глотает все ошибки
  (`extensions/subagents/registry.ts:72-74`) и пишет детерминированный
  `${path}.tmp` (:69); неизвестные ключи при чтении игнорируются, при записи не
  сохраняются;
- чтение: лениво, без кэша (единственное исключение — last-known-good для
  случая (б) выше) — на `session_start` (banner/виджет), на каждом
  `before_agent_start` (свежесть: внешний edit файла и `/reload` подхватываются
  автоматически) и в `/prime status`. Один `readFileSync` на ход — пренебрежимо.

**Команды.**

- `/prime` и `/prime status` — notify: режим, путь к файлу-источнику, эффекты
  on-режима (3 лукапа + 3/диспатч, 3 файла, инъекция), подсказка про
  `/prime off` / `/solo`;
- `/prime on` — записать `{enabled:true}`, notify «Prime on — протокол и
  solo-enforcement вернутся со следующего хода», перерисовать виджет;
- `/prime off` — записать `{enabled:false}`, notify «Prime off — инъекция и
  блокировки сняты со следующего хода; инструменты субагентов остаются
  доступны», виджет переключается на статичную строку `⚡ Prime · off`;
- режим меняется **только при успешной записи** файла; ошибка записи → notify
  об ошибке, режим не меняется (persist-или-ничего — файл и факт не расходятся).

**Семантика `off` (точный контракт):**

1. `before_agent_start` не возвращает override → системный промпт без протокола
   начиная со следующего run. `before_agent_start` срабатывает перед каждым run
   (pi types: `BeforeAgentStartEvent`, «Fired after user submits prompt but
   before agent loop», types.d.ts:692-693), так что
   toggle действует без перезапуска сессии; в текущем незавершённом run протокол
   ещё присутствует — документировано и принято;
2. `tool_call`-обработчик политики возвращает `undefined` немедленно — ни лукап-,
   ни файл-блокировок, счётчики не ведутся;
3. `tool_result`-статистика для виджета не ведётся;
4. banner не показывается;
5. инструменты `subagent` / `subagent_message` / `subagent_cancel` /
   `subagents_list` и команды `/subagent`, `/workers` остаются
   зарегистрированными — регистрация не зависит от toggle (требование R2);
6. trace-записи не меняются (prime их и сейчас не пишет; `trace:subagents`
   пишет механика — её не трогаем, R7).

**Семантика `on`:** текущее поведение без изменений (см. ADR-7).

**Child-семантика.** Toggle касается только main-сессий. Дети не инжектятся и не
блокируются **всегда**, независимо от toggle: guard'ы `PI_SUBAGENT_SESSION`,
child-append, отсутствие `subagent`-тула переносятся как есть и имеют приоритет
над toggle. Вложенный оркестратор (ребёнок, которому разрешено спавнить детей,
грузит subagents как orchestrator) тоже не получает ни инъекции, ни бюджетов —
как сегодня. Toggle-файл детьми не читается.

**Взаимодействие с `/solo`.** В on-режиме — без изменений: `/solo <N>` поднимает
лукап-кап до конца хода, `/solo off` снимает enforcement до следующего
пользовательского сообщения; `/solo off` снимает и файл-кап — как сейчас. В
off-режиме `/solo` отвечает notify «Prime выключен — сначала /prime on» и ничего
не меняет. Команда остаётся зарегистрированной всегда.

**Отвергнутые альтернативы хранения.**

- *Ключ в pi settings.json (глобальном или проектном).* У расширений есть только
  чтение: `ctx.getSettings()` возвращает копию эффективных настроек
  (pi types.d.ts:1240-1241), write-API нет. Ручная запись в `settings.json` за
  спиной pi гоняется с его собственными записями и ломает user-managed файл.
- *Env-переменная.* Не персистентна per-project между сессиями.
- *Файл в артефактах сессии* (как `subagent-registry.json`). Переживает только
  сессию, не проект.
- *`.pi/prime.json`* выбран по прецедентам проекта: `.pi/context-inspector.jsonl`
  (context-inspector), `.pi/jobs/` (bg-jobs) — project-local state уже живёт в
  `.pi/`.

**Последствия.** Появляется пользовательский файл состояния; его формат —
контракт (см. инвариант I7). Виджет в off-режиме остаётся как индикатор «почему
модель работает соло».

### ADR-3 (R3): единый читатель пула + компактная dispatch-таблица

**Контекст.** Две точки сканирования `agents/*.md` с разными областями (только
глобальная vs проект+глобальная) и таблица с колонкой Model.

**Решение.**

1. **Единственный читатель — `discoverAgents`** (`extensions/subagents/agents.ts`).
   Никаких `readdirSync` по каталогам агентов вне `agents.ts`. Для нужд prime:
   - `AgentDef` получает поле `dispatch: boolean` (default `true`; ключ
     `dispatch` уже в `KNOWN_KEYS`, но не парсился в поле);
   - dispatch-пул = `discoverAgents(...)` минус самоисключение prime (по ОБОИМ
     признакам — frontmatter `name === "prime"` И basename `prime.md`, как
     сегодня в `extensions/prime-protocol/protocol.ts:68`; тест «self excluded
     by file name even when frontmatter names it differently» переносится)
     минус `dispatch === false`;
   - тело prime и `knownAgentBodies` для `isChildAppend` берутся из того же
     `Map<string, AgentDef>` (`def.body`), собственные сканы
     (`splitFrontmatter`/`knownAgentBodies`/`dispatchTargets` из старого
     `protocol.ts`) удаляются.
2. **Колонка Model убирается.** Таблица становится `| Role | Purpose |`.

**Обоснование удаления Model:** выбор модели — механика спавна (`resolveAgentDef`
берёт `model` из определения в момент запуска), а решение prime — выбор **роли**;
колонка дублирует то, что уже видно через `subagents_list`, стоит ~1 токен ×
строку и создаёт второй источник правды, способный дрейфовать. Оставить колонку
«для осознанного роутинга» отклонено: протокол не должен микроменеджить модели.

**Санкционированная дельта on-режима** (единственная, вместе с п. 1): таблица и
banner теперь видят **объединённый** пул — проектные агенты (`.pi/agents/*.md`)
появляются в dispatch-таблице, проектный `prime.md` может переопределить
глобальный. Это осознанное исправление сегодняшнего расхождения «спавнится, но
не виден в протоколе», следующее из требования «один читатель на двоих».
Поведенческие же guarantee'и (guard'ы, бюджеты, счётчики, блок-сообщения,
trace) не меняются — см. ADR-7.

**Отвергнутая альтернатива:** сохранить для таблицы глобальный-only срез из
объединённого пула (фильтр `scope === "global"`) ради байт-в-байт идентичного
промпта. Отклонено: консервирует баг расхождения таблицы и спавн-реестра —
ровно то, что R3 просит устранить.

**Последствия.** Тесты `buildDispatchTable` переписываются на вход «готовые
строки пула» (см. раздел 7); промпт в on-режиме меняет текст таблицы (меньше,
без Model, возможно больше строк за счёт проектных агентов).

### ADR-4 (R4): единый hook-слой

**Контекст.** Две независимые подписки `session_start` в main-сессии; расплата —
два несинхронных сброса состояния и дублированный child-detect.

**Решение.** После слияния в основной сессии подписки держит **только**
`extensions/subagents/index.ts`:

- `session_start` (:661, расширяется) — сброс механики **и** вызов
  `prime.onSessionStart()`;
- `session_shutdown` (:668) — как сейчас;
- `message_start` (новая подписка index.ts) — только делегирование в
  `prime.onUserMessageStart()` (сброс хода + greeting; внутри prime — проверка
  `role === "user"`);
- `tool_call` — делегирование в `prime.onToolCall(event)`; других
  `tool_call`-подписок в main-сессии нет (`readonly-guard.ts:30` грузится только
  readonly-детям);
- `tool_result` — делегирование в `prime.onToolResult(event)`;
- `before_agent_start` — делегирование в `prime.onBeforeAgentStart(event)`.

`prime.ts` сам ничего не регистрирует: он экспортирует фабрику
`createPrimePolicy(...)`, index.ts вызывает её один раз при загрузке. Порядок
внутри обработчиков детерминирован (один модуль), состояние одно.
`subagent-done.ts` (child-side) и `readonly-guard.ts` (child-side) не трогаются:
они живут в детских процессах и не образуют дубль в main.

**Отвергнутая альтернатива:** общая подписка через «шину событий» между двумя
расширениями (`pi.events` — идея из удалённого research-дока, см. git
history) — у pi нет меж-extension шины; слияние делает её ненужной здесь.

**Последствия.** Инвариант I6: в основной сессии ровно по одному обработчику
каждого события на всё расширение. Порядок инъекции: prime-override
`systemPrompt` — последняя мутация промпта в пакете (context-inspector по этому
событию только наблюдает, `extensions/context-inspector/index.ts:123`).

### ADR-5 (R5): бюджеты не смягчаются

Константы `3 / 3 / 3` остаются литералами в `prime.ts` (переносятся как есть из
`extensions/prime-protocol/index.ts:86-88`): 3 лукапа за ход + 3 за каждого
успешно отправленного агента, 3 различных файла за ход, повторное чтение файла
бесплатно, `/solo off` снимает всё до конца хода. Тексты block-reason'ов
переносятся дословно. Это «зубы» протокола; ослабление — вне этого ADR.

### ADR-6 (R6): миграция в 4 шага

Каждый шаг — отдельный коммит, после каждого `npm run check` зелёный. Подробности
в разделе 6.

### ADR-7 (R7): on-режим поведенчески идентичен текущему

«Идентично» означает: guard'ы arming, моменты и причины блокировок, формулы
счётчиков, reset-точки, сообщения блокировок, banner/виджет-факты (модель в
banner/виджете — убрана 2026-10-21 после e2e: pi показывает модель нативно в
статус-баре, дубль снят; раньше — паритет через инжектируемый `PrimeDeps.model`,
§5), отсутствие trace-записей у prime. Единственные санкционированные дельты —
из R3: текст таблицы (без Model, из объединённого пула) и, как следствие, число
строк в ней.
Бюджетная строка протокола по-прежнему рендерится из констант кода — числа в
промпте не могут разойтись с блокировками.

## 4. Целевая структура subagents после слияния

```
extensions/subagents/
├── index.ts               # entry: инструменты, команды, watcher; ЕДИНСТВЕННЫЙ hook-слой main-сессии
├── prime.ts               # NEW policy: arming, бюджеты хода, toggle, /prime + /solo, banner, виджет
├── prime-protocol.ts      # NEW pure: buildDispatchTable / buildBudgetRule / isChildAppend /
│                          #     spawnAgents / shellLooksLikeLookup / shellWriteTargets / asInput / cell
├── agents.ts              # расширение: AgentDef.dispatch + отдача пула prime (единственный читатель agents/*.md)
├── registry.ts            # без изменений
├── subagent-done.ts       # без изменений (child-side)
├── readonly-guard.ts      # без изменений (child-side)
├── batch.ts, watcher.ts, mux.ts, launch-plan.ts, launcher.ts, render.ts,
│   shared.ts, activity.ts, child-tools.ts, herdr.ts, pane-cache.ts,
│   running-index.ts, session-read.ts, wezterm.ts        # без изменений
├── README.md              # обновить: раздел «Prime policy» (/prime, /solo, .pi/prime.json)
└── test/
    ├── prime-protocol.test.ts   # перенос prime-protocol/test/protocol.test.ts (адаптация)
    ├── prime.test.ts            # NEW: toggle, off-семантика, on-паритет
    ├── agents.test.ts           # расширить: dispatch-поле
    └── (остальные 19 файлов без изменений)
```

`extensions/prime-protocol/` удаляется целиком; `pi.extensions` в package.json
минус одна строка.

## 5. Контракты модулей

### `prime-protocol.ts` (pure, без pi-импортов и fs)

```ts
export interface DispatchRow { name: string; description: string }
/** Пустой пул → "". Колонки: Role | Purpose. */
export function buildDispatchTable(rows: DispatchRow[]): string;
/** Без изменений: рендер из констант enforcement. */
export function buildBudgetRule(a: { base: number; perDispatch: number; files: number }): string;
export function cell(text: string): string;
/** Без изменений: append заканчивается телом известного агента → child. */
export function isChildAppend(append: string | undefined, bodies: Set<string>): boolean;
export function asInput(event: unknown): Record<string, unknown>;
export function spawnAgents(toolName: string, input: Record<string, unknown> | undefined): string[];
export function shellLooksLikeLookup(input: Record<string, unknown>): boolean;
export function shellWriteTargets(input: Record<string, unknown>): string[];
```

Удаляются относительно старого `protocol.ts`: `readIfExists`, `splitFrontmatter`,
`dispatchTargets`, `knownAgentBodies` — их роли забирают `agents.ts` и `prime.ts`.

### `agents.ts` (расширение)

```ts
export interface AgentDef {
	// ...существующие поля...
	/** `dispatch: false` — роль не попадает в dispatch-таблицу prime. Default true. */
	dispatch: boolean;
}
```

`parseAgentMarkdown` парсит `dispatch` по образцу `readonly`. `discoverAgents`
сигнатуры не меняет.

### `prime.ts` (policy; pi — только типы)

```ts
export interface PrimeDeps {
	agents: () => Map<string, AgentDef>; // лениво: свежий пул на каждый before_agent_start
	stateFile: string;                   // <cwd>/.pi/prime.json
	// model: () => string | undefined — УБРАНО 2026-10-21 после e2e: pi
	// показывает модель нативно в статус-баре, дубль в banner/виджете снят
	// (раньше: источник модели — readSessionModel(), паритет banner
	// `⚡ Prime online — … · ${model}`).
	/** injectable fs для тестов (по образцу dependency-free registry.ts). */
	readState: (path: string) =>
		| { kind: "ok"; enabled: boolean } // ключ прочитан
		| { kind: "absent" } // файла нет (или без ключа) → трактуется как enabled = true, молча
		| { kind: "error"; message: string }; // файл есть, но нечитаем/невалиден → keep-last-known-good
	writeState: (path: string, enabled: boolean) => void; // бросает при ошибке записи (persist-или-ничего)
}

export interface PrimePolicy {
	onSessionStart(): void;
	onUserMessageStart(): void; // сброс хода + greeting (проверка role === "user" внутри)
	onToolCall(event: unknown): { block: true; reason: string } | undefined;
	onToolResult(event: unknown): void; // dispatch-надбавка + stats виджета
	onBeforeAgentStart(event: unknown): { systemPrompt: string } | undefined;
	onPrimeCommand(args: string, ctx: unknown): void; // /prime on|off|status
	onSoloCommand(args: string, ctx: unknown): void;  // /solo N|off; no-op при off-режиме
	statusLine(): string; // строка виджета, включая "⚡ Prime · off"
}

export function createPrimePolicy(deps: PrimeDeps): PrimePolicy;
```

Точные типы событий planner берёт из pi `types.d.ts`; контракт — границы и
направление зависимостей: `index.ts → prime.ts → prime-protocol.ts/agents.ts`;
`prime-protocol.ts` ни от кого внутри пакета не зависит (кроме `shared/shell.ts`
— как сегодня).

### Хранение toggle (контракт файла)

См. ADR-2: `<cwd>/.pi/prime.json`, `{ "enabled": boolean }`; absent → `true`
(молча), unreadable/invalid → keep-last-known-good сессии (стартует `true`) +
одноразовый notify, виджет `unknown`; запись tmp+rename с уникальным
tmp-суффиксом, ошибка бросается; чтение на `session_start` / каждом
`before_agent_start` / `/prime`.

## 6. План миграции

Каждый шаг = коммит; критерий приёмки каждого шага — зелёный `npm run check`
(lint + format-check + type + test).

**Шаг 0 (runbook пользователя, до кода).** Если локальная копия
`~/.pi/agent/extensions/prime-protocol.ts` существует (prime-protocol — её порт,
`extensions/prime-protocol/README.md:7`) — удалить/отключить её ДО включения
слитого кода, иначе двойная инъекция и двойные бюджеты; на момент ADR файл
отсутствует (в `~/.pi/agent/extensions/` только `browser/`, `btw.ts`,
`custom-header.ts`, `herdr-agent-state.ts`, `vlt-bridge.ts`).
*Приёмка:* `pi config` не показывает prime-protocol дважды.

**Шаг 1 — `agents.ts`: поле `dispatch`.** Парсинг в `parseAgentMarkdown`,
поле в `AgentDef`, тесты в `agents.test.ts` (true/false/отсутствует → true).
*Приёмка:* check зелёный; поведение остальных модулей не изменилось.

**Шаг 2 — перенос pure-модуля.** Создать `subagents/prime-protocol.ts`
(контракт раздела 5) и `subagents/test/prime-protocol.test.ts` (адаптация
`prime-protocol/test/protocol.test.ts`: импорты, `buildDispatchTable` на
`DispatchRow[]`, без Model-колонки; покрытие `isChildAppend`/`spawnAgents`/
shell-классификации переносится дословно). Старое расширение ещё активно и
работает по-старому (временное дублирование кода, не поведения).
*Приёмка:* check зелёный (257 + 19 адаптированных + новые); `npm run smoke`
зелёный.

**Шаг 3 — переключение (атомарно).** Одним коммитом: создать `prime.ts`,
провести его в `index.ts` (подписки и команды по ADR-4), `/prime` + `/solo`,
toggle-файл, виджет; **одновременно** убрать `./extensions/prime-protocol/index.ts`
из `pi.extensions` — разделять нельзя, иначе два активных enforcement-слоя.
*Приёмка:*
- `npm run check` и `npm run smoke` зелёные;
- вручную (e2e): on-паритет — banner при первом сообщении; 4-й лукап хода
  блокируется, 3-й проходит; успешный `subagent`-спавн поднимает кап на 3;
  повторное чтение того же файла бесплатно; 4-й файл блокируется; `/solo 10`
  пропускает 10; `/solo off` снимает всё до следующего сообщения; ребёнок
  (`/subagent`) без инъекции и без блокировок; `task_batch` chain даёт надбавку
  за каждый шаг;
- вручную (off): `/prime off` → следующий ход без протокола (видно в
  `/context` или по поведению), лукапы/едиты не блокируются, `subagent`-тул
  доступен; `/solo` в off отвечает подсказкой; после перезапуска pi режим off
  сохранён (файл).

**Шаг 4 — гигиена.** Удалить каталог `extensions/prime-protocol/`; обновить
`extensions/subagents/README.md` (раздел «Prime policy»: инъекция, бюджеты,
`/prime`, `/solo`, `.pi/prime.json`, child-семантика); CHANGELOG.md под
Unreleased (minor: −1 расширение, +`/prime`); проверить упоминания:
удалённый research-док (см. git history; конвенция `PI_SUBAGENT_SESSION`
между расширениями — теперь внутренняя), README других расширений, `docs/`
grep'ом по `prime-protocol`.
*Приёмка:* check зелёный; `grep -r "prime-protocol" extensions/ scripts/
package.json` пуст; в docs/ и CHANGELOG остаются только исторические упоминания.

## 7. План тестов

| Тесты | Судьба |
|---|---|
| `prime-protocol/test/protocol.test.ts` (19) | → `subagents/test/prime-protocol.test.ts`: импорты `../prime-protocol.ts`; кейсы `dispatchTargets` переписаны на `buildDispatchTable(DispatchRow[])` (сортировка по имени; фильтр `prime`/`dispatch:false` теперь тестируется в `prime.test.ts`); escape `\|`, пустой description → `—`, пустой пул → `""`; `isChildAppend` (последний append, чужой append ≠ child), `spawnAgents` (subagent / task_batch tasks+chain / без agent), shell-классификация (последовательности `;`/`&&`, pipe-потребители, git-читатели, write-таргеты) — дословно |
| `subagents/test/agents.test.ts` | + `dispatch: false` / отсутствие ключа / `true` |
| NEW `subagents/test/prime.test.ts` | toggle: файл отсутствует → on (молча); invalid JSON при предыдущем off → last-known-good (off), одноразовый notify, виджет `unknown (broken .pi/prime.json)`; без предыдущего значения (старт сессии) → on; `{enabled:false}` → off; запись tmp+rename (уникальный tmp-суффикс), ошибка записи бросается; off: `onToolCall` никогда не блокирует (10-й лукап подряд), `onBeforeAgentStart` → `undefined`, banner подавлен; on: 3-й лукап проходит, 4-й блок; +3 за успешный диспатч, за ошибочный — нет; файл-кап и его сообщения; повторное чтение бесплатно; `/solo` override и его сброс на новом user message; фильтр пула: самоисключение prime по frontmatter-имени И по файлу `prime.md` (тест «self excluded by file name even when frontmatter names it differently» переносится), плюс `dispatch:false` |
| Существующие 257 subagents | не меняются (кроме agents.test.ts) |

Ручные e2e (`e2e-*.manual.ts`) — по желанию добавить `/prime` в `e2e-pi.manual.ts`.

## 8. Риски и парирования

| Риск | Парирование |
|---|---|
| Регрессия бюджетов при переносе (потерянный reset, изменённый порядок guard'ов) | паритет-кейсы из старых тестов переносятся дословно; константы и тексты блокировок — литералами в `prime.ts`; ручной чек-лист шага 3 |
| Двойная инъекция/бюджеты в переходный период или от локальной копии `~/.pi/agent/extensions/prime-protocol.ts` | шаг 0 runbook; шаг 3 атомарен (новый код + снятие entry одним коммитом) |
| Расхождение child-detect после слияния | guard'ы переносятся как есть (env / append / selectedTools); `isChildAppend` теперь проверяет и проектные тела из `discoverAgents`: строго больше тел ⇒ БОЛЬШЕ append'ов классифицируется как child — main-сессия с `--append-system-prompt`, совпадающим с телом проектного агента, будет разоружена (ложный main-детект). Риск принят и документируется (README «Prime policy»); тесты `isChildAppend` переносятся |
| Порядок инициализации/подписок | один модуль `index.ts` владеет подписками; позиция обработчиков prime в `pi.extensions` меняется 8 → 14, значит меняется порядок before_agent_start-оверрайдов для других расширений (pi: «Later handlers observe this exact override», types.d.ts:1084); сегодня это безопасно — кроме prime промпт на этом событии наблюдает только context-inspector (observe-only, `extensions/context-inspector/index.ts:123`); проверяемое ограничение: регистрация prime остаётся последней мутацией `systemPrompt` в пакете (позиция subagents в `pi.extensions` — последняя среди мутирующих) |
| `/reload` сбрасывает module-state | ожидаемо и сегодня так: toggle и реестр на диске, счётчики хода пересоздаются (дешёвый сброс дисциплины, не данных) |
| `.pi/prime.json` не пишется (read-only cwd) | `/prime` сообщает ошибку, режим не меняется; чтение invalid → keep-last-known-good + одноразовый notify, виджет `unknown` (см. ADR-2) |
| Промпт в off-режиме ещё содержит протокол до конца текущего run | свойство `before_agent_start` (per-run) — документировано в `/prime off` notify |
| Дельта on-режима (таблица из объединённого пула) кем-то сочтена регрессией | дельта явно перечислена в ADR-3/ADR-7 и отражена в CHANGELOG |

## 9. Инварианты (должны держаться при любых будущих изменениях)

- **I1.** Дети (`PI_SUBAGENT_SESSION`, child-append, отсутствие `subagent`-тула)
  не получают ни инъекции, ни блокировок — независимо от toggle.
- **I2.** Числа в бюджетной строке протокола рендерятся из тех же констант, что
  блокируют tools (единственный источник — константы `prime.ts`).
- **I3.** Пул агентов читает только `discoverAgents`; никаких сканов
  `agents/*.md` вне `agents.ts`.
- **I4.** off-режим не изменяет регистрацию инструментов, команды механики
  (`/subagent`, `/workers`) и trace-записи.
- **I5.** Сообщения блокировок и формулы счётчиков в on-режиме не зависят от
  toggle-механизма.
- **I6.** В основной сессии у расширения ровно один обработчик на событие
  (`tool_call`, `session_start`, …); новых дублирующих слоёв не появляется.
- **I7.** Формат `.pi/prime.json` — контракт: `{ "enabled": boolean }`,
  default/отсутствие = `true`; менять только с обратной совместимостью чтения.
- **I8.** `prime-protocol.ts` остаётся pure (без pi-импортов и fs) — тесты
  standalone, как у `agents.ts`/`registry.ts`.

## 10. Ограничения для planner (дословно)

- Не менять: константы 3/3/3 и их имена; тексты block-reason'ов; порядок
  guard'ов в `before_agent_start` (env → append → selectedTools → armed);
  trace-записи `trace:subagents`; регистрацию инструментов и `/subagent`,
  `/workers`; `subagent-done.ts` и `readonly-guard.ts`.
- Границы модулей: подписки/команды — только в `index.ts`; `prime.ts` не
  импортирует pi-runtime (только типы) и не пишет в fs напрямую (через deps);
  `prime-protocol.ts` — без pi-импортов и fs.
- Все ui-выходы prime (notify, banner, виджет) — за `ctx.hasUI` / mode-guard
  (`mode !== "tui"`), как в текущем коде: headless/RPC-сессии не получают
  ui-вызовов.
- Один читатель пула: `discoverAgents`; никакого `readdirSync` по agents/
  вне `agents.ts`.
- Точки вызова prime из index.ts: `session_start`, `message_start`,
  `tool_call`, `tool_result`, `before_agent_start`, команды `/prime`, `/solo`.
- Персистентность режима — только `<cwd>/.pi/prime.json`; в pi `settings.json`
  ничего не пишем.
- Миграция: шаги 1–4 раздела 6, коммит на шаг, `npm run check` зелёный после
  каждого; шаг 3 атомарен (активация нового кода + снятие старого entry).
- Тесты: 19 старых сохраняются (адаптированные) + новые на toggle/off/on;
  существующие 257 не регрессируют.
- Удаляется целиком `extensions/prime-protocol/`; `pi.extensions` −1 entry;
  CHANGELOG (Unreleased), README subagents, удалённый research-док
  (см. git history).
