# Документация

Протокол ведения `docs/`: типы документов, статусы, нейминг, индекс и правила
сопровождения. При создании или правке любого дока — сначала прочитай этот файл;
индекс ниже — истина о том, что живёт в каталоге.

## Карта каталога

```text
docs/
  README.md     — индекс + протокол (living, этот файл)
  decisions/    — ADR: принятые архитектурные решения
  specs/        — дизайн-спеки расширений
```

Тип документа кодируется каталогом; в имени файла тип не дублируется.

## Корневые файлы

Живут в корне репозитория, вне docs/, но подчиняются этому протоколу:

- `README.md` — витрина проекта, living. Sync-триггер: добавление/удаление
  расширения → в том же коммите обновляются package.json, таблица расширений
  и env-таблица README.
- `TODO.md` — канонический living-backlog проекта (машиночитаемый заголовок,
  статусы active/closed). Все пункты закрыты → пересобрать файл или удалить.
- `CHANGELOG.md` — Keep a Changelog, Unreleased (уже зафиксировано в AGENTS.md).
- `AGENTS.md` — конвенции для агентов + указатель на этот протокол.

## Индекс

Индекс пересобирается на каждом аудите (grep статусов по заголовкам — см. п. 6).

| Док | Тип | Статус | Дата | Last verified | Примечание |
|---|---|---|---|---|---|
| `decisions/2026-10-21-prime-subagents-merge.md` | adr | accepted | 2026-10-21 | 2026-10-25 @ Unreleased | слияние prime-protocol → subagents (см. CHANGELOG Unreleased) |
| `specs/2026-10-01-bg-jobs.md` | spec | implemented | 2026-10-01 | 2026-10-25 @ v0.9.0 | дизайн живого расширения bg-jobs |
| `TODO.md` (корень) | backlog | active | — | 2026-10-25 | канонический backlog проекта |

## Жизненный цикл

| Тип | Переходы | Правила |
|---|---|---|
| adr | draft → accepted → superseded | После accepted контент immutable — правится только строка заголовка и supersedes-ссылки. Не имеет статуса implemented: решение вечно, исполнение видно в CHANGELOG. |
| spec | draft → accepted → implemented → archived | Статус обязан отражать реальность. implemented — постоянный якорь дизайна. archived — только при вытеснении новой спекой. |
| research | active → stale → archived | Снимок знания; живёт по полю last-verified. Без перепроверки > 6 мес → stale. |
| backlog | active → closed | Живёт только при ≥ 1 открытом пункте. Все закрыты → удалить файл (история в git/CHANGELOG). |

## Нейминг

- Снимочные доки (adr, spec, research-заметка): `YYYY-MM-DD-<slug>.md`.
- Living-доки (индекс, backlog): без даты в имени (`TODO.md` в корне,
  `README.md` здесь); дата живёт в last-verified, не в имени файла.
  Backlog живёт в корне как `TODO.md`, а не в docs/.

## Обязательный заголовок

Сразу под H1 каждого дока — blockquote, машиночитаемый:

```markdown
> **type:** adr · **status:** accepted · **date:** 2026-10-21 · **last-verified:** 2026-10-25 @ vX.Y.Z
> **supersedes:** — · **superseded-by:** — · **see-also:** CHANGELOG «Unreleased»
```

- `last-verified` = «против чего проверено»: дата + версия пакета, коммит или
  якорь CHANGELOG.
- `supersedes` / `superseded-by` / `see-also` — относительные пути; «—» если пусто.
- Формат полей строгий: литералы `status:` и `last-verified:` должны
  присутствовать в каждом заголовке — только тогда работает аудит.
- Аудит заголовков:

```sh
grep -rEn '\*\*(type|status|last-verified):\*\*' docs --include='*.md'
```

Исключение — сам `docs/README.md` (индекс хранит статусы в таблице).

## Триггеры сопровождения

1. Merge фичи → в том же коммите: спека → `implemented`, обновить её
   `last-verified`, изменение отражено в CHANGELOG Unreleased.
2. Удаление расширения → в том же коммите: запись в package.json снята,
   `grep -rn '<name>' extensions/ docs/ package.json` вычищен, спеки →
   `archived`, живые research-пункты об этом расширении удалены.
3. Изменение принятого решения → только новый ADR с `supersedes`; старый
   ADR не редактируется (получает `superseded-by`).
4. Новый док → строка в индекс этого файла в том же коммите.

## Правила ссылок

- Из кода (комментарии) и README расширений ссылаться можно только на ADR
  (`decisions/`, статус accepted/superseded) и спеки в статусе implemented —
  они стабильны по путям и содержанию.
- На research и backlog из кода ссылаться нельзя — они удаляемы. Факт либо
  инлайнится в код, либо уходит в ADR.
- Между доками ссылки свободные.
- Док без входящих ссылок (проверка: grep по `extensions/`, `scripts/`,
  `package.json`, `AGENTS.md`, `docs/`) и в статусе не-draft — кандидат на
  удаление или архив; решение принимает аудит.

## Аудит

Проводится на каждом minor-релизе (исполнитель — releaser); минимум — раз в
квартал. Чеклист:

1. Статус в заголовке каждого дока = реальность (сверка с кодом и CHANGELOG).
2. Grep входящих ссылок; сироты помечены и вынесены на решение.
3. Упоминания удалённых расширений вычищены.
4. `last-verified` старше 6 мес → перепроверить док или пометить stale.
5. Индекс в этом файле пересобран.

## Шаблоны

ADR:

```markdown
# <Заголовок решения>

> **type:** adr · **status:** draft · **date:** YYYY-MM-DD · **last-verified:** YYYY-MM-DD @ <версия/коммит>
> **supersedes:** — · **superseded-by:** — · **see-also:** —

## Контекст

## Решение

## Последствия

## Отвергнутые альтернативы
```

Спека:

```markdown
# Спека: <название>

> **type:** spec · **status:** draft · **date:** YYYY-MM-DD · **last-verified:** YYYY-MM-DD @ <версия/коммит>
> **supersedes:** — · **superseded-by:** — · **see-also:** —

## Резюме

## Дизайн

## Тестирование
```

Backlog:

```markdown
# TODO

> **type:** backlog · **status:** active · **date:** — · **last-verified:** YYYY-MM-DD @ <версия/коммит>

- [ ] <пункт> — источник: <док/сессия, откуда пришёл>
```

## Интеграция

В корневой `AGENTS.md`, раздел Conventions, добавляется строка-указатель
(точный текст; правка AGENTS.md — отдельный шаг плана, здесь только фиксация):

```text
Docs live under docs/ and follow the protocol in docs/README.md (types, statuses, naming, index); user-visible doc changes go to CHANGELOG under Unreleased.
```

Правило: user-visible доковские изменения (переезды файлов, пересборка
индекса, изменения протокола) документируются в CHANGELOG под Unreleased.
