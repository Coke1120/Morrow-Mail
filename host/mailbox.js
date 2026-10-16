const fs = require("fs");
const os = require("os");
const path = require("path");

// Sample mailbox for the shipped GenMail renderer.
// Shapes are taken from the 1.0.2218 store (locales-QDNVAh6a.js /
// GenmailSpace-D-MhAGBT.js): account folders.primary/more, string `from`,
// `unread`, list windows with geometry, and raw vs unwrapped envelopes.
// These messages are synthetic. They are not a copy of a live mailbox.

const ACCOUNT_GMAIL = "gmail-ada";
const ACCOUNT_OUTLOOK = "outlook-grace";

function folder(id, name, wellKnownName, unreadCount, totalCount) {
  return {
    id,
    name,
    wellKnownName,
    unreadCount,
    totalCount,
    type: "system",
    children: [],
  };
}

function customFolder(id, name) {
  return {
    id,
    name,
    wellKnownName: null,
    unreadCount: 0,
    totalCount: 0,
    type: "user",
    children: [],
  };
}

function account(partial, primary, more) {
  return {
    id: partial.id,
    email: partial.email,
    displayEmail: partial.email,
    preferredFromAddress: partial.email,
    senderName: partial.name,
    defaultSenderName: partial.name,
    sendAs: [{ email: partial.email, name: partial.name, isDefault: true }],
    name: partial.name,
    platform: partial.platform,
    needsReauth: false,
    reauthReason: null,
    reauthDetectedAt: null,
    suspended: false,
    isConnected: true,
    isDefault: partial.isDefault === true,
    unreadCount: partial.unreadCount,
    promoSignatureEnabled: false,
    folders: { primary, more },
    groups: [],
  };
}

function gmailFolders() {
  const id = (key) => `${ACCOUNT_GMAIL}:${key}`;
  return [
    folder(id("inbox"), "Inbox", "inbox", 2, 6),
    folder("starred", "Starred", "starred", 0, 1),
    folder(id("sent"), "Sent", "sentitems", 0, 0),
    folder(id("archive"), "Archive", "archive", 0, 0),
    folder(id("drafts"), "Drafts", "drafts", 0, 0),
    folder(id("trash"), "Deleted", "deleteditems", 0, 0),
    folder("important", "Important", "important", 1, 1),
    folder(id("spam"), "Junk", "junkemail", 0, 0),
  ];
}

function outlookFolders() {
  const id = (key) => `${ACCOUNT_OUTLOOK}:${key}`;
  return [
    folder(id("inbox"), "Inbox", "inbox", 1, 2),
    folder(id("drafts"), "Drafts", "drafts", 0, 0),
    folder(id("sent"), "Sent", "sentitems", 0, 0),
    folder(id("trash"), "Deleted", "deleteditems", 0, 0),
    folder(id("archive"), "Archive", "archive", 0, 0),
    folder(id("spam"), "Junk", "junkemail", 0, 0),
  ];
}

function buildAccounts() {
  return [
    account(
      {
        id: ACCOUNT_GMAIL,
        email: "ada.lovelace@example.com",
        name: null,
        platform: "gmail",
        isDefault: true,
        unreadCount: 2,
      },
      gmailFolders(),
      [
        customFolder(`${ACCOUNT_GMAIL}:notes`, "Notes"),
        customFolder(`${ACCOUNT_GMAIL}:papers`, "Papers"),
        customFolder(`${ACCOUNT_GMAIL}:travel`, "Travel"),
      ]
    ),
    account(
      {
        id: ACCOUNT_OUTLOOK,
        email: "grace.hopper@example.com",
        name: null,
        platform: "outlook",
        isDefault: false,
        unreadCount: 1,
      },
      outlookFolders(),
      [
        customFolder(`${ACCOUNT_OUTLOOK}:navy`, "Navy"),
        customFolder(`${ACCOUNT_OUTLOOK}:cobol`, "COBOL"),
      ]
    ),
  ];
}

