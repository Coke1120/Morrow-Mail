// What's new copy, keyed by the package.json version (no leading v).
// On each release, add that version's user-facing lines in the same change as the bump.
// A missing or empty entry does not open a dialog. This file does not fetch GitHub.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowChangelog = api;
})(typeof window === "object" ? window : globalThis, function () {
  const NOTES = {
    "0.3.11": [
      "Compose Signatures is one Settings entry. The dialog lists Account default and each send-as or domain on the left, and edits that identity's signature on the right. An optional Edit signature link still opens the same dialog for the active From.",
      "The status chip and Undo Details keep the active session while restores finish, preserve scheduled-restore feedback, and keep focus and selection stable when the offer changes.",
      "Outbox Undo resumes a draft with its validated Agent todo intact. Outlook Calendar description compares use trimmed text on both sides; revision and if-match stay as before.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.10": [
      "Learned waits for matching completed read settlements before counting a pattern, keeps validated thread identity across triage refreshes, and refreshes already-open suggestion surfaces when a pattern is learned or deleted. Reply learning no longer depends on a Needs You todo target.",
      "Undo Details keeps pending rows, checkbox state, and focus while restores finish, and late restores do not affect a replacement Undo offer. The Bodies Sync tooltip keeps a hover bridge and keyboard scroll, and confirmed IMAP source-limit results show as Limited with No action needed.",
      "Uncertain Outbox deliveries stay durable and noneditable. Agent filing follows matching journal completion without overwriting newer store state. Bot Disable and Revoke keep their intent during probes. Compose ignores finished AI events and fences pending attachments; Brain keeps concurrent saved rules and Unicode facts; Calendar keeps original instants on non-time edits and exposes reauthorization after known auth failure.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.9": [
      "All Account Mail is a collapsible section. Choosing the header expands or collapses it and does not open a list. Inbox opens the same merged list and keeps the Unread chip. Gmail still uses cached All Mail; other accounts use Inbox. Outbox stays beside Inbox as the local undo queue.",
      "The open message shows its date and time on the From row, right-aligned, in the main reading pane and in a separate reader window. That text uses the reader's existing date and time format. Loading and download-error headers use the same row. To and Cc stay on the lines below.",
      "Agent Todos includes List and Card. List stays the default. Card shows the sender, subject, one Agent reason line, and Reply and Done. Hover, Tab focus, or a tap opens the same detail: a fuller summary, the classification reason, one thread line, and Reply, Done, and Dismiss. Escape or leaving the card dismisses it. The page header does not repeat that detail. Opening the detail does not open the message or complete the todo.",
      "Settings → Learned lists explicit moves among Needs You, FYI, and Other, repeated Mark as read or a successful reply for one sender or thread, and opened or dismissed suggestion labels. The same pattern is Learned after 3 times. The list is kept in agent-learning.json on this computer. Delete removes that pattern and its count, and an action that already started does not recreate it. Learned rows do not rewrite Brain categories, triage prompts, or mailbox rules, and they do not send mail, mark mail read, or complete a todo. A Learned category stays a hint until that message is moved.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.8": [
      "Opening an unread message in the Unread filter, or the All Account Mail Unread chip, may mark it read and keeps that one row until you open a different unread message. Opening a message that is already read, opening the held row again, or highlighting a row without opening it leaves the hold. Mark read on the held row from the row button leaves it listed. Mark unread clears the hold. Mark read on a row that is not held removes it. Multi-select Mark read removes every selected row, including the held row when it is selected. Leaving Unread, switching folder or account, searching, or turning the filter off clears the hold, and coming back does not restore it. Refresh and Sync keep the held row unless the message is gone. Other filters do not keep a read row this way.",
      "To, Cc, and Bcc suggest up to eight addresses already in synced mail on this computer, ranked by how recent and how often they appear. Arrow keys then Enter, or a click, inserts one. Enter without a highlighted suggestion still previews the send, and an address you type is kept. Suggestions do not read a contacts directory or add a provider scope.",
      "A successful Reply or Reply All completes only the Needs You todo recorded when that reply starts. Forward, a new message, a saved draft, a canceled compose, a failed send, and a queued or scheduled send leave that todo open until the send succeeds. Mark as read leaves it open. The Settings opt-in \"Mark as read also completes Agent todos\" is off by default. Mark read & done marks the message read and completes the todo. FYI and Other offer Mark category as read for the messages listed there, with Undo, and do not complete todos. Needs You has no Mark-all. Select rows, then Mark selected as read or Complete selected. The label says all only after every listed row is selected. Done and Dismiss stay on this computer.",
      "Agent learning, the Agent card view, nesting Outbox under All Account Mail, and the Electron security bump are not in this version.",
    ],
    "0.3.7": [
      "Send with an undo delay closes compose and keeps the message in Outbox under All Account Mail until that delay ends. The wait is 30 seconds unless a shorter one is set. Outbox is local and lists every mailbox. Undo cancels the send and reopens the draft. Opening a waiting message does not send it. When the delay ends, send works as before and the message leaves Outbox. A zero delay sends immediately and skips Outbox.",
      "A partial delivery receipt stays open for review and is not a normal Outbox close. Quitting with a message still in Outbox asks first. Quit anyway sends it the next time Morrow is open, and it can no longer be undone. Restart and install waits while Outbox still has a message.",
      "Hover or focus Sync to see body activity for each mailbox, separately from list sync. If a foreground download fails before any body is available, the reader shows Retry download and leaves the message unread. A server response without the requested message is a failed download. Partial cached content stays visible with a download warning and retry.",
      "Switching mailboxes keeps body formatting, links, and a signature you edited. Only an untouched automatic signature follows the new mailbox. Gmail label copies of one message appear once in a conversation. Gmail folder sync keeps saved page progress, lets an open message go ahead, and still fetches at most 20 messages per pass.",
      "Notes for Agent learning, todo completion, FYI/Other batch read, card view, and holding an opened unread row are proposed only. Those behaviors are not in this version.",
    ],
    "0.3.6": [
      "Settings → Compose opens on display names, Preferred From, and a Signatures shortcut. Domain CC/BCC, aliases, the alias mailbox, and the fallback CC domain stay in Advanced.",
      "Advanced stays collapsed until a saved CC rule, BCC rule, alias, or fallback domain exists. Preferred From and display-name overrides do not open it. Longer policy notes sit in How this works. Existing rules and storage are unchanged.",
      "Compose From lists authorized addresses for every connected mailbox, grouped by account. Reply and forward still start on the mailbox that received the message.",
      "Choosing another mailbox reloads that mailbox's send-as list, CC/BCC defaults, and signature domain. Draft save and send use the selected mailbox. If the reloaded context does not authorize the address, the switch is discarded and the original mailbox stays selected. An existing draft on the previous mailbox is left there. The same address on two mailboxes stays with the current mailbox.",
      "Bot mail.send still sends only for the granted account and an address that account authorizes.",
    ],
    "0.3.5": [
      "Settings → AI data permission names why Allow stays unavailable: a missing saved API key or model, or a ChatGPT connection, plan step, or model that is not ready. The Allow tooltip uses that reason while the saved connection is not ready. Saving a key or signing in is still not consent.",
      "Unsaved connection edits, a save in progress, and a pending permission read keep Allow unavailable and say why. Save & review connection saves without granting permission. Choose permission after reviewing the saved destination.",
      "Reopening Settings keeps unsaved connection edits and asks for a fresh permission choice. The material disclosure stays visible; secondary detail is in an accordion. Explicit AI actions and background use stay separate choices. A changed destination, model, or account still needs a new review. Revoke stops queued and active requests; data already delivered cannot be recalled.",
      "Gmail sync and body downloads space reads for each mailbox after full message gets, leaving headroom under Google's per-user quota. A folder pass still fetches at most 20 messages. Writes and sends are not delayed or retried.",
      "Quota pauses still honor Retry-After, capped at 15 minutes. The first two pauses stay 30 seconds when Google does not say how long; later pauses grow from 2 minutes up to 15 minutes. That spacing is per mailbox in this app. It is not shared across accounts or machines, and Morrow does not show remaining quota.",
    ],
    "0.3.4": [
      "Gmail sync failures after Google login name an allowlisted category when Google supplies evidence: quota or rate limit, missing permission, a disabled API, domain policy, or unknown. Raw provider bodies, URLs, tokens and mail content stay out of these messages.",
      "Gmail sync Debug records omit the mailbox address, folder name and folder id. The mail UI and sync activity still show that mailbox and folder.",
      "A parsed Gmail category decides rate pauses. Sign-in, permission and unknown results keep their existing paths even if the reason mentions rateLimitExceeded. Only a quota category uses the quota pause. Errors without a Gmail diagnostic still use the existing rate-limit check.",
      "This does not identify or fix the live HTTP 403 that can follow a successful Google login. OAuth scopes, saved grants, credential storage and write retries are unchanged.",
    ],
    "0.3.3": [
      "Continue with Google stays primary. New connections and Gmail OAuth reconnects keep the manual password form collapsed; manual-provider reconnects retain their settings.",
      "Legacy Gmail sign-in offers Review Gmail API migration. It opens the matching Accounts review without starting migration; a changed or removed mailbox cancels the shortcut safely.",
      "Personal Google Desktop client import is an optional Advanced setting. The bundled client remains the default when present unless explicitly overridden.",
      "Google grants stay bound to the Desktop client that issued them. Older unknown-client grants need one-time Gmail and separate Calendar reauthorization; cached mail and drafts stay.",
      "Enabling Out of Office or reconnecting Gmail preserves a usable current-client Calendar grant instead of replacing it with stale credentials.",
      "Mail and conversation views reuse downloaded content and batch updates during reading and sync. Account changes and newer results invalidate stale work without deleting cached mail or drafts.",
    ],
    "0.3.2": [
      "Settings → AI data permission can again show status, review Allow and Revoke instead of failing with Unsupported channel.",
      "Save a ready API or ChatGPT connection, review its destination/model/account and explicitly choose manual AI use. Background use stays a separate optional choice.",
      "Changed saved destinations, models or accounts still require fresh review. Revocation stops queued and active work but cannot recall data already delivered.",
      "Updating does not grant AI permission automatically. This patch leaves mail body downloads and performance policy unchanged.",
    ],
    "0.3.1": [
      "Provider drafts prepare all attachment files before editing. Failed or cancelled preparation keeps the original draft for retry, including inline images and the selected sender.",
      "Save, Send and Schedule wait for AI writing to finish or be cancelled. Confirmation uses the reviewed preview; changing content requires another preview.",
      "Gmail handles more mail charsets, including cp932, UTF-7 and ISO-2022-JP. Malformed MIME is isolated, and incomplete fallback content keeps a visible reader warning.",
      "Reply and Reply All honor Reply-To with self-address filtering and deduplication. Known local Sent copies, including narrowly recognized older bot aliases, avoid unnecessary header reads; unknown remote headers still need retrieval.",
      "Calendar type changes retain dates. An unchanged timed → all-day → timed round trip restores the original hours; edited all-day ranges keep the selected dates with 09:00/10:00 defaults.",
      "These fixes passed synthetic provider, MIME, SQLite and DOM checks. Native UI, real delivery and live AI/provider behavior remain unverified.",
    ],
    "0.3.0": [
      "Settings → Compose previews a Morrow-only sender name for each exact From address. Keep the Gmail default, set a local name, clear it for address-only sending, or reset it.",
      "Refreshing Gmail identities preserves local name overrides and manually configured aliases. Names change mail sent from Morrow, not Gmail settings or sending permissions.",
      "Drafts and scheduled mail retain their selected sender name and address. Resume and recovery preserve names with quotes, brackets and Unicode without switching an alias to primary.",
      "Unchanged legacy drafts still clean up after a confirmed queued send; genuine subsequent name, From or body edits remain saved. Providers or recipient contacts may affect the delivered display.",
      "Preview, Open and Save share attachment downloads and reuse complete files from a bounded in-memory cache while Morrow is open.",
      "Save and Save as ZIP ask for a location before downloading. Cancelling the picker does not start a provider read.",
      "Attachment transfers show request-specific progress and Cancel controls without locking unrelated mail actions. Received bytes appear when available; there is no invented percentage.",
      "Closing Preview or cancelling one request leaves another Save or Open running. The last consumer stops queued or active provider work; a completed write or external launch cannot be recalled.",
      "Cached files expire after five minutes and are checked against the current account, message and attachment. Files over 32 MiB are not retained; incoming and ZIP size limits still apply.",
      "There is no background attachment prefetch or persistent attachment cache. Native dialogs and live provider performance remain unverified.",
    ],
    "0.2.39": [
      "Google mail can use Gmail API with narrower requested mail permissions. Google Calendar asks for its own optional grant.",
      "Existing Google OAuth IMAP accounts keep their connection until you review Migrate Gmail to Gmail API in Accounts. Cached mail and local drafts stay.",
      "Requesting fewer Google permissions does not automatically revoke old broad grants. Accounts shows requested and actual saved permissions separately.",
      "Gmail Delete and old draft cleanup keep mail in Trash, including repeated Delete from Trash. Gmail's own Trash retention still applies.",
      "Repeated message opens keep the correct Gmail attachments; Trash/Undo, Archive and draft updates retain the correct mail copies.",
      "AI data permission now requires disclosure and explicit approval for the saved destination, model and account. Background AI has a separate choice; saving a key or signing in is not consent.",
      "Revoking AI data permission stops queued and active requests. Data already delivered to a provider cannot be recalled.",
      "Google project and verification prerequisites still apply. Native and live Google migration, refresh and Calendar coexistence remain unverified; see the release notes.",
    ],
    "0.2.38": [
      "AI settings offer ChatGPT account sign-in alongside API keys and custom endpoints, with account-specific models and explicit background-use consent.",
      "AI saves preserve newer edits, tests ignore outdated responses, and cancelling sign-in allows a fresh attempt after cancellation finishes.",
      "Mail's Bodies disclosure shows current body downloads and queue, pause, error and last-result details for each mailbox separately from list sync.",
      "IMAP socket timeouts use normal connection-error and retry handling instead of an uncaught-exception dialog; existing retry delays stay the same.",
    ],
    "0.2.37": [
      "Password reconnects keep saved login settings consistent and report recovery failures.",
      "Signature saves show progress, ignore repeated submits, and keep the correct editing target when responses arrive late.",
      "Mail list shortcuts stay on Mail and preserve focused pagination, Sync, Scheduled, and other controls.",
      "Calendar time edits preserve long or untitled event titles and read-only description previews.",
      "Closing a calendar editor does not cancel a submitted save. Confirmed saves refresh month data while preserving newer edits.",
      "Events spanning midnight appear on each overlapping local date, including daylight-saving changes.",
      "Calendar validation and save errors appear in the dialog, retain your input, and correctly identify invalid date ranges.",
    ],
    "0.2.36": [
      "Routine IPC diagnostics omit mail arguments, renderer text and URLs, keeping channel, count and error metadata. Other Debug entries can still contain account or folder context.",
      "Bot capability descriptions correctly report when send permission may contact providers. Features → CLI explains that receipts describe SMTP outcomes rather than network-call counts.",
    ],
    "0.2.35": [
      "Mail changes use confirmed message identities. Interrupted or partial deliveries retain drafts and delivery records for review instead of resending automatically.",
      "Removing a mailbox invalidates pending sync and reconnect work. Bot access also refuses disconnected-account cache and proposals.",
      "Calendar edits preserve long descriptions and reject stale event revisions.",
      "Attachment downloads use exact file selections, include cached draft files in ZIPs, and stop when a selected file changes or is missing.",
      "Features → CLI explains supported bot actions, Tailscale setup, and the send authorization and revocation boundary.",
    ],
    "0.2.34": [
      "Features lists off-hours body fill from midnight to 7:00 local time, and Inbox Automation Rules show example placeholders.",
      "Check more than one calendar in the left list. Month and agenda combine those events and keep each calendar's color.",
      "Conversation shows the local date and time on each turn and opens at the bottom. Mark as read on Todos keeps your place in the list.",
      "Yahoo Mail connects beside Google and Microsoft with an app password, and Yahoo and AOL sign-in no longer stalls. Other addresses fill in from known hosts, mail servers, Thunderbird autoconfig, then SRV.",
    ],
    "0.2.33": [
      "The folder list uses arrow keys, and Collapse All closes every open section.",
      "Opening your mailbox shows the Morrow Mail mark, then What's new after the mail list loads.",
      "About shows the copyright line and links to Privacy, Terms, the license, the source, and support.",
    ],
    "0.2.32": [
      "About & updates shows a red mark when an update is available or ready to install.",
      "Morrow checks for updates when you open it, and about once an hour while it stays open.",
      "After an update, What's new lists what changed in this version once your mail list has loaded.",
    ],
  };

  function clean(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function notesFor(version) {
    const items = NOTES[clean(version)];
    if (!Array.isArray(items)) return [];
    return items.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  }

  function shouldOffer(input) {
    const version = clean(input && input.version);
    const seen = clean(input && input.seen);
    if (!input || input.listOk !== true || !version || version === seen) return false;
    return notesFor(version).length > 0;
  }

  return { notesFor, shouldOffer };
});
