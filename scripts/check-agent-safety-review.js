"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const review = require("../renderer/agent-safety-review");
const make = (messageId, attrs = {}) => ({
  accountId: "one", messageId, threadId: "", hasAttachments: false, from: "Sender <sender@example.test>", subject: "Weekly newsletter", ...attrs,
});
const sections = (items, id = "other", name = "Other") => [{ id, name, items }];
test("risk and actionable categories beat promotional keywords, attachments stay ordinary", () => {
  const rows = review.snapshotRows([
    ...sections([make("a", { subject: "Newsletter: new sign-in" }), make("b"), make("c", { hasAttachments: true }),
      make("d", { subject: "付款失敗" }), make("e", { subject: "An ordinary note" })]),
    ...sections([make("f")], "needs-you", "Needs You"),
  ]);
  assert.deepEqual(rows.map(x => x.tier), ["review", "cleanup", "ordinary", "review", "ordinary", "review"]);
});
test("attention outranks ordinary and cleanup inside the mailbox thread only", () => {
  const rows = review.snapshotRows(sections([
    make("a", { threadId: "b" }), make("b"), make("c", { threadId: "b", subject: "Action required" }),
    make("a", { accountId: "two", threadId: "b" }), make("a", { accountId: "two", threadId: "b" }),
  ]));
  assert.deepEqual(review.groupedThreads(rows).map(x => [x.accountId, x.messageId]), [["one", "c"], ["one", "b"], ["two", "a"]]);
});
test("exact preview rejects partial/wildcard scopes and keeps affected threads out of cleanup", () => {
  const rows = review.snapshotRows(sections([
    make("a"), make("b", { threadId: "next" }), make("c", { threadId: "next", subject: "Deadline" }),
    make("d", { accountId: "two" }), make("e", { from: "Different <sender@example.test>" }),
  ]));
  const exact = { accountId: "one", sender: "Sender <sender@example.test>", subject: "Weekly newsletter" };
  const result = review.previewExact(rows, exact);
  assert.deepEqual(result.candidates.map(x => x.messageId), ["a"]);
  assert.deepEqual(result.held.map(x => x.messageId), ["b"]);
  assert.deepEqual(review.previewExact(rows, { ...exact, subject: "*newsletter*" }).candidates, []);
  assert.equal(review.previewExact(rows, { ...exact, accountId: "" }).valid, false);
  assert.equal(review.previewExact(rows, { ...exact, sender: "" }).valid, false);
});
test("real Agent panel markup previews in-place; edits, a new snapshot and a blocked result retire it", () => {
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  const markup = html.match(/<details id="agent-safety-review"[\s\S]*?<\/details>/)[0];
  const dom = new JSDOM(markup);
  const panel = dom.window.document.querySelector("details");
  const form = panel.querySelector("form");
  const accounts = [{ id: "one", email: "one@example.test" }];
  const snapshot = { accepted: true, sections: sections([make("a"), make("missing", { accountId: "gone", subject: "Disconnected account" }), make("visible", { subject: "<b>security alert</b>" })]) };
  review.paint(panel, snapshot, accounts);
  assert.match(panel.querySelector("[data-review-tiers]").textContent, /Needs attention · 1/);
  assert.equal(panel.querySelector("[data-review-tiers] b"), null);
  assert.doesNotMatch(panel.textContent, /Disconnected account/);
  form.querySelector("select").value = "one";
  form.querySelector("[name=sender]").value = "Sender <sender@example.test>";
  form.querySelector("[name=subject]").value = "Weekly newsletter";
  assert.equal(!form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })), true);
  const result = panel.querySelector("[data-review-result]");
  assert.match(result.textContent, /1 possible cleanup; 0 matching held.*No messages changed/);
  review.paint(panel, snapshot, accounts);
  assert.match(result.textContent, /1 possible cleanup/);
  form.dispatchEvent(new dom.window.Event("input"));
  assert.equal(result.textContent, "");
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  review.paint(panel, { accepted: true, sections: sections([make("b")]) }, accounts);
  assert.equal(result.textContent, "");
  assert.equal(form.querySelector("[name=subject]").value, "Weekly newsletter");
  review.paint(panel, { ...snapshot, stale: true }, accounts);
  assert.equal(form.hidden, true);
  assert.match(panel.textContent, /Refresh todos before previewing/);
  review.paint(panel, { accepted: false, sections: snapshot.sections }, accounts);
  assert.equal(form.hidden, true);
  assert.doesNotMatch(panel.textContent, /security alert/);
});
test("first-party wiring, Features and documentation describe advisory rules without write paths", () => {
  const read = (filename) => fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
  const app = read("renderer/app.js");
  const html = read("renderer/index.html");
  assert.match(app, /morrowAgentSafetyReview\?\.paint\(\$\("agent-safety-review"\), payload, state.accounts\)/);
  assert.ok(html.indexOf('./agent-safety-review.js') < html.indexOf('./app.js'));
  assert.match(read("renderer/features-catalog.js"), /Agent safety review[\s\S]*No rule is approved/);
  assert.match(read("docs/adr/2026-11-17-agent-safety-review.md"), /never approves, saves or executes/);
});
