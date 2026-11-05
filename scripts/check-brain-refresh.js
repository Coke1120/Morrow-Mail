// Production Brain/settings/consent/request code with synthetic stores and fetch.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const { AsyncResource } = require("node:async_hooks");
const { test } = require("node:test");
const { createConsent } = require("../host/ai-consent");
const { renderer } = require("./check-ux-workflows");
const root = path.join(__dirname, "..");
const DAY = 86400000;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function load(relative, replacements = {}, globals = {}) {
  const filename = path.join(root, relative), module = { exports: {} }, original = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, process, Buffer, URL,
    AbortController, AbortSignal, TextDecoder, setImmediate, setInterval, clearInterval,
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : original(name), ...globals }, { filename });
  return module.exports;
}

function fixture(t, { granted = true, mode = "api_key" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-brain-refresh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-11-05T12:00:00Z"), hold = null, failModel = false, failWrite = false;
  let accountBackground = true, gateClosed = false;
  const events = [], calls = [], immediate = [], intervals = [];
  const config = { authMode: mode, baseUrl: "https://synthetic.invalid/v1", model: "synthetic-model", apiKey: "synthetic-only", chatgptModel: "synthetic-chat" };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const cfg = { ...require("../host/ai-config"), loadConfig: () => ({ ...config }), userDataDir: () => directory };
  const permission = createConsent({ directory: () => directory, config: cfg.loadConfig,
    account: () => ({ activeId: "synthetic-account", connected: true, planEnabled: true }), background() {} });
  const consentModule = { getConsent: () => permission };
  const context = load("host/ai-context.js", { "./ai-consent": consentModule });
  const generated = JSON.stringify({ writing: ["Synthetic rule"], sections: [] });
  async function response(messages, options) {
    calls.push({ messages, options, background: context.isBackground() });
    if (hold) await hold.promise;
    if (failModel) throw Error("Synthetic provider failure");
    return generated;
  }
  const client = load("host/openai-client.js", { "./ai-config": cfg, "./ai-consent": consentModule, "./ai-context": context,
    "./chatgpt-responses": { getResponses: () => ({ complete: response }) } }, {
    fetch: async (url, options) => {
      assert.equal(url, "https://synthetic.invalid/v1/chat/completions");
      const content = await response(JSON.parse(options.body).messages, options);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    },
  });
  const settings = load("host/settings.js", { "./paths": { userDataDir: () => directory } });
  const persona = load("host/brain-persona.js", {}, { Date: Clock });
  const brainFs = { ...fs, renameSync(from, to) {
    if (failWrite && to === path.join(directory, "brain.json")) throw Error("Synthetic persistence failure");
    fs.renameSync(from, to);
  } };
  function restart() {
    return load("host/brain.js", { fs: brainFs, "./ai-config": cfg, "./openai-client": client,
      "./brain-persona": persona, "./settings": settings, "./ai-context": context, "./ai-consent": consentModule,
      "./chatgpt-auth": { getAuth: () => ({ backgroundAllowed: () => accountBackground }) },
      "./update-quiescence": { gate: { run: work => { if (gateClosed) throw Error("Synthetic update gate is closed"); return work(); } } },
      "./agent": { mailboxConnected: () => true,
        profileSample: () => ({ messages: [{ id: "synthetic-message", from: "sender@example.invalid", subject: "Synthetic", snippet: "Synthetic only", folder: "sent" }], sentCount: 1, inboxCount: 0 }) },
      "./mail/db": { isReady: () => false },
      electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } }] } },
    }, { Date: Clock, setImmediate: callback => immediate.push(AsyncResource.bind(callback)),
      setInterval: (callback, ms) => { intervals.push({ callback, ms }); return { unref() {} }; } });
  }
  if (granted) permission.grant({ token: permission.status().token, manual: true, background: true });
  const brain = restart();
  const answer = (channel, params) => brain.answer(channel, params ? [params] : []);
  const read = () => JSON.parse(fs.readFileSync(path.join(directory, "brain.json"), "utf8"));
  return { brain, answer, settings, permission, config, calls, events, intervals, directory, restart, read,
    cadence: value => settings.answer("morrow:configSetBrainRefreshCadence", [value]),
    seed: value => fs.writeFileSync(path.join(directory, "brain.json"), JSON.stringify({ userRules: [], activity: [], ...value })),
    advance: ms => { now += ms; }, hold: () => { hold = deferred(); return hold; },
    fail: value => { failModel = value; }, failWrite: value => { failWrite = value; }, accountBackground: value => { accountBackground = value; },
    closeGate: value => { gateClosed = value; },
    async settle() { while (immediate.length) immediate.shift()(); for (let i = 0; i < 6; i++) await tick(); },
  };
}

