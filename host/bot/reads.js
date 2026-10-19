"use strict";

const db = require("../mail/db");
const observe = require("./observe");
const { htmlToText, trimUtf8 } = require("./text");
const {
  CORPUS_CAP,
  DEFAULT_BODY_BYTES,
  DEFAULT_LIMIT,
  HTML_INPUT_CAP,
  MAX_BODY_BYTES,
  MAX_LIMIT,
  MAX_RECIPIENTS,
  SENDER_BYTES,
  SNIPPET_BYTES,
  STALE_AFTER_SECONDS,
  SUBJECT_BYTES,
  SYNC_WINDOW_DAYS,
} = require("./constants");

let corpusCap = CORPUS_CAP;

function setCorpusCapForTest(value) {
  corpusCap = Number.isInteger(value) && value > 0 ? value : CORPUS_CAP;
}

function ready() {
  return db.isReady() === true;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  error.expose = true;
  return error;
}

function providerOf(profile) {
  if (profile === "gmail") return "gmail";
  if (profile === "outlook" || profile === "microsoft") return "microsoft";
  return "imap";
}

function accountsFor(accountIds) {
  if (!ready()) throw coded("HOST_NOT_READY");
  const items = [];
  for (const accountId of accountIds) {
    const row = db.accountById(accountId);
    if (!row) continue;
    items.push({
      accountId: row.id,
      email: row.email || "",
      displayName: row.display_name || "",
      provider: providerOf(row.profile),
      authKind: row.auth_kind === "oauth2" ? "oauth2" : "password",
      reauthentication: row.auth_error ? "needs_reauth" : "not_observed",
    });
  }
  return items;
}

function folderPaths(accountId, folder) {
  return db.pathsForKey(accountId, folder).map((row) => row.path);
}

function field(value, max) {
  const cut = trimUtf8(value || "", max);
  return cut;
}

function recipients(row) {
  const all = []
    .concat(db.jsonList(row.to_json), db.jsonList(row.cc_json))
    .filter((item) => typeof item === "string" && item);
  let truncated = false;
  const out = [];
  for (const item of all) {
    if (out.length >= MAX_RECIPIENTS) {
      truncated = true;
      break;
    }
    const cut = trimUtf8(item, SENDER_BYTES);
    if (cut.truncated) truncated = true;
    out.push(cut.text);
  }
  return { to: out, truncated };
}

function headerOf(row, detail) {
  const subject = field(row.subject, SUBJECT_BYTES);
  const from = field(row.from_addr, SENDER_BYTES);
  const snippet = field(row.snippet, SNIPPET_BYTES);
  const people = detail ? recipients(row) : { to: undefined, truncated: false };
  const item = {
    messageId: row.id,
    accountId: row.account_id,
    folderId: row.folder_path,
    subject: subject.text,
    from: from.text,
    date: row.date_iso || null,
    snippet: snippet.text,
    unread: row.unread === 1,
    bodyCached: row.body_complete === 1,
    hasAttachments: row.has_attachments === 1,
    attachmentCount: db.jsonList(row.attachments_json).length,
    snoozed: row.snoozed === 1,
    fieldTruncation: subject.truncated || from.truncated || snippet.truncated || people.truncated,
  };
  if (detail) item.to = people.to;
  return item;
}

function attachmentItem(item, index) {
  return {
    index,
    filename: trimUtf8(item && item.filename, 320).text,
    mimeType: trimUtf8(item && (item.mimeType || item.mime), 120).text,
    size: Number(item && item.size) || 0,
    inline: !!(item && (item.inline === true || item.isInlineFromApi === true)),
  };
}

function attachmentMeta(row, allowed) {
  const items = db.jsonList(row.attachments_json);
  if (!allowed) return { count: items.length };
  return {
    count: items.length,
    items: items.slice(0, 20).map((item, index) => attachmentItem(item, index)),
  };
}

