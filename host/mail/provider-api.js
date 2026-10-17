const { apiJson, safeId, cleanName, idList, safeNext } = require("./provider-http");

const GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me";
const MAX_LABELS = 1000;
const MAX_PAGES = 10;

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
  return {
    id,
    name,
    type: well ? "system" : "user",
    editable: !well,
    wellKnown: well || null,
    parentId: safeId(folder.parentFolderId) || "",
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

async function listMailFolders(accessToken, fetchImpl) {
  const url = new URL(`${GRAPH_ROOT}/mailFolders`);
  url.searchParams.set("$top", "100");
  url.searchParams.set("$select", "id,displayName,parentFolderId,childFolderCount,wellKnownName");
  return graphCollect(accessToken, url.toString(), fetchImpl);
}

async function createMailFolder(accessToken, name, fetchImpl) {
  const folder = cleanName(name);
  if (!folder) {
    const error = new Error("Add a folder name.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(`${GRAPH_ROOT}/mailFolders`, accessToken, {
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

module.exports = {
  GMAIL_ROOT,
  GRAPH_ROOT,
  GMAIL_LOCKED,
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
};
