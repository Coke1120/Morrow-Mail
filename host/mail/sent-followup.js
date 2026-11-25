// Identity checks for a local reminder. Subjects and provider conversation
// grouping are intentionally absent from the reply proof.
const { createHash } = require("node:crypto");
const addressParser = require("nodemailer/lib/addressparser");
const { address } = require("../../shared/compose-policy");
const dsn = require("./dsn-report");

const excludedReplyFolders = new Set(["sentitems", "drafts", "deleteditems", "junkemail"]);
const isReactionMime = type => typeof type === "string"
  && type.split(";")[0].trim().toLowerCase() === "text/vnd.google.email-reaction+json";

function messageId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return dsn.messageId(id.startsWith("<") ? id : `<${id}>`);
}

function oneAddress(value) {
  if (typeof value !== "string" || /[\r\n\x00]/.test(value)) return "";
  const parsed = addressParser(value, { flatten: true });
  return parsed.length === 1 ? address(parsed[0].address) : "";
}

function singleRecipient(to, cc, bcc) {
  if (![to, cc, bcc].every(Array.isArray) || to.length !== 1 || cc.length || bcc.length) return "";
  return oneAddress(to[0]);
}

// These are unfolded outer header lines, obtained only when the entire header
// block was available. Absence on a legacy or partial row provides no evidence.
function responseEvidence(headers, receivedAt = null) {
  let senders = [], parents = [];
  for (const line of headers) {
    const colon = line.indexOf(":");
    if (colon < 1) return null;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "from") senders.push(value);
    if (name === "in-reply-to") parents.push(value);
    if ((name === "auto-submitted" && !/^no(?:\s*;|$)/i.test(value))
      || ["x-autoreply", "x-autorespond", "x-auto-reply", "x-autoresponse"].includes(name)
      || (name === "precedence" && /^auto[_-]reply$/i.test(value))
      || (name === "return-path" && value === "<>")
      || (name === "content-type" && /^(?:multipart\/report|message\/(?:delivery-status|disposition-notification)|text\/vnd\.google\.email-reaction\+json)(?:\s*;|$)/i.test(value))) {
      return { kind: "automatic" };
    }
  }
  const from = senders.length === 1 ? oneAddress(senders[0]) : "";
  const parent = parents.length === 1 ? messageId(parents[0]) : "";
  return from && parent ? { kind: "ordinary", from, parent, receivedAt } : null;
}

function replyState(source, candidates, selfAddresses) {
  const parent = messageId(source.messageId);
  if (!parent || !source.recipient || !Number.isFinite(source.sentAt) || selfAddresses.includes(source.recipient)) return "none";
  // IMAP INTERNALDATE has second precision, including for a reply to a
  // message whose local submission timestamp still includes milliseconds.
  const sentAt = source.imapLocal ? Math.floor(source.sentAt / 1000) * 1000 : source.sentAt;
  let unverified = false;
  for (const row of candidates) {
    if (row.accountId !== source.accountId || row.id === source.id || row.draft
      || excludedReplyFolders.has(row.role) || row.confirmed !== true
      || messageId(row.inReplyTo) !== parent || (row.evidence?.from || oneAddress(row.from)) !== source.recipient
      || row.evidence?.kind === "automatic" || row.report) continue;
    const proof = row.evidence;
    if (Number.isFinite(proof?.receivedAt) && proof.receivedAt < sentAt) continue;
    if (proof?.kind === "ordinary" && proof.parent === parent && Number.isFinite(proof.receivedAt)) return "answered";
    unverified = true;
  }
  return unverified ? "unverified" : "none";
}

const validId = value => typeof value === "string" && value.length <= 512 && !!value && !/[\x00-\x1f\x7f]/.test(value);
const MAX_REMINDERS = 200;
const validDate = value => Number.isSafeInteger(value) && value > 0 && value < 253402300800000;
const json = (value, fallback = null) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function accountBinding(account) {
  return createHash("sha256").update(JSON.stringify([account.id, account.created_at, account.email, account.username,
    account.profile, account.auth_kind, account.mail_transport, account.gmail_generation, account.imap_host,
    account.imap_port, account.imap_tls])).digest("hex");
}

