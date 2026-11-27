"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");

const source = fs.readFileSync(require.resolve("../renderer/reply-selection"), "utf8");

function fixture(t, content) {
  const { window } = new JSDOM(
    `<h2>Sender header</h2><main>${content}</main><aside>Other mail</aside>`,
    { runScripts: "outside-only" },
  );
  t.after(() => window.close());
  window.eval(source);
  const { document, morrowReplySelection: actions } = window;
  const body = document.querySelector("main");
  return { document, body, actions, selection: document.getSelection() };
}

test("reads a precise reversed range in the current message body", t => {
  const { body, actions, selection } = fixture(t,
    '<p>Cover <em>needs 18 mm from trim</em>.</p><p>Inside pages need 20 mm.</p>');
  const text = body.querySelector("em").firstChild;
  selection.setBaseAndExtent(text, 11, text, 6);
  assert.equal(actions.read(body), "18 mm");
});

test("requires a nonempty range wholly inside the message", t => {
  const { document, body, actions, selection } = fixture(t, "<p>Blank <span> </span> detail</p>");
  assert.equal(actions.read(body), null);
  selection.selectAllChildren(body.querySelector("span"));
  assert.equal(actions.read(body), null);
  selection.selectAllChildren(document.querySelector("aside"));
  assert.equal(actions.read(body), null);
  selection.setBaseAndExtent(document.querySelector("h2").firstChild, 0, body.querySelector("p").firstChild, 5);
  assert.equal(actions.read(body), null);
});

test("does not reuse a selection after repaint or after clearing it", t => {
  const { body, actions, selection } = fixture(t, "<p>Original excerpt.</p>");
  selection.selectAllChildren(body);
  assert.equal(actions.read(body), "Original excerpt.");
  selection.removeAllRanges();
  assert.equal(actions.read(body), null);

  selection.selectAllChildren(body);
  const replacement = body.cloneNode(true);
  body.replaceWith(replacement);
  assert.equal(actions.read(body), null);
  assert.equal(actions.read(replacement), null);
});

test("requires a narrower selection when mail CSS obscures part of it", t => {
  const { body, actions, selection } = fixture(t,
    '<p>Visible excerpt <span style="opacity:0">hidden</span> line.</p>');
  selection.selectAllChildren(body);
  assert.equal(actions.read(body), null);
  const visible = body.querySelector("p").firstChild;
  selection.setBaseAndExtent(visible, 0, visible, visible.length);
  assert.equal(actions.read(body), "Visible excerpt ");
});

test("quotes a sentence and word restored to a visible font size in the Reader", t => {
  const { document, body: pane, actions, selection } = fixture(t, "");
  const ui = renderer({ window: document.defaultView, document, pane, email: {
    htmlBody: '<style>.zero { font-size: 0px } .visible { font-size: 16px }</style>' +
      '<p class="zero">Unseen text<span class="visible">Please check the invoice.</span></p>',
  } });
  const body = ui.run("appendMessageBody(pane, email, false)");
  const paragraph = body.querySelector("p");
  const visible = paragraph.querySelector("span");
  assert.equal(paragraph.style.fontSize, "0px");
  assert.equal(visible.style.fontSize, "16px");

  selection.selectAllChildren(visible);
  assert.equal(actions.read(body), "Please check the invoice.");
  const text = visible.firstChild;
  const word = "invoice";
  const start = text.data.indexOf(word);
  selection.setBaseAndExtent(text, start, text, start + word.length);
  assert.equal(actions.read(body), word);

  const hidden = paragraph.firstChild;
  selection.setBaseAndExtent(hidden, hidden.length, text, text.length);
  assert.equal(actions.read(body), "Please check the invoice.");
  selection.setBaseAndExtent(hidden, hidden.length - 1, text, text.length);
  assert.equal(actions.read(body), null);
});

test("creates a plain-text quote with line breaks and no links or images", t => {
  const { document, actions } = fixture(t, "");
  const quote = actions.quoteBody(document, "18 mm <trim>  & 中文\n\nhttps://example.invalid/label");
  assert.equal(quote.tagName, "BLOCKQUOTE");
  assert.equal(quote.innerHTML, "<pre><span>18 mm &lt;trim&gt;  &amp; 中文\n\nhttps://example.invalid/label</span></pre>");
  assert.equal(quote.querySelector("pre").textContent, "18 mm <trim>  & 中文\n\nhttps://example.invalid/label");
});

test("the reader menu uses its own selected passage and rejects missing or replaced sources", async t => {
  const { document, body, selection } = fixture(t, "<p>Before excerpt after.</p>");
  const ui = renderer({ window: document.defaultView, document });
  ui.run(`
    state.view = "mail";
    state.accounts = [{ id: "acct", email: "me@example.invalid", bodyEpoch: 1 }];
    state.email = { id: "one", accountId: "acct", bodyEpoch: 1, textBody: "Before excerpt after." };
    globalThis.replySeeds = [];
    globalThis.feedback = [];
    presentCompose = async seed => replySeeds.push(seed);
    showStatus = message => feedback.push(message);
  `);
  ui.context.body = body;
  const text = body.querySelector("p").firstChild;
  function openItem(select) {
    if (select) selection.setBaseAndExtent(text, 7, text, 14);
    else selection.removeAllRanges();
    ui.context.menu = document.createElement("div");
    ui.run("appendReaderBodyActions(menu, { ...state.email }, body)");
    return [...ui.context.menu.children].find(node => node.textContent === "Reply quoting selection");
  }
  const invoke = async item => {
    item.click();
    await new Promise(setImmediate);
  };
  const selected = openItem(true);
  selection.removeAllRanges();
  await invoke(selected);
  assert.equal(ui.run("replySeeds[0].selectedReplyQuote"), "excerpt");
  assert.equal(ui.run("replySeeds[0].sourceMessageId"), "one");

  await invoke(openItem(false));
  const stale = openItem(true);
  ui.run('state.email = { ...state.email, id: "two" };');
  await invoke(stale);
  assert.equal(ui.run("replySeeds.length"), 1);
  assert.equal(ui.run('feedback.filter(message => message.includes("Select text")).length'), 2);
});
