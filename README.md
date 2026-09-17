# pi-extensions

Личный pi-пакет: расширения для pi coding agent. Подключается ключом `"pi"` в package.json, все расширения грузятся при старте pi.

| Расширение | Команда | Что делает |
|---|---|---|
| [context-inspector](extensions/context-inspector/) | `/context` | Что реально видит модель: занятость окна, доля кэша, состав system prompt, вес схем инструментов, самые тяжёлые сообщения |
| [prompt-snippets](extensions/prompt-snippets/) | `alt+s`, `/snippets` | Сменные правила промпта: чекбоксы-сниппеты, вклеиваются до/после сообщения на один ход. На основе расширения Eero Alvar (amosblomqvist) |
| [session-ledger](extensions/session-ledger/) | `/stats` | Расходы и активность по всем сессиям на машине: стоимость, токены, кэш, вызовы и ошибки инструментов, компакции |
| [session-recall](extensions/session-recall/) | `/recall` | Полнотекстовый поиск по всем сессиям всех проектов с переходом в найденную сессию |
| [session-trace](extensions/session-trace/) | `/trace`, `/trace-web` | Живой flow-граф сессии: карточки ходов, чипы инструментов, маркеры на таймлайне; плюс CLI и веб-вьюер |
| [subagents](extensions/subagents/) | `subagent`, `task_batch`, `/subagent`, `/workers` | Субагенты: интерактивные в терминальных панелях — WezTerm или herdr (спавн/steer+interrupt/resume/cancel, живой статус) + headless-батчи single/parallel/chain (Windows + pwsh); глобальный индекс живых воркеров |
| [web](extensions/web/) | `web_search`, `web_fetch` | Веб-поиск DuckDuckGo без API-ключей: структурированные запросы (точные фразы/исключения/сайт), таймаут и ретрай; плюс fetch страницы → markdown (Readability/Turndown, PDF, текст, Jina-фолбэк для JS-rendered, SSRF-гард). На основе расширения Eero Alvar (amosblomqvist) |

## Запуск

Требуется Node >= 22.18.

```bash
npm test   # тесты всех расширений
npm smoke  # проверить, что расширения грузятся в pi
```

### Установка и обновление

Пакет устанавливается в pi напрямую из git-репозитория — pi клонирует его в `~/.pi/agent/git/github.com/stargot/pi-extensions` и грузит расширения оттуда:

```bash
pi install git:github.com/stargot/pi-extensions
```

Чтобы применить правки: `git push` из этого репозитория, затем `pi update --extensions` — pi подтянет клон до актуального состояния и при необходимости прогонит `npm install`. Если пакет установлен на закреплённый ref (`@тег` или коммит), обновление не сдвигает его — переместить на новый ref можно повторной установкой: `pi install git:github.com/stargot/pi-extensions@<ref>`.

Каждое расширение работает и без pi — через CLI:

```bash
npm run stats        # session-ledger
npm run recall       # session-recall
npm run trace        # session-trace, терминальный вьюер
npm run trace:web    # session-trace, веб-вьюер
```

Подробнее — README внутри каждой папки в `extensions/`.
