"use strict";

const { MAX_RECIPIENTS } = require("./constants");

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

function addressList(value, allowEmpty) {
  if (value == null && allowEmpty) return [];
  if (!Array.isArray(value)) return null;
  if (!allowEmpty && !value.length) return null;
  if (value.length > MAX_RECIPIENTS) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || byteLength(text) > 320 || /[\s\u0000]/.test(text) || !text.includes("@")) return null;
    out.push(text);
  }
  return out;
}

function escapePlain(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n|\r|\n/g, "<br>");
}

module.exports = { trimUtf8, htmlToText, byteLength, addressList, escapePlain };
