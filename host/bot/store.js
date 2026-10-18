"use strict";

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

function accessPath() {
  return path.join(bridgeDir(), "bot-access.json");
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
  accessPath,
  draftPath,
  auditPath,
};
