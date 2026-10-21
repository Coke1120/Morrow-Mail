# Compose AI lives in the formatting toolbar

Compose used to hide AI write in a `<details>` accordion beside Send later. That put a draft action in the same tools row as scheduling, and it stayed collapsed until someone opened it.

AI write is now a sparkle button on the rich-text toolbar. The button opens a popover with Rewrite, Continue, Custom, and Reply from thread. Send later keeps its own disclosure and the same `mail:scheduleSend` behavior. Reply suggestions stay chips in the draft.

Reply from thread uses the existing `aiDraftWrite:start` path with `mode: "reply"`. The host prompt includes the original subject, from, and body. An empty prompt still asks for a comprehensive reply. New mail and forwards leave that mode disabled because there is no message being answered. The signature already on the draft is put back after the model text.

Escape closes the popover before it closes compose. Cancel stops an in-flight draft and closes the popover. A click outside closes the popover and leaves a running draft in the editor so the sparkle can open it again.
