# Compose signatures follow From identity

Status: implemented in this change. Review required. No merge and no release.

Settings → Compose keeps one Signatures button. The dialog lists an Account default for the mailbox already selected there, then one row per send-as or saved domain. A small Edit signature link on a From card opens that same dialog on the matching row.

Storage stays `signatures` plus `signature_domains`. A domain row binds that domain. Account default sets `is_default` and leaves domain rows alone. Compose already chooses domain signature, then account default, then none. A mailbox with one signature that is not tied to a domain uses that signature as the account default, including rows saved before the flag was set.

Saving a domain that shares a signature with the account default, or with another domain, first writes the old body without that domain, then creates the new row. Saving the account default while that signature still has domains creates a new default and leaves the domain text in place. The dialog does not list every mailbox at once.
