// Synthetic mail, providers and temporary permission files only. No real secrets or network.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { createSummaryService, summaryInput, validateSummary, BODY_CHARS, LIMITS } = require("../host/message-summary");
const { renderer } = require("./check-ux-workflows");
const { JSDOM } = require("jsdom");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const source = filename => fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
const summary = (mainPoint = "Review the plan.", bullets = ["Ada asks for a reply by Friday."]) => ({ mainPoint, bullets });
const output = (...args) => JSON.stringify(summary(...args));
const email = () => ({ id: "one", accountId: "alpha", bodyEpoch: 0, bodyComplete: true, subject: "Project notes",
  from: "Ada <ada@example.invalid>", date: "2026-11-03T08:00:00Z", textBody: "Review the plan by Friday.",
  attachments: [{ filename: "do-not-send.pdf", bytes: "private-fixture" }] });
const params = (reqId = "fixture-request") => ({ reqId, emailId: "one", accountId: "alpha", bodyEpoch: 0 });
const start = (input, plan, extra = {}) => ({ ...input, planId: plan.planId, scope: "full", accepted: true, ...extra });

function inputChecks() {
  assert.throws(() => summaryInput({ snippet: "headers only" }), /No readable message body/);
  for (const body of ["x".repeat(BODY_CHARS - 1) + "🙂end", "書類🙂\n".repeat(3000), '\\"'.repeat(7000)]) {
    const input = summaryInput({ ...email(), textBody: body });
    assert.equal(input.parts.join(""), body.trim());
    for (const part of [...input.parts, input.excerpt]) assert.equal(/(?:[\uD800-\uDBFF]$|^[\uDC00-\uDFFF])/.test(part), false);
    assert.equal(input.excerptCharacters, Array.from(input.excerpt).length);
    assert.ok(input.needsReview);
  }
  assert.equal(summaryInput({ ...email(), textBody: "x".repeat(LIMITS.sourceBytes + 1) }).parts.length, 0);
  for (const bad of [null, "text", { mainPoint: "One", bullets: ["Two"], extra: "bad" },
    { mainPoint: "One", bullets: ["x\ny"] }, summary("x".repeat(361)), summary("One", Array(7).fill("Two"))]) {
    assert.throws(() => validateSummary(bad), /invalid summary/);
  }
  assert.deepEqual(validateSummary(summary("<img src=x onerror=alert(1)>", ["USD 125.40 is still unpaid."])),
    summary("<img src=x onerror=alert(1)>", ["USD 125.40 is still unpaid."]));
}

