const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiSetup", {
  get: () => ipcRenderer.invoke("host:aiGetConfig"),
  save: (input) => ipcRenderer.invoke("host:aiSaveConfig", input),
  test: (input) => ipcRenderer.invoke("host:aiTest", input),
  listModels: (input) => ipcRenderer.invoke("host:aiListModels", input),
  consentStatus: () => ipcRenderer.invoke("host:aiConsentStatus"),
  consentGrant: input => ipcRenderer.invoke("host:aiConsentGrant", input),
  consentRevoke: () => ipcRenderer.invoke("host:aiConsentRevoke"),
  chatgptStatus: () => ipcRenderer.invoke("host:chatgptStatus"),
  chatgptStart: (input) => ipcRenderer.invoke("host:chatgptStart", input),
  chatgptCallback: (url) => ipcRenderer.invoke("host:chatgptCallback", url),
  chatgptCancel: () => ipcRenderer.invoke("host:chatgptCancel"),
  chatgptSignOut: (id) => ipcRenderer.invoke("host:chatgptSignOut", id),
  chatgptSelect: (id) => ipcRenderer.invoke("host:chatgptSelect", id),
  chatgptPreferences: (input) => ipcRenderer.invoke("host:chatgptPreferences", input),
  chatgptResumeUsage: () => ipcRenderer.invoke("host:chatgptResumeUsage"),
});
