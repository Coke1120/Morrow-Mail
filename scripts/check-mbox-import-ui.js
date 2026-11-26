"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const L = require("../host/mail/local-folders"), { createImporter } = require("../host/mail/mbox-import");

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-dom-")), store = L.createLocalStore(path.join(dir, "local.sqlite"));
  const importer = createImporter({ store, ...options });
  const bytes = Buffer.from("From - Thu Nov  5 10:00:00 2026\nFrom: sender@fixture.invalid\nSubject: Synthetic UI evidence\n\nDownloaded body\n");
  const source = path.join(dir, "Exported-Inbox"); fs.writeFileSync(source, bytes);
  const window = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" }).window;
  const calls = []; let ui;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  t.after(async () => { if (ui) ui.run("clearTimeout(mboxReview?.timer)"); await importer.stop(); window.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  window.morrow = { on() {}, invoke: async (channel, params = {}) => {
    calls.push({ channel, params }); let data;
    if (channel === "mail:localFolders") data = store.account();
    else if (channel === "mail:mboxJobs") data = importer.list();
    else if (channel === "mail:mboxPick") data = await importer.select([source]);
    else if (channel === "mail:mboxStart") data = importer.start(params.jobId, { destination: params.folderId, variant: params.variant });
    else if (channel === "mail:mboxStatus") data = importer.status(params.jobId);
    else if (channel === "mail:mboxCancel") data = importer.cancel(params.jobId);
    else if (channel === "mail:mboxDiscard") data = await importer.discard(params.jobId);
    else if (channel === "mail:manageLocalFolder") data = store.manageFolder(params);
    else if (channel === "mail:listFromCache") data = store.list(params);
    else if (channel === "mail:listSnoozed") data = { records: [] };
    else throw new Error("Unexpected synthetic UI invoke " + channel);
    return { success: true, data };
  } };
  window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event,
    morrowFeaturesCatalog: window.morrowFeaturesCatalog });
  ui.run("renderAccounts=()=>{}; state.accounts=[]; state.view='mail';");
  return { dir, source, store, importer, window, calls, ui, $: id => window.document.getElementById(id) };
}

async function waitFor(assertion) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try { assertion(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(20);
  }
}

async function savedJob(f, folderId) {
  const job = await f.importer.select([f.source]);
  f.importer.start(job.id, { destination: folderId, variant: "mboxrd" });
  await f.importer.idle();
  return f.importer.status(job.id);
}

test("actual renderer reviews explicit files/destination/format, creates a local folder, renders counters and synchronizes Features/CLI help", async t => {
  const f = await fixture(t); const trigger = f.window.document.createElement("button");
  trigger.className = "local-mbox-open"; trigger.textContent = "Import MBOX…"; f.$("folders").appendChild(trigger); trigger.focus();
  await f.ui.run("openMboxImport()"); assert.equal(f.$("mbox-import").open, true); assert.equal(f.$("mbox-start").disabled, true);
  assert.equal(f.calls.filter(call => call.channel === "mail:mboxPick").length, 0);
  await f.ui.run("pickMboxFiles()"); assert.match(f.$("mbox-files").textContent, /Exported-Inbox/); assert.equal(f.$("mbox-start").disabled, false);
  assert.match(f.$("mbox-duplicate-help").textContent, /Message-ID alone never merges/);
  f.$("mbox-folder-name").value = "Synthetic destination"; f.$("mbox-new-folder").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.$("mbox-folder").selectedOptions[0].textContent, /Synthetic destination/);
  const destination = f.$("mbox-folder").value;
  await f.ui.run("startMboxImport()"); assert.equal(f.$("mbox-folder").disabled, true); assert.equal(f.$("mbox-variant").disabled, true);
  assert.equal(f.$("mbox-pick").disabled, true); assert.equal(f.$("mbox-history").disabled, true);
  await f.importer.idle();
  f.ui.run("mboxReview.job=JSON.parse(fixtureJob); paintMboxImport()".replace("fixtureJob", JSON.stringify(JSON.stringify(f.importer.list()[0]))));
  assert.match(f.$("mbox-status").textContent, /completed\. 1 imported/); assert.equal(f.store.list({ folderId: destination }).total, 1);
  assert.equal(f.$("mbox-discard").hidden, false); assert.equal(f.$("mbox-start").disabled, true);
  assert.equal(f.calls.filter(call => /Network|Provider|:send|^ai|^emailBrain|^nativeAgent/.test(call.channel)).length, 0);
  f.ui.run("paintFeatureCatalog()"); assert.match(f.$("features-catalog").textContent, /MBOX import/); assert.match(f.$("features-catalog").textContent, /Content-Length mboxcl/);
  assert.match(f.$("cli-mbox-help").textContent, /no CLI command or bot operation/);
  const replacement = trigger.cloneNode(true); trigger.replaceWith(replacement);
  await f.ui.run("closeMboxImport()"); assert.equal(f.$("mbox-import").open, false); assert.equal(f.window.document.activeElement, replacement, "completion refresh may rebuild the original sidebar trigger");
});

