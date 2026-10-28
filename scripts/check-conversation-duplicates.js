"use strict";

// Synthetic mailboxes only. Label copies stay in the cache for conversation
// trash; the reader collapses them. No live mailbox or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unclosed " + name);
}

function loadFunctions(source, names) {
  const body = names.map((name) => functionSource(source, name)).join("\n");
  return new Function(body + "; return { " + names.join(", ") + " };")();
}

const appJs = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const thread = loadFunctions(appJs, [
  "threadMessageId",
  "threadMemberKey",
  "uniqueThreadMembers",
  "threadStripPlan",
  "threadEarlierLabel",
]);

function row(id, extra) {
  return Object.assign({
    id: id,
    accountId: "gmail",
    messageId: "<one@fixture.invalid>",
    providerId: "gmail-one",
    date: "2026-10-28T14:14:24.000Z",
    subject: "Testing attachment from morrow",
    from: "Leo Ho <sender@fixture.invalid>",
  }, extra);
}

const copies = [
  row("inbox"),
  row("category", { date: "2026-10-28T14:14:24.000Z" }),
  row("all-mail"),
];
const opened = thread.uniqueThreadMembers(copies, "all-mail");
assert.deepEqual(opened.map((item) => item.id), ["all-mail"]);
const alone = thread.threadStripPlan(opened, "all-mail", true);
assert.equal(alone.total, 1);
assert.equal(alone.count, 0);
assert.equal(alone.showControl, false);

const mixed = thread.uniqueThreadMembers([
  row("old-inbox", { messageId: "<old@fixture.invalid>", providerId: "gmail-old", date: "2026-10-28T14:00:00.000Z" }),
  row("old-category", { messageId: "<OLD@fixture.invalid>", providerId: "gmail-old", date: "2026-10-28T14:00:00.000Z" }),
  row("old-all", { messageId: "old@fixture.invalid", providerId: "gmail-old", date: "2026-10-28T14:00:00.000Z" }),
  row("mid", { messageId: "<mid@fixture.invalid>", providerId: "gmail-mid", date: "2026-10-28T14:10:00.000Z" }),
  row("new-inbox", { messageId: "<new@fixture.invalid>", providerId: "gmail-new", date: "2026-10-28T14:14:24.000Z" }),
  row("new-all", { messageId: "<new@fixture.invalid>", providerId: "gmail-new", date: "2026-10-28T14:14:24.000Z" }),
], "new-all");
assert.deepEqual(mixed.map((item) => item.id), ["old-inbox", "mid", "new-all"]);
const collapsed = thread.threadStripPlan(mixed, "new-all", false);
const expanded = thread.threadStripPlan(mixed, "new-all", true);
assert.equal(collapsed.count, 1);
assert.equal(expanded.count, 1);
assert.equal(thread.threadEarlierLabel(expanded.count), "Earlier in this conversation (1)");
assert.deepEqual(collapsed.visibleIds, ["mid", "new-all"]);
assert.deepEqual(expanded.visibleIds, ["old-inbox", "mid", "new-all"]);
assert.equal(expanded.count, expanded.visibleIds.length - 2);

const sentAndReceived = thread.uniqueThreadMembers(copies.concat([
  row("hotmail-sent", { accountId: "hotmail", providerId: "" }),
]), "all-mail");
assert.deepEqual(sentAndReceived.map((item) => item.id), ["all-mail"]);
const distinctSent = thread.uniqueThreadMembers(copies.concat([
  row("hotmail-other", {
    accountId: "hotmail",
    messageId: "<sent@fixture.invalid>",
    providerId: "gmail-one",
  }),
]), "all-mail");
assert.deepEqual(distinctSent.map((item) => item.id), ["all-mail", "hotmail-other"]);

const providerCopies = thread.uniqueThreadMembers([
  row("bare-inbox", { messageId: "", providerId: "gmail-bare" }),
  row("bare-all", { messageId: null, providerId: "gmail-bare" }),
], "bare-all");
assert.deepEqual(providerCopies.map((item) => item.id), ["bare-all"]);
const otherAccount = thread.uniqueThreadMembers([
  row("bare-inbox", { messageId: "", providerId: "gmail-bare" }),
  row("hotmail-bare", { accountId: "hotmail", messageId: "", providerId: "gmail-bare" }),
], "bare-inbox");
assert.deepEqual(otherAccount.map((item) => item.id), ["bare-inbox", "hotmail-bare"]);
const unnamed = thread.uniqueThreadMembers([
  row("plain-a", { messageId: "", providerId: "" }),
  row("plain-b", { messageId: "  ", providerId: "" }),
], "plain-a");
assert.deepEqual(unnamed.map((item) => item.id), ["plain-a", "plain-b"]);

