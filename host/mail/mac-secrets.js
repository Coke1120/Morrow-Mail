const { spawnSync } = require("child_process");
const { SERVICE, LEGACY_SERVICE, migrateRead } = require("./secret-service");

function run(args) {
  return spawnSync("security", args, { encoding: "utf8" });
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
  return migrateRead(
    (service) => find(service, account),
    (service, password) => write(service, account, password),
    (service) => remove(service, account),
  );
}

function deletePassword(account) {
  remove(SERVICE, account);
  remove(LEGACY_SERVICE, account);
}

module.exports = { setPassword, getPassword, deletePassword, SERVICE, LEGACY_SERVICE };
