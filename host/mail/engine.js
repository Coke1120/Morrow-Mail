const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const presets = require("./presets");
const remote = require("./remote");

const secrets = process.env.MORROW_MAIL_SECRETS === "memory"
  ? require("./memory-secrets")
  : require("./secrets");
const oauth = require("./oauth");
const oauthConfig = require("./oauth-config");
const sidecar = require("./sidecar");
const inboxRules = require("./inbox-rules");
const http = require("./provider-http");
const providerApi = require("./provider-api");
const idle = require("./idle");
const debugLog = require("../debug-log");

const PRIMARY_ORDER = ["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"];
// Not an IMAP mailbox. List queries with this id return starred rows for one account.
const STARRED_FOLDER_ID = "__morrow_starred__";
const KEY_TO_WELL = {
  inbox: "inbox",
  drafts: "drafts",
  sent: "sentitems",
  trash: "deleteditems",
  archive: "archive",
  spam: "junkemail",
};
const SNOOZE_MAX_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Download bound. Mail older than this stays on the server.
// A folder records sync_horizon_days when the bound is finished, so raising
// SYNC_DAYS catches up in place and leaves mail already in mail.sqlite.
const SYNC_DAYS = 180;
const HEADER_BATCH = 100;
const OUTLOOK_BATCH = 50;
const REFRESH_PAGES = [20, 30, 30];
const PAGE_DELAY_MS = 200;
const MAX_PAGES = 50;
const TICK_MS = 25000;
const RATE_LIMIT_MS = 30000;
const STORM_MS = 15 * 60 * 1000;
const POLL_MS = 45000;
// Due mail is sent on this interval while the process is running.
// A sendAt that passes while the app is closed is sent the next time the app is open.
const SCHEDULE_TICK_MS = 15000;
const SEARCH_LIMIT = 100;
const GMAIL_ALL = ["[Gmail]/All Mail", "[Google Mail]/All Mail"];

let ready = false;
const tails = new Map();

function ok(data) {
  return { success: true, data };
}

function fail(code, message) {
  return { success: false, error: { code, message, status: 0, retryable: false } };
}

function dataFile() {
  const override = (process.env.MORROW_MAIL_DIR || "").trim();
  if (override) return path.join(override, "mail.sqlite");
  let dir = "";
  try {
    const { app } = require("electron");
    if (app && app.isReady()) dir = app.getPath("userData");
  } catch {
    dir = "";
  }
  if (!dir) dir = require("../paths").userDataDir();
  return path.join(dir, "mail.sqlite");
}

async function init() {
  await db.open(dataFile());
  ready = true;
  markMissingOAuthSecrets();
}

function exclusive(accountId, fn) {
  // Every call site enters once. A concurrent IPC/sync request is not a nested
  // call and must wait for the preceding operation on this account.
  const prev = tails.get(accountId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  tails.set(accountId, run.catch(() => {}));
  return run;
}

function broadcast(channel, payload) {
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  } catch {
    // IPC can run before a window exists, including the offline self-test.
  }
}

function accountViews() {
  return db.listAccountRows().map((row, index) => accountView(row, index));
}

function starredMailbox(accountId) {
  return {
    id: STARRED_FOLDER_ID,
    name: "Starred",
    wellKnownName: "starred",
    unreadCount: 0,
    totalCount: db.countMessages({ accountId, filterFlagged: true }),
    type: "virtual",
    children: [],
  };
}

function placeStarred(primary, accountId) {
  const view = starredMailbox(accountId);
  for (const name of ["drafts", "sentitems", "inbox"]) {
    const index = primary.findIndex((folder) => folder.wellKnownName === name);
    if (index >= 0) {
      primary.splice(index + 1, 0, view);
      return;
    }
  }
  primary.unshift(view);
}

function accountView(row, index) {
  const folders = db.foldersFor(row.id);
  const primary = [];
  const more = [];
  for (const folder of folders) {
    const view = {
      id: folder.path,
      name: folder.name,
      wellKnownName: folder.well_known,
      unreadCount: folder.unread || 0,
      totalCount: folder.total || 0,
      type: folder.well_known ? "system" : "user",
      children: [],
    };
    if (folder.well_known && PRIMARY_ORDER.includes(folder.well_known)) primary.push(view);
    else more.push(view);
  }
  primary.sort((a, b) => PRIMARY_ORDER.indexOf(a.wellKnownName) - PRIMARY_ORDER.indexOf(b.wellKnownName));
  placeStarred(primary, row.id);
  const view = {
    id: row.id,
    email: row.email,
    displayEmail: row.email,
    preferredFromAddress: row.email,
    senderName: row.display_name || null,
    defaultSenderName: row.display_name || null,
    sendAs: [{ email: row.email, name: row.display_name || null, isDefault: true }],
    name: row.display_name || null,
    platform: "imap",
    needsReauth: !!row.auth_error,
    reauthReason: row.auth_error || null,
    reauthDetectedAt: row.auth_error ? row.created_at : null,
    suspended: false,
    isConnected: !row.auth_error,
    isDefault: index === 0,
    unreadCount: db.inboxUnread(row.id),
    promoSignatureEnabled: false,
    folders: { primary, more },
    groups: [],
    imapSmtpProfile: row.profile,
    delimiter: row.delimiter || "/",
    imapUsername: row.username,
    authKind: row.auth_kind || "password",
    push: idlePush(row.id),
  };
  if (row.profile === "custom") {
    view.imapSmtpCustom = {
      imap: { host: row.imap_host, port: row.imap_port, tls: row.imap_tls === 1 },
      smtp: { host: row.smtp_host, port: row.smtp_port, tls: row.smtp_tls === 1 },
    };
  }
  return view;
}

function emitAccounts(extra) {
  broadcast("mail:accountsUpdated", { source: "server", accounts: accountViews(), ...(extra || {}) });
  broadcast("mail:emailsUpdated", { accountId: null, folderId: null, folderIds: null });
}

function publicAttachment(item) {
  return {
    id: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size || 0,
    contentId: item.contentId || null,
    isInlineFromApi: item.isInlineFromApi === true,
  };
}

function listRow(row) {
  const attachments = db.jsonList(row.attachments_json).map(publicAttachment);
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    conversationId: row.thread_id,
    folderId: row.folder_path,
    folders: [row.folder_path],
    subject: row.subject || "",
    snippet: row.snippet || "",
    from: row.from_addr || "",
    to: db.jsonList(row.to_json),
    cc: db.jsonList(row.cc_json),
    bcc: db.jsonList(row.bcc_json),
    date: row.date_iso,
    listSortTs: row.list_sort_ts,
    unread: row.unread === 1,
    isRead: row.unread !== 1,
    isStarred: row.starred === 1,
    isDraft: row.is_draft === 1,
    hasAttachments: row.has_attachments === 1,
    unifiedCategory: "primary",
    providerCategory: "primary",
    platform: "imap",
    attachments,
    messageId: row.rfc_message_id || null,
    inReplyTo: row.in_reply_to || null,
  };
}

function detailOf(row) {
  return { ...listRow(row), htmlBody: row.html_body || null, textBody: row.text_body || null };
}

function threadMeta(rows) {
  const threads = {};
  for (const email of rows) {
    const bucket = threads[email.threadId] || { messageCount: 0, unreadCount: 0, hasDraft: false };
    bucket.messageCount += 1;
    if (email.unread) bucket.unreadCount += 1;
    if (email.isDraft) bucket.hasDraft = true;
    threads[email.threadId] = bucket;
  }
  return threads;
}

function queryFrom(params) {
  const query = params || {};
  const out = {
    accountId: query.accountId || null,
    folderId: query.folderId || null,
    folderKey: query.folderKey || null,
    category: query.category || "all",
    filterUnread: query.filterUnread === true,
    filterFlagged: query.filterFlagged === true,
    filterAttachments: query.filterAttachments,
    limit: query.limit,
    offset: query.offset,
  };
  if (out.folderId === STARRED_FOLDER_ID) {
    out.filterFlagged = true;
    out.folderId = null;
  } else if (!out.folderKey && out.folderId && !out.accountId && KEY_TO_WELL[out.folderId]) {
    out.folderKey = out.folderId;
    out.folderId = null;
  }
  if (query.beforeDate) {
    const ts = Date.parse(query.beforeDate);
    if (Number.isFinite(ts)) out.beforeTs = ts;
  }
  return out;
}

function windowOpen(folder) {
  if (!folder || Number(folder.window_done) !== 1) return false;
  const horizon = Number(folder.sync_horizon_days);
  return Number.isFinite(horizon) && horizon >= SYNC_DAYS;
}

function serverHasMore(query) {
  const folders = query.folderKey
    ? db.pathsForKey(query.accountId, query.folderKey).map((entry) => db.folderByPath(entry.account_id, entry.path))
    : (query.accountId && query.folderId ? [db.folderByPath(query.accountId, query.folderId)] : []);
  return folders.some((folder) => folder && !windowOpen(folder));
}

function synced(query) {
  const folders = query.folderKey
    ? db.pathsForKey(query.accountId, query.folderKey).map((entry) => db.folderByPath(entry.account_id, entry.path))
    : (query.accountId && query.folderId ? [db.folderByPath(query.accountId, query.folderId)] : []);
  if (!folders.length) return true;
  return folders.every((folder) => windowOpen(folder));
}

function listPayload(params) {
  const query = queryFrom(params);
  const rows = db.selectMessages(query).map(listRow);
  const total = db.countMessages(query);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const oldest = db.oldestTs(query);
  const moreInCache = offset + rows.length < total;
  const more = moreInCache || serverHasMore(query);
  return {
    emails: rows,
    threads: threadMeta(rows),
    hasMore: more,
    hasMoreBelow: more,
    truncated: false,
    total,
    syncedOldestDateTs: oldest,
    initialSyncDone: synced(query),
    pageToken: more ? String(oldest || offset) : null,
    geometry: { total, aboveTop: offset },
  };
}

async function secretFor(account) {
  const stored = secrets.getPassword(account.id);
  if (!stored) {
    const error = new Error("The password for this account is not in the keychain. Connect the account again.");
    error.code = "auth";
    throw error;
  }
  if (account.auth_kind !== "oauth2") return stored;
  const result = await oauth.accessTokenFor(account, stored);
  if (secrets.getPassword(account.id) !== stored) {
    const error = new Error("This mailbox connection changed. Try again with the current connection.");
    error.code = "conflict";
    throw error;
  }
  if (typeof result === "string") return result;
  if (result && result.store) {
    try { secrets.setPassword(account.id, result.store); } catch { /* best effort */ }
    return result.token;
  }
  throw new Error("Could not refresh OAuth access token.");
}

/** @deprecated sync callers — use secretFor */
function passwordFor(account) {
  if (account.auth_kind === "oauth2") {
    const error = new Error("OAuth accounts need async secretFor()");
    error.code = "auth";
    throw error;
  }
  const password = secrets.getPassword(account.id);
  if (!password) {
    const error = new Error("The password for this account is not in the keychain. Connect the account again.");
    error.code = "auth";
    throw error;
  }
  return password;
}

function rememberSync(accountId, patch) {
  if (!accountId) return;
  try { require("../bot/observe").note(accountId, patch); } catch { /* the bridge is optional */ }
}

function emitFolderSync(accountId, folderPath, okFlag) {
  broadcast("mail:folderSyncCompleted", {
    accountId,
    folderId: folderPath,
    ok: okFlag === true,
    newThreadCount: 0,
  });
  const now = new Date().toISOString();
  const patch = { syncState: okFlag ? "idle" : "error", lastObservedAt: now, providerConnection: "unknown" };
  if (okFlag) patch.lastSuccessfulSyncAt = now;
  rememberSync(accountId, patch);
}