async function hostChecks() {
  const config = require("../host/ai-config"), consentModule = require("../host/ai-consent"), responses = require("../host/chatgpt-responses");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-summary-"));
  const variables = ["MORROW_AI_CONFIG_DIR", "MORROW_AI_API_KEY", "MORROW_AI_MODEL", "MORROW_AI_BASE_URL", "XAI_API_KEY", "MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_MAIL_SECRETS"];
  const originalEnv = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const original = { fetch: global.fetch, consent: consentModule.getConsent, responses: responses.getResponses };
  for (const name of variables) delete process.env[name];
  for (const name of ["MORROW_AI_CONFIG_DIR", "MORROW_MAIL_DIR", "MORROW_USER_DATA"]) process.env[name] = directory;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const account = { activeId: "fixture-ai", connected: true, planEnabled: true, accounts: [{ id: "fixture-ai", label: "Fixture" }] };
  const consent = consentModule.createConsent({ directory: () => directory, config: config.loadConfig, account: () => account, background() {} });
  consentModule.getConsent = () => consent;
  let current = email(), calls = [], responder = async () => output(), finishReason = "stop", clock = 1;
  const sender = new EventEmitter(), other = new EventEmitter();
  sender.isDestroyed = other.isDestroyed = () => false;
  const readMessage = input => {
    if (!current || current.accountId !== input.accountId || current.id !== input.emailId) throw Object.assign(new Error("Message gone"), { code: "email-gone" });
    if (current.bodyEpoch !== input.bodyEpoch) throw Object.assign(new Error("Connection changed"), { code: "message_changed" });
    return { ...current };
  };
  const service = createSummaryService({ readMessage, now: () => clock });
  const invoke = async (input = params(), owner = sender) => {
    const prepared = service.prepare(input, owner);
    return prepared.success ? service.summarize(start(input, prepared.data), owner) : prepared;
  };
  const allow = () => consent.grant({ token: consent.status().token, manual: true, background: false });
  global.fetch = async (url, input) => {
    assert.equal(String(url), "https://summary-fixture.invalid/v1/chat/completions"); assert.equal(input.redirect, "error");
    calls.push({ input, body: JSON.parse(input.body) });
    const content = await responder(input);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }));
  };
  responses.getResponses = () => ({ complete: async (messages, options) => {
    calls.push({ messages, options }); return { text: await responder(options), finishReason: "completed" };
  } });
  try {
    assert.equal((await invoke()).error.code, "ai-unconfigured"); assert.equal(calls.length, 0);
    config.saveConfig({ authMode: "api_key", baseUrl: "https://summary-fixture.invalid/v1", model: "fixture", apiKey: "synthetic-only" });
    assert.equal((await invoke()).error.code, "ai-consent-required"); assert.equal(calls.length, 0);
    allow(); let result = await invoke();
    assert.equal(result.success, true); assert.equal(result.data.emailId, "one"); assert.equal(result.data.accountId, "alpha");
    assert.match(result.data.summary.bullets[0], /Friday/); assert.equal(calls.length, 1);
    const sent = calls[0].body;
    assert.equal(sent.model, "fixture"); assert.equal(sent.max_tokens, 1200);
    assert.match(JSON.stringify(sent), /Review the plan/); assert.doesNotMatch(JSON.stringify(sent), /do-not-send|private-fixture|accountId|emailId/);
    assert.match(sent.messages[0].content, /untrusted data/); assert.match(sent.messages[0].content, /ASD-STE100-inspired/);
    assert.match(sent.messages[0].content, /exact amounts.*requests, not agreed commitments/);
    for (const invalid of [{ ...params(), accountId: "beta" }, { ...params(), bodyEpoch: 1 }, { ...params(), reqId: "" }]) assert.equal((await invoke(invalid)).success, false);
    assert.equal(calls.length, 1);
    current = { ...email(), textBody: "", htmlBody: "", snippet: "Only a snippet" };
    assert.equal((await invoke()).error.code, "summary-no-content"); assert.equal(calls.length, 1);
    current = { ...email(), textBody: "", htmlBody: '<style>hidden-css</style><script>hidden-script</script><p>Hello &#x4e16;&#x754c; &amp; team</p><img src="https://never-fetch.invalid/pixel">', bodyComplete: false };
    let plan = service.prepare(params(), sender).data;
    assert.equal(plan.needsReview, true); assert.equal(calls.length, 1);
    assert.equal((await service.summarize(start(params(), plan, { accepted: false }), sender)).error.code, "summary-review-required");
    result = await service.summarize(start(params(), plan), sender);
    const htmlSent = JSON.parse(calls.at(-1).body.messages[1].content);
    assert.match(htmlSent.text, /Hello 世界 & team/); assert.doesNotMatch(htmlSent.text, /hidden-|never-fetch/);
    assert.match(result.data.warnings.join(" "), /incomplete/);

    // Preparation never transmits long text. The explicit full path includes a late amount/deadline.
    current = { ...email(), textBody: "Earlier note: review stock records.\n".repeat(1100) + "FINAL: Ada requests USD 125.40 by 2026-12-18; payment is unconfirmed." };
    const beforeLong = calls.length;
    plan = service.prepare(params("long"), sender).data;
    assert.equal(plan.needsReview, true); assert.equal(plan.full.available, true); assert.equal(calls.length, beforeLong);
    assert.equal((await service.summarize(start(params("long"), plan, { accepted: false }), sender)).error.code, "summary-review-required");
    assert.equal((await service.summarize(start(params("long"), plan), other)).error.code, "summary-review-expired");
    assert.equal(calls.length, beforeLong);
    responder = async input => {
      const body = JSON.parse(input.body), data = JSON.parse(body.messages[1].content);
      const late = data.text?.includes("FINAL:") || data.parts?.some(part => part.summary.bullets.some(text => text.includes("USD 125.40")));
      return output("Ada requests a review.", late ? ["Ada requests USD 125.40 by 2026-12-18; payment is unconfirmed."] : []);
    };
    result = await service.summarize(start(params("long"), plan), sender);
    assert.equal(result.success, true); assert.match(JSON.stringify(result.data.summary), /USD 125.40 by 2026-12-18; payment is unconfirmed/);
    const longCalls = calls.slice(beforeLong), parts = longCalls.map(call => JSON.parse(call.body.messages[1].content)).filter(data => "text" in data);
    assert.equal(parts.map(part => part.text).join(""), current.textBody);
    assert.equal(result.data.coverage.included, Array.from(current.textBody).length);
    assert.equal(result.data.coverage.calls, plan.full.calls); assert.equal(longCalls.length, plan.full.calls);
    assert.ok(longCalls.every(call => Buffer.byteLength(JSON.stringify(call.body.messages)) <= LIMITS.requestBytes));
    assert.ok(longCalls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.body.messages)), 0) <= LIMITS.inputBytes);
    assert.equal((await service.summarize(start(params("long"), plan), sender)).error.code, "summary-review-expired", "reviews are single-use");
    plan = service.prepare(params("excerpt"), sender).data; const beforeExcerpt = calls.length;
    result = await service.summarize(start(params("excerpt"), plan, { scope: "excerpt" }), sender);
    assert.equal(result.success, true); assert.equal(calls.length, beforeExcerpt + 1);
    assert.match(result.data.warnings.join(" "), /Excerpt only.*Later text is not included/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /FINAL:/);
    assert.equal(result.data.coverage.included, plan.excerpt.characters);
    current = { ...email(), textBody: "x".repeat(LIMITS.sourceBytes + 1) };
    plan = service.prepare(params(), sender).data; const beforeOver = calls.length;
    assert.equal(plan.full.available, false);
    assert.equal((await service.summarize(start(params(), plan), sender)).error.code, "summary-budget"); assert.equal(calls.length, beforeOver);
    responder = async () => output(); result = await service.summarize(start(params(), plan, { scope: "excerpt" }), sender); assert.equal(result.success, true);

    // Reviews expire and are invalidated by source, consent, window and account changes.
    current = email(); plan = service.prepare(params(), sender).data; clock += LIMITS.reviewMs;
    assert.equal((await service.summarize(start(params(), plan), sender)).error.code, "summary-review-expired");
    plan = service.prepare(params(), sender).data; current.textBody += " Changed.";
    assert.equal((await service.summarize(start(params(), plan), sender)).error.code, "message_changed");
    plan = service.prepare(params(), sender).data; consent.revoke(); allow();
    assert.equal((await service.summarize(start(params(), plan), sender)).error.code, "ai-consent-required");
    for (const retire of [() => service.cancel({ reqId: params().reqId }, sender), () => sender.emit("destroyed"), () => service.invalidateAccount("alpha")]) {
      plan = service.prepare(params(), sender).data; retire();
      assert.equal((await service.summarize(start(params(), plan), sender)).error.code, "summary-review-expired");
    }
    current = email();
    for (const reason of ["length", "content_filter", "tool_calls", undefined]) {
      finishReason = reason; assert.equal((await invoke()).error.code, "ai-incomplete");
    }
    finishReason = "stop";
    for (const [answer, code] of [["", "summary-empty"], ["x".repeat(6001), "summary-too-long"], ["- a plain bullet", "summary-format"],
      [JSON.stringify({ mainPoint: "One", bullets: Array(7).fill("Two") }), "summary-format"]]) {
      responder = async () => answer; assert.equal((await invoke()).error.code, code);
    }
    responder = async () => "x".repeat(50000);
    assert.match((await invoke()).error.message, /AI response exceeds the output limit/, "Summary uses the bounded detailed transport");
    current = { ...email(), textBody: "Long reviewed evidence.\n".repeat(1500) };
    responder = async input => JSON.parse(JSON.parse(input.body).messages[1].content).parts ? "invalid consolidation" : output();
    result = await invoke(); assert.equal(result.error.code, "summary-format"); assert.equal(result.data, undefined, "intermediate summaries never escape as a complete result");
    current = email();
    responder = async () => { throw Error("Synthetic provider failure"); };
    assert.match((await invoke()).error.message, /AI request failed|Synthetic provider failure/);
    responder = async () => output();
    const beforeQueued = calls.length, queued = invoke(params("queued")); consent.revoke(); allow();
    assert.equal((await queued).error.code, "ai-consent-required"); assert.equal(calls.length, beforeQueued);
    for (const retire of ["cancel", "destroy", "account", "revoke", "config", "source"]) {
      allow(); const wait = deferred(); responder = () => wait.promise;
      const task = invoke(params(retire)); await tick(); const signal = calls.at(-1).input.signal;
      if (retire === "cancel") {
        service.cancel({ reqId: retire }, other); assert.equal(signal.aborted, false);
        service.cancel({ reqId: "wrong-request" }, sender); assert.equal(signal.aborted, false);
        assert.equal((await invoke(params("duplicate"))).error.code, "summary-busy"); service.cancel({ reqId: retire }, sender);
      } else if (retire === "destroy") sender.emit("destroyed");
      else if (retire === "account") service.invalidateAccount("alpha");
      else if (retire === "revoke") consent.revoke();
      else if (retire === "source") current.textBody += " Changed while pending.";
      else config.saveConfig({ model: "changed-fixture" });
      if (retire !== "source") assert.equal(signal.aborted, true);
      if (["cancel", "destroy", "account"].includes(retire)) assert.equal((await task).error.code, "summary-cancelled");
      wait.resolve(output("Late answer")); assert.equal((await task).success, false); await tick(); assert.equal(sender.listenerCount("destroyed"), 0);
    }
    // Consent/source/cancel retirement after part 1 must prevent every later send.
    for (const retire of ["revoke", "config", "source", "cancel"]) {
      current = { ...email(), textBody: "Long synthetic record.\n".repeat(1500) }; allow(); const before = calls.length;
      responder = async () => {
        if (retire === "revoke") { consent.revoke(); allow(); }
        else if (retire === "config") config.saveConfig({ model: "second-fixture" });
        else if (retire === "source") current.textBody += " New body.";
        else service.cancel({ reqId: "between" }, sender);
        return output();
      };
      assert.equal((await invoke(params("between"))).success, false); assert.equal(calls.length, before + 1);
    }
    allow(); current = email(); responder = async () => output("ChatGPT fixture summary");
    config.saveConfig({ authMode: "chatgpt", chatgptModel: "fixture-chat" });
    assert.equal((await invoke()).error.code, "ai-consent-required"); allow(); result = await invoke();
    assert.equal(result.data.summary.mainPoint, "ChatGPT fixture summary"); assert.equal(calls.at(-1).options.model, "fixture-chat");
    assert.equal(calls.at(-1).options.background, false);
    // Production engine, actual prepare IPC and temporary SQLite lookup.
    const electronPath = require.resolve("electron"), savedElectron = require.cache[electronPath], events = [];
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
      const invokeEngine = async input => {
        const prepared = await engine.answer("mail:prepareSummary", [input], { sender });
        return prepared.success ? engine.answer("mail:summarizeEmail", [start(input, prepared.data)], { sender }) : prepared;
      };
      const before = calls.length;
      assert.equal((await invokeEngine({ ...params(), accountId: "beta" })).error.code, "email-gone");
      assert.equal((await invokeEngine({ ...params(), bodyEpoch: 99 })).error.code, "message_changed"); assert.equal(calls.length, before);
      result = await invokeEngine({ ...params(), textBody: "FORGED RENDERER BODY" }); assert.equal(result.success, true);
      assert.match(calls.at(-1).messages[1].content, /Review the plan/); assert.doesNotMatch(calls.at(-1).messages[1].content, /FORGED/); assert.equal(events.length, 0);
      const changed = deferred(); responder = () => changed.promise;
      const changing = invokeEngine(params("changing")); await tick(); db.updateMessage("one", { text_body: "New downloaded body" }); changed.resolve(output("Old content"));
      assert.equal((await changing).error.code, "message_changed");
      const removed = deferred(); responder = () => removed.promise;
      const removing = invokeEngine(params("removing")); await tick(); const signal = calls.at(-1).options.signal;
      await engine.answer("mail:removeAccount", [{ accountId: "alpha" }]); assert.equal(signal.aborted, true); assert.equal((await removing).error.code, "summary-cancelled");
      removed.resolve(output("Removed mailbox")); await tick(); seed();
      assert.equal((await invokeEngine(params())).error.code, "message_changed");
      responder = async () => output("New mailbox summary");
      assert.equal((await invokeEngine({ ...params(), bodyEpoch: 1 })).data.summary.mainPoint, "New mailbox summary");
    } finally { await engine.stopIdle(); await db.close(); if (savedElectron) require.cache[electronPath] = savedElectron; else delete require.cache[electronPath]; }
    // Drive short and long deadlines without waiting or weakening production timers.
    for (const long of [false, true]) {
      let deadline, cleared = false; const module = { exports: {} };
      vm.runInNewContext(source("host/message-summary.js"), { module, require: createRequire(require.resolve("../host/message-summary")), AbortController, AbortSignal, Buffer,
        setTimeout(work, milliseconds) { assert.equal(milliseconds, long ? LIMITS.jobMs : LIMITS.requestMs); deadline = work; return 1; }, clearTimeout() { cleared = true; } });
      const timeout = module.exports.createSummaryService({ readMessage: () => ({ ...email(), textBody: long ? "x".repeat(30000) : "Short" }), complete: () => new Promise(() => {}) });
      const prepared = timeout.prepare(params(), sender); const timed = timeout.summarize(start(params(), prepared.data), sender); await tick(); deadline();
      assert.equal((await timed).error.code, "summary-cancelled"); assert.equal(cleared, true);
    }
  } finally {
    global.fetch = original.fetch; consentModule.getConsent = original.consent; responses.getResponses = original.responses;
    for (const [key, value] of Object.entries(originalEnv)) if (value == null) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function rendererChecks() {
  for (const role of ["shell", "reader"]) {
    const dom = new JSDOM(source("renderer/index.html")), ui = renderer({ document: dom.window.document });
    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog"); ui.context.fixtureEmail = email();
    ui.context.fixtureSummary = summary();
    ui.run(`state.accounts=[{id:'alpha',email:'me@alpha.invalid',bodyEpoch:0},{id:'beta',email:'me@beta.invalid',bodyEpoch:0}];
      state.accountId='alpha';state.email=fixtureEmail;state.prefs.conversation=false;globalThis.requests=[];globalThis.replies=[];
      globalThis.reviewMode=false;globalThis.prepareWait=false;globalThis.prepares=[];
      call=async(channel,input)=>{requests.push({channel,input});
        if(channel==='mail:prepareSummary') { const plan={...input,planId:'test-plan',needsReview:reviewMode,destination:'https://fixture.invalid/v1/chat/completions',model:'fixture',characters:40000,warnings:reviewMode?['The download may be incomplete. This summary covers downloaded text only.']:[],full:{available:true,calls:5,reason:''},excerpt:{characters:12000,omitted:28000}};
          return prepareWait?new Promise(resolve=>prepares.push(()=>resolve(plan))):plan; }
        if(channel==='mail:summarizeEmail')return new Promise((resolve,reject)=>replies.push({resolve,reject,input}));return {}};
      renderList=()=>{};document.documentElement.dataset.window='${role === "reader" ? "reader" : ""}';renderReader(false);`);
    const doc = dom.window.document, button = () => doc.querySelector('[data-action="summary"]'), box = () => doc.querySelector(".message-summary");
    assert.equal(ui.run("requests.length"), 0); assert.equal(box().hidden, true);
    button().click(); button().click(); await tick();
    assert.equal(ui.run("replies.length"), 1); assert.equal(button().disabled, true);
    assert.equal(doc.querySelector('[data-role="summary-status"]').getAttribute("role"), "status");
    ui.run(`replies[0].resolve({...replies[0].input,summary:{mainPoint:'<img src=x onerror=alert(1)>',bullets:['Ada asks for USD 125.40 by Friday.','Payment remains unconfirmed.']},warnings:[]})`); await tick();
    assert.equal(box().querySelector("img"), null); assert.equal(box().querySelectorAll("li").length, 2);
    assert.match(box().textContent, /USD 125.40/); assert.equal(box().querySelector("details").open, false);
    assert.match(box().querySelector("details").textContent, /Project notes.*Ada.*me@alpha.invalid/);
    assert.doesNotMatch(doc.querySelector('[data-role="summary-status"]').textContent, /AI-generated/);
    const details = box().querySelector("details"), toggled = new Promise(resolve => details.addEventListener("toggle", resolve, { once: true }));
    details.open = true; await toggled; ui.run("renderReader(false)"); assert.equal(box().querySelector("details").open, true);
    assert.equal(ui.run("replies.length"), 1, "repaint never generates");
    button().click(); await tick(); doc.querySelector('[data-role="summary-cancel"]').click(); await tick();
    assert.match(box().textContent, /cancelled/); assert.equal(button().disabled, false);
    button().click(); await tick();
    ui.run(`replies[1].resolve({...replies[1].input,summary:{mainPoint:'OLD CANCELLED',bullets:[]},warnings:[]});replies[2].resolve({...replies[2].input,summary:{mainPoint:'Fresh summary',bullets:[]},warnings:['Incomplete content']})`); await tick();
    assert.match(box().textContent, /Fresh summary/); assert.doesNotMatch(box().textContent, /OLD CANCELLED/); assert.match(box().textContent, /Incomplete content/);
    for (const [change, old] of [[`state.email={...state.email,accountId:'beta'};renderReader(false);state.email=fixtureEmail;renderReader(false);`, 'OLD ACCOUNT'],
      [`state.email.textBody='new content';renderReader(false,true);`, 'OLD BODY'],
      [`acceptBodyAccounts([{id:'alpha',email:'me@alpha.invalid',bodyEpoch:1}]);`, 'OLD CONNECTION']]) {
      button().click(); await tick(); ui.run(`${change}replies.at(-1).resolve({...replies.at(-1).input,summary:{mainPoint:'${old}',bullets:[]},warnings:[]})`); await tick(); assert.equal(box().hidden, true);
    }
    ui.run("state.email={...fixtureEmail,bodyEpoch:1};renderReader(false);requestMessageSummary(state.email)"); await tick();
    ui.run(`replies.at(-1).reject(Object.assign(new Error('AI data use is off. Review AI data permission.'),{code:'ai-consent-required'}))`); await tick();
    assert.equal(doc.querySelector('[data-role="summary-settings"]').hidden, false);
    let openedSettings = false, fold = ""; ui.context.openSettingsFixture = () => { openedSettings = true; }; ui.context.revealSettingsFixture = value => { fold = value; };
    ui.run("openSettings=openSettingsFixture;revealSettingsFold=revealSettingsFixture"); doc.querySelector('[data-role="summary-settings"]').click();
    assert.equal(openedSettings, true); assert.equal(fold, "ai");
    button().click(); await tick(); ui.run(`replies.at(-1).resolve({...replies.at(-1).input,accountId:'wrong',summary:{mainPoint:'WRONG',bullets:[]},warnings:[]})`); await tick();
    assert.match(box().textContent, /did not match/); assert.doesNotMatch(doc.querySelector('[data-role="summary-text"]').textContent, /WRONG/);
    // A review does not send until a coverage button is chosen.
    ui.run("reviewMode=true"); const before = ui.run("replies.length"); button().click(); await tick();
    assert.equal(ui.run("replies.length"), before); assert.match(box().textContent, /40,000.*fixture.invalid.*5 AI request/);
    assert.equal(doc.activeElement.dataset.role, "summary-full"); assert.equal(doc.querySelector('[data-role="summary-warnings"]').hidden, false);
    doc.querySelector('[data-role="summary-excerpt"]').click(); await tick();
    assert.equal(ui.run("replies.at(-1).input.scope"), "excerpt"); assert.equal(ui.run("replies.at(-1).input.accepted"), true);
    ui.run(`replies.at(-1).resolve({...replies.at(-1).input,summary:fixtureSummary,warnings:['Excerpt only: 12,000 of 40,000 downloaded characters. Later text is not included.'],coverage:{included:12000,downloaded:40000,parts:1,calls:1}})`); await tick();
    assert.match(doc.querySelector('[data-role="summary-warnings"]').textContent, /Excerpt only/); assert.equal(doc.activeElement, button());
    // Navigating during prepare or while reviewing retires the host plan and prevents generation.
    ui.run("prepareWait=true"); button().click(); await tick();
    ui.run("state.email={...state.email,textBody:'changed during prepare'};renderReader(false,true);prepares.at(-1)()"); await tick();
    assert.equal(box().hidden, true); assert.equal(ui.run("replies.length"), before + 1);
    ui.run("prepareWait=false"); button().click(); await tick();
    const beforeClose = ui.run("requests.length"); doc.querySelector('[aria-label="Dismiss summary"]').click(); await tick();
    assert.equal(box().hidden, true); assert.equal(ui.run("requests[requests.length-1].channel"), "mail:cancelSummary"); assert.equal(ui.run("requests.length"), beforeClose + 1);
    ui.run("paintFeatureCatalog()"); const help = doc.getElementById("features-catalog").textContent;
    for (const word of ["Message summary", "ASD-STE100", "128,000", "Cancel summary", "AI data permission", "no CLI command"]) assert.ok(help.includes(word), word);
    dom.window.close();
  }
  let bridge, invoked = [];
  vm.runInNewContext(source("renderer/preload.js"), { require: () => ({ contextBridge: { exposeInMainWorld(_name, api) { bridge = api; } },
    ipcRenderer: { invoke: async (channel, input) => { invoked.push({ channel, input }); return {}; } } }) });
  for (const channel of ["mail:prepareSummary", "mail:summarizeEmail", "mail:cancelSummary"]) await bridge.invoke(channel, params());
  await assert.rejects(bridge.invoke("mail:summarizeAnything", {}), /Unsupported channel/);
  assert.deepEqual(invoked.map(row => row.channel), ["mail:prepareSummary", "mail:summarizeEmail", "mail:cancelSummary"]);
}

async function run() {
  inputChecks(); await hostChecks(); await rendererChecks();
  console.log("message-summary-ok: structured bullets, Unicode, explicit full/excerpt review, complete long coverage, bounded transport, consent/source races, cancellation, timeout, real engine/preload, both readers and help");
}
module.exports = { run };
if (require.main === module) run().catch(value => { console.error(value); process.exitCode = 1; });
