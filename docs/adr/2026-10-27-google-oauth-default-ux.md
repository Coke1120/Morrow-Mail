# Keep Google browser sign-in first

Status: implemented on a dedicated draft branch; review and exact-head CI required.
No merge or release is part of this task.

Google browser sign-in already uses a bundled Desktop client when present and no
explicit import/environment override is selected. Preserve that precedence and
the optional personal-client import introduced in #330. The UI must not imply
that ordinary users need to create a Google Cloud project or type their Google
password into Morrow. Local client readiness does not determine Google's project
publication, verification or allowed-user state.

Every connection entrypoint resets the manual-provider disclosure. New accounts
and existing Gmail OAuth accounts start with it collapsed. Manual-provider
reconnects keep their existing form, address and custom servers; a Gmail password
account remains a manual reconnect until the user explicitly chooses Google.

A legacy Gmail OAuth account cannot reconnect through the normal add-account
action until the existing Gmail API migration review is confirmed. Preserve the
host's `gmail_migration_required` code when unwrapping its error. Offer Review
Gmail API migration, close Connect and open the matching Accounts permission
section; do not retry the blocked button, call migration, request consent or
change credentials as part of that navigation. Account removal/replacement and
unsaved Settings edits retain their existing protections. A connection without a
pinned mailbox asks the user to select one in Accounts.

Synthetic tests exercise the actual renderer and DOM events, required password
validation, repeated connection entrypoints, the host migration-error envelope,
the review-only handoff and the existing confirmation before migration. Features
and help describe the same flow. Native packaged windows, live Google sign-in and
Console state are outside this validation.

This is separate from #331's client/grant binding and operation serialization.
Integration must retain those checks, source-specific invalid-environment help,
and its separate Gmail/Calendar reauthorization guidance when reconciling copy.
