// Compose opens in its own window. The mail shell stays usable.
// xvfb-run -a npx electron --no-sandbox scripts/check-compose-window.js [--editing | --draft-window-labels | --find-replace | --translation-selection]
const { app, BrowserWindow, ipcMain, screen, Menu, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const composeWindows = require("../host/compose-window");

const root = path.join(__dirname, "..");
const outDir = process.env.MORROW_SHOT_DIR || "/opt/cursor/artifacts";
const preloadFile = path.join(root, "renderer", "preload.js");
const htmlFile = path.join(root, "renderer", "index.html");

const message = {
  id: "msg-engine",
  accountId: "acct-ada",
  folderId: "inbox",
  threadId: "thread-engine",
  messageId: "<engine@analytical.example>",
  from: "Charles Babbage <charles.babbage@example.com>",
  to: ["Ada Lovelace <ada.lovelace@example.com>", "Grace Hopper <grace@example.com>"],
  cc: ["Mary Somerville <mary@example.com>"],
  subject: "Notes on the Analytical Engine",
  date: "2026-10-12T15:04:00.000Z",
  unread: false,
  snippet: "The table of operations is ready for a second reading.",
  textBody: "The table of operations is ready for a second reading.",
  htmlBody: "<p>The table of operations is ready for a second reading.</p>",
  attachments: [],
  bodyEpoch: 0,
  bodyComplete: true,
};

const earlierMessage = { ...message, id: "msg-earlier", date: "2026-10-11T15:04:00.000Z",
  from: "Mary Somerville <mary@example.com>",
  textBody: "Earlier conversation: preserve the original table.\n" + "Long synthetic history for scrolling.\n".repeat(100),
  htmlBody: "<p>Earlier conversation: preserve the original table.</p>" + "<p>Long synthetic history for scrolling.</p>".repeat(100) };

const account = {
  id: "acct-ada",
  email: "ada.lovelace@example.com",
  name: "Ada Lovelace",
  platform: "imap",
  imapSmtpProfile: "custom",
  folders: {
    primary: [
      { id: "inbox", name: "Inbox", wellKnownName: "inbox", chip: true },
      { id: "sent", name: "Sent", wellKnownName: "sent", chip: true },
      { id: "drafts", name: "Drafts", wellKnownName: "drafts", chip: true },
    ],
    more: [],
  },
};

const labelDrafts = [1, 2].map(index => ({
  id: "label-draft-" + index,
  accountId: account.id,
  isDraft: true,
  bodyComplete: true,
  fromAddress: account.email,
  to: ["fixture-buyer-" + index + "@example.invalid"],
  subject: "Identical saved subject",
  textBody: "Private fixture text " + index,
  attachments: [],
}));

const composeContext = {
  fromAddress: "ada.lovelace@example.com",
  sendAs: [{ email: "ada.lovelace@example.com", source: "account" }],
  selfAddresses: ["ada.lovelace@example.com"],
  domain: "example.com",
  policyDomain: "example.com",
  defaultCc: [],
  defaultBcc: [],
  receivedAddress: "ada.lovelace@example.com",
  fallback: false,
  settings: { ccByDomain: {}, bccByDomain: {}, accounts: {} },
};

const sentChannels = [];
const sentPayloads = [];
let savedDraft = null;

function envelope(data) {
  return { success: true, data };
}

function answer(channel, payload) {
  sentChannels.push(channel);
  sentPayloads.push({ channel, payload });
  if (channel === "app:getVersion") return "0.2.23-test";
  if (channel === "host:updateGetState" || channel === "host:updateCheck" || channel === "host:updateInstall" || channel === "host:updateManual") return { enabled: false };
  if (channel === "config:getTheme" || channel === "config:setTheme") return "light";
  if (channel === "morrow:configGetAccent" || channel === "morrow:configSetAccent") return "#193C34";
  if (channel === "morrow:configGetUndoSendDelaySeconds" || channel === "morrow:configSetUndoSendDelaySeconds") return 30;
  if (channel === "morrow:configGetComposeQuoteWidth" || channel === "morrow:configSetComposeQuoteWidth") return 420;
  if (channel === "morrow:configGetLayoutPanes" || channel === "morrow:configSetLayoutPanes") return { folders: 260, list: 360, reading: 0 };
  if (channel === "morrow:configGetSyncHorizonDays" || channel === "morrow:configSetSyncHorizonDays") return 180;
  if (channel === "morrow:configGetDefaultScheduleDelayMinutes" || channel === "morrow:configSetDefaultScheduleDelayMinutes") return 0;
  if (channel === "morrow:configGetSidebarCollapsedFolders" || channel === "morrow:configSetSidebarCollapsedFolders") return {};
  if (channel.includes("configGet") || channel.startsWith("config:get")) return false;
  if (channel.includes("configSet") || channel.startsWith("config:set")) return true;
  if (channel.startsWith("host:") || channel.startsWith("app:")) return null;
  return envelope(mailData(channel, payload));
}

function mailData(channel, payload) {
  if (channel === "mail:listAccounts") return [account];
  if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") return { emails: [message], total: 1, initialSyncDone: true };
  if (channel === "mail:openEmail") {
    if (savedDraft && payload?.emailId === savedDraft.id) return { email: savedDraft };
    const labelDraft = labelDrafts.find(draft => draft.id === payload?.emailId);
    if (labelDraft) return { email: labelDraft };
    return { email: message, threadMessages: [message] };
  }
  if (channel === "mail:listThreadMessages") return [earlierMessage, message].map(({ textBody, htmlBody, ...row }) => ({ ...row, hasBody: true }));
  if (channel === "mail:readCachedBody") return { email: payload.emailId === earlierMessage.id ? earlierMessage : message };
  if (channel === "mail:getComposeContext") return composeContext;
  if (channel === "mail:listSignatures") return { signatures: [], defaultSignatureId: null, defaultSignaturePerAccount: {} };
  if (channel === "mail:listScheduled" || channel === "mail:listImapSmtpPresets") return [];
  if (channel === "mail:listSnoozed") return { records: [] };
  if (channel === "mail:oauthStatus") return { google: false };
  if (channel === "mail:listProviderFolders") return { api: false, folders: [], reason: "profile" };
  if (channel === "mail:getSyncStatus") return { state: "idle" };
  if (channel === "mail:uploadAttachment") {
    const bytes = payload && payload.fileBytes;
    const size = bytes && (bytes.byteLength || bytes.length) ? (bytes.byteLength || bytes.length) : 5;
    return {
      storageUrl: "local:note",
      filename: (payload && payload.filename) || "note.txt",
      size,
      mimeType: (payload && payload.mimeType) || "text/plain",
    };
  }
  if (channel === "mail:upsertDraft") {
    savedDraft = { id: "draft-1", isDraft: true, bodyComplete: true, ...payload,
      htmlBody: payload.body, textBody: "Format fixture", attachments: [] };
    return { emailId: savedDraft.id, remoteSaved: true };
  }
  if (channel === "mail:send" || channel === "mail:scheduleSend") return { ok: true };
  if (channel === "aiDraftWrite:replySuggestions") return { suggestions: [] };
  if (channel === "aiDraftWrite:start") return { reqId: payload && payload.reqId };
  if (channel === "aiDraftWrite:cancel") return true;
  return {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label, ready = () => true) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 15000) {
    if (win.isDestroyed()) throw new Error(label + " window closed");
    try {
      last = await win.webContents.executeJavaScript(expression, true);
      if (last && ready()) return last;
    } catch (error) {
      last = String(error.message || error);
    }
    await sleep(50);
  }
  throw new Error(label + " timed out: " + JSON.stringify(last));
}

