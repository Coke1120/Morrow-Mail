// Actual renderer and HTML parser, synthetic drafts/queue rows only. No IPC or providers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const index = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
const raster = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lvkAAAAASUVORK5CYII=";

function fixture(t) {
  const dom = new JSDOM(index);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }
  dom.window.morrow = { invoke() { throw new Error("Real IPC forbidden"); }, on() { return () => {}; } };
  dom.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  const ui = renderer({ window: dom.window, document });
  ui.run(`
    state.accounts = [{ id: 'a', platform: 'imap', email: 'sender@fixture.invalid' },
      { id: 'b', platform: 'imap', email: 'other@fixture.invalid' }];
    state.accountId = 'a'; state.composeMeta = { accountId: 'a', fromAddress: 'sender@fixture.invalid', fromDisplayName: 'Fixture Sender' };
    state.composeSession = 1; state.composeInitializing = false; state.composePending = false; state.composeQueued = false;
    state.composeIdentityError = null; state.composeFileJobs = []; state.composeAttachments = [];
    state.composeQuote = null; state.signatureText = ''; state.signatureHtml = ''; state.draftWrite = null;
    state.prefs.images = true; state.remoteAllowed = {}; state.thread = [];
    globalThis.calls = []; globalThis.confirmed = [];
    call = async (channel, payload) => { calls.push({channel, payload}); throw new Error('Unexpected IPC: ' + channel); };
    sendMail = async payload => { confirmed.push({ kind: 'send', payload }); };
    scheduleMail = async (when, payload) => { confirmed.push({ kind: 'schedule', sendAt: when.toISOString(), payload }); };
  `);
  const get = id => document.getElementById(id);
  get("compose-to").value = "recipient@fixture.invalid";
  get("compose-cc").value = "copy@fixture.invalid";
  get("compose-bcc").value = "hidden@fixture.invalid";
  get("compose-subject").value = "Reviewed message";
  return { ...ui, document, get, body: () => get("compose-preview-body"), paintOutbox(row) {
    ui.context.queueRow = row;
    ui.run("state.email = outboxEmails([queueRow])[0]; renderReader(false)");
    return get("reader");
  } };
}

function queue(body, extra = {}) {
  return { id: "queued", accountId: "a", status: "pending", outbox: true, to: "recipient@fixture.invalid",
    subject: "Queued review", fromAddress: "sender@fixture.invalid", htmlBody: body, ...extra };
}

function assertInert(body) {
  assert.equal(body.querySelectorAll("script,iframe,object,embed,svg,math,form,input,button,textarea,select,link,meta,base,style").length, 0);
  for (const element of body.querySelectorAll("*")) {
    assert.equal(element.getAttributeNames().some(name => /^on|^srcset$/i.test(name)), false);
    for (const attribute of ["src", "background"]) assert.doesNotMatch(element.getAttribute(attribute) || "", /^(?:https?:|file:|blob:|cid:)/i);
    assert.doesNotMatch(element.getAttribute("style") || "", /https?:|expression|position:\s*fixed/i);
  }
  assert.equal(body.querySelectorAll('a[href^="javascript:"]').length, 0);
}

