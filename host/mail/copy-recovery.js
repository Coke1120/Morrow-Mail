"use strict";

// Metadata-only copy intents. A receipt is never a permission to upload again.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Database = require("better-sqlite3");
const LIMITS = Object.freeze({ records: 5000, recordBytes: 16384, fileBytes: 96 * 1024 * 1024 });
const PHASES = new Set(["prepared", "unknown", "unverified", "verified", "not_uploaded"]);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const corrupt = () => Object.assign(new Error("Copy recovery storage could not be verified. No new upload is allowed; retain its files for recovery."), { code: "copy_recovery", operationIssued: false });

function createJournal(file, { database = Database } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  if (existed) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > LIMITS.fileBytes) throw corrupt();
  }
  const sql = new database(file);
  try {
    fs.chmodSync(file, 0o600);
    sql.pragma("journal_mode = DELETE"); sql.pragma("synchronous = EXTRA"); sql.pragma("fullfsync = ON");
    const pageSize = sql.pragma("page_size", { simple: true });
    sql.pragma(`max_page_count = ${Math.floor(LIMITS.fileBytes / pageSize)}`);
    const version = sql.pragma("user_version", { simple: true });
    if (version > 1 || existed && version !== 1) throw corrupt();
    if (existed && sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='mailbox_copies'").get().n !== 1) throw corrupt();
    if (sql.pragma("quick_check", { simple: true }) !== "ok") throw corrupt();
    sql.transaction(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS mailbox_copies (
        id TEXT PRIMARY KEY, copy_key TEXT NOT NULL UNIQUE, source_key TEXT NOT NULL,
        destination_key TEXT NOT NULL, phase TEXT NOT NULL, updated_at INTEGER NOT NULL,
        body TEXT NOT NULL, sha TEXT NOT NULL
      ); PRAGMA user_version = 1;`);
    })();
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) { sql.close(); throw error.code === "copy_recovery" ? error : corrupt(); }
  let poisoned = false, observedVersion = null, observedStamp = null;
  const identity = fs.lstatSync(file);
  function stamp() {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes
      || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs) throw corrupt();
    return JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]);
  }
  function assertIntegrity(force = false) {
    if (poisoned) throw corrupt();
    try {
      const version = sql.pragma("data_version", { simple: true }), currentStamp = stamp();
      if (force || version !== observedVersion || currentStamp !== observedStamp) {
        if (sql.pragma("quick_check", { simple: true }) !== "ok") throw corrupt();
        const rows = sql.prepare("SELECT * FROM mailbox_copies").all();
        if (rows.length > LIMITS.records) throw corrupt();
        for (const row of rows) decode(row);
      }
      observedVersion = version; observedStamp = currentStamp;
    } catch { poisoned = true; throw corrupt(); }
  }
  function guarded(work) {
    assertIntegrity();
    try {
      const value = work();
      observedVersion = sql.pragma("data_version", { simple: true }); observedStamp = stamp();
      return value;
    } catch (error) {
      if (["copy_exists", "copy_limit", "copy_conflict"].includes(error.code)) throw error;
      poisoned = true; throw corrupt();
    }
  }

  function decode(row) {
    if (!row || typeof row.body !== "string" || Buffer.byteLength(row.body) > LIMITS.recordBytes || digest(row.body) !== row.sha) throw corrupt();
    let value; try { value = JSON.parse(row.body); } catch { throw corrupt(); }
    if (!value || value.id !== row.id || value.key !== row.copy_key || value.sourceKey !== row.source_key
      || value.destinationKey !== row.destination_key || value.phase !== row.phase || value.updatedAt !== row.updated_at
      || !PHASES.has(value.phase) || ![value.key, value.sourceKey, value.destinationKey].every(key => /^[a-f0-9]{64}$/.test(key || ""))) throw corrupt();
    return value;
  }
  function encode(value) {
    const body = JSON.stringify(value);
    if (!PHASES.has(value.phase) || Buffer.byteLength(body) > LIMITS.recordBytes) throw corrupt();
    return { body, sha: digest(body) };
  }
  function find(key) {
    return guarded(() => { const row = sql.prepare("SELECT * FROM mailbox_copies WHERE copy_key=?").get(key); return row ? decode(row) : null; });
  }
  function read(id) {
    return guarded(() => { const row = sql.prepare("SELECT * FROM mailbox_copies WHERE id=?").get(id); return row ? decode(row) : null; });
  }
  function list() {
    return guarded(() => { const rows = sql.prepare("SELECT * FROM mailbox_copies ORDER BY updated_at,id").all();
    if (rows.length > LIMITS.records) throw corrupt();
    return rows.map(decode); });
  }
  function insert(value) {
    return guarded(() => sql.transaction(() => {
      if (find(value.key)) throw Object.assign(new Error("This source and destination already have a copy receipt. Review its result first."), { code: "copy_exists", operationIssued: false });
      if (sql.prepare("SELECT COUNT(*) n FROM mailbox_copies").get().n >= LIMITS.records) throw Object.assign(new Error("Copy recovery storage is full. Retain existing receipts; no new upload was started."), { code: "copy_limit", operationIssued: false });
      const encoded = encode(value);
      sql.prepare("INSERT INTO mailbox_copies VALUES(?,?,?,?,?,?,?,?)").run(value.id, value.key, value.sourceKey,
        value.destinationKey, value.phase, value.updatedAt, encoded.body, encoded.sha);
      return read(value.id);
    })());
  }
  function update(id, expected, patch) {
    return guarded(() => sql.transaction(() => {
      const value = read(id);
      if (!value || !(Array.isArray(expected) ? expected : [expected]).includes(value.phase)) throw Object.assign(new Error("This copy receipt changed. Review its result again."), { code: "copy_conflict", operationIssued: false });
      const next = { ...value, ...patch, id: value.id, key: value.key, sourceKey: value.sourceKey, destinationKey: value.destinationKey };
      const encoded = encode(next);
      sql.prepare("UPDATE mailbox_copies SET phase=?,updated_at=?,body=?,sha=? WHERE id=?")
        .run(next.phase, next.updatedAt, encoded.body, encoded.sha, id);
      return read(id);
    })());
  }
  function recover(now = Date.now()) {
    for (const value of list()) {
      if (value.phase === "prepared") update(value.id, "prepared", { phase: "not_uploaded", updatedAt: now, detail: "Interrupted before submission. A new explicit review is required." });
      if (value.phase === "unverified") update(value.id, "unverified", { phase: "unknown", updatedAt: now, detail: "Upload acknowledged, but destination verification was interrupted. No upload will be repeated." });
      // Unknown outcomes, including a durable pre-submit intent, stay unknown.
    }
  }
  return { file, find, read, list, insert, update, recover, assertIntegrity, close() { sql.close(); } };
}

module.exports = { createJournal, digest, LIMITS, PHASES };