function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}

function composeWindowsOpen() {
  return liveWindows().filter((win) => {
    const url = win.webContents.getURL();
    return url.includes("role=compose");
  });
}

async function shot(win, name) {
  fs.mkdirSync(outDir, { recursive: true });
  await sleep(200);
  const file = path.join(outDir, name + ".png");
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}

// A renderer can disappear before executeJavaScript returns its acknowledgement.
function whenClosed(win) {
  return new Promise(resolve => win.once("closed", () => resolve(false)));
}

async function closeClean(win) {
  if (win.isDestroyed()) return;
  const closed = whenClosed(win);
  win.close();
  const start = Date.now();
  while (!win.isDestroyed() && Date.now() - start < 8000) {
    const review = await Promise.race([closed, win.webContents.executeJavaScript(`!!document.getElementById("compose-close-review")?.open`, true).catch(() => false)]);
    if (review) await Promise.race([closed, win.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true)]);
    await sleep(40);
  }
  if (!win.isDestroyed()) throw new Error("compose window stayed open");
  await closed;
}

function assertNativeFit(win, opener) {
  const area = screen.getDisplayMatching(opener.getBounds()).workArea;
  const bounds = win.getBounds();
  assert.ok(bounds.width <= 1200 && bounds.height <= 900);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y, "compose starts on the opener's display");
  assert.ok(bounds.x + bounds.width <= area.x + area.width + 1);
  assert.ok(bounds.y + bounds.height <= area.y + area.height + 1);
}

