const fs = require("fs");
const path = require("path");
const { answer: liveAnswer } = require("./mail/engine");
const { answer: mailAnswer } = require("./mailbox");
const { answer: draftAnswer } = require("./draft-write");
const { answer: brainAnswer } = require("./brain");
const { answer: translateAnswer } = require("./translate");
const { answer: settingsAnswer } = require("./settings");

const SESSION = {
  userId: "local-user",
  cogenId: "local-user",
  email: "leo@localhost",
  userName: "Leo",
  name: "Leo",
  displayName: "Leo",
  avatarUrl: "",
  accessToken: "local",
  provider: "local",
};

const OVERRIDES = {
  "auth:getSession": SESSION,
  "auth:logout": { success: true },
  "auth:getLoginEndpoints": { endpoints: [], activeId: "local" },
  "auth:getLoginMethods": { methods: [] },
  "app:getVersion": "1.0.2218",
  "shell:getState": { tabs: ["genmail"], active: "genmail" },
  "shell:getProjectTabs": null,
  "shell:getSpaceGates": {
    genspark: "enabled",
    genteam: "enabled",
    genmail: "enabled",
    gencode: "enabled",
  },
  "shell:getOrgSpaceGates": { genmail: "enabled" },
  "shell:getDogfoodGate": "disabled",
  "shell:getDeviceControlGate": "disabled",
  "shell:getGenmailBadgeDetail": null,
  "config:getDistributionSource": "genmail",
  "config:getEnv": { domain: "https://www.genspark.ai", name: "local" },
  "config:getLocale": "en-US",
  "genmail:userGetFeatureGates": {
    gkGenmailSignatureInject: false,
    gkAiInboxScheduleSend: false,
  },
  "genmail:userCenterGetMembership": null,
  // The August-campaign loader reads `.success` on the raw result. null throws.
  "promotion:getGenMailAugustStatus": {
    success: false,
    error: { code: "disabled", status: 0, retryable: false },
  },
  "referral:getOverview": {
    success: false,
    error: { code: "disabled", status: 0, retryable: false },
  },
  "genmail:configGetDogfoodPrefs": {},
  "genmail:configGetShowJevClassification": false,
  "genmail:configGetShowJevSemanticSearch": false,
  "genmail:configGetShowJevSemanticSearchEffective": false,
  "genmail:configGetSidebarFolderOrder": null,
  "genmail:configGetCalendarSidebarOrder": {},
  "genmail:configGetAiWriteAgenticEnabled": false,
  "genmail:configGetAiWriteV2Enabled": false,
  "genmail:configGetAiWriteV2Effective": false,
  "genmail:configGetCalendarGenTeamGroupChatEnabled": false,
  "genmail:configGetCalendarGenTeamGroupChatEffective": false,
  "genmail:keymapGetAll": {},
  "genmail:localeGetSystemRegion": "en-GB",
  "locale:get": "en-US",
  "window:isMaximized": false,
  "window:isFullScreen": false,
  "window:isFocused": true,
  "update:getState": {
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    version: null,
    progress: 0,
    error: null,
    installing: false,
  },
  "diag:consumeCrashNotice": null,
  "diag:getUploadState": null,
  // Shell's DesktopObservationIndicator reads config.capabilities.desktopA11y
  // whenever config is a non-null object. An empty object throws.
  "deviceControl:getConfig": {
    enabled: false,
    grantedAt: null,
    deviceId: null,
    workspace: null,
    mode: "per_invocation",
    capabilities: {
      fsWorkspace: { enabled: false },
      shell: { enabled: false, allowNetwork: false, fullTrust: false },
      fsBeyondWorkspace: { enabled: false, roots: [] },
      browser: {
        enabled: false,
        grantedAt: null,
        grantVersion: null,
        grantedCogenId: null,
        shareProfile: true,
      },
      desktop: { enabled: false, grantedAt: null, grantVersion: null },
      desktopInput: { enabled: false, grantedAt: null, grantVersion: null },
      desktopA11y: { enabled: false, grantedAt: null, grantVersion: null, grantedCogenId: null },
      desktopA11yProtected: { enabled: false, grantedAt: null, grantVersion: null, grantedCogenId: null },
    },
    pathPolicy: { denyGlobs: [] },
    commandAllowlist: [],
    approvalTier: "ask_when_risky",
    legacyFullTrustPending: false,
    neverAskConfirmedAt: null,
  },
  "deviceControl:getStatus": "disabled",
  "deviceControl:desktopA11yGetState": { phase: "paused", error: null },
  "deviceControl:desktopGetState": { phase: "closed", error: null },
  "deviceControl:desktopInputGetAvailability": { available: false },
  "deviceControl:browserGetState": null,
};

function mailEnvelope(data) {
  return { success: true, data };
}

function redact(value) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (/password|secret|apiKey|fileBytes|authorization/i.test(key)) return "[redacted]";
      return item;
    }).slice(0, 400);
  } catch {
    return "[unserializable]";
  }
}

function fallback(channel, args) {
  if (channel === "update:getState" || channel === "app:getVersion") {
    try {
      const updater = require("./updater");
      if (channel === "update:getState") return updater.snapshot();
      if (channel === "app:getVersion") {
        try {
          const { app } = require("electron");
          return app.getVersion();
        } catch {
          return require("../package.json").version;
        }
      }
    } catch { /* keep stub */ }
  }
  const live = liveAnswer(channel, args);
  if (live !== undefined) return live;
  const mail = mailAnswer(channel, args);
  if (mail !== undefined) return mail;
  const draft = draftAnswer(channel, args);
  if (draft !== undefined) return draft;
  const brain = brainAnswer(channel, args);
  if (brain !== undefined) return brain;
  const translated = translateAnswer(channel, args);
  if (translated !== undefined) return translated;
  // The Enabled/Effective fallback below would answer these getters with false.
  const setting = settingsAnswer(channel, args);
  if (setting !== undefined) return setting;
  if (Object.prototype.hasOwnProperty.call(OVERRIDES, channel)) {
    return OVERRIDES[channel];
  }
  if (channel.startsWith("mail:")) {
    if (/[Ll]ist|[Ss]earch|[Pp]reset/.test(channel)) return mailEnvelope([]);
    if (/[Cc]ount|[Uu]nread|[Bb]adge/.test(channel)) return mailEnvelope({ count: 0 });
    if (/[Mm]asked/.test(channel)) return mailEnvelope({});
    return mailEnvelope(null);
  }
  if (channel === "nativeAgent:home:skills" || channel === "nativeAgent:home:librarySkills") {
    return { success: true, data: [] };
  }
  if (channel.startsWith("calendar:") || channel.startsWith("nativeAgent:")) {
    return { success: true, data: null };
  }
  if (/Effective$|Enabled$/.test(channel)) return false;
  return null;
}

function createIpc(logPath) {
  const seen = new Set();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  function note(kind, channel) {
    const key = `${kind} ${channel}`;
    if (seen.has(key)) return;
    seen.add(key);
    fs.appendFileSync(logPath, `${key}\n`);
  }
  return {
    handle(_event, channel, ...args) {
      note("invoke", channel);
      if (args.length && channel.startsWith("mail:")) {
        fs.appendFileSync(logPath, `  args ${channel} ${redact(args)}\n`);
      }
      return fallback(channel, args);
    },
    send(_event, channel) {
      note("send", channel);
    },
  };
}

module.exports = { createIpc, SESSION };
