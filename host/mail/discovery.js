// Add-account server discovery. Same order as neverest's wizard, without
// the steps this mail client does not use: known domain, then one MX lookup,
// Thunderbird autoconfig (ISP, /.well-known, ISPDB), then RFC 6186 SRV.
// Skipped: PACC, JMAP, CalDAV, CardDAV, and Proton Bridge (it is loopback-only).

const dns = require("dns").promises;
const presets = require("./presets");

const DOMAINS = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "myyahoo.com": "yahoo",
  "yahoo.ca": "yahoo",
  "yahoo.de": "yahoo",
  "yahoo.it": "yahoo",
  "yahoo.fr": "yahoo",
  "yahoo.es": "yahoo",
  "yahoo.se": "yahoo",
  "yahoo.co.in": "yahoo",
  "yahoo.co.uk": "yahoo",
  "yahoo.co.nz": "yahoo",
  "yahoo.com.au": "yahoo",
  "yahoo.com.ar": "yahoo",
  "yahoo.com.br": "yahoo",
  "yahoo.com.mx": "yahoo",
  "yahoo.com.hk": "yahoo",
  "cox.net": "yahoo",
  "yahoo.co.jp": "yahoo_jp",
  "fastmail.com": "fastmail",
  "fastmail.fm": "fastmail",
  "qq.com": "qq",
  "naver.com": "naver",
  "daum.net": "daum",
  "hanmail.net": "hanmail",
  "kakao.com": "kakao",
  "aol.com": "aol",
  "aim.com": "aol",
  "zoho.com": "zoho",
  "zohomail.com": "zoho",
};

const MX_SUFFIXES = [
  ["yahoodns.net", "yahoo"],
  ["messagingengine.com", "fastmail"],
  ["mail.icloud.com", "icloud"],
  ["icloud.com", "icloud"],
  ["zoho.com", "zoho"],
  ["aol.com", "aol"],
];

const APP_PASSWORD_PROFILES = new Set(["yahoo", "yahoo_jp", "aol"]);

function domainOf(email) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || value.indexOf("@") !== at) return "";
  const domain = value.slice(at + 1);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain)) return "";
  return domain;
}

function profileForEmail(email) {
  const domain = domainOf(email);
  return domain && DOMAINS[domain] || "";
}

function chosenProfile(requested, email) {
  const profile = String(requested || "custom");
  if (profile === "custom") return "custom";
  return profileForEmail(email) || profile;
}

function loginName(profile, email, username) {
  const address = String(email || "").trim();
  const typed = String(username || "").trim();
  if (!typed) return address;
  if (APP_PASSWORD_PROFILES.has(profile) && !typed.includes("@")) return address;
  return typed;
}

function profileForMx(host) {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!name) return "";
  for (const [suffix, profile] of MX_SUFFIXES) {
    if (name === suffix || name.endsWith("." + suffix)) return profile;
  }
  return "";
}

function publicHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(value)) return "";
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return "";
  return value;
}

function fromProfile(profile, source) {
  const endpoints = presets.endpointsFor(profile);
  if (!endpoints) return null;
  return { profile, source, imap: endpoints.imap, smtp: endpoints.smtp };
}

function tags(block, name) {
  const out = [];
  const re = new RegExp("<" + name + "\\b[^>]*>([^<]*)</" + name + ">", "gi");
  let match;
  while ((match = re.exec(block))) out.push(match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").trim());
  return out;
}

function serversOf(xml) {
  const out = [];
  const re = /<(incomingServer|outgoingServer)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(String(xml || "")))) {
    const type = (/type\s*=\s*"([^"]+)"/i.exec(match[2]) || [])[1] || "";
    out.push({
      kind: match[1].toLowerCase() === "outgoingserver" ? "smtp" : "imap",
      type: type.toLowerCase(),
      host: tags(match[3], "hostname")[0] || "",
      port: Number(tags(match[3], "port")[0]) || 0,
      socket: (tags(match[3], "socketType")[0] || "").toUpperCase(),
      auth: tags(match[3], "authentication").map((item) => item.toLowerCase()),
    });
  }
  return out;
}

function passwordAuth(server) {
  if (!server.auth.length) return true;
  return server.auth.some((item) => item === "password-cleartext" || item === "password-encrypted" || item === "plain");
}

