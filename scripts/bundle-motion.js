const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outfile = path.join(root, "renderer", "motion.bundle.js");

let esbuild;
try {
  esbuild = require("esbuild");
} catch (error) {
  if (fs.existsSync(outfile)) process.exit(0);
  console.error("esbuild is required to build renderer/motion.bundle.js");
  process.exit(1);
}

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: ["renderer/motion-ui.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome130"],
  outfile: "renderer/motion.bundle.js",
  minify: true,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});
