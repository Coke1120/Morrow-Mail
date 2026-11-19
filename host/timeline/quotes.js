// Share only exact quoted bodies with an earlier complete source in this request.
// Original sources/fingerprints remain untouched. No fuzzy matching, boilerplate
// removal, cross-request references or dependence on an AI-generated summary.
function compactQuotes(values) {
  const originals = new Map(), messages = new Map();
  let repeatedBytes = 0, sharedQuotes = 0;
  const rows = values.map(value => {
    const { _quoteGroup, _wholeBody, ...row } = value;
    if (typeof row.text !== "string") return row;
    let literal = "", decoded = "", quoted = "";
    const segments = [];
    const flushQuote = () => {
      if (!quoted) return;
      const match = originals.has(`${_quoteGroup}\0${decoded}`) ? decoded : decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
      const candidate = originals.get(`${_quoteGroup}\0${match}`);
      if (_quoteGroup && candidate && Buffer.byteLength(match) >= 128) {
        if (literal) { segments.push({ text: literal }); literal = ""; }
        segments.push({ quoted_source_token: candidate });
        const count = Buffer.byteLength(quoted);
        repeatedBytes += count; sharedQuotes++;
        const id = row.source_token.split(":")[0];
        const prior = messages.get(id) || { repeatedBytes: 0, sharedQuotes: 0 };
        messages.set(id, { repeatedBytes: prior.repeatedBytes + count, sharedQuotes: prior.sharedQuotes + 1 });
      } else literal += quoted;
      decoded = ""; quoted = "";
    };
    for (const line of row.text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      if (line.startsWith(">")) { quoted += line; decoded += line.replace(/^> ?/, ""); }
      else { flushQuote(); literal += line; }
    }
    flushQuote();
    if (literal) segments.push({ text: literal });
    if (segments.some(segment => segment.quoted_source_token)) {
      delete row.text;
      row.text_segments = segments;
    } else if (_quoteGroup && _wholeBody) {
      // A canonical reference must be directly visible, never another reference.
      originals.set(`${_quoteGroup}\0${row.text}`, row.source_token);
    }
    return row;
  });
  return { rows, repeatedBytes, sharedQuotes, messages };
}

// Fallback for a large local capture. Only use a complete, unchanged earlier
// body in this thread as evidence; that body will still go through extraction.
// Never send an unresolved token or remove a quote-only message's entire body.
function reduceRepeatedQuotes(sources) {
  const originals = new Map();
  return sources.map(source => {
    const { source_thread_id: thread, occurred_at: at, text } = source;
    let canonical = originals.get(thread);
    if (!canonical) originals.set(thread, canonical = new Map());
    const timestamp = Date.parse(at);
    let literal = "", quoted = "", decoded = "", count = 0;
    const flush = () => {
      if (!quoted) return;
      const match = canonical.has(decoded) ? decoded : decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
      if (canonical.get(match) < timestamp && Buffer.byteLength(match) >= 128) count++;
      else literal += quoted;
      quoted = ""; decoded = "";
    };
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      if (line.startsWith(">")) { quoted += line; decoded += line.replace(/^> ?/, ""); }
      else { flush(); literal += line; }
    }
    flush();
    if (count && literal.trim()) return { ...source, extractionText: literal, repeatedQuoteBlocks: count };
    if (Number.isFinite(timestamp) && !canonical.has(text)) canonical.set(text, timestamp);
    return source;
  });
}

module.exports = { compactQuotes, reduceRepeatedQuotes };
