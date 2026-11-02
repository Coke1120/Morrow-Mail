// Native notifications are owned by the main process. Provider/sync code can
// submit committed arrivals, never notification text, URLs or executable actions.
const crypto = require("node:crypto");
const db = require("./db");
const settings = require("../settings");

const MAX_SEEN = 2000;
const MAX_PENDING = 200;
const BATCH_MS = 2000;
const INTERVAL_MS = 15000;
const RECENT_MS = 5 * 60 * 1000;
const id = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function text(value, bytes) {
  const plain = String(value || "").replace(/<[^>]*>/g, "").replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  let result = "";
  for (const char of plain) { if (Buffer.byteLength(result + char) > bytes) break; result += char; }
  return result;
}

function createNotifications({ store = db, preferences = () => settings.notificationPreferences(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const startedAt = now();
  const boundaries = new Map();
  const versions = new Map();
  const pending = new Map();
  const active = new Set();
  let native = null, open = null, icon = null, platform = "", timer = null, lastAttempt = -Infinity;
  let halted = false, failed = false, stopped = false, target = null, settingsBoundary = startedAt;

  function prefs() { return preferences(); }
  function supported() {
    try { return ["win32", "darwin"].includes(platform) && native?.isSupported() === true; } catch { return false; }
  }
  function configure(options) {
    native = options.Notification; open = options.open; icon = options.icon; platform = options.platform;
    stopped = false;
  }
  function status() {
    const preference = prefs();
    return { enabled: preference.enabled, preview: preference.preview,
      state: halted ? "storage-error" : !preference.enabled ? "disabled" : !supported() ? "unsupported" : failed ? "failed" : "ready" };
  }
  function state(accountId) {
    const saved = store.notificationState(accountId);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)
      || (saved.seen !== undefined && (!Array.isArray(saved.seen) || saved.seen.length > MAX_SEEN
        || saved.seen.some(row => !Array.isArray(row) || !/^[a-f0-9]{64}$/.test(row[0]) || !Number.isFinite(row[1]))))
      || (saved.before !== undefined && !Number.isFinite(saved.before))) throw new Error("Invalid notification history");
    return { seen: saved.seen || [], before: saved.before || 0 };
  }
  function resolve(saved) {
    if (!saved || !id(saved.accountId)) return null;
    const account = store.accountById(saved.accountId);
    if (!account || account.created_at !== saved.createdAt || (versions.get(saved.accountId) || 0) !== saved.version) return null;
    let row = id(saved.messageId) ? store.messageById(saved.messageId, { headersOnly: true }) : null;
    if (row?.account_id !== account.id) row = null;
    // Gmail label copies can be retired by a move. Resolve by the stored
    // provider identity only within this same account; never by an RFC header.
    if (!row && saved.gmailId) row = store.gmailCopies(account.id, saved.gmailId, { headersOnly: true }).find(item => {
      const folder = store.folderByPath(account.id, item.folder_path);
      return folder && !["deleteditems", "junkemail", "drafts"].includes(folder.well_known);
    });
    const folder = row && store.folderByPath(account.id, row.folder_path);
    if (row && folder && !row.is_draft && !["deleteditems", "junkemail", "drafts"].includes(folder.well_known)) {
      return { accountId: account.id, folderId: folder.path, messageId: row.id };
    }
    const inbox = store.folderByWellKnown(account.id, "inbox");
    return inbox ? { accountId: account.id, folderId: inbox.path, messageId: null } : null;
  }
  function takeTarget() { const saved = target; target = null; return resolve(saved); }
  function clearActive(accountId) {
    for (const entry of active) {
      if (accountId && !entry.accounts.has(accountId)) continue;
      entry.valid = false;
      try { entry.notice.close(); } catch { /* native dismissal is best effort */ }
      active.delete(entry);
    }
  }
  function invalidate(accountId) {
    boundaries.set(accountId, now());
    versions.set(accountId, (versions.get(accountId) || 0) + 1);
    for (const [key, row] of pending) if (row.accountId === accountId) pending.delete(key);
    if (target?.accountId === accountId) target = null;
    clearActive(accountId);
  }
  function settingsChanged() {
    pending.clear(); target = null;
    if (timer) clearTimer(timer);
    timer = null;
    // Prevent re-enabling from replaying events accumulated while disabled.
    settingsBoundary = now();
    clearActive();
  }
  function schedule() {
    if (timer || !pending.size) return;
    timer = setTimer(() => {
      timer = null;
      try { flush(); } catch { halted = true; pending.clear(); }
    }, Math.max(BATCH_MS, lastAttempt + INTERVAL_MS - now()));
    timer?.unref?.();
  }
  function enqueue(account, rows) {
    if (!native || stopped || halted || !id(account?.id)) return;
    try {
      if (!prefs().enabled) return;
      const current = store.accountById(account.id);
      if (!current || current.created_at !== account.created_at) return;
      const saved = state(account.id), known = new Set(saved.seen.map(row => row[0]));
      const accepted = [];
      for (const item of rows) {
        const time = Number(item.receivedAt);
        if (!id(item.messageId) || !id(item.identity) || !Number.isFinite(time)
          || time < Math.max(startedAt, settingsBoundary, boundaries.get(account.id) || 0, now() - RECENT_MS) || time > now() + 60000
          || time <= saved.before) continue;
        const key = digest(item.identity);
        if (known.has(key)) continue;
        const row = store.messageById(item.messageId, { headersOnly: true }), folder = row && store.folderByPath(account.id, row.folder_path);
        if (!row || row.account_id !== account.id || folder?.well_known !== "inbox" || row.is_draft || row.draft_pending || !row.unread) continue;
        // The sender's Date is not delivery evidence. Delayed and undated mail
        // can be genuinely new at the server; only receivedAt gates freshness.
        known.add(key); saved.seen.push([key, time]);
        accepted.push({ accountId: account.id, createdAt: account.created_at, version: versions.get(account.id) || 0,
          messageId: row.id, gmailId: row.gmail_id || null, receivedAt: time, key });
      }
      if (!accepted.length) return;
      const evicted = saved.seen.splice(0, Math.max(0, saved.seen.length - MAX_SEEN));
      for (const [, time] of evicted) saved.before = Math.max(saved.before, time);
      // Reserve durably BEFORE native show. Crashes, denied permission, DND and
      // failed/uncertain show never cause replay; this is at-most-once attempt.
      store.notificationState(account.id, saved);
      for (const entry of accepted) if (pending.size < MAX_PENDING) pending.set(`${account.id}:${entry.key}`, entry);
      schedule();
    } catch {
      halted = true; pending.clear();
    }
  }
  function flush() {
    const batch = [...pending.values()]; pending.clear();
    if (stopped || halted || !prefs().enabled || !supported() || !batch.length) return;
    const live = batch.filter(entry => {
      if (entry.receivedAt < now() - RECENT_MS) return false;
      const value = resolve(entry), row = value?.messageId && store.messageById(value.messageId, { headersOnly: true });
      return row?.unread && store.folderByPath(entry.accountId, row.folder_path)?.well_known === "inbox";
    });
    if (!live.length) return;
    live.sort((a, b) => b.receivedAt - a.receivedAt);
    const selected = live[0], accounts = new Set(live.map(row => row.accountId));
    const row = store.messageById(resolve(selected).messageId, { headersOnly: true });
    const preview = prefs().preview;
    const options = { title: "Morrow Mail", body: live.length === 1 ? "You have a new email." : `${live.length} new emails${accounts.size > 1 ? ` across ${accounts.size} mailboxes` : ""}.`,
      silent: false, urgency: "normal", timeoutType: "default", ...(icon ? { icon } : {}) };
    if (live.length === 1 && preview === "sender") options.body = `New email from ${text(row.from_addr, 150) || "a sender"}.`;
    if (live.length === 1 && preview === "message") {
      options.title = text(row.from_addr, 70) || "New email";
      options.body = [text(row.subject, 90) || "(No subject)", text(row.snippet, 70)].filter(Boolean).join(" — ");
    }
    // Retain a small number of native objects for reliable click callbacks.
    while (active.size >= 8) {
      const oldest = active.values().next().value; oldest.valid = false;
      try { oldest.notice.close(); } catch { /* best effort */ } active.delete(oldest);
    }
    lastAttempt = now();
    let entry;
    try {
      const notice = new native(options);
      entry = { notice, accounts, valid: true };
      active.add(entry);
      notice.on("click", () => {
        try {
          if (stopped || !entry.valid || !prefs().enabled || !resolve(selected)) return;
          entry.valid = false;
          target = selected;
          Promise.resolve().then(() => open?.()).catch(() => { if (target === selected) target = null; });
        } catch { /* a notification click cannot interrupt mail/quit recovery */ }
      });
      notice.on("failed", () => { failed = true; entry.valid = false; active.delete(entry); });
      // Windows can close the banner while retaining a clickable Action Center
      // item. Keep these objects until bounded eviction/settings/account cleanup.
      notice.on("show", () => { failed = false; });
      notice.show();
    } catch { failed = true; if (entry) { entry.valid = false; active.delete(entry); } }
  }
  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null; pending.clear(); target = null; clearActive();
  }
  return { configure, enqueue, status, invalidate, settingsChanged, takeTarget, stop };
}

const notifications = createNotifications();
module.exports = { ...notifications, createNotifications, MAX_SEEN, MAX_PENDING, BATCH_MS, INTERVAL_MS };
