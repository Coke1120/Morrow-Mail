const { simpleParser } = require("mailparser");
const { createGmailMailApi } = require("./gmail-mail-api");
const db = require("./db");
const { isGmail } = require("./gmail-policy");
const { recipientHeaders } = require("./recipient-headers");
const textEncoding = require("./text-encoding");
const ALL = "__gmail_all__";
const SYSTEM = { INBOX: ["INBOX", "Inbox", "inbox"], SENT: ["[Gmail]/Sent Mail", "Sent", "sentitems"],
  DRAFT: ["[Gmail]/Drafts", "Drafts", "drafts"], TRASH: ["[Gmail]/Trash", "Trash", "deleteditems"], SPAM: ["[Gmail]/Spam", "Spam", "junkemail"] };
const VIRTUAL = new Set(["UNREAD", "STARRED", "IMPORTANT", "CHAT"]);
const migrated = account => isGmail(account) && account.auth_kind === "oauth2" && account.mail_transport === "gmail_api";
const ambiguous = () => Object.assign(new Error("This cached Gmail message cannot be matched uniquely. No mail was changed; keep the local copy and review it in Gmail."), { code: "gmail_identity_ambiguous", operationIssued: false });
function header(part, name) { return (part?.headers || []).find(value => String(value.name).toLowerCase() === name.toLowerCase())?.value || ""; }
function parts(root) {
  const result = [];
  function visit(part) { if (!part || typeof part !== "object") return; result.push(part); for (const child of part.parts || []) visit(child); }
  visit(root); return result;
}
function stringAddresses(value) { return (value?.value || []).map(row => row.name ? `${row.name} <${row.address}>` : row.address).filter(Boolean); }

