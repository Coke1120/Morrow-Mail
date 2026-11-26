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
  return { seedConsent: record => files.set(path.join(directory, "ai-consent.json"), JSON.stringify(record)), bridge, preload, consent, config, ui, component, get, calls, intercept, interceptReply,
    load: async () => { await ui.run("loadAiSettings()"); await tick(); },
    async chooseProcessing(value) {
      const control = get("ai-automatic-processing");
      control.value = value;
      control.dispatchEvent(new document.defaultView.Event("change"));
      await tick();
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

test("Settings and Setup: saving ChatGPT keeps the API connection saved by the other window", async t => {
  for (const older of ["settings", "setup"]) {
    const f = await settingsLifecycle(t, { config: { chatgptModel: "fixture-chat" } });
    const setup = setupLifecycle(t, f);
    await tick();
    const nextBase = "https://new.synthetic.invalid/v1", nextModel = "new-api-model";
    if (older === "settings") {
      setup.edit("baseUrl", nextBase);
      setup.edit("model", nextModel);
      await setup.get("save").onclick();
    } else {
      f.get("ai-base").value = nextBase;
      f.get("ai-model").value = nextModel;
      await f.ui.run("saveAiSettings()");
    }
    const get = older === "settings" ? f.get : setup.get;
    const mode = get("ai-auth-mode");
    mode.value = "chatgpt";
    mode.dispatchEvent(new mode.ownerDocument.defaultView.Event("change"));
    assert.equal(f.config.publicConfig().authMode, "api_key", "selecting a mode does not save");
    if (older === "settings") await f.ui.run("saveAiSettings()");
    else await get("save").onclick();
    const saved = f.config.publicConfig();
    assert.equal(saved.authMode, "chatgpt");
    assert.equal(saved.chatgptModel, "fixture-chat");
    assert.equal(saved.baseUrl, nextBase);
    assert.equal(saved.model, nextModel);
    assert.equal(get(older === "settings" ? "ai-base" : "baseUrl").value, nextBase);
    assert.equal(get(older === "settings" ? "ai-model" : "model").value, nextModel);
    assert.equal(get(older === "settings" ? "ai-status" : "status").textContent, "Saved.");
    const payload = f.calls.filter(row => row.channel === "host:aiSaveConfig").at(-1).input;
    for (const field of ["baseUrl", "model", "apiKey"]) assert.equal(Object.hasOwn(payload, field), false);
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false);
  }
});

test("Setup: a late initial account read cannot overwrite a successful save baseline or newer edits", async t => {
  for (const editAgain of [false, true]) {
    const f = fixture(), gate = deferred();
    f.intercept.set("host:chatgptStatus", () => gate.promise);
    const setup = setupLifecycle(t, f);
    await tick();
    assert.equal(setup.get("save").disabled, false);
    setup.edit("model", "saved-during-initial-load");
    await setup.get("save").onclick();
    assert.equal(setup.run("formState(draft()) !== formState(savedBaseline)"), false);
    if (editAgain) setup.edit("model", "newer-unsaved-model");
    gate.resolve(); await tick();
    assert.equal(f.config.loadConfig().model, "saved-during-initial-load");
    assert.equal(setup.run("formState(draft()) !== formState(savedBaseline)"), editAgain);
    assert.equal(setup.get("model").value, editAgain ? "newer-unsaved-model" : "saved-during-initial-load");
    if (editAgain) await setup.get("save").onclick();
    await tick();
    assert.equal(setup.run("formState(draft()) !== formState(savedBaseline)"), false);
    assert.equal(setup.get("ai-automatic-processing").value, "manual");
    assert.equal(setup.get("ai-automatic-processing").disabled, false);
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); f.assertNoModelCalls();
  }
});

test("both preloads expose the automatic preference and reject unknown channels", async t => {
  const f = await settingsLifecycle(t);
  const setup = setupLifecycle(t, f);
  await tick();
  for (const get of [f.get, setup.get]) {
    assert.equal(get("ai-automatic-processing").value, "manual");
    assert.equal(get("ai-consent-manual"), null);
    assert.equal(get("ai-consent-details"), null);
  }
  assert.equal(f.writes, 0);
  const token = f.consent.stamp();
  await assert.rejects(f.bridge.invoke("host:aiConsentGrant", { token, background: false }));
  await assert.rejects(f.bridge.invoke("host:aiConsentGrant", { token: "stale", background: true }));
  const total = f.calls.length;
  await assert.rejects(f.bridge.invoke("host:fakeGrant"), /Unsupported channel/);
  assert.equal(f.calls.length, total);
  await f.chooseProcessing("automatic");
  assert.equal(f.consent.status().background, true);
  assert.deepEqual(Object.keys(f.calls.find(row => row.channel === "host:aiConsentGrant" && row.input.background === true && row.input.token === token).input).sort(), ["background", "token"]);
  await f.chooseProcessing("manual");
  assert.equal(f.consent.status().background, false);
  f.assertNoModelCalls();
});

