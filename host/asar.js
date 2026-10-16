// Electron patches `fs` so paths inside an asar are virtual. Reading the
// Genspark archive itself has to go through the unpatched module.
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();

const ASAR = "/Applications/Genspark Super App.app/Contents/Resources/app.asar";

function openAsar(path = ASAR) {
  const fd = fs.openSync(path, "r");
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
  return { fd, dataOffset: 8 + headerSize, files, path };
}

function readFile(archive, rel) {
  const meta = archive.files.get(rel);
  if (!meta) return null;
  const buf = Buffer.alloc(meta.size);
  fs.readSync(archive.fd, buf, 0, meta.size, archive.dataOffset + meta.offset);
  return buf;
}

module.exports = { ASAR, openAsar, readFile };
