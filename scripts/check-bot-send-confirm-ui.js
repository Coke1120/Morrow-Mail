"use strict";

// Real preload and renderer events. The IPC boundary is an in-memory fake:
// no auth.mint, credential generation, user settings, listener or mail transport.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const source = file => fs.readFileSync(require.resolve("../" + file), "utf8");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t, motion = false) {
  const dom = new JSDOM(source("renderer/index.html")), { window } = dom, { document } = window;
  t.after(() => window.close());
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => {
      if (!dialog.open) return;
      dialog.open = false;
      // HTML close events are queued tasks, not synchronous notifications.
      setImmediate(() => dialog.dispatchEvent(new window.Event("close")));
    };
  }
  if (motion) window.morrowMotion = {
    rows() {}, bindChrome() {}, prepare() {}, dialogIn() {}, wantsCloseMotion: () => true,
    dialogOut: () => new Promise(resolve => setImmediate(resolve)),
  };
  const access = { enabled: false, listen: { listening: false }, grants: [], drafts: [], sends: [], audit: [],
    accounts: [{ accountId: "alpha", email: "alpha@example.test" }, { accountId: "beta", email: "beta@example.test" }] };
  const calls = [], persisted = [];
  let failure = null, held = null;
  const exposed = {};
  vm.runInNewContext(source("renderer/preload.js"), { require(name) {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, async invoke(channel, input) {
        calls.push({ channel, input: input === undefined ? undefined : clone(input) });
        if (channel === "bot:getAccess") return { success: true, data: clone(access) };
        if (channel === "bot:mintGrant") {
          if (held) await held;
          if (failure === "transport") throw Error("Synthetic IPC failure");
          if (failure) return { success: false, error: { message: "Synthetic persistence failure" } };
          persisted.push(clone(input));
          const grant = { ...clone(input), clientId: "fixture-bot", live: true, proactive: null };
          access.grants = [grant];
          return { success: true, data: { secret: "mock-not-a-credential", grant, access: clone(access) } };
        }
        assert.doesNotMatch(channel, /^(mail:send|bot:setEnabled|bot:configureProactive)$/);
        return { success: true, data: [] };
      } } };
  } });
  window.morrow = exposed.morrow;
  window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  const ui = renderer({ window, document, navigator: window.navigator, Event: window.Event, Node: window.Node,
    requestAnimationFrame: work => { queueMicrotask(() => work(0)); return 1; } });
  ui.context.access = clone(access);
  ui.run("wire(); paintBotAccess(access); openDialog('settings');");
  const get = id => document.getElementById(id), click = id => get(id).click();
  get("bot-platform").value = "hermes_agent";
  get("bot-label").value = "Hermes fixture";
  get("bot-accounts").querySelector('[value="alpha"]').checked = true;
  get("bot-caps").querySelector('[data-cap="mail.send"]').checked = true;
  get("bot-expiry").value = "never";
  return { ui, access, calls, persisted, get, click,
    setFailure: value => { failure = value; },
    hold: () => { let release; held = new Promise(resolve => { release = resolve; }); return release; },
    escape: () => {
      const dialog = get("confirm");
      if (dialog.dispatchEvent(new window.Event("cancel", { cancelable: true }))) dialog.close();
    },
    mintCalls: () => calls.filter(row => row.channel === "bot:mintGrant"),
  };
}

for (const motion of [false, true]) {
  test(`chained no-expiry and sending confirmations survive queued close (${motion ? "motion" : "reduced motion"})`, async t => {
    const f = fixture(t, motion);
    f.click("bot-mint-btn"); await settle();
    assert.equal(f.get("confirm-title").textContent, "No expiry");
    assert.equal(f.mintCalls().length, 0);
    f.click("confirm-ok"); await settle();
    assert.equal(f.get("confirm-ok").textContent, "Allow sending");
    assert.match(f.get("confirm-body").textContent, /alpha@example.test/);
    assert.doesNotMatch(f.get("confirm-body").textContent, /beta@example.test/);
    assert.equal(f.ui.run("!!confirmResult"), true, "the previous dialog's close cannot cancel this review");
    assert.equal(f.mintCalls().length, 0);
    f.click("confirm-ok"); f.click("confirm-ok"); f.click("bot-mint-btn"); await settle();
    assert.equal(f.mintCalls().length, 1);
    assert.deepEqual(f.persisted, [{ label: "Hermes fixture", platform: "hermes_agent", accountIds: ["alpha"],
      capabilities: ["accounts.read", "mail.headers.read", "health.read", "agent.proposals.read", "mail.send"],
      expiry: { kind: "never", neverConfirmed: true } }]);
    assert.equal(f.get("bot-secret").open, true);
    assert.match(f.get("bot-status").textContent, /Bot created.*Access is still off/);
    f.click("bot-secret-close"); await settle();
    assert.equal(f.get("bot-secret-value").textContent, "");
    await f.ui.run("loadBotAccess()");
    assert.match(f.get("bot-grants").textContent, /Hermes fixture/);
    assert.equal(f.get("bot-enabled").checked, false);
    assert.equal(f.persisted.length, 1, "refresh reads the fake persisted grant without repeating creation");
  });
}

