const { contextBridge, ipcRenderer } = require("electron");

const INVOKE = [
  "app:getVersion",
  "host:updateGetState",
  "host:updateCheck",
  "host:updateInstall",
  "config:getTheme",
  "config:setTheme",
  "genmail:configGetAccent",
  "genmail:configSetAccent",
  "genmail:configGetConversationViewEnabled",
  "genmail:configSetConversationViewEnabled",
  "genmail:configGetAutoLoadRemoteImages",
  "genmail:configSetAutoLoadRemoteImages",
  "genmail:configGetUndoSendDelaySeconds",
  "genmail:configSetUndoSendDelaySeconds",
  "genmail:configGetSnoozeEffective",
  "genmail:configSetSnoozeEffective",
  "genmail:configGetAiWriteAutoOpenOnReply",
  "genmail:configSetAiWriteAutoOpenOnReply",
  "genmail:configGetShowFolderChips",
  "genmail:configSetShowFolderChips",
  "genmail:configGetShowOneClickTidy",
  "genmail:configSetShowOneClickTidy",
  "genmail:configGetShowOneClickTidyEffective",
  "genmail:configGetSidebarGmailFoldersExpanded",
  "genmail:configSetSidebarGmailFoldersExpanded",
  "genmail:configGetSidebarOutlookFoldersExpanded",
  "genmail:configSetSidebarOutlookFoldersExpanded",
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
  "mail:tidyInbox",
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
  "mail:upsertSignature",
  "mail:deleteSignature",
  "mail:translateStart",
  "mail:translateCancel",
  "aiDraftWrite:start",
  "aiDraftWrite:cancel",
  "aiDraftWrite:replySuggestions",
  "emailBrain:getCached",
  "emailBrain:refresh",
  "emailBrain:rebuild",
  "emailBrain:addWritingRule",
  "emailBrain:setWritingRule",
  "emailBrain:deleteWritingRule",
  "emailBrain:getCategories",
  "emailBrain:saveCategories",
  "emailBrain:addCategoryViaPrompt",
  "emailBrain:getSkills",
  "emailBrain:getLibrarySkills",
  "emailBrain:runSkill",
  "nativeAgent:home:skills",
  "nativeAgent:home:librarySkills",
];

const EVENTS = [
  "mail:accountsUpdated",
  "mail:emailsUpdated",
  "mail:translate:event",
  "aiDraftWrite:event",
  "emailBrain:updated",
  "emailBrain:refreshState",
  "emailBrain:rebuildState",
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
