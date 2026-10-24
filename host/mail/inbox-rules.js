const { apiJson, safeNext, isRateLimit } = require("./provider-http");

const GMAIL_FILTERS = "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters";
const GRAPH_RULES = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules";
const MAX_LOCAL = 100;
const MAX_REMOTE = 200;
const GMAIL_RESERVED = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "TRASH",
  "SPAM",
  "DRAFT",
  "IMPORTANT",
  "CHAT",
  "SENT",
]);
const KNOWN_GRAPH_CONDITIONS = [
  "senderContains",
  "recipientContains",
  "subjectContains",
  "bodyContains",
  "hasAttachments",
];
const KNOWN_GRAPH_ACTIONS = ["moveToFolder", "markAsRead", "delete", "stopProcessingRules"];

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid";
  throw error;
}

function ruleId(value) {
  const id = String(value == null ? "" : value).trim();
  if (!id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id)) return "";
  return id;
}

function cleanText(value, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    invalid(`${label} is too long or has unsupported characters.`);
  }
  return text;
}

function backendFor(account) {
  const row = account || {};
  const profile = String(row.profile || "").toLowerCase();
  const oauth = String(row.auth_kind || row.authKind || "") === "oauth2";
  if (!oauth) return "imap";
  if (profile === "gmail" || profile === "google") return "gmail";
  if (profile === "outlook" || profile === "microsoft" || profile === "office365") return "microsoft";
  return "imap";
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function cleanMoveId(value, backend) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const id = ruleId(raw);
  if (!id) invalid("Choose a folder on this mailbox.");
  if (backend === "imap" && id.split("/").includes("..")) invalid("Choose a folder on this mailbox.");
  if (backend === "gmail" && (GMAIL_RESERVED.has(id) || id.startsWith("CATEGORY_"))) {
    invalid("Choose a Gmail label. Star, archive, and trash have their own checkboxes.");
  }
  return id;
}

function normalizeDraft(input, backend) {
  const kind = backend === "gmail" || backend === "microsoft" || backend === "imap" ? backend : "";
  if (!kind) invalid("This mailbox cannot store that rule.");
  const src = asObject(input);
  const matchSrc = asObject(src.match);
  const actionSrc = asObject(src.actions);
  const name = cleanText(src.name, "Name");
  if (kind !== "gmail" && !name) invalid("Add a name for this rule.");
  const enabled = src.enabled === false ? false : true;
  if (kind === "gmail" && src.enabled === false) invalid("Gmail filters stay on until you delete them.");
  const id = src.id == null || src.id === "" ? "" : ruleId(src.id);
  if (src.id != null && src.id !== "" && !id) invalid("That rule id is not valid.");
  let hasAttachment = null;
  if (matchSrc.hasAttachment === true || matchSrc.hasAttachment === false) hasAttachment = matchSrc.hasAttachment;
  else if (matchSrc.hasAttachment != null && matchSrc.hasAttachment !== "") {
    invalid("Attachment match must be yes, no, or any.");
  }
  const match = {
    from: cleanText(matchSrc.from, "From"),
    to: cleanText(matchSrc.to, "To"),
    subject: cleanText(matchSrc.subject, "Subject"),
    text: cleanText(matchSrc.text, "Text"),
    hasAttachment,
  };
  if (!match.from && !match.to && !match.subject && !match.text && match.hasAttachment == null) {
    invalid("Add something for the rule to match.");
  }
  if (kind === "microsoft" && actionSrc.star === true) {
    invalid("Outlook rules cannot star mail. Mark it read, move it, or trash it instead.");
  }
  const rawLabels = actionSrc.addLabelIds == null ? [] : actionSrc.addLabelIds;
  if (!Array.isArray(rawLabels)) invalid("Labels must be a list.");
  if (rawLabels.length > 5) invalid("A rule can add up to 5 labels.");
  if (kind !== "gmail" && rawLabels.length) invalid("Only Gmail rules can add a label.");
  const addLabelIds = [];
  for (const item of rawLabels) {
    const label = cleanMoveId(item, "gmail");
    if (label && !addLabelIds.includes(label)) addLabelIds.push(label);
  }
  const moveToId = cleanMoveId(actionSrc.moveToId, kind);
  const actions = {
    markRead: actionSrc.markRead === true,
    star: kind === "microsoft" ? false : actionSrc.star === true,
    archive: actionSrc.archive === true,
    trash: actionSrc.trash === true,
    moveToId,
    addLabelIds: kind === "gmail" ? addLabelIds.filter((label) => label !== moveToId) : [],
    stopProcessing: kind === "gmail" ? false : actionSrc.stopProcessing !== false,
  };
  if (actions.trash && (actions.archive || actions.moveToId || actions.addLabelIds.length)) {
    invalid("Trash cannot be combined with move, archive, or label.");
  }
  if (kind !== "gmail" && actions.archive && actions.moveToId) {
    invalid("Choose archive or a folder, not both.");
  }
  if (!actions.markRead && !actions.star && !actions.archive && !actions.trash && !actions.moveToId && !actions.addLabelIds.length) {
    invalid("Choose what the rule should do.");
  }
  return { id, name, enabled: kind === "gmail" ? true : enabled, match, actions };
}

