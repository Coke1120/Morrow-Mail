"use strict";
const fs = require("node:fs");
const path = require("node:path");
function describe(options = {}) {
  let packaged = false;
  try { packaged = require("electron").app?.isPackaged === true; } catch { /* source/Node fixture */ }
  if (options.packaged !== undefined) packaged = options.packaged === true;
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const launcherPath = packaged && resourcesPath ? path.join(resourcesPath, "morrow-mcp.cjs")
    : path.join(__dirname, "..", "..", "scripts", "morrow-mcp.js");
  let launcherAvailable = false;
  try { launcherAvailable = fs.statSync(launcherPath).isFile(); } catch { /* missing package: show unavailable */ }
  return { transport: "stdio", command: "node", launcherPath, launcherAvailable,
    sourceCheckout: !packaged, minimumNodeMajor: 20, platform: process.platform, remoteMcp: false };
}
module.exports = { describe };
