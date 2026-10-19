const db = require("./db");

const STARRED_ID = "__morrow_starred__";
const UNREAD_ID = "__morrow_unread__";

const REAL_CHIP_WELLS = new Set(["inbox", "sent", "sentitems", "drafts", "draft"]);
const ANCHOR_WELLS = ["drafts", "sentitems", "inbox"];
const ATTENTION_SKIP_KEYS = ["trash", "spam", "drafts", "sent"];

const VIRTUALS = [
  {
    id: STARRED_ID,
    name: "Starred",
    wellKnownName: "starred",
    chip: false,
    badge: "none",
    view: { flagged: true },
    scope: "any",
    filterCopy: "Starred is a filter, not a folder.",
    dropCopy: "Starred is a filter. Use the star control to flag a message.",
    title: "Starred messages in this mailbox",
    ariaLabel: "Starred. Downloaded messages flagged with a star.",
    emptyCopy: "No starred messages in the mail already downloaded.",
    syncMessage: "Starred uses messages already downloaded",
  },
  {
    id: UNREAD_ID,
    name: "Unread",
    wellKnownName: "unread",
    chip: true,
    badge: "total",
    view: { unread: true },
    scope: "attention",
    filterCopy: "Unread is a filter, not a folder.",
    dropCopy: "Unread is a filter, not a folder.",
    title: "Unread messages in this mailbox",
    ariaLabel: "Unread. Downloaded messages that are still unread.",
    emptyCopy: "No unread messages in the mail already downloaded.",
    syncMessage: "Unread uses messages already downloaded",
  },
];

function defById(id) {
  if (!id) return null;
  for (const def of VIRTUALS) {
    if (def.id === id) return def;
  }
  return null;
}

function attentionPaths(accountId) {
  const paths = ["__search__"];
  for (const key of ATTENTION_SKIP_KEYS) {
    for (const row of db.pathsForKey(accountId, key)) {
      if (row && row.path) paths.push(row.path);
    }
  }
  return paths;
}

function apply(query) {
  const source = query || {};
  const def = defById(source.folderId);
  if (!def) return source;
  const next = { ...source, folderId: null };
  if (def.view && def.view.unread) next.filterUnread = true;
  if (def.view && def.view.flagged) next.filterFlagged = true;
  if (def.scope === "attention") {
    next.excludeSnoozed = true;
    if (source.accountId) {
      next.excludeFolderPaths = attentionPaths(source.accountId);
    } else {
      next.category = "none";
    }
  }
  return next;
}

function nodeFor(def, accountId) {
  const total = db.countMessages(apply({ accountId, folderId: def.id }));
  return {
    id: def.id,
    name: def.name,
    wellKnownName: def.wellKnownName,
    type: "virtual",
    children: [],
    chip: def.chip,
    unreadCount: def.badge === "total" ? total : 0,
    totalCount: total,
    view: { ...def.view },
    filterCopy: def.filterCopy,
    dropCopy: def.dropCopy,
    title: def.title,
    ariaLabel: def.ariaLabel,
    emptyCopy: def.emptyCopy,
    syncs: false,
  };
}

function place(primary, more, accountId) {
  for (const list of [primary, more]) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (get(list[i] && list[i].id)) list.splice(i, 1);
    }
    for (const folder of list) {
      if (!folder || folder.type === "virtual") continue;
      folder.chip = REAL_CHIP_WELLS.has(String(folder.wellKnownName || "").toLowerCase());
    }
  }
  const nodes = VIRTUALS.map((def) => nodeFor(def, accountId));
  let anchor = -1;
  for (const well of ANCHOR_WELLS) {
    anchor = primary.findIndex((folder) => folder && folder.wellKnownName === well);
    if (anchor >= 0) break;
  }
  if (anchor >= 0) primary.splice(anchor + 1, 0, ...nodes);
  else primary.unshift(...nodes);
}

function get(id) {
  const def = defById(id);
  if (!def) return null;
  return {
    id: def.id,
    name: def.name,
    syncMessage: def.syncMessage,
    filterCopy: def.filterCopy,
    dropCopy: def.dropCopy,
  };
}

module.exports = { STARRED_ID, UNREAD_ID, apply, place, get };
