"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");

function createGate() {
  const context = new AsyncLocalStorage();
  const pending = new Set();
  let closed = false;
  function run(operation) {
    // Nested work belongs to an admitted operation; it must be allowed to finish.
    if (closed && !context.getStore()?.active) throw new Error("An update is preparing to restart. Try again after it finishes or is cancelled.");
    const admission = { active: true };
    const token = {};
    pending.add(token);
    const done = () => { admission.active = false; pending.delete(token); };
    try {
      const result = context.run(admission, operation);
      if (result && typeof result.then === "function") return Promise.resolve(result).finally(done);
      done();
      return result;
    } catch (error) { done(); throw error; }
  }
  async function prepare({ timeoutMs = 30000 } = {}) {
    if (closed) throw new Error("An update is already preparing to restart.");
    closed = true;
    const deadline = Date.now() + timeoutMs;
    // A timeout never authorizes installation. The caller must resume and abort.
    while (pending.size) {
      if (Date.now() >= deadline) throw new Error("Mail or settings operations are still running. Update cancelled; retry when they finish.");
      await new Promise(resolve => setTimeout(resolve, Math.min(20, timeoutMs)));
    }
  }
  return { run, prepare, resume() { closed = false; }, get closed() { return closed; }, get pending() { return pending.size; } };
}

const gate = createGate();
const preparing = new WeakSet();
function requestRendererQuiescence(win, ipcMain, { timeoutMs = 10000 } = {}) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.reject(new Error("The application window must be open to review the update."));
  const contents = win.webContents;
  if (preparing.has(contents)) return Promise.reject(new Error("Update preparation is already in progress."));
  preparing.add(contents);
  const nonce = randomUUID();
  return new Promise((resolve, reject) => {
    let finished = false;
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      preparing.delete(contents);
      if (!contents.isDestroyed()) contents.send("host:updateResume", { nonce });
    };
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener("host:updatePrepared", onReply);
      contents.removeListener("destroyed", onDestroyed);
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) { resume(); reject(error); } else resolve(resume);
    };
    const onDestroyed = () => finish(new Error("The application window closed before update preparation completed."));
    const onReply = (event, payload) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || payload?.nonce !== nonce) return;
      finish(payload.ok === true ? null : new Error("Save or discard open drafts and settings, finish pending work, and retry the update."));
    };
    const timer = setTimeout(() => finish(new Error("The application did not confirm it is safe to restart. Update cancelled.")), timeoutMs);
    ipcMain.on("host:updatePrepared", onReply);
    contents.once("destroyed", onDestroyed);
    try { contents.send("host:updatePrepareForInstall", { nonce }); } catch (error) { finish(error); }
  });
}

module.exports = { createGate, gate, requestRendererQuiescence };
