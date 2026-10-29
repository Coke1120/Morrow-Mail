// Synthetic Unread-filter hold. No mailbox, network, or live consent.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function loadFunctions(source, names) {
  const body = names.map((name) => functionSource(source, name)).join("\n");
  return new Function(`${body}; return { ${names.join(", ")} };`)();
}

const api = loadFunctions(appJs, [
  "unreadListActive",
  "unreadHoldKey",
  "applyUnreadHold",
  "filteredEmails",
  "visibleList",
  "mailListRequest",
]);

const unreadFolder = { accountId: "acct", folderId: "__morrow_unread__", folder: { id: "__morrow_unread__", view: { unread: true } } };
const allUnread = { allInbox: true, unreadOnly: true };
const rows = [
  { id: "a", unread: false, isStarred: false, subject: "Opened", from: "Ada", snippet: "read" },
  { id: "b", unread: true, isStarred: true, subject: "Still", from: "Bea", snippet: "unread" },
  { id: "c", unread: false, isStarred: true, subject: "Star", from: "Cy", snippet: "flagged" },
];

assert.equal(api.unreadListActive(unreadFolder), true);
assert.equal(api.unreadListActive(allUnread), true);
assert.equal(api.unreadListActive({ folder: { view: { flagged: true } } }), false);
assert.equal(api.unreadListActive({ ...unreadFolder, query: "hello" }), false);
assert.equal(api.unreadListActive({ ...unreadFolder, outbox: true }), false);
assert.equal(api.unreadListActive({ allInbox: true, unreadOnly: false }), false);
assert.equal(api.unreadHoldKey(unreadFolder), "acct\0__morrow_unread__");
assert.equal(api.unreadHoldKey(allUnread), "all");

let hold = api.applyUnreadHold(null, { kind: "open", view: unreadFolder, id: "a", accountId: "acct", unread: true });
assert.deepEqual(hold, { id: "a", accountId: "acct", key: "acct\0__morrow_unread__" });
assert.equal(api.applyUnreadHold(null, { kind: "open", view: unreadFolder, id: "a", unread: false }), null);
assert.equal(api.applyUnreadHold(null, { kind: "open", view: { folder: { id: "star", view: { flagged: true } } }, id: "a", unread: true }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "open", view: unreadFolder, id: "a", unread: true }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "open", view: unreadFolder, id: "a", unread: false }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "open", view: unreadFolder, id: "c", unread: false }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "highlight", id: "b" }).id, "a");
const next = api.applyUnreadHold(hold, { kind: "open", view: unreadFolder, id: "b", accountId: "acct", unread: true });
assert.equal(next.id, "b");
assert.notEqual(next.id, hold.id);

assert.equal(api.applyUnreadHold(hold, { kind: "mark", id: "a", isRead: true, mailList: true }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "mark", id: "b", isRead: true, mailList: true }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "mark", id: "a", isRead: false, mailList: true }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "mark", id: "a", isRead: true, mailList: false }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "mark", batch: true, isRead: true, selected: ["a"] }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "mark", batch: true, isRead: true, selected: ["b"] }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "mark", batch: true, isRead: false, selected: ["a"] }), null);

assert.equal(api.applyUnreadHold(hold, { kind: "refresh", ids: ["b", "a"] }).id, "a");
assert.equal(api.applyUnreadHold(hold, { kind: "refresh", ids: ["b"] }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "scope", view: { folder: { id: "INBOX" } } }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "scope", view: { ...unreadFolder, query: "find" } }), null);
assert.equal(api.applyUnreadHold(null, { kind: "scope", view: unreadFolder }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "scope", view: unreadFolder }).id, "a");

const allHold = api.applyUnreadHold(null, { kind: "open", view: allUnread, id: "a", accountId: "acct", unread: true });
assert.equal(allHold.key, "all");
assert.equal(api.applyUnreadHold(allHold, { kind: "scope", view: unreadFolder }), null);
assert.equal(api.applyUnreadHold(hold, { kind: "open", view: { allInbox: true, unreadOnly: false }, id: "b", unread: true }), null);

