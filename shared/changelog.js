// What's new copy, keyed by the package.json version (no leading v).
// On each release, add that version's user-facing lines in the same change as the bump.
// A missing or empty entry does not open a dialog. This file does not fetch GitHub.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowChangelog = api;
})(typeof window === "object" ? window : globalThis, function () {
  const NOTES = {
    "0.4.5": [
      "Mailbox headings and folder rows share a consistent appearance across Gmail, Outlook, Yahoo, IMAP and Local Folders, while real folders keep their expansion hierarchy.",
      "Folders & Labels adds clearer mailbox switching and reviewed creation. Gmail label deletion requires confirm and offers 30 seconds to cancel before removal; unsafe folder deletion on other server transports stays unavailable.",
      "Unchanged AI data permissions survive updates. Thread Timeline and cross-thread Case remain separate opt-ins; new or expanded data uses still require approval.",
      "Suggested replies move into Write with AI. Its prompt supports multiple lines and vertical resizing; Enter inserts a line and Ctrl/Command+Enter generates. Selecting a suggestion does not generate or send.",
      "Compose's native right-click menu offers available spelling corrections and editing actions without AI. Suggestions depend on the platform and dictionaries; this is not grammar checking.",
      "Timeline reports safe stage-specific validation errors, accepts a single complete JSON fence and keeps bounded retries and saved history. The reported incident's actual cause remains unproven.",
      "Mail-row menus add read, star and safe Trash actions plus a combined Copy/Move dialog for Local Folders. Remote mailbox Copy/Move is still developing and disabled in this proposal.",
      "Date and Time are separate mail-list columns. Right-click a header or use Columns to hide or show Time; saved layouts, device timezone and full-timestamp sorting are preserved.",
    ],
    "0.4.4": [
      "Local Folders now has compact New local folder and Import MBOX icon buttons beside its heading, with tooltips, accessible names and visible keyboard focus.",
      "The buttons remain separate from expand/collapse and keep the existing review, cancellation and focus-return behavior. Opening them does not create a folder or start an import.",
    ],
    "0.4.3": [
      "Local Folders keeps complete original mail and attachments on this computer, even after an account is disconnected. Copy verifies saved bytes; Move then uses recoverable server Trash after review.",
      "Import MBOX reviews exported or stopped Thunderbird mailboxes, destination, format and duplicates. Stop, errors and restart keep committed local mail; continuing is an explicit action and original files stay unchanged.",
      "Case / client Timeline searches the current account's downloaded mail across threads. Choose Main / Background sources, review coverage and destination, then confirm before Generate. Cited suggestions still need human review.",
      "Settings → AI requires renewed manual data permission for the Case disclosure. Background permission stays separate. Independent To/Cc headers remain local evidence, while body text and optional focus can contain addresses.",
      "Selective local search and pending-body work use more efficient access paths. Background IMAP writes yield between durable batches; broad queries, a large message or a disk call can still pause the host.",
      "Local archive search applies consistent Unicode normalization and lowercasing. An explicit connected-account search scope stays selected, and local reader Trash follows the complete reviewed selection, including filter-hidden rows.",
      "Case mode can review a smaller selection when the initially opened thread exceeds its limits. MBOX import restores keyboard focus after completion rebuilds the sidebar.",
    ],
    "0.4.2": [
      "Summary presents one main point and up to six plain-language bullets. Longer or incomplete downloaded text gets an explicit coverage choice; Timeline shows request limits and supports reviewed retries.",
      "To Me filters downloaded mail by the owning mailbox’s primary address in To. Attachments start collapsed with the file count and Save as ZIP still visible; All Mail folder chips align with Inbox and Sent.",
      "Delete and Backspace act on the reviewed selected messages, including selected rows hidden by a filter. Independent readers keep their own target.",
      "Preview Send and Outbox display safe readable HTML while keeping recipient, subject and sending review intact. Fresh Reply/Forward subjects normalize recognized language prefixes; edited and saved subjects stay unchanged.",
      "Gmail repairs eligible historical Reply indicators during bounded normal sync. IMAP replies and forwards retain confirmed local evidence and attempt supported server flags after every intended recipient is accepted.",
      "Settings → Brain offers Daily, Weekly and Manual only refresh. Automatic attempts share one job and wait the configured interval after failure or restart; background AI data permission stays a separate opt-in.",
      "Mail handles quoted and continued charset parameters, discloses decoding uncertainty and offers safe text alternatives. Explicit Retry download can replace a complete server copy without silently discarding pending edits.",
      "Feature reads recover from expired authorization and temporary Google-client configuration errors while preserving separate mail, Calendar and Graph permissions.",
    ],
    "0.4.1": [
      "Compose settings add question-mark help for mailbox defaults and Preferred From. Refresh From addresses now sits beside Sender identities; AI privacy details open in a separate dialog.",
      "Timeline stays usable during routine account refreshes, shows correspondence in date order with source evidence, and exports a readable HTML file after review.",
      "Existing AI data permission needs a fresh manual choice for Timeline’s sender/date evidence and optional focus. Background use remains a separate opt-in.",
      "Scheduled and Out of Office open from the same sidebar row. Every mailbox has its own saved expansion choice, including Yahoo and custom IMAP; Collapse All only collapses folders.",
      "The setup guide adds Mail preferences for Undo send, default schedule delay and remote images. Each choice has its own Save button; skipping keeps saved settings.",
      "Gmail keeps confirmed reply and forward indicators through sync. Reply evidence may also come from already-downloaded Sent mail; ambiguous history stays unknown.",
    ],
    "0.4.0": [
      "Maintenance rebuild after synchronizing main and dev history. The application behavior and features remain the same as v0.3.25.",
    ],
    "0.3.25": [
      "Settings → Accounts opens on actionable account cards with each mailbox’s full identity, provider and connection status. Its settings appear immediately, with clear Add account and no-account guidance.",
      "Settings keeps its selected mailbox independent of Mail. Switching accounts preserves the Out of Office discard review, rejects stale permission results, and restores keyboard focus when an account is removed.",
      "Mailbox folder chips show one canonical name per enabled role, so Sent Items, Sent Mail and casing variants no longer appear as duplicate Sent chips.",
      "Expanded IMAP, Gmail and Outlook accounts share the same colorful sidebar icons for known folder roles, with a folder icon for custom folders.",
      "Chips stay in a fixed order for the selected mailbox. All Account Mail keeps Inbox, Outbox, Starred and Unread; cross-account Sent, Drafts, Trash, Junk and Archived chips stay unavailable.",
    ],
    "0.3.24": [
      "Timeline is one button beside Summary in the opened-message action bar. A sheet offers optional keywords and editable From/To/Cc/Reply-To contacts; only Generate starts AI on that message's downloaded thread.",
      "Message/Timeline tabs and duplicate Generate timeline entries are removed. Right, Bottom and Separate window layouts keep the reader intact.",
      "Cached reply and forward flags show as icons before the Subject instead of a separate list column. Column visibility, sort and keyboard reorder stay as before.",
      "Public JSON 1.0.0, Markdown and isolated PDF exports, consent, coverage limits and personal-information review are unchanged.",
    ],
    "0.3.23": [
      "Gmail API mail reads renew saved tokens per request and can retry one rejected read after renewal. Writes are never replayed; unconfirmed submissions remain for review. Legacy IMAP, Calendar and provider sign-in policies are unchanged.",
      "The reader adds a Timeline tab for reviewed selected messages, downloaded threads and downloaded search results. Only Generate starts AI; no mail is marked read, relabeled or sent.",
      "Save timelines locally and export reviewed Markdown, PDF or public JSON 1.0.0 files. Coverage, timestamp provenance and uncertainty remain visible; exports require personal-information review.",
      "AI data permission needs a fresh review for Timeline extraction. Existing users must approve the saved AI destination again; background permission remains a separate choice.",
      "Outlook sync checks tokens after mailbox queue waits and can silently renew a rejected OAuth login once before any mailbox operation. Writes are never replayed; genuine sign-in requirements remain."
    ],
    "0.3.22": [
      "Choose Right, Bottom or Separate window reading layouts from View. Mail list corners and Sync menu layering stay consistent across layouts.",
      "Mail lists show available reply and forward status, let you choose visible columns, and display Outbox recipients correctly. Keyboard reordering preserves hidden-column positions.",
      "Summary on the reader toolbar summarizes the downloaded message on demand using your configured AI and existing data permission. You can cancel or retry; incomplete content is identified.",
      "Separate window keyboard shortcuts follow the single selected message and its mailbox. Loading, failed or ambiguous selections cannot act on an old preview. Notification clicks open a visible reader.",
      "Out of Office makes the selected mailbox, status and reviewed controls clearer. Features and README describe the current mail, Agent, bot and CLI capabilities.",
    ],
    "0.3.21": [
      "New Inbox mail can show system notifications on Windows and macOS. Alerts are on by default with sender and content hidden; Settings → Mail & Sync controls alerts and previews.",
      "Saved connections retry temporary renewal and secure-storage failures instead of unnecessarily asking for sign-in. Renewed credentials must be saved before use.",
      "Proactive notify supports explicit native Hermes HMAC V2 authentication while preserving existing Bearer settings. HTTP acknowledgement does not verify agent completion.",
      "Updates keep checking after a cached Mac download. Installed Windows updates wait for final shutdown, and portable Windows copies use manual downloads.",
    ],
    "0.3.20": [
      "New users get a five-step setup guide for mailbox, calendar, sender name, signature and optional AI. Settings can reopen it and resume progress.",
      "Drag mail column headers to reorder them, or use Columns and keyboard controls. The saved layout is independent of sorting and can be reset.",
      "All Account Mail adds Starred and Unread views with downloaded-mail counts. The Inbox unread chip is removed; each mailbox keeps its unread counts.",
      "Allow sending responds correctly after the No expiry bot review. Cancel, Escape and failed creation retain the form for another review.",
      "Bots can separately request permission to archive, mark read or unread, and move one message to Trash. Permissions start off, stay limited to selected mailboxes, and never allow permanent deletion.",
      "Bot mail changes report pending and confirmed outcomes. Repeating a request ID observes its original result; unknown outcomes require review instead of automatic retry.",
    ],
    "0.3.19": [
      "Undo asks you to confirm the reviewed changes; Cancel or Escape keeps your selection without changing mail.",
      "Select all and Clear selection keep Undo Details open when using the mouse or keyboard.",
      "First-use Google setup appears after What's New or another startup dialog closes, without needing to restart; Later is still remembered.",
    ],
    "0.3.18": [
      "Mail lists show Date, Recipient, Sender and Subject columns; select a header to sort matching downloaded mail before paging.",
      "Your mail sort order is remembered on this device, and changing it returns to page one while keeping the reader open.",
      "New profiles without accounts or a Google client can import Desktop JSON or choose Later; Accounts keeps a visible import reminder.",
    ],
    "0.3.17": [
      "Save as ZIP stays more responsive during archive preparation, with progress and cancellation before saving.",
      "Attachment saves keep writes in order and check cancellation before opening an external application.",
      "Sidebars with many folders refresh more efficiently while retaining unread counts and selection.",
    ],
    "0.3.16": [
      "Residual mail journal and mailbox work stays bounded, with a scoped refresh cursor.",
      "Deleting a bot removes its webhook credential before its grant, and Settings shows storage-related delivery halts truthfully.",
      "Mark category as read reports Already read and stays disabled when the category has no unread mail.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.15": [
      "All Account Inbox shows the selected mailbox Out of Office status, including compact off state and Manage.",
      "Large-mailbox startup uses phased preparation with a body-metadata budget and size-scaled checkpoint policy.",
      "Local search projects metadata for large mailboxes, with scoped summary staging and keyset paging for unfiltered lists.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.14": [
      "Bot mail can use Hermes Agent, with optional cached-mail notifications when you opt in.",
      "Proactive bot work stops cleanly when a cursor or status write fails; schedule controls that stay hidden no longer block native form validation.",
      "Bulk Undo keeps the reader clear across epochs, and overnight scan keeps its cursor after a retain path.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.13": [
      "Features and Settings Support include GitHub Sponsors and Buy Me a Coffee links; sponsor destinations in Features are clickable.",
      "Undo, signature loading, Outbox, and overnight scan P2 fixes; Learned recoveries after a read failure no longer stick on a stale error.",
      "The Electron/Node security bump is not in this version.",
    ],
    "0.3.12": [
      "Mail sync and related work stay bounded: credential reads stay async, recipient aggregates use header deltas, sync batches yield, and invalidations stay scoped. Outbox summaries, coalesced reads, and body backfill keep Calendar, Agent, and UI retention.",
      "Folders and labels keep provider organize identity. Support-rail Open in Mail navigation is hardened.",
      "The All Account unread chip uses the primary-mailbox unread sum and stays fresh while you view Secondary or other folders. Bulk Archive and Trash run in non-blocking chunks with accumulated Undo and Details across batches. Agent navigation is cache-first: the overlay shows only on a cold load or Refresh. All Account Out of Office opens a mailbox chooser instead of silently picking one account.",
      "The Electron/Node security bump is not in this version.",
    ],
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
