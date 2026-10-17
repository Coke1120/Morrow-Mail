const fs = require("fs");
const path = require("path");

let db = null;
let filePath = "";

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
}

function persist() {
  const data = db.export();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(data), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function transaction(fn) {
  run("BEGIN");
  try {
    const value = fn();
    run("COMMIT");
    persist();
    return value;
  } catch (error) {
    try { run("ROLLBACK"); } catch { /* already closed */ }
    throw error;
  }
}

function migrate() {
  run(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    profile TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_tls INTEGER NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_tls INTEGER NOT NULL,
    delimiter TEXT NOT NULL DEFAULT '/',
    auth_error TEXT,
    created_at INTEGER NOT NULL
  )`);
  
  try {
    const cols = all("PRAGMA table_info(accounts)").map((row) => row.name);
    if (!cols.includes("auth_kind")) {
      run("ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password'");
    }
  } catch { /* fresh DB */ }

  run(`CREATE TABLE IF NOT EXISTS folders (
    account_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    well_known TEXT,
    uid_validity INTEGER,
    unread INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER,
    PRIMARY KEY (account_id, path)
  )`);
  run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    uid INTEGER NOT NULL,
    uid_validity INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    rfc_message_id TEXT,
    in_reply_to TEXT,
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    date_iso TEXT NOT NULL,
    list_sort_ts INTEGER NOT NULL,
    unread INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    html_body TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    body_complete INTEGER NOT NULL DEFAULT 0
  )`);
  run(`CREATE INDEX IF NOT EXISTS messages_folder ON messages(account_id, folder_path, list_sort_ts)`);
  run(`CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_id)`);
  run(`CREATE TABLE IF NOT EXISTS snooze (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    until_iso TEXT NOT NULL,
    PRIMARY KEY (account_id, thread_id)
  )`);
  run(`CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS ops (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL
  )`);
}

async function open(target) {
  const initSqlJs = require("sql.js");
  const wasmDir = path.dirname(require.resolve("sql.js"));
  const SQL = await initSqlJs({ locateFile: (name) => path.join(wasmDir, name) });
  filePath = target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) db = new SQL.Database(fs.readFileSync(target));
  else db = new SQL.Database();
  migrate();
  persist();
}

function close() {
  if (!db) return;
  try { persist(); } catch { /* the test may already have removed the dir */ }
  db.close();
  db = null;
}

function hasAccounts() {
  if (!db) return false;
  return get("SELECT COUNT(*) AS n FROM accounts").n > 0;
}

function listAccountRows() {
  return all("SELECT * FROM accounts ORDER BY created_at ASC, id ASC");
}

function accountById(id) {
  return get("SELECT * FROM accounts WHERE id = ?", [id]);
}

function accountByEmail(email) {
  return get("SELECT * FROM accounts WHERE lower(email) = lower(?)", [email]);
}

