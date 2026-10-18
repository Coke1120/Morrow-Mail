// Electron patches `fs` so paths inside an asar are virtual. Reading the
// archive itself has to go through the unpatched module.
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();

// External UI archives are opt-in. An empty result means the host should
// load the bundled renderer instead.
function resolveAsarPath(explicit) {
  if (explicit) return explicit;
  const fromEnv = (process.env.MORROW_ASAR || "").trim();
  return fromEnv || null;
}

function openAsar(asarPath = resolveAsarPath()) {
  const target = asarPath;
  if (!target) {
    throw new Error(
      "MORROW_ASAR is not set. Leave it unset to boot the bundled renderer, or set it to an app.asar path (see docs/INDEPENDENT_UI.md)."
    );
  }
  if (!fs.existsSync(target)) {
    throw new Error(
      `UI asar missing at ${target}. Unset MORROW_ASAR to use the bundled renderer (see docs/INDEPENDENT_UI.md).`
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
  resolveAsarPath,
  openAsar,
  readFile,
};
