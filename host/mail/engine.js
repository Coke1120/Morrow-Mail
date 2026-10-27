const { gate: updateGate } = require("../update-quiescence");
const crypto = require("crypto");
const deliveryReceipt = require("./delivery-receipt");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const actions = require("./actions");
const virtuals = require("./virtual-folders");
const presets = require("./presets");
const discovery = require("./discovery");
const remote = require("./remote");
const zipBytes = require("./zip-bytes");
const attachmentTransfers = require("./attachment-cache");
const attachmentCache = attachmentTransfers.createAttachmentCache();
const attachmentRequests = require("./attachment-requests").createAttachmentRequests();

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
const overnight = require("./overnight");
const { createBodyProgress } = require("./body-progress");
const syncRetry = require("../../shared/sync-retry");
const debugLog = require("../debug-log");
const perf = require("../performance-diagnostics");
const composeIdentity = require("./compose-identity");
const textEncoding = require("./text-encoding");
const composePolicy = require("../../shared/compose-policy");
const senderHistory = require("../../shared/sender-history");
const { syncHorizonDays } = require("../settings");
const { planBackgroundFolders } = require("./background-jobs");

const PRIMARY_ORDER = ["all", "inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"];
const STARRED_FOLDER_ID = virtuals.STARRED_ID;
const UNREAD_FOLDER_ID = virtuals.UNREAD_ID;
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
// A completed folder records its horizon: 0 is unlimited, NULL is unknown.
// Read Settings once per sync so a mid-flight change cannot mark a shorter
// download as complete for a larger horizon. Existing cached mail stays.
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
const GMAIL_ALL = remote.GMAIL_ALL_PATHS;

let ready = false;
// One running mailbox job per account. User work (open, flags, manual Sync)
// waits on `user`. Background folder walks, visible-page body fills, and the
// off-hours body fill wait on `background` and run only when no user job is
// queued. A running walk checks between folders and returns so a queued open
// can fetch a body before the next folder. A body fill already inside IMAP
// finishes; the next one waits. Overnight fill does not start while a visible
// prefetch still wants the connection.
const lanes = new Map();
const flagCursors = new Map();
const accountEpochs = new Map();
const ACCOUNT_EPOCH = Symbol("accountEpoch");

function removedAccountError() {
  const error = new Error("This mailbox connection changed or was removed. Refresh before continuing.");
  error.code = "account_removed";
  error.operationIssued = false;
  error.syncReported = true;
  return error;
}

function assertAccountCurrent(account) {
  const current = account && db.accountById(account.id);
  if (!current || current.created_at !== account.created_at
      || (account[ACCOUNT_EPOCH] != null && account[ACCOUNT_EPOCH] !== (accountEpochs.get(account.id) || 0))) throw removedAccountError();
}

function bindAccount(account) {
  if (!account) throw removedAccountError();
  const bound = account[ACCOUNT_EPOCH] == null ? { ...account, [ACCOUNT_EPOCH]: accountEpochs.get(account.id) || 0 } : account;
  assertAccountCurrent(bound);
  return bound;
}

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
  return perf.measure("startup.mail", () => initializeMail());
}

async function initializeMail() {
  await db.open(dataFile());
  db.recoverScheduled();
  ready = true;
  markMissingOAuthSecrets();
  actions.resume();
}

function laneFor(accountId) {
  let lane = lanes.get(accountId);
  if (!lane) {
    lane = { user: [], background: [], active: false };
    lanes.set(accountId, lane);
  }
  return lane;
}

function priorityWaiting(accountId) {
  const lane = lanes.get(accountId);
  return !!(lane && lane.user.length > 0);
}

function drainLane(accountId) {
  const lane = lanes.get(accountId);
  if (!lane || lane.active) return;
  const job = lane.user.shift() || lane.background.shift();
  if (!job) return;
  lane.active = true;
  Promise.resolve()
    .then(job.fn)
    .then(job.settle, job.fail)
    .finally(() => {
      lane.active = false;
      drainLane(accountId);
      pumpBodyFills();
    });
}

function exclusive(accountId, fn, options) {
  // Every call site enters once. A concurrent IPC/sync request is not a nested
  // call and must wait; awaiting exclusive again on this account deadlocks.
  // Pass { background: true } for the rotating folder walk and for body fills
  // that must wait behind an open. That work yields while user work is queued.
  const lane = laneFor(accountId);
  let settle;
  let fail;
  const done = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const epoch = accountEpochs.get(accountId) || 0;
  const job = { fn() {
    if (epoch !== (accountEpochs.get(accountId) || 0)) throw removedAccountError();
    return fn();
  }, settle, fail };
  if (options && options.background) lane.background.push(job);
  else lane.user.push(job);
  drainLane(accountId);
  return done;
}

