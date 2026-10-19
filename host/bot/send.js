"use strict";

const crypto = require("crypto");
const fs = require("fs");
const composeIdentity = require("../mail/compose-identity");
const db = require("../mail/db");
const engine = require("../mail/engine");
const catalog = require("./catalog");
const { addressList } = require("./text");
const { sendReceiptPath, writeDurable } = require("./store");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIVE = new Map();
let chain = Promise.resolve();

function coded(code, extra) {
  const error = new Error(code);
  error.code = code;
  error.expose = true;
  if (extra && extra.auditId) error.auditId = extra.auditId;
  if (extra && extra.state) error.state = extra.state;
  if (extra && extra.messageId) error.messageId = extra.messageId;
  return error;
}

function closed(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function enqueue(work) {
  const run = chain.then(work, work);
  chain = run.then(() => {}, () => {});
  return run;
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify({
    accountId: value.accountId,
    fromAddress: value.fromAddress,
    to: value.to,
    cc: value.cc,
    bcc: value.bcc,
    subject: value.subject,
    bodyText: value.bodyText,
    inReplyToMessageId: value.inReplyToMessageId || "",
  })).digest("hex");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n|\n|\r/g, "<br>");
}

function messageIdFor(email) {
  const domain = String(email || "localhost").split("@")[1] || "localhost";
  return `<${crypto.randomBytes(12).toString("hex")}@${domain}>`;
}

function loadReceipts() {
  const file = sendReceiptPath();
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw coded("INTERNAL");
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.receipts)) throw coded("INTERNAL");
  return parsed.receipts;
}

function saveReceipts(rows) {
  writeDurable(sendReceiptPath(), `${JSON.stringify({ version: 1, receipts: rows })}\n`);
}

function sameUtcDay(iso, now) {
  const when = new Date(iso);
  const current = new Date(now);
  return Number.isFinite(when.getTime())
    && when.getUTCFullYear() === current.getUTCFullYear()
    && when.getUTCMonth() === current.getUTCMonth()
    && when.getUTCDate() === current.getUTCDate();
}

function overBudget(rows, clientId, now) {
  const spec = catalog.operation("mail.send").budgets;
  const minute = Math.floor(now / 60000);
  let grantMinute = 0;
  let grantDay = 0;
  let installationDay = 0;
  for (const row of rows) {
    const claimed = Date.parse(row.claimedAt);
    if (!Number.isFinite(claimed)) continue;
    if (sameUtcDay(row.claimedAt, now)) {
      installationDay += 1;
      if (row.clientId === clientId) grantDay += 1;
    }
    if (row.clientId === clientId && Math.floor(claimed / 60000) === minute) grantMinute += 1;
  }
  return grantMinute >= spec.perGrantPerMinute
    || grantDay >= spec.perGrantPerDay
    || installationDay >= spec.perInstallationPerDay;
}

function success(receipt, replay) {
  return {
    data: {
      auditId: receipt.auditId,
      state: receipt.state,
      messageId: receipt.messageId,
      recipientSummary: receipt.recipients || { to: [], cc: [], bcc: [] },
      idempotentReplay: replay,
    },
    meta: {
      observedAt: new Date().toISOString(),
      source: "host",
      stale: null,
      offline: null,
      warnings: [],
      contentTrust: catalog.CONTENT_TRUST,
    },
  };
}

function publicReceipt(row) {
  return {
    auditId: row.auditId,
    state: row.state,
    accountId: row.accountId,
    recipientSummary: row.recipients,
    subject: row.subject,
    claimedAt: row.claimedAt,
    finishedAt: row.finishedAt || null,
  };
}

function recentForSettings(limit = 8) {
  let rows = [];
  try { rows = loadReceipts(); } catch { return []; }
  return rows.slice(-limit).reverse().map(publicReceipt);
}

function decideReplay(receipt, payloadHash) {
  if (!receipt) return { effect: "claim" };
  if (receipt.payloadHash !== payloadHash) return { effect: "reject_request", code: "INVALID_REQUEST" };
  if (receipt.state === "submitted") return { effect: "replay", outcome: "submitted" };
  if (receipt.state === "rejected") return { effect: "replay", outcome: "rejected" };
  if (receipt.state === "claimed") return { effect: "replay", outcome: "unknown" };
  return { effect: "reject_request", code: "INVALID_REQUEST" };
}

