# Reader window uses the shell toolbar and its own frame

Previous emails opened a reader `BrowserWindow` with Reply and Close only, at a fixed 960×760 cascade. The shell reading pane already had the full action bar.

## Decision

A successful reader open calls the same `renderActions` and reply suggestions as the shell. Close is the last control on that bar and calls `window.close()` with no discard confirm. A failed, empty, or loading reader shows Close without the rest of the toolbar. The thread strip, message list, and rail stay hidden. R, A, F, and Delete or Backspace run in the reader window. Search, New Mail, and Settings stay on the shell.

The last reader size and position live in `reader-window-state.json`, not `window-state.json`, so a reader move cannot change the shell frame or zoom. Move, resize, and close write that file. `place()` from `host/window-state.js` drops a saved position that no longer sits on a display. The first open reader uses the clamped frame. Each later reader adds 28 pixels. A save subtracts that same offset so the stored origin does not walk. With no saved frame, the window stays 960×760 and cascades from the shell.

## Why a separate file

The shell file also stores maximized, fullscreen, and zoom. Sharing it would let a reader close overwrite the mail window. A `reader` key inside that file would have to survive every shell `update()`, which sanitizes the whole document.
