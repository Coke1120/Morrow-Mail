# Agent notes

## UI

The first-party shell in `renderer/` is still vanilla DOM. Use icons and motion anyway.

- Prefer **react-icons-compatible SVGs** now: `viewBox="0 0 24 24"`, `currentColor`, and the same paths as `react-icons/fi` (Feather) or `react-icons/lu` (Lucide). Decorative icons are `aria-hidden="true"`. Keep the visible text or an `aria-label`.
- When React lands in this shell, use **react-icons** and **motion.dev** (`motion/react`) heavily for icons, hover, and panel transitions.
- Do not strip the existing Motion usage. `renderer/motion-ui.js` imports `motion`. `renderer/motion.bundle.js` exposes `window.genmailMotion`. `renderer/app.js` calls it for rows, panels, dialogs, and chrome press/hover. Keep `prefers-reduced-motion: reduce`.
