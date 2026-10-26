# TODO

> **type:** backlog · **status:** active · **date:** 2026-10-22 · **last-verified:** 2026-10-25
*Источники происхождения RESEARCH.md и better-ui-analyse.md удалены из docs/ (см. git history и CHANGELOG «Unreleased» → Docs).*

## pi-extensions

- [ ] Investigate flaky subagents test: one `npm run check` run during the v0.8.0 release reported 842/843 (test identity lost to output filtering); three consecutive re-runs on the identical tree were green. Suspected timing sensitivity. Related: `5e5709c fix(subagents): stale pane-list snapshot falsely crashed freshly spawned panes` (merged as `001d0c0`) may already address the crash class — verify whether the flake reproduces on top of it, close the item if not. Assignee: investigator.
- [ ] env-guard: implement `context`/`context_with_system` hook as a full-history scrubber — defense against mid-token split of a secret value across two steer messages (per-event filtering cannot reassemble fragments; each fragment alone is inert). Backlog, not a blocker; document the residual limit in README if deferred indefinitely. Assignee: worker, reviewed by security-auditor.
- [ ] web: перемерить долю отказов DDG на текущей версии (POST + полный набор браузерных заголовков + ретрай могли заметно снизить прежние 25%) — фолбэк-бэкенды решать только по свежим цифрам (из RESEARCH.md §1.1)
- [ ] web: диск-TTL кэш для web_search и web_fetch — кэша нет нигде, дешёвый win (из RESEARCH.md §1.1)
- [ ] web: укрепить детект challenge — сейчас наивный regex `/anomaly|challenge|captcha/i`; ретраи фиксированы (1, без jitter/настроек) (из RESEARCH.md §1.1)
- [ ] web: DNS-rebinding — опционально pin IP первого резолва (из RESEARCH.md §1.1)
- [ ] web/pi-web-companion: bridge не рендерит PDF (документировано; упасть бы не молча — warning в details уже есть) (из RESEARCH.md §1.1)
- [ ] subagents/trace: метрики делегирования — считать долю ходов, где prime делал сам при наличии кандидатов на делегирование; показать в `/trace` или `/stats` (из RESEARCH.md §1.2)
- [ ] Телеметрия использования команд: каждое расширение пишет `pi.appendEntry("ext_usage", { ext, cmd })` при вызове команды — командные расширения невидимы в транскриптах (из RESEARCH.md §2.1)
- [ ] /commit flow: команда `/commit` — анализ diff → план атомарных коммитов → confirm-диалог (`ctx.ui.confirm`) → прогон; опционально `/commit push` (из RESEARCH.md §3.3)
- [ ] session-digest: `/digest [period] [project]` — прогон анализа по общему индексу сессий через task_batch, отчёт в md (из RESEARCH.md §3.5)
- [ ] ui: заменить `shared/scroll-report.ts` на `ScrollView`+`Box`/`VStack` pi-tui; обновить trace, recall и прочих потребителей разом — scroll-report.ts жив, используется trace/graph.ts и recall (из better-ui-analyse.md T1)
