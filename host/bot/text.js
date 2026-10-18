"use strict";

function trimUtf8(value, maxBytes) {
  const text = value == null ? "" : String(value);
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function safePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return " ";
  return String.fromCodePoint(code);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(\d+);/g, (_match, n) => safePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, n) => safePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

module.exports = { trimUtf8, htmlToText, byteLength };