test("Stop/Escape cancels a held real job, preserves partial state, restores focus and ignores an old close event after reopening", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { hooks: { stageChunk: () => held } });
  await f.ui.run("openMboxImport();"); await f.ui.run("pickMboxFiles()"); await f.ui.run("startMboxImport()");
  const cancel = new f.window.Event("cancel", { cancelable: true }); f.$("mbox-import").dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true); assert.equal(f.$("mbox-import").open, true);
  release(); await f.importer.idle(); await new Promise(resolve => setTimeout(resolve, 450));
  assert.match(f.$("mbox-status").textContent, /cancelled/); assert.equal(f.store.list().total, 0);
  assert.equal(f.calls.filter(row => row.channel === "mail:mboxCancel").length, 1);
  await f.ui.run("closeMboxImport()"); await f.ui.run("openMboxImport()");
  f.$("mbox-import").dispatchEvent(new f.window.Event("close"));
  assert.equal(f.ui.run("mboxReview !== null"), true); assert.equal(f.$("mbox-start").textContent, "Continue");
  assert.equal(f.$("mbox-folder").disabled, true);
});

test("polling and reopened history show committed counts and open the original destination from Folders in another account", async t => {
  const f = await fixture(t);
  const destination = f.store.manageFolder({ action: "create", name: "Evidence intake" }).id;
  const filed = f.store.manageFolder({ action: "create", name: "Filed deliveries" }).id;
  await savedJob(f, destination);
  f.store.update(f.store.list({ folderId: destination }).emails[0].id, { folderId: filed });
  fs.appendFileSync(f.source,
    "From - Thu Nov  5 10:00:00 2026\nFrom: sender@fixture.invalid\nSubject: Synthetic UI evidence\n\nNew body\n" +
    "From - Thu Nov  5 10:00:00 2026\nFrom: sender@fixture.invalid\nSubject: Deleted\nX-Mozilla-Status: 0008\n\nDeleted body\n" +
    "From - Thu Nov  5 10:00:00 2026\nFrom: sender@fixture.invalid\nSubject: Partial\nX-Mozilla-Status: 0400\n\nPartial body\n");
  await f.ui.run(`openMboxImport(${JSON.stringify(destination)})`);
  await f.ui.run("pickMboxFiles()");
  assert.match(f.$("mbox-history").selectedOptions[0].textContent, / · review$/);
  assert.equal(f.$("mbox-open-destination").hidden, true);
  await f.ui.run("startMboxImport()");
  await f.importer.idle();
  const result = /completed with errors\. 1 imported · 2 skipped \(1 duplicate, 1 Thunderbird-deleted entry\) · 1 failed/;
  await waitFor(() => assert.match(f.$("mbox-status").textContent, result));
  const resultId = f.$("mbox-history").value;
  assert.match(f.$("mbox-history").selectedOptions[0].textContent, / · completed with errors$/);
  assert.equal(f.$("mbox-result-hint").hidden, false);
  assert.match(f.$("mbox-result-hint").textContent, /Search Local Folders by subject or message text/);
  assert.equal(f.store.list({ folderId: filed }).total, 1);
  await f.ui.run("closeMboxImport()");
  f.ui.run(`
    state.accounts = [{ id: "other", email: "other@fixture.invalid" }];
    state.accountId = "other"; state.folderId = "INBOX";
    showPrimary("folders", "provider-panel");
  `);
  await f.ui.run("openMboxImport()");
  assert.match(f.$("mbox-status").textContent, result);
  assert.equal(f.$("mbox-history").value, resultId);
  assert.equal(f.$("mbox-open-destination").type, "button");
  assert.equal(f.$("mbox-open-destination").hidden, false);
  f.$("mbox-open-destination").focus();
  f.$("mbox-open-destination").click();
  await waitFor(() => assert.equal(f.ui.run("state.listTotal"), 1));
  assert.equal(f.$("mbox-import").open, false);
  assert.equal(f.$("provider-panel").hidden, true);
  assert.equal(f.$("shell").hidden, false);
  assert.equal(f.$("rail-mail").getAttribute("aria-current"), "page");
  assert.equal(f.ui.run("state.accountId"), L.ACCOUNT_ID);
  assert.equal(f.ui.run("state.folderId"), destination);
  assert.equal(f.ui.run("state.searchAccountId"), L.ACCOUNT_ID);
  assert.equal(f.window.document.activeElement, f.$("message-list"));
  assert.match(f.$("message-list").textContent, /Synthetic UI evidence/);
});