test("missing cadence migrates to daily; strict writes and malformed saved values stay bounded", t => {
  const f = fixture(t);
  assert.equal(f.settings.answer("morrow:configGetBrainRefreshCadence", []), "daily");
  const consent = fs.readFileSync(path.join(f.directory, "ai-consent.json"), "utf8");
  f.cadence("weekly");
  const reopened = load("host/settings.js", { "./paths": { userDataDir: () => f.directory } });
  assert.equal(reopened.answer("morrow:configGetBrainRefreshCadence", []), "weekly");
  for (const input of ["hourly", 60, null, {}, ["daily"]]) assert.throws(() => f.cadence(input), /daily, weekly, or manual/);
  const file = path.join(f.directory, "settings.json"), stored = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...stored, brainRefreshCadence: "damaged" }));
  assert.equal(reopened.answer("morrow:configGetBrainRefreshCadence", []), "manual");
  for (const damaged of ["broken JSON", "null", "[]"]) {
    fs.writeFileSync(file, damaged);
    assert.equal(reopened.answer("morrow:configGetBrainRefreshCadence", []), "manual", damaged);
  }
  assert.equal(fs.readFileSync(path.join(f.directory, "ai-consent.json"), "utf8"), consent);
  assert.equal(f.calls.length, 0);
});

test("page opens and timer share daily/weekly due logic; missed slots coalesce after restart", async t => {
  const f = fixture(t); f.seed({ generated: { updatedAt: "2026-11-05T11:00:00Z" } });
  f.brain.scheduleLivingRefresh(); f.brain.scheduleLivingRefresh();
  assert.equal(f.intervals.length, 1);
  f.intervals[0].callback();
  assert.equal(f.answer("emailBrain:refresh", { source: "open" }).data.cached, true);
  await f.settle(); assert.equal(f.calls.length, 0, "an hour-old profile must not trigger AI");
  f.advance(DAY); f.answer("emailBrain:refresh", { source: "open" }); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].background, true);
  f.intervals[0].callback(); await f.settle(); assert.equal(f.calls.length, 1);
  f.cadence("weekly"); f.advance(6 * DAY); f.intervals[0].callback(); await f.settle();
  assert.equal(f.calls.length, 1);
  f.advance(8 * DAY);
  const restarted = f.restart(); restarted.scheduleLivingRefresh(); f.intervals.at(-1).callback(); await f.settle();
  assert.equal(f.calls.length, 2, "many missed slots must start one request");
  f.intervals.at(-1).callback(); await f.settle(); assert.equal(f.calls.length, 2);
});

test("queued, running, manual, rebuild and timer requests share one profile job", async t => {
  const f = fixture(t), pending = f.hold();
  f.answer("emailBrain:refresh", { source: "open" });
  assert.equal(f.answer("emailBrain:refresh", { source: "open" }).data.running, true);
  assert.equal(f.answer("emailBrain:rebuild").data.mode, "refresh");
  f.brain.scheduleLivingRefresh(); f.intervals[0].callback();
  await f.settle(); assert.equal(f.calls.length, 1);
  assert.equal(f.answer("emailBrain:refresh", { source: "manual" }).data.running, true);
  pending.resolve(); await f.settle();
  f.answer("emailBrain:rebuild"); await f.settle(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).background, false);
});

