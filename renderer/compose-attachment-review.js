/* Narrow, local check for explicit filenames promised in Preview Send. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.morrowComposeAttachmentReview = factory();
})(typeof window === "object" ? window : globalThis, function () {
  // Limiting both the sentence forms and extensions avoids guessing at prose,
  // links, destinations, conditions, instructions, or future promises.
  const declaration = /^(?:attached\s+(?:is|are)\s+|attached\s*:\s*|please\s+find\s+attached\s+|i(?:\s+have|['’]ve)\s+attached\s+)(.+)$/i;
  const passive = /^(.+?)\s+(?:is|are)\s+attached$/i;
  const historyBoundary = /^(?:>|--$|-{2,}\s*(?:original|forwarded) message\s*-*|begin forwarded message:?$|on\s+.{1,240}\s+wrote\s*:$)/i;
  const extensions = "pdf|csv|tsv|xlsx?|xlsm|docx?|pptx?|txt|zip|png|jpe?g|webp|gif|tiff?|eml|msg|ics|odt|ods|odp|rtf";
  const bare = new RegExp(`^[\\p{L}\\p{N}_-][\\p{L}\\p{M}\\p{N}_.-]*\\.(?:${extensions})$`, "iu");
  const quoted = new RegExp(`^[\\p{L}\\p{N}_-][\\p{L}\\p{M}\\p{N}_. ()&+-]*\\.(?:${extensions})$`, "iu");

  function readNames(raw) {
    // Read all items or reject the line. Do not harvest a plausible substring
    // from "report.pdf if approved" or from an unquoted multiword filename.
    const names = [];
    let rest = raw.trim();
    while (rest && names.length < 12) {
      const match = rest.match(/^(?:"([^"]+)"|“([^”]+)”|([^\s,]+))/u);
      if (!match) return [];
      const name = match[1] || match[2] || match[3];
      if (name.length > 160 || !(match[3] ? bare : quoted).test(name)) return [];
      names.push(name);
      rest = rest.slice(match[0].length);
      if (!rest.trim()) return names;
      const separator = rest.match(/^(?:\s*,\s*(?:and\s+)?|\s+and\s+)/i);
      if (!separator || !rest.slice(separator[0].length).trim()) return [];
      rest = rest.slice(separator[0].length);
    }
    return [];
  }

  function missing(authoredText, files) {
    if (typeof authoredText !== "string" || authoredText.length > 32000) return [];
    const included = new Set((Array.isArray(files) ? files : [])
      .filter(file => typeof file?.filename === "string").map(file => file.filename.normalize("NFC")));
    const seen = new Set();
    const findings = [];
    for (const raw of authoredText.split(/\r?\n/u)) {
      const line = raw.trim();
      if (historyBoundary.test(line)) break;
      if (line.length > 280 || !line || /[\u0000-\u001f\u007f]/u.test(line)) continue;
      const sentence = line.replace(/\.$/, "");
      const names = readNames((sentence.match(declaration) || sentence.match(passive))?.[1] || "");
      for (const filename of names) {
        const key = filename.normalize("NFC");
        if (included.has(key) || seen.has(key)) continue;
        seen.add(key);
        findings.push({ filename, line });
        if (findings.length === 8) return findings;
      }
    }
    return findings;
  }

  return { missing };
});
