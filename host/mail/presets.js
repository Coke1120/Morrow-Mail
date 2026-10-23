// IMAP/SMTP endpoints for the settings wizard.
// The renderer adds its own Custom card, so this list must not include
// profile "custom". credentialKind must not be "oauth2" or the card is hidden.
// Gmail/Outlook one-click OAuth: mail:addAccount → host/mail/oauth.js (IMAP XOAUTH2).

const HOSTS = {
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 465, tls: true },
  },
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.me.com", port: 587, tls: true },
  },
  yahoo: {
    imap: { host: "imap.mail.yahoo.com", port: 993, tls: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, tls: true },
  },
  yahoo_jp: {
    imap: { host: "imap.mail.yahoo.co.jp", port: 993, tls: true },
    smtp: { host: "smtp.mail.yahoo.co.jp", port: 465, tls: true },
  },
  outlook: {
    imap: { host: "outlook.office365.com", port: 993, tls: true },
    smtp: { host: "smtp.office365.com", port: 587, tls: true },
  },
  fastmail: {
    imap: { host: "imap.fastmail.com", port: 993, tls: true },
    smtp: { host: "smtp.fastmail.com", port: 465, tls: true },
  },
  qq: {
    imap: { host: "imap.qq.com", port: 993, tls: true },
    smtp: { host: "smtp.qq.com", port: 465, tls: true },
  },
  naver: {
    imap: { host: "imap.naver.com", port: 993, tls: true },
    smtp: { host: "smtp.naver.com", port: 587, tls: true },
  },
  daum: {
    imap: { host: "imap.daum.net", port: 993, tls: true },
    smtp: { host: "smtp.daum.net", port: 465, tls: true },
  },
  hanmail: {
    imap: { host: "imap.daum.net", port: 993, tls: true },
    smtp: { host: "smtp.daum.net", port: 465, tls: true },
  },
  kakao: {
    imap: { host: "imap.kakao.com", port: 993, tls: true },
    smtp: { host: "smtp.kakao.com", port: 465, tls: true },
  },
  aol: {
    imap: { host: "imap.aol.com", port: 993, tls: true },
    smtp: { host: "smtp.aol.com", port: 465, tls: true },
  },
  zoho: {
    imap: { host: "imap.zoho.com", port: 993, tls: true },
    smtp: { host: "smtp.zoho.com", port: 465, tls: true },
  },
};

const CARDS = [
  { profile: "gmail", displayName: "Gmail", credentialKind: "password" },
  { profile: "outlook", displayName: "Outlook", credentialKind: "password" },
  { profile: "icloud", displayName: "iCloud", credentialKind: "password" },
  { profile: "yahoo", displayName: "Yahoo", credentialKind: "password" },
  { profile: "yahoo_jp", displayName: "Yahoo! Japan", credentialKind: "password" },
  { profile: "fastmail", displayName: "Fastmail", credentialKind: "password" },
  { profile: "qq", displayName: "QQ Mail", credentialKind: "password" },
  { profile: "naver", displayName: "Naver", credentialKind: "password" },
  { profile: "daum", displayName: "Daum", credentialKind: "password" },
  { profile: "hanmail", displayName: "Hanmail", credentialKind: "password" },
  { profile: "kakao", displayName: "Kakao", credentialKind: "password" },
  { profile: "aol", displayName: "AOL", credentialKind: "password" },
  { profile: "zoho", displayName: "Zoho", credentialKind: "password" },
];

function endpoint(raw, fallbackPort) {
  if (!raw || typeof raw.host !== "string" || !raw.host.trim()) return null;
  const port = Number(raw.port) || fallbackPort;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host: raw.host.trim(), port, tls: raw.tls !== false };
}

function endpointsFor(profile, custom) {
  if (profile === "custom") {
    const imap = endpoint(custom && custom.imap, 993);
    const smtp = endpoint(custom && custom.smtp, 465);
    if (!imap || !smtp) return null;
    return { imap, smtp };
  }
  const known = HOSTS[profile];
  if (!known) return null;
  return {
    imap: { ...known.imap },
    smtp: { ...known.smtp },
  };
}

module.exports = { CARDS, HOSTS, endpointsFor };