async function assertComposeGeometry(win) {
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById("compose-editor");
    const draft = document.querySelector(".compose-draft");
    const split = document.getElementById("compose-split"), form = document.getElementById("compose-form"), formStyle = getComputedStyle(form);
    const margins = node => { const s = getComputedStyle(node); return parseFloat(s.marginTop) + parseFloat(s.marginBottom); };
    const fixed = [...form.children].filter(node => node !== split && getComputedStyle(node).display !== "none")
      .reduce((height, node) => height + node.getBoundingClientRect().height + margins(node), 0);
    return {
      availableSplit: form.clientHeight - parseFloat(formStyle.paddingTop) - parseFloat(formStyle.paddingBottom) - fixed - margins(split),
      height: innerHeight, width: innerWidth, editorHeight: editor.clientHeight,
      editorScroll: editor.scrollHeight, draftHeight: draft.clientHeight,
      splitHeight: document.getElementById("compose-split").clientHeight,
      actions: ["compose-send", "compose-save", "compose-close"].map(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { id, top: rect.top, bottom: rect.bottom };
      }),
    };
  })()`, true);
  assert.ok(geometry.editorHeight >= 178, "Message retains its usable minimum");
  assert.ok(geometry.editorScroll > geometry.editorHeight, "long Message scrolls internally");
  assert.ok(Math.abs(geometry.splitHeight - geometry.availableSplit) <= 2, "split fills remaining height");
  for (const action of geometry.actions) {
    assert.ok(action.top >= 0 && action.bottom <= geometry.height + 1, action.id + " stays visible");
  }
  return geometry;
}

async function assertComposeFormatting(win) {
  const contents = win.webContents;
  await contents.executeJavaScript(`(() => {
    const editor = document.getElementById("compose-editor");
    editor.focus();
    placeComposeCaret(editor);
    const data = new DataTransfer();
    data.setData("text/html", '<b><span style="font-size:20px">Format fixture</span></b><img src="https://example.invalid/no-download">');
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  const body = 'composePayload(composeAccount()).body';
  const plain = 'document.getElementById("compose-body").value';
  const pasted = await contents.executeJavaScript(body);
  assert.match(pasted, /font-size: 20px/);
  assert.doesNotMatch(pasted, /example\.invalid/);
  assert.match(await contents.executeJavaScript(plain), /Format fixture/);
  contents.undo();
  await waitFor(win, `!${plain}.includes("Format fixture")`, "undo paste syncs plain draft");
  assert.match(await contents.executeJavaScript(body), /Earlier conversation: preserve the original table/);
  contents.redo();
  await waitFor(win, `${plain}.includes("Format fixture")`, "redo paste syncs plain draft");
  assert.match(await contents.executeJavaScript(body), /font-size: 20px/, "redo paste restores HTML style");

  const selectFixture = `(() => {
    const editor = document.getElementById("compose-editor");
    editor.focus();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.data !== "Format fixture") continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return true;
    }
    return false;
  })()`;
  assert.equal(await contents.executeJavaScript(selectFixture), true);
  const stepSize = direction => contents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-font-step="${direction}"]');
    button.focus();
    button.click();
    return { selected: getSelection().toString(), focus: document.activeElement.id,
      rendered: getComputedStyle(getSelection().anchorNode.parentElement).fontSize };
  })()`);
  const sized = rendered => ({ selected: "Format fixture", focus: "compose-editor", rendered });
  assert.deepEqual(await stepSize(1), sized("24px"));
  assert.match(await contents.executeJavaScript(body), /size="5"|font-size: x-large/);
  assert.deepEqual(await stepSize(-1), sized("18px"));
  assert.deepEqual(await stepSize(-1), sized("16px"));
  contents.undo();
  await waitFor(win, `/size="4"|font-size: large/.test(${body})`, "undo one size step");
  contents.undo();
  await waitFor(win, `/size="5"|font-size: x-large/.test(${body})`, "undo next size step");

  await contents.executeJavaScript(`document.getElementById("compose-text-color").click()`);
  assert.equal(await contents.executeJavaScript(`document.querySelector('#compose-color-palette [value="currentcolor"]').getAttribute("aria-pressed")`), "true");
  await contents.executeJavaScript(`document.querySelector('#compose-color-palette [value="#2867bd"]').click()`);
  const formatted = await contents.executeJavaScript(body);
  assert.match(formatted, /color="#2867bd"|color: rgb\(40, 103, 189\)/);
  assert.match(formatted, /size="5"|font-size: x-large/);
  assert.equal(await contents.executeJavaScript(`document.activeElement.id`), "compose-editor");
  contents.undo();
  await waitFor(win, `!${body}.includes("rgb(40, 103, 189)")`, "undo preset preserves size");
  assert.match(await contents.executeJavaScript(body), /size="5"|font-size: x-large/);
  contents.redo();
  await waitFor(win, `${body}.includes("rgb(40, 103, 189)")`, "redo preset reapplies color");

  await contents.executeJavaScript(`document.getElementById("compose-text-color").click()`);
  assert.equal(await contents.executeJavaScript(`document.querySelector('#compose-color-palette [value="#2867bd"]').getAttribute("aria-pressed")`), "true");
  await contents.executeJavaScript(`document.querySelector('#compose-color-palette [value="currentcolor"]').click()`);
  assert.doesNotMatch(await contents.executeJavaScript(body), /rgb\(40, 103, 189\)/);
  assert.match(await contents.executeJavaScript(body), /size="5"|font-size: x-large/);
  contents.undo();
  await waitFor(win, `${body}.includes("rgb(40, 103, 189)")`, "undo default restores color");
}

async function checkDraftWindowLabels(host, opener) {
  const generic = "Resume draft — Morrow Mail";
  const field = 'document.getElementById("compose-window-label")';
  const hidden = 'document.getElementById("compose-window-label-control").hidden';
  const run = (win, expression) => win.webContents.executeJavaScript(expression);
  const expectTitle = (win, title) => waitFor(win, 'document.title === ' + JSON.stringify(title),
    "matching DOM and native window title", () => win.getTitle() === title);
  const openDraft = async ({ id, accountId }, extra) => {
    const existing = new Set(host.records.keys());
    await run(opener, `resumeDraft(${JSON.stringify({ id, accountId })}, ${JSON.stringify(extra)})`);
    const record = [...host.records.values()].find(record => !existing.has(record.win.webContents.id));
    assert.ok(record, "resumeDraft opens a native window");
    await waitFor(record.win, '!state.composeInitializing && document.getElementById("compose").open', "resumed draft ready");
    await expectTitle(record.win, generic);
    assert.equal(await run(record.win, field + ".value"), "");
    assert.equal(await run(record.win, hidden), !!extra);
    return record.win;
  };
  const typeLabel = (win, label) => run(win, `(() => {
    const input = ${field};
    input.value = ${JSON.stringify(label)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);

  const approval = await openDraft(labelDrafts[0]);
  const other = await openDraft(labelDrafts[1]);
  const snapshot = await run(approval, "composeSnapshot()");
  assert.equal(await typeLabel(approval, "Ap\u202epro\u0007val"), "Approval");
  const approvalTitle = "Approval — " + generic;
  await expectTitle(approval, approvalTitle);
  assert.equal(await run(approval, "composeSnapshot()"), snapshot, "label changes leave draft content and dirty state alone");
  await expectTitle(other, generic);
  const otherLabel = "<b>Review</b>".repeat(4).slice(0, 32);
  assert.equal(await typeLabel(other, "<b>Review</b>".repeat(4)), otherLabel);
  await expectTitle(other, otherLabel + " — " + generic);
  await run(other, 'writeComposeBody("Unsaved fixture edit")');
  await expectTitle(other, otherLabel + " — " + generic);
  const selected = [other, approval].find(win => win.getTitle() === approvalTitle);
  assert.equal(await run(selected, '$("compose-to").value'), labelDrafts[0].to[0]);

  for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true }]) {
    const key = JSON.stringify({ key: "Enter", bubbles: true, cancelable: true, ...modifiers });
    assert.equal(await run(approval, field + '.dispatchEvent(new KeyboardEvent("keydown", ' + key + '))'), false);
    assert.equal(await run(approval, '$("compose-preview").open'), false, "Enter in the label never previews send");
  }
  await typeLabel(approval, "");
  await expectTitle(approval, generic);
  await typeLabel(approval, "Approval");
  await expectTitle(approval, approvalTitle);
  assert.equal(await run(approval, "requestComposeClose()"), true, "label alone does not prompt to discard");
  await expectTitle(approval, generic);
  assert.equal(await run(approval, field + ".value"), "");
  assert.equal(await run(approval, hidden), true);
  await closeClean(approval);
  await closeClean(await openDraft(labelDrafts[0]));
  await closeClean(await openDraft(labelDrafts[0], { status: "Recovered fixture" }));

  assert.equal(await run(other, "scheduleMail(new Date(Date.now() + 3600000))"), true);
  await expectTitle(other, "Scheduled receipt — Morrow Mail");
  assert.equal(await run(other, hidden), true);
  assert.equal(await run(other, field + ".value"), "");
  await closeClean(other);
}

