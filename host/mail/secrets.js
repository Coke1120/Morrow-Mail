const { SERVICE } = require("./secret-service");

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
  setPassword: (...args) => backend().setPassword(...args),
  getPassword: (...args) => backend().getPassword(...args),
  deletePassword: (...args) => backend().deletePassword(...args),
  get SERVICE() {
    return backend().SERVICE || SERVICE;
  },
};