function listCached(accountId, folder, limit) {
  if (!ready()) throw coded("HOST_NOT_READY");
  const paths = folderPaths(accountId, folder);
  const warnings = [];
  if (!paths.length) {
    return {
      accountId,
      folder,
      items: [],
      moreAvailable: false,
      warnings: ["FOLDER_NOT_CACHED"],
      folders: [],
    };
  }
  const rows = db.selectBotHeaders(accountId, paths, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => headerOf(row, false));
  return {
    accountId,
    folder,
    items,
    moreAvailable: more,
    warnings,
    folders: paths.map((folderPath) => db.folderByPath(accountId, folderPath)).filter(Boolean),
  };
}

function assertQuery(query) {
  if (typeof query !== "string") throw coded("INVALID_REQUEST");
  if (Buffer.byteLength(query, "utf8") < 1 || Buffer.byteLength(query, "utf8") > 256) throw coded("INVALID_REQUEST");
  if (/[:"]/.test(query) || /[“”]/.test(query)) throw coded("INVALID_REQUEST");
  const inspected = db.inspectSearchTokens(query);
  if (inspected.overlong || inspected.tokens.length < 1 || inspected.tokens.length > 8) {
    throw coded("INVALID_REQUEST");
  }
  return inspected.tokens;
}

function searchCached(accountId, query, limit) {
  if (!ready()) throw coded("HOST_NOT_READY");
  const stats = db.messageStats();
  if (stats.messages > corpusCap) throw coded("SEARCH_BUDGET_EXCEEDED");
  const tokens = assertQuery(query);
  const rows = db.searchMessages({
    accountId,
    tokens,
    limit: limit + 1,
    accountRequired: true,
  });
  const more = rows.length > limit;
  return {
    accountId,
    items: rows.slice(0, limit).map((row) => headerOf(row, false)),
    moreAvailable: more,
    warnings: ["LOCAL_SEARCH_ONLY"],
    folders: db.foldersFor(accountId),
  };
}

function bodyOf(row, maxBodyBytes) {
  const cap = maxBodyBytes || DEFAULT_BODY_BYTES;
  const warnings = [];
  if (row.body_complete === 1 && row.text_body != null) {
    const cut = trimUtf8(row.text_body, cap);
    return {
      body: {
        kind: "text",
        text: cut.text,
        complete: true,
        truncated: cut.truncated,
        returnedBytes: Buffer.byteLength(cut.text, "utf8"),
      },
      warnings,
    };
  }
  if (row.html_body) {
    if (Buffer.byteLength(String(row.html_body), "utf8") > HTML_INPUT_CAP) {
      const cut = trimUtf8(row.snippet || "", cap);
      warnings.push("HTML_CONVERSION_LIMIT");
      if (row.body_complete !== 1) warnings.push("BODY_NOT_CACHED");
      return {
        body: {
          kind: "snippet",
          text: cut.text,
          complete: false,
          truncated: cut.truncated,
          returnedBytes: Buffer.byteLength(cut.text, "utf8"),
        },
        warnings,
      };
    }
    const plain = htmlToText(row.html_body);
    const cut = trimUtf8(plain, cap);
    return {
      body: {
        kind: "html_text",
        text: cut.text,
        complete: row.body_complete === 1,
        truncated: cut.truncated,
        returnedBytes: Buffer.byteLength(cut.text, "utf8"),
      },
      warnings,
    };
  }
  if (row.body_complete === 1) {
    return {
      body: { kind: "text", text: "", complete: true, truncated: false, returnedBytes: 0 },
      warnings,
    };
  }
  const cut = trimUtf8(row.snippet || "", cap);
  warnings.push("BODY_NOT_CACHED");
  return {
    body: {
      kind: "snippet",
      text: cut.text,
      complete: false,
      truncated: cut.truncated,
      returnedBytes: Buffer.byteLength(cut.text, "utf8"),
    },
    warnings,
  };
}

function getAttachment(accountId, messageId, index) {
  if (!ready()) throw coded("HOST_NOT_READY");
  const row = db.messageById(messageId);
  if (!row || row.account_id !== accountId) throw coded("NOT_FOUND");
  const attachment = attachmentMeta(row, true).items.find((item) => item.index === index) || null;
  if (!attachment) throw coded("ATTACHMENT_NOT_IN_CACHE");
  return {
    accountId,
    messageId,
    attachment,
    bytes: null,
    code: "attachment_bytes_not_stored",
  };
}

function getCached(accountId, messageId, maxBodyBytes, attachments) {
  if (!ready()) throw coded("HOST_NOT_READY");
  const row = db.messageById(messageId);
  if (!row || row.account_id !== accountId) throw coded("NOT_FOUND");
  const activeSnooze = db.snoozeRows(accountId, "active");
  row.snoozed = activeSnooze.some((item) => item.thread_id === row.thread_id) ? 1 : 0;
  const projected = bodyOf(row, maxBodyBytes);
  const folder = db.folderByPath(accountId, row.folder_path);
  const message = headerOf(row, true);
  if (attachments) message.attachments = attachmentMeta(row, true).items;
  return {
    accountId,
    message,
    body: projected.body,
    warnings: projected.warnings,
    folders: folder ? [folder] : [],
  };
}

function isoFromMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function freshness(folders) {
  const rows = (folders || []).filter(Boolean);
  if (!rows.length) return { stale: null, lastSuccessfulSyncAt: null };
  const times = rows.map((folder) => Number(folder.synced_at)).filter((n) => Number.isFinite(n) && n > 0);
  if (times.length !== rows.length) {
    return {
      stale: null,
      lastSuccessfulSyncAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    };
  }
  const oldest = Math.min(...times);
  return {
    stale: Date.now() - oldest > STALE_AFTER_SECONDS * 1000,
    lastSuccessfulSyncAt: new Date(oldest).toISOString(),
  };
}

function coverage(accountId, folders) {
  const rows = (folders || []).filter(Boolean);
  const stats = accountId ? db.messageStats(accountId) : { messages: 0, bodiesComplete: 0 };
  const windowDone = rows.length > 0 && rows.every((folder) => {
    return Number(folder.window_done) === 1 && Number(folder.sync_horizon_days) >= SYNC_WINDOW_DAYS;
  });
  let bodyCoverage = "partial";
  if (!stats.messages) bodyCoverage = "partial";
  else if (stats.bodiesComplete === stats.messages) bodyCoverage = "complete";
  return {
    providerMailboxComplete: false,
    targetSyncWindowDays: SYNC_WINDOW_DAYS,
    folderCoverage: windowDone ? "complete" : "partial",
    bodyCoverage,
    indexCoverage: "bounded",
  };
}

function health(accountId) {
  if (!ready()) throw coded("HOST_NOT_READY");
  const account = db.accountById(accountId);
  if (!account) throw coded("NOT_FOUND");
  const folders = db.foldersFor(accountId);
  const fresh = freshness(folders);
  const seen = observe.get(accountId);
  const mailbox = account.auth_error
    ? { state: "needs_reauth", checkedAt: seen && seen.lastObservedAt || null }
    : { state: "not_observed", checkedAt: null };
  const unknown = { state: "not_observed", checkedAt: null };
  return {
    accountId,
    sync: {
      state: seen && seen.syncState || "unknown",
      lastObservedAt: (seen && seen.lastObservedAt) || isoFromMs(Math.max(...folders.map((folder) => Number(folder.synced_at) || 0))) || null,
      lastSuccessfulSyncAt: fresh.lastSuccessfulSyncAt,
      pausedUntil: seen ? seen.pausedUntil : null,
      providerConnection: "unknown",
    },
    auth: {
      mailbox,
      organize: unknown,
      calendar: unknown,
      rules: unknown,
      outOfOffice: unknown,
    },
    cache: {
      targetWindowDays: SYNC_WINDOW_DAYS,
      coverage: coverage(accountId, folders).folderCoverage,
      bodyCoverage: coverage(accountId, folders).bodyCoverage,
    },
    freshness: fresh,
    folders,
  };
}

function clampLimit(value) {
  if (value == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    const error = coded("INVALID_REQUEST");
    throw error;
  }
  return value;
}

function clampBody(value) {
  if (value == null) return DEFAULT_BODY_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BODY_BYTES) throw coded("INVALID_REQUEST");
  return value;
}

module.exports = {
  ready,
  accountsFor,
  listCached,
  searchCached,
  getCached,
  getAttachment,
  health,
  freshness,
  coverage,
  clampLimit,
  clampBody,
  setCorpusCapForTest,
};
