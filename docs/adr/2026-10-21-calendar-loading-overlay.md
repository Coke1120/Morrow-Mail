# Calendar loading uses the page overlay

A calendar fetch used to paint `reason: "loading"`, which hid the month and left the status line as “Loading calendar…”. The same thing happened when opening Calendar and when switching mailbox, calendar, or month.

Loading now stays on the calendar page. A cold open keeps the toolbar and an empty month grid, and `setPageBusy` covers that page with the same light overlay and spinner as Agent, labeled Loading…. When a month is already painted, or a cached payload exists, the last month stays up under an overlay labeled Updating calendar…. A cache hit from the last minute does not show the overlay. `pointer-events: none` on the overlay leaves the sidebar clickable.

Missing mailbox, missing grant, provider errors, and an empty month still use status text. Those paths do not use the overlay. The calendar IPC payloads are unchanged.
