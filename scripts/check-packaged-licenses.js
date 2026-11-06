// Verify real electron-builder output, including native-module unpacked files
// and dependencies relocated by the packager. This does not launch the app.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const root = path.join(__dirname, "..");

function run(archive) {
  assert.ok(archive && fs.existsSync(archive), "Pass the packaged resources/app.asar path");
  const read = name => asar.extractFile(archive, name);
  const files = asar.listPackage(archive).map(name => name.replace(/^\//, ""));
  const bundled = new Set(["motion", "framer-motion", "motion-dom", "motion-utils"]);
  const packages = new Map();
  for (const file of files.filter(name => name.startsWith("node_modules/") && name.endsWith("/package.json"))) {
    const pkg = JSON.parse(read(file));
    const key = pkg.name + "@" + pkg.version;
    if (!packages.has(key)) packages.set(key, []);
    packages.get(key).push(path.posix.dirname(file));
  }
  const required = ["LICENSE", "LICENSE-MIT", "NOTICE", "THIRD_PARTY_NOTICES.md",
    "renderer/vendor/pdfjs/cmaps/LICENSE", "renderer/vendor/pdfjs/standard_fonts/LICENSE_FOXIT",
    "renderer/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION"];
  for (const file of required) assert.deepEqual(read(file), fs.readFileSync(path.join(root, file)), file);
  assert.equal(JSON.parse(read("package.json")).license, "Apache-2.0");
  let count = 0;
  for (const [dir, entry] of Object.entries(require("../package-lock.json").packages)) {
    const source = path.join(root, dir);
    if (!dir || entry.dev || !fs.existsSync(source)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    if (bundled.has(pkg.name)) continue; // Full license texts are in THIRD_PARTY_NOTICES.md.
    const locations = packages.get(pkg.name + "@" + pkg.version) || [];
    for (const file of fs.readdirSync(source).filter(name => /^(license|licence|copying|notice|copyright)/i.test(name) && fs.statSync(path.join(source, name)).isFile())) {
      const expected = fs.readFileSync(path.join(source, file));
      assert.ok(locations.some(location => {
        const name = location + "/" + file;
        return files.includes(name) && read(name).equals(expected);
      }), "Missing/changed runtime notice: " + pkg.name + "@" + pkg.version + "/" + file);
      count++;
    }
  }
  const resources = path.dirname(archive);
  // Explicit extraResources survives electron-builder's top-level macOS cleanup.
  for (const [name, source] of [["LICENSE.electron.txt", "LICENSE"], ["LICENSES.chromium.html", "LICENSES.chromium.html"]]) {
    assert.deepEqual(fs.readFileSync(path.join(resources, "licenses", name)),
      fs.readFileSync(path.join(root, "node_modules/electron/dist", source)), "Electron runtime notice: " + name);
  }
  console.log(`packaged-licenses-ok: ${required.length} exact project/vendor notice files, ${count} unchanged runtime notice files (including relocated dependencies), Electron notices and Apache-2.0 package metadata`);
}

if (require.main === module) {
  try { run(process.argv[2]); } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { run };
