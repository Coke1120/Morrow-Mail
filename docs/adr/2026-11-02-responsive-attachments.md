# Attachment ZIP work and retained sidebar refresh

The Cloud review of `6edf30f` reproduced synchronous ZIP construction occupying
the host event loop for 405–445 ms at 16 MiB and 3.35–3.55 seconds at 128 MiB of
synthetic incompressible input. These Linux Node timings are not native Mac or
Windows Electron measurements. Retained sidebar refresh also concatenated and
searched the account's entire folder array once per visible folder.

ZIP compression, CRC and archive assembly now run in one worker at a time.
Admission permits at most three active/queued jobs and 256 MiB of input, in
addition to the existing 64 MiB per-file and 128 MiB per-archive limits. Waiting
jobs retain their input but spawn no worker. Input is cloned rather than detached
from a cache/consumer; output is transferred using dedicated storage. This bounds
admitted input, not whole-process peak memory or the time to clone one large input.
The worker exits after each archive. Cancellation terminates an active worker;
the next job waits for its confirmed exit. Failed/spawned/exited workers release
admission and permit retry. No result is written before the request/account/message
snapshot is checked again.

Attachment writes use asynchronous filesystem I/O and retain global serialization
so concurrent saves cannot interleave writes to the same selected path. Waiting
saves remain cancellable and recheck identity before their turn. Failed writes do
not poison the queue. Once a write starts it may
finish even if its request is cancelled or the window closes. The written file
is not deleted or rolled back; identity/cancellation is checked after the await,
before success or an external application launch. The UI already disables Cancel
while saving/opening and now describes the cancellable ZIP preparation phase.
Downloading, shared-consumer cancellation and provider/account guards are unchanged.

The unchanged sidebar builds account/folder maps once per snapshot. Existing nodes,
badges, selection and accessible labels are retained. This removes quadratic folder
array copying/search; it does not claim bounded rendering for arbitrary folder counts.

`check-responsive-attachments.js` exercises the actual worker with 16 MiB synthetic
bytes, heartbeat, output parity, duplicate safe names, cancellation/retry and bounded
queue/error lifecycle tests. It also mounts the actual sidebar and Features catalog,
checking linear lookup work and retained badge/selection behavior. Transfer tests
cover a window closing during asynchronous writing without launching an application.
No live provider, actual mailbox, native window or secure store is needed.

Exact local search, database ownership/migration, pending-body indexing, IMAP
foreground scheduling, Gmail decode, recipient aggregates and scheduled queue
enumeration remain separate review findings. No durability or provider protocol
rewrite is included in this change.
