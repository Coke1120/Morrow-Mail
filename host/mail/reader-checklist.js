"use strict";

const { createHash, randomUUID } = require("node:crypto");
const unavailable = "This message is no longer available for a private checklist.";
const limit = 32;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function providerProof(row) {
  // A changed UIDVALIDITY or an opaque provider id cannot inherit marks.
  const source = row.gmail_id
    ? ["gmail", row.gmail_id]
    : ["local-row", row.folder_path, row.uid_validity, row.uid, row.rfc_message_id];
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function readerChecklist(db, source, params, currentEpoch) {
  if (!source || !Number.isSafeInteger(source.bodyEpoch) || source.bodyEpoch !== currentEpoch(source.accountId)) {
    throw new Error(unavailable);
  }
  const message = db.messageById(source.messageId);
  if (!message || message.account_id !== source.accountId || !db.accountById(source.accountId) ||
      message.is_draft || message.draft_pending || message.body_complete !== 1) throw new Error(unavailable);
  const owner = [source.accountId, source.messageId, providerProof(message)];
  const read = () => db.readerChecklistItems(owner, limit).map(row => ({
    id: row.item_id, text: row.excerpt, done: row.done === 1,
  }));
  if (params?.action === "list") return read();
  if (params?.action === "add") {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text || text.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error("Select visible message text of 1–512 characters.");
    }
    const found = read();
    if (found.some(row => row.text === text)) return found;
    if (found.length >= limit) throw new Error("This checklist has 32 items. Remove an item before adding another.");
    db.addReaderChecklistItem(owner, randomUUID(), text);
  } else if (params?.action === "set" && typeof params.done === "boolean" && typeof params.id === "string" && ID.test(params.id)) {
    db.setReaderChecklistItem(owner, params.id, params.done);
  } else if (params?.action === "remove" && typeof params.id === "string" && ID.test(params.id)) {
    db.removeReaderChecklistItem(owner, params.id);
  } else {
    throw new Error("Unsupported private checklist action.");
  }
  return read();
}

module.exports = { readerChecklist };
