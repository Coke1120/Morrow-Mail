# macOS close hides the window

The red close button quit Morrow Mail. Electron quits when the last window closes unless the app handles `window-all-closed`, and the scheduled-mail close path treated every platform's window close as a quit.

## Decision

On macOS, the main window `close` event hides the window and leaves the process running. The red button and File → Close Window (Cmd+W) both emit that event. Hide does not read the scheduled queue and does not show the quit confirm. Background sync and scheduled sends keep running. Minimize already left the process running; this makes close do the same. System sleep still pauses push. Cmd+Q, the Quit menu item, and `app.quit()` still use the scheduled-mail confirm from [2026-10-21-quit-scheduled-confirm.md](2026-10-21-quit-scheduled-confirm.md), then quit.

`activate` (Dock icon, or relaunch while the process is already running) shows the shell window. A minimized window is restored. If the shell window is gone, `activate` creates it again with the same preload and mode as launch.

On Windows and Linux, closing the main window still goes through that quit confirm. `window-all-closed` quits on those platforms. A real quit still closes the macOS window: the first `before-quit` is held until cleanup, and the close that follows is allowed to destroy the window.

## Why hide

Hiding keeps the shell in memory. A Dock click shows that same window, and close never reads the scheduled queue. The quit confirm stays on Cmd+Q and on Windows and Linux window close.

A compose window is not the main window. Its close button closes that window. A dirty draft asks before discarding, and that confirm does not save the draft. Hiding applies only to the main window.
