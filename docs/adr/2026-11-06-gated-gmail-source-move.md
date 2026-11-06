# Gated Gmail-source Move after verified Copy

The Phase2 coordinator is prepared behind a compiled, disabled host policy.
Neither a renderer setting nor an environment variable enables it. Copy's exact
head, the source-removal implementation, synthetic checks and independent review
must pass before the owner-authorized coordinator changes that policy. This
change does not promote a branch, publish a release or enable source removal.

The first supported source transport is Gmail API. Legacy Gmail IMAP, generic
IMAP, Outlook, Yahoo and Local Folders sources remain unavailable for connected
Move; existing Local Folders transfers keep their separate implementation.

The UI completes ordinary Copy first. It then obtains a distinct Move review and
an explicit second Gmail Trash confirmation. A Copy review never authorizes
source removal. Move's private verifier cannot upload: it requires an existing
verified Copy receipt with matching canonical source, destination, account/client
bindings, raw hash, expected state and folder proof. Both accounts are held once
in sorted lane order. Complete destination readback is checked again in the same
pinned session before source removal. Sources are revalidated using Gmail's
canonical provider ID, current labels, date/flags and fresh folder identity.
Message-ID never identifies a source. Gmail label aliases share removal state.

A separate bounded SQLite journal commits source uncertainty before the single
Gmail messages.trash POST. Its source-wide unique key prevents two destinations
or aliases from issuing duplicate removal for an unresolved attempt. Known
unissued/rejected attempts need a new explicit review. Lost acknowledgements,
post-write verification failures and failed outcome commits retain uncertainty;
they never authorize automatic upload, re-Trash or restoration. Copy receipts and
receiving messages remain intact on every source-removal outcome.

The source adapter rejects fresh Trash/draft state and checks the exact Gmail ID
again after the API's metadata read. Submission rechecks Copy receipt integrity,
account/credential/Google-client bindings, live review authority and a bounded
destination-readback age. The acknowledged message is read back completely under
its original provider ID and must have TRASH membership and unchanged MIME/date/
read/star state before a confirmed outcome is stored. No generic delete, label
delete, IMAP fallback, SMTP or permanent-delete API is used.

After the confirmed source outcome is durable, the exact full Gmail readback is
adopted using the existing transactional label mapping and alias pruning. Only the
known canonical Gmail ID is admitted; duplicate RFC Message-ID rows are never
inferred to be aliases. Original account/client/credential/folder ownership is
checked through parsing and the synchronous cache commit. A failed cache update
rolls back local adoption and reports refresh pending while keeping the confirmed
provider receipt; it never changes that outcome to uncertainty or re-Trashes.

Reviews bind the requesting main frame and webContents. Destruction/main-frame
navigation retires authority in the host; same-page account/folder/choice/stop
changes retire the renderer ticket. Every access/session await and the submission
boundary checks authority. Restart preserves receipts but not review authority;
prepared unsubmitted records retire, and source_unknown remains unknown. No
source writes resume automatically. The journal validates all bounded metadata
inside the native transaction that consumes it, without an integrity cache.

This is a recoverable copy-then-Trash protocol across independent providers, not
a distributed transaction. A separate client can change either copy, and Gmail
retention can remove Trash. No Morrow Undo for this transfer is promised. Users
can inspect the confirmed Gmail Trash identity and use the provider's available
recovery. Partial and unknown outcomes always preserve the receiving copy.

Synthetic fixtures exercise real engine/admission, Gmail HTTP adapters, journal
reopen and crash/storage failures, duplicate identities, cancellation, protocol
barriers and rendered UI. They do not certify live providers, native windows,
screen readers or real power-loss behavior. Enabling the policy is a separate
reviewed change after Copy's readiness handoff.
