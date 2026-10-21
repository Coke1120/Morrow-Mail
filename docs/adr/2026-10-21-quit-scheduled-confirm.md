# Quit confirmation for pending scheduled mail

Scheduled sends run only while Morrow Mail is open. A time that passes while the app is closed is sent on the next launch. Quit and window close did not say so.

macOS window close no longer enters this path. See [2026-10-21-macos-close-hides.md](2026-10-21-macos-close-hides.md).

## Decision

Graceful quit, and main-window close on Windows and Linux, read `mail:listScheduled`. Pending and sending rows block that quit and open the quit dialog. Failed rows do not. Stay open, including Escape, keeps the process running. Quit anyway continues the existing before-quit cleanup and then quits, including when the request started from the Windows or Linux window button. View scheduled opens the existing scheduled-mail dialog and does not quit.

The in-app dialog is used when the main window can show it. A native message box with Stay open as the cancel button is the fallback when that window cannot show the dialog, including while an update has frozen the renderer. If the queue cannot be read, quit stays blocked until the same choice. Force-quit and `app.exit` are not intercepted.

## Why close is intercepted too

On Windows and Linux the window is destroyed before `before-quit`, so the in-app dialog would have nowhere to appear. The close handler prevents that close until the choice is made. On macOS, the red close button and File → Close Window hide the window and do not ask; Cmd+Q still uses this confirm. With nothing pending, a Windows or Linux window close still closes and quits.
