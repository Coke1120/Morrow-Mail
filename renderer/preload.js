const { contextBridge, ipcRenderer } = require("electron");

const INVOKE = [
  "app:getVersion",
  "host:updateGetState",
  "host:updateCheck",
  "host:updateInstall",
  "config:getTheme",
  "genmail:configGetAccent",
  "genmail:configGetConversationViewEnabled",
  "genmail:configGetAutoLoadRemoteImages",
  "genmail:configGetUndoSendDelaySeconds",
  "genmail:configGetSnoozeEffective",
  "mail:listAccounts",
  "mail:listImapSmtpPresets",
  "mail:connectImapSmtp",
  "mail:addAccount",
  "mail:removeAccount",
  "mail:listFromCache",
  "mail:listFromNetwork",
  "mail:openEmail",
  "mail:markRead",
  "mail:toggleStar",
  "mail:search",
  "mail:listThreadMessages",
  "mail:downloadAttachment",
  "mail:openAttachmentExternally",
  "mail:archive",
  "mail:threadArchive",
  "mail:delete",
  "mail:threadTrash",
  "mail:moveToFolder",
  "mail:undoRemoval",
  "mail:snoozeThread",
  "mail:unsnoozeThread",
  "mail:listSnoozed",
  "mail:upsertDraft",
  "mail:send",
  "mail:scheduleSend",
  "mail:listScheduled",
  "mail:listSignatures",
  "mail:translateStart",
  "mail:translateCancel",
  "aiDraftWrite:start",
  "aiDraftWrite:cancel",
  "aiDraftWrite:replySuggestions",
];

const EVENTS = [
  "mail:accountsUpdated",
  "mail:emailsUpdated",
  "mail:translate:event",
  "aiDraftWrite:event",
];

const invokeSet = new Set(INVOKE);
const eventSet = new Set(EVENTS);

contextBridge.exposeInMainWorld("genmail", {
  invoke(channel, payload) {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error("Unsupported channel"));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, handler) {
    if (!eventSet.has(channel) || typeof handler !== "function") return function () {};
    const wrapped = (_event, data) => handler(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
