// Synthetic Outbox queue and renderer. No live mailbox.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const envKeys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
function configure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    MORROW_USER_DATA: dir,
    MORROW_MAIL_DIR: dir,
    MORROW_AI_CONFIG_DIR: dir,
    MORROW_MAIL_SECRETS: "memory",
  });
}
function modules() {
  return { engine: require("../host/mail/engine"), db: require("../host/mail/db") };
}
function seedAccount(db, id) {
  db.insertAccount({
    id, email: id + "@example.test", username: id, profile: "custom", createdAt: Date.now(),
    imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true,
  });
  db.replaceFolders(id, [
    { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
  ]);
}
function queue(engine, accountId, subject, sendAt) {
  return engine.answer("mail:scheduleSend", [{
    accountId, to: "bob@example.test", subject, body: "<p>" + subject + "</p>",
    fromAddress: accountId + "@example.test", sendAt, outbox: true,
  }]);
}

async function engineChecks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-outbox-"));
  configure(root);
  const { engine, db } = modules();
  await engine.init();
  seedAccount(db, "ada");
  seedAccount(db, "grace");
  const later = new Date(Date.now() + 20000).toISOString();
  try {
    const ada = queue(engine, "ada", "Ada note", later);
    const grace = queue(engine, "grace", "Grace note", later);
    assert.equal(ada.success, true);
    assert.equal(grace.success, true);
    assert.equal(ada.data.outbox, true);
    assert.equal(ada.data.accountId, "ada");
    assert.equal(grace.data.accountId, "grace");
    assert.match(ada.data.htmlBody, /Ada note/);
    const normal = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Later", body: "<p>Later</p>", sendAt: "2099-01-01T00:00:00.000Z",
    }]);
    assert.equal(normal.success, true);
    assert.equal(normal.data.outbox, undefined);
    assert.equal(normal.data.htmlBody, undefined);
    assert.equal(engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Past", sendAt: new Date(Date.now() - 5000).toISOString(), outbox: true,
    }]).success, false);
    assert.equal(engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Far", sendAt: new Date(Date.now() + 60000).toISOString(), outbox: true,
    }]).error.message, "Undo send waits at most 30 seconds.");
    const listed = engine.answer("mail:listScheduled", [{}]).data;
    assert.deepEqual(listed.filter((row) => row.outbox && (row.status === "pending" || row.status === "sending")).map((row) => row.accountId).sort(), ["ada", "grace"]);
    const canceled = engine.answer("mail:cancelScheduled", [{ id: ada.data.id }]);
    assert.equal(canceled.success, true);
    assert.match(canceled.data.snapshot.payloadJson, /Ada note/);
    assert.match(canceled.data.snapshot.payloadJson, /"outbox":true/);
    assert.equal(db.scheduledById(ada.data.id), null);

    const recoveryQueued = queue(engine, "ada", "Recovery note", later);
    const recovered = engine.answer("mail:cancelScheduled", [{ id: recoveryQueued.data.id, recoverDraft: true }]);
    assert.equal(recovered.success, true);
    assert.equal(recovered.data.id, recoveryQueued.data.id);
    assert.equal(recovered.data.accountId, "ada");
    assert.match(recovered.data.snapshot.payloadJson, /Recovery note/);
    assert.equal(db.scheduledById(recoveryQueued.data.id), null);
    const recoveryDraft = db.messageById(recovered.data.emailId);
    assert.equal(recoveryDraft.is_draft, 1);
    assert.equal(recoveryDraft.folder_path, "Drafts");
    assert.match(recoveryDraft.html_body, /Recovery note/);

    seedAccount(db, "no-drafts");
    db.replaceFolders("no-drafts", []);
    const unrecoverable = queue(engine, "no-drafts", "Keep queued", later);
    const recoveryFailed = engine.answer("mail:cancelScheduled", [{ id: unrecoverable.data.id, recoverDraft: true }]);
    assert.equal(recoveryFailed.success, false);
    assert.match(recoveryFailed.error.message, /queued message is unchanged/);
    assert.equal(db.scheduledById(unrecoverable.data.id).status, "pending");
    assert.equal(engine.answer("mail:cancelScheduled", [{ id: unrecoverable.data.id }]).success, true);

    let sent = 0;
    engine.setSmtpSenderForTest(async () => {
      sent += 1;
      const tooLate = engine.answer("mail:cancelScheduled", [{ id: grace.data.id, recoverDraft: true }]);
      assert.equal(tooLate.success, false);
      assert.equal(tooLate.error.code, "sending");
      return { messageId: "<ok@test>", accepted: ["bob@example.test"], rejected: [] };
    });
    db.setScheduledSendAt(grace.data.id, 0);
    const sentNotices = await engine.pumpScheduled();
    assert.equal(sent, 1);
    assert.equal(db.scheduledById(grace.data.id), null);
    assert.deepEqual(sentNotices, []);

    const partial = queue(engine, "ada", "Partial note", later);
    engine.setSmtpSenderForTest(async () => ({
      messageId: "<part@test>",
      accepted: ["ok@example.test"],
      rejected: ["bad@example.test"],
      rejectedErrors: [{ recipient: "bad@example.test", responseCode: 550 }],
    }));
    db.setScheduledSendAt(partial.data.id, 0);
    const partialNotices = await engine.pumpScheduled();
    assert.equal(db.scheduledById(partial.data.id).status, "partial");
    assert.equal(partialNotices.length, 1);
    assert.match(partialNotices[0].outboxReceipt.message, /bad@example.test/);
    assert.equal(engine.answer("mail:listScheduled", [{}]).data.find((row) => row.id === partial.data.id).outbox, true);

    const failed = queue(engine, "grace", "Failed note", later);
    engine.setSmtpSenderForTest(async () => {
      const error = new Error("getaddrinfo ENOTFOUND smtp.example.test");
      error.code = "ENOTFOUND";
      throw error;
    });
    db.setScheduledSendAt(failed.data.id, 0);
    const failedNotices = await engine.pumpScheduled();
    assert.equal(db.scheduledById(failed.data.id), null);
    assert.match(failedNotices[0].outboxRestore.message, /Delivery was not confirmed/);
    assert.match(failedNotices[0].outboxRestore.seed.body, /Failed note/);

    const uncertain = queue(engine, "grace", "Uncertain note", later);
    let uncertainAttempts = 0;
    engine.setSmtpSenderForTest(async () => {
      uncertainAttempts += 1;
      throw Object.assign(new Error("Connection closed after DATA"), { code: "ECONNRESET" });
    });
    db.setScheduledSendAt(uncertain.data.id, 0);
    const uncertainNotices = await engine.pumpScheduled();
    const recovery = db.scheduledById(uncertain.data.id);
    assert.equal(recovery.status, "unknown");
    assert.ok(recovery.message_id);
    assert.match(recovery.payload_json, /Uncertain note/);
    assert.equal(uncertainNotices[0].outboxRestore, undefined);
    assert.equal(uncertainNotices[0].outboxReceipt.uncertain, true);
    await db.close();
    await engine.init();
    assert.equal(db.messageById(recovered.data.emailId).is_draft, 1);
    assert.equal(db.scheduledById(uncertain.data.id).message_id, recovery.message_id);
    assert.equal(db.scheduledById(uncertain.data.id).status, "unknown");
    await engine.pumpScheduled();
    assert.equal(uncertainAttempts, 1);

    let woke = 0;
    engine.setSmtpSenderForTest(async () => {
      woke += 1;
      return { messageId: "<wake@test>", accepted: ["bob@example.test"], rejected: [] };
    });
    const wake = queue(engine, "ada", "Wake note", new Date(Date.now() + 80).toISOString());
    assert.equal(wake.success, true);
    const start = Date.now();
    while (woke < 1 && Date.now() - start < 2000) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(woke, 1);
    assert.equal(db.scheduledById(wake.data.id), null);
  } finally {
    engine.setSmtpSenderForTest(null);
    await db.close();
  }
}

