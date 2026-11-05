// MIME decoding diagnostics contain fixed flags only, never mail text or bytes.
const iconv = require("iconv-lite");
const libmime = require("libmime");
const { Splitter, Streamer } = require("@zone-eu/mailsplit");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

function quality() {
  return { version: 1, lossy: false, unsupported: false, uncertain: false, htmlLossy: false, textLossy: false,
    textGood: false, hasText: false, hasHtml: false, ambiguousAlternatives: false };
}

function charsetOf(contentType) {
  try { return libmime.parseHeaderValue(String(contentType || "")).params.charset || "utf-8"; }
  catch { return "x-morrow-invalid-charset"; }
}

function replacementCount(text) {
  let count = 0;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 0xFFFD) count++;
  return count;
}

function decode(bytes, charset = "utf-8") {
  const name = libmime.normalizeCharset(charset);
  let text, lossy = false, unsupported = false, uncertain = false;
  if (iconv.encodingExists(name)) {
    text = iconv.decode(bytes, name);
    // A literal U+FFFD can be valid sender text. Validate the bytes instead of
    // treating the replacement character itself as proof of decoding loss.
    if (text.includes("\uFFFD")) {
      let validator;
      try { validator = new TextDecoder(name, { fatal: true }); } catch { /* ICU may not know a mail alias. */ }
      if (validator) {
        try {
          const checked = validator.decode(bytes);
          lossy = replacementCount(text) > replacementCount(checked);
        } catch { lossy = true; }
      } else if (iconv.decode(iconv.encode("\uFFFD", name), name) !== "\uFFFD") lossy = true;
      else uncertain = !iconv.encode(text, name).equals(bytes) && !iconv.encode(text, name, { addBOM: true }).equals(bytes);
    }
  } else {
    try {
      const decoder = new TextDecoder(name, { fatal: true });
      try { text = decoder.decode(bytes); }
      catch { lossy = true; text = new TextDecoder(name).decode(bytes); }
    } catch {
      unsupported = true;
      text = bytes.toString("utf8");
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { lossy = true; }
    }
  }
  return { text, lossy, unsupported, uncertain };
}

function note(target, decoded, type) {
  const seen = type === "text/html" ? "hasHtml" : "hasText";
  target.ambiguousAlternatives ||= target[seen];
  target[seen] = true;
  target.lossy ||= decoded.lossy;
  target.unsupported ||= decoded.unsupported;
  target.uncertain ||= decoded.uncertain;
  if (decoded.lossy && type === "text/html") target.htmlLossy = true;
  if (decoded.lossy && type === "text/plain") target.textLossy = true;
  if (type === "text/plain" && decoded.text.trim() && !decoded.lossy && !decoded.unsupported && !decoded.text.includes("\uFFFD")) target.textGood = true;
}

function noteHeaders(target, parsed) {
  const names = [parsed?.subject, ...[parsed?.from, parsed?.to, parsed?.cc, parsed?.replyTo]
    .flatMap(list => (list?.value || []).map(row => row.name))];
  // Decoded headers alone cannot distinguish sender literals from prior loss.
  if (names.some(value => typeof value === "string" && value.includes("\uFFFD"))) target.uncertain = true;
}

async function inspectSource(source) {
  const result = quality();
  const splitter = new Splitter();
  const streamer = new Streamer(node => {
    if (!["text/plain", "text/html"].includes(node.contentType)) return false;
    for (let part = node; part; part = part.parentNode) {
      if (part.filename || part.disposition === "attachment" || part.contentType === "message/rfc822") return false;
    }
    return true;
  });
  const reads = [];
  streamer.on("node", ({ node, decoder, done }) => {
    const reading = (async () => {
      const chunks = [];
      try {
        for await (const chunk of decoder) chunks.push(Buffer.from(chunk));
        note(result, decode(Buffer.concat(chunks), node.charset || "utf-8"), node.contentType);
      } catch { result.uncertain = true; }
      finally { done(); }
    })();
    reads.push(reading);
  });
  // Source is already bounded by the IMAP source caps. The public MIME splitter
  // exposes transfer-decoded leaf bytes; no second charset guess is attempted.
  streamer.resume();
  try { await pipeline(Readable.from([source]), splitter, streamer); }
  catch { result.uncertain = true; }
  await Promise.all(reads);
  return result;
}

function serialize(value) { const item = parse(value); return item ? JSON.stringify(item) : null; }
function parse(value) {
  try {
    const item = typeof value === "string" ? JSON.parse(value) : value;
    if (item?.version !== 1) return null;
    const result = quality();
    for (const key of ["lossy", "unsupported", "uncertain", "htmlLossy", "textLossy", "textGood", "hasText", "hasHtml", "ambiguousAlternatives"]) result[key] = item[key] === true;
    return result;
  } catch { return null; }
}

function presentation(row, presented) {
  // Pending local edits have not passed through a byte decoder. Do not apply
  // provider diagnostics from an older revision to newly typed draft text.
  if (row.draft_pending || row.uid === 0) return { ...presented, warning: "" };
  const info = parse(row.decoding_json);
  let warning = "";
  const plainFallback = info?.htmlLossy && !info.textLossy && info.textGood && !info.ambiguousAlternatives;
  if (info?.lossy) warning = "Some message text could not be decoded without losing characters. The available text is shown; missing characters cannot be recovered from this cached copy.";
  else if (info?.unsupported) warning = "This message uses an unrecognized text encoding. The available text may differ from the original.";
  else if (info?.uncertain) {
    warning = "The original text encoding could not be fully verified. Any replacement characters (�) may already be in the sender's text or come from an earlier decoding error.";
  } else if (!info && [row.subject, row.from_addr, presented.htmlBody, presented.textBody].some(value => value?.includes("\uFFFD"))) {
    warning = "This message contains replacement characters (�). They may already be in the sender's text or come from an earlier decoding error. Retry download can recheck the server copy; it cannot recreate missing original bytes.";
  }
  if (plainFallback) warning += " The plain-text version is shown because the HTML version could not be decoded correctly.";
  return { ...presented, htmlBody: plainFallback ? null : presented.htmlBody, warning };
}

// Avoid splitting surrogate pairs without allocating an array for a large body.
function snippet(text, limit = 180) {
  let cut = String(text || "").slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

module.exports = { quality, charsetOf, decode, note, noteHeaders, inspectSource, serialize, parse, presentation, snippet };
