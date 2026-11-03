// Synthetic mail, providers and temporary permission files only. No real secrets or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { createSummaryService, summaryInput, BODY_CHARS } = require("../host/message-summary");
const { renderer } = require("./check-ux-workflows");
const { JSDOM } = require("jsdom");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const source = filename => fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
const email = () => ({ id: "one", accountId: "alpha", bodyEpoch: 0, bodyComplete: true, subject: "Project notes",
  from: "Ada <ada@example.invalid>", date: "2026-11-03T08:00:00Z", textBody: "Review the plan by Friday.",
  attachments: [{ filename: "do-not-send.pdf", bytes: "private-fixture" }] });
const params = (reqId = "fixture-request") => ({ reqId, emailId: "one", accountId: "alpha", bodyEpoch: 0 });

async function hostChecks() {
  const config = require("../host/ai-config");
  const consentModule = require("../host/ai-consent");
  const responses = require("../host/chatgpt-responses");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-summary-"));
  const variables = ["MORROW_AI_CONFIG_DIR", "MORROW_AI_API_KEY", "MORROW_AI_MODEL", "MORROW_AI_BASE_URL", "XAI_API_KEY", "MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_MAIL_SECRETS"];
  const originalEnv = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const original = { fetch: global.fetch, consent: consentModule.getConsent, responses: responses.getResponses };
  for (const name of variables) delete process.env[name];
  process.env.MORROW_AI_CONFIG_DIR = directory;
  process.env.MORROW_MAIL_DIR = directory;
  process.env.MORROW_USER_DATA = directory;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const account = { activeId: "fixture-ai", connected: true, planEnabled: true, accounts: [{ id: "fixture-ai", label: "Fixture" }] };
  const consent = consentModule.createConsent({ directory: () => directory, config: config.loadConfig, account: () => account, background() {} });
  consentModule.getConsent = () => consent;
  let current = email(), calls = [], responder = async () => "Main point: review by Friday.", finishReason = "stop";
  const sender = new EventEmitter(), other = new EventEmitter();
  sender.isDestroyed = other.isDestroyed = () => false;
  const service = createSummaryService({ readMessage(input) {
    if (!current || current.accountId !== input.accountId || current.id !== input.emailId) throw Object.assign(new Error("Message gone"), { code: "email-gone" });
    if (current.bodyEpoch !== input.bodyEpoch) throw Object.assign(new Error("Connection changed"), { code: "message_changed" });
    return { ...current };
  } });
  const allow = () => consent.grant({ token: consent.status().token, manual: true, background: false });
  global.fetch = async (url, input) => {
    assert.equal(String(url), "https://summary-fixture.invalid/v1/chat/completions");
    assert.equal(input.redirect, "error");
    calls.push({ input, body: JSON.parse(input.body) });
    const content = await responder(input);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }));
  };
  responses.getResponses = () => ({ complete: async (messages, options) => {
    calls.push({ messages, options }); return responder(options);
  } });
  try {
    let result = await service.summarize(params(), sender);
    assert.equal(result.error.code, "ai-unconfigured"); assert.equal(calls.length, 0);
    config.saveConfig({ authMode: "api_key", baseUrl: "https://summary-fixture.invalid/v1", model: "fixture", apiKey: "synthetic-only" });
    result = await service.summarize(params(), sender);
    assert.equal(result.error.code, "ai-consent-required"); assert.equal(calls.length, 0);
    allow(); result = await service.summarize(params(), sender);
    assert.equal(result.data.emailId, "one"); assert.equal(result.data.accountId, "alpha");
    assert.match(result.data.text, /Friday/); assert.equal(calls.length, 1);
    const sent = calls[0].body;
    assert.equal(sent.model, "fixture"); assert.equal(sent.max_tokens, 1200);
    assert.match(JSON.stringify(sent), /Review the plan/);
    assert.doesNotMatch(JSON.stringify(sent), /do-not-send|private-fixture|accountId|emailId/);
    assert.match(sent.messages[0].content, /untrusted data/);
    for (const invalid of [{ ...params(), accountId: "beta" }, { ...params(), bodyEpoch: 1 }, { ...params(), reqId: "" }]) {
      assert.equal((await service.summarize(invalid, sender)).success, false);
    }
    assert.equal(calls.length, 1, "invalid identity never calls a provider");
    current = { ...email(), textBody: "", htmlBody: "", snippet: "Only a snippet" };
    assert.equal((await service.summarize(params(), sender)).error.code, "summary-no-content");
    assert.equal(calls.length, 1);
    current = { ...email(), textBody: "", htmlBody: '<style>hidden-css</style><script>hidden-script</script><p>Hello &#x4e16;&#x754c; &amp; team</p><img src="https://never-fetch.invalid/pixel">', bodyComplete: false };
    result = await service.summarize(params(), sender);
    const htmlSent = JSON.parse(calls.at(-1).body.messages[1].content);
    assert.match(htmlSent.text, /Hello 世界 & team/); assert.doesNotMatch(htmlSent.text, /hidden-|never-fetch/);
    assert.match(result.data.warnings.join(" "), /incomplete/);
    current = { ...email(), textBody: "x".repeat(BODY_CHARS) + "OMITTED-END" };
    result = await service.summarize(params(), sender);
    assert.equal(JSON.parse(calls.at(-1).body.messages[1].content).text.length, BODY_CHARS);
    assert.match(result.data.warnings.join(" "), /24,000/); assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /OMITTED-END/);
    current = email();
    for (const reason of ["length", "content_filter", "tool_calls"]) {
      finishReason = reason;
      assert.equal((await service.summarize(params(), sender)).error.code, "ai-incomplete");
    }
    finishReason = "stop";
    responder = async () => ""; assert.equal((await service.summarize(params(), sender)).error.code, "summary-empty");
    responder = async () => "x".repeat(12001); assert.equal((await service.summarize(params(), sender)).error.code, "summary-too-long");
    responder = async () => { throw Error("Synthetic provider failure"); };
    assert.match((await service.summarize(params(), sender)).error.message, /Synthetic provider failure/);
    const beforeQueued = calls.length;
    const queued = service.summarize(params("queued"), sender);
    consent.revoke(); allow();
    assert.equal((await queued).error.code, "ai-consent-required");
    assert.equal(calls.length, beforeQueued, "reapproval cannot resume a queued summary with an old consent stamp");
    for (const retire of ["cancel", "destroy", "account", "revoke", "config"]) {
      allow(); const wait = deferred(); responder = () => wait.promise;
      const task = service.summarize(params(retire), sender); await tick();
      const signal = calls.at(-1).input.signal;
      if (retire === "cancel") {
        service.cancel({ reqId: retire }, other); assert.equal(signal.aborted, false, "another window cannot cancel");
        service.cancel({ reqId: "wrong-request" }, sender); assert.equal(signal.aborted, false, "wrong request cannot cancel");
        assert.equal((await service.summarize(params("duplicate"), sender)).error.code, "summary-busy");
        service.cancel({ reqId: retire }, sender);
      } else if (retire === "destroy") sender.emit("destroyed");
      else if (retire === "account") service.invalidateAccount("alpha");
      else if (retire === "revoke") consent.revoke();
      else config.saveConfig({ model: "changed-fixture" });
      assert.equal(signal.aborted, true);
      if (["cancel", "destroy", "account"].includes(retire)) {
        const cancelled = await task; assert.equal(cancelled.error.code, "summary-cancelled", "cancellation settles before a stalled provider returns");
      }
      wait.resolve("Late answer must be discarded");
      assert.equal((await task).success, false); await tick();
      assert.equal(sender.listenerCount("destroyed"), 0);
    }
    allow();
    for (const mutate of [() => { current = { ...current, textBody: "Changed while generating" }; }, () => { current = { ...current, bodyEpoch: 1 }; }, () => { current = null; }]) {
      current = email(); const wait = deferred(); responder = () => wait.promise;
      const task = service.summarize(params(), sender); await tick(); mutate(); wait.resolve("Old answer");
      assert.equal((await task).success, false, "stale source cannot return a summary");
    }
    current = email(); responder = async () => "ChatGPT fixture summary";
    config.saveConfig({ authMode: "chatgpt", chatgptModel: "fixture-chat" });
    assert.equal((await service.summarize(params(), sender)).error.code, "ai-consent-required");
    allow(); result = await service.summarize(params(), sender);
    assert.equal(result.data.text, "ChatGPT fixture summary"); assert.equal(calls.at(-1).options.model, "fixture-chat");
    assert.equal(calls.at(-1).options.background, false, "manual permission alone suffices");
    // Exercise the production engine and real temporary SQLite identity lookup.
    const electronPath = require.resolve("electron"), savedElectron = require.cache[electronPath];
    const events = [];
    require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
      exports: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }] } } };
    const engine = require("../host/mail/engine"), db = require("../host/mail/db");
    try {
      await engine.init();
      const mailbox = { id: "alpha", email: "me@alpha.invalid", username: "me@alpha.invalid", profile: "custom", createdAt: 1,
        imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true };
      const seed = () => { db.insertAccount(mailbox); db.replaceFolders("alpha", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }]);
        db.insertMessage({ ...email(), folderPath: "INBOX", uid: 1, uidValidity: 1, threadId: "one", listSortTs: 1 }); };
      seed();
      const invoke = input => engine.answer("mail:summarizeEmail", [input], { sender });
      const before = calls.length;
      assert.equal((await invoke({ ...params(), accountId: "beta" })).error.code, "email-gone");
      assert.equal((await invoke({ ...params(), bodyEpoch: 99 })).error.code, "message_changed");
      assert.equal(calls.length, before);
      result = await invoke({ ...params(), textBody: "FORGED RENDERER BODY" }); assert.equal(result.success, true);
      assert.match(calls.at(-1).messages[1].content, /Review the plan/); assert.doesNotMatch(calls.at(-1).messages[1].content, /FORGED/);
      assert.equal(events.length, 0, "summary output is never broadcast to other windows");
      const changed = deferred(); responder = () => changed.promise;
      const changing = invoke(params("changing")); await tick(); db.updateMessage("one", { text_body: "New downloaded body" }); changed.resolve("Old content summary");
      assert.equal((await changing).error.code, "message_changed");
      const removed = deferred(); responder = () => removed.promise;
      const removing = invoke(params("removing")); await tick(); const signal = calls.at(-1).options.signal;
      await engine.answer("mail:removeAccount", [{ accountId: "alpha" }]);
      assert.equal(signal.aborted, true); assert.equal((await removing).error.code, "summary-cancelled");
      removed.resolve("Removed mailbox summary"); await tick(); seed();
      assert.equal((await invoke(params())).error.code, "message_changed", "a re-added mailbox cannot reuse an old epoch");
      responder = async () => "New mailbox summary";
      assert.equal((await invoke({ ...params(), bodyEpoch: 1 })).data.text, "New mailbox summary");
    } finally {
      await engine.stopIdle(); await db.close();
      if (savedElectron) require.cache[electronPath] = savedElectron; else delete require.cache[electronPath];
    }
    // Drive the actual deadline without waiting two minutes or changing the API.
    let deadline, cleared = false;
    const module = { exports: {} };
    vm.runInNewContext(source("host/message-summary.js"), { module, require: createRequire(require.resolve("../host/message-summary")), AbortController,
      setTimeout(work, milliseconds) { assert.equal(milliseconds, 120000); deadline = work; return 1; }, clearTimeout() { cleared = true; } });
    const timeout = module.exports.createSummaryService({ readMessage: email, complete: () => new Promise(() => {}) });
    const timed = timeout.summarize(params(), sender); await tick(); deadline();
    assert.equal((await timed).error.code, "summary-cancelled"); assert.equal(cleared, true);
  } finally {
    global.fetch = original.fetch; consentModule.getConsent = original.consent; responses.getResponses = original.responses;
    for (const [key, value] of Object.entries(originalEnv)) if (value == null) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function rendererChecks() {
  for (const role of ["shell", "reader"]) {
    const dom = new JSDOM(source("renderer/index.html"));
    const ui = renderer({ document: dom.window.document });
    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
    ui.context.fixtureEmail = email();
    ui.run(`state.accounts=[{id:'alpha',email:'me@alpha.invalid',bodyEpoch:0},{id:'beta',email:'me@beta.invalid',bodyEpoch:0}];
      state.accountId='alpha';state.email=fixtureEmail;state.prefs.conversation=false;
      globalThis.requests=[];globalThis.replies=[];
      call=async(channel,input)=>{requests.push({channel,input});if(channel==='mail:summarizeEmail')return new Promise((resolve,reject)=>replies.push({resolve,reject,input}));return {}};
      renderList=()=>{};document.documentElement.dataset.window='${role === "reader" ? "reader" : ""}';renderReader(false);`);
    const doc = dom.window.document, button = () => doc.querySelector('[data-action="summary"]'), box = () => doc.querySelector(".message-summary");
    assert.equal(ui.run("requests.length"), 0); assert.equal(box().hidden, true);
    assert.equal(button().textContent, "Summary"); assert.equal(button().getAttribute("aria-controls"), "message-summary");
    button().click(); button().click(); await tick();
    assert.equal(ui.run("requests.length"), 1); assert.equal(button().disabled, true); assert.equal(box().hidden, false);
    assert.match(box().textContent, /Project notes.*Ada.*me@alpha.invalid/);
    assert.equal(doc.querySelector('[data-role="summary-status"]').getAttribute("role"), "status");
    ui.run(`replies[0].resolve({...replies[0].input,text:'<img src=x onerror=alert(1)>\\nReview by Friday.',warnings:[]})`); await tick();
    assert.match(box().textContent, /Review by Friday/); assert.equal(box().querySelector("img"), null);
    assert.equal(button().disabled, false); ui.run("renderReader(false)"); assert.match(box().textContent, /Review by Friday/);
    assert.equal(ui.run("requests.length"), 1, "repaint never generates");
    button().click(); await tick(); doc.querySelector('[data-role="summary-cancel"]').click(); await tick();
    assert.match(box().textContent, /cancelled/); assert.equal(button().disabled, false);
    button().click(); await tick();
    ui.run(`replies[1].resolve({...replies[1].input,text:'OLD CANCELLED',warnings:[]});replies[2].resolve({...replies[2].input,text:'Fresh summary',warnings:['Incomplete content']})`); await tick();
    assert.match(box().textContent, /Fresh summary/); assert.doesNotMatch(box().textContent, /OLD CANCELLED/);
    assert.match(box().textContent, /Incomplete content/);
    // Same local ID in another account, then return to the original: neither can inherit late work.
    button().click(); await tick();
    ui.run(`state.email={...state.email,accountId:'beta'};renderReader(false);state.email=fixtureEmail;renderReader(false);
      replies[3].resolve({...replies[3].input,text:'OLD ACCOUNT',warnings:[]})`); await tick(); assert.equal(box().hidden, true);
    button().click(); await tick();
    ui.run(`state.email.textBody='new content';renderReader(false,true);replies[4].resolve({...replies[4].input,text:'OLD BODY',warnings:[]})`); await tick(); assert.equal(box().hidden, true);
    button().click(); await tick();
    ui.run(`acceptBodyAccounts([{id:'alpha',email:'me@alpha.invalid',bodyEpoch:1}]);replies[5].resolve({...replies[5].input,text:'OLD CONNECTION',warnings:[]})`); await tick(); assert.equal(box().hidden, true);
    ui.run(`state.email={...fixtureEmail,bodyEpoch:1};renderReader(false);requestMessageSummary(state.email);`); await tick();
    ui.run(`replies[6].reject(Object.assign(new Error('AI data use is off. Review AI data permission.'),{code:'ai-consent-required'}))`); await tick();
    assert.match(box().textContent, /AI data use is off/); assert.equal(doc.querySelector('[data-role="summary-settings"]').hidden, false);
    assert.equal(button().disabled, false);
    ui.run("requestMessageSummary(state.email)"); await tick();
    ui.run(`replies[7].resolve({...replies[7].input,accountId:'wrong',text:'Wrong result',warnings:[]})`); await tick();
    assert.match(box().textContent, /did not match/); assert.doesNotMatch(box().textContent, /Wrong result/);
    const before = ui.run("requests.length"); ui.run("renderReader(false)"); assert.equal(ui.run("requests.length"), before);
    let openedSettings = false, fold = "";
    ui.context.openSettingsFixture = () => { openedSettings = true; };
    ui.context.revealSettingsFixture = value => { fold = value; };
    ui.run("openSettings=openSettingsFixture;revealSettingsFold=revealSettingsFixture;messageSummary.settings=true;paintMessageSummary(state.email)");
    doc.querySelector('[data-role="summary-settings"]').click(); assert.equal(openedSettings, true); assert.equal(fold, "ai");
    ui.run("paintFeatureCatalog()"); const help = doc.getElementById("features-catalog").textContent;
    for (const word of ["Message summary", "24,000", "Cancel summary", "AI data permission", "two minutes", "no CLI command"]) assert.ok(help.includes(word), word);
    dom.window.close();
  }
  // Actual preload allowlist routes these exact invokes and still rejects unknown names.
  let bridge, invoked = [];
  vm.runInNewContext(source("renderer/preload.js"), { require: () => ({ contextBridge: { exposeInMainWorld(_name, api) { bridge = api; } },
    ipcRenderer: { invoke: async (channel, input) => { invoked.push({ channel, input }); return {}; } } }) });
  await bridge.invoke("mail:summarizeEmail", params()); await bridge.invoke("mail:cancelSummary", { reqId: "fixture-request" });
  await assert.rejects(bridge.invoke("mail:summarizeAnything", {}), /Unsupported channel/);
  assert.deepEqual(invoked.map(row => row.channel), ["mail:summarizeEmail", "mail:cancelSummary"]);
}

async function run() {
  assert.throws(() => summaryInput({ snippet: "headers only" }), /No readable message body/);
  await hostChecks(); await rendererChecks();
  console.log("message-summary-ok: real consent/API/ChatGPT transport, identity/content fences, owned cancellation, late output, HTML/partial/long/empty input, both readers, preload and rendered help");
}
module.exports = { run };
if (require.main === module) run().catch(value => { console.error(value); process.exitCode = 1; });
