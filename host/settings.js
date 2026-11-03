const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./paths");
const folderCollapse = require("../shared/folder-collapse");
const displayFormat = require("../shared/display-format");
const translateLang = require("../shared/translate-lang");

const DEFAULTS = {
  theme: "light",
  accent: "#193C34",
  timeFormat: "system",
  dateFormat: "system",
  translateTargetLanguage: "zh-Hant",
  conversationView: true,
  remoteImages: true,
  undoSendDelaySeconds: 30,
  snooze: false,
  aiWriteAutoOpenOnReply: true,
  markReadCompletesAgentTodos: false,
  showFolderChips: true,
  sidebarGmailFoldersExpanded: true,
  sidebarOutlookFoldersExpanded: false,
  sidebarCollapsedFolders: {},
  composeQuoteWidth: 420,
  brainCompose: { ccByDomain: {}, bccByDomain: {}, accounts: {} },
  syncHorizonDays: 0, // 0 means all available history. Fresh installs use All.
  compactMessageList: true,
  mailNotificationsEnabled: true,
  mailNotificationPreview: "hidden",
  defaultScheduleDelayMinutes: 0, // 0 sends immediately. Otherwise Send schedules this far ahead.
  layoutPanes: { folders: 260, list: 360, reading: 0 },
  mailView: { layout: "right", listHeight: 320 },
  changelogSeen: "",
  onboarding: null,
  mailColumnOrder: ["date", "recipient", "sender", "subject", "status"],
  mailHiddenColumns: [],
};

const GET = {
  "config:getTheme": "theme",
  "morrow:configGetAccent": "accent",
  "morrow:configGetTimeFormat": "timeFormat",
  "morrow:configGetDateFormat": "dateFormat",
  "morrow:configGetTranslateTargetLanguage": "translateTargetLanguage",
  "morrow:configGetConversationViewEnabled": "conversationView",
  "morrow:configGetAutoLoadRemoteImages": "remoteImages",
  "morrow:configGetUndoSendDelaySeconds": "undoSendDelaySeconds",
  "morrow:configGetSnoozeEffective": "snooze",
  "morrow:configGetAiWriteAutoOpenOnReply": "aiWriteAutoOpenOnReply",
  "morrow:configGetMarkReadCompletesAgentTodos": "markReadCompletesAgentTodos",
  "morrow:configGetShowFolderChips": "showFolderChips",
  "morrow:configGetSidebarGmailFoldersExpanded": "sidebarGmailFoldersExpanded",
  "morrow:configGetSidebarOutlookFoldersExpanded": "sidebarOutlookFoldersExpanded",
  "morrow:configGetSidebarCollapsedFolders": "sidebarCollapsedFolders",
  "morrow:configGetComposeQuoteWidth": "composeQuoteWidth",
  "emailBrain:getComposeSettings": "brainCompose",
  "morrow:configGetSyncHorizonDays": "syncHorizonDays",
  "morrow:configGetCompactMessageList": "compactMessageList",
  "morrow:configGetMailNotificationsEnabled": "mailNotificationsEnabled",
  "morrow:configGetMailNotificationPreview": "mailNotificationPreview",
  "morrow:configGetDefaultScheduleDelayMinutes": "defaultScheduleDelayMinutes",
  "morrow:configGetLayoutPanes": "layoutPanes",
  "morrow:configGetMailView": "mailView",
  "morrow:configGetMailColumnOrder": "mailColumnOrder",
  "morrow:configGetMailHiddenColumns": "mailHiddenColumns",
  "morrow:configGetOnboarding": "onboarding",
  "morrow:configGetChangelogSeen": "changelogSeen",
};

