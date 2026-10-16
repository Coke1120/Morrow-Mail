const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./paths");

// shortcut: stored only, the shell applies theme, images, undo, and snooze when it reads them
const DEFAULTS = {
  theme: "light",
  accent: "#7C3AED",
  conversationView: true,
  remoteImages: false,
  undoSendDelaySeconds: 5,
  snooze: true,
};

const GET = {
  "config:getTheme": "theme",
  "genmail:configGetAccent": "accent",
  "genmail:configGetConversationViewEnabled": "conversationView",
  "genmail:configGetAutoLoadRemoteImages": "remoteImages",
  "genmail:configGetUndoSendDelaySeconds": "undoSendDelaySeconds",
  "genmail:configGetSnoozeEffective": "snooze",
};

const SET = {
  "config:setTheme": "theme",
  "genmail:configSetAccent": "accent",
  "genmail:configSetConversationViewEnabled": "conversationView",
  "genmail:configSetAutoLoadRemoteImages": "remoteImages",
  "genmail:configSetUndoSendDelaySeconds": "undoSendDelaySeconds",
  "genmail:configSetSnoozeEffective": "snooze",
};

const BOOLS = new Set(["conversationView", "remoteImages", "snooze"]);

function storePath() {
  return path.join(userDataDir("genmail-exact"), "settings.json");
}

function reject(key) {
  if (key === "theme") throw new Error("Theme must be light or dark");
  if (key === "accent") throw new Error("Accent must be a #RRGGBB color");
  if (key === "undoSendDelaySeconds") throw new Error("Undo send delay must be 0 to 30 seconds");
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
