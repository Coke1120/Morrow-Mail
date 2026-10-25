const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { simpleParser } = require("mailparser");
const { isRateLimit } = require("./provider-http");
const mailboxRoles = require("../../shared/mailbox-roles");
const textEncoding = require("./text-encoding");

const SOURCE_CAP = 96 * 1024;
const FULL_CAP = 3 * 1024 * 1024;
const clientErrors = new WeakMap();

function connectionError(client, error) {
  // ImapFlow closes after emitting an error, rejecting pending commands with
  // NoConnection. Keep the cause for normal operation reporting and retries.
  return error && error.code === "NoConnection" && clientErrors.has(client)
    ? clientErrors.get(client) : error;
}

function isYahooAuth(account) {
  if (!account || typeof account !== "object") return false;
  const profile = String(account.profile || "").toLowerCase();
  if (profile === "yahoo" || profile === "yahoo_jp") return true;
  const host = String(account.imap_host || account.imapHost || account.smtp_host || account.smtpHost || "").toLowerCase();
  return host.endsWith(".yahoo.com") || host.endsWith(".yahoo.co.jp") || host.includes("imap.mail.yahoo") || host.includes("smtp.mail.yahoo");
}

// Yahoo and AOL advertise SASL-IR + AUTH=PLAIN, then answer a second empty
// challenge when PLAIN is sent without the initial response. ImapFlow waits
// on that challenge, so the login never finishes. LOGIN completes instead.
function usesImapLogin(account) {
  if (!account || account.auth_kind === "oauth2" || account.authKind === "oauth2") return false;
  const profile = String(account.profile || "").toLowerCase();
  if (profile === "yahoo" || profile === "yahoo_jp" || profile === "aol") return true;
  const host = String(account.imap_host || account.imapHost || "").toLowerCase();
  return host === "imap.aol.com" || host.endsWith(".yahoo.com") || host.endsWith(".yahoo.co.jp") || host.includes("imap.mail.yahoo");
}

function imapAuth(account, secret) {
  if (account && (account.auth_kind === "oauth2" || account.authKind === "oauth2")) {
    return { user: account.username, accessToken: secret };
  }
  const auth = { user: account && account.username, pass: secret };
  if (usesImapLogin(account)) auth.loginMethod = "LOGIN";
  return auth;
}

function explain(error, secret, account) {
  const parts = [error instanceof Error ? error.message : String(error || "")];
  if (error && typeof error === "object") {
    if (error.responseText) parts.push(String(error.responseText));
    if (error.response) parts.push(String(error.response));
    if (error.serverResponseCode) parts.push(String(error.serverResponseCode));
  }
  let message = parts.filter(Boolean).join(" ");
  if (secret && message.includes(secret)) message = message.split(secret).join("");
  const authFailed = error && error.authenticationFailed === true
    || /auth|invalid credentials|LOGIN failed|AUTHENTICATIONFAILED|535|Invalid login/i.test(message);
  if (authFailed) {
    if (isYahooAuth(account)) {
      return "Yahoo rejected the password. Generate an app password in Yahoo Account Security (Generate app password) and paste it here. The regular account password is rejected.";
    }
    return "The server rejected the credentials. Gmail/iCloud need an app password, or use Google/Microsoft OAuth. Outlook.com has mostly turned off password sign-in.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "The mail server address could not be found.";
  if (/certificate|self signed|UNABLE_TO_VERIFY/i.test(message)) return "The server certificate could not be verified.";
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Greeting/i.test(message)) return "Could not reach the mail server.";
  return message.replace(/\s+/g, " ").trim().slice(0, 280) || "The mail server refused the connection.";
}