function endpointFrom(server) {
  const host = publicHost(server.host);
  if (!host || !passwordAuth(server)) return null;
  const ssl = server.socket === "SSL" || server.socket === "SSL/TLS";
  const starttls = server.socket === "STARTTLS";
  let port = server.port;
  if (!port) port = server.kind === "smtp" ? (ssl ? 465 : 587) : (ssl ? 993 : 143);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host, port, tls: ssl || starttls };
}

function fromXml(xml) {
  const servers = serversOf(xml);
  const imapServer = servers.find((server) => server.kind === "imap" && server.type === "imap" && endpointFrom(server));
  const smtpServer = servers.find((server) => server.kind === "smtp" && server.type === "smtp" && endpointFrom(server));
  const imap = imapServer ? endpointFrom(imapServer) : null;
  const smtp = smtpServer ? endpointFrom(smtpServer) : null;
  if (!imap && !smtp) return null;
  return { profile: "", source: "autoconfig", imap, smtp };
}

function abortSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function readXml(url, fetchImpl) {
  if (!String(url).startsWith("https://")) return "";
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: abortSignal(3000),
      headers: { accept: "application/xml, text/xml" },
    });
    if (!response || response.ok === false) return "";
    const finalUrl = String(response.url || url);
    if (!finalUrl.startsWith("https://")) return "";
    const text = typeof response.text === "function" ? await response.text() : "";
    if (!text || text.length > 80000 || !text.includes("<clientConfig")) return "";
    return text;
  } catch {
    return "";
  }
}

async function autoconfig(email, domain, fetchImpl) {
  const address = encodeURIComponent(email);
  const urls = [
    "https://autoconfig." + domain + "/mail/config-v1.1.xml?emailaddress=" + address,
    "https://" + domain + "/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=" + address,
    "https://autoconfig.thunderbird.net/v1.1/" + domain,
  ];
  for (const url of urls) {
    const xml = await readXml(url, fetchImpl);
    const found = xml ? fromXml(xml) : null;
    if (found) return found;
  }
  return null;
}

async function timed(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, ms);
    Promise.resolve(promise).then((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function mxHost(domain, resolveMx) {
  const rows = await timed(resolveMx(domain), 2000);
  if (!Array.isArray(rows) || !rows.length) return "";
  rows.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  return String(rows[0].exchange || "");
}

async function firstSrv(resolveSrv, name) {
  let rows;
  try {
    rows = await timed(resolveSrv(name), 2000);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  rows.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || (Number(b.weight) || 0) - (Number(a.weight) || 0));
  const host = publicHost(rows[0].name);
  const port = Number(rows[0].port);
  if (!host || !port) return null;
  return { host, port };
}

async function fromSrv(domain, resolveSrv) {
  const imaps = await firstSrv(resolveSrv, "_imaps._tcp." + domain);
  const imap = imaps || await firstSrv(resolveSrv, "_imap._tcp." + domain);
  const submissions = await firstSrv(resolveSrv, "_submissions._tcp." + domain);
  const submission = submissions || await firstSrv(resolveSrv, "_submission._tcp." + domain);
  if (!imap && !submission) return null;
  return {
    profile: "",
    source: "srv",
    imap: imap ? { host: imap.host, port: imap.port, tls: true } : null,
    smtp: submission ? { host: submission.host, port: submission.port, tls: true } : null,
  };
}

async function discover(email, options) {
  const address = String(email || "").trim();
  const domain = domainOf(address);
  if (!domain) return null;
  const deps = options || {};
  const known = DOMAINS[domain];
  if (known) return fromProfile(known, "known");
  const resolveMx = deps.resolveMx || dns.resolveMx;
  const resolveSrv = deps.resolveSrv || dns.resolveSrv;
  const fetchImpl = deps.fetch || global.fetch;
  try {
    const viaMx = profileForMx(await mxHost(domain, resolveMx));
    if (viaMx) return fromProfile(viaMx, "mx");
  } catch { /* MX is optional */ }
  if (typeof fetchImpl === "function") {
    const found = await autoconfig(address, domain, fetchImpl);
    if (found) return found;
  }
  try {
    return await fromSrv(domain, resolveSrv);
  } catch {
    return null;
  }
}

module.exports = {
  discover,
  profileForEmail,
  chosenProfile,
  loginName,
  profileForMx,
  fromXml,
};
