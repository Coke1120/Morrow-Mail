const api = window.genmail;

const state = {
  accounts: [],
  accountId: null,
  folderId: null,
  emails: [],
  email: null,
  threadCount: 0,
  draftId: null,
  busy: false,
};

let accountGen = 0;
let listGen = 0;
let openGen = 0;
let reloadTimer = null;

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
      const name = document.createElement("span");
      name.textContent = folder.name || folder.id;
      button.appendChild(name);
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

function renderList() {
  const list = $("messages");
  list.replaceChildren();
  if (!state.emails.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No messages in this folder.";
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
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = email.from || "(unknown sender)";
    const subject = document.createElement("span");
    subject.textContent = email.subject || "(no subject)";
    const snippet = document.createElement("span");
    snippet.className = "snippet";
    snippet.textContent = email.snippet || "";
    button.append(from, subject, snippet);
    button.addEventListener("click", () => {
      openMessage(email.id).catch((error) => showStatus(error.message, true));
    });
    list.appendChild(button);
  }
}

function renderReader(focus) {
  const pane = $("reader");
  pane.replaceChildren();
  const email = state.email;
  if (!email) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Select a message to read it.";
    pane.appendChild(empty);
    return;
  }
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
  if (state.threadCount > 1) {
    const thread = document.createElement("p");
    thread.className = "meta";
    thread.textContent = `This thread has ${state.threadCount} messages. Showing the one you opened.`;
    pane.appendChild(thread);
  }
  const names = (email.attachments || []).map((item) => item && item.filename).filter(Boolean);
  if (names.length) {
    const files = document.createElement("p");
    files.className = "meta";
    files.textContent = `Attachments: ${names.join(", ")}`;
    pane.appendChild(files);
  }
  const body = document.createElement("pre");
  body.className = "body";
  body.textContent = readable(email);
  pane.appendChild(body);
  if (focus) {
    heading.tabIndex = -1;
    heading.focus();
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
    state.threadCount = 0;
    return;
  }
  if (!foldersOf(selectedAccount()).some((folder) => folder.id === state.folderId)) {
    const inbox = inboxOf(selectedAccount());
    state.folderId = inbox ? inbox.id : null;
    state.email = null;
    state.threadCount = 0;
  }
}

async function loadList() {
  const gen = ++listGen;
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
  await loadList();
  if (gen !== accountGen) return;
  renderReader(false);
}

async function selectFolder(accountId, folderId) {
  state.accountId = accountId;
  state.folderId = folderId;
  state.email = null;
  state.threadCount = 0;
  renderAccounts();
  syncRemove();
  renderReader(false);
  await loadList();
}

async function openMessage(emailId) {
  const gen = ++openGen;
  const data = await call("mail:openEmail", { emailId });
  if (gen !== openGen) return;
  const email = data && data.email;
  if (!email) throw new Error("That message is no longer in the mailbox.");
  state.email = email;
  state.threadCount = data && Array.isArray(data.threadMessages) ? data.threadMessages.length : 1;
  renderReader(true);
  renderList();
  if (!email.unread) return;
  try {
    await call("mail:markRead", { emailId, isRead: true });
  } catch {
    // The message is already on screen.
  }
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
  showStatus("Connecting…");
  const view = await call("mail:connectImapSmtp", connectPayload());
  $("password").value = "";
  closeDialog("connect");
  showStatus(view && view.email ? `Connected ${view.email}` : "Connected.");
  await loadAccounts(view && view.id);
}

async function connectOAuth(provider) {
  showStatus("Waiting for the browser sign-in…");
  const view = await call("mail:addAccount", { provider });
  closeDialog("connect");
  showStatus(view && view.email ? `Connected ${view.email}` : "Connected.");
  await loadAccounts(view && view.id);
}

function composePayload(account) {
  return {
    accountId: account.id,
    to: $("compose-to").value.trim(),
    subject: $("compose-subject").value,
    body: toHtml($("compose-body").value),
    fromAddress: account.email,
    draftId: state.draftId || undefined,
    emailId: state.draftId || undefined,
  };
}

function syncCompose() {
  const account = selectedAccount();
  const live = isLive(account);
  $("compose-note").textContent = live
    ? `From ${account.email}`
    : "Sample mailbox. Connect an account before saving or sending.";
  $("compose-save").disabled = !live;
  $("compose-send").disabled = !live;
}

function openCompose() {
  state.draftId = null;
  $("compose-to").value = "";
  $("compose-subject").value = "";
  $("compose-body").value = "";
  syncCompose();
  openDialog("compose");
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
  showStatus("Removing account…");
  await call("mail:removeAccount", { accountId: account.id });
  state.accountId = null;
  state.folderId = null;
  state.email = null;
  state.threadCount = 0;
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

function wire() {
  $("profile").addEventListener("change", syncCustomFields);
  $("refresh").addEventListener("click", () => guard(refresh));
  $("connect-open").addEventListener("click", () => openDialog("connect"));
  $("connect-close").addEventListener("click", () => closeDialog("connect"));
  $("connect-form").addEventListener("submit", (event) => {
    event.preventDefault();
    guard(connectImap);
  });
  $("oauth-google").addEventListener("click", () => guard(() => connectOAuth("google")));
  $("oauth-microsoft").addEventListener("click", () => guard(() => connectOAuth("microsoft")));
  $("remove").addEventListener("click", () => guard(removeAccount));
  $("compose-open").addEventListener("click", openCompose);
  $("compose-close").addEventListener("click", () => closeDialog("compose"));
  $("compose-save").addEventListener("click", () => guard(saveDraft));
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
  try {
    const version = await api.invoke("app:getVersion");
    $("version").textContent = typeof version === "string" ? version : "";
  } catch {
    $("version").textContent = "";
  }
  await loadPresets();
  await loadAccounts();
}

boot().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
