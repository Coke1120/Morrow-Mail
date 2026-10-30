/* Hand-maintained Features catalog. Edit this list; do not generate it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowFeaturesCatalog = api;
})(typeof window === "object" ? window : globalThis, function () {
  return {
    items: [
      {
        id: "compose-work-preservation",
        title: "Compose recovery and preparation",
        category: "Mail",
        blurb: "Unrelated, completed and canceled AI draft events cannot replace manual edits. Selected files show Preparing attachment and block Save, previews, Send and Schedule until preparation settles; closing Compose abandons unfinished preparation. Undo atomically saves an inert recovery draft before opening Compose. Exact recipients and body, including cleared Cc/Bcc and one existing signature, are preserved. If Compose fails, resume from local Drafts; Undo never requeues delivery. Failed-send snapshots also bypass new-message defaults. Untouched multiline HTML signatures follow same-mailbox aliases; edited signatures stay intact. Changing recipient input retires old suggestion choices immediately, and escaped display-name quotes round-trip.",
      },
      {
        id: "brain-edit-preservation",
        title: "Profile edit preservation",
        category: "Agent",
        blurb: "Refresh and Rebuild preserve saved user-rule and category edits made during analysis. A changed learned profile rejects an obsolete analysis. Learned facts retain non-Latin names and text. Fix persists the selected row, including voice quotes, only while its stored version still matches; an obsolete Fix asks you to reload. Category-save readback preserves newer local edits and reports them as unsaved. Domain CC/BCC recipients may contain = in the address.",
      },
      {
        id: "calendar-write-safety",
        title: "Calendar write safety",
        category: "Calendar",
        blurb: "Known authorization failures offer Reauthorize calendar; ordinary refresh reuses valid grants. Retrying unchanged creation in the same editor reuses its Google event ID or Microsoft transaction ID. Check the provider before changing an uncertain submission and starting another event. Plain-text descriptions preserve literal angle brackets; readable HTML descriptions retain link targets. Outlook description edits tolerate surrounding whitespace in an unchanged baseline and still require the provider revision to match. Non-time edits omit time fields, preserving offsets and seconds through repeated daylight-saving hours. Ambiguous or nonexistent local time edits require another time or the provider editor with an explicit offset. Confirmed saves and deletes invalidate all cached months for the changed mailbox, even after closing the editor. Google calendar enumeration follows up to five pages; incomplete lists leave saved selections unchanged. Timed agenda and day-cell rows sort by actual instants across UTC offsets.",
      },
      {
        id: "ai-connection",
        title: "ChatGPT or API key",
        category: "Agent",
        blurb: "AI settings preserve API keys and custom endpoints, and add Continue with ChatGPT for eligible plans. Browser sign-in uses Morrow Mail's own registered client, automatic loopback and optional one-time paste-back. Cancel, timeout, account selection, reauthorization and sign-out are available. Cancellation permits a fresh retry without waiting for an old discovery response; obsolete attempts cannot change the new one. Save keeps newer edits unsaved, and connection test results apply only to the current settings. Fetch account-specific models before choosing one. AI data permission discloses mail, calendar, drafts, profile and conversation context and the saved destination before an affirmative choice. Settings → AI and AI Setup support review, allow and revoke; Allow requires a ready saved connection and the explicit-action checkbox. If Allow stays unavailable, the status names the missing saved API key, model, ChatGPT connection, or plan step. Unsaved edits, saves and pending permission reads block Allow with an actionable reason. Save & review connection saves without approving; choose permission after reviewing the saved destination. Reopening Settings preserves unsaved connection edits and requires a fresh permission choice. Material disclosure stays visible, with full details in an accessible accordion. Existing API and ChatGPT connections start with AI data use off. Saving a key or signing in is not consent. Explicit AI actions need approval; Background profile refresh, page-open triage, compose-open reply suggestions and scheduled skills need separate background opt-in. Destination, model, account and material data-use changes need fresh permission. Cancel / revoke stops queued and active AI requests; data already delivered cannot be recalled. ChatGPT requests set store: false; no retention or training guarantee is made. Plan, app and workspace limits apply; Manage usage opens ChatGPT settings. No automatic billing fallback, provider switching, extra allowance, hosted tools or general proxy. ChatGPT credentials use OS-encrypted storage and require unlocked OS secure storage. API keys are saved in ai.json with restricted file permissions, not OS encryption. AI Setup announces connection results as live status; setup readiness follows the selected authentication mode. Native and live sign-in validation remains pending.",
      },
      {
        id: "email-brain",
        title: "Email Brain",
        category: "Agent",
        blurb: "Profile, categories, skills, and inbox rules built from your mail. Skills can draft a reply or propose a move. You still press Send. Explicit Run buttons and Home chips run the selected skill ID, even when names repeat or resemble chat commands. Dirty schedule editors survive polls and background schedule events. Scheduled preflight refusals are currently visible in schedule status, not run history.",
      },
      {
        id: "agent-triage",
        title: "Agent triage",
        category: "Agent",
        blurb: "Files recent inbox mail into your Brain categories and stacks todos. A successful Reply or Reply All completes only the Needs You todo recorded when that reply starts. Forward, a new message, a saved draft, a canceled compose, a failed send, and a queued or scheduled send leave that todo open until the send succeeds. Mark as read leaves it open. The Settings opt-in \"Mark as read also completes Agent todos\" is off by default. Mark read & done marks the message read and completes the todo. Explicit reads wait for mailbox confirmation before completing a todo or counting for Learned; failed, unknown, superseded, and unattempted operations do not count. FYI and Other offer Mark category as read for the messages listed there, with Undo, and do not complete todos. Needs You has no Mark-all. Select rows, then Mark selected as read or Complete selected. The label says all only after every listed row is selected. Done and Dismiss stay on this computer. The Todos switcher includes List and Card. Card shows the sender, subject, one Agent reason line, and Reply and Done. Hover, Tab focus, or a tap opens the same detail: a fuller summary, the classification reason, one thread line, and Reply, Done, and Dismiss. Escape or leaving the card dismisses it. The page header does not repeat that detail. Opening the detail does not open the message or complete the todo. Settings → Learned lists explicit moves among Needs You, FYI, and Other, repeated Mark as read or a successful reply for one sender or thread, and opened or dismissed suggestion labels. Replies in any category can count after non-partial delivery, even without an open todo. Thread hints also appear for multi-sender threads. The same pattern is Learned after 3 times. Delete removes that pattern and its count and refreshes suggestions in open conversations, skills, and proposals. Learned rows stay on this computer and do not rewrite Brain categories, triage prompts, or mailbox rules, and they do not send mail or move it. Conversation triage and mail cards use the same Learned suppression and Delete restoration. Peek Retry download stays in peek without marking read or changing Mail selection. Unsaved standing notes survive background refresh and page reopen; save replies preserve newer typing. IMAP filing remains visible while its journal receipt is pending, confirms only a matching completed move, and keeps failed or uncertain outcomes for review. Uncertain filing is not retried automatically; check the message in Mail.",
      },
      {
        id: "compose-window",
        title: "Compose in its own window",
        category: "Mail",
        blurb: "New mail, reply, forward, and drafts open in a separate window, so the mailbox stays usable. Closing that window does not send. Send with an undo delay closes it and waits in Outbox. Reply and Reply All prefer Reply-To addresses when supplied, exclude your own addresses, and avoid duplicate recipients. Replies to locally sent mail, including historical bot mail from aliases, remain available while the Sent copy is waiting to sync. Finish or cancel AI writing before Save, Send or Schedule. Confirmation uses the reviewed message; changes require a new preview. To, Cc, and Bcc suggest up to eight addresses already in synced mail on this computer, ranked by how recent and how often they appear. Arrow keys then Enter, or a click, inserts one. Enter without a highlighted suggestion still previews the send, and an address you type is kept. Suggestions do not read a contacts directory or add a provider scope.",
      },
      {
        id: "conversation-members",
        title: "Conversation messages",
        category: "Mail",
        blurb: "Gmail label copies appear once in a conversation, using the provider message ID within the same account. The selected folder copy stays selected. Folder records remain stored. Distinct provider messages and rows without a reliable provider ID stay separate, even when RFC Message-ID matches. A single message has no Earlier section.",
      },
      {
        id: "reading-header",
        title: "Reading header",
        category: "Mail",
        blurb: "The open message shows its date and time on the From row, right-aligned, in the main reading pane and in a separate reader window. That text uses the reader's existing date and time format. To and Cc stay on the lines below. Main and separate readers apply definitive flag and removal receipts; terminal refusals restore the authoritative flags instead of announcing success. Remote images are on for new profiles. When disabled, normal image, CSS URL and table backgrounds stay blocked until Load remote content is chosen for that message. Unsupported CSS image functions, including image-set, are discarded.",
      },
      {
        id: "sender-identities",
        title: "Sender identities",
        category: "Mail",
        blurb: "Settings → Compose previews each exact From address and its Morrow-only display name. Verified Gmail send-as names are the default; local overrides survive refresh. Clear a name for address-only sending or reset to the default. Most people only need a display name. Domain CC/BCC, aliases, and the fallback CC domain stay under Advanced, collapsed until one of those rules is saved. Compose From lists authorized addresses for every connected mailbox; choosing another mailbox sends and saves drafts there. Switching mailboxes preserves body formatting and links, and keeps a signature you edited. Only untouched automatic signatures, including multiline HTML signatures, follow the new mailbox. Drafts and scheduled mail retain the selected name and address, including punctuation and Unicode in names. Bot mail.send uses these defaults on the granted account only. Provider sending permissions still apply; Gmail settings and OAuth scopes stay unchanged. Providers or recipient contacts may affect the delivered display. The Compose mailbox selector is in Basic, above sender names, Preferred From and Signatures; alias and domain rules remain in Advanced.",
      },
      {
        id: "signatures",
        title: "Signatures",
        category: "Mail",
        blurb: "Settings → Signatures lists an Account default and one row per send-as domain. Saving a domain row does not replace the account default. Compose uses that domain signature, then the account default, then no signature. Saving… shows while a save waits, and switching identities keeps the new editing target. Edit signature on a From card opens the same dialog.",
      },
      {
        id: "mail-keyboard",
        title: "Mail list keyboard navigation",
        category: "Mail",
        blurb: "On the Mail page, ↑ and ↓ move through messages and Enter opens the highlighted message. Focused buttons and links keep their own keys, including pagination, Sync, and Scheduled. Other pages keep their own focus.",
      },
      {
        id: "unread-filter",
        title: "Unread filter",
        category: "Mail",
        blurb: "The sidebar Unread filter and the All Account Mail Unread chip list downloaded unread mail. Opening an unread message may mark it read and keeps that one row in the list until a different unread message is opened. Opening a message that is already read, opening the held row again, or highlighting a row without opening it leaves the hold. Mark read on the held row from the row button leaves it listed. Mark unread clears the hold and the row stays because it is unread. Mark read on a row that is not held removes it immediately. Multi-select Mark read removes every selected row immediately, including the held row when it is selected, even when only that row is selected. A held row outside the selection stays. Leaving Unread, switching folder or account, searching, or turning the filter off clears the hold, and coming back does not restore it. Refresh and Sync keep the held row unless the message is gone from that filtered mail. Other filters do not keep a read row this way.",
      },
      {
        id: "undo-removal",
        title: "Undo removal details",
        category: "Mail",
        blurb: "Archive, Trash, and Move keep Undo for every completed change in the current removal. Details, beside Undo, opens a checklist with the subject, sender, and action (archive, trash, or move), plus the destination when it is known. Rows also show the mailbox label/address when the session spans multiple accounts. Each checkbox keeps its subject as its name; its description includes the sender, action, destination and mailbox when shown. Select all or Clear, then Undo selected. The status chip only shows or hides the notice, anchored at the bottom-right. Details stays open during same-session late completions, preserving surviving selection, scroll and checkbox focus; new rows start unchecked. Escape closes it and returns focus. Restore controls wait until pending changes settle, and unreported rows stay available. Mark as read keeps its own Undo and does not replace a removal Undo. A newer removal replaces that list. Outbox undo send is separate and is not in this checklist. Separate account settlements from one reviewed removal join that same session in either order; late settlements from an older removal cannot replace the newer checklist.",
      },
      {
        id: "attachment-downloads",
        title: "Attachment downloads",
        category: "Mail",
        blurb: "Preview, Open and Save share downloads. Complete files up to 32 MiB can be reused for five minutes while Morrow is open; larger files remain on demand. Save asks for a location first. Attachment transfers show progress and individual Cancel controls; closing Preview keeps another Save or Open running. Downloads allow 64 MiB per file and 128 MiB per ZIP, with existing provider limits. Changed identities stop reuse; reopen legacy Gmail selections. Resuming a server draft prepares every attachment before editing, within the 25 MiB outgoing limit. Preparation shares the download cache and Cancel controls. Failure keeps the saved draft for retry. Inline file identities are retained. Bot access remains metadata only.",
      },
      {
        id: "local-search",
        title: "Search on this computer",
        category: "Mail",
        blurb: "Toolbar search reads subject, from, and body already synced to this computer. When the local index needs repair, opening shows preparation progress and works in saved batches, yielding between them. Mail and search become available after verification. Quitting keeps committed progress for the next open. No mail is downloaded by rebuilding. A large individual message or disk call can still cause a pause.",
      },
      {
        id: "schedule-send",
        title: "Send later",
        category: "Mail",
        blurb: "Schedule send keeps the message on this computer and delivers it while Morrow is open. Cancel asks twice, then Undo cancel is available for about eight seconds to restore that record. An Undo started in time keeps its success or failure feedback after the offer expires. A newer cancellation replaces the Undo offer, and an older restore cannot consume it or overwrite its feedback, even after the newer offer expires. Quitting with a pending send asks you first. Unchanged source drafts are cleaned up after delivery, including names with quotes or angle brackets; later edits stay saved. Default schedule-delay saves keep newer Hours and Minutes edits and report when they are still unsaved.",
      },
      {
        id: "outbox",
        title: "Outbox",
        category: "Mail",
        blurb: "Send closes compose and keeps the message in Outbox, a child of the collapsible All Account Mail section beside Inbox, until the undo delay ends (30 seconds unless a shorter one is set). Choosing the All Account Mail header only expands or collapses. Inbox opens the same merged list and keeps the Unread chip. Local only, every mailbox. Undo cancels the queued send and saves an inert recovery draft before opening Compose. When Undo reopens Compose, the original reply's Agent todo stays linked and completes only after a confirmed send. If Compose cannot open, resume it from local Drafts; the recovery draft never sends automatically. Recovery failure leaves the queued send unchanged. Once delivery starts, Undo cannot cancel it. Opening a waiting message does not send it. After the delay, send works as before and the message leaves Outbox. A partial delivery receipt stays open for review and is not a normal Outbox close. Quitting with a message still in Outbox asks first; it sends the next time Morrow is open. Restart and install waits while a message is still in Outbox. Zero undo delay sends immediately and skips Outbox. Uncertain submission keeps its content, Message-ID and recovery record in Scheduled delivery review across restart; check Sent and acknowledge recovery before creating a retry draft. It never auto-restores to an editable send. Entering Outbox retires earlier folder and search reads. A queue-read failure shows Unknown and Retry in Outbox, retaining any stale rows without claiming the queue is empty.",
      },
      {
        id: "out-of-office",
        title: "Out of Office",
        category: "Mail",
        blurb: "After you confirm, Settings writes a Gmail vacation reply, a Microsoft automatic reply, or an IMAP sieve script. Morrow does not send those replies itself. Provider replies preserve edits made during Save or Refresh as unsaved while updating the reviewed revision. Switching mailbox during a read cannot cache an unapplied result. Google mail/settings permission excludes Calendar; Microsoft uses its separate Graph bundle.",
      },
      {
        id: "imap-recovery",
        title: "IMAP connection recovery",
        category: "Mail",
        blurb: "Connection timeouts during IMAP sync use the usual connection-error and retry status. Inbox push falls back to polling and reconnects with backoff.",
      },
      {
        id: "overnight-body-fill",
        title: "Full message bodies",
        category: "Mail",
        blurb: "Hover or focus Sync to see per-mailbox body activity, separately from list sync. Move into the panel to scroll, or Tab into it and use the arrow keys; it stays open while hovered or focused. Message requests and the listed page download as needed. If a foreground download fails before any body is available, the reader shows Retry download and leaves the message unread. A server response without the requested message is treated as a failed download. Partial cached content stays visible with a download warning and retry. While the app is awake/open, 00:00–07:00 local adds one indexed body after each background folder pass, within Mail & Sync history; trash, spam and drafts are excluded. It yields to mail work and rate limits. Gmail API body downloads use the same per-user read spacing as sync. Activity has no whole-mailbox total or percentage. IMAP messages can remain incomplete at the 3 MiB source limit; this shows Limited with No action needed and keeps available content. Download and decoding failures still show Needs attention; Gmail API handles MIME parts within its response limit; attachment files stay on demand. Gmail decodes legacy mail encodings including cp932 and UTF-7, and retains ISO-2022-JP decoding. Malformed MIME or an unknown charset leaves available content with an incomplete-body warning and does not stop other messages from syncing.",
      },
      {
        id: "inbox-rules",
        title: "Inbox Automation Rules",
        category: "Mail",
        blurb: "Gmail filters and Outlook rules save on the provider after you grant access. Other accounts store the rule here and apply it to new Inbox mail.",
      },
      {
        id: "google-desktop-oauth",
        title: "Google sign-in and optional personal client",
        category: "Accounts",
        blurb: "Continue with Google uses the bundled Desktop client by default when present. New connections and Gmail OAuth reconnects keep Other email provider collapsed; manual-provider reconnects retain their form. A legacy Gmail connection offers Review Gmail API migration, which opens Accounts without migrating until you review and confirm. Settings → Accounts → Advanced: personal Google OAuth client (optional) imports a Desktop JSON into this computer's app data. An explicit import replaces the bundled client; developer environment variables still win. Web client JSON is rejected and the secret is not shown. Clear imported client removes only that file. Changing clients requires Gmail and separate Calendar reauthorization. Older grants with an unknown client need one-time reauthorization; cached mail and saved credentials stay. Finish or cancel Google sign-in before import or clear; finish the picker before starting Google sign-in. Invalid developer environment overrides must be fixed or removed. Local readiness does not prove Google permits sign-in.",
      },
      {
        id: "multi-account",
        title: "Multiple mailboxes",
        category: "Accounts",
        blurb: "Connect Google, Microsoft, and IMAP mailboxes. Password reconnects save the matching login type and servers after credentials are saved; failures attempt to restore prior credentials. Inbox under All Account Mail lists downloaded Gmail All Mail, or Inbox for other accounts. Disconnect invalidates queued sync and pending reconnects; server mail stays. Start a new connection after removal to add it again. Gmail Delete moves to Trash; deleting again keeps mail there. Conversation Trash acts once per Gmail message across label copies, with one membership snapshot for Undo. Verified copies leave their old labels after Trash; unrelated cached mail and unsaved edits stay. Archive removes Inbox membership even from All Mail or a search copy. Gmail draft cleanup moves old remote copies to Trash. Microsoft and other IMAP deletion behavior is unchanged. Google login remains OAuth. New Google connections use Gmail API polling/history with gmail.modify and gmail.settings.basic; Calendar is separate. Existing Google OAuth accounts migrate after review in Accounts. Cached mail and drafts stay; uncertain actions must be resolved first. A narrower request does not revoke older broad grants; Accounts shows actual saved scopes. Gmail API cannot move mail into Sent or Drafts; use Send or Save draft.",
      },
      {
        id: "bot-bridge",
        title: "Bot bridge",
        category: "Accounts",
        blurb: "An optional loopback API lets a bot read cached mail and propose inert drafts for connected, granted mailboxes. A separate send permission allows immediate plain-text mail. Access starts off; CLI explains capabilities, possible provider calls, Tailscale setup, and revocation limits. Disable and Revoke remain actionable during a connection probe. Access mutations are serialized in user order, including enable followed by disable; probe feedback cannot discard the intent. Acknowledged disable blocks new calls but retains saved grants, and cannot recall a submission already in progress.",
      },
      {
        id: "calendar",
        title: "Calendar",
        category: "Calendar",
        blurb: "Month view for Google Calendar or Microsoft Graph when that account has calendar access. Incomplete Google Calendar reauthorization preserves the working Calendar connection. Enabling another feature or reconnecting Gmail also preserves a usable current-client Calendar grant ahead of stale records. Create, edit, and delete events. Timed events appear on each local date they overlap. Closing a pending save does not cancel it; confirmed changes refresh the month. Titles over 200 characters and long Google descriptions stay read-only previews; other field edits preserve their complete values. Unchanged titles are kept, including untitled events. Save errors appear in the event dialog and keep your input. Invalid dates are reported before description preview restrictions. Opening an all-day event or switching between all-day and timed input keeps the dates. All-day ends are exclusive. An unchanged timed → all-day → timed round trip in the same editor restores the original dates and hours. Edited all-day dates or an event opened as all-day use 09:00/10:00 defaults when switched to timed.",
      },
      {
        id: "in-app-updater",
        title: "In-app updates",
        category: "Updates",
        blurb: "About & updates checks for a release on launch and every hour while Morrow is open. A red ! on that button means an update is ready. Restart and install applies a downloaded update once every compose window is closed and Outbox is empty.",
      },
      {
        id: "mail-body-updates",
        title: "Mail body updates",
        category: "Mail",
        blurb: "Mail lists batch action metadata. Body notifications carry availability instead of full messages; open readers and previews refresh from already downloaded mail. Each window can reuse up to 32 recent bodies within an estimated 8 MiB of strings, at most 2 MiB per entry. Larger bodies remain available in the open view. Reconnect/removal invalidates reuse; cache eviction never deletes saved mail, drafts or attachments. Native Mac responsiveness still needs profiling.",
      },
      {
        id: "mail-responsiveness",
        title: "Mail responsiveness",
        category: "Support",
        blurb: "Cached lists and thread headers avoid copying message bodies into JavaScript. IMAP sync keeps existing search terms when indexed content is unchanged. On macOS, routine mail credential reads and startup checks wait asynchronously, share pending reads and stop waiting after 30 seconds. Read failures retain saved credentials. Some account setup/status checks and credential writes remain synchronous, bounded to 30 seconds per command. Search repair yields between saved batches; individual index or disk calls can still pause work. Durable writes are unchanged. MORROW_PERF=1 enables bounded local timings in Debug log every 30 seconds, without mail contents or telemetry. Native Mac freezes still need profiling.",
      },
      {
        id: "gmail-error-diagnostics",
        title: "Gmail API error details",
        category: "Support",
        blurb: "Gmail sync activity and Debug log show HTTP status, a fixed operation and recognized Google reason/status codes. They distinguish quota or rate limits, missing mail permission, a disabled API and domain policy when Google supplies evidence. Unknown causes stay unknown. Raw error bodies, provider text, URLs, ids, mail content, addresses and tokens are omitted from these diagnostics. Gmail sync Debug records omit the mailbox address, folder name and folder id; sync activity still shows that mailbox and folder. Other Debug entries may still identify an account or folder. Only a quota classification pauses for quota or rate limits. Sync fetches up to 20 Gmail messages per folder pass. This counts actual message reads across history, bootstrap and cached verification. Pending pages resume from saved positions; a waiting message open goes ahead after the current read. Gmail sync and body downloads space reads to stay under the per-user quota. A quota pause honors Retry-After, capped at 15 minutes. The first two pauses are 30 seconds when Google does not say how long; later pauses grow from 2 minutes up to 15 minutes. Reads are spaced; writes are not. Sign-in success alone does not identify a later 403; these details do not prove its cause. No new scopes or automatic write retries are added.",
      },
      {
        id: "ipc-diagnostics",
        title: "IPC diagnostics",
        category: "Support",
        blurb: "IPC trace records known channels and argument counts, plus renderer levels, line numbers and load codes. Request values, renderer text and URLs are omitted. Other Debug entries may retain account/folder context.",
      },
    ],
  };
});