test("Preview Send paints frozen rich HTML and attachment metadata instead of the plaintext cache", async t => {
  const f = fixture(t);
  f.get("compose-editor").innerHTML = '<h2>Heading</h2><p>Hello <b>Ada</b>, <a href="https://docs.fixture.invalid/plan">review</a>.</p><ul><li>First</li><li>Second</li></ul><table><tr><td>Item</td><td>Cost</td></tr></table><p style="color:#193c34">Signature</p>';
  f.get("compose-body").value = "Stale plaintext cache";
  f.run(`state.composeAttachments = [{ id: 'file', storageUrl: 'local:file', filename: '<script>file</script>.pdf', size: 12 }];
    state.composeQuote = { text: 'Ada wrote:\\n> Previous <literal> & symbols', email: { htmlBody: '<b>Unsent rich original</b>' } }`);
  assert.equal(f.run("openComposePreview(null)"), true);
  const frozen = f.run("JSON.stringify(previewDraftState.payload)");
  assert.equal(f.body().querySelector("b").textContent, "Ada");
  assert.equal(f.body().querySelectorAll("li").length, 2);
  assert.equal(f.body().querySelectorAll("td").length, 2);
  assert.match(f.body().textContent, /Previous <literal> & symbols/);
  assert.doesNotMatch(f.body().textContent, /Stale plaintext|Unsent rich original/);
  const link = f.body().querySelector("a");
  assert.equal(link.href, "https://docs.fixture.invalid/plan");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(f.get("compose-preview-files").textContent, "<script>file</script>.pdf (12 B)");
  assert.equal(f.get("compose-preview-files").querySelector("script"), null);
  assert.equal(f.get("compose-preview-from").textContent, "Fixture Sender <sender@fixture.invalid>");
  f.get("compose-editor").innerHTML = "Changed while reviewing";
  f.run("paintPreview(previewDraftState)");
  assert.equal(f.body().querySelector("b").textContent, "Ada", "repaint keeps the captured HTML");
  assert.equal(f.run("JSON.stringify(previewDraftState.payload)"), frozen);
  assert.equal(await f.run("confirmComposePreview()"), false);
  assert.equal(f.run("confirmed.length"), 0);
  assert.match(f.get("compose-status").textContent, /Review a new preview/);
  assert.equal(f.run("calls.length"), 0);
});

test("Cancel is inert and send/schedule confirmation retains the captured HTML", async t => {
  const f = fixture(t);
  f.get("compose-editor").innerHTML = "<p><strong>Reviewed</strong></p>";
  f.run("openComposePreview(null); cancelComposePreview()");
  assert.equal(f.get("compose-preview").open, false);
  assert.equal(f.run("previewDraftState"), null);
  assert.equal(f.run("confirmed.length"), 0);
  f.run("openComposePreview(null)");
  const send = f.run("JSON.stringify(previewDraftState.payload)");
  await f.run("confirmComposePreview()");
  assert.equal(f.run("JSON.stringify(confirmed[0].payload)"), send);
  f.run("openComposePreview(new Date('2099-01-01T09:00:00Z'))");
  assert.equal(f.get("compose-preview-title").textContent, "Preview scheduled send");
  assert.equal(f.get("compose-preview-confirm").textContent, "Confirm schedule");
  assert.equal(f.body().querySelector("strong").textContent, "Reviewed");
  const scheduled = f.run("JSON.stringify(previewDraftState.payload)");
  await f.run("confirmComposePreview()");
  assert.equal(f.run("JSON.stringify(confirmed[1].payload)"), scheduled);
  assert.equal(f.run("confirmed[1].sendAt"), "2099-01-01T09:00:00.000Z");
  assert.equal(f.run("calls.length"), 0);
});

test("Plain text, entities and empty captured bodies stay distinct from HTML", t => {
  const f = fixture(t);
  const literal = "Two < three & four\nLiteral <b>text</b> and &copy;";
  f.context.literal = literal;
  f.run("writeComposeBody(literal); openComposePreview(null)");
  assert.equal(f.body().textContent, literal.replace("\n", ""));
  assert.equal(f.body().querySelectorAll("br").length, 1, "HTML send payload preserves the plain-text line break");
  assert.equal(f.body().querySelector("b"), null);
  f.run("paintPreview({body: literal})");
  assert.equal(f.body().querySelector(".is-plain").textContent, literal);
  f.run("paintPreview({body: 'Stale cache', payload: {body: ''}})");
  assert.equal(f.body().textContent, "(empty message)");
  f.run("paintPreview({body: ''})");
  assert.equal(f.body().textContent, "(empty message)");
  const pane = f.paintOutbox(queue("<p>&copy; &#x1F600; &#8364; &mdash; A&amp;B &lt;b&gt;literal&lt;/b&gt;</p>"));
  assert.equal(pane.querySelector(".body").textContent, "© 😀 € — A&B <b>literal</b>");
  assert.equal(pane.querySelector(".body b"), null);
  assert.equal(f.paintOutbox(queue("")).querySelector(".body").textContent, "(empty message)");
});

