const api = window.genmail;

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
  busy: false,
  snoozed: new Map(),
  signatures: [],
  signatureText: "",
  translateLang: "English",
  translate: null,
  draftWrite: null,
  suggestions: null,
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
let appVersion = "";
let updateGen = 0;
let updateTimer = null;
let brainSnapshot = null;
let brainEditId = "";
let brainCategories = [];
let brainCategoryDefaults = [];
let brainCategoryIndex = -1;
let brainCategoryGen = 0;
let brainCategoriesReady = false;
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

function isLive(account) {
  return !!(account && account.platform === "imap");
}

function foldersOf(account) {
  if (!account || !account.folders) return [];
  return [...(account.folders.primary || []), ...(account.folders.more || [])];
}

function inboxOf(account) {
  const folders = foldersOf(account);
  return folders.find((folder) => folder.wellKnownName === "inbox") || folders[0] || null;
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

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog.open) dialog.close();
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
  return [subject, to, time].filter(Boolean).join(" · ");
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

// shortcut: Reply All puts every other recipient in To, upgrade when compose has a Cc field.
function replyAddresses(email, self, all) {
  const mineRow = addressRows(self)[0];
  const mine = mineRow ? mineRow.addr : String(self || "").trim().toLowerCase();
  const seen = new Set();
  const out = [];
  const push = (row) => {
    if (!row || seen.has(row.addr) || row.addr === mine) return;
    seen.add(row.addr);
    out.push(row.text);
  };
  const from = addressRows(email && email.from)[0];
  const extras = addressRows(email && email.to).concat(addressRows(email && email.cc));
  if (from) push(from);
  if (all) {
    for (const row of extras) push(row);
  }
  if (!out.length) {
    for (const row of extras) push(row);
  }
  return out.join(", ");
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

function composeSeed(email, kind, self) {
  const message = email || {};
  if (kind === "forward") {
    return {
      title: "Forward",
      to: "",
      subject: prefixedSubject(message.subject, "Fwd:"),
      body: forwardBody(message),
    };
  }
  const all = kind === "all";
  const seed = {
    title: all ? "Reply All" : "Reply",
    to: replyAddresses(message, self, all),
    subject: prefixedSubject(message.subject, "Re:"),
    body: replyBody(message),
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

function renderBanner() {
  const banner = $("banner");
  if (!state.accounts.length) banner.textContent = "No mailbox yet. Connect an account.";
  else if (state.accounts.some(isLive)) banner.textContent = "";
  else banner.textContent = "Sample mailbox. Connect an account to use your own mail. Nothing here is sent.";
  banner.hidden = !banner.textContent;
}

function syncRemove() {
  $("remove").hidden = !isLive(selectedAccount());
}

function renderAccounts() {
  const nav = $("folders");
  nav.replaceChildren();
  if (!state.accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No accounts.";
    nav.appendChild(empty);
    return;
  }
  for (const account of state.accounts) {
    const heading = document.createElement("h2");
    heading.textContent = account.email || account.id;
    nav.appendChild(heading);
    if (account.needsReauth && account.reauthReason) {
      const note = document.createElement("p");
      note.className = "reauth";
      note.textContent = account.reauthReason;
      nav.appendChild(note);
    }
    for (const folder of foldersOf(account)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder";
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
      name.textContent = folder.name || folder.id;
      label.append(icon, name);
      button.appendChild(label);
      if (folder.unreadCount) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(folder.unreadCount);
        button.appendChild(count);
      }
      const unread = folder.unreadCount ? `, ${folder.unreadCount} unread` : "";
      button.setAttribute("aria-label", `${folder.name || "Folder"}${unread}`);
      button.addEventListener("click", () => {
        selectFolder(account.id, folder.id).catch((error) => showStatus(error.message, true));
      });
      nav.appendChild(button);
    }
  }
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

function renderList() {
  const list = $("messages");
  list.replaceChildren();
  const account = selectedAccount();
  const folder = foldersOf(account).find((item) => item.id === state.folderId);
  const title = document.createElement("h2");
  title.className = "list-title";
  title.textContent = state.query ? `Search: ${state.query}` : ((folder && (folder.name || folder.id)) || "Messages");
  list.appendChild(title);
  if (!state.emails.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.query ? "No messages match that search." : "No messages in this folder.";
    list.appendChild(empty);
    return;
  }
  for (const email of state.emails) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message";
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
    const from = document.createElement("span");
    from.className = "from";
    if (email.isStarred) {
      const star = document.createElement("span");
      star.className = "star";
      star.setAttribute("aria-hidden", "true");
      star.textContent = "★";
      from.appendChild(star);
    }
    from.append(senderName(email.from));
    const when = document.createElement("time");
    when.className = "when";
    if (email.date) when.dateTime = email.date;
    when.textContent = listWhen(email.date);
    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = email.subject || "(no subject)";
    const snippet = document.createElement("span");
    snippet.className = "snippet";
    snippet.textContent = email.snippet || "";
    button.append(from, when, subject, snippet);
    button.addEventListener("click", () => {
      openMessage(email.id).catch((error) => showStatus(error.message, true));
    });
    list.appendChild(button);
  }
  const current = list.querySelector('[aria-current="true"]');
  if (current) current.scrollIntoView({ block: "nearest" });
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

function readerButton(action, label, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.dataset.action = action;
  button.textContent = label;
  button.addEventListener("click", () => guard(run));
  return button;
}

function renderActions(pane, email) {
  const bar = document.createElement("div");
  bar.className = "reader-actions";
  const star = document.createElement("button");
  star.type = "button";
  star.className = "ghost";
  star.dataset.action = "star";
  star.textContent = email.isStarred ? "Unstar" : "Star";
  star.setAttribute("aria-pressed", email.isStarred ? "true" : "false");
  star.addEventListener("click", () => guard(() => toggleStar(email)));
  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "ghost";
  archive.dataset.action = "archive";
  archive.textContent = "Archive";
  archive.addEventListener("click", () => guard(() => archiveOpen(email)));
  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "ghost";
  trash.dataset.action = "trash";
  trash.textContent = "Trash";
  trash.addEventListener("click", () => guard(() => trashOpen(email)));
  const move = document.createElement("select");
  move.dataset.action = "move";
  move.setAttribute("aria-label", "Move to folder");
  move.append(option("", "Move"));
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  for (const folder of foldersOf(account)) {
    if (!folder || folder.id === email.folderId) continue;
    move.append(option(folder.id, folder.name || folder.id));
  }
  move.addEventListener("change", () => {
    const target = move.value;
    move.value = "";
    if (!target) return;
    guard(() => moveOpen(email, target));
  });
  const snooze = document.createElement("select");
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
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  const replyTo = replyAddresses(email, self, false);
  const everyone = replyAddresses(email, self, true);
  const reply = readerButton("reply", "Reply", () => openCompose(composeSeed(email, "reply", self)));
  const forward = readerButton("forward", "Forward", () => openCompose(composeSeed(email, "forward", self)));
  if (everyone !== replyTo) {
    const replyAll = readerButton("reply-all", "Reply All", () => openCompose(composeSeed(email, "all", self)));
    bar.append(reply, replyAll, forward, star, archive, trash, move, snooze);
  } else {
    bar.append(reply, forward, star, archive, trash, move, snooze);
  }
  pane.appendChild(bar);
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
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Select a message to read it.";
    pane.appendChild(empty);
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
  if (untilDate && !Number.isNaN(untilDate.getTime())) {
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
  renderBody(pane, readable(email));
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

function renderBody(pane, text) {
  const wrap = document.createElement("div");
  wrap.className = "body";
  for (const node of bodyNodes(text)) {
    const block = document.createElement("p");
    block.dataset.nodeId = node.node_id;
    block.textContent = node.text;
    wrap.appendChild(block);
  }
  pane.appendChild(wrap);
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

async function moveOpen(email, targetFolderId) {
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

async function loadList() {
  const gen = ++listGen;
  if (state.query) {
    const data = await call("mail:search", { query: state.query, limit: 30, filters: {} });
    if (gen !== listGen) return;
    state.emails = Array.isArray(data) ? data : [];
    renderList();
    return;
  }
  const account = selectedAccount();
  if (!account || !state.folderId) {
    state.emails = [];
    renderList();
    return;
  }
  const data = await call("mail:listFromCache", {
    accountId: account.id,
    folderId: state.folderId,
    limit: 80,
  });
  if (gen !== listGen) return;
  state.emails = (data && data.emails) || [];
  renderList();
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
  renderReader(false);
}

async function selectFolder(accountId, folderId) {
  state.accountId = accountId;
  state.folderId = folderId;
  state.query = "";
  $("search-query").value = "";
  state.email = null;
  state.thread = [];
  renderAccounts();
  syncRemove();
  renderReader(false);
  if (!undoOpIds) showStatus("");
  await loadSnoozed();
  await loadList();
}

async function openMessage(emailId) {
  const gen = ++openGen;
  const data = await call("mail:openEmail", { emailId });
  if (gen !== openGen) return;
  const email = data && data.email;
  if (!email) throw new Error("That message is no longer in the mailbox.");
  let listed = null;
  const fromOpen = data && data.threadMessages;
  if ((!Array.isArray(fromOpen) || !fromOpen.length) && email.threadId) {
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
  state.thread = threadMembers(fromOpen, listed);
  renderReader(true);
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
  if (query) showStatus("Searching…");
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

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadAccounts().catch((error) => showStatus(error.message, true));
  }, 150);
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
  showStatus("Waiting for the browser sign-in…");
  const view = await call("mail:addAccount", { provider });
  closeDialog("connect");
  showStatus(view && view.email ? `Connected ${view.email}` : "Connected.");
  await loadAccounts(view && view.id);
}

function composePayload(account) {
  const meta = state.composeMeta || {};
  const payload = {
    accountId: account.id,
    to: $("compose-to").value.trim(),
    subject: $("compose-subject").value,
    body: toHtml($("compose-body").value),
    fromAddress: account.email,
    draftId: state.draftId || undefined,
    emailId: state.draftId || undefined,
  };
  if (meta.inReplyTo) payload.inReplyTo = meta.inReplyTo;
  if (meta.threadId) payload.threadId = meta.threadId;
  return payload;
}

function syncCompose() {
  const account = selectedAccount();
  const live = isLive(account);
  $("compose-note").textContent = live
    ? `From ${account.email}`
    : "Sample mailbox. Connect an account before saving or sending. A scheduled message stays in the list below.";
  $("compose-save").disabled = !live;
  $("compose-send").disabled = !live;
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
    item.textContent = scheduledLine(row);
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
  const accountId = state.accountId;
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
  const accountId = state.accountId;
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

async function openCompose(seed) {
  const fields = seed || {};
  resetDraftWrite();
  state.draftId = null;
  state.signatureText = "";
  state.composeMeta = {
    inReplyTo: fields.inReplyTo || "",
    threadId: fields.threadId || "",
  };
  $("compose-title").textContent = fields.title || "New message";
  $("compose-to").value = fields.to || "";
  $("compose-subject").value = fields.subject || "";
  $("compose-body").value = fields.body || "";
  $("ai-prompt").value = "";
  $("schedule-preset").value = "1h";
  $("schedule-at").value = "";
  syncScheduleFields();
  syncCompose();
  openDialog("compose");
  await Promise.all([fillSignatures(), loadScheduled()]);
  if (!$("compose").open) return;
  if ($("compose-to").value.trim()) {
    const body = $("compose-body");
    body.focus();
    body.setSelectionRange(0, 0);
  } else {
    $("compose-to").focus();
  }
}

async function loadScheduled() {
  const gen = scheduledGen += 1;
  const account = selectedAccount();
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

// shortcut: no cancel, host only has mail:scheduleSend and mail:listScheduled, upgrade when a cancel channel exists.
async function scheduleMail() {
  const account = selectedAccount();
  if (!account) return;
  if (!$("compose-to").value.trim()) {
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
  const account = selectedAccount();
  if (!isLive(account)) return;
  showStatus("Saving draft…");
  const saved = await call("mail:upsertDraft", composePayload(account));
  state.draftId = (saved && (saved.emailId || saved.draftId)) || state.draftId;
  showStatus("Draft saved.");
}

async function sendMail() {
  const account = selectedAccount();
  if (!isLive(account)) return;
  if (!$("compose-to").value.trim()) {
    showStatus("Add a recipient.", true);
    return;
  }
  showStatus("Sending…");
  await call("mail:send", composePayload(account));
  state.draftId = null;
  closeDialog("compose");
  showStatus("Sent.");
  await loadList();
}

async function removeAccount() {
  const account = selectedAccount();
  if (!isLive(account)) return;
  const label = account.email || account.id;
  if (!window.confirm(`Remove ${label} from GenMail REA? Messages stay on the server.`)) return;
  clearUndo();
  showStatus("Removing account…");
  await call("mail:removeAccount", { accountId: account.id });
  state.accountId = null;
  state.folderId = null;
  state.query = "";
  $("search-query").value = "";
  state.email = null;
  state.thread = [];
  showStatus("Account removed.");
  await loadAccounts();
}

async function refresh() {
  const account = selectedAccount();
  if (!account || !state.folderId) return;
  showStatus("Refreshing…");
  await call("mail:listFromNetwork", {
    accountId: account.id,
    folderId: state.folderId,
    limit: 80,
  });
  await loadAccounts();
  showStatus("");
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

function setPane(which, width) {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  const total = shell.getBoundingClientRect().width;
  const folders = $("folders").getBoundingClientRect().width;
  const list = $("messages").getBoundingClientRect().width;
  const readerMin = 260;
  const handle = 12;
  if (which === "folders") {
    const max = Math.max(140, total - list - readerMin - handle);
    shell.style.setProperty("--folders", `${Math.round(paneWidth(width, 0, 140, max))}px`);
    return;
  }
  const max = Math.max(200, total - folders - readerMin - handle);
  shell.style.setProperty("--list", `${Math.round(paneWidth(width, 0, 200, max))}px`);
}

function wireSplits() {
  for (const handle of document.querySelectorAll(".split")) {
    handle.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 24 : event.key === "ArrowLeft" ? -24 : 0;
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      const pane = handle.dataset.split === "folders" ? $("folders") : $("messages");
      setPane(handle.dataset.split, pane.getBoundingClientRect().width + step);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const which = handle.dataset.split;
      const startX = event.clientX;
      const start = (which === "folders" ? $("folders") : $("messages")).getBoundingClientRect().width;
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

function updateView(snapshot, version) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const current = typeof version === "string" ? version : "";
  let status = "Up to date.";
  let install = false;
  let busy = false;
  const error = snap.error ? String(snap.error) : "";
  if (error) {
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

function prefRows() {
  return [
    ["pref-theme", "config:getTheme", "config:setTheme", "select"],
    ["pref-accent", "genmail:configGetAccent", "genmail:configSetAccent", "text"],
    ["pref-conversation", "genmail:configGetConversationViewEnabled", "genmail:configSetConversationViewEnabled", "bool"],
    ["pref-images", "genmail:configGetAutoLoadRemoteImages", "genmail:configSetAutoLoadRemoteImages", "bool"],
    ["pref-undo", "genmail:configGetUndoSendDelaySeconds", "genmail:configSetUndoSendDelaySeconds", "seconds"],
    ["pref-snooze", "genmail:configGetSnoozeEffective", "genmail:configSetSnoozeEffective", "bool"],
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
}

async function savePref(row) {
  const [id, getChannel, setChannel, kind] = row;
  const status = $("settings-status");
  try {
    await api.invoke(setChannel, readPref(kind, $(id)));
    applyPref(kind, $(id), await api.invoke(getChannel));
    status.textContent = "";
    status.classList.remove("error");
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("error");
    try {
      applyPref(kind, $(id), await api.invoke(getChannel));
    } catch { /* status already shows the failure */ }
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
  if (state.refreshing || state.rebuilding) {
    const pct = typeof state.percent === "number" ? " " + Math.round(state.percent) + "%" : "";
    const label = state.rebuilding ? "Rebuilding" : "Refreshing";
    return { text: label + pct + "…", error: false };
  }
  if (state.accepted === false) return { text: "Needs an AI key.", error: true };
  return { text: "", error: false };
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

function defaultCategoryHint(defaults) {
  const names = (Array.isArray(defaults) ? defaults : [])
    .map((row) => String((row && row.name) || "").trim())
    .filter(Boolean);
  return names.length ? "Defaults: " + names.join(", ") + "." : "";
}

function paintBrain(snapshot, view) {
  const message = brainMessage(view);
  const status = $("brain-status");
  status.textContent = message.text;
  status.classList.toggle("error", message.error);
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
        line.append(edit, del);
      }
      block.appendChild(line);
    }
    root.appendChild(block);
  }
  $("brain-add").textContent = brainEditId ? "Save" : "Add";
  $("brain-cancel").hidden = !brainEditId;
  $("brain-refresh").disabled = !!(view && (view.refreshing || view.rebuilding));
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
  if ($("brain").open) paintBrain(brainSnapshot, brainView);
}

async function loadBrain() {
  brainSnapshot = await call("emailBrain:getCached");
  if ($("brain").open) paintBrain(brainSnapshot, brainView);
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
  defaultsBtn.disabled = !brainCategoriesReady;
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
    edit.addEventListener("click", () => startCategoryEdit(index));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete category " + name);
    del.addEventListener("click", () => deleteLocalCategory(index));
    line.append(edit, del);
    root.appendChild(line);
  });
  $("brain-category-add").textContent = brainCategoryIndex >= 0 ? "Update" : "Add";
  $("brain-category-add").disabled = !brainCategoriesReady;
  $("brain-category-cancel").hidden = brainCategoryIndex < 0;
  $("brain-category-save").disabled = !brainCategoriesReady;
  $("brain-category-ai").disabled = !brainCategoriesReady;
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
  if ($("brain").open) paintCategories();
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
}

async function addCategoryFromPrompt(event) {
  event.preventDefault();
  if (!brainCategoriesReady) return;
  const prompt = $("brain-category-prompt").value.trim();
  if (!prompt) {
    showCategoryStatus("Describe a category.", true);
    return;
  }
  try {
    const data = await call("emailBrain:addCategoryViaPrompt", { prompt });
    const row = categoryFromCommand(data);
    if (!row) throw new Error("The model did not return a category.");
    const next = upsertCategory(brainCategories, { ...row, id: "cat-" + Date.now().toString(36) }, -1);
    if (next.error) throw new Error(next.error);
    brainCategories = next.categories;
    $("brain-category-prompt").value = "";
    showCategoryStatus("Save to keep this list.", false);
    paintCategories();
  } catch (error) {
    showCategoryStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function openBrain() {
  openDialog("brain");
  brainCategoriesReady = false;
  brainCategories = [];
  brainCategoryDefaults = [];
  resetCategoryForm();
  $("brain-category-prompt").value = "";
  showCategoryStatus("", false);
  paintCategories();
  const gen = brainCategoryGen += 1;
  loadBrain().catch((error) => {
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
  loadBrainSkills().catch((error) => {
    if ($("brain").open) paintBrainSkills({}, error instanceof Error ? error.message : String(error));
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

async function refreshBrain() {
  $("brain-refresh").disabled = true;
  brainView = { ...brainView, error: "" };
  try {
    let accepted = false;
    for (const channel of brainRefreshChannels()) {
      const result = await call(channel);
      accepted = !!(result && result.accepted);
      if (accepted) break;
    }
    brainView = { ...brainView, accepted };
  } catch (error) {
    brainView = { ...brainView, error: error instanceof Error ? error.message : String(error) };
  }
  if ($("brain").open) paintBrain(brainSnapshot, brainView);
}

function onBrainRefreshState(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  brainView = {
    ...brainView,
    refreshing: data.refreshing === true,
    error: data.error ? String(data.error) : "",
  };
  if ($("brain").open) paintBrain(brainSnapshot, brainView);
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
  if ($("brain").open) paintBrain(brainSnapshot, brainView);
}

function onBrainUpdated() {
  if (!$("brain").open) return;
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

function paintBrainSkills(lists, errorText) {
  const status = $("brain-skill-status");
  status.textContent = errorText || "";
  status.classList.toggle("error", !!errorText);
  const byId = lists || {};
  for (const [id, , empty] of brainSkillLists()) {
    const root = $(id);
    root.replaceChildren();
    const rows = skillRows(byId[id]);
    if (!rows.length) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = empty;
      root.appendChild(note);
      continue;
    }
    for (const row of rows) {
      const line = document.createElement("p");
      line.className = "brain-skill";
      line.textContent = skillLine(row) || "Skill";
      root.appendChild(line);
    }
  }
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
  if ($("brain").open) paintBrainSkills(lists, errors.filter(Boolean).join(" "));
}

function paintStudio(lists, errorText) {
  const status = $("studio-status");
  status.textContent = errorText || "";
  status.classList.toggle("error", !!errorText);
  const byId = lists || {};
  for (const [id, , empty] of studioLists()) {
    const root = $(id);
    root.replaceChildren();
    const rows = skillRows(byId[id]);
    if (!rows.length) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = empty;
      root.appendChild(note);
      continue;
    }
    for (const row of rows) {
      const line = document.createElement("p");
      line.className = "studio-row";
      line.textContent = skillLine(row) || "Skill";
      root.appendChild(line);
    }
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
  if ($("studio").open) paintStudio(lists, errors.filter(Boolean).join(" "));
}

function openStudio() {
  openDialog("studio");
  paintStudio({}, "");
  loadStudio().catch((error) => {
    paintStudio({}, error instanceof Error ? error.message : String(error));
  });
}

function wire() {
  document.addEventListener("keydown", onShellKey);
  wireSplits();
  $("undo").addEventListener("click", () => guard(undoRemoval));
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
  $("refresh").addEventListener("click", () => guard(refresh));
  $("settings-open").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", () => closeDialog("settings"));
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
  $("brain-open").addEventListener("click", openBrain);
  $("studio-open").addEventListener("click", openStudio);
  $("studio-close").addEventListener("click", () => closeDialog("studio"));
  $("brain-close").addEventListener("click", () => closeDialog("brain"));
  $("brain").addEventListener("close", () => {
    brainEditId = "";
    $("brain-rule").value = "";
    brainCategoryIndex = -1;
  });
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
  $("brain-refresh").addEventListener("click", () => {
    refreshBrain().catch((error) => {
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
  $("connect-close").addEventListener("click", () => closeDialog("connect"));
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
  $("compose-close").addEventListener("click", () => closeDialog("compose"));
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

async function boot() {
  if (!api) {
    showStatus("Mail preload is unavailable.", true);
    return;
  }
  wire();
  api.on("mail:accountsUpdated", scheduleReload);
  api.on("mail:emailsUpdated", scheduleReload);
  api.on("mail:translate:event", onTranslateEvent);
  api.on("aiDraftWrite:event", onDraftEvent);
  api.on("emailBrain:updated", onBrainUpdated);
  api.on("emailBrain:refreshState", onBrainRefreshState);
  api.on("emailBrain:rebuildState", onBrainRebuildState);
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
  await loadPresets();
  await loadAccounts();
}

boot().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
