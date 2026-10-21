const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function message(id, folderPath, uid, subject, ts, unread) {
  return {
    id,
    accountId: "star-acct",
    folderPath,
    uid,
    uidValidity: 1,
    threadId: `thr-${id}`,
    subject,
    snippet: subject,
    from: "Ada <ada@example.com>",
    to: ["Leo <leo@example.com>"],
    date: new Date(ts).toISOString(),
    listSortTs: ts,
    unread: unread === true,
    bodyComplete: true,
  };
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-star-"));
  const env = {
    MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR,
    MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS,
  };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const secrets = require("../host/mail/secrets");
  const remote = require("../host/mail/remote");
  const saved = { withClient: remote.withClient, changeFlags: remote.changeFlags };
  const flagCalls = [];
  let clientUses = 0;
  try {
    await engine.init();
    assert.strictEqual(engine.STARRED_FOLDER_ID, "__morrow_starred__");
    assert.strictEqual(engine.UNREAD_FOLDER_ID, "__morrow_unread__");
    const virtuals = require("../host/mail/virtual-folders");
    assert.equal(virtuals.VIRTUALS, undefined);
    db.insertAccount({
      id: "star-acct",
      email: "leo@example.com",
      username: "leo@example.com",
      profile: "custom",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
    });
    db.replaceFolders("star-acct", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Sent", name: "Sent", wellKnown: "sentitems" },
      { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
      { path: "Trash", name: "Trash", wellKnown: "deleteditems" },
      { path: "Junk", name: "Spam", wellKnown: "junkemail" },
      { path: "Notes", name: "Notes", wellKnown: null },
    ], "/");
    secrets.setPassword("star-acct", "pw");
    const now = Date.now();
    db.insertMessage(message("inbox-plain", "INBOX", 3, "Plain", now));
    db.insertMessage(message("notes-star", "Notes", 8, "Keep", now + 1));
    db.insertMessage(message("local-star", "Drafts", 0, "Draft star", now + 2));
    db.insertMessage(message("inbox-unread", "INBOX", 11, "Unread inbox", now + 10, true));
    db.insertMessage(message("notes-unread", "Notes", 12, "Unread notes", now + 11, true));
    db.insertMessage(message("trash-unread", "Trash", 13, "Unread trash", now + 12, true));
    db.insertMessage(message("drafts-unread", "Drafts", 14, "Unread drafts", now + 13, true));
    db.insertMessage(message("sent-unread", "Sent", 15, "Unread sent", now + 14, true));
    db.insertMessage(message("spam-unread", "Junk", 16, "Unread spam", now + 15, true));
    db.insertMessage(message("search-unread", "__search__", 17, "Unread search", now + 16, true));
    db.insertMessage(message("inbox-snooze", "INBOX", 18, "Snoozed unread", now + 17, true));
    db.setSnooze("star-acct", "thr-inbox-snooze", new Date(now + 60 * 60 * 1000).toISOString());

    const accounts = engine.answer("mail:listAccounts", []);
    const names = accounts.data[0].folders.primary.map((folder) => folder.wellKnownName);
    assert.deepStrictEqual(names.slice(0, 4), ["inbox", "sentitems", "drafts", "starred"]);
    assert.strictEqual(names[4], "unread");
    assert.strictEqual(accounts.data[0].folders.primary[3].id, "__morrow_starred__");
    assert.strictEqual(accounts.data[0].folders.primary[3].type, "virtual");
    assert.strictEqual(accounts.data[0].folders.primary[0].chip, true);
    assert.strictEqual(accounts.data[0].folders.primary[3].chip, false);
    assert.strictEqual(accounts.data[0].folders.primary[3].unreadCount, 0);
    const unreadFolder = accounts.data[0].folders.primary[4];
    assert.strictEqual(unreadFolder.id, "__morrow_unread__");
    assert.strictEqual(unreadFolder.type, "virtual");
    assert.strictEqual(unreadFolder.chip, true);
    assert.strictEqual(unreadFolder.wellKnownName, "unread");
    assert.strictEqual(unreadFolder.unreadCount, 2);
    assert.strictEqual(unreadFolder.totalCount, 2);
    assert.ok(!accounts.data[0].folders.more.some((folder) => folder.wellKnownName === "starred" || folder.wellKnownName === "unread"));
    const unreadList = engine.answer("mail:listFromCache", [{ accountId: "star-acct", folderId: "__morrow_unread__", limit: 20 }]);
    assert.strictEqual(unreadList.data.initialSyncDone, true);
    assert.deepStrictEqual(unreadList.data.emails.map((row) => row.id).sort(), ["inbox-unread", "notes-unread"]);
    assert.deepStrictEqual(unreadList.data.emails.map((row) => row.folderId).sort(), ["INBOX", "Notes"]);
    const openUnread = virtuals.apply({ accountId: "star-acct", folderId: "__morrow_unread__", filterFlagged: true });
    assert.strictEqual(openUnread.folderId, null);
    assert.strictEqual(openUnread.filterUnread, true);
    assert.strictEqual(openUnread.filterFlagged, true);
    assert.strictEqual(openUnread.excludeSnoozed, true);
    assert.ok(openUnread.excludeFolderPaths.includes("__search__"));
    assert.ok(openUnread.excludeFolderPaths.includes("Trash"));
    assert.ok(openUnread.excludeFolderPaths.includes("Junk"));
    assert.ok(openUnread.excludeFolderPaths.includes("Drafts"));
    assert.ok(openUnread.excludeFolderPaths.includes("Sent"));
    assert.strictEqual(virtuals.apply(openUnread), openUnread);
    const starredQuery = virtuals.apply({ accountId: "star-acct", folderId: "__morrow_starred__", filterUnread: true });
    assert.strictEqual(starredQuery.filterFlagged, true);
    assert.strictEqual(starredQuery.filterUnread, true);
    assert.strictEqual(starredQuery.excludeSnoozed, undefined);
    assert.strictEqual(starredQuery.folderId, null);
    const missingAccount = virtuals.apply({ folderId: "__morrow_unread__" });
    assert.equal(missingAccount.category, "none");
    assert.equal(missingAccount.folderPaths, undefined);
    assert.equal(missingAccount.excludeFolderPaths, undefined);
    const everyAccount = engine.answer("mail:listFromCache", [{ folderId: "__morrow_unread__", limit: 20 }]);
    assert.deepStrictEqual(everyAccount.data.emails, []);

    remote.withClient = async (_account, _password, fn) => {
      clientUses += 1;
      return fn({ id: "client" });
    };
    remote.changeFlags = async (_client, folder, uid, add, remove) => {
      flagCalls.push({ folder, uid: Number(uid), add: add.slice(), remove: remove.slice() });
    };

    const unreadNetwork = await engine.answer("mail:listFromNetwork", [{ accountId: "star-acct", folderId: "__morrow_unread__", limit: 20 }]);
    assert.strictEqual(unreadNetwork.success, true);
    assert.strictEqual(clientUses, 0);
    assert.strictEqual(unreadNetwork.data.sync.folderLabel, "Unread");
    assert.deepStrictEqual(unreadNetwork.data.emails.map((row) => row.id).sort(), ["inbox-unread", "notes-unread"]);

    const starred = await engine.answer("mail:toggleStar", [{ emailId: "notes-star", accountId: "star-acct", isStarred: true }]);
    assert.strictEqual(starred.success, true);
    assert.strictEqual(starred.data.isStarred, true);
    assert.strictEqual(db.messageById("notes-star").starred, 1);
    assert.deepStrictEqual(flagCalls, []);
    const starredRemote = await engine.settleActions();
    assert.strictEqual(starredRemote.outcomes[0].status, "completed");
    assert.deepStrictEqual(flagCalls, [{ folder: "Notes", uid: 8, add: ["\\Flagged"], remove: [] }]);

    const local = await engine.answer("mail:toggleStar", [{ emailId: "local-star", isStarred: true }]);
    assert.strictEqual(local.success, true);
    assert.strictEqual(db.messageById("local-star").starred, 1);
    assert.strictEqual(flagCalls.length, 1);
    assert.strictEqual(clientUses, 1);
    await engine.settleActions();

    const listed = engine.answer("mail:listFromCache", [{ accountId: "star-acct", folderId: "__morrow_starred__", limit: 20 }]);
    assert.deepStrictEqual(listed.data.emails.map((row) => row.id).sort(), ["local-star", "notes-star"]);
    assert.ok(listed.data.emails.every((row) => row.isStarred === true));

    const network = await engine.answer("mail:listFromNetwork", [{ accountId: "star-acct", folderId: "__morrow_starred__", limit: 20 }]);
    assert.strictEqual(network.success, true);
    assert.strictEqual(clientUses, 1);
    assert.strictEqual(network.data.sync.folderLabel, "Starred");
    assert.deepStrictEqual(network.data.emails.map((row) => row.id).sort(), ["local-star", "notes-star"]);

    const inbox = engine.answer("mail:listFromCache", [{ accountId: "star-acct", folderId: "INBOX", limit: 20 }]);
    const plain = inbox.data.emails.find((row) => row.id === "inbox-plain");
    assert.ok(plain);
    assert.strictEqual(plain.isStarred, false);

    secrets.deletePassword("star-acct");
    const noSecret = await engine.answer("mail:toggleStar", [{ emailId: "inbox-plain", isStarred: true }]);
    assert.strictEqual(noSecret.success, true);
    assert.strictEqual(db.messageById("inbox-plain").starred, 1);
    const noSecretRemote = await engine.settleActions();
    assert.strictEqual(noSecretRemote.outcomes[0].status, "failed");
    assert.match(noSecretRemote.outcomes[0].error, /password|keychain/i);
    assert.strictEqual(db.messageById("inbox-plain").starred, 0);
    secrets.setPassword("star-acct", "pw");

    remote.changeFlags = async () => {
      throw new Error("flag rejected");
    };
    const failed = await engine.answer("mail:toggleStar", [{ emailId: "inbox-plain", isStarred: true }]);
    assert.strictEqual(failed.success, true);
    assert.strictEqual(db.messageById("inbox-plain").starred, 1);
    const failedRemote = await engine.settleActions();
    assert.strictEqual(failedRemote.outcomes[0].status, "unknown");
    assert.match(failedRemote.outcomes[0].error, /flag rejected/);
    assert.strictEqual(db.messageById("inbox-plain").starred, 1);

    const gone = await engine.answer("mail:toggleStar", [{ emailId: "missing", isStarred: true }]);
    assert.strictEqual(gone.success, false);
    assert.match(gone.error.message, /no longer in the mailbox/);

    remote.changeFlags = async (_client, folder, uid, add, remove) => {
      flagCalls.push({ folder, uid: Number(uid), add: add.slice(), remove: remove.slice() });
    };
    const cleared = await engine.answer("mail:toggleStar", [{ emailId: "notes-star", isStarred: false }]);
    assert.strictEqual(cleared.success, true);
    assert.strictEqual(db.messageById("notes-star").starred, 0);
    await engine.settleActions();
    assert.deepStrictEqual(flagCalls[flagCalls.length - 1], { folder: "Notes", uid: 8, add: [], remove: ["\\Flagged"] });
    const after = engine.answer("mail:listFromCache", [{ accountId: "star-acct", folderId: "__morrow_starred__", limit: 20 }]);
    assert.deepStrictEqual(after.data.emails.map((row) => row.id), ["local-star", "inbox-plain"]);

    const batch = await engine.answer("mail:toggleStarBatch", [{
      isStarred: true,
      items: [{ emailId: "inbox-plain" }, { emailId: "notes-star" }],
    }]);
    assert.strictEqual(batch.success, true);
    assert.strictEqual(db.messageById("inbox-plain").starred, 1);
    assert.strictEqual(db.messageById("notes-star").starred, 1);
    const batchRemote = await engine.settleActions();
    assert.ok(batchRemote.outcomes.every((row) => row.status === "completed"));
    assert.ok(flagCalls.some((row) => row.folder === "INBOX" && row.add[0] === "\\Flagged"));

    const usesBeforeMove = clientUses;
    const moved = await engine.answer("mail:moveToFolder", [{
      emailId: "inbox-plain",
      accountId: "star-acct",
      targetFolderId: "__morrow_starred__",
    }]);
    assert.strictEqual(moved.success, false);
    assert.match(moved.error.message, /filter/);
    assert.strictEqual(db.messageById("inbox-plain").folder_path, "INBOX");
    assert.strictEqual(clientUses, usesBeforeMove);

    const usesBeforeUnreadMove = clientUses;
    const movedUnread = await engine.answer("mail:moveToFolder", [{
      emailId: "inbox-unread",
      accountId: "star-acct",
      targetFolderId: "__morrow_unread__",
    }]);
    assert.strictEqual(movedUnread.success, false);
    assert.match(movedUnread.error.message, /filter/);
    assert.strictEqual(db.messageById("inbox-unread").folder_path, "INBOX");
    assert.strictEqual(clientUses, usesBeforeUnreadMove);

    db.insertAccount({
      id: "other-acct",
      email: "other@example.com",
      username: "other@example.com",
      profile: "gmail",
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
      displayName: "Other Person",
    });
    db.replaceFolders("other-acct", [
      { path: "Inbox", name: "Inbox", wellKnown: "inbox" },
      { path: "INBOX", name: "Archive", wellKnown: "archive" },
    ], "/");
    const later = Date.now() + 100000;
    db.insertMessage({
      id: "other-inbox",
      accountId: "other-acct",
      folderPath: "Inbox",
      uid: 1,
      uidValidity: 1,
      threadId: "thr-other-inbox",
      subject: "Other inbox",
      snippet: "From the other mailbox",
      from: "Ada <ada@example.com>",
      to: ["Leo <leo@example.com>"],
      date: new Date(later).toISOString(),
      listSortTs: later,
      unread: true,
      bodyComplete: true,
    });
    db.insertMessage({
      id: "other-archive",
      accountId: "other-acct",
      folderPath: "INBOX",
      uid: 2,
      uidValidity: 1,
      threadId: "thr-other-archive",
      subject: "Not inbox",
      snippet: "Same path as the other mailbox inbox",
      from: "Ada <ada@example.com>",
      to: ["Leo <leo@example.com>"],
      date: new Date(later + 1000).toISOString(),
      listSortTs: later + 1000,
      unread: true,
      bodyComplete: true,
    });
    db.setSnooze("star-acct", "thr-inbox-snooze", new Date(Date.now() + 86400000).toISOString());
    const combined = await engine.answer("mail:listFromCache", [{ folderKey: "inbox", limit: 20 }]);
    assert.strictEqual(combined.success, true);
    assert.deepStrictEqual(combined.data.emails.map((row) => row.id), ["other-inbox", "inbox-unread", "inbox-plain"]);
    const unreadCombined = engine.answer("mail:listFromCache", [{ folderKey: "inbox", filterUnread: true, limit: 20 }]);
    assert.strictEqual(unreadCombined.success, true);
    assert.deepStrictEqual(unreadCombined.data.emails.map((row) => row.id), ["other-inbox", "inbox-unread"]);
    assert.ok(combined.data.emails.every((row) => row.accountId === "other-acct" || row.accountId === "star-acct"));
    const scoped = engine.answer("mail:listFromCache", [{ accountId: "star-acct", folderKey: "inbox", limit: 20 }]);
    assert.deepStrictEqual(scoped.data.emails.map((row) => row.id), ["inbox-unread", "inbox-plain"]);

    const named = await engine.answer("mail:setAccountLabel", [{ accountId: "star-acct", label: "  Leo Ho  " }]);
    assert.strictEqual(named.success, true);
    assert.strictEqual(named.data.label, "Leo Ho");
    assert.strictEqual(named.data.name, null);
    assert.strictEqual(named.data.email, "leo@example.com");
    assert.strictEqual(db.accountById("star-acct").display_name, null);
    assert.strictEqual(db.accountById("star-acct").imap_host, "imap.example.test");
    const again = await engine.answer("mail:setAccountLabel", [{ accountId: "star-acct", label: "Leo Ho" }]);
    assert.strictEqual(again.success, true);
    assert.strictEqual(db.accountById("star-acct").label, "Leo Ho");
    db.updateAccountLogin("star-acct", {
      username: "leo@example.com",
      profile: "custom",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpTls: true,
      displayName: "Provider Name",
      authKind: "password",
    });
    const afterLogin = db.accountById("star-acct");
    assert.strictEqual(afterLogin.label, "Leo Ho");
    assert.strictEqual(afterLogin.display_name, "Provider Name");
    assert.strictEqual(afterLogin.email, "leo@example.com");
    const clearedLabel = await engine.answer("mail:setAccountLabel", [{ accountId: "star-acct", label: "   " }]);
    assert.strictEqual(clearedLabel.success, true);
    assert.strictEqual(clearedLabel.data.label, null);
    assert.strictEqual(clearedLabel.data.name, "Provider Name");
    assert.strictEqual(db.accountById("star-acct").label, null);
    const tooLong = await engine.answer("mail:setAccountLabel", [{ accountId: "star-acct", label: "x".repeat(201) }]);
    assert.strictEqual(tooLong.success, false);
    assert.strictEqual(db.accountById("star-acct").label, null);
    const missing = await engine.answer("mail:setAccountLabel", [{ accountId: "missing-acct", label: "Nope" }]);
    assert.strictEqual(missing.success, false);
  } finally {
    await engine.settleActions().catch(() => {});
    Object.assign(remote, saved);
    secrets.deletePassword("star-acct");
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
