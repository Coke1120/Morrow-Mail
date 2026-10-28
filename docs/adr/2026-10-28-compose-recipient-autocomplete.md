# Compose recipient autocomplete

Issue: https://github.com/Coke1120/Morrow-Mail/issues/362

Not implemented in the change that added this record. Compose does not suggest addresses yet.

## Decision

Phase 1 collects addresses already stored in local mail: From, To, Cc, and Bcc on synced messages. Rank by recency and frequency. Do not add Contacts, People, or any other provider scope for this. The suggestion list is derived from mail Morrow has already downloaded.

Phase 2, optional and later, may read provider contacts. That stays behind its own explicit grant. It is not part of the Gmail or Microsoft mail grant, and it is not implied by Phase 1.

## Why local mail first

Synced headers already contain the addresses people reply to. A new contacts scope would ask for a directory the user did not need to connect in order to type a recipient.