const activeFolder = new Map();
const syncGates = new Map();
const syncScopes = new Map();
let syncState = {
  state: "idle",
  phase: "idle",
  message: "Not synced yet",
  accountId: null,
  accountLabel: "",
  folderId: null,
  folderLabel: "",
  updatedAt: 0,
  lastSuccessAt: null,
  lastError: "",
  lastErrorAt: null,
};

function syncLabels(extra) {
  const accountId = (extra && extra.accountId) || null;
  const folderId = (extra && extra.folderId) || null;
  let accountLabel = (extra && extra.accountLabel) || "";
  let folderLabel = (extra && extra.folderLabel) || "";
  try {
    if (!accountLabel && accountId) {
      const account = db.accountById(accountId);
      if (account) accountLabel = account.email || account.display_name || "";
    }
    if (folderId === STARRED_FOLDER_ID) {
      if (!folderLabel) folderLabel = "Starred";
    } else if (accountId && folderId) {
      const folder = db.folderByPath(accountId, folderId);
      if (!folderLabel && folder && folder.name) folderLabel = folder.name;
      else if (!folderLabel) folderLabel = String(folderId);
    }
  } catch {
    // A missing mailbox still reports the phase.
  }
  return {
    accountId,
    accountLabel: accountLabel || "",
    folderId,
    folderLabel: folderLabel || "",
  };
}

function emitSync(state, extra) {
  const now = Date.now();
  const scopeKey = JSON.stringify([(extra && extra.accountId) || "", (extra && extra.folderId) || ""]);
  const prev = syncScopes.get(scopeKey) || {};
  const message = debugLog.redactDebugText((extra && extra.message) || (
    state === "syncing" ? "Syncing…"
      : state === "paused" ? "Paused for rate limit"
        : state === "done" ? "Sync done"
          : "Sync failed"
  ));
  const place = syncLabels(extra);
  const phase = (extra && extra.phase) || (
    state === "syncing" ? "fetching"
      : state === "paused" ? "paused"
        : state === "error" ? "error"
          : "done"
  );
  syncState = {
    state,
    phase,
    message,
    accountId: place.accountId,
    accountLabel: place.accountLabel,
    folderId: place.folderId,
    folderLabel: place.folderLabel,
    updatedAt: now,
    lastSuccessAt: state === "done" && place.accountId && place.folderId ? now : (prev.lastSuccessAt || null),
    lastError: state === "error" ? message : (prev.lastError || ""),
    lastErrorAt: state === "error" ? now : (prev.lastErrorAt || null),
  };
  syncScopes.set(scopeKey, syncState);
  debugLog.note("sync", [state, phase, place.accountLabel, place.folderLabel, message].filter(Boolean).join(" · "));
  broadcast("mail:syncStatus", syncState);
  const accountId = syncState.accountId;
  if (!accountId) return;
  const gate = syncGates.get(accountId);
  rememberSync(accountId, {
    syncState: state === "paused" ? "paused" : state === "syncing" ? "syncing" : state === "done" ? "idle" : "error",
    lastObservedAt: new Date().toISOString(),
    pausedUntil: state === "paused" && gate ? new Date(gate.until).toISOString() : null,
    providerConnection: "unknown",
  });
}

function publicSync(params) {
  if (!db.listAccountRows().length) return { state: "idle", message: "No account connected", lastSuccessAt: null };
  const accountId = params && params.accountId;
  const folderId = params && params.folderId;
  if (folderId === STARRED_FOLDER_ID) {
    return {
      ...syncLabels(params),
      state: "idle",
      phase: "idle",
      message: "Starred uses messages already downloaded",
      lastSuccessAt: null,
      lastError: "",
    };
  }
  if (!accountId || !folderId) return { ...syncState };
  const saved = syncScopes.get(JSON.stringify([accountId, folderId]));
  const gate = syncGates.get(accountId);
  if (gate && gate.until > Date.now()) return { ...(saved || {}), ...syncLabels(params), state: "paused", message: "Paused by the provider", retryAt: gate.until };
  if (saved) return { ...saved };
  const folder = db.folderByPath(accountId, folderId);
  const lastSuccessAt = folder && windowOpen(folder) ? folder.synced_at : null;
  return { ...syncLabels(params), state: lastSuccessAt ? "done" : "idle", lastSuccessAt,
    message: lastSuccessAt ? "Folder checked" : "Not synced yet" };
}

function noteActive(accountId, folderId) {
  if (accountId && folderId) activeFolder.set(accountId, folderId);
}

function batchSize(account) {
  return account && account.profile === "outlook" ? OUTLOOK_BATCH : HEADER_BATCH;
}

function maxUid(uids, floor = 0) {
  let cursor = floor;
  for (const uid of uids || []) if (uid > cursor) cursor = uid;
  return cursor;
}

function windowStart(now) {
  return (Number.isFinite(now) ? now : Date.now()) - SYNC_DAYS * DAY_MS;
}

