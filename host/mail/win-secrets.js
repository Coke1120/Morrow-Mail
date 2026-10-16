const { spawnSync } = require("child_process");

const SERVICE = "genmail-exact";

function ps(script) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
}

function setPassword(account, password) {
  const a = String(account).replace(/'/g, "''");
  const p = String(password).replace(/'/g, "''");
  const target = `${SERVICE}:${a}`.replace(/'/g, "''");
  const script = `
\$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
\$bytes = [Text.Encoding]::UTF8.GetBytes('${p}')
[Security.Cryptography.ProtectedData]::Protect(\$bytes, \$null, 'CurrentUser') | Out-Null
\$dir = Join-Path \$env:LOCALAPPDATA 'genmail-rea\\secrets'
New-Item -ItemType Directory -Force -Path \$dir | Out-Null
\$path = Join-Path \$dir ('${target}' -replace '[^A-Za-z0-9._:-]','_')
\$prot = [Security.Cryptography.ProtectedData]::Protect(\$bytes, \$null, 'CurrentUser')
[IO.File]::WriteAllBytes(\$path, \$prot)
`;
  const result = ps(script);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || "Could not save the password to Windows DPAPI store.");
  }
}

function getPassword(account) {
  const a = String(account).replace(/'/g, "''");
  const target = `${SERVICE}:${a}`.replace(/'/g, "''");
  const script = `
\$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
\$dir = Join-Path \$env:LOCALAPPDATA 'genmail-rea\\secrets'
\$path = Join-Path \$dir ('${target}' -replace '[^A-Za-z0-9._:-]','_')
if (-not (Test-Path -LiteralPath \$path)) { exit 2 }
\$prot = [IO.File]::ReadAllBytes(\$path)
\$bytes = [Security.Cryptography.ProtectedData]::Unprotect(\$prot, \$null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString(\$bytes))
`;
  const result = ps(script);
  if (result.status === 2) return null;
  if (result.status !== 0) return null;
  return result.stdout;
}

function deletePassword(account) {
  const a = String(account).replace(/'/g, "''");
  const target = `${SERVICE}:${a}`.replace(/'/g, "''");
  const script = `
\$dir = Join-Path \$env:LOCALAPPDATA 'genmail-rea\\secrets'
\$path = Join-Path \$dir ('${target}' -replace '[^A-Za-z0-9._:-]','_')
if (Test-Path -LiteralPath \$path) { Remove-Item -LiteralPath \$path -Force }
`;
  ps(script);
}

module.exports = { setPassword, getPassword, deletePassword, SERVICE };
