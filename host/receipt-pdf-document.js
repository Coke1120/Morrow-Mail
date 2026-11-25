const { Parser } = require("htmlparser2");

const MAX_BODY_BYTES = 512 * 1024;
const MAX_EXPLICIT_BREAKS = 3000;
const TOO_LARGE = "This message is too large for a receipt PDF. Open a shorter message.";
const NO_TEXT = "This message has no readable text for a receipt PDF. Open a message with a text body.";
const INCOMPLETE = "The full message body is unavailable or has a warning. Open the message and resolve any download or decoding warning, then try again.";

const allowed = new Set(("address article aside b blockquote br caption center code dd div dl dt em footer "
  + "h1 h2 h3 h4 h5 h6 header hr i li main ol p pre s section small span strong sub sup "
  + "table tbody td tfoot th thead tr u ul wbr").split(" "));
const omitted = new Set(("applet audio button canvas datalist embed head iframe math noembed noframes noscript "
  + "object script select style svg template textarea title video xmp").split(" "));
const voidTags = new Set(["br", "hr", "wbr"]);
const lineTags = new Set("br div h1 h2 h3 h4 h5 h6 hr li p pre tr".split(" "));

class ReceiptError extends Error {}

function escape(text) {
  return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function readable(text) {
  return /[^\s\p{Cf}\p{Cc}\ufffd]/u.test(text);
}

function lineBreakCount(text) {
  return (text.match(/\r\n|[\r\n]/g) || []).length;
}

function spans(tag, attrs) {
  if (tag !== "th" && tag !== "td") return "";
  let output = "";
  for (const name of ["colspan", "rowspan"]) {
    if (!/^\s*[0-9]+\s*$/.test(attrs[name] || "")) continue;
    const value = Number(attrs[name]);
    if (value > 32) throw new ReceiptError("This message has a table with spans too large to print. Open a message with a smaller table.");
    if (value >= 1 || (name === "rowspan" && value === 0)) output += ` ${name}="${value}"`;
  }
  return output;
}

function inertHtml(html) {
  const stack = [];
  const output = [];
  let events = 0;
  let breaks = 0;
  let visibleText = false;
  function count() {
    if (++events > 20000) throw new ReceiptError(TOO_LARGE);
  }
  new Parser({
    onopentag(tag, attrs) {
      count();
      if (stack.length >= 96) throw new ReceiptError(TOO_LARGE);
      const parent = stack.at(-1);
      const hiddenStyle = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\s*(?:!important\s*)?(?:;|$)/i;
      const skip = parent?.skip || omitted.has(tag) || Object.hasOwn(attrs, "hidden") || hiddenStyle.test(attrs.style || "");
      const emit = !skip && allowed.has(tag);
      stack.push({ skip, emit, pre: tag === "pre" || parent?.pre });
      if (!emit) return;
      if (lineTags.has(tag) && ++breaks > MAX_EXPLICIT_BREAKS) throw new ReceiptError(TOO_LARGE);
      output.push(`<${tag}${spans(tag, attrs)}>`);
    },
    onclosetag(tag) {
      const entry = stack.pop();
      if (entry?.emit && !voidTags.has(tag)) output.push(`</${tag}>`);
    },
    ontext(text) {
      count();
      const parent = stack.at(-1);
      if (parent?.skip) return;
      if (parent?.pre) {
        breaks += lineBreakCount(text);
        if (breaks > MAX_EXPLICIT_BREAKS) throw new ReceiptError(TOO_LARGE);
      }
      visibleText ||= readable(text);
      output.push(escape(text));
    },
  }, { decodeEntities: true }).end(html);
  if (!visibleText) throw new ReceiptError(NO_TEXT);
  return output.join("");
}

function bodyOf(email) {
  if (email.bodyComplete !== true || email.hasBody !== true || email.bodyWarning || email.encodingWarning) {
    throw new ReceiptError(INCOMPLETE);
  }
  const html = email.htmlBody || "";
  const plain = email.textBody || "";
  if (Buffer.byteLength(html) + Buffer.byteLength(plain) > MAX_BODY_BYTES) throw new ReceiptError(TOO_LARGE);
  if (html.trim()) return inertHtml(html);
  if (!readable(plain)) throw new ReceiptError(NO_TEXT);
  if (lineBreakCount(plain) > MAX_EXPLICIT_BREAKS) throw new ReceiptError(TOO_LARGE);
  return `<div class="plain" dir="auto">${escape(plain)}</div>`;
}

function storedDate(date) {
  if (typeof date !== "string") return "Unknown";
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/.exec(date);
  if (!match) return "Unknown";
  const [, day, time, fraction = "", offset] = match;
  const stamp = Date.parse(offset ? date : date + "Z");
  if (!Number.isFinite(stamp)) return "Unknown";
  if (!offset) return `${day} ${time}${fraction} (time zone unavailable)`;
  if (offset !== "Z" && !/^-00:?00$/.test(offset)) {
    return `${day} ${time}${fraction} UTC${offset.length === 5 ? offset.slice(0, 3) + ":" + offset.slice(3) : offset}`;
  }
  return new Date(stamp).toISOString().replace("T", " ").replace("Z", " UTC");
}

function receiptHtml(email) {
  const subject = email.subject || "(No subject)";
  const sender = email.fromAddress || "Unknown";
  if (Buffer.byteLength(subject) + Buffer.byteLength(sender) > MAX_BODY_BYTES) throw new ReceiptError(TOO_LARGE);
  const body = bodyOf(email);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Message receipt</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { margin: 0; color: #151a18; font: 11pt/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
  header { border-bottom: 1px solid #aaa; margin-bottom: 14pt; padding-bottom: 8pt; }
  header p { margin: 3pt 0; }
  header h1 { margin: 0 0 6pt; font-size: 18pt; }
  header h1, .plain, pre { white-space: pre-wrap; }
  h1, h2, h3, h4, h5, h6, caption { break-after: avoid; }
  table { border-collapse: collapse; table-layout: fixed; width: 100%; margin: 5pt 0; }
  th, td { border: 1px solid #aaa; padding: 2pt; vertical-align: top; }
  th { text-align: start; }
  p, .plain, pre { orphans: 2; widows: 2; }
</style></head><body>
<header><h1 dir="auto">${escape(subject)}</h1>
<p><strong>From:</strong> <bdi>${escape(sender)}</bdi></p>
<p><strong>Date:</strong> ${escape(storedDate(email.date))}</p></header>
<main dir="auto">${body}</main></body></html>`;
}

module.exports = { receiptHtml, ReceiptError };