async function checkEditing(host) {
  app.on("window-all-closed", () => {});
  const { id } = host.open({ title: "Editing smoke", kind: "reply", quoteEmail: message,
    accountId: account.id, to: message.from, subject: "Re: " + message.subject,
    sourceMessageId: message.id, threadId: message.threadId });
  const win = host.records.get(id).win;
  const ready = '!state.composeInitializing && document.getElementById("compose").open';
  await waitFor(win, ready, "editing compose ready");
  await assertComposeFormatting(win);
  await win.webContents.executeJavaScript(`document.getElementById("compose-save").click()`);
  await waitFor(win, `document.getElementById("compose-status").textContent.includes("Draft saved.")`, "saved formatted draft");
  assert.match(savedDraft.htmlBody, /size="5"|font-size: x-large/);
  assert.match(savedDraft.htmlBody, /color="#2867bd"|color: rgb\(40, 103, 189\)/);
  await win.webContents.executeJavaScript(`resumeDraft({ id: "draft-1", accountId: "acct-ada" })`);
  const reopened = [...host.records.values()].find(record => record.win !== win)?.win;
  assert.ok(reopened, "saved draft opens a new Compose window");
  await waitFor(reopened, ready, "reopened formatted draft");
  await closeClean(win);
  const html = await reopened.webContents.executeJavaScript(`composePayload(composeAccount()).body`);
  assert.match(html, /size="5"|font-size: x-large/);
  assert.match(html, /color="#2867bd"|color: rgb\(40, 103, 189\)/);
  await reopened.webContents.executeJavaScript(`document.getElementById("compose-send").click()`);
  await waitFor(reopened, `document.getElementById("compose-preview").open`, "formatted send preview");
  await reopened.webContents.executeJavaScript(`document.getElementById("compose-preview-confirm").click()`);
  const start = Date.now();
  while (!sentChannels.includes("mail:scheduleSend") && Date.now() - start < 5000) await sleep(50);
  const queued = sentPayloads.find(item => item.channel === "mail:scheduleSend");
  assert.equal(queued?.payload.outbox, true);
  assert.match(queued.payload.body, /size="5"|font-size: x-large/);
  assert.match(queued.payload.body, /color="#2867bd"|color: rgb\(40, 103, 189\)/);
  assert.equal(sentChannels.includes("mail:send"), false);
  console.log("compose-editing-ok: paste Undo/Redo and quote, font size steps, preset/default text color Undo/Redo, saved/reopened draft, simulated Outbox");
}

