const { addresses } = require("../../shared/compose-policy");

// Store only recipient evidence, never the whole transport/header block.
function recipientHeaders(source) {
  const result = { originalTo: [], deliveredTo: [], envelopeTo: [] };
  const head = Buffer.from(source || "").toString("utf8").split(/\r?\n\r?\n/, 1)[0]
    .replace(/\r?\n[ \t]+/g, " ");
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    const group = { "x-original-to": "originalTo", "delivered-to": "deliveredTo",
      "envelope-to": "envelopeTo", "x-envelope-to": "envelopeTo" }[key];
    if (group) result[group].push(...addresses(value));
    if (key === "received") {
      const recipient = value.match(/\bfor\s+(<[^<>]+>|[^\s;]+)\s*;/i);
      if (recipient) result.envelopeTo.push(...addresses(recipient[1]));
    }
  }
  for (const key of Object.keys(result)) result[key] = [...new Set(result[key])].slice(0, 100);
  return result;
}

module.exports = { recipientHeaders };