function atLocal(dayOffset, hours, minutes) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function message(partial) {
  const when = partial.when;
  return {
    id: partial.id,
    accountId: partial.accountId,
    threadId: partial.threadId || partial.id,
    conversationId: partial.threadId || partial.id,
    folderId: partial.folderId,
    folderKey: partial.folderKey || "inbox",
    folders: partial.folders || [partial.folderId],
    subject: partial.subject,
    snippet: partial.snippet,
    from: partial.from,
    to: partial.to || [],
    cc: partial.cc || [],
    date: when.toISOString(),
    listSortTs: when.getTime(),
    unread: partial.unread === true,
    isRead: partial.unread !== true,
    isStarred: partial.isStarred === true,
    isDraft: false,
    hasAttachments: partial.hasAttachments === true,
    unifiedCategory: partial.unifiedCategory || "primary",
    providerCategory: partial.unifiedCategory || "primary",
    htmlBody: partial.htmlBody,
    textBody: partial.textBody,
    attachments: partial.attachments || [],
  };
}

function buildEmails() {
  const gmailInbox = `${ACCOUNT_GMAIL}:inbox`;
  const outlookInbox = `${ACCOUNT_OUTLOOK}:inbox`;
  return [
    message({
      id: "m-engine",
      accountId: ACCOUNT_GMAIL,
      folderId: gmailInbox,
      when: atLocal(0, 10, 0),
      unread: true,
      from: "Charles Babbage <charles@example.com>",
      to: ["Ada Lovelace <ada.lovelace@example.com>"],
      cc: ["Mary Somerville <mary@example.com>"],
      subject: "Notes on the Analytical Engine",
      snippet: "The table of operations is ready for a second reading.",
      unifiedCategory: "primary",
      htmlBody: "<p>The table of operations is ready for a second reading.</p><img alt=\"Charles Babbage\" src=\"https://upload.wikimedia.org/wikipedia/commons/thumb/a/af/Charles_Babbage.jpg/330px-Charles_Babbage.jpg\">",
      textBody: "The table of operations is ready for a second reading.",
    }),
    message({
      id: "m-compiler",
      threadId: "t-compiler",
      accountId: ACCOUNT_GMAIL,
      folderId: gmailInbox,
      folders: [gmailInbox, "important"],
      when: atLocal(0, 9, 53),
      unread: true,
      isStarred: true,
      from: "Grace Hopper <grace.hopper@example.com>",
      to: ["Ada Lovelace <ada.lovelace@example.com>"],
      subject: "A compiler is just another program",
      snippet: "Once the machine can read its own instructions, the rest follows.",
      unifiedCategory: "primary",
      hasAttachments: true,
      htmlBody: "<p>Once the machine can read its own instructions, the rest follows.</p>",
      textBody: "Once the machine can read its own instructions, the rest follows.",
      attachments: [{
        id: "a-notes",
        filename: "notes.txt",
        mimeType: "text/plain",
        size: 62,
        contentId: null,
        isInlineFromApi: false,
        _bytes: "Once the machine can read its own instructions, the rest follows.\n",
      }],
    }),
    message({
      id: "m-compiler-2",
      threadId: "t-compiler",
      accountId: ACCOUNT_GMAIL,
      folderId: gmailInbox,
      folders: [gmailInbox, "important"],
      when: atLocal(0, 9, 40),
      unread: false,
      from: "Ada Lovelace <ada.lovelace@example.com>",
      to: ["Grace Hopper <grace.hopper@example.com>"],
      subject: "Re: A compiler is just another program",
      snippet: "I sketched the first pass as a table of substitutions.",
      unifiedCategory: "primary",
      htmlBody: "<p>I sketched the first pass as a table of substitutions.</p>",
      textBody: "I sketched the first pass as a table of substitutions.",
    }),
    message({
      id: "m-trajectory",
      accountId: ACCOUNT_OUTLOOK,
      folderId: outlookInbox,
      when: atLocal(0, 8, 12),
      unread: true,
      from: "Katherine Johnson <katherine@example.com>",
      to: ["Grace Hopper <grace.hopper@example.com>"],
      subject: "Trajectory check",
      snippet: "The return numbers match the hand calculation.",
      unifiedCategory: "primary",
      htmlBody: "<p>The return numbers match the hand calculation.</p>",
      textBody: "The return numbers match the hand calculation.",
    }),
    message({
      id: "m-apollo",
      accountId: ACCOUNT_OUTLOOK,
      folderId: outlookInbox,
      when: atLocal(-1, 16, 28),
      unread: false,
      from: "Margaret Hamilton <margaret@example.com>",
      to: ["Grace Hopper <grace.hopper@example.com>"],
      subject: "Onboard software review",
      snippet: "Priority displays are in the build we flew last night.",
      unifiedCategory: "update",
      htmlBody: "<p>Priority displays are in the build we flew last night.</p>",
      textBody: "Priority displays are in the build we flew last night.",
    }),
    message({
      id: "m-salon",
      accountId: ACCOUNT_GMAIL,
      folderId: gmailInbox,
      when: atLocal(-1, 11, 5),
      unread: false,
      from: "Mary Somerville <mary@example.com>",
      to: ["Ada Lovelace <ada.lovelace@example.com>"],
      subject: "Thursday salon",
      snippet: "Bring the diagram. The room is booked from four.",
      unifiedCategory: "social",
      htmlBody: "<p>Bring the diagram. The room is booked from four.</p>",
      textBody: "Bring the diagram. The room is booked from four.",
    }),
    message({
      id: "m-promo",
      accountId: ACCOUNT_GMAIL,
      folderId: gmailInbox,
      when: atLocal(0, 9, 20),
      unread: false,
      from: "Slide Rule Shop <deals@example.com>",
      to: ["Ada Lovelace <ada.lovelace@example.com>"],
      subject: "50% off slide rules this week",
      snippet: "Promo ends Sunday. Free shipping on brass rules.",
      unifiedCategory: "promo",
      htmlBody: "<p>Promo ends Sunday. Free shipping on brass rules.</p>",
      textBody: "Promo ends Sunday. Free shipping on brass rules.",
    }),
    message({
      id: "m-news",
      accountId: ACCOUNT_GMAIL,
      folderId: gmailInbox,
      when: atLocal(0, 9, 10),
      unread: false,
      from: "Analytical Society <news@example.com>",
      to: ["Ada Lovelace <ada.lovelace@example.com>"],
      subject: "Newsletter: this month's tables",
      snippet: "The monthly newsletter lists the new operation tables.",
      unifiedCategory: "newsletter",
      htmlBody: "<p>The monthly newsletter lists the new operation tables.</p>",
      textBody: "The monthly newsletter lists the new operation tables.",
    }),
  ];
}

