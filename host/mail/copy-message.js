"use strict";

const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { Splitter, Streamer } = require("@zone-eu/mailsplit");
const MAX_BYTES = 32 * 1024 * 1024;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const invalid = text => Object.assign(new Error(text), { code: "copy_incomplete", operationIssued: false });
const TRACE = new Set(["received", "x-received", "delivered-to", "authentication-results", "received-spf", "arc-seal",
  "arc-message-signature", "arc-authentication-results", "x-google-smtp-source", "x-google-dkim-signature", "x-gm-message-state"]);

function inspect(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) throw invalid("A complete original message within the 32 MiB mailbox-copy limit is required.");
  let cut = raw.indexOf("\r\n\r\n"), delimiter = 4;
  if (cut < 0) { cut = raw.indexOf("\n\n"); delimiter = 2; }
  if (cut <= 0 || cut > 256 * 1024) throw invalid("The complete original headers could not be verified. The source was retained.");
  const header = raw.subarray(0, cut).toString("latin1");
  if (/\x00|\r(?!\n)/.test(header)) throw invalid("The original message headers are malformed. The source was retained.");
  const lines = header.split(/\r?\n/), headers = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!headers.length) throw invalid("The original message headers are incomplete.");
      headers[headers.length - 1].value += "\n" + line;
    } else {
      const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):(.*)$/.exec(line);
      if (!match || headers.length >= 512) throw invalid("The original message headers could not be verified.");
      headers.push({ name: match[1].toLowerCase(), value: match[2] });
    }
  }
  const body = raw.subarray(cut + delimiter);
  return { rawSha: digest(raw), size: raw.length, bodySha: digest(body), headers,
    fingerprint: digest(JSON.stringify([headers.map(value => [value.name, value.value]), digest(body)])) };
}

function verify(source, destination, { gmail = false } = {}) {
  const before = inspect(source), after = inspect(destination);
  if (before.bodySha !== after.bodySha) throw invalid("Destination readback did not preserve the complete MIME body and attachments. The source was retained.");
  if (!gmail) {
    if (before.rawSha !== after.rawSha) throw invalid("Destination readback did not match the complete original message. The source was retained.");
  } else {
    // Gmail may prepend transport/authentication trace fields. Every original
    // field, including duplicates, and the entire MIME body must still match.
    const remaining = after.headers.slice();
    for (const header of before.headers) {
      const at = remaining.findIndex(value => value.name === header.name && value.value === header.value);
      if (at < 0) throw invalid("Gmail readback did not retain all original headers. The source was retained.");
      remaining.splice(at, 1);
    }
    if (remaining.some(value => !TRACE.has(value.name))) throw invalid("Gmail changed message content or headers that could not be verified. The source was retained.");
  }
  return { rawSha: before.rawSha, fingerprint: before.fingerprint, size: before.size };
}

function dateHeader(raw) {
  const dates = inspect(raw).headers.filter(value => value.name === "date");
  if (dates.length !== 1) throw invalid("Copying into Gmail requires one valid original Date header. The source was retained.");
  const value = dates[0].value.replace(/\n[ \t]+/g, " ").trim();
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !/(?:[+-]\d{4}|UT|GMT)(?:\s*\([^\r\n]*\))?$/i.test(value)) {
    throw invalid("Gmail cannot preserve the sorting date for this original Date header. The source was retained.");
  }
  return timestamp;
}

async function decodedParts(raw) {
  inspect(raw);
  const splitter = new Splitter();
  const streamer = new Streamer(node => !String(node.contentType).startsWith("multipart/"));
  const pending = [], parts = [];
  streamer.on("node", ({ node, decoder, done }) => {
    const reading = (async () => {
      const hash = crypto.createHash("sha256"); let size = 0;
      try {
        for await (const chunk of decoder) {
          size += chunk.length;
          if (size > MAX_BYTES) throw invalid("A decoded MIME part exceeds the mailbox-copy limit.");
          hash.update(chunk);
        }
        parts.push({ type: String(node.contentType || "application/octet-stream").toLowerCase(), size, sha: hash.digest("hex") });
        if (parts.length > 200) throw invalid("This message has too many MIME parts for verified mailbox copy.");
      } finally { done(); }
    })();
    pending.push(reading);
  });
  streamer.resume();
  await pipeline(Readable.from([raw]), splitter, streamer);
  await Promise.all(pending);
  if (!parts.length) throw invalid("The complete MIME structure could not be verified.");
  return parts;
}

async function verifyGmailSource(raw, payload, readAttachment, check = () => {}) {
  const actual = await decodedParts(raw); check();
  const expected = [];
  async function visit(part, depth = 0) {
    if (!part || depth > 20 || expected.length > 200) throw invalid("Gmail returned an incomplete MIME structure.");
    if (Array.isArray(part.parts) && part.parts.length) { for (const child of part.parts) await visit(child, depth + 1); return; }
    const size = part.body?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw invalid("Gmail did not confirm a complete MIME part.");
    let bytes;
    if (typeof part.body.data === "string") {
      const value = part.body.data;
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw invalid("Gmail returned invalid MIME part data.");
      bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value.replace(/=+$/, "")) throw invalid("Gmail returned incomplete MIME part data.");
    } else if (typeof part.body.attachmentId === "string" && part.body.attachmentId) {
      check(); bytes = await readAttachment(part.body.attachmentId); check();
    } else if (size === 0) bytes = Buffer.alloc(0);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw invalid("Gmail original MIME or attachment data was incomplete. The source was retained.");
    expected.push({ type: String(part.mimeType || "application/octet-stream").toLowerCase(), size, sha: digest(bytes) });
  }
  await visit(payload); check();
  const key = value => JSON.stringify([value.type, value.size, value.sha]);
  if (JSON.stringify(actual.map(key).sort()) !== JSON.stringify(expected.map(key).sort())) throw invalid("Gmail raw MIME did not match all original parts and attachments. The source was retained.");
}

module.exports = { MAX_BYTES, digest, inspect, verify, dateHeader, decodedParts, verifyGmailSource };
