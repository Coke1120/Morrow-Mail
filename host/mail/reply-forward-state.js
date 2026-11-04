// Read only explicit provider flags. A thread or an In-Reply-To header describes
// message relationships, not whether this message was answered or forwarded.
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
