// Synthetic events/native objects only. No OS permissions, sockets or mail.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { createNotifications, MAX_SEEN, MAX_PENDING, INTERVAL_MS } = require("../host/mail/notifications");

function fixture() {
  let clock = 1793635200000;
  const saved = new Map(), messages = new Map(), accounts = new Map(["a", "b"].map(id => [id, { id, created_at: 1 }]));
  const timers = new Map(), notices = [];
  let prefs = { enabled: true, preview: "hidden" }, opened = 0, failSave = false;
  const store = {
    notificationState(id, value) { if (value) { if (failSave) throw new Error("disk"); saved.set(id, structuredClone(value)); } return structuredClone(saved.get(id) || {}); },
    accountById: id => accounts.get(id), messageById: id => messages.get(id),
    folderByPath: (accountId, path) => ({ path, well_known: path === "INBOX" ? "inbox" : path === "Trash" ? "deleteditems" : null }),
    folderByWellKnown: () => ({ path: "INBOX", well_known: "inbox" }),
    gmailCopies: (accountId, providerId) => [...messages.values()].filter(row => row.account_id === accountId && row.gmail_id === providerId),
    listAccountRows: () => [...accounts.values()], isReady: () => true,
  };
  class Native extends EventEmitter {
    static supported = true;
    static behavior = "show";
    static isSupported() { return this.supported; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() {
      assert.ok(saved.size, "reservation persisted before native show");
      if (Native.behavior === "throw") throw new Error("denied");
      if (Native.behavior !== "dnd") this.emit(Native.behavior);
    }
    close() { this.closed = true; this.emit("close"); }
  }
  const make = () => {
    const controller = createNotifications({ store, now: () => clock, preferences: () => prefs,
      setTimer(fn, delay) { const key = {}; timers.set(key, { fn, at: clock + delay }); return key; }, clearTimer: key => timers.delete(key) });
    controller.configure({ Notification: Native, platform: "win32", open: () => { opened++; } });
    return controller;
  };
  let controller = make();
  function arrival(n, accountId = "a", extra = {}) {
    const messageId = `${accountId}-${n}`;
    messages.set(messageId, { id: messageId, account_id: accountId, folder_path: "INBOX", date_iso: new Date(clock).toISOString(),
      from_addr: "Private sender <private@example.invalid>", subject: "Private subject", snippet: "Private preview", unread: 1, ...extra });
    return { messageId, identity: `imap:INBOX:1:${n}`, receivedAt: clock, sentAt: Date.parse(messages.get(messageId).date_iso) };
  }
  function advance(ms = 2000) {
    clock += ms;
    for (const [key, job] of [...timers]) if (job.at <= clock) { timers.delete(key); job.fn(); }
  }
  return { store, saved, messages, accounts, Native, notices, timers, arrival, advance,
    get controller() { return controller; }, get opened() { return opened; }, get clock() { return clock; },
    changePrefs(value) { prefs = { ...prefs, ...value }; controller.settingsChanged(); },
    restart() { controller.stop(); controller = make(); }, setFailSave() { failSave = true; } };
}

test("recent arrivals are generic by default and click pulls a validated same-account target once", async () => {
  const f = fixture(), row = f.arrival(1);
  f.controller.enqueue(f.accounts.get("a"), [row]);
  assert.equal(f.notices.length, 0); f.advance();
  assert.equal(f.notices.length, 1);
  assert.deepEqual(f.notices[0].options, { title: "Morrow Mail", body: "You have a new email.", silent: false, urgency: "normal", timeoutType: "default" });
  assert.doesNotMatch(JSON.stringify(f.saved.get("a")), /Private|private@|INBOX/);
  f.notices[0].emit("click"); await Promise.resolve();
  assert.equal(f.opened, 1);
  assert.deepEqual(f.controller.takeTarget(), { accountId: "a", folderId: "INBOX", messageId: row.messageId });
  assert.equal(f.controller.takeTarget(), null);
});

test("old startup/history/import dates, read mail, drafts and malformed IDs are silent", () => {
  const f = fixture();
  const old = f.arrival(1); old.receivedAt--;
  const imported = f.arrival(2, "a", { date_iso: "2001-01-01T00:00:00Z" });
  const read = f.arrival(3, "a", { unread: 0 });
  const draft = f.arrival(4, "a", { is_draft: 1 });
  f.controller.enqueue(f.accounts.get("a"), [old, imported, read, draft, { ...f.arrival(5), messageId: "\0bad" }]);
  f.advance(); assert.equal(f.notices.length, 0); assert.equal(f.saved.size, 0);
});

test("reconnect invalidates pending/native clicks and restart cannot replay successful reservations", async () => {
  const f = fixture(), row = f.arrival(1);
  f.controller.enqueue(f.accounts.get("a"), [row]); f.advance();
  f.controller.invalidate("a");
  f.notices[0].emit("click"); await Promise.resolve(); assert.equal(f.opened, 0);
  f.controller.enqueue(f.accounts.get("a"), [row]); f.advance(); assert.equal(f.notices.length, 1);
  f.restart(); f.controller.enqueue(f.accounts.get("a"), [{ ...row, receivedAt: f.clock }]); f.advance();
  assert.equal(f.notices.length, 1, "saved identity also blocks a refreshed event timestamp");
  const fresh = f.arrival(2); f.controller.enqueue(f.accounts.get("a"), [fresh]); f.advance(); assert.equal(f.notices.length, 2);
});

test("bursts across accounts batch, count and rate limit globally; IDs remain account scoped", () => {
  const f = fixture();
  f.controller.enqueue(f.accounts.get("a"), [f.arrival(1), f.arrival(2)]);
  f.controller.enqueue(f.accounts.get("b"), [f.arrival(1, "b")]); f.advance();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].options.body, "3 new emails across 2 mailboxes.");
  f.controller.enqueue(f.accounts.get("a"), [f.arrival(3)]); f.advance(); assert.equal(f.notices.length, 1);
  f.advance(INTERVAL_MS); assert.equal(f.notices.length, 2);
});