async function cachedThreads() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-conversation-"));
  const previous = {
    MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR,
    MORROW_USER_DATA: process.env.MORROW_USER_DATA,
    MORROW_AI_CONFIG_DIR: process.env.MORROW_AI_CONFIG_DIR,
    MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS,
  };
  Object.assign(process.env, {
    MORROW_MAIL_DIR: directory,
    MORROW_USER_DATA: directory,
    MORROW_AI_CONFIG_DIR: directory,
    MORROW_MAIL_SECRETS: "memory",
  });
  const db = require("../host/mail/db");
  const engine = require("../host/mail/engine");
  const account = (id, email) => ({
    id: id, email: email, username: email, profile: "custom", authKind: "password", createdAt: 1,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true,
    smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true,
  });
  const when = "2026-10-28T14:14:24.000Z";
  function store(id, accountId, folder, threadId, rfc, stamp, providerId) {
    db.insertMessage({
      id: id, accountId: accountId, folderPath: folder, uid: 42, uidValidity: 7,
      threadId: threadId, rfcMessageId: rfc, subject: "Testing attachment from morrow",
      snippet: "Testing attachment from morrow", from: "Leo Ho <sender@fixture.invalid>",
      date: stamp, listSortTs: Date.parse(stamp), textBody: "Testing attachment from morrow",
      bodyComplete: true, recipientHeaders: { replyTo: [] },
    });
    if (providerId) db.updateMessage(id, { gmail_id: providerId });
  }
  const ask = async (channel, input) => {
    const result = await engine.answer(channel, [input]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  try {
    await engine.init();
    db.insertAccount(account("gmail", "owner@fixture.invalid"));
    db.insertAccount(account("hotmail", "sender@fixture.invalid"));
    const threadId = "thr:one@fixture.invalid";
    store("inbox", "gmail", "INBOX", threadId, "<one@fixture.invalid>", when, "gmail-one");
    store("category", "gmail", "CATEGORY_PERSONAL", threadId, "<one@fixture.invalid>", when, "gmail-one");
    store("all-mail", "gmail", "[Gmail]/All Mail", threadId, "<One@fixture.invalid>", when, "gmail-one");
    store("hotmail-sent", "hotmail", "Sent", threadId, "<one@fixture.invalid>", when, "");
    const openedMail = await ask("mail:openEmail", { emailId: "all-mail" });
    assert.equal(openedMail.threadMessages.length, 3);
    assert.equal(openedMail.isThread, true);
    assert.ok(openedMail.threadMessages.every((item) => item.providerId === "gmail-one"));
    const shown = thread.uniqueThreadMembers(openedMail.threadMessages, "all-mail");
    assert.deepEqual(shown.map((item) => item.id), ["all-mail"]);
    assert.equal(thread.threadStripPlan(shown, "all-mail", true).showControl, false);
    const listed = await ask("mail:listThreadMessages", { accountId: "gmail", threadId: threadId, headersOnly: true });
    assert.equal(listed.length, 3, "conversation trash still sees every label copy");
    assert.equal(db.messagesByThread("gmail", threadId).length, 3);

    const older = "thr:older@fixture.invalid";
    store("old-inbox", "gmail", "INBOX", older, "<old@fixture.invalid>", "2026-10-28T14:00:00.000Z", "gmail-old");
    store("old-all", "gmail", "[Gmail]/All Mail", older, "old@fixture.invalid", "2026-10-28T14:00:00.000Z", "gmail-old");
    store("mid", "gmail", "INBOX", older, "<mid@fixture.invalid>", "2026-10-28T14:10:00.000Z", "gmail-mid");
    store("new-inbox", "gmail", "INBOX", older, "<new@fixture.invalid>", when, "gmail-new");
    store("new-all", "gmail", "[Gmail]/All Mail", older, "<new@fixture.invalid>", when, "gmail-new");
    const conversation = thread.uniqueThreadMembers((await ask("mail:openEmail", { emailId: "new-all" })).threadMessages, "new-all");
    assert.deepEqual(conversation.map((item) => item.messageId.toLowerCase().replace(/[<>]/g, "")), [
      "old@fixture.invalid", "mid@fixture.invalid", "new@fixture.invalid",
    ]);
    const plan = thread.threadStripPlan(conversation, "new-all", true);
    assert.equal(plan.count, 1);
    assert.equal(plan.visibleIds.length, 3);
    assert.equal(thread.threadEarlierLabel(plan.count), "Earlier in this conversation (1)");

    const bareId = "thr:bare@fixture.invalid";
    store("bare-inbox", "gmail", "INBOX", bareId, null, when, "gmail-bare");
    store("bare-all", "gmail", "[Gmail]/All Mail", bareId, null, when, "gmail-bare");
    const bare = await ask("mail:openEmail", { emailId: "bare-all" });
    assert.equal(bare.threadMessages.length, 2);
    assert.ok(bare.threadMessages.every((item) => item.providerId === "gmail-bare" && !item.messageId));
    assert.deepEqual(thread.uniqueThreadMembers(bare.threadMessages, "bare-all").map((item) => item.id), ["bare-all"]);

    const plainId = "thr:plain@fixture.invalid";
    store("plain-a", "gmail", "INBOX", plainId, null, when, "");
    store("plain-b", "gmail", "Sent", plainId, null, when, "");
    const plain = await ask("mail:openEmail", { emailId: "plain-a" });
    assert.deepEqual(thread.uniqueThreadMembers(plain.threadMessages, "plain-a").map((item) => item.id).sort(), ["plain-a", "plain-b"]);
  } finally {
    await db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

cachedThreads().then(() => {
  console.log("conversation-duplicates-ok");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
