// Actual first-party DOM/CSS, real temporary archive, mocked IPC and synthetic MIME.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const assert = require("node:assert/strict");
const L = require("../host/mail/local-folders");
const root = path.join(__dirname, ".."), output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-local-folders-browser");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-local-browser-")), store = L.createLocalStore(path.join(dir, "local.sqlite"));
  const raw = await require("../host/mail/remote").buildRaw({ from: "Synthetic sender <sender@fixture.invalid>", to: "owner@fixture.invalid",
    date: new Date("2026-11-01T12:00:00Z"), messageId: "<browser-local@fixture.invalid>",
    subject: "Local archive — complete synthetic message 中文", text: "This entire message and its attachment remain available offline after the account is disconnected.",
    html: "<p>This entire message and its attachment remain available <b>offline</b> after the account is disconnected.</p>",
    attachments: [{ filename: "synthetic-evidence.txt", content: "Synthetic attachment bytes saved durably" }] });
  const account = { id: "synthetic", email: "owner@fixture.invalid", name: "Synthetic account", platform: "imap", imapSmtpProfile: "custom", folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }], more: [] } };
  const source = { id: "synthetic-source", accountId: account.id, folderId: "INBOX", subject: "Local archive — complete synthetic message 中文", from: "Synthetic sender <sender@fixture.invalid>", to: [account.email], unread: true, date: "2026-11-01T12:00:00Z" };
  let trashes = 0;
  const saved = await L.transferToLocal({ store, destination: L.ARCHIVE_ID, sourceKey: "browser-source", source: {}, assertCurrent() {}, download: async () => raw });
  const parent = store.manageFolder({ action: "create", name: "Projects" }).id;
  store.manageFolder({ action: "create", parentId: parent, name: "Contracts and correspondence 中文" });
  const calls = [];
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("fixtureInvoke", async (channel, params = {}) => {
      calls.push({ channel, params });
      let data;
      if (channel === "mail:localFolders") data = store.account();
      else if (channel === "mail:listAccounts") data = [account];
      else if (channel === "mail:listFromCache") data = params.accountId === L.ACCOUNT_ID ? store.list(params) : { emails: [source], total: 1, initialSyncDone: true };
      else if (channel === "mail:openEmail") data = { email: store.verify(params.emailId), isThread: false, threadMessages: [] };
      else if (channel === "mail:markRead") { store.update(params.emailId, { isRead: params.isRead }); data = { outcomes: [], pending: [] }; }
      else if (channel === "mail:toggleStar") { store.update(params.emailId, { isStarred: params.isStarred }); data = { outcomes: [], pending: [] }; }
      else if (channel === "mail:listSnoozed") data = { records: [] };
      else if (channel === "mail:listProviderFolders") data = { folders: [], api: false };
      else if (channel === "mail:transferToLocal") data = await L.transferToLocal({ store, destination: params.folderId, sourceKey: "browser-source", source: {}, assertCurrent() {}, download: async () => raw,
        move: params.mode === "move", trash: async () => { trashes++; } });
      else throw new Error("Unexpected synthetic browser invoke: " + channel);
      return { success: true, data };
    });
    await page.addInitScript(() => { window.morrow = { invoke: (channel, payload) => window.fixtureInvoke(channel, payload), on() {} }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(({ account, source }) => {
      window.fixtureAccount = account; window.fixtureSource = source;
      state.accounts = [account]; state.accountId = account.id; state.folderId = "INBOX";
      renderSettingsAccounts = refreshMailVacation = () => {};
      setNavCollapsed(true); document.documentElement.dataset.view = "mail"; wireSelection(); wireOrganize();
    }, { account, source });
    await page.evaluate(() => loadLocalFolders()); await page.evaluate(() => { renderAccounts(); renderList(); });
    await page.getByRole("button", { name: "Archive. Local folder", exact: true }).click();
    await page.waitForFunction(() => state.accountId === "__morrow_local__" && state.emails.length === 1);
    await page.locator("button.message").first().click();
    await page.waitForFunction(() => state.email?.isLocal === true);
    assert.equal(await page.locator('#reader [data-action="reply"]').count(), 0);
    assert.match(await page.locator("#reader").textContent(), /synthetic-evidence.txt/);
    assert.equal(await page.locator('#refresh').getAttribute('aria-label').then(value => /available offline/.test(value)), true);
    await page.screenshot({ path: path.join(output, "local-reader-light.png") });
    await page.evaluate(() => { state.prefs.theme = "dark"; applyLook(state.prefs); });
    await page.screenshot({ path: path.join(output, "local-reader-dark.png") });
    // Keyboard folder menu is also available without a pointer.
    const folder = page.locator(`[data-account-id="${L.ACCOUNT_ID}"][data-folder-id="${parent}"]`);
    await folder.focus(); await folder.press("Shift+F10");
    assert.equal(await page.getByRole("menuitem", { name: "Rename local folder…", exact: true }).isVisible(), true);
    await page.keyboard.press("Escape");
    await page.evaluate(() => openLocalTransfer([fixtureSource], "copy"));
    assert.equal(await page.locator("#local-transfer-folder").evaluate(node => document.activeElement === node), true);
    await page.locator("#local-transfer-mode").selectOption("move");
    assert.match(await page.locator("#local-transfer-help").textContent(), /across all labels/);
    assert.equal(await page.locator("#local-transfer-ok").textContent(), "Move");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { state.prefs.theme = theme; applyLook(state.prefs); }, theme);
        const bounds = await page.locator("#local-transfer").evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, width: node.clientWidth }));
        assert(bounds.left >= 0 && bounds.right <= width && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
        await page.screenshot({ path: path.join(output, `move-${width}-${theme}.png`) });
      }
    }
    await page.keyboard.press("Escape"); assert.equal(trashes, 0, "cancel never submits Trash");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => openLocalTransfer([fixtureSource], "copy"));
    await page.locator("#local-transfer-mode").selectOption("move");
    await page.locator("#local-transfer-ok").click();
    await page.waitForFunction(() => !document.getElementById("local-transfer").open).catch(async error => {
      console.error({ status: await page.locator("#local-transfer-status").textContent(), calls: calls.slice(-5), errors }); throw error;
    });
    assert.equal(trashes, 1); assert.equal(store.verify(saved.localId).isLocal, true);
    await page.evaluate(() => { state.accounts = []; state.localAccount = null; });
    await page.evaluate(() => loadLocalFolders());
    const before = calls.length;
    await page.evaluate(({ id }) => selectFolder("__morrow_local__", "local-folder:archive").then(() => openMessage(id)), { id: saved.localId });
    assert(!calls.slice(before).some(row => row.channel === "mail:listFromNetwork" || row.channel === "mail:listProviderFolders"));
    await page.evaluate(() => showFeatures());
    const card = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Local Folders", exact: true }) });
    await card.scrollIntoViewIfNeeded(); assert.match(await card.textContent(), /Restart never replays server Trash/);
    await page.screenshot({ path: path.join(output, "features-narrow.png") });
    assert.deepEqual(errors, []);
    console.log("local-folders-browser-ok: offline reader, nested folders, keyboard review, safe cancellation, Copy/Move disclosure, 390/1440 light/dark, reduced motion, rendered Features");
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
