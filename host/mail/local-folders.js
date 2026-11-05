"use strict";

// An archive owns its bytes. Nothing here imports the account cache, credentials,
// sync, or attachment TTL cache. Copy this database with the app stopped to back up.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { simpleParser } = require("mailparser");
const { recipientHeaders } = require("./recipient-headers");
const composePolicy = require("../../shared/compose-policy");
const decoding = require("./mime-decoding");

const ACCOUNT_ID = "__morrow_local__";
const ARCHIVE_ID = "local-folder:archive";
const TRASH_ID = "local-folder:trash";
const RAW_LIMIT = 64 * 1024 * 1024;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const problem = message => Object.assign(new Error(message), { code: "local_archive" });
const isMessage = id => typeof id === "string" && id.startsWith("local-message:");

function addresses(header) {
  return (header?.value || []).flatMap(value => value.group ? addresses({ value: value.group })
    : value.address ? [value.name ? `${value.name} <${value.address}>` : value.address] : []);
}

async function parseArchive(raw, source = {}) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > RAW_LIMIT) throw problem("A complete message within the 64 MiB local-copy limit is required.");
  const parsed = await simpleParser(raw);
  const quality = await decoding.inspectSource(raw);
  decoding.noteHeaders(quality, parsed);
  const files = parsed.attachments.map(file => ({ id: `local-attachment:${crypto.randomUUID()}`,
    filename: file.filename || "attachment", mimeType: file.contentType || "application/octet-stream",
    contentId: file.contentId || null, isInlineFromApi: !!file.contentId && file.contentDisposition === "inline",
    size: file.content.length, data: Buffer.from(file.content) }));
  const date = parsed.date instanceof Date && Number.isFinite(parsed.date.getTime()) ? parsed.date.toISOString() : source.date || null;
  const headers = recipientHeaders(raw, parsed.replyTo);
  const body = { htmlBody: typeof parsed.html === "string" ? parsed.html : null, textBody: parsed.text || "" };
  const info = {
    subject: parsed.subject || "", from: addresses(parsed.from).join(", "), fromAddress: parsed.from?.value?.[0]?.address || "",
    to: addresses(parsed.to), cc: addresses(parsed.cc), bcc: addresses(parsed.bcc), replyTo: headers.replyTo || [], recipientHeaders: headers,
    messageId: parsed.messageId || null, inReplyTo: parsed.inReplyTo || null, date,
    dateSource: parsed.date ? "header" : source.dateSource || "unknown",
    listSortTs: Number.isFinite(Date.parse(date)) ? Date.parse(date) : 0,
    snippet: (parsed.text || "").replace(/\s+/g, " ").slice(0, 180),
    attachments: files.map(({ data, ...file }) => file), hasAttachments: files.some(file => !file.isInlineFromApi),
    isDraft: false, platform: "local", isLocal: true, bodyComplete: true, hasBody: true, bodyWarning: "",
    replied: source.replied ?? null, forwarded: source.forwarded ?? null,
    originalAccountEmail: source.accountEmail || "", originalFolder: source.folderId || "",
    toMe: addresses(parsed.to).some(value => composePolicy.addresses(value).includes(String(source.accountEmail || "").toLowerCase())),
    decoding: quality,
  };
  return { raw, files, body, info };
}

