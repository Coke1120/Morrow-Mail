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
const raster = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lvkAAAAASUVORK5CYII=";
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
    assert.match(f.get("compose-editor").textContent, /Please confirm.*appendix.*delivery on Friday/s);
    f.get("compose-editor").firstElementChild.textContent = "Confirmed.";
    f.run("syncComposePlainFromEditor()");
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
  f.get("compose-editor").firstElementChild.textContent = "Typed while loading";
  f.run("syncComposePlainFromEditor()");
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
  const f = fixture(t, [{ ...source, htmlBody: '<p><strong>Rich forwarding stays outside this change</strong></p>' }]);
  await f.open("forward");
  assert.equal(f.calls.length, 0);
  assert.equal(f.get("compose-editor").querySelector("[data-compose-reply-quote]"), null);
  assert.match(f.payload().body, /Please confirm the plan/);
  assert.doesNotMatch(f.payload().body, /Rich forwarding stays outside this change|<strong>/);
});

test("Edited/deleted reply quotes are the sole saved and reviewed output, with no hidden original appended", async t => {
  for (const kind of ["reply", "all"]) for (const edit of ["excerpt", "remove", "replace-all"]) {
    const f = fixture(t);
    await f.open(kind);
    const node = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
    assert.ok(node && !node.hasAttribute("contenteditable"), "quote inherits the editable message field");
    if (edit === "excerpt") node.textContent = "Edited excerpt <literal> & Unicode 中文";
    else if (edit === "remove") node.remove();
    else f.get("compose-editor").innerHTML = "<p>Only my answer.</p>";
    if (edit !== "replace-all") f.get("compose-editor").firstElementChild.textContent = "Only my answer.";
    f.run("syncComposePlainFromEditor(); state.composeInputVersions.body++");
    const body = f.payload().body;
    assert.match(body, /Only my answer/);
    assert.doesNotMatch(body, /Please confirm|Earlier proposal|Earlier answer/);
    if (edit === "excerpt") assert.match(body, /Edited excerpt &lt;literal&gt; &amp; Unicode 中文/);
    assert.match(f.get("compose-quote-body").textContent, /Please confirm/, "unchanged original preview is reference only");
    assert.match(f.get("compose-quote-note").textContent, /Edit or remove quoted text in Message/);
    assert.equal(await f.run("saveDraft()"), true);
    assert.equal(f.calls.find(row => row.channel === "mail:upsertDraft").payload.body, body);
    f.run(`globalThis.confirmed = [];
      sendMail = async payload => { confirmed.push(payload); };
      scheduleMail = async (_when, payload) => { confirmed.push(payload); return true; };`);
    for (const when of ["null", "new Date('2099-01-01T09:00:00Z')"]) {
      assert.equal(f.run(`openComposePreview(${when})`), true);
      assert.equal(f.run("previewDraftState.payload.body"), body);
      assert.doesNotMatch(f.get("compose-preview-body").textContent, /Please confirm|Earlier proposal/);
      assert.equal(await f.run("confirmComposePreview()"), true);
      assert.equal(f.run("confirmed.at(-1).body"), body);
    }
  }
});

test("History loading never restores an edited, deleted, or replaced quote", async t => {
  for (const edit of ["excerpt", "remove", "clear-all"]) {
    const f = fixture(t, [first, source]);
    let resolve;
    f.replies.body = () => new Promise(done => { resolve = done; });
    const pending = f.open();
    while (!resolve) await new Promise(done => setImmediate(done));
    const node = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
    if (edit === "excerpt") node.textContent = "My edited quote";
    else if (edit === "remove") node.remove();
    else f.get("compose-editor").replaceChildren();
    f.run("syncComposePlainFromEditor(); state.composeInputVersions.body++");
    const edited = f.get("compose-editor").innerHTML;
    resolve({ email: first });
    await pending;
    assert.equal(f.get("compose-editor").innerHTML, edited);
    assert.doesNotMatch(f.payload().body, /Please confirm|Earlier proposal/);
    assert.match(f.get("compose-quote-body").textContent, /not added to Message.*quoted text changed/s);
    if (edit === "clear-all") assert.equal(f.payload().body, "");
  }
});

