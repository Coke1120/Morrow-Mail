"use strict";
// Isolated Electron integration: real Reader/Compose windows, synthetic mail, local SQLite.
const { app, BrowserWindow, ipcMain, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createReaderHost, CHANNELS: readerChannels } = require("../host/reader-window");
const { createComposeHost, CHANNELS: composeChannels } = require("../host/compose-window");
const { readerChecklist } = require("../host/mail/reader-checklist");
const db = require("../host/mail/db");
const root = path.resolve(__dirname, ".."), htmlFile = path.join(root, "renderer/index.html");
const preloadFile = path.join(root, "renderer/preload.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-reader-checklist-ui-"));
const file = path.join(temp, "mail.sqlite");
app.setPath("userData", temp);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const accounts = ["office", "home"].map(id => ({ id, bodyEpoch: 0, email: id + "@example.invalid",
  platform: "imap", imapSmtpProfile: "custom", folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }], more: [] } }));
const sentence = "Return the key.";
const date = "2026-11-27T01:00:00.000Z";
const messages = accounts.map(account => ({ id: account.id + "-mail", accountId: account.id, bodyEpoch: 0,
  folderId: "INBOX", threadId: "same-thread", messageId: "<shared@example.invalid>", subject: "Same subject",
  from: "Sender <sender@example.invalid>", to: [account.email], date, bodyComplete: true,
  textBody: "Collect the parcel.\n" + sentence + "\n" + sentence,
  htmlBody: "<p>Collect the parcel.</p><p>" + sentence + "</p><p>" + sentence + "</p>" }));