function makeClient(account, secret, options) {
  const tls = account.imap_tls === 1;
  const secure = tls && account.imap_port !== 143;
  const auth = imapAuth(account, secret);
  const extra = options || {};
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure,
    doSTARTTLS: tls && !secure,
    auth,
    logger: false,
    emitLogs: false,
    disableAutoIdle: extra.disableAutoIdle === true,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: extra.socketTimeout || 45000,
    tls: { rejectUnauthorized: true },
  });
  // Socket events run outside our awaited commands. ImapFlow schedules close
  // and rejects those commands itself, but its error event still needs a
  // synchronous, nonthrowing owner, including between IDLE calls and at logout.
  // Retain this listener through close; a late event must not become uncaught.
  client.on("error", (error) => {
    if (error && !clientErrors.has(client)) clientErrors.set(client, error);
  });
  return client;
}

async function withClient(account, password, fn) {
  const client = makeClient(account, password);
  try {
    await client.connect();
    return await fn(client);
  } catch (error) {
    throw connectionError(client, error);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

// Longer than the 25 minute IDLE renew, shorter than a dead socket sitting forever.
// maxIdleTime stays unset so a DONE returns from idle() instead of looping inside ImapFlow.
const IDLE_SOCKET_MS = 28 * 60 * 1000;

function settleIdle(client, resolve, reject) {
  let finished = false;
  const finish = (fn, value) => {
    if (finished) return;
    finished = true;
    client.off("close", onClose);
    client.off("error", onError);
    fn(value);
  };
  const onClose = () => finish(reject, Object.assign(new Error("IMAP IDLE connection closed"), { code: "closed" }));
  const onError = (error) => finish(reject, error || Object.assign(new Error("IMAP IDLE failed"), { code: "closed" }));
  client.on("close", onClose);
  client.on("error", onError);
  return finish;
}

async function openIdleClient(account, secret) {
  const client = makeClient(account, secret, {
    disableAutoIdle: true,
    socketTimeout: IDLE_SOCKET_MS,
  });
  try {
    await client.connect();
  } catch (error) {
    try { client.close(); } catch { /* already closed */ }
    throw connectionError(client, error);
  }
  return {
    capabilities() {
      return client.capabilities;
    },
    async select(path) {
      try { await client.mailboxOpen(path); }
      catch (error) { throw connectionError(client, error); }
    },
    idle() {
      return new Promise((resolve, reject) => {
        const finish = settleIdle(client, resolve, reject);
        client.idle().then((value) => {
          if (value === false) finish(reject, Object.assign(new Error("IDLE failed"), { code: "idle_failed" }));
          else finish(resolve, "done");
        }).catch((error) => finish(reject, connectionError(client, error)));
      });
    },
    async done() {
      try {
        if (typeof client.preCheck === "function") {
          await client.preCheck();
          return;
        }
      } catch { /* NOOP still ends a stuck IDLE */ }
      if (typeof client.noop === "function") await client.noop();
    },
    on(event, fn) {
      client.on(event === "fetch" ? "flags" : event, fn);
    },
    async logout() {
      try { await client.logout(); } catch { try { client.close(); } catch { /* already closed */ } }
    },
    close() {
      try { client.close(); } catch { /* already closed */ }
    },
  };
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
  if (special === "\\All") return "all";
  const mapped = {
    "\\Inbox": "inbox",
    "\\Sent": "sentitems",
    "\\Drafts": "drafts",
    "\\Trash": "deleteditems",
    "\\Junk": "junkemail",
    "\\Archive": "archive",
  }[special];
  if (mapped) return mapped;
  if (mailboxRoles.isGmailAllPath(box.path)) return "all";
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
  if (special === "\\Flagged" || special === "\\Important") return true;
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
  const presented = textEncoding.presentMessage({
    subject: envelope.subject || "",
    htmlBody: parsed && parsed.html,
    textBody: parsed && parsed.text,
  });
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
    subject: presented.subject,
    snippet: snippetOf(presented.textBody, presented.htmlBody),
    from: formatList(envelope.from).join(", "),
    to: formatList(envelope.to),
    cc: formatList(envelope.cc),
    bcc: formatList(envelope.bcc),
    recipientHeaders: require("./recipient-headers").recipientHeaders(source),
    date: when.toISOString(),
    listSortTs: when.getTime(),
    unread: !seen,
    starred: !!(flags && flags.has("\\Flagged")),
    isDraft: !!(flags && flags.has("\\Draft")),
    hasAttachments: hasFileAttachment(attachments),
    htmlBody: presented.htmlBody,
    textBody: presented.textBody,
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

async function searchUids(client, folderPath, query, flagPage) {
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
    const flags = [];
    // Share the selection/lock with UID reconciliation. Never fetch bodies for
    // this rotating page, or apply flags from a different mailbox generation.
    if (flagPage && validity === Number(flagPage.validity) && validity > 0) {
      const wanted = new Set((flagPage.uids || []).filter((uid) => Number.isSafeInteger(uid) && uid > 0).slice(0, 200));
      if (wanted.size) {
        for await (const message of client.fetch([...wanted].join(","), { uid: true, flags: true }, { uid: true })) {
          const uid = Number(message.uid);
          if (!wanted.has(uid) || !(message.flags instanceof Set)) continue;
          flags.push({ uid, unread: !message.flags.has("\\Seen"), starred: message.flags.has("\\Flagged") });
        }
      }
    }
    return {
      uids: (uids || []).map(Number).filter((uid) => uid > 0),
      validity,
      flags,
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

async function fetchSource(client, folderPath, uid, expectedValidity) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    assertUidValidity(client, expectedValidity);
    // Untagged FETCH rows for other messages, or a flags-only row, can arrive
    // before the requested source. Taking the first row stores the wrong mail
    // (ImapFlow fetchOne, issue #426).
    const requested = Number(uid);
    let matched = null;
    for await (const msg of client.fetch(String(uid), {
      uid: true,
      source: { maxLength: FULL_CAP },
      bodyStructure: true,
      flags: true,
      envelope: true,
      internalDate: true,
    }, { uid: true })) {
      if (!msg || !Number.isFinite(requested) || Number(msg.uid) !== requested) continue;
      matched = matched ? Object.assign(matched, msg) : { ...msg };
    }
    // A flags-only row for this UID is not the message source. Leave the stored body alone.
    if (!matched || matched.source == null) return null;
    return readFetched(matched, Number((client.mailbox || {}).uidValidity) || 0, FULL_CAP);
  } finally {
    lock.release();
  }
}

async function readPart(client, folderPath, uid, part, expectedValidity) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    assertUidValidity(client, expectedValidity);
    const downloaded = await client.download(String(uid), part || "1", { uid: true });
    if (!downloaded || !downloaded.content) return Buffer.alloc(0);
    const chunks = [];
    for await (const chunk of downloaded.content) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    lock.release();
  }
}

function assertUidValidity(client, expected) {
  const actual = Number(client.mailbox && client.mailbox.uidValidity);
  if (Number.isSafeInteger(Number(expected)) && Number(expected) > 0 && actual === Number(expected)) return;
  const error = new Error("This folder changed on the server. No message was changed. Sync the folder and try again.");
  error.code = "uid_validity_changed";
  error.operationIssued = false;
  throw error;
}

async function moveUid(client, folderPath, uid, destination, expectedValidity) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    assertUidValidity(client, expectedValidity);
    const moved = await client.messageMove(String(uid), destination, { uid: true });
    const next = Number(moved && moved.uidMap && moved.uidMap.get(Number(uid)));
    // COPYUID binds these two values to the same destination generation. A
    // later STATUS could refer to a recreated mailbox and cannot supply it.
    const validity = Number(moved && moved.uidValidity);
    if (!Number.isSafeInteger(next) || next <= 0 || !Number.isSafeInteger(validity) || validity <= 0) {
      throw new Error("Move outcome is unknown: the server did not confirm the destination identity. Refresh before acting again.");
    }
    return { uid: next, uidValidity: validity };
  } finally {
    lock.release();
  }
}

