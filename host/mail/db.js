const { Persistence } = require("./persistence");
const primaryFolderLib = require("../../shared/primary-mailboxes");

let db = null;
let filePath = "";
let storage = null;
let closing = Promise.resolve();
let writes = null;
const observedSync = new Map();

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
  if (!writes) throw new Error("Mail writes require a transaction.");
  db.run(sql, params);
  recordWrite(sql, params);
}

function recordWrite(sql, params) {
  if (!writes) throw new Error("Mail writes require a transaction.");
  if (!storage.initialized) return;
  const last = writes[writes.length - 1];
  if (last && last.sql === sql) last.bindings.push(params);
  else writes.push({ sql, bindings: [params] });
}

function changeStamp() {
  return `${get("SELECT total_changes() AS n").n}:${get("PRAGMA schema_version").schema_version}`;
}

function transaction(fn) {
  if (writes) return fn();
  db.run("BEGIN");
  const before = changeStamp();
  writes = [];
  let journalOffset = null;
  let value;
  try {
    value = fn();
    if (value && typeof value.then === "function") throw new Error("Mail transactions must be synchronous.");
    const changed = changeStamp() !== before;
    if (changed && storage.initialized) {
      db.run("UPDATE morrow_storage SET sequence = ? WHERE id = 1", [storage.sequence + 1]);
      journalOffset = storage.append(writes);
    }
    db.run("COMMIT");
  } catch (error) {
    if (journalOffset != null) {
      try { storage.rewind(journalOffset); } catch { error.storageUncertain = true; }
    }
    try { db.run("ROLLBACK"); } catch { /* already closed */ }
    // If even truncating/syncing an unsuccessful append failed, continuing could
    // put another transaction behind an uncertain tail. Require a fresh open.
    if (error.storageUncertain) close();
    throw error;
  } finally {
    writes = null;
  }
  if (journalOffset != null) storage.committed();
  return value;
}

function updateChanged(table, patch, where, whereParams) {
  const entries = Object.entries(patch);
  if (!entries.length) return false;
  const values = entries.map(([, value]) => value);
  run(`UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")}
    WHERE ${where} AND (${entries.map(([key]) => `${key} IS NOT ?`).join(" OR ")})`,
  [...values, ...whereParams, ...values]);
  return db.getRowsModified() > 0;
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
    created_at INTEGER NOT NULL,
    display_name TEXT,
    label TEXT
  )`);
  
  try {
    const cols = all("PRAGMA table_info(accounts)").map((row) => row.name);
    if (!cols.includes("auth_kind")) {
      run("ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password'");
    }
    if (!cols.includes("display_name")) {
      run("ALTER TABLE accounts ADD COLUMN display_name TEXT");
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
    uid_cursor INTEGER NOT NULL DEFAULT 0,
    window_done INTEGER NOT NULL DEFAULT 0,
    sync_horizon_days INTEGER,
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
  try {
    const folderCols = all("PRAGMA table_info(folders)").map((row) => row.name);
    if (!folderCols.includes("uid_cursor")) {
      run("ALTER TABLE folders ADD COLUMN uid_cursor INTEGER NOT NULL DEFAULT 0");
    }
    if (!folderCols.includes("window_done")) {
      run("ALTER TABLE folders ADD COLUMN window_done INTEGER NOT NULL DEFAULT 0");
    }
    if (!folderCols.includes("sync_horizon_days")) {
      run("ALTER TABLE folders ADD COLUMN sync_horizon_days INTEGER");
    }
  } catch { /* fresh table already has the columns */ }

  run(`CREATE INDEX IF NOT EXISTS messages_folder ON messages(account_id, folder_path, list_sort_ts)`);
  if (!all("PRAGMA table_info(messages)").some((row) => row.name === "recipient_headers_json")) {
    run("ALTER TABLE messages ADD COLUMN recipient_headers_json TEXT");
  }
  if (!all("PRAGMA table_info(accounts)").some((row) => row.name === "send_as_json")) {
    run("ALTER TABLE accounts ADD COLUMN send_as_json TEXT");
  }
  if (!all("PRAGMA table_info(accounts)").some((row) => row.name === "label")) {
    run("ALTER TABLE accounts ADD COLUMN label TEXT");
  }
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
  run(`CREATE TABLE IF NOT EXISTS mail_actions (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    intent_json TEXT NOT NULL,
    prior_json TEXT NOT NULL,
    prior_row_json TEXT,
    source_json TEXT NOT NULL,
    phase TEXT NOT NULL,
    receipt TEXT,
    error TEXT,
    undo_op_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  run(`CREATE INDEX IF NOT EXISTS mail_actions_message ON mail_actions(message_id, generation)`);
  run(`CREATE INDEX IF NOT EXISTS mail_actions_account ON mail_actions(account_id, phase, created_at)`);
  run(`CREATE TABLE IF NOT EXISTS signatures (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  run(`CREATE INDEX IF NOT EXISTS signatures_account ON signatures(account_id, created_at)`);
  run(`CREATE TABLE IF NOT EXISTS signature_domains (
    account_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    signature_id TEXT NOT NULL,
    PRIMARY KEY (account_id, domain)
  )`);
  run(`CREATE TABLE IF NOT EXISTS scheduled_sends (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at INTEGER NOT NULL
  )`);
  run(`CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_sends(status, send_at)`);
  run(`CREATE TABLE IF NOT EXISTS inbox_rules (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    match_json TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    since_uid INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
  )`);
  run(`CREATE INDEX IF NOT EXISTS inbox_rules_account ON inbox_rules(account_id, position)`);
  ensureSearchIndex();
}

async function open(target) {
  if (db) close();
  await closing;
  filePath = target;
  storage = new Persistence(target);
  try {
    db = await storage.open();
    transaction(migrate);
    if (!storage.initialized) storage.initialize(db);
  } catch (error) {
    close();
    throw error;
  }
}

function close() {
  if (storage) closing = storage.close();
  if (db) db.close();
  db = null;
  storage = null;
  observedSync.clear();
  return closing;
}

function hasAccounts() {
  if (!db) return false;
  return get("SELECT COUNT(*) AS n FROM accounts").n > 0;
}

function isReady() {
  return !!db;
}

function listAccountRows() {
  return all("SELECT * FROM accounts ORDER BY created_at ASC, id ASC");
}

function accountById(id) {
  if (!id) return null;
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
        smtp_host, smtp_port, smtp_tls, delimiter, auth_error, created_at, auth_kind, display_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        row.id, row.email, row.username, row.profile,
        row.imapHost, row.imapPort, row.imapTls ? 1 : 0,
        row.smtpHost, row.smtpPort, row.smtpTls ? 1 : 0,
        row.delimiter || "/", row.createdAt,
        row.authKind || "password",
        row.displayName || null,
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
        auth_kind = COALESCE(?, auth_kind),
        display_name = COALESCE(?, display_name)
      WHERE id = ?`,
      [
        row.username, row.profile, row.imapHost, row.imapPort, row.imapTls ? 1 : 0,
        row.smtpHost, row.smtpPort, row.smtpTls ? 1 : 0,
        row.authKind || null,
        row.displayName == null ? null : String(row.displayName),
        id,
      ]
    );
  });
}

