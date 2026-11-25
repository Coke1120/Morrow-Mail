const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("receiptPdf", {
  bytes: () => ipcRenderer.invoke("receipt-pdf:bytes"),
  ready: () => ipcRenderer.invoke("receipt-pdf:ready"),
  save: () => ipcRenderer.invoke("receipt-pdf:save"),
  cancel: () => ipcRenderer.invoke("receipt-pdf:cancel"),
});