async function checkFindReplace(host, shell) {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Morrow Mail", submenu: [{ role: "hide" }] }]));
  }
  const { id } = host.open({ title: "Find fixture", kind: "new", accountId: account.id,
    to: "fixture@example.invalid", subject: "Case-01 in subject",
    body: "Case-01, Case-01", bodyHtml: "<p>Case-01, Case-01</p>" });
  const win = host.records.get(id).win;
  const ready = '!state.composeInitializing && $("compose").open';
  await waitFor(win, ready, "find compose ready");
  const run = js => win.webContents.executeJavaScript(js, true);
  const send = (target, keyCode, modifier = true) => {
    const modifiers = modifier ? [process.platform === "darwin" ? "meta" : "control"] : [];
    target.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    target.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  win.focus();
  await run(`(() => {
    $("compose-editor").innerHTML =
      '<p><b>Client Case-<i>01</i></b> plus <i>case-01 end</i></p>' +
      '<p>Case-0<br>1</p>' +
      '<div data-compose-signature="1"><b>Case-01 signature</b></div>' +
      '<blockquote data-compose-reply-quote="1"><i>Case-01 quote</i></blockquote>';
    syncComposePlainFromEditor();
    $("compose-editor").focus();
  })()`);
  send(win, "F");
  await waitFor(win, `!$("compose-find-panel").hidden && document.activeElement === $("compose-find-query")`, "native Find shortcut");
  assert.equal(await run(`$("compose-find-replace-row").hidden`), true);
  const search = value => run(`(() => {
    $("compose-find-query").value = ${JSON.stringify(value)};
    $("compose-find-query").dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await search("absent");
  assert.match(await run(`$("compose-find-status").textContent`), /No matches/);
  await search("CASE-01");
  assert.equal(await run(`$("compose-find-status").textContent`), "1 of 2");
  await run(`$("compose-find-next").click()`);
  assert.equal(await run(`$("compose-find-status").textContent`), "2 of 2");
  await run(`$("compose-find-previous").click()`);
  send(win, "H");
  await waitFor(win, `!$("compose-find-replace-row").hidden`, "native Replace shortcut with active app menu");
  const before = await run(`$("compose-editor").innerHTML`);
  await run(`$("compose-find-replacement").value = "$& <Ref>"; $("compose-find-replace-all").click()`);
  const editor = await run(`$("compose-editor").innerHTML`);
  assert.match(editor, /<b>Client \$&amp; &lt;Ref&gt;/);
  assert.match(editor, /<i>\$&amp; &lt;Ref&gt; end<\/i>/);
  assert.match(editor, /<b>Case-01 signature<\/b>/);
  assert.match(editor, /data-compose-reply-quote="1"><i>Case-01 quote<\/i>/);
  assert.match(editor, /Case-0<br>1/);
  assert.equal(await run(`$("compose-subject").value`), "Case-01 in subject");
  win.webContents.undo();
  await waitFor(win, `$("compose-editor").innerHTML === ${JSON.stringify(before)}`, "Undo restores both replacements in one step");
  win.webContents.redo();
  await waitFor(win, `$("compose-editor").innerHTML === ${JSON.stringify(editor)}`, "Redo restores both replacements");
  await search("$& <Ref>");
  await run(`$("compose-find-replacement").value = "$& <Ref> updated"; $("compose-find-replace-next").click()`);
  assert.equal(await run(`$("compose-find-status").textContent`), "Replaced 1. 2 of 2",
    "Replace Next advances past its own newly inserted match");
  win.webContents.undo();
  await waitFor(win, `$("compose-editor").innerHTML === ${JSON.stringify(editor)}`, "Undo single replacement");
  await search("$& <Ref>");
  await run(`$("compose-find-replacement").value = ""; $("compose-find-replace-next").click()`);
  assert.equal(await run(`$("compose-editor").textContent.split("$& <Ref>").length - 1`), 1);
  assert.match(await run(`$("compose-find-status").textContent`), /Replaced 1/);
  send(win, "Escape", false);
  await waitFor(win, `$("compose-find-panel").hidden && $("compose").open`, "Escape closes only Find");
  await run(`$("compose-save").click()`);
  await waitFor(win, `$("compose-status").textContent.includes("Draft saved.")`, "replacement draft saved");
  assert.match(savedDraft.htmlBody, /\$&amp; &lt;Ref&gt;/);
  await run(`resumeDraft({ id: "draft-1", accountId: "acct-ada" })`);
  const reopened = [...host.records.values()].find(record => record.win !== win)?.win;
  assert.ok(reopened);
  await waitFor(reopened, ready, "replacement draft reopened");
  const reopenedBody = await reopened.webContents.executeJavaScript(`composePayload(composeAccount()).body`);
  assert.match(reopenedBody, /\$&amp; &lt;Ref&gt;/);
  assert.equal(await reopened.webContents.executeJavaScript(`$("compose-find-panel").hidden && $("compose-find-query").value === ""`), true);
  await reopened.webContents.executeJavaScript(`(() => {
    $("compose-editor").innerHTML = "<p>Only text</p>";
    $("compose-find-open").click();
    $("compose-find-query").value = "Only text";
    $("compose-find-query").dispatchEvent(new Event("input", { bubbles: true }));
    $("compose-find-replace-all").click();
  })()`);
  assert.equal(await reopened.webContents.executeJavaScript(`$("compose-editor").textContent`), "");
  reopened.webContents.undo();
  await waitFor(reopened, `$("compose-editor").innerHTML === "<p>Only text</p>"`, "Undo removal of the entire body");

  shell.focus();
  send(shell, "F");
  await sleep(100);
  assert.equal(await shell.webContents.executeJavaScript(`$("compose-find-panel").hidden`), true);
  await shell.webContents.executeJavaScript(`paintShortcuts(); paintFeatureCatalog()`);
  assert.match(await shell.webContents.executeJavaScript(`$("shortcuts-list").textContent`), /Find and replace text in the message body/);
  assert.match(await shell.webContents.executeJavaScript(`$("features-catalog").textContent`), /Find and replace in Compose/);
  assert.equal(sentChannels.some(channel => channel === "mail:send" || channel === "mail:scheduleSend"), false);
  console.log("compose-find-replace-ok:", process.platform, "keyboard entry, scope, formatting, one-step undo/redo, save/reopen and rendered help");
}

const translationFixture = { calls: [], menus: [], connection: "fixture-connection", network: [] };
const translationService = require("../host/compose-translation").createComposeTranslation({
  status: () => ({ token: translationFixture.connection, ready: true, label: "Synthetic saved endpoint",
    destination: "https://synthetic.invalid/v1/chat/completions", model: "fixture-model" }),
  complete: (messages, options) => new Promise(resolve => translationFixture.calls.push({ messages, options, resolve })),
});

async function checkSelectionTranslation(host, shell) {
  const seed = { kind: "new", accountId: account.id, to: "recipient@example.invalid", subject: "Private subject", body: "Fresh draft" };
  const { id } = host.open(seed);
  const win = host.records.get(id).win;
  const run = code => win.webContents.executeJavaScript(code, true);
  await waitFor(win, '!state.composeInitializing && $("compose").open', "fresh Compose ready");
  const editorMarkup = '<p><i>Private prefix.</i> <b>Enter at 17:30 with ref AB-0146; budget USD 85.00.</b> <u>Private suffix.</u></p>' +
    '<blockquote data-compose-reply-quote="1"><b>Private quote.</b></blockquote>' +
    '<div data-compose-signature="1"><b>Private signature.</b></div>';
  const passage = "Enter at 17:30 with ref AB-0146; budget USD 85.00.";
  await run(`$("compose-editor").innerHTML = ${JSON.stringify(editorMarkup)}; syncComposePlainFromEditor()`);
  const select = selector => run(`(() => {
    const editor = $("compose-editor");
    editor.focus(); const node = editor.querySelector(${JSON.stringify(selector)}).firstChild;
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  })()`);
  const menu = async () => {
    const before = translationFixture.menus.length, contents = win.webContents;
    contents.emit("context-menu", { preventDefault() {} }, { frame: contents.mainFrame, isEditable: true, menuSourceType: "keyboard", editFlags: { canCopy: true } });
    for (let i = 0; i < 40 && translationFixture.menus.length === before; i++) await sleep(20);
    return translationFixture.menus.at(-1)?.find(item => item.label === "Translate selection…");
  };
  for (const excluded of ["blockquote b", "[data-compose-signature] b"]) {
    await select(excluded);
    assert.equal(await menu(), undefined);
  }
  const open = async () => {
    await select("p b");
    const item = await menu();
    assert.ok(item, "native menu offers translation for authored text");
    await item.click();
    await waitFor(win, '$("compose-translation").open && !$("compose-translation-send").disabled', "review before request");
  };
  await open();
  assert.equal(await run('$("compose-translation-source").textContent'), passage);
  assert.match(await run('$("compose-translation-destination").textContent'), /https:\/\/synthetic\.invalid/);
  assert.equal(translationFixture.calls.length, 0);
  await run(`for (const [id, value] of [["source", "en"], ["target", "de"]]) {
    const choice = $("compose-translation-"+id+"-language"); choice.value = value; choice.dispatchEvent(new Event("change"));
  }`);
  await waitFor(win, '!$("compose-translation-send").disabled', "review English to German");
  await run('$("compose-translation-send").click()');
  for (let i = 0; i < 40 && !translationFixture.calls.length; i++) await sleep(20);
  const call = translationFixture.calls[0];
  assert.ok(call);
  assert.equal(call.messages[1].content, passage);
  assert.match(call.messages[0].content, /English into German/);
  assert.doesNotMatch(JSON.stringify(call.messages), /Private|recipient@example.invalid/);
  call.resolve("Kommen Sie bitte um 18:00.");
  await waitFor(win, '!$("compose-translation-replace").disabled', "translation review");
  assert.equal(await run('$("compose-editor").innerHTML'), editorMarkup);
  assert.deepEqual(await run('Array.from($("compose-translation-source").querySelectorAll("mark")).map(mark => mark.textContent)'),
    ["17:30", "AB-0146", "USD 85.00"]);
  const corrected = "Einlass um 17:30 mit Referenz AB-0146. Budget USD 85.00.";
  await run(`$("compose-translation-output").value = ${JSON.stringify(corrected)};
    $("compose-translation-output").dispatchEvent(new Event("input")); $("compose-translation-replace").click()`);
  await waitFor(win, '!$("compose-translation").open', "explicit replacement");
  const rich = await run('$("compose-editor").innerHTML');
  for (const retained of ["<i>Private prefix.</i>", "<u>Private suffix.</u>", "<b>Private quote.</b>", "<b>Private signature.</b>", "<b>"+corrected+"</b>"]) assert.ok(rich.includes(retained), rich);
  await run('$("compose-send").click()');
  await waitFor(win, '$("compose-preview").open', "Preview Send");
  assert.match(await run('$("compose-preview-body").textContent'), /Budget USD 85\.00/);
  await run('$("compose-preview-cancel").click()');
  await waitFor(win, '!$("compose-preview").open', "Preview Send closed");
  await run('$("compose-editor").focus()');
  win.webContents.undo();
  await waitFor(win, `$("compose-editor").innerHTML === ${JSON.stringify(editorMarkup)}`, "native Undo");

  const awaitProvider = async count => {
    for (let i = 0; i < 40 && translationFixture.calls.length < count; i++) await sleep(20);
    const next = translationFixture.calls[count - 1]; assert.ok(next); return next;
  };
  await open();
  await run('$("compose-translation-send").click()');
  const canceled = await awaitProvider(2);
  await run('$("compose-translation-cancel").click()');
  for (let i = 0; i < 40 && !canceled.options.signal.aborted; i++) await sleep(20);
  assert.equal(canceled.options.signal.aborted, true);
  canceled.resolve("A result that will not be applied.");
  assert.equal(await run('$("compose-editor").innerHTML'), editorMarkup);

  await open();
  await run('$("compose-translation-send").click()');
  const stale = await awaitProvider(3);
  await run('state.composeMeta.accountId = "not-the-reviewed-mailbox"');
  stale.resolve("A result from a stale review.");
  await waitFor(win, '$("compose-translation-status").textContent.includes("changed")', "stale account");
  assert.equal(await run('$("compose-editor").innerHTML'), editorMarkup);
  await run('state.composeMeta.accountId = "acct-ada"; $("compose-translation-cancel").click()');

  await open();
  await run('$("compose-translation-send").click()');
  const changed = await awaitProvider(4);
  changed.resolve(corrected);
  await waitFor(win, '!$("compose-translation-replace").disabled', "result before connection change");
  translationFixture.connection = "changed-provider";
  await run('$("compose-translation-replace").click()');
  await waitFor(win, '$("compose-translation-status").textContent.includes("changed")', "saved destination changed");
  assert.equal(await run('$("compose-editor").innerHTML'), editorMarkup);
  assert.equal(await shell.webContents.executeJavaScript(`api.invoke("compose:translateSelection", { action: "prepare", text: "not Compose", source:"en", target:"fr" }).then(result => result.ok)`), false);
  await shell.webContents.executeJavaScript("paintFeatureCatalog()");
  assert.match(await shell.webContents.executeJavaScript('$("features-catalog").textContent'), /Review a selected draft translation/);
  assert.equal(sentChannels.some(channel => channel === "mail:send" || channel === "mail:scheduleSend"), false);
  assert.deepEqual(translationFixture.network, []);
  console.log("compose-selection-translation-electron-ok:", process.platform, "reviewed scope, editable output, value hints, native Undo, stale guards, zero network or sends");
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(process.env.MORROW_SMOKE_TMP || os.tmpdir(), "morrow-compose-window-")));

const consoleNotes = [];

app.whenReady().then(async () => {
  const translationTest = process.argv.includes("--translation-selection");
  if (translationTest) {
    Menu.buildFromTemplate = items => ({ popup() { translationFixture.menus.push(items); } });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] },
      (request, done) => { translationFixture.network.push(request.url); done({ cancel: true }); });
  }
  let shellWin;
  const host = composeWindows.createComposeHost({
    getParent: () => shellWin,
    selectionTranslation: translationTest ? translationService : null,
    preloadFile: () => preloadFile,
    mode: () => "bundled",
    htmlFile,
    backgroundColor: "#e7f0e4",
  });
  host.register();
  const preload = fs.readFileSync(preloadFile, "utf8");
  const channels = new Set();
  for (const match of preload.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) channels.add(match[1]);
  for (const channel of channels) {
    if (composeWindows.CHANNELS.includes(channel)) continue;
    ipcMain.handle(channel, (_event, payload) => answer(channel, payload));
  }

  if (process.argv.includes("--editing")) {
    await checkEditing(host);
    app.exit(0);
    return;
  }
  shellWin = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    backgroundColor: "#e7f0e4",
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const watchConsole = (win) => {
    win.webContents.on("console-message", (_event, level, messageText) => {
      if (level >= 2) {
        consoleNotes.push(messageText);
        console.error("[console]", messageText);
      }
    });
  };
  watchConsole(shellWin);
  app.on("browser-window-created", (_event, win) => watchConsole(win));
  await shellWin.loadFile(htmlFile);
  await waitFor(shellWin, `state.accounts && state.accounts.length > 0 && !!state.accountId`, "accounts");
  const shellRole = await shellWin.webContents.executeJavaScript(`document.documentElement.dataset.window || ""`, true);
  assert.equal(shellRole, "");

  if (translationTest) {
    await checkSelectionTranslation(host, shellWin);
    app.exit(0);
    return;
  }
  if (process.argv.includes("--find-replace")) {
    await checkFindReplace(host, shellWin);
    app.exit(0);
    return;
  }
  if (process.argv.includes("--draft-window-labels")) {
    await checkDraftWindowLabels(host, shellWin);
    console.log("draft-window-labels-ok");
    app.exit(0);
    return;
  }

  await shellWin.webContents.executeJavaScript(`document.getElementById("compose-open").click()`, true);
  await waitFor(shellWin, `document.getElementById("compose").open !== true`, "shell compose stays closed");
  let opened = [];
  const started = Date.now();
  while (Date.now() - started < 15000) {
    opened = [];
    for (const win of composeWindowsOpen()) {
      const ready = await win.webContents.executeJavaScript(`document.documentElement.dataset.window === "compose" && document.getElementById("compose").open && document.getElementById("compose-title").textContent === "New message"`, true).catch(() => false);
      if (ready) opened.push(win);
    }
    if (opened.length === 1) break;
    await sleep(50);
  }
  assert.equal(opened.length, 1, "new mail opens one compose window");
  assertNativeFit(opened[0], shellWin);
  const shellShot = await shot(shellWin, "compose-window-shell");
  shellWin.focus();
  shellWin.webContents.focus();
  const active = await shellWin.webContents.executeJavaScript(`
    const input = document.getElementById("search-query");
    input.focus();
    document.activeElement && document.activeElement.id
  `, true);
  assert.equal(active, "search-query");
  const beforeSettings = liveWindows().length;
  await shellWin.webContents.executeJavaScript(`document.getElementById("settings-open").click()`, true);
  await waitFor(shellWin, `document.getElementById("settings").open === true`, "settings");
  assert.equal(liveWindows().length, beforeSettings, "settings stays in the mail window");
  await shellWin.webContents.executeJavaScript(`document.getElementById("settings-close").click()`, true);
  await waitFor(shellWin, `document.getElementById("settings").open !== true`, "settings closed");

  const firstId = opened[0].webContents.id;
  await shellWin.webContents.executeJavaScript(`document.getElementById("compose-open").click()`, true);
  let second = null;
  const secondStart = Date.now();
  while (Date.now() - secondStart < 15000) {
    for (const win of composeWindowsOpen()) {
      if (win.webContents.id === firstId) continue;
      const ready = await win.webContents.executeJavaScript(`document.getElementById("compose").open`, true).catch(() => false);
      if (ready) second = win;
    }
    if (second) break;
    await sleep(50);
  }
  assert.ok(second, "a second compose window opens");
  await closeClean(second);
  assert.equal(composeWindowsOpen().length, 1);

  const dirty = composeWindowsOpen()[0];
  dirty.focus();
  await waitFor(dirty, `state.composeInitializing === false && document.getElementById("compose").open === true`, "compose ready");
  await dirty.webContents.executeJavaScript(`
    const field = document.getElementById("compose-to");
    field.value = "grace@example.com";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  `, true);
  dirty.close();
  await waitFor(dirty, `document.getElementById("compose-close-review").open === true`, "dirty confirm");
  const discardShot = await shot(dirty, "compose-window-discard");
  await dirty.webContents.executeJavaScript(`document.getElementById("draft-close-keep").click()`, true);
  await sleep(200);
  assert.equal(dirty.isDestroyed(), false);
  const stillOpen = await dirty.webContents.executeJavaScript(`document.getElementById("compose").open === true`, true);
  assert.equal(stillOpen, true);
  dirty.close();
  await waitFor(dirty, `document.getElementById("compose-close-review").open === true`, "dirty confirm again");
  await Promise.race([whenClosed(dirty), dirty.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true)]);
  const gone = Date.now();
  while (!dirty.isDestroyed() && Date.now() - gone < 8000) await sleep(40);
  assert.equal(dirty.isDestroyed(), true);
  assert.equal(composeWindowsOpen().length, 0);

  await shellWin.webContents.executeJavaScript(`document.querySelector('[data-testid="mail-list-message-row"]').click()`, true);
  await waitFor(shellWin, `!!document.querySelector('#reader [data-action="reply-all"]')`, "reader reply actions");
  await shellWin.webContents.executeJavaScript(`document.querySelector('#reader [data-action="reply-all"]').click()`, true);
  let all = null;
  const allStart = Date.now();
  while (Date.now() - allStart < 15000) {
    for (const win of composeWindowsOpen()) {
      const ready = await win.webContents.executeJavaScript(`state.composeInitializing === false && document.getElementById("compose").open && document.getElementById("compose-title").textContent === "Reply All"`, true).catch(() => false);
      if (ready) all = win;
    }
    if (all) break;
    await sleep(50);
  }
  assert.ok(all, "Reply All action opens its own compose window");
  assertNativeFit(all, shellWin);
  assert.equal(await all.webContents.executeJavaScript(`
    document.getElementById("compose-to").value.includes("charles.babbage@example.com")
    && document.getElementById("compose-cc").value.includes("grace@example.com")
    && document.getElementById("compose-cc").value.includes("mary@example.com")
    && !document.getElementById("compose-cc").value.includes("ada.lovelace@example.com")
  `, true), true, "Reply All preserves participants and excludes self");
  await assertComposeGeometry(all);
  await closeClean(all);
  await shellWin.webContents.executeJavaScript(`document.querySelector('#reader [data-action="reply"]').click()`, true);
  let reply = null;
  const replyStart = Date.now();
  while (Date.now() - replyStart < 15000) {
    for (const win of composeWindowsOpen()) {
      const ready = await win.webContents.executeJavaScript(`state.composeInitializing === false && document.getElementById("compose").open && document.getElementById("compose").dataset.quote === "shown" && (document.getElementById("compose-quote").textContent || "").includes("table of operations")`, true).catch(() => false);
      if (ready) reply = win;
    }
    if (reply) break;
    await sleep(50);
  }
  assert.ok(reply, "reply opens a compose window with the quote");
  assertNativeFit(reply, shellWin);
  assert.equal(await reply.webContents.executeJavaScript(`document.getElementById("compose-cc").value`, true), "", "Reply does not inherit Reply All recipients");
  assert.equal(await reply.webContents.executeJavaScript(`
    document.getElementById("compose-quote-body").textContent.includes("Earlier conversation: preserve the original table.")
    && composePayload(composeAccount()).body.includes("Earlier conversation: preserve the original table.")
  `, true), true, "earlier history is visible and included in the outgoing quote");
  const shellStillClosed = await shellWin.webContents.executeJavaScript(`document.getElementById("compose").open === false`, true);
  assert.equal(shellStillClosed, true);
  await waitFor(reply, `document.title.includes("Reply")`, "reply title");
  assert.ok(reply.getTitle().includes("Reply"));
  const baseline = await reply.webContents.executeJavaScript(`composeSnapshot()`, true);
  const geometry = [];
  for (const [width, height] of [[1200, 900], [800, 640], [720, 560], [1200, 900]]) {
    reply.setContentSize(width, height);
    await waitFor(reply, `innerWidth === ${width} && innerHeight === ${height} && document.getElementById("compose").dataset.layout === "${width >= 900 ? "wide" : "narrow"}"`, "compose resize");
    geometry.push(await assertComposeGeometry(reply));
    await reply.webContents.executeJavaScript(`
      document.getElementById("compose-editing-help").open = true;
      document.getElementById("compose-schedule-tools").open = true;
      document.querySelector(".compose-draft").scrollTop = 10000;
    `, true);
    await assertComposeGeometry(reply);
    assert.equal(await reply.webContents.executeJavaScript(`composeSnapshot()`, true), baseline, "resizing/help never alters draft content");
    await reply.webContents.executeJavaScript(`
      document.getElementById("compose-editing-help").open = false;
      document.getElementById("compose-schedule-tools").open = false;
      document.querySelector(".compose-draft").scrollTop = 0;
    `, true);
  }
  const replyShot = await shot(reply, "compose-window-reply");
  await reply.webContents.executeJavaScript(`
    const editor = document.getElementById("compose-editor");
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  `, true);
  await waitFor(reply, `(document.getElementById("compose-attachments").textContent || "").includes("note.txt")`, "dropped attachment");
  await reply.webContents.executeJavaScript(`
    const field = document.getElementById("compose-to");
    if (!field.value.trim()) field.value = "charles.babbage@example.com";
    document.getElementById("compose-send").click();
  `, true);
  await waitFor(reply, `document.getElementById("compose-preview").open === true`, "send preview");
  await Promise.race([whenClosed(reply), reply.webContents.executeJavaScript(`document.getElementById("compose-preview-confirm").click()`, true)]);
  const undoStart = Date.now();
  while (!reply.isDestroyed() && Date.now() - undoStart < 15000) await sleep(50);
  assert.equal(reply.isDestroyed(), true, "undo delay closes the compose window");
  const queued = sentPayloads.filter((item) => item.channel === "mail:scheduleSend");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.outbox, true);
  assert.equal(sentChannels.filter((channel) => channel === "mail:send").length, 0);

  await checkDraftWindowLabels(host, shellWin);
  console.log(JSON.stringify({ ok: true, shots: [shellShot, discardShot, replyShot], geometry, consoleNotes }));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