test("Settings preserves newer edits and retires pending reads when reopened", async t => {
  for (const [field, value] of [["ai-model", "draft-model"], ["ai-base", "https://draft.synthetic.invalid/v1"],
    ["ai-key", "synthetic-key"], ["ai-auth-mode", "chatgpt"]]) {
    const f = await settingsLifecycle(t, { config: { chatgptModel: "fixture-chat" } });
    f.get(field).value = value;
    f.ui.run("paintAiDirty()");
    const gate = deferred();
    f.interceptReply.set("host:aiConsentStatus", () => gate.promise);
    const reading = f.component.refreshConsent();
    await tick();
    f.interceptReply.delete("host:aiConsentStatus");
    f.close(); await f.open();
    gate.resolve(); await reading;
    assert.equal(f.get(field).value, value);
    assert.equal(f.ui.run("aiDirty()"), true);
    assert.equal(f.get("ai-automatic-processing").disabled, true);
    await f.ui.run("saveAiSettings()"); await tick();
    assert.equal(f.ui.run("aiDirty()"), false);
    assert.equal(f.get("ai-automatic-processing").disabled, false);
    assert.equal(f.get("ai-automatic-processing").value, "manual");
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false);
    f.assertNoModelCalls();
  }
});

test("unready targets and an obsolete pending grant fail closed", async t => {
  for (const initial of [{ config: { apiKey: "" } },
    { config: { authMode: "chatgpt", chatgptModel: "fixture-chat" }, account: { planEnabled: false } }]) {
    const f = await settingsLifecycle(t, initial);
    assert.equal(f.get("ai-automatic-processing").disabled, true);
    assert.ok(f.get("ai-automatic-status").textContent);
    await assert.rejects(f.bridge.invoke("host:aiConsentGrant", { token: f.consent.stamp(), background: true }));
    assert.equal(f.writes, 0);
  }
  const f = await settingsLifecycle(t), gate = deferred();
  f.intercept.set("host:aiConsentGrant", () => gate.promise);
  await f.chooseProcessing("automatic");
  assert.equal(f.get("ai-automatic-processing").disabled, true);
  f.get("ai-model").value = "changed-while-enabling";
  await f.ui.run("saveAiSettings()");
  gate.resolve(); await tick(); await tick();
  assert.equal(f.config.loadConfig().model, "changed-while-enabling");
  assert.equal(f.consent.status().background, false);
  assert.equal(f.get("ai-automatic-processing").value, "manual");
  f.assertNoModelCalls();
});

test("persistence failure cannot leave the automatic lease active", async t => {
  const f = await settingsLifecycle(t);
  await f.chooseProcessing("automatic");
  const lease = f.consent.acquire(f.config.loadConfig(), { stamp: f.consent.stamp(), background: true });
  f.failWrites(true);
  await f.chooseProcessing("manual");
  assert.equal(f.consent.status().background, false);
  assert.equal(lease.signal.aborted, true);
  assert.match(f.get("ai-automatic-status").textContent, /persistence failure/);
  lease.release();
  f.assertNoModelCalls();
});

test("selecting the active ChatGPT account preserves background settings and a live lease", async t => {
  const f = await settingsLifecycle(t, { config: { authMode: "chatgpt", chatgptModel: "fixture-chat" } });
  await f.chooseProcessing("automatic");
  const lease = f.consent.acquire(f.config.loadConfig(), { stamp: f.consent.stamp(), background: true });
  const before = f.writes;
  f.get("chatgpt-account").value = "fixture-account";
  await f.click("chatgpt-select");
  assert.equal(f.component.draft().chatgptModel, "fixture-chat");
  assert.equal(f.ui.run("aiDirty()"), false);
  assert.equal(f.get("ai-automatic-processing").value, "automatic");
  assert.equal(f.writes, before);
  lease.check();
  await f.bridge.invoke("host:chatgptSelect", "different-account");
  assert.equal(lease.signal.aborted, true);
  assert.equal(f.consent.status().background, false);
  lease.release();
  f.assertNoModelCalls();
});