function insertAccount(row) {
  transaction(() => {
    run(
      `INSERT INTO accounts (
        id, email, username, profile, imap_host, imap_port, imap_tls,
        smtp_host, smtp_port, smtp_tls, delimiter, auth_error, created_at, auth_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        row.id, row.email, row.username, row.profile,
        row.imapHost, row.imapPort, row.imapTls ? 1 : 0,
        row.smtpHost, row.smtpPort, row.smtpTls ? 1 : 0,
        row.delimiter || "/", row.createdAt,
        row.authKind || "password",
      ]
    );
  });
}

function updateAccountLogin(id, row) {
  transaction(() => {
    run(
      `UPDATE accounts SET
        username = ?, profile = ?, imap_host = ?, imap_port = ?, imap_tls = ?,
        smtp_host = ?, smtp_port = ?, smtp_tls = ?, auth_error = NULL,
        auth_kind = COALESCE(?, auth_kind)
      WHERE id = ?`,
      [
        row.username, row.profile, row.imapHost, row.imapPort, row.imapTls ? 1 : 0,
        row.smtpHost, row.smtpPort, row.smtpTls ? 1 : 0,
        row.authKind || null,
        id,
      ]
    );
  });
}

function setAuthError(id, message) {
  transaction(() => run("UPDATE accounts SET auth_error = ? WHERE id = ?", [message, id]));
}

function clearAuthError(id) {
  transaction(() => {
    if (id) run("UPDATE accounts SET auth_error = NULL WHERE id = ?", [id]);
    else run("UPDATE accounts SET auth_error = NULL");
  });
}

function removeAccount(id) {
  transaction(() => {
    run("DELETE FROM messages WHERE account_id = ?", [id]);
    run("DELETE FROM folders WHERE account_id = ?", [id]);
    run("DELETE FROM snooze WHERE account_id = ?", [id]);
    run("DELETE FROM accounts WHERE id = ?", [id]);
  });
}

function replaceFolders(accountId, folders, delimiter) {
  transaction(() => {
    if (delimiter) run("UPDATE accounts SET delimiter = ? WHERE id = ?", [delimiter, accountId]);
    const existing = new Set(all("SELECT path FROM folders WHERE account_id = ?", [accountId]).map((row) => row.path));
    const next = new Set(folders.map((folder) => folder.path));
    for (const folder of folders) {
      if (existing.has(folder.path)) {
        run(
          `UPDATE folders SET name = ?, well_known = ? WHERE account_id = ? AND path = ?`,
          [folder.name, folder.wellKnown, accountId, folder.path]
        );
      } else {
        run(
          `INSERT INTO folders (account_id, path, name, well_known, uid_validity, unread, total, synced_at)
           VALUES (?, ?, ?, ?, NULL, 0, 0, NULL)`,
          [accountId, folder.path, folder.name, folder.wellKnown]
        );
      }
    }
    for (const pathName of existing) {
      if (next.has(pathName)) continue;
      run("DELETE FROM messages WHERE account_id = ? AND folder_path = ?", [accountId, pathName]);
      run("DELETE FROM folders WHERE account_id = ? AND path = ?", [accountId, pathName]);
    }
  });
}

function foldersFor(accountId) {
  return all("SELECT * FROM folders WHERE account_id = ? ORDER BY path ASC", [accountId]);
}

function folderByPath(accountId, folderPath) {
  return get("SELECT * FROM folders WHERE account_id = ? AND path = ?", [accountId, folderPath]);
}

function folderByWellKnown(accountId, wellKnown) {
  return get(
    "SELECT * FROM folders WHERE account_id = ? AND well_known = ? ORDER BY path ASC LIMIT 1",
    [accountId, wellKnown]
  );
}

function pathsForKey(accountId, folderKey) {
  const well = {
    inbox: "inbox",
    drafts: "drafts",
    sent: "sentitems",
    trash: "deleteditems",
    archive: "archive",
    spam: "junkemail",
  }[folderKey];
  if (!well) return [];
  const sql = accountId
    ? "SELECT account_id, path FROM folders WHERE well_known = ? AND account_id = ?"
    : "SELECT account_id, path FROM folders WHERE well_known = ?";
  const params = accountId ? [well, accountId] : [well];
  return all(sql, params);
}

function newMessageId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function applyFolderSync(accountId, folderPath, report) {
  return transaction(() => {
    const previous = get(
      "SELECT uid_validity FROM folders WHERE account_id = ? AND path = ?",
      [accountId, folderPath]
    );
    if (previous && previous.uid_validity && report.validity && previous.uid_validity !== report.validity) {
      run("DELETE FROM messages WHERE account_id = ? AND folder_path = ?", [accountId, folderPath]);
    }
    if (Array.isArray(report.uids) && !report.keepOthers) {
      const keep = new Set(report.uids.map((uid) => Number(uid)));
      const stored = all(
        "SELECT id, uid FROM messages WHERE account_id = ? AND folder_path = ?",
        [accountId, folderPath]
      );
      for (const row of stored) {
        // uid <= 0 is a local-only copy (a send or draft not yet given a server uid).
        if (Number(row.uid) > 0 && !keep.has(Number(row.uid))) {
          run("DELETE FROM messages WHERE id = ?", [row.id]);
        }
      }
    }
    for (const message of report.messages) {
      let found = get(
        `SELECT id FROM messages
         WHERE account_id = ? AND folder_path = ? AND uid = ? AND uid_validity = ?`,
        [accountId, folderPath, message.uid, report.validity]
      );
      if (!found && message.rfcMessageId) {
        found = get(
          `SELECT id FROM messages
           WHERE account_id = ? AND folder_path = ? AND rfc_message_id = ? AND uid <= 0`,
          [accountId, folderPath, message.rfcMessageId]
        );
      }
      if (!found && message.subject) {
        found = get(
          `SELECT id FROM messages
           WHERE account_id = ? AND folder_path = ? AND uid <= 0 AND subject = ?
             AND abs(list_sort_ts - ?) < 120000
           LIMIT 1`,
          [accountId, folderPath, message.subject, message.listSortTs || 0]
        );
      }
      const id = found ? found.id : (message.id || newMessageId());
      const fields = [
        message.threadId, message.rfcMessageId, message.inReplyTo, message.subject, message.snippet,
        message.from, JSON.stringify(message.to || []), JSON.stringify(message.cc || []),
        JSON.stringify(message.bcc || []), message.date, message.listSortTs,
        message.unread ? 1 : 0, message.starred ? 1 : 0, message.isDraft ? 1 : 0,
        message.hasAttachments ? 1 : 0, message.htmlBody, message.textBody,
        JSON.stringify(message.attachments || []), message.bodyComplete ? 1 : 0,
      ];
      if (found) {
        run(
          `UPDATE messages SET
            uid = ?, uid_validity = ?,
            thread_id = ?, rfc_message_id = ?, in_reply_to = ?, subject = ?, snippet = ?,
            from_addr = ?, to_json = ?, cc_json = ?, bcc_json = ?, date_iso = ?, list_sort_ts = ?,
            unread = ?, starred = ?, is_draft = ?, has_attachments = ?, html_body = ?, text_body = ?,
            attachments_json = ?, body_complete = ?
          WHERE id = ?`,
          [message.uid, report.validity, ...fields, id]
        );
      } else {
        run(
          `INSERT INTO messages (
            id, account_id, folder_path, uid, uid_validity, thread_id, rfc_message_id, in_reply_to,
            subject, snippet, from_addr, to_json, cc_json, bcc_json, date_iso, list_sort_ts,
            unread, starred, is_draft, has_attachments, html_body, text_body, attachments_json, body_complete
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, accountId, folderPath, message.uid, report.validity,
            ...fields,
          ]
        );
      }
    }
    if (report.keepOthers) return;
    const cachedUnread = get(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder_path = ? AND unread = 1",
      [accountId, folderPath]
    ).n;
    const unread = typeof report.unseen === "number" ? report.unseen : cachedUnread;
    const total = typeof report.exists === "number" ? report.exists : get(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder_path = ?",
      [accountId, folderPath]
    ).n;
    run(
      `UPDATE folders SET uid_validity = ?, unread = ?, total = ?, synced_at = ?
       WHERE account_id = ? AND path = ?`,
      [report.validity || null, unread, total, Date.now(), accountId, folderPath]
    );
  });
}

