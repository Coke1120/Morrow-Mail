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

Google OAuth mail uses Gmail API with gmail.modify + gmail.settings.basic; Calendar is a separate grant. Existing Google OAuth IMAP accounts require the reviewed migration action before switching transport or mail credentials. Never silently narrow scopes while leaving Gmail on IMAP/SMTP; requested scopes do not prove old broad grants were revoked. Microsoft uses two dialogs maximum: Outlook IMAP/SMTP only, then one Graph bundle for all API features. Never mix Outlook and Graph on an authorize URL, code exchange, or refresh. Reuse saved grants, request missing permissions incrementally, and preserve existing tokens after partial consent. Bot bridge stays separate. See `docs/OAUTH.md`.

## Out of Office

Settings → Out of Office is a reviewed provider write. Gmail uses `gmail.settings.basic` and Microsoft uses `MailboxSettings.ReadWrite`, covered by the provider bundle or an existing legacy token. Do not replace the mailbox secret after partial consent. IMAP may install only the ManageSieve script `morrow-vacation` on port 4190 after STARTTLS. Do not send local automatic replies or replace another active script.

## AI data permission bridge

Settings uses the first-party renderer preload; AI Setup has its own preload.
Keep the three exact consent status/grant/revoke invokes aligned with the existing
host handlers. Exercise the actual preload, Settings mount and host validation in
synthetic tests; a mocked invoke callback alone cannot detect a missing channel.
Preserve the explicit manual checkbox, separate background choice, saved-target
token binding and rejection of unknown channels. Tests must not use live AI,
credentials or actual user consent files.

## Sender identities

Sender display names are Morrow-only preferences keyed by account id and exact normalized From address. Gmail discovery supplies defaults; refresh must preserve local overrides and manual aliases. An empty override means address-only; absence means inherit the default. Freeze the selected name with draft/scheduled content and use Nodemailer structured addresses for MIME. Never turn a display name into address authorization, update Gmail settings, or add scopes for local names. Preserve alias/provider restrictions and bot idempotent receipts. See `docs/adr/2026-10-26-sender-display-names.md`.

Draft hydration must use the separate bare `fromAddress`, never reparse recipient-visible preview text. Provider parsing persists that address independently of display names. Equivalent legacy sender metadata must not invalidate queued draft cleanup proofs; genuine name/content edits must still protect newer work.

Historical provider caches contain decoded `name <address>` display text, including unquoted punctuation, rather than an RFC From header. Recognize equivalent metadata only by the full historical representation plus a validated separate address, or a valid parsed header. Test the production provider formatter/parser path; manually quoted fixture headers alone miss this compatibility case.

## Startup search repair

Search rebuilds commit bounded batches and yield with no open SQL transaction.
Keep mail data admission closed until index verification; never carry internal
database admission across an await or invoke UI observers inside it. Progress and
cursor updates must follow durable commits. Preserve the building/version marker,
restart recovery and all three consistency tables. Do not drop tables, skip repair
or weaken journal/fsync. Tests must cover abort/close, concurrent access, journal
failure and process exit using synthetic stores. See
`docs/adr/2026-10-27-cooperative-search-index.md`.
