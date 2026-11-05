// IMAP adds confirmed local-send evidence in imap-dispositions.js. Gmail also
// supports a unique cached Sent In-Reply-To relationship in db.js.
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
