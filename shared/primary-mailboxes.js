(function (root, factory) {
  const roles = typeof module === "object" && module.exports
    ? require("./mailbox-roles")
    : root.morrowMailboxRoles;
  const api = factory(roles || {});
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowPrimaryMailboxes = api;
})(typeof window === "object" ? window : globalThis, function (roles) {
  function isGmailAllPath(value) {
    if (roles && typeof roles.isGmailAllPath === "function") return roles.isGmailAllPath(value);
    return value === "[Gmail]/All Mail" || value === "[Google Mail]/All Mail";
  }

  function isGmailAccount(account) {
    if (!account || typeof account !== "object") return false;
    const platform = String(account.platform || "").toLowerCase();
    const profile = String(account.imapSmtpProfile || account.profile || "").toLowerCase();
    return platform === "gmail" || profile === "gmail";
  }

  function folderPath(folder) {
    if (!folder || typeof folder !== "object") return "";
    const path = folder.path != null ? folder.path : folder.id;
    return path == null ? "" : String(path);
  }

  function folderWell(folder) {
    if (!folder || typeof folder !== "object") return "";
    return String(folder.wellKnownName || folder.well_known || folder.wellKnown || "");
  }

  function folderList(folders) {
    return Array.isArray(folders) ? folders.filter((folder) => folder && typeof folder === "object") : [];
  }

  // Gmail's primary mailbox is All Mail. Every other account stays on Inbox.
  // A Gmail row with no All Mail folder yet uses Inbox so that account is not blank.
  function choosePrimary(account, folders) {
    const list = folderList(folders);
    if (isGmailAccount(account)) {
      const byWell = list.find((folder) => folderWell(folder) === "all" && folderPath(folder));
      if (byWell) return { folder: byWell, role: "all" };
      const byPath = list.find((folder) => isGmailAllPath(folderPath(folder)));
      if (byPath) return { folder: byPath, role: "all" };
    }
    const inboxWell = list.find((folder) => folderWell(folder) === "inbox" && folderPath(folder));
    if (inboxWell) return { folder: inboxWell, role: "inbox" };
    const inboxPath = list.find((folder) => folderPath(folder).toUpperCase() === "INBOX");
    if (inboxPath) return { folder: inboxPath, role: "inbox" };
    return null;
  }

  function primaryMailbox(account, folders) {
    if (!account || account.id == null || account.id === "") return null;
    const chosen = choosePrimary(account, folders);
    if (!chosen) return null;
    return { accountId: String(account.id), path: folderPath(chosen.folder), role: chosen.role };
  }

  function primaryMailboxes(accounts, foldersOf) {
    const list = Array.isArray(accounts) ? accounts : [];
    const read = typeof foldersOf === "function" ? foldersOf : function () { return []; };
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const row = primaryMailbox(list[i], read(list[i]));
      if (row) out.push(row);
    }
    return out;
  }

  function positiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function folderUnread(folder) {
    if (!folder || typeof folder !== "object") return 0;
    if (folder.unreadCount != null && folder.unreadCount !== "") return positiveCount(folder.unreadCount);
    if (folder.unread != null && folder.unread !== "") return positiveCount(folder.unread);
    return 0;
  }

  function sumUnread(accounts, foldersOf) {
    const list = Array.isArray(accounts) ? accounts : [];
    const read = typeof foldersOf === "function" ? foldersOf : function () { return []; };
    return list.reduce((sum, account) => {
      if (Number.isFinite(account && account.cachedPrimaryUnreadCount)) return sum + positiveCount(account.cachedPrimaryUnreadCount);
      const chosen = choosePrimary(account, read(account));
      if (chosen) return sum + folderUnread(chosen.folder);
      return sum + positiveCount(account && account.unreadCount);
    }, 0);
  }

  return {
    isGmailAccount: isGmailAccount,
    primaryMailbox: primaryMailbox,
    primaryMailboxes: primaryMailboxes,
    sumUnread: sumUnread,
  };
});
