const api = window.morrow;

const state = {
  accounts: [],
  accountId: null,
  folderId: null,
  emails: [],
  email: null,
  thread: [],
  query: "",
  draftId: null,
  composeMeta: null,
  composeQuote: null,
  busy: false,
  snoozed: new Map(),
  signatures: [],
  signatureText: "",
  translateLang: "English",
  translate: null,
  draftWrite: null,
  suggestions: null,
  remoteAllowed: {},
  prefs: {
    chips: true,
    aiReply: false,
    gmailOpen: true,
    outlookOpen: false,
    theme: "light",
    accent: "#7C3AED",
    conversation: true,
    images: false,
    undoSend: 5,
    snooze: true,
    quoteWidth: 420,
  },
  providerFolders: null,
  dragMessage: null,
  selectedIds: [],
  selectionAnchor: "",
  sync: null,
  oauthStatus: null,
  oauthPending: false,
  view: "mail",
  side: "folders",
  calendarCursor: null,
  calendarAccountId: "",
  calendarId: "",
  calendarEventId: "",
  calendarStatus: null,
  calendarPayload: null,
};

let accountGen = 0;
let listGen = 0;
let openGen = 0;
let reloadTimer = null;
let undoOpIds = null;
let translateSeq = 0;
let draftSeq = 0;
let suggestGen = 0;
let signatureGen = 0;
let signatureEditId = "";
let scheduledGen = 0;
let sendTimer = null;
let sendGen = 0;
let appVersion = "";
let updateGen = 0;
let updateTimer = null;
let brainSnapshot = null;
let brainEditId = "";
let brainCategories = [];
let brainCategoryDefaults = [];
let brainCategoryIndex = -1;
let brainCategoryGen = 0;
let brainSkillBusy = false;
let brainFixBusy = false;
let brainCategoryBusy = false;
let brainSkillCache = {};
let brainCategoriesReady = false;
let calendarGen = 0;
let agentGen = 0;
let agentChatBusy = false;
let agentTurns = [];
let agentProposalIds = null;
let agentPoll = null;
let brainDragIndex = -1;
let listMotionKey = "";
let brainView = {
  accepted: null,
  refreshing: false,
  rebuilding: false,
  phase: "",
  percent: null,
  error: "",
};

function $(id) {
  return document.getElementById(id);
}

function showStatus(text, isError) {
  const el = $("status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError && !!text);
}

function selectedAccount() {
  return state.accounts.find((account) => account.id === state.accountId) || null;
}

function composeAccount() {
  const id = state.composeMeta && state.composeMeta.accountId;
  return state.accounts.find((account) => account.id === id) || null;
}

function signatureAccount() {
  return $("compose").open ? composeAccount() : selectedAccount();
}

function isLive(account) {
  return !!(account && account.platform === "imap");
}

function foldersOf(account) {
  if (!account || !account.folders) return [];
  return [...(account.folders.primary || []), ...(account.folders.more || [])];
}

function accountDelimiter(account) {
  if (account && account.delimiter) return String(account.delimiter);
  return folderDelimiter(foldersOf(account));
}

function inboxOf(account) {
  const folders = foldersOf(account);
  return folders.find((folder) => folder.wellKnownName === "inbox") || folders[0] || null;
}

// shortcut: chips are Inbox, Sent, and Drafts, upgrade when every primary folder should be a chip.
function chipFolders(account) {
  const folders = account && account.folders;
  const primary = folders && Array.isArray(folders.primary) ? folders.primary : [];
  const more = folders && Array.isArray(folders.more) ? folders.more : [];
  const list = primary.length ? primary : more;
  const names = new Set(["inbox", "sent", "sentitems", "drafts", "draft"]);
  return list.filter((folder) => folder && names.has(String(folder.wellKnownName || "").toLowerCase()));
}

function chipLabel(folder) {
  const name = String((folder && (folder.label || folder.name || folder.id)) || "");
  if (name.toUpperCase() === "INBOX") return "Inbox";
  return name;
}

function accountLabel(account) {
  const email = (account && (account.email || account.displayEmail)) || "";
  const name = (account && account.name) || "";
  if (name && email && name !== email) return `${name} · ${email}`;
  return email || name || (account && account.id) || "";
}

function preferredAccountId(payload) {
  if (!payload || typeof payload !== "object") return "";
  const id = payload.activeAccountId;
  return typeof id === "string" ? id : "";
}

function folderProvider(account) {
  const platform = String((account && account.platform) || "").toLowerCase();
  if (platform === "gmail" || platform === "outlook") return platform;
  const profile = String((account && (account.imapSmtpProfile || account.profile)) || "").toLowerCase();
  if (profile === "gmail" || profile === "outlook") return profile;
  return "";
}

function providerExpanded(provider, prefs) {
  const flags = prefs || {};
  if (provider === "gmail") return flags.gmailOpen !== false;
  if (provider === "outlook") return flags.outlookOpen === true;
  return true;
}

function opensAiWrite(seed, prefs) {
  return !!(seed && seed.aiWrite && prefs && prefs.aiReply === true);
}

function oauthButtonState(status, provider) {
  if (provider === "microsoft") return { disabled: false, reason: "" };
  if (status && status.google === true) return { disabled: false, reason: "" };
  if (status && status.google === false) return { disabled: true, reason: "Google Desktop OAuth is not configured." };
  return { disabled: false, reason: "" };
}

function calendarGrantState(status, account) {
  if (!account || account.platform !== "imap") return { disabled: true, reason: "Connect a Google or Microsoft mailbox first." };
  const profile = String((account.imapSmtpProfile || account.profile || "")).toLowerCase();
  const provider = profile === "gmail" || profile === "outlook" ? profile : "";
  if (!provider) return { disabled: true, reason: "Calendar needs a Google or Microsoft account." };
  if (provider === "gmail" && status && status.google === false) return { disabled: true, reason: "Google Desktop OAuth is not configured." };
  return { disabled: false, reason: "" };
}

function providerFolderState(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.api !== true) {
    return { mode: "degraded", reason: (payload && payload.reason) || "scope_missing", folders: [] };
  }
  const folders = (Array.isArray(payload.folders) ? payload.folders : []).filter((folder) => folder && folder.id && folder.name);
  return { mode: "live", reason: "", folders };
}

function providerCopy(reason, provider) {
  const outlook = provider === "outlook";
  if (reason === "loading") return outlook ? "Checking Outlook folders…" : "Checking Gmail labels…";
  if (reason === "scope_missing") {
    return outlook
      ? "Outlook folders need the Mail.ReadWrite grant. This mailbox stays on IMAP until then."
      : "Gmail labels need the gmail.modify grant. This mailbox stays on IMAP until then.";
  }
  if (reason === "password_account") return "This mailbox uses a password. Grant the provider API to manage labels, or keep using IMAP folders.";
  if (reason === "oauth_not_ready") return "Google Desktop OAuth is not configured, so Gmail labels stay on IMAP.";
  if (reason === "imap_only") return "Labels stay on IMAP for this account.";
  if (reason === "no_account") return "Connect a mailbox to load provider labels.";
  if (reason === "error") return "The provider label list failed. IMAP folders are unchanged.";
  return outlook
    ? "Outlook folders are unavailable. IMAP folders are unchanged."
    : "Gmail labels are unavailable. IMAP folders are unchanged.";
}

function showOrganizeGrant(reason) {
  return reason === "scope_missing" || reason === "password_account";
}

function folderDelimiter(folders) {
  const rows = Array.isArray(folders) ? folders : [];
  const ids = new Set(rows.filter((folder) => folder && folder.id).map((folder) => String(folder.id)));
  const seps = ["/", "."];
  for (let index = 0; index < seps.length; index += 1) {
    const sep = seps[index];
    for (const id of ids) {
      const cut = id.lastIndexOf(sep);
      if (cut > 0 && ids.has(id.slice(0, cut))) return sep;
    }
  }
  return "/";
}

function imapParent(folder, byId, sep) {
  let id = String(folder.id);
  let cut = id.lastIndexOf(sep);
  while (cut > 0) {
    const parent = byId.get(id.slice(0, cut));
    if (parent && parent.id !== folder.id) return parent;
    id = id.slice(0, cut);
    cut = id.lastIndexOf(sep);
  }
  return null;
}

function nestRows(rows, parentOf, labelOf) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
  const children = new Map();
  const childIds = new Set();
  for (const row of list) {
    const parent = parentOf(row);
    if (!parent || parent.id === row.id) continue;
    const kids = children.get(parent.id) || [];
    kids.push(row);
    children.set(parent.id, kids);
    childIds.add(row.id);
  }
  const out = [];
  const seen = new Set();
  function walk(row, depth) {
    if (!row || seen.has(row.id) || depth > 12) return;
    seen.add(row.id);
    const parent = depth ? parentOf(row) : null;
    out.push(Object.assign({}, row, {
      depth: depth,
      label: labelOf(row, depth),
      parentId: parent && parent.id ? parent.id : "",
    }));
    const kids = children.get(row.id) || [];
    for (const kid of kids) walk(kid, depth + 1);
  }
  for (const row of list) {
    if (!childIds.has(row.id)) walk(row, 0);
  }
  for (const row of list) {
    if (!seen.has(row.id)) walk(row, 0);
  }
  return out;
}

function folderTree(folders, delimiter) {
  const rows = Array.isArray(folders) ? folders.filter((folder) => folder && folder.id) : [];
  const sep = delimiter || folderDelimiter(rows);
  const byId = new Map(rows.map((folder) => [String(folder.id), folder]));
  return nestRows(rows, (folder) => imapParent(folder, byId, sep), (folder) => String(folder.name || folder.id));
}

function providerParent(folder, byId, byName) {
  if (folder.parentId && byId.has(String(folder.parentId))) {
    const parent = byId.get(String(folder.parentId));
    if (parent && parent.id !== folder.id) return parent;
  }
  let name = String(folder.name || "");
  let cut = name.lastIndexOf("/");
  while (cut > 0) {
    const parent = byName.get(name.slice(0, cut));
    if (parent && parent.id !== folder.id) return parent;
    name = name.slice(0, cut);
    cut = name.lastIndexOf("/");
  }
  return null;
}

function providerLabelText(folder, depth) {
  const name = String(folder.name || folder.id);
  if (!depth) return name;
  const cut = name.lastIndexOf("/");
  if (cut > 0 && cut < name.length - 1) return name.slice(cut + 1);
  return name;
}

function providerLabelTree(folders) {
  const rows = Array.isArray(folders) ? folders.filter((folder) => folder && folder.id && folder.name) : [];
  const byId = new Map(rows.map((folder) => [String(folder.id), folder]));
  const byName = new Map();
  for (const folder of rows) {
    if (!byName.has(folder.name)) byName.set(folder.name, folder);
  }
  return nestRows(rows, (folder) => providerParent(folder, byId, byName), providerLabelText);
}

function joinedPath(node, byId, sep) {
  const parts = [];
  let current = node;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(String(current.label || current.name || current.id));
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return parts.join(sep);
}

function moveNodesFromFolders(kind, folders, delimiter) {
  const tree = kind === "imap" ? folderTree(folders, delimiter) : providerLabelTree(folders);
  const nodes = tree.map((folder) => ({
    id: String(folder.id),
    name: String(folder.name || folder.id),
    label: String(folder.label || folder.name || folder.id),
    parentId: folder.parentId ? String(folder.parentId) : "",
    depth: folder.depth || 0,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (kind === "gmail") node.path = node.name;
    else if (kind === "imap") node.path = node.id;
    else node.path = joinedPath(node, byId, " / ");
  }
  return nodes;
}

function descendantIds(nodes, source, kind, delimiter) {
  const ids = new Set();
  if (!source) return ids;
  if (kind === "gmail") {
    const prefix = String(source.name || "");
    for (const node of nodes) {
      if (!node || node.id === source.id) continue;
      const name = String(node.name || "");
      if (prefix && (name === prefix || name.startsWith(prefix + "/"))) ids.add(node.id);
    }
    return ids;
  }
  if (kind === "imap") {
    const sep = delimiter || "/";
    const prefix = String(source.id || "");
    for (const node of nodes) {
      if (!node || node.id === source.id) continue;
      if (prefix && String(node.id).startsWith(prefix + sep)) ids.add(node.id);
    }
    return ids;
  }
  const children = new Map();
  for (const node of nodes) {
    if (!node || !node.parentId) continue;
    const list = children.get(node.parentId) || [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const stack = (children.get(source.id) || []).slice();
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of children.get(id) || []) stack.push(child);
  }
  return ids;
}

function moveTargetFlags(nodes, sourceId, kind, delimiter) {
  const list = Array.isArray(nodes) ? nodes : [];
  const source = list.find((node) => node && node.id === String(sourceId || ""));
  const noun = kind === "gmail" ? "label" : "folder";
  const sub = kind === "gmail" ? "sub-label" : "sub-folder";
  if (!source) {
    const reason = "Choose a " + noun + ".";
    return {
      root: { disabled: true, reason: reason },
      nodes: list.map((node) => Object.assign({}, node, { disabled: true, reason: reason })),
    };
  }
  const blocked = descendantIds(list, source, kind, delimiter);
  const currentParent = source.parentId || "";
  function reasonFor(id, isRoot) {
    if (!isRoot && id === source.id) return "A " + noun + " cannot move into itself.";
    if (!isRoot && blocked.has(id)) return "A " + noun + " cannot move into its own " + sub + ".";
    const already = isRoot ? !currentParent : id === currentParent;
    if (already) return "This " + noun + " is already there.";
    return "";
  }
  return {
    root: { disabled: !!reasonFor("", true), reason: reasonFor("", true) },
    nodes: list.map((node) => {
      const reason = reasonFor(node.id, false);
      return Object.assign({}, node, { disabled: !!reason, reason: reason });
    }),
  };
}

function messageTargetFlags(nodes, currentId) {
  const current = String(currentId || "");
  return {
    root: { disabled: true, reason: "", hidden: true },
    nodes: (Array.isArray(nodes) ? nodes : []).map((node) => {
      const same = !!(current && node.id === current);
      return Object.assign({}, node, {
        disabled: same,
        reason: same ? "That message is already in this folder." : "",
      });
    }),
  };
}

function filterMoveNodes(nodes, query) {
  const list = Array.isArray(nodes) ? nodes : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list.map((node) => Object.assign({}, node, { match: false }));
  const byId = new Map(list.map((node) => [node.id, node]));
  const keep = new Set();
  for (const node of list) {
    const hay = String(node.path || node.name || node.label || "").toLowerCase();
    if (!hay.includes(q)) continue;
    keep.add(node.id);
    let parent = node.parentId;
    const seen = new Set();
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      keep.add(parent);
      parent = byId.get(parent).parentId;
    }
  }
  return list.filter((node) => keep.has(node.id)).map((node) => Object.assign({}, node, {
    match: String(node.path || node.name || node.label || "").toLowerCase().includes(q),
  }));
}

function showMoveRoot(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return "(top level / root)".includes(q);
}

function visibleMoveNodes(nodes, expanded, filtering) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (filtering) return list.slice();
  const open = expanded instanceof Set ? expanded : new Set(expanded || []);
  const hidden = new Set();
  const out = [];
  for (const node of list) {
    if (node.parentId && hidden.has(node.parentId)) {
      hidden.add(node.id);
      continue;
    }
    out.push(node);
    let hasChild = false;
    for (const other of list) {
      if (other.parentId === node.id) {
        hasChild = true;
        break;
      }
    }
    if (hasChild && !open.has(node.id)) hidden.add(node.id);
  }
  return out;
}

function movePathPreview(source, destination, kind, delimiter) {
  const row = source || {};
  const dest = destination || {};
  const root = !destination || dest.isRoot === true;
  if (kind === "gmail") {
    const name = String(row.name || "");
    const cut = name.lastIndexOf("/");
    const leaf = cut >= 0 ? name.slice(cut + 1) : name;
    if (root) return leaf;
    return String(dest.path || dest.name || "") + "/" + leaf;
  }
  if (kind === "imap") {
    const sep = delimiter || "/";
    const id = String(row.id || row.path || "");
    const cut = id.lastIndexOf(sep);
    const leaf = cut >= 0 ? id.slice(cut + 1) : (id || String(row.label || ""));
    if (root) return leaf;
    return String(dest.id || dest.path || "") + sep + leaf;
  }
  const leaf = String(row.label || row.name || "");
  if (root) return leaf;
  return String(dest.path || dest.label || dest.name || "") + " / " + leaf;
}

function movePreviewLine(session, target) {
  const view = session || {};
  if (!target) return "Choose a destination.";
  if (target.disabled) return target.reason || "That destination is not available.";
  if (view.purpose === "message") {
    const where = target.path || target.label || target.name || "that folder";
    const count = Array.isArray(view.emails) ? view.emails.length : 0;
    if (count > 1) return "Move " + count + " messages to “" + where + "”.";
    return "Move the message to “" + where + "”.";
  }
  const next = movePathPreview(view.source || view, target, view.kind, view.delimiter);
  return "New path: " + next;
}

function moveRequestAfterConfirm(channel, answer, params) {
  if (!confirmsBefore(channel)) return params || null;
  if (!answer || answer.ok !== true) return null;
  return params || null;
}

function relocatedFolderId(current, renames) {
  const id = String(current || "");
  const rows = Array.isArray(renames) ? renames : [];
  const hit = rows.find((row) => row && row.from === id);
  return hit && hit.to ? String(hit.to) : id;
}

function messageDragPayload(email) {
  if (!email || !email.id || !email.accountId) return null;
  return {
    id: String(email.id),
    accountId: String(email.accountId),
    folderId: email.folderId ? String(email.folderId) : "",
  };
}

function organizeDrop(target, message) {
  const email = messageDragPayload(message);
  if (!email) return { ok: false, reason: "no_message", message: "Choose a message first." };
  if (!target || !target.id || !target.kind) {
    return { ok: false, reason: "no_target", message: "Drop the message on a folder or label." };
  }
  if (target.kind === "imap") {
    if (target.accountId && target.accountId !== email.accountId) {
      return { ok: false, reason: "other_account", message: "Move stays inside this mailbox." };
    }
    if (target.id === email.folderId) {
      return { ok: false, reason: "same_folder", message: "That message is already in this folder." };
    }
    return {
      ok: true,
      channel: "mail:moveToFolder",
      params: {
        emailId: email.id,
        accountId: email.accountId,
        targetFolderId: target.id,
        folderId: email.folderId,
      },
    };
  }
  if (target.kind === "gmail" || target.kind === "outlook") {
    if (target.accountId && target.accountId !== email.accountId) {
      return { ok: false, reason: "other_account", message: "Labels stay on the mailbox that owns this message." };
    }
    if (target.api !== true) {
      return {
        ok: false,
        reason: target.reason || "scope_missing",
        message: target.gate || providerCopy(target.reason || "scope_missing", target.kind),
      };
    }
    if (target.kind === "gmail") {
      return {
        ok: true,
        channel: "mail:modifyMessageLabels",
        params: {
          accountId: email.accountId,
          emailId: email.id,
          addLabelIds: [target.id],
          removeLabelIds: [],
        },
      };
    }
    return {
      ok: true,
      channel: "mail:moveProviderMessage",
      params: {
        accountId: email.accountId,
        emailId: email.id,
        destinationId: target.id,
      },
    };
  }
  return { ok: false, reason: "unsupported", message: "That target cannot take a message." };
}

function organizeMenu(email, imapFolders, providerPayload, provider) {
  const message = messageDragPayload(email);
  const moveTree = folderTree(imapFolders);
  const move = message ? moveTree.filter((folder) => folder.id !== message.folderId) : [];
  if (!message) return { move: [], add: [], remove: [], outlook: [], note: "Choose a message first." };
  if (provider !== "gmail" && provider !== "outlook") {
    return { move: move, add: [], remove: [], outlook: [], note: "" };
  }
  if (providerPayload && providerPayload.accountId && providerPayload.accountId !== message.accountId) {
    return {
      move: move,
      add: [],
      remove: [],
      outlook: [],
      note: "Labels follow the mailbox that owns this message.",
    };
  }
  const view = providerFolderState(providerPayload);
  if (view.mode !== "live") {
    const note = (providerPayload && providerPayload.message) || providerCopy(view.reason, provider);
    return { move: move, add: [], remove: [], outlook: [], note: note };
  }
  const labels = providerLabelTree(view.folders);
  if (provider === "gmail") {
    const editable = labels.filter((folder) => folder.editable);
    return { move: move, add: editable, remove: editable, outlook: [], note: "" };
  }
  return { move: move, add: [], remove: [], outlook: labels, note: "" };
}

function moveMenuItem(folder, provider) {
  const outlook = provider === "outlook";
  const editable = !!(folder && folder.editable);
  if (editable) return { id: "move", label: "Move…", disabled: false, reason: "" };
  return {
    id: "move",
    label: "Move…",
    disabled: true,
    reason: outlook ? "This Outlook folder cannot be moved." : "This Gmail label cannot be moved.",
  };
}

function imapFolderMenu(folder) {
  const system = !!(folder && (folder.wellKnownName || folder.type === "system" || String(folder.id || "").toUpperCase() === "INBOX"));
  return {
    name: String((folder && (folder.name || folder.id)) || "Folder"),
    items: [{
      id: "move",
      label: "Move…",
      disabled: system,
      reason: system ? "This folder cannot be moved." : "",
    }],
    note: "",
  };
}

function folderActionMenu(folder, provider) {
  const outlook = provider === "outlook";
  const name = String((folder && (folder.name || folder.id)) || (outlook ? "Folder" : "Label"));
  const editable = !!(folder && folder.editable);
  const items = [];
  if (editable) {
    items.push({ id: "rename", label: "Rename", disabled: false, reason: "" });
    items.push(moveMenuItem(folder, provider));
    items.push({ id: "delete", label: "Delete", disabled: false, reason: "" });
  } else {
    items.push(moveMenuItem(folder, provider));
  }
  items.push({ id: "create", label: outlook ? "Add folder" : "Add label", disabled: false, reason: "" });
  return {
    name: name,
    editable: editable,
    items: items,
    note: editable ? "" : (outlook
      ? "This Outlook folder cannot be renamed or deleted."
      : "This Gmail label cannot be renamed or deleted."),
  };
}

function actionConfirm(kind, detail) {
  const row = detail && typeof detail === "object" ? detail : {};
  const outlook = row.provider === "outlook";
  const where = outlook ? "Outlook" : "Gmail";
  if (kind === "rename") {
    const from = String(row.name || (outlook ? "Folder" : "Label"));
    return {
      title: outlook ? "Rename folder" : "Rename label",
      body: "Rename “" + from + "” on " + where + "? The name below replaces it. Messages stay in the mailbox.",
      confirm: "Confirm",
      cancel: "Cancel",
      needsName: true,
      name: from,
    };
  }
  if (kind === "delete") {
    const label = String(row.name || (outlook ? "Folder" : "Label"));
    const body = outlook
      ? "Delete “" + label + "” on Outlook? This deletes the folder, including the messages in it."
      : "Delete “" + label + "” on Gmail? This removes the label. Messages that had it stay in the mailbox.";
    return {
      title: outlook ? "Delete folder" : "Delete label",
      body: body,
      confirm: "Confirm",
      cancel: "Cancel",
      needsName: false,
      name: "",
    };
  }
  if (kind === "move-label") {
    const provider = row.provider || "gmail";
    const name = String(row.name || (provider === "gmail" ? "Label" : "Folder"));
    const destination = String(row.destination || "(Top level / root)");
    const outlook = provider === "outlook";
    const imap = provider === "imap";
    let body = "Move “" + name + "” into “" + destination + "” on Gmail? Nested labels are renamed with it.";
    if (outlook) body = "Move “" + name + "” into “" + destination + "” on Outlook? Folders inside it move with it.";
    if (imap) body = "Move “" + name + "” into “" + destination + "” on the mail server? Folders inside it follow that rename.";
    return {
      title: outlook || imap ? "Move folder" : "Move label",
      body: body,
      confirm: "Confirm",
      cancel: "Cancel",
      needsName: false,
      name: "",
    };
  }
  if (kind === "move") {
    const subject = String(row.subject || "(no subject)");
    const target = String(row.target || "that folder");
    const outlookMove = row.channel === "outlook" || row.channel === "mail:moveProviderMessage";
    return {
      title: "Move message",
      body: outlookMove
        ? "Move “" + subject + "” to “" + target + "” in Outlook? This moves the message on the provider."
        : "Move “" + subject + "” to “" + target + "”? This moves the message into that folder.",
      confirm: "Confirm",
      cancel: "Cancel",
      needsName: false,
      name: "",
    };
  }
  return null;
}

function confirmsBefore(channel) {
  return channel === "mail:moveToFolder"
    || channel === "mail:moveProviderMessage"
    || channel === "mail:renameProviderFolder"
    || channel === "mail:deleteProviderFolder"
    || channel === "mail:moveProviderFolder"
    || channel === "mail:moveFolder";
}

function calendarMode(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.api !== true) {
    return {
      mode: "needs-auth",
      reason: (payload && payload.reason) || "needs_auth",
      events: [],
      calendars: [],
    };
  }
  const events = (Array.isArray(payload.events) ? payload.events : []).filter((event) => event && event.id && event.start);
  const calendars = (Array.isArray(payload.calendars) ? payload.calendars : []).filter((calendar) => calendar && calendar.id);
  return { mode: events.length ? "events" : "empty", reason: "", events, calendars };
}

function calendarCopy(reason, email) {
  if (reason === "oauth_not_ready") return "Google Desktop OAuth is not configured, so calendar stays offline.";
  if (reason === "imap_only") return "Calendar needs a Google or Microsoft account.";
  if (reason === "no_account") return "Connect a Google or Microsoft mailbox. Calendar does not keep events of its own.";
  if (reason === "error") return "Calendar could not be loaded.";
  const who = email ? ` for ${email}` : "";
  return `Calendar needs a calendar grant${who}. This view does not keep events of its own.`;
}

function calendarConnection(status, account, listed) {
  const grant = calendarGrantState(status, account);
  if (!account || grant.disabled) {
    return { connected: false, canGrant: false, reason: grant.reason, label: "Grant calendar access" };
  }
  const rows = status && Array.isArray(status.accounts) ? status.accounts : [];
  const row = rows.find((item) => item && item.id === account.id);
  const connected = (row && row.calendar === true) || (listed && listed.api === true);
  return {
    connected,
    canGrant: true,
    reason: connected ? "" : ((row && row.calendarReason) || "needs_auth"),
    label: connected ? "Update calendar access" : "Grant calendar access",
  };
}

function calendarView(payload) {
  const mode = calendarMode(payload);
  if (mode.mode === "needs-auth") {
    const hostMessage = mode.reason === "error" && payload && payload.message ? String(payload.message) : "";
    return {
      showGrid: false,
      showForm: false,
      status: hostMessage || calendarCopy(mode.reason),
      error: mode.reason === "error",
      events: [],
      calendars: [],
    };
  }
  if (!mode.calendars.length) {
    return { showGrid: false, showForm: false, status: "No calendars on this account.", error: false, events: [], calendars: [] };
  }
  const status = mode.mode === "empty" ? "No events this month." : "";
  const truncated = payload && payload.truncated ? " The provider returned a partial list." : "";
  return {
    showGrid: true,
    showForm: true,
    status: `${status}${truncated}`.trim(),
    error: false,
    events: mode.events,
    calendars: mode.calendars,
  };
}

function monthRange(year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    label: start.toLocaleString("en-US", { month: "long", year: "numeric" }),
    year,
    month,
  };
}

function monthCells(year, month) {
  const pad = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < pad; i += 1) cells.push(0);
  for (let day = 1; day <= days; day += 1) cells.push(day);
  return cells;
}

function dayKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function eventDay(event) {
  if (!event || !event.start) return "";
  if (event.allDay && /^\d{4}-\d{2}-\d{2}/.test(event.start)) return String(event.start).slice(0, 10);
  const time = Date.parse(event.start);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return dayKey(date.getFullYear(), date.getMonth(), date.getDate());
}

function eventCoversDay(event, key) {
  const startKey = eventDay(event);
  if (!startKey || !key) return false;
  if (event && event.allDay) {
    const end = String(event.end || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end > startKey) return key >= startKey && key < end;
  }
  return startKey === key;
}

function eventsOnDay(events, key) {
  return (Array.isArray(events) ? events : []).filter((event) => eventCoversDay(event, key));
}

function clockLabel(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}

function formatEventWhen(event) {
  if (!event || !event.start) return "";
  if (event.allDay) return "All day";
  const start = clockLabel(event.start);
  const end = clockLabel(event.end);
  if (start && end) return `${start}–${end}`;
  return start;
}

function eventChip(event) {
  const title = (event && event.title) || "(no title)";
  if (!event || event.allDay) return title;
  const when = formatEventWhen(event);
  return when ? `${when} ${title}` : title;
}

function agendaEvents(events) {
  return (Array.isArray(events) ? events : []).slice().sort((left, right) => {
    return String((left && left.start) || "").localeCompare(String((right && right.start) || ""));
  });
}

function agendaLine(event) {
  if (!event) return "";
  const parts = [eventDay(event), formatEventWhen(event), event.title || "(no title)"];
  if (event.location) parts.push(event.location);
  return parts.filter(Boolean).join(" · ");
}

function sameDay(year, month, day, now) {
  const date = now instanceof Date ? now : new Date();
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
}

function calendarNameOf(calendars, id) {
  const row = (Array.isArray(calendars) ? calendars : []).find((item) => item && item.id === id);
  return row ? (row.name || row.id) : "";
}

function vacationProvider(account) {
  const profile = String((account && (account.imapSmtpProfile || account.profile)) || "").toLowerCase();
  if (profile === "gmail" || profile === "google") return "google";
  if (profile === "outlook" || profile === "microsoft" || profile === "office365") return "microsoft";
  return "imap";
}

function vacationLink(url) {
  const links = [
    "https://mail.google.com/mail/u/0/#settings/general",
    "https://outlook.live.com/mail/0/options/mail/automaticReplies",
    "https://outlook.office.com/mail/options/mail/automaticReplies",
    "https://mail.yahoo.com/",
    "https://www.icloud.com/mail",
  ];
  return links.includes(url) ? url : "";
}

function vacationDraft(input) {
  const row = input && typeof input === "object" ? input : {};
  const provider = row.provider === "microsoft" ? "microsoft" : row.provider === "google" ? "google" : "imap";
  const action = row.action === "disable" ? "disable" : "save";
  if (action === "disable") return { error: "", action: "disable", provider };
  const mode = ["disabled", "always", "scheduled"].includes(row.mode) ? row.mode : "";
  if (!mode) return { error: "Choose Disabled, Always, or Scheduled." };
  const subject = String(row.subject || "");
  const message = String(row.message || "");
  const externalMessage = String(row.externalMessage || "");
  if (subject.length > 200 || message.length > 10000 || externalMessage.length > 10000) return { error: "Shorten the automatic reply." };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(subject + message + externalMessage)) return { error: "The reply must be plain text." };
  if (subject.includes("\n")) return { error: "The subject must fit on one line." };
  const audience = String(row.audience || "all");
  if (provider === "imap" && (audience !== "all" || row.restrictToDomain === true)) return { error: "IMAP vacation replies go to every sender." };
  if (!["all", "contacts", "none"].includes(audience)) return { error: "Choose a valid reply audience." };
  if (provider === "google" && audience === "none") return { error: "Choose a valid reply audience." };
  if (mode !== "disabled" && !message.trim()) return { error: "Enter a reply message." };
  if (provider === "microsoft" && mode !== "disabled" && audience !== "none" && !externalMessage.trim()) return { error: "Enter the external reply." };
  let start = "";
  let end = "";
  if (mode === "scheduled") {
    const startMs = Date.parse(row.start || "");
    const endMs = Date.parse(row.end || "");
    if (provider === "microsoft") {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { error: "Outlook needs a start and an end." };
    } else if (!Number.isFinite(startMs) && !Number.isFinite(endMs)) return { error: "Enter a start or an end." };
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= endMs) return { error: "The end must be after the start." };
    if (Number.isFinite(endMs) && endMs <= Date.now()) return { error: "Choose an end time in the future." };
    start = Number.isFinite(startMs) ? new Date(startMs).toISOString() : "";
    end = Number.isFinite(endMs) ? new Date(endMs).toISOString() : "";
  }
  return {
    error: "",
    action: "save",
    provider,
    mode,
    subject,
    message,
    externalMessage,
    audience: provider === "imap" ? "all" : audience,
    restrictToDomain: provider === "google" && row.restrictToDomain === true,
    start,
    end,
  };
}

function vacationView(payload) {
  const row = payload && typeof payload === "object" ? payload : null;
  if (!row) return { showGrant: false, showForm: false, canSave: false, canDisable: false, note: "", help: "" };
  const provider = row.provider === "microsoft" ? "microsoft" : row.provider === "google" ? "google" : "imap";
  const settings = row.settings && typeof row.settings === "object" ? row.settings : null;
  const mode = settings ? settings.mode : "";
  return {
    provider,
    showGrant: row.requiresReconnect === true && provider !== "imap",
    showForm: row.supported === true && (row.canWrite === true || provider === "imap"),
    canSave: row.canWrite === true,
    canDisable: row.supported === true && row.requiresReconnect !== true && ((mode && mode !== "disabled") || !!row.scheduleWarning),
    note: row.detail || row.scheduleWarning || "",
    help: provider === "imap"
      ? "Plain text only. Morrow installs one script named morrow-vacation and will not replace a different active Sieve script."
      : "Plain text only. Save replaces rich formatting. Outlook keeps separate internal and external messages. Disable keeps the provider’s existing templates.",
  };
}

function vacationConfirm(kind, owner, options) {
  const who = owner || "this mailbox";
  const provider = options && options.provider;
  const closed = "Enabled replies continue while Morrow is closed. No mail is sent by this button.";
  if (kind === "grant") {
    const scope = options && options.scope ? options.scope : "the provider settings permission";
    return {
      title: "Allow Out of Office settings",
      body: "Allow Out of Office settings access for " + who + "?\n\nThe browser will request " + scope + ". Enabling replies still needs a separate Save confirmation. The existing mailbox connection stays if consent is incomplete.",
      confirm: "Continue",
      cancel: "Cancel",
      needsName: false,
    };
  }
  if (kind === "disable") {
    const kept = provider === "imap" ? "Only Morrow’s own vacation script is removed." : "Existing templates are retained.";
    return {
      title: "Disable automatic replies",
      body: "Disable automatic replies for " + who + "?\n\n" + kept + "\n\n" + closed,
      confirm: "Disable",
      cancel: "Cancel",
      needsName: false,
    };
  }
  const mode = options && options.mode ? options.mode : "disabled";
  const where = provider === "imap"
    ? "The IMAP server stores a ManageSieve vacation script if it offers one. Every sender can receive a reply. Dates use whole UTC days."
    : "The provider stores these plain-text replies.";
  return {
    title: mode === "disabled" ? "Save disabled settings" : "Save and enable",
    body: "Save automatic replies for " + who + "?\n\n" + where + " Mode: " + mode + ".\n\n" + closed,
    confirm: "Save",
    cancel: "Cancel",
    needsName: false,
  };
}

