const crypto = require("node:crypto");
const addressParser = require("nodemailer/lib/addressparser");
const sender = require("../mail/sender-header");
const { htmlToPlain } = require("../mail/text-encoding");
const { validateMetadata, failure } = require("./validate");
const { LIMITS } = require("./extract");
const { budget } = require("./budget");

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fingerprint(row) {
  return hash([row.account_id, row.id, row.thread_id, row.gmail_id, row.uid, row.uid_validity, row.folder_path, row.rfc_message_id,
    row.subject, row.from_addr, row.from_address, row.from_display_name, row.to_json, row.cc_json, row.date_iso, row.date_source,
    row.text_body, row.html_body, row.body_complete, row.body_warning, row.attachments_json, row.recipient_headers_json, row.draft_pending]);
}

function mailboxes(values) {
  if (!Array.isArray(values)) throw failure("timeline-metadata");
  return values.flatMap(value => {
    const parsed = typeof value === "string" ? addressParser(value) : [value];
    return parsed.flatMap(row => row.group ? mailboxes(row.group) : [{ address: row.address, ...(row.name ? { name: row.name } : {}) }]);
  });
}

function dedupeRows(rows) {
  const result = new Map();
  for (const row of rows) {
    const provider = !row.draft_pending && typeof row.gmail_id === "string" && row.gmail_id.length <= 512 && row.gmail_id && !/[\s\x00-\x1f]/.test(row.gmail_id);
    const key = JSON.stringify([row.account_id, provider ? "provider" : "local", provider ? row.gmail_id : row.id]);
    const old = result.get(key);
    if (!old || (old.body_complete !== 1 && row.body_complete === 1)) result.set(key, row);
  }
  return [...result.values()].sort((left, right) => String(left.date_iso || "").localeCompare(String(right.date_iso || "")) || left.id.localeCompare(right.id));
}

function freezeSources({ db, stamp, identities }, selection, mode = "thread") {
  let matched = 0;
  const seeds = (selection.messages || []).map(reference => {
    const row = db.timelineMessage(reference.messageId);
    if (!row || row.account_id !== reference.accountId) throw failure("timeline-source-changed");
    return row;
  });
  if (selection.search) {
    const { tokens, overlong } = db.inspectSearchTokens(selection.search.query);
    if (!tokens.length || tokens.length > 16 || overlong) throw failure("timeline-query");
    const found = db.timelineSearch(selection.search);
    if (found.length > LIMITS.messages) throw failure("timeline-selection-limit");
    matched = found.length;
    seeds.push(...found);
  }
  if (!seeds.length || seeds.some(row => !row)) throw failure("timeline-empty");
  const threadKeys = new Set(), collected = new Map();
  for (const seed of seeds) {
    const key = JSON.stringify([seed.account_id, seed.thread_id || seed.id]);
    if (threadKeys.has(key) && selection.expandThreads) continue;
    threadKeys.add(key);
    if (threadKeys.size > LIMITS.threads) throw failure("timeline-selection-limit");
    const rows = selection.expandThreads && seed.thread_id ? db.timelineThread(seed.account_id, seed.thread_id) : [seed];
    for (const row of rows) collected.set(row.id, row);
    if (collected.size > LIMITS.messages) throw failure("timeline-selection-limit");
  }
  const rows = dedupeRows([...collected.values()]);
  const accounts = new Map(), sourceThreads = new Map(), records = [], sources = [], omitted = [];
  let missingBodies = 0, invalidMetadata = 0, bodyBytes = 0;
  for (const selected of rows) {
    const row = db.messageById(selected.id);
    if (!row || row.account_id !== selected.account_id) throw failure("timeline-source-changed");
    let account = accounts.get(row.account_id);
    if (!account) {
      const saved = db.accountById(row.account_id);
      if (!saved) throw failure("timeline-source-changed");
      account = { saved, stamp: stamp(saved.id), aliases: identities(saved) };
      accounts.set(saved.id, account);
    }
    const threadId = db.timeline.identity(account.saved, "thread", row.thread_id || row.id);
    sourceThreads.set(threadId, (sourceThreads.get(threadId) || 0) + 1);
    const phase = mode === "case" ? selection.messages.find(reference => reference.messageId === row.id)?.phase || "main" : null;
    const record = { id: row.id, account_id: row.account_id, thread_id: row.thread_id || row.id, fingerprint: fingerprint(row), ...(phase ? { phase } : {}) };
    records.push(record);
    if (mode === "context") continue;
    const text = row.text_body || htmlToPlain(row.html_body || "");
    if (row.body_complete !== 1 || !text.trim() || row.body_warning) {
      missingBodies++;
      omitted.push({ accountId: row.account_id, messageId: row.id });
      continue;
    }
    bodyBytes += Buffer.byteLength(text);
    if (bodyBytes > LIMITS.inputTokens) throw budget("source-bytes", bodyBytes, LIMITS.inputTokens);
    try {
      const metadata = metadataOf(row, account, db.timeline, threadId);
      validateMetadata(metadata);
      if ((row.subject || "").length > 500) throw failure("timeline-metadata");
      sources.push({ ...metadata, ...(phase ? { phase } : {}), subject: row.subject || "", text });
    } catch { invalidMetadata++; }
  }
  const coverage = { selected_message_count: rows.length, included_message_count: sources.length,
    omitted_message_count: rows.length - sources.length, selection_truncated: false };
  const snapshot = { accounts: [...accounts].map(([id, account]) => ({ id, stamp: account.stamp, email: account.saved.email })),
    records, sources, omitted, coverage, sourceThreads: [...sourceThreads].map(([thread_id, selected_message_count]) => ({ thread_id, selected_message_count })),
    search: selection.search ? { matched, expanded: selection.expandThreads, localOnly: true, ordinaryDisplayCap: 100 } : null, missingBodies, invalidMetadata };
  snapshot.digest = hash([snapshot.accounts, records, coverage]);
  return snapshot;
}