function confirmation(accepted, rejected, options) {
  const recipient = singleRecipient(options.to || [], options.cc || [], options.bcc || []);
  return recipient && accepted.length === 1 && !rejected.length && oneAddress(accepted[0]) === recipient ? recipient : "";
}

function bodyProof(row) {
  // Metadata alone cannot prove that adopted attachment bytes are the same.
  if (row?.body_complete !== 1 || row.has_attachments || json(row.attachments_json, []).length) return null;
  const normalize = value => String(value || "").replace(/\r\n/g, "\n");
  return createHash("sha256").update(JSON.stringify([row.subject, normalize(row.html_body), normalize(row.text_body)])).digest("hex");
}

function createFollowups({ db, selfAddresses, hasCoverage, now = () => Date.now() }) {
  function rowIdentity(account, row, folder, excludedLabels = []) {
    if (!row || row.account_id !== account.id || !folder || row.is_draft || row.draft_pending
      || !(row.uid > 0) || !(row.uid_validity > 0)) return false;
    if (account.mail_transport !== "gmail_api") return folder.uid_validity === row.uid_validity;
    const mapping = row.gmail_id && db.gmailMap(account.id, row.gmail_id);
    const labels = mapping && db.jsonList(mapping.labels_json);
    return !!labels && mapping.local_uid === row.uid && row.uid_validity === account.gmail_generation
      && (folder.well_known !== "sentitems" || labels.includes("SENT"))
      && !labels.some(label => excludedLabels.includes(label));
  }

  function resolve(account, rfcId) {
    const rows = db.sentFollowupSources(account.id, rfcId, rfcId.slice(1, -1));
    if (rows.length !== 1) return null;
    const row = rows[0], folder = db.folderByPath(account.id, row.folder_path);
    const sender = oneAddress(row.from_address || row.from_addr);
    const recipient = singleRecipient(json(row.to_json), json(row.cc_json), json(row.bcc_json));
    const sentAt = Date.parse(row.date_iso);
    const identities = selfAddresses(account);
    if (!sender || !recipient || !identities.includes(sender) || identities.includes(recipient)
      || !validDate(sentAt) || !["header", "received", "local"].includes(row.date_source)) return null;
    const headers = json(row.recipient_headers_json);
    if (headers?.followupUnprovenAdoption) return null;
    const confirmedLocal = !row.uid && row.date_source === "local" && headers?.followupConfirmedRecipient === recipient;
    if (!confirmedLocal && !rowIdentity(account, row, folder)) return null;
    const copy = row.uid > 0 ? JSON.stringify([row.folder_path, row.uid, row.uid_validity, row.gmail_id || null]) : null;
    return { row, identities, source: { id: row.id, accountId: account.id, messageId: rfcId, sentAt, sender, copy,
      recipient, binding: accountBinding(account), imapLocal: confirmedLocal && account.mail_transport !== "gmail_api" } };
  }

  function resolveSaved(account, saved) {
    const prior = json(saved.source_json);
    if (!prior || !account || prior.binding !== accountBinding(account)) return null;
    const result = resolve(account, saved.rfc_id);
    const source = result?.source;
    if (!source || source.id !== prior.id || source.recipient !== prior.recipient || source.sender !== prior.sender) return null;
    if (prior.copy && prior.copy !== source.copy) return null;
    // A provider row can adopt the local row ID by RFC ID alone. Require
    // matching complete content before trusting that transition.
    if (!prior.copy && source.copy && (!prior.localBody || prior.localBody !== bodyProof(db.messageById(source.id)))) return null;
    // Keep the confirmed submission time when the provider adopts the row.
    return { ...result, source: prior };
  }

  function review(saved, account) {
    const result = resolveSaved(account, saved);
    const { source, row, identities } = result || {};
    let reply = "unverified";
    if (source) {
      const candidates = db.sentFollowupReplies(account.id, saved.rfc_id, saved.rfc_id.slice(1, -1));
      const folders = new Map(db.foldersFor(account.id).map(folder => [folder.path, folder]));
      reply = replyState(source, candidates.map(candidate => {
        const folder = folders.get(candidate.folder_path);
        return { id: candidate.id, accountId: candidate.account_id, from: candidate.from_address || candidate.from_addr,
          draft: candidate.is_draft, inReplyTo: candidate.in_reply_to, role: folder?.well_known,
          confirmed: rowIdentity(account, candidate, folder, ["SENT", "DRAFT", "SPAM", "TRASH"]),
          report: dsn.parse(candidate.dsn_redraft_json)?.kind === "report",
          evidence: json(candidate.recipient_headers_json)?.followupReply };
      }), identities);
      if (reply === "answered") {
        db.deleteSentFollowup(account.id, saved.rfc_id);
        return null;
      }
      if (candidates.length === 201) reply = "unverified";
    }
    const due = saved.due_at <= now();
    return { accountId: saved.account_id, messageId: saved.rfc_id, dueAt: saved.due_at,
      subject: row?.subject || "(Sent message unavailable)", recipient: source?.recipient || json(saved.source_json)?.recipient || "",
      canOpen: row?.body_complete === 1, state: !due ? "waiting" : reply === "none" && hasCoverage(account, source.sentAt, saved.due_at) ? "due" : "check" };
  }

  function answer(input = {}) {
    if (input.action === "list") {
      return db.allSentFollowups().map(saved => review(saved, db.accountById(saved.account_id))).filter(Boolean);
    }
    const account = validId(input.accountId) && db.accountById(input.accountId);
    if (!account) throw new Error("That mailbox is no longer connected.");
    if (input.action === "inspect") {
      const row = validId(input.emailId) && db.messageById(input.emailId, { headersOnly: true });
      const id = row?.account_id === account.id && messageId(row.rfc_message_id);
      const result = id && resolve(account, id);
      if (!result || result.source.id !== input.emailId) return null;
      const saved = db.sentFollowupById(account.id, id);
      if (saved && !resolveSaved(account, saved)) return null;
      const waiting = saved ? review(saved, account) : null;
      return { accountId: account.id, messageId: id, emailId: row.id, recipient: result.source.recipient,
        subject: row.subject || "(No subject)", dueAt: waiting?.dueAt ?? null };
    }
    const id = messageId(input.messageId);
    if (!id) throw new Error("Choose an exact Sent message.");
    const saved = db.sentFollowupById(account.id, id);
    const existingDue = saved?.due_at ?? null;
    if ((input.expectedDueAt ?? null) !== existingDue) throw new Error("That reminder changed. Reopen it before trying again.");
    if (input.action === "open") {
      const result = saved && resolveSaved(account, saved);
      if (!result) throw new Error("The original Sent message could not be verified.");
      if (result.row.body_complete !== 1) throw new Error("Download the complete Sent message first.");
      return { accountId: account.id, emailId: result.row.id, folderId: result.row.folder_path };
    }
    if (input.action === "dismiss" && saved) {
      db.deleteSentFollowup(account.id, id);
      return true;
    }
    if (input.action !== "save" || !validDate(input.dueAt) || input.dueAt <= now()) throw new Error("Choose a future date and time.");
    const result = saved ? resolveSaved(account, saved) : resolve(account, id);
    if (!saved && (!result || result.source.id !== input.emailId)) throw new Error("Choose a confirmed Sent message to one recipient.");
    if (!saved && db.allSentFollowups().length >= MAX_REMINDERS) throw new Error("Dismiss an existing follow-up reminder before adding another.");
    if (!saved && !result.source.copy) result.source.localBody = bodyProof(db.messageById(result.source.id));
    db.saveSentFollowup(account.id, id, input.dueAt, saved?.source_json ?? JSON.stringify(result.source));
    return true;
  }
  return { answer };
}

module.exports = { messageId, oneAddress, singleRecipient, responseEvidence, replyState, isReactionMime, excludedReplyFolders, confirmation, createFollowups };
