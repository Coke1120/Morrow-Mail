// Real preload -> Settings -> host handlers/validation. No live I/O or user state.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const { renderer } = require("./check-ux-workflows");
const root = path.join(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, name), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixtureDocument(useDom = false) {
  const html = source("renderer/index.html");
  if (useDom) return new (require("jsdom").JSDOM)(html).window.document;
  try { return require("./check-chatgpt-ui").documentFor(html); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND" || process.env.CI) throw error; }
  // Dependency-free VM fallback; existing CI uses the actual HTML-parser DOM.
  const nodes = new Map();
  class Element {
    constructor() { this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.open = false;
      this.children = []; this.dataset = {}; this.listeners = new Map(); this.attributes = {}; this._text = ""; this.classList = { toggle() {} }; }
    set innerHTML(value) { for (const match of String(value).matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element()); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    querySelector(selector) { return document.getElementById(selector.slice(1)); }
    querySelectorAll() { return []; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    replaceChildren(...children) { this.children = children; this._text = ""; }
    addEventListener(name, work) { this.listeners.set(name, work); }
    async fire(name) { if (name === "click" && this.disabled) return; await this.listeners.get(name)?.({ target: this }); }
    showModal() { this.open = true; } close() { this.open = false; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() {}
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element());
  const document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element(), querySelector: () => null };
  return document;
}

function fixture({ config: initial = {}, account: accountInput = {}, useDom = false } = {}) {
  const directory = "/synthetic-consent-settings", files = new Map(), calls = [], handlers = new Map(), intercept = new Map(), interceptReply = new Map();
  let failWrite = false, writes = 0, modelCalls = 0, gateCalls = 0, consent;
  const configRecord = { authMode: "api_key", baseUrl: "https://synthetic.invalid/v1", model: "fixture-model", apiKey: "synthetic-not-real", ...initial };
  files.set(path.join(directory, "ai.json"), JSON.stringify(configRecord));
  let account = { available: true, connected: true, planEnabled: true, activeId: "fixture-account", pending: false,
    accounts: [{ id: "fixture-account", label: "Synthetic account", connected: true }], ...accountInput };
  const auth = { status: () => ({ ...account }), preferences: input => { account = { ...account, ...input }; return { ...account }; },
    select: id => { account = { ...account, activeId: id }; return { ...account }; }, invalidateRequests() {} };
  const memoryFs = {
    readFileSync(filename) { if (!files.has(filename)) throw Error("Missing synthetic record"); return files.get(filename); },
    mkdirSync() {}, chmodSync() {},
    writeFileSync(filename, value) { if (failWrite) throw Error("Synthetic persistence failure"); writes++; files.set(filename, String(value)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  function loadModule(filename, replacements) {
    const module = { exports: {} };
    vm.runInNewContext(source(filename), { module, exports: module.exports, URL, AbortController, AbortSignal,
      process: { env: { MORROW_AI_CONFIG_DIR: directory } }, require(name) {
        if (Object.hasOwn(replacements, name)) return replacements[name];
        if (["path", "node:path", "os", "node:os", "crypto", "node:crypto"].includes(name)) return require(name);
        throw Error("Unexpected fixture dependency: " + name);
      } });
    return module.exports;
  }
  const consentProxy = { getConsent: () => consent }, authProxy = { getAuth: () => auth };
  const config = loadModule("host/ai-config.js", { fs: memoryFs, "./ai-consent": consentProxy, "./chatgpt-auth": authProxy });
  const consentModule = loadModule("host/ai-consent.js", { "node:fs": memoryFs, "./ai-config": config, "./chatgpt-auth": authProxy });
  consent = consentModule.createConsent({ directory: () => directory, config: config.loadConfig, account: auth.status,
    background: value => auth.preferences({ backgroundConsent: value }) });
  const main = source("host/main.js");
  const registration = main.slice(main.indexOf("function registerHostAi()"), main.indexOf("function runAiSelfTest()"));
  vm.runInNewContext(registration + "\nregisterHostAi();", {
    ipcMain: { handle: (name, work) => handlers.set(name, work) },
    loadConfig: config.loadConfig, publicConfig: config.publicConfig, saveConfig: config.saveConfig,
    complete: () => { modelCalls++; throw Error("A model call is forbidden in this fixture"); },
    listModels: () => { throw Error("Model discovery is not part of consent"); },
    updateGate: { run(work) { gateCalls++; return work(); } },
    require(name) { if (name === "./ai-consent") return consentProxy; if (name === "./chatgpt-auth") return authProxy; throw Error(name); },
  });
  const event = { sender: { id: "synthetic-settings-window" }, senderFrame: { url: "file:///synthetic/renderer/index.html" } };
  async function dispatch(channel, input) {
    calls.push({ channel, input });
    if (intercept.has(channel)) await intercept.get(channel)(input);
    assert.ok(handlers.has(channel), "A real registered host handler must receive " + channel);
    const result = await handlers.get(channel)(event, input);
    if (interceptReply.has(channel)) await interceptReply.get(channel)(result);
    return result;
  }
  function preload(filename = "renderer/preload.js") {
    const exposed = {};
    vm.runInNewContext(source(filename), { require(name) {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
        ipcRenderer: { invoke: dispatch, on() {}, removeListener() {}, send() {} } };
    } });
    return exposed;
  }
  const bridge = preload().morrow, document = fixtureDocument(useDom), get = id => document.getElementById(id);
  const ui = renderer({ document, window: { morrow: bridge, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  ui.run(source("renderer/chatgpt-settings.js"));
  ui.run("mountChatgptSettings()");
  const component = ui.run("chatgptSettings");
  return { bridge, preload, consent, config, ui, component, get, calls, intercept, interceptReply,
    load: async () => { await ui.run("loadAiSettings()"); await tick(); },
    checkManual: async value => {
      get("ai-consent-manual").checked = value;
      if (useDom) { get("ai-consent-manual").dispatchEvent(new document.defaultView.Event("change")); await tick(); }
      else await get("ai-consent-manual").fire("change");
    },
    dispose: () => { component.dispose(); document.defaultView?.close(); },
    failWrites: value => { failWrite = value; },
    assertNoModelCalls: () => assert.equal(modelCalls, 0),
    get writes() { return writes; }, get gateCalls() { return gateCalls; },
  };
}

async function settingsLifecycle(t, options = {}) {
  const f = fixture({ ...options, useDom: true });
  t.after(f.dispose);
  await f.load();
  // Use the actual AI portion of the dialog-close listener, without unrelated
  // mail/compose/preferences cleanup. Reopening runs the real fold loader.
  const app = source("renderer/app.js");
  const closeStart = app.indexOf('  $("settings").addEventListener("close", () => {');
  const closeEnd = app.indexOf("    clearBotSecret();", closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  f.ui.run(app.slice(closeStart, closeEnd) + "  });");
  f.ui.run("afterPaint = callback => callback(); loadSettings = async () => {};");
  return { ...f,
    open() {
      f.get("settings").open = true;
      f.get("settings-ai").classList.add("is-open");
      // openSettings clears lazy-load completion for each new dialog session.
      return f.ui.run('settingsFoldLoaded.clear(); loadSettingsFold("ai")');
    },
    close() {
      f.get("settings").open = false;
      f.get("settings").dispatchEvent(new (f.get("settings").ownerDocument.defaultView.Event)("close"));
    },
    async click(id) { f.get(id).click(); await tick(); },
  };
}

function setupLifecycle(t, f) {
  const dom = new (require("jsdom").JSDOM)(source("host/ai-setup.html"));
  const document = dom.window.document, events = {};
  const context = vm.createContext({ document,
    window: { aiSetup: f.preload("host/setup-preload.js").aiSetup, addEventListener: (name, work) => { events[name] = work; } },
    setTimeout: () => 1, clearTimeout() {},
  });
  const run = code => vm.runInContext(code, context);
  run(source("renderer/chatgpt-settings.js"));
  run(source("host/ai-setup.js"));
  t.after(() => { events.pagehide(); dom.window.close(); f.dispose(); });
  return { run, get: id => document.getElementById(id), close: () => events.pagehide(),
    edit(id, value) { document.getElementById(id).value = value; document.getElementById(id).dispatchEvent(new dom.window.Event("input")); } };
}

test("Setup: a late initial account read cannot overwrite a successful save baseline or newer edits", async t => {
  for (const editAgain of [false, true]) {
    const f = fixture(), gate = deferred();
    f.intercept.set("host:chatgptStatus", () => gate.promise);
    const setup = setupLifecycle(t, f);
    await tick();
    assert.equal(setup.get("save").disabled, false);
    setup.edit("model", "saved-during-initial-load");
    await setup.get("save").onclick();
    assert.equal(setup.run("formState(draft()) !== savedBaseline"), false);
    if (editAgain) setup.edit("model", "newer-unsaved-model");
    gate.resolve(); await tick();
    assert.equal(f.config.loadConfig().model, "saved-during-initial-load");
    assert.equal(setup.run("formState(draft()) !== savedBaseline"), editAgain);
    assert.equal(setup.get("model").value, editAgain ? "newer-unsaved-model" : "saved-during-initial-load");
    if (editAgain) { setup.get("ai-consent-connection").click(); await tick(); }
    assert.equal(setup.run("formState(draft()) !== savedBaseline"), false);
    assert.match(setup.get("ai-consent-destination").textContent, new RegExp(setup.get("model").value));
    assert.equal(setup.get("ai-consent-manual").checked, false);
    assert.equal(setup.get("ai-consent-allow").disabled, true);
    setup.get("ai-consent-manual").click();
    assert.equal(setup.get("ai-consent-allow").disabled, false);
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
  }
});

test("Settings: repeatedly reopening a dirty draft reactivates review and saves without consent", async t => {
  for (const [field, value] of [["ai-model", "draft-model"], ["ai-base", "https://draft.synthetic.invalid/v1"], ["ai-key", "synthetic-new-key"], ["ai-auth-mode", "chatgpt"]]) {
    const f = await settingsLifecycle(t, { config: { chatgptModel: "fixture-chat" } });
    f.get(field).value = value; f.ui.run("paintAiDirty()");
    for (let repeat = 0; repeat < 2; repeat++) {
      await f.checkManual(true);
      f.get("ai-consent-background").checked = true;
      f.close(); await f.open();
      assert.equal(f.get(field).value, value, "reopen preserves the connection draft");
      assert.equal(f.ui.run("aiDirty()"), true);
      assert.equal(f.get("ai-consent-manual").disabled, false);
      assert.equal(f.get("ai-consent-connection").disabled, false);
      assert.equal(f.get("ai-consent-manual").checked, false);
      assert.equal(f.get("ai-consent-background").checked, false);
      assert.match(f.get("ai-consent-reason").textContent, /Unsaved.*Save.*review/);
    }
    await f.click("ai-consent-connection");
    assert.equal(f.ui.run("aiDirty()"), false);
    assert.equal(f.get("ai-consent-manual").disabled, false);
    assert.equal(f.get("ai-consent-allow").disabled, true);
    assert.equal(f.get("ai-consent-manual").checked, false);
    await f.checkManual(true);
    assert.equal(f.get("ai-consent-allow").disabled, false);
    await f.checkManual(false);
    assert.equal(f.get("ai-consent-background").checked, false);
    await f.click("ai-consent-revoke");
    assert.equal(f.consent.status().manual, false);
    assert.equal(f.consent.status().background, false);
    assert.equal(f.get("ai-consent-manual").disabled, false);
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
  }
});

test("Settings: closing and reopening during a pending read does not join or paint the old session", async t => {
  const f = await settingsLifecycle(t), accountGate = deferred(), permissionGate = deferred();
  f.get("ai-model").value = "draft-before-close"; f.ui.run("paintAiDirty()");
  f.interceptReply.set("host:aiConsentStatus", () => permissionGate.promise);
  const oldPermission = f.component.refreshConsent(); await tick();
  f.interceptReply.delete("host:aiConsentStatus");
  f.close();
  f.interceptReply.set("host:chatgptStatus", () => accountGate.promise);
  const oldOpen = f.open(); await tick();
  f.close(); f.interceptReply.delete("host:chatgptStatus");
  const newOpen = f.open(); await tick();
  assert.equal(f.get("ai-consent-connection").disabled, false, "new session does not await the old account read");
  assert.equal(f.get("settings-ai").querySelector(".fold-panel").inert, false);
  await newOpen;
  await f.click("ai-consent-connection");
  await f.checkManual(true);
  f.get("ai-consent-background").checked = true;
  await f.click("ai-consent-revoke");
  const destination = f.get("ai-consent-destination").textContent;
  assert.match(destination, /draft-before-close/);
  accountGate.resolve(); permissionGate.resolve(); await oldOpen; await oldPermission; await tick();
  assert.equal(f.get("ai-consent-destination").textContent, destination);
  assert.equal(f.get("ai-consent-manual").checked, false);
  assert.equal(f.get("ai-consent-background").checked, false);
  assert.equal(f.get("ai-consent-manual").disabled, false);
  assert.equal(f.get("ai-consent-allow").disabled, true);
  assert.equal(f.consent.status().manual, false);
  assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
});

test("Settings: Cancel / revoke after reopening a dirty draft defeats an earlier pending Allow", async t => {
  const f = await settingsLifecycle(t), gate = deferred();
  await f.checkManual(true);
  f.get("ai-consent-background").checked = true;
  f.intercept.set("host:aiConsentGrant", () => gate.promise);
  f.get("ai-consent-allow").click(); await tick();
  assert.equal(f.get("ai-consent-allow").disabled, true);
  f.get("ai-model").value = "draft-after-pending-allow"; f.ui.run("paintAiDirty()");
  f.close(); await f.open();
  await f.click("ai-consent-revoke");
  assert.equal(f.consent.status().manual, false);
  gate.resolve(); await tick();
  assert.equal(f.consent.status().manual, false, "revocation invalidates the old grant token at the host");
  assert.equal(f.consent.status().background, false);
  assert.equal(f.get("ai-consent-manual").checked, false);
  assert.equal(f.get("ai-consent-background").checked, false);
  assert.match(f.get("ai-consent-reason").textContent, /Unsaved.*Save.*review/);
  await f.click("ai-consent-connection");
  assert.equal(f.config.loadConfig().model, "draft-after-pending-allow");
  assert.equal(f.get("ai-consent-manual").disabled, false);
  assert.equal(f.get("ai-consent-allow").disabled, true);
  assert.equal(f.consent.status().manual, false); f.assertNoModelCalls();
});

test("actual preload and Settings read saved consent; affirmative manual and separate background choices reach validated host handlers", async () => {
  const f = fixture(); await f.load();
  assert.match(f.get("ai-consent-destination").textContent, /synthetic\.invalid.*fixture-model/);
  assert.doesNotMatch(f.get("ai-consent-status").textContent, /Unsupported channel/);
  assert.equal(f.consent.status().manual, false); assert.equal(f.writes, 0);
  assert.equal(f.get("ai-consent-allow").disabled, true); assert.equal(f.get("ai-consent-background").disabled, true);
  await f.get("ai-consent-allow").fire("click"); assert.equal(f.writes, 0);
  await f.checkManual(true); assert.equal(f.get("ai-consent-allow").disabled, false);
  assert.match(f.get("ai-consent-status").textContent, /make an explicit choice/);
  assert.equal(f.get("ai-consent-allow").title || "", "");
  await f.get("ai-consent-allow").fire("click");
  assert.equal(f.consent.status().manual, true); assert.equal(f.consent.status().background, false);
  assert.throws(() => f.consent.acquire(f.config.loadConfig(), { background: true }), /Background AI is off/);
  assert.ok(f.gateCalls > 0); assert.match(f.get("ai-consent-status").textContent, /Explicit AI actions allowed.*Background AI off/);
  const lease = f.consent.acquire(f.config.loadConfig());
  await f.get("ai-consent-revoke").fire("click");
  assert.equal(lease.signal.aborted, true); lease.release();
  assert.equal(f.consent.status().manual, false); assert.equal(f.get("ai-consent-manual").checked, false);
  await f.checkManual(true); f.get("ai-consent-background").checked = true;
  await f.get("ai-consent-allow").fire("click"); assert.equal(f.consent.status().background, true);
  await f.checkManual(false); assert.equal(f.get("ai-consent-background").checked, false);
  f.assertNoModelCalls();
});

test("unready saved API/ChatGPT connections cannot enable Allow through the real bridge", async () => {
  const cases = [
    { config: { apiKey: "" }, status: /Save an API key, then review this connection again/ },
    { config: { authMode: "chatgpt", chatgptModel: "fixture-chat" }, account: { connected: false }, status: /Connect ChatGPT, then review this connection again/ },
    { config: { authMode: "chatgpt", chatgptModel: "fixture-chat" }, account: { planEnabled: false }, status: /Enable ChatGPT plan usage, then review this connection again/ },
    { config: { authMode: "chatgpt", chatgptModel: "" }, status: /Save a ChatGPT model, then review this connection again/ },
    { config: { authMode: "chatgpt", chatgptModel: "" }, account: { connected: false }, status: /Connect ChatGPT and save a ChatGPT model, then review this connection again/ },
    { config: { authMode: "chatgpt", chatgptModel: "" }, account: { planEnabled: false }, status: /Enable ChatGPT plan usage and save a ChatGPT model, then review this connection again/ },
  ];
  for (const options of cases) {
    const f = fixture(options); await f.load(); await f.checkManual(true);
    f.get("ai-consent-background").checked = true;
    assert.equal(f.consent.status().ready, false);
    assert.match(f.consent.status().blocker, options.status);
    assert.doesNotMatch(f.consent.status().blocker, /synthetic-not-real|fixture-account/);
    assert.equal(f.get("ai-consent-allow").disabled, true);
    assert.match(f.get("ai-consent-allow").title, options.status);
    assert.match(f.get("ai-consent-status").textContent, new RegExp(`AI data use is off\\. ${options.status.source}`));
    assert.doesNotMatch(f.get("ai-consent-status").textContent, /make an explicit choice/);
    assert.match(f.get("ai-consent-reason").textContent, options.status);
    await f.get("ai-consent-connection").fire("click");
    assert.equal(f.calls.some(row => row.channel === "host:chatgptStart" || row.channel === "host:aiTest"), false, "review only focuses connection controls");
    await f.get("ai-consent-allow").fire("click");
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); assert.equal(f.writes, 0);
    const status = await f.bridge.invoke("host:aiConsentStatus");
    await assert.rejects(f.bridge.invoke("host:aiConsentGrant", { token: status.token, manual: true, background: false }), /permission changed/);
    assert.equal(f.writes, 0); assert.equal(f.consent.status().manual, false);
    assert.doesNotMatch(f.get("ai-consent-status").textContent, /Unsupported channel/); f.assertNoModelCalls();
  }
});

test("connection validation and legacy-channel failures explain recovery and never approve a checked form", async () => {
  const f = fixture(); await f.load();
  f.get("ai-base").value = "file:///synthetic-invalid"; f.ui.run("paintAiDirty()");
  await f.checkManual(true); await f.get("ai-consent-connection").fire("click"); await tick();
  assert.equal(f.get("ai-consent-allow").disabled, true);
  assert.equal(f.consent.status().manual, false);
  assert.match(f.get("ai-status").textContent, /HTTP\(S\)/);
  assert.match(f.get("ai-consent-reason").textContent, /Unsaved.*Save.*review/);
  assert.equal(f.get("ai-base").value, "file:///synthetic-invalid");
  f.get("ai-base").value = f.config.loadConfig().baseUrl; f.ui.run("paintAiDirty()");
  f.intercept.set("host:aiConsentStatus", () => { throw Error("Unsupported channel"); });
  await f.component.refreshConsent();
  assert.match(f.get("ai-consent-reason").textContent, /Unsupported channel.*Update Morrow Mail/);
  assert.equal(f.get("ai-consent-manual").checked, false);
  f.intercept.delete("host:aiConsentStatus");
  await f.get("ai-consent-connection").fire("click"); await tick();
  assert.match(f.get("ai-consent-reason").textContent, /Select explicit AI actions/);
  assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
});

test("an unsaved key explains the blocked Allow and Save & review repairs the saved prerequisite without granting consent", async () => {
  const f = fixture({ config: { apiKey: "" } }); await f.load();
  f.get("ai-key").value = "synthetic-new-key"; f.ui.run("paintAiDirty()");
  await f.checkManual(true);
  assert.equal(f.consent.status().ready, false, "typing a key does not save a connection");
  assert.equal(f.get("ai-consent-allow").disabled, true);
  assert.match(f.get("ai-consent-reason").textContent, /Save.*review/i);
  await f.get("ai-consent-connection").fire("click"); await tick();
  assert.equal(f.config.loadConfig().apiKey, "synthetic-new-key");
  assert.equal(f.consent.status().ready, true);
  assert.equal(f.consent.status().manual, false);
  assert.equal(f.get("ai-consent-manual").checked, false, "saving needs a fresh affirmative choice");
  await f.checkManual(true); assert.equal(f.get("ai-consent-allow").disabled, false);
  assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
});

test("unsaved provider/model edits cannot approve the earlier saved target and delayed status blocks Allow until reviewed", async () => {
  for (const field of ["ai-model", "ai-base"]) {
    const f = fixture(); await f.load(); await f.checkManual(true);
    f.get(field).value = field === "ai-model" ? "unsaved-model" : "https://unsaved.synthetic.invalid/v1";
    f.ui.run("paintAiDirty()");
    assert.equal(f.get("ai-consent-allow").disabled, true);
    assert.equal(f.get("ai-consent-manual").checked, false);
    await f.get("ai-consent-allow").fire("click");
    assert.equal(f.consent.status().manual, false);
    const gate = deferred(); f.intercept.set("host:aiConsentStatus", () => gate.promise);
    await f.ui.run("saveAiSettings()"); await tick();
    await f.checkManual(true);
    assert.equal(f.get("ai-consent-allow").disabled, true, "old readiness cannot enable Allow during a fresh read");
    gate.resolve(); await tick();
    assert.equal(f.get("ai-consent-manual").checked, false);
    f.assertNoModelCalls();
  }
});

test("edits made while the initial permission read is pending stay unsaved after loading finishes", async () => {
  const f = fixture(), gate = deferred();
  f.intercept.set("host:aiConsentStatus", () => gate.promise);
  const loading = f.load(); await tick();
  f.get("ai-model").value = "edited-during-load"; f.ui.run("paintAiDirty()");
  gate.resolve(); await loading;
  assert.equal(f.config.loadConfig().model, "fixture-model");
  assert.equal(f.get("ai-model").value, "edited-during-load");
  assert.equal(f.ui.run("aiDirty()"), true);
  await f.checkManual(true);
  assert.equal(f.get("ai-consent-allow").disabled, true);
  assert.match(f.get("ai-consent-reason").textContent, /Unsaved.*Save.*review/);
  assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
});

test("exposing the channels retains host token/manual/background validation and rejects unknown channels before IPC", async () => {
  const f = fixture(); await f.load(); const status = await f.bridge.invoke("host:aiConsentStatus");
  for (const input of [{ token: "stale", manual: true, background: false }, { token: status.token, manual: false, background: false },
    { token: status.token, manual: true }, { token: status.token, manual: true, background: "yes" }]) {
    await assert.rejects(f.bridge.invoke("host:aiConsentGrant", input), /permission changed|Affirmatively/);
  }
  assert.equal(f.writes, 0); assert.equal(f.consent.status().manual, false);
  const count = f.calls.length;
  for (const name of ["host:aiConsent", "host:aiConsentDelete", "host:aiConsentStatus:extra", "host:unknownConsent", "unknown:channel"]) {
    await assert.rejects(f.bridge.invoke(name), /Unsupported channel/);
  }
  assert.equal(f.calls.length, count); f.assertNoModelCalls();
});

test("a destination/model changed in another window invalidates the old Settings checkbox/token until fresh review", async () => {
  for (const change of [{ baseUrl: "https://second.synthetic.invalid/v1" }, { model: "new-fixture-model" }]) {
    const f = fixture(); await f.load(); await f.checkManual(true);
    f.config.saveConfig(change); // The real save/invalidation logic, memory-only.
    await f.get("ai-consent-allow").fire("click");
    assert.equal(f.consent.status().manual, false); assert.equal(f.get("ai-consent-manual").checked, false);
    assert.match(f.get("ai-consent-status").textContent, /destination.*permission changed/);
    assert.equal(f.get("ai-consent-allow").disabled, true);
    await f.get("ai-consent-refresh").fire("click");
    assert.equal(f.get("ai-consent-manual").checked, false);
    await f.checkManual(true); await f.get("ai-consent-allow").fire("click");
    assert.equal(f.consent.status().manual, true); assert.equal(f.consent.status().background, false); f.assertNoModelCalls();
  }
});

test("Save AI through Settings refreshes the saved binding without approving the new model", async () => {
  const f = fixture(); await f.load(); await f.checkManual(true); await f.get("ai-consent-allow").fire("click");
  f.get("ai-model").value = "saved-new-model";
  await f.ui.run("saveAiSettings()"); await tick();
  assert.equal(f.config.loadConfig().model, "saved-new-model"); assert.equal(f.consent.status().manual, false);
  assert.equal(f.get("ai-consent-manual").checked, false); assert.equal(f.get("ai-consent-allow").disabled, true);
  assert.match(f.get("ai-consent-destination").textContent, /saved-new-model/); f.assertNoModelCalls();
});

test("status and persistence errors leave Settings unapproved; failed revoke still stops host use", async () => {
  const f = fixture(); f.intercept.set("host:aiConsentStatus", () => { throw Error("Synthetic status failure"); });
  await f.load(); await f.checkManual(true);
  assert.match(f.get("ai-consent-status").textContent, /Synthetic status failure/); assert.equal(f.get("ai-consent-allow").disabled, true);
  f.intercept.delete("host:aiConsentStatus"); await f.get("ai-consent-refresh").fire("click");
  await f.checkManual(true); f.failWrites(true); await f.get("ai-consent-allow").fire("click");
  assert.equal(f.consent.status().manual, false); assert.equal(f.get("ai-consent-manual").checked, false);
  assert.match(f.get("ai-consent-status").textContent, /Synthetic persistence failure/);
  f.failWrites(false); await f.get("ai-consent-refresh").fire("click"); await f.checkManual(true); await f.get("ai-consent-allow").fire("click");
  const lease = f.consent.acquire(f.config.loadConfig()); f.failWrites(true); await f.get("ai-consent-revoke").fire("click");
  assert.equal(lease.signal.aborted, true); lease.release(); assert.equal(f.consent.status().manual, false);
  assert.equal(f.get("ai-consent-allow").disabled, true); f.assertNoModelCalls();
});

test("pending grant disables repeated clicks and defers review refresh; a changed model cannot win the pending grant", async () => {
  for (const changeModel of [false, true]) {
    const f = fixture(), gate = deferred(); await f.load(); await f.checkManual(true);
    f.intercept.set("host:aiConsentGrant", () => gate.promise);
    const pending = f.get("ai-consent-allow").fire("click"); await tick();
    assert.equal(f.get("ai-consent-allow").disabled, true);
    const reads = f.calls.filter(row => row.channel === "host:aiConsentStatus").length;
    await f.get("ai-consent-allow").fire("click"); await f.component.refreshConsent();
    assert.equal(f.calls.filter(row => row.channel === "host:aiConsentGrant").length, 1);
    assert.equal(f.calls.filter(row => row.channel === "host:aiConsentStatus").length, reads);
    if (changeModel) f.config.saveConfig({ model: "changed-while-pending" });
    gate.resolve(); await pending; await tick();
    assert.equal(f.consent.status().manual, !changeModel);
    assert.ok(f.calls.filter(row => row.channel === "host:aiConsentStatus").length > reads);
    f.assertNoModelCalls();
  }
});

test("the existing AI Setup preload still uses the same explicit consent handlers; closing Settings disables its controls", async () => {
  const f = fixture(), setup = f.preload("host/setup-preload.js").aiSetup;
  const status = await setup.consentStatus(); assert.equal(status.manual, false);
  await setup.consentGrant({ token: status.token, manual: true, background: false });
  assert.equal(f.consent.status().manual, true); await setup.consentRevoke(); assert.equal(f.consent.status().manual, false);
  await f.load(); f.component.dispose(); assert.equal(f.get("ai-consent-allow").disabled, true);
  await f.get("ai-consent-allow").fire("click"); assert.equal(f.consent.status().manual, false); f.assertNoModelCalls();
});

test("ready ChatGPT consent stays bound to its selected account and separately chosen background use", async () => {
  const f = fixture({ config: { authMode: "chatgpt", chatgptModel: "fixture-chat" } }); await f.load();
  await f.checkManual(true); await f.get("ai-consent-allow").fire("click");
  assert.equal(f.consent.status().manual, true); assert.equal(f.consent.status().background, false);
  assert.equal((await f.bridge.invoke("host:chatgptStatus")).backgroundConsent, false);
  const lease = f.consent.acquire(f.config.loadConfig());
  await f.bridge.invoke("host:chatgptSelect", "another-synthetic-account");
  assert.equal(lease.signal.aborted, true); lease.release(); assert.equal(f.consent.status().manual, false);
  await f.get("ai-consent-refresh").fire("click");
  assert.equal(f.get("ai-consent-manual").checked, false); assert.equal(f.get("ai-consent-allow").disabled, true); f.assertNoModelCalls();
});

test("Features and Settings help render the same explicit consent prerequisites", async () => {
  const f = fixture(); await f.load();
  f.ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  f.ui.run("paintFeatureCatalog()");
  assert.match(f.get("features-catalog").textContent, /Settings → AI and AI Setup support review, allow and revoke; Allow requires a ready saved connection and the explicit-action checkbox/);
  assert.match(f.get("features-catalog").textContent, /If Allow stays unavailable, the status names the missing saved API key, model, ChatGPT connection, or plan step/);
  assert.match(f.get("features-catalog").textContent, /Save & review connection saves without approving/);
  assert.match(f.get("features-catalog").textContent, /Reopening Settings preserves unsaved connection edits and requires a fresh permission choice/);
  assert.match(source("renderer/index.html"), /id="ai-consent-help"[^>]*>Review the saved connection[\s\S]*?Background use is optional/);
  assert.match(source("renderer/index.html"), /id="ai-consent-help"[^>]*>[\s\S]*If Allow stays unavailable, the status names the missing saved API key, model, ChatGPT connection, or plan step/);
  f.assertNoModelCalls();
});

test("Settings and Setup keep material disclosure outside accordions, after connection controls, with accessible checkbox descriptions", async () => {
  const { JSDOM } = require("jsdom");
  for (const filename of ["renderer/index.html", "host/ai-setup.html"]) {
    const dom = new JSDOM(source(filename), { runScripts: "outside-only" });
    const f = fixture(), document = dom.window.document;
    dom.window.eval(source("renderer/chatgpt-settings.js"));
    const component = dom.window.morrowChatgptSettings.mount({ container: document.getElementById("ai-account-settings"),
      consentContainer: document.getElementById("ai-data-settings"), invoke: f.bridge.invoke });
    await component.load(f.config.publicConfig());
    const get = id => document.getElementById(id), permission = f.consent.status();
    assert.ok(get(filename.startsWith("host") ? "save" : "ai-save").compareDocumentPosition(get("ai-consent-title")) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    for (const id of ["ai-consent-destination", "ai-consent-locality", "ai-consent-data", "ai-consent-purposes", "ai-consent-background-data", "ai-consent-terms", "ai-consent-revocation"]) {
      assert.equal(get(id).closest("details"), null, id + " must stay visible before consent");
      assert.ok(get(id).textContent.length, id + " must contain material disclosure");
    }
    assert.equal(get("ai-consent-data").textContent, permission.dataSummary);
    assert.equal(get("ai-consent-full-data").textContent, permission.disclosure);
    assert.equal(get("ai-consent-full-background").textContent, permission.backgroundDisclosure);
    for (const category of ["sender addresses", "subjects", "dates", "snippets", "metadata", "selected message text", "quoted history", "drafts", "signatures", "selections", "instructions", "Brain profile", "identity", "categories", "writing rules", "Agent notes", "recent conversation", "event titles", "times", "locations", "Attachment files are excluded"]) {
      assert.ok(get("ai-consent-data").textContent.includes(category), category + " must stay in the visible data summary");
    }
    for (const purpose of ["translation", "reply suggestions", "writing", "profile learning", "triage", "skills", "answers"]) assert.ok(get("ai-consent-purposes").textContent.includes(purpose));
    for (const task of ["profile refresh", "opening Brain", "triage", "reply suggestions", "scheduled skills", "without another AI button press"]) assert.ok(get("ai-consent-background-data").textContent.includes(task));
    assert.equal(get("ai-consent-full-data").closest("details").open, false);
    for (const id of ["ai-consent-manual", "ai-consent-background", "ai-consent-allow"]) {
      const control = get(id);
      for (const description of control.getAttribute("aria-describedby").split(" ")) assert.ok(get(description));
      if (control.type === "checkbox") { assert.equal(control.checked, false); assert.equal(control.labels.length, 1); }
    }
    assert.match(get("ai-data-settings").textContent, /already delivered cannot be recalled/);
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false);
    f.assertNoModelCalls(); component.dispose(); dom.window.close();
  }
});
