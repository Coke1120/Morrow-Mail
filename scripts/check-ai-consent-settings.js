// Real preload -> Settings -> host handlers/validation. No live I/O or user state.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const { renderer } = require("./check-ux-workflows");
const root = path.join(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, name), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixtureDocument() {
  const html = source("renderer/index.html");
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

function fixture({ config: initial = {}, account: accountInput = {} } = {}) {
  const directory = "/synthetic-consent-settings", files = new Map(), calls = [], handlers = new Map(), intercept = new Map();
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
    return handlers.get(channel)(event, input);
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
  const bridge = preload().morrow, document = fixtureDocument(), get = id => document.getElementById(id);
  const ui = renderer({ document, window: { morrow: bridge, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  ui.run(source("renderer/chatgpt-settings.js"));
  ui.run("mountChatgptSettings()");
  const component = ui.run("chatgptSettings");
  return { bridge, preload, consent, config, ui, component, get, calls, intercept,
    load: async () => { await ui.run("loadAiSettings()"); await tick(); },
    checkManual: async value => { get("ai-consent-manual").checked = value; await get("ai-consent-manual").fire("change"); },
    failWrites: value => { failWrite = value; },
    assertNoModelCalls: () => assert.equal(modelCalls, 0),
    get writes() { return writes; }, get gateCalls() { return gateCalls; },
  };
}

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
    await f.get("ai-consent-allow").fire("click");
    assert.equal(f.calls.some(row => row.channel === "host:aiConsentGrant"), false); assert.equal(f.writes, 0);
    const status = await f.bridge.invoke("host:aiConsentStatus");
    await assert.rejects(f.bridge.invoke("host:aiConsentGrant", { token: status.token, manual: true, background: false }), /permission changed/);
    assert.equal(f.writes, 0); assert.equal(f.consent.status().manual, false);
    assert.doesNotMatch(f.get("ai-consent-status").textContent, /Unsupported channel/); f.assertNoModelCalls();
  }
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
  assert.match(source("renderer/index.html"), /id="ai-consent-help"[^>]*>Review the saved connection[\s\S]*?Background use is optional/);
  assert.match(source("renderer/index.html"), /id="ai-consent-help"[^>]*>[\s\S]*If Allow stays unavailable, the status names the missing saved API key, model, ChatGPT connection, or plan step/);
  f.assertNoModelCalls();
});
