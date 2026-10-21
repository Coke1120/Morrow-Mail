# Shortcuts page lists the repo CLI beside the keyboard list

Morrow Mail does not ship a `morrow` command. Operators and developers use the checkout commands already written down: `npm install` and `npm start` in the README, `npm run check`, the packaging scripts in `package.json` and `docs/PACKAGING.md`, and `node scripts/morrow-bot-call.js` in `docs/BOT_BRIDGE.md`.

The Shortcuts rail page keeps that keyboard list and adds a CLI section under it. Each row copies the command and does not run it. `postinstall` and `motion:bundle` stay off that list because npm runs the first on install and it only bundles motion.
