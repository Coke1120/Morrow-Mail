const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outfile = path.join(root, "renderer", "pdf-preview.bundle.js");
const pdfjs = path.join(root, "node_modules", "pdfjs-dist");
const vendor = path.join(root, "renderer", "vendor", "pdfjs");
const cmapReady = path.join(vendor, "cmaps", "Adobe-CNS1-UCS2.bcmap");
const fontReady = path.join(vendor, "standard_fonts", "LiberationSans-Regular.ttf");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.endsWith(".map")) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

let esbuild;
try {
  esbuild = require("esbuild");
} catch (error) {
  if (fs.existsSync(outfile) && fs.existsSync(cmapReady) && fs.existsSync(fontReady)) process.exit(0);
  console.error("esbuild is required to build renderer/pdf-preview.bundle.js");
  process.exit(1);
}

if (!fs.existsSync(pdfjs)) {
  if (fs.existsSync(outfile) && fs.existsSync(cmapReady) && fs.existsSync(fontReady)) process.exit(0);
  console.error("pdfjs-dist is required to build PDF preview");
  process.exit(1);
}

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: ["renderer/pdf-preview.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome130"],
  outfile: "renderer/pdf-preview.bundle.js",
  minify: true,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});

copyDir(path.join(pdfjs, "cmaps"), path.join(vendor, "cmaps"));
copyDir(path.join(pdfjs, "standard_fonts"), path.join(vendor, "standard_fonts"));
