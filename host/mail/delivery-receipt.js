const addressparser = require("nodemailer/lib/addressparser");

function addresses(value) {
  const values = Array.isArray(value) ? value : [value];
  const out = [];
  function add(item) {
    if (item && Array.isArray(item.group)) { item.group.forEach(add); return; }
    const address = String(item?.address || "").trim();
    if (address && address.length <= 998 && !/[\r\n\0]/.test(address) && !out.includes(address)) out.push(address);
  }
  for (const item of values) {
    if (item && typeof item === "object") add({ address: item.address || item.email });
    else if (typeof item === "string") {
      const parsed = addressparser(item);
      const before = out.length;
      parsed.forEach(add);
      if (out.length === before && parsed.every(row => !row.address && !row.group)) add({ address: item });
    }
  }
  return out;
}

function fromSmtp(info, messageId) {
  return {
    messageId: info?.messageId || messageId,
    accepted: addresses(info?.accepted),
    rejected: addresses(info?.rejected),
    rejectionDetails: (Array.isArray(info?.rejectedErrors) ? info.rejectedErrors : []).flatMap(error =>
      addresses(error?.recipient).map(address => ({ address, status: Number(error.responseCode) || undefined }))),
  };
}

function summary(receipt) {
  const rejected = addresses(receipt?.rejected);
  const details = Array.isArray(receipt?.rejectionDetails) ? receipt.rejectionDetails : [];
  const accepted = addresses(receipt?.accepted);
  return "Partly sent. SMTP accepted: " + (accepted.join(", ") || "some recipients") + "; rejected: " + rejected.map(address => {
    const detail = details.find(row => row.address === address);
    return address + (detail?.status ? ` (${detail.status})` : "");
  }).join(", ") + ". Accepted recipients will not be resent automatically. Recover a draft for rejected recipients from Scheduled delivery review.";
}

function retryRecipients(payload, receipt) {
  const accepted = new Set(addresses(receipt?.accepted).map(address => address.toLowerCase()));
  const rejected = addresses(receipt?.rejected);
  const wanted = new Set(rejected.map(address => address.toLowerCase()));
  const selected = new Set();
  const fields = {};
  for (const field of ["to", "cc", "bcc"]) {
    fields[field] = addresses(payload?.[field]).filter(address => {
      const key = address.toLowerCase();
      if (!wanted.has(key) || accepted.has(key) || selected.has(key)) return false;
      selected.add(key); return true;
    });
  }
  return { ...fields, unresolved: rejected.filter(address => !selected.has(address.toLowerCase())) };
}

module.exports = { addresses, fromSmtp, summary, retryRecipients };
