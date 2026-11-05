# Confirmed IMAP reply and forward dispositions

Outlook OAuth, Yahoo app-password and other IMAP/SMTP accounts previously read
`\Answered` and `$Forwarded`, but Morrow did not set the original message's flag
after sending. Gmail API evidence remains a separate mechanism.

Capture the original account incarnation/login/endpoints, folder, UIDVALIDITY,
UID and action before submitting. A reply header must agree with the selected
original when present; an original without Message-ID can still be identified
by its IMAP identity. Do not infer IMAP state from subjects, threads, RFC ID
matches in other folders, opening compose, saving drafts or creating a queue.
Keep that proof with drafts, Undo Send and scheduled snapshots across restart.

After the existing acceptance callback saves its delivery receipt, require all
intended To/Cc/Bcc recipients to appear in the SMTP accepted list with none
rejected. Only then persist local evidence and attempt the IMAP update. Partial,
incomplete, refused and uncertain submissions add no evidence. Bot `mail.send`
uses the same behavior for an explicit validated same-account reply target;
its request receipt and authorization rules remain unchanged.

Select and lock the original mailbox, verify UIDVALIDITY and the exact UID, and
check account/credential ownership after waits and before writes. Add one flag
with UID `+FLAGS`, preserving all other flags. Require the selected mailbox to
permit that permanent flag: `\*` allows a new keyword such as `$Forwarded`, not
an unlisted system flag. Verify flags after STORE because a server can acknowledge
an ignored keyword. Missing permission information, read-only selection, denied
or ignored flags keep local evidence without promising a server write. These
boundaries follow [IMAP permanent flag semantics](https://www.rfc-editor.org/rfc/rfc9051.html#section-7.1).

Flag/evidence/filing failures cannot change a confirmed send into a failed send
or trigger another SMTP submission. Local evidence commits separately after the
receipt: a crash or storage failure in that gap can omit an indicator, but must
not cause a duplicate delivery. This differs from Gmail's existing transactional
scheduled receipt/evidence write, which stays unchanged.

Local evidence is keyed by the exact IMAP identity and a hash of non-secret
account identity fields. It overlays an absent server flag, including after
full/body/flag-only refresh and restart. Raw provider flags remain separate.
Endpoint/login changes and account removal retire local evidence; UIDVALIDITY
reset clears that folder's evidence. Evidence does not follow unverified moves,
copies, account recreation or RFC Message-ID matches. Existing provider flags
still display without local send history. No mail or credential is uploaded by
this local fallback, and no OAuth permission or transport change is introduced.

Transient flag failures retry after five minutes, at most two existing identities
per ordinary folder sync while the app is running and its sync budget permits.
Unsupported/denied flags stop retrying until a new confirmed send. Retry is only
idempotent flag addition, never SMTP. Another device can display the result only
if the server persists the flag and that client recognizes it; local fallback
does not synchronize. Historical IMAP forwards remain unknown without flags.

Validation uses temporary stores, synthetic SMTP receipts, real ImapFlow over an
in-memory Duplex transport and actual renderer DOM/Features help. No real mailbox,
OS credential store, recipient or provider was accessed. Native packaged behavior
and live Outlook/Yahoo/custom-server flag policies remain unverified.
