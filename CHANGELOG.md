# Changelog

All notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/), versioning: semver.

## [0.2.0] — 2026-09-15

### Added

- **subagents**: herdr как вторая поверхность панелей — если pi запущен внутри
  herdr, сплиты идут через `herdr pane`, иначе через `wezterm cli` (mux-диспетчер,
  паритет API); завершившиеся панели схлопываются на обеих поверхностях.
- **subagents**: `/workers` — живые headless task_batch-воркеры на всей машине
  (id, pid, elapsed, задача, session-файл) и `/workers kill <id|pid>`.
- **subagents**: валидация определений агентов при спавне; дочерним панелям
  можно разрешить веб-инструменты; субагентам можно разрешить спавн собственных
  детей (`subagents:` во frontmatter).
- **session-trace**: live-панель воркеров в веб-вьювере, раскладка 60/40,
  зум графа, неразрушающий выбор узла.

### Changed

- **subagents**: task_batch получил живой UI — вердикт-чипы (running/ok/fail),
  прогресс-бар, спиннеры, компактные строки, chain-пайплайн, рамочные карточки
  в expanded-режиме.
- **subagents**: панельные инструменты (`subagent`, `subagent_message`,
  `subagent_cancel`, `subagents_list`) приведены к тому же дизайн-языку —
  вердикт-чипы, error-баннеры; сообщение о завершении субагента рендерится
  карточкой с вердиктом, usage в футере и Markdown-резюме; виджет показывает
  фазу каждого субагента (спиннер / ⚠ stalled / красный спиннер при отмене).
  Рендеры вынесены в чистый модуль `render.ts` и покрыты `test/render.test.ts`.

### Fixed

- **subagents**: живучесть таргетинга панелей (закрывшиеся панели больше не
  выбираются сплит-целью), stall-детектор учитывает потоковые дельты модели,
  управляемые interrupt/cancel-механики.
- **subagents**: превью задачи в `task_batch` single-режиме теперь
  действительно рендерится (TruncatedText терял вторую строку); legacy-записи
  без `details.summary` больше не показывают карточку с «(no summary)».

[0.2.0]: https://github.com/stargot/pi-extensions/releases/tag/v0.2.0
