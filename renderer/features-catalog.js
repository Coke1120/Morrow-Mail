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
        blurb: "AI settings preserve API keys and custom endpoints, and add Continue with ChatGPT for eligible plans. Browser sign-in uses Morrow Mail's own registered client, automatic loopback and optional one-time paste-back. Cancel, timeout, account selection, reauthorization and sign-out are available. Cancellation permits a fresh retry without waiting for an old discovery response; obsolete attempts cannot change the new one. Save keeps newer edits unsaved, and connection test results apply only to the current settings. Fetch account-specific models before choosing one. AI data permission discloses mail, calendar, drafts, profile and conversation context and the saved destination before an affirmative choice. Existing API and ChatGPT connections start with AI data use off. Saving a key or signing in is not consent. Explicit AI actions need approval; Background profile refresh, page-open triage, compose-open reply suggestions and scheduled skills need separate background opt-in. Destination, model, account and material data-use changes need fresh permission. Cancel / revoke stops queued and active AI requests; data already delivered cannot be recalled. ChatGPT requests set store: false; no retention or training guarantee is made. Plan, app and workspace limits apply; Manage usage opens ChatGPT settings. No automatic billing fallback, provider switching, extra allowance, hosted tools or general proxy. Credentials stay encrypted on this computer; unlocked OS secure storage is required. Native and live sign-in validation remains pending.",
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
        blurb: "New mail, reply, forward, and drafts open in a separate window, so the mailbox stays usable. Closing that window does not send.",
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
        blurb: "Save or open the selected file, or save all as ZIP, including cached draft attachments. Stale IDs, missing files, or a changed message stop the download. Bot access still exposes metadata only.",
      },
      {
        id: "local-search",
        title: "Search on this computer",
        category: "Mail",
        blurb: "Toolbar search reads subject, from, and body already synced to this computer.",
      },
      {
        id: "schedule-send",
        title: "Send later",
        category: "Mail",
        blurb: "Schedule send keeps the message on this computer and delivers it while Morrow is open. Quitting with a pending send asks you first.",
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
        blurb: "Mail → Bodies shows per-mailbox body activity separately from list sync. Message requests and the listed page download as needed. While the app is awake/open, 00:00–07:00 local adds one indexed body after each background folder pass, within Mail & Sync history; trash, spam and drafts are excluded. It yields to mail work and rate limits. Activity has no whole-mailbox total or percentage. Large messages can remain incomplete at the 3 MiB source limit; attachment files stay on demand.",
      },
      {
        id: "inbox-rules",
        title: "Inbox Automation Rules",
        category: "Mail",
        blurb: "Gmail filters and Outlook rules save on the provider after you grant access. Other accounts store the rule here and apply it to new Inbox mail.",
      },
      {
        id: "multi-account",
        title: "Multiple mailboxes",
        category: "Accounts",
        blurb: "Connect Google, Microsoft, and IMAP mailboxes. Password reconnects save the matching login type and servers after credentials are saved; failures attempt to restore prior credentials. All Account Mail lists downloaded Gmail All Mail, or Inbox for other accounts. Disconnect invalidates queued sync and pending reconnects; server mail stays. Start a new connection after removal to add it again. Gmail Delete moves to Trash; deleting again keeps mail there. Gmail draft cleanup moves old remote copies to Trash. Microsoft and other IMAP deletion behavior is unchanged. Gmail API migration and narrower OAuth requests remain unavailable while cache and reauthorization integration is incomplete; Google login still uses OAuth.",
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
        blurb: "Month view for Google Calendar or Microsoft Graph when that account has calendar access. Create, edit, and delete events. Timed events appear on each local date they overlap. Closing a pending save does not cancel it; confirmed changes refresh the month. Titles over 200 characters and long Google descriptions stay read-only previews; other field edits preserve their complete values. Unchanged titles are kept, including untitled events. Save errors appear in the event dialog and keep your input. Invalid dates are reported before description preview restrictions.",
      },
      {
        id: "in-app-updater",
        title: "In-app updates",
        category: "Updates",
        blurb: "About & updates checks for a release on launch and every hour while Morrow is open. A red ! on that button means an update is ready. Restart and install applies a downloaded update once every compose window is closed.",
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
