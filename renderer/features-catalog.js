/* Hand-maintained Features catalog. Edit this list; do not generate it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowFeaturesCatalog = api;
})(typeof window === "object" ? window : globalThis, function () {
  return {
    items: [
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
        id: "overnight-body-fill",
        title: "Off-hours body fill",
        category: "Mail",
        blurb: "While Morrow is open, from 00:00–07:00 local time (07:00 is outside), a slow pass fills one missing body after folder work, the same way a cold open does. Newest indexed mail inside Settings → Mail & Sync is used; trash, spam, and drafts are skipped, and the page on screen still comes first.",
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
        blurb: "Connect Google, Microsoft, and IMAP mailboxes. Password reconnects save the matching login type and servers after credentials are saved; failures attempt to restore prior credentials. All Account Mail lists downloaded Gmail All Mail, or Inbox for other accounts. Disconnect invalidates queued sync and pending reconnects; server mail stays. Start a new connection after removal to add it again.",
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
        blurb: "Month view for Google Calendar or Microsoft Graph when that account has calendar access. Create, edit, and delete events. Titles over 200 characters and long Google descriptions stay read-only previews; other field edits preserve their complete values. Unchanged titles are kept, including untitled events.",
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
