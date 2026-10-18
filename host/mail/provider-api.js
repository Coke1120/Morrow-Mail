const { apiJson, safeId, cleanName, idList, safeNext } = require("./provider-http");

const GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me";
const MAX_LABELS = 1000;
const MAX_PAGES = 10;
const SEARCH_CAP = 80;

const GMAIL_WELL = {
  INBOX: "inbox",
  SENT: "sentitems",
  TRASH: "deleteditems",
  SPAM: "junkemail",
  DRAFT: "drafts",
  STARRED: "starred",
  IMPORTANT: "important",
  UNREAD: "unread",
};

const GMAIL_LOCKED = new Set(Object.keys(GMAIL_WELL).concat([
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]));

function gmailLabelUrl(id) {
  const labelId = safeId(id);
  if (!labelId) return "";
  return `${GMAIL_ROOT}/labels/${encodeURIComponent(labelId)}`;
}

function gmailModifyUrl(messageId) {
  const id = safeId(messageId);
  if (!id) return "";
  return `${GMAIL_ROOT}/messages/${encodeURIComponent(id)}/modify`;
}

function gmailMessageQuery(rfcMessageId) {
  const bare = String(rfcMessageId || "").trim().replace(/^<|>$/g, "");
  if (!bare || bare.length > 998 || /[\u0000-\u001f\u007f]/.test(bare)) return "";
  const url = new URL(`${GMAIL_ROOT}/messages`);
  url.searchParams.set("q", `rfc822msgid:${bare}`);
  url.searchParams.set("maxResults", "1");
  return url.toString();
}

function graphFolderUrl(id) {
  const folderId = safeId(id);
  if (!folderId) return "";
  return `${GRAPH_ROOT}/mailFolders/${encodeURIComponent(folderId)}`;
}