function pageDelayMs() {
  const raw = process.env.MORROW_PAGE_DELAY_MS;
  if (raw != null && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return PAGE_DELAY_MS;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gateOpen(accountId) {
  const row = syncGates.get(accountId);
  return !row || row.until <= Date.now();
}

function idlePush(accountId) {
  if (!idleController || !idleController.healthy(accountId)) return "polling";
  return "push";
}

function pauseIdle(accountId) {
  if (idleController) idleController.notePause(accountId);
}

function noteRateLimit(accountId, error) {
  const row = syncGates.get(accountId) || { until: 0, strikes: 0 };
  row.strikes += 1;
  const hinted = http.retryAfterMs(error);
  const wait = row.strikes >= 3 ? STORM_MS : (hinted == null ? RATE_LIMIT_MS : hinted);
  row.until = Date.now() + wait;
  syncGates.set(accountId, row);
  emitSync("paused", { accountId, message: "Paused for rate limit" });
  pauseIdle(accountId);
  return row;
}

function noteStorm(accountId) {
  syncGates.set(accountId, { until: Date.now() + STORM_MS, strikes: 3 });
  emitSync("paused", { accountId, message: "Paused after a mailbox reset" });
  pauseIdle(accountId);
}

function clearStrikes(accountId) {
  const row = syncGates.get(accountId);
  if (row) row.strikes = 0;
}

function localInboxRules(account) {
  return inboxRules.backendFor(account) === "imap";
}

function resetWindow(accountId, folderPath, found) {
  const folder = db.folderByPath(accountId, folderPath);
  db.applyFolderSync(accountId, folderPath, {
    messages: [],
    validity: found.validity,
    exists: found.exists,
    unseen: found.unseen,
    windowDone: false,
    horizonDays: null,
    uidCursor: 0,
  });
  if (folder && folder.well_known === "inbox") db.resetInboxRuleWatermarks(accountId);
}

async function bootstrapFolder(client, account, folderPath, started) {
  const since = new Date(windowStart());
  const size = batchSize(account);
  let pages = 0;
  while (pages < MAX_PAGES && Date.now() - started < TICK_MS) {
    const found = await remote.searchUids(client, folderPath, { since });
    const folder = db.folderByPath(account.id, folderPath);
    if (folder && folder.uid_validity && found.validity && folder.uid_validity !== found.validity) {
      resetWindow(account.id, folderPath, found);
      noteStorm(account.id);
      return { paused: true, bootstrapped: false };
    }
    const have = new Set(db.uidsFor(account.id, folderPath));
    const missing = found.uids.filter((uid) => !have.has(uid)).sort((a, b) => b - a);
    const cursor = maxUid(found.uids);
    if (!missing.length) {
      db.applyFolderSync(account.id, folderPath, {
        messages: [],
        validity: found.validity,
        exists: found.exists,
        unseen: found.unseen,
        uids: found.uids,
        retainOlderThan: windowStart(),
        windowDone: true,
        horizonDays: SYNC_DAYS,
        uidCursor: cursor,
      });
      return { paused: false, bootstrapped: true };
    }
    if (pages > 0) await sleep(pageDelayMs());
    const page = missing.slice(0, size);
    const fetched = await remote.fetchMessages(client, folderPath, page);
    if (fetched.validity && found.validity && fetched.validity !== found.validity) {
      resetWindow(account.id, folderPath, fetched);
      noteStorm(account.id);
      return { paused: true, bootstrapped: false };
    }
    const highest = Math.max(Number(folder && folder.uid_cursor) || 0, ...page);
    const finished = missing.length <= size;
    db.applyFolderSync(account.id, folderPath, {
      messages: fetched.messages,
      validity: fetched.validity || found.validity,
      exists: found.exists,
      unseen: found.unseen,
      uids: found.uids,
      retainOlderThan: windowStart(),
      windowDone: finished,
      ...(finished ? { horizonDays: SYNC_DAYS } : {}),
      uidCursor: finished ? cursor : highest,
    });
    emitFolderSync(account.id, folderPath, true);
    broadcast("mail:emailsUpdated", { accountId: account.id, folderId: folderPath, folderIds: [folderPath] });
    pages += 1;
    if (missing.length <= size) return { paused: false, bootstrapped: true };
  }
  return { paused: false, bootstrapped: false };
}

async function warmFolder(client, account, folder, started) {
  let next = Number(folder.uid_cursor) || 0;
  const since = new Date(windowStart());
  for (let index = 0; index < REFRESH_PAGES.length; index += 1) {
    if (Date.now() - started >= TICK_MS) break;
    const found = await remote.searchUids(client, folder.path, { uid: `${next + 1}:*`, since });
    if (folder.uid_validity && found.validity && folder.uid_validity !== found.validity) {
      resetWindow(account.id, folder.path, found);
      noteStorm(account.id);
      return { paused: true, bootstrapped: false };
    }
    const fresh = found.uids.filter((uid) => uid > next).sort((a, b) => a - b);
    if (!fresh.length) break;
    if (index > 0) await sleep(pageDelayMs());
    const page = fresh.slice(0, REFRESH_PAGES[index]);
    const fetched = await remote.fetchMessages(client, folder.path, page);
    next = Math.max(next, ...page);
    db.applyFolderSync(account.id, folder.path, {
      messages: fetched.messages,
      validity: fetched.validity || found.validity,
      keepOthers: true,
      uidCursor: next,
    });
    if (folder.well_known === "inbox" && localInboxRules(account)) {
      emitSync("syncing", { accountId: account.id, folderId: folder.path, phase: "rules" });
      const ruled = await inboxRules.runImapPlan({
        client,
        remote,
        db,
        account,
        folder,
        messages: fetched.messages,
        validity: fetched.validity || found.validity,
      });
      if (ruled.failed) {
        emitSync("error", {
          accountId: account.id,
          folderId: folder.path,
          phase: "rules",
          message: "An inbox rule could not run.",
        });
      }
    }
    broadcast("mail:emailsUpdated", { accountId: account.id, folderId: folder.path, folderIds: [folder.path] });
    if (fresh.length <= REFRESH_PAGES[index]) break;
  }
  const live = await remote.searchUids(client, folder.path, { since });
  if (folder.uid_validity && live.validity && folder.uid_validity !== live.validity) {
    resetWindow(account.id, folder.path, live);
    noteStorm(account.id);
    return { paused: true, bootstrapped: false };
  }
  db.pruneMissing(account.id, folder.path, live.uids, windowStart());
  db.applyFolderSync(account.id, folder.path, {
    messages: [],
    validity: live.validity,
    exists: live.exists,
    unseen: live.unseen,
    uids: live.uids,
    retainOlderThan: windowStart(),
    windowDone: true,
    horizonDays: SYNC_DAYS,
    uidCursor: next,
  });
  return { paused: false, bootstrapped: true };
}

async function syncFolderPolicy(client, account, folderPath) {
  if (!gateOpen(account.id)) {
    emitSync("paused", { accountId: account.id, folderId: folderPath, message: "Paused for rate limit" });
    return { paused: true, bootstrapped: false };
  }
  let phase = "fetching";
  try {
    const known = db.folderByPath(account.id, folderPath);
    if (known && windowOpen(known)) phase = "refreshing";
  } catch {
    phase = "fetching";
  }
  emitSync("syncing", { accountId: account.id, folderId: folderPath, phase });
  const started = Date.now();
  try {
    const folder = db.folderByPath(account.id, folderPath);
    const result = folder && windowOpen(folder)
      ? await warmFolder(client, account, folder, started)
      : await bootstrapFolder(client, account, folderPath, started);
    if (!result.paused) clearStrikes(account.id);
    if (!result.paused && result.bootstrapped) emitSync("done", { accountId: account.id, folderId: folderPath });
    return result;
  } catch (error) {
    if (http.isRateLimit(error)) {
      noteRateLimit(account.id, error);
      return { paused: true, bootstrapped: false };
    }
    emitSync("error", { accountId: account.id, folderId: folderPath, message: remote.explain(error) });
    emitFolderSync(account.id, folderPath, false);
    if (error && typeof error === "object") error.syncReported = true;
    throw error;
  }
}

function finishSync(jobs, paused, allDone, accountId) {
  if (paused || !jobs.length) return;
  if (allDone) emitSync("done", { accountId });
}

async function syncFolderPath(account, folderPath) {
  return exclusive(account.id, async () => {
    const password = await secretFor(account);
    const result = await remote.withClient(account, password, (client) => syncFolderPolicy(client, account, folderPath));
    finishSync([folderPath], result && result.paused, result && result.bootstrapped, account.id);
    return result;
  });
}

function jobFolders(folders, options, accountId) {
  const inbox = folders.find((folder) => folder.well_known === "inbox");
  if (options && options.background) {
    const jobs = [];
    if (inbox) jobs.push(inbox);
    const activePath = activeFolder.get(accountId);
    const extra = activePath && folders.find((folder) => folder.path === activePath);
    if (extra && extra !== inbox) jobs.push(extra);
    return jobs;
  }
  const jobs = [];
  const inboxWanted = !options
    || options.folderKey === "inbox"
    || (!options.folderKey && !options.onlyPath)
    || (options.onlyPath && inbox && options.onlyPath === inbox.path);
  if (inbox && inboxWanted) jobs.push(inbox);
  if (!options || !options.onlyInbox) {
    for (const folder of folders) {
      if (folder === inbox) continue;
      if (options && options.folderKey && KEY_TO_WELL[options.folderKey] !== folder.well_known) continue;
      if (options && options.onlyPath && options.onlyPath !== folder.path) continue;
      jobs.push(folder);
    }
  }
  return jobs;
}

async function syncAccount(account, options) {
  if (!gateOpen(account.id)) {
    emitSync("paused", { accountId: account.id, message: "Paused for rate limit" });
    return;
  }
  const password = await secretFor(account);
  await exclusive(account.id, async () => {
    let jobs = [];
    let paused = false;
    let allDone = true;
    await remote.withClient(account, password, async (client) => {
      emitSync("syncing", { accountId: account.id, phase: "listing" });
      const listed = await remote.listFolderRecords(client);
      db.replaceFolders(account.id, listed.folders, listed.delimiter);
      const folders = db.foldersFor(account.id);
      jobs = jobFolders(folders, options, account.id);
      for (const folder of jobs) {
        const result = await syncFolderPolicy(client, account, folder.path);
        if (result && result.paused) {
          paused = true;
          break;
        }
        if (!result || !result.bootstrapped) allDone = false;
      }
    });
    finishSync(jobs, paused, allDone, account.id);
    if (!paused) db.clearAuthError(account.id);
  });
}

async function syncAll(options) {
  const scope = options && (options.folderKey || options.onlyPath || options.onlyInbox || options.background)
    ? options
    : { background: true };
  const accounts = db.listAccountRows();
  for (const account of accounts) {
    const pushed = !!(idleController && idleController.healthy(account.id));
    if (scope.background && !idle.backgroundPollDue(
      pushed,
      idleSafetyAt.get(account.id) || 0,
      Date.now(),
      idle.IDLE_SAFETY_POLL_MS,
    )) continue;
    if (pushed) idleSafetyAt.set(account.id, Date.now());
    try {
      await syncAccount(account, scope);
    } catch (error) {
      if (http.isRateLimit(error)) {
        noteRateLimit(account.id, error);
        continue;
      }
      const message = remote.explain(error, secrets.getPassword(account.id));
      if (/password|keychain|rejected the password/i.test(message)) db.setAuthError(account.id, message);
      else if (syncState.state !== "paused") emitSync("error", { accountId: account.id, message });
    }
  }
  emitAccounts();
}

let pollTimer = null;
let scheduleTimer = null;
let syncing = false;
let pumping = false;
let oauthGeneration = 0;
const oauthCommitted = new Set();
let idleController = null;
const idleSafetyAt = new Map();
const idleReported = new Map();

function onIdleStatus(accountId, mode) {
  if (mode === "push") idleSafetyAt.set(accountId, Date.now());
  if (idleReported.get(accountId) === mode) return;
  idleReported.set(accountId, mode);
  if (ready) emitAccounts();
}

function ensureIdle() {
  if (idleController) return idleController;
  idleController = idle.createIdleController({
    listAccounts: () => db.listAccountRows(),
    secretFor,
    openClient: (account, secret) => remote.openIdleClient(account, secret),
    syncFolder: async (account, folderPath) => {
      const row = db.accountById(account.id);
      if (!row) return null;
      try {
        return await syncFolderPath(row, folderPath);
      } catch (error) {
        if (http.isRateLimit(error)) throw error;
        if (!error || !error.syncReported) {
          emitSync("error", { accountId: row.id, folderId: folderPath, message: remote.explain(error) });
        }
        return null;
      }
    },
    gateUntil: (accountId) => {
      const row = syncGates.get(accountId);
      return row && row.until > Date.now() ? row.until : 0;
    },
    inboxPath: (account) => {
      const inbox = db.folderByWellKnown(account.id, "inbox");
      return (inbox && inbox.path) || "INBOX";
    },
    onRateLimit: (accountId, error) => noteRateLimit(accountId, error),
    onStatus: onIdleStatus,
    isRateLimit: (error) => http.isRateLimit(error),
  });
  return idleController;
}

function watchIdle() {
  if (!idleController) return;
  idleController.syncAccounts().catch(() => {});
}

function idleSleep() {
  if (idleController) idleController.sleep();
}

function idleWake() {
  if (idleController && idleController.wake) idleController.wake();
}

function idleOffline() {
  if (idleController) idleController.offline();
}

function idleOnline() {
  if (idleController && idleController.online) idleController.online();
}

async function stopIdle() {
  if (!idleController) return;
  const controller = idleController;
  idleController = null;
  idleReported.clear();
  await controller.stop();
}

function markMissingOAuthSecrets() {
  if (!ready) return false;
  let changed = false;
  for (const row of db.listAccountRows()) {
    if (row.auth_kind !== "oauth2") continue;
    let secret = null;
    try {
      secret = secrets.getPassword(row.id);
    } catch (error) {
      // A just-saved mailbox stays connected if the key store read fails.
      if (oauthCommitted.has(row.id)) continue;
      throw error;
    }
    if (secret) continue;
    // A purged or unavailable key store is not evidence of abandoned sign-in.
    // New OAuth accounts are inserted only after authentication succeeds.
    // Keep local mail and purpose-specific grants so re-login can reuse the id.
    if (row.auth_error) continue;
    db.setAuthError(row.id, "Mailbox credentials are unavailable. Sign in again to reconnect. Local mail is retained.");
    changed = true;
  }
  return changed;
}

function cancelOAuth() {
  oauthGeneration += 1;
  try { oauth.cancelActive(); } catch { /* no browser flow is waiting */ }
  if (markMissingOAuthSecrets()) emitAccounts();
  return ok({ canceled: true });
}

function startBackgroundSync() {
  if (!ready) return;
  const tick = () => {
    if (syncing || !db.hasAccounts()) return;
    syncing = true;
    syncAll({ background: true }).catch(() => {}).finally(() => {
      syncing = false;
    });
  };
  setTimeout(tick, 400);
  if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
  startSchedulePump();
  ensureIdle().start().catch(() => {});
}

function startSchedulePump() {
  if (scheduleTimer) return;
  const tick = () => { pumpScheduled().catch(() => {}); };
  setTimeout(tick, 800);
  scheduleTimer = setInterval(tick, SCHEDULE_TICK_MS);
}


function finishOAuthPage(signed, okFlag, message) {
  if (!signed || typeof signed.complete !== "function") return;
  try { signed.complete({ ok: okFlag === true, message: message || "" }); } catch { /* the browser already left */ }
}

function noteOAuthSyncFailure(id, error, secret) {
  if (http.isRateLimit(error)) {
    noteRateLimit(id, error);
    return;
  }
  const message = remote.explain(error, secret);
  if (/password|keychain|rejected/i.test(message)) db.setAuthError(id, message);
}

async function settleOAuthMailbox(id) {
  const row = db.accountById(id);
  if (!row) return;
  let token = "";
  try {
    token = await secretFor(row);
  } catch (error) {
    noteOAuthSyncFailure(id, error, "");
    emitAccounts();
    return;
  }
  try {
    await remote.withClient(row, token, async (client) => {
      const listed = await remote.listFolderRecords(client);
      db.replaceFolders(id, listed.folders || [], listed.delimiter || "/");
    });
  } catch (error) {
    noteOAuthSyncFailure(id, error, token);
  }
  try {
    const current = db.accountById(id);
    if (current) await remote.verifySmtp(current, token);
  } catch (error) {
    const message = remote.explain(error, token);
    if (/rejected/i.test(message)) db.setAuthError(id, message);
  }
  const account = db.accountById(id);
  if (!account) return;
  const inbox = db.folderByWellKnown(id, "inbox");
  if (inbox) noteActive(id, inbox.path);
  if (inbox) {
    try {
      await syncFolderPath(account, inbox.path);
    } catch (error) {
      if (!error || !error.syncReported) noteOAuthSyncFailure(id, error, token);
    }
  }
  emitAccounts({ activeAccountId: id, folderId: inbox ? inbox.path : "" });
  const fresh = db.accountById(id);
  if (!fresh) return;
  try {
    await syncAccount(fresh, { background: true });
  } catch (error) {
    if (!error || !error.syncReported) noteOAuthSyncFailure(id, error, token);
  }
  emitAccounts();
}

async function connectOAuthAccount(providerInput, expectedAccountId) {
  const gen = ++oauthGeneration;
  let signed;
  try {
    signed = await oauth.signIn(providerInput, oauthConfig.providerKey(providerInput) === "google" ? "bundle" : "imap");
  } catch (error) {
    if (error && error.code === "oauth_cancelled") return fail("oauth_cancelled", "Sign-in canceled.");
    return fail("oauth", error instanceof Error ? error.message : String(error));
  }
  if (gen !== oauthGeneration) {
    finishOAuthPage(signed, false, "Sign-in canceled.");
    return fail("oauth_cancelled", "Sign-in canceled.");
  }
  if (expectedAccountId) {
    const expected = db.accountById(expectedAccountId);
    if (!expected || expected.email.toLowerCase() !== String(signed.email).toLowerCase()) {
      finishOAuthPage(signed, false, "Sign-in did not match the mailbox being reconnected.");
      return fail("account_mismatch", "Sign in with the mailbox named in Reconnect. Existing accounts and credentials are unchanged.");
    }
  }
  try {
    oauth.requirePurposeScopes(signed, signed.provider, "imap");
  } catch (error) {
    finishOAuthPage(signed, false, error.message);
    return fail("scope_missing", error.message);
  }
  const draft = {
    id: `oauth-${crypto.randomBytes(8).toString("hex")}`,
    email: signed.email,
    username: signed.username,
    profile: signed.profile,
    auth_kind: "oauth2",
    imap_host: signed.imap.host,
    imap_port: signed.imap.port,
    imap_tls: signed.imap.tls ? 1 : 0,
    smtp_host: signed.smtp.host,
    smtp_port: signed.smtp.port,
    smtp_tls: signed.smtp.tls ? 1 : 0,
  };
  const serialize = (grant, purpose) => JSON.stringify({
    provider: signed.provider,
    purpose,
    refreshToken: grant.refreshToken,
    accessToken: grant.accessToken,
    expiresAt: grant.expiresAt,
    grantedScopes: grant.grantedScopes,
    requestedScopes: grant.requestedScopes || grant.grantedScopes,
  });
  const existing = db.accountByEmail(signed.email);
  const id = existing ? existing.id : draft.id;
  // A narrower reconnect must never downgrade an existing primary token.
  if (existing && signed.provider === "google") {
    let previous;
    try { previous = JSON.parse(secrets.getPassword(id)); } catch { /* password or no prior grant */ }
    if (previous?.grantedScopes && !oauthConfig.hasScopes(signed.grantedScopes, previous.grantedScopes)) {
      const message = "Some previously granted permissions were omitted. Existing credentials were retained; approve the missing permissions and try again.";
      finishOAuthPage(signed, false, message);
      return fail("scope_missing", message);
    }
  }
  const displayName = signed.displayName || null;
  const login = {
    username: draft.username,
    profile: draft.profile,
    imapHost: draft.imap_host,
    imapPort: draft.imap_port,
    imapTls: draft.imap_tls === 1,
    smtpHost: draft.smtp_host,
    smtpPort: draft.smtp_port,
    smtpTls: draft.smtp_tls === 1,
    authKind: "oauth2",
    displayName,
  };
  const writes = [[id, serialize(signed, "imap")]];
  const previous = new Map();
  const written = [];
  let stage = "keychain";
  try {
    for (const [key] of writes) previous.set(key, secrets.getPassword(key));
    for (const [key, value] of writes) {
      written.push(key);
      secrets.setPassword(key, value);
    }
    stage = "storage";
    if (existing) db.updateAccountLogin(id, login);
    else {
      db.insertAccount({
        id,
        email: draft.email,
        ...login,
        delimiter: "/",
        createdAt: Date.now(),
      });
    }
    oauthCommitted.add(id);
  } catch (error) {
    let restored = true;
    for (const key of written.reverse()) {
      try {
        if (previous.get(key) == null) secrets.deletePassword(key);
        else secrets.setPassword(key, previous.get(key));
      } catch { restored = false; }
    }
    const message = restored
      ? (stage === "keychain" ? "Could not save credentials. Previous credentials were restored." : "Could not save this account. Previous credentials were restored.")
      : "Could not restore all credentials after a storage failure. Reconnect the mailbox.";
    finishOAuthPage(signed, false, message);
    return fail(stage, message);
  }
  finishOAuthPage(signed, true);
  let grantWarning = "";
  if (signed.provider === "microsoft") {
    // A second, Graph-only consent. Declining it must not undo the saved IMAP
    // connection; existing Graph grants remain usable and can be extended later.
    try {
      const granted = await sidecar.grantPurpose({ accountId: id }, "bundle");
      if (!granted.success) grantWarning = granted.error.message;
    } catch {
      grantWarning = "Could not finish feature sign-in. Mail remains connected; enable the missing features to try again.";
    }
  }
  const current = db.accountById(id);
  if (!current || gen !== oauthGeneration) return fail("oauth_cancelled", "Sign-in stopped. Any saved mailbox connection was retained.");
  const missing = ["calendar", "organize", "vacation", "rules"].filter((purpose) => !sidecar.gateAccount(current, purpose).ok);
  if (missing.length && !grantWarning) grantWarning = "Some feature permissions were not granted. Enable the missing features to try again.";
  emitAccounts({ activeAccountId: id, folderId: "" });
  watchIdle();
  setTimeout(() => {
    settleOAuthMailbox(id).catch(() => {});
  }, 0);
  return ok({ ...accountView(current, 0), grantWarning, missingPermissions: missing });
}

async function connectAccount(params) {
  if (params.expectedAccountId) {
    const expected = db.accountById(params.expectedAccountId);
    if (!expected || expected.email.toLowerCase() !== String(params.email || "").trim().toLowerCase()) return fail("account_mismatch", "Reconnect must use the selected mailbox address. Cached work is unchanged.");
  }
  const profile = params && params.profile ? String(params.profile) : "custom";
  const email = params && typeof params.email === "string" ? params.email.trim() : "";
  const username = params && typeof params.username === "string" && params.username.trim()
    ? params.username.trim()
    : email;
  const password = params && typeof params.password === "string" ? params.password : "";
  if (!email.includes("@")) return fail("invalid", "Enter the email address for this account.");
  if (!password) return fail("invalid", "Enter the password or app password.");
  const endpoints = presets.endpointsFor(profile, params.custom);
  if (!endpoints) {
    return fail("invalid", profile === "custom"
      ? "Enter the IMAP and SMTP server addresses."
      : "This provider needs the Custom IMAP / SMTP card so you can enter its servers.");
  }
  const draft = {
    id: `imap-${crypto.randomBytes(8).toString("hex")}`,
    email,
    username,
    profile,
    imap_host: endpoints.imap.host,
    imap_port: endpoints.imap.port,
    imap_tls: endpoints.imap.tls ? 1 : 0,
    smtp_host: endpoints.smtp.host,
    smtp_port: endpoints.smtp.port,
    smtp_tls: endpoints.smtp.tls ? 1 : 0,
  };
  try {
    await remote.withClient(draft, password, async (client) => {
      const listed = await remote.listFolderRecords(client);
      draft.folders = listed.folders;
      draft.delimiter = listed.delimiter;
    });
    try {
      await remote.verifySmtp(draft, password);
    } catch (error) {
      const message = remote.explain(error, password);
      if (/rejected the password/i.test(message)) throw error;
    }
  } catch (error) {
    return fail("auth", remote.explain(error, password));
  }
  const existing = db.accountByEmail(email);
  const id = existing ? existing.id : draft.id;
  if (existing) {
    db.updateAccountLogin(id, {
      username,
      profile,
      imapHost: draft.imap_host,
      imapPort: draft.imap_port,
      imapTls: draft.imap_tls === 1,
      smtpHost: draft.smtp_host,
      smtpPort: draft.smtp_port,
      smtpTls: draft.smtp_tls === 1,
    });
  } else {
    db.insertAccount({
      id,
      email,
      username,
      profile,
      imapHost: draft.imap_host,
      imapPort: draft.imap_port,
      imapTls: draft.imap_tls === 1,
      smtpHost: draft.smtp_host,
      smtpPort: draft.smtp_port,
      smtpTls: draft.smtp_tls === 1,
      delimiter: draft.delimiter || "/",
      createdAt: Date.now(),
    });
  }
  try {
    secrets.setPassword(id, password);
  } catch (error) {
    if (!existing) db.removeAccount(id);
    return fail("keychain", error instanceof Error ? error.message : "Could not save the password to the keychain.");
  }
  db.replaceFolders(id, draft.folders || [], draft.delimiter || "/");
  const account = db.accountById(id);
  const inbox = db.folderByWellKnown(id, "inbox");
  if (inbox) {
    noteActive(id, inbox.path);
    try {
      await syncFolderPath(account, inbox.path);
    } catch (error) {
      if (http.isRateLimit(error)) noteRateLimit(id, error);
      else db.setAuthError(id, remote.explain(error, password));
    }
  }
  emitAccounts();
  watchIdle();
  setTimeout(() => {
    const row = db.accountById(id);
    if (!row) return;
    syncAccount(row, { background: true }).then(() => emitAccounts()).catch((error) => {
      if (http.isRateLimit(error)) noteRateLimit(id, error);
    });
  }, 200);
  const view = accountView(db.accountById(id), 0);
  return ok(view);
}

async function removeAccount(params) {
  const id = params && (params.accountId || params.id);
  if (!id || !db.accountById(id)) return undefined;
  secrets.deletePassword(id);
  secrets.deletePassword(`${id}:organize`);
  secrets.deletePassword(`${id}:calendar`);
  secrets.deletePassword(`${id}:rules`);
  secrets.deletePassword(`${id}:vacation`);
  secrets.deletePassword(`${id}:bundle`);
  if (idleController) {
    try { await idleController.forget(id); } catch { /* the connection is already gone */ }
  }
  idleSafetyAt.delete(id);
  idleReported.delete(id);
  db.removeAccount(id);
  emitAccounts();
  return ok(true);
}

function addrList(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    const address = item.address || item.email || "";
    if (!address) return "";
    return item.name ? `${item.name} <${address}>` : address;
  }).filter(Boolean);
}

function plainFromHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function rfcMessageId(email) {
  const domain = String(email || "localhost").split("@")[1] || "localhost";
  return `<${crypto.randomBytes(12).toString("hex")}@${domain}>`;
}

function attachmentFiles(list) {
  const files = [];
  for (const item of list || []) {
    if (!item || typeof item !== "object") continue;
    let content = null;
    const storage = typeof item.storageUrl === "string" ? item.storageUrl : "";
    if (storage.startsWith("local:")) {
      const blob = db.readBlob(storage.slice("local:".length));
      if (blob && blob.data) content = Buffer.from(blob.data);
    } else if (item.content) {
      content = Buffer.isBuffer(item.content) ? item.content : Buffer.from(String(item.content), "base64");
    } else if (item.fileBytes) {
      content = Buffer.from(item.fileBytes);
    } else if (typeof item.path === "string" && fs.existsSync(item.path)) {
      content = fs.readFileSync(item.path);
    }
    if (!content) continue;
    files.push({
      filename: item.filename || item.name || "attachment",
      content,
      contentType: item.mimeType || item.contentType || "application/octet-stream",
      cid: item.contentId || undefined,
      contentDisposition: item.contentId ? "inline" : "attachment",
    });
  }
  return files;
}

function mimeOptions(account, params, files) {
  const html = typeof params.body === "string" ? params.body : "";
  return {
    from: params.fromAddress || account.email,
    to: addrList(params.to),
    cc: addrList(params.cc),
    bcc: addrList(params.bcc),
    subject: params.subject || "",
    html,
    text: plainFromHtml(html),
    inReplyTo: params.inReplyTo || undefined,
    references: Array.isArray(params.references) ? params.references : undefined,
    attachments: files,
  };
}

function remember(moves) {
  const id = `op-${crypto.randomBytes(6).toString("hex")}`;
  db.saveOp(id, { moves });
  return id;
}

