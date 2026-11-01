"use strict";

// Actual preload -> vanilla Settings DOM -> host validation, with synthetic
// accounts and memory secrets. No credentials, live mailbox or network calls.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const root = path.join(__dirname, "..");
const source = file => fs.readFileSync(path.join(root, file), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function haltedDeliveryChecks(ui, dom, clientId, temp) {
  const db = require("../host/mail/db"), auth = require("../host/bot/auth");
  const proactive = require("../host/bot/proactive"), config = require("../host/bot/proactive-config");
  const transport = require("../host/bot/proactive-transport"), audit = require("../host/bot/audit");
  const listener = require("../host/bot/listener-status");
  const original = { rename: fs.renameSync, post: transport.post, record: audit.record, listening: listener.state.listening };
  const grant = auth.load().store.grants.find(row => row.clientId === clientId);
  const file = path.join(temp, "bot-proactive-state.json");
  const list = dom.window.document.getElementById("bot-grants");
  let posts = 0, timeout;
  const assertHalted = () => {
    const text = list.querySelector("[data-notify-status]").textContent;
    assert.match(text, /halted.*STATE_UNAVAILABLE/i);
    assert.match(text, /inspect.*storage.*restart/i);
    assert.doesNotMatch(text, /Runs while|Next slot|SCHEDULED|after saving/);
    assert.match(list.querySelector(".bot-proactive summary").textContent, /halted/i);
  };
  try {
    db.replaceFolders("fixture-mail", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    db.insertMessage({ id: "halt-fixture", accountId: "fixture-mail", folderPath: "INBOX", uid: 1, uidValidity: 1,
      subject: "Synthetic delivery", snippet: "Cached mail", date: new Date().toISOString(), listSortTs: Date.now() });
    fs.writeFileSync(file, JSON.stringify({ version: 1, bots: { [clientId]: {
      binding: config.binding(grant), revision: grant.revision, seen: {}, lastCode: "SCHEDULED",
      nextRunAt: new Date(Date.now() - 60000).toISOString(),
    } } }));
    auth.setEnabledFlag(true); listener.state.listening = true;
    transport.post = async () => { posts++; return { code: "OK" }; };
    fs.renameSync = (from, to) => {
      if (to === file && posts) throw Error("synthetic acknowledgement write failure");
      return original.rename(from, to);
    };
    await ui.run("loadBotAccess()");
    const form = list.querySelector(".bot-proactive form");
    assert.match(list.querySelector("[data-notify-status]").textContent, /Runs while Morrow is open and awake/);
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(Error("synthetic delivery did not halt")), 5000);
      audit.record = entry => {
        original.record(entry);
        if (entry.clientId === clientId && entry.code === "STATE_UNAVAILABLE") resolve();
      };
      proactive.start();
    });
    proactive.stop();
    fs.renameSync = original.rename;
    assert.equal(posts, 1, "the intercepted webhook succeeds before acknowledgement storage fails");
    assert.deepEqual(audit.recent(2).map(row => row.code).sort(), ["OK", "STATE_UNAVAILABLE"]);
    await ui.run("loadBotAccess()");
    assert.equal(list.querySelector(".bot-proactive form"), form, "a status refresh preserves the editor while updating the halt");
    assertHalted();
    for (const enabled of [false, true]) {
      auth.setEnabledFlag(enabled);
      await ui.run("loadBotAccess()");
      assertHalted();
    }
    form.querySelector('[data-notify-field="allow"]').checked = true;
    form.requestSubmit(); await tick(); await tick();
    assert.ok(auth.view().grants[0].revision > grant.revision, "the real Settings save commits a newer revision after storage recovers");
    assert.equal(proactive.statuses(auth.view().grants)[clientId].halted, true, "saving settings cannot clear the runtime halt");
    assertHalted();
    assert.match(dom.window.document.getElementById("bot-status").textContent, /Delivery remains halted; inspect local storage before restarting/);
  } finally {
    clearTimeout(timeout); proactive.stop();
    fs.renameSync = original.rename; transport.post = original.post; audit.record = original.record;
    listener.state.listening = original.listening;
  }
}

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-proactive-ui-"));
  const previous = { data: process.env.MORROW_USER_DATA, secrets: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_USER_DATA = temp; process.env.MORROW_MAIL_SECRETS = "memory";
  const db = require("../host/mail/db"), auth = require("../host/bot/auth"), manage = require("../host/bot/manage");
  const transport = require("../host/bot/proactive-transport"), originalPost = transport.post;
  transport.post = async () => { throw Error("unexpected delivery outside the synthetic webhook fixture"); };
  const dom = new JSDOM(source("renderer/index.html"));
  try {
    await db.open(path.join(temp, "mail.sqlite"));
    db.insertAccount({ id: "fixture-mail", email: "fixture@example.test", username: "fixture", profile: "imap", authKind: "password",
      imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true, createdAt: Date.now() });
    const event = { sender: { getURL: () => "file:///synthetic/renderer/index.html" } };
    const exposed = {}, calls = [];
    vm.runInNewContext(source("renderer/preload.js"), { require(name) {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
        ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke(channel, payload) {
          calls.push({ channel, payload }); return manage.answer(channel, payload, event);
        } } };
    } });
    await assert.rejects(exposed.morrow.invoke("bot:notAChannel", {}), /Unsupported channel/);
    assert.equal((await manage.answer("bot:configureProactive", {}, { sender: { getURL: () => "https://untrusted.invalid" } })).success, false);
    let copied = "";
    const ui = renderer({ document: dom.window.document, window: { morrow: exposed.morrow },
      navigator: { clipboard: { writeText: async value => { copied = value; } } } });
    const $ = id => dom.window.document.getElementById(id);
    ui.run("showBotSecret = () => {}; wireBot();");
    await ui.run("loadBotAccess()");
    assert.equal($("bot-platform").value, "grok_bot");
    $("bot-platform").value = "hermes_agent"; $("bot-label").value = "Hermes fixture";
    $("bot-accounts").querySelector("input").checked = true;
    $("bot-mint").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await tick(); await tick();
    const grant = auth.view().grants[0];
    assert.equal(grant.platform, "hermes_agent"); assert.equal(grant.proactive, null);
    assert.match($("bot-grants").textContent, /Hermes Agent/);
    assert.equal($("bot-setup-client").value, grant.clientId);
    let form = $("bot-grants").querySelector(".bot-proactive form");
    const field = name => form.querySelector(`[data-notify-field="${name}"]`);
    assert.equal(field("allow").checked, false);
    assert.equal(field("includeBody").checked, false);
    assert.equal(field("includeBody").disabled, true, "body checkbox obeys grant");
    assert.equal(field("account-fixture-mail").checked, false, "mailbox selection is explicit");
    field("webhookUrl").value = "https://bot.tail.ts.net:8443/notify";
    field("account-fixture-mail").checked = true;
    field("secret").value = "synthetic-ui-bearer";
    field("allow").checked = true;
    field("everyMinutes").value = "15";
    field("everyMinutes").dispatchEvent(new dom.window.Event("input"));
    assert.equal(field("allow").checked, false, "edited targets/settings require a fresh review");
    await ui.run("loadBotAccess()");
    assert.equal($("bot-grants").querySelector(".bot-proactive form"), form, "status refresh retains the unsaved editor");
    assert.equal(field("webhookUrl").value, "https://bot.tail.ts.net:8443/notify");
    assert.equal(field("secret").value, "synthetic-ui-bearer");
    field("allow").checked = true;
    form.requestSubmit();
    await tick(); await tick();
    const configured = auth.view().grants[0];
    assert.equal(configured.proactive.enabled, true);
    assert.equal(configured.proactive.schedule.everyMinutes, 15);
    assert.equal(configured.proactive.hasSecret, true);
    assert.equal(auth.isEnabled(), false, "saving proactive consent does not start the listener");
    assert.doesNotMatch(JSON.stringify(manage.snapshot()), /synthetic-ui-bearer|secretKey/);
    form = $("bot-grants").querySelector(".bot-proactive form");
    assert.equal(field("secret").value, ""); assert.equal(field("allow").checked, false);
    assert.match($("bot-grants").textContent, /Paused until bot access is listening/);
    let submits = 0;
    form.addEventListener("submit", () => { submits++; });
    field("everyMinutes").value = "0";
    field("everyMinutes").dispatchEvent(new dom.window.Event("input"));
    assert.equal(form.checkValidity(), false, "active invalid interval blocks native submission");
    field("kind").value = "cron";
    field("kind").dispatchEvent(new dom.window.Event("input"));
    field("kind").dispatchEvent(new dom.window.Event("change"));
    assert.equal(field("everyMinutes").parentElement.hidden, true);
    field("allow").checked = true;
    form.requestSubmit();
    await tick(); await tick();
    assert.equal(submits, 1, "valid cron submits natively despite the stale invalid interval");
    assert.equal(field("everyMinutes").disabled, true, "inactive interval is excluded from native validation");
    assert.equal(field("cron").disabled, false);
    assert.deepEqual(auth.view().grants[0].proactive.schedule, { kind: "cron", cron: "0 9 * * 1-5" });
    assert.equal(calls.filter(row => row.channel === "bot:configureProactive").length, 2);
    form = $("bot-grants").querySelector(".bot-proactive form");
    assert.equal(field("everyMinutes").disabled, true, "saved cron mounts with interval validation disabled");
    field("cron").setCustomValidity("Synthetic invalid cron");
    assert.equal(form.checkValidity(), false);
    field("kind").value = "interval";
    field("kind").dispatchEvent(new dom.window.Event("input"));
    field("kind").dispatchEvent(new dom.window.Event("change"));
    field("everyMinutes").value = "7";
    field("allow").checked = true;
    form.requestSubmit();
    await tick(); await tick();
    assert.equal(field("cron").disabled, true, "inactive cron is excluded from native validation");
    assert.equal(field("everyMinutes").disabled, false);
    assert.deepEqual(auth.view().grants[0].proactive.schedule, { kind: "interval", everyMinutes: 7 });
    assert.equal(calls.filter(row => row.channel === "bot:configureProactive").length, 3);
    form = $("bot-grants").querySelector(".bot-proactive form");
    $("bot-copy-setup").click(); await tick(); await tick();
    assert.match(copied, /Hermes Agent/); assert.match(copied, /inbound webhook.*proactive.mail_digest/);
    assert.match(copied, /platform bot owns every decision/); assert.doesNotMatch(copied, /synthetic-ui-bearer/);
    const denied = await exposed.morrow.invoke("bot:configureProactive", { ...calls.find(row => row.channel === "bot:configureProactive").payload, backgroundConfirmed: false });
    assert.equal(denied.success, false);
    await haltedDeliveryChecks(ui, dom, grant.clientId, temp);
    form = $("bot-grants").querySelector(".bot-proactive form");
    [...form.querySelectorAll("button")].find(node => node.textContent === "Stop proactive notify").click();
    await tick(); await tick();
    assert.equal(auth.view().grants[0].proactive.enabled, false);
    ui.run(source("renderer/features-catalog.js"));
    ui.run("paintFeatureCatalog(); paintCli();");
    assert.match($("features-catalog").textContent, /Grok Bot and Hermes Agent/);
    assert.match($("features-catalog").textContent, /halt.*storage.*restart/i);
    assert.match($("features-catalog").textContent, /Delete.*webhook credential.*cannot be removed/);
    assert.match($("cli-proactive").textContent, /platform bot decides/);
    assert.match($("cli-proactive").textContent, /halt.*restart.*Inspect storage/);
    const contract = require("../shared/bot-contract-v1.json");
    assert.deepEqual([...dom.window.document.querySelectorAll("[data-bot-operation]")].map(node => node.textContent).sort(), Object.keys(contract.operations).sort());
    for (const file of ["host/bot/proactive.js", "host/bot/proactive-config.js", "host/bot/proactive-transport.js"]) {
      assert.doesNotMatch(source(file), /require\(["'].*(?:openai-client|\/agent["']|\/engine|\/drafts|\/send)/, "push must not import action/model paths");
    }
    console.log("bot-proactive-ui-ok (actual preload, Settings DOM, native submission, host validation, Features and CLI)");
  } finally {
    transport.post = originalPost;
    dom.window.close(); await db.close(); fs.rmSync(temp, { recursive: true, force: true });
    for (const [key, value] of [["MORROW_USER_DATA", previous.data], ["MORROW_MAIL_SECRETS", previous.secrets]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
