# TODO

## pi-extensions

- [ ] Investigate flaky subagents test: one `npm run check` run during the v0.8.0 release reported 842/843 (test identity lost to output filtering); three consecutive re-runs on the identical tree were green. Suspected timing sensitivity. Related: `5e5709c fix(subagents): stale pane-list snapshot falsely crashed freshly spawned panes` (merged as `001d0c0`) may already address the crash class — verify whether the flake reproduces on top of it, close the item if not. Assignee: investigator.
- [ ] env-guard: implement `context`/`context_with_system` hook as a full-history scrubber — defense against mid-token split of a secret value across two steer messages (per-event filtering cannot reassemble fragments; each fragment alone is inert). Backlog, not a blocker; document the residual limit in README if deferred indefinitely. Assignee: worker, reviewed by security-auditor.
