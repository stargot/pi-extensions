# BACKLOG: skill-auditor — аудит скиллов pi (механический lint + семантический разбор)

Дата: 2026-09-30 · Статус: план к исполнению (worker-задачи, 7 штук, порядок линейный)
Цель: расширение `extensions/skill-auditor/` — read-only аудит скиллов: валидность
frontmatter, роутинг, ссылки, обезличенность, карта скоупов; по команде — отправка
механического отчёта модели для семантических рекомендаций (пересечения, кандидаты
в проектные/`disable-model-invocation`). Файлы скиллов никогда не двигаются и не правятся.

## 0. Проверенные факты (scout, не догадки)

- Гейт репо: `npm run check` = biome lint + format-check (табы, 120) + `tsc --noEmit`
  + `node --test extensions/**/test/*.test.ts`. Новые тесты подхватываются glob-ом.
- Парсер frontmatter — прецедент `extensions/subagents/agents.ts`: минимальное
  YAML-подмножество (key: value, кавычки, CRLF), без зависимостей. Новых зависимостей
  не добавляем.
- Discovery pi (docs/skills.md; ПОРЯДОК исправлен по итогам reviewer, сверка с dist 0.85.1
  package-manager.addAutoDiscoveredResources): (1) `<cwd>/.pi/skills`, (2) `.agents/skills`
  предков от cwd до корня репо (есть `.git`) — оба проектных места pi гейтит флагом trusted,
  (3) `<agentDir>/skills`, (4) `~/.agents/skills`; first-wins → проектный скилл побеждает
  пользовательский при коллизии. `SKILL.md` ищется рекурсивно; коллизии имён — первый найденный
  + warning; «кривой» SKILL.md или пустой description — pi молча НЕ ГРУЗИТ; description >1024 —
  у pi лишь warning-диагностика, скилл ГРУЗИТСЯ (тоже уточнено reviewer'ом — не отказ загрузки);
  name ≠ каталогу — pi не предупреждает.
  Spec-поля: name, description, license, compatibility, metadata, allowed-tools,
  disable-model-invocation. name: строчные/цифры/дефисы, без ведущих/хвостовых/подряд
  идущих, ≤64; description ≤1024.
- Agent-dir: в `index.ts` — `getAgentDir()` из pi-coding-agent; в чистых модулях/CLI —
  `$PI_CODING_AGENT_DIR || ~/.pi/agent` (прецедент `shared/sessions.ts`).
- Инжект промпта: `ctx.ui.confirm` → `pi.sendUserMessage` (прецедент `/handoff go`);
  рендер отчёта — `ScrollReport` из `../shared/scroll-report.ts`, вне TUI — notify.
- CLI-стиль: `main(argv)` + `process.exit(main(...))`, `--json` (прецедент session-recall).

## Зафиксированные решения (не пересматривать)

- Имя `skill-auditor`; скоуп v1 — только глобал + проектные `.agents/skills`
  (пакетные/npm-локации — не в v1). Строго read-only.
- Домовой стиль: двойной режим — команда pi `/audit` + автономный CLI
  `node extensions/skill-auditor/cli.ts` (npm-скрипт `audit`).
- Две половины: детерминированный lint (весь в тестах) + LLM-разбор как
  инжектированный промпт (только рекомендации).

## Задачи

### T1 [S] Скаффолд + парсер frontmatter + discovery
- Файлы: `extensions/skill-auditor/skills.ts`, `index.ts` (заглушка),
  `test/skills.test.ts`, `package.json` (путь в `"pi".extensions`).
- `skills.ts` (чистый, без pi-импортов): типы `SkillRecord` (name, dirName,
  description, поля frontmatter, disableModelInvocation, body, dir, scope,
  location, инвентарь относительных путей файлов), `parseSkillFrontmatter`
  (→ attrs/body/malformed), `validateSkillName`, `discoverSkillLocations(cwd, env)`
  (глобал + цепочка `.agents/skills` с стопом на `.git`), `discoverSkills`
  (рекурсивный обход, коллизии first-wins, нечитаемое — skip).
- Критерий: тесты parse/name/locations/рекурсии/коллизий зелёные; `npm run check`.

### T2 [S] Ядро механического lint
- Файлы: `extensions/skill-auditor/lint.ts`, `test/lint.test.ts`. Только данные
  из discovery, без fs.
- `Finding { skill, severity: error|warning|info, code, message }`, коды:
  `skill-unloadable` (error: нет frontmatter / пустой description — pi молча не грузит),
  `name-invalid` (warning), `name-dir-mismatch` (warning), `description-too-long`
  (error, >1024), `unknown-frontmatter-key` (info), `name-collision` (warning),
  `broken-reference` (warning: относительные пути из бэктиков и `](…)`-ссылок,
  не http/#/absolute, нет в инвентаре), `orphan-file` (info),
  `vague-description` (warning, эвристика «use when»/триггеров),
  `personal-content` (warning: `C:\Users\<user>`, `/Users/<user>`, `/home/<user>`,
  email, username параметром). Плюс карта скоупов (глобал vs проект для cwd).
- Критерий: каждый код покрыт тестом; `npm run check`.

### T3 [S] Рендер отчёта
- Файлы: `extensions/skill-auditor/report.ts`, `test/report.test.ts`.
- `buildReport(result, { now? }): string` — markdown: шапка (cwd, дата), карта
  скоупов, находки по severity, счётчики; `reportToJson(result)`. Один источник
  для CLI, команды и промпта.
- Критерий: детерминированные тесты (инжект now); `npm run check`.

### T4 [P] CLI
- Файлы: `extensions/skill-auditor/cli.ts`, `package.json` (скрипт `"audit"`).
- Флаги: `[--json] [--dir <cwd>] [--agent-dir <dir>] [-h]`; exit 0 (advisory).
- Критерий: `node extensions/skill-auditor/cli.ts` печатает отчёт; `--json` —
  валидный JSON; `npm run check`.

### T5 [P] Команда pi `/audit` (минимальный UI)
- Файлы: `extensions/skill-auditor/index.ts` (заменить заглушку).
- `registerCommand("audit")`: отчёт в `ScrollReport` (TUI) / notify вне TUI,
  подсказка «go — семантический разбор».
- Критерий: `npm run smoke`; `npm run check`.

### T6 [S] Семантический промпт-инжект (`/audit go`)
- Файлы: `extensions/skill-auditor/prompt.ts` (+`test/prompt.test.ts`), `index.ts`.
- `buildSemanticPrompt(report, cwd)`: качество роутинга, пересечения скиллов,
  кандидаты global→`.agents/skills` и на `disable-model-invocation`; явное
  «только рекомендации, файлы не двигать/не править». В `index.ts`: confirm →
  `pi.sendUserMessage` (прецедент `/handoff go`).
- Критерий: тесты промпта; `npm run smoke`; `npm run check`.

### T7 [S] Документация
- Файлы: `extensions/skill-auditor/README.md`, корневой `README.md` (строка таблицы
  + `npm run audit`), `CHANGELOG.md` (`[Unreleased] → Added`).
- Критерий: grep находит запись в корневом README и CHANGELOG; `npm run check`.

## Порядок и параллельность

T1 → T2 → T3 → { T4 ∥ T5 } → T6 → T7. Каждый шаг — одна worker-сессия,
гейт каждого шага — `npm run check`.

## Риски

- Парсер — подмножество YAML: вложенный `metadata` не разбирается глубоко
  (ASSUMPTION: у пользовательских скиллов нет многострочных YAML-значений).
- Корень репо = каталог с `.git` (зеркалит доки pi); worktree-кейсы могут стопнуть
  цепочку раньше — приемлемо для v1.
- `vague-description` — эвристика по англ. триггерам; русские description будут
  флагаться (warning + оговорка в README).
