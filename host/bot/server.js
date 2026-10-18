"use strict";

const http = require("http");
const auth = require("./auth");
const audit = require("./audit");
const budget = require("./budget");
const { parseStrict } = require("./json");
const service = require("./service");
const {
  API_VERSION,
  CALL_PATH,
  ERRORS,
  HOST,
  MAX_AUTH_HEADER,
  MAX_CAP_HEADER,
  MAX_DEPTH,
  MAX_HEADER_BYTES,
  MAX_REQUEST_BYTES,
  PORT,
  SERVE_CAPABILITY,
} = require("./constants");

let httpServer = null;
let boundPort = PORT;
let beforeRelease = async () => {};
const state = { listening: false, error: "", host: HOST, port: PORT };

function status() {
  return {
    listening: state.listening,
    error: state.error,
    host: HOST,
    port: state.listening ? boundPort : PORT,
    address: state.listening ? HOST : "",
  };
}

function setBeforeRelease(fn) {
  beforeRelease = typeof fn === "function" ? fn : async () => {};
}

function observed() {
  return new Date().toISOString();
}

function failure({ statusCode, code, requestId, installationId, retryAfterMs }) {
  const spec = ERRORS[code] || ERRORS.INTERNAL;
  const error = {
    code: spec === ERRORS[code] ? code : "INTERNAL",
    message: spec.message,
    retryable: spec.retryable,
  };
  if (spec.action) error.action = spec.action;
  if (retryAfterMs) error.retryAfterMs = retryAfterMs;
  return {
    statusCode: statusCode || spec.status,
    envelope: {
      apiVersion: API_VERSION,
      requestId: requestId || null,
      installationId: installationId || null,
      ok: false,
      error,
      meta: { observedAt: observed(), source: "host" },
    },
  };
}

function write(res, payload, bytesOut) {
  if (res.writableEnded || res.destroyed) return 0;
  const body = Buffer.from(JSON.stringify(payload.envelope), "utf8");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(body.length),
  };
  if (payload.envelope.error && payload.envelope.error.retryAfterMs) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(payload.envelope.error.retryAfterMs / 1000)));
  }
  res.writeHead(payload.statusCode, headers);
  res.end(body);
  return bytesOut == null ? body.length : body.length;
}

function headerValues(req, name) {
  const want = name.toLowerCase();
  const values = [];
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === want) values.push(String(raw[i + 1]));
  }
  return values;
}

function headerSize(req) {
  const raw = req.rawHeaders || [];
  let n = 0;
  for (const part of raw) n += Buffer.byteLength(String(part));
  return n;
}

function allowedHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (host === `127.0.0.1:${boundPort}` || host === "127.0.0.1") return true;
  const serve = auth.serveHost();
  return !!serve && host === serve;
}

function markerOk(value) {
  if (typeof value !== "string" || value.length > MAX_CAP_HEADER || /[^\x20-\x7e]/.test(value)) return false;
  let parsed;
  try { parsed = parseStrict(value, 4); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const rows = parsed[SERVE_CAPABILITY];
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const keys = Object.keys(row);
  return keys.length === 1 && keys[0] === "readBridge" && row.readBridge === true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        if (!failed) {
          failed = true;
          reject(Object.assign(new Error("REQUEST_TOO_LARGE"), { code: "REQUEST_TOO_LARGE", expose: true }));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      if (!failed) reject(Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST", expose: true }));
    });
  });
}

function accountFrom(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const id = params.accountId;
  return typeof id === "string" && id.length <= 120 ? id : "";
}

