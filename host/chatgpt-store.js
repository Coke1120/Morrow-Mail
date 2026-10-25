// SIWC credentials belong to the local main process, separate from mailbox
// grants and ai.json. Never fall back to Electron's plaintext Linux backend.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function secureStorage() {
  const { safeStorage } = require("electron");
  if (!safeStorage || !safeStorage.isEncryptionAvailable()
    || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
    throw new Error("ChatGPT sign-in needs the operating system's secure credential storage. Unlock it and retry.");
  }
  return safeStorage;
}

function createStore({ directory = () => require("./ai-config").userDataDir(), storage = secureStorage } = {}) {
  const location = () => path.join(directory(), "chatgpt-credentials.enc");
  return {
    available() { try { storage(); return true; } catch { return false; } },
    read() {
      let bytes;
      try { bytes = fs.readFileSync(location()); }
      catch (error) {
        if (error.code === "ENOENT") return { hostId: "", activeId: "", registrations: [] };
        throw new Error("ChatGPT credentials could not be read. Check local file permissions.");
      }
      try {
        const record = JSON.parse(storage().decryptString(bytes));
        if (record.version !== 1 || typeof record.hostId !== "string" || !Array.isArray(record.registrations)) throw new Error();
        return record;
      } catch {
        throw new Error("ChatGPT credentials are locked or damaged. Unlock secure storage and retry; the saved file has been preserved.");
      }
    },
    write(record) {
      const bytes = storage().encryptString(JSON.stringify({ ...record, version: 1 }));
      const dest = location();
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const temp = `${dest}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
        fs.renameSync(temp, dest);
      } finally {
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
  };
}

module.exports = { createStore };