async function moveRow(row, destination, wellKnown) {
  const account = db.accountById(row.account_id);
  if (!account) throw new Error("That account is no longer connected.");
  if (!row.uid) {
    db.updateMessage(row.id, {
      folder_path: destination,
      is_draft: wellKnown === "drafts" ? 1 : 0,
    });
    return;
  }
  await exclusive(account.id, async () => {
    const password = await secretFor(account);
    const next = await remote.withClient(account, password, (client) => remote.moveUid(client, row.folder_path, row.uid, destination));
    db.updateMessage(row.id, {
      folder_path: destination,
      uid: next.uid,
      uid_validity: next.uidValidity || row.uid_validity,
      is_draft: wellKnown === "drafts" ? 1 : 0,
    });
  });
}

// A thrown remote operation may have reached the server. Never infer rollback.
async function messageChanges(ids, change) {
  const outcomes = [];
  let stopped = false;
  for (const id of [...new Set(ids)]) {
    if (stopped) { outcomes.push({ id, status: "not_attempted" }); continue; }
    const row = db.messageById(id);
    if (!row || !db.accountById(row.account_id)) {
      outcomes.push({ id, status: "failed", error: "Message or account is no longer available." });
      stopped = true;
      continue;
    }
    try {
      outcomes.push({ id, status: "completed", ...(await change(row)) });
    } catch (error) {
      outcomes.push({ id, status: error.beforeWrite ? "failed" : "unknown", error: remote.explain(error) });
      stopped = true;
    }
  }
  emitAccounts();
  return { outcomes, opIds: outcomes.filter((row) => row.status === "completed" && row.opId).map((row) => row.opId) };
}

async function moveIds(ids, targetWell, targetPath) {
  return messageChanges(ids, async (row) => {
    const destFolder = targetPath
      ? db.folderByPath(row.account_id, targetPath)
      : db.folderByWellKnown(row.account_id, targetWell);
    if (!destFolder) throw Object.assign(new Error("That folder is not on this account."), { beforeWrite: true });
    const snapshot = { id: row.id, accountId: row.account_id, folderPath: row.folder_path, uid: row.uid,
      uidValidity: row.uid_validity, isDraft: row.is_draft };
    await moveRow(row, destFolder.path, destFolder.well_known);
    const moved = db.messageById(row.id);
    // Without a destination UID a remote move cannot safely be reversed.
    if (row.uid && !moved.uid) return {};
    snapshot.destination = { folderPath: moved.folder_path, uid: moved.uid, uidValidity: moved.uid_validity };
    return { opId: remember([snapshot]) };
  });
}

async function ensureBody(row) {
  if (!row || row.body_complete === 1 || !row.uid) return row;
  const account = db.accountById(row.account_id);
  if (!account) return row;
  try {
    return await exclusive(account.id, async () => {
    const password = await secretFor(account);
    const fetched = await remote.withClient(account, password, (client) => remote.fetchSource(client, row.folder_path, row.uid));
    if (!fetched) return row;
    db.updateMessage(row.id, {
      html_body: fetched.htmlBody,
      text_body: fetched.textBody,
      snippet: fetched.snippet || row.snippet,
      attachments_json: JSON.stringify(fetched.attachments || []),
      has_attachments: fetched.hasAttachments ? 1 : 0,
      body_complete: fetched.bodyComplete ? 1 : 0,
      subject: fetched.subject || row.subject,
    });
    return db.messageById(row.id);
    });
  } catch {
    return row;
  }
}

async function mutateFlags(row, add, remove, patch) {
  const account = db.accountById(row.account_id);
  if (account && row.uid) {
    await exclusive(account.id, async () => {
      const password = await secretFor(account);
      await remote.withClient(account, password, (client) => remote.changeFlags(client, row.folder_path, row.uid, add, remove));
      db.updateMessage(row.id, patch);
    });
    return;
  }
  db.updateMessage(row.id, patch);
}

async function applyFlags(row, add, remove, patch) {
  try {
    await mutateFlags(row, add, remove, patch);
    return null;
  } catch (error) {
    return remote.explain(error);
  }
}

function pushRows(into, rows, limit) {
  const seen = new Set(into.map((row) => row.id));
  for (const row of rows || []) {
    if (!row || seen.has(row.id)) continue;
    into.push(row);
    seen.add(row.id);
    if (into.length >= limit) break;
  }
}

function storeImapHits(account, folderPath, found) {
  const messages = found && Array.isArray(found.messages) ? found.messages : [];
  if (!messages.length) return [];
  db.applyFolderSync(account.id, folderPath, {
    messages,
    validity: found.validity,
    keepOthers: true,
  });
  const rows = [];
  for (const message of messages) {
    const row = db.messageByUid(account.id, folderPath, message.uid, found.validity);
    if (row) rows.push(listRow(row));
  }
  return rows;
}

function rememberApiHit(account, hit) {
  const rfc = hit && hit.rfcMessageId ? String(hit.rfcMessageId).trim() : "";
  if (rfc) {
    const existing = db.messageByRfc(account.id, rfc);
    if (existing) return listRow(existing);
  }
  const when = Date.parse(hit && hit.date);
  const id = `m-${crypto.randomBytes(8).toString("hex")}`;
  db.insertMessage({
    id,
    accountId: account.id,
    folderPath: "__search__",
    uid: 0,
    uidValidity: 0,
    threadId: (hit && hit.threadId) || id,
    rfcMessageId: rfc || null,
    subject: (hit && hit.subject) || "",
    snippet: (hit && hit.snippet) || "",
    from: (hit && hit.from) || "",
    to: (hit && hit.to) || [],
    cc: (hit && hit.cc) || [],
    date: (hit && hit.date) || new Date().toISOString(),
    listSortTs: Number.isFinite(when) ? when : Date.now(),
    unread: !!(hit && hit.unread),
    hasAttachments: !!(hit && hit.hasAttachments),
    htmlBody: hit && hit.html ? hit.html : null,
    textBody: hit && hit.text ? hit.text : null,
    bodyComplete: !!(hit && (hit.html || hit.text)),
  });
  const row = db.messageById(id);
  return row ? listRow(row) : null;
}

async function searchImap(account, text, limit) {
  const password = await secretFor(account);
  return exclusive(account.id, () => remote.withClient(account, password, async (client) => {
    if (account.profile === "gmail") {
      for (const box of GMAIL_ALL) {
        let found = null;
        try {
          found = await remote.findText(client, box, text, limit, { gmail: true });
        } catch (error) {
          if (http.isRateLimit(error)) throw error;
          found = null;
        }
        if (found && found.searched) return storeImapHits(account, box, found).slice(0, limit);
      }
      const token = await sidecar.organizeToken(account);
      if (token && token.provider === "google") {
        const hits = await providerApi.searchGmail(token.accessToken, text, Math.min(limit, providerApi.SEARCH_CAP));
        return hits.map((hit) => rememberApiHit(account, hit)).filter(Boolean).slice(0, limit);
      }
    }
    const rows = [];
    for (const folder of db.foldersFor(account.id)) {
      if (rows.length >= limit) break;
      let found = null;
      try {
        found = await remote.findText(client, folder.path, text, limit - rows.length);
      } catch (error) {
        if (http.isRateLimit(error)) throw error;
        continue;
      }
      if (!found || !found.searched) continue;
      pushRows(rows, storeImapHits(account, folder.path, found), limit);
    }
    return rows;
  }));
}

async function searchAccount(account, text, limit) {
  if (account.profile === "outlook") {
    const token = await sidecar.organizeToken(account);
    if (token && token.provider === "microsoft") {
      const hits = await providerApi.searchGraph(token.accessToken, text, Math.min(limit, providerApi.SEARCH_CAP));
      return hits.map((hit) => rememberApiHit(account, hit)).filter(Boolean).slice(0, limit);
    }
  }
  return searchImap(account, text, limit);
}

function searchLocal(params) {
  const query = params || {};
  return db.searchMessages({
    query: query.query,
    accountId: query.accountId || null,
    limit: query.limit,
  }).map(listRow);
}

async function searchRemote(params) {
  const text = String((params && params.query) || "").trim();
  if (!text) return [];
  const limit = Math.min(Math.max(Number(params && params.limit) || SEARCH_LIMIT, 1), SEARCH_LIMIT);
  const accounts = params && params.accountId
    ? [db.accountById(params.accountId)].filter(Boolean)
    : db.listAccountRows();
  const rows = [];
  let paused = false;
  for (const account of accounts) {
    if (rows.length >= limit) break;
    if (!gateOpen(account.id)) {
      emitSync("paused", { accountId: account.id, message: "Paused for rate limit" });
      paused = true;
      continue;
    }
    try {
      pushRows(rows, await searchAccount(account, text, limit - rows.length), limit);
    } catch (error) {
      if (http.isRateLimit(error)) {
        noteRateLimit(account.id, error);
        paused = true;
        continue;
      }
      throw error;
    }
  }
  if (!rows.length && paused) {
    const error = new Error("Paused for rate limit");
    error.code = "rate_limit";
    throw error;
  }
  return rows.slice(0, limit);
}

function saveUpload(params) {
  const bytes = params && params.fileBytes ? Buffer.from(params.fileBytes) : null;
  if (!bytes || !bytes.length) return fail("invalid", "The attachment was empty.");
  if (bytes.length > 25 * 1024 * 1024) return fail("too-large", "Attachments must be 25 MB or smaller.");
  const id = crypto.randomBytes(9).toString("hex");
  const filename = params.filename && String(params.filename).trim() ? String(params.filename).trim() : "attachment";
  const mime = params.mimeType && String(params.mimeType).trim() ? String(params.mimeType).trim() : "application/octet-stream";
  db.saveBlob(id, filename, mime, bytes);
  return ok({ storageUrl: `local:${id}`, pageUrl: null, fileWrapperUrl: `local:${id}` });
}

async function bytesFor(params) {
  const row = db.messageById(params && (params.messageId || params.emailId));
  if (!row) return null;
  const attachments = db.jsonList(row.attachments_json);
  const wanted = attachments.find((item) => item.id === params.attachmentId) || attachments[0];
  if (!wanted) return null;
  if (!row.uid) return null;
  const account = db.accountById(row.account_id);
  const data = await exclusive(account.id, async () => {
    const password = await secretFor(account);
    return remote.withClient(account, password, (client) => remote.readPart(client, row.folder_path, row.uid, wanted.id));
  });
  return { filename: params.filename || wanted.filename || "attachment", data };
}

function signatureText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicSignature(row) {
  const out = { id: row.id, accountId: row.account_id, name: row.name };
  if (row.body_html) out.html = row.body_html;
  else out.text = row.body_text || "";
  return out;
}

function signaturePack(accountId) {
  const rows = db.listSignatures(accountId || null);
  const per = {};
  for (const row of db.signatureDefaults()) per[row.account_id] = row.id;
  return {
    signatures: rows.map(publicSignature),
    defaultSignatureId: accountId ? (per[accountId] || null) : null,
    defaultSignaturePerAccount: per,
  };
}

function upsertSignature(params) {
  const accountId = params && params.accountId ? String(params.accountId) : "";
  const id = params && params.id ? String(params.id) : "";
  const existing = id ? db.signatureById(id) : null;
  if (id && !existing) return fail("not-found", "That signature is gone.");
  const owner = accountId || (existing && existing.account_id) || "";
  if (!owner || !db.accountById(owner)) return fail("not-found", "Connect an account before saving a signature.");
  if (existing && existing.account_id !== owner) return fail("not-found", "That signature is gone.");
  const name = signatureText(params && params.name);
  const text = signatureText(params && params.text);
  const html = signatureText(params && params.html);
  if (!name) return fail("invalid", "Add a name.");
  if (!text && !html) return fail("invalid", "Add signature text.");
  const saved = db.saveSignature({
    id: existing ? existing.id : `sig-${crypto.randomBytes(8).toString("hex")}`,
    accountId: owner,
    name,
    bodyText: html ? null : text,
    bodyHtml: html || null,
    isDefault: params && params.isDefault,
  });
  return ok(publicSignature(saved));
}

