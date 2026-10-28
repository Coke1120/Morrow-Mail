# Compose settings disclosure and cross-account From

Status: implemented for issue #357. Review and `CI=1 npm run check` are required.
No merge, tag, or release is part of this change.

Settings → Compose showed domain CC/BCC rules, aliases, sender names, Preferred
From, and the fallback domain at once. The compose From menu listed send-as
addresses for `composeMeta.accountId` only, so another mailbox required closing
compose and choosing that account in the sidebar.

The basic surface is how a message looks when it is sent: sender display names,
Preferred From, and the existing Signatures dialog for the mailbox selected in
Compose settings. Default CC/BCC-by-domain, the alias mailbox, alias lines, and
the fallback CC domain stay in Advanced. Advanced is collapsed in the page.
After compose settings load, it opens only when a saved CC rule, BCC rule,
alias, or fallback domain already exists. Preferred From and display-name
overrides do not open it. The longer policy notes sit in one collapsed
"How this works" disclosure. The domain DSL and its storage stay as they are.

From lists authorized addresses for every connected live mailbox, grouped by
account. Reply and forward still start on the mailbox that received the
message. Choosing an address the current mailbox does not authorize switches
`composeMeta.accountId`, reloads that mailbox's compose context, and applies
its CC/BCC defaults and signature domain. Draft save and send use that mailbox.
The previous mailbox's draft id is cleared and left in place, and the
mailbox-local thread id is cleared; In-Reply-To stays. If the reloaded context
does not include the chosen address, the switch is discarded and the original
mailbox remains selected. The same address on two mailboxes stays with the
current mailbox. Same-mailbox alias changes keep the existing recipient and
signature behavior.

`mail.send` is unchanged: a bot still sends only for the granted account and an
address that account authorizes. This does not add structured rule rows, move
aliases into Accounts, or rewrite compose-policy.

Validation is synthetic DOM and the existing compose-identity fixture. It does
not open a native window or send through a live provider.
