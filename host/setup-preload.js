const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiSetup", {
  get: () => ipcRenderer.invoke("host:aiGetConfig"),
  save: (input) => ipcRenderer.invoke("host:aiSaveConfig", input),
  test: () => ipcRenderer.invoke("host:aiTest"),
});
