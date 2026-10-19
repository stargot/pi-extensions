# pi-extensions

Личный pi-пакет: расширения для pi coding agent. Подключается ключом `"pi"` в package.json, все расширения грузятся при старте pi.

| Расширение | Команда | Что делает |
|---|---|---|
| [ask-user-question](extensions/ask-user-question/) | — | Инструмент структурированного вопроса к пользователю: опции с описаниями, multiSelect, свободный ввод |
| [bg-jobs](extensions/bg-jobs/) | `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `/bg`, `/jobs`, `/logs`, `/kill` | Фоновые shell-джобы без блокировки хода: durable-лог в `.pi/jobs/`, wake-ход модели с итогом (exit code + хвост), kill дерева процессов, переживание /reload, виджет running/done (Windows + pwsh; БЕЗ песочницы) |
| [context-inspector](extensions/context-inspector/) | `/context` | Что реально видит модель: занятость окна, доля кэша, состав system prompt, вес схем инструментов, самые тяжёлые сообщения |
| [edit-guard](extensions/edit-guard/) | — | Страховка инструмента edit: спасает правки от несовпадений BOM/CRLF/пробелов/отступов и лёгкого дрейфа текста, блокирует ненадёжные с перечнем строк и сниппетами |
| [prompt-snippets](extensions/prompt-snippets/) | `alt+s`, `/snippets` | Сменные правила промпта: чекбоксы-сниппеты, вклеиваются до/после сообщения на один ход. На основе расширения Eero Alvar (amosblomqvist) |
| [prime-protocol](extensions/prime-protocol/) | `/solo` | Протокол оркестратора для основных сессий: инжект prime-промпта (тело agents/prime.md + бюджетная строка из констант + dispatch-таблица, генерируемая сканом agents/*.md, опт-аут `dispatch: false`), виджет prime-status, принудительный solo-кап на лукапы и правки (лимиты — константы расширения, +бюджет за каждого отправленного агента) с детьми-детектом |
| [quiz](extensions/quiz/) | — | Градируемый вопрос с вариантами: правильный ответ по value, мгновенная оценка ✓/✗ с пояснением, шаффл, авто-вариант «I don't know», поле note (Tab или n). На основе расширения Eero Alvar (amosblomqvist) |
| [usage](extensions/usage/) | `/stats` | Расходы и активность по всем сессиям на машине: стоимость, токены, кэш, вызовы и ошибки инструментов, компакции |
| [recall](extensions/recall/) | `/recall` | Полнотекстовый поиск по всем сессиям всех проектов с переходом в найденную сессию |
| [trace](extensions/trace/) | `/trace`, `/trace-web` | Живой flow-граф сессии: карточки ходов, чипы инструментов, маркеры на таймлайне; плюс CLI и веб-вьюер |
| [skill-auditor](extensions/skill-auditor/) | `/audit` | Read-only аудит скиллов: валидность frontmatter (зеркало фактического поведения pi), роутинг description, битые ссылки и сироты, карта скоупов user vs project; `/audit go` отправляет отчёт модели на семантический разбор (только рекомендации) |
| [subagents](extensions/subagents/) | `subagent`, `task_batch`, `/subagent`, `/workers` | Субагенты: интерактивные в терминальных панелях — WezTerm или herdr (спавн/steer+interrupt/resume/cancel, живой статус) + headless-батчи single/parallel/chain (Windows + pwsh); глобальный индекс живых воркеров |
| [web](extensions/web/) | `web_search`, `web_fetch`, `/bridge` | Веб-поиск DuckDuckGo без API-ключей: структурированные запросы (точные фразы/исключения/сайт), таймаут и ретрай; плюс fetch страницы → markdown (Readability/Turndown, PDF, текст, браузерный мост pi-web-companion для JS-rendered, SSRF-гард). На основе расширения Eero Alvar (amosblomqvist) |

## Совместимость

- pi >= 1.0.0, Node >= 22.19.0 (peerDependencies `@earendil-works/pi-coding-agent` и
  `@earendil-works/pi-tui` закреплены на `^1.0.0`).
- pi 1.0.0 по умолчанию использует fullscreen TUI и тему «system» — расширения пакета
  проверены в этом режиме (ручной чеклист — финальный гейт релиза).

## Environment variables

Расширения читают переменные окружения напрямую; `web` при старте подхватывает `.env` из
рабочего каталога и вверх по дереву (уже установленные переменные не перезаписывает;
`.env` в gitignored). `env-guard` сканирует весь `process.env` на секреты — именованных
переменных не читает.

| Переменная | Назначение |
|---|---|
| `PI_CODING_AGENT_DIR` | Каталог агента вместо `~/.pi/agent` — sessions, recall, usage, trace, skill-auditor |
| `PI_SNIPPETS_DIR` | Каталог сниппетов prompt-snippets вместо `~/.pi/agent/snippets` |
| `PI_SUBAGENT_ALLOWED` | subagents: allowlist имён агентов для спавна |
| `PI_TASK_BATCH_DEPTH` | subagents: глубина вложенных батчей — задаётся самим расширением дочерним процессам |
| `PI_SUBAGENT_NAME` / `PI_SUBAGENT_AGENT` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_SESSION` / `PI_SUBAGENT_AUTO_EXIT` / `PI_SUBAGENT_ACTIVITY_FILE` | subagents: контекст ребёнка — задаётся расширением при спавне |
| `HERDR_ENV` / `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID` | subagents: детект запуска под herdr — задаёт сам herdr |
| `WEZTERM_PANE` | subagents: детект запуска в панели WezTerm — задаёт WezTerm |
| `PI_WEB_SEARCH_PROVIDER` | web: провайдер поиска (`langsearch`), по умолчанию DuckDuckGo |
| `LANGSEARCH_API_KEY` | web: API-ключ LangSearch |
| `PI_WEB_BRIDGE_PORT` / `PI_WEB_BRIDGE_PORTS` | web bridge: порт или диапазон портов (по умолчанию 8790–8799) |
| `PI_WEB_BRIDGE_TOKEN` / `PI_WEB_BRIDGE_TOKEN_FILE` | web bridge: токен аутентификации или файл с ним |
| `HOME` / `USERPROFILE` | Домашний каталог (нативные) — context-inspector, subagents |
| `PI_TRACE_MODE` | Только тесты trace: `live` / `replay` |

