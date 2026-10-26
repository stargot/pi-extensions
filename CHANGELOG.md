# Changelog

All notable changes to this project are documented in this file.
Versioning: [semver](https://semver.org/). Внутри версии — группы New / Add / Fixed / Removed.

## [Unreleased]

### Add

- **docs**: протокол ведения документации `docs/README.md` — типы доков (adr / spec / research), машиночитаемые заголовки, нейминг, индекс docs/ и аудит на каждом minor-релизе; backlog канонически живёт в корневом `TODO.md`, живые пункты из `docs/RESEARCH.md` и `docs/better-ui-analyse.md` перенесены в него (заметки удалены), ссылки на удалённые research-заметки вычищены из кода и README расширений.

### Fixed

- **docs**: README переработан (таблица расширений, разделы «Разработка» и «CLI без pi»), third-party атрибуция сведена в README расширений.

### Removed

- **prompt-snippets**: расширение удалено из пакета — сняты каталог `extensions/prompt-snippets/`, запись в `pi.extensions`, env-ручка `PI_SNIPPETS_DIR` и упоминания в README.
- **docs**: `THIRD_PARTY_NOTICES.md` удалён — атрибуция заимствованного кода живёт в README расширений.

## [0.11.0] — 2026-10-23

### Add

- **trace**: строка состояния над редактором — ход с таймером, cache hit (холодный `↻`), стоимость, воркеры, итог эры; `/trace on|off`, выбор хранится в `<agentDir>/trace.json`.
- **trace**: `/trace web [файл]` — веб-вьюер подкомандой; `/trace-web` устарела и будет удалена.
- **subagents**: frontmatter `readonly: true` — ребёнок с блокировкой `edit`/`write` и пишущих shell-команд (эвристики в общем `shared/shell.ts`).
- **subagents**: общий промпт детей `APPEND_SUBAGENT.md` (проектный или глобальный) добавляется перед identity.
- **subagents**: `/prime on|off|status` — prime-политика переехала в subagents; в off-режиме протокол не инжектится, `/solo` подсказывает включить prime.
- **subagents**: dispatch-таблица строится из объединённого пула агентов (проектные + глобальные, опт-аут `dispatch: false`), без колонки Model.
- **subagents**: env `PI_SUBAGENT_SUMMARY_CHARS` — единый лимит обрезки результата субагента и вывода задачи `task_batch` (дефолт 8000 вместо жёстких 2000/50 КБ).

### Fixed

- **trace**: оверлей и веб-вьюер переделаны на общем ядре — вкладки Flow · Timeline · Context, инспектор хода, эры на таймлайне, дифф контекста (вместо контекст-диффа), фильтры и воспроизведение со сжатием пауз; новые клавиши `1 2 3`, `, .`, `[ ]`, `i`.
- **trace**: TUI перерисовывается только при изменении кадра, а не ~7 раз в секунду на простое.
- **subagents**: модель убрана из prime-баннера и виджета — pi и так показывает её нативно.
- **prime-protocol**: child-detect по append сравнивает окончание промпта, а не точное совпадение.
- **trace**: веб-вьюер опрашивает сессию инкрементально (`/session.jsonl?from=<байт>`) и не качает её целиком каждые 2 с; незаписанная последняя строка ждёт следующего опроса, смена файла — полное перечитывание.
- **trace**: статика веб-вьюера отдаётся с `no-cache` — после обновления trace браузер не показывает старую страницу.
- **trace**: `/trace-web` держит сервер в процессе pi (ушли гонки kill/spawn и сирота на 8787), при занятом порте берёт свободный и показывает настоящий адрес.
- **trace**: мелочи веб-вьюера и TUI — горизонтальный скролл ленты, слайдер растёт с живой сессией, автодополнение не теряет живых воркеров и берёт сессии по cwd, live-воркер открывается в live-режиме, скобка режима воркеров, ссылка карточки субагента, декодирование кусков через `StringDecoder`, спиннер running-чипа, перемотка replay, цветной CLI (`fallbackTheme` ломал SGR), длительность чипа инструмента от конца стрима, падение `boot()` веб-вьюера.
- **subagents**: `browser_*` в `tools:` даёт ребёнку `PI_BROWSER_ENABLED=1`; `web_search`/`web_fetch` у pane-детей резолвятся в `web` пакета, `browser_*` — в глобальный browser.
- **subagents**: pane-дети с `tools:` больше не теряют env-guard/edit-guard; `subagents:` во frontmatter с `tools:` снова даёт спавн; `task_batch` передаёт ребёнку `thinking`.
- **prime-protocol**: chain-шаги `task_batch` считаются диспатчами; лукап-детектор проверяет каждую команду последовательности (`sed`, `awk`, читающие git); shell-записи идут в лимит правок за ход. **shared**: system-theme завендорен (deep-импорт из dist pi ломал тему у git-потребителей).
- **bg-jobs**: тесты дожидаются завершения всех заспавненных джоб и чистят temp-каталоги с ретраями — транзиентные Windows-ошибки EPERM/EBUSY больше не роняют прогон.

### Removed

- **shared**: модуль `line-diff.ts` — потреблял только заменённый режим контекст-диффа trace.
- **prime-protocol**: расширение удалено, протокол оркестратора слился в subagents как внутренний policy-модуль.
- **context-inspector, quiz, usage, payload-capture**: расширения удалены из пакета (context-inspector/quiz/usage — как неиспользуемые), включая npm-скрипт `stats`.
- **web**: провайдер LangSearch удалён — `web_search` работает только через DuckDuckGo; env-переключатель провайдера и `LANGSEARCH_API_KEY` сняты.

## [0.10.0] — 2026-10-16

### Removed

- **handoff**: расширение удалено из пакета — автодамп состояния сессии и подхват на старте больше не входят в поставку.

## [0.9.0] — 2026-10-16

### Fixed

- **package**: расширения переименованы (session-recall/trace/handoff/ledger → recall, trace, handoff, usage), кастомные записи — `trace:subagents`/`trace:bg-jobs` (легаси распознаётся).
- **subagents**: исправлен ложный вердикт «pane closed» сразу после спавна; сентинел завершения не затирает строку экрана.
- **prime-protocol**: статус-строка виджета сжата (`⚡ Prime · <model>`, бюджет хода, `sent N`).

## [0.8.0] — 2026-10-15

### Add

- **env-guard**: deny-слой на файлы `.env`-семейства (включая `.envrc`) и shell-команды с env-путями/именами-токенами; хук `input` маскирует весь входящий текст сессии, включая steer-результаты субагентов.
- **env-guard**: сбор секретов из любых значений под секрет-именованными ключами (числа, URL) и из direnv `.envrc` без исполнения кода.

### Fixed

- **subagents**: спавн детей унифицирован (`ChildLaunchPlan`, `MuxBackend` для wezterm/herdr), resume и re-label асинхронные, `task_batch` получил кап глубины, валидацию `cwd` и контракт артефактов.
- **env-guard**: прекращена маскировка не-секретных значений (`isPlausibleSecretValue`); именной fallback-редактор маскирует `KEY=value` в результатах инструментов даже несобранных значений.
- **env-guard**: steer-сообщения субагентов больше не проходят мимо маскировки; на `message_end` маскируются все роли.
- **subagents**: hotfix гонок вотчера — done-waiter, пустой список панелей, приоритет `.exit`-маркера, живой статус в `task_batch`.

### Removed

- **quiz**: веб-режим — расширение снова TUI-only.

## [0.7.0] — 2026-10-02

### Fixed

- **shared, context-inspector, session-trace**: парсеры переживают формат pi 1.0.0 (`context_edit`, retain-none компакция); `/context` не падает на compaction-записях; replay показывает маркер `✎`.
- **session-trace**: footer `/trace` больше не обрезается в fullscreen.
- **subagents**: убраны сырые herdr error-конверты и двойной re-label ретрай; steer к завершившемуся — обычный «already finished».
- **package**: peerDependencies подняты до `^1.0.0`, node `>=22.19.0`; аудит цветов под тему pi 1.0.0; raw ANSI в fallbackTheme CLI задокументирован как осознанное решение.

## [0.6.0] — 2026-10-01

### Add

- **subagents**: интеграция с agent-surface herdr — steer-доставка со структурированными исходами, фоновый `wait` как запасной сигнал завершения, стабильные rename-лейблы панелей.

### Fixed

- **ui**: направление jumpMatch (n/N) считается по индексу совпавшей клавиши; клавиши-действия оверлеев резолвятся из единого реестра `shared/keybindings.ts`.

## [0.5.0] — 2026-10-01

### New

- **shared/line-diff**: чистый LCS line-diff с бюджетом и инлайн-подсветкой по графемам, без зависимостей и DOM.
- **payload-capture**: новое расширение — arm-once захват provider-запросов с тройной приватностью (redaction, кап, запись на диск только по `--save` в trusted-проекте).

### Add

- **session-trace**: rolling-история контекста — кольцевой буфер на 20 ходов и prefix-walk-дифф (`deltaTokens`, `changedBlocks`), клавиша `d`.
- **ui**: keybindings-менеджер (`ext.*` действия, `<agentDir>/keybindings.json`), `CancellableLoader` для холодного `/stats`, чипы в `shared/chip.ts`.

### Fixed

- **ui**: ScrollReport переписан на примитивы pi-tui с тем же API.
- **session-recall**: ResultsView переведён на pi-tui SelectList.
- **session-trace**: TraceView переведён на pi-tui Box/ScrollView/HStack.
- **session-ledger**: честная модель stats — usage разделён на main/nested, hit-rate из сумм токенов, индекс v2.

## [0.4.0] — 2026-09-30

### New

- **shared/session-index**: персистентный инкрементальный индекс сессий — `/stats` и `/recall` на общем слое, у recall BM25-подобное ранжирование.
- **quiz**: новое расширение — градируемый вопрос с правильным ответом, `explanation`, авто-вариантом «I don't know» и переключателем note клавишей `n` (порт из learn).
- **skill-auditor**: новое расширение — read-only аудит скиллов (frontmatter, роутинг, битые ссылки, коллизии), `/audit` и `/audit go`, CLI `npm run audit`.

### Add

- **quiz**: веб-режим — Markdown/LaTeX/mermaid в браузере при `web: true`, грейд на сервере (ключей нет даже в devtools), loopback-гард и CSP.

### Fixed

- **session-trace**: локальный сервер веб-вьюера отвечает 403 на не-loopback `Host` (анти-DNS-rebinding), тело `POST /load` ограничено 64 КБ.

## [0.3.0] — 2026-09-24

### New

- **ask-user-question**: инструмент структурированного вопроса (опции, multiSelect, Other), перенесён из глобальных расширений.
- **edit-guard**: новое расширение — страховка edit с фазами нормализации и fuzzy-матчингом, телеметрия pass/patched/blocked.
- **prompt-snippets**: новое расширение — сменные одноцелевые правила промпта (`alt+s` / `/snippets`), перенос из pi-config.

### Add

- **subagents**: `task_batch` — per-task таймаут (`timeoutMs`, дефолт 30 мин) и живой прогресс с текущим инструментом ребёнка.
- **session-trace**: автоплей веб-вьюера в гипер-ускорении с паузой по окончании; любое ручное действие его отменяет, `?noplay=1` отключает.
- **web**: `web_fetch` — страницы в markdown (linkedom + Readability + turndown), PDF через unpdf, SSRF-гард с перепроверкой на каждом редиректе, стримовое чтение с лимитами; браузерный мост через расширение pi-web-companion для JS-rendered страниц (WS на 127.0.0.1, токен-pairing, `/bridge`).

### Fixed

- **web**: выдача DuckDuckGo парсится собственным мини-парсером вместо linkedom (−110–130 мс на старте pi); каталог переименован в `extensions/web`, пакет — `pi-web`; общие сетевые хелперы вынесены в `http.ts`.
- **web**: `package-lock.json` закоммичен.
- **subagents**: live-обновления `task_batch` несут компактные снапшоты; карточка ребёнка и убийство процессов вынесены в общие модули.
- **subagents**: серия багфиксов `task_batch` — убитый ребёнок больше не отчитывается успехом, работает эскалация SIGKILL по всему дереву, отмена не спавнит queued-задачи «на убой», `{previous}` не интерпретирует `$&` и обрезается до 16 КБ, stderr капится, tmp-файл running-index уникален.

### Removed

- **web**: фолбэк Jina Reader — JS-рендеринг теперь в браузере пользователя через мост.
- **web**: зависимость `linkedom`.

## [0.2.0] — 2026-09-15

### Add

- **subagents**: herdr как вторая поверхность панелей; `/workers` и `/workers kill` для живых headless-воркеров; валидация определений агентов, веб-инструменты панелям и `subagents:` во frontmatter.
- **session-trace**: live-панель воркеров в веб-вьюере, зум графа, неразрушающий выбор узла.

### Fixed

- **subagents**: живой UI `task_batch` (вердикт-чипы, прогресс, chain-пайплайн) и единый дизайн-язык панельных инструментов; рендеры вынесены в чистый `render.ts`.
- **subagents**: живучесть таргетинга панелей, stall-детектор учитывает потоковые дельты, превью задачи в single-режиме рендерится.

[0.11.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.11.0
[0.10.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.10.0
[0.9.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.9.0
[0.8.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.8.0
[0.7.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.7.0
[0.6.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.6.0
[0.5.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.5.0
[0.4.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.4.0
[0.3.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.3.0
[0.2.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.2.0
