// Synthetic transports and native SQLite. The renderer uses the real preload and DOM, without Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { simpleParser } = require("mailparser");
const dsn = require("../host/mail/dsn-report");

const valid = 91;
const oldAddress = "former@example.test";
const newAddress = "Replacement+sales@example.test";
const accountEmail = "mailbox@example.test";
const fromAddress = "alias@example.test";
const fromName = 'Chan, "Operations" <team> 產品';
const originalId = "<original.777@example.test>";
const sentAt = new Date("2026-11-25T08:00:00Z");
const receivedAt = new Date("2026-11-25T08:05:00Z");
const originalSubject = "Contract & terms";
const originalText = "Dear team,\r\n\r\nPlease keep the agreed terms <unchanged>.\r\n";
const originalHtml = '<div>Original &amp; safe</div><script>ignored()</script><img src="https://images.example.test/pixel">';
const q = value => Buffer.from(value || "").toString("base64url");
const tick = () => new Promise(resolve => setImmediate(resolve));

function report({ original = `Message-ID: ${originalId}`, to = accountEmail, outer = "multipart/report; report-type=delivery-status;",
  failure = `Final-Recipient: rfc822; ${oldAddress}\r\nAction: failed\r\nStatus: 5.1.1`, returnedType = "text/rfc822-headers",
  explanation = "An external diagnostic; never put this in a draft.", closed = true } = {}) {
  return Buffer.from([
    "From: Mail Delivery <postmaster@example.test>", `To: ${to}`, `Date: ${receivedAt.toUTCString()}`,
    "Message-ID: <dsn.888@example.test>", "Subject: Delivery Status Notification (Failure)", `Content-Type: ${outer}`, ' boundary="dsn-888"', "",
    "--dsn-888", "Content-Type: text/plain", "", explanation,
    "--dsn-888", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; mx.example.test", "", failure,
    "Diagnostic-Code: smtp; 550 synthetic failure", "",
    "--dsn-888", `Content-Type: ${returnedType}`, "", "Subject: Returned copy subject", original,
    ...(returnedType === "message/rfc822" ? ["", "UNTRUSTED returned message body"] : []),
    "", ...(closed ? ["--dsn-888--", ""] : []),
  ].join("\r\n"));
}

function mimeChecks() {
  const expected = { kind: "report", id: originalId, failed: oldAddress, notified: accountEmail };
  assert.deepEqual(dsn.fromReport(report()), expected);
  const delayed = report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: delayed\r\nStatus: 4.2.0` });
  const wait = { kind: "report", delayed: true, notified: accountEmail };
  assert.deepEqual(dsn.fromReport(delayed), wait);
  const noOriginal = delayed.toString().replace(/--dsn-888\r\nContent-Type: text\/rfc822-headers[\s\S]+?(?=--dsn-888--)/, "");
  assert.deepEqual(dsn.fromReport(Buffer.from(noOriginal)), wait);
  assert.deepEqual(dsn.fromReport(report({ returnedType: "message/rfc822" })), expected);
  assert.deepEqual(dsn.fromReport(report({ original: `Message-ID:\r\n\t${originalId}` })), expected);
  assert.deepEqual(dsn.fromReport(report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nOriginal-Recipient: rfc822; ${oldAddress}\r\nAction: FAILED\r\nStatus: 5.1.1` })), expected);
  for (const source of [
    report({ original: "X-Original-Message-ID: " + originalId }),
    report({ original: `Message-ID: ${originalId}\r\nMessage-ID: ${originalId}` }),
    report({ original: `Message-ID: ${originalId} <another@example.test>` }),
    report({ original: `Message-ID: ${originalId}\u0000` }),
    report({ original: `Message-ID: ${originalId.replace("777", "7\u202e77")}` }),
    report({ original: `Message-ID: ${originalId}\r\nmalformed field` }),
    report({ outer: "multipart/mixed;" }),
    report({ outer: "multipart/report; report-type=delivery-status; report-type=delivery-status;" }),
    report({ closed: false }),
    report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: delayed\r\nStatus: 5.1.1` }),
    report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: failed\r\nStatus: 4.1.1` }),
    report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: failed\r\nStatus: 5.1.10` }),
    report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: failed\r\nAction: failed\r\nStatus: 5.1.1` }),
    report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nOriginal-Recipient: rfc822; different@example.test\r\nAction: failed\r\nStatus: 5.1.1` }),
    report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\nFinal-Recipient: rfc822; other@example.test\r\nAction: failed\r\nStatus: 5.1.1` }),
    report({ to: `${accountEmail}, another@example.test` }),
  ]) assert.equal(dsn.fromReport(source), dsn.REPORT);
  assert.deepEqual(dsn.fromReport(report(), false), { kind: "report", partial: true });
}