const accounts = buildAccounts();
const emails = buildEmails();
const snoozes = new Map();
const undos = new Map();
const SNOOZE_MAX_MS = 365 * 24 * 60 * 60 * 1000;
// shortcut: scheduled sample mail stays in memory and is not sent, upgrade when IMAP can send it later.
const scheduled = [];
let scheduleSeq = 0;
// shortcut: sample signatures stay in memory, upgrade when IMAP can store them.
const signatures = [];
let signatureSeq = 0;
let defaultSignatureId = null;

function ok(data) {
  return { success: true, data };
}

function fail(code, message) {
  return { success: false, error: { code, message, status: 0, retryable: false } };
}

function scheduleTo(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
  return String(value || "").trim();
}

function signatureText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function signaturePack() {
  return {
    signatures: signatures.map((row) => ({ ...row })),
    defaultSignatureId,
    defaultSignaturePerAccount: {},
  };
}

function applySignatureDefault(id, flag) {
  if (flag === true) defaultSignatureId = id;
  else if (flag === false && defaultSignatureId === id) defaultSignatureId = null;
}

function inboxUnread(accountId) {
  return emails.filter((email) => email.accountId === accountId && email.folderKey === "inbox" && email.unread).length;
}

function selectEmails(params) {
  const query = params || {};
  const category = query.category || "all";
  return emails.filter((email) => {
    if (query.accountId && email.accountId !== query.accountId) return false;
    const starredFolder = query.folderId === "starred" || String(query.folderId || "").endsWith(":starred");
    if (starredFolder) {
      const inFolder = email.folderId === query.folderId || (email.folders || []).includes(query.folderId);
      if (!email.isStarred && !inFolder) return false;
    } else {
      if (query.folderKey && email.folderKey !== query.folderKey) return false;
      if (query.folderId && email.folderId !== query.folderId && !(email.folders || []).includes(query.folderId)) {
        return false;
      }
    }
    if (category !== "all" && email.unifiedCategory !== category) return false;
    if (query.filterUnread && !email.unread) return false;
    if (query.filterFlagged && !email.isStarred) return false;
    const viewingInbox = !starredFolder && (query.folderKey === "inbox" || (query.folderId && String(query.folderId).endsWith(":inbox")));
    if (viewingInbox && snoozedActive(email.threadId)) return false;
    return true;
  }).sort((a, b) => b.listSortTs - a.listSortTs);
}

