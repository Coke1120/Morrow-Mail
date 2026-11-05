"use strict";

// Container framing only. MIME decoding happens in the production parser in a
// bounded worker. Never use readline: a single malicious line can be gigabytes.
const { setImmediate: yieldTurn } = require("node:timers/promises");
const LIMITS = Object.freeze({ chunk: 64 * 1024, line: 256 * 1024, headers: 256 * 1024,
  message: 32 * 1024 * 1024, files: 20, sourceBytes: 100 * 1024 ** 3,
  runBytes: 512 * 1024 * 1024, runMs: 10 * 60 * 1000, parseMs: 20000, attachments: 256 });
const error = (code, message) => Object.assign(new Error(message), { code });
const envelope = /^From [^\s]+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d\d:\d\d:\d\d(?: [A-Za-z+\d:-]+)? \d{4}(?: [A-Za-z+\d:-]+)?$/;
const textLine = bytes => bytes.toString("latin1").replace(/\r?\n$/, "");
const isEnvelope = bytes => bytes.length < 512 && envelope.test(textLine(bytes));

async function* lines(handle, start, { check = () => {}, progress = () => {}, limits = LIMITS } = {}) {
  let position = start, tail = Buffer.alloc(0), lineStart = start;
  for (;;) {
    check();
    const chunk = Buffer.allocUnsafe(limits.chunk);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    const bytes = tail.length ? Buffer.concat([tail, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let cursor = 0, newline;
    while ((newline = bytes.indexOf(10, cursor)) !== -1) {
      const length = newline + 1 - cursor;
      if (length > limits.line) throw error("mbox_line", "A line exceeds the 256 KiB import limit. Import stopped without guessing its boundaries.");
      const part = bytes.subarray(cursor, newline + 1);
      yield { bytes: part, start: lineStart, end: lineStart + length };
      lineStart += length; cursor = newline + 1;
    }
    tail = Buffer.from(bytes.subarray(cursor));
    if (tail.length > limits.line) throw error("mbox_line", "A line exceeds the 256 KiB import limit. Import stopped without guessing its boundaries.");
    progress(position);
    await yieldTurn(); // Outside every archive transaction, including long lines.
  }
  if (tail.length) yield { bytes: tail, start: lineStart, end: lineStart + tail.length };
}

async function headers(iterator, limits) {
  const parts = []; let length = 0, fields = 0, previous = false, bad = false, eof = false;
  for (;;) {
    const next = await iterator.next();
    if (next.done) { eof = true; bad = true; break; }
    const line = textLine(next.value.bytes);
    length += next.value.bytes.length;
    if (length > limits.headers) throw error("mbox_headers", "Message headers exceed the 256 KiB import limit. Import stopped; source bytes were retained.");
    parts.push(next.value.bytes);
    if (!line) break;
    if (/^Content-Length\s*:/i.test(line)) throw error("mbox_variant", "Content-Length framing (mboxcl/mboxcl2) is unsupported. Export as mboxrd or mboxo first.");
    if (/^[!-9;-~]+:/.test(line)) { fields++; previous = true; }
    else if (!/^[ \t]/.test(line) || !previous) bad = true;
  }
  return { bytes: Buffer.concat(parts, length), valid: fields > 0 && !bad, eof };
}

// A possible following envelope is confirmed by a complete header block before
// acknowledging the preceding message. An ambiguous boundary stops the job.
async function* entries(handle, start = 0, options = {}) {
  const limits = { ...LIMITS, ...options.limits };
  if (!["mboxrd", "mboxo"].includes(options.variant)) throw error("mbox_variant", "Choose mboxrd or mboxo explicitly.");
  const iterator = lines(handle, start, { ...options, limits })[Symbol.asyncIterator]();
  let first = await iterator.next();
  if (first.done) return;
  if (!isEnvelope(first.value.bytes)) throw error("mbox_format", "Expected a ctime-style From separator at the start of the mailbox. EML, Maildir and other MBOX variants are unsupported.");
  let begin = first.value.start, header = await headers(iterator, limits);
  let buffer, size, tooLarge;
  function reset() {
    size = 0; tooLarge = false; buffer = Buffer.allocUnsafe(Math.min(65536, limits.message));
    append(header.bytes);
  }
  function append(bytes) {
    if (tooLarge) return;
    if (size + bytes.length > limits.message) { tooLarge = true; buffer = null; return; }
    if (size + bytes.length > buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(limits.message, Math.max(size + bytes.length, buffer.length * 2)));
      buffer.copy(grown, 0, 0, size); buffer = grown;
    }
    bytes.copy(buffer, size); size += bytes.length;
  }
  const result = end => ({ start: begin, end, raw: tooLarge ? null : buffer.subarray(0, size),
    failure: tooLarge ? "Message exceeds the 32 MiB MBOX import limit; retained in the source snapshot."
      : !header.valid ? "Malformed or truncated message headers; retained in the source snapshot." : "" });
  reset();
  let end = first.value.end + header.bytes.length;
  for (;;) {
    options.check?.();
    const next = await iterator.next();
    if (next.done) { yield result(end); return; }
    const row = next.value; end = row.end;
    if (isEnvelope(row.bytes)) {
      const following = await headers(iterator, limits);
      if (!following.valid) throw error("mbox_ambiguous", "A possible From separator has malformed or truncated headers. Import stopped before the ambiguous message; no boundary was guessed.");
      yield result(row.start);
      begin = row.start; header = following; reset(); end = row.end + header.bytes.length;
    } else {
      // Only body lines are unescaped. Preserve CRLF/LF, encoded MIME and all
      // other bytes. Variant selection avoids silently guessing quote depth.
      const body = row.bytes;
      let quote = 0;
      while (body[quote] === 62) quote++;
      const from = quote > 0 && body.subarray(quote, quote + 5).equals(Buffer.from("From "));
      append(from && (options.variant === "mboxrd" || quote === 1) ? body.subarray(1) : body);
    }
  }
}

function metadata(raw) {
  const head = raw.subarray(0, Math.min(raw.length, LIMITS.headers)).toString("latin1").split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  const value = name => head.match(new RegExp("^" + name + ":[ \\t]*([^\\r\\n]*)", "im"))?.[1] || "";
  const status = value("X-Mozilla-Status");
  if (status && !/^[\da-f]{4}$/i.test(status.trim())) throw error("mbox_flags", "Invalid Thunderbird status header; original message retained in the source snapshot.");
  const flags = status ? parseInt(status, 16) : null;
  return { unread: flags == null ? (!!value("Status") && !value("Status").includes("R")) : !(flags & 1),
    isStarred: flags == null ? value("X-Status").includes("F") : !!(flags & 4),
    replied: flags == null ? null : !!(flags & 2), forwarded: flags == null ? null : !!(flags & 0x1000),
    expunged: flags != null && !!(flags & 8), partial: flags != null && !!(flags & 0x400), originalDate: value("Date"), references: value("References") };
}

module.exports = { LIMITS, error, isEnvelope, lines, entries, metadata };
