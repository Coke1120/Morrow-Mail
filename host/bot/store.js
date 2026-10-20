"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { userDataDir } = require("../paths");

function bridgeDir() {
  return userDataDir();
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows permissions differ */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows permissions differ */ }
}

function syncParentDirectory(file) {
  // Node cannot open a directory for FlushFileBuffers on Windows. File fsync
  // and same-directory rename are the durable order there.
  if (process.platform === "win32") return;
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function writeDurable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows permissions differ */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows permissions differ */ }
  syncParentDirectory(file);
}

function accessPath() {
  return path.join(bridgeDir(), "bot-access.json");
}

function sendReceiptPath() {
  return path.join(bridgeDir(), "bot-send-receipts.json");
}

function draftPath() {
  return path.join(bridgeDir(), "bot-draft-proposals.json");
}

function auditPath() {
  return path.join(bridgeDir(), "bot-audit.log");
}

module.exports = {
  bridgeDir,
  writePrivate,
  writeDurable,
  accessPath,
  draftPath,
  auditPath,
  sendReceiptPath,
};
