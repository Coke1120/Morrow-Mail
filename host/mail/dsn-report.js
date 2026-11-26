const addressParser = require("nodemailer/lib/addressparser");
const { domain } = require("../../shared/compose-policy");

const HEADER_LIMIT = 64 * 1024;
const DOT_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const MAILBOX = new RegExp(`^(${DOT_ATOM})@([A-Za-z0-9.-]+)$`);
const MESSAGE_ID = new RegExp(`^<${DOT_ATOM}@${DOT_ATOM}>$`);
const REPORT = Object.freeze({ kind: "report" });
const PARTIAL_REPORT = Object.freeze({ kind: "report", partial: true });
const DRAFT = Object.freeze({ kind: "draft" });

function mailbox(value) {
  if (typeof value !== "string" || value.length > 254 || /[^\x21-\x7e]/.test(value)) return "";
  const match = MAILBOX.exec(value);
  return match && match[1].length <= 64 && domain(match[2]) ? value : "";
}

function messageId(value) {
  return typeof value === "string" && value.length <= 998 && !/[^\x21-\x7e]/.test(value) && MESSAGE_ID.test(value) ? value : "";
}

function trimHorizontal(value) {
  let start = 0, end = value.length;
  while (value[start] === " " || value[start] === "\t") start++;
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) end--;
  return value.slice(start, end);
}

function parseFields(text) {
  const fields = new Map();
  let values;
  for (const line of text.split(/\r?\n/)) {
    if (/[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/.test(line)) return null;
    if (/^[ \t]/.test(line) && values) {
      values[values.length - 1] += " " + trimHorizontal(line);
      continue;
    }
    const field = /^([!-9;-~]+):([^\r\n]*)$/.exec(line);
    if (!field) return null;
    const key = field[1].toLowerCase();
    values = fields.get(key) || [];
    values.push(field[2]);
    fields.set(key, values);
  }
  return fields;
}

function one(fields, key) {
  const values = fields?.get(key);
  return values?.length === 1 ? trimHorizontal(values[0]) : "";
}

function headerBlock(bytes, headersOnly = false) {
  const prefix = bytes.subarray(0, HEADER_LIMIT + 4);
  const crlf = prefix.indexOf("\r\n\r\n");
  const lf = (crlf < 0 ? prefix : prefix.subarray(0, crlf)).indexOf("\n\n");
  const end = crlf < 0 || (lf >= 0 && lf < crlf) ? lf : crlf;
  if (end < 0 && (!headersOnly || bytes.length > HEADER_LIMIT)) return null;
  const length = end < 0 ? bytes.length : end;
  if (length > HEADER_LIMIT) return null;
  const text = bytes.subarray(0, length).toString("utf8").replace(/(?:\r?\n)+$/, "");
  return { fields: parseFields(text), body: end < 0 ? Buffer.alloc(0) : bytes.subarray(length + (end === crlf ? 4 : 2)) };
}

function reportType(value) {
  return /^multipart\/report(?:[ \t]*;|[ \t]*$)/i.test(value || "");
}

function isDeliveryReport(contentType) {
  return reportType(contentType?.value) && contentType.params?.["report-type"]?.toLowerCase() === "delivery-status";
}

function reportBoundary(fields) {
  const value = one(fields, "content-type");
  if (!reportType(value)) return "";
  const params = new Map();
  for (const parameter of value.split(";").slice(1)) {
    const match = /^[ \t]*([a-z0-9_-]+)[ \t]*=[ \t]*(?:"([^"]*)"|([^ \t"]+))[ \t]*$/i.exec(parameter);
    if (!match || params.has(match[1].toLowerCase())) return "";
    params.set(match[1].toLowerCase(), match[2] ?? match[3]);
  }
  const boundary = params.get("boundary");
  return params.get("report-type")?.toLowerCase() === "delivery-status"
    && /^[A-Za-z0-9'()+_,.\/:=? -]{1,70}$/.test(boundary || "") && !boundary.endsWith(" ") ? boundary : "";
}

