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
        id: "inbox-rules",
        title: "Inbox rules",
        category: "Mail",
        blurb: "Gmail filters and Outlook rules save on the provider after you grant access. Other accounts store the rule here and apply it to new Inbox mail.",
      },
      {
        id: "multi-account",
        title: "Multiple mailboxes",
        category: "Accounts",
        blurb: "Connect Google, Microsoft, and IMAP mailboxes and switch among them. All Account Mail lists downloaded primary mail: Gmail All Mail, or Inbox for every other account.",
      },
      {
        id: "bot-bridge",
        title: "Bot bridge",
        category: "Accounts",
        blurb: "An optional loopback API lets a bot read cached mail and propose drafts. It stays off until you turn it on. Opening a proposal does not send it.",
      },
      {
        id: "calendar",
        title: "Calendar",
        category: "Calendar",
        blurb: "Month view for Google Calendar or Microsoft Graph when that account has calendar access. Create, edit, and delete events on that page.",
      },
      {
        id: "in-app-updater",
        title: "In-app updates",
        category: "Updates",
        blurb: "About & updates checks for a release. Restart and install applies a downloaded update once every compose window is closed.",
      },
    ],
  };
});
