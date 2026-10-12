# Review workspace lifecycle follow-up

Delayed [PR32 findings](https://github.com/Coke1120/Morrow-Mail/pull/32)
identified three independent defects in its accepted source. This follow-up is
separate from the Windows process observer and Thunderbird synchronization.

## Empty projections

The `/state` account loop called Today projection and reply review even when
there were no saved summary items or proposals. Both eagerly loaded the bounded
conversation index, scanning/parsing up to 10,001 live/deleted metadata rows per
call. Today now collects still-cached saved items first and returns immediately
when none remain. Reply review validates the connected owner, then returns empty
collections before index loading when no proposal array exists or it is empty.
Nonempty projections keep the existing source/coverage/policy reconciliation.

An isolated Rust fixture removes only its conversation-deletion metadata table
through the existing Store connection. This makes any index load fail, while
normal cached messages/settings remain. The baseline empty projection fails;
the corrected empty direct and full `/state` projections pass. A nonempty saved
projection still fails the trap, confirming index checks were not waived. This
proves the redundant index dependency was removed, not a measured UI speedup.

## Skip and refresh state

Opening a Mac suggestion creates a clean prepared draft. The previous full Skip
action removed the server proposal, then reloaded; the selected local draft
caused the removed proposal to be appended as stale. A second Skip returned404.
Successful dismiss now validates its owner, invalidates older pending loads,
removes that proposal from local projections and forgets its ephemeral draft,
baseline, message/proposal, approval/stale/error and selection/scroll state. A
failed dismiss keeps local working state. The operation never deletes a saved
mailbox draft or changes another account's proposal.

When a later source retargeted a reply to a different message key, both native
clients copied the edited draft without erasing the previous workspace key.
Saving the new entry left `hasEdits` true on the obsolete entry, blocking update
and exit. Successful source/owner validation now moves scene-owned state,
redirects selections/scroll and erases the obsolete workspace entry. Same-key
refreshes retain saved identity/baseline; failed transfers keep their original
working state. The old persisted mailbox draft remains in storage, while a new
message target must receive a distinct draft identity on Save.

## Verification contract

The existing fictional Mac transport now implements proposal removal and an
owned in-memory persisted draft store. Native tests execute the exact production
Skip Button action, including `AppModel.perform`, POST and reload. The immutable
failed v0.7.6 source is compiled as a negative control; it must reproduce stale
reinsertion/second404 and retarget/save ghost guards. Candidate checks cover
opening-only/edited Skip, polling, account collisions, retarget/save, same-key and
failed transfer, update/exit guards and old persisted draft retention. No mail
deletion, send, model/provider request or real Store is permitted.

Windows native controls use the same workspace commit operation as the full
authenticated refresh handler. They check moved entry/text, obsolete key removal,
scope selections/scroll, dirty-to-saved transition and same-key behavior. These
controls do not establish live-account/manual acceptance. Both platform builds
and the existing paired release gates remain mandatory.