function calendarDraft(input) {
  const title = String((input && input.title) || "").trim();
  const startRaw = String((input && input.start) || "").trim();
  const endRaw = String((input && input.end) || "").trim();
  const calendarId = String((input && input.calendarId) || "").trim();
  const accountId = String((input && input.accountId) || "").trim();
  if (!accountId) return { error: "Connect a Google or Microsoft mailbox first." };
  if (!calendarId) return { error: "Choose a calendar." };
  if (!title) return { error: "Add a title." };
  const location = String((input && input.location) || "").trim();
  const start = Date.parse(startRaw);
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { error: "Pick a start and a later end." };
  return {
    error: "",
    accountId,
    calendarId,
    title,
    location,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

function envelopeError(result) {
  if (!result || typeof result !== "object") return "No response from the mail host.";
  if (result.success === false) {
    const err = result.error;
    return (err && (err.message || err.code)) || "The mail host rejected that request.";
  }
  return null;
}

async function call(channel, payload) {
  const result = await api.invoke(channel, payload);
  const message = envelopeError(result);
  if (message) throw new Error(message);
  return result.data;
}

async function guard(fn) {
  if (state.busy) return;
  state.busy = true;
  try {
    await fn();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
  }
}

function guardOoo(fn) {
  return guard(async () => {
    try {
      await fn();
    } catch (error) {
      setOooStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
}

function motionApi() {
  const motion = window.morrowMotion;
  return motion && typeof motion.rows === "function" ? motion : null;
}

function hidePane(id) {
  const el = $(id);
  el.hidden = true;
  if (el.getAnimations) {
    for (const animation of el.getAnimations()) animation.cancel();
  }
  el.style.opacity = "";
  el.style.transform = "";
  el.style.transformOrigin = "";
}

function revealPanel(id) {
  const el = $(id);
  const motion = motionApi();
  if (motion) motion.prepare(el);
  el.hidden = false;
  if (motion) motion.enter(el);
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  const motion = motionApi();
  if (motion) motion.prepare(dialog);
  dialog.showModal();
  if (motion) motion.dialogIn(dialog);
}

function closeDialog(id) {
  const dialog = $(id);
  if (!dialog || !dialog.open || dialog.dataset.closing === "1") return;
  const motion = motionApi();
  if (!motion || !motion.wantsCloseMotion()) {
    dialog.close();
    return;
  }
  dialog.dataset.closing = "1";
  motion.dialogOut(dialog).then(() => {
    if (dialog.open) dialog.close();
    if (dialog.getAnimations) {
      for (const animation of dialog.getAnimations()) animation.cancel();
    }
    dialog.style.opacity = "";
    dialog.style.transform = "";
    dialog.style.transformOrigin = "";
    delete dialog.dataset.closing;
  });
}

let confirmResult = null;
let confirmCopy = null;
let vacationCache = null;

function paintConfirm(copy) {
  $("confirm-title").textContent = copy.title;
  $("confirm-body").textContent = copy.body;
  const field = $("confirm-field");
  const input = $("confirm-name");
  field.hidden = !copy.needsName;
  input.value = copy.needsName ? (copy.name || "") : "";
  $("confirm-ok").textContent = copy.confirm || "Confirm";
  $("confirm-cancel").textContent = copy.cancel || "Cancel";
}

function focusConfirm(copy) {
  if (copy && copy.needsName) {
    const input = $("confirm-name");
    input.focus();
    input.select();
    return;
  }
  $("confirm-ok").focus();
}

function askConfirm(copy) {
  const dialog = $("confirm");
  if (!copy || !dialog) return Promise.resolve({ ok: false, name: "" });
  if (confirmResult) {
    const previous = confirmResult;
    confirmResult = null;
    previous({ ok: false, name: "" });
  }
  confirmCopy = copy;
  paintConfirm(copy);
  const pending = new Promise((resolve) => {
    confirmResult = resolve;
  });
  if (!dialog.open) openDialog("confirm");
  focusConfirm(copy);
  return pending;
}

function finishConfirm(result) {
  const pending = confirmResult;
  confirmResult = null;
  confirmCopy = null;
  if (pending) pending(result);
  closeDialog("confirm");
}

function submitConfirm() {
  if (!confirmResult) return;
  const name = $("confirm-name").value.trim();
  if (confirmCopy && confirmCopy.needsName && !name) {
    $("confirm-body").textContent = "Enter a name.";
    $("confirm-name").focus();
    return;
  }
  finishConfirm({ ok: true, name: name });
}

function cancelConfirm() {
  finishConfirm({ ok: false, name: "" });
}

function toHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function senderName(from) {
  const text = String(from || "").trim();
  if (!text) return "(unknown sender)";
  const cut = text.indexOf("<");
  const name = (cut > 0 ? text.slice(0, cut) : text).trim().replaceAll('"', "");
  return name || text;
}

function senderInitial(name) {
  const match = String(name || "").match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : "?";
}

function avatarColor(name) {
  const colors = ["#5b2a6e", "#1d4ed8", "#0f766e", "#b45309", "#be123c", "#0369a1", "#4d7c0f", "#9d174d"];
  let hash = 0;
  const text = String(name || "");
  for (let i = 0; i < text.length; i += 1) hash = (hash + text.charCodeAt(i)) % 997;
  return colors[hash % colors.length];
}

function applyShellTheme(root, theme, accent) {
  if (!root || !root.dataset || !root.style) return "light";
  const mode = theme === "dark" ? "dark" : "light";
  root.dataset.theme = mode;
  const color = typeof accent === "string" ? accent.trim() : "";
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) root.style.setProperty("--accent", color);
  else root.style.removeProperty("--accent");
  return mode;
}

function listWhen(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

function nextRow(length, index, delta) {
  if (length <= 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  const next = index + delta;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}

function paneWidth(current, delta, min, max) {
  const next = current + delta;
  if (next < min) return min;
  if (next > max) return max;
  return next;
}

function folderIcon(wellKnownName) {
  switch (String(wellKnownName || "").toLowerCase()) {
    case "inbox": return "📥";
    case "starred": return "⭐";
    case "sentitems":
    case "sent": return "📤";
    case "drafts":
    case "draft": return "📝";
    case "archive": return "📦";
    case "deleteditems":
    case "trash":
    case "deleted": return "🗑️";
    case "junkemail":
    case "spam":
    case "junk": return "🚫";
    case "important": return "❗";
    default: return "📁";
  }
}

// shortcut: tonight is 18:00, else 22:00, else the next 18:00, upgrade if a named late-night preset is needed.
function snoozeUntil(preset, now) {
  const start = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (preset === "1h") return new Date(start.getTime() + 60 * 60 * 1000);
  if (preset === "tonight") {
    const at = new Date(start);
    at.setHours(18, 0, 0, 0);
    if (at.getTime() <= start.getTime() + 1000) at.setHours(22, 0, 0, 0);
    if (at.getTime() <= start.getTime() + 1000) {
      at.setDate(at.getDate() + 1);
      at.setHours(18, 0, 0, 0);
    }
    return at;
  }
  const morning = new Date(start);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(8, 0, 0, 0);
  return morning;
}

function scheduleAt(preset, custom, now) {
  const start = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  let when = null;
  if (preset === "1h" || preset === "tonight" || preset === "morning") when = snoozeUntil(preset, start);
  else if (preset === "custom") when = new Date(custom);
  if (!when || Number.isNaN(when.getTime()) || when.getTime() <= start.getTime() + 1000) return null;
  return when;
}

function scheduledRows(data) {
  return Array.isArray(data) ? data.filter((row) => row && row.id) : [];
}

function scheduledLine(row) {
  const subject = String((row && row.subject) || "").trim() || "(no subject)";
  const to = Array.isArray(row && row.to) ? row.to.filter(Boolean).join(", ") : String((row && row.to) || "").trim();
  const when = row && row.sendAt ? new Date(row.sendAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "";
  const failed = row && row.status === "failed" ? (String(row.error || "").trim() || "Send failed.") : "";
  return [subject, to, time, failed].filter(Boolean).join(" · ");
}

function removalPayload(email, threaded) {
  const payload = { accountId: email.accountId, emailId: email.id };
  if (threaded) payload.threadId = email.threadId || email.id;
  return payload;
}

function usesThread(email, members) {
  if (!email) return false;
  return (members || []).some((row) => row && row.id && row.id !== email.id);
}

const TRANSLATE_LANGS = ["English", "Spanish", "French", "German", "Chinese", "Japanese"];

function bodyNodes(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({ node_id: `n${index}`, text: part }));
}

function applyTranslate(view, event) {
  if (!view || !view.pending || !event || event.reqId !== view.reqId) return view;
  if (event.type === "progress") {
    if (typeof event.current === "number") view.current = event.current;
    if (typeof event.total === "number") view.total = event.total;
    return view;
  }
  if (event.type === "node") {
    const text = event.status === "success" ? String(event.translatedText || "") : "";
    view.texts[event.nodeId] = text;
    if (!text && event.error) view.error = String(event.error);
    return view;
  }
  if (event.type === "error") {
    view.error = String(event.message || "Translation failed.");
    view.pending = false;
    return view;
  }
  if (event.type === "done") view.pending = false;
  return view;
}

function translationText(view) {
  if (!view || !Array.isArray(view.nodes)) return "";
  return view.nodes.map((node) => (view.texts && view.texts[node.node_id]) || "").filter(Boolean).join("\n\n");
}

// shortcut: rows are {id, name, text|html}, upgrade when the host documents another shape.
function signatureRows(pack) {
  const rows = pack && Array.isArray(pack.signatures) ? pack.signatures : [];
  return rows.filter((row) => row && row.id);
}

function chosenSignatureId(pack, accountId) {
  const per = pack && pack.defaultSignaturePerAccount;
  const fromAccount = per && accountId ? per[accountId] : null;
  if (fromAccount) return String(fromAccount);
  if (pack && pack.defaultSignatureId) return String(pack.defaultSignatureId);
  return "";
}

function signatureName(row) {
  const name = row && row.name ? String(row.name).trim() : "";
  return name || "Signature";
}

function signaturePlain(row) {
  if (!row) return "";
  if (typeof row.text === "string" && row.text.trim()) return row.text.trim();
  const html = typeof row.html === "string" ? row.html : "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function signatureDraft(input) {
  const source = input || {};
  const payload = {
    name: String(source.name || "").trim(),
    isDefault: source.isDefault === true,
  };
  if (source.id) payload.id = String(source.id);
  const body = String(source.body || "");
  if (source.html === true) payload.html = body;
  else payload.text = body;
  return payload;
}

function signatureFields(row, isDefault) {
  if (!row || !row.id) return { id: "", name: "", body: "", html: false, isDefault: false };
  const html = typeof row.html === "string" && row.html.trim() ? row.html : "";
  const text = typeof row.text === "string" ? row.text : "";
  return {
    id: String(row.id),
    name: row.name ? String(row.name) : "",
    body: html || text,
    html: !!html,
    isDefault: isDefault === true,
  };
}

// shortcut: only an untouched signature at the end of the body is replaced, upgrade if edits inside it must be tracked.
function applySignature(body, previous, next) {
  let base = String(body || "");
  const prev = String(previous || "");
  if (prev) {
    if (base === prev) base = "";
    else {
      const tail = `\n\n${prev}`;
      if (base.endsWith(tail)) base = base.slice(0, -tail.length);
    }
  }
  const added = String(next || "");
  if (!added) return base;
  return base ? `${base}\n\n${added}` : added;
}

function people(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value ? String(value) : "";
}

function readable(email) {
  const html = email && email.htmlBody ? String(email.htmlBody) : "";
  if (html) {
    const text = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
    if (text) return text;
  }
  return (email && (email.textBody || email.snippet)) || "";
}

// shortcut: one string is one address, upgrade if the host sends a comma-separated To.
function addressRows(value) {
  const parts = Array.isArray(value) ? value : (value ? [value] : []);
  const rows = [];
  for (const item of parts) {
    const text = String(item || "").trim();
    if (!text) continue;
    const angled = text.match(/<([^<>]+)>/);
    const addr = (angled ? angled[1] : text).trim().toLowerCase();
    if (!addr.includes("@")) continue;
    rows.push({ addr, text });
  }
  return rows;
}

// shortcut: Reply puts the sender in To. Reply All keeps other To and Cc in Cc. Upgrade if Reply-To should replace From.
function replyParties(email, self, all) {
  const mineRow = addressRows(self)[0];
  const mine = mineRow ? mineRow.addr : String(self || "").trim().toLowerCase();
  const seen = new Set();
  const take = (value) => {
    const out = [];
    for (const row of addressRows(value)) {
      if (!row || seen.has(row.addr) || row.addr === mine) continue;
      seen.add(row.addr);
      out.push(row.text);
    }
    return out;
  };
  const from = addressRows(email && email.from)[0];
  const fromOther = from && from.addr !== mine ? from : null;
  if (fromOther) seen.add(fromOther.addr);
  const toRows = take(email && email.to);
  const ccRows = take(email && email.cc);
  if (!all) {
    if (fromOther) return { to: fromOther.text, cc: "" };
    return { to: toRows.concat(ccRows).join(", "), cc: "" };
  }
  if (fromOther) return { to: fromOther.text, cc: toRows.concat(ccRows).join(", ") };
  return { to: toRows.join(", "), cc: ccRows.join(", ") };
}

function prefixedSubject(subject, prefix) {
  const text = String(subject || "").trim();
  if (!text) return prefix;
  if (prefix === "Re:" && /^re\s*:/i.test(text)) return text;
  if (prefix === "Fwd:" && /^(?:fwd|fw)\s*:/i.test(text)) return text;
  return `${prefix} ${text}`;
}

function quoteBlock(text) {
  const body = String(text || "").trim();
  if (!body) return "";
  return body.split("\n").map((line) => `> ${line}`).join("\n");
}

function replyBody(email) {
  const quoted = quoteBlock(readable(email));
  if (!quoted) return "";
  const who = String((email && email.from) || "").trim() || "the sender";
  return `\n\n${who} wrote:\n${quoted}`;
}

// shortcut: names only, upgrade when compose can attach the open message's blobs.
function attachmentNote(email) {
  const files = ((email && email.attachments) || []).filter((item) => item && (item.filename || item.id));
  if (files.length) {
    return `Attachments: ${files.map((item) => item.filename || "attachment").join(", ")}`;
  }
  if (email && email.hasAttachments) return "This message has attachments.";
  return "";
}

function forwardBody(email) {
  const lines = ["---------- Forwarded message ----------"];
  const from = String((email && email.from) || "").trim();
  if (from) lines.push(`From: ${from}`);
  if (email && email.date) lines.push(`Date: ${email.date}`);
  const subject = String((email && email.subject) || "").trim();
  if (subject) lines.push(`Subject: ${subject}`);
  const to = people(email && email.to);
  if (to) lines.push(`To: ${to}`);
  const cc = people(email && email.cc);
  if (cc) lines.push(`Cc: ${cc}`);
  const quoted = String(readable(email) || "").trim();
  if (quoted) lines.push("", quoted);
  const note = attachmentNote(email);
  if (note) lines.push("", note);
  return `\n\n${lines.join("\n")}`;
}

function quoteShownDefault(kind) {
  return kind === "reply" || kind === "all";
}

function quoteSource(email) {
  const message = email || {};
  return {
    id: message.id ? String(message.id) : "",
    from: message.from || "",
    to: message.to || "",
    cc: message.cc || "",
    date: message.date || "",
    subject: message.subject || "",
    htmlBody: typeof message.htmlBody === "string" ? message.htmlBody : "",
    textBody: typeof message.textBody === "string" ? message.textBody : "",
    snippet: typeof message.snippet === "string" ? message.snippet : "",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    hasAttachments: message.hasAttachments === true,
  };
}

function outgoingBody(draft, quote) {
  const text = String(draft || "").replace(/\s+$/g, "");
  const quoted = String(quote || "").replace(/^\s+/, "").replace(/\s+$/g, "");
  if (!quoted) return text;
  if (!text) return quoted;
  return text + "\n\n" + quoted;
}

function quoteWidthPref(value) {
  const raw = typeof value === "number" ? value : (typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN);
  if (!Number.isInteger(raw) || raw < 220 || raw > 720) return 420;
  return raw;
}

function quotePaneWidth(width, total) {
  const min = 220;
  const raw = Number(width);
  const stored = Number.isFinite(raw) ? raw : 420;
  const space = Number(total);
  const max = Number.isFinite(space) && space >= min + 320
    ? Math.max(min, Math.min(720, Math.floor(space - 320)))
    : 720;
  return paneWidth(stored, 0, min, max);
}

function composeLayoutMode(contentWidth, readerWidth, viewportWidth) {
  const content = Number(contentWidth) || 0;
  const reader = Number(readerWidth) || 0;
  const viewport = Number(viewportWidth) || 0;
  if (content >= 900) return "wide";
  if (content > 0) return "narrow";
  if (reader >= 640 && (viewport === 0 || viewport >= 960)) return "wide";
  if (viewport >= 960) return "wide";
  return "narrow";
}

function composeFrame(contentWidth, readerWidth, viewportWidth, shown, collapsed) {
  const layout = composeLayoutMode(contentWidth, readerWidth, viewportWidth);
  const visible = shown === true;
  const wide = layout === "wide";
  return {
    layout: layout,
    quote: visible ? "shown" : "hidden",
    direction: wide && visible ? "row" : "column",
    divider: wide && visible,
    collapsed: !wide && visible && collapsed === true,
  };
}

function composeDismisses(action) {
  return action === "close" || action === "cancel";
}

function composeOutcome(action) {
  if (action === "send") return "mail:send";
  if (action === "schedule") return "mail:scheduleSend";
  if (action === "save") return "mail:upsertDraft";
  return "";
}

function composeSession(actions) {
  const calls = [];
  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    if (composeDismisses(action)) continue;
    const channel = composeOutcome(action);
    if (channel) calls.push(channel);
  }
  return calls;
}

function dismissCompose(action) {
  const name = action || "close";
  return composeDismisses(name) && !composeOutcome(name);
}

function quoteStateFromSeed(fields) {
  const source = fields && fields.quoteEmail;
  const text = fields && typeof fields.quote === "string" ? fields.quote : "";
  if (!source && !text) return null;
  return {
    text: text,
    shown: !!(fields && fields.quoteShown),
    collapsed: false,
    email: source || null,
    kind: (fields && fields.kind) || "",
    images: false,
  };
}

function composeSeed(email, kind, self) {
  const message = email || {};
  if (kind === "forward") {
    return {
      kind: "forward",
      accountId: message.accountId || "",
      title: "Forward",
      to: "",
      cc: "",
      subject: prefixedSubject(message.subject, "Fwd:"),
      body: "",
      quote: forwardBody(message),
      quoteShown: quoteShownDefault("forward"),
      quoteEmail: quoteSource(message),
    };
  }
  const all = kind === "all";
  const parties = replyParties(message, self, all);
  const seed = {
    kind: all ? "all" : "reply",
    accountId: message.accountId || "",
    title: all ? "Reply All" : "Reply",
    to: parties.to,
    cc: parties.cc,
    subject: prefixedSubject(message.subject, "Re:"),
    body: "",
    quote: replyBody(message),
    quoteShown: quoteShownDefault(all ? "all" : "reply"),
    quoteEmail: quoteSource(message),
    aiWrite: true,
  };
  if (message.messageId) seed.inReplyTo = message.messageId;
  if (message.threadId) seed.threadId = message.threadId;
  return seed;
}

function withSuggestion(seed, text) {
  const line = String(text || "").trim();
  if (!line) return seed;
  const body = seed && seed.body ? String(seed.body) : "";
  return { ...seed, body: body ? `${line}${body}` : line };
}

function suggestionItems(data) {
  const list = data && Array.isArray(data.suggestions) ? data.suggestions : [];
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

function suggestionEmail(email) {
  return {
    subject: (email && email.subject) || "",
    from: (email && email.from) || "",
    snippet: (email && (email.snippet || email.textBody)) || "",
    text_body: readable(email),
  };
}

function draftBlockReason(mode, prompt, existing) {
  const instruction = String(prompt || "").trim();
  const body = String(existing || "").trim();
  if (mode === "custom" && !instruction) return "Add a prompt.";
  if (mode !== "custom" && !body && !instruction) return "Add some text, or a prompt.";
  return "";
}

function draftInstruction(mode, prompt, existing, subject) {
  return {
    mode: mode || "custom",
    user_prompt: String(prompt || "").trim(),
    existing_draft_content: String(existing || ""),
    subject: String(subject || ""),
  };
}

// shortcut: continue appends model text; rewrite and custom replace the body. Upgrade if continue must keep a partial model reply beside the old draft.
function draftBase(mode, existing) {
  return mode === "continue" ? String(existing || "") : "";
}

function shownDraft(view) {
  if (!view) return "";
  if (!view.text) return typeof view.previous === "string" ? view.previous : view.base;
  return view.base + view.text;
}

function htmlChunkToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function applyDraftEvent(view, event) {
  if (!view || !view.pending || !event || event.reqId !== view.reqId) return view;
  if (event.type === "chunk") {
    view.text += htmlChunkToText(event.data);
    return view;
  }
  if (event.type === "error") {
    view.error = String(event.message || "The draft failed.");
    view.pending = false;
    return view;
  }
  if (event.type === "done") view.pending = false;
  return view;
}

function fillPresets(cards) {
  const select = $("profile");
  select.replaceChildren();
  for (const card of cards) {
    const option = document.createElement("option");
    option.value = card.profile;
    option.textContent = card.displayName || card.profile;
    select.appendChild(option);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom IMAP / SMTP";
  select.appendChild(custom);
  syncCustomFields();
}

function syncCustomFields() {
  $("custom-fields").hidden = $("profile").value !== "custom";
}

function connectButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary empty-connect";
  button.addEventListener("click", () => openDialog("connect"));
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "15");
  icon.setAttribute("height", "15");
  icon.setAttribute("aria-hidden", "true");
  const link = document.createElementNS("http://www.w3.org/2000/svg", "path");
  link.setAttribute("fill", "none");
  link.setAttribute("stroke", "currentColor");
  link.setAttribute("stroke-width", "2");
  link.setAttribute("stroke-linecap", "round");
  link.setAttribute("stroke-linejoin", "round");
  link.setAttribute("d", "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71");
  const link2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  link2.setAttribute("fill", "none");
  link2.setAttribute("stroke", "currentColor");
  link2.setAttribute("stroke-width", "2");
  link2.setAttribute("stroke-linecap", "round");
  link2.setAttribute("stroke-linejoin", "round");
  link2.setAttribute("d", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71");
  icon.append(link, link2);
  const label = document.createElement("span");
  label.textContent = "Connect account";
  button.append(icon, label);
  return button;
}

function renderBanner() {
  const banner = $("banner");
  banner.textContent = state.accounts.length ? "" : "No mailbox yet. Connect an account.";
  banner.hidden = !banner.textContent;
  banner.title = banner.textContent;
}

function syncRemove() {
  const button = $("remove");
  const live = isLive(selectedAccount());
  button.hidden = false;
  button.disabled = !live;
  button.title = live ? "Remove this account. Mail stays on the server." : "Connect a mailbox before removing one.";
}

function renderAccounts() {
  renderSettingsAccounts();
  const nav = $("folders");
  nav.replaceChildren();
  if (!state.accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No accounts.";
    nav.append(empty, connectButton());
    return;
  }
  for (const account of state.accounts) {
    const provider = folderProvider(account);
    const expanded = providerExpanded(provider, state.prefs);
    let heading;
    if (provider) {
      heading = document.createElement("button");
      heading.type = "button";
      heading.className = "account";
      heading.setAttribute("aria-expanded", expanded ? "true" : "false");
      const mark = document.createElement("span");
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = expanded ? "▾ " : "▸ ";
      heading.append(mark, accountLabel(account));
      heading.addEventListener("click", () => {
        toggleProviderFolders(provider).catch((error) => showStatus(error.message, true));
      });
    } else {
      heading = document.createElement("h2");
      heading.textContent = accountLabel(account);
    }
    nav.appendChild(heading);
    if (account.needsReauth && account.reauthReason) {
      const note = document.createElement("p");
      note.className = "reauth";
      note.textContent = account.reauthReason;
      nav.appendChild(note);
    }
    if (expanded) {
    for (const folder of folderTree(foldersOf(account), accountDelimiter(account))) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder";
      button.dataset.dropKind = "imap";
      button.dataset.dropId = folder.id;
      button.dataset.dropAccount = account.id;
      button.style.paddingLeft = (8 + folder.depth * 14) + "px";
      if (account.id === state.accountId && folder.id === state.folderId) {
        button.setAttribute("aria-current", "true");
      }
      const label = document.createElement("span");
      label.className = "folder-label";
      const icon = document.createElement("span");
      icon.className = "folder-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = folderIcon(folder.wellKnownName);
      const name = document.createElement("span");
      name.className = "name";
      const labelText = chipLabel(folder);
      name.textContent = labelText;
      label.append(icon, name);
      button.appendChild(label);
      if (folder.unreadCount) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(folder.unreadCount);
        button.appendChild(count);
      }
      const unread = folder.unreadCount ? `, ${folder.unreadCount} unread` : "";
      const serverName = String(folder.name || folder.id || "");
      button.title = serverName && serverName !== labelText ? serverName : labelText;
      button.setAttribute("aria-label", `${labelText || "Folder"}${unread}. Right-click to move.`);
      button.addEventListener("click", () => {
        selectFolder(account.id, folder.id).catch((error) => showStatus(error.message, true));
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openImapFolderMenu(folder, account, event.clientX, event.clientY);
      });
      nav.appendChild(button);
    }
    }
    appendProviderBlock(nav, account);
  }
}

function providerPayloadFor(account) {
  const payload = state.providerFolders;
  if (payload && payload.accountId === account.id) return payload;
  return { accountId: account.id, api: false, reason: "loading", folders: [] };
}

function appendProviderBlock(nav, account) {
  if (!isLive(account) || account.id !== state.accountId) return;
  const provider = folderProvider(account);
  if (provider !== "gmail" && provider !== "outlook") return;
  const payload = providerPayloadFor(account);
  const view = providerFolderState(payload);
  const block = document.createElement("section");
  block.className = "provider-block";
  block.id = "provider-folders";
  const title = document.createElement("h2");
  title.textContent = provider === "outlook" ? "Outlook folders" : "Gmail labels";
  block.appendChild(title);
  if (view.mode !== "live") {
    const note = document.createElement("p");
    note.className = "provider-note";
    note.textContent = payload.message || providerCopy(view.reason, provider);
    block.appendChild(note);
    if (showOrganizeGrant(view.reason)) {
      const grant = document.createElement("button");
      grant.type = "button";
      grant.className = "provider-grant";
      grant.textContent = provider === "outlook" ? "Grant Outlook folders" : "Grant Gmail labels";
      grant.addEventListener("click", () => guard(grantOrganize));
      block.appendChild(grant);
    }
    nav.appendChild(block);
    return;
  }
  if (!view.folders.length) {
    const note = document.createElement("p");
    note.className = "provider-note";
    note.textContent = provider === "outlook" ? "No Outlook folders returned." : "No Gmail labels returned.";
    block.appendChild(note);
  }
  for (const folder of providerLabelTree(view.folders)) {
    const row = document.createElement("div");
    row.className = "provider-row";
    row.dataset.dropKind = provider === "outlook" ? "outlook" : "gmail";
    row.dataset.dropId = folder.id;
    row.title = folder.name;
    row.tabIndex = 0;
    row.setAttribute("aria-haspopup", "menu");
    const shown = folder.label || folder.name;
    row.setAttribute("aria-label", folder.editable
      ? shown + ". Right-click for Rename, Move, and Delete."
      : shown + ". Right-click to move.");
    row.style.paddingLeft = (folder.depth * 14) + "px";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = shown;
    row.append(providerMark(provider), name);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFolderMenu(folder, provider, event.clientX, event.clientY);
    });
    block.appendChild(row);
  }
  const form = document.createElement("form");
  form.className = "provider-create";
  let parentSelect = null;
  if (provider === "outlook") {
    parentSelect = document.createElement("select");
    parentSelect.setAttribute("aria-label", "Inside Outlook folder");
    parentSelect.append(option("", "Top level"));
    for (const folder of providerLabelTree(view.folders)) {
      parentSelect.append(option(folder.id, indentedName(folder)));
    }
    form.appendChild(parentSelect);
  }
  const input = document.createElement("input");
  input.maxLength = 200;
  input.placeholder = provider === "outlook" ? "Folder name" : "Parent/Child";
  input.setAttribute("aria-label", provider === "outlook" ? "New Outlook folder" : "New Gmail label");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "provider-mini";
  submit.textContent = provider === "outlook" ? "Add folder" : "Add label";
  form.append(input, submit);
  if (parentSelect) form.classList.add("stacked");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const parentId = parentSelect ? parentSelect.value : "";
    guard(() => createProviderFolder(input.value, parentId));
  });
  block.appendChild(form);
  nav.appendChild(block);
}

function fileSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function threadMembers(fromOpen, listed) {
  const open = Array.isArray(fromOpen) ? fromOpen.filter((row) => row && row.id) : [];
  if (open.length) return open;
  return Array.isArray(listed) ? listed.filter((row) => row && row.id) : [];
}

function renderChips(account) {
  const row = $("list-chips");
  if (!row) return;
  row.replaceChildren();
  const folders = state.prefs.chips && account ? chipFolders(account) : [];
  row.hidden = folders.length === 0;
  for (const folder of folders) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    const label = chipLabel(folder);
    button.textContent = label;
    const server = String(folder.name || folder.id || "");
    if (server && server !== label) button.title = server;
    if (account.id === state.accountId && folder.id === state.folderId) {
      button.setAttribute("aria-current", "true");
    }
    button.addEventListener("click", () => {
      selectFolder(account.id, folder.id).catch((error) => showStatus(error.message, true));
    });
    row.appendChild(button);
  }
}

// Filter stays on messages already loaded: subject, from, and snippet.
// It does not call mail:search or mail:searchLocal. Toolbar search does.
function filteredEmails(emails, query) {
  const q = String(query || "").trim().toLowerCase();
  const rows = Array.isArray(emails) ? emails : [];
  if (!q) return rows;
  return rows.filter((email) => {
    const subject = email && email.subject ? String(email.subject) : "";
    const from = email && email.from ? String(email.from) : "";
    const snippet = email && email.snippet ? String(email.snippet) : "";
    return (subject + "\n" + from + "\n" + snippet).toLowerCase().includes(q);
  });
}

function selectionIds(selected) {
  const list = selected instanceof Set ? Array.from(selected) : (Array.isArray(selected) ? selected : []);
  const ids = [];
  const seen = new Set();
  for (const id of list) {
    const key = String(id || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }
  return ids;
}

function listClickSelection(selected, anchor, visibleIds, clickedId, mods) {
  const visible = selectionIds(visibleIds);
  const current = selectionIds(selected);
  const id = String(clickedId || "");
  const flags = mods || {};
  const shift = flags.shift === true;
  const toggle = flags.meta === true || flags.ctrl === true || flags.toggle === true;
  const kept = anchor ? String(anchor) : "";
  if (!id || visible.indexOf(id) < 0) return { ids: current, anchor: kept };
  if (shift) {
    const start = kept && visible.indexOf(kept) >= 0 ? kept : id;
    const from = Math.min(visible.indexOf(start), visible.indexOf(id));
    const to = Math.max(visible.indexOf(start), visible.indexOf(id));
    const range = visible.slice(from, to + 1);
    if (toggle) {
      const set = new Set(current);
      for (const item of range) set.add(item);
      return { ids: selectionIds(Array.from(set)), anchor: start };
    }
    return { ids: range, anchor: start };
  }
  if (toggle) {
    const set = new Set(current);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    return { ids: selectionIds(Array.from(set)), anchor: id };
  }
  return { ids: [id], anchor: id };
}

function toggleSelectionId(selected, id) {
  const key = String(id || "");
  const current = selectionIds(selected);
  if (!key) return { ids: current, anchor: current[0] || "" };
  const has = current.indexOf(key) >= 0;
  const ids = has ? current.filter((item) => item !== key) : current.concat(key);
  return { ids: ids, anchor: has ? (ids[ids.length - 1] || "") : key };
}

function selectAllVisible(visibleIds) {
  const ids = selectionIds(visibleIds);
  return { ids: ids, anchor: ids[0] || "" };
}

function clearListSelection() {
  return { ids: [], anchor: "" };
}

function pruneSelection(selected, loadedIds, anchor) {
  const allowed = new Set(selectionIds(loadedIds));
  const ids = selectionIds(selected).filter((id) => allowed.has(id));
  const kept = anchor && allowed.has(String(anchor)) && ids.indexOf(String(anchor)) >= 0
    ? String(anchor)
    : (ids[0] || "");
  return { ids: ids, anchor: kept };
}

function selectionShortcut(event, blocked) {
  if (blocked || !event) return "";
  if (event.key === "Escape") return "clear";
  const key = String(event.key || "").toLowerCase();
  if (key === "a" && (event.meta || event.ctrl) && !event.alt && !event.shift) return "all";
  return "";
}

function modifierBlocksDrag(event) {
  if (!event) return false;
  return event.shiftKey === true || event.metaKey === true || event.ctrlKey === true;
}

function selectionDragPayload(messages) {
  const rows = [];
  for (const message of messages || []) {
    const row = messageDragPayload(message);
    if (row) rows.push(row);
  }
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    accountId: rows[0].accountId,
    folderId: rows[0].folderId,
    messages: rows,
  };
}

function dragMessagesFrom(raw, fallback) {
  let payload = fallback || null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.id || (Array.isArray(parsed.messages) && parsed.messages.length))) payload = parsed;
    } catch (error) {
      // The in-memory drag payload still names the messages.
    }
  }
  if (!payload) return [];
  if (Array.isArray(payload.messages) && payload.messages.length) {
    return payload.messages.map((row) => messageDragPayload(row)).filter(Boolean);
  }
  const one = messageDragPayload(payload);
  return one ? [one] : [];
}

function coalesceProviderCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const moves = new Map();
  const order = [];
  const rest = [];
  for (const spec of list) {
    if (!spec || !spec.channel || !spec.params) continue;
    if (spec.channel === "mail:moveToFolder") {
      const key = String(spec.params.targetFolderId || "");
      if (!moves.has(key)) {
        moves.set(key, []);
        order.push(key);
      }
      moves.get(key).push(spec.params);
      continue;
    }
    rest.push({ channel: spec.channel, params: spec.params });
  }
  const out = [];
  for (const key of order) {
    const params = moves.get(key);
    if (params.length === 1) {
      out.push({ channel: "mail:moveToFolder", params: params[0] });
      continue;
    }
    out.push({
      channel: "mail:moveToFolder",
      params: {
        targetFolderId: params[0].targetFolderId,
        items: params.map((row) => ({
          emailId: row.emailId,
          accountId: row.accountId,
          folderId: row.folderId,
        })),
      },
    });
  }
  return out.concat(rest);
}

function bulkMoveCalls(messages, target) {
  const calls = [];
  for (const message of messages || []) {
    const plan = organizeDrop(target, message);
    if (!plan.ok) continue;
    calls.push({ channel: plan.channel, params: plan.params });
  }
  return coalesceProviderCalls(calls);
}

function bulkMoveFailure(messages, target) {
  if (bulkMoveCalls(messages, target).length) return "";
  const first = (messages || [])[0];
  const plan = first ? organizeDrop(target, first) : null;
  return plan && plan.message ? plan.message : "Choose a message first.";
}

function conversationRemoval(email, conversationOn, members) {
  const threaded = conversationOn !== false && usesThread(email, members);
  return {
    unit: threaded ? "thread" : "message",
    threaded: threaded,
    channelArchive: threaded ? "mail:threadArchive" : "mail:archive",
    channelTrash: threaded ? "mail:threadTrash" : "mail:delete",
  };
}

function bulkRemovalCalls(messages, kind, conversationOn) {
  const trash = kind === "trash";
  const threads = new Map();
  const singles = [];
  for (const email of messages || []) {
    if (!email || !email.id || !email.accountId) continue;
    const choice = conversationRemoval(email, conversationOn, email.members || []);
    if (choice.threaded) {
      const threadId = String(email.threadId || email.id);
      const key = String(email.accountId) + "\0" + threadId;
      if (!threads.has(key)) {
        threads.set(key, {
          channel: trash ? "mail:threadTrash" : "mail:threadArchive",
          params: {
            accountId: email.accountId,
            emailId: String(email.id),
            threadId: threadId,
          },
        });
      }
      continue;
    }
    singles.push({ emailId: String(email.id), accountId: email.accountId });
  }
  const calls = Array.from(threads.values());
  if (singles.length === 1) {
    calls.push({
      channel: trash ? "mail:delete" : "mail:archive",
      params: singles[0],
    });
  } else if (singles.length > 1) {
    calls.push({
      channel: trash ? "mail:deleteBatch" : "mail:archiveBatch",
      params: { items: singles },
    });
  }
  return calls;
}

function bulkFlagCalls(messages, action) {
  const items = [];
  for (const message of messages || []) {
    if (!message || !message.id) continue;
    items.push({ emailId: String(message.id), accountId: message.accountId });
  }
  if (!items.length) return [];
  if (action === "read" || action === "unread") {
    return [{ channel: "mail:markReadBatch", params: { isRead: action === "read", items: items } }];
  }
  if (action === "star" || action === "unstar") {
    return [{ channel: "mail:toggleStarBatch", params: { isStarred: action === "star", items: items } }];
  }
  return [];
}

function bulkLabelCalls(messages, labelId, mode) {
  const id = String(labelId || "");
  if (!id) return [];
  const add = mode === "add" ? [id] : [];
  const remove = mode === "remove" ? [id] : [];
  const calls = [];
  for (const message of messages || []) {
    if (!message || !message.id || !message.accountId) continue;
    calls.push({
      channel: "mail:modifyMessageLabels",
      params: {
        accountId: message.accountId,
        emailId: String(message.id),
        addLabelIds: add,
        removeLabelIds: remove,
      },
    });
  }
  return calls;
}

function bulkNeedsConfirm(action, detail) {
  if (action === "archive" || action === "trash" || action === "move") return true;
  if (action === "remove-label") return !!(detail && detail.removesFromView);
  return false;
}

