# env-guard

Keeps secret values out of the session transcript. A tool that prints an environment variable (the incident that motivated this extension: a bash `echo $LANGSEARCH_API_KEY` put the token straight into the log) gets its output rewritten before the text reaches the model or is stored. The guard never shows, logs, or writes the values it tracks — they live only in memory for the lifetime of the session.

## What it does

- On `session_start` (and on every `/env-guard rescan`), the guard collects known secret values:
  - `.env` and `.env.local` from the working directory and every parent directory up to the filesystem root (unreadable files are skipped);
  - `process.env` entries whose **name** matches `/(?:KEY|TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIAL|PRIVATE)/i`.
- A value becomes a tracked secret only if it passes the false-positive filters:
  - length ≥ 8 characters;
  - no whitespace or newlines;
  - not `true`/`false`/`none`/`null`/`undefined`/`0`/`1` (case-insensitive), not a pure integer;
  - not an `http://` / `https://` URL.
- Values are deduplicated by `key`+`value`; when the same value appears under several keys, one entry remains and the **shortest** key name wins for the replacement marker.
- Secrets exist only in memory. Nothing is written to disk or to the session.

## Redaction points

| Hook | What happens |
|---|---|
| `tool_call` | Before a tool executes, known secret values inside its arguments (`event.input`, deep walk over strings in plain objects and arrays) are replaced with the marker in place, so a command like `curl -H "Authorization: Bearer <token>"` runs without the real value and the transcript stores only the marker. Cycles are handled; non-plain objects (`Date`, `Map`, `Set`, `Buffer`) are passed through untouched. |
| `tool_result` | Every text block of the result, the `structuredContent` tree (deep walk over strings in objects and arrays), and the `details` tree are rewritten. When `content` is replaced, `structuredContent` is returned alongside it, so the machine-readable result is kept rather than dropped. |
| `message_end` | A finalized **assistant** message is redacted the same way (text and thinking blocks, tool-call blocks untouched, role preserved). This covers resumed legacy sessions where a secret already sits in the transcript. |

For each tracked value the guard redacts several textual variants of it: the raw value, the JSON-escaped inner form (`JSON.stringify(value).slice(1, -1)`), the URL-encoded form (`encodeURIComponent`), and the base64 form (only when it is at least 12 characters long). All variants go into one combined regular expression, alternatives ordered longest-first so a value always wins over its own prefixes, with every variant regex-escaped (`a.b*c+d(e)` matches literally).

Each occurrence is replaced with `[REDACTED:<KEY>]`. Redaction is idempotent: running it twice changes nothing. Values whose text would appear inside a replacement marker (for example a value literally spelled `REDACTED`) are excluded from the regex so the markers themselves cannot be corrupted on a second pass.

After any redacting `tool_call`, `tool_result`, or `message_end` event, the user is notified once per session per key — key **names** only, never values — e.g. `env-guard: redacted LANGSEARCH_API_KEY`. Rescan resets this state for keys that disappeared, so a removed-and-re-added key notifies again.

## The `/env-guard` command

- `/env-guard` — status: how many secrets are tracked, from which sources (file paths with per-file counts, process env variable names) and the redaction counters per key.
- `/env-guard rescan` — re-read all sources now and report the delta (added / removed / unchanged key names). Run it after adding secrets to `.env` mid-session.
- Any other argument prints usage. Output goes through `ctx.ui.notify`, guarded by `ctx.hasUI`, so JSON and print modes stay silent but redaction itself stays active everywhere.

## Guarantees and limits

- Only values known at collection time are redacted. A secret that reaches the transcript in a form other than the four tracked variants (for example reversed, split across lines, or hex-encoded) passes through.
- Secrets shorter than 8 characters are never tracked — the false-positive cost outweighs the risk. Same for whole URLs.
- Only `.env` / `.env.local` in the directory chain and `process.env` are scanned. Secrets in arbitrary config files, keychains, or other dotfiles are out of scope.
- The guard repairs the future, not the past: it cannot remove a secret that was printed before the session started. Resumed sessions get assistant-message redaction via `message_end`, but user messages are never modified.
- A cyclic `structuredContent` is copied cycle-safely (the copy never points back into the raw input), but the resulting copy still contains a cycle and therefore remains non-serializable for `JSON.stringify` — this is the pre-existing baseline, not a regression.
- `message_end` redaction rewrites the finalized message object; `tool_result` redaction composes with other handlers and each sees the previous changes.
- Rescan after changing `.env` — the guard does not watch files.

## Tests

```bash
node --test extensions/env-guard/test/*.test.ts
```

Tests use synthetic values only (`sk-test-0123456789abcdef` and similar); no real secret from any `.env` or `process.env` is ever printed or asserted.