function metadataOf(row, account, store, threadId) {
  const to = mailboxes(JSON.parse(row.to_json || "[]")), cc = mailboxes(JSON.parse(row.cc_json || "[]"));
  const address = sender.savedAddress(row);
  const parsed = sender.headerParts(row.from_addr);
  const name = typeof row.from_display_name === "string" ? row.from_display_name : parsed.name;
  const recipientHeaders = JSON.parse(row.recipient_headers_json || "{}");
  const evidence = [...to, ...cc].map(mailbox => mailbox.address).concat(...["originalTo", "deliveredTo", "envelopeTo"].map(key => recipientHeaders[key] || []));
  const aliases = account.aliases.filter(alias => alias !== account.saved.email.toLowerCase() && evidence.some(value => typeof value === "string" && value.toLowerCase() === alias));
  const { date, dateSource } = dateEvidence(row);
  return { event_id: crypto.randomUUID(), source_thread_id: threadId,
    source_message_id: messageIdentity(row, account.saved, store),
    occurred_at: date, date_source: dateSource,
    from: address ? { address, ...(name ? { name } : {}) } : null, to, cc, via_alias: aliases.length === 1 ? aliases[0] : null,
    attachments: JSON.parse(row.attachments_json || "[]").map(attachment => attachment.filename) };
}

function messageIdentity(row, account, store) {
  const provider = !row.draft_pending && typeof row.gmail_id === "string" && row.gmail_id.length <= 512 && row.gmail_id && !/[\s\x00-\x1f]/.test(row.gmail_id);
  return store.identity(account, provider ? "provider-message" : "local-message", provider ? row.gmail_id : row.id);
}

function assertSources({ db, stamp }, snapshot) {
  for (const account of snapshot.accounts) if (stamp(account.id) !== account.stamp) throw failure("timeline-source-changed");
  for (const record of snapshot.records) {
    const row = db.messageById(record.id);
    if (!row || row.account_id !== record.account_id || fingerprint(row) !== record.fingerprint) throw failure("timeline-source-changed");
  }
}

function dateEvidence(row) {
  const valid = typeof row.date_iso === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(row.date_iso) && Number.isFinite(Date.parse(row.date_iso));
  const dateSource = valid && row.date_source !== "unknown" ? ["header", "received"].includes(row.date_source) ? row.date_source : "cached_unknown" : "unknown";
  return { date: dateSource === "unknown" ? null : new Date(row.date_iso).toISOString(), dateSource };
}

function messagePreview(row) {
  return { messageId: row.id, accountId: row.account_id, threadId: row.thread_id || row.id,
    subject: String(row.subject || "").slice(0, 500), from: String(row.from_addr || "").slice(0, 500),
    ...dateEvidence(row), complete: row.body_complete === 1 && !row.body_warning };
}

module.exports = { hash, fingerprint, dedupeRows, mailboxes, freezeSources, assertSources, messageIdentity, messagePreview };