function setAuthError(id, message) {
  transaction(() => updateChanged("accounts", { auth_error: message }, "id = ?", [id]));
}

function clearAuthError(id) {
  transaction(() => {
    if (id) run("UPDATE accounts SET auth_error = NULL WHERE id = ? AND auth_error IS NOT NULL", [id]);
    else run("UPDATE accounts SET auth_error = NULL WHERE auth_error IS NOT NULL");
  });
}

function removeAccount(id) {
  transaction(() => {
    forgetIds(all("SELECT id FROM messages WHERE account_id = ?", [id]));
    run("DELETE FROM messages WHERE account_id = ?", [id]);
    run("DELETE FROM folders WHERE account_id = ?", [id]);
    run("DELETE FROM snooze WHERE account_id = ?", [id]);
    run("DELETE FROM signature_domains WHERE account_id = ?", [id]);
    run("DELETE FROM signatures WHERE account_id = ?", [id]);
    run("DELETE FROM scheduled_sends WHERE account_id = ?", [id]);
    run("DELETE FROM inbox_rules WHERE account_id = ?", [id]);
    run("DELETE FROM accounts WHERE id = ?", [id]);
  });
}

function replaceFolders(accountId, folders, delimiter) {
  transaction(() => {
    if (delimiter) updateChanged("accounts", { delimiter }, "id = ?", [accountId]);
    const existing = new Set(all("SELECT path FROM folders WHERE account_id = ?", [accountId]).map((row) => row.path));
    const next = new Set(folders.map((folder) => folder.path));
    for (const folder of folders) {
      if (existing.has(folder.path)) {
        updateChanged("folders", { name: folder.name, well_known: folder.wellKnown },
          "account_id = ? AND path = ?", [accountId, folder.path]);
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
      forgetIds(all("SELECT id FROM messages WHERE account_id = ? AND folder_path = ?", [accountId, pathName]));
      run("DELETE FROM messages WHERE account_id = ? AND folder_path = ?", [accountId, pathName]);
      run("DELETE FROM folders WHERE account_id = ? AND path = ?", [accountId, pathName]);
    }
  });
}

function foldersFor(accountId) {
  return all("SELECT * FROM folders WHERE account_id = ? ORDER BY path ASC", [accountId]).map(withObservedSync);
}

function folderByPath(accountId, folderPath) {
  return withObservedSync(get("SELECT * FROM folders WHERE account_id = ? AND path = ?", [accountId, folderPath]));
}

function withObservedSync(row) {
  if (!row) return row;
  const seen = observedSync.get(JSON.stringify([row.account_id, row.path, row.uid_validity]));
  return seen ? { ...row, synced_at: Math.max(row.synced_at || 0, seen) } : row;
}

function folderByWellKnown(accountId, wellKnown) {
  return withObservedSync(get(
    "SELECT * FROM folders WHERE account_id = ? AND well_known = ? ORDER BY path ASC LIMIT 1",
    [accountId, wellKnown]
  ));
}

function primaryMailboxes() {
  if (!db) return [];
  return primaryFolderLib.primaryMailboxes(listAccountRows(), (account) => foldersFor(account.id));
}

function mailboxPairs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const box of list) {
    if (!box || typeof box !== "object") continue;
    const accountId = String(box.accountId || box.account_id || "");
    const path = box.path == null ? "" : String(box.path);
    if (!accountId || !path) continue;
    out.push({ accountId, path });
  }
  return out;
}

function applyPrimaryScope(next, boxes) {
  // This view is inbox-like: snoozed threads stay hidden here.
  // Opening that account's All Mail folder still lists them.
  next.excludeSnoozed = true;
  if (!boxes.length) {
    next.mailboxes = [];
    next.folderPaths = ["__missing__"];
    return next;
  }
  next.mailboxes = boxes;
  return next;
}

