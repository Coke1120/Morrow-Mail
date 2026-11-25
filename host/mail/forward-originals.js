"use strict";

const { digest, isMessage } = require("./local-folders");

const unavailable = () => new Error("A selected original is unavailable or changed. Review your selection again.");

function filenameFor(subject, index) {
  const safe = subject.replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]+/gu, " ").trim();
  const title = Array.from(safe).slice(0, 56).join("").trim() || "Untitled message";
  return `${index + 1} - ${title}.eml`;
}

function snapshot(archive, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(isMessage) || new Set(ids).size !== ids.length) {
    throw new Error("Choose up to 200 different messages from Local Folders.");
  }
  return ids.map((id, index) => {
    const original = archive.originalMetadata(id);
    if (!original || !Number.isSafeInteger(original.size) || original.size < 1 || !/^[a-f0-9]{64}$/.test(original.rawSha)) {
      throw unavailable();
    }
    const subject = original.subject || "";
    return { id, folderId: original.folderId, from: original.from || "", subject, date: original.date || null,
      filename: filenameFor(subject, index), size: original.size, rawSha: original.rawSha };
  });
}

function byteTotal(items) {
  return items.reduce((sum, item) => sum + item.size, 0);
}

function selectionProof(items) {
  return digest(JSON.stringify(items));
}

function reviewOriginals(archive, ids, limit) {
  const selected = snapshot(archive, ids);
  const totalBytes = byteTotal(selected);
  return {
    items: selected.map(({ rawSha, folderId, ...item }) => item),
    proof: selectionProof(selected),
    totalBytes,
    overLimit: totalBytes > limit,
  };
}

function readOriginals(archive, ids, proof, limit) {
  const selected = snapshot(archive, ids);
  if (proof !== selectionProof(selected)) throw unavailable();
  if (byteTotal(selected) > limit) throw new Error("The selected originals exceed the 25 MiB outgoing attachment limit.");
  return selected.map(({ id, filename, size, rawSha }) => {
    const fileBytes = archive.raw(id);
    if (!Buffer.isBuffer(fileBytes) || fileBytes.length !== size || digest(fileBytes) !== rawSha) throw unavailable();
    // A binary .eml attachment can use base64 without message/rfc822's transfer-encoding restriction.
    return { filename, mimeType: "application/octet-stream", fileBytes };
  });
}

module.exports = { reviewOriginals, readOriginals };
