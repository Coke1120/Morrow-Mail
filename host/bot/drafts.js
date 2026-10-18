"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { DRAFTS_PENDING, DRAFTS_PER_DAY, DRAFT_TTL_MS, MAX_RECIPIENTS } = require("./constants");
const { draftPath, writePrivate } = require("./store");
const { byteLength, trimUtf8 } = require("./text");

const STORE_CAP = 2 * 1024 * 1024;

function coded(code) {
  const error = new Error(code);
  error.code = code;
  error.expose = true;
  return error;
}

function empty() {
  return { version: 1, proposals: [] };
}

function load() {
  const file = draftPath();
  if (!fs.existsSync(file)) return { ok: true, store: empty() };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > STORE_CAP) return { ok: false, store: null };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.proposals)) return { ok: false, store: null };
    return { ok: true, store: parsed };
  } catch {
    return { ok: false, store: null };
  }
}

function save(store) {
  writePrivate(draftPath(), `${JSON.stringify(store)}\n`);
}

function expired(row, now) {
  return !row || !row.expiresAt || Date.parse(row.expiresAt) <= now;
}

function sweep(store, now) {
  for (const row of store.proposals) {
    if (row && row.status === "pending" && expired(row, now)) row.status = "expired";
  }
}

function contentHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    accountId: input.accountId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyText: input.bodyText,
    inReplyToMessageId: input.inReplyToMessageId || "",
  })).digest("hex");
}

function dayCount(store, clientId, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return store.proposals.filter((row) => {
    return row && row.clientId === clientId && String(row.createdAt || "").slice(0, 10) === day;
  }).length;
}

function pendingCount(store, clientId) {
  return store.proposals.filter((row) => row && row.clientId === clientId && row.status === "pending").length;
}

function structural(row, includeBody) {
  const base = {
    proposalId: row.id,
    accountId: row.accountId,
    clientId: row.clientId,
    status: row.status,
    subject: row.subject,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revision: row.revision,
    reviewInMorrow: true,
    sends: false,
    providerDraft: false,
    bodyStored: true,
    bodyBytes: byteLength(row.bodyText),
  };
  if (includeBody) base.bodyText = row.bodyText;
  return base;
}

function remoteView(row) {
  const view = structural(row, false);
  delete view.clientId;
  delete view.bodyText;
  return view;
}

function submit(input) {
  const loaded = load();
  if (!loaded.ok) throw coded("STORE_UNAVAILABLE");
  const now = Date.now();
  sweep(loaded.store, now);
  const hash = contentHash(input);
  const existing = loaded.store.proposals.find((row) => {
    return row && row.clientId === input.clientId && row.idempotencyKey === input.idempotencyKey;
  });
  if (existing) {
    if (existing.contentHash !== hash) throw coded("INVALID_REQUEST");
    save(loaded.store);
    return { proposal: remoteView(existing), replay: true };
  }
  if (dayCount(loaded.store, input.clientId, now) >= DRAFTS_PER_DAY) throw coded("RATE_LIMITED");
  if (pendingCount(loaded.store, input.clientId) >= DRAFTS_PENDING) throw coded("RATE_LIMITED");
  const row = {
    id: `dprop-${crypto.randomBytes(9).toString("hex")}`,
    accountId: input.accountId,
    clientId: input.clientId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyText: input.bodyText,
    inReplyToMessageId: input.inReplyToMessageId || "",
    idempotencyKey: input.idempotencyKey,
    contentHash: hash,
    status: "pending",
    revision: 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(),
    openedAt: null,
    reviewHash: null,
  };
  loaded.store.proposals.push(row);
  if (JSON.stringify(loaded.store).length > STORE_CAP) throw coded("REQUEST_TOO_LARGE");
  save(loaded.store);
  return { proposal: remoteView(row), replay: false };
}

function listForClient(clientId, accountId, limit) {
  const loaded = load();
  if (!loaded.ok) throw coded("STORE_UNAVAILABLE");
  sweep(loaded.store, Date.now());
  save(loaded.store);
  const rows = loaded.store.proposals.filter((row) => {
    return row && row.clientId === clientId && row.accountId === accountId && row.status === "pending";
  });
  const items = rows.slice(0, limit).map(remoteView);
  return { items, more: rows.length > limit };
}