function bulkConfirmCopy(action, count, detail) {
  const n = Math.max(0, Number(count) || 0);
  const noun = n === 1 ? "message" : "messages";
  const row = detail || {};
  const base = { confirm: "Confirm", cancel: "Cancel", needsName: false, name: "" };
  if (action === "archive") {
    return Object.assign({}, base, {
      title: "Archive",
      body: "Archive " + n + " " + noun + "? This removes them from the current list.",
    });
  }
  if (action === "trash") {
    return Object.assign({}, base, {
      title: "Trash",
      body: "Move " + n + " " + noun + " to Trash? This removes them from the current list.",
    });
  }
  if (action === "move") {
    const target = String(row.target || "that folder");
    return Object.assign({}, base, {
      title: "Move",
      body: "Move " + n + " " + noun + " to “" + target + "”? This moves them on the provider.",
    });
  }
  if (action === "remove-label") {
    const label = String(row.label || "that label");
    return Object.assign({}, base, {
      title: "Remove label",
      body: "Remove “" + label + "” from " + n + " " + noun + "? This removes them from the current list.",
    });
  }
  return null;
}

function confirmedCalls(action, answer, calls, detail) {
  const list = Array.isArray(calls) ? calls.slice() : [];
  if (!bulkNeedsConfirm(action, detail)) return list;
  if (!answer || answer.ok !== true) return [];
  return list;
}

function labelRemovesFromView(folderId, labelId) {
  const folder = String(folderId || "");
  const label = String(labelId || "");
  return !!(folder && label && folder === label);
}

function bulkBlockedByPause(sync, accountId) {
  if (!sync || sync.state !== "paused") return false;
  if (sync.accountId && accountId && String(sync.accountId) !== String(accountId)) return false;
  return true;
}

function selectionPaused(sync, messages) {
  return (messages || []).some((message) => bulkBlockedByPause(sync, message && message.accountId));
}

function collectBulkOutcome(previous, data, error) {
  const opIds = previous && Array.isArray(previous.opIds) ? previous.opIds.slice() : [];
  if (error) {
    const message = error && error.message ? String(error.message) : String(error || "");
    if (/rate limit|rate_limit|\b429\b/i.test(message)) {
      return { opIds: opIds, paused: true, error: "Paused for rate limit" };
    }
    return { opIds: opIds, paused: false, error: message || "The mail host rejected that request." };
  }
  const more = data && Array.isArray(data.opIds) ? data.opIds.filter(Boolean) : [];
  return { opIds: opIds.concat(more), paused: false, error: "" };
}

function callCount(calls) {
  let n = 0;
  for (const spec of calls || []) {
    const params = spec && spec.params;
    if (params && Array.isArray(params.items) && params.items.length) n += params.items.length;
    else if (params) n += 1;
  }
  return n;
}

function bulkDropAction(target) {
  if (!target || !target.kind) return "";
  if (target.kind === "gmail") return "add-label";
  if (target.kind === "imap" || target.kind === "outlook") return "move";
  return "";
}

function pushStatusLabel(account) {
  return account && account.push === "push" ? "Push: on" : "Push: polling";
}

function pushIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  for (const d of [
    "M5 12.55a11 11 0 0 1 14.08 0",
    "M1.42 9a16 16 0 0 1 21.16 0",
    "M8.53 16.11a6 6 0 0 1 6.95 0",
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.appendChild(path);
  }
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "line");
  dot.setAttribute("x1", "12");
  dot.setAttribute("y1", "20");
  dot.setAttribute("x2", "12.01");
  dot.setAttribute("y2", "20");
  icon.appendChild(dot);
  return icon;
}

function renderSettingsAccounts() {
  const list = $("settings-accounts");
  if (!list) return;
  const rows = state.accounts.map((account) => `${account.id}\t${pushStatusLabel(account)}`);
  const stamp = rows.join("\n") || "empty";
  if (list.dataset.stamp === stamp) return;
  list.dataset.stamp = stamp;
  list.replaceChildren();
  if (!state.accounts.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No mailbox connected.";
    list.appendChild(empty);
    return;
  }
  for (const account of state.accounts) {
    const row = document.createElement("li");
    row.className = "settings-account";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = accountLabel(account);
    const status = document.createElement("span");
    status.className = "push";
    const label = pushStatusLabel(account);
    status.append(pushIcon(), document.createTextNode(label));
    row.append(name, status);
    list.appendChild(row);
  }
  const motion = motionApi();
  const dialog = $("settings");
  if (motion && dialog && dialog.open) motion.rows(list.querySelectorAll(".settings-account"));
}

function syncStatusLabel(sync) {
  if (!sync || !sync.state) return "";
  if (sync.message) return sync.message;
  if (sync.state === "syncing") return "Syncing…";
  if (sync.state === "paused") return "Paused for rate limit";
  if (sync.state === "done") return "Sync done";
  if (sync.state === "error") return "Sync failed";
  return "";
}

const ROW_ICON = {
  "Mark read": "M4 11h16v8H4v-8Zm0 0 8 5 8-5M4 11 12 5l8 6",
  "Mark unread": "M4 7h16v11H4V7Zm0 0 8 6 8-6",
  Delete: "M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13",
  Reply: "M9 17 4 12 9 7M20 18v-2a4 4 0 0 0-4-4H4",
  "Reply All": "M8 17 3 12 8 7M13 17 8 12 13 7M21 18v-2a4 4 0 0 0-4-4H8",
};

function rowIcon(label) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", ROW_ICON[label] || "");
  svg.appendChild(path);
  return svg;
}

function rowAction(action, label, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.appendChild(rowIcon(label));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    guard(run);
  });
  return button;
}

const CHECK_BOX = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z";
const CHECK_MARK = "M8 12.5l2.5 2.5L16 9";

function rowCheck(email, selected) {
  const box = document.createElement("button");
  box.type = "button";
  box.className = "row-check";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", selected ? "true" : "false");
  box.setAttribute("aria-label", "Select " + (email.subject || "message"));
  box.appendChild(strokeIcon(selected ? [CHECK_BOX, CHECK_MARK] : [CHECK_BOX], 16));
  box.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    commitSelection(toggleSelectionId(state.selectedIds, email.id));
  });
  return box;
}

function messageRow(email) {
  const row = document.createElement("div");
  row.className = "message-row";
  row.dataset.emailId = email.id || "";
  row.dataset.accountId = email.accountId || "";
  row.dataset.folderId = email.folderId || "";
  const selected = state.selectedIds.indexOf(String(email.id || "")) >= 0;
  if (selected) row.classList.add("selected");
  row.setAttribute("aria-selected", selected ? "true" : "false");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message";
  button.draggable = true;
  button.setAttribute("data-testid", "mail-list-message-row");
  if (email.unread) button.classList.add("unread");
  if (state.email && state.email.id === email.id) button.setAttribute("aria-current", "true");
  if (email.unread) {
    const flag = document.createElement("span");
    flag.className = "sr";
    flag.textContent = "Unread";
    button.appendChild(flag);
  }
  if (email.isStarred) {
    const flag = document.createElement("span");
    flag.className = "sr";
    flag.textContent = "Starred";
    button.appendChild(flag);
  }
  const name = senderName(email.from);
  const gutter = document.createElement("span");
  gutter.className = "gutter";
  gutter.setAttribute("aria-hidden", "true");
  if (email.unread) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    gutter.appendChild(dot);
  }
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = senderInitial(name);
  avatar.style.backgroundColor = avatarColor(name);
  const main = document.createElement("span");
  main.className = "row-main";
  const from = document.createElement("span");
  from.className = "from";
  if (email.isStarred) {
    const star = document.createElement("span");
    star.className = "star";
    star.setAttribute("aria-hidden", "true");
    star.textContent = "★";
    from.appendChild(star);
  }
  from.append(name);
  const subjectLine = document.createElement("span");
  subjectLine.className = "subject-line";
  const subject = document.createElement("span");
  subject.className = "subject";
  subject.textContent = email.subject || "(no subject)";
  const when = document.createElement("time");
  when.className = "when";
  if (email.date) when.dateTime = email.date;
  when.textContent = listWhen(email.date);
  subjectLine.append(subject, when);
  const snippet = document.createElement("span");
  snippet.className = "snippet";
  snippet.textContent = email.snippet || "";
  main.append(from, subjectLine, snippet);
  button.append(gutter, avatar, main);
  button.addEventListener("click", (event) => {
    const mods = { shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey };
    const visible = shownEmails().map((item) => item && item.id);
    commitSelection(listClickSelection(state.selectedIds, state.selectionAnchor, visible, email.id, mods));
    if (mods.shift || mods.meta || mods.ctrl) {
      event.preventDefault();
      return;
    }
    openMessage(email.id).catch((error) => showStatus(error.message, true));
  });
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.setAttribute("data-testid", "mail-row-actions");
  const unread = !!email.unread;
  actions.append(
    rowAction("read", unread ? "Mark read" : "Mark unread", () => setRead(email, unread)),
    rowAction("delete", "Delete", () => deleteFromList(email)),
    rowAction("reply", "Reply", () => replyFromList(email, "reply")),
    rowAction("reply-all", "Reply All", () => replyFromList(email, "all")),
  );
  row.append(rowCheck(email, selected), button, actions);
  return row;
}

function shownEmails() {
  const input = $("list-filter");
  return filteredEmails(state.emails, input ? input.value : "");
}

function rememberLoadedSelection() {
  const next = pruneSelection(
    state.selectedIds,
    (state.emails || []).map((email) => email && email.id),
    state.selectionAnchor,
  );
  state.selectedIds = next.ids;
  state.selectionAnchor = next.anchor;
}

function commitSelection(next) {
  const row = next || clearListSelection();
  state.selectedIds = row.ids;
  state.selectionAnchor = row.anchor || "";
  renderList();
}

function selectedMessages() {
  const byId = new Map();
  for (const email of state.emails || []) {
    if (email && email.id) byId.set(String(email.id), email);
  }
  return state.selectedIds.map((id) => byId.get(id)).filter(Boolean);
}

function selectionMoveMessages() {
  const rows = selectedMessages();
  if (!rows.length) return [];
  const accountId = rows.some((email) => email.accountId === state.accountId)
    ? state.accountId
    : rows[0].accountId;
  return rows.filter((email) => email.accountId === accountId);
}

function withSelectionMembers(email) {
  const members = [];
  if (state.prefs.conversation !== false && email) {
    const threadId = String(email.threadId || "");
    const open = state.email;
    if (open && open.accountId === email.accountId && (open.id === email.id || (threadId && String(open.threadId || "") === threadId))) {
      for (const row of state.thread || []) members.push(row);
    }
    if (threadId) {
      for (const row of state.emails || []) {
        if (row && row.accountId === email.accountId && String(row.threadId || "") === threadId) members.push(row);
      }
    }
  }
  return Object.assign({}, email, { members: members });
}

function setSelectionLabel(id, label) {
  const button = $(id);
  if (!button) return;
  button.setAttribute("aria-label", label);
  button.title = label;
  const text = button.querySelector("span");
  if (text) text.textContent = label;
}

function paintSelectionBar(shown) {
  const bar = $("selection-bar");
  const count = $("selection-count");
  const selectAll = $("select-visible");
  const list = $("messages");
  if (list) list.classList.toggle("has-selection", state.selectedIds.length > 0);
  if (selectAll) selectAll.hidden = !shown.length;
  if (!bar) return;
  const wasHidden = bar.hidden;
  if (!state.selectedIds.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (count) {
    const n = state.selectedIds.length;
    count.textContent = n === 1 ? "1 selected" : n + " selected";
  }
  const messages = selectedMessages();
  const starred = messages.length > 0 && messages.every((email) => email.isStarred);
  setSelectionLabel("selection-star", starred ? "Unstar" : "Star");
  const account = messages[0]
    ? (state.accounts.find((item) => item.id === messages[0].accountId) || selectedAccount())
    : selectedAccount();
  const provider = folderProvider(account);
  const listed = account ? providerPayloadFor(account) : null;
  const model = messages[0]
    ? organizeMenu(messages[0], foldersOf(account), listed, provider)
    : { add: [], remove: [], outlook: [] };
  const add = $("selection-add-label");
  const remove = $("selection-remove-label");
  const outlook = $("selection-outlook");
  if (add) add.hidden = !model.add.length;
  if (remove) remove.hidden = !model.remove.length;
  if (outlook) outlook.hidden = !model.outlook.length;
  if (wasHidden) {
    const motion = motionApi();
    if (motion) {
      motion.prepare(bar);
      motion.enter(bar);
    }
  }
}

function renderList() {
  rememberLoadedSelection();
  const list = $("messages");
  const head = $("list-head");
  for (const node of [...list.children]) {
    if (node !== head) node.remove();
  }
  const account = selectedAccount();
  const folder = foldersOf(account).find((item) => item.id === state.folderId);
  const title = $("list-title");
  if (title) {
    title.textContent = state.query ? `Search: ${state.query}` : (chipLabel(folder) || "Messages");
  }
  renderChips(account);
  const shown = filteredEmails(state.emails, $("list-filter") ? $("list-filter").value : "");
  paintSelectionBar(shown);
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    if (!state.accounts.length && !state.query) {
      empty.textContent = "No messages yet.";
    } else if (!state.emails.length) {
      empty.textContent = state.query ? "No messages match that search." : "No messages in this folder.";
    } else {
      empty.textContent = "No loaded messages match that filter.";
    }
    list.appendChild(empty);
  } else {
    for (const email of shown) list.appendChild(messageRow(email));
  }
  const motionKey = [
    state.accountId || "",
    state.folderId || "",
    state.query,
    state.emails.map((email) => (email && email.id) || "").join("\n"),
  ].join("\0");
  if (motionKey !== listMotionKey) {
    listMotionKey = motionKey;
    const motion = motionApi();
    if (motion) motion.rows(list.querySelectorAll("button.message"));
  }
  const current = list.querySelector('[aria-current="true"]');
  const filtering = document.activeElement && document.activeElement.id === "list-filter";
  if (current && !filtering) current.scrollIntoView({ block: "nearest" });
}

function snoozedUntilOf(email) {
  if (!email) return "";
  return state.snoozed.get(email.threadId || email.id) || "";
}

function option(value, text) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}

const READER_ICON = {
  reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  "reply-all": "M7 8V5l-7 7 7 7v-3l-4-4 4-4zm6 1V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  forward: "M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z",
  star: "m12 3.2 2.47 5.01 5.53.8-4 3.9.94 5.5L12 15.9l-4.94 2.51.94-5.5-4-3.9 5.53-.8L12 3.2z",
  archive: "M4 4h16v3H4V4zm1 5h14v10H5V9zm4 2v2h6v-2H9z",
  trash: "M9 3h6l1 2h4v2H4V5h4l1-2zm-2 6h10l-.8 12H7.8L7 9zm3 2v8h2v-8H10zm4 0v8h2v-8h-2z",
  organize: "M3 6h7l2 2h9v11H3V6z",
  move: "M3 6h7l2 2h9v11H3V6z",
};

function readerIcon(name) {
  const d = READER_ICON[name];
  if (!d) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

function readerButton(action, label, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost icon-btn";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  const icon = readerIcon(action);
  if (icon) button.appendChild(icon);
  const text = document.createElement("span");
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener("click", () => guard(run));
  return button;
}

function renderActions(pane, email) {
  const bar = document.createElement("div");
  bar.className = "reader-actions";
  const star = readerButton("star", email.isStarred ? "Unstar" : "Star", () => toggleStar(email));
  star.setAttribute("aria-pressed", email.isStarred ? "true" : "false");
  const archive = readerButton("archive", "Archive", () => archiveOpen(email));
  const trash = readerButton("trash", "Trash", () => trashOpen(email));
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const move = readerButton("move", "Move", () => openMessageMovePicker(email, "imap"));
  move.setAttribute("aria-label", "Move to folder");
  let snooze = null;
  if (state.prefs.snooze !== false) {
    snooze = document.createElement("select");
    snooze.dataset.action = "snooze";
    snooze.setAttribute("aria-label", "Snooze");
    const until = snoozedUntilOf(email);
    snooze.append(option("", until ? "Snoozed" : "Snooze"));
    if (until) snooze.append(option("clear", "Unsnooze"));
    snooze.append(option("1h", "1 hour"), option("tonight", "Tonight"), option("morning", "Tomorrow morning"));
    snooze.addEventListener("change", () => {
      const preset = snooze.value;
      snooze.value = "";
      if (!preset) return;
      guard(() => (preset === "clear" ? unsnoozeOpen(email) : snoozeOpen(email, preset)));
    });
  }
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  const reply = readerButton("reply", "Reply", () => openCompose(composeSeed(email, "reply", self)));
  const replyAll = readerButton("reply-all", "Reply All", () => openCompose(composeSeed(email, "all", self)));
  const forward = readerButton("forward", "Forward", () => openCompose(composeSeed(email, "forward", self)));
  const menus = document.createElement("div");
  menus.className = "reader-menus";
  menus.append(move, organizeButton(email));
  if (snooze) menus.append(snooze);
  bar.append(reply, replyAll, forward, star, archive, trash, menus);
  appendLabelActions(bar, email);
  pane.appendChild(bar);
}

function indentedName(folder) {
  const depth = folder && folder.depth ? folder.depth : 0;
  const text = (folder && (folder.label || folder.name || folder.id)) || "";
  if (!depth) return text;
  return "\u00A0".repeat(depth * 2) + text;
}

function providerMark(provider) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("provider-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", provider === "outlook"
    ? "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
    : "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z");
  svg.appendChild(path);
  return svg;
}

function organizeButton(email) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost icon-btn";
  button.dataset.action = "organize";
  button.setAttribute("aria-label", "Organize");
  button.setAttribute("aria-haspopup", "menu");
  button.title = "Organize";
  const icon = readerIcon("organize");
  if (icon) button.appendChild(icon);
  const text = document.createElement("span");
  text.textContent = "Organize";
  button.appendChild(text);
  button.addEventListener("click", () => {
    const rect = button.getBoundingClientRect();
    openOrganizeMenu(email, rect.left, rect.bottom + 4);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openOrganizeMenu(email, event.clientX, event.clientY);
  });
  return button;
}

function appendLabelActions(bar, email) {
  const payload = state.providerFolders;
  if (!payload || payload.accountId !== email.accountId) return;
  const view = providerFolderState(payload);
  if (view.mode !== "live") return;
  const labels = providerLabelTree(view.folders);
  if (payload.source === "gmail" || payload.provider === "google") {
    const editable = labels.filter((folder) => folder.editable);
    bar.append(labelSelect("Add Gmail label", "Add label", editable, (id) => changeLabels(email, [id], [])));
    bar.append(labelSelect("Remove Gmail label", "Remove label", editable, (id) => changeLabels(email, [], [id])));
    return;
  }
  if (payload.source === "graph" || payload.provider === "microsoft") {
    const outlookMove = document.createElement("button");
    outlookMove.type = "button";
    outlookMove.className = "ghost";
    outlookMove.dataset.action = "move-outlook";
    outlookMove.setAttribute("aria-label", "Move in Outlook");
    outlookMove.textContent = "Move in Outlook";
    outlookMove.addEventListener("click", () => openMessageMovePicker(email, "outlook"));
    bar.append(outlookMove);
  }
}

function labelSelect(aria, placeholder, folders, run) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", aria);
  select.append(option("", placeholder));
  for (const folder of folders) select.append(option(folder.id, indentedName(folder)));
  select.addEventListener("change", () => {
    const id = select.value;
    select.value = "";
    if (!id) return;
    guard(() => run(id));
  });
  return select;
}

function renderSuggestions(pane, email) {
  const box = document.createElement("div");
  box.className = "suggestions";
  box.setAttribute("aria-label", "Reply suggestions");
  const status = document.createElement("p");
  status.className = "hint";
  status.dataset.role = "suggest-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  const list = document.createElement("div");
  list.className = "suggest-list";
  box.append(status, list);
  pane.appendChild(box);
  const cached = state.suggestions;
  const same = cached && cached.emailId === email.id;
  if (!same || (cached.error && !cached.pending)) {
    state.suggestions = { emailId: email.id, items: [], error: "", pending: true };
    loadSuggestions(email);
  }
  paintSuggestions(email);
}

async function loadSuggestions(email) {
  const gen = suggestGen += 1;
  const id = email.id;
  try {
    const data = await call("aiDraftWrite:replySuggestions", { email: suggestionEmail(email) });
    if (gen !== suggestGen || !state.email || state.email.id !== id) return;
    state.suggestions = { emailId: id, items: suggestionItems(data), error: "", pending: false };
  } catch (error) {
    if (gen !== suggestGen || !state.email || state.email.id !== id) return;
    state.suggestions = {
      emailId: id,
      items: [],
      error: error instanceof Error ? error.message : String(error),
      pending: false,
    };
  }
  if (state.email && state.email.id === id) paintSuggestions(state.email);
}

function paintSuggestions(email) {
  const box = $("reader").querySelector(".suggestions");
  if (!box) return;
  const view = state.suggestions;
  const active = !!(email && view && view.emailId === email.id);
  const status = box.querySelector("[data-role='suggest-status']");
  const list = box.querySelector(".suggest-list");
  if (!status || !list) return;
  list.replaceChildren();
  if (!active) {
    box.hidden = true;
    return;
  }
  if (view.pending) {
    box.hidden = false;
    status.hidden = false;
    status.className = "hint";
    status.textContent = "Suggesting replies…";
    return;
  }
  if (view.error) {
    box.hidden = false;
    status.hidden = false;
    status.className = "hint error";
    status.textContent = view.error;
    return;
  }
  status.hidden = true;
  status.textContent = "";
  if (!view.items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  for (const text of view.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = text;
    button.addEventListener("click", () => {
      openCompose(withSuggestion(composeSeed(email, "reply", self), text))
        .catch((error) => showStatus(error.message, true));
    });
    list.appendChild(button);
  }
}

function renderReader(focus) {
  const pane = $("reader");
  const email = state.email;
  if (state.translate && (!email || state.translate.emailId !== email.id)) {
    stopTranslate();
    state.translate = null;
  }
  pane.replaceChildren();
  if (!email) {
    const wrap = document.createElement("div");
    wrap.className = "empty-read";
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("class", "empty-mark");
    mark.setAttribute("viewBox", "0 0 24 24");
    mark.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", "M4 7h16v11H4V7Zm0 0 8 6 8-6");
    mark.appendChild(path);
    const title = document.createElement("p");
    title.className = "empty-title";
    const hint = document.createElement("p");
    hint.className = "empty";
    if (!state.accounts.length) {
      title.textContent = "No mailbox yet";
      hint.textContent = "Connect an account to see your mail.";
      wrap.append(mark, title, hint, connectButton());
    } else {
      title.textContent = "No conversation selected";
      hint.textContent = "Select a conversation to read.";
      wrap.append(mark, title, hint);
    }
    pane.appendChild(wrap);
    return;
  }
  renderActions(pane, email);
  renderSuggestions(pane, email);
  const heading = document.createElement("h2");
  heading.textContent = email.subject || "(no subject)";
  const from = document.createElement("p");
  from.className = "meta";
  from.textContent = email.from || "";
  const when = document.createElement("p");
  when.className = "meta";
  const date = email.date ? new Date(email.date) : null;
  when.textContent = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "";
  pane.append(heading, from, when);
  const until = snoozedUntilOf(email);
  const untilDate = until ? new Date(until) : null;
  if (state.prefs.snooze !== false && untilDate && !Number.isNaN(untilDate.getTime())) {
    const snooze = document.createElement("p");
    snooze.className = "meta";
    snooze.textContent = `Snoozed until ${untilDate.toLocaleString()}`;
    pane.appendChild(snooze);
  }
  for (const [label, value] of [["To", email.to], ["Cc", email.cc]]) {
    const text = people(value);
    if (!text) continue;
    const line = document.createElement("p");
    line.className = "meta";
    line.textContent = `${label} ${text}`;
    pane.appendChild(line);
  }
  renderThread(pane, email);
  renderAttachments(pane, email);
  renderTranslate(pane, email);
  renderRemoteGate(pane, email);
  renderBody(pane, email);
  const translated = document.createElement("div");
  translated.className = "translation";
  translated.setAttribute("role", "status");
  translated.hidden = true;
  pane.appendChild(translated);
  paintTranslation();
  if (focus) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function appendMessageBody(parent, email, imagesOn) {
  const wrap = document.createElement("div");
  wrap.className = "body";
  for (const node of bodyNodes(readable(email))) {
    const block = document.createElement("p");
    block.dataset.nodeId = node.node_id;
    block.textContent = node.text;
    wrap.appendChild(block);
  }
  if (imagesOn) {
    for (const image of remoteImageSrcs(email && email.htmlBody)) {
      const img = document.createElement("img");
      img.className = "remote";
      img.alt = image.alt;
      img.referrerPolicy = "no-referrer";
      img.src = image.src;
      wrap.appendChild(img);
    }
  }
  parent.appendChild(wrap);
  return wrap;
}

function renderBody(pane, email) {
  const allowed = !!(email && state.remoteAllowed && state.remoteAllowed[email.id]);
  appendMessageBody(pane, email, remoteVisible(state.prefs.images, allowed));
}

function renderRemoteGate(pane, email) {
  const images = remoteImageSrcs(email && email.htmlBody);
  const allowed = !!(email && state.remoteAllowed && state.remoteAllowed[email.id]);
  if (!images.length || remoteVisible(state.prefs.images, allowed)) return;
  const bar = document.createElement("div");
  bar.className = "remote-gate";
  const note = document.createElement("p");
  note.textContent = images.length === 1
    ? "1 remote image is blocked."
    : `${images.length} remote images are blocked.`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.dataset.action = "remote";
  button.textContent = "Load remote content";
  button.addEventListener("click", () => {
    state.remoteAllowed[email.id] = true;
    renderReader(false);
  });
  bar.append(note, button);
  pane.appendChild(bar);
}

function renderTranslate(pane, email) {
  const bar = document.createElement("div");
  bar.className = "translate";
  const select = document.createElement("select");
  select.dataset.action = "translate-lang";
  select.setAttribute("aria-label", "Translate into");
  for (const lang of TRANSLATE_LANGS) select.append(option(lang, lang));
  select.value = state.translateLang || "English";
  select.addEventListener("change", () => {
    state.translateLang = select.value;
  });
  const go = document.createElement("button");
  go.type = "button";
  go.className = "ghost";
  go.dataset.action = "translate";
  go.textContent = "Translate";
  go.addEventListener("click", () => {
    startTranslate(email).catch((error) => showStatus(error.message, true));
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.dataset.action = "translate-cancel";
  cancel.textContent = "Cancel";
  cancel.hidden = true;
  cancel.addEventListener("click", () => {
    cancelTranslate().catch((error) => showStatus(error.message, true));
  });
  bar.append(select, go, cancel);
  pane.appendChild(bar);
}

function paintTranslation() {
  const box = $("reader").querySelector(".translation");
  const view = state.translate;
  const email = state.email;
  const active = !!(view && email && view.emailId === email.id);
  const cancel = $("reader").querySelector("[data-action='translate-cancel']");
  const go = $("reader").querySelector("[data-action='translate']");
  if (cancel) cancel.hidden = !(active && view.pending);
  if (go) go.disabled = !!(active && view.pending);
  if (!box) return;
  box.replaceChildren();
  if (!active) {
    box.hidden = true;
    return;
  }
  const text = translationText(view);
  const show = !!(view.pending || view.error || text);
  box.hidden = !show;
  if (!show) return;
  if (view.pending) {
    const line = document.createElement("p");
    const total = view.total || view.nodes.length;
    const current = view.current || 0;
    line.textContent = total ? `Translating… ${current}/${total}` : "Translating…";
    box.appendChild(line);
  }
  if (view.error) {
    const line = document.createElement("p");
    line.className = "error";
    line.textContent = view.error;
    box.appendChild(line);
  }
  if (text) {
    const pre = document.createElement("pre");
    pre.textContent = text;
    box.appendChild(pre);
  }
}

function onTranslateEvent(event) {
  applyTranslate(state.translate, event);
  paintTranslation();
}

function stopTranslate() {
  const current = state.translate;
  if (!current || !current.pending) return;
  current.pending = false;
  call("mail:translateCancel", { reqId: current.reqId }).catch(() => {});
}

async function startTranslate(email) {
  const nodes = bodyNodes(readable(email));
  if (!nodes.length) {
    showStatus("This message has no text to translate.", true);
    return;
  }
  stopTranslate();
  const reqId = `tr-${Date.now().toString(36)}-${translateSeq += 1}`;
  const targetLanguage = state.translateLang || "English";
  state.translate = {
    reqId,
    emailId: email.id,
    nodes,
    texts: {},
    error: "",
    pending: true,
    current: 0,
    total: nodes.length,
  };
  paintTranslation();
  try {
    await call("mail:translateStart", { reqId, targetLanguage, nodes });
  } catch (error) {
    if (!state.translate || state.translate.reqId !== reqId) return;
    state.translate.pending = false;
    state.translate.error = error instanceof Error ? error.message : String(error);
    paintTranslation();
  }
}

async function cancelTranslate() {
  const current = state.translate;
  if (!current || !current.pending) return;
  const reqId = current.reqId;
  current.pending = false;
  paintTranslation();
  await call("mail:translateCancel", { reqId });
}

function renderThread(pane, email) {
  if (state.prefs.conversation === false) return;
  const members = state.thread.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  if (members.length < 2) return;
  const list = document.createElement("div");
  list.className = "thread";
  list.setAttribute("aria-label", `${members.length} messages in this conversation`);
  for (const member of members) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-item";
    if (member.id === email.id) button.setAttribute("aria-current", "true");
    const who = document.createElement("span");
    who.textContent = `${senderName(member.from)} — ${member.subject || "(no subject)"}`;
    const when = document.createElement("time");
    when.className = "when";
    if (member.date) when.dateTime = member.date;
    when.textContent = listWhen(member.date);
    button.append(who, when);
    button.addEventListener("click", () => {
      if (member.id === email.id) return;
      openMessage(member.id).catch((error) => showStatus(error.message, true));
    });
    list.appendChild(button);
  }
  pane.appendChild(list);
}

function renderAttachments(pane, email) {
  const files = (email.attachments || []).filter((item) => item && (item.filename || item.id));
  if (!files.length) {
    if (!email.hasAttachments) return;
    const note = document.createElement("p");
    note.className = "meta";
    note.textContent = "This message has attachments.";
    pane.appendChild(note);
    return;
  }
  const list = document.createElement("ul");
  list.className = "attachments";
  for (const file of files) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const size = fileSize(file.size);
    const label = file.filename || "attachment";
    name.textContent = size ? `${label} (${size})` : label;
    item.appendChild(name);
    if (file.id) {
      const save = document.createElement("button");
      save.type = "button";
      save.className = "ghost";
      save.textContent = "Save";
      save.setAttribute("aria-label", `Save ${label}`);
      save.addEventListener("click", () => guard(() => useAttachment("mail:downloadAttachment", email, file)));
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ghost";
      open.textContent = "Open";
      open.setAttribute("aria-label", `Open ${label}`);
      open.addEventListener("click", () => guard(() => useAttachment("mail:openAttachmentExternally", email, file)));
      item.append(save, open);
    }
    list.appendChild(item);
  }
  pane.appendChild(list);
}

async function useAttachment(channel, email, file) {
  try {
    await call(channel, {
      emailId: email.id,
      messageId: email.id,
      attachmentId: file.id,
      filename: file.filename,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "cancelled") return;
    throw error;
  }
  showStatus(channel === "mail:downloadAttachment" ? "Saved." : "Opened.");
}

function showUndo(text, opIds) {
  undoOpIds = opIds && opIds.length ? opIds.slice() : null;
  $("undo").hidden = !undoOpIds;
  showStatus(text);
}

function clearUndo() {
  undoOpIds = null;
  $("undo").hidden = true;
}

function focusAction(name) {
  const control = $("reader").querySelector(`[data-action="${name}"]`);
  if (control) control.focus();
}

async function toggleStar(email) {
  const isStarred = !email.isStarred;
  await call("mail:toggleStar", { emailId: email.id, accountId: email.accountId, isStarred });
  email.isStarred = isStarred;
  const row = state.emails.find((item) => item.id === email.id);
  if (row) row.isStarred = isStarred;
  renderList();
  renderReader(false);
  focusAction("star");
}

async function setRead(email, isRead) {
  await call("mail:markRead", { emailId: email.id, accountId: email.accountId, isRead });
  email.unread = !isRead;
  email.isRead = isRead;
  if (state.email && state.email.id === email.id) {
    state.email.unread = email.unread;
    state.email.isRead = email.isRead;
  }
  renderList();
}

async function deleteFromList(email) {
  await finishRemoval(email, "Moved to Trash.", await call("mail:delete", removalPayload(email, false)));
}

async function replyFromList(email, kind) {
  let opened = state.email && state.email.id === email.id ? state.email : null;
  if (!opened) {
    const data = await call("mail:openEmail", { emailId: email.id });
    opened = data && data.email;
  }
  if (!opened) throw new Error("That message is no longer in the mailbox.");
  const account = state.accounts.find((item) => item.id === opened.accountId) || selectedAccount();
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  await openCompose(composeSeed(opened, kind, self));
}

async function finishRemoval(email, label, data) {
  const opIds = data && Array.isArray(data.opIds) ? data.opIds.filter(Boolean) : [];
  if (state.email && state.email.id === email.id) {
    state.email = null;
    state.thread = [];
  }
  renderReader(false);
  if (opIds.length) showUndo(label, opIds);
  else {
    clearUndo();
    showStatus(label);
  }
  await loadList();
}

async function removeOpen(email, channel, label) {
  const threaded = channel === "mail:threadArchive" || channel === "mail:threadTrash";
  await finishRemoval(email, label, await call(channel, removalPayload(email, threaded)));
}

async function archiveOpen(email) {
  const threaded = usesThread(email, state.thread);
  await removeOpen(email, threaded ? "mail:threadArchive" : "mail:archive", "Archived.");
}

async function trashOpen(email) {
  const threaded = usesThread(email, state.thread);
  await removeOpen(email, threaded ? "mail:threadTrash" : "mail:delete", "Moved to Trash.");
}

function folderTitle(folders, id) {
  const rows = Array.isArray(folders) ? folders : [];
  const found = rows.find((folder) => folder && String(folder.id) === String(id));
  if (!found) return String(id || "that folder");
  return String(found.name || found.label || found.id);
}

async function confirmRelocation(channel, email, target) {
  if (!confirmsBefore(channel)) return true;
  const answer = await askConfirm(actionConfirm("move", {
    subject: email && email.subject,
    target: target,
    channel: channel === "mail:moveProviderMessage" ? "outlook" : "imap",
    provider: channel === "mail:moveProviderMessage" ? "outlook" : "",
  }));
  return !!(answer && answer.ok);
}

async function moveOpen(email, targetFolderId) {
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const target = folderTitle(foldersOf(account), targetFolderId);
  if (!(await confirmRelocation("mail:moveToFolder", email, target))) return;
  await finishRemoval(email, "Moved.", await call("mail:moveToFolder", {
    emailId: email.id,
    accountId: email.accountId,
    targetFolderId,
    folderId: email.folderId,
  }));
}

async function undoRemoval() {
  const opIds = undoOpIds;
  if (!opIds || !opIds.length) return;
  clearUndo();
  await call("mail:undoRemoval", { opIds, kind: "move" });
  showStatus("Undone.");
  await loadList();
}

async function snoozeOpen(email, preset) {
  const threadId = email.threadId || email.id;
  const snoozedUntil = snoozeUntil(preset, new Date()).toISOString();
  const data = await call("mail:snoozeThread", { accountId: email.accountId, threadId, snoozedUntil });
  state.snoozed.set(threadId, (data && data.snoozedUntil) || snoozedUntil);
  const when = new Date(state.snoozed.get(threadId));
  showStatus(Number.isNaN(when.getTime()) ? "Snoozed." : `Snoozed until ${when.toLocaleString()}.`);
  await loadList();
  renderReader(false);
  focusAction("snooze");
}

async function unsnoozeOpen(email) {
  const threadId = email.threadId || email.id;
  await call("mail:unsnoozeThread", { accountId: email.accountId, threadId });
  state.snoozed.delete(threadId);
  showStatus("Unsnoozed.");
  await loadList();
  renderReader(false);
  focusAction("snooze");
}

async function loadSnoozed() {
  const account = selectedAccount();
  if (!account) {
    state.snoozed = new Map();
    return;
  }
  try {
    const data = await call("mail:listSnoozed", { accountId: account.id });
    const records = data && Array.isArray(data.records) ? data.records : [];
    const next = new Map();
    for (const row of records) {
      if (row && row.threadId) next.set(row.threadId, row.snoozedUntil || "snoozed");
    }
    state.snoozed = next;
  } catch {
    // Keep the marks already shown when this account has no snooze list.
  }
}

function rememberSelection(preferredId) {
  if (preferredId && state.accounts.some((account) => account.id === preferredId)) {
    state.accountId = preferredId;
  }
  if (!state.accounts.some((account) => account.id === state.accountId)) {
    const first = state.accounts[0];
    state.accountId = first ? first.id : null;
    const inbox = first ? inboxOf(first) : null;
    state.folderId = inbox ? inbox.id : null;
    state.email = null;
    state.thread = [];
    return;
  }
  if (!foldersOf(selectedAccount()).some((folder) => folder.id === state.folderId)) {
    const inbox = inboxOf(selectedAccount());
    state.folderId = inbox ? inbox.id : null;
    state.email = null;
    state.thread = [];
  }
}

async function loadList(fromNetwork) {
  const gen = ++listGen;
  if (state.query) {
    const data = await call("mail:searchLocal", { query: state.query, limit: 100 });
    if (gen !== listGen) return null;
    state.emails = Array.isArray(data) ? data : [];
    renderList();
    return null;
  }
  const account = selectedAccount();
  if (!account || !state.folderId) {
    state.emails = [];
    renderList();
    return null;
  }
  const channel = fromNetwork && isLive(account) ? "mail:listFromNetwork" : "mail:listFromCache";
  const data = await call(channel, {
    accountId: account.id,
    folderId: state.folderId,
    limit: 500,
  });
  if (gen !== listGen) return data;
  state.emails = (data && data.emails) || [];
  if (data && data.sync) state.sync = Object.assign({ accountId: account.id }, data.sync);
  renderList();
  return data;
}

async function loadAccounts(preferredId) {
  const gen = ++accountGen;
  const data = await call("mail:listAccounts");
  if (gen !== accountGen) return;
  state.accounts = Array.isArray(data) ? data : [];
  rememberSelection(preferredId);
  renderAccounts();
  renderBanner();
  syncRemove();
  await loadSnoozed();
  if (gen !== accountGen) return;
  await loadList();
  if (gen !== accountGen) return;
  await loadProviderFolders(gen);
  if (gen !== accountGen) return;
  renderReader(false);
}

async function loadProviderFolders(gen) {
  const account = selectedAccount();
  if (!isLive(account)) {
    state.providerFolders = null;
    renderAccounts();
    return;
  }
  const requestId = account.id;
  try {
    const payload = await call("mail:listProviderFolders", { accountId: requestId });
    if (gen !== accountGen || state.accountId !== requestId) return;
    state.providerFolders = { ...(payload || {}), accountId: requestId };
  } catch (error) {
    if (gen !== accountGen || state.accountId !== requestId) return;
    state.providerFolders = {
      accountId: requestId,
      api: false,
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
      folders: [],
    };
  }
  renderAccounts();
}

async function grantOrganize() {
  const account = selectedAccount();
  if (!isLive(account)) throw new Error("Connect a Google or Microsoft mailbox first.");
  showStatus("Waiting for the mail API consent…");
  await call("mail:grantOrganize", { accountId: account.id });
  showStatus("Mail API connected.");
  await loadProviderFolders(accountGen);
}

async function createProviderFolder(name, parentId) {
  await call("mail:createProviderFolder", { accountId: state.accountId, name, parentId: parentId || "" });
  showStatus("Saved on the provider.");
  await loadProviderFolders(accountGen);
}

async function renameProviderFolder(folderId, name) {
  await call("mail:renameProviderFolder", { accountId: state.accountId, folderId, name });
  showStatus("Saved on the provider.");
  await loadProviderFolders(accountGen);
}

async function deleteProviderFolder(folderId) {
  await call("mail:deleteProviderFolder", { accountId: state.accountId, folderId });
  showStatus("Removed on the provider.");
  await loadProviderFolders(accountGen);
}

async function confirmRenameFolder(folder, provider) {
  const name = String((folder && folder.name) || "");
  if (confirmsBefore("mail:renameProviderFolder")) {
    const answer = await askConfirm(actionConfirm("rename", { provider: provider, name: name }));
    if (!answer || !answer.ok) return;
    const next = String(answer.name || "").trim();
    if (!next) return;
    if (next === name.trim()) {
      showStatus("Name is unchanged.");
      return;
    }
    await renameProviderFolder(folder.id, next);
    return;
  }
  await renameProviderFolder(folder.id, name);
}

async function confirmDeleteFolder(folder, provider) {
  const name = String((folder && (folder.name || folder.id)) || "");
  if (confirmsBefore("mail:deleteProviderFolder")) {
    const answer = await askConfirm(actionConfirm("delete", { provider: provider, name: name }));
    if (!answer || !answer.ok) return;
  }
  await deleteProviderFolder(folder.id);
}

async function changeLabels(email, addLabelIds, removeLabelIds) {
  await call("mail:modifyMessageLabels", {
    accountId: email.accountId,
    emailId: email.id,
    addLabelIds,
    removeLabelIds,
  });
  showStatus(addLabelIds.length ? "Label added in Gmail." : "Label removed in Gmail.");
}

async function moveOutlook(email, destinationId) {
  const payload = state.providerFolders;
  const folders = payload && Array.isArray(payload.folders) ? payload.folders : [];
  const target = folderTitle(folders, destinationId);
  if (!(await confirmRelocation("mail:moveProviderMessage", email, target))) return;
  await call("mail:moveProviderMessage", {
    accountId: email.accountId,
    emailId: email.id,
    destinationId,
  });
  showStatus("Moved in Outlook.");
  if (isLive(selectedAccount())) await loadList(true);
}

function ensureOrganizeMenu() {
  let menu = $("organize-menu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "organize-menu";
  menu.className = "organize-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Move and labels");
  document.body.appendChild(menu);
  return menu;
}

function closeOrganizeMenu() {
  const menu = $("organize-menu");
  if (!menu) return;
  menu.hidden = true;
  menu.dataset.open = "";
  menu.replaceChildren();
}

function appendMenuGroup(menu, title, items, run) {
  if (!items || !items.length) return;
  const heading = document.createElement("h3");
  heading.textContent = title;
  menu.appendChild(heading);
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menuitem";
    button.setAttribute("role", "menuitem");
    button.style.paddingLeft = (12 + (item.depth || 0) * 14) + "px";
    button.textContent = item.label || item.name || item.id;
    button.title = item.name || item.label || item.id;
    button.addEventListener("click", () => {
      closeOrganizeMenu();
      guard(() => run(item));
    });
    menu.appendChild(button);
  }
}

function placeMenu(menu, x, y) {
  menu.hidden = false;
  menu.dataset.open = "";
  menu.style.left = "8px";
  menu.style.top = "8px";
  const rect = menu.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = Math.min(Math.max(8, x), maxX) + "px";
  menu.style.top = Math.min(Math.max(8, y), maxY) + "px";
  setTimeout(() => {
    if (menu.hidden) return;
    menu.dataset.open = "1";
    const first = menu.querySelector("[role='menuitem']");
    if (first) first.focus();
  }, 0);
}

function focusProviderCreate() {
  const input = document.querySelector("#provider-folders .provider-create input");
  if (!input) return;
  input.focus();
  if (input.scrollIntoView) input.scrollIntoView({ block: "nearest" });
}

function appendFolderMenuItem(menu, item, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menuitem";
  button.setAttribute("role", "menuitem");
  if (item.disabled) {
    button.disabled = true;
    button.title = item.reason || item.label;
    const label = document.createElement("span");
    label.textContent = item.label;
    button.appendChild(label);
    if (item.reason) {
      const reason = document.createElement("span");
      reason.className = "menu-reason";
      reason.textContent = item.reason;
      button.appendChild(reason);
    }
  } else {
    button.textContent = item.label;
    button.addEventListener("click", () => {
      closeOrganizeMenu();
      run(item);
    });
  }
  menu.appendChild(button);
}

function strokeIcon(shapes, size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of shapes) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const MOVE_CHEVRON_RIGHT = "M9 18l6-6-6-6";
const MOVE_CHEVRON_DOWN = "M6 9l6 6 6-6";
const MOVE_FOLDER = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";

let moveSession = null;

function moveRowKey(id) {
  return id ? "id:" + id : "root";
}

function accountForMove(accountId) {
  return state.accounts.find((account) => account.id === accountId) || selectedAccount();
}

function openMoveSession(session) {
  const parents = new Set();
  for (const node of session.nodes) {
    if (node.parentId) parents.add(node.parentId);
  }
  session.expanded = parents;
  session.query = "";
  session.activeKey = "";
  session.animated = false;
  moveSession = session;
  $("move-picker-title").textContent = session.title;
  const source = $("move-picker-source");
  if (session.purpose === "message") source.textContent = "Message: " + (session.sourceName || "this message");
  else source.textContent = (session.kind === "gmail" ? "Label: " : "Folder: ") + (session.sourcePath || session.sourceName || "");
  $("move-picker-filter").value = "";
  paintMoveTree();
  if (!$("move-picker").open) openDialog("move-picker");
  setTimeout(() => {
    const input = $("move-picker-filter");
    if (input && $("move-picker").open) input.focus();
  }, 0);
}

function openRelocatePicker(kind, folder, account, folders, delimiter) {
  const nodes = moveNodesFromFolders(kind, folders, delimiter);
  const source = nodes.find((node) => node.id === String(folder.id));
  if (!source) {
    showStatus(kind === "gmail" ? "That label is not in this list." : "That folder is not in this list.", true);
    return;
  }
  openMoveSession({
    purpose: "relocate",
    kind: kind,
    title: kind === "gmail" ? "Move label" : "Move folder",
    accountId: account.id,
    sourceId: source.id,
    sourceName: source.label || source.name,
    sourcePath: source.path || source.name,
    source: source,
    delimiter: delimiter || "/",
    nodes: nodes,
  });
}

function openMessageMovePicker(email, kind) {
  if (!email) return;
  const account = accountForMove(email.accountId);
  if (!account) return;
  if (kind === "outlook") {
    const payload = providerPayloadFor(account);
    const view = providerFolderState(payload);
    if (view.mode !== "live") {
      showStatus((payload && payload.message) || providerCopy(view.reason, "outlook"), true);
      return;
    }
    openMoveSession({
      purpose: "message",
      kind: "outlook",
      title: "Move to folder",
      accountId: account.id,
      sourceId: "",
      sourceName: email.subject || "Message",
      sourcePath: email.subject || "Message",
      source: { id: "", name: "", label: "" },
      email: email,
      delimiter: "/",
      nodes: moveNodesFromFolders("outlook", view.folders, "/"),
    });
    return;
  }
  const delimiter = accountDelimiter(account);
  openMoveSession({
    purpose: "message",
    kind: "imap",
    title: "Move to folder",
    accountId: account.id,
    sourceId: email.folderId || "",
    sourceName: email.subject || "Message",
    sourcePath: email.subject || "Message",
    source: { id: email.folderId || "", name: "", label: "" },
    email: email,
    delimiter: delimiter,
    nodes: moveNodesFromFolders("imap", foldersOf(account), delimiter),
  });
}

function moveRowsFor(session) {
  const filtering = !!String(session.query || "").trim();
  const flags = session.purpose === "message"
    ? messageTargetFlags(session.nodes, session.sourceId)
    : moveTargetFlags(session.nodes, session.sourceId, session.kind, session.delimiter);
  const filtered = filterMoveNodes(flags.nodes, session.query);
  const visible = visibleMoveNodes(filtered, session.expanded, filtering);
  const rows = [];
  if (session.purpose !== "message" && showMoveRoot(session.query)) {
    rows.push({
      key: "root",
      isRoot: true,
      id: "",
      label: "(Top level / root)",
      path: "(Top level / root)",
      depth: 0,
      disabled: flags.root.disabled,
      reason: flags.root.reason,
      hasChild: false,
      expanded: false,
      match: false,
    });
  }
  for (const node of visible) {
    let hasChild = false;
    for (const other of session.nodes) {
      if (other.parentId === node.id) {
        hasChild = true;
        break;
      }
    }
    rows.push({
      key: moveRowKey(node.id),
      isRoot: false,
      id: node.id,
      label: node.label || node.name,
      path: node.path || node.name,
      name: node.name,
      depth: node.depth || 0,
      disabled: node.disabled,
      reason: node.reason,
      hasChild: hasChild,
      expanded: filtering || session.expanded.has(node.id),
      match: !!node.match,
    });
  }
  return rows;
}

function activeMoveTarget(session) {
  if (!session) return null;
  const rows = moveRowsFor(session);
  return rows.find((row) => row.key === session.activeKey) || null;
}

function paintMoveTree() {
  const session = moveSession;
  const tree = $("move-picker-tree");
  const preview = $("move-picker-preview");
  const ok = $("move-picker-ok");
  if (!session || !tree) return;
  const rows = moveRowsFor(session);
  if (!rows.some((row) => row.key === session.activeKey)) {
    const enabled = rows.find((row) => !row.disabled);
    session.activeKey = enabled ? enabled.key : (rows[0] ? rows[0].key : "");
  }
  const active = rows.find((row) => row.key === session.activeKey) || null;
  tree.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "move-empty";
    empty.textContent = "No matching labels or folders.";
    tree.appendChild(empty);
  }
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "move-row";
    line.style.paddingLeft = (6 + row.depth * 16) + "px";
    if (row.hasChild) {
      const twist = document.createElement("button");
      twist.type = "button";
      twist.className = "twist";
      twist.setAttribute("aria-label", (row.expanded ? "Collapse " : "Expand ") + row.label);
      twist.setAttribute("aria-expanded", row.expanded ? "true" : "false");
      twist.appendChild(strokeIcon([row.expanded ? MOVE_CHEVRON_DOWN : MOVE_CHEVRON_RIGHT], 14));
      twist.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!moveSession) return;
        if (moveSession.expanded.has(row.id)) moveSession.expanded.delete(row.id);
        else moveSession.expanded.add(row.id);
        paintMoveTree();
      });
      line.appendChild(twist);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "twist-spacer";
      spacer.setAttribute("aria-hidden", "true");
      line.appendChild(spacer);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "move-node";
    if (row.match) button.classList.add("match");
    button.dataset.key = row.key;
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-selected", row.key === session.activeKey ? "true" : "false");
    if (row.disabled) {
      button.setAttribute("aria-disabled", "true");
      button.title = row.reason || "";
    }
    button.appendChild(strokeIcon([MOVE_FOLDER], 15));
    const text = document.createElement("span");
    text.textContent = row.label;
    button.appendChild(text);
    button.addEventListener("click", () => {
      if (!moveSession) return;
      moveSession.activeKey = row.key;
      paintMoveTree();
    });
    line.appendChild(button);
    tree.appendChild(line);
  }
  preview.textContent = movePreviewLine(session, active);
  ok.disabled = !active || active.disabled;
  const current = tree.querySelector('[aria-selected="true"]');
  if (current && current.scrollIntoView) current.scrollIntoView({ block: "nearest" });
  if (!session.animated) {
    session.animated = true;
    const motion = motionApi();
    if (motion) motion.rows(tree.querySelectorAll(".move-node"));
  }
}

