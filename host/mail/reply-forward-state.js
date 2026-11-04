// IMAP remains provider-authoritative. Gmail enriches unsupported states in db.js
// using confirmed local sends or a unique cached Sent In-Reply-To relationship.
function fromFlags(flags) {
  if (!(flags instanceof Set)) return { replied: null, forwarded: null };
  const values = new Set([...flags].map(value => String(value).toLowerCase()));
  return { replied: values.has("\\answered"), forwarded: values.has("$forwarded") };
}

function patch(value) {
  const result = {};
  for (const key of ["replied", "forwarded"]) {
    if (value[key] === null || typeof value[key] === "boolean") result[key] = value[key] === null ? null : Number(value[key]);
  }
  return result;
}

module.exports = { fromFlags, patch };
