const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { simpleParser } = require("mailparser");
const { isRateLimit } = require("./provider-http");

const SOURCE_CAP = 96 * 1024;
const FULL_CAP = 3 * 1024 * 1024;

function explain(error, secret) {
  let message = error instanceof Error ? error.message : String(error || "");
  if (secret && message.includes(secret)) message = message.split(secret).join("");
  if (/auth|invalid credentials|LOGIN failed|AUTHENTICATIONFAILED|535|Invalid login/i.test(message)) {
    return "The server rejected the credentials. Gmail/iCloud need an app password, or use Google/Microsoft OAuth. Outlook.com has mostly turned off password sign-in.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "The mail server address could not be found.";
  if (/certificate|self signed|UNABLE_TO_VERIFY/i.test(message)) return "The server certificate could not be verified.";
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Greeting/i.test(message)) return "Could not reach the mail server.";
  return message.replace(/\s+/g, " ").trim().slice(0, 280) || "The mail server refused the connection.";
}


function makeClient(account, secret) {
  const tls = account.imap_tls === 1;
  const secure = tls && account.imap_port !== 143;
  const auth = account.auth_kind === "oauth2"
    ? { user: account.username, accessToken: secret }
    : { user: account.username, pass: secret };
  return new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure,
    doSTARTTLS: tls && !secure,
    auth,
    logger: false,
    emitLogs: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 45000,
    tls: { rejectUnauthorized: true },
  });
}

async function withClient(account, password, fn) {
  const client = makeClient(account, password);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

function transport(account, secret) {
  const tls = account.smtp_tls === 1;
  const secure = tls && account.smtp_port === 465;
  const auth = account.auth_kind === "oauth2"
    ? { type: "OAuth2", user: account.username, accessToken: secret }
    : { user: account.username, pass: secret };
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure,
    requireTLS: tls && !secure,
    ignoreTLS: !tls,
    auth,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: true },
  });
}

async function verifySmtp(account, password) {
  const client = transport(account, password);
  try {
    await client.verify();
  } finally {
    client.close();
  }
}

function formatAddress(entry) {
  if (!entry) return "";
  const address = entry.address || entry.email || "";
  const name = entry.name || "";
  if (name && address) return `${name} <${address}>`;
  return address || name;
}

function formatList(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map(formatAddress).filter(Boolean);
}

function walkParts(node, out, inRelated) {
  if (!node || typeof node !== "object") return;
  const filename = (node.dispositionParameters && node.dispositionParameters.filename)
    || (node.parameters && (node.parameters.name || node.parameters.filename))
    || "";
  const type = node.type || "application/octet-stream";
  const disposition = node.disposition || "";
  const inlineFile = disposition === "inline" && node.id && !String(type).startsWith("text/");
  if (disposition === "attachment" || filename || type === "text/calendar" || inlineFile) {
    out.push({
      id: node.part || "1",
      filename: filename || `attachment-${node.part || "1"}`,
      mimeType: type,
      size: node.size || 0,
      isInlineFromApi: disposition === "inline" || (inRelated && !!node.id && disposition !== "attachment"),
      contentId: node.id ? String(node.id).replace(/^<|>$/g, "") : null,
    });
    return;
  }
  const related = type === "multipart/related";
  for (const child of node.childNodes || []) walkParts(child, out, related || inRelated);
}

function attachmentsOf(structure) {
  const out = [];
  walkParts(structure, out, false);
  return out;
}

function hasFileAttachment(attachments) {
  return attachments.some((item) => {
    const type = (item.mimeType || "").toLowerCase();
    const embedded = item.isInlineFromApi && type.startsWith("image/");
    return !embedded;
  });
}

function snippetOf(text, html) {
  const raw = text || String(html || "").replace(/<[^>]+>/g, " ");
  return raw.replace(/\s+/g, " ").trim().slice(0, 180);
}

function threadIdOf(parsed, envelope, fallback) {
  const refs = parsed && parsed.references;
  const list = Array.isArray(refs) ? refs : (typeof refs === "string" && refs ? [refs] : []);
  const root = list[0] || (parsed && parsed.inReplyTo) || (envelope && (envelope.inReplyTo || envelope.messageId));
  if (!root) return fallback;
  return `thr:${String(root).replace(/[<>\s]/g, "").slice(0, 180)}`;
}

async function parseSource(source, truncated) {
  if (!source || !source.length) return null;
  try {
    const parsed = await simpleParser(source);
    return {
      html: typeof parsed.html === "string" ? parsed.html : null,
      text: typeof parsed.text === "string" ? parsed.text : null,
      messageId: parsed.messageId || null,
      inReplyTo: parsed.inReplyTo || null,
      references: parsed.references || null,
      complete: !truncated,
    };
  } catch {
    const text = source.toString("utf8");
    const body = text.split(/\r?\n\r?\n/).slice(1).join("\n").replace(/<[^>]+>/g, " ");
    return {
      html: null,
      text: body.replace(/\s+/g, " ").trim().slice(0, 2000),
      messageId: null,
      inReplyTo: null,
      references: null,
      complete: false,
    };
  }
}