function countInFolder(accountId, folderPath) {
  const row = get(
    "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder_path = ?",
    [accountId, folderPath]
  );
  return row ? row.n : 0;
}

function insertMessage(row) {
  transaction(() => {
    run(
      `INSERT INTO messages (
        id, account_id, folder_path, uid, uid_validity, thread_id, rfc_message_id, in_reply_to,
        subject, snippet, from_addr, to_json, cc_json, bcc_json, date_iso, list_sort_ts,
        unread, starred, is_draft, has_attachments, html_body, text_body, attachments_json, body_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.accountId, row.folderPath, row.uid || 0, row.uidValidity || 0,
        row.threadId || row.id, row.rfcMessageId || null, row.inReplyTo || null,
        row.subject || "", row.snippet || "", row.from || "",
        JSON.stringify(row.to || []), JSON.stringify(row.cc || []), JSON.stringify(row.bcc || []),
        row.date, row.listSortTs, row.unread ? 1 : 0, row.starred ? 1 : 0, row.isDraft ? 1 : 0,
        row.hasAttachments ? 1 : 0, row.htmlBody || null, row.textBody || null,
        JSON.stringify(row.attachments || []), row.bodyComplete ? 1 : 0,
      ]
    );
  });
}

function messageById(id) {
  return get("SELECT * FROM messages WHERE id = ?", [id]);
}

function messagesByThread(accountId, threadId) {
  return all(
    "SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY list_sort_ts ASC",
    [accountId, threadId]
  );
}

function updateMessage(id, patch) {
  const assignments = [];
  const params = [];
  for (const [column, value] of Object.entries(patch)) {
    assignments.push(`${column} = ?`);
    params.push(value);
  }
  if (!assignments.length) return;
  params.push(id);
  transaction(() => run(`UPDATE messages SET ${assignments.join(", ")} WHERE id = ?`, params));
}

function deleteMessage(id) {
  transaction(() => run("DELETE FROM messages WHERE id = ?", [id]));
}

function jsonList(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const WELL_TO_KEY = {
  inbox: "inbox",
  drafts: "drafts",
  sentitems: "sent",
  deleteditems: "trash",
  archive: "archive",
  junkemail: "spam",
};

function whereFor(query) {
  const clauses = [];
  const params = [];
  if (query.accountId) {
    clauses.push("m.account_id = ?");
    params.push(query.accountId);
  }
  if (query.folderPaths && query.folderPaths.length) {
    clauses.push(`m.folder_path IN (${query.folderPaths.map(() => "?").join(", ")})`);
    params.push(...query.folderPaths);
  } else if (query.folderPath) {
    clauses.push("m.folder_path = ?");
    params.push(query.folderPath);
  }
  if (query.category && query.category !== "all" && query.category !== "primary") {
    clauses.push("0 = 1");
  }
  if (query.filterUnread) {
    clauses.push("m.unread = 1");
  }
  if (query.filterFlagged) {
    clauses.push("m.starred = 1");
  }
  if (query.filterAttachments === true) clauses.push("m.has_attachments = 1");
  if (query.filterAttachments === false) clauses.push("m.has_attachments = 0");
  if (query.beforeTs) {
    clauses.push("m.list_sort_ts < ?");
    params.push(query.beforeTs);
  }
  if (query.sinceTs) {
    clauses.push("m.list_sort_ts >= ?");
    params.push(query.sinceTs);
  }
  if (query.excludeSnoozed) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM snooze s
      WHERE s.account_id = m.account_id AND s.thread_id = m.thread_id AND s.until_iso > ?
    )`);
    params.push(new Date().toISOString());
  }
  if (query.onlySnoozed) {
    clauses.push(`EXISTS (
      SELECT 1 FROM snooze s
      WHERE s.account_id = m.account_id AND s.thread_id = m.thread_id AND s.until_iso > ?
    )`);
    params.push(new Date().toISOString());
  }
  for (const token of query.tokens || []) {
    clauses.push(`(
      lower(m.subject) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.snippet) LIKE ?
      OR lower(m.text_body) LIKE ? OR lower(m.to_json) LIKE ?
    )`);
    const like = `%${token}%`;
    params.push(like, like, like, like, like);
  }
  if (query.participant) {
    const like = `%${query.participant}%`;
    clauses.push("(lower(m.from_addr) LIKE ? OR lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)");
    params.push(like, like, like);
  }
  if (query.fromMe) {
    clauses.push("lower(m.from_addr) LIKE '%' || lower(a.email) || '%'");
  }
  return { clauses, params };
}

function resolveScope(query) {
  const next = { ...query };
  if (query.folderKey) {
    const paths = pathsForKey(query.accountId, query.folderKey);
    next.folderPaths = paths.map((row) => row.path);
    if (query.accountId) {
      next.folderPaths = paths.filter((row) => row.account_id === query.accountId).map((row) => row.path);
    }
    next.excludeSnoozed = query.folderKey === "inbox";
    if (!next.folderPaths.length) next.folderPaths = ["__missing__"];
  } else if (query.folderId && query.accountId) {
    const folder = folderByPath(query.accountId, query.folderId);
    next.folderPath = query.folderId;
    next.excludeSnoozed = folder && folder.well_known === "inbox";
  }
  return next;
}

function selectMessages(query) {
  const scope = resolveScope(query);
  const { clauses, params } = whereFor(scope);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const join = query.fromMe ? "JOIN accounts a ON a.id = m.account_id" : "";
  return all(
    `SELECT m.* FROM messages m ${join} ${where} ORDER BY m.list_sort_ts DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

function countMessages(query) {
  const scope = resolveScope(query);
  const { clauses, params } = whereFor(scope);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const join = query.fromMe ? "JOIN accounts a ON a.id = m.account_id" : "";
  return get(`SELECT COUNT(*) AS n FROM messages m ${join} ${where}`, params).n;
}

function oldestTs(query) {
  const scope = resolveScope(query);
  const { clauses, params } = whereFor(scope);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = get(`SELECT MIN(m.list_sort_ts) AS ts FROM messages m ${where}`, params);
  return row && row.ts != null ? row.ts : null;
}

function inboxUnread(accountId) {
  const folder = folderByWellKnown(accountId, "inbox");
  if (folder && typeof folder.unread === "number") return folder.unread;
  return 0;
}

function draftCount(accountId) {
  const params = [];
  let sql = `SELECT COUNT(*) AS n FROM messages m
    JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder_path
    WHERE f.well_known = 'drafts'`;
  if (accountId) {
    sql += " AND m.account_id = ?";
    params.push(accountId);
  }
  return get(sql, params).n;
}

function setSnooze(accountId, threadId, untilIso) {
  transaction(() => {
    run(
      `INSERT INTO snooze (account_id, thread_id, until_iso) VALUES (?, ?, ?)
       ON CONFLICT(account_id, thread_id) DO UPDATE SET until_iso = excluded.until_iso`,
      [accountId, threadId, untilIso]
    );
  });
}

function clearSnooze(accountId, threadId) {
  transaction(() => run("DELETE FROM snooze WHERE account_id = ? AND thread_id = ?", [accountId, threadId]));
}

function snoozeRows(accountId, mode) {
  const now = new Date().toISOString();
  if (mode === "active") {
    return all(
      "SELECT * FROM snooze WHERE account_id = ? AND until_iso > ? ORDER BY until_iso ASC",
      [accountId, now]
    );
  }
  return all(
    "SELECT * FROM snooze WHERE account_id = ? AND until_iso <= ? ORDER BY until_iso ASC",
    [accountId, now]
  );
}

function saveBlob(id, filename, mime, data) {
  transaction(() => {
    run("INSERT OR REPLACE INTO blobs (id, filename, mime, data) VALUES (?, ?, ?, ?)", [id, filename, mime, data]);
  });
}

function readBlob(id) {
  return get("SELECT id, filename, mime, data FROM blobs WHERE id = ?", [id]);
}

function saveOp(id, payload) {
  transaction(() => run("INSERT OR REPLACE INTO ops (id, payload_json) VALUES (?, ?)", [id, JSON.stringify(payload)]));
}

function readOp(id) {
  const row = get("SELECT payload_json FROM ops WHERE id = ?", [id]);
  if (!row) return null;
  try { return JSON.parse(row.payload_json); } catch { return null; }
}

function recentForAi(limit) {
  return all(
    `SELECT from_addr, subject, snippet FROM messages
     ORDER BY list_sort_ts DESC LIMIT ?`,
    [limit]
  ).map((row) => ({
    from: row.from_addr,
    subject: row.subject,
    snippet: row.snippet,
    category: "primary",
  }));
}

function inboxRow(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    from: row.from_addr || "",
    subject: row.subject || "",
    snippet: String(row.snippet || "").slice(0, 280),
    date: row.date_iso || "",
    unread: row.unread === 1,
    starred: row.starred === 1,
    hasAttachments: row.has_attachments === 1,
    threadId: row.thread_id || "",
    folderPath: row.folder_path || "",
  };
}

function recentInbox(limit) {
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 20, 1), 40);
  const columns = `m.id, m.account_id, m.subject, m.snippet, m.from_addr, m.date_iso,
            m.unread, m.starred, m.has_attachments, m.thread_id, m.folder_path`;
  const inbox = all(
    `SELECT ${columns}
     FROM messages m
     JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder_path
     WHERE f.well_known = 'inbox'
     ORDER BY m.list_sort_ts DESC
     LIMIT ?`,
    [n]
  );
  if (inbox.length) return inbox.map(inboxRow);
  return all(
    `SELECT id, account_id, subject, snippet, from_addr, date_iso,
            unread, starred, has_attachments, thread_id, folder_path
     FROM messages
     WHERE lower(folder_path) IN ('inbox', 'inbox/')
     ORDER BY list_sort_ts DESC
     LIMIT ?`,
    [n]
  ).map(inboxRow);
}

module.exports = {
  open,
  close,
  hasAccounts,
  listAccountRows,
  accountById,
  accountByEmail,
  insertAccount,
  updateAccountLogin,
  setAuthError,
  clearAuthError,
  removeAccount,
  replaceFolders,
  foldersFor,
  folderByPath,
  folderByWellKnown,
  pathsForKey,
  applyFolderSync,
  insertMessage,
  messageById,
  messagesByThread,
  updateMessage,
  deleteMessage,
  selectMessages,
  countMessages,
  countInFolder,
  oldestTs,
  inboxUnread,
  draftCount,
  setSnooze,
  clearSnooze,
  snoozeRows,
  saveBlob,
  readBlob,
  saveOp,
  readOp,
  recentForAi,
  recentInbox,
  jsonList,
  newMessageId,
  WELL_TO_KEY,
  file: () => filePath,
};