function deleteSignature(params) {
  const id = params && params.id ? String(params.id) : "";
  const existing = db.signatureById(id);
  if (!existing) return fail("not-found", "That signature is gone.");
  const accountId = params && params.accountId ? String(params.accountId) : "";
  if (accountId && existing.account_id !== accountId) return fail("not-found", "That signature is gone.");
  db.deleteSignature(id);
  return ok(true);
}

function displayAddress(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
  return String(value || "").trim();
}

function storedAddress(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").trim();
}

function hasRecipient(to, cc, bcc) {
  return !!(displayAddress(to) || displayAddress(cc) || displayAddress(bcc));
}

function storedAttachments(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map((item) => {
    if (!item || typeof item !== "object") return null;
    const copy = { ...item };
    delete copy.fileBytes;
    delete copy.content;
    return copy;
  }).filter(Boolean);
}

const scheduledDelivering = new Set();

function publicScheduled(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json) || {}; } catch { payload = {}; }
  const out = {
    id: row.id,
    accountId: row.account_id,
    to: displayAddress(payload.to),
    subject: payload.subject || "",
    sendAt: new Date(row.send_at).toISOString(),
    status: scheduledDelivering.has(row.id) ? "sending" : (row.status || "pending"),
  };
  const cc = displayAddress(payload.cc);
  const bcc = displayAddress(payload.bcc);
  if (cc) out.cc = cc;
  if (bcc) out.bcc = bcc;
  if (row.error) out.error = row.error;
  return out;
}

function scheduleSend(params) {
  const input = params || {};
  const account = db.accountById(input.accountId);
  if (!account) return fail("not-found", "Choose an account before scheduling.");
  const to = storedAddress(input.to);
  const cc = storedAddress(input.cc);
  const bcc = storedAddress(input.bcc);
  if (!hasRecipient(to, cc, bcc)) return fail("invalid", "Add a recipient.");
  const when = Date.parse(input.sendAt);
  if (!Number.isFinite(when) || when <= Date.now() + 1000) {
    return fail("send_at_in_past", "Pick a time in the future.");
  }
  const payload = {
    to,
    cc,
    bcc,
    subject: input.subject ? String(input.subject).trim() : "",
    body: typeof input.body === "string" ? input.body : "",
    fromAddress: input.fromAddress || account.email,
  };
  if (input.draftId) payload.draftId = input.draftId;
  if (input.emailId) payload.emailId = input.emailId;
  if (input.inReplyTo) payload.inReplyTo = input.inReplyTo;
  if (input.threadId) payload.threadId = input.threadId;
  if (Array.isArray(input.references)) payload.references = input.references;
  const attachments = storedAttachments(input.attachments);
  if (attachments && attachments.length) payload.attachments = attachments;
  const saved = db.insertScheduled({
    id: `sched-${crypto.randomBytes(8).toString("hex")}`,
    accountId: account.id,
    payloadJson: JSON.stringify(payload),
    sendAt: when,
    createdAt: Date.now(),
  });
  return ok(publicScheduled(saved));
}

function listScheduled(params) {
  const accountId = params && params.accountId ? String(params.accountId) : "";
  return ok(db.listScheduled(accountId).map(publicScheduled));
}

function cancelScheduled(params) {
  const id = params && params.id ? String(params.id) : "";
  if (scheduledDelivering.has(id)) return fail("sending", "Delivery has started. It can no longer be canceled or edited. Check Sent before retrying.");
  if (!db.deleteScheduled(id)) return fail("not-found", "That scheduled send is gone.");
  return ok(true);
}

function editScheduled(params) {
  const id = String((params && params.id) || "");
  if (scheduledDelivering.has(id)) return fail("sending", "Delivery has started. It can no longer be canceled or edited. Check Sent before retrying.");
  const row = db.scheduledById(id);
  if (!row) return fail("not-found", "That scheduled send is gone. Refresh the queue and check Sent.");
  const account = db.accountById(row.account_id);
  const drafts = account && db.folderByWellKnown(account.id, "drafts");
  if (!drafts) return fail("not-found", "This mailbox has no Drafts folder. The queued message is unchanged.");
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { return fail("invalid", "The queued content cannot be read. It has not been changed."); }
  if (payload.attachments && payload.attachments.length) return fail("unsupported", "This composer cannot edit queued attachments. The queued message is unchanged.");
  const now = new Date();
  const emailId = db.newMessageId();
  db.scheduledToDraft(id, {
    id: emailId, accountId: account.id, folderPath: drafts.path,
    threadId: payload.threadId || emailId, inReplyTo: payload.inReplyTo || null,
    rfcMessageId: rfcMessageId(account.email), subject: payload.subject || "",
    from: payload.fromAddress || account.email, to: addrList(payload.to), cc: addrList(payload.cc), bcc: addrList(payload.bcc),
    date: now.toISOString(), listSortTs: now.getTime(), isDraft: true,
    htmlBody: payload.body || "", textBody: plainFromHtml(payload.body || ""),
    snippet: plainFromHtml(payload.body || "").slice(0, 180), bodyComplete: true,
  });
  emitAccounts();
  return ok({ emailId, accountId: account.id, sendAt: new Date(row.send_at).toISOString() });
}

async function deliver(params) {
  const account = db.accountById(params && params.accountId);
  if (!account) return fail("not-found", "Choose an account before sending.");
  const files = attachmentFiles(params && params.attachments);
  const options = mimeOptions(account, params || {}, files);
  if (!options.to.length && !options.cc.length && !options.bcc.length) {
    return fail("invalid", "Add a recipient.");
  }
  try {
    const sentResult = await exclusive(account.id, async () => {
      const password = await secretFor(account);
      const messageId = rfcMessageId(account.email);
      const info = await remote.sendSmtp(account, password, { ...options, messageId });
      const sent = db.folderByWellKnown(account.id, "sentitems");
      const emailId = db.newMessageId();
      const when = new Date();
      const keptId = info.messageId || messageId;
      if (sent) {
        db.insertMessage({
          id: emailId,
          accountId: account.id,
          folderPath: sent.path,
          threadId: (params && params.threadId) || emailId,
          rfcMessageId: keptId,
          subject: options.subject,
          snippet: plainFromHtml(options.html).slice(0, 180),
          from: options.from,
          to: options.to,
          cc: options.cc,
          bcc: options.bcc,
          date: when.toISOString(),
          listSortTs: when.getTime(),
          isDraft: false,
          hasAttachments: files.length > 0,
          htmlBody: options.html,
          textBody: options.text,
          bodyComplete: true,
          inReplyTo: params.inReplyTo || null,
        });
        if (account.profile !== "gmail") {
          try {
            const raw = await remote.buildRaw({ ...options, messageId: keptId });
            const appended = await remote.withClient(account, password, (client) => remote.appendRaw(client, sent.path, raw, ["\\Seen"]));
            if (appended && appended.uid) {
              db.updateMessage(emailId, {
                uid: Number(appended.uid),
                uid_validity: Number(appended.uidValidity) || 0,
              });
            }
          } catch {
            // The SMTP send already succeeded. The next sync adopts the Sent copy by message id.
          }
        } else {
          try {
            const report = await remote.withClient(account, password, (client) => remote.syncFolder(client, sent.path, { limit: 40 }));
            db.applyFolderSync(account.id, sent.path, report);
          } catch {
            // The local Sent row stays until a later sync can adopt it.
          }
        }
      }
      return { emailId, messageId: keptId };
    });
    const draftId = params && (params.draftId || params.emailId);
    const draft = draftId ? db.messageById(draftId) : null;
    if (draft && draft.is_draft === 1) {
      try {
        if (draft.uid) {
          await exclusive(account.id, async () => {
            const password = await secretFor(account);
            await remote.withClient(account, password, (client) => remote.removeUid(client, draft.folder_path, draft.uid));
          });
        }
      } catch { /* local removal still happens */ }
      db.deleteMessage(draft.id);
    }
    emitAccounts();
    return ok({ emailId: sentResult.emailId, messageId: sentResult.messageId, platform: "imap" });
  } catch (error) {
    return fail("send", remote.explain(error, secrets.getPassword(account.id)));
  }
}

async function pumpScheduled() {
  if (!ready || pumping) return;
  pumping = true;
  try {
    const due = db.dueScheduled(Date.now());
    for (const candidate of due) {
      // Another queued item may have been canceled/edited while delivery awaited I/O.
      const row = db.scheduledById(candidate.id);
      if (!row || row.status !== "pending") continue;
      scheduledDelivering.add(row.id);
      let payload = {};
      try { payload = JSON.parse(row.payload_json) || {}; } catch { payload = {}; }
      let result;
      try {
        result = await deliver({ ...payload, accountId: row.account_id });
      } catch (error) {
        result = fail("send", error instanceof Error ? error.message : String(error));
      }
      scheduledDelivering.delete(row.id);
      if (result && result.success) db.deleteScheduled(row.id);
      else db.markScheduledFailed(row.id, (result && result.error && result.error.message) || "Send failed.");
    }
  } finally {
    pumping = false;
  }
}