function rendererChecks() {
  const { renderer } = require("./check-ux-workflows");
  const dom = new JSDOM(`<!doctype html><body>
    <dialog id="settings"></dialog>
    <nav id="folders"></nav>
    <input id="folder-filter" />
    <input id="search-query" />
    <input id="list-filter" />
    <h2 id="list-title"></h2>
    <div id="messages"><div id="message-list"></div></div>
    <div id="list-paging"></div>
    <button id="list-prev"></button>
    <button id="list-next"></button>
    <button id="list-sync-more"></button>
    <p id="list-page-status"></p>
    <div id="selection-bar" hidden></div>
    <input id="select-visible" type="checkbox" />
    <p id="selection-count"></p>
    <p id="search-scope"></p>
    <select id="search-account"></select>
    <p id="list-coverage"></p>
    <p id="filter-chip"></p>
    <div id="list-chips"></div>
    <div id="reader"></div>
    <button id="refresh"></button>
    <button id="remove"></button>
    <span id="sync-label"></span>
    <span id="sync-detail"></span>
    <div id="sync-control"></div>
    <div id="list-refresh-slot"></div>
    <div id="page-refresh-slot"></div>
    <p id="status"></p>
    <ul id="scheduled"></ul>
    <p id="scheduled-summary"></p>
  </body>`);
  const document = dom.window.document;
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const ui = renderer({ document });
  const rows = [
    { id: "s1", accountId: "ada", outbox: true, status: "pending", subject: "Ada note", to: "bob@example.test", sendAt: new Date().toISOString(), htmlBody: "<p>Hello <b>Ada</b></p><script>nope</script>", fromAddress: "ada@example.test", draftId: "draft-ada", inReplyTo: "msg-1" },
    { id: "s2", accountId: "grace", outbox: true, status: "sending", subject: "Grace note", to: "bea@example.test", sendAt: new Date().toISOString(), htmlBody: "<p>Sending</p>", fromAddress: "grace@example.test" },
    { id: "s3", accountId: "ada", outbox: true, status: "partial", subject: "Receipt", to: "bob@example.test", sendAt: new Date().toISOString(), htmlBody: "<p>Part</p>" },
    { id: "s4", accountId: "ada", status: "pending", subject: "Real schedule", to: "bob@example.test", sendAt: new Date().toISOString() },
  ];
  ui.context.rows = rows;
  ui.run(`
    state.accounts = [
      { id: "ada", email: "ada@example.test", name: "Ada", platform: "imap" },
      { id: "grace", email: "grace@example.test", name: "Grace", platform: "imap" },
    ];
    state.accountId = "ada";
    state.view = "mail";
    globalThis.calls = [];
    globalThis.opened = null;
    globalThis.statuses = [];
    showStatus = (text, isError) => { statuses.push([text || "", !!isError]); };
    call = async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "mail:listScheduled") return rows;
      if (channel === "mail:cancelScheduled") return { id: payload.id, emailId: "recovered-ada", accountId: "ada", snapshot: { payloadJson: JSON.stringify({ body: "<p>Hello <b>Ada</b></p>", draftId: "draft-ada", inReplyTo: "msg-1", subject: "Ada note", to: ["bob@example.test"], outbox: true }) } };
      if (channel === "mail:openEmail") return { email: { id: "recovered-ada", accountId: "ada", isDraft: true, bodyComplete: true, fromAddress: "ada@example.test", to: ["bob@example.test"], cc: [], bcc: [], subject: "Ada note", textBody: "Hello Ada", htmlBody: "<p>Hello <b>Ada</b></p>", inReplyTo: "msg-1" } };
      return {};
    };
    presentCompose = async (seed) => { opened = seed; };
  `);
  assert.deepEqual(ui.run("scheduledRows(rows).map(row => row.id)"), ["s3", "s4"]);
  assert.deepEqual(ui.run("outboxRowsFrom(rows).map(row => row.id)"), ["s1", "s2"]);
  ui.context.morrowFolderCollapse = require("../shared/folder-collapse");
  ui.context.window.morrow.invoke = async (channel, payload) => {
    if (channel === "morrow:configSetSidebarCollapsedFolders") return payload;
    return {};
  };
  ui.run("renderAccounts()");
  const nav = document.getElementById("folders");
  const testIds = () => [...nav.querySelectorAll("[data-testid]")].map((node) => node.getAttribute("data-testid"));
  assert.deepEqual(testIds(), ["all-account-mail", "all-account-inbox", "all-account-unread", "outbox"]);
  const header = nav.querySelector("[data-testid=all-account-mail]");
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.equal(header.querySelector(".name").textContent, "All Account Mail");
  assert.equal(nav.querySelector("[data-testid=all-account-inbox] .name").textContent, "Inbox");
  assert.equal(nav.querySelector("[data-testid=outbox] .outbox-count").hidden, true);
  header.click();
  return ui.run("new Promise((resolve) => setTimeout(resolve, 0))").then(() => {
    assert.equal(ui.run("state.allInbox"), false);
    assert.equal(ui.run("state.outbox"), false);
    assert.deepEqual(testIds(), ["all-account-mail"]);
    assert.equal(nav.querySelector("[data-testid=all-account-mail]").getAttribute("aria-expanded"), "false");
    assert.deepEqual(ui.run("state.prefs.collapsedFolders"), { "*": ["all-account-mail"] });
    assert.equal(ui.run("calls.some((item) => item.channel === 'mail:listFromCache')"), false);
    ui.run(`onFolderNavKey({ key: "ArrowRight", target: document.querySelector("[data-testid=all-account-mail]"), preventDefault() {}, stopPropagation() {} })`);
    return ui.run("new Promise((resolve) => setTimeout(resolve, 0))");
  }).then(() => {
    assert.equal(nav.querySelector("[data-testid=all-account-mail]").getAttribute("aria-expanded"), "true");
    assert.deepEqual(testIds(), ["all-account-mail", "all-account-inbox", "all-account-unread", "outbox"]);
    assert.deepEqual(ui.run("state.prefs.collapsedFolders"), {});
    ui.run(`onFolderNavKey({ key: "ArrowLeft", target: document.querySelector("[data-testid=all-account-mail]"), preventDefault() {}, stopPropagation() {} })`);
    return ui.run("new Promise((resolve) => setTimeout(resolve, 0))");
  }).then(() => {
    assert.equal(nav.querySelector("[data-testid=all-account-mail]").getAttribute("aria-expanded"), "false");
    assert.deepEqual(testIds(), ["all-account-mail"]);
    ui.run(`onFolderNavKey({ key: "ArrowRight", target: document.querySelector("[data-testid=all-account-mail]"), preventDefault() {}, stopPropagation() {} })`);
    return ui.run("new Promise((resolve) => setTimeout(resolve, 0))");
  }).then(() => {
    document.getElementById("folder-filter").value = "outbox";
    ui.run("renderAccounts()");
    assert.deepEqual(testIds(), ["all-account-mail", "outbox"]);
    assert.equal(nav.querySelector("[data-testid=all-account-mail]").dataset.navLock, "1");
    document.getElementById("folder-filter").value = "account";
    ui.run("renderAccounts()");
    assert.deepEqual(testIds(), ["all-account-mail"]);
    assert.equal(nav.querySelector("[data-testid=all-account-mail]").hasAttribute("aria-expanded"), false);
    document.getElementById("folder-filter").value = "";
    ui.run("renderAccounts()");
    nav.querySelector("[data-testid=all-account-inbox]").click();
    return ui.run("new Promise((resolve) => setTimeout(resolve, 0))");
  }).then(() => {
    assert.equal(ui.run("state.allInbox"), true);
    assert.equal(ui.run("state.outbox"), false);
    assert.equal(document.getElementById("list-title").textContent, "All Account Mail");
    assert.equal(nav.querySelector("[data-testid=all-account-inbox]").getAttribute("aria-current"), "true");
    assert.equal(nav.querySelector("[data-testid=all-account-mail]").hasAttribute("aria-current"), false);
    return ui.run("selectOutbox()");
  }).then(() => {
    assert.equal(document.getElementById("list-title").textContent, "Outbox");
    const list = document.getElementById("message-list").textContent;
    assert.match(list, /Ada note/);
    assert.match(list, /Grace note/);
    assert.match(list, /Ada/);
    assert.match(list, /Grace/);
    assert.equal(nav.querySelector("[data-testid=outbox]").getAttribute("aria-current"), "true");
    assert.equal(nav.querySelector(".outbox-count").textContent, "2");
    const sending = document.querySelector('[data-action="undo-outbox"][disabled]');
    assert.ok(sending, "sending row cannot be undone");
    return ui.run("openMessage('s1')");
  }).then(() => {
    const reader = document.getElementById("reader");
    assert.equal(reader.querySelector("[data-testid=outbox-undo]").textContent, "Undo send");
    assert.equal(reader.querySelector("pre.outbox-body").textContent, "Hello Ada");
    assert.doesNotMatch(reader.textContent, /<b>|script/);
    assert.equal(ui.run("calls.some(item => item.channel === 'mail:openEmail')"), false);
    return ui.run("undoOutboxItem(state.emails.find(row => row.id === 's1'))");
  }).then(() => {
    assert.equal(ui.run("calls.filter(item => item.channel === 'mail:cancelScheduled').length"), 1);
    assert.deepEqual(JSON.parse(ui.run("JSON.stringify(calls.find(item => item.channel === 'mail:cancelScheduled').payload)")), { id: "s1", recoverDraft: true });
    assert.equal(ui.run("calls.some(item => item.channel === 'mail:editScheduled')"), false);
    const opened = ui.run("opened");
    assert.equal(opened.draftId, "recovered-ada");
    assert.equal(opened.inReplyTo, "msg-1");
    assert.equal(opened.body, "Hello Ada");
    assert.equal(document.getElementById("message-list").textContent.includes("Ada note"), false);
    return ui.run("undoOutboxItem(state.emails.find(row => row.id === 's2'))");
  }).then(() => {
    assert.match(ui.run("statuses.at(-1)[0]"), /can no longer be canceled/);
    assert.equal(ui.run("calls.filter(item => item.channel === 'mail:cancelScheduled').length"), 1);
    ui.run("state.outboxRows = []; state.emails = []; renderList()");
    assert.match(document.getElementById("message-list").textContent, /Nothing is waiting to send/);
  });
}

async function run() {
  await engineChecks();
  await rendererChecks();
  console.log("outbox-ok");
}
module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
