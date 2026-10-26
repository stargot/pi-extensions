# pi-extensions

Личный pi-пакет: расширения для pi coding agent. Подключается ключом `"pi"` в package.json, все расширения грузятся при старте pi.

| Расширение | Команда | Что делает |
|---|---|---|
| [ask-user-question](extensions/ask-user-question/) | — | Инструмент структурированного вопроса к пользователю: опции с описаниями, multiSelect, свободный ввод |
| [bg-jobs](extensions/bg-jobs/) | `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `/bg`, `/jobs`, `/logs`, `/kill` | Фоновые shell-джобы без блокировки хода: durable-лог в `.pi/jobs/`, wake-ход модели с итогом (exit code + хвост), kill дерева процессов, переживание /reload, виджет running/done (Windows + pwsh; БЕЗ песочницы) |
| [edit-guard](extensions/edit-guard/) | — | Страховка инструмента edit: спасает правки от несовпадений BOM/CRLF/пробелов/отступов и лёгкого дрейфа текста, блокирует ненадёжные с перечнем строк и сниппетами |
| [env-guard](extensions/env-guard/) | `/env-guard` (opt. `rescan`) | Гард секретов: собирает значения из `.env`-семейства и `process.env`, блокирует доступ модели к env-файлам и командам с именами секретных переменных, редактирует значения во вводе, аргументах инструментов, результатах и готовых сообщениях; `/env-guard` показывает статистику, `/env-guard rescan` пересканирует источники |
| [recall](extensions/recall/) | `/recall` | Полнотекстовый поиск по всем сессиям всех проектов с переходом в найденную сессию |
| [trace](extensions/trace/) | `/trace`, `/trace web`, `/trace on`, `/trace off` | Живой flow-граф сессии: карточки ходов, чипы инструментов, маркеры на таймлайне; строка состояния над редактором; плюс CLI и веб-вьюер |
| [skill-auditor](extensions/skill-auditor/) | `/audit` | Read-only аудит скиллов: валидность frontmatter (зеркало фактического поведения pi), роутинг description, битые ссылки и сироты, карта скоупов user vs project; `/audit go` отправляет отчёт модели на семантический разбор (только рекомендации) |
| [subagents](extensions/subagents/) | `subagent`, `task_batch`, `/subagent`, `/workers`, `/prime`, `/solo` | Субагенты: интерактивные в терминальных панелях — WezTerm или herdr (спавн/steer+interrupt/resume/cancel, живой статус) + headless-батчи single/parallel/chain (Windows + pwsh); глобальный индекс живых воркеров; prime-политика основной сессии — протокол оркестратора (инжект prime-промпта + dispatch-таблица объединённого пула, опт-аут `dispatch: false`), бюджеты 3/3/3, виджет, переключатель `/prime` с состоянием в `.pi/prime.json` |
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
| `PI_CODING_AGENT_DIR` | Каталог агента вместо `~/.pi/agent` — sessions, recall, trace, skill-auditor |
| `PI_SUBAGENT_ALLOWED` | subagents: allowlist имён агентов для спавна |
| `PI_SUBAGENT_READONLY` | subagents: при значении `1` в дочерней сессии включается read-only-гард — блокируются `edit`/`write` и мутирующие shell-команды (агент может только читать и отчитываться) |
| `PI_TASK_BATCH_DEPTH` | subagents: глубина вложенных батчей — задаётся самим расширением дочерним процессам |
| `PI_SUBAGENT_SUMMARY_CHARS` | subagents: лимит усечения итога ребёнка и вывода каждой задачи `task_batch`, положительное целое, по умолчанию 8000 символов (в `task_batch` инфорсится по байтам UTF-8); невалидное значение молча даёт дефолт |
| `PI_SUBAGENT_NAME` / `PI_SUBAGENT_AGENT` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_SESSION` / `PI_SUBAGENT_AUTO_EXIT` / `PI_SUBAGENT_ACTIVITY_FILE` | subagents: контекст ребёнка — задаётся расширением при спавне |
| `HERDR_ENV` / `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID` | subagents: детект запуска под herdr — задаёт сам herdr |
| `WEZTERM_PANE` | subagents: детект запуска в панели WezTerm — задаёт WezTerm |
| `PI_WEB_BRIDGE_PORT` / `PI_WEB_BRIDGE_PORTS` | web bridge: порт или диапазон портов (по умолчанию 8790–8799) |
| `PI_BROWSER_ENABLED` | браузерные инструменты (`browser_*`): при значении `1` стартуют включёнными — задаётся расширением subagents при спавне ребёнка с браузерными тулами в allowlist (ребёнок не может сам набрать `/browser on`) |
| `PI_WEB_BRIDGE_TOKEN` / `PI_WEB_BRIDGE_TOKEN_FILE` | web bridge: токен аутентификации или файл с ним |
| `HOME` / `USERPROFILE` | Домашний каталог (нативные) — subagents |
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
npm run recall       # recall
npm run audit        # skill-auditor
npm run trace        # trace, терминальный вьюер
npm run trace:web    # trace, веб-вьюер
```

Подробнее — README внутри каждой папки в `extensions/`.

## Лицензия

[MIT](LICENSE) © Ivan Sinyavskiy.