function assertLocalDestination(rule, folders) {
  const rows = Array.isArray(folders) ? folders : [];
  const byPath = new Map();
  const byWell = new Map();
  for (const row of rows) {
    if (!row) continue;
    const path = row.path || row.id;
    if (path) byPath.set(path, row);
    const well = row.well_known || row.wellKnown;
    if (well && !byWell.has(well)) byWell.set(well, row);
  }
  if (rule.actions.trash && !byWell.get("deleteditems")) invalid("This mailbox has no Trash folder for that rule.");
  if (rule.actions.archive && !byWell.get("archive")) invalid("This mailbox has no Archive folder for that rule.");
  if (rule.actions.moveToId) {
    const dest = byPath.get(rule.actions.moveToId);
    const well = dest && (dest.well_known || dest.wellKnown);
    if (!dest || well === "inbox") invalid("Choose a folder on this mailbox.");
  }
}

function gmailBody(rule) {
  const criteria = { excludeChats: true };
  if (rule.match.from) criteria.from = rule.match.from;
  if (rule.match.to) criteria.to = rule.match.to;
  if (rule.match.subject) criteria.subject = rule.match.subject;
  if (rule.match.text) criteria.query = rule.match.text;
  if (rule.match.hasAttachment === true || rule.match.hasAttachment === false) {
    criteria.hasAttachment = rule.match.hasAttachment;
  }
  const add = [];
  const remove = [];
  const push = (list, id) => {
    if (id && !list.includes(id)) list.push(id);
  };
  if (rule.actions.star) push(add, "STARRED");
  if (rule.actions.trash) push(add, "TRASH");
  if (rule.actions.markRead) push(remove, "UNREAD");
  if (!rule.actions.trash && (rule.actions.archive || rule.actions.moveToId)) push(remove, "INBOX");
  if (!rule.actions.trash && rule.actions.moveToId) push(add, rule.actions.moveToId);
  for (const id of rule.actions.addLabelIds || []) {
    if (!remove.includes(id)) push(add, id);
  }
  const action = {};
  if (add.length) action.addLabelIds = add;
  if (remove.length) action.removeLabelIds = remove;
  if (!action.addLabelIds && !action.removeLabelIds) invalid("Choose what the rule should do.");
  return { criteria, action };
}

function toGmailFilter(input) {
  return gmailBody(normalizeDraft(input, "gmail"));
}

function textItem(value) {
  return String(value || "").trim();
}

function textList(value) {
  if (Array.isArray(value)) return value.map(textItem).filter(Boolean);
  return [];
}

