const { addresses } = require("../../shared/compose-policy");

function replyToAddresses(input) {
  const rows = Array.isArray(input) ? input : input?.value || [];
  return rows.flatMap(row => {
    if (row?.group) return replyToAddresses(row.group);
    const address = addresses(row?.address)[0];
    return address ? [{ address, name: String(row.name || "").replace(/[\x00-\x1f\x7f]/g, " ").trim() }] : [];
  }).slice(0, 100);
}

// Store only recipient evidence, never the whole transport/header block.
function recipientHeaders(source, replyTo) {
  const result = { originalTo: [], deliveredTo: [], envelopeTo: [], replyTo: replyToAddresses(replyTo) };
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
  for (const key of ["originalTo", "deliveredTo", "envelopeTo"]) result[key] = [...new Set(result[key])].slice(0, 100);
  return result;
}

module.exports = { recipientHeaders, replyToAddresses };
