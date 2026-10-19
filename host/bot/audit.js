"use strict";

const fs = require("fs");
const { auditPath, writePrivate } = require("./store");

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function record(entry) {
  const row = {
    at: typeof entry.at === "string" ? entry.at : new Date().toISOString(),
    clientId: typeof entry.clientId === "string" ? entry.clientId : "",
    operation: typeof entry.operation === "string" ? entry.operation : "",
    code: typeof entry.code === "string" ? entry.code : "",
    requestId: typeof entry.requestId === "string" ? entry.requestId : "",
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
    bytes: Number.isFinite(entry.bytes) ? Math.max(0, Math.round(entry.bytes)) : 0,
    accountId: typeof entry.accountId === "string" ? entry.accountId : "",
    auditId: typeof entry.auditId === "string" ? entry.auditId : "",
  };
  const line = JSON.stringify(row);
  if (line.includes("mmb_v1_") || line.includes("Bearer ")) return;
  const file = auditPath();
  try {
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) compact(file);
  } catch {
    /* audit must not break the request */
  }
}

function compact(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  const cutoff = Date.now() - MAX_AGE_MS;
  const kept = text.split("\n").filter((line) => {
    if (!line) return false;
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row.at);
      return Number.isFinite(at) && at >= cutoff;
    } catch {
      return false;
    }
  });
  const sliced = kept.slice(Math.floor(kept.length / 2));
  try { writePrivate(file, sliced.length ? `${sliced.join("\n")}\n` : ""); } catch { /* keep going */ }
}

function recent(limit = 8) {
  const file = auditPath();
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const cutoff = Date.now() - MAX_AGE_MS;
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < cutoff) continue;
      rows.push({
        at: row.at,
        clientId: row.clientId || "",
        operation: row.operation || "",
        code: row.code || "",
        durationMs: row.durationMs || 0,
        bytes: row.bytes || 0,
        accountId: row.accountId || "",
        auditId: row.auditId || "",
      });
    } catch {
      /* skip a damaged line */
    }
  }
  return rows.slice(-limit).reverse();
}

module.exports = { record, recent };
