const crypto = require("node:crypto");
const { apiJson, safeId, cleanName, idList, safeNext } = require("./provider-http");
const senderHistory = require("../../shared/sender-history");

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
  if (!bare || bare.length > 998 || /[\s"\\<>\u0000-\u001f\u007f]/.test(bare)) return "";
  const url = new URL(`${GMAIL_ROOT}/messages`);
  url.searchParams.set("q", `rfc822msgid:${bare}`);
  url.searchParams.set("maxResults", "2");
  url.searchParams.set("includeSpamTrash", "true");
  return url.toString();
}

function graphFolderUrl(id) {
  const folderId = safeId(id);
  if (!folderId) return "";
  return `${GRAPH_ROOT}/mailFolders/${encodeURIComponent(folderId)}`;
}

function graphFolderMoveUrl(id) {
  const base = graphFolderUrl(id);
  return base ? `${base}/move` : "";
}

function graphMessageLookup(rfcMessageId, folderId) {
  const raw = String(rfcMessageId || "").trim();
  if (!raw || raw.length > 998 || /['"\\\u0000-\u001f\u007f]/.test(raw)) return "";
  const wrapped = raw.startsWith("<") ? raw : `<${raw}>`;
  const folder = folderId && graphFolderUrl(folderId);
  if (folderId && !folder) return "";
  const url = new URL(`${folder || GRAPH_ROOT}/messages`);
  url.searchParams.set("$filter", `internetMessageId eq '${wrapped}'`);
  url.searchParams.set("$select", "id");
  url.searchParams.set("$top", "2");
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

async function listSendAs(accessToken, fetchImpl) {
  const json = await apiJson(`${GMAIL_ROOT}/settings/sendAs`, accessToken, {
    fetchImpl: fetchImpl || ((url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) })),
    maxBytes: 1024 * 1024,
  });
  if (!Array.isArray(json.sendAs)) throw new Error("Gmail did not return its send-as addresses.");
  const { address } = require("../../shared/compose-policy");
  return json.sendAs.filter((row) => row.isPrimary || row.verificationStatus === "accepted")
    .map((row) => ({ email: address(row.sendAsEmail), name: row.displayName || "", isPrimary: row.isPrimary === true,
      isDefault: row.isDefault === true, verificationStatus: row.verificationStatus || "", verified: true, source: "gmail" })).filter((row) => row.email);
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

function gmailLeaf(name) {
  const text = String(name || "");
  const cut = text.lastIndexOf("/");
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function gmailTreeParent(labels, source) {
  const byName = new Map();
  for (const row of labels) {
    if (row && row.name && !byName.has(row.name)) byName.set(row.name, row);
  }
  let name = String(source.name || "");
  let cut = name.lastIndexOf("/");
  while (cut > 0) {
    const parent = byName.get(name.slice(0, cut));
    if (parent && parent.id !== source.id) return parent;
    name = name.slice(0, cut);
    cut = name.lastIndexOf("/");
  }
  return null;
}

function planGmailLabelMove(labels, sourceId, destinationId) {
  const rows = (Array.isArray(labels) ? labels : []).filter((row) => row && row.id && row.name);
  const source = rows.find((row) => row.id === String(sourceId || ""));
  if (!source) return { ok: false, code: "not-found", message: "That Gmail label is not in this mailbox." };
  if (source.editable === false || source.type === "system" || GMAIL_LOCKED.has(source.id)) {
    return { ok: false, code: "invalid", message: "This Gmail label cannot be moved." };
  }
  const destRaw = destinationId ? String(destinationId) : "";
  const root = !destRaw;
  const dest = root ? null : rows.find((row) => row.id === destRaw);
  if (!root && !dest) return { ok: false, code: "not-found", message: "That destination is not in this mailbox." };
  const moving = rows.filter((row) => row.name === source.name || row.name.startsWith(`${source.name}/`));
  const movingIds = new Set(moving.map((row) => row.id));
  if (dest && movingIds.has(dest.id)) {
    return { ok: false, code: "invalid", message: "A label cannot move into itself or one of its own sub-labels." };
  }
  const parent = gmailTreeParent(rows, source);
  if ((root && !parent) || (dest && parent && dest.id === parent.id)) {
    return { ok: false, code: "invalid", message: "This label is already there." };
  }
  const nextName = dest ? `${dest.name}/${gmailLeaf(source.name)}` : gmailLeaf(source.name);
  if (!nextName || nextName.length > 200) {
    return { ok: false, code: "invalid", message: "That path is too long for Gmail." };
  }
  const renames = moving.map((row) => ({
    id: row.id,
    from: row.name,
    to: nextName + row.name.slice(source.name.length),
  }));
  renames.sort((a, b) => b.from.length - a.from.length || b.from.localeCompare(a.from));
  const taken = new Map();
  for (const row of rows) {
    if (!movingIds.has(row.id)) taken.set(row.name, row.id);
  }
  const used = new Set();
  for (const step of renames) {
    if (!step.to || step.to.length > 200) {
      return { ok: false, code: "invalid", message: "That path is too long for Gmail." };
    }
    if (taken.has(step.to) || used.has(step.to)) {
      return {
        ok: false,
        code: "collision",
        message: `“${step.to}” already exists, so this move was not started.`,
      };
    }
    used.add(step.to);
  }
  return { ok: true, sourceId: source.id, sourceName: source.name, nextName, renames };
}

function partialMoveMessage(moved, failed) {
  const failedNames = failed.map((step) => step.from).join(", ");
  const movedNames = moved.map((step) => `${step.from} → ${step.to}`).join(", ");
  const head = moved.length
    ? `Partly renamed (${movedNames}). Failed: ${failedNames}. The mailbox is only partly renamed.`
    : `No labels were renamed. Failed: ${failedNames}.`;
  return head.slice(0, 280);
}

async function moveLabel(accessToken, id, destinationId, fetchImpl) {
  const labels = await listLabels(accessToken, fetchImpl);
  const plan = planGmailLabelMove(labels, id, destinationId);
  if (!plan.ok) {
    const error = new Error(plan.message);
    error.code = plan.code || "invalid";
    throw error;
  }
  const moved = [];
  const failed = [];
  for (const step of plan.renames) {
    try {
      await renameLabel(accessToken, step.id, step.to, fetchImpl);
      moved.push(step);
    } catch (error) {
      failed.push({
        id: step.id,
        from: step.from,
        to: step.to,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed.length) {
    const error = new Error(partialMoveMessage(moved, failed));
    error.code = "partial";
    error.failed = failed;
    error.moved = moved;
    throw error;
  }
  return { id: plan.sourceId, name: plan.nextName, renamed: moved };
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

function messageIdentityError() {
  return Object.assign(new Error("This message cannot be matched uniquely in its source mailbox folder. Refresh before retrying; no mail was changed."), { code: "conflict" });
}

async function gmailMessageId(accessToken, identity, fetchImpl) {
  if (identity && typeof identity === "object" && identity.providerId) {
    const id = safeId(identity.providerId);
    if (!id || id !== identity.providerId) throw messageIdentityError();
    return id;
  }
  const url = gmailMessageQuery(typeof identity === "string" ? identity : identity?.rfcMessageId);
  if (!url) {
    const error = new Error("This message has no RFC Message-ID, so Gmail labels cannot be changed.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(url, accessToken, { fetchImpl });
  if (json.nextPageToken || !Array.isArray(json.messages) || json.messages.length > 1) throw messageIdentityError();
  const id = json.messages[0] && safeId(json.messages[0].id);
  if (!id) {
    const error = new Error("Gmail has no message with that Message-ID.");
    error.code = "not-found";
    throw error;
  }
  if (identity && typeof identity === "object") {
    const source = identity.sourceFolder;
    if (!source) throw messageIdentityError();
    let labelId = source.providerId;
    if (!labelId && source.wellKnown !== "all") {
      const labels = await listLabels(accessToken, fetchImpl);
      const matches = labels.filter(label => source.wellKnown ? label.wellKnown === source.wellKnown : label.name === source.path);
      if (matches.length !== 1) throw messageIdentityError();
      labelId = matches[0].id;
    }
    const message = await apiJson(`${GMAIL_ROOT}/messages/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`, accessToken, { fetchImpl });
    if (message.id !== id || !Array.isArray(message.labelIds) || (source.wellKnown === "all"
      ? message.labelIds.includes("TRASH") || message.labelIds.includes("SPAM") : !message.labelIds.includes(labelId))) throw messageIdentityError();
  }
  return id;
}

async function modifyLabels(accessToken, identity, addLabelIds, removeLabelIds, fetchImpl) {
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
  const messageId = await gmailMessageId(accessToken, identity, fetchImpl);
  if (identity && typeof identity.check === "function") identity.check();
  const json = await apiJson(gmailModifyUrl(messageId), accessToken, {
    method: "POST",
    fetchImpl,
    body: { addLabelIds: add, removeLabelIds: remove },
  });
  return { messageId, addLabelIds: add, removeLabelIds: remove,
    ...(Array.isArray(json.labelIds) ? { labelIds: idList(json.labelIds, MAX_LABELS) } : {}) };
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
  url.searchParams.set("$select", "id,displayName,parentFolderId,childFolderCount");
  return url.toString();
}

// Scope the short-lived cache to the exact grant without retaining its bearer token.
const graphSystemCache = new Map();
async function graphSystemFolders(accessToken, fetchImpl) {
  const key = crypto.createHash("sha256").update(accessToken).digest("hex");
  const cached = graphSystemCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.ids;
  const ids = new Map();
  const names = ["archive", "clutter", "conflicts", "conversationhistory", "deleteditems",
    "drafts", "inbox", "junkemail", "localfailures", "msgfolderroot", "outbox",
    "recoverableitemsdeletions", "scheduled", "searchfolders", "sentitems",
    "serverfailures", "syncissues"];
  // Limit concurrency to avoid a burst against Graph on large mailboxes.
  for (let start = 0; start < names.length; start += 4) {
    await Promise.all(names.slice(start, start + 4).map(async (name) => {
      let system;
      try {
        system = await apiJson(`${GRAPH_ROOT}/mailFolders/${name}?$select=id`, accessToken, { fetchImpl });
      } catch (error) {
        if (error.status === 404) return; // Optional folders need not exist.
        throw error;
      }
      if (!safeId(system.id)) {
        const error = new Error("Outlook did not identify its system folder.");
        error.code = "provider";
        throw error;
      }
      ids.set(system.id, name);
    }));
  }
  if (graphSystemCache.size >= 32) graphSystemCache.delete(graphSystemCache.keys().next().value);
  graphSystemCache.set(key, { ids, expires: Date.now() + 5 * 60 * 1000 });
  return ids;
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
  // wellKnownName is a beta-only property. v1.0 supports addressing these
  // folders by alias; compare their stable IDs, never translated display names.
  if (rows.some((folder) => !folder.wellKnown)) {
    const identities = await graphSystemFolders(accessToken, fetchImpl);
    for (const row of rows) {
      const name = identities.get(row.id);
      if (name) Object.assign(row, { type: "system", editable: false, wellKnown: name });
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

function graphDescendantIds(folders, sourceId) {
  const children = new Map();
  for (const row of folders) {
    if (!row || !row.parentId) continue;
    const list = children.get(row.parentId) || [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const ids = new Set();
  const stack = (children.get(sourceId) || []).slice();
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of children.get(id) || []) stack.push(child);
  }
  return ids;
}

function graphListedParent(folders, row) {
  if (!row || !row.parentId) return null;
  return folders.find((item) => item.id === row.parentId) || null;
}

function planGraphFolderMove(folders, sourceId, destinationId) {
  const rows = (Array.isArray(folders) ? folders : []).filter((row) => row && row.id);
  const source = rows.find((row) => row.id === String(sourceId || ""));
  if (!source) return { ok: false, code: "not-found", message: "That Outlook folder is not in this mailbox." };
  if (source.editable === false || source.wellKnown || source.type === "system") {
    return { ok: false, code: "invalid", message: "This Outlook folder cannot be moved." };
  }
  const destRaw = destinationId ? String(destinationId) : "";
  const root = !destRaw || destRaw === "msgfolderroot" || destRaw === "root";
  const dest = root ? null : rows.find((row) => row.id === destRaw);
  if (!root && !dest) return { ok: false, code: "not-found", message: "That destination is not in this mailbox." };
  const kids = graphDescendantIds(rows, source.id);
  if (dest && (dest.id === source.id || kids.has(dest.id))) {
    return { ok: false, code: "invalid", message: "A folder cannot move into itself or one of its own sub-folders." };
  }
  const parent = graphListedParent(rows, source);
  if ((root && !parent) || (dest && parent && dest.id === parent.id)) {
    return { ok: false, code: "invalid", message: "This folder is already there." };
  }
  const parentKey = root ? "" : dest.id;
  const sibling = rows.find((row) => {
    if (row.id === source.id) return false;
    const rowParent = graphListedParent(rows, row);
    const rowParentId = rowParent ? rowParent.id : "";
    return rowParentId === parentKey && String(row.name || "").toLowerCase() === String(source.name || "").toLowerCase();
  });
  if (sibling) {
    return {
      ok: false,
      code: "collision",
      message: `“${source.name}” already exists there, so this move was not started.`,
    };
  }
  return {
    ok: true,
    sourceId: source.id,
    destinationId: root ? "msgfolderroot" : dest.id,
  };
}

async function moveMailFolder(accessToken, id, destinationId, fetchImpl) {
  const folders = await listMailFolders(accessToken, fetchImpl);
  const plan = planGraphFolderMove(folders, id, destinationId);
  if (!plan.ok) {
    const error = new Error(plan.message);
    error.code = plan.code || "invalid";
    throw error;
  }
  const json = await apiJson(graphFolderMoveUrl(plan.sourceId), accessToken, {
    method: "POST",
    fetchImpl,
    body: { destinationId: plan.destinationId },
  });
  const moved = normalizeGraphFolder(json);
  if (!moved) {
    const error = new Error("Outlook did not return the moved folder.");
    error.code = "provider";
    throw error;
  }
  return moved;
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

async function graphSourceFolder(accessToken, source, fetchImpl) {
  if (!source || !source.path) throw messageIdentityError();
  if (source.providerId) {
    const id = safeId(source.providerId);
    if (!id || id !== source.providerId) throw messageIdentityError();
    return id;
  }
  const folders = await listMailFolders(accessToken, fetchImpl);
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const matches = folders.filter(folder => {
    if (source.wellKnown) return folder.wellKnown === source.wellKnown;
    const names = [folder.name], seen = new Set([folder.id]);
    let parent = byId.get(folder.parentId);
    while (parent) {
      if (seen.has(parent.id)) return false;
      seen.add(parent.id);
      names.unshift(parent.name);
      parent = byId.get(parent.parentId);
    }
    return names.join(source.delimiter || "/") === source.path;
  });
  if (matches.length !== 1) throw messageIdentityError();
  return matches[0].id;
}

async function graphMessageId(accessToken, identity, fetchImpl) {
  const sourceId = await graphSourceFolder(accessToken, identity?.sourceFolder, fetchImpl);
  const url = graphMessageLookup(identity?.rfcMessageId, sourceId);
  if (!url) {
    const error = new Error("This message has no RFC Message-ID, so Outlook cannot move it.");
    error.code = "invalid";
    throw error;
  }
  const json = await apiJson(url, accessToken, { fetchImpl });
  if (json["@odata.nextLink"] || !Array.isArray(json.value) || json.value.length > 1) throw messageIdentityError();
  const id = json.value[0] && safeId(json.value[0].id);
  if (!id) {
    const error = new Error("Outlook has no message with that Message-ID.");
    error.code = "not-found";
    throw error;
  }
  return id;
}

async function moveMessage(accessToken, identity, destinationId, fetchImpl) {
  const destination = safeId(destinationId);
  if (!destination) {
    const error = new Error("Choose an Outlook folder.");
    error.code = "invalid";
    throw error;
  }
  if (identity && typeof identity.check === "function") identity.check();
  const messageId = await graphMessageId(accessToken, identity, fetchImpl);
  if (identity && typeof identity.check === "function") identity.check();
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

function graphFromAddressUrl(address, limit) {
  const filter = senderHistory.graphFromFilter(address);
  if (!filter) return "";
  const url = new URL(`${GRAPH_ROOT}/messages`);
  url.searchParams.set("$filter", filter);
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$top", String(searchCap(limit)));
  url.searchParams.set("$select", "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,internetMessageId,isRead,conversationId,hasAttachments");
  return url.toString();
}

function graphSenderNext(link) {
  const safe = safeNext(link, "graph.microsoft.com");
  if (!safe) return "";
  let url;
  try { url = new URL(safe); } catch { return ""; }
  if (!url.pathname.startsWith("/v1.0/me/messages")) return "";
  return safe;
}

function graphFilterUnsupported(error) {
  if (!error || error.status !== 400) return false;
  const blob = `${error.providerCode || ""} ${error.providerDetail || ""}`;
  return /unsupported|InefficientFilter|ErrorInvalidUrl|too complex|not support/i.test(blob);
}

async function gmailMetadata(accessToken, id, fetchImpl) {
  const meta = new URL(`${GMAIL_ROOT}/messages/${encodeURIComponent(id)}`);
  meta.searchParams.set("format", "metadata");
  for (const name of ["Subject", "From", "To", "Cc", "Date", "Message-ID"]) {
    meta.searchParams.append("metadataHeaders", name);
  }
  const json = await apiJson(meta.toString(), accessToken, { fetchImpl });
  return gmailHit(json);
}

async function searchGmailPage(accessToken, query, limit, pageToken, fetchImpl) {
  const cap = searchCap(limit);
  const url = gmailSearchUrl(query, cap, pageToken || "");
  if (!url) return { hits: [], nextPageToken: "", short: true };
  const json = await apiJson(url, accessToken, { fetchImpl });
  const rows = json && Array.isArray(json.messages) ? json.messages : [];
  const ids = [];
  for (const row of rows) {
    const id = safeId(row && row.id);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  const hits = [];
  for (const id of ids) {
    const hit = await gmailMetadata(accessToken, id, fetchImpl);
    if (hit) hits.push(hit);
  }
  const next = nextPageToken(json && json.nextPageToken);
  return { hits, nextPageToken: next, short: ids.length < cap };
}

async function searchGraphFromPage(accessToken, address, limit, nextLink, fetchImpl) {
  const url = nextLink ? graphSenderNext(nextLink) : graphFromAddressUrl(address, limit);
  if (!url) return { hits: [], nextLink: "", short: true };
  try {
    const json = await apiJson(url, accessToken, {
      fetchImpl,
      headers: { ConsistencyLevel: "eventual" },
    });
    const rows = json && Array.isArray(json.value) ? json.value : [];
    const hits = rows.map(graphHit).filter(Boolean);
    const raw = json && json["@odata.nextLink"] ? String(json["@odata.nextLink"]) : "";
    const next = raw ? graphSenderNext(raw) : "";
    const short = !raw || !next || rows.length < searchCap(limit);
    return { hits, nextLink: next, short };
  } catch (error) {
    if (graphFilterUnsupported(error)) error.code = "filter_unsupported";
    throw error;
  }
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
  graphFolderMoveUrl,
  graphMessageLookup,
  graphMoveUrl,
  normalizeGmailLabel,
  normalizeGmailLabels,
  normalizeGraphFolder,
  normalizeGraphFolders,
  listLabels,
  listSendAs,
  createLabel,
  renameLabel,
  deleteLabel,
  planGmailLabelMove,
  moveLabel,
  modifyLabels,
  listMailFolders,
  createMailFolder,
  renameMailFolder,
  deleteMailFolder,
  planGraphFolderMove,
  moveMailFolder,
  moveMessage,
  searchGmail,
  searchGraph,
  graphFromAddressUrl,
  graphSenderNext,
  searchGmailPage,
  searchGraphFromPage,
};
