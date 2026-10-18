// Read-only audit of the actual executable produced by afterPack.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { verifyWindowsIcon } = require("./windows-icon");
const pkg = require("../package.json");

async function check(exePath) {
  const result = await verifyWindowsIcon(exePath, path.join(__dirname, "../build/icon.ico"), {
    productName: pkg.build.productName, version: pkg.version,
  });
  const resources = path.join(path.dirname(exePath), "resources");
  for (const file of ["icon.ico", "icon.png"]) {
    if (!fs.readFileSync(path.join(resources, file)).equals(fs.readFileSync(path.join(__dirname, "../build", file)))) {
      throw new Error(`Packaged ${file} differs from build/${file}`);
    }
  }
  const pe = await require("pe-library/cjs").load();
  const exe = pe.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const entries = pe.NtExecutableResource.from(exe).entries;
  const integrity = entries.find(entry => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR");
  if (!integrity) throw new Error("Missing Electron ASAR integrity record");
  const records = JSON.parse(Buffer.from(integrity.bin).toString());
  const record = records.find(row => row.file.replace(/\\/g, "/").toLowerCase() === "resources/app.asar");
  const header = require("@electron/asar").getRawHeader(path.join(resources, "app.asar")).headerString;
  const hash = crypto.createHash("sha256").update(header).digest("hex");
  if (!record || record.alg !== "SHA256" || record.value !== hash) throw new Error("ASAR integrity hash mismatch");
  console.log(JSON.stringify({ ...result, productName: pkg.build.productName, asarIntegrity: "verified" }));
  console.log("WINDOWS_ICON_CHECK_OK");
}
check(path.resolve(process.argv[2] || "dist/win-unpacked/Morrow Mail.exe")).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