test("Outbox uses its saved HTML, keeps queue controls and shows files without mailbox actions", t => {
  const f = fixture(t);
  const row = queue("<h2>Queued</h2><p><b>Reviewed</b></p><table><tr><td>A</td><td>B</td></tr></table>", {
    cc: "copy@fixture.invalid", bcc: "hidden@fixture.invalid", attachments: [{ id: "file", storageUrl: "local:file", filename: "review.pdf", size: 12 }],
  });
  const saved = JSON.stringify(row);
  let pane = f.paintOutbox(row);
  assert.equal(pane.querySelector(".body b").textContent, "Reviewed");
  assert.equal(pane.querySelectorAll(".body td").length, 2);
  assert.equal(pane.querySelector(".outbox-files").textContent, "Files: review.pdf (12 B)");
  assert.match(pane.textContent, /Cc: copy@fixture.invalid/);
  assert.match(pane.textContent, /Bcc: hidden@fixture.invalid/);
  assert.equal(pane.querySelectorAll("button").length, 1);
  assert.equal(pane.querySelector("button").textContent, "Undo send");
  assert.equal(pane.querySelector("button").disabled, false);
  assert.equal(JSON.stringify(row), saved);
  pane = f.paintOutbox(queue("<p><i>Other account</i></p>", { accountId: "b", status: "sending" }));
  assert.equal(pane.querySelector(".body i").textContent, "Other account");
  assert.equal(pane.querySelector("button").textContent, "Sending…");
  assert.equal(pane.querySelector("button").disabled, true);
  assert.doesNotMatch(pane.textContent, /review.pdf|Reviewed/);
  pane = f.paintOutbox(queue("<p>Refreshed content</p>"));
  assert.equal(pane.querySelector(".body").textContent, "Refreshed content");
  assert.equal(f.run("calls.length"), 0);
});

test("Both previews sanitize active content and block external images regardless of reader permissions", t => {
  const f = fixture(t);
  const html = '<style>@import "https://track.fixture.invalid/import.css";p{color:#193c34;background-image:url("https://track.fixture.invalid/css.png")}</style>' +
    '<script>window.attack=1</script><iframe src="https://track.fixture.invalid/frame"></iframe><object data="https://track.fixture.invalid/object"></object>' +
    '<svg onload="window.attack=2"><script>window.attack=3</script></svg><form action="https://track.fixture.invalid/form"><input value="x"><button>fake send</button></form>' +
    '<p onclick="window.attack=4" style="position:fixed">Safe text</p><a href="javascript:window.attack=5">unsafe link</a>' +
    '<img src="https://track.fixture.invalid/pixel.png" onerror="window.attack=6" srcset="https://track.fixture.invalid/another.png 2x" width="1" height="1">' +
    '<table background="https://track.fixture.invalid/table.png"><tr><td>Cell</td></tr></table>' +
    '<img src="file:///fixture/private.png"><img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="cid:unresolved" alt="cid fallback">' +
    '<img alt="Embedded raster" src="' + raster + '">';
  f.context.hostile = html;
  f.run("state.remoteAllowed.queued = true; state.prefs.images = true; paintPreview({payload:{body:hostile}})");
  for (const container of [f.body(), f.paintOutbox(queue(html))]) {
    const body = container.querySelector(".body");
    assertInert(body);
    assert.equal(body.querySelectorAll("img").length, 1);
    assert.equal(body.querySelector("img").src, raster);
    assert.match(body.textContent, /Safe text/);
    assert.match(body.textContent, /cid fallback/);
    assert.match(container.querySelector(".preview-remote-note").textContent, /Remote images are blocked/);
    assert.equal(container.querySelector('[data-action="remote"]'), null);
  }
  f.paintOutbox(queue("<p>Another item</p>", { accountId: "b" }));
  assert.equal(f.get("reader").querySelector(".preview-remote-note"), null);
  assert.equal(f.run("calls.length"), 0);
});

test("Features and preview help disclose formatting, remote blocking and attachment limits", t => {
  const f = fixture(t);
  f.run("paintFeatureCatalog(); showFeaturesTab('catalog')");
  const text = f.get("features-catalog").textContent;
  assert.match(text, /Preview Send and scheduled previews show safe HTML from the reviewed snapshot/);
  assert.match(text, /remote images remain blocked/);
  assert.match(text, /Attachment downloads are unavailable in Outbox/);
  assert.match(f.get("compose-preview").textContent, /Remote images stay blocked/);
});
