/* Public account-view identity only. Never include credentials or mail bodies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowMailContextOwner = api;
})(typeof window === "object" ? window : globalThis, function () {
  function connection(account) {
    if (!account || typeof account.id !== "string" || !account.id
      || !Number.isSafeInteger(account.bodyEpoch) || account.bodyEpoch < 0) return "";
    const imap = account.imapSmtpCustom?.imap;
    // bodyVersion is a global body-cache counter, not a connection generation.
    // Routine cache fills must not retire a reviewed account operation.
    return JSON.stringify([account.id, account.email, account.imapUsername, account.authKind,
      account.imapSmtpProfile, account.mailTransport, imap?.host ?? null, imap?.port ?? null,
      imap?.tls ?? null, account.bodyEpoch]);
  }
  function capture(account, message) {
    const proof = connection(account);
    if (!proof || !message || message.accountId !== account.id || typeof message.id !== "string" || !message.id
      || typeof message.folderId !== "string" || !message.folderId) return null;
    return { accountId: account.id, emailId: message.id, folderId: message.folderId,
      bodyEpoch: account.bodyEpoch, connection: proof };
  }
  return { connection, capture };
});
