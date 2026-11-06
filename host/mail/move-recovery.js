"use strict";

// Source-removal facts only. Copy receipts remain independent and intact.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Database = require("better-sqlite3");
const LIMITS = Object.freeze({ records: 1000, recordBytes: 16384, fileBytes: 32 * 1024 * 1024 });
const PHASES = new Set(["prepared", "source_unknown", "source_trashed", "not_trashed"]);
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const problem = () => Object.assign(new Error("Move recovery storage could not be verified. Source removal is blocked; keep the copies and recovery files."), { code: "move_recovery", operationIssued: false });
const conflict = () => Object.assign(new Error("This source Move receipt changed. Review the current result before another action."), { code: "move_conflict", operationIssued: false });

function createJournal(file, { database = Database } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  if (existed) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > LIMITS.fileBytes) throw problem();
  }
  const sql = new database(file);
  let identity, poisoned = false;
  try {
    fs.chmodSync(file, 0o600);
    sql.pragma("journal_mode = DELETE"); sql.pragma("synchronous = EXTRA"); sql.pragma("fullfsync = ON");
    const pageSize = sql.pragma("page_size", { simple: true });
    sql.pragma(`max_page_count = ${Math.floor(LIMITS.fileBytes / pageSize)}`);
    const version = sql.pragma("user_version", { simple: true });
    if (version > 1 || existed && version !== 1) throw problem();
    if (existed && sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='mailbox_moves'").get().n !== 1) throw problem();
    if (sql.pragma("quick_check", { simple: true }) !== "ok") throw problem();
    sql.transaction(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS mailbox_moves (
        id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, phase TEXT NOT NULL,
        updated_at INTEGER NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL
      ); PRAGMA user_version = 1;`);
    })();
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    identity = fs.lstatSync(file);
  } catch (error) { sql.close(); throw error.code === "move_recovery" ? error : problem(); }

  function decode(row) {
    if (!row || typeof row.body !== "string" || Buffer.byteLength(row.body) > LIMITS.recordBytes || digest(row.body) !== row.sha) throw problem();
    let value; try { value = JSON.parse(row.body); } catch { throw problem(); }
    if (!value || value.id !== row.id || value.sourceKey !== row.source_key || value.phase !== row.phase || value.updatedAt !== row.updated_at
      || !PHASES.has(value.phase) || !/^[a-f0-9]{64}$/.test(value.sourceKey || "") || !Number.isSafeInteger(value.updatedAt)
      || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 1000
      || !value.copy || typeof value.copy.id !== "string" || !/^[a-f0-9]{64}$/.test(value.copy.proof || "")
      || !value.source || typeof value.source.accountId !== "string" || typeof value.source.providerId !== "string"
      || !/^[a-f0-9]{64}$/.test(value.source.rawSha || "") || !/^[a-f0-9]{64}$/.test(value.source.binding || "")
      || !value.destination || typeof value.destination.accountId !== "string" || typeof value.destination.folderId !== "string") throw problem();
    return value;
  }
  function all() { return sql.prepare("SELECT * FROM mailbox_moves ORDER BY updated_at,id").all(); }
  function validate() {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes || stat.dev !== identity.dev
      || stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs || sql.pragma("quick_check", { simple: true }) !== "ok") throw problem();
    const rows = all();
    if (rows.length > LIMITS.records) throw problem();
    for (const row of rows) decode(row);
  }
  function guarded(work) {
    if (poisoned) throw problem();
    try {
      // The complete bounded metadata set is checked inside the same native
      // transaction as its use. No integrity cache can miss an external edit.
      return sql.transaction(() => { validate(); return work(); }).immediate();
    } catch (error) {
      if (["move_conflict", "move_limit"].includes(error.code)) throw error;
      poisoned = true; throw problem();
    }
  }
  function readUnchecked(id) { const row = sql.prepare("SELECT * FROM mailbox_moves WHERE id=?").get(id); return row ? decode(row) : null; }
  function encode(value) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > LIMITS.recordBytes) throw problem();
    decode({ id: value.id, source_key: value.sourceKey, phase: value.phase, updated_at: value.updatedAt, body, sha: digest(body) });
    return { body, sha: digest(body) };
  }
  function insert(value) {
    return guarded(() => {
      if (sql.prepare("SELECT 1 FROM mailbox_moves WHERE source_key=?").get(value.sourceKey)) throw conflict();
      if (sql.prepare("SELECT COUNT(*) n FROM mailbox_moves").get().n >= LIMITS.records) throw Object.assign(new Error("Move recovery storage is full. Existing source-removal evidence was retained; no source was removed."), { code: "move_limit", operationIssued: false });
      const data = encode(value);
      sql.prepare("INSERT INTO mailbox_moves VALUES(?,?,?,?,?,?)").run(value.id, value.sourceKey, value.phase, value.updatedAt, data.body, data.sha);
      return readUnchecked(value.id);
    });
  }
  function update(id, expected, patch) {
    return guarded(() => {
      const value = readUnchecked(id);
      if (!value || !(Array.isArray(expected) ? expected : [expected]).includes(value.phase)) throw conflict();
      const next = { ...value, ...patch, id: value.id, sourceKey: value.sourceKey };
      const data = encode(next);
      sql.prepare("UPDATE mailbox_moves SET phase=?,updated_at=?,body=?,sha=? WHERE id=?").run(next.phase, next.updatedAt, data.body, data.sha, id);
      return readUnchecked(id);
    });
  }
  function recover(now = Date.now()) {
    for (const value of list()) if (value.phase === "prepared") update(value.id, "prepared", {
      phase: "not_trashed", updatedAt: now, detail: "The unsubmitted Move review expired at restart. The destination copy remains; no source write will resume." });
    // source_unknown stays unknown, even if its HTTP acknowledgement was lost.
  }
  function list() { return guarded(() => all().map(decode)); }
  return { file, insert, update, list, recover,
    find(sourceKey) { return guarded(() => { const row = sql.prepare("SELECT * FROM mailbox_moves WHERE source_key=?").get(sourceKey); return row ? decode(row) : null; }); },
    read(id) { return guarded(() => readUnchecked(id)); },
    assertIntegrity() { return guarded(() => true); }, close() { sql.close(); } };
}

module.exports = { createJournal, PHASES, LIMITS, digest };
