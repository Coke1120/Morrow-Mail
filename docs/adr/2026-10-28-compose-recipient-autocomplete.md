# Compose recipient autocomplete

Issue: https://github.com/Coke1120/Morrow-Mail/issues/362

Status: Accepted. Phase 1 is implemented. Phase 2 is not.

Compose asks `mail:suggestRecipients` with the address being typed in To, Cc, or Bcc. The host reads From, To, Cc, and Bcc on non-draft messages already stored on this computer, skips message bodies, and returns at most eight addresses. The same address on one message, including Gmail label copies that share a provider id, counts once. Each extra sighting is worth seven days against the latest time that address was seen. Arrow keys then Enter, or a click, inserts the address. Enter without a highlighted suggestion still previews send. An address you type is kept. This does not read a contacts directory and does not add a provider scope.

## Decision

Phase 1 collects addresses already stored in local mail: From, To, Cc, and Bcc on synced messages. Rank by recency and frequency. Do not add Contacts, People, or any other provider scope for this. The suggestion list is derived from mail Morrow has already downloaded.

Phase 2, optional and later, may read provider contacts. That stays behind its own explicit grant. It is not part of the Gmail or Microsoft mail grant, and it is not implied by Phase 1.

## Why local mail first

Synced headers already contain the addresses people reply to. A new contacts scope would ask for a directory the user did not need to connect in order to type a recipient.
