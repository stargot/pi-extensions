# prompt-snippets — сменные правила промпта для pi

Крошечные одноцелевые правила, которые вклеиваются в сообщение перед
отправкой: **alt+s** или **/snippets** открывают меню с чекбоксами, активные
сниппеты вставляются до (prepend) или после (append) текста. В отличие от
скиллов это не постоянные инструкции, а одноразовые модификаторы на одно
сообщение: после каждой отправки тогглы сбрасываются в off.

Основа — расширение **prompt-snippets** автора **Eero Alvar
([amosblomqvist](https://github.com/amosblomqvist))** из
[pi-config](https://github.com/amosblomqvist/pi-config/tree/main/extensions/prompt-snippets),
перенесено в этот пакет без изменений логики.

## Использование

- **alt+s** / **/snippets** — меню: `↑↓` навигация, `space` тоггл,
  `tab` предпросмотр (имя, placement, order, файл, полное тело; `↑↓` — скролл,
  `tab`/`esc` — назад к списку с сохранением курсора), `enter` применить,
  `esc` отменить. Список скроллится, высота подстраивается под терминал,
  при обрезке показываются `↑ n more` / `↓ n more`.
- Активные сниппеты видны виджетом над редактором:
  `↑ prepend: ...` (accent) — вставится до сообщения,
  `↓ append: ...` (warning) — после.
- При отправке: тела prepend-группы (по `order`) → твой текст → тела
  append-группы (по `order`), раздельно пустой строкой.
- Тогглы сбрасываются в **off** после каждой отправки и на старте сессии.

## Сниппеты

Лежат в `~/.pi/agent/snippets/` — по одному markdown-файлу на сниппет,
с frontmatter:

```markdown
---
name: Concise
description: Keep answers short and to the point
placement: prepend
order: 10
---
Keep your response concise. Skip preamble and unnecessary explanation.
```

| Поле | Обязателен | Заметки |
|---|---|---|
| `name` | нет | Имя в меню; по умолчанию имя файла без `.md` |
| `description` | нет | Показывается рядом с именем в меню |
| `placement` | нет | `prepend` или `append` (по умолчанию `append`) |
| `order` | нет | Число; сортировка внутри группы — в меню и в собранном тексте (по умолчанию `9999`, при равенстве — по имени) |

В комплекте шесть сниппетов: Session kickoff, Orchestrator mode (prepend) и
Ask questions, Verify don't assume, Delegate exploration, Diagnose don't fix
(append).

Файлы перечитываются при каждом открытии меню и каждой отправке — правки
вступают в силу сразу, без перезагрузки pi.
