"use strict";

const https = require("https");
const catalog = require("./catalog");
const { API_VERSION, CALL_PATH, ERRORS } = require("./constants");

const MAX_BYTES = 8192;
const TIMEOUT_MS = 5000;
const GATEWAY_TITLE = /^(bad gateway|502 bad gateway|503 service unavailable|504 gateway timeout|service unavailable|gateway timeout)$/i;

function serveHostParts(value) {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!host) return { host: "", port: null, name: "" };
  const match = /^([a-z0-9.-]+):([0-9]{1,5})$/.exec(host);
  if (match) return { host, name: match[1], port: Number(match[2]) };
  if (/^[a-z0-9.-]+$/.test(host)) return { host, name: host, port: null };
  return { host, name: "", port: null };
}

function safeName(name) {
  if (!name || !name.includes(".")) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) return false;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false;
  return /^[a-z0-9.-]+$/.test(name);
}

function safePort(port) {
  return port == null || (Number.isInteger(port) && port >= 1 && port <= 65535);
}

function looksLikeMorrow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.apiVersion !== API_VERSION || value.ok !== false) return false;
  const code = value.error && value.error.code;
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(ERRORS, code)) return false;
  return !!(value.meta && value.meta.source === "host");
}

function cleanTitle(value) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) return "";
  if (/bearer|mmb_v1_|password|secret|token/i.test(text)) return "";
  if (!/^[\p{L}\p{N} .,:;'"()&+/_-]{1,80}$/u.test(text)) return "";
  return text;
}

function extractTitle(body) {
  const match = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(String(body || ""));
  if (!match) return "";
  return match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}

function safeStatus(statusCode) {
  return Number.isInteger(statusCode) ? `HTTP ${statusCode}` : "HTTP response";
}

function safeSnippet(statusCode, title) {
  const status = safeStatus(statusCode);
  const cleaned = cleanTitle(title);
  return cleaned ? `${status} · ${cleaned}` : status;
}

function classifyProbeResponse(input) {
  const statusCode = input && Number.isInteger(input.statusCode) ? input.statusCode : null;
  const body = typeof (input && input.body) === "string" ? input.body : "";
  if (statusCode != null && statusCode >= 300 && statusCode < 400) {
    return { state: "foreign", reason: "", statusCode, snippet: safeStatus(statusCode) };
  }
  const trimmed = body.trim();
  let parsed = null;
  if (trimmed.startsWith("{")) {
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
  }
  if (looksLikeMorrow(parsed)) {
    return { state: "morrow", reason: "", statusCode, snippet: safeStatus(statusCode) };
  }
  const title = extractTitle(body);
  if (title && GATEWAY_TITLE.test(title.replace(/\s+/g, " ").trim())) {
    return { state: "not_checked", reason: "inconclusive", statusCode, snippet: safeSnippet(statusCode, title) };
  }
  if (statusCode != null && statusCode >= 500 && !title && trimmed.length < 200 && !parsed) {
    return { state: "not_checked", reason: "inconclusive", statusCode, snippet: safeStatus(statusCode) };
  }
  return { state: "foreign", reason: "", statusCode, snippet: safeSnippet(statusCode, title) };
}

function defaultRequest(url, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = https.request({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      timeout: options.timeoutMs,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      servername: url.hostname,
      headers: options.headers,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > (options.maxBytes || MAX_BYTES)) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        finish({
          okTransport: true,
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", () => finish({ okTransport: false, reason: "unreachable" }));
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ okTransport: false, reason: "timeout" });
    });
    req.on("error", (error) => {
      const code = error && error.code;
      const tls = typeof code === "string" && (
        code.startsWith("CERT_")
        || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
      );
      finish({ okTransport: false, reason: tls ? "tls" : "unreachable" });
    });
    req.end();
  });
}

async function probeServeHost(serveHost, deps) {
  const raw = typeof serveHost === "string" ? serveHost.trim().toLowerCase() : "";
  const commands = catalog.serveCommands(raw);
  if (!raw) {
    return {
      state: "not_checked",
      reason: "no_host",
      serveHost: "",
      statusCode: null,
      snippet: "",
      endpoint: "",
      commands,
    };
  }
  const parts = serveHostParts(raw);
  let url = null;
  try { url = new URL(`https://${raw}${CALL_PATH}`); } catch { url = null; }
  const expectedPort = parts.port == null ? "" : String(parts.port);
  const portOk = !url || url.port === expectedPort || (parts.port === 443 && url.port === "");
  if (!url || !parts.name || !safeName(parts.name) || !safePort(parts.port) || !portOk
    || url.protocol !== "https:" || url.hostname !== parts.name || url.pathname !== CALL_PATH
    || url.search || url.username || url.password) {
    return {
      state: "not_checked",
      reason: "unsafe",
      serveHost: raw,
      statusCode: null,
      snippet: "",
      endpoint: "",
      commands,
    };
  }
  const request = (deps && typeof deps.request === "function") ? deps.request : defaultRequest;
  const options = {
    method: "GET",
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    rejectUnauthorized: true,
    headers: {
      accept: "application/json, text/html;q=0.1",
      "user-agent": "MorrowBotProbe",
    },
  };
  let transport;
  try {
    transport = await request(url, options);
  } catch {
    transport = { okTransport: false, reason: "unreachable" };
  }
  const endpoint = url.toString();
  if (!transport || transport.okTransport !== true) {
    const reason = transport && (transport.reason === "timeout" || transport.reason === "tls")
      ? transport.reason
      : "unreachable";
    return {
      state: "not_checked",
      reason,
      serveHost: raw,
      statusCode: null,
      snippet: "",
      endpoint,
      commands,
    };
  }
  const classified = classifyProbeResponse(transport);
  return {
    state: classified.state,
    reason: classified.reason || "",
    serveHost: raw,
    statusCode: classified.statusCode,
    snippet: classified.snippet,
    endpoint,
    commands,
  };
}

module.exports = {
  classifyProbeResponse,
  probeServeHost,
};
