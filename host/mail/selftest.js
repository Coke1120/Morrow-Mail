const fs = require("fs");
const db = require("./db");
const presets = require("./presets");
const { answer } = require("./engine");

function problem(list, message) {
  list.push(message);
}

async function run() {
  const problems = [];
  const cards = answer("mail:listImapSmtpPresets", []);
  const profiles = cards && cards.data;
  if (!Array.isArray(profiles) || profiles.length < 5) problem(problems, "presets missing");
  if (profiles && profiles.some((card) => card.credentialKind === "oauth2" || card.profile === "custom")) {
    problem(problems, "preset card would be hidden or duplicated");
  }
  if (!presets.endpointsFor("gmail") || !presets.endpointsFor("icloud")) problem(problems, "known hosts missing");
  if (presets.endpointsFor("custom", {})) problem(problems, "custom without servers should fail");

  const missing = await answer("mail:connectImapSmtp", [{ profile: "custom", email: "ada@example.com", password: "secret" }]);
  if (!missing || missing.success !== false) problem(problems, "custom connect without servers should fail");
  const bad = await answer("mail:connectImapSmtp", [{ profile: "gmail", email: "not-an-email", password: "x" }]);
  if (!bad || bad.success !== false) problem(problems, "bad email should fail");
  if (db.hasAccounts()) problem(problems, "failed connect stored an account");

  db.insertAccount({
    id: "imap-test",
    email: "ada@example.com",
    username: "ada@example.com",
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
  db.replaceFolders("imap-test", [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    { path: "Notes", name: "Notes", wellKnown: null },
    { path: "Archive", name: "Archive", wellKnown: "archive" },
  ], "/");
  db.insertMessage({
    id: "m-test",
    accountId: "imap-test",
    folderPath: "INBOX",
    uid: 0,
    uidValidity: 1,
    threadId: "thr-test",
    subject: "Analytical Engine",
    snippet: "The table of operations is ready.",
    from: "Charles Babbage <charles@example.com>",
    to: ["Ada <ada@example.com>"],
    date: new Date().toISOString(),
    listSortTs: Date.now(),
    unread: true,
    htmlBody: "<p>The table of operations is ready.</p>",
    textBody: "The table of operations is ready.",
    bodyComplete: true,
  });

  const accounts = answer("mail:listAccounts", []);
  if (!accounts || !accounts.data || accounts.data[0].id !== "imap-test" || accounts.data[0].platform !== "imap") {
    problem(problems, "listAccounts shape");
  }
  if (!accounts.data[0].folders.primary.some((folder) => folder.wellKnownName === "inbox")) {
    problem(problems, "inbox folder missing");
  }
  const primaryNames = accounts.data[0].folders.primary.map((folder) => folder.wellKnownName);
  if (primaryNames.indexOf("starred") !== primaryNames.indexOf("drafts") + 1) problem(problems, "starred folder placement");
  if (primaryNames.indexOf("unread") !== primaryNames.indexOf("starred") + 1) problem(problems, "unread folder placement");
  const starredFolder = accounts.data[0].folders.primary.find((folder) => folder.wellKnownName === "starred");
  if (!starredFolder || starredFolder.id !== "__morrow_starred__" || starredFolder.type !== "virtual") {
    problem(problems, "starred folder shape");
  }
  if (accounts.data[0].folders.more.some((folder) => folder.id === "__morrow_starred__")) problem(problems, "starred folder stored as a mailbox");
  if (!accounts.data[0].folders.more.some((folder) => folder.id === "Notes")) problem(problems, "custom folder missing");

  const listed = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "INBOX", limit: 50 }]);
  if (!listed || !listed.data || listed.data.emails.length !== 1 || listed.data.emails[0].unread !== true) {
    problem(problems, "inbox list");
  }
  const blank = await answer("mail:search", [{ query: "", limit: 10, filters: {} }]);
  if (!blank || !Array.isArray(blank.data) || blank.data.length !== 0) problem(problems, "empty search");
  const remote = require("./remote");
  const savedFind = remote.findText;
  const savedClient = remote.withClient;
  const prevSecrets = process.env.MORROW_MAIL_SECRETS;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const secrets = require("./secrets");
  secrets.setPassword("imap-test", "secret");
  let served = false;
  remote.withClient = async (_account, _password, fn) => fn({});
  remote.findText = async () => {
    if (served) return { messages: [], validity: 1, searched: true };
    served = true;
    return {
      messages: [{
        uid: 42,
        threadId: "thr-server",
        rfcMessageId: "<server-hit@example.test>",
        subject: "Server hit",
        snippet: "from the server",
        from: "Server <server@example.com>",
        to: [],
        date: new Date().toISOString(),
        listSortTs: Date.now(),
        unread: false,
        bodyComplete: false,
      }],
      validity: 1,
      searched: true,
    };
  };
  const found = await answer("mail:search", [{ query: "analytical engine", limit: 10, filters: {} }]);
  if (!found || found.success !== true || !Array.isArray(found.data) || found.data.length !== 1 || found.data[0].subject !== "Server hit" || found.data[0].id === "m-test") {
    problem(problems, "search must return the server hit, not a local-only row");
  }
  remote.findText = async () => ({ messages: [], validity: 1, searched: true });
  const localOnly = await answer("mail:search", [{ query: "table of operations", limit: 10, filters: {} }]);
  if (!localOnly || localOnly.success !== true || localOnly.data.length !== 0) problem(problems, "search must not fall back to local mail");
  remote.findText = savedFind;
  remote.withClient = savedClient;
  secrets.deletePassword("imap-test");
  if (prevSecrets === undefined) delete process.env.MORROW_MAIL_SECRETS;
  else process.env.MORROW_MAIL_SECRETS = prevSecrets;

  const past = answer("mail:snoozeThread", [{ accountId: "imap-test", threadId: "thr-test", snoozedUntil: new Date(Date.now() - 60000).toISOString() }]);
  if (!past || past.success !== false || past.error.code !== "snoozed_until_in_past") problem(problems, "snooze past");
  const far = answer("mail:snoozeThread", [{
    accountId: "imap-test",
    threadId: "thr-test",
    snoozedUntil: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(),
  }]);
  if (!far || far.error.code !== "snoozed_until_too_far") problem(problems, "snooze too far");
  const snoozed = answer("mail:snoozeThread", [{
    accountId: "imap-test",
    threadId: "thr-test",
    snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }]);
  if (!snoozed || snoozed.success !== true) problem(problems, "snooze");
  const snoozeList = answer("mail:listSnoozed", [{ accountId: "imap-test" }]);
  if (!snoozeList || !snoozeList.data || !Array.isArray(snoozeList.data.records) || snoozeList.data.records[0].state !== "snoozed") {
    problem(problems, "snoozed list");
  }
  const hidden = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "INBOX", limit: 50 }]);
  if (!hidden || hidden.data.emails.length !== 0) problem(problems, "snooze did not hide the thread");
  answer("mail:unsnoozeThread", [{ accountId: "imap-test", threadId: "thr-test" }]);
  const back = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "INBOX", limit: 50 }]);
  if (!back || back.data.emails.length !== 1) problem(problems, "unsnooze");

  const moved = await answer("mail:moveToFolder", [{ emailId: "m-test", accountId: "imap-test", targetFolderId: "Notes", folderId: "INBOX" }]);
  if (!moved || moved.success !== true) problem(problems, `move ${moved && moved.error && moved.error.message}`);
  const notes = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "Notes", limit: 50 }]);
  if (!notes || notes.data.emails.length !== 1) problem(problems, "custom folder move");
  const undo = await answer("mail:undoRemoval", [{ opIds: moved.data.opIds, kind: "move" }]);
  if (!undo || undo.success !== true) problem(problems, "undo");
  const restored = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "INBOX", limit: 50 }]);
  if (!restored || restored.data.emails.length !== 1) problem(problems, "undo did not restore");

  db.insertMessage({
    id: "m-remote",
    accountId: "imap-test",
    folderPath: "INBOX",
    uid: 4,
    uidValidity: 1,
    threadId: "thr-remote",
    subject: "Server flag",
    snippet: "This row still lives on the server.",
    from: "Grace Hopper <grace@example.com>",
    to: ["Ada <ada@example.com>"],
    date: new Date().toISOString(),
    listSortTs: Date.now(),
    unread: true,
    bodyComplete: true,
  });
  const refused = await answer("mail:markRead", [{ emailId: "m-remote", accountId: "imap-test", isRead: true }]);
  if (!refused || refused.success !== false) problem(problems, "mark read without a password should fail");
  if (db.messageById("m-remote").unread !== 1) problem(problems, "failed mark read changed the local row");
  const unreadBefore = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "__morrow_unread__", limit: 50 }]);
  if (!unreadBefore || !unreadBefore.data || !unreadBefore.data.emails.some((row) => row.id === "m-test")) {
    problem(problems, "unread filter missed m-test");
  }
  const read = await answer("mail:markRead", [{ emailId: "m-test", accountId: "imap-test", isRead: true }]);
  if (!read || read.success !== true || db.messageById("m-test").unread !== 0) problem(problems, "local mark read");
  const unreadAfter = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "__morrow_unread__", limit: 50 }]);
  if (!unreadAfter || !unreadAfter.data || unreadAfter.data.emails.some((row) => row.id === "m-test")) {
    problem(problems, "unread filter kept m-test after mark read");
  }
  const star = await answer("mail:toggleStar", [{ emailId: "m-test", accountId: "imap-test", isStarred: true }]);
  if (!star || star.success !== true || db.messageById("m-test").starred !== 1) problem(problems, "local star");
  const starredList = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "__morrow_starred__", limit: 50 }]);
  if (!starredList || !starredList.data || starredList.data.emails.length !== 1 || starredList.data.emails[0].id !== "m-test" || starredList.data.emails[0].isStarred !== true) {
    problem(problems, "starred filter");
  }
  const clearStar = await answer("mail:toggleStar", [{ emailId: "m-test", accountId: "imap-test", isStarred: false }]);
  if (!clearStar || clearStar.success !== true || db.messageById("m-test").starred !== 0) problem(problems, "local unstar");
  const clearedList = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "__morrow_starred__", limit: 50 }]);
  if (!clearedList || !clearedList.data || clearedList.data.emails.length !== 0) problem(problems, "unstar left the starred filter");
  const missingStar = await answer("mail:toggleStar", [{ emailId: "missing-message", accountId: "imap-test", isStarred: true }]);
  if (!missingStar || missingStar.success !== false || !missingStar.error || !missingStar.error.message) problem(problems, "missing star was silent");

  const drafted = await answer("mail:upsertDraft", [{
    accountId: "imap-test",
    to: ["grace@example.com"],
    subject: "First draft",
    body: "<p>Hello</p>",
  }]);
  if (!drafted || !drafted.data || !drafted.data.emailId) problem(problems, "draft save");
  const draftId = drafted && drafted.data && drafted.data.emailId;
  const revised = await answer("mail:upsertDraft", [{
    accountId: "imap-test",
    emailId: draftId,
    to: ["grace@example.com"],
    subject: "Revised draft",
    body: "<p>Hello again</p>",
  }]);
  if (!revised || !revised.data || revised.data.emailId !== draftId) problem(problems, "draft save minted a second id");
  const draftList = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "Drafts", limit: 50 }]);
  if (!draftList || draftList.data.emails.length !== 1 || draftList.data.emails[0].subject !== "Revised draft") {
    problem(problems, "draft was not updated in place");
  }
  const nobody = await answer("mail:send", [{ accountId: "imap-test", subject: "x", body: "<p>x</p>", to: [] }]);
  if (!nobody || nobody.success !== false) problem(problems, "send without a recipient");
  const unsent = await answer("mail:send", [{
    accountId: "imap-test",
    subject: "x",
    body: "<p>x</p>",
    to: ["grace@example.com"],
  }]);
  if (!unsent || unsent.success !== false) problem(problems, "send without a password must not claim success");
  const sent = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "Sent", limit: 50 }]);
  if (!sent || sent.data.emails.length !== 0) problem(problems, "unsent mail was stored as sent");
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const scheduled = answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    subject: "Later",
    sendAt: future,
  }]);
  if (!scheduled || scheduled.success !== true || !scheduled.data || !scheduled.data.id) {
    problem(problems, "schedule send");
  }
  const scheduledId = scheduled && scheduled.data && scheduled.data.id;
  const scheduledList = answer("mail:listScheduled", [{ accountId: "imap-test" }]);
  if (!scheduledList || !scheduledList.data || !scheduledList.data.some((row) => row.id === scheduledId && row.subject === "Later")) {
    problem(problems, "scheduled list");
  }
  const pastSend = answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    sendAt: new Date(Date.now() - 1000).toISOString(),
  }]);
  if (!pastSend || !pastSend.error || pastSend.error.code !== "send_at_in_past") problem(problems, "schedule in the past");
  const canceled = answer("mail:cancelScheduled", [{ id: scheduledId }]);
  if (!canceled || canceled.success !== true) problem(problems, "cancel scheduled");
  const signatureWrite = answer("mail:upsertSignature", [{
    accountId: "imap-test",
    name: "Work",
    text: "Thanks",
    isDefault: true,
  }]);
  if (!signatureWrite || signatureWrite.success !== true || signatureWrite.data.text !== "Thanks") {
    problem(problems, "signature write");
  }
  const signatureList = answer("mail:listSignatures", [{ accountId: "imap-test" }]);
  if (!signatureList || !signatureList.data || signatureList.data.signatures.length !== 1) {
    problem(problems, "signature list");
  }
  if (!signatureList.data.defaultSignaturePerAccount || signatureList.data.defaultSignaturePerAccount["imap-test"] !== signatureWrite.data.id) {
    problem(problems, "per-account default signature");
  }
  await answer("mail:deleteDraft", [{ emailId: draftId }]);
  const draftGone = answer("mail:listFromCache", [{ accountId: "imap-test", folderId: "Drafts", limit: 50 }]);
  if (!draftGone || draftGone.data.emails.length !== 0) problem(problems, "draft delete");

  const uploaded = answer("mail:uploadAttachment", [{ filename: "notes.txt", mimeType: "text/plain", fileBytes: Buffer.from("hello") }]);
  if (!uploaded || !uploaded.data || !String(uploaded.data.storageUrl).startsWith("local:")) problem(problems, "upload");

  const secret = "super-secret-passphrase";
  require("./memory-secrets").setPassword("imap-test", secret);
  const file = fs.readFileSync(db.file());
  if (file.includes(Buffer.from(secret))) problem(problems, "password was written into the mailbox cache");

  const opened = answer("mail:openEmail", [{ emailId: "m-test" }]);
  const openedEmail = opened && opened.then ? await opened : opened;
  if (!openedEmail || !openedEmail.data || !openedEmail.data.email.htmlBody) problem(problems, "open email");

  db.replaceFolders("imap-test", [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    { path: "Notes", name: "Notes", wellKnown: null },
    { path: "Archive", name: "Archive", wellKnown: "archive" },
    { path: "Work", name: "Work", wellKnown: null },
    { path: "Work/Travel", name: "Travel", wellKnown: null },
  ], "/");
  db.applyFolderSync("imap-test", "Work", {
    messages: [],
    keepOthers: true,
    validity: 4,
    uidCursor: 12,
    windowDone: true,
    horizonDays: 180,
  });
  db.applyFolderSync("imap-test", "Work/Travel", {
    messages: [],
    keepOthers: true,
    validity: 4,
    uidCursor: 9,
    windowDone: true,
    horizonDays: 180,
  });
  db.insertMessage({
    id: "m-nested",
    accountId: "imap-test",
    folderPath: "Work/Travel",
    uid: 3,
    uidValidity: 4,
    threadId: "thr-nested",
    subject: "Nested stay",
    snippet: "still cached",
    from: "Ada <ada@example.com>",
    date: new Date().toISOString(),
    listSortTs: Date.now(),
    unread: false,
    bodyComplete: true,
  });
  const pathPlan = db.planImapPathMove(db.foldersFor("imap-test").map((folder) => ({
    path: folder.path,
    name: folder.name,
    wellKnown: folder.well_known,
  })), "Work", "Archive", "/");
  if (!pathPlan.ok) problem(problems, "imap path plan");
  const rewritten = pathPlan.ok ? db.rewriteFolderPaths("imap-test", pathPlan.renames) : { moved: [], skipped: ["plan"] };
  if (rewritten.skipped.length || db.messageById("m-nested").folder_path !== "Archive/Work/Travel") {
    problem(problems, "imap path rewrite dropped or skipped cached mail");
  }
  const keptFolder = db.folderByPath("imap-test", "Archive/Work");
  if (!keptFolder || keptFolder.sync_horizon_days !== 180 || keptFolder.uid_cursor !== 12 || keptFolder.window_done !== 1) {
    problem(problems, "imap path rewrite dropped the sync horizon");
  }
  if (!db.messageById("m-test") || db.messageById("m-test").folder_path !== "INBOX" || db.messageById("m-test").subject !== "Analytical Engine") {
    problem(problems, "imap path rewrite disturbed inbox mail");
  }

  db.close();
  await db.open(db.file());
  const again = db.messageById("m-test");
  if (!again || again.subject !== "Analytical Engine") problem(problems, "cache did not survive reopen");

  await answer("mail:removeAccount", [{ accountId: "imap-test" }]);
  if (db.hasAccounts()) problem(problems, "account was not removed");
  const emptyAccounts = answer("mail:listAccounts", []);
  if (!emptyAccounts || emptyAccounts.success !== true || !Array.isArray(emptyAccounts.data) || emptyAccounts.data.length !== 0) {
    problem(problems, "empty cache should list no accounts");
  }
  const emptyMail = answer("mail:listFromCache", [{ limit: 20 }]);
  if (!emptyMail || !emptyMail.data || emptyMail.data.emails.length !== 0) {
    problem(problems, "empty cache should not list sample mail");
  }
  const goneSignature = answer("mail:listSignatures", [{ accountId: "imap-test" }]);
  if (!goneSignature || goneSignature.data.signatures.length !== 0) problem(problems, "removed account kept a signature");

  if (problems.length) {
    console.error(problems.join("\n"));
    return 1;
  }
  console.log("MAIL_SELFTEST_OK");
  return 0;
}

module.exports = { run };
