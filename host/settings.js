const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./paths");

const DEFAULTS = {
  theme: "light",
  accent: "#193C34",
  conversationView: true,
  remoteImages: false,
  undoSendDelaySeconds: 5,
  snooze: true,
  aiWriteAutoOpenOnReply: false,
  showFolderChips: true,
  sidebarGmailFoldersExpanded: true,
  sidebarOutlookFoldersExpanded: false,
  composeQuoteWidth: 420,
};

const GET = {
  "config:getTheme": "theme",
  "morrow:configGetAccent": "accent",
  "morrow:configGetConversationViewEnabled": "conversationView",
  "morrow:configGetAutoLoadRemoteImages": "remoteImages",
  "morrow:configGetUndoSendDelaySeconds": "undoSendDelaySeconds",
  "morrow:configGetSnoozeEffective": "snooze",
  "morrow:configGetAiWriteAutoOpenOnReply": "aiWriteAutoOpenOnReply",
  "morrow:configGetShowFolderChips": "showFolderChips",
  "morrow:configGetSidebarGmailFoldersExpanded": "sidebarGmailFoldersExpanded",
  "morrow:configGetSidebarOutlookFoldersExpanded": "sidebarOutlookFoldersExpanded",
  "morrow:configGetComposeQuoteWidth": "composeQuoteWidth",
};

const SET = {
  "config:setTheme": "theme",
  "morrow:configSetAccent": "accent",
  "morrow:configSetConversationViewEnabled": "conversationView",
  "morrow:configSetAutoLoadRemoteImages": "remoteImages",
  "morrow:configSetUndoSendDelaySeconds": "undoSendDelaySeconds",
  "morrow:configSetSnoozeEffective": "snooze",
  "morrow:configSetAiWriteAutoOpenOnReply": "aiWriteAutoOpenOnReply",
  "morrow:configSetShowFolderChips": "showFolderChips",
  "morrow:configSetSidebarGmailFoldersExpanded": "sidebarGmailFoldersExpanded",
  "morrow:configSetSidebarOutlookFoldersExpanded": "sidebarOutlookFoldersExpanded",
  "morrow:configSetComposeQuoteWidth": "composeQuoteWidth",
};

const BOOLS = new Set([
  "conversationView",
  "remoteImages",
  "snooze",
  "aiWriteAutoOpenOnReply",
  "showFolderChips",
  "sidebarGmailFoldersExpanded",
  "sidebarOutlookFoldersExpanded",
]);

function storePath() {
  return path.join(userDataDir(), "settings.json");
}

function reject(key) {
  if (key === "theme") throw new Error("Theme must be light or dark");
  if (key === "accent") throw new Error("Accent must be a #RRGGBB color");
  if (key === "undoSendDelaySeconds") throw new Error("Undo send delay must be 0 to 30 seconds");
  if (key === "composeQuoteWidth") throw new Error("Quote pane width must be 220 to 720");
  throw new Error("Expected on or off");
}

function cast(key, value, loose) {
  if (key === "theme") {
    const theme = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (theme === "light" || theme === "dark") return theme;
  } else if (key === "accent") {
    const accent = typeof value === "string" ? value.trim() : "";
    if (/^#[0-9A-Fa-f]{6}$/.test(accent)) return accent.toUpperCase();
  } else if (key === "undoSendDelaySeconds") {
    if (Number.isInteger(value) && value >= 0 && value <= 30) return value;
  } else if (key === "composeQuoteWidth") {
    if (Number.isInteger(value) && value >= 220 && value <= 720) return value;
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
  return store[setKey];
}

module.exports = { answer };
