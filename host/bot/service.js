"use strict";

const agent = require("../agent");
const auth = require("./auth");
const drafts = require("./drafts");
const reads = require("./reads");
const catalog = require("./catalog");
const send = require("./send");
const {
  API_VERSION,
  CALLS_PER_MINUTE,
  DEFAULT_BODY_BYTES,
  DEFAULT_LIMIT,
  FOLDERS,
  HOST,
  MAX_ACCOUNTS,
  MAX_BODY_BYTES,
  MAX_LIMIT,
  MAX_RESPONSE_BYTES,
  PORT,
  SERVE_CAPABILITY,
  STALE_AFTER_SECONDS,
  SYNC_WINDOW_DAYS,
} = require("./constants");

function coded(code, extra) {
  const error = new Error(code);
  error.code = code;
  error.expose = true;
  if (extra && extra.retryAfterMs) error.retryAfterMs = extra.retryAfterMs;
  return error;
}

function closed(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
}

function accountParam(params) {
  if (!params || !validId(params.accountId)) throw coded("INVALID_REQUEST");
  return params.accountId;
}

function requireAccount(grant, accountId) {
  if (!grant.accountIds.includes(accountId)) throw coded("FORBIDDEN");
  const db = require("../mail/db");
  if (!db.isReady()) throw coded("HOST_NOT_READY");
  // A retained grant and known message/proposal ID do not authorize access to
  // orphaned legacy cache after its account has been disconnected.
  if (!db.accountById(accountId)) throw coded("NOT_FOUND");
}

function metaFor(fresh, warnings, extra) {
  const stale = fresh ? fresh.stale : null;
  const list = (warnings || []).slice();
  if (stale === true && !list.includes("CACHE_STALE")) list.push("CACHE_STALE");
  return {
    observedAt: new Date().toISOString(),
    source: "local_cache",
    stale,
    offline: null,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    lastSuccessfulSyncAt: fresh ? fresh.lastSuccessfulSyncAt : null,
    coverage: extra.coverage,
    truncated: false,
    warnings: list,
    contentTrust: "untrusted_mail_data",
  };
}

function hostMeta() {
  return {
    observedAt: new Date().toISOString(),
    source: "host",
    stale: null,
    offline: null,
  };
}

function fit(envelope) {
  const encode = () => Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (encode() <= MAX_RESPONSE_BYTES) return envelope;
  envelope.meta.truncated = true;
  if (Array.isArray(envelope.meta.warnings) && !envelope.meta.warnings.includes("RESULT_TRUNCATED")) {
    envelope.meta.warnings.push("RESULT_TRUNCATED");
  }
  const items = envelope.data && Array.isArray(envelope.data.items) ? envelope.data.items : null;
  while (items && items.length && encode() > MAX_RESPONSE_BYTES) {
    items.pop();
    envelope.data.moreAvailable = true;
  }
  const body = envelope.data && envelope.data.body;
  let guard = 0;
  while (body && typeof body.text === "string" && body.text && encode() > MAX_RESPONSE_BYTES && guard < 16) {
    const next = Math.floor(Buffer.byteLength(body.text, "utf8") / 2);
    body.text = Buffer.from(body.text, "utf8").subarray(0, Math.max(0, next)).toString("utf8");
    body.truncated = true;
    body.returnedBytes = Buffer.byteLength(body.text, "utf8");
    guard += 1;
  }
  if (encode() > MAX_RESPONSE_BYTES && items) items.splice(0, items.length);
  if (body && encode() > MAX_RESPONSE_BYTES) {
    body.text = "";
    body.truncated = true;
    body.returnedBytes = 0;
  }
  return envelope;
}

