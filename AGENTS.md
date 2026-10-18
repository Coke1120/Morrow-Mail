# Agent notes

## UI

The first-party shell in `renderer/` is still vanilla DOM. Use icons and motion anyway.

- Prefer **react-icons-compatible SVGs** now: `viewBox="0 0 24 24"`, `currentColor`, and the same paths as `react-icons/fi` (Feather) or `react-icons/lu` (Lucide). Decorative icons are `aria-hidden="true"`. Keep the visible text or an `aria-label`.
- When React lands in this shell, use **react-icons** and **motion.dev** (`motion/react`) heavily for icons, hover, and panel transitions.
- Do not strip the existing Motion usage. `renderer/motion-ui.js` imports `motion`. `renderer/motion.bundle.js` exposes `window.morrowMotion`. `renderer/app.js` calls it for rows, panels, dialogs, and chrome press/hover. Keep `prefers-reduced-motion: reduce`.

## OAuth consent

Google connects mail, calendar, organize, Out of Office, and rules in one full consent. Microsoft uses two dialogs maximum: Outlook IMAP/SMTP only, then one Graph bundle for all API features. Never mix Outlook and Graph on an authorize URL, code exchange, or refresh. Reuse saved grants, request missing permissions incrementally, and preserve existing tokens after partial consent. Bot bridge stays separate. See `docs/OAUTH.md`.

## Out of Office

Settings → Out of Office is a reviewed provider write. Gmail uses `gmail.settings.basic` and Microsoft uses `MailboxSettings.ReadWrite`, covered by the provider bundle or an existing legacy token. Do not replace the mailbox secret after partial consent. IMAP may install only the ManageSieve script `morrow-vacation` on port 4190 after STARTTLS. Do not send local automatic replies or replace another active script.
