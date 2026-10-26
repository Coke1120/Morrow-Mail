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

## Security audit skill

- Skill path: `.cursor/skills/security-audit/`
- Use only when Leo explicitly asks for a security audit, pen-test, or full security review.
- Not always-on. Do not run it on every PR or feature task.
- Full audit mode is expensive (multi-agent). Prefer guidance mode unless Leo asks for a full audit or report artifacts.
- Source: Cloudflare security-audit-skill (MIT) — https://github.com/cloudflare/security-audit-skill

---

# Coding guide (restored from main)

# Agent notes

## UI

The first-party shell in `renderer/` is still vanilla DOM. Use icons and motion anyway.

- Prefer **react-icons-compatible SVGs** now: `viewBox="0 0 24 24"`, `currentColor`, and the same paths as `react-icons/fi` (Feather) or `react-icons/lu` (Lucide). Decorative icons are `aria-hidden="true"`. Keep the visible text or an `aria-label`.
- When React lands in this shell, use **react-icons** and **motion.dev** (`motion/react`) heavily for icons, hover, and panel transitions.
- Do not strip the existing Motion usage. `renderer/motion-ui.js` imports `motion`. `renderer/motion.bundle.js` exposes `window.morrowMotion`. `renderer/app.js` calls it for rows, panels, dialogs, and chrome press/hover. Keep `prefers-reduced-motion: reduce`.

## Keep Features and help current

- Every feature addition, change, or removal must update its corresponding **Features page/tab** in the same change. Update the hand-maintained catalog (`renderer/features-catalog.js`) and relevant tabs in `renderer/index.html` / `renderer/app.js`, including **CLI** for bot/API/command changes.
- Keep capability/status descriptions, supported and unsupported operations, permissions/prerequisites, cancellation limits, command examples, and usage/help consistent with the implementation. Describe planned work as unavailable; do not present it as shipped.
- Review those claims against the actual handlers/catalog/contract. Add or update consistency/regression checks and validate the affected rendered tab with synthetic data. Reviewers must check this synchronization before approving a feature change; passing host tests alone does not verify UI/help claims.

## OAuth consent

Google connects mail, calendar, organize, Out of Office, and rules in one full consent. Microsoft uses two dialogs maximum: Outlook IMAP/SMTP only, then one Graph bundle for all API features. Never mix Outlook and Graph on an authorize URL, code exchange, or refresh. Reuse saved grants, request missing permissions incrementally, and preserve existing tokens after partial consent. Bot bridge stays separate. See `docs/OAUTH.md`.

## Out of Office

Settings → Out of Office is a reviewed provider write. Gmail uses `gmail.settings.basic` and Microsoft uses `MailboxSettings.ReadWrite`, covered by the provider bundle or an existing legacy token. Do not replace the mailbox secret after partial consent. IMAP may install only the ManageSieve script `morrow-vacation` on port 4190 after STARTTLS. Do not send local automatic replies or replace another active script.
