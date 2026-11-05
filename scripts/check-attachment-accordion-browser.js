"use strict";

// Actual renderer and Chromium input/layout. Synthetic IPC; no real mail/files.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-attachment-accordion");

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
    const file = req.url === "/axe.js" ? require.resolve(process.env.MORROW_AXE_MODULE || "axe-core/axe.min.js") : path.resolve(root, "." + req.url.split("?")[0]);
    if (req.url !== "/axe.js" && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let body = fs.readFileSync(file);
      if (file.endsWith("/renderer/app.js")) body = body.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors = [], network = [], accessibility = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
      network.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(() => {
      window.requests = [];
      const listeners = new Set();
      window.morrow = {
        on(channel, fn) { if (channel === "mail:attachmentProgress") listeners.add(fn); return () => listeners.delete(fn); },
        async invoke(channel, payload) {
          requests.push({ channel, payload });
          if (channel === "mail:fetchAttachmentBytes") return { success: true, data: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNb8AAAAASUVORK5CYII="), ch => ch.charCodeAt(0)) };
          if (channel === "mail:downloadAttachment" && window.holdSave) {
            return new Promise(resolve => {
              window.finishSave = () => resolve({ success: true, data: {} });
              for (const fn of listeners) fn({ requestId: payload.requestId, phase: "downloading", loaded: 1024 });
            });
          }
          if (["mail:downloadAttachment", "mail:openAttachmentExternally", "mail:downloadAttachmentsZip", "mail:cancelAttachmentRequest"].includes(channel)) return { success: true, data: {} };
          throw new Error("Unexpected synthetic IPC: " + channel);
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      wire();
      state.accounts = [{ id: "fixture", email: "reader@example.invalid", platform: "imap", folders: { primary: [], more: [] } }];
      state.accountId = "fixture"; state.folderId = "Inbox"; state.prefs.images = false;
      window.fixtureMail = { id: "fixture-mail", accountId: "fixture", subject: "Project records", from: "Alex <alex@example.invalid>", to: "reader@example.invalid", date: "2026-11-05T08:00:00Z", bodyComplete: true,
        textBody: "Please review the attached records. Send the updated list when it is ready.\n\nThank you,\nAlex", attachments: [
          { id: "image-1", filename: "project-image.png", size: 94000 },
          { id: "image-2", filename: "image001.jpg", size: 7000 },
          { id: "image-3", filename: "image001.jpg", size: 7000 },
          { id: "image-4", filename: "image001.jpg", size: 7000 },
          { id: "sheet-1", filename: "Project records for review.xlsx", size: 33000 },
          { id: "sheet-2", filename: "2024 - Invoice amount review.xlsx", size: 13000 },
          { id: "sheet-3", filename: "Long-filename-without-spaces-" + "a".repeat(80) + ".xlsx", size: 21000 },
          { id: "sheet-4", filename: "Samples selected.xlsx", size: 27000 },
        ] };
      state.email = fixtureMail; state.emails = [fixtureMail]; state.thread = [fixtureMail];
      renderAccounts(); showMail(); renderReader(false);
    });
    const toggle = () => page.locator("#reader .attachment-toggle");
    const zip = () => page.locator("#reader .attachment-zip");
    const list = () => page.locator("#reader .attachments");
    const requestCount = channel => page.evaluate(channel => requests.filter(row => row.channel === channel).length, channel);
    const shot = name => page.screenshot({ path: path.join(output, name + ".png") });

    assert.equal(await toggle().getAttribute("aria-expanded"), "false");
    assert.equal(await list().isVisible(), false); assert.equal(await zip().isVisible(), true);
    assert.equal(await requestCount("mail:fetchAttachmentBytes"), 0);
    assert.equal(await toggle().getAttribute("aria-label"), "Attachments (8)");
    await shot("desktop-collapsed");
    await toggle().focus(); await page.keyboard.press("Tab");
    assert.equal(await zip().evaluate(el => el === document.activeElement), true, "collapsed file actions are excluded from Tab order");
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Space");
    assert.equal(await list().isVisible(), true); assert.equal(await toggle().getAttribute("aria-expanded"), "true");
    assert.equal(await toggle().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Enter"); assert.equal(await list().isVisible(), false);
    await zip().click(); await page.waitForFunction(() => requests.some(row => row.channel === "mail:downloadAttachmentsZip"));
    assert.equal(await toggle().getAttribute("aria-expanded"), "false", "ZIP does not toggle the list");
    assert.deepEqual(await page.evaluate(() => requests.find(row => row.channel === "mail:downloadAttachmentsZip").payload.attachmentIds), ["image-1", "image-2", "image-3", "image-4", "sheet-1", "sheet-2", "sheet-3", "sheet-4"]);

    await toggle().click(); await page.keyboard.press("Tab");
    assert.equal(await zip().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#reader .attachment-name").first().evaluate(el => el === document.activeElement), true);
    await page.getByRole("button", { name: "Save image001.jpg, attachment 3 of 8", exact: true }).click();
    await page.getByRole("button", { name: "Open image001.jpg, attachment 4 of 8", exact: true }).click();
    await page.getByRole("button", { name: "Save Project records for review.xlsx", exact: true }).click();
    assert.equal(await page.evaluate(() => requests.find(row => row.channel === "mail:downloadAttachment").payload.attachmentId), "image-3");
    assert.equal(await page.evaluate(() => requests.find(row => row.channel === "mail:openAttachmentExternally").payload.attachmentId), "image-4");
    assert.equal(await page.locator("#reader .attachments li").nth(4).getByRole("button", { name: /^Preview/ }).count(), 0);
    await page.locator("#reader .attachment-actions").nth(1).getByRole("button", { name: /^Preview/ }).click();
    await page.locator("#attachment-preview[open]").waitFor();
    await page.waitForFunction(() => $("attachment-preview-image").naturalWidth === 1);
    assert.equal(await page.evaluate(() => requests.find(row => row.channel === "mail:fetchAttachmentBytes").payload.attachmentId), "image-2");
    await page.locator("#attachment-preview-close").click();

    // Collapse changes visibility only: an active Save remains visible and cancellable.
    await page.evaluate(() => { window.holdSave = true; });
    await page.getByRole("button", { name: "Save Samples selected.xlsx", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishSave === "function");
    await toggle().click();
    assert.equal(await page.getByRole("button", { name: "Cancel save", exact: true }).isVisible(), true);
    assert.match(await page.locator("#attachment-transfer-activity").textContent(), /Samples selected.xlsx.*received/);
    assert.equal(await requestCount("mail:cancelAttachmentRequest"), 0);
    await page.getByRole("button", { name: "Cancel save", exact: true }).click();
    assert.equal(await requestCount("mail:cancelAttachmentRequest"), 1);
    await page.evaluate(() => { window.finishSave(); window.holdSave = false; });
    await page.waitForFunction(() => attachmentTasks.size === 0);
    await toggle().click();
    await page.evaluate(() => { state.email = { ...fixtureMail, textBody: fixtureMail.textBody + "\nUpdated." }; renderReader(false); });
    assert.equal(await toggle().getAttribute("aria-expanded"), "true");
    await page.evaluate(() => showStatus(""));

    await page.addScriptTag({ url: "/axe.js" });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const layout of ["right", "bottom", "reader", "narrow", "narrow320"]) {
        await page.setViewportSize({ width: layout === "narrow320" ? 320 : layout === "narrow" ? 360 : 1280, height: 900 });
        await page.evaluate(layout => {
          if (["reader", "narrow", "narrow320"].includes(layout)) document.documentElement.dataset.window = "reader";
          else { delete document.documentElement.dataset.window; state.prefs.mailView.layout = layout; applyMailView(); }
          renderReader(false);
        }, layout);
        assert.equal(await list().isVisible(), true);
        const bounds = await page.locator("#reader .attachment-card").evaluate(card => {
          const reader = card.closest("#reader").getBoundingClientRect(), box = card.getBoundingClientRect();
          return { inside: box.left >= reader.left && box.right <= reader.right + 1, overflow: card.scrollWidth > card.clientWidth + 1,
            filenames: [...card.querySelectorAll(".attachment-name")].every(el => el.scrollWidth <= el.clientWidth + 1) };
        });
        assert.deepEqual(bounds, { inside: true, overflow: false, filenames: true }, theme + " " + layout + " reflows without clipping names or actions");
        const result = await page.evaluate(() => axe.run(document.querySelector("#reader .attachment-card"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
        accessibility.push({ theme, layout, violations: result.violations });
        assert.deepEqual(result.violations.map(row => row.id), [], theme + " " + layout + " attachment accessibility");
        if ((theme === "light" && layout === "right") || (theme === "dark" && layout === "narrow")) await shot(theme === "light" ? "desktop-expanded" : "narrow-dark-expanded");
      }
    }
    assert.equal(await toggle().locator(".attachment-chevron").evaluate(el => getComputedStyle(el).transitionDuration), "0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await toggle().locator(".attachment-chevron").evaluate(el => getComputedStyle(el).transitionDuration), "0.12s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      delete document.documentElement.dataset.window; state.prefs.mailView.layout = "right"; applyMailView();
      state.email = { ...fixtureMail, id: "another-message" }; renderReader(false);
    });
    assert.equal(await list().isVisible(), false, "a different message starts collapsed");
    await page.evaluate(() => { paintFeatureCatalog(); showFeatures(); });
    const help = page.locator("#features-catalog");
    assert.match(await help.textContent(), /Message attachments start collapsed/);
    assert.match(await help.textContent(), /Collapse does not cancel transfers/);
    await shot("features-help");
    assert.deepEqual(network, [], "no external network was used");
    assert.deepEqual(errors, [], "no renderer errors");
    fs.writeFileSync(path.join(output, "checks.json"), JSON.stringify({ checks: "keyboard, visibility, ZIP/Preview/Save/Open identity, transfer cancellation, refresh, themes/layout, motion and rendered Features", accessibility, errors, externalRequests: network }, null, 2) + "\n");
    console.log("attachment-accordion-browser-ok: keyboard, real attachment actions, active transfers, refresh, right/bottom/separate/narrow, light/dark, motion, axe and rendered Features");
    console.log("Evidence: " + output);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