test("failed, throwing, unsupported and OS-suppressed notifications never retry or bypass the OS", () => {
  for (const behavior of ["failed", "throw", "dnd", "unsupported"]) {
    const f = fixture(), row = f.arrival(1);
    f.Native.behavior = behavior; f.Native.supported = behavior !== "unsupported";
    f.controller.enqueue(f.accounts.get("a"), [row]); f.advance();
    const count = f.notices.length;
    f.controller.enqueue(f.accounts.get("a"), [row]); f.advance(INTERVAL_MS); assert.equal(f.notices.length, count);
    assert.equal(f.controller.status().state, behavior === "unsupported" ? "unsupported" : behavior === "dnd" ? "ready" : "failed");
    f.restart(); f.controller.enqueue(f.accounts.get("a"), [{ ...row, receivedAt: f.clock }]); f.advance(); assert.equal(f.notices.length, count);
  }
});

test("privacy modes sanitize and bound text; settings changes close old previews and clear pending", () => {
  const f = fixture();
  f.changePrefs({ preview: "sender" });
  f.controller.enqueue(f.accounts.get("a"), [f.arrival(1)]); f.advance();
  assert.match(f.notices[0].options.body, /Private sender/); assert.doesNotMatch(f.notices[0].options.body, /subject|preview/);
  f.changePrefs({ preview: "message" }); assert.equal(f.notices[0].closed, true);
  f.controller.enqueue(f.accounts.get("a"), [f.arrival(2, "a", { subject: "<b>題</b>\r\n".repeat(100), snippet: "<img src='https://evil.invalid'>\u202eSecret".repeat(100) })]);
  f.advance(INTERVAL_MS);
  const notice = f.notices.at(-1);
  assert.doesNotMatch(notice.options.body, /[<>\r\n\u202e]|https:/);
  assert.ok(Buffer.byteLength(notice.options.title + notice.options.body) < 256);
  f.controller.enqueue(f.accounts.get("a"), [f.arrival(3)]);
  f.changePrefs({ enabled: false }); f.advance(INTERVAL_MS); assert.equal(f.notices.length, 2);
  f.controller.enqueue(f.accounts.get("a"), [f.arrival(4)]); f.advance(); assert.equal(f.notices.length, 2);
});

