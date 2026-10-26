// What's new copy, keyed by the package.json version (no leading v).
// On each release, add that version's user-facing lines in the same change as the bump.
// A missing or empty entry does not open a dialog. This file does not fetch GitHub.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowChangelog = api;
})(typeof window === "object" ? window : globalThis, function () {
  const NOTES = {
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
