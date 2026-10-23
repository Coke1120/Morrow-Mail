// What's new copy, keyed by the package.json version (no leading v).
// On each release, add that version's user-facing lines in the same change as the bump.
// A missing or empty entry does not open a dialog. This file does not fetch GitHub.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowChangelog = api;
})(typeof window === "object" ? window : globalThis, function () {
  const NOTES = {
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