async function prepare(ctx) {
  if (!ctx || typeof ctx.requestId !== "string" || !UUID.test(ctx.requestId)) {
    throw coded("INVALID_REQUEST");
  }
  const params = ctx.params;
  const keys = ["accountId", "fromAddress", "to", "cc", "bcc", "subject", "bodyText", "inReplyToMessageId"];
  if (!closed(params, keys)) throw coded("INVALID_REQUEST");
  if (!Object.prototype.hasOwnProperty.call(params, "to")
    || !Object.prototype.hasOwnProperty.call(params, "subject")
    || !Object.prototype.hasOwnProperty.call(params, "bodyText")) {
    throw coded("INVALID_REQUEST");
  }
  if (typeof params.accountId !== "string" || !ctx.grant.accountIds.includes(params.accountId)) {
    throw coded("FORBIDDEN");
  }
  const account = db.accountById(params.accountId);
  if (!account) throw coded("NOT_FOUND");
  let fromAddress;
  try {
    fromAddress = await composeIdentity.sendingFrom(account, params.fromAddress);
  } catch {
    throw coded("INVALID_REQUEST");
  }
  const fresh = db.accountById(account.id);
  if (!fresh) throw coded("NOT_FOUND");
  const to = addressList(params.to, false);
  const cc = addressList(params.cc || [], true);
  const bcc = addressList(params.bcc || [], true);
  if (!to || !cc || !bcc || to.length + cc.length + bcc.length > 50) throw coded("INVALID_REQUEST");
  if (typeof params.subject !== "string" || /[\r\n\u0000]/.test(params.subject) || Buffer.byteLength(params.subject, "utf8") > 512) {
    throw coded("INVALID_REQUEST");
  }
  if (typeof params.bodyText !== "string" || Buffer.byteLength(params.bodyText, "utf8") > 32 * 1024) {
    throw coded("INVALID_REQUEST");
  }
  let inReplyToMessageId = "";
  let inReplyToHeader = "";
  if (params.inReplyToMessageId != null && params.inReplyToMessageId !== "") {
    if (typeof params.inReplyToMessageId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(params.inReplyToMessageId)) {
      throw coded("INVALID_REQUEST");
    }
    const row = db.messageById(params.inReplyToMessageId);
    if (!row || row.account_id !== params.accountId || !row.rfc_message_id) throw coded("INVALID_REQUEST");
    inReplyToMessageId = params.inReplyToMessageId;
    inReplyToHeader = row.rfc_message_id;
  }
  const normalized = {
    accountId: params.accountId,
    fromAddress,
    to,
    cc,
    bcc,
    subject: params.subject,
    bodyText: params.bodyText,
    inReplyToMessageId,
  };
  return {
    ...normalized,
    hash: hashPayload(normalized),
    requestId: ctx.requestId,
    clientId: ctx.grant.clientId,
    account: fresh,
    inReplyToHeader,
    options: {
      from: fromAddress,
      to,
      cc,
      bcc,
      subject: params.subject,
      text: params.bodyText,
      html: escapeHtml(params.bodyText),
      inReplyTo: inReplyToHeader || undefined,
    },
  };
}

