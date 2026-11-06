// First-party renderer/CSS + actual preload allowlist. All mail/provider data is synthetic.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), vm = require("node:vm");
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-folder-management-browser");

async function checkPreload() {
  let exposed;
  const calls = [], listeners = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8"), { require(name) {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, "morrow"); exposed = api; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); }, on: (...args) => listeners.push(args), removeListener() {}, send() {} } };
  } });
  await exposed.invoke("mail:folderManagement", { action: "list", accountId: "g", expectedEpoch: 1 });
  assert.equal(calls[0][0], "mail:folderManagement");
  await assert.rejects(exposed.invoke("mail:folderManagement:unknown", {}), /Unsupported channel/);
  exposed.on("mail:folderManagementChanged", () => {});
  exposed.on("mail:folderManagement:unknown", () => {});
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], "mail:folderManagementChanged");
}

const account = (id, profile) => ({ id, email: id + "@fixture.invalid", platform: "imap", bodyEpoch: 1,
  imapSmtpProfile: profile, authKind: profile === "gmail" || profile === "outlook" ? "oauth" : "password",
  mailTransport: profile === "gmail" ? "gmail_api" : "imap", folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }],
    more: [{ id: "Projects", name: "Projects", providerId: profile === "gmail" ? "Label_projects" : undefined }] } });
const accounts = [account("g", "gmail"), account("o", "outlook"), account("y", "yahoo"), account("i", "custom")];
const disabled = { enabled: false, reason: "Recoverable folder deletion is not yet verified. No irreversible delete is available." };
const folder = (id, name, extra = {}) => ({ id, name, type: "user", flags: [], selectable: true, readOnly: false, canCreate: true, deletion: disabled, ...extra });
const models = new Map(accounts.map(acc => [acc.id, { accountId: acc.id, backend: acc.id === "g" ? "gmail" : "imap", delimiter: acc.id === "i" ? "." : "/", canCreate: true,
  folders: [folder("INBOX", "Inbox", { type: "system", wellKnown: "inbox", canCreate: acc.id !== "g" }),
    folder(acc.id === "g" ? "Label_projects" : "Projects", "Projects", acc.id === "g" ? { deletion: { enabled: true, mode: "label-grace", reason: "Only this label is removed. Messages and child labels stay. Undo cancels during the 30-second grace period before any write." } } : {}),
    ...(acc.id === "g" ? [folder("Label_child", "Projects/Reports", { parentId: "Label_projects" })] : [folder(acc.id === "i" ? "Projects.Reports" : "Projects/Reports", "Reports", { parentId: "Projects" }),
      folder("Container", "Container", { selectable: false }), folder("Locked", "Locked", { flags: ["\\Noinferiors"], readOnly: true, canCreate: false })])], operations: [] }]));