test("a failed automatic attempt persists its full-interval backoff across restart; manual retries work", async t => {
  const f = fixture(t); f.fail(true);
  f.answer("emailBrain:refresh", { source: "open" }); await f.settle();
  assert.equal(f.calls.length, 1); assert.ok(f.read().refreshAttemptAt);
  assert.match(f.events.at(-1).payload.error, /Synthetic provider failure/);
  const restarted = f.restart();
  assert.equal(restarted.answer("emailBrain:refresh", [{ source: "open" }]).data.cached, true);
  f.advance(-DAY); restarted.scheduleLivingRefresh(); f.intervals.at(-1).callback(); await f.settle();
  assert.equal(f.calls.length, 1, "a backward clock must not create extra requests");
  f.fail(false); restarted.answer("emailBrain:refresh", [{ source: "manual" }]); await f.settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls.at(-1).background, false);
  f.advance(2 * DAY); f.intervals.at(-1).callback(); await f.settle(); assert.equal(f.calls.length, 3);
});

test("manual only suppresses timer and page-open work, including an already queued job", async t => {
  const f = fixture(t);
  f.answer("emailBrain:refresh", { source: "open" }); f.cadence("manual"); await f.settle();
  assert.equal(f.calls.length, 0);
  f.advance(30 * DAY); f.brain.scheduleLivingRefresh(); f.intervals[0].callback();
  assert.equal(f.answer("emailBrain:refresh", { source: "open" }).data.cached, true);
  await f.settle(); assert.equal(f.calls.length, 0);
  f.answer("emailBrain:refresh", { source: "manual" }); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].background, false);
});

test("automatic admission preserves manual/background consent, account consent and queued destination binding", async t => {
  for (const mode of ["api_key", "chatgpt"]) {
    const f = fixture(t, { mode, granted: false });
    f.answer("emailBrain:refresh", { source: "open" }); await f.settle(); assert.equal(f.calls.length, 0);
    assert.match(f.events.at(-1).payload.error, /Background AI is off/);
    f.permission.grant({ token: f.permission.status().token, manual: true, background: false });
    f.answer("emailBrain:refresh", { source: "open" }); await f.settle(); assert.equal(f.calls.length, 0);
    f.answer("emailBrain:refresh", { source: "manual" }); await f.settle(); assert.equal(f.calls.length, 1);
    f.advance(2 * DAY);
    f.permission.grant({ token: f.permission.status().token, manual: true, background: true });
    f.answer("emailBrain:refresh", { source: "open" });
    f.config.model = "changed-model"; f.config.chatgptModel = "changed-chat-model";
    await f.settle(); assert.equal(f.calls.length, 1, "queue must retain the reviewed destination stamp");
    f.permission.grant({ token: f.permission.status().token, manual: true, background: true });
    f.accountBackground(false); f.answer("emailBrain:refresh", { source: "open" }); await f.settle();
    assert.equal(f.calls.length, mode === "chatgpt" ? 1 : 2);
  }
});

test("revocation and regrant retire queued work; revocation during fetch cannot save an obsolete result", async t => {
  const f = fixture(t);
  f.answer("emailBrain:refresh", { source: "open" }); f.permission.revoke();
  f.permission.grant({ token: f.permission.status().token, manual: true, background: true });
  await f.settle(); assert.equal(f.calls.length, 0);
  const hold = f.hold(); f.answer("emailBrain:refresh", { source: "open" }); await f.settle();
  assert.equal(f.calls.length, 1); f.permission.revoke(); hold.resolve(); await f.settle();
  assert.equal(f.read().generated, null); assert.match(f.events.at(-1).payload.error, /cancelled/);
});

