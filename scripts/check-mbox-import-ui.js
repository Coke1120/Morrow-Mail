"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
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
    else throw new Error("Unexpected synthetic UI invoke " + channel);
    return { success: true, data };
  } };
  window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event,
    morrowFeaturesCatalog: window.morrowFeaturesCatalog });
  ui.run("renderAccounts=()=>{}; state.accounts=[]; state.view='mail';");
  return { dir, source, store, importer, window, calls, ui, $: id => window.document.getElementById(id) };
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
