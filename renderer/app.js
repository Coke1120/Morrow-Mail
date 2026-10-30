const api = window.morrow;

const state = {
  accounts: [],
  accountId: null,
  allInbox: false,
  allInboxUnreadOnly: false,
  outbox: false,
  outboxRows: [],
  outboxError: "",
  settingsAccountId: null,
  reconnectAccountId: null,
  folderId: null,
  emails: [],
  listOffset: 0,
  listTotal: 0,
  listSyncDone: true,
  listLoading: false,
  listScope: "",
  email: null,
  thread: [],
  query: "",
  searchAccountId: "",
  draftId: null,
  draftRevision: null,
  composeSession: 0,
  agentReplyTodo: null,
  agentReplySource: null,
  agentLearning: null,
  composeAttachments: [],
  composeFileJobs: [],
  composeSuggestions: null,
  composeMeta: null,
  composeBaseline: "",
  composePending: false,
  composeQueued: false,
  composeInitializing: false,
  composeQuote: null,
  botDraftReview: null,
  botAccess: null,
  busy: false,
  snoozed: new Map(),
  signatures: [],
  signatureText: "",
  signatureHtml: "",
  translate: null,
  draftWrite: null,
  suggestions: null,
  remoteAllowed: {},
  prefs: {
    chips: true,
    aiReply: true,
    markReadCompletesTodos: false,
    gmailOpen: true,
    outlookOpen: false,
    theme: "light",
    accent: "#193C34",
    translateLang: "zh-Hant",
    conversation: true,
    images: true,
    undoSend: 30,
    snooze: false,
    quoteWidth: 420,
    syncHorizon: 0,
    compactList: true,
    collapsedFolders: {},
    scheduleDelay: 0,
    layout: { folders: 260, list: 360, reading: 0 },
    timeFormat: "system",
    dateFormat: "system",
  },
  providerFolders: null,
  dragMessage: null,
  dragFolder: null,
  selectedIds: [],
  selectionAnchor: "",
  unreadHold: null,
  sync: null,
  syncScopes: new Map(),
  bodySync: null,
  bodySyncUnavailable: false,
  oauthStatus: null,
  googleOauthClient: null,
  oauthPending: false,
  view: "mail",
  side: "folders",
  calendarCursor: null,
  calendarAccountId: "",
  calendarId: "",
  calendarIds: [],
  calendarChecksAccountId: "",
  calendarEventId: "",
  calendarStatus: null,
  calendarPayload: null,
  providerColumnPath: [],
  calendarFocusDay: "",
};

let accountGen = 0;
let listGen = 0;
const LIST_PAGE_SIZE = 200;
let openGen = 0;
let pendingOpenId = "";
let pendingOpenBody = false;
const latestBodies = new Map();
const BODY_CACHE_LIMITS = Object.freeze({ entries: 32, bytes: 8 * 1024 * 1024, entryBytes: 2 * 1024 * 1024 });
let latestBodyBytes = 0;
const bodyNotices = new Map();
const bodyReadFences = new Map();
let bodyReadSerial = 0;
let bodyRefresh = null;
let peekGen = 0;
let peekEmail = null;
let pendingPeekId = "";
let pendingPeekAccountId = "";
let reloadTimer = null;
let undoKind = "";
let undoOpIds = null;
let undoItems = null;
let undoBusy = false;
let undoEpoch = 0;
let undoDetailsEpoch = -1;
const undoEpochByOp = new Map();
const removalEpochByAction = new Map();
const removalEpochByMessage = new Map();
const undoPending = new Set();
let undoInflight = null;
let undoFlightSerial = 0;
const undoSettleQueue = [];
const undoSnapshots = new Map();
let readUndoItems = null;
let readUndoTimer = 0;
let undoReceipt = "";
let undoReceiptError = false;
const agentReplySelection = new Set();
let translateSeq = 0;
let draftSeq = 0;
let suggestGen = 0;
let composeSuggestGen = 0;
let signatureGen = 0;
let signatureEditId = "";
let signatureEditorAccountId = "";
let signatureEditorPack = null;
let signatureEditorIdentity = null;
let signatureEditorFocus = null;
let signatureEditorSettings = null;
let signatureEditorGeneration = 0;
let signatureListGen = 0;
let signatureSavePending = null;
let scheduledGen = 0;
let scheduleUndo = null;
let scheduleUndoTimer = null;
let scheduleUndoBusy = false;
let scheduleUndoEpoch = 0;
let previewDraftState = null;
let layoutSaveTimer = null;
let sendTimer = null;
let sendGen = 0;
let appVersion = "";
let changelogSettled = false;
let changelogPending = false;
let updateGen = 0;
let updateTimer = null;
let brainSnapshot = null;
let brainEditId = "";
let brainCategories = [];
let updateCategoriesBaseline = "[]";
let updateMemoryBaseline = "";
let agentMemoryVersion = 0;
let agentMemorySaveQueue = Promise.resolve();
let agentMemoryPending = 0;
let updateAiBaseline = null;
let updateFreezeNonce = null;
let updateWasInert = false;
let brainCategoryDefaults = [];
let brainCategoryIndex = -1;
let brainCategoryGen = 0;
let brainSkillBusy = false;
let brainSkillDialogId = "";
let customSkillCreating = false;
let customSkillSaving = false;
let brainFixBusy = false;
let brainCategoryBusy = false;
let brainCategorySaving = false;
let brainSkillCache = {};
let brainCategoriesReady = false;
let calendarGen = 0;
let agentGen = 0;
let agentChatBusy = false;
let agentTurns = [];
let agentPaintPayload = null;
let agentProposalIds = null;
let agentPoll = null;
let brainDragIndex = -1;
let listMotionKey = "";
let listOpenKey = "";
let folderRenderKey = "";
let folderCollapseGen = 0;
let folderNavKey = "";
let folderNavRestore = false;
let chipRenderKey = "";
let searchAccountKey = "";
const messageRows = new Map();
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

const STATUS_SUCCESS_DWELL_MS = 4000;
const STATUS_ERROR_DWELL_MS = 12000;
let statusCollapseTimer = 0;
let statusGeneration = 0;
let statusExpanded = false;
let statusIsError = false;
let statusHoldOpen = false;

function armStatusTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function clearStatusTimer() {
  statusGeneration += 1;
  if (!statusCollapseTimer) return;
  clearTimeout(statusCollapseTimer);
  statusCollapseTimer = 0;
}

function paintStatusChrome(expanded) {
  const status = $("status");
  const notice = $("notice");
  const chip = $("status-chip");
  const hasText = !!(status && status.textContent);
  const open = !!expanded && hasText;
  statusExpanded = open;
  if (notice && notice.classList) {
    notice.classList.toggle("collapsed", hasText && !open);
    notice.classList.toggle("error", hasText && statusIsError);
  }
  if (!chip) return;
  chip.hidden = !hasText;
  if (chip.classList) chip.classList.toggle("error", hasText && statusIsError);
  if (typeof chip.setAttribute === "function") {
    chip.setAttribute("aria-expanded", open ? "true" : "false");
    chip.setAttribute("aria-label", open ? "Collapse status" : (hasText ? status.textContent : "Show status"));
  }
  chip.title = hasText && !open ? status.textContent : "";
}

function scheduleStatusCollapse() {
  clearStatusTimer();
  if (statusHoldOpen || !statusExpanded || statusInteractionActive()) return;
  const generation = statusGeneration;
  const wait = statusIsError ? STATUS_ERROR_DWELL_MS : STATUS_SUCCESS_DWELL_MS;
  statusCollapseTimer = armStatusTimer(() => {
    if (generation !== statusGeneration || statusHoldOpen || statusInteractionActive()) return;
    statusCollapseTimer = 0;
    const status = $("status");
    if (!status || !status.textContent) return;
    paintStatusChrome(false);
  }, wait);
}

function statusInteractionActive() {
  const notice = $("notice");
  return undoPopoverOpen() || !!notice?.matches?.(":hover, :focus-within");
}

function collapseStatus() {
  statusHoldOpen = false;
  clearStatusTimer();
  const status = $("status");
  if (!status || !status.textContent) {
    paintStatusChrome(true);
    return;
  }
  paintStatusChrome(false);
}

function expandStatus(pin) {
  const status = $("status");
  if (!status || !status.textContent) {
    statusHoldOpen = false;
    paintStatusChrome(true);
    return;
  }
  statusHoldOpen = !!pin;
  clearStatusTimer();
  paintStatusChrome(true);
  if (!statusHoldOpen) scheduleStatusCollapse();
}

function showStatus(text, isError) {
  const el = $("status");
  if (!el) return;
  if (undoKind === "read" && text !== undoReceipt) clearUndo();
  const kept = undoKind === "removal" && undoOpIds && undoReceipt;
  el.textContent = kept && text !== undoReceipt ? undoReceipt + (text ? "\n" + text : "") : (text || "");
  statusIsError = !!(isError || (kept && undoReceiptError)) && !!el.textContent;
  if (el.classList) el.classList.toggle("error", statusIsError);
  statusHoldOpen = false;
  if (!el.textContent) {
    clearStatusTimer();
    paintStatusChrome(true);
    return;
  }
  paintStatusChrome(true);
  scheduleStatusCollapse();
}

function statusToggleTarget(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== "function") return null;
  return target.closest("button");
}

function statusControl(event) {
  const pop = $("undo-details-popover");
  const target = event && event.target;
  if (pop && pop.hidden === false && target && target.nodeType && typeof pop.contains === "function" && pop.contains(target)) return false;
  const button = statusToggleTarget(event);
  if (button && button.id !== "status-chip") return false;
  const status = $("status");
  if (!status || !status.textContent) return false;
  if (statusExpanded && !button && typeof window.getSelection === "function") {
    const selection = window.getSelection();
    if (selection && String(selection)) return false;
  }
  if (statusExpanded) collapseStatus();
  else expandStatus(true);
  return true;
}

function statusDismissPointer(event) {
  if (undoPopoverOpen() && !eventInsideUndoDetails(event)) closeUndoDetails(false);
  if (!statusExpanded) return false;
  if (event && event.button !== undefined && event.button !== 0) return false;
  const status = $("status");
  if (!status || !status.textContent) return false;
  const notice = $("notice");
  if (notice && typeof notice.contains === "function" && event && notice.contains(event.target)) return false;
  collapseStatus();
  return true;
}

function statusDismissKey(event) {
  if (!event || event.key !== "Escape") return false;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  if (typeof document.querySelector === "function" && document.querySelector("dialog[open]")) return false;
  const menu = typeof document.getElementById === "function" ? document.getElementById("organize-menu") : null;
  if (menu && !menu.hidden) return false;
  if (undoPopoverOpen()) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    closeUndoDetails(true);
    return true;
  }
  if (!statusExpanded) return false;
  const target = event.target;
  if (target && typeof target.closest === "function" && target.closest("input, textarea, select, [contenteditable='true']")) return false;
  if (typeof event.preventDefault === "function") event.preventDefault();
  collapseStatus();
  return true;
}

function wireStatusNotice() {
  const notice = $("notice");
  if (!notice || (notice.dataset && notice.dataset.statusWired)) return;
  if (notice.dataset) notice.dataset.statusWired = "1";
  if (typeof notice.addEventListener === "function") {
    notice.addEventListener("click", statusControl);
    notice.addEventListener("pointerenter", clearStatusTimer);
    notice.addEventListener("pointerleave", scheduleStatusCollapse);
    notice.addEventListener("focusin", clearStatusTimer);
    notice.addEventListener("focusout", () => Promise.resolve().then(() => {
      if (undoPopoverOpen() && !eventInsideUndoDetails({ target: document.activeElement })) closeUndoDetails(false);
      scheduleStatusCollapse();
    }));
  }
  document.addEventListener("mousedown", statusDismissPointer);
  document.addEventListener("keydown", statusDismissKey);
}

function selectedAccount() {
  return state.accounts.find((account) => account.id === state.accountId) || null;
}

function composeAccount() {
  const id = state.composeMeta && state.composeMeta.accountId;
  return state.accounts.find((account) => account.id === id) || null;
}

function signatureAccount() {
  if (signatureEditorAccountId) return state.accounts.find(account => account.id === signatureEditorAccountId) || null;
  return ($("settings").open ? settingsAccount() : composeAccount()) || settingsAccount();
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

function chipFolders(account) {
  const folders = account && account.folders;
  const primary = folders && Array.isArray(folders.primary) ? folders.primary : [];
  const more = folders && Array.isArray(folders.more) ? folders.more : [];
  const list = primary.length ? primary : more;
  return list.filter((folder) => folder && folder.chip === true);
}

function selectedFolderNode() {
  return foldersOf(selectedAccount()).find((folder) => folder && folder.id === state.folderId) || null;
}

function chipLabel(folder) {
  const name = String((folder && (folder.label || folder.name || folder.id)) || "");
  if (name.toUpperCase() === "INBOX") return "Inbox";
  return name;
}

function isVirtualMailbox(folder) {
  return !!(folder && typeof folder === "object" && folder.type === "virtual");
}

function storableFolders(folders) {
  return (Array.isArray(folders) ? folders : []).filter((folder) => folder && !isVirtualMailbox(folder));
}

function unreadListActive(view) {
  const source = view || {};
  if (source.query || source.outbox) return false;
  if (source.allInbox === true) return source.unreadOnly === true;
  const folder = source.folder;
  return !!(folder && folder.view && folder.view.unread === true);
}

function unreadHoldKey(view) {
  if (!unreadListActive(view)) return "";
  if (view.allInbox === true) return "all";
  const folderId = (view.folder && view.folder.id) || view.folderId || "";
  return String(view.accountId || "") + "\0" + String(folderId);
}

// List membership for one opened unread row. The read flag itself is unchanged.
function applyUnreadHold(hold, action) {
  const current = hold && hold.id
    ? { id: String(hold.id), accountId: String(hold.accountId || ""), key: String(hold.key || "") }
    : null;
  const kind = action && action.kind;
  if (kind === "scope") {
    const key = unreadHoldKey(action.view);
    if (!current || current.key !== key) return null;
    return current;
  }
  if (kind === "open") {
    const key = unreadHoldKey(action.view);
    if (!key) return null;
    if (!action.unread) return current && current.key === key ? current : null;
    const id = String(action.id || "");
    if (!id) return current && current.key === key ? current : null;
    if (current && current.id === id && current.key === key) return current;
    return { id, accountId: String(action.accountId || ""), key };
  }
  if (kind === "mark") {
    if (!current) return null;
    const ids = action.batch
      ? (Array.isArray(action.selected) ? action.selected : []).map((id) => String(id || "")).filter(Boolean)
      : [String(action.id || "")];
    if (!ids.includes(current.id)) return current;
    if (action.isRead === false) return null;
    if (action.batch || action.mailList === false) return null;
    return current;
  }
  if (kind === "refresh") {
    if (!current) return null;
    const ids = new Set((Array.isArray(action.ids) ? action.ids : []).map((id) => String(id || "")));
    return ids.has(current.id) ? current : null;
  }
  return current;
}

function visibleList(emails, query, folder, holdId) {
  const rows = filteredEmails(emails, query);
  const view = folder && folder.view;
  if (!view) return rows;
  const kept = holdId == null ? "" : String(holdId);
  return rows.filter((email) => {
    if (view.unread === true && !(email && email.unread)) {
      return !!(kept && email && String(email.id) === kept);
    }
    if (view.flagged === true && !(email && email.isStarred)) return false;
    return true;
  });
}

function accountLabel(account) {
  const email = (account && (account.email || account.displayEmail)) || "";
  const custom = String((account && account.label) || "").trim();
  const name = custom || ((account && account.name) || "");
  if (name && email && name !== email) return `${name} · ${email}`;
  return email || name || (account && account.id) || "";
}

function allInboxUnread(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const helper = typeof morrowPrimaryMailboxes === "object" && morrowPrimaryMailboxes;
  if (helper && typeof helper.sumUnread === "function") return helper.sumUnread(list, foldersOf);
  return list.reduce((sum, account) => {
    const count = Number(account && account.unreadCount);
    return sum + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
}

function allAccountMailLabel() {
  return "All Account Mail";
}

function allAccountMailTitle(unreadOnly) {
  return unreadOnly ? "All Account Mail · Unread" : "All Account Mail";
}

function allAccountMailSyncCopy() {
  return "All Account Mail shows mail already downloaded. Open Gmail All Mail, or Inbox for another account, to sync that account.";
}

function allAccountMailEmptyCopy(unreadOnly) {
  if (unreadOnly) return "No unread messages in All Account Mail.";
  return "No downloaded messages in All Account Mail. Open Gmail All Mail, or Inbox for another account, and use Sync to download recent mail.";
}

function allAccountMailMatches(query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || "all account mail".includes(q);
}

function inboxMatches(query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || "inbox".includes(q);
}

function outboxMatches(query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || "outbox".includes(q);
}

function allAccountSectionKey() {
  const collapse = folderCollapse();
  if (!collapse || !collapse.ALL_ACCOUNT_MAIL_ACCOUNT || !collapse.ALL_ACCOUNT_MAIL_ID) return null;
  return { accountId: collapse.ALL_ACCOUNT_MAIL_ACCOUNT, folderId: collapse.ALL_ACCOUNT_MAIL_ID };
}

function allAccountSectionOpen() {
  const collapse = folderCollapse();
  if (!collapse || typeof collapse.allAccountMailCollapsed !== "function") return true;
  return !collapse.allAccountMailCollapsed(state.prefs.collapsedFolders);
}

function toggleAllAccountSection() {
  const key = allAccountSectionKey();
  if (!key) {
    folderNavRestore = false;
    return Promise.resolve();
  }
  return toggleSidebarFolder(key.accountId, key.folderId);
}

function allAccountUnreadChip(count, pressed) {
  const n = Number(count);
  const unread = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const on = pressed === true;
  const action = on
    ? "Showing unread messages in All Account Mail. Show every message."
    : "Show only unread messages in All Account Mail.";
  return {
    text: unread ? "Unread " + unread : "Unread",
    pressed: on,
    label: (unread ? "Unread, " + unread + ". " : "Unread. ") + action,
  };
}

function allAccountMailChoice(current, control) {
  const view = current && typeof current === "object" ? current : {};
  if (control === "unread") {
    if (view.allInbox === true && view.unreadOnly === true) return { allInbox: true, unreadOnly: false };
    return { allInbox: true, unreadOnly: true };
  }
  return { allInbox: true, unreadOnly: false };
}

function mailListRequest(view) {
  const source = view || {};
  const limit = source.limit || 200;
  const offset = Number.isFinite(source.offset) ? source.offset : 0;
  if (source.query) {
    const params = { query: source.query, limit: 100 };
    if (source.searchAccountId) params.accountId = source.searchAccountId;
    return { channel: "mail:searchLocal", params };
  }
  const retainSource = Array.isArray(source.retainIds) ? source.retainIds[0] : "";
  const retainId = typeof retainSource === "string" && retainSource && retainSource.length <= 200 ? retainSource : "";
  if (source.allInbox) {
    const params = { folderKey: "primary", limit, offset };
    const helper = typeof morrowPrimaryMailboxes === "object" && morrowPrimaryMailboxes;
    if (helper && typeof helper.primaryMailboxes === "function") {
      const mailboxes = helper.primaryMailboxes(source.accounts, foldersOf);
      if (mailboxes.length) params.mailboxes = mailboxes;
    }
    if (source.unreadOnly) params.filterUnread = true;
    if (retainId) params.retainIds = [retainId];
    return { channel: "mail:listFromCache", params };
  }
  const params = { accountId: source.accountId, folderId: source.folderId, limit, offset };
  if (retainId) params.retainIds = [retainId];
  return {
    channel: source.fromNetwork ? "mail:listFromNetwork" : "mail:listFromCache",
    params,
  };
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
  if (status && status.google === false) return { disabled: true, reason: "Google sign-in is unavailable in this installation. Review Google OAuth status in Settings → Accounts." };
  return { disabled: false, reason: "" };
}

function googleOauthClientCopy(status) {
  const source = status && status.source;
  const imported = !!(status && status.imported);
  if (source === "invalid") {
    if (status.invalidSource === "env") return "Google OAuth is not ready. Fix or remove the developer environment override (MORROW_GOOGLE_OAUTH_FILE, MORROW_GOOGLE_OAUTH_JSON, or GOOGLE_DESKTOP_OAUTH_JSON). Importing or clearing a client does not override it.";
    return status.invalidSource === "imported" || (!status.invalidSource && imported)
      ? "The imported Google OAuth file could not be read. Import a Desktop client JSON again, or clear the imported client."
      : "Google OAuth is not ready. The configured Desktop client JSON could not be read.";
  }
  if (!status || status.ready !== true) return "Google OAuth is not ready. Review this installation's Google sign-in configuration. Personal client import is optional.";
  const using = source === "env"
    ? "a developer environment variable"
    : source === "imported"
      ? "your imported Desktop client"
      : source === "bundled"
        ? "the bundled Desktop client"
        : "a Desktop client";
  const saved = source !== "imported" && imported ? " An imported client is also saved on this computer." : "";
  return "Google OAuth is ready. This installation is using " + using + "." + saved;
}

function calendarGrantState(status, account) {
  if (!account || account.platform !== "imap") return { disabled: true, reason: "Connect a Google or Microsoft mailbox first." };
  const profile = String((account.imapSmtpProfile || account.profile || "")).toLowerCase();
  const provider = profile === "gmail" || profile === "outlook" ? profile : "";
  if (!provider) return { disabled: true, reason: "Calendar needs a Google or Microsoft account." };
  if (provider === "gmail" && status && status.google === false) return { disabled: true, reason: "Google sign-in is unavailable in this installation. Review Google OAuth status in Settings → Accounts." };
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
  if (reason === "oauth_not_ready") return "Google sign-in is unavailable in this installation, so Gmail labels stay on IMAP. Review Google OAuth status in Settings → Accounts; personal client import is optional.";
  if (reason === "google_client_changed") return "The saved Google grant belongs to a different or unknown Desktop client. Reauthorize Gmail in Settings → Accounts. Cached mail stays available.";
  if (reason === "imap_only") return "Labels stay on IMAP for this account.";
  if (reason === "no_account") return "Connect a mailbox to load provider labels.";
  if (reason === "error") return "The provider label list failed. IMAP folders are unchanged.";
  return outlook
    ? "Outlook folders are unavailable. IMAP folders are unchanged."
    : "Gmail labels are unavailable. IMAP folders are unchanged.";
}

function showOrganizeGrant(reason) {
  return reason === "scope_missing" || reason === "password_account" || reason === "google_client_changed";
}

function grantApiOutcome(saved, successMessage, fallback) {
  if (saved && saved.api === true) return { ok: true, message: successMessage };
  const message = saved && typeof saved.message === "string" && saved.message.trim()
    ? saved.message.trim()
    : fallback;
  return { ok: false, message: message || "The provider did not return the required grant." };
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

function isAllMailFolder(folder) {
  if (typeof morrowMailboxRoles === "object" && morrowMailboxRoles && typeof morrowMailboxRoles.isAllMail === "function") {
    return morrowMailboxRoles.isAllMail(folder);
  }
  return !!(folder && folder.wellKnownName === "all");
}

function folderCollapse() {
  if (typeof morrowFolderCollapse === "object" && morrowFolderCollapse) return morrowFolderCollapse;
  return null;
}

function imapParent(folder, byId, sep) {
  if (isAllMailFolder(folder)) return null;
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

function providerColumns(tree, pathIds, query) {
  const rows = Array.isArray(tree) ? tree.filter((folder) => folder && folder.id) : [];
  const q = String(query || "").trim().toLowerCase();
  const children = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const folder = rows[i];
    const parent = folder.parentId ? String(folder.parentId) : "";
    const list = children.get(parent);
    if (list) list.push(folder);
    else children.set(parent, [folder]);
  }
  function textHits(folder) {
    const label = String(folder.label || folder.name || folder.id).toLowerCase();
    const name = String(folder.name || "").toLowerCase();
    return label.indexOf(q) >= 0 || name.indexOf(q) >= 0;
  }
  function visibleMatch(folder, seen) {
    if (!q) return true;
    if (textHits(folder)) return true;
    const id = String(folder.id);
    if (seen.has(id)) return false;
    seen.add(id);
    const kids = children.get(id) || [];
    for (let n = 0; n < kids.length; n += 1) {
      if (visibleMatch(kids[n], seen)) return true;
    }
    return false;
  }
  function columnFor(parentId) {
    const kids = children.get(parentId) || [];
    const out = [];
    for (let n = 0; n < kids.length; n += 1) {
      if (visibleMatch(kids[n], new Set())) out.push(kids[n]);
    }
    return out;
  }
  const requested = [];
  const raw = Array.isArray(pathIds) ? pathIds : [];
  for (let i = 0; i < raw.length; i += 1) {
    const id = String(raw[i] || "");
    if (id) requested.push(id);
  }
  const columns = [];
  const path = [];
  let parent = "";
  for (let depth = 0; depth < 24; depth += 1) {
    const column = columnFor(parent);
    if (!column.length && depth > 0) break;
    columns.push(column);
    const wanted = requested[depth] || "";
    let chosen = null;
    for (let n = 0; n < column.length; n += 1) {
      if (String(column[n].id) === wanted) {
        chosen = column[n];
        break;
      }
    }
    if (!chosen) break;
    path.push(String(chosen.id));
    const next = columnFor(String(chosen.id));
    if (!next.length) break;
    parent = String(chosen.id);
  }
  return { columns: columns, path: path };
}

function providerFilterReveal(tree, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  const rows = Array.isArray(tree) ? tree.filter((folder) => folder && folder.id) : [];
  const byId = new Map();
  for (let i = 0; i < rows.length; i += 1) byId.set(String(rows[i].id), rows[i]);
  let match = null;
  for (let i = 0; i < rows.length; i += 1) {
    const folder = rows[i];
    const label = String(folder.label || folder.name || folder.id).toLowerCase();
    const name = String(folder.name || "").toLowerCase();
    if (label.indexOf(q) >= 0 || name.indexOf(q) >= 0) {
      match = folder;
      break;
    }
  }
  if (!match) return [];
  const path = [];
  const seen = new Set();
  let current = match;
  while (current && !seen.has(String(current.id))) {
    seen.add(String(current.id));
    path.unshift(String(current.id));
    current = current.parentId ? byId.get(String(current.parentId)) : null;
  }
  return path;
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

function folderCanNest(kind, folder) {
  if (!folder) return { ok: false, reason: "Choose a folder." };
  if (isVirtualMailbox(folder)) return { ok: false, reason: folder.filterCopy || "That view is a filter, not a folder." };
  if (kind === "imap") {
    const item = imapFolderMenu(folder).items[0];
    return item && item.disabled
      ? { ok: false, reason: item.reason || "This folder cannot be moved." }
      : { ok: true, reason: "" };
  }
  if (kind !== "gmail" && kind !== "outlook") {
    return { ok: false, reason: "This mailbox cannot nest folders." };
  }
  const item = moveMenuItem(folder, kind);
  return item.disabled
    ? { ok: false, reason: item.reason || "This folder cannot be moved." }
    : { ok: true, reason: "" };
}

function nestDropPlan(source, target, flags) {
  if (!source || !source.folderId || !source.kind) {
    return { ok: false, reason: "no_folder", message: "Choose a label or folder to move." };
  }
  if (!target || !target.kind) {
    return { ok: false, reason: "no_target", message: "Drop onto a folder, or onto Top level to unnest." };
  }
  if (source.kind !== target.kind) {
    return { ok: false, reason: "other_kind", message: "Nesting stays with this mailbox's folders." };
  }
  if (source.accountId && target.accountId && source.accountId !== target.accountId) {
    return { ok: false, reason: "other_account", message: "Nesting stays inside this mailbox." };
  }
  const view = flags || { root: { disabled: true, reason: "Choose a folder." }, nodes: [] };
  const dest = target.isRoot
    ? view.root
    : (view.nodes || []).find((node) => node && node.id === String(target.id || ""));
  if (!dest) return { ok: false, reason: "missing", message: "That destination is not in this list." };
  if (dest.disabled) return { ok: false, reason: "blocked", message: dest.reason || "That destination is not available." };
  return {
    ok: true,
    reason: "",
    message: "",
    channel: source.kind === "imap" ? "mail:moveFolder" : "mail:moveProviderFolder",
    params: {
      accountId: source.accountId,
      folderId: source.folderId,
      destinationId: target.isRoot ? "" : String(target.id || ""),
    },
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

function dragGhostHotspot() {
  // The pointer sits in the transparent spacer. The chip hangs below the folder name.
  return { x: 14, y: 8, offset: 48 };
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
  if (target.kind === "virtual" || target.type === "virtual") {
    return {
      ok: false,
      reason: "virtual",
      message: target.dropCopy || target.filterCopy || "That view is a filter, not a folder.",
    };
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
  const stored = storableFolders(imapFolders);
  const message = messageDragPayload(email);
  const moveTree = folderTree(stored);
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

function messageLabelKeys(email) {
  if (!email || typeof email !== "object") return [];
  if (Array.isArray(email.labelIds)) {
    return email.labelIds.map((item) => String(item || "")).filter(Boolean);
  }
  const keys = [];
  if (Array.isArray(email.folders)) {
    for (const item of email.folders) keys.push(item);
  }
  if (email.folderId) keys.push(email.folderId);
  return keys.map((item) => String(item || "")).filter(Boolean);
}

function appliedEditableLabels(email, labels) {
  const rows = Array.isArray(labels) ? labels.filter((row) => row && row.id) : [];
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    byId.set(String(row.id), row);
    const name = String(row.name || "").toLowerCase();
    if (name && !byName.has(name)) byName.set(name, row);
  }
  const ids = [];
  const seen = new Set();
  for (const key of messageLabelKeys(email)) {
    const named = byId.get(key) || byName.get(String(key).toLowerCase());
    if (!named || seen.has(String(named.id))) continue;
    seen.add(String(named.id));
    ids.push(String(named.id));
  }
  return ids;
}

function labelCheckedState(messages, labels) {
  const rows = Array.isArray(labels) ? labels.filter((row) => row && row.id) : [];
  const list = (Array.isArray(messages) ? messages : []).filter((email) => email && email.id);
  const counts = new Map();
  for (const email of list) {
    for (const id of appliedEditableLabels(email, rows)) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const marks = new Map();
  for (const row of rows) {
    const id = String(row.id);
    const n = counts.get(id) || 0;
    let mark = "off";
    if (list.length && n === list.length) mark = "on";
    else if (n > 0) mark = "mixed";
    marks.set(id, mark);
  }
  return marks;
}

function labelChangeForMessages(messages, labels, initial, next) {
  const rows = Array.isArray(labels) ? labels.filter((row) => row && row.id) : [];
  const before = initial instanceof Map ? initial : new Map();
  const after = next instanceof Map ? next : new Map();
  const plans = [];
  for (const email of Array.isArray(messages) ? messages : []) {
    if (!email || !email.id) continue;
    const applied = new Set(appliedEditableLabels(email, rows));
    const add = [];
    const remove = [];
    for (const row of rows) {
      const id = String(row.id);
      const from = before.has(id) ? before.get(id) : "off";
      const to = after.has(id) ? after.get(id) : from;
      if (to === from || to === "mixed") continue;
      if (to === "on" && !applied.has(id)) add.push(id);
      if (to === "off" && applied.has(id)) remove.push(id);
    }
    if (add.length || remove.length) plans.push({ email: email, addLabelIds: add, removeLabelIds: remove });
  }
  return plans;
}

function filterEditableLabels(labels, query) {
  const rows = Array.isArray(labels) ? labels.filter((row) => row && row.id) : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter((row) => {
    const label = String(row.label || "").toLowerCase();
    const name = String(row.name || "").toLowerCase();
    const id = String(row.id || "").toLowerCase();
    return label.indexOf(q) >= 0 || name.indexOf(q) >= 0 || id.indexOf(q) >= 0;
  });
}

function labelEditCalls(plans) {
  const calls = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || !plan.email || !plan.email.id || !plan.email.accountId) continue;
    const add = (Array.isArray(plan.addLabelIds) ? plan.addLabelIds : []).map((id) => String(id || "")).filter(Boolean);
    const remove = (Array.isArray(plan.removeLabelIds) ? plan.removeLabelIds : []).map((id) => String(id || "")).filter(Boolean);
    if (!add.length && !remove.length) continue;
    calls.push({
      channel: "mail:modifyMessageLabels",
      params: {
        accountId: plan.email.accountId,
        emailId: String(plan.email.id),
        addLabelIds: add,
        removeLabelIds: remove,
      },
    });
  }
  return calls;
}

function labelApplyConfirm(plans, labels, scope) {
  const add = [];
  const remove = [];
  const seenAdd = new Set();
  const seenRemove = new Set();
  const nameOf = (id) => {
    const row = (Array.isArray(labels) ? labels : []).find((item) => item && String(item.id) === String(id));
    return row ? String(row.name || row.label || row.id) : String(id);
  };
  for (const plan of Array.isArray(plans) ? plans : []) {
    for (const id of plan.addLabelIds || []) {
      const key = String(id);
      if (seenAdd.has(key)) continue;
      seenAdd.add(key);
      add.push(nameOf(key));
    }
    for (const id of plan.removeLabelIds || []) {
      const key = String(id);
      if (seenRemove.has(key)) continue;
      seenRemove.add(key);
      remove.push(nameOf(key));
    }
  }
  const n = Array.isArray(plans) ? plans.length : 0;
  const noun = n === 1 ? "message" : "messages";
  const parts = [];
  if (add.length) parts.push("Add “" + add.join("”, “") + "”");
  if (remove.length) parts.push("Remove “" + remove.join("”, “") + "”");
  const action = parts.length ? parts.join(". ") : "Update labels";
  return {
    title: "Labels",
    body: action + " on " + n + " " + noun + "." + (scope ? " " + scope : ""),
    confirm: "Apply",
    cancel: "Cancel",
    needsName: false,
    name: "",
  };
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
  if (reason === "oauth_not_ready") return "Google sign-in is unavailable in this installation, so calendar stays offline. Review Google OAuth status in Settings → Accounts; personal client import is optional.";
  if (reason === "google_client_changed") return "The saved Calendar grant belongs to a different or unknown Desktop client. Enable Google Calendar to authorize it separately from Gmail.";
  if (reason === "imap_only") return "Calendar needs a Google or Microsoft account.";
  if (reason === "no_account") return "Connect a Google or Microsoft mailbox. Calendar does not keep events of its own.";
  if (reason === "error") return "Calendar could not be loaded.";
  if (reason === "loading") return "Loading calendar…";
  const who = email ? ` for ${email}` : "";
  return `Enable calendar and mailbox features${who}. Google requests Calendar separately from mail; Microsoft connects mail first, then checks feature permissions for the same account.`;
}

function calendarConnection(status, account, listed, reauthorize = false) {
  const grant = calendarGrantState(status, account);
  if (!account || grant.disabled) {
    return { connected: false, canGrant: false, reason: grant.reason, label: "Enable mailbox features" };
  }
  const rows = status && Array.isArray(status.accounts) ? status.accounts : [];
  const row = rows.find((item) => item && item.id === account.id);
  const connected = !reauthorize && ((row && row.calendar === true) || (listed && listed.api === true));
  return {
    connected,
    canGrant: true,
    reason: connected ? "" : ((row && row.calendarReason) || "needs_auth"),
    label: reauthorize ? "Reauthorize calendar" : connected ? "Refresh calendar" : (account.imapSmtpProfile || account.profile) === "gmail" ? "Enable Google Calendar" : "Enable mailbox features",
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
  const label = typeof displayStamp === "function"
    ? displayStamp(start, "month")
    : start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    label,
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
  } else {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (Number.isFinite(end) && end > start) {
      const dayStart = new Date(key + "T00:00:00");
      if (dayKey(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate()) !== key) return false;
      const dayEnd = new Date(dayStart);
      // Advance the local date, since a day can have 23 or 25 hours.
      dayEnd.setDate(dayEnd.getDate() + 1);
      dayEnd.setHours(0, 0, 0, 0);
      return start < dayEnd.getTime() && end > dayStart.getTime();
    }
  }
  return startKey === key;
}

function allDayContinues(event, key) {
  if (!event || !event.allDay || !key) return false;
  const startKey = eventDay(event);
  return !!(startKey && key > startKey && eventCoversDay(event, key));
}

function eventsOnDay(events, key) {
  return (Array.isArray(events) ? events : []).filter((event) => eventCoversDay(event, key));
}

function clockLabel(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  if (typeof displayStamp === "function") return displayStamp(date, "time");
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

function formatEventDetailWhen(event) {
  if (!event || !event.start) return "";
  if (event.allDay) {
    const start = shownDayKey(String(event.start).slice(0, 10));
    const end = shownDayKey(String(event.end || "").slice(0, 10));
    if (String(event.end || "").slice(0, 10) > String(event.start || "").slice(0, 10) && /^\d{4}-\d{2}-\d{2}$/.test(String(event.end || "").slice(0, 10))) {
      return start + " – " + end + " (end date is exclusive)";
    }
    return "All day · " + start;
  }
  const startMs = Date.parse(event.start);
  if (!Number.isFinite(startMs)) return formatEventWhen(event);
  const date = displayStamp(new Date(startMs), "date", { weekday: true });
  const when = formatEventWhen(event);
  return when ? date + " · " + when : date;
}

function eventChip(event) {
  const title = (event && event.title) || "(no title)";
  if (!event || event.allDay) return title;
  const when = formatEventWhen(event);
  return when ? `${when} ${title}` : title;
}

function agendaEvents(events) {
  return (Array.isArray(events) ? events : []).slice().sort((left, right) => {
    return compareCalendarStarts(left, right);
  });
}

function compareCalendarStarts(left, right) {
  const startOf = (event) => Date.parse(event?.allDay ? String(event.start).slice(0, 10) + "T00:00:00" : event?.start);
  const difference = startOf(left) - startOf(right);
  return Number.isFinite(difference) ? difference : String(left?.start || "").localeCompare(String(right?.start || ""));
}

function agendaLine(event) {
  if (!event) return "";
  let dayLabel = eventDay(event);
  if (dayLabel && typeof displayStamp === "function") {
    const bits = dayLabel.split("-");
    if (bits.length === 3) {
      const date = new Date(Number(bits[0]), Number(bits[1]) - 1, Number(bits[2]));
      if (!Number.isNaN(date.getTime())) {
        const formatted = displayStamp(date, "date");
        if (formatted) dayLabel = formatted;
      }
    }
  }
  const parts = [dayLabel, formatEventWhen(event), event.title || "(no title)"];
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

function calendarColor(id) {
  const palette = ["#1a73e8", "#188038", "#d93025", "#e37400", "#a142f4", "#039be5", "#0b8043"];
  const text = String(id || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash + text.charCodeAt(i)) % palette.length;
  return palette[hash];
}

function localDateStamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function plusDays(stamp, count) {
  const parts = String(stamp || "").split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return "";
  return localDateStamp(new Date(y, m - 1, d + count));
}

function toDateTimeLocal(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return localDateStamp(date) + "T" + hh + ":" + mm;
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
      ? "Plain text only. Dates take effect on whole UTC days: start rounds down, end rounds up unless already midnight UTC. The final review shows effective dates. Morrow installs only morrow-vacation and will not replace a different active Sieve script."
      : "Plain text only. Save replaces rich formatting. Outlook keeps separate internal and external messages. Disable keeps the provider’s existing templates.",
  };
}

function vacationConfirm(kind, owner, options) {
  const who = owner || "this mailbox";
  const provider = options && options.provider;
  const closed = "Your mail server will send these automatic replies to the audience below, including while Morrow is closed.";
  if (kind === "grant") {
    const scope = options && options.scope ? options.scope : "the provider settings permission";
    const bundle = provider === "google" ? "the Gmail mail, organize, Out of Office, and inbox rules grant. Calendar permission is separate" : "the Microsoft Graph calendar, organize, Out of Office, and inbox rules bundle";
    return {
      title: "Allow Out of Office settings",
      body: "Allow Out of Office settings access for " + who + "?\n\nThe browser will request " + scope + " as part of " + bundle + ". Enabling replies still needs a separate Save confirmation. The existing mailbox connection stays if consent is incomplete.",
      confirm: "Continue",
      cancel: "Cancel",
      needsName: false,
    };
  }
  if (kind === "disable") {
    const kept = provider === "imap" ? "Only Morrow’s own vacation script is removed." : "Existing templates are retained.";
    return {
      title: "Disable automatic replies",
      body: "Disable automatic replies for " + who + "?\n\nNew automatic replies will stop after the provider applies this change. " + kept,
      confirm: "Disable",
      cancel: "Cancel",
      needsName: false,
    };
  }
  const mode = options && options.mode ? options.mode : "disabled";
  const row = options || {};
  const audience = provider === "imap" ? "All senders" : provider === "microsoft"
    ? "Internal senders; external: " + ({ none: "no external replies", contacts: "contacts only", all: "all senders" }[row.audience] || "all senders")
    : (row.audience === "contacts" ? "Contacts only" : "All senders") + (row.restrictToDomain ? "; within your Google Workspace domain only" : "");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = (value, end) => {
    if (!value) return end ? "No end" : "Immediately";
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return "Unknown";
    if (provider !== "imap") {
      return typeof displayStamp === "function"
        ? displayStamp(time, "dateTime", { withZone: true })
        : time.toLocaleString() + " (" + zone + ")";
    }
    const midnight = Date.parse(time.toISOString().slice(0, 10) + "T00:00:00.000Z");
    return new Date(midnight + (end && time.getTime() > midnight ? 86400000 : 0)).toISOString().slice(0, 10) + " 00:00 UTC" + (end ? " (exclusive)" : "");
  };
  const dates = mode === "scheduled" ? "Effective start: " + date(row.start, false) + "\nEffective end: " + date(row.end, true) : mode === "always" ? "Effective: immediately, until disabled." : "Automatic replies stay disabled.";
  const excerpt = (text) => String(text || "").slice(0, 240) + (String(text || "").length > 240 ? "…" : "");
  const where = "Provider: " + (provider === "imap" ? "IMAP / ManageSieve" : provider === "microsoft" ? "Microsoft" : "Google")
    + ". Mode: " + mode + ".\n" + dates + "\nAudience: " + audience
    + (provider === "imap" ? "\nDates use whole UTC days." : mode === "disabled" ? "\nExisting provider templates are retained." : "\nSaving plain text replaces rich formatting.")
    + (mode !== "disabled" ? (row.subject ? "\nSubject: " + excerpt(row.subject) : "")
      + "\n" + (provider === "microsoft" ? "Internal reply: " : "Reply: ") + excerpt(row.message)
      + (provider === "microsoft" ? "\nExternal reply: " + excerpt(row.externalMessage) : "") : "");
  return {
    title: mode === "disabled" ? "Save disabled settings" : "Save and enable",
    body: (mode === "disabled" ? "Save disabled settings for " : "Enable automatic replies for ") + who + "?\n\n"
      + (mode === "disabled" ? "These settings will not enable automatic replies." : closed) + "\n\n" + where,
    confirm: "Save",
    cancel: "Cancel",
    needsName: false,
  };
}

function calendarDraft(input, omitTitle = false, omitTime = false) {
  const title = String((input && input.title) || "").trim();
  const startRaw = String((input && input.start) || "").trim();
  const endRaw = String((input && input.end) || "").trim();
  const calendarId = String((input && input.calendarId) || "").trim();
  const accountId = String((input && input.accountId) || "").trim();
  if (!accountId) return { error: "Connect a Google or Microsoft mailbox first." };
  if (!calendarId) return { error: "Choose a calendar." };
  if (!omitTitle && !title) return { error: "Add a title." };
  if (!omitTitle && (title.length > 200 || /[\u0000-\u001f\u007f]/.test(title))) return { error: "Use a title of at most 200 characters without control characters." };
  const location = String((input && input.location) || "").trim();
  const description = String((input && input.description) || "").trim();
  const allDay = !!(input && input.allDay);
  const eventId = String((input && input.eventId) || "").trim();
  if (omitTime && eventId) return { error: "", accountId, calendarId, eventId,
    ...(omitTitle ? {} : { title }), location, description };
  if (allDay) {
    const start = startRaw.slice(0, 10);
    const end = endRaw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) {
      return { error: "Pick a start date and a later end date." };
    }
    const body = {
      error: "",
      accountId: accountId,
      calendarId: calendarId,
      ...(omitTitle ? {} : { title }),
      location: location,
      description: description,
      allDay: true,
      start: start,
      end: end,
    };
    if (eventId) body.eventId = eventId;
    return body;
  }
  const start = Date.parse(startRaw);
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { error: "Pick a start and a later end." };
  for (const raw of [startRaw, endRaw]) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)) continue;
    const parsed = new Date(raw);
    const offsets = [-86400000, 86400000].map((shift) => new Date(parsed.getTime() + shift).getTimezoneOffset());
    if (toDateTimeLocal(raw) !== raw.slice(0, 16) || offsets.some((offset) => {
      const alternate = parsed.getTime() + (offset - parsed.getTimezoneOffset()) * 60000;
      return alternate !== parsed.getTime() && toDateTimeLocal(new Date(alternate).toISOString()) === raw.slice(0, 16);
    })) return { error: "This local time is missing or ambiguous at a daylight-saving change. Choose another time or edit it with the calendar provider using an explicit offset." };
  }
  const body = {
    error: "",
    accountId: accountId,
    calendarId: calendarId,
    ...(omitTitle ? {} : { title }),
    location: location,
    description: description,
    allDay: false,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
  if (eventId) body.eventId = eventId;
  return body;
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
  if (message) {
    const error = new Error(message);
    if (typeof result?.error?.code === "string") error.code = result.error.code;
    throw error;
  }
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

const pageMotionArmed = { agent: false, calendar: false, brain: false };

function armPageMotion(view) {
  if (Object.prototype.hasOwnProperty.call(pageMotionArmed, view)) pageMotionArmed[view] = true;
}

function paintMotionRows(view, nodes) {
  if (!pageMotionArmed[view]) return;
  const list = [];
  if (nodes && nodes.length) {
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].nodeType === 1) list.push(nodes[i]);
    }
  }
  if (!list.length) return;
  pageMotionArmed[view] = false;
  const motion = motionApi();
  if (motion) motion.rows(list);
}

function playPageSections(id) {
  const motion = motionApi();
  const node = $(id);
  if (!motion || !node || typeof motion.sections !== "function") return;
  motion.sections(node.querySelectorAll(id === "calendar-panel" ? ":scope > .calendar-bar" : ":scope > .motion-block"));
}

function afterPaint(task) {
  // Yield through a frame and a task so the visible shell can paint before work starts.
  requestAnimationFrame(() => setTimeout(task, 0));
}

function setPageBusy(panel, on, label) {
  const root = typeof panel === "string" ? $(panel) : panel;
  if (!root || !root.querySelector) return;
  let overlay = root.querySelector(":scope > .page-busy");
  if (!on) {
    root.removeAttribute("aria-busy");
    if (overlay) overlay.remove();
    return;
  }
  root.setAttribute("aria-busy", "true");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "page-busy";
    overlay.setAttribute("role", "status");
    const spin = document.createElement("span");
    spin.className = "page-busy-spin";
    spin.setAttribute("aria-hidden", "true");
    const text = document.createElement("p");
    text.className = "page-busy-label";
    overlay.append(spin, text);
    root.appendChild(overlay);
  }
  const text = overlay.querySelector(".page-busy-label");
  if (text) text.textContent = label || "Working…";
}

// Field-level errors: attach aria-invalid and aria-describedby to the control
// so the message is tied to the field, not only to the shared status line.
function insertFieldError(input, node) {
  const label = input.closest && input.closest("label");
  if (label && label.contains(input) && label.parentNode) {
    label.parentNode.insertBefore(node, label.nextSibling);
    return;
  }
  const fieldset = input.closest && input.closest("fieldset");
  if (fieldset && fieldset.parentNode) {
    fieldset.parentNode.insertBefore(node, fieldset.nextSibling);
    return;
  }
  const field = input.closest && input.closest(".field");
  if (field) {
    const help = field.querySelector(".hint");
    field.insertBefore(node, help || null);
    return;
  }
  if (input.parentNode) input.parentNode.insertBefore(node, input.nextSibling);
}

function setFieldError(id, message) {
  const input = $(id);
  if (!input) return;
  const errorId = id + "-error";
  const existing = document.getElementById(errorId);
  const describedBy = String(input.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter(value => value && value !== errorId);
  if (!message) {
    if (existing) existing.remove();
    input.removeAttribute("aria-invalid");
    if (describedBy.length) input.setAttribute("aria-describedby", describedBy.join(" "));
    else input.removeAttribute("aria-describedby");
    return;
  }
  let node = existing;
  if (!node) {
    node = document.createElement("p");
    node.id = errorId;
    node.className = "field-error";
    insertFieldError(input, node);
  }
  node.textContent = message;
  input.setAttribute("aria-invalid", "true");
  describedBy.push(errorId);
  input.setAttribute("aria-describedby", describedBy.join(" "));
}

function clearFieldErrors(ids) {
  for (const id of ids) setFieldError(id, "");
}

let agentLoadOverlay = false;
let agentLoaded = false;

function syncAgentPageBusy() {
  setPageBusy("agent-panel", !!(agentChatBusy || agentLoadOverlay), "Working…");
}

function hidePane(id) {
  const el = $(id);
  el.hidden = true;
  const motion = motionApi();
  if (motion && typeof motion.reset === "function") {
    motion.reset(el);
    for (const child of el.querySelectorAll("[data-motion]")) motion.reset(child);
  } else if (el.getAnimations) {
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

const dialogCloseGen = new WeakMap();

function clearDialogMotion(dialog) {
  if (dialog.getAnimations) {
    for (const animation of dialog.getAnimations()) animation.cancel();
  }
  dialog.style.opacity = "";
  dialog.style.transform = "";
  dialog.style.transformOrigin = "";
  delete dialog.dataset.closing;
}

function closeDialog(id) {
  const dialog = $(id);
  if (!dialog || !dialog.open || dialog.dataset.closing === "1") return;
  const motion = motionApi();
  if (!motion || !motion.wantsCloseMotion()) {
    dialog.close();
    return;
  }
  const generation = (dialogCloseGen.get(dialog) || 0) + 1;
  dialogCloseGen.set(dialog, generation);
  dialog.dataset.closing = "1";
  return motion.dialogOut(dialog).then(() => {
    if (dialogCloseGen.get(dialog) !== generation) return;
    if (dialog.open) dialog.close();
    clearDialogMotion(dialog);
  });
}

function releaseClosingDialog(dialog) {
  dialogCloseGen.set(dialog, (dialogCloseGen.get(dialog) || 0) + 1);
  clearDialogMotion(dialog);
  if (dialog.open) dialog.close();
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
  input.placeholder = copy.needsName ? (copy.placeholder || "") : "";
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
  let resolveConfirm = null;
  const pending = new Promise((resolve) => {
    resolveConfirm = resolve;
  });
  // Close motion still has the dialog open. Drop that generation before the
  // close event so it cannot cancel this prompt, then show the new one now.
  if (dialog.open && dialog.dataset.closing === "1") {
    confirmResult = null;
    releaseClosingDialog(dialog);
  }
  confirmResult = resolveConfirm;
  if (!dialog.open) openDialog("confirm");
  focusConfirm(copy);
  return pending;
}

function confirmSettled() {
  const dialog = $("confirm");
  if (!dialog || !dialog.open) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    dialog.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
  if (confirmCopy && confirmCopy.needsName && !confirmCopy.allowEmpty && !name) {
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
  if (/^#[0-9A-Fa-f]{6}$/.test(color) && color.toUpperCase() !== "#193C34") {
    root.style.setProperty("--accent", color);
    root.style.setProperty("--accent-ink", color);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-ink");
  }
  return mode;
}

function displayStamp(date, kind, extra) {
  const options = extra && typeof extra === "object" ? extra : {};
  const api = typeof morrowDisplayFormat === "object" && morrowDisplayFormat ? morrowDisplayFormat : null;
  const prefs = state && state.prefs ? state.prefs : {};
  if (kind === "weekdays") {
    if (api && typeof api.weekdayLabels === "function") return api.weekdayLabels(options);
    if (options.narrow) return ["S", "M", "T", "W", "T", "F", "S"];
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  let text = "";
  if (api) {
    if (kind === "time") text = api.formatTime(date, prefs, options);
    else if (kind === "date") text = api.formatDate(date, prefs, options);
    else if (kind === "month") text = api.formatMonthLabel(date, prefs, options);
    else if (kind === "list") text = api.formatListWhen(date, options.now instanceof Date ? options.now : new Date(), prefs, options);
    else text = api.formatDateTime(date, prefs, options);
  } else if (kind === "time") {
    text = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else if (kind === "month") {
    text = date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } else if (kind === "list") {
    const now = options.now instanceof Date ? options.now : new Date();
    if (date.toDateString() === now.toDateString()) text = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    else {
      const sameYear = date.getFullYear() === now.getFullYear();
      text = date.toLocaleDateString([], sameYear
        ? { month: "short", day: "numeric" }
        : { year: "numeric", month: "short", day: "numeric" });
    }
  } else if (kind === "date") {
    if (options.omitYear) text = date.toLocaleDateString([], { month: "short", day: "numeric" });
    else if (options.weekday) {
      text = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } else text = date.toLocaleDateString();
  } else if (options.compact) {
    text = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } else if (options.medium) {
    try { text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
    catch { text = date.toLocaleString(); }
  } else text = date.toLocaleString();
  if (options.withZone && text) {
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { zone = ""; }
    if (zone) text += " (" + zone + ")";
  }
  return text;
}

function shownWhen(date, withZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return displayStamp(date, "dateTime", withZone ? { withZone: true } : undefined);
}

function shownDayKey(value) {
  const day = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return String(value || "");
  const parts = day.split("-");
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(date.getTime())) return day;
  return displayStamp(date, "date") || day;
}

function listWhen(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return displayStamp(date, "list", { now: new Date() });
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
    case "all": return "📨";
    case "inbox": return "📥";
    case "starred": return "⭐";
    case "unread": return "✉️";
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

const SCHEDULE_UNDO_MS = 8000;

function scheduleDelayMinutes(value) {
  const n = typeof value === "number" ? value : (typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  if (!Number.isInteger(n) || n < 0 || n > 10080) return 0;
  return n;
}

function splitScheduleDelay(minutes) {
  const delay = scheduleDelayMinutes(minutes);
  return { hours: Math.floor(delay / 60), minutes: delay % 60 };
}

function joinScheduleDelay(hours, minutes) {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || minutes < 0 || hours > 168 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  if (total > 10080) return null;
  return total;
}

function formatScheduleDelay(minutes) {
  const parts = splitScheduleDelay(minutes);
  if (!parts.hours && !parts.minutes) return "";
  if (parts.hours && parts.minutes) return parts.hours + "h " + parts.minutes + "m";
  if (parts.hours) return parts.hours + "h";
  return parts.minutes + "m";
}

function defaultSendAt(now, minutes) {
  const delay = scheduleDelayMinutes(minutes);
  if (!delay) return null;
  const start = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + delay * 60 * 1000);
}

function sendButtonLabel(minutes, review) {
  if (review) return "Send";
  const text = formatScheduleDelay(minutes);
  return text ? "Schedule in " + text : "Send";
}

function layoutBound(value, min, max) {
  const n = typeof value === "number" ? value : (typeof value === "string" && /^-?\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function layoutPanesPref(value) {
  const fallback = { folders: 260, list: 360, reading: 0 };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const folders = layoutBound(value.folders, 140, 1600);
  const list = layoutBound(value.list, 200, 2000);
  const reading = layoutBound(value.reading, 0, 4000);
  if (folders == null || list == null || reading == null) return { ...fallback };
  return { folders, list, reading };
}

function clampLayoutMeasure(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function measuredLayoutPanes(folders, list, reading) {
  return {
    folders: clampLayoutMeasure(folders, 140, 1600, 260),
    list: clampLayoutMeasure(list, 200, 2000, 360),
    reading: clampLayoutMeasure(reading, 0, 4000, 0),
  };
}

function applyLayoutPanes(value) {
  const root = document.documentElement;
  if (!root || !root.style || typeof root.style.setProperty !== "function") return;
  const panes = layoutPanesPref(value);
  root.style.setProperty("--folders", panes.folders + "px");
  root.style.setProperty("--list", panes.list + "px");
}

function rememberLayoutPanes() {
  const side = sideColumn();
  const list = $("messages");
  const reader = $("reader");
  if (!side || !list || !reader || !api || typeof side.getBoundingClientRect !== "function") return;
  const panes = measuredLayoutPanes(
    side.getBoundingClientRect().width,
    list.getBoundingClientRect().width,
    reader.getBoundingClientRect().width
  );
  state.prefs.layout = panes;
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    api.invoke("morrow:configSetLayoutPanes", panes).catch(() => {});
  }, 200);
}

function attachmentLimitCopy(provider) {
  if (provider === "gmail") return "Gmail rejects messages larger than 25 MB.";
  if (provider === "outlook") return "Outlook rejects messages larger than 25 MB.";
  return "Gmail and Outlook reject messages larger than 25 MB.";
}

function attachmentCapCopy(filename, size, total, provider) {
  const limit = attachmentLimitCopy(provider);
  const cap = 25 * 1024 * 1024;
  const name = String(filename || "That file");
  if (size > cap) return `${name} is ${fileSize(size) || "over 25 MB"}. ${limit}`;
  if (total > cap) return `These files are ${fileSize(total) || "over 25 MB"} together. ${limit}`;
  return "";
}

function composeFileMeta(row) {
  if (!row || typeof row !== "object") return null;
  const storageUrl = typeof row.storageUrl === "string" && row.storageUrl.startsWith("local:") ? row.storageUrl : "";
  if (!storageUrl) return null;
  const filename = String(row.filename || row.name || "").trim() || "attachment";
  const size = Number(row.size);
  return {
    id: row.id ? String(row.id) : storageUrl,
    storageUrl,
    filename,
    mimeType: String(row.mimeType || row.contentType || "application/octet-stream"),
    ...(row.contentId ? { contentId: row.contentId } : {}),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

function composeAttachmentList(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const meta = composeFileMeta(row);
    if (!meta || seen.has(meta.storageUrl)) continue;
    seen.add(meta.storageUrl);
    out.push(meta);
  }
  return out;
}

function attachmentPayload(rows) {
  return composeAttachmentList(rows).map((row) => ({
    storageUrl: row.storageUrl,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    id: row.id,
    ...(row.contentId ? { contentId: row.contentId } : {}),
  }));
}

function attachmentKey(rows) {
  return composeAttachmentList(rows).map((row) => row.storageUrl).join("\n");
}

function reviewComposeFiles(existing, incoming, provider) {
  const rows = composeAttachmentList(existing);
  let total = rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
  const errors = [];
  const accepted = [];
  const files = Array.isArray(incoming) ? incoming : [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const name = String((file && (file.filename || file.name)) || "").trim() || "attachment";
    const size = Number(file && file.size);
    if (!Number.isFinite(size) || size <= 0) {
      errors.push(`${name} is empty.`);
      continue;
    }
    const reason = attachmentCapCopy(name, size, total + size, provider);
    if (reason) {
      errors.push(reason);
      continue;
    }
    total += size;
    accepted.push({ index, filename: name, size });
  }
  return { accepted, errors, total };
}

function previewDraft(fields, quote, when, files) {
  const source = fields && typeof fields === "object" ? fields : {};
  const to = String(source.to || "").trim();
  const cc = String(source.cc || "").trim();
  const bcc = String(source.bcc || "").trim();
  const subject = String(source.subject || "").trim() || "(no subject)";
  const body = outgoingBody(source.body, quote);
  const schedule = when instanceof Date && !Number.isNaN(when.getTime()) ? when : null;
  return {
    kind: schedule ? "schedule" : "send",
    to,
    cc,
    bcc,
    subject,
    body,
    attachments: composeAttachmentList(files).map((row) => ({ filename: row.filename, size: row.size })),
    sendAt: schedule ? schedule.toISOString() : "",
    ...(source.fromAddress ? { fromAddress: source.fromAddress, fromDisplayName: source.fromDisplayName || "" } : {}),
  };
}

function scheduledRows(data) {
  return Array.isArray(data) ? data.filter((row) => row && row.id && !(row.outbox === true && (row.status === "pending" || row.status === "sending"))) : [];
}

function outboxRowsFrom(data) {
  return Array.isArray(data) ? data.filter((row) => row && row.id && row.outbox === true && (row.status === "pending" || row.status === "sending")) : [];
}

function outboxEmptyCopy() {
  return "Nothing is waiting to send. After Send, the message stays here until the undo delay ends.";
}

function outboxSnippet(row) {
  if (row && (row.status === "sending" || row.outboxStatus === "sending")) return "Sending…";
  const to = String((row && row.to) || "").trim();
  return to ? "To " + to : "Waiting to send";
}

function outboxEmails(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id,
    accountId: row.accountId,
    outbox: true,
    outboxStatus: row.status || row.outboxStatus || "pending",
    subject: row.subject || "",
    from: row.fromAddress || "",
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    date: row.sendAt,
    snippet: outboxSnippet(row),
    htmlBody: row.htmlBody || "",
    textBody: plainFromMailHtml(row.htmlBody || ""),
    unread: false,
    isStarred: false,
    draftId: row.draftId,
    draftRevision: row.draftRevision,
    fromAddress: row.fromAddress,
    fromDisplayName: row.fromDisplayName,
    attachments: row.attachments,
    inReplyTo: row.inReplyTo,
    threadId: row.threadId,
  }));
}

function outboxComposeSeed(row, payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const html = typeof source.body === "string" ? source.body : (row && row.htmlBody) || "";
  const subject = source.subject || (row && row.subject) || "";
  const seed = {
    recoveredSnapshot: true,
    title: subject || "Message",
    accountId: source.accountId || (row && row.accountId),
    fromAddress: source.fromAddress || (row && row.fromAddress),
    fromDisplayName: source.fromDisplayName || (row && row.fromDisplayName) || "",
    to: people(source.to != null ? source.to : row && row.to),
    cc: people(source.cc != null ? source.cc : row && row.cc),
    bcc: people(source.bcc != null ? source.bcc : row && row.bcc),
    subject,
    body: plainFromMailHtml(html),
    htmlBody: html,
    attachments: source.attachments || (row && row.attachments),
    draftId: source.draftId || (row && row.draftId),
    draftRevision: typeof source.draftRevision === "string" ? source.draftRevision : row && row.draftRevision,
    inReplyTo: source.inReplyTo || (row && row.inReplyTo) || "",
    threadId: source.threadId || (row && row.threadId) || "",
    status: "Send canceled. Your draft is ready to edit.",
  };
  const todo = explicitAgentTodo(source.agentTodo);
  if (todo) seed.agentTodo = todo;
  return seed;
}

function scheduledEmptyCopy() {
  return "No scheduled mail or delivery records on this computer.";
}

function scheduledSummary(rows) {
  const list = scheduledRows(rows);
  if (!list.length) return "";
  const accounts = new Set(list.map((row) => row && row.accountId).filter(Boolean));
  const noun = list.length === 1 ? "message" : "messages";
  const count = accounts.size;
  if (!count) return list.length + " scheduled " + noun + ".";
  return list.length + " scheduled " + noun + " from " + count + " " + (count === 1 ? "account" : "accounts") + ".";
}

function scheduledLine(row, accounts = []) {
  const subject = String((row && row.subject) || "").trim() || "(no subject)";
  const to = Array.isArray(row && row.to) ? row.to.filter(Boolean).join(", ") : String((row && row.to) || "").trim();
  const when = row && row.sendAt ? new Date(row.sendAt) : null;
  const time = when && !Number.isNaN(when.getTime())
    ? (typeof displayStamp === "function"
      ? displayStamp(when, "dateTime", { withZone: true })
      : when.toLocaleString() + " (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")")
    : "Unknown time";
  const detail = String(row && row.error || "").trim();
  const account = accounts.find(item => item.id === row.accountId);
  const label = row.status === "partial" ? "Partly sent — rejected recipients need review; no automatic resend"
    : row.status === "unknown" ? "Delivery uncertain — check Sent; no automatic resend"
    : row.status === "sent" ? "Provider accepted — check Sent; no automatic resend"
    : row.status === "failed" ? "Failed — not sent; edit to retry" : row.status === "sending" ? "Sending" : "Pending";
  return [account ? account.email : (row && row.accountId), subject, to, time, label, detail].filter(Boolean).join(" · ");
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

function translateLangPref(value) {
  const lang = typeof window !== "undefined" && window.morrowTranslateLang;
  if (lang && typeof lang.cast === "function") {
    try { return lang.cast(value, true); } catch { return "zh-Hant"; }
  }
  const aliases = {
    "zh-hant": "zh-Hant",
    "zh-tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    "zh-hans": "zh-Hant",
    "zh-cn": "zh-Hant",
    chinese: "zh-Hant",
    "simplified chinese": "zh-Hant",
    "traditional chinese": "zh-Hant",
    en: "en",
    english: "en",
    es: "es",
    spanish: "es",
    fr: "fr",
    french: "fr",
    de: "de",
    german: "de",
    ja: "ja",
    japanese: "ja",
  };
  const key = String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
  return aliases[key] || "zh-Hant";
}

function translateLangLabel(value) {
  const code = translateLangPref(value);
  const lang = typeof window !== "undefined" && window.morrowTranslateLang;
  if (lang && typeof lang.label === "function") return lang.label(code);
  if (code === "zh-Hant") return "Traditional Chinese (繁體中文)";
  return { en: "English", es: "Spanish", fr: "French", de: "German", ja: "Japanese" }[code] || "Traditional Chinese (繁體中文)";
}

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

function chosenSignatureId(pack, accountId, policyDomain) {
  if (policyDomain) {
    const byAccount = pack && pack.signatureByDomainPerAccount && accountId ? pack.signatureByDomainPerAccount[accountId] : null;
    const bound = byAccount && Object.hasOwn(byAccount, policyDomain) ? String(byAccount[policyDomain]) : "";
    const rows = pack && Array.isArray(pack.signatures) ? pack.signatures : [];
    if (bound && rows.some((row) => row && String(row.id) === bound)) return bound;
  }
  const per = pack && pack.defaultSignaturePerAccount;
  const fromAccount = per && accountId ? per[accountId] : null;
  if (fromAccount) return String(fromAccount);
  if (pack && pack.defaultSignatureId) return String(pack.defaultSignatureId);
  // One unbound signature is already the account default, including rows saved before that flag existed.
  const owned = pack && Array.isArray(pack.signatures) ? pack.signatures.filter((row) => {
    return row && row.id && (!row.accountId || !accountId || String(row.accountId) === String(accountId));
  }) : [];
  if (owned.length === 1) {
    const id = String(owned[0].id);
    const map = pack.signatureByDomainPerAccount && accountId ? pack.signatureByDomainPerAccount[accountId] : null;
    if (!map || !Object.keys(map).some((domain) => String(map[domain]) === id)) return id;
  }
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

function signatureMarkup(row) {
  if (!row) return "";
  if (typeof row.html === "string" && row.html.trim()) return row.html.trim();
  const text = typeof row.text === "string" ? row.text.trim() : "";
  return text ? toHtml(text) : "";
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
  if (Array.isArray(source.domains)) payload.domains = source.domains.slice();
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

function signatureUntouched(body, previous) {
  const base = String(body || "");
  const prev = String(previous || "");
  if (!prev) return true;
  return base === prev || base.endsWith(`\n\n${prev}`);
}

function replaceSignature(body, previous, next) {
  if (!signatureUntouched(body, previous)) return { body: String(body || ""), applied: false };
  return { body: applySignature(body, previous, next), applied: true };
}

function commitPickerSignature(body, previous, next) {
  const text = String(next || "");
  return { body: applySignature(body, previous, text), previous: text ? text : String(previous || "") };
}

function applyFromSignature(input) {
  const source = input || {};
  const body = String(source.body || "");
  const previous = String(source.previous || "");
  if (!source.follows || !source.pack) return { body, previous, applied: false, pickerId: null };
  const id = chosenSignatureId(source.pack, source.accountId, source.policyDomain);
  const rows = Array.isArray(source.rows) ? source.rows : signatureRows(source.pack);
  const match = id ? rows.find((row) => String(row.id) === String(id)) : null;
  const next = match ? signaturePlain(match) : "";
  const markup = match ? signatureMarkup(match) : "";
  const replaced = replaceSignature(body, previous, next);
  if (!replaced.applied) return { body, previous, applied: false, pickerId: null };
  return { body: replaced.body, previous: next, applied: true, pickerId: match ? String(match.id) : "", html: markup };
}

function people(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value ? String(value) : "";
}

function readable(email) {
  if (email && email.textBody) return String(email.textBody);
  // Plain-text quotes and AI inputs must not contain CSS/script source.
  const text = String((email && email.htmlBody) || "")
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .trim();
  return text || (email && email.snippet) || "";
}

function plainFromMailHtml(html) {
  return String(html || "")
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .trim();
}

function translateSource(email) {
  if (email && email.htmlBody) {
    const text = plainFromMailHtml(email.htmlBody);
    if (text) return text;
  }
  if (email && email.textBody) return String(email.textBody);
  return (email && email.snippet) || "";
}

function translateNodes(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({ node_id: "n" + index, text: part }));
}

// Layout attributes and a filtered CSS subset. Handlers, embedded documents, and
// active URLs stay out. Style attributes are renamed before the HTML parser sees
// them, then declarations are applied through CSSOM. style-src stays 'self'.
const MAIL_ALIGN = new Set("left right center justify top middle bottom baseline absbottom absmiddle texttop".split(" "));
const MAIL_CSS_PROPS = new Set(("color background background-color background-image background-repeat background-position background-size " +
  "font font-family font-size font-weight font-style font-variant line-height letter-spacing word-spacing word-break overflow-wrap " +
  "text-align text-decoration text-transform text-indent white-space vertical-align " +
  "margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left " +
  "border border-width border-style border-color border-collapse border-spacing border-radius " +
  "border-top border-right border-bottom border-left " +
  "border-top-width border-right-width border-bottom-width border-left-width " +
  "border-top-style border-right-style border-bottom-style border-left-style " +
  "border-top-color border-right-color border-bottom-color border-left-color " +
  "width height max-width min-width max-height min-height display float clear table-layout empty-cells " +
  "list-style list-style-type list-style-position overflow overflow-x overflow-y opacity direction box-sizing position").split(/\s+/));
const MAIL_LAYOUT = {
  table: ["width", "height", "align", "border", "cellpadding", "cellspacing", "bgcolor"],
  thead: ["align", "valign", "bgcolor"],
  tbody: ["align", "valign", "bgcolor"],
  tfoot: ["align", "valign", "bgcolor"],
  tr: ["align", "valign", "bgcolor", "height"],
  td: ["width", "height", "align", "valign", "colspan", "rowspan", "bgcolor", "nowrap"],
  th: ["width", "height", "align", "valign", "colspan", "rowspan", "bgcolor", "nowrap"],
  col: ["width", "span", "align"],
  colgroup: ["width", "span", "align"],
  caption: ["align"],
  img: ["width", "height", "align", "border"],
  font: ["color", "face", "size"],
  p: ["align"], div: ["align"], span: ["align"], hr: ["width", "align"],
  h1: ["align"], h2: ["align"], h3: ["align"], h4: ["align"], h5: ["align"], h6: ["align"],
};

function mailMeasure(value) {
  const v = String(value || "").trim();
  if (/^\d{1,4}$/.test(v) || /^\d{1,4}%$/.test(v)) return v;
  const px = v.match(/^(\d{1,4})px$/i);
  return px ? px[1] : "";
}

function mailInt(value, max) {
  const v = String(value || "").trim();
  if (!/^\d{1,3}$/.test(v)) return "";
  const n = Number(v);
  return n <= max ? String(n) : "";
}

function mailColor(value) {
  const v = String(value || "").trim();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v.toLowerCase();
  if (/^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(v)) return v.replace(/\s+/g, "");
  return "";
}

function mailRemoteUrl(value) {
  const v = String(value || "").trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(v) && v.length <= 2000) return v;
  return "";
}

function mailHref(value) {
  const v = String(value || "").trim();
  if (mailRemoteUrl(v)) return v;
  if (/^mailto:[^\s"'<>]+$/i.test(v) && v.length <= 500) return v;
  return "";
}

function mailImageSrc(src, imagesOn) {
  const value = String(src || "").replace(/\s+/g, "").trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(value) && value.length <= 2000) return imagesOn ? value : "";
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= 8000000) return value;
  return "";
}

function mailScopeToken(name) {
  const clean = String(name || "").replace(/[^\w-]/g, "");
  if (!/^[_a-zA-Z][\w-]*$/.test(clean)) return "";
  return "mmail-" + clean.slice(0, 80);
}

function mailScopeClass(value) {
  return String(value || "").split(/\s+/).map(mailScopeToken).filter(Boolean).join(" ");
}

function mailSelectorToken(token) {
  if (token === "*") return true;
  return /^(?:[a-z][\w-]*)?(?:[.#][-_a-zA-Z0-9]+)+$/i.test(token) || /^[a-z][\w-]*$/i.test(token);
}

function mailSelectorOk(selector) {
  if (!selector || selector.length > 500) return false;
  if (/[{}<>]|url\s*\(|expression\s*\(|javascript\s*:|@|\\|:/i.test(selector)) return false;
  return selector.split(",").every((group) => {
    const tokens = group.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.length <= 8 && tokens.every(mailSelectorToken);
  });
}

function mailScopeSelector(selector) {
  return selector.split(",").map((group) => group.trim()
    .replace(/\.(-?[_a-zA-Z][\w-]*)/g, (_, name) => ".mmail-" + name.slice(0, 80))
    .replace(/#(-?[_a-zA-Z][\w-]*)/g, (_, name) => "#mmail-" + name.slice(0, 80))).join(", ");
}

function mailSplitDecls(css) {
  const out = [];
  let cur = "";
  let quote = "";
  let paren = 0;
  const text = String(css || "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") paren++;
    if (ch === ")") paren = Math.max(0, paren - 1);
    if (ch === ";" && paren === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const MAIL_CSS_FUNCTIONS = new Set(["url", "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "calc", "min", "max", "clamp", "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient"]);
function mailCssValue(prop, raw, imagesOn) {
  let value = String(raw || "").trim();
  if (!value || value.length > 100000) return "";
  if (/\/\*|[\u0000-\u001f\u007f]/.test(value)) return "";
  if (/[{}<>]|expression\s*\(|javascript\s*:|@import|-moz-binding|behavior\s*:|\\/i.test(value)) return "";
  for (const match of value.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)) {
    if (!MAIL_CSS_FUNCTIONS.has(match[1].toLowerCase())) return "";
  }
  const urls = [];
  const urlRe = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)'"\s]+))\s*\)/gi;
  value.replace(urlRe, (_all, _q, quoted, bare) => { urls.push(String(quoted || bare || "").trim()); return ""; });
  if (urls.length && !imagesOn) {
    value = value.replace(/url\(\s*(?:(['"])([\s\S]*?)\1|([^)'"\s]+))\s*\)/gi, " ").replace(/\s+/g, " ").trim();
    urls.length = 0;
    if (!value) return "";
  }
  for (const url of urls) {
    const remote = /^https?:\/\/[^\s"'<>]+$/i.test(url) && url.length <= 2000;
    const raster = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url.replace(/\s+/g, "")) && url.length <= 500000;
    if (!remote && !raster) return "";
  }
  const name = String(prop || "").toLowerCase();
  if (name === "position" && !/^(static|relative)$/i.test(value)) return "";
  if (name === "display" && !/^(block|inline|inline-block|inline-table|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|none|flex|inline-flex|list-item)$/i.test(value)) return "";
  if ((name === "overflow" || name === "overflow-x" || name === "overflow-y") && !/^(visible|hidden|auto|scroll)$/i.test(value)) return "";
  if (name === "white-space" && !/^(normal|nowrap|pre-line)$/i.test(value)) return "";
  return value;
}

function mailApplyCss(el, css, imagesOn, wantImportant) {
  if (!el || !el.style || typeof el.style.setProperty !== "function") return;
  for (const part of mailSplitDecls(css)) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    let raw = part.slice(idx + 1).trim();
    const important = /!important\s*$/i.test(raw);
    if (important !== !!wantImportant) continue;
    raw = raw.replace(/!important\s*$/i, "").trim();
    if (!MAIL_CSS_PROPS.has(prop)) continue;
    const value = mailCssValue(prop, raw, imagesOn);
    if (!value) continue;
    try { el.style.setProperty(prop, value, important ? "important" : ""); } catch { /* ignore a rejected declaration */ }
  }
}

function mailMediaMatches(selector) {
  const query = String(selector || "").replace(/^@media\s+/i, "").trim();
  if (!query || query.length > 240 || /[{};]|url\s*\(|expression|javascript:|@|\\/i.test(query)) return false;
  try { return typeof matchMedia === "function" && matchMedia(query).matches; } catch { return false; }
}

function mailStyleRules(css) {
  const text = String(css || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;?/gi, "").replace(/@charset[^;]*;?/gi, "").slice(0, 100000);
  const rules = [];
  function walk(body) {
    let i = 0;
    while (i < body.length && rules.length < 300) {
      while (i < body.length && /\s/.test(body[i])) i++;
      const open = body.indexOf("{", i);
      if (open < 0) break;
      const selector = body.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      let quote = "";
      for (; j < body.length && depth; j++) {
        const ch = body[j];
        if (quote) { if (ch === quote && body[j - 1] !== "\\") quote = ""; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      const inner = body.slice(open + 1, j - 1);
      if (/^@media\b/i.test(selector)) { if (mailMediaMatches(selector)) walk(inner); }
      else if (selector && !selector.startsWith("@") && mailSelectorOk(selector)) rules.push({ selector: mailScopeSelector(selector), body: inner });
      i = j;
    }
  }
  walk(text);
  return rules;
}

function mailSet(el, name, value) {
  if (value == null || value === "" || !el || typeof el.setAttribute !== "function") return;
  el.setAttribute(name, value);
}

function mailCopyLayout(el, tag, source, imagesOn) {
  const names = MAIL_LAYOUT[tag] || [];
  for (const name of names) {
    if (name === "nowrap") {
      if (source.getAttribute("nowrap") != null) el.setAttribute("nowrap", "");
      continue;
    }
    const raw = source.getAttribute(name);
    if (raw == null || String(raw).trim() === "") continue;
    if (name === "align" || name === "valign") {
      const token = String(raw).trim().toLowerCase();
      if (MAIL_ALIGN.has(token)) mailSet(el, name, token);
    } else if (name === "bgcolor" || name === "color") {
      const color = mailColor(raw);
      if (color) mailSet(el, name, color);
    } else if (name === "face") {
      if (/^[\w\s,"'-]{1,80}$/.test(String(raw).trim())) mailSet(el, "face", String(raw).trim());
    } else if (name === "size") {
      if (/^[1-7]$/.test(String(raw).trim())) mailSet(el, "size", String(raw).trim());
    } else if (name === "colspan" || name === "rowspan" || name === "span") {
      const n = mailInt(raw, 24);
      if (n) mailSet(el, name, n);
    } else if (name === "border" || name === "cellpadding" || name === "cellspacing") {
      const n = mailInt(raw, 40);
      if (n) mailSet(el, name, n);
    } else if (name === "width" || name === "height") {
      const measure = mailMeasure(raw);
      if (measure) mailSet(el, name, measure);
    }
  }
  const klass = mailScopeClass(source.getAttribute("class"));
  if (klass) mailSet(el, "class", klass);
  const id = mailScopeToken(source.getAttribute("id"));
  if (id) mailSet(el, "id", id);
  if (imagesOn && /^(table|thead|tbody|tfoot|tr|td|th)$/.test(tag)) {
    const bg = mailRemoteUrl(source.getAttribute("background"));
    if (bg) mailSet(el, "background", bg);
  }
}

// style-src 'self' refuses a style attribute while the parser builds the tree.
// Rename it first so the console stays quiet, then read the parked value below.
function parkMailStyleAttributes(html) {
  const src = String(html || "");
  const out = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { out.push(src.slice(i)); break; }
    if (lt > i) out.push(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      const stop = end < 0 ? len : end + 3;
      out.push(src.slice(lt, stop));
      i = stop;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt + 2);
      const stop = end < 0 ? len : end + 1;
      out.push(src.slice(lt, stop));
      i = stop;
      continue;
    }
    if (src.charCodeAt(lt + 1) === 47) {
      const end = src.indexOf(">", lt + 2);
      const stop = end < 0 ? len : end + 1;
      out.push(src.slice(lt, stop));
      i = stop;
      continue;
    }
    let j = lt + 1;
    const nameStart = j;
    while (j < len) {
      const c = src.charCodeAt(j);
      const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
      if (!ok) break;
      j += 1;
    }
    if (j === nameStart) { out.push("<"); i = lt + 1; continue; }
    const tag = src.slice(nameStart, j);
    out.push(src.slice(lt, j));
    let closed = false;
    while (j < len && !closed) {
      const c = src.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) { out.push(src[j]); j += 1; continue; }
      if (c === 62) { out.push(">"); j += 1; closed = true; break; }
      if (c === 47 && src.charCodeAt(j + 1) === 62) { out.push("/>"); j += 2; closed = true; break; }
      const attrStart = j;
      while (j < len) {
        const a = src.charCodeAt(j);
        if (a === 32 || a === 9 || a === 10 || a === 12 || a === 13 || a === 61 || a === 47 || a === 62) break;
        j += 1;
      }
      const name = src.slice(attrStart, j);
      if (!name) { out.push(src[j] || ""); j += 1; continue; }
      out.push(/^style$/i.test(name) ? "data-mail-style" : name);
      while (j < len) {
        const s = src.charCodeAt(j);
        if (s !== 32 && s !== 9 && s !== 10 && s !== 12 && s !== 13) break;
        out.push(src[j]);
        j += 1;
      }
      if (src.charCodeAt(j) !== 61) continue;
      out.push("=");
      j += 1;
      while (j < len) {
        const s = src.charCodeAt(j);
        if (s !== 32 && s !== 9 && s !== 10 && s !== 12 && s !== 13) break;
        out.push(src[j]);
        j += 1;
      }
      const q = src.charCodeAt(j);
      if (q === 34 || q === 39) {
        const end = src.indexOf(src[j], j + 1);
        const stop = end < 0 ? len : end + 1;
        out.push(src.slice(j, stop));
        j = stop;
      } else {
        const start = j;
        while (j < len) {
          const u = src.charCodeAt(j);
          if (u === 32 || u === 9 || u === 10 || u === 12 || u === 13 || u === 62) break;
          j += 1;
        }
        out.push(src.slice(start, j));
      }
    }
    i = j;
    if (/^(style|script|textarea|title)$/i.test(tag)) {
      const rest = src.slice(i);
      const close = new RegExp("</" + tag.replace(/[^\w:-]/g, "") + "\\s*>", "i");
      const found = close.exec(rest);
      if (!found) { out.push(rest); i = len; }
      else {
        const stop = found.index + found[0].length;
        out.push(rest.slice(0, stop));
        i += stop;
      }
    }
  }
  return out.join("");
}

function mailInlineStyle(source) {
  if (!source || typeof source.getAttribute !== "function") return "";
  const live = source.getAttribute("style");
  if (live) return live;
  return source.getAttribute("data-mail-style") || "";
}

function appendSafeMailHtml(parent, html, imagesOn) {
  const template = document.createElement("template");
  template.innerHTML = parkMailStyleAttributes(html);
  const allowed = new Set("p div span br hr b strong i em u s small sub sup blockquote pre code ul ol li table tbody thead tfoot tr td th col colgroup caption center font h1 h2 h3 h4 h5 h6 a".split(" "));
  const blocked = new Set("script iframe object embed svg math title template link meta base audio video source input textarea select noscript".split(" "));
  const styles = [];
  const inlines = [];
  function decorate(dest, tag, source) {
    mailCopyLayout(dest, tag, source, imagesOn);
    const inline = mailInlineStyle(source);
    if (inline) inlines.push({ el: dest, css: inline });
  }
  function placeImage(source, target) {
    const alt = String(source.getAttribute("alt") || "").slice(0, 300);
    const shown = mailImageSrc(source.getAttribute("src"), imagesOn);
    const remote = mailRemoteUrl(source.getAttribute("src"));
    const width = mailMeasure(source.getAttribute("width"));
    const height = mailMeasure(source.getAttribute("height"));
    if (shown) {
      const image = document.createElement("img");
      image.alt = alt;
      image.referrerPolicy = "no-referrer";
      image.src = shown;
      if (width) image.setAttribute("width", width);
      if (height) image.setAttribute("height", height);
      const align = String(source.getAttribute("align") || "").trim().toLowerCase();
      if (MAIL_ALIGN.has(align)) image.setAttribute("align", align);
      const klass = mailScopeClass(source.getAttribute("class"));
      if (klass) image.setAttribute("class", klass);
      const id = mailScopeToken(source.getAttribute("id"));
      if (id) image.setAttribute("id", id);
      const inline = mailInlineStyle(source);
      if (inline) inlines.push({ el: image, css: inline });
      if (typeof image.addEventListener === "function") {
        image.addEventListener("load", () => {
          if (image.naturalWidth > image.clientWidth + 1 && image.style && image.style.setProperty) image.style.setProperty("height", "auto");
        });
      }
      target.appendChild(image);
      return;
    }
    if (remote && (width || height)) {
      const hold = document.createElement("span");
      hold.className = "mail-image-hold";
      if (typeof hold.setAttribute === "function") {
        hold.setAttribute("class", "mail-image-hold");
        hold.setAttribute("role", "img");
        if (alt) hold.setAttribute("aria-label", alt);
      }
      const px = (measure) => /^\d+$/.test(measure) ? measure + "px" : measure;
      if (hold.style && hold.style.setProperty) {
        hold.style.setProperty("display", "inline-block");
        hold.style.setProperty("max-width", "100%");
        hold.style.setProperty("vertical-align", "middle");
        hold.style.setProperty("background", "#eef1f4");
        if (width) hold.style.setProperty("width", px(width));
        if (height) hold.style.setProperty("height", px(height));
      }
      target.appendChild(hold);
      return;
    }
    if (alt) target.appendChild(document.createTextNode(alt));
  }
  function copy(source, target) {
    if (!source) return;
    if (source.nodeType === 3) { target.appendChild(document.createTextNode(source.textContent)); return; }
    if (source.nodeType !== 1) return;
    const tag = String(source.localName || "").toLowerCase();
    if (!tag) return;
    if (tag === "style") { styles.push(source.textContent || ""); return; }
    if (tag === "head") {
      for (const child of source.childNodes) if (child.nodeType === 1) copy(child, target);
      return;
    }
    if (tag === "html" || tag === "body" || tag === "form") {
      if (tag === "body" && target.style && target.style.setProperty) {
        const bg = mailColor(source.getAttribute("bgcolor"));
        if (bg) target.style.setProperty("background-color", bg);
        const text = mailColor(source.getAttribute("text"));
        if (text) target.style.setProperty("color", text);
        if (imagesOn) {
          const bgUrl = mailRemoteUrl(source.getAttribute("background"));
          if (bgUrl) target.style.setProperty("background-image", 'url("' + bgUrl.replace(/"/g, "") + '")');
        }
      }
      for (const child of source.childNodes) copy(child, target);
      return;
    }
    if (blocked.has(tag)) return;
    if (tag === "img") { placeImage(source, target); return; }
    if (tag === "a") {
      const href = mailHref(source.getAttribute("href"));
      const dest = href ? document.createElement("a") : document.createElement("span");
      if (href) {
        dest.setAttribute("href", href);
        dest.setAttribute("target", "_blank");
        dest.setAttribute("rel", "noopener noreferrer");
        const title = String(source.getAttribute("title") || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
        if (title) dest.setAttribute("title", title);
      }
      decorate(dest, href ? "a" : "span", source);
      for (const child of source.childNodes) copy(child, dest);
      target.appendChild(dest);
      return;
    }
    const keep = allowed.has(tag);
    const dest = keep ? document.createElement(tag) : document.createElement("span");
    decorate(dest, keep ? tag : "span", source);
    for (const child of source.childNodes) copy(child, dest);
    target.appendChild(dest);
  }
  const fragment = template.content || template;
  for (const child of fragment.childNodes) copy(child, parent);
  const rules = styles.flatMap(mailStyleRules);
  const applySheet = (important) => {
    if (typeof parent.querySelectorAll !== "function") return;
    for (const rule of rules) {
      let nodes = [];
      try { nodes = parent.querySelectorAll(rule.selector); } catch { continue; }
      for (const node of nodes) mailApplyCss(node, rule.body, imagesOn, important);
    }
  };
  applySheet(false);
  for (const item of inlines) mailApplyCss(item.el, item.css, imagesOn, false);
  applySheet(true);
  for (const item of inlines) mailApplyCss(item.el, item.css, imagesOn, true);
}

// shortcut: one string is one address, upgrade if the host sends a comma-separated To.
function addressRows(value) {
  const parts = Array.isArray(value) ? value : (value ? [value] : []);
  const rows = [];
  for (const item of parts) {
    const structured = item && typeof item === "object" && item.address;
    const text = structured
      ? (item.name ? JSON.stringify(item.name) + " <" + item.address + ">" : item.address)
      : String(item || "").trim();
    if (!text) continue;
    const angled = structured ? null : text.match(/<([^<>]+)>/);
    const addr = String(structured ? item.address : angled ? angled[1] : text).trim().toLowerCase();
    if (!addr.includes("@")) continue;
    rows.push({ addr, text });
  }
  return rows;
}

// Prefer structured Reply-To, keeping self addresses and duplicate recipients out.
function replyParties(email, self, all) {
  const mine = new Set(addressRows(self).map((row) => row.addr));
  const seen = new Set();
  const take = (value) => {
    const out = [];
    for (const row of addressRows(value)) {
      if (!row || seen.has(row.addr) || mine.has(row.addr)) continue;
      seen.add(row.addr);
      out.push(row.text);
    }
    return out;
  };
  const replyTo = addressRows(email && email.replyTo);
  const authors = (replyTo.length ? replyTo : addressRows(email && email.from).slice(0, 1)).filter(row => {
    if (mine.has(row.addr) || seen.has(row.addr)) return false;
    seen.add(row.addr); return true;
  }).map(row => row.text);
  const toRows = take(email && email.to);
  const ccRows = take(email && email.cc);
  if (!all) {
    if (authors.length) return { to: authors.join(", "), cc: "" };
    return { to: toRows.concat(ccRows).join(", "), cc: "" };
  }
  if (authors.length) return { to: authors.join(", "), cc: toRows.concat(ccRows).join(", ") };
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
    return `Original attachment names: ${files.map((item) => item.filename || "attachment").join(", ")}. Files are not included in this forward.`;
  }
  if (email && email.hasAttachments) return "The original message has attachments. Files are not included in this forward.";
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
    replyTo: Array.isArray(message.replyTo) ? message.replyTo : [],
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

function joinComposeHtml(html, quoteHtml) {
  const body = String(html || "").trim();
  const quote = String(quoteHtml || "").trim();
  if (!quote) return body;
  if (!body) return quote;
  return body + "<br><br>" + quote;
}

function plainFromComposeHtml(html) {
  return String(html || "")
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n\n\n+/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function splitComposeSignature(body, signature) {
  const base = String(body || "");
  const prev = String(signature || "");
  if (!prev) return { message: base, signature: "" };
  if (base === prev) return { message: "", signature: prev };
  const tail = "\n\n" + prev;
  if (base.endsWith(tail)) return { message: base.slice(0, -tail.length), signature: prev };
  return { message: base, signature: "" };
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
      sourceMessageId: message.id || "",
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
    sourceMessageId: message.id || "",
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

function replyThreadEmail(fields) {
  if (!fields || typeof fields !== "object") return null;
  const kind = fields.kind || "";
  if (kind !== "reply" && kind !== "all") return null;
  const email = fields.quoteEmail && typeof fields.quoteEmail === "object"
    ? fields.quoteEmail
    : (fields.email && typeof fields.email === "object" ? fields.email : null);
  if (email) return email;
  const text = typeof fields.quote === "string" ? fields.quote.trim()
    : (typeof fields.text === "string" ? fields.text.trim() : "");
  if (!text) return null;
  return {
    subject: String(fields.subject || "").replace(/^(?:re|fwd|fw):\s*/i, "").trim(),
    from: "",
    textBody: text,
    snippet: text,
  };
}

function defaultAiMode(fields) {
  return replyThreadEmail(fields) ? "reply" : "rewrite";
}

function replyThreadPrompt(prompt) {
  const instruction = String(prompt || "").trim();
  if (instruction) return instruction;
  return "Write a comprehensive reply to the original email. Address the points it raises in a complete draft the sender can send.";
}

function draftBlockReason(mode, prompt, existing, email) {
  const instruction = String(prompt || "").trim();
  const body = String(existing || "").trim();
  const source = !!(email && typeof email === "object");
  if (mode === "reply") return source ? "" : "Reply from thread needs the original message.";
  if (mode === "custom" && !instruction && !source) return "Add a prompt.";
  if (mode !== "custom" && !body && !instruction && !source) return "Add some text, or a prompt.";
  return "";
}

function draftInstruction(mode, prompt, existing, subject, email) {
  const instruction = String(prompt || "").trim();
  const body = {
    mode: mode || "custom",
    user_prompt: mode === "reply" ? replyThreadPrompt(instruction) : instruction,
    existing_draft_content: String(existing || ""),
    subject: String(subject || ""),
  };
  if (mode === "reply") {
    if (email && typeof email === "object") body.email = suggestionEmail(email);
    return body;
  }
  if (email && typeof email === "object") {
    body.email = suggestionEmail(email);
    if (!instruction && !String(existing || "").trim()) body.user_prompt = "Write a reply.";
  }
  return body;
}

function replySuggestionSource(fields) {
  const email = fields && fields.quoteEmail;
  if (!email || typeof email !== "object") return null;
  if (fields.kind === "reply" || fields.kind === "all" || fields.aiWrite === true) return email;
  return null;
}

function suggestedReplyBody(current, signature, text) {
  const line = String(text || "").trim();
  if (!line) return String(current || "");
  const parts = splitComposeSignature(current, signature);
  if (parts.signature) return `${line}\n\n${parts.signature}`;
  return line;
}

// shortcut: continue appends model text; rewrite, custom, and reply from thread replace the body. Reply from thread keeps a trailing signature.
function draftBase(mode, existing) {
  return mode === "continue" ? String(existing || "") : "";
}

function shownDraft(view) {
  if (!view) return "";
  const body = !view.text
    ? (typeof view.previous === "string" ? view.previous : view.base)
    : view.base + view.text;
  const tail = view.text && typeof view.signatureTail === "string" ? view.signatureTail : "";
  if (!tail || body.endsWith(tail)) return body;
  return body.replace(/\s+$/g, "") + "\n\n" + tail;
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

let discoverGen = 0;
let discoverTimer = 0;
const customEndpointEdits = new Set();
let discoveryEmail = "";
let discoveredProfile = "";

function clearDiscoveredEndpoints() {
  for (const kind of ["imap", "smtp"]) {
    if (customEndpointEdits.has(kind)) continue;
    $(kind + "-host").value = "";
    $(kind + "-port").value = kind === "imap" ? "993" : "465";
    $(kind + "-tls").checked = true;
  }
}

function prepareDiscoveryAddress() {
  const email = $("email").value.trim();
  if (email.toLowerCase() !== discoveryEmail) {
    clearDiscoveredEndpoints();
    if (discoveredProfile && $("profile").value === discoveredProfile) $("profile").value = "custom";
    discoveredProfile = "";
    discoveryEmail = email.toLowerCase();
    syncCustomFields();
  }
  return email;
}

function cancelDiscovery() {
  discoverGen += 1;
  if (discoverTimer) clearTimeout(discoverTimer);
  discoverTimer = 0;
}

function yahooPasswordAccount(profile, email) {
  if (profile === "yahoo" || profile === "yahoo_jp") return true;
  const domain = String(email || "").trim().toLowerCase().split("@").pop() || "";
  return domain === "ymail.com" || domain === "rocketmail.com" || domain === "myyahoo.com" || domain.startsWith("yahoo.");
}

function syncPasswordHint() {
  const hint = $("password-hint");
  if (!hint) return;
  const on = yahooPasswordAccount($("profile") && $("profile").value, $("email") && $("email").value);
  hint.hidden = !on;
  hint.textContent = on
    ? "Yahoo needs an app password. In Yahoo Account Security, choose Generate app password, then paste it here. The regular account password is rejected."
    : "";
}

function syncCustomFields() {
  const custom = $("custom-fields");
  const profile = $("profile");
  if (custom && profile) custom.hidden = profile.value !== "custom";
  syncPasswordHint();
}

function manualCustomHosts() {
  return customEndpointEdits.has("imap") && customEndpointEdits.has("smtp") && $("profile").value === "custom" && $("imap-host").value.trim() && $("smtp-host").value.trim();
}

function applyDiscovery(found) {
  if (!found || typeof found !== "object" || manualCustomHosts()) return;
  const select = $("profile");
  if (!select || !select.options) return;
  const profile = String(found.profile || "");
  const hasCard = profile && [...select.options].some((option) => option.value === profile);
  if (hasCard && !customEndpointEdits.size && found.source !== "autoconfig" && found.source !== "srv") {
    select.value = profile;
    discoveredProfile = profile;
    syncCustomFields();
    return;
  }
  clearDiscoveredEndpoints();
  select.value = "custom";
  discoveredProfile = "";
  if (!customEndpointEdits.has("imap") && found.imap && found.imap.host && $("imap-host")) {
    $("imap-host").value = found.imap.host;
    $("imap-port").value = String(found.imap.port || "");
    $("imap-tls").checked = found.imap.tls !== false;
  }
  if (!customEndpointEdits.has("smtp") && found.smtp && found.smtp.host && $("smtp-host")) {
    $("smtp-host").value = found.smtp.host;
    $("smtp-port").value = String(found.smtp.port || "");
    $("smtp-tls").checked = found.smtp.tls !== false;
  }
  syncCustomFields();
}

function scheduleDiscover() {
  syncPasswordHint();
  const gen = ++discoverGen;
  const email = prepareDiscoveryAddress();
  if (discoverTimer) clearTimeout(discoverTimer);
  if (!email || !email.includes("@")) return;
  discoverTimer = setTimeout(() => {
    discoverTimer = 0;
    call("mail:discoverMail", { email }).then((found) => {
      if (gen !== discoverGen || !$("email") || $("email").value.trim() !== email) return;
      applyDiscovery(found);
    }).catch(() => {});
  }, 300);
}

function openImapDetails() {
  const details = $("connect-imap");
  if (details) details.open = true;
}

function chooseYahoo() {
  if (state.connectPending || state.oauthPending) return;
  openImapDetails();
  cancelDiscovery();
  customEndpointEdits.clear();
  clearDiscoveredEndpoints();
  discoveredProfile = "";
  const select = $("profile");
  if (select && select.options && [...select.options].some((option) => option.value === "yahoo")) select.value = "yahoo";
  syncCustomFields();
  setConnectStatus("Yahoo Mail uses your full email address and an app password.");
  const focus = $("email") && $("email").value.trim() ? $("password") : $("email");
  if (focus && typeof focus.focus === "function") focus.focus();
}

function connectButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary empty-connect";
  button.addEventListener("click", () => openConnectFor(null));
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

function syncRemove() {
  const button = $("remove");
  const live = isLive(settingsAccount());
  button.hidden = false;
  button.disabled = !live;
  button.title = live ? "Remove this account. Mail stays on the server." : "Connect a mailbox before removing one.";
}

function folderRootDrop(kind, accountId) {
  const row = document.createElement("div");
  row.className = "folder-root";
  row.dataset.nestKind = kind;
  row.dataset.nestRoot = "1";
  row.dataset.nestAccount = accountId || "";
  row.dataset.nestId = "";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Top level. Drop a folder here to unnest.");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Top level";
  row.appendChild(name);
  return row;
}

function applyNestDrag(node, kind, folder, accountId, baseTitle, baseLabel) {
  const nest = folderCanNest(kind, folder);
  node.dataset.nestKind = kind;
  node.dataset.nestId = String((folder && folder.id) || "");
  node.dataset.nestAccount = accountId || "";
  node.dataset.nestRoot = "0";
  node.dataset.nestDrag = nest.ok ? "1" : "0";
  node.draggable = !!nest.ok;
  const title = baseTitle || "Folder";
  const label = baseLabel || title;
  if (nest.ok) {
    node.title = title + " Drag onto a folder to nest, or onto Top level to unnest.";
    node.setAttribute("aria-label", label + " Drag onto a folder to nest, or onto Top level to unnest.");
  } else {
    node.title = nest.reason ? title + " " + nest.reason : title;
    node.setAttribute("aria-label", label + (nest.reason ? " " + nest.reason : ""));
  }
  return nest;
}

function applyAllAccountMailChrome(root) {
  if (!root || typeof root.querySelector !== "function") return;
  const current = !!state.allInbox;
  const inbox = root.querySelector("button.all-inbox");
  if (inbox) {
    if (current) inbox.setAttribute("aria-current", "true");
    else inbox.removeAttribute("aria-current");
  }
  const chip = root.querySelector("button.all-account-unread");
  if (!chip) return;
  const model = allAccountUnreadChip(allInboxUnread(state.accounts), current && !!state.allInboxUnreadOnly);
  chip.textContent = model.text;
  chip.title = model.label;
  chip.setAttribute("aria-label", model.label);
  chip.setAttribute("aria-pressed", model.pressed ? "true" : "false");
}

function allAccountMailRow(open, hasChild, filtering) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "account all-account-mail";
  button.setAttribute("data-testid", "all-account-mail");
  const expanded = !!(hasChild && open);
  if (hasChild) {
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = expanded ? "▾ " : "▸ ";
    button.appendChild(mark);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = allAccountMailLabel();
  button.appendChild(name);
  const key = allAccountSectionKey();
  markFolderNav(button, {
    key: "all",
    kind: "all",
    accountId: key ? key.accountId : "",
    id: key ? key.folderId : "",
    hasChild: !!hasChild,
    expanded: expanded,
    lock: !!filtering,
  });
  button.title = hasChild ? ((expanded ? "Collapse " : "Expand ") + allAccountMailLabel()) : allAccountMailLabel();
  button.addEventListener("click", () => {
    folderNavKey = "all";
    folderNavRestore = true;
    toggleAllAccountSection().catch((error) => showStatus(error.message, true));
  });
  return button;
}

function allAccountInboxRow() {
  const line = document.createElement("div");
  line.className = "folder-line all-account-inbox";
  const indent = document.createElement("span");
  indent.className = "folder-indent";
  indent.style.width = "14px";
  indent.setAttribute("aria-hidden", "true");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "folder all-inbox";
  button.setAttribute("data-testid", "all-account-inbox");
  const label = document.createElement("span");
  label.className = "folder-label";
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = folderIcon("inbox");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Inbox";
  label.append(icon, name);
  button.appendChild(label);
  markFolderNav(button, { key: "inbox", kind: "inbox", parent: "all" });
  button.addEventListener("click", () => {
    folderNavKey = "inbox";
    const next = allAccountMailChoice({ allInbox: state.allInbox, unreadOnly: state.allInboxUnreadOnly }, "mail");
    selectAllInbox(next.unreadOnly).catch((error) => showStatus(error.message, true));
  });
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "count all-account-unread";
  chip.setAttribute("data-testid", "all-account-unread");
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    folderNavKey = "inbox";
    const next = allAccountMailChoice({ allInbox: state.allInbox, unreadOnly: state.allInboxUnreadOnly }, "unread");
    selectAllInbox(next.unreadOnly).catch((error) => showStatus(error.message, true));
  });
  line.append(indent, button, chip);
  applyAllAccountMailChrome(line);
  return line;
}

function applyOutboxChrome(root) {
  if (!root) return;
  const count = Array.isArray(state.outboxRows) ? state.outboxRows.length : 0;
  const button = root.querySelector("button.outbox");
  if (button) {
    if (state.outbox) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
    button.setAttribute("aria-label", count ? "Outbox, " + count + " waiting to send" : "Outbox");
  }
  const badge = root.querySelector(".outbox-count");
  if (badge) {
    badge.textContent = count ? String(count) : "";
    badge.hidden = !count;
  }
}

function outboxMailRow() {
  const line = document.createElement("div");
  line.className = "folder-line outbox-mail";
  const indent = document.createElement("span");
  indent.className = "folder-indent";
  indent.style.width = "14px";
  indent.setAttribute("aria-hidden", "true");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "folder outbox";
  button.setAttribute("data-testid", "outbox");
  const label = document.createElement("span");
  label.className = "folder-label";
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "📬";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Outbox";
  label.append(icon, name);
  const count = document.createElement("span");
  count.className = "count outbox-count";
  button.append(label, count);
  markFolderNav(button, { key: "outbox", kind: "outbox", parent: "all" });
  button.addEventListener("click", () => {
    folderNavKey = "outbox";
    selectOutbox().catch((error) => showStatus(error.message, true));
  });
  line.append(indent, button);
  applyOutboxChrome(line);
  return line;
}

function folderFilterQuery() {
  const input = $("folder-filter");
  return input ? String(input.value || "") : "";
}

function filterSidebarTree(rows, query) {
  const list = Array.isArray(rows) ? rows.filter((folder) => folder && folder.id != null && folder.id !== "") : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list.map((folder) => Object.assign({}, folder, { filterMatch: false }));
  const byId = new Map(list.map((folder) => [String(folder.id), folder]));
  const keep = new Set();
  const match = new Set();
  for (const folder of list) {
    if (!chipLabel(folder).toLowerCase().includes(q)) continue;
    const id = String(folder.id);
    match.add(id);
    keep.add(id);
    let parent = folder.parentId ? String(folder.parentId) : "";
    const seen = new Set();
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      keep.add(parent);
      const next = byId.get(parent);
      parent = next && next.parentId ? String(next.parentId) : "";
    }
  }
  return list.filter((folder) => keep.has(String(folder.id))).map((folder) => Object.assign({}, folder, {
    filterMatch: match.has(String(folder.id)),
  }));
}

function sidebarRowsFor(tree, accountId, collapsed, query, collapse) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(tree) ? tree : [];
  if (q) {
    const filtered = filterSidebarTree(list, q);
    const parents = new Set();
    for (const folder of filtered) {
      if (folder && folder.parentId) parents.add(String(folder.parentId));
    }
    return filtered.map((folder) => {
      const hasChild = parents.has(String(folder.id));
      return Object.assign({}, folder, {
        hasChild: hasChild,
        expanded: hasChild,
        filtering: true,
      });
    });
  }
  if (!collapse || typeof collapse.visibleRows !== "function") {
    return list.map((folder) => Object.assign({}, folder, { hasChild: false, expanded: true }));
  }
  return collapse.visibleRows(list, collapsed, accountId);
}

function sidebarFolderRows(tree, accountId) {
  return sidebarRowsFor(tree, accountId, state.prefs.collapsedFolders, folderFilterQuery(), folderCollapse());
}

function mirrorFolderTarget(line, button) {
  const keys = ["dropKind", "dropId", "dropAccount", "dropCopy", "nestKind", "nestId", "nestAccount", "nestRoot"];
  for (const key of keys) {
    if (button.dataset[key]) line.dataset[key] = button.dataset[key];
  }
}

function folderTwistMark(open) {
  const mark = document.createElement("span");
  mark.className = "folder-twist-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(strokeIcon([open ? MOVE_CHEVRON_DOWN : MOVE_CHEVRON_RIGHT], 12));
  return mark;
}

function folderTwist(folder, accountId, labelText) {
  const open = folder.expanded !== false;
  const label = labelText || "folder";
  const twist = document.createElement("button");
  twist.type = "button";
  twist.className = "folder-twist";
  twist.setAttribute("aria-expanded", open ? "true" : "false");
  twist.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + label);
  twist.title = twist.getAttribute("aria-label");
  twist.tabIndex = -1;
  twist.appendChild(strokeIcon([open ? MOVE_CHEVRON_DOWN : MOVE_CHEVRON_RIGHT], 12));
  twist.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  twist.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    folderNavKey = "folder:" + accountId + ":" + folder.id;
    folderNavRestore = true;
    toggleSidebarFolder(accountId, folder.id).catch((error) => showStatus(error.message, true));
  });
  return twist;
}

function markFolderNav(node, spec) {
  const item = spec || {};
  node.dataset.navKey = item.key || "";
  node.dataset.navParent = item.parent || "";
  node.dataset.navKind = item.kind || "";
  node.dataset.navAccount = item.accountId || "";
  node.dataset.navId = item.id || "";
  node.dataset.navChild = item.hasChild ? "1" : "0";
  node.dataset.navOpen = item.expanded ? "1" : "0";
  if (item.lock) node.dataset.navLock = "1";
  else delete node.dataset.navLock;
  if (item.hasChild) node.setAttribute("aria-expanded", item.expanded ? "true" : "false");
  node.tabIndex = -1;
}

function folderNavModel(node) {
  return {
    id: node.dataset.navKey || "",
    parentId: node.dataset.navParent || "",
    hasChild: node.dataset.navChild === "1",
    expanded: node.dataset.navOpen === "1",
    collapsible: node.dataset.navLock !== "1",
  };
}

function folderNavNode(target, nav) {
  if (!target || !target.closest || !nav || !nav.contains(target)) return null;
  if (shellBlocked(target)) return null;
  const direct = target.closest("[data-nav-key]");
  if (direct && nav.contains(direct)) return direct;
  const line = target.closest(".folder-line");
  if (!line || !nav.contains(line)) return null;
  return line.querySelector("[data-nav-key]");
}

function applyFolderNavFocus(nav) {
  if (!nav) return;
  const nodes = Array.from(nav.querySelectorAll("[data-nav-key]"));
  if (!nodes.length) return;
  let current = folderNavKey ? nodes.find((node) => node.dataset.navKey === folderNavKey) : null;
  const found = !!current;
  if (!current) current = nodes[0];
  for (const node of nodes) node.tabIndex = node === current ? 0 : -1;
  if (folderNavRestore && found) {
    current.focus();
    if (current.scrollIntoView) current.scrollIntoView({ block: "nearest" });
  }
}

function onFolderNavKey(event) {
  if (!event || event.altKey || event.ctrlKey || event.metaKey) return;
  const key = event.key;
  if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") return;
  const nav = $("folders");
  const node = folderNavNode(event.target, nav);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  const tree = folderCollapse();
  if (!tree || typeof tree.folderTreeKey !== "function") return;
  const nodes = Array.from(nav.querySelectorAll("[data-nav-key]"));
  const action = tree.folderTreeKey(nodes.map(folderNavModel), nodes.indexOf(node), key);
  if (!action || action.type === "none" || action.type === "parent" || action.type === "child") return;
  if (action.type === "move") {
    const next = nodes[action.index];
    if (!next) return;
    folderNavKey = next.dataset.navKey || "";
    for (const item of nodes) item.tabIndex = item === next ? 0 : -1;
    next.focus();
    if (next.scrollIntoView) next.scrollIntoView({ block: "nearest" });
    return;
  }
  folderNavKey = node.dataset.navKey || "";
  folderNavRestore = true;
  if (node.dataset.navKind === "all") {
    toggleAllAccountSection().catch((error) => showStatus(error.message, true));
    return;
  }
  if (node.dataset.navKind === "account") {
    const provider = node.dataset.navId || "";
    if (provider === "gmail" || provider === "outlook") {
      toggleProviderFolders(provider).catch((error) => showStatus(error.message, true));
    } else folderNavRestore = false;
    return;
  }
  if (node.dataset.navKind === "folder") {
    toggleSidebarFolder(node.dataset.navAccount || "", node.dataset.navId || "").catch((error) => showStatus(error.message, true));
    return;
  }
  folderNavRestore = false;
}

function renderAccounts() {
  renderSettingsAccounts();
  refreshMailVacation();
  const nav = $("folders");
  const folderQuery = String(folderFilterQuery() || "").trim().toLowerCase();
  // Sync status and folder selection do not change the folder tree.
  const key = JSON.stringify([
    state.accounts,
    state.accountId,
    state.prefs.gmailOpen,
    state.prefs.outlookOpen,
    state.prefs.collapsedFolders || {},
    folderQuery,
  ]);
  if (key === folderRenderKey) {
    for (const button of nav.querySelectorAll("button.folder")) {
      const current = !state.allInbox && !state.outbox && button.dataset.accountId === state.accountId && button.dataset.folderId === state.folderId;
      if (current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    applyAllAccountMailChrome(nav);
    applyOutboxChrome(nav.querySelector(".outbox-mail"));
    return;
  }
  folderRenderKey = key;
  nav.replaceChildren();
  if (!state.accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No accounts.";
    nav.append(empty, connectButton());
    applyFolderNavFocus(nav);
    return;
  }
  const filtering = !!folderQuery;
  const inboxMatch = inboxMatches(folderQuery);
  const outboxMatch = outboxMatches(folderQuery);
  const sectionHasChild = filtering ? (inboxMatch || outboxMatch) : true;
  const sectionOpen = filtering ? sectionHasChild : allAccountSectionOpen();
  const showSection = allAccountMailMatches(folderQuery) || (filtering && sectionHasChild);
  let shownFolder = false;
  if (showSection) {
    shownFolder = true;
    nav.appendChild(allAccountMailRow(sectionOpen, sectionHasChild, filtering));
    if (sectionOpen && inboxMatch) nav.appendChild(allAccountInboxRow());
    if (sectionOpen && outboxMatch) nav.appendChild(outboxMailRow());
  }
  for (const account of state.accounts) {
    const provider = folderProvider(account);
    const filtering = !!folderQuery;
    const expanded = filtering || providerExpanded(provider, state.prefs);
    const tree = folderTree(foldersOf(account), accountDelimiter(account));
    const rows = expanded ? sidebarFolderRows(tree, account.id) : [];
    if (filtering && !rows.length) continue;
    shownFolder = true;
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
      heading.title = accountLabel(account);
      heading.addEventListener("click", () => {
        folderNavKey = "account:" + account.id;
        folderNavRestore = true;
        toggleProviderFolders(provider).catch((error) => showStatus(error.message, true));
      });
    } else {
      heading = document.createElement("h2");
      heading.textContent = accountLabel(account);
      heading.title = accountLabel(account);
    }
    markFolderNav(heading, {
      key: "account:" + account.id,
      kind: "account",
      accountId: account.id,
      id: provider || "",
      hasChild: tree.length > 0,
      expanded: !!(expanded && tree.length),
      lock: !provider || filtering,
    });
    heading.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAccountLabelMenu(account, event.clientX, event.clientY);
    });
    nav.appendChild(heading);
    if (account.needsReauth && account.reauthReason) {
      const note = document.createElement("p");
      note.className = "reauth";
      note.textContent = account.reauthReason;
      const reconnect = document.createElement("button");
      reconnect.type = "button"; reconnect.className = "ghost";
      reconnect.textContent = "Reconnect " + account.email;
      reconnect.title = reconnect.textContent;
      reconnect.onclick = () => openConnectFor(account);
      nav.append(note, reconnect);
    }
    if (expanded) {
    nav.appendChild(folderRootDrop("imap", account.id));
    for (const folder of rows) {
      const line = document.createElement("div");
      line.className = "folder-line";
      const indent = document.createElement("span");
      indent.className = "folder-indent";
      indent.style.width = ((folder.depth || 0) * 14) + "px";
      indent.setAttribute("aria-hidden", "true");
      line.appendChild(indent);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder";
      button.dataset.accountId = account.id;
      button.dataset.folderId = folder.id;
      const virtual = isVirtualMailbox(folder);
      if (virtual) {
        button.dataset.dropKind = "virtual";
        button.dataset.dropId = folder.id;
        button.dataset.dropAccount = account.id;
        button.dataset.dropCopy = folder.dropCopy || "";
      } else {
        button.dataset.dropKind = "imap";
        button.dataset.dropId = folder.id;
        button.dataset.dropAccount = account.id;
      }
      if (!state.allInbox && !state.outbox && account.id === state.accountId && folder.id === state.folderId) {
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
      if (folder.filterMatch) button.classList.add("is-filter-match");
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
      const baseTitle = serverName && serverName !== labelText ? serverName : labelText;
      name.title = baseTitle;
      const baseLabel = `${labelText || "Folder"}${unread}. Right-click to move.`;
      if (virtual) {
        button.title = folder.title || labelText;
        button.setAttribute("aria-label", (folder.ariaLabel || labelText) + unread);
      } else {
        applyNestDrag(button, "imap", folder, account.id, baseTitle, baseLabel);
      }
      markFolderNav(button, {
        key: "folder:" + account.id + ":" + folder.id,
        parent: folder.parentId ? "folder:" + account.id + ":" + folder.parentId : "account:" + account.id,
        kind: "folder",
        accountId: account.id,
        id: String(folder.id),
        hasChild: !!folder.hasChild,
        expanded: !!(folder.hasChild && folder.expanded !== false),
        lock: !!folder.filtering,
      });
      button.addEventListener("click", () => {
        folderNavKey = button.dataset.navKey || "";
        selectFolder(account.id, folder.id).catch((error) => showStatus(error.message, true));
      });
      if (folder.hasChild) {
        line.appendChild(folder.filtering ? folderTwistMark(folder.expanded !== false) : folderTwist(folder, account.id, labelText));
      }
      else {
        const spacer = document.createElement("span");
        spacer.className = "folder-twist-spacer";
        spacer.setAttribute("aria-hidden", "true");
        line.appendChild(spacer);
      }
      mirrorFolderTarget(line, button);
      line.appendChild(button);
      if (!virtual) line.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openImapFolderMenu(folder, account, event.clientX, event.clientY);
      });
      nav.appendChild(line);
    }
    }
  }
  if (!shownFolder) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching folders.";
    nav.appendChild(empty);
  }
  applyFolderNavFocus(nav);
}

function fillAccountOptions(select, rows, selected, emptyLabel = "No mailbox") {
  const key = JSON.stringify(rows.map(account => [account.id, account.email]));
  if (select.dataset.optionsKey !== key) {
    select.dataset.optionsKey = key;
    select.replaceChildren(...(rows.length ? rows.map(account => option(account.id, account.email || account.id)) : [option("", emptyLabel)]));
  }
  select.disabled = !rows.length;
  select.value = selected || "";
}

let providerPageKey = "";
let providerPageAccountId = "";

function providerFilterQuery() {
  const input = $("provider-filter");
  return input ? String(input.value || "") : "";
}

function providerColumnHasChild(tree, pathPrefix, id, query) {
  const probe = providerColumns(tree, pathPrefix.concat([String(id)]), query);
  return probe.columns.length > pathPrefix.length + 1;
}

function renderProviderColumns(block) {
  const host = block && block.querySelector(".provider-columns");
  if (!host) return;
  const account = selectedAccount();
  const provider = folderProvider(account);
  const payload = providerPayloadFor(account);
  const tree = providerLabelTree((payload && payload.folders) || []);
  const query = providerFilterQuery();
  const view = providerColumns(tree, state.providerColumnPath, query);
  state.providerColumnPath = view.path.slice();
  const restore = host.dataset.restoreFocus === "1";
  delete host.dataset.restoreFocus;
  host.replaceChildren();
  const focusId = view.path.length ? view.path[view.path.length - 1] : "";
  view.columns.forEach((column, index) => {
    const col = document.createElement("div");
    col.className = "provider-column";
    col.dataset.column = String(index);
    col.setAttribute("role", "listbox");
    col.setAttribute("aria-label", index ? "Contents" : (provider === "outlook" ? "Folders" : "Labels"));
    const selectedId = view.path[index] || "";
    if (!column.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = query.trim() ? "No matching labels." : "Nothing in this column.";
      col.appendChild(empty);
    }
    column.forEach((folder) => {
      const row = document.createElement("div");
      row.className = "provider-row";
      row.dataset.dropKind = provider === "outlook" ? "outlook" : "gmail";
      row.dataset.dropId = folder.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-haspopup", "menu");
      const selected = String(folder.id) === selectedId;
      const hasChild = providerColumnHasChild(tree, view.path.slice(0, index), folder.id, query);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      row.setAttribute("aria-expanded", hasChild ? (selected ? "true" : "false") : "false");
      row.tabIndex = selected || (!selectedId && index === 0 && column[0] === folder) ? 0 : -1;
      const shown = folder.label || folder.name;
      applyNestDrag(row, provider, folder, account.id, folder.name || shown, shown + ".");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = shown;
      row.append(providerMark(provider), name);
      if (hasChild) {
        const chevron = strokeIcon([MOVE_CHEVRON_RIGHT], 14);
        chevron.classList.add("provider-chevron");
        row.appendChild(chevron);
      }
      row.addEventListener("click", () => {
        host.dataset.restoreFocus = "1";
        const next = state.providerColumnPath.slice(0, index);
        next.push(String(folder.id));
        state.providerColumnPath = next;
        renderProviderColumns(block);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openFolderMenu(folder, provider, event.clientX, event.clientY);
      });
      col.appendChild(row);
    });
    host.appendChild(col);
  });
  paintProviderActions(block, account, provider, tree, state.providerColumnPath);
  if (host.dataset.motion !== "1") {
    host.dataset.motion = "1";
    const motion = motionApi();
    if (motion) motion.rows(host.querySelectorAll(".provider-row"));
  }
  if (restore) {
    const wantId = host.dataset.restoreFocusId || focusId;
    const wantCol = host.dataset.restoreColumn || "";
    delete host.dataset.restoreFocusId;
    delete host.dataset.restoreColumn;
    const rows = Array.from(host.querySelectorAll(".provider-row"));
    let row = rows.find((node) => node.dataset.dropId === wantId && (!wantCol || node.parentElement.dataset.column === wantCol));
    if (!row && focusId) {
      row = rows.find((node) => node.dataset.dropId === focusId && node.getAttribute("aria-selected") === "true");
    }
    if (row) focusProviderRow(row);
  }
}

function focusProviderRow(node) {
  if (!node) return;
  const column = node.parentElement;
  if (column) {
    for (const row of column.querySelectorAll(".provider-row")) row.tabIndex = row === node ? 0 : -1;
  }
  node.focus();
  if (node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
}

function restoreProviderFocus(row, index) {
  const host = row && row.closest ? row.closest(".provider-columns") : null;
  if (host) {
    host.dataset.restoreFocus = "1";
    host.dataset.restoreFocusId = (row.dataset && row.dataset.dropId) || "";
    host.dataset.restoreColumn = String(index);
  }
  const block = $("provider-folders");
  if (block) renderProviderColumns(block);
}

function openProviderColumn(index, id) {
  const path = state.providerColumnPath.slice(0, index);
  if (id) path.push(id);
  state.providerColumnPath = path;
}

function imapFolderForProvider(account, folder) {
  if (!account || !folder) return null;
  const id = String(folder.id || "");
  const name = String(folder.name || "");
  const label = String(folder.label || "");
  return foldersOf(account).find((item) => {
    if (!item) return false;
    const itemId = String(item.id || "");
    const itemName = String(item.name || "");
    return itemId === id || (name && itemName === name) || (label && itemName === label);
  }) || null;
}

function paintProviderActions(block, account, provider, tree, path) {
  const actions = block.querySelector("#provider-actions");
  if (!actions) return;
  actions.replaceChildren();
  const id = path.length ? path[path.length - 1] : "";
  if (!id) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Drag a message onto a row.";
    actions.appendChild(hint);
    return;
  }
  const folder = tree.find((item) => item && String(item.id) === id) || null;
  const label = document.createElement("p");
  label.className = "provider-selection";
  label.textContent = (folder && (folder.label || folder.name)) || id;
  actions.appendChild(label);
  const row = document.createElement("div");
  row.className = "row";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "ghost";
  open.textContent = "Open in Mail";
  const imap = imapFolderForProvider(account, folder);
  open.disabled = !imap;
  open.title = imap ? "Open this folder in Mail" : "No matching mailbox folder";
  open.addEventListener("click", () => {
    if (!imap) return;
    selectFolder(account.id, imap.id).then(() => showMail()).catch((error) => showStatus(error.message, true));
  });
  row.appendChild(open);
  if (provider === "gmail") {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ghost";
    add.textContent = "Add label to open message";
    const email = state.email;
    const ready = !!(email && account && email.accountId === account.id);
    add.disabled = !ready;
    add.title = ready ? "Add this label to the open message" : "Open a message in this mailbox first";
    add.addEventListener("click", () => {
      if (!state.email || state.email.accountId !== account.id) return;
      guard(() => changeLabels(state.email, [id], []));
    });
    row.appendChild(add);
  } else if (provider === "outlook") {
    const move = document.createElement("button");
    move.type = "button";
    move.className = "ghost";
    move.textContent = "Move open message here";
    const email = state.email;
    const ready = !!(email && account && email.accountId === account.id);
    move.disabled = !ready;
    move.title = ready ? "Move the open message into this folder" : "Open a message in this mailbox first";
    move.addEventListener("click", () => {
      if (!state.email || state.email.accountId !== account.id) return;
      guard(() => moveOutlook(state.email, id));
    });
    row.appendChild(move);
  }
  actions.appendChild(row);
}

function onProviderColumnKey(event) {
  if (!event || shellBlocked(event.target)) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const row = event.target && event.target.closest ? event.target.closest(".provider-row") : null;
  const root = $("provider-content");
  if (!row || !root || !root.contains(row)) return;
  const key = event.key;
  if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Enter") return;
  const column = row.parentElement;
  const index = Number(column && column.dataset.column);
  if (!Number.isFinite(index)) return;
  event.preventDefault();
  event.stopPropagation();
  if (key === "Enter") {
    openProviderColumn(index, row.dataset.dropId);
    restoreProviderFocus(row, index);
    return;
  }
  const tree = folderCollapse();
  if (!tree || typeof tree.folderTreeKey !== "function") return;
  const nodes = Array.from(column.querySelectorAll(".provider-row"));
  const rows = nodes.map((node) => ({
    id: node.dataset.dropId || "",
    parentId: "",
    hasChild: !!node.querySelector(".provider-chevron"),
    expanded: node.getAttribute("aria-expanded") === "true",
    collapsible: true,
  }));
  const action = tree.folderTreeKey(rows, nodes.indexOf(row), key);
  if (!action || action.type === "none") return;
  if (action.type === "move") {
    focusProviderRow(nodes[action.index]);
    return;
  }
  if (action.type === "collapse") {
    openProviderColumn(index, "");
    restoreProviderFocus(row, index);
    return;
  }
  if (action.type === "expand") {
    openProviderColumn(index, row.dataset.dropId);
    restoreProviderFocus(row, index);
    return;
  }
  const host = row.closest(".provider-columns");
  if (action.type === "child") {
    const next = host && host.querySelector('.provider-column[data-column="' + (index + 1) + '"] .provider-row');
    if (next) focusProviderRow(next);
    return;
  }
  if (action.type !== "parent" || !index || !host) return;
  const prev = host.querySelector('.provider-column[data-column="' + (index - 1) + '"]');
  const parent = prev && (prev.querySelector('.provider-row[aria-selected="true"]') || prev.querySelector(".provider-row"));
  if (parent) focusProviderRow(parent);
}

function paintProviderPage() {
  const account = selectedAccount();
  fillAccountOptions($("provider-account"), state.accounts, account?.id);
  const accountId = account ? account.id : "";
  if (accountId !== providerPageAccountId) {
    providerPageAccountId = accountId;
    state.providerColumnPath = [];
  }
  const key = JSON.stringify([account?.id, account && folderProvider(account), state.providerFolders]);
  if (key === providerPageKey) return;
  providerPageKey = key;
  const root = $("provider-content");
  root.replaceChildren();
  if (account && isLive(account) && ["gmail", "outlook"].includes(folderProvider(account))) {
    appendProviderBlock(root, account);
  } else {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = account ? "This mailbox uses IMAP folders. Open Mail to browse and organize them." : "Connect a Google or Microsoft mailbox to manage labels and folders.";
    root.append(note);
    if (!account) root.append(connectButton());
  }
}

function showProviderPage() {
  showPrimary("folders", "provider-panel");
  paintProviderPage();
  loadProviderFolders(accountGen);
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
  block.appendChild(folderRootDrop(provider, account.id));
  const columns = document.createElement("div");
  columns.className = "provider-columns";
  block.appendChild(columns);
  const actions = document.createElement("div");
  actions.id = "provider-actions";
  actions.className = "provider-actions";
  block.appendChild(actions);
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
  renderProviderColumns(block);
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
  const folders = state.prefs.chips && account ? chipFolders(account) : [];
  const key = JSON.stringify([account?.id, state.folderId, folders]);
  if (key === chipRenderKey) return;
  chipRenderKey = key;
  row.replaceChildren();
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
  // A plain click opens the message. It does not leave a one-row selection,
  // so the checkbox column and selection bar stay hidden.
  return clearListSelection();
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
  const base = { confirm: action === "archive" ? "Archive" : action === "trash" ? "Move to Trash" : action === "move" ? "Move" : "Apply label", cancel: "Cancel", needsName: false, name: "" };
  const scope = row.scope ? " " + row.scope : "";
  if (action === "archive") {
    return Object.assign({}, base, {
      title: "Archive",
      body: "Archive " + n + " " + noun + "?" + scope,
    });
  }
  if (action === "trash") {
    return Object.assign({}, base, {
      title: "Trash",
      body: "Move " + n + " " + noun + " to Trash?" + scope,
    });
  }
  if (action === "move") {
    const target = String(row.target || "that folder");
    return Object.assign({}, base, {
      title: "Move",
      body: "Move " + n + " " + noun + " to “" + target + "”? This moves them on the provider." + scope,
    });
  }
  if (action === "add-label") return Object.assign({}, base, { title: "Add Gmail label", body: "Add “" + String(row.label || "that label") + "” to " + n + " " + noun + "? Existing labels remain." + scope });
  if (action === "remove-label") {
    const label = String(row.label || "that label");
    return Object.assign({}, base, {
      title: "Remove label",
      body: "Remove “" + label + "” from " + n + " " + noun + "?" + scope,
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
  return account && account.needsReauth ? "Sign-in needed" : account && account.push === "push" ? "Push connected" : "Checking periodically";
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
  if (!$("settings").open) return;
  paintSettingsMailbox();
  if (!document.querySelector('#settings .fold[data-fold="mailbox"].is-open')) return;
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
}

function syncStatusLabel(sync) {
  if (!sync || !sync.state) return "";
  if (sync.state === "error" && sync.retrying) return "Retrying…";
  if (sync.message) return redactDebugText(sync.message);
  if (sync.state === "syncing") return "Syncing…";
  if (sync.state === "paused") return "Paused for rate limit";
  if (sync.state === "done") return sync.lastSuccessAt ? "Folder checked" : "Not synced yet";
  if (sync.state === "error") return "Sync failed";
  return "";
}

function redactDebugText(text) {
  return String(text || "")
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|authorization)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, "$1[redacted]")
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|authorization)\b\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function phaseWord(phase) {
  if (phase === "listing") return "Listing folders";
  if (phase === "fetching") return "Fetching mail";
  if (phase === "refreshing") return "Refreshing";
  if (phase === "rules") return "Running rules";
  if (phase === "calendar") return "Refreshing calendar";
  if (phase === "agent") return "Refreshing agent";
  if (phase === "brain") return "Refreshing Email Brain";
  return "";
}

function syncClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    const date = new Date(n);
    if (typeof displayStamp === "function") return displayStamp(date, "time");
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function syncDetail(sync) {
  if (!sync || !sync.state) return "";
  const where = [sync.accountLabel, sync.folderLabel].filter(Boolean).join(" · ");
  const phase = phaseWord(sync.phase);
  const success = sync.lastSuccessAt && sync.accountId && sync.folderId
    ? (typeof displayStamp === "function"
      ? displayStamp(new Date(sync.lastSuccessAt), "dateTime")
      : new Date(sync.lastSuccessAt).toLocaleString())
    : "";
  const successLine = success ? `${where} · Last checked ${success}` : "";
  if (sync.state === "syncing") return [where, phase || "Downloading recent mail", successLine].filter(Boolean).join(" · ");
  if (sync.state === "error") return [where, redactDebugText(sync.lastError || sync.message || "Sync failed"), sync.retrying ? "Retrying…" : ""].filter(Boolean).join(" · ");
  if (sync.state === "paused") {
    const retry = sync.retryAt
      ? "Retrying at " + (typeof displayStamp === "function"
        ? displayStamp(new Date(sync.retryAt), "dateTime")
        : new Date(sync.retryAt).toLocaleString())
      : "Waiting before retrying";
    return [sync.message || "Paused for rate limit", where, retry].filter(Boolean).join(" · ");
  }
  if (sync.state === "done") return successLine || [where, "Not synced yet"].filter(Boolean).join(" · ");
  return sync.message || "";
}

function syncButtonLabel(sync) {
  if (!sync || !sync.state || sync.state === "done") return "Sync";
  if (sync.state === "syncing") return "Syncing";
  if (sync.state === "error") return sync.retrying ? "Retrying…" : "Sync failed";
  if (sync.state === "paused") return "Sync paused";
  return "Sync";
}

const debugLines = [];
let logRefreshTimer = null;
let logRefreshPending = null;

function pushDebug(source, text) {
  const line = redactDebugText(text);
  if (!line) return;
  debugLines.push({ at: Date.now(), source: String(source || "app").slice(0, 40), text: line });
  if (debugLines.length > 200) debugLines.splice(0, debugLines.length - 200);
  if (state.view === "log" && !logRefreshTimer) {
    logRefreshTimer = setTimeout(() => {
      logRefreshTimer = null;
      if (state.view === "log") refreshLog();
    }, 150);
  }
}

function rememberSyncStatus(sync) {
  if (!sync) return;
  state.sync = sync;
  if (sync.accountId) state.syncScopes.set(JSON.stringify([sync.accountId, sync.folderId || ""]), sync);
}

function currentFolderSync() {
  const key = JSON.stringify([state.accountId, state.folderId]);
  const folder = state.syncScopes.get(key);
  const account = state.syncScopes.get(JSON.stringify([state.accountId, ""]));
  if (account && (account.state === "paused" || account.state === "error") && (!folder || (account.updatedAt || 0) >= (folder.updatedAt || 0))) return account;
  return folder || null;
}

let bodySyncEvents = 0;
let bodySyncPaintTimer = null;
let bodySyncRead = null;

function rememberBodySync(snapshot) {
  if (!snapshot || typeof snapshot.session !== "string" || !Number.isFinite(snapshot.sequence) || !Array.isArray(snapshot.accounts)) return false;
  const previous = state.bodySync;
  if (previous && (previous.session === snapshot.session ? snapshot.sequence < previous.sequence : snapshot.startedAt < previous.startedAt)) return false;
  state.bodySync = snapshot;
  state.bodySyncUnavailable = false;
  return true;
}

function bodySyncCopy(row) {
  const sources = { open: "Message request", visible: "Message list", overnight: "Overnight fill" };
  const reasons = {
    "mail-work": "Waiting for other mail work", turn: "Waiting for its turn",
    "rate-limit": "Paused for mailbox rate limit", connection: "Check the mailbox connection",
    offline: "Network reports offline; existing requests may still finish",
    sleeping: "Waiting for the computer to wake",
    "source-limit": "Reached the 3 MiB source limit; available content is kept. No action needed",
    incomplete: "Body remains incomplete; available content is kept",
    "message-changed": "Message changed; refresh the folder or reopen it",
    "download-failed": "Body download did not finish; normal mail activity can retry",
  };
  const labels = { running: "Downloading", queued: "Waiting", paused: "Paused", error: "Needs attention", limited: "Limited", idle: "Idle" };
  const label = labels[row?.state] || "Checking activity…";
  const detail = row?.reason === "rate-limit" && row.state === "error" ? "Last attempt hit a mailbox rate limit"
    : reasons[row?.reason] || (row?.state === "idle" && row.lastResult === "done" ? "Last body download finished" : sources[row?.source] || "Downloads as needed");
  return { label, detail };
}

function bodySyncView(snapshot, accounts, unavailable = false) {
  const rows = accounts.map(account => {
    const activity = !unavailable && snapshot?.accounts.find(row => row.accountId === account.id);
    return { account, ...(activity || { state: "unknown" }), copy: unavailable ? { label: "Status unavailable", detail: "Waiting for a fresh activity update" } : bodySyncCopy(activity) };
  });
  const priority = ["running", "queued", "paused", "error", "limited", "idle"];
  const active = priority.find(kind => rows.some(row => row.state === kind)) || "unknown";
  const label = unavailable ? "Status unavailable" : bodySyncCopy({ state: active }).label;
  const horizon = snapshot?.horizonDays === 0 ? "All history" : [180,365].includes(snapshot?.horizonDays) ? snapshot.horizonDays + " days" : "Mail & Sync history";
  const help = (snapshot?.night ? "Overnight window active. " : "Overnight: 00:00–07:00 local while the app is awake and open. ")
    + horizon + ". One indexed body per background pass; attachments on demand. Activity only, with no whole-mailbox completion estimate.";
  return { rows, state: active, label: "Bodies · " + label, help };
}

function paintBodySyncStatus() {
  const root = $("body-sync"), label = $("body-sync-label"), list = $("body-sync-accounts");
  if (!root || !label || !list) return;
  const show = state.view === "mail" && state.accounts.length > 0;
  root.hidden = !show;
  const button = $("refresh");
  if (button && typeof button.setAttribute === "function") {
    if (show) button.setAttribute("aria-describedby", "body-sync");
    else if (typeof button.removeAttribute === "function") button.removeAttribute("aria-describedby");
  }
  if (!show) return;
  const view = bodySyncView(state.bodySync, state.accounts, state.bodySyncUnavailable);
  if (label.textContent !== view.label) label.textContent = view.label;
  root.setAttribute?.("data-state", view.state);
  $("body-sync-help").textContent = view.help;
  if (!state.bodySync && !state.bodySyncUnavailable) return;
  list.replaceChildren(...view.rows.map(row => {
    const item = document.createElement("li"), name = document.createElement("strong"), detail = document.createElement("span");
    name.textContent = accountLabel(row.account);
    detail.textContent = " · " + row.copy.label + " — " + row.copy.detail;
    item.append(name, detail);
    return item;
  }));
}

function acceptBodySync(snapshot) {
  if (!rememberBodySync(snapshot)) return;
  bodySyncEvents++;
  if (!bodySyncPaintTimer) bodySyncPaintTimer = setTimeout(() => {
    bodySyncPaintTimer = null; paintBodySyncStatus();
  }, 100);
}

async function refreshBodySyncStatus() {
  if (bodySyncRead) return bodySyncRead;
  const events = bodySyncEvents;
  bodySyncRead = (async () => {
    try {
      const snapshot = await call("mail:getBodySyncStatus");
      if (events !== bodySyncEvents) return;
      if (!rememberBodySync(snapshot)) state.bodySyncUnavailable = true;
    } catch {
      if (events === bodySyncEvents) state.bodySyncUnavailable = true;
    }
    paintBodySyncStatus();
  })().finally(() => { bodySyncRead = null; });
  return bodySyncRead;
}

let syncDetailTimer = null;
function paintSyncControl() {
  clearTimeout(syncDetailTimer);
  const button = $("refresh");
  const label = $("sync-label");
  const detail = $("sync-detail");
  const sync = currentFolderSync();
  const mail = state.view === "mail";
  const control = $("sync-control");
  const slot = $(mail ? "list-refresh-slot" : "page-refresh-slot");
  if (control && slot && control.parentElement !== slot) slot.appendChild(control);
  const word = !mail || state.outbox ? "Refresh" : syncButtonLabel(sync);
  const text = !mail ? "Refresh this page" : !state.accounts.length ? "No account connected"
    : state.outbox ? "Outbox is on this computer. It is not a mailbox folder."
    : (state.allInbox && !(sync && ["syncing", "error", "paused"].includes(sync.state)))
      ? allAccountMailSyncCopy()
      : (syncDetail(sync) || "Not synced yet");
  if (label) label.textContent = word;
  if (button) {
    const busy = mail && !state.outbox && !!(sync && sync.state === "syncing");
    const nativeTip = !state.accounts.length && mail ? "Connect an account to sync mail." : text;
    button.disabled = mail && (!state.accounts.length || busy);
    button.classList.toggle("is-syncing", busy);
    button.setAttribute("aria-busy", busy ? "true" : "false");
    button.setAttribute("aria-label", `${word}. ${text}`);
    const line = $("sync-tip-line");
    if (line) line.textContent = nativeTip;
    if (button.dataset) button.dataset.syncTitle = nativeTip;
    const bodies = $("body-sync");
    const bodiesOpen = !!(bodies && !bodies.hidden);
    const hot = bodiesOpen && typeof button.matches === "function" && button.matches(":hover, :focus");
    if (hot && typeof button.removeAttribute === "function") button.removeAttribute("title");
    else button.title = nativeTip;
    if (button.dataset && typeof button.addEventListener === "function" && !button.dataset.bodiesTip) {
      button.dataset.bodiesTip = "1";
      const hideNative = () => {
        const open = $("body-sync");
        if (open && !open.hidden && typeof button.removeAttribute === "function") button.removeAttribute("title");
      };
      const showNative = () => { if (button.dataset.syncTitle) button.title = button.dataset.syncTitle; };
      button.addEventListener("pointerenter", hideNative);
      button.addEventListener("focus", hideNative);
      button.addEventListener("pointerleave", showNative);
      button.addEventListener("blur", showNative);
    }
  }
  if (detail) {
    const active = mail && ["syncing", "error", "paused"].includes(sync?.state);
    const remaining = sync?.state === "done" && sync.lastSuccessAt ? 5000 - (Date.now() - Number(sync.updatedAt || sync.lastSuccessAt)) : 0;
    const brief = active ? (sync.state === "syncing" ? phaseWord(sync.phase) || "Downloading…" : syncStatusLabel(sync))
      : mail && remaining > 0 ? "Synced " + syncClock(sync.lastSuccessAt) : "";
    detail.textContent = brief;
    detail.hidden = !brief;
    detail.title = text;
    if (mail && remaining > 0) syncDetailTimer = setTimeout(paintSyncControl, remaining + 1);
  }
}

function beginSync(extra) {
  const prev = currentFolderSync() || {};
  rememberSyncStatus(Object.assign({}, prev, extra || {}, {
    state: "syncing",
    message: "Syncing…",
    updatedAt: Date.now(),
  }));
  paintSyncControl();
  pushDebug("sync", syncDetail(state.sync) || "Syncing…");
}

function finishLocalSync(kind, error) {
  if (kind === "error") {
    const message = redactDebugText(error.message || String(error));
    rememberSyncStatus({ ...(currentFolderSync() || {}), accountId: state.accountId, folderId: state.folderId,
      state: "error", lastError: message, message });
  }
  paintSyncControl();
}

let supportLogLines = [];
function logLine(row) {
  const at = new Date(row && row.at);
  const when = Number.isFinite(+at) ? shownWhen(at, true) : "Unknown time";
  return [when, redactDebugText(row && row.source), redactDebugText(row && row.text)].filter(Boolean).join(" · ");
}
function paintLog(lines) {
  supportLogLines = (Array.isArray(lines) ? lines : []).slice(-200);
  const sources = $("log-source");
  const previous = sources.value;
  sources.replaceChildren();
  for (const value of ["", ...new Set(supportLogLines.map(row => row.source || "host"))]) {
    const option = document.createElement("option"); option.value = value; option.textContent = value ? redactDebugText(value) : "All sources"; sources.append(option);
  }
  sources.value = [...sources.options].some(row => row.value === previous) ? previous : "";
  filterSupportLog();
}
function filteredSupportLog() {
  const source = $("log-source").value;
  return supportLogLines.filter(row => !source || (row.source || "host") === source);
}
function filterSupportLog() {
  const list = $("log-lines"); list.replaceChildren();
  const rows = filteredSupportLog();
  for (const row of rows) { const item = document.createElement("li"); item.textContent = logLine(row); list.append(item); }
  if (!rows.length) { const item = document.createElement("li"); item.textContent = "No recent session lines for this source."; list.append(item); }
}
function refreshLog() {
  if (!logRefreshPending) logRefreshPending = readSupportLog().finally(() => { logRefreshPending = null; });
  return logRefreshPending;
}
async function readSupportLog() {
  const status = $("log-status");
  try {
    const data = await call("host:getDebugLog", { limit: 200 });
    const lines = data && Array.isArray(data.lines) ? data.lines : [];
    paintLog([...lines, ...debugLines].sort((a,b) => Number(a.at) - Number(b.at)).slice(-200));
    status.textContent = "Showing up to 200 recent host and renderer lines from this session.";
  } catch (error) {
    paintLog(debugLines);
    status.textContent = "Host log unavailable; only recent renderer lines are shown. " + redactDebugText(error.message);
  }
}
function previewSupportLog() {
  const header = "Morrow Mail " + appVersion + " · Support preview · " + shownWhen(new Date(), true) + "\nKnown credential patterns are redacted. Review before sharing: addresses and diagnostic context may remain. Up to 200 recent session lines; this is not a full history.\n\n";
  $("support-preview").value = header + filteredSupportLog().map(logLine).join("\n");
  $("support-copy-status").textContent = "Review the preview before copying.";
  openDialog("support-dialog");
}
async function copySupportLog() {
  try { await navigator.clipboard.writeText($("support-preview").value); $("support-copy-status").textContent = "Copied the preview. Review again before sharing; addresses may remain."; }
  catch { $("support-copy-status").textContent = "Could not copy. Select and copy the preview manually."; $("support-preview").focus(); $("support-preview").select(); }
}

function showLog() {
  showPrimary("log", "log-panel");
  refreshLog().catch(() => paintLog(debugLines));
}

function showFeatures() {
  showPrimary("features", "features-panel");
  paintFeatureCatalog();
  paintShortcuts();
  paintCli();
  showFeaturesTab("catalog");
}

function showShortcuts() {
  showFeatures();
}

function setNavCollapsed(collapsed) {
  const on = !!collapsed;
  document.documentElement.dataset.nav = on ? "collapsed" : "expanded";
  const button = $("nav-collapse");
  const label = on ? "Expand sidebar" : "Collapse sidebar";
  if (button) {
    button.setAttribute("aria-expanded", on ? "false" : "true");
    button.setAttribute("aria-label", label);
    button.setAttribute("data-label", label);
    button.title = label;
    const text = button.querySelector(".nav-label");
    if (text) text.textContent = on ? "Expand" : "Collapse";
  }
  const brand = document.querySelector(".rail-brand");
  if (brand) {
    if (on) brand.setAttribute("title", "Morrow Mail");
    else brand.removeAttribute("title");
  }
  try { localStorage.setItem("morrow.navCollapsed", on ? "1" : "0"); } catch { /* the choice stays for this window */ }
}

function readNavCollapsed() {
  try {
    const stored = localStorage.getItem("morrow.navCollapsed");
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch { /* labels remain visible for a new profile */ }
  return false;
}

const ROW_ICON = {
  "Mark read": "M4 11h16v8H4v-8Zm0 0 8 5 8-5M4 11 12 5l8 6",
  "Mark unread": "M4 7h16v11H4V7Zm0 0 8 6 8-6",
  Delete: "M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13",
  Reply: "M9 17 4 12 9 7M20 18v-2a4 4 0 0 0-4-4H4",
  "Reply All": "M8 17 3 12 8 7M13 17 8 12 13 7M21 18v-2a4 4 0 0 0-4-4H8",
  Forward: ["M15 14 20 9 15 4", "M4 20v-7a4 4 0 0 1 4-4h12"],
  "Undo send": "M3 12a9 9 0 1 0 2.5-6.3M3 4v6h6",
};

function rowIcon(label) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const spec = ROW_ICON[label];
  const paths = Array.isArray(spec) ? spec : [spec || ""];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function rowAction(action, label, run, iconNode) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  if (action === "star") {
    const on = label === "Unstar";
    button.classList.toggle("is-starred", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  button.appendChild(iconNode || rowIcon(label));
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
  row.mailMessage = email;
  row.dataset.emailId = email.id || "";
  row.dataset.accountId = email.accountId || "";
  row.dataset.folderId = email.folderId || "";
  const selected = state.selectedIds.indexOf(String(email.id || "")) >= 0;
  if (selected) row.classList.add("selected");
  row.setAttribute("aria-selected", selected ? "true" : "false");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message";
  button.draggable = !email.outbox;
  button.setAttribute("data-testid", "mail-list-message-row");
  if (email.unread) button.classList.add("unread");
  if (readerCurrentId() === email.id) button.setAttribute("aria-current", "true");
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
    star.appendChild(starIcon(true, 13));
    from.appendChild(star);
  }
  if (email.isStarred) row.dataset.starred = "true";
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
  const mailbox = state.accounts.find((row) => row.id === email.accountId);
  const prefix = (state.allInbox || state.outbox) && mailbox
    ? accountLabel(mailbox) + " · "
    : (state.query && mailbox ? (mailbox.email || accountLabel(mailbox)) + " · " : "");
  snippet.textContent = prefix + (email.snippet || "");
  main.append(from, subjectLine, snippet);
  button.append(gutter, avatar, main);
  button.addEventListener("click", (event) => {
    if (email.outbox) {
      openMessage(email.id).catch((error) => showStatus(error.message, true));
      return;
    }
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
  const starred = !!email.isStarred;
  actions.append(
    rowAction("star", starred ? "Unstar" : "Star", () => toggleStar(row.mailMessage), starIcon(starred, 16)),
    rowAction("read", unread ? "Mark read" : "Mark unread", () => setRead(row.mailMessage, !!row.mailMessage.unread)),
    rowAction("reply", "Reply", () => replyFromList(row.mailMessage, "reply")),
    rowAction("reply-all", "Reply All", () => replyFromList(row.mailMessage, "all")),
    rowAction("forward", "Forward", () => replyFromList(row.mailMessage, "forward")),
    rowAction("delete", "Delete", () => deleteFromList(row.mailMessage)),
  );
  if (email.outbox) {
    const undo = rowAction("undo-outbox", "Undo send", () => undoOutboxItem(row.mailMessage));
    if (email.outboxStatus === "sending") undo.disabled = true;
    actions.replaceChildren(undo);
    row.append(button, actions);
    return row;
  }
  row.append(rowCheck(email, selected), button, actions);
  return row;
}

function currentUnreadView() {
  return {
    query: state.query,
    outbox: state.outbox,
    allInbox: state.allInbox,
    unreadOnly: state.allInboxUnreadOnly,
    accountId: state.accountId,
    folderId: state.folderId,
    folder: state.allInbox || state.outbox ? null : selectedFolderNode(),
  };
}

function noteUnreadScope() {
  state.unreadHold = applyUnreadHold(state.unreadHold, { kind: "scope", view: currentUnreadView() });
}

function unreadRetainIds() {
  const hold = state.unreadHold;
  if (!hold || !hold.id || !unreadListActive(currentUnreadView())) return [];
  return [String(hold.id)];
}

function shownEmails() {
  const input = $("list-filter");
  const query = input ? input.value : "";
  if (state.outbox) return visibleList(state.emails, query, null);
  const folder = state.allInbox
    ? (state.allInboxUnreadOnly ? { view: { unread: true } } : null)
    : selectedFolderNode();
  const holdId = unreadListActive(currentUnreadView()) && state.unreadHold ? state.unreadHold.id : "";
  return visibleList(state.emails, query, folder, holdId);
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
  if (state.outbox) {
    state.selectedIds = [];
    state.selectionAnchor = "";
    renderList();
    return;
  }
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
  if (selectAll) {
    const selected = shown.filter(email => state.selectedIds.includes(email.id)).length;
    selectAll.disabled = !shown.length;
    selectAll.checked = shown.length > 0 && selected === shown.length;
    selectAll.indeterminate = selected > 0 && selected < shown.length;
    selectAll.setAttribute("aria-label", `Select ${shown.length} messages shown on this page`);
  }
  if (!bar) return;
  const wasHidden = bar.hidden;
  if (!state.selectedIds.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (count) {
    const n = state.selectedIds.length;
    const hidden = state.selectedIds.filter((id) => !shown.some((row) => row.id === id)).length;
    count.textContent = n + " selected" + (hidden ? " · " + hidden + " hidden by this filter" : "");
  }
  const messages = selectionMoveMessages();
  const starred = selectedMessages().length > 0 && selectedMessages().every((email) => email.isStarred);
  setSelectionLabel("selection-star", starred ? "Unstar" : "Star");
  const starButton = $("selection-star");
  if (starButton) {
    starButton.classList.toggle("is-starred", starred);
    starButton.setAttribute("aria-pressed", starred ? "true" : "false");
  }
  const account = messages[0]
    ? (state.accounts.find((item) => item.id === messages[0].accountId) || selectedAccount())
    : selectedAccount();
  const provider = folderProvider(account);
  const listed = account ? providerPayloadFor(account) : null;
  const model = messages[0]
    ? organizeMenu(messages[0], foldersOf(account), listed, provider)
    : { add: [], remove: [], outlook: [] };
  const labels = $("selection-labels");
  const outlook = $("selection-outlook");
  if (labels) labels.hidden = provider !== "gmail" || !model.add.length;
  if (outlook) outlook.hidden = !model.outlook.length;
  if (wasHidden) {
    const motion = motionApi();
    if (motion) {
      motion.prepare(bar);
      motion.enter(bar);
    }
  }
}

function paintSearchCoverage(shown) {
  const filter = $("list-filter").value.trim();
  const scope = $("search-scope");
  scope.hidden = !state.query;
  const picker = $("search-account");
  const key = JSON.stringify(state.accounts.map(account => [account.id, accountLabel(account)]));
  if (key !== searchAccountKey) {
    searchAccountKey = key;
    picker.replaceChildren(option("", "All connected accounts"));
    for (const account of state.accounts) picker.appendChild(option(account.id, accountLabel(account)));
  }
  picker.value = state.searchAccountId;
  const account = state.accounts.find((row) => row.id === state.searchAccountId);
  $("list-coverage").textContent = state.query
    ? `Search downloaded mail · ${account ? accountLabel(account) : "All connected accounts"} · ${state.emails.length} returned (up to 100) · ${shown.length} shown`
    : `${shown.length} shown of ${state.emails.length} on this page`;
  $("list-coverage").hidden = !state.query && !filter;
  const chip = $("filter-chip");
  chip.hidden = !filter;
  chip.textContent = "Filter: " + filter + " × Clear filter";
}

function selectionScopeCopy(messages, source) {
  const rows = messages || [];
  const selected = source || selectedMessages();
  const ids = new Set(rows.map((row) => row.id));
  const excluded = selected.filter((row) => !ids.has(row.id)).length;
  const names = [...new Set(rows.map((row) => {
    const account = state.accounts.find((item) => item.id === row.accountId);
    return account ? accountLabel(account) : "Disconnected mailbox";
  }))];
  return `${rows.length} messages from ${names.join(", ")}.` + (excluded ? ` ${excluded} excluded messages in other accounts or outside this action will stay selected.` : "");
}

async function reviewedRemoval(messages, kind) {
  const planned = bulkRemovalCalls(messages, kind, state.prefs.conversation);
  const affected = new Map(messages.map((row) => [row.id, row]));
  let expanded = false;
  for (const spec of planned) {
    if (!spec.params.threadId) continue;
    const rows = await call("mail:listThreadMessages", { accountId: spec.params.accountId, threadId: spec.params.threadId, headersOnly: true });
    if (!Array.isArray(rows)) throw new Error("Conversation scope could not be loaded. Refresh before trying again.");
    for (const row of rows) {
      if (row.accountId !== spec.params.accountId) throw new Error("Conversation account did not match.");
      affected.set(row.id, row);
    }
    expanded = true;
  }
  const rows = [...affected.values()];
  const detail = { scope: selectionScopeCopy(rows, messages) + (expanded
    ? ` Conversation view expands this action to ${rows.length} downloaded messages, including unselected members in other folders.`
    : " Only these messages are included.") };
  // Freeze the reviewed message IDs; a newly arriving thread member is not authorized.
  return { rows, detail, calls: bulkRemovalCalls(rows, kind, false) };
}

function renderList() {
  paintSyncControl();
  paintListPaging();
  rememberLoadedSelection();
  const list = $("message-list");
  $("messages").classList.toggle("compact-list", state.prefs.compactList === true);
  const account = selectedAccount();
  const folder = foldersOf(account).find((item) => item.id === state.folderId);
  const title = $("list-title");
  if (title) {
    title.textContent = state.query ? `Search: ${state.query}` : (state.outbox ? "Outbox" : (state.allInbox ? allAccountMailTitle(state.allInboxUnreadOnly) : (chipLabel(folder) || "Messages")));
  }
  renderChips(state.allInbox || state.outbox ? null : account);
  if (title) title.classList.toggle("sr", !state.query && !state.allInbox && !state.outbox && state.prefs.chips && chipFolders(account).some(item => item.id === state.folderId));
  const shown = shownEmails();
  paintSelectionBar(shown);
  paintSearchCoverage(shown);
  const keys = new Set(shown.map(email => email.accountId + "\0" + email.id));
  for (const [key, cached] of messageRows) {
    if (!keys.has(key)) { cached.row.remove(); messageRows.delete(key); }
  }
  list.querySelector(":scope > .empty")?.remove();
  list.querySelector(":scope > .outbox-load-error")?.remove();
  if (state.outbox && state.outboxError) {
    const error = document.createElement("p");
    error.className = "outbox-load-error hint";
    error.setAttribute("role", "status");
    error.textContent = "Unknown — Outbox could not be refreshed. Saved rows may be out of date. ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ghost";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => loadScheduled());
    error.appendChild(retry);
    list.appendChild(error);
  }
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    const listQuery = $("list-filter") && String($("list-filter").value || "").trim();
    if (!state.accounts.length && !state.query) {
      empty.textContent = "Connect a mailbox to download messages here.";
    } else if (state.query && !state.emails.length) {
      empty.textContent = `No downloaded messages match “${state.query}”. Older mail or complete bodies may not be downloaded.`;
    } else if (state.outbox && !listQuery && !state.emails.length) {
      empty.textContent = state.outboxError ? "Waiting sends are unknown. Retry to load Outbox." : outboxEmptyCopy();
    } else if (state.allInbox && !listQuery && (state.allInboxUnreadOnly || !state.emails.length)) {
      empty.textContent = allAccountMailEmptyCopy(state.allInboxUnreadOnly);
    } else if (!listQuery && folder && folder.emptyCopy) {
      empty.textContent = folder.emptyCopy;
    } else if (!state.emails.length) {
      empty.textContent = currentFolderSync()?.lastSuccessAt
        ? "No downloaded messages in this folder. Sync checks recent mail; older mail may be outside the download window."
        : "Mail has not been downloaded for this folder yet. Use Sync to download recent mail.";
    } else {
      empty.textContent = "No loaded messages match that filter.";
    }
    list.appendChild(empty);
  } else {
    let previous = null;
    const selected = new Set(state.selectedIds);
    for (const email of shown) {
      const key = email.accountId + "\0" + email.id;
      // Compare displayed fields only: bodies and attachments can be large.
      // Retained rows keep keyboard focus and read the latest message for actions.
      const mailbox = state.accounts.find((item) => item.id === email.accountId);
      const stamp = JSON.stringify([email.folderId, email.from, email.subject, email.snippet, email.date,
        email.unread, email.isStarred, !!state.query, state.allInbox, state.outbox,
        state.allInbox && mailbox ? accountLabel(mailbox) : "",
        state.query && mailbox ? mailbox.email : "",
        state.prefs.timeFormat, state.prefs.dateFormat]);
      let cached = messageRows.get(key);
      if (!cached || cached.stamp !== stamp) {
        const row = messageRow(email);
        if (cached) cached.row.replaceWith(row);
        cached = { row, stamp, selected: selected.has(email.id), current: readerCurrentId() === email.id };
        messageRows.set(key, cached);
      }
      const row = cached.row;
      row.mailMessage = email;
      const isSelected = selected.has(email.id);
      if (cached.selected !== isSelected) {
        cached.selected = isSelected;
        row.classList.toggle("selected", isSelected);
        row.setAttribute("aria-selected", String(isSelected));
        const check = row.querySelector(".row-check");
        if (check) {
          check.setAttribute("aria-checked", String(isSelected));
          check.replaceChildren(strokeIcon(isSelected ? [CHECK_BOX, CHECK_MARK] : [CHECK_BOX], 16));
        }
      }
      const current = readerCurrentId() === email.id;
      if (cached.current !== current) {
        cached.current = current;
        const button = row.querySelector("button.message");
        if (current) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      }
      const next = previous ? previous.nextElementSibling : list.firstElementChild;
      if (next !== row) list.insertBefore(row, next);
      previous = row;
    }
  }
  const motionKey = [state.accountId || "", state.folderId || "", state.query, state.listOffset, state.allInbox ? "all" : "", state.outbox ? "outbox" : "", state.allInboxUnreadOnly ? "unread" : ""].join("\0");
  if (motionKey !== listMotionKey) {
    listMotionKey = motionKey;
    const motion = motionApi();
    if (motion) motion.rows(list.querySelectorAll("button.message"));
  }
  const current = list.querySelector('[aria-current="true"]');
  const filtering = document.activeElement && document.activeElement.id === "list-filter";
  const currentId = readerCurrentId();
  const currentRow = (state.emails || []).find((row) => row && row.id === currentId);
  const openKey = currentRow ? currentRow.accountId + "\0" + currentRow.id : "";
  // Revealing the open mail row scrolls the document. Skip it off the Mail page.
  if (current && !filtering && openKey !== listOpenKey && state.view === "mail") current.scrollIntoView({ block: "nearest" });
  listOpenKey = openKey;
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

const SUGGEST_ICON = [
  "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
  "M20 3v4",
  "M22 5h-4",
  "M4 17v2",
  "M5 18H3",
];

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

const LABEL_ICON = [
  "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z",
  "M7 7h.01",
];

const STAR_PATH = "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z";

function starIcon(filled, size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("star-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", STAR_PATH);
  if (filled) {
    path.setAttribute("fill", "currentColor");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-linejoin", "round");
  } else {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.appendChild(path);
  return svg;
}

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

function readerButton(action, label, run, iconNode) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost icon-btn";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  const icon = iconNode || readerIcon(action);
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
  const starredOn = !!email.isStarred;
  const star = readerButton("star", starredOn ? "Unstar" : "Star", () => toggleStar(email), starIcon(starredOn));
  star.classList.toggle("is-starred", starredOn);
  star.setAttribute("aria-pressed", starredOn ? "true" : "false");
  star.addEventListener("click", (event) => {
    if (!state.busy) return;
    event.stopImmediatePropagation();
    showStatus("Still finishing the last change.", true);
  }, true);
  const archive = readerButton("archive", "Archive", () => archiveOpen(email));
  const trash = readerButton("trash", "Delete", () => trashOpen(email));
  trash.setAttribute("aria-keyshortcuts", "Delete Backspace");
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
  const reply = readerButton("reply", "Reply", () => openReaderCompose("reply"));
  reply.setAttribute("aria-keyshortcuts", "R");
  const replyAll = readerButton("reply-all", "Reply All", () => openReaderCompose("all"));
  replyAll.setAttribute("aria-keyshortcuts", "A");
  const suggestPending = !!(state.suggestions && state.suggestions.emailId === email.id && state.suggestions.pending);
  const suggest = readerButton("suggest", "Suggest", () => {
    requestReplySuggestions(email);
  }, strokeIcon(SUGGEST_ICON));
  suggest.title = "Suggest a reply";
  suggest.setAttribute("aria-label", "Suggest a reply");
  suggest.setAttribute("aria-busy", suggestPending ? "true" : "false");
  suggest.disabled = suggestPending;
  const forward = readerButton("forward", "Forward", () => openReaderCompose("forward"));
  forward.setAttribute("aria-keyshortcuts", "F");
  const menus = document.createElement("div");
  menus.className = "reader-menus";
  menus.append(move, organizeButton(email));
  if (snooze) menus.append(snooze);
  if (email.isDraft) {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "primary";
    resume.textContent = "Resume draft";
    resume.addEventListener("click", () => attachmentAction(() => resumeDraft(email)));
    bar.appendChild(resume);
  }
  const besideStar = document.createElement("div");
  besideStar.className = "reader-star-group";
  besideStar.append(star);
  renderTranslate(besideStar, email);
  bar.append(reply, replyAll, suggest, forward, besideStar, archive, trash, menus);
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

function placeReaderMenu(bar, node, beforeAction) {
  const menus = bar.querySelector(".reader-menus") || bar;
  const before = beforeAction ? menus.querySelector('[data-action="' + beforeAction + '"]') : null;
  if (before) menus.insertBefore(node, before);
  else menus.append(node);
}

function appendLabelActions(bar, email) {
  const payload = state.providerFolders;
  if (!payload || payload.accountId !== email.accountId) return;
  const view = providerFolderState(payload);
  if (view.mode !== "live") return;
  const labels = providerLabelTree(view.folders);
  if (payload.source === "gmail" || payload.provider === "google") {
    if (!labels.some((folder) => folder.editable)) return;
    const button = readerButton("labels", "Labels", () => openLabelPicker([email], false), strokeIcon(LABEL_ICON));
    button.title = "Edit Gmail labels";
    button.setAttribute("aria-haspopup", "dialog");
    placeReaderMenu(bar, button, "organize");
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
    placeReaderMenu(bar, outlookMove, "snooze");
  }
}

function renderSuggestions(pane, email) {
  const box = document.createElement("div");
  box.className = "suggestions";
  box.setAttribute("aria-label", "Reply suggestions");
  box.hidden = true;
  const status = document.createElement("p");
  status.className = "hint";
  status.dataset.role = "suggest-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  const list = document.createElement("div");
  list.className = "suggest-list";
  box.append(status, list);
  pane.appendChild(box);
  paintSuggestions(email);
}

function requestReplySuggestions(email) {
  if (!email || !email.id) return;
  const view = state.suggestions;
  if (view && view.emailId === email.id && view.pending) return;
  state.suggestions = { emailId: email.id, items: [], error: "", pending: true };
  paintSuggestions(email);
  syncSuggestControl(email);
  return loadSuggestions(email);
}

function syncSuggestControl(email) {
  const reader = $("reader");
  const button = reader && reader.querySelector('[data-action="suggest"]');
  if (!button) return;
  const pending = !!(email && state.suggestions && state.suggestions.emailId === email.id && state.suggestions.pending);
  button.disabled = pending;
  button.setAttribute("aria-busy", pending ? "true" : "false");
}

async function loadSuggestions(email) {
  const gen = suggestGen += 1;
  const id = email.id;
  let next;
  try {
    const data = await call("aiDraftWrite:replySuggestions", { email: suggestionEmail(email) });
    next = { emailId: id, items: suggestionItems(data), error: "", pending: false };
  } catch (error) {
    next = {
      emailId: id,
      items: [],
      error: error instanceof Error ? error.message : String(error),
      pending: false,
    };
  }
  if (gen !== suggestGen) return;
  state.suggestions = next;
  if (state.email && state.email.id === id) {
    paintSuggestions(state.email);
    syncSuggestControl(state.email);
  }
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
    box.hidden = false;
    status.hidden = false;
    status.className = "hint";
    status.textContent = "No reply suggestions.";
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
      presentCompose(withSuggestion(composeSeed(email, "reply", self), text))
        .catch((error) => showStatus(error.message, true));
    });
    list.appendChild(button);
  }
}

function renderOutboxReader(pane, email, focus) {
  const bar = document.createElement("div");
  bar.className = "actions";
  const undo = document.createElement("button");
  undo.type = "button";
  undo.setAttribute("data-testid", "outbox-undo");
  const sending = email.outboxStatus === "sending";
  undo.textContent = sending ? "Sending…" : "Undo send";
  undo.disabled = sending;
  undo.onclick = () => { undoOutboxItem(email).catch((error) => showStatus(error.message, true)); };
  bar.appendChild(undo);
  const heading = document.createElement("h2");
  heading.textContent = email.subject || "(no subject)";
  const meta = document.createElement("p");
  meta.className = "meta";
  const mailbox = state.accounts.find((row) => row.id === email.accountId);
  meta.textContent = (mailbox ? accountLabel(mailbox) + ". " : "") + "Waiting on this computer. This is not a mailbox folder.";
  pane.append(bar, heading, meta);
  for (const [label, value] of [["To", email.to], ["Cc", email.cc], ["Bcc", email.bcc]]) {
    const text = people(value);
    if (!text) continue;
    const line = document.createElement("p");
    line.className = "meta";
    line.textContent = label + ": " + text;
    pane.appendChild(line);
  }
  // shortcut: outbox preview is plain text, upgrade if a safe HTML reader is required
  const body = document.createElement("pre");
  body.className = "outbox-body";
  body.textContent = email.textBody || "";
  pane.appendChild(body);
  if (focus !== false) undo.focus();
}

function readerFromLine(email) {
  const row = document.createElement("div");
  row.className = "reader-from";
  const from = document.createElement("p");
  from.className = "meta";
  paintSenderAddress(from, (email && email.from) || "");
  row.appendChild(from);
  const raw = email && email.date;
  const date = raw ? new Date(raw) : null;
  const text = shownWhen(date);
  if (!text) return row;
  const when = document.createElement("time");
  when.className = "meta when";
  when.setAttribute("datetime", typeof raw === "string" ? raw : date.toISOString());
  when.textContent = text;
  row.appendChild(when);
  return row;
}

function renderReader(focus) {
  if (pendingOpenBody && pendingOpenId) {
    paintReaderPending(listedMessage(pendingOpenId));
    return;
  }
  const pane = $("reader");
  pane.removeAttribute("aria-busy");
  const email = state.email;
  if (state.translate && (!email || state.translate.emailId !== email.id)) {
    stopTranslate();
    state.translate = null;
  }
  pane.replaceChildren();
  syncAttachmentPreview(email);
  if (!email) {
    resetThreadStrip();
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
    if (isReaderWindow()) pane.appendChild(readerCloseBar());
    pane.appendChild(wrap);
    return;
  }
  if (email.bodyError) {
    const heading = document.createElement("h2");
    heading.textContent = email.subject || "(no subject)";
    const error = document.createElement("p");
    error.className = "hint error";
    error.setAttribute("role", "status");
    error.textContent = email.bodyError;
    if (isReaderWindow()) pane.appendChild(readerCloseBar());
    pane.append(heading, readerFromLine(email), error);
    pane.appendChild(bodyRetryButton(email));
    if (focus) {
      heading.tabIndex = -1;
      heading.focus();
    }
    return;
  }
  if (email.outbox) {
    renderOutboxReader(pane, email, focus);
    return;
  }
  renderActions(pane, email);
  renderSuggestions(pane, email);
  appendReaderClose(pane);
  appendTranslateStatus(pane);
  paintTranslation();
  const heading = document.createElement("h2");
  heading.textContent = email.subject || "(no subject)";
  pane.append(heading, readerFromLine(email));
  const until = snoozedUntilOf(email);
  const untilDate = until ? new Date(until) : null;
  if (state.prefs.snooze !== false && untilDate && !Number.isNaN(untilDate.getTime())) {
    const snooze = document.createElement("p");
    snooze.className = "meta";
    snooze.textContent = `Snoozed until ${shownWhen(untilDate)}`;
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
  if (!isReaderWindow()) renderThread(pane, email);
  renderAttachments(pane, email);
  renderRemoteGate(pane, email);
  renderBody(pane, email);
  if (focus) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function appendMessageBody(parent, email, imagesOn) {
  const wrap = document.createElement("div");
  wrap.className = email && email.htmlBody ? "body is-html" : "body is-plain";
  if (email && email.htmlBody) {
    appendSafeMailHtml(wrap, email.htmlBody, imagesOn);
  } else {
    for (const node of bodyNodes(readable(email))) {
      const block = document.createElement("p");
      block.dataset.nodeId = node.node_id;
      block.textContent = node.text;
      wrap.appendChild(block);
    }
  }
  parent.appendChild(wrap);
  return wrap;
}

function bodyRetryButton(email, refresh) {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost";
  retry.dataset.action = "retry-body";
  retry.textContent = "Retry download";
  retry.addEventListener("click", () => guard(async () => {
    retry.disabled = true;
    try {
      if (typeof refresh === "function") await refresh();
      else await openMessage(email.id, false, true);
    }
    finally { retry.disabled = false; }
  }));
  return retry;
}

function renderBody(pane, email, refresh) {
  if (email?.bodyWarning) {
    const warning = document.createElement("p");
    warning.className = "hint"; warning.setAttribute("role", "status"); warning.textContent = email.bodyWarning;
    pane.appendChild(warning);
    pane.appendChild(bodyRetryButton(email, refresh));
  }
  const allowed = !!(email && state.remoteAllowed && state.remoteAllowed[email.id]);
  appendMessageBody(pane, email, remoteVisible(state.prefs.images, allowed));
}

function renderRemoteGate(pane, email, repaint) {
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
    if (typeof repaint === "function") repaint();
    else renderReader(false);
  });
  bar.append(note, button);
  pane.appendChild(bar);
}

function translateIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "10");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "2");
  line.setAttribute("y1", "12");
  line.setAttribute("x2", "22");
  line.setAttribute("y2", "12");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z");
  svg.append(circle, line, path);
  return svg;
}

function renderTranslate(pane, email) {
  const bar = document.createElement("div");
  bar.className = "translate";
  const go = document.createElement("button");
  go.type = "button";
  go.className = "ghost";
  go.dataset.action = "translate";
  const label = document.createElement("span");
  label.textContent = "Translate";
  go.append(translateIcon(), label);
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
  bar.append(go, cancel);
  pane.appendChild(bar);
}

function appendTranslateStatus(pane) {
  const translated = document.createElement("div");
  translated.className = "translation";
  translated.setAttribute("role", "status");
  translated.hidden = true;
  pane.appendChild(translated);
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
  const failed = !!(view.error || view.openError);
  const show = !!(view.pending || failed || view.windowOpen || text);
  box.hidden = !show;
  if (!show) return;
  if (failed) {
    const line = document.createElement("p");
    line.className = "error";
    line.textContent = view.error || view.openError;
    box.appendChild(line);
  }
  if (view.pending && !view.error) {
    const line = document.createElement("p");
    line.textContent = view.windowOpen ? "Translating… Opened in a new window." : "Translating…";
    box.appendChild(line);
  } else if (view.windowOpen && !failed) {
    const line = document.createElement("p");
    line.textContent = "Opened in a new window.";
    box.appendChild(line);
  }
  if (text && (!view.windowOpen || view.openError)) {
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
  current.error = current.error || "Translation cancelled.";
  call("mail:translateCancel", { reqId: current.reqId }).catch(() => {});
}

function reportTranslation(reqId, message) {
  if (!api || typeof api.reportTranslate !== "function") return;
  api.reportTranslate({ reqId: reqId, type: "error", message: message }).catch(() => {});
}

async function openTranslationWindow(view) {
  const seed = {
    reqId: view.reqId,
    subject: view.subject,
    language: view.languageLabel,
    original: view.source,
    nodeIds: view.nodes.map((node) => node.node_id),
  };
  if (!api || typeof api.openTranslateWindow !== "function") {
    throw new Error("Translation window is unavailable.");
  }
  const opened = await api.openTranslateWindow(seed);
  if (!opened || opened.ok === false) {
    throw new Error((opened && opened.message) || "That translation could not be opened.");
  }
}

async function startTranslate(email) {
  const nodes = translateNodes(translateSource(email));
  if (!nodes.length) {
    showStatus("This message has no text to translate.", true);
    return;
  }
  stopTranslate();
  const reqId = `tr-${Date.now().toString(36)}-${translateSeq += 1}`;
  const code = translateLangPref(state.prefs && state.prefs.translateLang);
  const view = {
    reqId: reqId,
    emailId: email && email.id,
    subject: email && email.subject ? String(email.subject) : "",
    nodes: nodes,
    texts: {},
    source: nodes.map((node) => node.text).join("\n\n"),
    language: code,
    languageLabel: translateLangLabel(code),
    error: "",
    openError: "",
    windowOpen: false,
    pending: true,
    current: 0,
    total: nodes.length,
  };
  state.translate = view;
  paintTranslation();
  try {
    await openTranslationWindow(view);
    if (state.translate === view) view.windowOpen = true;
  } catch (error) {
    if (state.translate !== view) return;
    view.openError = error instanceof Error ? error.message : String(error);
  }
  paintTranslation();
  if (state.translate !== view) return;
  try {
    await call("mail:translateStart", { reqId, targetLanguage: code, nodes });
  } catch (error) {
    if (state.translate !== view) return;
    const message = error instanceof Error ? error.message : String(error);
    view.pending = false;
    view.error = message;
    paintTranslation();
    reportTranslation(reqId, message);
  }
}

async function cancelTranslate() {
  const current = state.translate;
  if (!current || !current.pending) return;
  const reqId = current.reqId;
  current.pending = false;
  current.error = "Translation cancelled.";
  paintTranslation();
  await call("mail:translateCancel", { reqId });
}

function threadCalendarTime(iso, now) {
  const date = new Date(iso);
  const clock = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(clock.getTime())) return "";
  if (typeof displayStamp === "function") return displayStamp(date, "list", { now: clock });
  if (date.toDateString() === clock.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === clock.getFullYear();
  const options = sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
  return date.toLocaleDateString([], options);
}

function threadRelativeTime(iso, now) {
  const date = iso ? new Date(iso) : null;
  const clock = now instanceof Date ? now : new Date(typeof now === "number" || typeof now === "string" ? now : Date.now());
  if (!date || Number.isNaN(date.getTime()) || Number.isNaN(clock.getTime())) return "";
  const delta = clock.getTime() - date.getTime();
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (delta < minute && delta > -minute) return "just now";
  if (delta < 0) return threadCalendarTime(iso, clock);
  if (delta < hour) {
    const minutes = Math.max(1, Math.floor(delta / minute));
    return minutes === 1 ? "1 minute ago" : String(minutes) + " minutes ago";
  }
  if (delta < day) {
    const hours = Math.max(1, Math.floor(delta / hour));
    return hours === 1 ? "1 hour ago" : String(hours) + " hours ago";
  }
  if (delta < 7 * day) {
    const days = Math.floor(delta / day);
    if (days <= 1) return "yesterday";
    return String(days) + " days ago";
  }
  return threadCalendarTime(iso, clock);
}

function threadSnippetLine(member) {
  const raw = member && typeof member.snippet === "string" ? member.snippet : "";
  const line = raw.replace(/\s+/g, " ").trim();
  if (line.length <= 180) return line;
  return line.slice(0, 179).trimEnd() + "…";
}

function threadEarlierLabel(count) {
  return "Earlier in this conversation (" + count + ")";
}

function threadEarlierAnnouncement(count, expanded) {
  const noun = count === 1 ? "message" : "messages";
  if (expanded) return "Showing " + count + " earlier " + noun;
  return String(count) + " earlier " + noun + " collapsed";
}

function threadListLabel(total, count, expanded) {
  const messages = total === 1 ? "1 message" : String(total) + " messages";
  if (!count || expanded) return messages + " in this conversation";
  const earlier = count === 1 ? "1 earlier message collapsed" : String(count) + " earlier messages collapsed";
  return messages + " in this conversation, " + earlier;
}

// Latest two stay visible. The open message stays visible when it is older than those two.
// count is how many rows the Earlier control hides until it is expanded.
function threadStripPlan(members, currentId, expanded) {
  const rows = [];
  for (const row of Array.isArray(members) ? members : []) {
    if (row && row.id) rows.push(row);
  }
  rows.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const ids = [];
  for (const row of rows) ids.push(String(row.id));
  const total = ids.length;
  const tailCount = total < 2 ? total : 2;
  const tail = ids.slice(total - tailCount);
  const older = ids.slice(0, total - tailCount);
  const current = String(currentId || "");
  let pinned = false;
  const hiddenIds = [];
  for (const id of older) {
    if (id === current) pinned = true;
    else hiddenIds.push(id);
  }
  const showControl = hiddenIds.length > 0;
  const open = showControl && expanded === true;
  let visibleIds = ids;
  if (showControl && !open) visibleIds = pinned ? [current].concat(tail) : tail.slice();
  return {
    total: total,
    count: hiddenIds.length,
    showControl: showControl,
    expanded: open,
    visibleIds: visibleIds,
  };
}

function threadStripKey(email, members) {
  if (email && email.threadId) return String(email.threadId);
  for (const row of Array.isArray(members) ? members : []) {
    if (row && row.threadId) return String(row.threadId);
  }
  return email && email.id ? String(email.id) : "";
}

let threadEarlierKey = "";
let threadEarlierOpen = false;

function resetThreadStrip() {
  threadEarlierKey = "";
  threadEarlierOpen = false;
}

function rememberThreadStrip(email, members) {
  const key = threadStripKey(email, members);
  if (key === threadEarlierKey) return;
  threadEarlierKey = key;
  threadEarlierOpen = false;
}

function threadAbsoluteTime(iso) {
  const date = iso ? new Date(iso) : null;
  return shownWhen(date);
}

function threadMessageButton(member, email) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = member && member.unread ? "thread-item unread" : "thread-item";
  if (member.id === email.id) button.setAttribute("aria-current", "true");
  const who = document.createElement("span");
  who.className = "thread-sender";
  who.textContent = senderName(member.from);
  button.appendChild(who);
  const snippet = threadSnippetLine(member);
  if (snippet) {
    const preview = document.createElement("span");
    preview.className = "thread-snippet";
    preview.textContent = snippet;
    button.appendChild(preview);
  }
  const relative = threadRelativeTime(member.date);
  if (relative) {
    const when = document.createElement("time");
    when.className = "when";
    if (member.date) when.setAttribute("datetime", member.date);
    const absolute = threadAbsoluteTime(member.date);
    if (absolute) when.title = absolute;
    when.textContent = relative;
    button.appendChild(when);
  }
  button.addEventListener("click", () => {
    if (member.id === email.id) return;
    openMessage(member.id).catch((error) => showStatus(error.message, true));
  });
  return button;
}

function buildThreadStrip(email, members) {
  const plan = threadStripPlan(members, email && email.id, threadEarlierOpen);
  const byId = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    if (member && member.id) byId.set(String(member.id), member);
  }
  const list = document.createElement("div");
  list.className = "thread";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", threadListLabel(plan.total, plan.count, plan.expanded));
  if (plan.showControl) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "thread-earlier";
    toggle.setAttribute("aria-expanded", plan.expanded ? "true" : "false");
    toggle.setAttribute("aria-controls", "thread-messages");
    toggle.appendChild(strokeIcon([plan.expanded ? MOVE_CHEVRON_DOWN : MOVE_CHEVRON_RIGHT], 14));
    const label = document.createElement("span");
    label.textContent = threadEarlierLabel(plan.count);
    toggle.appendChild(label);
    toggle.addEventListener("click", () => toggleThreadEarlier());
    list.appendChild(toggle);
  }
  const messages = document.createElement("div");
  messages.id = "thread-messages";
  messages.className = "thread-messages";
  for (const id of plan.visibleIds) {
    const member = byId.get(id);
    if (member) messages.appendChild(threadMessageButton(member, email));
  }
  list.appendChild(messages);
  if (plan.showControl) {
    const status = document.createElement("p");
    status.className = "sr thread-earlier-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    list.appendChild(status);
  }
  return list;
}

function paintThreadStrip(announce) {
  const pane = $("reader");
  const email = state.email;
  if (!pane || !email || state.prefs.conversation === false) return;
  const members = Array.isArray(state.thread) ? state.thread : [];
  const list = buildThreadStrip(email, members);
  const existing = pane.querySelector(".thread");
  if (existing) existing.replaceWith(list);
  else pane.appendChild(list);
  if (!announce) return;
  const plan = threadStripPlan(members, email.id, threadEarlierOpen);
  const status = list.querySelector(".thread-earlier-status");
  if (status && plan.showControl) status.textContent = threadEarlierAnnouncement(plan.count, plan.expanded);
  const toggle = list.querySelector(".thread-earlier");
  if (toggle && typeof toggle.focus === "function") toggle.focus();
}

function toggleThreadEarlier() {
  threadEarlierOpen = !threadEarlierOpen;
  paintThreadStrip(true);
}

function renderThread(pane, email) {
  if (state.prefs.conversation === false || !email) {
    resetThreadStrip();
    return;
  }
  const members = Array.isArray(state.thread) ? state.thread : [];
  let count = 0;
  for (const row of members) if (row && row.id) count += 1;
  if (count < 2) {
    if (threadStripKey(email, members) !== threadEarlierKey) resetThreadStrip();
    return;
  }
  rememberThreadStrip(email, members);
  pane.appendChild(buildThreadStrip(email, members));
}

function attachmentPreviewKind(file) {
  if (!file || typeof file !== "object") return "";
  const mime = String(file.mimeType || file.contentType || "").toLowerCase().split(";")[0].trim();
  const name = String(file.filename || file.name || "").toLowerCase();
  const generic = !mime || mime === "application/octet-stream";
  if (mime === "application/pdf" || mime === "application/x-pdf") return "pdf";
  if (mime.startsWith("image/") && mime !== "image/svg+xml" && !mime.includes("tiff") && !mime.includes("heic") && !mime.includes("heif")) return "image";
  if (!generic) return "";
  if (name.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|gif|webp|bmp|avif|apng|ico)$/.test(name)) return "image";
  return "";
}

function attachmentBytes(data) {
  if (!data) return new Uint8Array();
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) return Uint8Array.from(data.data);
  return new Uint8Array();
}

function previewMime(file, kind) {
  if (kind === "pdf") return "application/pdf";
  const mime = String((file && (file.mimeType || file.contentType)) || "").toLowerCase().split(";")[0].trim();
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return mime === "image/jpg" ? "image/jpeg" : mime;
  const name = String((file && (file.filename || file.name)) || "").toLowerCase();
  if (name.endsWith(".png") || name.endsWith(".apng")) return "image/png";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".bmp")) return "image/bmp";
  if (name.endsWith(".avif")) return "image/avif";
  if (name.endsWith(".ico")) return "image/x-icon";
  return "image/jpeg";
}

let attachmentPreviewToken = 0;
let attachmentPreviewUrl = "";
let attachmentPreviewEmailId = "";
let attachmentPreviewAbort = null;
let attachmentPreviewRequest = null;
let attachmentPreviewFileId = "";
let pdfPreviewLoader = null;
const attachmentTasks = new Map();

function attachmentTaskKey(email, ids) {
  return JSON.stringify([String(email.id), ids]);
}

function attachmentTaskCopy(task) {
  if (task.cancelRequested) return `${task.label}: cancelling…`;
  const phases = { choosing: "Choose a save location…", queued: "Waiting for mailbox…", connecting: "Connecting…",
    downloading: "Downloading…", ready: task.cached ? "Using cached file…" : "Download complete…",
    writing: "Saving…", opening: "Opening application…" };
  const bytes = task.phase === "downloading" && task.loaded > 0 ? ` (${Math.ceil(task.loaded / 1024).toLocaleString()} KiB received)` : "";
  const file = task.count > 1 ? ` File ${(task.index || 0) + 1} of ${task.count}.` : "";
  return `${task.label}: ${phases[task.phase] || "Waiting…"}${bytes}${file}`;
}

function paintAttachmentTasks() {
  for (const list of document.querySelectorAll(".attachment-task-list")) {
    list.replaceChildren();
    for (const task of attachmentTasks.values()) {
      if (list.dataset.attachmentTasks !== "all" && task.viewKey !== list.dataset.attachmentTasks) continue;
      const row = document.createElement("div"); row.className = "attachment-task";
      const status = document.createElement("span"); status.setAttribute("role", "status"); status.textContent = `${task.filename} · ${attachmentTaskCopy(task)}`;
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "ghost"; cancel.textContent = "Cancel";
      cancel.setAttribute("aria-label", `Cancel ${task.label.toLowerCase()}`);
      cancel.disabled = task.cancelRequested || ["writing", "opening"].includes(task.phase);
      cancel.addEventListener("click", () => cancelAttachmentTask(task));
      row.append(status, cancel); list.appendChild(row);
    }
    list.hidden = !list.childNodes.length;
  }
}

function cancelAttachmentTask(task) {
  if (!task || task.done || task.cancelRequested) return;
  task.cancelRequested = true; paintAttachmentTasks();
  call("mail:cancelAttachmentRequest", { requestId: task.requestId }).catch(() => {
    if (task.done) return;
    task.cancelRequested = false; paintAttachmentTasks(); showStatus("Could not request attachment cancellation. Try Cancel again.", true);
  });
}

function startAttachmentTask(channel, email, files, label) {
  const zip = channel === "mail:downloadAttachmentsZip", prepare = channel === "mail:prepareDraft";
  const ids = zip || prepare ? files.map(file => file.id) : files[0].id;
  const viewKey = attachmentTaskKey(email, zip ? "zip" : ids), key = JSON.stringify([channel, viewKey, ids]);
  const existing = attachmentTasks.get(key);
  if (existing && !existing.cancelRequested) return existing;
  const task = { requestId: crypto.randomUUID(), viewKey, label, filename: prepare ? "Draft attachments" : zip ? "Attachments ZIP" : files[0].filename || "Attachment", phase: "queued", done: false, key };
  attachmentTasks.set(key, task);
  const off = typeof api.on === "function" ? api.on("mail:attachmentProgress", value => {
    if (value?.requestId !== task.requestId || task.done) return;
    Object.assign(task, { phase: value.phase, loaded: value.loaded, cached: value.cached, index: value.index, count: value.count }); paintAttachmentTasks();
    if (task === attachmentPreviewRequest && $("attachment-preview-status")) $("attachment-preview-status").textContent = attachmentTaskCopy(task);
  }) : () => {};
  const params = { emailId: email.id, messageId: email.id, requestId: task.requestId,
    ...(prepare ? { draftRevision: email.draftRevision } : zip ? { attachmentIds: ids } : { attachmentId: files[0].id, filename: files[0].filename }) };
  task.promise = call(channel, params).finally(() => {
    task.done = true; off?.(); if (attachmentTasks.get(key) === task) attachmentTasks.delete(key); paintAttachmentTasks();
  });
  paintAttachmentTasks(); return task;
}

function attachmentAction(fn) {
  // Attachment work has its own state. It must not hold the shell-wide guard.
  Promise.resolve().then(fn).catch(error => { if (error?.message !== "cancelled") showStatus(error.message || String(error), true); });
}

function attachmentIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const add = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  };
  if (kind === "download") {
    add("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" });
    add("polyline", { points: "7 10 12 15 17 10" });
    add("line", { x1: "12", y1: "15", x2: "12", y2: "3" });
  } else {
    add("path", { d: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" });
  }
  return svg;
}

function attachmentGhost(label, aria, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  button.setAttribute("aria-label", aria);
  button.addEventListener("click", onClick);
  return button;
}

function revokeAttachmentPreviewUrl() {
  if (!attachmentPreviewUrl) return;
  URL.revokeObjectURL(attachmentPreviewUrl);
  attachmentPreviewUrl = "";
}

function clearPdfPreviewPages() {
  const pages = $("attachment-preview-pages");
  if (!pages) return;
  pages.replaceChildren();
  pages.hidden = true;
  pages.removeAttribute("aria-busy");
}

function clearAttachmentPreview() {
  attachmentPreviewToken += 1;
  attachmentPreviewEmailId = "";
  attachmentPreviewFileId = "";
  cancelAttachmentTask(attachmentPreviewRequest);
  attachmentPreviewRequest = null;
  if (attachmentPreviewAbort) {
    attachmentPreviewAbort.abort();
    attachmentPreviewAbort = null;
  }
  const img = $("attachment-preview-image");
  if (img) {
    img.onload = null;
    img.onerror = null;
    if (typeof img.removeAttribute === "function") img.removeAttribute("src");
    img.alt = "";
    img.hidden = true;
  }
  clearPdfPreviewPages();
  revokeAttachmentPreviewUrl();
  const stage = $("attachment-preview-stage");
  if (stage) {
    stage.classList.remove("is-image");
    stage.classList.remove("is-pdf");
  }
  const status = $("attachment-preview-status");
  if (status) {
    status.hidden = true;
    status.textContent = "";
  }
}

function closeAttachmentPreview() {
  const dialog = $("attachment-preview");
  if (!dialog || !dialog.open) return;
  dialog.close();
}

function syncAttachmentPreview(email) {
  const dialog = $("attachment-preview");
  if (!dialog || !dialog.open) return;
  const id = email && email.id;
  if (id && id === attachmentPreviewEmailId) return;
  closeAttachmentPreview();
}

function showAttachmentPreviewShell(file, kind) {
  const dialog = $("attachment-preview");
  const title = $("attachment-preview-title");
  const status = $("attachment-preview-status");
  const stage = $("attachment-preview-stage");
  const img = $("attachment-preview-image");
  const label = (file && file.filename) || "Attachment";
  if (title) title.textContent = label;
  if (status) {
    status.hidden = false;
    status.textContent = "Loading preview…";
  }
  if (img) {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
    img.hidden = true;
  }
  clearPdfPreviewPages();
  if (stage) {
    stage.classList.toggle("is-image", kind === "image");
    stage.classList.toggle("is-pdf", kind === "pdf");
  }
  if (dialog && !dialog.open) openDialog("attachment-preview");
  const close = $("attachment-preview-close");
  if (close) close.focus();
}

function rememberPreviewUrl(url) {
  const previous = attachmentPreviewUrl;
  attachmentPreviewUrl = url || "";
  if (previous && previous !== url) URL.revokeObjectURL(previous);
}

function loadPdfPreview() {
  if (window.morrowPdf && window.morrowPdf.render) return Promise.resolve(window.morrowPdf);
  if (pdfPreviewLoader) return pdfPreviewLoader;
  pdfPreviewLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./pdf-preview.bundle.js";
    script.onload = () => {
      if (window.morrowPdf && window.morrowPdf.render) resolve(window.morrowPdf);
      else {
        pdfPreviewLoader = null;
        reject(new Error("PDF preview failed to load."));
      }
    };
    script.onerror = () => {
      pdfPreviewLoader = null;
      reject(new Error("PDF preview failed to load."));
    };
    document.head.appendChild(script);
  });
  return pdfPreviewLoader;
}

function pdfPreviewError(error) {
  const name = error && error.name;
  if (name === "PasswordException") return "This PDF is password-protected. Save or Open it instead.";
  if (name === "AbortError") return "";
  return "This PDF could not be previewed. Save or Open it instead.";
}

async function previewAttachment(email, file) {
  const kind = attachmentPreviewKind(file);
  if (!kind || !file || !file.id) return;
  if (attachmentPreviewEmailId === email.id && attachmentPreviewFileId === file.id && $("attachment-preview")?.open) return;
  const gen = ++attachmentPreviewToken;
  if (attachmentPreviewAbort) {
    attachmentPreviewAbort.abort();
    attachmentPreviewAbort = null;
  }
  cancelAttachmentTask(attachmentPreviewRequest);
  const controller = new AbortController();
  attachmentPreviewAbort = controller;
  attachmentPreviewEmailId = email && email.id ? email.id : "";
  attachmentPreviewFileId = file.id;
  showAttachmentPreviewShell(file, kind);
  const label = file.filename || "attachment";
  let data;
  try {
    attachmentPreviewRequest = startAttachmentTask("mail:fetchAttachmentBytes", email, [file], "Preview");
    data = await attachmentPreviewRequest.promise;
  } catch (error) {
    if (gen !== attachmentPreviewToken) return;
    attachmentPreviewFileId = "";
    const message = error instanceof Error ? error.message : String(error);
    if (message === "cancelled") {
      const status = $("attachment-preview-status");
      if (status) { status.hidden = false; status.textContent = "Preview cancelled."; }
      return;
    }
    const status = $("attachment-preview-status");
    if (status) {
      status.hidden = false;
      status.textContent = message;
    }
    throw error;
  }
  if (gen !== attachmentPreviewToken) return;
  const bytes = attachmentBytes(data);
  const status = $("attachment-preview-status");
  if (!bytes.byteLength) {
    if (status) {
      status.hidden = false;
      status.textContent = "This file is empty.";
    }
    return;
  }
  if (kind === "image") {
    const url = URL.createObjectURL(new Blob([bytes], { type: previewMime(file, kind) }));
    rememberPreviewUrl(url);
    if (gen !== attachmentPreviewToken) {
      if (attachmentPreviewUrl === url) revokeAttachmentPreviewUrl();
      return;
    }
    const img = $("attachment-preview-image");
    if (!img) return;
    img.alt = label;
    img.onload = () => {
      if (gen !== attachmentPreviewToken) return;
      img.hidden = false;
      if (status) status.hidden = true;
    };
    img.onerror = () => {
      if (gen !== attachmentPreviewToken) return;
      attachmentPreviewFileId = "";
      img.hidden = true;
      if (status) {
        status.hidden = false;
        status.textContent = "This image could not be previewed. Save or Open it instead.";
      }
    };
    img.src = url;
    return;
  }
  if (gen !== attachmentPreviewToken) return;
  rememberPreviewUrl("");
  const pages = $("attachment-preview-pages");
  const stage = $("attachment-preview-stage");
  if (!pages || !stage) return;
  pages.hidden = false;
  if (status) { status.hidden = false; status.textContent = "Rendering PDF…"; }
  try {
    const pdfApi = await loadPdfPreview();
    if (gen !== attachmentPreviewToken || controller.signal.aborted) return;
    await pdfApi.render({
      data: bytes,
      pages,
      stage,
      signal: controller.signal,
      onFirstPage() {
        if (gen !== attachmentPreviewToken) return;
        if (status) status.hidden = true;
      },
    });
  } catch (error) {
    if (gen !== attachmentPreviewToken || controller.signal.aborted) return;
    attachmentPreviewFileId = "";
    const message = pdfPreviewError(error);
    if (!message || !status) return;
    status.hidden = false;
    status.textContent = message;
  }
}

async function saveAttachmentsZip(email, files) {
  const attachmentIds = (files || []).map((file) => file && file.id).filter(Boolean);
  if (!attachmentIds.length) return;
  try {
    await startAttachmentTask("mail:downloadAttachmentsZip", email, files, "Save ZIP").promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "cancelled") return;
    throw error;
  }
  showStatus("Saved all attachments.");
}

function renderAttachments(pane, email) {
  const files = (email.attachments || []).filter((item) => item && (item.filename || item.id));
  if (!files.length && !email.hasAttachments) return;
  const card = document.createElement("section");
  card.className = "attachment-card";
  card.setAttribute("aria-label", "Attachments");
  const head = document.createElement("div");
  head.className = "attachment-card-head";
  const title = document.createElement("h3");
  title.appendChild(attachmentIcon("paperclip"));
  const titleText = document.createElement("span");
  titleText.textContent = "Attachments";
  title.appendChild(titleText);
  if (files.length) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(files.length);
    title.appendChild(count);
  }
  head.appendChild(title);
  if (files.some((file) => file.id)) {
    const zip = document.createElement("button");
    zip.type = "button";
    zip.className = "attachment-zip";
    zip.appendChild(attachmentIcon("download"));
    const zipLabel = document.createElement("span");
    zipLabel.textContent = "Save as ZIP";
    zip.appendChild(zipLabel);
    zip.setAttribute("aria-label", "Save all attachments as ZIP");
    zip.addEventListener("click", () => attachmentAction(() => saveAttachmentsZip(email, files)));
    head.appendChild(zip);
  }
  card.appendChild(head);
  if (!files.length) {
    const note = document.createElement("p");
    note.className = "attachment-note";
    note.textContent = "This message has attachments.";
    card.appendChild(note);
    pane.appendChild(card);
    return;
  }
  const list = document.createElement("ul");
  list.className = "attachments";
  for (const file of files) {
    const item = document.createElement("li");
    const main = document.createElement("div");
    main.className = "attachment-main";
    const size = fileSize(file.size);
    const label = file.filename || "attachment";
    const kind = file.id ? attachmentPreviewKind(file) : "";
    const name = document.createElement(kind ? "button" : "span");
    name.className = "attachment-name";
    name.textContent = label;
    name.title = label;
    if (kind) {
      name.type = "button";
      name.setAttribute("aria-label", "Preview " + label);
      name.addEventListener("click", () => attachmentAction(() => previewAttachment(email, file)));
    }
    main.appendChild(name);
    if (size) {
      const sizeNode = document.createElement("span");
      sizeNode.className = "attachment-size";
      sizeNode.textContent = size;
      main.appendChild(sizeNode);
    }
    item.appendChild(main);
    if (file.id) {
      const actions = document.createElement("div");
      actions.className = "attachment-actions";
      if (kind) actions.appendChild(attachmentGhost("Preview", "Preview " + label, () => attachmentAction(() => previewAttachment(email, file))));
      actions.appendChild(attachmentGhost("Save", "Save " + label, () => attachmentAction(() => useAttachment("mail:downloadAttachment", email, file))));
      actions.appendChild(attachmentGhost("Open", "Open " + label, () => attachmentAction(() => useAttachment("mail:openAttachmentExternally", email, file))));
      item.appendChild(actions);
    }
    list.appendChild(item);
  }
  card.appendChild(list);
  pane.appendChild(card);
}

async function useAttachment(channel, email, file) {
  try {
    await startAttachmentTask(channel, email, [file], channel === "mail:downloadAttachment" ? "Save" : "Open").promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "cancelled") return;
    throw error;
  }
  showStatus(channel === "mail:downloadAttachment" ? "Saved." : "Opened.");
}

function clearReadUndoTimer() {
  if (!readUndoTimer) return;
  clearTimeout(readUndoTimer);
  readUndoTimer = 0;
}

function removalAction(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("trash")) return "trash";
  if (text.includes("archive")) return "archive";
  return "move";
}

function destinationFor(action, explicit) {
  if (explicit) return String(explicit);
  if (action === "archive") return "Archive";
  if (action === "trash") return "Trash";
  return "";
}

function emailById(id) {
  if (id == null || id === "") return null;
  const key = String(id);
  const lists = [state.emails, state.thread];
  if (state.email) lists.push([state.email]);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const found = list.find((row) => row && String(row.id) === key);
    if (found) return found;
  }
  return null;
}

function rememberUndoSnapshots(messages, action, destinationLabel) {
  const dest = destinationFor(action, destinationLabel);
  for (const email of messages || []) {
    if (!email || email.id == null || email.id === "") continue;
    undoSnapshots.set(String(email.id), {
      messageId: String(email.id),
      accountId: email.accountId || "",
      subject: email.subject || "(No subject)",
      from: email.from || email.fromAddress || "",
      action: action || "move",
      destinationLabel: dest,
    });
  }
}

function snapshotEmails(ids, extra) {
  const out = [];
  const seen = new Set();
  const add = (email) => {
    if (!email || email.id == null || email.id === "") return;
    const key = String(email.id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(email);
  };
  for (const email of (extra && extra.messages) || []) add(email);
  for (const id of ids || []) add(emailById(id));
  return out;
}

function normalizeUndoItem(item) {
  const source = item || {};
  const snap = source.messageId ? undoSnapshots.get(String(source.messageId)) : null;
  const action = source.action || (snap && snap.action) || "move";
  return {
    opId: source.opId,
    messageId: source.messageId || (snap && snap.messageId) || "",
    accountId: source.accountId || (snap && snap.accountId) || "",
    subject: source.subject || (snap && snap.subject) || "(No subject)",
    from: source.from || (snap && snap.from) || "",
    action,
    destinationLabel: source.destinationLabel || (snap && snap.destinationLabel) || destinationFor(action, ""),
  };
}

function undoListFor(opIds, items) {
  if (!opIds) return null;
  const byOp = new Map();
  const source = Array.isArray(items) ? items : (undoItems || []);
  for (const item of source) {
    if (item && item.opId) byOp.set(item.opId, item);
  }
  return opIds.map((opId) => normalizeUndoItem(byOp.get(opId) || { opId }));
}

function undoItemsForOutcomes(outcome) {
  const items = [];
  const seen = new Set();
  for (const row of (outcome && outcome.outcomes) || []) {
    if (!row || row.status !== "completed" || !row.opId || seen.has(row.opId)) continue;
    if (row.kind && row.kind !== "remove") continue;
    seen.add(row.opId);
    const snap = undoSnapshots.get(String(row.id)) || {};
    items.push(normalizeUndoItem({
      opId: row.opId,
      messageId: row.id || snap.messageId || "",
      accountId: snap.accountId || "",
      subject: snap.subject || "",
      from: snap.from || "",
      action: snap.action || "",
      destinationLabel: snap.destinationLabel || "",
    }));
  }
  return items;
}

function undoRetriesByEpoch(batch) {
  const live = [];
  const stale = [];
  for (const item of undoRetryItems(batch)) {
    if (undoEpochByOp.get(item.opId) === undoEpoch) live.push(item);
    else stale.push(item);
  }
  return { live, stale };
}

function rememberUndoEpoch(opIds) {
  for (const id of opIds || []) {
    if (id && !undoEpochByOp.has(id)) undoEpochByOp.set(id, undoEpoch);
  }
}

function startRemovalSession(text, opIds, isError, items) {
  undoEpoch += 1;
  undoInflight = null;
  undoPending.clear();
  showUndo(text, opIds, isError, items);
}

function beginRemovalRequest(messages, action, destinationLabel) {
  rememberUndoSnapshots(messages, action, destinationLabel);
  startRemovalSession("Applying mailbox changes…", [], false, []);
  for (const message of messages || []) {
    if (message?.id) removalEpochByMessage.set(String(message.id), { epoch: undoEpoch, generation: (actionGeneration.get(message.id) || 0) + 1 });
  }
  return undoEpoch;
}

function rememberRemovalReceipt(data, epoch) {
  if (epoch == null) return;
  for (const row of [...(data?.pending || []), ...(data?.outcomes || [])]) {
    if (row.actionId) removalEpochByAction.set(row.actionId, epoch);
    if (row.opId) undoEpochByOp.set(row.opId, epoch);
  }
}

function removalSettlementEpoch(row) {
  if (row.actionId && removalEpochByAction.has(row.actionId)) return removalEpochByAction.get(row.actionId);
  if (row.opId && undoEpochByOp.has(row.opId)) return undoEpochByOp.get(row.opId);
  if (row.kind !== "remove") return undefined;
  const request = removalEpochByMessage.get(String(row.id));
  if (request && (typeof row.generation !== "number" || row.generation >= request.generation)) return request.epoch;
  if (request) return -1;
  return undefined;
}

function showRemovalUndo(text, opIds, isError, items) {
  const ids = opIds || [];
  const sameEpoch = ids.length > 0 && ids.every((id) => undoEpochByOp.get(id) === undoEpoch);
  if (sameEpoch) showUndo(text, ids, isError, items);
  else startRemovalSession(text, ids, isError, items);
}

function inflightUndoRow(row) {
  if (!undoInflight || !row) return false;
  if (row.retryOpId) return undoInflight.opIds.has(row.retryOpId);
  const requested = row.id != null && undoInflight.messages.get(String(row.id));
  return row.kind === "undo" && requested && undoInflight.opIds.has(requested.opId)
    && (typeof row.generation !== "number" || row.generation > requested.generation);
}

function settleUndoInflight(batch) {
  if (!undoInflight || undoInflight.epoch !== undoEpoch) return false;
  const rows = ((batch && batch.outcomes) || []).filter(inflightUndoRow);
  if (!rows.length) return false;
  const requested = [...undoInflight.opIds];
  const retained = new Set(retainedUndoOpIds(requested, rows, undoItems));
  const resolved = new Set();
  for (const row of rows) {
    const opId = row.retryOpId || ((undoItems || []).find((item) => item && String(item.messageId) === String(row.id)) || {}).opId;
    if (opId && undoInflight.opIds.has(opId)) resolved.add(opId);
  }
  for (const id of resolved) undoPending.delete(id);
  for (const id of resolved) undoInflight.opIds.delete(id);
  if (!undoInflight.opIds.size) undoInflight = null;
  else undoInflight.settled = true;
  const kept = (undoItems || []).filter((item) => !requested.includes(item.opId) || retained.has(item.opId));
  const receipt = receiptText("Restore", { outcomes: rows });
  const incomplete = rows.some((row) => row && row.status !== "completed");
  if (!kept.length) {
    clearUndo();
    showStatus(receipt, incomplete);
  } else {
    undoKind = "removal";
    undoOpIds = kept.map((item) => item.opId);
    undoItems = kept;
    undoReceiptError = undoReceiptError || incomplete;
    paintUndoControls();
    showStatus(receipt, incomplete);
  }
  return true;
}

function applyRemovalSettlement(batch, receipt, bad) {
  if (batch?.outcomes) {
    const outcomes = batch.outcomes.filter((row) => {
      const epoch = removalSettlementEpoch(row);
      return epoch == null || epoch === undoEpoch;
    });
    if (!outcomes.length && batch.outcomes.length) return;
    if (outcomes.length !== batch.outcomes.length) batch = { ...batch, outcomes,
      opIds: outcomes.flatMap((row) => row.retryOpId ? [row.retryOpId] : row.status === "completed" && row.opId ? [row.opId] : []) };
  }
  if (!batch || !Array.isArray(batch.opIds) || !batch.opIds.length) {
    if (bad) showStatus(receipt, true);
    return;
  }
  const current = $("status") && $("status").textContent;
  const text = bad || !current ? receipt : current;
  const { live } = undoRetriesByEpoch(batch);
  if (live.length && undoKind === "removal" && undoOpIds && undoOpIds.length) {
    const merged = (undoItems || []).slice();
    const have = new Set(merged.map((item) => item.opId));
    for (const item of live) if (!have.has(item.opId)) merged.push(item);
    showUndo(text, merged.map((item) => item.opId), true, merged);
  } else if (live.length) {
    showUndo(text, live.map((item) => item.opId), true, live);
  } else {
    const built = undoItemsForOutcomes(batch);
    if (batch.outcomes?.some((row) => removalSettlementEpoch(row) === undoEpoch)) {
      const merged = new Map((undoItems || []).map((item) => [item.opId, item]));
      for (const item of built) merged.set(item.opId, item);
      for (const id of batch.opIds) if (!merged.has(id)) merged.set(id, normalizeUndoItem({ opId: id }));
      showUndo(text, [...merged.keys()], bad, [...merged.values()]);
    } else showRemovalUndo(text, batch.opIds, bad, built.length ? built : undefined);
  }
}

function flushUndoSettleQueue() {
  const queued = undoSettleQueue.splice(0);
  for (const batch of queued) applyActionSettlement(batch);
}

function undoRetryItems(batch) {
  const items = [];
  const seen = new Set();
  for (const row of (batch && batch.outcomes) || []) {
    if (!row || !row.retryOpId || seen.has(row.retryOpId)) continue;
    if (row.kind && row.kind !== "undo") continue;
    seen.add(row.retryOpId);
    const prior = (undoItems || []).find((item) => item && item.opId === row.retryOpId);
    if (prior) {
      items.push(prior);
      continue;
    }
    const snap = undoSnapshots.get(String(row.id)) || {};
    items.push(normalizeUndoItem({
      opId: row.retryOpId,
      messageId: snap.messageId || "",
      accountId: snap.accountId || "",
      subject: snap.subject || "",
      from: snap.from || "",
      action: snap.action || "",
      destinationLabel: snap.destinationLabel || "",
    }));
  }
  return items;
}

function rememberUndoItems(items) {
  for (const item of items || []) {
    if (!item || !item.messageId) continue;
    undoSnapshots.set(String(item.messageId), {
      messageId: String(item.messageId),
      accountId: item.accountId || "",
      subject: item.subject || "(No subject)",
      from: item.from || "",
      action: item.action || "move",
      destinationLabel: item.destinationLabel || "",
    });
  }
}

function undoPopoverOpen() {
  const pop = $("undo-details-popover");
  return !!(pop && pop.hidden === false);
}

function eventInsideUndoDetails(event) {
  const target = event && event.target;
  if (!target || !target.nodeType) return false;
  const pop = $("undo-details-popover");
  const button = $("undo-details");
  if (pop && typeof pop.contains === "function" && pop.contains(target)) return true;
  if (button && typeof button.contains === "function" && button.contains(target)) return true;
  return target === button;
}

function closeUndoDetails(restoreFocus) {
  const pop = $("undo-details-popover");
  const hadFocus = !!pop?.contains?.(document.activeElement);
  if (pop) pop.hidden = true;
  const button = $("undo-details");
  if (!button) return;
  if (typeof button.setAttribute === "function") button.setAttribute("aria-expanded", "false");
  if (restoreFocus || hadFocus) {
    const target = undoKind === "removal" && undoOpIds?.length && !button.hidden && !undoBusy && !undoPending.size
      ? button : $("status-chip");
    if (target && !target.hidden && typeof target.focus === "function") target.focus();
  }
  scheduleStatusCollapse();
}

function paintUndoSelectedCount() {
  const button = $("undo-details-selected");
  const list = $("undo-details-list");
  if (!button) return;
  const boxes = list && typeof list.querySelectorAll === "function" ? list.querySelectorAll('input[type="checkbox"]') : [];
  let count = 0;
  for (const box of boxes) if (box.checked && !box.disabled) count += 1;
  button.textContent = "Undo selected (" + count + ")";
  button.disabled = count === 0 || !!undoBusy || undoPending.size > 0;
}

function paintUndoDetails() {
  const list = $("undo-details-list");
  if (!list || typeof list.replaceChildren !== "function" || typeof document.createElement !== "function") return;
  const checked = new Set(selectedUndoOpIds());
  const focused = list.contains(document.activeElement) ? document.activeElement.value : null;
  const scrollTop = list.scrollTop;
  const multipleAccounts = new Set((undoItems || []).map((item) => item.accountId).filter(Boolean)).size > 1;
  list.replaceChildren();
  for (const [index, item] of (undoItems || []).entries()) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = item.opId;
    box.disabled = undoPending.has(item.opId);
    box.checked = checked.has(item.opId) && !box.disabled;
    box.setAttribute("aria-label", item.subject || "(No subject)");
    box.addEventListener("change", paintUndoSelectedCount);
    const text = document.createElement("span");
    text.className = "undo-details-copy";
    const subject = document.createElement("span");
    subject.className = "undo-details-subject";
    subject.textContent = item.subject || "(No subject)";
    const meta = document.createElement("span");
    meta.className = "undo-details-meta";
    meta.id = "undo-details-meta-" + index;
    box.setAttribute("aria-describedby", meta.id);
    const action = item.action || "move";
    const where = item.destinationLabel ? " → " + item.destinationLabel : "";
    const account = multipleAccounts && state.accounts.find((row) => row.id === item.accountId);
    const mailbox = multipleAccounts ? accountLabel({ ...account, id: "" }) || "Unavailable mailbox" : "";
    meta.textContent = [mailbox, item.from, action + where].filter(Boolean).join(" · ");
    text.append(subject, meta);
    label.append(box, text);
    li.appendChild(label);
    list.appendChild(li);
    if (focused === item.opId) box.focus({ preventScroll: true });
  }
  list.scrollTop = scrollTop;
  paintUndoSelectedCount();
}

function setUndoDetailChecks(on) {
  const list = $("undo-details-list");
  if (!list || typeof list.querySelectorAll !== "function") return;
  for (const box of list.querySelectorAll('input[type="checkbox"]')) box.checked = !!on && !box.disabled;
  paintUndoSelectedCount();
}

function selectedUndoOpIds() {
  const list = $("undo-details-list");
  if (!list || typeof list.querySelectorAll !== "function") return [];
  const ids = [];
  for (const box of list.querySelectorAll('input[type="checkbox"]')) {
    if (box.checked && !box.disabled && box.value) ids.push(box.value);
  }
  return ids;
}

function openUndoDetails() {
  if (undoBusy || undoPending.size || undoKind !== "removal" || !undoOpIds || !undoOpIds.length) return;
  const pop = $("undo-details-popover");
  if (!pop) return;
  if (pop.hidden === false) {
    closeUndoDetails(true);
    return;
  }
  paintUndoDetails();
  pop.hidden = false;
  clearStatusTimer();
  const button = $("undo-details");
  if (button && typeof button.setAttribute === "function") button.setAttribute("aria-expanded", "true");
  const first = typeof pop.querySelector === "function" ? pop.querySelector("button, input") : null;
  if (first && typeof first.focus === "function") first.focus();
}

function paintUndoControls() {
  const undo = $("undo");
  const details = $("undo-details");
  const count = undoKind === "removal" && undoOpIds ? undoOpIds.length : 0;
  const pending = undoPending.size > 0;
  if (undo && undoKind === "removal") {
    undo.hidden = !count;
    undo.disabled = !!undoBusy || pending;
    undo.setAttribute?.("aria-busy", undoBusy || pending ? "true" : "false");
    undo.textContent = pending ? "Restoring " + undoPending.size + " changes…" : "Undo " + count + " completed changes";
  }
  if (details) {
    details.hidden = !count;
    details.disabled = !!undoBusy || pending || !count;
    if (!count && typeof details.setAttribute === "function") details.setAttribute("aria-expanded", "false");
  }
  if (!count || undoBusy || pending) closeUndoDetails(false);
  else if (undoPopoverOpen()) paintUndoDetails();
}

function showUndo(text, opIds, isError, items) {
  clearReadUndoTimer();
  const nextIds = opIds && opIds.length ? opIds.slice() : null;
  if (undoKind !== "removal" || undoDetailsEpoch !== undoEpoch) {
    closeUndoDetails(false);
    $("undo-details-list")?.replaceChildren?.();
  }
  undoDetailsEpoch = undoEpoch;
  undoKind = "removal";
  readUndoItems = null;
  undoReceipt = text;
  undoReceiptError = !!isError;
  undoOpIds = nextIds;
  undoItems = undoListFor(nextIds, items);
  rememberUndoEpoch(nextIds);
  rememberUndoItems(undoItems);
  paintUndoControls();
  showStatus(text, isError);
}

function showReadUndo(text, items) {
  if (undoKind === "removal" && undoOpIds && undoOpIds.length) {
    showStatus(text);
    return;
  }
  clearReadUndoTimer();
  undoKind = "read";
  closeUndoDetails(false);
  undoOpIds = null;
  undoItems = null;
  readUndoItems = (items || []).slice();
  undoReceipt = text || "";
  undoReceiptError = false;
  const undo = $("undo");
  if (undo) {
    undo.hidden = !readUndoItems.length;
    undo.disabled = false;
    undo.setAttribute?.("aria-busy", "false");
    undo.textContent = "Undo";
  }
  const details = $("undo-details");
  if (details) {
    details.hidden = true;
    details.disabled = false;
  }
  showStatus(text);
  readUndoTimer = armStatusTimer(() => {
    readUndoTimer = 0;
    if (undoKind === "read") clearUndo();
  }, STATUS_SUCCESS_DWELL_MS);
}

function clearUndo() {
  clearReadUndoTimer();
  undoKind = "";
  undoOpIds = null;
  undoItems = null;
  undoPending.clear();
  undoInflight = null;
  readUndoItems = null;
  undoReceipt = "";
  undoReceiptError = false;
  closeUndoDetails(false);
  const undo = $("undo");
  if (undo) {
    if (document.activeElement === undo) $("status-chip")?.focus?.();
    undo.hidden = true;
    undo.disabled = false;
    undo.setAttribute?.("aria-busy", "false");
  }
  const details = $("undo-details");
  if (details) {
    if (document.activeElement === details) $("status-chip")?.focus?.();
    details.hidden = true;
    details.disabled = false;
    if (typeof details.setAttribute === "function") details.setAttribute("aria-expanded", "false");
  }
}

function focusAction(name) {
  const control = $("reader").querySelector(`[data-action="${name}"]`);
  if (control) control.focus();
}

function eachStarRow(email, visit) {
  const id = email && email.id;
  if (!id) return;
  visit(email);
  for (const row of state.emails || []) {
    if (row && row.id === id && row !== email) visit(row);
  }
  if (state.email && state.email.id === id && state.email !== email) visit(state.email);
  for (const row of state.thread || []) {
    if (row && row.id === id && row !== email) visit(row);
  }
}

let openViewReload = false;
async function settleOpenView() {
  // check-mail-reader evals setRead without these helpers. typeof does not throw when the binding is absent.
  if (typeof selectedFolderNode !== "function" || typeof loadList !== "function") return;
  if (openViewReload) return;
  const folder = selectedFolderNode();
  if (!folder || !folder.view) return;
  openViewReload = true;
  try {
    await loadList(false);
  } finally {
    openViewReload = false;
  }
}

function paintStars(emails, isStarred, focus) {
  const ids = new Set();
  for (const email of emails || []) {
    if (!email || !email.id) continue;
    ids.add(email.id);
    eachStarRow(email, (row) => {
      row.isStarred = !!isStarred;
    });
  }
  renderList();
  if (state.email && ids.has(state.email.id)) {
    renderReader(false);
    if (focus) focusAction("star");
  }
}

const actionGeneration = new Map();

function rememberActionGeneration(rows) {
  for (const row of rows || []) {
    if (!row || typeof row.generation !== "number" || !row.id) continue;
    if ((actionGeneration.get(row.id) || 0) <= row.generation) actionGeneration.set(row.id, row.generation);
  }
}

function takeEmails(rows) {
  const previous = new Map((state.emails || []).map((row) => [row.id, row]));
  return (rows || []).map((row) => {
    const prior = previous.get(row && row.id);
    const memory = row && actionGeneration.get(row.id) || 0;
    const incoming = row && row.actionGeneration || 0;
    if (prior && memory > incoming) {
      return Object.assign({}, row, {
        isStarred: prior.isStarred,
        unread: prior.unread,
        isRead: prior.isRead,
        folderId: prior.folderId,
        actionGeneration: memory,
      });
    }
    return row;
  });
}

function applyActionSettlement(batch) {
  const outcomes = batch && Array.isArray(batch.outcomes) ? batch.outcomes : [];
  let moved = false;
  for (const outcome of outcomes) {
    if (!outcome || !outcome.id) continue;
    if (typeof settleAgentReadOutcome === "function") settleAgentReadOutcome(outcome).catch((error) => showStatus(error.message || String(error), true));
    const memory = actionGeneration.get(outcome.id) || 0;
    if (typeof outcome.generation === "number" && outcome.generation < memory) continue;
    if (typeof outcome.generation === "number") actionGeneration.set(outcome.id, outcome.generation);
    const projection = outcome.projection;
    if (projection && typeof paintAgentReadProjection === "function") paintAgentReadProjection(outcome.id, !!projection.unread);
    if ((outcome.status === "failed" || outcome.status === "not_attempted") && projection) {
      eachStarRow({ id: outcome.id }, (row) => {
        row.unread = !!projection.unread;
        row.isRead = !projection.unread;
        if (projection.folderId) row.folderId = projection.folderId;
      });
      paintStars([{ id: outcome.id }], !!projection.isStarred);
    }
    if (outcome.kind === "remove" || outcome.kind === "undo") moved = true;
  }
  const bad = outcomes.some((row) => row.status && row.status !== "completed");
  const receipt = receiptText("Mailbox", { outcomes });
  if (settleUndoInflight(batch)) {
    if (moved) loadList(false).catch(() => {});
    return;
  }
  const retrySplit = undoRetriesByEpoch(batch);
  // A retry from an older removal must not join or revive the current session.
  if (retrySplit.stale.length && !retrySplit.live.length) {
    if (bad && !undoBusy) showStatus(receipt, true);
    if (moved) loadList(false).catch(() => {});
    return;
  }
  if (undoBusy) {
    undoSettleQueue.push(batch);
    if (moved) loadList(false).catch(() => {});
    return;
  }
  applyRemovalSettlement(batch, receipt, bad);
  if (moved) loadList(false).catch(() => {});
}

async function toggleStar(email) {
  if (!email || !email.id) throw new Error("That message is no longer in the mailbox.");
  const next = !email.isStarred;
  const previous = !!email.isStarred;
  paintStars([email], next, true);
  let data;
  try {
    data = await call("mail:toggleStar", { emailId: email.id, accountId: email.accountId, isStarred: next });
    rememberActionGeneration(data && data.pending);
    rememberActionGeneration(data && data.outcomes);
  } catch (error) {
    paintStars([email], previous, true);
    throw error;
  }
  const rejected = data?.outcomes?.find((row) => row.status !== "completed");
  if (rejected) applyActionSettlement(data);
  if (rejected) throw new Error(rejected.error || "The mailbox did not confirm the star change. Refresh before retrying.");
  showStatus(next ? "Starred." : "Removed the star.");
  await settleOpenView();
}

const readWrites = new Map();
async function setRead(email, isRead) {
  const previousWrite = readWrites.get(email.id);
  if (previousWrite) {
    await previousWrite.catch(() => {});
    return setRead(email, isRead);
  }
  const previous = !!email.unread;
  const priorHold = state.unreadHold || null;
  // check-mail-reader evals setRead without the hold helpers.
  if (typeof applyUnreadHold === "function") {
    state.unreadHold = applyUnreadHold(priorHold, {
      kind: "mark",
      id: email.id,
      isRead: !!isRead,
      batch: false,
      mailList: state.view === "mail",
    });
  }
  const appliedHold = state.unreadHold;
  const paint = (unread) => {
    eachStarRow(email, (row) => { row.unread = unread; row.isRead = !unread; });
    renderList();
  };
  paint(!isRead);
  const write = call("mail:markRead", { emailId: email.id, accountId: email.accountId, isRead });
  readWrites.set(email.id, write);
  let data;
  try {
    data = await write;
    if (typeof rememberActionGeneration === "function") {
      rememberActionGeneration(data && data.pending);
      rememberActionGeneration(data && data.outcomes);
    }
  }
  catch (error) {
    if (typeof applyUnreadHold === "function" && state.unreadHold === appliedHold) state.unreadHold = priorHold;
    paint(previous);
    throw error;
  }
  finally { if (readWrites.get(email.id) === write) readWrites.delete(email.id); }
  const rejected = data?.outcomes?.find((row) => row.status !== "completed");
  if (rejected) {
    if (typeof applyActionSettlement === "function") applyActionSettlement(data);
    else if (rejected.projection) paint(!!rejected.projection.unread);
    if (typeof applyUnreadHold === "function" && state.unreadHold === appliedHold) state.unreadHold = priorHold;
    renderList();
    throw new Error(rejected.error || "The mailbox did not confirm the read change. Refresh before retrying.");
  }
  // Re-paint after success so a list reload during the network wait still gets the confirmed unread flag.
  paint(!isRead);
  await settleOpenView();
  return data;
}

async function deleteFromList(email) {
  const answer = await askConfirm(bulkConfirmCopy("trash", 1, { scope: selectionScopeCopy([email], [email]) }));
  if (!answer || !answer.ok) return;
  const epoch = beginRemovalRequest([email], "trash");
  await finishRemoval(email, "Move to Trash", await call("mail:delete", removalPayload(email, false)), undefined, epoch);
}

async function replyFromList(email, kind) {
  let opened = state.email && state.email.id === email.id ? state.email : null;
  if (!opened) {
    const data = await call("mail:openEmail", { emailId: email.id, full: true });
    opened = data && data.email;
  }
  if (!opened) throw new Error("That message is no longer in the mailbox.");
  const account = state.accounts.find((item) => item.id === opened.accountId) || selectedAccount();
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  await presentCompose(composeSeed(opened, kind, self));
}

async function finishRemoval(email, label, data, destinationLabel, epoch) {
  rememberRemovalReceipt(data, epoch);
  const outcomes = receiptRows(data, { params: { emailId: email.id } });
  return finishBulkRemoval(label, {
    outcomes,
    opIds: outcomes.filter((row) => row.status === "completed" && row.opId).map((row) => row.opId),
    error: outcomes.some((row) => row.status !== "completed") ? "Some changes could not be verified." : "",
    removalEpoch: epoch,
  }, [email.id], {
    messages: [email],
    action: removalAction(label),
    destinationLabel,
  });
}


async function removeOpen(email, channel, label) {
  const kind = channel === "mail:threadTrash" || channel === "mail:delete" ? "trash" : "archive";
  const review = await reviewedRemoval([withSelectionMembers(email)], kind);
  const answer = await askConfirm(bulkConfirmCopy(kind, review.rows.length, review.detail));
  if (!answer || !answer.ok) return;
  const epoch = beginRemovalRequest(review.rows, kind);
  await finishBulkRemoval(kind === "trash" ? "Move to Trash" : "Archive", await runBulk(review.calls, epoch), review.rows.map((row) => row.id), {
    messages: review.rows,
    action: kind === "trash" ? "trash" : "archive",
  });
}

async function archiveOpen(email) {
  const threaded = usesThread(email, state.thread);
  await removeOpen(email, threaded ? "mail:threadArchive" : "mail:archive", "Archived.");
}

async function trashOpen(email) {
  if (email && email.outbox) return;
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
  const epoch = beginRemovalRequest([email], "move", target);
  await finishRemoval(email, "Moved.", await call("mail:moveToFolder", {
    emailId: email.id,
    accountId: email.accountId,
    targetFolderId,
    folderId: email.folderId,
  }), target, epoch);
}

async function undoReadBatch() {
  const items = readUndoItems && readUndoItems.slice();
  if (undoKind !== "read" || !items || !items.length) return;
  clearUndo();
  try {
    const data = await call("mail:markReadBatch", {
      isRead: false,
      restoreRead: true,
      items: items.map((row) => ({ emailId: row.emailId, accountId: row.accountId, generation: row.generation })),
    });
    if (typeof rememberActionGeneration === "function") {
      rememberActionGeneration(data && data.pending);
      rememberActionGeneration(data && data.outcomes);
    }
    const restored = new Set();
    for (const row of (data && data.outcomes) || []) {
      if (row && row.id && row.status === "completed") restored.add(row.id);
    }
    for (const row of (data && data.pending) || []) {
      if (row && row.id) restored.add(row.id);
    }
    for (const messageId of restored) {
      const pending = agentPendingReads.get(String(messageId));
      if (pending) pending.item.unread = true;
      agentPendingReads.delete(String(messageId));
    }
    for (const section of agentSections(agentPaintPayload)) {
      for (const item of section.items || []) {
        if (!item || !restored.has(item.messageId)) continue;
        item.unread = true;
        agentMarkedRead.delete(String(item.messageId));
      }
    }
    if (restored.size && state.view === "agent" && agentPaintPayload) paintAgent(agentPaintPayload, "");
    showStatus(restored.size ? "Restored unread." : "Those messages changed later. Unread was left as it is.");
  } catch (error) {
    showStatus("Restore outcome is unknown. " + (error.message || String(error)) + " Refresh before retrying.", true);
  }
}

function retainedUndoOpIds(requested, outcomes, items) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  if (!rows.length) return requested.slice();
  const itemByMessage = new Map();
  for (const item of items || []) {
    if (item && item.opId && item.messageId) itemByMessage.set(String(item.messageId), item.opId);
  }
  const failed = new Set();
  const completed = new Set();
  for (const row of rows) {
    if (!row) continue;
    if (row.status === "completed") {
      if (row.id && itemByMessage.has(String(row.id))) completed.add(itemByMessage.get(String(row.id)));
      continue;
    }
    const opId = row.retryOpId
      || (row.id && itemByMessage.get(String(row.id)))
      || (requested.length === 1 ? requested[0] : "");
    if (opId) failed.add(opId);
  }
  // A settlement can cover only one account. Absence is not completion.
  if (failed.size) return requested.filter((opId) => failed.has(opId) || !completed.has(opId));
  const completedCount = rows.filter((row) => row && row.status === "completed").length;
  if (completedCount === rows.length && (completed.size === requested.length || (!completed.size && rows.length === requested.length) || requested.length === 1)) {
    return [];
  }
  if (completed.size) return requested.filter((opId) => !completed.has(opId));
  return requested.slice();
}

async function undoRemoval(requested) {
  if (undoBusy || undoPending.size) return;
  if (undoKind === "read") return undoReadBatch();
  const opIds = (Array.isArray(requested) && requested.length
    ? requested.filter((id) => (undoOpIds || []).includes(id))
    : (undoOpIds || []).slice()
  ).filter((id) => !undoPending.has(id));
  if (!opIds.length) return;
  const prior = undoReceipt || (($("status") && $("status").textContent) || "");
  const previousItems = (undoItems || []).slice();
  const previousError = undoReceiptError;
  const epoch = undoEpoch;
  const serial = ++undoFlightSerial;
  const messages = new Map();
  for (const item of previousItems) {
    if (item && opIds.includes(item.opId) && item.messageId) messages.set(String(item.messageId), {
      opId: item.opId, generation: actionGeneration.get(item.messageId) || 0,
    });
  }
  for (const id of opIds) undoPending.add(id);
  undoInflight = { epoch, serial, opIds: new Set(opIds), messages };
  undoBusy = true;
  closeUndoDetails(false);
  paintUndoControls();
  let applied = false;
  try {
    const data = await call("mail:undoRemoval", { opIds, kind: "move" });
    if (epoch !== undoEpoch) return;
    const stillPending = undoInflight && undoInflight.serial === serial && !undoInflight.settled;
    const hasOutcomes = !!(data && Array.isArray(data.outcomes));
    const outcomes = hasOutcomes ? data.outcomes : null;
    // An empty outcome list is still in flight. mail:actionsSettled decides which rows remain.
    if (stillPending && hasOutcomes && !outcomes.length) {
      applied = true;
      undoKind = "removal";
      undoOpIds = previousItems.map((item) => item.opId);
      undoItems = previousItems;
      undoReceipt = prior;
      undoReceiptError = previousError;
      paintUndoControls();
      showStatus(prior);
    } else if (stillPending && !hasOutcomes) {
      for (const id of opIds) undoPending.delete(id);
      undoInflight = null;
      applied = true;
      undoKind = "removal";
      undoOpIds = previousItems.map((item) => item.opId);
      undoItems = previousItems;
      undoReceipt = prior;
      undoReceiptError = true;
      paintUndoControls();
      showStatus(prior + " Restore outcome is unknown. Refresh before retrying.", true);
    } else if (stillPending) {
      for (const id of opIds) undoPending.delete(id);
      undoInflight = null;
      const failed = new Set(retainedUndoOpIds(opIds, outcomes, previousItems));
      const kept = previousItems.filter((item) => !opIds.includes(item.opId) || failed.has(item.opId));
      const receipt = receiptText("Restore", { outcomes });
      const incomplete = outcomes.some((row) => row && row.status !== "completed");
      applied = true;
      if (!kept.length) {
        clearUndo();
        showStatus(prior + " " + receipt, incomplete);
      } else {
        undoKind = "removal";
        undoOpIds = kept.map((item) => item.opId);
        undoItems = kept;
        undoReceipt = prior;
        undoReceiptError = previousError || incomplete;
        paintUndoControls();
        showStatus(receipt, incomplete);
      }
    } else applied = true;
    await loadList();
  } catch (error) {
    if (epoch !== undoEpoch) return;
    // A settlement can arrive before an IPC rejection. Never resurrect its rows.
    if (!applied && (!undoInflight || undoInflight.serial !== serial || undoInflight.settled)) return;
    if (!applied) {
      for (const id of opIds) undoPending.delete(id);
      if (undoInflight && undoInflight.serial === serial) undoInflight = null;
      undoKind = "removal";
      undoOpIds = previousItems.map((item) => item.opId);
      undoItems = previousItems;
      undoReceipt = prior;
      undoReceiptError = previousError;
      paintUndoControls();
    }
    const message = error && error.message ? error.message : String(error);
    showStatus(applied ? "Restore result received, but the message list could not refresh. " + message
      : prior + " Restore outcome is unknown. " + message + " Refresh before retrying.", true);
  } finally {
    undoBusy = false;
    flushUndoSettleQueue();
    paintUndoControls();
  }
}

async function undoSelected() {
  if (undoBusy) return;
  const ids = selectedUndoOpIds();
  if (!ids.length) return;
  await undoRemoval(ids);
}

async function snoozeOpen(email, preset) {
  const threadId = email.threadId || email.id;
  const snoozedUntil = snoozeUntil(preset, new Date()).toISOString();
  const data = await call("mail:snoozeThread", { accountId: email.accountId, threadId, snoozedUntil });
  state.snoozed.set(threadId, (data && data.snoozedUntil) || snoozedUntil);
  const when = new Date(state.snoozed.get(threadId));
  showStatus(Number.isNaN(when.getTime()) ? "Snoozed." : `Snoozed until ${shownWhen(when)}.`);
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
    if (state.accountId !== account.id) return;
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
  if (!state.accounts.length) {
    state.allInbox = false;
    state.allInboxUnreadOnly = false;
    state.outbox = false;
    state.outboxRows = [];
  }
  if (preferredId && state.accounts.some((account) => account.id === preferredId)) {
    if (state.accountId !== preferredId) {
      state.allInbox = false;
      state.allInboxUnreadOnly = false;
    }
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

function paintListPaging() {
  const pager = $("list-paging");
  if (!pager) return;
  pager.hidden = !!state.query || !!state.outbox || (!state.allInbox && (!state.accountId || !state.folderId));
  const end = state.listOffset + state.emails.length;
  $("list-prev").disabled = state.listLoading || state.listOffset === 0;
  $("list-next").disabled = state.listLoading || end >= state.listTotal;
  $("list-sync-more").hidden = !!state.outbox || state.allInbox || state.listSyncDone || selectedFolderNode()?.syncs === false;
  $("list-sync-more").disabled = state.listLoading || currentFolderSync()?.state === "syncing";
  $("list-page-status").textContent = state.listLoading ? "Loading messages…"
    : (state.emails.length ? `${(state.listOffset + 1).toLocaleString()}–${end.toLocaleString()} / ${state.listTotal.toLocaleString()} downloaded`
      : "0 downloaded");
}

async function changeListPage(direction) {
  if (state.listLoading || state.query) return;
  const offset = Math.max(0, state.listOffset + direction * LIST_PAGE_SIZE);
  if (direction > 0 && offset >= state.listTotal) return;
  const data = await loadList(false, offset);
  if (data) {
    state.selectedIds = [];
    state.selectionAnchor = "";
    renderList();
    $("message-list").scrollTop = 0;
  }
}

function changelogApi() {
  return typeof morrowChangelog === "object" && morrowChangelog ? morrowChangelog : null;
}

function acknowledgeChangelog() {
  const dialog = $("changelog");
  const version = dialog && dialog.dataset.version;
  if (!version || !api) return;
  delete dialog.dataset.version;
  api.invoke("morrow:configSetChangelogSeen", version).catch(() => {});
}

function paintChangelog(version, notes) {
  const dialog = $("changelog");
  const list = $("changelog-notes");
  const label = $("changelog-version");
  if (!dialog || !list || !label) return false;
  label.textContent = "Morrow Mail " + version;
  list.replaceChildren();
  for (const line of notes) {
    const item = document.createElement("li");
    item.textContent = line;
    list.appendChild(item);
  }
  dialog.dataset.version = version;
  return true;
}

async function offerChangelog() {
  if (changelogSettled || changelogPending || !api || !appVersion) return;
  const notesApi = changelogApi();
  if (!notesApi || typeof notesApi.shouldOffer !== "function" || typeof notesApi.notesFor !== "function") {
    changelogSettled = true;
    return;
  }
  if (document.querySelector("dialog[open]")) return;
  changelogPending = true;
  try {
    const seen = await api.invoke("morrow:configGetChangelogSeen");
    if (changelogSettled) return;
    if (!notesApi.shouldOffer({ version: appVersion, seen: seen, listOk: true })) {
      changelogSettled = true;
      return;
    }
    const notes = notesApi.notesFor(appVersion);
    if (!notes.length || !paintChangelog(appVersion, notes)) return;
    if (document.querySelector("dialog[open]")) {
      delete $("changelog").dataset.version;
      return;
    }
    openDialog("changelog");
    const dialog = $("changelog");
    if (!dialog || !dialog.open) {
      if (dialog) delete dialog.dataset.version;
      return;
    }
    changelogSettled = true;
  } catch {
    // A failed settings read is not an acknowledgement.
  } finally {
    changelogPending = false;
  }
}

function noteMailListLoaded(gen) {
  // A thrown list load never reaches this. Failure must not cover the shell.
  if (gen !== listGen) return;
  offerChangelog().catch(() => {});
}

async function loadList(fromNetwork, requestedOffset) {
  const gen = ++listGen;
  noteUnreadScope();
  const scope = JSON.stringify([state.allInbox, state.allInboxUnreadOnly, state.outbox, state.accountId, state.folderId, state.query, state.searchAccountId]);
  if (state.listScope !== scope) {
    state.listScope = scope;
    state.listOffset = 0;
    state.listTotal = 0;
  }
  state.listLoading = true;
  paintListPaging();
  try {
    if (state.outbox && !state.query) {
      state.emails = outboxEmails(state.outboxRows);
      state.listOffset = 0;
      state.listTotal = state.emails.length;
      state.listSyncDone = true;
      renderList();
      noteMailListLoaded(gen);
      return null;
    }
    if (state.query) {
      const data = await call("mail:searchLocal", { query: state.query, limit: 100, ...(state.searchAccountId ? { accountId: state.searchAccountId } : {}) });
      if (gen !== listGen) return null;
      state.emails = takeEmails(Array.isArray(data) ? data : []);
      renderList();
      noteMailListLoaded(gen);
      return null;
    }
    const account = selectedAccount();
    if (!state.allInbox && (!account || !state.folderId)) {
      state.emails = [];
      renderList();
      noteMailListLoaded(gen);
      return null;
    }
    let offset = requestedOffset == null ? state.listOffset : requestedOffset;
    const retainIds = unreadRetainIds();
    const request = mailListRequest({
      allInbox: state.allInbox,
      unreadOnly: state.allInbox && state.allInboxUnreadOnly,
      fromNetwork: !state.allInbox && fromNetwork && isLive(account),
      accountId: account && account.id,
      folderId: state.folderId,
      accounts: state.accounts,
      retainIds,
      limit: LIST_PAGE_SIZE,
      offset,
    });
    let data = await call(request.channel, request.params);
    if (gen !== listGen) return null;
    // Deleting the last page or provider changes can shrink the cached list.
    if (offset > 0 && Number.isFinite(data?.total) && offset >= data.total) {
      offset = Math.max(0, Math.ceil(data.total / LIST_PAGE_SIZE) - 1) * LIST_PAGE_SIZE;
      const again = mailListRequest({
        allInbox: state.allInbox,
        unreadOnly: state.allInbox && state.allInboxUnreadOnly,
        accountId: account && account.id,
        folderId: state.folderId,
        accounts: state.accounts,
        retainIds,
        limit: LIST_PAGE_SIZE,
        offset,
      });
      data = await call(again.channel, again.params);
      if (gen !== listGen) return null;
    }
    state.listOffset = offset;
    state.emails = takeEmails((data && data.emails) || []);
    if (unreadListActive(currentUnreadView())) {
      state.unreadHold = applyUnreadHold(state.unreadHold, {
        kind: "refresh",
        ids: state.emails.map((row) => row && row.id),
      });
    }
    state.listTotal = Number.isFinite(data?.total) ? data.total : offset + state.emails.length;
    state.listSyncDone = data?.initialSyncDone !== false;
    if (!state.allInbox && data && data.sync) rememberSyncStatus(Object.assign({ accountId: account.id }, data.sync));
    renderList();
    noteMailListLoaded(gen);
    return data;
  } finally {
    if (gen === listGen) { state.listLoading = false; paintListPaging(); }
  }
}

async function loadAccounts(preferredId) {
  const gen = ++accountGen;
  const data = await call("mail:listAccounts");
  if (gen !== accountGen) return;
  acceptBodyAccounts(Array.isArray(data) ? data : []);
  rememberSelection(preferredId);
  renderAccounts();
  paintBodySyncStatus();
  loadScheduled().catch(() => {});
  if (state.view === "calendar" && (calendarAccount()?.id || "") !== calendarPaintedAccountId) {
    loadCalendar({ preferCache: true }).catch(error => showStatus(error.message, true));
  }
  syncRemove();
  if (window.morrowBrainCompose && typeof window.morrowBrainCompose.sync === "function") window.morrowBrainCompose.sync();
  await loadSnoozed();
  if (gen !== accountGen) return;
  await loadList();
  if (gen !== accountGen) return;
  loadProviderFolders(gen);
  if (state.view === "folders") paintProviderPage();
  renderReader(false);
}

const providerFolderPending = new Map();
async function loadProviderFolders(gen) {
  const account = selectedAccount();
  if (!isLive(account)) {
    state.providerFolders = null;
    paintProviderPage();
    return;
  }
  const requestId = account.id;
  try {
    if (!providerFolderPending.has(requestId)) {
      const pending = call("mail:listProviderFolders", { accountId: requestId }).finally(() => providerFolderPending.delete(requestId));
      providerFolderPending.set(requestId, pending);
    }
    const payload = await providerFolderPending.get(requestId);
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
  if (state.view === "folders") paintProviderPage();
}

async function grantOrganize() {
  const account = selectedAccount();
  if (!isLive(account)) throw new Error("Connect a Google or Microsoft mailbox first.");
  showStatus("Waiting for mailbox feature permissions…");
  const provider = folderProvider(account) === "gmail" ? "gmail" : "outlook";
  try {
    const saved = await call("mail:grantOrganize", { accountId: account.id });
    const outcome = grantApiOutcome(saved, "Mail API connected.", providerCopy("scope_missing", provider));
    if (!outcome.ok) throw new Error(outcome.message);
    showStatus(outcome.message);
  } finally {
    await loadProviderFolders(accountGen);
  }
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
  const add = Array.isArray(addLabelIds) ? addLabelIds : [];
  const remove = Array.isArray(removeLabelIds) ? removeLabelIds : [];
  await call("mail:modifyMessageLabels", {
    accountId: email.accountId,
    emailId: email.id,
    addLabelIds: add,
    removeLabelIds: remove,
  });
  const text = add.length && remove.length
    ? "Labels updated in Gmail."
    : add.length
      ? "Label added in Gmail."
      : "Label removed in Gmail.";
  showStatus(text);
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
    nodes: moveNodesFromFolders("imap", storableFolders(foldersOf(account)), delimiter),
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

let labelSession = null;

function openLabelPicker(messages, bulk) {
  const requested = (Array.isArray(messages) ? messages : []).filter((email) => email && email.id);
  if (!requested.length) return;
  const accountId = requested[0].accountId;
  const rows = requested.filter((email) => email.accountId === accountId);
  const account = accountForMove(rows[0].accountId);
  const provider = folderProvider(account);
  const listed = account ? providerPayloadFor(account) : null;
  const view = providerFolderState(listed);
  if (provider === "outlook") {
    showStatus("Outlook moves the message instead of editing Gmail labels.", true);
    return;
  }
  if (provider !== "gmail") {
    showStatus("Labels stay on IMAP for this account.", true);
    return;
  }
  if (view.mode !== "live") {
    showStatus((listed && listed.message) || providerCopy(view.reason, "gmail"), true);
    return;
  }
  const labels = providerLabelTree(view.folders).filter((folder) => folder.editable);
  if (!labels.length) {
    showStatus("No Gmail labels to edit.", true);
    return;
  }
  const initial = labelCheckedState(rows, labels);
  labelSession = {
    messages: rows.slice(),
    labels: labels,
    initial: initial,
    next: new Map(initial),
    query: "",
    bulk: !!bulk,
    animated: false,
  };
  const source = $("label-picker-source");
  if (source) {
    source.textContent = bulk
      ? selectionScopeCopy(rows, selectedMessages())
      : (rows[0].subject || "(no subject)");
  }
  const filter = $("label-picker-filter");
  if (filter) filter.value = "";
  const title = $("label-picker-title");
  if (title) title.textContent = "Labels";
  paintLabelPicker();
  if (!$("label-picker").open) openDialog("label-picker");
  setTimeout(() => {
    const input = $("label-picker-filter");
    if (input && $("label-picker").open) input.focus();
  }, 0);
}

function paintLabelPicker() {
  const session = labelSession;
  const list = $("label-picker-list");
  const empty = $("label-picker-empty");
  if (!session || !list) return;
  list.replaceChildren();
  const shown = filterEditableLabels(session.labels, session.query);
  if (empty) empty.hidden = shown.length > 0;
  for (const folder of shown) {
    const id = String(folder.id);
    const mark = session.next.get(id) || "off";
    const row = document.createElement("label");
    row.className = "check label-row";
    row.style.paddingLeft = (8 + (folder.depth || 0) * 16) + "px";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = id;
    box.checked = mark === "on";
    if (mark === "mixed") box.title = "On some selected messages";
    box.addEventListener("change", () => {
      if (!labelSession) return;
      labelSession.next.set(id, box.checked ? "on" : "off");
      box.indeterminate = false;
      const note = row.querySelector(".label-mixed");
      if (note) note.hidden = true;
    });
    const text = document.createElement("span");
    text.textContent = folder.label || folder.name || folder.id;
    if (folder.name && folder.label && folder.name !== folder.label) text.title = folder.name;
    row.append(box, text);
    if (mark === "mixed") {
      const note = document.createElement("span");
      note.className = "label-mixed";
      note.textContent = "Some";
      row.appendChild(note);
    }
    list.appendChild(row);
    box.indeterminate = mark === "mixed";
  }
  if (!session.animated) {
    session.animated = true;
    const motion = motionApi();
    if (motion) motion.rows(list.querySelectorAll(".label-row"));
  }
}

function stampLabelIds(email, labels, addLabelIds, removeLabelIds) {
  if (!email || !email.id) return;
  const next = new Set(appliedEditableLabels(email, labels));
  for (const id of addLabelIds || []) next.add(String(id));
  for (const id of removeLabelIds || []) next.delete(String(id));
  const ids = [...next];
  const write = (row) => {
    if (row && String(row.id) === String(email.id)) row.labelIds = ids.slice();
  };
  write(email);
  for (const row of state.emails || []) write(row);
  write(state.email);
  for (const row of state.thread || []) write(row);
}

function closeLabelPicker() {
  labelSession = null;
  const dialog = $("label-picker");
  if (!dialog || !dialog.open) return Promise.resolve();
  return closeDialog("label-picker") || Promise.resolve();
}

function finishLabelPick() {
  const session = labelSession;
  if (!session) return;
  const snapshot = {
    plans: labelChangeForMessages(session.messages, session.labels, session.initial, session.next),
    labels: session.labels,
    bulk: !!session.bulk,
    messages: session.messages.slice(),
  };
  guard(async () => {
    await closeLabelPicker();
    if (!snapshot.plans.length) {
      showStatus("Labels are unchanged.");
      return;
    }
    await applyLabelPlans(snapshot);
  });
}

async function applyLabelPlans(snapshot) {
  const plans = snapshot.plans || [];
  if (!snapshot.bulk && plans.length === 1) {
    const plan = plans[0];
    await changeLabels(plan.email, plan.addLabelIds, plan.removeLabelIds);
    stampLabelIds(plan.email, snapshot.labels, plan.addLabelIds, plan.removeLabelIds);
    return;
  }
  const messages = plans.map((plan) => plan.email);
  if (refusePaused(messages)) return;
  let calls = labelEditCalls(plans);
  const removes = plans.some((plan) => (plan.removeLabelIds || []).some((id) => labelRemovesFromView(state.folderId, id)));
  const excluded = selectedMessages().length !== (snapshot.messages || []).length;
  if (removes || excluded) {
    const answer = await askConfirm(labelApplyConfirm(plans, snapshot.labels, selectionScopeCopy(messages, snapshot.messages)));
    if (!answer || !answer.ok) return;
    if (removes) calls = confirmedCalls("remove-label", answer, calls, { removesFromView: true });
  }
  if (!calls.length) return;
  const outcome = await runBulk(calls);
  const completed = new Set((outcome.outcomes || []).filter((row) => row.status === "completed").map((row) => String(row.id)));
  for (const plan of plans) {
    if (!completed.has(String(plan.email.id))) continue;
    stampLabelIds(plan.email, snapshot.labels, plan.addLabelIds, plan.removeLabelIds);
  }
  if (removes) await finishBulkRemoval("Labels", outcome, messages.map((row) => row.id), { messages, action: "move" });
  else showStatus(receiptText("Labels", outcome), !!outcome.error);
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
      openRelocatePicker("imap", folder, account, storableFolders(foldersOf(account)), accountDelimiter(account));
    });
  }
  placeMenu(menu, x, y);
}

function openAccountLabelMenu(account, x, y) {
  if (!account || !account.id) return;
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", "Account");
  menu.replaceChildren();
  appendMenuAction(menu, "Rename", () => {
    renameAccountLabel(account).catch((error) => showStatus(error.message, true));
  });
  placeMenu(menu, x, y);
}

async function renameAccountLabel(account) {
  if (!account || !account.id) return;
  const result = await askConfirm({
    title: "Rename account",
    body: "This name is the label in the account list. Clear it to use the provider name, or the address when the provider has none. The address and From stay the same.",
    confirm: "Save",
    cancel: "Cancel",
    needsName: true,
    allowEmpty: true,
    name: account.label || account.name || "",
    placeholder: "Name",
  });
  if (!result.ok) return;
  await call("mail:setAccountLabel", { accountId: account.id, label: result.name });
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
  if (provider === "gmail" && model.add.length) appendMenuAction(menu, "Labels…", () => openLabelPicker([email], false));
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
  if (kind === "virtual") {
    return {
      kind,
      id,
      type: "virtual",
      accountId: node.dataset.dropAccount || "",
      dropCopy: node.dataset.dropCopy || "",
    };
  }
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

function operationIds(spec) {
  const params = spec.params || {};
  return params.items ? params.items.map((item) => item.emailId || item.id) : (params.emailId ? [params.emailId] : []);
}

function receiptRows(data, spec) {
  const pending = data && Array.isArray(data.pending)
    ? data.pending.map((row) => ({ ...row, status: "completed", phase: "accepted" }))
    : [];
  if (data && Array.isArray(data.outcomes)) return [...pending, ...data.outcomes];
  const ids = operationIds(spec);
  // Legacy multi-message/thread responses do not establish per-message outcomes.
  const verified = ids.length === 1 && !spec.params.threadId && data != null;
  return ids.map((id) => ({ id, status: verified ? "completed" : "unknown" }));
}

function receiptText(label, outcome) {
  const rows = outcome.outcomes || [];
  const count = (status) => rows.filter((row) => row.status === status).length;
  const parts = [count("completed") + " completed", count("failed") + " failed", count("unknown") + " unknown", count("not_attempted") + " not attempted"];
  const errors = [...new Set(rows.map((row) => row.error).filter(Boolean))];
  if (outcome.error && !errors.includes(outcome.error)) errors.push(outcome.error);
  return label.replace(/[.]$/, "") + ": " + parts.join(" · ") + "." + (errors.length ? " " + errors.join(" ") : "")
    + (count("unknown") ? " Refresh before retrying unknown changes." : "");
}

async function runBulk(calls, removalEpoch) {
  const outcome = { opIds: [], outcomes: [], done: 0, paused: false, error: "" };
  if (removalEpoch != null) outcome.removalEpoch = removalEpoch;
  let stopped = false;
  for (const spec of calls) {
    if (stopped) {
      outcome.outcomes.push(...operationIds(spec).map((id) => ({ id, status: "not_attempted" })));
      continue;
    }
    let rows;
    try {
      const data = await call(spec.channel, spec.params);
      rememberRemovalReceipt(data, removalEpoch);
      rows = receiptRows(data, spec);
    } catch (error) {
      const message = error.message || String(error);
      rows = operationIds(spec).map((id) => ({ id, status: "unknown", error: message }));
      outcome.error = message;
    }
    outcome.outcomes.push(...rows);
    const unresolved = rows.find((row) => row.status !== "completed");
    if (unresolved) {
      stopped = true;
      outcome.error = unresolved.error || outcome.error || "Some changes could not be verified.";
    }
  }
  outcome.done = outcome.outcomes.filter((row) => row.status === "completed").length;
  outcome.opIds = outcome.outcomes.filter((row) => row.status === "completed" && row.opId).map((row) => row.opId);
  outcome.paused = /rate limit|rate_limit|\b429\b/i.test(outcome.error);
  return outcome;
}

async function finishBulkRemoval(label, outcome, ids, extra) {
  rememberActionGeneration(outcome.outcomes);
  const action = (extra && extra.action) || removalAction(label);
  rememberUndoSnapshots(snapshotEmails(ids, extra), action, extra && extra.destinationLabel);
  const completed = new Set((outcome.outcomes || []).filter((row) => row.status === "completed").map((row) => row.id));
  if (state.email && completed.has(state.email.id)) {
    state.email = null;
    state.thread = [];
    renderReader(false);
  }
  state.selectedIds = state.selectedIds.filter((id) => !completed.has(id));
  const text = receiptText(label, outcome);
  const waiting = (outcome.outcomes || []).some((row) => row.phase === "accepted");
  if (outcome.removalEpoch == null) startRemovalSession(text, [], !!outcome.error, []);
  const epoch = outcome.removalEpoch ?? undoEpoch;
  rememberRemovalReceipt(outcome, epoch);
  if (epoch === undoEpoch) {
    if (outcome.opIds.length) applyRemovalSettlement(outcome, text, !!outcome.error);
    else if (waiting || undoOpIds?.length) showStatus(text, !!outcome.error);
    else { clearUndo(); showStatus(text, !!outcome.error); }
  }
  if (completed.size) await loadList();
  else renderList();
}

async function bulkArchive() {
  const messages = selectedMessages().map(withSelectionMembers);
  if (!messages.length || refusePaused(messages)) return;
  const review = await reviewedRemoval(messages, "archive");
  const answer = await askConfirm(bulkConfirmCopy("archive", review.rows.length, review.detail));
  const gated = confirmedCalls("archive", answer, review.calls, review.detail);
  if (!gated.length) return;
  const outcome = await runBulk(gated, beginRemovalRequest(review.rows, "archive"));
  await finishBulkRemoval("Archive", outcome, review.rows.map((item) => item.id), {
    messages: review.rows,
    action: "archive",
  });
}

async function bulkTrash() {
  const messages = selectedMessages().map(withSelectionMembers);
  if (!messages.length || refusePaused(messages)) return;
  const review = await reviewedRemoval(messages, "trash");
  const answer = await askConfirm(bulkConfirmCopy("trash", review.rows.length, review.detail));
  const gated = confirmedCalls("trash", answer, review.calls, review.detail);
  if (!gated.length) return;
  const outcome = await runBulk(gated, beginRemovalRequest(review.rows, "trash"));
  await finishBulkRemoval("Move to Trash", outcome, review.rows.map((item) => item.id), {
    messages: review.rows,
    action: "trash",
  });
}

async function bulkSetRead(isRead) {
  const messages = selectedMessages();
  if (!messages.length || refusePaused(messages)) return;
  const priorHold = state.unreadHold || null;
  if (typeof applyUnreadHold === "function") {
    state.unreadHold = applyUnreadHold(priorHold, {
      kind: "mark",
      batch: true,
      isRead: !!isRead,
      selected: messages.map((row) => row && row.id),
    });
  }
  const previous = new Map(messages.map((email) => [email.id, !!email.unread]));
  for (const email of messages) {
    eachStarRow(email, (row) => { row.unread = !isRead; row.isRead = !!isRead; });
  }
  renderList();
  const outcome = await runBulk(bulkFlagCalls(messages, isRead ? "read" : "unread"));
  const completed = new Set(outcome.outcomes.filter((row) => row.status === "completed").map((row) => row.id));
  for (const email of messages) {
    if (completed.has(email.id)) continue;
    const unread = previous.get(email.id) === true;
    eachStarRow(email, (row) => { row.unread = unread; row.isRead = !unread; });
  }
  if (priorHold && priorHold.id && !completed.has(String(priorHold.id))) state.unreadHold = priorHold;
  renderList();
  renderReader(false);
  showStatus(receiptText(isRead ? "Mark read" : "Mark unread", outcome), !!outcome.error);
  if (completed.size) await settleOpenView();
}

async function bulkStar(isStarred) {
  const messages = selectedMessages();
  if (!messages.length || refusePaused(messages)) return;
  const previous = new Map(messages.map((email) => [email.id, !!email.isStarred]));
  paintStars(messages, isStarred);
  const outcome = await runBulk(bulkFlagCalls(messages, isStarred ? "star" : "unstar"));
  const completed = new Set(outcome.outcomes.filter((row) => row.status === "completed").map((row) => row.id));
  for (const email of messages) {
    if (completed.has(email.id)) continue;
    eachStarRow(email, (row) => {
      row.isStarred = previous.get(email.id) === true;
    });
  }
  renderList();
  renderReader(false);
  const failed = (outcome.outcomes || []).some((row) => row.status !== "completed");
  showStatus(receiptText(isStarred ? "Star" : "Unstar", outcome), !!(outcome.error || failed));
  if (completed.size) await settleOpenView();
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
    scope: selectionScopeCopy(rows.filter((row) => planned.some((spec) => operationIds(spec).includes(row.id))),
      rows.every((row) => state.selectedIds.includes(row.id)) ? selectedMessages() : rows),
  };
  let answer = { ok: true };
  if (bulkNeedsConfirm(action, detail) || detail.scope.includes("excluded")) {
    answer = await askConfirm(bulkConfirmCopy(action, callCount(planned), detail));
    if (!answer || !answer.ok) return;
  }
  const gated = confirmedCalls(action, answer, planned, detail);
  if (!gated.length) return;
  const outcome = await runBulk(gated, action === "add-label" ? undefined : beginRemovalRequest(rows, "move", name));
  const acted = [];
  for (const spec of gated) {
    if (spec.params && Array.isArray(spec.params.items)) {
      for (const item of spec.params.items) acted.push(item.emailId);
    } else if (spec.params && spec.params.emailId) acted.push(spec.params.emailId);
  }
  if (action === "add-label") {
    showStatus(receiptText("Add label", outcome), !!outcome.error);
    return;
  }
  const count = callCount(gated);
  const label = action === "move" ? "Move" : "Remove label";
  await finishBulkRemoval(label, outcome, acted, {
    messages: rows,
    action: "move",
    destinationLabel: name,
  });
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
  source.textContent = selectionScopeCopy(messages);
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
  if (provider === "gmail" && model.add.length) appendMenuAction(menu, "Labels…", () => openLabelPicker(messages, true));
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
  button.addEventListener("click", () => {
    if (run) guard(run);
  });
  return button;
}

function wireSelection() {
  $("filter-chip").addEventListener("click", () => { $("list-filter").value = ""; renderList(); });
  $("search-account").addEventListener("change", () => { state.searchAccountId = $("search-account").value; guard(applySearch); });
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
  const labels = selectionButton("selection-labels", "Labels", tag, () => openLabelPicker(selectionMoveMessages(), true));
  labels.hidden = true;
  labels.setAttribute("aria-haspopup", "dialog");
  labels.title = "Edit Gmail labels";
  bar.append(labels, selectionButton("selection-clear", "Clear", clear, () => commitSelection(clearListSelection())));
  const selectAll = $("select-visible");
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      const shown = shownEmails().map(email => email.id);
      const ids = selectAll.checked
        ? selectionIds(state.selectedIds.concat(shown))
        : state.selectedIds.filter(id => !shown.includes(id));
      commitSelection({ ids, anchor: ids[0] || "" });
    });
  }
}

function onSelectionKey(event) {
  const menu = $("organize-menu");
  const menuOpen = menu && !menu.hidden;
  if (event.key === "Escape") {
    if (menuOpen || document.querySelector("dialog[open]")) return;
    // Details is a role=dialog popover, not a <dialog>. Close it without clearing the mailbox selection.
    if (undoPopoverOpen()) return;
    if (event.target && typeof event.target.closest === "function" && event.target.closest("[role='dialog']")) return;
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

let dropTarget = null;
let dropTargetClass = "";
function clearDropTargets() {
  if (dropTarget) dropTarget.classList.remove("drop-target", "drop-reject");
  dropTarget = null;
  dropTargetClass = "";
}
function paintDropTarget(node, kind) {
  if (dropTarget === node && dropTargetClass === kind) return;
  clearDropTargets();
  dropTarget = node;
  dropTargetClass = kind;
  if (node) node.classList.add(kind);
}

function onListContext(event) {
  const row = event.target.closest && event.target.closest(".message-row");
  const email = emailFromRow(row);
  if (!email || email.outbox) return;
  event.preventDefault();
  if (state.selectedIds.indexOf(String(email.id)) >= 0 && state.selectedIds.length > 1) {
    openSelectionMenu(event.clientX, event.clientY);
    return;
  }
  openOrganizeMenu(email, event.clientX, event.clientY);
}

function readerContextTarget(event) {
  const target = event && event.target;
  if (!target) return null;
  if (typeof target.closest === "function") return target;
  return target.parentElement || null;
}

function onReaderContext(event) {
  if (!state.email || state.email.outbox) return;
  const target = readerContextTarget(event);
  if (target && target.closest && target.closest(".sender-address")) return;
  if (target && target.closest && target.closest("input, textarea, select, a")) return;
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

function setOffsetDragGhost(event, label) {
  if (!event || !event.dataTransfer) return;
  const spot = dragGhostHotspot();
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const spacer = document.createElement("div");
  spacer.className = "drag-ghost-spacer";
  spacer.style.height = spot.offset + "px";
  const chip = document.createElement("div");
  chip.className = "drag-ghost-chip";
  chip.textContent = String(label || "Mail").slice(0, 80);
  ghost.append(spacer, chip);
  document.body.appendChild(ghost);
  try {
    event.dataTransfer.setDragImage(ghost, spot.x, spot.y);
  } catch { /* the browser keeps its own preview */ }
  setTimeout(() => {
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
  }, 0);
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
  if (email && email.outbox) {
    event.preventDefault();
    return;
  }
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
  const count = Array.isArray(payload.messages) ? payload.messages.length : 1;
  const subjectNode = button.querySelector(".subject");
  const subject = subjectNode && subjectNode.textContent ? subjectNode.textContent.trim() : "Message";
  setOffsetDragGhost(event, count > 1 ? count + " messages" : subject);
}

function onMessageDragEnd() {
  state.dragMessage = null;
  clearDropTargets();
  clearMailDragChrome();
}

function eventElement(event) {
  const target = event && event.target;
  if (!target) return null;
  return target.nodeType === 1 ? target : target.parentElement;
}

function armFolderRoots(payload) {
  for (const node of document.querySelectorAll(".folder-root")) {
    const match = payload
      && node.dataset.nestKind === payload.kind
      && node.dataset.nestAccount === payload.accountId;
    node.classList.toggle("is-armed", !!match);
  }
}

function clearFolderDrag() {
  state.dragFolder = null;
  document.body.classList.remove("is-folder-drag");
  for (const node of document.querySelectorAll(".dragging-folder")) node.classList.remove("dragging-folder");
  armFolderRoots(null);
  clearDropTargets();
}

function folderNestContext(payload) {
  const account = accountForMove(payload && payload.accountId);
  if (!account || !payload) return null;
  const kind = payload.kind;
  if (kind === "imap") {
    const delimiter = accountDelimiter(account);
    const nodes = moveNodesFromFolders("imap", foldersOf(account), delimiter);
    return { nodes, flags: moveTargetFlags(nodes, payload.folderId, "imap", delimiter) };
  }
  if (kind !== "gmail" && kind !== "outlook") {
    return { blocked: "This mailbox cannot nest folders." };
  }
  const listed = providerPayloadFor(account);
  const view = providerFolderState(listed);
  if (view.mode !== "live") {
    return { blocked: (listed && listed.message) || providerCopy(view.reason, kind) };
  }
  const nodes = moveNodesFromFolders(kind, view.folders, "/");
  return { nodes, flags: moveTargetFlags(nodes, payload.folderId, kind, "/") };
}

function nestTargetFrom(node) {
  if (!node || !node.dataset || !node.dataset.nestKind) return null;
  return {
    kind: node.dataset.nestKind,
    accountId: node.dataset.nestAccount || "",
    id: node.dataset.nestId || "",
    isRoot: node.dataset.nestRoot === "1",
  };
}

function nestHover(payload, node) {
  const target = nestTargetFrom(node);
  if (!payload || !target) return { ok: false, message: "Drop onto a folder, or onto Top level to unnest." };
  const cached = payload.nest;
  if (cached && cached.blocked) return { ok: false, message: cached.blocked };
  if (!cached || !cached.flags) return { ok: false, message: "That mailbox is not connected." };
  return nestDropPlan(payload, target, cached.flags);
}

function onFolderDragStart(event) {
  if (state.dragMessage) return;
  const origin = eventElement(event);
  const node = origin && origin.closest && origin.closest("[data-nest-drag='1']");
  if (!node || !event.dataTransfer) return;
  const payload = {
    kind: node.dataset.nestKind,
    accountId: node.dataset.nestAccount || "",
    folderId: node.dataset.nestId || "",
    name: (node.querySelector(".name") && node.querySelector(".name").textContent) || "Folder",
  };
  if (!payload.folderId) {
    event.preventDefault();
    return;
  }
  payload.nest = folderNestContext(payload);
  state.dragFolder = payload;
  event.dataTransfer.setData("application/x-morrow-folder", JSON.stringify({
    kind: payload.kind,
    accountId: payload.accountId,
    folderId: payload.folderId,
    name: payload.name,
  }));
  event.dataTransfer.effectAllowed = "move";
  document.body.classList.add("is-folder-drag");
  node.classList.add("dragging-folder");
  armFolderRoots(payload);
  setOffsetDragGhost(event, payload.name);
}

function onFolderDragEnd() {
  clearFolderDrag();
}

async function dropFolderNest(source, node) {
  const target = nestTargetFrom(node);
  const ctx = folderNestContext(source);
  if (!ctx) {
    showStatus("That mailbox is not connected.", true);
    return;
  }
  if (ctx.blocked) {
    showStatus(ctx.blocked, true);
    return;
  }
  const plan = nestDropPlan(source, target, ctx.flags);
  if (!plan.ok) {
    showStatus(plan.message, true);
    return;
  }
  const sourceNode = (ctx.nodes || []).find((row) => row.id === source.folderId);
  const destNode = target && target.isRoot ? null : (ctx.nodes || []).find((row) => row.id === (target && target.id));
  const destinationName = target && target.isRoot
    ? "(Top level / root)"
    : ((destNode && (destNode.path || destNode.label || destNode.name)) || "folder");
  await commitFolderMove({
    kind: source.kind,
    accountId: source.accountId,
    sourceId: source.folderId,
    sourceName: source.name || (sourceNode && sourceNode.label) || "Folder",
    sourcePath: (sourceNode && (sourceNode.path || sourceNode.name)) || source.name || "Folder",
  }, {
    isRoot: !!(target && target.isRoot),
    id: target && target.isRoot ? "" : (target && target.id) || "",
    path: destinationName,
    label: destinationName,
    name: destinationName,
  });
}

function onFolderDragOver(event) {
  if (state.dragFolder) {
    const origin = eventElement(event);
    const node = origin && origin.closest && origin.closest("[data-nest-kind]");
    if (!node) { clearDropTargets(); return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const hover = nestHover(state.dragFolder, node);
    paintDropTarget(node, hover.ok ? "drop-target" : "drop-reject");
    return;
  }
  const node = event.target.closest && event.target.closest("[data-drop-kind]");
  if (!node || !state.dragMessage) { clearDropTargets(); return; }
  event.preventDefault();
  if (node.dataset.dropKind === "virtual") {
    // Chromium skips the drop event when dropEffect is none, so the refusal never reaches the status line.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    paintDropTarget(node, "drop-reject");
    return;
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = node.dataset.dropKind === "gmail" ? "copy" : "move";
  paintDropTarget(node, "drop-target");
}

function onFolderDrop(event) {
  if (state.dragFolder) {
    const origin = eventElement(event);
    const node = origin && origin.closest && origin.closest("[data-nest-kind]");
    const source = {
      kind: state.dragFolder.kind,
      accountId: state.dragFolder.accountId,
      folderId: state.dragFolder.folderId,
      name: state.dragFolder.name,
    };
    event.preventDefault();
    clearFolderDrag();
    if (!node) {
      showStatus("Drop onto a folder, or onto Top level to unnest.", true);
      return;
    }
    guard(() => dropFolderNest(source, node));
    return;
  }
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
  for (const folders of [$("folders"), $("provider-content")]) {
    folders.addEventListener("dragstart", onFolderDragStart);
    folders.addEventListener("dragend", onFolderDragEnd);
    folders.addEventListener("dragover", onFolderDragOver);
    folders.addEventListener("drop", onFolderDrop);
  }
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

async function selectOutbox() {
  if (!state.accounts.length) return;
  ++listGen;
  state.listLoading = false;
  invalidateReaderOpen();
  state.outbox = true;
  state.allInbox = false;
  state.allInboxUnreadOnly = false;
  noteUnreadScope();
  state.query = "";
  const search = $("search-query");
  if (search) search.value = "";
  const listFilter = $("list-filter");
  if (listFilter) listFilter.value = "";
  state.email = null;
  state.thread = [];
  state.selectedIds = [];
  state.selectionAnchor = "";
  state.listScope = "";
  renderAccounts();
  renderReader(false);
  await loadScheduled();
  if (!state.outbox) return;
  state.emails = outboxEmails(state.outboxRows);
  state.listOffset = 0;
  state.listTotal = state.emails.length;
  state.listSyncDone = true;
  renderList();
}

async function selectAllInbox(unreadOnly) {
  if (!state.accounts.length) return;
  const nextUnread = unreadOnly === true;
  const staying = state.allInbox && !state.query;
  if (!staying) {
    invalidateReaderOpen();
    state.email = null;
    state.thread = [];
    state.selectedIds = [];
    state.selectionAnchor = "";
    state.query = "";
    $("search-query").value = "";
    const listFilter = $("list-filter");
    if (listFilter) listFilter.value = "";
  } else if (state.allInboxUnreadOnly !== nextUnread) {
    state.selectedIds = [];
    state.selectionAnchor = "";
  }
  state.outbox = false;
  state.allInbox = true;
  state.allInboxUnreadOnly = nextUnread;
  state.listScope = "";
  renderAccounts();
  if (state.view === "folders") paintProviderPage();
  syncRemove();
  if (!staying) renderReader(false);
  if (!undoOpIds && !sendTimer) showStatus("");
  await loadList();
}

async function selectFolder(accountId, folderId) {
  invalidateReaderOpen();
  const previous = state.accountId;
  state.outbox = false;
  state.allInbox = false;
  state.allInboxUnreadOnly = false;
  state.listScope = "";
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
  if (state.view === "folders") paintProviderPage();
  syncRemove();
  renderReader(false);
  const live = isLive(selectedAccount()) && selectedFolderNode()?.syncs !== false;
  if (!undoOpIds && !sendTimer) showStatus("");
  // Paint downloaded mail before waiting for IMAP or provider APIs.
  await loadList();
  if (state.accountId !== accountId || state.folderId !== folderId) return;
  if (live) loadList(true).then(() => {
    if (state.accountId === accountId && state.folderId === folderId) paintSyncControl();
  }).catch((error) => {
    if (state.accountId === accountId && state.folderId === folderId) showStatus(error.message, true);
  });
  if (previous !== accountId) {
    loadSnoozed();
    loadProviderFolders(accountGen);
  }
  refreshMailVacation();
}

function readerCurrentId() {
  return pendingOpenId || (state.email && state.email.id) || "";
}

function invalidateReaderOpen() {
  openGen += 1;
  pendingOpenId = "";
  pendingOpenBody = false;
  const previews = new Set(activeBodyTargets().filter(target => target.peek).map(target => target.identity.key));
  for (const key of bodyNotices.keys()) if (!previews.has(key)) bodyNotices.delete(key);
}

function abandonOpen(emailId, message) {
  pendingOpenId = "";
  pendingOpenBody = false;
  const known = listedMessage(emailId) || {};
  state.email = {
    ...known,
    id: String(emailId),
    htmlBody: null,
    textBody: null,
    bodyError: message,
  };
  state.thread = [];
  renderReader(false);
  renderList();
}

function listedMessage(emailId) {
  const id = String(emailId);
  const rows = [].concat(state.emails || [], state.thread || []);
  return rows.find((row) => row && String(row.id) === id) || null;
}

function listedHasBody(email) {
  if (!email) return false;
  if (typeof email.htmlBody === "string" && email.htmlBody.trim()) return true;
  if (typeof email.textBody === "string" && email.textBody.trim()) return true;
  return email.hasBody === true;
}

function bodyIdentity(email, current = false) {
  if (!email || email.id == null || !email.accountId) return null;
  const account = state.accounts.find(row => row.id === email.accountId);
  if (!account) return null;
  const epoch = Number.isSafeInteger(account.bodyEpoch) ? account.bodyEpoch : 0;
  if (!current && email.bodyEpoch != null && email.bodyEpoch !== epoch) return null;
  return { id: String(email.id), accountId: email.accountId, bodyEpoch: epoch,
    key: JSON.stringify([email.accountId, epoch, String(email.id)]) };
}

function bodyFields(email, identity) {
  return { id: identity.id, accountId: identity.accountId, bodyEpoch: identity.bodyEpoch,
    bodyVersion: Number.isSafeInteger(email.bodyVersion) ? email.bodyVersion : 0,
    htmlBody: typeof email.htmlBody === "string" ? email.htmlBody : null,
    textBody: typeof email.textBody === "string" ? email.textBody : null,
    bodyComplete: email.bodyComplete === true, hasBody: listedHasBody(email), bodyWarning: typeof email.bodyWarning === "string" ? email.bodyWarning : "" };
}

function dropBody(key) {
  const entry = latestBodies.get(key);
  if (entry) latestBodyBytes -= entry.bytes;
  latestBodies.delete(key);
}

function noteBody(email, explicit = true) {
  const identity = bodyIdentity(email);
  if (!identity) return;
  if (explicit) {
    bodyReadFences.delete(identity.key); bodyReadFences.set(identity.key, ++bodyReadSerial);
    while (bodyReadFences.size > 64) bodyReadFences.delete(bodyReadFences.keys().next().value);
    const notice = bodyNotices.get(identity.key);
    if (notice) notice.attempted = -1;
  }
  const body = bodyFields(email, identity), previous = latestBodies.get(identity.key);
  if (previous && previous.body.bodyVersion > body.bodyVersion) return;
  dropBody(identity.key);
  const bytes = 2 * (identity.key.length + (body.htmlBody || "").length + (body.textBody || "").length + body.bodyWarning.length);
  if (bytes > BODY_CACHE_LIMITS.entryBytes) return; // Open views still own their full body.
  while (latestBodies.size && (latestBodies.size >= BODY_CACHE_LIMITS.entries || latestBodyBytes + bytes > BODY_CACHE_LIMITS.bytes)) dropBody(latestBodies.keys().next().value);
  latestBodies.set(identity.key, { body, bytes }); latestBodyBytes += bytes;
}

function preferBody(email) {
  const identity = bodyIdentity(email);
  const entry = identity && latestBodies.get(identity.key);
  if (!entry) return email;
  latestBodies.delete(identity.key); latestBodies.set(identity.key, entry);
  if (entry.body.bodyVersion > (Number.isSafeInteger(email.bodyVersion) ? email.bodyVersion : 0)) return {
    ...email, bodyMetadataVersion: email.bodyMetadataVersion ?? email.bodyVersion ?? 0, ...entry.body };
  return email;
}

function activeBodyTargets() {
  const targets = [];
  if (pendingOpenId) targets.push({ pending: true, email: listedMessage(pendingOpenId) || { id: pendingOpenId, accountId: state.accountId } });
  else if (state.email) targets.push({ email: state.email });
  if (pendingPeekId) targets.push({ pending: true, peek: true, email: { id: pendingPeekId, accountId: pendingPeekAccountId || listedMessage(pendingPeekId)?.accountId } });
  else if (peekEmail && $("agent-peek")?.open) targets.push({ peek: true, email: peekEmail });
  return targets.map(target => ({ ...target, identity: bodyIdentity(target.email, true) })).filter(target => target.identity);
}

function pruneBodyNotices() {
  const keys = new Set(activeBodyTargets().map(target => target.identity.key));
  for (const key of bodyNotices.keys()) if (!keys.has(key)) bodyNotices.delete(key);
}

function applyCachedBody(email) {
  const identity = bodyIdentity(email);
  if (!identity) return;
  noteBody(email, false);
  const body = bodyFields(email, identity);
  for (const target of activeBodyTargets()) {
    if (target.pending || target.identity.key !== identity.key) continue;
    if ((target.email.bodyEpoch ?? 0) === identity.bodyEpoch && (target.email.bodyVersion || 0) > body.bodyVersion) continue;
    let changed = target.email.htmlBody !== body.htmlBody || target.email.textBody !== body.textBody
      || target.email.bodyWarning !== body.bodyWarning || target.email.bodyComplete !== body.bodyComplete;
    const metadata = {};
    for (const field of ["attachments", "hasAttachments", "draftRevision", "draftPending", "from", "fromAddress", "fromDisplayName", "recipientHeaders", "replyTo",
      "to", "cc", "bcc", "subject", "messageId", "inReplyTo", "threadId", "conversationId", "isDraft"]) {
      if (Object.hasOwn(email, field)) metadata[field] = email[field];
    }
    changed ||= Object.entries(metadata).some(([field, value]) => JSON.stringify(target.email[field]) !== JSON.stringify(value));
    // Fresh local snapshots preserve body-associated draft/attachment identity.
    // Optimistic action flags stay with their own action-generation guards.
    const next = { ...target.email, ...metadata, ...body, bodyMetadataVersion: body.bodyVersion };
    if (target.peek) { peekEmail = next; if (changed) paintPeek(next); }
    else { state.email = next; if (changed) renderReader(false); }
  }
}

function pumpBodyRefreshes() {
  pruneBodyNotices();
  if (bodyRefresh) return;
  for (const [key, notice] of bodyNotices) {
    const targets = activeBodyTargets().filter(target => target.identity.key === key);
    const cached = latestBodies.get(key)?.body.bodyVersion ?? -1;
    const needed = targets.some(target => {
      const current = target.pending || (target.email.bodyEpoch ?? 0) !== notice.bodyEpoch ? -1 : target.email.bodyVersion ?? -1;
      const metadata = target.pending ? cached : (target.email.bodyMetadataVersion ?? current);
      return Math.min(Math.max(cached, current), metadata) < notice.bodyVersion;
    });
    if (!needed || notice.attempted >= notice.bodyVersion) continue;
    notice.attempted = notice.bodyVersion;
    const request = { key, fence: bodyReadFences.get(key) || 0, version: notice.bodyVersion };
    bodyRefresh = request;
    Promise.resolve().then(() => call("mail:readCachedBody", { accountId: notice.accountId, emailId: notice.id, bodyEpoch: notice.bodyEpoch }))
      .then(result => {
        const email = result?.email, identity = bodyIdentity(email);
        if (!identity || identity.key !== key || !activeBodyTargets().some(target => target.identity.key === key)) return;
        if ((bodyReadFences.get(key) || 0) !== request.fence) {
          const latest = bodyNotices.get(key);
          if (latest && latest.attempted === request.version) latest.attempted = -1;
          return;
        }
        applyCachedBody(email);
      }).catch(() => { /* Retry on a newer notice or an explicit reopen, never spin on a failed local read. */ })
      .finally(() => { if (bodyRefresh === request) bodyRefresh = null; pumpBodyRefreshes(); });
    return;
  }
}

function acceptBodyAccounts(accounts) {
  const previous = new Map(state.accounts.map(account => [account.id, account.bodyEpoch || 0]));
  state.accounts = Array.isArray(accounts) ? accounts : [];
  for (const [key, entry] of latestBodies) if (!bodyIdentity(entry.body)) dropBody(key);
  for (const key of bodyReadFences.keys()) {
    const [accountId, epoch] = JSON.parse(key);
    if (!state.accounts.some(account => account.id === accountId && (account.bodyEpoch || 0) === epoch)) bodyReadFences.delete(key);
  }
  pruneBodyNotices();
  for (const target of activeBodyTargets()) {
    const account = state.accounts.find(row => row.id === target.identity.accountId);
    if ((previous.has(account.id) && previous.get(account.id) !== (account.bodyEpoch || 0))
        || (target.email.bodyEpoch != null && target.email.bodyEpoch !== (account.bodyEpoch || 0))) bodyNotices.set(target.identity.key,
      { ...target.identity, bodyVersion: account.bodyVersion || 0, attempted: -1 });
  }
  pumpBodyRefreshes();
}

function applyBodyUpdate(payload) {
  const full = payload?.email;
  const incoming = full || { ...payload, id: payload?.emailId };
  const identity = bodyIdentity(incoming);
  if (!identity) return;
  if (incoming.bodyVersion != null && (!Number.isSafeInteger(incoming.bodyVersion) || incoming.bodyVersion < 0)) return;
  const version = Number.isSafeInteger(incoming.bodyVersion) ? incoming.bodyVersion : 0;
  const known = listedMessage(identity.id);
  if (known && known.accountId === identity.accountId && Math.max(known.bodyNoticeVersion ?? -1, known.bodyVersion ?? -1) <= version) {
    known.bodyNoticeVersion = version;
    if (known !== state.email && known !== peekEmail) {
      known.bodyComplete = incoming.bodyComplete === true;
      known.hasBody = full ? listedHasBody(full) : incoming.hasBody === true;
      known.bodyWarning = incoming.bodyWarning || "";
    }
  }
  if (pendingPeekId === identity.id && !pendingPeekAccountId) pendingPeekAccountId = identity.accountId;
  const targets = activeBodyTargets().filter(target => target.identity.key === identity.key);
  if (!targets.length) return; // Unopened body updates retain no body or per-message notice.
  if (full) { applyCachedBody(full); return; } // Compatibility with already queued full events.
  const previous = bodyNotices.get(identity.key);
  if (!previous || previous.bodyVersion < version) bodyNotices.set(identity.key, { ...identity, bodyVersion: version, attempted: previous?.attempted ?? -1 });
  pumpBodyRefreshes();
}

function paintReaderPending(email) {
  const pane = $("reader");
  pane.replaceChildren();
  if (isReaderWindow()) pane.appendChild(readerCloseBar());
  pane.setAttribute("aria-busy", "true");
  const heading = document.createElement("h2");
  heading.textContent = (email && email.subject) || "(no subject)";
  const pending = document.createElement("div");
  pending.className = "body-pending";
  pending.setAttribute("role", "status");
  const spin = document.createElement("div");
  spin.className = "page-busy-spin";
  spin.setAttribute("aria-hidden", "true");
  const label = document.createElement("p");
  label.className = "body-pending-label";
  label.textContent = "Loading message…";
  pending.append(spin, label);
  pane.append(heading, readerFromLine(email), pending);
}

async function openMessage(emailId, focus, full = false) {
  const known = listedMessage(emailId);
  const openedUnread = !!(known && known.unread);
  if (known && known.outbox) {
    invalidateReaderOpen();
    state.email = known;
    state.thread = [];
    renderReader(focus !== false);
    renderList();
    return;
  }
  const gen = ++openGen;
  const showing = state.email && String(state.email.id) === String(emailId)
    && (state.email.htmlBody || state.email.textBody);
  const waitForBody = !showing && !listedHasBody(known) && !!(known && known.bodyComplete === false);
  pendingOpenId = emailId;
  pendingOpenBody = waitForBody;
  if (waitForBody) paintReaderPending(known);
  renderList();
  let data;
  try {
    data = await call("mail:openEmail", { emailId, ...(full ? { full: true } : {}) });
  } catch (error) {
    if (gen !== openGen) return;
    abandonOpen(emailId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (gen !== openGen) return;
  const email = data && data.email;
  if (!email || String(email.id) !== String(emailId)) {
    const message = email ? "That message could not be loaded." : "That message is no longer in the mailbox.";
    abandonOpen(emailId, message);
    throw new Error(message);
  }
  let listed = null;
  const fromOpen = data && data.threadMessages;
  if (shouldListThread(state.prefs.conversation, fromOpen, email.threadId)) {
    try {
      listed = await call("mail:listThreadMessages", {
        threadId: email.threadId,
        accountId: email.accountId,
        emailId: email.id,
        headersOnly: true,
      });
    } catch {
      // The opened message still renders when the thread list fails.
    }
    if (gen !== openGen) return;
  }
  if (email.bodyEpoch != null && !bodyIdentity(email)) {
    const message = "The mailbox connection changed. Reopen the message.";
    abandonOpen(emailId, message); throw new Error(message);
  }
  pendingOpenId = "";
  pendingOpenBody = false;
  noteBody(email);
  state.email = preferBody(email);
  state.thread = state.prefs.conversation === false ? [] : threadMembers(fromOpen, listed);
  state.unreadHold = applyUnreadHold(state.unreadHold, {
    kind: "open",
    view: currentUnreadView(),
    id: email.id,
    accountId: email.accountId,
    unread: openedUnread,
  });
  renderReader(focus !== false);
  renderList();
  pumpBodyRefreshes();
  if (!email.unread) return;
  try {
    await setRead(email, true);
  } catch (error) {
    if (gen === openGen) showStatus("Message opened, but marking it read was not confirmed. Other clients may still show it unread. " + (error.message || String(error)), true);
  }
}

async function applySearch() {
  invalidateReaderOpen();
  const query = $("search-query").value.trim();
  if (query) state.outbox = false;
  state.query = query;
  state.email = null;
  state.thread = [];
  state.selectedIds = [];
  renderReader(false);
  if (query) showStatus("Searching downloaded mail…");
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

let reloadAccounts = false;
let reloadPreferred = "";
let reloadRunning = false;
let reloadAgain = false;
function scheduleReload(preferredId, accountsChanged = false) {
  reloadAccounts ||= accountsChanged;
  if (typeof preferredId === "string" && preferredId) reloadPreferred = preferredId;
  reloadAgain = true;
  if (reloadTimer || reloadRunning) return;
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    reloadRunning = true;
    reloadAgain = false;
    const accounts = reloadAccounts, preferred = reloadPreferred;
    reloadAccounts = false; reloadPreferred = "";
    try {
      if (accounts) await loadAccounts(preferred || undefined);
      else await loadList();
    } catch (error) { pushDebug("sync", error.message); }
    finally {
      reloadRunning = false;
      if (reloadAgain) scheduleReload();
    }
  }, 150);
}

function onAccountsUpdated(payload) {
  const preferred = preferredAccountId(payload);
  const accounts = payload && Array.isArray(payload.accounts) ? payload.accounts : null;
  if (accounts) {
    acceptBodyAccounts(accounts);
    rememberSelection(preferred);
    renderAccounts();
    syncRemove();
    if (preferred && state.oauthPending) {
      const view = accounts.find((account) => account.id === preferred);
      if (view && view.email && !view.needsReauth) {
        state.oauthPending = false;
        paintConnectPending();
        closeDialog("connect");
        showStatus(`Connected ${view.email}. ${view.grantWarning || "Downloading recent Inbox mail…"}`);
      }
    }
  }
  if (payload && payload.outboxReceipt) {
    const notice = payload.outboxReceipt;
    if (notice.uncertain) showStatus(notice.message || "Delivery is uncertain. Check Sent and Scheduled delivery review.", true);
    else separatePartialReceipt(notice.seed || {}, notice.message || "").catch(() => {});
  }
  if (payload && payload.outboxRestore) {
    const notice = payload.outboxRestore;
    const seed = notice.seed || {};
    const html = typeof seed.htmlBody === "string" ? seed.htmlBody : (typeof seed.body === "string" ? seed.body : "");
    const message = notice.message || "Delivery was not confirmed. Your draft is ready to edit. Check Sent before retrying.";
    presentCompose({
      title: seed.subject || "Message",
      accountId: seed.accountId,
      fromAddress: seed.fromAddress,
      fromDisplayName: seed.fromDisplayName || "",
      to: people(seed.to),
      cc: people(seed.cc),
      bcc: people(seed.bcc),
      subject: seed.subject || "",
      body: plainFromMailHtml(html),
      htmlBody: html,
      attachments: seed.attachments,
      draftId: seed.draftId,
      draftRevision: seed.draftRevision,
      inReplyTo: seed.inReplyTo || "",
      threadId: seed.threadId || "",
      status: message,
      ...(explicitAgentTodo(seed.agentTodo) ? { agentTodo: explicitAgentTodo(seed.agentTodo) } : {}),
    }).catch(() => {});
    showStatus(message, true);
  }
  scheduleReload(preferred, true);
  if (payload?.scheduledUpdated || $("scheduled-dialog")?.open) loadScheduled().catch(() => {});
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

let connectGmailMigrationAccountId = null;

function clearConnectMigration() {
  connectGmailMigrationAccountId = null;
  const button = $("connect-gmail-migration");
  if (button) button.hidden = true;
}

function setConnectStatus(text, isError) {
  $("connect-status").textContent = text || "";
  $("connect-status").classList.toggle("error", !!isError);
}

function paintConnectPending() {
  const busy = state.oauthPending || state.connectPending;
  const google = oauthButtonState(state.oauthStatus, "google");
  $("oauth-google").disabled = !!busy || googleOauthClientBusy || google.disabled;
  $("oauth-microsoft").disabled = !!busy;
  if ($("connect-yahoo")) $("connect-yahoo").disabled = !!busy;
  $("connect-submit").disabled = !!busy;
  if ($("connect-gmail-migration")) $("connect-gmail-migration").disabled = !!busy;
  $("connect-close").textContent = state.oauthPending ? "Cancel sign-in" : "Cancel";
  $("connect-form").setAttribute("aria-busy", busy ? "true" : "false");
  $("oauth-unavailable").textContent = google.disabled
    ? "Google sign-in is unavailable in this installation. Review Google OAuth status in Settings → Accounts. A personal Desktop client is an optional advanced choice." : "";
  paintGoogleOauthClientButtons();
}

async function connectImap() {
  if (state.connectPending || state.oauthPending) return;
  // Dialog close clears selection while discovery may still be pending. Keep
  // the request's original identity so it cannot turn into a fresh account add.
  const expectedAccountId = state.reconnectAccountId || undefined;
  state.connectPending = true;
  paintConnectPending();
  setConnectStatus("Connecting…");
  try {
    cancelDiscovery();
    const gen = discoverGen;
    const email = prepareDiscoveryAddress();
    if (!manualCustomHosts()) {
      let found;
      try {
        found = await call("mail:discoverMail", { email });
      } catch { /* the selected provider still connects */ }
      if ($("email").value.trim() !== email) throw new Error("The email address changed. Review the servers and choose Connect again.");
      if (gen !== discoverGen) throw new Error("The account details changed. Review the servers and choose Connect again.");
      applyDiscovery(found);
    }
    const view = await call("mail:connectImapSmtp", { ...connectPayload(), expectedAccountId });
    $("password").value = "";
    closeDialog("connect");
    showStatus(view && view.email ? `Connected ${view.email}. Downloading recent Inbox mail…` : "Connected.");
    await loadAccounts(view && view.id);
  } catch (error) { setConnectStatus("Could not connect. " + error.message, true); }
  finally { state.connectPending = false; paintConnectPending(); }
}

async function connectOAuth(provider) {
  if (state.oauthPending || state.connectPending) return;
  const expectedAccountId = state.reconnectAccountId || null;
  clearConnectMigration();
  state.oauthPending = true;
  paintConnectPending();
  setConnectStatus(provider === "microsoft"
    ? "Continue in your browser to connect mail. Morrow then checks calendar, organize, Out of Office, and inbox rules for the same account; approve any missing permissions. Mail stays connected if you decline those features."
    : "Continue with Google OAuth for Gmail API mail, labels, Out of Office and inbox rules. Calendar is enabled separately. Existing legacy OAuth mailboxes require the reviewed migration in Settings → Accounts.");
  try {
    const view = await call("mail:addAccount", { provider, expectedAccountId: expectedAccountId || undefined });
    if (!view || !view.id || !view.email) throw new Error("Sign-in did not return an account.");
    state.oauthPending = false;
    paintConnectPending();
    closeDialog("connect");
    showStatus(`Connected ${view.email}. ${view.grantWarning || "Downloading recent Inbox mail…"}`);
    await loadAccounts(view.id);
  } catch (error) {
    const message = error.message || String(error);
    if (provider === "google" && error.code === "gmail_migration_required") {
      connectGmailMigrationAccountId = expectedAccountId;
      $("connect-imap").open = false;
      $("connect-gmail-migration").hidden = false;
      setConnectStatus("This Gmail connection needs migration review. Choose Review Gmail API migration to open Settings → Accounts → Permissions & calendar access. Review the migration there, then choose Continue with Google. Cached mail and drafts stay. No password is needed in Morrow.", true);
    } else {
      setConnectStatus(/cancel/i.test(message) ? "Sign-in canceled." : "Could not finish sign-in. " + message + " Try the provider button again.", !/cancel/i.test(message));
    }
  } finally {
    state.oauthPending = false;
    paintConnectPending();
  }
}

async function reviewConnectGmailMigration() {
  if (state.oauthPending || state.connectPending || $("connect-gmail-migration").hidden) return;
  const accountId = connectGmailMigrationAccountId;
  const accountEmail = state.accounts.find(row => row.id === accountId)?.email;
  const targetAvailable = selected => {
    const account = state.accounts.find(row => row.id === accountId);
    return account?.email === accountEmail && account?.authKind === "oauth2"
      && (account.imapSmtpProfile || account.profile) === "gmail" && (!selected || settingsAccount()?.id === accountId);
  };
  const cancelReview = () => {
    paintSettingsMailbox();
    revealSettingsFold("mailbox");
    $("account-permissions").open = false;
    $("settings-account").focus();
    showStatus("That Gmail connection changed or was removed. Migration review was cancelled. Select the intended mailbox in Accounts to start again.", true);
  };
  await closeDialog("connect");
  openSettings();
  if (accountId) {
    if (!targetAvailable(false)) { cancelReview(); return; }
    if (settingsAccount()?.id !== accountId && !(await changeSettingsMailbox(accountId))) return;
    if (!targetAvailable(true)) { cancelReview(); return; }
  }
  paintSettingsMailbox();
  revealSettingsFold("mailbox");
  $("account-permissions").open = true;
  await loadSettingsFold("mailbox");
  if (accountId && !targetAvailable(true)) { cancelReview(); return; }
  if (accountId && !$("settings-gmail-migrate").hidden) $("settings-gmail-migrate").focus();
  else {
    $("settings-account").focus();
    showStatus("Select the Gmail mailbox in Accounts, then review Migrate Gmail to Gmail API under Permissions & calendar access.");
  }
}

function dismissConnect() {
  closeDialog("connect");
  if (!state.oauthPending) return;
  call("mail:cancelOAuth").catch(() => {});
}

function sanitizeComposeHtml(html) {
  const root = document.createElement("div");
  appendSafeMailHtml(root, html, false);
  return root.innerHTML || "";
}

function composeEditorLive() {
  const editor = $("compose-editor");
  return !!(editor && editor.nodeType === 1 && typeof editor.appendChild === "function" && typeof editor.replaceChildren === "function");
}

function blankComposeHtml(html) {
  const value = String(html || "").replace(/\s+/g, "").toLowerCase();
  return !value || value === "<br>" || value === "<br/>" || value === "<div><br></div>" || value === "<div><br/></div>" || value === "<p><br></p>" || value === "<p><br/></p>";
}

function readComposeEditorHtml() {
  const editor = $("compose-editor");
  if (!editor || editor.nodeType !== 1) return "";
  const html = typeof editor.innerHTML === "string" ? editor.innerHTML.trim() : "";
  if (blankComposeHtml(html)) return "";
  if (typeof sanitizeComposeHtml !== "function") return "";
  try { return sanitizeComposeHtml(html); } catch { return ""; }
}

function composeEditorSnapshot() {
  const editor = $("compose-editor");
  if (!editor || editor.nodeType !== 1 || typeof editor.innerHTML !== "string") return "";
  if (blankComposeHtml(editor.innerHTML)) return "";
  return editor.innerHTML;
}

function paintComposeEditor(plain, html) {
  if (!composeEditorLive()) return;
  const editor = $("compose-editor");
  editor.replaceChildren();
  const markup = String(html || "");
  if (markup.trim()) {
    appendSafeMailHtml(editor, markup, false);
    return;
  }
  const parts = splitComposeSignature(plain, state.signatureText);
  if (parts.message) appendSafeMailHtml(editor, toHtml(parts.message), false);
  if (!parts.signature) return;
  if (editor.childNodes.length) {
    editor.appendChild(document.createElement("br"));
    editor.appendChild(document.createElement("br"));
  }
  const block = document.createElement("div");
  block.setAttribute("data-compose-signature", "1");
  appendSafeMailHtml(block, state.signatureHtml || toHtml(parts.signature), false);
  editor.appendChild(block);
}

function writeComposeBody(next, html) {
  const body = $("compose-body");
  const value = next == null ? "" : String(next);
  if (body) body.value = value;
  paintComposeEditor(value, html || "");
}

function updateComposeSignatureNode(text, html) {
  const editor = $("compose-editor");
  if (!composeEditorLive()) return;
  const next = String(text || "");
  const markup = String(html || "");
  let node = editor.querySelector("[data-compose-signature]");
  if (!next && !markup.trim()) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    if (editor.childNodes.length) {
      editor.appendChild(document.createElement("br"));
      editor.appendChild(document.createElement("br"));
    }
    node = document.createElement("div");
    node.setAttribute("data-compose-signature", "1");
    editor.appendChild(node);
  }
  node.replaceChildren();
  appendSafeMailHtml(node, markup.trim() ? markup : toHtml(next), false);
}

function commitComposeSignature(previous, next, html) {
  const body = $("compose-body");
  const current = body && typeof body.value === "string" ? body.value : "";
  const committed = commitPickerSignature(current, previous, next);
  if (body) body.value = committed.body;
  state.signatureText = committed.previous;
  state.signatureHtml = next ? String(html || toHtml(next)) : "";
  if (composeEditorLive() && signatureUntouched(current, previous)) {
    updateComposeSignatureNode(next, state.signatureHtml);
    return;
  }
  paintComposeEditor(committed.body, "");
}

function composeSignatureUntouched() {
  if (!composeEditorLive()) return signatureUntouched($("compose-body").value, state.signatureText);
  const node = $("compose-editor").querySelector("[data-compose-signature]");
  if (!state.signatureText && !state.signatureHtml) return !node;
  // The live node is authoritative: HTML-only signatures can have different
  // plain-text forms (block boundaries and entities) without any user edit.
  return !!node && node.innerHTML === sanitizeComposeHtml(state.signatureHtml || toHtml(state.signatureText));
}

function syncComposePlainFromEditor() {
  const editor = $("compose-editor");
  const body = $("compose-body");
  if (!composeEditorLive() || !body) return;
  if (state.draftWrite && !state.draftWrite.pending) state.draftWrite = null;
  const sig = editor.querySelector("[data-compose-signature]");
  if (sig) {
    const clone = editor.cloneNode(true);
    const sigClone = clone.querySelector("[data-compose-signature]");
    if (sigClone) sigClone.remove();
    const message = plainFromComposeHtml(clone.innerHTML);
    const sigText = plainFromComposeHtml(sig.innerHTML);
    body.value = message && sigText ? message + "\n\n" + sigText : (message || sigText);
  } else {
    body.value = plainFromComposeHtml(editor.innerHTML);
  }
  paintComposeNote();
}

function setComposeEditorEditable(editable) {
  const editor = $("compose-editor");
  if (!editor || editor.nodeType !== 1) return;
  editor.contentEditable = editable ? "true" : "false";
}

function setComposeFormatLocked(locked) {
  const editing = !locked && !(state.draftWrite && state.draftWrite.pending);
  const bar = $("compose-format");
  if (bar && typeof bar.querySelectorAll === "function") {
    for (const control of bar.querySelectorAll("button, input")) {
      if (control.id === "compose-ai-open") {
        control.disabled = !!locked;
        continue;
      }
      control.disabled = !editing;
    }
  }
  setComposeEditorEditable(editing);
}

// style-src 'self' ignores style attributes. Reapply color and highlight through CSSOM so they stay visible.
function revealEditorStyles(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  let nodes = [];
  try { nodes = root.querySelectorAll("[style], [data-mail-style], font[color], [bgcolor]"); } catch { return; }
  for (const el of nodes) {
    if (!el || el === root) continue;
    const css = mailInlineStyle(el);
    if (css) mailApplyCss(el, css, false, false);
    if (typeof el.getAttribute !== "function" || !el.style || typeof el.style.setProperty !== "function") continue;
    if (String(el.tagName || "").toLowerCase() === "font") {
      const color = mailColor(el.getAttribute("color"));
      if (color) el.style.setProperty("color", color);
    }
    const bg = mailColor(el.getAttribute("bgcolor"));
    if (bg) el.style.setProperty("background-color", bg);
  }
}

function paintFormatState(bar) {
  if (!bar || typeof bar.querySelectorAll !== "function" || typeof document.queryCommandState !== "function") return;
  for (const button of bar.querySelectorAll("button[data-command]")) {
    let on = false;
    try { on = document.queryCommandState(button.getAttribute("data-command")) === true; } catch { on = false; }
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function activeRichEditor(editor) {
  const node = editor && editor.nodeType === 1 ? editor : $("compose-editor");
  if (!node || node.nodeType !== 1 || node.contentEditable === "false") return null;
  if (typeof node.appendChild !== "function" || typeof node.replaceChildren !== "function") return null;
  return node;
}

function rememberEditorRange(editor) {
  const sel = typeof document.getSelection === "function" ? document.getSelection() : null;
  if (!sel || !sel.rangeCount || !editor) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  if (node !== editor && !(editor.contains && editor.contains(node))) return null;
  return typeof range.cloneRange === "function" ? range.cloneRange() : range;
}

function restoreEditorRange(editor, range) {
  if (!range || typeof document.getSelection !== "function") return;
  const sel = document.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
  if (editor && typeof editor.focus === "function") editor.focus();
}

function paintColorSwatch(input) {
  const label = input && input.closest ? input.closest(".compose-color") : null;
  if (!label || !label.style || typeof label.style.setProperty !== "function") return;
  const color = mailColor(input.value);
  if (color) label.style.setProperty("--swatch", color);
}

function wrapRichStyle(editor, prop, color) {
  if (!editor || typeof document.getSelection !== "function") return;
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  if (node !== editor && !(editor.contains && editor.contains(node))) return;
  const el = document.createElement("span");
  if (el.style && typeof el.style.setProperty === "function") el.style.setProperty(prop, color);
  try {
    range.surroundContents(el);
  } catch {
    el.appendChild(range.extractContents());
    range.insertNode(el);
  }
}

function insertComposeFallback(command) {
  const tag = command === "bold" ? "strong" : command === "italic" ? "em" : command === "underline" ? "u" : "";
  if (!tag || typeof document.getSelection !== "function") return;
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const el = document.createElement(tag);
  try {
    range.surroundContents(el);
  } catch {
    el.appendChild(range.extractContents());
    range.insertNode(el);
  }
}

function applyComposeCommand(command, editor, value) {
  const target = activeRichEditor(editor);
  if (!target) return;
  if (typeof target.focus === "function") target.focus();
  const colored = command === "foreColor" || command === "hiliteColor" || command === "backColor";
  const color = colored ? mailColor(value) : "";
  if (colored && !color) return;
  let applied = false;
  try {
    if (command === "foreColor") {
      try { document.execCommand("styleWithCSS", false, false); } catch { /* font color stays visible without a style attribute */ }
    } else if (colored) {
      try { document.execCommand("styleWithCSS", false, true); } catch { /* highlight uses a background color */ }
    }
    try { applied = document.execCommand(command, false, colored ? color : null) === true; } catch { applied = false; }
    if (!applied && command === "hiliteColor") {
      try { applied = document.execCommand("backColor", false, color) === true; } catch { applied = false; }
    }
  } finally {
    if (colored && command !== "foreColor") {
      try { document.execCommand("styleWithCSS", false, false); } catch { /* bold and italic stay on tags */ }
    }
  }
  if (!applied && !colored) insertComposeFallback(command);
  if (!applied && command === "foreColor") wrapRichStyle(target, "color", color);
  if (!applied && (command === "hiliteColor" || command === "backColor")) wrapRichStyle(target, "background-color", color);
  if (colored) revealEditorStyles(target);
}

function insertComposeMarkup(markup, editor) {
  const target = activeRichEditor(editor);
  if (!target) return;
  if (typeof target.focus === "function") target.focus();
  const holder = document.createElement("div");
  appendSafeMailHtml(holder, markup, false);
  const sel = typeof document.getSelection === "function" ? document.getSelection() : null;
  const anchor = sel && sel.rangeCount ? sel.anchorNode : null;
  const inside = !!(anchor && (anchor === target || (target.contains && target.contains(anchor))));
  if (!inside) {
    while (holder.firstChild) target.appendChild(holder.firstChild);
  } else {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    while (holder.firstChild) fragment.appendChild(holder.firstChild);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
  }
  revealEditorStyles(target);
}

function placeComposeCaret(editor) {
  if (!editor || typeof document.createRange !== "function" || typeof window.getSelection !== "function") return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusComposeBody() {
  const editor = $("compose-editor");
  if (editor && editor.nodeType === 1 && typeof editor.focus === "function") {
    editor.focus();
    placeComposeCaret(editor);
    return;
  }
  const body = $("compose-body");
  if (!body || typeof body.focus !== "function") return;
  body.focus();
  if (typeof body.setSelectionRange === "function") body.setSelectionRange(0, 0);
  if (typeof body.scrollTop === "number") body.scrollTop = 0;
}

function bindRichEditor(bar, editor, onInput) {
  if (!bar && !editor) return;
  let saved = null;
  if (bar && typeof bar.addEventListener === "function") {
    if (typeof bar.querySelectorAll === "function") {
      for (const input of bar.querySelectorAll("input[data-command]")) paintColorSwatch(input);
    }
    bar.addEventListener("mousedown", (event) => {
      const button = event.target && event.target.closest && event.target.closest("button");
      if (button && button.id === "compose-ai-open") return;
      if (button) event.preventDefault();
      saved = rememberEditorRange(editor);
    });
    bar.addEventListener("click", (event) => {
      const button = event.target && event.target.closest && event.target.closest("button[data-command]");
      if (!button || button.disabled) return;
      applyComposeCommand(button.getAttribute("data-command"), editor);
      if (onInput) onInput();
      paintFormatState(bar);
    });
    bar.addEventListener("input", (event) => {
      const input = event.target && event.target.closest && event.target.closest("input[data-command]");
      if (!input || input.disabled) return;
      restoreEditorRange(editor, saved);
      applyComposeCommand(input.getAttribute("data-command"), editor, input.value);
      paintColorSwatch(input);
      if (onInput) onInput();
    });
  }
  if (!editor || typeof editor.addEventListener !== "function") return;
  editor.addEventListener("input", () => {
    revealEditorStyles(editor);
    if (onInput) onInput();
  });
  editor.addEventListener("paste", (event) => {
    if (!event || !event.clipboardData) return;
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    if (!html && !text) return;
    event.preventDefault();
    const markup = html ? sanitizeComposeHtml(html) : toHtml(text);
    if (!markup) return;
    insertComposeMarkup(markup, editor);
    revealEditorStyles(editor);
    if (onInput) onInput();
  });
  editor.addEventListener("keyup", () => paintFormatState(bar));
  editor.addEventListener("mouseup", () => paintFormatState(bar));
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    event.stopPropagation();
  });
}

function wireComposeFormat() {
  bindRichEditor($("compose-format"), $("compose-editor"), syncComposePlainFromEditor);
  bindRichEditor($("signature-format"), $("signature-editor"), syncSignatureSource);
}

function composePayload(account) {
  const meta = state.composeMeta || {};
  const plain = $("compose-body").value;
  const quote = state.composeQuote && state.composeQuote.text;
  const rich = readComposeEditorHtml();
  const payload = {
    accountId: account.id,
    to: $("compose-to").value.trim(),
    subject: $("compose-subject").value,
    body: rich
      ? joinComposeHtml(rich, toHtml(outgoingBody("", quote)))
      : toHtml(outgoingBody(plain, quote)),
    fromAddress: meta.fromAddress || account.preferredFromAddress || account.email,
    fromDisplayName: meta.fromDisplayName,
    draftId: state.draftId || undefined,
    emailId: state.draftId || undefined,
    draftRevision: state.draftRevision || undefined,
  };
  const cc = $("compose-cc").value.trim();
  const bcc = $("compose-bcc").value.trim();
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;
  if (meta.inReplyTo) payload.inReplyTo = meta.inReplyTo;
  if (meta.threadId) payload.threadId = meta.threadId;
  const files = attachmentPayload(state.composeAttachments);
  if (files.length) payload.attachments = files;
  return payload;
}

function syncComposeRecipientRows() {
  const showCc = !!(state.composeShowCc || $("compose-cc")?.value?.trim());
  const showBcc = !!(state.composeShowBcc || $("compose-bcc")?.value?.trim());
  const ccRow = $("compose-cc-row");
  const bccRow = $("compose-bcc-row");
  const ccBtn = $("compose-show-cc");
  const bccBtn = $("compose-show-bcc");
  if (ccRow) ccRow.hidden = !showCc;
  if (bccRow) bccRow.hidden = !showBcc;
  if (ccBtn) {
    ccBtn.hidden = showCc;
    ccBtn.setAttribute?.("aria-expanded", String(showCc));
  }
  if (bccBtn) {
    bccBtn.hidden = showBcc;
    bccBtn.setAttribute?.("aria-expanded", String(showBcc));
  }
}

function syncComposeActions() {
  const account = composeAccount();
  const live = isLive(account);
  const locked = state.composePending || state.composeQueued || state.composeInitializing || !!state.draftWrite?.pending || composeFilesPending();
  for (const id of ["compose-save", "compose-send", "compose-schedule"]) $(id).disabled = !live || locked || !!state.composeIdentityError;
  $("compose-schedule").disabled = !live || locked || !!state.composeIdentityError || !!state.botDraftReview;
  const sendButton = $("compose-send");
  if (sendButton) sendButton.textContent = sendButtonLabel(state.prefs.scheduleDelay, state.botDraftReview);
  const sendNow = $("compose-send-now");
  if (sendNow) {
    const offerNow = !state.botDraftReview && scheduleDelayMinutes(state.prefs.scheduleDelay) > 0;
    sendNow.hidden = !offerNow;
    sendNow.disabled = !live || locked || !!state.composeIdentityError;
  }
}

function syncCompose() {
  const locked = state.composePending || state.composeQueued || state.composeInitializing;
  syncComposeActions();
  $("compose-close").disabled = state.composePending || state.composeInitializing;
  for (const id of ["compose-from", "compose-to", "compose-cc", "compose-bcc", "compose-show-cc", "compose-show-bcc", "compose-subject", "compose-body", "signature", "signatures-from-compose", "ai-mode", "ai-prompt", "ai-generate", "schedule-preset", "schedule-at", "compose-attach", "compose-file"]) {
    const control = $(id);
    if (control) control.disabled = locked;
  }
  for (const id of ["compose-to", "compose-cc", "compose-bcc", "compose-subject", "compose-body"]) {
    const control = $(id);
    if (control) { control.readOnly = !!state.composePartialReceipt; if (state.composePartialReceipt) control.disabled = false; }
  }
  setComposeFormatLocked(locked);
  syncComposeRecipientRows();
  paintComposeAttachments();
  paintComposeNote();
  paintComposeAi();
  if (recipientSuggestInput && (recipientSuggestInput.disabled || recipientSuggestInput.readOnly)) hideRecipientSuggest();
}

function paintComposeNote() {
  const account = composeAccount();
  const live = isLive(account);
  let text = live
    ? "From " + window.morrowComposePolicy.senderPreview((state.composeMeta && state.composeMeta.fromAddress) || account.preferredFromAddress || account.email, state.composeMeta?.fromDisplayName || "")
    : "Connect an account before saving or sending.";
  const review = state.botDraftReview;
  if (review) {
    const accountId = (state.composeMeta && state.composeMeta.accountId) || "";
    const same = review.accountId === accountId
      && review.to === $("compose-to").value
      && review.cc === $("compose-cc").value
      && review.bcc === $("compose-bcc").value
      && review.subject === $("compose-subject").value
      && review.body === $("compose-body").value
      && (review.attachments || "") === attachmentKey(state.composeAttachments);
    text += same
      ? " Reviewing a draft proposal. Nothing is sent until you press Send."
      : " This compose no longer matches the reviewed draft. Nothing is sent until you press Send.";
  }
  if (state.composeQuote && state.composeQuote.kind === "forward" && attachmentNote(state.composeQuote.email)) {
    text += " Original files are not copied into this forward. Use Attach files to add them.";
  }
  const delayLabel = formatScheduleDelay(state.prefs.scheduleDelay);
  if (live && !review && delayLabel) {
    text += " Send schedules " + delayLabel + " ahead. Send now delivers immediately.";
  }
  $("compose-note").textContent = text;
}

function setComposeAttachError(text) {
  const el = $("compose-attach-error");
  if (!el) return;
  const message = text || "";
  el.hidden = !message;
  el.textContent = message;
}

function paintComposeAttachments() {
  const list = $("compose-attachments");
  if (!list || typeof list.replaceChildren !== "function") return;
  const rows = composeAttachmentList(state.composeAttachments);
  list.replaceChildren();
  const pending = (state.composeFileJobs || []).filter((job) => job.session === state.composeSession);
  list.hidden = !rows.length && !pending.length;
  for (const job of pending) {
    const item = document.createElement("li");
    item.textContent = "Preparing attachment: " + job.names.join(", ");
    list.appendChild(item);
  }
  const locked = !!(state.composePending || state.composeQueued || state.composeInitializing);
  for (const row of rows) {
    const item = typeof document.createElement === "function" ? document.createElement("li") : null;
    if (!item) continue;
    item.className = "compose-file";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.filename;
    const size = document.createElement("span");
    size.className = "size";
    const label = fileSize(row.size);
    size.textContent = label;
    if (!label) size.hidden = true;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.disabled = locked;
    if (typeof remove.setAttribute === "function") remove.setAttribute("aria-label", `Remove ${row.filename}`);
    if (typeof remove.addEventListener === "function") {
      remove.addEventListener("click", () => removeComposeAttachment(row.storageUrl));
    }
    if (typeof item.append === "function") item.append(name, size, remove);
    else if (typeof item.appendChild === "function") {
      item.appendChild(name);
      item.appendChild(size);
      item.appendChild(remove);
    }
    if (typeof list.appendChild === "function") list.appendChild(item);
  }
}

function removeComposeAttachment(storageUrl) {
  if (state.composePending || state.composeQueued || state.composeInitializing) return;
  state.composeAttachments = composeAttachmentList(state.composeAttachments).filter((row) => row.storageUrl !== storageUrl);
  setComposeAttachError("");
  paintComposeAttachments();
  paintComposeNote();
}

function composeFilesPending() {
  return (state.composeFileJobs || []).some((job) => job.session === state.composeSession);
}

async function addComposeFiles(list) {
  const incoming = Array.from(list || []);
  if (!incoming.length || state.composePending || state.composeQueued || state.composeInitializing) return;
  const provider = folderProvider(composeAccount());
  const review = reviewComposeFiles(state.composeAttachments, incoming.map((file) => ({
    filename: file && file.name,
    size: file && file.size,
  })), provider);
  const errors = review.errors.slice();
  const job = { session: state.composeSession, names: review.accepted.map((row) => row.filename) };
  const active = () => job.session === state.composeSession && !state.composeQueued && $("compose").open;
  state.composeFileJobs.push(job);
  syncComposeActions();
  paintComposeAttachments();
  try {
    for (const row of review.accepted) {
      if (!active()) return;
      const file = incoming[row.index];
      const name = row.filename;
      try {
        const bytes = file && typeof file.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : null;
        if (!active()) return;
        if (!bytes || !bytes.length) {
          errors.push(`${name} is empty.`);
          continue;
        }
        const saved = await call("mail:uploadAttachment", {
          filename: name,
          mimeType: (file && file.type) || "application/octet-stream",
          fileBytes: bytes,
        });
        if (!active()) return;
        const meta = composeFileMeta(saved);
        if (!meta) {
          errors.push(`Could not read ${name}. Remove it and attach the file again.`);
          continue;
        }
        const next = composeAttachmentList(state.composeAttachments.concat([meta]));
        const sum = next.reduce((total, item) => total + (Number(item.size) || 0), 0);
        const over = attachmentCapCopy(meta.filename, meta.size, sum, provider);
        if (over) {
          errors.push(over);
          continue;
        }
        state.composeAttachments = next;
        paintComposeAttachments();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!active()) return;
    setComposeAttachError(errors[0] || "");
    paintComposeNote();
  } finally {
    state.composeFileJobs = state.composeFileJobs.filter((item) => item !== job);
    if (active()) {
      syncComposeActions();
      paintComposeAttachments();
    }
  }
}

let composeDropDepth = 0;

function composeDragFiles(transfer) {
  if (!transfer || typeof transfer !== "object") return null;
  const types = Array.from(transfer.types || []);
  if (!types.includes("Files")) return null;
  return Array.from(transfer.files || []);
}

function composeDropLocked() {
  return !!(state.composePending || state.composeQueued || state.composeInitializing);
}

function setComposeDropHighlight(on) {
  const editor = $("compose-editor");
  if (!editor || !editor.classList) return;
  editor.classList.toggle("drop-target", !!on);
}

function resetComposeDrop() {
  composeDropDepth = 0;
  setComposeDropHighlight(false);
}

function onComposeDragEnter(event) {
  if (!event || !composeDragFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (composeDropLocked()) return;
  composeDropDepth += 1;
  setComposeDropHighlight(true);
}

function onComposeDragOver(event) {
  if (!event || !composeDragFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (composeDropLocked()) {
    setComposeDropHighlight(false);
    return;
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  setComposeDropHighlight(true);
}

function onComposeDragLeave() {
  if (!composeDropDepth) return;
  composeDropDepth -= 1;
  if (!composeDropDepth) setComposeDropHighlight(false);
}

function onComposeDrop(event) {
  resetComposeDrop();
  if (!event) return;
  const files = composeDragFiles(event.dataTransfer);
  if (!files) return;
  event.preventDefault();
  if (composeDropLocked() || !files.length) return;
  addComposeFiles(files).catch((error) => setComposeAttachError(error instanceof Error ? error.message : String(error)));
}

function wireComposeFileDrop() {
  const editor = $("compose-editor");
  if (!editor || typeof editor.addEventListener !== "function") return;
  editor.addEventListener("dragenter", onComposeDragEnter);
  editor.addEventListener("dragover", onComposeDragOver);
  editor.addEventListener("dragleave", onComposeDragLeave);
  editor.addEventListener("drop", onComposeDrop);
}

function paintComposeSuggestions() {
  const box = $("compose-suggestions");
  const status = $("compose-suggest-status");
  const list = $("compose-suggest-list");
  if (!box || !list || typeof list.replaceChildren !== "function") return;
  const view = state.composeSuggestions;
  list.replaceChildren();
  if (!view) {
    box.hidden = true;
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    return;
  }
  box.hidden = false;
  if (view.pending) {
    if (status) {
      status.hidden = false;
      status.className = "hint";
      status.textContent = "Suggesting replies…";
    }
    return;
  }
  if (view.error) {
    if (status) {
      status.hidden = false;
      status.className = "hint error";
      status.textContent = view.error;
    }
    return;
  }
  if (!view.items.length) {
    if (status) {
      status.hidden = false;
      status.className = "hint";
      status.textContent = "No reply suggestions.";
    }
    return;
  }
  if (status) {
    status.hidden = true;
    status.textContent = "";
  }
  for (const text of view.items) {
    if (typeof document.createElement !== "function") continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = text;
    if (typeof button.setAttribute === "function") button.setAttribute("aria-label", `Use suggested reply: ${text}`);
    if (typeof button.addEventListener === "function") button.addEventListener("click", () => applySuggestedReply(text));
    if (typeof list.appendChild === "function") list.appendChild(button);
  }
}

function applySuggestedReply(text) {
  const body = $("compose-body");
  const current = body && typeof body.value === "string" ? body.value : "";
  writeComposeBody(suggestedReplyBody(current, state.signatureText, text));
  const prompt = $("ai-prompt");
  if (prompt && !String(prompt.value || "").trim()) prompt.value = String(text || "").trim();
  if (state.prefs.aiReply !== false) openComposeAi();
  paintComposeNote();
}

async function showComposeSuggestions(fields) {
  const gen = composeSuggestGen += 1;
  const email = replySuggestionSource(fields);
  if (!email) {
    if (gen !== composeSuggestGen) return;
    state.composeSuggestions = null;
    paintComposeSuggestions();
    return;
  }
  state.composeSuggestions = { items: [], error: "", pending: true };
  paintComposeSuggestions();
  let next;
  try {
    const data = await call("aiDraftWrite:replySuggestions", { email: suggestionEmail(email), source: "compose-open" });
    next = { items: suggestionItems(data), error: "", pending: false };
  } catch (error) {
    next = {
      items: [],
      error: error instanceof Error ? error.message : String(error),
      pending: false,
    };
  }
  if (gen !== composeSuggestGen) return;
  state.composeSuggestions = next;
  paintComposeSuggestions();
}

function syncScheduleFields() {
  const custom = $("schedule-preset").value === "custom";
  $("schedule-at").hidden = !custom;
  $("schedule-at-label").hidden = !custom;
  const when = scheduleAt($("schedule-preset").value, $("schedule-at").value, new Date());
  $("schedule-note").textContent = (when ? "Scheduled time: " + shownWhen(when, true) + ". " : "Choose a future local time. ") + "Sends while the app is open. If Morrow Mail is closed at that time, it sends the next time you open it.";
}

function renderScheduled(rows) {
  const list = $("scheduled");
  const summary = $("scheduled-summary");
  const reviewCount = rows.filter(row => ["unknown", "sent", "partial"].includes(row.status)).length;
  const attention = $("scheduled-review-count");
  if (attention) { attention.textContent = reviewCount ? ` (${reviewCount} need review)` : ""; attention.hidden = !reviewCount; }
  const open = $("scheduled-open");
  if (open) open.title = reviewCount ? "Check Sent and review saved delivery records. These messages will not resend automatically." : "Scheduled mail";
  if (summary) summary.textContent = scheduledSummary(rows);
  list.replaceChildren();
  if (!rows.length) {
    const item = document.createElement("li");
    item.textContent = scheduledEmptyCopy();
    list.append(item);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = scheduledLine(row, state.accounts);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    const review = ["unknown", "sent", "partial"].includes(row.status);
    cancel.textContent = review ? "Dismiss record" : "Cancel";
    const subject = String((row && row.subject) || "").trim() || "(no subject)";
    cancel.setAttribute("aria-label", `${review ? "Dismiss delivery record" : "Cancel scheduled send"} ${subject}`);
    cancel.addEventListener("click", () => {
      requestCancelScheduled(row).catch((error) => {
        $("scheduled-status").textContent = error.message || String(error);
      });
    });
    cancel.disabled = row.status === "sending";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.textContent = review ? "Recover draft…" : "Edit/reschedule…";
    edit.disabled = row.status === "sending";
    edit.onclick = () => editScheduledMail(row).catch(error => { $("scheduled-status").textContent = error.message; });
    item.append(text, cancel, edit);
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

async function fillSignatures(preserveBody, fromChange = false) {
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
  if (gen !== signatureGen || state.composeQueued || state.composePending) return;
  const rows = signatureRows(pack);
  state.signaturePack = pack;
  state.signatures = rows;
  const identity = state.composeIdentity;
  const replaceBody = !preserveBody && (!fromChange || composeSignatureUntouched());
  if (replaceBody && fromChange && composeEditorLive()) {
    const signature = $("compose-editor").querySelector("[data-compose-signature]");
    // Align both text baselines before commitComposeSignature so an intact
    // HTML signature uses the node update rather than rebuilding the body.
    state.signatureText = signature ? plainFromComposeHtml(signature.innerHTML) : "";
    syncComposePlainFromEditor();
  }
  if (!rows.length) {
    showSignatureEmpty("No signatures.");
    if (replaceBody) {
      commitComposeSignature(state.signatureText, "");
      if (fromChange) state.signatureText = "";
    }
    if (identity) identity.signatureFollowsFrom = replaceBody;
    return;
  }
  const select = $("signature");
  $("signature-empty").hidden = true;
  select.hidden = false;
  select.replaceChildren();
  select.append(option("", "No signature"));
  for (const row of rows) select.append(option(String(row.id), signatureName(row)));
  if (!replaceBody) {
    select.value = "";
    if (identity) identity.signatureFollowsFrom = false;
    return;
  }
  const id = chosenSignatureId(pack, accountId, identity && identity.policyDomain);
  const match = rows.find((row) => String(row.id) === id);
  select.value = match ? String(match.id) : "";
  const text = signaturePlain(match);
  commitComposeSignature(state.signatureText, text, match ? signatureMarkup(match) : "");
  if (fromChange) state.signatureText = text;
  if (identity) identity.signatureFollowsFrom = true;
}

function onSignatureChange() {
  if (state.composeQueued || state.composePending) return;
  const row = state.signatures.find((item) => String(item.id) === $("signature").value);
  const text = signaturePlain(row);
  commitComposeSignature(state.signatureText, text, row ? signatureMarkup(row) : "");
  paintComposeNote();
}

function showSignatureStatus(text, isError) {
  const el = $("signatures-status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError && !!text);
}

function paintSignatureEditor(body, asHtml) {
  const editor = $("signature-editor");
  if (!editor || editor.nodeType !== 1 || typeof editor.replaceChildren !== "function") return;
  editor.replaceChildren();
  const value = String(body || "");
  if (!value.trim()) return;
  appendSafeMailHtml(editor, asHtml ? value : toHtml(value), false);
  revealEditorStyles(editor);
}

function showSignatureEditor(body, asHtml) {
  const htmlOn = !!($("signature-html") && $("signature-html").checked);
  const area = $("signature-body");
  const editor = $("signature-editor");
  const bar = $("signature-format");
  if (bar) bar.hidden = !htmlOn;
  if (editor) editor.hidden = !htmlOn;
  if (area) area.hidden = htmlOn;
  if (!htmlOn) return;
  paintSignatureEditor(body == null ? "" : body, asHtml === true);
}

function readSignatureEditorHtml() {
  const editor = $("signature-editor");
  if (!editor || editor.nodeType !== 1 || typeof editor.innerHTML !== "string") return "";
  if (blankComposeHtml(editor.innerHTML)) return "";
  try { return sanitizeComposeHtml(editor.innerHTML); } catch { return ""; }
}

function syncSignatureSource() {
  const box = $("signature-html");
  const area = $("signature-body");
  const editor = $("signature-editor");
  if (!box || !box.checked || !area || !editor) return;
  area.value = readSignatureEditorHtml();
}

function onSignatureHtmlToggle() {
  const box = $("signature-html");
  const area = $("signature-body");
  const editor = $("signature-editor");
  if (!box) return;
  if (box.checked) {
    showSignatureEditor(area ? area.value : "", false);
    return;
  }
  if (area) area.value = editor ? plainFromComposeHtml(editor.innerHTML || "") : area.value;
  if (editor) editor.hidden = true;
  const bar = $("signature-format");
  if (bar) bar.hidden = true;
  if (area) area.hidden = false;
}

function clearSignatureForm() {
  signatureEditorGeneration += 1;
  signatureEditId = "";
  signatureEditorIdentity = null;
  signatureEditorFocus = null;
  $("signature-name").value = "";
  $("signature-body").value = "";
  $("signature-html").checked = true;
  const legacyDefault = $("signature-default");
  if (legacyDefault) legacyDefault.checked = false;
  const legacyDomains = $("signature-domains");
  if (legacyDomains) legacyDomains.value = "";
  syncSignatureSave();
  $("signature-cancel").hidden = true;
  showSignatureStatus("");
  showSignatureEditor("", true);
}

function syncSignatureSave() {
  const pending = signatureSavePending === signatureEditorGeneration;
  $("signature-save").disabled = pending;
  const editing = signatureEditId || signatureEditorIdentity;
  $("signature-save").textContent = pending ? "Saving…" : editing ? "Save" : "Add";
  $("signature-form").setAttribute("aria-busy", String(pending));
}

function signatureDomainField(pack, accountId, signatureId) {
  const map = pack && pack.signatureByDomainPerAccount && accountId ? pack.signatureByDomainPerAccount[accountId] : null;
  if (!map || !signatureId) return "";
  return Object.keys(map).filter((domain) => map[domain] === signatureId).sort().join(", ");
}

function signatureBareAddress(value) {
  const text = String(value || "").trim();
  const match = text.match(/<([^<>]+)>/);
  return (match ? match[1] : text).trim().toLowerCase();
}

function signaturePolicyDomain(address, account, settings) {
  const policy = typeof window !== "undefined" && window.morrowComposePolicy;
  if (policy && typeof policy.policyDomain === "function") {
    return policy.policyDomain(address, account || { email: "" }, settings || { accounts: {} });
  }
  const bare = signatureBareAddress(address);
  const at = bare.lastIndexOf("@");
  const host = at >= 0 ? bare.slice(at + 1).replace(/^@/, "").toLowerCase() : "";
  const prefs = settings && settings.accounts && account && account.id ? settings.accounts[account.id] : null;
  const aliases = prefs && Array.isArray(prefs.aliases) ? prefs.aliases : [];
  for (const row of aliases) {
    if (!row || signatureBareAddress(row.address) !== bare || !row.domain) continue;
    const mapped = String(row.domain).replace(/^@/, "").trim().toLowerCase();
    if (mapped) return mapped;
  }
  return host;
}

function signatureDomainList(pack, accountId, signatureId) {
  const text = signatureDomainField(pack, accountId, signatureId);
  return text ? text.split(", ").filter(Boolean) : [];
}

function signatureRecordPayload(row) {
  const name = row && row.name ? String(row.name).trim() : "";
  const payload = { id: row && row.id ? String(row.id) : "", name: name || "Signature" };
  const html = row && typeof row.html === "string" ? row.html.trim() : "";
  if (html) payload.html = html;
  else payload.text = row && typeof row.text === "string" ? row.text : "";
  return payload;
}

function signatureIdentityRows(pack, account, settings) {
  const accountId = account && account.id ? String(account.id) : "";
  const stored = signatureRows(pack).filter((row) => !row.accountId || !accountId || String(row.accountId) === accountId);
  const byId = new Map(stored.map((row) => [String(row.id), row]));
  const defaultId = chosenSignatureId(pack, accountId);
  const domainMap = pack && pack.signatureByDomainPerAccount && accountId && pack.signatureByDomainPerAccount[accountId]
    ? pack.signatureByDomainPerAccount[accountId] : {};
  const primary = signatureBareAddress(account && account.email);
  const primaryHost = primary.includes("@") ? primary.slice(primary.lastIndexOf("@") + 1) : "";
  const addresses = [];
  const seen = new Set();
  function addAddress(value) {
    const email = signatureBareAddress(value);
    if (!email || seen.has(email)) return;
    seen.add(email);
    addresses.push(email);
  }
  addAddress(primary);
  const sendAs = account && Array.isArray(account.sendAs) ? account.sendAs : [];
  for (const row of sendAs) {
    if (!row || row.verificationStatus === "pending" || row.verified === false) continue;
    addAddress(row.email || row.sendAsEmail);
  }
  const prefs = settings && settings.accounts && accountId ? settings.accounts[accountId] : null;
  const aliases = prefs && Array.isArray(prefs.aliases) ? prefs.aliases : [];
  for (const row of aliases) addAddress(row && row.address);
  if (account && account.preferredFromAddress) addAddress(account.preferredFromAddress);
  if (prefs && prefs.preferredFromAddress) addAddress(prefs.preferredFromAddress);
  const groups = new Map();
  for (const email of addresses) {
    const domain = signaturePolicyDomain(email, account, settings);
    if (!domain) continue;
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(email);
  }
  for (const domain of Object.keys(domainMap)) {
    if (!groups.has(domain)) groups.set(domain, []);
  }
  const domains = [];
  for (const [domain, emails] of groups) {
    const bound = Object.hasOwn(domainMap, domain);
    const onlyPrimary = !emails.length || (emails.length === 1 && emails[0] === primary);
    // The primary host is already covered by Account default unless another address uses it or a row is saved.
    if (!bound && onlyPrimary && domain === primaryHost) continue;
    domains.push({ domain, emails });
  }
  domains.sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
  const defaultRow = byId.get(defaultId);
  const defaultName = defaultRow ? signatureName(defaultRow) : "";
  const email = account && account.email ? String(account.email) : "";
  const rows = [{
    key: "default",
    kind: "default",
    domain: "",
    label: "Account default",
    detail: defaultName ? (email ? email + " · " + defaultName : defaultName) : "Used when From has no domain signature",
    signatureId: defaultId || "",
  }];
  const used = new Set(defaultId ? [defaultId] : []);
  for (const item of domains) {
    const signatureId = Object.hasOwn(domainMap, item.domain) ? String(domainMap[item.domain] || "") : "";
    if (signatureId) used.add(signatureId);
    const row = byId.get(signatureId);
    const storedName = row ? signatureName(row) : "";
    const who = item.emails.length ? item.emails.join(", ") : "Saved domain";
    rows.push({
      key: "domain:" + item.domain,
      kind: "domain",
      domain: item.domain,
      label: item.domain,
      detail: storedName && storedName !== item.domain ? who + " · " + storedName : who,
      signatureId,
    });
  }
  for (const row of stored) {
    const id = String(row.id);
    if (used.has(id) || signatureDomainList(pack, accountId, id).length) continue;
    rows.push({
      key: "signature:" + id,
      kind: "extra",
      domain: "",
      label: signatureName(row),
      detail: "Saved signature, not used for a From domain",
      signatureId: id,
    });
  }
  return rows;
}

function signatureSavePlan(pack, account, settings, target, draft) {
  const accountId = account && account.id ? String(account.id) : "";
  const rows = signatureIdentityRows(pack, account, settings);
  const identity = rows.find((row) => row.key === (target && target.key)) || target || {};
  const base = signatureDraft(draft || {});
  base.accountId = accountId;
  const signatureId = identity.signatureId ? String(identity.signatureId) : "";
  const stored = signatureRows(pack).find((row) => String(row.id) === signatureId);
  if (identity.kind !== "domain" && identity.kind !== "default") {
    if (signatureId) base.id = signatureId;
    base.isDefault = false;
    delete base.domains;
    return [base];
  }
  if (identity.kind === "default") {
    const domains = signatureDomainList(pack, accountId, signatureId);
    if (signatureId && !domains.length) base.id = signatureId;
    else delete base.id;
    base.isDefault = true;
    delete base.domains;
    return [base];
  }
  const domain = identity.domain;
  const defaultId = chosenSignatureId(pack, accountId);
  const boundDomains = signatureDomainList(pack, accountId, signatureId);
  const exclusive = !!(stored && signatureId && signatureId !== defaultId && boundDomains.length === 1 && boundDomains[0] === domain);
  if (exclusive) {
    base.id = signatureId;
    base.isDefault = false;
    base.domains = [domain];
    return [base];
  }
  const steps = [];
  if (stored && signatureId && boundDomains.includes(domain)) {
    // Keep the shared body. Drop this domain first so the host can bind it to the new row.
    const keep = signatureRecordPayload(stored);
    keep.accountId = accountId;
    keep.domains = boundDomains.filter((item) => item !== domain);
    steps.push(keep);
  }
  delete base.id;
  base.isDefault = false;
  base.domains = domain ? [domain] : [];
  steps.push(base);
  return steps;
}

function signatureDeletePlan(pack, account, settings, target) {
  const accountId = account && account.id ? String(account.id) : "";
  const rows = signatureIdentityRows(pack, account, settings);
  const identity = rows.find((row) => row.key === (target && target.key)) || target || {};
  const id = identity.signatureId ? String(identity.signatureId) : "";
  if (!id) return [];
  const stored = signatureRows(pack).find((row) => String(row.id) === id);
  const sharers = rows.filter((row) => String(row.signatureId) === id);
  if (sharers.length <= 1 || !stored) return [{ delete: true, id }];
  if (identity.kind === "domain") {
    const keep = signatureRecordPayload(stored);
    keep.accountId = accountId;
    keep.domains = signatureDomainList(pack, accountId, id).filter((item) => item !== identity.domain);
    return [keep];
  }
  if (identity.kind === "default") {
    const keep = signatureRecordPayload(stored);
    keep.accountId = accountId;
    keep.isDefault = false;
    return [keep];
  }
  return [{ delete: true, id }];
}

function signatureSettings() {
  if (signatureEditorSettings) return signatureEditorSettings;
  const brain = typeof window !== "undefined" && window.morrowBrainCompose;
  if (brain && typeof brain.settings === "function") {
    const value = brain.settings();
    if (value) return value;
  }
  if (state.composeIdentity && state.composeIdentity.settings) return state.composeIdentity.settings;
  return { accounts: {} };
}

function signatureFocusRow(rows, focus, account, settings) {
  const list = Array.isArray(rows) ? rows : [];
  if (focus && focus.key) {
    const match = list.find((row) => row.key === focus.key);
    if (match) return match;
  }
  if (focus && focus.email) {
    const domain = signaturePolicyDomain(focus.email, account, settings);
    const match = list.find((row) => row.kind === "domain" && row.domain === domain);
    if (match) return match;
  }
  return list.find((row) => row.kind === "default") || list[0] || null;
}

function signatureGroupLabel(text) {
  const label = document.createElement("p");
  label.className = "hint signature-group";
  label.textContent = text;
  return label;
}

function signatureIdentityLine(identity) {
  const line = document.createElement("div");
  line.className = "signature-row";
  line.dataset.signatureKey = identity.key;
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "signature-pick";
  pick.setAttribute("aria-pressed", "false");
  const label = document.createElement("span");
  label.className = "signature-label";
  label.textContent = identity.label;
  const detail = document.createElement("span");
  detail.className = "hint";
  detail.textContent = identity.detail || "";
  pick.append(label, detail);
  pick.addEventListener("click", () => selectSignatureIdentity(identity, true));
  line.appendChild(pick);
  if (identity.signatureId) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete " + identity.label);
    del.addEventListener("click", () => {
      removeSignatureIdentity(identity).catch((error) => {
        showSignatureStatus(error instanceof Error ? error.message : String(error), true);
      });
    });
    line.appendChild(del);
  }
  return line;
}

function markSignatureSelection(key) {
  const root = $("signature-list");
  if (!root || !root.children) return;
  for (const row of root.children) {
    const on = !!(row.dataset && row.dataset.signatureKey === key);
    if (row.classList) row.classList.toggle("is-selected", on);
    const pick = row.children && row.children[0];
    if (pick && pick.classList && pick.classList.contains("signature-pick")) pick.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function selectSignatureIdentity(identity, focus) {
  if (!identity) return;
  if (focus) signatureEditorGeneration += 1;
  signatureEditorIdentity = {
    key: identity.key,
    kind: identity.kind,
    domain: identity.domain || "",
    label: identity.label || "",
    signatureId: identity.signatureId || "",
  };
  const row = signatureRows(signatureEditorPack).find((item) => String(item.id) === String(identity.signatureId || ""));
  const fields = row
    ? signatureFields(row, identity.kind === "default")
    : { id: "", name: identity.label || "", body: "", html: true, isDefault: identity.kind === "default" };
  signatureEditId = fields.id;
  $("signature-name").value = fields.name;
  $("signature-body").value = fields.body;
  $("signature-html").checked = row ? fields.html : true;
  const legacyDefault = $("signature-default");
  if (legacyDefault) legacyDefault.checked = identity.kind === "default";
  const legacyDomains = $("signature-domains");
  if (legacyDomains) legacyDomains.value = identity.kind === "domain" ? identity.domain || "" : "";
  syncSignatureSave();
  $("signature-cancel").hidden = false;
  if (focus) showSignatureStatus("");
  showSignatureEditor(fields.body, row ? fields.html : true);
  markSignatureSelection(identity.key);
  if (focus) $("signature-name").focus();
}

function paintSignatures(pack) {
  signatureEditorPack = pack;
  const root = $("signature-list");
  root.replaceChildren();
  const account = signatureAccount();
  const settings = signatureSettings();
  const rows = signatureIdentityRows(pack, account, settings);
  let grouped = false;
  let extras = false;
  for (const identity of rows) {
    if (identity.kind === "domain" && !grouped) {
      root.appendChild(signatureGroupLabel("Send-as domains"));
      grouped = true;
    }
    if (identity.kind === "extra" && !extras) {
      root.appendChild(signatureGroupLabel("Other saved signatures"));
      extras = true;
    }
    root.appendChild(signatureIdentityLine(identity));
  }
  syncSignatureSave();
  const current = signatureEditorIdentity;
  if (current || signatureEditId) {
    const fresh = current && rows.find((row) => row.key === current.key);
    if (fresh) {
      current.signatureId = fresh.signatureId || "";
      if (fresh.signatureId) signatureEditId = fresh.signatureId;
      markSignatureSelection(fresh.key);
    }
    $("signature-cancel").hidden = false;
    return;
  }
  const request = signatureEditorFocus;
  signatureEditorFocus = null;
  const picked = signatureFocusRow(rows, request, account, settings);
  if (picked) selectSignatureIdentity(picked, !!request);
}

function startSignatureEdit(row, isDefault) {
  signatureEditorGeneration += 1;
  signatureEditorIdentity = null;
  const fields = signatureFields(row, isDefault);
  signatureEditId = fields.id;
  $("signature-name").value = fields.name;
  $("signature-body").value = fields.body;
  $("signature-html").checked = fields.html;
  const legacyDefault = $("signature-default");
  if (legacyDefault) legacyDefault.checked = fields.isDefault;
  const legacyDomains = $("signature-domains");
  if (legacyDomains) legacyDomains.value = signatureDomainField(signatureEditorPack, signatureAccount()?.id, fields.id);
  syncSignatureSave();
  $("signature-cancel").hidden = false;
  showSignatureStatus("");
  showSignatureEditor(fields.body, fields.html);
  $("signature-name").focus();
}

async function loadSignatureEditor() {
  const gen = ++signatureListGen;
  const generation = signatureEditorGeneration;
  const accountId = signatureAccount()?.id;
  const pack = await call("mail:listSignatures", accountId ? { accountId } : {});
  if (gen === signatureListGen && generation === signatureEditorGeneration
      && $("signatures").open && signatureAccount()?.id === accountId) paintSignatures(pack);
  return pack;
}

function ensureSignatureSettings() {
  const generation = signatureEditorGeneration;
  const accountId = signatureEditorAccountId;
  call("emailBrain:getComposeSettings").then((value) => {
    if (!$("signatures").open || signatureEditorGeneration !== generation || signatureEditorAccountId !== accountId) return;
    if (!value || signatureEditorSettings) return;
    signatureEditorSettings = value;
    loadSignatureEditor().catch((error) => {
      showSignatureStatus(error instanceof Error ? error.message : String(error), true);
    });
  }).catch(() => {});
}

function openSignatures(accountId, focus) {
  const explicit = typeof accountId === "string" ? accountId : "";
  const request = focus && typeof focus === "object" && !focus.preventDefault ? focus : null;
  signatureEditorAccountId = explicit || ($("settings").open ? settingsAccount() : composeAccount())?.id || settingsAccount()?.id || "";
  $("signatures-title").textContent = "Signatures · " + (signatureAccount()?.email || "No mailbox");
  clearSignatureForm();
  signatureEditorSettings = null;
  if (request && request.settings) signatureEditorSettings = request.settings;
  else if (typeof window !== "undefined" && window.morrowBrainCompose && typeof window.morrowBrainCompose.settings === "function") {
    const value = window.morrowBrainCompose.settings();
    if (value) signatureEditorSettings = value;
  }
  if (!signatureEditorSettings && state.composeIdentity && state.composeIdentity.settings) {
    signatureEditorSettings = state.composeIdentity.settings;
  }
  signatureEditorFocus = request;
  showSignatureStatus("");
  openDialog("signatures");
  if (!signatureEditorSettings) ensureSignatureSettings();
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
  const generation = signatureEditorGeneration;
  if (signatureSavePending === generation) return;
  if ($("signature-html") && $("signature-html").checked) syncSignatureSource();
  const identity = signatureEditorIdentity;
  let name = $("signature-name").value;
  if (identity && !String(name || "").trim() && identity.label) name = identity.label;
  const legacyDefault = $("signature-default");
  const legacyDomains = $("signature-domains");
  const source = {
    id: identity ? "" : signatureEditId,
    name,
    body: $("signature-body").value,
    html: $("signature-html").checked,
    isDefault: identity ? false : !!(legacyDefault && legacyDefault.checked),
    domains: identity || !legacyDomains ? undefined : legacyDomains.value.split(/[,;\s]+/).map((token) => token.trim()).filter(Boolean),
  };
  const draft = signatureDraft(source);
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
  const steps = identity
    ? signatureSavePlan(signatureEditorPack, account, signatureSettings(), identity, source)
    : [{ ...draft, accountId: account.id }];
  const ownsEditor = () => generation === signatureEditorGeneration
    && signatureAccount()?.id === account.id && $("signatures").open;
  signatureSavePending = generation;
  syncSignatureSave();
  showSignatureStatus("Saving…");
  try {
    let saved = null;
    for (const step of steps) {
      saved = await call("mail:upsertSignature", step);
      if (!ownsEditor()) return;
    }
    signatureEditId = saved && saved.id ? String(saved.id) : "";
    if (signatureEditorIdentity && signatureEditId) signatureEditorIdentity.signatureId = signatureEditId;
    showSignatureStatus("Saved.");
    await loadSignatureEditor();
    if (!ownsEditor()) return;
    await refreshComposeSignatures();
  } catch (error) {
    if (ownsEditor()) showSignatureStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    if (signatureSavePending === generation) signatureSavePending = null;
    if (ownsEditor()) syncSignatureSave();
  }
}

async function removeSignature(id) {
  await call("mail:deleteSignature", { id });
  if (signatureEditId === id) clearSignatureForm();
  showSignatureStatus("Deleted.");
  await loadSignatureEditor();
  await refreshComposeSignatures();
}

async function removeSignatureIdentity(identity) {
  const account = signatureAccount();
  const plan = signatureDeletePlan(signatureEditorPack, account, signatureSettings(), identity);
  if (!plan.length) return;
  for (const step of plan) {
    if (step.delete) await call("mail:deleteSignature", { id: step.id });
    else await call("mail:upsertSignature", step);
  }
  if (signatureEditorIdentity && identity && signatureEditorIdentity.key === identity.key) clearSignatureForm();
  showSignatureStatus("Deleted.");
  await loadSignatureEditor();
  await refreshComposeSignatures();
}

function readAiMode() {
  const input = $("ai-mode");
  const value = input && input.value;
  if (value === "continue" || value === "custom" || value === "reply" || value === "rewrite") return value;
  return "rewrite";
}

function currentReplyThreadEmail() {
  const quote = state.composeQuote;
  if (!quote) return null;
  const subjectField = $("compose-subject");
  return replyThreadEmail({
    kind: quote.kind,
    quoteEmail: quote.email,
    quote: quote.text,
    subject: subjectField && subjectField.value ? subjectField.value : "",
  });
}

function composeAiLocked() {
  return !!(state.composeQueued || state.composePending || state.composeInitializing);
}

function paintComposeAi() {
  const pending = !!(state.draftWrite && state.draftWrite.pending);
  const locked = composeAiLocked();
  const available = !!currentReplyThreadEmail();
  const mode = readAiMode();
  const group = $("compose-ai-modes");
  if (group && typeof group.querySelectorAll === "function") {
    for (const button of group.querySelectorAll("[data-ai-mode]")) {
      const reply = button.getAttribute("data-ai-mode") === "reply";
      button.disabled = locked || pending || (reply && !available);
      if (reply) {
        if (typeof button.setAttribute === "function") button.setAttribute("aria-disabled", available ? "false" : "true");
        button.title = available ? "Draft a full reply from the original message" : "No original message on this draft";
      }
    }
  }
  const note = $("compose-ai-note");
  if (note) {
    if (!available) {
      note.hidden = false;
      note.textContent = "Reply from thread needs the original message.";
    } else if (mode === "reply") {
      note.hidden = false;
      note.textContent = "Uses the original message. An empty prompt writes a full reply.";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }
  const prompt = $("ai-prompt");
  if (prompt) prompt.disabled = locked || pending;
  const go = $("ai-generate");
  if (go) go.disabled = locked || pending || (mode === "reply" && !available);
  const pop = $("compose-ai-popover");
  if (pop && typeof pop.setAttribute === "function") pop.setAttribute("aria-busy", pending ? "true" : "false");
  const cancel = $("ai-cancel");
  if (cancel) {
    cancel.hidden = false;
    cancel.disabled = locked && !pending;
  }
}

function setAiMode(mode) {
  const next = mode === "continue" || mode === "custom" || mode === "reply" || mode === "rewrite" ? mode : "rewrite";
  const input = $("ai-mode");
  if (input) input.value = next;
  const group = $("compose-ai-modes");
  if (group && typeof group.querySelectorAll === "function") {
    for (const button of group.querySelectorAll("[data-ai-mode]")) {
      const on = button.getAttribute("data-ai-mode") === next;
      if (typeof button.setAttribute === "function") button.setAttribute("aria-checked", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
    }
  }
  const prompt = $("ai-prompt");
  if (prompt) {
    if (next === "reply") prompt.placeholder = "Optional: tone or points to cover";
    else if (next === "continue") prompt.placeholder = "What should come next?";
    else if (next === "custom") prompt.placeholder = "Type your prompt...";
    else prompt.placeholder = "How should this read?";
  }
  paintComposeAi();
}

function composeAiOpen() {
  const pop = $("compose-ai-popover");
  return !!(pop && !pop.hidden);
}

function openComposeAi(options) {
  const pop = $("compose-ai-popover");
  const btn = $("compose-ai-open");
  if (!pop) return;
  pop.hidden = false;
  if (pop.classList && typeof pop.classList.add === "function") pop.classList.add("open");
  if (btn && typeof btn.setAttribute === "function") btn.setAttribute("aria-expanded", "true");
  paintComposeAi();
  if (options && options.focus === false) return;
  const prompt = $("ai-prompt");
  if (prompt && !prompt.disabled && typeof prompt.focus === "function") prompt.focus();
}

function closeComposeAi(options) {
  const pop = $("compose-ai-popover");
  const btn = $("compose-ai-open");
  if (pop) {
    pop.hidden = true;
    if (pop.classList && typeof pop.classList.remove === "function") pop.classList.remove("open");
  }
  if (btn && typeof btn.setAttribute === "function") btn.setAttribute("aria-expanded", "false");
  if (options && options.restore && btn && !btn.disabled && typeof btn.focus === "function") btn.focus();
}

function toggleComposeAi() {
  if (composeAiOpen()) closeComposeAi({ restore: true });
  else openComposeAi();
}

function composeAiFocusables() {
  const pop = $("compose-ai-popover");
  if (!pop || typeof pop.querySelectorAll !== "function") return [];
  return [...pop.querySelectorAll("button, input, textarea")].filter((el) => {
    if (!el || el.disabled || el.type === "hidden" || el.tabIndex < 0) return false;
    return true;
  });
}

function onComposeAiTab(event) {
  if (!event || event.key !== "Tab" || !composeAiOpen()) return;
  const pop = $("compose-ai-popover");
  if (!pop || !event.target || typeof pop.contains !== "function" || !pop.contains(event.target)) return;
  const items = composeAiFocusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && event.target === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && event.target === last) {
    event.preventDefault();
    first.focus();
  }
}

function onAiModeKeydown(event) {
  if (!event) return;
  const order = ["rewrite", "continue", "custom", "reply"];
  const current = order.indexOf(readAiMode());
  let next = current < 0 ? 0 : current;
  let direction = 1;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next += 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    next -= 1;
    direction = -1;
  } else if (event.key === "Home") next = 0;
  else if (event.key === "End") {
    next = order.length - 1;
    direction = -1;
  } else return;
  event.preventDefault();
  const group = $("compose-ai-modes");
  for (let n = 0; n < order.length; n += 1) {
    const mode = order[(next + (n * direction) + (order.length * 2)) % order.length];
    const button = group && typeof group.querySelector === "function" ? group.querySelector(`[data-ai-mode="${mode}"]`) : null;
    if (button && !button.disabled) {
      setAiMode(mode);
      if (typeof button.focus === "function") button.focus();
      return;
    }
  }
}

function onComposeAiPointerDown(event) {
  if (!composeAiOpen()) return;
  const target = event && event.target;
  if (target && typeof target.closest === "function" && (target.closest("#compose-ai-popover") || target.closest("#compose-ai-open"))) return;
  closeComposeAi({ restore: false });
}

async function dismissComposeAi() {
  if (state.draftWrite && state.draftWrite.pending) await cancelDraftWrite();
  closeComposeAi({ restore: true });
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
  if (cancel) cancel.hidden = false;
  const go = $("ai-generate");
  if (go) go.disabled = false;
  const body = $("compose-body");
  if (body) body.readOnly = false;
  setComposeEditorEditable(true);
}

function paintDraft() {
  if (state.composeQueued || state.composePending) return;
  syncComposeActions();
  const view = state.draftWrite;
  const pending = !!(view && view.pending);
  const error = $("ai-write-error");
  const body = $("compose-body");
  if (body) body.readOnly = pending;
  setComposeEditorEditable(!pending);
  if (error) {
    const message = view && view.error ? view.error : "";
    error.hidden = !message;
    error.textContent = message;
  }
  if (view && body) writeComposeBody(shownDraft(view));
  paintComposeAi();
}

function onDraftEvent(event) {
  if (!state.draftWrite?.pending || !event || event.reqId !== state.draftWrite.reqId) return;
  if (!["chunk", "error", "done"].includes(event.type)) return;
  applyDraftEvent(state.draftWrite, event);
  if (!$("compose").open) return;
  paintDraft();
}

async function startDraftWrite() {
  if (state.composeQueued || state.composePending || state.composeInitializing) return;
  const mode = readAiMode();
  const prompt = $("ai-prompt").value;
  const existing = $("compose-body").value;
  const thread = currentReplyThreadEmail();
  const source = mode === "reply" ? thread : replySuggestionSource({
    quoteEmail: state.composeQuote && state.composeQuote.email,
    kind: state.composeQuote && state.composeQuote.kind,
  });
  const parts = mode === "reply" ? splitComposeSignature(existing, state.signatureText) : null;
  const draftExisting = parts ? parts.message : existing;
  const reason = draftBlockReason(mode, prompt, draftExisting, source);
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
    base: draftBase(mode, draftExisting),
    previous: existing,
    signatureTail: parts && parts.signature ? parts.signature : "",
  };
  paintDraft();
  try {
    await call("aiDraftWrite:start", {
      reqId,
      body: draftInstruction(mode, prompt, draftExisting, $("compose-subject").value, source),
    });
  } catch (error) {
    if (!state.draftWrite?.pending || state.draftWrite.reqId !== reqId) return;
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
    block.className = "body is-plain";
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
    when.textContent = Number.isNaN(date.getTime()) ? String(email.date) : shownWhen(date);
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
  if (toggleLabel) toggleLabel.textContent = shown ? "Hide original preview" : "Show original preview";
  pane.hidden = !shown;
  pane.setAttribute("aria-hidden", shown ? "false" : "true");
  handle.hidden = !(shown && wide);
  note.hidden = false;
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

// shortcut: the same address on two mailboxes stays with the current one; give options distinct values if both copies must be selectable.
function composeFromChoices(activeSendAs) {
  const activeId = state.composeMeta && state.composeMeta.accountId;
  const live = [];
  for (const account of state.accounts) if (isLive(account)) live.push(account);
  live.sort((a, b) => (a.id === activeId ? 0 : 1) - (b.id === activeId ? 0 : 1));
  const seen = new Set();
  const groups = [];
  for (const account of live) {
    const source = account.id === activeId && Array.isArray(activeSendAs) ? activeSendAs : (account.sendAs || []);
    const options = [];
    for (const row of source) {
      const email = row && row.email;
      if (!email || seen.has(email)) continue;
      seen.add(email);
      options.push(row);
    }
    if (options.length) groups.push({ id: account.id, label: account.email || account.id, options });
  }
  return groups;
}

function composeFromAccountId(email) {
  const activeId = state.composeMeta && state.composeMeta.accountId;
  const identity = state.composeIdentity && state.composeIdentity.sendAs;
  if ((identity || []).some((row) => row && row.email === email)) return activeId;
  for (const account of state.accounts) {
    if (!isLive(account) || account.id === activeId) continue;
    if ((account.sendAs || []).some((row) => row && row.email === email)) return account.id;
  }
  return activeId;
}

function paintComposeFromPicker(context) {
  const picker = $("compose-from");
  const rows = context && context.sendAs || [];
  picker.replaceChildren();
  const listed = new Set();
  for (const group of composeFromChoices(rows)) {
    const shell = document.createElement("optgroup");
    shell.label = group.label;
    const nested = typeof shell.appendChild === "function";
    const parent = nested ? shell : picker;
    for (const row of group.options) {
      listed.add(row.email);
      const node = option(row.email, window.morrowComposePolicy.senderPreview(row.email, row.displayName || ""));
      if (node.dataset) node.dataset.accountId = group.id;
      if (typeof parent.appendChild === "function") parent.appendChild(node);
    }
    if (nested && typeof picker.appendChild === "function") picker.appendChild(shell);
  }
  const selected = context && context.fromAddress;
  if (selected && !listed.has(selected)) {
    picker.appendChild(option(selected, selected + " (saved address — configure in Brain)"));
  }
  if (selected) picker.value = selected;
}

async function initializeComposeIdentity(fields) {
  const account = composeAccount();
  const picker = $("compose-from");
  picker.replaceChildren();
  $("compose-from-note").textContent = "";
  if (!account) return;
  const context = await call("mail:getComposeContext", { accountId: account.id,
    sourceMessageId: fields.sourceMessageId || undefined, kind: fields.kind || "new",
    fromAddress: fields.fromAddress || undefined });
  if (!context || !context.fromAddress) throw new Error("The mailbox did not return a From address.");
  state.composeMeta.fromAddress = context.fromAddress;
  state.composeMeta.fromDisplayName = typeof fields.fromDisplayName === "string"
    ? window.morrowComposePolicy.displayName(fields.fromDisplayName) : context.fromDisplayName || "";
  if ((fields.kind === "reply" || fields.kind === "all") && fields.quoteEmail && !fields.draftId && !fields.botDraft) {
    const parties = replyParties({ ...fields.quoteEmail, ...(Array.isArray(context.replyTo) ? { replyTo: context.replyTo } : {}) }, context.selfAddresses, fields.kind === "all");
    $("compose-to").value = parties.to;
    $("compose-cc").value = parties.cc;
  }
  const savedRecipients = !!fields.draftId || !!fields.botDraft || !!fields.partialReceipt || !!fields.recoveredSnapshot;
  state.composeIdentity = { ...context, kind: fields.kind || "new",
    seeds: window.morrowComposePolicy.openRecipientSeeds(savedRecipients, $("compose-cc").value, $("compose-bcc").value) };
  paintComposeFromPicker(state.composeIdentity);
  applyComposeRecipients();
  paintComposeIdentity();
}

function applyComposeRecipients() {
  const context = state.composeIdentity;
  if (!context || !context.seeds) return;
  const seeded = window.morrowComposePolicy.applyRecipientSeeds(context.seeds,
    { cc: context.defaultCc, bcc: context.defaultBcc },
    { to: $("compose-to").value, cc: $("compose-cc").value, bcc: $("compose-bcc").value },
    context.selfAddresses);
  $("compose-cc").value = seeded.cc;
  $("compose-bcc").value = seeded.bcc;
  syncComposeRecipientRows();
}

function paintComposeIdentity() {
  const context = state.composeIdentity;
  if (!context) return;
  const row = context.sendAs.find((item) => item.email === state.composeMeta.fromAddress);
  for (const choice of $("compose-from").options || []) {
    const identity = context.sendAs.find(item => item.email === choice.value);
    if (identity) choice.textContent = window.morrowComposePolicy.senderPreview(choice.value,
      choice.value === state.composeMeta.fromAddress ? state.composeMeta.fromDisplayName : identity.displayName || "");
  }
  const text = [];
  text.push("Recipients see: " + window.morrowComposePolicy.senderPreview(state.composeMeta.fromAddress, state.composeMeta.fromDisplayName) + ".");
  const mailbox = composeAccount();
  if (mailbox && state.accounts.filter(isLive).length > 1) text.push("Mailbox: " + mailbox.email + ".");
  if (context.receivedAddress) text.push("Received as " + context.receivedAddress + ".");
  else if (context.fallback) text.push("No received address matched this mailbox's known aliases. Add a missing alias in Email Brain or choose From.");
  text.push("CC domain: " + (context.domain || "none") + ".");
  if (context.policyDomain && context.policyDomain !== context.domain) text.push("Signature domain: " + context.policyDomain + ".");
  if (row && row.source === "configured") text.push("Confirm this alias is enabled for sending with your provider.");
  if (context.warning) text.push(context.warning);
  $("compose-from-note").textContent = text.join(" ");
}

function changeComposeFrom() {
  if (!state.composeIdentity || state.composePending || state.composeQueued || state.composeInitializing) return;
  const fromAddress = $("compose-from").value;
  const nextId = composeFromAccountId(fromAddress);
  if (nextId && state.composeMeta && nextId !== state.composeMeta.accountId) return switchComposeMailbox(nextId, fromAddress);
  const context = state.composeIdentity;
  state.composeMeta.fromAddress = fromAddress;
  state.composeMeta.fromDisplayName = context.sendAs.find((row) => row.email === fromAddress)?.displayName || "";
  const account = composeAccount();
  const defaults = window.morrowComposePolicy.recipientDefaults(fromAddress, account, context.settings, context.kind);
  context.domain = defaults.ccDomain;
  context.policyDomain = defaults.policyDomain;
  context.defaultCc = defaults.cc;
  context.defaultBcc = defaults.bcc;
  applyComposeRecipients();
  const untouched = composeSignatureUntouched();
  if (untouched && composeEditorLive()) {
    const node = $("compose-editor").querySelector("[data-compose-signature]");
    state.signatureText = node ? plainFromComposeHtml(node.innerHTML) : "";
    syncComposePlainFromEditor();
  }
  const signature = applyFromSignature({
    follows: context.signatureFollowsFrom && untouched,
    body: $("compose-body").value,
    previous: state.signatureText,
    pack: state.signaturePack,
    accountId: account && account.id,
    policyDomain: defaults.policyDomain,
    rows: state.signatures,
  });
  if (signature.applied) {
    $("compose-body").value = signature.body;
    state.signatureText = signature.previous;
    state.signatureHtml = signature.previous ? (signature.html || toHtml(signature.previous)) : "";
    const select = $("signature");
    if (!select.hidden) select.value = signature.pickerId || "";
    if (composeEditorLive()) updateComposeSignatureNode(signature.previous, state.signatureHtml);
  }
  paintComposeIdentity();
  paintComposeNote();
}

async function switchComposeMailbox(accountId, fromAddress) {
  const session = state.composeSession;
  const previous = {
    accountId: state.composeMeta.accountId,
    draftId: state.draftId,
    draftRevision: state.draftRevision,
    threadId: state.composeMeta.threadId,
    fromAddress: state.composeMeta.fromAddress,
    fromDisplayName: state.composeMeta.fromDisplayName,
    identity: state.composeIdentity,
  };
  state.composeInitializing = true;
  syncCompose();
  state.composeMeta.accountId = accountId;
  // The previous draft id belongs to the other mailbox. Leave that draft where it is.
  state.draftId = null;
  state.draftRevision = null;
  state.composeMeta.threadId = "";
  let switched = false;
  try {
    const context = await call("mail:getComposeContext", {
      accountId, kind: previous.identity.kind || "new", fromAddress,
    });
    if (session !== state.composeSession) return;
    const rows = context && context.sendAs || [];
    if (!rows.some((row) => row && row.email === fromAddress)) throw new Error("That address is not authorized for this mailbox.");
    const follows = !!previous.identity.signatureFollowsFrom;
    state.composeMeta.fromAddress = fromAddress;
    state.composeMeta.fromDisplayName = rows.find((row) => row.email === fromAddress).displayName || "";
    state.composeIdentity = {
      ...context,
      kind: previous.identity.kind || "new",
      seeds: previous.identity.seeds,
      signatureFollowsFrom: follows,
    };
    paintComposeFromPicker(state.composeIdentity);
    $("compose-from").value = fromAddress;
    applyComposeRecipients();
    await fillSignatures(!follows, true);
    if (session !== state.composeSession) return;
    paintComposeIdentity();
    paintComposeNote();
    switched = true;
    if (previous.draftId) setComposeStatus("The earlier draft stays in the original mailbox. Save draft stores a new copy here.");
  } catch (error) {
    if (session !== state.composeSession) return;
    state.composeMeta.accountId = previous.accountId;
    state.draftId = previous.draftId;
    state.draftRevision = previous.draftRevision;
    state.composeMeta.threadId = previous.threadId;
    state.composeMeta.fromAddress = previous.fromAddress;
    state.composeMeta.fromDisplayName = previous.fromDisplayName;
    state.composeIdentity = previous.identity;
    paintComposeFromPicker(previous.identity);
    $("compose-from").value = previous.fromAddress || "";
    paintComposeIdentity();
    $("compose-from-note").textContent = "Could not switch mailbox. " + (error.message || String(error));
  } finally {
    if (session === state.composeSession) {
      state.composeInitializing = false;
      syncCompose();
      if (switched) paintComposeNote();
    }
  }
}

function isReaderWindow() {
  try {
    const root = document.documentElement;
    if (root && root.dataset && root.dataset.window === "reader") return true;
    const search = window.location && window.location.search;
    if (typeof search === "string" && new URLSearchParams(search).get("role") === "reader") {
      if (root && root.dataset) root.dataset.window = "reader";
      return true;
    }
  } catch { /* vm checks have no location */ }
  return false;
}

function isTranslateWindow() {
  try {
    const root = document.documentElement;
    if (root && root.dataset && root.dataset.window === "translate") return true;
    const search = window.location && window.location.search;
    if (typeof search === "string" && new URLSearchParams(search).get("role") === "translate") {
      if (root && root.dataset) root.dataset.window = "translate";
      return true;
    }
  } catch { /* vm checks have no location */ }
  return false;
}

function isComposeWindow() {
  try {
    const root = document.documentElement;
    if (root && root.dataset && root.dataset.window === "compose") return true;
    const search = window.location && window.location.search;
    if (typeof search === "string" && new URLSearchParams(search).get("role") === "compose") {
      if (root && root.dataset) root.dataset.window = "compose";
      return true;
    }
  } catch { /* vm checks have no location */ }
  return false;
}

let composeWindowClosing = false;
let composeCloseQueued = false;

function newMailSeed() {
  const account = selectedAccount();
  return { title: "New message", kind: "new", accountId: (account && account.id) || state.accountId || "" };
}

function cloneComposeSeed(seed) {
  try {
    return JSON.parse(JSON.stringify(seed || {}));
  } catch {
    throw new Error("That message could not be opened in a compose window.");
  }
}

async function presentCompose(seed) {
  if (api && typeof api.openComposeWindow === "function") {
    await api.openComposeWindow(cloneComposeSeed(seed));
    return;
  }
  await openCompose(seed || {});
}

function publishComposeTitle(text) {
  if (!isComposeWindow()) return;
  const title = String(text || "New message").trim() || "New message";
  document.title = title + " — Morrow Mail";
  if (api && typeof api.setComposeTitle === "function") api.setComposeTitle(title).catch(() => {});
}

function dismissComposeSurface() {
  if (isComposeWindow()) {
    requestComposeWindowClose().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
    return;
  }
  requestComposeClose();
}

async function requestComposeWindowClose() {
  if (!isComposeWindow()) return requestComposeClose();
  if (composeWindowClosing) return;
  if (state.composeInitializing) {
    composeCloseQueued = true;
    return;
  }
  if (state.composePending && !sendTimer) {
    setComposeStatus("Finish the current action before closing.", true);
    showStatus("Finish the current action before closing.", true);
    return;
  }
  composeWindowClosing = true;
  try {
    if (sendTimer) {
      hideUndoSend();
      setComposeStatus("Send canceled. Your draft is ready to edit.");
    }
    const closed = await requestComposeClose();
    if (!closed) {
      if (!$("compose").open) {
        openDialog("compose");
        scheduleComposeLayout();
      }
      return;
    }
    if (api && typeof api.allowComposeClose === "function") api.allowComposeClose();
  } finally {
    composeWindowClosing = false;
  }
}

function flushComposeWindowClose() {
  if (!composeCloseQueued || !isComposeWindow()) return;
  composeCloseQueued = false;
  requestComposeWindowClose().catch(() => {});
}

function finishComposeOpen(fields) {
  if (fields && fields.status && !state.composeIdentityError) setComposeStatus(fields.status);
  flushComposeWindowClose();
}

async function loadComposeAccounts() {
  const data = await call("mail:listAccounts");
  acceptBodyAccounts(Array.isArray(data) ? data : []);
  if (!state.accountId && state.accounts[0]) state.accountId = state.accounts[0].id;
}

async function bootComposeWindow() {
  try { document.documentElement.dataset.window = "compose"; } catch { /* the page is still the compose surface */ }
  if (!api) {
    showStatus("Mail preload is unavailable.", true);
    return;
  }
  api.on("compose:requestClose", () => {
    requestComposeWindowClose().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
  });
  api.on("aiDraftWrite:event", onDraftEvent);
  api.on("mail:accountsUpdated", (payload) => {
    const accounts = payload && Array.isArray(payload.accounts) ? payload.accounts : null;
    if (accounts) acceptBodyAccounts(accounts);
  });
  wire();
  let seed = {};
  try {
    if (typeof api.pullComposeSeed === "function") seed = (await api.pullComposeSeed()) || {};
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
  publishComposeTitle((seed && seed.title) || "New message");
  await loadLook();
  await loadShellPrefs();
  try { await loadComposeAccounts(); }
  catch (error) { showStatus(error instanceof Error ? error.message : String(error), true); }
  if (seed && seed.accountId) state.accountId = seed.accountId;
  try { await openCompose(seed || {}); }
  catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
    flushComposeWindowClose();
  }
}

const READER_CLOSE_ICON = ["M18 6 6 18", "M6 6l12 12"];

function readerCloseButton() {
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ghost icon-btn";
  close.dataset.action = "close-reader";
  close.setAttribute("aria-label", "Close");
  close.title = "Close";
  close.appendChild(strokeIcon(READER_CLOSE_ICON, 16));
  const text = document.createElement("span");
  text.textContent = "Close";
  close.appendChild(text);
  close.addEventListener("click", () => {
    if (typeof window.close === "function") window.close();
  });
  return close;
}

function readerCloseBar() {
  const bar = document.createElement("div");
  bar.className = "reader-actions";
  bar.appendChild(readerCloseButton());
  return bar;
}

function appendReaderClose(pane) {
  if (!isReaderWindow() || !pane || typeof pane.querySelector !== "function") return;
  if (pane.querySelector('[data-action="close-reader"]')) return;
  const bar = pane.querySelector(".reader-actions");
  const menus = bar && typeof bar.querySelector === "function" ? bar.querySelector(".reader-menus") : null;
  const button = readerCloseButton();
  if (menus) {
    menus.appendChild(button);
    return;
  }
  if (bar) {
    bar.appendChild(button);
    return;
  }
  pane.appendChild(readerCloseBar());
}

function publishReaderTitle(subject) {
  const title = String(subject || "").trim() || "Message";
  document.title = title.slice(0, 180) + " — Morrow Mail";
}

function showReaderOpenError(message, emailId) {
  invalidateReaderOpen();
  const pane = $("reader");
  if (!pane) return;
  pane.removeAttribute("aria-busy");
  pane.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "Message";
  const error = document.createElement("p");
  error.className = "hint error";
  error.textContent = message || "That message could not be opened.";
  pane.append(readerCloseBar(), heading, error);
  if (emailId) pane.appendChild(bodyRetryButton({ id: emailId }));
}

async function bootReaderWindow() {
  try { document.documentElement.dataset.window = "reader"; } catch { /* the page is still the reader surface */ }
  if (!api) {
    showStatus("Mail preload is unavailable.", true);
    return;
  }
  wire();
  if (typeof api.on === "function") api.on("mail:translate:event", onTranslateEvent);
  if (typeof api.on === "function") api.on("mail:bodyUpdated", applyBodyUpdate);
  if (typeof api.on === "function") api.on("mail:actionsSettled", applyActionSettlement);
  if (typeof api.on === "function") api.on("mail:accountsUpdated", payload => {
    if (Array.isArray(payload?.accounts)) acceptBodyAccounts(payload.accounts);
  });
  await loadLook();
  await loadShellPrefs();
  try {
    const data = await call("mail:listAccounts");
    acceptBodyAccounts(Array.isArray(data) ? data : []);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
  let seed = null;
  try {
    if (typeof api.pullReaderSeed === "function") seed = await api.pullReaderSeed();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
  publishReaderTitle("");
  paintReaderPending({ subject: "" });
  const messageId = seed && seed.messageId;
  const accountId = seed && seed.accountId;
  if (!messageId) {
    showReaderOpenError("That message could not be opened.");
    showStatus("That message could not be opened.", true);
    return;
  }
  state.accountId = accountId || state.accountId;
  pendingOpenId = messageId; pendingOpenBody = true;
  let opened;
  try {
    opened = await call("mail:openEmail", { emailId: messageId, accountId: accountId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showReaderOpenError(message, messageId);
    showStatus(message, true);
    return;
  }
  const email = opened && opened.email;
  if (!email) {
    showReaderOpenError("That message is no longer in the mailbox.");
    showStatus("That message is no longer in the mailbox.", true);
    return;
  }
  if (email.bodyEpoch != null && !bodyIdentity(email)) {
    showReaderOpenError("The mailbox connection changed. Reopen the message."); return;
  }
  pendingOpenId = ""; pendingOpenBody = false;
  noteBody(email);
  state.email = preferBody(email);
  state.thread = [];
  state.accountId = email.accountId || accountId || state.accountId;
  publishReaderTitle(email.subject || "");
  renderReader(false);
  pumpBodyRefreshes();
  const openedId = email.id;
  loadSnoozed().then(() => loadProviderFolders(accountGen)).then(() => {
    if (state.email && state.email.id === openedId) renderReader(false);
  }).catch(() => {});
  if (!email.unread) return;
  try {
    await setRead(email, true);
  } catch (error) {
    showStatus("Message opened, but marking it read was not confirmed. Other clients may still show it unread. " + (error.message || String(error)), true);
  }
}

async function openCompose(seed) {
  if (sendTimer || state.composePending || state.composeInitializing) {
    showStatus("Finish the pending message first.");
    return;
  }
  if ($("compose").open && !(await requestComposeClose())) return;
  hideRecipientSuggest();
  const fields = seed || {};
  state.composeSession = (state.composeSession || 0) + 1;
  state.composeFileJobs = [];
  const replySession = state.composeSession;
  state.agentReplyTodo = explicitAgentTodo(fields.agentTodo);
  state.agentReplySource = freshReplyLearningSource(fields);
  state.composeInitializing = true;
  state.composeIdentityError = false;
  state.composeIdentity = null;
  state.composeShowCc = false;
  state.composeShowBcc = false;
  resetDraftWrite();
  closeComposeAi();
  state.draftId = fields.draftId || null;
  state.draftRevision = fields.draftRevision || null;
  state.composeQueued = false;
  state.composePartialReceipt = false;
  state.signatureText = "";
  state.signatureHtml = "";
  state.composeMeta = {
    accountId: fields.accountId || state.accountId,
    inReplyTo: fields.inReplyTo || "",
    threadId: fields.threadId || "",
  };
  state.composeQuote = quoteStateFromSeed(fields);
  state.composeAttachments = composeAttachmentList(fields.attachments);
  state.composeSuggestions = null;
  state.botDraftReview = fields.botDraft ? {
    proposalId: fields.botDraft.proposalId || "",
    accountId: fields.accountId || state.accountId || "",
    to: fields.to || "",
    cc: fields.cc || "",
    bcc: fields.bcc || "",
    subject: fields.subject || "",
    body: fields.body || "",
    attachments: attachmentKey(fields.attachments),
  } : null;
  setComposeStatus("");
  $("compose-title").textContent = fields.title || "New message";
  publishComposeTitle(fields.title || "New message");
  $("compose-to").value = fields.to || "";
  $("compose-cc").value = fields.cc || "";
  $("compose-bcc").value = fields.bcc || "";
  $("compose-subject").value = fields.subject || "";
  $("compose-body").value = fields.body || "";
  paintComposeEditor(fields.body || "", fields.htmlBody || "");
  $("ai-prompt").value = "";
  $("schedule-preset").value = fields.schedulePreset || "1h";
  $("schedule-at").value = typeof fields.scheduleAt === "string" ? fields.scheduleAt : "";
  const fileInput = $("compose-file");
  if (fileInput) fileInput.value = "";
  resetComposeDrop();
  setComposeAttachError("");
  paintComposeAttachments();
  syncScheduleFields();
  syncCompose();
  paintComposeChrome();
  paintQuoteBody();
  openDialog("compose");
  scheduleComposeLayout();
  try { await initializeComposeIdentity(fields); }
  catch (error) {
    state.composeIdentityError = true;
    $("compose-from-note").textContent = "Could not resolve the From address. Close and reopen compose to retry. " + error.message;
    setComposeStatus("From address could not be loaded. Your text is retained.", true);
  }
  const initial = composeSnapshot();
  await Promise.all([fields.partialReceipt ? Promise.resolve() : fillSignatures(!!fields.draftId || !!fields.recoveredSnapshot), loadScheduled()]);
  if (replySession === state.composeSession && !state.agentReplyTodo && freshReplyTodoSeed(fields)) {
    try {
      const target = await call("nativeAgent:home:replyTarget", freshReplyTodoSeed(fields));
      if (replySession === state.composeSession) state.agentReplyTodo = explicitAgentTodo(target);
    } catch { /* the reply can still send; this todo stays open */ }
  }
  state.composeInitializing = false;
  if (fields.partialReceipt) {
    state.composeQueued = true;
    state.composePartialReceipt = true;
    state.draftId = null;
    state.draftRevision = null;
    state.composeBaseline = composeSnapshot();
    syncCompose();
    setComposeStatus(fields.partialReceipt, true);
    finishComposeOpen(fields);
    return;
  }
  // A supplied proposal is unsaved work; an untouched new message is not.
  const baseline = JSON.parse(initial);
  baseline.body = fields.draftId || fields.recoveredSnapshot ? baseline.body : applySignature(baseline.body, "", state.signatureText);
  baseline.html = composeEditorSnapshot();
  state.composeBaseline = fields.body && !fields.draftId ? "" : JSON.stringify(baseline);
  syncCompose();
  paintComposeNote();
  if (!$("compose").open) {
    finishComposeOpen(fields);
    return;
  }
  scheduleComposeLayout();
  setAiMode(defaultAiMode(fields));
  $("compose-schedule-tools").open = false;
  showComposeSuggestions(fields).catch(() => {});
  if (opensAiWrite(fields, state.prefs)) {
    openComposeAi();
    finishComposeOpen(fields);
    return;
  }
  closeComposeAi();
  if ($("compose-to").value.trim()) focusComposeBody();
  else $("compose-to").focus();
  finishComposeOpen(fields);
}

function setComposeStatus(text, isError) {
  const el = $("compose-status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

function composeSnapshot() {
  return JSON.stringify({ accountId: state.composeMeta && state.composeMeta.accountId,
    fromAddress: state.composeMeta && state.composeMeta.fromAddress,
    fromDisplayName: state.composeMeta && state.composeMeta.fromDisplayName,
    to: $("compose-to").value, cc: $("compose-cc").value, bcc: $("compose-bcc").value,
    subject: $("compose-subject").value, body: $("compose-body").value,
    html: composeEditorSnapshot(),
    quote: state.composeQuote && state.composeQuote.text,
    attachments: attachmentKey(state.composeAttachments),
    pendingAttachments: (state.composeFileJobs || []).filter((job) => job.session === state.composeSession).map((job) => job.names) });
}

async function requestComposeClose() {
  const preview = $("compose-preview");
  if (preview && preview.open) return false;
  if (state.composePending || state.composeInitializing) return false;
  if (!state.composeQueued && composeSnapshot() !== state.composeBaseline) {
    const choice = await new Promise((resolve) => {
      const dialog = $("compose-close-review");
      const finish = (value) => { dialog.close(); resolve(value); };
      $("draft-close-discard").onclick = () => finish("discard");
      $("draft-close-keep").onclick = () => finish("keep");
      dialog.oncancel = (event) => { event.preventDefault(); finish("keep"); };
      openDialog("compose-close-review");
    });
    if (choice !== "discard") return false;
  }
  // Await the exit before another composition reuses this dialog.
  await closeDialog("compose");
  return true;
}

const draftResumes = new Map();
function resumeDraft(email, extra) {
  const key = JSON.stringify([email.accountId, email.id]);
  if (draftResumes.has(key)) return draftResumes.get(key);
  const pending = prepareDraftCompose(email, extra).finally(() => draftResumes.delete(key));
  draftResumes.set(key, pending);
  return pending;
}

async function prepareDraftCompose(email, extra) {
  const data = await call("mail:openEmail", { emailId: email.id, full: true });
  let draft = data && data.email;
  if (!draft || !draft.isDraft || draft.accountId !== email.accountId) throw new Error("That draft is no longer available.");
  if (!draft.fromAddress) throw new Error("This draft's sender address could not be resolved. The saved draft was retained.");
  if (!draft.bodyComplete || draft.bodyWarning) throw new Error("The complete draft body could not be downloaded. The saved draft was retained; reopen it to retry.");
  if (draft.attachments?.length) {
    const prepared = await startAttachmentTask("mail:prepareDraft", draft, draft.attachments, "Prepare draft").promise;
    draft = prepared.email;
    if (!draft || draft.accountId !== email.accountId || draft.id !== email.id
        || composeAttachmentList(draft.attachments).length !== draft.attachments.length) {
      throw new Error("Draft attachments could not be prepared. The saved draft was retained; retry from Drafts.");
    }
  }
  await presentCompose({ title: "Resume draft", draftId: draft.id, accountId: draft.accountId,
    draftRevision: draft.draftRevision,
    fromAddress: draft.fromAddress,
    fromDisplayName: draft.fromDisplayName,
    to: people(draft.to), cc: people(draft.cc), bcc: people(draft.bcc), subject: draft.subject,
    body: readable(draft),
    htmlBody: typeof draft.htmlBody === "string" ? draft.htmlBody : "",
    attachments: draft.attachments,
    inReplyTo: draft.inReplyTo || "", threadId: draft.threadId || "",
    ...(draft.draftPending ? { status: "Local changes are protected and waiting for upload. Save draft to retry; nothing sends automatically." } : {}),
    ...(extra || {}) });
}

async function loadScheduled() {
  const gen = scheduledGen += 1;
  try {
    const data = await call("mail:listScheduled", {});
    if (gen !== scheduledGen) return;
    state.outboxError = "";
    state.outboxRows = outboxRowsFrom(data);
    renderScheduled(scheduledRows(data));
    const nav = $("folders");
    if (nav && typeof nav.querySelector === "function") applyOutboxChrome(nav.querySelector(".outbox-mail"));
    if (state.outbox) {
      state.emails = outboxEmails(state.outboxRows);
      state.listOffset = 0;
      state.listTotal = state.emails.length;
      state.listSyncDone = true;
      if (state.email && !state.emails.some((row) => row && row.id === state.email.id)) {
        state.email = null;
        state.thread = [];
        renderReader(false);
      }
      renderList();
    }
  } catch (error) {
    if (gen !== scheduledGen) return;
    state.outboxError = error instanceof Error ? error.message : String(error);
    if (state.outbox) renderList();
    $("scheduled").replaceChildren();
    const item = document.createElement("li");
    item.textContent = "Unknown — Scheduled mail could not be loaded. ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ghost";
    retry.textContent = "Retry";
    retry.onclick = () => loadScheduled();
    item.appendChild(retry);
    $("scheduled").appendChild(item);
  }
}

function paintScheduleUndo() {
  const on = !!scheduleUndo;
  for (const id of ["undo-schedule", "scheduled-undo"]) {
    const button = $(id);
    if (button) {
      if (!on && document.activeElement === button) $(id === "scheduled-undo" ? "scheduled-close" : "status-chip")?.focus?.();
      button.hidden = !on;
      button.disabled = scheduleUndoBusy;
      button.setAttribute?.("aria-busy", scheduleUndoBusy ? "true" : "false");
    }
  }
}

function clearScheduleUndoTimer() {
  if (scheduleUndoTimer) clearTimeout(scheduleUndoTimer);
  scheduleUndoTimer = null;
}

function hideScheduleUndo() {
  clearScheduleUndoTimer();
  scheduleUndo = null;
  paintScheduleUndo();
}

function armScheduleUndo(snapshot) {
  clearScheduleUndoTimer();
  scheduleUndoEpoch += 1;
  scheduleUndo = snapshot;
  paintScheduleUndo();
  scheduleUndoTimer = setTimeout(() => {
    scheduleUndo = null;
    scheduleUndoTimer = null;
    paintScheduleUndo();
  }, SCHEDULE_UNDO_MS);
}

async function commitCancelScheduled(row) {
  const removed = await call("mail:cancelScheduled", { id: row.id });
  const snapshot = removed && removed.snapshot;
  const status = $("scheduled-status");
  if (snapshot) {
    armScheduleUndo(snapshot);
    const message = ["unknown", "sent", "partial"].includes(snapshot.status)
      ? "Delivery record dismissed. This does not recall any delivered mail. Undo is available for a few seconds."
      : "Scheduled delivery canceled. Undo is available for a few seconds.";
    if (status) status.textContent = message;
    showStatus(message);
  } else if (status) {
    status.textContent = "Scheduled delivery canceled.";
  }
  await loadScheduled();
}

async function requestCancelScheduled(row) {
  if (!row || !row.id || row.status === "sending") return;
  const line = scheduledLine(row, state.accounts);
  const review = ["unknown", "sent", "partial"].includes(row.status);
  const first = await askConfirm({
    title: review ? "Dismiss delivery record?" : "Cancel scheduled send?",
    body: line + (review ? "\nThis only removes the saved recovery copy. It does not recall delivered mail. Check Sent or recover a draft first. You will be asked to confirm again." : "\nNothing is canceled yet. You will be asked to confirm again."),
    confirm: "Continue",
    cancel: "Keep scheduled",
  });
  if (!first || !first.ok) return;
  await confirmSettled();
  const second = await askConfirm({
    title: review ? "Confirm dismiss?" : "Confirm cancel?",
    body: line + (review ? "\nRemove this delivery record and recovery copy? You can undo for a few seconds." : "\nCancel this scheduled send? You can undo for a few seconds."),
    confirm: review ? "Dismiss record" : "Cancel send",
    cancel: "Keep scheduled",
  });
  if (!second || !second.ok) return;
  await commitCancelScheduled(row);
}

async function undoCancelScheduled() {
  const snapshot = scheduleUndo;
  if (!snapshot || scheduleUndoBusy) return;
  const epoch = scheduleUndoEpoch;
  scheduleUndoBusy = true;
  paintScheduleUndo();
  try {
    await call("mail:restoreScheduled", { snapshot });
    if (scheduleUndoEpoch === epoch) {
      hideScheduleUndo();
      const status = $("scheduled-status");
      if (status) status.textContent = "Scheduled send restored.";
      showStatus("Scheduled send restored.");
    }
    await loadScheduled();
  } catch (error) {
    if (scheduleUndoEpoch !== epoch) return;
    const message = error instanceof Error ? error.message : String(error);
    const status = $("scheduled-status");
    if (status) status.textContent = message;
    showStatus(message, true);
  } finally {
    scheduleUndoBusy = false;
    paintScheduleUndo();
  }
}

async function showScheduled() {
  if ($("compose").open && !(await requestComposeClose())) return;
  if (!scheduleUndo) $("scheduled-status").textContent = "";
  openDialog("scheduled-dialog");
  await loadScheduled();
}

let quitScheduledPrompt = null;
let quitScheduledDismissed = "";

function replyQuitScheduled(choice) {
  const pending = quitScheduledPrompt;
  if (!pending) return;
  quitScheduledPrompt = null;
  const dialog = $("quit-scheduled");
  if (dialog) dialog.oncancel = null;
  closeDialog("quit-scheduled");
  const allowed = choice === "quit" || choice === "view" ? choice : "stay";
  if (api && typeof api.replyQuitScheduled === "function") {
    api.replyQuitScheduled({ nonce: pending.nonce, choice: allowed });
  }
}

function presentQuitScheduled(payload) {
  const dialog = $("quit-scheduled");
  if (!dialog || !payload || typeof payload.nonce !== "string") return;
  const count = Number(payload.count) || 0;
  const noun = count === 1 ? "message" : "messages";
  $("quit-scheduled-title").textContent = payload.title || (count === 1 ? "1 scheduled message is still pending" : `${count} scheduled messages are still pending`);
  $("quit-scheduled-body").textContent = payload.body || `Scheduled ${noun} will not send while Morrow Mail is closed. A time that passes while the app is closed is sent the next time you open it.`;
  const list = $("quit-scheduled-list");
  list.replaceChildren();
  const items = Array.isArray(payload.items) ? payload.items : [];
  for (const item of items) {
    const li = document.createElement("li");
    const subject = String((item && item.subject) || "").trim() || "(no subject)";
    const time = String((item && (item.time || item.sendAt)) || "").trim() || "Unknown time";
    const sending = item && item.status === "sending" ? " · Sending now" : "";
    li.textContent = `${subject} · ${time}${sending}`;
    list.appendChild(li);
  }
  list.hidden = items.length === 0;
  const hidden = Number(payload.hidden) || 0;
  const more = $("quit-scheduled-more");
  if (more) {
    more.hidden = hidden <= 0;
    more.textContent = hidden === 1 ? "1 more scheduled message." : hidden > 1 ? `${hidden} more scheduled messages.` : "";
  }
  if (dialog.dataset) delete dialog.dataset.closing;
  dialog.oncancel = null;
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  quitScheduledPrompt = { nonce: payload.nonce };
  const stay = () => replyQuitScheduled("stay");
  const form = $("quit-scheduled-form");
  if (form) {
    form.onsubmit = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      stay();
    };
  }
  const stayButton = $("quit-scheduled-stay");
  if (stayButton) stayButton.onclick = stay;
  const quitButton = $("quit-scheduled-quit");
  if (quitButton) quitButton.onclick = () => replyQuitScheduled("quit");
  const viewButton = $("quit-scheduled-view");
  if (viewButton) {
    viewButton.onclick = () => {
      replyQuitScheduled("view");
      showScheduled().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
    };
  }
  dialog.oncancel = (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    stay();
  };
  openDialog("quit-scheduled");
  if (stayButton && typeof stayButton.focus === "function") stayButton.focus();
}

function acceptQuitScheduled(payload) {
  if (!payload || typeof payload.nonce !== "string") return;
  if (payload.nonce === quitScheduledDismissed) return;
  if (quitScheduledPrompt) {
    if (api && typeof api.replyQuitScheduledShown === "function") api.replyQuitScheduledShown({ nonce: payload.nonce });
    if (api && typeof api.replyQuitScheduled === "function") api.replyQuitScheduled({ nonce: payload.nonce, choice: "stay" });
    return;
  }
  try {
    presentQuitScheduled(payload);
  } catch {
    return;
  }
  if (!quitScheduledPrompt || quitScheduledPrompt.nonce !== payload.nonce) return;
  if (api && typeof api.replyQuitScheduledShown === "function") api.replyQuitScheduledShown({ nonce: payload.nonce });
}

function dismissQuitScheduled(payload) {
  if (!payload || typeof payload.nonce !== "string") return;
  quitScheduledDismissed = payload.nonce;
  if (!quitScheduledPrompt || quitScheduledPrompt.nonce !== payload.nonce) return;
  quitScheduledPrompt = null;
  const dialog = $("quit-scheduled");
  if (dialog) dialog.oncancel = null;
  const form = $("quit-scheduled-form");
  if (form) form.onsubmit = null;
  closeDialog("quit-scheduled");
}

async function editScheduledMail(row) {
  const review = ["unknown", "sent", "partial"].includes(row.status);
  const answer = await askConfirm({ title: review ? "Recover an unsent draft copy?" : "Remove from queue and edit?", body: scheduledLine(row, state.accounts)
    + (row.status === "partial" ? "\nSMTP accepted some recipients and rejected others. The recovered draft will contain only verified rejected recipients, with their original To/Cc/Bcc roles. Review it before sending; accepted recipients will not be included."
      : review ? "\nCheck Sent first: this message may already have reached the recipient. The saved content will become an unsent local draft. Sending it again may create a duplicate; nothing is sent automatically."
      : "\nThe queued delivery will be removed and saved as a local draft. Review it, then explicitly Schedule send again."), confirm: review ? "Recover draft" : "Remove and edit", cancel: "Keep queued" });
  if (!answer || !answer.ok) return;
  const draft = await call("mail:editScheduled", { id: row.id, acknowledgeDelivery: review });
  $("scheduled-status").textContent = "Removed from queue. A local draft is saved in Drafts.";
  await loadScheduled();
  await closeDialog("scheduled-dialog");
  const handoff = {
    schedulePreset: "custom",
    scheduleAt: vacationLocalValue(draft.sendAt),
    status: draft.warning || "Removed from queue; local draft saved. Review and choose a future time, then Schedule send.",
    ...(explicitAgentTodo(draft.agentTodo) ? { agentTodo: explicitAgentTodo(draft.agentTodo) } : {}),
  };
  try {
    await resumeDraft({ id: draft.emailId, accountId: draft.accountId }, handoff);
  } catch (error) {
    openDialog("scheduled-dialog");
    throw new Error("Removed from queue and saved in local Drafts, but the editor could not open. Resume it from Drafts. " + (error.message || String(error)));
  }
  if (!(api && typeof api.openComposeWindow === "function")) {
    $("schedule-preset").value = handoff.schedulePreset;
    $("schedule-at").value = handoff.scheduleAt;
    syncScheduleFields();
    setComposeStatus(handoff.status);
  }
}

async function composeOperation(work) {
  if (state.composePending || state.composeQueued || state.composeInitializing || state.composeIdentityError || state.draftWrite?.pending || composeFilesPending()) return false;
  state.composePending = true;
  syncCompose();
  try { await work(); return true; }
  catch (error) { setComposeStatus(error.message || String(error), true); return false; }
  finally { state.composePending = false; syncCompose(); }
}

async function scheduleMail(whenOverride, reviewedPayload) {
  if (state.botDraftReview) { setComposeStatus("Review this Bot proposal and use Send when ready. It cannot be scheduled from proposal review."); return false; }
  const account = composeAccount();
  if (!isLive(account)) return false;
  if (reviewedPayload && reviewedPayload.accountId !== account.id) return false;
  if (!composeHasRecipient()) {
    setComposeStatus("Add at least one recipient.", true);
    $("compose-to").focus();
    return false;
  }
  const picked = whenOverride instanceof Date && !Number.isNaN(whenOverride.getTime()) ? whenOverride : null;
  const when = picked || scheduleAt($("schedule-preset").value, $("schedule-at").value, new Date());
  if (!when || when.getTime() <= Date.now() + 1000) { setComposeStatus("Pick a time in the future.", true); $("schedule-at").focus(); return false; }
  return composeOperation(async () => {
    setComposeStatus("Scheduling…");
    await call("mail:scheduleSend", { ...withAgentReplyTodo(reviewedPayload || composePayload(account)), sendAt: when.toISOString() });
    state.agentReplyTodo = null;
    state.agentReplySource = null;
    state.composeQueued = true;
    $("compose-title").textContent = "Scheduled receipt";
    // Mailbox fixtures evaluate scheduleMail without the compose-window helpers.
    if (typeof publishComposeTitle === "function") publishComposeTitle("Scheduled receipt");
    state.composeBaseline = composeSnapshot();
    // Mailbox fixtures evaluate scheduleMail without the display helper.
    const scheduledFor = typeof shownWhen === "function"
      ? shownWhen(when, true)
      : when.toLocaleString() + " (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")";
    setComposeStatus(`Scheduled for ${scheduledFor} from ${state.composeMeta.fromAddress || account.email}. View scheduled mail to cancel or edit. Sends while Morrow is open; a missed time sends on next launch.`);
    await loadScheduled();
  });
}

function composeFields() {
  return {
    fromAddress: state.composeMeta?.fromAddress || "",
    fromDisplayName: state.composeMeta?.fromDisplayName || "",
    to: $("compose-to").value,
    cc: $("compose-cc").value,
    bcc: $("compose-bcc").value,
    subject: $("compose-subject").value,
    body: $("compose-body").value,
  };
}

function composeReady() {
  const account = composeAccount();
  if (!isLive(account)) return false;
  if (state.composePending || state.composeQueued || state.composeInitializing || state.composeIdentityError) return false;
  if (composeFilesPending()) {
    setComposeStatus("Wait for attachment preparation before saving, sending or scheduling.", true);
    return false;
  }
  if (state.draftWrite?.pending) {
    setComposeStatus("Finish or cancel AI writing before reviewing this message.", true);
    return false;
  }
  if (!composeHasRecipient()) {
    setComposeStatus("Add at least one recipient.", true);
    $("compose-to").focus();
    return false;
  }
  return true;
}

function pendingScheduleWhen() {
  if (state.botDraftReview) return null;
  return defaultSendAt(new Date(), state.prefs.scheduleDelay);
}

function paintPreview(draft) {
  const schedule = draft && draft.kind === "schedule";
  $("compose-preview-title").textContent = schedule ? "Preview scheduled send" : "Preview send";
  const when = $("compose-preview-when");
  const date = schedule && draft.sendAt ? new Date(draft.sendAt) : null;
  if (date && !Number.isNaN(date.getTime())) {
    when.hidden = false;
    when.textContent = "Scheduled for " + shownWhen(date, true) + ".";
  } else {
    when.hidden = true;
    when.textContent = "";
  }
  $("compose-preview-to").textContent = draft.to || "";
  $("compose-preview-from").textContent = window.morrowComposePolicy.senderPreview(draft.fromAddress || "", draft.fromDisplayName || "");
  const ccRow = $("compose-preview-cc-row");
  const bccRow = $("compose-preview-bcc-row");
  if (ccRow) ccRow.hidden = !draft.cc;
  if (bccRow) bccRow.hidden = !draft.bcc;
  $("compose-preview-cc").textContent = draft.cc || "";
  $("compose-preview-bcc").textContent = draft.bcc || "";
  $("compose-preview-subject").textContent = draft.subject || "(no subject)";
  const fileRow = $("compose-preview-files-row");
  const fileText = $("compose-preview-files");
  const files = Array.isArray(draft.attachments) ? draft.attachments : [];
  if (fileRow && fileText) {
    fileRow.hidden = !files.length;
    fileText.textContent = files.map((file) => {
      const size = fileSize(file.size);
      const name = file.filename || "attachment";
      return size ? `${name} (${size})` : name;
    }).join(", ");
  }
  $("compose-preview-body").textContent = draft.body ? draft.body : "(empty message)";
  $("compose-preview-confirm").textContent = schedule ? "Confirm schedule" : "Confirm send";
}

function openComposePreview(when) {
  if (!composeReady()) return false;
  const draft = previewDraft(composeFields(), state.composeQuote && state.composeQuote.text, when, state.composeAttachments);
  previewDraftState = { ...draft, payload: JSON.parse(JSON.stringify(composePayload(composeAccount()))),
    session: state.composeSession, snapshot: composeSnapshot() };
  paintPreview(draft);
  openDialog("compose-preview");
  const confirm = $("compose-preview-confirm");
  if (confirm && typeof confirm.focus === "function") confirm.focus();
  return true;
}

function requestSendPreview() {
  return openComposePreview(pendingScheduleWhen());
}

function requestSendNowPreview() {
  if (state.botDraftReview) return false;
  return openComposePreview(null);
}

function requestSchedulePreview() {
  if (state.botDraftReview) {
    setComposeStatus("Review this Bot proposal and use Send when ready. It cannot be scheduled from proposal review.");
    return false;
  }
  if (!composeReady()) return false;
  const when = scheduleAt($("schedule-preset").value, $("schedule-at").value, new Date());
  if (!when) {
    setComposeStatus("Pick a time in the future.", true);
    $("schedule-at").focus();
    return false;
  }
  return openComposePreview(when);
}

async function confirmComposePreview() {
  const draft = previewDraftState;
  if (!draft) return false;
  previewDraftState = null;
  await closeDialog("compose-preview");
  if (draft.session !== state.composeSession || draft.snapshot !== composeSnapshot() || state.draftWrite?.pending || composeFilesPending()) {
    setComposeStatus("The message changed. Review a new preview before sending or scheduling.", true);
    return false;
  }
  if (draft.kind === "schedule") return scheduleMail(new Date(draft.sendAt), draft.payload);
  await sendMail(draft.payload);
  return true;
}

function cancelComposePreview() {
  previewDraftState = null;
  closeDialog("compose-preview");
}

async function saveDraft() {
  const account = composeAccount();
  if (!isLive(account)) return false;
  return composeOperation(async () => {
    setComposeStatus("Saving draft…");
    const snapshot = composeSnapshot();
    const saved = await call("mail:upsertDraft", composePayload(account));
    state.draftId = (saved && (saved.emailId || saved.draftId)) || state.draftId;
    state.draftRevision = saved?.draftRevision || null;
    if (!state.draftId) throw new Error("Draft could not be saved. Your text is still here.");
    state.composeBaseline = snapshot;
    setComposeStatus(saved && saved.remoteSaved === false ? "Draft saved on this computer. " + (saved.warning || "Server copy could not be updated.") : "Draft saved." + (saved?.warning ? " " + saved.warning : ""));
  });
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
  openDialog("compose");
  scheduleComposeLayout();
  setComposeStatus("Send canceled. Your draft is ready to edit.");
  showStatus("Send canceled. Your draft is ready to edit.");
  focusComposeBody();
  return true;
}

async function separatePartialReceipt(payload, message) {
  const shown = value => Array.isArray(value) ? value.join(", ") : value || "";
  const seed = { title: "Partial delivery receipt", accountId: payload.accountId, fromAddress: payload.fromAddress,
    fromDisplayName: payload.fromDisplayName,
    to: shown(payload.to), cc: shown(payload.cc), bcc: shown(payload.bcc), subject: payload.subject || "",
    body: plainFromMailHtml(payload.body || ""), htmlBody: payload.body || "", attachments: payload.attachments,
    partialReceipt: message };
  if (api && typeof api.openComposeWindow === "function") {
    try { await api.openComposeWindow(seed); return; } catch { /* retain an inspectable receipt in this window */ }
  }
  // Older preload/modal environments still need a receipt without replacing a
  // newer composition. Text nodes and a readonly field never execute mail HTML.
  const dialog = document.createElement("dialog");
  dialog.className = "delivery-receipt";
  const heading = document.createElement("h2"); heading.textContent = seed.title;
  const notice = document.createElement("p"); notice.textContent = message;
  const content = document.createElement("textarea"); content.readOnly = true;
  content.setAttribute("aria-label", "Partial delivery content");
  content.value = `To: ${seed.to}\nCc: ${seed.cc}\nBcc: ${seed.bcc}\nSubject: ${seed.subject}\n\n${seed.body}`;
  const close = document.createElement("button"); close.type = "button"; close.className = "ghost"; close.textContent = "Close receipt";
  close.onclick = () => dialog.close(); dialog.onclose = () => dialog.remove();
  dialog.append(heading, notice, content, close); document.body.appendChild(dialog); dialog.showModal();
}

async function deliverMail(payload, session = state.composeSession) {
  const ownsCompose = () => session === state.composeSession;
  if (ownsCompose()) { state.composePending = true; syncCompose(); setComposeStatus("Sending…"); }
  showStatus("Sending…");
  try {
    const result = await call("mail:send", payload);
    if (result?.partial) {
      const message = result.warning || "Partly sent. Review rejected recipients in Scheduled delivery review; accepted recipients will not be resent automatically.";
      if (!ownsCompose()) {
        await separatePartialReceipt(payload, message);
        showStatus(message, true);
        loadScheduled().catch(() => {});
        return;
      }
      state.composeQueued = true;
      state.composePartialReceipt = true;
      state.draftId = null;
      state.draftRevision = null;
      state.composeBaseline = composeSnapshot();
      $("compose-title").textContent = "Partial delivery receipt";
      if (typeof publishComposeTitle === "function") publishComposeTitle("Partial delivery receipt");
      openDialog("compose");
      scheduleComposeLayout();
      setComposeStatus(message, true);
      showStatus(message, true);
      loadScheduled().catch(() => {});
      return;
    }
    if (!ownsCompose()) { showStatus(result?.warning || "Sent.", !!result?.warning); return; }
    await finishAgentReplyTodo(session);
    state.draftId = null;
    state.draftRevision = null;
    state.composeBaseline = composeSnapshot();
    await closeDialog("compose");
    showStatus(result?.warning || "Sent.", !!result?.warning);
  } catch (error) {
    const message = "Delivery was not confirmed. Your draft is ready to edit. Check Sent before retrying. " + (error.message || String(error));
    if (ownsCompose()) { openDialog("compose"); scheduleComposeLayout(); setComposeStatus(message, true); }
    showStatus(message, true);
    return;
  } finally { if (ownsCompose()) { state.composePending = false; syncCompose(); } }
  if (isComposeWindow()) {
    if (api && typeof api.allowComposeClose === "function") api.allowComposeClose();
    return;
  }
  await loadList();
}

async function undoOutboxItem(row) {
  if (!row || !row.id) return;
  if (row.outboxStatus === "sending" || row.status === "sending") {
    showStatus("Delivery has started. It can no longer be canceled. Check Sent before retrying.", true);
    return;
  }
  let recovered;
  try {
    recovered = await call("mail:cancelScheduled", { id: row.id, recoverDraft: true });
  } catch (error) {
    showStatus(error.message || "Delivery has started. It can no longer be canceled. Check Sent before retrying.", true);
    return;
  }
  state.outboxRows = (state.outboxRows || []).filter((item) => item && item.id !== row.id);
  const nav = $("folders");
  if (nav && typeof nav.querySelector === "function") applyOutboxChrome(nav.querySelector(".outbox-mail"));
  if (state.outbox) {
    state.emails = outboxEmails(state.outboxRows);
    state.listOffset = 0;
    state.listTotal = state.emails.length;
    if (state.email && String(state.email.id) === String(row.id)) {
      state.email = null;
      state.thread = [];
    }
    renderList();
    renderReader(false);
  }
  const status = "Send canceled. A recovery copy is saved in local Drafts; nothing sends automatically.";
  try {
    await resumeDraft({ id: recovered.emailId, accountId: recovered.accountId }, { status });
    showStatus(status);
  } catch (error) {
    showStatus("Send canceled and saved in local Drafts, but Compose could not open. Resume it from Drafts. " + (error.message || String(error)), true);
  }
}

// The local delay can be canceled only before mail:send begins.
async function sendMail(reviewedPayload) {
  const account = composeAccount();
  if (!isLive(account) || state.composePending || state.composeQueued || state.composeInitializing || state.composeIdentityError || state.draftWrite?.pending || composeFilesPending() || sendTimer) return;
  if (reviewedPayload && reviewedPayload.accountId !== account.id) return;
  if (!composeHasRecipient()) {
    setComposeStatus("Add at least one recipient.", true);
    $("compose-to").focus();
    return;
  }
  const payload = withAgentReplyTodo(reviewedPayload || composePayload(account));
  const session = state.composeSession;
  const delay = sendDelayMs(state.prefs.undoSend);
  if (!delay) { await deliverMail(payload, session); return; }
  state.composePending = true;
  syncCompose();
  let queued = false;
  try {
    await call("mail:scheduleSend", { ...payload, sendAt: new Date(Date.now() + delay).toISOString(), outbox: true });
    queued = true;
    state.agentReplyTodo = null;
    state.agentReplySource = null;
    state.composeQueued = true;
    state.composeBaseline = composeSnapshot();
  } catch (error) {
    if (!queued) {
      setComposeStatus(error.message || "Undo send could not be queued.", true);
      showStatus(error.message || "Undo send could not be queued.", true);
      return;
    }
  } finally {
    state.composePending = false;
    syncCompose();
  }
  if (!queued) return;
  showStatus("Queued in Outbox. You can undo until it sends.");
  if (isComposeWindow() && api && typeof api.allowComposeClose === "function") {
    api.allowComposeClose();
    return;
  }
  await closeDialog("compose");
  loadScheduled().catch(() => {});
}

async function removeAccount() {
  const account = settingsAccount();
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
  const pages = { calendar: [loadCalendar, "Calendar refreshed."], agent: [loadAgent, "Agent refreshed."],
    brain: [loadBrain, "Profile reloaded."], log: [refreshLog, "Log refreshed."],
    shortcuts: [paintShortcuts, "Shortcuts refreshed."],
    folders: [() => loadProviderFolders(accountGen), "Folders and labels refreshed."] };
  if (pages[state.view]) {
    const [load, receipt] = pages[state.view];
    await load();
    showStatus(receipt);
    return;
  }
  if (state.outbox) {
    await loadScheduled();
    showStatus("Outbox is on this computer. It is not a mailbox folder.");
    return;
  }
  if (state.allInbox) {
    await loadList();
    showStatus(allAccountMailSyncCopy());
    return;
  }
  const account = selectedAccount();
  if (!account || !state.folderId) return;
  beginSync({
    phase: "fetching",
    accountId: account.id,
    accountLabel: account.email || accountLabel(account),
    folderId: state.folderId,
    folderLabel: folderTitle(foldersOf(account), state.folderId),
  });
  try {
    const data = await call("mail:listFromNetwork", {
      accountId: account.id,
      folderId: state.folderId,
      limit: LIST_PAGE_SIZE,
      offset: state.listOffset,
    });
    if (data && data.sync) rememberSyncStatus(data.sync);
    await loadAccounts();
    paintSyncControl();
    pushDebug("sync", syncDetail(state.sync) || syncStatusLabel(data && data.sync));
  } catch (error) {
    finishLocalSync("error", error);
    throw error;
  }
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
  if (target.closest("input, textarea, select, [contenteditable='true'], #undo-details-popover, #body-sync")) return true;
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

function shortcutPlatform(platform) {
  return /mac|iphone|ipad/i.test(String(platform || "")) ? "mac" : "other";
}

function shortcutMod(platform) {
  return shortcutPlatform(platform) === "mac" ? "⌘" : "Ctrl";
}

function shortcutChord(platform, key) {
  const mod = shortcutMod(platform);
  return shortcutPlatform(platform) === "mac" ? mod + key : mod + "+" + key;
}

function shortcutNote(platform) {
  const reload = shortcutPlatform(platform) === "mac" ? "⌘R stays View → Reload." : "Ctrl+R stays View → Reload.";
  return "Single letters work while a message is open and you are not typing in a field. Delete and Backspace use the same Trash action as the Delete button. Message list arrows and Enter work only on the Mail page. Focused buttons and links keep their own keys, including pagination, Sync, and Scheduled. " + reload + " Zoom stays on the View menu.";
}

function shortcutCatalog(platform) {
  const chord = (key) => shortcutChord(platform, key);
  return [
    { group: "Reading", keys: "Delete or Backspace", action: "Move the open message to Trash" },
    { group: "Reading", keys: "R", action: "Reply to the open message" },
    { group: "Reading", keys: "A", action: "Reply all" },
    { group: "Reading", keys: "F", action: "Forward the open message" },
    { group: "Mail", keys: chord("N"), action: "New Mail" },
    { group: "Mail", keys: chord("F") + " or /", action: "Focus mail search" },
    { group: "Compose", keys: chord("Enter"), action: "Send" },
    { group: "Compose", keys: chord("S"), action: "Save draft" },
    { group: "Window", keys: "Esc", action: "Close the compose window or dismiss an overlay. Also clears a message selection when that is already the Esc action." },
    { group: "Window", keys: chord(","), action: "Settings" },
    { group: "List", keys: "↑ or ↓", action: "Move through the message list" },
    { group: "List", keys: "Enter", action: "Open the highlighted message" },
    { group: "List", keys: chord("A"), action: "Select the visible messages" },
    { group: "View menu", keys: chord("0"), action: "Actual size" },
    { group: "View menu", keys: chord("+") + " or " + chord("−"), action: "Zoom in or out" },
  ];
}

// Checkout commands already printed in README.md, package.json scripts,
// docs/INDEPENDENT_UI.md, docs/PACKAGING.md, docs/UPDATER_TEST.md, and docs/BOT_BRIDGE.md.
function cliNote() {
  return "Shell commands for a checkout of this repo. There is no morrow command. The bot client needs Node and the matching checkout files; it has no --help command. Copy does not run the command.";
}

function cliCatalog() {
  return [
    { group: "Run", command: "npm install", action: "Install dependencies for this checkout." },
    { group: "Run", command: "npm start", action: "Boot Morrow Mail with the bundled renderer in renderer/. Leave MORROW_ASAR unset. npm start leaves the updater off." },
    { group: "Run", command: "MORROW_ASAR=/absolute/path/to/app.asar npm start", action: "Optional. Load that external app.asar instead of renderer/. Leave the variable unset for the first-party shell." },
    { group: "Check", command: "npm run check", action: "Offline host and renderer checks. This runs without a Google Desktop client JSON." },
    { group: "Package", command: "npm ci", action: "Clean install from the lockfile before a local unsigned Windows build." },
    { group: "Package", command: "npm run pack", action: "Runs electron-builder --dir. Output goes to dist/." },
    { group: "Package", command: "npm run dist", action: "Runs electron-builder with no extra arguments." },
    { group: "Package", command: "CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win", action: "Unsigned Windows x64 NSIS setup and portable exe, without uploading. Artifacts land in dist/." },
    { group: "Package", command: "CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win -- --publish never", action: "Same Windows build, with publish forced off. The release workflow uses this form." },
    { group: "Package", command: "npm run dist:mac", action: "Runs electron-builder --mac dir zip." },
    { group: "Package", command: "CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac", action: "Local macOS dir and zip without uploading." },
    { group: "Package", command: "CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --arm64 --publish never", action: "Local ARM64 macOS dir and zip, without publishing. Run this on macOS." },
    { group: "Package", command: "npm run dist:unsigned", action: "Runs CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dir zip." },
    { group: "Package", command: "npm run publish:github", action: "Runs electron-builder --publish always. This uploads a GitHub release for Coke1120/Morrow-Mail. The release workflow is Actions → release." },
    { group: "Verify", command: "node scripts/check-windows-icon.js \"path/to/Morrow Mail.exe\"", action: "On Windows, check the installed executable icon and version strings. This does not clear the system icon cache." },
    { group: "Verify", command: "codesign --verify --deep --strict --verbose=2 \"dist/mac-arm64/Morrow Mail.app\"", action: "After a local ARM64 pack, this has to succeed. Ad hoc signing is not Developer ID or notarization." },
    { group: "Verify", command: "codesign -dv --verbose=4 \"dist/mac-arm64/Morrow Mail.app\"", action: "Print the signature. Expect Signature=adhoc and no Developer ID or TeamIdentifier." },
    { group: "Bot bridge", command: "node scripts/morrow-bot-call.js --token-file /path/to/morrow-bot-token --installation '<installation-id-from-settings>' --operation bridge.describe --params-file ./params.json", action: "Call the loopback bridge while Morrow is open and bot access is on. params.json is {}. Replace placeholders; use --token-file, never --token." },
    { group: "Bot bridge", command: "node scripts/morrow-bot-call.js --endpoint https://your-mac.your-tailnet.ts.net:8443/api/bot/v1/call --token-file /path/to/morrow-bot-token --installation '<installation-id-from-settings>' --operation bridge.describe --params-file ./params.json", action: "After the Tailscale steps, use the exact paired HTTPS endpoint. TLS is verified; redirects and non-loopback plain HTTP are rejected." },
    { group: "Bot bridge", command: "node scripts/morrow-bot-call.js --token-file /path/to/morrow-bot-token --installation '<installation-id-from-settings>' --operation mail.list_cached --params-file ./list.json", action: "List the granted account's cached inbox with the list.json example above. This does not fetch new mail or mark it read." },
    { group: "Bot bridge", command: "node scripts/morrow-bot-call.js --token-file /path/to/morrow-bot-token --installation '<installation-id-from-settings>' --operation mail.send --request-id '<uuid>' --params-file ./send.json", action: "Sends immediately with mail.send permission. Use the send.json example; keep the same UUID and content for retries. Mail-provider submission cannot be recalled once it begins." },
    { group: "Tailscale Serve", command: "tailscale serve --bg --https=8443 --accept-app-caps=com.coke1120.morrow-mail/bot-access http://127.0.0.1:47831", action: "Run this on the computer where Morrow is open. Morrow does not run it. Settings copies the same command. The port stays 8443 until you save another HTTPS port. Do not run tailscale funnel." },
    { group: "Tailscale Serve", command: "tailscale serve status --json", action: "Show Serve status as JSON. Morrow does not run this." },
    { group: "Tailscale Serve", command: "tailscale funnel status --json", action: "Confirm Funnel is not serving this port. Do not run tailscale funnel." },
  ];
}

function editableField(target) {
  if (!target || typeof target.closest !== "function") return null;
  const node = target.closest("input, textarea, select, [contenteditable]");
  if (!node) return null;
  if (node.isContentEditable) return node;
  const tag = node.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return null;
  if (node.disabled || node.readOnly) return null;
  const type = String(node.type || "").toLowerCase();
  if (type === "button" || type === "checkbox" || type === "radio" || type === "range" || type === "file" || type === "submit" || type === "reset" || type === "color") return null;
  return node;
}

function topOpenDialog() {
  const active = document.activeElement;
  if (active && typeof active.closest === "function") {
    const owned = active.closest("dialog[open]");
    if (owned) return owned;
  }
  const open = typeof document.querySelectorAll === "function" ? [...document.querySelectorAll("dialog[open]")] : [];
  return open.length ? open[open.length - 1] : null;
}

function mailShortcutContext(event) {
  const menu = $("organize-menu");
  const top = topOpenDialog();
  let textSelected = false;
  if (typeof window.getSelection === "function") {
    const selection = window.getSelection();
    textSelected = !!(selection && selection.isCollapsed === false && String(selection));
  }
  return {
    typing: !!editableField(event && event.target),
    dialog: !!top || undoPopoverOpen() || !!event?.target?.closest?.("#body-sync"),
    menu: !!(menu && menu.hidden === false),
    topDialog: top && top.id ? top.id : "",
    mailOpen: !!(state.email && state.email.id && !state.email.outbox),
    view: state.view,
    textSelected: textSelected,
  };
}

// Reply, Reply All, and Forward are plain R, A, and F. CommandOrControl+R stays View → Reload.
function mailShortcut(event, context) {
  if (!event || event.isComposing || event.repeat) return "";
  const ctx = context || {};
  const key = String(event.key || "");
  const lower = key.toLowerCase();
  const command = event.metaKey === true || event.ctrlKey === true;
  const alt = event.altKey === true;
  const shift = event.shiftKey === true;
  const typing = ctx.typing === true;
  const dialog = ctx.dialog === true;
  const menu = ctx.menu === true;
  const view = ctx.view == null ? "mail" : ctx.view;
  const mailOpen = ctx.mailOpen === true && view === "mail";
  const top = ctx.topDialog || "";
  if (command && !alt && !shift && key === "Enter") {
    if (top === "compose-preview") return "send-confirm";
    if (top === "compose") return "send";
    return "";
  }
  if (command && !alt && !shift && lower === "s") {
    if (top === "compose") return "save-draft";
    return "";
  }
  if (command && !alt && !shift && lower === "n") return "new-mail";
  if (command && !alt && !shift && key === ",") return "settings";
  if (command && !alt && !shift && lower === "f") {
    if (typing || dialog || menu) return "";
    return "search";
  }
  if (command || alt || shift) return "";
  if (key === "/") {
    if (typing || dialog || menu) return "";
    return "search";
  }
  if (typing || dialog || menu) return "";
  if ((key === "Delete" || key === "Backspace") && mailOpen && ctx.textSelected !== true) return "delete";
  if (!mailOpen) return "";
  if (lower === "r") return "reply";
  if (lower === "a") return "reply-all";
  if (lower === "f") return "forward";
  return "";
}

function openReaderCompose(kind) {
  const email = state.email;
  if (!email || email.outbox) return;
  const account = state.accounts.find((item) => item.id === email.accountId) || selectedAccount();
  const self = (account && (account.preferredFromAddress || account.email)) || "";
  return presentCompose(composeSeed(email, kind, self));
}

function focusMailSearch() {
  if (state.view !== "mail") showMail();
  const input = $("search-query");
  if (!input || typeof input.focus !== "function") return;
  input.focus();
  if (typeof input.select === "function") input.select();
}

let mailShortcutAction = "";
let mailShortcutStamp = 0;

function runMailShortcut(action) {
  const now = Date.now();
  if (action && action === mailShortcutAction && now - mailShortcutStamp < 50) return;
  mailShortcutAction = action || "";
  mailShortcutStamp = now;
  if (action === "new-mail") {
    const button = $("compose-open");
    if (button) button.click();
    return;
  }
  if (action === "settings") {
    const button = $("settings-open");
    if (button) button.click();
    return;
  }
  if (action === "search") {
    focusMailSearch();
    return;
  }
  if (action === "delete") {
    if (!state.email) return;
    guard(() => trashOpen(state.email));
    return;
  }
  if (action === "reply" || action === "reply-all" || action === "forward") {
    const kind = action === "reply" ? "reply" : action === "reply-all" ? "all" : "forward";
    guard(() => openReaderCompose(kind));
    return;
  }
  const commandId = action === "send" ? "compose-send" : action === "save-draft" ? "compose-save" : action === "send-confirm" ? "compose-preview-confirm" : "";
  if (!commandId) return;
  const button = $(commandId);
  if (!button || button.disabled) return;
  button.click();
}

function readerWindowShortcut(action) {
  return action === "reply" || action === "reply-all" || action === "forward" || action === "delete";
}

function onMailShortcut(event) {
  const action = mailShortcut(event, mailShortcutContext(event));
  if (!action) return;
  if (isReaderWindow() && !readerWindowShortcut(action)) return;
  event.preventDefault();
  runMailShortcut(action);
}

function onMenuAction(payload) {
  const action = payload && payload.action;
  if (action === "new-mail" || action === "settings") runMailShortcut(action);
}

function cliCopyIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "9");
  rect.setAttribute("y", "9");
  rect.setAttribute("width", "13");
  rect.setAttribute("height", "13");
  rect.setAttribute("rx", "2");
  rect.setAttribute("ry", "2");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
  svg.append(rect, path);
  return svg;
}

function copyCliCommand(command) {
  const status = $("cli-copy-status");
  const fail = () => {
    if (status) status.textContent = "Could not copy. Select the command and copy it.";
  };
  if (!command || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    fail();
    return;
  }
  navigator.clipboard.writeText(command).then(() => {
    if (status) status.textContent = "Command copied. Morrow did not run it.";
  }).catch(fail);
}

function wireCliCopy() {
  const list = $("cli-list");
  if (!list || list.dataset.wired === "1") return;
  list.dataset.wired = "1";
  list.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest("[data-cli-copy]");
    if (!button || !list.contains(button)) return;
    copyCliCommand(button.getAttribute("data-cli-copy") || "");
  });
}

function paintCli() {
  const note = $("cli-note");
  if (note) note.textContent = cliNote();
  const list = $("cli-list");
  if (!list) return;
  list.replaceChildren();
  let group = "";
  for (const row of cliCatalog()) {
    if (row.group !== group) {
      group = row.group;
      const heading = document.createElement("li");
      heading.className = "shortcut-group";
      heading.textContent = group;
      list.appendChild(heading);
    }
    const item = document.createElement("li");
    item.className = "shortcut-row cli-row";
    const command = document.createElement("div");
    command.className = "cli-command";
    const code = document.createElement("code");
    code.textContent = row.command;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost icon-label";
    button.setAttribute("data-cli-copy", row.command);
    button.setAttribute("aria-label", "Copy " + row.command);
    const label = document.createElement("span");
    label.textContent = "Copy";
    button.append(cliCopyIcon(), label);
    command.append(code, button);
    const action = document.createElement("span");
    action.className = "shortcut-action";
    action.textContent = row.action;
    item.append(command, action);
    list.appendChild(item);
  }
  wireCliCopy();
}

function normalizeFeatureCatalog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = typeof row.id === "string" ? row.id : "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) continue;
    if (typeof row.title !== "string" || !row.title.trim()) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const category = typeof row.category === "string" && row.category.trim() ? row.category.trim() : "";
    items.push({
      id: id,
      title: row.title.trim(),
      blurb: typeof row.blurb === "string" ? row.blurb.trim() : "",
      category: category,
    });
  }
  return items;
}

function groupFeatureCatalog(items) {
  if (!Array.isArray(items)) return [];
  const groups = [];
  const index = new Map();
  const loose = [];
  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const category = typeof row.category === "string" ? row.category : "";
    if (!category) {
      loose.push(row);
      continue;
    }
    let group = index.get(category);
    if (!group) {
      group = { heading: category, items: [] };
      index.set(category, group);
      groups.push(group);
    }
    group.items.push(row);
  }
  if (!loose.length) return groups;
  if (!groups.length) return [{ heading: "", items: loose }];
  let other = index.get("Other");
  if (!other) {
    other = { heading: "Other", items: [] };
    groups.push(other);
  } else if (groups[groups.length - 1] !== other) {
    groups.splice(groups.indexOf(other), 1);
    groups.push(other);
  }
  other.items.push(...loose);
  return groups;
}

function paintFeatureCatalog() {
  const root = $("features-catalog");
  const empty = $("features-empty");
  let items = [];
  try {
    const catalog = window.morrowFeaturesCatalog;
    items = normalizeFeatureCatalog(catalog && catalog.items);
  } catch (error) {
    items = [];
  }
  if (root) {
    root.replaceChildren();
    for (const group of groupFeatureCatalog(items)) {
      const list = document.createElement("ul");
      list.className = "feature-cards";
      for (const row of group.items) {
        const card = document.createElement("li");
        card.className = "feature-card";
        const title = document.createElement("h4");
        title.className = "feature-card-title";
        title.textContent = row.title || "";
        const blurb = document.createElement("p");
        blurb.className = "feature-card-blurb";
        blurb.textContent = row.blurb || "";
        card.append(title, blurb);
        list.appendChild(card);
      }
      if (group.heading) {
        const section = document.createElement("section");
        section.className = "feature-group";
        const heading = document.createElement("h3");
        heading.textContent = group.heading;
        section.append(heading, list);
        root.appendChild(section);
      } else root.appendChild(list);
    }
  }
  if (empty) empty.hidden = items.length > 0;
}

let featuresTab = "catalog";

function showFeaturesTab(name) {
  if (name !== "catalog" && name !== "shortcuts" && name !== "cli") return;
  featuresTab = name;
  const nav = $("features-tabs");
  if (!nav) return;
  for (const tab of nav.querySelectorAll('[role="tab"]')) {
    const active = tab.dataset.featuresTab === name;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.setAttribute("aria-current", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    const panel = $(tab.getAttribute("aria-controls"));
    if (!panel) continue;
    const wasHidden = panel.hidden;
    panel.hidden = !active;
    if (!active || !wasHidden) continue;
    const motion = motionApi();
    const reduced = !!(motion && typeof motion.reduced === "function" && motion.reduced());
    if (motion && typeof motion.fadePane === "function" && !reduced) motion.fadePane(panel, "y");
  }
}

function wireFeaturesTabs() {
  const nav = $("features-tabs");
  if (!nav || nav.dataset.wired === "1") return;
  nav.dataset.wired = "1";
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest && event.target.closest('[role="tab"]');
    if (!tab || !nav.contains(tab)) return;
    showFeaturesTab(tab.dataset.featuresTab);
    tab.focus({ preventScroll: true });
  });
  nav.addEventListener("keydown", (event) => {
    const tabs = [...nav.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    showFeaturesTab(tabs[next].dataset.featuresTab);
    tabs[next].focus({ preventScroll: true });
  });
}

function applyFeaturesHash() {
  if (isComposeWindow()) return;
  let hash = "";
  try {
    hash = String(location.hash || "");
  } catch (error) {
    return;
  }
  if (hash !== "#features" && hash !== "#shortcuts") return;
  showFeatures();
  if (hash !== "#shortcuts") return;
  history.replaceState(null, "", location.pathname + location.search + "#features");
}

function paintShortcuts() {
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  const note = $("shortcuts-note");
  if (note) note.textContent = shortcutNote(platform);
  const list = $("shortcuts-list");
  if (list) {
    list.replaceChildren();
    let group = "";
    for (const row of shortcutCatalog(platform)) {
      if (row.group !== group) {
        group = row.group;
        const heading = document.createElement("li");
        heading.className = "shortcut-group";
        heading.textContent = group;
        list.appendChild(heading);
      }
      const item = document.createElement("li");
      item.className = "shortcut-row";
      const keys = document.createElement("span");
      keys.className = "shortcut-keys";
      keys.textContent = row.keys;
      const action = document.createElement("span");
      action.className = "shortcut-action";
      action.textContent = row.action;
      item.append(keys, action);
      list.appendChild(item);
    }
  }
}

function onShellKey(event) {
  if (state.view !== "mail") return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
  if (shellBlocked(event.target)) return;
  if (event.target.closest && event.target.closest(".row-actions")) return;
  const control = event.target.closest && event.target.closest("button, a[href], summary, [role='button'], [role='link']");
  if (control && !messageButtons().includes(control)) return;
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
      rememberLayoutPanes();
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
        rememberLayoutPanes();
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
  let status = snap.lastCheckedAt ? "Up to date." : "Updates have not been checked yet.";
  let install = false;
  let busy = false;
  const error = snap.error ? String(snap.error) : "";
  if (snap.manualRequired) {
    status = "Manual installation required. Your current app has not been replaced.";
  } else if (error) {
    status = "Update failed.";
  } else if (snap.installing) {
    status = "Installing…";
    busy = true;
  } else if (snap.downloaded) {
    status = snap.requiresExplicitInstall && snap.platform === "darwin" ? "Update download verified. Installation checks run before restart; macOS may require manual approval." : (snap.version ? "Update " + snap.version + " ready." : "Update ready.");
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
  const pending = !!(snap.available || snap.downloaded || snap.downloading);
  const attention = !!snap.manualRequired || (!error && pending);
  return { version: current, status: status, error: error, install: install, busy: busy, manual: !!snap.manualAvailable, downloaded: !!snap.downloaded, explicitInstall: !!snap.requiresExplicitInstall, lastCheckedAt: snap.lastCheckedAt || null, attention: attention };
}

function paintUpdateAttention(view) {
  const badge = $("update-attention");
  const about = $("rail-about");
  if (!badge || !about) return;
  const attention = !!view.attention;
  badge.hidden = !attention;
  about.classList.toggle("has-update", attention);
  const label = attention ? "About & updates, update available" : "About & updates";
  about.setAttribute("aria-label", label);
  about.setAttribute("title", label);
  about.setAttribute("data-label", label);
}

function paintUpdate(view) {
  $("about-version").textContent = view.version ? "Version " + view.version : "";
  const status = $("about-update-status");
  status.textContent = (view.error ? view.status + " " + view.error : view.status) + (view.lastCheckedAt ? " Last checked " + shownWhen(new Date(view.lastCheckedAt), true) + "." : "");
  status.classList.toggle("error", !!view.error);
  $("about-update-check").disabled = !!view.busy;
  const install = $("about-update-install");
  install.hidden = !view.install;
  install.textContent = "Restart and install";
  install.disabled = !!view.busy;
  $("about-update-quit").hidden = !view.install;
  $("about-update-quit").textContent = view.explicitInstall ? "Restart and install closes Morrow after you finish active work. Quitting alone does not install this update." : "This update will also install automatically when you quit Morrow. Restart and install closes the app now.";
  const manual = $("about-update-manual");
  manual.hidden = !view.manual;
  manual.disabled = !!view.busy;
  manual.textContent = view.downloaded ? "Show downloaded update" : "Open official releases";
  paintUpdateAttention(view);
}

function openAbout() {
  openDialog("about-dialog");
  const serial = updateGen;
  api.invoke("host:updateGetState").then((next) => {
    if (serial !== updateGen) return;
    bumpUpdate(next);
  }).catch((error) => {
    if (serial !== updateGen) return;
    bumpUpdate({ error: error.message });
  });
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
  $("about-update-check").disabled = true;
  const serial = updateGen;
  try {
    const next = await api.invoke("host:updateCheck");
    if (serial !== updateGen) return;
    bumpUpdate(next);
  } catch (error) {
    if (serial !== updateGen) return;
    bumpUpdate({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function installUpdate() {
  $("about-update-install").disabled = true;
  const serial = updateGen;
  try {
    const next = await api.invoke("host:updateInstall");
    if (serial !== updateGen) return;
    bumpUpdate(next);
  } catch (error) {
    if (serial !== updateGen) return;
    bumpUpdate({ error: error instanceof Error ? error.message : String(error) });
  }
}

// No implicit saves or sends: the user must resolve editing before restart.
function updateRestartBlocked() {
  if (attachmentTasks.size) return true;
  if (Array.from(document.querySelectorAll("dialog[open]")).some(node => node.id !== "about-dialog")) return true;
  if (state.composePending || state.composeQueued || state.composeInitializing || state.oauthPending || state.connectPending || state.busy || sendTimer) return true;
  if (state.outboxRows && state.outboxRows.length) return true;
  if (agentChatBusy || brainSkillBusy || brainFixBusy || brainCategoryBusy || brainView.refreshing || brainView.rebuilding) return true;
  if (oooDirty()) return true;
  if (inboxRuleBaseline && JSON.stringify(inboxRuleFieldsFromForm()) !== inboxRuleBaseline) return true;
  if ($("ai-key")?.value) return true;
  if (aiDirty()) return true;
  if (updateAiBaseline !== null && JSON.stringify([$("ai-base")?.value, $("ai-model")?.value]) !== updateAiBaseline) return true;
  if (JSON.stringify(brainCategories) !== updateCategoriesBaseline) return true;
  if ($("agent-memory") && $("agent-memory").value !== updateMemoryBaseline) return true;
  if ($("agent-input")?.value.trim()) return true;
  return false;
}

function prepareUpdateRestart(payload) {
  if (typeof payload?.nonce !== "string") return;
  if (updateFreezeNonce || updateRestartBlocked()) {
    api.replyUpdatePreparation({ nonce: payload.nonce, ok: false });
    return;
  }
  updateFreezeNonce = payload.nonce;
  updateWasInert = document.body.inert;
  document.body.inert = true;
  api.replyUpdatePreparation({ nonce: payload.nonce, ok: true });
}

function resumeAfterUpdate(payload) {
  if (payload?.nonce !== updateFreezeNonce) return;
  document.body.inert = updateWasInert;
  updateFreezeNonce = null;
}

function shellLook(prefs) {
  const src = prefs && typeof prefs === "object" ? prefs : {};
  const theme = String(src.theme || "").trim().toLowerCase() === "dark" ? "dark" : "light";
  const raw = typeof src.accent === "string" ? src.accent.trim() : "";
  const accent = /^#[0-9A-Fa-f]{6}$/.test(raw) ? raw.toUpperCase() : "#193C34";
  return { theme, accent };
}

function applyLook(prefs) {
  const look = shellLook(prefs);
  applyShellTheme(document.documentElement, look.theme, look.accent);
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
  const seen = new Set(srcs.map((image) => image.src));
  const references = /url\(\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s)'"<>]+))\s*\)|\bbackground\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'=<>`]+))/gi;
  for (const reference of String(html || "").matchAll(references)) {
    const src = reference.slice(1).find((value) => value != null)?.trim() || "";
    if (/^https?:\/\/\S+$/i.test(src) && !seen.has(src)) {
      srcs.push({ src, alt: "" });
      seen.add(src);
    }
  }
  return srcs;
}

function sendDelayMs(seconds) {
  const n = typeof seconds === "number" ? seconds : (typeof seconds === "string" && /^-?\d+$/.test(seconds) ? Number(seconds) : NaN);
  if (!Number.isInteger(n) || n < 0 || n > 30) return 5000;
  return n * 1000;
}

const SHELL_PREFS = {
  "morrow:configGetCompactMessageList": "compactList",
  "morrow:configGetShowFolderChips": "chips",
  "morrow:configGetAiWriteAutoOpenOnReply": "aiReply",
  "morrow:configGetMarkReadCompletesAgentTodos": "markReadCompletesTodos",
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
    next.translateLang = translateLangPref(await api.invoke("morrow:configGetTranslateTargetLanguage"));
    for (const [channel, key] of Object.entries(READER_PREFS)) {
      next[key] = (await api.invoke(channel)) === true;
    }
    const collapse = folderCollapse();
    next.collapsedFolders = collapse
      ? collapse.normalize(await api.invoke("morrow:configGetSidebarCollapsedFolders"))
      : (state.prefs.collapsedFolders || {});
    next.undoSend = sendDelayMs(await api.invoke("morrow:configGetUndoSendDelaySeconds")) / 1000;
    next.quoteWidth = quoteWidthPref(await api.invoke("morrow:configGetComposeQuoteWidth"));
    next.syncHorizon = await api.invoke("morrow:configGetSyncHorizonDays");
    next.scheduleDelay = scheduleDelayMinutes(await api.invoke("morrow:configGetDefaultScheduleDelayMinutes"));
    next.layout = layoutPanesPref(await api.invoke("morrow:configGetLayoutPanes"));
    const formats = typeof morrowDisplayFormat === "object" && morrowDisplayFormat ? morrowDisplayFormat : null;
    next.timeFormat = formats
      ? formats.castTimeFormat(await api.invoke("morrow:configGetTimeFormat"), true)
      : "system";
    next.dateFormat = formats
      ? formats.castDateFormat(await api.invoke("morrow:configGetDateFormat"), true)
      : "system";
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  state.prefs = next;
  applyLook(next);
  applyLayoutPanes(next.layout);
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
  if (getChannel === "morrow:configGetTranslateTargetLanguage") {
    state.prefs.translateLang = translateLangPref(readPref(kind, control));
    return false;
  }
  if (getChannel === "morrow:configGetUndoSendDelaySeconds") {
    state.prefs.undoSend = sendDelayMs(readPref(kind, control)) / 1000;
    return true;
  }
  if (getChannel === "morrow:configGetSyncHorizonDays") {
    state.prefs.syncHorizon = readPref(kind, control);
    return false; // The sync policy is read on the next host sync.
  }
  if (getChannel === "morrow:configGetTimeFormat" || getChannel === "morrow:configGetDateFormat") {
    const formats = typeof morrowDisplayFormat === "object" && morrowDisplayFormat ? morrowDisplayFormat : null;
    if (getChannel === "morrow:configGetTimeFormat") {
      state.prefs.timeFormat = formats ? formats.castTimeFormat(control.value, true) : "system";
    } else {
      state.prefs.dateFormat = formats ? formats.castDateFormat(control.value, true) : "system";
    }
    return true;
  }
  return false;
}

function paintPrefs() {
  applyLook(state.prefs);
  renderAccounts();
  renderList();
  refreshReader();
  repaintClockSurfaces();
}

function repaintClockSurfaces() {
  if ($("refresh")) paintSyncControl();
  if (state.view === "calendar" && state.calendarPayload && $("calendar-heading")) {
    calendarGridKey = "";
    calendarEventsKey = "";
    const mini = $("calendar-mini");
    if (mini && mini.dataset) delete mini.dataset.month;
    paintCalendar(state.calendarPayload);
  }
  const history = $("sender-history");
  if (history && history.open) paintSenderHistory();
  const scheduled = $("scheduled-dialog");
  if (scheduled && scheduled.open) loadScheduled().catch(() => {});
  if ($("schedule-preset") && $("schedule-note")) syncScheduleFields();
  if ($("compose-quote-body")) paintQuoteBody();
  const preview = $("compose-preview");
  if (preview && preview.open && previewDraftState) paintPreview(previewDraftState);
  if (state.view === "log" && $("log-lines")) filterSupportLog();
  if ($("mail-ooo")) paintMailVacation();
  if (brainIsOpen() && $("brain-status")) paintBrain(brainSnapshot, brainView);
  if (state.view === "agent" && agentPaintPayload && $("agent-status")) paintAgent(agentPaintPayload, "");
}

async function toggleProviderFolders(provider) {
  const spec = provider === "gmail"
    ? ["gmailOpen", "morrow:configSetSidebarGmailFoldersExpanded"]
    : ["outlookOpen", "morrow:configSetSidebarOutlookFoldersExpanded"];
  const key = spec[0];
  const gen = ++folderCollapseGen;
  const next = !state.prefs[key];
  state.prefs[key] = next;
  renderAccounts();
  try {
    const saved = (await api.invoke(spec[1], next)) === true;
    if (gen !== folderCollapseGen) return;
    state.prefs[key] = saved;
  } catch (error) {
    if (gen !== folderCollapseGen) return;
    showStatus(error instanceof Error ? error.message : String(error), true);
    await loadShellPrefs();
  }
  if (gen !== folderCollapseGen) return;
  renderAccounts();
  folderNavRestore = false;
}

async function toggleSidebarFolder(accountId, folderId) {
  const collapse = folderCollapse();
  if (!collapse) {
    folderNavRestore = false;
    return;
  }
  const gen = ++folderCollapseGen;
  const next = collapse.toggle(state.prefs.collapsedFolders, accountId, folderId);
  state.prefs.collapsedFolders = next;
  renderAccounts();
  try {
    const saved = collapse.normalize(await api.invoke("morrow:configSetSidebarCollapsedFolders", next));
    if (gen !== folderCollapseGen) return;
    state.prefs.collapsedFolders = saved;
  } catch (error) {
    if (gen !== folderCollapseGen) return;
    showStatus(error instanceof Error ? error.message : String(error), true);
    await loadShellPrefs();
  }
  if (gen !== folderCollapseGen) return;
  renderAccounts();
  folderNavRestore = false;
}

async function collapseAllFolders() {
  const collapse = folderCollapse();
  if (!collapse) return;
  folderNavRestore = false;
  const gen = ++folderCollapseGen;
  let next = collapse.normalize(state.prefs.collapsedFolders);
  for (const account of state.accounts) {
    const parents = [];
    const seen = new Set();
    for (const folder of folderTree(foldersOf(account), accountDelimiter(account))) {
      const id = folder && folder.parentId ? String(folder.parentId) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      parents.push(id);
    }
    next = collapse.collapseIds(next, account.id, parents);
  }
  const closeGmail = state.prefs.gmailOpen !== false;
  const closeOutlook = state.prefs.outlookOpen === true;
  const changed = JSON.stringify(next) !== JSON.stringify(collapse.normalize(state.prefs.collapsedFolders));
  if (!changed && !closeGmail && !closeOutlook) return;
  state.prefs.collapsedFolders = next;
  if (closeGmail) state.prefs.gmailOpen = false;
  if (closeOutlook) state.prefs.outlookOpen = false;
  renderAccounts();
  try {
    if (closeGmail && gen === folderCollapseGen) {
      state.prefs.gmailOpen = (await api.invoke("morrow:configSetSidebarGmailFoldersExpanded", false)) === true;
    }
    if (closeOutlook && gen === folderCollapseGen) {
      state.prefs.outlookOpen = (await api.invoke("morrow:configSetSidebarOutlookFoldersExpanded", false)) === true;
    }
    if (gen !== folderCollapseGen) return;
    if (changed) state.prefs.collapsedFolders = collapse.normalize(await api.invoke("morrow:configSetSidebarCollapsedFolders", next));
  } catch (error) {
    if (gen !== folderCollapseGen) return;
    showStatus(error instanceof Error ? error.message : String(error), true);
    await loadShellPrefs();
  }
  if (gen === folderCollapseGen) renderAccounts();
}

function prefRows() {
  return [
    ["pref-theme", "config:getTheme", "config:setTheme", "select"],
    ["pref-accent", "morrow:configGetAccent", "morrow:configSetAccent", "text"],
    ["pref-time-format", "morrow:configGetTimeFormat", "morrow:configSetTimeFormat", "select"],
    ["pref-date-format", "morrow:configGetDateFormat", "morrow:configSetDateFormat", "select"],
    ["pref-translate-language", "morrow:configGetTranslateTargetLanguage", "morrow:configSetTranslateTargetLanguage", "select"],
    ["pref-conversation", "morrow:configGetConversationViewEnabled", "morrow:configSetConversationViewEnabled", "bool"],
    ["pref-images", "morrow:configGetAutoLoadRemoteImages", "morrow:configSetAutoLoadRemoteImages", "bool"],
    ["pref-undo", "morrow:configGetUndoSendDelaySeconds", "morrow:configSetUndoSendDelaySeconds", "seconds"],
    ["pref-sync-horizon", "morrow:configGetSyncHorizonDays", "morrow:configSetSyncHorizonDays", "days"],
    ["pref-compact-list", "morrow:configGetCompactMessageList", "morrow:configSetCompactMessageList", "bool"],
    ["pref-snooze", "morrow:configGetSnoozeEffective", "morrow:configSetSnoozeEffective", "bool"],
    ["pref-ai-reply", "morrow:configGetAiWriteAutoOpenOnReply", "morrow:configSetAiWriteAutoOpenOnReply", "bool"],
    ["pref-agent-read-done", "morrow:configGetMarkReadCompletesAgentTodos", "morrow:configSetMarkReadCompletesAgentTodos", "bool"],
    ["pref-folder-chips", "morrow:configGetShowFolderChips", "morrow:configSetShowFolderChips", "bool"],
    ["pref-gmail-folders", "morrow:configGetSidebarGmailFoldersExpanded", "morrow:configSetSidebarGmailFoldersExpanded", "bool"],
    ["pref-outlook-folders", "morrow:configGetSidebarOutlookFoldersExpanded", "morrow:configSetSidebarOutlookFoldersExpanded", "bool"],
  ];
}

function readPref(kind, control) {
  if (kind === "bool") return control.checked === true;
  if (kind === "seconds" || kind === "days") {
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

function syncAccentPicker(value) {
  const picker = $("pref-accent-picker");
  const reset = $("pref-accent-reset");
  const clean = /^#[0-9A-Fa-f]{6}$/.test(String(value || "").trim())
    ? String(value).trim().toLowerCase()
    : "#193c34";
  if (picker) picker.value = clean;
  if (reset) reset.disabled = clean === "#193c34";
}

async function loadSettings() {
  const status = $("settings-status");
  status.textContent = "";
  status.classList.remove("error");
  // Boot and preference writes already maintain this snapshot. Opening a dialog
  // must not repeat preference IPC reads or load closed provider/AI/Bot tabs.
  const keys = { ...SHELL_PREFS, ...READER_PREFS, "config:getTheme": "theme",
    "morrow:configGetAccent": "accent", "morrow:configGetUndoSendDelaySeconds": "undoSend",
    "morrow:configGetSyncHorizonDays": "syncHorizon",
    "morrow:configGetTimeFormat": "timeFormat", "morrow:configGetDateFormat": "dateFormat",
    "morrow:configGetTranslateTargetLanguage": "translateLang" };
  for (const [id, channel, , kind] of prefRows()) {
    applyPref(kind, $(id), state.prefs[keys[channel]]);
  }
  syncAccentPicker(state.prefs.accent);
  paintScheduleDelay(state.prefs.scheduleDelay);
  await paintAgentLearned();
}

function paintScheduleDelay(minutes) {
  const parts = splitScheduleDelay(minutes);
  const hours = $("pref-schedule-hours");
  const mins = $("pref-schedule-minutes");
  if (hours) hours.value = String(parts.hours);
  if (mins) mins.value = String(parts.minutes);
}

function readWhole(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) return NaN;
  return Number(raw);
}

let scheduleStatusTimer = 0;
function setScheduleStatus(text, isError) {
  const node = $("pref-schedule-status");
  settingsInlineStatus(node, text, isError);
  if (scheduleStatusTimer) clearTimeout(scheduleStatusTimer);
  scheduleStatusTimer = 0;
  if (text && !isError) {
    scheduleStatusTimer = setTimeout(() => {
      scheduleStatusTimer = 0;
      settingsInlineStatus($("pref-schedule-status"), "", false);
    }, 1800);
  }
}

let scheduleDelaySaveSerial = 0;
let scheduleDelaySaveQueue = Promise.resolve();
function scheduleDelaySnapshot() {
  return JSON.stringify([$("pref-schedule-hours")?.value, $("pref-schedule-minutes")?.value]);
}
async function saveScheduleDelay() {
  const serial = ++scheduleDelaySaveSerial;
  const snapshot = scheduleDelaySnapshot();
  const hours = readWhole($("pref-schedule-hours") && $("pref-schedule-hours").value);
  const minutes = readWhole($("pref-schedule-minutes") && $("pref-schedule-minutes").value);
  const total = joinScheduleDelay(hours, minutes);
  if (total == null) {
    setScheduleStatus("Default schedule delay must be 0 to 168 hours, with minutes from 0 to 59, and at most 7 days.", true);
    paintScheduleDelay(state.prefs.scheduleDelay);
    return;
  }
  const pending = scheduleDelaySaveQueue.then(async () => {
    try {
      await api.invoke("morrow:configSetDefaultScheduleDelayMinutes", total);
      const saved = scheduleDelayMinutes(await api.invoke("morrow:configGetDefaultScheduleDelayMinutes"));
      state.prefs.scheduleDelay = saved;
      if (serial !== scheduleDelaySaveSerial) return;
      const edited = scheduleDelaySnapshot() !== snapshot;
      if (!edited) paintScheduleDelay(saved);
      setScheduleStatus((saved
        ? "Saved. Send schedules " + formatScheduleDelay(saved) + " ahead."
        : "Saved. Send delivers immediately.") + (edited ? " Newer edits are not saved yet." : ""), false);
      if ($("compose") && $("compose").open) syncCompose();
    } catch (error) {
      if (serial !== scheduleDelaySaveSerial) return;
      setScheduleStatus(error instanceof Error ? error.message : String(error), true);
      if (scheduleDelaySnapshot() === snapshot) paintScheduleDelay(state.prefs.scheduleDelay);
    }
  });
  scheduleDelaySaveQueue = pending;
  return pending;
}

const settingsFoldPending = new Map();
const settingsFoldLoaded = new Set();
const settingsFoldLoadingLabels = {
  prefs: "Loading settings…",
  mail: "Loading mail and sync settings…",
  mailbox: "Loading mailbox tools…",
  ai: "Loading AI settings…",
  compose: "Loading compose defaults…",
  ooo: "Checking Out of Office status…",
  bot: "Loading Bot access…",
};
function setSettingsFoldLoading(fold, label) {
  if (!fold) return;
  let loading = fold.querySelector(":scope > .fold-loading");
  if (!label) {
    if (loading) loading.remove();
    return;
  }
  if (!loading) {
    loading = document.createElement("div");
    loading.className = "fold-loading";
    loading.setAttribute("role", "status");
    const spin = document.createElement("span");
    spin.className = "fold-loading-spin";
    spin.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "fold-loading-label";
    loading.append(spin, text);
    fold.insertBefore(loading, fold.firstChild);
  }
  const text = loading.querySelector(".fold-loading-label");
  if (text) text.textContent = label;
}
function settingsFoldKey(name) {
  return name + ":" + (["mailbox", "ooo"].includes(name) ? settingsAccount()?.id || "" : "");
}
function loadComposeSettings() {
  if (!window.morrowBrainCompose) return Promise.resolve();
  return window.morrowBrainCompose.load({
    call,
    accounts: () => state.accounts,
    selectedId: () => state.accountId,
    openSignatures,
  });
}
function loadSettingsFold(name) {
  if (!$("settings").open) return Promise.resolve();
  const key = settingsFoldKey(name);
  if (settingsFoldLoaded.has(key)) {
    if (name === "compose") return loadComposeSettings();
    return Promise.resolve();
  }
  if (settingsFoldPending.has(key)) return settingsFoldPending.get(key);
  const fold = document.querySelector('#settings .fold[data-fold="' + name + '"]');
  if (!fold) return Promise.resolve();
  const panel = fold.querySelector(".fold-panel");
  const pending = new Promise(resolve => afterPaint(resolve)).then(async () => {
    if (settingsFoldPending.get(key) !== pending || !$("settings").open || !fold.classList.contains("is-open") || key !== settingsFoldKey(name)) return;
    panel.inert = true;
    panel.setAttribute("aria-busy", "true");
    setSettingsFoldLoading(fold, settingsFoldLoadingLabels[name] || "Loading…");
    if (name === "prefs" || name === "mail") await loadSettings();
    else if (name === "ai") {
      await loadSettings();
      if (settingsFoldPending.get(key) !== pending || !$("settings").open) return;
      if (aiDirty()) await resumeAiSettings();
      else await loadAiSettings();
    }
    else if (name === "mailbox") { renderSettingsAccounts(); await loadSettingsCapabilities(); await loadGoogleOauthClient(); }
    else if (name === "compose") await loadComposeSettings();
    else if (name === "ooo" && !oooDirty()) {
      if (await loadVacation() !== true) return;
    }
    else if (name === "bot") await loadBotAccess();
    if (settingsFoldPending.get(key) === pending) settingsFoldLoaded.add(key);
  }).catch(error => {
    if (settingsFoldPending.get(key) !== pending || key !== settingsFoldKey(name)) return;
    const message = error instanceof Error ? error.message : String(error);
    if (name === "ooo") setOooStatus(message, true);
    else if (name === "bot") setBotStatus(message, true);
    else { $("settings-status").textContent = message; $("settings-status").classList.add("error"); }
  }).finally(() => {
    if (settingsFoldPending.get(key) !== pending) return;
    settingsFoldPending.delete(key);
    const pendingForFold = [...settingsFoldPending.keys()].some(other => other.startsWith(name + ":"));
    if (!pendingForFold) {
      panel.inert = false;
      panel.removeAttribute("aria-busy");
      setSettingsFoldLoading(fold, "");
    }
  });
  settingsFoldPending.set(key, pending);
  return pending;
}

const OOO_FIELD_IDS = ["ooo-mode", "ooo-start", "ooo-end", "ooo-subject", "ooo-message", "ooo-external", "ooo-audience"];

function vacationFieldForError(message) {
  const text = String(message || "");
  if (text === "Choose Disabled, Always, or Scheduled.") return "ooo-mode";
  if (text === "The subject must fit on one line.") return "ooo-subject";
  if (text === "Enter a reply message." || text === "The reply must be plain text.") return "ooo-message";
  if (text === "Enter the external reply.") return "ooo-external";
  if (text === "Choose a valid reply audience." || text === "IMAP vacation replies go to every sender.") return "ooo-audience";
  if (text === "The end must be after the start." || text === "Choose an end time in the future.") return "ooo-end";
  if (text === "Outlook needs a start and an end." || text === "Enter a start or an end.") {
    return String(($("ooo-start") && $("ooo-start").value) || "").trim() ? "ooo-end" : "ooo-start";
  }
  if (text === "Shorten the automatic reply.") {
    if (String(($("ooo-subject") && $("ooo-subject").value) || "").length > 200) return "ooo-subject";
    if (String(($("ooo-external") && $("ooo-external").value) || "").length > 10000) return "ooo-external";
    return "ooo-message";
  }
  return "";
}

function setOooStatus(text, isError) {
  const status = $("ooo-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("error", !!isError && !!text);
  clearFieldErrors(OOO_FIELD_IDS);
  if (isError && text) {
    const field = vacationFieldForError(text);
    if (field) setFieldError(field, text);
  }
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
  if (vacationCache) rememberVacation(vacationCache);
  const view = vacationView(vacationCache);
  const note = $("ooo-note");
  if (note) {
    note.textContent = view.note;
    note.hidden = !view.note;
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
  $("ooo-timezone").textContent = "Times use " + Intl.DateTimeFormat().resolvedOptions().timeZone + ".";
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
  const account = settingsAccount();
  if (!account || !isLive(account)) {
    vacationCache = null;
    paintVacation(null);
    setOooStatus("Choose a connected mailbox.", false);
    return;
  }
  setOooStatus("Contacting the mail provider…", false);
  const gen = ++settingsVacationGen;
  const snapshot = oooSnapshot();
  const data = await call("mail:vacationGet", { accountId: account.id });
  if (gen !== settingsVacationGen) return;
  if (!data || data.accountId !== account.id) throw new Error("Out of Office response did not match this mailbox.");
  if (!settingsAccount() || settingsAccount().id !== account.id) return;
  const edited = applyVacationResponse(data, snapshot);
  setOooStatus(edited ? "Provider settings loaded. Newer edits are not saved yet." : "", false);
  return true;
}

function applyVacationResponse(data, snapshot) {
  const current = oooSnapshot();
  const edited = current !== snapshot;
  paintVacation(data);
  oooBaseline = oooSnapshot();
  if (edited) {
    const values = JSON.parse(current);
    ["ooo-mode", "ooo-start", "ooo-end", "ooo-subject", "ooo-message", "ooo-external", "ooo-audience", "ooo-domain"].forEach((id, index) => {
      const field = $(id);
      if (!field) return;
      if (field.type === "checkbox") field.checked = values[index];
      else field.value = values[index];
    });
    syncVacationFields();
  }
  paintOooDirty();
  return edited;
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
  const account = settingsAccount();
  if (!account || !isLive(account) || !vacationCache || vacationCache.accountId !== account.id) {
    throw new Error("Choose a connected mailbox.");
  }
  const body = vacationFormBody(kind);
  const snapshot = oooSnapshot();
  if (kind !== "disable") {
    const draft = vacationDraft({ ...body, provider: vacationCache.provider });
    if (draft.error) throw new Error(draft.error);
  }
  const answer = await askConfirm(vacationConfirm(kind === "disable" ? "disable" : "save", account.email || account.id, {
    ...body,
    provider: vacationCache.provider,
  }));
  if (!answer || !answer.ok) return;
  const current = settingsAccount();
  if (!current || current.id !== account.id || !vacationCache || vacationCache.accountId !== account.id) {
    throw new Error("Choose a connected mailbox.");
  }
  setOooStatus("Contacting the mail provider…", false);
  const gen = ++settingsVacationGen;
  const saved = await call("mail:vacationPut", body);
  if (gen !== settingsVacationGen || settingsAccount()?.id !== account.id) return;
  if (!saved || saved.accountId !== account.id) throw new Error("Out of Office response did not match this mailbox.");
  const edited = applyVacationResponse(saved, snapshot);
  setOooStatus(edited ? "Reviewed reply saved on the provider. Newer edits are not saved yet." : "Saved on the provider.", false);
}

async function grantVacationAccess() {
  const account = settingsAccount();
  if (!account || !isLive(account)) throw new Error("Choose a connected mailbox.");
  const answer = await askConfirm(vacationConfirm("grant", account.email || account.id, {
    provider: vacationProvider(account),
    scope: vacationCache && vacationCache.requiredScope,
  }));
  if (!answer || !answer.ok) return;
  if (!settingsAccount() || settingsAccount().id !== account.id) throw new Error("Choose a connected mailbox.");
  setOooStatus("Waiting for mailbox feature permissions…", false);
  await call("mail:grantVacation", { accountId: account.id });
  await loadVacation();
  setOooStatus("Out of Office settings permission saved.", false);
}

const AI_FIELD_IDS = ["ai-base", "ai-model", "ai-key"];

function aiFieldForError(message) {
  const text = String(message || "");
  if (/api key|unconfigured|unauthori[sz]ed|\b401\b|\b403\b|bearer/i.test(text)) return "ai-key";
  if (/base url|endpoint|\burl\b|network|fetch failed|enotfound|econnrefused/i.test(text)) return "ai-base";
  if (/\bmodel\b/i.test(text)) return "ai-model";
  return "";
}

function setAiStatus(text, isError) {
  const status = $("ai-status");
  status.textContent = text || "";
  status.classList.toggle("error", !!isError && !!text);
  clearFieldErrors(AI_FIELD_IDS);
  if (isError && text) {
    const field = aiFieldForError(text);
    if (field) setFieldError(field, text);
  }
}

function aiKeyPlaceholder(cfg) {
  if (cfg && cfg.hasKey) return "Saved " + (cfg.keyHint || "••••") + ". Leave blank to keep it.";
  return "sk-…";
}

let aiBaseline = "";
let chatgptSettings = null;
let aiOperation = 0;
let aiViewRevision = 0;
let aiSaveBusy = false;
function aiAuthDraft() { return chatgptSettings ? chatgptSettings.draft() : {}; }
function mountChatgptSettings() {
  const container = $("ai-account-settings");
  if (!chatgptSettings && container && window.morrowChatgptSettings) {
    chatgptSettings = window.morrowChatgptSettings.mount({
      container, consentContainer: $("ai-data-settings") || container,
      invoke: (channel, input) => api.invoke(channel, input), onChange: paintAiDirty,
      onSave: saveAiSettings,
      onReviewConnection: () => $("ai-base").focus(),
      onContext: () => { aiOperation++; setAiStatus("", false); },
      onMode: (chatgpt) => {
        for (const id of ["ai-api-base-field", "ai-api-model-field", "ai-api-key-field"]) if ($(id)) $(id).hidden = chatgpt;
      },
    });
  }
  return chatgptSettings;
}
function aiSettingsDraft() {
  return { baseUrl: $("ai-base").value, model: $("ai-model").value, apiKey: $("ai-key").value, ...aiAuthDraft() };
}
function aiFormState(input = aiSettingsDraft()) {
  return JSON.stringify([
    String(input.baseUrl || "").trim(), String(input.model || "").trim(),
    !!input.apiKey,
    { authMode: input.authMode || "api_key", chatgptModel: String(input.chatgptModel || "").trim() },
  ]);
}
function aiRequestCurrent(operation, view, input, context) {
  return operation === aiOperation && view === aiViewRevision
    && JSON.stringify(input) === JSON.stringify(aiSettingsDraft())
    && context === chatgptSettings?.context?.();
}
function aiDirty() {
  return !!aiBaseline && aiFormState() !== aiBaseline;
}
function paintAiDirty(preserveStatus = false) {
  const note = $("ai-dirty");
  if (!note) return;
  const dirty = aiDirty();
  chatgptSettings?.setConnectionState({ dirty, saving: aiSaveBusy });
  note.hidden = !dirty;
  note.textContent = dirty ? "Unsaved changes. Save AI to apply them." : "";
  const status = $("ai-status")?.textContent || "";
  if ((dirty && status === "Saved.") || (preserveStatus !== true && status.startsWith("Connected."))) setAiStatus("", false);
}

function closeAiSettings() {
  aiViewRevision++;
  aiOperation++;
  chatgptSettings?.dispose();
  // A new dialog session must not join a closed session's pending fold read.
  const key = settingsFoldKey("ai");
  settingsFoldLoaded.delete(key);
  settingsFoldPending.delete(key);
}

async function resumeAiSettings() {
  const view = ++aiViewRevision;
  aiOperation++;
  const accountSettings = mountChatgptSettings();
  paintAiDirty(true);
  if (accountSettings) await accountSettings.resume();
  if (view === aiViewRevision) paintAiDirty(true);
}

function clearAiModelChoices() {
  const chooser = $("ai-model-chooser");
  const select = $("ai-model-select");
  if (select) {
    select.replaceChildren();
    select.value = "";
  }
  if (chooser) chooser.hidden = true;
}

function applyFetchedModels(ids) {
  const chooser = $("ai-model-chooser");
  const select = $("ai-model-select");
  if (!chooser || !select) return 0;
  select.replaceChildren();
  const seen = new Set();
  const models = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  if (!models.length) {
    select.value = "";
    chooser.hidden = true;
    return 0;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a model";
  select.appendChild(placeholder);
  const current = String(($("ai-model") && $("ai-model").value) || "").trim();
  for (const id of models) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    select.appendChild(option);
  }
  select.size = Math.min(8, Math.max(models.length + 1, 3));
  select.value = models.includes(current) ? current : "";
  chooser.hidden = false;
  return models.length;
}

function chooseFetchedModel() {
  const select = $("ai-model-select");
  const input = $("ai-model");
  if (!select || !input) return;
  const id = String(select.value || "").trim();
  if (!id || input.value === id) return;
  input.value = id;
  if (typeof input.dispatchEvent === "function") {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  paintAiDirty();
}

async function loadAiSettings() {
  const view = ++aiViewRevision;
  aiOperation++;
  setAiStatus("", false);
  $("ai-key").value = "";
  clearAiModelChoices();
  try {
    const cfg = await api.invoke("host:aiGetConfig");
    if (view !== aiViewRevision) return;
    $("ai-base").value = cfg && cfg.baseUrl ? cfg.baseUrl : "";
    $("ai-model").value = cfg && cfg.model ? cfg.model : "";
    $("ai-key").placeholder = aiKeyPlaceholder(cfg);
    // A later account/permission reply must not replace a newer Save baseline.
    updateAiBaseline = JSON.stringify([cfg?.baseUrl || "", cfg?.model || ""]);
    aiBaseline = aiFormState(cfg || {});
    const accountSettings = mountChatgptSettings();
    if (accountSettings) await accountSettings.load(cfg || {});
    if (view !== aiViewRevision) return;
    paintAiDirty();
  } catch (error) {
    if (view === aiViewRevision) setAiStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function saveAiSettings() {
  if (aiSaveBusy) return;
  const input = aiSettingsDraft();
  const operation = ++aiOperation;
  const view = aiViewRevision;
  aiSaveBusy = true;
  chatgptSettings?.setConnectionState({ dirty: aiDirty(), saving: true });
  $("ai-save").disabled = true;
  setAiStatus("Saving…", false);
  try {
    const saved = await api.invoke("host:aiSaveConfig", input);
    if (window.morrowAiIndicator) window.morrowAiIndicator.paint(saved);
    if (view !== aiViewRevision) return;
    // Only reconcile fields still owned by this save. New edits stay in the form.
    if ($("ai-key").value === input.apiKey) $("ai-key").value = "";
    if ($("ai-base").value === input.baseUrl) $("ai-base").value = saved.baseUrl;
    if ($("ai-model").value === input.model) $("ai-model").value = saved.model;
    $("ai-key").placeholder = aiKeyPlaceholder(saved);
    updateAiBaseline = JSON.stringify([saved.baseUrl, saved.model]);
    aiBaseline = aiFormState(saved);
    chatgptSettings?.refreshConsent();
    paintAiDirty(true);
    if (operation === aiOperation) setAiStatus(aiDirty() ? "Earlier settings saved. Your newer changes are not saved." : "Saved.", false);
  } catch (error) {
    if (operation === aiOperation && view === aiViewRevision) setAiStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    aiSaveBusy = false;
    $("ai-save").disabled = false;
    paintAiDirty(true);
  }
}

async function fetchAiModels() {
  const operation = ++aiOperation;
  const view = aiViewRevision;
  const input = aiSettingsDraft();
  const context = chatgptSettings?.context?.();
  setAiStatus(aiDirty() ? "Fetching models with the unsaved values in this form…" : "Fetching models…", false);
  try {
    if (aiAuthDraft().authMode === "chatgpt") {
      const count = await chatgptSettings.fetchModels();
      if (operation === aiOperation && view === aiViewRevision && aiAuthDraft().authMode === "chatgpt" && context === chatgptSettings?.context?.()) {
        setAiStatus(count ? `Fetched ${count} ChatGPT models. Choose one, then Save AI.` : "No ChatGPT models are available for this account.", false);
      }
      return;
    }
    const result = await api.invoke("host:aiListModels", {
      baseUrl: $("ai-base").value,
      apiKey: $("ai-key").value,
      authMode: "api_key",
    });
    if (!aiRequestCurrent(operation, view, input, context)) return;
    if (!result || result.ok !== true) {
      setAiStatus((result && result.message) || "Could not list models.", true);
      return;
    }
    const ids = Array.isArray(result.models) ? result.models : [];
    const count = applyFetchedModels(ids);
    setAiStatus(count ? "Fetched " + count + " models. Pick one or type an id." : "No models returned. Type a model id.", false);
  } catch (error) {
    if (aiRequestCurrent(operation, view, input, context)) setAiStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function testAiConnection() {
  const operation = ++aiOperation;
  const view = aiViewRevision;
  const input = aiSettingsDraft();
  const context = chatgptSettings?.context?.();
  // Test what the form shows, including unsaved edits. A blank key still falls
  // back to the saved key on the host, matching Save and Fetch models.
  setAiStatus(aiDirty() ? "Testing the unsaved values in this form…" : "Contacting the model…", false);
  try {
    const result = await api.invoke("host:aiTest", input);
    if (!aiRequestCurrent(operation, view, input, context)) {
      if (operation === aiOperation && view === aiViewRevision) setAiStatus("Settings changed. Test the current settings again.", false);
      return;
    }
    if (result && result.ok) setAiStatus("Connected. " + (result.preview || ""), false);
    else setAiStatus((result && result.message) || "Connection failed.", true);
  } catch (error) {
    if (aiRequestCurrent(operation, view, input, context)) setAiStatus(error instanceof Error ? error.message : String(error), true);
    else if (operation === aiOperation && view === aiViewRevision) setAiStatus("Settings changed. Test the current settings again.", false);
  }
}

const prefSaveTimers = new Map();

function settingsInlineStatus(node, text, isError) {
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  if (node.classList) {
    if (isError) node.classList.add("error");
    else node.classList.remove("error");
  }
}

// Auto-saved preferences report beside their own control, not only in the
// dialog footer, so a failure is visible next to the value that did not save.
function prefSaveStatusNode(id) {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return null;
  const statusId = "pref-save-status-" + id;
  const existing = document.getElementById(statusId);
  if (existing) return existing;
  const control = document.getElementById(id);
  if (!control || !control.parentNode) return null;
  const anchor = (control.closest && (control.closest(".field") || control.closest(".check"))) || control;
  if (!anchor || !anchor.parentNode) return null;
  const node = document.createElement("p");
  node.id = statusId;
  node.className = "hint settings-inline-status";
  node.setAttribute("role", "status");
  node.hidden = true;
  anchor.parentNode.insertBefore(node, anchor.nextSibling);
  const describedBy = control.getAttribute ? control.getAttribute("aria-describedby") : "";
  if (control.setAttribute) {
    control.setAttribute("aria-describedby", (describedBy ? describedBy + " " : "") + statusId);
  }
  return node;
}

function setPrefSaveStatus(id, text, isError) {
  const timer = prefSaveTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    prefSaveTimers.delete(id);
  }
  const node = prefSaveStatusNode(id);
  if (!node) return;
  settingsInlineStatus(node, text, isError);
  if (!text || isError) return;
  prefSaveTimers.set(id, setTimeout(() => {
    prefSaveTimers.delete(id);
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    const live = document.getElementById("pref-save-status-" + id);
    if (live) settingsInlineStatus(live, "", false);
  }, 1800));
}

const prefWriteSerial = new Map();
async function savePref(row) {
  const [id, getChannel, setChannel, kind] = row;
  const control = $(id);
  const submitted = readPref(kind, control);
  const serial = (prefWriteSerial.get(id) || 0) + 1;
  prefWriteSerial.set(id, serial);
  const status = $("settings-status");
  try {
    await api.invoke(setChannel, submitted);
    const saved = await api.invoke(getChannel);
    if (serial !== prefWriteSerial.get(id)) return;
    const edited = readPref(kind, control) !== submitted;
    if (!edited) applyPref(kind, control, saved);
    status.textContent = "";
    status.classList.remove("error");
    if (takePref(getChannel, kind, { checked: saved === true, value: String(saved) })) paintPrefs();
    if (id === "pref-sync-horizon") {
      status.textContent = "Sync history saved. It takes effect on the next sync; downloaded mail stays.";
      setPrefSaveStatus(id, "Saved. It takes effect on the next sync." + (edited ? " Newer edits are not saved yet." : ""), false);
      await loadList();
    } else {
      setPrefSaveStatus(id, edited ? "Saved. Newer edits are not saved yet." : "Saved.", false);
    }
  } catch (error) {
    if (serial !== prefWriteSerial.get(id)) return;
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = message;
    status.classList.add("error");
    setPrefSaveStatus(id, message, true);
    try {
      const saved = await api.invoke(getChannel);
      if (serial === prefWriteSerial.get(id) && readPref(kind, control) === submitted) applyPref(kind, control, saved);
    } catch { /* status already shows the failure */ }
  }
  if (id === "pref-theme" || id === "pref-accent") {
    syncAccentPicker($("pref-accent").value);
    applyShellTheme(document.documentElement, $("pref-theme").value, $("pref-accent").value);
  }
}

function settingsFolds() {
  return document.querySelectorAll("#settings .settings-folds .fold");
}

function applySettingsFold(fold, open, animate) {
  const panel = fold.querySelector(".fold-panel");
  fold.classList.toggle("is-open", open);
  fold.hidden = !open;
  const motion = motionApi();
  const live = !!(animate && !$("settings").dataset.motion && motion && typeof motion.fold === "function" && !(typeof motion.reduced === "function" && motion.reduced()));
  if (panel && live) motion.fold(panel, open);
  else if (panel) {
    if (motion && typeof motion.reset === "function") motion.reset(panel);
    panel.hidden = !open;
  }
  if (fold.dataset.fold === "bot") syncBotSectionPanels(open);
}

function syncBotSectionPanels(open) {
  const nav = $("bot-sections");
  if (!nav) return;
  if (!open) {
    for (const tab of nav.querySelectorAll('[role="tab"]')) {
      tab.tabIndex = -1;
      const panel = $(tab.getAttribute("aria-controls"));
      if (panel) panel.hidden = true;
    }
    return;
  }
  const selected = nav.querySelector('[role="tab"][aria-selected="true"]');
  showBotSection((selected && selected.dataset.botSection) || "grants");
}

function setSettingsFold(name, open, animate) {
  // Tab state stays in the DOM for this renderer session, including reopen.
  if (![...settingsFolds()].some(fold => fold.dataset.fold === name)) return;
  for (const fold of settingsFolds()) {
    const next = fold.getAttribute("data-fold") === name;
    if (fold.classList.contains("is-open") === next) continue;
    applySettingsFold(fold, next, animate !== false);
  }
  const nav = $("settings-nav");
  if (!nav) return;
  for (const button of nav.querySelectorAll("[data-fold]")) {
    const selected = button.getAttribute("data-fold") === name;
    button.setAttribute("aria-current", String(selected));
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  document.querySelector("#settings .settings-account-context").hidden = !["mailbox", "ooo"].includes(name);
  $("settings").querySelector(".dialog-body").scrollTop = 0;
  loadSettingsFold(name);
}

function revealSettingsFold(name) {
  setSettingsFold(name, true, false);
  $("settings-tab-" + name)?.focus({ preventScroll: true });
}

function wireSettingsFolds() {
  const nav = $("settings-nav");
  if (!nav || nav.dataset.wired === "1") return;
  nav.dataset.wired = "1";
  nav.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest("button[data-fold]");
    if (!button || !nav.contains(button)) return;
    const name = button.getAttribute("data-fold");
    setSettingsFold(name, true, true);
  });
  nav.addEventListener("keydown", event => {
    const tabs = [...nav.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setSettingsFold(tabs[next].dataset.fold, true, true);
    tabs[next].focus({ preventScroll: true });
  });
}

function wireSectionNav(id) {
  const nav = $(id);
  if (!nav || nav.dataset.wired === "1") return;
  nav.dataset.wired = "1";
  nav.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest("button[data-scroll]");
    if (!button || !nav.contains(button) || button.disabled) return;
    const target = $(button.getAttribute("data-scroll"));
    if (!target || target.hidden) return;
    target.scrollIntoView({ block: "nearest" });
    for (const item of nav.querySelectorAll("button[data-scroll]")) {
      item.setAttribute("aria-current", item === button ? "true" : "false");
    }
  });
}

let agentTab = "home";
function showAgentTab(name) {
  if (!["home", "conversation", "tools"].includes(name)) return;
  const changed = agentTab !== name;
  agentTab = name;
  const panel = $("agent-panel");
  panel.dataset.agentPane = name;
  for (const tab of $("agent-nav").querySelectorAll("[data-agent-tab]")) {
    const active = tab.dataset.agentTab === name;
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("aria-current", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !active;
  }
  $("agent-skill-chips").hidden = name !== "home";
  // Switching sections should never scroll two competing containers.
  if (!changed) return;
  if (name === "conversation") {
    const thread = $("agent-sections");
    thread.scrollTop = thread.scrollHeight;
  } else panel.scrollTop = 0;
}

function wireAgentTabs() {
  const nav = $("agent-nav");
  nav.addEventListener("click", event => {
    const tab = event.target.closest("[data-agent-tab]");
    if (tab) showAgentTab(tab.dataset.agentTab);
  });
  nav.addEventListener("keydown", event => {
    const tabs = [...nav.querySelectorAll("[data-agent-tab]")];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    showAgentTab(tabs[next].dataset.agentTab);
    tabs[next].focus({ preventScroll: true });
  });
}

function openSettings() {
  if ($("settings").open) return;
  if (!state.settingsAccountId) state.settingsAccountId = state.accountId;
  openDialog("settings");
  settingsFoldLoaded.clear();
  afterPaint(() => {
    if (!$("settings").open) return;
    paintSettingsMailbox();
    const fold = document.querySelector("#settings .fold.is-open");
    if (fold) loadSettingsFold(fold.dataset.fold);
  });
}

const mailVacation = new Map();
const mailVacationPending = new Set();
let oooRetryAccount = null;
function vacationChipSummary(entry) {
  if (entry && entry.retrying) return "Out of Office: Retrying…";
  if (entry && entry.error) return "Out of Office: unknown — refresh to retry";
  return "";
}
function decideOooRefresh(input) {
  const api = window.morrowSyncRetry;
  if (api && api.decideVacationRefresh) return api.decideVacationRefresh(input);
  if (input && input.pending) return "wait";
  if (input && input.force) return "fetch";
  const previous = input && input.previous;
  const now = input && input.now || Date.now();
  if (previous && !previous.retrying && previous.at && now - previous.at < 60000) return "cache";
  return "fetch";
}
const oooRetry = (window.morrowSyncRetry
  ? window.morrowSyncRetry.createRetryScheduler({
    delays: window.morrowSyncRetry.OOO_RETRY_DELAYS_MS,
    onRetry(accountId) {
      if (!selectedAccount() || selectedAccount().id !== accountId) {
        oooRetry.clear(accountId);
        if (mailVacation.get(accountId) && mailVacation.get(accountId).retrying) mailVacation.delete(accountId);
        return;
      }
      refreshMailVacation(false);
    },
  })
  : {
    noteFailure() { return { retry: false, exhausted: true }; },
    noteSuccess() {},
    clear() {},
    status() { return null; },
  });
function vacationSummary(data, now = Date.now()) {
  if (!data) return "Out of Office: unknown";
  if (data.requiresReconnect) return "Out of Office: permission needed to check";
  if (!data.supported) return "Out of Office: unavailable here — manage on your server";
  if (data.scheduleWarning) return "Out of Office: status needs review — " + data.scheduleWarning;
  const settings = data.settings;
  if (!settings) return "Out of Office: unknown";
  if (settings.mode === "disabled") return "Out of Office: off";
  if (settings.mode === "always") return "Out of Office: on until disabled";
  if (settings.mode !== "scheduled") return "Out of Office: unknown";
  const day = 86400000;
  let start = Date.parse(settings.start), end = Date.parse(settings.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Out of Office: scheduled — dates unavailable; manage to review";
  if (data.provider === "imap") { start = Math.floor(start / day) * day; end = Math.ceil(end / day) * day; }
  const format = time => Number.isFinite(time) ? (data.provider === "imap" ? new Date(time).toISOString().slice(0, 10) + " 00:00 UTC" : shownWhen(new Date(time), true)) : "unknown";
  const phase = Number.isFinite(end) && now >= end ? "ended" : Number.isFinite(start) && now < start ? "scheduled" : "scheduled / active within these dates";
  return "Out of Office: " + phase + " · " + format(start) + " → " + format(end);
}
function rememberVacation(data) {
  mailVacation.set(data.accountId, { data, at: Date.now() });
  paintMailVacation();
}
function paintMailVacation() {
  const box = $("mail-ooo");
  if (!box) return;
  if (state.allInbox) {
    box.hidden = true;
    return;
  }
  const account = selectedAccount();
  box.hidden = !account;
  if (!account) return;
  const entry = mailVacation.get(account.id);
  const compact = !entry?.error && entry?.data?.supported && !entry.data.requiresReconnect && !entry.data.scheduleWarning && entry.data.settings?.mode === "disabled";
  const summary = vacationChipSummary(entry) || vacationSummary(entry?.data);
  const detail = account.email + " · " + summary + (entry?.at ? " · Checked " + shownWhen(new Date(entry.at)) : "");
  box.classList.toggle("is-off", !!compact);
  box.title = detail;
  $("mail-ooo-status").textContent = compact ? "Out of Office: off" : detail;
  $("mail-ooo-status").setAttribute("aria-label", detail);
  $("mail-ooo-status").setAttribute("aria-busy", entry?.retrying ? "true" : "false");
  $("mail-ooo-manage").textContent = compact ? "Manage" : "Manage / disable";
  $("mail-ooo-refresh").hidden = !!compact;
}
function releaseVacationRetry(accountId) {
  if (!accountId) return;
  oooRetry.clear(accountId);
  const entry = mailVacation.get(accountId);
  if (entry && entry.retrying) mailVacation.delete(accountId);
}
async function refreshMailVacation(force = false) {
  const account = selectedAccount();
  if (oooRetryAccount && (!account || oooRetryAccount !== account.id)) releaseVacationRetry(oooRetryAccount);
  oooRetryAccount = account ? account.id : null;
  paintMailVacation();
  if (!account || mailVacationPending.has(account.id)) return;
  const id = account.id;
  if (force) oooRetry.clear(id);
  const previous = mailVacation.get(id);
  const decision = decideOooRefresh({
    force: !!force,
    pending: false,
    status: oooRetry.status(id),
    previous,
    now: Date.now(),
  });
  if (decision !== "fetch") return;
  mailVacationPending.add(id);
  try {
    const data = await call("mail:vacationGet", { accountId: id });
    if (selectedAccount()?.id !== id) return;
    if (!data || data.accountId !== id) throw new Error("Mailbox did not match");
    oooRetry.noteSuccess(id);
    rememberVacation(data);
  } catch (error) {
    if (selectedAccount()?.id !== id) return;
    const plan = oooRetry.noteFailure(id, "", { stickyAuth: false });
    if (plan.retry) mailVacation.set(id, { error: true, retrying: true, at: previous && previous.at });
    else mailVacation.set(id, { error: true, at: Date.now() });
    paintMailVacation();
  } finally { mailVacationPending.delete(id); }
}
async function manageMailVacation() {
  const id = state.accountId;
  if (!id) return;
  openSettings();
  if (settingsAccount()?.id !== id && !(await changeSettingsMailbox(id))) return;
  revealSettingsFold("ooo");
  $("ooo-refresh").focus();
}

let settingsVacationGen = 0;
let settingsCapabilityGen = 0;
let oooBaseline = "";
function settingsAccount() {
  return state.accounts.find(account => account.id === (state.settingsAccountId || state.accountId)) || null;
}
function oooSnapshot() {
  return JSON.stringify(["ooo-mode", "ooo-start", "ooo-end", "ooo-subject", "ooo-message", "ooo-external", "ooo-audience", "ooo-domain"].map(id => {
    const el = $(id); return el ? (el.type === "checkbox" ? el.checked : el.value) : "";
  }));
}
function oooDirty() { return !!oooBaseline && oooSnapshot() !== oooBaseline; }
function paintOooDirty() {
  const note = $("ooo-dirty");
  if (!note) return;
  const dirty = oooDirty();
  note.hidden = !dirty;
  note.textContent = dirty ? "Unsaved changes. Review and save to the provider." : "";
  if (dirty && $("ooo-status") && $("ooo-status").textContent === "Saved on the provider.") setOooStatus("", false);
}
let googleOauthClientBusy = false;
function paintGoogleOauthClient() {
  const node = $("google-oauth-client-status");
  if (!node) return;
  node.classList.remove("error");
  node.textContent = googleOauthClientCopy(state.googleOauthClient);
  paintGoogleOauthClientButtons();
}
function paintGoogleOauthClientButtons() {
  const busy = googleOauthClientBusy || state.oauthPending;
  const clear = $("google-oauth-clear");
  if (clear) clear.disabled = busy || !(state.googleOauthClient && state.googleOauthClient.imported);
  const button = $("google-oauth-import");
  if (button) button.disabled = busy;
  for (const id of ["settings-gmail-migrate", "settings-gmail-calendar"]) {
    const action = $(id);
    if (action) action.disabled = busy || gmailMigrationBusy;
  }
}
async function loadGoogleOauthClient() {
  const node = $("google-oauth-client-status");
  try {
    state.googleOauthClient = await call("mail:googleOauthStatus");
    paintGoogleOauthClient();
  } catch (error) {
    if (!node) throw error;
    node.textContent = error instanceof Error ? error.message : String(error);
    node.classList.add("error");
  }
}
async function changeGoogleOauthClient(channel) {
  if (googleOauthClientBusy || state.oauthPending) return;
  const node = $("google-oauth-client-status");
  googleOauthClientBusy = true;
  paintGoogleOauthClient();
  paintConnectPending();
  if (node) {
    node.classList.remove("error");
    if (channel === "mail:importGoogleOauth") node.textContent = "Choose a Desktop client JSON…";
  }
  try {
    const result = await call(channel);
    state.googleOauthClient = result || state.googleOauthClient;
    paintGoogleOauthClient();
    await loadOauthStatus();
    await loadSettingsCapabilities();
  } catch (error) {
    if (node) {
      node.textContent = error instanceof Error ? error.message : String(error);
      node.classList.add("error");
    }
  } finally {
    googleOauthClientBusy = false;
    paintGoogleOauthClientButtons();
    paintConnectPending();
  }
}
function paintSettingsMailbox() {
  const select = $("settings-account");
  if (!select) return;
  if (state.settingsAccountId && !state.accounts.some(a => a.id === state.settingsAccountId)) state.settingsAccountId = null;
  const account = settingsAccount();
  fillAccountOptions(select, state.accounts, account?.id);
  $("settings-reconnect").disabled = !account;
  $("settings-reconnect").textContent = "Reconnect mailbox";
  $("settings-reconnect").title = account ? "Reconnect " + account.email : "Connect a mailbox first";
  if ($("settings-gmail-migrate")) {
    const google = (account?.imapSmtpProfile || account?.profile) === "gmail";
    $("settings-gmail-migrate").hidden = !google || account?.authKind !== "oauth2";
    $("settings-gmail-migrate").textContent = account?.mailTransport === "gmail_api" ? "Reauthorize Gmail API mail" : "Migrate Gmail to Gmail API";
    $("settings-gmail-calendar").hidden = !google;
    $("settings-gmail-migrate").disabled = gmailMigrationBusy || googleOauthClientBusy || state.oauthPending;
    $("settings-gmail-calendar").disabled = gmailMigrationBusy || googleOauthClientBusy || state.oauthPending;
  }
  $("settings-mailbox-note").textContent = account ? "Signatures, rules, and automatic replies use this mailbox." : "Connect an account in Accounts to get started.";
  syncRemove();
}
async function changeSettingsMailbox(id) {
  const previous = settingsAccount()?.id;
  if (state.busy) { $("settings-account").value = previous || ""; return false; }
  if (id === previous) return true;
  if (oooDirty()) {
    const answer = await askConfirm({ title: "Change Settings mailbox?", body: "Discard unsaved Out of Office edits for " + settingsAccount().email + "? Saved provider settings are unchanged.", confirm: "Discard edits", cancel: "Keep editing" });
    if (!answer?.ok) { $("settings-account").value = previous || ""; return false; }
  }
  state.settingsAccountId = id;
  ++settingsVacationGen;
  oooBaseline = "";
  paintVacation(null);
  paintOooDirty();
  paintSettingsMailbox();
  for (const key of settingsFoldLoaded) if (key.startsWith("mailbox:") || key.startsWith("ooo:")) settingsFoldLoaded.delete(key);
  for (const key of settingsFoldPending.keys()) if (key.startsWith("mailbox:") || key.startsWith("ooo:")) settingsFoldPending.delete(key);
  const fold = document.querySelector("#settings .fold.is-open");
  if (fold) await loadSettingsFold(fold.dataset.fold);
  return true;
}
async function loadSettingsCapabilities() {
  const gen = ++settingsCapabilityGen;
  const account = settingsAccount();
  const node = $("settings-capabilities");
  node.textContent = account ? "Checking feature permissions…" : "No mailbox selected.";
  if (!account) return;
  try {
    const status = await call("mail:oauthStatus");
    if (gen !== settingsCapabilityGen || settingsAccount()?.id !== account.id) return;
    const grants = status?.accounts?.find(row => row.id === account.id);
    const local = account.authKind !== "oauth2";
    const permission = key => grants ? (grants[key] ? "Permission granted" : "Additional consent needed") : "Unknown — refresh permissions";
    node.textContent = ["Mail: " + (account.needsReauth || grants?.mailClientMatches === false ? "Reconnect needed" : "Configured; connection health is shown in Sync"), "Signatures: saved on this computer", "Labels/folders: " + (local ? "IMAP folders" : permission("organize")), "Rules: " + (local ? "Local; runs on new downloads while open" : permission("rules")), "Calendar: " + (local ? "Requires Google or Microsoft browser sign-in" : permission("calendar")), "Out of Office: " + (local ? "Check support in the Out of Office tab" : permission("vacation"))].join("\n");
    if (grants?.provider === "google") node.textContent += "\nMail transport: " + (grants.mailTransport === "gmail_api" ? "Gmail API (polling)" : "Legacy IMAP/SMTP — review migration")
      + "\nRequested mail scopes: " + (grants.requestedScopes?.mail || "Unknown legacy request")
      + "\nGranted mail scopes: " + (grants.grantedScopes?.imap || "Unknown")
      + "\nRequested Calendar scopes: " + (grants.requestedScopes?.calendar || "Not separately requested")
      + "\nGranted Calendar scopes: " + (grants.grantedScopes?.calendar || "None")
      + "\n" + (grants.broadGoogleGrant ? "A saved broad mail.google.com grant remains. A narrower request has not removed it. To remove it, deliberately revoke Morrow access in Google Account connections, reauthorize Gmail API mail, then separately reauthorize Calendar. Cached mail and local work stay; server access pauses until reauthorization." : "No broad mail.google.com scope is recorded in the saved grants. Google controls actual app access.");
  } catch (error) { if (gen === settingsCapabilityGen) node.textContent = "Permissions unknown. Refresh permissions to retry. " + error.message; }
}
let gmailMigrationBusy = false;
let gmailMigrationOperation = 0;
async function reauthorizeGmail(calendar = false) {
  if (gmailMigrationBusy || googleOauthClientBusy || state.oauthPending || state.connectPending) return;
  const account = settingsAccount();
  if (!account || (account.imapSmtpProfile || account.profile) !== "gmail") return;
  const answer = await askConfirm({ title: calendar ? "Reauthorize Google Calendar" : "Migrate or reauthorize Gmail API mail",
    body: calendar
      ? "Continue with Google OAuth for calendar list and event access only, for " + account.email + ". Mail access stays separate. This replaces the saved Calendar credential only after successful consent. A saved broad grant may remain until you deliberately revoke Morrow access in Google Account connections and reauthorize both features."
      : "Continue with Google OAuth for " + account.email + ". Gmail API replaces Gmail IMAP/SMTP for this account. The request is gmail.modify and gmail.settings.basic: mail, drafts, send, labels, Trash, rules and Out of Office; Calendar is separate. Account id, cached mail and local drafts stay. Pending or uncertain mail actions must be resolved first. Unuploaded draft edits stay local for another Save; an older server copy may remain. Cancel or declined/insufficient mail permission preserves the current connection. Older broad Google grants are not revoked by a narrower request; review the actual granted scopes afterward.",
    confirm: "Continue with Google", cancel: "Keep current connection" });
  if (!answer?.ok || settingsAccount()?.id !== account.id || gmailMigrationBusy || googleOauthClientBusy || state.oauthPending) return;
  const operation = ++gmailMigrationOperation;
  gmailMigrationBusy = true; state.oauthPending = true;
  paintSettingsMailbox(); paintConnectPending();
  $("settings-gmail-cancel").hidden = false;
  $("settings-capabilities").textContent = "Waiting for Google OAuth approval…";
  try {
    const result = await call(calendar ? "calendar:connect" : "mail:migrateGmail", { accountId: account.id, confirmed: true, ...(calendar ? { forceReauthorize: true } : {}) });
    if (operation !== gmailMigrationOperation) return;
    showStatus(calendar ? "Google Calendar authorization updated. Review granted scopes in Accounts." : `Gmail API connection updated. ${result?.grantWarning || "Review granted scopes in Accounts."}`);
    await loadAccounts();
    await loadSettingsCapabilities();
  } catch (error) {
    if (operation === gmailMigrationOperation) $("settings-capabilities").textContent = error.message || "Google reauthorization did not finish. Review the current connection.";
  } finally {
    if (operation === gmailMigrationOperation) {
      gmailMigrationBusy = false; state.oauthPending = false;
      $("settings-gmail-cancel").hidden = true;
      paintSettingsMailbox(); paintConnectPending();
    }
  }
}
async function cancelGmailReauthorization() {
  if (!gmailMigrationBusy) return;
  const operation = gmailMigrationOperation;
  $("settings-gmail-cancel").disabled = true;
  try {
    await call("mail:cancelOAuth");
    if (operation === gmailMigrationOperation) {
      gmailMigrationOperation++;
      gmailMigrationBusy = false; state.oauthPending = false;
      $("settings-gmail-cancel").hidden = true;
      $("settings-capabilities").textContent = "Google reauthorization cancelled. Refresh permissions to review the current connection.";
    }
  } catch (error) {
    if (operation === gmailMigrationOperation) $("settings-capabilities").textContent = "Cancellation could not be confirmed. Authorization may still finish; retry Cancel before starting another authorization. " + error.message;
  } finally {
    $("settings-gmail-cancel").disabled = false;
    paintSettingsMailbox(); paintConnectPending();
  }
}
function openConnectFor(account) {
  if (state.oauthPending || state.connectPending) return;
  clearConnectMigration();
  const gmailOAuth = account?.authKind === "oauth2" && (account.imapSmtpProfile || account.profile) === "gmail";
  $("connect-imap").open = !!account && !gmailOAuth;
  state.reconnectAccountId = account?.id || null;
  $("connect-title").textContent = account ? "Reconnect " + account.email : "Connect account";
  $("connect-recovery-note").textContent = account ? "Sign in as " + account.email + ". Cached mail, drafts, rules, signatures, and queued work remain. Password reconnects update the login type and servers only after saving credentials; a failure attempts to restore the prior credentials. Removing this account invalidates a pending reconnect. Start a new connection after removal to add it again. Google mail uses Gmail API scopes with separate Calendar consent; migrate a legacy Google OAuth mailbox from Settings → Accounts. Microsoft asks for mail, then its feature bundle." : "";
  $("email").value = account?.email || "";
  $("email").readOnly = !!account;
  $("username").value = account?.imapUsername || "";
  $("password").value = "";
  cancelDiscovery();
  customEndpointEdits.clear();
  discoveredProfile = "";
  discoveryEmail = String(account?.email || "").trim().toLowerCase();
  clearDiscoveredEndpoints();
  if (account && account.imapSmtpProfile === "custom") {
    customEndpointEdits.add("imap");
    customEndpointEdits.add("smtp");
  }
  if (account) {
    $("profile").value = account.imapSmtpProfile || "custom";
    const custom = account.imapSmtpCustom;
    if (custom) for (const kind of ["imap", "smtp"]) {
      $(kind + "-host").value = custom[kind].host;
      $(kind + "-port").value = custom[kind].port;
      $(kind + "-tls").checked = custom[kind].tls;
    }
    syncCustomFields();
  } else {
    $("profile").value = "custom";
    syncCustomFields();
  }
  setConnectStatus("");
  paintConnectPending();
  openDialog("connect");
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
  const left = parts.join(", ") || "All new Inbox mail";
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
let inboxRulesAccountId = "";
let inboxRulesGen = 0;
let inboxRuleBaseline = "";

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
  return displayStamp(date, "dateTime", { medium: true }) || text;
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
  inboxRuleBaseline = JSON.stringify(inboxRuleFieldsFromForm());
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
  const picker = $("inbox-rules-account");
  picker.replaceChildren();
  for (const account of state.accounts) picker.appendChild(option(account.id, accountLabel(account)));
  picker.value = inboxRulesAccountId;
  picker.disabled = inboxRulesBusy;
  const owner = state.accounts.find((row) => row.id === inboxRulesAccountId);
  $("inbox-rules-owner").textContent = owner ? accountLabel(owner) + " · " + (data.backend === "imap"
    ? "Local rules apply to newly downloaded Inbox mail while Morrow is open."
    : data.backend ? "Rules run on the " + (data.backend === "gmail" ? "Gmail" : "Microsoft") + " server." : "Loading rules…") : "Connect a mailbox to manage its rules.";
  const note = $("inbox-rules-note");
  if (note && data.message) note.textContent = data.message;
  const dirty = inboxRuleBaseline && JSON.stringify(inboxRuleFieldsFromForm()) !== inboxRuleBaseline;
  if (!dirty) {
    fillInboxRuleSelect("inbox-rule-move", data.destinations, "Pick a folder, or leave mail where it is");
    fillInboxRuleSelect("inbox-rule-label", data.destinations, "Pick a label, or add none");
  }
  const root = $("inbox-rules-list");
  root.replaceChildren();
  const rows = Array.isArray(data.rules) ? data.rules : [];
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = data.api ? "No inbox automation rules yet." : "";
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
  inboxRuleBaseline = JSON.stringify(inboxRuleFieldsFromForm());
}

function inboxRuleAccount() {
  return state.accounts.find((row) => row.id === inboxRulesAccountId && row.id === inboxRulesState.accountId) || null;
}

function setInboxRulesBusy(value) {
  inboxRulesBusy = value;
  $("inbox-rules-account").disabled = value;
  for (const node of $("inbox-rule-form").querySelectorAll("input, select, button")) node.disabled = value;
}

async function changeInboxRulesAccount(id) {
  if (inboxRulesBusy || id === inboxRulesAccountId) return;
  if (inboxRuleBaseline && JSON.stringify(inboxRuleFieldsFromForm()) !== inboxRuleBaseline) {
    const answer = await askConfirm({ title: "Change rules mailbox?", body: "Discard unsaved rule edits before switching mailboxes?", confirm: "Discard edits", cancel: "Keep editing" });
    if (!answer || !answer.ok) { $("inbox-rules-account").value = inboxRulesAccountId; return; }
  }
  inboxRulesAccountId = id;
  clearInboxRuleForm();
  await loadInboxRules();
}

async function loadInboxRules() {
  const gen = ++inboxRulesGen;
  if (!inboxRulesAccountId) inboxRulesAccountId = state.accountId || "";
  const account = state.accounts.find((row) => row.id === inboxRulesAccountId);
  const previous = inboxRulesState.accountId === (account && account.id) ? inboxRulesState : {};
  inboxRulesState = { backend: "", rules: [], destinations: [], ...previous, accountId: account && account.id, api: false,
    message: account ? "Loading rules…" : "Connect an account to add an inbox automation rule." };
  paintInboxRules();
  if (!account) return;
  const data = await call("mail:listInboxRules", { accountId: account.id });
  if (gen !== inboxRulesGen || account.id !== inboxRulesAccountId) return;
  if (!data || data.accountId !== account.id) throw new Error("Rules did not match the selected mailbox. Reload before editing.");
  inboxRulesState = data;
  paintInboxRules();
  if (!inboxRuleBaseline) inboxRuleBaseline = JSON.stringify(inboxRuleFieldsFromForm());
}

async function submitInboxRule(event) {
  event.preventDefault();
  if (inboxRulesBusy) return;
  const account = inboxRuleAccount();
  if (!account || !inboxRulesState.api) { showInboxRuleStatus("Load rules for a connected mailbox before saving.", true); return; }
  const backend = inboxRulesState.backend;
  const draft = readInboxRuleForm(inboxRuleFieldsFromForm(), backend);
  if (inboxRuleEditId) draft.id = inboxRuleEditId;
  setInboxRulesBusy(true);
  try {
    const actions = draft.actions || {};
    if (actions.trash || actions.archive || actions.moveToId || !Object.values(draft.match || {}).some((value) => value !== "" && value != null)) {
      const answer = await askConfirm({ title: "Save rule for " + accountLabel(account) + "?", body: inboxRuleSummary(draft)
        + (actions.moveToId ? " Destination: " + ((inboxRulesState.destinations || []).find((row) => row.id === actions.moveToId)?.name || "selected folder") + "." : "")
        + (backend === "imap" ? " This local rule applies only to newly downloaded Inbox mail while Morrow is open." : " This rule runs on your mail provider."), confirm: "Save rule", cancel: "Cancel" });
      if (!answer || !answer.ok) return;
    }
    if (inboxRuleAccount()?.id !== account.id || inboxRulesState.backend !== backend) throw new Error("The rules mailbox changed. Review the rule again.");
    showInboxRuleStatus("Saving…", false);
    await call("mail:saveInboxRule", { accountId: account.id, rule: draft });
    if (inboxRulesAccountId !== account.id) return;
    clearInboxRuleForm();
    await loadInboxRules();
    showInboxRuleStatus(backend === "imap" ? "Local rule saved for " + accountLabel(account) + ". It applies to newly downloaded Inbox mail while Morrow is open."
      : "Rule saved on " + (backend === "gmail" ? "Gmail" : "Microsoft") + " for " + accountLabel(account) + ".", false);
  } catch (error) { showInboxRuleStatus(error.message || String(error), true); }
  finally { setInboxRulesBusy(false); }
}

async function deleteInboxRule(id) {
  const account = inboxRuleAccount();
  const rule = (inboxRulesState.rules || []).find((row) => row.id === id);
  if (!account || !rule || inboxRulesBusy) return;
  if (!window.confirm("Delete “" + (rule.name || inboxRuleSummary(rule)) + "” for " + accountLabel(account) + "?")) return;
  setInboxRulesBusy(true);
  try {
    await call("mail:deleteInboxRule", { accountId: account.id, ruleId: id });
    if (inboxRuleEditId === id) clearInboxRuleForm();
    await loadInboxRules();
    showInboxRuleStatus("Rule deleted for " + accountLabel(account) + ".", false);
  } finally { setInboxRulesBusy(false); }
}

async function grantInboxRules() {
  const account = inboxRuleAccount();
  if (!account || inboxRulesBusy) throw new Error("Choose a connected rules mailbox.");
  setInboxRulesBusy(true);
  try {
    showInboxRuleStatus("Waiting for the browser for " + accountLabel(account) + "…", false);
    const saved = await call("mail:grantRules", { accountId: account.id });
    const outcome = grantApiOutcome(saved, "Granted for " + accountLabel(account) + ".", "Inbox rules need a provider grant.");
    if (!outcome.ok) throw new Error(outcome.message);
    await loadInboxRules();
    showInboxRuleStatus(outcome.message, false);
  } finally { setInboxRulesBusy(false); }
}

async function openInboxRules() {
  const id = settingsAccount()?.id || "";
  try {
    if (id !== inboxRulesAccountId) await changeInboxRulesAccount(id);
  } catch (error) {
    $("settings-status").textContent = "Could not load rules for " + (settingsAccount()?.email || "this mailbox") + ". " + (error.message || String(error));
    $("settings-status").classList.add("error");
    $("settings-status").scrollIntoView({ block: "nearest" });
    return;
  }
  if (id !== inboxRulesAccountId) return;
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
    if (panel) {
      const wasHidden = panel.hidden;
      panel.hidden = !on;
      if (on && wasHidden) {
        const motion = motionApi();
        if (motion && motion.fadePane) motion.fadePane(panel, "y");
      }
    }
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

function brainIdentityHint() {
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Refresh learns names from your mail. Mailbox addresses show up here after that distill.";
  return hint;
}

function brainIdentityActions(value, itemId) {
  const name = String(value || "").slice(0, 80);
  const actions = document.createElement("div");
  actions.className = "row brain-actions";
  const fix = document.createElement("button");
  fix.type = "button";
  fix.className = "ghost";
  fix.textContent = "Fix";
  fix.setAttribute("aria-label", "Fix " + name);
  fix.disabled = brainFixBusy;
  fix.addEventListener("click", () => {
    fixBrainItem({ id: itemId, value: name });
  });
  const forget = document.createElement("button");
  forget.type = "button";
  forget.className = "ghost";
  forget.textContent = "Forget";
  forget.setAttribute("aria-label", "Forget " + name);
  forget.disabled = brainFixBusy;
  forget.addEventListener("click", () => {
    forgetBrainItem({ id: itemId, value: name });
  });
  actions.append(fix, forget);
  return actions;
}

function paintBrainIdentity(snapshot) {
  const list = $("brain-identity-list");
  if (!list) return;
  list.replaceChildren();
  const persona = snapshot && snapshot.persona;
  const profile = persona && persona.profile;
  const identity = profile && profile.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    list.appendChild(brainIdentityHint());
    return;
  }
  const groups = [
    ["Emails", "emails"],
    ["Names", "displayNames"],
    ["Nicknames", "nicknames"],
    ["Organizations", "orgs"],
  ];
  for (const [title, key] of groups) {
    const rows = Array.isArray(identity[key]) ? identity[key] : [];
    const visible = rows.filter((row) => {
      if (!row) return false;
      if (key === "emails") return String(row.address || "").trim() !== "";
      return String(row.value || "").trim() !== "";
    });
    if (!visible.length) continue;
    const block = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = title;
    block.appendChild(heading);
    for (const row of visible) {
      const line = document.createElement("div");
      line.className = "brain-row";
      const text = document.createElement("p");
      if (key === "emails") {
        text.textContent = String(row.address || "").trim() + " — account";
        line.appendChild(text);
      } else {
        const value = String(row.value || "").trim();
        text.textContent = value + " — auto";
        line.appendChild(text);
        line.appendChild(brainIdentityActions(value, row.id));
      }
      block.appendChild(line);
    }
    list.appendChild(block);
  }
}

function paintBrain(snapshot, view) {
  const message = brainMessage(view);
  const status = $("brain-status");
  status.textContent = message.text;
  status.classList.toggle("error", message.error);
  paintBrainProgress(view);
  paintBrainMeta(snapshot);
  paintBrainIdentity(snapshot);
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
  paintMotionRows("brain", root.querySelectorAll(".brain-row"));
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
  $("brain-category-save").disabled = locked || brainCategorySaving;
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
  updateCategoriesBaseline = JSON.stringify(brainCategories);
  brainCategoryDefaults = parsed.defaults;
  brainCategoriesReady = true;
  if (brainIsOpen()) paintCategories();
}

async function saveBrainCategories() {
  if (!brainCategoriesReady || brainCategorySaving) return;
  const gen = brainCategoryGen;
  const submitted = JSON.stringify(brainCategories);
  const formState = () => JSON.stringify([brainCategoryIndex, $("brain-category-name").value,
    $("brain-category-description").value, $("brain-category-collapse").checked]);
  const submittedForm = formState();
  const wasEmpty = brainCategories.length === 0;
  brainCategorySaving = true;
  paintCategories();
  try {
    await call("emailBrain:saveCategories", { categories: JSON.parse(submitted) });
    const parsed = readCategoryPayload(await call("emailBrain:getCategories"));
    if (gen !== brainCategoryGen) return;
    const unchanged = JSON.stringify(brainCategories) === submitted && formState() === submittedForm;
    if (unchanged) brainCategories = parsed.categories;
    updateCategoriesBaseline = JSON.stringify(parsed.categories);
    brainCategoryDefaults = parsed.defaults;
    if (unchanged) resetCategoryForm();
    showCategoryStatus(!unchanged ? "Submitted list saved. Newer edits are not saved."
      : wasEmpty ? "Saved. An empty list uses the defaults." : "Saved.", false);
    paintCategories();
    const home = await call("nativeAgent:home:refreshTaxonomy");
    if (state.view === "agent") {
      paintAgent(home, "");
      await loadAgent();
    }
  } finally {
    brainCategorySaving = false;
    if (gen === brainCategoryGen) paintCategories();
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
  if (skillResult) paintSkillBlocks(skillResult, null);
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
  const date = new Date(time);
  if (typeof displayStamp === "function") return displayStamp(date, "dateTime", { compact: true });
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function agentMessageContext(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const messageId = String(item.messageId || "").trim();
  if (!messageId) return null;
  return {
    messageId: messageId,
    accountId: String(item.accountId || "").trim(),
  };
}

function agentReadIntent(item) {
  if (!agentMessageContext(item)) return "skip";
  if (item.unread === false) return "already";
  return "mark";
}

function explicitAgentTodo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messageId = String(value.messageId || "").trim();
  if (!messageId) return null;
  return { messageId, accountId: String(value.accountId || "").trim() };
}

function freshReplyTodoSeed(fields) {
  if (!fields || fields.draftId || fields.botDraft || fields.partialReceipt) return null;
  if (fields.kind !== "reply" && fields.kind !== "all") return null;
  const messageId = String(fields.sourceMessageId || "").trim();
  if (!messageId) return null;
  return { messageId, accountId: String(fields.accountId || "").trim() };
}

function freshReplyLearningSource(fields) {
  const source = freshReplyTodoSeed(fields);
  if (!source) return null;
  const quoted = fields.quoteEmail;
  if (quoted && quoted.id === source.messageId && (!quoted.accountId || quoted.accountId === source.accountId)) {
    if (quoted.from) source.from = String(quoted.from);
  }
  if (fields.threadId) source.threadId = String(fields.threadId);
  return source;
}

function withAgentReplyTodo(payload) {
  if (!payload) return payload;
  const todo = explicitAgentTodo(state.agentReplyTodo);
  const next = { ...payload };
  if (todo) next.agentTodo = todo;
  const kind = state.composeIdentity && state.composeIdentity.kind;
  const action = kind === "all" ? "reply-all" : kind === "reply" ? "reply" : "";
  const source = state.agentReplySource;
  if (!action || !source) return next;
  const item = { ...source };
  next.agentLearning = { kind: "action", action, begunAt: Date.now(), items: [item] };
  return next;
}

async function finishAgentReplyTodo(session) {
  if (session !== state.composeSession) return;
  const todo = explicitAgentTodo(state.agentReplyTodo);
  state.agentReplyTodo = null;
  state.agentReplySource = null;
  if (!todo) return;
  try {
    const data = await call("nativeAgent:home:todoUpdate", {
      messageId: todo.messageId,
      accountId: todo.accountId,
      status: "done",
    });
    if (state.view === "agent" && data) paintAgent(data, "");
  } catch { /* confirmed send stands; the todo can still be marked done */ }
}

function agentPileRole(section) {
  const source = section && typeof section === "object" ? section : {};
  const id = String(source.id || source.categoryId || "").trim();
  const name = String(source.name || source.title || "").trim();
  if (id === "needs-you" || /^needs you$/i.test(name)) return "reply";
  if (id === "fyi" || /^fyi$/i.test(name)) return "fyi";
  if (id === "other" || /^other$/i.test(name)) return "other";
  return "";
}

function agentMoveTargets(role) {
  if (role === "reply") return [["fyi", "FYI"], ["other", "Other"]];
  if (role === "fyi") return [["needs-you", "Needs You"], ["other", "Other"]];
  if (role === "other") return [["needs-you", "Needs You"], ["fyi", "FYI"]];
  return [];
}

function suggestionClass(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function suggestionSuppressed(label) {
  const name = suggestionClass(label);
  if (!name) return false;
  const learning = state.agentLearning;
  const list = learning && Array.isArray(learning.suppressed) ? learning.suppressed : [];
  return list.includes(name);
}

function agentAddress(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function agentLearnedNotes(item) {
  const learning = state.agentLearning;
  const patterns = learning && Array.isArray(learning.patterns) ? learning.patterns : [];
  const email = agentAddress(item && item.from);
  const thread = String(item && item.threadId || "").trim();
  const role = agentPileRole(item);
  const pile = role === "reply" ? "needs-you" : role === "fyi" || role === "other" ? role : "";
  const notes = [];
  const seen = new Set();
  for (const row of patterns) {
    if (!row || row.learned !== true || !row.match) continue;
    let text = "";
    if (row.kind === "category" && pile && row.match.fromCategoryId === pile && email && Array.isArray(row.senders) && row.senders.includes(email)) {
      text = "Learned: move to " + (row.match.toName || "the other category");
    } else if (row.kind === "action" && row.match.scope === "sender" && email && row.match.key === email) {
      text = "Learned: " + (row.actionLabel || "this action");
    } else if (row.kind === "action" && row.match.scope === "thread" && thread && row.match.key === thread) {
      text = "Learned: " + (row.actionLabel || "this action");
    }
    if (text && !seen.has(text)) {
      seen.add(text);
      notes.push(text);
    }
  }
  return notes;
}

function agentLearnedLine(item) {
  const notes = agentLearnedNotes(item);
  if (!notes.length) return null;
  const line = document.createElement("p");
  line.className = "agent-learned";
  line.textContent = notes.join(" · ");
  return line;
}

function learningApplyStamp(view) {
  const patterns = view && Array.isArray(view.patterns) ? view.patterns : [];
  const suppressed = view && Array.isArray(view.suppressed) ? view.suppressed : [];
  return JSON.stringify([suppressed, patterns.filter((row) => row && row.learned).map((row) => [row.id, row.senders || null, row.match || null])]);
}

function applyAgentLearning(view) {
  const next = view && typeof view === "object" ? view : null;
  const changed = learningApplyStamp(state.agentLearning) !== learningApplyStamp(next);
  state.agentLearning = next;
  if (changed && state.view === "agent" && agentPaintPayload) {
    agentPaintPayload.learning = next;
    paintAgentHome(agentPaintPayload);
  }
  if (changed) {
    for (const [root, surface] of agentSuggestionSurfaces) {
      if (!root.isConnected) agentSuggestionSurfaces.delete(root);
      else if (surface.kind === "run") paintStoredRun(surface.data);
      else if (surface.kind === "skill") paintSkillBlocks(root, surface.data);
      else paintProposals(root, surface.data);
    }
    paintThread();
  }
  const settings = $("settings");
  if (settings && settings.open && $("agent-learned-list")) renderAgentLearned(next);
}

function learnAgent(body) {
  const payload = Object.assign({ begunAt: Date.now() }, body || {});
  return call("nativeAgent:learning:observe", payload).then((view) => {
    applyAgentLearning(view);
  }).catch(() => {});
}

function learningSignalItem(item) {
  const context = agentMessageContext(item);
  if (!context) return null;
  const signal = { messageId: context.messageId, accountId: context.accountId };
  if (item && item.from) signal.from = String(item.from);
  if (item && item.threadId) signal.threadId = String(item.threadId);
  return signal;
}

async function moveAgentCategory(item, toCategoryId, toName, fromName) {
  const context = agentMessageContext(item);
  if (!context) return;
  const data = await call("nativeAgent:learning:moveCategory", {
    messageId: context.messageId,
    accountId: context.accountId,
    toCategoryId,
    toName,
    fromName,
    begunAt: Date.now(),
  });
  if (data && data.learning) applyAgentLearning(data.learning);
  if (state.view === "agent" && data) paintAgent(data, "");
}

function renderAgentLearned(view) {
  const list = $("agent-learned-list");
  if (!list) return;
  list.replaceChildren();
  const patterns = view && Array.isArray(view.patterns) ? view.patterns : [];
  if (!patterns.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing learned yet. Category moves, repeated actions, and suggestion choices show up here.";
    list.appendChild(empty);
    return;
  }
  const threshold = view && view.threshold || 3;
  for (const row of patterns) {
    if (!row || !row.id) continue;
    const item = document.createElement("li");
    item.className = "settings-account";
    const name = document.createElement("span");
    name.className = "name";
    const count = Number(row.count) || 0;
    name.textContent = (row.label || "Pattern") + " — " + (row.learned ? "Learned" : count + " of " + threshold);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete " + (row.label || "pattern"));
    del.addEventListener("click", () => {
      call("nativeAgent:learning:forget", { id: row.id }).then((next) => {
        applyAgentLearning(next);
        renderAgentLearned(next);
      }).catch((error) => {
        showStatus(error instanceof Error ? error.message : String(error), true);
      });
    });
    item.append(name, del);
    list.appendChild(item);
  }
}

async function paintAgentLearned() {
  const list = $("agent-learned-list");
  if (!list) return;
  try {
    const view = await call("nativeAgent:learning:list");
    if (view) state.agentLearning = view;
    renderAgentLearned(view);
  } catch (error) {
    list.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = error instanceof Error ? error.message : "Learned patterns could not be loaded.";
    list.appendChild(empty);
  }
}

function agentSelectionLabels(selectedCount, listedCount) {
  const selected = Number(selectedCount) || 0;
  const listed = Number(listedCount) || 0;
  const all = listed > 0 && selected === listed;
  return {
    read: all ? "Mark all as read" : "Mark selected as read",
    done: all ? "Complete all" : "Complete selected",
  };
}

function agentUnreadSnapshot(items) {
  const rows = [];
  const seen = new Set();
  for (const item of items || []) {
    if (agentReadIntent(item) !== "mark") continue;
    const context = agentMessageContext(item);
    if (!context || seen.has(context.messageId) || agentMarkedRead.has(context.messageId) || agentPendingReads.has(context.messageId)) continue;
    seen.add(context.messageId);
    rows.push({ messageId: context.messageId, accountId: context.accountId });
  }
  return rows;
}

function readUndoRows(snapshot, data) {
  const accounts = new Map();
  for (const row of snapshot || []) {
    const context = agentMessageContext(row);
    if (context) accounts.set(context.messageId, context.accountId || "");
  }
  const rows = [];
  const seen = new Set();
  const take = (entry, requireCompleted) => {
    if (!entry || !entry.id || seen.has(entry.id)) return;
    if (requireCompleted && entry.status !== "completed") return;
    if (typeof entry.generation !== "number" || !Number.isFinite(entry.generation)) return;
    if (!accounts.has(entry.id)) return;
    seen.add(entry.id);
    rows.push({ emailId: entry.id, accountId: accounts.get(entry.id), generation: entry.generation });
  };
  const packet = data && typeof data === "object" ? data : {};
  for (const row of packet.outcomes || []) take(row, true);
  for (const row of packet.pending || []) take(row, false);
  return rows;
}

function agentTodoActionNames(item, section) {
  if (!agentMessageContext(item)) return [];
  const names = ["Open", "Reply", "Reply All", "Mark as read"];
  if (agentPileRole(section || item) === "reply") names.push("Mark read & done");
  names.push("Mark todo done", "Dismiss");
  for (const target of agentMoveTargets(agentPileRole(section || item))) names.push("Move to " + target[1]);
  return names;
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
  let text = "On demand. Auto-run is off.";
  const paused = row && (row.schedule === "paused" || row.paused === true);
  if (paused) text = "Paused. No scheduled runs; Run still works on demand.";
  else if (row && row.schedule !== "disabled" && (row.schedule === "interval" || row.kind === "interval") && Number(row.everyMinutes) > 0) text = "Scheduled · Every " + Number(row.everyMinutes) + " min.";
  else if (row && row.schedule !== "disabled" && (row.schedule === "cron" || row.kind === "cron") && row.cron) text = "Scheduled · Cron " + String(row.cron) + ".";
  if (text.startsWith("Scheduled")) {
    const next = row.nextRunAt && new Date(row.nextRunAt);
    text += next && Number.isFinite(+next)
      ? " Next run: " + (typeof displayStamp === "function"
        ? displayStamp(next, "dateTime", { withZone: true })
        : next.toLocaleString() + " (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")") + "."
      : " Next run not available.";
    text += " Runs while Morrow is open; a missed run fires once on relaunch. Drafts need review and Send; filing needs confirmation.";
  }
  if (row && row.lastError) text += " Last run: " + String(row.lastError);
  return text;
}

function skillStatusChip(row, mode) {
  if (mode === "install") return { label: "Not installed", tone: "library" };
  if (row && (row.schedule === "paused" || row.paused === true)) return { label: "Paused", tone: "paused" };
  const minutes = Number(row && row.everyMinutes);
  const scheduled = !!(row && row.schedule && row.schedule !== "disabled");
  if (scheduled && (row.schedule === "interval" || row.kind === "interval") && Number.isInteger(minutes) && minutes > 0) {
    return { label: "Every " + minutes + " min", tone: "scheduled" };
  }
  if (scheduled && (row.schedule === "cron" || row.kind === "cron") && row.cron) return { label: "Cron", tone: "scheduled" };
  return { label: "On demand", tone: "demand" };
}

function customSkillDraft(input) {
  const source = input && typeof input === "object" ? input : {};
  const name = String(source.name || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  const description = String(source.description || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  const instruction = String(source.instruction || "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!name) return { error: "A skill needs a name." };
  if (name.length > 80) return { error: "Use a name of 80 characters or fewer." };
  if (description.length > 240) return { error: "Use a description of 240 characters or fewer." };
  if (!instruction) return { error: "A skill needs an instruction." };
  if (instruction.length > 4000) return { error: "Use an instruction of 4000 characters or fewer." };
  const draft = {
    name: name,
    description: description,
    instruction: instruction,
    calendar: source.calendar === true,
    person: source.person === true,
    moves: source.moves === true,
  };
  const skillId = String(source.skillId || "").trim();
  if (skillId) draft.skillId = skillId;
  return draft;
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
  if (skillIdOf(row) === "brief-this-person" || (row && row.person === true)) {
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
  for (const id of ["brain-skill-status", "agent-skill-status", "brain-skill-dialog-status"]) {
    const status = $(id);
    if (!status) continue;
    status.textContent = text || "";
    status.classList.toggle("error", !!isError && !!text);
  }
}

function proposalContext(proposal, kind) {
  const account = state.accounts.find(row => row.id === proposal.accountId);
  const who = account?.email || proposal.accountId || "Unknown — verified when opening source";
  const source = proposal.subject || proposal.messageId || "Missing source";
  const filing = folderProvider(account) === "gmail" ? "Add Gmail label when granted, otherwise move to IMAP folder" : "Move message to folder";
  const action = kind === "draft" ? "Review reply draft" : filing;
  const target = kind === "draft" ? "Recipients: verified from source when reviewed" : "Destination: " + (proposal.labelName || "Unknown");
  return "Account: " + who + "\nSource: " + source + (proposal.messageId ? " · " + proposal.messageId : "") + "\nAction: " + action + "\n" + target + "\nState: " + (proposal.status || "Pending review") + (kind === "draft" ? " · Opening does not send or schedule." : " · Requires provider confirmation.");
}
async function describeDraftSource(node, draft) {
  if (!draft.messageId) { node.textContent += "\nSource missing — request a new draft from a message."; return; }
  try {
    const data = await call("mail:openEmail", { emailId: draft.messageId, full: true });
    const source = data?.email;
    if (!source || (draft.accountId && source.accountId !== draft.accountId)) throw new Error("Source unavailable or mailbox mismatch");
    const account = state.accounts.find(row => row.id === source.accountId);
    if (!account) throw new Error("Mailbox unavailable");
    const seed = composeSeed(source, "reply", account.email);
    node.textContent = proposalContext({ ...draft, accountId: source.accountId, subject: source.subject }, "draft").replace("Recipients: verified from source when reviewed", "To: " + seed.to + (seed.cc ? " · Cc: " + seed.cc : ""));
  } catch { node.textContent += "\nSource unavailable — review is blocked until it can be verified."; }
}
async function refreshAiSetupState() {
  let configured = null;
  try {
    const result = await api.invoke("host:aiGetConfig");
    const config = result?.data || result;
    if (config?.authMode === "chatgpt") {
      const reply = await api.invoke("host:chatgptStatus");
      const connection = reply?.data || reply;
      configured = connection?.connected === true && connection?.planEnabled === true;
    } else configured = config?.hasKey === true;
  } catch { /* unknown stays actionable */ }
  for (const space of ["agent", "brain"]) {
    const box = $(space + "-setup");
    if (!box) continue;
    box.hidden = configured === true && state.accounts.length > 0;
    $(space + "-setup-copy").textContent = !state.accounts.length ? "Connect a mailbox to use mail context. Cached profile and preferences remain available." : configured === false ? "Set up AI to ask questions and run skills. Cached content and local editing remain available." : "AI setup status is unknown. Open AI settings to check configuration.";
    $(space + "-setup-ai").hidden = configured === true;
    $(space + "-setup-connect").hidden = state.accounts.length > 0;
  }
}
function openAiSetup() {
  openSettings();
  revealSettingsFold("ai");
  $("ai-base").focus();
}

function followButton(follow, draft) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  const label = suggestionClass((follow && follow.label) || (draft ? "Review draft" : "Open"));
  button.textContent = label || (draft ? "Review draft" : "Open");
  button.addEventListener("click", () => {
    const source = draft || follow || {};
    const body = String(source.body || source.text || "").trim();
    const draftFollow = !draft && source.kind === "draft";
    const run = draft || (source.kind === "draft" && body)
      ? reviewDraft(source)
      : draftFollow
        ? openReplyCompose(source.messageId || "")
        : peekMessage(source.messageId || "");
    const begunAt = Date.now();
    Promise.resolve(run).then(() => {
      learnAgent({ kind: "suggestion", choice: "open", className: button.textContent, begunAt });
    }).catch((error) => {
      showStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  return button;
}

const agentSuggestionSurfaces = new Map();

function paintSkillBlocks(root, data) {
  if (!root) return;
  if (root.isConnected) agentSuggestionSurfaces.set(root, { kind: "skill", data });
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
    line.textContent = proposalContext(draft, "draft");
    line.className = "preserve-lines";
    describeDraftSource(line, draft);
    wrap.appendChild(line);
    const row = document.createElement("div");
    row.className = "row";
    if (!suggestionSuppressed("Review draft")) row.appendChild(followButton(null, draft));
    wrap.appendChild(row);
    root.appendChild(wrap);
  }
  const follows = Array.isArray(data.followUps) ? data.followUps : [];
  if (follows.length) {
    const row = document.createElement("div");
    row.className = "row";
    for (const follow of follows) {
      const label = suggestionClass(follow && follow.label) || "Open";
      if (suggestionSuppressed(label)) continue;
      row.appendChild(followButton(follow));
    }
    root.appendChild(row);
  }
  paintProposals(root, data.proposals, true);
}

function paintProposals(root, proposals, append) {
  if (!root) return;
  if (!append && root.isConnected) agentSuggestionSurfaces.set(root, { kind: "proposal", data: proposals });
  if (!append) root.replaceChildren();
  const rows = Array.isArray(proposals) ? proposals.filter((item) => item && item.status !== "dismissed" && item.status !== "confirmed" && !suggestionSuppressed(item.labelName || "Filing")) : [];
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
    line.textContent = proposalContext(proposal, "filing");
    line.className = "preserve-lines";
    wrap.appendChild(line);
    const actions = document.createElement("div");
    actions.className = "row";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = "Review filing…";
    const waiting = proposal.filing?.status === "pending";
    const uncertain = proposal.filing?.status === "unknown";
    confirm.disabled = waiting || uncertain;
    if (proposal.filing) {
      const receipt = document.createElement("p");
      receipt.className = "hint";
      receipt.setAttribute("role", "status");
      receipt.textContent = waiting ? "Waiting for mailbox confirmation. This proposal stays visible until completion." : uncertain ? "Filing is uncertain. Open the message in Mail and check its folder before any retry. Morrow will not retry automatically." : proposal.filing.error || "Filing was not completed. Review before retrying.";
      wrap.appendChild(receipt);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ghost";
      open.textContent = "Open in Mail";
      open.addEventListener("click", () => guard(async () => { showMail(); await openMessage(proposal.messageId, true); }));
      actions.appendChild(open);
    }
    confirm.addEventListener("click", () => {
      const begunAt = Date.now();
      confirmProposal(proposal).then((data) => {
        if (!data) return;
        if (data.accepted !== false) {
          learnAgent({ kind: "suggestion", choice: "open", className: proposal.labelName || "Filing", begunAt });
        }
        if (data.accepted !== false) wrap.remove();
        if (brainIsOpen()) setSkillStatus(data.pending ? data.error || "Waiting for mailbox confirmation." : data.detail || "Move confirmed.", false);
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
      const begunAt = Date.now();
      dismissProposal(proposal).then(() => {
        learnAgent({ kind: "suggestion", choice: "dismiss", className: proposal.labelName || "Filing", begunAt });
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

const AGENT_ICON = {
  open: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M22 6l-10 7L2 6"],
  done: ["M20 6 9 17l-5-5"],
  dismiss: ["M18 6 6 18", "M6 6l12 12"],
  draft: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  attachment: ["M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"],
};

const agentMarkedRead = new Set();
const agentPendingReads = new Map();

function iconShapes(spec) {
  if (!spec) return [];
  return Array.isArray(spec) ? spec : [spec];
}

function agentIconSpec(action) {
  if (action === "reply") return ROW_ICON.Reply;
  if (action === "reply-all") return ROW_ICON["Reply All"];
  if (action === "read") return ROW_ICON["Mark read"];
  if (action === "read-done") return AGENT_ICON.done;
  return AGENT_ICON[action] || "";
}

function agentLooksUnread(item) {
  if (!item || item.unread !== true) return false;
  const id = String(item.messageId || "");
  return !id || !agentMarkedRead.has(id);
}

function agentActionButton(action, label, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-action";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  const spec = agentIconSpec(action);
  if (spec) button.appendChild(strokeIcon(iconShapes(spec), 16));
  const text = document.createElement("span");
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const pinTodos = action === "read" && agentTab === "home";
    const panel = pinTodos ? $("agent-panel") : null;
    const page = pinTodos ? document.scrollingElement : null;
    const panelTop = panel ? panel.scrollTop : 0;
    const pageTop = page ? page.scrollTop : 0;
    const keepTodos = () => {
      if (!pinTodos || state.view !== "agent" || agentTab !== "home") return;
      if (panel) panel.scrollTop = panelTop;
      if (page) page.scrollTop = pageTop;
    };
    button.disabled = true;
    keepTodos();
    Promise.resolve().then(run).catch((error) => {
      showStatus(error instanceof Error ? error.message : String(error), true);
    }).finally(() => {
      button.disabled = false;
      keepTodos();
      if (pinTodos) afterPaint(keepTodos);
    });
  });
  return button;
}

function styleFollowButton(follow) {
  const button = followButton(follow);
  button.classList.remove("ghost");
  button.classList.add("agent-action");
  const kind = follow && follow.kind === "draft" ? "draft" : follow && follow.kind === "flag-attachment" ? "attachment" : "open";
  const spec = kind === "open" ? AGENT_ICON.open : AGENT_ICON[kind];
  if (spec) button.prepend(strokeIcon(iconShapes(spec), 16));
  return button;
}

function agentCard(item, options) {
  const card = document.createElement("article");
  card.className = "agent-item";
  if (agentLooksUnread(item)) card.classList.add("unread");
  const messageId = item && item.messageId ? String(item.messageId) : "";
  if (messageId) card.dataset.messageId = messageId;
  const main = document.createElement("div");
  main.className = "agent-item-main";
  const name = senderName(item && item.from);
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = senderInitial(name);
  avatar.style.backgroundColor = avatarColor(name);
  const copy = document.createElement("div");
  copy.className = "agent-item-copy";
  const line = document.createElement("div");
  line.className = "agent-item-line";
  const sender = document.createElement("div");
  sender.className = "agent-sender";
  if (agentLooksUnread(item)) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    dot.setAttribute("aria-hidden", "true");
    sender.appendChild(dot);
  }
  const from = document.createElement("p");
  from.className = "agent-from";
  from.textContent = name;
  if (item && item.from) from.title = String(item.from);
  sender.appendChild(from);
  line.appendChild(sender);
  const when = agentWhen(item && item.date);
  if (when) {
    const time = document.createElement("time");
    time.className = "agent-when";
    if (item && item.date) time.dateTime = String(item.date);
    time.textContent = when;
    line.appendChild(time);
  }
  copy.appendChild(line);
  const subject = document.createElement("p");
  subject.className = "agent-subject";
  subject.textContent = (item && item.subject) || "(no subject)";
  copy.appendChild(subject);
  const summary = String((item && item.summary) || "").trim();
  if (summary) {
    const summaryLine = document.createElement("p");
    summaryLine.className = "agent-summary";
    summaryLine.textContent = summary;
    copy.appendChild(summaryLine);
  }
  if (item && item.hasAttachments) {
    const attach = document.createElement("p");
    attach.className = "agent-attach";
    attach.appendChild(strokeIcon(iconShapes(AGENT_ICON.attachment), 14));
    const attachText = document.createElement("span");
    attachText.textContent = "Has an attachment.";
    attach.appendChild(attachText);
    copy.appendChild(attach);
  }
  main.append(avatar, copy);
  card.appendChild(main);
  if (!(options && options.actions === false)) {
    const follows = agentFollowUps(item).filter((follow) => !suggestionSuppressed(follow.label || (follow.kind === "draft" ? "Review draft" : "Open")));
    if (follows.length) {
      const actions = document.createElement("div");
      actions.className = "agent-actions";
      const group = document.createElement("div");
      group.className = "agent-action-group";
      for (const follow of follows) group.appendChild(styleFollowButton(follow));
      actions.appendChild(group);
      card.appendChild(actions);
    }
  }
  return card;
}

function paintStoredRun(run) {
  const view = historyRunView(run);
  const root = $("agent-result");
  if (!root || !view) return;
  if (root.isConnected) agentSuggestionSurfaces.set(root, { kind: "run", data: run });
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

function skillScheduleSnapshot(box) {
  return JSON.stringify([...box.querySelectorAll("select, input")].map((field) => field.value));
}

function keepSkillSchedule(row) {
  const editor = row?.querySelector(".skill-schedule");
  return !!(editor && (editor.contains(document.activeElement) || skillScheduleSnapshot(editor) !== editor.dataset.baseline));
}

function appendSkillSchedule(parent, row) {
  const skillId = skillIdOf(row);
  if (!parent || !skillId) return;
  const name = skillName(row) || skillId;
  const box = document.createElement("div");
  box.className = "skill-schedule";
  box.dataset.skillId = skillId;
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
  const wantsPerson = skillId === "brief-this-person" || (row && row.person === true);
  const syncFields = () => {
    minutes.hidden = kind.value !== "interval";
    cron.hidden = kind.value !== "cron";
    contact.hidden = !wantsPerson || kind.value === "off";
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
  box.dataset.baseline = skillScheduleSnapshot(box);
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
  const editors = [...document.querySelectorAll(".skill-schedule")].filter((box) => box.dataset.skillId === skillId);
  const snapshots = new Map(editors.map((box) => [box, skillScheduleSnapshot(box)]));
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
    if (skillId === "brief-this-person" || (row && row.person === true)) payload.contactEmail = draft.contactEmail;
    await call("emailBrain:setSkillSchedule", payload);
    setSkillStatus("Saved the schedule for " + name + ".", false);
  }
  for (const [box, snapshot] of snapshots) box.dataset.baseline = snapshot;
  await Promise.all([loadBrainSkills(), loadStudio()]);
  refreshBrainSkillDialog(true);
}

async function pauseSkillSchedule(row, paused) {
  const skillId = skillIdOf(row);
  if (!skillId) throw new Error("That skill has no id.");
  await call("emailBrain:setSkillSchedule", { skillId, paused: paused === true });
  const name = skillName(row) || skillId;
  setSkillStatus((paused ? "Paused " : "Resumed ") + name + ".", false);
  await Promise.all([loadBrainSkills(), loadStudio()]);
  refreshBrainSkillDialog(true);
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
  const previous = new Map([...root.children].filter((row) => row.dataset.skillId).map((row) => [row.dataset.skillId, row]));
  const rendered = [];
  if (!rows.length) {
    root.replaceChildren();
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
    const retained = previous.get(skillId);
    if (retained && keepSkillSchedule(retained)) {
      rendered.push(retained);
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "studio-row";
    if (skillId) wrap.dataset.skillId = skillId;
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
    if (row && row.custom === true) {
      const kind = document.createElement("p");
      kind.className = "hint";
      kind.textContent = "Custom skill. Saved on this computer.";
      copy.appendChild(kind);
    }
    const modeLine = document.createElement("p");
    modeLine.className = "hint";
    modeLine.textContent = runModeLabel(row);
    if (modeLine.textContent) copy.appendChild(modeLine);
    wrap.appendChild(copy);
    if (!skillId) {
      rendered.push(wrap);
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
      if (row && row.custom === true) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "ghost";
        edit.textContent = "Edit";
        edit.setAttribute("aria-label", "Edit " + name);
        edit.addEventListener("click", () => openBrainSkillDialog(row, "run"));
        actions.appendChild(edit);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      const custom = row && row.custom === true;
      remove.textContent = custom ? "Delete" : "Remove";
      remove.setAttribute("aria-label", (custom ? "Delete " : "Remove ") + name);
      remove.addEventListener("click", () => {
        removeBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.appendChild(remove);
    }
    wrap.appendChild(actions);
    if (mode === "run") appendSkillSchedule(wrap, row);
    rendered.push(wrap);
  }
  const wanted = new Set(rendered);
  for (const child of [...root.children]) if (!wanted.has(child)) child.remove();
  rendered.forEach((child, index) => {
    if (root.children[index] !== child) root.insertBefore(child, root.children[index] || null);
  });
}

function skillActionButton(className, action, busy) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.skillAction = action;
  if (busy) button.disabled = true;
  return button;
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
    const title = document.createElement("h3");
    title.className = "brain-skill";
    const name = row && typeof row === "object" ? String(row.name || row.title || "").trim() : "";
    title.textContent = name || skillLine(row) || "Skill";
    card.appendChild(title);
    const description = row && typeof row === "object" ? String(row.description || "").trim() : "";
    if (description) {
      const detail = document.createElement("p");
      detail.className = "hint brain-skill-detail";
      detail.textContent = description;
      card.appendChild(detail);
    }
    if (row && row.custom === true) {
      const customChip = document.createElement("span");
      customChip.className = "brain-skill-chip is-custom";
      customChip.textContent = "Custom";
      card.appendChild(customChip);
    }
    const chipInfo = skillStatusChip(row, mode);
    const chip = document.createElement("span");
    chip.className = "brain-skill-chip" + (chipInfo.tone ? " is-" + chipInfo.tone : "");
    chip.textContent = chipInfo.label;
    card.appendChild(chip);
    if (!skillId) {
      root.appendChild(card);
      continue;
    }
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      openBrainSkillDialog(row, mode);
    });
    const actions = document.createElement("div");
    actions.className = "row brain-skill-actions";
    if (mode === "install") {
      const install = skillActionButton("primary", "install", false);
      install.textContent = "Install";
      install.setAttribute("aria-label", "Install " + title.textContent);
      install.addEventListener("click", () => {
        installBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.appendChild(install);
    } else {
      const run = skillActionButton("primary", "run", brainSkillBusy);
      run.textContent = "Run";
      run.setAttribute("aria-label", "Run " + title.textContent);
      run.addEventListener("click", () => {
        runBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.appendChild(run);
    }
    const manage = skillActionButton("ghost", "manage", false);
    manage.textContent = "Manage";
    manage.setAttribute("aria-label", "Manage " + title.textContent);
    manage.addEventListener("click", () => openBrainSkillDialog(row, mode));
    actions.appendChild(manage);
    card.appendChild(actions);
    root.appendChild(card);
  }
}

function findBrainSkill(skillId) {
  const lists = brainSkillCache || {};
  for (const [id] of brainSkillLists()) {
    const row = skillRows(lists[id]).find((item) => skillIdOf(item) === skillId);
    if (row) return { row, mode: id === "brain-library-skills" ? "install" : "run" };
  }
  return null;
}

function setCustomSkillEditor(visible) {
  const form = $("custom-skill-form");
  if (form) form.hidden = !visible;
}

function fillCustomSkillForm(row) {
  const skill = row && typeof row === "object" ? row : {};
  const name = $("custom-skill-name");
  const description = $("custom-skill-description");
  const instruction = $("custom-skill-instruction");
  const calendar = $("custom-skill-calendar");
  const person = $("custom-skill-person");
  const moves = $("custom-skill-moves");
  if (name) name.value = row ? String(skill.name || "") : "";
  if (description) description.value = row ? String(skill.description || "") : "";
  if (instruction) instruction.value = row ? String(skill.instruction || "") : "";
  if (calendar) calendar.checked = skill.calendar === true;
  if (person) person.checked = skill.person === true;
  if (moves) moves.checked = skill.moves === true;
  const save = $("custom-skill-save");
  if (save) save.textContent = row ? "Save changes" : "Save skill";
}

function customSkillEditorFocused() {
  const active = document.activeElement;
  return !!(active && active.closest && active.closest("#custom-skill-form"));
}

function paintBrainSkillDialog(row, mode) {
  const skillId = skillIdOf(row);
  const custom = !!(row && row.custom === true);
  const name = (row && typeof row === "object" ? String(row.name || row.title || "").trim() : "") || skillLine(row) || "Skill";
  const title = $("brain-skill-dialog-title");
  if (title) title.textContent = name;
  const detail = $("brain-skill-dialog-detail");
  const description = row && typeof row === "object" ? String(row.description || "").trim() : "";
  if (detail) {
    detail.textContent = custom
      ? "Custom skill. Stored on this computer and kept across app updates. Nothing is sent."
      : description;
    detail.hidden = custom ? false : !description;
  }
  const modeLine = $("brain-skill-dialog-mode");
  if (modeLine) modeLine.textContent = mode === "install" ? "This skill is in the library until you install it." : runModeLabel(row);
  setCustomSkillEditor(custom);
  if (custom) fillCustomSkillForm(row);
  const scheduleTitle = $("brain-skill-dialog-schedule-title");
  if (scheduleTitle) scheduleTitle.hidden = mode === "install";
  const actions = $("brain-skill-dialog-actions");
  if (actions) {
    actions.replaceChildren();
    if (mode === "install") {
      const install = skillActionButton("primary", "install", false);
      install.textContent = "Install";
      install.setAttribute("aria-label", "Install " + name);
      install.addEventListener("click", () => {
        installBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.appendChild(install);
    } else {
      const run = skillActionButton("primary", "run", brainSkillBusy);
      run.textContent = "Run";
      run.setAttribute("aria-label", "Run " + name);
      run.addEventListener("click", () => {
        runBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      const remove = skillActionButton("ghost", "remove", brainSkillBusy);
      remove.textContent = custom ? "Delete" : "Remove";
      remove.setAttribute("aria-label", (custom ? "Delete " : "Remove ") + name);
      remove.addEventListener("click", () => {
        removeBrainSkill(row).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.append(run, remove);
    }
  }
  const schedule = $("brain-skill-dialog-schedule");
  if (schedule) {
    schedule.replaceChildren();
    if (mode !== "install" && skillId) appendSkillSchedule(schedule, row);
  }
}

function openCustomSkillCreator() {
  customSkillCreating = true;
  brainSkillDialogId = "";
  const title = $("brain-skill-dialog-title");
  if (title) title.textContent = "New skill";
  const detail = $("brain-skill-dialog-detail");
  if (detail) {
    detail.textContent = "Saved on this computer. App updates do not replace it. It runs on your mailbox cache and does not send mail.";
    detail.hidden = false;
  }
  const modeLine = $("brain-skill-dialog-mode");
  if (modeLine) modeLine.textContent = "This skill appears on Home after you save it.";
  fillCustomSkillForm(null);
  setCustomSkillEditor(true);
  const scheduleTitle = $("brain-skill-dialog-schedule-title");
  if (scheduleTitle) scheduleTitle.hidden = true;
  const schedule = $("brain-skill-dialog-schedule");
  if (schedule) schedule.replaceChildren();
  const actions = $("brain-skill-dialog-actions");
  if (actions) actions.replaceChildren();
  const result = $("brain-skill-dialog-result");
  if (result) paintSkillBlocks(result, null);
  const status = $("brain-skill-dialog-status");
  if (status) {
    status.textContent = "";
    status.classList.remove("error");
  }
  const dialog = $("brain-skill-dialog");
  if (dialog && !dialog.open) openDialog("brain-skill-dialog");
  const name = $("custom-skill-name");
  if (name) name.focus();
}

function openBrainSkillDialog(row, mode) {
  const skillId = skillIdOf(row);
  if (!skillId) return;
  customSkillCreating = false;
  const switching = brainSkillDialogId !== skillId;
  brainSkillDialogId = skillId;
  paintBrainSkillDialog(row, mode);
  if (switching) {
    const result = $("brain-skill-dialog-result");
    if (result) paintSkillBlocks(result, null);
    const status = $("brain-skill-dialog-status");
    if (status) {
      status.textContent = "";
      status.classList.remove("error");
    }
  }
  const dialog = $("brain-skill-dialog");
  if (dialog && !dialog.open) openDialog("brain-skill-dialog");
  const primary = dialog && dialog.querySelector("[data-skill-action='run'], [data-skill-action='install']");
  if (primary) primary.focus();
}

function refreshBrainSkillDialog(force) {
  const dialog = $("brain-skill-dialog");
  if (!dialog || !dialog.open || customSkillCreating || !brainSkillDialogId) return;
  const editing = scheduleEditorFocused() || customSkillEditorFocused();
  if (!force && editing) return;
  const lists = brainSkillCache || {};
  const known = brainSkillLists().every(([id]) => Object.prototype.hasOwnProperty.call(lists, id));
  const found = findBrainSkill(brainSkillDialogId);
  if (!found) {
    if (!known) return;
    brainSkillDialogId = "";
    closeDialog("brain-skill-dialog");
    return;
  }
  const restore = dialog.contains(document.activeElement);
  paintBrainSkillDialog(found.row, found.mode);
  if (editing) {
    const select = $("brain-skill-dialog-schedule") && $("brain-skill-dialog-schedule").querySelector("select");
    if (select) select.focus();
  } else if (restore) {
    const primary = dialog.querySelector("[data-skill-action='run'], [data-skill-action='install']");
    if (primary) primary.focus();
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
  refreshBrainSkillDialog(false);
}

async function reviewDraft(draft) {
  const body = String((draft && (draft.body || draft.text)) || "").trim();
  if (!body) throw new Error("That draft is empty.");
  const messageId = draft && draft.messageId;
  if (!messageId) throw new Error("This proposal has no source message. Open the intended message and request a new draft.");
  const data = await call("mail:openEmail", { emailId: messageId, full: true });
  const email = data && data.email;
  if (!email || email.id !== messageId || !email.accountId || (draft.accountId && draft.accountId !== email.accountId)) {
    throw new Error("The proposal's source message or account is unavailable. Open the intended message and request a new draft.");
  }
  const account = state.accounts.find((item) => item.id === email.accountId);
  if (!account) throw new Error("The proposal's mailbox is no longer connected. Reconnect it before reviewing this reply.");
  const self = account.preferredFromAddress || account.email || "";
  const seed = composeSeed(email, "reply", self);
  await presentCompose(withSuggestion(seed, body));
}

function paintMailBody(pane, email, repaint, refresh) {
  pane.replaceChildren();
  const from = document.createElement("p");
  from.className = "meta";
  from.textContent = email.from || "";
  const when = document.createElement("p");
  when.className = "meta";
  const date = email.date ? new Date(email.date) : null;
  when.textContent = shownWhen(date);
  pane.append(from, when);
  for (const [label, value] of [["To", email.to], ["Cc", email.cc]]) {
    const text = people(value);
    if (!text) continue;
    const line = document.createElement("p");
    line.className = "meta";
    line.textContent = `${label} ${text}`;
    pane.appendChild(line);
  }
  renderRemoteGate(pane, email, repaint);
  renderAttachments(pane, email);
  renderBody(pane, email, refresh);
}

function paintPeek(email) {
  const title = $("agent-peek-title");
  if (title) title.textContent = (email && String(email.subject || "").trim()) || "Message";
  const pane = $("agent-peek-body");
  if (!pane || !email) return;
  paintMailBody(pane, email, () => paintPeek(email), () => peekMessage(email.id, true));
}

function invalidatePeek() {
  peekGen += 1;
  peekEmail = null;
  pendingPeekId = "";
  pendingPeekAccountId = "";
  pruneBodyNotices();
}

async function peekMessage(messageId, full) {
  if (!messageId) throw new Error("That message is not in the mailbox.");
  const gen = ++peekGen;
  pendingPeekId = String(messageId); pendingPeekAccountId = peekEmail?.id === messageId ? peekEmail.accountId : listedMessage(messageId)?.accountId || "";
  const accountId = pendingPeekAccountId;
  let data;
  try {
    data = await call("mail:openEmail", { emailId: messageId, ...(accountId ? { accountId } : {}), ...(full ? { full: true } : {}) });
  } catch (error) {
    if (gen !== peekGen) return;
    pendingPeekId = ""; pendingPeekAccountId = ""; pruneBodyNotices();
    throw error;
  }
  if (gen !== peekGen) return;
  const email = data && data.email;
  if (!email || (accountId && email.accountId !== accountId) || (email.bodyEpoch != null && !bodyIdentity(email))) {
    pendingPeekId = ""; pendingPeekAccountId = ""; pruneBodyNotices();
    throw new Error("That message is no longer available for this mailbox.");
  }
  noteBody(email);
  peekEmail = preferBody(email);
  pendingPeekId = ""; pendingPeekAccountId = "";
  paintPeek(peekEmail);
  openDialog("agent-peek");
  pumpBodyRefreshes();
}

async function openPeekInMail() {
  const id = peekEmail && peekEmail.id;
  const closing = closeDialog("agent-peek");
  if (closing) await closing;
  if (!id) return;
  showMail();
  await openMessage(id, true);
}

async function openReplyCompose(messageId) {
  if (!messageId) throw new Error("That message is not in the mailbox.");
  const data = await call("mail:openEmail", { emailId: messageId, full: true });
  const email = data && data.email;
  if (!email || !email.accountId) throw new Error("That message is no longer in the mailbox.");
  const account = state.accounts.find((item) => item.id === email.accountId);
  if (!account) throw new Error("The mailbox is no longer connected.");
  const self = account.preferredFromAddress || account.email || "";
  await presentCompose(composeSeed(email, "reply", self));
}

async function showStoredRun(run) {
  if (state.view === "agent") showAgentTab("conversation");
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
    await sendAgentText(skillName(row) || skillId, skillId);
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
    if ($("brain-skill-dialog") && $("brain-skill-dialog").open && brainSkillDialogId === skillId) {
      paintSkillBlocks($("brain-skill-dialog-result"), data);
    }
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
  refreshBrainSkillDialog(true);
}

async function saveCustomSkillFromForm(event) {
  if (event) event.preventDefault();
  const form = $("custom-skill-form");
  if (!form || form.hidden || customSkillSaving) return;
  const draft = customSkillDraft({
    skillId: customSkillCreating ? "" : brainSkillDialogId,
    name: $("custom-skill-name") ? $("custom-skill-name").value : "",
    description: $("custom-skill-description") ? $("custom-skill-description").value : "",
    instruction: $("custom-skill-instruction") ? $("custom-skill-instruction").value : "",
    calendar: !!($("custom-skill-calendar") && $("custom-skill-calendar").checked),
    person: !!($("custom-skill-person") && $("custom-skill-person").checked),
    moves: !!($("custom-skill-moves") && $("custom-skill-moves").checked),
  });
  if (draft.error) {
    setSkillStatus(draft.error, true);
    return;
  }
  customSkillSaving = true;
  try {
    const data = await call("emailBrain:saveCustomSkill", draft);
    const savedId = data && data.skill && data.skill.id ? String(data.skill.id) : "";
    customSkillCreating = false;
    if (savedId) brainSkillDialogId = savedId;
    setSkillStatus("Saved " + draft.name + ".", false);
    await Promise.all([loadBrainSkills(), loadStudio()]);
    if (savedId && data.skill) openBrainSkillDialog(data.skill, "run");
  } catch (error) {
    setSkillStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    customSkillSaving = false;
  }
}

async function removeBrainSkill(row) {
  const skillId = skillIdOf(row);
  if (!skillId) throw new Error("That skill has no id.");
  const custom = row && row.custom === true;
  const name = row.name || skillId;
  if (custom) {
    const answer = await askConfirm({
      title: "Delete custom skill",
      body: "Delete " + name + "? This removes it from this computer.",
      confirm: "Delete",
      cancel: "Cancel",
    });
    if (!answer || !answer.ok) return;
  }
  await call(custom ? "emailBrain:deleteCustomSkill" : "emailBrain:removeSkill", { skillId });
  setSkillStatus(custom ? "Deleted " + name + "." : "Removed " + name + ". It is in the library.", false);
  if (brainSkillDialogId === skillId) {
    brainSkillDialogId = "";
    closeDialog("brain-skill-dialog");
  }
  await Promise.all([loadBrainSkills(), loadStudio()]);
}

async function confirmProposal(proposal) {
  const answer = await askConfirm({ title: "Confirm provider filing", body: proposalContext(proposal, "filing") + "\nThis changes mail on your server. It is separate from marking a local todo done.", confirm: "Apply filing", cancel: "Cancel" });
  if (!answer?.ok) return null;
  const data = await call("emailBrain:confirmProposal", { proposalId: proposal && proposal.id });
  paintProposals($("agent-proposals"), data && data.proposals);
  if (data && data.accepted === false && !data.pending) throw new Error(data.error || "That move was not applied.");
  if (proposal && data?.accepted === true) proposal.status = "confirmed";
  showStatus(data?.pending ? data.error || "Waiting for mailbox confirmation." : (data && data.detail) || "Move confirmed.", false);
  if ($("agent-panel") && !$("agent-panel").hidden) await loadAgent();
  return data;
}

async function dismissProposal(proposal) {
  const data = await call("emailBrain:dismissProposal", { proposalId: proposal && proposal.id });
  if (proposal) proposal.status = "dismissed";
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
  else {
    brainSkillCache = lists;
    refreshBrainSkillDialog(false);
  }
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
  const visible = rows.filter((row) => skillName(row) && skillIdOf(row));
  if (visible.length) {
    const caption = document.createElement("span");
    caption.className = "agent-chip-label";
    caption.textContent = "Home skills";
    root.appendChild(caption);
  }
  for (const row of visible) {
    const name = skillName(row);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => {
      sendAgentText(name, skillIdOf(row)).catch((error) => setAgentSkillStatus(error instanceof Error ? error.message : String(error), true));
    });
    root.appendChild(button);
  }
}

let studioGen = 0;
async function loadStudio() {
  const gen = ++studioGen;
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
  if (gen === studioGen && panel && !panel.hidden) paintStudio(lists, errors.filter(Boolean).join(" "));
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
  const name = document.createElement("span");
  name.textContent = turn && turn.role === "user" ? "You" : "Agent";
  who.appendChild(name);
  const stamp = turn && turn.at ? formatBrainTime(turn.at) : "";
  if (stamp) {
    const time = document.createElement("time");
    time.className = "agent-when";
    time.dateTime = String(turn.at);
    time.textContent = stamp;
    who.appendChild(time);
  }
  article.appendChild(who);
  const cueName = turn && turn.kind === "skill" ? String(turn.name || "").trim() : "";
  if (cueName) {
    const cue = document.createElement("p");
    cue.className = "agent-cue";
    cue.textContent = "Running " + cueName + "…";
    article.appendChild(cue);
  }
  if (turn && turn.text) {
    const body = document.createElement("p");
    body.textContent = turn.text;
    article.appendChild(body);
  }
  const reply = turn && turn.reply;
  if (reply && reply.kind === "list" && Array.isArray(reply.cards)) {
    for (const card of reply.cards) article.appendChild(agentCard(card));
  }
  if (reply && reply.kind === "clarify" && Array.isArray(reply.choices) && reply.choices.length) {
    const actions = document.createElement("div");
    actions.className = "agent-actions row";
    for (const choice of reply.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = choice.label || "";
      button.addEventListener("click", () => sendAgentText(choice.label || ""));
      actions.appendChild(button);
    }
    article.appendChild(actions);
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

let agentThreadKey = "";
let agentThreadTurns = "";
function paintThread() {
  const root = $("agent-sections");
  if (!root) return;
  const turnsKey = JSON.stringify(agentTurns);
  const key = turnsKey + "\n" + JSON.stringify(agentProposalIds) + "\n" + learningApplyStamp(state.agentLearning);
  if (key === agentThreadKey) return;
  const followEnd = turnsKey !== agentThreadTurns;
  agentThreadKey = key;
  agentThreadTurns = turnsKey;
  root.replaceChildren();
  if (!agentTurns.length) {
    const empty = document.createElement("p");
    empty.className = "agent-empty hint";
    empty.textContent = "No Agent conversations saved on this computer. Ask a question or run a skill.";
    root.appendChild(empty);
    return;
  }
  for (const turn of agentTurns) root.appendChild(paintTurn(turn));
  if (followEnd && agentTab === "conversation") root.scrollTop = root.scrollHeight;
}

function paintAgent(payload, errorText) {
  if (payload && typeof payload === "object") agentPaintPayload = payload;
  if (payload && payload.learning) applyAgentLearning(payload.learning);
  const status = $("agent-status");
  const copy = errorText ? { text: errorText, error: true } : agentStatusCopy(payload);
  if (status) {
    const updated = payload && payload.updatedAt;
    const rawUpdated = updated ? "Updated " + updated : "";
    status.textContent = !errorText && copy.text === rawUpdated ? "Updated " + formatBrainTime(updated) : copy.text;
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
  agentDetailSeq = 0;
  syncAgentTodoViewControls();
  const greet = $("agent-greeting");
  if (greet) greet.textContent = agentGreeting();
  root.replaceChildren();
  const reason = payload && payload.reason;
  const sections = agentSections(payload);
  if (!sections.length) {
    const empty = document.createElement("p");
    empty.className = "agent-empty";
    empty.textContent = sectionEmptyCopy(reason) || "Nothing suggested yet.";
    root.appendChild(empty);
  }
  for (const section of sections) {
    const block = document.createElement("section");
    block.className = "agent-section";
    if (section.collapseView) block.classList.add("is-collapsed");
    const items = Array.isArray(section.items) ? section.items : [];
    const head = document.createElement("div");
    head.className = "agent-section-head";
    const titles = document.createElement("div");
    titles.className = "agent-section-copy";
    const title = document.createElement("h3");
    const name = document.createElement("span");
    name.textContent = section.name || section.title || "Section";
    const count = document.createElement("span");
    count.className = "agent-count";
    count.textContent = String(items.length);
    title.append(name, count);
    titles.appendChild(title);
    if (section.description) {
      const desc = document.createElement("p");
      desc.className = "hint";
      desc.textContent = section.description;
      titles.appendChild(desc);
    }
    head.appendChild(titles);
    const tools = document.createElement("div");
    tools.className = "agent-section-tools";
    const role = agentPileRole(section);
    if ((role === "fyi" || role === "other") && items.length) tools.appendChild(agentCategoryReadButton(role, items));
    if (role === "reply" && items.length) tools.appendChild(agentReplySelectionTools(block, items));
    if (section.collapseView && items.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ghost agent-section-toggle";
      toggle.textContent = "Show";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const collapsed = block.classList.toggle("is-collapsed");
        toggle.textContent = collapsed ? "Show" : "Hide";
        toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      });
      tools.appendChild(toggle);
    }
    if (tools.childNodes.length) head.appendChild(tools);
    block.appendChild(head);
    const empty = sectionEmptyCopy(reason);
    if (!items.length && empty) {
      const emptyNote = document.createElement("p");
      emptyNote.className = "agent-empty";
      emptyNote.textContent = empty;
      block.appendChild(emptyNote);
    }
    if (agentTodoView === "card") {
      const grid = document.createElement("div");
      grid.className = "agent-card-grid";
      for (const item of items) {
        if (item && typeof item === "object") grid.appendChild(agentTodoCard(item, section));
      }
      if (grid.childNodes.length) block.appendChild(grid);
    } else {
      for (const item of items) {
        if (item && typeof item === "object") block.appendChild(agentTodoCard(item, section));
      }
    }
    root.appendChild(block);
  }
  const note = document.createElement("p");
  note.id = "agent-todo-note";
  note.className = "agent-note";
  note.textContent = "Mark todo done and Dismiss only update this local Agent list. They do not archive, delete, mark read, or reply. A successful Reply or Reply All completes only the Needs You todo recorded when that reply starts. Mark as read leaves it open unless Settings → Mark as read also completes Agent todos is on. Mark read & done marks read and completes. Both wait for mailbox confirmation before completing a todo or counting a read for Learned. FYI and Other can mark the listed messages read, with Undo, and do not complete todos. Successful replies in any category can count for Learned without an open todo. Settings → Learned keeps a correction after the same pattern happens 3 times. Delete removes that one pattern and refreshes suggestions in open views.";
  root.appendChild(note);
  paintReplySelectionLabels(root);
  paintMotionRows("agent", root.querySelectorAll(".agent-section"));
}

async function replyToAgentItem(item, kind) {
  const context = agentMessageContext(item);
  if (!context) return;
  const data = await call("mail:openEmail", { emailId: context.messageId, full: true });
  const email = data && data.email;
  if (!email || !email.accountId) throw new Error("That message is no longer in the mailbox.");
  const account = state.accounts.find((row) => row.id === email.accountId);
  if (!account) throw new Error("The mailbox is no longer connected.");
  const self = account.preferredFromAddress || account.email || "";
  await presentCompose(composeSeed(email, kind === "all" ? "all" : "reply", self));
}

function agentSelectBox(item) {
  const context = agentMessageContext(item);
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "agent-select";
  if (context) box.dataset.messageId = context.messageId;
  const subject = String((item && item.subject) || "").trim() || "(no subject)";
  box.setAttribute("aria-label", "Select " + subject);
  box.checked = !!(context && agentReplySelection.has(context.messageId));
  box.addEventListener("click", (event) => event.stopPropagation());
  box.addEventListener("change", () => {
    if (!context) return;
    if (box.checked) agentReplySelection.add(context.messageId);
    else agentReplySelection.delete(context.messageId);
    paintReplySelectionLabels();
  });
  return box;
}

function paintReplySelectionLabels(root) {
  const home = root || $("agent-home");
  if (!home || typeof home.querySelectorAll !== "function") return;
  for (const block of home.querySelectorAll(".agent-section")) {
    const tools = block.querySelector(".agent-section-tools");
    if (!tools) continue;
    const boxes = [...block.querySelectorAll(".agent-select")];
    if (!boxes.length) continue;
    const labels = agentSelectionLabels(boxes.filter((box) => box.checked).length, boxes.length);
    const read = tools.querySelector(".agent-mark-selected");
    const done = tools.querySelector(".agent-complete-selected");
    if (read) read.textContent = labels.read;
    if (done) done.textContent = labels.done;
  }
}

function selectedReplyItems(block, items) {
  const wanted = new Set();
  for (const box of block.querySelectorAll(".agent-select")) {
    if (box.checked && box.dataset.messageId) wanted.add(box.dataset.messageId);
  }
  return (items || []).filter((item) => wanted.has(String(item && item.messageId || "")));
}

function agentReplySelectionTools(block, items) {
  const wrap = document.createElement("div");
  wrap.className = "agent-reply-tools";
  wrap.dataset.pile = "reply";
  const labels = agentSelectionLabels(0, items.length);
  const read = document.createElement("button");
  read.type = "button";
  read.className = "ghost agent-mark-selected";
  read.dataset.testid = "agent-mark-selected";
  read.textContent = labels.read;
  const done = document.createElement("button");
  done.type = "button";
  done.className = "ghost agent-complete-selected";
  done.dataset.testid = "agent-complete-selected";
  done.textContent = labels.done;
  read.addEventListener("click", () => {
    const captured = selectedReplyItems(block, items);
    if (!captured.length) return;
    guard(() => applyReplySelection(captured, "read"));
  });
  done.addEventListener("click", () => {
    const captured = selectedReplyItems(block, items);
    if (!captured.length) return;
    guard(() => applyReplySelection(captured, "done"));
  });
  wrap.append(read, done);
  return wrap;
}

function agentCategoryReadButton(role, items) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost agent-category-read";
  button.dataset.testid = "agent-category-read";
  button.dataset.pile = role;
  button.textContent = "Mark category as read";
  const snapshot = items.slice();
  button.addEventListener("click", () => guard(() => markAgentCategoryRead(snapshot)));
  return button;
}

function paintAgentReadProjection(messageId, unread, original) {
  eachStarRow({ id: messageId }, (row) => { row.unread = unread; row.isRead = !unread; });
  if (state.view === "mail" && $("messages") && $("message-list")) renderList();
  const rows = original ? [original] : [];
  for (const section of agentPaintPayload && agentPaintPayload.sections || []) rows.push(...section.items || []);
  for (const item of rows) {
    if (item && String(item.messageId || "") === messageId) item.unread = unread;
  }
  if (unread) agentMarkedRead.delete(messageId);
  else agentMarkedRead.add(messageId);
  if (state.view === "agent" && agentPaintPayload) paintAgentHome(agentPaintPayload);
}

function beginAgentRead(item, begunAt, complete) {
  const entry = { item, begunAt, complete, signal: learningSignalItem(item), receipt: null, early: [] };
  agentPendingReads.set(String(item.messageId), entry);
  return entry;
}

async function settleAgentReadOutcome(outcome) {
  if (outcome.kind && outcome.kind !== "read") return;
  const entry = agentPendingReads.get(String(outcome.id));
  if (!entry) return;
  if (!entry.receipt) {
    entry.early.push(outcome);
    return;
  }
  const receipt = entry.receipt;
  if (!Number.isFinite(outcome.generation) || outcome.generation < receipt.generation) return;
  agentPendingReads.delete(String(outcome.id));
  const same = outcome.generation === receipt.generation && (!receipt.actionId || outcome.actionId === receipt.actionId);
  const completed = same && outcome.status === "completed" && (!outcome.kind || outcome.kind === "read") && (!outcome.projection || outcome.projection.unread === false);
  const unread = outcome.projection ? !!outcome.projection.unread : !completed;
  // Record the confirmation before painting. A list repaint must not drop it.
  if (completed && entry.signal) await learnAgent({ kind: "action", action: "mark-read", begunAt: entry.begunAt, items: [entry.signal] });
  if (completed && entry.complete) {
    const context = agentMessageContext(entry.item);
    await updateTodo(context.messageId, "done", context.accountId);
  }
  if (outcome.generation >= (actionGeneration.get(outcome.id) || 0)) paintAgentReadProjection(String(outcome.id), unread, entry.item);
  if (!completed) {
    showStatus("Mark as read was not confirmed.", true);
    return same && outcome.status !== "completed" ? outcome.status : "superseded";
  }
  showStatus(entry.complete ? "Marked as read; todo completed." : "Marked as read.");
  return "completed";
}

async function acceptAgentRead(entry, data) {
  const messageId = String(entry.item.messageId);
  if (agentPendingReads.get(messageId) !== entry) return "superseded";
  const outcomes = data && Array.isArray(data.outcomes) ? data.outcomes : [];
  const pending = data && Array.isArray(data.pending) ? data.pending : [];
  const receipt = outcomes.find((row) => row.id === messageId) || pending.find((row) => row.id === messageId);
  if (!receipt || !Number.isFinite(receipt.generation)) {
    agentPendingReads.delete(messageId);
    paintAgentReadProjection(messageId, true, entry.item);
    return "not_attempted";
  }
  entry.receipt = receipt;
  const early = entry.early.filter((row) => Number.isFinite(row.generation) && row.generation >= receipt.generation).sort((first, second) => second.generation - first.generation)[0];
  const outcome = early || outcomes.find((row) => row.id === messageId);
  if (outcome) {
    return await settleAgentReadOutcome(outcome);
  }
  paintAgentReadProjection(messageId, false, entry.item);
  return "pending";
}

function abandonAgentRead(entry) {
  const messageId = String(entry.item.messageId);
  if (agentPendingReads.get(messageId) !== entry) return;
  agentPendingReads.delete(messageId);
  paintAgentReadProjection(messageId, true, entry.item);
}

async function markAgentMessageRead(item, card, mode, begunAt = Date.now()) {
  const context = agentMessageContext(item);
  if (!context) return;
  const reply = agentPileRole(item) === "reply";
  const already = agentReadIntent(item) === "already" || agentMarkedRead.has(context.messageId);
  const complete = mode === "done" || (reply && state.prefs.markReadCompletesTodos === true);
  const pending = agentPendingReads.get(context.messageId);
  if (pending) {
    pending.complete = pending.complete || complete;
    showStatus("Mark as read is waiting for mailbox confirmation.");
    return "pending";
  }
  if (already && !complete) {
    showStatus("Already read.");
    return "already";
  }
  if (!already) {
    const entry = beginAgentRead(item, begunAt, complete);
    try {
      const data = await setRead({ id: context.messageId, accountId: context.accountId, unread: true }, true);
      const status = await acceptAgentRead(entry, data);
      showStatus(status === "pending" ? "Mark as read is waiting for mailbox confirmation." : status === "completed" ? "Marked as read." : "Mark as read was not confirmed.", status !== "pending" && status !== "completed");
      return status;
    } catch (error) {
      abandonAgentRead(entry);
      throw error;
    }
  }
  if (complete) {
    await updateTodo(context.messageId, "done", context.accountId);
    return;
  }
  showStatus("Marked as read.");
}

async function applyReplySelection(items, mode) {
  const captured = (items || []).filter((item) => agentMessageContext(item));
  if (!captured.length) return;
  if (mode === "done") {
    for (const item of captured) {
      const context = agentMessageContext(item);
      await updateTodo(context.messageId, "done", context.accountId);
    }
    showStatus(captured.length === 1 ? "Todo completed." : "Todos completed.");
    return;
  }
  const begunAt = Date.now();
  for (const item of captured) {
    await markAgentMessageRead(item, null, undefined, begunAt);
  }
  if (state.view === "agent" && agentPaintPayload) paintAgent(agentPaintPayload, "");
}

async function markAgentCategoryRead(items) {
  const begunAt = Date.now();
  const snapshot = agentUnreadSnapshot(items);
  if (!snapshot.length) return;
  const entries = snapshot.map((row) => beginAgentRead(items.find((item) => item.messageId === row.messageId), begunAt, false));
  let data;
  try {
    data = await call("mail:markReadBatch", {
      isRead: true,
      items: snapshot.map((row) => ({ emailId: row.messageId, accountId: row.accountId })),
    });
  } catch (error) {
    for (const entry of entries) abandonAgentRead(entry);
    throw error;
  }
  if (typeof rememberActionGeneration === "function") {
    rememberActionGeneration(data && data.pending);
    rememberActionGeneration(data && data.outcomes);
  }
  const undoRows = readUndoRows(snapshot, data);
  await Promise.all(entries.map((entry) => acceptAgentRead(entry, data)));
  if (state.view === "agent" && agentPaintPayload) paintAgent(agentPaintPayload, "");
  if (!undoRows.length) {
    showStatus("Mark as read was not confirmed.", true);
    return;
  }
  const noun = undoRows.length === 1 ? "message" : "messages";
  const waiting = entries.some((entry) => agentPendingReads.get(String(entry.item.messageId)) === entry);
  showReadUndo(waiting ? "Mark as read requested for " + undoRows.length + " " + noun + "." : "Marked " + undoRows.length + " " + noun + " as read.", undoRows);
}

function agentTodoActions(item, section) {
  const context = agentMessageContext(item);
  if (!context) return null;
  const actions = document.createElement("div");
  actions.className = "agent-actions";
  actions.setAttribute("data-testid", "agent-todo-actions");
  const mail = document.createElement("div");
  mail.className = "agent-action-group";
  const card = () => actions.closest && actions.closest(".agent-item");
  mail.append(
    agentActionButton("open", "Open", () => peekMessage(context.messageId)),
    agentActionButton("reply", "Reply", () => replyToAgentItem(item, "reply")),
    agentActionButton("reply-all", "Reply All", () => replyToAgentItem(item, "all")),
    agentActionButton("read", "Mark as read", () => markAgentMessageRead(item, card())),
  );
  if (agentPileRole(section || item) === "reply") {
    mail.append(agentActionButton("read-done", "Mark read & done", () => markAgentMessageRead(item, card(), "done")));
  }
  for (const follow of agentFollowUps(item)) {
    if (!follow || follow.kind === "open") continue;
    const label = suggestionClass(follow.label) || (follow.kind === "draft" ? "Review reply" : "Attachment");
    if (suggestionSuppressed(label)) continue;
    const followControl = styleFollowButton(Object.assign({}, follow, { label }));
    const dismissFollow = agentActionButton("dismiss", "Dismiss " + label, () => {
      followControl.remove();
      dismissFollow.remove();
      return learnAgent({
        kind: "suggestion",
        choice: "dismiss",
        className: label,
        begunAt: Date.now(),
      });
    });
    mail.append(followControl, dismissFollow);
  }
  const local = document.createElement("div");
  local.className = "agent-action-group agent-action-local";
  local.append(
    agentActionButton("done", "Mark todo done", () => updateTodo(context.messageId, "done", context.accountId)),
    agentActionButton("dismiss", "Dismiss", () => updateTodo(context.messageId, "dismissed", context.accountId)),
  );
  for (const button of agentMoveButtons(item, section)) local.appendChild(button);
  const learned = agentLearnedLine(item);
  if (learned) actions.appendChild(learned);
  actions.append(mail, local);
  return actions;
}

function agentMoveButtons(item, section) {
  const targets = agentMoveTargets(agentPileRole(section || item));
  if (!agentMessageContext(item) || !targets.length) return [];
  const fromName = String((section && (section.name || section.title)) || "").trim();
  return targets.map(([id, name]) => agentActionButton("move", "Move to " + name, () => moveAgentCategory(item, id, name, fromName)));
}

let agentTodoView = "list";
let agentDetailSeq = 0;
let agentCardOutsideWired = false;

function agentPlain(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function agentReasonLine(item) {
  return agentPlain(item && item.summary) || "No Agent reason for this message.";
}

function agentClassification(item, section) {
  const source = section && typeof section === "object" ? section : {};
  const name = String(source.name || source.title || (item && item.categoryId) || "Category").trim() || "Category";
  const description = agentPlain(source.description || (item && item.reason));
  return description ? name + " — " + description : name;
}

function agentThreadLine(item) {
  const explicit = agentPlain(item && (item.threadLine || item.threadSnippet));
  if (explicit) return explicit;
  const snippet = agentPlain(item && item.snippet);
  const summary = agentPlain(item && item.summary);
  if (snippet && snippet !== summary) return snippet;
  const subject = agentPlain(item && item.subject) || "(no subject)";
  return "Thread · " + subject;
}

function nextAgentDetailId(messageId) {
  agentDetailSeq += 1;
  const safe = String(messageId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return "agent-detail-" + agentDetailSeq + (safe ? "-" + safe : "");
}

function syncAgentTodoViewControls() {
  const view = agentTodoView === "card" ? "card" : "list";
  agentTodoView = view;
  const home = $("agent-home");
  if (home && home.dataset) home.dataset.todoView = view;
  const listBtn = $("agent-view-list");
  const cardBtn = $("agent-view-card");
  if (listBtn) listBtn.setAttribute("aria-pressed", view === "list" ? "true" : "false");
  if (cardBtn) cardBtn.setAttribute("aria-pressed", view === "card" ? "true" : "false");
}

function setAgentTodoView(next, options) {
  agentTodoView = next === "card" ? "card" : "list";
  try { localStorage.setItem("morrow.agentTodoView", agentTodoView); } catch { /* this window only */ }
  syncAgentTodoViewControls();
  if (options && options.paint === false) return;
  if (agentPaintPayload) paintAgentHome(agentPaintPayload);
}

function wireAgentTodoView() {
  let stored = "list";
  try {
    const value = localStorage.getItem("morrow.agentTodoView");
    if (value === "card" || value === "list") stored = value;
  } catch { /* list */ }
  const bar = $("agent-view-switch");
  if (bar && bar.dataset && !bar.dataset.wired) {
    bar.dataset.wired = "1";
    bar.addEventListener("click", (event) => {
      const button = event.target && event.target.closest ? event.target.closest("[data-agent-view]") : null;
      if (!button || !button.dataset) return;
      setAgentTodoView(button.dataset.agentView);
    });
  }
  setAgentTodoView(stored, { paint: false });
}

function agentHoverNone() {
  try {
    return !!(window.matchMedia && window.matchMedia("(hover: none)").matches);
  } catch {
    return false;
  }
}

function agentPointerCoarse(event) {
  const type = event && event.pointerType;
  if (type === "touch" || type === "pen") return true;
  return agentHoverNone();
}

function syncAgentCardDisclosure(card) {
  const face = card && card.querySelector ? card.querySelector("[data-agent-face]") : null;
  if (!face) return;
  const summaryId = card.dataset ? card.dataset.summaryId || "" : "";
  const open = card.classList.contains("is-open");
  const ids = String(face.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== summaryId);
  if (open && summaryId) ids.push(summaryId);
  if (ids.length) face.setAttribute("aria-describedby", ids.join(" "));
  else face.removeAttribute("aria-describedby");
  face.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) face.removeAttribute("title");
  else if (face.dataset && face.dataset.agentTitle) face.setAttribute("title", face.dataset.agentTitle);
  else face.removeAttribute("title");
  const detail = card.querySelector(".agent-card-detail");
  if (detail) detail.hidden = !open;
}

function openAgentCardDetail(card) {
  if (!card || (card.dataset && card.dataset.detailBlock === "1") || card.classList.contains("is-open")) return;
  const home = $("agent-home");
  if (home && typeof home.querySelectorAll === "function") {
    for (const other of home.querySelectorAll(".agent-card.is-open")) {
      if (other !== card) closeAgentCardDetail(other);
    }
  }
  card.classList.add("is-open");
  syncAgentCardDisclosure(card);
}

function closeAgentCardDetail(card, options) {
  if (!card) return;
  const opts = options || {};
  card.classList.remove("is-open");
  if (opts.block && card.dataset) card.dataset.detailBlock = "1";
  syncAgentCardDisclosure(card);
  if (!opts.focus) return;
  const face = card.querySelector("[data-agent-face]");
  if (face && typeof face.focus === "function") face.focus();
}

function wireAgentCardOutside() {
  if (agentCardOutsideWired || !document || typeof document.addEventListener !== "function") return;
  agentCardOutsideWired = true;
  document.addEventListener("pointerdown", (event) => {
    const home = $("agent-home");
    if (!home || typeof home.querySelectorAll !== "function") return;
    for (const card of home.querySelectorAll(".agent-card.is-open")) {
      if (event && typeof card.contains === "function" && card.contains(event.target)) continue;
      closeAgentCardDetail(card);
      if (card.dataset) delete card.dataset.detailBlock;
    }
  });
}

function bindAgentCardDetail(card) {
  const face = card.querySelector("[data-agent-face]");
  card.addEventListener("pointerenter", (event) => {
    const coarse = agentPointerCoarse(event);
    if (card.dataset) {
      if (coarse) card.dataset.coarse = "1";
      else delete card.dataset.coarse;
      if (!coarse) card.dataset.hover = "1";
    }
    if (coarse) return;
    openAgentCardDetail(card);
  });
  card.addEventListener("pointerleave", (event) => {
    if (event && event.relatedTarget && card.contains(event.relatedTarget)) return;
    if (card.dataset) delete card.dataset.hover;
    const blocked = !!(card.dataset && card.dataset.detailBlock === "1");
    if (card.dataset) delete card.dataset.detailBlock;
    if (blocked) return;
    if (card.dataset && card.dataset.coarse === "1") return;
    if (document.activeElement && card.contains(document.activeElement)) return;
    closeAgentCardDetail(card);
  });
  card.addEventListener("focusin", () => openAgentCardDetail(card));
  card.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!card.isConnected || (document.activeElement && card.contains(document.activeElement))) return;
      closeAgentCardDetail(card);
      if (card.dataset) delete card.dataset.detailBlock;
    }, 0);
  });
  card.addEventListener("keydown", (event) => {
    if (!event || event.key !== "Escape" || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!card.classList.contains("is-open")) return;
    if (typeof document.querySelector === "function" && document.querySelector("dialog[open]")) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    closeAgentCardDetail(card, { block: true, focus: true });
  });
  card.addEventListener("pointerdown", (event) => {
    const coarse = agentPointerCoarse(event);
    if (card.dataset) {
      if (coarse) card.dataset.coarse = "1";
      else delete card.dataset.coarse;
    }
    if (!coarse || card.classList.contains("is-open")) return;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    if (card.dataset) {
      delete card.dataset.detailBlock;
      card.dataset.suppressClick = "1";
    }
    openAgentCardDetail(card);
    if (face && typeof face.focus === "function") face.focus();
  }, true);
  card.addEventListener("click", (event) => {
    if (!card.dataset || card.dataset.suppressClick !== "1") return;
    delete card.dataset.suppressClick;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
  }, true);
}

function agentSkimCard(item, section) {
  const context = agentMessageContext(item);
  const card = document.createElement("article");
  card.className = "agent-item agent-card";
  card.setAttribute("data-testid", "agent-card");
  if (agentLooksUnread(item)) card.classList.add("unread");
  const messageId = String(item.messageId || "");
  if (messageId) card.dataset.messageId = messageId;
  const detailId = nextAgentDetailId(messageId);
  const summaryId = detailId + "-summary";
  card.dataset.summaryId = summaryId;
  const reason = agentReasonLine(item);
  const face = document.createElement("div");
  face.className = "agent-card-face";
  face.tabIndex = 0;
  face.dataset.agentFace = "1";
  face.dataset.agentTitle = reason;
  face.setAttribute("aria-controls", detailId);
  const top = document.createElement("div");
  top.className = "agent-card-top";
  if (agentPileRole(section || item) === "reply") top.appendChild(agentSelectBox(item));
  const sender = document.createElement("p");
  sender.className = "agent-card-sender";
  if (agentLooksUnread(item)) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    dot.setAttribute("aria-hidden", "true");
    sender.appendChild(dot);
  }
  const senderText = document.createElement("span");
  senderText.textContent = senderName(item && item.from);
  sender.appendChild(senderText);
  top.appendChild(sender);
  const subject = document.createElement("p");
  subject.className = "agent-card-subject";
  subject.textContent = agentPlain(item && item.subject) || "(no subject)";
  const line = document.createElement("p");
  line.className = "agent-card-line";
  line.textContent = reason;
  face.append(top, subject, line);
  const learned = agentLearnedLine(item);
  if (learned) face.appendChild(learned);
  const chips = document.createElement("div");
  chips.className = "agent-card-chips";
  chips.append(
    agentActionButton("reply", "Reply", () => replyToAgentItem(item, "reply")),
    agentActionButton("done", "Done", () => updateTodo(context.messageId, "done", context.accountId)),
  );
  const detail = document.createElement("div");
  detail.className = "agent-card-detail";
  detail.id = detailId;
  detail.hidden = true;
  detail.setAttribute("role", "group");
  detail.setAttribute("aria-label", "Message detail");
  const summary = document.createElement("p");
  summary.className = "agent-card-summary";
  summary.id = summaryId;
  summary.textContent = reason;
  const classification = document.createElement("p");
  classification.className = "agent-card-class";
  classification.textContent = agentClassification(item, section);
  const thread = document.createElement("p");
  thread.className = "agent-card-thread";
  thread.textContent = agentThreadLine(item);
  const quick = document.createElement("div");
  quick.className = "agent-card-quick";
  quick.append(
    agentActionButton("reply", "Reply", () => replyToAgentItem(item, "reply")),
    agentActionButton("done", "Done", () => updateTodo(context.messageId, "done", context.accountId)),
    agentActionButton("dismiss", "Dismiss", () => updateTodo(context.messageId, "dismissed", context.accountId)),
  );
  const moves = document.createElement("div");
  moves.className = "agent-card-moves";
  for (const button of agentMoveButtons(item, section)) moves.appendChild(button);
  detail.append(summary, classification, thread, quick);
  if (moves.childNodes.length) detail.appendChild(moves);
  card.append(face, chips, detail);
  syncAgentCardDisclosure(card);
  bindAgentCardDetail(card);
  wireAgentCardOutside();
  return card;
}

function agentTodoCard(item, section) {
  if (section && item && typeof item === "object" && !item.categoryId) item.categoryId = section.id || "";
  if (!agentMessageContext(item)) return agentCard(item);
  if (agentTodoView === "card") return agentSkimCard(item, section);
  const card = agentCard(item, { actions: false });
  if (agentPileRole(section || item) === "reply") {
    const main = card.querySelector(".agent-item-main");
    if (main) main.prepend(agentSelectBox(item));
  }
  const actions = agentTodoActions(item, section);
  if (actions) card.appendChild(actions);
  return card;
}

async function updateTodo(messageId, status, accountId) {
  const payload = { messageId, status };
  if (accountId) payload.accountId = accountId;
  const data = await call("nativeAgent:home:todoUpdate", payload);
  paintAgent(data, "");
}

function applyChatPayload(data, memoryVersion = agentMemoryVersion) {
  if (!data) return;
  if (Array.isArray(data.turns)) agentTurns = data.turns;
  if (data.memory && memoryVersion === agentMemoryVersion) applyAgentMemory(data.memory.notes || "");
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
  syncAgentPageBusy();
}

async function sendAgentText(text, skillId) {
  const trimmed = String(text || "").trim();
  if (!trimmed || agentChatBusy) return;
  showAgentTab("conversation");
  setAgentBusy(true);
  const input = $("agent-input");
  if (input && input.value.trim() === trimmed) input.value = "";
  const status = $("agent-status");
  if (status) {
    status.textContent = "Working…";
    status.classList.remove("error");
  }
  try {
    const memoryVersion = agentMemoryVersion;
    const request = agentChatRequest(trimmed);
    if (skillId) request.skillId = skillId;
    const data = await call("nativeAgent:chat", request);
    applyChatPayload(data, memoryVersion);
    if (data && (data.intent === "skill" || data.intent === "triage")) {
      const history = await call("nativeAgent:history");
      paintHistory($("agent-history"), history && history.runs);
    }
  } finally {
    setAgentBusy(false);
  }
}

function applyAgentMemory(value) {
  const notes = $("agent-memory");
  if (notes && !agentMemoryPending && notes.value === updateMemoryBaseline) notes.value = updateMemoryBaseline = value;
}

async function saveAgentMemory() {
  const notes = $("agent-memory");
  const submitted = notes ? notes.value : "";
  ++agentMemoryVersion;
  ++agentMemoryPending;
  const pending = agentMemorySaveQueue.catch(() => {}).then(async () => {
    try {
      const data = await call("nativeAgent:memorySet", { notes: submitted });
      if (data && typeof data.notes === "string") {
        updateMemoryBaseline = data.notes;
        if (notes && notes.value === submitted) notes.value = data.notes;
      }
      const status = $("agent-memory-status");
      if (status) status.textContent = notes && notes.value !== updateMemoryBaseline ? "Notes saved. Newer edits are not saved yet." : "Notes saved.";
    } finally {
      --agentMemoryPending;
      ++agentMemoryVersion;
    }
  });
  agentMemorySaveQueue = pending;
  return pending;
}

async function loadAgent(options) {
  const quiet = !!(options && options.overlay === false);
  const gen = ++agentGen;
  const memoryVersion = agentMemoryVersion;
  const hold = (on) => {
    if (gen !== agentGen) return;
    agentLoadOverlay = !!on;
    syncAgentPageBusy();
  };
  if (!quiet) hold(true);
  try {
    const [triage, history, chat] = await Promise.all([
      call("nativeAgent:home:todosCached"),
      call("nativeAgent:history"),
      call("nativeAgent:chatHistory"),
    ]);
    if (gen !== agentGen || state.view !== "agent") return;
    agentTurns = chat && Array.isArray(chat.turns) ? chat.turns : [];
    if (memoryVersion === agentMemoryVersion) applyAgentMemory((chat && chat.memory && chat.memory.notes) || "");
    const runs = history && Array.isArray(history.runs) ? history.runs : triage && triage.runs;
    const payload = Object.assign({}, triage, { runs });
    paintAgent(payload, "");
    agentLoaded = true;
    await loadStudio();
    if (gen !== agentGen || state.view !== "agent") return;
    const reason = triage && triage.reason;
    if (!(triage && triage.stale) || reason === "needs_key" || reason === "needs_mailbox") return;
    hold(true);
    const fresh = await call("nativeAgent:triage", { source: "open" });
    if (gen !== agentGen || state.view !== "agent") return;
    paintAgent(Object.assign({}, fresh, { runs }), "");
  } finally {
    if (gen === agentGen) hold(false);
  }
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
    loadAgent({ overlay: false }).catch(() => {});
  }, 60000);
}

function markRail(view) {
  state.view = view;
  state.side = view === "mail" ? "folders" : view;
  paintSyncControl();
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.dataset.view = view;
  const shell = $("shell");
  if (shell) shell.dataset.side = state.side;
  const current = {
    mail: "rail-mail",
    agent: "rail-agent",
    calendar: "rail-calendar",
    brain: "rail-brain",
    log: "rail-log",
    features: "rail-shortcuts",
    folders: "rail-folders",
  }[view];
  for (const id of ["rail-mail", "rail-agent", "rail-calendar", "rail-brain", "rail-shortcuts", "rail-log", "rail-folders"]) {
    const node = $(id);
    if (node) node.setAttribute("aria-current", id === current ? "page" : "false");
  }
}

function showPrimary(view, id) {
  const legacyFeatures = view === "shortcuts" || id === "shortcuts-panel";
  if (legacyFeatures) {
    view = "features";
    id = "features-panel";
  }
  if (view === "agent" || view === "brain") refreshAiSetupState();
  const swap = state.view !== view;
  if (view !== "agent") stopAgentPoll();
  markRail(view);
  paintBodySyncStatus();
  for (const pane of ["shell", "calendar-panel", "agent-panel", "brain", "provider-panel", "log-panel", "features-panel"]) {
    if (pane === id) continue;
    hidePane(pane);
  }
  if (swap) {
    const node = $(id);
    if (node.querySelector(":scope > .motion-block")) {
      node.hidden = false;
      playPageSections(id);
    } else revealPanel(id);
  } else {
    const node = $(id);
    if (node) node.hidden = false;
  }
  if (legacyFeatures) {
    paintFeatureCatalog();
    paintShortcuts();
    paintCli();
    showFeaturesTab("catalog");
  }
}

function showAgent() {
  showPrimary("agent", "agent-panel");
  const greet = $("agent-greeting");
  if (greet) greet.textContent = agentGreeting();
  startAgentPoll();
  loadAgent({ overlay: !agentLoaded }).catch((error) => {
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
  fillAccountOptions($("calendar-account"), state.accounts.filter(isLive), calendarAccount()?.id);
}

function fillCalendarPick(calendars) {
  const select = $("calendar-pick");
  if (!select) return;
  const dialog = $("calendar-event-dialog");
  const editing = !!(dialog && dialog.open);
  const keep = editing ? select.value : "";
  const key = JSON.stringify(calendars.map(row => [row.id, row.name]));
  if (select.dataset.optionsKey !== key) {
    select.dataset.optionsKey = key;
    select.replaceChildren(...calendars.map(calendar => option(calendar.id, calendar.name || calendar.id)));
  }
  if (editing && keep && Array.from(select.options).some((item) => item.value === keep)) {
    select.value = keep;
    return;
  }
  const preferred = state.calendarId || state.calendarIds[0] || "";
  if (preferred && calendars.some(calendar => calendar.id === preferred)) select.value = preferred;
  else if (select.value) state.calendarId = select.value;
}

function calendarEventKey(event) {
  if (!event || !event.id) return "";
  return JSON.stringify([String(event.calendarId || ""), String(event.id)]);
}

function selectedCalendarEvent(payload) {
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  return events.find((event) => calendarEventKey(event) === state.calendarEventId) || null;
}

function checkedCalendarEvents(events) {
  const ids = state.calendarIds;
  if (!ids.length) return Array.isArray(events) ? events : [];
  const allowed = new Set(ids);
  return (Array.isArray(events) ? events : []).filter((event) => !event || !event.calendarId || allowed.has(event.calendarId));
}

let calendarDetailKey = "";
let calendarEditingId = "";
let calendarEditingIdentity = null;
let calendarTimedSnapshot = null;
let calendarCreateAttempt = null;
const calendarAuthFailures = new Set();

function recordCalendarAuthFailure(accountId, error) {
  if (!["needs_auth", "scope_missing", "oauth", "google_client_changed"].includes(error?.code)) return false;
  calendarAuthFailures.add(accountId);
  if (calendarAccount()?.id === accountId) {
    const grant = $("calendar-grant");
    if (grant) grant.textContent = "Reauthorize calendar";
  }
  return true;
}
let calendarEditorGeneration = 0;
let calendarWritePending = false;

function calendarDetailLine(paths, label, value, empty) {
  const line = document.createElement("p");
  line.className = "calendar-detail-line";
  line.appendChild(strokeIcon(paths, 16));
  const name = document.createElement("span");
  name.className = "calendar-detail-label";
  name.textContent = label;
  const text = document.createElement("span");
  text.textContent = value;
  if (empty) text.classList.add("is-empty");
  line.append(name, text);
  return line;
}

function paintCalendarDetail(event, calendarName) {
  const root = $("calendar-detail");
  if (!root) return;
  const key = JSON.stringify([event, calendarName]);
  if (calendarDetailKey === key) return;
  calendarDetailKey = key;
  root.replaceChildren();
  if (!event) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const title = document.createElement("h3");
  title.textContent = event.title || "(no title)";
  root.appendChild(title);
  root.appendChild(calendarDetailLine(
    ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 6v6l4 2"],
    "When",
    formatEventDetailWhen(event) || "Time not provided.",
    false,
  ));
  root.appendChild(calendarDetailLine(
    ["M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z", "M16 2v4M8 2v4M3 10h18"],
    "Calendar",
    calendarName || "Calendar",
    !calendarName,
  ));
  root.appendChild(calendarDetailLine(
    ["M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z", "M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
    "Location",
    event.location || "No location",
    !event.location,
  ));
  const description = document.createElement("p");
  description.className = "calendar-detail-description";
  if (event.description) description.textContent = event.description;
  else {
    description.textContent = "No description";
    description.classList.add("is-empty");
  }
  root.appendChild(description);
  const actions = document.createElement("div");
  actions.className = "row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "ghost";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openCalendarEditor(event));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    guard(() => deleteCalendarEvent(event));
  });
  actions.append(edit, remove);
  root.appendChild(actions);
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
    button.dataset.eventId = event.id;
    button.dataset.eventKey = calendarEventKey(event);
    button.style.setProperty("--event-color", calendarColor(event.calendarId));
    if (button.dataset.eventKey === state.calendarEventId) button.classList.add("is-selected");
    button.textContent = agendaLine(event);
    button.addEventListener("click", () => selectCalendarEvent(event));
    button.addEventListener("dblclick", (click) => {
      click.preventDefault();
      selectCalendarEvent(event);
      openCalendarEditor(event);
    });
    root.appendChild(button);
  }
}

function selectCalendarEvent(event) {
  state.calendarEventId = calendarEventKey(event);
  if (state.calendarPayload) paintCalendarSelection(state.calendarPayload);
}

function paintCalendarSelection(payload) {
  for (const node of $("calendar-layout").querySelectorAll("[data-event-key]")) {
    const selected = node.dataset.eventKey === state.calendarEventId;
    node.classList.toggle("is-selected", selected);
    node.setAttribute("aria-pressed", String(selected));
  }
  const selected = selectedCalendarEvent(payload);
  paintCalendarDetail(selected, calendarNameOf(payload?.calendars || [], selected?.calendarId || state.calendarId));
}

let calendarGridKey = "";
let calendarEventsKey = "";
function paintCalendar(payload) {
  calendarPaintedAccountId = calendarAccount()?.id || "";
  const view = calendarView(payload);
  const cursor = state.calendarCursor || new Date();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const range = monthRange(year, month);
  const account = calendarAccount();
  const connection = calendarConnection(state.calendarStatus || state.oauthStatus, account, payload, calendarAuthFailures.has(account?.id));
  let status = view.status;
  if (!view.showGrid && payload && payload.reason === "needs_auth" && account && account.email) {
    status = calendarCopy("needs_auth", account.email);
  }
  $("calendar-heading").textContent = range.label;
  const statusEl = $("calendar-status");
  statusEl.textContent = status;
  statusEl.classList.toggle("error", view.error === true);
  statusEl.classList.toggle("is-empty", !view.showGrid);
  const add = $("calendar-add");
  if (add) {
    add.disabled = !view.showForm;
    add.title = view.showForm ? "Create an event" : "Shown when this month has a calendar.";
  }
  const grant = $("calendar-grant");
  grant.disabled = !connection.canGrant;
  grant.textContent = connection.label;
  grant.title = connection.canGrant ? "" : connection.reason;
  const layout = $("calendar-layout");
  if (layout) layout.hidden = !view.showGrid;
  const body = $("calendar-body");
  if (!view.showGrid) {
    paintCalendarDetail(null, "");
    return;
  }
  fillCalendarPick(view.calendars);
  paintCalendarList(view.calendars);
  paintMiniMonth(year, month);
  ensureCalendarGrid(year, month);
  const events = checkedCalendarEvents(view.events);
  const eventsKey = JSON.stringify([account?.id, state.calendarIds, events]);
  const changed = eventsKey !== calendarEventsKey;
  for (const cell of body.querySelectorAll("[data-day]")) {
    const day = Number(cell.dataset.day);
    const key = dayKey(year, month, day);
    if (!changed) continue;
    const bucket = cell.querySelector(".calendar-day-events") || cell;
    for (const item of bucket.querySelectorAll(".calendar-event")) item.remove();
    const rows = eventsOnDay(events, key).slice().sort((left, right) => {
      if (!!left.allDay !== !!right.allDay) return left.allDay ? -1 : 1;
      return compareCalendarStarts(left, right);
    });
    for (const event of rows) appendCalendarEvent(bucket, event, key, calendarColor(event.calendarId || state.calendarId));
  }
  paintCalendarFocus(year, month);
  if (changed) {
    calendarEventsKey = eventsKey;
    paintAgenda(events);
  }
  paintCalendarSelection(payload);
}

function appendCalendarEvent(parent, event, key, color) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "calendar-event";
  item.dataset.eventId = event.id;
  item.dataset.eventKey = calendarEventKey(event);
  item.style.setProperty("--event-color", color || calendarColor(event.calendarId));
  if (event.allDay) {
    item.classList.add("is-all-day");
    if (allDayContinues(event, key)) item.classList.add("is-continued");
    item.textContent = event.title || "(no title)";
  } else {
    item.classList.add("is-timed");
    const dot = document.createElement("span");
    dot.className = "calendar-dot";
    dot.setAttribute("aria-hidden", "true");
    const when = document.createElement("span");
    when.className = "calendar-when";
    when.textContent = clockLabel(event.start);
    const title = document.createElement("span");
    title.className = "calendar-title";
    title.textContent = event.title || "(no title)";
    item.append(dot, when, title);
  }
  item.title = [event.title || "(no title)", event.location].filter(Boolean).join(" — ");
  item.addEventListener("click", (click) => {
    click.stopPropagation();
    selectCalendarEvent(event);
  });
  item.addEventListener("dblclick", (click) => {
    click.stopPropagation();
    click.preventDefault();
    selectCalendarEvent(event);
    openCalendarEditor(event);
  });
  parent.appendChild(item);
}

function paintCalendarFocus(year, month) {
  const focus = state.calendarFocusDay || "";
  const body = $("calendar-body");
  if (body) {
    for (const cell of body.querySelectorAll("[data-day]")) {
      const day = Number(cell.dataset.day);
      const stamp = day ? dayKey(year, month, day) : "";
      cell.classList.toggle("is-focus", !!stamp && stamp === focus);
      cell.classList.toggle("today", sameDay(year, month, day));
      const num = cell.querySelector(".calendar-num");
      if (num) num.classList.toggle("is-today", sameDay(year, month, day));
    }
  }
  const mini = $("calendar-mini");
  if (!mini) return;
  for (const button of mini.querySelectorAll(".mini-day")) {
    button.classList.toggle("is-focus", button.dataset.stamp === focus);
  }
}

function focusCalendarDay(year, month, day) {
  const stamp = dayKey(year, month, day);
  const cursor = state.calendarCursor || new Date();
  state.calendarFocusDay = stamp;
  if (cursor.getFullYear() === year && cursor.getMonth() === month) {
    paintCalendarFocus(year, month);
    return;
  }
  state.calendarCursor = new Date(year, month, 1);
  loadCalendar().catch((error) => showStatus(error.message, true));
}

function paintMiniMonth(year, month) {
  const root = $("calendar-mini");
  if (!root) return;
  const monthKey = String(year) + "-" + String(month);
  if (root.dataset.month === monthKey && root.querySelector(".mini-day")) return;
  root.dataset.month = monthKey;
  root.replaceChildren();
  const bar = document.createElement("div");
  bar.className = "mini-bar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "ghost icon-btn";
  prev.setAttribute("aria-label", "Previous month");
  prev.appendChild(strokeIcon(["M15 18l-6-6 6-6"], 16));
  prev.addEventListener("click", () => shiftMonth(-1));
  const label = document.createElement("span");
  label.textContent = monthRange(year, month).label;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "ghost icon-btn";
  next.setAttribute("aria-label", "Next month");
  next.appendChild(strokeIcon([MOVE_CHEVRON_RIGHT], 16));
  next.addEventListener("click", () => shiftMonth(1));
  bar.append(prev, label, next);
  const grid = document.createElement("div");
  grid.className = "mini-grid";
  for (const name of displayStamp(null, "weekdays", { narrow: true })) {
    const dow = document.createElement("div");
    dow.className = "mini-dow";
    dow.textContent = name;
    grid.appendChild(dow);
  }
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-day";
    const cellYear = date.getFullYear();
    const cellMonth = date.getMonth();
    const cellDay = date.getDate();
    button.dataset.stamp = dayKey(cellYear, cellMonth, cellDay);
    button.textContent = String(cellDay);
    if (cellMonth !== month) button.classList.add("is-outside");
    if (sameDay(cellYear, cellMonth, cellDay)) button.classList.add("is-today");
    button.addEventListener("click", () => focusCalendarDay(cellYear, cellMonth, cellDay));
    grid.appendChild(button);
  }
  root.append(bar, grid);
}

function readCalendarCheckStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem("morrow.calendarChecks") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function readCalendarChecks(accountId) {
  const rows = readCalendarCheckStore()[accountId];
  if (!Array.isArray(rows)) return [];
  const ids = [];
  for (const row of rows) {
    const id = String(row || "");
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids.slice(0, 100); // shortcut: 100 ids, when calendarList pages past 100
}

function saveCalendarChecks(accountId, ids) {
  if (!accountId) return;
  try {
    const store = readCalendarCheckStore();
    store[accountId] = ids;
    localStorage.setItem("morrow.calendarChecks", JSON.stringify(store));
  } catch { /* the choice stays for this window */ }
}

function ensureCalendarChecks(account) {
  if (!account || state.calendarChecksAccountId === account.id) return;
  state.calendarChecksAccountId = account.id;
  state.calendarId = "";
  state.calendarEventId = "";
  state.calendarIds = readCalendarChecks(account.id);
}

function toggleCalendarCheck(input, id) {
  const next = state.calendarIds.filter((item) => item !== id);
  if (input.checked) next.push(id);
  if (!next.length) {
    input.checked = true;
    return;
  }
  state.calendarIds = next;
  if (input.checked) state.calendarId = id;
  else if (state.calendarId === id) state.calendarId = next[0];
  state.calendarEventId = "";
  saveCalendarChecks((calendarAccount() && calendarAccount().id) || "", next);
  if (state.calendarPayload) paintCalendar(state.calendarPayload);
  loadCalendar().catch((error) => showStatus(error.message, true));
}

function paintCalendarList(calendars) {
  const root = $("calendar-list");
  if (!root) return;
  const rows = Array.isArray(calendars) ? calendars : [];
  const key = JSON.stringify(rows.map((row) => [row.id, row.name]));
  if (root.dataset.key !== key) {
    root.dataset.key = key;
    root.replaceChildren();
    for (const calendar of rows) {
      const label = document.createElement("label");
      label.className = "calendar-source";
      label.style.setProperty("--event-color", calendarColor(calendar.id));
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = calendar.id;
      input.addEventListener("change", () => toggleCalendarCheck(input, calendar.id));
      const name = document.createElement("span");
      name.textContent = calendar.name || calendar.id;
      label.append(input, name);
      root.appendChild(label);
    }
  }
  for (const input of root.querySelectorAll("input")) input.checked = state.calendarIds.includes(input.value);
}

function syncAllDayInputs() {
  const allDay = $("calendar-all-day");
  const start = $("calendar-start");
  const end = $("calendar-end");
  if (!allDay || !start || !end) return;
  const startValue = start.value, endValue = end.value;
  const enabled = !!allDay.checked;
  const wasTimed = start.type === "datetime-local";
  const restore = !enabled && calendarTimedSnapshot
    && startValue === calendarTimedSnapshot.dateStart && endValue === calendarTimedSnapshot.dateEnd;
  start.type = enabled ? "date" : "datetime-local";
  end.type = enabled ? "date" : "datetime-local";
  const endLabel = document.querySelector("label[for='calendar-end']");
  if (endLabel) endLabel.textContent = enabled ? "End (exclusive)" : "End";
  if (enabled) {
    start.value = startValue.slice(0, 10);
    end.value = endValue.slice(0, 10);
    if (start.value && (!end.value || end.value <= start.value)) end.value = plusDays(start.value, 1);
    if (wasTimed) calendarTimedSnapshot = { start: startValue, end: endValue, dateStart: start.value, dateEnd: end.value };
  } else {
    start.value = restore ? calendarTimedSnapshot.start : /^\d{4}-\d{2}-\d{2}$/.test(startValue) ? startValue + "T09:00" : startValue;
    end.value = restore ? calendarTimedSnapshot.end : /^\d{4}-\d{2}-\d{2}$/.test(endValue) ? endValue + "T10:00" : endValue;
    calendarTimedSnapshot = null;
  }
}

function openCalendarEditor(event, dayStamp) {
  const account = calendarAccount();
  if (event?.id && state.calendarPayload?.accountId && state.calendarPayload.accountId !== account?.id) {
    showStatus("Wait for this mailbox's calendar to finish loading before editing an event.", true);
    return;
  }
  calendarEditorGeneration += 1;
  calendarTimedSnapshot = null;
  calendarCreateAttempt = null;
  const dialogTitle = $("calendar-dialog-title");
  const save = $("calendar-save");
  const remove = $("calendar-delete");
  const title = $("calendar-event-title");
  const location = $("calendar-location");
  const description = $("calendar-description");
  const allDay = $("calendar-all-day");
  const start = $("calendar-start");
  const end = $("calendar-end");
  const status = $("calendar-form-status");
  if (status) {
    status.textContent = "";
    status.classList.remove("error");
  }
  const editing = !!(event && event.id);
  calendarEditingId = editing ? String(event.id) : "";
  calendarEditingIdentity = editing ? { accountId: account?.id, calendarId: event.calendarId || state.calendarId,
    id: calendarEditingId, title: String(event.title || ""), titleTruncated: !!event.titleTruncated,
    description: String(event.description || ""), descriptionTruncated: !!event.descriptionTruncated, location: String(event.location || "") } : null;
  if (dialogTitle) dialogTitle.textContent = editing ? "Edit event" : "Add event";
  if (save) save.textContent = editing ? "Save" : "Add event";
  if (remove) remove.hidden = !editing;
  if (title) title.value = editing ? (event.title || "") : "";
  if (title) title.readOnly = !!(editing && event.titleTruncated);
  if (title && editing) calendarEditingIdentity.title = title.value;
  const titleNote = $("calendar-title-note");
  if (titleNote) titleNote.hidden = !(editing && event.titleTruncated);
  if (location) location.value = editing ? (event.location || "") : "";
  if (description) description.value = editing ? (event.description || "") : "";
  if (description) description.readOnly = !!(editing && event.descriptionTruncated);
  const descriptionNote = $("calendar-description-note");
  if (descriptionNote) descriptionNote.hidden = !(editing && event.descriptionTruncated);
  if (allDay) allDay.checked = editing ? !!event.allDay : false;
  // Assign values only after the input type accepts their representation.
  start.type = end.type = editing && event.allDay ? "date" : "datetime-local";
  if (editing && event.allDay) {
    start.value = String(event.start || "").slice(0, 10);
    end.value = String(event.end || "").slice(0, 10);
    if (!end.value || end.value <= start.value) end.value = plusDays(start.value, 1);
  } else if (editing) {
    start.value = toDateTimeLocal(event.start);
    end.value = toDateTimeLocal(event.end);
  } else {
    const stamp = dayStamp || state.calendarFocusDay || localDateStamp(state.calendarCursor || new Date());
    start.value = stamp + "T09:00";
    end.value = stamp + "T10:00";
  }
  syncAllDayInputs();
  if (editing) calendarEditingIdentity.timeInputs = [start.value, end.value, !!allDay.checked];
  const pick = $("calendar-pick");
  if (pick) pick.disabled = editing;
  const wanted = editing && event.calendarId ? event.calendarId : (state.calendarId || state.calendarIds[0] || "");
  if (pick && wanted && Array.from(pick.options).some((item) => item.value === wanted)) pick.value = wanted;
  openDialog("calendar-event-dialog");
  if (title) title.focus();
}

async function deleteCalendarEvent(event) {
  const identity = event?.id ? event : calendarEditingIdentity;
  const id = identity?.id;
  if (!id) return;
  const account = calendarAccount();
  const ownerId = identity.accountId || state.calendarPayload?.accountId || account?.id;
  if (ownerId !== account?.id) throw new Error("The calendar account changed. Reopen the event before deleting it.");
  if (calendarWritePending) throw new Error("A calendar change is still being confirmed.");
  const generation = calendarEditorGeneration;
  calendarWritePending = true;
  try {
    const answer = await askConfirm({
      title: "Delete event",
      body: "Delete this event from the calendar? This removes it from Google Calendar or Outlook.",
      confirm: "Delete",
      cancel: "Cancel",
      needsName: false,
    });
    if (!answer || !answer.ok) return;
    if (calendarAccount()?.id !== ownerId) throw new Error("The calendar account changed. Reopen the event before deleting it.");
    await call("calendar:deleteEvent", {
      accountId: ownerId,
      calendarId: identity.calendarId,
      eventId: id,
    });
    invalidateCalendarAccount(ownerId);
    if (generation !== calendarEditorGeneration || calendarAccount()?.id !== ownerId) {
      if (state.view === "calendar" && calendarAccount()?.id === ownerId && !$("calendar-event-dialog").open) await loadCalendar({ fresh: true });
      return;
    }
    calendarEditingId = "";
    calendarEditingIdentity = null;
    if (event && calendarEventKey(event) === state.calendarEventId) state.calendarEventId = "";
    closeDialog("calendar-event-dialog");
    showStatus("Event deleted.");
    await loadCalendar({ fresh: true });
  } catch (error) {
    recordCalendarAuthFailure(ownerId, error);
    throw error;
  } finally { calendarWritePending = false; }
}

function syncCalendarNav(view) {
  const nav = $("calendar-nav");
  if (!nav) return;
  const grid = !!(view && view.showGrid);
  const form = !!(view && view.showForm);
  for (const button of nav.querySelectorAll("[data-scroll]")) {
    const id = button.getAttribute("data-scroll");
    const enabled = id === "calendar-create" ? form : grid;
    button.disabled = !enabled;
    if (enabled) button.removeAttribute("title");
    else button.title = "Shown when this month has a calendar.";
    if (!enabled) button.setAttribute("aria-current", "false");
  }
}

const calendarCache = new Map();
const calendarPending = new Map();
const calendarRevisions = new Map();
let calendarStatusPending = null;
let calendarPaintedAccountId = "";
function invalidateCalendarAccount(accountId) {
  // An edit can affect multiple months and checked-calendar combinations.
  calendarRevisions.set(accountId, (calendarRevisions.get(accountId) || 0) + 1);
  const prefix = JSON.stringify([accountId]).slice(0, -1) + ",";
  for (const entries of [calendarCache, calendarPending]) {
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  }
}
function calendarCacheKey(account, range, calendarIds) {
  const ids = Array.isArray(calendarIds) ? calendarIds : [];
  return JSON.stringify([account?.id || "", range.timeMin, ids]);
}
function calendarMonthVisible() {
  const layout = $("calendar-layout");
  const body = $("calendar-body");
  return !!(layout && !layout.hidden && body && body.querySelector(".calendar-grid"));
}
function beginCalendarRequest(account) {
  ensureCalendarChecks(account);
  state.calendarAccountId = account.id;
  const cursor = state.calendarCursor || new Date();
  state.calendarCursor = cursor;
  const range = monthRange(cursor.getFullYear(), cursor.getMonth());
  const requestedIds = state.calendarIds.slice();
  const key = calendarCacheKey(account, range, requestedIds);
  return { range, requestedIds, key, cached: calendarCache.get(key) || null };
}
function calendarKeepsMonth(cached) {
  if (cached && cached.payload && cached.payload.api === true) return true;
  return !!(state.calendarPayload && state.calendarPayload.api === true && calendarMonthVisible());
}
function calendarBusyLabel(keepMonth) {
  return keepMonth ? "Updating calendar…" : "Loading…";
}
function ensureCalendarGrid(year, month) {
  const range = monthRange(year, month);
  const body = $("calendar-body");
  if (!body) return;
  if (calendarGridKey === range.timeMin && body.querySelector(".calendar-grid")) return;
  calendarGridKey = range.timeMin;
  calendarEventsKey = "";
  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", range.label);
  for (const name of displayStamp(null, "weekdays")) {
    const head = document.createElement("div");
    head.className = "calendar-dow";
    head.textContent = name;
    grid.appendChild(head);
  }
  for (const day of monthCells(year, month)) {
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (!day) cell.classList.add("pad");
    else {
      cell.dataset.day = String(day);
      const num = document.createElement("span");
      num.className = "calendar-num";
      num.textContent = String(day);
      const events = document.createElement("div");
      events.className = "calendar-day-events";
      cell.append(num, events);
      const stamp = dayKey(year, month, day);
      cell.addEventListener("click", () => {
        state.calendarFocusDay = stamp;
        paintCalendarFocus(year, month);
      });
      cell.addEventListener("dblclick", () => {
        state.calendarFocusDay = stamp;
        paintCalendarFocus(year, month);
        const create = $("calendar-add");
        if (create && !create.disabled) openCalendarEditor(null, stamp);
      });
    }
    grid.appendChild(cell);
  }
  body.replaceChildren(grid);
}
function paintCalendarShell() {
  const cursor = state.calendarCursor || new Date();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const range = monthRange(year, month);
  const heading = $("calendar-heading");
  if (heading) heading.textContent = range.label;
  const statusEl = $("calendar-status");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.classList.remove("error", "is-empty");
  }
  const layout = $("calendar-layout");
  if (layout) layout.hidden = false;
  const add = $("calendar-add");
  if (add) {
    add.disabled = true;
    add.title = "Shown when this month has a calendar.";
  }
  paintMiniMonth(year, month);
  ensureCalendarGrid(year, month);
  paintCalendarFocus(year, month);
}
function prepareCalendarLoad(account, preferCache) {
  const request = beginCalendarRequest(account);
  const freshHit = !!(preferCache && request.cached && Date.now() - request.cached.at < 60000 && !calendarPending.has(request.key));
  const keepMonth = calendarKeepsMonth(request.cached);
  if (state.view !== "calendar") return Object.assign({}, request, { freshHit, keepMonth });
  if (freshHit) {
    setPageBusy("calendar-panel", false);
    return Object.assign({}, request, { freshHit, keepMonth });
  }
  if (!keepMonth) paintCalendarShell();
  setPageBusy("calendar-panel", true, calendarBusyLabel(keepMonth));
  return Object.assign({}, request, { freshHit, keepMonth });
}
function rememberCalendar(key, payload) {
  calendarCache.delete(key);
  calendarCache.set(key, { payload, at: Date.now() });
  while (calendarCache.size > 8) calendarCache.delete(calendarCache.keys().next().value);
}
function calendarIdsFromPayload(payload) {
  const ids = [];
  const rows = Array.isArray(payload && payload.calendarIds) ? payload.calendarIds : [];
  for (const row of rows) {
    const id = String(row || "");
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length) return ids;
  const single = payload && payload.calendarId ? String(payload.calendarId) : "";
  return single ? [single] : [];
}

function applyCalendarPayload(payload) {
  const returned = calendarIdsFromPayload(payload);
  if (returned.length) {
    state.calendarIds = returned;
    if (!returned.includes(state.calendarId)) state.calendarId = returned[0];
    saveCalendarChecks((payload && payload.accountId) || state.calendarAccountId, returned);
  }
  if (!(payload?.events || []).some((event) => calendarEventKey(event) === state.calendarEventId)) state.calendarEventId = "";
  state.calendarPayload = payload;
  if (state.view === "calendar") paintCalendar(payload);
}

async function loadCalendar({ preferCache = false, fresh = false } = {}) {
  const gen = ++calendarGen;
  fillCalendarAccounts();
  const account = calendarAccount();
  if (!account) {
    calendarCache.clear();
    setPageBusy("calendar-panel", false);
    applyCalendarPayload({ api: false, reason: "no_account", events: [], calendars: [] });
    return;
  }
  const revision = calendarRevisions.get(account.id) || 0;
  const plan = prepareCalendarLoad(account, preferCache);
  const { range, requestedIds, key, cached } = plan;
  if (cached) applyCalendarPayload(cached.payload);
  if (plan.freshHit) return;
  // Status does not gate the event list. Coalesce this account-wide read too.
  if (!calendarStatusPending) calendarStatusPending = call("calendar:status").finally(() => { calendarStatusPending = null; });
  calendarStatusPending.then(status => {
    if (gen !== calendarGen || calendarAccount()?.id !== account.id) return;
    state.calendarStatus = status;
    const connection = calendarConnection(status, calendarAccount(), state.calendarPayload, calendarAuthFailures.has(account.id));
    $("calendar-grant").disabled = !connection.canGrant;
    $("calendar-grant").textContent = connection.label;
    $("calendar-grant").title = connection.reason;
  }).catch(() => {});
  try {
    if (fresh || !calendarPending.has(key)) {
      const body = { accountId: account.id, timeMin: range.timeMin, timeMax: range.timeMax };
      if (requestedIds.length) body.calendarIds = requestedIds;
      const pending = call("calendar:list", body).finally(() => {
        if (calendarPending.get(key) === pending) calendarPending.delete(key);
      });
      calendarPending.set(key, pending);
    }
    const payload = await calendarPending.get(key);
    if (gen !== calendarGen || calendarAccount()?.id !== account.id || revision !== (calendarRevisions.get(account.id) || 0)) return;
    if (payload?.api) calendarAuthFailures.delete(account.id);
    applyCalendarPayload(payload);
    rememberCalendar(key, payload);
    rememberCalendar(calendarCacheKey(account, range, state.calendarIds), payload);
  } catch (error) {
    if (gen !== calendarGen || calendarAccount()?.id !== account.id || revision !== (calendarRevisions.get(account.id) || 0)) return;
    const message = error instanceof Error ? error.message : String(error);
    recordCalendarAuthFailure(account.id, error);
    if (cached?.payload?.api) {
      $("calendar-status").textContent = "Could not refresh. Showing the saved month. " + message;
      $("calendar-status").classList.add("error");
    } else applyCalendarPayload({ api: false, reason: "error", message, events: [], calendars: [] });
  } finally {
    if (gen === calendarGen) setPageBusy("calendar-panel", false);
  }
}

function showMail() {
  showPrimary("mail", "shell");
}

let calendarOpenScheduled = false;
function showCalendar() {
  if (!state.calendarCursor) state.calendarCursor = new Date();
  const account = calendarAccount();
  if ((account?.id || "") !== calendarPaintedAccountId) {
    closeDialog("calendar-event-dialog");
    const detail = $("calendar-detail");
    if (detail) detail.hidden = true;
  }
  fillCalendarAccounts();
  showPrimary("calendar", "calendar-panel");
  if (account) prepareCalendarLoad(account, true);
  else setPageBusy("calendar-panel", false);
  if (calendarOpenScheduled) return;
  calendarOpenScheduled = true;
  afterPaint(() => {
    calendarOpenScheduled = false;
    if (state.view === "calendar") loadCalendar({ preferCache: true }).catch(error => showStatus(error.message, true));
    else setPageBusy("calendar-panel", false);
  });
}

async function grantCalendar() {
  const account = calendarAccount();
  if (!account) throw new Error("Connect a Google or Microsoft mailbox first.");
  showStatus("Enabling mailbox features…");
  try {
    const saved = await call("calendar:connect", { accountId: account.id,
      ...(calendarAuthFailures.has(account.id) ? { forceReauthorize: true } : {}) });
    const outcome = grantApiOutcome(saved, "Calendar connected.", "Approve mailbox feature permissions in your browser.");
    if (!outcome.ok) throw new Error(outcome.message);
    calendarAuthFailures.delete(account.id);
    showStatus(outcome.message);
  } finally {
    await loadCalendar({ fresh: true });
  }
}

async function submitCalendarForm(event) {
  event.preventDefault();
  const generation = calendarEditorGeneration;
  const accountId = calendarAccount()?.id;
  return guard(async () => {
    try {
      await submitCalendarEvent(event);
    } catch (error) {
      if (generation !== calendarEditorGeneration || calendarAccount()?.id !== accountId
          || !$("calendar-event-dialog").open) return;
      const status = $("calendar-form-status");
      status.textContent = (error instanceof Error ? error.message : String(error)) + " Your changes are still here.";
      status.classList.add("error");
      status.focus();
    }
  });
}

async function submitCalendarEvent(event) {
  event.preventDefault();
  if (calendarWritePending) throw new Error("A calendar change is still being confirmed.");
  const account = calendarAccount();
  const editing = calendarEditingId;
  const identity = calendarEditingIdentity;
  const generation = calendarEditorGeneration;
  if (editing && (!identity || identity.id !== editing || identity.accountId !== account?.id)) {
    throw new Error("The calendar account changed. Reopen the event before saving it.");
  }
  const title = $("calendar-event-title").value;
  const unchangedTime = !!editing && JSON.stringify(identity.timeInputs) === JSON.stringify([
    $("calendar-start").value, $("calendar-end").value, !!$("calendar-all-day").checked]);
  if (editing && identity.titleTruncated && title !== identity.title) {
    throw new Error("This title is incomplete. Leave it unchanged or edit it with the calendar provider.");
  }
  const draft = calendarDraft({
    accountId: account && account.id,
    calendarId: editing ? identity.calendarId : ($("calendar-pick") && $("calendar-pick").value) || state.calendarId,
    title,
    location: $("calendar-location").value,
    description: $("calendar-description") ? $("calendar-description").value : "",
    allDay: !!($("calendar-all-day") && $("calendar-all-day").checked),
    start: $("calendar-start").value,
    end: $("calendar-end").value,
    eventId: editing,
  }, !!editing && title === identity.title, unchangedTime);
  const status = $("calendar-form-status");
  if (draft.error) {
    if (status) {
      status.textContent = draft.error;
      status.classList.add("error");
    }
    throw new Error(draft.error);
  }
  if (editing) {
    if (draft.description === identity.description.trim()) delete draft.description;
    else {
      if (identity.descriptionTruncated) throw new Error("This description is incomplete. Leave it unchanged or edit it in Google Calendar.");
      draft.descriptionBase = identity.description;
    }
    if (draft.location === identity.location.trim()) delete draft.location;
  } else {
    const fingerprint = JSON.stringify(draft);
    if (calendarCreateAttempt && calendarCreateAttempt.fingerprint !== fingerprint) {
      throw new Error("The earlier creation may already exist. Restore the submitted fields to retry safely, or check the provider before starting another event.");
    }
    if (!calendarCreateAttempt) {
      const uuid = (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : (typeof window !== "undefined" && window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : ""));
      const operationId = (uuid && String(uuid).replace(/-/g, ""))
        || Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      calendarCreateAttempt = { operationId, fingerprint };
    }
    draft.operationId = calendarCreateAttempt.operationId;
  }
  if (status) {
    status.textContent = "";
    status.classList.remove("error");
  }
  calendarWritePending = true;
  try {
    if (editing) await call("calendar:updateEvent", draft);
    else await call("calendar:createEvent", draft);
  } catch (error) {
    const refused = recordCalendarAuthFailure(account.id, error) || ["invalid", "oauth_not_ready", "imap_only", "no_account"].includes(error.code);
    if (!editing && refused && generation === calendarEditorGeneration) calendarCreateAttempt = null;
    throw error;
  } finally { calendarWritePending = false; }
  invalidateCalendarAccount(account.id);
  if (generation !== calendarEditorGeneration || calendarAccount()?.id !== account.id) {
    if (state.view === "calendar" && calendarAccount()?.id === account.id && !$("calendar-event-dialog").open) {
      await loadCalendar({ fresh: true });
    }
    return;
  }
  if (draft.calendarId && !state.calendarIds.includes(draft.calendarId)) {
    state.calendarIds = state.calendarIds.concat(draft.calendarId);
    state.calendarId = draft.calendarId;
    saveCalendarChecks(account && account.id, state.calendarIds);
  }
  calendarEditingId = "";
  calendarEditingIdentity = null;
  closeDialog("calendar-event-dialog");
  showStatus("Event saved on the calendar.");
  await loadCalendar({ fresh: true });
}

function shiftMonth(delta) {
  const cursor = state.calendarCursor || new Date();
  state.calendarCursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
  state.calendarFocusDay = "";
  loadCalendar().catch((error) => showStatus(error.message, true));
}

function showCalendarToday() {
  const now = new Date();
  state.calendarCursor = now;
  state.calendarFocusDay = localDateStamp(now);
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
  $("oauth-google").title = google.reason;
  paintConnectPending();
}

const BOT_FIELD_IDS = ["bot-label", "bot-accounts", "bot-serve-host"];

function botFieldForError(message) {
  const text = String(message || "");
  if (/name the client|client name|1 to 60 characters/i.test(text)) return "bot-label";
  if (/choose a connected account|connect an account|at least one mailbox/i.test(text)) return "bot-accounts";
  if (/serve host|save an address first|hostname and optional port|address is too long/i.test(text)) return "bot-serve-host";
  return "";
}

function setBotStatus(text, isError) {
  const status = $("bot-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("error", !!isError && !!text);
  clearFieldErrors(BOT_FIELD_IDS);
  if (isError && text) {
    const field = botFieldForError(text);
    if (field) setFieldError(field, text);
  }
}

function clearBotSecret() {
  const value = $("bot-secret-value");
  if (value) value.textContent = "";
  $("bot-secret-status").textContent = "";
}

function setBotSecretStatus(text, isError) {
  $("bot-secret-status").textContent = text;
  $("bot-secret-status").classList.toggle("error", !!isError);
}

function showBotSecret(secret) {
  $("bot-secret-value").textContent = secret || "";
  setBotSecretStatus("Copy now, then close this dialog to turn on access or refresh the listener.");
  openDialog("bot-secret");
}

let botAccessVersion = 0;
async function loadBotAccess() {
  const version = botAccessVersion;
  const data = await call("bot:getAccess");
  if (version !== botAccessVersion) return state.botAccess;
  paintBotAccess(data);
  return data;
}

function botIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const paths = {
    refresh: [
      ["polyline", { points: "23 4 23 10 17 10" }],
      ["polyline", { points: "1 20 1 14 7 14" }],
      ["path", { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" }],
    ],
    x: [
      ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
      ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }],
    ],
    trash: [
      ["polyline", { points: "3 6 5 6 21 6" }],
      ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
      ["line", { x1: "10", y1: "11", x2: "10", y2: "17" }],
      ["line", { x1: "14", y1: "11", x2: "14", y2: "17" }],
    ],
    mail: [
      ["path", { d: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" }],
      ["polyline", { points: "22,6 12,13 2,6" }],
    ],
  };
  for (const [tag, attrs] of paths[name] || []) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}

function paintBotAccounts(accounts) {
  const box = $("bot-accounts");
  box.replaceChildren();
  const legend = document.createElement("legend");
  legend.textContent = "Allow access to";
  box.append(legend);
  if (!accounts.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Connect an account before creating a bot.";
    box.append(empty);
    return;
  }
  for (const account of accounts) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.accountId;
    const name = account.displayName ? `${account.displayName} · ${account.email}` : (account.email || account.accountId);
    label.append(input, document.createTextNode(` ${name}`));
    box.append(label);
  }
}

function botPermissionNames(capabilities) {
  const names = { "accounts.read": "account details", "mail.headers.read": "cached mail headers",
    "health.read": "sync health", "agent.proposals.read": "pending proposals", "mail.bodies.read": "message text",
    "mail.attachments.read": "attachment names", "draft.proposals.create": "draft proposals",
    "mail.send": "send mail as you" };
  return (capabilities || []).map((cap) => names[cap] || cap).join(", ");
}

function botListenerStatus(access) {
  const listen = (access && access.listen) || {};
  const where = "This is the listener on this computer.";
  if (listen.listening) return `${where} Listening on ${listen.address || "127.0.0.1"}:${listen.port || 47831}.`;
  if (listen.error === "port_in_use") return `${where} Could not start: port 47831 is in use. Bot access is not listening. Quit the other program using port 47831, or restart Morrow.`;
  if (listen.error) return `${where} Could not start. Bot access is not listening. ${listen.error}`;
  return `${where} Bot access is not listening.`;
}

function paintBotGrants(grants) {
  const list = $("bot-grants");
  list.replaceChildren();
  if (!grants.length) {
    const item = document.createElement("li");
    item.textContent = "No bots yet.";
    list.append(item);
    return;
  }
  for (const grant of grants) {
    const item = document.createElement("li");
    item.className = "bot-grant";
    const title = document.createElement("p");
    const when = grant.revokedAt ? "revoked" : (grant.expired ? "expired" : "access valid");
    title.textContent = `${grant.label} · ${when}`;
    const meta = document.createElement("p");
    meta.className = "hint";
    const accounts = (state.botAccess && state.botAccess.accounts) || [];
    const names = (grant.accountIds || []).map((id) => {
      const account = accounts.find((row) => row.accountId === id);
      return account ? account.email || account.displayName : "Disconnected mailbox";
    });
    const expiryAt = new Date(grant.expiry && grant.expiry.expiresAt);
    const expiryText = grant.expiry && grant.expiry.kind === "never"
      ? "No expiry"
      : "Expires " + (shownWhen(expiryAt) || "Unknown time");
    meta.textContent = `${names.join(", ")} · ${botPermissionNames(grant.capabilities)} · ${expiryText}`;
    const used = document.createElement("p");
    used.className = "hint";
    used.textContent = grant.lastUsedAt
      ? `Last successful use ${shownWhen(new Date(grant.lastUsedAt)) || "Unknown time"}. ${grant.bytesToday || 0} bytes today.`
      : "No successful bot use recorded.";
    const row = document.createElement("div");
    row.className = "row";
    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = "ghost icon-label";
    rotate.append(botIcon("refresh"), document.createElement("span"));
    rotate.lastChild.textContent = "Replace secret…";
    rotate.title = "The current secret will stop working immediately.";
    rotate.disabled = !!grant.revokedAt || !!grant.expired;
    rotate.addEventListener("click", () => {
      botGuard(async () => {
        const answer = await askConfirm({ title: "Replace secret for " + grant.label + "?",
          body: "The current secret will stop working immediately. Copy the replacement once and update the bot’s private credential file.", confirm: "Replace secret", cancel: "Cancel" });
        if (!answer || !answer.ok) return;
        const rotated = await call("bot:rotateGrant", { clientId: grant.clientId });
        showBotSecret(rotated.secret);
        paintBotAccess(rotated.access);
        setBotStatus("Rotated. The previous secret stopped working.");
      });
    });
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "ghost icon-label";
    revoke.append(botIcon("x"), document.createElement("span"));
    revoke.lastChild.textContent = "Revoke";
    revoke.disabled = !!grant.revokedAt;
    revoke.title = "Invalidate the secret and stop this bot’s access. The row stays.";
    revoke.addEventListener("click", () => {
      botGuard(async () => {
        paintBotAccess(await call("bot:revokeGrant", { clientId: grant.clientId }));
        setBotStatus(`Access revoked for ${grant.label}. The secret no longer works. Other bots are unchanged.`);
      }, true);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost icon-label";
    remove.dataset.botAction = "delete";
    remove.append(botIcon("trash"), document.createElement("span"));
    remove.lastChild.textContent = "Delete";
    remove.title = "Remove this bot from the list after you confirm.";
    remove.addEventListener("click", () => {
      botGuard(async () => {
        const answer = await askConfirm({
          title: "Delete " + grant.label + "?",
          body: "This removes the bot from your list. Its secret stops working immediately. This cannot be undone.",
          confirm: "Delete bot",
          cancel: "Cancel",
        });
        if (!answer || !answer.ok) return;
        paintBotAccess(await call("bot:deleteGrant", { clientId: grant.clientId }));
        setBotStatus(`Deleted ${grant.label}. Its secret no longer works.`);
      }, true);
    });
    row.append(rotate, revoke, remove);
    item.append(title, meta, used, row);
    list.append(item);
  }
}

function paintBotDrafts(rows) {
  const list = $("bot-drafts");
  list.replaceChildren();
  if (!rows) {
    const item = document.createElement("li");
    item.textContent = "Draft proposals cannot be read.";
    list.append(item);
    return;
  }
  if (!rows.length) {
    const item = document.createElement("li");
    item.textContent = "No draft proposals waiting.";
    list.append(item);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("li");
    item.className = "bot-draft";
    const title = document.createElement("p");
    title.textContent = `${row.subject || "(no subject)"} · ${row.status}`;
    const to = document.createElement("p");
    to.className = "hint";
    to.textContent = `To ${(row.to || []).join(", ")}`;
    const body = document.createElement("pre");
    body.textContent = row.bodyText || "";
    const actions = document.createElement("div");
    actions.className = "row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ghost icon-label";
    open.append(botIcon("mail"), document.createElement("span"));
    open.lastChild.textContent = "Open in compose";
    open.addEventListener("click", () => {
      botGuard(() => openBotDraft(row.proposalId));
    });
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ghost icon-label";
    dismiss.append(botIcon("x"), document.createElement("span"));
    dismiss.lastChild.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      botGuard(async () => {
        paintBotAccess(await call("bot:dismissDraftProposal", { proposalId: row.proposalId }));
        setBotStatus("Draft proposal dismissed. Nothing was sent.");
      });
    });
    actions.append(open, dismiss);
    item.append(title, to, body, actions);
    list.append(item);
  }
}

function paintBotAudit(rows) {
  const list = $("bot-audit");
  if (!list || typeof list.replaceChildren !== "function") return;
  list.replaceChildren();
  const items = rows || [];
  if (!items.length) {
    const item = document.createElement("li");
    item.textContent = "No recent bot calls.";
    list.append(item);
    return;
  }
  for (const row of items) {
    const item = document.createElement("li");
    const audit = row.auditId ? `${row.auditId} · ` : "";
    item.textContent = `${audit}${row.at || ""} · ${row.operation || "call"} · ${row.code || "ok"} · ${row.accountId || "no account"}`;
    list.append(item);
  }
}

function paintBotSends(rows) {
  const list = $("bot-sends");
  if (!list || typeof list.replaceChildren !== "function") return;
  list.replaceChildren();
  const items = rows || [];
  if (!items.length) {
    const item = document.createElement("li");
    item.textContent = "No send receipts.";
    list.append(item);
    return;
  }
  for (const row of items) {
    const item = document.createElement("li");
    const to = row.recipientSummary && row.recipientSummary.to ? row.recipientSummary.to.join(", ") : "";
    item.textContent = `${row.auditId || ""} · ${row.state || ""} · ${row.accountId || ""} · ${to} · ${row.subject || ""} · ${row.claimedAt || ""} · ${row.finishedAt || ""}` + (row.warning ? " · " + row.warning : "");
    list.append(item);
  }
}

function paintBotAccess(data) {
  ++botAccessVersion;
  const access = data || {};
  state.botAccess = access;
  $("bot-listen").textContent = botListenerStatus(access);
  const listenFix = $("bot-listen-fix");
  if (listenFix) listenFix.hidden = !(access.listen && access.listen.error === "port_in_use");
  $("bot-intent").textContent = access.enabled
    ? "Access on this computer: on. This is separate from the listener status above."
    : "Access on this computer: off.";
  $("bot-retry").hidden = !access.enabled || !!(access.listen && access.listen.listening);
  $("bot-review-link").textContent = "Review draft proposals (" + ((access.drafts || []).length) + ")";
  $("bot-install").textContent = access.installationId
    ? `Installation id ${access.installationId}`
    : "The installation id appears after you create the first bot.";
  const grants = access.grants || [];
  const live = grants.some((grant) => grant.live);
  const setup = $("bot-add-client");
  if (!setup.dataset.initialized) {
    setup.open = !live;
    setup.dataset.initialized = "true";
  }
  const endpoints = access.endpoints || {};
  $("bot-local-endpoint").textContent = endpoints.local
    ? `Address on this computer ${endpoints.local}`
    : "";
  $("bot-endpoint").textContent = endpoints.serve
    ? `HTTPS address ${endpoints.serve}`
    : "Save an address and port to see the HTTPS address.";
  $("bot-marker").textContent = access.markerJson
    ? `Capability marker ${access.markerJson}`
    : "";
  const enabled = $("bot-enabled");
  enabled.checked = access.enabled === true;
  enabled.disabled = access.enabled !== true && !live;
  $("bot-enable-help").textContent = live ? "Copy the secret before turning this on. Turning it on does not create the address other devices use." : "Create a bot that has not expired first. The listener stays on this computer only.";
  const hostField = $("bot-serve-host");
  if (typeof document === "undefined" || document.activeElement !== hostField) {
    hostField.value = access.serveHost || "";
  }
  paintBotAccounts(access.accounts || []);
  paintBotGrants(grants);
  paintBotDrafts(access.draftsAvailable === false ? null : (access.drafts || []));
  if (typeof paintBotAudit === "function") paintBotAudit(access.audit || []);
  if (typeof paintBotSends === "function") paintBotSends(access.sends || []);
  paintBotProbe(access);
}

function botServeCommands(serveHost) {
  const host = String(serveHost || "").trim();
  const match = /:([0-9]{1,5})$/.exec(host);
  let port = 8443;
  if (match) {
    const parsed = Number(match[1]);
    if (parsed >= 1 && parsed <= 65535) port = parsed;
  }
  return {
    port,
    status: "tailscale serve status",
    serve: `tailscale serve --bg --https=${port} --accept-app-caps=com.coke1120.morrow-mail/bot-access http://127.0.0.1:47831`,
  };
}

function botProbeReason(reason) {
  if (reason === "timeout") return "The address did not answer in time.";
  if (reason === "tls") return "The certificate check failed.";
  if (reason === "unreachable") return "Morrow could not open a connection.";
  if (reason === "unsafe") return "Morrow will not check this address.";
  if (reason === "inconclusive") return "The answer was not clear enough to call it Morrow or another app.";
  if (reason === "no_host") return "Save an address first.";
  return "Morrow could not check this address.";
}

function syncBotProbe(access) {
  const host = (access && access.serveHost) || "";
  if (!state.botProbe || state.botProbe.host !== host) {
    state.botProbe = { host, state: "not_checked", checked: false, reason: "", snippet: "", statusCode: null };
  }
}

function botRemoteStatusText(access) {
  const host = access && access.serveHost;
  const probe = state.botProbe;
  if (!host) return "No address saved yet. Not checked.";
  if (!probe || probe.host !== host || !probe.checked) return "Not checked. Saving an address does not set up the secure link.";
  if (probe.state === "foreign") return "Another app is using this address.";
  if (probe.state === "morrow") return "This address answered like Morrow’s bot listener. Saving the address did not set up the secure link.";
  return `Not checked. ${botProbeReason(probe.reason)}`;
}

function setBotButtonLabel(button, label) {
  if (!button) return;
  const span = button.querySelector && button.querySelector("span");
  if (span) span.textContent = label;
  else button.textContent = label;
}

function paintBotCommands(access) {
  const saved = access && access.serveCommands;
  const commands = saved && saved.serve && saved.status ? saved : botServeCommands(access && access.serveHost);
  for (const id of ["bot-cmd-status", "bot-fix-status"]) {
    const node = $(id);
    if (node) node.textContent = commands.status;
  }
  for (const id of ["bot-cmd-serve", "bot-fix-serve"]) {
    const node = $(id);
    if (node) node.textContent = commands.serve;
  }
}

function paintBotProbe(access) {
  syncBotProbe(access);
  const probe = state.botProbe || {};
  const remote = $("bot-remote-status");
  if (remote) remote.textContent = botRemoteStatusText(access);
  paintBotCommands(access);
  const foreign = !!(probe.checked && probe.state === "foreign");
  const box = $("bot-probe-conflict");
  if (box) box.hidden = !foreign;
  const saw = $("bot-probe-saw");
  if (saw) {
    const snippet = probe.snippet || "a response that is not Morrow’s bot listener";
    saw.textContent = foreign ? `Morrow asked the saved address and saw ${snippet}.` : "";
  }
  setBotButtonLabel($("bot-probe"), probe.checked ? "Check again" : "Check connection");
}

async function openBotDraft(proposalId) {
  const seed = await call("bot:draftComposeSeed", { proposalId });
  await presentCompose({
    accountId: seed.accountId,
    to: seed.to,
    cc: seed.cc,
    bcc: seed.bcc,
    subject: seed.subject,
    body: seed.body,
    title: "Review draft",
    botDraft: {
      proposalId: seed.proposalId,
      accountId: seed.accountId,
      to: seed.to,
      cc: seed.cc,
      bcc: seed.bcc,
      subject: seed.subject,
      body: seed.body,
    },
  });
  setBotStatus("Opened in compose. Nothing is sent until you press Send.");
}

let botBusy = false;
let botStatusBusy = false;
let botMutationCount = 0;
let botMutationQueue = Promise.resolve();
function botGuard(fn, mutation) {
  if (!mutation && botBusy) return Promise.resolve();
  if (mutation) botMutationCount += 1;
  else botStatusBusy = true;
  botBusy = true;
  const pending = (mutation ? botMutationQueue : Promise.resolve())
    .then(fn)
    .catch((error) => {
      setBotStatus(error instanceof Error ? error.message : String(error), true);
    })
    .finally(() => {
      if (mutation) botMutationCount -= 1;
      else botStatusBusy = false;
      botBusy = botStatusBusy || botMutationCount > 0;
    });
  if (mutation) botMutationQueue = pending;
  return pending;
}

function selectedBotAccounts() {
  return [...$("bot-accounts").querySelectorAll("input:checked")].map((input) => input.value);
}

function selectedBotCaps() {
  const caps = ["accounts.read", "mail.headers.read", "health.read", "agent.proposals.read"];
  for (const input of $("bot-caps").querySelectorAll("input")) {
    if (input.checked && input.dataset.cap) caps.push(input.dataset.cap);
  }
  return caps;
}

function selectedBotAccountLabels() {
  const accounts = (state.botAccess && state.botAccess.accounts) || [];
  return selectedBotAccounts().map((id) => {
    const account = accounts.find((row) => row.accountId === id);
    return account ? (account.email || account.displayName || id) : id;
  });
}

// The send permission is confirmed against the exact mailbox list, not a generic warning.
function botSendConfirmCopy(labels) {
  const list = labels && labels.length ? labels.join(", ") : "the mailboxes you select";
  return {
    title: "Allow this bot to send mail?",
    body: `This bot can send mail as you from ${list}. It sends immediately and does not wait for you to press Send. Message text from those mailboxes stays untrusted.`,
    confirm: "Allow sending",
    cancel: "Cancel",
  };
}

function showBotSection(name) {
  const nav = $("bot-sections");
  if (!nav) return;
  const tabs = [...nav.querySelectorAll('[role="tab"]')];
  const known = tabs.some((tab) => tab.dataset.botSection === name);
  if (!known) return;
  for (const tab of tabs) {
    const active = tab.dataset.botSection === name;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    const panel = $(tab.getAttribute("aria-controls"));
    if (!panel) continue;
    const show = active;
    const wasHidden = panel.hidden;
    panel.hidden = !show;
    if (show && wasHidden) {
      const motion = motionApi();
      if (motion && motion.fadePane) motion.fadePane(panel, "y");
    }
  }
}

function botSetupChoice() {
  const picked = document.querySelector('input[name="bot-setup-target"]:checked');
  return picked && picked.value === "serve" ? "serve" : "local";
}

function wireBotSections() {
  const nav = $("bot-sections");
  if (!nav || nav.dataset.wired === "1") return;
  nav.dataset.wired = "1";
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest && event.target.closest('[role="tab"]');
    if (!tab || !nav.contains(tab)) return;
    showBotSection(tab.dataset.botSection);
    tab.focus({ preventScroll: true });
  });
  nav.addEventListener("keydown", (event) => {
    const tabs = [...nav.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    showBotSection(tabs[next].dataset.botSection);
    tabs[next].focus({ preventScroll: true });
  });
}

function wireBot() {
  wireBotSections();
  $("bot-review-link").addEventListener("click", () => {
    showBotSection("activity");
    $("bot-review").open = true;
    $("bot-draft-heading").scrollIntoView({ block: "center" });
    $("bot-draft-heading").focus({ preventScroll: true });
  });
  $("bot-copy-setup").addEventListener("click", () => botGuard(async () => {
    const text = await call("bot:setupText", { target: botSetupChoice() });
    if (!navigator.clipboard) {
      setBotStatus("Could not copy the setup prompt.", true);
      return;
    }
    await navigator.clipboard.writeText(text.prompt);
    setBotStatus("Setup prompt copied.");
  }));
  $("bot-download-skill").addEventListener("click", () => botGuard(async () => {
    const text = await call("bot:setupText", { target: botSetupChoice() });
    const blob = new Blob([text.skillMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "SKILL.md";
    link.click();
    URL.revokeObjectURL(url);
    setBotStatus("SKILL.md downloaded.");
  }));
  $("bot-verify").addEventListener("click", () => botGuard(async () => {
    const access = await loadBotAccess();
    setBotStatus(botListenerStatus(access), !!(access.listen && access.listen.error));
  }));
  $("bot-retry").addEventListener("click", () => botGuard(async () => {
    const access = await call("bot:setEnabled", { enabled: true });
    paintBotAccess(access);
    setBotStatus(botListenerStatus(access), !(access.listen && access.listen.listening));
  }, true));
  $("bot-enabled").addEventListener("change", () => {
    const want = $("bot-enabled").checked === true;
    botGuard(async () => {
      try {
        const access = await call("bot:setEnabled", { enabled: want });
        paintBotAccess(access);
        setBotStatus(want ? botListenerStatus(access) : "Bot access off. New bot calls are blocked; saved grants are retained.", want && !(access.listen && access.listen.listening));
      } catch (error) {
        await loadBotAccess().catch(() => {});
        throw error;
      }
    }, true);
  });
  $("bot-serve-save").addEventListener("click", () => {
    botGuard(async () => {
      paintBotAccess(await call("bot:setServeHost", { serveHost: $("bot-serve-host").value }));
      setBotStatus("Address saved. This does not set up the secure link.");
    });
  });
  $("bot-panel-tailscale").addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest("[data-copy-command]");
    if (!button || !$("bot-panel-tailscale").contains(button)) return;
    const kind = button.dataset.copyCommand === "status" ? "status" : "serve";
    botGuard(async () => {
      const access = state.botAccess || {};
      const saved = access.serveCommands;
      const commands = saved && saved.serve && saved.status ? saved : botServeCommands(access.serveHost);
      const text = kind === "status" ? commands.status : commands.serve;
      if (!text || !navigator.clipboard) {
        setBotStatus("Could not copy. Select the command and copy it.", true);
        return;
      }
      await navigator.clipboard.writeText(text);
      setBotStatus(kind === "status"
        ? "Status command copied. Morrow did not run it."
        : "Morrow command copied. Morrow did not run it.");
    });
  });
  $("bot-probe").addEventListener("click", () => botGuard(async () => {
    const access = state.botAccess || {};
    if (!access.serveHost) {
      state.botProbe = { host: "", state: "not_checked", checked: true, reason: "no_host", snippet: "" };
      paintBotProbe(access);
      setBotStatus("Save an address first. Not checked.");
      return;
    }
    setBotStatus("Checking the saved address…");
    const result = await call("bot:probeServe");
    const stateName = result && (result.state === "foreign" || result.state === "morrow") ? result.state : "not_checked";
    state.botProbe = {
      host: access.serveHost,
      checked: true,
      state: stateName,
      reason: (result && result.reason) || "",
      snippet: (result && result.snippet) || "",
      statusCode: result && result.statusCode,
    };
    paintBotProbe(access);
    if (stateName === "foreign") setBotStatus("Another app is using this address. Follow the fix steps, then check again.", true);
    else if (stateName === "morrow") setBotStatus("This address answered like Morrow’s bot listener. This check did not set up the secure link.");
    else setBotStatus(botRemoteStatusText(access));
  }));
  $("bot-mint").addEventListener("submit", (event) => {
    event.preventDefault();
    botGuard(async () => {
      const accountIds = selectedBotAccounts();
      if (!accountIds.length) {
        setBotStatus("Choose at least one mailbox for this bot.", true);
        return;
      }
      const capabilities = selectedBotCaps();
      const choice = $("bot-expiry").value;
      let expiry;
      if (choice === "never") {
        const answer = await askConfirm({
          title: "No expiry",
          body: "This bot keeps access until you revoke it. Continue only if you can turn off that bot.",
          confirm: "Create bot",
          cancel: "Cancel",
        });
        if (!answer || !answer.ok) return;
        expiry = { kind: "never", neverConfirmed: true };
      } else {
        expiry = { kind: "finite", days: Number(choice) };
      }
      if (capabilities.includes("mail.send")) {
        const answer = await askConfirm(botSendConfirmCopy(selectedBotAccountLabels()));
        if (!answer || !answer.ok) return;
      }
      const minted = await call("bot:mintGrant", {
        label: $("bot-label").value,
        accountIds,
        capabilities,
        expiry,
      });
      showBotSecret(minted.secret);
      paintBotAccess(minted.access);
      $("bot-label").value = "";
      const access = minted.access || {};
      setBotStatus("Bot created. " + (access.listen && access.listen.listening ? "Bot access is already on." : access.enabled ? "Access is set to on, but the listener is not running." : "Access is still off."));
    });
  });
  $("bot-secret-copy").addEventListener("click", () => {
    const value = $("bot-secret-value").textContent;
    if (!value || !navigator.clipboard) {
      setBotSecretStatus("Could not copy. Select and copy the secret here before closing.", true);
      return;
    }
    navigator.clipboard.writeText(value).then(() => {
      setBotSecretStatus("Copied. Close this dialog, then turn on access or refresh the listener.");
    }).catch(() => {
      setBotSecretStatus("Could not copy. Select and copy the secret here before closing.", true);
    });
  });
  $("bot-secret-close").addEventListener("click", () => closeDialog("bot-secret"));
  $("bot-secret").addEventListener("close", clearBotSecret);
  for (const id of ["compose-to", "compose-cc", "compose-bcc", "compose-subject", "compose-body"]) {
    $(id).addEventListener("input", () => {
      if (id === "compose-body" && state.draftWrite && !state.draftWrite.pending) state.draftWrite = null;
      paintComposeNote();
    });
  }
}

function senderHistoryApi() {
  return typeof window !== "undefined" ? window.morrowSenderHistory : null;
}

function paintSenderAddress(node, from) {
  const header = String(from || "");
  const history = senderHistoryApi();
  if (!node) return;
  if (!history || typeof history.senderHeader !== "function") {
    node.textContent = header;
    return;
  }
  const parsed = history.senderHeader(header);
  if (!parsed.address) {
    node.textContent = header;
    return;
  }
  node.replaceChildren();
  if (parsed.displayName) node.appendChild(document.createTextNode(parsed.displayName + " "));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sender-address";
  button.dataset.senderAddress = parsed.address;
  button.setAttribute("aria-label", "Previous emails from " + parsed.address);
  button.textContent = parsed.address;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    openSenderHistory(parsed.address);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSenderAddressMenu(parsed.address, event.clientX, event.clientY);
  });
  node.appendChild(button);
}

function openSenderAddressMenu(address, x, y) {
  const menu = ensureOrganizeMenu();
  menu.setAttribute("aria-label", "Previous emails");
  menu.replaceChildren();
  appendMenuAction(menu, "Previous emails…", () => openSenderHistory(address));
  placeMenu(menu, x, y);
}

let senderHistoryGen = 0;
let senderHistoryView = null;

function senderWhen(value) {
  const date = value ? new Date(value) : null;
  return shownWhen(date);
}

function senderAccountLabel(account) {
  return accountLabel({
    id: account && account.accountId,
    email: account && account.email,
    label: account && account.label,
    name: account && account.name,
  });
}

function toastSenderFailures(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const auth = list.find((row) => row && row.status === "auth");
  if (auth) {
    showStatus("Sign in again to search " + senderAccountLabel(auth) + ".", true);
    return;
  }
  const limited = list.find((row) => row && row.status === "rate_limit");
  if (limited) {
    showStatus("Paused for rate limit", true);
    return;
  }
  const failed = list.find((row) => row && row.status === "error");
  if (failed) showStatus(failed.message || "Previous mail could not be loaded.", true);
}

function senderChipText(account) {
  const status = account && account.status;
  if (status === "auth") return "Sign in again";
  if (status === "rate_limit") return "Paused for rate limit";
  if (status === "unavailable") return "Unavailable";
  if (status === "error") return account.message || "Could not search";
  return "";
}

function paintSenderChips(host) {
  host.replaceChildren();
  const accounts = (senderHistoryView && senderHistoryView.accounts) || [];
  for (const account of accounts) {
    if (!account || !account.status || account.status === "ok") continue;
    const chip = document.createElement("div");
    chip.className = "sender-history-chip";
    const label = document.createElement("span");
    label.textContent = senderAccountLabel(account) + " · " + senderChipText(account);
    chip.appendChild(label);
    if (account.status === "auth" || account.status === "rate_limit" || account.status === "error") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => retrySenderAccount(account.accountId));
      chip.appendChild(retry);
    }
    host.appendChild(chip);
  }
}

function senderHistoryRow(row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sender-history-row" + (row.unread ? " unread" : "");
  if (row.current) button.setAttribute("aria-current", "true");
  const read = row.unread ? "Unread" : "Read";
  const subject = row.subject || "(no subject)";
  const when = senderWhen(row.date);
  const account = ((senderHistoryView && senderHistoryView.accounts) || []).find((item) => item.accountId === row.accountId);
  const chip = senderAccountLabel(account || { accountId: row.accountId });
  const parts = [when, subject, chip, read];
  if (row.current) parts.push("Current");
  button.setAttribute("aria-label", parts.filter(Boolean).join(", "));
  const date = document.createElement("span");
  date.className = "when";
  date.textContent = when;
  const title = document.createElement("span");
  title.className = "subject";
  title.textContent = subject;
  const accountNode = document.createElement("span");
  accountNode.className = "sender-history-account";
  accountNode.textContent = chip;
  const stateNode = document.createElement("span");
  stateNode.className = "sender-history-read";
  stateNode.textContent = read;
  button.append(date, title, accountNode, stateNode);
  if (row.current) {
    const current = document.createElement("span");
    current.className = "sender-history-current";
    current.textContent = "Current";
    button.appendChild(current);
  }
  button.addEventListener("click", () => openSenderReader(row));
  return button;
}

function paintSenderHistory() {
  const view = senderHistoryView;
  const dialog = $("sender-history");
  const desc = $("sender-history-desc");
  const chips = $("sender-history-chips");
  const body = $("sender-history-body");
  const more = $("sender-history-more");
  if (!view || !dialog || !body) return;
  if (desc) desc.textContent = "From " + view.address;
  const busy = !!(view.loading && !view.rows.length);
  dialog.setAttribute("aria-busy", busy ? "true" : "false");
  if (chips) paintSenderChips(chips);
  body.replaceChildren();
  if (view.loading && !view.rows.length) {
    const pending = document.createElement("div");
    pending.className = "body-pending";
    pending.setAttribute("role", "status");
    const spin = document.createElement("div");
    spin.className = "page-busy-spin";
    spin.setAttribute("aria-hidden", "true");
    const label = document.createElement("p");
    label.textContent = "Searching…";
    pending.append(spin, label);
    body.appendChild(pending);
  } else if (!view.rows.length && (view.failed || (view.accounts || []).some((row) => row && row.status && row.status !== "ok"))) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Previous mail could not be loaded.";
    body.appendChild(note);
  } else if (!view.rows.length && !view.loading) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "No earlier mail from " + view.address + ".";
    body.appendChild(note);
  } else {
    for (const row of view.rows) body.appendChild(senderHistoryRow(row));
  }
  if (more) {
    more.hidden = !view.rows.length || !!view.exhausted;
    const spinning = !!(view.loading || view.loadingMore);
    more.disabled = spinning;
    more.setAttribute("aria-busy", spinning ? "true" : "false");
  }
}

async function requestSenderHistory(gen, append, retryAccountId) {
  const view = senderHistoryView;
  if (!view || !api) return;
  const payload = {
    address: view.address,
    preferAccountId: view.preferAccountId,
    currentId: view.currentId,
    currentMessageId: view.currentMessageId,
    limit: 50,
  };
  if (append && view.resume) payload.resume = view.resume;
  if (retryAccountId) payload.retryAccountId = retryAccountId;
  try {
    const data = await call("mail:searchSender", payload);
    if (gen !== senderHistoryGen || !senderHistoryView) return;
    senderHistoryView.resume = data && data.resume;
    senderHistoryView.accounts = (data && data.accounts) || [];
    senderHistoryView.exhausted = !!(data && data.exhausted);
    const rows = (data && data.rows) || [];
    senderHistoryView.rows = append ? senderHistoryView.rows.concat(rows) : rows;
    senderHistoryView.failed = false;
    senderHistoryView.loading = false;
    senderHistoryView.loadingMore = false;
    paintSenderHistory();
    toastSenderFailures(senderHistoryView.accounts);
  } catch (error) {
    if (gen !== senderHistoryGen || !senderHistoryView) return;
    senderHistoryView.loading = false;
    senderHistoryView.loadingMore = false;
    if (!senderHistoryView.rows.length) senderHistoryView.failed = true;
    paintSenderHistory();
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function openSenderHistory(address) {
  const email = state.email || {};
  senderHistoryGen += 1;
  const gen = senderHistoryGen;
  senderHistoryView = {
    address: address,
    preferAccountId: email.accountId || "",
    currentId: email.id || "",
    currentMessageId: email.messageId || "",
    resume: null,
    rows: [],
    accounts: [],
    exhausted: false,
    loading: true,
    loadingMore: false,
    failed: false,
  };
  paintSenderHistory();
  const dialog = $("sender-history");
  if (dialog && !dialog.open) openDialog("sender-history");
  const title = $("sender-history-title");
  if (title && typeof title.focus === "function") title.focus();
  return requestSenderHistory(gen, false, "");
}

function loadMoreSenderHistory() {
  if (!senderHistoryView || senderHistoryView.exhausted || senderHistoryView.loading || senderHistoryView.loadingMore) return;
  senderHistoryGen += 1;
  const gen = senderHistoryGen;
  senderHistoryView.loadingMore = true;
  paintSenderHistory();
  return requestSenderHistory(gen, true, "");
}

function retrySenderAccount(accountId) {
  if (!senderHistoryView || !accountId) return;
  senderHistoryGen += 1;
  const gen = senderHistoryGen;
  senderHistoryView.loading = true;
  paintSenderHistory();
  return requestSenderHistory(gen, true, accountId);
}

async function openSenderReader(row) {
  if (!row) return;
  if (!api || typeof api.openReaderWindow !== "function") {
    showStatus("That message could not be opened.", true);
    return;
  }
  try {
    await api.openReaderWindow({ accountId: String(row.accountId), messageId: String(row.id) });
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function wireSenderHistory() {
  const dialog = $("sender-history");
  if (!dialog || dialog.dataset.wired === "1") return;
  dialog.dataset.wired = "1";
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog("sender-history");
  });
  dialog.addEventListener("close", () => {
    const genAtClose = senderHistoryGen;
    queueMicrotask(() => {
      if (senderHistoryGen !== genAtClose) return;
      senderHistoryGen += 1;
      senderHistoryView = null;
    });
  });
  const more = $("sender-history-more");
  if (more) more.addEventListener("click", () => { loadMoreSenderHistory(); });
  if (api && typeof api.on === "function") {
    api.on("reader:openFailed", (payload) => {
      showStatus((payload && payload.message) || "That message could not be opened.", true);
    });
  }
}

let recipientSuggestGen = 0;
let recipientSuggestTimer = 0;
let recipientSuggestIndex = -1;
let recipientSuggestRows = [];
let recipientSuggestInput = null;
let recipientSuggestEscape = false;
let recipientSuggestSnapshot = null;

function recipientSuggestApi() {
  return typeof window !== "undefined" ? window.morrowRecipientSuggest : null;
}

function hideRecipientSuggest() {
  if (!document || typeof document.getElementById !== "function") return false;
  const box = document.getElementById("recipient-suggest");
  const open = !!(box && box.hidden === false);
  if (box) {
    box.hidden = true;
    if (typeof box.replaceChildren === "function") box.replaceChildren();
  }
  const input = recipientSuggestInput;
  recipientSuggestIndex = -1;
  recipientSuggestRows = [];
  recipientSuggestInput = null;
  recipientSuggestSnapshot = null;
  if (input && typeof input.setAttribute === "function") {
    input.setAttribute("aria-expanded", "false");
    if (typeof input.removeAttribute === "function") input.removeAttribute("aria-activedescendant");
  }
  if (recipientSuggestTimer) clearTimeout(recipientSuggestTimer);
  recipientSuggestTimer = 0;
  recipientSuggestGen += 1;
  return open;
}

function scheduleRecipientSuggest(input) {
  const api = recipientSuggestApi();
  const query = api && input ? api.activeQuery(input.value) : "";
  if (!api || !input || input.disabled || input.readOnly || !query) {
    hideRecipientSuggest();
    return;
  }
  hideRecipientSuggest();
  const gen = ++recipientSuggestGen;
  if (recipientSuggestTimer) clearTimeout(recipientSuggestTimer);
  recipientSuggestTimer = setTimeout(() => {
    recipientSuggestTimer = 0;
    loadRecipientSuggest(input, gen);
  }, 80);
}

async function loadRecipientSuggest(input, gen) {
  const api = recipientSuggestApi();
  if (!api) return;
  const query = api.activeQuery(input.value);
  let result;
  try {
    result = await call("mail:suggestRecipients", { query });
  } catch {
    if (gen === recipientSuggestGen) hideRecipientSuggest();
    return;
  }
  if (gen !== recipientSuggestGen) return;
  const active = document.activeElement;
  if (active && active !== input && active !== document.body && active !== document.documentElement) return;
  if (api.activeQuery(input.value) !== query) return;
  const used = api.usedAddresses(input.value);
  const rows = ((result && result.suggestions) || []).filter((row) => row && row.email && !used.has(row.email));
  if (!rows.length) {
    hideRecipientSuggest();
    return;
  }
  paintRecipientSuggest(input, rows);
}

function recipientSuggestIcon() {
  const svg = strokeIcon(["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"], 16);
  if (!document.createElementNS) return svg;
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "7");
  circle.setAttribute("r", "4");
  svg.appendChild(circle);
  return svg;
}

function paintRecipientSuggest(input, rows) {
  const box = document.getElementById("recipient-suggest");
  if (!box || typeof box.replaceChildren !== "function") return;
  const host = input.closest ? input.closest(".field-row") : input.parentElement;
  if (host && typeof host.appendChild === "function") host.appendChild(box);
  box.replaceChildren();
  recipientSuggestRows = rows;
  recipientSuggestInput = input;
  recipientSuggestSnapshot = { value: input.value, gen: recipientSuggestGen };
  recipientSuggestIndex = -1;
  for (const id of ["compose-to", "compose-cc", "compose-bcc"]) {
    const node = document.getElementById(id);
    if (!node || node === input || typeof node.setAttribute !== "function") continue;
    node.setAttribute("aria-expanded", "false");
    if (typeof node.removeAttribute === "function") node.removeAttribute("aria-activedescendant");
  }
  rows.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "recipient-suggest-" + index;
    button.className = "recipient-suggest-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.dataset.email = item.email;
    const label = ((item.name ? item.name + " " : "") + item.email).trim();
    button.setAttribute("aria-label", label);
    button.appendChild(recipientSuggestIcon());
    const text = document.createElement("span");
    text.className = "recipient-suggest-copy";
    const name = document.createElement("span");
    name.className = "recipient-suggest-name";
    name.textContent = item.name || item.email;
    const email = document.createElement("span");
    email.className = "recipient-suggest-email";
    email.textContent = item.email;
    if (!item.name) email.hidden = true;
    text.appendChild(name);
    text.appendChild(email);
    button.appendChild(text);
    box.appendChild(button);
  });
  box.hidden = false;
  if (typeof input.setAttribute === "function") {
    input.setAttribute("aria-expanded", "true");
    if (typeof input.removeAttribute === "function") input.removeAttribute("aria-activedescendant");
  }
}

function moveRecipientSuggest(delta) {
  const box = document.getElementById("recipient-suggest");
  if (!box || !recipientSuggestRows.length) return;
  const last = recipientSuggestRows.length - 1;
  if (recipientSuggestIndex < 0) recipientSuggestIndex = delta > 0 ? 0 : last;
  else recipientSuggestIndex = Math.max(0, Math.min(last, recipientSuggestIndex + delta));
  const buttons = box.querySelectorAll('[role="option"]');
  buttons.forEach((button, index) => {
    const on = index === recipientSuggestIndex;
    button.setAttribute("aria-selected", on ? "true" : "false");
    if (!on) return;
    if (recipientSuggestInput && typeof recipientSuggestInput.setAttribute === "function") {
      recipientSuggestInput.setAttribute("aria-activedescendant", button.id);
    }
    try { button.scrollIntoView({ block: "nearest" }); } catch { /* synthetic documents have no layout */ }
  });
}

function chooseRecipientSuggest(email) {
  const api = recipientSuggestApi();
  const input = recipientSuggestInput;
  const choice = recipientSuggestRows.find((row) => row.email === email);
  if (!api || !input || !choice) return;
  if (!recipientSuggestSnapshot || recipientSuggestSnapshot.value !== input.value || recipientSuggestSnapshot.gen !== recipientSuggestGen) {
    hideRecipientSuggest();
    return;
  }
  input.value = api.applyChoice(input.value, choice);
  hideRecipientSuggest();
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (typeof input.focus === "function") input.focus();
  if (typeof input.setSelectionRange === "function") {
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch { /* some fields reject a range while hidden */ }
  }
}

function onRecipientSuggestKey(event) {
  const api = recipientSuggestApi();
  if (!api || !event) return;
  const box = document.getElementById("recipient-suggest");
  const open = !!(box && box.hidden === false && recipientSuggestInput === event.currentTarget);
  const action = api.keyAction(event.key, open, recipientSuggestIndex);
  if (!action) return;
  event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  if (action === "close") {
    recipientSuggestEscape = true;
    hideRecipientSuggest();
    return;
  }
  if (action === "next") moveRecipientSuggest(1);
  else if (action === "prev") moveRecipientSuggest(-1);
  else if (action === "choose") {
    const row = recipientSuggestRows[recipientSuggestIndex];
    if (row) chooseRecipientSuggest(row.email);
  }
}

function takeRecipientSuggestEscape() {
  if (recipientSuggestEscape) {
    recipientSuggestEscape = false;
    return true;
  }
  const box = document && typeof document.getElementById === "function" ? document.getElementById("recipient-suggest") : null;
  if (box && box.hidden === false) {
    hideRecipientSuggest();
    return true;
  }
  return false;
}

function wireRecipientSuggest() {
  for (const id of ["compose-to", "compose-cc", "compose-bcc"]) {
    const input = $(id);
    if (!input || typeof input.addEventListener !== "function") continue;
    input.addEventListener("input", () => scheduleRecipientSuggest(input));
    input.addEventListener("keydown", onRecipientSuggestKey);
    input.addEventListener("blur", () => {
      const gen = recipientSuggestGen;
      setTimeout(() => {
        if (gen !== recipientSuggestGen || recipientSuggestInput !== input) return;
        if (document.activeElement === input) return;
        const box = document.getElementById("recipient-suggest");
        if (box && typeof box.contains === "function" && box.contains(document.activeElement)) return;
        hideRecipientSuggest();
      }, 0);
    });
  }
  const box = $("recipient-suggest");
  if (!box || typeof box.addEventListener !== "function") return;
  box.addEventListener("mousedown", (event) => {
    const button = event.target && event.target.closest ? event.target.closest("button") : null;
    if (button) event.preventDefault();
  });
  box.addEventListener("click", (event) => {
    const button = event.target && event.target.closest ? event.target.closest("button") : null;
    if (button && button.dataset) chooseRecipientSuggest(button.dataset.email);
  });
}

function wire() {
  if (window.morrowBrainCompose) window.morrowBrainCompose.wire();
  wireRecipientSuggest();
  wireComposeFormat();
  $("compose-from").addEventListener("change", changeComposeFrom);
  $("compose-cc").addEventListener("input", () => {
    if (state.composeIdentity && state.composeIdentity.seeds) state.composeIdentity.seeds.cc.locked = true;
  });
  $("compose-bcc").addEventListener("input", () => {
    if (state.composeIdentity && state.composeIdentity.seeds) state.composeIdentity.seeds.bcc.locked = true;
  });
  $("inbox-rules-account").addEventListener("change", () => changeInboxRulesAccount($("inbox-rules-account").value).catch((error) => showInboxRuleStatus(error.message, true)));
  document.addEventListener("keydown", onShellKey);
  document.addEventListener("keydown", onMailShortcut);
  wireBot();
  document.addEventListener("keydown", onSelectionKey);
  wireStatusNotice();
  wireOrganize();
  wireSelection();
  const motion = motionApi();
  if (motion) motion.bindChrome(document);
  wireSettingsFolds();
  wireAgentTabs();
  wireAgentTodoView();
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("cancel", (event) => {
      if (dialog.id === "quit-scheduled") {
        event.preventDefault();
        if (quitScheduledPrompt) replyQuitScheduled("stay");
        else closeDialog("quit-scheduled");
        return;
      }
      if (dialog.id === "compose-close-review") return;
      if (dialog.id === "connect") {
        event.preventDefault();
        dismissConnect();
        return;
      }
      if (dialog.id === "compose") {
        event.preventDefault();
        if (takeRecipientSuggestEscape()) return;
        if (composeAiOpen()) {
          dismissComposeAi().catch(() => {});
          return;
        }
        dismissComposeSurface();
        return;
      }
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
  $("agent-manage-skills").addEventListener("click", () => { $("brain-return-agent").hidden = false; openBrain("skills"); });
  $("brain-return-agent").addEventListener("click", showAgent);
  for (const space of ["agent", "brain"]) {
    $(space + "-setup-ai").addEventListener("click", openAiSetup);
    $(space + "-setup-connect").addEventListener("click", () => openConnectFor(null));
  }
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
  $("rail-folders").addEventListener("click", showProviderPage);
  $("provider-account").addEventListener("change", () => guard(async () => {
    const account = state.accounts.find(row => row.id === $("provider-account").value);
    if (!account) return;
    await selectFolder(account.id, foldersOf(account)[0]?.id || "INBOX");
    paintProviderPage();
  }));
  $("rail-shortcuts").addEventListener("click", showFeatures);
  window.addEventListener("hashchange", applyFeaturesHash);
  wireFeaturesTabs();
  $("rail-log").addEventListener("click", showLog);
  $("rail-about").addEventListener("click", openAbout);
  $("log-refresh").addEventListener("click", () => {
    refreshLog().catch((error) => {
      const status = $("log-status");
      if (status) status.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  $("nav-collapse").addEventListener("click", () => {
    setNavCollapsed(document.documentElement.dataset.nav !== "collapsed");
  });
  $("calendar-prev").addEventListener("click", () => shiftMonth(-1));
  $("calendar-next").addEventListener("click", () => shiftMonth(1));
  $("calendar-today").addEventListener("click", showCalendarToday);
  $("calendar-grant").addEventListener("click", () => guard(grantCalendar));
  $("calendar-add").addEventListener("click", () => openCalendarEditor(null, state.calendarFocusDay));
  $("calendar-create").addEventListener("submit", submitCalendarForm);
  $("calendar-all-day").addEventListener("change", syncAllDayInputs);
  $("calendar-delete").addEventListener("click", () => guard(() => deleteCalendarEvent(calendarEditingIdentity)));
  $("calendar-cancel").addEventListener("click", () => {
    calendarEditingId = "";
    calendarEditingIdentity = null;
    closeDialog("calendar-event-dialog");
  });
  $("calendar-event-dialog").addEventListener("close", () => {
    if ($("calendar-event-dialog").open) return; // ignore a queued close from a previous editor
    calendarEditingId = "";
    calendarEditingIdentity = null;
    calendarEditorGeneration += 1;
  });
  $("calendar-account").addEventListener("change", () => {
    state.calendarAccountId = $("calendar-account").value;
    state.calendarId = "";
    state.calendarEventId = "";
    state.calendarFocusDay = "";
    loadCalendar().catch((error) => showStatus(error.message, true));
  });
  $("calendar-pick").addEventListener("change", () => {
    const dialog = $("calendar-event-dialog");
    if (dialog && dialog.open) return;
    state.calendarId = $("calendar-pick").value;
  });
  $("provider-content").addEventListener("keydown", onProviderColumnKey);
  const folderNav = $("folders");
  if (folderNav) {
    folderNav.addEventListener("keydown", onFolderNavKey);
    folderNav.addEventListener("focusin", (event) => {
      const node = folderNavNode(event.target, folderNav);
      if (!node) return;
      folderNavKey = node.dataset.navKey || "";
      for (const item of folderNav.querySelectorAll("[data-nav-key]")) item.tabIndex = item === node ? 0 : -1;
    });
  }
  const collapseAll = $("folder-collapse-all");
  if (collapseAll) collapseAll.addEventListener("click", () => {
    collapseAllFolders().catch((error) => showStatus(error.message, true));
  });
  wireSplits();
  wireQuoteSplit();
  $("undo").addEventListener("click", () => guard(undoRemoval));
  const undoDetailsButton = $("undo-details");
  if (undoDetailsButton) undoDetailsButton.addEventListener("click", () => openUndoDetails());
  const undoDetailsAll = $("undo-details-all");
  if (undoDetailsAll) undoDetailsAll.addEventListener("click", () => setUndoDetailChecks(true));
  const undoDetailsClear = $("undo-details-clear");
  if (undoDetailsClear) undoDetailsClear.addEventListener("click", () => setUndoDetailChecks(false));
  const undoDetailsSelected = $("undo-details-selected");
  if (undoDetailsSelected) undoDetailsSelected.addEventListener("click", () => guard(() => undoSelected()));
  $("undo-send").addEventListener("click", cancelUndoSend);
  $("profile").addEventListener("change", () => {
    cancelDiscovery();
    discoveredProfile = "";
    if ($("profile").value !== "custom") {
      customEndpointEdits.clear();
      clearDiscoveredEndpoints();
    }
    syncCustomFields();
  });
  $("connect-yahoo").addEventListener("click", chooseYahoo);
  $("email").addEventListener("input", scheduleDiscover);
  for (const id of ["imap-host", "smtp-host", "imap-port", "smtp-port"]) {
    $(id).addEventListener("input", () => { customEndpointEdits.add(id.split("-")[0]); });
  }
  for (const id of ["imap-tls", "smtp-tls"]) {
    $(id).addEventListener("change", () => { customEndpointEdits.add(id.split("-")[0]); });
  }
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
  const folderFilter = $("folder-filter");
  const folderFilterClear = $("folder-filter-clear");
  if (folderFilter) {
    const syncFolderFilterClear = () => {
      if (folderFilterClear) folderFilterClear.hidden = !String(folderFilter.value || "");
    };
    const applyFolderFilter = () => {
      syncFolderFilterClear();
      renderAccounts();
    };
    folderFilter.addEventListener("input", applyFolderFilter);
    folderFilter.addEventListener("search", applyFolderFilter);
    folderFilter.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (folderFilter.value) {
        folderFilter.value = "";
        applyFolderFilter();
        return;
      }
      folderFilter.blur();
    });
    if (folderFilterClear) {
      folderFilterClear.addEventListener("click", () => {
        folderFilter.value = "";
        applyFolderFilter();
        folderFilter.focus();
      });
    }
    syncFolderFilterClear();
  }
  const providerFilter = $("provider-filter");
  const providerFilterClear = $("provider-filter-clear");
  if (providerFilter) {
    const syncProviderFilterClear = () => {
      if (providerFilterClear) providerFilterClear.hidden = !String(providerFilter.value || "");
    };
    const applyProviderFilter = () => {
      syncProviderFilterClear();
      const block = $("provider-folders");
      if (!block) return;
      const account = selectedAccount();
      const payload = account ? providerPayloadFor(account) : null;
      const tree = providerLabelTree((payload && payload.folders) || []);
      const reveal = providerFilterReveal(tree, providerFilter.value);
      if (reveal) state.providerColumnPath = reveal;
      renderProviderColumns(block);
    };
    providerFilter.addEventListener("input", applyProviderFilter);
    providerFilter.addEventListener("search", applyProviderFilter);
    providerFilter.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (providerFilter.value) {
        providerFilter.value = "";
        applyProviderFilter();
        return;
      }
      providerFilter.blur();
    });
    if (providerFilterClear) {
      providerFilterClear.addEventListener("click", () => {
        providerFilter.value = "";
        applyProviderFilter();
        providerFilter.focus();
      });
    }
    syncProviderFilterClear();
  }
  $("refresh").addEventListener("click", () => guard(refresh));
  $("list-prev").addEventListener("click", () => guard(() => changeListPage(-1)));
  $("list-next").addEventListener("click", () => guard(() => changeListPage(1)));
  $("list-sync-more").addEventListener("click", () => guard(() => loadList(true)));
  $("scheduled-open").addEventListener("click", () => showScheduled());
  $("compose-view-scheduled").addEventListener("click", () => showScheduled());
  $("scheduled-refresh").addEventListener("click", () => loadScheduled());
  $("scheduled-close").addEventListener("click", () => closeDialog("scheduled-dialog"));
  $("mail-ooo-manage").addEventListener("click", () => manageMailVacation());
  $("mail-ooo-refresh").addEventListener("click", () => refreshMailVacation(true));
  $("settings-account").addEventListener("change", () => changeSettingsMailbox($("settings-account").value));
  $("settings-reconnect").addEventListener("click", () => openConnectFor(settingsAccount()));
  $("google-oauth-import").addEventListener("click", () => changeGoogleOauthClient("mail:importGoogleOauth"));
  $("google-oauth-clear").addEventListener("click", () => changeGoogleOauthClient("mail:clearGoogleOauth"));
  $("settings-gmail-migrate").addEventListener("click", () => reauthorizeGmail(false));
  $("settings-gmail-calendar").addEventListener("click", () => reauthorizeGmail(true));
  $("settings-gmail-cancel").addEventListener("click", cancelGmailReauthorization);
  $("settings-calendar").addEventListener("click", () => {
    const accountId = settingsAccount()?.id || "";
    if (state.calendarAccountId !== accountId) { state.calendarId = ""; state.calendarEventId = ""; }
    state.calendarAccountId = accountId;
    closeDialog("settings");
    showCalendar();
  });
  $("settings-capabilities-refresh").addEventListener("click", loadSettingsCapabilities);
  $("about-close").addEventListener("click", () => closeDialog("about-dialog"));
  $("changelog-close").addEventListener("click", () => closeDialog("changelog"));
  $("changelog-ok").addEventListener("click", () => closeDialog("changelog"));
  $("changelog").addEventListener("close", acknowledgeChangelog);
  $("about-update-check").addEventListener("click", checkForUpdates);
  $("about-update-install").addEventListener("click", installUpdate);
  $("about-update-manual").addEventListener("click", async () => {
    const serial = updateGen;
    try {
      const next = await api.invoke("host:updateManual");
      if (serial !== updateGen) return;
      bumpUpdate(next);
    } catch (error) {
      if (serial !== updateGen) return;
      bumpUpdate({ error: error.message });
    }
  });
  $("log-source").addEventListener("change", filterSupportLog);
  $("log-preview").addEventListener("click", previewSupportLog);
  $("support-copy").addEventListener("click", copySupportLog);
  $("support-close").addEventListener("click", () => closeDialog("support-dialog"));
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
  $("label-picker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    finishLabelPick();
  });
  $("label-picker-cancel").addEventListener("click", () => closeLabelPicker());
  $("label-picker-filter").addEventListener("input", () => {
    if (!labelSession) return;
    labelSession.query = $("label-picker-filter").value;
    paintLabelPicker();
  });
  $("label-picker-filter").addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  $("label-picker").addEventListener("close", () => {
    labelSession = null;
  });
  $("confirm-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitConfirm();
  });
  $("confirm-cancel").addEventListener("click", () => cancelConfirm());
  $("attachment-preview-close").addEventListener("click", () => closeAttachmentPreview());
  window.addEventListener("beforeunload", () => { for (const task of attachmentTasks.values()) cancelAttachmentTask(task); });
  $("attachment-preview").addEventListener("close", clearAttachmentPreview);
  $("agent-peek-close").addEventListener("click", () => closeDialog("agent-peek"));
  $("agent-peek-mail").addEventListener("click", () => {
    openPeekInMail().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("agent-peek").addEventListener("close", invalidatePeek);
  $("confirm").addEventListener("close", () => {
    if (!confirmResult) return;
    const pending = confirmResult;
    confirmResult = null;
    confirmCopy = null;
    pending({ ok: false, name: "" });
  });
  for (const id of AI_FIELD_IDS) {
    $(id).addEventListener("input", () => setFieldError(id, ""));
  }
  for (const id of OOO_FIELD_IDS) {
    $(id).addEventListener("input", () => setFieldError(id, ""));
    $(id).addEventListener("change", () => setFieldError(id, ""));
  }
  $("bot-label").addEventListener("input", () => setFieldError("bot-label", ""));
  $("bot-serve-host").addEventListener("input", () => setFieldError("bot-serve-host", ""));
  $("bot-accounts").addEventListener("change", () => setFieldError("bot-accounts", ""));
  $("ai-save").addEventListener("click", () => {
    saveAiSettings().catch((error) => setAiStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("ai-fetch").addEventListener("click", () => {
    fetchAiModels().catch((error) => setAiStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("ai-test").addEventListener("click", () => {
    testAiConnection().catch((error) => setAiStatus(error instanceof Error ? error.message : String(error), true));
  });
  for (const id of ["ai-base", "ai-model", "ai-key"]) {
    $(id).addEventListener("input", paintAiDirty);
    $(id).addEventListener("change", paintAiDirty);
  }
  $("ai-model-select").addEventListener("change", chooseFetchedModel);
  for (const id of ["ooo-mode", "ooo-start", "ooo-end", "ooo-subject", "ooo-message", "ooo-external", "ooo-audience", "ooo-domain"]) {
    $(id).addEventListener("input", paintOooDirty);
    $(id).addEventListener("change", paintOooDirty);
  }
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
    closeAiSettings();
    clearBotSecret();
    loadShellPrefs().then(() => {
      paintPrefs();
      if ($("compose") && $("compose").open) syncCompose();
    }).catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
  });
  for (const id of ["pref-schedule-hours", "pref-schedule-minutes"]) {
    $(id).addEventListener("change", () => {
      saveScheduleDelay().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
    });
  }
  for (const row of prefRows()) {
    $(row[0]).addEventListener("change", () => {
      savePref(row);
    });
  }
  const accentRow = prefRows().find((row) => row[0] === "pref-accent");
  if ($("pref-accent-picker") && accentRow) {
    $("pref-accent-picker").addEventListener("input", () => {
      $("pref-accent").value = $("pref-accent-picker").value.toUpperCase();
      applyShellTheme(document.documentElement, $("pref-theme").value, $("pref-accent").value);
    });
    $("pref-accent-picker").addEventListener("change", () => {
      $("pref-accent").value = $("pref-accent-picker").value.toUpperCase();
      savePref(accentRow);
    });
  }
  if ($("pref-accent-reset") && accentRow) {
    $("pref-accent-reset").addEventListener("click", () => {
      $("pref-accent").value = "#193C34";
      savePref(accentRow);
    });
  }
  $("signatures-open").addEventListener("click", openSignatures);
  const composeSignatures = $("brain-compose-signatures");
  if (composeSignatures) composeSignatures.addEventListener("click", () => openSignatures(($("brain-compose-account") && $("brain-compose-account").value) || ""));
  $("signatures-close").addEventListener("click", () => {
    signatureEditorIdentity = null;
    signatureEditorFocus = null;
    signatureEditorSettings = null;
    closeDialog("signatures");
  });
  $("signatures").addEventListener("close", () => {
    if ($("signatures").open) return; // ignore a queued close from a previous editor
    signatureEditorGeneration += 1;
    signatureEditId = "";
    signatureEditorAccountId = "";
  });
  $("signature-cancel").addEventListener("click", () => {
    if (signatureEditorIdentity) selectSignatureIdentity(signatureEditorIdentity, true);
    else clearSignatureForm();
  });
  $("signature-html").addEventListener("change", onSignatureHtmlToggle);
  $("signature-form").addEventListener("submit", (event) => {
    submitSignature(event).catch((error) => {
      showSignatureStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  $("brain-close").addEventListener("click", closeBrain);
  $("brain-open-compose-settings").addEventListener("click", () => {
    openSettings();
    revealSettingsFold("compose");
  });
  $("brain-skill-dialog-close").addEventListener("click", () => closeDialog("brain-skill-dialog"));
  $("brain-skill-dialog").addEventListener("close", () => {
    brainSkillDialogId = "";
    customSkillCreating = false;
  });
  $("custom-skill-form").addEventListener("submit", (event) => {
    saveCustomSkillFromForm(event).catch((error) => setSkillStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("brain-skill-new").addEventListener("click", openCustomSkillCreator);
  $("agent-skill-new").addEventListener("click", openCustomSkillCreator);
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
  $("connect-open").addEventListener("click", () => openConnectFor(null));
  $("connect").addEventListener("close", () => { state.reconnectAccountId = null; clearConnectMigration(); $("email").readOnly = false; $("connect-title").textContent = "Connect account"; $("connect-recovery-note").textContent = ""; });
  $("connect-close").addEventListener("click", () => dismissConnect());
  $("connect-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connectImap();
  });
  $("oauth-google").addEventListener("click", () => connectOAuth("google"));
  $("connect-gmail-migration").addEventListener("click", () => { reviewConnectGmailMigration().catch(error => showStatus(error.message, true)); });
  $("oauth-microsoft").addEventListener("click", () => connectOAuth("microsoft"));
  $("remove").addEventListener("click", () => guard(removeAccount));
  $("compose-open").addEventListener("click", () => {
    presentCompose(newMailSeed()).catch((error) => showStatus(error.message, true));
  });
  $("compose-show-cc")?.addEventListener("click", () => {
    state.composeShowCc = true;
    syncComposeRecipientRows();
    $("compose-cc")?.focus();
  });
  $("compose-show-bcc")?.addEventListener("click", () => {
    state.composeShowBcc = true;
    syncComposeRecipientRows();
    $("compose-bcc")?.focus();
  });
  $("signature").addEventListener("change", onSignatureChange);
  $("signatures-from-compose").addEventListener("click", openSignatures);
  $("schedule-preset").addEventListener("change", syncScheduleFields);
  $("schedule-at").addEventListener("change", syncScheduleFields);
  $("compose").addEventListener("close", () => {
    stopDraftWrite();
    closeComposeAi();
  });
  $("compose-close").addEventListener("click", () => {
    dismissComposeSurface();
  });
  const aiOpen = $("compose-ai-open");
  if (aiOpen && typeof aiOpen.addEventListener === "function") {
    aiOpen.addEventListener("click", () => toggleComposeAi());
  }
  const aiModes = $("compose-ai-modes");
  if (aiModes && typeof aiModes.addEventListener === "function") {
    aiModes.addEventListener("click", (event) => {
      const button = event.target && event.target.closest && event.target.closest("[data-ai-mode]");
      if (!button || button.disabled) return;
      setAiMode(button.getAttribute("data-ai-mode"));
    });
    aiModes.addEventListener("keydown", onAiModeKeydown);
  }
  const aiPopover = $("compose-ai-popover");
  if (aiPopover && typeof aiPopover.addEventListener === "function") {
    aiPopover.addEventListener("keydown", onComposeAiTab);
  }
  document.addEventListener("pointerdown", onComposeAiPointerDown);
  $("ai-generate").addEventListener("click", () => {
    startDraftWrite().catch((error) => showStatus(error.message, true));
  });
  $("ai-cancel").addEventListener("click", () => {
    dismissComposeAi().catch((error) => showStatus(error.message, true));
  });
  $("ai-prompt").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    startDraftWrite().catch((error) => showStatus(error.message, true));
  });
  const attach = $("compose-attach");
  if (attach && typeof attach.addEventListener === "function") {
    attach.addEventListener("click", () => {
      const input = $("compose-file");
      if (!input || input.disabled || typeof input.click !== "function") return;
      input.click();
    });
  }
  const fileInput = $("compose-file");
  if (fileInput && typeof fileInput.addEventListener === "function") {
    fileInput.addEventListener("change", () => {
      const picked = Array.from(fileInput.files || []);
      fileInput.value = "";
      addComposeFiles(picked).catch((error) => setComposeAttachError(error instanceof Error ? error.message : String(error)));
    });
  }
  wireComposeFileDrop();
  $("compose-save").addEventListener("click", () => guard(saveDraft));
  $("compose-schedule").addEventListener("click", () => guard(requestSchedulePreview));
  $("compose-send-now").addEventListener("click", () => guard(requestSendNowPreview));
  $("compose-form").addEventListener("submit", (event) => {
    event.preventDefault();
    guard(requestSendPreview);
  });
  $("compose-preview-form").addEventListener("submit", (event) => {
    event.preventDefault();
    guard(confirmComposePreview);
  });
  $("compose-preview-cancel").addEventListener("click", () => cancelComposePreview());
  $("compose-preview").addEventListener("close", () => { previewDraftState = null; });
  $("undo-schedule").addEventListener("click", () => {
    undoCancelScheduled().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
  });
  $("scheduled-undo").addEventListener("click", () => {
    undoCancelScheduled().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
  });
  wireSenderHistory();
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

let translateSnapSeq = 0;

function translateHeading(snap) {
  const subject = snap && snap.subject ? String(snap.subject).trim() : "";
  const language = snap && snap.language ? String(snap.language).trim() : "";
  if (subject && language) return subject + " — " + language;
  if (subject) return subject;
  if (language) return "Translation — " + language;
  return "Translation";
}

function translateStatusLabel(snap) {
  const total = Number(snap && snap.total) || 0;
  const current = Number(snap && snap.current) || 0;
  if (total > 0) return "Translating… " + current + "/" + total;
  return "Translating…";
}

function buildTranslateWindow(pane, snap) {
  pane.replaceChildren();
  const chrome = document.createElement("div");
  chrome.className = "translate-chrome";
  const heading = document.createElement("h2");
  heading.className = "translate-title";
  heading.dataset.role = "translate-title";
  heading.textContent = translateHeading(snap);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.dataset.action = "translate-cancel";
  cancel.textContent = "Cancel";
  cancel.hidden = true;
  cancel.addEventListener("click", () => {
    const reqId = pane.dataset.translateReq;
    if (!reqId || !api) return;
    api.invoke("mail:translateCancel", { reqId: reqId }).catch(() => {});
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ghost";
  close.textContent = "Close";
  close.addEventListener("click", () => {
    if (typeof window.close === "function") window.close();
  });
  chrome.append(heading, cancel, close);
  const columns = document.createElement("div");
  columns.className = "translate-columns";
  const left = document.createElement("section");
  left.className = "translate-column";
  const leftLabel = document.createElement("h2");
  leftLabel.textContent = "Original";
  const leftBody = document.createElement("div");
  leftBody.className = "translate-column-body";
  const original = document.createElement("pre");
  original.dataset.role = "original";
  original.textContent = snap && snap.original ? String(snap.original) : "";
  leftBody.appendChild(original);
  left.append(leftLabel, leftBody);
  const right = document.createElement("section");
  right.className = "translate-column";
  const rightLabel = document.createElement("h2");
  rightLabel.textContent = "Translation";
  const stateLine = document.createElement("p");
  stateLine.dataset.role = "translate-state";
  stateLine.setAttribute("role", "status");
  const errorLine = document.createElement("p");
  errorLine.dataset.role = "translate-error";
  errorLine.className = "error";
  errorLine.setAttribute("role", "status");
  errorLine.hidden = true;
  const rightBody = document.createElement("div");
  rightBody.className = "translate-column-body";
  const translated = document.createElement("pre");
  translated.dataset.role = "translated";
  rightBody.appendChild(translated);
  right.append(rightLabel, stateLine, errorLine, rightBody);
  columns.append(left, right);
  pane.append(chrome, columns);
}

function renderTranslateWindow(snap) {
  const pane = $("reader");
  if (!pane || !snap) return;
  const reqId = snap.reqId ? String(snap.reqId) : "";
  if (pane.dataset.translateReq !== reqId || !pane.querySelector("[data-role='original']")) {
    pane.dataset.translateReq = reqId;
    buildTranslateWindow(pane, snap);
  }
  const heading = pane.querySelector("[data-role='translate-title']");
  const stateLine = pane.querySelector("[data-role='translate-state']");
  const errorLine = pane.querySelector("[data-role='translate-error']");
  const translated = pane.querySelector("[data-role='translated']");
  const cancel = pane.querySelector("[data-action='translate-cancel']");
  if (heading) heading.textContent = translateHeading(snap);
  document.title = translateHeading(snap).slice(0, 180) + " — Morrow Mail";
  const pending = snap.pending === true && !snap.error;
  if (pending) pane.setAttribute("aria-busy", "true");
  else pane.removeAttribute("aria-busy");
  if (stateLine) {
    stateLine.hidden = !pending;
    stateLine.textContent = pending ? translateStatusLabel(snap) : "";
  }
  if (errorLine) {
    errorLine.hidden = !snap.error;
    errorLine.textContent = snap.error ? String(snap.error) : "";
  }
  const nextText = snap.translated ? String(snap.translated) : "";
  if (translated && translated.textContent !== nextText) translated.textContent = nextText;
  if (cancel) cancel.hidden = !pending;
}

function acceptTranslateSnap(snap) {
  if (!snap || typeof snap.seq !== "number") return;
  if (snap.seq < translateSnapSeq) return;
  translateSnapSeq = snap.seq;
  renderTranslateWindow(snap);
}

async function bootTranslateWindow() {
  try { document.documentElement.dataset.window = "translate"; } catch { /* the page is still the translation surface */ }
  if (!api) {
    showStatus("Mail preload is unavailable.", true);
    return;
  }
  await loadLook();
  if (typeof api.on === "function") api.on("translate:update", acceptTranslateSnap);
  let snap = null;
  try {
    if (typeof api.pullTranslateSeed === "function") snap = await api.pullTranslateSeed();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
  if (snap) acceptTranslateSnap(snap);
  else {
    renderTranslateWindow({
      seq: 0,
      reqId: "",
      subject: "",
      language: "",
      original: "",
      translated: "",
      error: "That translation could not be opened.",
      pending: false,
      current: 0,
      total: 0,
    });
  }
}

async function boot() {
  if (isComposeWindow()) {
    await bootComposeWindow();
    return;
  }
  if (isTranslateWindow()) {
    await bootTranslateWindow();
    return;
  }
  if (isReaderWindow()) {
    await bootReaderWindow();
    return;
  }
  if (!api) {
    showStatus("Mail preload is unavailable.", true);
    return;
  }
  api.invoke("morrow:configGetLayoutPanes").then((value) => {
    const panes = layoutPanesPref(value);
    state.prefs.layout = panes;
    applyLayoutPanes(panes);
  }).catch(() => {});
  api.on("host:menuAction", onMenuAction);
  api.on("host:updatePrepareForInstall", prepareUpdateRestart);
  api.on("host:updateResume", resumeAfterUpdate);
  api.on("host:updateState", (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return;
    bumpUpdate(snapshot);
  });
  api.on("app:confirmQuitScheduled", acceptQuitScheduled);
  api.on("app:dismissQuitScheduled", dismissQuitScheduled);
  wire();
  setNavCollapsed(readNavCollapsed());
  watchNetwork();
  api.on("mail:accountsUpdated", onAccountsUpdated);
  api.on("nativeAgent:homeUpdated", (payload) => {
    if (!payload || typeof payload !== "object") return;
    agentPaintPayload = payload;
    if (state.view === "agent") paintAgent(payload, "");
  });
  api.on("mail:emailsUpdated", () => scheduleReload());
  api.on("mail:bodyUpdated", applyBodyUpdate);
  api.on("mail:bodySyncStatus", acceptBodySync);
  api.on("mail:actionsSettled", applyActionSettlement);
  api.on("mail:syncStatus", (payload) => {
    rememberSyncStatus(payload);
    paintSyncControl();
    pushDebug("sync", syncDetail(payload) || syncStatusLabel(payload));
    // Background sync updates its own control; action receipts stay readable.
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
  const updateSerial = updateGen;
  try {
    const next = await api.invoke("host:updateGetState");
    if (updateSerial === updateGen) bumpUpdate(next);
  } catch (error) {
    if (updateSerial === updateGen) bumpUpdate({ error: error instanceof Error ? error.message : String(error) });
  }
  await loadLook();
  await refreshBodySyncStatus();
  window.addEventListener("focus", () => { refreshBodySyncStatus().catch(() => {}); });
  try {
    rememberSyncStatus(await call("mail:getSyncStatus"));
    paintSyncControl();
  } catch { /* the button stays on Sync until the next status */ }
  await loadPresets();
  await loadOauthStatus();
  await loadShellPrefs();
  await loadAccounts();
  applyFeaturesHash();
  if (typeof api.reportUpdateReady === "function") api.reportUpdateReady();
}

boot().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));
