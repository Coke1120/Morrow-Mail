"use strict";

// Real renderer, native form validation and accessibility in Chromium. Fake IPC
// stores synthetic settings only; no host credentials, mail or Push are used.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-hermes-browser");

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
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
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
        window.requests = []; window.savedCredential = false;
        window.fixtureGrant = () => JSON.parse(localStorage.getItem("synthetic.grant") || JSON.stringify({
          clientId: "fixture-bot", label: "Hermes fixture", platform: "hermes_agent", live: true, revision: 1,
          accountIds: ["a"], capabilities: ["mail.headers.read"], proactive: null,
        }));
        window.fixtureAccess = () => ({ enabled: false, listen: { listening: false },
          accounts: [{ accountId: "a", email: "fixture@example.test" }], grants: [fixtureGrant()], drafts: [], sends: [], audit: [] });
        window.morrow = { on() { return () => {}; }, async invoke(channel, payload) {
          // Record only whether the synthetic secret was entered, never its value.
          requests.push({ channel, payload: payload && { ...payload, secret: !!payload.secret } });
          if (channel === "bot:getAccess") return { success: true, data: fixtureAccess() };
          if (channel === "bot:configureProactive") {
            if (payload.enabled && payload.backgroundConfirmed !== true) throw Error("Missing synthetic permission");
            if (payload.webhookMode === "hermes_hmac_v2" && payload.enabled && !payload.secret && !savedCredential) throw Error("Missing synthetic secret");
            const grant = fixtureGrant();
            const { clientId, platform, secret, clearSecret, backgroundConfirmed, ...proactive } = payload;
            savedCredential = clearSecret ? false : !!secret || savedCredential;
            grant.platform = platform; grant.revision++; grant.proactive = { ...proactive, hasSecret: savedCredential };
            localStorage.setItem("synthetic.grant", JSON.stringify(grant));
            return { success: true, data: fixtureAccess() };
          }
          if (/^(mail:send|bot:setEnabled|bot:mintGrant)$/.test(channel)) throw Error("Unexpected mutation: " + channel);
          return { success: true, data: [] };
        } };
      });
      const initialize = () => page.evaluate(async () => { wire(); setSettingsFold("bot", true, false); await loadBotAccess(); openDialog("settings"); });
      const field = name => page.locator(`[data-notify-field="${name}"]`);
      const saves = () => page.evaluate(() => requests.filter(row => row.channel === "bot:configureProactive"));
      await page.goto(origin + "/renderer/index.html"); await initialize();
      await page.locator(".bot-proactive > summary").click();
      assert.equal(await field("webhookMode").inputValue(), "hermes_hmac_v2");
      assert.equal(await field("allow").isChecked(), false); assert.equal((await saves()).length, 0);
      await field("webhookUrl").fill("http://127.0.0.1:8644/p/email/webhooks/morrow-mail");
      await field("account-a").check(); await field("allow").check();
      assert.equal(await field("secret").evaluate(node => node.required), true);
      await page.locator(".bot-proactive button[type=submit]").click();
      assert.equal((await saves()).length, 0, "native validation blocks missing HMAC secret");
      assert.equal(await field("secret").evaluate(node => node === document.activeElement), true);
      await field("secret").fill("synthetic-browser-secret");
      assert.equal(await field("allow").isChecked(), false, "secret edits require renewed background permission");
      await field("allow").check(); await field("webhookMode").selectOption("bearer");
      assert.equal(await field("allow").isChecked(), false); assert.equal(await field("secret").inputValue(), "");
      assert.equal(await field("secret").evaluate(node => node.required), false);
      await field("webhookMode").selectOption("hermes_hmac_v2");
      await field("secret").fill("synthetic-browser-secret"); await field("allow").check();
      await page.addScriptTag({ url: origin + "/axe.js" });
      const violations = () => page.evaluate(async () => (await axe.run(document.querySelector(".bot-proactive"), {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      })).violations.map(row => ({ id: row.id, targets: row.nodes.map(node => node.target) })));
      assert.deepEqual(await violations(), []);
      await field("webhookMode").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `hermes-${reducedMotion}.png`) });
      await field("allow").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `hermes-permission-${reducedMotion}.png`) });
      await page.locator(".bot-proactive button[type=submit]").press("Enter");
      await page.waitForFunction(() => document.getElementById("bot-status").textContent.includes("Proactive notify saved"));
      const saved = (await saves()).at(-1).payload;
      assert.equal(saved.webhookMode, "hermes_hmac_v2"); assert.equal(saved.backgroundConfirmed, true);
      assert.deepEqual(saved.accountIds, ["a"]); assert.equal(saved.includeBody, false); assert.equal(saved.secret, true);
      assert.equal(await field("allow").isChecked(), false); assert.equal(await field("secret").inputValue(), "");
      assert.match(await page.locator("#bot-grants").textContent(), /Paused until bot access is listening/);
      await page.reload(); await initialize(); await page.locator(".bot-proactive > summary").click();
      assert.equal(await field("webhookMode").inputValue(), "hermes_hmac_v2"); assert.equal(await field("allow").isChecked(), false);
      await page.evaluate(() => {
        const grant = fixtureGrant(); delete grant.proactive.webhookMode;
        localStorage.setItem("synthetic.grant", JSON.stringify(grant));
      });
      await page.reload(); await initialize(); await page.locator(".bot-proactive > summary").click();
      assert.equal(await field("webhookMode").inputValue(), "bearer", "legacy Hermes settings stay Bearer");
      await page.evaluate(() => {
        const access = fixtureAccess(); access.grants[0].proactiveStatus = { lastCode: "HERMES_HTTP_202", nextRunAt: "2026-11-03T10:00:00Z" };
        paintBotAccess(access); paintBotAudit([{ operation: "proactive.mail_digest", code: "HERMES_HTTP_200" }]);
        paintFeatureCatalog(); paintCli();
      });
      assert.match(await page.locator("[data-notify-status]").textContent(), /202 accepted for handling.*agent completion unverified/);
      assert.match(await page.locator("#bot-audit").textContent(), /200 acknowledged.*duplicate, ignored or direct delivery.*agent completion unverified/);
      assert.match(await page.locator("#features-catalog").textContent(), /native Hermes HMAC V2/);
      assert.match(await page.locator("#cli-hermes").textContent(), /Neither confirms agent completion/);
      await page.setViewportSize({ width: 820, height: 740 });
      await field("webhookMode").selectOption("hermes_hmac_v2");
      await page.addScriptTag({ url: origin + "/axe.js" });
      assert.deepEqual(await violations(), []);
      assert.equal(await page.locator(".bot-proactive").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      await field("webhookMode").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `hermes-narrow-${reducedMotion}.png`) });
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      await context.close();
    }
    console.log(JSON.stringify({ result: "passed", checks: "native HMAC/Bearer selection, validation/focus, explicit permission, keyboard save, reload/legacy compatibility, admission labels, Features/CLI, narrow layout, motion/reduced motion, zero axe violations or external requests", output }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