const unreadView = { view: { unread: true } };
let list = [
  { id: "a", unread: true, subject: "A", from: "Ada", snippet: "" },
  { id: "b", unread: true, subject: "B", from: "Bea", snippet: "" },
  { id: "c", unread: true, subject: "C", from: "Cy", snippet: "" },
];
let shownHold = null;
shownHold = api.applyUnreadHold(shownHold, { kind: "open", view: unreadFolder, id: "a", accountId: "acct", unread: true });
list = list.map((row) => row.id === "a" ? { ...row, unread: false } : row);
assert.deepEqual(api.visibleList(list, "", unreadView, shownHold.id).map((row) => row.id), ["a", "b", "c"]);
shownHold = api.applyUnreadHold(shownHold, { kind: "open", view: unreadFolder, id: "b", accountId: "acct", unread: true });
list = list.map((row) => row.id === "b" ? { ...row, unread: false } : row);
assert.deepEqual(api.visibleList(list, "", unreadView, shownHold.id).map((row) => row.id), ["b", "c"]);
shownHold = api.applyUnreadHold(shownHold, { kind: "mark", id: "c", isRead: true, mailList: true });
list = list.map((row) => row.id === "c" ? { ...row, unread: false } : row);
assert.deepEqual(api.visibleList(list, "", unreadView, shownHold.id).map((row) => row.id), ["b"]);
shownHold = api.applyUnreadHold(shownHold, { kind: "mark", id: "b", isRead: false, mailList: true });
list = list.map((row) => row.id === "b" ? { ...row, unread: true } : row);
assert.equal(shownHold, null);
assert.deepEqual(api.visibleList(list, "", unreadView, "").map((row) => row.id), ["b"]);
list = list.map((row) => row.id === "b" ? { ...row, unread: false } : row);
assert.deepEqual(api.visibleList(list, "", unreadView, "").map((row) => row.id), []);
assert.deepEqual(api.visibleList(rows, "", { view: { unread: true } }).map((row) => row.id), ["b"]);
assert.deepEqual(api.visibleList(rows, "", { view: { unread: true } }, "a").map((row) => row.id), ["a", "b"]);
assert.deepEqual(api.visibleList(rows, "", { view: { flagged: true } }, "a").map((row) => row.id), ["b", "c"]);
assert.deepEqual(api.visibleList(rows, "", { id: "INBOX" }, "a").map((row) => row.id), ["a", "b", "c"]);
assert.deepEqual(api.visibleList(rows, "nope", { view: { unread: true } }, "a"), []);

const kept = api.mailListRequest({ allInbox: true, unreadOnly: true, retainIds: ["held"], limit: 20, offset: 0 });
assert.equal(kept.params.filterUnread, true);
assert.deepEqual(kept.params.retainIds, ["held"]);
const folder = api.mailListRequest({ accountId: "acct", folderId: "__morrow_unread__", retainIds: ["held"], limit: 20, offset: 0 });
assert.deepEqual(folder.params.retainIds, ["held"]);
assert.equal(folder.params.filterUnread, undefined);
assert.equal(api.mailListRequest({ query: "hi", retainIds: ["held"] }).params.retainIds, undefined);
assert.equal(api.mailListRequest({ allInbox: true, unreadOnly: true, retainIds: ["", "held"], limit: 20, offset: 0 }).params.retainIds, undefined);
assert.equal(api.mailListRequest({ allInbox: true, unreadOnly: true, retainIds: ["x".repeat(201)], limit: 20, offset: 0 }).params.retainIds, undefined);
assert.equal(api.mailListRequest({ allInbox: false, unreadOnly: true, accountId: "a", folderId: "INBOX", limit: 200, offset: 0 }).params.filterUnread, undefined);

const openSource = functionSource(appJs, "openMessage");
assert.ok(openSource.indexOf("const openedUnread") < openSource.indexOf("mail:openEmail"));
assert.ok(openSource.indexOf("mail:openEmail") < openSource.indexOf('kind: "open"'));
assert.ok(openSource.indexOf('kind: "open"') < openSource.indexOf("setRead(email, true)"));
assert.ok(openSource.includes("unread: openedUnread"));
const setReadSource = functionSource(appJs, "setRead");
assert.ok(setReadSource.includes('kind: "mark"'));
assert.ok(setReadSource.includes("mailList: state.view === \"mail\""));
assert.ok(setReadSource.includes("state.unreadHold = priorHold"));
assert.ok(setReadSource.indexOf('kind: "mark"') < setReadSource.indexOf("paint(!isRead)"));
assert.ok(functionSource(appJs, "bulkSetRead").includes("batch: true"));
assert.ok(functionSource(appJs, "loadList").includes("noteUnreadScope()"));
assert.ok(functionSource(appJs, "loadList").includes("retainIds"));
assert.ok(functionSource(appJs, "loadList").includes('kind: "refresh"'));
assert.ok(functionSource(appJs, "shownEmails").includes("state.unreadHold"));
assert.ok(functionSource(appJs, "selectOutbox").includes("noteUnreadScope()"));
assert.ok(!functionSource(appJs, "moveCursor").includes("unreadHold"));
assert.ok(!functionSource(appJs, "onShellKey").includes("applyUnreadHold"));

const catalog = require("../renderer/features-catalog").items.find((row) => row.id === "unread-filter");
assert.ok(catalog);
assert.match(catalog.blurb, /keeps that one row/);
assert.match(catalog.blurb, /Multi-select Mark read removes every selected row/);
assert.match(catalog.blurb, /Other filters do not keep a read row/);
const adr = fs.readFileSync(path.join(root, "docs/adr/2026-10-29-unread-filter-defer-removal.md"), "utf8");
assert.match(adr, /Status: Accepted and implemented/);
for (const file of ["docs/INDEPENDENT_UI.md", "docs/PARITY_SHELL.md"]) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(text, /Opening an unread message keeps that row/);
  assert.match(text, /All Account Mail Unread chip follows the same rule/);
}

console.log("unread filter hold checks passed");
