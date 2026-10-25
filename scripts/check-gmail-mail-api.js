// Entirely synthetic HTTP and IMAP clients. Never opens a socket or reads credentials.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { createGmailMailApi, MAIL_SCOPES, CALENDAR_SCOPES } = require("../host/mail/gmail-mail-api");
const ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const reply = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const source = Buffer.from("From: fixture@example.invalid\r\nTo: to@example.invalid\r\nCc: cc@example.invalid\r\nBcc: bcc@example.invalid\r\nSubject: Re: synthetic\r\nIn-Reply-To: <fixture@example.invalid>\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nSynthetic draft\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=fixture.txt\r\n\r\nSynthetic attachment\r\n--fixture--\r\n");
function fixture(route, options = {}) {
  const calls = [];
  const api = createGmailMailApi({ accessToken: async () => "synthetic-token", ...options, fetchImpl: async (url, input) => {
    assert.ok(url.startsWith(`${ROOT}/`));
    assert.equal(input.redirect, "error");
    assert.equal(input.headers.authorization, "Bearer synthetic-token");
    assert.ok(!/\/(?:messages|threads)(?:\/[^/?]+)?(?:\/batchDelete)?(?:\?|$)/.test(url) || input.method !== "DELETE", "no permanent mail deletion");
    assert.ok(!url.includes("batchDelete"));
    const call = { url: new URL(url), input, body: input.body ? JSON.parse(input.body) : undefined };
    calls.push(call); return route(call, calls);
  } });
  return { api, calls };
}