function closeMovePicker() {
  moveSession = null;
  const dialog = $("move-picker");
  if (dialog && dialog.open) dialog.close();
}

function finishMovePick() {
  const session = moveSession;
  const target = activeMoveTarget(session);
  if (!session || !target || target.disabled) return;
  closeMovePicker();
  if (session.purpose === "message") {
    if (session.bulk && session.emails && session.emails.length) {
      const emails = session.emails.slice();
      const kind = session.kind;
      const id = target.id;
      const name = target.path || target.label || target.name;
      guard(() => applyPickedMove(emails, kind, id, name));
      return;
    }
    guard(() => (session.kind === "outlook"
      ? moveOutlook(session.email, target.id)
      : moveOpen(session.email, target.id)));
    return;
  }
  guard(() => commitFolderMove(session, target));
}

async function commitFolderMove(session, target) {
  const channel = session.kind === "imap" ? "mail:moveFolder" : "mail:moveProviderFolder";
  const params = {
    accountId: session.accountId,
    folderId: session.sourceId,
    destinationId: target && target.isRoot ? "" : (target && target.id) || "",
  };
  const answer = confirmsBefore(channel)
    ? await askConfirm(actionConfirm("move-label", {
      provider: session.kind,
      name: session.sourcePath || session.sourceName,
      destination: target && target.isRoot ? "(Top level / root)" : (target.path || target.label || target.name),
    }))
    : { ok: true };
  const request = moveRequestAfterConfirm(channel, answer, params);
  if (!request) return;
  if (session.kind === "imap") {
    const data = await call("mail:moveFolder", request);
    const next = relocatedFolderId(state.folderId, data && data.renames);
    if (next) state.folderId = next;
    if (data && data.warning) showStatus(data.warning, true);
    else showStatus("Folder moved.");
    await loadAccounts(state.accountId);
    return;
  }
  try {
    await call("mail:moveProviderFolder", request);
    showStatus(session.kind === "outlook" ? "Folder moved." : "Label moved.");
  } finally {
    await loadProviderFolders(accountGen);
  }
}

function onMovePickerKey(event) {
  const dialog = $("move-picker");
  if (!dialog || !dialog.open || !moveSession) return;
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const rows = moveRowsFor(moveSession);
  if (!rows.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const index = rows.findIndex((row) => row.key === moveSession.activeKey);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    let next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : index + delta;
    if (next < 0) next = 0;
    if (next >= rows.length) next = rows.length - 1;
    moveSession.activeKey = rows[next].key;
    paintMoveTree();
    return;
  }
  const active = rows.find((row) => row.key === moveSession.activeKey);
  if (!active || active.isRoot || !active.hasChild) return;
  event.preventDefault();
  const open = moveSession.expanded.has(active.id);
  if (event.key === "ArrowRight" && !open) moveSession.expanded.add(active.id);
  if (event.key === "ArrowLeft" && open) moveSession.expanded.delete(active.id);
  paintMoveTree();
}

function openFolderMenu(folder, provider, x, y) {
  const model = folderActionMenu(folder, provider);
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", provider === "outlook" ? "Folder" : "Label");
  menu.replaceChildren();
  const account = selectedAccount();
  const payload = account ? providerPayloadFor(account) : null;
  const view = providerFolderState(payload);
  for (const item of model.items) {
    appendFolderMenuItem(menu, item, () => {
      if (item.id === "create") {
        focusProviderCreate();
        return;
      }
      if (item.id === "rename") {
        guard(() => confirmRenameFolder(folder, provider));
        return;
      }
      if (item.id === "move") {
        if (!account || view.mode !== "live") {
          showStatus("That list is not available.", true);
          return;
        }
        openRelocatePicker(provider, folder, account, view.folders, "/");
        return;
      }
      guard(() => confirmDeleteFolder(folder, provider));
    });
  }
  if (model.note) {
    const note = document.createElement("p");
    note.className = "organize-note";
    note.textContent = model.note;
    menu.appendChild(note);
  }
  placeMenu(menu, x, y);
}

function openImapFolderMenu(folder, account, x, y) {
  const model = imapFolderMenu(folder);
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", "Folder");
  menu.replaceChildren();
  for (const item of model.items) {
    appendFolderMenuItem(menu, item, () => {
      if (item.id !== "move") return;
      openRelocatePicker("imap", folder, account, foldersOf(account), accountDelimiter(account));
    });
  }
  placeMenu(menu, x, y);
}

function appendMenuAction(menu, label, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menuitem";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("click", () => {
    closeOrganizeMenu();
    run();
  });
  menu.appendChild(button);
}

function openOrganizeMenu(email, x, y) {
  if (!email) return;
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const provider = folderProvider(account);
  const listed = account ? providerPayloadFor(account) : null;
  const model = organizeMenu(email, foldersOf(account), listed, provider);
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", "Move and labels");
  menu.replaceChildren();
  if (model.move.length) appendMenuAction(menu, "Move to folder…", () => openMessageMovePicker(email, "imap"));
  appendMenuGroup(menu, "Add Gmail label", model.add, (item) => changeLabels(email, [item.id], []));
  appendMenuGroup(menu, "Remove Gmail label", model.remove, (item) => changeLabels(email, [], [item.id]));
  if (model.outlook.length) appendMenuAction(menu, "Move in Outlook…", () => openMessageMovePicker(email, "outlook"));
  if (model.note) {
    const note = document.createElement("p");
    note.className = "organize-note";
    note.textContent = model.note;
    menu.appendChild(note);
  }
  if (!menu.childElementCount) {
    const note = document.createElement("p");
    note.className = "organize-note";
    note.textContent = "No folders to show.";
    menu.appendChild(note);
  }
  placeMenu(menu, x, y);
}

function emailFromRow(row) {
  if (!row) return null;
  const id = row.dataset.emailId;
  const found = state.emails.find((email) => email && email.id === id);
  if (found) return found;
  if (!id || !row.dataset.accountId) return null;
  return { id, accountId: row.dataset.accountId, folderId: row.dataset.folderId || "" };
}

function dropTargetFrom(node) {
  if (!node) return null;
  const kind = node.dataset.dropKind;
  const id = node.dataset.dropId;
  if (!kind || !id) return null;
  if (kind === "imap") return { kind, id, accountId: node.dataset.dropAccount || "" };
  const provider = kind === "outlook" ? "outlook" : "gmail";
  const payload = state.providerFolders;
  const view = providerFolderState(payload);
  return {
    kind,
    id,
    accountId: (payload && payload.accountId) || "",
    api: view.mode === "live",
    reason: view.reason,
    gate: (payload && payload.message) || providerCopy(view.reason, provider),
  };
}

function refusePaused(messages) {
  if (!selectionPaused(state.sync, messages)) return false;
  showStatus("Paused for rate limit", true);
  return true;
}

async function runBulk(calls) {
  let outcome = { opIds: [], paused: false, error: "" };
  let done = 0;
  for (const spec of calls) {
    try {
      const data = await call(spec.channel, spec.params);
      outcome = collectBulkOutcome(outcome, data, null);
      done += 1;
    } catch (error) {
      outcome = collectBulkOutcome(outcome, null, error);
      break;
    }
  }
  outcome.done = done;
  return outcome;
}

async function finishBulkRemoval(label, outcome, ids) {
  const acted = Array.isArray(ids) ? ids : [];
  if (outcome.done > 0 && state.email && acted.indexOf(state.email.id) >= 0) {
    state.email = null;
    state.thread = [];
    renderReader(false);
  }
  if (outcome.done > 0) {
    state.selectedIds = [];
    state.selectionAnchor = "";
  }
  if (outcome.opIds.length) showUndo(outcome.paused ? "Paused for rate limit." : label, outcome.opIds);
  else if (outcome.paused || outcome.error) showStatus(outcome.error || "Paused for rate limit", true);
  else if (outcome.done > 0) showStatus(label);
  if (outcome.done > 0) await loadList();
}

async function bulkArchive() {
  const messages = selectedMessages().map(withSelectionMembers);
  if (!messages.length || refusePaused(messages)) return;
  const calls = bulkRemovalCalls(messages, "archive", state.prefs.conversation);
  const answer = await askConfirm(bulkConfirmCopy("archive", messages.length, {}));
  const gated = confirmedCalls("archive", answer, calls, {});
  if (!gated.length) return;
  const outcome = await runBulk(gated);
  const n = messages.length;
  await finishBulkRemoval(n === 1 ? "Archived." : "Archived " + n + " messages.", outcome, messages.map((item) => item.id));
}

async function bulkTrash() {
  const messages = selectedMessages().map(withSelectionMembers);
  if (!messages.length || refusePaused(messages)) return;
  const calls = bulkRemovalCalls(messages, "trash", state.prefs.conversation);
  const answer = await askConfirm(bulkConfirmCopy("trash", messages.length, {}));
  const gated = confirmedCalls("trash", answer, calls, {});
  if (!gated.length) return;
  const outcome = await runBulk(gated);
  const n = messages.length;
  await finishBulkRemoval(n === 1 ? "Moved to Trash." : "Moved " + n + " messages to Trash.", outcome, messages.map((item) => item.id));
}

async function bulkSetRead(isRead) {
  const messages = selectedMessages();
  if (!messages.length || refusePaused(messages)) return;
  const outcome = await runBulk(bulkFlagCalls(messages, isRead ? "read" : "unread"));
  if (outcome.error) {
    showStatus(outcome.error, true);
    return;
  }
  for (const email of messages) {
    email.unread = !isRead;
    email.isRead = isRead;
    if (state.email && state.email.id === email.id) {
      state.email.unread = email.unread;
      state.email.isRead = email.isRead;
    }
  }
  renderList();
  renderReader(false);
  showStatus(isRead ? "Marked read." : "Marked unread.");
}

async function bulkStar(isStarred) {
  const messages = selectedMessages();
  if (!messages.length || refusePaused(messages)) return;
  const outcome = await runBulk(bulkFlagCalls(messages, isStarred ? "star" : "unstar"));
  if (outcome.error) {
    showStatus(outcome.error, true);
    return;
  }
  for (const email of messages) {
    email.isStarred = isStarred;
    if (state.email && state.email.id === email.id) state.email.isStarred = isStarred;
  }
  renderList();
  renderReader(false);
  showStatus(isStarred ? "Starred." : "Unstarred.");
}

async function applySelectionLabels(label, mode) {
  const messages = selectionMoveMessages();
  if (!messages.length || !label || refusePaused(messages)) return;
  const name = label.label || label.name || label.id;
  const removes = mode === "remove" && labelRemovesFromView(state.folderId, label.id);
  const action = mode === "remove" ? "remove-label" : "add-label";
  const detail = { removesFromView: removes, label: name };
  const calls = bulkLabelCalls(messages, label.id, mode);
  let answer = { ok: true };
  if (bulkNeedsConfirm(action, detail)) {
    answer = await askConfirm(bulkConfirmCopy(action, messages.length, detail));
  }
  const gated = confirmedCalls(action, answer, calls, detail);
  if (!gated.length) return;
  const outcome = await runBulk(gated);
  if (outcome.paused || outcome.error) {
    showStatus(outcome.error || "Paused for rate limit", true);
    if (outcome.done > 0 && removes) await loadList();
    return;
  }
  showStatus(mode === "add" ? "Label added in Gmail." : "Label removed in Gmail.");
  if (removes) {
    state.selectedIds = [];
    state.selectionAnchor = "";
    if (state.email && messages.some((item) => item.id === state.email.id)) {
      state.email = null;
      state.thread = [];
      renderReader(false);
    }
    await loadList();
  }
}

function dropTargetName(target) {
  if (!target) return "that folder";
  if (target.kind === "imap") {
    const account = state.accounts.find((item) => item.id === target.accountId) || selectedAccount();
    return folderTitle(foldersOf(account), target.id);
  }
  const folders = state.providerFolders && Array.isArray(state.providerFolders.folders) ? state.providerFolders.folders : [];
  return folderTitle(folders, target.id);
}

async function applyBulkMove(messages, target, targetName) {
  const rows = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!rows.length || !target) return;
  if (refusePaused(rows)) return;
  const planned = bulkMoveCalls(rows, target);
  if (!planned.length) throw new Error(bulkMoveFailure(rows, target));
  const action = bulkDropAction(target) || "move";
  const name = targetName || dropTargetName(target);
  const detail = {
    removesFromView: action === "remove-label" && labelRemovesFromView(state.folderId, target.id),
    target: name,
    label: name,
  };
  let answer = { ok: true };
  if (bulkNeedsConfirm(action, detail)) {
    answer = await askConfirm(bulkConfirmCopy(action, callCount(planned), detail));
  }
  const gated = confirmedCalls(action, answer, planned, detail);
  if (!gated.length) return;
  const outcome = await runBulk(gated);
  const acted = [];
  for (const spec of gated) {
    if (spec.params && Array.isArray(spec.params.items)) {
      for (const item of spec.params.items) acted.push(item.emailId);
    } else if (spec.params && spec.params.emailId) acted.push(spec.params.emailId);
  }
  if (action === "add-label") {
    if (outcome.paused || outcome.error) showStatus(outcome.error || "Paused for rate limit", true);
    else showStatus("Label added in Gmail.");
    return;
  }
  const count = callCount(gated);
  const label = action === "move"
    ? (count === 1 ? "Moved." : "Moved " + count + " messages.")
    : "Label removed in Gmail.";
  await finishBulkRemoval(label, outcome, acted);
}

async function applyPickedMove(messages, kind, destinationId, name) {
  const accountId = messages[0] && messages[0].accountId;
  const target = kind === "outlook"
    ? { kind: "outlook", id: destinationId, accountId: accountId, api: true }
    : { kind: "imap", id: destinationId, accountId: accountId };
  await applyBulkMove(messages, target, name);
}

function openSelectionMove(kind) {
  const messages = selectionMoveMessages();
  if (!messages.length) return;
  openMessageMovePicker(messages[0], kind);
  if (!moveSession) return;
  moveSession.bulk = true;
  moveSession.emails = messages.slice();
  paintMoveTree();
  const source = $("move-picker-source");
  if (!source) return;
  if (messages.length === 1) source.textContent = "Message: " + (messages[0].subject || "this message");
  else source.textContent = "Messages: " + messages.length;
}

function openSelectionLabelMenu(mode, anchor) {
  const messages = selectionMoveMessages();
  const email = messages[0];
  if (!email || !anchor) return;
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const provider = folderProvider(account);
  const listed = account ? providerPayloadFor(account) : null;
  const model = organizeMenu(email, foldersOf(account), listed, provider);
  const items = mode === "add" ? model.add : model.remove;
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", mode === "add" ? "Add Gmail label" : "Remove Gmail label");
  menu.replaceChildren();
  appendMenuGroup(menu, mode === "add" ? "Add Gmail label" : "Remove Gmail label", items, (item) => applySelectionLabels(item, mode));
  if (!items.length) {
    const note = document.createElement("p");
    note.className = "organize-note";
    note.textContent = model.note || "No labels to show.";
    menu.appendChild(note);
  }
  const rect = anchor.getBoundingClientRect();
  placeMenu(menu, rect.left, rect.bottom + 4);
}

function openSelectionMenu(x, y) {
  const messages = selectedMessages();
  if (!messages.length) return;
  const email = messages[0];
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const provider = folderProvider(account);
  const listed = account ? providerPayloadFor(account) : null;
  const model = organizeMenu(email, foldersOf(account), listed, provider);
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", "Selected messages");
  menu.replaceChildren();
  const starred = messages.every((row) => row.isStarred);
  appendMenuAction(menu, "Mark read", () => guard(() => bulkSetRead(true)));
  appendMenuAction(menu, "Mark unread", () => guard(() => bulkSetRead(false)));
  appendMenuAction(menu, starred ? "Unstar" : "Star", () => guard(() => bulkStar(!starred)));
  appendMenuAction(menu, "Archive", () => guard(bulkArchive));
  appendMenuAction(menu, "Trash", () => guard(bulkTrash));
  if (model.move.length) appendMenuAction(menu, "Move to folder…", () => openSelectionMove("imap"));
  appendMenuGroup(menu, "Add Gmail label", model.add, (item) => applySelectionLabels(item, "add"));
  appendMenuGroup(menu, "Remove Gmail label", model.remove, (item) => applySelectionLabels(item, "remove"));
  if (model.outlook.length) appendMenuAction(menu, "Move in Outlook…", () => openSelectionMove("outlook"));
  appendMenuAction(menu, "Clear selection", () => commitSelection(clearListSelection()));
  if (model.note && !model.add.length && !model.remove.length && !model.outlook.length) {
    const note = document.createElement("p");
    note.className = "organize-note";
    note.textContent = model.note;
    menu.appendChild(note);
  }
  placeMenu(menu, x, y);
}

function selectionButton(id, label, paths, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "selection-action";
  button.id = id;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.appendChild(strokeIcon(paths, 15));
  const text = document.createElement("span");
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener("click", (event) => {
    if (run) guard(run);
    else openSelectionLabelMenu(button.dataset.mode, event.currentTarget);
  });
  return button;
}

function wireSelection() {
  const bar = $("selection-actions");
  if (!bar || bar.childElementCount) return;
  const mail = ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M22 6l-10 7L2 6"];
  const archive = ["M21 8v13H3V8", "M1 3h22v5H1z", "M10 12h4"];
  const trash = ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6l-1 14H6L5 6"];
  const star = ["M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"];
  const tag = ["M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z", "M7 7h.01"];
  const clear = ["M18 6L6 18", "M6 6l12 12"];
  bar.append(
    selectionButton("selection-read", "Mark read", mail, () => bulkSetRead(true)),
    selectionButton("selection-unread", "Mark unread", mail, () => bulkSetRead(false)),
    selectionButton("selection-star", "Star", star, () => {
      const messages = selectedMessages();
      const starred = messages.length > 0 && messages.every((email) => email.isStarred);
      return bulkStar(!starred);
    }),
    selectionButton("selection-archive", "Archive", archive, bulkArchive),
    selectionButton("selection-trash", "Trash", trash, bulkTrash),
    selectionButton("selection-move", "Move…", [MOVE_FOLDER], () => openSelectionMove("imap")),
    selectionButton("selection-outlook", "Move in Outlook…", [MOVE_FOLDER], () => openSelectionMove("outlook")),
  );
  const add = selectionButton("selection-add-label", "Add label", tag, null);
  add.dataset.mode = "add";
  const remove = selectionButton("selection-remove-label", "Remove label", tag, null);
  remove.dataset.mode = "remove";
  bar.append(add, remove, selectionButton("selection-clear", "Clear", clear, () => commitSelection(clearListSelection())));
  const selectAll = $("select-visible");
  if (selectAll) {
    selectAll.addEventListener("click", () => {
      commitSelection(selectAllVisible(shownEmails().map((email) => email && email.id)));
    });
  }
}

function onSelectionKey(event) {
  const menu = $("organize-menu");
  const menuOpen = menu && !menu.hidden;
  if (event.key === "Escape") {
    if (menuOpen || document.querySelector("dialog[open]")) return;
    const typing = event.target && event.target.closest && event.target.closest("input, textarea, select");
    if (selectionShortcut({ key: "Escape" }, !!typing) !== "clear") return;
    if (!state.selectedIds.length) return;
    event.preventDefault();
    commitSelection(clearListSelection());
    return;
  }
  const shortcut = selectionShortcut({
    key: event.key,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  }, shellBlocked(event.target) || state.view !== "mail");
  if (shortcut !== "all") return;
  event.preventDefault();
  commitSelection(selectAllVisible(shownEmails().map((email) => email && email.id)));
}

async function dropOrganized(target, message) {
  const plan = organizeDrop(target, message);
  if (!plan.ok) throw new Error(plan.message || "That message could not be moved.");
  if (plan.channel === "mail:moveToFolder") {
    await moveOpen(message, plan.params.targetFolderId);
    return;
  }
  if (plan.channel === "mail:modifyMessageLabels") {
    await changeLabels(message, plan.params.addLabelIds, plan.params.removeLabelIds);
    return;
  }
  await moveOutlook(message, plan.params.destinationId);
}

function clearDropTargets() {
  for (const node of document.querySelectorAll(".drop-target")) node.classList.remove("drop-target");
}

function onListContext(event) {
  const row = event.target.closest && event.target.closest(".message-row");
  const email = emailFromRow(row);
  if (!email) return;
  event.preventDefault();
  if (state.selectedIds.indexOf(String(email.id)) >= 0 && state.selectedIds.length > 1) {
    openSelectionMenu(event.clientX, event.clientY);
    return;
  }
  openOrganizeMenu(email, event.clientX, event.clientY);
}

function onReaderContext(event) {
  if (!state.email) return;
  if (event.target.closest && event.target.closest("input, textarea, select, a")) return;
  event.preventDefault();
  openOrganizeMenu(state.email, event.clientX, event.clientY);
}

function onMessagePointerDown(event) {
  const button = event.target && event.target.closest && event.target.closest("button.message");
  if (!button || event.button !== 0 || !modifierBlocksDrag(event)) return;
  button.draggable = false;
  const restore = () => {
    if (button.isConnected) button.draggable = true;
    window.removeEventListener("pointerup", restore, true);
    window.removeEventListener("pointercancel", restore, true);
  };
  window.addEventListener("pointerup", restore, true);
  window.addEventListener("pointercancel", restore, true);
}

function clearMailDragChrome() {
  document.body.classList.remove("is-mail-drag");
  for (const row of document.querySelectorAll(".message-row.dragging")) row.classList.remove("dragging");
}

