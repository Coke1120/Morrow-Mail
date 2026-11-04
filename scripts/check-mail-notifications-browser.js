// Optional real Chromium UI/axe smoke. Local synthetic IPC only; no native notices.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), output = process.env.MORROW_UI_OUTPUT || path.join(require("node:os").tmpdir(), "morrow-notification-ui");
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const filename = url.pathname === "/axe.js" ? require.resolve(process.env.MORROW_AXE_MODULE || "axe-core/axe.min.js") : path.join(root, url.pathname);
  if (url.pathname !== "/axe.js" && !filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    let body = fs.readFileSync(filename);
    if (filename.endsWith("renderer/index.html")) body = body.toString().replace('<script src="./app.js"></script>', '<script src="/scripts/fixtures/google-onboarding-startup.js"></script><script src="/scripts/fixtures/mail-notifications-startup.js"></script><script src="./app.js"></script>');
    response.setHeader("content-type", filename.endsWith(".js") ? "application/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const url = `http://127.0.0.1:${server.address().port}/renderer/index.html?version=${require("../package.json").version}`;
    await page.goto(url);
    try { await page.waitForFunction(() => syntheticStartup.ready); }
    catch (error) { console.error(JSON.stringify(await page.evaluate(() => ({ errors: document.getElementById("status")?.textContent, calls: notificationFixture.calls, ready: syntheticStartup.ready })))); throw error; }
    await page.evaluate(() => { openSettings(); revealSettingsFold("mail"); });
    await page.locator("#mail-notification-status").filter({ hasText: "enabled" }).waitFor();
    assert.equal(await page.getByLabel("Show system notifications for new Inbox mail", { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel("Notification preview", { exact: true }).inputValue(), "hidden");
    await page.locator("#pref-mail-notifications").focus(); await page.keyboard.press("Space");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("synthetic.notification.MailNotificationsEnabled")) === false);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("synthetic.notification.MailNotificationsEnabled")) === true);
    await page.locator("#pref-mail-notification-preview").selectOption("sender");
    await page.waitForFunction(() => state.prefs.mailNotificationPreview === "sender");
    await page.reload(); await page.waitForFunction(() => syntheticStartup.ready);
    await page.evaluate(() => { openSettings(); revealSettingsFold("mail"); });
    await page.waitForFunction(() => document.getElementById("pref-mail-notification-preview").value === "sender");
    await page.locator("#pref-mail-notification-preview").selectOption("hidden");
    await page.addScriptTag({ url: "/axe.js" });
    async function accessibility(selector) {
      const result = await page.evaluate(selector => axe.run(document.querySelector(selector), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } }), selector);
      assert.deepEqual(result.violations.map(value => ({ id: value.id, nodes: value.nodes.map(node => node.target) })), []);
    }
    await accessibility("#settings");
    await page.screenshot({ path: path.join(output, "settings-desktop.png") });
    await page.setViewportSize({ width: 860, height: 700 });
    assert.equal(await page.locator("#settings").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(output, "settings-narrow.png") });
    await page.evaluate(async () => { notificationFixture.osState = "failed"; await refreshMailNotificationStatus(); });
    assert.match(await page.locator("#mail-notification-status").textContent(), /could not be shown.*permissions/);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      notificationFixture.target = { accountId: "b", folderId: "INBOX", messageId: "b-new" };
      notificationFixture.emit("mail:notificationClicked", { url: "https://untrusted.invalid" });
    });
    await page.waitForFunction(() => state.accountId === "b" && state.email?.id === "b-new");
    assert.match(await page.locator("#reader").textContent(), /Synthetic B arrival/);
    await page.screenshot({ path: path.join(output, "clicked-message.png") });
    await page.evaluate(() => showFeatures());
    await page.waitForFunction(() => [...document.getAnimations()].every(animation => animation.playState !== "running"));
    assert.match(await page.locator("#features-catalog").textContent(), /New email notifications.*Enabled by default.*content hidden/s);
    await accessibility("#features-catalog");
    await page.screenshot({ path: path.join(output, "features.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "browser-ok", accessibility: "0 WCAG A/AA violations in Settings and Features", checks: "keyboard toggle, privacy selection/reload persistence, narrow layout, OS failure text, real click routing to account B", output }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
