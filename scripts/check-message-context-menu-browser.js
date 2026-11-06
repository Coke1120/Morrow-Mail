// Actual Chromium/renderer interaction with synthetic mail and mocked IPC only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(require("node:os").tmpdir(), "morrow-message-menu-browser");

(async () => {
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, "." + decodeURI(req.url.split("?")[0]));
    if (!target.startsWith(root + path.sep)) { res.statusCode = 403; res.end(); return; }
    try {
      let data = fs.readFileSync(target);
      if (target.endsWith("/renderer/app.js")) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("content-type", target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".svg") ? "image/svg+xml" : "text/html");
      res.end(data);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    await page.addInitScript(() => { window.morrow = {}; });
    await page.goto(origin + "/renderer/index.html");
    await page.evaluate(() => {
      state.view = "mail"; state.accountId = "b"; state.folderId = "INBOX"; state.listSyncDone = true;
      state.accounts = ["a", "b"].map(id => ({ id, email: id + "@fixture.invalid", createdAt: 1, platform: "imap", imapSmtpProfile: "custom",
        folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }, { id: "Archive", name: "Archive", wellKnownName: "archive" }, { id: "Trash", name: "Trash", wellKnownName: "deleteditems" }], more: [] } }));
      state.localAccount = { id: LOCAL_ACCOUNT_ID, name: "Local Folders", folders: { primary: [{ id: "local-folder:archive", name: "Archive" }], more: [] } };
      state.emails = [{ id: "clicked", accountId: "a", folderId: "INBOX", subject: "Synthetic clicked message", from: "sender@fixture.invalid", unread: true },
        { id: "selected", accountId: "b", folderId: "INBOX", subject: "Unrelated selected message", from: "other@fixture.invalid", unread: false }];
      state.selectedIds = ["selected"]; state.email = state.emails[1];
      globalThis.menuCalls = [];
      call = async (channel, params) => { menuCalls.push({ channel, params }); if (channel === "mail:localFolders") return state.localAccount; return { outcomes: (params.items || []).map(item => ({id:item.emailId,status:"completed"})) }; };
      bulkSetRead = async (isRead, rows) => { menuCalls.push({ action: "read", isRead, ids: rows.map(row => row.id), accounts: rows.map(row => row.accountId) }); };
      wireOrganize(); renderAccounts(); renderList(); document.documentElement.dataset.view = "mail";
    });
    const row = page.locator('[data-email-id="clicked"] button.message');
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Message actions", exact: true });
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(async error => {
      throw new Error(error.message + " " + JSON.stringify({ errors, state: await page.evaluate(() => ({ menu: document.getElementById('organize-menu')?.outerHTML, active: document.activeElement?.outerHTML, selected: state.selectedIds, debug: menuCalls })) }));
    });
    assert.deepEqual(await page.evaluate(() => state.selectedIds), ["selected"]);
    assert.equal(await page.evaluate(() => state.email.id), "selected");
    await page.screenshot({ path: path.join(output, "wide-menu.png") });
    await page.getByRole("menuitem", { name: "Move to folder…", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Move / Copy to other mailbox…");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Mark as read");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => menuCalls.some(row => row.action === "read"));
    assert.deepEqual(await page.evaluate(() => menuCalls.find(row => row.action === "read").ids), ["clicked"]);
    assert.deepEqual(await page.evaluate(() => menuCalls.find(row => row.action === "read").accounts), ["a"]);
    await row.focus(); await page.keyboard.press("Shift+F10");
    await menu.waitFor({ state: "visible" }); await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Archive");
    await page.keyboard.press("Escape"); assert.equal(await row.evaluate(node => node === document.activeElement), true);
    await page.setViewportSize({ width: 760, height: 640 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await row.click({ button: "right" }); await menu.waitFor({ state: "visible" });
    assert.equal(await menu.evaluate(node => { const r=node.getBoundingClientRect(); return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight; }), true);
    await page.screenshot({ path: path.join(output, "narrow-dark-menu.png") });
    await page.getByRole("menuitem", { name: "Move / Copy to other mailbox…", exact: true }).click();
    const dialog = page.locator("#local-transfer"); await dialog.waitFor({ state: "visible" });
    assert.equal(await page.locator("#local-transfer-account option:disabled").count(), 2);
    await page.locator("#local-transfer-mode").selectOption("move");
    assert.match(await page.locator("#local-transfer-help").textContent(), /verify a complete local copy first/);
    assert.match(await page.locator("#local-transfer-capability").textContent(), /into another connected mailbox is not supported yet/);
    await page.waitForFunction(() => Number(getComputedStyle(document.getElementById("local-transfer")).opacity) >= 0.99);
    await page.screenshot({ path: path.join(output, "narrow-transfer.png") });
    await page.locator("#local-transfer-cancel").click();
    assert.equal(await page.evaluate(() => menuCalls.some(row => /transferToLocal|moveLocalMessage|mail:delete/.test(row.channel || ""))), false);
    await page.evaluate(() => showFeatures());
    const help = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Local Folders", exact: true }) });
    await help.scrollIntoViewIfNeeded();
    assert.match(await help.textContent(), /Move \/ Copy to other mailbox/);
    assert.match(await help.textContent(), /Connected destinations are listed unavailable/);
    assert.match(await help.textContent(), /already-Trash sources are blocked and rechecked by the host/);
    await page.screenshot({ path: path.join(output, "features.png") });
    assert.deepEqual(errors, []);
    console.log("message-context-browser-ok: clicked identity, ordered actions, native keyboard activation/focus, narrow/dark bounds, Copy/Move review, unsupported destinations, cancellation and rendered Features; synthetic IPC only");
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