const SET = {
  "config:setTheme": "theme",
  "morrow:configSetAccent": "accent",
  "morrow:configSetTimeFormat": "timeFormat",
  "morrow:configSetDateFormat": "dateFormat",
  "morrow:configSetTranslateTargetLanguage": "translateTargetLanguage",
  "morrow:configSetConversationViewEnabled": "conversationView",
  "morrow:configSetAutoLoadRemoteImages": "remoteImages",
  "morrow:configSetUndoSendDelaySeconds": "undoSendDelaySeconds",
  "morrow:configSetSnoozeEffective": "snooze",
  "morrow:configSetAiWriteAutoOpenOnReply": "aiWriteAutoOpenOnReply",
  "morrow:configSetMarkReadCompletesAgentTodos": "markReadCompletesAgentTodos",
  "morrow:configSetShowFolderChips": "showFolderChips",
  "morrow:configSetSidebarGmailFoldersExpanded": "sidebarGmailFoldersExpanded",
  "morrow:configSetSidebarOutlookFoldersExpanded": "sidebarOutlookFoldersExpanded",
  "morrow:configSetSidebarCollapsedFolders": "sidebarCollapsedFolders",
  "morrow:configSetComposeQuoteWidth": "composeQuoteWidth",
  "emailBrain:saveComposeSettings": "brainCompose",
  "morrow:configSetSyncHorizonDays": "syncHorizonDays",
  "morrow:configSetCompactMessageList": "compactMessageList",
  "morrow:configSetMailNotificationsEnabled": "mailNotificationsEnabled",
  "morrow:configSetMailNotificationPreview": "mailNotificationPreview",
  "morrow:configSetDefaultScheduleDelayMinutes": "defaultScheduleDelayMinutes",
  "morrow:configSetLayoutPanes": "layoutPanes",
  "morrow:configSetMailView": "mailView",
  "morrow:configSetMailColumnOrder": "mailColumnOrder",
  "morrow:configSetMailHiddenColumns": "mailHiddenColumns",
  "morrow:configSetOnboarding": "onboarding",
  "morrow:configSetChangelogSeen": "changelogSeen",
};

const BOOLS = new Set([
  "conversationView",
  "remoteImages",
  "snooze",
  "aiWriteAutoOpenOnReply",
  "markReadCompletesAgentTodos",
  "showFolderChips",
  "sidebarGmailFoldersExpanded",
  "sidebarOutlookFoldersExpanded",
  "compactMessageList",
  "mailNotificationsEnabled",
]);

function storePath() {
  return path.join(userDataDir(), "settings.json");
}

function reject(key) {
  if (key === "theme") throw new Error("Theme must be light or dark");
  if (key === "accent") throw new Error("Accent must be a #RRGGBB color");
  if (key === "timeFormat") throw new Error("Time format must be system, 12h, or 24h");
  if (key === "dateFormat") throw new Error("Date format must be system, dd/mm/yyyy, dd/mmmm/yyyy, mm/dd/yyyy, yyyy-mm-dd, or d mmm yyyy");
  if (key === "translateTargetLanguage") throw new Error("Translation language is not supported");
  if (key === "undoSendDelaySeconds") throw new Error("Undo send delay must be 0 to 30 seconds");
  if (key === "composeQuoteWidth") throw new Error("Quote pane width must be 220 to 720");
  if (key === "syncHorizonDays") throw new Error("Sync history must be 180 days, 365 days, or All");
  if (key === "defaultScheduleDelayMinutes") throw new Error("Default schedule delay must be 0 to 10080 minutes");
  if (key === "layoutPanes") throw new Error("Layout panes must be folder, list, and reading widths");
  if (key === "changelogSeen") throw new Error("Changelog version must look like 1.2.3");
  throw new Error("Expected on or off");
}

function layoutBound(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function castLayoutPanes(value, loose) {
  const fallback = { folders: 260, list: 360, reading: 0 };
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const folders = source ? layoutBound(source.folders, 140, 1600) : null;
  const list = source ? layoutBound(source.list, 200, 2000) : null;
  const reading = source ? layoutBound(source.reading, 0, 4000) : null;
  if (folders == null || list == null || reading == null) {
    if (loose) return { ...fallback };
    reject("layoutPanes");
  }
  return { folders, list, reading };
}

function castChangelogSeen(value, loose) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= 32 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text)) return text;
  if (loose) return "";
  reject("changelogSeen");
}