for (const phase of ["expiry", "sending"]) for (const action of ["cancel", "escape"]) {
  test(`${action} at ${phase} review writes nothing and permits a fresh attempt`, async t => {
    const f = fixture(t, true);
    f.click("bot-mint-btn"); await settle();
    if (phase === "sending") { f.click("confirm-ok"); await settle(); }
    if (action === "cancel") f.click("confirm-cancel"); else f.escape();
    await settle();
    assert.equal(f.get("confirm").open, false);
    assert.equal(f.mintCalls().length, 0);
    assert.equal(f.persisted.length, 0);
    assert.equal(f.get("bot-secret").open, false);
    f.click("bot-mint-btn"); await settle();
    assert.equal(f.get("confirm-title").textContent, "No expiry");
    f.click("confirm-ok"); await settle();
    assert.equal(f.get("confirm-ok").textContent, "Allow sending");
    f.click("confirm-cancel"); await settle();
  });
}

test("the reviewed mailbox labels and entire grant request retain the submitted selection", async t => {
  const f = fixture(t);
  f.click("bot-mint-btn"); await settle();
  // Simulate a form/status change while the first asynchronous review is open.
  f.get("bot-accounts").querySelector('[value="alpha"]').checked = false;
  f.get("bot-accounts").querySelector('[value="beta"]').checked = true;
  f.get("bot-label").value = "Changed name"; f.get("bot-platform").value = "grok_bot";
  f.get("bot-caps").querySelector('[data-cap="mail.bodies.read"]').checked = true;
  f.click("confirm-ok"); await settle();
  assert.match(f.get("confirm-body").textContent, /alpha@example.test/);
  assert.doesNotMatch(f.get("confirm-body").textContent, /beta@example.test/);
  f.click("confirm-ok"); await settle();
  const saved = f.persisted[0];
  assert.deepEqual(saved.accountIds, ["alpha"]);
  assert.equal(saved.platform, "hermes_agent"); assert.equal(saved.label, "Hermes fixture");
  assert.ok(!saved.capabilities.includes("mail.bodies.read"));
});

for (const failure of ["persistence", "transport"]) {
  test(`${failure} failure remains visible, exposes no secret and requires fresh reviews on retry`, async t => {
    const f = fixture(t); f.setFailure(failure);
    f.click("bot-mint-btn"); await settle(); f.click("confirm-ok"); await settle();
    f.click("confirm-ok"); await settle();
    assert.equal(f.persisted.length, 0); assert.equal(f.get("bot-secret").open, false);
    assert.match(f.get("bot-status").textContent, /Synthetic .*failure/);
    assert.equal(f.get("bot-status").classList.contains("error"), true);
    assert.equal(f.get("bot-label").value, "Hermes fixture");
    f.setFailure(null); f.click("bot-mint-btn"); await settle();
    assert.equal(f.get("confirm-title").textContent, "No expiry");
    f.click("confirm-ok"); await settle(); assert.equal(f.get("confirm-ok").textContent, "Allow sending");
    f.click("confirm-ok"); await settle(); assert.equal(f.persisted.length, 1);
  });
}

test("repeated clicks during slow fake persistence cannot duplicate a grant", async t => {
  const f = fixture(t), release = f.hold();
  f.click("bot-mint-btn"); await settle(); f.click("confirm-ok"); await settle();
  f.click("confirm-ok"); await settle();
  f.click("confirm-ok"); f.click("bot-mint-btn"); await settle();
  assert.equal(f.mintCalls().length, 1); assert.equal(f.persisted.length, 0);
  release(); await settle(); assert.equal(f.persisted.length, 1);
});

test("finite expiry, default read access, missing accounts and Features retain their boundaries", async t => {
  const f = fixture(t);
  f.get("bot-expiry").value = "7";
  f.click("bot-mint-btn"); await settle();
  assert.equal(f.get("confirm-ok").textContent, "Allow sending");
  f.click("confirm-cancel"); await settle();
  f.get("bot-caps").querySelector('[data-cap="mail.send"]').checked = false;
  f.get("bot-accounts").querySelector("input").checked = false;
  f.click("bot-mint-btn"); await settle();
  assert.match(f.get("bot-status").textContent, /Choose at least one mailbox/);
  assert.equal(f.mintCalls().length, 0);
  f.get("bot-accounts").querySelectorAll("input").forEach(input => { input.checked = true; });
  f.click("bot-mint-btn"); await settle();
  assert.equal(f.get("confirm").open, false);
  assert.deepEqual(f.persisted[0].accountIds, ["alpha", "beta"]);
  assert.ok(!f.persisted[0].capabilities.includes("mail.send"));
  assert.deepEqual(f.persisted[0].expiry, { kind: "finite", days: 7 });
  f.ui.run("paintFeatureCatalog()");
  assert.match(f.get("features-catalog").textContent, /No expiry and Allow sending are separate reviews/);
});