async function handle(req, res) {
  const started = Date.now();
  let requestId = null;
  let installationId = null;
  let clientId = "";
  let operation = "";
  let accountId = "";
  let admitted = null;
  const finish = (payload, auditCode) => {
    if (!auth.isEnabled() && payload.envelope && payload.envelope.ok) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    const bytes = write(res, payload);
    audit.record({
      at: observed(),
      clientId,
      operation,
      code: auditCode || (payload.envelope.ok ? "ok" : payload.envelope.error.code),
      requestId: requestId || "",
      durationMs: Date.now() - started,
      bytes,
      accountId: payload.envelope.ok ? accountId : accountId,
    });
    if (payload.envelope.ok && clientId) {
      budget.commitBytes(clientId, bytes);
      auth.recordUse(clientId, bytes);
    }
  };
  try {
    if (headerSize(req) > MAX_HEADER_BYTES) {
      finish(failure({ code: "REQUEST_TOO_LARGE" }));
      return;
    }
    if (req.headers.origin) {
      finish(failure({ statusCode: 403, code: "FORBIDDEN" }));
      return;
    }
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); } catch {
      finish(failure({ statusCode: 400, code: "INVALID_REQUEST" }));
      return;
    }
    if (url.pathname !== CALL_PATH) {
      finish(failure({ statusCode: 404, code: "INVALID_REQUEST" }));
      return;
    }
    if (url.search) {
      finish(failure({ statusCode: 400, code: "INVALID_REQUEST" }));
      return;
    }
    if (req.method !== "POST") {
      finish(failure({ statusCode: 405, code: "INVALID_REQUEST" }));
      return;
    }
    if (!allowedHost(req.headers.host)) {
      finish(failure({ statusCode: 403, code: "FORBIDDEN" }));
      return;
    }
    const type = String(req.headers["content-type"] || "").toLowerCase().replace(/\s+/g, "");
    if (type !== "application/json" && type !== "application/json;charset=utf-8") {
      finish(failure({ statusCode: 415, code: "INVALID_REQUEST" }));
      return;
    }
    if (req.headers["content-encoding"]) {
      finish(failure({ statusCode: 400, code: "INVALID_REQUEST" }));
      return;
    }
    const accept = String(req.headers.accept || "");
    if (!accept.split(",").some((part) => part.trim().toLowerCase().startsWith("application/json"))) {
      finish(failure({ statusCode: 400, code: "INVALID_REQUEST" }));
      return;
    }
    const authz = headerValues(req, "authorization");
    if (authz.length !== 1 || authz[0].length > MAX_AUTH_HEADER) {
      finish(failure({ code: "UNAUTHENTICATED" }));
      return;
    }
    const principal = auth.authenticate(authz[0]);
    if (!principal) {
      finish(failure({ code: "UNAUTHENTICATED" }));
      return;
    }
    clientId = principal.clientId;
    installationId = principal.installationId;
    const caps = headerValues(req, "tailscale-app-capabilities");
    if (caps.length !== 1 || !markerOk(caps[0])) {
      finish(failure({ code: "FORBIDDEN", installationId }));
      return;
    }
    const body = await readBody(req);
    const text = body.toString("utf8");
    if (Buffer.compare(body, Buffer.from(text, "utf8")) !== 0) {
      finish(failure({ code: "INVALID_REQUEST", installationId }));
      return;
    }
    let parsed;
    try { parsed = parseStrict(text, MAX_DEPTH); } catch {
      finish(failure({ code: "INVALID_REQUEST", installationId }));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      finish(failure({ code: "INVALID_REQUEST", installationId }));
      return;
    }
    const keys = Object.keys(parsed);
    const expected = ["apiVersion", "requestId", "installationId", "operation", "params"];
    if (keys.length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key))) {
      finish(failure({ code: "INVALID_REQUEST", installationId }));
      return;
    }
    if (typeof parsed.requestId === "string" && /^[0-9a-f-]{36}$/i.test(parsed.requestId)) requestId = parsed.requestId;
    if (parsed.apiVersion !== API_VERSION) {
      finish(failure({ code: "UNSUPPORTED_VERSION", requestId, installationId }));
      return;
    }
    const claimed = typeof parsed.installationId === "string" ? parsed.installationId.toLowerCase() : "";
    if (claimed !== String(principal.installationId).toLowerCase()) {
      finish(failure({ code: "INSTALLATION_MISMATCH", requestId, installationId }));
      return;
    }
    if (typeof parsed.operation !== "string") {
      finish(failure({ code: "UNKNOWN_OPERATION", requestId, installationId }));
      return;
    }
    // Body upload yields to Settings. Revalidate before dispatch, since draft
    // proposals persist locally even if the eventual response is rejected.
    if (!auth.recheck(principal)) {
      finish(failure({ code: "UNAUTHENTICATED", requestId, installationId: null }));
      return;
    }
    operation = parsed.operation;
    accountId = accountFrom(parsed.params);
    const kind = service.kindFor(operation);
    admitted = budget.admit({ clientId, kind, bytesToday: principal.bytesToday });
    if (!admitted.ok) {
      const retryAfterMs = admitted.retryAfterMs;
      admitted = null;
      finish(failure({
        code: "RATE_LIMITED",
        requestId,
        installationId,
        retryAfterMs,
      }));
      return;
    }
    try {
      const envelope = service.execute({
        grant: principal,
        installationId: principal.installationId,
        requestId,
        operation,
        params: parsed.params,
      });
      await beforeRelease();
      if (!auth.isEnabled()) {
        if (!res.writableEnded) res.destroy();
        audit.record({
          at: observed(),
          clientId,
          operation,
          code: "disabled",
          requestId: requestId || "",
          durationMs: Date.now() - started,
          bytes: 0,
          accountId,
        });
        return;
      }
      if (!auth.recheck(principal)) {
        finish(failure({ code: "UNAUTHENTICATED", requestId, installationId: null }));
        return;
      }
      finish({ statusCode: 200, envelope });
    } finally {
      if (admitted) budget.leave(clientId, admitted.kind || kind);
      admitted = null;
    }
  } catch (error) {
    if (admitted) budget.leave(clientId, admitted.kind || "call");
    const code = error && error.expose && ERRORS[error.code] ? error.code : "INTERNAL";
    finish(failure({
      code,
      requestId,
      installationId: code === "UNAUTHENTICATED" ? null : installationId,
      retryAfterMs: error && error.retryAfterMs,
    }));
  }
}

