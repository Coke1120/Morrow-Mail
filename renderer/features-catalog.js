/* Hand-maintained Features catalog. Edit this list; do not generate it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowFeaturesCatalog = api;
})(typeof window === "object" ? window : globalThis, function () {
  return {
    items: [
      {
        id: "ai-connection",
        title: "ChatGPT or API key",
        category: "Agent",
        blurb: "AI settings preserve API keys and custom endpoints, and add Continue with ChatGPT for eligible plans. Browser sign-in uses Morrow Mail's own registered client, automatic loopback and optional one-time paste-back. Cancel, timeout, account selection, reauthorization and sign-out are available. Cancellation permits a fresh retry without waiting for an old discovery response; obsolete attempts cannot change the new one. Save keeps newer edits unsaved, and connection test results apply only to the current settings. Fetch account-specific models before choosing one. AI data permission discloses mail, calendar, drafts, profile and conversation context and the saved destination before an affirmative choice. Settings → AI and AI Setup support review, allow and revoke; Allow requires a ready saved connection and the explicit-action checkbox. Existing API and ChatGPT connections start with AI data use off. Saving a key or signing in is not consent. Explicit AI actions need approval; Background profile refresh, page-open triage, compose-open reply suggestions and scheduled skills need separate background opt-in. Destination, model, account and material data-use changes need fresh permission. Cancel / revoke stops queued and active AI requests; data already delivered cannot be recalled. ChatGPT requests set store: false; no retention or training guarantee is made. Plan, app and workspace limits apply; Manage usage opens ChatGPT settings. No automatic billing fallback, provider switching, extra allowance, hosted tools or general proxy. Credentials stay encrypted on this computer; unlocked OS secure storage is required. Native and live sign-in validation remains pending.",
      },
      {
        id: "email-brain",
        title: "Email Brain",
        category: "Agent",
        blurb: "Profile, categories, skills, and inbox rules built from your mail. Skills can draft a reply or propose a move. You still press Send.",
      },
      {
        id: "agent-triage",
        title: "Agent triage",
        category: "Agent",
        blurb: "Files recent inbox mail into your Brain categories and stacks todos. Reply opens a compose window. Done and Dismiss stay on this computer.",
      },
      {
        id: "compose-window",
        title: "Compose in its own window",
        category: "Mail",
        blurb: "New mail, reply, forward, and drafts open in a separate window, so the mailbox stays usable. Closing that window does not send. Reply and Reply All prefer Reply-To addresses when supplied, exclude your own addresses, and avoid duplicate recipients. Replies to locally sent mail, including historical bot mail from aliases, remain available while the Sent copy is waiting to sync. Finish or cancel AI writing before Save, Send or Schedule. Confirmation uses the reviewed message; changes require a new preview.",
      },
      {
        id: "sender-identities",
        title: "Sender identities",
        category: "Mail",
        blurb: "Settings → Compose previews each exact From address and its Morrow-only display name. Verified Gmail send-as names are the default; local overrides survive refresh. Clear a name for address-only sending or reset to the default. Drafts and scheduled mail retain the selected name and address, including punctuation and Unicode in names. Bot mail.send uses these defaults. Provider sending permissions still apply; Gmail settings and OAuth scopes stay unchanged. Providers or recipient contacts may affect the delivered display.",
      },
      {
        id: "signatures",
        title: "Signatures",
        category: "Mail",
        blurb: "Settings → Signatures shows Saving… and ignores repeated saves in the current editor while it waits. Switching signatures keeps the new editing target.",
      },
      {
        id: "mail-keyboard",
        title: "Mail list keyboard navigation",
        category: "Mail",
        blurb: "On the Mail page, ↑ and ↓ move through messages and Enter opens the highlighted message. Focused buttons and links keep their own keys, including pagination, Sync, and Scheduled. Other pages keep their own focus.",
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
        blurb: "Schedule send keeps the message on this computer and delivers it while Morrow is open. Quitting with a pending send asks you first. Unchanged source drafts are cleaned up after delivery, including names with quotes or angle brackets; later edits stay saved.",
      },
      {
        id: "out-of-office",
        title: "Out of Office",
        category: "Mail",
        blurb: "After you confirm, Settings writes a Gmail vacation reply, a Microsoft automatic reply, or an IMAP sieve script. Morrow does not send those replies itself.",
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
        blurb: "Mail → Bodies shows per-mailbox body activity separately from list sync. Message requests and the listed page download as needed. While the app is awake/open, 00:00–07:00 local adds one indexed body after each background folder pass, within Mail & Sync history; trash, spam and drafts are excluded. It yields to mail work and rate limits. Activity has no whole-mailbox total or percentage. IMAP messages can remain incomplete at the 3 MiB source limit; Gmail API handles MIME parts within its response limit; attachment files stay on demand. Gmail decodes legacy mail encodings including cp932 and UTF-7, and retains ISO-2022-JP decoding. Malformed MIME or an unknown charset leaves available content with an incomplete-body warning and does not stop other messages from syncing.",
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
        blurb: "Connect Google, Microsoft, and IMAP mailboxes. Password reconnects save the matching login type and servers after credentials are saved; failures attempt to restore prior credentials. All Account Mail lists downloaded Gmail All Mail, or Inbox for other accounts. Disconnect invalidates queued sync and pending reconnects; server mail stays. Start a new connection after removal to add it again. Gmail Delete moves to Trash; deleting again keeps mail there. Conversation Trash acts once per Gmail message across label copies, with one membership snapshot for Undo. Verified copies leave their old labels after Trash; unrelated cached mail and unsaved edits stay. Archive removes Inbox membership even from All Mail or a search copy. Gmail draft cleanup moves old remote copies to Trash. Microsoft and other IMAP deletion behavior is unchanged. Google login remains OAuth. New Google connections use Gmail API polling/history with gmail.modify and gmail.settings.basic; Calendar is separate. Existing Google OAuth accounts migrate after review in Accounts. Cached mail and drafts stay; uncertain actions must be resolved first. A narrower request does not revoke older broad grants; Accounts shows actual saved scopes. Gmail API cannot move mail into Sent or Drafts; use Send or Save draft.",
      },
      {
        id: "bot-bridge",
        title: "Bot bridge",
        category: "Accounts",
        blurb: "An optional loopback API lets a bot read cached mail and propose inert drafts for connected, granted mailboxes. A separate send permission allows immediate plain-text mail. Access starts off; CLI explains capabilities, possible provider calls, Tailscale setup, and revocation limits.",
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
        blurb: "About & updates checks for a release on launch and every hour while Morrow is open. A red ! on that button means an update is ready. Restart and install applies a downloaded update once every compose window is closed.",
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
        id: "ipc-diagnostics",
        title: "IPC diagnostics",
        category: "Support",
        blurb: "IPC trace records known channels and argument counts, plus renderer levels, line numbers and load codes. Request values, renderer text and URLs are omitted. Other Debug entries may retain account/folder context.",
      },
    ],
  };
});
