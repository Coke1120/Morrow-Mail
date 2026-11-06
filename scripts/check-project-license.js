const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const startup = require("../host/startup-error");
const { notices } = require("./bundle-notices");
const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const project = "https://github.com/Coke1120/Morrow-Mail";
const license = "https://www.apache.org/licenses/LICENSE-2.0";

async function run() {
  const pkg = require("../package.json");
  const lock = require("../package-lock.json");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(lock.packages[""].license, pkg.license);
  for (const [source, target] of [["LICENSE", "LICENSE.electron.txt"], ["LICENSES.chromium.html", "LICENSES.chromium.html"]]) {
    assert.ok(pkg.build.extraResources.some(row => row.from === "node_modules/electron/dist/" + source && row.to === "licenses/" + target),
      "retain Electron notices after macOS packaging cleanup");
  }
  assert.match(read("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
  assert.match(read("NOTICE"), /Copyright \(c\) 2026 Leo Ho \/ HWL-HK/);
  assert.match(read("NOTICE"), /does not withdraw rights/);
  assert.match(read("README.md"), /Commercial use is welcome/);
  assert.match(read("README.md"), /mailto:leo@hwl-hk\.com/);
  for (const file of ["LICENSE", "LICENSE-MIT", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(pkg.build.files.includes(file), "packaged license notice: " + file);
    assert.ok(read(file).trim());
  }
  // Keep the previous canonical MIT notice byte-for-byte, including its grant.
  assert.equal(crypto.createHash("sha256").update(read("LICENSE-MIT")).digest("hex"),
    "4bb216147ad284417b5c28c5db2c2dbbc937ebdab74da31386cd5ce18078498f");
  assert.equal(read("THIRD_PARTY_NOTICES.md"), notices(root));
  for (const name of ["motion", "framer-motion", "motion-dom", "motion-utils"]) {
    assert.equal(lock.packages["node_modules/" + name].license, "MIT");
  }
  assert.match(read("renderer/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION"), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read("renderer/vendor/pdfjs/cmaps/LICENSE"), /Adobe Systems Incorporated/);

  const html = new JSDOM(read("renderer/index.html"));
  for (const id of ["about-dialog", "changelog"]) {
    const dialog = html.window.document.getElementById(id);
    const links = [...dialog.querySelectorAll("a")];
    assert.ok(links.some(a => a.href === project && a.textContent === "GitHub"));
    assert.ok(links.some(a => a.href === license && a.textContent === "Apache License 2.0"));
    assert.ok(links.some(a => a.href === "mailto:leo@hwl-hk.com"));
    assert.match(dialog.textContent, /Commercial use is welcome/);
    for (const link of links.filter(a => a.target === "_blank")) assert.ok(link.relList.contains("noreferrer"));
  }
  html.window.close();

  const escaped = new JSDOM(startup.startupStatusHtml('9.8.7 <img src=x onerror="bad()">'));
  assert.match(escaped.window.document.querySelector(".version").textContent, /9\.8\.7 <img/);
  assert.equal(escaped.window.document.querySelector(".version img"), null);
  assert.equal(escaped.window.document.querySelector("main").getAttribute("aria-busy"), null,
    "product information remains available to assistive technology during preparation");
  escaped.window.close();

  // Exercise the real opening-window host function, including exact version and
  // browser routing. No Electron window, mailbox, profile or external call runs.
  const main = read("host/main.js");
  const start = main.indexOf("async function presentBootStatus()");
  const end = main.indexOf("async function presentBootFailure", start);
  assert.ok(start > 0 && end > start);
  let popup, navigate, openingUrl;
  const opened = [];
  const context = {
    bootWindow: null, bootFinished: false, bootFailed: false,
    startupStatusHtml: startup.startupStatusHtml, isStartupExternalUrl: startup.isStartupExternalUrl,
    app: { getVersion: () => "9.8.7-runtime" },
    shell: { openExternal: async url => { opened.push(url); } },
    BrowserWindow: class {
      constructor(options) {
        assert.equal(options.webPreferences.sandbox, true);
        assert.equal(options.webPreferences.nodeIntegration, false);
        this.webContents = {
          setWindowOpenHandler(handler) { popup = handler; },
          on(name, handler) { assert.equal(name, "will-navigate"); navigate = handler; },
        };
      }
      on() {}
      isDestroyed() { return false; }
      show() {}
      async loadURL(url) { openingUrl = url; }
    },
  };
  vm.createContext(context);
  await vm.runInContext(main.slice(start, end) + "\npresentBootStatus()", context);
  const opening = new JSDOM(decodeURIComponent(openingUrl.split(",").slice(1).join(",")));
  assert.equal(opening.window.document.querySelector(".version").textContent, "Version 9.8.7-runtime");
  assert.deepEqual([...opening.window.document.querySelectorAll("nav a")].map(a => a.href), [project, license]);
  for (const url of [project, license, "https://github.com/evil", project + "/../evil", project + "?redirect=evil",
    "https://github.com.evil.test/Coke1120/Morrow-Mail", "file:///tmp/evil", "javascript:bad()", "http://github.com/Coke1120/Morrow-Mail"]) {
    assert.equal(popup({ url }).action, "deny");
  }
  assert.deepEqual(opened, [project, license]);
  let prevented = false;
  navigate({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  opening.window.close();
  console.log("project-license-ok: preserved grants, bundled notices, package inputs, runtime version, fixed browser links and product/contact surfaces");
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
