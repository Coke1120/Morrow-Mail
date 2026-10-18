"use strict";

const fs = require("fs");
const path = require("path");

// electron-builder skips rcedit when signAndEditExecutable is false, so the
// installed exe keeps Electron's icon and "GitHub, Inc." version strings.
// This hook writes the Morrow Mail icon and product name without signing.
function windowsFileVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version));
  if (!match) throw new Error(`Windows icon edit needs a numeric version, got ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] == null ? 0 : Number(match[4])];
}

async function editWindowsIcon(exePath, iconPath, metadata) {
  const { load } = require("resedit/cjs");
  const { load: loadPe } = require("pe-library/cjs");
  const ResEdit = await load();
  const pe = await loadPe();
  const exe = pe.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = pe.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const icons = iconFile.icons.map((item) => item.data);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
  } else {
    for (const group of groups) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons);
    }
  }
  const [major, minor, patch, build] = windowsFileVersion(metadata.version);
  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = viList[0];
  if (vi) {
    vi.setFileVersion(major, minor, patch, build, 1033);
    vi.setProductVersion(major, minor, patch, build, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: metadata.productName,
      ProductName: metadata.productName,
      CompanyName: metadata.companyName,
      LegalCopyright: metadata.copyright,
      InternalName: metadata.productName,
      OriginalFilename: `${metadata.productName}.exe`,
      FileVersion: metadata.version,
      ProductVersion: metadata.version,
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  const next = Buffer.from(exe.generate());
  const tmp = `${exePath}.icon-tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, exePath);
}

async function afterPack(context) {
  if (!context || context.electronPlatformName !== "win32") return;
  const pkg = require("../package.json");
  const productName = (context.packager && context.packager.appInfo && context.packager.appInfo.productFilename) || pkg.build.productName;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  if (!fs.existsSync(exePath)) throw new Error(`Windows executable missing: ${exePath}`);
  const author = pkg.author;
  const companyName = author && typeof author === "object" ? author.name : author || "Leo Ho";
  await editWindowsIcon(exePath, path.join(__dirname, "..", "build", "icon.ico"), {
    version: pkg.version,
    productName: pkg.build.productName,
    companyName,
    copyright: pkg.build.copyright || "",
  });
}

module.exports = afterPack;
module.exports.windowsFileVersion = windowsFileVersion;
module.exports.editWindowsIcon = editWindowsIcon;
