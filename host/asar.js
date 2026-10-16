// Electron patches `fs` so paths inside an asar are virtual. Reading the
// Genspark (or bundled) archive itself has to go through the unpatched module.
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();
const path = require("path");

const DEFAULT_GENSPARK_ASAR =
  "/Applications/Genspark Super App.app/Contents/Resources/app.asar";

function bundledUiAsar() {
  try {
    const { app } = require("electron");
    if (app) {
      const candidate = path.join(process.resourcesPath || "", "ui.asar");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // plain node
  }
  const local = path.join(__dirname, "..", "resources", "ui.asar");
  if (fs.existsSync(local)) return local;
  return null;
}

function resolveAsarPath(explicit) {
  const fromEnv = (process.env.GENMAIL_ASAR || "").trim();
  if (explicit) return explicit;
  if (fromEnv) return fromEnv;
  const bundled = bundledUiAsar();
  if (bundled) return bundled;
  return DEFAULT_GENSPARK_ASAR;
}

function openAsar(asarPath = resolveAsarPath()) {
  const target = asarPath;
  if (!fs.existsSync(target)) {
    throw new Error(
      `UI asar missing at ${target}. Install Genspark Super App, set GENMAIL_ASAR, or place resources/ui.asar (see docs/PACKAGING.md).`
    );
  }
  const fd = fs.openSync(target, "r");
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  if (head.readUInt32LE(0) !== 4) {
    throw new Error("unexpected asar pickle header");
  }
  const headerSize = head.readUInt32LE(4);
  const header = Buffer.alloc(headerSize);
  fs.readSync(fd, header, 0, headerSize, 8);
  const jsonLen = header.readUInt32LE(4);
  const tree = JSON.parse(header.subarray(8, 8 + jsonLen).toString("utf8"));
  const files = new Map();
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, rel);
      else files.set(rel, { offset: Number(child.offset), size: child.size });
    }
  })(tree, "");
  return { fd, dataOffset: 8 + headerSize, files, path: target };
}

function readFile(archive, rel) {
  const meta = archive.files.get(rel);
  if (!meta) return null;
  const buf = Buffer.alloc(meta.size);
  fs.readSync(archive.fd, buf, 0, meta.size, archive.dataOffset + meta.offset);
  return buf;
}

module.exports = {
  ASAR: DEFAULT_GENSPARK_ASAR,
  resolveAsarPath,
  openAsar,
  readFile,
  bundledUiAsar,
};