function cast(key, value, loose) {
  if (key === "mailView") {
    if (value && typeof value === "object" && !Array.isArray(value)
      && ["right", "bottom", "window"].includes(value.layout)
      && Number.isInteger(value.listHeight) && value.listHeight >= 200 && value.listHeight <= 1600) {
      return { layout: value.layout, listHeight: value.listHeight };
    }
    if (loose) return { ...DEFAULTS.mailView };
    throw new Error("Mail view must use right, bottom, or window and a list height from 200 to 1600");
  }
  if (key === "mailNotificationPreview") {
    if (["hidden", "sender", "message"].includes(value)) return value;
    if (loose) return "hidden";
    throw new Error("Notification preview must be hidden, sender, or message");
  }
  if (key === "mailColumnOrder") return require("../shared/mail-columns").normalize(value);
  if (key === "mailHiddenColumns") return require("../shared/mail-columns").normalizeHidden(value);
  if (key === "onboarding") {
    if (value === null) return null;
    if (!value || typeof value !== "object" || !["active", "later", "done", "existing"].includes(value.status)
      || !Number.isInteger(value.step) || value.step < 0 || value.step > 4) {
      if (loose) return null;
      throw new Error("Invalid setup guide progress");
    }
    return { status: value.status, step: value.step,
      accountId: typeof value.accountId === "string" ? value.accountId.slice(0, 256) : "" };
  }
  if (key === "changelogSeen") return castChangelogSeen(value, loose);
  if (key === "sidebarCollapsedFolders") {
    if (loose) return folderCollapse.normalize(value);
    return folderCollapse.cast(value);
  }
  if (key === "layoutPanes") return castLayoutPanes(value, loose);
  if (key === "brainCompose") {
    const policy = require("../shared/compose-policy");
    try { return policy.normalizeSettings(value); }
    catch (error) { if (!loose) throw error; return policy.emptySettings(); }
  }
  if (key === "translateTargetLanguage") return translateLang.cast(value, !!loose);
  if (key === "theme") {
    const theme = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (theme === "light" || theme === "dark") return theme;
  } else if (key === "accent") {
    const accent = typeof value === "string" ? value.trim() : "";
    if (/^#[0-9A-Fa-f]{6}$/.test(accent)) return accent.toUpperCase();
  } else if (key === "timeFormat" || key === "dateFormat") {
    const next = key === "timeFormat"
      ? displayFormat.castTimeFormat(value, loose)
      : displayFormat.castDateFormat(value, loose);
    if (next) return next;
  } else if (key === "undoSendDelaySeconds") {
    if (Number.isInteger(value) && value >= 0 && value <= 30) return value;
  } else if (key === "composeQuoteWidth") {
    if (Number.isInteger(value) && value >= 220 && value <= 720) return value;
  } else if (key === "syncHorizonDays") {
    if ([0, 180, 365].includes(value)) return value;
  } else if (key === "defaultScheduleDelayMinutes") {
    if (Number.isInteger(value) && value >= 0 && value <= 10080) return value;
  } else if (BOOLS.has(key) && typeof value === "boolean") {
    return value;
  }
  if (loose) return DEFAULTS[key];
  reject(key);
}

function readStore() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch (error) {
    if (error && (error.code === "ENOENT" || error instanceof SyntaxError)) return { ...DEFAULTS };
    throw error;
  }
  const store = { ...DEFAULTS };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return store;
  for (const key of Object.keys(store)) store[key] = cast(key, parsed[key], true);
  if (store.accent === "#7C3AED") store.accent = DEFAULTS.accent;
  return store;
}

function writeStore(store) {
  const dest = storePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, dest);
}

function answer(channel, args) {
  const getKey = GET[channel];
  if (getKey) return readStore()[getKey];
  const setKey = SET[channel];
  if (!setKey) return undefined;
  const store = readStore();
  store[setKey] = cast(setKey, args && args[0], false);
  writeStore(store);
  if (setKey === "mailNotificationsEnabled" || setKey === "mailNotificationPreview") {
    require("./mail/notifications").settingsChanged();
  }
  return store[setKey];
}

function syncHorizonDays() {
  return readStore().syncHorizonDays;
}

function notificationPreferences() {
  const store = readStore();
  return { enabled: store.mailNotificationsEnabled, preview: store.mailNotificationPreview };
}

module.exports = { answer, syncHorizonDays, notificationPreferences };