(async () => {
  await checkPreload();
  fs.mkdirSync(output, { recursive: true });
  let failOnce = "", reviewSerial = 0;
  const calls = [], reviews = new Map();
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, "." + decodeURIComponent(req.url.split("?")[0]));
    if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let bytes = fs.readFileSync(target);
      if (target.endsWith("/renderer/app.js")) bytes = bytes.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("content-type", target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".svg") ? "image/svg+xml" : "text/html");
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("fixtureInvoke", async (channel, params = {}) => {
      calls.push({ channel, params });
      let data;
      if (channel === "mail:folderManagement") {
        assert.equal(params.expectedEpoch, 1);
        assert.ok(models.has(params.accountId));
        const model = models.get(params.accountId);
        if (params.action === "list") {
          await new Promise(resolve => setTimeout(resolve, 70));
          if (failOnce === params.accountId) { failOnce = ""; return { success: false, error: "Synthetic folder listing unavailable. Refresh to try again." }; }
          data = structuredClone(model);
        } else if (params.action === "operations") data = structuredClone(model.operations);
        else if (params.action === "review") {
          const source = params.folderId ? model.folders.find(folder => folder.id === params.folderId) : null;
          if (params.intent === "delete") assert.equal(source?.deletion?.enabled, true);
          data = { reviewId: "review-" + (++reviewSerial), accountId: params.accountId, mailbox: params.accountId + "@fixture.invalid", intent: params.intent,
            name: source?.name || "", parentName: source?.name || "Top level", disclosure: source?.deletion?.reason || "", graceMs: params.intent === "delete" ? 30000 : 0 };
          reviews.set(data.reviewId, { accountId: params.accountId, source, intent: params.intent });
        } else if (params.action === "cancelReview") { reviews.delete(params.reviewId); data = { cancelled: true }; }
        else if (params.action === "create") {
          const review = reviews.get(params.reviewId); assert.equal(review?.accountId, params.accountId); assert.equal(review.intent, "create");
          assert.ok(params.name); reviews.delete(params.reviewId); data = { created: true };
        } else if (params.action === "delete") {
          const review = reviews.get(params.reviewId); assert.equal(review?.accountId, params.accountId); assert.equal(review.intent, "delete"); assert.equal(params.confirmation, "confirm");
          model.operations = [{ id: "operation-" + params.reviewId, accountId: params.accountId, intent: "delete", name: review.source.name, sourceId: review.source.id,
            phase: "pending", remainingMs: 30000, canUndo: true, canReview: false, reason: "Undo cancels before removal; it does not restore a removed label." }];
          reviews.delete(params.reviewId); data = structuredClone(model.operations[0]);
        } else if (params.action === "undo") {
          const operation = model.operations.find(item => item.id === params.operationId); assert.ok(operation?.canUndo);
          operation.phase = "cancelled"; operation.canUndo = false; data = structuredClone(operation);
        } else throw new Error("Unsupported synthetic folder action " + params.action);
      } else if (channel === "mail:listProviderFolders") data = { accountId: params.accountId, api: true, folders: params.accountId === "g" ? models.get("g").folders.map(folder => ({ ...folder, editable: folder.type === "user" })) : [] };
      else if (channel === "mail:listFromCache" || channel === "mail:listEmails") data = { emails: [], total: 0, initialSyncDone: true };
      else if (channel === "mail:listSnoozed") data = { records: [] };
      else if (channel === "mail:localFolders") data = null;
      else if (channel === "mail:vacationGet") data = { enabled: false };
      else throw new Error("Unexpected synthetic browser invoke: " + channel);
      return { success: true, data };
    });
    await page.addInitScript(() => { window.fixtureEvents = {}; window.morrow = { invoke: (channel, params) => window.fixtureInvoke(channel, params), on(channel, callback) { window.fixtureEvents[channel] = callback; return () => {}; } }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(accounts => {
      state.accounts = accounts; state.accountId = "g"; state.folderId = "INBOX";
      wire(); showProviderPage();
    }, accounts);
    await page.waitForFunction(() => folderManagementViews.get("g")?.data);
    assert.equal(await page.locator(".folder-mailbox-card").count(), 4);
    assert.equal(await page.locator('.folder-mailbox-card[aria-pressed="true"] strong').textContent(), "g@fixture.invalid");
    assert.equal(await page.locator(".provider-tools summary").count(), 1);
    assert.equal(await page.locator(".provider-tools").evaluate(node => node.open), false);
    // Exact typing is enforced by the actual common confirmation form.
    await page.locator('[data-managed-folder="Label_projects"]').click();
    await page.locator(".managed-folder-actions").getByRole("button", { name: "Delete…", exact: true }).click();
    await page.locator("#confirm[open]").waitFor();
    assert.match(await page.locator("#confirm-body").textContent(), /Mailbox: g@fixture.invalid[\s\S]*30-second[\s\S]*does not restore/);
    for (const value of ["Confirm", " confirm", "confirm "]) {
      await page.locator("#confirm-name").fill(value); assert.equal(await page.locator("#confirm-ok").isDisabled(), true);
    }
    await page.locator("#confirm-name").fill("confirm"); assert.equal(await page.locator("#confirm-ok").isEnabled(), true);
    await page.locator("#confirm-ok").click();
    await page.getByRole("button", { name: "Undo deletion", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "gmail-pending-light.png") });
    // Cancellation is explicitly bound to the original mailbox even when another is selected.
    await page.locator(".folder-mailbox-card").filter({ hasText: "o@fixture.invalid" }).click();
    await page.waitForFunction(() => state.accountId === "o" && folderManagementViews.get("o")?.data);
    await page.getByRole("button", { name: "Undo deletion", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("folder-operation-activity").hidden);
    assert.equal(calls.filter(call => call.params.action === "undo").at(-1).params.accountId, "g");
    // All IMAP providers share browse/create, preserve container and server restrictions, and block Delete.
    for (const id of ["o", "y", "i"]) {
      await page.locator(".folder-mailbox-card").filter({ hasText: id + "@fixture.invalid" }).click();
      await page.waitForFunction(id => folderManagementViews.get(id)?.data && !folderManagementViews.get(id)?.loading, id);
      await page.locator('[data-managed-folder="Projects"]').click();
      assert.equal(await page.locator(".managed-folder-actions").getByRole("button", { name: "Delete…", exact: true }).isDisabled(), true);
      assert.match(await page.locator(".folder-management-limits").textContent(), /Delete is disabled.*IMAP, Outlook and Yahoo/);
      await page.locator('[data-managed-folder="Container"]').click();
      assert.equal(await page.locator(".managed-folder-actions").getByRole("button", { name: "New child folder…", exact: true }).isEnabled(), true);
      await page.locator('[data-managed-folder="Locked"]').click();
      assert.equal(await page.locator(".managed-folder-actions").getByRole("button", { name: "New child folder…", exact: true }).isDisabled(), true);
    }
    // NoSelect/container creation gets an explicit destination review.
    await page.locator('[data-managed-folder="Container"]').click();
    await page.locator(".managed-folder-actions").getByRole("button", { name: "New child folder…", exact: true }).click();
    await page.locator("#confirm[open]").waitFor(); assert.match(await page.locator("#confirm-body").textContent(), /Mailbox: i@fixture.invalid[\s\S]*Inside: Container/);
    await page.locator("#confirm-name").fill("Synthetic child"); await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => !document.getElementById("confirm").open);
    assert.equal(calls.filter(call => call.params.action === "create").at(-1).params.accountId, "i");
    // Flat/ambiguous namespaces can still be browsed without offering top-level creation.
    models.get("i").delimiter = null; models.get("i").canCreate = false;
    await page.getByRole("button", { name: "Refresh folders", exact: true }).click();
    await page.waitForFunction(() => folderManagementViews.get("i")?.data?.canCreate === false && !folderManagementViews.get("i")?.loading);
    assert.equal(await page.getByRole("button", { name: "New folder…", exact: true }).isDisabled(), true);
    // Recovery storage failure blocks writes while preserving a readable hierarchy.
    models.get("i").recoveryAvailable = false;
    models.get("i").recoveryError = "Durable folder recovery cannot open. Folder changes are disabled; browsing remains available.";
    for (const item of models.get("i").folders) { item.canCreate = false; item.deletion = disabled; }
    await page.getByRole("button", { name: "Refresh folders", exact: true }).click();
    await page.waitForFunction(() => folderManagementViews.get("i")?.data?.recoveryAvailable === false && !folderManagementViews.get("i")?.loading);
    assert.match(await page.locator("#folder-management [role=alert]").textContent(), /browsing remains available/);
    assert.ok(await page.locator("[data-managed-folder]").count() > 0);
    assert.equal(await page.getByRole("button", { name: "New folder…", exact: true }).isDisabled(), true);
    // Legacy provider tools obey the same recovery gate, while message/read actions stay available.
    const healthyGmail = structuredClone(models.get("g"));
    models.get("g").recoveryAvailable = false; models.get("g").canCreate = false;
    models.get("g").recoveryError = "Durable folder recovery cannot open. Folder changes are disabled; browsing remains available.";
    for (const item of models.get("g").folders) { item.canCreate = false; item.deletion = disabled; }
    await page.evaluate(async () => { state.accountId = "g"; ++mailboxNavigationGen; paintProviderPage(); await loadFolderManagement(selectedAccount(), true); await loadProviderFolders(accountGen); });
    await page.locator(".provider-tools").evaluate(node => { node.open = true; });
    assert.equal(await page.locator("#provider-folders .provider-create input").isDisabled(), true);
    assert.equal(await page.locator("#provider-folders .provider-row").evaluateAll(rows => rows.every(row => !row.draggable)), true);
    await page.evaluate(() => {
      state.email = { id: "synthetic-header-only", accountId: "g" }; state.providerColumnPath = ["Label_projects"];
      renderProviderColumns(document.getElementById("provider-folders"));
      openFolderMenu(state.providerFolders.folders.find(folder => folder.id === "Label_projects"), "gmail", 200, 200);
    });
    assert.equal(await page.getByRole("menuitem", { name: /^Rename/ }).isDisabled(), true);
    assert.equal(await page.locator("#provider-actions").getByRole("button", { name: "Add label to open message", exact: true }).isEnabled(), true);
    await page.keyboard.press("Escape");
    models.set("g", healthyGmail);
    // Loading/error/retry state is visible and creation is not enabled from a failed list.
    failOnce = "y";
    await page.locator(".folder-mailbox-card").filter({ hasText: "y@fixture.invalid" }).click();
    await page.evaluate(() => loadFolderManagement(selectedAccount(), true).catch(() => {}));
    await page.locator("#folder-management [role=alert]").waitFor();
    assert.equal(await page.getByRole("button", { name: "New folder…", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Refresh folders", exact: true }).click();
    await page.waitForFunction(() => folderManagementViews.get("y")?.data && !folderManagementViews.get("y")?.loading && !folderManagementViews.get("y")?.error);
    // A real modal cannot redirect a write after a switch, return visit, reconnect or folder change.
    const deletesBeforeRaces = calls.filter(call => call.params.action === "delete").length;
    for (const change of ["switch", "away-and-back", "reconnect", "folder-rename"]) {
      await page.evaluate(async () => {
        state.accountId = "g"; ++mailboxNavigationGen; state.accounts[0].bodyEpoch = 1; paintProviderPage();
        await loadFolderManagement(state.accounts[0], true);
        window.reviewFailure = null;
        window.pendingReview = reviewManagedFolder(state.accounts[0], "delete", folderManagementViews.get("g").data.folders.find(folder => folder.id === "Label_projects")).catch(error => { window.reviewFailure = error.message; });
      });
      await page.locator("#confirm[open]").waitFor();
      await page.evaluate(change => {
        if (change === "switch") { state.accountId = "o"; ++mailboxNavigationGen; }
        if (change === "away-and-back") { state.accountId = "o"; ++mailboxNavigationGen; state.accountId = "g"; ++mailboxNavigationGen; }
        if (change === "reconnect") state.accounts[0].bodyEpoch++;
        if (change === "folder-rename") folderManagementViews.get("g").data.folders.find(folder => folder.id === "Label_projects").name = "Changed elsewhere";
      }, change);
      await page.locator("#confirm-name").fill("confirm"); await page.locator("#confirm-ok").click();
      await page.evaluate(() => window.pendingReview);
      assert.match(await page.evaluate(() => window.reviewFailure), /mailbox, folder or navigation changed/);
    }
    assert.equal(calls.filter(call => call.params.action === "delete").length, deletesBeforeRaces);
    // Overlapping A→B→A reads cannot install the first visit's response.
    await page.evaluate(async () => {
      state.accounts[0].bodyEpoch = 1; state.accountId = "g"; ++mailboxNavigationGen;
      const originalCall = call, reads = []; let next = 0;
      call = (channel, payload) => channel === "mail:folderManagement" && payload.action === "list"
        ? new Promise(resolve => reads.push({ resolve, payload, index: ++next })) : originalCall(channel, payload);
      try {
        const first = loadFolderManagement(state.accounts[0], true).catch(() => {});
        state.accountId = "o"; ++mailboxNavigationGen;
        const other = loadFolderManagement(state.accounts[1], true).catch(() => {});
        state.accountId = "g"; ++mailboxNavigationGen;
        const current = loadFolderManagement(state.accounts[0], true);
        const result = name => ({ accountId: "g", backend: "gmail", delimiter: "/", canCreate: true, operations: [],
          folders: [{ id: "current", name, type: "user", flags: [], selectable: true, readOnly: false, canCreate: true, deletion: { enabled: false, reason: "Synthetic" } }] });
        reads[2].resolve(result("Current visit")); await current;
        reads[0].resolve(result("Stale first visit")); reads[1].resolve({ ...result("Other visit"), accountId: "o" });
        await Promise.all([first, other]);
        if (folderManagementViews.get("g").data.folders[0].name !== "Current visit") throw new Error("Stale list installed");
      } finally { call = originalCall; }
      await loadFolderManagement(state.accounts[0], true);
    });
    // Restart-paused operations can genuinely be cancelled; uncertain writes offer no fake Undo or replay.
    models.get("g").operations = [{ id: "paused-synthetic", accountId: "g", intent: "delete", sourceId: "Label_projects", name: "Projects", phase: "paused", remainingMs: 0, canUndo: true, canReview: false }];
    await page.evaluate(() => onFolderManagementChanged({ accountId: "g" }));
    await page.getByRole("button", { name: "Undo deletion", exact: true }).waitFor();
    assert.match(await page.locator("#folder-operation-activity").textContent(), /paused.*No automatic retry/);
    await page.getByRole("button", { name: "Undo deletion", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("folder-operation-activity").hidden);
    models.get("g").operations = [{ id: "uncertain-synthetic", accountId: "g", intent: "delete", sourceId: "Label_projects", name: "Projects", phase: "uncertain", remainingMs: 0, canUndo: false, canReview: false }];
    await page.evaluate(() => onFolderManagementChanged({ accountId: "g" }));
    await page.locator("#folder-operation-activity").filter({ hasText: "Outcome uncertain" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Undo deletion", exact: true }).count(), 0);
    assert.equal(calls.filter(call => call.params.action === "delete").length, deletesBeforeRaces);
    models.get("g").operations = [];
    await page.evaluate(() => onFolderManagementChanged({ accountId: "g" }));
    await page.waitForFunction(() => document.getElementById("folder-operation-activity").hidden);
    // Keyboard context menus work on unselected accounts and bind their target identity.
    await page.evaluate(async () => { state.accounts[0].bodyEpoch = 1; state.accountId = "i"; ++mailboxNavigationGen; renderAccounts(); paintProviderPage(); await loadFolderManagement(selectedAccount(), true); });
    await page.evaluate(() => { const account = state.accounts[0]; openAccountLabelMenu(account, 200, 200); });
    await page.getByRole("menuitem", { name: "New folder / label…", exact: true }).click();
    await page.locator("#confirm[open]").waitFor(); assert.match(await page.locator("#confirm-body").textContent(), /Mailbox: g@fixture.invalid/);
    await page.locator("#confirm-cancel").click();
    await page.waitForFunction(() => !document.getElementById("confirm").open);
    assert.equal(await page.evaluate(() => state.accountId), "i");
    await page.evaluate(() => openImapFolderMenu(state.accounts[3].folders.more[0], state.accounts[3], 200, 200));
    assert.equal(await page.getByRole("menuitem", { name: /^Delete folder…/ }).isDisabled(), true);
    await page.keyboard.press("Escape");
    const first = page.locator("[data-managed-folder]").first(); await first.focus(); await first.press("ArrowDown");
    assert.notEqual(await page.evaluate(() => document.activeElement?.dataset.managedFolder), await first.getAttribute("data-managed-folder"));
    await page.keyboard.press("Shift+F10"); assert.equal(await page.locator("#organize-menu").isVisible(), true); await page.keyboard.press("Escape");
    // Rendered Features and layouts at desktop/narrow sizes with reduced motion.
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(width => setNavCollapsed(width < 620), width);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: path.join(output, `folders-${width}-${theme}.png`) });
        assert.equal(await page.locator("#provider-panel").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      }
    }
    await page.evaluate(() => showFeatures());
    const feature = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Mailbox folders and label deletion", exact: true }) });
    await feature.scrollIntoViewIfNeeded(); assert.match(await feature.textContent(), /typing confirm exactly[\s\S]*IMAP, Outlook, Yahoo and legacy Gmail IMAP deletion remain disabled/);
    await page.screenshot({ path: path.join(output, "features-narrow-dark.png") });
    assert.deepEqual(errors, []);
    console.log("folder-management-browser-ok: exact preload, Gmail pending cancellation, account/epoch/navigation/folder races, IMAP/Outlook/Yahoo browse+create restrictions, keyboard, error/retry, 390/1440 light/dark, rendered Features; synthetic only");
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
