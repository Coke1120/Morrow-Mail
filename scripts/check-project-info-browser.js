// Synthetic browser checks only: no real mailbox, credentials, AI or updater.
// Optional tools may be installed outside the checkout through these env paths.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { startupStatusHtml } = require("../host/startup-error");
const root = path.resolve(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-project-info");
const version = require("../package.json").version;
const project = "https://github.com/Coke1120/Morrow-Mail";
const license = "https://www.apache.org/licenses/LICENSE-2.0";

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const type = { ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(url.pathname)] || "text/html";
    res.setHeader("Content-Type", type);
    if (url.pathname === "/axe.js") return res.end(fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE || "axe-core/axe.min.js")));
    if (url.pathname === "/startup") return res.end(startupStatusHtml("9.8.7-runtime"));
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/renderer/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const externalRequests = [];
    await page.route("**/*", route => {
      if (route.request().url().startsWith(base + "/")) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    async function accessible(selector) {
      await page.addScriptTag({ url: base + "/axe.js" });
      const violations = await page.evaluate(selector => axe.run(document.querySelector(selector), {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      }).then(result => result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))), selector);
      assert.deepEqual(violations, [], selector + " accessibility");
    }
    async function links(selector) {
      assert.equal(await page.locator(selector + ` a[href="${project}"]`).textContent(), "GitHub");
      assert.equal(await page.locator(selector + ` a[href="${license}"]`).textContent(), "Apache License 2.0");
    }
    for (const width of [480, 390]) {
      await page.setViewportSize({ width, height: 420 });
      await page.goto(base + "/startup");
      assert.equal(await page.locator(".version").textContent(), "Version 9.8.7-runtime");
      await links("nav");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await accessible("main");
      await page.screenshot({ path: path.join(output, `startup-${width}.png`) });
    }

    await page.addInitScript({ path: path.join(root, "scripts/fixtures/google-onboarding-startup.js") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + "/renderer/index.html?version=" + version);
    await page.locator("#changelog[open]").waitFor();
    assert.equal(await page.locator("#changelog-version").textContent(), "Morrow Mail " + version);
    await links("#changelog");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.locator("#changelog").evaluate(d => d.scrollWidth <= d.clientWidth), true);
        await accessible("#changelog");
        await page.screenshot({ path: path.join(output, `whats-new-${theme}-${width}.png`) });
      }
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(version => localStorage.getItem("synthetic.changelogSeen") === version, version);
    // Retained acknowledgements stay quiet; adding links must not reset them.
    await page.reload();
    await page.waitForFunction(() => syntheticStartup.calls.includes("morrow:configGetChangelogSeen"));
    assert.equal(await page.locator("#changelog").evaluate(d => d.open), false);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close()));
    await page.locator("#rail-about").click();
    await page.locator("#about-dialog[open]").waitFor();
    await page.evaluate(() => showUpdate({ version: "9.9.9", downloaded: true, requiresExplicitInstall: true, platform: "darwin" }));
    assert.equal(await page.locator("#about-version").textContent(), "Version " + version, "available update does not replace installed version");
    assert.match(await page.locator("#about-update-status").textContent(), /verified/);
    assert.equal(await page.locator("#about-update-install").isVisible(), true);
    await links("#about-dialog");
    assert.match(await page.locator("#about-dialog").textContent(), /Commercial use is welcome/);
    assert.equal(await page.locator('#about-dialog a[href="mailto:leo@hwl-hk.com"]').textContent(), "leo@hwl-hk.com");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.locator("#about-dialog").evaluate(d => d.scrollWidth <= d.clientWidth), true);
        await accessible("#about-dialog");
        await page.locator("#about-close").focus();
        for (const href of ["https://hwl-hk.com/en/morrow-mail/privacy", "https://hwl-hk.com/en/morrow-mail/terms",
          license, project, project + "/blob/main/NOTICE", "mailto:leo@hwl-hk.com", "https://github.com/sponsors/Coke1120",
          "https://buymeacoffee.com/coke1120"]) {
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement.href), href, "keyboard reaches project and contact links in order");
        }
        await page.locator("#about-close").focus();
        await page.screenshot({ path: path.join(output, `about-updates-${theme}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; showUpdate({}); });
    await page.locator("#about-close").focus();
    await page.screenshot({ path: path.join(output, "about-readme.png") });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#about-dialog").evaluate(d => d.open), false);
    await page.locator("#rail-shortcuts").click();
    const feature = page.locator(".feature-card").filter({ hasText: "Version, source and license" });
    await feature.waitFor();
    assert.match(await feature.textContent(), /once per app version/);
    await feature.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "features-project-info.png") });
    assert.deepEqual(externalRequests, []);
    assert.equal(await page.evaluate(() => syntheticStartup.calls.some(c => /mail:send|aiDraftWrite:start|Timeline.*Generate/.test(c))), false);
    console.log("project-info-browser-ok: startup/runtime version, once-per-version modal, About/update state, commercial contact, Features, light/dark 1280/390px, keyboard and WCAG A/AA");
    console.log("screenshots: " + output);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
