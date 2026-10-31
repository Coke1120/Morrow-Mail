const { spawnSync } = require("child_process");
const { SERVICE } = require("./secret-service");
const perf = require("../performance-diagnostics");
const { createReader, TIMEOUT_MS, MAX_OUTPUT } = require("./keychain-reader");
const read = createReader({ command: "powershell.exe", decode: output => Buffer.from(output.trim(), "base64").toString("utf8") });

const STORE_DIR = "morrow-mail";

function ps(script) {
  return perf.sync("keychain.wait", () => spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT }
  ));
}

function targetOf(service, account) {
  const a = String(account).replace(/'/g, "''");
  return `${service}:${a}`.replace(/'/g, "''");
}

function writePassword(dirName, service, account, password) {
  const p = String(password).replace(/'/g, "''");
  const target = targetOf(service, account);
  const dir = String(dirName).replace(/'/g, "''");
  const script = `
\$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
\$bytes = [Text.Encoding]::UTF8.GetBytes('${p}')
\$dir = Join-Path \$env:LOCALAPPDATA '${dir}\\secrets'
New-Item -ItemType Directory -Force -Path \$dir | Out-Null
\$path = Join-Path \$dir ('${target}' -replace '[^A-Za-z0-9._-]','_')
\$prot = [Security.Cryptography.ProtectedData]::Protect(\$bytes, \$null, 'CurrentUser')
[IO.File]::WriteAllBytes(\$path, \$prot)
`;
  const result = ps(script);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || "Could not save the password to Windows DPAPI store.");
  }
}

function readScript(dirName, service, account, encoded = false) {
  const target = targetOf(service, account);
  const dir = String(dirName).replace(/'/g, "''");
  return `
\$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
\$dir = Join-Path \$env:LOCALAPPDATA '${dir}\\secrets'
\$path = Join-Path \$dir ('${target}' -replace '[^A-Za-z0-9._-]','_')
if (-not (Test-Path -LiteralPath \$path)) { exit 2 }
\$prot = [IO.File]::ReadAllBytes(\$path)
\$bytes = [Security.Cryptography.ProtectedData]::Unprotect(\$prot, \$null, 'CurrentUser')
[Console]::Out.Write(${encoded ? "[Convert]::ToBase64String(\$bytes)" : "[Text.Encoding]::UTF8.GetString(\$bytes)"})
`;
}

function readPassword(dirName, service, account) {
  const result = ps(readScript(dirName, service, account));
  if (result.error) throw Object.assign(new Error("Secure storage could not be read. Try again."), {
    code: result.error.code === "ETIMEDOUT" ? "secure_storage_timeout" : "secure_storage_unavailable",
  });
  if (result.status === 2) return null;
  if (result.status !== 0) return null;
  return result.stdout;
}

function deleteAt(dirName, service, account) {
  const target = targetOf(service, account);
  const dir = String(dirName).replace(/'/g, "''");
  const script = `
\$dir = Join-Path \$env:LOCALAPPDATA '${dir}\\secrets'
\$path = Join-Path \$dir ('${target}' -replace '[^A-Za-z0-9._-]','_')
if (Test-Path -LiteralPath \$path) { Remove-Item -LiteralPath \$path -Force }
`;
  ps(script);
}

function setPassword(account, password) {
  writePassword(STORE_DIR, SERVICE, account, password);
}

function getPassword(account) {
  return readPassword(STORE_DIR, SERVICE, account);
}

function getPasswordAsync(account, options) {
  return perf.measure("keychain.wait", () => read(["-NoProfile", "-NonInteractive", "-Command", readScript(STORE_DIR, SERVICE, account, true)], options));
}

function deletePassword(account) {
  deleteAt(STORE_DIR, SERVICE, account);
}

module.exports = {
  setPassword,
  getPassword,
  getPasswordAsync,
  deletePassword,
  SERVICE,
  STORE_DIR,
};