## Запуск

Требования к pi и Node — в разделе «Совместимость».

```bash
npm run check    # гейт: lint + format-check + type + test (то же гоняет CI)
npm test         # тесты всех расширений
npm run format   # отформатировать код (biome)
npm run coverage # покрытие по файлам (вне гейта)
npm run smoke    # проверить, что расширения грузятся в pi
```

### Установка и обновление

Пакет устанавливается в pi напрямую из git-репозитория — pi клонирует его в `~/.pi/agent/git/github.com/stargot/pi-extensions` и грузит расширения оттуда:

```bash
pi install git:github.com/stargot/pi-extensions
```

Чтобы применить правки: `git push` из этого репозитория, затем `pi update --extensions` — pi подтянет клон до актуального состояния и при необходимости прогонит `npm install`. Если пакет установлен на закреплённый ref (`@тег` или коммит), обновление не сдвигает его — переместить на новый ref можно повторной установкой: `pi install git:github.com/stargot/pi-extensions@<ref>`.

Каждое расширение работает и без pi — через CLI:

```bash
npm run stats        # usage
npm run recall       # recall
npm run audit        # skill-auditor
npm run trace        # trace, терминальный вьюер
npm run trace:web    # trace, веб-вьюер
```

Подробнее — README внутри каждой папки в `extensions/`.

## Лицензия

[MIT](LICENSE) © Ivan Sinyavskiy. Атрибуция заимствованного кода — в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
