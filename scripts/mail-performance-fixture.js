"use strict";

// Synthetic data only. Callers must open their own temporary database first.
const account = { id: "performance-fixture", email: "owner@fixture.invalid", username: "owner", profile: "custom", authKind: "password", createdAt: 1,
  imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true };
const folders = [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Sent", name: "Sent", wellKnown: "sentitems" }];
function message(uid, extra = {}) {
  return { id: `performance-${uid}`, uid, threadId: `thread-${uid}`, rfcMessageId: `<performance-${uid}@fixture.invalid>`, subject: `Synthetic subject ${uid}`,
    from: "sender@fixture.invalid", fromAddress: "sender@fixture.invalid", fromDisplayName: "Synthetic sender", to: [account.email], cc: [], bcc: [],
    date: "2026-10-26T00:00:00.000Z", listSortTs: uid, snippet: "Synthetic snippet", textBody: "Synthetic searchable body", bodyComplete: true,
    recipientHeaders: { originalTo: [], deliveredTo: [], envelopeTo: [], replyTo: [] }, ...extra };
}
function report(messages, extra = {}) {
  return { messages, validity: 7, exists: messages.length, unseen: 0, keepOthers: true, windowDone: true, horizonDays: 0, ...extra };
}
function seed(db, { count = 10000, threadCount = 256, bodyBytes = 4096, threadBytes = 65536 } = {}) {
  db.insertAccount(account); db.replaceFolders(account.id, folders);
  const sized = (text, bytes) => text.repeat(Math.ceil(bytes / text.length)).slice(0, bytes);
  const ordinary = sized("Synthetic searchable mailbox body. ",bodyBytes);
  const long = sized("Synthetic searchable long thread body. ",threadBytes);
  for (let first = 1; first <= count; first += 100) {
    const rows = [];
    for (let uid = first; uid <= Math.min(count, first + 99); uid++) {
      const inThread = uid > count - threadCount;
      const textBody = inThread ? long : ordinary;
      rows.push(message(uid, { textBody, htmlBody: `<p>${textBody}</p>`, ...(inThread ? { threadId: "long-thread" } : {}) }));
    }
    db.applyFolderSync(account.id, "INBOX", report(rows));
  }
  return { count, threadCount, bodyBytes, threadBytes, openId: `performance-${count}` };
}
module.exports = { account, folders, message, report, seed };
