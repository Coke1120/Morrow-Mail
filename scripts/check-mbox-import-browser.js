"use strict";
// Only synthetic mail and a loopback fixture. Requires local Playwright/Chromium.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const assert = require("node:assert/strict");
const L = require("../host/mail/local-folders"), { createImporter } = require("../host/mail/mbox-import");
const root = path.join(__dirname, ".."), output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-mbox-browser");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-browser-")), store = L.createLocalStore(path.join(dir, "local.sqlite"));
  const importer = createImporter({ store });
  const mime = await require("../host/mail/remote").buildRaw({ from: "Synthetic <sender@fixture.invalid>", to: "owner@fixture.invalid",
    subject: "Imported archive — 合成郵件", text: "Searchable synthetic archived evidence",
    html: '<p>Imported evidence<script>window.fixtureExecuted=true</script><img src="https://fixture.invalid/tracker"><img src="cid:logo"></p>',
    attachments: [{ filename: "offline-evidence.bin", content: Buffer.from([0, 255, 1, 2, 3]) }, { filename: "inline.png", cid: "logo", content: Buffer.from("synthetic image") }] });
  const source = path.join(dir, "Exported-Thunderbird-Inbox-synthetic-correspondence-2026");
  fs.writeFileSync(source, Buffer.concat([Buffer.from("From - Thu Nov  5 10:00:00 2026\n"), mime]));
  const calls = [], errors = [], external = [];
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, "." + decodeURIComponent(req.url.split("?")[0]));
    if (!target.startsWith(root + path.sep)) { res.statusCode = 403; res.end(); return; }
    try {
      let bytes = fs.readFileSync(target);
      if (target.endsWith("/renderer/app.js")) bytes = bytes.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("content-type", target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(bytes);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", failure => errors.push(failure.message));
    await page.route("**/*", route => {
      if (route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.exposeFunction("fixtureInvoke", async (channel, params = {}) => {
      calls.push(channel); let data;
      if (channel === "mail:localFolders") data = store.account();
      else if (channel === "mail:mboxJobs") data = importer.list();
      else if (channel === "mail:mboxPick") data = await importer.select([source]);
      else if (channel === "mail:mboxStart") data = importer.start(params.jobId, { destination: params.folderId, variant: params.variant });
      else if (channel === "mail:mboxStatus") data = importer.status(params.jobId);
      else if (channel === "mail:mboxCancel") data = importer.cancel(params.jobId);
      else if (channel === "mail:listFromCache") data = store.list(params);
      else if (channel === "mail:openEmail") data = { email: store.verify(params.emailId), isThread: false, threadMessages: [] };
      else if (channel === "mail:markRead") { store.update(params.emailId, { isRead: params.isRead }); data = { outcomes: [], pending: [] }; }
      else if (channel === "mail:listSnoozed") data = { records: [] };
      else throw new Error("Unexpected synthetic browser invoke: " + channel);
      return { success: true, data };
    });
    await page.addInitScript(() => { window.morrow = { invoke: (channel, payload) => window.fixtureInvoke(channel, payload), on() {} }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(async () => {
      state.accounts = []; state.accountId = "__morrow_local__"; state.folderId = "local-folder:archive";
      state.prefs.images = false; state.prefs.loadImages = false;
      renderSettingsAccounts = refreshMailVacation = () => {};
      setNavCollapsed(true); document.documentElement.dataset.view = "mail"; wireSelection(); wireOrganize();
      await loadLocalFolders(); renderAccounts();
    });
    const trigger = page.getByRole("button", { name: "Import MBOX…", exact: true }); await trigger.click();
    assert.equal(await page.locator("#mbox-start").isDisabled(), true);
    await page.locator("#mbox-pick").click(); await page.waitForFunction(() => !!mboxReview?.job);
    assert.equal(await page.locator("#mbox-start").isEnabled(), true);
    assert.match(await page.locator("#mbox-files").textContent(), /Exported-Thunderbird/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { state.prefs.theme = theme; applyLook(state.prefs); document.getElementById("mbox-form").scrollTop = 0; }, theme);
        const bounds = await page.locator("#mbox-import").evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, width: node.clientWidth }));
        assert(bounds.left >= 0 && bounds.right <= width && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
        if ((width === 1440 && theme === "light") || (width === 390 && theme === "dark")) await page.screenshot({ path: path.join(output, `import-${width}-${theme}.png`) });
      }
    }
    await page.keyboard.press("Escape"); assert.equal(await page.locator("#mbox-import").evaluate(node => node.open), false);
    assert.equal(importer.list()[0].status, "review");
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await page.emulateMedia({ reducedMotion: "reduce" }); await trigger.click();
    await page.locator("#mbox-start").click();
    await page.waitForFunction(() => mboxReview?.job?.status === "completed" && !mboxReview.job.running);
    assert.match(await page.locator("#mbox-status").textContent(), /1 imported/);
    await page.locator("#mbox-status").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, "import-result-390-dark.png") });
    await page.locator("#mbox-close").click();
    await page.locator("button.message").first().click();
    await page.waitForFunction(() => state.email?.isLocal === true);
    assert.equal(await page.locator("#reader script").count(), 0); assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined);
    assert.match(await page.locator("#reader").textContent(), /offline-evidence.bin/);
    await page.screenshot({ path: path.join(output, "offline-reader-390-dark.png") });
    await page.evaluate(() => showFeatures());
    const feature = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "MBOX import", exact: true }) });
    await feature.scrollIntoViewIfNeeded(); assert.match(await feature.textContent(), /No directories are scanned/);
    await page.screenshot({ path: path.join(output, "features-390-dark.png") });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert(!calls.some(channel => /Network|Provider|:send|^ai|^emailBrain/.test(channel)));
    console.log("mbox-browser-ok: actual import review/result/reader/Features; 1440/390 light/dark, keyboard Escape/focus, reduced motion; no page errors, no external requests");
  } finally { await browser.close(); await importer.stop(); store.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(failure => { console.error(failure); process.exitCode = 1; });