function pathsForKey(accountId, folderKey) {
  const well = {
    inbox: "inbox",
    drafts: "drafts",
    sent: "sentitems",
    trash: "deleteditems",
    archive: "archive",
    spam: "junkemail",
    all: "all",
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

function newInboxRuleId() {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function decodeInboxRule(row) {
  if (!row) return null;
  let match = {};
  let actions = {};
  try {
    match = JSON.parse(row.match_json || "{}");
    actions = JSON.parse(row.actions_json || "{}");
  } catch {
    return null;
  }
  if (!match || typeof match !== "object" || !actions || typeof actions !== "object") return null;
  const labels = Array.isArray(actions.addLabelIds) ? actions.addLabelIds.map((item) => String(item || "")).filter(Boolean) : [];
  return {
    id: row.id,
    name: row.name || "",
    enabled: row.enabled === 1,
    editable: true,
    unsupported: "",
    sequence: Number(row.position) || 0,
    sinceUid: Number(row.since_uid) || 0,
    position: Number(row.position) || 0,
    match: {
      from: String(match.from || ""),
      to: String(match.to || ""),
      subject: String(match.subject || ""),
      text: String(match.text || ""),
      hasAttachment: match.hasAttachment === true ? true : match.hasAttachment === false ? false : null,
    },
    actions: {
      markRead: actions.markRead === true,
      star: actions.star === true,
      archive: actions.archive === true,
      trash: actions.trash === true,
      moveToId: String(actions.moveToId || ""),
      addLabelIds: labels,
      stopProcessing: actions.stopProcessing !== false,
    },
  };
}

function listInboxRules(accountId) {
  return all(
    "SELECT * FROM inbox_rules WHERE account_id = ? ORDER BY position ASC, id ASC",
    [accountId]
  ).map(decodeInboxRule).filter(Boolean);
}

function inboxRuleById(accountId, id) {
  if (!accountId || !id) return null;
  return decodeInboxRule(get(
    "SELECT * FROM inbox_rules WHERE account_id = ? AND id = ?",
    [accountId, id]
  ));
}

function countInboxRules(accountId) {
  const row = get("SELECT COUNT(*) AS n FROM inbox_rules WHERE account_id = ?", [accountId]);
  return row ? Number(row.n) || 0 : 0;
}

function nextInboxRulePosition(accountId) {
  const row = get("SELECT COALESCE(MAX(position), 0) AS n FROM inbox_rules WHERE account_id = ?", [accountId]);
  return (row ? Number(row.n) || 0 : 0) + 1;
}

function saveInboxRule(accountId, rule) {
  const existing = get(
    "SELECT since_uid, position FROM inbox_rules WHERE account_id = ? AND id = ?",
    [accountId, rule.id]
  );
  const inbox = folderByWellKnown(accountId, "inbox");
  const sinceUid = existing ? Number(existing.since_uid) || 0 : (inbox ? Number(inbox.uid_cursor) || 0 : 0);
  const position = existing ? Number(existing.position) || 0 : nextInboxRulePosition(accountId);
  const now = new Date().toISOString();
  const matchJson = JSON.stringify(rule.match || {});
  const actionsJson = JSON.stringify(rule.actions || {});
  transaction(() => {
    if (existing) {
      run(
        `UPDATE inbox_rules
         SET name = ?, enabled = ?, match_json = ?, actions_json = ?, updated_at = ?
         WHERE account_id = ? AND id = ?`,
        [rule.name || "", rule.enabled ? 1 : 0, matchJson, actionsJson, now, accountId, rule.id]
      );
    } else {
      run(
        `INSERT INTO inbox_rules (
          account_id, id, name, enabled, match_json, actions_json, since_uid, position, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, rule.id, rule.name || "", rule.enabled ? 1 : 0, matchJson, actionsJson, sinceUid, position, now]
      );
    }
  });
  return inboxRuleById(accountId, rule.id);
}

function deleteInboxRule(accountId, id) {
  if (!inboxRuleById(accountId, id)) return false;
  transaction(() => run("DELETE FROM inbox_rules WHERE account_id = ? AND id = ?", [accountId, id]));
  return true;
}

function resetInboxRuleWatermarks(accountId) {
  transaction(() => run("UPDATE inbox_rules SET since_uid = 0 WHERE account_id = ?", [accountId]));
}

function horizonWrite(report) {
  if (!report || !Object.prototype.hasOwnProperty.call(report, "horizonDays")) {
    return { touch: 0, value: null };
  }
  if (report.horizonDays == null || report.horizonDays === "") return { touch: 1, value: null };
  const days = Number(report.horizonDays);
  if (!Number.isFinite(days)) return { touch: 1, value: null };
  return { touch: 1, value: days };
}

// Local full-text index for synced mail. sql.js in this app has no FTS5 module,
// so subject, from, and body are tokenized into message_fts. The list filter
// stays a separate in-memory match and does not read this index.
const SEARCH_INDEX_VERSION = "1";
const SEARCH_BODY_CAP = 200000;
const SEARCH_TERM_CAP = 4000;
const SEARCH_QUERY_CAP = 16;
const SEARCH_RESULT_CAP = 100;
const INDEXED_PATCH = new Set(["subject", "from_addr", "text_body", "html_body", "snippet"]);

function safePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return " ";
  return String.fromCodePoint(code);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(\d+);/g, (_match, n) => safePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, n) => safePoint(parseInt(n, 16)));
}

function squash(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, SEARCH_BODY_CAP);
}

function plainBody(row) {
  const text = squash(row.text_body);
  if (text) return text;
  const html = squash(htmlToText(row.html_body));
  if (html) return html;
  return squash(row.snippet);
}

function foldTerm(value) {
  return String(value || "").normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
}

function tokenize(value) {
  const found = foldTerm(value).match(/[\p{L}\p{N}]+/gu) || [];
  const terms = [];
  const seen = new Set();
  for (const term of found) {
    if (!term || term.length > 80) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= SEARCH_TERM_CAP) break;
  }
  return terms;
}

function termUpper(term) {
  const chars = Array.from(term);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const code = chars[i].codePointAt(0);
    if (code < 0x10FFFD) {
      chars[i] = String.fromCodePoint(code + 1);
      return chars.slice(0, i + 1).join("");
    }
  }
  return `${term}\u{10FFFD}`;
}

function forgetIndex(messageId) {
  if (!messageId) return;
  run("DELETE FROM message_fts WHERE message_id = ?", [messageId]);
  run("DELETE FROM message_fts_doc WHERE message_id = ?", [messageId]);
}

function forgetIds(rows) {
  for (const row of rows) forgetIndex(row.id);
}

function indexText(messageId) {
  forgetIndex(messageId);
  const row = get(
    "SELECT id, subject, from_addr, text_body, html_body, snippet FROM messages WHERE id = ?",
    [messageId]
  );
  if (!row) return;
  const subject = row.subject || "";
  const sender = row.from_addr || "";
  const body = plainBody(row);
  run(
    "INSERT INTO message_fts_doc (message_id, subject, sender, body) VALUES (?, ?, ?, ?)",
    [messageId, subject, sender, body]
  );
  const sql = "INSERT INTO message_fts (term, message_id, field) VALUES (?, ?, ?)";
  const stmt = db.prepare(sql);
  try {
    const fields = [
      ["subject", subject],
      ["sender", sender],
      ["body", body],
    ];
    for (const [field, text] of fields) {
      for (const term of tokenize(text)) {
        const params = [term, messageId, field];
        stmt.run(params);
        recordWrite(sql, params);
      }
    }
  } finally {
    stmt.free();
  }
}

function ensureSearchIndex() {
  run(`CREATE TABLE IF NOT EXISTS message_fts_meta (
    meta_key TEXT PRIMARY KEY,
    meta_value TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS message_fts_doc (
    message_id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS message_fts (
    term TEXT NOT NULL,
    message_id TEXT NOT NULL,
    field TEXT NOT NULL,
    PRIMARY KEY (term, message_id, field)
  )`);
  run("CREATE INDEX IF NOT EXISTS message_fts_message ON message_fts(message_id)");
  const version = get("SELECT meta_value AS value FROM message_fts_meta WHERE meta_key = 'version'");
  const messages = get("SELECT COUNT(*) AS n FROM messages").n;
  const docs = get("SELECT COUNT(*) AS n FROM message_fts_doc").n;
  if (version && version.value === SEARCH_INDEX_VERSION && messages === docs) return;
  transaction(() => {
    run("DELETE FROM message_fts");
    run("DELETE FROM message_fts_doc");
    for (const row of all("SELECT id FROM messages")) indexText(row.id);
    run("DELETE FROM message_fts_meta WHERE meta_key = 'version'");
    run("INSERT INTO message_fts_meta (meta_key, meta_value) VALUES ('version', ?)", [SEARCH_INDEX_VERSION]);
  });
}

function searchResultLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SEARCH_RESULT_CAP;
  return Math.min(Math.max(Math.trunc(n), 1), SEARCH_RESULT_CAP);
}

function inspectSearchTokens(value) {
  const found = foldTerm(value).match(/[\p{L}\p{N}]+/gu) || [];
  let overlong = 0;
  const tokens = [];
  const seen = new Set();
  for (const term of found) {
    if (!term) continue;
    if (term.length > 80) {
      overlong += 1;
      continue;
    }
    if (seen.has(term)) continue;
    seen.add(term);
    tokens.push(term);
  }
  return { tokens, overlong };
}

function searchMessages(options) {
  if (!db) return [];
  const query = options || {};
  if (query.accountRequired && !query.accountId) return [];
  let tokens;
  if (Array.isArray(query.tokens)) {
    tokens = [];
    for (const term of query.tokens) {
      if (typeof term !== "string" || !term || term.length > 80) continue;
      tokens.push(term);
      if (tokens.length >= SEARCH_QUERY_CAP) break;
    }
  } else {
    tokens = tokenize(query.query).slice(0, SEARCH_QUERY_CAP);
  }
  if (!tokens.length) return [];
  const joins = [];
  const params = [];
  tokens.forEach((token, index) => {
    joins.push(
      `JOIN (
        SELECT message_id, MAX(CASE field WHEN 'subject' THEN 6 WHEN 'sender' THEN 4 ELSE 1 END) AS weight
        FROM message_fts
        WHERE term >= ? AND term < ?
        GROUP BY message_id
      ) t${index} ON t${index}.message_id = m.id`
    );
    params.push(token, termUpper(token));
  });
  const rank = tokens.map((_token, index) => `t${index}.weight`).join(" + ");
  let where = "";
  if (query.accountId) {
    where = " WHERE m.account_id = ?";
    params.push(query.accountId);
  }
  params.push(searchResultLimit(query.limit));
  return all(
    `SELECT m.* FROM messages m
     ${joins.join("\n")}
     ${where}
     ORDER BY (${rank}) DESC, m.list_sort_ts DESC, m.id DESC
     LIMIT ?`,
    params
  );
}

function localOutgoingAttachments(json) {
  let stored;
  try { stored = JSON.parse(json || "[]"); } catch { return null; }
  if (!Array.isArray(stored)) return null;
  const local = stored.filter((item) => item && typeof item.storageUrl === "string" && item.storageUrl.startsWith("local:"));
  return local.length ? local : null;
}

function applyFolderSync(accountId, folderPath, report) {
  const result = transaction(() => {
    const before = changeStamp();
    const previous = get(
      "SELECT uid_validity FROM folders WHERE account_id = ? AND path = ?",
      [accountId, folderPath]
    );
    if (previous && previous.uid_validity && report.validity && previous.uid_validity !== report.validity) {
      forgetIds(all("SELECT id FROM messages WHERE account_id = ? AND folder_path = ?", [accountId, folderPath]));
      run("DELETE FROM messages WHERE account_id = ? AND folder_path = ?", [accountId, folderPath]);
      run(
        "UPDATE folders SET uid_cursor = 0, window_done = 0, sync_horizon_days = NULL WHERE account_id = ? AND path = ?",
        [accountId, folderPath]
      );
    }
    if (Array.isArray(report.uids) && !report.keepOthers) {
      const keep = new Set(report.uids.map((uid) => Number(uid)));
      const stored = all(
        "SELECT id, uid, list_sort_ts FROM messages WHERE account_id = ? AND folder_path = ?",
        [accountId, folderPath]
      );
      for (const row of stored) {
        // uid <= 0 is a local-only copy (a send or draft not yet given a server uid).
        if (Number(row.uid) <= 0 || keep.has(Number(row.uid))) continue;
        if (report.retainOlderThan && Number(row.list_sort_ts) < report.retainOlderThan) continue;
        if (messageHeld(row.id)) continue;
        forgetIndex(row.id);
        run("DELETE FROM messages WHERE id = ?", [row.id]);
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
      let unreadBit = message.unread ? 1 : 0;
      let starredBit = message.starred ? 1 : 0;
      if (found && messageHeld(found.id)) {
        const existing = get("SELECT unread, starred FROM messages WHERE id = ?", [found.id]);
        if (existing) {
          unreadBit = existing.unread;
          starredBit = existing.starred;
        }
      }
      let attachmentRows = Array.isArray(message.attachments) ? message.attachments : [];
      let attachmentBit = message.hasAttachments ? 1 : 0;
      if (found) {
        const prior = get("SELECT is_draft, attachments_json FROM messages WHERE id = ?", [found.id]);
        const kept = prior && Number(prior.is_draft) === 1 ? localOutgoingAttachments(prior.attachments_json) : null;
        if (kept) {
          attachmentRows = kept;
          attachmentBit = 1;
        }
      }
      const fields = [
        message.threadId || null, message.rfcMessageId || null, message.inReplyTo || null,
        message.subject || "", message.snippet || "",
        message.from || "", JSON.stringify(message.to || []), JSON.stringify(message.cc || []),
        JSON.stringify(message.bcc || []), message.date || null, Number(message.listSortTs) || 0,
        unreadBit, starredBit, message.isDraft ? 1 : 0,
        attachmentBit, message.htmlBody || null, message.textBody || null,
        JSON.stringify(attachmentRows), message.bodyComplete ? 1 : 0,
        JSON.stringify(message.recipientHeaders || {}),
      ];
      if (found) {
        run(
          `UPDATE messages SET
            uid = ?, uid_validity = ?,
            thread_id = ?, rfc_message_id = ?, in_reply_to = ?, subject = ?, snippet = ?,
            from_addr = ?, to_json = ?, cc_json = ?, bcc_json = ?, date_iso = ?, list_sort_ts = ?,
            unread = ?, starred = ?, is_draft = ?, has_attachments = ?, html_body = ?, text_body = ?,
            attachments_json = ?, body_complete = ?, recipient_headers_json = ?
          WHERE id = ?`,
          [message.uid, report.validity, ...fields, id]
        );
      } else {
        run(
          `INSERT INTO messages (
            id, account_id, folder_path, uid, uid_validity, thread_id, rfc_message_id, in_reply_to,
            subject, snippet, from_addr, to_json, cc_json, bcc_json, date_iso, list_sort_ts,
            unread, starred, is_draft, has_attachments, html_body, text_body, attachments_json, body_complete, recipient_headers_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, accountId, folderPath, message.uid, report.validity,
            ...fields,
          ]
        );
      }
      indexText(id);
    }
    const cursor = report.uidCursor == null ? null : Number(report.uidCursor);
    const done = report.windowDone === true ? 1 : (report.windowDone === false ? 0 : null);
    const horizon = horizonWrite(report);
    if (report.keepOthers) {
      if (cursor != null || done != null || report.validity || horizon.touch) {
        const patch = {};
        if (report.validity) patch.uid_validity = report.validity;
        if (Number.isFinite(cursor)) patch.uid_cursor = cursor;
        if (done != null) patch.window_done = done;
        if (horizon.touch) patch.sync_horizon_days = horizon.value;
        updateChanged("folders", patch, "account_id = ? AND path = ?", [accountId, folderPath]);
      }
      return;
    }
    const cachedUnread = get(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder_path = ? AND unread = 1",
      [accountId, folderPath]
    ).n;
    const unread = typeof report.unseen === "number" ? report.unseen : cachedUnread;
    const total = typeof report.exists === "number" ? report.exists : get(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder_path = ?",
      [accountId, folderPath]
    ).n;
    const patch = { uid_validity: report.validity || null, unread, total };
    if (Number.isFinite(cursor)) patch.uid_cursor = cursor;
    if (done != null) patch.window_done = done;
    if (horizon.touch) patch.sync_horizon_days = horizon.value;
    const folder = folderByPath(accountId, folderPath);
    if (folder && (changeStamp() !== before || !folder.synced_at
        || Object.entries(patch).some(([key, value]) => folder[key] !== value))) {
      patch.synced_at = Date.now();
      updateChanged("folders", patch, "account_id = ? AND path = ?", [accountId, folderPath]);
    }
  });
  // Observation-only freshness is session state, like engine syncScopes. It must
  // not make an otherwise unchanged mailbox dirty on every background poll.
  if (!report.keepOthers) observedSync.set(JSON.stringify([accountId, folderPath, report.validity || null]), Date.now());
  return result;
}

function uidsFor(accountId, folderPath) {
  return all(
    "SELECT uid FROM messages WHERE account_id = ? AND folder_path = ? AND uid > 0",
    [accountId, folderPath]
  ).map((row) => Number(row.uid));
}

function messageByUid(accountId, folderPath, uid, validity) {
  return get(
    "SELECT * FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ? AND uid_validity = ?",
    [accountId, folderPath, uid, validity]
  );
}

function messageByRfc(accountId, rfcMessageId) {
  if (!rfcMessageId) return null;
  return get(
    "SELECT * FROM messages WHERE account_id = ? AND rfc_message_id = ? ORDER BY uid DESC LIMIT 1",
    [accountId, rfcMessageId]
  );
}

function pruneMissing(accountId, folderPath, liveUids, retainOlderThan) {
  const keep = new Set((liveUids || []).map((uid) => Number(uid)));
  transaction(() => {
    const stored = all(
      "SELECT id, uid, list_sort_ts FROM messages WHERE account_id = ? AND folder_path = ?",
      [accountId, folderPath]
    );
    for (const row of stored) {
      if (Number(row.uid) <= 0 || keep.has(Number(row.uid))) continue;
      if (retainOlderThan && Number(row.list_sort_ts) < retainOlderThan) continue;
      if (messageHeld(row.id)) continue;
      forgetIndex(row.id);
      run("DELETE FROM messages WHERE id = ?", [row.id]);
    }
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
  transaction(() => insertMessageRecord(row));
}

function insertMessageRecord(row) {
    run(
      `INSERT INTO messages (
        id, account_id, folder_path, uid, uid_validity, thread_id, rfc_message_id, in_reply_to,
        subject, snippet, from_addr, to_json, cc_json, bcc_json, date_iso, list_sort_ts,
        unread, starred, is_draft, has_attachments, html_body, text_body, attachments_json, body_complete, recipient_headers_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.accountId, row.folderPath, row.uid || 0, row.uidValidity || 0,
        row.threadId || row.id, row.rfcMessageId || null, row.inReplyTo || null,
        row.subject || "", row.snippet || "", row.from || "",
        JSON.stringify(row.to || []), JSON.stringify(row.cc || []), JSON.stringify(row.bcc || []),
        row.date, row.listSortTs, row.unread ? 1 : 0, row.starred ? 1 : 0, row.isDraft ? 1 : 0,
        row.hasAttachments ? 1 : 0, row.htmlBody || null, row.textBody || null,
        JSON.stringify(row.attachments || []), row.bodyComplete ? 1 : 0,
        JSON.stringify(row.recipientHeaders || {}),
      ]
    );
    indexText(row.id);
}

function messageById(id) {
  if (!id) return null;
  return get("SELECT * FROM messages WHERE id = ?", [id]);
}

function saveSendAs(accountId, value) {
  transaction(() => run("UPDATE accounts SET send_as_json = ? WHERE id = ?", [JSON.stringify(value), accountId]));
}

function saveAccountLabel(accountId, label) {
  transaction(() => run("UPDATE accounts SET label = ? WHERE id = ?", [label, accountId]));
}

function selectBotHeaders(accountId, folderPaths, limit) {
  if (!db || !accountId || !Array.isArray(folderPaths) || !folderPaths.length) return [];
  const n = Math.min(Math.max(Number(limit) || 1, 1), 51);
  const marks = folderPaths.map(() => "?").join(", ");
  return all(
    `SELECT m.*, CASE WHEN EXISTS (
       SELECT 1 FROM snooze s
       WHERE s.account_id = m.account_id AND s.thread_id = m.thread_id AND s.until_iso > ?
     ) THEN 1 ELSE 0 END AS snoozed
     FROM messages m
     WHERE m.account_id = ? AND m.folder_path IN (${marks})
     ORDER BY m.list_sort_ts DESC, m.id DESC
     LIMIT ?`,
    [new Date().toISOString(), accountId, ...folderPaths, n]
  );
}

function messageStats(accountId) {
  if (!db) return { messages: 0, bodiesComplete: 0 };
  const row = accountId
    ? get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN body_complete = 1 THEN 1 ELSE 0 END), 0) AS bodies FROM messages WHERE account_id = ?",
      [accountId],
    )
    : get("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN body_complete = 1 THEN 1 ELSE 0 END), 0) AS bodies FROM messages");
  return { messages: row ? row.n : 0, bodiesComplete: row ? row.bodies : 0 };
}

function messagesByThread(accountId, threadId) {
  return all(
    "SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY list_sort_ts ASC",
    [accountId, threadId]
  );
}

function updateMessage(id, patch) {
  if (!Object.keys(patch).length) return;
  const reindex = Object.keys(patch).some((key) => INDEXED_PATCH.has(key));
  transaction(() => {
    if (updateChanged("messages", patch, "id = ?", [id]) && reindex) indexText(id);
  });
}

function deleteMessage(id) {
  transaction(() => {
    forgetIndex(id);
    run("DELETE FROM messages WHERE id = ?", [id]);
  });
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
  if (query.mailboxes && query.mailboxes.length) {
    // Shared path strings are different folders once two mailboxes are open.
    clauses.push(`(${query.mailboxes.map(() => "(m.account_id = ? AND m.folder_path = ?)").join(" OR ")})`);
    for (const box of query.mailboxes) params.push(box.accountId, box.path);
  } else if (query.folderPaths && query.folderPaths.length) {
    clauses.push(`m.folder_path IN (${query.folderPaths.map(() => "?").join(", ")})`);
    params.push(...query.folderPaths);
  } else if (query.folderPath) {
    clauses.push("m.folder_path = ?");
    params.push(query.folderPath);
  }
  if (Array.isArray(query.excludeFolderPaths) && query.excludeFolderPaths.length) {
    clauses.push(`m.folder_path NOT IN (${query.excludeFolderPaths.map(() => "?").join(", ")})`);
    params.push(...query.excludeFolderPaths);
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
  if (query.needsBody) {
    clauses.push("m.uid > 0");
    clauses.push("m.body_complete != 1");
    clauses.push("m.is_draft = 0");
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM folders f
      WHERE f.account_id = m.account_id AND f.path = m.folder_path
        AND f.well_known IN ('deleteditems', 'junkemail')
    )`);
  }
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
  const explicit = mailboxPairs(query.mailboxes);
  if (query.folderKey === "primary") {
    const boxes = explicit.length
      ? explicit
      : primaryMailboxes().map((row) => ({ accountId: row.accountId, path: row.path }));
    return applyPrimaryScope(next, boxes);
  }
  if (!query.folderKey && !query.folderId && explicit.length) return applyPrimaryScope(next, explicit);
  if (query.folderKey) {
    const paths = pathsForKey(query.accountId, query.folderKey);
    next.excludeSnoozed = query.folderKey === "inbox";
    if (query.accountId) {
      next.folderPaths = paths.filter((row) => row.account_id === query.accountId).map((row) => row.path);
      if (!next.folderPaths.length) next.folderPaths = ["__missing__"];
    } else if (!paths.length) {
      next.folderPaths = ["__missing__"];
    } else {
      next.mailboxes = paths.map((row) => ({ accountId: row.account_id, path: row.path }));
    }
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
  const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || 2000, 1), 2000);
  const offset = Number.isFinite(Number(query.offset)) ? Math.max(Math.floor(Number(query.offset)), 0) : 0;
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

function insertMailAction(row) {
  transaction(() => run(
    `INSERT INTO mail_actions (
      id, batch_id, message_id, account_id, generation, intent_json, prior_json, prior_row_json,
      source_json, phase, receipt, error, undo_op_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.batchId, row.messageId, row.accountId, row.generation, row.intentJson, row.priorJson,
      row.priorRowJson || null, row.sourceJson, row.phase, row.receipt || null, row.error || null,
      row.undoOpId || null, row.createdAt,
    ]
  ));
}

function updateMailAction(id, patch) {
  transaction(() => updateChanged("mail_actions", patch, "id = ?", [id]));
}

function mailActionById(id) {
  return get("SELECT * FROM mail_actions WHERE id = ?", [id]);
}

function mailActionsForMessage(messageId) {
  return all("SELECT * FROM mail_actions WHERE message_id = ? ORDER BY generation DESC", [messageId]);
}

function openMailAction(messageId) {
  return get(
    "SELECT * FROM mail_actions WHERE message_id = ? AND phase IN ('accepted', 'publishing') ORDER BY generation DESC LIMIT 1",
    [messageId]
  );
}

function acceptedMailActions(accountId) {
  return all(
    "SELECT * FROM mail_actions WHERE account_id = ? AND phase = 'accepted' ORDER BY created_at ASC, id ASC",
    [accountId]
  );
}

function publishingMailActions() {
  return all("SELECT * FROM mail_actions WHERE phase = 'publishing' ORDER BY created_at ASC");
}

function acceptedAccountIds() {
  return all("SELECT DISTINCT account_id FROM mail_actions WHERE phase = 'accepted'").map((row) => row.account_id);
}

function maxActionGeneration(messageId) {
  const row = get("SELECT MAX(generation) AS n FROM mail_actions WHERE message_id = ?", [messageId]);
  return row && row.n ? Number(row.n) : 0;
}

function messageHeld(id) {
  const rows = mailActionsForMessage(id);
  return rows.some((row) => {
    let intent = {};
    try { intent = JSON.parse(row.intent_json); } catch { intent = {}; }
    if (!intent || intent.kind !== "remove") return false;
    if (row.phase === "accepted" || row.phase === "publishing") return true;
    return row.phase === "closed" && row.receipt === "unknown";
  });
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

function recentInWellKnown(wellKnown, limit) {
  if (!db) return [];
  const key = String(wellKnown || "").trim();
  if (!key) return [];
  const n = Math.min(Math.max(Number(limit) || 20, 1), 40);
  const columns = `m.id, m.account_id, m.subject, m.snippet, m.from_addr, m.date_iso,
            m.unread, m.starred, m.has_attachments, m.thread_id, m.folder_path`;
  return all(
    `SELECT ${columns}
     FROM messages m
     JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder_path
     WHERE f.well_known = ?
     ORDER BY m.list_sort_ts DESC
     LIMIT ?`,
    [key, n]
  ).map(inboxRow);
}

function listSignatures(accountId) {
  if (!db) return [];
  if (accountId) {
    return all(
      "SELECT * FROM signatures WHERE account_id = ? ORDER BY created_at ASC, id ASC",
      [accountId]
    );
  }
  return all("SELECT * FROM signatures ORDER BY created_at ASC, id ASC");
}

function signatureById(id) {
  if (!db || !id) return null;
  return get("SELECT * FROM signatures WHERE id = ?", [id]);
}

function signatureDefaults() {
  if (!db) return [];
  return all("SELECT id, account_id FROM signatures WHERE is_default = 1 ORDER BY account_id ASC");
}

function listSignatureDomains() {
  if (!db) return [];
  return all("SELECT account_id, domain, signature_id FROM signature_domains ORDER BY account_id ASC, domain ASC");
}

function replaceSignatureDomains(accountId, signatureId, domains) {
  run("DELETE FROM signature_domains WHERE signature_id = ?", [signatureId]);
  for (const domain of domains) {
    const existing = get("SELECT signature_id FROM signature_domains WHERE account_id = ? AND domain = ?", [accountId, domain]);
    if (existing && existing.signature_id !== signatureId) {
      const other = get("SELECT name FROM signatures WHERE id = ?", [existing.signature_id]);
      const name = other && other.name ? other.name : "another signature";
      throw new Error(domain + " is already bound to " + name + ".");
    }
    run("INSERT INTO signature_domains (account_id, domain, signature_id) VALUES (?, ?, ?)", [accountId, domain, signatureId]);
  }
}

function saveSignature(row) {
  const now = Date.now();
  transaction(() => {
    const existing = get("SELECT id FROM signatures WHERE id = ?", [row.id]);
    if (existing) {
      run(
        "UPDATE signatures SET name = ?, body_text = ?, body_html = ?, updated_at = ? WHERE id = ?",
        [row.name, row.bodyText, row.bodyHtml, now, row.id]
      );
    } else {
      run(
        `INSERT INTO signatures (
          id, account_id, name, body_text, body_html, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [row.id, row.accountId, row.name, row.bodyText, row.bodyHtml, now, now]
      );
    }
    if (row.isDefault === true) {
      run("UPDATE signatures SET is_default = 0 WHERE account_id = ?", [row.accountId]);
      run("UPDATE signatures SET is_default = 1 WHERE id = ?", [row.id]);
    } else if (row.isDefault === false) {
      run("UPDATE signatures SET is_default = 0 WHERE id = ? AND account_id = ?", [row.id, row.accountId]);
    }
    if (Array.isArray(row.domains)) replaceSignatureDomains(row.accountId, row.id, row.domains);
  });
  return signatureById(row.id);
}

function deleteSignature(id) {
  if (!signatureById(id)) return false;
  transaction(() => {
    run("DELETE FROM signature_domains WHERE signature_id = ?", [id]);
    run("DELETE FROM signatures WHERE id = ?", [id]);
  });
  return true;
}

function insertScheduled(row) {
  const status = row.status === "failed" ? "failed" : "pending";
  const error = status === "failed" ? String(row.error || "Send failed.") : null;
  transaction(() => {
    run(
      `INSERT INTO scheduled_sends (id, account_id, payload_json, send_at, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.accountId, row.payloadJson, row.sendAt, status, error, row.createdAt]
    );
  });
  return get("SELECT * FROM scheduled_sends WHERE id = ?", [row.id]);
}

function listScheduled(accountId) {
  if (!db) return [];
  if (accountId) {
    return all(
      `SELECT * FROM scheduled_sends
       WHERE account_id = ? AND status IN ('pending', 'failed')
       ORDER BY send_at ASC, created_at ASC`,
      [accountId]
    );
  }
  return all(
    `SELECT * FROM scheduled_sends
     WHERE status IN ('pending', 'failed')
     ORDER BY send_at ASC, created_at ASC`
  );
}

function dueScheduled(now) {
  if (!db) return [];
  return all(
    `SELECT * FROM scheduled_sends
     WHERE status = 'pending' AND send_at <= ?
     ORDER BY send_at ASC, created_at ASC`,
    [now]
  );
}

function scheduledById(id) {
  return get("SELECT * FROM scheduled_sends WHERE id = ?", [id]);
}

function scheduledToDraft(id, record) {
  return transaction(() => {
    const queued = scheduledById(id);
    if (!queued || queued.account_id !== record.accountId) throw new Error("That scheduled send is gone.");
    insertMessageRecord(record);
    run("DELETE FROM scheduled_sends WHERE id = ?", [id]);
    return record.id;
  });
}

function deleteScheduled(id) {
  if (!db || !id || !get("SELECT id FROM scheduled_sends WHERE id = ?", [id])) return false;
  transaction(() => run("DELETE FROM scheduled_sends WHERE id = ?", [id]));
  return true;
}

function markScheduledFailed(id, message) {
  transaction(() => {
    run("UPDATE scheduled_sends SET status = 'failed', error = ? WHERE id = ?", [String(message || "Send failed."), id]);
  });
}

function setScheduledSendAt(id, sendAt) {
  transaction(() => run("UPDATE scheduled_sends SET send_at = ?, status = 'pending', error = NULL WHERE id = ?", [sendAt, id]));
}

function planImapPathMove(folders, sourcePath, destinationParent, delimiter) {
  const sep = delimiter || "/";
  const rows = (Array.isArray(folders) ? folders : []).filter((row) => row && row.path);
  const source = String(sourcePath || "");
  const row = rows.find((item) => item.path === source);
  if (!row) return { ok: false, code: "not-found", message: "That folder is not in this mailbox." };
  const well = row.wellKnown || row.well_known || "";
  if (well || source.toUpperCase() === "INBOX") {
    return { ok: false, code: "invalid", message: "This folder cannot be moved." };
  }
  const parent = destinationParent ? String(destinationParent) : "";
  if (parent === source || (parent && (parent.startsWith(`${source}${sep}`)))) {
    return { ok: false, code: "invalid", message: "A folder cannot move into itself or one of its own sub-folders." };
  }
  const known = new Set(rows.map((item) => item.path));
  let current = "";
  let cursor = source;
  let cut = cursor.lastIndexOf(sep);
  while (cut > 0) {
    const maybe = cursor.slice(0, cut);
    if (known.has(maybe)) {
      current = maybe;
      break;
    }
    cursor = maybe;
    cut = cursor.lastIndexOf(sep);
  }
  if (parent === current) return { ok: false, code: "invalid", message: "This folder is already there." };
  const leafCut = source.lastIndexOf(sep);
  const leaf = leafCut >= 0 ? source.slice(leafCut + 1) : source;
  if (!leaf) return { ok: false, code: "invalid", message: "That folder name cannot be moved." };
  const next = parent ? `${parent}${sep}${leaf}` : leaf;
  const moving = rows.filter((item) => item.path === source || item.path.startsWith(`${source}${sep}`));
  const movingPaths = new Set(moving.map((item) => item.path));
  const renames = moving.map((item) => {
    const suffix = item.path.slice(source.length);
    const to = next + suffix;
    const nameCut = to.lastIndexOf(sep);
    return { from: item.path, to, name: nameCut >= 0 ? to.slice(nameCut + 1) : to };
  });
  const used = new Set();
  for (const step of renames) {
    const clash = rows.find((item) => item.path === step.to && !movingPaths.has(item.path));
    if (clash || used.has(step.to)) {
      return {
        ok: false,
        code: "collision",
        message: `“${step.to}” already exists, so this move was not started.`,
      };
    }
    used.add(step.to);
  }
  return { ok: true, source, next, renames, delimiter: sep };
}

function confirmedImapRenames(plan, serverFolders) {
  const server = new Set((serverFolders || []).map((folder) => folder && folder.path).filter(Boolean));
  return ((plan && plan.renames) || []).filter((step) => step && step.from !== step.to && server.has(step.to) && !server.has(step.from));
}

function rewriteFolderPaths(accountId, moves) {
  const ordered = (Array.isArray(moves) ? moves : [])
    .filter((move) => move && move.from && move.to && move.from !== move.to)
    .sort((a, b) => b.from.length - a.from.length || String(b.from).localeCompare(String(a.from)));
  return transaction(() => {
    const moved = [];
    const skipped = [];
    for (const move of ordered) {
      const source = get("SELECT * FROM folders WHERE account_id = ? AND path = ?", [accountId, move.from]);
      if (!source) {
        skipped.push({ from: move.from, to: move.to, reason: "missing" });
        continue;
      }
      const dest = get("SELECT path FROM folders WHERE account_id = ? AND path = ?", [accountId, move.to]);
      if (dest) {
        skipped.push({ from: move.from, to: move.to, reason: "collision" });
        continue;
      }
      run(
        "UPDATE folders SET path = ?, name = ? WHERE account_id = ? AND path = ?",
        [move.to, move.name || source.name, accountId, move.from]
      );
      run(
        "UPDATE messages SET folder_path = ? WHERE account_id = ? AND folder_path = ?",
        [move.to, accountId, move.from]
      );
      moved.push({ from: move.from, to: move.to });
    }
    return { moved, skipped };
  });
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
  checkpoint: () => storage ? storage.checkpoint() : Promise.resolve(),
  hasAccounts,
  isReady,
  listAccountRows,
  accountById,
  accountByEmail,
  insertAccount,
  updateAccountLogin,
  saveSendAs,
  saveAccountLabel,
  setAuthError,
  clearAuthError,
  removeAccount,
  replaceFolders,
  planImapPathMove,
  confirmedImapRenames,
  rewriteFolderPaths,
  foldersFor,
  folderByPath,
  folderByWellKnown,
  pathsForKey,
  primaryMailboxes,
  applyFolderSync,
  uidsFor,
  messageByUid,
  messageByRfc,
  pruneMissing,
  insertMessage,
  searchMessages,
  inspectSearchTokens,
  selectBotHeaders,
  messageStats,
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
  transaction,
  insertMailAction,
  updateMailAction,
  mailActionById,
  mailActionsForMessage,
  openMailAction,
  acceptedMailActions,
  publishingMailActions,
  acceptedAccountIds,
  maxActionGeneration,
  messageHeld,
  recentForAi,
  recentInWellKnown,
  recentInbox,
  listSignatures,
  signatureById,
  signatureDefaults,
  listSignatureDomains,
  saveSignature,
  deleteSignature,
  scheduledById,
  scheduledToDraft,
  insertScheduled,
  listScheduled,
  dueScheduled,
  deleteScheduled,
  markScheduledFailed,
  setScheduledSendAt,
  jsonList,
  newMessageId,
  newInboxRuleId,
  listInboxRules,
  inboxRuleById,
  countInboxRules,
  saveInboxRule,
  deleteInboxRule,
  resetInboxRuleWatermarks,
  WELL_TO_KEY,
  file: () => filePath,
};