async function changeFlags(client, folderPath, uid, add, remove, expectedValidity) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    assertUidValidity(client, expectedValidity);
    if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
  } finally {
    lock.release();
  }
}

async function removeUid(client, folderPath, uid, expectedValidity) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    assertUidValidity(client, expectedValidity);
    await client.messageDelete(String(uid), { uid: true });
  } finally {
    lock.release();
  }
}

async function checkUidValidity(client, folderPath, expectedValidity) {
  const lock = await client.getMailboxLock(folderPath);
  try { assertUidValidity(client, expectedValidity); }
  finally { lock.release(); }
}

async function createBox(client, folderPath) {
  await client.mailboxCreate(folderPath);
}

async function renameBox(client, fromPath, toPath) {
  await client.mailboxRename(fromPath, toPath);
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

function classifyImapSearchError(error) {
  if (!error || typeof error !== "object") return error;
  const text = `${error.message || ""} ${error.responseText || ""} ${error.response || ""}`;
  if (/NONEXISTENT|does not exist|Unknown Mailbox|Mailbox doesn't exist|TRYCREATE/i.test(text)) {
    error.code = "mailbox_missing";
    return error;
  }
  const status = String(error.responseStatus || "");
  if (status === "NO" || status === "BAD" || /unsupported|not supported|unknown command/i.test(text)) {
    error.code = "search_unsupported";
  }
  return error;
}

async function searchFromUids(client, address, gmail) {
  const needle = `from:${address}`;
  if (gmail) {
    try {
      return await client.search({ gmraw: needle }, { uid: true });
    } catch (error) {
      throwRate(error);
      classifyImapSearchError(error);
      if (error && error.code === "mailbox_missing") throw error;
    }
    try {
      return await client.search({ gmRaw: needle }, { uid: true });
    } catch (error) {
      throwRate(error);
      classifyImapSearchError(error);
      throw error;
    }
  }
  try {
    return await client.search({ from: address }, { uid: true });
  } catch (error) {
    throwRate(error);
    classifyImapSearchError(error);
    throw error;
  }
}

async function findFrom(client, folderPath, address, limit, options) {
  const addr = String(address || "").trim();
  if (!addr) return null;
  let lock;
  try {
    lock = await client.getMailboxLock(folderPath);
  } catch (error) {
    throwRate(error);
    classifyImapSearchError(error);
    throw error;
  }
  try {
    let uids = [];
    try {
      uids = await searchFromUids(client, addr, !!(options && options.gmail));
    } catch (error) {
      throwRate(error);
      classifyImapSearchError(error);
      throw error;
    }
    const before = Number(options && options.beforeUid) || 0;
    let list = (uids || []).map(Number).filter((uid) => uid > 0);
    if (before > 0) list = list.filter((uid) => uid < before);
    list.sort((a, b) => b - a);
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 50);
    const more = list.length > cap;
    const picked = list.slice(0, cap);
    const lowestUid = picked.length ? picked[picked.length - 1] : 0;
    const validity = Number((client.mailbox || {}).uidValidity) || 0;
    if (!picked.length) return { messages: [], validity, searched: true, more: false, lowestUid: 0 };
    const messages = [];
    try {
      for await (const msg of client.fetch(picked.join(","), FETCH_FIELDS, { uid: true })) {
        messages.push(await readFetched(msg, validity));
      }
    } catch (error) {
      throwRate(error);
      throw error;
    }
    return { messages, validity, searched: true, more, lowestUid };
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
  GMAIL_ALL_PATHS: mailboxRoles.GMAIL_ALL_PATHS,
  isGmailAllPath: mailboxRoles.isGmailAllPath,
  isAllMail: mailboxRoles.isAllMail,
  allMailLabel: mailboxRoles.allMailLabel,
  explain,
  imapAuth,
  usesImapLogin,
  withClient,
  openIdleClient,
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
  checkUidValidity,
  createBox,
  renameBox,
  appendRaw,
  findText,
  findFrom,
  buildRaw,
  sendSmtp,
  walkParts,
  snippetOf,
  formatList,
  hasFileAttachment,
};