test("paged message/history/body/attachment reads retain provider ids and MIME without IMAP assumptions", async () => {
  const f = fixture(({ url }) => {
    if (url.pathname.endsWith("/attachments/part-1")) return reply({ data: Buffer.from("Synthetic attachment").toString("base64url") });
    if (url.pathname.endsWith("/messages/message-1")) return reply({ id: "message-1", threadId: "thread-1", raw: source.toString("base64url"), labelIds: ["INBOX", "UNREAD"], payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Synthetic body").toString("base64url") } }] } });
    if (url.pathname.endsWith("/history")) return reply({ historyId: "99999999999999999999", history: [{ id: "22", messagesAdded: [{ message: { id: "message-1" } }] }], nextPageToken: "history-page" });
    return reply({ messages: [{ id: "message-1", threadId: "thread-1" }], nextPageToken: "next-page" });
  });
  const page = await f.api.listMessages({ labelIds: ["INBOX"], query: "after:1700000000", limit: 120, pageToken: "previous-page" });
  assert.equal(page.nextPageToken, "next-page");
  assert.equal(f.calls[0].url.searchParams.get("pageToken"), "previous-page");
  assert.equal(f.calls[0].url.searchParams.get("maxResults"), "120");
  assert.equal(f.calls[0].url.searchParams.get("q"), "after:1700000000");
  assert.deepEqual((await f.api.raw("message-1")).source, source);
  assert.equal((await f.api.getMessage("message-1")).payload.parts[0].mimeType, "text/plain");
  assert.equal((await f.api.attachment("message-1", "part-1")).toString(), "Synthetic attachment");
  assert.equal((await f.api.history({ startHistoryId: "99999999999999999998" })).historyId, "99999999999999999999");
  assert.ok(f.calls.every(call => call.input.method === "GET"));
});

test("draft create/update/resume preserve MIME, replies and attachments; save never sends and discard trashes", async () => {
  const f = fixture(({ url, input, body }) => {
    if (url.pathname.endsWith("/trash")) return reply({ id: "draft-message-1", labelIds: ["TRASH"] });
    if (url.pathname.endsWith("/messages/draft-message-1")) return reply({ id: "draft-message-1", labelIds: ["DRAFT"] });
    if (input.method === "POST" || input.method === "PUT") assert.deepEqual(Buffer.from(body.message.raw, "base64url"), source);
    if (url.pathname.endsWith("/drafts") && input.method === "GET") return reply({ drafts: [{ id: "draft-1", message: { id: "draft-message-1" } }], nextPageToken: "draft-page" });
    return reply({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1", raw: source.toString("base64url") } });
  });
  await f.api.saveDraft({ raw: source, threadId: "thread-1" });
  await f.api.saveDraft({ draftId: "draft-1", raw: source, threadId: "thread-1" });
  assert.equal(f.calls[0].input.method, "POST"); assert.equal(f.calls[1].input.method, "PUT");
  assert.equal(f.calls[1].body.message.threadId, "thread-1");
  assert.equal((await f.api.getDraft("draft-1")).message.id, "draft-message-1");
  assert.equal((await f.api.listDrafts()).nextPageToken, "draft-page");
  assert.ok(f.calls.every(call => !call.url.pathname.endsWith("/send")));
  await f.api.discardDraft("draft-1");
  assert.ok(f.calls.at(-1).url.pathname.endsWith("/messages/draft-message-1/trash"));
  assert.ok(f.calls.every(call => call.input.method !== "DELETE"));
});

test("send requires an explicit action and preserves To/Cc/Bcc/threading/MIME without an automatic retry", async () => {
  const f = fixture(({ body }) => { assert.deepEqual(Buffer.from(body.raw, "base64url"), source); assert.equal(body.threadId, "thread-1"); return reply({ id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] }); });
  await assert.rejects(f.api.send({ raw: source }), /explicit/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.api.send({ raw: source, threadId: "thread-1", confirmed: true })).id, "sent-1");
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.pathname.endsWith("/messages/send"));
  assert.equal(MAIL_SCOPES.includes("mail.google.com"), false);
  assert.equal(MAIL_SCOPES.includes("gmail.labels"), false);
  assert.equal(MAIL_SCOPES.includes("calendar"), false);
  assert.equal(CALENDAR_SCOPES.includes("gmail"), false);
  const actual = require("../host/mail/oauth-config").scopesFor("google", "bundle");
  assert.ok(actual.includes("https://mail.google.com/"), "current production request remains broad until engine migration is complete");
});

test("read/star/archive/labels and Trash Undo preserve membership without erasing later flags", async () => {
  const f = fixture(({ url, body }) => {
    if (url.pathname.endsWith("/messages/message-1")) return reply({ id: "message-1", labelIds: ["INBOX", "Label_work", "UNREAD"] });
    if (url.pathname.endsWith("/trash")) return reply({ id: "message-1", labelIds: ["TRASH"] });
    if (url.pathname.endsWith("/untrash")) return reply({ id: "message-1", labelIds: ["STARRED", "Label_new"] });
    return reply({ id: "message-1", labelIds: body?.addLabelIds || [] });
  });
  await f.api.markRead("message-1", true); assert.deepEqual(f.calls.at(-1).body.removeLabelIds, ["UNREAD"]);
  await f.api.star("message-1", true); assert.deepEqual(f.calls.at(-1).body.addLabelIds, ["STARRED"]);
  await f.api.archive("message-1"); assert.deepEqual(f.calls.at(-1).body.removeLabelIds, ["INBOX"]);
  await f.api.modifyLabels("message-1", ["Label_work"], ["Label_old"]);
  const trashed = await f.api.trash("message-1");
  await f.api.restoreTrash(trashed.undo);
  assert.deepEqual(f.calls.at(-1).body, { addLabelIds: ["INBOX", "Label_work"], removeLabelIds: [] });
  await assert.rejects(f.api.modifyLabels("message-1", ["INBOX"], ["INBOX"]), /both/);
});

test("existing label hierarchy API is reused with redirects disabled", async () => {
  const f = fixture(({ input, body }) => input.method === "GET" ? reply({ labels: [{ id: "Label_work", name: "Work", type: "user" }] }) : input.method === "DELETE" ? reply(null, 204) : reply({ id: "Label_work", name: body.name, type: "user" }));
  assert.equal((await f.api.labels())[0].name, "Work");
  await f.api.createLabel("Work"); await f.api.renameLabel("Label_work", "Next"); await f.api.deleteLabel("Label_work");
  assert.ok(f.calls.every(call => call.url.pathname.includes("/labels")));
});

test("HTTP failure, lost writes, history expiry, malformed data and cancellation stay explicit", async () => {
  for (const [status, code, issued] of [[403, "scope_missing", false], [429, "rate_limit", false], [500, "provider", true]]) {
    const f = fixture(() => reply({}, status, { "retry-after": "2" }));
    await assert.rejects(f.api.send({ raw: source, confirmed: true }), error => error.code === code && error.operationIssued === issued);
    assert.equal(f.calls.length, 1);
  }
  const expired = fixture(() => reply({}, 404));
  await assert.rejects(expired.api.history({ startHistoryId: "10" }), error => error.code === "history_expired");
  const malformed = fixture(() => reply({ id: "message-1", raw: "!!bad!!" }));
  await assert.rejects(malformed.api.raw("message-1"), /base64url/);
  const failed = fixture(() => { throw new Error("Synthetic lost acknowledgement"); });
  await assert.rejects(failed.api.send({ raw: source, confirmed: true }), error => error.operationIssued && error.code === "provider_network");
  assert.equal(failed.calls.length, 1);
  const lostId = fixture(() => reply({}));
  await assert.rejects(lostId.api.send({ raw: source, confirmed: true }), error => error.operationIssued && error.code === "provider");
  const controller = new AbortController(); controller.abort();
  const cancelled = fixture(() => { throw new Error("Must not send"); }, { signal: controller.signal });
  await assert.rejects(cancelled.api.listMessages()); assert.equal(cancelled.calls.length, 0);
});

function vmModule(filename, replacements, extra = "") {
  const load = createRequire(filename), module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => Object.hasOwn(replacements, name) ? replacements[name] : load(name), Buffer, URL, console, setTimeout, clearTimeout, setImmediate, WeakMap });
  vm.runInContext(fs.readFileSync(filename, "utf8") + extra, context);
  return { exports: module.exports, context };
}

