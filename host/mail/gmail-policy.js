function isGmail(account) {
  const profile = String(account?.profile || "").toLowerCase();
  const host = String(account?.imap_host || account?.imapHost || "").toLowerCase();
  return profile === "gmail" || ["imap.gmail.com", "imap.googlemail.com"].includes(host);
}

module.exports = { isGmail };