function start() {
  if (httpServer && state.listening) return Promise.resolve(status());
  if (httpServer) return Promise.resolve(status());
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.writableEnded) {
        try { res.destroy(); } catch { /* already closed */ }
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 2000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  httpServer = server;
  return new Promise((resolve) => {
    const fail = (error) => {
      state.listening = false;
      state.error = error && error.code === "EADDRINUSE" ? "port_in_use" : "listen_failed";
      state.port = PORT;
      httpServer = null;
      server.close(() => {});
      resolve(status());
    };
    server.once("error", fail);
    server.listen(PORT, HOST, () => {
      server.removeListener("error", fail);
      const addr = server.address();
      if (!addr || addr.address !== HOST) {
        state.listening = false;
        state.error = "bad_bind";
        server.close();
        httpServer = null;
        resolve(status());
        return;
      }
      boundPort = addr.port;
      state.listening = true;
      state.error = "";
      state.port = addr.port;
      resolve(status());
    });
  });
}

function stop() {
  const current = httpServer;
  httpServer = null;
  state.listening = false;
  state.error = "";
  if (!current) return Promise.resolve(status());
  return new Promise((resolve) => {
    try { if (current.closeAllConnections) current.closeAllConnections(); } catch { /* node without the helper */ }
    current.close(() => resolve(status()));
  });
}

async function startIfEnabled() {
  if (!auth.isEnabled()) {
    await stop();
    state.error = "";
    return status();
  }
  return start();
}

module.exports = {
  start,
  stop,
  startIfEnabled,
  status,
  setBeforeRelease,
  handle,
};
