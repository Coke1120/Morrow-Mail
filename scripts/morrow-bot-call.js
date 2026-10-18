#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { API_VERSION, CALL_PATH, HOST, PORT, SERVE_CAPABILITY, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = require("../host/bot/constants");

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("--token")) fail("Pass the secret with --token-file, not --token.", 2);

function flag(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

const endpoint = flag("--endpoint") || `http://${HOST}:${PORT}${CALL_PATH}`;
const tokenFile = flag("--token-file");
const installation = flag("--installation");
const operation = flag("--operation");
const paramsFile = flag("--params-file");
if (!tokenFile || !installation || !operation) {
  fail("Required: --token-file --installation --operation", 2);
}

let url;
try {
  url = new URL(endpoint);
} catch {
  fail("The endpoint is not a URL.", 2);
}
if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === HOST)) {
  fail("Use HTTPS for Serve, or HTTP on 127.0.0.1 for a local bridge.", 2);
}
if (url.username || url.password || url.hash || url.pathname !== CALL_PATH || url.search) {
  fail("Use the exact bridge endpoint without credentials, query, or fragment.", 2);
}

let token = "";
try {
  token = fs.readFileSync(tokenFile, "utf8").trim();
} catch {
  fail("Could not read the token file.", 2);
}
if (!token || token.includes("\n") || token.includes("\r")) fail("The token file must hold one line.", 2);

let params = {};
if (paramsFile) {
  try {
    params = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
  } catch {
    fail("Could not read the params file.", 2);
  }
}

const body = JSON.stringify({
  apiVersion: API_VERSION,
  requestId: crypto.randomUUID(),
  installationId: installation,
  operation,
  params,
});
if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) fail("The request is too large.", 2);
const marker = JSON.stringify({ [SERVE_CAPABILITY]: [{ readBridge: true }] });
const transport = url.protocol === "https:" ? https : http;
const req = transport.request({
  hostname: url.hostname,
  port: url.port || (url.protocol === "https:" ? 443 : 80),
  path: url.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json; charset=utf-8",
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "tailscale-app-capabilities": marker,
    "content-length": Buffer.byteLength(body),
  },
}, (res) => {
  // Node's HTTPS defaults verify the certificate and hostname. Do not follow
  // redirects with a bearer credential, or print arbitrary proxy error pages.
  if (res.statusCode >= 300 && res.statusCode < 400) fail("The bridge endpoint redirected. Check the paired endpoint.", 1);
  const chunks = [];
  let bytes = 0;
  res.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      res.destroy();
      fail("The bridge response is too large.", 1);
    }
    chunks.push(chunk);
  });
  res.on("error", () => fail("The bridge response was interrupted.", 1));
  res.on("aborted", () => fail("The bridge response was interrupted.", 1));
  res.on("end", () => {
    clearTimeout(deadline);
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { fail("The endpoint did not return a bridge response.", 1); }
    if (!parsed || parsed.apiVersion !== API_VERSION || typeof parsed.ok !== "boolean") {
      fail("The endpoint did not return a bridge response.", 1);
    }
    if (parsed.ok && (res.statusCode !== 200 || parsed.installationId !== installation)) {
      fail("The bridge response does not match the paired installation.", 1);
    }
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
    process.exit(parsed.ok ? 0 : 1);
  });
});
const deadline = setTimeout(() => req.destroy(new Error("deadline")), 5000);
req.on("error", () => {
  clearTimeout(deadline);
  fail("The bridge did not answer securely within the call deadline.", 1);
});
req.end(body);