test("durable attempt failure sends no context and retains the previous profile and writing rules", async t => {
  const f = fixture(t);
  f.seed({ userRules: [{ id: "saved", value: "My rule" }], generated: { updatedAt: "2026-10-01T00:00:00Z", writing: [] } });
  const before = f.read(); f.failWrite(true);
  f.answer("emailBrain:refresh", { source: "open" }); await f.settle();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.read(), before);
  assert.match(f.events.at(-1).payload.error, /persistence failure/);
});

test("a closed update gate pauses timer work without escaping its callback or retaining a stuck job", async t => {
  const f = fixture(t); f.brain.scheduleLivingRefresh(); f.closeGate(true);
  assert.doesNotThrow(() => f.intervals[0].callback());
  await f.settle(); assert.equal(f.calls.length, 0);
  f.closeGate(false); f.intervals[0].callback(); await f.settle();
  assert.equal(f.calls.length, 1);
});

test("actual Settings tab and preload round-trip cadence without granting permission or invoking AI", async t => {
  const f = fixture(t, { granted: false }), dispatches = [], intercept = new Map();
  const noop = { answer: () => undefined };
  const ipc = load("host/ipc.js", { "./mail/engine": noop, "./draft-write": noop, "./brain": f.brain, "./agent": noop,
    "./translate": noop, "./settings": f.settings, "./debug-log": noop,
    "./ipc-diagnostics": { createDiagnostics: () => ({ ipc() {} }) }, "./performance-diagnostics": { ipc: (_channel, work) => work() },
  }).createIpc("synthetic-no-log");
  const exposed = {};
  load("renderer/preload.js", { electron: {
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: async (channel, input) => {
      dispatches.push(channel); if (intercept.has(channel)) await intercept.get(channel)(input);
      return ipc.handle({}, channel, input);
    } },
  } });
  const dom = new (require("jsdom").JSDOM)(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"));
  t.after(() => dom.window.close());
  const document = dom.window.document, get = id => document.getElementById(id);
  const ui = renderer({ document, window: { morrow: exposed.morrow, addEventListener() {} }, requestAnimationFrame: callback => setImmediate(callback) });
  ui.run("wire(); $('settings').open=true; revealSettingsFold('brain')");
  await ui.run("loadSettingsFold('brain')");
  assert.equal(get("settings-brain").hidden, false);
  assert.equal(get("settings-tab-brain").getAttribute("aria-selected"), "true");
  assert.equal(get("pref-brain-refresh").value, "daily");
  assert.match(get("brain-refresh-permission").textContent, /paused.*background AI/);
  get("pref-brain-refresh").value = "weekly";
  get("pref-brain-refresh").dispatchEvent(new dom.window.Event("change"));
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(f.settings.answer("morrow:configGetBrainRefreshCadence", []), "weekly");
  assert.match(get("brain-refresh-setting-status").textContent, /saved/);
  assert.equal(f.permission.status().manual, false); assert.equal(f.calls.length, 0);
  assert.ok(dispatches.includes("emailBrain:getRefreshStatus"));
  await assert.rejects(exposed.morrow.invoke("morrow:configSetBrainRefreshAnything", "daily"), /Unsupported channel/);
  await assert.rejects(exposed.morrow.invoke("morrow:configSetBrainRefreshCadence", "hourly"), /daily, weekly, or manual/);
  const hold = deferred(); intercept.set("morrow:configSetBrainRefreshCadence", () => hold.promise);
  get("pref-brain-refresh").value = "manual";
  get("pref-brain-refresh").dispatchEvent(new dom.window.Event("change"));
  assert.equal(get("pref-brain-refresh").disabled, true);
  get("settings").open = false; get("settings").open = true; ui.run("loadBrainSettings()");
  hold.resolve(); for (let i = 0; i < 10; i++) await tick();
  assert.equal(get("pref-brain-refresh").value, "manual");
  assert.equal(get("pref-brain-refresh").disabled, false);
  assert.equal(dispatches.some(channel => /ConsentGrant|:refresh$|:rebuild$/.test(channel)), false);
});
