// Synthetic providers and temporary files only. No sockets, credentials or model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const consentModule = require("../host/ai-consent");
const { createConsent, VERSION } = consentModule;
const config = require("../host/ai-config");
const client = require("../host/openai-client");
const context = require("../host/ai-context");
const responses = require("../host/chatgpt-responses");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-ai-consent-"));
  const names = ["MORROW_AI_CONFIG_DIR", "MORROW_AI_API_KEY", "MORROW_AI_MODEL", "MORROW_AI_BASE_URL", "XAI_API_KEY"];
  const environment = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const original = { fetch: global.fetch, consent: consentModule.getConsent, responses: responses.getResponses };
  for (const name of names) delete process.env[name];
  process.env.MORROW_AI_CONFIG_DIR = directory;
  let account = { activeId: "synthetic-account", connected: true, planEnabled: true, backgroundConsent: true, accounts: [{ id: "synthetic-account", label: "Synthetic account" }] };
  const consent = createConsent({ directory: () => directory, config: config.loadConfig, account: () => account,
    background: value => { account.backgroundConsent = value; } });
  consentModule.getConsent = () => consent;
  const calls = [], adapterCalls = [];
  global.fetch = async (url, input) => {
    assert.match(String(url), /^https:\/\/synthetic\.invalid\//);
    calls.push({ url, input });
    return json({ choices: [{ message: { content: "Synthetic answer" } }] });
  };
  responses.getResponses = () => ({ complete: async (messages, options) => { adapterCalls.push({ messages, options }); return "Synthetic ChatGPT answer"; },
    stream: async (messages, onChunk, options) => { adapterCalls.push({ messages, options }); onChunk("Synthetic ChatGPT answer"); } });
  config.saveConfig({ authMode: "api_key", baseUrl: "https://synthetic.invalid/v1", model: "fixture-model", apiKey: "synthetic-key" });
  t.after(() => {
    global.fetch = original.fetch; consentModule.getConsent = original.consent; responses.getResponses = original.responses;
    for (const [name, value] of Object.entries(environment)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, consent, calls, adapterCalls, account: () => account, setAccount: value => { account = { ...account, ...value }; },
    allow: (background = false) => consent.grant({ token: consent.status().token, manual: true, background }) };
}

test("an unready saved target names the missing step and still refuses grant", () => {
  const consent = createConsent({
    directory: () => "/synthetic-unready-consent",
    config: () => ({ authMode: "api_key", baseUrl: "https://synthetic.invalid/v1", model: "", apiKey: "" }),
    account: () => ({ connected: false, planEnabled: false, activeId: "", accounts: [] }),
    background() { throw new Error("background must not run"); },
  });
  const status = consent.status();
  assert.equal(status.ready, false);
  assert.equal(status.manual, false);
  assert.match(status.blocker, /Save an API key and a model, then review this connection again/);
  assert.doesNotMatch(status.blocker, /synthetic/);
  assert.throws(() => consent.grant({ token: status.token, manual: true, background: false }), /permission changed/);
  assert.equal(consent.status().manual, false);
});

test("existing API/ChatGPT/background settings, corrupt files and old disclosures never grandfather permission", async t => {
  const f = fixture(t);
  assert.equal(f.consent.status().manual, false);
  for (const input of [undefined, { manual: false, background: true }, { token: f.consent.status().token, manual: true }]) assert.throws(() => f.consent.grant(input));
  await assert.rejects(client.complete([{ role: "user", content: "Synthetic mail" }]), /AI data use is off/);
  await assert.rejects(client.stream([], () => {}), /AI data use is off/);
  config.saveConfig({ authMode: "chatgpt", chatgptModel: "fixture-chat" });
  await assert.rejects(client.complete([]), /AI data use is off/);
  assert.equal(f.account().backgroundConsent, true, "legacy account opt-in is insufficient");
  for (const raw of ["damaged", JSON.stringify({ version: VERSION - 1, manual: true, background: true })]) {
    fs.writeFileSync(path.join(f.directory, "ai-consent.json"), raw);
    assert.equal(f.consent.status().manual, false);
    await assert.rejects(client.complete([]), /AI data use is off/);
  }
  assert.equal(f.calls.length + f.adapterCalls.length, 0);
});

test("manual permission, separate background permission and local/remote disclosure", async t => {
  const f = fixture(t);
  f.allow();
  assert.equal(await client.complete([{ role: "user", content: "Synthetic" }]), "Synthetic answer");
  assert.equal(f.calls[0].input.redirect, "error");
  for (const run of [() => client.complete([], { background: true }), () => context.background(() => client.complete([], { background: false })), () => context.background(() => client.stream([], () => {}))]) await assert.rejects(run(), /Background AI is off/);
  assert.equal(f.calls.length, 1);
  f.allow(true);
  await context.background(() => client.complete([]));
  assert.equal(f.calls.length, 2);
  const status = f.consent.status();
  assert.match(status.disclosure, /calendar|event titles/);
  assert.match(status.backgroundDisclosure, /reply composition opens/);
  assert.match(status.providerTerms, /not a guarantee/);
  assert.ok(!JSON.stringify(status).includes("synthetic-key"));
  assert.equal(status.local, false);
  config.saveConfig({ baseUrl: "http://127.0.0.1:12345/v1" });
  assert.equal(f.consent.status().local, true);
  assert.match(f.consent.status().locality, /may forward/);
  assert.equal(f.consent.status().manual, false);
});

test("provider, path, model, key, mode and account changes require fresh consent and reject stale approval", async t => {
  const f = fixture(t);
  for (const edit of [{ baseUrl: "https://synthetic.invalid/new/v1" }, { model: "different-model" }, { apiKey: "different-key" }, { authMode: "chatgpt", chatgptModel: "fixture-chat" }]) {
    f.allow(true);
    const stale = f.consent.status().token;
    config.saveConfig(edit);
    assert.equal(f.consent.status().manual, false);
    assert.throws(() => f.consent.grant({ token: stale, manual: true, background: false }), /changed/);
    await assert.rejects(client.complete([]), /AI data use is off/);
  }
  f.allow(true);
  assert.equal(await client.complete([]), "Synthetic ChatGPT answer");
  assert.equal(f.adapterCalls.length, 1);
  const lease = f.consent.acquire(config.loadConfig());
  f.setAccount({ activeId: "different-account" });
  assert.throws(lease.check, /cancelled/);
  await assert.rejects(client.complete([]), /AI data use is off/);
  lease.release();
  config.saveConfig({ authMode: "api_key" });
  assert.equal(f.consent.status().manual, false, "switching back cannot resurrect an older grant");
  const saved = config.loadConfig();
  assert.throws(() => config.saveConfig({ baseUrl: "file:///synthetic" }));
  assert.deepEqual(config.loadConfig(), saved, "invalid destination cannot poison settings");
});

test("revoke aborts concurrent API requests and ignores providers that deliver after abort", async t => {
  const f = fixture(t); f.allow(true);
  const wait = deferred(), signals = [];
  global.fetch = async (_url, input) => { signals.push(input.signal); await wait.promise; return json({ choices: [{ message: { content: "Late synthetic answer" } }] }); };
  const pending = [client.complete([]), client.complete([])];
  f.consent.revoke();
  assert.ok(signals.every(signal => signal.aborted));
  wait.resolve();
  for (const result of pending) await assert.rejects(result, /cancelled/);
  const stop = new AbortController(); stop.abort();
  f.allow();
  await assert.rejects(client.complete([], { signal: stop.signal }), /cancelled/);
  assert.equal(signals.length, 2, "pre-cancelled actions never reach fetch");
});

test("queued actions cannot resume after revoke/regrant and changed streams cannot send a fallback", async t => {
  const f = fixture(t); f.allow();
  const queued = deferred();
  const old = context.operation(async () => { await queued.promise; return client.complete([]); });
  f.consent.revoke(); f.allow(); queued.resolve();
  await assert.rejects(old, /permission changed|permission.*changed/);
  assert.equal(f.calls.length, 0);
  let sends = 0, chunks = "";
  global.fetch = async () => {
    sends++;
    config.saveConfig({ model: "new-fixture-model" });
    return new Response("data: [DONE]\n\n");
  };
  await assert.rejects(client.stream([], chunk => { chunks += chunk; }), /cancelled/);
  assert.equal(sends, 1);
  assert.equal(chunks, "");
  assert.equal(f.adapterCalls.length, 0, "no provider or paid fallback");
});

test("actual host test and account-change IPC enforce permission independently of the renderer", async t => {
  const f = fixture(t), handlers = new Map();
  const source = fs.readFileSync(require.resolve("../host/main"), "utf8");
  const registration = source.slice(source.indexOf("function registerHostAi()"), source.indexOf("function runAiSelfTest()"));
  const auth = { status: () => f.account(), select: () => f.account() };
  vm.runInNewContext(`${registration}\nregisterHostAi();`, { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    loadConfig: config.loadConfig, publicConfig: config.publicConfig, saveConfig: config.saveConfig, complete: client.complete, listModels: client.listModels,
    updateGate: { run: work => work() }, require: name => {
      if (name === "./ai-consent") return consentModule;
      if (name === "./chatgpt-auth") return { getAuth: () => auth };
      throw new Error(`Unexpected dependency ${name}`);
    } });
  const run = (name, input) => handlers.get(name)({}, input);
  assert.equal((await run("host:aiTest", {})).ok, false);
  assert.equal(f.calls.length, 0);
  f.allow();
  assert.equal((await run("host:aiTest", {})).ok, true);
  assert.match(f.calls[0].input.body, /Say hello/);
  assert.equal((await run("host:aiTest", { model: "unapproved-model" })).ok, false);
  assert.equal(f.calls.length, 1);
  config.saveConfig({ authMode: "chatgpt", chatgptModel: "fixture-chat" }); f.allow();
  run("host:chatgptSelect", "synthetic-account");
  assert.equal(f.consent.status().manual, false);
});

function loadSynthetic(name, replacements) {
  const filename = require.resolve(`../host/${name}`), load = createRequire(filename), module = { exports: {} };
  const sandbox = vm.createContext({ module, exports: module.exports, __dirname: path.dirname(filename), console, process, Buffer, AbortController,
    require: key => Object.hasOwn(replacements, key) ? replacements[key] : load(key), setImmediate, clearInterval, setInterval: () => ({ unref() {} }), setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox);
  return module.exports;
}

test("actual Brain, Agent, custom/catalog skill, draft, suggestion and translation entrypoints all fail closed", async t => {
  const f = fixture(t), events = [];
  const mail = { id: "fixture-message", accountId: "fixture-account", from: "fixture@example.invalid", subject: "Fixture", snippet: "Synthetic context", date: "2026-10-25", folderPath: "INBOX" };
  const db = { hasAccounts: () => true, recentInbox: () => [mail], recentInWellKnown: () => [mail], messageById: () => null };
  const electron = { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } }] } };
  const replacements = { electron, "./mail/db": db, "./mail/sidecar": { answer: async () => ({ success: true, data: { api: true, events: [] } }) } };
  const brain = loadSynthetic("brain", replacements); replacements["./brain"] = brain;
  const agent = loadSynthetic("agent", replacements); replacements["./agent"] = agent;
  const draft = loadSynthetic("draft-write", replacements);
  const translate = loadSynthetic("translate", { ...replacements, "./translate-window": { note() {} } });
  const messages = [];
  for (const channel of ["emailBrain:addCategoryViaPrompt", "emailBrain:fixCategory", "emailBrain:fixItem"]) messages.push((await brain.answer(channel, [{ prompt: "Synthetic", itemId: "row" }])).error.message);
  for (const run of [() => agent.runSkill({ skillId: "morning-brief" }), () => agent.runSkill({ skillId: "morning-brief", source: "schedule" }), () => agent.answer("nativeAgent:triage", [{}]), () => agent.answer("nativeAgent:triage", [{ source: "open" }])]) messages.push((await run()).data.error);
  const custom = brain.answer("emailBrain:saveCustomSkill", [{ name: "Fixture skill", instruction: "Summarize synthetic context" }]);
  assert.ok(custom.success, JSON.stringify(custom));
  messages.push((await agent.runSkill({ skillId: custom.data.skill.id })).data.error);
  messages.push((await agent.answer("nativeAgent:chat", [{ text: "Explain what needs my attention" }])).data.turn.text);
  messages.push((await agent.answer("nativeAgent:chat", [{ text: "Draft a reply" }])).data.turn.text);
  messages.push((await draft.answer("aiDraftWrite:replySuggestions", [{ email: mail }])).error.message);
  draft.answer("aiDraftWrite:start", [{ reqId: "fixture-draft", body: { user_prompt: "Synthetic" } }]);
  translate.answer("mail:translateStart", [{ reqId: "fixture-translation", nodes: [{ node_id: "one", text: "Synthetic" }] }]);
  brain.answer("emailBrain:refresh", [{ source: "manual" }]);
  brain.answer("emailBrain:refresh", [{ source: "open" }]);
  brain.answer("emailBrain:rebuild", []);
  await tick(); await tick();
  for (const row of events.filter(row => row.payload?.error || row.payload?.type === "error")) messages.push(row.payload.error || row.payload.message);
  assert.ok(messages.length >= 14, "each real entrypoint returned its normal error surface");
  for (const message of messages) assert.match(String(message), /AI data use is off|Background AI is off/, String(message));
  assert.equal(f.calls.length + f.adapterCalls.length, 0);
  f.allow();
  const automatic = await draft.answer("aiDraftWrite:replySuggestions", [{ source: "compose-open", email: mail }]);
  assert.match(automatic.error.message, /Background AI is off/);
  assert.equal(f.calls.length, 0);
});
