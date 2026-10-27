const { spawnSync } = require("child_process");
const { SERVICE } = require("./secret-service");
const perf = require("../performance-diagnostics");
const { createReader, TIMEOUT_MS, MAX_OUTPUT } = require("./keychain-reader");
const read = createReader();

function run(args) {
  const result = perf.sync("keychain.wait", () => spawnSync("security", args, {
    encoding: "utf8", timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
  }));
  if (result.error) {
    const timeout = result.error.code === "ETIMEDOUT";
    throw Object.assign(new Error(timeout ? "Secure storage did not respond in time. Check access and retry."
      : "Secure storage is unavailable. Try again."), { code: timeout ? "secure_storage_timeout" : "secure_storage_unavailable" });
  }
  return result;
}

function write(service, account, password) {
  const result = run([
    "add-generic-password",
    "-s", service,
    "-a", account,
    "-U",
    "-w", password,
  ]);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new Error(detail || "Could not save the password to the keychain.");
  }
}

function find(service, account) {
  const result = run(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (result.status !== 0) return null;
  return result.stdout.replace(/\n$/, "");
}

function remove(service, account) {
  run(["delete-generic-password", "-s", service, "-a", account]);
}

function setPassword(account, password) {
  write(SERVICE, account, password);
}

function getPassword(account) {
  return find(SERVICE, account);
}

function getPasswordAsync(account, options) {
  return perf.measure("keychain.wait", () => read(["find-generic-password", "-s", SERVICE, "-a", account, "-w"], options));
}

function deletePassword(account) {
  remove(SERVICE, account);
}

module.exports = { setPassword, getPassword, getPasswordAsync, deletePassword, SERVICE };
