# Agent notes

Project-level standing rules for humans and coding agents (Cloud Agent / Claude / Codex).

## Branches

- **Working / PR base: `dev`** — open feature/fix PRs against `dev`.
- **`main`** — production / default. Do **not** merge or push here unless Leo explicitly says merge to main/production.
- **`production`** (if present) — treat like main for merge gates.

## Hard limits

- No auto-merge.
- No force-push to `main` or `dev`.
- No production deploy from agent initiative.

## Decisions (ADR)

- Record **important** architecture / process decisions under `docs/adr/` (one short Markdown file per decision, numbered or dated).
- Prefer an ADR over chat-only memory when the choice will affect future PRs, agents, or deploys.
- Lightweight product UX backlog can stay in GitHub Issues; ADRs are for durable “why we chose X”.

## Source of truth

- Cross-repo bot habits: Grok Bot skill `leo-coding-prefs` + Graph `projects.yaml`.
- This file + `docs/adr/` win for **this repo's** rules and decisions.