test("account removal, cross-account substitution and moved/missing messages route safely", async () => {
  for (const action of ["remove", "cross-account", "move", "missing"]) {
    const f = fixture(), row = f.arrival(1);
    f.controller.enqueue(f.accounts.get("a"), [row]); f.advance();
    if (action === "remove") f.accounts.delete("a");
    if (action === "cross-account") f.messages.get(row.messageId).account_id = "b";
    if (action === "move") f.messages.get(row.messageId).folder_path = "Archive";
    if (action === "missing") f.messages.delete(row.messageId);
    f.notices[0].emit("click"); await Promise.resolve();
    const value = f.controller.takeTarget();
    if (action === "remove") assert.equal(value, null);
    else assert.deepEqual(value, { accountId: "a", folderId: action === "move" ? "Archive" : "INBOX", messageId: action === "move" ? row.messageId : null });
  }
});

test("persistence failure halts delivery without changing mail and queues/dedup are bounded", () => {
  const broken = fixture(); broken.setFailSave();
  broken.controller.enqueue(broken.accounts.get("a"), [broken.arrival(1)]); broken.advance();
  assert.equal(broken.notices.length, 0); assert.equal(broken.controller.status().state, "storage-error");
  assert.equal(broken.messages.size, 1);
  const f = fixture();
  const original = f.arrival(1);
  f.controller.enqueue(f.accounts.get("a"), Array.from({ length: MAX_SEEN + 20 }, (_, i) => f.arrival(i + 1)));
  assert.equal(f.saved.get("a").seen.length, MAX_SEEN); f.advance();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].options.body, `${MAX_PENDING} new emails.`);
  f.controller.enqueue(f.accounts.get("a"), [{ ...f.arrival(1), receivedAt: original.receivedAt }]); f.advance(INTERVAL_MS); assert.equal(f.notices.length, 1, "evicted timestamp floor prevents replay");
});

test("queued mail expires across long sleep; broken history and preference reads cannot interrupt sync", () => {
  const f = fixture(); f.controller.enqueue(f.accounts.get("a"), [f.arrival(1)]);
  f.advance(10 * 60 * 1000); assert.equal(f.notices.length, 0);
  f.saved.set("a", { seen: [["not-a-digest", f.clock]] });
  assert.doesNotThrow(() => f.controller.enqueue(f.accounts.get("a"), [f.arrival(2)]));
  assert.equal(f.controller.status().state, "storage-error");
  const g = fixture();
  const broken = createNotifications({ store: g.store, preferences: () => { throw new Error("settings unavailable"); } });
  broken.configure({ Notification: g.Native, platform: "win32", open() {} });
  assert.doesNotThrow(() => broken.enqueue(g.accounts.get("a"), [g.arrival(1)]));
  assert.equal(g.notices.length, 0);
});

test("Gmail label copy retirement before show retains preview and correct target; stopped controllers reject late sync", async () => {
  const f = fixture(); f.changePrefs({ preview: "sender" });
  const item = f.arrival(1, "a", { gmail_id: "gmail-1" });
  f.controller.enqueue(f.accounts.get("a"), [item]);
  const replacement = { ...f.messages.get(item.messageId), id: "replacement" };
  f.messages.delete(item.messageId); f.messages.set(replacement.id, replacement);
  f.advance(); assert.equal(f.notices.length, 1); assert.match(f.notices[0].options.body, /Private sender/);
  f.notices[0].emit("click"); await Promise.resolve();
  assert.equal(f.controller.takeTarget().messageId, "replacement");
  f.controller.stop(); f.controller.enqueue(f.accounts.get("a"), [f.arrival(2)]); f.advance(INTERVAL_MS);
  assert.equal(f.notices.length, 1, "late sync cannot recreate notifications during quit cleanup");
});