function fromGmailFilter(filter) {
  if (!filter || !ruleId(filter.id)) return null;
  const criteria = asObject(filter.criteria);
  const action = asObject(filter.action);
  const add = textList(action.addLabelIds);
  const remove = textList(action.removeLabelIds);
  let unsupported = "";
  if (action.forward) unsupported = "forward";
  else if (criteria.negatedQuery || criteria.sizeComparison || (criteria.size != null && criteria.size !== "")) unsupported = "custom";
  else if (criteria.excludeChats === false) unsupported = "custom";
  else if (add.some((id) => (GMAIL_RESERVED.has(id) && !["STARRED", "TRASH"].includes(id)) || id.startsWith("CATEGORY_"))) unsupported = "custom";
  else if (remove.some((id) => id !== "UNREAD" && id !== "INBOX")) unsupported = "custom";
  const userAdds = add.filter((id) => !GMAIL_RESERVED.has(id) && !id.startsWith("CATEGORY_"));
  // The editor has one label picker. Do not silently discard other labels.
  if (!unsupported && userAdds.length > 1) unsupported = "custom";
  const leavesInbox = remove.includes("INBOX");
  // Gmail files a label by adding it and removing INBOX. That is the same
  // filter as archive plus the label, so the label stays in addLabelIds.
  const moveToId = "";
  const addLabelIds = userAdds;
  if (!unsupported && !add.length && !remove.length) unsupported = "custom";
  return {
    id: ruleId(filter.id),
    name: "",
    enabled: true,
    editable: !unsupported,
    unsupported,
    sequence: 0,
    sinceUid: 0,
    position: 0,
    match: {
      from: textItem(criteria.from),
      to: textItem(criteria.to),
      subject: textItem(criteria.subject),
      text: textItem(criteria.query),
      hasAttachment: criteria.hasAttachment === true ? true : criteria.hasAttachment === false ? false : null,
    },
    actions: {
      markRead: remove.includes("UNREAD"),
      star: add.includes("STARRED"),
      archive: leavesInbox && !add.includes("TRASH"),
      trash: add.includes("TRASH"),
      moveToId,
      addLabelIds,
      stopProcessing: false,
    },
  };
}

function filled(value) {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.some((item) => textItem(item));
  return true;
}

function extraKeys(obj, known) {
  return Object.keys(asObject(obj)).some((key) => !known.includes(key) && filled(obj[key]));
}

function many(list) {
  return textList(list).length > 1;
}

function graphBody(rule, sequence, archiveFolderId) {
  const conditions = {};
  if (rule.match.from) conditions.senderContains = [rule.match.from];
  if (rule.match.to) conditions.recipientContains = [rule.match.to];
  if (rule.match.subject) conditions.subjectContains = [rule.match.subject];
  if (rule.match.text) conditions.bodyContains = [rule.match.text];
  if (rule.match.hasAttachment === true || rule.match.hasAttachment === false) {
    conditions.hasAttachments = rule.match.hasAttachment;
  }
  const archiveId = ruleId(archiveFolderId);
  if (rule.actions.archive && !archiveId) invalid("Outlook has no Archive folder for that rule.");
  const move = rule.actions.trash ? "" : (rule.actions.archive ? archiveId : rule.actions.moveToId);
  const actions = {
    stopProcessingRules: rule.actions.stopProcessing !== false,
    markAsRead: rule.actions.markRead === true,
    delete: rule.actions.trash === true,
  };
  if (move) actions.moveToFolder = move;
  return {
    displayName: rule.name,
    sequence: Math.max(1, Number(sequence) || 1),
    isEnabled: rule.enabled !== false,
    conditions,
    actions,
  };
}

function toGraphRule(input, sequence, archiveFolderId) {
  return graphBody(normalizeDraft(input, "microsoft"), sequence, archiveFolderId);
}

function fromGraphRule(rule, archiveFolderId) {
  if (!rule || !ruleId(rule.id)) return null;
  const conditions = asObject(rule.conditions);
  const actions = asObject(rule.actions);
  const multi = ["senderContains", "recipientContains", "subjectContains", "bodyContains"].some((key) => many(conditions[key]));
  const unsupported = rule.isReadOnly === true || multi
    || extraKeys(rule.exceptions, [])
    || extraKeys(conditions, KNOWN_GRAPH_CONDITIONS) || extraKeys(actions, KNOWN_GRAPH_ACTIONS);
  const move = ruleId(actions.moveToFolder) || "";
  const trash = actions.delete === true;
  const archiveId = ruleId(archiveFolderId);
  const archive = !trash && !!archiveId && move === archiveId;
  return {
    id: ruleId(rule.id),
    name: textItem(rule.displayName),
    enabled: rule.isEnabled !== false,
    editable: !unsupported,
    unsupported: unsupported ? "custom" : "",
    sequence: Number(rule.sequence) || 0,
    sinceUid: 0,
    position: Number(rule.sequence) || 0,
    match: {
      from: textList(conditions.senderContains)[0] || "",
      to: textList(conditions.recipientContains)[0] || "",
      subject: textList(conditions.subjectContains)[0] || "",
      text: textList(conditions.bodyContains)[0] || "",
      hasAttachment: conditions.hasAttachments === true ? true : conditions.hasAttachments === false ? false : null,
    },
    actions: {
      markRead: actions.markAsRead === true,
      star: false,
      archive,
      trash,
      moveToId: archive || trash ? "" : move,
      addLabelIds: [],
      stopProcessing: actions.stopProcessingRules !== false,
    },
  };
}

