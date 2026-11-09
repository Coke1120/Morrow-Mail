// Real compose DOM and production renderer; synthetic IPC only, no live mail/AI.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const index = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");

function message(id, body, extra = {}) {
  return { id, accountId: "a", threadId: "thread", bodyEpoch: 3, bodyComplete: true,
    from: `${id} <${id}@fixture.invalid>`, to: ["me@fixture.invalid"], subject: "Conversation",
    textBody: body, htmlBody: "", hasBody: !!body, ...extra };
}
const first = message("first", "Earlier proposal: delivery on Friday.");
const second = message("second", "Earlier answer: please include the appendix.");
const source = message("source", "Please confirm the plan.");
const later = message("later", "Later private follow-up must not be included.");
function header(row) { const { htmlBody, textBody, ...out } = row; return out; }

function fixture(t, messages = [first, second, source, later]) {
  const dom = new JSDOM(index);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }
  dom.window.morrow = { invoke() { throw new Error("Real IPC forbidden"); } };
  dom.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  const ui = renderer({ window: dom.window, document });
  const calls = [];
  const replies = {
    list: async () => messages.map(header),
    body: async payload => ({ email: messages.find(row => row.id === payload.emailId) }),
  };
  ui.context.invoke = async (channel, payload) => {
    calls.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
    if (channel === "mail:listThreadMessages") return replies.list(payload);
    if (channel === "mail:readCachedBody") return replies.body(payload);
    if (channel === "mail:upsertDraft") return { emailId: "draft", remoteSaved: true };
    throw new Error("Unexpected IPC: " + channel);
  };
  ui.context.source = messages.find(row => row.id === "source") || source;
  ui.run(`
    state.accounts = [{id:'a',email:'me@fixture.invalid',platform:'imap',bodyEpoch:3}];
    state.accountId = 'a'; state.prefs.images = false; state.prefs.scheduleDelay = 0;
    state.prefs.aiWriteAutoOpenOnReply = false;
    call = invoke;
    globalThis.productionInitializeComposeIdentity = initializeComposeIdentity;
    initializeComposeIdentity = async () => { state.composeMeta.fromAddress = 'me@fixture.invalid'; };
    fillSignatures = async () => {};
    freshReplyTodoSeed = () => null;
    showComposeSuggestions = async () => {};
    finishComposeOpen = () => {};
    focusComposeBody = () => {};
    opensAiWrite = () => false;
    openDialog = id => { $(id).open = true; };
    closeDialog = async id => { $(id).open = false; };
    scheduleComposeLayout = () => { $('compose').dataset.layout = 'wide'; paintComposeChrome(); };
  `);
  return { ...ui, calls, replies, document, get: id => document.getElementById(id),
    open(kind = "reply", extra = {}) {
      ui.context.extra = extra;
      return ui.run(`globalThis.fields = {...composeSeed(source, ${JSON.stringify(kind)}, 'me@fixture.invalid'), ...extra}; openCompose(fields)`);
    },
    payload() { return JSON.parse(ui.run("JSON.stringify(composePayload(composeAccount()))")); },
  };
}

test("Reply and Reply All show earlier bodies and preserve them in draft/send/schedule output", async t => {
  for (const kind of ["reply", "all"]) {
    const f = fixture(t);
    await f.open(kind);
    assert.equal(f.get("compose-quote-label").textContent, "Conversation history");
    const sections = [...f.get("compose-quote-body").querySelectorAll(".compose-quote-message")];
    assert.equal(sections.length, 3);
    assert.match(sections[0].textContent, /Please confirm/);
    assert.match(sections[1].textContent, /appendix/);
    assert.match(sections[2].textContent, /delivery on Friday/);
    f.get("compose-editor").innerHTML = "<p>Confirmed.</p>";
    f.get("compose-body").value = "Confirmed.";
    const body = f.payload().body;
    for (const text of ["Confirmed.", source.textBody, first.textBody, second.textBody]) assert.ok(body.includes(text));
    assert.ok(!body.includes(later.textBody));
    assert.equal(body.match(/Please confirm the plan/g).length, 1);
    assert.equal(f.run("state.composeInitializing"), false);
    assert.equal(await f.run("saveDraft()"), true);
    assert.equal(f.calls.find(row => row.channel === "mail:upsertDraft").payload.body, body);
    for (const when of ["null", "new Date(Date.now() + 3600000)"]) {
      assert.equal(f.run(`openComposePreview(${when})`), true);
      assert.equal(f.run("previewDraftState.payload.body"), body);
      assert.match(f.get("compose-preview-body").textContent, /appendix/);
      f.run("cancelComposePreview()");
    }
    assert.ok(f.calls.every(row => ["mail:listThreadMessages", "mail:readCachedBody", "mail:upsertDraft"].includes(row.channel)));
    assert.deepEqual(f.calls[0].payload, { accountId: "a", threadId: "thread", emailId: "source", headersOnly: true });
    assert.deepEqual(f.calls.filter(row => row.channel === "mail:readCachedBody").map(row => row.payload.emailId), ["second", "first"]);
  }
});