async function fetched(uid, source, bodyStructure) {
  const parsed = await simpleParser(source);
  const values = key => parsed[key]?.value || [];
  return { uid, source, size: source.length, bodyStructure, internalDate: receivedAt, flags: new Set(["\\Seen"]), envelope: {
    from: values("from"), to: values("to"), cc: values("cc"), bcc: values("bcc"), subject: parsed.subject,
    date: parsed.date, messageId: parsed.messageId,
  } };
}

function imap(rows) {
  return {
    mailbox: { uidValidity: valid },
    async getMailboxLock() { return { release() {} }; },
    async *fetch(request, fields) {
      for (const uid of request.split(",").map(Number)) {
        const row = rows.find(item => item.uid === uid);
        assert.ok(row, "only fixture UIDs may be fetched");
        yield { ...row, source: row.source.subarray(0, fields.source.maxLength) };
      }
    },
  };
}

function seed(db, id, email, gmail = false) {
  db.insertAccount({ id, email, username: email, profile: gmail ? "gmail" : "custom", authKind: gmail ? "oauth2" : "password",
    createdAt: Date.now(), imapHost: "imap.example.test", imapPort: 993, imapTls: true,
    smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
  if (gmail) db.enableGmail(id);
  db.replaceFolders(id, [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox", ...(gmail ? { providerId: "INBOX" } : {}) },
    { path: "Sent", name: "Sent", wellKnown: "sentitems", ...(gmail ? { providerId: "SENT" } : {}) },
    { path: "Drafts", name: "Drafts", wellKnown: "drafts", ...(gmail ? { providerId: "DRAFT" } : {}) },
    { path: "Archive", name: "Archive", wellKnown: gmail ? "all" : "archive", ...(gmail ? { providerId: "__gmail_all__" } : {}) },
  ]);
}

function owner(id) {
  const mainFrame = {};
  return { senderFrame: mainFrame, sender: { id, mainFrame, isDestroyed: () => false } };
}

async function rendererChecks(invoke, email, waiting, legacy, mailAccount, temp) {
  const app = fs.readFileSync(require.resolve("../renderer/app.js"), "utf8");
  const preload = fs.readFileSync(require.resolve("../renderer/preload.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://morrow.example.test/", runScripts: "outside-only" });
  const { window } = dom;
  const document = window.document;
  const $ = id => document.getElementById(id);
  const invokes = [];
  let reloadResult;
  const reviews = owner(7);
  const context = dom.getInternalVMContext();
  try {
    vm.runInNewContext(preload, { require(name) {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld(key, api) { window[key] = api; } }, ipcRenderer: {
        async invoke(channel, payload) {
          invokes.push([channel, payload]);
          const result = invoke(channel, payload, reviews);
          if (channel === "mail:openEmail") reloadResult = result;
          return result;
        },
        on() {}, removeListener() {}, send() {},
      } };
    } });
    // jsdom does not implement the native dialog methods. All form actions and
    // focus behavior below use the real renderer with the local DOM.
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
    const catalog = path.join(temp, "features-catalog.js");
    const { generateFeatureCatalog, readExpectedFeatures } = require("./check-boot-path/feature-catalog");
    generateFeatureCatalog(undefined, catalog);
    vm.runInContext(fs.readFileSync(catalog, "utf8"), context);
    for (const script of ["compose-policy", "display-format", "mailbox-roles", "mail-context-owner", "recipient-suggest"]) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, `../shared/${script}.js`), "utf8"), context);
    }
    vm.runInContext(app.slice(0, app.lastIndexOf("\nboot().catch(")) + `\n`
      + `globalThis.fixture = { state, wire, renderReader, acceptDsnRedraft, paintFeatureCatalog, showFeaturesTab };`, context);
    const fixture = window.fixture;
    fixture.state.accounts = [mailAccount];
    fixture.state.accountId = mailAccount.id;
    fixture.state.folderId = "Archive";
    fixture.state.email = legacy;
    fixture.wire();
    fixture.renderReader(false);
    const action = () => $("reader").querySelector('[data-action="dsn-redraft"]');
    assert.equal(action(), null);
    const reload = $("reader").querySelector('[data-action="retry-body"]');
    assert.equal(reload?.textContent, "Reload message");
    assert.equal(reloadResult, undefined, "rendering a cached Inbox report does not reopen it");
    reload.click();
    const opens = invokes.filter(([channel]) => channel === "mail:openEmail");
    assert.equal(opens.length, 1);
    const [, request] = opens[0];
    assert.deepEqual([request.accountId, request.emailId, request.full, request.retry], [legacy.accountId, legacy.id, true, true]);
    await reloadResult;
    await tick();
    assert.ok(action(), "the reloaded report can now be reviewed");

    fixture.state.folderId = "INBOX";
    fixture.state.email = email;
    fixture.state.thread = [];
    fixture.renderReader(false);
    assert.equal(action().getAttribute("aria-label"), "Review delivery report");
    assert.equal(action().getAttribute("aria-haspopup"), "dialog");
    assert.equal(action().querySelector("svg").getAttribute("aria-hidden"), "true");
    action().click();
    await tick();
    assert.equal($("dsn-redraft").open, true);
    assert.equal(document.activeElement, $("dsn-redraft-title"));
    assert.equal($("dsn-redraft-mailbox").textContent, accountEmail);
    assert.equal($("dsn-redraft-from").textContent, `${fromName} <${fromAddress}>`);
    assert.match($("dsn-redraft-date").textContent, /2026-11-25T08:00:00.000Z/);
    assert.equal($("dsn-redraft-failed").textContent, oldAddress);
    assert.equal($("dsn-redraft-subject").textContent, originalSubject);
    assert.equal($("dsn-redraft-body").textContent.trim(), originalText.replace(/\r\n/g, "\n").trim());
    assert.equal($("dsn-redraft-body").childElementCount, 0);
    assert.equal($("dsn-redraft-to").value, "");
    assert.equal($("dsn-redraft-save").disabled, true);
    $("dsn-redraft-close").click();
    assert.equal(invokes.filter(([, data]) => data.action === "save").length, 0);
    assert.equal(document.activeElement, action());

    fixture.state.email = waiting;
    fixture.renderReader(false);
    action().click();
    await tick();
    assert.equal($("dsn-redraft-review").hidden, true);
    assert.equal($("dsn-redraft-status").getAttribute("role"), "status");
    assert.match($("dsn-redraft-status").textContent, /review the delivery failure manually/i);
    $("dsn-redraft-close").click();

    fixture.state.email = email;
    fixture.renderReader(false);
    action().click();
    await tick();
    const to = $("dsn-redraft-to"), confirm = $("dsn-redraft-confirm"), save = $("dsn-redraft-save");
    to.value = oldAddress;
    to.dispatchEvent(new window.Event("input"));
    confirm.click();
    save.click();
    await tick();
    assert.match($("dsn-redraft-status").textContent, /different email address/);
    to.value = newAddress;
    to.dispatchEvent(new window.Event("input"));
    assert.equal(confirm.checked, false);
    assert.equal(save.disabled, true);
    confirm.click();
    save.click();
    save.click();
    await tick();
    assert.equal($("dsn-redraft-open").hidden, false);
    assert.match($("dsn-redraft-status").textContent, /saved on this computer/);
    assert.equal(invokes.filter(([, data]) => data.action === "save").length, 2, "one invalid attempt and one save");
    $("dsn-redraft-open").click();
    await tick();
    assert.equal($("dsn-redraft").open, false);
    const compose = invokes.find(([channel]) => channel === "compose:open")?.[1];
    assert.ok(compose?.draftId, "the Reader reuses Resume draft");
    assert.deepEqual([compose.fromAddress, compose.fromDisplayName, compose.to, compose.cc, compose.bcc],
      [fromAddress, fromName, newAddress, "", ""]);

    fixture.acceptDsnRedraft({}, { review: "fixture", mailbox: accountEmail, fromAddress, fromDisplayName: fromName,
      date: sentAt.toISOString(), failedAddress: oldAddress, subject: originalSubject, body: "Plain fallback",
      htmlBody: originalHtml + '<p><a href="https://example.test/terms">Terms</a></p>' });
    const formatted = $("dsn-redraft-body");
    assert.match(formatted.textContent, /Original & safe/);
    assert.equal(formatted.querySelector("a")?.getAttribute("href"), "https://example.test/terms");
    assert.equal(formatted.querySelector("script, img"), null);

    fixture.paintFeatureCatalog();
    fixture.showFeaturesTab("shortcuts");
    fixture.showFeaturesTab("catalog");
    const expected = readExpectedFeatures().find(([id]) => id === "dsn-redraft");
    const card = Array.from($("features-catalog").querySelectorAll(".feature-card")).find(el => el.querySelector("h4").textContent === expected[1]);
    assert.ok(card && !card.closest('[role="tabpanel"]').hidden);
    assert.equal(card.querySelector(".feature-card-blurb").textContent, expected[3]);
  } finally { window.close(); }
}

