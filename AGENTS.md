# Agent notes

## UI

The first-party shell in `renderer/` is still vanilla DOM. Use icons and motion anyway.

- Prefer **react-icons-compatible SVGs** now: `viewBox="0 0 24 24"`, `currentColor`, and the same paths as `react-icons/fi` (Feather) or `react-icons/lu` (Lucide). Decorative icons are `aria-hidden="true"`. Keep the visible text or an `aria-label`.
- When React lands in this shell, use **react-icons** and **motion.dev** (`motion/react`) heavily for icons, hover, and panel transitions.
- Do not strip the existing Motion usage. `renderer/motion-ui.js` imports `motion`. `renderer/motion.bundle.js` exposes `window.morrowMotion`. `renderer/app.js` calls it for rows, panels, dialogs, and chrome press/hover. Keep `prefers-reduced-motion: reduce`.

## Out of Office

Settings → Out of Office is a reviewed provider write. Gmail uses `gmail.settings.basic` and Microsoft uses `MailboxSettings.ReadWrite`, each on its own token. Do not replace the mailbox secret after partial consent. IMAP may install only the ManageSieve script `morrow-vacation` on port 4190 after STARTTLS. Do not send local automatic replies or replace another active script.