test("History reads retain the captured source, exclude drafts/foreign rows and deduplicate row copies", async t => {
  const f = fixture(t, [first, first, message("draft", "Unsent draft", { isDraft: true }),
    message("foreign", "Wrong mailbox", { accountId: "b" }), message("other", "Wrong thread", { threadId: "other" }), source, later]);
  let resolve;
  f.replies.list = () => new Promise(done => { resolve = done; });
  const pending = f.open();
  assert.equal(f.get("compose-send").disabled, true);
  assert.equal(f.run("openComposePreview(null)"), false);
  assert.equal(await f.run("saveDraft()"), false);
  f.run(`state.email = {id:'later',accountId:'b'}; state.accountId = 'b'; state.composeInputVersions.body++`);
  f.get("compose-editor").innerHTML = "Typed while loading";
  f.get("compose-body").value = "Typed while loading";
  resolve([first, first, message("draft", "Unsent draft", { isDraft: true }),
    message("foreign", "Wrong mailbox", { accountId: "b" }), message("other", "Wrong thread", { threadId: "other" }), source, later].map(header));
  await pending;
  const body = f.payload().body;
  assert.match(body, /Typed while loading/);
  assert.match(body, /Earlier proposal/);
  assert.doesNotMatch(body, /Unsent draft|Wrong mailbox|Wrong thread|Later private/);
  assert.equal(f.payload().accountId, "a");
  assert.equal(f.calls.filter(row => row.channel === "mail:readCachedBody").length, 1);
});

test("Already attributed quoted history is not appended again; identical unquoted deliveries stay distinct", async t => {
  const attributed = `${first.from} wrote:\n> ${first.textBody}`;
  const f = fixture(t, [first, { ...source, textBody: "New answer.\n\n" + attributed }]);
  await f.open();
  assert.equal(f.payload().body.match(/Earlier proposal/g).length, 1);
  assert.equal(f.get("compose-quote-body").querySelectorAll(".compose-quote-message").length, 1);
  const equal = fixture(t, [first, { ...source, textBody: first.textBody }]);
  await equal.open();
  assert.equal(equal.payload().body.match(/Earlier proposal/g).length, 2);
  const sameSender = fixture(t, [first, { ...first, id: "same-sender-second" }, source]);
  await sameSender.open();
  assert.equal(sameSender.payload().body.match(/Earlier proposal/g).length, 2);
  assert.equal(sameSender.get("compose-quote-body").querySelectorAll(".compose-quote-message").length, 3);
});

test("Production sender defaults preserve To/Cc/Bcc edits made while history is loading", async t => {
  const f = fixture(t, [first, source]);
  let resolveHistory, resolveIdentity;
  f.replies.list = () => new Promise(done => { resolveHistory = done; });
  f.context.identity = () => new Promise(done => { resolveIdentity = done; });
  f.run(`
    initializeComposeIdentity = productionInitializeComposeIdentity;
    call = (channel,payload) => channel === 'mail:getComposeContext' ? identity() : invoke(channel,payload);
  `);
  const pending = f.open();
  assert.ok(resolveIdentity, "identity edit-version snapshot begins before waiting for history");
  for (const name of ["to", "cc", "bcc"]) {
    f.get("compose-" + name).value = name + "-edited@fixture.invalid";
    f.run(`state.composeInputVersions.${name}++`);
  }
  resolveHistory([first, source].map(header));
  resolveIdentity({ fromAddress: "me@fixture.invalid", selfAddresses: ["me@fixture.invalid"],
    sendAs: [{ email: "me@fixture.invalid" }], defaultCc: ["default@fixture.invalid"],
    defaultBcc: ["default-bcc@fixture.invalid"], settings: { accounts: {}, ccByDomain: {}, bccByDomain: {} } });
  await pending;
  for (const name of ["to", "cc", "bcc"]) assert.equal(f.get("compose-" + name).value, name + "-edited@fixture.invalid");
  assert.match(f.payload().body, /Earlier proposal/);
});