function threadMeta(rows) {
  const threads = {};
  for (const email of rows) {
    const bucket = threads[email.threadId] || { messageCount: 0, unreadCount: 0, hasDraft: false };
    bucket.messageCount += 1;
    if (email.unread) bucket.unreadCount += 1;
    threads[email.threadId] = bucket;
  }
  return threads;
}

function listPayload(params) {
  const rows = selectEmails(params).map((email) => ({
    ...email,
    attachments: publicAttachments(email),
  }));
  const oldest = rows.length ? rows[rows.length - 1].listSortTs : null;
  return {
    emails: rows,
    threads: threadMeta(rows),
    hasMore: false,
    hasMoreBelow: false,
    truncated: false,
    syncedOldestDateTs: oldest,
    geometry: { total: rows.length, aboveTop: 0 },
  };
}

function findEmail(id) {
  return emails.find((email) => email.id === id) || null;
}

function notifyList(accountId) {
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("mail:emailsUpdated", {
        accountId: accountId || null,
        folderId: null,
        folderIds: null,
      });
    }
  } catch {
    // The host can answer IPC before a window exists.
  }
}

function folderKeyFrom(entry) {
  const wk = (entry && entry.wellKnownName || "").toLowerCase();
  if (wk === "inbox") return "inbox";
  if (wk === "drafts" || wk === "draft") return "drafts";
  if (wk === "sentitems" || wk === "sent") return "sent";
  if (wk === "deleteditems" || wk === "trash" || wk === "deleted") return "trash";
  if (wk === "archive") return "archive";
  if (wk === "junkemail" || wk === "spam" || wk === "junk") return "spam";
  return "custom";
}

function findFolder(account, folderKeyOrId) {
  const all = [...account.folders.primary, ...account.folders.more];
  const byId = all.find((entry) => entry.id === folderKeyOrId);
  if (byId) return byId;
  return all.find((entry) => folderKeyFrom(entry) === folderKeyOrId) || null;
}

function snoozedActive(threadId) {
  const until = snoozes.get(threadId);
  return !!until && Date.parse(until) > Date.now();
}

function moveEmail(id, folderKeyOrId) {
  const email = findEmail(id);
  if (!email) return false;
  const owner = accounts.find((item) => item.id === email.accountId);
  const dest = owner && findFolder(owner, folderKeyOrId);
  if (!dest) return false;
  email.folderKey = folderKeyFrom(dest);
  email.folderId = dest.id;
  email.folders = [dest.id];
  return true;
}

function idsForMove(params) {
  if (!params) return [];
  if (params.threadId) {
    return emails
      .filter((email) => email.threadId === params.threadId && (!params.accountId || email.accountId === params.accountId))
      .map((email) => email.id);
  }
  if (params.emailId && findEmail(params.emailId)) return [params.emailId];
  if (params.emailId) {
    return emails.filter((email) => email.threadId === params.emailId).map((email) => email.id);
  }
  return [];
}

// shortcut: promo and newsletter tags on the sample mailbox, upgrade when IMAP can file the same tags.
const TIDY_CATEGORIES = new Set(["promo", "newsletter"]);

function tidyInboxIds(accountId) {
  return emails.filter((email) => (
    email.folderKey === "inbox"
    && TIDY_CATEGORIES.has(email.unifiedCategory)
    && (!accountId || email.accountId === accountId)
  )).map((email) => email.id);
}

