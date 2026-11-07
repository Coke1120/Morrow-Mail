"use strict";
const path = require("node:path");
const fs = require("node:fs");
const root = path.join(__dirname, "..");
function bundle(outfile = path.join(root, "resources", "morrow-mcp.cjs")) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  require("esbuild").buildSync({ entryPoints: [path.join(root, "scripts", "morrow-mcp.js")], outfile,
    bundle: true, platform: "node", target: "node20", format: "cjs", legalComments: "eof" });
  return outfile;
}
if (require.main === module) { bundle(); console.log("Bundled local MCP adapter (separate Node.js 20+ runtime required)."); }
module.exports = { bundle };