test("Undownloaded/incomplete history is disclosed and snippets are never substituted for missing bodies", async t => {
  const missing = message("missing", "", { hasBody: false, bodyComplete: false, snippet: "Not a full message" });
  const partial = message("partial", "Available partial text", { bodyComplete: false, bodyWarning: "Limited" });
  const f = fixture(t, [missing, partial, source]);
  await f.open();
  const text = f.get("compose-quote-body").textContent;
  assert.match(text, /no downloaded body/);
  assert.match(text, /incomplete or uncertain/);
  assert.match(text, /Body not downloaded/);
  assert.match(f.payload().body, /Available partial text/);
  assert.doesNotMatch(f.payload().body, /Not a full message|Body not downloaded/);
});

test("Read failures/connection races keep original quote, disclose failure and cannot inject another mailbox", async t => {
  for (const mode of ["failure", "epoch", "identity"]) {
    const f = fixture(t, [first, source]);
    f.replies.body = async () => {
      if (mode === "failure") throw new Error("Synthetic read failure");
      return { email: { ...first, ...(mode === "epoch" ? { bodyEpoch: 4 } : { accountId: "b" }) } };
    };
    await f.open();
    assert.match(f.get("compose-quote-body").textContent, /could not be loaded/);
    assert.match(f.payload().body, /Please confirm/);
    assert.doesNotMatch(f.payload().body, /Earlier proposal/);
  }
});

test("Closing/replacing compose during a cached read ignores the late response", async t => {
  const f = fixture(t, [first, source]);
  let resolve;
  f.replies.body = () => new Promise(done => { resolve = done; });
  const pending = f.open();
  while (!resolve) await new Promise(done => setImmediate(done));
  f.run(`state.composeSession++; state.composeQuote = {text:'Replacement',email:{from:'new',textBody:'New compose'}}; paintQuoteBody()`);
  resolve({ email: first });
  await pending;
  assert.equal(f.run("state.composeQuote.text"), "Replacement");
  assert.doesNotMatch(f.get("compose-quote-body").textContent, /Earlier proposal/);
});

test("Long histories stay bounded and disclose omitted earlier messages", async t => {
  const rows = Array.from({ length: 102 }, (_, i) => message("old" + i, "Message " + i));
  const f = fixture(t, [...rows, source]);
  await f.open();
  assert.equal(f.calls.filter(row => row.channel === "mail:readCachedBody").length, 100);
  assert.match(f.get("compose-quote-body").textContent, /2 earlier message\(s\) are not included/);
  const huge = fixture(t, [message("huge", "x".repeat(1100000)), source]);
  await huge.open();
  assert.match(huge.get("compose-quote-body").textContent, /1 earlier message\(s\) are not included/);
  assert.ok(huge.payload().body.length < 1000);
});

test("Earlier rich content is inert; remote images obey the existing image gate and outgoing text is escaped", async t => {
  const rich = message("rich", "", { hasBody: true,
    htmlBody: '<p>Safe &lt;literal&gt; history</p><script>evil()</script><img src="https://tracker.fixture.invalid/pixel"><a href="javascript:evil()">bad</a>' });
  const f = fixture(t, [rich, source]);
  await f.open();
  const pane = f.get("compose-quote-body");
  assert.equal(pane.querySelector("script"), null);
  assert.equal(pane.querySelector('a[href^="javascript:"]'), null);
  assert.equal(pane.querySelector('img[src^="https:"]'), null);
  assert.match(pane.textContent, /remote image is blocked/);
  const body = f.payload().body;
  assert.match(body, /Safe &lt;literal&gt; history/);
  assert.doesNotMatch(body, /evil\(\)|tracker\.fixture/);
  f.run("toggleComposeQuote(); toggleComposeQuote()");
  assert.equal(f.payload().body, body, "hide/show never removes or duplicates outgoing history");
});

test("Resumed/recovered drafts and forwards do not rebuild saved reply history", async t => {
  for (const extra of [{ draftId: "saved" }, { recoveredSnapshot: true }]) {
    const f = fixture(t);
    await f.open("reply", extra);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(f.payload().body, /Earlier proposal/);
  }
  const f = fixture(t);
  await f.open("forward");
  assert.equal(f.calls.length, 0);
});

test("Rendered Features catalog describes reply history, output, limits and privacy boundaries", t => {
  const f = fixture(t);
  f.run("paintFeatureCatalog(); showFeaturesTab('catalog')");
  const card = [...f.get("features-catalog").querySelectorAll(".feature-card")]
    .find(node => node.querySelector("h4").textContent === "Reply conversation history");
  assert.ok(card);
  assert.match(card.textContent, /Save draft, Preview Send, Send and Schedule/);
  assert.match(card.textContent, /do not download bodies, mark messages read or send history to AI/);
  assert.match(card.textContent, /100 earlier messages/);
  assert.match(card.textContent, /Missing bodies are labelled/);
});
