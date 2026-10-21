# Agent replies open in their own window

Agent todos that point at a message can Reply and Reply All without covering the Agent page in the compose dialog. Those actions call `host:openComposeWindow`. The host opens a separate `BrowserWindow` on the same renderer with `?surface=compose`, passes the compose seed, and the window fills itself with the existing compose dialog.

The same message and kind focuses the window that is already open. Closing that window asks before discarding unsaved edits, the same as closing the dialog. Quitting the app still closes it.

Reader Reply, Reply All, and Forward still use the dialog in the main window. A compose-window branch was not on `dev` when this landed, so this host module is the seam for that work. New Mail should move to the same window when that branch arrives, instead of growing a second compose implementation.
