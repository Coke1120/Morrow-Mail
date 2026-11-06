# Spelling suggestions while composing

In an editable compose-window field, right-click or use the keyboard context-menu
key (Shift+F10 where supported). Available dictionary corrections appear above
Undo, Redo, Cut, Copy, Paste, Paste and match style, and Select all. Choose a
suggestion to replace that spelling through Electron's native editing command.
The existing editor input handler keeps rich HTML and plain draft text aligned;
formatting and native Undo/Redo remain available. A disabled spellchecker or a
missing dictionary leaves normal editing actions available without invented words.

This is spelling support, not grammar checking or an AI action. macOS uses native
system spellchecking with its automatic language handling. Windows/Linux use
Hunspell and default to the OS locale; available dictionaries and language support
vary. Electron may download dictionary files from its default CDN. Morrow does not
change dictionary download settings, upload compose text to an AI, or add words to
a personal dictionary. This menu has no Add to Dictionary action. See the
[Electron spellchecker guide](https://www.electronjs.org/docs/latest/tutorial/spellchecker)
and [editing/context-menu API](https://www.electronjs.org/docs/latest/api/web-contents).

Menus bind the first-party compose window, frame and current editable field.
Changed text, focus, compose session, account/From identity, draft, active AI writing,
read-only state, a newer context menu, navigation or destruction
invalidates an earlier correction. Field contents stay in the renderer during
these checks. Password fields, other windows and subframes are excluded.

Validation uses mocked native Menu/webContents APIs and real Chromium editing,
input, formatting, Undo/Redo, and synthetic draft save/reopen. Native Electron menu
appearance, OS dictionary downloads, real macOS/Windows spellchecking and assistive
technology still require native platform verification; no Electron executable is
installed in this workspace. No real messages, credentials, custom dictionary or
user AI service is used by the tests.