async function providerCall(url, accessToken, options) {
  return apiJson(url, accessToken, options || {});
}

function missingRule() {
  const error = new Error("That inbox rule is no longer on the provider.");
  error.code = "not-found";
  return error;
}

async function listGmail(accessToken, fetchImpl) {
  const json = await providerCall(GMAIL_FILTERS, accessToken, { fetchImpl });
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    const error = new Error("Gmail did not return filters.");
    error.code = "provider";
    throw error;
  }
  if (json.filter != null && !Array.isArray(json.filter)) {
    const error = new Error("Gmail did not return filters.");
    error.code = "provider";
    throw error;
  }
  const rows = Array.isArray(json.filter) ? json.filter : [];
  if (rows.length > MAX_REMOTE) {
    const error = new Error("This mailbox has more than 200 filters.");
    error.code = "too_many";
    throw error;
  }
  return rows.map(fromGmailFilter).filter(Boolean);
}

async function getGmail(accessToken, id, fetchImpl) {
  const rule = ruleId(id);
  if (!rule) invalid("Choose a rule.");
  try {
    const json = await providerCall(`${GMAIL_FILTERS}/${encodeURIComponent(rule)}`, accessToken, { fetchImpl });
    const parsed = fromGmailFilter(json);
    if (!parsed) throw missingRule();
    return parsed;
  } catch (error) {
    if (error && error.status === 404) throw missingRule();
    throw error;
  }
}

async function createGmail(accessToken, rule, fetchImpl) {
  const body = gmailBody(rule);
  const json = await providerCall(GMAIL_FILTERS, accessToken, { method: "POST", body, fetchImpl });
  const saved = fromGmailFilter(json);
  if (!saved) {
    const error = new Error("Gmail did not return the new filter.");
    error.code = "provider";
    throw error;
  }
  return saved;
}

async function deleteGmail(accessToken, id, fetchImpl) {
  const rule = ruleId(id);
  if (!rule) invalid("Choose a rule.");
  try {
    await providerCall(`${GMAIL_FILTERS}/${encodeURIComponent(rule)}`, accessToken, { method: "DELETE", fetchImpl });
  } catch (error) {
    if (error && error.status === 404) return;
    throw error;
  }
}

async function saveGmail(accessToken, input, fetchImpl) {
  const rule = normalizeDraft(input, "gmail");
  if (rule.id) {
    const current = await getGmail(accessToken, rule.id, fetchImpl);
    if (!current.editable) {
      invalid("That Gmail filter uses an action Morrow Mail does not rewrite. Delete it, then create a new one.");
    }
  }
  const created = await createGmail(accessToken, rule, fetchImpl);
  if (rule.id && rule.id !== created.id) {
    try {
      await deleteGmail(accessToken, rule.id, fetchImpl);
    } catch (error) {
      if (!error || error.status !== 404) {
        const partial = new Error("The new Gmail filter was saved, but the previous one is still there.");
        partial.code = "partial";
        throw partial;
      }
    }
  }
  return created;
}

async function listGraph(accessToken, archiveFolderId, fetchImpl) {
  const rules = [];
  let url = GRAPH_RULES;
  for (let page = 0; page < 10 && url; page += 1) {
    const json = await providerCall(url, accessToken, { fetchImpl });
    const rows = json && Array.isArray(json.value) ? json.value : null;
    if (!rows) {
      const error = new Error("Outlook did not return inbox rules.");
      error.code = "provider";
      throw error;
    }
    for (const row of rows) {
      const rule = fromGraphRule(row, archiveFolderId);
      if (!rule || rules.some((item) => item.id === rule.id)) continue;
      rules.push(rule);
      if (rules.length >= MAX_REMOTE) return rules;
    }
    const next = safeNext(json["@odata.nextLink"], "graph.microsoft.com");
    url = next && next !== url ? next : "";
  }
  return rules;
}

