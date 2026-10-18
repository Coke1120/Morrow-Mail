#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { API_VERSION, CALL_PATH, HOST, PORT, SERVE_CAPABILITY } = require("../host/bot/constants");

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

let url;
try {
  url = new URL(endpoint);
} catch {
  fail("The endpoint is not a URL.", 2);
}
if (url.protocol !== "http:") fail("This client speaks HTTP to the loopback bridge.", 2);
if (url.pathname !== CALL_PATH || url.search) fail("The endpoint path is not the bridge call path.", 2);

const body = JSON.stringify({
  apiVersion: API_VERSION,
  requestId: crypto.randomUUID(),
  installationId: installation,
  operation,
  params,
});
const marker = JSON.stringify({ [SERVE_CAPABILITY]: [{ readBridge: true }] });
const req = http.request({
  hostname: url.hostname,
  port: url.port || 80,
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
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { process.exit(1); }
    process.exit(parsed && parsed.ok === true ? 0 : 1);
  });
});
req.on("error", () => fail("The bridge did not answer.", 1));
req.end(body);
