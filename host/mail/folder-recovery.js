"use strict";

// Durable intent/receipt metadata only. Never stores credentials or message bytes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const PHASES = new Set(["pending", "paused", "running", "recoverable", "uncertain", "cancelled", "deleted", "restored", "created"]);
const ACTIVE = new Set(["pending", "paused", "running", "recoverable", "uncertain"]);
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const problem = () => Object.assign(new Error("Folder recovery storage could not be verified. No new folder write is allowed; keep its files for recovery."), { code: "folder_recovery", operationIssued: false });

function createJournal(file, { database = Database } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const exists = fs.existsSync(file);
  if (exists) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw problem();
  }
  const sql = new database(file);
  try {
    fs.chmodSync(file, 0o600);
    sql.pragma("journal_mode = DELETE");
    sql.pragma("synchronous = EXTRA");
    sql.pragma("fullfsync = ON");
    const version = sql.pragma("user_version", { simple: true });
    if (exists && version !== 1 || version > 1) throw problem();
    if (exists && sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='folder_operations'").get().n !== 1) throw problem();
    if (sql.pragma("quick_check", { simple: true }) !== "ok") throw problem();
    sql.transaction(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS folder_operations (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
        phase TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS folder_operation_owner ON folder_operations(account_id,source_id)
        WHERE phase IN ('pending','paused','running','recoverable','uncertain');
      PRAGMA user_version = 1;`);
    })();
  } catch (error) { sql.close(); throw error.code === "folder_recovery" ? error : problem(); }

  function decode(row) {
    if (!row || typeof row.body !== "string" || row.body.length > 65536 || digest(row.body) !== row.sha) throw problem();
    let value; try { value = JSON.parse(row.body); } catch { throw problem(); }
    if (!value || value.id !== row.id || value.accountId !== row.account_id || value.sourceId !== row.source_id || value.phase !== row.phase
        || value.updatedAt !== row.updated_at || !PHASES.has(value.phase) || !/^[a-f0-9]{64}$/.test(value.owner || "")) throw problem();
    return value;
  }
  function read(id) {
    const row = sql.prepare("SELECT * FROM folder_operations WHERE id=?").get(id);
    return row ? decode(row) : null;
  }
  function list(accountId) {
    const rows = accountId == null ? sql.prepare("SELECT * FROM folder_operations ORDER BY updated_at DESC").all()
      : sql.prepare("SELECT * FROM folder_operations WHERE account_id=? ORDER BY updated_at DESC").all(accountId);
    if (rows.length > 1200) throw problem();
    return rows.map(decode);
  }
  function encode(value) {
    const body = JSON.stringify(value);
    if (!PHASES.has(value.phase) || body.length > 65536 || !value.id || !value.accountId || !value.sourceId) throw problem();
    return { body, sha: digest(body) };
  }
  function insert(value) {
    return sql.transaction(() => {
      const rows = list();
      if (rows.filter(row => ACTIVE.has(row.phase)).length >= 100) throw Object.assign(new Error("Review existing folder recovery actions before starting another."), { code: "folder_recovery", operationIssued: false });
      for (const old of rows.filter(row => !ACTIVE.has(row.phase)).slice(100)) sql.prepare("DELETE FROM folder_operations WHERE id=?").run(old.id);
      const data = encode(value);
      sql.prepare("INSERT INTO folder_operations VALUES(?,?,?,?,?,?,?)").run(value.id, value.accountId, value.sourceId, value.phase, value.updatedAt, data.body, data.sha);
      return read(value.id);
    })();
  }
  function update(id, expected, patch) {
    return sql.transaction(() => {
      const value = read(id);
      if (!value || !(Array.isArray(expected) ? expected : [expected]).includes(value.phase)) {
        throw Object.assign(new Error("This folder action changed. Refresh its recovery status."), { code: "conflict", operationIssued: false });
      }
      const next = { ...value, ...patch, id: value.id, accountId: value.accountId, owner: value.owner, sourceId: value.sourceId };
      const data = encode(next);
      sql.prepare("UPDATE folder_operations SET phase=?,updated_at=?,body=?,sha=? WHERE id=?")
        .run(next.phase, next.updatedAt, data.body, data.sha, id);
      return read(id);
    })();
  }
  function recover(now = Date.now()) {
    for (const value of list()) {
      if (value.phase === "pending") update(value.id, "pending", { phase: "paused", updatedAt: now, reason: "restart" });
      if (value.phase === "running") update(value.id, "running", { phase: "uncertain", updatedAt: now, reason: "interrupted" });
    }
  }
  return { file, read, list, insert, update, recover, close() { sql.close(); } };
}

module.exports = { createJournal, ACTIVE, digest };