function describe(ctx) {
  if (!closed(ctx.params, [])) throw coded("INVALID_REQUEST");
  const allowed = catalog.operations().filter((name) => {
    const spec = catalog.operation(name);
    return spec.caps.every((cap) => ctx.grant.capabilities.includes(cap));
  });
  return {
    data: {
      apiVersion: API_VERSION,
      appVersion: appVersion(),
      installationId: ctx.installationId,
      operations: allowed,
      capabilities: ctx.grant.capabilities.slice(),
      grantExpiry: ctx.grant.expiry,
      semantics: {
        cacheOnlyReads: true,
        sending: ctx.grant.capabilities.includes("mail.send"),
        attachmentBytes: false,
        providerCalls: allowed.includes("mail.send"),
        draftProposals: ctx.grant.capabilities.includes("draft.proposals.create"),
        draftProposalsSend: false,
      },
      bounds: {
        port: PORT,
        bind: HOST,
        serveCapability: SERVE_CAPABILITY,
        funnel: false,
        defaultLimit: DEFAULT_LIMIT,
        maxLimit: MAX_LIMIT,
        defaultBodyBytes: DEFAULT_BODY_BYTES,
        maxBodyBytes: MAX_BODY_BYTES,
        maxAccounts: MAX_ACCOUNTS,
        callsPerMinute: CALLS_PER_MINUTE,
        staleAfterSeconds: STALE_AFTER_SECONDS,
        targetSyncWindowDays: SYNC_WINDOW_DAYS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      },
      readOnlyMailbox: !ctx.grant.capabilities.includes("mail.send"),
    },
    meta: hostMeta(),
  };
}

function appVersion() {
  try {
    const { app } = require("electron");
    if (app && app.getVersion) return app.getVersion();
  } catch { /* tests run outside Electron */ }
  return require("../../package.json").version;
}

function listAccounts(ctx) {
  if (!closed(ctx.params, [])) throw coded("INVALID_REQUEST");
  return {
    data: { accounts: reads.accountsFor(ctx.grant.accountIds) },
    meta: hostMeta(),
  };
}

function listMail(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId", "folder", "limit"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  if (!FOLDERS.includes(params.folder)) throw coded("INVALID_REQUEST");
  const limit = reads.clampLimit(params.limit);
  const listed = reads.listCached(accountId, params.folder, limit);
  const fresh = reads.freshness(listed.folders);
  return {
    data: {
      accountId,
      folder: params.folder,
      items: listed.items,
      moreAvailable: listed.moreAvailable,
      cursor: null,
    },
    meta: metaFor(fresh, listed.warnings, { coverage: reads.coverage(accountId, listed.folders) }),
  };
}

function searchMail(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId", "query", "limit"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  const limit = reads.clampLimit(params.limit);
  const found = reads.searchCached(accountId, params.query, limit);
  const fresh = reads.freshness(found.folders);
  return {
    data: {
      accountId,
      items: found.items,
      moreAvailable: found.moreAvailable,
      cursor: null,
    },
    meta: metaFor(fresh, found.warnings, { coverage: reads.coverage(accountId, found.folders) }),
  };
}

function getMail(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId", "messageId", "maxBodyBytes"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  if (!validId(params.messageId)) throw coded("INVALID_REQUEST");
  const maxBodyBytes = reads.clampBody(params.maxBodyBytes);
  const got = reads.getCached(
    accountId,
    params.messageId,
    maxBodyBytes,
    ctx.grant.capabilities.includes("mail.attachments.read"),
  );
  const fresh = reads.freshness(got.folders);
  return {
    data: { accountId, message: got.message, body: got.body },
    meta: metaFor(fresh, got.warnings, { coverage: reads.coverage(accountId, got.folders) }),
  };
}

function getAttachment(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId", "messageId", "index"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  if (!validId(params.messageId)) throw coded("INVALID_REQUEST");
  if (!Number.isInteger(params.index) || params.index < 0) throw coded("INVALID_REQUEST");
  return {
    data: reads.getAttachment(accountId, params.messageId, params.index),
    meta: {
      ...hostMeta(),
      contentTrust: "untrusted_mail_data",
    },
  };
}

function health(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  const row = reads.health(accountId);
  return {
    data: {
      accountId,
      sync: row.sync,
      auth: row.auth,
      cache: row.cache,
    },
    meta: {
      ...hostMeta(),
      stale: row.freshness.stale,
      offline: null,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      lastSuccessfulSyncAt: row.freshness.lastSuccessfulSyncAt,
      contentTrust: "untrusted_mail_data",
    },
  };
}

