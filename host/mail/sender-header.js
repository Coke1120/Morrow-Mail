// Keep machine-readable identity separate from a recipient-visible From label.
const policy = require("../../shared/compose-policy");

function bareAddress(value) {
  if (typeof value !== "string") return "";
  const address = policy.address(value);
  return address && value.trim().toLowerCase() === address ? address : "";
}

function headerParts(value) {
  const direct = bareAddress(value);
  if (direct) return { address: direct, name: "" };
  const parsed = require("nodemailer/lib/addressparser")(value || "");
  const rows = parsed.filter(row => bareAddress(row.address));
  // Ambiguous legacy headers must not guess an identity or fall back to primary.
  if (rows.length !== 1) return { address: "", name: "" };
  return { address: bareAddress(rows[0].address), name: rows[0].name || "" };
}

function savedAddress(row) {
  return bareAddress(row.from_address) || headerParts(row.from_addr).address;
}

module.exports = { bareAddress, headerParts, savedAddress };