test("click revalidates the exact destination of an older completed job and keeps its counts when the folder is gone", async t => {
  const f = await fixture(t);
  const destination = f.store.manageFolder({ action: "create", name: "Evidence intake" }).id;
  fs.writeFileSync(f.source, "From - Thu Nov  5 10:00:00 2026\nFrom: sender@fixture.invalid\nSubject: Deleted\nX-Mozilla-Status: 0008\n\nDeleted body\n");
  const old = await savedJob(f, destination);
  await savedJob(f, L.ARCHIVE_ID);
  await f.ui.run("openMboxImport()");
  f.$("mbox-history").value = old.id;
  f.$("mbox-history").dispatchEvent(new f.window.Event("change"));
  await waitFor(() => assert.equal(f.ui.run("mboxReview.job.id"), old.id));
  assert.equal(f.$("mbox-open-destination").hidden, false);

  f.store.manageFolder({ action: "delete", folderId: destination });
  f.store.manageFolder({ action: "create", name: "Evidence intake" });
  f.$("mbox-open-destination").focus();
  f.$("mbox-open-destination").click();
  await waitFor(() => assert.match(f.$("mbox-status").textContent, /The original destination is unavailable/));
  assert.match(f.$("mbox-status").textContent, /0 imported · 1 skipped \(0 duplicates, 1 Thunderbird-deleted entry\) · 0 failed/);
  assert.equal(f.$("mbox-history").value, old.id);
  assert.equal(f.$("mbox-import").open, true);
  assert.equal(f.$("mbox-open-destination").hidden, true);
  assert.equal(f.window.document.activeElement, f.$("mbox-close"));
  assert.equal(f.calls.some(call => call.channel === "mail:listFromCache"), false);
});

test("a pending history change supersedes destination navigation and a late history response", async t => {
  const f = await fixture(t);
  const completed = await savedJob(f, L.ARCHIVE_ID);
  const review = await f.importer.select([f.source]);
  await f.ui.run("openMboxImport()");
  const invoke = f.window.morrow.invoke;
  let releaseFolder, releaseReview;
  let folder = new Promise(resolve => { releaseFolder = resolve; });
  const status = new Promise(resolve => { releaseReview = resolve; });
  f.window.morrow.invoke = async (channel, params) => {
    if (channel === "mail:localFolders") await folder;
    if (channel === "mail:mboxStatus" && params.jobId === review.id) await status;
    return invoke(channel, params);
  };
  const select = id => {
    f.$("mbox-history").value = id;
    f.$("mbox-history").dispatchEvent(new f.window.Event("change"));
  };
  select(completed.id);
  await waitFor(() => assert.match(f.$("mbox-status").textContent, /^completed\./));
  const pendingOpen = f.ui.run("openMboxDestination()");
  select(review.id);
  assert.equal(f.$("mbox-open-destination").hidden, true);
  releaseFolder();
  await pendingOpen;
  assert.equal(f.$("mbox-import").open, true);
  select(completed.id);
  await waitFor(() => assert.match(f.$("mbox-status").textContent, /^completed\./));
  releaseReview();
  await delay(0);
  assert.equal(f.$("mbox-history").value, completed.id);
  assert.match(f.$("mbox-status").textContent, /^completed\./);

  folder = new Promise(resolve => { releaseFolder = resolve; });
  const cancelledOpen = f.ui.run("openMboxDestination()");
  const cancel = new f.window.Event("cancel", { cancelable: true });
  assert.equal(f.$("mbox-import").dispatchEvent(cancel), true);
  f.$("mbox-import").close(); // JSDOM needs the native Escape default simulated.
  releaseFolder();
  await cancelledOpen;
  assert.equal(f.$("mbox-import").open, false);
  assert.equal(f.calls.some(call => call.channel === "mail:listFromCache"), false);
});