function moveMany(ids, dest) {
  const snapshots = [];
  for (const id of ids) {
    const email = findEmail(id);
    if (!email) continue;
    snapshots.push({
      id,
      folderId: email.folderId,
      folderKey: email.folderKey,
      folders: [...(email.folders || [])],
    });
    moveEmail(id, dest);
  }
  if (!snapshots.length) return null;
  const opId = `op-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
  undos.set(opId, snapshots);
  notifyList(null);
  return opId;
}

function accountList() {
  return accounts.map((item) => ({
    ...item,
    unreadCount: inboxUnread(item.id),
    folders: {
      primary: item.folders.primary.map((entry) => entry.wellKnownName === "inbox"
        ? { ...entry, unreadCount: inboxUnread(item.id) }
        : entry),
      more: item.folders.more,
    },
  }));
}

function publicAttachments(email) {
  return (email.attachments || []).map((item) => {
    const copy = { ...item };
    delete copy._bytes;
    return copy;
  });
}

function searchRows(params) {
  const filters = (params && params.filters) || {};
  const tokens = String((params && params.query) || "").toLowerCase().split(/\s+/).filter(Boolean);
  return emails.filter((email) => {
    const hay = `${email.subject}\n${email.from}\n${email.snippet}\n${email.textBody || ""}`.toLowerCase();
    if (tokens.length && !tokens.every((token) => hay.includes(token))) return false;
    if (filters.unread && !email.unread) return false;
    if (filters.hasAttachment && !email.hasAttachments) return false;
    if (Number.isFinite(filters.sinceMs) && email.listSortTs < filters.sinceMs) return false;
    if (filters.participant) {
      const who = String(filters.participant).toLowerCase();
      const people = `${email.from}\n${(email.to || []).join("\n")}`.toLowerCase();
      if (!people.includes(who)) return false;
    }
    return true;
  }).slice(0, (params && params.limit) || 30).map((email) => ({
    ...email,
    attachments: publicAttachments(email),
  }));
}

function detailOf(email) {
  return {
    ...email,
    attachments: publicAttachments(email),
  };
}

function answer(channel, args) {
  const params = args && args.length ? args[0] : undefined;
  switch (channel) {
    case "mail:refreshAccounts":
      return ok({ refreshed: true, refreshedAt: Date.now() });
    case "mail:listAccounts":
    case "mail:refreshUnreadCounts":
    case "mail:unreadCounts":
      return ok(accountList());
    case "mail:listFromCacheAggregate":
    case "mail:listFromCache":
    case "mail:listFromNetwork":
    case "mail:listWindowRead":
    case "mail:loadMoreAggregate":
      return ok(listPayload(params));
    case "mail:kickoffAggregateSync":
      return ok({ started: true });
    case "mail:folderStats": {
      const rows = selectEmails({
        accountId: params && params.accountId,
        folderId: params && params.accountId ? params.folderId : undefined,
        folderKey: params && !params.accountId ? params.folderId : undefined,
      });
      return ok({
        flagged: rows.filter((email) => email.isStarred).length,
        unread: rows.filter((email) => email.unread).length,
      });
    }
    case "mail:countInboxUnread":
      return ok({ count: inboxUnread(params && params.accountId) });
    case "mail:countDrafts":
      return ok({ count: 0 });
    case "mail:maskedFolderUnread":
      return ok({ revision: 1, overrides: [] });
    case "mail:getUnifiedCategorySettings":
      return ok({ enabled: true });
    case "mail:getNotificationSettings":
      return ok({ enhanced_notifications_enabled: false });
    case "mail:getNotificationBadgeCount":
      return ok(emails.filter((email) => email.unread).length);
    case "mail:peekMailboxHint":
      return null;
    case "mail:ackMailboxHint":
      return ok(true);
    case "mail:listFailedDraftIds":
      return ok([]);
    case "mail:listSignatures":
      return ok(signaturePack());
    case "mail:upsertSignature": {
      const name = signatureText(params && params.name);
      const text = signatureText(params && params.text);
      const html = signatureText(params && params.html);
      if (!name) return fail("invalid", "Add a name.");
      if (!text && !html) return fail("invalid", "Add signature text.");
      const id = params && params.id ? String(params.id) : "";
      let row = id ? signatures.find((item) => item.id === id) : null;
      if (id && !row) return fail("not-found", "That signature is gone.");
      if (!row) {
        row = { id: `sig-${++signatureSeq}` };
        signatures.push(row);
      }
      row.name = name;
      if (html) {
        row.html = html;
        delete row.text;
      } else {
        row.text = text;
        delete row.html;
      }
      applySignatureDefault(row.id, params && params.isDefault);
      return ok({ ...row });
    }
    case "mail:deleteSignature": {
      const id = params && params.id ? String(params.id) : "";
      const index = signatures.findIndex((item) => item.id === id);
      if (index < 0) return fail("not-found", "That signature is gone.");
      signatures.splice(index, 1);
      if (defaultSignatureId === id) defaultSignatureId = null;
      return ok(true);
    }
    case "mail:ops:queueSummary":
      return ok({ pending: 0, dead: 0, sends: 0 });
    case "mail:ops:getNetworkState":
      return ok({ state: "connected" });
    case "mail:openEmail": {
      const email = findEmail(params && params.emailId);
      if (!email) return { success: false, error: { code: "email-gone", message: "missing" } };
      return ok({ email: detailOf(email), isThread: false, threadMessages: [] });
    }
    case "mail:readEmail": {
      const email = findEmail(params && params.emailId);
      if (!email) return { success: false, error: { code: "email-gone", message: "missing" } };
      return ok(detailOf(email));
    }
    case "mail:getLocalThreadMembers":
    case "mail:listThreadMessages": {
      const threadId = params && params.threadId;
      return ok(emails.filter((email) => email.threadId === threadId).map(detailOf));
    }
    case "mail:markRead": {
      const email = findEmail(params && params.emailId);
      if (email && typeof params.isRead === "boolean") {
        email.unread = !params.isRead;
        email.isRead = params.isRead;
        notifyList(email.accountId);
      }
      return ok(true);
    }
    case "mail:toggleStar": {
      const email = findEmail(params && params.emailId);
      if (email && typeof params.isStarred === "boolean") {
        email.isStarred = params.isStarred;
        notifyList(email.accountId);
      }
      return ok(true);
    }
    case "mail:search":
      return ok(searchRows(params));
    case "mail:tidyInbox": {
      // mail:tidyInbox archives sample inbox mail tagged promo or newsletter.
      // Live IMAP answers { accepted: false } from the mail engine and does not move mail.
      const ids = tidyInboxIds(params && params.accountId);
      const opId = moveMany(ids, "archive");
      return ok({ accepted: true, opIds: opId ? [opId] : [], archived: ids.length, ids });
    }
    case "genmail:configGetShowOneClickTidyEffective":
      return require("./settings").answer("genmail:configGetShowOneClickTidy", []) === true;
    case "mail:archive":
    case "mail:threadArchive": {
      const opId = moveMany(idsForMove(params), "archive");
      return ok({ opIds: opId ? [opId] : [] });
    }
    case "mail:delete":
    case "mail:threadTrash": {
      const opId = moveMany(idsForMove(params), "trash");
      return ok({ opIds: opId ? [opId] : [] });
    }
    case "mail:markSpam": {
      const opId = moveMany(idsForMove(params), "spam");
      return ok({ opIds: opId ? [opId] : [] });
    }
    case "mail:moveToFolder": {
      const opId = moveMany(params && params.emailId ? [params.emailId] : [], params && params.targetFolderId);
      return ok({ opIds: opId ? [opId] : [] });
    }
    case "mail:undoRemoval": {
      for (const opId of (params && params.opIds) || []) {
        for (const snap of undos.get(opId) || []) {
          const email = findEmail(snap.id);
          if (!email) continue;
          email.folderId = snap.folderId;
          email.folderKey = snap.folderKey;
          email.folders = snap.folders;
        }
      }
      notifyList(null);
      return { ok: true, success: true, data: true };
    }
    case "mail:snoozeThread": {
      const when = Date.parse(params && params.snoozedUntil);
      if (!Number.isFinite(when) || when <= Date.now() + 1000) {
        return { success: false, error: { code: "snoozed_until_in_past", message: "Pick a time in the future." } };
      }
      if (when - Date.now() > SNOOZE_MAX_MS) {
        return { success: false, error: { code: "snoozed_until_too_far", message: "Snooze stays within a year." } };
      }
      if (params && params.threadId) snoozes.set(params.threadId, new Date(when).toISOString());
      notifyList(params && params.accountId);
      return { success: true, data: { snoozedUntil: new Date(when).toISOString() } };
    }
    case "mail:unsnoozeThread":
      if (params && params.threadId) snoozes.delete(params.threadId);
      notifyList(params && params.accountId);
      return { success: true, data: true };
    case "mail:listSnoozed": {
      const accountId = params && params.accountId;
      const records = [];
      for (const [threadId, until] of snoozes) {
        if (!snoozedActive(threadId)) continue;
        const email = emails.find((row) => row.threadId === threadId && (!accountId || row.accountId === accountId));
        if (!email) continue;
        records.push({
          threadId,
          accountId: email.accountId,
          state: "snoozed",
          snoozedUntil: until,
        });
      }
      return ok({ records });
    }
    case "mail:fetchAttachmentBytes": {
      const email = findEmail(params && (params.messageId || params.emailId));
      const attachment = email && (email.attachments || []).find((item) => item.id === (params && params.attachmentId));
      if (!attachment || !attachment._bytes) return failAttachment();
      return ok(Buffer.from(attachment._bytes));
    }
    case "mail:downloadAttachment":
    case "mail:openAttachmentExternally":
      return saveSampleAttachment(channel, params);
    case "mail:upsertDraft":
      return ok({
        emailId: (params && params.emailId) || "draft-local",
        draftId: (params && params.draftId) || "draft-local",
      });
    case "mail:send":
      return ok({ emailId: "sent-local", messageId: "sent-local" });
    case "mail:scheduleSend": {
      const to = scheduleTo(params && params.to);
      if (!to) return fail("invalid", "Add a recipient.");
      const when = Date.parse(params && params.sendAt);
      if (!Number.isFinite(when) || when <= Date.now() + 1000) {
        return fail("send_at_in_past", "Pick a time in the future.");
      }
      const row = {
        id: `sched-${++scheduleSeq}`,
        accountId: (params && params.accountId) || "",
        to,
        subject: params && params.subject ? String(params.subject).trim() : "",
        sendAt: new Date(when).toISOString(),
      };
      scheduled.push(row);
      return ok(row);
    }
    case "mail:listScheduled": {
      const accountId = params && params.accountId;
      const rows = accountId ? scheduled.filter((row) => row.accountId === accountId) : scheduled;
      return ok(rows.slice());
    }
    default:
      return undefined;
  }
}

function failAttachment() {
  return { success: false, error: { code: "not-found", message: "That attachment is no longer available.", status: 0, retryable: false } };
}

async function saveSampleAttachment(channel, params) {
  const email = findEmail(params && (params.messageId || params.emailId));
  const attachment = email && (email.attachments || []).find((item) => item.id === (params && params.attachmentId));
  if (!attachment || !attachment._bytes) return failAttachment();
  const bytes = Buffer.from(attachment._bytes);
  if (channel === "mail:openAttachmentExternally") {
    const { shell } = require("electron");
    const dir = path.join(os.tmpdir(), "genmail-exact-attachments");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${Date.now()}-${attachment.filename}`);
    fs.writeFileSync(target, bytes);
    const opened = await shell.openPath(target);
    if (opened) return { success: false, error: { code: "open", message: opened, status: 0, retryable: false } };
    return ok({ path: target });
  }
  const { dialog, BrowserWindow } = require("electron");
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const picked = await dialog.showSaveDialog(win || undefined, { defaultPath: attachment.filename });
  if (picked.canceled || !picked.filePath) {
    return { success: false, error: { code: "cancelled", message: "cancelled", status: 0, retryable: false } };
  }
  fs.writeFileSync(picked.filePath, bytes);
  return ok({ path: picked.filePath });
}

function messagesForAi(limit = 12) {
  try {
    const live = require("./mail/engine").messagesForAi(limit);
    if (Array.isArray(live) && live.length) return live;
  } catch {
    // The mail engine is optional until it has finished opening its cache.
  }
  return emails
    .slice()
    .sort((a, b) => b.listSortTs - a.listSortTs)
    .slice(0, limit)
    .map((email) => ({
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      category: email.unifiedCategory,
    }));
}

module.exports = { answer, messagesForAi, accountList };
