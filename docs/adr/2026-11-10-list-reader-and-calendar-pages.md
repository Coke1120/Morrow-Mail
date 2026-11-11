# Keep stored mail text, skill intent, and calendar selections

Status: Proposed in this fix PR.

## Context

Server mail is stored after decoding. The message list then ran a second
mojibake repair, while the reader kept the stored text. A stored `cafÃ©`
could read as `café` in the list and `cafÃ©` in the reader. Healthy Unicode
did not need that second pass.

Agent chat treated any installed skill name longer than three characters as a
command when the message merely contained it. “Please organize inbox before
noon” could start Organize Inbox. Explicit skill chips already pass a skill id.

Outlook calendar listing stopped after five pages, or on a repeated next link,
and returned the pages it had. The shell then saved only the checks that
appeared in that partial list. Google already refused an incomplete list.
Saved checks were also read back as only the first 100 ids.

## Decision

- The list uses the same preserve rule as the reader. Persisted server mail
  (`uid > 0` and not a pending draft) keeps the stored subject and snippet.
  Pending local drafts still use the existing repair on both surfaces. The
  reader does not guess another encoding.
- Typed chat runs a skill only when the whole message is that skill’s name or
  id, or `run` followed by that name or id. A longer message that only
  mentions the name stays a chat answer. An explicit skill id is unchanged.
- Google and Outlook calendar lists follow at most five pages. An extra page,
  a repeated next link, or a next link that cannot be followed throws. The
  shell does not receive a partial list, so it does not replace saved checks.
  Saved calendar checks are stored and read back in full.

## Verification

Synthetic host and renderer checks cover preserved versus repaired subjects,
exact skill routing versus a name mentioned inside a question, explicit skill
ids, Outlook’s incomplete calendar list, and a 101-id check round-trip.
