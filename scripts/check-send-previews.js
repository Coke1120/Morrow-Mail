// Actual renderer and HTML parser, synthetic drafts/queue rows only. No IPC or providers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const index = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
const bccRosterScript = fs.readFileSync(require.resolve("../renderer/compose-bcc-roster.js"), "utf8");
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

function rosterFixture(t) {
  const f = fixture(t);
  f.run(bccRosterScript);
  f.run("wire()");
  const window = f.document.defaultView;
  const panel = f.get("compose-preview-bcc-roster");
  const input = f.get("compose-preview-bcc-roster-input");
  const check = f.get("compose-preview-bcc-roster-check");
  const status = f.get("compose-preview-bcc-roster-status");
  const findings = f.get("compose-preview-bcc-roster-findings");
  const enter = (target, modifiers) => target.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true, ...modifiers,
  }));
  function type(text) {
    input.value = text;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  function compare(text) {
    panel.open = true;
    type(text);
    check.click();
  }
  function rows(title) {
    const heading = [...findings.querySelectorAll("h3")].find(node => node.textContent === title);
    return heading ? [...heading.nextElementSibling.children].map(node => node.textContent) : [];
  }
  return { ...f, window, panel, input, check, status, findings, enter, type, compare, rows };
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

test("Review links keeps repeated occurrences and selects only the matching preview anchor", t => {
  const f = fixture(t);
  const repeated = "https://docs.fixture.invalid/a?token=" + "x".repeat(180) + "&part=two#section";
  const other = "http://docs.fixture.invalid/b#details";
  const link = (href, label) => `<a href="${href.replaceAll("&", "&amp;")}">${label}</a>`;
  f.get("compose-editor").innerHTML = "<p>Faraway opening " + "filler ".repeat(60) +
    `<br><i>Alpha</i> ${link(repeated, "<b>Re</b>view")} begins here.<br>` +
    `<span>Beta</span> ${link(other, "Review")} ends here.</p><p>Gamma ${link(repeated, "Review")}.</p>`;
  const location = f.document.defaultView.location.href;
  let opens = 0;
  let submits = 0;
  f.document.defaultView.open = () => { opens++; };
  f.get("compose-preview-form").addEventListener("submit", event => { event.preventDefault(); submits++; });

  assert.equal(f.run("openComposePreview(null)"), true);
  const frozen = f.run("JSON.stringify(previewDraftState.payload)");
  const review = f.get("compose-preview-links");
  assert.equal(review.previousElementSibling, f.body());
  assert.equal(review.hidden, false);
  assert.equal(review.open, false);
  assert.equal(f.document.activeElement, f.get("compose-preview-confirm"));
  assert.equal(review.querySelector("summary").textContent.trim(), "Review links 3");
  review.open = true;
  const rows = [...review.querySelectorAll("button")];
  const anchors = [...f.body().querySelectorAll("a")];
  const rowText = field => rows.map(row => row.querySelector(".preview-link-" + field).textContent);
  assert.deepEqual(rowText("label"), ["Review", "Review", "Review"]);
  assert.deepEqual(rowText("url"), [repeated, other, repeated]);
  assert.deepEqual(rowText("context"), ["Alpha Review begins here.", "Beta Review ends here.", "Gamma Review."]);
  assert.doesNotMatch(rowText("context")[0], /Faraway opening/);
  assert.equal(review.querySelector("a"), null);
  assert.ok(rows.every(row => row.type === "button"));

  const scrolled = [];
  let anchorClicks = 0;
  for (const anchor of anchors) {
    anchor.scrollIntoView = () => scrolled.push(anchor);
    anchor.addEventListener("click", event => { event.preventDefault(); anchorClicks++; });
  }
  rows[1].focus();
  rows[1].click();
  assert.equal(f.document.activeElement, rows[1]);
  assert.equal(f.body().querySelector("[data-preview-link-target]"), anchors[1]);
  rows[2].click();
  assert.deepEqual(scrolled, [anchors[1], anchors[2]]);
  assert.deepEqual([...f.body().querySelectorAll("[data-preview-link-target]")], [anchors[2]]);
  assert.deepEqual([...review.querySelectorAll('[aria-current="true"]')], [rows[2]]);
  assert.equal(anchors[2].href, repeated);
  assert.equal(anchors[2].target, "_blank");
  assert.equal(anchors[2].rel, "noopener noreferrer");
  assert.deepEqual([opens, submits, anchorClicks, f.run("calls.length"), f.run("confirmed.length")], [0, 0, 0, 0, 0]);
  assert.equal(f.document.defaultView.location.href, location);
  assert.equal(f.run("JSON.stringify(previewDraftState.payload)"), frozen);
});

test("Review links describes image targets and lists only real web anchors in the safe body", t => {
  const f = fixture(t);
  f.context.html = '<p>Before <a href="https://docs.fixture.invalid/image"><img alt="Map &amp; routes" src="' + raster + '"></a>' +
    '<br>Directions <a href="https://docs.fixture.invalid/blocked"><img src="https://track.fixture.invalid/pixel.png" width="20" height="20"></a>' +
    ' continue.</p><a href="mailto:help@fixture.invalid">Email</a><a href="javascript:void(0)">Unsafe</a>' +
    '<a href="/relative">Relative</a><a href="#fragment">Fragment</a><a href="https://[invalid">Invalid</a>' +
    '<p>https://docs.fixture.invalid/plain</p>';
  f.run("paintPreview({payload: {body: html}})");
  const list = f.get("compose-preview-link-list");
  assert.deepEqual([...list.querySelectorAll(".preview-link-label")].map(node => node.textContent),
    ["Image link (Map & routes)", "Image link"]);
  assert.match(list.lastElementChild.querySelector(".preview-link-context").textContent, /Directions Image link continue\./);
  assert.equal(f.body().querySelector(".mail-image-hold").getAttribute("role"), "img");
  assert.equal(f.body().querySelectorAll("img").length, 1);
  assert.equal(f.body().querySelector('a[href^="mailto:"]').textContent, "Email");
  assertInert(f.body());

  f.get("compose-editor").innerHTML = '<a href="https://docs.fixture.invalid/blocked"><img width="20" alt="Map" src="https://track.fixture.invalid/map.png"></a>';
  assert.equal(f.run("openComposePreview(null)"), true);
  assert.equal(list.querySelector(".preview-link-label").textContent, "Image link",
    "a blocked image stays recognizable after both compose and preview sanitization");
  assert.equal(f.body().querySelector("img"), null);

  f.context.html = '<p>Public text</p><div style="display:none"><a href="https://docs.fixture.invalid/hidden">Hidden copy</a></div>';
  f.run("paintPreview({payload: {body: html}})");
  list.querySelector("button").click();
  const marker = f.body().querySelector(".preview-link-location");
  assert.equal(marker.nextElementSibling.style.display, "none");
  assert.equal(marker.nextElementSibling.querySelector("a").hasAttribute("data-preview-link-target"), true);
  f.run("cancelComposePreview()");
  assert.equal(f.body().querySelector(".preview-link-location"), null);
});

test("Review links resets on repaint and cancellation and reopens with the scheduled snapshot", async t => {
  const f = fixture(t);
  const editor = f.get("compose-editor");
  const review = f.get("compose-preview-links");
  const list = f.get("compose-preview-link-list");
  const select = () => { review.open = true; list.querySelector("button").click(); };
  editor.innerHTML = '<a href="https://docs.fixture.invalid/original">Original</a>';
  assert.equal(f.run("openComposePreview(null)"), true);
  select();
  const retired = list.querySelector("button");
  retired.focus();
  editor.innerHTML = '<a href="https://docs.fixture.invalid/edited?x=1#new">Edited</a>';
  f.run("paintPreview(previewDraftState)");
  assert.equal(review.open, false);
  assert.equal(f.document.activeElement, review.querySelector("summary"));
  assert.equal(list.querySelector(".preview-link-label").textContent, "Original");
  retired.click();
  assert.equal(list.querySelector("[aria-current]"), null);
  assert.equal(f.body().querySelector("[data-preview-link-target]"), null);
  select();
  f.run("cancelComposePreview()");
  assert.equal(f.get("compose-preview").open, false);
  assert.equal(review.hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(f.body().querySelector("[data-preview-link-target]"), null);
  assert.equal(f.run("confirmed.length"), 0);

  assert.equal(f.run("openComposePreview(new Date('2099-01-01T09:00:00Z'))"), true);
  assert.equal(review.open, false);
  assert.equal(list.querySelector(".preview-link-url").textContent, "https://docs.fixture.invalid/edited?x=1#new");
  const scheduled = f.run("JSON.stringify(previewDraftState.payload)");
  select();
  await f.run("confirmComposePreview()");
  assert.equal(f.run("confirmed[0].kind"), "schedule");
  assert.equal(f.run("JSON.stringify(confirmed[0].payload)"), scheduled);
  editor.textContent = "A bare URL https://docs.fixture.invalid/plain";
  assert.equal(f.run("openComposePreview(null)"), true);
  assert.equal(review.hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(f.run("calls.length"), 0);
});

test("Bcc roster distinguishes missing, extra and exposed addresses using every captured recipient field", t => {
  const f = rosterFixture(t);
  f.get("compose-to").value = "Organizer <organizer@fixture.invalid>, Shared <ada@fixture.invalid>";
  f.get("compose-cc").value = "ada@fixture.invalid; bo@fixture.invalid";
  f.get("compose-bcc").value = "Shared <ada@fixture.invalid>, Shared <extra@fixture.invalid>";
  assert.equal(f.run("openComposePreview(null)"), true);
  f.compare("ada@fixture.invalid\nbo@fixture.invalid\nmissing@fixture.invalid");
  assert.equal(f.status.textContent, "1 missing, 1 extra in Bcc, 2 exposed in To or Cc.");
  assert.deepEqual(f.rows("Missing from draft"), ["missing@fixture.invalid"]);
  assert.deepEqual(f.rows("Extra in Bcc"), ["extra@fixture.invalid"]);
  assert.deepEqual(f.rows("Exposed in To or Cc"), ["ada@fixture.invalid — To, Cc, Bcc", "bo@fixture.invalid — Cc"]);
  assert.doesNotMatch(f.findings.textContent, /organizer|Manual review/);
});

test("Bcc roster matches reordered bare addresses and understands quoted and unquoted names in the preview", t => {
  const f = rosterFixture(t);
  f.get("compose-bcc").value = '"Lo, Ada; \\"A\\"" <ada.lo+tag@FIXTURE.invalid>; <bo@fixture.invalid>, Bo Kim <bo@fixture.invalid>, ';
  assert.equal(f.run("openComposePreview(null)"), true);
  f.compare(" bo@FIXTURE.INVALID \r\n\r\n ada.lo+tag@fixture.invalid\r\nbo@fixture.invalid");
  assert.equal(f.status.textContent, "Bcc matches the roster.");
  assert.equal(f.findings.hidden, true);
  assert.equal(f.check.type, "button");

  f.type("ada.lo@fixture.invalid");
  assert.equal(f.status.textContent, "");
  assert.equal(f.findings.childElementCount, 0);
  f.check.click();
  assert.deepEqual(f.rows("Missing from draft"), ["ada.lo@fixture.invalid"]);
  assert.ok(f.rows("Extra in Bcc").includes("ada.lo+tag@fixture.invalid"));
});

test("Bcc roster requires manual review for ambiguous case, malformed inputs or oversized paste", t => {
  const f = rosterFixture(t);
  f.get("compose-cc").value = 'Broken <cc@fixture.invalid> <still@fixture.invalid>';
  f.get("compose-bcc").value = 'Ada@fixture.invalid, "Unclosed <bad@fixture.invalid>';
  assert.equal(f.run("openComposePreview(null)"), true);
  f.compare(" \r\n\n ");
  assert.equal(f.status.textContent, "");
  assert.equal(f.findings.hidden, true);
  f.compare("Email\nada@FIXTURE.invalid\na@fixture.invalid\tb@fixture.invalid\na@fixture.invalid,b@fixture.invalid");
  assert.match(f.status.textContent, /^Manual review needed/);
  assert.deepEqual(f.rows("Manual review"), [
    "Roster row 1 needs one bare email address.", "Roster row 3 needs one bare email address.",
    "Roster row 4 needs one bare email address.", "Cc recipient 1 could not be read.",
    "Bcc recipient 2 could not be read.", "Local-part case differs: ada@fixture.invalid / Ada@fixture.invalid.",
  ]);
  assert.deepEqual(f.rows("Missing from draft"), []);
  assert.deepEqual(f.rows("Extra in Bcc"), []);
  f.compare("x".repeat(64_001));
  assert.match(f.status.textContent, /Manual review.*exceeds 64,000/);
  assert.equal(f.input.value.length, 64_001);
  assert.equal(f.findings.hidden, true);
});

test("Bcc roster follows preview lifetime and leaves send and schedule confirmation on the captured payload", async t => {
  const f = rosterFixture(t);
  const dialog = f.get("compose-preview");
  const confirm = f.get("compose-preview-confirm");
  const open = when => {
    assert.equal(f.run(`openComposePreview(${when})`), true);
    assert.equal(f.document.activeElement, confirm);
    assert.equal(confirm.disabled, false);
  };
  const empty = () => {
    assert.equal(f.panel.open, false);
    assert.equal(f.input.value, "");
    assert.equal(f.status.textContent, "");
    assert.equal(f.findings.childElementCount, 0);
  };
  const compare = () => f.compare("hidden@fixture.invalid");
  const close = () => dialog.dispatchEvent(new f.window.Event("close"));
  const settled = () => new Promise(resolve => setImmediate(resolve));

  open("null");
  compare();
  const frozen = f.run("JSON.stringify(previewDraftState.payload)");
  f.get("compose-bcc").value = "changed@fixture.invalid";
  f.run("paintPreview(previewDraftState)");
  assert.equal(f.panel.open, true);
  assert.equal(f.input.value, "hidden@fixture.invalid");
  assert.equal(f.status.textContent, "Bcc matches the roster.");
  f.check.click();
  assert.equal(f.status.textContent, "Bcc matches the roster.", "recheck uses the snapshot");
  f.get("compose-bcc").value = "hidden@fixture.invalid";
  f.input.focus();
  assert.equal(f.enter(f.input), true, "plain Enter keeps its textarea default");
  assert.equal(f.enter(f.input, { metaKey: true }), false);
  assert.equal(f.enter(f.check, { ctrlKey: true }), false);
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.run("confirmed.length"), 0);
  assert.equal(f.enter(confirm, { metaKey: true }), false);
  await settled();
  assert.equal(f.run("confirmed[0].kind"), "send");
  assert.equal(f.run("JSON.stringify(confirmed[0].payload)"), frozen);
  assert.equal(dialog.open, false);
  empty();

  open("new Date('2099-01-01T09:00:00Z')");
  empty();
  f.compare("pasted-only@fixture.invalid");
  const scheduled = f.run("JSON.stringify(previewDraftState.payload)");
  close(); // A prior native close event can arrive after reopening.
  assert.equal(f.input.value, "pasted-only@fixture.invalid");
  assert.equal(f.enter(f.input, { ctrlKey: true }), false);
  assert.equal(f.run("confirmed.length"), 1);
  confirm.click();
  await settled();
  assert.equal(f.run("confirmed[1].kind"), "schedule");
  assert.equal(f.run("confirmed[1].sendAt"), "2099-01-01T09:00:00.000Z");
  assert.equal(f.run("JSON.stringify(confirmed[1].payload)"), scheduled);
  assert.equal(dialog.open, false);
  empty();

  open("null");
  compare();
  f.get("compose-preview-cancel").click();
  empty();
  open("null");
  compare();
  assert.equal(dialog.dispatchEvent(new f.window.Event("cancel", { cancelable: true })), false);
  assert.equal(dialog.open, false);
  empty();
  open("null");
  compare();
  dialog.close();
  close();
  empty();
  assert.equal(f.run("previewDraftState"), null);
  assert.equal(f.run("confirmed.length"), 2);
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
  assert.match(text, /Review links before sending/);
  assert.match(text, /highlight that occurrence in the message without opening the destination/);
  assert.match(text, /Check Bcc roster before sending/);
  assert.match(text, /closing the preview clears the roster/);
  const scripts = [...f.document.scripts].map(script => script.getAttribute("src"));
  assert.ok(scripts.indexOf("./compose-bcc-roster.js") >= 0);
  assert.ok(scripts.indexOf("./compose-bcc-roster.js") < scripts.indexOf("./app.js"));
  assert.match(f.get("compose-preview-links").textContent, /highlight its location in the message without opening it/);
  assert.match(f.get("compose-preview").textContent, /Remote images stay blocked/);
});
