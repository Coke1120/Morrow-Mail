const { spawnSync } = require("child_process");

const SERVICE = "genmail-exact";

function run(args) {
  return spawnSync("security", args, { encoding: "utf8" });
}

function setPassword(account, password) {
  const result = run([
    "add-generic-password",
    "-s", SERVICE,
    "-a", account,
    "-U",
    "-w", password,
  ]);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new Error(detail || "Could not save the password to the keychain.");
  }
}

function getPassword(account) {
  const result = run(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  if (result.status !== 0) return null;
  return result.stdout.replace(/\n$/, "");
}

function deletePassword(account) {
  run(["delete-generic-password", "-s", SERVICE, "-a", account]);
}

module.exports = { setPassword, getPassword, deletePassword, SERVICE };