function claimOrReplay(prepared) {
  const rows = loadReceipts();
  const existing = rows.find((row) => row.clientId === prepared.clientId && row.requestId === prepared.requestId);
  const decision = decideReplay(existing, prepared.hash);
  if (decision.effect === "reject_request") {
    throw coded(decision.code || "INVALID_REQUEST", existing ? { auditId: existing.auditId } : undefined);
  }
  if (decision.effect === "replay" && decision.outcome === "submitted") {
    return { done: true, value: success(existing, true) };
  }
  if (decision.effect === "replay" && decision.outcome === "rejected") {
    throw coded("SEND_REJECTED", {
      auditId: existing.auditId,
      state: "rejected",
      messageId: existing.messageId,
    });
  }
  if (decision.effect === "replay") {
    throw coded("SEND_OUTCOME_UNKNOWN", {
      auditId: existing.auditId,
      state: "claimed",
      messageId: existing.messageId,
    });
  }
  if (overBudget(rows, prepared.clientId, Date.now())) throw coded("RATE_LIMITED");
  const receipt = {
    auditId: crypto.randomUUID(),
    clientId: prepared.clientId,
    accountId: prepared.accountId,
    requestId: prepared.requestId,
    state: "claimed",
    payloadHash: prepared.hash,
    messageId: messageIdFor(prepared.fromAddress),
    fromAddress: prepared.fromAddress,
    recipients: { to: prepared.to, cc: prepared.cc, bcc: prepared.bcc },
    subject: prepared.subject,
    claimedAt: new Date().toISOString(),
    finishedAt: null,
  };
  rows.push(receipt);
  saveReceipts(rows);
  return { done: false, receipt };
}

function replaceReceipt(next) {
  const rows = loadReceipts();
  const index = rows.findIndex((row) => row.auditId === next.auditId);
  if (index < 0) throw coded("INTERNAL");
  rows[index] = next;
  saveReceipts(rows);
}

async function finishSend(prepared, receipt) {
  const smtp = await engine.submitSmtp({
    account: prepared.account,
    options: prepared.options,
    messageId: receipt.messageId,
    threadId: null,
    inReplyTo: prepared.inReplyToHeader || null,
    files: [],
  });
  if (smtp.kind === "accepted") {
    const next = {
      ...receipt,
      state: "submitted",
      messageId: smtp.messageId || receipt.messageId,
      finishedAt: new Date().toISOString(),
    };
    try {
      await enqueue(() => replaceReceipt(next));
    } catch {
      throw coded("SEND_OUTCOME_UNKNOWN", {
        auditId: receipt.auditId,
        state: "claimed",
        messageId: receipt.messageId,
      });
    }
    engine.noteBotSent({
      accountId: next.accountId,
      messageId: next.messageId,
      fromAddress: next.fromAddress,
      to: prepared.to,
      cc: prepared.cc,
      bcc: prepared.bcc,
      subject: next.subject,
      text: prepared.bodyText,
      html: prepared.options.html,
      inReplyTo: prepared.inReplyToHeader || null,
    });
    return success(next, false);
  }
  if (smtp.kind === "rejected") {
    const next = { ...receipt, state: "rejected", finishedAt: new Date().toISOString(), refusal: smtp.refusal || "" };
    try {
      await enqueue(() => replaceReceipt(next));
    } catch {
      throw coded("SEND_OUTCOME_UNKNOWN", {
        auditId: receipt.auditId,
        state: "claimed",
        messageId: receipt.messageId,
      });
    }
    throw coded("SEND_REJECTED", {
      auditId: receipt.auditId,
      state: "rejected",
      messageId: receipt.messageId,
    });
  }
  throw coded("SEND_OUTCOME_UNKNOWN", {
    auditId: receipt.auditId,
    state: "claimed",
    messageId: receipt.messageId,
  });
}

async function run(prepared) {
  const decision = await enqueue(() => claimOrReplay(prepared));
  if (decision.done) return decision.value;
  return finishSend(prepared, decision.receipt);
}

function startOrJoin(prepared) {
  const key = `${prepared.clientId}\0${prepared.requestId}`;
  const current = LIVE.get(key);
  if (current) {
    if (current.hash !== prepared.hash) throw coded("INVALID_REQUEST");
    return current.promise;
  }
  const promise = run(prepared);
  LIVE.set(key, { hash: prepared.hash, promise });
  return promise.finally(() => {
    if (LIVE.get(key) && LIVE.get(key).promise === promise) LIVE.delete(key);
  });
}

async function perform(ctx) {
  const prepared = await prepare(ctx);
  return startOrJoin(prepared);
}

function setSmtpForTest(fn) {
  engine.setSmtpSenderForTest(fn);
}

function resetForTest() {
  LIVE.clear();
}

module.exports = {
  perform,
  recentForSettings,
  hashPayload,
  setSmtpForTest,
  resetForTest,
};
