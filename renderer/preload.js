const { contextBridge, ipcRenderer } = require("electron");

const INVOKE = [
  "app:getVersion",
  "mail:listAccounts",
  "mail:listImapSmtpPresets",
  "mail:connectImapSmtp",
  "mail:addAccount",
  "mail:removeAccount",
  "mail:listFromCache",
  "mail:listFromNetwork",
  "mail:openEmail",
  "mail:markRead",
  "mail:search",
  "mail:listThreadMessages",
  "mail:downloadAttachment",
  "mail:openAttachmentExternally",
  "mail:upsertDraft",
  "mail:send",
];

const EVENTS = [
  "mail:accountsUpdated",
  "mail:emailsUpdated",
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