function proposals(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId", "limit"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  const limit = reads.clampLimit(params.limit);
  const listed = agent.bridgeListProposals(accountId, {
    limit,
    owns(messageId, ownerId) {
      const db = require("../mail/db");
      const row = db.messageById(messageId);
      return !!(row && row.account_id === ownerId);
    },
  });
  if (listed.error) throw coded(listed.error);
  return {
    data: {
      accountId,
      items: listed.items,
      moreAvailable: listed.more,
      coverage: listed.coverage,
    },
    meta: {
      ...hostMeta(),
      warnings: [],
      contentTrust: "untrusted_mail_data",
    },
  };
}

function submitDraft(ctx) {
  const params = ctx.params;
  const keys = ["accountId", "idempotencyKey", "to", "cc", "bcc", "subject", "bodyText", "inReplyToMessageId"];
  if (!closed(params, keys)) throw coded("INVALID_REQUEST");
  if (!Object.prototype.hasOwnProperty.call(params, "to") || !Object.prototype.hasOwnProperty.call(params, "subject")) {
    throw coded("INVALID_REQUEST");
  }
  if (!Object.prototype.hasOwnProperty.call(params, "bodyText") || !Object.prototype.hasOwnProperty.call(params, "idempotencyKey")) {
    throw coded("INVALID_REQUEST");
  }
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  const normalized = drafts.normalizeSubmission(params);
  if (!normalized) throw coded("INVALID_REQUEST");
  if (normalized.inReplyToMessageId) {
    const db = require("../mail/db");
    if (!db.isReady()) throw coded("HOST_NOT_READY");
    const row = db.messageById(normalized.inReplyToMessageId);
    if (!row || row.account_id !== accountId) throw coded("NOT_FOUND");
  }
  const saved = drafts.submit({ ...normalized, accountId, clientId: ctx.grant.clientId });
  return {
    data: {
      ...saved.proposal,
      idempotentReplay: saved.replay,
    },
    meta: {
      ...hostMeta(),
      warnings: [],
      contentTrust: "untrusted_mail_data",
    },
  };
}

async function sendMail(ctx) {
  return send.perform(ctx);
}

function listDrafts(ctx) {
  const params = ctx.params;
  if (!closed(params, ["accountId", "limit"])) throw coded("INVALID_REQUEST");
  const accountId = accountParam(params);
  requireAccount(ctx.grant, accountId);
  const limit = reads.clampLimit(params.limit);
  const listed = drafts.listForClient(ctx.grant.clientId, accountId, limit);
  return {
    data: {
      accountId,
      items: listed.items,
      moreAvailable: listed.more,
      sends: false,
      providerDraft: false,
    },
    meta: {
      ...hostMeta(),
      warnings: [],
      contentTrust: "untrusted_mail_data",
    },
  };
}

const HANDLERS = {
  "bridge.describe": describe,
  "accounts.list": listAccounts,
  "mail.list_cached": listMail,
  "mail.search_cached": searchMail,
  "mail.get_cached": getMail,
  "mail.attachment.get": getAttachment,
  "health.get": health,
  "agent.proposals.list": proposals,
  "draft.proposals.submit": submitDraft,
  "draft.proposals.list": listDrafts,
  "mail.send": sendMail,
};

const catalogNames = catalog.operations();
if (catalogNames.length !== Object.keys(HANDLERS).length || catalogNames.some((name) => typeof HANDLERS[name] !== "function")) {
  throw new Error("Bot operation handlers do not match the catalog.");
}

async function execute(ctx) {
  const spec = ctx && catalog.operation(ctx.operation);
  if (!spec) throw coded("UNKNOWN_OPERATION");
  if (spec.caps.some((cap) => !ctx.grant.capabilities.includes(cap))) throw coded("FORBIDDEN");
  const handler = HANDLERS[ctx.operation];
  const result = await handler(ctx);
  return fit({
    apiVersion: API_VERSION,
    requestId: ctx.requestId,
    installationId: ctx.installationId,
    ok: true,
    data: result.data,
    meta: result.meta,
  });
}

function kindFor(operation) {
  const spec = catalog.operation(operation);
  return spec && spec.kind ? spec.kind : "call";
}

module.exports = {
  execute,
  kindFor,
  HANDLERS,
};
