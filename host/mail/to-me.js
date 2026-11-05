// The cached To field is independent of Cc/Bcc and delivery-hop metadata.
const addressparser = require("nodemailer/lib/addressparser");
const { bareAddress } = require("./sender-header");

function matches(toJson, accountEmail) {
  const owner = bareAddress(accountEmail);
  if (!owner) return 0;
  let recipients;
  try { recipients = JSON.parse(toJson); } catch { return 0; }
  if (!Array.isArray(recipients)) return 0;
  return Number(recipients.some(recipient => {
    if (recipient && typeof recipient === "object") return bareAddress(recipient.address) === owner;
    if (typeof recipient !== "string") return false;
    const direct = bareAddress(recipient);
    if (direct) return direct === owner;
    // Provider formatters store one decoded name <address> per array entry.
    // Names can themselves contain literal angle brackets or email addresses;
    // reparsing that display text as RFC syntax can mistake a name for To.
    const terminal = /<([^<>]+)>\s*$/.exec(recipient);
    if (terminal) return bareAddress(terminal[1]) === owner;
    if (/[<>]/.test(recipient)) return false;
    return addressparser(recipient, { flatten: true }).some(row => bareAddress(row.address) === owner);
  }));
}

module.exports = { matches };
