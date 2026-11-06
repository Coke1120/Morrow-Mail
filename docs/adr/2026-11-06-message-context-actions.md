# Message context actions and mailbox transfers

The message-row menu captures the clicked message, or the existing multi-selection
when the clicked row belongs to it. Menu actions, folder/label pickers and transfer
reviews keep those explicit IDs and account identities across navigation and
confirmation. They do not expand conversations. Replacing a source account retires
the review. Right-click does not change the selected/open message or mark it read.

“Move to trash” uses explicit nonpermanent removal requests with
`moveToTrashOnly: true`. The host rejects already-Trash sources before accepting a
request and prevents a stale `deleteBatch` Trash hint from requesting permanent
deletion. Existing explicit permanent-delete callers keep their separate behavior.
The new menu does not expose permanent deletion.

“Move / Copy to other mailbox” retains the existing durable Local Folders transfer
implementation: complete MIME/attachment verification precedes server Trash, and
uncertain moves are not replayed. Local-to-local filing remains available.
Connected mailboxes appear as disabled destinations with an explanation. Verified
server import, durable receipts, recovery and safe source removal have not been
implemented for general server-to-server or local-to-server transfer. Gmail's
draft upload is not a general mail import operation. No irreversible fallback is
allowed. A future provider implementation must supply these guarantees before its
destination is enabled.

Gmail labels and optional Outlook Graph moves retain their existing provider
capabilities and permission requirements. IMAP and Yahoo retain physical folder
movement. The menu supports the Menu key / Shift + F10, arrow keys, Home/End and
Escape with focus restoration; unsupported actions are explained and disabled.