function createLocalStore(file, { database = Database } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  if (existed && fs.statSync(file).size === 0) throw problem("The local archive file is incomplete. Its file was retained; restore a backup before continuing.");
  const sql = new database(file);
  try {
    fs.chmodSync(file, 0o600);
    sql.pragma("foreign_keys = ON");
    sql.pragma("journal_mode = DELETE");
    // EXTRA includes the journal unlink directory sync. No disposable live DB.
    sql.pragma("synchronous = EXTRA");
    sql.pragma("fullfsync = ON");
    const version = sql.pragma("user_version", { simple: true });
    if (version > 1) throw problem("This local archive needs a newer version of Morrow Mail. Its files were retained.");
    if (existed && version !== 1) throw problem("This local archive format could not be recognized. Its files were retained; restore a backup before continuing.");
    if (version === 1 && sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('folders','messages','attachments','transfers')").get().n !== 4) throw problem("The local archive schema is incomplete. Its files were retained; restore a backup before continuing.");
    sql.transaction(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id), system INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS local_folder_names ON folders(COALESCE(parent_id,''), name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id), info TEXT NOT NULL, info_sha TEXT NOT NULL,
        body TEXT NOT NULL, body_sha TEXT NOT NULL, raw BLOB NOT NULL, raw_sha TEXT NOT NULL, raw_size INTEGER NOT NULL,
        unread INTEGER NOT NULL, starred INTEGER NOT NULL, sort_ts INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_message_folder ON messages(folder_id, sort_ts DESC, id);
      CREATE TABLE IF NOT EXISTS attachments (
        message_id TEXT NOT NULL REFERENCES messages(id), id TEXT NOT NULL, data BLOB NOT NULL, sha TEXT NOT NULL,
        PRIMARY KEY(message_id,id)
      );
      CREATE TABLE IF NOT EXISTS transfers (
        source_key TEXT NOT NULL, destination TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
        status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', PRIMARY KEY(source_key,destination)
      );`);
      sql.prepare("INSERT OR IGNORE INTO folders(id,name,system) VALUES(?,?,1)").run(ARCHIVE_ID, "Archive");
      sql.prepare("INSERT OR IGNORE INTO folders(id,name,system) VALUES(?,?,1)").run(TRASH_ID, "Trash");
      sql.pragma("user_version = 1");
    })();
    if (process.platform !== "win32") {
      const fd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } catch (error) { sql.close(); throw error; }

  function folder(id) {
    const row = sql.prepare("SELECT * FROM folders WHERE id=?").get(id);
    if (!row) throw problem("That local folder is no longer available. Choose a folder again.");
    return row;
  }
  function folders() {
    return sql.prepare(`SELECT f.*, COUNT(m.id) AS total, COALESCE(SUM(m.unread),0) AS unread
      FROM folders f LEFT JOIN messages m ON m.folder_id=f.id GROUP BY f.id ORDER BY f.system DESC,f.name COLLATE NOCASE`).all().map(row => ({
      id: row.id, name: row.name, parentId: row.parent_id, wellKnownName: row.id === TRASH_ID ? "deleteditems" : row.id === ARCHIVE_ID ? "archive" : null,
      type: "local", system: !!row.system, totalCount: row.total, unreadCount: row.unread, syncs: false,
      emptyCopy: "No messages in this local folder. Use Copy to Local Folders on a downloaded server message.",
    }));
  }
  function account() {
    return { id: ACCOUNT_ID, platform: "local", mailTransport: "local", isLocal: true, name: "Local Folders", label: "Local Folders",
      email: "", displayEmail: "On this computer", isConnected: false, delimiter: "/", folders: { primary: folders(), more: [] } };
  }
  function message(id, full = true) {
    const row = sql.prepare(`SELECT id,folder_id,info,unread,starred${full ? ",body" : ""} FROM messages WHERE id=?`).get(id);
    if (!row) throw problem("That local message is no longer available.");
    const info = JSON.parse(row.info);
    const body = full ? JSON.parse(row.body) : {};
    const presented = full ? decoding.presentation({ uid: 1, decoding_json: info.decoding, subject: info.subject, from_addr: info.from }, body) : {};
    return { ...info, ...body, ...(full ? { htmlBody: presented.htmlBody, textBody: presented.textBody,
      encodingWarning: presented.warning ? presented.warning + " Original bytes are retained in Save EML." : "" } : {}), id: row.id, accountId: ACCOUNT_ID,
      folderId: row.folder_id, folders: [row.folder_id], threadId: row.id, conversationId: row.id,
      unread: !!row.unread, isRead: !row.unread, isStarred: !!row.starred, bodyEpoch: 0, bodyVersion: 0 };
  }
  function verify(id) {
    const row = sql.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!row || row.raw.length !== row.raw_size || digest(row.raw) !== row.raw_sha || digest(row.info) !== row.info_sha || digest(row.body) !== row.body_sha) {
      throw problem("Local copy verification failed. The server message was retained. Check storage and copy again.");
    }
    const attachments = sql.prepare("SELECT id,data,sha FROM attachments WHERE message_id=?").all(id);
    const expected = JSON.parse(row.info).attachments;
    if (attachments.length !== expected.length || attachments.some(part => digest(part.data) !== part.sha
      || !expected.some(item => item.id === part.id && item.size === part.data.length))) throw problem("Local attachment verification failed. The server message was retained.");
    return message(id);
  }
  function receipt(sourceKey, destination) {
    return sql.prepare("SELECT * FROM transfers WHERE source_key=? AND destination=?").get(sourceKey, destination);
  }
  function sourceReceipt(sourceKey) {
    return sql.prepare(`SELECT * FROM transfers WHERE source_key=? ORDER BY CASE status WHEN 'remote_unknown' THEN 0 WHEN 'moved' THEN 1 ELSE 2 END LIMIT 1`).get(sourceKey);
  }
  function save(sourceKey, destination, archive, flags = {}) {
    folder(destination);
    const prior = receipt(sourceKey, destination);
    if (prior) { verify(prior.message_id); return prior; }
    const id = `local-message:${crypto.randomUUID()}`, info = JSON.stringify(archive.info), body = JSON.stringify(archive.body);
    sql.transaction(() => {
      folder(destination);
      sql.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, destination, info, digest(info), body, digest(body), archive.raw,
        digest(archive.raw), archive.raw.length, flags.unread ? 1 : 0, flags.isStarred ? 1 : 0, archive.info.listSortTs, Date.now());
      const insert = sql.prepare("INSERT INTO attachments VALUES(?,?,?,?)");
      for (const part of archive.files) insert.run(id, part.id, part.data, digest(part.data));
      sql.prepare("INSERT INTO transfers(source_key,destination,message_id,status) VALUES(?,?,?,'copied')").run(sourceKey, destination, id);
    })();
    verify(id);
    return receipt(sourceKey, destination);
  }
  function setReceipt(sourceKey, destination, status, detail = "") {
    if (!["copied", "moved", "remote_failed", "remote_unknown"].includes(status)) throw problem("Invalid transfer state.");
    sql.prepare("UPDATE transfers SET status=?,detail=? WHERE source_key=? AND destination=?").run(status, detail, sourceKey, destination);
    return receipt(sourceKey, destination);
  }
  function manageFolder(params) {
    const name = String(params.name || "").trim();
    if (params.action !== "delete" && (!name || name.length > 200 || /[\x00-\x1f/\\]/.test(name))) throw problem("Use a folder name of 1–200 characters without slashes or control characters.");
    return sql.transaction(() => {
      if (params.action === "create") {
        if (params.parentId) folder(params.parentId);
        const id = `local-folder:${crypto.randomUUID()}`;
        sql.prepare("INSERT INTO folders(id,name,parent_id) VALUES(?,?,?)").run(id, name, params.parentId || null);
        return { id };
      }
      const current = folder(params.folderId);
      if (current.system) throw problem("Archive and Trash are permanent local folders.");
      if (params.action === "rename") sql.prepare("UPDATE folders SET name=? WHERE id=?").run(name, current.id);
      else if (params.action === "delete") {
        if (sql.prepare("SELECT 1 FROM messages WHERE folder_id=?").get(current.id) || sql.prepare("SELECT 1 FROM folders WHERE parent_id=?").get(current.id)) throw problem("Move all messages and subfolders out before deleting this local folder.");
        sql.prepare("DELETE FROM folders WHERE id=?").run(current.id);
      } else throw problem("Choose create, rename or delete.");
      return { id: current.id };
    })();
  }
  function list(params = {}) {
    folder(params.folderId || ARCHIVE_ID);
    const rules = ["folder_id=@folder"], args = { folder: params.folderId || ARCHIVE_ID };
    if (params.filterUnread) rules.push("unread=1");
    if (params.filterFlagged) rules.push("starred=1");
    if (params.filterToMe) rules.push("json_extract(info,'$.toMe')=1");
    if (typeof params.filterAttachments === "boolean") { rules.push("json_extract(info,'$.hasAttachments')=@attachments"); args.attachments = params.filterAttachments ? 1 : 0; }
    const where = rules.join(" AND ");
    const total = sql.prepare(`SELECT COUNT(*) n FROM messages WHERE ${where}`).get(args).n;
    const limit = Math.max(1, Math.min(2000, Math.floor(Number(params.limit) || 200)));
    const offset = Number.isSafeInteger(Number(params.offset)) ? Math.max(0, Number(params.offset)) : 0;
    const ids = sql.prepare(`SELECT id FROM messages WHERE ${where} ORDER BY ${ordering(params)} LIMIT @limit OFFSET @offset`).all({ ...args, limit, offset });
    const more = offset + ids.length < total;
    return { emails: ids.map(row => message(row.id, false)), threads: {}, total, hasMore: more, hasMoreInCache: more, hasMoreBelow: more, initialSyncDone: true };
  }
  function update(id, changes) {
    return sql.transaction(() => {
      message(id, false);
      if (typeof changes.isRead === "boolean") sql.prepare("UPDATE messages SET unread=? WHERE id=?").run(changes.isRead ? 0 : 1, id);
      if (typeof changes.isStarred === "boolean") sql.prepare("UPDATE messages SET starred=? WHERE id=?").run(changes.isStarred ? 1 : 0, id);
      if (changes.folderId) { folder(changes.folderId); sql.prepare("UPDATE messages SET folder_id=? WHERE id=?").run(changes.folderId, id); }
      return message(id);
    })();
  }
  function copy(id, destination) {
    verify(id); folder(destination);
    const existing = sql.prepare("SELECT * FROM messages WHERE id=?").get(id);
    const info = JSON.parse(existing.info), body = JSON.parse(existing.body);
    const files = sql.prepare("SELECT * FROM attachments WHERE message_id=?").all(id);
    return save(digest(JSON.stringify([id, existing.raw_sha])), destination, { raw: existing.raw, info, body, files }, message(id));
  }
  function search(params = {}) {
    const query = String(params.query || "").trim().toLowerCase();
    if (!query) return [];
    const rows = sql.prepare(`SELECT id FROM messages WHERE
      (instr(lower(json_extract(info,'$.subject')),@query)>0 OR instr(lower(json_extract(info,'$.from')),@query)>0
      OR instr(lower(json_extract(info,'$.to')),@query)>0 OR instr(lower(json_extract(body,'$.textBody')),@query)>0)
      ${params.filterToMe ? "AND json_extract(info,'$.toMe')=1" : ""}
      ORDER BY ${ordering(params)} LIMIT 100`).all({ query });
    return rows.map(row => message(row.id, false));
  }
  function ordering(params) {
    const field = { date: "sort_ts", subject: "json_extract(info,'$.subject') COLLATE NOCASE", sender: "json_extract(info,'$.from') COLLATE NOCASE", recipient: "COALESCE(json_extract(info,'$.to[0]'),'') COLLATE NOCASE" }[params.sortBy] || "sort_ts";
    const direction = params.sortDirection === "asc" ? "ASC" : "DESC";
    return `${field} ${direction},id ${direction}`;
  }
  return { file, folder, folders, account, message, verify, receipt, sourceReceipt, save, setReceipt, manageFolder, list, search, update, copy,
    transaction(work) { return sql.transaction(work)(); },
    attachment(id, attachmentId) {
      const owner = sql.prepare("SELECT info,info_sha FROM messages WHERE id=?").get(id);
      if (!owner || digest(owner.info) !== owner.info_sha) throw problem("Local message metadata verification failed.");
      const expected = JSON.parse(owner.info).attachments.find(part => part.id === attachmentId);
      const part = sql.prepare("SELECT data,sha FROM attachments WHERE message_id=? AND id=?").get(id, attachmentId);
      if (!part || !expected || expected.size !== part.data.length || digest(part.data) !== part.sha) throw problem("Local attachment verification failed. Its bytes were retained for recovery.");
      return Buffer.from(part.data);
    }, raw(id) {
      const row = sql.prepare("SELECT raw,raw_sha,raw_size FROM messages WHERE id=?").get(id);
      if (!row || row.raw.length !== row.raw_size || digest(row.raw) !== row.raw_sha) throw problem("Original MIME verification failed. Its bytes were retained for recovery.");
      return Buffer.from(row.raw);
    },
    close() { sql.close(); } };
}

// Caller serializes the source account lane. No provider deletion runs until
// the durable copy is re-read and checked, including on a repeated request.
async function transferToLocal({ store, destination, sourceKey, download, source, assertCurrent, trash, move = false }) {
  store.folder(destination);
  const priorSource = store.sourceReceipt(sourceKey);
  let saved = store.receipt(sourceKey, destination);
  if (!saved) {
    assertCurrent();
    const raw = priorSource ? store.raw(priorSource.message_id) : await download();
    assertCurrent();
    const archive = await parseArchive(raw, source);
    assertCurrent();
    saved = store.save(sourceKey, destination, archive, source);
  }
  store.verify(saved.message_id);
  if (move && priorSource && ["moved", "remote_unknown"].includes(priorSource.status)) {
    saved = store.setReceipt(sourceKey, destination, priorSource.status, priorSource.detail);
  }
  if (!move || ["moved", "remote_unknown"].includes(saved.status)) return { localId: saved.message_id, status: saved.status, detail: saved.detail };
  try {
    assertCurrent();
    // A crash from here through acknowledgement is deliberately uncertain.
    // Restart/repeated requests retain the archive and never replay Trash.
    store.setReceipt(sourceKey, destination, "remote_unknown", "Local copy saved. Server Trash outcome is unconfirmed; check the server before another move.");
  } catch {
    return { localId: saved.message_id, status: "remote_failed", detail: "Local copy saved and verified. The source changed or the move intent could not be saved. No server move was submitted by this operation." };
  }
  let trashFinished = false;
  try {
    await trash();
    trashFinished = true;
    assertCurrent();
    saved = store.setReceipt(sourceKey, destination, "moved", "Local copy verified; the server original is in Trash.");
  } catch (error) {
    const status = !trashFinished && error.operationIssued === false ? "remote_failed" : "remote_unknown";
    try {
      saved = store.setReceipt(sourceKey, destination, status, status === "remote_failed"
        ? "Local copy saved. The server original could not be moved to Trash; check the account and retry explicitly."
        : "Local copy saved. Server Trash outcome is unconfirmed; check the server before another move.");
    } catch {
      return { localId: saved.message_id, status: "remote_unknown", detail: "Local copy saved. The server result could not be recorded; its durable receipt remains unconfirmed. Check the server before another move." };
    }
  }
  return { localId: saved.message_id, status: saved.status, detail: saved.detail };
}

module.exports = { ACCOUNT_ID, ARCHIVE_ID, TRASH_ID, RAW_LIMIT, digest, isMessage, parseArchive, createLocalStore, transferToLocal };
