# Opening a message jumps ahead of background sync

Background sync and `mail:openEmail` both took the per-account mailbox queue. The background pass held that queue for every folder it reached in the tick, so a message that still needed a body waited until the pass released the queue.

User mailbox work and the background walk now use two lanes on that same queue. Only one job runs at a time, so two IMAP commands cannot write the account database together. `mail:openEmail` / `ensureBody` stays on the user lane. The background walk is the background lane, and a queued user job runs before a queued walk.

A walk that is already inside a folder finishes that folder batch. The batch commits its UID cursor before the next folder starts. If a user job is waiting, the walk saves the folder turn, closes its connection, and returns. The user job then fetches the body. The same pass continues when the tick still has time, using the folders it has not visited yet. When the tick is over, the next poll resumes at the saved turn. Manual Sync stays one user-lane job and still downloads the open folder without stopping between its pages.

This pass does not prefetch bodies for visible rows. Visible-page prefetch came later and stays on the background lane; see `2026-10-22-paint-first-visible-bodies.md`. Off-hours body fill also stays on that lane and waits behind an open; see `2026-10-22-overnight-body-fill.md`.