const requests = [], network = [];
const ok = data => ({ success: true, data });
const run = (win, code) => win.webContents.executeJavaScript(code, true);
async function until(win, code, label) {
  for (let i = 0; i < 160; i++) {
    try { if (await run(win, code)) return; } catch { /* loading */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Timed out: " + label);
}
const samplePrefs = { "config:getTheme": "light", "morrow:configGetAccent": "#193C34",
  "morrow:configGetComposeQuoteWidth": 420, "morrow:configGetConversationViewEnabled": true };
function value(channel, args) {
  if (Object.hasOwn(samplePrefs, channel)) return samplePrefs[channel];
  if (channel === "app:getVersion") return "1.0.0";
  if (channel === "mail:listAccounts") return ok(accounts);
  if (channel === "mail:openEmail") return ok({ email: messages.find(row => row.id === args.emailId) });
  if (channel === "mail:listSignatures") return ok({ signatures: [], defaultSignaturePerAccount: {} });
  if (channel === "mail:getComposeContext") {
    const email = accounts.find(account => account.id === args.accountId).email;
    return ok({ fromAddress: email, sendAs: [{ email }], selfAddresses: [email], defaultCc: [], defaultBcc: [],
      settings: { ccByDomain: {}, bccByDomain: {}, accounts: {} }, domain: "example.invalid" });
  }
  if (channel === "mail:listSnoozed") return ok({ records: [] });
  return ok([]);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] },
    (request, reply) => { network.push(request.url); reply({ cancel: true }); });
  await db.open(file);
  for (const { id, email } of accounts) {
    db.insertAccount({ id, email, username: email, profile: "custom", createdAt: Date.parse(date),
      imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.example.invalid", smtpPort: 465, smtpTls: true });
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    const fixture = messages.find(row => row.accountId === id);
    db.insertMessage({ ...fixture, folderPath: fixture.folderId, uid: 23, uidValidity: 7,
      rfcMessageId: fixture.messageId, listSortTs: Date.parse(date) });
  }
  const options = { htmlFile, preloadFile, mode: "bundled" };
  const reader = createReaderHost({ ...options,
    privateChecklist: (source, params) => readerChecklist(db, source, params, () => 0) });
  const compose = createComposeHost(options);
  reader.register();
  compose.register();
  ipcMain.handle("reader:privateChecklist", reader.privateChecklist);
  const claimed = new Set([...readerChannels, ...composeChannels, "reader:privateChecklist", "reader:setTitle"]);
  ipcMain.handle("reader:setTitle", () => true);
  const preload = fs.readFileSync(preloadFile, "utf8");
  for (const channel of new Set([...preload.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)].map(match => match[1]))) {
    if (claimed.has(channel)) continue;
    ipcMain.handle(channel, (event, params) => {
      requests.push(channel);
      const observe = channel === "mail:openEmail" ? reader.observeOpen(event, params) : null;
      const reply = value(channel, params);
      if (observe) observe(reply);
      return reply;
    });
  }
  const open = async mail => {
    const { id } = reader.open({ accountId: mail.accountId, messageId: mail.id });
    const win = reader.records.get(id).win;
    await until(win, `document.querySelector("#reader .body")?.textContent.includes(${JSON.stringify(sentence)})`, "Reader body");
    return win;
  };
  const original = messages[0], first = await open(original);
  const checklist = ".reader-checklist";
  await run(first, `(() => {
    const body = document.querySelector("#reader .body");
    const range = document.createRange();
    range.selectNodeContents(body.querySelectorAll("p")[1]);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 55, clientY: 65 }));
    Array.from(document.querySelectorAll("button[role=menuitem]"))
      .find(button => button.textContent === "Add selection to private checklist").click();
  })()`);
  await until(first, `document.querySelector("${checklist} input")`, "private selection added");
  assert.equal(await run(first, `document.querySelectorAll("#reader .body .reader-checklist").length`), 0, "no marks inside message body");
  await run(first, `document.querySelector("${checklist} input").click()`);
  await until(first, `document.querySelector("${checklist} [role=status]").textContent.includes("1 of 1 done")`, "completed");
  first.destroy();
  await db.close();
  await db.open(file);
  const reopened = await open(original);
  await until(reopened, `document.querySelector("${checklist} input")?.checked`, "persisted across database close/reopen");
  const lookalike = await open(messages[1]);
  assert.equal(await run(lookalike, `document.querySelector("${checklist}").hidden`), true);
  assert.equal(await run(lookalike, `api.invoke("reader:privateChecklist", {action:"list", accountId:"office", messageId:"office-mail", bodyEpoch:0}).then(result => result.ok)`), false);
  lookalike.destroy();
  await run(reopened, `document.querySelector('[data-action="plain-body"]').click(); document.querySelector("${checklist} input").click()`);
  await until(reopened, `document.querySelector("${checklist} [role=status]").textContent.includes("0 of 1 done")`, "unchecked after switching body presentation");
  const created = compose.open({ accountId: original.accountId, kind: "reply", title: "Reply fixture",
    to: original.from, subject: "Re: Same subject", body: "I can help.", quoteEmail: original,
    sourceMessageId: original.id, threadId: original.threadId });
  const draft = compose.records.get(created.id).win;
  await until(draft, `$("compose").open && !state.composeInitializing`, "Compose initialization");
  await run(draft, `$("compose-send").click()`);
  await until(draft, `$("compose-preview").open`, "Preview Send");
  assert.doesNotMatch(await run(draft, `$("compose").textContent + $("compose-preview-body").textContent + JSON.stringify(composePayload(composeAccount()))`),
    /Private checklist|of 1 done|reader-checklist/i);
  assert.equal(await run(draft, `api.invoke("reader:privateChecklist", {action:"list", accountId:"office", messageId:"office-mail", bodyEpoch:0}).then(result => result.ok)`), false);
  assert.deepEqual(requests.filter(channel => ["mail:send", "mail:scheduleSend", "mail:markRead", "mail:summarizeEmail",
    "host:aiTest", "aiDraftWrite:start"].includes(channel) || /^nativeAgent:.*(triage|chat|run)$/i.test(channel)), []);
  assert.deepEqual(network, []);
  console.log("reader-private-checklist-electron-ok:", process.platform, "selection, persistence, presentation and mailbox scope, no Compose/Send marks or outbound requests");
}).then(async () => {
  await db.close();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