function onMessageDragStart(event) {
  if (modifierBlocksDrag(event)) {
    event.preventDefault();
    return;
  }
  const button = event.target.closest && event.target.closest("button.message");
  if (!button || !event.dataTransfer) return;
  const row = button.closest(".message-row");
  const email = emailFromRow(row);
  const selected = selectedMessages();
  const inSelection = !!(email && state.selectedIds.indexOf(String(email.id)) >= 0 && selected.length > 1);
  const payload = inSelection ? selectionDragPayload(selected) : messageDragPayload(email);
  if (!payload) {
    event.preventDefault();
    return;
  }
  state.dragMessage = payload;
  event.dataTransfer.setData("application/x-morrow-message", JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copyMove";
  document.body.classList.add("is-mail-drag");
  const rows = inSelection ? document.querySelectorAll(".message-row.selected") : (row ? [row] : []);
  for (const item of rows) item.classList.add("dragging");
}

function onMessageDragEnd() {
  state.dragMessage = null;
  clearDropTargets();
  clearMailDragChrome();
}

function onFolderDragOver(event) {
  const node = event.target.closest && event.target.closest("[data-drop-kind]");
  if (!node || !state.dragMessage) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = node.dataset.dropKind === "gmail" ? "copy" : "move";
  clearDropTargets();
  node.classList.add("drop-target");
}

function onFolderDrop(event) {
  const node = event.target.closest && event.target.closest("[data-drop-kind]");
  clearDropTargets();
  if (!node) return;
  event.preventDefault();
  const raw = event.dataTransfer && event.dataTransfer.getData("application/x-morrow-message");
  const messages = dragMessagesFrom(raw, state.dragMessage);
  state.dragMessage = null;
  clearMailDragChrome();
  if (!messages.length) return;
  const full = messages.map((item) => {
    const found = state.emails.find((email) => email && String(email.id) === String(item.id));
    return found || item;
  });
  const target = dropTargetFrom(node);
  if (full.length === 1) {
    guard(() => dropOrganized(target, full[0]));
    return;
  }
  guard(() => applyBulkMove(full, target, dropTargetName(target)));
}

function wireOrganize() {
  $("messages").addEventListener("contextmenu", onListContext);
  $("reader").addEventListener("contextmenu", onReaderContext);
  $("messages").addEventListener("pointerdown", onMessagePointerDown, true);
  $("messages").addEventListener("dragstart", onMessageDragStart);
  $("messages").addEventListener("dragend", onMessageDragEnd);
  const folders = $("folders");
  folders.addEventListener("dragover", onFolderDragOver);
  folders.addEventListener("drop", onFolderDrop);
  document.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    const menu = $("organize-menu");
    if (!menu || menu.hidden || menu.dataset.open !== "1") return;
    if (menu.contains(event.target)) return;
    closeOrganizeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = $("organize-menu");
    if (!menu || menu.hidden) return;
    event.preventDefault();
    closeOrganizeMenu();
  });
  document.addEventListener("scroll", (event) => {
    const menu = $("organize-menu");
    if (!menu || menu.hidden) return;
    if (event.target === menu || (event.target && menu.contains && menu.contains(event.target))) return;
    closeOrganizeMenu();
  }, true);
}

async function selectFolder(accountId, folderId) {
  const previous = state.accountId;
  state.accountId = accountId;
  state.folderId = folderId;
  state.query = "";
  $("search-query").value = "";
  const listFilter = $("list-filter");
  if (listFilter) listFilter.value = "";
  state.email = null;
  state.thread = [];
  state.selectedIds = [];
  state.selectionAnchor = "";
  renderAccounts();
  syncRemove();
  renderReader(false);
  const live = isLive(selectedAccount());
  if (live) showStatus("Syncing…");
  else if (!undoOpIds && !sendTimer) showStatus("");
  await loadSnoozed();
  const data = await loadList(live);
  if (live && !undoOpIds && !sendTimer) showStatus(syncStatusLabel(data && data.sync));
  if (previous !== accountId) await loadProviderFolders(accountGen);
  const settingsDialog = $("settings");
  if (previous !== accountId && settingsDialog && settingsDialog.open) {
    loadVacation().catch((error) => setOooStatus(error instanceof Error ? error.message : String(error), true));
  }
}

async function openMessage(emailId, focus) {
  const gen = ++openGen;
  const data = await call("mail:openEmail", { emailId });
  if (gen !== openGen) return;
  const email = data && data.email;
  if (!email) throw new Error("That message is no longer in the mailbox.");
  let listed = null;
  const fromOpen = data && data.threadMessages;
  if (shouldListThread(state.prefs.conversation, fromOpen, email.threadId)) {
    try {
      listed = await call("mail:listThreadMessages", {
        threadId: email.threadId,
        accountId: email.accountId,
        headersOnly: true,
      });
    } catch {
      // The opened message still renders when the thread list fails.
    }
    if (gen !== openGen) return;
  }
  state.email = email;
  state.thread = state.prefs.conversation === false ? [] : threadMembers(fromOpen, listed);
  renderReader(focus !== false);
  renderList();
  if (!email.unread) return;
  try {
    await call("mail:markRead", { emailId, isRead: true });
  } catch {
    // The message is already on screen.
  }
}

async function applySearch() {
  const query = $("search-query").value.trim();
  state.query = query;
  if (query) showStatus("Searching all mail…");
  try {
    await loadList();
  } catch (error) {
    if (state.query !== query) return;
    showStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  if (state.query !== query) return;
  showStatus("");
}

function scheduleReload(preferredId) {
  const preferred = typeof preferredId === "string" && preferredId ? preferredId : "";
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadAccounts(preferred || undefined).catch((error) => showStatus(error.message, true));
  }, 150);
}

function onAccountsUpdated(payload) {
  const preferred = preferredAccountId(payload);
  const accounts = payload && Array.isArray(payload.accounts) ? payload.accounts : null;
  if (accounts) {
    state.accounts = accounts;
    rememberSelection(preferred);
    renderAccounts();
    renderBanner();
    syncRemove();
    if (preferred && state.oauthPending) {
      const view = accounts.find((account) => account.id === preferred);
      if (view && view.email) {
        closeDialog("connect");
        showStatus(`Connected ${view.email}`);
      }
    }
  }
  scheduleReload(preferred);
}

function connectPayload() {
  const profile = $("profile").value;
  const payload = {
    profile,
    email: $("email").value.trim(),
    password: $("password").value,
  };
  const username = $("username").value.trim();
  if (username) payload.username = username;
  if (profile === "custom") {
    payload.custom = {
      imap: {
        host: $("imap-host").value.trim(),
        port: Number($("imap-port").value),
        tls: $("imap-tls").checked,
      },
      smtp: {
        host: $("smtp-host").value.trim(),
        port: Number($("smtp-port").value),
        tls: $("smtp-tls").checked,
      },
    };
  }
  return payload;
}

async function connectImap() {
  clearUndo();
  showStatus("Connecting…");
  const view = await call("mail:connectImapSmtp", connectPayload());
  $("password").value = "";
  closeDialog("connect");
  showStatus(view && view.email ? `Connected ${view.email}` : "Connected.");
  await loadAccounts(view && view.id);
}

async function connectOAuth(provider) {
  clearUndo();
  state.oauthPending = true;
  showStatus("Waiting for the browser sign-in…");
  try {
    const view = await call("mail:addAccount", { provider });
    if (!view || !view.id || !view.email) throw new Error("Sign-in did not return an account.");
    closeDialog("connect");
    showStatus(`Connected ${view.email}`);
    await loadAccounts(view.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) {
      showStatus("Sign-in canceled.");
      await loadAccounts();
      return;
    }
    throw error;
  } finally {
    state.oauthPending = false;
  }
}

function dismissConnect() {
  closeDialog("connect");
  if (!state.oauthPending) return;
  call("mail:cancelOAuth").catch(() => {});
}

function composePayload(account) {
  const meta = state.composeMeta || {};
  const payload = {
    accountId: account.id,
    to: $("compose-to").value.trim(),
    subject: $("compose-subject").value,
    body: toHtml(outgoingBody($("compose-body").value, state.composeQuote && state.composeQuote.text)),
    fromAddress: account.email,
    draftId: state.draftId || undefined,
    emailId: state.draftId || undefined,
  };
  const cc = $("compose-cc").value.trim();
  const bcc = $("compose-bcc").value.trim();
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;
  if (meta.inReplyTo) payload.inReplyTo = meta.inReplyTo;
  if (meta.threadId) payload.threadId = meta.threadId;
  return payload;
}

function syncCompose() {
  const account = composeAccount();
  const live = isLive(account);
  $("compose-note").textContent = live
    ? `From ${account.email}`
    : "Connect an account before saving or sending.";
  $("compose-save").disabled = !live;
  $("compose-send").disabled = !live;
  $("compose-schedule").disabled = !live;
}

function syncScheduleFields() {
  const custom = $("schedule-preset").value === "custom";
  $("schedule-at").hidden = !custom;
  $("schedule-at-label").hidden = !custom;
}

function renderScheduled(rows) {
  const list = $("scheduled");
  list.replaceChildren();
  if (!rows.length) {
    const item = document.createElement("li");
    item.textContent = "Nothing scheduled.";
    list.append(item);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = scheduledLine(row);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancel";
    const subject = String((row && row.subject) || "").trim() || "(no subject)";
    cancel.setAttribute("aria-label", `Cancel scheduled send ${subject}`);
    cancel.addEventListener("click", () => {
      cancelScheduled(row.id).catch((error) => {
        showStatus(error instanceof Error ? error.message : String(error), true);
      });
    });
    item.append(text, cancel);
    list.append(item);
  }
}

function showSignatureEmpty(message) {
  const select = $("signature");
  select.hidden = true;
  select.replaceChildren();
  const empty = $("signature-empty");
  empty.hidden = false;
  empty.textContent = message;
}

async function fillSignatures() {
  const gen = signatureGen += 1;
  const accountId = composeAccount()?.id;
  let pack = null;
  try {
    pack = await call("mail:listSignatures", accountId ? { accountId } : {});
  } catch (error) {
    if (gen !== signatureGen) return;
    state.signatures = [];
    showSignatureEmpty(error instanceof Error ? error.message : String(error));
    return;
  }
  if (gen !== signatureGen) return;
  const rows = signatureRows(pack);
  state.signatures = rows;
  if (!rows.length) {
    showSignatureEmpty("No signatures.");
    $("compose-body").value = applySignature($("compose-body").value, state.signatureText, "");
    state.signatureText = "";
    return;
  }
  const select = $("signature");
  $("signature-empty").hidden = true;
  select.hidden = false;
  select.replaceChildren();
  select.append(option("", "No signature"));
  for (const row of rows) select.append(option(String(row.id), signatureName(row)));
  const id = chosenSignatureId(pack, accountId);
  const match = rows.find((row) => String(row.id) === id);
  select.value = match ? String(match.id) : "";
  const text = signaturePlain(match);
  $("compose-body").value = applySignature($("compose-body").value, state.signatureText, text);
  state.signatureText = text;
}

function onSignatureChange() {
  const row = state.signatures.find((item) => String(item.id) === $("signature").value);
  const text = signaturePlain(row);
  $("compose-body").value = applySignature($("compose-body").value, state.signatureText, text);
  state.signatureText = text;
}

function showSignatureStatus(text, isError) {
  const el = $("signatures-status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError && !!text);
}

function clearSignatureForm() {
  signatureEditId = "";
  $("signature-name").value = "";
  $("signature-body").value = "";
  $("signature-html").checked = false;
  $("signature-default").checked = false;
  $("signature-save").textContent = "Add";
  $("signature-cancel").hidden = true;
}

function paintSignatures(pack) {
  const root = $("signature-list");
  root.replaceChildren();
  const rows = signatureRows(pack);
  const def = pack && pack.defaultSignatureId ? String(pack.defaultSignatureId) : "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No signatures.";
    root.appendChild(empty);
  }
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "signature-row";
    const isDefault = String(row.id) === def;
    const text = document.createElement("p");
    text.textContent = signatureName(row) + (isDefault ? " · Default" : "");
    const name = signatureName(row);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit " + name);
    edit.addEventListener("click", () => startSignatureEdit(row, isDefault));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete " + name);
    del.addEventListener("click", () => {
      removeSignature(row.id).catch((error) => {
        showSignatureStatus(error instanceof Error ? error.message : String(error), true);
      });
    });
    line.append(text, edit, del);
    root.appendChild(line);
  }
  $("signature-save").textContent = signatureEditId ? "Save" : "Add";
  $("signature-cancel").hidden = !signatureEditId;
}

function startSignatureEdit(row, isDefault) {
  const fields = signatureFields(row, isDefault);
  signatureEditId = fields.id;
  $("signature-name").value = fields.name;
  $("signature-body").value = fields.body;
  $("signature-html").checked = fields.html;
  $("signature-default").checked = fields.isDefault;
  $("signature-save").textContent = "Save";
  $("signature-cancel").hidden = false;
  $("signature-name").focus();
}

async function loadSignatureEditor() {
  const accountId = signatureAccount()?.id;
  const pack = await call("mail:listSignatures", accountId ? { accountId } : {});
  if ($("signatures").open) paintSignatures(pack);
  return pack;
}

function openSignatures() {
  clearSignatureForm();
  showSignatureStatus("");
  openDialog("signatures");
  loadSignatureEditor().catch((error) => {
    showSignatureStatus(error instanceof Error ? error.message : String(error), true);
  });
}

async function refreshComposeSignatures() {
  if (!$("compose").open) return;
  const select = $("signature");
  const hadPicker = !select.hidden;
  const selected = select.value;
  await fillSignatures();
  if ($("signature").hidden || !hadPicker) return;
  if (![...$("signature").options].some((opt) => opt.value === selected)) return;
  if ($("signature").value === selected) return;
  $("signature").value = selected;
  onSignatureChange();
}

