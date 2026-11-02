"use strict";

// Native Chromium dialogs and full renderer wiring, with fake IPC persistence.
// No host auth store, credentials, mailbox data, grants or provider calls are used.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-bot-confirm");

(async () => {
  const server = http.createServer((req, res) => {
    try {
      const target = path.resolve(root, "." + req.url.split("?")[0]);
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const isAxe = req.url === "/axe.js";
      let data = fs.readFileSync(isAxe ? require.resolve(process.env.MORROW_AXE_MODULE || "axe-core/axe.min.js") : target);
      if (target.endsWith("/renderer/app.js")) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".png") ? "image/png" : "text/html");
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const context = await browser.newContext({ reducedMotion, viewport: { width: 1280, height: 960 } });
      const page = await context.newPage(), errors = [], external = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        if (route.request().url().startsWith(origin + "/")) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      await page.addInitScript(() => {
        window.requests = []; window.failMint = false; window.pauseMint = false;
        window.fixtureAccess = () => ({ enabled: false, listen: { listening: false },
          accounts: [{ accountId: "alpha", email: "alpha@example.test" }, { accountId: "beta", email: "beta@example.test" }],
          grants: JSON.parse(localStorage.getItem("synthetic.bot-grants") || "[]"), drafts: [], sends: [], audit: [] });
        window.morrow = { on() { return () => {}; }, async invoke(channel, payload) {
          requests.push({ channel, payload });
          if (channel === "bot:getAccess") return { success: true, data: fixtureAccess() };
          if (channel === "bot:mintGrant") {
            if (pauseMint) await new Promise(resolve => { window.releaseMint = resolve; });
            if (failMint) return { success: false, error: { message: "Synthetic persistence failure. Please retry." } };
            const grant = { ...payload, clientId: "fixture-bot", live: true, proactive: null };
            localStorage.setItem("synthetic.bot-grants", JSON.stringify([grant]));
            return { success: true, data: { secret: "mock-not-a-credential", grant, access: fixtureAccess() } };
          }
          if (/^(mail:send|bot:setEnabled|bot:configureProactive)$/.test(channel)) throw Error("Unexpected mutation: " + channel);
          return { success: true, data: [] };
        } };
      });
      const initialize = () => page.evaluate(async () => { wire(); setSettingsFold("bot", true, false); await loadBotAccess(); openDialog("settings"); });
      const fill = async () => {
        await page.locator("#bot-label").fill("Hermes fixture");
        await page.locator("#bot-platform").selectOption("hermes_agent");
        await page.locator('#bot-accounts input[value="alpha"]').check();
        if (!await page.locator("#bot-grant-options").evaluate(node => node.open)) await page.locator("#bot-grant-options summary").click();
        await page.locator('[data-cap="mail.send"]').check(); await page.locator("#bot-expiry").selectOption("never");
      };
      const start = async () => { await page.locator("#bot-mint-btn").click(); await page.waitForFunction(() => document.getElementById("confirm-title").textContent === "No expiry" && document.getElementById("confirm").open); };
      const next = async () => {
        await page.locator("#confirm-ok").click();
        await page.waitForFunction(() => document.getElementById("confirm-ok").textContent === "Allow sending");
        await page.waitForTimeout(260); // Drain the native close task and old motion.
        assert.equal(await page.evaluate(() => !!confirmResult), true);
        assert.match(await page.locator("#confirm-body").textContent(), /alpha@example.test/);
        assert.doesNotMatch(await page.locator("#confirm-body").textContent(), /beta@example.test/);
      };
      const mintCount = () => page.evaluate(() => requests.filter(row => row.channel === "bot:mintGrant").length);
      await page.goto(origin + "/renderer/index.html"); await initialize(); await fill();
      await start(); await page.locator("#confirm-cancel").click(); await page.locator("#confirm").waitFor({ state: "hidden" });
      await start(); await next(); await page.keyboard.press("Escape"); await page.locator("#confirm").waitFor({ state: "hidden" });
      assert.equal(await mintCount(), 0);
      assert.equal(await page.evaluate(() => document.getElementById("settings").contains(document.activeElement)), true);
      await start(); await next();
      for (let n = 0; n < 5; n++) {
        await page.keyboard.press("Tab");
        // Native Tab can visit browser chrome; page focus must stay in the
        // top dialog rather than returning to the inert Settings controls.
        assert.equal(await page.evaluate(() => !document.hasFocus() || document.getElementById("confirm").contains(document.activeElement)), true);
      }
      await page.addScriptTag({ url: origin + "/axe.js" });
      const violations = await page.evaluate(async () => (await axe.run(document.getElementById("confirm"), {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      })).violations.map(row => row.id));
      assert.deepEqual(violations, []);
      await page.screenshot({ path: path.join(output, `allow-sending-${reducedMotion}.png`) });
      await page.evaluate(() => { pauseMint = true; });
      await page.locator("#confirm-ok").press("Enter");
      await page.waitForFunction(() => requests.some(row => row.channel === "bot:mintGrant"));
      await page.locator("#confirm").waitFor({ state: "hidden" });
      await page.locator("#bot-mint-btn").click(); assert.equal(await mintCount(), 1);
      await page.evaluate(() => releaseMint()); await page.locator("#bot-secret[open]").waitFor();
      const saved = await page.evaluate(() => fixtureAccess().grants[0]);
      assert.deepEqual(saved.accountIds, ["alpha"]); assert.ok(saved.capabilities.includes("mail.send"));
      assert.deepEqual(saved.expiry, { kind: "never", neverConfirmed: true }); assert.equal(saved.platform, "hermes_agent");
      assert.match(await page.locator("#bot-status").textContent(), /Bot created.*Access is still off/);
      await page.locator("#bot-secret-close").click(); await page.locator("#bot-secret").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.getElementById("bot-secret-value").textContent === "");
      await page.reload(); await initialize(); assert.match(await page.locator("#bot-grants").textContent(), /Hermes fixture/);
      await page.locator("#bot-add-client > summary").click(); await fill(); await page.evaluate(() => { failMint = true; });
      await start(); await next(); await page.locator("#confirm-ok").click();
      await page.waitForFunction(() => document.getElementById("bot-status").textContent.includes("Synthetic persistence failure"));
      assert.equal(await page.locator("#bot-secret").evaluate(node => node.open), false);
      await page.setViewportSize({ width: 820, height: 740 });
      await page.evaluate(() => { failMint = false; }); await start(); await next();
      await page.screenshot({ path: path.join(output, `narrow-${reducedMotion}.png`) });
      await page.locator("#confirm-cancel").click(); await page.locator("#confirm").waitFor({ state: "hidden" });
      for (const cap of ["mail.archive", "mail.read_state.write", "mail.trash"]) {
        const input = page.locator(`[data-cap="${cap}"]`);
        assert.equal(await input.isChecked(), false); await input.check();
      }
      const reviewChanges = async () => {
        await start(); await next(); await page.locator("#confirm-ok").click();
        await page.waitForFunction(() => document.getElementById("confirm-ok").textContent === "Allow mail changes");
        await page.waitForTimeout(260); assert.equal(await page.evaluate(() => !!confirmResult), true);
        const text = await page.locator("#confirm-body").textContent();
        for (const phrase of ["archive mail", "mark mail read or unread", "move mail to Trash", "alpha@example.test", "never permanently deletes"]) assert.ok(text.includes(phrase));
        assert.ok(!text.includes("beta@example.test"));
      };
      await reviewChanges(); await page.keyboard.press("Escape"); await page.locator("#confirm").waitFor({ state: "hidden" });
      const beforeChanges = await mintCount();
      await reviewChanges(); await page.setViewportSize({ width: 1280, height: 960 });
      await page.addScriptTag({ url: origin + "/axe.js" });
      assert.deepEqual(await page.evaluate(async () => (await axe.run(document.getElementById("confirm"), {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      })).violations.map(row => row.id)), []);
      await page.screenshot({ path: path.join(output, `mail-changes-${reducedMotion}.png`) });
      await page.setViewportSize({ width: 820, height: 740 });
      await page.screenshot({ path: path.join(output, `mail-changes-narrow-${reducedMotion}.png`) });
      await page.locator("#confirm-ok").press("Enter"); await page.locator("#bot-secret[open]").waitFor();
      assert.equal(await mintCount(), beforeChanges + 1);
      const consent = await page.evaluate(() => fixtureAccess().grants[0].mailActionConsent);
      assert.deepEqual(consent, { accountIds: ["alpha"], capabilities: ["mail.archive", "mail.read_state.write", "mail.trash"] });
      await page.evaluate(() => paintFeatureCatalog());
      assert.match(await page.locator("#features-catalog").textContent(), /No expiry and Allow sending are separate reviews/);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      await context.close();
    }
    console.log(JSON.stringify({ result: "passed", checks: "native queued-close sequence, motion/reduced motion, cancel/Escape, focus trap, keyboard allow, duplicate clicks, fake persistence/reload/failure, separate default-off mail-change scopes and third review, narrow UI, Features, zero axe violations", output }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
