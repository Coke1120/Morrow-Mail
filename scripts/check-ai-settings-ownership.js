// Actual controllers in synthetic DOM/VM; every IPC/provider/store is a fixture.
// No browser, native window, real credentials, mail or external request is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const { documentFor } = require("./check-chatgpt-ui");
const { renderer } = require("./check-ux-workflows");
const { createAuth, ISSUER } = require("../host/chatgpt-auth");
const component = fs.readFileSync(require.resolve("../renderer/chatgpt-settings.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const initialConfig = () => ({ authMode: "api_key", baseUrl: "https://synthetic.invalid/v1", model: "api-original", chatgptModel: "chat-original", hasKey: true, keyHint: "••••fake" });
const initialStatus = () => ({ available: true, connected: false, planEnabled: false, pending: false, activeId: "", accounts: [], backgroundConsent: false });

async function fixture(kind) {
  const native = kind === "setup";
  const html = fs.readFileSync(require.resolve(native ? "../host/ai-setup.html" : "../renderer/index.html"), "utf8");
  const document = documentFor(html), $ = id => document.getElementById(id);
  const calls = [], queues = new Map(), events = {};
  let config = initialConfig(), status = initialStatus();
  let permission = { ready: true, token: "fixture-consent", label: "Synthetic provider", destination: "https://synthetic.invalid/v1/chat/completions", model: "api-original", manual: false, background: false,
    disclosure: "Synthetic mail and calendar context", backgroundDisclosure: "Synthetic background tasks" };
  function wait(channel) {
    const request = deferred();
    if (!queues.has(channel)) queues.set(channel, []);
    queues.get(channel).push(request);
    return request;
  }
  const saveResult = input => {
    config = { ...config, ...input };
    delete config.apiKey;
    return structuredClone(config);
  };
  const invoke = async (channel, input) => {
    calls.push({ channel, input });
    if (queues.get(channel)?.length) return queues.get(channel).shift().promise;
    if (channel === "host:aiConsentStatus") return structuredClone(permission);
    if (channel === "host:aiConsentGrant") { permission = { ...permission, ...input, token: permission.token + "1" }; return structuredClone(permission); }
    if (channel === "host:aiConsentRevoke") { permission = { ...permission, manual: false, background: false, token: permission.token + "1" }; return structuredClone(permission); }
    if (channel === "host:aiGetConfig") return structuredClone(config);
    if (channel === "host:aiSaveConfig") return saveResult(input);
    if (channel === "host:aiTest") return { ok: true, preview: "Synthetic success" };
    if (channel === "host:aiListModels") return { ok: true, models: ["chat-original", "chat-new"], choices: [{ id: "chat-original", name: "Original" }, { id: "chat-new", name: "New" }] };
    if (channel === "host:chatgptCancel") status = { ...status, pending: false, phase: "cancelled", message: "Sign-in cancelled" };
    return structuredClone(status);
  };
  let context, run;
  if (native) {
    const bridge = { get: () => invoke("host:aiGetConfig"), save: input => invoke("host:aiSaveConfig", input), test: input => invoke("host:aiTest", input), listModels: input => invoke("host:aiListModels", input) };
    for (const name of ["Status", "Grant", "Revoke"]) bridge[`consent${name}`] = input => invoke(`host:aiConsent${name}`, input);
    for (const name of ["Status", "Start", "Callback", "Cancel", "SignOut", "Select", "Preferences", "ResumeUsage"]) bridge[`chatgpt${name}`] = input => invoke(`host:chatgpt${name}`, input);
    context = vm.createContext({ document, window: { aiSetup: bridge, addEventListener: (name, handler) => { events[name] = handler; } }, setTimeout: () => 1, clearTimeout() {} });
    run = code => vm.runInContext(code, context);
    run(component);
    run(fs.readFileSync(require.resolve("../host/ai-setup.js"), "utf8"));
    await tick();
  } else {
    const ui = renderer({ document, window: { morrow: { invoke } }, setTimeout: () => 1, clearTimeout() {} });
    ({ context, run } = ui);
    run(component);
    await run("loadAiSettings()");
    // Same bindings as wire(); boot itself is deliberately not run in this VM.
    run('for (const id of ["ai-base", "ai-model", "ai-key"]) { $(id).addEventListener("input", paintAiDirty); $(id).addEventListener("change", paintAiDirty); }');
  }
  const ids = native ? { base: "baseUrl", model: "model", key: "apiKey", status: "status", save: "save" } : { base: "ai-base", model: "ai-model", key: "ai-key", status: "ai-status", save: "ai-save" };
  return {
    $, calls, wait, saveResult, run,
    field: name => $(ids[name]),
    get statusText() { return $(ids.status).textContent; },
    get config() { return config; },
    async edit(name, value) { $(ids[name]).value = value; await $(ids[name]).fire("input"); },
    async mode(value) { $("ai-auth-mode").value = value; await $("ai-auth-mode").fire("change"); },
    save: () => native ? $("save").onclick() : run("saveAiSettings()"),
    test: () => native ? $("test").onclick() : run("testAiConnection()"),
    fetch: () => native ? $("fetch").onclick() : run("fetchAiModels()"),
    dirty: () => native ? /not saved|Unsaved/.test($("status").textContent) : run("aiDirty()"),
    settings: () => run(native ? "accountSettings" : "chatgptSettings"),
    close: () => native ? events.pagehide() : run("aiViewRevision++; aiOperation++; chatgptSettings.dispose()"),
    setStatus(value) { status = value; },
    setPermission(value) { permission = { ...permission, ...value }; },
  };
}

for (const kind of ["settings", "setup"]) {
  test(`${kind}: data consent is affirmative, background is separate, revoke wins over late grants and reads`, async () => {
    const f = await fixture(kind);
    assert.equal(f.$("ai-consent-manual").checked, false);
    assert.equal(f.$("ai-consent-background").checked, false);
    assert.equal(f.$("ai-consent-allow").disabled, true);
    await f.save();
    assert.equal(f.calls.filter(row => row.channel === "host:aiConsentGrant").length, 0, "save/key entry is not consent");
    f.$("ai-consent-manual").checked = true; await f.$("ai-consent-manual").fire("change");
    await f.$("ai-consent-allow").fire("click");
    assert.equal(f.calls.find(row => row.channel === "host:aiConsentGrant").input.background, false);
    assert.match(f.$("ai-consent-status").textContent, /Background AI off/);
    f.$("ai-consent-manual").checked = true; await f.$("ai-consent-manual").fire("change");
    f.$("ai-consent-background").checked = true;
    const grant = f.wait("host:aiConsentGrant"), allowing = f.$("ai-consent-allow").fire("click");
    await f.$("ai-consent-allow").fire("click");
    assert.equal(f.calls.filter(row => row.channel === "host:aiConsentGrant").length, 2, "duplicate grants are serialized");
    await f.$("ai-consent-revoke").fire("click");
    grant.resolve({ ready: true, manual: true, background: true, token: "obsolete-grant" }); await allowing;
    assert.match(f.$("ai-consent-status").textContent, /AI data use is off/);
    assert.equal(f.$("ai-consent-manual").checked, false);
    const read = f.wait("host:aiConsentStatus"), reading = f.settings().refreshConsent();
    f.setPermission({ token: "new-provider", label: "New synthetic provider" });
    await f.settings().refreshConsent();
    read.resolve({ ready: true, token: "old-provider", label: "Old provider" }); await reading;
    assert.match(f.$("ai-consent-destination").textContent, /New synthetic provider/);
    f.$("ai-consent-manual").checked = true; await f.$("ai-consent-manual").fire("change");
    const closing = f.wait("host:aiConsentGrant"), pending = f.$("ai-consent-allow").fire("click");
    f.close(); const before = f.$("ai-consent-status").textContent;
    closing.resolve({ ready: true, manual: true, token: "closed-success" }); await pending;
    assert.equal(f.$("ai-consent-status").textContent, before);
  });

  test(`${kind}: save keeps later mode, endpoint, model and key edits dirty; repeated save is serialized`, async () => {
    const f = await fixture(kind);
    await f.mode("chatgpt");
    const request = f.wait("host:aiSaveConfig"), saving = f.save();
    const sent = f.calls.at(-1).input;
    assert.equal(sent.authMode, "chatgpt");
    assert.equal(f.field("save").disabled, true);
    await f.save();
    assert.equal(f.calls.filter(row => row.channel === "host:aiSaveConfig").length, 1);
    await f.mode("api_key");
    await f.edit("base", "https://new.synthetic.invalid/v1");
    await f.edit("model", "new-api-model");
    await f.edit("key", "synthetic-new-key");
    request.resolve(f.saveResult(sent));
    await saving;
    assert.equal(f.$("ai-auth-mode").value, "api_key");
    assert.equal(f.field("base").value, "https://new.synthetic.invalid/v1");
    assert.equal(f.field("model").value, "new-api-model");
    assert.equal(f.field("key").value, "synthetic-new-key");
    assert.equal(f.dirty(), true);
    assert.match(f.statusText, /newer changes are not saved/);
    assert.equal(f.field("save").disabled, false);
    assert.equal(f.config.authMode, "chatgpt");
    await f.save();
    assert.equal(f.config.authMode, "api_key");
    assert.equal(f.field("key").value, "");
    assert.equal(f.statusText, "Saved.");
    assert.equal(f.dirty(), false);
    f.close();
  });

  test(`${kind}: ChatGPT model edits made during save remain unsaved`, async () => {
    const f = await fixture(kind);
    await f.mode("chatgpt");
    await f.fetch();
    const request = f.wait("host:aiSaveConfig"), saving = f.save();
    const sent = f.calls.at(-1).input;
    f.$("chatgpt-model").value = "chat-new";
    await f.$("chatgpt-model").fire("change");
    request.resolve(f.saveResult(sent));
    await saving;
    assert.equal(f.config.chatgptModel, "chat-original");
    assert.equal(f.$("chatgpt-model").value, "chat-new");
    assert.equal(f.dirty(), true);
    assert.match(f.statusText, /not saved/);
    f.close();
  });

  test(`${kind}: save failure preserves edits and retry, late save cannot overwrite a newer test`, async () => {
    const f = await fixture(kind);
    await f.mode("chatgpt");
    const request = f.wait("host:aiSaveConfig"), saving = f.save();
    await f.mode("api_key");
    request.reject(new Error("Synthetic save failed"));
    await saving;
    assert.equal(f.field("save").disabled, false);
    assert.equal(f.$("ai-auth-mode").value, "api_key");
    assert.equal(f.config.authMode, "api_key");
    assert.match(f.statusText, /Synthetic save failed/);
    for (const failure of [false, true]) {
      const late = f.wait("host:aiSaveConfig"), pending = f.save();
      const sent = f.calls.at(-1).input;
      await f.test();
      assert.match(f.statusText, /^Connected\./);
      failure ? late.reject(new Error("Obsolete save failure")) : late.resolve(f.saveResult(sent));
      await pending;
      assert.match(f.statusText, /^Connected\./);
    }
    f.close();
  });

  test(`${kind}: test results and errors belong to the tested mode/configuration`, async () => {
    for (const change of ["mode", "base", "model", "key"]) {
      for (const failure of [false, true]) {
        const f = await fixture(kind);
        const request = f.wait("host:aiTest"), testing = f.test();
        assert.equal(f.calls.at(-1).input.authMode, "api_key");
        if (change === "mode") await f.mode("chatgpt");
        else await f.edit(change, "synthetic-changed-" + change);
        failure ? request.reject(new Error("Obsolete API failure")) : request.resolve({ ok: true, preview: "Obsolete API success" });
        await testing;
        assert.doesNotMatch(f.statusText, /Connected|Obsolete/);
        assert.match(f.statusText, /current settings/);
        f.close();
      }
    }
    const f = await fixture(kind);
    await f.test();
    assert.match(f.statusText, /^Connected\./);
    await f.edit("model", "after-tested-model");
    assert.doesNotMatch(f.statusText, /Connected/);
    await f.mode("chatgpt");
    f.setStatus({ ...initialStatus(), connected: true, planEnabled: true, activeId: "synthetic-account", accounts: [{ id: "synthetic-account", connected: true, label: "Synthetic account" }] });
    await f.settings().refresh();
    const signedOut = f.wait("host:aiTest"), testing = f.test();
    f.setStatus({ ...initialStatus(), activeId: "synthetic-account" });
    await f.settings().refresh();
    signedOut.resolve({ ok: true, preview: "Old signed-in account success" });
    await testing;
    assert.doesNotMatch(f.statusText, /Connected|Old signed-in/);
    f.close();
  });

  test(`${kind}: repeated tests ignore out-of-order success and failure; close ignores late results`, async () => {
    for (const firstFails of [false, true]) {
      const f = await fixture(kind);
      const first = f.wait("host:aiTest"), old = f.test();
      const second = f.wait("host:aiTest"), recent = f.test();
      second.resolve(firstFails ? { ok: true, preview: "Latest success" } : { ok: false, message: "Latest failure" });
      await recent;
      const latest = f.statusText;
      firstFails ? first.reject(new Error("Obsolete failure")) : first.resolve({ ok: true, preview: "Obsolete success" });
      await old;
      assert.equal(f.statusText, latest);
      const closing = f.wait("host:aiTest"), pending = f.test();
      f.close();
      const before = f.statusText;
      closing.resolve({ ok: true, preview: "Closed view success" });
      await pending;
      assert.equal(f.statusText, before);
    }
  });

  test(`${kind}: provider reads cannot replace a newer action or changed form`, async () => {
    const f = await fixture(kind);
    const request = f.wait("host:aiListModels"), fetching = f.fetch();
    await f.test();
    const latest = f.statusText;
    request.resolve({ ok: true, models: ["obsolete-model"] });
    await fetching;
    assert.equal(f.statusText, latest);
    const pending = f.wait("host:aiListModels"), old = f.fetch();
    await f.mode("chatgpt");
    pending.reject(new Error("Obsolete API catalog failure"));
    await old;
    assert.doesNotMatch(f.statusText, /Obsolete/);
    f.close();
  });
}

test("shared login: cancel permits immediate retry and ignores old success/failure and status", async () => {
  for (const oldFails of [false, true]) {
    const f = await fixture("settings");
    await f.mode("chatgpt");
    const first = f.wait("host:chatgptStart"), old = f.$("chatgpt-login").fire("click");
    const poll = f.wait("host:chatgptStatus"), reading = f.settings().refresh();
    const cancel = f.wait("host:chatgptCancel"), cancelling = f.$("chatgpt-cancel").fire("click");
    assert.equal(f.$("chatgpt-cancel").disabled, true);
    await f.$("chatgpt-cancel").fire("click");
    assert.equal(f.calls.filter(row => row.channel === "host:chatgptCancel").length, 1);
    cancel.resolve({ ...initialStatus(), phase: "cancelled", message: "Sign-in cancelled" });
    await cancelling;
    assert.equal(f.$("chatgpt-login").disabled, false, "does not wait for the old start");
    const second = f.wait("host:chatgptStart"), recent = f.$("chatgpt-login").fire("click");
    const before = f.$("chatgpt-status").textContent;
    oldFails ? first.reject(new Error("Obsolete start failure")) : first.resolve({ ...initialStatus(), connected: true, message: "Obsolete start success", welcome: true });
    poll.resolve({ ...initialStatus(), pending: false, message: "Obsolete poll" });
    await old; await reading;
    assert.equal(f.$("chatgpt-status").textContent, before);
    second.resolve({ ...initialStatus(), pending: true, phase: "waiting", message: "New attempt waiting" });
    await recent;
    assert.equal(f.$("chatgpt-status").textContent, "New attempt waiting");
    assert.equal(f.$("chatgpt-welcome").hidden, true);
    f.close();
  }
});

test("shared login: failed cancellation remains retryable; disposal prevents late UI work", async () => {
  const f = await fixture("settings");
  await f.mode("chatgpt");
  f.setStatus({ ...initialStatus(), pending: true, phase: "starting" });
  const start = f.wait("host:chatgptStart"), old = f.$("chatgpt-login").fire("click");
  const cancel = f.wait("host:chatgptCancel"), cancelling = f.$("chatgpt-cancel").fire("click");
  cancel.reject(new Error("Synthetic cancellation failed"));
  await cancelling;
  assert.match(f.$("chatgpt-status").textContent, /cancellation failed/);
  assert.equal(f.$("chatgpt-login").disabled, true, "a failed cancellation does not pretend the host stopped");
  assert.equal(f.$("chatgpt-cancel").disabled, false);
  await f.$("chatgpt-cancel").fire("click");
  assert.equal(f.$("chatgpt-login").disabled, false, "successful cancellation permits immediate retry");
  const retry = f.wait("host:chatgptStart"), pending = f.$("chatgpt-login").fire("click");
  f.close();
  const before = f.$("chatgpt-status").textContent;
  retry.resolve({ ...initialStatus(), connected: true, welcome: true, message: "Closed success" });
  start.reject(new Error("Old failure"));
  await pending; await old;
  assert.equal(f.$("chatgpt-status").textContent, before);
  assert.equal(f.$("chatgpt-welcome").hidden, true);
});

test("host discovery: cancel aborts the old wait; retry and late success/failure stay separate", async () => {
  for (const oldFails of [false, true]) {
    let data = { hostId: "", activeId: "", registrations: [] };
    const requests = [];
    let browserCalls = 0;
    const auth = createAuth({ store: { available: () => true, read: () => structuredClone(data), write: next => { data = structuredClone(next); } },
      fetcher: async (url, input) => {
        assert.equal(url, `${ISSUER}/.well-known/openid-configuration`);
        const request = deferred(); requests.push({ ...request, signal: input.signal });
        return request.promise; // deliberately let the fixture deliver after abort
      }, openBrowser: async () => { browserCalls++; } });
    const metadata = () => new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` }), { headers: { "content-type": "application/json" } });
    try {
      const old = auth.start().catch(error => error);
      auth.cancel();
      assert.equal(requests[0].signal.aborted, true);
      const recent = auth.start().catch(error => error);
      assert.equal(requests.length, 2, "retry does not join the cancelled discovery");
      assert.equal(requests[1].signal.aborted, false);
      oldFails ? requests[0].reject(new Error("Old discovery failed")) : requests[0].resolve(metadata());
      assert.ok(await old instanceof Error);
      assert.equal(auth.status().pending, true);
      assert.equal(auth.status().phase, "starting");
      assert.match(auth.status().message, /Opening ChatGPT/);
      auth.cancel(); requests[1].resolve(metadata()); await recent;
      assert.equal(auth.status().pending, false);
      assert.equal(browserCalls, 0, "no real browser or loopback listener is reached");
    } finally { auth.dispose(); }
  }
});