function directParts(body, boundary) {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiters = new RegExp(`(^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
  const wire = body.toString("latin1");
  const parts = [];
  let start, delimiter;
  while ((delimiter = delimiters.exec(wire))) {
    if (start !== undefined) parts.push(headerBlock(body.subarray(start, delimiter.index)));
    if (delimiter[2]) return parts.length >= 2 && parts.every(part => part?.fields) ? parts : null;
    if (parts.length === 3) return null;
    start = delimiters.lastIndex;
  }
  return null;
}

function mimeType(fields) {
  const values = fields.get("content-type") || [];
  return values.length === 0 ? "text/plain" : one(fields, "content-type").split(";", 1)[0].trim().toLowerCase();
}

function unencoded(fields) {
  return !fields.has("content-transfer-encoding")
    || /^(?:7bit|8bit|binary)$/i.test(one(fields, "content-transfer-encoding"));
}

function recipientStatus(bytes) {
  if (bytes.length > HEADER_LIMIT) return null;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  const blocks = lines.join("\n").split("\n\n", 3);
  if (blocks.length !== 2) return null;
  const [report, recipient] = blocks.map(parseFields);
  if (!/^[a-z0-9-]+[ \t]*;[ \t]*\S+/i.test(one(report, "reporting-mta"))) return null;
  if (["action", "status", "final-recipient", "original-recipient"].some(key => report.has(key)) || recipient?.has("reporting-mta")) return null;
  const action = one(recipient, "action").toLowerCase();
  const status = one(recipient, "status");
  const address = field => mailbox(/^rfc822[ \t]*;[ \t]*(\S+)$/i.exec(one(recipient, field))?.[1]);
  const failed = address("final-recipient");
  if (!failed || (recipient.has("original-recipient") && address("original-recipient").toLowerCase() !== failed.toLowerCase())) return null;
  if (action === "delayed" && /^4\.\d{1,3}\.\d{1,3}$/.test(status)) return { delayed: true };
  return action === "failed" && status === "5.1.1" ? { failed } : null;
}

function fromReport(bytes, complete = true) {
  if (!complete) return PARTIAL_REPORT;
  const head = headerBlock(bytes);
  const boundary = reportBoundary(head?.fields);
  if (!boundary || !unencoded(head.fields)) return REPORT;
  const parts = directParts(head.body, boundary);
  if (!parts) return REPORT;
  const [explanation, status, returned] = parts;
  if (!["text/plain", "text/html", "multipart/alternative"].includes(mimeType(explanation.fields))
    || mimeType(status.fields) !== "message/delivery-status" || !unencoded(status.fields)) return REPORT;
  const outcome = recipientStatus(status.body);
  const recipients = addressParser(one(head.fields, "to"));
  const notified = recipients.length === 1 && mailbox(recipients[0].address);
  if (!outcome || !notified) return REPORT;
  if (outcome.delayed) return { kind: "report", delayed: true, notified };
  if (!returned || !unencoded(returned.fields)) return REPORT;
  const returnedType = mimeType(returned.fields);
  if (!["message/rfc822", "text/rfc822-headers"].includes(returnedType)) return REPORT;
  const original = headerBlock(returned.body, returnedType === "text/rfc822-headers");
  if (returnedType === "text/rfc822-headers" && /[^\r\n \t]/.test(original?.body.toString("latin1") || "")) return REPORT;
  const id = messageId(one(original?.fields, "message-id"));
  return id ? { kind: "report", id, failed: outcome.failed, notified } : REPORT;
}

function original(bytes, parsed, quality) {
  const fields = headerBlock(bytes)?.fields;
  const from = parsed?.from?.value;
  const id = messageId(one(fields, "message-id"));
  if (!id || id !== parsed.messageId || !one(fields, "from") || from?.length !== 1 || !mailbox(from[0].address)
    || !one(fields, "date") || !Number.isFinite(parsed.date?.getTime()) || fields.get("subject")?.length > 1 || !quality
    || quality.lossy || quality.unsupported || quality.uncertain || quality.ambiguousAlternatives
    || (quality.hasText && quality.hasHtml && !quality.provenAlternatives)
    || !["text/plain", "text/html", "multipart/alternative", "multipart/mixed", "multipart/related"].includes(mimeType(fields))) return null;
  const body = quality.hasHtml ? (quality.hasText && quality.textGood ? "both" : "html") : quality.hasText ? "text" : "";
  function addresses(row) {
    return Array.isArray(row.group) ? row.group.flatMap(addresses) : [row.address];
  }
  // Use MIME parser addresses. Cached preview labels may contain commas and
  // even address-like text inside a name, so they cannot prove a recipient.
  const recipients = [parsed.to, parsed.cc, parsed.bcc].flatMap(field => (field?.value || []).flatMap(addresses));
  return originalEvidence(body, recipients);
}

function originalEvidence(body, addresses) {
  const recipients = [...new Set(addresses.filter(mailbox).map(address => address.toLowerCase()))];
  return body && recipients.length ? { kind: "original", body, recipients } : null;
}

function forFolder(value, role) {
  if ((value?.kind === "report" && role === "inbox") || (value?.kind === "original" && role === "sentitems")
    || (value?.kind === "draft" && role === "drafts")) return JSON.stringify(value);
  return null;
}

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { mailbox, messageId, isDeliveryReport, fromReport, original, originalEvidence, forFolder, parse, REPORT, DRAFT };
