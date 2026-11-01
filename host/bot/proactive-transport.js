"use strict";

const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const { webhook } = require("./proactive-config");

const MAX_BYTES = 128 * 1024;
const RESPONSE_BYTES = 8192;
const TIMEOUT_MS = 10000;

function tailnetAddress(address) {
  if (net.isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  return net.isIP(address) === 6 && /^fd7a:115c:a1e0:/i.test(address);
}

// Validate every DNS answer and pin the socket lookup to the checked address.
// A public Funnel address must never receive the request body or bearer.
function privateLookup(hostname, options, callback) {
  if (hostname === "localhost") {
    return callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
  }
  dns.lookup(hostname, { all: true }, (error, rows) => {
    if (error || !rows || !rows.length || rows.some(row => !tailnetAddress(row.address))) {
      const denied = new Error("WEBHOOK_DESTINATION_BLOCKED");
      denied.code = "WEBHOOK_DESTINATION_BLOCKED";
      callback(denied);
      return;
    }
    callback(null, options.all ? [rows[0]] : rows[0].address, rows[0].family);
  });
}

function post(urlValue, body, { signal, token = "", deliveryId, timeoutMs = TIMEOUT_MS } = {}) {
  // No redirect handler, proxy environment, cookies or response-body execution.
  let url;
  try { url = new URL(webhook(urlValue)); } catch { return Promise.resolve({ code: "WEBHOOK_DESTINATION_BLOCKED", retryable: false }); }
  if (Buffer.byteLength(body) > MAX_BYTES) return Promise.resolve({ code: "PAYLOAD_TOO_LARGE", retryable: false });
  if (signal && signal.aborted) return Promise.resolve({ code: "CANCELLED", retryable: false });
  return new Promise(resolve => {
    let req;
    let timer;
    let settled = false;
    const finish = (code, retryable = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      if (req) req.destroy();
      resolve({ code, retryable });
    };
    const abort = () => finish("CANCELLED");
    timer = setTimeout(() => finish("WEBHOOK_TIMEOUT", true), timeoutMs);
    if (signal) signal.addEventListener("abort", abort, { once: true });
    const headers = { "content-type": "application/json; charset=utf-8", accept: "application/json",
      "content-length": Buffer.byteLength(body), "user-agent": "MorrowBotNotify/1.0", "idempotency-key": deliveryId };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      req = (url.protocol === "https:" ? https : http).request(url, {
        method: "POST", headers, agent: false, lookup: privateLookup, rejectUnauthorized: true,
      }, res => {
        const status = res.statusCode;
        if (status >= 300 && status < 400) return finish("WEBHOOK_REDIRECT_REJECTED");
        let bytes = 0;
        res.on("data", chunk => { bytes += chunk.length; if (bytes > RESPONSE_BYTES) finish("WEBHOOK_RESPONSE_TOO_LARGE"); });
        res.on("end", () => {
          if (status >= 200 && status < 300) finish("OK");
          else finish(`WEBHOOK_HTTP_${status}`, status === 429 || status >= 500);
        });
        res.on("error", () => finish("WEBHOOK_UNREACHABLE", true));
        res.on("aborted", () => finish("WEBHOOK_UNREACHABLE", true));
      });
      req.on("error", error => finish(error.code === "WEBHOOK_DESTINATION_BLOCKED" ? error.code : "WEBHOOK_UNREACHABLE", error.code !== "WEBHOOK_DESTINATION_BLOCKED"));
      req.end(body);
    } catch { finish("WEBHOOK_UNREACHABLE", true); }
  });
}

module.exports = { post, tailnetAddress, privateLookup, MAX_BYTES, RESPONSE_BYTES, TIMEOUT_MS };
