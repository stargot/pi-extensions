# AGENTS.md

pi-extensions — personal pi package: extensions for the pi coding agent.
TypeScript, ESM, Node >= 22.19.0 (`engines`). Peer dependencies:
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (`^1.0.0`),
`typebox`. pi loads every file listed under the `"pi".extensions` key in
package.json (9 entry points).

## Layout

- `extensions/<name>/` — one folder per extension: `index.ts` (entry point), `test/`, `README.md`
- `extensions/shared/` — modules shared across extensions, with its own `test/`
- `scripts/` — dev CLIs (`smoke.mjs`, `visual-audit.mjs`)
- `docs/`, `docs/specs/` — research notes and design specs
- `CHANGELOG.md` (Keep a Changelog, semver), `biome.json`, `.github/workflows/ci.yml`

## Commands

- `npm run check` — gate: `lint` + `format-check` + `type` + `test`; CI runs exactly this on windows-latest (Node 22/24 matrix)
- `npm test` — `node --test extensions/**/test/*.test.ts`
- `npm run lint` / `npm run format` — Biome over `extensions` and `scripts`
- `npm run type` — `tsc --noEmit`
- `npm run smoke` — loads the package's extensions in pi (`scripts/smoke.mjs`)
- `npm run coverage` — per-file coverage, outside the gate
- Extension CLIs without pi: `npm run audit`, `npm run recall`, `npm run trace`, `npm run trace:web`

## Conventions

- Every active extension folder keeps its own `README.md`.
- Document user-visible changes in `CHANGELOG.md` under Unreleased or a new version.
- Tests use `node:test` with `node:assert/strict`; one `test/` folder per extension.