test("real batch/legacy action paths turn Gmail deletion into Trash while preserving other providers", async () => {
  const accounts = { gmail: { id: "gmail", profile: "gmail" }, outlook: { id: "outlook", profile: "outlook" }, custom: { id: "custom", profile: "custom", imap_host: "imap.gmail.com" } };
  const rows = Object.fromEntries(Object.keys(accounts).map(key => [key, { id: key, account_id: key, folder_path: "Trash", uid: 1 }]));
  const db = { accountById: key => accounts[key], messageById: key => rows[key], folderByPath: (_account, value) => ({ path: value, well_known: value === "Trash" ? "deleteditems" : "inbox" }), folderByWellKnown: () => ({ path: "Trash", well_known: "deleteditems" }) };
  const deletions = [];
  const remote = { withClient: async (_account, _secret, work) => work({}), removeUid: async () => { deletions.push("permanent"); }, explain: error => error.message };
  const loaded = vmModule(require.resolve("../host/mail/actions"), { "./db": db, "./remote": remote, "./virtual-folders": { get: () => null } }, "\nmodule.exports.runRemote = runRemote; acceptAll = commands => ({ commands });");
  loaded.exports.install({ secretFor: async () => "fixture" });
  const batch = loaded.exports.handle("mail:deleteBatch", { folderWellKnownName: "trash", items: [{ emailId: "gmail" }, { emailId: "outlook" }, { emailId: "custom" }] }).data.commands;
  assert.equal(batch[0].intent.permanent, false); assert.equal(batch[0].intent.destPath, "Trash");
  assert.equal(batch[1].intent.permanent, true); assert.equal(batch[2].intent.permanent, false);
  rows.gmail.folder_path = "INBOX";
  const normal = loaded.exports.handle("mail:delete", { emailId: "gmail" }).data.commands[0];
  assert.equal(normal.intent.permanent, false); assert.equal(normal.intent.destPath, "Trash");
  for (const uid of [0, 1]) {
    const denied = await loaded.exports.runRemote({ account_id: "gmail", intent_json: JSON.stringify({ kind: "remove", permanent: true }), source_json: JSON.stringify({ uid }) });
    assert.equal(denied.issued, false); assert.match(denied.error, /Permanent Gmail deletion is unavailable/);
  }
  await loaded.exports.runRemote({ account_id: "outlook", intent_json: JSON.stringify({ kind: "remove", permanent: true }), source_json: JSON.stringify({ uid: 1, folderPath: "Trash", uidValidity: 1 }) });
  assert.equal(deletions.length, 1, "existing Outlook path remains available");
});

test("real IMAP draft cleanup moves Gmail copies to Trash and never expunges; other-provider cleanup stays unchanged", async () => {
  const calls = [];
  let hasTrash = true;
  class FakeClient extends EventEmitter {
    constructor() { super(); this.mailbox = { uidValidity: 1 }; }
    async connect() {} async logout() {} close() {}
    async list() { return [...(hasTrash ? [{ path: "Trash", specialUse: "\\Trash" }] : []), { path: "Drafts", specialUse: "\\Drafts" }]; }
    async getMailboxLock() { return { release() {} }; }
    async messageMove(uid, destination) { calls.push(["move", destination]); return { uidMap: new Map([[Number(uid), 2]]), uidValidity: 1 }; }
    async messageDelete() { calls.push(["delete"]); }
  }
  const remote = vmModule(require.resolve("../host/mail/remote"), { imapflow: { ImapFlow: FakeClient }, nodemailer: {}, "nodemailer/lib/mail-composer": class {}, mailparser: {} }).exports;
  for (const profile of ["gmail", "outlook", "custom"]) {
    const account = { profile, imap_host: profile === "custom" ? "imap.gmail.com" : `${profile}.invalid` };
    await remote.withClient(account, "fixture", client => remote.removeUid(client, "Drafts", 1, 1));
  }
  assert.deepEqual(calls, [["move", "Trash"], ["delete"], ["move", "Trash"]]);
  await remote.withClient({ profile: "gmail" }, "fixture", client => remote.removeUid(client, "Trash", 1, 1));
  assert.equal(calls.length, 3, "already-trashed Gmail remains in Trash");
  hasTrash = false;
  await assert.rejects(remote.withClient({ profile: "gmail" }, "fixture", client => remote.removeUid(client, "Drafts", 1, 1)), error => error.operationIssued === false && /Trash is unavailable/.test(error.message));
  hasTrash = true;
  await assert.rejects(remote.withClient({ profile: "gmail" }, "fixture", client => remote.removeUid(client, "Drafts", 1, 2)), error => error.operationIssued === false && error.code === "uid_validity_changed");
  assert.equal(calls.length, 3, "missing Trash or changed identity cannot trigger a permanent deletion fallback");
});