function graphMessageLookup(rfcMessageId) {
  const raw = String(rfcMessageId || "").trim();
  if (!raw || raw.length > 998 || /['"\\\u0000-\u001f\u007f]/.test(raw)) return "";
  const wrapped = raw.startsWith("<") ? raw : `<${raw}>`;
  const url = new URL(`${GRAPH_ROOT}/messages`);
  url.searchParams.set("$filter", `internetMessageId eq '${wrapped}'`);
  url.searchParams.set("$select", "id");
  url.searchParams.set("$top", "1");
  return url.toString();
}

function graphMoveUrl(messageId) {
  const id = safeId(messageId);
  if (!id) return "";
  return `${GRAPH_ROOT}/messages/${encodeURIComponent(id)}/move`;
}

function normalizeGmailLabel(label) {
  if (!label || !safeId(label.id)) return null;
  const id = safeId(label.id);
  const system = label.type === "system" || GMAIL_LOCKED.has(id);
  const name = cleanName(label.name) || (system ? id : "");
  if (!name) return null;
  return {
    id,
    name,
    type: system ? "system" : "user",
    editable: !system && label.type === "user",
    wellKnown: GMAIL_WELL[id] || null,
  };
}

function normalizeGmailLabels(payload) {
  const labels = payload && Array.isArray(payload.labels) ? payload.labels : null;
  if (!labels) {
    const error = new Error("Gmail did not return a label list.");
    error.code = "provider";
    throw error;
  }
  if (labels.length > MAX_LABELS) {
    const error = new Error("This mailbox has more than 1,000 labels.");
    error.code = "too_many";
    throw error;
  }
  return labels.map(normalizeGmailLabel).filter(Boolean).sort(byName);
}

function normalizeGraphFolder(folder) {
  if (!folder || !safeId(folder.id)) return null;
  const id = safeId(folder.id);
  const name = cleanName(folder.displayName) || id;
  const well = folder.wellKnownName ? String(folder.wellKnownName).toLowerCase() : "";
  const count = Number(folder.childFolderCount);
  return {
    id,
    name,
    type: well ? "system" : "user",
    editable: !well,
    wellKnown: well || null,
    parentId: safeId(folder.parentFolderId) || "",
    childCount: Number.isFinite(count) && count > 0 ? count : 0,
  };
}

function normalizeGraphFolders(payload) {
  const folders = payload && Array.isArray(payload.value) ? payload.value : null;
  if (!folders) {
    const error = new Error("Outlook did not return a folder list.");
    error.code = "provider";
    throw error;
  }
  return folders.map(normalizeGraphFolder).filter(Boolean);
}

function byName(a, b) {
  if (a.editable !== b.editable) return a.editable ? 1 : -1;
  return String(a.name).localeCompare(String(b.name));
}

async function listLabels(accessToken, fetchImpl) {
  const json = await apiJson(`${GMAIL_ROOT}/labels`, accessToken, { fetchImpl });
  return normalizeGmailLabels(json);
}

async function createLabel(accessToken, name, fetchImpl) {
  const label = cleanName(name);
  if (!label) {
    const error = new Error("Add a label name.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(`${GMAIL_ROOT}/labels`, accessToken, {
    method: "POST",
    fetchImpl,
    body: {
      name: label,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  const created = normalizeGmailLabel(json);
  if (!created) {
    const error = new Error("Gmail did not return the new label.");
    error.code = "provider";
    throw error;
  }
  return created;
}

async function renameLabel(accessToken, id, name, fetchImpl) {
  const labelId = safeId(id);
  const label = cleanName(name);
  if (!labelId || GMAIL_LOCKED.has(labelId)) {
    const error = new Error("That Gmail label cannot be changed.");
    error.code = "invalid";
    throw error;
  }
  if (!label) {
    const error = new Error("Add a label name.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(gmailLabelUrl(labelId), accessToken, {
    method: "PATCH",
    fetchImpl,
    body: { name: label },
  });
  const renamed = normalizeGmailLabel({ ...json, id: json.id || labelId, type: "user" });
  if (!renamed) {
    const error = new Error("Gmail did not return the renamed label.");
    error.code = "provider";
    throw error;
  }
  return renamed;
}

async function deleteLabel(accessToken, id, fetchImpl) {
  const labelId = safeId(id);
  if (!labelId || GMAIL_LOCKED.has(labelId)) {
    const error = new Error("That Gmail label cannot be changed.");
    error.code = "invalid";
    throw error;
  }
  await apiJson(gmailLabelUrl(labelId), accessToken, { method: "DELETE", fetchImpl });
  return { id: labelId };
}

async function gmailMessageId(accessToken, rfcMessageId, fetchImpl) {
  const url = gmailMessageQuery(rfcMessageId);
  if (!url) {
    const error = new Error("This message has no RFC Message-ID, so Gmail labels cannot be changed.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(url, accessToken, { fetchImpl });
  const id = json.messages && json.messages[0] && safeId(json.messages[0].id);
  if (!id) {
    const error = new Error("Gmail has no message with that Message-ID.");
    error.code = "not-found";
    throw error;
  }
  return id;
}

async function modifyLabels(accessToken, rfcMessageId, addLabelIds, removeLabelIds, fetchImpl) {
  const add = idList(addLabelIds);
  const remove = idList(removeLabelIds);
  if (!add || !remove) {
    const error = new Error("Too many labels in that change.");
    error.code = "invalid";
    throw error;
  }
  if (!add.length && !remove.length) {
    const error = new Error("Choose a label.");
    error.code = "invalid";
    throw error;
  }
  const messageId = await gmailMessageId(accessToken, rfcMessageId, fetchImpl);
  await apiJson(gmailModifyUrl(messageId), accessToken, {
    method: "POST",
    fetchImpl,
    body: { addLabelIds: add, removeLabelIds: remove },
  });
  return { messageId, addLabelIds: add, removeLabelIds: remove };
}

async function graphCollect(accessToken, startUrl, fetchImpl) {
  const rows = [];
  let next = startUrl;
  const seen = new Set();
  let pages = 0;
  while (next) {
    pages += 1;
    if (pages > MAX_PAGES || seen.has(next)) {
      const error = new Error("Outlook returned too many folder pages.");
      error.code = "too_many";
      throw error;
    }
    seen.add(next);
    const json = await apiJson(next, accessToken, { fetchImpl });
    const chunk = normalizeGraphFolders(json);
    rows.push(...chunk);
    if (rows.length > MAX_LABELS) {
      const error = new Error("This mailbox has more than 1,000 folders.");
      error.code = "too_many";
      throw error;
    }
    next = safeNext(json["@odata.nextLink"], "graph.microsoft.com");
  }
  return rows.sort(byName);
}

const CHILD_REQUESTS = 50;

function graphFolderListUrl(path) {
  const url = new URL(path);
  url.searchParams.set("$top", "100");
  url.searchParams.set("$select", "id,displayName,parentFolderId,childFolderCount,wellKnownName");
  return url.toString();
}

async function listMailFolders(accessToken, fetchImpl) {
  const rows = await graphCollect(accessToken, graphFolderListUrl(`${GRAPH_ROOT}/mailFolders`), fetchImpl);
  const seen = new Set(rows.map((folder) => folder.id));
  const queue = rows.filter((folder) => folder.childCount > 0);
  let hops = 0;
  while (queue.length && hops < CHILD_REQUESTS && rows.length < MAX_LABELS) {
    const parent = queue.shift();
    hops += 1;
    const children = await graphCollect(
      accessToken,
      graphFolderListUrl(`${GRAPH_ROOT}/mailFolders/${encodeURIComponent(parent.id)}/childFolders`),
      fetchImpl
    );
    for (const child of children) {
      if (!child || seen.has(child.id)) continue;
      if (rows.length >= MAX_LABELS) {
        const error = new Error("This mailbox has more than 1,000 folders.");
        error.code = "too_many";
        throw error;
      }
      seen.add(child.id);
      rows.push(child);
      if (child.childCount > 0) queue.push(child);
    }
  }
  return rows.sort(byName);
}

async function createMailFolder(accessToken, name, parentId, fetchImpl) {
  const folder = cleanName(name);
  if (!folder) {
    const error = new Error("Add a folder name.");
    error.code = "invalid";
    throw error;
  }
  const parent = safeId(parentId);
  const url = parent
    ? `${GRAPH_ROOT}/mailFolders/${encodeURIComponent(parent)}/childFolders`
    : `${GRAPH_ROOT}/mailFolders`;
  const json = await apiJson(url, accessToken, {
    method: "POST",
    fetchImpl,
    body: { displayName: folder },
  });
  const created = normalizeGraphFolder(json);
  if (!created) {
    const error = new Error("Outlook did not return the new folder.");
    error.code = "provider";
    throw error;
  }
  return created;
}

async function renameMailFolder(accessToken, id, name, fetchImpl) {
  const folderId = safeId(id);
  const folder = cleanName(name);
  if (!folderId) {
    const error = new Error("That Outlook folder cannot be changed.");
    error.code = "invalid";
    throw error;
  }
  if (!folder) {
    const error = new Error("Add a folder name.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(graphFolderUrl(folderId), accessToken, {
    method: "PATCH",
    fetchImpl,
    body: { displayName: folder },
  });
  const renamed = normalizeGraphFolder({ ...json, id: json.id || folderId });
  if (!renamed) {
    const error = new Error("Outlook did not return the renamed folder.");
    error.code = "provider";
    throw error;
  }
  return renamed;
}

async function deleteMailFolder(accessToken, id, fetchImpl) {
  const folderId = safeId(id);
  if (!folderId) {
    const error = new Error("That Outlook folder cannot be changed.");
    error.code = "invalid";
    throw error;
  }
  await apiJson(graphFolderUrl(folderId), accessToken, { method: "DELETE", fetchImpl });
  return { id: folderId };
}

async function graphMessageId(accessToken, rfcMessageId, fetchImpl) {
  const url = graphMessageLookup(rfcMessageId);
  if (!url) {
    const error = new Error("This message has no RFC Message-ID, so Outlook cannot move it.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(url, accessToken, { fetchImpl });
  const id = json.value && json.value[0] && safeId(json.value[0].id);
  if (!id) {
    const error = new Error("Outlook has no message with that Message-ID.");
    error.code = "not-found";
    throw error;
  }
  return id;
}

async function moveMessage(accessToken, rfcMessageId, destinationId, fetchImpl) {
  const destination = safeId(destinationId);
  if (!destination) {
    const error = new Error("Choose an Outlook folder.");
    error.code = "invalid";
    throw error;
  }
  const messageId = await graphMessageId(accessToken, rfcMessageId, fetchImpl);
  const json = await apiJson(graphMoveUrl(messageId), accessToken, {
    method: "POST",
    fetchImpl,
    body: { destinationId: destination },
  });
  return { messageId, destinationId: destination, id: safeId(json.id) || messageId };
}

function searchCap(limit) {
  return Math.min(Math.max(Number(limit) || SEARCH_CAP, 1), SEARCH_CAP);
}

function gmailSearchUrl(query, limit, pageToken) {
  const q = String(query || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 400);
  if (!q) return "";
  const url = new URL(`${GMAIL_ROOT}/messages`);
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", String(searchCap(limit)));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

function graphSearchUrl(query, limit) {
  const q = String(query || "").replace(/["\\\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!q) return "";
  const url = new URL(`${GRAPH_ROOT}/messages`);
  url.searchParams.set("$search", `"${q}"`);
  url.searchParams.set("$top", String(searchCap(limit)));
  url.searchParams.set("$select", "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,internetMessageId,isRead,conversationId,hasAttachments");
  return url.toString();
}

function nextPageToken(value) {
  const token = String(value || "");
  if (!token || token.length > 2048 || /[\u0000-\u001f\u007f]/.test(token)) return "";
  return token;
}

function headerValue(payload, name) {
  const headers = payload && payload.payload && Array.isArray(payload.payload.headers) ? payload.payload.headers : [];
  const found = headers.find((header) => header && String(header.name || "").toLowerCase() === name);
  return found && found.value ? String(found.value) : "";
}

function addressList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function graphAddress(entry) {
  const who = entry && entry.emailAddress;
  if (!who) return "";
  if (who.name && who.address) return `${who.name} <${who.address}>`;
  return who.address || who.name || "";
}

function gmailHit(message) {
  if (!message || !safeId(message.id)) return null;
  const when = Number(message.internalDate);
  return {
    providerId: safeId(message.id),
    rfcMessageId: headerValue(message, "message-id"),
    subject: headerValue(message, "subject"),
    from: headerValue(message, "from"),
    to: addressList(headerValue(message, "to")),
    cc: addressList(headerValue(message, "cc")),
    date: Number.isFinite(when) ? new Date(when).toISOString() : (headerValue(message, "date") || new Date().toISOString()),
    snippet: message.snippet || "",
    unread: Array.isArray(message.labelIds) && message.labelIds.includes("UNREAD"),
    threadId: message.threadId || safeId(message.id),
    hasAttachments: false,
  };
}

function graphHit(row) {
  if (!row || !safeId(row.id)) return null;
  const body = row.body && typeof row.body.content === "string" ? row.body.content : "";
  const html = row.body && String(row.body.contentType || "").toLowerCase() === "text" ? "" : body;
  return {
    providerId: safeId(row.id),
    rfcMessageId: row.internetMessageId || "",
    subject: row.subject || "",
    from: graphAddress(row.from),
    to: (row.toRecipients || []).map(graphAddress).filter(Boolean),
    cc: (row.ccRecipients || []).map(graphAddress).filter(Boolean),
    date: row.receivedDateTime || new Date().toISOString(),
    snippet: row.bodyPreview || "",
    html: html || null,
    text: html ? "" : body,
    unread: row.isRead === false,
    threadId: row.conversationId || safeId(row.id),
    hasAttachments: row.hasAttachments === true,
  };
}

async function searchGmail(accessToken, query, limit, fetchImpl) {
  const cap = searchCap(limit);
  const ids = [];
  let token = "";
  for (let page = 0; page < 4 && ids.length < cap; page += 1) {
    const url = gmailSearchUrl(query, cap - ids.length, token);
    if (!url) break;
    const json = await apiJson(url, accessToken, { fetchImpl });
    const rows = json && Array.isArray(json.messages) ? json.messages : [];
    for (const row of rows) {
      const id = safeId(row && row.id);
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length >= cap) break;
    }
    token = nextPageToken(json && json.nextPageToken);
    if (!token || !rows.length) break;
  }
  const hits = [];
  for (const id of ids) {
    const meta = new URL(`${GMAIL_ROOT}/messages/${encodeURIComponent(id)}`);
    meta.searchParams.set("format", "metadata");
    for (const name of ["Subject", "From", "To", "Cc", "Date", "Message-ID"]) {
      meta.searchParams.append("metadataHeaders", name);
    }
    const json = await apiJson(meta.toString(), accessToken, { fetchImpl });
    const hit = gmailHit(json);
    if (hit) hits.push(hit);
  }
  return hits;
}

async function searchGraph(accessToken, query, limit, fetchImpl) {
  const url = graphSearchUrl(query, limit);
  if (!url) return [];
  const json = await apiJson(url, accessToken, {
    fetchImpl,
    headers: { ConsistencyLevel: "eventual" },
  });
  const rows = json && Array.isArray(json.value) ? json.value : [];
  return rows.map(graphHit).filter(Boolean).slice(0, searchCap(limit));
}

module.exports = {
  GMAIL_ROOT,
  GRAPH_ROOT,
  GMAIL_LOCKED,
  SEARCH_CAP,
  gmailSearchUrl,
  graphSearchUrl,
  gmailLabelUrl,
  gmailModifyUrl,
  gmailMessageQuery,
  graphFolderUrl,
  graphMessageLookup,
  graphMoveUrl,
  normalizeGmailLabel,
  normalizeGmailLabels,
  normalizeGraphFolder,
  normalizeGraphFolders,
  listLabels,
  createLabel,
  renameLabel,
  deleteLabel,
  modifyLabels,
  listMailFolders,
  createMailFolder,
  renameMailFolder,
  deleteMailFolder,
  moveMessage,
  searchGmail,
  searchGraph,
};