async function submitSignature(event) {
  event.preventDefault();
  const draft = signatureDraft({
    id: signatureEditId,
    name: $("signature-name").value,
    body: $("signature-body").value,
    html: $("signature-html").checked,
    isDefault: $("signature-default").checked,
  });
  if (!draft.name) {
    showSignatureStatus("Add a name.", true);
    return;
  }
  if (!String(draft.html || draft.text || "").trim()) {
    showSignatureStatus("Add signature text.", true);
    return;
  }
  const account = signatureAccount();
  if (!isLive(account)) {
    showSignatureStatus("Connect an account before saving a signature.", true);
    return;
  }
  draft.accountId = account.id;
  try {
    const saved = await call("mail:upsertSignature", draft);
    signatureEditId = saved && saved.id ? String(saved.id) : "";
    showSignatureStatus("Saved.");
    await loadSignatureEditor();
    await refreshComposeSignatures();
  } catch (error) {
    showSignatureStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function removeSignature(id) {
  await call("mail:deleteSignature", { id });
  if (signatureEditId === id) clearSignatureForm();
  showSignatureStatus("Deleted.");
  await loadSignatureEditor();
  await refreshComposeSignatures();
}

function stopDraftWrite() {
  const current = state.draftWrite;
  if (!current || !current.pending) return;
  current.pending = false;
  call("aiDraftWrite:cancel", { reqId: current.reqId }).catch(() => {});
}

function resetDraftWrite() {
  stopDraftWrite();
  state.draftWrite = null;
  const error = $("ai-write-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  const cancel = $("ai-cancel");
  if (cancel) cancel.hidden = true;
  const go = $("ai-generate");
  if (go) go.disabled = false;
  const body = $("compose-body");
  if (body) body.readOnly = false;
}

function paintDraft() {
  const view = state.draftWrite;
  const pending = !!(view && view.pending);
  const cancel = $("ai-cancel");
  const go = $("ai-generate");
  const error = $("ai-write-error");
  const body = $("compose-body");
  if (cancel) cancel.hidden = !pending;
  if (go) go.disabled = pending;
  if (body) body.readOnly = pending;
  if (error) {
    const message = view && view.error ? view.error : "";
    error.hidden = !message;
    error.textContent = message;
  }
  if (view && body) body.value = shownDraft(view);
}

function onDraftEvent(event) {
  applyDraftEvent(state.draftWrite, event);
  if (!$("compose").open) return;
  paintDraft();
}

async function startDraftWrite() {
  const mode = $("ai-mode").value || "custom";
  const prompt = $("ai-prompt").value;
  const existing = $("compose-body").value;
  const reason = draftBlockReason(mode, prompt, existing);
  stopDraftWrite();
  if (reason) {
    state.draftWrite = { reqId: "", pending: false, error: reason, text: "", base: existing, previous: existing };
    paintDraft();
    return;
  }
  const reqId = `dw-${Date.now().toString(36)}-${draftSeq += 1}`;
  state.draftWrite = {
    reqId,
    pending: true,
    error: "",
    text: "",
    base: draftBase(mode, existing),
    previous: existing,
  };
  paintDraft();
  try {
    await call("aiDraftWrite:start", {
      reqId,
      body: draftInstruction(mode, prompt, existing, $("compose-subject").value),
    });
  } catch (error) {
    if (!state.draftWrite || state.draftWrite.reqId !== reqId) return;
    state.draftWrite.pending = false;
    state.draftWrite.error = error instanceof Error ? error.message : String(error);
    paintDraft();
  }
}

async function cancelDraftWrite() {
  const current = state.draftWrite;
  if (!current || !current.pending) return;
  const reqId = current.reqId;
  current.pending = false;
  paintDraft();
  await call("aiDraftWrite:cancel", { reqId });
}

function readComposeLayout() {
  const dialog = $("compose");
  const reader = $("reader");
  return composeLayoutMode(
    dialog ? dialog.clientWidth : 0,
    reader ? reader.clientWidth : 0,
    window.innerWidth || 0,
  );
}

function applyQuoteWidth() {
  const dialog = $("compose");
  const total = dialog ? dialog.clientWidth : 0;
  const next = Math.round(quotePaneWidth(state.prefs.quoteWidth, total));
  document.documentElement.style.setProperty("--compose-quote", next + "px");
  const handle = $("compose-split-handle");
  if (handle) {
    handle.setAttribute("aria-valuemin", "220");
    handle.setAttribute("aria-valuemax", "720");
    handle.setAttribute("aria-valuenow", String(next));
  }
  return next;
}

function dragQuoteWidth(px) {
  const dialog = $("compose");
  const total = dialog ? dialog.clientWidth : 0;
  const next = Math.round(quotePaneWidth(px, total));
  state.prefs.quoteWidth = next;
  document.documentElement.style.setProperty("--compose-quote", next + "px");
  const handle = $("compose-split-handle");
  if (handle) handle.setAttribute("aria-valuenow", String(next));
  return next;
}

function rememberQuoteWidth(px) {
  const next = quoteWidthPref(px);
  state.prefs.quoteWidth = next;
  applyQuoteWidth();
  if (!api) return;
  api.invoke("morrow:configSetComposeQuoteWidth", next).catch(() => {});
}

function quoteImagesOn(email) {
  if (!email) return false;
  const allowed = !!(email.id && state.remoteAllowed && state.remoteAllowed[email.id]);
  if (allowed) return true;
  if (state.composeQuote && state.composeQuote.images === true && !email.id) return true;
  return remoteVisible(state.prefs.images, false);
}

function paintQuoteBody() {
  const root = $("compose-quote-body");
  if (!root) return;
  root.replaceChildren();
  const quote = state.composeQuote;
  if (!quote) return;
  const email = quote.email;
  if (!email) {
    const text = String(quote.text || "").trim();
    if (!text) return;
    const block = document.createElement("p");
    block.className = "body";
    block.textContent = text;
    root.appendChild(block);
    return;
  }
  const head = document.createElement("div");
  head.className = "compose-quote-meta";
  const from = document.createElement("p");
  from.className = "meta";
  from.textContent = email.from || "";
  head.appendChild(from);
  if (email.date) {
    const when = document.createElement("p");
    when.className = "meta";
    const date = new Date(email.date);
    when.textContent = Number.isNaN(date.getTime()) ? String(email.date) : date.toLocaleString();
    head.appendChild(when);
  }
  if (email.subject) {
    const subject = document.createElement("p");
    subject.className = "meta";
    subject.textContent = email.subject;
    head.appendChild(subject);
  }
  for (const pair of [["To", email.to], ["Cc", email.cc]]) {
    const text = people(pair[1]);
    if (!text) continue;
    const line = document.createElement("p");
    line.className = "meta";
    line.textContent = pair[0] + " " + text;
    head.appendChild(line);
  }
  root.appendChild(head);
  const images = remoteImageSrcs(email.htmlBody);
  const allowed = quoteImagesOn(email);
  if (images.length && !allowed) {
    const bar = document.createElement("div");
    bar.className = "remote-gate";
    const note = document.createElement("p");
    note.textContent = images.length === 1
      ? "1 remote image is blocked."
      : images.length + " remote images are blocked.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "Load remote content";
    button.addEventListener("click", () => {
      if (email.id) {
        state.remoteAllowed[email.id] = true;
        if (state.email && state.email.id === email.id) renderReader(false);
      } else if (state.composeQuote) {
        state.composeQuote.images = true;
      }
      paintQuoteBody();
    });
    bar.append(note, button);
    root.appendChild(bar);
  }
  appendMessageBody(root, email, allowed);
  const files = attachmentNote(email);
  if (files) {
    const line = document.createElement("p");
    line.className = "meta";
    line.textContent = files;
    root.appendChild(line);
  }
}

function paintComposeChrome() {
  const dialog = $("compose");
  const quote = state.composeQuote;
  const toggle = $("compose-quote-toggle");
  const pane = $("compose-quote");
  const handle = $("compose-split-handle");
  const note = $("compose-quote-note");
  const collapse = $("compose-quote-collapse");
  const collapseLabel = $("compose-quote-collapse-label");
  const body = $("compose-quote-body");
  if (!dialog || !toggle || !pane || !handle || !note) return;
  const has = !!(quote && (quote.email || quote.text));
  dialog.classList.toggle("is-quoting", has);
  toggle.hidden = !has;
  if (!has) {
    dialog.dataset.quote = "off";
    dialog.dataset.layout = "";
    dialog.dataset.quoteCollapsed = "false";
    pane.hidden = true;
    handle.hidden = true;
    note.hidden = true;
    if (collapse) collapse.hidden = true;
    if (body) body.replaceChildren();
    return;
  }
  const shown = quote.shown === true;
  const wide = dialog.dataset.layout === "wide";
  const collapsed = !wide && shown && quote.collapsed === true;
  dialog.dataset.quote = shown ? "shown" : "hidden";
  dialog.dataset.quoteCollapsed = collapsed ? "true" : "false";
  toggle.setAttribute("aria-pressed", shown ? "true" : "false");
  const toggleLabel = $("compose-quote-toggle-label");
  if (toggleLabel) toggleLabel.textContent = shown ? "Hide quoted message" : "Show quoted message";
  pane.hidden = !shown;
  pane.setAttribute("aria-hidden", shown ? "false" : "true");
  handle.hidden = !(shown && wide);
  note.hidden = shown;
  if (collapse) {
    collapse.hidden = !shown || wide;
    collapse.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  if (collapseLabel) collapseLabel.textContent = collapsed ? "Expand" : "Collapse";
  if (body) body.hidden = collapsed;
}

function syncComposeLayout() {
  const dialog = $("compose");
  if (!dialog) return;
  if (!state.composeQuote) {
    paintComposeChrome();
    return;
  }
  const mode = readComposeLayout();
  const changed = dialog.dataset.layout !== mode;
  dialog.dataset.layout = mode;
  if (mode === "wide") state.composeQuote.collapsed = false;
  paintComposeChrome();
  applyQuoteWidth();
  if (changed && state.composeQuote.shown) {
    const motion = motionApi();
    if (motion && motion.fadePane) motion.fadePane($("compose-quote"), mode === "wide" ? "x" : "y");
  }
}

function scheduleComposeLayout() {
  syncComposeLayout();
  requestAnimationFrame(() => syncComposeLayout());
}

function toggleComposeQuote() {
  if (!state.composeQuote) return;
  state.composeQuote.shown = !state.composeQuote.shown;
  if (state.composeQuote.shown) state.composeQuote.collapsed = false;
  syncComposeLayout();
  if (!state.composeQuote.shown) return;
  const motion = motionApi();
  if (motion && motion.fadePane) {
    motion.fadePane($("compose-quote"), $("compose").dataset.layout === "wide" ? "x" : "y");
  }
}

function toggleComposeQuoteCollapse() {
  const quote = state.composeQuote;
  const dialog = $("compose");
  if (!quote || !quote.shown || !dialog || dialog.dataset.layout === "wide") return;
  quote.collapsed = !quote.collapsed;
  paintComposeChrome();
  if (quote.collapsed) return;
  const motion = motionApi();
  if (motion && motion.fadePane) motion.fadePane($("compose-quote-body"), "y");
}

async function openCompose(seed) {
  const fields = seed || {};
  resetDraftWrite();
  state.draftId = null;
  state.signatureText = "";
  state.composeMeta = {
    accountId: fields.accountId || state.accountId,
    inReplyTo: fields.inReplyTo || "",
    threadId: fields.threadId || "",
  };
  state.composeQuote = quoteStateFromSeed(fields);
  $("compose-title").textContent = fields.title || "New message";
  $("compose-to").value = fields.to || "";
  $("compose-cc").value = fields.cc || "";
  $("compose-bcc").value = fields.bcc || "";
  $("compose-subject").value = fields.subject || "";
  $("compose-body").value = fields.body || "";
  $("ai-prompt").value = "";
  $("schedule-preset").value = "1h";
  $("schedule-at").value = "";
  syncScheduleFields();
  syncCompose();
  paintComposeChrome();
  paintQuoteBody();
  openDialog("compose");
  scheduleComposeLayout();
  await Promise.all([fillSignatures(), loadScheduled()]);
  if (!$("compose").open) return;
  scheduleComposeLayout();
  const write = document.querySelector(".ai-write");
  const openWrite = opensAiWrite(fields, state.prefs);
  if (write) write.classList.toggle("open", openWrite);
  if (openWrite) {
    const body = $("compose-body");
    body.setSelectionRange(0, 0);
    body.scrollTop = 0;
    $("ai-prompt").focus();
    return;
  }
  if ($("compose-to").value.trim()) {
    const body = $("compose-body");
    body.focus();
    body.setSelectionRange(0, 0);
    body.scrollTop = 0;
  } else {
    $("compose-to").focus();
  }
}

async function loadScheduled() {
  const gen = scheduledGen += 1;
  const account = composeAccount();
  let data = null;
  try {
    data = await call("mail:listScheduled", account ? { accountId: account.id } : {});
  } catch (error) {
    if (gen !== scheduledGen) return;
    renderScheduled([]);
    showStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  if (gen !== scheduledGen) return;
  renderScheduled(scheduledRows(data));
}

async function cancelScheduled(id) {
  await call("mail:cancelScheduled", { id });
  showStatus("Scheduled send canceled.");
  await loadScheduled();
}

async function scheduleMail() {
  const account = composeAccount();
  if (!isLive(account)) return;
  if (!composeHasRecipient()) {
    showStatus("Add a recipient.", true);
    return;
  }
  const when = scheduleAt($("schedule-preset").value, $("schedule-at").value, new Date());
  if (!when) {
    showStatus("Pick a time in the future.", true);
    return;
  }
  showStatus("Scheduling…");
  await call("mail:scheduleSend", { ...composePayload(account), sendAt: when.toISOString() });
  showStatus(`Scheduled for ${when.toLocaleString()}.`);
  await loadScheduled();
}

async function saveDraft() {
  const account = composeAccount();
  if (!isLive(account)) return;
  showStatus("Saving draft…");
  const saved = await call("mail:upsertDraft", composePayload(account));
  state.draftId = (saved && (saved.emailId || saved.draftId)) || state.draftId;
  showStatus("Draft saved.");
}

function hideUndoSend() {
  sendGen += 1;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  const button = $("undo-send");
  if (button) button.hidden = true;
}

function cancelUndoSend() {
  if (!sendTimer) return false;
  hideUndoSend();
  showStatus("Send canceled.");
  return true;
}

async function deliverMail(payload) {
  showStatus("Sending…");
  await call("mail:send", payload);
  state.draftId = null;
  closeDialog("compose");
  showStatus("Sent.");
  await loadList();
}

// shortcut: the wait is local; mail:send is immediate once it starts, upgrade when the host can recall a send
async function sendMail() {
  const account = composeAccount();
  if (!isLive(account)) return;
  if (!composeHasRecipient()) {
    showStatus("Add a recipient.", true);
    return;
  }
  const payload = composePayload(account);
  const delay = sendDelayMs(state.prefs.undoSend);
  hideUndoSend();
  if (!delay) {
    await deliverMail(payload);
    return;
  }
  closeDialog("compose");
  const gen = ++sendGen;
  showStatus(`Undo send for ${delay / 1000}s.`);
  $("undo-send").hidden = false;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    const button = $("undo-send");
    if (button) button.hidden = true;
    if (gen !== sendGen) return;
    guard(() => deliverMail(payload));
  }, delay);
}

async function removeAccount() {
  const account = selectedAccount();
  if (!isLive(account)) return;
  const label = account.email || account.id;
  if (!window.confirm(`Remove ${label} from Morrow Mail? Messages stay on the server.`)) return;
  hideUndoSend();
  clearUndo();
  showStatus("Removing account…");
  await call("mail:removeAccount", { accountId: account.id });
  state.accountId = null;
  state.folderId = null;
  state.query = "";
  $("search-query").value = "";
  const listFilter = $("list-filter");
  if (listFilter) listFilter.value = "";
  state.email = null;
  state.thread = [];
  showStatus("Account removed.");
  await loadAccounts();
}

async function refresh() {
  if (state.view === "calendar") {
    showStatus("Syncing…");
    await loadCalendar();
    showStatus("");
    return;
  }
  if (state.view === "agent") {
    showStatus("Syncing…");
    await loadAgent();
    showStatus("");
    return;
  }
  if (state.view === "brain") {
    showStatus("Syncing…");
    await loadBrain();
    showStatus("");
    return;
  }
  const account = selectedAccount();
  if (!account || !state.folderId) return;
  showStatus("Syncing…");
  const data = await call("mail:listFromNetwork", {
    accountId: account.id,
    folderId: state.folderId,
    limit: 500,
  });
  await loadAccounts();
  showStatus(syncStatusLabel(data && data.sync));
}

async function loadPresets() {
  try {
    const cards = await call("mail:listImapSmtpPresets");
    fillPresets(Array.isArray(cards) ? cards : []);
  } catch (error) {
    fillPresets([]);
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function shellBlocked(target) {
  if (!target || !target.closest) return true;
  if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
  return !!document.querySelector("dialog[open]");
}

function messageButtons() {
  return [...$("messages").querySelectorAll("button.message")];
}

function moveCursor(delta) {
  const buttons = messageButtons();
  if (!buttons.length) return;
  let index = buttons.indexOf(document.activeElement);
  if (index < 0) index = buttons.findIndex((button) => button.classList.contains("cursor"));
  if (index < 0) index = buttons.findIndex((button) => button.getAttribute("aria-current") === "true");
  const next = buttons[nextRow(buttons.length, index, delta)];
  if (!next) return;
  for (const button of buttons) button.classList.toggle("cursor", button === next);
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function onShellKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
  if (shellBlocked(event.target)) return;
  if (event.target.closest && event.target.closest(".row-actions")) return;
  if (event.key === "Enter") {
    const buttons = messageButtons();
    if (buttons.includes(document.activeElement)) return;
    if (event.target.closest && event.target.closest("nav, header, dialog, #reader, #notice, .split")) return;
    const target = buttons.find((button) => button.classList.contains("cursor"))
      || buttons.find((button) => button.getAttribute("aria-current") === "true");
    if (!target) return;
    event.preventDefault();
    target.click();
    return;
  }
  event.preventDefault();
  moveCursor(event.key === "ArrowDown" ? 1 : -1);
}

function sideColumn() {
  return document.querySelector(".side");
}

function setPane(which, width) {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  const total = shell.getBoundingClientRect().width;
  const folders = sideColumn().getBoundingClientRect().width;
  const list = $("messages").getBoundingClientRect().width;
  const readerMin = 260;
  const handle = 12;
  if (which === "folders") {
    const max = Math.max(140, total - list - readerMin - handle);
    document.documentElement.style.setProperty("--folders", `${Math.round(paneWidth(width, 0, 140, max))}px`);
    return;
  }
  const max = Math.max(200, total - folders - readerMin - handle);
  document.documentElement.style.setProperty("--list", `${Math.round(paneWidth(width, 0, 200, max))}px`);
}

function wireSplits() {
  for (const handle of document.querySelectorAll(".split")) {
    handle.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 24 : event.key === "ArrowLeft" ? -24 : 0;
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      const pane = handle.dataset.split === "folders" ? sideColumn() : $("messages");
      setPane(handle.dataset.split, pane.getBoundingClientRect().width + step);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const which = handle.dataset.split;
      const startX = event.clientX;
      const start = (which === "folders" ? sideColumn() : $("messages")).getBoundingClientRect().width;
      function move(ev) {
        setPane(which, start + ev.clientX - startX);
      }
      function stop() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    });
  }
}

function wireQuoteSplit() {
  const handle = $("compose-split-handle");
  const toggle = $("compose-quote-toggle");
  const collapse = $("compose-quote-collapse");
  if (!handle || handle.dataset.wired === "1") return;
  handle.dataset.wired = "1";
  handle.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 24 : event.key === "ArrowLeft" ? -24 : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    rememberQuoteWidth(dragQuoteWidth((state.prefs.quoteWidth || 420) + step));
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const start = state.prefs.quoteWidth || 420;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    function move(ev) {
      dragQuoteWidth(start + ev.clientX - startX);
    }
    function stop() {
      document.documentElement.style.cursor = "";
      document.documentElement.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      rememberQuoteWidth(state.prefs.quoteWidth);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });
  window.addEventListener("resize", () => {
    const dialog = $("compose");
    if (!dialog || !dialog.open) return;
    syncComposeLayout();
  });
  if (toggle) toggle.addEventListener("click", () => toggleComposeQuote());
  if (collapse) collapse.addEventListener("click", () => toggleComposeQuoteCollapse());
}

function updateView(snapshot, version) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const current = typeof version === "string" ? version : "";
  let status = "Up to date.";
  let install = false;
  let busy = false;
  const error = snap.error ? String(snap.error) : "";
  if (snap.needsToken) {
    status = "Private updates need a GitHub token.";
  } else if (error) {
    status = "Update failed.";
  } else if (snap.installing) {
    status = "Installing…";
    busy = true;
  } else if (snap.downloaded) {
    status = snap.version ? "Update " + snap.version + " ready." : "Update ready.";
    install = true;
  } else if (snap.downloading) {
    const pct = typeof snap.progress === "number" ? Math.round(snap.progress) : 0;
    status = "Downloading " + pct + "%…";
    busy = true;
  } else if (snap.checking) {
    status = "Checking for updates…";
    busy = true;
  } else if (snap.available) {
    status = snap.version ? "Update " + snap.version + " available." : "Update available.";
  } else if (snap.enabled === false) {
    status = "Updater is off until the app is packaged.";
  }
  return { version: current, status: status, error: error, install: install, busy: busy };
}

function paintUpdate(view) {
  $("version").textContent = view.version ? "Version " + view.version : "";
  const status = $("update-status");
  status.textContent = view.error ? view.status + " " + view.error : view.status;
  status.classList.toggle("error", !!view.error);
  $("update-check").disabled = !!view.busy;
  const install = $("update-install");
  install.hidden = !view.install;
  if (!view.install) install.disabled = false;
}

function showUpdate(snapshot) {
  const view = updateView(snapshot, appVersion);
  paintUpdate(view);
  clearTimeout(updateTimer);
  if (!view.busy) return;
  const gen = updateGen;
  updateTimer = setTimeout(() => {
    api.invoke("host:updateGetState").then((next) => {
      if (gen !== updateGen) return;
      showUpdate(next);
    }).catch((error) => {
      if (gen !== updateGen) return;
      showUpdate({ error: error instanceof Error ? error.message : String(error) });
    });
  }, 1000);
}

function bumpUpdate(snapshot) {
  updateGen += 1;
  showUpdate(snapshot);
}

async function checkForUpdates() {
  $("update-check").disabled = true;
  try {
    bumpUpdate(await api.invoke("host:updateCheck"));
  } catch (error) {
    bumpUpdate({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function installUpdate() {
  $("update-install").disabled = true;
  try {
    bumpUpdate(await api.invoke("host:updateInstall"));
  } catch (error) {
    bumpUpdate({ error: error instanceof Error ? error.message : String(error) });
  }
}

function shellLook(prefs) {
  const src = prefs && typeof prefs === "object" ? prefs : {};
  const theme = String(src.theme || "").trim().toLowerCase() === "dark" ? "dark" : "light";
  const raw = typeof src.accent === "string" ? src.accent.trim() : "";
  const accent = /^#[0-9A-Fa-f]{6}$/.test(raw) ? raw.toUpperCase() : "#7C3AED";
  return { theme, accent };
}

function applyLook(prefs) {
  const look = shellLook(prefs);
  const root = document.documentElement;
  root.dataset.theme = look.theme;
  root.style.setProperty("--accent", look.accent);
}

function shouldListThread(conversation, fromOpen, threadId) {
  if (conversation === false) return false;
  if (Array.isArray(fromOpen) && fromOpen.length > 0) return false;
  return !!threadId;
}

function remoteVisible(auto, allowed) {
  return auto === true || allowed === true;
}

function composeHasRecipient() {
  return ["compose-to", "compose-cc", "compose-bcc"].some((id) => $(id).value.trim());
}

// shortcut: CSP allows http/https images. They stay out until this message is allowed or remote images is on.
function remoteImageSrcs(html) {
  const srcs = [];
  const re = /<img\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const tag = match[1] || "";
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const src = srcMatch ? (srcMatch[1] || srcMatch[2] || srcMatch[3] || "").trim() : "";
    if (!/^https?:\/\/\S+$/i.test(src)) continue;
    const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const alt = altMatch ? (altMatch[1] || altMatch[2] || altMatch[3] || "").trim() : "";
    srcs.push({ src, alt });
  }
  return srcs;
}

function sendDelayMs(seconds) {
  const n = typeof seconds === "number" ? seconds : (typeof seconds === "string" && /^-?\d+$/.test(seconds) ? Number(seconds) : NaN);
  if (!Number.isInteger(n) || n < 0 || n > 30) return 5000;
  return n * 1000;
}

const SHELL_PREFS = {
  "morrow:configGetShowFolderChips": "chips",
  "morrow:configGetAiWriteAutoOpenOnReply": "aiReply",
  "morrow:configGetSidebarGmailFoldersExpanded": "gmailOpen",
  "morrow:configGetSidebarOutlookFoldersExpanded": "outlookOpen",
};

const READER_PREFS = {
  "morrow:configGetConversationViewEnabled": "conversation",
  "morrow:configGetAutoLoadRemoteImages": "images",
  "morrow:configGetSnoozeEffective": "snooze",
};

async function loadLook() {
  try {
    const theme = await api.invoke("config:getTheme");
    const accent = await api.invoke("morrow:configGetAccent");
    applyShellTheme(document.documentElement, theme, accent);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function loadShellPrefs() {
  const next = { ...state.prefs };
  try {
    for (const [channel, key] of Object.entries(SHELL_PREFS)) {
      next[key] = (await api.invoke(channel)) === true;
    }
    const look = shellLook({
      theme: await api.invoke("config:getTheme"),
      accent: await api.invoke("morrow:configGetAccent"),
    });
    next.theme = look.theme;
    next.accent = look.accent;
    for (const [channel, key] of Object.entries(READER_PREFS)) {
      next[key] = (await api.invoke(channel)) === true;
    }
    next.undoSend = sendDelayMs(await api.invoke("morrow:configGetUndoSendDelaySeconds")) / 1000;
    next.quoteWidth = quoteWidthPref(await api.invoke("morrow:configGetComposeQuoteWidth"));
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  state.prefs = next;
  applyLook(next);
  document.documentElement.style.setProperty("--compose-quote", state.prefs.quoteWidth + "px");
}

function refreshReader() {
  const email = state.email;
  if (!email) return;
  if (state.prefs.conversation === false) {
    state.thread = [];
    renderReader(false);
    return;
  }
  const have = state.thread.some((row) => row && row.id === email.id);
  if (email.threadId && state.thread.length < 2 && !have) {
    openMessage(email.id, false).catch((error) => showStatus(error.message, true));
    return;
  }
  renderReader(false);
}

function takePref(getChannel, kind, control) {
  const key = SHELL_PREFS[getChannel] || READER_PREFS[getChannel];
  if (key) {
    state.prefs[key] = control.checked === true;
    return true;
  }
  if (getChannel === "config:getTheme" || getChannel === "morrow:configGetAccent") {
    const look = shellLook({
      theme: getChannel === "config:getTheme" ? control.value : state.prefs.theme,
      accent: getChannel === "morrow:configGetAccent" ? control.value : state.prefs.accent,
    });
    state.prefs.theme = look.theme;
    state.prefs.accent = look.accent;
    return true;
  }
  if (getChannel === "morrow:configGetUndoSendDelaySeconds") {
    state.prefs.undoSend = sendDelayMs(readPref(kind, control)) / 1000;
    return true;
  }
  return false;
}

function paintPrefs() {
  applyLook(state.prefs);
  renderAccounts();
  renderList();
  refreshReader();
}

async function toggleProviderFolders(provider) {
  const spec = provider === "gmail"
    ? ["gmailOpen", "morrow:configSetSidebarGmailFoldersExpanded"]
    : ["outlookOpen", "morrow:configSetSidebarOutlookFoldersExpanded"];
  const key = spec[0];
  const next = !state.prefs[key];
  state.prefs[key] = next;
  renderAccounts();
  try {
    state.prefs[key] = (await api.invoke(spec[1], next)) === true;
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
    await loadShellPrefs();
  }
  renderAccounts();
}

function prefRows() {
  return [
    ["pref-theme", "config:getTheme", "config:setTheme", "select"],
    ["pref-accent", "morrow:configGetAccent", "morrow:configSetAccent", "text"],
    ["pref-conversation", "morrow:configGetConversationViewEnabled", "morrow:configSetConversationViewEnabled", "bool"],
    ["pref-images", "morrow:configGetAutoLoadRemoteImages", "morrow:configSetAutoLoadRemoteImages", "bool"],
    ["pref-undo", "morrow:configGetUndoSendDelaySeconds", "morrow:configSetUndoSendDelaySeconds", "seconds"],
    ["pref-snooze", "morrow:configGetSnoozeEffective", "morrow:configSetSnoozeEffective", "bool"],
    ["pref-ai-reply", "morrow:configGetAiWriteAutoOpenOnReply", "morrow:configSetAiWriteAutoOpenOnReply", "bool"],
    ["pref-folder-chips", "morrow:configGetShowFolderChips", "morrow:configSetShowFolderChips", "bool"],
    ["pref-gmail-folders", "morrow:configGetSidebarGmailFoldersExpanded", "morrow:configSetSidebarGmailFoldersExpanded", "bool"],
    ["pref-outlook-folders", "morrow:configGetSidebarOutlookFoldersExpanded", "morrow:configSetSidebarOutlookFoldersExpanded", "bool"],
  ];
}

function readPref(kind, control) {
  if (kind === "bool") return control.checked === true;
  if (kind === "seconds") {
    const raw = String(control.value).trim();
    if (!/^-?\d+$/.test(raw)) return raw;
    return Number(raw);
  }
  return control.value;
}

function applyPref(kind, control, value) {
  if (kind === "bool") {
    control.checked = value === true;
    return;
  }
  control.value = value == null ? "" : String(value);
}

async function loadSettings() {
  const status = $("settings-status");
  status.textContent = "";
  status.classList.remove("error");
  try {
    for (const [id, channel, , kind] of prefRows()) {
      applyPref(kind, $(id), await api.invoke(channel));
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("error");
  }
  loadAiSettings();
  loadVacation().catch((error) => setOooStatus(error instanceof Error ? error.message : String(error), true));
}

function setOooStatus(text, isError) {
  const status = $("ooo-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("error", !!isError && !!text);
}

function vacationLocalValue(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(+date)) return "";
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function vacationUtcValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(+date) ? date.toISOString() : "";
}

function syncVacationFields() {
  if (!vacationCache) return;
  const provider = vacationCache.provider;
  const scheduled = $("ooo-mode").value === "scheduled";
  $("ooo-schedule").hidden = !scheduled;
  $("ooo-subject-label").hidden = provider === "microsoft";
  $("ooo-audience-label").hidden = provider === "imap";
  const none = $("ooo-audience").querySelector('option[value="none"]');
  if (none) none.hidden = provider !== "microsoft";
  $("ooo-external-label").hidden = provider !== "microsoft";
  $("ooo-domain-label").hidden = provider !== "google";
  const caption = $("ooo-message-caption");
  if (caption) caption.textContent = provider === "microsoft" ? "Reply within your organization" : "Reply message";
  const scheduledOption = $("ooo-mode").querySelector('option[value="scheduled"]');
  if (scheduledOption) {
    const dated = provider !== "imap" || (vacationCache.extensions || []).includes("date");
    scheduledOption.hidden = !dated;
    if (!dated && $("ooo-mode").value === "scheduled") $("ooo-mode").value = "always";
  }
}

function paintVacation(data) {
  vacationCache = data && data.accountId ? data : null;
  const account = selectedAccount();
  const who = $("ooo-account");
  if (who) who.textContent = account && isLive(account) ? (account.email || account.id) : "Choose a connected mailbox.";
  const view = vacationView(vacationCache);
  const note = $("ooo-note");
  if (note) {
    note.textContent = view.note || "Server-managed automatic replies continue while Morrow is closed. This screen does not send mail.";
  }
  const grant = $("ooo-grant");
  if (grant) grant.hidden = !view.showGrant;
  const link = $("ooo-provider-link");
  const href = vacationLink(vacationCache && vacationCache.providerUrl);
  if (link) {
    link.hidden = !href;
    if (href) link.href = href;
  }
  const fields = $("ooo-fields");
  if (fields) fields.hidden = !view.showForm;
  const help = $("ooo-help");
  if (help) help.textContent = view.help || "";
  if (!vacationCache || !vacationCache.settings || !view.showForm) return;
  const settings = vacationCache.settings;
  $("ooo-mode").value = settings.mode || "disabled";
  $("ooo-subject").value = settings.subject || "";
  $("ooo-message").value = settings.message || "";
  $("ooo-external").value = settings.externalMessage || "";
  $("ooo-audience").value = settings.audience || (vacationCache.provider === "google" ? "all" : "none");
  $("ooo-domain").checked = settings.restrictToDomain === true;
  $("ooo-start").value = vacationLocalValue(settings.start);
  $("ooo-end").value = vacationLocalValue(settings.end);
  syncVacationFields();
  $("ooo-save").textContent = $("ooo-mode").value === "disabled" ? "Save disabled settings…" : "Save and enable…";
  $("ooo-save").disabled = !view.canSave;
  $("ooo-disable").disabled = !view.canDisable;
}

function vacationFormBody(kind) {
  const provider = vacationCache.provider;
  return {
    accountId: vacationCache.accountId,
    action: kind === "disable" ? "disable" : "save",
    confirmed: true,
    revision: vacationCache.revision,
    mode: kind === "disable" ? "disabled" : $("ooo-mode").value,
    subject: $("ooo-subject").value,
    message: $("ooo-message").value,
    externalMessage: $("ooo-external").value,
    audience: provider === "imap" ? "all" : $("ooo-audience").value,
    restrictToDomain: provider === "google" && $("ooo-domain").checked === true,
    start: vacationUtcValue($("ooo-start").value),
    end: vacationUtcValue($("ooo-end").value),
  };
}

async function loadVacation() {
  const account = selectedAccount();
  if (!account || !isLive(account)) {
    vacationCache = null;
    paintVacation(null);
    setOooStatus("Choose a connected mailbox.", false);
    return;
  }
  setOooStatus("Contacting the mail provider…", false);
  const data = await call("mail:vacationGet", { accountId: account.id });
  if (!selectedAccount() || selectedAccount().id !== account.id) return;
  paintVacation(data);
  setOooStatus("", false);
}

async function refreshVacation() {
  if (vacationCache && vacationCache.settings) {
    const draft = vacationDraft({ ...vacationFormBody("save"), provider: vacationCache.provider, confirmed: false, action: "save" });
    const current = vacationCache.settings;
    const dirty = draft.mode !== current.mode
      || draft.subject !== (current.subject || "")
      || draft.message !== (current.message || "")
      || draft.externalMessage !== (current.externalMessage || "")
      || draft.audience !== (current.audience || "all")
      || draft.restrictToDomain !== (current.restrictToDomain === true)
      || $("ooo-start").value !== vacationLocalValue(current.start)
      || $("ooo-end").value !== vacationLocalValue(current.end);
    if (dirty) {
      const answer = await askConfirm({
        title: "Refresh provider settings",
        body: "Discard unsaved automatic reply edits and refresh from the provider?",
        confirm: "Refresh",
        cancel: "Cancel",
        needsName: false,
      });
      if (!answer || !answer.ok) return;
    }
  }
  await loadVacation();
}

async function saveVacation(kind) {
  const account = selectedAccount();
  if (!account || !isLive(account) || !vacationCache || vacationCache.accountId !== account.id) {
    throw new Error("Choose a connected mailbox.");
  }
  const body = vacationFormBody(kind);
  if (kind !== "disable") {
    const draft = vacationDraft({ ...body, provider: vacationCache.provider });
    if (draft.error) throw new Error(draft.error);
  }
  const answer = await askConfirm(vacationConfirm(kind === "disable" ? "disable" : "save", account.email || account.id, {
    provider: vacationCache.provider,
    mode: body.mode,
  }));
  if (!answer || !answer.ok) return;
  const current = selectedAccount();
  if (!current || current.id !== account.id || !vacationCache || vacationCache.accountId !== account.id) {
    throw new Error("Choose a connected mailbox.");
  }
  setOooStatus("Contacting the mail provider…", false);
  const saved = await call("mail:vacationPut", body);
  paintVacation(saved);
  setOooStatus("Saved on the provider.", false);
}

async function grantVacationAccess() {
  const account = selectedAccount();
  if (!account || !isLive(account)) throw new Error("Choose a connected mailbox.");
  const answer = await askConfirm(vacationConfirm("grant", account.email || account.id, {
    provider: vacationProvider(account),
    scope: vacationCache && vacationCache.requiredScope,
  }));
  if (!answer || !answer.ok) return;
  if (!selectedAccount() || selectedAccount().id !== account.id) throw new Error("Choose a connected mailbox.");
  setOooStatus("Waiting for Out of Office settings consent…", false);
  await call("mail:grantVacation", { accountId: account.id });
  await loadVacation();
  setOooStatus("Out of Office settings permission saved.", false);
}

function setAiStatus(text, isError) {
  const status = $("ai-status");
  status.textContent = text || "";
  status.classList.toggle("error", !!isError && !!text);
}

function aiKeyPlaceholder(cfg) {
  if (cfg && cfg.hasKey) return "Saved " + (cfg.keyHint || "••••") + ". Leave blank to keep it.";
  return "sk-…";
}

async function loadAiSettings() {
  setAiStatus("", false);
  $("ai-key").value = "";
  $("ai-model-list").replaceChildren();
  try {
    const cfg = await api.invoke("host:aiGetConfig");
    $("ai-base").value = cfg && cfg.baseUrl ? cfg.baseUrl : "";
    $("ai-model").value = cfg && cfg.model ? cfg.model : "";
    $("ai-key").placeholder = aiKeyPlaceholder(cfg);
  } catch (error) {
    setAiStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function saveAiSettings() {
  setAiStatus("Saving…", false);
  try {
    const saved = await api.invoke("host:aiSaveConfig", {
      baseUrl: $("ai-base").value,
      model: $("ai-model").value,
      apiKey: $("ai-key").value,
    });
    $("ai-key").value = "";
    $("ai-base").value = saved && saved.baseUrl ? saved.baseUrl : $("ai-base").value;
    $("ai-model").value = saved && saved.model ? saved.model : $("ai-model").value;
    $("ai-key").placeholder = aiKeyPlaceholder(saved);
    setAiStatus("Saved.", false);
  } catch (error) {
    setAiStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function fetchAiModels() {
  setAiStatus("Fetching models…", false);
  try {
    const result = await api.invoke("host:aiListModels", {
      baseUrl: $("ai-base").value,
      apiKey: $("ai-key").value,
    });
    if (!result || result.ok !== true) {
      setAiStatus((result && result.message) || "Could not list models.", true);
      return;
    }
    const ids = Array.isArray(result.models) ? result.models : [];
    const list = $("ai-model-list");
    list.replaceChildren();
    for (const id of ids) {
      const option = document.createElement("option");
      option.value = id;
      list.appendChild(option);
    }
    setAiStatus(ids.length ? "Fetched " + ids.length + " models. Pick one or type an id." : "No models returned. Type a model id.", false);
  } catch (error) {
    setAiStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function testAiConnection() {
  setAiStatus("Contacting the model…", false);
  try {
    const result = await api.invoke("host:aiTest");
    if (result && result.ok) setAiStatus("Connected. " + (result.preview || ""), false);
    else setAiStatus((result && result.message) || "Connection failed.", true);
  } catch (error) {
    setAiStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function savePref(row) {
  const [id, getChannel, setChannel, kind] = row;
  const status = $("settings-status");
  try {
    await api.invoke(setChannel, readPref(kind, $(id)));
    applyPref(kind, $(id), await api.invoke(getChannel));
    status.textContent = "";
    status.classList.remove("error");
    if (takePref(getChannel, kind, $(id))) paintPrefs();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("error");
    try {
      applyPref(kind, $(id), await api.invoke(getChannel));
    } catch { /* status already shows the failure */ }
  }
  if (id === "pref-theme" || id === "pref-accent") {
    applyShellTheme(document.documentElement, $("pref-theme").value, $("pref-accent").value);
  }
}

function openSettings() {
  openDialog("settings");
  loadSettings();
}

function brainSections(snapshot) {
  const persona = snapshot && snapshot.persona;
  const sections = persona && persona.profile && persona.profile.sections;
  return Array.isArray(sections) ? sections : [];
}

function brainUserRules(sections) {
  const rules = [];
  const list = Array.isArray(sections) ? sections : [];
  for (const section of list) {
    const rows = section && Array.isArray(section.rows) ? section.rows : [];
    for (const row of rows) {
      if (row && row.source === "user" && row.id) rules.push(row);
    }
  }
  return rules;
}

function brainRowText(row) {
  const label = String((row && row.label) || "").trim();
  const value = String((row && row.value) || "").trim();
  if (label && value) return label + " — " + value;
  return value || label;
}

function brainMessage(view) {
  const state = view || {};
  if (state.error) return { text: String(state.error), error: true };
  if (state.fixing) return { text: "Fixing…", error: false };
  if (state.refreshing || state.rebuilding) {
    const pct = typeof state.percent === "number" ? " " + Math.round(state.percent) + "%" : "";
    const label = state.rebuilding ? "Rebuilding" : "Refreshing";
    return { text: label + pct + "…", error: false };
  }
  if (state.accepted === false) return { text: "Needs an AI key. Open Morrow Mail → AI Setup.", error: true };
  return { text: "", error: false };
}

function brainProfileMeta(snapshot) {
  const persona = snapshot && snapshot.persona;
  const profile = persona && persona.profile;
  const meta = profile && profile.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const rows = [];
  const owner = String(meta.ownerName || "").trim();
  if (owner) rows.push({ key: "ownerName", label: "Owner", value: owner });
  if (typeof meta.emailsAnalyzed === "number" && Number.isFinite(meta.emailsAnalyzed)) {
    rows.push({ key: "emailsAnalyzed", label: "Emails analyzed", value: String(meta.emailsAnalyzed) });
  }
  if (typeof meta.factsLearned === "number" && Number.isFinite(meta.factsLearned)) {
    rows.push({ key: "factsLearned", label: "Facts learned", value: String(meta.factsLearned) });
  }
  const updated = meta.updatedAt == null ? "" : String(meta.updatedAt).trim();
  if (updated) rows.push({ key: "updatedAt", label: "Updated", value: updated });
  return rows;
}

function brainLearnedRow(section, row) {
  if (!row || !row.id || row.source === "user") return false;
  const sectionId = section && section.id;
  if (sectionId === "ai-setup" || sectionId === "recent-mail") return false;
  return row.source === "auto" || row.source === "learned";
}

function inboxRuleFormMode(backend) {
  const kind = backend === "gmail" || backend === "microsoft" || backend === "imap" ? backend : "imap";
  return {
    backend: kind,
    name: kind !== "gmail",
    enabled: kind !== "gmail",
    star: kind !== "microsoft",
    label: kind === "gmail",
    stop: kind !== "gmail",
  };
}

function readInboxRuleForm(fields, backend) {
  const row = fields && typeof fields === "object" ? fields : {};
  const mode = inboxRuleFormMode(backend);
  const attachment = row.attachment === "yes" ? true : row.attachment === "no" ? false : null;
  const labelId = mode.label ? String(row.labelId || "").trim() : "";
  return {
    name: mode.name ? String(row.name || "").trim() : "",
    enabled: mode.enabled ? row.enabled !== false : true,
    match: {
      from: String(row.from || "").trim(),
      to: String(row.to || "").trim(),
      subject: String(row.subject || "").trim(),
      text: String(row.text || "").trim(),
      hasAttachment: attachment,
    },
    actions: {
      markRead: row.markRead === true,
      star: mode.star ? row.star === true : false,
      archive: row.archive === true,
      trash: row.trash === true,
      moveToId: String(row.moveToId || "").trim(),
      addLabelIds: labelId ? [labelId] : [],
      stopProcessing: mode.stop ? row.stopProcessing !== false : false,
    },
  };
}

function inboxRuleSummary(rule) {
  if (!rule || typeof rule !== "object") return "";
  const match = rule.match || {};
  const actions = rule.actions || {};
  const parts = [];
  if (match.from) parts.push("From " + match.from);
  if (match.to) parts.push("To " + match.to);
  if (match.subject) parts.push("Subject " + match.subject);
  if (match.text) parts.push("Text " + match.text);
  if (match.hasAttachment === true) parts.push("Has attachment");
  if (match.hasAttachment === false) parts.push("No attachment");
  const verbs = [];
  if (actions.markRead) verbs.push("Mark read");
  if (actions.star) verbs.push("Star");
  if (actions.archive) verbs.push("Archive");
  if (actions.trash) verbs.push("Trash");
  if (actions.moveToId) verbs.push("Move");
  if (Array.isArray(actions.addLabelIds) && actions.addLabelIds.length) verbs.push("Label");
  const left = parts.join(", ") || "Match";
  const right = verbs.join(", ") || "No action";
  const name = String(rule.name || "").trim();
  const line = name ? name + " — " + left + " → " + right : left + " → " + right;
  if (rule.enabled === false) return "Off. " + line;
  if (rule.unsupported) return line + " — provider action";
  return line;
}

let inboxRulesState = { api: false, backend: "", rules: [], destinations: [], reason: "", message: "" };
let inboxRuleEditId = "";
let inboxRulesBusy = false;

function brainPaneIds() {
  return [
    ["profile", "brain-profile"],
    ["categories", "brain-categories"],
    ["skills", "brain-skills"],
    ["rules", "brain-rules"],
  ];
}

function formatBrainTime(value) {
  const text = String(value || "").trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) return text;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return text;
  }
}

function brainRefreshChannels() {
  return ["emailBrain:refresh", "emailBrain:rebuild"];
}

function blankCategory(category, index) {
  const row = category && typeof category === "object" ? category : {};
  const fallback = "cat-" + ((index || 0) + 1);
  const id = String(row.id || fallback).trim().slice(0, 80);
  return {
    id: id || fallback,
    name: String(row.name || "").trim().slice(0, 80),
    description: String(row.description || "").trim().slice(0, 400),
    collapseView: row.collapseView === true,
  };
}

function categoryLine(category) {
  const row = blankCategory(category, 0);
  const view = row.collapseView ? "collapsed" : "shown";
  return row.id + " — " + row.name + " — " + row.description + " — " + view;
}

function readCategoryPayload(data) {
  const payload = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const categories = Array.isArray(data) ? data : payload.categories;
  const defaults = payload.defaultCategories;
  return {
    categories: (Array.isArray(categories) ? categories : []).map((row, index) => blankCategory(row, index)),
    defaults: (Array.isArray(defaults) ? defaults : []).map((row, index) => blankCategory(row, index)),
  };
}

function upsertCategory(list, draft, index) {
  const rows = (Array.isArray(list) ? list : []).map((row, i) => blankCategory(row, i));
  const next = blankCategory(draft, rows.length);
  if (!next.name) return { categories: rows, error: "A category needs a name." };
  if (Number.isInteger(index) && index >= 0 && index < rows.length) {
    next.id = rows[index].id;
    rows[index] = next;
  } else {
    rows.push(next);
  }
  return { categories: rows, error: "" };
}

function removeCategory(list, index) {
  const rows = (Array.isArray(list) ? list : []).map((row, i) => blankCategory(row, i));
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return rows;
  return rows.filter((_row, i) => i !== index);
}

function categoryFromCommand(data) {
  const command = data && data.command;
  if (!command || command.kind !== "add_category") return null;
  const row = blankCategory(command, 0);
  return row.name ? row : null;
}

function categoryFromFix(data) {
  const category = data && data.category;
  if (!category || typeof category !== "object" || Array.isArray(category)) return null;
  const row = blankCategory(category, 0);
  return row.name ? row : null;
}

function showInboxRuleStatus(text, isError) {
  const node = $("inbox-rules-status");
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("error", !!isError);
}

function inboxRuleFieldsFromForm() {
  return {
    name: $("inbox-rule-name").value,
    enabled: $("inbox-rule-enabled").checked,
    from: $("inbox-rule-from").value,
    to: $("inbox-rule-to").value,
    subject: $("inbox-rule-subject").value,
    text: $("inbox-rule-text").value,
    attachment: $("inbox-rule-attachment").value,
    markRead: $("inbox-rule-read").checked,
    star: $("inbox-rule-star").checked,
    archive: $("inbox-rule-archive").checked,
    trash: $("inbox-rule-trash").checked,
    stopProcessing: $("inbox-rule-stop").checked,
    moveToId: $("inbox-rule-move").value,
    labelId: $("inbox-rule-label").value,
  };
}

function fillInboxRuleSelect(id, rows, placeholder) {
  const select = $(id);
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = placeholder;
  select.append(blank);
  for (const row of rows || []) {
    if (!row || !row.id || !row.name) continue;
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = row.name;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function clearInboxRuleForm() {
  inboxRuleEditId = "";
  $("inbox-rule-name").value = "";
  $("inbox-rule-enabled").checked = true;
  $("inbox-rule-from").value = "";
  $("inbox-rule-to").value = "";
  $("inbox-rule-subject").value = "";
  $("inbox-rule-text").value = "";
  $("inbox-rule-attachment").value = "";
  $("inbox-rule-read").checked = false;
  $("inbox-rule-star").checked = false;
  $("inbox-rule-archive").checked = false;
  $("inbox-rule-trash").checked = false;
  $("inbox-rule-stop").checked = true;
  $("inbox-rule-move").value = "";
  $("inbox-rule-label").value = "";
  paintInboxRuleForm();
}

function paintInboxRuleForm() {
  const backend = inboxRulesState && inboxRulesState.backend;
  const mode = inboxRuleFormMode(backend);
  const granted = !!(inboxRulesState && inboxRulesState.api);
  $("inbox-rule-name-field").hidden = !mode.name;
  $("inbox-rule-enabled-field").hidden = !mode.enabled;
  $("inbox-rule-star-field").hidden = !mode.star;
  $("inbox-rule-stop-field").hidden = !mode.stop;
  $("inbox-rule-label-field").hidden = !mode.label;
  $("inbox-rule-form").hidden = !granted;
  $("inbox-rule-save").textContent = inboxRuleEditId ? "Save rule" : "Add rule";
  $("inbox-rule-cancel").hidden = !inboxRuleEditId;
  const grant = $("inbox-rule-grant");
  const needsGrant = !granted && inboxRulesState && (inboxRulesState.backend === "gmail" || inboxRulesState.backend === "microsoft");
  grant.hidden = !needsGrant;
  grant.textContent = inboxRulesState && inboxRulesState.backend === "microsoft" ? "Grant Outlook rules" : "Grant Gmail filters";
}

function paintInboxRules() {
  const data = inboxRulesState || {};
  const note = $("inbox-rules-note");
  if (note && data.message) note.textContent = data.message;
  fillInboxRuleSelect("inbox-rule-move", data.destinations, "Do not move");
  fillInboxRuleSelect("inbox-rule-label", data.destinations, "No extra label");
  const root = $("inbox-rules-list");
  root.replaceChildren();
  const rows = Array.isArray(data.rules) ? data.rules : [];
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = data.api ? "No inbox rules yet." : "";
    if (empty.textContent) root.append(empty);
  }
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "inbox-rule-row";
    const text = document.createElement("p");
    text.textContent = inboxRuleSummary(row);
    line.append(text);
    if (row.editable !== false) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost";
      edit.textContent = "Edit";
      edit.setAttribute("aria-label", "Edit " + (inboxRuleSummary(row) || "rule"));
      edit.addEventListener("click", () => startInboxRuleEdit(row));
      line.append(edit);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete " + (inboxRuleSummary(row) || "rule"));
    del.addEventListener("click", () => {
      deleteInboxRule(row.id).catch((error) => {
        showInboxRuleStatus(error instanceof Error ? error.message : String(error), true);
      });
    });
    line.append(del);
    root.append(line);
  }
  paintInboxRuleForm();
}

function startInboxRuleEdit(row) {
  if (!row || row.editable === false) return;
  inboxRuleEditId = row.id || "";
  const match = row.match || {};
  const actions = row.actions || {};
  $("inbox-rule-name").value = row.name || "";
  $("inbox-rule-enabled").checked = row.enabled !== false;
  $("inbox-rule-from").value = match.from || "";
  $("inbox-rule-to").value = match.to || "";
  $("inbox-rule-subject").value = match.subject || "";
  $("inbox-rule-text").value = match.text || "";
  $("inbox-rule-attachment").value = match.hasAttachment === true ? "yes" : match.hasAttachment === false ? "no" : "";
  $("inbox-rule-read").checked = actions.markRead === true;
  $("inbox-rule-star").checked = actions.star === true;
  $("inbox-rule-archive").checked = actions.archive === true;
  $("inbox-rule-trash").checked = actions.trash === true;
  $("inbox-rule-stop").checked = actions.stopProcessing !== false;
  paintInboxRules();
  if ([...$("inbox-rule-move").options].some((option) => option.value === (actions.moveToId || ""))) {
    $("inbox-rule-move").value = actions.moveToId || "";
  }
  const label = Array.isArray(actions.addLabelIds) ? actions.addLabelIds[0] || "" : "";
  if ([...$("inbox-rule-label").options].some((option) => option.value === label)) {
    $("inbox-rule-label").value = label;
  }
  $("inbox-rule-save").textContent = "Save rule";
  $("inbox-rule-cancel").hidden = false;
}

async function loadInboxRules() {
  const account = selectedAccount();
  if (!account) {
    inboxRulesState = {
      api: false,
      backend: "",
      reason: "no_account",
      message: "Connect an account to add inbox rules.",
      rules: [],
      destinations: [],
    };
    paintInboxRules();
    return;
  }
  const data = await call("mail:listInboxRules", { accountId: account.id });
  inboxRulesState = data || inboxRulesState;
  paintInboxRules();
}

async function submitInboxRule(event) {
  event.preventDefault();
  if (inboxRulesBusy) return;
  const account = selectedAccount();
  if (!account) {
    showInboxRuleStatus("Connect an account to add inbox rules.", true);
    return;
  }
  const draft = readInboxRuleForm(inboxRuleFieldsFromForm(), inboxRulesState && inboxRulesState.backend);
  if (inboxRuleEditId) draft.id = inboxRuleEditId;
  inboxRulesBusy = true;
  showInboxRuleStatus("Saving…", false);
  try {
    await call("mail:saveInboxRule", { accountId: account.id, rule: draft });
    clearInboxRuleForm();
    showInboxRuleStatus("Saved.", false);
    await loadInboxRules();
  } catch (error) {
    showInboxRuleStatus(error instanceof Error ? error.message : String(error), true);
    try { await loadInboxRules(); } catch { /* keep the save error */ }
  } finally {
    inboxRulesBusy = false;
  }
}

async function deleteInboxRule(id) {
  const account = selectedAccount();
  if (!account || !id) return;
  if (!window.confirm("Delete this inbox rule?")) return;
  await call("mail:deleteInboxRule", { accountId: account.id, ruleId: id });
  if (inboxRuleEditId === id) clearInboxRuleForm();
  showInboxRuleStatus("Deleted.", false);
  await loadInboxRules();
}

async function grantInboxRules() {
  const account = selectedAccount();
  if (!account) throw new Error("Connect an account to add inbox rules.");
  showInboxRuleStatus("Waiting for the browser…", false);
  await call("mail:grantRules", { accountId: account.id });
  showInboxRuleStatus("Granted.", false);
  await loadInboxRules();
}

function openInboxRules() {
  closeDialog("settings");
  if (state.view !== "brain") openBrain("rules");
  else showBrainPane("rules");
}

function showBrainPane(name) {
  const panes = brainPaneIds();
  const known = panes.some((row) => row[0] === name);
  const next = known ? name : "profile";
  for (const row of panes) {
    const on = row[0] === next;
    const tab = $("brain-tab-" + row[0]);
    const panel = $(row[1]);
    if (tab) {
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    }
    if (panel) panel.hidden = !on;
  }
  if (next === "rules") {
    loadInboxRules().catch((error) => {
      showInboxRuleStatus(error instanceof Error ? error.message : String(error), true);
    });
  }
}

function defaultCategoryHint(defaults) {
  const names = (Array.isArray(defaults) ? defaults : [])
    .map((row) => String((row && row.name) || "").trim())
    .filter(Boolean);
  return names.length ? "Defaults: " + names.join(", ") + "." : "";
}

function paintBrainProgress(view) {
  const bar = $("brain-progress");
  if (!bar) return;
  const active = !!(view && (view.refreshing || view.rebuilding) && !view.error);
  const pct = view && typeof view.percent === "number" ? Math.max(0, Math.min(100, Math.round(view.percent))) : 0;
  bar.hidden = !active;
  bar.setAttribute("aria-valuenow", String(active ? pct : 0));
  const fill = bar.firstElementChild;
  if (fill) fill.style.width = (active ? pct : 0) + "%";
}

function paintBrainMeta(snapshot) {
  const root = $("brain-meta");
  if (!root) return;
  root.replaceChildren();
  const rows = brainProfileMeta(snapshot);
  root.hidden = rows.length === 0;
  for (const row of rows) {
    const term = document.createElement("dt");
    term.textContent = row.label;
    const detail = document.createElement("dd");
    detail.textContent = row.key === "updatedAt" ? formatBrainTime(row.value) : row.value;
    root.append(term, detail);
  }
}

function paintBrain(snapshot, view) {
  const message = brainMessage(view);
  const status = $("brain-status");
  status.textContent = message.text;
  status.classList.toggle("error", message.error);
  paintBrainProgress(view);
  paintBrainMeta(snapshot);
  paintBrainActivity(snapshot);
  const root = $("brain-sections");
  root.replaceChildren();
  const sections = brainSections(snapshot);
  if (!sections.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No writing rules yet.";
    root.appendChild(empty);
  }
  for (const section of sections) {
    const block = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = section.title || "Section";
    block.appendChild(title);
    const rows = Array.isArray(section.rows) ? section.rows : [];
    if (!rows.length && section.id === "how-you-write") {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No writing rules yet.";
      block.appendChild(empty);
    }
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "brain-row";
      const text = document.createElement("p");
      text.textContent = brainRowText(row);
      line.appendChild(text);
      if (row && row.source === "user" && row.id) {
        const name = brainRowText(row).slice(0, 80);
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "ghost";
        edit.textContent = "Edit";
        edit.setAttribute("aria-label", "Edit " + name);
        edit.addEventListener("click", () => startBrainEdit(row));
        const del = document.createElement("button");
        del.type = "button";
        del.className = "ghost";
        del.textContent = "Delete";
        del.setAttribute("aria-label", "Delete " + name);
        del.addEventListener("click", () => {
          deleteBrainRule(row.id).catch((error) => {
            brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
            paintBrain(brainSnapshot, brainView);
          });
        });
        const actions = document.createElement("div");
        actions.className = "row brain-actions";
        actions.append(edit, del);
        line.appendChild(actions);
      } else if (brainLearnedRow(section, row)) {
        const name = brainRowText(row).slice(0, 80);
        const actions = document.createElement("div");
        actions.className = "row brain-actions";
        const fix = document.createElement("button");
        fix.type = "button";
        fix.className = "ghost";
        fix.textContent = "Fix";
        fix.setAttribute("aria-label", "Fix " + name);
        fix.disabled = brainFixBusy;
        fix.addEventListener("click", () => {
          fixBrainItem(row);
        });
        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "ghost";
        forget.textContent = "Forget";
        forget.setAttribute("aria-label", "Forget " + name);
        forget.disabled = brainFixBusy;
        forget.addEventListener("click", () => {
          forgetBrainItem(row);
        });
        actions.append(fix, forget);
        line.appendChild(actions);
      }
      block.appendChild(line);
    }
    root.appendChild(block);
  }
  const busy = brainFixBusy || !!(view && (view.refreshing || view.rebuilding || view.fixing));
  $("brain-add").textContent = brainEditId ? "Save" : "Add";
  $("brain-cancel").hidden = !brainEditId;
  $("brain-refresh").disabled = busy;
  $("brain-rebuild").disabled = busy;
}

function paintBrainActivity(snapshot) {
  const wrap = $("brain-activity");
  const root = $("brain-activity-list");
  if (!wrap || !root) return;
  const persona = snapshot && snapshot.persona;
  const rows = persona && Array.isArray(persona.recentActivity) ? persona.recentActivity : [];
  root.replaceChildren();
  wrap.hidden = rows.length === 0;
  for (const row of rows) {
    const line = document.createElement("p");
    const when = row && row.at ? formatBrainTime(row.at) : "";
    const detail = String((row && row.detail) || (row && row.kind) || "").trim();
    line.textContent = [when, detail].filter(Boolean).join(" — ");
    root.appendChild(line);
  }
}

function startBrainEdit(row) {
  brainEditId = row.id;
  $("brain-rule").value = String(row.value || "");
  $("brain-add").textContent = "Save";
  $("brain-cancel").hidden = false;
  $("brain-rule").focus();
}

function clearBrainEdit() {
  brainEditId = "";
  $("brain-rule").value = "";
  if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
}

async function loadBrain() {
  brainSnapshot = await call("emailBrain:getCached");
  if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
}

function showCategoryStatus(text, isError) {
  const el = $("brain-category-status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError && !!text);
}

function resetCategoryForm() {
  brainCategoryIndex = -1;
  $("brain-category-name").value = "";
  $("brain-category-description").value = "";
  $("brain-category-collapse").checked = false;
}

function paintCategories() {
  const root = $("brain-category-list");
  root.replaceChildren();
  const hint = $("brain-category-defaults");
  hint.textContent = defaultCategoryHint(brainCategoryDefaults);
  const defaultsBtn = $("brain-category-defaults-btn");
  defaultsBtn.hidden = brainCategoryDefaults.length === 0;
  defaultsBtn.disabled = !brainCategoriesReady || brainCategoryBusy;
  if (!brainCategories.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = brainCategoriesReady ? "No categories." : "Loading categories…";
    root.appendChild(empty);
  }
  brainCategories.forEach((category, index) => {
    const line = document.createElement("div");
    line.className = "brain-row";
    const text = document.createElement("p");
    text.textContent = categoryLine(category);
    line.appendChild(text);
    const name = String(category.name || category.id || "category").slice(0, 80);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit category " + name);
    edit.disabled = !brainCategoriesReady || brainCategoryBusy;
    edit.addEventListener("click", () => startCategoryEdit(index));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete category " + name);
    del.disabled = !brainCategoriesReady || brainCategoryBusy;
    del.addEventListener("click", () => deleteLocalCategory(index));
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "ghost";
    fix.textContent = "Fix";
    fix.setAttribute("aria-label", "Fix category " + name);
    fix.disabled = !brainCategoriesReady || brainCategoryBusy;
    fix.addEventListener("click", () => {
      fixBrainCategory(category);
    });
    const up = document.createElement("button");
    up.type = "button";
    up.className = "ghost";
    up.textContent = "Up";
    up.setAttribute("aria-label", "Move " + name + " up");
    up.disabled = lockedMove(index) || index === 0;
    up.addEventListener("click", () => moveCategory(index, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "ghost";
    down.textContent = "Down";
    down.setAttribute("aria-label", "Move " + name + " down");
    down.disabled = lockedMove(index) || index === brainCategories.length - 1;
    down.addEventListener("click", () => moveCategory(index, 1));
    const actions = document.createElement("div");
    actions.className = "row brain-actions";
    actions.append(up, down, edit, fix, del);
    line.appendChild(actions);
    line.draggable = !lockedMove(index);
    line.addEventListener("dragstart", () => {
      brainDragIndex = index;
    });
    line.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    line.addEventListener("drop", (event) => {
      event.preventDefault();
      reorderCategories(brainDragIndex, index);
      brainDragIndex = -1;
    });
    root.appendChild(line);
  });
  const locked = !brainCategoriesReady || brainCategoryBusy;
  $("brain-category-add").textContent = brainCategoryIndex >= 0 ? "Update" : "Add";
  $("brain-category-add").disabled = locked;
  $("brain-category-cancel").hidden = brainCategoryIndex < 0;
  $("brain-category-save").disabled = locked;
  $("brain-category-ai").disabled = locked;
}

function lockedMove(index) {
  return !brainCategoriesReady || brainCategoryBusy || !Number.isInteger(index);
}

function moveCategory(index, delta) {
  reorderCategories(index, index + delta);
}

function reorderCategories(from, to) {
  if (!brainCategoriesReady || brainCategoryBusy) return;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from < 0 || to < 0 || from >= brainCategories.length || to >= brainCategories.length || from === to) return;
  const rows = brainCategories.slice();
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  brainCategories = rows;
  if (brainCategoryIndex === from) brainCategoryIndex = to;
  else if (from < brainCategoryIndex && to >= brainCategoryIndex) brainCategoryIndex -= 1;
  else if (from > brainCategoryIndex && to <= brainCategoryIndex) brainCategoryIndex += 1;
  showCategoryStatus("Save to keep this list.", false);
  paintCategories();
}

function startCategoryEdit(index) {
  const row = brainCategories[index];
  if (!row) return;
  brainCategoryIndex = index;
  $("brain-category-name").value = row.name;
  $("brain-category-description").value = row.description;
  $("brain-category-collapse").checked = row.collapseView === true;
  paintCategories();
  $("brain-category-name").focus();
}

function deleteLocalCategory(index) {
  if (!brainCategoriesReady) return;
  const editing = brainCategoryIndex;
  brainCategories = removeCategory(brainCategories, index);
  if (editing === index) resetCategoryForm();
  else if (editing > index) brainCategoryIndex = editing - 1;
  showCategoryStatus("Save to keep this list.", false);
  paintCategories();
}

function submitCategory(event) {
  event.preventDefault();
  if (!brainCategoriesReady) return;
  const existing = brainCategoryIndex >= 0 ? brainCategories[brainCategoryIndex] : null;
  const draft = {
    id: existing ? existing.id : "cat-" + Date.now().toString(36),
    name: $("brain-category-name").value,
    description: $("brain-category-description").value,
    collapseView: $("brain-category-collapse").checked,
  };
  const next = upsertCategory(brainCategories, draft, brainCategoryIndex);
  if (next.error) {
    showCategoryStatus(next.error, true);
    return;
  }
  brainCategories = next.categories;
  resetCategoryForm();
  showCategoryStatus("Save to keep this list.", false);
  paintCategories();
}

function useDefaultCategories() {
  if (!brainCategoriesReady || !brainCategoryDefaults.length) return;
  brainCategories = brainCategoryDefaults.map((row, index) => blankCategory(row, index));
  resetCategoryForm();
  showCategoryStatus("Defaults loaded. Save to keep them.", false);
  paintCategories();
}

async function loadBrainCategories(gen) {
  const parsed = readCategoryPayload(await call("emailBrain:getCategories"));
  if (gen !== brainCategoryGen) return;
  brainCategories = parsed.categories;
  brainCategoryDefaults = parsed.defaults;
  brainCategoriesReady = true;
  if (brainIsOpen()) paintCategories();
}

async function saveBrainCategories() {
  if (!brainCategoriesReady) return;
  const wasEmpty = brainCategories.length === 0;
  await call("emailBrain:saveCategories", { categories: brainCategories });
  const gen = brainCategoryGen;
  const parsed = readCategoryPayload(await call("emailBrain:getCategories"));
  if (gen !== brainCategoryGen) return;
  brainCategories = parsed.categories;
  brainCategoryDefaults = parsed.defaults;
  resetCategoryForm();
  // shortcut: an empty save reads back as the host defaults, change readStore if an empty list must stick
  showCategoryStatus(wasEmpty ? "Saved. An empty list uses the defaults." : "Saved.", false);
  paintCategories();
  const home = await call("nativeAgent:home:refreshTaxonomy");
  if (state.view === "agent") {
    paintAgent(home, "");
    await loadAgent();
  }
}

async function fixBrainCategory(category) {
  if (!brainCategoriesReady || brainCategoryBusy || !category || !category.id) return;
  brainCategoryBusy = true;
  paintCategories();
  const promptInput = $("brain-category-prompt");
  const typed = promptInput ? promptInput.value.trim() : "";
  const prompt = typed || [category.name, category.description].filter(Boolean).join(". ");
  showCategoryStatus("Fixing category…", false);
  try {
    const data = await call("emailBrain:fixCategory", { itemId: category.id, prompt: prompt });
    const row = categoryFromFix(data);
    if (!row) throw new Error("The model did not return a category.");
    const index = brainCategories.findIndex((item) => item.id === category.id);
    if (index < 0) throw new Error("That category is no longer in the list.");
    const next = upsertCategory(brainCategories, {
      id: category.id,
      name: row.name,
      description: row.description,
      collapseView: row.collapseView,
    }, index);
    if (next.error) throw new Error(next.error);
    brainCategories = next.categories;
    if (promptInput && typed) promptInput.value = "";
    showCategoryStatus("Save to keep this list.", false);
  } catch (error) {
    showCategoryStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    brainCategoryBusy = false;
    paintCategories();
  }
}

async function addCategoryFromPrompt(event) {
  event.preventDefault();
  if (!brainCategoriesReady || brainCategoryBusy) return;
  const prompt = $("brain-category-prompt").value.trim();
  if (!prompt) {
    showCategoryStatus("Describe a category.", true);
    return;
  }
  brainCategoryBusy = true;
  paintCategories();
  try {
    const data = await call("emailBrain:addCategoryViaPrompt", { prompt });
    const row = categoryFromCommand(data);
    if (!row) throw new Error("The model did not return a category.");
    const next = upsertCategory(brainCategories, { ...row, id: "cat-" + Date.now().toString(36) }, -1);
    if (next.error) throw new Error(next.error);
    brainCategories = next.categories;
    $("brain-category-prompt").value = "";
    showCategoryStatus("Save to keep this list.", false);
  } catch (error) {
    showCategoryStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    brainCategoryBusy = false;
    paintCategories();
  }
}

function brainIsOpen() {
  const node = $("brain");
  return !!(node && !node.hidden);
}

function openBrain(pane) {
  const name = typeof pane === "string" ? pane : "profile";
  showPrimary("brain", "brain");
  showBrainPane(name);
  brainCategoriesReady = false;
  brainCategories = [];
  brainCategoryDefaults = [];
  resetCategoryForm();
  $("brain-category-prompt").value = "";
  showCategoryStatus("", false);
  paintCategories();
  const gen = brainCategoryGen += 1;
  loadBrain().then(() => {
    if (state.view !== "brain") return null;
    return requestBrainJob(["emailBrain:refresh"], "refresh", { source: "open" });
  }).catch((error) => {
    brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
    paintBrain(brainSnapshot, brainView);
  });
  loadBrainCategories(gen).catch((error) => {
    if (gen !== brainCategoryGen) return;
    showCategoryStatus(error instanceof Error ? error.message : String(error), true);
  });
  const skillStatus = $("brain-skill-status");
  skillStatus.textContent = "";
  skillStatus.classList.remove("error");
  const skillResult = $("brain-skill-result");
  if (skillResult) skillResult.replaceChildren();
  loadBrainSkills().catch((error) => {
    if (brainIsOpen()) paintBrainSkills({}, error instanceof Error ? error.message : String(error));
  });
}

async function submitBrainRule(event) {
  event.preventDefault();
  const text = $("brain-rule").value.trim();
  const itemId = brainEditId;
  try {
    if (!text) throw new Error("A writing rule needs text");
    if (itemId) await call("emailBrain:setWritingRule", { itemId, text });
    else await call("emailBrain:addWritingRule", { text });
    brainEditId = "";
    $("brain-rule").value = "";
    brainView = { ...brainView, error: "", accepted: null };
    await loadBrain();
  } catch (error) {
    brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
    paintBrain(brainSnapshot, brainView);
  }
}

async function deleteBrainRule(itemId) {
  await call("emailBrain:deleteWritingRule", { itemId });
  if (brainEditId === itemId) {
    brainEditId = "";
    $("brain-rule").value = "";
  }
  brainView = { ...brainView, error: "", accepted: null };
  await loadBrain();
}

async function requestBrainJob(channels, mode, params) {
  const refresh = $("brain-refresh");
  const rebuild = $("brain-rebuild");
  if (refresh) refresh.disabled = true;
  if (rebuild) rebuild.disabled = true;
  brainView = { ...brainView, error: "", fixing: false };
  try {
    let accepted = false;
    let cached = false;
    const list = Array.isArray(channels) && channels.length ? channels : [];
    for (const channel of list) {
      const result = await call(channel, params || {});
      accepted = !!(result && result.accepted);
      cached = !!(result && result.cached);
      if (accepted) break;
    }
    brainView = {
      ...brainView,
      accepted,
      refreshing: accepted && !cached && mode !== "rebuild",
      rebuilding: accepted && mode === "rebuild",
      percent: accepted && !cached ? 15 : null,
      error: "",
    };
  } catch (error) {
    brainView = {
      ...brainView,
      error: error instanceof Error ? error.message : String(error),
      refreshing: false,
      rebuilding: false,
      percent: null,
    };
  }
  if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
}

async function refreshBrain() {
  await requestBrainJob(["emailBrain:refresh"], "refresh", { source: "manual" });
}

async function rebuildBrain() {
  if (!window.confirm("Rebuild Email Brain from scratch? Your writing rules stay. Learned profile rows are replaced.")) return;
  await requestBrainJob(["emailBrain:rebuild"], "rebuild");
}

async function fixBrainItem(row) {
  if (brainFixBusy || !row || !row.id) return;
  brainFixBusy = true;
  brainView = { ...brainView, fixing: true, error: "", accepted: null };
  if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
  try {
    const noteEl = $("brain-fix-note");
    const note = noteEl ? noteEl.value.trim() : "";
    await call("emailBrain:fixItem", {
      itemId: row.id,
      label: String(row.label || ""),
      value: String(row.value || ""),
      prompt: note || "Rewrite this profile row. Keep it short.",
    });
    if (noteEl) noteEl.value = "";
    brainView = { ...brainView, fixing: false, error: "", accepted: null };
    await loadBrain();
  } catch (error) {
    brainView = { ...brainView, fixing: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    brainFixBusy = false;
    if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
  }
}

async function forgetBrainItem(row) {
  if (!row || !row.id) return;
  const name = brainRowText(row).slice(0, 80) || "this row";
  if (!window.confirm("Forget “" + name + "”? This removes it from the profile.")) return;
  try {
    await call("emailBrain:forgetItem", { itemId: row.id });
    if (brainEditId === row.id) {
      brainEditId = "";
      $("brain-rule").value = "";
    }
    brainView = { ...brainView, error: "", accepted: null, fixing: false };
    await loadBrain();
  } catch (error) {
    brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
    if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
  }
}

function onBrainRefreshState(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  brainView = {
    ...brainView,
    refreshing: data.refreshing === true,
    error: data.error ? String(data.error) : "",
  };
  if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
}

function onBrainRebuildState(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  brainView = {
    ...brainView,
    rebuilding: data.rebuilding === true,
    phase: typeof data.phase === "string" ? data.phase : "",
    percent: typeof data.percent === "number" ? data.percent : null,
    error: data.error ? String(data.error) : "",
  };
  if (brainIsOpen()) paintBrain(brainSnapshot, brainView);
}

function onBrainUpdated() {
  if (!brainIsOpen()) return;
  loadBrain().catch((error) => {
    brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
    paintBrain(brainSnapshot, brainView);
  });
}

function skillRows(data) {
  const list = Array.isArray(data) ? data : (data && (data.skills || data.items));
  if (!Array.isArray(list)) return [];
  return list.filter((row) => {
    if (typeof row === "string") return row.trim() !== "";
    return !!row && typeof row === "object" && !Array.isArray(row);
  });
}

function skillLine(row) {
  if (!row || typeof row !== "object") return String(row || "").trim();
  const name = String(row.name || row.title || row.id || "").trim();
  const detail = String(row.description || row.summary || "").trim();
  if (name && detail) return name + " — " + detail;
  return name || detail;
}

function studioLists() {
  return [
    ["studio-home", "nativeAgent:home:skills", "No home skills."],
    ["studio-library", "nativeAgent:home:librarySkills", "No library skills."],
  ];
}

function brainSkillLists() {
  return [
    ["brain-home-skills", "emailBrain:getSkills", "No home skills."],
    ["brain-library-skills", "emailBrain:getLibrarySkills", "No library skills."],
  ];
}

function skillIdOf(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "";
  return String(row.id || "").trim();
}

function skillResultMessage(data) {
  if (!data || data.accepted === false) {
    const err = data && data.error;
    return { text: String(err || "That skill did not run."), error: true };
  }
  const text = String(data.summary || data.text || data.title || "").trim();
  return { text: text || "Done.", error: false };
}

function skillBlocks(data) {
  if (!data || data.accepted === false) return [];
  const blocks = [];
  if (data.summary) blocks.push({ kind: "summary", text: String(data.summary) });
  if (data.note) blocks.push({ kind: "note", text: String(data.note) });
  const sections = Array.isArray(data.sections) ? data.sections : [];
  for (const section of sections) {
    blocks.push({
      kind: "section",
      title: String((section && section.title) || ""),
      items: Array.isArray(section && section.items) ? section.items.map((item) => String(item)) : [],
    });
  }
  return blocks;
}

function agentSections(payload) {
  const sections = payload && payload.sections;
  return Array.isArray(sections) ? sections : [];
}

function agentItemLine(item) {
  const from = String((item && item.from) || "").trim();
  const subject = String((item && item.subject) || "").trim();
  const summary = String((item && item.summary) || "").trim();
  return [from, subject, summary].filter(Boolean).join(" — ");
}

function agentStatusCopy(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  if (data.reason === "needs_key") {
    return { text: String(data.error || "Add an API key in Morrow Mail → AI Setup."), error: true };
  }
  if (data.reason === "needs_mailbox") {
    return { text: String(data.error || "Connect a mailbox. Sample mail is not used."), error: true };
  }
  if (data.reason === "empty") {
    return { text: String(data.error || "The inbox cache is empty. Refresh mail, then triage again."), error: false };
  }
  if (data.accepted === false && data.error) return { text: String(data.error), error: true };
  if (data.stale && data.reason !== "needs_key" && data.reason !== "needs_mailbox") {
    return { text: "Updating suggested todos…", error: false };
  }
  if (data.updatedAt) return { text: "Updated " + data.updatedAt, error: false };
  return { text: "", error: false };
}

function agentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function sectionEmptyCopy(reason) {
  if (reason === "ready" || reason === "empty") return "Nothing in this section.";
  if (reason === "idle") return "Nothing suggested yet.";
  return "";
}

function agentWhen(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function agentFollowUps(item) {
  const follows = Array.isArray(item && item.followUps) ? item.followUps.filter((follow) => follow && follow.messageId) : [];
  const messageId = item && item.messageId ? String(item.messageId) : "";
  if (!messageId) return follows;
  if (follows.some((follow) => follow.kind === "open" && follow.messageId === messageId)) return follows;
  return follows.concat([{ kind: "open", messageId, label: "Open" }]);
}

function agentContextCopy(email) {
  if (!email || !email.id) return "No message is open. Brief This Person can use an email address, or open a message in Mail first.";
  const subject = String(email.subject || "").trim() || "(no subject)";
  const from = String(email.from || "").trim();
  return from ? `Open message: ${from} — ${subject}` : `Open message: ${subject}`;
}

function agentContact(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function skillName(row) {
  if (!row || typeof row !== "object") return String(row || "").trim();
  return String(row.name || row.title || row.id || "").trim();
}

function skillDetail(row) {
  if (!row || typeof row !== "object") return "";
  return String(row.description || row.summary || "").trim();
}

function historyRunView(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const sections = (Array.isArray(run.sections) ? run.sections : []).map((section) => ({
    title: String((section && (section.title || section.name)) || ""),
    items: Array.isArray(section && section.items) ? section.items : [],
  })).filter((section) => section.title || section.items.length);
  return {
    accepted: run.accepted !== false,
    name: String(run.name || run.skillId || "Run"),
    summary: String(run.summary || ""),
    note: String(run.note || ""),
    sections,
    drafts: Array.isArray(run.drafts) ? run.drafts : [],
    followUps: Array.isArray(run.followUps) ? run.followUps : [],
  };
}

function sectionItemsAreMail(section) {
  const items = section && section.items;
  return Array.isArray(items) && items.some((item) => item && typeof item === "object" && item.messageId);
}

function historyLine(run) {
  if (!run || typeof run !== "object") return "";
  const name = String(run.name || run.skillId || "Run").trim();
  const summary = String(run.summary || "").trim();
  if (name && summary) return name + " — " + summary;
  return name || summary;
}

function proposalLine(proposal) {
  if (!proposal || typeof proposal !== "object") return "";
  const subject = String(proposal.subject || proposal.messageId || "").trim();
  const label = String(proposal.labelName || "").trim();
  if (subject && label) return subject + " → " + label;
  return subject || label;
}

function runModeLabel(row) {
  let text = "";
  if (row && (row.schedule === "paused" || row.paused === true)) text = "Paused. It runs only when you ask.";
  else if (row && (row.schedule === "interval" || row.kind === "interval") && Number(row.everyMinutes) > 0) {
    text = "Every " + Number(row.everyMinutes) + " min. Nothing is sent.";
  } else if (row && (row.schedule === "cron" || row.kind === "cron") && row.cron) {
    text = "Cron " + String(row.cron) + ". Nothing is sent.";
  } else if (row && row.schedule === "disabled") text = "Only when I ask. Auto-run is off.";
  else if (row && row.runMode === "on_demand") text = "Only when I ask.";
  if (text && row && row.lastError) return text + " Last run: " + String(row.lastError);
  return text;
}

function scheduleFormValue(input) {
  const source = input && typeof input === "object" ? input : {};
  const kind = String(source.kind || "off").trim();
  if (kind === "off" || kind === "disabled") return { action: "delete" };
  if (kind === "interval") {
    const everyMinutes = Number(source.everyMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 10080) {
      return { error: "Use 1 to 10080 minutes." };
    }
    return {
      action: "save",
      kind: "interval",
      everyMinutes: everyMinutes,
      paused: source.paused === true,
      contactEmail: String(source.contactEmail || "").trim(),
    };
  }
  if (kind === "cron") {
    const cron = String(source.cron || "").trim().replace(/\s+/g, " ");
    if (!cron) return { error: "A cron schedule needs five fields." };
    return {
      action: "save",
      kind: "cron",
      cron: cron,
      paused: source.paused === true,
      contactEmail: String(source.contactEmail || "").trim(),
    };
  }
  return { error: "Pick an interval or a cron schedule." };
}

function skillRequest(row, options) {
  const opts = options && typeof options === "object" ? options : {};
  const payload = { skillId: skillIdOf(row) };
  const account = opts.account;
  if (account && account.id && isLive(account)) payload.accountId = account.id;
  const email = opts.email;
  if (email && email.id) {
    payload.email = {
      id: email.id,
      subject: email.subject || "",
      from: email.from || "",
      snippet: email.snippet || "",
    };
  }
  if (skillIdOf(row) === "brief-this-person") {
    const contact = agentContact(opts.contact);
    if (contact) payload.contactEmail = contact;
  }
  return payload;
}

function skillPayload(row) {
  const email = state.email;
  const account = email
    ? (state.accounts.find((item) => item.id === email.accountId) || selectedAccount())
    : selectedAccount();
  const contact = $("agent-contact");
  return skillRequest(row, {
    account,
    email,
    contact: contact ? contact.value : "",
  });
}

function setSkillStatus(text, isError) {
  for (const id of ["brain-skill-status", "agent-skill-status"]) {
    const status = $(id);
    if (!status) continue;
    status.textContent = text || "";
    status.classList.toggle("error", !!isError && !!text);
  }
}

function followButton(follow, draft) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  const kind = follow ? follow.kind : "draft";
  button.textContent = (follow && follow.label) || (draft ? "Review draft" : "Open");
  button.addEventListener("click", () => {
    const run = kind === "draft" || draft
      ? reviewDraft(draft || follow)
      : openFollowUp((follow && follow.messageId) || "");
    Promise.resolve(run).catch((error) => {
      showStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  return button;
}

function paintSkillBlocks(root, data) {
  if (!root) return;
  root.replaceChildren();
  if (!data || data.accepted === false) return;
  for (const block of skillBlocks(data)) {
    const wrap = document.createElement("div");
    wrap.className = "skill-block";
    if (block.kind === "section") {
      const title = document.createElement("h3");
      title.textContent = block.title || "Notes";
      wrap.appendChild(title);
      for (const item of block.items) {
        const line = document.createElement("p");
        line.textContent = item;
        wrap.appendChild(line);
      }
    } else {
      const line = document.createElement("p");
      line.textContent = block.text;
      wrap.appendChild(line);
    }
    root.appendChild(wrap);
  }
  const drafts = Array.isArray(data.drafts) ? data.drafts : [];
  for (const draft of drafts) {
    const wrap = document.createElement("div");
    wrap.className = "skill-block";
    const line = document.createElement("p");
    line.textContent = draft.subject || "Draft reply";
    wrap.appendChild(line);
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(followButton(null, draft));
    wrap.appendChild(row);
    root.appendChild(wrap);
  }
  const follows = Array.isArray(data.followUps) ? data.followUps : [];
  if (follows.length) {
    const row = document.createElement("div");
    row.className = "row";
    for (const follow of follows) row.appendChild(followButton(follow));
    root.appendChild(row);
  }
  paintProposals(root, data.proposals, true);
}

function paintProposals(root, proposals, append) {
  if (!root) return;
  if (!append) root.replaceChildren();
  const rows = Array.isArray(proposals) ? proposals.filter((item) => item && item.status !== "dismissed" && item.status !== "confirmed") : [];
  if (!rows.length) {
    if (append) return;
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "No moves waiting.";
    root.appendChild(note);
    return;
  }
  for (const proposal of rows) {
    const wrap = document.createElement("div");
    wrap.className = "proposal-row";
    const line = document.createElement("p");
    line.textContent = proposalLine(proposal) || "Proposed move";
    wrap.appendChild(line);
    const actions = document.createElement("div");
    actions.className = "row";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = "Confirm move";
    confirm.addEventListener("click", () => {
      confirmProposal(proposal).then((data) => {
        wrap.remove();
        if (brainIsOpen()) setSkillStatus((data && data.detail) || "Move confirmed.", false);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (brainIsOpen()) setSkillStatus(message, true);
        else showStatus(message, true);
      });
    });
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ghost";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      dismissProposal(proposal).then(() => {
        wrap.remove();
        if (brainIsOpen()) setSkillStatus("Move dismissed.", false);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (brainIsOpen()) setSkillStatus(message, true);
        else showStatus(message, true);
      });
    });
    actions.append(confirm, dismiss);
    wrap.appendChild(actions);
    root.appendChild(wrap);
  }
}

function setAgentSkillStatus(text, isError) {
  const status = $("agent-skill-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("error", !!isError && !!text);
}

function agentCard(item) {
  const card = document.createElement("div");
  card.className = "agent-item";
  if (item && item.unread) card.classList.add("unread");
  const from = document.createElement("p");
  from.className = "agent-from";
  from.textContent = (item && item.from) || "(unknown sender)";
  const subject = document.createElement("p");
  subject.className = "agent-subject";
  subject.textContent = (item && item.subject) || "(no subject)";
  card.append(from, subject);
  const when = agentWhen(item && item.date);
  if (when) {
    const time = document.createElement("p");
    time.className = "hint";
    time.textContent = when;
    card.appendChild(time);
  }
  const summary = String((item && item.summary) || "").trim();
  if (summary) {
    const line = document.createElement("p");
    line.textContent = summary;
    card.appendChild(line);
  }
  if (item && item.hasAttachments) {
    const line = document.createElement("p");
    line.className = "hint";
    line.textContent = "Has an attachment.";
    card.appendChild(line);
  }
  const follows = agentFollowUps(item);
  if (follows.length) {
    const actions = document.createElement("div");
    actions.className = "agent-actions row";
    for (const follow of follows) actions.appendChild(followButton(follow));
    card.appendChild(actions);
  }
  return card;
}

function paintStoredRun(run) {
  const view = historyRunView(run);
  const root = $("agent-result");
  if (!root || !view) return;
  if (!view.accepted) setAgentSkillStatus(view.summary || "That run did not finish.", true);
  else setAgentSkillStatus(view.summary || view.name, false);
  const mailSections = view.sections.filter(sectionItemsAreMail);
  if (mailSections.length) {
    root.replaceChildren();
    for (const section of mailSections) {
      const block = document.createElement("section");
      block.className = "agent-section";
      const title = document.createElement("h3");
      title.textContent = section.title || "Section";
      block.appendChild(title);
      for (const item of section.items) {
        if (item && typeof item === "object" && item.messageId) block.appendChild(agentCard(item));
      }
      root.appendChild(block);
    }
    return;
  }
  paintSkillBlocks(root, {
    accepted: view.accepted,
    summary: view.summary,
    note: view.note,
    sections: view.sections.map((section) => ({
      title: section.title,
      items: section.items.map((item) => (typeof item === "string" ? item : agentItemLine(item))).filter(Boolean),
    })),
    drafts: view.drafts,
    followUps: view.followUps,
  });
}

function paintHistory(root, runs) {
  if (!root) return;
  root.replaceChildren();
  const rows = Array.isArray(runs) ? runs : [];
  if (!rows.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "No runs yet.";
    root.appendChild(note);
    return;
  }
  for (const run of rows.slice(0, 12)) {
    const line = document.createElement("button");
    line.type = "button";
    line.className = "history-row";
    line.textContent = historyLine(run) || "Run";
    line.addEventListener("click", () => {
      showStoredRun(run).catch((error) => setAgentSkillStatus(error instanceof Error ? error.message : String(error), true));
    });
    root.appendChild(line);
  }
}

function scheduleChoice(row) {
  if (!row || row.schedule === "disabled" || !row.schedule) return "off";
  if (row.schedule === "paused") return row.kind === "cron" ? "cron" : "interval";
  if (row.schedule === "cron" || row.schedule === "interval") return row.schedule;
  return "off";
}

function appendSkillSchedule(parent, row) {
  const skillId = skillIdOf(row);
  if (!parent || !skillId) return;
  const name = skillName(row) || skillId;
  const box = document.createElement("div");
  box.className = "skill-schedule";
  const kind = document.createElement("select");
  kind.setAttribute("aria-label", "Schedule " + name);
  const choices = [["off", "Only when I ask"], ["interval", "Every N minutes"], ["cron", "Cron"]];
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice[0];
    option.textContent = choice[1];
    kind.appendChild(option);
  }
  kind.value = scheduleChoice(row);
  const minutes = document.createElement("input");
  minutes.type = "number";
  minutes.min = "1";
  minutes.max = "10080";
  minutes.step = "1";
  minutes.value = row && row.everyMinutes ? String(row.everyMinutes) : "60";
  minutes.setAttribute("aria-label", "Minutes between runs");
  const cron = document.createElement("input");
  cron.type = "text";
  cron.value = row && row.cron ? String(row.cron) : "0 8 * * 1-5";
  cron.spellcheck = false;
  cron.placeholder = "0 8 * * 1-5";
  cron.setAttribute("aria-label", "Cron schedule");
  const contact = document.createElement("input");
  contact.type = "email";
  contact.value = row && row.contactEmail ? String(row.contactEmail) : "";
  contact.spellcheck = false;
  contact.placeholder = "name@example.com";
  contact.setAttribute("aria-label", "Contact email for this schedule");
  const syncFields = () => {
    minutes.hidden = kind.value !== "interval";
    cron.hidden = kind.value !== "cron";
    contact.hidden = skillId !== "brief-this-person" || kind.value === "off";
  };
  kind.addEventListener("change", syncFields);
  syncFields();
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost";
  save.textContent = "Save schedule";
  save.setAttribute("aria-label", "Save schedule for " + name);
  save.addEventListener("click", () => {
    saveSkillSchedule(row, {
      kind: kind.value,
      everyMinutes: Number(minutes.value),
      cron: cron.value,
      contactEmail: contact.value,
    }).catch((error) => {
      setSkillStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  box.append(kind, minutes, cron, contact, save);
  if (row && row.schedule && row.schedule !== "disabled") {
    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "ghost";
    const paused = row.paused === true || row.schedule === "paused";
    pause.textContent = paused ? "Resume" : "Pause";
    pause.setAttribute("aria-label", (paused ? "Resume " : "Pause ") + name);
    pause.addEventListener("click", () => {
      pauseSkillSchedule(row, !paused).catch((error) => {
        setSkillStatus(error instanceof Error ? error.message : String(error), true);
      });
    });
    box.appendChild(pause);
  }
  parent.appendChild(box);
}

async function saveSkillSchedule(row, input) {
  const skillId = skillIdOf(row);
  if (!skillId) throw new Error("That skill has no id.");
  const draft = scheduleFormValue(input);
  if (draft.error) throw new Error(draft.error);
  const name = skillName(row) || skillId;
  if (draft.action === "delete") {
    if (!row || row.schedule === "disabled" || !row.schedule) {
      setSkillStatus(name + " already runs only when you ask.", false);
      return;
    }
    await call("emailBrain:deleteSkillSchedule", { skillId });
    setSkillStatus("Schedule removed. " + name + " runs only when you ask.", false);
  } else {
    const payload = { skillId, kind: draft.kind };
    if (draft.kind === "interval") payload.everyMinutes = draft.everyMinutes;
    if (draft.kind === "cron") payload.cron = draft.cron;
    if (skillId === "brief-this-person") payload.contactEmail = draft.contactEmail;
    await call("emailBrain:setSkillSchedule", payload);
    setSkillStatus("Saved the schedule for " + name + ".", false);
  }
  await Promise.all([loadBrainSkills(), loadStudio()]);
}

async function pauseSkillSchedule(row, paused) {
  const skillId = skillIdOf(row);
  if (!skillId) throw new Error("That skill has no id.");
  await call("emailBrain:setSkillSchedule", { skillId, paused: paused === true });
  const name = skillName(row) || skillId;
  setSkillStatus((paused ? "Paused " : "Resumed ") + name + ".", false);
  await Promise.all([loadBrainSkills(), loadStudio()]);
}

function scheduleEditorFocused() {
  const active = document.activeElement;
  return !!(active && active.closest && active.closest(".skill-schedule"));
}

function onScheduleFired(payload) {
  const name = payload && payload.name ? String(payload.name) : "Skill";
  const accepted = !!(payload && payload.accepted === true);
  const summary = payload && payload.summary ? String(payload.summary) : "";
  const text = accepted
    ? name + " finished in the background." + (summary ? " " + summary : "")
    : String((payload && payload.error) || (name + " did not finish."));
  setSkillStatus(text, !accepted);
  const panel = $("agent-panel");
  if (panel && !panel.hidden) {
    call("nativeAgent:history").then((history) => {
      paintHistory($("agent-history"), history && history.runs);
    }).catch(() => {});
  }
  if (scheduleEditorFocused()) return;
  Promise.all([loadBrainSkills(), loadStudio()]).catch(() => {});
}

function paintSkillList(root, rows, empty, mode) {
  root.replaceChildren();
  if (!rows.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = empty;
    root.appendChild(note);
    return;
  }
  for (const row of rows) {
    const name = skillName(row) || "Skill";
    const detail = skillDetail(row);
    const skillId = skillIdOf(row);
    const wrap = document.createElement("div");
    wrap.className = "studio-row";
    const copy = document.createElement("div");
    copy.className = "studio-copy";
    const title = document.createElement("p");
    title.className = "brain-skill";
    title.textContent = name;
    copy.appendChild(title);
    if (detail && detail !== name) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = detail;
      copy.appendChild(hint);
    }
    const modeLine = document.createElement("p");
    modeLine.className = "hint";
    modeLine.textContent = runModeLabel(row);
    if (modeLine.textContent) copy.appendChild(modeLine);
    wrap.appendChild(copy);
    if (!skillId) {
      root.appendChild(wrap);
      continue;
    }
    const actions = document.createElement("div");
    actions.className = "studio-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = mode === "install" ? "ghost" : "primary";
    button.textContent = mode === "install" ? "Install" : "Run";
    button.setAttribute("aria-label", (mode === "install" ? "Install " : "Run ") + name);
    button.addEventListener("click", () => {
      const action = mode === "install" ? installBrainSkill(row) : runBrainSkill(row);
      action.catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
    });
    actions.appendChild(button);
    if (mode === "run") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove " + name);
      remove.addEventListener("click", () => {
        removeBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.appendChild(remove);
    }
    wrap.appendChild(actions);
    if (mode === "run") appendSkillSchedule(wrap, row);
    root.appendChild(wrap);
  }
}

function paintBrainSkillList(root, rows, empty, mode) {
  root.replaceChildren();
  if (!rows.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = empty;
    root.appendChild(note);
    return;
  }
  for (const row of rows) {
    const skillId = skillIdOf(row);
    const card = document.createElement("article");
    card.className = "brain-skill-card";
    const title = document.createElement("p");
    title.className = "brain-skill";
    const name = row && typeof row === "object" ? String(row.name || row.title || "").trim() : "";
    title.textContent = name || skillLine(row) || "Skill";
    card.appendChild(title);
    const description = row && typeof row === "object" ? String(row.description || "").trim() : "";
    if (description) {
      const detail = document.createElement("p");
      detail.className = "hint";
      detail.textContent = description;
      card.appendChild(detail);
    }
    const demand = runModeLabel(row);
    if (demand) {
      const modeLine = document.createElement("p");
      modeLine.className = "hint";
      modeLine.textContent = demand;
      card.appendChild(modeLine);
    }
    if (!skillId) {
      root.appendChild(card);
      continue;
    }
    const actions = document.createElement("div");
    actions.className = "row brain-skill-actions";
    if (mode === "install") {
      const install = document.createElement("button");
      install.type = "button";
      install.className = "primary";
      install.textContent = "Install";
      install.setAttribute("aria-label", "Install " + title.textContent);
      install.addEventListener("click", () => {
        installBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.appendChild(install);
    } else {
      const run = document.createElement("button");
      run.type = "button";
      run.className = "primary";
      run.textContent = "Run";
      run.disabled = brainSkillBusy;
      run.setAttribute("aria-label", "Run " + title.textContent);
      run.addEventListener("click", () => {
        runBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "Remove";
      remove.disabled = brainSkillBusy;
      remove.setAttribute("aria-label", "Remove " + title.textContent);
      remove.addEventListener("click", () => {
        removeBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.append(run, remove);
    }
    card.appendChild(actions);
    if (mode !== "install") appendSkillSchedule(card, row);
    root.appendChild(card);
  }
}

function paintBrainSkills(lists, errorText) {
  const status = $("brain-skill-status");
  if (errorText) {
    status.textContent = errorText;
    status.classList.add("error");
  }
  const byId = lists || {};
  brainSkillCache = byId;
  for (const [id, , empty] of brainSkillLists()) {
    const mode = id === "brain-library-skills" ? "install" : "run";
    paintBrainSkillList($(id), skillRows(byId[id]), empty, mode);
  }
}

async function reviewDraft(draft) {
  const body = String((draft && (draft.body || draft.text)) || "").trim();
  if (!body) throw new Error("That draft is empty.");
  const email = state.email;
  const account = email
    ? (state.accounts.find((item) => item.id === email.accountId) || selectedAccount())
    : selectedAccount();
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  const seed = email && email.id
    ? composeSeed(email, "reply", self)
    : {
      title: "New message",
      to: (draft && draft.to) || "",
      subject: (draft && draft.subject) || "",
      body: "",
    };
  await openCompose(withSuggestion(seed, body));
}

async function openFollowUp(messageId) {
  if (!messageId) throw new Error("That message is not in the mailbox.");
  if (state.view !== "mail") showMail();
  await openMessage(messageId, true);
}

async function showStoredRun(run) {
  if (run && run.id) {
    applyChatPayload(await call("nativeAgent:chatShow", { runId: run.id }));
    return;
  }
  paintStoredRun(run);
}

async function runBrainSkill(row) {
  const skillId = skillIdOf(row);
  if (!skillId) {
    setSkillStatus("That skill has no id.", true);
    return;
  }
  if (!brainIsOpen() && state.view === "agent") {
    await sendAgentText(skillName(row) || skillId);
    return;
  }
  if (brainSkillBusy) return;
  brainSkillBusy = true;
  setSkillStatus("Running…", false);
  if (brainIsOpen()) paintBrainSkills(brainSkillCache, "");
  try {
    const data = await call("emailBrain:runSkill", skillPayload(row));
    const message = skillResultMessage(data);
    setSkillStatus(message.text, message.error);
    paintSkillBlocks($("brain-skill-result"), data);
    paintSkillBlocks($("agent-result"), data);
    if (data && Array.isArray(data.proposals)) paintProposals($("agent-proposals"), data.proposals);
    if ($("agent-panel") && !$("agent-panel").hidden) {
      const history = await call("nativeAgent:history");
      paintHistory($("agent-history"), history && history.runs);
    }
  } catch (error) {
    setSkillStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    brainSkillBusy = false;
    if (brainIsOpen()) paintBrainSkills(brainSkillCache, "");
  }
}

async function installBrainSkill(row) {
  const skillId = skillIdOf(row);
  if (!skillId) throw new Error("That skill has no id.");
  await call("emailBrain:installSkill", { skillId });
  setSkillStatus("Installed " + (row.name || skillId) + ".", false);
  await Promise.all([loadBrainSkills(), loadStudio()]);
}

async function removeBrainSkill(row) {
  const skillId = skillIdOf(row);
  if (!skillId) throw new Error("That skill has no id.");
  await call("emailBrain:removeSkill", { skillId });
  setSkillStatus("Removed " + (row.name || skillId) + ". It is in the library.", false);
  await Promise.all([loadBrainSkills(), loadStudio()]);
}

async function confirmProposal(proposal) {
  const data = await call("emailBrain:confirmProposal", { proposalId: proposal && proposal.id });
  if (data && data.accepted === false) throw new Error(data.error || "That move was not applied.");
  showStatus((data && data.detail) || "Move confirmed.", false);
  paintProposals($("agent-proposals"), data && data.proposals);
  if ($("agent-panel") && !$("agent-panel").hidden) await loadAgent();
  return data;
}

async function dismissProposal(proposal) {
  const data = await call("emailBrain:dismissProposal", { proposalId: proposal && proposal.id });
  paintProposals($("agent-proposals"), data && data.proposals);
  if ($("agent-panel") && !$("agent-panel").hidden) await loadAgent();
}

async function loadBrainSkills() {
  const lists = {};
  const errors = [];
  for (const [id, channel] of brainSkillLists()) {
    try {
      lists[id] = await call(channel);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (brainIsOpen()) paintBrainSkills(lists, errors.filter(Boolean).join(" "));
}

function paintStudio(lists, errorText) {
  if (errorText) setSkillStatus(errorText, true);
  const byId = lists || {};
  for (const [id, , empty] of studioLists()) {
    const root = $(id);
    if (!root) continue;
    const mode = id === "studio-library" ? "install" : "run";
    paintSkillList(root, skillRows(byId[id]), empty, mode);
  }
  paintSkillChips(skillRows(byId["studio-home"]));
}

function paintSkillChips(rows) {
  const root = $("agent-skill-chips");
  if (!root) return;
  root.replaceChildren();
  for (const row of rows) {
    const name = skillName(row);
    if (!name || !skillIdOf(row)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => {
      sendAgentText(name).catch((error) => setAgentSkillStatus(error instanceof Error ? error.message : String(error), true));
    });
    root.appendChild(button);
  }
}

async function loadStudio() {
  const lists = {};
  const errors = [];
  for (const [id, channel] of studioLists()) {
    try {
      lists[id] = await call(channel);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const panel = $("agent-panel");
  if (panel && !panel.hidden) paintStudio(lists, errors.filter(Boolean).join(" "));
}

function shownProposals(list) {
  const rows = Array.isArray(list) ? list.filter((item) => item && item.status !== "dismissed" && item.status !== "confirmed") : [];
  if (!agentProposalIds) return rows;
  const ids = new Set(agentProposalIds);
  return rows.filter((item) => ids.has(item.id));
}

function appendTriage(root, payload) {
  const reason = payload && payload.reason;
  for (const section of agentSections(payload)) {
    const block = document.createElement("section");
    block.className = "agent-section";
    const title = document.createElement("h3");
    title.textContent = section.name || section.title || "Section";
    block.appendChild(title);
    const items = Array.isArray(section.items) ? section.items : [];
    const empty = sectionEmptyCopy(reason);
    if (!items.length && empty) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = empty;
      block.appendChild(note);
    }
    for (const item of items) {
      if (item && typeof item === "object") block.appendChild(agentCard(item));
      else if (item) {
        const line = document.createElement("p");
        line.textContent = String(item);
        block.appendChild(line);
      }
    }
    root.appendChild(block);
  }
}

function paintTurn(turn) {
  const article = document.createElement("article");
  article.className = "agent-turn " + (turn && turn.role === "user" ? "is-user" : "is-agent");
  if (turn && turn.error) article.classList.add("is-error");
  const who = document.createElement("p");
  who.className = "agent-who";
  who.textContent = turn && turn.role === "user" ? "You" : "Agent";
  article.appendChild(who);
  if (turn && turn.text) {
    const body = document.createElement("p");
    body.textContent = turn.text;
    article.appendChild(body);
  }
  if (turn && turn.kind === "triage" && turn.triage) appendTriage(article, turn.triage);
  else if (turn && turn.role !== "user" && !turn.error) {
    const slot = document.createElement("div");
    paintSkillBlocks(slot, {
      accepted: true,
      note: turn.note,
      sections: Array.isArray(turn.sections) ? turn.sections : [],
      drafts: turn.drafts,
      followUps: turn.followUps,
      proposals: shownProposals(turn.proposals),
    });
    if (slot.childNodes.length) article.appendChild(slot);
  }
  return article;
}

function paintThread() {
  const root = $("agent-sections");
  if (!root) return;
  root.replaceChildren();
  if (!agentTurns.length) {
    const empty = document.createElement("p");
    empty.className = "agent-empty hint";
    empty.textContent = "No messages yet. Ask Morrow Mail, or run a skill. Nothing is sent.";
    root.appendChild(empty);
    return;
  }
  for (const turn of agentTurns) root.appendChild(paintTurn(turn));
  root.scrollTop = root.scrollHeight;
}

function paintAgent(payload, errorText) {
  const status = $("agent-status");
  const copy = errorText ? { text: errorText, error: true } : agentStatusCopy(payload);
  if (status) {
    status.textContent = copy.text;
    status.classList.toggle("error", copy.error);
  }
  const context = $("agent-context");
  if (context) context.textContent = agentContextCopy(state.email);
  if (payload && Array.isArray(payload.proposals)) {
    agentProposalIds = payload.proposals.map((item) => item && item.id).filter(Boolean);
  }
  paintProposals($("agent-proposals"), payload && payload.proposals);
  paintHistory($("agent-history"), payload && payload.runs);
  paintAgentHome(payload);
  paintThread();
}

function paintAgentHome(payload) {
  const root = $("agent-home");
  if (!root) return;
  const greet = $("agent-greeting");
  if (greet) greet.textContent = agentGreeting();
  root.replaceChildren();
  const reason = payload && payload.reason;
  for (const section of agentSections(payload)) {
    const block = document.createElement("section");
    block.className = "agent-section";
    if (section.collapseView) block.classList.add("is-collapsed");
    const items = Array.isArray(section.items) ? section.items : [];
    const title = document.createElement("h3");
    title.textContent = (section.name || section.title || "Section") + (items.length ? " · " + items.length : "");
    block.appendChild(title);
    if (section.description) {
      const desc = document.createElement("p");
      desc.className = "hint";
      desc.textContent = section.description;
      block.appendChild(desc);
    }
    if (section.collapseView && items.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ghost";
      toggle.textContent = "Show";
      toggle.addEventListener("click", () => {
        const collapsed = block.classList.toggle("is-collapsed");
        toggle.textContent = collapsed ? "Show" : "Hide";
      });
      block.appendChild(toggle);
    }
    const empty = sectionEmptyCopy(reason);
    if (!items.length && empty) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = empty;
      block.appendChild(note);
    }
    for (const item of items) {
      if (item && typeof item === "object") block.appendChild(agentTodoCard(item));
    }
    root.appendChild(block);
  }
}

function agentTodoCard(item) {
  const card = agentCard(item);
  const messageId = item && item.messageId ? String(item.messageId) : "";
  if (!messageId) return card;
  const actions = document.createElement("div");
  actions.className = "agent-actions row";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "ghost";
  done.textContent = "Done";
  done.addEventListener("click", () => {
    updateTodo(messageId, "done").catch((error) => paintAgent(null, error instanceof Error ? error.message : String(error)));
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    updateTodo(messageId, "dismissed").catch((error) => paintAgent(null, error instanceof Error ? error.message : String(error)));
  });
  actions.append(done, dismiss);
  card.appendChild(actions);
  return card;
}

async function updateTodo(messageId, status) {
  const data = await call("nativeAgent:home:todoUpdate", { messageId, status });
  paintAgent(data, "");
}

function applyChatPayload(data) {
  if (!data) return;
  if (Array.isArray(data.turns)) agentTurns = data.turns;
  const notes = $("agent-memory");
  if (notes && data.memory && document.activeElement !== notes) notes.value = data.memory.notes || "";
  if (data.triage) paintAgent(data.triage, "");
  else {
    const status = $("agent-status");
    if (status) {
      status.textContent = "";
      status.classList.remove("error");
    }
    if (data.result && Array.isArray(data.result.proposals)) {
      agentProposalIds = data.result.proposals.map((item) => item && item.id).filter(Boolean);
      paintProposals($("agent-proposals"), data.result.proposals);
    }
    paintThread();
  }
  if (data.turn) setAgentSkillStatus(data.turn.text || "", !!data.turn.error);
}

function agentChatRequest(text) {
  const email = state.email;
  const account = email
    ? (state.accounts.find((item) => item.id === email.accountId) || selectedAccount())
    : selectedAccount();
  const payload = { text: String(text || "").trim() };
  if (account && account.id && isLive(account)) payload.accountId = account.id;
  if (email && email.id) {
    payload.email = {
      id: email.id,
      subject: email.subject || "",
      from: email.from || "",
      snippet: email.snippet || "",
    };
  }
  const contact = $("agent-contact");
  const address = agentContact(contact ? contact.value : "");
  if (address) payload.contactEmail = address;
  return payload;
}

function setAgentBusy(busy) {
  agentChatBusy = busy;
  const send = $("agent-send");
  const triage = $("agent-triage");
  const input = $("agent-input");
  if (send) send.disabled = busy;
  if (triage) triage.disabled = busy;
  if (input) input.disabled = busy;
}

async function sendAgentText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || agentChatBusy) return;
  setAgentBusy(true);
  const input = $("agent-input");
  if (input && input.value.trim() === trimmed) input.value = "";
  const status = $("agent-status");
  if (status) {
    status.textContent = "Working…";
    status.classList.remove("error");
  }
  try {
    const data = await call("nativeAgent:chat", agentChatRequest(trimmed));
    applyChatPayload(data);
    if (data && (data.intent === "skill" || data.intent === "triage")) {
      const history = await call("nativeAgent:history");
      paintHistory($("agent-history"), history && history.runs);
    }
  } finally {
    setAgentBusy(false);
  }
}

async function saveAgentMemory() {
  const notes = $("agent-memory");
  const data = await call("nativeAgent:memorySet", { notes: notes ? notes.value : "" });
  if (notes && data && typeof data.notes === "string") notes.value = data.notes;
  const status = $("agent-memory-status");
  if (status) status.textContent = "Notes saved.";
}

async function loadAgent() {
  const gen = ++agentGen;
  const [triage, history, chat] = await Promise.all([
    call("nativeAgent:home:todosCached"),
    call("nativeAgent:history"),
    call("nativeAgent:chatHistory"),
  ]);
  if (gen !== agentGen || state.view !== "agent") return;
  agentTurns = chat && Array.isArray(chat.turns) ? chat.turns : [];
  const notes = $("agent-memory");
  if (notes && document.activeElement !== notes) notes.value = (chat && chat.memory && chat.memory.notes) || "";
  const runs = history && Array.isArray(history.runs) ? history.runs : triage && triage.runs;
  const payload = Object.assign({}, triage, { runs });
  paintAgent(payload, "");
  await loadStudio();
  const reason = triage && triage.reason;
  if (gen !== agentGen || state.view !== "agent") return;
  if (!(triage && triage.stale) || reason === "needs_key" || reason === "needs_mailbox") return;
  const fresh = await call("nativeAgent:triage");
  if (gen !== agentGen || state.view !== "agent") return;
  paintAgent(Object.assign({}, fresh, { runs }), "");
}

async function runTriage() {
  if (agentChatBusy) return;
  setAgentBusy(true);
  try {
    const data = await call("nativeAgent:triage");
    paintAgent(data, "");
  } finally {
    setAgentBusy(false);
  }
}

function stopAgentPoll() {
  if (agentPoll) clearInterval(agentPoll);
  agentPoll = null;
}

function startAgentPoll() {
  stopAgentPoll();
  agentPoll = setInterval(() => {
    if (state.view !== "agent") {
      stopAgentPoll();
      return;
    }
    loadAgent().catch(() => {});
  }, 60000);
}

function markRail(view) {
  state.view = view;
  state.side = view === "mail" ? "folders" : view;
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.dataset.view = view;
  const shell = $("shell");
  if (shell) shell.dataset.side = state.side;
  const current = {
    mail: "rail-mail",
    agent: "rail-agent",
    calendar: "rail-calendar",
    brain: "rail-brain",
  }[view];
  for (const id of ["rail-mail", "rail-agent", "rail-calendar", "rail-brain"]) {
    const node = $(id);
    if (node) node.setAttribute("aria-current", id === current ? "page" : "false");
  }
}

function showPrimary(view, id) {
  const swap = state.view !== view;
  if (view !== "agent") stopAgentPoll();
  markRail(view);
  for (const pane of ["shell", "calendar-panel", "agent-panel", "brain"]) {
    if (pane === id) continue;
    hidePane(pane);
  }
  if (swap) revealPanel(id);
  else {
    const node = $(id);
    if (node) node.hidden = false;
  }
}

function showAgent() {
  showPrimary("agent", "agent-panel");
  const greet = $("agent-greeting");
  if (greet) greet.textContent = agentGreeting();
  startAgentPoll();
  loadAgent().catch((error) => {
    paintAgent(null, error instanceof Error ? error.message : String(error));
  });
}

function closeBrain() {
  brainEditId = "";
  const rule = $("brain-rule");
  if (rule) rule.value = "";
  brainCategoryIndex = -1;
  showMail();
}

function calendarAccount() {
  const rows = state.accounts.filter(isLive);
  return rows.find((account) => account.id === state.calendarAccountId)
    || rows.find((account) => account.id === state.accountId)
    || rows[0]
    || null;
}

function fillCalendarAccounts() {
  const select = $("calendar-account");
  const rows = state.accounts.filter(isLive);
  select.replaceChildren();
  if (!rows.length) {
    select.append(option("", "No mailbox"));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const account of rows) select.append(option(account.id, account.email || account.id));
  const current = calendarAccount();
  if (current) select.value = current.id;
}

function fillCalendarPick(calendars) {
  const select = $("calendar-pick");
  select.replaceChildren();
  for (const calendar of calendars) select.append(option(calendar.id, calendar.name || calendar.id));
  if (state.calendarId && calendars.some((calendar) => calendar.id === state.calendarId)) {
    select.value = state.calendarId;
  } else if (select.value) {
    state.calendarId = select.value;
  }
}

function selectedCalendarEvent(payload) {
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  return events.find((event) => event && event.id === state.calendarEventId) || null;
}

function paintCalendarDetail(event, calendarName) {
  const root = $("calendar-detail");
  if (!root) return;
  root.replaceChildren();
  if (!event) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const title = document.createElement("h3");
  title.textContent = event.title || "(no title)";
  root.appendChild(title);
  const when = document.createElement("p");
  when.textContent = formatEventWhen(event) || "Time not provided.";
  root.appendChild(when);
  if (event.location) {
    const where = document.createElement("p");
    where.textContent = event.location;
    root.appendChild(where);
  }
  if (calendarName) {
    const name = document.createElement("p");
    name.className = "hint";
    name.textContent = calendarName;
    root.appendChild(name);
  }
}

function paintAgenda(events) {
  const root = $("calendar-agenda");
  if (!root) return;
  root.replaceChildren();
  const rows = agendaEvents(events);
  if (!rows.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "No events this month.";
    root.appendChild(note);
    return;
  }
  for (const event of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agenda-item";
    if (event.id === state.calendarEventId) button.classList.add("is-selected");
    button.textContent = agendaLine(event);
    button.addEventListener("click", () => selectCalendarEvent(event));
    root.appendChild(button);
  }
}

function selectCalendarEvent(event) {
  state.calendarEventId = event && event.id ? event.id : "";
  if (state.calendarPayload) paintCalendar(state.calendarPayload);
}

function paintCalendar(payload) {
  const view = calendarView(payload);
  const cursor = state.calendarCursor || new Date();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const range = monthRange(year, month);
  const account = calendarAccount();
  const connection = calendarConnection(state.calendarStatus || state.oauthStatus, account, payload);
  let status = view.status;
  if (!view.showGrid && payload && payload.reason === "needs_auth" && account && account.email) {
    status = calendarCopy("needs_auth", account.email);
  }
  $("calendar-heading").textContent = range.label;
  const statusEl = $("calendar-status");
  statusEl.textContent = status;
  statusEl.classList.toggle("error", view.error === true);
  statusEl.classList.toggle("is-empty", !view.showGrid);
  $("calendar-create").hidden = !view.showForm;
  const grant = $("calendar-grant");
  grant.disabled = !connection.canGrant;
  grant.textContent = connection.label;
  grant.title = connection.canGrant ? "" : connection.reason;
  const layout = $("calendar-layout");
  if (layout) layout.hidden = !view.showGrid;
  const body = $("calendar-body");
  body.replaceChildren();
  if (!view.showGrid) {
    paintCalendarDetail(null, "");
    return;
  }
  fillCalendarPick(view.calendars);
  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", range.label);
  for (const name of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const head = document.createElement("div");
    head.className = "calendar-dow";
    head.textContent = name;
    grid.appendChild(head);
  }
  for (const day of monthCells(year, month)) {
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (!day) {
      cell.classList.add("pad");
      grid.appendChild(cell);
      continue;
    }
    if (sameDay(year, month, day)) cell.classList.add("today");
    const num = document.createElement("span");
    num.className = "calendar-num";
    num.textContent = String(day);
    cell.appendChild(num);
    for (const event of eventsOnDay(view.events, dayKey(year, month, day))) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "calendar-event";
      if (event.id === state.calendarEventId) item.classList.add("is-selected");
      item.textContent = eventChip(event);
      const tip = [event.title || "(no title)", event.location].filter(Boolean).join(" — ");
      if (tip) item.title = tip;
      item.addEventListener("click", () => selectCalendarEvent(event));
      cell.appendChild(item);
    }
    grid.appendChild(cell);
  }
  body.appendChild(grid);
  paintAgenda(view.events);
  const selected = selectedCalendarEvent(payload);
  paintCalendarDetail(selected, calendarNameOf(view.calendars, (selected && selected.calendarId) || state.calendarId));
}

async function loadCalendar() {
  const gen = ++calendarGen;
  fillCalendarAccounts();
  const account = calendarAccount();
  let calStatus = state.oauthStatus;
  try {
    calStatus = await call("calendar:status");
  } catch {
    // The month list still says when the grant is missing.
  }
  if (gen !== calendarGen) return;
  state.calendarStatus = calStatus;
  if (!account) {
    state.calendarPayload = { api: false, reason: "no_account", events: [], calendars: [] };
    paintCalendar(state.calendarPayload);
    return;
  }
  state.calendarAccountId = account.id;
  const cursor = state.calendarCursor || new Date();
  state.calendarCursor = cursor;
  const range = monthRange(cursor.getFullYear(), cursor.getMonth());
  try {
    const payload = await call("calendar:list", {
      accountId: account.id,
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      calendarId: state.calendarId || undefined,
    });
    if (gen !== calendarGen) return;
    if (payload && payload.calendarId) state.calendarId = payload.calendarId;
    const events = Array.isArray(payload && payload.events) ? payload.events : [];
    if (!events.some((event) => event && event.id === state.calendarEventId)) state.calendarEventId = "";
    state.calendarPayload = payload;
    paintCalendar(payload);
  } catch (error) {
    if (gen !== calendarGen) return;
    const message = error instanceof Error ? error.message : String(error);
    state.calendarEventId = "";
    state.calendarPayload = { api: false, reason: "error", message, events: [], calendars: [] };
    paintCalendar(state.calendarPayload);
  }
}

function showMail() {
  showPrimary("mail", "shell");
}

function showCalendar() {
  if (!state.calendarCursor) state.calendarCursor = new Date();
  showPrimary("calendar", "calendar-panel");
  loadCalendar().catch((error) => showStatus(error.message, true));
}

async function grantCalendar() {
  const account = calendarAccount();
  if (!account) throw new Error("Connect a Google or Microsoft mailbox first.");
  showStatus("Waiting for the calendar consent…");
  await call("calendar:connect", { accountId: account.id });
  showStatus("Calendar connected.");
  await loadCalendar();
}

async function submitCalendarEvent(event) {
  event.preventDefault();
  const account = calendarAccount();
  const draft = calendarDraft({
    accountId: account && account.id,
    calendarId: state.calendarId || $("calendar-pick").value,
    title: $("calendar-event-title").value,
    location: $("calendar-location").value,
    start: $("calendar-start").value,
    end: $("calendar-end").value,
  });
  if (draft.error) {
    $("calendar-status").textContent = draft.error;
    $("calendar-status").classList.add("error");
    throw new Error(draft.error);
  }
  await call("calendar:createEvent", draft);
  $("calendar-event-title").value = "";
  $("calendar-location").value = "";
  showStatus("Event saved on the calendar.");
  await loadCalendar();
}

function shiftMonth(delta) {
  const cursor = state.calendarCursor || new Date();
  state.calendarCursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
  loadCalendar().catch((error) => showStatus(error.message, true));
}

function showCalendarToday() {
  state.calendarCursor = new Date();
  state.calendarEventId = "";
  loadCalendar().catch((error) => showStatus(error.message, true));
}

async function loadOauthStatus() {
  try {
    state.oauthStatus = await call("mail:oauthStatus");
  } catch {
    state.oauthStatus = null;
  }
  const google = oauthButtonState(state.oauthStatus, "google");
  $("oauth-google").disabled = google.disabled;
  $("oauth-google").title = google.reason;
}

function wire() {
  document.addEventListener("keydown", onShellKey);
  document.addEventListener("keydown", onSelectionKey);
  wireOrganize();
  wireSelection();
  const motion = motionApi();
  if (motion) motion.bindChrome(document);
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("cancel", (event) => {
      if (dialog.id === "connect") {
        event.preventDefault();
        dismissConnect();
        return;
      }
      if (dialog.id === "compose" && !dismissCompose("cancel")) return;
      const apiMotion = motionApi();
      if (!apiMotion || !apiMotion.wantsCloseMotion()) return;
      event.preventDefault();
      closeDialog(dialog.id);
    });
  }
  $("rail-mail").addEventListener("click", () => {
    showMail();
    const row = $("messages").querySelector(".message");
    if (row) row.focus();
    else $("search-query").focus();
  });
  $("rail-agent").addEventListener("click", showAgent);
  $("rail-brain").addEventListener("click", () => openBrain("profile"));
  $("agent-manage-skills").addEventListener("click", () => openBrain("skills"));
  $("agent-triage").addEventListener("click", () => {
    runTriage().catch((error) => paintAgent(null, error instanceof Error ? error.message : String(error)));
  });
  $("agent-composer").addEventListener("submit", (event) => {
    event.preventDefault();
    sendAgentText($("agent-input").value).catch((error) => {
      paintAgent(null, error instanceof Error ? error.message : String(error));
    });
  });
  $("agent-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    $("agent-composer").requestSubmit();
  });
  $("agent-memory-save").addEventListener("click", () => {
    saveAgentMemory().catch((error) => {
      const status = $("agent-memory-status");
      if (status) status.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  $("rail-calendar").addEventListener("click", showCalendar);
  $("calendar-prev").addEventListener("click", () => shiftMonth(-1));
  $("calendar-next").addEventListener("click", () => shiftMonth(1));
  $("calendar-today").addEventListener("click", showCalendarToday);
  $("calendar-grant").addEventListener("click", () => guard(grantCalendar));
  $("calendar-create").addEventListener("submit", (event) => guard(() => submitCalendarEvent(event)));
  $("calendar-account").addEventListener("change", () => {
    state.calendarAccountId = $("calendar-account").value;
    state.calendarId = "";
    state.calendarEventId = "";
    loadCalendar().catch((error) => showStatus(error.message, true));
  });
  $("calendar-pick").addEventListener("change", () => {
    state.calendarId = $("calendar-pick").value;
    loadCalendar().catch((error) => showStatus(error.message, true));
  });
  wireSplits();
  wireQuoteSplit();
  $("undo").addEventListener("click", () => guard(undoRemoval));
  $("undo-send").addEventListener("click", cancelUndoSend);
  $("profile").addEventListener("change", syncCustomFields);
  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    applySearch();
  });
  $("search-query").addEventListener("search", () => {
    if ($("search-query").value.trim()) return;
    if (!state.query) return;
    applySearch();
  });
  const listFilter = $("list-filter");
  if (listFilter) {
    listFilter.addEventListener("input", () => renderList());
    listFilter.addEventListener("search", () => renderList());
  }
  $("refresh").addEventListener("click", () => guard(refresh));
  $("settings-open").addEventListener("click", openSettings);
  $("inbox-rules-open").addEventListener("click", openInboxRules);
  $("inbox-rule-form").addEventListener("submit", (event) => {
    submitInboxRule(event).catch((error) => {
      showInboxRuleStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  $("inbox-rule-cancel").addEventListener("click", () => {
    clearInboxRuleForm();
    showInboxRuleStatus("", false);
  });
  $("inbox-rule-grant").addEventListener("click", () => {
    grantInboxRules().catch((error) => {
      showInboxRuleStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  $("settings-close").addEventListener("click", () => closeDialog("settings"));
  $("move-picker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    finishMovePick();
  });
  $("move-picker-cancel").addEventListener("click", () => closeMovePicker());
  $("move-picker-filter").addEventListener("input", () => {
    if (!moveSession) return;
    moveSession.query = $("move-picker-filter").value;
    paintMoveTree();
  });
  $("move-picker").addEventListener("keydown", onMovePickerKey);
  $("move-picker").addEventListener("close", () => {
    moveSession = null;
  });
  $("confirm-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitConfirm();
  });
  $("confirm-cancel").addEventListener("click", () => cancelConfirm());
  $("confirm").addEventListener("close", () => {
    if (!confirmResult) return;
    const pending = confirmResult;
    confirmResult = null;
    confirmCopy = null;
    pending({ ok: false, name: "" });
  });
  $("ai-save").addEventListener("click", () => {
    saveAiSettings().catch((error) => setAiStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("ai-fetch").addEventListener("click", () => {
    fetchAiModels().catch((error) => setAiStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("ai-test").addEventListener("click", () => {
    testAiConnection().catch((error) => setAiStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("ooo-mode").addEventListener("change", () => {
    syncVacationFields();
    if (vacationCache) {
      $("ooo-save").textContent = $("ooo-mode").value === "disabled" ? "Save disabled settings…" : "Save and enable…";
    }
  });
  $("ooo-refresh").addEventListener("click", () => {
    guardOoo(() => refreshVacation());
  });
  $("ooo-grant").addEventListener("click", () => {
    guardOoo(() => grantVacationAccess());
  });
  $("ooo-save").addEventListener("click", () => {
    guardOoo(() => saveVacation("save"));
  });
  $("ooo-disable").addEventListener("click", () => {
    guardOoo(() => saveVacation("disable"));
  });
  $("settings").addEventListener("close", () => {
    loadShellPrefs().then(() => {
      paintPrefs();
    }).catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
  });
  for (const row of prefRows()) {
    $(row[0]).addEventListener("change", () => {
      savePref(row);
    });
  }
  $("signatures-open").addEventListener("click", openSignatures);
  $("signatures-close").addEventListener("click", () => closeDialog("signatures"));
  $("signatures").addEventListener("close", () => {
    signatureEditId = "";
  });
  $("signature-cancel").addEventListener("click", clearSignatureForm);
  $("signature-form").addEventListener("submit", (event) => {
    submitSignature(event).catch((error) => {
      showSignatureStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  $("brain-close").addEventListener("click", closeBrain);
  $("brain-category-cancel").addEventListener("click", () => {
    resetCategoryForm();
    paintCategories();
  });
  $("brain-category-form").addEventListener("submit", (event) => {
    submitCategory(event);
  });
  $("brain-category-save").addEventListener("click", () => {
    saveBrainCategories().catch((error) => {
      showCategoryStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  $("brain-category-defaults-btn").addEventListener("click", useDefaultCategories);
  $("brain-category-ai-form").addEventListener("submit", (event) => {
    addCategoryFromPrompt(event).catch((error) => {
      showCategoryStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  $("brain-cancel").addEventListener("click", clearBrainEdit);
  $("brain-tabs").addEventListener("keydown", (event) => {
    const names = brainPaneIds().map((row) => row[0]);
    const current = names.findIndex((name) => $("brain-tab-" + name).getAttribute("aria-selected") === "true");
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    let next = current < 0 ? 0 : current;
    if (event.key === "ArrowRight") next = (next + 1) % names.length;
    if (event.key === "ArrowLeft") next = (next + names.length - 1) % names.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = names.length - 1;
    showBrainPane(names[next]);
    $("brain-tab-" + names[next]).focus();
  });
  for (const name of brainPaneIds().map((row) => row[0])) {
    $("brain-tab-" + name).addEventListener("click", () => showBrainPane(name));
  }
  $("brain-refresh").addEventListener("click", () => {
    refreshBrain().catch((error) => {
      brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
      paintBrain(brainSnapshot, brainView);
    });
  });
  $("brain-rebuild").addEventListener("click", () => {
    rebuildBrain().catch((error) => {
      brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
      paintBrain(brainSnapshot, brainView);
    });
  });
  $("brain-rule-form").addEventListener("submit", (event) => {
    submitBrainRule(event).catch((error) => {
      brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
      paintBrain(brainSnapshot, brainView);
    });
  });
  $("update-check").addEventListener("click", () => {
    checkForUpdates();
  });
  $("update-install").addEventListener("click", () => {
    installUpdate();
  });
  $("connect-open").addEventListener("click", () => openDialog("connect"));
  $("connect-close").addEventListener("click", () => dismissConnect());
  $("connect-form").addEventListener("submit", (event) => {
    event.preventDefault();
    guard(connectImap);
  });
  $("oauth-google").addEventListener("click", () => guard(() => connectOAuth("google")));
  $("oauth-microsoft").addEventListener("click", () => guard(() => connectOAuth("microsoft")));
  $("remove").addEventListener("click", () => guard(removeAccount));
  $("compose-open").addEventListener("click", () => {
    openCompose().catch((error) => showStatus(error.message, true));
  });
  $("signature").addEventListener("change", onSignatureChange);
  $("signatures-from-compose").addEventListener("click", openSignatures);
  $("schedule-preset").addEventListener("change", syncScheduleFields);
  $("compose").addEventListener("close", () => stopDraftWrite());
  $("compose-close").addEventListener("click", () => {
    if (dismissCompose("close")) closeDialog("compose");
  });
  $("ai-generate").addEventListener("click", () => {
    startDraftWrite().catch((error) => showStatus(error.message, true));
  });
  $("ai-cancel").addEventListener("click", () => {
    cancelDraftWrite().catch((error) => showStatus(error.message, true));
  });
  $("ai-prompt").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    startDraftWrite().catch((error) => showStatus(error.message, true));
  });
  $("compose-save").addEventListener("click", () => guard(saveDraft));
  $("compose-schedule").addEventListener("click", () => guard(scheduleMail));
  $("compose-form").addEventListener("submit", (event) => {
    event.preventDefault();
    guard(sendMail);
  });
}

function watchNetwork() {
  if (!api || typeof navigator === "undefined") return;
  const send = () => {
    api.invoke("mail:setOnline", { online: navigator.onLine !== false }).catch(() => {});
  };
  window.addEventListener("online", send);
  window.addEventListener("offline", send);
  send();
}

async function boot() {
  if (!api) {
    showStatus("Mail preload is unavailable.", true);
    return;
  }
  wire();
  watchNetwork();
  api.on("mail:accountsUpdated", onAccountsUpdated);
  api.on("mail:emailsUpdated", () => scheduleReload());
  api.on("mail:syncStatus", (payload) => {
    state.sync = payload || null;
    if (state.query) return;
    const label = syncStatusLabel(payload);
    if (!label) return;
    showStatus(label, !!(payload && payload.state === "error"));
  });
  api.on("mail:translate:event", onTranslateEvent);
  api.on("aiDraftWrite:event", onDraftEvent);
  api.on("emailBrain:updated", onBrainUpdated);
  api.on("emailBrain:refreshState", onBrainRefreshState);
  api.on("emailBrain:rebuildState", onBrainRebuildState);
  api.on("emailBrain:scheduleFired", onScheduleFired);
  try {
    const version = await api.invoke("app:getVersion");
    appVersion = typeof version === "string" ? version : "";
  } catch {
    appVersion = "";
  }
  try {
    bumpUpdate(await api.invoke("host:updateGetState"));
  } catch (error) {
    bumpUpdate({ error: error instanceof Error ? error.message : String(error) });
  }
  await loadLook();
  await loadPresets();
  await loadOauthStatus();
  await loadShellPrefs();
  await loadAccounts();
}

boot().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
