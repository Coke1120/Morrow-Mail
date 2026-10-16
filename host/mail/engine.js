const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const presets = require("./presets");
const remote = require("./remote");

const secrets = process.env.GENMAIL_MAIL_SECRETS === "memory"
  ? require("./memory-secrets")
  : require("./secrets");

const PRIMARY_ORDER = ["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"];
const KEY_TO_WELL = {
  inbox: "inbox",
  drafts: "drafts",
  sent: "sentitems",
  trash: "deleteditems",
  archive: "archive",
  spam: "junkemail",
};
const SNOOZE_MAX_MS = 365 * 24 * 60 * 60 * 1000;
const INBOX_LIMIT = 120;
const OTHER_LIMIT = 40;

let ready = false;
const tails = new Map();

function ok(data) {
  return { success: true, data };
}

function fail(code, message) {
  return { success: false, error: { code, message, status: 0, retryable: false } };
}

function dataFile() {
  const override = (process.env.GENMAIL_MAIL_DIR || "").trim();
  if (override) return path.join(override, "mail.sqlite");
  let dir = "";
  try {
    const { app } = require("electron");
    if (app && app.isReady()) dir = app.getPath("userData");
  } catch {
    dir = "";
  }
  if (!dir) dir = path.join(os.homedir(), "Library/Application Support/genmail-exact");
  return path.join(dir, "mail.sqlite");
}

async function init() {
  await db.open(dataFile());
  ready = true;
}

const depths = new Map();

