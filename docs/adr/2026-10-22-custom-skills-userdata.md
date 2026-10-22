# Custom Brain skills live in userData

Built-in skills stay a catalog in the app package. Skills a person writes are not part of that package.

`custom-skills.json` sits in the Electron userData directory, beside `agent.json` and `brain.json`. Installers and in-app updates replace the app bundle. They do not write this file, and a catalog change does not reuse a `user:` id. A read that fails leaves the file on disk.

Install and schedule state for both kinds of skill stays in `agent.json` in that same directory. Deleting a custom skill removes its definition. Removing a catalog skill only uninstalls it.