function mailQueueForTest(accountId) {
  const lane = lanes.get(accountId);
  if (!lane) return { user: 0, background: 0, active: false };
  return { user: lane.user.length, background: lane.background.length, active: lane.active === true };
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

function accountView(row, index) {
  const folders = db.foldersFor(row.id);
  const primary = [];
  const more = [];
  for (const folder of folders) {
    const well = remote.isAllMail(folder) ? "all" : folder.well_known;
    const view = {
      id: folder.path,
      name: remote.isAllMail(folder) ? remote.allMailLabel(folder) : folder.name,
      wellKnownName: well,
      unreadCount: folder.unread || 0,
      totalCount: folder.total || 0,
      type: well ? "system" : "user",
      children: [],
    };
    if (well && PRIMARY_ORDER.includes(well)) primary.push(view);
    else more.push(view);
  }
  primary.sort((a, b) => PRIMARY_ORDER.indexOf(a.wellKnownName) - PRIMARY_ORDER.indexOf(b.wellKnownName));
  virtuals.place(primary, more, row.id);
  const view = {
    id: row.id,
    email: row.email,
    displayEmail: row.email,
    senderName: row.display_name || null,
    defaultSenderName: row.display_name || null,
    ...composeIdentity.accountIdentity(row),
    name: row.display_name || null,
    label: row.label || null,
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
    mailTransport: row.mail_transport || "imap",
    gmailMigrationAvailable: row.profile === "gmail" && row.auth_kind === "oauth2" && row.mail_transport !== "gmail_api",
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
  const out = {
    id: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size || 0,
    contentId: item.contentId || null,
    isInlineFromApi: item.isInlineFromApi === true,
  };
  if (typeof item.storageUrl === "string" && item.storageUrl.startsWith("local:")) out.storageUrl = item.storageUrl;
  return out;
}

function listRow(row) {
  const attachments = db.jsonList(row.attachments_json).map(publicAttachment);
  const recipientHeaders = JSON.parse(row.recipient_headers_json || "{}");
  const sender = row.from_address || row.from_addr || "";
  const parsedAddress = composePolicy.address(sender);
  const bareSender = parsedAddress && parsedAddress === sender.trim().toLowerCase() ? parsedAddress : "";
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    conversationId: row.thread_id,
    folderId: row.folder_path,
    folders: [row.folder_path],
    subject: textEncoding.repairMojibake(row.subject || ""),
    snippet: textEncoding.repairMojibake(row.snippet || ""),
    from: row.from_display_name && bareSender ? composePolicy.senderPreview(bareSender, row.from_display_name) : row.from_addr || "",
    to: db.jsonList(row.to_json),
    cc: db.jsonList(row.cc_json),
    bcc: db.jsonList(row.bcc_json),
    date: row.date_iso,
    listSortTs: row.list_sort_ts,
    unread: row.unread === 1,
    isRead: row.unread !== 1,
    isStarred: row.starred === 1,
    actionGeneration: actions.generationOf(row.id),
    isDraft: row.is_draft === 1,
    hasAttachments: row.has_attachments === 1,
    unifiedCategory: "primary",
    providerCategory: "primary",
    platform: "imap",
    attachments,
    messageId: row.rfc_message_id || null,
    inReplyTo: row.in_reply_to || null,
    recipientHeaders,
    replyTo: recipientHeaders.replyTo || [],
    bodyWarning: row.body_warning || "",
    bodyComplete: row.body_complete === 1,
    hasBody: usableStoredBody(row),
  };
}

function detailOf(row) {
  const presented = textEncoding.presentMessage({
    subject: row.subject || "",
    htmlBody: row.html_body,
    textBody: row.text_body,
  });
  return {
    ...listRow(row),
    subject: presented.subject,
    htmlBody: presented.htmlBody,
    textBody: presented.textBody,
    fromAddress: composeIdentity.savedAddress(row),
    ...(row.is_draft ? { draftRevision: db.draftRevision(row), draftPending: !!row.draft_pending,
      fromDisplayName: composeIdentity.savedName(row) } : {}),
  };
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
  let out = {
    accountId: query.accountId || null,
    folderId: query.folderId || null,
    folderKey: query.folderKey || null,
    mailboxes: Array.isArray(query.mailboxes) ? query.mailboxes : null,
    category: query.category || "all",
    filterUnread: query.filterUnread === true,
    filterFlagged: query.filterFlagged === true,
    filterAttachments: query.filterAttachments,
    limit: query.limit,
    offset: query.offset,
  };
  out = virtuals.apply(out);
  if (!out.folderKey && out.folderId && !out.accountId && KEY_TO_WELL[out.folderId]) {
    out.folderKey = out.folderId;
    out.folderId = null;
  }
  if (query.beforeDate) {
    const ts = Date.parse(query.beforeDate);
    if (Number.isFinite(ts)) out.beforeTs = ts;
  }
  return out;
}

function windowOpen(folder, days = syncHorizonDays()) {
  if (!folder || Number(folder.window_done) !== 1) return false;
  if (folder.sync_horizon_days == null) return false;
  const horizon = Number(folder.sync_horizon_days);
  return Number.isFinite(horizon) && (horizon === 0 || (days !== 0 && horizon >= days));
}

function foldersInScope(query) {
  const source = query || {};
  const explicit = Array.isArray(source.mailboxes) ? source.mailboxes : [];
  let boxes = null;
  if (source.folderKey === "primary") boxes = explicit.length ? explicit : db.primaryMailboxes();
  else if (!source.folderKey && !source.folderId && explicit.length) boxes = explicit;
  if (boxes) {
    return boxes
      .map((entry) => db.folderByPath(entry.accountId || entry.account_id, entry.path))
      .filter(Boolean);
  }
  if (source.folderKey) {
    return db.pathsForKey(source.accountId, source.folderKey).map((entry) => db.folderByPath(entry.account_id, entry.path));
  }
  if (source.accountId && source.folderId) return [db.folderByPath(source.accountId, source.folderId)];
  return [];
}

function serverHasMore(query, days) {
  return foldersInScope(query).some((folder) => folder && !windowOpen(folder, days));
}

function synced(query, days) {
  const folders = foldersInScope(query);
  if (!folders.length) return true;
  return folders.every((folder) => windowOpen(folder, days));
}

function listPayload(params) {
  const query = queryFrom(params);
  const rows = db.selectMessages(query, { headersOnly: true }).map(listRow);
  const total = db.countMessages(query);
  const offset = Number.isFinite(Number(query.offset)) ? Math.max(Math.floor(Number(query.offset)), 0) : 0;
  const days = syncHorizonDays();
  const oldest = db.oldestTs(query);
  const moreInCache = offset + rows.length < total;
  const more = moreInCache || serverHasMore(query, days);
  return {
    emails: rows,
    threads: threadMeta(rows),
    hasMore: more,
    hasMoreBelow: more,
    hasMoreInCache: moreInCache,
    truncated: false,
    total,
    syncedOldestDateTs: oldest,
    initialSyncDone: synced(query, days),
    pageToken: more ? String(oldest || offset) : null,
    geometry: { total, aboveTop: offset },
  };
}

function cachedList(params) {
  const payload = listPayload(params);
  scheduleVisibleBodyPrefetch(payload.emails);
  return { ...payload, sync: publicSync(params) };
}

async function secretFor(account) {
  const stored = secrets.getPassword(account.id);
  if (!stored) {
    const error = new Error("The password for this account is not in the keychain. Connect the account again.");
    error.code = "auth";
    throw error;
  }
  if (account.auth_kind !== "oauth2") return stored;
  if (account.mail_transport === "gmail_api") {
    let grant; try { grant = JSON.parse(stored); } catch { grant = {}; }
    if (!oauthConfig.hasPurposeScopes(grant.grantedScopes || "", "google", "imap")) throw Object.assign(new Error("Gmail API mail permission is missing. Reconnect Google; cached work was retained."), { code: "scope_missing" });
  }
  const result = await oauth.accessTokenFor(account, stored, "imap");
  if (secrets.getPassword(account.id) !== stored) {
    const error = new Error("This mailbox connection changed. Try again with the current connection.");
    error.code = "conflict";
    throw error;
  }
  if (typeof result === "string") return result;
  if (result && result.store) {
    if (account.mail_transport === "gmail_api" && !oauthConfig.hasPurposeScopes(JSON.parse(result.store).grantedScopes || "", "google", "imap")) throw Object.assign(new Error("The refreshed Google grant is missing Gmail API mail permission. Reauthorize the mailbox."), { code: "scope_missing" });
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
const backgroundCursor = new Map();
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
  retrying: false,
  retryAt: null,
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
    const described = virtuals.get(folderId);
    if (described) {
      if (!folderLabel) folderLabel = described.name;
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
    retrying: state === "error" && !!(extra && extra.retrying),
    retryAt: state === "error" && extra && extra.retryAt ? extra.retryAt : null,
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
  const described = virtuals.get(folderId);
  if (described) {
    return {
      ...syncLabels(params),
      state: "idle",
      phase: "idle",
      message: described.syncMessage,
      lastSuccessAt: null,
      lastError: "",
    };
  }
  if (!accountId || !folderId) return { ...syncState };
  const saved = syncScopes.get(JSON.stringify([accountId, folderId]));
  const gate = syncGates.get(accountId);
  if (gate && gate.until > Date.now()) return { ...(saved || {}), ...syncLabels(params), state: "paused", message: "Paused by the provider", retryAt: gate.until, retrying: false };
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

function windowStart(days, now = Date.now()) {
  return days === 0 ? null : now - days * DAY_MS;
}

function pageDelayMs() {
  const raw = process.env.MORROW_PAGE_DELAY_MS;
  if (raw != null && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return PAGE_DELAY_MS;
}

function tickMs() {
  const raw = process.env.MORROW_SYNC_TICK_MS;
  if (raw != null && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return TICK_MS;
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

function explainSyncError(account, error, secret) {
  let hidden = secret || "";
  if (!hidden && account && account.id) {
    try { hidden = secrets.getPassword(account.id) || ""; } catch { hidden = ""; }
  }
  return remote.explain(error, hidden, account);
}

// One schedule per failure. The folder catch sets syncReported before rethrowing
// so an outer catch does not consume the next delay. The mark stays on that
// throw only as a signal; a later attempt may reuse the same Error object.
function planSyncFailure(account, error, secret) {
  if (!account || !account.id) return { kind: "none", message: remote.explain(error) };
  if (http.isRateLimit(error)) return { kind: "rate", message: "Paused for rate limit" };
  const message = explainSyncError(account, error, secret);
  if (account.auth_error || syncRetry.isStickyAuthSyncError(message, error)) {
    syncRetryScheduler.clear(account.id);
    if (!account.auth_error) db.setAuthError(account.id, message);
    return { kind: "auth", message: account.auth_error || message };
  }
  const scheduled = syncRetryScheduler.noteFailure(account.id, message, { stickyAuth: false });
  return {
    kind: "error",
    message,
    retrying: scheduled.retry === true,
    retryAt: scheduled.retryAt,
    exhausted: scheduled.exhausted === true,
  };
}

function reportSyncFailure(account, error, extra) {
  const plan = planSyncFailure(account, error, extra && extra.secret);
  if (plan.kind === "rate") {
    if (account && account.id) {
      noteRateLimit(account.id, error);
      syncRetryScheduler.clear(account.id);
    }
    return plan;
  }
  if (plan.kind !== "error") {
    if (plan.kind === "auth" && extra && extra.emitAuth && account && account.id && syncState.state !== "paused") {
      emitSync("error", {
        accountId: account.id,
        folderId: extra.folderId,
        message: plan.message,
        retrying: false,
      });
    }
    return plan;
  }
  if (!account || !account.id || syncState.state === "paused") return plan;
  emitSync("error", {
    accountId: account.id,
    folderId: extra && extra.folderId,
    message: plan.message,
    retrying: plan.retrying,
    retryAt: plan.retryAt,
  });
  return plan;
}

function localInboxRules(account) {
  return inboxRules.backendFor(account) === "imap";
}

function resetWindow(accountId, folderPath, found) {
  flagCursors.delete(JSON.stringify([accountId, folderPath]));
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

async function bootstrapFolder(client, account, folderPath, started, days, limits) {
  const start = windowStart(days, started);
  const criteria = start == null ? { all: true } : { since: new Date(start) };
  const size = batchSize(account);
  const pageCap = limits && limits.oneBatch ? 1 : MAX_PAGES;
  const deadline = limits && Number.isFinite(limits.deadline) ? limits.deadline : started + tickMs();
  let pages = 0;
  while (pages < pageCap) {
    assertAccountCurrent(account);
    if (pages > 0 && Date.now() >= deadline) break;
    const found = await remote.searchUids(client, folderPath, criteria);
    assertAccountCurrent(account);
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
        retainOlderThan: start,
        windowDone: true,
        horizonDays: days,
        uidCursor: cursor,
      });
      return { paused: false, bootstrapped: true };
    }
    if (pages > 0) await sleep(pageDelayMs());
    assertAccountCurrent(account);
    const page = missing.slice(0, size);
    const fetched = await remote.fetchMessages(client, folderPath, page);
    assertAccountCurrent(account);
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
      retainOlderThan: start,
      windowDone: finished,
      ...(finished ? { horizonDays: days } : {}),
      uidCursor: finished ? cursor : highest,
    });
    emitFolderSync(account.id, folderPath, true);
    broadcast("mail:emailsUpdated", { accountId: account.id, folderId: folderPath, folderIds: [folderPath] });
    pages += 1;
    if (missing.length <= size) return { paused: false, bootstrapped: true };
  }
  return { paused: false, bootstrapped: false };
}

async function warmFolder(client, account, folder, started, days, limits) {
  let next = Number(folder.uid_cursor) || 0;
  const start = windowStart(days, started);
  const criteria = start == null ? {} : { since: new Date(start) };
  const pageCap = limits && limits.oneBatch ? 1 : REFRESH_PAGES.length;
  const deadline = limits && Number.isFinite(limits.deadline) ? limits.deadline : started + tickMs();
  let backlog = false;
  for (let index = 0; index < pageCap; index += 1) {
    assertAccountCurrent(account);
    if (index > 0 && Date.now() >= deadline) break;
    const found = await remote.searchUids(client, folder.path, { uid: `${next + 1}:*`, ...criteria });
    assertAccountCurrent(account);
    if (folder.uid_validity && found.validity && folder.uid_validity !== found.validity) {
      resetWindow(account.id, folder.path, found);
      noteStorm(account.id);
      return { paused: true, bootstrapped: false };
    }
    const fresh = found.uids.filter((uid) => uid > next).sort((a, b) => a - b);
    if (!fresh.length) break;
    if (index > 0) await sleep(pageDelayMs());
    assertAccountCurrent(account);
    const page = fresh.slice(0, REFRESH_PAGES[index]);
    const fetched = await remote.fetchMessages(client, folder.path, page);
    assertAccountCurrent(account);
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
    if (fresh.length > REFRESH_PAGES[index]) backlog = true;
    if (fresh.length <= REFRESH_PAGES[index]) break;
  }
  // A background turn stops after one batch when newer mail is still waiting,
  // so the next folder can run inside this tick. A caught-up folder still
  // reconciles so deletes and counts stay current.
  if (backlog && limits && limits.oneBatch) return { paused: false, bootstrapped: true };
  const flagKey = JSON.stringify([account.id, folder.path]);
  const priorFlags = flagCursors.get(flagKey);
  const beforeUid = priorFlags && priorFlags.validity === folder.uid_validity ? priorFlags.uid : 0;
  let flagUids = db.flagUidsFor(account.id, folder.path, folder.uid_validity, beforeUid);
  if (!flagUids.length && beforeUid) flagUids = db.flagUidsFor(account.id, folder.path, folder.uid_validity);
  const live = await remote.searchUids(client, folder.path, criteria, { uids: flagUids, validity: folder.uid_validity });
  assertAccountCurrent(account);
  if (folder.uid_validity && live.validity && folder.uid_validity !== live.validity) {
    resetWindow(account.id, folder.path, live);
    noteStorm(account.id);
    return { paused: true, bootstrapped: false };
  }
  // applyFolderSync prunes and updates the cursor/counts in one transaction.
  const flagsChanged = db.applyFolderSync(account.id, folder.path, {
    messages: [],
    validity: live.validity,
    flags: live.flags,
    exists: live.exists,
    unseen: live.unseen,
    uids: live.uids,
    retainOlderThan: start,
    windowDone: true,
    horizonDays: days,
    uidCursor: next,
  });
  if (flagUids.length && Array.isArray(live.flags)) {
    flagCursors.set(flagKey, { validity: live.validity, uid: flagUids[flagUids.length - 1] });
  }
  if (flagsChanged) broadcast("mail:emailsUpdated", { accountId: account.id, folderId: folder.path, folderIds: [folder.path] });
  return { paused: false, bootstrapped: true };
}

async function syncFolderPolicy(client, account, folderPath, limits) {
  const days = syncHorizonDays();
  if (!gateOpen(account.id)) {
    emitSync("paused", { accountId: account.id, folderId: folderPath, message: "Paused for rate limit" });
    return { paused: true, bootstrapped: false };
  }
  let phase = "fetching";
  try {
    const known = db.folderByPath(account.id, folderPath);
    if (known && windowOpen(known, days)) phase = "refreshing";
  } catch {
    phase = "fetching";
  }
  emitSync("syncing", { accountId: account.id, folderId: folderPath, phase });
  const started = Date.now();
  const bounds = {
    oneBatch: !!(limits && limits.oneBatch),
    deadline: limits && Number.isFinite(limits.deadline) ? limits.deadline : started + tickMs(),
  };
  try {
    const folder = db.folderByPath(account.id, folderPath);
    if (client.gmail) {
      const result = await client.gmail.sync(folderPath, { horizonDays: days, limit: batchSize(account) });
      assertAccountCurrent(account);
      clearStrikes(account.id);
      emitFolderSync(account.id, folderPath, result.bootstrapped);
      broadcast("mail:emailsUpdated", { accountId: account.id, folderId: folderPath, folderIds: [folderPath] });
      if (result.bootstrapped) emitSync("done", { accountId: account.id, folderId: folderPath });
      return result;
    }
    const result = folder && windowOpen(folder, days)
      ? await warmFolder(client, account, folder, started, days, bounds)
      : await bootstrapFolder(client, account, folderPath, started, days, bounds);
    if (!result.paused) clearStrikes(account.id);
    if (!result.paused && result.bootstrapped) emitSync("done", { accountId: account.id, folderId: folderPath });
    return result;
  } catch (error) {
    assertAccountCurrent(account);
    if (error?.code === "account_removed") throw error;
    const plan = reportSyncFailure(account, error, { folderId: folderPath, emitAuth: true });
    if (plan.kind === "rate") return { paused: true, bootstrapped: false };
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
  account = bindAccount(account);
  return updateGate.run(() => syncFolderPathAdmitted(account, folderPath)).catch(error => {
    assertAccountCurrent(account);
    throw error;
  });
}

async function syncFolderPathAdmitted(account, folderPath) {
  return exclusive(account.id, async () => {
    assertAccountCurrent(account);
    const password = await secretFor(account);
    const result = await remote.withClient(account, password, (client) => syncFolderPolicy(client, account, folderPath));
    assertAccountCurrent(account);
    finishSync([folderPath], result && result.paused, result && result.bootstrapped, account.id);
    return result;
  });
}

function jobFolders(folders, options) {
  const inbox = folders.find((folder) => folder.well_known === "inbox");
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
  account = bindAccount(account);
  return updateGate.run(() => syncAccountAdmitted(account, options)).catch(error => {
    assertAccountCurrent(account);
    throw error;
  });
}

async function syncAccountAdmitted(account, options) {
  assertAccountCurrent(account);
  if (!gateOpen(account.id)) {
    emitSync("paused", { accountId: account.id, message: "Paused for rate limit" });
    return;
  }
  const password = await secretFor(account);
  const background = !!(options && options.background);
  const deadline = Date.now() + tickMs();
  // One pass keeps its folder list and visited set across yields. The cursor
  // is the same one a single exclusive walk would have saved.
  let jobs = null;
  let plan = null;
  const visited = new Set();
  let paused = false;
  let pausedPath = "";
  let incomplete = false;
  while (true) {
    let yielded = false;
    await exclusive(account.id, async () => {
      assertAccountCurrent(account);
      if (!gateOpen(account.id)) {
        emitSync("paused", { accountId: account.id, message: "Paused for rate limit" });
        paused = true;
        return;
      }
      // The in-flight folder batch finishes before this runs again. A waiting
      // open then takes the only connection. The rest of the pass continues
      // only while this tick still has time.
      if (background && visited.size > 0 && Date.now() >= deadline) return;
      if (background && priorityWaiting(account.id)) {
        yielded = true;
        return;
      }
      await remote.withClient(account, password, async (client) => {
        if (!jobs) {
          emitSync("syncing", { accountId: account.id, phase: "listing" });
          const listed = await remote.listFolderRecords(client);
          assertAccountCurrent(account);
          db.replaceFolders(account.id, listed.folders, listed.delimiter);
          const folders = db.foldersFor(account.id).filter(folder => account.mail_transport !== "gmail_api" || folder.provider_id);
          if (background) {
            plan = planBackgroundFolders(folders, activeFolder.get(account.id), backgroundCursor.get(account.id) || 0);
            jobs = plan.jobs;
          } else {
            jobs = jobFolders(folders, options);
          }
        }
        for (const folder of jobs) {
          if (visited.has(folder.path)) continue;
          if (background && priorityWaiting(account.id)) {
            yielded = true;
            break;
          }
          if (background && visited.size > 0 && Date.now() >= deadline) break;
          const result = await syncFolderPolicy(
            client,
            account,
            folder.path,
            background ? { oneBatch: true, deadline } : null,
          );
          visited.add(folder.path);
          if (result && result.paused) {
            paused = true;
            pausedPath = folder.path;
            break;
          }
          if (!result || !result.bootstrapped) incomplete = true;
        }
        if (background && plan) {
          backgroundCursor.set(account.id, pausedPath ? plan.cursorFor(pausedPath) : plan.nextCursor(visited));
        }
      });
      const passDone = !!(jobs && jobs.length && visited.size === jobs.length && !incomplete);
      assertAccountCurrent(account);
      finishSync(jobs || [], paused, passDone, account.id);
      if (!paused) {
        db.clearAuthError(account.id);
        syncRetryScheduler.noteSuccess(account.id);
      }
    }, background ? { background: true } : undefined);
    if (!background || !yielded || paused) break;
  }
}

async function syncAllForTest(options) {
  return syncAll(options || { background: true });
}

async function syncAll(options) {
  return updateGate.run(() => syncAllAdmitted(options));
}

async function syncAllAdmitted(options) {
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
    // A sticky sign-in failure waits for reconnect. The 45s poll must not keep
    // opening the mailbox or refreshing a rejected token.
    if (account.auth_error) {
      syncRetryScheduler.clear(account.id);
      continue;
    }
    try {
      await syncAccount(account, scope);
    } catch (error) {
      if (error && error.syncReported) continue;
      reportSyncFailure(account, error);
    }
  }
  if (scope.background) {
    try { await fillOvernightBodies(); } catch { /* one body must not stop the next poll */ }
  }
  emitAccounts();
}

let pollTimer = null;
let scheduleTimer = null;
let syncing = false;
const syncRetryScheduler = syncRetry.createRetryScheduler({
  delays: syncRetry.SYNC_RETRY_DELAYS_MS,
  onRetry: (accountId) => runBackgroundRetry(accountId),
});
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
        if (!error || !error.syncReported) reportSyncFailure(row, error, { folderId: folderPath, emitAuth: true });
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
  bodySleeping = true;
  bodyProgress.changed();
  if (idleController) idleController.sleep();
}

function idleWake() {
  bodySleeping = false;
  bodyProgress.changed();
  if (idleController && idleController.wake) idleController.wake();
}

function idleOffline() {
  bodyOnline = false;
  bodyProgress.changed();
  if (idleController) idleController.offline();
}

function idleOnline() {
  bodyOnline = true;
  bodyProgress.changed();
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

function runBackgroundRetry(accountId) {
  if (!ready || !accountId) return;
  const account = db.accountById(accountId);
  if (!account || account.auth_error) {
    syncRetryScheduler.clear(accountId);
    return;
  }
  if (!gateOpen(accountId)) {
    const gate = syncGates.get(accountId);
    const wait = Math.max(1000, (gate && gate.until ? gate.until : Date.now() + 1000) - Date.now());
    syncRetryScheduler.hold(accountId, wait);
    return;
  }
  if (syncing) {
    syncRetryScheduler.hold(accountId, 1000);
    return;
  }
  syncing = true;
  syncAccount(account, { background: true }).catch((error) => {
    if (!error || !error.syncReported) reportSyncFailure(account, error);
  }).finally(() => {
    syncing = false;
    try { emitAccounts(); } catch { /* the window may already be gone */ }
  });
}

function startBackgroundSync() {
  if (!ready) return;
  const tick = () => {
    if (syncing || !db.hasAccounts()) return;
    syncing = true;
    syncAll({ background: true }).catch(() => {}).finally(() => {
      syncing = false;
      bodyProgress.changed();
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
  if (error && error.syncReported) return;
  const account = db.accountById(id);
  if (!account) return;
  reportSyncFailure(account, error, { secret });
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

async function connectOAuthAccount(providerInput, expectedAccountId, options = {}) {
  const gen = ++oauthGeneration;
  // OAuth reveals the email only after sign-in. Pin every currently connected
  // incarnation so an implicit same-email reconnect cannot become a fresh add
  // if that mailbox is removed while the browser is open.
  const reconnects = db.listAccountRows().map(bindAccount);
  const expected = expectedAccountId ? reconnects.find(row => row.id === expectedAccountId) : null;
  if (expectedAccountId && !expected) return fail("account_mismatch", "Sign in with the mailbox named in Reconnect. Existing accounts and credentials are unchanged.");
  if (expected?.profile === "gmail" && expected.auth_kind === "oauth2" && expected.mail_transport !== "gmail_api" && options.migrateGmail !== true) {
    return fail("gmail_migration_required", "Review Migrate Gmail to Gmail API in Settings → Accounts first. Google OAuth remains available; cached mail and drafts stay in this account.");
  }
  const expectedSecret = expected ? secrets.getPassword(expected.id) : null;
  let signed;
  try {
    signed = await oauth.signIn(providerInput, oauthConfig.providerKey(providerInput) === "google" ? "bundle" : "imap", { expectedEmail: expected?.email });
  } catch (error) {
    if (error && error.code === "oauth_cancelled") return fail("oauth_cancelled", "Sign-in canceled.");
    return fail("oauth", error instanceof Error ? error.message : String(error));
  }
  if (gen !== oauthGeneration) {
    finishOAuthPage(signed, false, "Sign-in canceled.");
    return fail("oauth_cancelled", "Sign-in canceled.");
  }
  if (expectedAccountId) {
    if (expected.email.toLowerCase() !== String(signed.email).toLowerCase()) {
      finishOAuthPage(signed, false, "Sign-in did not match the mailbox being reconnected.");
      return fail("account_mismatch", "Sign in with the mailbox named in Reconnect. Existing accounts and credentials are unchanged.");
    }
  }
  const reconnect = expected || reconnects.find(row => row.email.toLowerCase() === String(signed.email).toLowerCase());
  try {
    if (reconnect) assertAccountCurrent(reconnect);
  } catch (error) {
    finishOAuthPage(signed, false, error.message);
    return fail("account_removed", error.message);
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
  if (existing?.profile === "gmail" && existing.auth_kind === "oauth2" && existing.mail_transport !== "gmail_api" && options.migrateGmail !== true) {
    finishOAuthPage(signed, false, "Review Gmail API migration in Settings → Accounts. Existing mail and credentials were retained.");
    return fail("gmail_migration_required", "Review Gmail API migration in Settings → Accounts. Existing mail and credentials were retained.");
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
  let detachedDrafts = 0;
  try {
    await exclusive(id, () => {
    if (gen !== oauthGeneration) throw Object.assign(new Error("Sign-in canceled. The current connection was retained."), { code: "oauth_cancelled" });
    if (reconnect) assertAccountCurrent(reconnect);
    if (expected && secrets.getPassword(id) !== expectedSecret) throw Object.assign(new Error("The mailbox credentials changed during sign-in. Retry for the current connection."), { code: "conflict" });
    if (signed.provider === "google" && existing && db.gmailMigrationBlockers(id)) throw Object.assign(new Error("Finish or resolve pending mail actions before migrating Gmail."), { code: "conflict" });
    if (signed.provider === "google" && existing) {
      // Keep separately granted features without claiming a union of token scopes.
      for (const purpose of ["calendar", "organize", "rules", "vacation"]) {
        const key = `${id}:${purpose}`;
        if (oauthConfig.hasPurposeScopes(signed.grantedScopes, "google", purpose)) {
          if (secrets.getPassword(key)) writes.push([key, null]);
          continue;
        }
        const legacy = [key, `${id}:bundle`, id].map(name => secrets.getPassword(name)).find(raw => {
          try { return oauthConfig.hasPurposeScopes(JSON.parse(raw).grantedScopes || "", "google", purpose); } catch { return false; }
        });
        if (legacy) writes.push([key, legacy]);
      }
      if (secrets.getPassword(`${id}:bundle`)) writes.push([`${id}:bundle`, null]);
    }
    for (const [key] of writes) previous.set(key, secrets.getPassword(key));
    for (const [key, value] of writes) {
      written.push(key);
      if (value == null) secrets.deletePassword(key); else secrets.setPassword(key, value);
    }
    stage = "storage";
    db.transaction(() => {
      if (existing) db.updateAccountLogin(id, login);
      else db.insertAccount({
        id,
        email: draft.email,
        ...login,
        delimiter: "/",
        createdAt: Date.now(),
      });
      if (signed.provider === "google") detachedDrafts = db.enableGmail(id);
    });
    if (existing) { invalidateAttachmentAccount(id); composeIdentity.invalidate(id); }
    oauthCommitted.add(id);
    syncRetryScheduler.clear(id);
    });
  } catch (error) {
    let restored = true;
    for (const key of written.reverse()) {
      try {
        if (previous.get(key) == null) secrets.deletePassword(key);
        else secrets.setPassword(key, previous.get(key));
      } catch { restored = false; }
    }
    const message = ["conflict", "oauth_cancelled"].includes(error?.code) ? error.message : restored
      ? (stage === "keychain" ? "Could not save credentials. Previous credentials were restored." : "Could not save this account. Previous credentials were restored.")
      : "Could not restore all credentials after a storage failure. Reconnect the mailbox.";
    finishOAuthPage(signed, false, message);
    return fail(["conflict", "oauth_cancelled"].includes(error?.code) ? error.code : stage, message);
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
  const missing = (signed.provider === "google" ? ["organize", "vacation", "rules"] : ["calendar", "organize", "vacation", "rules"]).filter((purpose) => !sidecar.gateAccount(current, purpose).ok);
  if (missing.length && !grantWarning) grantWarning = "Some feature permissions were not granted. Enable the missing features to try again.";
  if (detachedDrafts) grantWarning += `${grantWarning ? " " : ""}${detachedDrafts} unuploaded draft edit(s) were kept locally. Save them again; an earlier server copy may remain.`;
  if (signed.provider === "google" && oauthConfig.hasScopes(signed.grantedScopes || "", "https://mail.google.com/")) grantWarning += `${grantWarning ? " " : ""}Google returned an existing broad mail grant. The request is narrower, but this granted permission has not been narrowed. Review Google app access before deliberately revoking and reconnecting.`;
  if (signed.provider === "google" && idleController) await idleController.forget(id).catch(() => {});
  emitAccounts({ activeAccountId: id, folderId: "" });
  watchIdle();
  setTimeout(() => {
    settleOAuthMailbox(id).catch(() => {});
  }, 0);
  return ok({ ...accountView(current, 0), grantWarning, missingPermissions: missing });
}

async function discoverMail(params) {
  const email = params && typeof params.email === "string" ? params.email : "";
  try {
    return ok(await discovery.discover(email));
  } catch {
    return ok(null);
  }
}

async function connectAccount(params) {
  const email = params && typeof params.email === "string" ? params.email.trim() : "";
  const selected = params.expectedAccountId ? db.accountById(params.expectedAccountId) : db.accountByEmail(email);
  if (params.expectedAccountId) {
    if (!selected || selected.email.toLowerCase() !== email.toLowerCase()) return fail("account_mismatch", "Reconnect must use the selected mailbox address. Cached work is unchanged.");
  }
  const reconnect = selected ? bindAccount(selected) : null;
  let profile = params && params.profile ? String(params.profile) : "custom";
  const typedUsername = params && typeof params.username === "string" ? params.username : "";
  const password = params && typeof params.password === "string" ? params.password : "";
  if (!email.includes("@")) return fail("invalid", "Enter the email address for this account.");
  if (!password) return fail("invalid", "Enter the password or app password.");
  profile = discovery.chosenProfile(profile, email);
  const username = discovery.loginName(profile, email, typedUsername);
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
    if (reconnect) assertAccountCurrent(reconnect);
    try {
      await remote.verifySmtp(draft, password);
    } catch (error) {
      const message = remote.explain(error, password, draft);
      if (/rejected the password/i.test(message)) throw error;
    }
    // No await between this check and the account/credential commits below.
    if (reconnect) assertAccountCurrent(reconnect);
  } catch (error) {
    return fail(error?.code === "account_removed" ? "account_removed" : "auth", remote.explain(error, password, draft));
  }
  const existing = db.accountByEmail(email);
  const id = existing ? existing.id : draft.id;
  const login = {
    username, profile, authKind: "password",
    imapHost: draft.imap_host,
    imapPort: draft.imap_port,
    imapTls: draft.imap_tls === 1,
    smtpHost: draft.smtp_host,
    smtpPort: draft.smtp_port,
    smtpTls: draft.smtp_tls === 1,
  };
  let previous;
  let attempted = false;
  let stage = "keychain";
  // Credential storage and SQLite cannot share a transaction. Keep this block
  // synchronous so compensation cannot undo a later reconnect/refresh, and
  // commit the login kind, servers and folder changes together only after save.
  try {
    previous = secrets.getPassword(id);
    attempted = true; // A backend may write successfully before throwing.
    secrets.setPassword(id, password);
    stage = "storage";
    db.transaction(() => {
      if (existing) db.updateAccountLogin(id, login);
      else db.insertAccount({ id, email, ...login, delimiter: draft.delimiter || "/", createdAt: Date.now() });
      db.setMailTransport(id, "imap");
      db.replaceFolders(id, draft.folders || [], draft.delimiter || "/");
    });
    if (existing) { invalidateAttachmentAccount(id); composeIdentity.invalidate(id); }
  } catch (error) {
    let restored = true;
    if (attempted) {
      try {
        if (previous == null) secrets.deletePassword(id);
        else secrets.setPassword(id, previous);
      } catch { restored = false; }
    }
    const message = error?.storageUncertain
      ? "Account storage could not be confirmed. Restart Morrow Mail and reconnect the mailbox."
      : !restored ? "Could not restore credentials after a storage failure. Reconnect the mailbox."
        : !attempted ? "Could not read saved credentials. This account was not changed."
          : stage === "keychain" ? "Could not save credentials. Previous account settings and credentials were retained."
            : "Could not save this account. Previous account settings and credentials were restored.";
    return fail(stage, message);
  }
  syncRetryScheduler.clear(id);
  const account = db.accountById(id);
  const inbox = db.folderByWellKnown(id, "inbox");
  if (inbox) {
    noteActive(id, inbox.path);
    try {
      await syncFolderPath(account, inbox.path);
    } catch (error) {
      if (http.isRateLimit(error)) noteRateLimit(id, error);
      else {
        const message = remote.explain(error, password, account);
        db.setAuthError(id, message);
        syncRetryScheduler.clear(id);
        emitSync("error", { accountId: id, message, retrying: false });
      }
    }
  }
  emitAccounts();
  watchIdle();
  setTimeout(() => {
    const row = db.accountById(id);
    if (!row) return;
    syncAccount(row, { background: true }).then(() => emitAccounts()).catch((error) => {
      if (!error || !error.syncReported) reportSyncFailure(row, error);
      emitAccounts();
    });
  }, 200);
  const view = accountView(db.accountById(id), 0);
  return ok(view);
}

function invalidateAttachmentAccount(id) {
  accountEpochs.set(id, (accountEpochs.get(id) || 0) + 1);
  const error = removedAccountError();
  attachmentRequests.invalidateAccount(id, error);
  attachmentCache.invalidateAccount(id, error);
}

async function removeAccount(params) {
  const id = params && (params.accountId || params.id);
  if (!id || !db.accountById(id)) return undefined;
  composeIdentity.invalidate(id);
  invalidateAttachmentAccount(id);
  secrets.deletePassword(id);
  secrets.deletePassword(`${id}:organize`);
  secrets.deletePassword(`${id}:calendar`);
  secrets.deletePassword(`${id}:rules`);
  secrets.deletePassword(`${id}:vacation`);
  secrets.deletePassword(`${id}:bundle`);
  idleSafetyAt.delete(id);
  idleReported.delete(id);
  backgroundCursor.delete(id);
  for (const key of flagCursors.keys()) if (JSON.parse(key)[0] === id) flagCursors.delete(key);
  activeFolder.delete(id);
  const lane = lanes.get(id);
  if (lane && !lane.active && !lane.user.length && !lane.background.length) lanes.delete(id);
  syncRetryScheduler.clear(id);
  db.removeAccount(id);
  emitAccounts();
  if (idleController) {
    try { await idleController.forget(id); } catch { /* the connection is already gone */ }
  }
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

const ATTACHMENT_CAP = 25 * 1024 * 1024;

function formatAttachmentSize(size) {
  const n = Number(size) || 0;
  if (n > ATTACHMENT_CAP) return "over 25 MB";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / 1048576;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function attachmentLimitCopy(account) {
  const profile = String((account && (account.profile || account.imapSmtpProfile)) || "").toLowerCase();
  if (profile === "gmail") return "Gmail rejects messages larger than 25 MB.";
  if (profile === "outlook") return "Outlook rejects messages larger than 25 MB.";
  return "Gmail and Outlook reject messages larger than 25 MB.";
}

function attachmentName(item) {
  const name = item && (item.filename || item.name);
  const text = name && String(name).trim();
  return text || "attachment";
}

function readAttachmentBytes(item) {
  if (!item || typeof item !== "object") return { error: "missing" };
  const storage = typeof item.storageUrl === "string" ? item.storageUrl : "";
  if (storage.startsWith("local:")) {
    const blob = db.readBlob(storage.slice("local:".length));
    if (!blob || !blob.data || !blob.data.length) return { error: "missing" };
    return {
      content: Buffer.from(blob.data),
      storageUrl: storage,
      id: storage.slice("local:".length),
    };
  }
  if (item.content) {
    const content = Buffer.isBuffer(item.content) ? item.content : Buffer.from(String(item.content), "base64");
    return content.length ? { content } : { error: "missing" };
  }
  if (item.fileBytes) {
    const content = Buffer.from(item.fileBytes);
    return content.length ? { content } : { error: "missing" };
  }
  if (typeof item.path === "string" && item.path) {
    if (!fs.existsSync(item.path)) return { error: "missing" };
    const size = fs.statSync(item.path).size;
    if (!size) return { error: "missing" };
    if (size > ATTACHMENT_CAP) return { error: "too-large", size };
    return { content: fs.readFileSync(item.path) };
  }
  return { error: "missing" };
}

function resolveAttachments(list, account) {
  const items = Array.isArray(list) ? list.filter((item) => item && typeof item === "object") : [];
  if (!items.length) return { files: [], meta: [], error: null };
  const loaded = [];
  let total = 0;
  for (const item of items) {
    const name = attachmentName(item);
    const read = readAttachmentBytes(item);
    if (read.error === "too-large") {
      return {
        files: [],
        meta: [],
        error: { code: "too-large", message: `${name} is ${formatAttachmentSize(read.size)}. ${attachmentLimitCopy(account)}` },
      };
    }
    if (read.error || !read.content || !read.content.length) {
      return {
        files: [],
        meta: [],
        error: { code: "attachment", message: `Could not read ${name}. Remove it and attach the file again.` },
      };
    }
    if (read.content.length > ATTACHMENT_CAP) {
      return {
        files: [],
        meta: [],
        error: { code: "too-large", message: `${name} is ${formatAttachmentSize(read.content.length)}. ${attachmentLimitCopy(account)}` },
      };
    }
    total += read.content.length;
    if (total > ATTACHMENT_CAP) {
      return {
        files: [],
        meta: [],
        error: { code: "too-large", message: `These files are ${formatAttachmentSize(total)} together. ${attachmentLimitCopy(account)}` },
      };
    }
    loaded.push({ item, name, read });
  }
  const files = [];
  const meta = [];
  for (const row of loaded) {
    const mime = row.item.mimeType || row.item.contentType || "application/octet-stream";
    let storageUrl = row.read.storageUrl || "";
    let id = row.read.id || (row.item.id ? String(row.item.id) : "");
    if (!storageUrl) {
      id = crypto.randomBytes(9).toString("hex");
      db.saveBlob(id, row.name, mime, row.read.content);
      storageUrl = `local:${id}`;
    }
    files.push({
      filename: row.name,
      content: row.read.content,
      contentType: mime,
      cid: row.item.contentId || undefined,
      contentDisposition: row.item.contentId ? "inline" : "attachment",
    });
    meta.push({
      id: id || storageUrl,
      filename: row.name,
      mimeType: mime,
      size: row.read.content.length,
      storageUrl,
      contentId: row.item.contentId || null,
    });
  }
  return { files, meta, error: null };
}

function mimeOptions(account, params, files) {
  const html = typeof params.body === "string" ? params.body : "";
  return {
    from: composeIdentity.mimeFrom(account, params.fromAddress, params.fromDisplayName),
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

function storedBodyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function usableStoredBody(row) {
  if (row && typeof row.has_body === "number") return row.has_body === 1;
  return !!(row && (storedBodyText(row.html_body) || storedBodyText(row.text_body)));
}

function rowNeedsBody(row) {
  return !!(row && !row.draft_pending && Number(row.uid) > 0 && row.body_complete !== 1);
}

// Visible-list prefetch only. Older mail waits for the off-hours fill.
const BODY_PREFETCH_LIMIT = 200;
const bodyJobs = new Set();
let fillQueue = [];
let fillGen = 0;
let fillKey = null;
let fillRunning = false;
let bodyOnline = true;
let bodySleeping = false;
const bodyProgress = createBodyProgress({ onChange() {
  if (ready) broadcast("mail:bodySyncStatus", bodySyncSnapshot());
} });

function bodySyncSnapshot() {
  return bodyProgress.snapshot({
    accounts: db.listAccountRows().map(account => ({ id: account.id,
      generation: accountEpochs.get(account.id) || 0,
      needsConnection: !!account.auth_error,
      pausedUntil: syncGates.get(account.id)?.until || 0,
      busy: !!lanes.get(account.id)?.active })),
    queued: fillQueue.map(item => ({ accountId: item.accountId, generation: item.generation, source: item.kind === "open" ? "open" : "visible" })),
    online: bodyOnline, sleeping: bodySleeping,
    night: overnight.inOvernightWindow(overnightNow(), overnightZone()), horizonDays: syncHorizonDays(),
  });
}

function scheduleVisibleBodyPrefetch(emails) {
  const page = Array.isArray(emails) ? emails.slice(0, BODY_PREFETCH_LIMIT) : [];
  const ids = [];
  for (const email of page) {
    if (!email || email.id == null || email.bodyComplete === true) continue;
    ids.push(String(email.id));
  }
  const key = ids.join("\n");
  if (key === fillKey) return;
  fillKey = key;
  fillGen += 1;
  const gen = fillGen;
  fillQueue = fillQueue.filter((item) => item.kind === "open");
  for (const id of ids) {
    if (bodyJobs.has(id) || fillQueue.some((item) => item.id === id)) continue;
    const accountId = db.messageById(id)?.account_id;
    fillQueue.push({ id, gen, kind: "prefetch", accountId, generation: accountEpochs.get(accountId) || 0 });
  }
  bodyProgress.changed();
  pumpBodyFills();
}

function queueOpenFill(row) {
  if (!row || !rowNeedsBody(row)) return;
  const id = String(row.id);
  if (bodyJobs.has(id)) return;
  fillQueue = fillQueue.filter((item) => item.id !== id);
  fillQueue.unshift({ id, gen: fillGen, kind: "open", accountId: row.account_id, generation: accountEpochs.get(row.account_id) || 0 });
  bodyProgress.changed();
  pumpBodyFills();
}

function fillBodyInBackground(row, outcome, bodySource = "visible") {
  if (!row || row.id == null) return Promise.resolve(row);
  const id = String(row.id);
  if (bodyJobs.has(id) || !rowNeedsBody(row)) return Promise.resolve(row);
  bodyJobs.add(id);
  const beforeHtml = row.html_body;
  const beforeText = row.text_body;
  const beforeComplete = row.body_complete;
  const beforeWarning = row.body_warning;
  return ensureBody(row, { background: true, outcome, bodySource }).then((fresh) => {
    const next = fresh || row;
    if (outcome && outcome.skipped) return next;
    if (next.html_body !== beforeHtml || next.text_body !== beforeText || next.body_complete !== beforeComplete || next.body_warning !== beforeWarning) {
      broadcast("mail:bodyUpdated", { email: detailOf(next) });
    }
    return next;
  }).finally(() => {
    bodyJobs.delete(id);
  });
}

async function pumpBodyFills() {
  if (fillRunning) return;
  fillRunning = true;
  try {
    while (fillQueue.length) {
      const item = fillQueue[0];
      if (item.kind === "prefetch" && item.gen !== fillGen) {
        fillQueue.shift();
        continue;
      }
      const row = db.messageById(item.id);
      if (!row || !rowNeedsBody(row)) {
        fillQueue.shift();
        continue;
      }
      if (priorityWaiting(row.account_id)) return;
      const outcome = { skipped: false };
      fillQueue.shift();
      await fillBodyInBackground(row, outcome, item.kind === "open" ? "open" : "visible");
      if (outcome.skipped) {
        if (!fillQueue.some((queued) => queued.id === item.id)) fillQueue.unshift(item);
        return;
      }
    }
  } finally {
    fillRunning = false;
    bodyProgress.changed();
    const next = fillQueue[0];
    const pending = next && db.messageById(next.id);
    if (next && (!pending || !priorityWaiting(pending.account_id))) pumpBodyFills();
  }
}

function overnightNow() {
  const raw = process.env.MORROW_OVERNIGHT_AT;
  if (raw != null && String(raw).trim() !== "") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function overnightZone() {
  const zone = (process.env.MORROW_OVERNIGHT_TZ || "").trim();
  return zone || undefined;
}

const overnightTried = new Set();
let overnightSawWindow = false;
let overnightRunning = false;

function resetOvernightForTest() {
  overnightTried.clear();
  overnightSawWindow = false;
  overnightRunning = false;
  fillRunning = false;
  fillQueue = [];
  fillKey = null;
  fillGen += 1;
}

function nextOvernightRow(now) {
  const days = syncHorizonDays();
  const query = { needsBody: true, limit: 200 };
  if (days) query.sinceTs = now - days * DAY_MS;
  const rows = db.selectMessages(query);
  for (const row of rows) {
    if (!row || overnightTried.has(String(row.id))) continue;
    if (!rowNeedsBody(row)) continue;
    if (!gateOpen(row.account_id) || priorityWaiting(row.account_id)) continue;
    const account = db.accountById(row.account_id);
    if (!account || account.auth_error) continue;
    return row;
  }
  return null;
}

async function fillOvernightBodies() {
  if (overnightRunning) return { ran: false, fetched: 0, busy: true, window: true };
  const now = overnightNow();
  if (!overnight.inOvernightWindow(now, overnightZone())) {
    if (overnightSawWindow) overnightTried.clear();
    overnightSawWindow = false;
    return { ran: false, fetched: 0, window: false };
  }
  overnightSawWindow = true;
  if (fillRunning || fillQueue.length) return { ran: false, fetched: 0, window: true, yielded: "prefetch" };
  const row = nextOvernightRow(now);
  if (!row) return { ran: true, fetched: 0, window: true };
  overnightRunning = true;
  fillRunning = true;
  overnightTried.add(String(row.id));
  const outcome = { skipped: false, rateLimited: false };
  try {
    await fillBodyInBackground(row, outcome, "overnight");
  } finally {
    overnightRunning = false;
    fillRunning = false;
    if (fillQueue.length) pumpBodyFills();
  }
  if (outcome.skipped) {
    overnightTried.delete(String(row.id));
    return { ran: true, fetched: 0, window: true, yielded: "open" };
  }
  if (outcome.rateLimited) {
    overnightTried.delete(String(row.id));
    return { ran: true, fetched: 0, window: true, yielded: "rate" };
  }
  const fresh = db.messageById(row.id);
  return { ran: true, fetched: fresh && fresh.body_complete === 1 ? 1 : 0, window: true };
}

function needsGmailMetadata(row, account) {
  return account?.mail_transport === "gmail_api" && (!row.gmail_id || Number(row.uid_validity) !== Number(account.gmail_generation) || db.jsonList(row.attachments_json)
    .some(file => !String(file.storageUrl || "").startsWith("local:") && !String(file.id || "").startsWith("gmail:")));
}

async function ensureBody(row, options) {
  const background = !!(options && options.background);
  const outcome = options && options.outcome;
  const markSkip = () => {
    if (outcome) outcome.skipped = true;
  };
  // Full RFC822 via fetchSource. A text/html part fetch needs stored structure
  // so attachments and recipient headers stay intact.
  if (!row || row.draft_pending || !row.uid) return row;
  const account = db.accountById(row.account_id);
  if (!account) return row;
  const completeHeaders = value => {
    if (!options?.replyHeaders) return value.recipient_headers_json != null;
    try { return Array.isArray(JSON.parse(value.recipient_headers_json).replyTo); } catch { return false; }
  };
  if (row.body_complete === 1 && !row.body_warning && completeHeaders(row) && !needsGmailMetadata(row, account)) return row;
  if (background && priorityWaiting(account.id)) {
    markSkip();
    return row;
  }
  const bodyTask = row.body_complete !== 1 ? bodyProgress.queue(account.id, options?.bodySource || "open", accountEpochs.get(account.id) || 0) : null;
  let bodyResult;
  try {
    return await exclusive(account.id, async () => {
    if (background && priorityWaiting(account.id)) {
      markSkip();
      return db.messageById(row.id) || row;
    }
    // Another open may have filled the cache while this request queued.
    row = db.messageById(row.id);
    if (!row || row.draft_pending || !row.uid || (row.body_complete === 1 && !row.body_warning && completeHeaders(row) && !needsGmailMetadata(row, account))) return row;
    actions.assertIdentityReady(row.id);
    const password = await secretFor(account);
    bodyProgress.start(bodyTask);
    const metadataOnly = account.mail_transport === "gmail_api" && row.body_complete === 1;
    const fetched = await remote.withClient(account, password, (client) => remote.fetchSource(client, row.folder_path, row.uid, row.uid_validity, { metadataOnly }));
    bodyResult = "incomplete";
    // A FETCH row for another UID must not be written onto this message.
    if (!fetched || Number(fetched.uid) !== Number(row.uid)) return row;
    const current = db.messageById(row.id);
    if (current?.draft_pending) return current;
    actions.assertIdentityReady(row.id);
    if (!current || current.folder_path !== row.folder_path || current.uid !== row.uid || current.uid_validity !== row.uid_validity) {
      const error = new Error("This message moved while it was being read. Reopen it after the move is confirmed.");
      error.code = "message_moving";
      throw error;
    }
    const localFiles = account.mail_transport === "gmail_api" && row.is_draft ? db.jsonList(row.attachments_json).filter(file => String(file.storageUrl || "").startsWith("local:")) : [];
    db.updateMessage(row.id, {
      ...(account.mail_transport === "gmail_api" && fetched.providerId && Number.isSafeInteger(fetched.providerUid) && fetched.providerUid > 0 && fetched.providerValidity === account.gmail_generation
        ? { gmail_id: fetched.providerId, uid: fetched.providerUid, uid_validity: fetched.providerValidity } : {}),
      ...(metadataOnly ? {} : { html_body: fetched.htmlBody, text_body: fetched.textBody, body_complete: fetched.bodyComplete ? 1 : 0, snippet: fetched.snippet || row.snippet }),
      body_warning: fetched.bodyWarning || null,
      attachments_json: JSON.stringify(localFiles.length ? localFiles : fetched.attachments || []),
      has_attachments: localFiles.length > 0 || fetched.hasAttachments ? 1 : 0,
      subject: fetched.subject || row.subject,
      recipient_headers_json: JSON.stringify(fetched.recipientHeaders || {}),
      from_address: fetched.fromAddress || row.from_address || null,
    });
    bodyResult = metadataOnly || fetched.bodyComplete ? "done" : "incomplete";
    return db.messageById(row.id);
    }, background ? { background: true } : undefined);
  } catch (error) {
    bodyResult = http.isRateLimit(error) ? "rate-limit"
      : ["uid_validity_changed", "message_moving"].includes(error?.code) ? "message-changed" : "download-failed";
    if (error?.code === "uid_validity_changed" || error?.code === "message_moving") {
      if (!background) throw error;
      if (error.code === "uid_validity_changed") emitSync("error", { accountId: account.id, folderId: row.folder_path, message: error.message });
      return db.messageById(row.id) || row;
    }
    if (background && account && http.isRateLimit(error)) {
      noteRateLimit(account.id, error);
      if (outcome) outcome.rateLimited = true;
    }
    return row;
  } finally {
    bodyProgress.finish(bodyTask, bodyResult);
  }
}

function localSentReplyHeaders(row, account) {
  let headers;
  try { headers = JSON.parse(row.recipient_headers_json); } catch { return row; }
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length || row.is_draft || row.body_complete !== 1
      || Number(row.uid) !== 0 || Number(row.uid_validity) !== 0 || row.gmail_id
      || db.folderByPath(account.id, row.folder_path)?.well_known !== "sentitems") return row;
  // Before Reply-To was stored, unfiled locally generated Sent rows used empty
  // metadata and these cache/RFC id formats. Remote API search hits use a
  // different cache id; provider-fetched rows retain transport header evidence.
  // Do not infer local origin from uid=0, Sent membership or From alone.
  const rfc = /^<[a-f0-9]{24}@([^<>\s]+)>$/.exec(row.rfc_message_id || "");
  const from = composePolicy.address(row.from_addr);
  // Desktop sends generated ids from the account domain; bot sends used the
  // selected bare From, including aliases on a different domain. Both are
  // historical local formats, independent of today's alias configuration.
  if (!/^m-[a-z0-9]+-[a-f0-9]{1,8}$/.test(row.id) || !rfc
      || !from || from !== row.from_addr.trim().toLowerCase()
      || ![String(account.email).split("@")[1]?.toLowerCase(), from.split("@")[1]].includes(rfc[1].toLowerCase())) return row;
  db.updateMessage(row.id, { recipient_headers_json: JSON.stringify({ replyTo: [] }) });
  return db.messageById(row.id);
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
  assertAccountCurrent(account);
  const messages = found && Array.isArray(found.messages) ? found.messages : [];
  if (!messages.length) return [];
  if (found.gmail) return messages.map(message => db.gmailCopies(account.id, message.providerId).find(row => row.folder_path === folderPath) || db.gmailCopies(account.id, message.providerId)[0]).filter(Boolean).map(listRow);
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
  assertAccountCurrent(account);
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
    if (client.gmail) {
      const all = db.folderByWellKnown(account.id, "all");
      const found = await client.gmail.search(all.path, text, limit);
      return storeImapHits(account, all.path, found).slice(0, limit);
    }
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
  account = bindAccount(account);
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

const SENDER_EXACT = 50;
const SENDER_REQUESTS = 4;

function readSenderResume(raw) {
  const resume = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const capList = (value) => (Array.isArray(value) ? value.slice(0, 5000).map((item) => String(item)) : []);
  const buffers = {};
  const source = resume.buffers && typeof resume.buffers === "object" && !Array.isArray(resume.buffers) ? resume.buffers : {};
  for (const key of Object.keys(source).slice(0, 200)) {
    const list = source[key];
    if (!Array.isArray(list)) continue;
    buffers[String(key)] = list.slice(0, 200).filter((row) => row && typeof row === "object");
  }
  return {
    buffers,
    seenIds: capList(resume.seenIds),
    seenRfc: capList(resume.seenRfc),
    cursors: resume.cursors && typeof resume.cursors === "object" && !Array.isArray(resume.cursors) ? resume.cursors : {},
    exhausted: resume.exhausted && typeof resume.exhausted === "object" && !Array.isArray(resume.exhausted) ? resume.exhausted : {},
    statuses: resume.statuses && typeof resume.statuses === "object" && !Array.isArray(resume.statuses) ? resume.statuses : {},
  };
}

function senderAccountFields(view, order) {
  return {
    accountId: view.id,
    email: view.email || "",
    label: view.label || "",
    name: view.name || "",
    order,
  };
}

function senderSummaries(rows, address, accountId) {
  const out = [];
  for (const row of rows || []) {
    if (!row || !senderHistory.headerMatches(row.from, address)) continue;
    out.push({
      id: row.id,
      accountId,
      subject: row.subject || "",
      date: row.date || "",
      listSortTs: row.listSortTs,
      unread: !!row.unread,
      messageId: row.messageId || "",
    });
  }
  return out;
}

function sortSenderHits(rows) {
  return rows.slice().sort((a, b) => {
    const ta = Number.isFinite(a.listSortTs) ? a.listSortTs : Date.parse(a.date);
    const tb = Number.isFinite(b.listSortTs) ? b.listSortTs : Date.parse(b.date);
    const fa = Number.isFinite(ta);
    const fb = Number.isFinite(tb);
    if (fa && fb && ta !== tb) return tb - ta;
    if (fa && !fb) return -1;
    if (!fa && fb) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function senderFailure(accountId, error) {
  if (http.isRateLimit(error) || (error && error.code === "rate_limit")) {
    noteRateLimit(accountId, error);
    return { status: "rate_limit", message: "Paused for rate limit", exhausted: false, hits: [], cursor: null };
  }
  const code = error && error.code;
  const status = error && error.status;
  if (code === "auth" || code === "scope_missing" || status === 401 || status === 403) {
    return { status: "auth", message: "Sign in again", exhausted: false, hits: [], cursor: null };
  }
  if (code === "search_unsupported" || code === "filter_unsupported") {
    return { status: "unavailable", message: "Unavailable", exhausted: true, hits: [], cursor: null };
  }
  return { status: "error", message: remote.explain(error), exhausted: false, hits: [], cursor: null };
}

async function refillSenderApi(account, address, cursor, runPage) {
  const exact = [];
  let step = cursor || null;
  let exhausted = false;
  let nextCursor = null;
  for (let round = 0; round < SENDER_REQUESTS && exact.length < SENDER_EXACT; round += 1) {
    const page = await runPage(step, SENDER_EXACT - exact.length);
    const stored = page.stored || (page.hits || []).map((hit) => rememberApiHit(account, hit)).filter(Boolean);
    exact.push(...senderSummaries(stored, address, account.id));
    if (page.short || !page.cursor) {
      exhausted = true;
      nextCursor = null;
      break;
    }
    nextCursor = page.cursor;
    step = page.cursor;
  }
  if (!nextCursor) exhausted = true;
  return { hits: exact, cursor: exhausted ? null : nextCursor, exhausted };
}

async function searchSenderGmailApi(account, address, cursor, token) {
  let pageToken = cursor && cursor.pageToken ? String(cursor.pageToken) : "";
  if (account.mail_transport === "gmail_api") return exclusive(account.id, () => remote.withClient(account, token.accessToken, async client => {
    return refillSenderApi(account, address, pageToken ? { pageToken } : null, async (step, limit) => {
      const page = await client.gmail.api.listMessages({ query: senderHistory.gmailFromQuery(address), pageToken: step?.pageToken || "", limit });
      const stored = [];
      for (const row of page.messages) {
        await client.gmail.adopt(await client.gmail.api.getMessage(row.id));
        const cached = db.gmailCopies(account.id, row.id)[0];
        if (cached) stored.push(listRow(cached));
      }
      return { stored, short: !page.nextPageToken, cursor: page.nextPageToken ? { pageToken: page.nextPageToken } : null };
    });
  }));
  return refillSenderApi(account, address, pageToken ? { pageToken } : null, async (step, limit) => {
    const page = await providerApi.searchGmailPage(token.accessToken, senderHistory.gmailFromQuery(address), limit, step && step.pageToken);
    return {
      hits: page.hits,
      short: page.short,
      cursor: page.nextPageToken ? { pageToken: page.nextPageToken } : null,
    };
  });
}

async function searchSenderGraph(account, address, cursor, token) {
  if (cursor && cursor.nextLink && !providerApi.graphSenderNext(String(cursor.nextLink))) {
    return { hits: [], cursor: null, exhausted: true };
  }
  return refillSenderApi(account, address, cursor && cursor.nextLink ? { nextLink: String(cursor.nextLink) } : null, async (step, limit) => {
    const link = step && step.nextLink ? step.nextLink : "";
    const page = await providerApi.searchGraphFromPage(token.accessToken, address, limit, link);
    return {
      hits: page.hits,
      short: page.short,
      cursor: page.nextLink ? { nextLink: page.nextLink } : null,
    };
  });
}

async function searchSenderImapGmail(account, address, cursor) {
  const beforeUid = cursor && Number(cursor.beforeUid) > 0 ? Number(cursor.beforeUid) : 0;
  const password = await secretFor(account);
  return exclusive(account.id, () => remote.withClient(account, password, async (client) => {
    let unsupported = null;
    for (const box of GMAIL_ALL) {
      try {
        const found = await remote.findFrom(client, box, address, SENDER_EXACT, { gmail: true, beforeUid });
        if (!found || !found.searched) continue;
        const hits = sortSenderHits(senderSummaries(storeImapHits(account, box, found), address, account.id));
        const more = found.more === true && found.lowestUid > 0;
        return {
          hits,
          cursor: more ? { folderIndex: 0, beforeUid: found.lowestUid } : null,
          exhausted: !more,
        };
      } catch (error) {
        if (http.isRateLimit(error)) throw error;
        if (error && error.code === "mailbox_missing") continue;
        if (error && error.code === "search_unsupported") {
          unsupported = error;
          continue;
        }
        throw error;
      }
    }
    if (unsupported) throw unsupported;
    throw new Error("Gmail All Mail is not available.");
  }));
}

async function searchSenderImap(account, address, cursor) {
  const folders = db.foldersFor(account.id);
  let folderIndex = 0;
  let beforeUid = null;
  const rawIndex = cursor && cursor.folderIndex;
  if (Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < folders.length) {
    folderIndex = rawIndex;
    beforeUid = Number(cursor.beforeUid) > 0 ? Number(cursor.beforeUid) : null;
  }
  const password = await secretFor(account);
  return exclusive(account.id, () => remote.withClient(account, password, async (client) => {
    const hits = [];
    let scanned = 0;
    let nextCursor = null;
    while (folderIndex < folders.length && scanned < SENDER_REQUESTS) {
      const folder = folders[folderIndex];
      scanned += 1;
      let found = null;
      try {
        found = await remote.findFrom(client, folder.path, address, SENDER_EXACT, { beforeUid: beforeUid || 0 });
      } catch (error) {
        if (http.isRateLimit(error)) throw error;
        if (error && error.code === "mailbox_missing") {
          folderIndex += 1;
          beforeUid = null;
          continue;
        }
        throw error;
      }
      if (found && found.searched) {
        hits.push(...senderSummaries(storeImapHits(account, folder.path, found), address, account.id));
      }
      if (found && found.more && found.lowestUid > 0) {
        nextCursor = { folderIndex, beforeUid: found.lowestUid };
        break;
      }
      folderIndex += 1;
      beforeUid = null;
    }
    const exhausted = !nextCursor && folderIndex >= folders.length;
    if (!nextCursor && folderIndex < folders.length) nextCursor = { folderIndex, beforeUid: null };
    return { hits: sortSenderHits(hits), cursor: nextCursor, exhausted };
  }));
}

async function searchSenderAccount(account, address, cursor) {
  account = bindAccount(account);
  if (account.auth_error) {
    return { status: "auth", message: "Sign in again", exhausted: false, hits: [], cursor: cursor || null };
  }
  if (!gateOpen(account.id)) {
    return { status: "rate_limit", message: "Paused for rate limit", exhausted: false, hits: [], cursor: cursor || null };
  }
  if (account.profile === "gmail") {
    const token = await sidecar.organizeToken(account);
    if (token && token.provider === "google") {
      const page = await searchSenderGmailApi(account, address, cursor, token);
      return { status: "ok", message: "", ...page };
    }
  }
  if (account.profile === "outlook") {
    const token = await sidecar.organizeToken(account);
    if (token && token.provider === "microsoft") {
      const page = await searchSenderGraph(account, address, cursor, token);
      return { status: "ok", message: "", ...page };
    }
  }
  const page = account.profile === "gmail"
    ? await searchSenderImapGmail(account, address, cursor)
    : await searchSenderImap(account, address, cursor);
  return { status: "ok", message: "", ...page };
}

async function senderTask(view, order, address, resume, retryAccountId) {
  const base = senderAccountFields(view, order);
  const id = view.id;
  const prior = resume.statuses && resume.statuses[id] ? resume.statuses[id] : { status: "ok", message: "" };
  const skip = (retryAccountId && retryAccountId !== id) || (!retryAccountId && resume.exhausted[id] === true);
  if (skip) {
    return {
      ...base,
      status: prior.status || "ok",
      message: prior.message || "",
      hits: [],
      cursor: (resume.cursors && resume.cursors[id]) || null,
      exhausted: resume.exhausted[id] === true,
    };
  }
  const account = db.accountById(id);
  if (!account) {
    return { ...base, status: "error", message: "That account is not connected.", hits: [], cursor: null, exhausted: true };
  }
  try {
    const result = await searchSenderAccount(account, address, (resume.cursors && resume.cursors[id]) || null);
    return { ...base, ...result };
  } catch (error) {
    return { ...base, ...senderFailure(id, error) };
  }
}

async function searchSender(params) {
  const raw = String((params && params.address) || "").trim();
  if (!senderHistory.isAddrSpec(raw)) return fail("invalid", "That sender has no email address.");
  const address = raw.toLowerCase();
  try {
    const resume = readSenderResume(params && params.resume);
    const retryAccountId = params && typeof params.retryAccountId === "string" ? params.retryAccountId : "";
    const views = accountViews();
    const accounts = await Promise.all(views.map((view, order) => senderTask(view, order, address, resume, retryAccountId)));
    return ok(senderHistory.pageSenderHistory({
      accounts,
      preferAccountId: params && params.preferAccountId,
      currentId: params && params.currentId,
      currentMessageId: params && params.currentMessageId,
      resume,
    }));
  } catch (error) {
    return fail("search", remote.explain(error));
  }
}

function saveUpload(params) {
  const bytes = params && params.fileBytes ? Buffer.from(params.fileBytes) : null;
  if (!bytes || !bytes.length) return fail("invalid", "That file is empty.");
  if (bytes.length > ATTACHMENT_CAP) {
    return fail("too-large", `That file is ${formatAttachmentSize(bytes.length)}. ${attachmentLimitCopy(null)}`);
  }
  const id = crypto.randomBytes(9).toString("hex");
  const filename = params.filename && String(params.filename).trim() ? String(params.filename).trim() : "attachment";
  const mime = params.mimeType && String(params.mimeType).trim() ? String(params.mimeType).trim() : "application/octet-stream";
  db.saveBlob(id, filename, mime, bytes);
  return ok({ storageUrl: `local:${id}`, pageUrl: null, fileWrapperUrl: `local:${id}`, filename, mimeType: mime, size: bytes.length });
}

function attachmentSelection(params, all = false) {
  const row = db.messageById(params && (params.messageId || params.emailId));
  if (!row) return null;
  const attachments = db.jsonList(row.attachments_json);
  if (all) return { row, files: selectableAttachments(attachments, params?.attachmentIds) };
  const explicit = params && params.attachmentId != null;
  const matches = explicit ? attachments.filter(item => String(item.id) === String(params.attachmentId)) : [];
  const wanted = explicit ? (matches.length === 1 ? matches[0] : null) : attachments[0];
  if (!wanted) return null;
  return { row, files: [wanted] };
}

async function bytesFor(params, options) {
  const selection = attachmentSelection(params);
  if (!selection) return null;
  const files = await attachmentParts(selection.row, selection.files, options);
  return { filename: params.filename || files[0].name, data: files[0].data };
}

function selectableAttachments(attachments, ids) {
  const files = (Array.isArray(attachments) ? attachments : []).filter((item) => item && item.id);
  if (ids == null) return files;
  if (!Array.isArray(ids) || !ids.length) return [];
  const wanted = [...new Set(ids.map(id => String(id)))];
  const picked = wanted.map(id => { const matches = files.filter(item => String(item.id) === id); return matches.length === 1 ? matches[0] : null; });
  if (picked.some(item => !item)) throw new Error("An attachment changed or is no longer available. Reopen the message before saving its files.");
  return picked;
}

function attachmentSnapshot(row) {
  const account = bindAccount(db.accountById(row.account_id));
  const login = value => JSON.stringify([value.created_at, value.auth_kind, value.mail_transport, value.gmail_generation,
    value.username, value.imap_host, value.imap_port, value.imap_tls]);
  const connection = login(account);
  const assertSnapshot = () => {
    assertAccountCurrent(account);
    if (login(db.accountById(account.id)) !== connection) throw removedAccountError();
    const current = db.messageById(row.id);
    if (!current || ["account_id", "folder_path", "uid", "uid_validity", "gmail_id", "rfc_message_id", "attachments_json"].some(key => current[key] !== row[key])) {
      throw new Error("The message or its attachments changed. Reopen it before saving its files.");
    }
  };
  assertSnapshot();
  return { account, assertSnapshot, key: JSON.stringify([account.id, account[ACCOUNT_EPOCH], connection, row.id,
    row.folder_path, row.uid, row.uid_validity, row.gmail_id, row.rfc_message_id, row.attachments_json]) };
}

async function attachmentParts(row, files, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const { account, assertSnapshot, key } = attachmentSnapshot(row);
  const parts = new Map(), remoteItems = [];
  let localBytes = 0;
  for (const [index, item] of files.entries()) {
    if (Number(item.size) > attachmentTransfers.LIMITS.fileBytes) throw attachmentTransfers.tooLarge();
    if (String(item.storageUrl || "").startsWith("local:")) {
      const blob = db.readBlob(item.storageUrl.slice(6));
      if (!blob?.data) throw new Error("That local attachment is no longer available. Attach the file again.");
      if (blob.data.length > attachmentTransfers.LIMITS.fileBytes) throw attachmentTransfers.tooLarge();
      localBytes += blob.data.length;
      if (localBytes > attachmentTransfers.LIMITS.zipBytes) throw Object.assign(new Error("These files exceed the 128 MiB combined download limit. Save them separately."), { code: "too-large" });
      parts.set(index, { name: item.filename || blob.filename || "attachment", data: Buffer.from(blob.data) });
    } else remoteItems.push({ key: JSON.stringify([key, String(item.id)]), item, index });
  }
  const assertRemote = () => {
    assertSnapshot();
    actions.assertIdentityReady(row.id);
    const folder = db.folderByPath(row.account_id, row.folder_path);
    if (account.mail_transport !== "gmail_api" && folder?.uid_validity > 0 && Number(folder.uid_validity) !== Number(row.uid_validity)) {
      throw Object.assign(new Error("This folder changed. Sync and reopen the message before downloading its files."), { code: "uid_validity_changed" });
    }
  };
  if (remoteItems.length) {
    if (!(row.uid > 0)) throw new Error("That remote attachment is not available on this computer.");
    assertRemote();
    // A large ZIP consumes bounded batches, rather than refusing valid selections
    // just because they contain more files than the pending-transfer budget.
    for (let start = 0; start < remoteItems.length; start += 8) {
      const batch = remoteItems.slice(start, start + 8);
      const downloaded = await attachmentCache.getMany(batch, { accountId: account.id, signal,
        maxTotalBytes: attachmentTransfers.LIMITS.zipBytes - [...parts.values()].reduce((sum, part) => sum + part.data.length, 0),
        onProgress: value => onProgress({ ...value, index: batch[value.index].index, count: files.length }),
        load: (entries, groupSignal) => updateGate.run(() => exclusive(account.id, async () => {
          groupSignal.throwIfAborted(); assertRemote();
          for (const entry of entries) entry.report({ phase: "connecting", loaded: 0 });
          const password = await secretFor(account);
          groupSignal.throwIfAborted(); assertRemote();
          await remote.withClient(account, password, async client => {
            for (const entry of entries) {
              groupSignal.throwIfAborted();
              if (entry.signal.aborted) continue;
              assertRemote(); entry.report({ phase: "downloading", loaded: 0 });
              try {
                const data = await remote.readPart(client, row.folder_path, row.uid, entry.item.item.id, row.uid_validity,
                  { signal: entry.signal, maxBytes: attachmentTransfers.LIMITS.fileBytes, onProgress: entry.report });
                assertRemote(); if (!entry.signal.aborted) entry.complete(data);
              } catch (error) { entry.fail(entry.signal.aborted ? attachmentTransfers.cancelled() : error); }
            }
          }, { signal: groupSignal });
        })) });
      signal?.throwIfAborted(); assertRemote();
      for (const [index, data] of downloaded.entries()) {
        const selected = batch[index];
        parts.set(selected.index, { name: selected.item.filename || "attachment", data });
      }
    }
  }
  signal?.throwIfAborted(); assertSnapshot();
  const result = files.map((_file, index) => parts.get(index));
  if (result.reduce((sum, part) => sum + part.data.length, 0) > attachmentTransfers.LIMITS.zipBytes) throw Object.assign(new Error("These files exceed the 128 MiB combined download limit. Save them separately."), { code: "too-large" });
  return result;
}

async function attachmentOperation(channel, params, owner) {
  let request;
  try {
    request = attachmentRequests.begin(params, owner);
    const zip = channel === "mail:downloadAttachmentsZip";
    const selection = attachmentSelection(params, zip);
    if (!selection || !selection.files.length) return fail("not-found", "That attachment is no longer available.");
    const { row, files } = selection;
    const snapshot = attachmentSnapshot(row);
    request.accountId = row.account_id;
    const assertCurrent = () => { request.signal.throwIfAborted(); snapshot.assertSnapshot(); };
    const filename = zip ? zipBytes.zipDownloadName(textEncoding.repairMojibake(row.subject || ""))
      : params.filename || files[0].filename || "attachment";
    let target;
    if (channel === "mail:downloadAttachment" || zip) {
      request.report({ phase: "choosing" });
      const { dialog, BrowserWindow } = require("electron");
      const win = (owner && BrowserWindow.fromWebContents?.(owner)) || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const picked = await dialog.showSaveDialog(win || undefined, { defaultPath: filename });
      assertCurrent();
      if (picked.canceled || !picked.filePath) throw attachmentTransfers.cancelled();
      target = picked.filePath;
    }
    assertCurrent();
    const parts = await attachmentParts(row, files, { signal: request.signal, onProgress: value => request.report(value) });
    assertCurrent();
    const data = zip ? zipBytes.zipFiles(parts) : parts[0].data;
    if (channel === "mail:fetchAttachmentBytes") return ok(data);
    request.report({ phase: "writing" });
    assertCurrent();
    if (channel === "mail:openAttachmentExternally") {
      const dir = path.join(os.tmpdir(), "morrow-mail-attachments");
      fs.mkdirSync(dir, { recursive: true });
      const safe = filename.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 120) || "attachment";
      target = path.join(dir, `${crypto.randomUUID()}-${safe}`);
    }
    fs.writeFileSync(target, data, { mode: 0o600 });
    if (channel === "mail:openAttachmentExternally") {
      request.report({ phase: "opening" });
      const opened = await require("electron").shell.openPath(target);
      if (opened) return fail("open", opened);
    }
    return ok({ path: target });
  } catch (error) {
    if (request?.signal.aborted || error?.code === "cancelled" || error?.name === "AbortError") return fail("cancelled", "cancelled");
    return fail(error?.code || "attachment", remote.explain(error));
  } finally { request?.finish(); }
}

async function prepareDraft(params, owner) {
  let request;
  try {
    request = attachmentRequests.begin(params, owner);
    let row = db.messageById(params.emailId);
    if (!row?.is_draft) throw new Error("That draft is no longer available.");
    request.accountId = row.account_id;
    row = await ensureBody(row);
    if (!row?.is_draft || !row.body_complete || row.body_warning) throw new Error("The complete draft body could not be downloaded. Reopen it to retry.");
    const revision = db.draftRevision(row);
    if (params.draftRevision !== revision) throw new Error("This draft changed. Reopen the current revision before editing.");
    const snapshot = attachmentSnapshot(row), files = db.jsonList(row.attachments_json);
    const check = () => {
      request.signal.throwIfAborted(); snapshot.assertSnapshot();
      if (db.draftRevision(db.messageById(row.id)) !== revision) throw new Error("This draft changed while its files were loading. Reopen it.");
    };
    check();
    if (files.some(file => !file?.id) || files.reduce((sum, file) => sum + (Number(file.size) || 0), 0) > ATTACHMENT_CAP) {
      throw new Error("This draft's files cannot be prepared within the 25 MiB outgoing attachment limit.");
    }
    const parts = await attachmentParts(row, files, { signal: request.signal, onProgress: value => request.report(value) });
    check();
    if (parts.some(part => !part.data.length) || parts.reduce((sum, part) => sum + part.data.length, 0) > ATTACHMENT_CAP) {
      throw new Error("This draft contains an empty file or exceeds the 25 MiB outgoing attachment limit.");
    }
    // Hydration is not an edit. Keep the source row/revision intact for queued
    // cleanup proofs; publish all local files atomically after every read succeeds.
    const attachments = db.transaction(() => {
      check();
      return files.map((file, index) => {
        const part = parts[index];
        if (String(file.storageUrl || "").startsWith("local:")) return { ...file, size: part.data.length };
        const id = crypto.randomBytes(9).toString("hex");
        db.saveBlob(id, file.filename || part.name, file.mimeType || "application/octet-stream", part.data);
        return { ...file, id, storageUrl: `local:${id}`, size: part.data.length };
      });
    });
    return ok({ email: { ...detailOf(row), attachments } });
  } catch (error) {
    if (request?.signal.aborted || error?.code === "cancelled") return fail("cancelled", "cancelled");
    return fail(error?.code || "draft_prepare", (error.message || String(error)) + " The saved draft was retained. Retry from Drafts; nothing was sent.");
  } finally { request?.finish(); }
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
  const byDomain = {};
  for (const row of db.listSignatureDomains()) {
    if (!byDomain[row.account_id]) byDomain[row.account_id] = {};
    byDomain[row.account_id][row.domain] = row.signature_id;
  }
  return {
    signatures: rows.map(publicSignature),
    defaultSignatureId: accountId ? (per[accountId] || null) : null,
    defaultSignaturePerAccount: per,
    signatureByDomainPerAccount: byDomain,
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
  let domains;
  if (Array.isArray(params && params.domains)) {
    try { domains = composePolicy.normalizeDomainKeys(params.domains); }
    catch (error) { return fail("invalid", error instanceof Error ? error.message : String(error)); }
  }
  let saved;
  try {
    saved = db.saveSignature({
      id: existing ? existing.id : `sig-${crypto.randomBytes(8).toString("hex")}`,
      accountId: owner,
      name,
      bodyText: html ? null : text,
      bodyHtml: html || null,
      isDefault: params && params.isDefault,
      domains,
    });
  } catch (error) {
    return fail("invalid", error instanceof Error ? error.message : String(error));
  }
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

const scheduledDelivering = new Set();

function publicScheduled(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json) || {}; } catch { payload = {}; }
  let receipt = {};
  try { receipt = JSON.parse(row.receipt_json) || {}; } catch { receipt = {}; }
  const out = {
    id: row.id,
    accountId: row.account_id,
    to: displayAddress(payload.to),
    subject: payload.subject || "",
    sendAt: new Date(row.send_at).toISOString(),
    status: scheduledDelivering.has(row.id) ? "sending" : (row.status || "pending"),
    messageId: row.message_id || undefined,
    acceptedRecipients: deliveryReceipt.addresses(receipt.accepted),
    rejectedRecipients: deliveryReceipt.addresses(receipt.rejected),
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
  let fromAddress, fromDisplayName;
  try { ({ fromAddress, fromDisplayName } = composeIdentity.outgoingIdentity(account, input.fromAddress, input.fromDisplayName)); }
  catch (error) { return fail("invalid_from", error.message); }
  const to = storedAddress(input.to);
  const cc = storedAddress(input.cc);
  const bcc = storedAddress(input.bcc);
  if (!hasRecipient(to, cc, bcc)) return fail("invalid", "Add a recipient.");
  const when = Date.parse(input.sendAt);
  if (!Number.isFinite(when) || when <= Date.now() + 1000) {
    return fail("send_at_in_past", "Pick a time in the future.");
  }
  const presented = textEncoding.presentMessage({
    subject: input.subject ? String(input.subject).trim() : "",
    htmlBody: typeof input.body === "string" ? input.body : "",
  });
  const payload = {
    to,
    cc,
    bcc,
    subject: presented.subject,
    body: presented.htmlBody || "",
    fromAddress,
    fromDisplayName,
  };
  if (input.draftId) payload.draftId = input.draftId;
  if (input.emailId) payload.emailId = input.emailId;
  if (typeof input.draftRevision === "string") payload.draftRevision = input.draftRevision;
  if (input.inReplyTo) payload.inReplyTo = input.inReplyTo;
  if (input.threadId) payload.threadId = input.threadId;
  if (Array.isArray(input.references)) payload.references = input.references;
  const resolved = resolveAttachments(input.attachments, account);
  if (resolved.error) return fail(resolved.error.code, resolved.error.message);
  if (resolved.meta.length) payload.attachments = resolved.meta;
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

function scheduledSnapshot(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    payloadJson: row.payload_json,
    sendAt: row.send_at,
    status: ["failed", "unknown", "sent", "partial"].includes(row.status) ? row.status : row.status === "sending" ? "unknown" : "pending",
    messageId: row.message_id || null,
    receiptJson: row.receipt_json || null,
    error: row.error || "",
    createdAt: row.created_at,
  };
}

function cancelScheduled(params) {
  const id = params && params.id ? String(params.id) : "";
  if (scheduledDelivering.has(id)) return fail("sending", "Delivery has started. It can no longer be canceled or edited. Check Sent before retrying.");
  const row = db.scheduledById(id);
  if (!row) return fail("not-found", "That scheduled send is gone.");
  const snapshot = scheduledSnapshot(row);
  if (!db.deleteScheduled(id)) return fail("not-found", "That scheduled send is gone.");
  return ok({ id, snapshot });
}

function restoreScheduled(params) {
  const snap = params && params.snapshot;
  if (!snap || typeof snap !== "object") return fail("invalid", "That scheduled send cannot be restored.");
  const id = String(snap.id || "");
  if (!/^[\w.-]{1,80}$/.test(id)) return fail("invalid", "That scheduled send cannot be restored.");
  const account = db.accountById(String(snap.accountId || ""));
  if (!account) return fail("not-found", "That mailbox is no longer connected.");
  if (scheduledDelivering.has(id)) return fail("sending", "Delivery has started. It can no longer be canceled or edited. Check Sent before retrying.");
  if (db.scheduledById(id)) return fail("conflict", "That scheduled send is already queued.");
  const raw = typeof snap.payloadJson === "string" ? snap.payloadJson : "";
  let payload;
  try { payload = JSON.parse(raw); } catch { return fail("invalid", "That scheduled send cannot be restored."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("invalid", "That scheduled send cannot be restored.");
  if (!hasRecipient(payload.to, payload.cc, payload.bcc)) return fail("invalid", "That scheduled send cannot be restored.");
  const when = Number(snap.sendAt);
  if (!Number.isFinite(when)) return fail("invalid", "That scheduled send cannot be restored.");
  const status = ["failed", "unknown", "sent", "partial"].includes(snap.status) ? snap.status : snap.status === "sending" ? "unknown" : "pending";
  const saved = db.insertScheduled({
    id,
    accountId: account.id,
    payloadJson: raw,
    sendAt: when,
    createdAt: Number(snap.createdAt) || Date.now(),
    status,
    error: status !== "pending" ? String(snap.error || "Check Sent before recovering this delivery.") : null,
    messageId: typeof snap.messageId === "string" ? snap.messageId : null,
    receiptJson: typeof snap.receiptJson === "string" ? snap.receiptJson : null,
  });
  return ok(publicScheduled(saved));
}

function editScheduled(params) {
  const id = String((params && params.id) || "");
  if (scheduledDelivering.has(id)) return fail("sending", "Delivery has started. It can no longer be canceled or edited. Check Sent before retrying.");
  const row = db.scheduledById(id);
  if (!row) return fail("not-found", "That scheduled send is gone. Refresh the queue and check Sent.");
  if (row.status === "sending") return fail("sending", "Delivery has started. Check Sent before retrying.");
  const needsReview = ["unknown", "sent", "partial"].includes(row.status);
  if (needsReview && params.acknowledgeDelivery !== true) return fail("delivery_review", "Check Sent first. Recovering this copy and sending it may duplicate an earlier delivery.");
  const account = db.accountById(row.account_id);
  const drafts = account && db.folderByWellKnown(account.id, "drafts");
  if (!drafts) return fail("not-found", "This mailbox has no Drafts folder. The queued message is unchanged.");
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { return fail("invalid", "The queued content cannot be read. It has not been changed."); }
  let partialWarning = "";
  if (row.status === "partial") {
    let receipt = {};
    try { receipt = JSON.parse(row.receipt_json) || {}; } catch { /* an unverified receipt yields no recipients */ }
    const retry = deliveryReceipt.retryRecipients(payload, receipt);
    payload = { ...payload, to: retry.to, cc: retry.cc, bcc: retry.bcc };
    partialWarning = "This draft includes only verified rejected recipients; accepted recipients were removed. Review before explicitly sending."
      + (retry.unresolved.length || !retry.to.length && !retry.cc.length && !retry.bcc.length
        ? " Some recipient details could not be safely matched. Add only failed addresses after reviewing the receipt." : "");
  }
  const resolved = resolveAttachments(payload.attachments, account);
  if (resolved.error) return fail(resolved.error.code, resolved.error.message);
  const presented = textEncoding.presentMessage({
    subject: payload.subject || "",
    htmlBody: payload.body || "",
  });
  const html = presented.htmlBody || "";
  const text = presented.textBody || plainFromHtml(html);
  const now = new Date();
  const emailId = db.newMessageId();
  db.scheduledToDraft(id, {
    id: emailId, accountId: account.id, folderPath: drafts.path,
    threadId: payload.threadId || emailId, inReplyTo: payload.inReplyTo || null,
    rfcMessageId: rfcMessageId(account.email), subject: presented.subject,
    from: payload.fromAddress || account.email, fromDisplayName: typeof payload.fromDisplayName === "string" ? payload.fromDisplayName : "",
    to: addrList(payload.to), cc: addrList(payload.cc), bcc: addrList(payload.bcc),
    date: now.toISOString(), listSortTs: now.getTime(), isDraft: true,
    hasAttachments: resolved.meta.length > 0,
    attachments: resolved.meta,
    htmlBody: html, textBody: text,
    snippet: plainFromHtml(html).slice(0, 180), bodyComplete: true,
    recipientHeaders: { replyTo: [] },
  });
  emitAccounts();
  return ok({ emailId, accountId: account.id, sendAt: new Date(row.send_at).toISOString(),
    warning: partialWarning || (needsReview ? "This message may already have been delivered. Check Sent before explicitly sending or scheduling this recovered draft." : "") });
}

const PRE_ACCEPT_CODES = new Set(["EENVELOPE", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);
const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_SIGNATURE_FAILURE",
]);
const PRE_ACCEPT_COMMANDS = new Set(["CONN", "AUTH", "EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"]);
let smtpSenderForTest = null;

function setSmtpSenderForTest(fn) {
  smtpSenderForTest = typeof fn === "function" ? fn : null;
}

function provedRefusal(error) {
  if (!error || typeof error !== "object") return "";
  const code = typeof error.code === "string" ? error.code : "";
  const command = typeof error.command === "string" ? error.command.toUpperCase() : "";
  const responseCode = Number(error.responseCode);
  const proved = PRE_ACCEPT_CODES.has(code) || CERT_CODES.has(code)
    || error.operationIssued === false
    || code === "EAUTH" || code === "EMESSAGE" || code === "auth"
    || (Number.isFinite(responseCode) && responseCode >= 400)
    || (PRE_ACCEPT_COMMANDS.has(command) && responseCode >= 400);
  if (!proved) return "";
  return remote.explain(error, "") || code || command || "The mail server refused the message.";
}

async function fileSentMessage(account, password, options, info, messageId, extra) {
  const sent = db.folderByWellKnown(account.id, "sentitems");
  const emailId = db.newMessageId();
  const when = new Date();
  const keptId = (info && info.messageId) || messageId;
  const files = (extra && extra.files) || [];
  if (sent) {
    db.insertMessage({
      id: emailId,
      accountId: account.id,
      folderPath: sent.path,
      threadId: (extra && extra.threadId) || emailId,
      rfcMessageId: keptId,
      subject: options.subject,
      snippet: plainFromHtml(options.html).slice(0, 180),
      from: typeof options.from === "object" ? options.from.address : options.from,
      fromDisplayName: typeof options.from === "object" ? options.from.name || "" : "",
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      date: when.toISOString(),
      listSortTs: when.getTime(),
      isDraft: false,
      hasAttachments: files.length > 0,
      attachments: (extra && extra.meta) || [],
      htmlBody: options.html,
      textBody: options.text,
      bodyComplete: true,
      recipientHeaders: { replyTo: [] },
      inReplyTo: (extra && extra.inReplyTo) || null,
    });
    if (account.mail_transport === "gmail_api" && info?.providerId) {
      const mapping = db.rememberGmail(account.id, { providerId: info.providerId, labelIds: ["SENT"] });
      db.updateMessage(emailId, { gmail_id: info.providerId, uid: mapping.local_uid, uid_validity: account.gmail_generation });
      return { emailId, messageId: keptId };
    }
    if (password && account.profile !== "gmail") {
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
    } else if (password) {
      try {
        const report = await remote.withClient(account, password, (client) => remote.syncFolder(client, sent.path, { limit: 40 }));
        db.applyFolderSync(account.id, sent.path, report);
      } catch {
        // The local Sent row stays until a later sync can adopt it.
      }
    }
  }
  return { emailId, messageId: keptId };
}

async function submitSmtp(input) {
  const account = input && input.account;
  const options = input && input.options;
  const messageId = input && input.messageId;
  if (!account || !options || !messageId) return { kind: "rejected", refusal: "Missing message id." };
  let accepted = false;
  let receipt;
  let authorizationError;
  try {
    const sentResult = await exclusive(account.id, async () => {
      let info;
      let password = "";
      if (!smtpSenderForTest) password = await secretFor(account);
      // Keep this gate synchronous and adjacent to the transport invocation:
      // mailbox queueing and OAuth refresh may both outlive a bot grant.
      if (input.beforeSubmit) {
        try { input.beforeSubmit(); } catch (error) { authorizationError = error; throw error; }
      }
      if (smtpSenderForTest) info = await smtpSenderForTest({ account, options, messageId });
      else info = await remote.sendSmtp(account, password, { ...options, messageId });
      accepted = true;
      receipt = deliveryReceipt.fromSmtp(info, messageId);
      // Persist acceptance before any best-effort Sent filing can await I/O.
      if (input.onAccepted) await input.onAccepted(receipt);
      try {
        return await fileSentMessage(account, password, options, info, messageId, input);
      } catch {
        return { emailId: null, messageId: (info && info.messageId) || messageId };
      }
    });
    return { kind: "accepted", messageId: sentResult.messageId, emailId: sentResult.emailId, receipt };
  } catch (error) {
    if (authorizationError) return { kind: "not_submitted" };
    const refusal = accepted ? "" : provedRefusal(error);
    if (refusal) return { kind: "rejected", refusal };
    return { kind: "unknown", detail: remote.explain(error, ""), receipt };
  }
}

async function cleanupSubmittedDraft(account, proof) {
  if (!proof) return false; // Legacy snapshots have no evidence of a revision.
  return exclusive(account.id, async () => {
    const matches = row => row?.account_id === account.id && db.draftRevision(row) === proof.revision;
    let current = db.messageById(proof.id);
    if (!current) return true;
    if (!matches(current)) return false;
    if (current.uid > 0) {
      const password = await secretFor(account);
      actions.assertIdentityReady(proof.id);
      current = db.messageById(proof.id);
      if (!matches(current)) return false;
      await remote.withClient(account, password, async client => {
        // Connecting can await I/O while another window saves locally.
        if (!matches(db.messageById(proof.id))) return;
        await remote.removeUid(client, current.folder_path, current.uid, current.uid_validity);
      });
    }
    // A save can also arrive while the server deletion is in flight.
    if (!matches(db.messageById(proof.id))) return false;
    db.deleteMessage(proof.id);
    return true;
  });
}

async function deliver(params, lifecycle) {
  let account = db.accountById(params && params.accountId);
  if (!account) return fail("not-found", "Choose an account before sending.");
  const draftId = params && (params.draftId || params.emailId);
  const proof = draftId && /^[a-f0-9]{64}$/.test(params.draftRevision || "")
    ? { id: draftId, revision: params.draftRevision } : null;
  try {
    // Freeze the name before any provider lookup/queue wait. Only the address
    // gets revalidated against provider permissions immediately before sending.
    const identity = composeIdentity.outgoingIdentity(account, params.fromAddress, params.fromDisplayName);
    params = { ...params, ...identity, fromAddress: await composeIdentity.sendingFrom(account, identity.fromAddress) };
  }
  catch (error) { return fail("invalid_from", error.message); }
  account = db.accountById(account.id);
  if (!account) return fail("not-found", "That mailbox is no longer connected.");
  const resolved = resolveAttachments(params && params.attachments, account);
  if (resolved.error) return fail(resolved.error.code, resolved.error.message);
  const files = resolved.files;
  const options = mimeOptions(account, params || {}, files);
  if (!options.to.length && !options.cc.length && !options.bcc.length) {
    return fail("invalid", "Add a recipient.");
  }
  const candidateId = `delivery-${crypto.randomBytes(8).toString("hex")}`;
  let recoveryId = null;
  let receipt;
  try {
    const submitted = await submitSmtp({
      account,
      options,
      messageId: lifecycle?.messageId || rfcMessageId(account.email),
      onAccepted(next) {
        receipt = next;
        if (lifecycle?.onAccepted) return lifecycle.onAccepted(next);
        if (!next.rejected.length) return;
        db.insertScheduled({ id: candidateId, accountId: account.id, status: "partial", sendAt: Date.now(), createdAt: Date.now(),
          messageId: next.messageId, receiptJson: JSON.stringify(next), error: deliveryReceipt.summary(next),
          payloadJson: JSON.stringify({ to: params.to, cc: params.cc, bcc: params.bcc, subject: options.subject, body: options.html,
            fromAddress: params.fromAddress, fromDisplayName: params.fromDisplayName, attachments: resolved.meta, inReplyTo: params.inReplyTo, threadId: params.threadId, references: params.references }) });
        recoveryId = candidateId;
        scheduledDelivering.add(candidateId);
      },
      threadId: (params && params.threadId) || null,
      inReplyTo: (params && params.inReplyTo) || null,
      files,
      meta: resolved.meta,
    });
    receipt = submitted.receipt || receipt;
    const partial = !!receipt?.rejected?.length;
    if (submitted.kind !== "accepted" && !partial) {
      const message = submitted.kind === "rejected" && submitted.refusal
        ? submitted.refusal
        : (submitted.detail || "The mail server did not confirm this message.");
      const result = fail("send", message);
      result.error.delivery = submitted.kind === "rejected" ? "not_sent" : "unknown";
      return result;
    }
    let warning = partial ? deliveryReceipt.summary(receipt) : "";
    if (partial && !lifecycle && !recoveryId) {
      // Check a possibly committed outcome; never repeat submission to repair it.
      try { if (db.scheduledById(candidateId)?.status === "partial") recoveryId = candidateId; } catch { /* storage may be unavailable */ }
      if (recoveryId) scheduledDelivering.add(recoveryId);
      if (!recoveryId) warning += " The recovery record could not be saved. Keep or copy this message and the rejected addresses before closing; do not resend to accepted recipients.";
    }
    try {
      if (draftId && (!partial || lifecycle || recoveryId)) {
        if (!(await cleanupSubmittedDraft(account, proof))) {
          warning += " The source draft was kept because its submitted revision could not be verified or has changed.";
        }
      }
    } catch (error) {
      warning += " SMTP accepted the submission, but local cleanup could not finish. Check Sent before any retry.";
    }
    try { emitAccounts(); } catch { warning += " Saved mail could not be refreshed. Keep this receipt and check storage before closing."; }
    return ok({ emailId: submitted.emailId, messageId: receipt?.messageId || submitted.messageId, platform: "imap",
      ...(warning ? { warning } : {}), ...(partial ? { partial: true, receipt, recoveryId, recoverySaved: !!recoveryId || !!lifecycle } : {}) });
  } finally {
    if (recoveryId) scheduledDelivering.delete(recoveryId);
    if (receipt?.rejected?.length && !lifecycle) {
      try { emitAccounts({ scheduledUpdated: true }); } catch { /* return the known partial outcome even if storage is unavailable */ }
    }
  }
}

async function pumpScheduled() {
  return updateGate.run(() => pumpScheduledAdmitted());
}

async function pumpScheduledAdmitted() {
  if (!ready || pumping) return;
  pumping = true;
  try {
    const due = db.dueScheduled(Date.now());
    for (const candidate of due) {
      // Another queued item may have been canceled/edited while delivery awaited I/O.
      const current = db.scheduledById(candidate.id);
      if (!current || current.status !== "pending") continue;
      // The claim is durable before validation/submission, not just an in-memory
      // spinner. A crash from here onward requires review, never automatic replay.
      const account = db.accountById(current.account_id);
      const row = db.claimScheduled(current.id, rfcMessageId(account?.email || "morrow.local"));
      if (!row) continue;
      scheduledDelivering.add(row.id);
      let payload = {};
      try { payload = JSON.parse(row.payload_json) || {}; } catch { payload = {}; }
      const presented = textEncoding.presentMessage({
        subject: payload.subject || "",
        htmlBody: typeof payload.body === "string" ? payload.body : "",
      });
      let result;
      try {
        result = await deliver({
          ...payload,
          fromDisplayName: typeof payload.fromDisplayName === "string" ? payload.fromDisplayName : "",
          accountId: row.account_id,
          subject: presented.subject,
          body: presented.htmlBody || "",
        }, { messageId: row.message_id, onAccepted(receipt) {
          if (!db.acceptScheduled(row.id, receipt.messageId, receipt)) throw new Error("The delivery receipt could not be saved. Check Sent before retrying.");
        } });
      } catch (error) {
        result = fail("send", error instanceof Error ? error.message : String(error));
        result.error.delivery = "unknown";
      }
      try {
        const status = db.scheduledById(row.id)?.status;
        if (status === "sent") {
          if (result && result.success) {
            if (result.data?.warning) db.noteScheduledWarning(row.id, result.data.warning);
            else db.deleteScheduled(row.id);
          }
        } else if (status === "partial" && result?.data?.warning) {
          db.noteScheduledWarning(row.id, result.data.warning);
        } else if (status !== "partial") {
          db.failScheduled(row.id, result?.error?.message || result?.data?.warning, result?.error?.delivery === "unknown", result?.data?.receipt);
        }
      } finally {
        scheduledDelivering.delete(row.id);
        emitAccounts({ scheduledUpdated: true });
      }
    }
  } finally {
    pumping = false;
  }
}

function answer(channel, args, event) {
  if (!ready) return undefined;
  if (sidecar.handles(channel)) return sidecar.answer(channel, args);
  const params = args && args.length ? args[0] : undefined;
  if (channel === "mail:cancelAttachmentRequest") return ok(attachmentRequests.cancel(params?.requestId, event?.sender));
  if (channel === "mail:listImapSmtpPresets") return ok(presets.CARDS);
  if (channel === "mail:discoverMail") return discoverMail(params || {});
  if (channel === "mail:connectImapSmtp") return connectAccount(params || {});
  if (channel === "mail:uploadAttachment" || channel === "mail:uploadInlineImage" || channel === "mail:uploadAgentFile") {
    return saveUpload(params || {});
  }
  if (channel === "mail:removeAccount") return removeAccount(params || {});
  if (channel === "mail:clearAuthFailures") {
    if (ready) {
      db.clearAuthError(params && params.accountId);
      if (params && params.accountId) syncRetryScheduler.clear(String(params.accountId));
      else syncRetryScheduler.stop();
    }
    return ok(true);
  }
  if (channel === "mail:cancelOAuth") return cancelOAuth();
  if (channel === "mail:migrateGmail") {
    const account = db.accountById(params?.accountId);
    if (!account || account.profile !== "gmail" || account.auth_kind !== "oauth2") return fail("invalid", "Choose a connected Google OAuth mailbox.");
    if (params?.confirmed !== true) return fail("confirmation_required", "Review Gmail API migration and reauthorization before continuing.");
    if (db.gmailMigrationBlockers(account.id)) return fail("conflict", "Finish or resolve pending mail actions before migrating Gmail.");
    return connectOAuthAccount("google", account.id, { migrateGmail: true });
  }
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
    case "mail:getComposeContext":
      return (async () => {
        const account = db.accountById(params && params.accountId);
        if (!account) return fail("not-found", "Choose a connected mailbox.");
        try {
          let message = null;
          if (params.sourceMessageId) {
            let row = db.messageById(params.sourceMessageId);
            if (!row || row.account_id !== account.id) return fail("invalid", "The source message does not belong to this mailbox.");
            const replying = ["reply", "all"].includes(params.kind);
            if (replying) row = localSentReplyHeaders(row, account);
            const fresh = await ensureBody(row, { replyHeaders: replying });
            if (replying && !Array.isArray(JSON.parse(fresh.recipient_headers_json || "{}").replyTo)) {
              return fail("read", "Reply headers could not be downloaded. Reopen the message to retry before replying.");
            }
            message = detailOf(fresh);
          }
          return ok({ ...await composeIdentity.context(account, message, params.kind || "new", params.fromAddress, params.refresh === true),
            ...(message ? { replyTo: message.replyTo } : {}) });
        } catch (error) { return fail("compose_identity", error.message); }
      })();
    case "mail:refreshAccounts":
      setTimeout(() => { syncAll().catch(() => {}); }, 0);
      return ok({ refreshed: true, refreshedAt: Date.now() });
    case "mail:setAccountLabel": {
      const id = params && params.accountId ? String(params.accountId) : "";
      const account = id && db.accountById(id);
      if (!account) return fail("account", "Choose an account.");
      const trimmed = String(params.label == null ? "" : params.label).trim();
      if (trimmed.length > 200) return fail("label", "Use 200 characters or fewer.");
      db.saveAccountLabel(id, trimmed || null);
      emitAccounts();
      return ok(accountViews().find((item) => item.id === id) || null);
    }
    case "mail:listAccounts":
    case "mail:refreshUnreadCounts":
    case "mail:unreadCounts":
      return ok(accountViews());
    case "mail:listFromCacheAggregate":
    case "mail:listFromCache":
    case "mail:listWindowRead":
    case "mail:loadMoreAggregate":
      if (params && params.accountId && params.folderId && !virtuals.get(params.folderId)) {
        noteActive(params.accountId, params.folderId);
      }
      return ok(cachedList(params));
    case "mail:getSyncStatus":
      return ok(publicSync(params));
    case "mail:getBodySyncStatus":
      return ok(bodySyncSnapshot());
    case "mail:listFromNetwork":
      return (async () => {
        const query = params || {};
        if (virtuals.get(query.folderId)) {
          return ok(cachedList(query));
        }
        const account = query.accountId ? db.accountById(query.accountId) : null;
        if (account && query.folderId) noteActive(account.id, query.folderId);
        // A manual Sync starts a fresh sequence. The in-flight read is the attempt.
        if (account) syncRetryScheduler.clear(account.id);
        try {
          if (account && query.folderId) {
            await syncFolderPath(account, query.folderId);
          } else if (account) {
            await syncAccount(account, { onlyInbox: true });
          }
        } catch (error) {
          if (!(error && error.syncReported) && account) {
            reportSyncFailure(account, error, { folderId: query.folderId, emitAuth: true });
          }
          if (!http.isRateLimit(error) && db.countMessages(queryFrom(query)) === 0) return fail("sync", remote.explain(error));
        }
        emitAccounts();
        return ok(cachedList(query));
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
    case "mail:searchSender":
      return searchSender(params || {});
    case "mail:openEmail":
      return (async () => {
        const stored = db.messageById(params && params.emailId);
        if (!stored) return fail("email-gone", "That message is no longer in the mailbox.");
        const paintFirst = !(params && params.full === true)
          && stored.body_complete !== 1
          && usableStoredBody(stored);
        let row;
        try { row = paintFirst ? stored : await ensureBody(stored); }
        catch (error) { return fail(error.code || "read", error.message); }
        if (!row) return fail("email-gone", "That message is no longer in the mailbox.");
        if (paintFirst) queueOpenFill(stored);
        const members = db.messagesByThread(row.account_id, row.thread_id, { headersOnly: true }).map(listRow);
        return ok({
          email: detailOf(row),
          isThread: members.length > 1,
          threadMessages: members,
        });
      })();
    case "mail:prepareDraft":
      return updateGate.run(() => prepareDraft(params || {}, event?.sender));
    case "mail:readEmail":
      return (async () => {
        let row;
        try { row = await ensureBody(db.messageById(params && params.emailId)); }
        catch (error) { return fail(error.code || "read", error.message); }
        if (!row) return fail("email-gone", "That message is no longer in the mailbox.");
        return ok(detailOf(row));
      })();
    case "mail:getLocalThreadMembers":
    case "mail:listThreadMessages": {
      const threadId = params && params.threadId;
      const accountId = params && params.accountId;
      if (!threadId) return ok([]);
      const headersOnly = params && params.headersOnly === true;
      const rows = accountId
        ? db.messagesByThread(accountId, threadId, { headersOnly })
        : db.selectMessages({ tokens: [], limit: 50 }, { headersOnly }).filter((row) => row.thread_id === threadId);
      return ok(rows.map((row) => headersOnly ? listRow(row) : detailOf(row)));
    }
    case "mail:markRead":
    case "mail:markReadBatch":
    case "mail:toggleStar":
    case "mail:toggleStarBatch":
    case "mail:archive":
    case "mail:threadArchive":
    case "mail:delete":
    case "mail:threadTrash":
    case "mail:markSpam":
    case "mail:markNotSpam":
    case "mail:archiveBatch":
    case "mail:deleteBatch":
    case "mail:moveToFolder":
    case "mail:threadMove":
    case "mail:moveToFolderBatch":
    case "mail:undoRemoval":
      return actions.handle(channel, params);
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
          providerId: folder.provider_id,
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
        // Stable-id Gmail discovery may already have reconciled the rename.
        const reconciled = account.mail_transport === "gmail_api" ? confirmed.filter(move => {
          const providerId = records.find(row => row.path === move.from)?.providerId;
          return providerId && !db.folderByPath(account.id, move.from) && db.folderByPath(account.id, move.to)?.provider_id === providerId;
        }) : [];
        const rewritten = db.rewriteFolderPaths(account.id, confirmed.filter(move => !reconciled.includes(move)));
        const rewrite = { moved: [...reconciled.map(({ from, to }) => ({ from, to })), ...rewritten.moved], skipped: rewritten.skipped };
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
          if (account.mail_transport === "gmail_api") return fail("partial", "Gmail accepted the label creation but has not returned its identity. Refresh folders before moving mail; do not repeat creation.");
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
        let fromAddress, fromDisplayName;
        try { ({ fromAddress, fromDisplayName } = composeIdentity.outgoingIdentity(account, params.fromAddress, params.fromDisplayName)); }
        catch (error) { return fail("invalid_from", error.message); }
        const drafts = db.folderByWellKnown(account.id, "drafts");
        if (!drafts) return fail("not-found", "This account has no Drafts folder.");
        const emailId = (params && params.emailId) || db.newMessageId();
        const existing = db.messageById(emailId);
        if (existing && (existing.account_id !== account.id || !existing.is_draft)) return fail("invalid", "That draft does not belong to this mailbox.");
        if (existing && params.draftRevision && params.draftRevision !== db.draftRevision(existing)) {
          return fail("draft_conflict", "This draft changed in another window. Your text is still here; keep a copy before reopening the saved draft.");
        }
        // A legacy UID is not a Gmail identity. Preserve the remote draft rather
        // than replacing its RFC id locally and then trying to resolve that new id.
        const detachedGmailDraft = account.mail_transport === "gmail_api" && existing?.uid > 0
          && !db.gmailAlias(account.id, existing.folder_path, existing.uid, existing.uid_validity);
        const resolved = resolveAttachments(params && params.attachments, account);
        if (resolved.error) return fail(resolved.error.code, resolved.error.message);
        const files = resolved.files;
        const presented = textEncoding.presentMessage({
          subject: params.subject || "",
          htmlBody: typeof params.body === "string" ? params.body : "",
        });
        const html = presented.htmlBody || "";
        const when = new Date();
        // A distinct RFC identity prevents an older server copy from adopting a
        // newer local revision, including after an interrupted APPEND.
        const messageId = rfcMessageId(account.email);
        const record = {
          id: emailId,
          accountId: account.id,
          folderPath: drafts.path,
          uid: existing && !detachedGmailDraft ? existing.uid : 0,
          uidValidity: existing && !detachedGmailDraft ? existing.uid_validity : 0,
          threadId: (params && params.threadId) || emailId,
          rfcMessageId: messageId,
          subject: presented.subject,
          snippet: plainFromHtml(html).slice(0, 180),
          from: fromAddress,
          fromDisplayName,
          to: addrList(params.to),
          cc: addrList(params.cc),
          bcc: addrList(params.bcc),
          date: when.toISOString(),
          listSortTs: when.getTime(),
          unread: false,
          isDraft: true,
          hasAttachments: resolved.meta.length > 0,
          attachments: resolved.meta,
          htmlBody: html,
          textBody: presented.textBody || plainFromHtml(html),
          bodyComplete: true,
          recipientHeaders: { replyTo: [] },
          draftPending: true,
          inReplyTo: params.inReplyTo || null,
        };
        if (existing) {
          db.updateMessage(emailId, {
            ...(detachedGmailDraft ? { uid: 0, uid_validity: 0, gmail_id: null } : {}),
            folder_path: drafts.path,
            thread_id: record.threadId,
            subject: record.subject,
            snippet: record.snippet,
            from_addr: record.from,
            from_address: record.from,
            from_display_name: record.fromDisplayName,
            rfc_message_id: messageId,
            to_json: JSON.stringify(record.to),
            cc_json: JSON.stringify(record.cc),
            bcc_json: JSON.stringify(record.bcc),
            date_iso: record.date,
            list_sort_ts: record.listSortTs,
            is_draft: 1,
            has_attachments: record.hasAttachments ? 1 : 0,
            attachments_json: JSON.stringify(resolved.meta),
            html_body: html,
            text_body: record.textBody,
            body_complete: 1,
            recipient_headers_json: JSON.stringify(record.recipientHeaders),
            draft_pending: 1,
            in_reply_to: record.inReplyTo,
          });
        } else {
          db.insertMessage(record);
        }
        let remoteSaved = false;
        let warning = detachedGmailDraft ? "The earlier Gmail draft could not be linked safely and was retained on the server. This Save creates a new server copy." : "";
        const revision = db.draftRevision(db.messageById(emailId));
        try {
          await exclusive(account.id, async () => {
            const matches = () => db.draftRevision(db.messageById(emailId)) === revision;
            if (!matches()) { warning = "A newer draft revision was saved. This upload was skipped."; return; }
            const password = await secretFor(account);
            const raw = await remote.buildRaw({
              ...mimeOptions(account, { ...params, fromAddress, fromDisplayName, subject: presented.subject, body: html }, files),
              messageId,
              keepBcc: account.mail_transport === "gmail_api",
            });
            await remote.withClient(account, password, async (client) => {
              if (!matches()) { warning = "A newer draft revision was saved. This upload was skipped."; return; }
              actions.assertIdentityReady(emailId);
              const prior = db.messageById(emailId);
              if (client.gmail && prior.uid > 0) await client.gmail.resolve(prior.folder_path, prior.uid, prior.uid_validity, emailId);
              if (prior.uid > 0 && prior.uid_validity > 0) await remote.checkUidValidity(client, prior.folder_path, prior.uid_validity);
              if (!matches()) { warning = "A newer draft revision was saved. This upload was skipped."; return; }
              // Keep the old remote copy until the replacement is confirmed and
              // the matching local revision has been durably updated.
              const appended = await remote.appendRaw(client, drafts.path, raw, ["\\Draft", "\\Seen"]);
              if (!appended) throw new Error("The server did not confirm the draft upload.");
              if (!matches()) { warning = "A newer draft revision was saved and kept. An older server copy may remain."; return; }
              const confirmed = Number(appended.uid) > 0 && Number(appended.uidValidity) > 0;
              db.updateMessage(emailId, {
                uid: confirmed ? Number(appended.uid) : 0,
                uid_validity: confirmed ? Number(appended.uidValidity) : 0,
                ...(client.gmail ? { gmail_id: appended.providerId } : {}),
                draft_pending: 0,
              });
              remoteSaved = true;
              if (prior.uid > 0) {
                if (confirmed && prior.uid_validity === Number(appended.uidValidity) && prior.uid !== Number(appended.uid)) {
                  try { await remote.removeUid(client, prior.folder_path, prior.uid, prior.uid_validity); }
                  catch { warning = "The new draft is saved. An older server copy could not be removed and may remain."; }
                } else warning = "The new draft is saved. An older server copy was retained because its replacement identity could not be verified.";
              }
            });
          });
        } catch (error) {
          warning = error?.code === "uid_validity_changed" || error?.code === "message_moving" ? error.message
            : "Local changes are protected. The server copy could not be updated; Save draft to retry.";
        }
        emitAccounts();
        return ok({ emailId, draftId: emailId, draftRevision: revision, remoteSaved, warning });
      })();
    case "mail:deleteDraft":
      return (async () => {
        const row = db.messageById(params && params.emailId);
        if (row) {
          try {
            actions.assertIdentityReady(row.id);
            const account = db.accountById(row.account_id);
            if (account && row.uid) {
              await exclusive(account.id, async () => {
                const password = await secretFor(account);
                actions.assertIdentityReady(row.id);
                const current = db.messageById(row.id);
                if (account.mail_transport === "gmail_api" && current && db.draftRevision(current) !== db.draftRevision(row)) throw Object.assign(new Error("This draft changed while deletion was waiting. Review the current draft before discarding it."), { code: "draft_changed" });
                if (current) await remote.withClient(account, password, (client) => remote.removeUid(client, current.folder_path, current.uid, current.uid_validity));
              });
            }
          } catch (error) {
            if (db.accountById(row.account_id)?.mail_transport === "gmail_api" || error?.code === "uid_validity_changed" || error?.code === "message_moving") return fail(error.code || "draft_cleanup", error.message || "The Gmail draft could not be moved to Trash. The local copy was retained.");
            // Drop the local row even if the server delete fails.
          }
          const current = db.messageById(row.id);
          if (db.accountById(row.account_id)?.mail_transport === "gmail_api" && current && db.draftRevision(current) !== db.draftRevision(row)) return fail("draft_changed", "The server copy was moved to Trash. New local edits were retained; review the current draft.");
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
    case "mail:restoreScheduled":
      return restoreScheduled(params || {});
    case "mail:downloadAttachment":
    case "mail:downloadAttachmentsZip":
    case "mail:fetchAttachmentBytes":
    case "mail:openAttachmentExternally":
      return attachmentOperation(channel, params || {}, event?.sender);
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

function noteBotSent(receipt) {
  try {
    if (!receipt || !receipt.accountId || !receipt.messageId) return;
    if (db.messageByRfc(receipt.accountId, receipt.messageId)) return;
    const sent = db.folderByWellKnown(receipt.accountId, "sentitems");
    if (!sent) return;
    const when = new Date();
    const emailId = db.newMessageId();
    db.insertMessage({
      id: emailId,
      accountId: receipt.accountId,
      folderPath: sent.path,
      threadId: emailId,
      rfcMessageId: receipt.messageId,
      subject: receipt.subject || "",
      snippet: String(receipt.text || "").slice(0, 180),
      from: receipt.fromAddress || "",
      fromDisplayName: receipt.fromDisplayName || "",
      to: receipt.to || [],
      cc: receipt.cc || [],
      bcc: receipt.bcc || [],
      date: when.toISOString(),
      listSortTs: when.getTime(),
      isDraft: false,
      htmlBody: receipt.html || "",
      textBody: receipt.text || "",
      bodyComplete: true,
      recipientHeaders: { replyTo: [] },
      inReplyTo: receipt.inReplyTo || null,
    });
  } catch {
    // A durable submit already happened. A missing local Sent row can be adopted later.
  }
}

actions.install({ exclusive, secretFor, emitAccounts, broadcast });

module.exports = {
  init,
  answer,
  settleActions: actions.settleActions,
  settleAccount: actions.settleAccount,
  bytesFor,
  attachmentCacheForTest: attachmentCache,
  submitSmtp,
  setSmtpSenderForTest,
  noteBotSent,
  STARRED_FOLDER_ID,
  UNREAD_FOLDER_ID,
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
  mailQueueForTest,
  syncAccountById,
  syncAllForTest,
  fillOvernightBodies,
  resetOvernightForTest,
  syncPolicy: {
    get syncDays() { return syncHorizonDays(); },
    headerBatch: HEADER_BATCH,
    outlookBatch: OUTLOOK_BATCH,
    refreshPages: REFRESH_PAGES.slice(),
    pageDelayMs: PAGE_DELAY_MS,
    maxPages: MAX_PAGES,
    tickMs: TICK_MS,
    rateLimitMs: RATE_LIMIT_MS,
    stormMs: STORM_MS,
    pollMs: POLL_MS,
    syncRetryDelaysMs: syncRetry.SYNC_RETRY_DELAYS_MS.slice(),
    vacationRetryDelaysMs: syncRetry.OOO_RETRY_DELAYS_MS.slice(),
    idleRenewMs: idle.IDLE_RENEW_MS,
    idleSafetyPollMs: idle.IDLE_SAFETY_POLL_MS,
    idleBackoffCapMs: idle.IDLE_BACKOFF_CAP_MS,
    searchLimit: SEARCH_LIMIT,
  },
};
