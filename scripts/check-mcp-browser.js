"use strict";
// Render the actual Settings/Features/CLI in Chromium with synthetic IPC only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-mcp-browser");
(async () => {
  const server = http.createServer((req, res) => {
    try {
      const target = path.resolve(root, "." + req.url.split("?")[0]);
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const isAxe = req.url === "/axe.js";
      let data = fs.readFileSync(isAxe ? require.resolve(process.env.MORROW_AXE_MODULE || "axe-core/axe.min.js") : target);
      if (target.endsWith("/renderer/app.js")) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const [theme, width, reducedMotion] of [["light", 1280, "no-preference"], ["dark", 640, "reduce"]]) {
      const context = await browser.newContext({ reducedMotion, viewport: { width, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
      const page = await context.newPage(), errors = [], external = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        if (route.request().url().startsWith(origin + "/")) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      await page.addInitScript(() => {
        window.requests = [];
        window.fixtureAccess = () => ({ enabled: true, installationId: "11111111-1111-4111-8111-111111111111", listen: { listening: true },
          mcp: { launcherAvailable: true, launcherPath: "/Applications/Morrow Mail.app/Contents/Resources/morrow-mcp.cjs", sourceCheckout: false, platform: "darwin", remoteMcp: false },
          accounts: [{ accountId: "alpha", email: "synthetic@example.test" }],
          grants: [{ clientId: "synthetic-mcp", label: "Synthetic MCP", platform: "mcp_agent", live: true, revision: 1,
            accountIds: ["alpha"], capabilities: ["accounts.read", "mail.headers.read", "health.read"], proactive: null }], drafts: [], sends: [], audit: [] });
        window.morrow = { on() { return () => {}; }, async invoke(channel) {
          requests.push(channel);
          if (channel === "bot:getAccess") return { success: true, data: fixtureAccess() };
          if (channel === "bot:setupText") return { success: true, data: { prompt: "Synthetic compatibility prompt; no secret", skillMarkdown: "Synthetic skill" } };
          if (channel.startsWith("bot:") || channel === "mail:send") throw Error("Unexpected mutation: " + channel);
          return { success: true, data: [] };
        } };
      });
      await page.goto(origin + "/renderer/index.html");
      await page.evaluate(async theme => { document.documentElement.dataset.theme = theme; wire(); setSettingsFold("bot", true, false); await loadBotAccess(); openDialog("settings"); }, theme);
      assert.equal(await page.locator("#settings-tab-bot").textContent(), "Agent access / MCP");
      await page.locator("#bot-tab-grants").focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.activeElement.id === "bot-tab-agent" && !document.getElementById("bot-panel-agent").hidden);
      assert.equal(await page.locator("#bot-legacy-setup").evaluate(node => node.open), false);
      assert.equal(await page.locator("#bot-mcp-copy").isDisabled(), true);
      await page.locator("#bot-mcp-node").fill("/usr/local/bin/node");
      await page.locator("#bot-mcp-token-file").fill("/Users/Synthetic/Private files/" + "long-folder/".repeat(12) + "agent.token");
      await page.locator("#bot-mcp-copy").scrollIntoViewIfNeeded();
      assert.equal(await page.locator("#bot-mcp-copy").isEnabled(), true);
      await page.locator("#bot-mcp-copy").click();
      await page.waitForFunction(() => document.getElementById("bot-mcp-status").textContent.includes("configuration copied"));
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      assert.equal(copied.mcpServers["morrow-mail"].command, "/usr/local/bin/node");
      assert.ok(copied.mcpServers["morrow-mail"].args[0].includes("Contents/Resources/morrow-mcp.cjs"));
      assert.equal(await page.evaluate(() => document.getElementById("settings").scrollWidth <= document.getElementById("settings").clientWidth + 2), true, "narrow configuration wraps without dialog overflow");
      await page.addScriptTag({ url: origin + "/axe.js" });
      const violations = await page.evaluate(async () => (await axe.run(document.getElementById("settings"),
        { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map(row => ({ id: row.id, nodes: row.nodes.map(n => n.target) })));
      assert.deepEqual(violations, []);
      await page.screenshot({ path: path.join(output, `mcp-${theme}-${width}.png`) });
      await page.locator("#bot-mcp-token-file").fill("mmb_v1_DO_NOT_PASTE_A_SECRET");
      assert.equal(await page.locator("#bot-mcp-copy").isDisabled(), true);
      assert.equal(await page.locator("#bot-mcp-config").textContent(), "");
      await page.locator("#bot-legacy-setup > summary").click();
      await page.locator("#bot-copy-setup").click();
      await page.waitForFunction(() => requests.includes("bot:setupText"));
      await page.locator("#bot-tab-tailscale").click(); await page.locator("#bot-serve-host").waitFor({ state: "visible" });
      await page.locator("#bot-tab-activity").click(); await page.locator("#bot-audit").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.evaluate(() => { showFeatures(); showFeaturesTab("cli"); });
      await page.locator("#cli-mcp").waitFor({ state: "visible" });
      assert.match(await page.locator("#cli-mcp").textContent(), /no remote MCP endpoint/);
      await page.evaluate(() => showFeaturesTab("catalog"));
      const feature = page.locator('.feature-card').filter({ hasText: "Agent access / MCP" });
      assert.ok(await feature.count() >= 1);
      assert.match(await feature.first().textContent(), /Node.js 20\+/);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      assert.ok((await page.evaluate(() => requests)).every(channel => !["mail:send", "bot:mintGrant", "bot:setEnabled", "bot:configureProactive"].includes(channel)));
      await context.close();
    }
    console.log("mcp-browser-ok (light/dark, narrow, reduced motion, keyboard, clipboard, compatibility, Features/CLI, axe; synthetic IPC only)");
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