function exclusive(accountId, fn) {
  const entry = depths.get(accountId) || { depth: 0 };
  depths.set(accountId, entry);
  if (entry.depth > 0) {
    entry.depth += 1;
    return Promise.resolve().then(fn).finally(() => {
      entry.depth -= 1;
    });
  }
  const prev = tails.get(accountId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => {
    entry.depth = 1;
    return Promise.resolve().then(fn).finally(() => {
      entry.depth = 0;
    });
  });
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
  const view = {
    id: row.id,
    email: row.email,
    displayEmail: row.email,
    preferredFromAddress: row.email,
    senderName: null,
    defaultSenderName: null,
    sendAs: [{ email: row.email, name: null, isDefault: true }],
    name: null,
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
    imapUsername: row.username,
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
  const own = accountViews();
  let accounts = own;
  if (!own.length) {
    try {
      accounts = require("../mailbox").accountList();
    } catch {
      accounts = [];
    }
  }
  broadcast("mail:accountsUpdated", { source: "server", accounts, ...(extra || {}) });
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

function serverHasMore(query) {
  if (query.folderKey) {
    const paths = db.pathsForKey(query.accountId, query.folderKey);
    return paths.some((entry) => {
      const folder = db.folderByPath(entry.account_id, entry.path);
      if (!folder) return false;
      const cached = db.countInFolder(entry.account_id, entry.path);
      return folder.total > cached;
    });
  }
  if (query.accountId && query.folderId) {
    const folder = db.folderByPath(query.accountId, query.folderId);
    if (!folder || !folder.synced_at) return false;
    const cached = db.countInFolder(query.accountId, query.folderId);
    return folder.total > cached;
  }
  return false;
}

function synced(query) {
  const folders = query.folderKey
    ? db.pathsForKey(query.accountId, query.folderKey).map((entry) => db.folderByPath(entry.account_id, entry.path))
    : (query.accountId && query.folderId ? [db.folderByPath(query.accountId, query.folderId)] : []);
  if (!folders.length) return true;
  return folders.every((folder) => folder && folder.synced_at);
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

function passwordFor(account) {
  const password = secrets.getPassword(account.id);
  if (!password) {
    const error = new Error("The password for this account is not in the keychain. Connect the account again.");
    error.code = "auth";
    throw error;
  }
  return password;
}

function emitFolderSync(accountId, folderPath, okFlag) {
  broadcast("mail:folderSyncCompleted", {
    accountId,
    folderId: folderPath,
    ok: okFlag === true,
    newThreadCount: 0,
  });
}

async function syncFolderPath(account, folderPath, options) {
  return exclusive(account.id, async () => {
    const password = passwordFor(account);
    try {
      const report = await remote.withClient(account, password, (client) => remote.syncFolder(client, folderPath, options || {}));
      db.applyFolderSync(account.id, folderPath, report);
      emitFolderSync(account.id, folderPath, true);
      return report;
    } catch (error) {
      emitFolderSync(account.id, folderPath, false);
      throw error;
    }
  });
}

async function syncAccount(account, options) {
  const password = passwordFor(account);
  await exclusive(account.id, async () => {
    await remote.withClient(account, password, async (client) => {
      const listed = await remote.listFolderRecords(client);
      db.replaceFolders(account.id, listed.folders, listed.delimiter);
      const folders = db.foldersFor(account.id);
      const inbox = folders.find((folder) => folder.well_known === "inbox");
      const rest = folders.filter((folder) => folder !== inbox);
      const jobs = [];
      if (inbox && (!options || options.folderKey === "inbox" || !options.folderKey && !options.onlyPath)) {
        jobs.push(inbox);
      }
      if (!options || !options.onlyInbox) {
        for (const folder of rest) {
          if (options && options.folderKey && KEY_TO_WELL[options.folderKey] !== folder.well_known) continue;
          if (options && options.onlyPath && options.onlyPath !== folder.path) continue;
          jobs.push(folder);
        }
      }
      for (const folder of jobs) {
        const limit = folder.well_known === "inbox" ? INBOX_LIMIT : OTHER_LIMIT;
        const before = options && options.before && options.onlyPath === folder.path ? options.before : null;
        const report = await remote.syncFolder(client, folder.path, { limit, before });
        db.applyFolderSync(account.id, folder.path, report);
        emitFolderSync(account.id, folder.path, true);
      }
    });
    db.clearAuthError(account.id);
  });
}

async function syncAll(options) {
  const accounts = db.listAccountRows();
  for (const account of accounts) {
    try {
      await syncAccount(account, options);
    } catch (error) {
      const message = remote.explain(error, secrets.getPassword(account.id));
      if (/password|keychain|rejected the password/i.test(message)) db.setAuthError(account.id, message);
    }
  }
  emitAccounts();
}

let pollTimer = null;
let syncing = false;

function startBackgroundSync() {
  if (!ready) return;
  const tick = () => {
    if (syncing || !db.hasAccounts()) return;
    syncing = true;
    syncAll().catch(() => {}).finally(() => {
      syncing = false;
    });
  };
  setTimeout(tick, 400);
  if (!pollTimer) pollTimer = setInterval(tick, 45000);
}

async function connectAccount(params) {
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
    try {
      await syncFolderPath(account, inbox.path, { limit: INBOX_LIMIT });
    } catch (error) {
      db.setAuthError(id, remote.explain(error, password));
    }
  }
  emitAccounts();
  setTimeout(() => {
    syncAccount(db.accountById(id), {}).then(() => emitAccounts()).catch(() => {});
  }, 200);
  const view = accountView(db.accountById(id), 0);
  return ok(view);
}

async function removeAccount(params) {
  const id = params && (params.accountId || params.id);
  if (!id || !db.accountById(id)) return undefined;
  secrets.deletePassword(id);
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
  if (!account) return;
  if (!row.uid) {
    db.updateMessage(row.id, {
      folder_path: destination,
      is_draft: wellKnown === "drafts" ? 1 : 0,
    });
    return;
  }
  await exclusive(account.id, async () => {
    const password = passwordFor(account);
    const next = await remote.withClient(account, password, (client) => remote.moveUid(client, row.folder_path, row.uid, destination));
    db.updateMessage(row.id, {
      folder_path: destination,
      uid: next.uid,
      uid_validity: next.uidValidity || row.uid_validity,
      is_draft: wellKnown === "drafts" ? 1 : 0,
    });
  });
}

async function moveIds(ids, targetWell, targetPath) {
  const snapshots = [];
  for (const id of ids) {
    const row = db.messageById(id);
    if (!row) continue;
    const destFolder = targetPath
      ? db.folderByPath(row.account_id, targetPath)
      : db.folderByWellKnown(row.account_id, targetWell);
    if (!destFolder) throw new Error("That folder is not on this account.");
    snapshots.push({
      id: row.id,
      folderPath: row.folder_path,
      uid: row.uid,
      uidValidity: row.uid_validity,
    });
    await moveRow(row, destFolder.path, destFolder.well_known);
  }
  const opId = remember(snapshots);
  emitAccounts();
  return opId;
}

async function ensureBody(row) {
  if (!row || row.body_complete === 1 || !row.uid) return row;
  const account = db.accountById(row.account_id);
  if (!account) return row;
  try {
    return await exclusive(account.id, async () => {
    const password = passwordFor(account);
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
      const password = passwordFor(account);
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

function searchRows(params) {
  const filters = (params && params.filters) || {};
  const tokens = String((params && params.query) || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((token) => token.replace(/[%_\\]/g, ""))
    .filter(Boolean);
  if (!tokens.length && !filters.participant && !filters.unread && !filters.hasAttachment && !filters.fromMe) {
    return [];
  }
  return db.selectMessages({
    tokens,
    filterUnread: filters.unread === true,
    filterAttachments: filters.hasAttachment ? true : undefined,
    sinceTs: Number.isFinite(filters.sinceMs) ? filters.sinceMs : null,
    participant: filters.participant ? String(filters.participant).toLowerCase() : null,
    fromMe: filters.fromMe === true,
    limit: (params && params.limit) || 30,
    offset: 0,
  }).map(listRow);
}

async function searchServer(params) {
  const text = String((params && params.query) || "").trim();
  if (!text) return;
  const accounts = params.accountId
    ? [db.accountById(params.accountId)].filter(Boolean)
    : db.listAccountRows();
  for (const account of accounts) {
    try {
      await exclusive(account.id, async () => {
        const password = passwordFor(account);
        await remote.withClient(account, password, async (client) => {
          const folders = db.foldersFor(account.id).filter((folder) => (
            folder.well_known === "inbox"
            || folder.well_known === "sentitems"
            || folder.well_known === "archive"
            || folder.well_known === "drafts"
          )).slice(0, 8);
          for (const folder of folders) {
            const found = await remote.findText(client, folder.path, text, 30);
            if (!found || !found.messages.length) continue;
            db.applyFolderSync(account.id, folder.path, {
              messages: found.messages,
              validity: found.validity,
              keepOthers: true,
            });
          }
        });
      });
    } catch {
      // A server search miss still leaves the local cache results.
    }
  }
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
    const password = passwordFor(account);
    return remote.withClient(account, password, (client) => remote.readPart(client, row.folder_path, row.uid, wanted.id));
  });
  return { filename: params.filename || wanted.filename || "attachment", data };
}

function answer(channel, args) {
  if (!ready) return undefined;
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
  if (channel === "mail:addAccount") {
    return fail(
      "oauth_unavailable",
      "Google and Microsoft one-click sign-in stays on Genspark. Choose an IMAP provider and use an app password."
    );
  }
  if (!db.hasAccounts()) return undefined;

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
      return ok(listPayload(params));
    case "mail:listFromNetwork":
      return (async () => {
        const query = params || {};
        const account = query.accountId ? db.accountById(query.accountId) : null;
        try {
          if (account && query.folderId) {
            await syncFolderPath(account, query.folderId, {
              limit: query.beforeDate ? 50 : INBOX_LIMIT,
              before: query.beforeDate || null,
            });
          } else if (account) {
            await syncAccount(account, { onlyInbox: !query.folderId });
          }
        } catch (error) {
          if (db.countMessages(queryFrom(query)) === 0) return fail("sync", remote.explain(error));
        }
        emitAccounts();
        return ok(listPayload(query));
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
      return ok({ signatures: [], defaultSignatureId: null, defaultSignaturePerAccount: {} });
    case "mail:ops:queueSummary":
      return ok({ pending: 0, dead: 0, sends: 0 });
    case "mail:ops:getNetworkState":
      return ok({ state: "connected" });
    case "mail:search":
      return (async () => {
        await searchServer(params || {});
        return ok(searchRows(params || {}));
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
        for (const item of (params && params.items) || []) {
          const row = db.messageById(item.emailId || item.id);
          if (!row) continue;
          const message = await applyFlags(row, isRead ? ["\\Seen"] : [], isRead ? [] : ["\\Seen"], { unread: isRead ? 0 : 1 });
          if (message) return fail("flags", message);
        }
        emitAccounts();
        return ok(true);
      })();
    case "mail:toggleStar":
      return (async () => {
        const row = db.messageById(params && params.emailId);
        if (row && typeof params.isStarred === "boolean") {
          const message = await applyFlags(row, params.isStarred ? ["\\Flagged"] : [], params.isStarred ? [] : ["\\Flagged"], { starred: params.isStarred ? 1 : 0 });
          if (message) return fail("flags", message);
          emitAccounts();
        }
        return ok(true);
      })();
    case "mail:toggleStarBatch":
      return (async () => {
        const starred = !!(params && params.isStarred);
        for (const item of (params && params.items) || []) {
          const row = db.messageById(item.emailId || item.id);
          if (!row) continue;
          const message = await applyFlags(row, starred ? ["\\Flagged"] : [], starred ? [] : ["\\Flagged"], { starred: starred ? 1 : 0 });
          if (message) return fail("flags", message);
        }
        emitAccounts();
        return ok(true);
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
            for (const id of unique) {
              const row = db.messageById(id);
              if (!row) continue;
              const account = db.accountById(row.account_id);
              if (account && row.uid) {
                const password = passwordFor(account);
                await remote.withClient(account, password, (client) => remote.removeUid(client, row.folder_path, row.uid));
              }
              db.deleteMessage(id);
            }
            emitAccounts();
            return ok({ opIds: [] });
          }
          let well = "archive";
          if (channel === "mail:delete" || channel === "mail:threadTrash" || channel === "mail:deleteBatch") well = "deleteditems";
          if (channel === "mail:markSpam") well = "junkemail";
          if (channel === "mail:markNotSpam") well = "inbox";
          const opId = await moveIds(unique, well, null);
          return ok({ opIds: opId ? [opId] : [] });
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
          const opId = await moveIds(unique, null, target);
          return ok({ opIds: opId ? [opId] : [] });
        } catch (error) {
          return fail("move", remote.explain(error));
        }
      })();
    case "mail:undoRemoval":
      return (async () => {
        const opIds = (params && params.opIds) || [];
        for (const opId of opIds) {
          const saved = db.readOp(opId);
          for (const snap of (saved && saved.moves) || []) {
            const row = db.messageById(snap.id);
            if (!row) continue;
            try {
              await moveRow(row, snap.folderPath, null);
            } catch {
              db.updateMessage(snap.id, { folder_path: snap.folderPath, uid: snap.uid, uid_validity: snap.uidValidity || 0 });
            }
          }
        }
        emitAccounts();
        return { ok: true, success: true, data: true };
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
            const password = passwordFor(account);
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
        try {
          await exclusive(account.id, async () => {
            const password = passwordFor(account);
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
          });
        } catch {
          // The draft remains in the local cache when the server append fails.
        }
        emitAccounts();
        return ok({ emailId, draftId: emailId });
      })();
    case "mail:deleteDraft":
      return (async () => {
        const row = db.messageById(params && params.emailId);
        if (row) {
          try {
            const account = db.accountById(row.account_id);
            if (account && row.uid) {
              await exclusive(account.id, async () => {
                const password = passwordFor(account);
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
      return (async () => {
        const account = db.accountById(params && params.accountId);
        if (!account) return fail("not-found", "Choose an account before sending.");
        const files = attachmentFiles(params && params.attachments);
        const options = mimeOptions(account, params || {}, files);
        if (!options.to.length && !options.cc.length && !options.bcc.length) {
          return fail("invalid", "Add a recipient.");
        }
        try {
          const sentResult = await exclusive(account.id, async () => {
            const password = passwordFor(account);
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
                  const password = passwordFor(account);
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
      })();
    case "mail:scheduleSend":
      return fail("imap_schedule_send_unsupported", "Scheduled send is not available for IMAP accounts.");
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
          const dir = path.join(os.tmpdir(), "genmail-exact-attachments");
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
      return ok([]);
    default:
      return undefined;
  }
}

function messagesForAi(limit = 12) {
  if (!ready || !db.hasAccounts()) return [];
  return db.recentForAi(limit);
}

module.exports = {
  init,
  answer,
  messagesForAi,
  startBackgroundSync,
  accountViews,
  dataFile,
};
