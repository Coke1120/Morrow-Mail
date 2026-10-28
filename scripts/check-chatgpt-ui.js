// Synthetic DOM/VM QA. This does not navigate a browser or exercise native UI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { parseDocument, DomUtils } = require("htmlparser2");
const { renderer } = require("./check-ux-workflows");

class Element {
  constructor(node, document) {
    this.node = node; this.document = document; this.listeners = new Map(); this.dataset = {};
    this._value = node.attribs?.value || ""; this.checked = Object.hasOwn(node.attribs || {}, "checked");
    this.hidden = Object.hasOwn(node.attribs || {}, "hidden"); this.disabled = false; this.style = {};
    const classes = new Set((node.attribs?.class || "").split(/\s+/).filter(Boolean));
    this.classList = { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key), toggle(key, force) { if (force === undefined) force = !classes.has(key); force ? classes.add(key) : classes.delete(key); return force; } };
  }
  get id() { return this.node.attribs?.id || ""; }
  get options() { return (this.node.children || []).filter(node => node.name === "option").map(node => this.document.wrap(node)); }
  get children() { return (this.node.children || []).filter(node => node.type === "tag").map(node => this.document.wrap(node)); }
  get value() { return this.node.name === "select" ? this.options.find(option => option.value === this._value)?.value || "" : this._value; }
  set value(value) { this._value = String(value); }
  set textContent(value) { this.node.children = [{ type: "text", data: String(value), parent: this.node }]; }
  get textContent() { return DomUtils.textContent(this.node); }
  set innerHTML(value) { this.node.children = parseDocument(value).children; for (const child of this.node.children) child.parent = this.node; }
  get innerHTML() { return DomUtils.getInnerHTML(this.node); }
  setAttribute(name, value) { this.node.attribs[name] = String(value); }
  getAttribute(name) { return this.node.attribs?.[name] ?? null; }
  removeAttribute(name) { delete this.node.attribs[name]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = DomUtils.findAll(node => selector.startsWith("#") ? node.attribs?.id === selector.slice(1) : selector === "[data-ai-provider]" ? Object.hasOwn(node.attribs || {}, "data-ai-provider") : false, this.node.children || []);
    return found.map(node => this.document.wrap(node));
  }
  replaceChildren(...nodes) { this.node.children = nodes.map(node => node.node); for (const child of this.node.children) child.parent = this.node; }
  appendChild(node) { this.node.children ||= []; this.node.children.push(node.node); node.node.parent = this.node; return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  async fire(name) { if (name === "click" && this.disabled) return; await this.listeners.get(name)?.({ target: this }); }
  focus() { this.document.activeElement = this; }
}
function documentFor(html) {
  const dom = parseDocument(html); const wrappers = new WeakMap();
  const document = {
    activeElement: null,
    wrap(node) { if (!wrappers.has(node)) wrappers.set(node, new Element(node, document)); return wrappers.get(node); },
    getElementById(id) { const node = DomUtils.findOne(node => node.attribs?.id === id, dom.children, true); return node ? document.wrap(node) : null; },
    createElement(name) { return document.wrap(parseDocument(`<${name}></${name}>`).children[0]); },
    querySelectorAll(selector) { return document.wrap({ type: "root", children: dom.children }).querySelectorAll(selector); },
  };
  return document;
}
async function run() {
  const html = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
  const setup = fs.readFileSync(require.resolve("../host/ai-setup.html"), "utf8");
  const component = fs.readFileSync(require.resolve("../renderer/chatgpt-settings.js"), "utf8");
  const document = documentFor(html);
  const $ = id => document.getElementById(id);
  const calls = [];
  let callbackWait;
  let config = { authMode: "api_key", baseUrl: "https://synthetic.invalid/v1", model: "original-model", hasKey: true, keyHint: "••••test", chatgptModel: "" };
  let snapshot = { available: true, connected: false, pending: false, accounts: [], activeId: "", backgroundConsent: false };
  let permission = { ready: true, token: "fixture-permission", destination: "https://synthetic.invalid/v1/chat/completions", label: "Synthetic provider", model: "fixture-model", manual: false, background: false,
    disclosure: "Synthetic mail and calendar context", backgroundDisclosure: "Synthetic background tasks" };
  const invoke = async (channel, input) => {
    calls.push({ channel, input });
    if (channel === "host:aiConsentStatus") return { ...permission };
    if (channel === "host:aiConsentGrant") { permission = { ...permission, ...input, token: permission.token + "1" }; return { ...permission }; }
    if (channel === "host:aiConsentRevoke") { permission = { ...permission, manual: false, background: false, token: permission.token + "1" }; return { ...permission }; }
    if (channel === "host:aiGetConfig") return { ...config };
    if (channel === "host:aiSaveConfig") { config = { ...config, ...input }; delete config.apiKey; return { ...config }; }
    if (channel === "host:aiListModels") return { ok: true, models: ["synthetic-sol"], choices: [{ id: "synthetic-sol", name: "Synthetic Sol" }] };
    if (channel === "host:aiTest") return { ok: true, preview: "Synthetic response" };
    if (channel === "host:chatgptStart") snapshot = { ...snapshot, pending: true, phase: "waiting", message: "Waiting in browser" };
    if (channel === "host:chatgptCancel") snapshot = { ...snapshot, pending: false, phase: "cancelled", message: "Sign-in cancelled" };
    if (channel === "host:chatgptCallback") { assert.equal($("chatgpt-callback").value, ""); if (callbackWait) await callbackWait; throw new Error("Synthetic invalid callback"); }
    if (channel === "host:chatgptPreferences") snapshot = { ...snapshot, ...input };
    if (channel === "host:chatgptSignOut") snapshot = { ...snapshot, connected: false, backgroundConsent: false, message: "Signed out locally; remote revocation not confirmed" };
    return structuredClone(snapshot);
  };
  const ui = renderer({ document, window: { morrow: { invoke } }, Event: class { constructor(type) { this.type = type; } },
    setTimeout: () => 1, clearTimeout() {},
  });
  ui.run(component);
  await ui.run("loadAiSettings()");
  assert.equal($("ai-auth-mode").value, "api_key");
  assert.equal($("chatgpt-panel").hidden, true);
  assert.equal($("ai-base").value, config.baseUrl);
  assert.equal(ui.run("aiDirty()"), false);
  $("ai-auth-mode").value = "chatgpt"; await $("ai-auth-mode").fire("change");
  assert.equal($("chatgpt-panel").hidden, false);
  assert.equal($("ai-api-key-field").hidden, true);
  assert.equal($("ai-consent-manual").checked, false);
  assert.equal($("ai-consent-background").checked, false);
  assert.equal(ui.run("aiDirty()"), true);
  snapshot = { ...snapshot, available: false, message: "Synthetic secure storage locked" };
  await $("chatgpt-refresh").fire("click");
  assert.equal($("chatgpt-login").disabled, true);
  assert.match($("chatgpt-status").textContent, /storage locked/);
  snapshot = { ...snapshot, available: true };
  await $("chatgpt-refresh").fire("click");
  assert.equal($("chatgpt-login").disabled, false, "refresh permits retry after secure storage is unlocked");
  await $("chatgpt-login").fire("click");
  assert.equal($("chatgpt-cancel").hidden, false);
  assert.equal($("chatgpt-login").disabled, true);
  await $("chatgpt-cancel").fire("click");
  assert.equal($("chatgpt-login").disabled, false, "cancel enables a new attempt");
  await $("chatgpt-login").fire("click");
  $("chatgpt-callback").value = "http://127.0.0.1:12345/auth/callback?code=synthetic-sensitive&state=synthetic";
  await $("chatgpt-submit").fire("click");
  await new Promise(done => setImmediate(done));
  assert.equal($("chatgpt-callback").value, "");
  assert.match($("chatgpt-status").textContent, /invalid callback/);
  let releaseCallback;
  callbackWait = new Promise(resolve => { releaseCallback = resolve; });
  $("chatgpt-callback").value = "http://127.0.0.1:12345/auth/callback?code=synthetic&state=synthetic";
  await $("chatgpt-submit").fire("click");
  assert.equal($("chatgpt-login").disabled, true);
  await $("chatgpt-cancel").fire("click");
  assert.equal(calls.at(-1).channel, "host:chatgptCancel", "cancel remains usable while exchange awaits IPC");
  releaseCallback();
  await new Promise(done => setImmediate(done));
  callbackWait = null;
  assert.equal($("chatgpt-login").disabled, false);
  snapshot = { ...snapshot, pending: false, connected: true, planEnabled: true, activeId: "synthetic-account", accounts: [{ id: "synthetic-account", label: "Synthetic account · 123456", connected: true }], message: "Connected", welcome: true };
  await ui.run("chatgptSettings.refresh()");
  assert.equal($("chatgpt-signout").disabled, false);
  assert.equal($("chatgpt-welcome").hidden, false);
  assert.equal($("ai-consent-allow").disabled, true, "unsaved mode must be saved before permission");
  await ui.run("fetchAiModels()");
  assert.deepEqual($("chatgpt-model").options.map(row => row.textContent), ["Choose an available ChatGPT model", "Synthetic Sol"]);
  $("chatgpt-model").value = "synthetic-sol"; await $("chatgpt-model").fire("change");
  await ui.run("saveAiSettings()");
  assert.equal(config.authMode, "chatgpt"); assert.equal(config.chatgptModel, "synthetic-sol");
  assert.equal(config.baseUrl, "https://synthetic.invalid/v1"); assert.equal(config.model, "original-model");
  await new Promise(done => setImmediate(done));
  $("ai-consent-manual").checked = true; await $("ai-consent-manual").fire("change");
  $("ai-consent-background").checked = true;
  await $("ai-consent-allow").fire("click");
  assert.equal(calls.at(-1).input.background, true);
  assert.match($("ai-consent-status").textContent, /Background AI allowed/);
  await ui.run("testAiConnection()");
  assert.equal(calls.at(-1).input.authMode, "chatgpt");
  assert.equal(calls.at(-1).input.chatgptModel, "synthetic-sol");
  await $("chatgpt-signout").fire("click");
  assert.match($("chatgpt-status").textContent, /revocation not confirmed/);
  await $("ai-consent-revoke").fire("click");
  assert.equal($("ai-consent-background").checked, false);
  $("ai-auth-mode").value = "api_key"; await $("ai-auth-mode").fire("change");
  await ui.run("saveAiSettings()");
  assert.equal($("chatgpt-panel").hidden, true);
  assert.equal($("ai-api-key-field").hidden, false);
  assert.equal(config.model, "original-model");
  assert.equal(config.authMode, "api_key");
  const feature = require("../renderer/features-catalog").items.find(row => row.id === "ai-connection");
  assert.ok(feature);
  for (const claim of ["Continue with ChatGPT", "Cancel", "paste-back", "separate background opt-in", "Native and live", "newer edits unsaved", "fresh retry", "current settings", "AI data permission"]) assert.ok(feature.blurb.includes(claim), claim);
  for (const claim of ["ChatGPT", "credentials are not exposed", "API key/custom endpoint", "no general-purpose"]) assert.ok($("cli-ai-connection").textContent.includes(claim), claim);
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.run("paintFeatureCatalog()");
  assert.match($("features-catalog").textContent, /ChatGPT or API key/);
  assert.match($("features-catalog").textContent, /Background profile refresh/);
  assert.match($("features-catalog").textContent, /Save keeps newer edits unsaved/);
  assert.match($("chatgpt-manual").textContent, /fresh attempt immediately/);
  assert.match($("ai-connection-details").textContent, /edits made while saving remain unsaved/);
  for (const source of [html, setup]) assert.ok(source.includes("chatgpt-settings.js"));
  assert.ok(setup.includes('id="ai-account-settings"'));
  assert.ok(setup.includes("Results from older tests or changed settings are ignored."));
  assert.ok(!/localStorage|sessionStorage|console\./.test(component));
  // Execute the actual native Setup controller with the same shared component.
  // This checks its renderer logic; it does not instantiate an Electron window.
  const setupDoc = documentFor(setup);
  const bridge = {
    get: () => invoke("host:aiGetConfig"), save: input => invoke("host:aiSaveConfig", input),
    test: input => invoke("host:aiTest", input), listModels: input => invoke("host:aiListModels", input),
  };
  for (const name of ["Status", "Grant", "Revoke"]) bridge[`consent${name}`] = input => invoke(`host:aiConsent${name}`, input);
  for (const name of ["Status", "Start", "Callback", "Cancel", "SignOut", "Select", "Preferences", "ResumeUsage"]) bridge[`chatgpt${name}`] = input => invoke(`host:chatgpt${name}`, input);
  const setupContext = vm.createContext({ document: setupDoc, window: { aiSetup: bridge, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(component, setupContext);
  vm.runInContext(fs.readFileSync(require.resolve("../host/ai-setup.js"), "utf8"), setupContext);
  await new Promise(done => setImmediate(done));
  assert.equal(setupDoc.getElementById("ai-auth-mode").value, "api_key");
  setupDoc.getElementById("ai-auth-mode").value = "chatgpt";
  await setupDoc.getElementById("ai-auth-mode").fire("change");
  assert.equal(setupDoc.getElementById("api-fields").hidden, true);
  await setupDoc.getElementById("fetch").onclick();
  setupDoc.getElementById("chatgpt-model").value = "synthetic-sol";
  await setupDoc.getElementById("save").onclick();
  assert.equal(config.authMode, "chatgpt");
  await setupDoc.getElementById("test").onclick();
  assert.equal(calls.at(-1).input.authMode, "chatgpt");
  assert.equal(calls.at(-1).input.chatgptModel, "synthetic-sol");
  ui.context.window.addEventListener = () => {};
  document.addEventListener = () => {};
  ui.run(fs.readFileSync(require.resolve("../renderer/ai-provider-indicator.js"), "utf8"));
  await new Promise(done => setImmediate(done));
  assert.ok(document.querySelectorAll("[data-ai-provider]").every(node => !node.hidden));
  ui.context.window.morrowAiIndicator.paint({ authMode: "api_key" });
  assert.ok(document.querySelectorAll("[data-ai-provider]").every(node => node.hidden));
  console.log("chatgpt-ui-ok: settings mode/login/cancel/manual callback/consent/models/save/test/logout and Features/CLI using synthetic DOM; no browser/native/live validation");
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run, documentFor };
