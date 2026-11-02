"use strict";

const crypto = require("crypto");
const fs = require("fs");
const auth = require("./auth");
const catalog = require("./catalog");
const db = require("../mail/db");
const engine = require("../mail/engine");
const { state: listenerState } = require("./listener-status");
const { mailActionReceiptPath, writeDurable } = require("./store");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const CHANNELS = { "mail.archive": "mail:archive", "mail.mark_read": "mail:markRead", "mail.trash": "mail:delete" };

function coded(code) { return Object.assign(new Error(code), { code, expose: true, operationIssued: false }); }
function load() {
  const file = mailActionReceiptPath();
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.receipts) || data.receipts.some(row => !row
      || typeof row.requestId !== "string" || !UUID.test(row.requestId) || !UUID.test(row.receiptId || "")
      || !CHANNELS[row.operation] || typeof row.accountId !== "string" || !ID.test(row.accountId)
      || typeof row.messageId !== "string" || !ID.test(row.messageId)
      || typeof row.clientId !== "string" || !/^[a-f0-9]{64}$/.test(row.payloadHash)
      || !["claimed", "accepted", "failed"].includes(row.state))) throw Error("Invalid receipt store");
    return data.receipts;
  } catch { throw coded("INTERNAL"); }
}
function save(rows) { writeDurable(mailActionReceiptPath(), JSON.stringify({ version: 1, receipts: rows }) + "\n"); }
function accountBinding(account) {
  return JSON.stringify([account.id, account.created_at, account.username, account.auth_kind, account.profile,
    account.mail_transport, account.imap_host, account.imap_port, account.imap_tls]);
}
function authorized(ctx, account, capability) {
  const current = db.accountById(account.id);
  if (!listenerState.listening || !current || accountBinding(current) !== accountBinding(account)
    || !auth.recheck(ctx.grant, { accountId: account.id, capability })) throw coded("UNAUTHENTICATED");
}
function normalized(ctx) {
  const spec = catalog.operation(ctx?.operation), params = ctx?.params;
  if (!CHANNELS[ctx?.operation] || !spec || typeof ctx?.requestId !== "string" || !UUID.test(ctx.requestId) || !params || Array.isArray(params)
    || Object.keys(params).some(key => !spec.params.includes(key)) || typeof params.accountId !== "string" || !ID.test(params.accountId)
    || typeof params.messageId !== "string" || !ID.test(params.messageId) || (ctx.operation === "mail.mark_read" && typeof params.isRead !== "boolean")) {
    throw coded("INVALID_REQUEST");
  }
  if (!ctx.grant?.accountIds.includes(params.accountId) || !ctx.grant?.capabilities.includes(spec.caps[0])) throw coded("FORBIDDEN");
  if (!db.isReady()) throw coded("HOST_NOT_READY");
  const account = db.accountById(params.accountId);
  if (!account) throw coded("NOT_FOUND");
  authorized(ctx, account, spec.caps[0]);
  const value = { operation: ctx.operation, accountId: params.accountId, messageId: params.messageId,
    ...(ctx.operation === "mail.mark_read" ? { isRead: params.isRead } : {}) };
  return { account, capability: spec.caps[0], value,
    payloadHash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

function resultOf(receipt) {
  if (receipt.state === "failed") return { state: "failed", errorCode: receipt.errorCode || "UNSUPPORTED_OPERATION", providerConfirmed: false };
  if (!receipt.actionId) return { state: "unknown", providerConfirmed: false };
  const action = db.mailActionById(receipt.actionId);
  if (!action || action.message_id !== receipt.messageId || action.account_id !== receipt.accountId) return { state: "unknown", providerConfirmed: false };
  if (action.generation !== receipt.generation) return { state: "superseded", providerConfirmed: false };
  const state = action.phase === "closed" ? action.receipt : "pending";
  const known = ["pending", "completed", "failed", "unknown", "superseded", "not_attempted"].includes(state) ? state : "unknown";
  return { state: known, providerConfirmed: known === "completed",
    ...(known === "completed" && action.undo_op_id ? { undoOpId: action.undo_op_id } : {}),
    ...(["failed", "not_attempted"].includes(known) ? { errorCode: "OPERATION_NOT_COMPLETED" } : {}),
    ...(action.error ? { warning: known === "completed" ? "The provider confirmed the change; refresh Morrow to reconcile its cache." : "Review this operation in Morrow before starting another request." } : {}) };
}
function response(receipt, replay) {
  const outcome = resultOf(receipt);
  return { data: { receiptId: receipt.receiptId, requestId: receipt.requestId, operation: receipt.operation,
    accountId: receipt.accountId, messageId: receipt.messageId, ...outcome, idempotentReplay: replay },
  meta: { observedAt: new Date().toISOString(), source: "host", contentTrust: catalog.CONTENT_TRUST,
    warnings: outcome.state === "unknown" ? [{ code: "OUTCOME_UNKNOWN", message: "Do not repeat this change with a new request ID. Refresh and review it in Morrow." }] : [] } };
}

// Admission and both durable writes are synchronous. The mail queue cannot
// start between receipt claim and binding; failed persistence never grants the
// queued action authority. Replaying a UUID only observes its original action.
function perform(ctx) {
  const prepared = normalized(ctx), rows = load();
  const requestId = ctx.requestId.toLowerCase();
  const prior = rows.find(row => row.clientId === ctx.grant.clientId && row.requestId === requestId);
  if (prior) {
    if (prior.payloadHash !== prepared.payloadHash) throw coded("INVALID_REQUEST");
    return response(prior, true);
  }
  const row = db.messageById(prepared.value.messageId);
  if (!row || row.account_id !== prepared.account.id) throw coded("NOT_FOUND");
  const receipt = { ...prepared.value, clientId: ctx.grant.clientId, requestId,
    receiptId: crypto.randomUUID(), payloadHash: prepared.payloadHash, state: "claimed", createdAt: new Date().toISOString() };
  rows.push(receipt);
  save(rows);
  let admitted = false;
  const check = () => {
    if (!admitted) throw coded("UNAUTHENTICATED");
    authorized(ctx, prepared.account, prepared.capability);
  };
  const accepted = engine.submitBotAction(CHANNELS[ctx.operation], {
    accountId: prepared.account.id, emailId: row.id, isRead: prepared.value.isRead,
  }, check);
  const pending = accepted?.data?.pending?.[0];
  if (accepted?.success && pending) {
    receipt.state = "accepted"; receipt.actionId = pending.actionId; receipt.generation = pending.generation;
  } else {
    receipt.state = "failed"; receipt.errorCode = "UNSUPPORTED_OPERATION";
  }
  save(rows);
  admitted = true;
  return response(receipt, false);
}

function settingsStatus(limit = 8) {
  try { return { available: true, receipts: load().slice(-limit).reverse().map(row => ({ receiptId: row.receiptId, requestId: row.requestId,
    operation: row.operation, accountId: row.accountId, messageId: row.messageId, createdAt: row.createdAt, ...resultOf(row) })) }; }
  catch { return { available: false, receipts: [] }; }
}

module.exports = { perform, settingsStatus, recentForSettings: limit => settingsStatus(limit).receipts };