async function run() {
  mimeChecks();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-dsn-redraft-"));
  const env = { MORROW_USER_DATA: temp, MORROW_MAIL_DIR: temp, MORROW_AI_CONFIG_DIR: temp, MORROW_MAIL_SECRETS: "memory" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote");
  const settings = require("../host/settings"), secrets = require("../host/mail/secrets");
  const originalFetch = global.fetch, originalClient = remote.withClient, originalAppend = remote.appendRaw, originalSend = remote.sendSmtp;
  let fixtureClient, providerWrites = 0, providerReads = 0;
  global.fetch = async () => { throw new Error("No network in the DSN fixture"); };
  remote.withClient = async (account, _secret, work) => {
    assert.equal(account.id, "dsn-imap");
    assert.ok(fixtureClient, "only the explicit synthetic download may read a provider");
    providerReads++;
    return work(fixtureClient);
  };
  remote.appendRaw = remote.sendSmtp = () => { providerWrites++; throw new Error("Unexpected provider write"); };
  const ipc = (channel, payload, event) => engine.answer(channel, [payload], event);
  const reader = owner(12), secondReader = owner(13);
  const find = (accountId, folder, uid) => db.messageByUid(accountId, folder, uid, valid);
  const target = (row, extra = {}) => ({ accountId: row.account_id, emailId: row.id, bodyEpoch: 0, ...extra });
  const review = (row, extra, event = reader) => ipc("mail:dsnRedraft", target(row, { action: "review", ...extra }), event);
  const save = (row, token, extra, event = reader) => ipc("mail:dsnRedraft", target(row,
    { action: "save", to: newAddress, review: token, confirmed: true, ...extra }), event);
  const count = accountId => db.countInFolder(accountId, "Drafts");
  const ordinary = (messageId, extra = {}) => remote.buildRaw({ from: { address: fromAddress, name: fromName }, date: sentAt,
    to: [`Former <${oldAddress}>`, "untouched@example.test"], cc: ["copy@example.test"], bcc: ["secret@example.test"], keepBcc: true,
    subject: originalSubject, messageId, text: originalText, ...extra });
  async function ingest(accountId, folder, rows) {
    const fetched = await remote.fetchMessages(imap(rows), folder, rows.map(row => row.uid));
    await db.applyFolderSyncAsync(accountId, folder, { ...fetched, keepOthers: true });
  }
  try {
    await engine.init();
    const accountId = "dsn-imap";
    seed(db, accountId, accountEmail);
    seed(db, "dsn-other", "other@example.test");
    secrets.setPassword(accountId, "offline-fixture");
    const prefs = { ccByDomain: { "example.test": ["default-cc@example.test"] }, bccByDomain: { "example.test": ["default-bcc@example.test"] },
      accounts: { [accountId]: { aliases: [{ address: fromAddress }], senderNames: { [fromAddress]: "New default name" } } } };
    settings.answer("emailBrain:saveComposeSettings", [prefs]);
    await ingest(accountId, "Sent", [await fetched(1, await ordinary(originalId))]);
    const original = find(accountId, "Sent", 1);
    const originalRfc = subject => `<${subject}@example.test>`;
    await ingest(accountId, "INBOX", [await fetched(2, report()), await fetched(3, report({ to: "other@example.test" })),
      await fetched(4, report({ failure: "Final-Recipient: rfc822; mismatch@example.test\r\nAction: failed\r\nStatus: 5.1.1" })),
      await fetched(5, report({ original: `Message-ID: ${originalRfc("missing")}` })),
      await fetched(6, report({ original: `Message-ID: ${originalId}\r\nMessage-ID: ${originalId}` })),
      await fetched(7, report({ outer: "multipart/mixed;" })),
      await fetched(9, report({ outer: "multipart/report; report-type=disposition-notification;" })),
      await fetched(8, report({ failure: `Final-Recipient: rfc822; ${oldAddress}\r\nAction: delayed\r\nStatus: 4.2.0` }))]);
    const inbox = find(accountId, "INBOX", 2);
    const waiting = find(accountId, "INBOX", 6);
    const delayed = find(accountId, "INBOX", 8);
    assert.equal(review(delayed).error.code, "dsn_delayed");
    assert.equal(save(delayed, "").error.code, "dsn_delayed");
    assert.equal(count(accountId), 0);
    const opened = await ipc("mail:openEmail", target(inbox));
    assert.equal(opened.data.email.dsnRedraftAvailable, true);
    assert.equal((await ipc("mail:openEmail", target(find(accountId, "INBOX", 7)))).data.email.dsnRedraftAvailable, false);
    assert.equal((await ipc("mail:openEmail", target(find(accountId, "INBOX", 9)))).data.email.dsnRedraftAvailable, false, "read receipts are separate from delivery reports");
    for (const uid of [3, 4, 5, 6]) assert.equal(review(find(accountId, "INBOX", uid)).error.code, "dsn_manual");
    assert.equal(review(inbox, { accountId: "dsn-other" }).error.code, "dsn_manual");
    assert.equal(review(inbox, { bodyEpoch: 1 }).error.code, "dsn_manual");
    assert.equal(review(inbox, {}, { ...reader, senderFrame: {} }).error.code, "dsn_reader");
    await ingest("dsn-other", "Sent", [await fetched(1, await ordinary(originalRfc("missing")))]);
    assert.equal(review(find(accountId, "INBOX", 5)).error.code, "dsn_manual", "an original in the other account is ineligible");
    await ingest(accountId, "Archive", [await fetched(1, await ordinary(originalId))]);
    assert.ok(review(inbox).data.review, "a copy in Archive is outside the Sent lookup");
    db.deleteMessage(find(accountId, "Archive", 1).id);
    await ingest(accountId, "Sent", [await fetched(10, await ordinary(originalId))]);
    assert.equal(review(inbox).error.code, "dsn_manual", "two Sent matches are ambiguous");
    db.deleteMessage(find(accountId, "Sent", 10).id);
    await ingest(accountId, "Archive", [await fetched(20, report())]);
    assert.equal(review(find(accountId, "Archive", 20)).error.code, "dsn_manual");

    const preview = review(inbox).data;
    assert.ok(preview.review, JSON.stringify(review(inbox)));
    assert.deepEqual([preview.mailbox, preview.fromAddress, preview.fromDisplayName, preview.failedAddress, preview.date],
      [accountEmail, fromAddress, fromName, oldAddress, sentAt.toISOString()]);
    assert.equal(preview.body, original.text_body);
    assert.equal(preview.subject, originalSubject);
    assert.equal(save(inbox, preview.review, {}, secondReader).error.code, "dsn_changed");
    for (const to of [oldAddress.toUpperCase(), "bad@example.test,another@example.test", "Name <new@example.test>",
      "new@example.test\r\nBcc: extra@example.test", "bad..address@example.test", "new@-example.test", [newAddress], "new\u202e@example.test"]) {
      assert.equal(save(inbox, preview.review, { to }).error.code, "invalid_recipient");
    }
    assert.equal(save(inbox, preview.review, { confirmed: "true" }).error.code, "invalid_recipient");
    db.updateMessage(original.id, { text_body: "edited after review" });
    assert.equal(save(inbox, preview.review).error.code, "dsn_changed");
    db.updateMessage(original.id, { text_body: original.text_body, body_complete: 0 });
    assert.equal(review(inbox).error.code, "dsn_manual");
    db.updateMessage(original.id, { body_complete: 1, from_address: null });
    assert.equal(review(inbox).error.code, "dsn_manual", "a missing From must not fall back to primary");
    db.updateMessage(original.id, { from_address: fromAddress });
    settings.answer("emailBrain:saveComposeSettings", [{}]);
    assert.equal(review(inbox).error.code, "dsn_manual", "a removed alias must not fall back to primary");
    settings.answer("emailBrain:saveComposeSettings", [prefs]);
    assert.equal(count(accountId), 0);

    const beforeReport = db.messageById(inbox.id), beforeSent = db.messageById(original.id);
    const legacySource = await fetched(24, report());
    await ingest(accountId, "INBOX", [legacySource]);
    const legacy = find(accountId, "INBOX", legacySource.uid);
    db.updateMessage(legacy.id, { dsn_redraft_json: null });
    const cachedReport = (await ipc("mail:openEmail", target(legacy))).data.email;
    assert.deepEqual([cachedReport.bodyComplete, cachedReport.unsubscribeChecked, cachedReport.dsnRedraftAvailable],
      [true, true, false]);
    assert.equal(providerReads, 0, "opening the cached report uses the complete body");
    fixtureClient = imap([legacySource]);
    await rendererChecks(ipc, opened.data.email, (await ipc("mail:openEmail", target(waiting))).data.email,
      cachedReport, engine.accountViews().find(account => account.id === accountId), temp);
    fixtureClient = null;
    assert.equal(providerReads, 1, "Reload message fetches the report once");
    const saved = review(inbox).data;
    assert.equal(saved.alreadySaved, true);
    assert.equal(save(inbox, preview.review, { to: "extra@example.test" }).data.draftId, saved.draftId);
    const draft = db.messageById(saved.draftId);
    assert.equal(count(accountId), 1);
    assert.deepEqual(db.jsonList(draft.to_json), [newAddress]);
    assert.equal(draft.cc_json, "[]");
    assert.equal(draft.bcc_json, "[]");
    assert.equal(draft.attachments_json, "[]");
    assert.equal(draft.subject, originalSubject);
    assert.equal(draft.text_body, original.text_body);
    assert.equal(draft.html_body, null);
    assert.equal(draft.uid, 0);
    assert.equal(draft.draft_pending, 1);
    assert.equal(draft.in_reply_to, null);
    assert.notEqual(draft.rfc_message_id, originalId);
    assert.notEqual(draft.thread_id, original.thread_id);
    const resumed = (await ipc("mail:openEmail", target(draft, { full: true }))).data.email;
    assert.deepEqual([resumed.fromAddress, resumed.fromDisplayName], [fromAddress, fromName]);
    assert.deepEqual(db.messageById(inbox.id), beforeReport);
    assert.deepEqual(db.messageById(original.id), beforeSent);

    const htmlId = originalRfc("html"), attachmentId = originalRfc("has-file"), addressInNameId = originalRfc("address-in-name");
    await ingest(accountId, "Sent", [await fetched(11, await ordinary(htmlId, { text: undefined, html: originalHtml })),
      await fetched(12, await ordinary(attachmentId, { attachments: [{ filename: "private.txt", content: "synthetic" }] })),
      await fetched(13, await ordinary(addressInNameId, { to: [{ name: `Display <${oldAddress}>`, address: "actual@example.test" }] }))]);
    const large = await fetched(21, report({ original: `Message-ID: ${htmlId}`, explanation: "A".repeat(100 * 1024) }));
    await ingest(accountId, "INBOX", [large, await fetched(22, report({ original: `Message-ID: ${attachmentId}` })),
      await fetched(23, report({ original: `Message-ID: ${addressInNameId}` }))]);
    const partial = find(accountId, "INBOX", 21);
    assert.equal(partial.body_complete, 0);
    assert.equal(review(partial).error.code, "dsn_manual");
    assert.equal(review(find(accountId, "INBOX", 22)).error.code, "dsn_manual", "an attachment in original MIME blocks even without BODYSTRUCTURE");
    assert.equal(review(find(accountId, "INBOX", 23)).error.code, "dsn_manual", "an address in the original recipient’s display name is not evidence");
    const readsBeforePartial = providerReads;
    fixtureClient = imap([large]);
    assert.equal((await ipc("mail:openEmail", target(partial, { full: true }))).data.email.dsnRedraftAvailable, true);
    fixtureClient = null;
    assert.equal(providerReads - readsBeforePartial, 1);
    await ingest(accountId, "INBOX", [large]);
    const htmlReview = review(partial).data;
    const storedHtml = find(accountId, "Sent", 11).html_body;
    assert.equal(storedHtml.trim(), originalHtml);
    assert.equal(htmlReview.htmlBody, storedHtml);
    assert.equal(htmlReview.body, "Original & safe");
    const htmlDraft = save(partial, htmlReview.review).data;
    assert.equal(db.messageById(htmlDraft.draftId).text_body, "Original & safe");
    assert.equal(db.messageById(htmlDraft.draftId).html_body, storedHtml);

    await gmailChecks(db, review, save, ipc, target);
    assert.equal(providerWrites, 0);
    assert.equal(db.listScheduled().length, 0);
    await db.close();
    await engine.init();
    assert.equal(review(inbox).data.draftId, draft.id, "repeat review reopens the same draft after relaunch");
    console.log("DSN corrected draft checks passed (MIME, SQLite, preload, Reader and Features DOM)");
  } finally {
    global.fetch = originalFetch;
    remote.withClient = originalClient;
    remote.appendRaw = originalAppend;
    remote.sendSmtp = originalSend;
    await db.close();
    Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function gmailChecks(db, review, save, ipc, target) {
  const id = "dsn-gmail", email = "dsn-gmail@example.test";
  seed(db, id, email, true);
  const { createSession } = require("../host/mail/gmail-session");
  const original = { id: "gsent", labelIds: ["SENT"], internalDate: sentAt.getTime(), payload: {
    mimeType: "text/plain", headers: [
      ["From", `Gmail sender <${email}>`], ["To", oldAddress], ["Subject", "Gmail synthetic"], ["Date", sentAt.toUTCString()],
      ["Message-ID", originalId], ["Content-Type", "text/plain"],
    ].map(([name, value]) => ({ name, value })), body: { data: q("Local Sent bytes"), size: 16 },
  } };
  const receipt = { id: "ginbox", labelIds: ["INBOX"], internalDate: receivedAt.getTime(), payload: {
    mimeType: "multipart/report", headers: [
      ["From", "postmaster@example.test"], ["To", email], ["Date", receivedAt.toUTCString()],
      ["Message-ID", "<dsn.888@example.test>"], ["Content-Type", 'multipart/report; report-type=delivery-status; boundary="dsn-888"'],
    ].map(([name, value]) => ({ name, value })), parts: [
      { partId: "0", mimeType: "text/plain", body: { data: q("Rendered failure"), size: 16 } },
      { partId: "1", mimeType: "message/delivery-status", body: { size: 148, attachmentId: "status" } },
      { partId: "2", mimeType: "message/rfc822", body: { size: 220, attachmentId: "returned" } },
    ],
  } };
  let rawReads = 0;
  const session = createSession(db.accountById(id), "", { api: { async raw(providerId) {
    assert.equal(providerId, receipt.id);
    rawReads++;
    return { id: providerId, source: report({ to: email, returnedType: "message/rfc822" }) };
  } } });
  const sent = await session.adopt(original);
  const incoming = await session.adopt(receipt);
  assert.equal(rawReads, 1);
  assert.equal(db.gmailCopies(id, original.id).length, 2, "Sent and All Mail label copies are the same Gmail identity");
  const row = db.messageByUid(id, "INBOX", incoming.uid, incoming.validity);
  assert.equal((await ipc("mail:openEmail", target(row))).data.email.dsnRedraftAvailable, true);
  const preview = review(row).data;
  assert.equal(preview.body, "Local Sent bytes");
  assert.equal(preview.fromAddress, email);
  db.rememberGmail(id, { providerId: original.id, labelIds: [] });
  assert.equal(save(row, preview.review).error.code, "dsn_manual", "removed Gmail Sent membership invalidates an open review");
  db.rememberGmail(id, { providerId: original.id, labelIds: ["SENT"] });
  assert.equal(db.messageByUid(id, "Sent", sent.uid, sent.validity).gmail_id, original.id);
  const saved = save(row, preview.review).data;
  assert.equal(db.messageById(saved.draftId).text_body, "Local Sent bytes");
  assert.equal(db.countInFolder(id, "Drafts"), 1);
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
