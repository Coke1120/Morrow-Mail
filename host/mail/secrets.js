const { SERVICE } = require("./secret-service");
const reads = require("./secret-reads").createReads();

function backend() {
  if (process.env.MORROW_MAIL_SECRETS === "memory") {
    return require("./memory-secrets");
  }
  if (process.platform === "win32") {
    return require("./win-secrets");
  }
  // macOS / Linux fallback: macOS Keychain via `security`. Linux has no keychain CLI here;
  // callers should prefer MORROW_MAIL_SECRETS=memory for tests.
  return require("./mac-secrets");
}

module.exports = {
  setPassword(account, password) {
    const store = backend();
    reads.invalidate(store, account);
    return store.setPassword(account, password);
  },
  getPassword: (...args) => backend().getPassword(...args),
  getPasswordAsync: (account, options) => reads.get(backend(), account, options),
  revision: account => reads.revision(backend(), account),
  deletePassword(account) {
    const store = backend();
    reads.invalidate(store, account, true);
    return store.deletePassword(account);
  },
  get SERVICE() {
    return backend().SERVICE || SERVICE;
  },
};