function listLocal() {
  const loaded = load();
  if (!loaded.ok) return { available: false, proposals: [] };
  sweep(loaded.store, Date.now());
  try { save(loaded.store); } catch { /* the screen can still show the last good copy */ }
  return {
    available: true,
    proposals: loaded.store.proposals
      .filter((row) => row && (row.status === "pending" || row.status === "opened"))
      .map((row) => structural(row, true)),
  };
}

function find(id) {
  const loaded = load();
  if (!loaded.ok) return { ok: false, row: null, store: null };
  return {
    ok: true,
    row: loaded.store.proposals.find((item) => item && item.id === id) || null,
    store: loaded.store,
  };
}

function composeSeed(proposalId) {
  const found = find(proposalId);
  if (!found.ok) throw coded("STORE_UNAVAILABLE");
  const row = found.row;
  if (!row) {
    const error = coded("NOT_FOUND");
    error.publicMessage = "That draft proposal is not on this computer.";
    throw error;
  }
  if (row.status === "dismissed" || row.status === "expired" || expired(row, Date.now())) {
    if (row.status === "pending") row.status = "expired";
    save(found.store);
    const error = coded("NOT_FOUND");
    error.publicMessage = "That draft proposal is no longer waiting for review.";
    throw error;
  }
  row.status = "opened";
  row.openedAt = new Date().toISOString();
  row.reviewHash = row.contentHash;
  row.revision += 1;
  save(found.store);
  return {
    proposalId: row.id,
    accountId: row.accountId,
    to: row.to.join(", "),
    cc: row.cc.join(", "),
    bcc: row.bcc.join(", "),
    subject: row.subject,
    body: row.bodyText,
    contentHash: row.contentHash,
    sends: false,
  };
}

function dismiss(proposalId) {
  const found = find(proposalId);
  if (!found.ok) throw coded("STORE_UNAVAILABLE");
  if (!found.row) {
    const error = coded("NOT_FOUND");
    error.publicMessage = "That draft proposal is not on this computer.";
    throw error;
  }
  found.row.status = "dismissed";
  found.row.revision += 1;
  save(found.store);
  return { proposalId, status: "dismissed", sends: false };
}

function addressList(value, allowEmpty) {
  if (value == null && allowEmpty) return [];
  if (!Array.isArray(value)) return null;
  if (!allowEmpty && !value.length) return null;
  if (value.length > MAX_RECIPIENTS) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || byteLength(text) > 320 || /[\s\u0000]/.test(text) || !text.includes("@")) return null;
    out.push(text);
  }
  return out;
}

function normalizeSubmission(params) {
  const to = addressList(params.to, false);
  const cc = addressList(params.cc || [], true);
  const bcc = addressList(params.bcc || [], true);
  if (!to || !cc || !bcc) return null;
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) return null;
  if (typeof params.subject !== "string") return null;
  const subject = trimUtf8(params.subject, 512);
  if (subject.truncated && byteLength(params.subject) > 512) return null;
  if (typeof params.bodyText !== "string" || byteLength(params.bodyText) > 32 * 1024) return null;
  if (typeof params.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,80}$/.test(params.idempotencyKey)) return null;
  let inReplyToMessageId = "";
  if (params.inReplyToMessageId != null && params.inReplyToMessageId !== "") {
    if (typeof params.inReplyToMessageId !== "string") return null;
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(params.inReplyToMessageId)) return null;
    inReplyToMessageId = params.inReplyToMessageId;
  }
  return {
    to,
    cc,
    bcc,
    subject: subject.text,
    bodyText: params.bodyText,
    idempotencyKey: params.idempotencyKey,
    inReplyToMessageId,
  };
}

module.exports = {
  submit,
  listForClient,
  listLocal,
  composeSeed,
  dismiss,
  normalizeSubmission,
  contentHash,
};