async function getGraph(accessToken, id, archiveFolderId, fetchImpl) {
  const rule = ruleId(id);
  if (!rule) invalid("Choose a rule.");
  try {
    const json = await providerCall(`${GRAPH_RULES}/${encodeURIComponent(rule)}`, accessToken, { fetchImpl });
    const parsed = fromGraphRule(json, archiveFolderId);
    if (!parsed) throw missingRule();
    return parsed;
  } catch (error) {
    if (error && error.status === 404) throw missingRule();
    throw error;
  }
}

async function createGraph(accessToken, rule, sequence, archiveFolderId, fetchImpl) {
  const body = graphBody(rule, sequence, archiveFolderId);
  const json = await providerCall(GRAPH_RULES, accessToken, { method: "POST", body, fetchImpl });
  const saved = fromGraphRule(json, archiveFolderId);
  if (!saved) {
    const error = new Error("Outlook did not return the new rule.");
    error.code = "provider";
    throw error;
  }
  return saved;
}

async function deleteGraph(accessToken, id, fetchImpl) {
  const rule = ruleId(id);
  if (!rule) invalid("Choose a rule.");
  try {
    await providerCall(`${GRAPH_RULES}/${encodeURIComponent(rule)}`, accessToken, { method: "DELETE", fetchImpl });
  } catch (error) {
    if (error && error.status === 404) return;
    throw error;
  }
}

async function saveGraph(accessToken, input, archiveFolderId, fetchImpl) {
  const rule = normalizeDraft(input, "microsoft");
  let sequence;
  if (rule.id) {
    const current = await getGraph(accessToken, rule.id, archiveFolderId, fetchImpl);
    if (!current.editable) {
      invalid("That Outlook rule uses an action Morrow Mail does not rewrite. Delete it, then create a new one.");
    }
    sequence = current.sequence;
  }
  if (!sequence) {
    const listed = await listGraph(accessToken, archiveFolderId, fetchImpl);
    sequence = listed.reduce((max, row) => Math.max(max, Number(row.sequence) || 0), 0) + 1;
  }
  const created = await createGraph(accessToken, rule, sequence, archiveFolderId, fetchImpl);
  if (rule.id && rule.id !== created.id) {
    try {
      await deleteGraph(accessToken, rule.id, fetchImpl);
    } catch (error) {
      if (!error || error.status !== 404) {
        const partial = new Error("The new Outlook rule was saved, but the previous one is still there.");
        partial.code = "partial";
        throw partial;
      }
    }
  }
  return created;
}

function textOf(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "")).join(" ");
  const raw = String(value || "");
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || "")).join(" ");
    } catch {
      return raw;
    }
  }
  return raw;
}

function contains(value, needle) {
  if (!needle) return true;
  return textOf(value).toLowerCase().includes(String(needle).toLowerCase());
}

function messageHasAttachment(message) {
  const row = message || {};
  return row.hasAttachments === true || row.hasAttachments === 1 || row.has_attachments === 1;
}

function matches(rule, message) {
  const row = message || {};
  const match = rule && rule.match ? rule.match : {};
  if (match.from && !contains(row.from || row.from_addr, match.from)) return false;
  if (match.to && !contains(`${textOf(row.to != null ? row.to : row.to_json)} ${textOf(row.cc != null ? row.cc : row.cc_json)}`, match.to)) {
    return false;
  }
  if (match.subject && !contains(row.subject, match.subject)) return false;
  if (match.text && !contains(`${row.subject || ""} ${row.snippet || ""} ${row.textBody || row.text_body || ""}`, match.text)) {
    return false;
  }
  if (match.hasAttachment === true && !messageHasAttachment(row)) return false;
  if (match.hasAttachment === false && messageHasAttachment(row)) return false;
  return true;
}

