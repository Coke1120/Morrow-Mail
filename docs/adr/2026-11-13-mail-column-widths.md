# Mail-list column width overrides

Store optional pixel widths in `settings.json` as `mailColumnWidths`, keyed by
stable column ID rather than the displayed index. Reordering and hiding a column
must not move or delete its width. Unset keys retain the existing responsive
layout, so upgrading does not freeze every column or migrate an old layout.

The shared column helper normalizes finite numeric widths within per-column
bounds; unknown keys and invalid values are ignored. The same normalization is
used by the renderer and host settings IPC. Width changes do not change sorting,
visibility, paging, selected mail, or reading-pane layout. Narrow lists retain
horizontal scrolling.

Pointer resizing previews locally, then saves on completion. Cancellation restores
the prior layout without a settings write. A separate keyboard-focusable resize
handle avoids overloading the existing sort button and Alt-arrow reorder controls.
Settings writes are serialized and load completion must not overwrite newer user
choices. A save failure is reported rather than pretending the override persisted.