function wellKnownOf(box) {
  const special = box.specialUse || "";
  const mapped = {
    "\\Inbox": "inbox",
    "\\Sent": "sentitems",
    "\\Drafts": "drafts",
    "\\Trash": "deleteditems",
    "\\Junk": "junkemail",
    "\\Archive": "archive",
  }[special];
  if (mapped) return mapped;
  if (String(box.path || "").toUpperCase() === "INBOX") return "inbox";
  const name = String(box.name || box.path || "").toLowerCase();
  if (name === "sent" || name === "sent items" || name === "sent mail") return "sentitems";
  if (name === "drafts" || name === "draft") return "drafts";
  if (name === "trash" || name === "deleted" || name === "deleted items" || name === "deleted messages" || name === "bin") {
    return "deleteditems";
  }
  if (name === "junk" || name === "spam" || name === "junk email" || name === "junk mail") return "junkemail";
  if (name === "archive" || name === "archives") return "archive";
  return null;
}

function skipBox(box) {
  const special = box.specialUse || "";
  if (special === "\\All" || special === "\\Flagged" || special === "\\Important") return true;
  const flags = box.flags;
  if (flags && typeof flags.has === "function" && (flags.has("\\Noselect") || flags.has("\\NonExistent"))) return true;
  return false;
}

async function listFolderRecords(client) {
  const boxes = await client.list();
  const delimiter = (boxes.find((box) => box.delimiter) || {}).delimiter || "/";
  const folders = [];
  for (const box of boxes) {
    if (!box.path || skipBox(box)) continue;
    folders.push({
      path: box.path,
      name: box.name || box.path,
      wellKnown: wellKnownOf(box),
      delimiter: box.delimiter || delimiter,
    });
  }
  if (!folders.some((folder) => folder.wellKnown === "inbox")) {
    folders.unshift({ path: "INBOX", name: "Inbox", wellKnown: "inbox", delimiter });
  }
  return { folders, delimiter };
}

async function readFetched(msg, validity, cap) {
  const envelope = msg.envelope || {};
  const source = msg.source ? Buffer.from(msg.source) : null;
  const limit = cap || SOURCE_CAP;
  const truncated = !!(source && source.length >= limit - 1);
  const parsed = await parseSource(source, truncated);
  const attachments = attachmentsOf(msg.bodyStructure);
  const flags = msg.flags;
  const seen = !!(flags && flags.has("\\Seen"));
  const when = envelope.date instanceof Date
    ? envelope.date
    : (msg.internalDate instanceof Date ? msg.internalDate : new Date());
  const uid = Number(msg.uid);
  return {
    uid,
    threadId: threadIdOf(parsed, envelope, `thr:${validity}:${uid}`),
    rfcMessageId: (parsed && parsed.messageId) || envelope.messageId || null,
    inReplyTo: (parsed && parsed.inReplyTo) || envelope.inReplyTo || null,
    subject: envelope.subject || "",
    snippet: snippetOf(parsed && parsed.text, parsed && parsed.html),
    from: formatList(envelope.from).join(", "),
    to: formatList(envelope.to),
    cc: formatList(envelope.cc),
    bcc: formatList(envelope.bcc),
    date: when.toISOString(),
    listSortTs: when.getTime(),
    unread: !seen,
    starred: !!(flags && flags.has("\\Flagged")),
    isDraft: !!(flags && flags.has("\\Draft")),
    hasAttachments: hasFileAttachment(attachments),
    htmlBody: parsed && parsed.html,
    textBody: parsed && parsed.text,
    attachments,
    bodyComplete: !!(parsed && parsed.complete),
  };
}

function throwRate(error) {
  if (!isRateLimit(error)) return;
  if (error && typeof error === "object") {
    error.code = "rate_limit";
    error.status = error.status || 429;
  }
  throw error;
}

const FETCH_FIELDS = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  source: { maxLength: SOURCE_CAP },
};

async function searchUids(client, folderPath, query) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    const box = client.mailbox || {};
    const validity = Number(box.uidValidity) || 0;
    let uids = [];
    try {
      const criteria = query && Object.keys(query).length ? query : { all: true };
      uids = await client.search(criteria, { uid: true });
    } catch (error) {
      throwRate(error);
      throw error;
    }
    return {
      uids: (uids || []).map(Number).filter((uid) => uid > 0),
      validity,
      exists: Number(box.exists) || 0,
      unseen: typeof box.unseen === "number" ? box.unseen : null,
    };
  } finally {
    lock.release();
  }
}

async function fetchMessages(client, folderPath, uids) {
  const list = (uids || []).map(Number).filter((uid) => uid > 0);
  const lock = await client.getMailboxLock(folderPath);
  try {
    const validity = Number((client.mailbox || {}).uidValidity) || 0;
    if (!list.length) return { messages: [], validity };
    const messages = [];
    try {
      for await (const msg of client.fetch(list.join(","), FETCH_FIELDS, { uid: true })) {
        messages.push(await readFetched(msg, validity));
      }
    } catch (error) {
      throwRate(error);
      throw error;
    }
    return { messages, validity };
  } finally {
    lock.release();
  }
}