function ruleEnabled(rule) {
  return !!(rule && (rule.enabled === true || rule.enabled === 1));
}

function planImap(rules, messages) {
  const ordered = (Array.isArray(rules) ? rules : [])
    .filter(ruleEnabled)
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const steps = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const uid = Number(message && message.uid) || 0;
    if (uid <= 0) continue;
    for (const rule of ordered) {
      const since = Number(rule.sinceUid) || 0;
      if (uid <= since) continue;
      if (!matches(rule, message)) continue;
      const actions = rule.actions || {};
      steps.push({
        uid,
        ruleId: rule.id,
        markRead: actions.markRead === true,
        star: actions.star === true,
        archive: actions.archive === true && actions.trash !== true,
        trash: actions.trash === true,
        moveToId: actions.trash || actions.archive ? "" : (actions.moveToId || ""),
      });
      if (actions.stopProcessing !== false) break;
    }
  }
  return steps;
}

function folderPath(row) {
  return row && (row.path || row.id) ? String(row.path || row.id) : "";
}

function destinationPath(db, accountId, step, inboxPath) {
  if (!db) return "";
  if (step.trash || step.archive) {
    const well = step.trash ? "deleteditems" : "archive";
    const folder = db.folderByWellKnown(accountId, well);
    const path = folderPath(folder);
    return path && path !== inboxPath ? path : "";
  }
  if (step.moveToId) {
    const folder = db.folderByPath(accountId, step.moveToId);
    const path = folderPath(folder);
    const well = folder && (folder.well_known || folder.wellKnown);
    if (!path || path === inboxPath || well === "inbox") return "";
    return path;
  }
  return "";
}

async function runImapStep(ctx, step) {
  const account = ctx.account;
  const folder = ctx.folder;
  const inboxPath = folder.path;
  const wantsMove = step.trash || step.archive || step.moveToId;
  const dest = wantsMove ? destinationPath(ctx.db, account.id, step, inboxPath) : "";
  if (wantsMove && !dest) {
    const error = new Error("That inbox rule has no destination folder.");
    error.code = "invalid";
    throw error;
  }
  const add = [];
  if (step.markRead) add.push("\\Seen");
  if (step.star) add.push("\\Flagged");
  if (add.length) await ctx.remote.changeFlags(ctx.client, inboxPath, step.uid, add, [], ctx.validity);
  let next = null;
  if (dest) next = await ctx.remote.moveUid(ctx.client, inboxPath, step.uid, dest, ctx.validity);
  const row = ctx.validity ? ctx.db.messageByUid(account.id, inboxPath, step.uid, ctx.validity) : null;
  if (!row) return;
  const patch = {};
  if (step.markRead) patch.unread = 0;
  if (step.star) patch.starred = 1;
  if (dest) {
    patch.folder_path = dest;
    patch.uid = next && next.uid ? next.uid : step.uid;
    if (next && next.uidValidity) patch.uid_validity = next.uidValidity;
  }
  if (Object.keys(patch).length) ctx.db.updateMessage(row.id, patch);
}

async function runImapPlan(ctx) {
  const account = ctx && ctx.account;
  const folder = ctx && ctx.folder;
  if (!account || !folder || folder.well_known !== "inbox") return { applied: 0, failed: 0 };
  if (backendFor(account) !== "imap") return { applied: 0, failed: 0 };
  const rules = ctx.rules || (ctx.db && ctx.db.listInboxRules(account.id)) || [];
  const plan = planImap(rules, ctx.messages);
  let applied = 0;
  let failed = 0;
  for (const step of plan) {
    try {
      await runImapStep(ctx, step);
      applied += 1;
    } catch (error) {
      if (isRateLimit(error)) throw error;
      failed += 1;
    }
  }
  return { applied, failed };
}

module.exports = {
  GMAIL_FILTERS,
  GRAPH_RULES,
  MAX_LOCAL,
  backendFor,
  normalizeDraft,
  assertLocalDestination,
  toGmailFilter,
  fromGmailFilter,
  toGraphRule,
  fromGraphRule,
  listGmail,
  getGmail,
  deleteGmail,
  saveGmail,
  listGraph,
  getGraph,
  deleteGraph,
  saveGraph,
  matches,
  planImap,
  runImapPlan,
};
