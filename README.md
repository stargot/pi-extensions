# pi-extensions

Личный pi-пакет: расширения для pi coding agent. Подключается ключом `"pi"` в package.json, все расширения грузятся при старте pi.

| Расширение | Команда | Что делает |
|---|---|---|
| [ask-user-question](extensions/ask-user-question/) | — | Инструмент структурированного вопроса к пользователю: опции с описаниями, multiSelect, свободный ввод |
| [context-inspector](extensions/context-inspector/) | `/context` | Что реально видит модель: занятость окна, доля кэша, состав system prompt, вес схем инструментов, самые тяжёлые сообщения |
| [edit-guard](extensions/edit-guard/) | — | Страховка инструмента edit: спасает правки от несовпадений BOM/CRLF/пробелов/отступов и лёгкого дрейфа текста, блокирует ненадёжные с перечнем строк и сниппетами |
| [prompt-snippets](extensions/prompt-snippets/) | `alt+s`, `/snippets` | Сменные правила промпта: чекбоксы-сниппеты, вклеиваются до/после сообщения на один ход. На основе расширения Eero Alvar (amosblomqvist) |
| [quiz](extensions/quiz/) | `/quiz-web` | Градируемый вопрос с вариантами: правильный ответ по value, мгновенная оценка ✓/✗ с пояснением, шаффл, авто-вариант «I don't know», поле note (Tab или n); веб-режим — вопрос в браузере с Markdown/LaTeX/mermaid по `web: true`. На основе расширения Eero Alvar (amosblomqvist) |
| [session-handoff](extensions/session-handoff/) | `/handoff` | Автодамп состояния сессии при выходе (последний запрос/ответ, git-статус) и подхват на следующем старте: просмотр, продолжение с промптом, очистка |
| [session-ledger](extensions/session-ledger/) | `/stats` | Расходы и активность по всем сессиям на машине: стоимость, токены, кэш, вызовы и ошибки инструментов, компакции |
| [session-recall](extensions/session-recall/) | `/recall` | Полнотекстовый поиск по всем сессиям всех проектов с переходом в найденную сессию |
| [session-trace](extensions/session-trace/) | `/trace`, `/trace-web` | Живой flow-граф сессии: карточки ходов, чипы инструментов, маркеры на таймлайне; плюс CLI и веб-вьюер |
| [skill-auditor](extensions/skill-auditor/) | `/audit` | Read-only аудит скиллов: валидность frontmatter (зеркало фактического поведения pi), роутинг description, битые ссылки и сироты, карта скоупов user vs project; `/audit go` отправляет отчёт модели на семантический разбор (только рекомендации) |
| [subagents](extensions/subagents/) | `subagent`, `task_batch`, `/subagent`, `/workers` | Субагенты: интерактивные в терминальных панелях — WezTerm или herdr (спавн/steer+interrupt/resume/cancel, живой статус) + headless-батчи single/parallel/chain (Windows + pwsh); глобальный индекс живых воркеров |
| [web](extensions/web/) | `web_search`, `web_fetch`, `/bridge` | Веб-поиск DuckDuckGo без API-ключей: структурированные запросы (точные фразы/исключения/сайт), таймаут и ретрай; плюс fetch страницы → markdown (Readability/Turndown, PDF, текст, браузерный мост pi-web-companion для JS-rendered, SSRF-гард). На основе расширения Eero Alvar (amosblomqvist) |

## Совместимость

- pi >= 1.0.0, Node >= 22.19.0 (peerDependencies `@earendil-works/pi-coding-agent` и
  `@earendil-works/pi-tui` закреплены на `^1.0.0`).
- pi 1.0.0 по умолчанию использует fullscreen TUI и тему «system» — расширения пакета
  проверены в этом режиме (ручной чеклист — финальный гейт релиза).

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
npm run stats        # session-ledger
npm run recall       # session-recall
npm run audit        # skill-auditor
npm run trace        # session-trace, терминальный вьюер
npm run trace:web    # session-trace, веб-вьюер
```

Подробнее — README внутри каждой папки в `extensions/`.

## Лицензия

[MIT](LICENSE) © Ivan Sinyavskiy. Атрибуция заимствованного кода — в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
