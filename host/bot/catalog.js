"use strict";

const {
  BODIES_PER_MINUTE,
  BYTES_PER_DAY,
  BYTES_PER_MINUTE,
  CALL_PATH,
  CALLS_PER_MINUTE,
  DRAFTS_PER_DAY,
  HOST,
  MAX_REQUEST_BYTES,
  PORT,
  SEARCHES_PER_MINUTE,
  SERVE_CAPABILITY,
} = require("./constants");

const CONTENT_TRUST = "untrusted_mail_data";
const ORDINARY_BYTES = MAX_REQUEST_BYTES;
const LARGE_BYTES = 48 * 1024;
const ORDINARY_TIMEOUT_MS = 5000;

const ROWS = [
  {
    operation: "bridge.describe",
    caps: [],
    params: [],
    kind: "call",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "accounts.list",
    caps: ["accounts.read"],
    params: [],
    kind: "call",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "mail.list_cached",
    caps: ["mail.headers.read"],
    params: ["accountId", "folder", "limit"],
    kind: "call",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "mail.search_cached",
    caps: ["mail.headers.read"],
    params: ["accountId", "query", "limit"],
    kind: "search",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "mail.get_cached",
    caps: ["mail.headers.read", "mail.bodies.read"],
    whenGranted: { attachmentNames: "mail.attachments.read" },
    params: ["accountId", "messageId", "maxBodyBytes"],
    kind: "body",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "health.get",
    caps: ["health.read"],
    params: ["accountId"],
    kind: "call",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "agent.proposals.list",
    caps: ["agent.proposals.read", "mail.headers.read"],
    params: ["accountId", "limit"],
    kind: "call",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "draft.proposals.submit",
    caps: ["draft.proposals.create"],
    params: ["accountId", "idempotencyKey", "to", "cc", "bcc", "subject", "bodyText", "inReplyToMessageId"],
    kind: "draft",
    requestBytes: LARGE_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
  {
    operation: "draft.proposals.list",
    caps: ["draft.proposals.create"],
    params: ["accountId", "limit"],
    kind: "call",
    requestBytes: ORDINARY_BYTES,
    responseTimeoutMs: ORDINARY_TIMEOUT_MS,
    requestId: "echo",
    budgets: null,
  },
];

const DEFAULT_CAPABILITIES = [
  "accounts.read",
  "mail.headers.read",
  "health.read",
  "agent.proposals.read",
];

function operations() {
  return ROWS.map((row) => row.operation);
}

function operation(name) {
  return ROWS.find((row) => row.operation === name) || null;
}

function capabilities() {
  const set = new Set();
  for (const row of ROWS) {
    for (const cap of row.caps) set.add(cap);
    if (row.whenGranted) {
      for (const value of Object.values(row.whenGranted)) {
        if (typeof value === "string") set.add(value);
      }
    }
  }
  return [...set].sort();
}

const CAPABILITIES = capabilities();

if (DEFAULT_CAPABILITIES.some((cap) => cap === "mail.send" || cap === "mail.attachments.read")) {
  throw new Error("Default bot capabilities cannot send mail or read attachment names.");
}
if (DEFAULT_CAPABILITIES.some((cap) => !CAPABILITIES.includes(cap))) {
  throw new Error("Default bot capabilities are not in the catalog.");
}

function endpoints(serveHost) {
  const host = typeof serveHost === "string" ? serveHost.trim() : "";
  return {
    local: `http://${HOST}:${PORT}${CALL_PATH}`,
    serve: host ? `https://${host}${CALL_PATH}` : null,
  };
}

function markerJson() {
  return JSON.stringify({ [SERVE_CAPABILITY]: [{ readBridge: true }] });
}

function project(row) {
  return {
    operation: row.operation,
    caps: row.caps.slice(),
    params: row.params.slice(),
    kind: row.kind,
    requestBytes: row.requestBytes,
    responseTimeoutMs: row.responseTimeoutMs,
    requestId: row.requestId,
    budgets: row.budgets,
  };
}

function factsFrom(view, target) {
  const readBudgets = {
    callsPerMinute: CALLS_PER_MINUTE,
    searchesPerMinute: SEARCHES_PER_MINUTE,
    bodiesPerMinute: BODIES_PER_MINUTE,
    bytesPerMinute: BYTES_PER_MINUTE,
    bytesPerDay: BYTES_PER_DAY,
    draftsPerDay: DRAFTS_PER_DAY,
  };
  return {
    installationId: view && view.installationId,
    endpoints: endpoints(view && view.serveHost),
    target: target === "serve" ? "serve" : "local",
    markerJson: markerJson(),
    contentTrust: CONTENT_TRUST,
    operations: ROWS.map(project),
    readBudgets,
    callsPerMinute: readBudgets.callsPerMinute,
  };
}

function requestBytes(name) {
  const row = operation(name);
  return row ? row.requestBytes : MAX_REQUEST_BYTES;
}

function responseTimeoutMs(name) {
  const row = operation(name);
  return row ? row.responseTimeoutMs : ORDINARY_TIMEOUT_MS;
}

module.exports = {
  CONTENT_TRUST,
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  operations,
  operation,
  capabilities,
  endpoints,
  markerJson,
  factsFrom,
  requestBytes,
  responseTimeoutMs,
};
