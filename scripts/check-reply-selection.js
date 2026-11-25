"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

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

test("creates a plain-text quote with line breaks and no links or images", t => {
  const { document, actions } = fixture(t, "");
  const quote = actions.quoteBody(document, "18 mm <trim>  & 中文\n\nhttps://example.invalid/label");
  assert.equal(quote.tagName, "BLOCKQUOTE");
  assert.equal(quote.innerHTML, "<pre><span>18 mm &lt;trim&gt;  &amp; 中文\n\nhttps://example.invalid/label</span></pre>");
  assert.equal(quote.querySelector("pre").textContent, "18 mm <trim>  & 中文\n\nhttps://example.invalid/label");
});