function answer(channel, args) {
  if (!ready) return undefined;
  if (sidecar.handles(channel)) return sidecar.answer(channel, args);
  const params = args && args.length ? args[0] : undefined;
  if (channel === "mail:listImapSmtpPresets") return ok(presets.CARDS);
  if (channel === "mail:connectImapSmtp") return connectAccount(params || {});
  if (channel === "mail:uploadAttachment" || channel === "mail:uploadInlineImage" || channel === "mail:uploadAgentFile") {
    return saveUpload(params || {});
  }
  if (channel === "mail:removeAccount") return removeAccount(params || {});
  if (channel === "mail:clearAuthFailures") {
    if (ready) db.clearAuthError(params && params.accountId);
    return ok(true);
  }
  if (channel === "mail:cancelOAuth") return cancelOAuth();
  if (channel === "mail:setOnline") {
    const online = !params || params.online !== false;
    if (online) idleOnline();
    else idleOffline();
    return ok({ online });
  }
  if (channel === "mail:addAccount") {
    return (async () => {
      try {
        const provider = (params && (params.provider || params.platform || params.type)) || "google";
        const result = await connectOAuthAccount(provider, params && params.expectedAccountId);
        return result;
      } catch (error) {
        return fail("oauth", error instanceof Error ? error.message : String(error));
      }
    })();
  }

  switch (channel) {
    case "mail:refreshAccounts":
      setTimeout(() => { syncAll().catch(() => {}); }, 0);
      return ok({ refreshed: true, refreshedAt: Date.now() });
    case "mail:listAccounts":
    case "mail:refreshUnreadCounts":
    case "mail:unreadCounts":
      return ok(accountViews());
    case "mail:listFromCacheAggregate":
    case "mail:listFromCache":
    case "mail:listWindowRead":
    case "mail:loadMoreAggregate":
      if (params && params.accountId && params.folderId && params.folderId !== STARRED_FOLDER_ID) {
        noteActive(params.accountId, params.folderId);
      }
      return ok({ ...listPayload(params), sync: publicSync(params) });
    case "mail:getSyncStatus":
      return ok(publicSync(params));
    case "mail:listFromNetwork":
      return (async () => {
        const query = params || {};
        if (query.folderId === STARRED_FOLDER_ID) {
          return ok({ ...listPayload(query), sync: publicSync(query) });
        }
        const account = query.accountId ? db.accountById(query.accountId) : null;
        if (account && query.folderId) noteActive(account.id, query.folderId);
        try {
          if (account && query.folderId) {
            await syncFolderPath(account, query.folderId);
          } else if (account) {
            await syncAccount(account, { onlyInbox: true });
          }
        } catch (error) {
          if (http.isRateLimit(error) && account) noteRateLimit(account.id, error);
          else if (db.countMessages(queryFrom(query)) === 0) return fail("sync", remote.explain(error));
        }
        emitAccounts();
        return ok({ ...listPayload(query), sync: publicSync(query) });
      })();
    case "mail:kickoffAggregateSync":
      setTimeout(() => { syncAll({ folderKey: params && params.folderKey }).catch(() => {}); }, 0);
      return ok({ started: true });
    case "mail:folderStats":
      return ok({
        flagged: db.countMessages({ ...queryFrom(params), filterFlagged: true }),
        unread: db.countMessages({ ...queryFrom(params), filterUnread: true }),
      });
    case "mail:countInboxUnread":
      return ok({ count: params && params.accountId ? db.inboxUnread(params.accountId) : accountViews().reduce((sum, item) => sum + item.unreadCount, 0) });
    case "mail:countDrafts":
      return ok({ count: db.draftCount(params && params.accountId) });
    case "mail:maskedFolderUnread":
      return ok({ revision: 1, overrides: [] });
    case "mail:getUnifiedCategorySettings":
      return ok({ enabled: true });
    case "mail:getNotificationSettings":
      return ok({ enhanced_notifications_enabled: false });
    case "mail:getNotificationBadgeCount":
      return ok(accountViews().reduce((sum, item) => sum + item.unreadCount, 0));
    case "mail:listFailedDraftIds":
      return ok([]);
    case "mail:listSignatures":
      return ok(signaturePack(params && params.accountId ? String(params.accountId) : ""));
    case "mail:upsertSignature":
      return upsertSignature(params || {});
    case "mail:deleteSignature":
      return deleteSignature(params || {});
    case "mail:ops:queueSummary":
      return ok({ pending: 0, dead: 0, sends: 0 });
    case "mail:ops:getNetworkState":
      return ok({ state: "connected" });
    case "mail:searchLocal":
      return ok(searchLocal(params || {}));
    case "mail:search":
      return (async () => {
        try {
          return ok(await searchRemote(params || {}));
        } catch (error) {
          if (http.isRateLimit(error) || (error && error.code === "rate_limit")) {
            return fail("rate_limit", "Paused for rate limit");
          }
          return fail("search", remote.explain(error));
        }
      })();
    case "mail:openEmail":
      return (async () => {
        const row = await ensureBody(db.messageById(params && params.emailId));
        if (!row) return fail("email-gone", "That message is no longer in the mailbox.");
        const members = db.messagesByThread(row.account_id, row.thread_id).map(listRow);
        return ok({
          email: detailOf(row),
          isThread: members.length > 1,
          threadMessages: members,
        });
      })();
    case "mail:readEmail":
      return (async () => {
        const row = await ensureBody(db.messageById(params && params.emailId));
        if (!row) return fail("email-gone", "That message is no longer in the mailbox.");
        return ok(detailOf(row));
      })();
    case "mail:getLocalThreadMembers":
    case "mail:listThreadMessages": {
      const threadId = params && params.threadId;
      const accountId = params && params.accountId;
      if (!threadId) return ok([]);
      const rows = accountId
        ? db.messagesByThread(accountId, threadId)
        : db.selectMessages({ tokens: [], limit: 50 }).filter((row) => row.thread_id === threadId);
      const headersOnly = params && params.headersOnly === true;
      return ok(rows.map((row) => headersOnly ? listRow(row) : detailOf(row)));
    }
    case "mail:markRead":
      return (async () => {
        const row = db.messageById(params && params.emailId);
        if (row && typeof params.isRead === "boolean") {
          const message = await applyFlags(row, params.isRead ? ["\\Seen"] : [], params.isRead ? [] : ["\\Seen"], { unread: params.isRead ? 0 : 1 });
          if (message) return fail("flags", message);
          emitAccounts();
        }
        return ok(true);
      })();
    case "mail:markReadBatch":
      return (async () => {
        const isRead = params && params.isRead !== false;
        return ok(await messageChanges(((params && params.items) || []).map((item) => item.emailId || item.id), async (row) => {
          await mutateFlags(row, isRead ? ["\\Seen"] : [], isRead ? [] : ["\\Seen"], { unread: isRead ? 0 : 1 });
        }));
      })();
    case "mail:toggleStar":
      return (async () => {
        const row = db.messageById(params && params.emailId);
        if (!row) return fail("email-gone", "That message is no longer in the mailbox.");
        if (typeof (params && params.isStarred) !== "boolean") return fail("flags", "Star needs a true or false value.");
        // IMAP \Flagged is Gmail's star and the flag on other servers, including Outlook.
        const on = params.isStarred;
        const message = await applyFlags(row, on ? ["\\Flagged"] : [], on ? [] : ["\\Flagged"], { starred: on ? 1 : 0 });
        if (message) return fail("flags", message);
        emitAccounts();
        return ok({ isStarred: on });
      })();
    case "mail:toggleStarBatch":
      return (async () => {
        const starred = !!(params && params.isStarred);
        return ok(await messageChanges(((params && params.items) || []).map((item) => item.emailId || item.id), async (row) => {
          await mutateFlags(row, starred ? ["\\Flagged"] : [], starred ? [] : ["\\Flagged"], { starred: starred ? 1 : 0 });
        }));
      })();
    case "mail:archive":
    case "mail:threadArchive":
    case "mail:delete":
    case "mail:threadTrash":
    case "mail:markSpam":
    case "mail:markNotSpam":
    case "mail:archiveBatch":
    case "mail:deleteBatch":
      return (async () => {
        try {
          const ids = [];
          if (params && params.threadId && (channel === "mail:threadArchive" || channel === "mail:threadTrash")) {
            const rows = db.messagesByThread(params.accountId, params.threadId);
            ids.push(...rows.map((row) => row.id));
          }
          if (params && Array.isArray(params.items)) {
            for (const item of params.items) ids.push(item.emailId || item.id);
          }
          if (params && params.emailId) ids.push(params.emailId);
          const unique = [...new Set(ids)];
          if (!unique.length) return ok({ opIds: [] });
          const permanent = channel === "mail:deleteBatch"
            && (params.folderWellKnownName === "deleteditems" || params.folderWellKnownName === "trash");
          if (permanent) {
            return ok(await messageChanges(unique, async (row) => {
              const account = db.accountById(row.account_id);
              if (account && row.uid) {
                const password = await secretFor(account);
                await remote.withClient(account, password, (client) => remote.removeUid(client, row.folder_path, row.uid));
              }
              db.deleteMessage(row.id);
            }));
          }
          let well = "archive";
          if (channel === "mail:delete" || channel === "mail:threadTrash" || channel === "mail:deleteBatch") well = "deleteditems";
          if (channel === "mail:markSpam") well = "junkemail";
          if (channel === "mail:markNotSpam") well = "inbox";
          return ok(await moveIds(unique, well, null));
        } catch (error) {
          return fail("move", remote.explain(error));
        }
      })();
    case "mail:moveToFolder":
    case "mail:threadMove":
    case "mail:moveToFolderBatch":
      return (async () => {
        try {
        const target = params && (params.targetFolderId || params.destination);
        if (target === STARRED_FOLDER_ID) return fail("move", "Starred is a filter, not a folder.");
        if (!target) return fail("move", "Choose a folder.");
          const ids = [];
          if (params.emailId) ids.push(params.emailId);
          if (params.threadId) {
            const rows = db.messagesByThread(params.accountId, params.threadId);
            const source = params.sourceFolderId || params.folderId;
            ids.push(...rows.filter((row) => !source || row.folder_path === source).map((row) => row.id));
          }
          for (const item of params.items || []) ids.push(item.emailId || item.id);
          const unique = [...new Set(ids)];
          if (!unique.length) return ok({ opIds: [] });
          return ok(await moveIds(unique, null, target));
        } catch (error) {
          return fail("move", remote.explain(error));
        }
      })();
    case "mail:undoRemoval":
      return (async () => {
        const opIds = (params && params.opIds) || [];
        const outcomes = [];
        for (const opId of opIds) {
          const saved = db.readOp(opId);
          // Consume before attempting: an uncertain reverse move must not be replayed.
          db.saveOp(opId, { moves: [] });
          if (!saved || !saved.moves || !saved.moves.length) {
            outcomes.push({ id: opId, status: "failed", error: "This Undo is no longer available." });
          }
          for (const snap of (saved && saved.moves) || []) {
            const row = db.messageById(snap.id);
            const dest = snap.destination;
            if (!row || !dest || row.account_id !== snap.accountId || row.folder_path !== dest.folderPath
                || row.uid !== dest.uid || row.uid_validity !== dest.uidValidity) {
              outcomes.push({ id: snap.id, status: "failed", error: "Message changed since this operation. Refresh before acting again." });
              continue;
            }
            try {
              await moveRow(row, snap.folderPath, snap.isDraft ? "drafts" : null);
              outcomes.push({ id: snap.id, status: "completed" });
            } catch (error) {
              outcomes.push({ id: snap.id, status: "unknown", error: remote.explain(error) });
            }
          }
        }
        emitAccounts();
        return ok({ outcomes, opIds: [] });
      })();
    case "mail:snoozeThread": {
      const when = Date.parse(params && params.snoozedUntil);
      if (!Number.isFinite(when) || when <= Date.now() + 1000) {
        return { success: false, error: { code: "snoozed_until_in_past", message: "Pick a time in the future." } };
      }
      if (when - Date.now() > SNOOZE_MAX_MS) {
        return { success: false, error: { code: "snoozed_until_too_far", message: "Snooze stays within a year." } };
      }
      if (!params.accountId || !params.threadId) return { success: false, error: { code: "invalid", message: "Missing thread." } };
      db.setSnooze(params.accountId, params.threadId, new Date(when).toISOString());
      emitAccounts();
      return { success: true, data: { snoozedUntil: new Date(when).toISOString() } };
    }
    case "mail:unsnoozeThread":
      if (params && params.accountId && params.threadId) db.clearSnooze(params.accountId, params.threadId);
      emitAccounts();
      return { success: true, data: true };
    case "mail:listSnoozed": {
      const records = db.snoozeRows(params && params.accountId, "active").map((row) => ({
        threadId: row.thread_id,
        accountId: row.account_id,
        state: "snoozed",
        snoozedUntil: row.until_iso,
      }));
      return ok({ records });
    }
    case "mail:listSnoozedEmails": {
      const accountId = params && params.accountId;
      const active = db.snoozeRows(accountId, "active");
      const untilByThread = {};
      for (const row of active) untilByThread[row.thread_id] = row.until_iso;
      const emails = db.selectMessages({ accountId, onlySnoozed: true, limit: 200 }).map(listRow);
      return ok({ emails, snoozedUntilByThread: untilByThread, threads: threadMeta(emails), total: emails.length });
    }
    case "mail:listResurfaced":
      return ok(db.snoozeRows(params && params.accountId, "due").map((row) => ({
        threadId: row.thread_id,
        accountId: row.account_id,
        snoozedUntil: row.until_iso,
        resurfacedAt: row.until_iso,
        acknowledged: false,
      })));
    case "mail:moveFolder":
      return (async () => {
        const account = db.accountById(params && params.accountId);
        if (!account) return fail("not-found", "That account is not connected.");
        const delimiter = account.delimiter || "/";
        const sourceId = params && params.folderId ? String(params.folderId) : "";
        const destinationId = params && params.destinationId ? String(params.destinationId) : "";
        const records = db.foldersFor(account.id).map((folder) => ({
          path: folder.path,
          name: folder.name,
          wellKnown: folder.well_known,
        }));
        const plan = db.planImapPathMove(records, sourceId, destinationId, delimiter);
        if (!plan.ok) return fail(plan.code || "invalid", plan.message);
        let listed = null;
        try {
          await exclusive(account.id, async () => {
            const password = await secretFor(account);
            await remote.withClient(account, password, async (client) => {
              await remote.renameBox(client, plan.source, plan.next);
              listed = await remote.listFolderRecords(client);
            });
          });
        } catch (error) {
          return fail("PROVIDER_ERROR", remote.explain(error));
        }
        const serverFolders = listed && Array.isArray(listed.folders) ? listed.folders : [];
        const confirmed = db.confirmedImapRenames(plan, serverFolders);
        const rewrite = db.rewriteFolderPaths(account.id, confirmed);
        const sourceMoved = rewrite.moved.some((row) => row.from === plan.source);
        if (!sourceMoved || rewrite.skipped.length) {
          const message = rewrite.skipped.length
            ? "The server renamed the folder, but the local cache already had the new path, so cached mail was left in place."
            : "The server did not show the folder at its new path, so cached mail was left in place.";
          return fail("partial", message);
        }
        if (serverFolders.length) db.replaceFolders(account.id, serverFolders, (listed && listed.delimiter) || delimiter);
        const movedFrom = new Set(rewrite.moved.map((row) => row.from));
        const missed = plan.renames.filter((step) => !movedFrom.has(step.from));
        const accounts = accountViews();
        broadcast("mail:accountsUpdated", { source: "server", accounts });
        broadcast("mail:emailsUpdated", { accountId: account.id, folderId: plan.next, folderIds: null });
        return ok({
          id: plan.next,
          from: plan.source,
          renames: rewrite.moved,
          warning: missed.length ? `These folders stayed at their old paths: ${missed.map((step) => step.from).join(", ")}` : "",
        });
      })();
    case "mail:createFolder":
      return (async () => {
        const account = db.accountById(params && params.accountId);
        const name = params && typeof params.folderName === "string" ? params.folderName.trim() : "";
        if (!account) return fail("not-found", "That account is not connected.");
        if (!name) return fail("INVALID_NAME", "Enter a folder name.");
        if (name.includes("/")) return fail("INVALID_NAME", "Folder names cannot include a slash.");
        const parent = params.parentFolderId;
        const delimiter = account.delimiter || "/";
        const folderPath = parent ? `${parent}${delimiter}${name}` : name;
        if (db.folderByPath(account.id, folderPath)) return fail("DUPLICATE_NAME", "A folder with that name already exists.");
        try {
          await exclusive(account.id, async () => {
            const password = await secretFor(account);
            await remote.withClient(account, password, async (client) => {
              await remote.createBox(client, folderPath);
              const listed = await remote.listFolderRecords(client);
              db.replaceFolders(account.id, listed.folders, listed.delimiter);
            });
          });
        } catch (error) {
          return fail("PROVIDER_ERROR", remote.explain(error));
        }
        if (!db.folderByPath(account.id, folderPath)) {
          db.replaceFolders(account.id, [...db.foldersFor(account.id).map((folder) => ({
            path: folder.path,
            name: folder.name,
            wellKnown: folder.well_known,
          })), { path: folderPath, name, wellKnown: null }], account.delimiter);
        }
        const created = {
          id: folderPath,
          name,
          wellKnownName: null,
          unreadCount: 0,
          totalCount: 0,
          type: "user",
          children: [],
        };
        const accounts = accountViews();
        broadcast("mail:accountsUpdated", {
          accounts,
          createdFolderId: folderPath,
          createdFolderAccountId: account.id,
        });
        return ok(created);
      })();
    case "mail:upsertDraft":
      return (async () => {
        const account = db.accountById(params && params.accountId);
        if (!account) return fail("not-found", "Choose an account before saving a draft.");
        const drafts = db.folderByWellKnown(account.id, "drafts");
        if (!drafts) return fail("not-found", "This account has no Drafts folder.");
        const emailId = (params && params.emailId) || db.newMessageId();
        const existing = db.messageById(emailId);
        if (existing && (existing.account_id !== account.id || !existing.is_draft)) return fail("invalid", "That draft does not belong to this mailbox.");
        const files = attachmentFiles(params && params.attachments);
        const html = typeof params.body === "string" ? params.body : "";
        const when = new Date();
        const messageId = (existing && existing.rfc_message_id) || rfcMessageId(account.email);
        const record = {
          id: emailId,
          accountId: account.id,
          folderPath: drafts.path,
          uid: existing ? existing.uid : 0,
          uidValidity: existing ? existing.uid_validity : 0,
          threadId: (params && params.threadId) || emailId,
          rfcMessageId: messageId,
          subject: params.subject || "",
          snippet: plainFromHtml(html).slice(0, 180),
          from: params.fromAddress || account.email,
          to: addrList(params.to),
          cc: addrList(params.cc),
          bcc: addrList(params.bcc),
          date: when.toISOString(),
          listSortTs: when.getTime(),
          unread: false,
          isDraft: true,
          hasAttachments: files.length > 0,
          htmlBody: html,
          textBody: plainFromHtml(html),
          bodyComplete: true,
          inReplyTo: params.inReplyTo || null,
        };
        if (existing) {
          db.updateMessage(emailId, {
            folder_path: drafts.path,
            thread_id: record.threadId,
            subject: record.subject,
            snippet: record.snippet,
            from_addr: record.from,
            rfc_message_id: messageId,
            to_json: JSON.stringify(record.to),
            cc_json: JSON.stringify(record.cc),
            bcc_json: JSON.stringify(record.bcc),
            date_iso: record.date,
            list_sort_ts: record.listSortTs,
            is_draft: 1,
            has_attachments: record.hasAttachments ? 1 : 0,
            html_body: html,
            text_body: record.textBody,
            body_complete: 1,
            in_reply_to: record.inReplyTo,
          });
        } else {
          db.insertMessage(record);
        }
        let remoteSaved = false;
        try {
          await exclusive(account.id, async () => {
            const password = await secretFor(account);
            const raw = await remote.buildRaw({ ...mimeOptions(account, params, files), messageId });
            const appended = await remote.withClient(account, password, async (client) => {
              if (existing && existing.uid) {
                try { await remote.removeUid(client, existing.folder_path, existing.uid); } catch { /* replaced below */ }
              }
              return remote.appendRaw(client, drafts.path, raw, ["\\Draft", "\\Seen"]);
            });
            if (appended && appended.uid) {
              db.updateMessage(emailId, {
                uid: Number(appended.uid),
                uid_validity: Number(appended.uidValidity) || (existing && existing.uid_validity) || 0,
              });
            } else {
              db.updateMessage(emailId, { uid: 0 });
            }
            remoteSaved = true;
          });
        } catch {
          // The draft remains in the local cache when the server append fails.
        }
        emitAccounts();
        return ok({ emailId, draftId: emailId, remoteSaved });
      })();
    case "mail:deleteDraft":
      return (async () => {
        const row = db.messageById(params && params.emailId);
        if (row) {
          try {
            const account = db.accountById(row.account_id);
            if (account && row.uid) {
              await exclusive(account.id, async () => {
                const password = await secretFor(account);
                await remote.withClient(account, password, (client) => remote.removeUid(client, row.folder_path, row.uid));
              });
            }
          } catch {
            // Drop the local row even if the server delete fails.
          }
          db.deleteMessage(row.id);
          emitAccounts();
        }
        return ok(true);
      })();
    case "mail:getPendingDraft":
      return ok(null);
    case "mail:send":
      return deliver(params || {});
    case "mail:scheduleSend":
      return scheduleSend(params || {});
    case "mail:editScheduled":
      return editScheduled(params || {});
    case "mail:cancelScheduled":
      return cancelScheduled(params || {});
    case "mail:downloadAttachment":
      return (async () => {
        try {
          const file = await bytesFor(params || {});
          if (!file) return fail("not-found", "That attachment is no longer available.");
          const { dialog, BrowserWindow } = require("electron");
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
          const picked = await dialog.showSaveDialog(win || undefined, { defaultPath: file.filename });
          if (picked.canceled || !picked.filePath) return fail("cancelled", "cancelled");
          fs.writeFileSync(picked.filePath, file.data);
          return ok({ path: picked.filePath });
        } catch (error) {
          return fail("attachment", remote.explain(error));
        }
      })();
    case "mail:fetchAttachmentBytes":
      return (async () => {
        try {
          const file = await bytesFor(params || {});
          if (!file) return fail("not-found", "That attachment is no longer available.");
          return ok(file.data);
        } catch (error) {
          return fail("attachment", remote.explain(error));
        }
      })();
    case "mail:openAttachmentExternally":
      return (async () => {
        try {
          const file = await bytesFor(params || {});
          if (!file) return fail("not-found", "That attachment is no longer available.");
          const { shell } = require("electron");
          const dir = path.join(os.tmpdir(), "morrow-mail-attachments");
          fs.mkdirSync(dir, { recursive: true });
          const safe = file.filename.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 120) || "attachment";
          const target = path.join(dir, `${Date.now()}-${safe}`);
          fs.writeFileSync(target, file.data);
          const opened = await shell.openPath(target);
          if (opened) return fail("open", opened);
          return ok({ path: target });
        } catch (error) {
          return fail("attachment", remote.explain(error));
        }
      })();
    case "mail:listScheduled":
      return listScheduled(params);
    default:
      return undefined;
  }
}

