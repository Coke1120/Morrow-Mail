// UTF-8 bytes labeled Latin-1 or windows-1252 show up as mojibake in the editor.
// Repair only when those bytes are valid UTF-8 and the text is actually cleaner.

const CP1252_BYTE = {
  0x20AC: 0x80,
  0x201A: 0x82,
  0x0192: 0x83,
  0x201E: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02C6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8A,
  0x2039: 0x8B,
  0x0152: 0x8C,
  0x017D: 0x8E,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201C: 0x93,
  0x201D: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02DC: 0x98,
  0x2122: 0x99,
  0x0161: 0x9A,
  0x203A: 0x9B,
  0x0153: 0x9C,
  0x017E: 0x9E,
  0x0178: 0x9F,
};

function hasHigh(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) return true;
  }
  return false;
}

function hasNonAscii(text) {
  return hasHigh(text);
}

function singleBytes(text, windows) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0xFF) {
      bytes[i] = code;
      continue;
    }
    if (!windows) return null;
    const mapped = CP1252_BYTE[code];
    if (mapped == null) return null;
    bytes[i] = mapped;
  }
  return bytes;
}

function sameBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function countCjk(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      i += 1;
      continue;
    }
    if (
      (code >= 0x3400 && code <= 0x9FFF)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0x3040 && code <= 0x30FF)
      || (code >= 0xAC00 && code <= 0xD7AF)
    ) count += 1;
  }
  return count;
}

function weirdness(text) {
  let score = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0xFFFD) score += 8;
    else if (code >= 0x80 && code <= 0x9F) score += 4;
    else if (code >= 0xA0 && code <= 0xFF) score += 1;
  }
  return score;
}

function hasLetter(text) {
  return /\p{L}/u.test(text);
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

function acceptRepair(before, after) {
  if (!after || after === before || after.includes("\uFFFD") || !hasLetter(after)) return false;
  return countCjk(after) > countCjk(before) || weirdness(after) < weirdness(before);
}

function decodeMojibake(text) {
  const latin = singleBytes(text, false);
  const windows = singleBytes(text, true);
  const candidates = [];
  if (latin) candidates.push(latin);
  if (windows && !sameBytes(latin, windows)) candidates.push(windows);
  let best = "";
  let bestCjk = -1;
  let bestWeird = Infinity;
  for (const bytes of candidates) {
    const decoded = decodeUtf8(bytes);
    if (!acceptRepair(text, decoded)) continue;
    const cjk = countCjk(decoded);
    const weird = weirdness(decoded);
    if (cjk > bestCjk || (cjk === bestCjk && weird < bestWeird)) {
      best = decoded;
      bestCjk = cjk;
      bestWeird = weird;
    }
  }
  return best;
}

function repairMojibake(value) {
  if (typeof value !== "string" || !value) return value;
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!hasHigh(text)) return text;
    const next = decodeMojibake(text);
    if (!next || next === text) return text;
    text = next;
  }
  return text;
}

function safePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return "";
  return String.fromCodePoint(code);
}

function htmlToPlain(html) {
  return String(html || "")
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits) => safePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => safePoint(parseInt(digits, 16)))
    .replace(/&amp;/gi, "&")
    .trim();
}

function presentMessage(input) {
  const source = input || {};
  const subject = repairMojibake(source.subject == null ? "" : String(source.subject));
  const htmlBody = source.htmlBody == null ? null : repairMojibake(String(source.htmlBody));
  let textBody = source.textBody == null ? null : repairMojibake(String(source.textBody));
  const plain = htmlBody ? htmlToPlain(htmlBody) : "";
  const missing = textBody == null || textBody === "";
  const broken = textBody != null && textBody.includes("\uFFFD");
  if (plain && !plain.includes("\uFFFD") && (broken || (missing && hasNonAscii(plain)))) {
    textBody = plain;
  }
  return { subject, htmlBody, textBody };
}

module.exports = {
  repairMojibake,
  htmlToPlain,
  presentMessage,
};
