const SERVICE = "genmail-exact";

function impl() {
  if (process.env.GENMAIL_MAIL_SECRETS === "memory") {
    return require("./memory-secrets");
  }
  if (process.platform === "win32") {
    return require("./win-secrets");
  }
  // macOS / Linux fallback: macOS Keychain via `security`. Linux has no keychain CLI here;
  // callers should prefer GENMAIL_MAIL_SECRETS=memory for tests.
  return require("./mac-secrets");
}

const backend = impl();

module.exports = {
  setPassword: (...a) => backend.setPassword(...a),
  getPassword: (...a) => backend.getPassword(...a),
  deletePassword: (...a) => backend.deletePassword(...a),
  SERVICE: backend.SERVICE || SERVICE,
};