function createSession(account, token, { api, check = () => {} } = {}) {
  const incarnation = account.gmail_generation;
  function alive() {
    check();
    const current = db.accountById(account.id);
    if (!migrated(current) || current.gmail_generation !== incarnation) throw Object.assign(new Error("This Gmail connection changed. Start the action again."), { code: "account_removed", operationIssued: false });
  }
  api ||= createGmailMailApi({ accessToken: async () => token, check: alive });
  const rfcChecks = new Map();
  async function folders() {
    alive();
    const labels = await api.labels();
    alive();
    const old = db.foldersFor(account.id);
    const records = [];
    for (const label of labels) {
      if (VIRTUAL.has(label.id)) continue;
      const well = SYSTEM[label.id];
      const previous = old.find(row => row.provider_id === label.id) || (well && old.find(row => row.well_known === well[2]));
      const path = well ? previous?.path || well[0] : label.name;
      if (previous && previous.path !== path && !old.some(row => row.path === path)) {
        db.rewriteFolderPaths(account.id, [{ from: previous.path, to: path, name: label.name }]);
      }
      records.push({ path, name: well ? well[1] : label.name, wellKnown: well ? well[2] : null, providerId: label.id, delimiter: "/" });
    }
    const all = old.find(row => row.well_known === "all");
    records.push({ path: all?.path || "[Gmail]/All Mail", name: "All Mail", wellKnown: "all", providerId: ALL, delimiter: "/" });
    return { folders: records, delimiter: "/" };
  }
  function folder(path) {
    const value = db.folderByPath(account.id, path);
    if (!value?.provider_id) throw Object.assign(new Error("This cached folder is not available from Gmail. Refresh the folder list; cached mail was retained."), { code: "not-found", operationIssued: false });
    return value;
  }
  function pathsFor(labels) {
    const ids = new Set(labels || []), visible = !ids.has("TRASH") && !ids.has("SPAM");
    return db.foldersFor(account.id).filter(row => ids.has(row.provider_id) || (row.provider_id === ALL && visible)).map(row => row.path);
  }
  async function uniqueRfc(rfc) {
    const bare = String(rfc || "").trim().replace(/^<|>$/g, "");
    if (!bare || bare.length > 998 || /[\s"\\]/.test(bare)) throw ambiguous();
    if (!rfcChecks.has(bare)) rfcChecks.set(bare, api.listMessages({ query: `rfc822msgid:${bare}`, includeSpamTrash: true, limit: 2 }));
    const result = await rfcChecks.get(bare);
    alive();
    if (result.nextPageToken || result.messages.length !== 1) throw ambiguous();
    return result.messages[0].id;
  }
  async function normalize(data, full = false) {
    alive();
    const list = parts(data.payload);
    const headers = (data.payload?.headers || []).filter(row => row && typeof row.name === "string" && typeof row.value === "string");
    const headerBytes = Buffer.from(headers.map(row => `${row.name}: ${row.value}`).join("\r\n") + "\r\n\r\n");
    const parsed = await simpleParser(headerBytes);
    const body = { text: [], html: [] }, attachments = [];
    let complete = true;
    for (const part of list) {
      if (part.parts?.length) continue;
      const type = String(part.mimeType || "application/octet-stream").toLowerCase();
      const disposition = header(part, "content-disposition");
      const file = !!part.filename || /attachment/i.test(disposition) || !["text/plain", "text/html"].includes(type);
      let bytes;
      if (typeof part.body?.data === "string") bytes = Buffer.from(part.body.data, "base64url");
      if (!file) {
        if (!bytes && part.body?.attachmentId && full) bytes = await api.attachment(data.id, part.body.attachmentId);
        if (!bytes && (part.body?.attachmentId || Number(part.body?.size) > 0)) { complete = false; continue; }
        const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(header(part, "content-type"))?.[1] || "utf-8";
        const text = new TextDecoder(charset).decode(bytes || Buffer.alloc(0));
        body[type === "text/html" ? "html" : "text"].push(text);
      } else {
        const contentId = header(part, "content-id").replace(/^<|>$/g, "");
        attachments.push({ id: part.partId || "0", filename: part.filename || `attachment-${part.partId || "0"}`, mimeType: type,
          size: Number(part.body?.size) || 0, contentId: contentId || null, isInlineFromApi: !!contentId && !/attachment/i.test(disposition) });
      }
    }
    let html = body.html.join("\n") || null;
    // Inline images belong to the displayed body. Ordinary attachment files stay on demand.
    for (const attachment of attachments.filter(row => row.isInlineFromApi && row.mimeType.startsWith("image/"))) {
      if (!full) { complete = false; continue; }
      const part = list.find(row => (row.partId || "0") === attachment.id);
      let bytes = typeof part?.body?.data === "string" ? Buffer.from(part.body.data, "base64url") : null;
      if (!bytes && part?.body?.attachmentId) bytes = await api.attachment(data.id, part.body.attachmentId);
      if (bytes && html) html = html.split(`cid:${attachment.contentId}`).join(`data:${attachment.mimeType};base64,${bytes.toString("base64")}`);
    }
    alive();
    const presented = textEncoding.presentMessage({ subject: parsed.subject || "", htmlBody: html, textBody: body.text.join("\n") || null });
    const date = parsed.date instanceof Date && Number.isFinite(parsed.date.getTime()) ? parsed.date : new Date(Number(data.internalDate) || 0);
    const labels = data.labelIds || [];
    const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
    const root = references[0] || parsed.inReplyTo || parsed.messageId;
    return { providerId: data.id, providerThreadId: data.threadId, labelIds: labels, rfcMessageId: parsed.messageId || null,
      threadId: root ? `thr:${String(root).replace(/[<>\s]/g, "").slice(0, 180)}` : `gmail:${data.threadId || data.id}`,
      inReplyTo: parsed.inReplyTo || null, subject: presented.subject, from: stringAddresses(parsed.from).join(", "),
      to: stringAddresses(parsed.to), cc: stringAddresses(parsed.cc), bcc: stringAddresses(parsed.bcc), recipientHeaders: recipientHeaders(headerBytes),
      date: date.toISOString(), listSortTs: date.getTime(), snippet: data.snippet || textEncoding.htmlToPlain(presented.textBody || presented.htmlBody).replace(/\s+/g, " ").slice(0, 180),
      unread: labels.includes("UNREAD"), starred: labels.includes("STARRED"), isDraft: labels.includes("DRAFT"),
      hasAttachments: attachments.some(row => !row.isInlineFromApi || !row.mimeType.startsWith("image/")), attachments,
      htmlBody: presented.htmlBody, textBody: presented.textBody, bodyComplete: complete };
  }
  async function adopt(data, { full = false, after = null, cache = true } = {}) {
    const value = await normalize(data, full);
    const legacy = db.gmailLegacy(account.id, value.rfcMessageId);
    if (legacy.some(row => !row.draft_pending)) {
      if (await uniqueRfc(value.rfcMessageId) !== value.providerId) throw ambiguous();
      value.legacyVerified = true;
    }
    alive();
    const mapping = db.rememberGmail(account.id, value);
    const paths = pathsFor(value.labelIds);
    if (cache && (after == null || value.listSortTs >= after || db.gmailCopies(account.id, data.id).length)) {
      db.applyGmailMessage(account.id, paths, value);
      db.pruneGmailCopies(account.id, value.providerId, paths);
    }
    return { ...value, uid: mapping.local_uid, validity: incarnation };
  }
  async function resolve(path, uid, validity, localMessageId) {
    alive();
    const mapped = db.gmailAlias(account.id, path, uid, validity);
    if (mapped) return mapped;
    const row = localMessageId ? db.messageById(localMessageId) : db.messageByUid(account.id, path, uid, validity);
    if (row && (row.account_id !== account.id || Number(row.uid) !== Number(uid) || Number(row.uid_validity) !== Number(validity))) throw ambiguous();
    if (!row || !row.rfc_message_id || row.draft_pending) throw ambiguous();
    const providerId = row.gmail_id || await uniqueRfc(row.rfc_message_id);
    const data = await api.getMessage(providerId, { format: "metadata" });
    alive();
    const providerFolder = folder(path).provider_id;
    if (providerFolder !== ALL && !(data.labelIds || []).includes(providerFolder)) throw Object.assign(new Error("This Gmail message moved. Refresh before changing it."), { code: "message_moving", operationIssued: false });
    const mapping = db.rememberGmail(account.id, { providerId, providerThreadId: data.threadId, labelIds: data.labelIds || [] });
    db.bindGmailAlias(row, providerId);
    return mapping;
  }
  async function sync(path, { horizonDays = null, limit = 40 } = {}) {
    alive();
    const selected = folder(path), after = Number(horizonDays) > 0 ? Date.now() - Number(horizonDays) * 86400000 : null;
    let state = db.gmailSyncState(account.id, path);
    if (state.horizonDays !== horizonDays) state = { verifyNeeded: true };
    async function verifyCached() {
      if (!state.verifyNeeded) return;
      const rows = db.gmailVerifyPage(account.id, path, state.verifyBefore || 0);
      for (const row of rows) {
        try { await adopt(await api.getMessage(row.gmail_id), { after }); }
        catch (error) { if (error.status === 404) db.pruneGmailCopies(account.id, row.gmail_id, []); else throw error; }
      }
      state.verifyBefore = rows.at(-1)?.uid || 0;
      if (rows.length < 20) { state.verifyNeeded = false; state.verifyBefore = 0; }
    }
    const filter = { labelIds: selected.provider_id === ALL ? [] : [selected.provider_id],
      includeSpamTrash: selected.provider_id !== ALL, query: after == null ? "" : `after:${Math.floor(after / 1000)}`, limit };
    if (state.complete && state.historyId) {
      try {
        const page = await api.history({ startHistoryId: state.historyId, pageToken: state.historyPageToken || "", limit });
        const changed = new Set(), deleted = new Set();
        for (const event of page.history) {
          for (const item of event.messagesDeleted || []) deleted.add(item.message.id);
          for (const item of [...(event.messagesAdded || []), ...(event.labelsAdded || []), ...(event.labelsRemoved || [])]) changed.add(item.message.id);
          for (const item of event.messages || []) changed.add(item.id);
        }
        for (const providerId of deleted) db.pruneGmailCopies(account.id, providerId, []);
        for (const providerId of changed) {
          if (deleted.has(providerId)) continue;
          try { await adopt(await api.getMessage(providerId), { after }); }
          catch (error) { if (error.status === 404) db.pruneGmailCopies(account.id, providerId, []); else throw error; }
        }
        await verifyCached();
        alive();
        state = { ...state, historyPageToken: page.nextPageToken || "", ...(!page.nextPageToken && page.historyId ? { historyId: page.historyId } : {}) };
        db.gmailSyncState(account.id, path, state);
        return { paused: false, bootstrapped: true };
      } catch (error) { if (error.code !== "history_expired") throw error; state = { verifyNeeded: true }; }
    }
    if (!state.historyId) state = { ...state, horizonDays, historyId: String((await api.profile()).historyId || ""), pageToken: "", complete: false };
    const page = await api.listMessages({ ...filter, pageToken: state.pageToken || "" });
    const ids = new Set(page.messages.map(row => row.id));
    if (state.pageToken) for (const row of (await api.listMessages({ ...filter, limit: Math.min(limit, 20) })).messages) ids.add(row.id);
    for (const providerId of ids) {
      try { await adopt(await api.getMessage(providerId), { after }); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    await verifyCached();
    alive();
    state = { ...state, horizonDays, pageToken: page.nextPageToken || "", complete: !page.nextPageToken };
    db.gmailSyncState(account.id, path, state);
    return { paused: false, bootstrapped: state.complete };
  }
  async function source(path, uid, validity) {
    const mapped = await resolve(path, uid, validity);
    const value = await normalize(await api.getMessage(mapped.provider_id), true);
    return { ...value, uid: Number(uid) }; // retain the caller's legacy pair until its cache row is adopted
  }
  async function attachment(path, uid, partId, validity) {
    const mapped = await resolve(path, uid, validity), data = await api.getMessage(mapped.provider_id);
    const part = parts(data.payload).find(row => (row.partId || "0") === partId);
    if (!part) throw new Error("This Gmail attachment is no longer available.");
    const result = typeof part.body?.data === "string" ? Buffer.from(part.body.data, "base64url") : await api.attachment(data.id, part.body.attachmentId);
    alive(); return result;
  }
  async function move(path, uid, destination, validity, localMessageId) {
    const mapped = await resolve(path, uid, validity, localMessageId), from = folder(path).provider_id, to = folder(destination).provider_id;
    const priorTrashLabels = JSON.parse(mapped.trash_labels_json || "[]");
    const protectedRestore = from === "TRASH" && priorTrashLabels.includes(to) && ["DRAFT", "SENT"].includes(to);
    if (from !== to && ["DRAFT", "SENT"].includes(to) && !protectedRestore) throw Object.assign(new Error("Gmail does not allow moving existing mail into Drafts or Sent. Save a draft or send the message instead."), { code: "unsupported", operationIssued: false });
    if (from !== to && (JSON.parse(mapped.labels_json).includes("DRAFT")) && !["TRASH", "DRAFT"].includes(to)) throw Object.assign(new Error("Gmail does not allow applying folder labels to drafts. Save or send the draft instead."), { code: "unsupported", operationIssued: false });
    if (from !== to) {
      let result;
      if (to === "TRASH") {
        const prior = await api.getMessage(mapped.provider_id, { format: "metadata" });
        alive();
        db.rememberGmail(account.id, { providerId: mapped.provider_id, priorTrashLabels: prior.labelIds || [] });
        result = (await api.trash(mapped.provider_id)).message;
      }
      else {
        if (from === "TRASH") result = await api.restoreTrash({ messageId: mapped.provider_id, priorLabelIds: priorTrashLabels });
        if (protectedRestore) {
          if (!(result.labelIds || []).includes(to)) throw Object.assign(new Error("Gmail restored this message but did not confirm its original Drafts/Sent membership. Refresh and review it in Gmail."), { code: "provider", operationIssued: true });
        } else if (to === ALL) result = await api.archive(mapped.provider_id);
        else result = await api.modifyLabels(mapped.provider_id, [to], [ALL, "TRASH", "SENT", "DRAFT"].includes(from) ? [] : [from]);
      }
      alive(); db.rememberGmail(account.id, { providerId: mapped.provider_id, labelIds: result.labelIds || [], ...(from === "TRASH" ? { priorTrashLabels: null } : {}) });
    }
    return { uid: mapped.local_uid, uidValidity: incarnation };
  }
  async function flags(path, uid, add, remove, validity, localMessageId) {
    const mapped = await resolve(path, uid, validity, localMessageId);
    if (add.includes("\\Seen") || remove.includes("\\Seen")) await api.markRead(mapped.provider_id, add.includes("\\Seen"));
    if (add.includes("\\Flagged") || remove.includes("\\Flagged")) await api.star(mapped.provider_id, add.includes("\\Flagged"));
    alive();
  }
  async function append(path, raw) {
    if (folder(path).provider_id !== "DRAFT") throw Object.assign(new Error("Gmail saves Sent copies itself; only drafts can be uploaded here."), { operationIssued: false });
    const saved = await api.saveDraft({ raw });
    alive();
    const mapped = db.rememberGmail(account.id, { providerId: saved.message.id, providerThreadId: saved.message.threadId, providerDraftId: saved.id, labelIds: saved.message.labelIds || ["DRAFT"] });
    return { uid: mapped.local_uid, uidValidity: incarnation, providerId: saved.message.id };
  }
  async function search(path, query, limit = 80) {
    const selected = folder(path);
    const page = await api.listMessages({ labelIds: selected.provider_id === ALL ? [] : [selected.provider_id], includeSpamTrash: selected.provider_id !== ALL, query, limit });
    const messages = [];
    for (const row of page.messages) messages.push(await adopt(await api.getMessage(row.id)));
    return { gmail: true, messages, validity: incarnation, keepOthers: true, searched: true, nextPageToken: page.nextPageToken };
  }
  return { api, account, alive, folders, folder, sync, source, attachment, resolve, move, flags, append, search, adopt,
    async remove(path, uid, validity) { const mapped = await resolve(path, uid, validity); await api.trash(mapped.provider_id); alive(); },
    async create(path) { await api.createLabel(path); alive(); },
    async rename(from, to) {
      const labels = await api.labels();
      const selected = labels.filter(row => row.name === from || row.name.startsWith(`${from}/`));
      if (!selected.length || selected.some(row => row.type !== "user")) throw Object.assign(new Error("Choose an existing user label to rename."), { code: "unsupported", operationIssued: false });
      for (const label of selected) {
        await api.renameLabel(label.id, to + label.name.slice(from.length)); alive();
      }
    },
  };
}

module.exports = { createSession, migrated, ALL };