async function syncFolder(client, folderPath, options) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    const box = client.mailbox || {};
    const validity = Number(box.uidValidity) || 0;
    const exists = Number(box.exists) || 0;
    let uids = null;
    try {
      uids = await client.search({ all: true }, { uid: true });
    } catch (error) {
      throwRate(error);
      uids = null;
    }
    const limit = options.limit || 80;
    let range = null;
    let byUid = false;
    if (options.before) {
      const found = await client.search({ before: new Date(options.before) }, { uid: true });
      const picked = (found || []).map(Number).sort((a, b) => b - a).slice(0, limit);
      if (!picked.length) {
        return { messages: [], validity, exists, unseen: box.unseen, uids, exhausted: true };
      }
      range = picked.join(",");
      byUid = true;
    } else if (exists > 0) {
      const start = Math.max(1, exists - limit + 1);
      range = `${start}:*`;
    }
    const messages = [];
    if (range) {
      const query = {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        source: { maxLength: SOURCE_CAP },
      };
      for await (const msg of client.fetch(range, query, { uid: byUid })) {
        messages.push(await readFetched(msg, validity));
      }
    }
    return {
      messages,
      validity,
      exists,
      unseen: typeof box.unseen === "number" ? box.unseen : null,
      uids: Array.isArray(uids) ? uids.map(Number) : null,
      exhausted: false,
    };
  } finally {
    lock.release();
  }
}

async function fetchSource(client, folderPath, uid) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    for await (const msg of client.fetch(String(uid), {
      uid: true,
      source: { maxLength: FULL_CAP },
      bodyStructure: true,
      flags: true,
      envelope: true,
      internalDate: true,
    }, { uid: true })) {
      return readFetched(msg, Number((client.mailbox || {}).uidValidity) || 0, FULL_CAP);
    }
    return null;
  } finally {
    lock.release();
  }
}

async function readPart(client, folderPath, uid, part) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    const downloaded = await client.download(String(uid), part || "1", { uid: true });
    if (!downloaded || !downloaded.content) return Buffer.alloc(0);
    const chunks = [];
    for await (const chunk of downloaded.content) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    lock.release();
  }
}

async function moveUid(client, folderPath, uid, destination) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    const moved = await client.messageMove(String(uid), destination, { uid: true });
    const next = moved && moved.uidMap && moved.uidMap.get(Number(uid));
    let validity = null;
    try {
      const status = await client.status(destination, { uidValidity: true });
      validity = status && status.uidValidity ? Number(status.uidValidity) : null;
    } catch {
      validity = null;
    }
    return { uid: next ? Number(next) : Number(uid), uidValidity: validity };
  } finally {
    lock.release();
  }
}

async function changeFlags(client, folderPath, uid, add, remove) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
  } finally {
    lock.release();
  }
}

async function removeUid(client, folderPath, uid) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    await client.messageDelete(String(uid), { uid: true });
  } finally {
    lock.release();
  }
}

async function createBox(client, folderPath) {
  await client.mailboxCreate(folderPath);
}

async function appendRaw(client, folderPath, raw, flags) {
  return client.append(folderPath, raw, flags, new Date());
}

async function searchTextUids(client, needle, gmail) {
  if (gmail) {
    try {
      return await client.search({ gmraw: needle }, { uid: true });
    } catch (error) {
      throwRate(error);
    }
    try {
      return await client.search({ gmRaw: needle }, { uid: true });
    } catch (error) {
      throwRate(error);
    }
  }
  return client.search({ text: needle }, { uid: true });
}

async function findText(client, folderPath, text, limit, options) {
  const needle = String(text || "").trim();
  if (!needle) return null;
  const lock = await client.getMailboxLock(folderPath);
  try {
    let uids = [];
    try {
      uids = await searchTextUids(client, needle, !!(options && options.gmail));
    } catch (error) {
      throwRate(error);
      return null;
    }
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const picked = (uids || []).map(Number).filter((uid) => uid > 0).sort((a, b) => b - a).slice(0, cap);
    const validity = Number((client.mailbox || {}).uidValidity) || 0;
    if (!picked.length) return { messages: [], validity, searched: true };
    const messages = [];
    try {
      for await (const msg of client.fetch(picked.join(","), {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        source: { maxLength: SOURCE_CAP },
      }, { uid: true })) {
        messages.push(await readFetched(msg, validity));
      }
    } catch (error) {
      throwRate(error);
      throw error;
    }
    return { messages, validity, searched: true };
  } finally {
    lock.release();
  }
}

async function buildRaw(options) {
  const composer = new MailComposer(options);
  return composer.compile().build();
}

async function sendSmtp(account, password, options) {
  const client = transport(account, password);
  try {
    return await client.sendMail(options);
  } finally {
    client.close();
  }
}

module.exports = {
  explain,
  withClient,
  verifySmtp,
  listFolderRecords,
  syncFolder,
  searchUids,
  fetchMessages,
  fetchSource,
  readPart,
  moveUid,
  changeFlags,
  removeUid,
  createBox,
  appendRaw,
  findText,
  buildRaw,
  sendSmtp,
  walkParts,
  snippetOf,
  formatList,
  hasFileAttachment,
};