function messagesForAi(limit = 12) {
  if (!ready || !db.hasAccounts()) return [];
  return db.recentForAi(limit);
}

async function syncAccountById(id, options) {
  const account = db.accountById(id);
  if (!account) return null;
  await syncAccount(account, options || { background: true });
  return publicSync();
}

module.exports = {
  init,
  answer,
  STARRED_FOLDER_ID,
  messagesForAi,
  pumpScheduled,
  startBackgroundSync,
  stopIdle,
  idleSleep,
  idleWake,
  idleOffline,
  idleOnline,
  accountViews,
  dataFile,
  markMissingOAuthSecrets,
  syncGates,
  noteActive,
  syncAccountById,
  syncPolicy: {
    syncDays: SYNC_DAYS,
    headerBatch: HEADER_BATCH,
    outlookBatch: OUTLOOK_BATCH,
    refreshPages: REFRESH_PAGES.slice(),
    pageDelayMs: PAGE_DELAY_MS,
    maxPages: MAX_PAGES,
    tickMs: TICK_MS,
    rateLimitMs: RATE_LIMIT_MS,
    stormMs: STORM_MS,
    pollMs: POLL_MS,
    idleRenewMs: idle.IDLE_RENEW_MS,
    idleSafetyPollMs: idle.IDLE_SAFETY_POLL_MS,
    idleBackoffCapMs: idle.IDLE_BACKOFF_CAP_MS,
    searchLimit: SEARCH_LIMIT,
  },
};