test("Signatures and AI writing preserve edited quotes without treating cached history as authored AI input", async t => {
  const f = fixture(t);
  f.run(`fillSignatures = async () => commitComposeSignature('', 'Fixture signature', '<b>Fixture signature</b>')`);
  await f.open();
  assert.equal(f.run("composeSnapshot() === state.composeBaseline"), true, "untouched seeded reply stays clean");
  const quote = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
  const signature = f.get("compose-editor").querySelector("[data-compose-signature]");
  assert.ok(signature.compareDocumentPosition(quote) & f.document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
  quote.innerHTML = "<b>Edited quoted text</b>";
  f.get("compose-editor").firstElementChild.textContent = "Authored answer";
  f.run("syncComposePlainFromEditor(); state.composeInputVersions.body++");
  assert.equal(f.get("compose-body").value, "Authored answer\n\nFixture signature");
  f.run("commitComposeSignature('Fixture signature', 'New signature', '<i>New signature</i>')");
  assert.equal(quote.innerHTML, "<b>Edited quoted text</b>");
  f.run(`globalThis.aiRequests = []; const originalCall = call;
    call = async (channel, payload) => {
      if (channel === 'aiDraftWrite:start' || channel === 'aiDraftWrite:cancel') { aiRequests.push({channel,payload}); return {}; }
      return originalCall(channel,payload);
    };`);
  f.get("ai-mode").value = "reply";
  await f.run("startDraftWrite()");
  const request = f.run("JSON.stringify(aiRequests[0])");
  assert.match(request, /Authored answer/);
  assert.doesNotMatch(request, /Earlier proposal|Earlier answer|Edited quoted text/);
  f.run(`onDraftEvent({reqId:state.draftWrite.reqId,type:'chunk',data:'Generated answer'});
    onDraftEvent({reqId:state.draftWrite.reqId,type:'done'});`);
  assert.equal(f.get("compose-editor").querySelector("[data-compose-reply-quote]"), quote);
  assert.equal(quote.innerHTML, "<b>Edited quoted text</b>");
  assert.match(f.payload().body, /Generated answer/);
  assert.match(f.payload().body, /<b>Edited quoted text<\/b>/);
  assert.doesNotMatch(f.payload().body, /Please confirm|Earlier proposal/);
  quote.remove();
  f.run("syncComposePlainFromEditor(); writeComposeBody('Another answer')");
  assert.doesNotMatch(f.payload().body, /Edited quoted text|Please confirm|Earlier proposal/);
});

test("Saved and scheduled recovery keeps the exact edited quote without reconstructing source history", async t => {
  const original = fixture(t);
  await original.open();
  original.get("compose-editor").querySelector("[data-compose-reply-quote]").textContent = "Saved edited quote";
  const payload = original.payload();
  for (const saved of [true, false]) {
    const f = fixture(t);
    f.context.payload = payload;
    f.run(`globalThis.savedSeed = outboxComposeSeed({}, payload)`);
    if (saved) f.run(`savedSeed.draftId = 'saved-draft'; delete savedSeed.recoveredSnapshot`);
    await f.run("openCompose(savedSeed)");
    assert.equal(f.payload().body, payload.body);
    assert.match(f.get("compose-editor").textContent, /Saved edited quote/);
    assert.doesNotMatch(f.payload().body, /Please confirm|Earlier proposal/);
    assert.equal(f.calls.length, 0, "saved content never triggers history reads");
  }
});

test("Formatting around the editable quote does not break later signature insertion", async t => {
  const f = fixture(t);
  await f.open();
  const quote = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
  const wrapper = f.document.createElement("span");
  quote.replaceWith(wrapper);
  wrapper.appendChild(quote);
  f.run("commitComposeSignature('', 'Signature above the quote', '')");
  const signature = f.get("compose-editor").querySelector("[data-compose-signature]");
  assert.equal(signature.parentNode, f.get("compose-editor"));
  assert.ok(signature.compareDocumentPosition(wrapper) & f.document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(f.payload().body, /Signature above the quote/);
  assert.equal(f.payload().body.match(/Please confirm the plan/g).length, 1);
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
  assert.match(card.textContent, /edit or remove/);
  assert.match(card.textContent, /only the edited Message/);
  assert.match(card.textContent, /safe HTML formatting/);
  assert.match(card.textContent, /Remote images and CSS resources stay blocked/);
  assert.match(card.textContent, /plain-text fallback/);
});

test("Reply and Reply All retain safe original/earlier HTML through edit, save, preview, confirmation and recovery", async t => {
  const richSource = { ...source, textBody: "Alternate plain part is not the displayed HTML.",
    htmlBody: '<h2>HTML plan</h2><p><strong>Confirm the plan</strong> with <em>emphasis</em> and <u>underline</u>.</p><p style="color:#193c34;background-color:#f0f5ef">Styled original</p><ul><li>First item</li><li>Second item</li></ul><table border="1"><tr><th>Item</th><th>Amount</th></tr><tr><td>Delivery</td><td>42</td></tr></table><a href="https://docs.fixture.invalid/plan">Plan link</a><img alt="Embedded logo" src="' + raster + '">' };
  const richEarlier = { ...first, htmlBody: '<p>Earlier <b>HTML proposal</b></p><ol><li>Earlier item</li></ol>' };
  for (const kind of ["reply", "all"]) {
    const f = fixture(t, [richEarlier, richSource]);
    await f.open(kind);
    const editor = f.get("compose-editor"), quote = editor.querySelector("[data-compose-reply-quote]");
    assert.ok(quote.querySelector("h2"));
    assert.equal(quote.querySelectorAll("li").length, 3);
    assert.equal(quote.querySelectorAll("td").length, 2);
    assert.equal(quote.querySelector("img").src, raster);
    assert.equal(quote.querySelector("p[style]").style.color, "rgb(25, 60, 52)");
    assert.doesNotMatch(editor.textContent, /Alternate plain part|Earlier proposal: delivery/);
    quote.querySelector("strong").textContent = "Edited HTML answer";
    editor.firstElementChild.textContent = "My reply.";
    f.run("syncComposePlainFromEditor(); state.composeInputVersions.body++");
    assert.equal(f.get("compose-body").value, "My reply.");
    const body = f.payload().body;
    assert.match(body, /<strong>Edited HTML answer<\/strong>/);
    assert.match(body, /<b>HTML proposal<\/b>/);
    assert.equal(await f.run("saveDraft()"), true);
    assert.equal(f.calls.find(row => row.channel === "mail:upsertDraft").payload.body, body);
    f.run(`globalThis.confirmed = [];
      sendMail = async payload => { confirmed.push(payload); };
      scheduleMail = async (_when, payload) => { confirmed.push(payload); return true; };`);
    for (const when of ["null", "new Date('2099-01-01T09:00:00Z')"]) {
      assert.equal(f.run(`openComposePreview(${when})`), true);
      assert.equal(f.run("previewDraftState.payload.body"), body);
      assert.equal(f.get("compose-preview-body").querySelector("strong").textContent, "Edited HTML answer");
      assert.equal(f.get("compose-preview-body").querySelectorAll("td").length, 2);
      assert.equal(await f.run("confirmComposePreview()"), true);
      assert.equal(f.run("confirmed.at(-1).body"), body);
    }
    const payload = f.payload();
    for (const saved of [true, false]) {
      const recovered = fixture(t);
      recovered.context.payload = payload;
      recovered.run("globalThis.savedSeed = outboxComposeSeed({}, payload)");
      if (saved) recovered.run("savedSeed.draftId = 'saved'; delete savedSeed.recoveredSnapshot");
      await recovered.run("openCompose(savedSeed)");
      assert.equal(recovered.payload().body, body);
      assert.equal(recovered.get("compose-editor").querySelector("strong").textContent, "Edited HTML answer");
      assert.equal(recovered.calls.length, 0);
    }
  }
});

test("Sender HTML is inert in editable quotes and outgoing HTML, independent of reader remote permission", async t => {
  const html = '<style>@import "https://tracker.fixture.invalid/import"; p { background-image:url(https://tracker.fixture.invalid/css); color:#193c34 } </style>'
    + '<p onclick="evil()" data-compose-signature="1" data-compose-reply-quote="1" contenteditable="false">Safe original</p>'
    + '<script>evil()</script><iframe src="https://tracker.fixture.invalid/frame"></iframe><form action="https://tracker.fixture.invalid/form"><input name="leak"></form>'
    + '<object data="https://tracker.fixture.invalid/object"></object><svg onload="evil()"><image href="https://tracker.fixture.invalid/svg"></image></svg>'
    + '<link rel="stylesheet" href="https://tracker.fixture.invalid/style"><meta http-equiv="refresh" content="0;url=https://tracker.fixture.invalid/refresh">'
    + '<img src="https://tracker.fixture.invalid/pixel" srcset="https://tracker.fixture.invalid/srcset 2x" onerror="evil()" width="20" height="20">'
    + '<table background="https://tracker.fixture.invalid/table"><tr><td style="background:image-set(\'https://tracker.fixture.invalid/other\' 1x)">Cell</td></tr></table>'
    + '<a href="javascript:evil()">Unsafe link</a><a href="https://docs.fixture.invalid/safe" ping="https://tracker.fixture.invalid/ping">Safe link</a>'
    + '<img src="file:///private/source"><img src="cid:unresolved"><img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="' + raster + '">';
  const f = fixture(t, [{ ...first, htmlBody: html }, { ...source, htmlBody: html }]);
  f.run("state.prefs.images = true; state.remoteAllowed = {source:true,first:true}");
  await f.open();
  const quote = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
  assert.equal(quote.querySelectorAll("[data-compose-reply-quote], [data-compose-signature], [contenteditable]").length, 0);
  const serialized = JSDOM.fragment(f.payload().body);
  for (const root of [quote, serialized]) {
    assert.equal(root.querySelector("script,style,iframe,object,embed,svg,math,link,meta,base,form,input,textarea,select"), null);
    for (const el of root.querySelectorAll("*")) {
      assert.equal(el.getAttributeNames().some(name => /^on|^srcset$|^ping$|^contenteditable$/i.test(name)), false);
      assert.doesNotMatch(el.getAttribute("src") || "", /^(https?:|file:|cid:|blob:|data:image\/svg)/i);
      assert.doesNotMatch(el.getAttribute("style") || "", /tracker\.fixture|url\(|image-set\(/i);
      assert.equal(el.getAttribute("background"), null);
    }
    assert.equal(root.querySelector('a[href^="javascript:"]'), null);
    assert.equal(root.querySelector("a").rel, "noopener noreferrer");
    assert.equal(root.querySelector("img").src, raster);
  }
  assert.doesNotMatch(f.payload().body, /evil\(\)|tracker\.fixture|private\/source|unresolved/);
  assert.ok(f.calls.every(row => ["mail:listThreadMessages", "mail:readCachedBody"].includes(row.channel)));
});

test("Quote styles remain isolated per message and survive payload and draft rehydration", async t => {
  const f = fixture(t, [{ ...first, htmlBody: '<style>* {color:#aa1100;font-weight:bold}</style><p>Styled earlier</p>' },
    { ...source, htmlBody: '<p style="color:#1122aa">Styled source</p>' }]);
  await f.open();
  f.get("compose-editor").firstElementChild.textContent = "Authored paragraph";
  const blocks = f.get("compose-editor").querySelectorAll("[data-compose-reply-quote] > div");
  assert.equal(blocks[0].querySelector("blockquote p").style.color, "rgb(17, 34, 170)");
  assert.equal(blocks[1].querySelector("blockquote p").style.color, "rgb(170, 17, 0)");
  assert.equal(blocks[0].firstElementChild.style.color, "");
  assert.equal(blocks[1].firstElementChild.style.color, "");
  assert.equal(f.get("compose-editor").firstElementChild.style.color, "");
  const payload = f.payload();
  const recovered = fixture(t);
  recovered.context.payload = payload;
  await recovered.run("openCompose(outboxComposeSeed({}, payload))");
  const paragraphs = [...recovered.get("compose-editor").querySelectorAll("p")];
  assert.equal(paragraphs.find(node => node.textContent === "Styled source").style.color, "rgb(17, 34, 170)");
  assert.equal(paragraphs.find(node => node.textContent === "Styled earlier").style.color, "rgb(170, 17, 0)");
});

test("Plain/empty/unsupported HTML uses safe body text fallback without promoting earlier snippets", async t => {
  for (const htmlBody of ["", "   ", '<style>p{color:red}</style><script>evil()</script>', '<p><br></p>']) {
    const f = fixture(t, [{ ...first, htmlBody }, { ...source, htmlBody }]);
    await f.open();
    assert.match(f.payload().body, /Earlier proposal: delivery on Friday/);
    assert.match(f.payload().body, /Please confirm the plan/);
    assert.doesNotMatch(f.payload().body, /evil|color:red/);
  }
  const f = fixture(t, [message("unsupported", "", { hasBody:true, htmlBody:'<script>evil()</script>', snippet:'Never a full earlier body' }),
    message("svg", "", { hasBody:true, htmlBody:'<svg><text>Safe escaped fallback &lt;literal&gt;</text></svg>' }), source]);
  await f.open();
  assert.match(f.payload().body, /Safe escaped fallback &lt;literal&gt;/);
  assert.doesNotMatch(f.payload().body, /Never a full earlier body|evil/);
  assert.match(f.get("compose-quote-body").textContent, /1 earlier message\(s\) have no supported body content/);
});

test("HTML history deduplication uses the included body, not an alternate MIME text part", async t => {
  const earlier = { ...first, htmlBody: '<p>Earlier HTML detail</p>', textBody: 'Earlier HTML detail' };
  const attributed = first.from + " wrote:\n> Earlier HTML detail";
  const f = fixture(t, [earlier, { ...source, textBody: "Answer\n" + attributed, htmlBody:'<p>HTML answer without earlier detail</p>' }]);
  await f.open();
  assert.match(f.payload().body, /Earlier HTML detail/);
  assert.equal(f.get("compose-quote-body").querySelectorAll(".compose-quote-message").length, 2);
  const already = fixture(t, [earlier, { ...source, textBody: 'Alternate unquoted plain part',
    htmlBody:'<p>HTML answer</p><div><p>' + first.from.replace(/</g, '&lt;').replace(/>/g, '&gt;') + ' wrote:</p><blockquote><p>Earlier HTML detail</p></blockquote></div>' }]);
  await already.open();
  assert.equal(already.payload().body.match(/Earlier HTML detail/g).length, 1);
});

test("HTML history waits preserve authored typing and never restore edited/deleted rich quotes", async t => {
  for (const edit of ["authored", "quote", "delete", "clear"]) {
    const f = fixture(t, [{ ...first, htmlBody:'<p>Earlier <b>HTML proposal</b></p>' },
      { ...source, htmlBody:'<p>Source <strong>HTML question</strong></p>' }]);
    let resolve;
    f.replies.body = () => new Promise(done => { resolve = done; });
    const pending = f.open();
    while (!resolve) await new Promise(done => setImmediate(done));
    const editor = f.get("compose-editor"), quote = editor.querySelector("[data-compose-reply-quote]");
    if (edit === "authored") editor.firstElementChild.textContent = "Typed answer";
    if (edit === "quote") quote.querySelector("strong").textContent = "Edited HTML question";
    if (edit === "delete") quote.remove();
    if (edit === "clear") editor.replaceChildren();
    f.run("syncComposePlainFromEditor(); state.composeInputVersions.body++");
    const before = editor.innerHTML;
    resolve({ email:{ ...first, htmlBody:'<p>Earlier <b>HTML proposal</b></p>' } });
    await pending;
    if (edit === "authored") {
      assert.match(f.payload().body, /Typed answer/);
      assert.match(f.payload().body, /<b>HTML proposal<\/b>/);
    } else {
      assert.equal(editor.innerHTML, before);
      assert.doesNotMatch(f.payload().body, /HTML proposal/);
    }
  }
});

test("Stylesheet expansion is bounded before allocation and falls back to available body text", async t => {
  const htmlBody = '<style>span{font-family:"' + "x".repeat(3000) + '"}</style>' + '<span>Detail</span>'.repeat(700);
  const f = fixture(t, [{ ...first, htmlBody, textBody:"Earlier detail" }, source]);
  await f.open();
  assert.match(f.get("compose-quote-body").textContent, /HTML formatting was simplified/);
  assert.doesNotMatch(f.payload().body, /font-family/);
  assert.match(f.payload().body, /Earlier detail/);
  assert.match(f.payload().body, /Please confirm the plan/);
  const original = fixture(t, [{ ...source, htmlBody, textBody:"Full original text is retained" }]);
  await original.open();
  assert.match(original.payload().body, /Full original text is retained/);
  assert.match(original.get("compose-quote-body").textContent, /HTML formatting was simplified/);
});

test("Serialized sanitized HTML counts against the earlier-history budget", async t => {
  const htmlBody = ('<a href="https://docs.fixture.invalid/' + "p".repeat(160) + '">x</a>').repeat(5000);
  const f = fixture(t, [{ ...first, htmlBody, textBody:"Earlier detail" }, source]);
  await f.open();
  assert.match(f.get("compose-quote-body").textContent, /1 earlier message\(s\) are not included/);
  assert.doesNotMatch(f.payload().body, /docs\.fixture\.invalid|Earlier detail/);
  assert.match(f.payload().body, /Please confirm the plan/);
});

test("Text matching alone cannot discard distinct images, link targets or tables in older HTML", async t => {
  for (const htmlBody of ['<img alt="Earlier image" src="' + raster + '">',
    '<p>Read <a href="https://docs.fixture.invalid/earlier">this link</a></p>',
    '<table><tr><td>Unique table</td></tr></table>']) {
    const earlier = { ...first, textBody:"", htmlBody };
    const quotedText = htmlBody.includes("<a") ? "Read this link" : htmlBody.includes("<table") ? "Unique table" : "Different old text";
    const f = fixture(t, [earlier, { ...source, htmlBody:'<div><p>' + first.from.replace(/</g,'&lt;').replace(/>/g,'&gt;') + ' wrote:</p><blockquote>' + quotedText + '</blockquote></div>' }]);
    await f.open();
    const quote = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
    assert.equal(f.get("compose-quote-body").querySelectorAll(".compose-quote-message").length, 2);
    assert.ok(quote.querySelector(htmlBody.includes("<img") ? "img" : htmlBody.includes("<a") ? "a" : "table"));
  }
});

test("AI and signature updates retain HTML quote edits without adding cached HTML history to authored input", async t => {
  const f = fixture(t, [{ ...first, htmlBody:'<table><tr><td>Private earlier HTML history</td></tr></table>' },
    { ...source, htmlBody:'<p><b>HTML question</b></p>' }]);
  await f.open();
  const quote = f.get("compose-editor").querySelector("[data-compose-reply-quote]");
  quote.querySelector("b").textContent = "Edited HTML question";
  f.get("compose-editor").firstElementChild.textContent = "Authored reply";
  f.run("syncComposePlainFromEditor(); state.composeInputVersions.body++");
  f.run("commitComposeSignature('', 'Fixture signature', '<i>Fixture signature</i>')");
  const kept = quote.innerHTML;
  assert.equal(f.get("compose-body").value, "Authored reply\n\nFixture signature");
  f.run(`globalThis.aiRequests = []; const originalCall = call;
    call = async (channel, payload) => {
      if (channel === 'aiDraftWrite:start' || channel === 'aiDraftWrite:cancel') { aiRequests.push({channel,payload}); return {}; }
      return originalCall(channel,payload);
    };`);
  f.get("ai-mode").value = "reply";
  await f.run("startDraftWrite()");
  assert.doesNotMatch(f.run("JSON.stringify(aiRequests)"), /Private earlier HTML history|Edited HTML question/);
  f.run(`onDraftEvent({reqId:state.draftWrite.reqId,type:'chunk',data:'Generated reply'});
    onDraftEvent({reqId:state.draftWrite.reqId,type:'done'});`);
  assert.equal(f.get("compose-editor").querySelector("[data-compose-reply-quote]"), quote);
  assert.equal(quote.innerHTML, kept);
  assert.match(f.payload().body, /<b>Edited HTML question<\/b>/);
  assert.match(f.payload().body, /<td>Private earlier HTML history<\/td>/);
});
